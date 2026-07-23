mod memory;

use super::{tool_executor_arguments_with_context, ShellExecuteRequestParams};
use crate::collaboration::subagents::{SubagentSpawnParams, SubagentThreadManager};
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerRequest, WorkerRequestCancellation};
use crate::rpc::WorkerRpcRouter;
use crate::tools::executor::ToolExecutorExecuteRequest;
use crate::tools::permissions::PermissionEvaluateToolRequest;
use crate::tools::shell::WorkerShellRuntime;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

static WORKSPACE_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

mod approval_and_shell;
mod automation_and_collaboration;
mod request_boundary;
mod sessions;
mod threads_and_tools;

fn approve_once(
    router: &mut WorkerRpcRouter,
    run_id: &str,
    session_id: &str,
    operation: Value,
    category: &str,
    risk: &str,
    reason: &str,
) {
    let requested_tool_name = operation["toolName"]
        .as_str()
        .expect("approval helper operation should identify a tool");
    let tool_id = match requested_tool_name {
        "write_file" => "workspace.write_file",
        "apply_patch" => "workspace.apply_patch",
        "delete_file" => "workspace.delete_file",
        "exec" => "shell.execute",
        other => other,
    };
    let tool = router
        .tool_registry
        .get_tool(tool_id)
        .unwrap_or_else(|| panic!("approval helper tool should be registered: {tool_id}"));
    let evaluation = router
        .permission_profile
        .evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: tool_id.to_string(),
                arguments: operation["arguments"].clone(),
                session_id: Some(session_id.to_string()),
                run_id: Some(run_id.to_string()),
            },
        )
        .expect("approval helper effects should normalize");
    let approval = evaluation
        .approval_request
        .expect("approval helper tool should require approval");
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-approval-helper",
        "trace-approval",
        "approval.request",
        json!({
            "run_id": run_id,
            "session_id": session_id,
            "operation": approval.operation,
            "classification": {
                "category": category,
                "risk": risk,
                "reason": reason
            },
            "fingerprint": approval.fingerprint,
            "session_fingerprint": approval.session_fingerprint,
            "scope": approval.scope,
            "lifetime": approval.lifetime,
            "effects": approval.effects
        }),
    ));
    let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
        .as_str()
        .unwrap()
        .to_string();
    let resolve_response = router.dispatch(&WorkerRequest::new(
        "req-approval-resolve-helper",
        "trace-approval",
        "approval.resolve",
        json!({
            "session_id": session_id,
            "approval_id": approval_id,
            "approved": true,
            "scope": "once"
        }),
    ));
    assert!(resolve_response.error.is_none());
}

#[cfg(target_os = "windows")]
fn blocking_shell_command_with_marker() -> String {
    "echo started > started.txt & for /L %i in (0,0,1) do @rem".to_string()
}

#[cfg(not(target_os = "windows"))]
fn blocking_shell_command_with_marker() -> String {
    "printf started > started.txt; while true; do :; done".to_string()
}

#[derive(Default, Debug)]
struct TestCancellation {
    cancelled: AtomicBool,
}

impl TestCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

impl WorkerRequestCancellation for TestCancellation {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

fn session_fixture() -> crate::threads::session::SessionMetadata {
    crate::threads::session::SessionMetadata {
        session_id: "session-1".to_string(),
        title: "Native Core Migration".to_string(),
        workspace_dir: "D:/code/tinybot/tinybot".to_string(),
        created_at: "2026-06-09T09:00:00Z".to_string(),
        updated_at: "2026-06-09T09:30:00Z".to_string(),
        extra: json!({ "mode": "desktop" }),
    }
}

fn first_thread_log_file(root: &Path) -> PathBuf {
    first_thread_log_file_under(root, "threads").expect("thread log file should exist")
}

fn first_archived_thread_log_file(root: &Path) -> PathBuf {
    first_thread_log_file_under(root, "archived_threads")
        .expect("archived thread log file should exist")
}

fn first_thread_log_file_under(root: &Path, directory: &str) -> Option<PathBuf> {
    fn visit(dir: &Path) -> Option<PathBuf> {
        for entry in std::fs::read_dir(dir).ok()? {
            let path = entry.ok()?.path();
            if path.is_dir() {
                if let Some(found) = visit(&path) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("thread-")
                        && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
                })
            {
                return Some(path);
            }
        }
        None
    }
    visit(&root.join(".tinybot").join(directory))
}

fn assert_removed_persistence_paths_absent(root: &Path) {
    let removed_paths = [
        root.join("sessions").join("sessions.sqlite"),
        root.join(".tinybot")
            .join("state")
            .join("thread-store.jsonl"),
        root.join(".tinybot").join("threads").join("threads.sqlite"),
    ];
    for path in removed_paths {
        assert!(!path.exists(), "removed persistence path exists: {path:?}");
    }
}

fn prepare_session_log_index_for_startup(root: &Path) {
    let rpc = crate::threads::rollout::store::WorkerThreadLogRpc::new(
        root.to_path_buf(),
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let migration = rpc
        .prepare_state_index_for_startup()
        .expect("startup index preparation should succeed");
    assert!(migration.is_some(), "missing index should be migrated");
}

fn repair_session_log_index(root: &Path) {
    let rpc = crate::threads::rollout::store::WorkerThreadLogRpc::new(
        root.to_path_buf(),
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let repair = rpc
        .repair_state_index(crate::threads::rollout::store::ThreadLogIndexRepairMode::RebuildIndex)
        .expect("explicit index repair should succeed");
    assert_eq!(
        repair.after.status,
        crate::threads::rollout::store::ThreadLogIndexConsistencyStatus::Clean
    );
}

fn thread_state_updated_at(state_path: &Path, session_id: &str) -> String {
    let connection = rusqlite::Connection::open(state_path).expect("state db should open");
    connection
        .query_row(
            "SELECT updated_at FROM threads WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .expect("thread state row should exist")
}

struct WorkspaceFixture {
    root: PathBuf,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let counter = WORKSPACE_FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-rpc-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos(),
            counter
        ));
        std::fs::create_dir_all(&root).expect("workspace fixture should create");
        Self { root }
    }

    fn write(&self, relative_path: &str, contents: &str) {
        let path = self
            .root
            .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent should create");
        }
        std::fs::write(path, contents).expect("fixture file should write");
    }

    fn read(&self, relative_path: &str) -> String {
        let path = self
            .root
            .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::read_to_string(path).expect("fixture file should read")
    }
}

impl Drop for WorkspaceFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
