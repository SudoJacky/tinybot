use super::{
    completed_tool_result_from_response_item, response_item_from_runtime_event,
    response_items_from_runtime_event,
};
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::threads::rollout::format::SessionApiMode;
use crate::threads::rollout::store::{read_thread_lines, ThreadLogItem, WorkerThreadLogRpc};
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
