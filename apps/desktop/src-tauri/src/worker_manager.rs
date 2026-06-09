use crate::worker_connection::WorkerConnection;
use crate::worker_protocol::{
    WorkerDiagnosticLine, WorkerDiagnostics, WorkerEvent, WorkerProtocolError,
    WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest, WorkerResponse,
};
use crate::worker_rpc::WorkerRpcRouter;
use serde::Serialize;
use std::{
    fmt,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerCommandSpec {
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

impl WorkerCommandSpec {
    pub fn new(
        program: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
        cwd: PathBuf,
    ) -> Self {
        let program = program.into();
        Self {
            label: program.clone(),
            program,
            args: args.into_iter().map(Into::into).collect(),
            cwd,
        }
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerManagerState {
    Stopped,
    Running,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerHealth {
    Stopped,
    Running,
    Exited,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerManagerError {
    AlreadyRunning,
    SpawnFailed(String),
    StopFailed(String),
    InspectFailed(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkerManagerStatus {
    pub state: WorkerManagerState,
    pub label: Option<String>,
    pub pid: Option<u32>,
    pub started_at_unix_ms: Option<u128>,
    pub diagnostics: Vec<WorkerDiagnosticLine>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum WorkerManagerEvent {
    Status(WorkerManagerStatus),
    Diagnostics(WorkerDiagnosticLine),
    Protocol(WorkerEvent),
}

type WorkerEventSink = Arc<dyn Fn(WorkerManagerEvent) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct WorkerManager {
    inner: Arc<Mutex<WorkerManagerInner>>,
    event_sink: Arc<Mutex<Option<WorkerEventSink>>>,
}

impl fmt::Debug for WorkerManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerManager")
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct WorkerManagerInner {
    child: Option<Child>,
    label: Option<String>,
    pid: Option<u32>,
    started_at_unix_ms: Option<u128>,
    diagnostics: WorkerDiagnostics,
    last_error: Option<String>,
    stdio_connection: Option<WorkerConnection<ChildStdin>>,
}

impl WorkerManager {
    pub fn new(diagnostic_capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(WorkerManagerInner {
                child: None,
                label: None,
                pid: None,
                started_at_unix_ms: None,
                diagnostics: WorkerDiagnostics::new(diagnostic_capacity),
                last_error: None,
                stdio_connection: None,
            })),
            event_sink: Arc::new(Mutex::new(None)),
        }
    }

    pub fn with_event_sink(
        self,
        event_sink: impl Fn(WorkerManagerEvent) + Send + Sync + 'static,
    ) -> Self {
        self.set_event_sink(event_sink);
        self
    }

    pub fn set_event_sink(&self, event_sink: impl Fn(WorkerManagerEvent) + Send + Sync + 'static) {
        let mut sink = lock_event_sink(&self.event_sink);
        *sink = Some(Arc::new(event_sink));
    }

    pub fn start(&self, spec: WorkerCommandSpec) -> Result<(), WorkerManagerError> {
        {
            let mut inner = lock_inner(&self.inner);
            if refresh_child_status(&mut inner)? == WorkerHealth::Running {
                return Err(WorkerManagerError::AlreadyRunning);
            }
        }

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);

        let mut child = command
            .spawn()
            .map_err(|error| WorkerManagerError::SpawnFailed(error.to_string()))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();

        {
            let mut inner = lock_inner(&self.inner);
            inner.child = Some(child);
            inner.label = Some(spec.label);
            inner.pid = Some(pid);
            inner.started_at_unix_ms = Some(now_unix_ms());
            inner.last_error = None;
            inner.stdio_connection = None;
        }
        self.emit_status();

        if let Some(stdout) = stdout {
            spawn_diagnostic_reader(
                stdout,
                "stdout",
                self.inner.clone(),
                self.event_sink.clone(),
            );
        }
        if let Some(stderr) = stderr {
            spawn_diagnostic_reader(
                stderr,
                "stderr",
                self.inner.clone(),
                self.event_sink.clone(),
            );
        }

        Ok(())
    }

    pub fn start_stdio_rpc(
        &self,
        spec: WorkerCommandSpec,
        router: WorkerRpcRouter,
    ) -> Result<(), WorkerManagerError> {
        {
            let mut inner = lock_inner(&self.inner);
            if refresh_child_status(&mut inner)? == WorkerHealth::Running {
                return Err(WorkerManagerError::AlreadyRunning);
            }
        }

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);

        let mut child = command
            .spawn()
            .map_err(|error| WorkerManagerError::SpawnFailed(error.to_string()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();

        {
            let mut inner = lock_inner(&self.inner);
            inner.child = Some(child);
            inner.label = Some(spec.label);
            inner.pid = Some(pid);
            inner.started_at_unix_ms = Some(now_unix_ms());
            inner.last_error = None;
        }
        self.emit_status();

        match (stdout, stdin) {
            (Some(stdout), Some(stdin)) => {
                let event_inner = self.inner.clone();
                let event_sink_for_events = self.event_sink.clone();
                let connection =
                    WorkerConnection::start(BufReader::new(stdout), stdin, router, move |event| {
                        record_worker_protocol_event(&event, &event_inner, &event_sink_for_events);
                    });
                let mut inner = lock_inner(&self.inner);
                inner.stdio_connection = Some(connection);
            }
            _ => {
                let message = "worker stdio pipes are unavailable".to_string();
                let mut inner = lock_inner(&self.inner);
                inner.last_error = Some(message.clone());
                inner.diagnostics.push("stderr", message.clone());
                drop(inner);
                emit_worker_event(
                    &self.event_sink,
                    WorkerManagerEvent::Diagnostics(WorkerDiagnosticLine::new("stderr", message)),
                );
            }
        }

        if let Some(stderr) = stderr {
            spawn_diagnostic_reader(
                stderr,
                "stderr",
                self.inner.clone(),
                self.event_sink.clone(),
            );
        }

        Ok(())
    }

    pub fn send_stdio_request(
        &self,
        request: &WorkerRequest,
        timeout: Duration,
    ) -> Result<WorkerResponse, WorkerProtocolError> {
        let connection = {
            let inner = lock_inner(&self.inner);
            inner.stdio_connection.clone()
        }
        .ok_or_else(|| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "worker stdio connection is not running",
                serde_json::json!({
                    "id": request.id,
                    "trace_id": request.trace_id,
                }),
                true,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        connection.send_request(request, timeout)
    }

    pub fn stop(&self) -> Result<(), WorkerManagerError> {
        let child = {
            let mut inner = lock_inner(&self.inner);
            inner.child.take()
        };

        if let Some(mut child) = child {
            terminate_child_process_tree(&mut child)
                .map_err(|error| WorkerManagerError::StopFailed(error.to_string()))?;
            let _ = child.wait();
        }

        let mut inner = lock_inner(&self.inner);
        inner.pid = None;
        inner.label = None;
        inner.started_at_unix_ms = None;
        inner.last_error = None;
        inner.stdio_connection = None;
        drop(inner);
        self.emit_status();
        Ok(())
    }

    pub fn restart(&self, spec: WorkerCommandSpec) -> Result<(), WorkerManagerError> {
        self.stop()?;
        self.start(spec)
    }

    pub fn health_check(&self) -> WorkerHealth {
        let mut inner = lock_inner(&self.inner);
        refresh_child_status(&mut inner).unwrap_or(WorkerHealth::Failed)
    }

    pub fn status(&self) -> WorkerManagerStatus {
        let mut inner = lock_inner(&self.inner);
        let health = refresh_child_status(&mut inner).unwrap_or(WorkerHealth::Failed);
        WorkerManagerStatus {
            state: match health {
                WorkerHealth::Running => WorkerManagerState::Running,
                WorkerHealth::Failed => WorkerManagerState::Failed,
                WorkerHealth::Stopped | WorkerHealth::Exited => WorkerManagerState::Stopped,
            },
            label: inner.label.clone(),
            pid: inner.pid,
            started_at_unix_ms: inner.started_at_unix_ms,
            diagnostics: inner.diagnostics.lines(),
            last_error: inner.last_error.clone(),
        }
    }

    fn emit_status(&self) {
        emit_worker_event(&self.event_sink, WorkerManagerEvent::Status(self.status()));
    }
}

fn refresh_child_status(
    inner: &mut WorkerManagerInner,
) -> Result<WorkerHealth, WorkerManagerError> {
    let Some(child) = inner.child.as_mut() else {
        return Ok(WorkerHealth::Stopped);
    };

    match child.try_wait() {
        Ok(None) => Ok(WorkerHealth::Running),
        Ok(Some(status)) => {
            inner.last_error = Some(format!("worker exited with {status}"));
            inner.child = None;
            inner.pid = None;
            inner.started_at_unix_ms = None;
            inner.stdio_connection = None;
            Ok(WorkerHealth::Exited)
        }
        Err(error) => {
            let message = format!("failed to inspect worker process: {error}");
            inner.last_error = Some(message.clone());
            inner.child = None;
            inner.pid = None;
            inner.started_at_unix_ms = None;
            inner.stdio_connection = None;
            Err(WorkerManagerError::InspectFailed(message))
        }
    }
}

fn spawn_diagnostic_reader<R>(
    reader: R,
    stream: &'static str,
    inner: Arc<Mutex<WorkerManagerInner>>,
    event_sink: Arc<Mutex<Option<WorkerEventSink>>>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines().map_while(Result::ok) {
            let diagnostic = WorkerDiagnosticLine::new(stream, line);
            let mut inner = lock_inner(&inner);
            inner
                .diagnostics
                .push(diagnostic.stream.clone(), diagnostic.line.clone());
            drop(inner);
            emit_worker_event(&event_sink, WorkerManagerEvent::Diagnostics(diagnostic));
        }
    });
}

fn record_worker_protocol_event(
    event: &WorkerEvent,
    inner: &Arc<Mutex<WorkerManagerInner>>,
    event_sink: &Arc<Mutex<Option<WorkerEventSink>>>,
) {
    if event.event != "diagnostics.log" {
        emit_worker_event(event_sink, WorkerManagerEvent::Protocol(event.clone()));
        return;
    }
    let Some(stream) = event
        .payload
        .get("stream")
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };
    let Some(line) = event
        .payload
        .get("line")
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };
    if !matches!(stream, "stdout" | "stderr") {
        return;
    }
    let diagnostic = WorkerDiagnosticLine::new(stream, line);
    let mut inner = lock_inner(inner);
    inner
        .diagnostics
        .push(diagnostic.stream.clone(), diagnostic.line.clone());
    drop(inner);
    emit_worker_event(event_sink, WorkerManagerEvent::Diagnostics(diagnostic));
}

#[cfg(target_os = "windows")]
fn terminate_child_process_tree(child: &mut Child) -> std::io::Result<()> {
    let status = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => child.kill(),
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_child_process_tree(child: &mut Child) -> std::io::Result<()> {
    child.kill()
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn lock_inner(
    inner: &Arc<Mutex<WorkerManagerInner>>,
) -> std::sync::MutexGuard<'_, WorkerManagerInner> {
    inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_event_sink(
    sink: &Arc<Mutex<Option<WorkerEventSink>>>,
) -> std::sync::MutexGuard<'_, Option<WorkerEventSink>> {
    sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn emit_worker_event(event_sink: &Arc<Mutex<Option<WorkerEventSink>>>, event: WorkerManagerEvent) {
    let sink = lock_event_sink(event_sink).clone();
    if let Some(sink) = sink {
        sink(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_rpc::WorkerRpcRouter;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn manager_emits_status_events_on_start_and_stop() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_log = events.clone();
        let manager = WorkerManager::new(20).with_event_sink(move |event| {
            event_log.lock().expect("event log should lock").push(event);
        });

        manager
            .start(test_worker_spec("manager-status-events"))
            .expect("worker should start");
        manager.stop().expect("worker should stop");

        let events = events.lock().expect("event log should lock");

        assert!(events.iter().any(|event| matches!(
            event,
            WorkerManagerEvent::Status(status)
                if status.state == WorkerManagerState::Running
                    && status.label.as_deref() == Some("manager-status-events")
                    && status.pid.is_some()
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerManagerEvent::Status(status)
                if status.state == WorkerManagerState::Stopped && status.pid.is_none()
        )));
    }

    #[test]
    fn manager_emits_diagnostics_events_for_stdout_and_stderr() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_log = events.clone();
        let manager = WorkerManager::new(20).with_event_sink(move |event| {
            event_log.lock().expect("event log should lock").push(event);
        });

        manager
            .start(test_logging_worker_spec())
            .expect("logging worker should start");

        let events = wait_for_events(&events, |events| {
            has_diagnostics_event(events, "stdout", "worker stdout")
                && has_diagnostics_event(events, "stderr", "worker stderr")
        });

        assert!(has_diagnostics_event(&events, "stdout", "worker stdout"));
        assert!(has_diagnostics_event(&events, "stderr", "worker stderr"));
    }

    #[test]
    fn manager_starts_worker_once_and_reports_pid() {
        let manager = WorkerManager::new(20);
        let spec = test_worker_spec("manager-starts-once");

        manager.start(spec.clone()).expect("worker should start");
        let duplicate = manager
            .start(spec)
            .expect_err("running worker should not start twice");
        let status = manager.status();

        assert_eq!(duplicate, WorkerManagerError::AlreadyRunning);
        assert_eq!(status.state, WorkerManagerState::Running);
        assert!(status.pid.is_some());

        manager.stop().expect("worker should stop");
    }

    #[test]
    fn manager_restart_replaces_running_worker() {
        let manager = WorkerManager::new(20);

        manager
            .start(test_worker_spec("manager-restart-before"))
            .expect("worker should start");
        let before = manager
            .status()
            .pid
            .expect("running worker should expose pid");

        manager
            .restart(test_worker_spec("manager-restart-after"))
            .expect("worker should restart");
        let after = manager
            .status()
            .pid
            .expect("restarted worker should expose pid");

        assert_ne!(before, after);
        assert_eq!(manager.health_check(), WorkerHealth::Running);

        manager.stop().expect("worker should stop");
    }

    #[test]
    fn manager_captures_stdout_and_stderr_diagnostics() {
        let manager = WorkerManager::new(20);

        manager
            .start(test_logging_worker_spec())
            .expect("logging worker should start");

        let diagnostics = wait_for_diagnostics(&manager, |diagnostics| {
            has_diagnostic_line(diagnostics, "stdout", "worker stdout")
                && has_diagnostic_line(diagnostics, "stderr", "worker stderr")
        });

        assert!(has_diagnostic_line(&diagnostics, "stdout", "worker stdout"));
        assert!(has_diagnostic_line(&diagnostics, "stderr", "worker stderr"));
    }

    #[test]
    fn manager_status_records_last_error_after_exited_worker_health_check() {
        let manager = WorkerManager::new(20);

        manager
            .start(test_logging_worker_spec())
            .expect("short worker should start");

        assert_eq!(
            wait_for_health(&manager, WorkerHealth::Exited),
            WorkerHealth::Exited
        );
        let status = manager.status();

        assert_eq!(status.state, WorkerManagerState::Stopped);
        assert!(status.pid.is_none());
        assert!(status
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("worker exited")));
    }

    #[test]
    fn manager_serves_stdio_worker_rpc_requests() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello manager rpc");
        let manager = WorkerManager::new(20);
        let router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );

        manager
            .start_stdio_rpc(test_stdio_rpc_worker_spec(), router)
            .expect("stdio RPC worker should start");

        let diagnostics = wait_for_diagnostics(&manager, |diagnostics| {
            has_diagnostic_line(diagnostics, "stderr", "hello manager rpc")
        });

        assert!(has_diagnostic_line(
            &diagnostics,
            "stderr",
            "notes/today.md"
        ));
        assert!(has_diagnostic_line(
            &diagnostics,
            "stderr",
            "hello manager rpc"
        ));
    }

    #[test]
    fn manager_records_stdio_worker_diagnostics_events() {
        let fixture = WorkspaceFixture::new();
        let manager = WorkerManager::new(20);
        let router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );

        manager
            .start_stdio_rpc(test_stdio_event_worker_spec(), router)
            .expect("stdio event worker should start");

        let diagnostics = wait_for_diagnostics(&manager, |diagnostics| {
            has_diagnostic_line(diagnostics, "stdout", "protocol event ready")
        });

        assert!(has_diagnostic_line(
            &diagnostics,
            "stdout",
            "protocol event ready"
        ));
    }

    #[test]
    fn manager_full_duplex_stdio_request_allows_worker_rust_rpc_before_response() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        let manager = WorkerManager::new(20);
        let router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );

        manager
            .start_stdio_rpc(test_stdio_agent_echo_worker_spec(), router)
            .expect("stdio agent worker should start");

        let request = WorkerRequest::new(
            "agent-req-1",
            "trace-agent",
            "agent.echo",
            json!({ "input": "hello" }),
        );
        let response = manager
            .send_stdio_request(&request, std::time::Duration::from_secs(3))
            .expect("agent request should complete");

        assert_eq!(response.result.as_ref().unwrap()["ok"], true);
        assert_eq!(response.result.as_ref().unwrap()["echo"], "hello");
        assert_eq!(response.result.as_ref().unwrap()["workspaceFileCount"], 1);
    }

    #[test]
    fn manager_forwards_non_diagnostic_worker_protocol_events() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_log = events.clone();
        let fixture = WorkspaceFixture::new();
        let manager = WorkerManager::new(20).with_event_sink(move |event| {
            event_log.lock().expect("event log should lock").push(event);
        });
        let router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );

        manager
            .start_stdio_rpc(test_stdio_agent_event_worker_spec(), router)
            .expect("stdio event worker should start");

        let events = wait_for_events(&events, |events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    WorkerManagerEvent::Protocol(protocol_event)
                        if protocol_event.event == "agent.delta"
                            && protocol_event.payload["message"] == "starting"
                )
            })
        });

        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.delta"
                        && protocol_event.payload["message"] == "starting"
            )
        }));
    }

    #[test]
    fn manager_runs_real_ts_worker_fixture_agent_echo() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_log = events.clone();
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        fixture.write("notes/today.md", "hello ts worker");
        let manager = WorkerManager::new(20).with_event_sink(move |event| {
            event_log.lock().expect("event log should lock").push(event);
        });
        let router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ConfigRead,
                WorkerCapability::FsWorkspaceRead,
                WorkerCapability::DiagnosticsWrite,
            ]),
        );

        manager
            .start_stdio_rpc(ts_worker_fixture_spec(), router)
            .expect("TS fixture should start");

        let request = WorkerRequest::new(
            "agent-req-ts-1",
            "trace-ts-agent",
            "agent.echo",
            json!({ "input": "hello from rust" }),
        );
        let response = manager
            .send_stdio_request(&request, std::time::Duration::from_secs(5))
            .expect("agent request should complete");
        let events = wait_for_events(&events, |events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    WorkerManagerEvent::Protocol(protocol_event)
                        if protocol_event.event == "agent.delta"
                            && protocol_event.payload["message"] == "read native state"
                )
            })
        });

        let result = response.result.expect("TS fixture should return result");
        assert_eq!(result["ok"], true);
        assert_eq!(result["echo"], "hello from rust");
        assert_eq!(result["configValue"], "gpt-5");
        assert_eq!(result["workspaceFileCount"], 2);
        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.delta"
                        && protocol_event.payload["message"] == "starting"
            )
        }));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.delta"
                        && protocol_event.payload["message"] == "read native state"
            )
        }));
    }

    #[test]
    fn manager_runs_real_ts_worker_fixture_agent_event_flow() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_log = events.clone();
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        let manager = WorkerManager::new(20).with_event_sink(move |event| {
            event_log.lock().expect("event log should lock").push(event);
        });
        let router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::DiagnosticsWrite]),
        );

        manager
            .start_stdio_rpc(ts_worker_fixture_spec(), router)
            .expect("TS fixture should start");

        let request = WorkerRequest::new(
            "agent-req-ts-flow-1",
            "trace-ts-agent-flow",
            "agent.fixture_flow",
            json!({ "runId": "fixture-run-1" }),
        );
        let response = manager
            .send_stdio_request(&request, std::time::Duration::from_secs(5))
            .expect("agent flow request should complete");
        let events = wait_for_events(&events, |events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    WorkerManagerEvent::Protocol(protocol_event)
                        if protocol_event.event == "agent.done"
                            && protocol_event.payload["runId"] == "fixture-run-1"
                )
            })
        });

        let result = response.result.expect("TS fixture should return result");
        assert_eq!(result["finalContent"], "fixture final");
        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.delta"
                        && protocol_event.payload["runId"] == "fixture-run-1"
            )
        }));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.checkpoint"
                        && protocol_event.payload["phase"] == "awaiting_tools"
            )
        }));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.tool.start"
                        && protocol_event.payload["toolName"] == "fixture_tool"
            )
        }));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.tool.result"
                        && protocol_event.payload["content"] == "fixture tool result"
            )
        }));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.done"
                        && protocol_event.payload["stopReason"] == "final_response"
            )
        }));
    }

    fn test_worker_spec(label: &str) -> WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            WorkerCommandSpec::new(
                "cmd",
                ["/C", "ping", "-n", "30", "127.0.0.1", ">", "NUL"],
                PathBuf::from("."),
            )
            .with_label(label)
        }

        #[cfg(not(target_os = "windows"))]
        {
            WorkerCommandSpec::new("sh", ["-c", "sleep 30"], PathBuf::from(".")).with_label(label)
        }
    }

    fn test_logging_worker_spec() -> WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            WorkerCommandSpec::new(
                "cmd",
                ["/C", "echo worker stdout && echo worker stderr 1>&2"],
                PathBuf::from("."),
            )
        }

        #[cfg(not(target_os = "windows"))]
        {
            WorkerCommandSpec::new(
                "sh",
                ["-c", "echo worker stdout && echo worker stderr >&2"],
                PathBuf::from("."),
            )
        }
    }

    fn test_stdio_rpc_worker_spec() -> WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","method":"workspace.read_file","params":{"path":"notes/today.md"}}'; [Console]::Out.WriteLine($json); $line = [Console]::In.ReadLine(); [Console]::Error.WriteLine($line)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-rpc-worker")
        }

        #[cfg(not(target_os = "windows"))]
        {
            WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","method":"workspace.read_file","params":{"path":"notes/today.md"}}'; printf '%s\n' "$json"; IFS= read -r line; printf '%s\n' "$line" >&2"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-rpc-worker")
        }
    }

    fn test_stdio_event_worker_spec() -> WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","trace_id":"trace-event","event":"diagnostics.log","payload":{"stream":"stdout","line":"protocol event ready"}}'; [Console]::Out.WriteLine($json)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-event-worker")
        }

        #[cfg(not(target_os = "windows"))]
        {
            WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","trace_id":"trace-event","event":"diagnostics.log","payload":{"stream":"stdout","line":"protocol event ready"}}'; printf '%s\n' "$json""#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-event-worker")
        }
    }

    fn test_stdio_agent_echo_worker_spec() -> WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$agent = [Console]::In.ReadLine(); $nativeReq = '{"protocol_version":"1","id":"worker-req-1","trace_id":"trace-worker","method":"workspace.list_files","params":{}}'; [Console]::Out.WriteLine($nativeReq); $nativeResp = [Console]::In.ReadLine() | ConvertFrom-Json; $agentObj = $agent | ConvertFrom-Json; $count = $nativeResp.result.Count; $echo = $agentObj.params.input; $final = @{ protocol_version = '1'; id = $agentObj.id; trace_id = $agentObj.trace_id; result = @{ ok = $true; echo = $echo; workspaceFileCount = $count } } | ConvertTo-Json -Compress -Depth 8; [Console]::Out.WriteLine($final)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
        }

        #[cfg(not(target_os = "windows"))]
        {
            WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"IFS= read -r agent; printf '%s\n' '{"protocol_version":"1","id":"worker-req-1","trace_id":"trace-worker","method":"workspace.list_files","params":{}}'; IFS= read -r native_resp; printf '%s\n' '{"protocol_version":"1","id":"agent-req-1","trace_id":"trace-agent","result":{"ok":true,"echo":"hello","workspaceFileCount":1}}'"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
        }
    }

    fn test_stdio_agent_event_worker_spec() -> WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","trace_id":"trace-agent-event","event":"agent.delta","payload":{"message":"starting"}}'; [Console]::Out.WriteLine($json)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-event-worker")
        }

        #[cfg(not(target_os = "windows"))]
        {
            WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","trace_id":"trace-agent-event","event":"agent.delta","payload":{"message":"starting"}}'; printf '%s\n' "$json""#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-event-worker")
        }
    }

    fn ts_worker_fixture_spec() -> WorkerCommandSpec {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let desktop_dir = manifest_dir
            .parent()
            .expect("src-tauri should have desktop parent")
            .to_path_buf();
        WorkerCommandSpec::new(
            "node",
            ["workers/ts-worker-fixture/src/index.ts"],
            desktop_dir,
        )
        .with_label("ts-worker-fixture")
    }

    fn wait_for_health(manager: &WorkerManager, expected: WorkerHealth) -> WorkerHealth {
        for _ in 0..30 {
            let health = manager.health_check();
            if health == expected {
                return health;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        manager.health_check()
    }

    fn wait_for_diagnostics(
        manager: &WorkerManager,
        predicate: impl Fn(&[WorkerDiagnosticLine]) -> bool,
    ) -> Vec<WorkerDiagnosticLine> {
        for _ in 0..30 {
            let diagnostics = manager.status().diagnostics;
            if predicate(&diagnostics) {
                return diagnostics;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        manager.status().diagnostics
    }

    fn wait_for_events(
        events: &Arc<Mutex<Vec<WorkerManagerEvent>>>,
        predicate: impl Fn(&[WorkerManagerEvent]) -> bool,
    ) -> Vec<WorkerManagerEvent> {
        for _ in 0..30 {
            let snapshot = events.lock().expect("event log should lock").clone();
            if predicate(&snapshot) {
                return snapshot;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        events.lock().expect("event log should lock").clone()
    }

    fn has_diagnostic_line(
        diagnostics: &[WorkerDiagnosticLine],
        stream: &str,
        expected: &str,
    ) -> bool {
        diagnostics
            .iter()
            .any(|line| line.stream == stream && line.line.contains(expected))
    }

    fn has_diagnostics_event(events: &[WorkerManagerEvent], stream: &str, expected: &str) -> bool {
        events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Diagnostics(line)
                    if line.stream == stream && line.line.contains(expected)
            )
        })
    }

    struct WorkspaceFixture {
        root: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-manager-rpc-{}-{}",
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
