use super::*;
use serde_json::json;

#[test]
fn form_request_returns_awaiting_form_result() {
    let form = json!({
        "form_id": "travel_plan",
        "title": "Travel plan",
        "fields": [
            { "name": "destination", "type": "text", "label": "Destination" }
        ]
    });
    let rpc = WorkerFormRpc::new(CapabilityPolicy::new([WorkerCapability::FormRequest]));
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "form.request",
        json!({
            "turn_id": "turn-1",
            "session_id": "session-1",
            "form": form,
            "continuation_mode": "resume"
        }),
    );

    let response = rpc
        .request_from_request(&request)
        .expect("form request should return result");

    assert_eq!(
        response,
        json!({
            "content": "Waiting for form submission.",
            "awaitingUserInput": true,
            "stopReason": "awaiting_form",
            "formId": "travel_plan",
            "form": form,
            "continuationMode": "resume",
            "turnId": "turn-1",
            "sessionId": "session-1"
        })
    );
}

#[test]
fn form_request_rejects_missing_form_id() {
    let rpc = WorkerFormRpc::new(CapabilityPolicy::new([WorkerCapability::FormRequest]));
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "form.request",
        json!({
            "turn_id": "turn-1",
            "form": { "fields": [] }
        }),
    );

    let error = rpc
        .request_from_request(&request)
        .expect_err("missing form_id should fail");

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert_eq!(error.message, "form.form_id must be a non-empty string");
}

#[test]
fn form_request_requires_form_capability() {
    let rpc = WorkerFormRpc::new(CapabilityPolicy::new([]));
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "form.request",
        json!({
            "turn_id": "turn-1",
            "form": { "form_id": "travel_plan" }
        }),
    );

    let error = rpc
        .request_from_request(&request)
        .expect_err("missing capability should fail");

    assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
    assert_eq!(error.details["capability"], "form.request");
}
