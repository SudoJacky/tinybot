use super::config::ResolvedCommandHook;
use super::managed::{read_bounded_script, script_revision};
use super::{CommandHookEvent, CommandHookRequest, CommandHookRunResult};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_STDOUT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;

pub(super) async fn run_hook(
    hook: ResolvedCommandHook,
    request: CommandHookRequest,
    workspace_root: PathBuf,
) -> CommandHookRunResult {
    let started = Instant::now();
    let mut result = CommandHookRunResult {
        hook_hash: hook.hash.clone(),
        hook_name: hook
            .handler
            .status_message
            .clone()
            .unwrap_or_else(|| hook.event.as_str().to_string()),
        source_path: hook.source_path.clone(),
        ..CommandHookRunResult::default()
    };
    if let Some(managed) = hook.managed.as_ref() {
        let current_revision = match read_bounded_script(&managed.script_path) {
            Ok(contents) => script_revision(&contents),
            Err(error) => {
                result.failure = Some(format!("failed to validate managed hook script: {error}"));
                result.decision = "failed".to_string();
                return finish(result, started);
            }
        };
        if current_revision != managed.script_revision {
            result.failure = Some(format!(
                "managed hook script `{}` changed after it was trusted",
                managed.id
            ));
            result.decision = "failed".to_string();
            return finish(result, started);
        }
    }
    let payload = hook_input_payload(&request, &workspace_root);
    let stdin = match serde_json::to_vec(&payload) {
        Ok(stdin) if stdin.len() <= MAX_STDIN_BYTES => stdin,
        Ok(_) => {
            result.failure = Some("hook input exceeds the 1 MiB limit".to_string());
            result.decision = "failed".to_string();
            return finish(result, started);
        }
        Err(error) => {
            result.failure = Some(format!("failed to serialize hook input: {error}"));
            result.decision = "failed".to_string();
            return finish(result, started);
        }
    };
    let mut command = shell_command(hook.handler.command_for_platform());
    command
        .current_dir(&workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_hidden_window(&mut command);
    configure_process_group(&mut command);
    #[cfg(windows)]
    let process_job = match crate::tools::shell::WindowsProcessJob::new() {
        Ok(job) => job,
        Err(error) => {
            result.failure = Some(format!("failed to create hook process job: {error}"));
            result.decision = "failed".to_string();
            return finish(result, started);
        }
    };
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            result.failure = Some(format!("failed to start hook command: {error}"));
            result.decision = "failed".to_string();
            return finish(result, started);
        }
    };
    #[cfg(windows)]
    if let Err(error) = child
        .raw_handle()
        .ok_or_else(|| "hook process exited before job assignment".to_string())
        .and_then(|handle| {
            process_job
                .assign_raw_handle(handle)
                .map_err(|error| error.to_string())
        })
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
        result.failure = Some(format!("failed to assign hook process job: {error}"));
        result.decision = "failed".to_string();
        return finish(result, started);
    }
    let process_id = child.id();
    let mut stdin_task = child.stdin.take().map(|mut pipe| {
        tokio::spawn(async move {
            let _ = pipe.write_all(&stdin).await;
            let _ = pipe.shutdown().await;
        })
    });
    let mut stdout_task = child
        .stdout
        .take()
        .map(|pipe| tokio::spawn(read_bounded(pipe, MAX_STDOUT_BYTES)));
    let mut stderr_task = child
        .stderr
        .take()
        .map(|pipe| tokio::spawn(read_bounded(pipe, MAX_STDERR_BYTES)));
    let timeout = Duration::from_secs(hook.handler.timeout_seconds());
    let deadline = tokio::time::Instant::now() + timeout;
    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            result.failure = Some(format!("failed to wait for hook command: {error}"));
            result.decision = "failed".to_string();
            abort_io_tasks(&mut stdin_task, &mut stdout_task, &mut stderr_task);
            #[cfg(windows)]
            let _ = process_job.terminate();
            let _ = terminate_process_tree(&mut child, process_id).await;
            return finish(result, started);
        }
        Err(_) => {
            abort_io_tasks(&mut stdin_task, &mut stdout_task, &mut stderr_task);
            #[cfg(windows)]
            let _ = process_job.terminate();
            let _ = terminate_process_tree(&mut child, process_id).await;
            result.failure = Some(format!(
                "hook command timed out after {} seconds",
                hook.handler.timeout_seconds()
            ));
            result.decision = "failed".to_string();
            return finish(result, started);
        }
    };
    let drained = tokio::time::timeout_at(deadline, async {
        if let Some(task) = stdin_task.as_mut() {
            let _ = task.await;
        }
        let stdout = join_output(&mut stdout_task).await;
        let stderr = join_output(&mut stderr_task).await;
        (stdout, stderr)
    })
    .await;
    let ((stdout, stdout_truncated), (stderr, stderr_truncated)) = match drained {
        Ok(output) => output,
        Err(_) => {
            abort_io_tasks(&mut stdin_task, &mut stdout_task, &mut stderr_task);
            #[cfg(windows)]
            let _ = process_job.terminate();
            let _ = terminate_process_tree(&mut child, process_id).await;
            result.failure = Some(format!(
                "hook command timed out after {} seconds",
                hook.handler.timeout_seconds()
            ));
            result.decision = "failed".to_string();
            return finish(result, started);
        }
    };
    let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    if stdout_truncated || stderr_truncated {
        result.failure = Some("hook output exceeded its configured runtime limit".to_string());
        result.decision = "failed".to_string();
        return finish(result, started);
    }
    if status.code() == Some(2) {
        let reason = non_empty(&stderr).unwrap_or_else(|| "hook blocked the operation".to_string());
        apply_exit_two(&mut result, request.event, reason);
        return finish(result, started);
    }
    if !status.success() {
        result.failure = Some(format!(
            "hook command exited with status {}",
            status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string())
        ));
        result.decision = "failed".to_string();
        return finish(result, started);
    }
    if stdout.is_empty() {
        result.decision = "continue".to_string();
        return finish(result, started);
    }
    let output = match serde_json::from_str::<Value>(&stdout) {
        Ok(output) => output,
        Err(_) if request.event == CommandHookEvent::UserPromptSubmit => {
            result.additional_context =
                Some(truncate_context(stdout, hook.handler.context_limit_chars()));
            result.decision = "additional_context".to_string();
            return finish(result, started);
        }
        Err(error) => {
            result.failure = Some(format!("hook stdout is not valid JSON: {error}"));
            result.decision = "failed".to_string();
            return finish(result, started);
        }
    };
    if let Err(error) = apply_json_output(
        &mut result,
        request.event,
        &output,
        hook.handler.context_limit_chars(),
    ) {
        result.failure = Some(error);
        result.decision = "failed".to_string();
    }
    finish(result, started)
}

