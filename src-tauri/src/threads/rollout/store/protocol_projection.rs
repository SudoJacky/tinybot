use crate::agent::runtime_protocol::{resolve_event_name, AgentEventKind, EventNameResolution};
use crate::threads::rollout::format::SessionApiMode;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum ProtocolEventProjection {
    ResponseItems(Vec<Value>),
    AlreadyRepresented { call_id: String },
}

pub(super) fn project_response_items(
    event: &Value,
    api_mode: SessionApiMode,
) -> ProtocolEventProjection {
    match api_mode {
        SessionApiMode::ChatCompletions => ProtocolEventProjection::ResponseItems(
            response_item_from_runtime_event(event)
                .into_iter()
                .collect(),
        ),
        SessionApiMode::Responses => project_responses_items(event),
    }
}

pub(super) fn response_items_from_runtime_event(
    event: &Value,
    api_mode: SessionApiMode,
) -> Vec<Value> {
    match project_response_items(event, api_mode) {
        ProtocolEventProjection::ResponseItems(items) => items,
        ProtocolEventProjection::AlreadyRepresented { .. } => Vec::new(),
    }
}

pub(super) fn response_item_from_runtime_event(event: &Value) -> Option<Value> {
    let payload = event.get("payload")?;
    match runtime_event_kind(event)? {
        AgentEventKind::TurnStarted => {
            let mut message = payload.get("userMessage")?.clone();
            let content = message.get("content").cloned().unwrap_or(Value::Null);
            message["type"] = Value::String("message".to_string());
            message["role"] = Value::String("user".to_string());
            message["content"] = canonical_message_content(content, "input_text");
            if message.get("id").is_none() {
                message["id"] = message
                    .get("messageId")
                    .or_else(|| message.get("message_id"))
                    .or_else(|| payload.get("userMessageId"))
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            if message.get("messageId").is_none() {
                message["messageId"] = message.get("id").cloned().unwrap_or(Value::Null);
            }
            Some(message)
        }
        AgentEventKind::MessageCompleted => {
            let content = payload.get("content")?.as_str()?;
            let message_id = payload.get("messageId").cloned().unwrap_or(Value::Null);
            Some(serde_json::json!({
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": canonical_message_content(Value::String(content.to_string()), "output_text"),
                "messageId": message_id,
                "phase": payload
                    .get("messagePhase")
                    .cloned()
                    .unwrap_or_else(|| Value::String("final_answer".to_string())),
            }))
        }
        AgentEventKind::MessageClassified => {
            let message_id = payload.get("messageId").cloned().unwrap_or(Value::Null);
            Some(serde_json::json!({
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": canonical_message_content(
                    payload.get("content").cloned().unwrap_or(Value::Null),
                    "output_text",
                ),
                "messageId": message_id,
                "phase": payload
                    .get("messagePhase")
                    .cloned()
                    .unwrap_or_else(|| Value::String("commentary".to_string())),
            }))
        }
        AgentEventKind::ReasoningCompleted => {
            let summary = payload.get("summary")?.as_str()?;
            Some(serde_json::json!({
                "type": "reasoning",
                "id": payload
                    .get("reasoningId")
                    .cloned()
                    .unwrap_or_else(|| payload.get("modelCallId").cloned().unwrap_or(Value::Null)),
                "summary": [{
                    "type": "summary_text",
                    "text": summary,
                }],
                "content": null,
                "encrypted_content": null,
                "modelCallId": payload.get("modelCallId").cloned().unwrap_or(Value::Null),
                "reasoningId": payload.get("reasoningId").cloned().unwrap_or(Value::Null),
            }))
        }
        AgentEventKind::ToolCallDelta => Some(serde_json::json!({
            "type": "custom_tool_call",
            "id": payload.get("toolCallId")?.clone(),
            "call_id": payload.get("toolCallId")?.clone(),
            "name": payload
                .get("toolName")
                .or_else(|| payload.get("name"))?
                .clone(),
            "input": payload
                .get("argumentsDelta")
                .cloned()
                .unwrap_or_else(|| serde_json::json!("{}")),
        })),
        AgentEventKind::CommandAcknowledged => Some(serde_json::json!({
            "type": "custom_tool_call",
            "id": payload.get("commandId")?.clone(),
            "call_id": payload.get("commandId")?.clone(),
            "name": payload.get("commandKind")?.clone(),
            "input": payload.get("target").cloned().unwrap_or_else(|| serde_json::json!({})),
        })),
        AgentEventKind::ToolResult => {
            let call_id = payload.get("toolCallId")?.clone();
            let item_id = call_id
                .as_str()
                .map(|call_id| format!("tool-output:{call_id}"))?;
            let mut item = serde_json::json!({
                "type": "custom_tool_call_output",
                "id": item_id,
                "call_id": call_id,
                "tool_name": payload
                    .get("toolName")
                    .or_else(|| payload.get("name"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "status": payload
                    .get("resultStatus")
                    .or_else(|| payload.get("result_status"))
                    .or_else(|| payload.get("envelope").and_then(|envelope| envelope.get("status")))
                    .cloned()
                    .unwrap_or(Value::Null),
                "output": payload
                    .get("content")
                    .or_else(|| payload.get("result"))
                    .or_else(|| payload.get("summary"))
                    .cloned()
                    .unwrap_or(Value::Null),
            });
            if let Some(result) = structured_tool_result(payload) {
                item["tinybot_result"] = result;
            }
            Some(item)
        }
        _ => None,
    }
}

pub(super) fn runtime_event_kind(event: &Value) -> Option<AgentEventKind> {
    let event_name = event.get("eventName").and_then(Value::as_str)?;
    match resolve_event_name(event_name) {
        EventNameResolution::Canonical(kind) => Some(kind),
        EventNameResolution::DeprecatedIgnored(_) | EventNameResolution::Unknown => None,
    }
}

fn project_responses_items(event: &Value) -> ProtocolEventProjection {
    let Some(payload) = event.get("payload") else {
        return ProtocolEventProjection::ResponseItems(Vec::new());
    };
    match runtime_event_kind(event) {
        Some(AgentEventKind::TurnStarted) => ProtocolEventProjection::ResponseItems(
            response_item_from_runtime_event(event)
                .into_iter()
                .collect(),
        ),
        Some(AgentEventKind::MessageClassified | AgentEventKind::MessageCompleted) => {
            ProtocolEventProjection::ResponseItems(
                payload
                    .get("responseItems")
                    .or_else(|| payload.get("response_items"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            )
        }
        Some(AgentEventKind::ToolCallDelta) => payload
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|call_id| !call_id.trim().is_empty())
            .map(|call_id| ProtocolEventProjection::AlreadyRepresented {
                call_id: call_id.to_string(),
            })
            .unwrap_or_else(|| ProtocolEventProjection::ResponseItems(Vec::new())),
        Some(AgentEventKind::ToolResult) => {
            let Some(call_id) = payload.get("toolCallId").cloned() else {
                return ProtocolEventProjection::ResponseItems(Vec::new());
            };
            let output = payload
                .get("content")
                .or_else(|| payload.get("result"))
                .or_else(|| payload.get("summary"))
                .cloned()
                .unwrap_or(Value::Null);
            let mut item = serde_json::json!({
                "type": "function_call_output",
                "call_id": call_id,
                "tool_name": payload
                    .get("toolName")
                    .or_else(|| payload.get("name"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "status": payload
                    .get("resultStatus")
                    .or_else(|| payload.get("result_status"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "output": output,
            });
            if let Some(result) = structured_tool_result(payload) {
                item["tinybot_result"] = result;
            }
            ProtocolEventProjection::ResponseItems(vec![item])
        }
        _ => ProtocolEventProjection::ResponseItems(Vec::new()),
    }
}

fn structured_tool_result(payload: &Value) -> Option<Value> {
    let result = payload
        .get("result")
        .or_else(|| {
            payload
                .get("envelope")
                .and_then(|envelope| envelope.get("raw"))
        })
        .filter(|result| !result.is_null())
        .cloned()?;
    if is_shell_process_result(payload, &result) {
        return None;
    }
    Some(result)
}

fn is_shell_process_result(payload: &Value, result: &Value) -> bool {
    let tool_name = payload
        .get("toolName")
        .or_else(|| payload.get("name"))
        .and_then(Value::as_str);
    if !matches!(tool_name, Some("exec_command" | "write_stdin")) {
        return false;
    }
    let result = result.get("result").unwrap_or(result);
    result.get("processId").and_then(Value::as_str).is_some()
        && result.get("output").and_then(Value::as_str).is_some()
}

fn canonical_message_content(content: Value, part_type: &str) -> Value {
    match content {
        Value::Array(_) => content,
        Value::String(text) => serde_json::json!([{
            "type": part_type,
            "text": text,
        }]),
        Value::Null => Value::Array(Vec::new()),
        value => serde_json::json!([{
            "type": part_type,
            "text": value.to_string(),
        }]),
    }
}
