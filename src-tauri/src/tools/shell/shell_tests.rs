use super::*;
use crate::protocol::WorkerRequestCancellation;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

#[test]
fn start_allows_approved_absolute_path_outside_workspace() {
    let workspace = ShellFixture::new();
    let mentioned_file = ShellFixture::new();
    let file_path = mentioned_file.root.join("RAG.md");
    std::fs::write(&file_path, "external document").expect("fixture file should write");
    let command = if cfg!(target_os = "windows") {
        format!("type \"{}\"", file_path.display())
    } else {
        format!("cat '{}'", file_path.display())
    };
    let rpc = WorkerShellRpc::new(
        workspace.root.clone(),
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let result = rpc
        .start_with_approval_decision(
            ShellStartParams {
                command,
                working_dir: Some(".".to_string()),
                restrict_to_workspace: Some(true),
                tty: Some(false),
                yield_time_ms: Some(10_000),
                rows: None,
                cols: None,
                sandbox_mode: Some(ShellSandboxMode::Unsandboxed),
                network_mode: Some(PermissionNetworkMode::Unrestricted),
                owner_id: Some("turn-external-read".to_string()),
                tool_call_id: Some("call-external-read".to_string()),
                cancellation: None,
            },
            "approved",
        )
        .expect("approved shell command should read an absolute mentioned-file path");

    assert!(!result.running, "{result:?}");
    assert_eq!(result.exit_code, Some(0), "{result:?}");
    assert!(result.stdout.contains("external document"), "{result:?}");
}

#[test]
fn execute_drains_large_output_while_command_is_running() {
    let fixture = ShellFixture::new();
    let rpc = WorkerShellRpc::new(
        fixture.root.clone(),
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let result = rpc
        .execute(ShellExecuteParams {
            command: large_output_command(),
            working_dir: Some(".".to_string()),
            timeout: Some(15),
            restrict_to_workspace: Some(true),
            sandbox_mode: None,
            network_mode: None,
            cancellation: None,
        })
        .expect("large output command should complete");

    assert!(!result.timed_out);
    assert!(!result.cancelled);
    assert_eq!(result.exit_code, 0);
    assert!(result.stdout.len() >= 200_000);
    assert!(result.truncated);
}

#[test]
fn execute_kills_running_command_when_cancelled() {
    let fixture = ShellFixture::new();
    let started_marker = fixture.root.join("started.txt");
    let cancellation = Arc::new(TestCancellation::default());
    let rpc = WorkerShellRpc::new(
        fixture.root.clone(),
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );
    let execute_cancellation = cancellation.clone();
    let command = blocking_command_with_marker();

    let started = std::time::Instant::now();
    let handle = std::thread::spawn(move || {
        rpc.execute(ShellExecuteParams {
            command,
            working_dir: Some(".".to_string()),
            timeout: Some(30),
            restrict_to_workspace: Some(true),
            sandbox_mode: None,
            network_mode: None,
            cancellation: Some(execute_cancellation),
        })
    });

    while !started_marker.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "blocking shell command should create the started marker"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    cancellation.cancel();

    let result = handle
        .join()
        .expect("shell execute thread should not panic")
        .expect("cancelled shell execute should return a structured result");
    assert!(result.cancelled);
    assert!(!result.timed_out);
    assert_eq!(result.exit_code, -1);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancelled shell execute should return promptly"
    );
    assert!(result.content.contains("aborted by user"));
}

#[test]
fn execute_times_out_through_the_owned_process_manager() {
    let fixture = ShellFixture::new();
    let rpc = WorkerShellRpc::new(
        fixture.root.clone(),
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let result = rpc
        .execute(ShellExecuteParams {
            command: blocking_command_with_marker(),
            working_dir: Some(".".to_string()),
            timeout: Some(1),
            restrict_to_workspace: Some(true),
            sandbox_mode: None,
            network_mode: None,
            cancellation: None,
        })
        .expect("timed out shell execute should return a structured result");

    assert!(result.timed_out, "{result:?}");
    assert!(!result.cancelled);
    assert_eq!(result.exit_code, -1);
    assert!(result.content.contains("timed out"));
    assert_eq!(rpc.active_process_count(), 0);
}

#[cfg(unix)]
#[test]
fn execute_kills_shell_process_group_when_cancelled() {
    let fixture = ShellFixture::new();
    let started_marker = fixture.root.join("started.txt");
    let survived_marker = fixture.root.join("child-survived.txt");
    let cancellation = Arc::new(TestCancellation::default());
    let rpc = WorkerShellRpc::new(
        fixture.root.clone(),
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );
    let execute_cancellation = cancellation.clone();

    let started = std::time::Instant::now();
    let handle = std::thread::spawn(move || {
        rpc.execute(ShellExecuteParams {
            command: child_process_command_with_marker(),
            working_dir: Some(".".to_string()),
            timeout: Some(30),
            restrict_to_workspace: Some(true),
            sandbox_mode: None,
            network_mode: None,
            cancellation: Some(execute_cancellation),
        })
    });

    while !started_marker.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "shell command should create the started marker"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    cancellation.cancel();

    let result = handle
        .join()
        .expect("shell execute thread should not panic")
        .expect("cancelled shell execute should return a structured result");
    assert!(result.cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cancelled shell process group should return promptly"
    );
    std::thread::sleep(Duration::from_millis(1200));
    assert!(
        !survived_marker.exists(),
        "a cancelled shell child process must not continue after its parent exits"
    );
}

#[cfg(target_os = "windows")]
fn large_output_command() -> String {
    "for /L %i in (1,1,40000) do @echo xxxxx".to_string()
}

#[cfg(not(target_os = "windows"))]
fn large_output_command() -> String {
    "yes x | head -c 200000".to_string()
}

#[cfg(target_os = "windows")]
fn blocking_command_with_marker() -> String {
    "echo started > started.txt & for /L %i in (0,0,1) do @rem".to_string()
}

#[cfg(not(target_os = "windows"))]
fn blocking_command_with_marker() -> String {
    "printf started > started.txt; while true; do :; done".to_string()
}

#[cfg(unix)]
fn child_process_command_with_marker() -> String {
    "printf started > started.txt; (sleep 1; printf survived > child-survived.txt) & wait"
        .to_string()
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

struct ShellFixture {
    root: PathBuf,
}

impl ShellFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-shell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("shell fixture should create");
        Self { root }
    }
}

impl Drop for ShellFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
