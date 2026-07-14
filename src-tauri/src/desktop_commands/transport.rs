use crate::agent_loop_runtime_protocol::AgentRuntimeEventEnvelope;
use crate::desktop_commands::agent::worker_run_agent_with_live_trace_sink_async;
use crate::native_agent_bridge::{desktop_agent_event_sink, persist_native_agent_run_start};
use crate::worker_agent_runtime::NativeAgentTraceSink;
use crate::worker_capability::default_desktop_capability_policy;
use crate::worker_permission_profile::{PermissionNetworkMode, ShellSandboxMode};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::worker_shell::{
    ShellProcessIdParams, ShellProcessListParams, ShellProcessOutput, ShellProcessPollParams,
    ShellStartParams, WorkerShellRpc,
};
use crate::worker_workspace::WorkerWorkspaceRpc;
use crate::{
    call_rust_state_service, experimental_worker_config_snapshot, lock_runtime,
    native_backend_workspace_root, SharedGateway,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{Runtime, State};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerTransportWebSocketDispatchInput {
    pub(crate) client_id: String,
    pub(crate) frame: serde_json::Value,
    #[serde(default)]
    pub(crate) attached_chat_id: Option<String>,
    #[serde(default)]
    pub(crate) session_exists: Option<bool>,
    #[serde(default)]
    pub(crate) editable_paths: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) max_iterations: Option<u32>,
    #[serde(default)]
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) stream: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WorkerTransportWebSocketDispatchOptions {
    pub(crate) model: Option<String>,
    pub(crate) max_iterations: Option<u32>,
    pub(crate) run_id: Option<String>,
    pub(crate) stream: Option<bool>,
}

#[tauri::command]
pub(crate) async fn worker_dispatch_tinyos_host_command<R: Runtime + 'static>(
    input: WorkerTransportWebSocketDispatchInput,
    state: State<'_, SharedGateway>,
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let shared = state.inner().clone();
    let workspace_root = native_backend_workspace_root();
    let config_snapshot = experimental_worker_config_snapshot();
    let live_trace_sink = desktop_agent_event_sink(app);
    worker_transport_dispatch_websocket_message_with_live_trace_sink_async(
        &shared,
        input,
        workspace_root,
        config_snapshot,
        Duration::from_secs(60),
        Some(live_trace_sink),
    )
    .await
}

#[cfg(test)]
pub(crate) fn worker_transport_dispatch_websocket_message_with_options(
    shared: &SharedGateway,
    input: WorkerTransportWebSocketDispatchInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::block_on(
        worker_transport_dispatch_websocket_message_with_live_trace_sink_async(
            shared,
            input,
            workspace_root,
            config_snapshot,
            timeout,
            None,
        ),
    )
}

async fn worker_transport_dispatch_websocket_message_with_live_trace_sink_async(
    shared: &SharedGateway,
    input: WorkerTransportWebSocketDispatchInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    validate_tinyos_host_command_frame(&input.frame)?;
    let Some(transport_result) = native_websocket_transport_result(&input) else {
        return unsupported_rust_only_command("worker_dispatch_tinyos_host_command");
    };
    dispatch_tinyos_command(
        shared,
        transport_result,
        workspace_root,
        config_snapshot,
        live_trace_sink,
        timeout,
    )
    .await
}

