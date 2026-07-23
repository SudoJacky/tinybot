use crate::protocol::request_id::WorkerRequestCorrelation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
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
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    session_id: &str,
    turn_id: &str,
) -> serde_json::Value {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            "req-agent-turn-get",
            "trace-agent-turn-get",
            "thread.turn.get",
            serde_json::json!({
                "session_id": session_id,
                "turn_id": turn_id,
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
        Self { root }
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
            rpc.append_session_messages(
                session_id,
                &format!("turn-fixture-{session_id}"),
                messages,
            )
            .expect("fixture Rollout messages should append");
            let mut metadata = session["extra"]["metadata"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            metadata.insert("title".to_string(), session["title"].clone());
            metadata.insert(
                "workingDirectory".to_string(),
                session["workspace_dir"].clone(),
            );
            rpc.patch_metadata(session_id, &serde_json::Value::Object(metadata))
                .expect("fixture Rollout metadata should patch");
            if let Some(user_profile) = session["extra"].get("user_profile") {
                rpc.patch_user_profile(session_id, user_profile.clone(), serde_json::json!({}))
                    .expect("fixture Rollout user profile should patch");
            }
        }
    }
}

impl Drop for WorkspaceFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
