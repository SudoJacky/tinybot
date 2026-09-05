use super::{runtime_events_from_thread_items, turn_items_from_thread_items};
use crate::agent::runtime_protocol::{
    AgentRuntimeEventVisibility, AgentTurnItemData, AgentTurnItemKind, AgentTurnItemStatus,
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
fn persisted_runtime_events_replay_in_canonical_sequence_order() {
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
            "tool-output:call-1",
            1,
            ThreadItemKind::ToolCallOutput(json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "status": "error",
                "output": "invalid arguments",
                "sequence": 9,
                "timestamp": "2026-08-14T10:00:00.009Z",
            })),
        ),
        item(
            "event:call-1",
            2,
            ThreadItemKind::Event(json!({
                "eventName": "agent.tool_call.delta",
                "itemId": "call-1",
                "sequence": 8,
                "timestamp": "2026-08-14T10:00:00.008Z",
                "payload": {
                    "toolCallId": "call-1",
                    "toolName": "workspace.write_file",
                    "argumentsDelta": "{not json",
                },
            })),
        ),
    ];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");

    assert_eq!(
        events
            .iter()
            .map(|event| (event.event_name.as_str(), event.sequence))
            .collect::<Vec<_>>(),
        vec![("agent.tool_call.delta", 8), ("agent.tool.result", 9)],
    );
    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].status, AgentTurnItemStatus::Completed);
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::ToolCall { result_status, .. }
            if result_status.as_deref() == Some("error")
    ));
}

#[test]
fn persisted_runtime_events_follow_rollout_time_across_sparse_source_sequences() {
    let item = |item_id: &str, sequence: u64, created_at: &str, kind: ThreadItemKind| ThreadItem {
        item_id: item_id.to_string(),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        parent_item_id: None,
        sequence,
        created_at: created_at.to_string(),
        kind,
    };
    // A reloaded Rollout is stored by Thread item sequence. Sparse runtime
    // sequences can therefore place a later semantic event before the assistant
    // message that preceded it in the append-only log.
    let items = vec![
        item(
            "event:call-1",
            13,
            "2026-08-31T07:17:22.496Z",
            ThreadItemKind::Event(json!({
                "eventName": "agent.tool_call.delta",
                "itemId": "call-1",
                "sequence": 35,
                "timestamp": "1788160642495",
                "payload": {
                    "toolCallId": "call-1",
                    "toolName": "update_plan",
                    "argumentsDelta": "{}",
                },
            })),
        ),
        item(
            "tool-output:call-1",
            14,
            "2026-08-31T07:17:22.514Z",
            ThreadItemKind::ToolCallOutput(json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "status": "ok",
                "output": "Plan updated",
                "threadItemSequence": 39,
                "timestamp": "1788160642513",
            })),
        ),
        item(
            "assistant-1",
            32,
            "2026-08-31T07:17:22.478Z",
            ThreadItemKind::AssistantMessageCompleted(json!({
                "type": "message",
                "id": "assistant-1",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "I will make a plan." }],
                "phase": "commentary",
                "modelCallId": "provider-1",
                "threadItemSequence": 32,
                "timestamp": "1788160642477",
            })),
        ),
    ];

    let events = runtime_events_from_thread_items(&items, "thread-1", "turn-1");

    assert_eq!(
        events
            .iter()
            .map(|event| (event.event_name.as_str(), event.sequence))
            .collect::<Vec<_>>(),
        vec![
            ("agent.message.completed", 32),
            ("agent.tool_call.delta", 35),
            ("agent.tool.result", 39),
        ],
    );
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
fn responses_raw_reasoning_reloads_into_the_timeline_and_tool_output_gets_a_display_summary() {
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
    assert_eq!(reasoning.visibility, AgentRuntimeEventVisibility::User);
    assert_eq!(
        reasoning.payload["summary"],
        "Private provider chain of thought."
    );

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(projected.len(), 2);
    assert_eq!(projected[0].kind, AgentTurnItemKind::Reasoning);
    assert!(matches!(
        &projected[0].data,
        AgentTurnItemData::Reasoning { summary, .. }
            if summary == "Private provider chain of thought."
    ));
    assert_eq!(projected[1].kind, AgentTurnItemKind::ToolCall);
    assert_eq!(projected[1].summary.as_deref(), Some("reply.json"));
    assert!(matches!(
        &projected[1].data,
        AgentTurnItemData::ToolCall { name, result, .. }
            if name == "exec_command"
                && result["stdout"] == "reply.json\r\n"
                && result["exitCode"] == 0
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
        sequence: 2,
        created_at: "2026-08-03T12:00:01Z".to_string(),
        kind: ThreadItemKind::Event(json!({
            "itemId": "usage-1",
            "eventId": "usage-event-1",
            "sequence": 23,
            "timestamp": "1786673534920",
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
    assert_eq!(events[0].sequence, 23);
    assert_eq!(events[0].timestamp, "1786673534920");

    let projected = turn_items_from_thread_items(&items, "thread-1", "turn-1");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].kind, AgentTurnItemKind::Usage);
    assert_eq!(projected[0].sequence, 23);
    assert_eq!(projected[0].created_at, "1786673534920");
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

#[test]
fn persisted_typed_usage_retains_model_timing_on_reload() {
    let timing =
        json!({ "modelCallId": "call-1", "timeToFirstTokenMs": 600, "decodeDurationMs": 2000 });
    let item = ThreadItem {
        item_id: "usage-1".to_string(),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        parent_item_id: None,
        sequence: 2,
        created_at: "1786673534920".to_string(),
        kind: ThreadItemKind::Event(json!({
            "eventName": "agent.usage", "sequence": 2, "timestamp": "1786673534920",
            "source": "provider", "visibility": "debug", "turnId": "turn-1", "itemId": "usage-1",
            "payload": {"agentItem": {"type": "usage", "id": "usage-1", "inputTokens": 100,
                "outputTokens": 216, "totalTokens": 316, "providerPayload": {}, "modelTiming": timing }}
        })),
    };
    let restored: ThreadItem =
        serde_json::from_value(serde_json::to_value(&item).unwrap()).unwrap();
    let projected = turn_items_from_thread_items(&[restored], "thread-1", "turn-1");
    assert_eq!(projected.len(), 1);
    let data = serde_json::to_value(&projected[0].data).unwrap();
    assert_eq!(data["modelTiming"], timing);
    assert_eq!(data["outputTokens"], 216);
}
