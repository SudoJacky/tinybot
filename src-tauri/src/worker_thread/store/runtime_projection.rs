use crate::agent_loop_runtime_protocol::{
    project_turn_items_from_trace_events, AgentRuntimeEventEnvelope, AgentTurnItem,
    LegacyNativeAgentEventEnvelopeInput,
};
use crate::worker_thread::types::{ThreadItem, ThreadItemKind};
use serde_json::Value;
use std::collections::HashMap;

pub(super) fn trace_event_from_thread_item(item: &ThreadItem) -> Option<Value> {
    if let ThreadItemKind::Reasoning(value) = &item.kind {
        let has_trace_shape = value.get("eventName").is_some()
            || value.get("event_name").is_some()
            || value.get("schemaVersion").is_some()
            || value.get("schema_version").is_some();
        if has_trace_shape {
            return Some(value.clone());
        }
        let mut payload = value.as_object().cloned().unwrap_or_default();
        payload.insert(
            "delta".to_string(),
            Value::String(reasoning_response_text(value)),
        );
        return Some(serde_json::json!({
            "eventName": "agent.reasoning_delta",
            "payload": payload,
        }));
    }
    let (payload, fallback_event_name) = match &item.kind {
        ThreadItemKind::UserMessage(value) => (value, Some("agent.turn.started")),
        ThreadItemKind::AssistantMessageDelta(value) => (value, Some("agent.delta")),
        ThreadItemKind::AssistantMessageCompleted(value) => {
            (value, Some("agent.message.completed"))
        }
        ThreadItemKind::Reasoning(_) => unreachable!("reasoning items return above"),
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
        ThreadItemKind::AgentRunStarted(_)
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

pub(crate) fn runtime_events_from_thread_items(
    items: &[ThreadItem],
    session_id: &str,
    run_id: &str,
) -> Vec<AgentRuntimeEventEnvelope> {
    let mut events = items
        .iter()
        .filter(|item| item.run_id.as_deref() == Some(run_id))
        .filter_map(|item| runtime_event_from_thread_item(item, session_id, run_id))
        .collect::<Vec<_>>();
    normalize_interaction_resolution_order(&mut events);
    events
}

fn normalize_interaction_resolution_order(events: &mut [AgentRuntimeEventEnvelope]) {
    let mut positions = HashMap::<(String, String), Vec<usize>>::new();
    for (index, event) in events.iter().enumerate() {
        if let Some((kind, interaction_id, _)) = interaction_order_key(event) {
            positions
                .entry((kind.to_string(), interaction_id.to_string()))
                .or_default()
                .push(index);
        }
    }
    for indexes in positions.into_values() {
        let mut ordered = indexes
            .iter()
            .map(|index| events[*index].clone())
            .collect::<Vec<_>>();
        ordered.sort_by_key(|event| {
            interaction_order_key(event)
                .map(|(_, _, rank)| rank)
                .unwrap_or_default()
        });
        for (index, event) in indexes.into_iter().zip(ordered) {
            events[index] = event;
        }
    }
}

fn interaction_order_key(event: &AgentRuntimeEventEnvelope) -> Option<(&str, &str, u8)> {
    let (kind, id_keys, rank) = match event.event_name.as_str() {
        "agent.awaiting_approval" => ("approval", &["approvalId", "approval_id"][..], 0),
        "agent.approval.decision" => ("approval", &["approvalId", "approval_id"][..], 1),
        "agent.awaiting_form" => ("form", &["formId", "form_id"][..], 0),
        "agent.form.resolution" => ("form", &["formId", "form_id"][..], 1),
        _ => return None,
    };
    id_keys.iter().find_map(|key| {
        event
            .payload
            .get(*key)
            .and_then(Value::as_str)
            .map(|interaction_id| (kind, interaction_id, rank))
    })
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
        "agent.delta"
        | "agent.message.phase"
        | "agent.message.classified"
        | "agent.message.completed" => {
            string_from_trace_payload(payload, &["messageId", "message_id"]).or_else(|| {
                prefixed_string_from_trace_payload(
                    payload,
                    "assistant",
                    &["modelCallId", "model_call_id"],
                )
            })
        }
        "agent.reasoning_delta" => {
            string_from_trace_payload(payload, &["reasoningId", "reasoning_id"]).or_else(|| {
                prefixed_string_from_trace_payload(
                    payload,
                    "reasoning",
                    &["modelCallId", "model_call_id"],
                )
            })
        }
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

fn prefixed_string_from_trace_payload(
    payload: &Value,
    prefix: &str,
    keys: &[&str],
) -> Option<String> {
    string_from_trace_payload(payload, keys).map(|value| format!("{prefix}:{value}"))
}

#[cfg(test)]
mod tests {
    use super::{runtime_events_from_thread_items, turn_items_from_thread_items};
    use crate::agent_loop_runtime_protocol::{
        AgentTurnItemData, AgentTurnItemKind, AgentTurnItemStatus,
    };
    use crate::worker_thread::types::{ThreadItem, ThreadItemKind};
    use serde_json::{json, Value};

    fn approval_item(
        item_id: &str,
        sequence: u64,
        event_name: &str,
        approval_id: &str,
    ) -> ThreadItem {
        ThreadItem {
            item_id: item_id.to_string(),
            thread_id: "thread-1".to_string(),
            run_id: Some("run-1".to_string()),
            turn_id: Some("run-1".to_string()),
            parent_item_id: None,
            sequence,
            created_at: sequence.to_string(),
            kind: ThreadItemKind::Event(json!({
                "eventName": event_name,
                "payload": {
                    "approvalId": approval_id,
                    "status": if event_name == "agent.approval.decision" {
                        "completed"
                    } else {
                        "waiting"
                    }
                }
            })),
        }
    }

    #[test]
    fn persisted_approval_resolution_is_replayed_after_its_request() {
        let approval_id = "approval:run-1:call-1";
        let items = vec![
            approval_item(
                "thread-runtime:thread-1:run-1:event:1",
                1,
                "agent.approval.decision",
                approval_id,
            ),
            approval_item(
                "thread-runtime:thread-1:run-1:event:209",
                209,
                "agent.awaiting_approval",
                approval_id,
            ),
        ];

        let events = runtime_events_from_thread_items(&items, "thread-1", "run-1");
        assert_eq!(events[0].event_name, "agent.awaiting_approval");
        assert_eq!(events[1].event_name, "agent.approval.decision");
        let projected = turn_items_from_thread_items(&items, "thread-1", "run-1");
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].status, AgentTurnItemStatus::Completed);
    }

    #[test]
    fn persisted_stream_chunks_replay_as_one_reasoning_and_one_assistant_item() {
        let persisted_event =
            |item_id: &str, sequence: u64, event_name: &str, payload: Value| ThreadItem {
                item_id: item_id.to_string(),
                thread_id: "thread-1".to_string(),
                run_id: Some("run-1".to_string()),
                turn_id: Some("run-1".to_string()),
                parent_item_id: None,
                sequence,
                created_at: sequence.to_string(),
                kind: ThreadItemKind::Event(json!({
                    "eventId": format!("event-{sequence}"),
                    "eventName": event_name,
                    "payload": payload,
                    "sequence": sequence,
                    "timestamp": sequence.to_string(),
                })),
            };
        let items = vec![
            persisted_event(
                "thread-runtime:thread-1:run-1:event-id:event-1",
                1,
                "agent.reasoning_delta",
                json!({
                    "delta": "Inspect ",
                    "modelCallId": "provider-1",
                    "reasoningId": "reasoning-1",
                }),
            ),
            persisted_event(
                "thread-runtime:thread-1:run-1:event-id:event-2",
                2,
                "agent.reasoning_delta",
                json!({
                    "delta": "first.",
                    "modelCallId": "provider-1",
                    "reasoningId": "reasoning-1",
                }),
            ),
            persisted_event(
                "thread-runtime:thread-1:run-1:event-id:event-3",
                3,
                "agent.delta",
                json!({
                    "delta": "Hello ",
                    "messageId": "assistant-1",
                    "messagePhase": "final_answer",
                    "modelCallId": "provider-1",
                }),
            ),
            persisted_event(
                "thread-runtime:thread-1:run-1:event-id:event-4",
                4,
                "agent.delta",
                json!({
                    "delta": "world.",
                    "messageId": "assistant-1",
                    "messagePhase": "final_answer",
                    "modelCallId": "provider-1",
                }),
            ),
        ];

        let projected = turn_items_from_thread_items(&items, "thread-1", "run-1");

        assert_eq!(projected.len(), 2);
        assert!(matches!(
            &projected[0],
            item if item.kind == AgentTurnItemKind::Reasoning
                && matches!(&item.data, AgentTurnItemData::Reasoning { summary, .. } if summary == "Inspect first.")
        ));
        assert!(matches!(
            &projected[1],
            item if item.kind == AgentTurnItemKind::AssistantMessage
                && matches!(&item.data, AgentTurnItemData::AssistantMessage { content, .. } if content == "Hello world.")
        ));
    }
}
