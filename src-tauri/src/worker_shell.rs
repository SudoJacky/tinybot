use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_permission_profile::{PermissionNetworkMode, ShellSandboxMode};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
    WorkerRequestCancellation,
};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

mod process_manager;
#[cfg(test)]
mod process_manager_tests;
mod sandbox;
#[cfg(test)]
mod sandbox_tests;

use self::process_manager::{ShellProcessManager, ValidatedShellStart};
use self::sandbox::select_shell_sandbox;

const MAX_TIMEOUT_SECONDS: u64 = 600;
const MAX_OUTPUT_CHARS: usize = 10_000;

#[derive(Clone, Debug)]
pub struct WorkerShellRpc {
    workspace_root: PathBuf,
    policy: CapabilityPolicy,
    processes: ShellProcessManager,
}

#[derive(Clone, Debug)]
pub struct WorkerShellRuntime {
    processes: ShellProcessManager,
}

impl Default for WorkerShellRuntime {
    fn default() -> Self {
        Self {
            processes: ShellProcessManager::new(),
        }
    }
}

impl WorkerShellRpc {
    pub fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self::with_runtime(workspace_root, policy, WorkerShellRuntime::default())
    }

    pub fn with_runtime(
        workspace_root: PathBuf,
        policy: CapabilityPolicy,
        runtime: WorkerShellRuntime,
    ) -> Self {
        Self {
            workspace_root,
            policy,
            processes: runtime.processes,
        }
    }

    pub fn use_runtime(mut self, runtime: WorkerShellRuntime) -> Self {
        self.processes = runtime.processes;
        self
    }

    pub(crate) fn validate_security_request(
        &self,
        sandbox_mode: ShellSandboxMode,
        network_mode: PermissionNetworkMode,
        tty: bool,
    ) -> Result<(), WorkerProtocolError> {
        select_shell_sandbox(sandbox_mode, network_mode, tty).map(|_| ())
    }

    pub fn start(
        &self,
        params: ShellStartParams,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        self.start_with_approval_decision(params, "internal_direct")
    }

    pub(crate) fn start_with_approval_decision(
        &self,
        params: ShellStartParams,
        approval_decision: &str,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        let run_id = required_process_owner(params.run_id, "runId")?;
        let tool_call_id = required_process_owner(params.tool_call_id, "toolCallId")?;
        let requested_working_dir = params.working_dir.as_deref().unwrap_or(".");
        let working_dir = self.resolve_working_dir(
            requested_working_dir,
            params.restrict_to_workspace.unwrap_or(true),
        )?;
        let sandbox = select_shell_sandbox(
            params.sandbox_mode.unwrap_or_default(),
            params
                .network_mode
                .unwrap_or(PermissionNetworkMode::Unrestricted),
            params.tty.unwrap_or(false),
        )?;
        if let Some(reason) = guard_command(&params.command, &working_dir, &self.workspace_root) {
            return Err(shell_error(
                "shell command blocked by safety guard",
                serde_json::json!({
                    "blocked": true,
                    "reason": reason,
                }),
            ));
        }
        if is_cancelled(&params.cancellation) {
            return Err(shell_error(
                "shell process start was cancelled",
                serde_json::json!({ "cancelled": true }),
            ));
        }
        self.processes.start(ValidatedShellStart {
            command: params.command,
            working_dir,
            working_dir_display: normalize_working_dir_display(requested_working_dir),
            tty: params.tty.unwrap_or(false),
            yield_time_ms: params.yield_time_ms.unwrap_or(10_000),
            rows: params.rows.unwrap_or(24).max(1),
            cols: params.cols.unwrap_or(80).max(1),
            run_id: Some(run_id),
            tool_call_id: Some(tool_call_id),
            cancellation: params.cancellation,
            sandbox_adapter: sandbox.adapter,
            sandbox_mode: sandbox.sandbox_label.to_string(),
            network_mode: sandbox.network_label.to_string(),
            approval_decision: approval_decision.to_string(),
        })
    }

    pub fn poll(
        &self,
        params: ShellProcessPollParams,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        self.processes.poll(
            &params.process_id,
            params.run_id.as_deref(),
            params.cursor.unwrap_or(0),
            params.yield_time_ms.unwrap_or(1_000),
        )
    }

    pub fn write_stdin(
        &self,
        params: ShellProcessInputParams,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        self.processes.write_stdin(
            &params.process_id,
            params.run_id.as_deref(),
            params.input.as_bytes(),
            params.cursor.unwrap_or(0),
            params.yield_time_ms.unwrap_or(1_000),
        )
    }

    pub fn resize(&self, params: ShellProcessResizeParams) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        self.processes.resize(
            &params.process_id,
            params.run_id.as_deref(),
            params.rows,
            params.cols,
        )
    }

    pub fn interrupt(
        &self,
        params: ShellProcessIdParams,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        self.processes
            .interrupt(&params.process_id, params.run_id.as_deref())
    }

    pub fn terminate(
        &self,
        params: ShellProcessIdParams,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        self.processes
            .terminate(&params.process_id, params.run_id.as_deref())
    }

    pub fn terminate_run(&self, run_id: &str) -> ShellProcessCleanupReport {
        self.processes.terminate_run(run_id)
    }

    pub fn shutdown(&self) -> ShellProcessCleanupReport {
        self.processes.shutdown()
    }

    pub fn active_process_count(&self) -> usize {
        self.processes.active_count()
    }

    pub fn list(
        &self,
        params: ShellProcessListParams,
    ) -> Result<Vec<ShellProcessOutput>, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        Ok(self.processes.list(params.run_id.as_deref()))
    }

    pub fn execute(
        &self,
        params: ShellExecuteParams,
    ) -> Result<ShellExecuteResult, WorkerProtocolError> {
        self.execute_with_approval_decision(params, "internal_direct")
    }

    pub(crate) fn execute_with_approval_decision(
        &self,
        params: ShellExecuteParams,
        approval_decision: &str,
    ) -> Result<ShellExecuteResult, WorkerProtocolError> {
        self.require(WorkerCapability::ShellExecute)?;
        let timeout = params.timeout.unwrap_or(60).clamp(1, MAX_TIMEOUT_SECONDS);
        let requested_working_dir = params.working_dir.as_deref().unwrap_or(".");
        let working_dir = self.resolve_working_dir(
            requested_working_dir,
            params.restrict_to_workspace.unwrap_or(true),
        )?;
        let sandbox = select_shell_sandbox(
            params.sandbox_mode.unwrap_or_default(),
            params
                .network_mode
                .unwrap_or(PermissionNetworkMode::Unrestricted),
            false,
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
                sandbox_mode: sandbox.sandbox_label.to_string(),
                network_mode: sandbox.network_label.to_string(),
                approval_decision: approval_decision.to_string(),
            });
        }
        if is_cancelled(&params.cancellation) {
            return Ok(cancelled_shell_result(
                String::new(),
                String::new(),
                sandbox.sandbox_label,
                sandbox.network_label,
                approval_decision,
            ));
        }
        let started = Instant::now();
        let timeout_duration = Duration::from_secs(timeout);
        let mut output = self.processes.start(ValidatedShellStart {
            command: params.command,
            working_dir,
            working_dir_display: normalize_working_dir_display(requested_working_dir),
            tty: false,
            yield_time_ms: 20,
            rows: 24,
            cols: 80,
            run_id: None,
            tool_call_id: None,
            cancellation: params.cancellation,
            sandbox_adapter: sandbox.adapter,
            sandbox_mode: sandbox.sandbox_label.to_string(),
            network_mode: sandbox.network_label.to_string(),
            approval_decision: approval_decision.to_string(),
        })?;
        let process_id = output.process_id.clone();
        while output.running {
            if started.elapsed() >= timeout_duration {
                self.processes.timeout(&process_id, None)?;
                break;
            }
            let remaining = timeout_duration.saturating_sub(started.elapsed());
            let yield_time_ms = remaining.as_millis().clamp(1, 50) as u64;
            output = self
                .processes
                .poll(&process_id, None, output.cursor, yield_time_ms)?;
        }
        let output = self.processes.poll(&process_id, None, 0, 0)?;
        self.processes.release(&process_id)?;
        if let Some(failure) = output.failure.clone() {
            return Err(shell_error(
                "shell process failed",
                serde_json::json!({
                    "processId": process_id,
                    "status": output.status,
                    "failure": failure,
                }),
            ));
        }
        if output.status == "terminated" {
            return Err(shell_error(
                "shell process was terminated before completion",
                serde_json::json!({ "processId": process_id }),
            ));
        }
        let timed_out = output.status == "timed_out";
        let cancelled = output.status == "cancelled";
        let exit_code = if timed_out || cancelled {
            -1
        } else {
            output.exit_code.unwrap_or(-1)
        };
        let mut content = format_shell_content(
            &output.stdout,
            &output.stderr,
            exit_code,
            timed_out,
            cancelled,
        );
        if output.truncated {
            content.push_str(&format!(
                "\n\nOutput truncated: {} bytes discarded",
                output.dropped_bytes
            ));
        }
        let content_truncated = content.chars().count() > MAX_OUTPUT_CHARS;
        if content_truncated {
            content = truncate_head_tail(&content, MAX_OUTPUT_CHARS);
        }
        Ok(ShellExecuteResult {
            stdout: output.stdout,
            stderr: output.stderr,
            exit_code,
            timed_out,
            cancelled,
            blocked: false,
            truncated: output.truncated || content_truncated,
            content,
            sandbox_mode: output.sandbox_mode,
            network_mode: output.network_mode,
            approval_decision: output.approval_decision,
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

fn terminate_child_process(child: &mut Child) -> std::io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        let process_group = child.id() as libc::pid_t;
        // SAFETY: the process group is created from the child PID before exec.
        if unsafe { libc::kill(-process_group, libc::SIGKILL) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) || child.try_wait()?.is_none() {
                return Err(error);
            }
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
        let tree_result = taskkill.status();
        let child_result = child.kill();
        let tree_succeeded = tree_result
            .as_ref()
            .is_ok_and(std::process::ExitStatus::success);
        if !tree_succeeded && child_result.is_err() && child.try_wait()?.is_none() {
            let tree_failure = tree_result
                .map(|status| format!("taskkill exited with status {status}"))
                .unwrap_or_else(|error| format!("taskkill failed: {error}"));
            let child_failure = child_result
                .expect_err("failed child result should contain an error")
                .to_string();
            return Err(std::io::Error::other(format!(
                "{tree_failure}; direct child termination failed: {child_failure}"
            )));
        }
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
    #[serde(default, alias = "sandboxMode")]
    pub sandbox_mode: Option<ShellSandboxMode>,
    #[serde(default, alias = "networkMode")]
    pub network_mode: Option<PermissionNetworkMode>,
    #[serde(skip)]
    pub cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
}

#[derive(Clone, Deserialize)]
pub struct ShellStartParams {
    pub command: String,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub restrict_to_workspace: Option<bool>,
    #[serde(default)]
    pub tty: Option<bool>,
    #[serde(default)]
    pub yield_time_ms: Option<u64>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default, alias = "sandboxMode")]
    pub sandbox_mode: Option<ShellSandboxMode>,
    #[serde(default, alias = "networkMode")]
    pub network_mode: Option<PermissionNetworkMode>,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
    #[serde(default, alias = "toolCallId")]
    pub tool_call_id: Option<String>,
    #[serde(skip)]
    pub cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
}

