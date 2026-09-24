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

    fn team_turn(&self) {
        self.threads
            .turn_operation(|operation| {
                let thread = operation.thread().create_thread(
                    crate::threads::domain::CreateThreadRequest {
                        thread_id: Some("team-thread".into()),
                        source: Some("team".into()),
                        ..Default::default()
                    },
                )?;
                operation.thread_log().create_from_thread_record(&thread)?;
                operation.sync_thread_projection("team-thread")
            })
            .unwrap();
        let input = crate::agent::runtime::AgentTurnInput::from_wire(
            &json!({
                "sessionId":"team-thread", "turnId":"team-turn",
                "metadata":{"source":"desktop","memoryExtraction":true}
            }),
            &json!({}),
        )
        .unwrap();
        self.threads.start_agent_turn(
            crate::agent::bridge::native_agent_turn_start_record(&input, "team-thread", "team-turn"),
            None, vec![crate::threads::rollout::format::ResponseItem::from_value(json!({
                "role":"user", "content":"Remember this planner-generated instruction.", "turnId":"team-turn"
            })).unwrap()],
        ).unwrap();
        self.threads
            .complete_agent_turn(
                "team-thread",
                "team-turn",
                "final_response",
                Some("done".into()),
                None,
            )
            .unwrap();
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
fn queued_notification_does_not_repeat_extraction_completed_by_heartbeat() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let model = Arc::new(Model::new(true, 2));
        let runtime = WorkspaceMemoryRuntime {
            store: fixture.store.clone(),
            thread_store: fixture.threads.clone(),
            thread_store_path: fixture.scope.clone(),
            latest_config: Arc::new(Mutex::new(json!({"revision": 2}))),
            model: model.clone(),
            cancellation: CancellationToken::new(),
        };
        fixture
            .store
            .enqueue_turn(&fixture.scope, "thread", "turn", &fixture.scope)
            .unwrap();
        let notification = fixture
            .store
            .pending_turns(&fixture.scope, 1)
            .unwrap()
            .remove(0);
        // Heartbeats may win select! before the queued notification is received.
        runtime.run_heartbeat().await.unwrap();
        assert_eq!(fixture.pending(), 1);
        runtime.run_heartbeat().await.unwrap();
        assert_eq!(fixture.pending(), 0);
        runtime.process_pending_turn(&notification).await.unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
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

#[test]
fn restart_skips_queued_team_origin_without_blocking_eligible_work() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        fixture.team_turn();
        fixture
            .store
            .enqueue_turn(&fixture.scope, "team-thread", "team-turn", &fixture.scope)
            .unwrap();
        fixture
            .store
            .enqueue_turn(&fixture.scope, "thread", "turn", &fixture.scope)
            .unwrap();
        fixture.threads.flush().unwrap();
        let reopened = WorkspaceThreadStore::new_with_data_root(
            fixture.root.clone(),
            fixture.threads.data_root().into(),
            crate::protocol::capability::default_desktop_capability_policy(),
        );
        let model = Arc::new(Model::new(false, 1));
        let mut runtime = MemoryRuntime::new(model.clone());
        runtime.heartbeat_interval = Duration::from_millis(20);
        runtime
            .start(reopened.clone(), json!({"revision":2}))
            .unwrap();
        wait_for(|| fixture.pending() == 0).await;
        runtime.shutdown(Duration::from_secs(1)).await.unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        let database =
            rusqlite::Connection::open(fixture.threads.data_root().join("state/memory.sqlite"))
                .unwrap();
        let reason: String = database
            .query_row(
                "SELECT skip_reason FROM processed_memory_turns WHERE thread_id='team-thread'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reason, "team_origin");
        let count: i64 = database
            .query_row("SELECT COUNT(*) FROM memory_fragments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        runtime
            .start(reopened.clone(), json!({"revision":2}))
            .unwrap();
        // Explicitly scheduling a Team after restart cannot recreate pending work.
        runtime
            .schedule_turn_extraction(
                reopened.clone(),
                json!({}),
                "team-thread".into(),
                "team-turn".into(),
                fixture.scope.clone(),
            )
            .unwrap();
        assert_eq!(fixture.pending(), 0);
        runtime.shutdown(Duration::from_secs(1)).await.unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        reopened.shutdown().unwrap();
    });
}

