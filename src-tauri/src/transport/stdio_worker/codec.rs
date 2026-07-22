use crate::protocol::{
    validate_protocol_version, WorkerEvent, WorkerProtocolError, WorkerProtocolErrorCode,
    WorkerProtocolErrorSource, WorkerRequest, WorkerResponse,
};
#[cfg(test)]
use crate::rpc::WorkerRpcRouter;
use serde_json::Value;
#[cfg(test)]
use std::io::{BufRead, Write};

#[derive(Clone, Debug, PartialEq)]
pub enum WorkerInboundMessage {
    Request(WorkerRequest),
    Response(WorkerResponse),
    Event(WorkerEvent),
}

#[derive(Debug)]
#[cfg(test)]
pub struct WorkerStdioTransport<R, W> {
    reader: R,
    writer: W,
}

#[cfg(test)]
impl<R, W> WorkerStdioTransport<R, W>
where
    R: BufRead,
    W: Write,
{
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }

    pub fn send_request(&mut self, request: &WorkerRequest) -> Result<(), WorkerProtocolError> {
        serde_json::to_writer(&mut self.writer, request).map_err(|error| {
            invalid_protocol_error(
                "failed to encode worker request",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.write_all(b"\n").map_err(|error| {
            invalid_protocol_error(
                "failed to write worker request",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.flush().map_err(|error| {
            invalid_protocol_error(
                "failed to flush worker request",
                serde_json::json!({ "error": error.to_string() }),
            )
        })
    }

    pub fn send_response(&mut self, response: &WorkerResponse) -> Result<(), WorkerProtocolError> {
        serde_json::to_writer(&mut self.writer, response).map_err(|error| {
            invalid_protocol_error(
                "failed to encode worker response",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.write_all(b"\n").map_err(|error| {
            invalid_protocol_error(
                "failed to write worker response",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.flush().map_err(|error| {
            invalid_protocol_error(
                "failed to flush worker response",
                serde_json::json!({ "error": error.to_string() }),
            )
        })
    }

    pub fn read_message(&mut self) -> Result<Option<WorkerInboundMessage>, WorkerProtocolError> {
        let mut line = String::new();
        let bytes = self.reader.read_line(&mut line).map_err(|error| {
            invalid_protocol_error(
                "failed to read worker message",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        if bytes == 0 {
            return Ok(None);
        }
        decode_worker_line(line.trim_end_matches(['\r', '\n'])).map(Some)
    }

    pub fn round_trip(
        &mut self,
        request: &WorkerRequest,
        mut on_event: impl FnMut(&WorkerEvent),
    ) -> Result<WorkerResponse, WorkerProtocolError> {
        self.send_request(request)?;
        loop {
            let Some(message) = self.read_message()? else {
                return Err(worker_error(
                    "worker stream ended before response",
                    serde_json::json!({
                        "id": request.id,
                        "trace_id": request.trace_id,
                    }),
                    true,
                ));
            };
            match message {
                WorkerInboundMessage::Request(request) => {
                    return Err(invalid_protocol_error(
                        "worker RPC request arrived during Rust request round trip",
                        serde_json::json!({
                            "id": request.id,
                            "trace_id": request.trace_id,
                            "method": request.method,
                        }),
                    ));
                }
                WorkerInboundMessage::Event(event) => on_event(&event),
                WorkerInboundMessage::Response(response) => {
                    if response.matches_request(request) {
                        return Ok(response);
                    }
                    return Err(invalid_protocol_error(
                        "worker response does not match request identity",
                        serde_json::json!({
                            "expected_id": request.id,
                            "expected_trace_id": request.trace_id,
                            "actual_id": response.id,
                            "actual_trace_id": response.trace_id,
                        }),
                    ));
                }
            }
        }
    }

    pub fn serve_rust_rpc_requests(
        &mut self,
        router: &mut WorkerRpcRouter,
        mut on_event: impl FnMut(&WorkerEvent),
    ) -> Result<(), WorkerProtocolError> {
        while let Some(message) = self.read_message()? {
            match message {
                WorkerInboundMessage::Request(request) => {
                    let response = router.dispatch(&request);
                    self.send_response(&response)?;
                }
                WorkerInboundMessage::Event(event) => on_event(&event),
                WorkerInboundMessage::Response(response) => {
                    return Err(invalid_protocol_error(
                        "worker response arrived while serving Rust RPC requests",
                        serde_json::json!({
                            "id": response.id,
                            "trace_id": response.trace_id,
                        }),
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn into_writer(self) -> W {
        self.writer
    }
}

pub fn decode_worker_line(line: &str) -> Result<WorkerInboundMessage, WorkerProtocolError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        invalid_protocol_error(
            "worker message is not valid JSON",
            serde_json::json!({ "error": error.to_string(), "line": line }),
        )
    })?;
    let version = value
        .get("protocol_version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            invalid_protocol_error(
                "worker message missing protocol_version",
                serde_json::json!({ "message": value }),
            )
        })?;
    validate_protocol_version(version)?;

    if value.get("method").is_some() {
        let request: WorkerRequest = serde_json::from_value(value).map_err(|error| {
            invalid_protocol_error(
                "worker request has invalid shape",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        return Ok(WorkerInboundMessage::Request(request));
    }

    if value.get("id").is_some() {
        let response: WorkerResponse = serde_json::from_value(value).map_err(|error| {
            invalid_protocol_error(
                "worker response has invalid shape",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        return Ok(WorkerInboundMessage::Response(response));
    }

    if value.get("event").is_some() {
        let event: WorkerEvent = serde_json::from_value(value).map_err(|error| {
            invalid_protocol_error(
                "worker event has invalid shape",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        return Ok(WorkerInboundMessage::Event(event));
    }

    Err(invalid_protocol_error(
        "worker message is neither response nor event",
        serde_json::json!({ "message": value }),
    ))
}

fn invalid_protocol_error(message: impl Into<String>, details: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
fn worker_error(
    message: impl Into<String>,
    details: Value,
    retryable: bool,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        retryable,
        WorkerProtocolErrorSource::Worker,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
    use crate::protocol::{
        WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest, WorkerTransportMode,
        WORKER_PROTOCOL_VERSION,
    };
    use crate::rpc::WorkerRpcRouter;
    use serde_json::json;
    use std::io::Cursor;
    use std::path::PathBuf;

    #[test]
    fn transport_writes_request_as_one_json_line() {
        let request = WorkerRequest::new(
            "req-123",
            "trace-abc",
            "worker.health",
            json!({ "transport": WorkerTransportMode::Stdio }),
        );
        let mut transport = WorkerStdioTransport::new(Cursor::new(Vec::<u8>::new()), Vec::new());

        transport
            .send_request(&request)
            .expect("request should write");

        let written = String::from_utf8(transport.into_writer()).expect("request is utf-8");
        assert!(written.ends_with('\n'));

        let value: serde_json::Value =
            serde_json::from_str(written.trim_end()).expect("request line should be json");
        assert_eq!(value["protocol_version"], WORKER_PROTOCOL_VERSION);
        assert_eq!(value["id"], "req-123");
        assert_eq!(value["trace_id"], "trace-abc");
        assert_eq!(value["method"], "worker.health");
        assert!(value.get("jsonrpc").is_none());
    }

    #[test]
    fn transport_reads_fake_worker_response() {
        let input = Cursor::new(
            br#"{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","result":{"ok":true}}"#
                .to_vec(),
        );
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        let message = transport
            .read_message()
            .expect("response should parse")
            .expect("response should exist");

        match message {
            WorkerInboundMessage::Response(response) => {
                assert_eq!(response.id, "req-123");
                assert_eq!(response.trace_id, "trace-abc");
                assert_eq!(response.result, Some(json!({ "ok": true })));
                assert!(response.error.is_none());
            }
            WorkerInboundMessage::Request(_) => panic!("expected response"),
            WorkerInboundMessage::Event(_) => panic!("expected response"),
        }
    }

    #[test]
    fn transport_reads_worker_rpc_request() {
        let input = Cursor::new(
            br#"{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","method":"workspace.read_file","params":{"path":"notes/today.md"}}"#
                .to_vec(),
        );
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        let message = transport
            .read_message()
            .expect("request should parse")
            .expect("request should exist");

        match message {
            WorkerInboundMessage::Request(request) => {
                assert_eq!(request.id, "req-123");
                assert_eq!(request.trace_id, "trace-abc");
                assert_eq!(request.method, "workspace.read_file");
                assert_eq!(request.params["path"], "notes/today.md");
            }
            WorkerInboundMessage::Response(_) => panic!("expected request"),
            WorkerInboundMessage::Event(_) => panic!("expected request"),
        }
    }

    #[test]
    fn transport_reads_fake_worker_event() {
        let input = Cursor::new(
            br#"{"protocol_version":"1","trace_id":"trace-abc","event":"diagnostics.log","payload":{"stream":"stderr","line":"ready"}}"#
                .to_vec(),
        );
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        let message = transport
            .read_message()
            .expect("event should parse")
            .expect("event should exist");

        match message {
            WorkerInboundMessage::Event(event) => {
                assert_eq!(event.trace_id, "trace-abc");
                assert_eq!(event.event, "diagnostics.log");
                assert_eq!(event.payload["line"], "ready");
            }
            WorkerInboundMessage::Request(_) => panic!("expected event"),
            WorkerInboundMessage::Response(_) => panic!("expected event"),
        }
    }

    #[test]
    fn transport_reads_fake_worker_event_then_response_sequence() {
        let input = Cursor::new(
            concat!(
                r#"{"protocol_version":"1","trace_id":"trace-abc","event":"diagnostics.log","payload":{"line":"starting"}}"#,
                "\n",
                r#"{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","result":{"status":"ok"}}"#,
                "\n"
            )
            .as_bytes()
            .to_vec(),
        );
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        let first = transport
            .read_message()
            .expect("event should parse")
            .expect("event should exist");
        let second = transport
            .read_message()
            .expect("response should parse")
            .expect("response should exist");

        assert!(matches!(first, WorkerInboundMessage::Event(_)));
        match second {
            WorkerInboundMessage::Response(response) => {
                assert_eq!(response.id, "req-123");
                assert_eq!(response.result, Some(json!({ "status": "ok" })));
            }
            WorkerInboundMessage::Request(_) => panic!("expected response"),
            WorkerInboundMessage::Event(_) => panic!("expected response"),
        }
    }

    #[test]
    fn round_trip_sends_request_collects_events_until_matching_response() {
        let input = Cursor::new(
            concat!(
                r#"{"protocol_version":"1","trace_id":"trace-abc","event":"diagnostics.log","payload":{"line":"starting"}}"#,
                "\n",
                r#"{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","result":{"status":"ok"}}"#,
                "\n"
            )
            .as_bytes()
            .to_vec(),
        );
        let request = WorkerRequest::new("req-123", "trace-abc", "worker.health", json!({}));
        let mut events = Vec::new();
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        let response = transport
            .round_trip(&request, |event| events.push(event.event.clone()))
            .expect("round trip should return matching response");

        assert_eq!(response.result, Some(json!({ "status": "ok" })));
        assert_eq!(events, vec!["diagnostics.log"]);

        let written = String::from_utf8(transport.into_writer()).expect("request is utf-8");
        assert!(written.contains(r#""method":"worker.health""#));
    }

    #[test]
    fn round_trip_rejects_mismatched_response_identity() {
        let input = Cursor::new(
            br#"{"protocol_version":"1","id":"other","trace_id":"trace-abc","result":{"status":"ok"}}"#
                .to_vec(),
        );
        let request = WorkerRequest::new("req-123", "trace-abc", "worker.health", json!({}));
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        let error = transport
            .round_trip(&request, |_| {})
            .expect_err("mismatched response should fail");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["expected_id"], "req-123");
        assert_eq!(error.details["actual_id"], "other");
    }

    #[test]
    fn round_trip_returns_worker_error_when_eof_arrives_before_response() {
        let request = WorkerRequest::new("req-123", "trace-abc", "worker.health", json!({}));
        let mut transport = WorkerStdioTransport::new(Cursor::new(Vec::<u8>::new()), Vec::new());

        let error = transport
            .round_trip(&request, |_| {})
            .expect_err("eof before response should fail");

        assert_eq!(error.code, WorkerProtocolErrorCode::WorkerError);
        assert_eq!(error.source, WorkerProtocolErrorSource::Worker);
        assert!(error.retryable);
    }

    #[test]
    fn transport_dispatches_worker_rpc_request_and_writes_response() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello stdio rpc");
        let input = Cursor::new(
            concat!(
                r#"{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","method":"workspace.read_file","params":{"path":"notes/today.md"}}"#,
                "\n"
            )
            .as_bytes()
            .to_vec(),
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        transport
            .serve_rust_rpc_requests(&mut router, |_| {})
            .expect("worker RPC request should be served");

        let written = String::from_utf8(transport.into_writer()).expect("response is utf-8");
        let value: serde_json::Value =
            serde_json::from_str(written.trim_end()).expect("response line should be json");

        assert_eq!(value["protocol_version"], WORKER_PROTOCOL_VERSION);
        assert_eq!(value["id"], "req-123");
        assert_eq!(value["trace_id"], "trace-abc");
        assert_eq!(value["result"]["path"], "notes/today.md");
        assert_eq!(value["result"]["contents"], "hello stdio rpc");
        assert!(value.get("error").is_none());
    }

    #[test]
    fn transport_returns_none_at_eof() {
        let mut transport = WorkerStdioTransport::new(Cursor::new(Vec::<u8>::new()), Vec::new());

        assert_eq!(
            transport.read_message().expect("eof should not error"),
            None
        );
    }

    #[test]
    fn transport_rejects_incompatible_protocol_version() {
        let input = Cursor::new(
            br#"{"protocol_version":"0","id":"req-123","trace_id":"trace-abc","result":{"ok":true}}"#
                .to_vec(),
        );
        let mut transport = WorkerStdioTransport::new(input, Vec::new());

        let error = transport
            .read_message()
            .expect_err("old protocol should be rejected");

        assert_eq!(
            error.code,
            WorkerProtocolErrorCode::IncompatibleProtocolVersion
        );
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["expected"], WORKER_PROTOCOL_VERSION);
    }

    #[test]
    fn transport_rejects_non_json_line_as_invalid_protocol() {
        let mut transport =
            WorkerStdioTransport::new(Cursor::new(b"not-json\n".to_vec()), Vec::new());

        let error = transport
            .read_message()
            .expect_err("non-json line should be rejected");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert!(!error.retryable);
    }

    struct WorkspaceFixture {
        root: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-stdio-rpc-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            Self { root }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