impl fmt::Debug for ShellStartParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShellStartParams")
            .field("command", &self.command)
            .field("working_dir", &self.working_dir)
            .field("restrict_to_workspace", &self.restrict_to_workspace)
            .field("tty", &self.tty)
            .field("yield_time_ms", &self.yield_time_ms)
            .field("rows", &self.rows)
            .field("cols", &self.cols)
            .field("sandbox_mode", &self.sandbox_mode)
            .field("network_mode", &self.network_mode)
            .field("run_id", &self.run_id)
            .field("tool_call_id", &self.tool_call_id)
            .field("has_cancellation", &self.cancellation.is_some())
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ShellProcessPollParams {
    #[serde(alias = "processId", alias = "sessionId")]
    pub process_id: String,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
    #[serde(default)]
    pub cursor: Option<u64>,
    #[serde(default, alias = "yieldTimeMs")]
    pub yield_time_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ShellProcessInputParams {
    #[serde(alias = "processId", alias = "sessionId")]
    pub process_id: String,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
    #[serde(default, alias = "chars")]
    pub input: String,
    #[serde(default)]
    pub cursor: Option<u64>,
    #[serde(default, alias = "yieldTimeMs")]
    pub yield_time_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ShellProcessResizeParams {
    #[serde(alias = "processId", alias = "sessionId")]
    pub process_id: String,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ShellProcessIdParams {
    #[serde(alias = "processId", alias = "sessionId")]
    pub process_id: String,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ShellProcessListParams {
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutputChunk {
    pub sequence: u64,
    pub stream: String,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProcessOutput {
    pub process_id: String,
    pub system_process_id: Option<u32>,
    pub run_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub command: String,
    pub working_dir: String,
    pub tty: bool,
    pub status: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub output: String,
    pub chunks: Vec<ShellOutputChunk>,
    pub cursor: u64,
    pub truncated: bool,
    pub dropped_bytes: u64,
    pub started_at_ms: u64,
    pub last_activity_ms: u64,
    pub sandbox_mode: String,
    pub network_mode: String,
    pub approval_decision: String,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProcessCleanupReport {
    pub requested_process_ids: Vec<String>,
    pub terminated_process_ids: Vec<String>,
    pub failures: Vec<String>,
}

impl fmt::Debug for ShellExecuteParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShellExecuteParams")
            .field("command", &self.command)
            .field("working_dir", &self.working_dir)
            .field("timeout", &self.timeout)
            .field("restrict_to_workspace", &self.restrict_to_workspace)
            .field("sandbox_mode", &self.sandbox_mode)
            .field("network_mode", &self.network_mode)
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
    pub sandbox_mode: String,
    pub network_mode: String,
    pub approval_decision: String,
}

fn normalize_working_dir_display(requested: &str) -> String {
    if requested == "." {
        ".".to_string()
    } else {
        requested.replace('\\', "/")
    }
}

pub(in crate::worker_shell) fn process_working_dir(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        let verbatim_prefix = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
        if wide.starts_with(&verbatim_prefix) {
            let unc_prefix = [
                b'\\' as u16,
                b'\\' as u16,
                b'?' as u16,
                b'\\' as u16,
                b'U' as u16,
                b'N' as u16,
                b'C' as u16,
                b'\\' as u16,
            ];
            let normalized = if wide.starts_with(&unc_prefix) {
                let mut normalized = vec![b'\\' as u16, b'\\' as u16];
                normalized.extend_from_slice(&wide[unc_prefix.len()..]);
                normalized
            } else {
                wide[verbatim_prefix.len()..].to_vec()
            };
            return PathBuf::from(OsString::from_wide(&normalized));
        }
    }
    path.to_path_buf()
}

fn required_process_owner(
    value: Option<String>,
    field: &str,
) -> Result<String, WorkerProtocolError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid_shell_request(format!("{field} is required for shell.start")))
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

fn cancelled_shell_result(
    stdout: String,
    stderr: String,
    sandbox_mode: &str,
    network_mode: &str,
    approval_decision: &str,
) -> ShellExecuteResult {
    ShellExecuteResult {
        stdout,
        stderr,
        exit_code: -1,
        timed_out: false,
        cancelled: true,
        blocked: false,
        truncated: false,
        content: "Error: Command aborted by user\n\nExit code: -1".to_string(),
        sandbox_mode: sandbox_mode.to_string(),
        network_mode: network_mode.to_string(),
        approval_decision: approval_decision.to_string(),
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
}
