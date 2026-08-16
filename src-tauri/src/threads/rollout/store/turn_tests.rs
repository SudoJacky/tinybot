use super::{
    completed_tool_result_from_response_item, response_item_from_runtime_event,
    response_items_from_runtime_event,
};
use crate::agent::runtime_protocol::{project_timeline_snapshot, AgentRuntimeEventEnvelope};
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::threads::rollout::format::SessionApiMode;
use crate::threads::rollout::store::{
    read_thread_lines, EventKind, ThreadLogItem, WorkerThreadLogRpc,
};
use crate::threads::turn::{AgentTurnRecord, AgentTurnStatus};
use serde_json::json;

#[test]
fn runtime_tool_events_materialize_a_complete_model_visible_pair() {
    let call = response_item_from_runtime_event(&json!({
        "eventName": "agent.tool_call.delta",
        "payload": {
            "toolCallId": "call-1",
            "toolName": "workspace.read_file",
            "argumentsDelta": "{\"path\":\"README.md\"}"
        }
    }))
    .unwrap();
    let result = response_item_from_runtime_event(&json!({
        "eventId": "event-result-1",
        "eventName": "agent.tool.result",
        "payload": {
            "toolCallId": "call-1",
            "toolName": "workspace.read_file",
            "resultStatus": "ok",
            "content": "contents",
            "summary": "contents",
            "envelope": {
                "summary": "contents",
                "modelContent": "contents",
                "raw": {
                    "content": "contents",
                    "result": { "path": "README.md", "contents": "contents" }
                }
            }
        }
    }))
    .unwrap();

    assert_eq!(call["type"], "custom_tool_call");
    assert_eq!(call["call_id"], "call-1");
    assert_eq!(call["input"], "{\"path\":\"README.md\"}");
    assert_eq!(
        result,
        json!({
            "type": "custom_tool_call_output",
            "id": "tool-output:call-1",
            "call_id": "call-1",
            "tool_name": "workspace.read_file",
            "status": "ok",
            "output": "contents",
            "tinybot_result": {
                "content": "contents",
                "result": { "path": "README.md", "contents": "contents" }
            },
        })
    );
}

#[test]
fn artifact_tool_results_keep_the_envelope_in_the_native_replay_sidecar() {
    let result = response_item_from_runtime_event(&json!({
        "eventId": "event-data-view",
        "eventName": "agent.tool.result",
        "payload": {
            "toolCallId": "call-data-view",
            "toolName": "publish_data_view",
            "resultStatus": "ok",
            "content": "Published data view dv_1 as an immutable inline chat artifact.",
            "envelope": {
                "status": "ok",
                "summary": "Published data view: Revenue",
                "modelContent": "Published data view dv_1 as an immutable inline chat artifact.",
                "structured": { "kind": "data_view_published", "artifactId": "dv_1" },
                "artifacts": [{
                    "id": "dv_1",
                    "kind": "data_view",
                    "content": { "schemaVersion": "tinybot.data_view.v1" }
                }],
                "raw": { "artifactId": "dv_1" }
            }
        }
    }))
    .expect("artifact tool result should project");

    assert_eq!(result["tinybot_result"]["status"], "ok");
    assert_eq!(
        result["tinybot_result"]["artifacts"][0]["content"]["schemaVersion"],
        "tinybot.data_view.v1"
    );
    assert_eq!(
        result["output"],
        "Published data view dv_1 as an immutable inline chat artifact."
    );
}

#[test]
fn responses_events_keep_native_output_and_encode_function_results() {
    let output = response_items_from_runtime_event(
        &json!({
            "eventName": "agent.message.completed",
            "payload": {
                "responseItems": [
                    {
                        "type": "reasoning",
                        "id": "reasoning-1",
                        "summary": [],
                        "encrypted_content": "opaque"
                    },
                    {
                        "type": "message",
                        "id": "message-1",
                        "role": "assistant",
                        "phase": "final_answer",
                        "content": [{ "type": "output_text", "text": "done" }]
                    }
                ]
            }
        }),
        SessionApiMode::Responses,
    );
    let tool_result = response_items_from_runtime_event(
        &json!({
            "eventName": "agent.tool.result",
            "payload": {
                "toolCallId": "call-1",
                "toolName": "workspace.read_file",
                "resultStatus": "ok",
                "content": "contents",
                "result": { "path": "README.md", "contents": "contents" }
            }
        }),
        SessionApiMode::Responses,
    );

    assert_eq!(output.len(), 2);
    assert_eq!(output[0]["encrypted_content"], "opaque");
    assert_eq!(output[1]["phase"], "final_answer");
    assert_eq!(
        tool_result,
        vec![json!({
            "type": "function_call_output",
            "call_id": "call-1",
            "tool_name": "workspace.read_file",
            "status": "ok",
            "output": "contents",
            "tinybot_result": { "path": "README.md", "contents": "contents" },
        })]
    );
}

