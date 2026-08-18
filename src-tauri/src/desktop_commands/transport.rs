use crate::agent::bridge::desktop_agent_event_sink;
use crate::agent::runtime::NativeAgentTraceSink;
use crate::config::application::{native_backend_workspace_root, native_runtime_config_snapshot};
use crate::desktop::{state::lock_runtime, SharedNativeRuntime};
use crate::desktop_commands::agent::worker_run_agent_with_live_trace_sink_async;
use crate::protocol::request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::workspace_store::WorkspaceThreadStore;
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
    pub(crate) stream: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WorkerTransportWebSocketDispatchOptions {
    pub(crate) model: Option<String>,
    pub(crate) max_iterations: Option<u32>,
    pub(crate) turn_id: Option<String>,
    pub(crate) stream: Option<bool>,
}

#[tauri::command]
pub(crate) async fn worker_dispatch_tinyos_host_command<R: Runtime + 'static>(
    input: WorkerTransportWebSocketDispatchInput,
    state: State<'_, SharedNativeRuntime>,
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let shared = state.inner().clone();
    let workspace_root = native_backend_workspace_root();
    let config_snapshot = native_runtime_config_snapshot();
    let live_trace_sink = desktop_agent_event_sink(app.clone());
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
    shared: &SharedNativeRuntime,
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
    shared: &SharedNativeRuntime,
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
    dispatch_tinyos_retry_command(
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
            "worker_dispatch_tinyos_host_command accepts only TinyOS host commands; use worker_submit_thread_turn, worker_thread_interrupt, or worker_submit_thread_form for chat"
                .to_string(),
        );
    }
    let command_kind = frame
        .get("command_kind")
        .or_else(|| frame.get("commandKind"))
        .and_then(serde_json::Value::as_str);
    if command_kind != Some("operation.retry") {
        return Err("TinyOS host command dispatcher accepts only operation.retry; chat control commands must use the typed Thread API".to_string());
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
    if command_kind != "operation.retry" {
        return None;
    }
    let turn_id =
        json_string_field(frame, "turn_id").or_else(|| json_string_field(frame, "turnId"))?;
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
        "turnId": turn_id,
        "threadId": json_string_field(frame, "thread_id").or_else(|| json_string_field(frame, "threadId")),
        "source": frame.get("source").cloned().unwrap_or(serde_json::Value::Null),
        "frames": [],
    });
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
    Some(transport)
}
async fn dispatch_tinyos_retry_command(
    shared: &SharedNativeRuntime,
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
        workspace_root,
        config_snapshot,
        live_trace_sink,
        timeout,
    )
    .await
}

async fn dispatch_tinyos_new_turn_command(
    shared: &SharedNativeRuntime,
    mut transport: serde_json::Value,
    content: String,
    command_metadata: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let session_id = required_transport_string(&transport, "sessionId")?;
    let turn_id = required_transport_string(&transport, "turnId")?;
    let command_id = required_transport_string(&transport, "commandId")?;
    let command_kind = required_transport_string(&transport, "commandKind")?;
    let metadata = serde_json::json!({ "_tinyosCommand": command_metadata });
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
    worker_run_agent_with_live_trace_sink_async(
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
    Ok(serde_json::json!({
        "transport": transport,
        "sessionId": session_id,
        "turnId": turn_id,
    }))
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
