use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::WorkerRequest;
use crate::rpc::WorkerRpcRouter;
use serde_json::json;
use std::{
    io::{BufReader, Cursor, Read},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

#[test]
fn full_duplex_request_allows_worker_to_call_rust_rpc_before_final_response() {
    let fixture = WorkspaceFixture::new();
    fixture.write("AGENTS.md", "agents");
    let (writer, response_gate) = SharedWriter::with_response_gate();
    let reader = BufReader::new(GatedReader::new(
        concat!(
            r#"{"protocol_version":"1","id":"worker-req-1","trace_id":"trace-worker","method":"workspace.list_files","params":{}}"#,
            "\n",
        ),
        concat!(
            r#"{"protocol_version":"1","id":"agent-req-1","trace_id":"trace-agent","result":{"ok":true}}"#,
            "\n",
        ),
        response_gate,
    ));
    let router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );
    let connection = WorkerConnection::start(reader, writer.clone(), router, |_| {});
    let request = WorkerRequest::new("agent-req-1", "trace-agent", "agent.echo", json!({}));

    let response = connection
        .send_request(&request, Duration::from_secs(10))
        .expect("agent request should complete");

    assert_eq!(response.result, Some(json!({ "ok": true })));
    let written = writer.text();
    assert!(written.contains(r#""method":"agent.echo""#));
    assert!(written.contains(r#""id":"worker-req-1""#));
    assert!(written.contains(r#""path":"AGENTS.md""#));
}

#[test]
fn malformed_worker_stdout_emits_invalid_protocol_diagnostics_event() {
    let fixture = WorkspaceFixture::new();
    let reader = Cursor::new(b"not-json\n".to_vec());
    let writer = SharedWriter::default();
    let router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::default(),
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let event_log = events.clone();

    let _connection = WorkerConnection::start(reader, writer, router, move |event| {
        event_log.lock().expect("events should lock").push(event);
    });

    let events = wait_for_events(&events, |events| {
        events.iter().any(|event| {
            event.event == "diagnostics.log"
                && event.payload["line"]
                    .as_str()
                    .is_some_and(|line| line.contains("worker message is not valid JSON"))
        })
    });

    assert!(events.iter().any(|event| event.event == "diagnostics.log"));
}

#[test]
fn worker_rust_rpc_capability_denial_is_written_back_to_worker() {
    let fixture = WorkspaceFixture::new();
    let reader = Cursor::new(
            concat!(
                r#"{"protocol_version":"1","id":"worker-req-1","trace_id":"trace-worker","method":"workspace.list_files","params":{}}"#,
                "\n",
            )
            .as_bytes()
            .to_vec(),
        );
    let writer = SharedWriter::default();
    let router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::default(),
    );

    let _connection = WorkerConnection::start(reader, writer.clone(), router, |_| {});
    let written = wait_for_writer_text(&writer, |text| text.contains("capability_denied"));

    assert!(written.contains(r#""code":"capability_denied""#));
    assert!(written.contains(r#""capability":"fs.workspace.read""#));
}

#[test]
fn duplicate_pending_request_key_is_rejected() {
    let pending = Arc::new(Mutex::new(PendingResponses::default()));
    let request = WorkerRequest::new("agent-req-1", "trace-agent", "agent.echo", json!({}));

    let _first = register_pending_request(&pending, &request)
        .expect("first pending request should register");
    let duplicate = register_pending_request(&pending, &request)
        .expect_err("duplicate pending request should be rejected");

    assert_eq!(
        duplicate.code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert!(duplicate.message.contains("duplicate worker request key"));
    assert_eq!(lock_pending(&pending).waiting.len(), 1);
}

#[test]
fn unmatched_worker_response_is_not_cached() {
    let pending = Arc::new(Mutex::new(PendingResponses::default()));
    let request = WorkerRequest::new("agent-req-1", "trace-agent", "agent.echo", json!({}));
    let response = WorkerResponse::success(&request, json!({ "ok": true }));

    assert!(!route_worker_response(&pending, response));
    assert!(lock_pending(&pending).waiting.is_empty());
}

#[test]
fn closing_connection_wakes_pending_requests() {
    let pending = Arc::new(Mutex::new(PendingResponses::default()));
    let request = WorkerRequest::new("agent-req-1", "trace-agent", "agent.echo", json!({}));
    let receiver =
        register_pending_request(&pending, &request).expect("pending request should register");

    wake_pending_requests(&pending, "worker stdio connection closed");

    let response = receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("pending request should be woken");
    let error = response.error.expect("wake response should carry error");
    assert!(error.message.contains("worker stdio connection closed"));
    assert!(lock_pending(&pending).waiting.is_empty());
}

type ResponseGate = Arc<(Mutex<bool>, Condvar)>;

struct GatedReader {
    request: Cursor<Vec<u8>>,
    response: Cursor<Vec<u8>>,
    response_gate: ResponseGate,
}

impl GatedReader {
    fn new(request: &str, response: &str, response_gate: ResponseGate) -> Self {
        Self {
            request: Cursor::new(request.as_bytes().to_vec()),
            response: Cursor::new(response.as_bytes().to_vec()),
            response_gate,
        }
    }
}

impl Read for GatedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.request.position() < self.request.get_ref().len() as u64 {
            return self.request.read(buffer);
        }
        let (ready, wake) = &*self.response_gate;
        let mut ready = ready.lock().expect("response gate should lock");
        while !*ready {
            ready = wake.wait(ready).expect("response gate should wait");
        }
        self.response.read(buffer)
    }
}

#[derive(Clone, Default)]
struct SharedWriter {
    bytes: Arc<Mutex<Vec<u8>>>,
    response_gate: Option<ResponseGate>,
}

impl SharedWriter {
    fn with_response_gate() -> (Self, ResponseGate) {
        let response_gate = Arc::new((Mutex::new(false), Condvar::new()));
        (
            Self {
                bytes: Arc::new(Mutex::new(Vec::new())),
                response_gate: Some(response_gate.clone()),
            },
            response_gate,
        )
    }

    fn text(&self) -> String {
        let bytes = self.bytes.lock().expect("writer should lock").clone();
        String::from_utf8(bytes).expect("writer output should be utf-8")
    }
}

impl std::io::Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.bytes
            .lock()
            .expect("writer should lock")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.text().contains(r#""method":"agent.echo""#) {
            if let Some(response_gate) = &self.response_gate {
                let (ready, wake) = &**response_gate;
                *ready.lock().expect("response gate should lock") = true;
                wake.notify_all();
            }
        }
        Ok(())
    }
}

fn wait_for_events(
    events: &Arc<Mutex<Vec<crate::protocol::WorkerEvent>>>,
    predicate: impl Fn(&[crate::protocol::WorkerEvent]) -> bool,
) -> Vec<crate::protocol::WorkerEvent> {
    for _ in 0..30 {
        let snapshot = events.lock().expect("events should lock").clone();
        if predicate(&snapshot) {
            return snapshot;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    events.lock().expect("events should lock").clone()
}

fn wait_for_writer_text(writer: &SharedWriter, predicate: impl Fn(&str) -> bool) -> String {
    for _ in 0..30 {
        let text = writer.text();
        if predicate(&text) {
            return text;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    writer.text()
}

struct WorkspaceFixture {
    root: PathBuf,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-connection-{}-{}",
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