#[test]
fn existing_session_rejects_a_different_turn_api_mode() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-turn-api-mode-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );

    rpc.ensure_turn_thread(
        "session-pinned-responses",
        "2026-08-01T00:00:00Z",
        None,
        Some(SessionApiMode::Responses),
    )
    .unwrap();
    let error = rpc
        .ensure_turn_thread(
            "session-pinned-responses",
            "2026-08-01T00:01:00Z",
            None,
            Some(SessionApiMode::ChatCompletions),
        )
        .expect_err("an existing session must not switch API modes");

    assert!(error.message.contains("does not match its session"));
    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn shell_results_persist_only_the_canonical_model_output() {
    let model_output = serde_json::json!({
        "cursor": 1,
        "droppedBytes": 0,
        "exitCode": 0,
        "output": "listed.txt\r\n",
        "processId": "process-1",
        "running": false,
        "status": "exited",
        "truncated": false
    })
    .to_string();
    let items = response_items_from_runtime_event(
        &json!({
            "eventName": "agent.tool.result",
            "payload": {
                "toolCallId": "call-shell-1",
                "toolName": "exec_command",
                "resultStatus": "ok",
                "content": model_output,
                "envelope": {
                    "raw": {
                        "chunks": [
                            { "content": "listed.txt\r\n", "sequence": 1, "stream": "stdout" }
                        ],
                        "command": "dir /b",
                        "output": "listed.txt\r\n",
                        "processId": "process-1",
                        "stderr": "",
                        "stdout": "listed.txt\r\n",
                        "workingDir": "D:/workspace"
                    }
                }
            }
        }),
        SessionApiMode::Responses,
    );

    assert_eq!(items.len(), 1);
    assert!(items[0].get("tinybot_result").is_none());
    assert_eq!(items[0]["output"], model_output);
    let serialized = serde_json::to_string(&items[0]).expect("tool result should serialize");
    assert_eq!(serialized.matches("listed.txt").count(), 1);
    assert!(!serialized.contains("chunks"));
    assert!(!serialized.contains("stdout"));
}

