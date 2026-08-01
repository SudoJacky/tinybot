use super::{
    completed_tool_result_from_response_item, response_item_from_runtime_event,
    response_items_from_runtime_event,
};
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::threads::rollout::format::SessionApiMode;
use crate::threads::rollout::store::WorkerThreadLogRpc;
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
                "raw": { "content": "contents" }
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
                "content": "contents"
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
