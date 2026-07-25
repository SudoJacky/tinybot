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
    let mut transport = WorkerStdioTransport::new(Cursor::new(b"not-json\n".to_vec()), Vec::new());

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
