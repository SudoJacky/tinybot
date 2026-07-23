use crate::agent::bridge::desktop_agent_event_sink;
use crate::agent::runtime::NativeAgentTraceSink;
use crate::config::application::{native_backend_workspace_root, native_config_snapshot};
use crate::desktop::{state::lock_runtime, SharedGateway};
use crate::desktop_commands::agent::worker_run_agent_with_live_trace_sink_async;
use crate::native_browser::{BrowserInteractionInput, SharedBrowserRuntime};
use crate::protocol::capability::default_desktop_capability_policy;
use crate::protocol::request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::workspace_store::WorkspaceThreadStore;
use crate::tools::permissions::{PermissionNetworkMode, ShellSandboxMode};
use crate::tools::shell::{
    ShellProcessIdParams, ShellProcessListParams, ShellProcessOutput, ShellProcessPollParams,
    ShellStartParams, WorkerShellRpc,
};
use crate::workspace::WorkerWorkspaceRpc;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{Emitter, Runtime, State};

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
    pub(crate) stream: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WorkerTransportWebSocketDispatchOptions {
    pub(crate) model: Option<String>,
    pub(crate) max_iterations: Option<u32>,
    pub(crate) turn_id: Option<String>,
    pub(crate) stream: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TinyOsHostOperationEvent {
    session_id: String,
    operation_id: String,
    command_id: String,
    command_kind: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

type TinyOsHostOperationSink =
    Arc<dyn Fn(TinyOsHostOperationEvent) -> Result<(), String> + Send + Sync + 'static>;

#[tauri::command]
pub(crate) async fn worker_dispatch_tinyos_host_command<R: Runtime + 'static>(
    input: WorkerTransportWebSocketDispatchInput,
    state: State<'_, SharedGateway>,
    browser_runtime: State<'_, SharedBrowserRuntime>,
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let shared = state.inner().clone();
    let workspace_root = native_backend_workspace_root();
    let config_snapshot = native_config_snapshot();
    let live_trace_sink = desktop_agent_event_sink(app.clone());
    let host_operation_sink: TinyOsHostOperationSink = Arc::new(move |event| {
        app.emit("tinyos:host-operation", event)
            .map_err(|error| format!("TinyOS host operation event emit failed: {error}"))
    });
    worker_transport_dispatch_websocket_message_with_live_trace_sink_async(
        &shared,
        input,
        workspace_root,
        config_snapshot,
        Duration::from_secs(60),
        Some(live_trace_sink),
        Some(browser_runtime.inner().clone()),
        Some(host_operation_sink),
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
            None,
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
    browser_runtime: Option<SharedBrowserRuntime>,
    host_operation_sink: Option<TinyOsHostOperationSink>,
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
        browser_runtime,
        host_operation_sink,
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
    let agent_command = matches!(
        command_kind,
        "agent.pause" | "agent.resume" | "operation.retry" | "agent.request_change"
    );
    let identity_key = if agent_command {
        "turnId"
    } else {
        "operationId"
    };
    let identity = if agent_command {
        json_string_field(frame, "turn_id").or_else(|| json_string_field(frame, "turnId"))
    } else {
        json_string_field(frame, "operation_id").or_else(|| json_string_field(frame, "operationId"))
    }?;
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
        "threadId": json_string_field(frame, "thread_id").or_else(|| json_string_field(frame, "threadId")),
        "source": frame.get("source").cloned().unwrap_or(serde_json::Value::Null),
        "frames": [],
    });
    transport[identity_key] = serde_json::Value::String(identity.to_string());
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
        transport["observedTurnId"] = frame
            .get("observed_turn_id")
            .or_else(|| frame.get("observedTurnId"))
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
        transport["browserSessionId"] = frame
            .get("browser_session_id")
            .or_else(|| frame.get("browserSessionId"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["captureId"] = frame
            .get("capture_id")
            .or_else(|| frame.get("captureId"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["controlEpoch"] = frame
            .get("control_epoch")
            .or_else(|| frame.get("controlEpoch"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["observationRevision"] = frame
            .get("observation_revision")
            .or_else(|| frame.get("observationRevision"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        transport["tabId"] = frame
            .get("tab_id")
            .or_else(|| frame.get("tabId"))
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
    browser_runtime: Option<SharedBrowserRuntime>,
    host_operation_sink: Option<TinyOsHostOperationSink>,
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
            dispatch_tinyos_agent_turn_control_command(
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
                host_operation_sink,
            )
            .await
        }
        Some("browser.interact") => {
            dispatch_tinyos_browser_command(
                transport,
                workspace_root,
                config_snapshot,
                live_trace_sink,
                browser_runtime,
            )
            .await
        }
        command_kind => Err(format!(
            "unsupported TinyOS command kind: {}",
            command_kind.unwrap_or("missing")
        )),
    }
}

async fn dispatch_tinyos_agent_turn_control_command(
    shared: &SharedGateway,
    mut transport: serde_json::Value,
    _workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let turn_id = required_transport_string(&transport, "turnId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    let task_runtime = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.task_runtime()
    };
    let task_status = task_runtime
        .status(&turn_id)
        .ok_or_else(|| format!("{command_kind} target turn `{turn_id}` was not found"))?;
    if task_status.session_id != session_id {
        return Err(format!(
            "{command_kind} target turn `{turn_id}` belongs to session `{}`",
            task_status.session_id
        ));
    }
    match command_kind.as_str() {
        "agent.pause" if !task_status.active || task_status.phase == "paused" => {
            return Err(format!(
                "agent.pause target turn `{turn_id}` is not running"
            ));
        }
        "agent.resume" if !task_status.active || task_status.phase != "paused" => {
            return Err(format!(
                "agent.resume target turn `{turn_id}` is not paused"
            ));
        }
        "agent.pause" | "agent.resume" => {}
        _ => return Err(format!("unsupported TinyOS command kind: {command_kind}")),
    }
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    persist_tinyos_command_acknowledgement(
        &thread_store,
        config_snapshot,
        &session_id,
        &turn_id,
        &command_id,
        &transport,
    )?;
    let outcome = if command_kind == "agent.pause" {
        task_runtime.request_pause(&turn_id, &command_id)
    } else {
        task_runtime.request_resume(&turn_id, &command_id)
    }
    .map_err(|error| format!("{command_kind} failed: {error}"))?;
    transport["frames"] = serde_json::json!([
        {
            "event": "command_accepted",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": &command_id,
            "turn_id": &turn_id,
        },
        {
            "event": "command_canonical_updated",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": &command_id,
            "turn_id": &turn_id,
        }
    ]);
    Ok(serde_json::json!({ "transport": transport, "control": outcome }))
}

async fn dispatch_tinyos_file_command(
    shared: &SharedGateway,
    mut transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let operation_id = required_transport_string(&transport, "operationId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    if !operation_id.starts_with("tinyos-host-file-") {
        return Err(format!(
            "{command_kind} requires a dedicated TinyOS file operation"
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
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    ensure_no_active_agent_turn(&thread_store, &session_id, config_snapshot.clone())?;
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
            return Err(format!("{command_kind} failed: {message}"));
        }
    };
    set_tinyos_operation_frames(&mut transport, &command_id, &operation_id);
    Ok(serde_json::json!({ "transport": transport, "operation": result }))
}

async fn dispatch_tinyos_terminal_command(
    shared: &SharedGateway,
    mut transport: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    host_operation_sink: Option<TinyOsHostOperationSink>,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let operation_id = required_transport_string(&transport, "operationId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    if !operation_id.starts_with("tinyos-host-terminal-") {
        return Err(format!(
            "{command_kind} requires a TinyOS terminal operation"
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
                owner_id: Some(operation_id.clone()),
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
            .ok_or_else(|| {
                format!("terminal.cancel found no running process for `{operation_id}`")
            })?;
        let outcome = shell
            .interrupt(ShellProcessIdParams {
                process_id: active.process_id,
                owner_id: Some(operation_id.clone()),
            })
            .map_err(|error| {
                format!(
                    "terminal.cancel failed: {}",
                    worker_protocol_error_message(&error)
                )
            })?;
        emit_tinyos_host_operation(
            &host_operation_sink,
            &session_id,
            &operation_id,
            &command_id,
            &command_kind,
            "cancelled",
            Some(outcome.process_id.clone()),
            None,
        )?;
        set_tinyos_operation_frames(&mut transport, &command_id, &operation_id);
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
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    ensure_no_active_agent_turn(&thread_store, &session_id, config_snapshot.clone())?;
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
            owner_id: Some(operation_id.clone()),
            tool_call_id: Some(command_id.clone()),
            cancellation: None,
        },
        "user_confirmed",
    ) {
        Ok(output) => output,
        Err(error) => {
            let message = worker_protocol_error_message(&error);
            return Err(format!("terminal.execute failed: {message}"));
        }
    };
    if let Some(message) = tinyos_terminal_process_failure(&initial) {
        return Err(format!("terminal.execute failed: {message}"));
    }
    let initial_response = serde_json::json!({
        "processId": initial.process_id.clone(),
        "operationId": operation_id.clone(),
        "status": initial.status.clone(),
    });
    emit_tinyos_host_operation(
        &host_operation_sink,
        &session_id,
        &operation_id,
        &command_id,
        &command_kind,
        if initial.running {
            "running"
        } else {
            "completed"
        },
        Some(initial.process_id.clone()),
        None,
    )?;
    let background_shell = shell.clone();
    let background_operation_id = operation_id.clone();
    let background_session_id = session_id.clone();
    let background_command_id = command_id.clone();
    let background_command_kind = command_kind.clone();
    let background_operation_sink = host_operation_sink.clone();
    tauri::async_runtime::spawn(async move {
        let mut output = initial;
        while output.running {
            tokio::time::sleep(Duration::from_millis(100)).await;
            match background_shell.poll(ShellProcessPollParams {
                process_id: output.process_id.clone(),
                owner_id: Some(background_operation_id.clone()),
                cursor: Some(output.cursor),
                yield_time_ms: Some(50),
            }) {
                Ok(next) => output = next,
                Err(error) => {
                    let message = worker_protocol_error_message(&error);
                    eprintln!(
                        "TinyOS terminal polling failed for operation {}: {}",
                        background_operation_id, message
                    );
                    let _ = emit_tinyos_host_operation(
                        &background_operation_sink,
                        &background_session_id,
                        &background_operation_id,
                        &background_command_id,
                        &background_command_kind,
                        "failed",
                        Some(output.process_id.clone()),
                        Some(message),
                    );
                    return;
                }
            }
        }
        let terminal_error = tinyos_terminal_process_failure(&output);
        let status = if output.status == "cancelled" {
            "cancelled"
        } else if terminal_error.is_some() {
            "failed"
        } else {
            "completed"
        };
        let _ = emit_tinyos_host_operation(
            &background_operation_sink,
            &background_session_id,
            &background_operation_id,
            &background_command_id,
            &background_command_kind,
            status,
            Some(output.process_id),
            terminal_error,
        );
    });
    set_tinyos_operation_frames(&mut transport, &command_id, &operation_id);
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
    let retry_turn_id = required_transport_string(&transport, "turnId")?;
    let source_turn_id = required_transport_string(&transport, "sourceTurnId")?;
    let item_id = required_transport_string(&transport, "itemId")?;
    if retry_turn_id == source_turn_id {
        return Err("operation.retry requires a new target turnId".to_string());
    }

    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let source_item = validate_tinyos_retry_source(
        &thread_store,
        &session_id,
        &source_turn_id,
        &item_id,
        config_snapshot.clone(),
    )?;
    let description = tinyos_retry_source_description(&source_item);
    let content = format!(
        "Retry the failed canonical operation `{description}` (source item `{item_id}` from turn `{source_turn_id}`). Preserve completed work, verify the failure context, and continue the task from that operation."
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
            "turnId": &retry_turn_id,
            "sessionId": &session_id,
            "threadId": transport.get("threadId").cloned().unwrap_or(serde_json::Value::Null),
        },
    });
    dispatch_tinyos_new_turn_command(
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
    let request_turn_id = required_transport_string(&transport, "turnId")?;
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
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    validate_tinyos_followup_turn_state(
        &thread_store,
        &session_id,
        transport
            .get("observedTurnId")
            .and_then(serde_json::Value::as_str),
        config_snapshot.clone(),
    )?;
    let command_metadata = serde_json::json!({
        "commandId": command_id,
        "commandKind": "agent.request_change",
        "request": {
            "observedTurnId": transport.get("observedTurnId").cloned().unwrap_or(serde_json::Value::Null),
            "referenceCount": references.len(),
        },
        "source": transport.get("source").cloned().unwrap_or(serde_json::Value::Null),
        "target": {
            "turnId": request_turn_id,
            "sessionId": session_id,
            "threadId": transport.get("threadId").cloned().unwrap_or(serde_json::Value::Null),
        },
    });
    dispatch_tinyos_new_turn_command(
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

async fn dispatch_tinyos_new_turn_command(
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
    let turn_id = required_transport_string(&transport, "turnId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    let mut metadata = serde_json::json!({ "_tinyosCommand": command_metadata });
    if let Some(references) = references {
        metadata["references"] = references;
    }
    let turn_transport = serde_json::json!({
        "inbound": {
            "channel": "websocket",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "content": content,
            "metadata": metadata,
            "session_key": &session_id,
        }
    });
    let turn_request = build_worker_transport_websocket_turn_input_request(
        next_worker_request_correlation(),
        &turn_transport,
        WorkerTransportWebSocketDispatchOptions {
            turn_id: Some(turn_id.clone()),
            stream: Some(true),
            ..WorkerTransportWebSocketDispatchOptions::default()
        },
    )
    .ok_or_else(|| format!("{command_kind} failed to build Agent turn input"))?;
    let turn_spec = turn_request
        .params
        .get("input")
        .cloned()
        .ok_or_else(|| format!("{command_kind} Agent turn input is missing"))?;
    let agent_result = worker_run_agent_with_live_trace_sink_async(
        shared,
        turn_spec,
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
            "turn_id": &turn_id,
        },
        {
            "event": "command_canonical_updated",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": &command_id,
            "turn_id": &turn_id,
        }
    ]);
    Ok(serde_json::json!({ "transport": transport, "agent": agent_result }))
}

fn validate_tinyos_followup_turn_state(
    thread_store: &WorkspaceThreadStore,
    session_id: &str,
    observed_turn_id: Option<&str>,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    let turns = call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-followup-turn-list"),
            request_id.trace_id("tinyos-followup-turn-list"),
            "thread.turn.list",
            serde_json::json!({ "threadId": session_id }),
        ),
        "TinyOS follow-up turn lookup",
    )?;
    let turns = turns
        .get("turns")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let latest = turns.first();
    let latest_turn_id = latest
        .and_then(|turn| turn.get("turnId"))
        .and_then(serde_json::Value::as_str);
    if latest_turn_id != observed_turn_id {
        return Err(format!(
            "agent.request_change observed stale turn `{}`; latest turn is `{}`",
            observed_turn_id.unwrap_or("none"),
            latest_turn_id.unwrap_or("none")
        ));
    }
    if turns.iter().any(|turn| {
        turn.get("status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|status| matches!(status, "running" | "waiting"))
    }) {
        return Err(
            "agent.request_change is unavailable while an Agent turn is active".to_string(),
        );
    }
    Ok(())
}

fn validate_tinyos_retry_source(
    thread_store: &WorkspaceThreadStore,
    session_id: &str,
    source_turn_id: &str,
    item_id: &str,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let turns = call_rust_state_service(
        thread_store,
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("tinyos-retry-turn-list"),
            request_id.trace_id("tinyos-retry-turn-list"),
            "thread.turn.list",
            serde_json::json!({ "threadId": session_id }),
        ),
        "TinyOS retry turn lookup",
    )?;
    let latest_turn = turns
        .get("turns")
        .and_then(serde_json::Value::as_array)
        .and_then(|turns| turns.first())
        .ok_or_else(|| "operation.retry source turn was not found".to_string())?;
    let latest_turn_id = latest_turn
        .get("turnId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if latest_turn_id != source_turn_id {
        return Err(format!(
            "operation.retry targets stale turn `{source_turn_id}`; latest turn is `{latest_turn_id}`"
        ));
    }
    if latest_turn
        .get("status")
        .and_then(serde_json::Value::as_str)
        != Some("failed")
    {
        return Err(format!(
            "operation.retry source turn `{source_turn_id}` is not failed"
        ));
    }

    let request_id = next_worker_request_correlation();
    let runtime_state = call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-retry-runtime-state"),
            request_id.trace_id("tinyos-retry-runtime-state"),
            "thread.turn.runtime_state",
            serde_json::json!({
                "threadId": session_id,
                "turnId": source_turn_id,
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

fn ensure_no_active_agent_turn(
    thread_store: &WorkspaceThreadStore,
    session_id: &str,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    let turns = call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-host-active-turns"),
            request_id.trace_id("tinyos-host-active-turns"),
            "thread.turn.list",
            serde_json::json!({ "threadId": session_id }),
        ),
        "TinyOS host operation active-turn validation",
    )?;
    let active = turns
        .get("turns")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|turn| {
            matches!(
                turn.get("status").and_then(serde_json::Value::as_str),
                Some("running" | "waiting")
            )
        });
    if let Some(active) = active {
        return Err(format!(
            "TinyOS host operation is unavailable while turn `{}` is active",
            active
                .get("turnId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    Ok(())
}

fn worker_protocol_error_message(error: &crate::protocol::WorkerProtocolError) -> String {
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

async fn dispatch_tinyos_browser_command(
    mut transport: serde_json::Value,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    browser_runtime: Option<SharedBrowserRuntime>,
) -> Result<serde_json::Value, String> {
    let operation_id = required_transport_string(&transport, "operationId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    if !operation_id.starts_with("tinyos-host-browser-") {
        return Err(format!(
            "{command_kind} requires a dedicated TinyOS browser operation"
        ));
    }
    if transport
        .get("confirmed")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err("browser.interact requires explicit user confirmation".to_string());
    }
    let command_id = required_transport_string(&transport, "commandId")?;
    let browser_session_id = required_transport_string(&transport, "browserSessionId")?;
    let tab_id = required_transport_string(&transport, "tabId")?;
    let input: BrowserInteractionInput = serde_json::from_value(serde_json::json!({
        "browserSessionId": browser_session_id,
        "tabId": tab_id,
        "commandId": command_id,
        "controlEpoch": transport.get("controlEpoch").cloned().unwrap_or(serde_json::Value::Null),
        "captureId": transport.get("captureId").cloned().unwrap_or(serde_json::Value::Null),
        "observationRevision": transport.get("observationRevision").cloned().unwrap_or(serde_json::Value::Null),
        "action": transport.get("action").cloned().unwrap_or(serde_json::Value::Null),
    }))
    .map_err(|error| format!("browser.interact payload is invalid: {error}"))?;
    let browser_runtime = browser_runtime.ok_or_else(|| {
        "browser.interact is unavailable because the native browser runtime is not managed"
            .to_string()
    })?;

    let result = browser_runtime
        .interact(input)
        .await
        .map_err(|error| format!("browser.interact failed: {error}"))?;
    set_tinyos_operation_frames(&mut transport, &command_id, &operation_id);
    Ok(serde_json::json!({ "transport": transport, "operation": result }))
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

fn set_tinyos_operation_frames(
    transport: &mut serde_json::Value,
    command_id: &str,
    operation_id: &str,
) {
    transport["frames"] = serde_json::json!([
        {
            "event": "command_accepted",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": command_id,
            "operation_id": operation_id,
        },
        {
            "event": "command_canonical_updated",
            "chat_id": transport.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": command_id,
            "operation_id": operation_id,
        }
    ]);
}

#[allow(clippy::too_many_arguments)]
fn emit_tinyos_host_operation(
    sink: &Option<TinyOsHostOperationSink>,
    session_id: &str,
    operation_id: &str,
    command_id: &str,
    command_kind: &str,
    status: &str,
    process_id: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let Some(sink) = sink else {
        return Ok(());
    };
    sink(TinyOsHostOperationEvent {
        session_id: session_id.to_string(),
        operation_id: operation_id.to_string(),
        command_id: command_id.to_string(),
        command_kind: command_kind.to_string(),
        status: status.to_string(),
        process_id,
        error,
    })
}

fn persist_tinyos_command_acknowledgement(
    thread_store: &WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
    session_id: &str,
    turn_id: &str,
    command_id: &str,
    transport: &serde_json::Value,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("tinyos-command-acknowledge"),
            request_id.trace_id("tinyos-command-acknowledge"),
            "thread.turn.append_semantic_batch",
            serde_json::json!({
                "threadId": session_id,
                "turnId": turn_id,
                "events": [{
                    "eventId": format!("{turn_id}:command-ack:{command_id}"),
                    "itemId": format!("{turn_id}:command-ack:{command_id}"),
                    "eventName": "agent.command.acknowledged",
                    "payload": {
                        "commandId": command_id,
                        "commandKind": transport.get("commandKind").cloned().unwrap_or(serde_json::Value::Null),
                        "commandStatus": "acknowledged",
                        "message": "Agent command acknowledged",
                        "source": transport.get("source").cloned().unwrap_or(serde_json::Value::Null),
                        "target": {
                            "sessionId": session_id,
                            "turnId": turn_id,
                            "threadId": transport.get("threadId").cloned().unwrap_or(serde_json::Value::Null),
                        }
                    }
                }]
            }),
        ),
        "TinyOS command acknowledgement append",
    )?;
    Ok(())
}

pub(crate) fn build_worker_transport_websocket_turn_input_request(
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

    let turn_id = options.turn_id.unwrap_or_else(|| {
        format!(
            "websocket-{}-{}",
            sanitize_worker_turn_id_part(if chat_id.is_empty() {
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
        "turnId": turn_id,
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
        request_id.id("transport-websocket-turn-input"),
        request_id.trace_id("transport-websocket-turn-input"),
        "agent.turn_input",
        serde_json::json!({ "input": input }),
    ))
}

fn json_string_field<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    object.get(key).and_then(serde_json::Value::as_str)
}

fn sanitize_worker_turn_id_part(value: &str) -> String {
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
