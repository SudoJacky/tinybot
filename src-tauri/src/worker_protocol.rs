use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;

pub const WORKER_PROTOCOL_VERSION: &str = "1";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerTransportMode {
    Stdio,
    LocalPipe,
}

pub trait WorkerRequestCancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;
}

#[derive(Clone, Deserialize, Serialize)]
pub struct WorkerRequest {
    pub protocol_version: String,
    pub id: String,
    pub trace_id: String,
    pub method: String,
    #[serde(default = "empty_json_object")]
    pub params: Value,
    #[serde(skip)]
    pub cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    #[serde(skip)]
    trusted_internal: bool,
}

impl WorkerRequest {
    pub fn new(
        id: impl Into<String>,
        trace_id: impl Into<String>,
        method: impl Into<String>,
        params: Value,
    ) -> Self {
        Self {
            protocol_version: WORKER_PROTOCOL_VERSION.to_string(),
            id: id.into(),
            trace_id: trace_id.into(),
            method: method.into(),
            params,
            cancellation: None,
            trusted_internal: false,
        }
    }

    pub fn with_cancellation(
        mut self,
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Self {
        self.cancellation = cancellation;
        self
    }

    pub fn cancellation(&self) -> Option<Arc<dyn WorkerRequestCancellation>> {
        self.cancellation.clone()
    }

    pub(crate) fn with_trusted_internal(mut self) -> Self {
        self.trusted_internal = true;
        self
    }

    pub(crate) fn is_trusted_internal(&self) -> bool {
        self.trusted_internal
    }
}

impl fmt::Debug for WorkerRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerRequest")
            .field("protocol_version", &self.protocol_version)
            .field("id", &self.id)
            .field("trace_id", &self.trace_id)
            .field("method", &self.method)
            .field("params", &self.params)
            .field("has_cancellation", &self.cancellation.is_some())
            .field("trusted_internal", &self.trusted_internal)
            .finish()
    }
}

impl PartialEq for WorkerRequest {
    fn eq(&self, other: &Self) -> bool {
        self.protocol_version == other.protocol_version
            && self.id == other.id
            && self.trace_id == other.trace_id
            && self.method == other.method
            && self.params == other.params
            && self.trusted_internal == other.trusted_internal
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkerResponse {
    pub protocol_version: String,
    pub id: String,
    pub trace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WorkerProtocolError>,
}

impl WorkerResponse {
    pub fn success(request: &WorkerRequest, result: Value) -> Self {
        Self {
            protocol_version: WORKER_PROTOCOL_VERSION.to_string(),
            id: request.id.clone(),
            trace_id: request.trace_id.clone(),
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request: &WorkerRequest, error: WorkerProtocolError) -> Self {
        Self {
            protocol_version: WORKER_PROTOCOL_VERSION.to_string(),
            id: request.id.clone(),
            trace_id: request.trace_id.clone(),
            result: None,
            error: Some(error),
        }
    }

    pub fn matches_request(&self, request: &WorkerRequest) -> bool {
        self.id == request.id && self.trace_id == request.trace_id
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkerEvent {
    pub protocol_version: String,
    pub trace_id: String,
    pub event: String,
    #[serde(default = "empty_json_object")]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerProtocolErrorCode {
    InvalidProtocol,
    IncompatibleProtocolVersion,
    CapabilityDenied,
    WorkerError,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerProtocolErrorSource {
    RustCore,
    Worker,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkerProtocolError {
    pub code: WorkerProtocolErrorCode,
    pub message: String,
    #[serde(default = "empty_json_object")]
    pub details: Value,
    pub retryable: bool,
    pub source: WorkerProtocolErrorSource,
}

impl WorkerProtocolError {
    pub fn new(
        code: WorkerProtocolErrorCode,
        message: impl Into<String>,
        details: Value,
        retryable: bool,
        source: WorkerProtocolErrorSource,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details,
            retryable,
            source,
        }
    }
}

pub fn validate_protocol_version(version: &str) -> Result<(), WorkerProtocolError> {
    if version == WORKER_PROTOCOL_VERSION {
        return Ok(());
    }
    Err(WorkerProtocolError::new(
        WorkerProtocolErrorCode::IncompatibleProtocolVersion,
        format!(
            "Unsupported worker protocol version '{version}'. Expected '{WORKER_PROTOCOL_VERSION}'."
        ),
        serde_json::json!({
            "actual": version,
            "expected": WORKER_PROTOCOL_VERSION,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    ))
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
}
