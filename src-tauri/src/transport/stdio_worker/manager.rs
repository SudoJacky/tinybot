use crate::protocol::{
    WorkerDiagnosticLine, WorkerDiagnostics, WorkerEvent, WorkerProtocolError,
    WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest, WorkerResponse,
};
use crate::rpc::WorkerRpcRouter;
use crate::transport::stdio_worker::connection::WorkerConnection;
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
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerHealth {
    Stopped,
    Starting,
    Running,
    Stopping,
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
    lifecycle: WorkerProcessLifecycle,
    child: Option<Child>,
    label: Option<String>,
    pid: Option<u32>,
    started_at_unix_ms: Option<u128>,
    diagnostics: WorkerDiagnostics,
    last_error: Option<String>,
    stdio_connection: Option<WorkerConnection<ChildStdin>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkerProcessLifecycle {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

impl WorkerManager {
    pub fn new(diagnostic_capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(WorkerManagerInner {
                lifecycle: WorkerProcessLifecycle::Stopped,
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

    #[cfg(test)]
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

    #[cfg(test)]
    pub fn start(&self, spec: WorkerCommandSpec) -> Result<(), WorkerManagerError> {
        {
            let mut inner = lock_inner(&self.inner);
            if matches!(
                refresh_child_status(&mut inner)?,
                WorkerHealth::Running | WorkerHealth::Starting | WorkerHealth::Stopping
            ) {
                return Err(WorkerManagerError::AlreadyRunning);
            }
            inner.lifecycle = WorkerProcessLifecycle::Starting;
            inner.label = Some(spec.label.clone());
            inner.pid = None;
            inner.started_at_unix_ms = None;
            inner.last_error = None;
            inner.stdio_connection = None;
        }
        self.emit_status();

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("failed to spawn worker: {error}");
                let mut inner = lock_inner(&self.inner);
                inner.lifecycle = WorkerProcessLifecycle::Failed;
                inner.child = None;
                inner.label = Some(spec.label);
                inner.pid = None;
                inner.started_at_unix_ms = None;
                inner.last_error = Some(message.clone());
                inner.stdio_connection = None;
                drop(inner);
                self.emit_status();
                return Err(WorkerManagerError::SpawnFailed(error.to_string()));
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();

        {
            let mut inner = lock_inner(&self.inner);
            inner.lifecycle = WorkerProcessLifecycle::Running;
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
            if matches!(
                refresh_child_status(&mut inner)?,
                WorkerHealth::Running | WorkerHealth::Starting | WorkerHealth::Stopping
            ) {
                return Err(WorkerManagerError::AlreadyRunning);
            }
            inner.lifecycle = WorkerProcessLifecycle::Starting;
            inner.label = Some(spec.label.clone());
            inner.pid = None;
            inner.started_at_unix_ms = None;
            inner.last_error = None;
            inner.stdio_connection = None;
        }
        self.emit_status();

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("failed to spawn worker: {error}");
                let mut inner = lock_inner(&self.inner);
                inner.lifecycle = WorkerProcessLifecycle::Failed;
                inner.child = None;
                inner.label = Some(spec.label);
                inner.pid = None;
                inner.started_at_unix_ms = None;
                inner.last_error = Some(message.clone());
                inner.stdio_connection = None;
                drop(inner);
                self.emit_status();
                return Err(WorkerManagerError::SpawnFailed(error.to_string()));
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();

        {
            let mut inner = lock_inner(&self.inner);
            inner.lifecycle = WorkerProcessLifecycle::Running;
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
            if !matches!(inner.lifecycle, WorkerProcessLifecycle::Stopped) {
                inner.lifecycle = WorkerProcessLifecycle::Stopping;
            }
            inner.child.take()
        };
        self.emit_status();

        if let Some(mut child) = child {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    if let Err(error) = terminate_child_process_tree(&mut child) {
                        let mut inner = lock_inner(&self.inner);
                        inner.lifecycle = WorkerProcessLifecycle::Failed;
                        inner.last_error = Some(format!("failed to stop worker: {error}"));
                        drop(inner);
                        self.emit_status();
                        return Err(WorkerManagerError::StopFailed(error.to_string()));
                    }
                    let _ = child.wait();
                }
                Err(error) => {
                    let mut inner = lock_inner(&self.inner);
                    inner.lifecycle = WorkerProcessLifecycle::Failed;
                    inner.last_error =
                        Some(format!("failed to inspect worker before stop: {error}"));
                    drop(inner);
                    self.emit_status();
                    return Err(WorkerManagerError::StopFailed(error.to_string()));
                }
            }
        }

        let mut inner = lock_inner(&self.inner);
        inner.lifecycle = WorkerProcessLifecycle::Stopped;
        inner.pid = None;
        inner.label = None;
        inner.started_at_unix_ms = None;
        inner.last_error = None;
        inner.stdio_connection = None;
        drop(inner);
        self.emit_status();
        Ok(())
    }

    #[cfg(test)]
    pub fn restart(&self, spec: WorkerCommandSpec) -> Result<(), WorkerManagerError> {
        self.stop()?;
        self.start(spec)
    }

    #[cfg(test)]
    pub fn restart_stdio_rpc(
        &self,
        spec: WorkerCommandSpec,
        router: WorkerRpcRouter,
    ) -> Result<(), WorkerManagerError> {
        self.stop()?;
        self.start_stdio_rpc(spec, router)
    }

    #[cfg(test)]
    pub fn health_check(&self) -> WorkerHealth {
        let mut inner = lock_inner(&self.inner);
        refresh_child_status(&mut inner).unwrap_or(WorkerHealth::Failed)
    }

    pub fn status(&self) -> WorkerManagerStatus {
        let mut inner = lock_inner(&self.inner);
        let health = refresh_child_status(&mut inner).unwrap_or(WorkerHealth::Failed);
        WorkerManagerStatus {
            state: match health {
                WorkerHealth::Starting => WorkerManagerState::Starting,
                WorkerHealth::Running => WorkerManagerState::Running,
                WorkerHealth::Stopping => WorkerManagerState::Stopping,
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
    match inner.lifecycle {
        WorkerProcessLifecycle::Starting if inner.child.is_none() => {
            return Ok(WorkerHealth::Starting);
        }
        WorkerProcessLifecycle::Stopping if inner.child.is_none() => {
            return Ok(WorkerHealth::Stopping);
        }
        WorkerProcessLifecycle::Failed if inner.child.is_none() => {
            return Ok(WorkerHealth::Failed);
        }
        WorkerProcessLifecycle::Stopped if inner.child.is_none() => {
            return Ok(WorkerHealth::Stopped);
        }
        _ => {}
    }

    let Some(child) = inner.child.as_mut() else {
        inner.lifecycle = WorkerProcessLifecycle::Stopped;
        return Ok(WorkerHealth::Stopped);
    };

    match child.try_wait() {
        Ok(None) => Ok(match inner.lifecycle {
            WorkerProcessLifecycle::Starting => WorkerHealth::Starting,
            WorkerProcessLifecycle::Stopping => WorkerHealth::Stopping,
            _ => WorkerHealth::Running,
        }),
        Ok(Some(status)) => {
            inner.last_error = Some(format!("worker exited with {status}"));
            inner.lifecycle = WorkerProcessLifecycle::Stopped;
            inner.child = None;
            inner.pid = None;
            inner.started_at_unix_ms = None;
            inner.stdio_connection = None;
            Ok(WorkerHealth::Exited)
        }
        Err(error) => {
            let message = format!("failed to inspect worker process: {error}");
            inner.last_error = Some(message.clone());
            inner.lifecycle = WorkerProcessLifecycle::Failed;
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
#[path = "manager_tests.rs"]
mod tests;
