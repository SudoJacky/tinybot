use crate::worker_protocol::{
    WorkerEvent, WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
    WorkerRequest, WorkerResponse, WORKER_PROTOCOL_VERSION,
};
use crate::worker_rpc::WorkerRpcRouter;
use crate::worker_stdio::{decode_worker_line, WorkerInboundMessage};
use std::{
    collections::HashMap,
    fmt,
    io::{BufRead, Write},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct WorkerRequestKey {
    id: String,
    trace_id: String,
}

impl WorkerRequestKey {
    fn new(id: impl Into<String>, trace_id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            trace_id: trace_id.into(),
        }
    }

    fn from_request(request: &WorkerRequest) -> Self {
        Self::new(request.id.clone(), request.trace_id.clone())
    }

    fn from_response(response: &WorkerResponse) -> Self {
        Self::new(response.id.clone(), response.trace_id.clone())
    }
}

#[derive(Default)]
struct PendingResponses {
    waiting: HashMap<WorkerRequestKey, mpsc::Sender<WorkerResponse>>,
}

pub struct WorkerConnection<W> {
    writer: Arc<Mutex<W>>,
    pending: Arc<Mutex<PendingResponses>>,
}

impl<W> Clone for WorkerConnection<W> {
    fn clone(&self) -> Self {
        Self {
            writer: self.writer.clone(),
            pending: self.pending.clone(),
        }
    }
}

impl<W> fmt::Debug for WorkerConnection<W> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerConnection")
            .finish_non_exhaustive()
    }
}

impl<W> WorkerConnection<W>
where
    W: Write + Send + 'static,
{
    pub fn start<R>(
        reader: R,
        writer: W,
        router: WorkerRpcRouter,
        on_event: impl Fn(WorkerEvent) + Send + Sync + 'static,
    ) -> Self
    where
        R: BufRead + Send + 'static,
    {
        let writer = Arc::new(Mutex::new(writer));
        let pending = Arc::new(Mutex::new(PendingResponses::default()));
        spawn_reader_loop(
            reader,
            writer.clone(),
            Arc::new(Mutex::new(router)),
            pending.clone(),
            Arc::new(on_event),
        );
        Self { writer, pending }
    }

    pub fn send_request(
        &self,
        request: &WorkerRequest,
        timeout: Duration,
    ) -> Result<WorkerResponse, WorkerProtocolError> {
        let key = WorkerRequestKey::from_request(request);
        let rx = register_pending_request(&self.pending, request)?;

        if let Err(error) = write_request(&self.writer, request) {
            let mut pending = lock_pending(&self.pending);
            pending.waiting.remove(&key);
            return Err(error);
        }

        rx.recv_timeout(timeout).map_err(|error| {
            let mut pending = lock_pending(&self.pending);
            pending.waiting.remove(&key);
            worker_error(
                "timed out waiting for worker response",
                serde_json::json!({
                    "id": request.id,
                    "trace_id": request.trace_id,
                    "error": error.to_string(),
                }),
                true,
            )
        })
    }
}

fn spawn_reader_loop<R, W>(
    mut reader: R,
    writer: Arc<Mutex<W>>,
    router: Arc<Mutex<WorkerRpcRouter>>,
    pending: Arc<Mutex<PendingResponses>>,
    on_event: Arc<dyn Fn(WorkerEvent) + Send + Sync>,
) where
    R: BufRead + Send + 'static,
    W: Write + Send + 'static,
{
    thread::spawn(move || loop {
        let mut line = String::new();
        let bytes = match reader.read_line(&mut line) {
            Ok(bytes) => bytes,
            Err(error) => {
                emit_protocol_diagnostics(
                    &on_event,
                    format!("failed to read worker message: {error}"),
                );
                wake_pending_requests(&pending, format!("failed to read worker message: {error}"));
                return;
            }
        };
        if bytes == 0 {
            wake_pending_requests(&pending, "worker stdio connection closed");
            return;
        }
        let message = match decode_worker_line(line.trim_end_matches(['\r', '\n'])) {
            Ok(message) => message,
            Err(error) => {
                let message = error.message;
                emit_protocol_diagnostics(&on_event, message.clone());
                wake_pending_requests(
                    &pending,
                    format!("worker protocol decoding stopped: {message}"),
                );
                return;
            }
        };
        match message {
            WorkerInboundMessage::Request(request) => {
                let response = lock_router(&router).dispatch(&request);
                let _ = write_response(&writer, &response);
            }
            WorkerInboundMessage::Response(response) => {
                if !route_worker_response(&pending, response) {
                    emit_protocol_diagnostics(
                        &on_event,
                        "worker response did not match a pending request",
                    );
                }
            }
            WorkerInboundMessage::Event(event) => on_event(event),
        }
    });
}

fn emit_protocol_diagnostics(
    on_event: &Arc<dyn Fn(WorkerEvent) + Send + Sync>,
    line: impl Into<String>,
) {
    on_event(WorkerEvent {
        protocol_version: WORKER_PROTOCOL_VERSION.to_string(),
        trace_id: "worker-protocol".to_string(),
        event: "diagnostics.log".to_string(),
        payload: serde_json::json!({
            "stream": "stderr",
            "line": line.into(),
        }),
    });
}