pub(crate) fn validate_tinyos_host_command_frame(frame: &serde_json::Value) -> Result<(), String> {
    if frame.get("type").and_then(serde_json::Value::as_str) != Some("command") {
        return Err(
            "worker_dispatch_tinyos_host_command accepts only TinyOS host commands; use worker_submit_thread_turn, worker_thread_interrupt, worker_resolve_thread_approval, or worker_submit_thread_form for chat"
                .to_string(),
        );
    }
    if matches!(
        frame
            .get("command_kind")
            .or_else(|| frame.get("commandKind"))
            .and_then(serde_json::Value::as_str),
        Some("agent.cancel" | "approval.resolve" | "form.submit" | "form.cancel")
    ) {
        return Err(
            "chat control commands must use the typed Thread API instead of the TinyOS host command dispatcher"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn native_websocket_transport_result(
    input: &WorkerTransportWebSocketDispatchInput,
) -> Option<serde_json::Value> {
    let frame = input.frame.as_object()?;
    if json_string_field(frame, "type") != Some("command") {
        return None;
    }
    let chat_id = json_string_field(frame, "chat_id")
        .or_else(|| json_string_field(frame, "chatId"))
        .or(input.attached_chat_id.as_deref())?;
    let command_id =
        json_string_field(frame, "command_id").or_else(|| json_string_field(frame, "commandId"))?;
    let command_kind = json_string_field(frame, "command_kind")
        .or_else(|| json_string_field(frame, "commandKind"))?;
    let run_id = json_string_field(frame, "run_id")
        .or_else(|| json_string_field(frame, "runId"))
        .or(input.run_id.as_deref())?;
    let session_id = json_string_field(frame, "session_id")
        .or_else(|| json_string_field(frame, "sessionId"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("websocket:{chat_id}"));
    let mut transport = serde_json::json!({
        "kind": "command",
        "chatId": chat_id,
        "sessionId": session_id,
        "commandId": command_id,
        "commandKind": command_kind,
        "runId": run_id,
        "turnId": json_string_field(frame, "turn_id").or_else(|| json_string_field(frame, "turnId")),
        "threadId": json_string_field(frame, "thread_id").or_else(|| json_string_field(frame, "threadId")),
        "source": frame.get("source").cloned().unwrap_or(serde_json::Value::Null),
        "frames": [],
    });
    if command_kind == "operation.retry" {
        transport["sourceTurnId"] = frame
            .get("source_turn_id")
            .or_else(|| frame.get("sourceTurnId"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["itemId"] = frame
            .get("item_id")
            .or_else(|| frame.get("itemId"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
    } else if command_kind == "agent.request_change" {
        transport["instruction"] = frame
            .get("instruction")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["observedRunId"] = frame
            .get("observed_run_id")
            .or_else(|| frame.get("observedRunId"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["references"] = frame
            .get("references")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
    } else if matches!(command_kind, "file.save" | "file.move" | "file.delete") {
        transport["path"] = frame
            .get("path")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["baseRevision"] = frame
            .get("base_revision")
            .or_else(|| frame.get("baseRevision"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["confirmed"] = frame
            .get("confirmed")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if command_kind == "file.save" {
            transport["content"] = frame
                .get("content")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            transport["createOnly"] = frame
                .get("create_only")
                .or_else(|| frame.get("createOnly"))
                .cloned()
                .unwrap_or(serde_json::Value::Bool(false));
        } else if command_kind == "file.move" {
            transport["targetPath"] = frame
                .get("target_path")
                .or_else(|| frame.get("targetPath"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
        }
    } else if command_kind == "terminal.execute" {
        transport["command"] = frame
            .get("command")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["cwd"] = frame.get("cwd").cloned().unwrap_or(serde_json::Value::Null);
        transport["confirmed"] = frame
            .get("confirmed")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
    } else if command_kind == "browser.interact" {
        transport["captureId"] = frame
            .get("capture_id")
            .or_else(|| frame.get("captureId"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["action"] = frame
            .get("action")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["confirmed"] = frame
            .get("confirmed")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
    }
    Some(transport)
}
async fn dispatch_tinyos_command(
    shared: &SharedGateway,
    transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    match transport
        .get("commandKind")
        .and_then(serde_json::Value::as_str)
    {
        Some("operation.retry") => {
            dispatch_tinyos_retry_command(
                shared,
                transport,
                workspace_root,
                config_snapshot,
                live_trace_sink,
                timeout,
            )
            .await
        }
        Some("agent.request_change") => {
            dispatch_tinyos_agent_request_change_command(
                shared,
                transport,
                workspace_root,
                config_snapshot,
                live_trace_sink,
                timeout,
            )
            .await
        }
        Some("agent.pause" | "agent.resume") => {
            dispatch_tinyos_agent_run_control_command(
                shared,
                transport,
                workspace_root,
                config_snapshot,
            )
            .await
        }
        Some("file.save" | "file.move" | "file.delete") => {
            dispatch_tinyos_file_command(
                shared,
                transport,
                workspace_root,
                config_snapshot,
                live_trace_sink,
            )
            .await
        }
        Some("terminal.execute" | "terminal.cancel") => {
            dispatch_tinyos_terminal_command(
                shared,
                transport,
                workspace_root,
                config_snapshot,
                live_trace_sink,
            )
            .await
        }
        Some("browser.interact") => Err(
            "browser.interact is unavailable because no real browser capture backend is configured"
                .to_string(),
        ),
        command_kind => Err(format!(
            "unsupported TinyOS command kind: {}",
            command_kind.unwrap_or("missing")
        )),
    }
}

async fn dispatch_tinyos_agent_run_control_command(
    shared: &SharedGateway,
    mut transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let run_id = required_transport_string(&transport, "runId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    let task_runtime = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.task_runtime()
    };
    let task_status = task_runtime
        .status(&run_id)
        .ok_or_else(|| format!("{command_kind} target run `{run_id}` was not found"))?;
    if task_status.session_id != session_id {
        return Err(format!(
            "{command_kind} target run `{run_id}` belongs to session `{}`",
            task_status.session_id
        ));
    }
    match command_kind.as_str() {
        "agent.pause" if !task_status.active || task_status.phase == "paused" => {
            return Err(format!("agent.pause target run `{run_id}` is not running"));
        }
        "agent.resume" if !task_status.active || task_status.phase != "paused" => {
            return Err(format!("agent.resume target run `{run_id}` is not paused"));
        }
        "agent.pause" | "agent.resume" => {}
        _ => return Err(format!("unsupported TinyOS command kind: {command_kind}")),
    }
    persist_tinyos_command_acknowledgement(
        workspace_root,
        config_snapshot,
        &session_id,
        &run_id,
        &command_id,
        &transport,
    )?;
    let outcome = if command_kind == "agent.pause" {
        task_runtime.request_pause(&run_id, &command_id)
    } else {
        task_runtime.request_resume(&run_id, &command_id)
    }
    .map_err(|error| format!("{command_kind} failed: {error}"))?;
    transport["frames"] = serde_json::json!([
        {
            "event": "command_accepted",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": &command_id,
            "run_id": &run_id,
        },
        {
            "event": "command_canonical_updated",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": &command_id,
            "run_id": &run_id,
        }
    ]);
    Ok(serde_json::json!({ "transport": transport, "control": outcome }))
}

async fn dispatch_tinyos_file_command(
    _shared: &SharedGateway,
    mut transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let run_id = required_transport_string(&transport, "runId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    if !run_id.starts_with("tinyos-host-file-") {
        return Err(format!(
            "{command_kind} requires a dedicated TinyOS file operation run"
        ));
    }
    if transport
        .get("confirmed")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(format!(
            "{command_kind} requires explicit user confirmation"
        ));
    }
    ensure_no_active_host_or_agent_run(
        &session_id,
        &run_id,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    if !workspace_root.is_dir() {
        return Err("TinyOS file operation workspace root is unavailable".to_string());
    }
    let path = required_transport_string(&transport, "path")?;
    if path.len() > 1_024 {
        return Err(format!("{command_kind} path exceeds 1024 characters"));
    }
    let base_revision = transport
        .get("baseRevision")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let target_path = transport
        .get("targetPath")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let content = transport
        .get("content")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    if content
        .as_ref()
        .is_some_and(|value| value.len() > 2 * 1024 * 1024)
    {
        return Err("file.save content exceeds the 2 MiB TinyOS host-operation limit".to_string());
    }
    let create_only = transport
        .get("createOnly")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    match command_kind.as_str() {
        "file.save" if content.is_none() => return Err("file.save content is required".to_string()),
        "file.save" if !create_only && base_revision.is_none() => {
            return Err("file.save requires a base revision for an existing file".to_string())
        }
        "file.move" if base_revision.is_none() || target_path.is_none() => {
            return Err("file.move requires baseRevision and targetPath".to_string())
        }
        "file.delete" if base_revision.is_none() => {
            return Err("file.delete requires baseRevision".to_string())
        }
        "file.save" | "file.move" | "file.delete" => {}
        _ => return Err(format!("unsupported TinyOS file command: {command_kind}")),
    }
    start_tinyos_host_operation(
        &session_id,
        &run_id,
        &command_id,
        &command_kind,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    if let Err(error) = persist_tinyos_command_acknowledgement(
        workspace_root.clone(),
        config_snapshot.clone(),
        &session_id,
        &run_id,
        &command_id,
        &transport,
    ) {
        let _ = mark_tinyos_host_run(
            workspace_root,
            config_snapshot,
            &session_id,
            &run_id,
            "failed",
            Some(format!("Command acknowledgement failed: {error}")),
        );
        return Err(error);
    }
    let args = serde_json::json!({
        "path": path,
        "targetPath": target_path,
        "baseRevision": base_revision,
        "createOnly": create_only,
    });
    if let Err(error) = append_tinyos_host_event(
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink.clone(),
        &session_id,
        &run_id,
        serde_json::json!({
            "eventId": format!("{run_id}:host-start:{command_id}"),
            "itemId": command_id,
            "eventName": "agent.tool.start",
            "payload": {
                "args": args,
                "approvalDecision": "user_confirmed",
                "capabilityDecision": "available",
                "commandId": command_id,
                "summary": host_file_operation_summary(&command_kind, &path, target_path.as_deref()),
                "toolCallId": command_id,
                "toolName": host_file_tool_name(&command_kind),
            }
        }),
    ) {
        let _ = mark_tinyos_host_run(
            workspace_root,
            config_snapshot,
            &session_id,
            &run_id,
            "failed",
            Some(format!("File operation audit start failed: {error}")),
        );
        return Err(error);
    }
    let workspace =
        WorkerWorkspaceRpc::new(workspace_root.clone(), default_desktop_capability_policy());
    let operation = match command_kind.as_str() {
        "file.save" => workspace
            .write_file_with_base_revision(
                &path,
                content.as_deref().expect("validated file.save content"),
                base_revision.as_deref(),
                create_only,
            )
            .map(|value| serde_json::to_value(value).expect("workspace write result serializes")),
        "file.move" => workspace
            .move_file_with_base_revision(
                &path,
                target_path.as_deref().expect("validated file.move target"),
                base_revision
                    .as_deref()
                    .expect("validated file.move revision"),
            )
            .map(|value| serde_json::to_value(value).expect("workspace move result serializes")),
        "file.delete" => workspace
            .delete_file_with_base_revision(
                &path,
                base_revision
                    .as_deref()
                    .expect("validated file.delete revision"),
            )
            .map(|value| serde_json::to_value(value).expect("workspace delete result serializes")),
        _ => unreachable!("validated TinyOS file command"),
    };
    let result = match operation {
        Ok(result) => result,
        Err(error) => {
            let message = worker_protocol_error_message(&error);
            fail_tinyos_host_operation(
                workspace_root,
                config_snapshot,
                live_trace_sink,
                &session_id,
                &run_id,
                &command_id,
                &message,
            )?;
            return Err(format!("{command_kind} failed: {message}"));
        }
    };
    append_tinyos_host_event(
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink,
        &session_id,
        &run_id,
        serde_json::json!({
            "eventId": format!("{run_id}:host-result:{command_id}"),
            "itemId": command_id,
            "eventName": "agent.tool.result",
            "payload": {
                "commandId": command_id,
                "envelope": { "status": "completed", "summary": host_file_operation_summary(&command_kind, &path, target_path.as_deref()) },
                "result": result,
                "summary": host_file_operation_summary(&command_kind, &path, target_path.as_deref()),
                "toolCallId": command_id,
                "toolName": host_file_tool_name(&command_kind),
            }
        }),
    )?;
    mark_tinyos_host_run(
        workspace_root,
        config_snapshot,
        &session_id,
        &run_id,
        "completed",
        Some(host_file_operation_summary(
            &command_kind,
            &path,
            target_path.as_deref(),
        )),
    )?;
    set_tinyos_command_frames(&mut transport, &command_id, &run_id);
    Ok(serde_json::json!({ "transport": transport, "operation": result }))
}

async fn dispatch_tinyos_terminal_command(
    shared: &SharedGateway,
    mut transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let run_id = required_transport_string(&transport, "runId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    if !run_id.starts_with("tinyos-host-terminal-") {
        return Err(format!(
            "{command_kind} requires a TinyOS terminal operation run"
        ));
    }
    let shell_runtime = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.shell_runtime()
    };
    let shell = WorkerShellRpc::with_runtime(
        workspace_root.clone(),
        default_desktop_capability_policy(),
        shell_runtime,
    );
    if command_kind == "terminal.cancel" {
        let processes = shell
            .list(ShellProcessListParams {
                run_id: Some(run_id.clone()),
            })
            .map_err(|error| {
                format!(
                    "terminal.cancel failed to inspect processes: {}",
                    worker_protocol_error_message(&error)
                )
            })?;
        let active = processes
            .into_iter()
            .find(|process| process.running)
            .ok_or_else(|| format!("terminal.cancel found no running process for `{run_id}`"))?;
        persist_tinyos_command_acknowledgement(
            workspace_root.clone(),
            config_snapshot.clone(),
            &session_id,
            &run_id,
            &command_id,
            &transport,
        )?;
        let outcome = shell
            .interrupt(ShellProcessIdParams {
                process_id: active.process_id,
                run_id: Some(run_id.clone()),
            })
            .map_err(|error| {
                format!(
                    "terminal.cancel failed: {}",
                    worker_protocol_error_message(&error)
                )
            })?;
        append_tinyos_host_event(
            workspace_root.clone(),
            config_snapshot.clone(),
            live_trace_sink,
            &session_id,
            &run_id,
            serde_json::json!({
                "eventId": format!("{run_id}:host-cancel:{command_id}"),
                "itemId": command_id,
                "eventName": "agent.cancelled",
                "payload": {
                    "commandId": command_id,
                    "message": "Terminal process cancelled",
                    "processId": outcome.process_id,
                    "reason": "user_requested",
                }
            }),
        )?;
        mark_tinyos_host_run(
            workspace_root,
            config_snapshot,
            &session_id,
            &run_id,
            "cancelled",
            None,
        )?;
        set_tinyos_command_frames(&mut transport, &command_id, &run_id);
        return Ok(serde_json::json!({ "transport": transport, "operation": outcome }));
    }
    if command_kind != "terminal.execute" {
        return Err(format!(
            "unsupported TinyOS terminal command: {command_kind}"
        ));
    }
    if transport
        .get("confirmed")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err("terminal.execute requires explicit user confirmation".to_string());
    }
    ensure_no_active_host_or_agent_run(
        &session_id,
        &run_id,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let command = required_transport_string(&transport, "command")?;
    if command.len() > 4_096 {
        return Err("terminal.execute command exceeds 4096 characters".to_string());
    }
    let cwd = transport
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".")
        .to_string();
    if cwd.len() > 1_024 {
        return Err("terminal.execute cwd exceeds 1024 characters".to_string());
    }
    start_tinyos_host_operation(
        &session_id,
        &run_id,
        &command_id,
        &command_kind,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    if let Err(error) = persist_tinyos_command_acknowledgement(
        workspace_root.clone(),
        config_snapshot.clone(),
        &session_id,
        &run_id,
        &command_id,
        &transport,
    ) {
        let _ = mark_tinyos_host_run(
            workspace_root,
            config_snapshot,
            &session_id,
            &run_id,
            "failed",
            Some(format!("Command acknowledgement failed: {error}")),
        );
        return Err(error);
    }
    let initial = match shell.start_with_approval_decision(
        ShellStartParams {
            command: command.clone(),
            working_dir: Some(cwd.clone()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(50),
            rows: None,
            cols: None,
            sandbox_mode: Some(ShellSandboxMode::ReadOnly),
            network_mode: Some(PermissionNetworkMode::Denied),
            run_id: Some(run_id.clone()),
            tool_call_id: Some(command_id.clone()),
            cancellation: None,
        },
        "user_confirmed",
    ) {
        Ok(output) => output,
        Err(error) => {
            let message = worker_protocol_error_message(&error);
            fail_tinyos_host_operation(
                workspace_root,
                config_snapshot,
                live_trace_sink,
                &session_id,
                &run_id,
                &command_id,
                &message,
            )?;
            return Err(format!("terminal.execute failed: {message}"));
        }
    };
    if let Some(message) = tinyos_terminal_process_failure(&initial) {
        fail_tinyos_host_operation(
            workspace_root,
            config_snapshot,
            live_trace_sink,
            &session_id,
            &run_id,
            &command_id,
            &message,
        )?;
        return Err(format!("terminal.execute failed: {message}"));
    }
    if let Err(error) = append_tinyos_terminal_event(
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink.clone(),
        &session_id,
        &run_id,
        &command_id,
        &command,
        &cwd,
        &initial,
        !initial.running,
    ) {
        if initial.running {
            let _ = shell.interrupt(ShellProcessIdParams {
                process_id: initial.process_id.clone(),
                run_id: Some(run_id.clone()),
            });
        }
        let _ = mark_tinyos_host_run(
            workspace_root,
            config_snapshot,
            &session_id,
            &run_id,
            "failed",
            Some(format!("Terminal audit start failed: {error}")),
        );
        return Err(error);
    }
    let initial_response = serde_json::json!({
        "processId": initial.process_id.clone(),
        "runId": run_id.clone(),
        "status": initial.status.clone(),
    });
    let background_shell = shell.clone();
    let background_workspace_root = workspace_root.clone();
    let background_config = config_snapshot.clone();
    let background_session_id = session_id.clone();
    let background_run_id = run_id.clone();
    let background_command_id = command_id.clone();
    let background_command = command.clone();
    let background_cwd = cwd.clone();
    let background_live_sink = live_trace_sink.clone();
    tauri::async_runtime::spawn(async move {
        let mut output = initial;
        loop {
            if !output.running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            match background_shell.poll(ShellProcessPollParams {
                process_id: output.process_id.clone(),
                run_id: Some(background_run_id.clone()),
                cursor: Some(output.cursor),
                yield_time_ms: Some(50),
            }) {
                Ok(next) => {
                    let changed = next.cursor != output.cursor || next.running != output.running;
                    output = next;
                    if output.status == "cancelled" {
                        break;
                    }
                    if let Some(message) = tinyos_terminal_process_failure(&output) {
                        if let Err(error) = fail_tinyos_host_operation(
                            background_workspace_root.clone(),
                            background_config.clone(),
                            background_live_sink.clone(),
                            &background_session_id,
                            &background_run_id,
                            &background_command_id,
                            &message,
                        ) {
                            eprintln!(
                                "TinyOS terminal failed to persist process failure for {}: {}",
                                background_run_id, error
                            );
                        }
                        return;
                    }
                    if changed {
                        let snapshot = match background_shell.poll(ShellProcessPollParams {
                            process_id: output.process_id.clone(),
                            run_id: Some(background_run_id.clone()),
                            cursor: Some(0),
                            yield_time_ms: Some(0),
                        }) {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                let message = worker_protocol_error_message(&error);
                                if let Err(persist_error) = fail_tinyos_host_operation(
                                    background_workspace_root.clone(),
                                    background_config.clone(),
                                    background_live_sink.clone(),
                                    &background_session_id,
                                    &background_run_id,
                                    &background_command_id,
                                    &message,
                                ) {
                                    eprintln!(
                                        "TinyOS terminal failed to persist snapshot error for {}: {}",
                                        background_run_id, persist_error
                                    );
                                }
                                return;
                            }
                        };
                        if let Err(error) = append_tinyos_terminal_event(
                            background_workspace_root.clone(),
                            background_config.clone(),
                            background_live_sink.clone(),
                            &background_session_id,
                            &background_run_id,
                            &background_command_id,
                            &background_command,
                            &background_cwd,
                            &snapshot,
                            !output.running,
                        ) {
                            eprintln!(
                                "TinyOS terminal failed to persist output for {}: {}",
                                background_run_id, error
                            );
                            let _ = fail_tinyos_host_operation(
                                background_workspace_root.clone(),
                                background_config.clone(),
                                background_live_sink.clone(),
                                &background_session_id,
                                &background_run_id,
                                &background_command_id,
                                &error,
                            );
                            return;
                        }
                    }
                }
                Err(error) => {
                    if let Err(persist_error) = fail_tinyos_host_operation(
                        background_workspace_root.clone(),
                        background_config.clone(),
                        background_live_sink.clone(),
                        &background_session_id,
                        &background_run_id,
                        &background_command_id,
                        &worker_protocol_error_message(&error),
                    ) {
                        eprintln!(
                            "TinyOS terminal failed to persist polling error for {}: {}",
                            background_run_id, persist_error
                        );
                    }
                    return;
                }
            }
        }
        if output.status == "cancelled" {
            if let Err(error) = mark_tinyos_host_run(
                background_workspace_root,
                background_config,
                &background_session_id,
                &background_run_id,
                "cancelled",
                None,
            ) {
                eprintln!(
                    "TinyOS terminal failed to persist cancellation for {}: {}",
                    background_run_id, error
                );
            }
        } else {
            if let Err(error) = mark_tinyos_host_run(
                background_workspace_root,
                background_config,
                &background_session_id,
                &background_run_id,
                "completed",
                Some(format!(
                    "Terminal exited with code {}",
                    output.exit_code.unwrap_or(-1)
                )),
            ) {
                eprintln!(
                    "TinyOS terminal failed to persist completion for {}: {}",
                    background_run_id, error
                );
            }
        }
    });
    set_tinyos_command_frames(&mut transport, &command_id, &run_id);
    Ok(serde_json::json!({
        "transport": transport,
        "operation": initial_response,
    }))
}

async fn dispatch_tinyos_retry_command(
    shared: &SharedGateway,
    transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let retry_run_id = required_transport_string(&transport, "runId")?;
    let source_turn_id = required_transport_string(&transport, "sourceTurnId")?;
    let item_id = required_transport_string(&transport, "itemId")?;
    if retry_run_id == source_turn_id {
        return Err("operation.retry requires a new target runId".to_string());
    }

    let source_item = validate_tinyos_retry_source(
        &session_id,
        &source_turn_id,
        &item_id,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let description = tinyos_retry_source_description(&source_item);
    let content = format!(
        "Retry the failed canonical operation `{description}` (source item `{item_id}` from run `{source_turn_id}`). Preserve completed work, verify the failure context, and continue the task from that operation."
    );
    let command_metadata = serde_json::json!({
        "commandId": required_transport_string(&transport, "commandId")?,
        "commandKind": "operation.retry",
        "operation": {
            "itemId": &item_id,
            "turnId": &source_turn_id,
        },
        "source": transport.get("source").cloned().unwrap_or(serde_json::Value::Null),
        "target": {
            "runId": &retry_run_id,
            "sessionId": &session_id,
            "threadId": transport.get("threadId").cloned().unwrap_or(serde_json::Value::Null),
        },
    });
    dispatch_tinyos_new_run_command(
        shared,
        transport,
        content,
        command_metadata,
        None,
        workspace_root,
        config_snapshot,
        live_trace_sink,
        timeout,
    )
    .await
}

async fn dispatch_tinyos_agent_request_change_command(
    shared: &SharedGateway,
    transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let request_run_id = required_transport_string(&transport, "runId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let instruction = required_transport_string(&transport, "instruction")?;
    if instruction.chars().count() > 4_096 {
        return Err("agent.request_change instruction exceeds 4096 characters".to_string());
    }
    let references = transport
        .get("references")
        .and_then(serde_json::Value::as_array)
        .filter(|references| !references.is_empty())
        .ok_or_else(|| "agent.request_change requires references".to_string())?;
    if references.len() > 16 {
        return Err("agent.request_change supports at most 16 references".to_string());
    }
    if serde_json::to_vec(references)
        .map_err(|error| format!("agent.request_change references are invalid: {error}"))?
        .len()
        > 65_536
    {
        return Err("agent.request_change references exceed 64 KiB".to_string());
    }
    for reference in references {
        validate_tinyos_agent_request_reference(reference)?;
    }
    validate_tinyos_followup_run_state(
        &session_id,
        transport
            .get("observedRunId")
            .and_then(serde_json::Value::as_str),
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let command_metadata = serde_json::json!({
        "commandId": command_id,
        "commandKind": "agent.request_change",
        "request": {
            "observedRunId": transport.get("observedRunId").cloned().unwrap_or(serde_json::Value::Null),
            "referenceCount": references.len(),
        },
        "source": transport.get("source").cloned().unwrap_or(serde_json::Value::Null),
        "target": {
            "runId": request_run_id,
            "sessionId": session_id,
            "threadId": transport.get("threadId").cloned().unwrap_or(serde_json::Value::Null),
        },
    });
    dispatch_tinyos_new_run_command(
        shared,
        transport.clone(),
        instruction,
        command_metadata,
        Some(serde_json::Value::Array(references.clone())),
        workspace_root,
        config_snapshot,
        live_trace_sink,
        timeout,
    )
    .await
}

fn validate_tinyos_agent_request_reference(reference: &serde_json::Value) -> Result<(), String> {
    let reference_type = reference.get("type").and_then(serde_json::Value::as_str);
    let source_text_is_string = reference
        .get("sourceText")
        .is_some_and(serde_json::Value::is_string);
    let canonical_identity_is_present = || {
        reference
            .get("evidenceId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
            && reference
                .get("scope")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
    };
    let valid_line_range = || {
        let source_line = reference
            .get("sourceLine")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| *value > 0);
        reference
            .get("sourceEndLine")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|end| source_line.is_some_and(|start| end >= start))
    };
    match reference_type {
        Some("tinyos.file")
            if reference
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
                && valid_line_range()
                && source_text_is_string =>
        {
            Ok(())
        }
        Some("tinyos.terminal")
            if canonical_identity_is_present() && valid_line_range() && source_text_is_string =>
        {
            Ok(())
        }
        Some("tinyos.plan") if canonical_identity_is_present() && source_text_is_string => Ok(()),
        Some(reference_type) => Err(format!(
            "agent.request_change received an invalid {reference_type} reference"
        )),
        None => Err("agent.request_change reference type is required".to_string()),
    }
}

async fn dispatch_tinyos_new_run_command(
    shared: &SharedGateway,
    mut transport: serde_json::Value,
    content: String,
    command_metadata: serde_json::Value,
    references: Option<serde_json::Value>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let run_id = required_transport_string(&transport, "runId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    let mut metadata = serde_json::json!({ "_tinyosCommand": command_metadata });
    if let Some(references) = references {
        metadata["references"] = references;
    }
    let run_transport = serde_json::json!({
        "inbound": {
            "channel": "websocket",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "content": content,
            "metadata": metadata,
            "session_key": &session_id,
        }
    });
    let run_request = build_worker_transport_websocket_run_input_request(
        next_worker_request_correlation(),
        &run_transport,
        WorkerTransportWebSocketDispatchOptions {
            run_id: Some(run_id.clone()),
            stream: Some(true),
            ..WorkerTransportWebSocketDispatchOptions::default()
        },
    )
    .ok_or_else(|| format!("{command_kind} failed to build Agent run input"))?;
    let run_spec = run_request
        .params
        .get("input")
        .cloned()
        .ok_or_else(|| format!("{command_kind} Agent run input is missing"))?;
    let agent_result = worker_run_agent_with_live_trace_sink_async(
        shared,
        run_spec,
        workspace_root,
        config_snapshot,
        timeout,
        live_trace_sink,
    )
    .await?;

    transport["frames"] = serde_json::json!([
        {
            "event": "command_accepted",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": &command_id,
            "run_id": &run_id,
        },
        {
            "event": "command_canonical_updated",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": &command_id,
            "run_id": &run_id,
        }
    ]);
    Ok(serde_json::json!({ "transport": transport, "agent": agent_result }))
}

fn validate_tinyos_followup_run_state(
    session_id: &str,
    observed_run_id: Option<&str>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    let runs = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-followup-run-list"),
            request_id.trace_id("tinyos-followup-run-list"),
            "agent_run.list",
            serde_json::json!({ "session_id": session_id }),
        ),
        "TinyOS follow-up run lookup",
    )?;
    let runs = runs
        .get("runs")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let latest = runs.first();
    let latest_run_id = latest
        .and_then(|run| run.get("runId"))
        .and_then(serde_json::Value::as_str);
    if latest_run_id != observed_run_id {
        return Err(format!(
            "agent.request_change observed stale run `{}`; latest run is `{}`",
            observed_run_id.unwrap_or("none"),
            latest_run_id.unwrap_or("none")
        ));
    }
    if runs.iter().any(|run| {
        run.get("status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|status| matches!(status, "running" | "waiting"))
    }) {
        return Err("agent.request_change is unavailable while an Agent run is active".to_string());
    }
    Ok(())
}

fn validate_tinyos_retry_source(
    session_id: &str,
    source_turn_id: &str,
    item_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let runs = call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("tinyos-retry-run-list"),
            request_id.trace_id("tinyos-retry-run-list"),
            "agent_run.list",
            serde_json::json!({ "session_id": session_id }),
        ),
        "TinyOS retry run lookup",
    )?;
    let latest_run = runs
        .get("runs")
        .and_then(serde_json::Value::as_array)
        .and_then(|runs| runs.first())
        .ok_or_else(|| "operation.retry source run was not found".to_string())?;
    let latest_run_id = latest_run
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if latest_run_id != source_turn_id {
        return Err(format!(
            "operation.retry targets stale run `{source_turn_id}`; latest run is `{latest_run_id}`"
        ));
    }
    if latest_run.get("status").and_then(serde_json::Value::as_str) != Some("failed") {
        return Err(format!(
            "operation.retry source run `{source_turn_id}` is not failed"
        ));
    }

    let request_id = next_worker_request_correlation();
    let runtime_state = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-retry-runtime-state"),
            request_id.trace_id("tinyos-retry-runtime-state"),
            "agent_run.runtime_state",
            serde_json::json!({
                "session_id": session_id,
                "run_id": source_turn_id,
            }),
        ),
        "TinyOS retry source item lookup",
    )?;
    runtime_state
        .get("timeline")
        .and_then(|timeline| timeline.get("items"))
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("itemId").and_then(serde_json::Value::as_str) == Some(item_id)
                    && item.get("status").and_then(serde_json::Value::as_str) == Some("failed")
            })
        })
        .cloned()
        .ok_or_else(|| format!("operation.retry source item `{item_id}` is not failed"))
}

fn tinyos_retry_source_description(item: &serde_json::Value) -> String {
    let data = item.get("data").unwrap_or(&serde_json::Value::Null);
    let value = ["title", "summary", "message"]
        .iter()
        .find_map(|key| data.get(key).and_then(serde_json::Value::as_str))
        .or_else(|| item.get("kind").and_then(serde_json::Value::as_str))
        .unwrap_or("failed operation")
        .trim();
    value.chars().take(500).collect()
}

fn required_transport_string(value: &serde_json::Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("TinyOS command is missing {key}"))
}

fn ensure_no_active_host_or_agent_run(
    session_id: &str,
    target_run_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    let runs = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-host-active-runs"),
            request_id.trace_id("tinyos-host-active-runs"),
            "agent_run.list",
            serde_json::json!({ "session_id": session_id }),
        ),
        "TinyOS host operation active-run validation",
    )?;
    let active = runs
        .get("runs")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|run| {
            run.get("runId").and_then(serde_json::Value::as_str) != Some(target_run_id)
                && matches!(
                    run.get("status").and_then(serde_json::Value::as_str),
                    Some("running" | "waiting")
                )
        });
    if let Some(active) = active {
        return Err(format!(
            "TinyOS host operation is unavailable while run `{}` is active",
            active
                .get("runId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    Ok(())
}

fn worker_protocol_error_message(error: &crate::worker_protocol::WorkerProtocolError) -> String {
    if error.details.is_null()
        || error
            .details
            .as_object()
            .is_some_and(serde_json::Map::is_empty)
    {
        error.message.clone()
    } else {
        format!("{}: {}", error.message, error.details)
    }
}

fn start_tinyos_host_operation(
    session_id: &str,
    run_id: &str,
    command_id: &str,
    command_kind: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    persist_native_agent_run_start(
        serde_json::json!({
            "sessionId": session_id,
            "runId": run_id,
            "instructionProvenance": {
                "kind": "tinyos_host_command",
                "commandId": command_id,
                "commandKind": command_kind,
            },
        }),
        workspace_root,
        config_snapshot,
    )
}

fn append_tinyos_host_event(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    session_id: &str,
    run_id: &str,
    event: serde_json::Value,
) -> Result<(), String> {
    let event_id = event
        .get("eventId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "TinyOS host event is missing eventId".to_string())?
        .to_string();
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("tinyos-host-event"),
            request_id.trace_id("tinyos-host-event"),
            "agent_run.append_trace",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "event": event,
            }),
        ),
        "TinyOS host event append",
    )?;
    if let Some(live_trace_sink) = live_trace_sink {
        let request_id = next_worker_request_correlation();
        let runtime_state = call_rust_state_service(
            workspace_root,
            config_snapshot,
            WorkerRequest::new(
                request_id.id("tinyos-host-event-state"),
                request_id.trace_id("tinyos-host-event-state"),
                "agent_run.runtime_state",
                serde_json::json!({
                    "session_id": session_id,
                    "run_id": run_id,
                }),
            ),
            "TinyOS host event runtime state",
        )?;
        let event = runtime_state
            .get("runtimeEvents")
            .and_then(serde_json::Value::as_array)
            .and_then(|events| {
                events.iter().find(|event| {
                    event.get("eventId").and_then(serde_json::Value::as_str)
                        == Some(event_id.as_str())
                })
            })
            .cloned()
            .ok_or_else(|| format!("TinyOS host event `{event_id}` was not persisted"))?;
        let event: AgentRuntimeEventEnvelope = serde_json::from_value(event)
            .map_err(|error| format!("TinyOS host event projection failed: {error}"))?;
        live_trace_sink.append_trace_event(session_id, run_id, &event)?;
    }
    Ok(())
}

fn mark_tinyos_host_run(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    session_id: &str,
    run_id: &str,
    status: &str,
    detail: Option<String>,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    let (method, params) = match status {
        "completed" => (
            "agent_run.mark_completed",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "stop_reason": "host_operation_completed",
                "final_content": detail,
            }),
        ),
        "failed" => (
            "agent_run.mark_failed",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "stop_reason": "host_operation_failed",
                "error": detail,
            }),
        ),
        "cancelled" => (
            "agent_run.mark_cancelled",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
            }),
        ),
        _ => return Err(format!("unsupported TinyOS host run status: {status}")),
    };
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-host-run-terminal"),
            request_id.trace_id("tinyos-host-run-terminal"),
            method,
            params,
        ),
        "TinyOS host run terminal update",
    )?;
    Ok(())
}

