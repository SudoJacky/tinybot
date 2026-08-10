use super::{runtime_events_from_thread_items, turn_items_from_thread_items};
use crate::agent::runtime_protocol::{
    AgentRuntimeEventVisibility, AgentTurnItemData, AgentTurnItemKind,
};
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
                "tinybot_result": {
                    "path": "README.md",
                    "contents": "README contents"
                },
            })),
        ),
    ];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(
        events[1].payload,
        json!({
            "toolCallId": "call-1",
            "result": {
                "path": "README.md",
                "contents": "README contents"
            },
        })
    );

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].summary, None);
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::ToolCall { name, args, result, .. }
            if name == "workspace.read_file"
                && args == "{\"path\":\"README.md\"}"
                && result == &json!({
                    "path": "README.md",
                    "contents": "README contents"
                })
    ));
}

#[test]
fn failed_tool_output_preserves_its_result_status() {
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
            "call-data-view",
            1,
            ThreadItemKind::ToolCallStarted(json!({
                "type": "function_call",
                "call_id": "call-data-view",
                "name": "publish_data_view",
                "arguments": "{}",
            })),
        ),
        item(
            "tool-output:call-data-view",
            2,
            ThreadItemKind::ToolCallOutput(json!({
                "type": "function_call_output",
                "call_id": "call-data-view",
                "status": "error",
                "output": "publish_data_view cannot be mixed with other tools",
            })),
        ),
    ];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(events[1].payload["resultStatus"], "error");

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::ToolCall { result_status, .. }
            if result_status.as_deref() == Some("error")
    ));
}

#[test]
fn artifact_tool_output_replays_the_persisted_envelope() {
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
            "call-data-view",
            1,
            ThreadItemKind::ToolCallStarted(json!({
                "type": "custom_tool_call",
                "call_id": "call-data-view",
                "name": "publish_data_view",
                "input": "{}",
            })),
        ),
        item(
            "tool-output:call-data-view",
            2,
            ThreadItemKind::ToolCallOutput(json!({
                "type": "custom_tool_call_output",
                "call_id": "call-data-view",
                "output": "Published data view dv_1.",
                "tinybot_result": {
                    "status": "ok",
                    "summary": "Published data view: Revenue",
                    "artifacts": [{
                        "id": "dv_1",
                        "kind": "data_view",
                        "content": { "schemaVersion": "tinybot.data_view.v1" }
                    }]
                }
            })),
        ),
    ];

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");

    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::ToolCall { result, .. }
            if result["artifacts"][0]["id"] == "dv_1"
                && result["artifacts"][0]["content"]["schemaVersion"] == "tinybot.data_view.v1"
    ));
}

#[test]
fn responses_raw_reasoning_stays_hidden_and_tool_output_gets_a_display_summary() {
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
            "reasoning-1",
            1,
            ThreadItemKind::Reasoning(json!({
                "type": "reasoning",
                "id": "reasoning-1",
                "summary": [],
                "content": [{
                    "type": "reasoning_text",
                    "text": "Private provider chain of thought.",
                }],
            })),
        ),
        item(
            "tool-call-1",
            2,
            ThreadItemKind::ToolCallStarted(json!({
                "type": "function_call",
                "id": "tool-call-1",
                "call_id": "call-1",
                "name": "exec_command",
                "arguments": "{\"command\":\"dir /b\"}",
            })),
        ),
        item(
            "tool-output-1",
            3,
            ThreadItemKind::ToolCallOutput(json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "{\"chunks\":[{\"content\":\"reply.json\",\"sequence\":1,\"stream\":\"stdout\"}],\"output\":\"reply.json\\r\\n\",\"stdout\":\"reply.json\\r\\n\",\"stderr\":\"\",\"exitCode\":0}",
            })),
        ),
    ];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");
    let reasoning = events
        .iter()
        .find(|event| event.event_name == "agent.reasoning.completed")
        .expect("reasoning remains available in the runtime trace");
    assert_eq!(reasoning.visibility, AgentRuntimeEventVisibility::Debug);
    assert_eq!(reasoning.payload["summary"], "");

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].kind, AgentTurnItemKind::ToolCall);
    assert_eq!(projected[0].summary.as_deref(), Some("reply.json"));
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::ToolCall { name, result, .. }
            if name == "exec_command"
                && result["stdout"] == "reply.json\r\n"
                && result["exitCode"] == 0
    ));
}

