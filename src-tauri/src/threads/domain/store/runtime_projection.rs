use crate::agent::runtime_protocol::{
    project_turn_items_from_trace_events, AgentEventKind, AgentRuntimeEventEnvelope, AgentTurnItem,
    LegacyNativeAgentEventEnvelopeInput,
};
use crate::threads::domain::types::{ThreadItem, ThreadItemKind};
use serde_json::Value;

fn semantic_event_from_thread_item(item: &ThreadItem) -> Option<(AgentEventKind, Value)> {
    match &item.kind {
        ThreadItemKind::UserMessage(value) => Some((
            AgentEventKind::TurnStarted,
            serde_json::json!({ "userMessage": value }),
        )),
        ThreadItemKind::AssistantMessageCompleted(value) => Some((
            AgentEventKind::MessageCompleted,
            serde_json::json!({
                "content": response_item_text(value),
                "messageId": value.get("messageId").or_else(|| value.get("id")).cloned().unwrap_or_else(|| Value::String(item.item_id.clone())),
                "messagePhase": value.get("phase").cloned().unwrap_or_else(|| Value::String("final_answer".to_string())),
            }),
        )),
        ThreadItemKind::Reasoning(value) => Some((
            AgentEventKind::ReasoningCompleted,
            serde_json::json!({
                "summary": reasoning_response_text(value),
                "reasoningId": value.get("reasoningId").or_else(|| value.get("id")).cloned().unwrap_or_else(|| Value::String(item.item_id.clone())),
                "modelCallId": value.get("modelCallId").cloned().unwrap_or(Value::Null),
            }),
        )),
        ThreadItemKind::ToolCallStarted(value) => Some((
            AgentEventKind::ToolCallDelta,
            serde_json::json!({
                "toolCallId": semantic_item_id(item),
                "toolName": value.get("name").or_else(|| value.get("toolName")).cloned().unwrap_or(Value::Null),
                "argumentsDelta": value.get("input").or_else(|| value.get("arguments")).cloned().unwrap_or_else(|| serde_json::json!({})),
            }),
        )),
        ThreadItemKind::ToolCallOutput(value) => Some((
            AgentEventKind::ToolResult,
            serde_json::json!({
                "toolCallId": semantic_item_id(item),
                "content": value.get("output").cloned().unwrap_or(Value::Null),
            }),
        )),
        ThreadItemKind::ApprovalRequested(_) | ThreadItemKind::ApprovalResolved(_) => None,
        ThreadItemKind::SubagentSpawned(value) => {
            Some((AgentEventKind::DelegateSpawned, value.clone()))
        }
        ThreadItemKind::SubagentMessage(value) => Some((
            AgentEventKind::DelegateMessage,
            normalized_subagent_message_payload(item, value),
        )),
        ThreadItemKind::SubagentCompleted(value) => {
            Some((AgentEventKind::DelegateCompleted, value.clone()))
        }
        ThreadItemKind::Error(value) => Some((AgentEventKind::Error, value.clone())),
        ThreadItemKind::Cancelled(value) => Some((AgentEventKind::Cancelled, value.clone())),
        ThreadItemKind::AssistantMessageDelta(_)
        | ThreadItemKind::TurnStarted(_)
        | ThreadItemKind::TurnStep(_)
        | ThreadItemKind::TurnCompleted(_)
        | ThreadItemKind::CheckpointCreated(_)
        | ThreadItemKind::ContextTrimmed(_)
        | ThreadItemKind::ContextCompaction(_)
        | ThreadItemKind::SettingsChanged(_)
        | ThreadItemKind::Event(_) => None,
    }
}

fn reasoning_response_text(value: &Value) -> String {
    if let Some(text) = value
        .get("summary")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("text").and_then(Value::as_str))
        .next()
    {
        return text.to_string();
    }
    value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("text").and_then(Value::as_str))
        .next()
        .or_else(|| value.get("summary").and_then(Value::as_str))
        .or_else(|| value.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn runtime_event_from_thread_item(
    item: &ThreadItem,
    session_id: &str,
) -> Option<AgentRuntimeEventEnvelope> {
    let (event_kind, payload) = semantic_event_from_thread_item(item)?;
    let item_id = semantic_item_id(item);
    Some(AgentRuntimeEventEnvelope::from_legacy_native_event(
        LegacyNativeAgentEventEnvelopeInput {
            session_id: session_id.to_string(),
            thread_id: Some(item.thread_id.clone()),
            turn_id: item.turn_id.clone(),
            parent_turn_id: None,
            item_id: Some(item_id),
            event_name: event_kind.wire_name().to_string(),
            sequence: item.sequence,
            timestamp: item.created_at.clone(),
            payload,
        },
    ))
}

fn semantic_item_id(item: &ThreadItem) -> String {
    if let ThreadItemKind::SubagentMessage(value) = &item.kind {
        return value
            .get("messageId")
            .or_else(|| value.get("message_id"))
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(&item.item_id)
            .to_string();
    }
    let value = match &item.kind {
        ThreadItemKind::AssistantMessageCompleted(value)
        | ThreadItemKind::Reasoning(value)
        | ThreadItemKind::ToolCallStarted(value)
        | ThreadItemKind::ToolCallOutput(value)
        | ThreadItemKind::SubagentSpawned(value)
        | ThreadItemKind::SubagentMessage(value)
        | ThreadItemKind::SubagentCompleted(value) => value,
        _ => return item.item_id.clone(),
    };
    [
        "call_id",
        "callId",
        "toolCallId",
        "messageId",
        "reasoningId",
        "delegateId",
        "subagentId",
        "id",
    ]
    .into_iter()
    .find_map(|key| value.get(key).and_then(Value::as_str))
    .unwrap_or(&item.item_id)
    .to_string()
}

fn normalized_subagent_message_payload(item: &ThreadItem, value: &Value) -> Value {
    let mut payload = value
        .as_object()
        .cloned()
        .unwrap_or_else(|| panic!("persisted subagent message payload must be an object"));
    if !payload.contains_key("agentId") {
        if let Some(agent_id) = ["agent_id", "delegateId", "delegate_id", "subagentId"]
            .into_iter()
            .find_map(|key| payload.get(key).cloned())
        {
            payload.insert("agentId".to_string(), agent_id);
        }
    }
    if !payload.contains_key("messageId") {
        let message_id = ["message_id", "id"]
            .into_iter()
            .find_map(|key| payload.get(key).cloned())
            .unwrap_or_else(|| Value::String(item.item_id.clone()));
        payload.insert("messageId".to_string(), message_id);
    }
    Value::Object(payload)
}

fn response_item_text(value: &Value) -> String {
    match value.get("content") {
        Some(Value::String(content)) => content.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(Value::as_str))
            })
            .collect(),
        Some(Value::Null) | None => String::new(),
        Some(content) => content.to_string(),
    }
}

pub(crate) fn runtime_events_from_thread_items(
    items: &[ThreadItem],
    session_id: &str,
    turn_id: &str,
) -> Vec<AgentRuntimeEventEnvelope> {
    items
        .iter()
        .filter(|item| item.turn_id == turn_id)
        .filter_map(|item| runtime_event_from_thread_item(item, session_id))
        .collect()
}

pub(super) fn turn_items_from_thread_items(
    items: &[ThreadItem],
    session_id: &str,
    turn_id: &str,
) -> Vec<AgentTurnItem> {
    let runtime_events = runtime_events_from_thread_items(items, session_id, turn_id);
    project_turn_items_from_trace_events(&runtime_events)
}

#[cfg(test)]
#[path = "runtime_projection_tests.rs"]
mod tests;