fn fail_tinyos_host_operation(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    session_id: &str,
    run_id: &str,
    command_id: &str,
    message: &str,
) -> Result<(), String> {
    append_tinyos_host_event(
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink,
        session_id,
        run_id,
        serde_json::json!({
            "eventId": format!("{run_id}:host-error:{command_id}"),
            "itemId": command_id,
            "eventName": "agent.error",
            "payload": {
                "commandId": command_id,
                "message": message,
            }
        }),
    )?;
    mark_tinyos_host_run(
        workspace_root,
        config_snapshot,
        session_id,
        run_id,
        "failed",
        Some(message.to_string()),
    )
}

fn append_tinyos_terminal_event(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    session_id: &str,
    run_id: &str,
    command_id: &str,
    command: &str,
    cwd: &str,
    output: &ShellProcessOutput,
    terminal: bool,
) -> Result<(), String> {
    let stdout = sanitize_tinyos_host_text(&output.stdout, &config_snapshot);
    let stderr = sanitize_tinyos_host_text(&output.stderr, &config_snapshot);
    append_tinyos_host_event(
        workspace_root,
        config_snapshot,
        live_trace_sink,
        session_id,
        run_id,
        serde_json::json!({
            "eventId": format!("{run_id}:terminal:{}:{}", if terminal { "result" } else { "stream" }, output.cursor),
            "itemId": command_id,
            "eventName": if terminal { "agent.tool.result" } else { "agent.tool.start" },
            "payload": {
                "args": {
                    "command": command,
                    "cwd": cwd,
                    "networkMode": "denied",
                    "sandboxMode": "read_only",
                },
                "approvalDecision": "user_confirmed",
                "capabilityDecision": "available",
                "commandId": command_id,
                "envelope": {
                    "status": if terminal { "completed" } else { "running" },
                    "summary": if terminal { "Terminal command finished" } else { "Terminal command running" },
                },
                "result": {
                    "cancelled": output.status == "cancelled",
                    "droppedBytes": output.dropped_bytes,
                    "exitCode": output.exit_code,
                    "processId": output.process_id,
                    "stderr": stderr,
                    "stdout": stdout,
                    "truncated": output.truncated,
                },
                "stderr": stderr,
                "stdout": stdout,
                "summary": if terminal { "Terminal command finished" } else { "Terminal command running" },
                "toolCallId": command_id,
                "toolName": "shell.execute",
            }
        }),
    )
}

