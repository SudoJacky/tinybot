use crate::agent::runtime_protocol::{
    project_turn_items_from_trace_events, AgentRuntimeEventEnvelope, AgentTurnItem,
    LegacyNativeAgentEventEnvelopeInput,
};
use crate::threads::domain::types::{ThreadItem, ThreadItemKind};
use serde_json::Value;

fn semantic_event_from_thread_item(item: &ThreadItem) -> Option<(&'static str, Value)> {
    match &item.kind {
        ThreadItemKind::UserMessage(value) => Some((
            "agent.turn.started",
            serde_json::json!({ "userMessage": value }),
        )),
        ThreadItemKind::AssistantMessageCompleted(value) => Some((
            "agent.message.completed",
            serde_json::json!({
                "content": response_item_text(value),
                "messageId": value.get("messageId").or_else(|| value.get("id")).cloned().unwrap_or_else(|| Value::String(item.item_id.clone())),
                "messagePhase": value.get("phase").cloned().unwrap_or_else(|| Value::String("final_answer".to_string())),
            }),
        )),
        ThreadItemKind::Reasoning(value) => Some((
            "agent.reasoning.completed",
            serde_json::json!({
                "summary": reasoning_response_text(value),
                "reasoningId": value.get("reasoningId").or_else(|| value.get("id")).cloned().unwrap_or_else(|| Value::String(item.item_id.clone())),
                "modelCallId": value.get("modelCallId").cloned().unwrap_or(Value::Null),
            }),
        )),
        ThreadItemKind::ToolCallStarted(value) => Some((
            "agent.tool_call.delta",
            serde_json::json!({
                "toolCallId": semantic_item_id(item),
                "toolName": value.get("name").or_else(|| value.get("toolName")).cloned().unwrap_or(Value::Null),
                "argumentsDelta": value.get("input").or_else(|| value.get("arguments")).cloned().unwrap_or_else(|| serde_json::json!({})),
            }),
        )),
        ThreadItemKind::ToolCallOutput(value) => Some((
            "agent.tool.result",
            serde_json::json!({
                "toolCallId": semantic_item_id(item),
                "content": value.get("output").cloned().unwrap_or(Value::Null),
            }),
        )),
        ThreadItemKind::ApprovalRequested(value) => {
            Some(("agent.awaiting_approval", value.clone()))
        }
        ThreadItemKind::ApprovalResolved(value) => Some(("agent.approval.decision", value.clone())),
        ThreadItemKind::SubagentSpawned(value) => Some(("agent.delegate.spawned", value.clone())),
        ThreadItemKind::SubagentMessage(value) => Some(("agent.delegate.message", value.clone())),
        ThreadItemKind::SubagentCompleted(value) => {
            Some(("agent.delegate.completed", value.clone()))
        }
        ThreadItemKind::Error(value) => Some(("agent.error", value.clone())),
        ThreadItemKind::Cancelled(value) => Some(("agent.cancelled", value.clone())),
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
    let (event_name, payload) = semantic_event_from_thread_item(item)?;
    let item_id = semantic_item_id(item);
    Some(AgentRuntimeEventEnvelope::from_legacy_native_event(
        LegacyNativeAgentEventEnvelopeInput {
            session_id: session_id.to_string(),
            thread_id: Some(item.thread_id.clone()),
            turn_id: item.turn_id.clone(),
            parent_turn_id: None,
            item_id: Some(item_id),
            event_name: event_name.to_string(),
            sequence: item.sequence,
            timestamp: item.created_at.clone(),
            payload,
        },
    ))
}

fn semantic_item_id(item: &ThreadItem) -> String {
    if let ThreadItemKind::ApprovalRequested(value) | ThreadItemKind::ApprovalResolved(value) =
        &item.kind
    {
        return value
            .get("approvalId")
            .or_else(|| value.get("approval_id"))
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
        "approvalId",
        "delegateId",
        "subagentId",
        "id",
    ]
    .into_iter()
    .find_map(|key| value.get(key).and_then(Value::as_str))
    .unwrap_or(&item.item_id)
    .to_string()
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
