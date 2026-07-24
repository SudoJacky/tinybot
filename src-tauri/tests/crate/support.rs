use crate::protocol::request_id::WorkerRequestCorrelation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
pub(super) fn lifecycle_blocking_command() -> String {
    "for /L %i in (0,0,1) do @rem".to_string()
}

#[cfg(not(target_os = "windows"))]
pub(super) fn lifecycle_blocking_command() -> String {
    "while true; do :; done".to_string()
}

#[cfg(target_os = "windows")]
pub(super) fn lifecycle_echo_command() -> String {
    "echo resumed".to_string()
}

#[cfg(not(target_os = "windows"))]
pub(super) fn lifecycle_echo_command() -> String {
    "printf 'resumed\\n'".to_string()
}

pub(super) fn read_agent_turn_record(
    thread_store: &WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
    session_id: &str,
    turn_id: &str,
) -> serde_json::Value {
    call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            "req-agent-turn-get",
            "trace-agent-turn-get",
            "thread.turn.get",
            serde_json::json!({
                "threadId": session_id,
                "turnId": turn_id,
            }),
        ),
        "agent turn read",
    )
    .expect("agent turn record should persist")
}

pub(super) fn test_request_correlation(suffix: &str) -> WorkerRequestCorrelation {
    WorkerRequestCorrelation::from_suffix(suffix)
}

pub(super) fn compatibility_thread_log_paths(
    workspace_root: &std::path::Path,
) -> Vec<std::path::PathBuf> {
    fn collect(directory: &std::path::Path, paths: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, paths);
            } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
                paths.push(path);
            }
        }
    }

    let mut paths = Vec::new();
    collect(&workspace_root.join(".tinybot").join("threads"), &mut paths);
    paths.sort();
    paths
}

pub(super) struct WorkspaceFixture {
    pub(super) root: PathBuf,
    pub(super) thread_store: WorkspaceThreadStore,
}

impl WorkspaceFixture {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-echo-command-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("workspace fixture should create");
        let thread_store = WorkspaceThreadStore::new(
            root.clone(),
            crate::protocol::capability::default_desktop_capability_policy(),
        );
        Self { root, thread_store }
    }

    pub(super) fn write(&self, relative_path: &str, contents: &str) {
        let path = self
            .root
            .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent should create");
        }
        std::fs::write(path, contents).expect("fixture file should write");
    }

    pub(super) fn seed_rollout_sessions(&self, store: serde_json::Value) {
        let rpc = crate::threads::rollout::store::WorkerThreadLogRpc::new(
            self.root.clone(),
            crate::protocol::capability::CapabilityPolicy::new([
                crate::protocol::capability::WorkerCapability::SessionMetadataRead,
                crate::protocol::capability::WorkerCapability::SessionWrite,
            ]),
        );
        let sessions = store
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .expect("fixture Rollout seed should contain sessions");
        for session in sessions {
            let session_id = session["session_id"]
                .as_str()
                .expect("fixture session id should be a string");
            let messages = session["extra"]["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let metadata = session["extra"]["metadata"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let fixture_identity = format!("{}:{session_id}", self.root.display());
            let thread_id =
                crate::threads::rollout::store::thread_id_for_session_id(&fixture_identity);
            let thread = crate::threads::domain::ThreadRecord {
                thread_id: thread_id.clone(),
                title: session["title"]
                    .as_str()
                    .unwrap_or("Fixture thread")
                    .to_string(),
                status: crate::threads::domain::ThreadStatus::Idle,
                session_key: Some(session_id.to_string()),
                root_turn_id: None,
                active_turn_id: None,
                parent_thread_id: None,
                source: "test".to_string(),
                created_at: session["created_at"]
                    .as_str()
                    .unwrap_or("2026-01-01T00:00:00Z")
                    .to_string(),
                updated_at: session["updated_at"]
                    .as_str()
                    .unwrap_or("2026-01-01T00:00:00Z")
                    .to_string(),
                archived_at: None,
                metadata: crate::threads::domain::ThreadMetadata {
                    working_directory: session["workspace_dir"].as_str().map(str::to_string),
                    extra: serde_json::json!({
                        "metadata": metadata,
                        "userProfile": session["extra"]
                            .get("user_profile")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({})),
                    }),
                    ..crate::threads::domain::ThreadMetadata::default()
                },
            };
            rpc.create_from_thread_record(&thread)
                .expect("fixture thread should be created");
            rpc.append_thread_messages(&thread_id, &format!("turn-fixture-{thread_id}"), messages)
                .expect("fixture Rollout messages should append");
        }
    }

    pub(super) fn seed_thread_messages(
        &self,
        session_key: &str,
        turn_id: &str,
        messages: Vec<serde_json::Value>,
    ) {
        let rpc = crate::threads::rollout::store::WorkerThreadLogRpc::new(
            self.root.clone(),
            crate::protocol::capability::CapabilityPolicy::new([
                crate::protocol::capability::WorkerCapability::SessionMetadataRead,
                crate::protocol::capability::WorkerCapability::SessionWrite,
            ]),
        );
        let thread_id = crate::threads::rollout::store::thread_id_for_session_id(session_key);
        let thread = crate::threads::domain::ThreadRecord {
            thread_id: thread_id.clone(),
            title: "Fixture thread".to_string(),
            status: crate::threads::domain::ThreadStatus::Idle,
            session_key: Some(session_key.to_string()),
            root_turn_id: None,
            active_turn_id: None,
            parent_thread_id: None,
            source: "test".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            archived_at: None,
            metadata: crate::threads::domain::ThreadMetadata::default(),
        };
        rpc.create_from_thread_record(&thread)
            .expect("fixture thread should be created");
        rpc.append_thread_messages(&thread_id, turn_id, messages)
            .expect("fixture thread messages should append");
    }
}

impl Drop for WorkspaceFixture {
    fn drop(&mut self) {
        let _ = self.thread_store.shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