#[test]
fn user_interruption_persists_an_interrupted_turn_aborted_boundary() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-user-interruption-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let session_id = "interrupted-session";
    let turn_id = "interrupted-turn";
    let timestamp = "2026-08-03T00:00:00Z";
    let thread = rpc
        .ensure_turn_thread(session_id, timestamp, None, Some(SessionApiMode::Responses))
        .unwrap();
    rpc.start_turn(
        AgentTurnRecord {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            thread_id: None,
            parent_thread_id: None,
            child_thread_ids: Vec::new(),
            status: AgentTurnStatus::Running,
            phase: "streaming_model".to_string(),
            started_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
            completed_at: None,
            stop_reason: None,
            model: "gpt-test".to_string(),
            provider: Some("openai".to_string()),
            max_iterations: 8,
            current_iteration: 1,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: None,
            instruction_diagnostics: Vec::new(),
            trace_context: None,
            error: None,
        },
        None,
        Vec::new(),
    )
    .unwrap();

    let interrupted = rpc
        .mark_turn_interrupted_terminal(session_id, turn_id, "Interrupted by user")
        .unwrap();

    assert_eq!(interrupted.status, AgentTurnStatus::Interrupted);
    assert_eq!(interrupted.phase, "interrupted");
    assert_eq!(interrupted.stop_reason.as_deref(), Some("interrupted"));
    let boundary = read_thread_lines(std::path::Path::new(&thread.thread_path))
        .unwrap()
        .into_iter()
        .find_map(|line| match line.item {
            ThreadLogItem::EventMsg(event) if *event.kind() == EventKind::TurnAborted => {
                Some(event.payload().clone())
            }
            _ => None,
        })
        .expect("interruption should append a turn_aborted boundary");
    assert_eq!(boundary["status"], "interrupted");
    assert_eq!(boundary["stopReason"], "interrupted");

    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn completed_standalone_compaction_runtime_state_keeps_the_turn_boundary() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-completed-compaction-runtime-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let session_id = "standalone-compaction-session";
    let turn_id = "standalone-compaction-turn";
    let timestamp = "2026-08-10T13:06:03Z";
    rpc.start_turn(
        AgentTurnRecord {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            thread_id: None,
            parent_thread_id: None,
            child_thread_ids: Vec::new(),
            status: AgentTurnStatus::Running,
            phase: "planning".to_string(),
            started_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
            completed_at: None,
            stop_reason: None,
            model: "gpt-test".to_string(),
            provider: Some("openai".to_string()),
            max_iterations: 1,
            current_iteration: 0,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: None,
            instruction_diagnostics: Vec::new(),
            trace_context: None,
            error: None,
        },
        None,
        Vec::new(),
    )
    .unwrap();
    rpc.append_turn_semantic_event(
        session_id,
        turn_id,
        json!({
            "eventId": "compact-1",
            "eventName": "agent.context.compacted",
            "itemId": "context-1",
            "sequence": 1,
            "timestamp": timestamp,
            "payload": {
                "agentItem": {
                    "type": "context_compaction",
                    "id": "context-1",
                    "summary": "compact",
                    "droppedItemCount": 1,
                    "estimatedTokensBefore": 2889,
                    "estimatedTokensAfter": 2627
                }
            }
        }),
    )
    .unwrap();
    rpc.mark_turn_completed(session_id, turn_id, "context_compacted", None, None)
        .unwrap();

    let runtime_state = rpc
        .get_turn_runtime_state(session_id, turn_id)
        .unwrap()
        .expect("completed standalone compaction should reload");
    let serialized = serde_json::to_value(&runtime_state).unwrap();

    assert_eq!(serialized["status"], "completed");
    assert!(serialized["completedAt"].as_str().is_some());
    assert_eq!(serialized["stopReason"], "context_compacted");
    assert_eq!(runtime_state.timeline.items.len(), 1);
    assert_eq!(serialized["timeline"]["items"][0]["status"], "running");

    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn persisted_usage_preserves_the_live_timeline_item_identity() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-usage-timeline-identity-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let session_id = "usage-timeline-session";
    let turn_id = "turn-usage";
    let started_at = "2026-08-14T02:12:10.469Z";
    rpc.start_turn(
        AgentTurnRecord {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            thread_id: None,
            parent_thread_id: None,
            child_thread_ids: Vec::new(),
            status: AgentTurnStatus::Running,
            phase: "calling_model".to_string(),
            started_at: started_at.to_string(),
            updated_at: started_at.to_string(),
            completed_at: None,
            stop_reason: None,
            model: "gpt-test".to_string(),
            provider: Some("openai".to_string()),
            max_iterations: 1,
            current_iteration: 0,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: None,
            instruction_diagnostics: Vec::new(),
            trace_context: None,
            error: None,
        },
        None,
        Vec::new(),
    )
    .unwrap();
    let live_event: AgentRuntimeEventEnvelope = serde_json::from_value(json!({
        "schemaVersion": "tinybot.agent_event.v1",
        "eventId": "turn-usage:agent-usage:23",
        "sequence": 23,
        "sessionId": session_id,
        "threadId": session_id,
        "turnId": turn_id,
        "itemId": "turn-usage:usage:0",
        "eventName": "agent.usage",
        "phase": "calling_model",
        "timestamp": "1786673534920",
        "source": "provider",
        "visibility": "debug",
        "payload": {
            "iteration": 0,
            "modelCallId": "turn-usage:provider:1",
            "usage": {
                "inputTokens": 4469,
                "outputTokens": 219,
                "totalTokens": 4688
            }
        }
    }))
    .unwrap();
    let live_timeline =
        project_timeline_snapshot(session_id, turn_id, std::slice::from_ref(&live_event)).unwrap();

    rpc.append_turn_semantic_event(
        session_id,
        turn_id,
        serde_json::to_value(&live_event).unwrap(),
    )
    .unwrap();
    let reloaded = rpc
        .get_turn_runtime_state(session_id, turn_id)
        .unwrap()
        .expect("persisted usage should reload");

    assert_eq!(reloaded.timeline.items, live_timeline.items);
    assert_eq!(
        reloaded.timeline.snapshot_revision,
        live_timeline.snapshot_revision
    );

    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn persisted_responses_tool_call_preserves_the_live_timeline_item_identity() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-tool-timeline-identity-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let session_id = "tool-timeline-session";
    let turn_id = "turn-tool";
    let started_at = "2026-08-14T04:40:01.936Z";
    rpc.ensure_turn_thread(
        session_id,
        started_at,
        None,
        Some(SessionApiMode::Responses),
    )
    .unwrap();
    rpc.start_turn(
        AgentTurnRecord {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            thread_id: None,
            parent_thread_id: None,
            child_thread_ids: Vec::new(),
            status: AgentTurnStatus::Running,
            phase: "calling_model".to_string(),
            started_at: started_at.to_string(),
            updated_at: started_at.to_string(),
            completed_at: None,
            stop_reason: None,
            model: "gpt-test".to_string(),
            provider: Some("openai".to_string()),
            max_iterations: 1,
            current_iteration: 0,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: None,
            instruction_diagnostics: Vec::new(),
            trace_context: None,
            error: None,
        },
        None,
        Vec::new(),
    )
    .unwrap();

    let classified_event: AgentRuntimeEventEnvelope = serde_json::from_value(json!({
        "schemaVersion": "tinybot.agent_event.v1",
        "eventId": "message-classified-1",
        "sequence": 0,
        "sessionId": session_id,
        "threadId": session_id,
        "turnId": turn_id,
        "itemId": "assistant-1",
        "eventName": "agent.message.classified",
        "phase": "completed",
        "timestamp": "1786682410223",
        "source": "provider",
        "visibility": "user",
        "payload": {
            "content": "",
            "messageId": "assistant-1",
            "messagePhase": "commentary",
            "responseItems": [{
                "type": "function_call",
                "id": "function-call-1",
                "call_id": "call-1",
                "name": "exec_command",
                "arguments": "{\"command\":\"dir\"}"
            }]
        }
    }))
    .unwrap();
    let call_event: AgentRuntimeEventEnvelope = serde_json::from_value(json!({
        "schemaVersion": "tinybot.agent_event.v1",
        "eventId": "tool-call-1",
        "sequence": 1,
        "sessionId": session_id,
        "threadId": session_id,
        "turnId": turn_id,
        "itemId": "call-1",
        "eventName": "agent.tool_call.delta",
        "phase": "tool_calling",
        "timestamp": "1786682410224",
        "source": "tool",
        "visibility": "user",
        "payload": {
            "toolCallId": "call-1",
            "toolName": "exec_command",
            "argumentsDelta": "{\"command\":\"dir\"}"
        }
    }))
    .unwrap();
    let result_event: AgentRuntimeEventEnvelope = serde_json::from_value(json!({
        "schemaVersion": "tinybot.agent_event.v1",
        "eventId": "tool-result-1",
        "sequence": 2,
        "sessionId": session_id,
        "threadId": session_id,
        "turnId": turn_id,
        "itemId": "call-1",
        "eventName": "agent.tool.result",
        "phase": "tool_running",
        "timestamp": "1786682412260",
        "source": "tool",
        "visibility": "user",
        "payload": {
            "toolCallId": "call-1",
            "toolName": "exec_command",
            "resultStatus": "ok",
            "result": { "exitCode": 0 },
            "summary": "completed"
        }
    }))
    .unwrap();
    let final_event: AgentRuntimeEventEnvelope = serde_json::from_value(json!({
        "schemaVersion": "tinybot.agent_event.v1",
        "eventId": "message-completed-1",
        "sequence": 90,
        "sessionId": session_id,
        "threadId": session_id,
        "turnId": turn_id,
        "itemId": "assistant-final",
        "eventName": "agent.message.completed",
        "phase": "completed",
        "timestamp": "1786682413260",
        "source": "provider",
        "visibility": "user",
        "payload": {
            "content": "Done.",
            "messageId": "assistant-final",
            "modelCallId": "call-final",
            "messagePhase": "final_answer",
            "responseItems": [{
                "type": "message",
                "id": "assistant-final",
                "role": "assistant",
                "modelCallId": "call-final",
                "phase": "final_answer",
                "content": [{ "type": "output_text", "text": "Done." }]
            }]
        }
    }))
    .unwrap();
    let live_timeline = project_timeline_snapshot(
        session_id,
        turn_id,
        &[
            classified_event.clone(),
            call_event.clone(),
            result_event.clone(),
            final_event.clone(),
        ],
    )
    .unwrap();

    for event in [&classified_event, &call_event, &result_event, &final_event] {
        rpc.append_turn_semantic_event(session_id, turn_id, serde_json::to_value(event).unwrap())
            .unwrap();
    }
    let reloaded = rpc
        .get_turn_runtime_state(session_id, turn_id)
        .unwrap()
        .expect("persisted tool call should reload");
    assert_eq!(
        live_timeline.snapshot_revision, reloaded.timeline.snapshot_revision,
        "tool-only provider responses must not create live-only assistant mutations"
    );
    assert_eq!(
        live_timeline
            .items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        reloaded
            .timeline
            .items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
    );
    let live_tool = live_timeline
        .items
        .iter()
        .find(|item| item.item_id == "call-1")
        .unwrap();
    let reloaded_tool = reloaded
        .timeline
        .items
        .iter()
        .find(|item| item.item_id == "call-1")
        .unwrap();

    assert_eq!(reloaded_tool.item_id, live_tool.item_id);
    assert_eq!(reloaded_tool.sequence, live_tool.sequence);
    assert_eq!(reloaded_tool.revision, live_tool.revision);
    assert_eq!(reloaded_tool.created_at, live_tool.created_at);
    assert_eq!(reloaded_tool.updated_at, live_tool.updated_at);
    assert_eq!(reloaded_tool.status, live_tool.status);
    let live_final = live_timeline
        .items
        .iter()
        .find(|item| item.item_id == "assistant-final")
        .unwrap();
    let reloaded_final = reloaded
        .timeline
        .items
        .iter()
        .find(|item| item.item_id == "assistant-final")
        .unwrap();
    assert_eq!(reloaded_final.item_id, live_final.item_id);
    assert_eq!(reloaded_final.sequence, live_final.sequence);
    assert_eq!(reloaded_final.revision, live_final.revision);
    assert_eq!(reloaded_final.created_at, live_final.created_at);
    assert_eq!(reloaded_final.status, live_final.status);
    assert_eq!(reloaded_final.data, live_final.data);

    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn responses_tool_call_delta_after_native_function_call_does_not_fail_persistence() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-responses-tool-call-delta-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let session_id = "responses-tool-call-session";
    let turn_id = "responses-tool-call-turn";
    let timestamp = "2026-08-02T04:01:42Z";

    let thread = rpc
        .ensure_turn_thread(session_id, timestamp, None, Some(SessionApiMode::Responses))
        .unwrap();
    rpc.start_turn(
        AgentTurnRecord {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            thread_id: None,
            parent_thread_id: None,
            child_thread_ids: Vec::new(),
            status: AgentTurnStatus::Running,
            phase: "planning".to_string(),
            started_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
            completed_at: None,
            stop_reason: None,
            model: "test-model".to_string(),
            provider: Some("openai".to_string()),
            max_iterations: 8,
            current_iteration: 0,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: None,
            instruction_diagnostics: Vec::new(),
            trace_context: None,
            error: None,
        },
        None,
        Vec::new(),
    )
    .unwrap();
    rpc.append_turn_semantic_event(
        session_id,
        turn_id,
        json!({
            "eventId": "response-function-call",
            "eventName": "agent.message.completed",
            "payload": {
                "content": "",
                "messageId": "message-1",
                "responseItems": [{
                    "type": "function_call",
                    "id": "function-call-1",
                    "call_id": "call-1",
                    "name": "exec_command",
                    "arguments": "{\"command\":\"dir /b\"}"
                }]
            }
        }),
    )
    .unwrap();

    rpc.append_turn_semantic_event(
        session_id,
        turn_id,
        json!({
            "eventId": "runtime-tool-call-delta",
            "eventName": "agent.tool_call.delta",
            "payload": {
                "toolCallId": "call-1",
                "toolName": "exec_command",
                "argumentsDelta": "{\"command\":\"dir /b\"}"
            }
        }),
    )
    .expect(
        "Responses runtime tool lifecycle must not duplicate or reject the native function_call",
    );

    let persisted_calls = read_thread_lines(std::path::Path::new(&thread.thread_path))
        .unwrap()
        .into_iter()
        .filter_map(|line| match line.item {
            ThreadLogItem::ResponseItem(item) => Some(item),
            _ => None,
        })
        .filter(|item| item.get("call_id").and_then(serde_json::Value::as_str) == Some("call-1"))
        .collect::<Vec<_>>();
    assert_eq!(persisted_calls.len(), 1);
    assert_eq!(
        persisted_calls[0]
            .get("type")
            .and_then(serde_json::Value::as_str),
        Some("function_call")
    );

    let error = rpc
        .append_turn_semantic_event(
            session_id,
            turn_id,
            json!({
                "eventId": "orphan-runtime-tool-call-delta",
                "eventName": "agent.tool_call.delta",
                "payload": {
                    "toolCallId": "call-without-native-item",
                    "toolName": "exec_command",
                    "argumentsDelta": "{}"
                }
            }),
        )
        .expect_err("an unrepresented Responses tool lifecycle must fail fast");
    assert!(error
        .message
        .contains("has no persisted native function_call"));

    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn persisted_tool_result_keeps_trust_fields_for_memory_evidence() {
    let result = completed_tool_result_from_response_item(&json!({
        "type": "custom_tool_call_output",
        "id": "tool-output:call-1",
        "call_id": "call-1",
        "turnId": "turn-1",
        "tool_name": "workspace.read_file",
        "status": "ok",
        "output": "contents"
    }));

    assert_eq!(result["toolCallId"], "call-1");
    assert_eq!(result["toolName"], "workspace.read_file");
    assert_eq!(result["status"], "ok");
    assert_eq!(result["summary"], "contents");
}