fn route_worker_response(pending: &Arc<Mutex<PendingResponses>>, response: WorkerResponse) -> bool {
    let key = WorkerRequestKey::from_response(&response);
    let sender = {
        let mut pending = lock_pending(pending);
        match pending.waiting.remove(&key) {
            Some(sender) => Some(sender),
            None => return false,
        }
    };
    if let Some(sender) = sender {
        let _ = sender.send(response);
    }
    true
}

fn register_pending_request(
    pending: &Arc<Mutex<PendingResponses>>,
    request: &WorkerRequest,
) -> Result<mpsc::Receiver<WorkerResponse>, WorkerProtocolError> {
    let key = WorkerRequestKey::from_request(request);
    let (tx, rx) = mpsc::channel();
    let mut pending = lock_pending(pending);
    if pending.waiting.contains_key(&key) {
        return Err(invalid_protocol_error(
            "duplicate worker request key",
            serde_json::json!({
                "id": request.id,
                "trace_id": request.trace_id,
            }),
        ));
    }
    pending.waiting.insert(key, tx);
    Ok(rx)
}

fn wake_pending_requests(pending: &Arc<Mutex<PendingResponses>>, message: impl Into<String>) {
    let message = message.into();
    let waiting = {
        let mut pending = lock_pending(pending);
        std::mem::take(&mut pending.waiting)
    };
    for (key, sender) in waiting {
        let _ = sender.send(WorkerResponse {
            protocol_version: WORKER_PROTOCOL_VERSION.to_string(),
            id: key.id.clone(),
            trace_id: key.trace_id.clone(),
            result: None,
            error: Some(worker_error(
                message.clone(),
                serde_json::json!({
                    "id": key.id,
                    "trace_id": key.trace_id,
                }),
                true,
            )),
        });
    }
}

fn write_request<W>(
    writer: &Arc<Mutex<W>>,
    request: &WorkerRequest,
) -> Result<(), WorkerProtocolError>
where
    W: Write,
{
    let mut writer = lock_writer(writer)?;
    serde_json::to_writer(&mut *writer, request).map_err(|error| {
        invalid_protocol_error(
            "failed to encode worker request",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    writer.write_all(b"\n").map_err(|error| {
        invalid_protocol_error(
            "failed to write worker request",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    writer.flush().map_err(|error| {
        invalid_protocol_error(
            "failed to flush worker request",
            serde_json::json!({ "error": error.to_string() }),
        )
    })
}

fn write_response<W>(
    writer: &Arc<Mutex<W>>,
    response: &WorkerResponse,
) -> Result<(), WorkerProtocolError>
where
    W: Write,
{
    let mut writer = lock_writer(writer)?;
    serde_json::to_writer(&mut *writer, response).map_err(|error| {
        invalid_protocol_error(
            "failed to encode worker response",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    writer.write_all(b"\n").map_err(|error| {
        invalid_protocol_error(
            "failed to write worker response",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    writer.flush().map_err(|error| {
        invalid_protocol_error(
            "failed to flush worker response",
            serde_json::json!({ "error": error.to_string() }),
        )
    })
}

fn lock_pending(
    pending: &Arc<Mutex<PendingResponses>>,
) -> std::sync::MutexGuard<'_, PendingResponses> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_router(router: &Arc<Mutex<WorkerRpcRouter>>) -> std::sync::MutexGuard<'_, WorkerRpcRouter> {
    router
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_writer<W>(
    writer: &Arc<Mutex<W>>,
) -> Result<std::sync::MutexGuard<'_, W>, WorkerProtocolError> {
    writer.lock().map_err(|_| {
        worker_error(
            "worker writer lock is poisoned",
            serde_json::json!({}),
            true,
        )
    })
}

fn invalid_protocol_error(
    message: impl Into<String>,
    details: serde_json::Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn worker_error(
    message: impl Into<String>,
    details: serde_json::Value,
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
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::WorkerRequest;
    use crate::worker_rpc::WorkerRpcRouter;
    use serde_json::json;
    use std::{
        io::Cursor,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::Duration,
    };

    #[test]
    fn full_duplex_request_allows_worker_to_call_rust_rpc_before_final_response() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        let reader = Cursor::new(
            concat!(
                r#"{"protocol_version":"1","id":"worker-req-1","trace_id":"trace-worker","method":"workspace.list_files","params":{}}"#,
                "\n",
                r#"{"protocol_version":"1","id":"agent-req-1","trace_id":"trace-agent","result":{"ok":true}}"#,
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
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let connection = WorkerConnection::start(reader, writer.clone(), router, |_| {});
        let request = WorkerRequest::new("agent-req-1", "trace-agent", "agent.echo", json!({}));

        let response = connection
            .send_request(&request, Duration::from_secs(2))
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
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
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

    #[derive(Clone, Default)]
    struct SharedWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl SharedWriter {
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
            Ok(())
        }
    }

    fn wait_for_events(
        events: &Arc<Mutex<Vec<crate::worker_protocol::WorkerEvent>>>,
        predicate: impl Fn(&[crate::worker_protocol::WorkerEvent]) -> bool,
    ) -> Vec<crate::worker_protocol::WorkerEvent> {
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
}
