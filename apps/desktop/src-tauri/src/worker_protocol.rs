use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

pub const WORKER_PROTOCOL_VERSION: &str = "2026-06-09";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerTransportMode {
    Stdio,
    LocalPipe,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkerRequest {
    pub jsonrpc: String,
    pub id: String,
    pub method: String,
    #[serde(default = "empty_json_object")]
    pub params: Value,
}

impl WorkerRequest {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkerResponse {
    pub jsonrpc: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WorkerProtocolError>,
}

impl WorkerResponse {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            result: Some(result),
            error: None,
        }
    }

    pub fn matches_request(&self, request: &WorkerRequest) -> bool {
        self.id == request.id
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkerNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default = "empty_json_object")]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerProtocolErrorCode {
    InvalidProtocol,
    IncompatibleProtocolVersion,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkerProtocolError {
    pub code: WorkerProtocolErrorCode,
    pub message: String,
}

pub fn validate_protocol_version(version: &str) -> Result<(), WorkerProtocolError> {
    if version == WORKER_PROTOCOL_VERSION {
        return Ok(());
    }
    Err(WorkerProtocolError {
        code: WorkerProtocolErrorCode::IncompatibleProtocolVersion,
        message: format!(
            "Unsupported worker protocol version '{version}'. Expected '{WORKER_PROTOCOL_VERSION}'."
        ),
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkerDiagnosticLine {
    pub stream: String,
    pub line: String,
}

impl WorkerDiagnosticLine {
    pub fn new(stream: impl Into<String>, line: impl Into<String>) -> Self {
        Self {
            stream: stream.into(),
            line: line.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkerDiagnostics {
    capacity: usize,
    lines: VecDeque<WorkerDiagnosticLine>,
}

impl WorkerDiagnostics {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            lines: VecDeque::with_capacity(capacity),
        }
    }

    pub fn push(&mut self, stream: impl Into<String>, line: impl Into<String>) {
        if self.capacity == 0 {
            return;
        }
        while self.lines.len() >= self.capacity {
            self.lines.pop_front();
        }
        self.lines
            .push_back(WorkerDiagnosticLine::new(stream, line));
    }

    pub fn lines(&self) -> Vec<WorkerDiagnosticLine> {
        self.lines.iter().cloned().collect()
    }
}

fn empty_json_object() -> Value {
    Value::Object(Default::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn worker_request_response_ids_are_correlated() {
        let request = WorkerRequest::new(
            "req-123",
            "worker.health",
            json!({ "protocolVersion": WORKER_PROTOCOL_VERSION }),
        );
        let response = WorkerResponse::success(&request.id, json!({ "ok": true }));

        assert!(response.matches_request(&request));
        assert_eq!(response.id, "req-123");
        assert_eq!(response.result, Some(json!({ "ok": true })));
        assert!(response.error.is_none());
    }

    #[test]
    fn worker_notification_without_id_is_event() {
        let notification: WorkerNotification = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "method": "worker.progress",
            "params": { "percent": 42 }
        }))
        .expect("notification should parse");

        assert_eq!(notification.method, "worker.progress");
        assert_eq!(notification.params, json!({ "percent": 42 }));
    }

    #[test]
    fn incompatible_protocol_version_returns_protocol_error() {
        let error = validate_protocol_version("0.9").expect_err("old worker should be rejected");

        assert_eq!(error.code, WorkerProtocolErrorCode::IncompatibleProtocolVersion);
        assert!(error.message.contains(WORKER_PROTOCOL_VERSION));
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
}
