use crate::desktop_commands::agent::worker_run_agent_with_live_trace_sink_async;
use crate::native_agent_bridge::desktop_agent_event_sink;
use crate::worker_agent_runtime::NativeAgentTraceSink;
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::{experimental_worker_config_snapshot, native_backend_workspace_root, SharedGateway};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{Runtime, State};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerTransportGatewayFrameInput {
    kind: String,
    chat_id: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    usage: Option<serde_json::Value>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerTransportWebSocketMessageInput {
    client_id: String,
    frame: serde_json::Value,
    #[serde(default)]
    attached_chat_id: Option<String>,
    #[serde(default)]
    session_exists: Option<bool>,
    #[serde(default)]
    editable_paths: Option<Vec<String>>,
}

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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerChannelDispatchInboundInput {
    message: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerChannelLoginInput {
    channel: String,
    #[serde(default)]
    force: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WorkerTransportWebSocketDispatchOptions {
    pub(crate) model: Option<String>,
    pub(crate) max_iterations: Option<u32>,
    pub(crate) run_id: Option<String>,
    pub(crate) stream: Option<bool>,
}

#[tauri::command]
pub(crate) fn worker_transport_gateway_frame(
    input: WorkerTransportGatewayFrameInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_transport_gateway_frame_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_transport_websocket_message(
    input: WorkerTransportWebSocketMessageInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_transport_websocket_message_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) async fn worker_transport_dispatch_websocket_message<R: Runtime + 'static>(
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

#[tauri::command]
pub(crate) fn worker_channel_dispatch_inbound(
    input: WorkerChannelDispatchInboundInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_channel_dispatch_inbound_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
pub(crate) fn worker_channel_start(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_channel_start_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
pub(crate) fn worker_channel_status(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_channel_status_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_channel_stop(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_channel_stop_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
pub(crate) fn worker_channel_login(
    input: WorkerChannelLoginInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_channel_login_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
        input.channel,
        input.force,
    )
}

pub(crate) fn worker_transport_gateway_frame_with_options(
    _shared: &SharedGateway,
    _input: WorkerTransportGatewayFrameInput,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_transport_gateway_frame")
}

pub(crate) fn worker_transport_websocket_message_with_options(
    _shared: &SharedGateway,
    _input: WorkerTransportWebSocketMessageInput,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_transport_websocket_message")
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
    let Some(mut transport_result) = native_websocket_transport_result(&input) else {
        return unsupported_rust_only_command("worker_transport_dispatch_websocket_message");
    };
    if transport_result
        .get("kind")
        .and_then(serde_json::Value::as_str)
        == Some("interrupt")
    {
        let run_id = transport_result
            .get("runId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "native websocket interrupt is missing runId".to_string())?;
        let command_id = transport_result
            .get("commandId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "native websocket interrupt is missing commandId".to_string())?;
        let services = {
            let runtime = crate::lock_runtime(shared);
            runtime.native_agent_runtime.clone()
        };
        let cancellation = services.cancel_with_command_id(&run_id, Some(&command_id));
        transport_result["frames"] = serde_json::json!([{
            "event": "command_accepted",
            "chat_id": transport_result.get("chatId").cloned().unwrap_or(serde_json::Value::Null),
            "command_id": command_id,
            "run_id": run_id,
        }]);
        return Ok(serde_json::json!({
            "transport": transport_result,
            "command": cancellation,
        }));
    }
    let dispatch_options = WorkerTransportWebSocketDispatchOptions {
        model: input.model,
        max_iterations: input.max_iterations,
        run_id: input.run_id,
        stream: input.stream,
    };
    let Some(run_request) = build_worker_transport_websocket_run_input_request(
        next_worker_request_correlation(),
        &transport_result,
        dispatch_options,
    ) else {
        return Ok(serde_json::json!({ "transport": transport_result }));
    };

    let run_spec = run_request
        .params
        .get("input")
        .cloned()
        .ok_or_else(|| "native websocket dispatch missing run input".to_string())?;
    let agent_result = worker_run_agent_with_live_trace_sink_async(
        shared,
        run_spec,
        workspace_root,
        config_snapshot,
        timeout,
        live_trace_sink,
    )
    .await?;

    Ok(serde_json::json!({
        "transport": transport_result,
        "agent": agent_result,
    }))
}

pub(crate) fn native_websocket_transport_result(
    input: &WorkerTransportWebSocketDispatchInput,
) -> Option<serde_json::Value> {
    let frame = input.frame.as_object()?;
    if json_string_field(frame, "type") == Some("new_chat") {
        let chat_id = json_string_field(frame, "chat_id")
            .or_else(|| json_string_field(frame, "chatId"))
            .map(str::to_string)
            .unwrap_or_else(|| format!("chat-{}", next_worker_request_correlation().suffix()));
        let session_id = format!("websocket:{chat_id}");
        return Some(serde_json::json!({
            "kind": "new_chat",
            "chatId": chat_id,
            "sessionId": session_id,
            "attachedChatId": chat_id,
            "frames": [{ "event": "chat_created", "chat_id": chat_id }],
        }));
    }
    if json_string_field(frame, "type") == Some("interrupt") {
        let chat_id = json_string_field(frame, "chat_id")
            .or_else(|| json_string_field(frame, "chatId"))
            .or(input.attached_chat_id.as_deref())?;
        let command_id = json_string_field(frame, "command_id")
            .or_else(|| json_string_field(frame, "commandId"))?;
        let run_id = json_string_field(frame, "run_id")
            .or_else(|| json_string_field(frame, "runId"))
            .or(input.run_id.as_deref())?;
        return Some(serde_json::json!({
            "kind": "interrupt",
            "chatId": chat_id,
            "sessionId": format!("websocket:{chat_id}"),
            "commandId": command_id,
            "runId": run_id,
            "frames": [],
        }));
    }
    if json_string_field(frame, "type") != Some("message") {
        return None;
    }
    let content = json_string_field(frame, "content")?;
    let chat_id = json_string_field(frame, "chat_id")
        .or(input.attached_chat_id.as_deref())
        .unwrap_or_default();
    if chat_id.is_empty() {
        return None;
    }
    let session_id = format!("websocket:{chat_id}");
    let mut metadata = frame
        .get("metadata")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(use_persistent_rag) = frame
        .get("use_persistent_rag")
        .and_then(serde_json::Value::as_bool)
    {
        metadata.insert(
            "_use_persistent_rag".to_string(),
            serde_json::Value::Bool(use_persistent_rag),
        );
    }
    if let Some(client_event_id) = json_string_field(frame, "client_event_id")
        .or_else(|| json_string_field(frame, "clientEventId"))
    {
        metadata.insert(
            "clientEventId".to_string(),
            serde_json::Value::String(client_event_id.to_string()),
        );
    }
    if let Some(references) = frame.get("references") {
        if !references.is_array() {
            return None;
        }
        metadata.insert("references".to_string(), references.clone());
    }

    Some(serde_json::json!({
        "kind": "message",
        "chatId": chat_id,
        "sessionId": session_id,
        "frames": [],
        "inbound": {
            "channel": "websocket",
            "sender_id": input.client_id,
            "chat_id": chat_id,
            "content": content,
            "metadata": serde_json::Value::Object(metadata),
            "session_key": session_id,
        }
    }))
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

pub(crate) fn worker_channel_dispatch_inbound_with_options(
    _shared: &SharedGateway,
    _input: WorkerChannelDispatchInboundInput,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_channel_dispatch_inbound")
}

pub(crate) fn worker_channel_start_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_start_request(next_worker_request_correlation()),
        timeout,
        "start",
    )
}

pub(crate) fn worker_channel_status_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_status_request(next_worker_request_correlation()),
        timeout,
        "status",
    )
}

pub(crate) fn worker_channel_stop_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_stop_request(next_worker_request_correlation()),
        timeout,
        "stop",
    )
}

pub(crate) fn worker_channel_login_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
    channel: String,
    force: bool,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_login_request(next_worker_request_correlation(), channel, force),
        timeout,
        "login",
    )
}

fn send_channel_lifecycle_worker_request(
    _shared: &SharedGateway,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    request: WorkerRequest,
    _timeout: Duration,
    action: &str,
) -> Result<serde_json::Value, String> {
    let _ = request;
    unsupported_rust_only_command(&format!("worker_channel_{action}"))
}

fn build_worker_channel_start_request(request_id: WorkerRequestCorrelation) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-start"),
        request_id.trace_id("channel-start"),
        "channel.start",
        serde_json::json!({}),
    )
}

fn build_worker_channel_status_request(request_id: WorkerRequestCorrelation) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-status"),
        request_id.trace_id("channel-status"),
        "channel.status",
        serde_json::json!({}),
    )
}

fn build_worker_channel_stop_request(request_id: WorkerRequestCorrelation) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-stop"),
        request_id.trace_id("channel-stop"),
        "channel.stop",
        serde_json::json!({}),
    )
}

fn build_worker_channel_login_request(
    request_id: WorkerRequestCorrelation,
    channel: String,
    force: bool,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-login"),
        request_id.trace_id("channel-login"),
        "channel.login",
        serde_json::json!({
            "channel": channel,
            "force": force,
        }),
    )
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