fn tinyos_terminal_process_failure(output: &ShellProcessOutput) -> Option<String> {
    output.failure.clone().or_else(|| {
        matches!(
            output.status.as_str(),
            "failed" | "terminated" | "timed_out"
        )
        .then(|| {
            format!(
                "Terminal process ended with status `{}` before normal completion",
                output.status
            )
        })
    })
}

pub(crate) fn sanitize_tinyos_host_text(text: &str, config_snapshot: &serde_json::Value) -> String {
    let mut secrets = Vec::new();
    collect_tinyos_secret_values(config_snapshot, None, &mut secrets);
    let mut sanitized = text
        .chars()
        .rev()
        .take(10_000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    for secret in secrets {
        if secret.len() >= 4 {
            sanitized = sanitized.replace(&secret, "[REDACTED]");
        }
    }
    for marker in [
        "api_key=",
        "apikey=",
        "authorization:",
        "password=",
        "secret=",
        "token=",
    ] {
        sanitized = redact_assignment(&sanitized, marker);
    }
    sanitized
}

fn collect_tinyos_secret_values(
    value: &serde_json::Value,
    key: Option<&str>,
    secrets: &mut Vec<String>,
) {
    match value {
        serde_json::Value::Object(object) => {
            for (child_key, child_value) in object {
                collect_tinyos_secret_values(child_value, Some(child_key), secrets);
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                collect_tinyos_secret_values(child, key, secrets);
            }
        }
        serde_json::Value::String(secret)
            if key.is_some_and(|key| {
                let key = key.to_ascii_lowercase();
                ["api_key", "apikey", "password", "secret", "token"]
                    .iter()
                    .any(|candidate| key.contains(candidate))
            }) =>
        {
            secrets.push(secret.clone());
        }
        _ => {}
    }
}

fn redact_assignment(text: &str, marker: &str) -> String {
    let mut output = text.to_string();
    let mut search_from = 0;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(offset) = lower[search_from..].find(marker) else {
            break;
        };
        let value_start = search_from + offset + marker.len();
        let value_end = output[value_start..]
            .find(char::is_whitespace)
            .map(|length| value_start + length)
            .unwrap_or(output.len());
        output.replace_range(value_start..value_end, "[REDACTED]");
        search_from = value_start + "[REDACTED]".len();
        if search_from >= lower.len() {
            break;
        }
    }
    output
}