#[test]
fn empty_semantic_batch_fails_before_touching_the_rollout() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-empty-semantic-batch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );

    let error = rpc
        .append_turn_semantic_events("empty-batch-session", "empty-batch-turn", Vec::new())
        .expect_err("an empty semantic batch must fail fast");

    assert!(error.message.contains("must contain at least one event"));
    assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_token_count_batch_does_not_append_partial_rollout_items() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-invalid-token-batch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let session_id = "invalid-token-session";
    let turn_id = "invalid-token-turn";
    let timestamp = "2026-08-16T00:00:00Z";
    let thread = rpc
        .ensure_turn_thread(
            session_id,
            timestamp,
            None,
            Some(SessionApiMode::ChatCompletions),
        )
        .unwrap();
    rpc.start_turn(
        AgentTurnRecord {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            thread_id: None,
            parent_thread_id: None,
            child_thread_ids: Vec::new(),
            status: AgentTurnStatus::Running,
            phase: "planning".to_string(),
            started_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
            completed_at: None,
            stop_reason: None,
            model: "test-model".to_string(),
            provider: Some("openai".to_string()),
            max_iterations: 8,
            current_iteration: 0,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: None,
            instruction_diagnostics: Vec::new(),
            trace_context: None,
            error: None,
        },
        None,
        Vec::new(),
    )
    .unwrap();
    let path = std::path::Path::new(&thread.thread_path);
    let initial_line_count = read_thread_lines(path).unwrap().len();

    let error = rpc
        .append_turn_semantic_events(
            session_id,
            turn_id,
            vec![json!({
                "eventId": "invalid-token-count",
                "eventName": "agent.token_count",
                "payload": {
                    "info": {
                        "totalTokenUsage": { "totalTokens": 21 }
                    }
                }
            })],
        )
        .expect_err("token usage without lastTokenUsage must fail fast");

    assert!(error.message.contains("missing lastTokenUsage"));
    assert_eq!(read_thread_lines(path).unwrap().len(), initial_line_count);
    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}
