use super::{completed_tool_result_from_response_item, response_item_from_runtime_event};
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