fn host_file_tool_name(command_kind: &str) -> &'static str {
    match command_kind {
        "file.save" => "workspace.write_file",
        "file.move" => "workspace.move_file",
        "file.delete" => "workspace.delete_file",
        _ => "workspace.host_operation",
    }
}

fn host_file_operation_summary(command_kind: &str, path: &str, target: Option<&str>) -> String {
    match command_kind {
        "file.save" => format!("Saved {path}"),
        "file.move" => format!("Moved {path} to {}", target.unwrap_or("unknown target")),
        "file.delete" => format!("Deleted {path}"),
        _ => format!("Updated {path}"),
    }
}

fn set_tinyos_command_frames(transport: &mut serde_json::Value, command_id: &str, run_id: &str) {
    transport["frames"] = serde_json::json!([
        {
            "event": "command_accepted",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": command_id,
            "run_id": run_id,
        },
        {
            "event": "command_canonical_updated",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": command_id,
            "run_id": run_id,
        }
    ]);
}

fn persist_tinyos_command_acknowledgement(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    session_id: &str,
    run_id: &str,
    command_id: &str,
    transport: &serde_json::Value,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-command-acknowledge"),
            request_id.trace_id("tinyos-command-acknowledge"),
            "agent_run.append_trace",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "event": {
                    "eventId": format!("{run_id}:command-ack:{command_id}"),
                    "itemId": format!("{run_id}:command-ack:{command_id}"),
                    "eventName": "agent.command.acknowledged",
                    "payload": {
                        "commandId": command_id,
                        "commandKind": transport.get("commandKind").cloned().unwrap_or(serde_json::Value::Null),
                        "commandStatus": "acknowledged",
                        "message": "Agent command acknowledged",
                        "source": transport.get("source").cloned().unwrap_or(serde_json::Value::Null),
                        "target": {
                            "sessionId": session_id,
                            "runId": run_id,
                            "turnId": transport.get("turnId").cloned().unwrap_or(serde_json::Value::Null),
                            "threadId": transport.get("threadId").cloned().unwrap_or(serde_json::Value::Null),
                        }
                    }
                }
            }),
        ),
        "TinyOS command acknowledgement append",
    )?;
    Ok(())
}

