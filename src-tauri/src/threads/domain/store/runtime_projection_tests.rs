use super::{runtime_events_from_thread_items, turn_items_from_thread_items};
use crate::agent::runtime_protocol::{AgentTurnItemData, AgentTurnItemKind};
use crate::threads::domain::types::{ThreadItem, ThreadItemKind};
use serde_json::json;

#[test]
fn typed_record_uses_rollout_identity_sequence_and_timestamp() {
    let items = vec![ThreadItem {
        item_id: "rollout-item-99".to_string(),
        thread_id: "canonical-thread".to_string(),
        turn_id: "canonical-turn".to_string(),
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

    let events = runtime_events_from_thread_items(&items, "canonical-session", "canonical-turn");

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].sequence, 99);
    assert_eq!(events[0].timestamp, "2026-07-20T00:00:99Z");
    assert_eq!(events[0].session_id, "canonical-session");
    assert_eq!(events[0].thread_id.as_deref(), Some("canonical-thread"));
    assert_eq!(events[0].turn_id, "canonical-turn");
}

#[test]
fn slim_tool_output_replays_through_the_tool_call_item() {
    let item = |item_id: &str, sequence: u64, kind: ThreadItemKind| ThreadItem {
        item_id: item_id.to_string(),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
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

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(
        events[1].payload,
        json!({
            "toolCallId": "call-1",
            "content": "README contents",
        })
    );

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
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
        turn_id: "turn-1".to_string(),
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

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|event| !matches!(
        event.event_name.as_str(),
        "agent.delta" | "agent.reasoning_delta"
    )));
    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");

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

#[test]
fn legacy_subagent_messages_receive_canonical_identity_without_merging_lifecycle_items() {
    let item = |item_id: &str, sequence: u64, kind: ThreadItemKind| ThreadItem {
        item_id: item_id.to_string(),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        parent_item_id: None,
        sequence,
        created_at: sequence.to_string(),
        kind,
    };
    let items = vec![
        item(
            "subagent-spawned-1",
            1,
            ThreadItemKind::SubagentSpawned(json!({
                "subagentId": "delegate-1",
                "status": "running",
            })),
        ),
        item(
            "subagent-message-1",
            2,
            ThreadItemKind::SubagentMessage(json!({
                "subagentId": "delegate-1",
                "content": "Research complete.",
            })),
        ),
        item(
            "subagent-completed-1",
            3,
            ThreadItemKind::SubagentCompleted(json!({
                "subagentId": "delegate-1",
                "status": "completed",
            })),
        ),
    ];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(events[1].item_id.as_deref(), Some("subagent-message-1"));
    assert_eq!(events[1].payload["agentId"], "delegate-1");
    assert_eq!(events[1].payload["messageId"], "subagent-message-1");

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(projected.len(), 2);
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::SubagentLifecycle { agent_id, .. } if agent_id == "delegate-1"
    ));
    assert!(matches!(
        &projected[1].data,
        AgentTurnItemData::SubagentMessage {
            agent_id,
            message_id,
            content,
            ..
        } if agent_id == "delegate-1"
            && message_id == "subagent-message-1"
            && content == "Research complete."
    ));
}