fn hook_input_payload(request: &CommandHookRequest, workspace_root: &PathBuf) -> Value {
    let mut payload = serde_json::json!({
        "session_id": request.session_id,
        "transcript_path": Value::Null,
        "cwd": workspace_root,
        "hook_event_name": request.event.as_str(),
        "model": request.model,
        "turn_id": request.turn_id,
        "permission_mode": request.permission_mode,
    });
    let object = payload
        .as_object_mut()
        .expect("constructed hook payload must be an object");
    match request.event {
        CommandHookEvent::UserPromptSubmit => {
            object.insert(
                "prompt".to_string(),
                Value::String(request.prompt.clone().unwrap_or_default()),
            );
        }
        CommandHookEvent::PreToolUse | CommandHookEvent::PostToolUse => {
            object.insert(
                "tool_name".to_string(),
                Value::String(request.tool_name.clone().unwrap_or_default()),
            );
            object.insert(
                "tool_use_id".to_string(),
                Value::String(request.tool_use_id.clone().unwrap_or_default()),
            );
            object.insert(
                "tool_input".to_string(),
                request.tool_input.clone().unwrap_or(Value::Null),
            );
            if request.event == CommandHookEvent::PostToolUse {
                object.insert(
                    "tool_response".to_string(),
                    request.tool_response.clone().unwrap_or(Value::Null),
                );
            }
        }
        CommandHookEvent::PostCompact => {
            object.insert(
                "trigger".to_string(),
                Value::String(
                    request
                        .trigger
                        .clone()
                        .unwrap_or_else(|| "auto".to_string()),
                ),
            );
        }
    }
    payload
}