#[test]
fn typed_completed_records_replay_without_stream_deltas_or_user_reasoning() {
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

    assert_eq!(projected.len(), 1);
    assert!(matches!(
        &projected[0],
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

#[test]
fn persisted_context_compaction_replays_after_session_reload() {
    let items = vec![ThreadItem {
        item_id: "thread-runtime:thread-1:turn-compact:event-id:compact-1".to_string(),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-compact".to_string(),
        parent_item_id: None,
        sequence: 7,
        created_at: "2026-08-03T12:00:00Z".to_string(),
        kind: ThreadItemKind::ContextCompaction(json!({
            "itemId": "context-1",
            "eventId": "compact-1",
            "sequence": 7,
            "timestamp": "2026-08-03T12:00:00Z",
            "eventName": "agent.context.compacted",
            "turnId": "turn-compact",
            "source": "rust_backend",
            "visibility": "user",
            "payload": {
                "summary": "Compacted conversation history",
                "droppedMessageCount": 12,
                "contextWindowTokens": 128000,
                "strategy": "compact",
                "estimatedTokensBefore": 12000,
                "estimatedTokensAfter": 4200
            }
        })),
    }];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-compact");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name, "agent.context.compacted");

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-compact");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].kind, AgentTurnItemKind::ContextCompaction);
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::ContextCompaction {
            dropped_item_count: 12,
            estimated_tokens_before: Some(12000),
            estimated_tokens_after: Some(4200),
            ..
        }
    ));
    let projected_data = serde_json::to_value(&projected[0].data).unwrap();
    assert_eq!(projected_data["contextWindowTokens"], 128000);
    assert_eq!(projected_data["strategy"], "compact");
}

#[test]
fn persisted_usage_restores_context_window_after_session_reload() {
    let items = vec![ThreadItem {
        item_id: "thread-runtime:thread-1:turn-1:event-id:usage-1".to_string(),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        parent_item_id: None,
        sequence: 8,
        created_at: "2026-08-03T12:00:01Z".to_string(),
        kind: ThreadItemKind::Event(json!({
            "itemId": "usage-1",
            "eventId": "usage-event-1",
            "sequence": 8,
            "timestamp": "2026-08-03T12:00:01Z",
            "eventName": "agent.usage",
            "turnId": "turn-1",
            "source": "provider",
            "visibility": "debug",
            "payload": {
                "inputTokens": 100,
                "outputTokens": 25,
                "totalTokens": 125,
                "contextWindowRemainingTokens": 127875,
                "contextWindowTokens": 128000,
                "contextWindowUsedTokens": 125,
                "percent": 0.09765625
            }
        })),
    }];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name, "agent.usage");

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].kind, AgentTurnItemKind::Usage);
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::Usage { provider_payload, .. }
            if provider_payload["contextWindowTokens"] == 128000
                && provider_payload["contextWindowUsedTokens"] == 125
    ));
}

#[test]
fn unrelated_domain_events_are_not_projected_as_agent_context_state() {
    let items = vec![ThreadItem {
        item_id: "thread-runtime:thread-1:turn-1:event-id:continue-1".to_string(),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        parent_item_id: None,
        sequence: 9,
        created_at: "2026-08-03T12:00:02Z".to_string(),
        kind: ThreadItemKind::Event(json!({
            "eventName": "thread.continue_turn",
            "payload": { "message": "continue" }
        })),
    }];

    assert!(runtime_events_from_thread_items(&items, "thread-1", "turn-1").is_empty());
    assert!(turn_items_from_thread_items(&items, "thread-1", "turn-1").is_empty());
}
