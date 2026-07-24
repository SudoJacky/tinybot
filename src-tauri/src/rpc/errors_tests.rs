use super::*;
use serde_json::json;

#[test]
fn unknown_method_error_includes_method_and_namespace() {
    let request = WorkerRequest::new("req-1", "trace-1", "memory.missing", json!({}));

    let error = unknown_method_error(&request);

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert_eq!(error.details["method"], "memory.missing");
    assert_eq!(error.details["namespace"], "memory");
}