pub(super) fn apply_json_output(
    result: &mut CommandHookRunResult,
    event: CommandHookEvent,
    output: &Value,
    context_limit: usize,
) -> Result<(), String> {
    let object = output
        .as_object()
        .ok_or_else(|| "hook stdout JSON must be an object".to_string())?;
    if object
        .get("suppressOutput")
        .or_else(|| object.get("suppress_output"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err("suppressOutput is not supported by Tinybot hooks".to_string());
    }
    result.system_message =
        string_field(object, "systemMessage").or_else(|| string_field(object, "system_message"));
    let specific = object
        .get("hookSpecificOutput")
        .or_else(|| object.get("hook_specific_output"))
        .and_then(Value::as_object);
    if let Some(specific) = specific {
        if let Some(event_name) = string_field(specific, "hookEventName")
            .or_else(|| string_field(specific, "hook_event_name"))
        {
            if event_name != event.as_str() {
                return Err(format!(
                    "hookSpecificOutput event `{event_name}` does not match {}",
                    event.as_str()
                ));
            }
        }
        result.additional_context = string_field(specific, "additionalContext")
            .or_else(|| string_field(specific, "additional_context"))
            .map(|context| truncate_context(context, context_limit));
    }
    let continue_run = object.get("continue").and_then(Value::as_bool);
    let stop_reason =
        string_field(object, "stopReason").or_else(|| string_field(object, "stop_reason"));
    let legacy_decision = string_field(object, "decision");
    let legacy_reason = string_field(object, "reason");
    match event {
        CommandHookEvent::UserPromptSubmit => {
            if legacy_decision.as_deref() == Some("block") || continue_run == Some(false) {
                result.denied_reason = legacy_reason
                    .or(stop_reason)
                    .or_else(|| Some("user prompt blocked by hook".to_string()));
                result.decision = "deny".to_string();
            }
        }
        CommandHookEvent::PreToolUse => {
            let permission_decision = specific
                .and_then(|specific| string_field(specific, "permissionDecision"))
                .or_else(|| {
                    specific.and_then(|specific| string_field(specific, "permission_decision"))
                });
            if permission_decision.as_deref() == Some("deny")
                || legacy_decision.as_deref() == Some("block")
            {
                result.denied_reason = specific
                    .and_then(|specific| string_field(specific, "permissionDecisionReason"))
                    .or_else(|| {
                        specific.and_then(|specific| {
                            string_field(specific, "permission_decision_reason")
                        })
                    })
                    .or(legacy_reason)
                    .or_else(|| Some("tool use blocked by hook".to_string()));
                result.decision = "deny".to_string();
            } else if let Some(updated_input) = specific
                .and_then(|specific| specific.get("updatedInput"))
                .or_else(|| specific.and_then(|specific| specific.get("updated_input")))
            {
                if permission_decision.as_deref() != Some("allow") {
                    return Err("updatedInput requires permissionDecision `allow`".to_string());
                }
                if !updated_input.is_object() {
                    return Err("updatedInput must be a JSON object".to_string());
                }
                result.updated_input = Some(updated_input.clone());
                result.decision = "replace_input".to_string();
            }
        }
        CommandHookEvent::PostToolUse => {
            if legacy_decision.as_deref() == Some("block") || continue_run == Some(false) {
                result.tool_feedback = legacy_reason
                    .or(stop_reason)
                    .or_else(|| Some("tool result blocked by hook".to_string()));
                result.decision = "replace_tool_result".to_string();
            }
        }
        CommandHookEvent::PostCompact => {
            if continue_run == Some(false) {
                result.denied_reason =
                    stop_reason.or_else(|| Some("turn stopped by PostCompact hook".to_string()));
                result.decision = "deny".to_string();
            }
        }
    }
    if result.decision.is_empty() {
        result.decision = if result.additional_context.is_some() {
            "additional_context".to_string()
        } else if result.system_message.is_some() {
            "system_message".to_string()
        } else {
            "continue".to_string()
        };
    }
    Ok(())
}

fn apply_exit_two(result: &mut CommandHookRunResult, event: CommandHookEvent, reason: String) {
    match event {
        CommandHookEvent::UserPromptSubmit | CommandHookEvent::PreToolUse => {
            result.denied_reason = Some(reason);
            result.decision = "deny".to_string();
        }
        CommandHookEvent::PostToolUse => {
            result.tool_feedback = Some(reason);
            result.decision = "replace_tool_result".to_string();
        }
        CommandHookEvent::PostCompact => {
            result.failure = Some("exit code 2 is unsupported for PostCompact".to_string());
            result.decision = "failed".to_string();
        }
    }
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).and_then(non_empty)
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn truncate_context(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value
    } else {
        let mut truncated = value.chars().take(max_chars).collect::<String>();
        truncated.push_str("\n[hook context truncated]");
        truncated
    }
}

fn finish(mut result: CommandHookRunResult, started: Instant) -> CommandHookRunResult {
    result.duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    result
}

async fn read_bounded<R>(mut reader: R, limit: usize) -> (Vec<u8>, bool)
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(count) => {
                let remaining = limit.saturating_sub(output.len());
                output.extend_from_slice(&chunk[..count.min(remaining)]);
                truncated |= count > remaining;
            }
            Err(_) => break,
        }
    }
    (output, truncated)
}

async fn join_output(
    task: &mut Option<tokio::task::JoinHandle<(Vec<u8>, bool)>>,
) -> (Vec<u8>, bool) {
    match task.as_mut() {
        Some(task) => task.await.unwrap_or_default(),
        None => (Vec::new(), false),
    }
}

fn abort_io_tasks(
    stdin: &mut Option<tokio::task::JoinHandle<()>>,
    stdout: &mut Option<tokio::task::JoinHandle<(Vec<u8>, bool)>>,
    stderr: &mut Option<tokio::task::JoinHandle<(Vec<u8>, bool)>>,
) {
    if let Some(task) = stdin.take() {
        task.abort();
    }
    if let Some(task) = stdout.take() {
        task.abort();
    }
    if let Some(task) = stderr.take() {
        task.abort();
    }
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut shell = Command::new("cmd.exe");
        shell.args(["/D", "/S", "/C", command]);
        shell
    }
    #[cfg(not(windows))]
    {
        let mut shell = Command::new("sh");
        shell.args(["-lc", command]);
        shell
    }
}

#[cfg(windows)]
fn configure_hidden_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_hidden_window(_command: &mut Command) {}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.as_std_mut().pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

async fn terminate_process_tree(child: &mut Child, process_id: Option<u32>) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(process_id) = process_id {
        unsafe {
            libc::kill(-(process_id as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = process_id;
    child
        .kill()
        .await
        .map_err(|error| format!("failed to terminate hook process: {error}"))?;
    let _ = child.wait().await;
    Ok(())
}
