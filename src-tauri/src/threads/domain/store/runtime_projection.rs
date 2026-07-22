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
        | ThreadItemKind::AgentRunStarted(_)
        | ThreadItemKind::AgentRunStep(_)
        | ThreadItemKind::AgentRunCompleted(_)
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
    run_id: &str,
) -> Option<AgentRuntimeEventEnvelope> {
    let (event_name, payload) = semantic_event_from_thread_item(item)?;
    let item_id = semantic_item_id(item);
    Some(AgentRuntimeEventEnvelope::from_legacy_native_event(
        LegacyNativeAgentEventEnvelopeInput {
            session_id: session_id.to_string(),
            thread_id: Some(item.thread_id.clone()),
            turn_id: item
                .turn_id
                .clone()
                .or_else(|| item.run_id.clone())
                .unwrap_or_else(|| run_id.to_string()),
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

#[cfg(test)]
mod tests {
    use super::{runtime_events_from_thread_items, turn_items_from_thread_items};
    use crate::agent::runtime_protocol::{AgentTurnItemData, AgentTurnItemKind};
    use crate::threads::domain::types::{ThreadItem, ThreadItemKind};
    use serde_json::json;

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
            kind: if event_name == "agent.approval.decision" {
                ThreadItemKind::ApprovalResolved(json!({
                    "approvalId": approval_id,
                    "status": "completed",
                }))
            } else {
                ThreadItemKind::ApprovalRequested(json!({
                    "approvalId": approval_id,
                    "status": "waiting",
                }))
            },
        }
    }

    #[test]
    fn persisted_approval_order_follows_rollout_order() {
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
        assert_eq!(events[0].event_name, "agent.approval.decision");
        assert_eq!(events[1].event_name, "agent.awaiting_approval");
        assert_eq!(events[0].sequence, 1);
        assert_eq!(events[1].sequence, 209);
    }

    #[test]
    fn typed_record_uses_rollout_identity_sequence_and_timestamp() {
        let items = vec![ThreadItem {
            item_id: "rollout-item-99".to_string(),
            thread_id: "canonical-thread".to_string(),
            run_id: Some("canonical-run".to_string()),
            turn_id: Some("canonical-run".to_string()),
            parent_item_id: None,
            sequence: 99,
            created_at: "2026-07-20T00:00:99Z".to_string(),
            kind: ThreadItemKind::AssistantMessageCompleted(json!({
                "type": "message",
                "id": "assistant-1",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Done." }],
            })),
        }];

        let events = runtime_events_from_thread_items(&items, "canonical-session", "canonical-run");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].sequence, 99);
        assert_eq!(events[0].timestamp, "2026-07-20T00:00:99Z");
        assert_eq!(events[0].session_id, "canonical-session");
        assert_eq!(events[0].thread_id.as_deref(), Some("canonical-thread"));
        assert_eq!(events[0].turn_id, "canonical-run");
    }

    #[test]
    fn slim_tool_output_replays_through_the_tool_call_item() {
        let item = |item_id: &str, sequence: u64, kind: ThreadItemKind| ThreadItem {
            item_id: item_id.to_string(),
            thread_id: "thread-1".to_string(),
            run_id: Some("run-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            parent_item_id: None,
            sequence,
            created_at: sequence.to_string(),
            kind,
        };
        let items = vec![
            item(
                "call-1",
                1,
                ThreadItemKind::ToolCallStarted(json!({
                    "type": "custom_tool_call",
                    "id": "call-1",
                    "call_id": "call-1",
                    "name": "workspace.read_file",
                    "input": "{\"path\":\"README.md\"}",
                })),
            ),
            item(
                "tool-output:call-1",
                2,
                ThreadItemKind::ToolCallOutput(json!({
                    "type": "custom_tool_call_output",
                    "id": "tool-output:call-1",
                    "call_id": "call-1",
                    "output": "README contents",
                })),
            ),
        ];

        let events = runtime_events_from_thread_items(&items, "thread-1", "run-1");
        assert_eq!(
            events[1].payload,
            json!({
                "toolCallId": "call-1",
                "content": "README contents",
            })
        );

        let projected = turn_items_from_thread_items(&items, "thread-1", "run-1");
        assert_eq!(projected.len(), 1);
        assert!(matches!(
            &projected[0].data,
            AgentTurnItemData::ToolCall { name, args, result, .. }
                if name == "workspace.read_file"
                    && args == "{\"path\":\"README.md\"}"
                    && result == "README contents"
        ));
    }

    #[test]
    fn typed_completed_records_replay_without_stream_deltas() {
        let persisted_item = |item_id: &str, sequence: u64, kind: ThreadItemKind| ThreadItem {
            item_id: item_id.to_string(),
            thread_id: "thread-1".to_string(),
            run_id: Some("run-1".to_string()),
            turn_id: Some("run-1".to_string()),
            parent_item_id: None,
            sequence,
            created_at: sequence.to_string(),
            kind,
        };
        let items = vec![
            persisted_item(
                "reasoning-1",
                1,
                ThreadItemKind::Reasoning(json!({
                    "type": "reasoning",
                    "summary": [{ "type": "summary_text", "text": "Inspect first." }],
                    "modelCallId": "provider-1",
                    "reasoningId": "reasoning-1",
                })),
            ),
            persisted_item(
                "assistant-1",
                2,
                ThreadItemKind::AssistantMessageCompleted(json!({
                    "type": "message",
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Hello world." }],
                    "phase": "final_answer",
                })),
            ),
        ];

        let events = runtime_events_from_thread_items(&items, "thread-1", "run-1");
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| !matches!(
            event.event_name.as_str(),
            "agent.delta" | "agent.reasoning_delta"
        )));
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
