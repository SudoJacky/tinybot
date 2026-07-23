use super::*;
use serde_json::json;

#[test]
fn worker_request_response_ids_and_trace_ids_are_correlated() {
    let request = WorkerRequest::new(
        "req-123",
        "trace-abc",
        "worker.health",
        json!({ "protocol_version": WORKER_PROTOCOL_VERSION }),
    );
    let response = WorkerResponse::success(&request, json!({ "ok": true }));

    assert!(response.matches_request(&request));
    assert_eq!(request.protocol_version, "1");
    assert_eq!(response.id, "req-123");
    assert_eq!(response.trace_id, "trace-abc");
    assert_eq!(response.result, Some(json!({ "ok": true })));
    assert!(response.error.is_none());

    let value = serde_json::to_value(request).expect("request should serialize");
    assert!(value.get("jsonrpc").is_none());
}

#[test]
fn worker_event_without_id_keeps_protocol_and_trace_metadata() {
    let event: WorkerEvent = serde_json::from_value(json!({
        "protocol_version": "1",
        "trace_id": "trace-abc",
        "event": "diagnostics.log",
        "payload": { "stream": "stdout", "line": "ready" }
    }))
    .expect("event should parse");

    assert_eq!(event.event, "diagnostics.log");
    assert_eq!(event.trace_id, "trace-abc");
    assert_eq!(
        event.payload,
        json!({ "stream": "stdout", "line": "ready" })
    );
}

#[test]
fn incompatible_protocol_version_returns_protocol_error() {
    let error = validate_protocol_version("0.9").expect_err("old worker should be rejected");

    assert_eq!(
        error.code,
        WorkerProtocolErrorCode::IncompatibleProtocolVersion
    );
    assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
    assert!(!error.retryable);
    assert_eq!(error.details["expected"], WORKER_PROTOCOL_VERSION);
    assert!(error.message.contains(WORKER_PROTOCOL_VERSION));
}

#[test]
fn worker_error_response_uses_unified_error_shape() {
    let request = WorkerRequest::new("req-123", "trace-abc", "worker.health", json!({}));
    let response = WorkerResponse::failure(
        &request,
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::WorkerError,
            "worker crashed",
            json!({ "pid": 1234 }),
            true,
            WorkerProtocolErrorSource::Worker,
        ),
    );

    let value = serde_json::to_value(response).expect("response should serialize");

    assert_eq!(value["protocol_version"], "1");
    assert_eq!(value["id"], "req-123");
    assert_eq!(value["trace_id"], "trace-abc");
    assert_eq!(value["error"]["code"], "worker_error");
    assert_eq!(value["error"]["message"], "worker crashed");
    assert_eq!(value["error"]["details"]["pid"], 1234);
    assert_eq!(value["error"]["retryable"], true);
    assert_eq!(value["error"]["source"], "worker");
}

#[test]
fn diagnostic_buffer_keeps_recent_lines_only() {
    let mut diagnostics = WorkerDiagnostics::new(3);

    diagnostics.push("stdout", "one");
    diagnostics.push("stderr", "two");
    diagnostics.push("stdout", "three");
    diagnostics.push("stderr", "four");

    assert_eq!(
        diagnostics.lines(),
        vec![
            WorkerDiagnosticLine::new("stderr", "two"),
            WorkerDiagnosticLine::new("stdout", "three"),
            WorkerDiagnosticLine::new("stderr", "four"),
        ]
    );
}
