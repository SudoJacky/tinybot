use crate::agent_loop_runtime_protocol::{
    project_turn_items_from_trace_events, AgentRuntimeEventEnvelope, AgentTurnItem,
    LegacyNativeAgentEventEnvelopeInput,
};
use crate::worker_thread::types::{ThreadItem, ThreadItemKind};
use serde_json::Value;

pub(super) fn trace_event_from_thread_item(item: &ThreadItem) -> Option<Value> {
    let (payload, fallback_event_name) = match &item.kind {
        ThreadItemKind::AssistantMessageDelta(value) => (value, Some("agent.assistant.delta")),
        ThreadItemKind::AssistantMessageCompleted(value) => {
            (value, Some("agent.assistant.completed"))
        }
        ThreadItemKind::Reasoning(value) => (value, Some("agent.reasoning")),
        ThreadItemKind::ToolCallStarted(value) => (value, Some("agent.tool.start")),
        ThreadItemKind::ToolCallOutput(value) => (value, Some("agent.tool.result")),
        ThreadItemKind::ApprovalRequested(value) => (value, Some("agent.awaiting_approval")),
        ThreadItemKind::ApprovalResolved(value) => (value, Some("agent.approval.decision")),
        ThreadItemKind::AgentRunStep(value) => (value, Some("agent.step")),
        ThreadItemKind::CheckpointCreated(value) => (value, None),
        ThreadItemKind::ContextTrimmed(value) => (value, Some("agent.context.trimmed")),
        ThreadItemKind::ContextCompaction(value) => (value, Some("agent.context.compacted")),
        ThreadItemKind::SubagentSpawned(value) => (value, Some("agent.delegate.spawned")),
        ThreadItemKind::SubagentMessage(value) => (value, Some("agent.delegate.message")),
        ThreadItemKind::SubagentCompleted(value) => (value, Some("agent.delegate.completed")),
        ThreadItemKind::Error(value) => (value, Some("agent.error")),
        ThreadItemKind::Cancelled(value) => (value, Some("agent.cancelled")),
        ThreadItemKind::Event(value) => (value, None),
        ThreadItemKind::UserMessage(_)
        | ThreadItemKind::AgentRunStarted(_)
        | ThreadItemKind::AgentRunCompleted(_)
        | ThreadItemKind::SettingsChanged(_) => return None,
    };
    let has_trace_shape = payload.get("eventName").is_some()
        || payload.get("event_name").is_some()
        || payload.get("schemaVersion").is_some()
        || payload.get("schema_version").is_some();
    if has_trace_shape {
        return Some(payload.clone());
    }
    fallback_event_name.map(|event_name| {
        serde_json::json!({
            "eventName": event_name,
            "payload": payload,
        })
    })
}

fn runtime_event_from_thread_item(
    item: &ThreadItem,
    session_id: &str,
    run_id: &str,
) -> Option<AgentRuntimeEventEnvelope> {
    let event = trace_event_from_thread_item(item)?;
    if let Ok(envelope) = serde_json::from_value::<AgentRuntimeEventEnvelope>(event.clone()) {
        return Some(envelope);
    }
    let event_name = event
        .get("eventName")
        .or_else(|| event.get("event_name"))
        .and_then(Value::as_str)?
        .to_string();
    let payload = event
        .get("payload")
        .cloned()
        .unwrap_or_else(|| event.clone());
    let item_id = event
        .get("itemId")
        .or_else(|| event.get("item_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| legacy_trace_item_id(&event_name, &payload))
        .or_else(|| Some(item.item_id.clone()));
    let sequence = event
        .get("sequence")
        .and_then(Value::as_u64)
        .unwrap_or(item.sequence);
    let timestamp = event
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| item.created_at.clone());
    Some(AgentRuntimeEventEnvelope::from_legacy_native_event(
        LegacyNativeAgentEventEnvelopeInput {
            session_id: event
                .get("sessionId")
                .or_else(|| event.get("session_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| session_id.to_string()),
            thread_id: event
                .get("threadId")
                .or_else(|| event.get("thread_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| Some(item.thread_id.clone())),
            turn_id: item
                .turn_id
                .clone()
                .or_else(|| item.run_id.clone())
                .unwrap_or_else(|| run_id.to_string()),
            parent_turn_id: event
                .get("parentTurnId")
                .or_else(|| event.get("parent_turn_id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            item_id,
            event_name,
            sequence,
            timestamp,
            payload,
        },
    ))
}

pub(super) fn runtime_events_from_thread_items(
    items: &[ThreadItem],
    session_id: &str,
    run_id: &str,
) -> Vec<AgentRuntimeEventEnvelope> {
    items
        .iter()
        .filter(|item| item.run_id.as_deref() == Some(run_id))
        .filter_map(|item| runtime_event_from_thread_item(item, session_id, run_id))
        .collect()
}

pub(super) fn turn_items_from_thread_items(
    items: &[ThreadItem],
    session_id: &str,
    run_id: &str,
) -> Vec<AgentTurnItem> {
    let runtime_events = runtime_events_from_thread_items(items, session_id, run_id);
    project_turn_items_from_trace_events(&runtime_events)
}

fn legacy_trace_item_id(event_name: &str, payload: &Value) -> Option<String> {
    match event_name {
        "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" => {
            string_from_trace_payload(payload, &["toolCallId", "tool_call_id"])
        }
        "agent.awaiting_approval" | "agent.approval.decision" => {
            string_from_trace_payload(payload, &["approvalId", "approval_id"])
        }
        "agent.awaiting_form" | "agent.form.resolution" => {
            string_from_trace_payload(payload, &["formId", "form_id"])
        }
        event_name if event_name.starts_with("agent.delegate.") => {
            string_from_trace_payload(payload, &["delegateId", "subagentId", "delegate_id"])
        }
        _ => None,
    }
}

fn string_from_trace_payload(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}
