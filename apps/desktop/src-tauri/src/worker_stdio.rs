use crate::worker_protocol::{
    validate_protocol_version, WorkerEvent, WorkerProtocolError, WorkerProtocolErrorCode,
    WorkerProtocolErrorSource, WorkerRequest, WorkerResponse,
};
use serde_json::Value;
use std::io::{BufRead, Write};

#[derive(Clone, Debug, PartialEq)]
pub enum WorkerInboundMessage {
    Response(WorkerResponse),
    Event(WorkerEvent),
}

#[derive(Debug)]
pub struct WorkerStdioTransport<R, W> {
    reader: R,
    writer: W,
}

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
mod tests {
    use super::*;
    use crate::worker_protocol::{
        WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
        WorkerTransportMode, WORKER_PROTOCOL_VERSION,
    };
    use serde_json::json;
    use std::io::Cursor;

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
            WorkerInboundMessage::Event(_) => panic!("expected response"),
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
            WorkerInboundMessage::Event(_) => panic!("expected response"),
        }
    }

    #[test]
    fn transport_returns_none_at_eof() {
        let mut transport = WorkerStdioTransport::new(Cursor::new(Vec::<u8>::new()), Vec::new());

        assert_eq!(transport.read_message().expect("eof should not error"), None);
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

        assert_eq!(error.code, WorkerProtocolErrorCode::IncompatibleProtocolVersion);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["expected"], WORKER_PROTOCOL_VERSION);
    }

    #[test]
    fn transport_rejects_non_json_line_as_invalid_protocol() {
        let mut transport = WorkerStdioTransport::new(Cursor::new(b"not-json\n".to_vec()), Vec::new());

        let error = transport
            .read_message()
            .expect_err("non-json line should be rejected");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert!(!error.retryable);
    }
}