pub(crate) fn build_worker_transport_websocket_run_input_request(
    request_id: WorkerRequestCorrelation,
    transport_result: &serde_json::Value,
    options: WorkerTransportWebSocketDispatchOptions,
) -> Option<WorkerRequest> {
    let inbound = transport_result.get("inbound")?.as_object()?;
    let session_id = json_string_field(inbound, "session_key")?;
    let content = json_string_field(inbound, "content")?;
    let channel = json_string_field(inbound, "channel").unwrap_or("websocket");
    let chat_id = json_string_field(inbound, "chat_id").unwrap_or("");
    let mut metadata = inbound
        .get("metadata")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    metadata.insert("_wants_stream".to_string(), serde_json::Value::Bool(true));

    let run_id = options.run_id.unwrap_or_else(|| {
        format!(
            "websocket-{}-{}",
            sanitize_worker_run_id_part(if chat_id.is_empty() {
                session_id
            } else {
                chat_id
            }),
            request_id.suffix()
        )
    });
    let client_event_id = json_string_field(&metadata, "clientEventId")
        .or_else(|| json_string_field(&metadata, "client_event_id"))
        .map(str::to_string);
    let references = metadata
        .get("references")
        .filter(|value| value.is_array())
        .cloned();
    let mut input = serde_json::json!({
        "runId": run_id,
        "sessionId": session_id,
        "input": {
            "role": "user",
            "content": content,
        },
        "channel": channel,
        "chatId": chat_id,
        "stream": options.stream.unwrap_or(true),
        "metadata": serde_json::Value::Object(metadata),
    });
    if let Some(client_event_id) = client_event_id {
        input["input"]["clientEventId"] = serde_json::Value::String(client_event_id);
    }
    if let Some(references) = references {
        input["input"]["references"] = references;
    }
    if let Some(model) = options.model {
        input["model"] = serde_json::Value::String(model);
    }
    if let Some(max_iterations) = options.max_iterations {
        input["maxIterations"] = serde_json::json!(max_iterations);
    }

    Some(WorkerRequest::new(
        request_id.id("transport-websocket-run-input"),
        request_id.trace_id("transport-websocket-run-input"),
        "agent.run_input",
        serde_json::json!({ "input": input }),
    ))
}

fn json_string_field<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    object.get(key).and_then(serde_json::Value::as_str)
}

fn sanitize_worker_run_id_part(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "chat".to_string()
    } else {
        sanitized
    }
}

fn unsupported_rust_only_command(command: &str) -> Result<serde_json::Value, String> {
    Err(format!("{command} is unsupported in the Rust-only backend"))
}