struct SnapshotProvider;
impl crate::agent::runtime::test_support::BlockingTestProvider for SnapshotProvider {
    fn complete(
        &self,
        context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        let tool_calls = if context.metadata.get("teamRunId").is_some() {
            assert!(context
                .system_instruction_prompt()
                .unwrap()
                .contains("Workspace uses Rust."));
            vec![crate::agent::runtime::NativeAgentToolCall {
                id: "complete-memory-team-task".into(),
                name: crate::tools::registry::TEAM_COMPLETE_TASK_METHOD.into(),
                arguments_json: json!({"summary":"done","artifacts":[],"unresolved":""})
                    .to_string(),
                result: json!({}),
            }]
        } else {
            vec![]
        };
        Ok(crate::agent::runtime::NativeAgentProviderResponse {
            final_content: if tool_calls.is_empty() {
                "done".into()
            } else {
                String::new()
            },
            reasoning_delta: None,
            usage: None,
            tool_calls,
            response_items: vec![],
        })
    }
}

#[test]
fn native_team_completion_reads_memory_without_extracting_and_user_turn_still_extracts() {
    use crate::agent::bridge::TestApplicationServices;
    use crate::agent::runtime::{
        FakeNativeAgentToolDispatcher, InMemoryNativeAgentCancellation,
        InMemoryNativeAgentCheckpointStore, NativeAgentRuntimeServices,
    };
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        fixture
            .store
            .mutate_memory(
                0,
                &crate::memory::MemoryMutation::Create {
                    scope: MemoryScope::Workspace,
                    path: Some(fixture.scope.clone()),
                    content: "Workspace uses Rust.".into(),
                },
            )
            .unwrap();
        let model = Arc::new(Model::new(false, 1));
        let memory = MemoryRuntime::new(model.clone());
        let mut services = NativeAgentRuntimeServices::new(
            Arc::new(SnapshotProvider),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_thread_store(fixture.threads.clone());
        services.memory_runtime = memory.clone();
        let spec = serde_json::from_value(json!({
            "goal":"Research the project", "workspacePath":fixture.scope, "maxConcurrency":1,
            "members":[{"id":"research","displayName":"Research","instructions":"Inspect project","model":{"modelId":"fixture-model"}}]
        }))
        .unwrap();
        let plan = serde_json::from_value(json!({
            "tasks":[{"id":"task","title":"Research","memberId":"research","instructions":"Return evidence","dependencies":[]}],
            "finalTaskId":"task"
        })).unwrap();
        let run = crate::teams::prepare(fixture.threads.data_root(), spec, plan).unwrap();
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        let before = metrics.snapshot()["counters"]
            ["memory.phase1.origin_ineligible.schedule.skipped"]
            .as_u64()
            .unwrap_or(0);
        let result = crate::teams::execute(
            fixture.threads.data_root(),
            crate::teams::TeamRunInput {
                run_id: run.id,
                expected_revision: run.revision,
            },
            Arc::new(crate::teams::NativeTeamExecutor {
                worker_options: serde_json::json!({}),
                services: services.clone(),
                workspace_root: fixture.root.clone(),
                config: json!({"revision":2}),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(&result).unwrap()["status"],
            "completed",
            "Team run failed: {:?}",
            result.error
        );
        assert_eq!(model.calls.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.pending(), 0);
        assert!(fixture.store.phase2_input().unwrap().is_none());
        assert!(memory.state.lock().unwrap().workers.is_empty());
        assert!(
            metrics.snapshot()["counters"]["memory.phase1.origin_ineligible.schedule.skipped"]
                .as_u64()
                .unwrap()
                > before
        );
        crate::agent::bridge::run_agent_from_wire_with_services(services, json!({
            "sessionId":"thread", "threadId":"thread", "turnId":"user-turn", "model":"fixture-model",
            "messages":[{"role":"user","content":"Please remember that I prefer Chinese."}],
            "metadata":{"source":"team"}
        }), fixture.root.clone(), json!({"revision":2}), None).await.unwrap();
        wait_for(|| model.calls.load(Ordering::SeqCst) == 1 && fixture.pending() == 0).await;
        memory.shutdown(Duration::from_secs(1)).await.unwrap();
        assert_eq!(
            fixture
                .store
                .phase2_input()
                .unwrap()
                .unwrap()
                .fragments
                .len(),
            1
        );
    });
}
