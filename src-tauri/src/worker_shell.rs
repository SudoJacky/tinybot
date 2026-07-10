use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
    WorkerRequestCancellation,
};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const MAX_TIMEOUT_SECONDS: u64 = 600;
const MAX_OUTPUT_CHARS: usize = 10_000;

#[derive(Clone, Debug)]
pub struct WorkerShellRpc {
    workspace_root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerShellRpc {
    pub fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self {
            workspace_root,
            policy,
        }
    }

    pub fn execute(
        &self,
        params: ShellExecuteParams,
    ) -> Result<ShellExecuteResult, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        let timeout = params.timeout.unwrap_or(60).clamp(1, MAX_TIMEOUT_SECONDS);
        let working_dir = self.resolve_working_dir(
            params.working_dir.as_deref().unwrap_or("."),
            params.restrict_to_workspace.unwrap_or(true),
        )?;
        if let Some(reason) = guard_command(&params.command, &working_dir, &self.workspace_root) {
            return Ok(ShellExecuteResult {
                stdout: String::new(),
                stderr: reason.clone(),
                exit_code: 1,
                timed_out: false,
                cancelled: false,
                blocked: true,
                truncated: false,
                content: reason,
            });
        }
        if is_cancelled(&params.cancellation) {
            return Ok(cancelled_shell_result(String::new(), String::new()));
        }

