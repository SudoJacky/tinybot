use super::*;
use crate::memory::{ExtractedMemory, MemoryScope, Phase2Input, SelectionAdd, SelectionDiff};
use futures_util::future::BoxFuture;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{Notify, Semaphore};

struct Fixture {
    root: PathBuf,
    threads: WorkspaceThreadStore,
    store: MemoryStore,
    scope: String,
}

impl Fixture {
    fn new() -> Self {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "tinybot-memory-owner-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&root).unwrap();
        let data = root.join("application-data");
        let threads = WorkspaceThreadStore::new_with_data_root(
            root.clone(),
            data.clone(),
            crate::protocol::capability::default_desktop_capability_policy(),
        );
        let input = crate::agent::runtime::AgentTurnInput::from_wire(
            &json!({"sessionId":"thread", "turnId":"turn"}),
            &json!({}),
        )
        .unwrap();
        let record = crate::agent::bridge::native_agent_turn_start_record(&input, "thread", "turn");
        let message = crate::threads::rollout::format::ResponseItem::from_value(json!({
            "role":"user", "content":"Please remember that I prefer Chinese.", "turnId":"turn",
        }))
        .unwrap();
        threads
            .start_agent_turn(record, None, vec![message])
            .unwrap();
        threads
            .complete_agent_turn(
                "thread",
                "turn",
                "final_response",
                Some("Done".into()),
                None,
            )
            .unwrap();
        let store = MemoryStore::new(&data);
        store.initialize().unwrap();
        let scope = crate::memory::normalized_workspace_path(&root).unwrap();
        Self {
            root,
            threads,
            store,
            scope,
        }
    }

    fn schedule(&self, runtime: &MemoryRuntime) -> Result<(), String> {
        runtime.schedule_turn_extraction(
            self.threads.clone(),
            json!({"revision": 2}),
            "thread".into(),
            "turn".into(),
            self.scope.clone(),
        )
    }

    fn pending(&self) -> usize {
        self.store.pending_turns(&self.scope, 10).unwrap().len()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.threads.shutdown().unwrap();
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

struct Model {
    calls: AtomicUsize,
    dropped: AtomicUsize,
    fail_once: AtomicBool,
    started: Notify,
    release: Semaphore,
}

impl Model {
    fn new(fail_once: bool, permits: usize) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
            fail_once: AtomicBool::new(fail_once),
            started: Notify::new(),
            release: Semaphore::new(permits),
        }
    }
}

struct RequestGuard<'a>(&'a AtomicUsize);
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl MemoryModel for Model {
    fn extract<'a>(
        &'a self,
        config: &'a Value,
        evidence: &'a TurnEvidence,
    ) -> BoxFuture<'a, Result<Vec<ExtractedMemory>, String>> {
        Box::pin(async move {
            assert!(!evidence.user_messages.is_empty());
            assert_eq!(config["revision"], 2);
            self.calls.fetch_add(1, Ordering::SeqCst);
            let _guard = RequestGuard(&self.dropped);
            self.started.notify_one();
            if self.fail_once.swap(false, Ordering::SeqCst) {
                return Err("fixture model failure".into());
            }
            self.release.acquire().await.unwrap().forget();
            Ok(vec![ExtractedMemory {
                scope: MemoryScope::User,
                content: "Prefers Chinese.".into(),
            }])
        })
    }
    fn select<'a>(
        &'a self,
        _config: &'a Value,
        input: &'a Phase2Input,
    ) -> BoxFuture<'a, Result<SelectionDiff, String>> {
        Box::pin(async move {
            Ok(SelectionDiff {
                add: input
                    .fragments
                    .iter()
                    .map(|m| SelectionAdd {
                        scope: m.scope,
                        path: m.path.clone(),
                        content: m.content.clone(),
                    })
                    .collect(),
                update: vec![],
                remove: vec![],
            })
        })
    }
}

async fn wait_for(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("observable worker state should converge");
}

#[test]
fn shutdown_drops_in_flight_model_work_and_restart_recovers_durable_queue() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let model = Arc::new(Model::new(false, 0));
        let mut runtime = MemoryRuntime::new(model.clone());
        runtime.heartbeat_interval = Duration::from_millis(20);
        fixture.schedule(&runtime).unwrap();
        tokio::time::timeout(Duration::from_secs(3), model.started.notified())
            .await
            .unwrap();
        runtime.shutdown(Duration::from_secs(1)).await.unwrap();
        assert_eq!(
            model.dropped.load(Ordering::SeqCst),
            1,
            "shutdown joins the cancelled request"
        );
        assert_eq!(fixture.pending(), 1);
        assert!(fixture
            .schedule(&runtime)
            .unwrap_err()
            .contains("not accepting"));
        assert!(runtime.state.lock().unwrap().workers.is_empty());

        model.release.add_permits(1);
        runtime
            .start(fixture.threads.clone(), json!({"revision": 2}))
            .unwrap();
        wait_for(|| fixture.pending() == 0).await;
        wait_for(|| !fixture.store.active_memories().unwrap().is_empty()).await;
        runtime.shutdown(Duration::from_secs(1)).await.unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            fixture.store.active_memories().unwrap()[0].content,
            "Prefers Chinese."
        );
        assert!(
            !fixture.root.join(".tinybot/state/memory.sqlite").exists(),
            "storage uses the injected data directory"
        );
    });
}

#[test]
fn model_failure_remains_pending_until_heartbeat_retry_succeeds() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let model = Arc::new(Model::new(true, 0));
        let mut runtime = MemoryRuntime::new(model.clone());
        runtime.heartbeat_interval = Duration::from_millis(20);
        fixture.schedule(&runtime).unwrap();
        wait_for(|| model.calls.load(Ordering::SeqCst) >= 2).await;
        assert_eq!(
            fixture.pending(),
            1,
            "failed and unfinished work must remain durable"
        );
        model.release.add_permits(1);
        wait_for(|| fixture.pending() == 0).await;
        runtime.shutdown(Duration::from_secs(1)).await.unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    });
}
