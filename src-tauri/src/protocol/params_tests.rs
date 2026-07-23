use super::*;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize, PartialEq)]
struct ExampleParams {
    name: String,
}

#[test]
fn parse_params_returns_typed_params() {
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "example.method",
        json!({ "name": "tinybot" }),
    );

    assert_eq!(
        parse_params::<ExampleParams>(&request).unwrap(),
        ExampleParams {
            name: "tinybot".to_string()
        }
    );
}

#[test]
fn parse_params_reports_method_on_invalid_payload() {
    let request = WorkerRequest::new("req-1", "trace-1", "example.method", json!({ "name": 42 }));

    let error = parse_params::<ExampleParams>(&request).unwrap_err();

    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(error.details["method"], "example.method");
}
