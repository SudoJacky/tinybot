use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
        let timeout = params
            .timeout
            .unwrap_or(60)
            .clamp(1, MAX_TIMEOUT_SECONDS);
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
                blocked: true,
                truncated: false,
                content: reason,
            });
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

        let mut child = command.spawn().map_err(|error| {
            shell_error(
                "failed to start shell command",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let started = Instant::now();
        let timeout_duration = Duration::from_secs(timeout);
        let mut timed_out = false;
        loop {
            if let Some(_status) = child.try_wait().map_err(|error| {
                shell_error(
                    "failed to poll shell command",
                    serde_json::json!({ "error": error.to_string() }),
                )
            })? {
                break;
            }
            if started.elapsed() >= timeout_duration {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        let status = child.wait().map_err(|error| {
            shell_error(
                "failed to wait for shell command",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let exit_code = if timed_out {
            -1
        } else {
            status.code().unwrap_or(-1)
        };
        let mut content = format_shell_content(&stdout, &stderr, exit_code, timed_out);
        let truncated = content.chars().count() > MAX_OUTPUT_CHARS;
        if truncated {
            content = truncate_head_tail(&content, MAX_OUTPUT_CHARS);
        }
        Ok(ShellExecuteResult {
            stdout,
            stderr,
            exit_code,
            timed_out,
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
            if normalized.starts_with('/') || normalized.contains(':') || normalized.contains('\0') {
                return Err(invalid_shell_request("working_dir must be workspace-relative"));
            }
            if normalized.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
                return Err(invalid_shell_request("working_dir must be workspace-relative"));
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

#[derive(Clone, Debug, Deserialize)]
pub struct ShellExecuteParams {
    pub command: String,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub restrict_to_workspace: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ShellExecuteResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
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
        || lower.contains("rm -rf __pycache__")
        || lower.contains("rm -rf .pytest_cache")
        || lower.contains("rm -rf dist")
        || lower.contains("rm -rf build")
        || lower.contains("rm -rf target")
        || lower.contains("rm -rf .ruff_cache")
    {
        return None;
    }
    let denied = [
        "rm -rf",
        "rm -fr",
        "del /f",
        "del /q",
        "rmdir /s",
        "shred",
        "mkfs",
        "diskpart",
        "shutdown",
        "reboot",
        "poweroff",
        "format ",
        "format\t",
        "format\n",
        "sudo rm",
        "sudo dd",
    ];
    if denied.iter().any(|pattern| lower.contains(pattern)) || lower.starts_with("format") {
        return Some("Error: Command blocked by safety guard (dangerous pattern detected)".to_string());
    }
    if lower.contains("../") || lower.contains("..\\") {
        return Some("Error: Command blocked by safety guard (path traversal detected)".to_string());
    }
    if contains_private_url(&lower) {
        return Some("Error: Command blocked by safety guard (internal/private URL detected)".to_string());
    }
    if contains_absolute_path_outside_workspace(command, working_dir, workspace_root) {
        return Some("Error: Command blocked by safety guard (path outside working dir)".to_string());
    }
    None
}

fn contains_private_url(command: &str) -> bool {
    ["127.0.0.1", "localhost", "0.0.0.0", "10.", "192.168.", "169.254."]
        .iter()
        .any(|needle| command.contains(needle))
}

fn contains_absolute_path_outside_workspace(command: &str, working_dir: &Path, workspace_root: &Path) -> bool {
    let root = workspace_root.canonicalize().unwrap_or_else(|_| workspace_root.to_path_buf());
    let cwd = working_dir.canonicalize().unwrap_or_else(|_| working_dir.to_path_buf());
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

fn format_shell_content(stdout: &str, stderr: &str, exit_code: i32, timed_out: bool) -> String {
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