        let mut command = shell_command(&params.command);
        command
            .current_dir(&working_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let mut child = command.spawn().map_err(|error| {
            shell_error(
                "failed to start shell command",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let stdout_reader = child.stdout.take().map(read_pipe_to_string);
        let stderr_reader = child.stderr.take().map(read_pipe_to_string);
        let started = Instant::now();
        let timeout_duration = Duration::from_secs(timeout);
        let mut timed_out = false;
        let mut cancelled = false;
        loop {
            if let Some(_status) = child.try_wait().map_err(|error| {
                shell_error(
                    "failed to poll shell command",
                    serde_json::json!({ "error": error.to_string() }),
                )
            })? {
                break;
            }
            if is_cancelled(&params.cancellation) {
                cancelled = true;
                terminate_child_process(&mut child).map_err(|error| {
                    shell_error(
                        "failed to terminate shell process tree",
                        serde_json::json!({ "error": error.to_string() }),
                    )
                })?;
                break;
            }
            if started.elapsed() >= timeout_duration {
                timed_out = true;
                terminate_child_process(&mut child).map_err(|error| {
                    shell_error(
                        "failed to terminate shell process tree",
                        serde_json::json!({ "error": error.to_string() }),
                    )
                })?;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        let status = child.wait().map_err(|error| {
            shell_error(
                "failed to wait for shell command",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let stdout = join_pipe_reader(stdout_reader);
        let stderr = join_pipe_reader(stderr_reader);
        let exit_code = if timed_out || cancelled {
            -1
        } else {
            status.code().unwrap_or(-1)
        };
        let mut content = format_shell_content(&stdout, &stderr, exit_code, timed_out, cancelled);
        let truncated = content.chars().count() > MAX_OUTPUT_CHARS;
        if truncated {
            content = truncate_head_tail(&content, MAX_OUTPUT_CHARS);
        }
        Ok(ShellExecuteResult {
            stdout,
            stderr,
            exit_code,
            timed_out,
            cancelled,
            blocked: false,
            truncated,
            content,
        })
    }

    fn resolve_working_dir(
        &self,
        requested: &str,
        restrict_to_workspace: bool,
    ) -> Result<PathBuf, WorkerProtocolError> {
        let root = self.workspace_root.canonicalize().map_err(|error| {
            shell_error(
                "failed to resolve workspace root",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let candidate = if requested == "." {
            root.clone()
        } else {
            let normalized = requested.replace('\\', "/");
            if normalized.starts_with('/') || normalized.contains(':') || normalized.contains('\0')
            {
                return Err(invalid_shell_request(
                    "working_dir must be workspace-relative",
                ));
            }
            if normalized
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err(invalid_shell_request(
                    "working_dir must be workspace-relative",
                ));
            }
            normalized
                .split('/')
                .fold(root.clone(), |path, part| path.join(part))
        };
        if !candidate.exists() {
            return Err(invalid_shell_request("working_dir does not exist"));
        }
        let canonical = candidate.canonicalize().map_err(|error| {
            shell_error(
                "failed to resolve working_dir",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        if restrict_to_workspace && !canonical.starts_with(&root) {
            return Err(invalid_shell_request("working_dir escapes workspace"));
        }
        Ok(canonical)
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

fn read_pipe_to_string<R>(mut reader: R) -> JoinHandle<String>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = String::new();
        let _ = reader.read_to_string(&mut output);
        output
    })
}

fn join_pipe_reader(reader: Option<JoinHandle<String>>) -> String {
    reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

fn terminate_child_process(child: &mut Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let process_group = child.id() as libc::pid_t;
        // SAFETY: the process group is created from the child PID before exec.
        if unsafe { libc::kill(-process_group, libc::SIGKILL) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut taskkill = Command::new("taskkill");
        taskkill
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        let _ = taskkill.status();
        let _ = child.kill();
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        child.kill()?;
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
pub struct ShellExecuteParams {
    pub command: String,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub restrict_to_workspace: Option<bool>,
    #[serde(skip)]
    pub cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
}

impl fmt::Debug for ShellExecuteParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShellExecuteParams")
            .field("command", &self.command)
            .field("working_dir", &self.working_dir)
            .field("timeout", &self.timeout)
            .field("restrict_to_workspace", &self.restrict_to_workspace)
            .field("has_cancellation", &self.cancellation.is_some())
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ShellExecuteResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
    pub cancelled: bool,
    pub blocked: bool,
    pub truncated: bool,
    pub content: String,
}

fn shell_command(command: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut shell = Command::new("cmd");
        shell.args(["/C", command]);
        shell
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut shell = Command::new("sh");
        shell.args(["-c", command]);
        shell
    }
}

fn guard_command(command: &str, working_dir: &Path, workspace_root: &Path) -> Option<String> {
    let lower = command.trim().to_ascii_lowercase();
    if lower.contains("rm -rf node_modules")
        || lower.contains("rm -rf dist")
        || lower.contains("rm -rf build")
        || lower.contains("rm -rf target")
    {
        return None;
    }
    let denied = [
        "rm -rf", "rm -fr", "del /f", "del /q", "rmdir /s", "shred", "mkfs", "diskpart",
        "shutdown", "reboot", "poweroff", "format ", "format\t", "format\n", "sudo rm", "sudo dd",
    ];
    if denied.iter().any(|pattern| lower.contains(pattern)) || lower.starts_with("format") {
        return Some(
            "Error: Command blocked by safety guard (dangerous pattern detected)".to_string(),
        );
    }
    if lower.contains("../") || lower.contains("..\\") {
        return Some(
            "Error: Command blocked by safety guard (path traversal detected)".to_string(),
        );
    }
    if contains_private_url(&lower) {
        return Some(
            "Error: Command blocked by safety guard (internal/private URL detected)".to_string(),
        );
    }
    if contains_absolute_path_outside_workspace(command, working_dir, workspace_root) {
        return Some(
            "Error: Command blocked by safety guard (path outside working dir)".to_string(),
        );
    }
    None
}

fn contains_private_url(command: &str) -> bool {
    [
        "127.0.0.1",
        "localhost",
        "0.0.0.0",
        "10.",
        "192.168.",
        "169.254.",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn contains_absolute_path_outside_workspace(
    command: &str,
    working_dir: &Path,
    workspace_root: &Path,
) -> bool {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let cwd = working_dir
        .canonicalize()
        .unwrap_or_else(|_| working_dir.to_path_buf());
    command.split_whitespace().any(|token| {
        let cleaned = token.trim_matches(|ch| ch == '"' || ch == '\'' || ch == ';' || ch == '|');
        let path = PathBuf::from(cleaned);
        if !path.is_absolute() {
            return false;
        }
        let resolved = path.canonicalize().unwrap_or(path);
        !resolved.starts_with(&cwd) && !resolved.starts_with(&root)
    })
}

fn is_cancelled(cancellation: &Option<Arc<dyn WorkerRequestCancellation>>) -> bool {
    cancellation
        .as_ref()
        .is_some_and(|cancellation| cancellation.is_cancelled())
}

fn cancelled_shell_result(stdout: String, stderr: String) -> ShellExecuteResult {
    ShellExecuteResult {
        stdout,
        stderr,
        exit_code: -1,
        timed_out: false,
        cancelled: true,
        blocked: false,
        truncated: false,
        content: "Error: Command aborted by user\n\nExit code: -1".to_string(),
    }
}

fn format_shell_content(
    stdout: &str,
    stderr: &str,
    exit_code: i32,
    timed_out: bool,
    cancelled: bool,
) -> String {
    if cancelled {
        return "Error: Command aborted by user\n\nExit code: -1".to_string();
    }
    if timed_out {
        return "Error: Command timed out\n\nExit code: -1".to_string();
    }
    let mut parts = Vec::new();
    if !stdout.is_empty() {
        parts.push(stdout.trim_end().to_string());
    }
    if !stderr.trim().is_empty() {
        parts.push(format!("STDERR:\n{}", stderr.trim_end()));
    }
    parts.push(format!("Exit code: {exit_code}"));
    parts.join("\n\n")
}

fn truncate_head_tail(content: &str, max_chars: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= max_chars {
        return content.to_string();
    }
    let half = max_chars / 2;
    let head: String = chars[..half].iter().collect();
    let tail: String = chars[chars.len() - half..].iter().collect();
    format!(
        "{head}\n\n... ({} chars truncated) ...\n\n{tail}",
        chars.len() - max_chars
    )
}

fn invalid_shell_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({}),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn shell_error(message: impl Into<String>, details: serde_json::Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_protocol::WorkerRequestCancellation;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

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
}
