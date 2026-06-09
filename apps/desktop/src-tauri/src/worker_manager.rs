use crate::worker_protocol::{WorkerDiagnosticLine, WorkerDiagnostics};
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
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

#[derive(Clone, Debug)]
pub struct WorkerManager {
    inner: Arc<Mutex<WorkerManagerInner>>,
}

#[derive(Debug)]
struct WorkerManagerInner {
    child: Option<Child>,
    label: Option<String>,
    pid: Option<u32>,
    started_at_unix_ms: Option<u128>,
    diagnostics: WorkerDiagnostics,
    last_error: Option<String>,
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
            })),
        }
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
        }

        if let Some(stdout) = stdout {
            spawn_diagnostic_reader(stdout, "stdout", self.inner.clone());
        }
        if let Some(stderr) = stderr {
            spawn_diagnostic_reader(stderr, "stderr", self.inner.clone());
        }

        Ok(())
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
            Ok(WorkerHealth::Exited)
        }
        Err(error) => {
            let message = format!("failed to inspect worker process: {error}");
            inner.last_error = Some(message.clone());
            inner.child = None;
            inner.pid = None;
            inner.started_at_unix_ms = None;
            Err(WorkerManagerError::InspectFailed(message))
        }
    }
}

fn spawn_diagnostic_reader<R>(
    reader: R,
    stream: &'static str,
    inner: Arc<Mutex<WorkerManagerInner>>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines().map_while(Result::ok) {
            let mut inner = lock_inner(&inner);
            inner.diagnostics.push(stream, line);
        }
    });
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
        std::thread::sleep(std::time::Duration::from_millis(900));

        let diagnostics = manager.status().diagnostics;

        assert!(diagnostics
            .iter()
            .any(|line| line.stream == "stdout" && line.line.contains("worker stdout")));
        assert!(diagnostics
            .iter()
            .any(|line| line.stream == "stderr" && line.line.contains("worker stderr")));
    }

    #[test]
    fn manager_status_records_last_error_after_exited_worker_health_check() {
        let manager = WorkerManager::new(20);

        manager
            .start(test_logging_worker_spec())
            .expect("short worker should start");

        assert_eq!(wait_for_health(&manager, WorkerHealth::Exited), WorkerHealth::Exited);
        let status = manager.status();

        assert_eq!(status.state, WorkerManagerState::Stopped);
        assert!(status.pid.is_none());
        assert!(status
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("worker exited")));
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
            WorkerCommandSpec::new("sh", ["-c", "sleep 30"], PathBuf::from("."))
                .with_label(label)
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
}
