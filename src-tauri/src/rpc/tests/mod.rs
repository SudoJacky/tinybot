use super::{tool_executor_arguments_with_context, ShellExecuteRequestParams};
use crate::collaboration::subagents::{SubagentSpawnParams, SubagentThreadManager};
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerRequest, WorkerRequestCancellation};
use crate::rpc::WorkerRpcRouter;
use crate::tools::executor::ToolExecutorExecuteRequest;
use crate::tools::shell::WorkerShellRuntime;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

static WORKSPACE_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

mod automation_and_collaboration;
mod request_boundary;
mod threads_and_tools;
mod workspace_and_shell;

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

fn thread_fixture() -> crate::threads::domain::ThreadRecord {
    crate::threads::domain::ThreadRecord {
        thread_id: "session-1".to_string(),
        title: "Native Core Migration".to_string(),
        status: crate::threads::domain::ThreadStatus::Idle,
        session_key: Some("session-1".to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: "desktop".to_string(),
        created_at: "2026-06-09T09:00:00Z".to_string(),
        updated_at: "2026-06-09T09:30:00Z".to_string(),
        archived_at: None,
        metadata: crate::threads::domain::ThreadMetadata {
            working_directory: Some("D:/code/tinybot/tinybot".to_string()),
            extra: json!({ "mode": "desktop" }),
            ..crate::threads::domain::ThreadMetadata::default()
        },
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
