#[cfg(target_os = "windows")]
use super::sandbox::windows::{
    spawn_read_only_pipe_process, WindowsProcessJob, WindowsReadOnlyChild,
};
use super::{
    sandbox::ShellSandboxAdapter, shell_command, shell_error, ShellOutputChunk,
    ShellProcessCleanupReport, ShellProcessOutput,
};
use crate::worker_protocol::{WorkerProtocolError, WorkerRequestCancellation};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_PROCESS_RECORDS: usize = 64;
const MAX_YIELD_TIME_MS: u64 = 30_000;
const TERMINATION_WAIT: Duration = Duration::from_secs(2);
const OUTPUT_HEAD_BYTES: usize = 256 * 1024;
const OUTPUT_TAIL_BYTES: usize = 768 * 1024;

pub(super) struct ValidatedShellStart {
    pub(super) command: String,
    pub(super) working_dir: PathBuf,
    pub(super) working_dir_display: String,
    pub(super) tty: bool,
    pub(super) yield_time_ms: u64,
    pub(super) rows: u16,
    pub(super) cols: u16,
    pub(super) run_id: Option<String>,
    pub(super) tool_call_id: Option<String>,
    pub(super) cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    pub(super) sandbox_adapter: ShellSandboxAdapter,
    pub(super) sandbox_mode: String,
    pub(super) network_mode: String,
    pub(super) approval_decision: String,
}

#[derive(Clone)]
pub(super) struct ShellProcessManager {
    inner: Arc<ShellProcessManagerInner>,
}

struct ShellProcessManagerInner {
    next_process_id: AtomicU64,
    accepting_starts: AtomicBool,
    starting_processes: AtomicUsize,
    processes: Mutex<HashMap<String, Arc<ShellProcessRecord>>>,
}

impl fmt::Debug for ShellProcessManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShellProcessManager")
            .field("active_process_count", &self.active_count())
            .finish()
    }
}

impl ShellProcessManager {
    pub(super) fn new() -> Self {
        Self {
            inner: Arc::new(ShellProcessManagerInner {
                next_process_id: AtomicU64::new(1),
                accepting_starts: AtomicBool::new(true),
                starting_processes: AtomicUsize::new(0),
                processes: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(super) fn start(
        &self,
        request: ValidatedShellStart,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        let process_id = format!(
            "process-{}",
            self.inner.next_process_id.fetch_add(1, Ordering::Relaxed)
        );
        let cancellation = request.cancellation.clone();
        let yield_time_ms = clamp_yield_time(request.yield_time_ms);
        self.reserve_process_slot()?;
        let spawned = if request.tty {
            if request.sandbox_adapter != ShellSandboxAdapter::Unsandboxed {
                Err(shell_error(
                    "selected shell sandbox adapter does not support PTY execution",
                    serde_json::json!({
                        "processStarted": false,
                        "sandboxMode": request.sandbox_mode,
                    }),
                ))
            } else {
                spawn_pty_process(process_id, request)
            }
        } else {
            spawn_pipe_process(process_id, request)
        };
        let record = match spawned {
            Ok(record) => record,
            Err(error) => {
                self.cancel_process_slot();
                return Err(error);
            }
        };
        if !self.commit_process_slot(record.clone()) {
            let termination = terminate_record(&record, ProcessTerminationReason::Terminated);
            if termination.is_ok() {
                let removed = self
                    .inner
                    .processes
                    .lock()
                    .expect("shell process store lock should not be poisoned")
                    .remove(&record.process_id);
                if let Some(removed) = removed {
                    removed.join_threads();
                }
            }
            return Err(shell_error(
                "shell process manager shut down while process was starting",
                serde_json::json!({
                    "processId": record.process_id,
                    "cleanupError": termination.err().map(|error| error.message),
                }),
            ));
        }
        if let Some(cancellation) = cancellation {
            let cancellation_record = record.clone();
            record.add_thread(thread::spawn(move || {
                while cancellation_record.is_running() {
                    if cancellation.is_cancelled() {
                        if let Err(error) = terminate_record(
                            &cancellation_record,
                            ProcessTerminationReason::Cancelled,
                        ) {
                            cancellation_record.record_failure(error.message);
                        }
                        break;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
            }));
        }
        record.wait_for_terminal(Duration::from_millis(yield_time_ms));
        Ok(record.snapshot(0))
    }

    pub(super) fn poll(
        &self,
        process_id: &str,
        run_id: Option<&str>,
        cursor: u64,
        yield_time_ms: u64,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        let record = self.lookup(process_id, run_id)?;
        Ok(record.wait_for_output(
            cursor,
            Duration::from_millis(clamp_yield_time(yield_time_ms)),
        ))
    }

    pub(super) fn write_stdin(
        &self,
        process_id: &str,
        run_id: Option<&str>,
        input: &[u8],
        cursor: u64,
        yield_time_ms: u64,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        let record = self.lookup(process_id, run_id)?;
        if !input.is_empty() {
            record.write_stdin(input)?;
        }
        Ok(record.wait_for_output(
            cursor,
            Duration::from_millis(clamp_yield_time(yield_time_ms)),
        ))
    }

    pub(super) fn resize(
        &self,
        process_id: &str,
        run_id: Option<&str>,
        rows: u16,
        cols: u16,
    ) -> Result<(), WorkerProtocolError> {
        let record = self.lookup(process_id, run_id)?;
        record.resize(rows, cols)
    }

    pub(super) fn interrupt(
        &self,
        process_id: &str,
        run_id: Option<&str>,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        let record = self.lookup(process_id, run_id)?;
        record.interrupt()?;
        Ok(record.snapshot(0))
    }

    pub(super) fn terminate(
        &self,
        process_id: &str,
        run_id: Option<&str>,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        let record = self.lookup(process_id, run_id)?;
        terminate_record(&record, ProcessTerminationReason::Terminated)?;
        Ok(record.snapshot(0))
    }

    pub(super) fn timeout(
        &self,
        process_id: &str,
        run_id: Option<&str>,
    ) -> Result<ShellProcessOutput, WorkerProtocolError> {
        let record = self.lookup(process_id, run_id)?;
        terminate_record(&record, ProcessTerminationReason::TimedOut)?;
        Ok(record.snapshot(0))
    }

    pub(super) fn terminate_run(&self, run_id: &str) -> ShellProcessCleanupReport {
        let records = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned")
            .values()
            .filter(|record| record.run_id.as_deref() == Some(run_id) && record.is_running())
            .cloned()
            .collect::<Vec<_>>();
        cleanup_records(records, ProcessTerminationReason::Terminated)
    }

    pub(super) fn shutdown(&self) -> ShellProcessCleanupReport {
        let mut report = ShellProcessCleanupReport::default();
        {
            let _processes = self
                .inner
                .processes
                .lock()
                .expect("shell process store lock should not be poisoned");
            self.inner.accepting_starts.store(false, Ordering::Release);
        }
        let start_deadline = Instant::now() + TERMINATION_WAIT;
        while self.inner.starting_processes.load(Ordering::Acquire) > 0
            && Instant::now() < start_deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        let starting_processes = self.inner.starting_processes.load(Ordering::Acquire);
        if starting_processes > 0 {
            report.failures.push(format!(
                "{starting_processes} shell process starts did not finish before shutdown timeout"
            ));
        }
        let records = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned")
            .values()
            .filter(|record| record.is_running())
            .cloned()
            .collect::<Vec<_>>();
        let cleanup = cleanup_records(records, ProcessTerminationReason::Terminated);
        report
            .requested_process_ids
            .extend(cleanup.requested_process_ids);
        report
            .terminated_process_ids
            .extend(cleanup.terminated_process_ids);
        report.failures.extend(cleanup.failures);
        let released = {
            let mut processes = self
                .inner
                .processes
                .lock()
                .expect("shell process store lock should not be poisoned");
            let terminal_ids = processes
                .iter()
                .filter(|(_, record)| !record.is_running())
                .map(|(process_id, _)| process_id.clone())
                .collect::<Vec<_>>();
            terminal_ids
                .into_iter()
                .filter_map(|process_id| processes.remove(&process_id))
                .collect::<Vec<_>>()
        };
        for record in released {
            record.join_threads();
        }
        report
    }

    pub(super) fn resume_accepting(&self) -> Result<(), WorkerProtocolError> {
        let processes = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned");
        let starting_processes = self.inner.starting_processes.load(Ordering::Acquire);
        let active_processes = processes
            .values()
            .filter(|record| record.is_running())
            .count();
        if starting_processes > 0 || active_processes > 0 {
            return Err(shell_error(
                "shell process manager cannot resume while cleanup is incomplete",
                serde_json::json!({
                    "startingProcesses": starting_processes,
                    "activeProcesses": active_processes,
                }),
            ));
        }
        self.inner.accepting_starts.store(true, Ordering::Release);
        Ok(())
    }

    pub(super) fn active_count(&self) -> usize {
        self.inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned")
            .values()
            .filter(|record| record.is_running())
            .count()
    }

    pub(super) fn list(&self, run_id: Option<&str>) -> Vec<ShellProcessOutput> {
        let records = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned")
            .values()
            .filter(|record| run_id.is_none_or(|run_id| record.run_id.as_deref() == Some(run_id)))
            .cloned()
            .collect::<Vec<_>>();
        let mut outputs = records
            .into_iter()
            .map(|record| record.snapshot(0))
            .collect::<Vec<_>>();
        outputs.sort_by_key(|output| (output.started_at_ms, output.process_id.clone()));
        outputs
    }

    pub(super) fn release(&self, process_id: &str) -> Result<(), WorkerProtocolError> {
        let record = self.lookup(process_id, None)?;
        if record.is_running() {
            return Err(shell_error(
                "running shell process cannot be released",
                serde_json::json!({ "processId": process_id }),
            ));
        }
        let removed = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned")
            .remove(process_id);
        let removed = removed.ok_or_else(|| unknown_process_error(process_id))?;
        removed.join_threads();
        Ok(())
    }

    fn lookup(
        &self,
        process_id: &str,
        run_id: Option<&str>,
    ) -> Result<Arc<ShellProcessRecord>, WorkerProtocolError> {
        let record = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned")
            .get(process_id)
            .cloned()
            .ok_or_else(|| unknown_process_error(process_id))?;
        if record.run_id.as_deref() != run_id {
            return Err(shell_error(
                "shell process owner does not match requested run",
                serde_json::json!({
                    "processId": process_id,
                    "requestedRunId": run_id,
                    "ownerRunId": record.run_id,
                }),
            ));
        }
        Ok(record)
    }

    fn reserve_process_slot(&self) -> Result<(), WorkerProtocolError> {
        let removed = {
            let mut processes = self
                .inner
                .processes
                .lock()
                .expect("shell process store lock should not be poisoned");
            let starting = self.inner.starting_processes.load(Ordering::Acquire);
            if !self.inner.accepting_starts.load(Ordering::Acquire) {
                return Err(shell_error(
                    "shell process manager is shutting down",
                    serde_json::json!({}),
                ));
            }
            let removed = if processes.len().saturating_add(starting) >= MAX_PROCESS_RECORDS {
                let removable = processes
                    .iter()
                    .filter(|(_, record)| !record.is_running())
                    .min_by_key(|(_, record)| record.last_activity_ms())
                    .map(|(process_id, _)| process_id.clone());
                let Some(removable) = removable else {
                    return Err(shell_error(
                        "shell process capacity reached",
                        serde_json::json!({
                            "capacity": MAX_PROCESS_RECORDS,
                            "activeProcesses": processes.len(),
                        }),
                    ));
                };
                processes.remove(&removable)
            } else {
                None
            };
            self.inner
                .starting_processes
                .fetch_add(1, Ordering::Release);
            removed
        };
        if let Some(record) = removed {
            record.join_threads();
        }
        Ok(())
    }

    fn commit_process_slot(&self, record: Arc<ShellProcessRecord>) -> bool {
        let mut processes = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned");
        let replaced = processes.insert(record.process_id.clone(), record);
        assert!(replaced.is_none(), "shell process ids must be unique");
        let previous = self
            .inner
            .starting_processes
            .fetch_sub(1, Ordering::Release);
        assert!(previous > 0, "shell process slot reservation must exist");
        self.inner.accepting_starts.load(Ordering::Acquire)
    }

    fn cancel_process_slot(&self) {
        let _processes = self
            .inner
            .processes
            .lock()
            .expect("shell process store lock should not be poisoned");
        let previous = self
            .inner
            .starting_processes
            .fetch_sub(1, Ordering::Release);
        assert!(previous > 0, "shell process slot reservation must exist");
    }
}

fn cleanup_records(
    records: Vec<Arc<ShellProcessRecord>>,
    reason: ProcessTerminationReason,
) -> ShellProcessCleanupReport {
    let mut report = ShellProcessCleanupReport::default();
    for record in records {
        report.requested_process_ids.push(record.process_id.clone());
        match terminate_record(&record, reason) {
            Ok(()) => report
                .terminated_process_ids
                .push(record.process_id.clone()),
            Err(error) => report
                .failures
                .push(format!("{}: {}", record.process_id, error.message)),
        }
    }
    report
}

fn spawn_pipe_process(
    process_id: String,
    request: ValidatedShellStart,
) -> Result<Arc<ShellProcessRecord>, WorkerProtocolError> {
    match request.sandbox_adapter {
        ShellSandboxAdapter::Unsandboxed => spawn_unsandboxed_pipe_process(process_id, request),
        #[cfg(target_os = "windows")]
        ShellSandboxAdapter::WindowsReadOnly => {
            spawn_windows_read_only_pipe_process(process_id, request)
        }
        #[cfg(not(target_os = "windows"))]
        ShellSandboxAdapter::WindowsReadOnly => Err(shell_error(
            "Windows read-only shell adapter is unavailable on this platform",
            serde_json::json!({ "processStarted": false }),
        )),
    }
}

fn spawn_unsandboxed_pipe_process(
    process_id: String,
    request: ValidatedShellStart,
) -> Result<Arc<ShellProcessRecord>, WorkerProtocolError> {
    let mut command = shell_command(&request.command);
    command
        .current_dir(&request.working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    #[cfg(target_os = "windows")]
    let job = WindowsProcessJob::new().map_err(|error| {
        shell_error(
            "failed to create shell process job",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    let mut child = command.spawn().map_err(|error| {
        shell_error(
            "failed to start shell process",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    #[cfg(target_os = "windows")]
    if let Err(error) = job.assign(&child) {
        let _ = super::terminate_child_process(&mut child);
        return Err(shell_error(
            "failed to assign shell process to job",
            serde_json::json!({ "error": error.to_string() }),
        ));
    }
    let system_process_id = child.id();
    let stdin = child.stdin.take().ok_or_else(|| {
        shell_error(
            "shell process stdin pipe is unavailable",
            serde_json::json!({ "systemProcessId": system_process_id }),
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        shell_error(
            "shell process stdout pipe is unavailable",
            serde_json::json!({ "systemProcessId": system_process_id }),
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        shell_error(
            "shell process stderr pipe is unavailable",
            serde_json::json!({ "systemProcessId": system_process_id }),
        )
    })?;
    let child = Arc::new(Mutex::new(child));
    let record = ShellProcessRecord::new(process_id, Some(system_process_id), &request);
    record.set_stdin(Box::new(stdin));
    record.set_terminator(ProcessTerminator::Pipe {
        child: child.clone(),
        #[cfg(target_os = "windows")]
        job,
    });
    let stdout_reader = spawn_output_reader(record.clone(), "stdout", Box::new(stdout));
    let stderr_reader = spawn_output_reader(record.clone(), "stderr", Box::new(stderr));
    let wait_record = record.clone();
    record.add_thread(thread::spawn(move || {
        let wait_result = loop {
            let result = child
                .lock()
                .map_err(|_| "shell child process lock was poisoned".to_string())
                .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()));
            match result {
                Ok(Some(status)) => break Ok(exit_code_from_status(status)),
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(error) => break Err(format!("failed to wait for shell process: {error}")),
            }
        };
        wait_record.close_io();
        let reader_failure = join_output_readers([stdout_reader, stderr_reader]);
        match wait_result {
            Ok(exit_code) => wait_record.finish(Some(exit_code), reader_failure),
            Err(error) => wait_record.finish(None, Some(error)),
        }
    }));
    Ok(record)
}

#[cfg(target_os = "windows")]
fn spawn_windows_read_only_pipe_process(
    process_id: String,
    request: ValidatedShellStart,
) -> Result<Arc<ShellProcessRecord>, WorkerProtocolError> {
    let spawned =
        spawn_read_only_pipe_process(&request.command, &request.working_dir).map_err(|error| {
            shell_error(
                "failed to start read-only shell process",
                serde_json::json!({
                    "adapter": "windows_restricted_low_integrity_read_only",
                    "error": error.to_string(),
                    "processStarted": false,
                }),
            )
        })?;
    let system_process_id = spawned.process_id;
    let child = Arc::new(Mutex::new(spawned.child));
    let record = ShellProcessRecord::new(process_id, Some(system_process_id), &request);
    record.set_stdin(Box::new(spawned.stdin));
    record.set_terminator(ProcessTerminator::WindowsReadOnly {
        child: child.clone(),
    });
    let stdout_reader = spawn_output_reader(record.clone(), "stdout", Box::new(spawned.stdout));
    let stderr_reader = spawn_output_reader(record.clone(), "stderr", Box::new(spawned.stderr));
    let wait_record = record.clone();
    record.add_thread(thread::spawn(move || {
        let wait_result = loop {
            let result = child
                .lock()
                .map_err(|_| "read-only shell child process lock was poisoned".to_string())
                .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()));
            match result {
                Ok(Some(exit_code)) => break Ok(exit_code),
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(error) => {
                    break Err(format!(
                        "failed to wait for read-only shell process: {error}"
                    ))
                }
            }
        };
        wait_record.close_io();
        let reader_failure = join_output_readers([stdout_reader, stderr_reader]);
        match wait_result {
            Ok(exit_code) => wait_record.finish(Some(exit_code), reader_failure),
            Err(error) => wait_record.finish(None, Some(error)),
        }
    }));
    Ok(record)
}

fn spawn_pty_process(
    process_id: String,
    request: ValidatedShellStart,
) -> Result<Arc<ShellProcessRecord>, WorkerProtocolError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows,
            cols: request.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| {
            shell_error(
                "failed to open shell PTY",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    let reader = pair.master.try_clone_reader().map_err(|error| {
        shell_error(
            "failed to clone shell PTY reader",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    let writer = pair.master.take_writer().map_err(|error| {
        shell_error(
            "failed to open shell PTY writer",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    let mut command = pty_shell_command(&request.command);
    command.cwd(super::process_working_dir(&request.working_dir));
    let mut child = pair.slave.spawn_command(command).map_err(|error| {
        shell_error(
            "failed to start shell PTY process",
            serde_json::json!({ "error": error.to_string() }),
        )
    })?;
    drop(pair.slave);
    let system_process_id = child.process_id();
    let killer = child.clone_killer();
    let record = ShellProcessRecord::new(process_id, system_process_id, &request);
    record.set_stdin(writer);
    record.set_pty_master(pair.master);
    record.set_terminator(ProcessTerminator::Pty {
        killer,
        system_process_id,
    });
    let output_reader = spawn_output_reader(record.clone(), "terminal", reader);
    let wait_record = record.clone();
    record.add_thread(thread::spawn(move || {
        let wait_result = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .map_err(|error| format!("failed to wait for shell PTY process: {error}"));
        wait_record.close_io();
        let reader_failure = join_output_readers([output_reader]);
        match wait_result {
            Ok(exit_code) => wait_record.finish(Some(exit_code), reader_failure),
            Err(error) => wait_record.finish(None, Some(error)),
        }
    }));
    Ok(record)
}

fn configure_process_group(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn pty_shell_command(command: &str) -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        let mut builder = CommandBuilder::new("cmd");
        builder.arg("/C");
        builder.arg(command);
        builder
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut builder = CommandBuilder::new("sh");
        builder.arg("-c");
        builder.arg(command);
        builder
    }
}

fn spawn_output_reader(
    record: Arc<ShellProcessRecord>,
    stream: &'static str,
    mut reader: Box<dyn Read + Send>,
) -> JoinHandle<Result<(), String>> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8_192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    record.finish_output(stream);
                    return Ok(());
                }
                Ok(read) => record.append_output(stream, &buffer[..read]),
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) if terminal_reader_reached_eof(stream, &error) => {
                    record.finish_output(stream);
                    return Ok(());
                }
                Err(error) => {
                    record.finish_output(stream);
                    let error = format!("failed to read shell {stream}: {error}");
                    record.record_failure(error.clone());
                    return Err(error);
                }
            }
        }
    })
}

fn terminal_reader_reached_eof(stream: &str, error: &std::io::Error) -> bool {
    if stream != "terminal" {
        return false;
    }
    if error.kind() == ErrorKind::BrokenPipe {
        return true;
    }
    #[cfg(unix)]
    {
        return error.raw_os_error() == Some(libc::EIO);
    }
    #[cfg(not(unix))]
    false
}

fn join_output_readers<const N: usize>(
    readers: [JoinHandle<Result<(), String>>; N],
) -> Option<String> {
    let mut errors = Vec::new();
    for reader in readers {
        match reader.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => errors.push(error),
            Err(_) => errors.push("shell output reader panicked".to_string()),
        }
    }
    (!errors.is_empty()).then(|| errors.join("; "))
}

fn terminate_record(
    record: &Arc<ShellProcessRecord>,
    reason: ProcessTerminationReason,
) -> Result<(), WorkerProtocolError> {
    match record.begin_termination(reason) {
        BeginTermination::Terminal => return Ok(()),
        BeginTermination::InProgress => return wait_for_termination(record),
        BeginTermination::Started => {}
    }
    let terminate_result = record
        .terminator
        .lock()
        .map_err(|_| {
            shell_error(
                "shell process terminator lock was poisoned",
                serde_json::json!({ "processId": record.process_id }),
            )
        })?
        .as_mut()
        .ok_or_else(|| {
            shell_error(
                "shell process terminator is unavailable",
                serde_json::json!({ "processId": record.process_id }),
            )
        })?
        .terminate();
    if let Err(error) = terminate_result {
        let message = format!("failed to terminate shell process tree: {error}");
        record.record_failure(message.clone());
        return Err(shell_error(
            message,
            serde_json::json!({ "processId": record.process_id }),
        ));
    }
    wait_for_termination(record)
}

fn wait_for_termination(record: &Arc<ShellProcessRecord>) -> Result<(), WorkerProtocolError> {
    if !record.wait_for_terminal(TERMINATION_WAIT) {
        let message = "shell process did not exit after termination request".to_string();
        record.record_failure(message.clone());
        return Err(shell_error(
            message,
            serde_json::json!({
                "processId": record.process_id,
                "timeoutMs": TERMINATION_WAIT.as_millis(),
            }),
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ProcessTerminationReason {
    Cancelled,
    Terminated,
    TimedOut,
}

enum BeginTermination {
    Started,
    InProgress,
    Terminal,
}

enum ProcessTerminator {
    Pipe {
        child: Arc<Mutex<Child>>,
        #[cfg(target_os = "windows")]
        job: WindowsProcessJob,
    },
    Pty {
        killer: Box<dyn ChildKiller + Send + Sync>,
        system_process_id: Option<u32>,
    },
    #[cfg(target_os = "windows")]
    WindowsReadOnly {
        child: Arc<Mutex<WindowsReadOnlyChild>>,
    },
}

impl ProcessTerminator {
    fn terminate(&mut self) -> std::io::Result<()> {
        match self {
            Self::Pipe {
                child,
                #[cfg(target_os = "windows")]
                job,
            } => {
                let mut child = child
                    .lock()
                    .map_err(|_| std::io::Error::other("shell child process lock was poisoned"))?;
                #[cfg(target_os = "windows")]
                {
                    let tree_result = job.terminate();
                    let child_result = super::terminate_child_process(&mut child);
                    combine_termination_results(tree_result, child_result)
                }
                #[cfg(not(target_os = "windows"))]
                {
                    super::terminate_child_process(&mut child)
                }
            }
            Self::Pty {
                killer,
                system_process_id,
            } => {
                let tree_result = system_process_id.map(kill_process_tree).unwrap_or_else(|| {
                    Err(std::io::Error::new(
                        ErrorKind::NotFound,
                        "shell PTY process id is unavailable",
                    ))
                });
                let child_result = killer.kill();
                combine_termination_results(tree_result, child_result)
            }
            #[cfg(target_os = "windows")]
            Self::WindowsReadOnly { child } => child
                .lock()
                .map_err(|_| {
                    std::io::Error::other("read-only shell child process lock was poisoned")
                })?
                .terminate(),
        }
    }
}

fn combine_termination_results(
    tree_result: std::io::Result<()>,
    child_result: std::io::Result<()>,
) -> std::io::Result<()> {
    match (tree_result, child_result) {
        (Ok(()), _) | (_, Ok(())) => Ok(()),
        (Err(tree_error), Err(child_error)) => Err(std::io::Error::other(format!(
            "process tree termination failed: {tree_error}; direct child termination failed: {child_error}"
        ))),
    }
}

fn kill_process_tree(process_id: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let process_group = process_id as libc::pid_t;
        // SAFETY: PTY and pipe children are created as process-group leaders.
        if unsafe { libc::kill(-process_group, libc::SIGKILL) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let status = Command::new("taskkill")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "taskkill exited with status {status}"
            )))
        }
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = process_id;
        Err(std::io::Error::new(
            ErrorKind::Unsupported,
            "process tree termination is unsupported on this platform",
        ))
    }
}

struct ShellProcessRecord {
    process_id: String,
    system_process_id: Option<u32>,
    run_id: Option<String>,
    tool_call_id: Option<String>,
    command: String,
    working_dir: String,
    tty: bool,
    started_at_ms: u64,
    sandbox_mode: String,
    network_mode: String,
    approval_decision: String,
    state: Mutex<ShellProcessState>,
    changed: Condvar,
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    #[cfg(target_os = "windows")]
    windows_input: Mutex<WindowsTtyInputNormalizer>,
    #[cfg(target_os = "windows")]
    windows_terminal_output: Mutex<WindowsTerminalOutputNormalizer>,
    pty_master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    terminator: Mutex<Option<ProcessTerminator>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

impl ShellProcessRecord {
    fn new(
        process_id: String,
        system_process_id: Option<u32>,
        request: &ValidatedShellStart,
    ) -> Arc<Self> {
        let started_at_ms = unix_time_ms();
        Arc::new(Self {
            process_id,
            system_process_id,
            run_id: request.run_id.clone(),
            tool_call_id: request.tool_call_id.clone(),
            command: request.command.clone(),
            working_dir: request.working_dir_display.clone(),
            tty: request.tty,
            started_at_ms,
            sandbox_mode: request.sandbox_mode.clone(),
            network_mode: request.network_mode.clone(),
            approval_decision: request.approval_decision.clone(),
            state: Mutex::new(ShellProcessState {
                status: ProcessStatus::Running,
                exit_code: None,
                termination_reason: None,
                output: HeadTailOutput::new(),
                last_activity_ms: started_at_ms,
                failure: None,
            }),
            changed: Condvar::new(),
            stdin: Mutex::new(None),
            #[cfg(target_os = "windows")]
            windows_input: Mutex::new(WindowsTtyInputNormalizer::default()),
            #[cfg(target_os = "windows")]
            windows_terminal_output: Mutex::new(WindowsTerminalOutputNormalizer::default()),
            pty_master: Mutex::new(None),
            terminator: Mutex::new(None),
            threads: Mutex::new(Vec::new()),
        })
    }

    fn set_stdin(&self, stdin: Box<dyn Write + Send>) {
        *self
            .stdin
            .lock()
            .expect("shell process stdin lock should not be poisoned") = Some(stdin);
    }

    fn set_pty_master(&self, master: Box<dyn MasterPty + Send>) {
        *self
            .pty_master
            .lock()
            .expect("shell PTY master lock should not be poisoned") = Some(master);
    }

    fn set_terminator(&self, terminator: ProcessTerminator) {
        *self
            .terminator
            .lock()
            .expect("shell process terminator lock should not be poisoned") = Some(terminator);
    }

    fn add_thread(&self, handle: JoinHandle<()>) {
        self.threads
            .lock()
            .expect("shell process thread registry lock should not be poisoned")
            .push(handle);
    }

    fn append_output(&self, stream: &str, bytes: &[u8]) {
        #[cfg(target_os = "windows")]
        let normalized_output = if self.tty && stream == "terminal" {
            let normalized = self
                .windows_terminal_output
                .lock()
                .expect("shell terminal output normalizer lock should not be poisoned")
                .normalize(bytes);
            for _ in 0..normalized.cursor_position_queries {
                if let Err(error) = self.write_raw_stdin(b"\x1b[1;1R") {
                    self.record_failure(format!(
                        "failed to answer shell terminal cursor query: {}",
                        error.message
                    ));
                }
            }
            Some(normalized.output)
        } else {
            None
        };
        #[cfg(target_os = "windows")]
        let bytes = normalized_output.as_deref().unwrap_or(bytes);
        self.append_buffered_output(stream, bytes);
    }

    fn finish_output(&self, stream: &str) {
        #[cfg(target_os = "windows")]
        if self.tty && stream == "terminal" {
            let pending = self
                .windows_terminal_output
                .lock()
                .expect("shell terminal output normalizer lock should not be poisoned")
                .finish();
            self.append_buffered_output(stream, &pending);
        }
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        if state.output.finish_stream(stream) {
            state.last_activity_ms = unix_time_ms();
            self.changed.notify_all();
        }
    }

    fn append_buffered_output(&self, stream: &str, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        state.output.append(stream, bytes);
        state.last_activity_ms = unix_time_ms();
        self.changed.notify_all();
    }

    fn write_stdin(&self, input: &[u8]) -> Result<(), WorkerProtocolError> {
        if !self.is_running() {
            return Err(process_exited_error(self));
        }
        #[cfg(target_os = "windows")]
        let normalized_input = if self.tty {
            Some(
                self.windows_input
                    .lock()
                    .map_err(|_| {
                        shell_error(
                            "shell PTY input normalizer lock was poisoned",
                            serde_json::json!({ "processId": self.process_id }),
                        )
                    })?
                    .normalize(input),
            )
        } else {
            None
        };
        #[cfg(target_os = "windows")]
        let input = normalized_input.as_deref().unwrap_or(input);
        if let Err(error) = self.write_raw_stdin(input) {
            if !self.is_running() {
                return Err(process_exited_error(self));
            }
            let message = format!("failed to write shell process stdin: {}", error.message);
            self.record_failure(message.clone());
            return Err(shell_error(
                message,
                serde_json::json!({ "processId": self.process_id }),
            ));
        }
        self.touch();
        Ok(())
    }

    fn write_raw_stdin(&self, input: &[u8]) -> Result<(), WorkerProtocolError> {
        let mut stdin = self.stdin.lock().map_err(|_| {
            shell_error(
                "shell process stdin lock was poisoned",
                serde_json::json!({ "processId": self.process_id }),
            )
        })?;
        let writer = stdin.as_mut().ok_or_else(|| {
            shell_error(
                "shell process stdin is closed",
                serde_json::json!({ "processId": self.process_id }),
            )
        })?;
        writer
            .write_all(input)
            .and_then(|_| writer.flush())
            .map_err(|error| {
                shell_error(
                    "failed to write shell process stdin",
                    serde_json::json!({
                        "processId": self.process_id,
                        "error": error.to_string(),
                    }),
                )
            })
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<(), WorkerProtocolError> {
        if !self.tty {
            return Err(shell_error(
                "shell process is not attached to a PTY",
                serde_json::json!({ "processId": self.process_id }),
            ));
        }
        if !self.is_running() {
            return Err(process_exited_error(self));
        }
        self.pty_master
            .lock()
            .map_err(|_| {
                shell_error(
                    "shell PTY master lock was poisoned",
                    serde_json::json!({ "processId": self.process_id }),
                )
            })?
            .as_ref()
            .ok_or_else(|| {
                shell_error(
                    "shell PTY master is unavailable",
                    serde_json::json!({ "processId": self.process_id }),
                )
            })?
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                shell_error(
                    "failed to resize shell PTY",
                    serde_json::json!({
                        "processId": self.process_id,
                        "error": error.to_string(),
                    }),
                )
            })?;
        self.touch();
        Ok(())
    }

    fn interrupt(&self) -> Result<(), WorkerProtocolError> {
        if !self.is_running() {
            return Err(process_exited_error(self));
        }
        #[cfg(unix)]
        {
            let process_id = self.system_process_id.ok_or_else(|| {
                shell_error(
                    "shell process id is unavailable for interrupt",
                    serde_json::json!({ "processId": self.process_id }),
                )
            })?;
            // SAFETY: shell children are created as process-group leaders.
            if unsafe { libc::kill(-(process_id as libc::pid_t), libc::SIGINT) } == -1 {
                return Err(shell_error(
                    "failed to interrupt shell process group",
                    serde_json::json!({
                        "processId": self.process_id,
                        "error": std::io::Error::last_os_error().to_string(),
                    }),
                ));
            }
        }
        #[cfg(target_os = "windows")]
        {
            if !self.tty {
                return Err(shell_error(
                    "shell process interrupt requires a PTY on Windows",
                    serde_json::json!({ "processId": self.process_id }),
                ));
            }
            self.write_stdin(&[3])?;
        }
        #[cfg(not(any(unix, target_os = "windows")))]
        {
            return Err(shell_error(
                "shell process interrupt is unsupported on this platform",
                serde_json::json!({ "processId": self.process_id }),
            ));
        }
        self.touch();
        Ok(())
    }

    fn begin_termination(&self, reason: ProcessTerminationReason) -> BeginTermination {
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        match state.status {
            ProcessStatus::Running => {
                state.termination_reason.get_or_insert(reason);
                state.status = ProcessStatus::Terminating;
                state.last_activity_ms = unix_time_ms();
                self.changed.notify_all();
                BeginTermination::Started
            }
            ProcessStatus::Terminating => BeginTermination::InProgress,
            _ => BeginTermination::Terminal,
        }
    }

    fn finish(&self, exit_code: Option<i32>, failure: Option<String>) {
        self.close_io();
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        state.exit_code = exit_code;
        if let Some(failure) = failure {
            state.failure.get_or_insert(failure);
        }
        state.status = if state.failure.is_some() {
            ProcessStatus::Failed
        } else {
            match state.termination_reason {
                Some(ProcessTerminationReason::Cancelled) => ProcessStatus::Cancelled,
                Some(ProcessTerminationReason::Terminated) => ProcessStatus::Terminated,
                Some(ProcessTerminationReason::TimedOut) => ProcessStatus::TimedOut,
                None => ProcessStatus::Exited,
            }
        };
        state.last_activity_ms = unix_time_ms();
        self.changed.notify_all();
    }

    fn record_failure(&self, failure: String) {
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        state.failure.get_or_insert(failure);
        state.last_activity_ms = unix_time_ms();
        self.changed.notify_all();
    }

    fn close_io(&self) {
        self.stdin
            .lock()
            .expect("shell process stdin lock should not be poisoned")
            .take();
        self.pty_master
            .lock()
            .expect("shell PTY master lock should not be poisoned")
            .take();
    }

    fn touch(&self) {
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        state.last_activity_ms = unix_time_ms();
        self.changed.notify_all();
    }

    fn is_running(&self) -> bool {
        self.state
            .lock()
            .expect("shell process state lock should not be poisoned")
            .status
            .is_running()
    }

    fn last_activity_ms(&self) -> u64 {
        self.state
            .lock()
            .expect("shell process state lock should not be poisoned")
            .last_activity_ms
    }

    fn wait_for_terminal(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        while state.status.is_running() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next_state, wait_result) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("shell process state lock should not be poisoned while waiting");
            state = next_state;
            if wait_result.timed_out() && state.status.is_running() {
                return false;
            }
        }
        true
    }

    fn wait_for_output(&self, cursor: u64, timeout: Duration) -> ShellProcessOutput {
        let mut state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        if timeout.is_zero() || state.output.has_after(cursor) || !state.status.is_running() {
            return self.snapshot_from_state(&state, cursor);
        }
        let deadline = Instant::now() + timeout;
        while !state.output.has_after(cursor) && state.status.is_running() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let (next_state, wait_result) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("shell process state lock should not be poisoned while waiting");
            state = next_state;
            if wait_result.timed_out() {
                break;
            }
        }
        self.snapshot_from_state(&state, cursor)
    }

    fn snapshot(&self, cursor: u64) -> ShellProcessOutput {
        let state = self
            .state
            .lock()
            .expect("shell process state lock should not be poisoned");
        self.snapshot_from_state(&state, cursor)
    }

    fn snapshot_from_state(&self, state: &ShellProcessState, cursor: u64) -> ShellProcessOutput {
        let snapshot = state.output.snapshot_after(cursor);
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut output = String::new();
        for chunk in &snapshot.chunks {
            output.push_str(&chunk.content);
            if chunk.stream == "stderr" {
                stderr.push_str(&chunk.content);
            } else {
                stdout.push_str(&chunk.content);
            }
        }
        ShellProcessOutput {
            process_id: self.process_id.clone(),
            system_process_id: self.system_process_id,
            run_id: self.run_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            command: self.command.clone(),
            working_dir: self.working_dir.clone(),
            tty: self.tty,
            status: state.status.as_str().to_string(),
            running: state.status.is_running(),
            exit_code: state.exit_code,
            stdout,
            stderr,
            output,
            chunks: snapshot.chunks,
            cursor: snapshot.cursor,
            truncated: snapshot.truncated,
            dropped_bytes: snapshot.dropped_bytes,
            started_at_ms: self.started_at_ms,
            last_activity_ms: state.last_activity_ms,
            sandbox_mode: self.sandbox_mode.clone(),
            network_mode: self.network_mode.clone(),
            approval_decision: self.approval_decision.clone(),
            failure: state.failure.clone(),
        }
    }

    fn join_threads(&self) {
        let handles = std::mem::take(
            &mut *self
                .threads
                .lock()
                .expect("shell process thread registry lock should not be poisoned"),
        );
        for handle in handles {
            handle
                .join()
                .expect("owned shell process lifecycle thread should not panic");
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct WindowsTtyInputNormalizer {
    previous_was_cr: bool,
}

#[cfg(target_os = "windows")]
impl WindowsTtyInputNormalizer {
    fn normalize(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut normalized = Vec::with_capacity(bytes.len());
        for &byte in bytes {
            match byte {
                b'\x08' => normalized.push(b'\x7f'),
                b'\n' if !self.previous_was_cr => normalized.push(b'\r'),
                b'\n' => {}
                _ => normalized.push(byte),
            }
            self.previous_was_cr = byte == b'\r';
        }
        normalized
    }
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct WindowsTerminalOutputNormalizer {
    pending: Vec<u8>,
}

#[cfg(target_os = "windows")]
struct NormalizedTerminalOutput {
    output: Vec<u8>,
    cursor_position_queries: usize,
}

#[cfg(target_os = "windows")]
impl WindowsTerminalOutputNormalizer {
    fn normalize(&mut self, bytes: &[u8]) -> NormalizedTerminalOutput {
        const CURSOR_POSITION_QUERY: &[u8] = b"\x1b[6n";
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(bytes);
        let mut output = Vec::with_capacity(input.len());
        let mut cursor_position_queries = 0;
        let mut offset = 0;
        while offset < input.len() {
            let remaining = &input[offset..];
            if remaining.starts_with(CURSOR_POSITION_QUERY) {
                cursor_position_queries += 1;
                offset += CURSOR_POSITION_QUERY.len();
            } else if CURSOR_POSITION_QUERY.starts_with(remaining) {
                self.pending.extend_from_slice(remaining);
                break;
            } else {
                output.push(input[offset]);
                offset += 1;
            }
        }
        NormalizedTerminalOutput {
            output,
            cursor_position_queries,
        }
    }

    fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_terminal_output_tests {
    use super::WindowsTerminalOutputNormalizer;

    #[test]
    fn removes_split_cursor_queries_and_counts_responses() {
        let mut normalizer = WindowsTerminalOutputNormalizer::default();
        let first = normalizer.normalize(b"before\x1b[");
        assert_eq!(first.output, b"before");
        assert_eq!(first.cursor_position_queries, 0);

        let second = normalizer.normalize(b"6nafter\x1b[6n");
        assert_eq!(second.output, b"after");
        assert_eq!(second.cursor_position_queries, 2);

        let _ = normalizer.normalize(b"tail\x1b[");
        assert_eq!(normalizer.finish(), b"\x1b[");
    }
}

struct ShellProcessState {
    status: ProcessStatus,
    exit_code: Option<i32>,
    termination_reason: Option<ProcessTerminationReason>,
    output: HeadTailOutput,
    last_activity_ms: u64,
    failure: Option<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ProcessStatus {
    Running,
    Terminating,
    Exited,
    Cancelled,
    Terminated,
    TimedOut,
    Failed,
}

impl ProcessStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Terminating => "terminating",
            Self::Exited => "exited",
            Self::Cancelled => "cancelled",
            Self::Terminated => "terminated",
            Self::TimedOut => "timed_out",
            Self::Failed => "failed",
        }
    }

    fn is_running(self) -> bool {
        matches!(self, Self::Running | Self::Terminating)
    }
}

struct HeadTailOutput {
    head: Vec<BufferedOutputChunk>,
    tail: VecDeque<BufferedOutputChunk>,
    pending_utf8: HashMap<String, Vec<u8>>,
    head_bytes: usize,
    tail_bytes: usize,
    dropped_bytes: u64,
    next_sequence: u64,
}

impl HeadTailOutput {
    fn new() -> Self {
        Self {
            head: Vec::new(),
            tail: VecDeque::new(),
            pending_utf8: HashMap::new(),
            head_bytes: 0,
            tail_bytes: 0,
            dropped_bytes: 0,
            next_sequence: 0,
        }
    }

    fn append(&mut self, stream: &str, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut combined = self.pending_utf8.remove(stream).unwrap_or_default();
        combined.extend_from_slice(bytes);
        let (decoded, pending) = decode_available_utf8(&combined);
        if !pending.is_empty() {
            self.pending_utf8.insert(stream.to_string(), pending);
        }
        self.append_retained(stream, &decoded);
    }

    fn finish_stream(&mut self, stream: &str) -> bool {
        let Some(pending) = self.pending_utf8.remove(stream) else {
            return false;
        };
        let decoded = String::from_utf8_lossy(&pending).into_owned().into_bytes();
        self.append_retained(stream, &decoded);
        !decoded.is_empty()
    }

    fn append_retained(&mut self, stream: &str, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let head_remaining = if self.tail.is_empty() {
            OUTPUT_HEAD_BYTES.saturating_sub(self.head_bytes)
        } else {
            0
        };
        let head_len = floor_utf8_boundary(bytes, head_remaining.min(bytes.len()));
        if head_len > 0 {
            let chunk = self.new_chunk(stream, bytes[..head_len].to_vec());
            self.head_bytes += head_len;
            self.head.push(chunk);
        }
        if head_len < bytes.len() {
            self.append_tail(stream, &bytes[head_len..]);
        }
    }

    fn append_tail(&mut self, stream: &str, bytes: &[u8]) {
        let retained = if bytes.len() > OUTPUT_TAIL_BYTES {
            let start = ceil_utf8_boundary(bytes, bytes.len() - OUTPUT_TAIL_BYTES);
            self.dropped_bytes = self.dropped_bytes.saturating_add(start as u64);
            &bytes[start..]
        } else {
            bytes
        };
        while self.tail_bytes.saturating_add(retained.len()) > OUTPUT_TAIL_BYTES {
            let Some(removed) = self.tail.pop_front() else {
                break;
            };
            self.tail_bytes = self.tail_bytes.saturating_sub(removed.bytes.len());
            self.dropped_bytes = self
                .dropped_bytes
                .saturating_add(removed.bytes.len() as u64);
        }
        let chunk = self.new_chunk(stream, retained.to_vec());
        self.tail_bytes += retained.len();
        self.tail.push_back(chunk);
    }

    fn new_chunk(&mut self, stream: &str, bytes: Vec<u8>) -> BufferedOutputChunk {
        self.next_sequence = self.next_sequence.saturating_add(1);
        BufferedOutputChunk {
            sequence: self.next_sequence,
            stream: stream.to_string(),
            bytes,
        }
    }

    fn has_after(&self, cursor: u64) -> bool {
        self.next_sequence > cursor
    }

    fn snapshot_after(&self, cursor: u64) -> BufferedOutputSnapshot {
        let chunks = self
            .head
            .iter()
            .chain(self.tail.iter())
            .filter(|chunk| chunk.sequence > cursor)
            .map(|chunk| ShellOutputChunk {
                sequence: chunk.sequence,
                stream: chunk.stream.clone(),
                content: String::from_utf8_lossy(&chunk.bytes).into_owned(),
            })
            .collect();
        BufferedOutputSnapshot {
            chunks,
            cursor: self.next_sequence,
            truncated: self.dropped_bytes > 0,
            dropped_bytes: self.dropped_bytes,
        }
    }
}

fn decode_available_utf8(bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    while offset < bytes.len() {
        match std::str::from_utf8(&bytes[offset..]) {
            Ok(_) => {
                decoded.extend_from_slice(&bytes[offset..]);
                return (decoded, Vec::new());
            }
            Err(error) => {
                let valid_end = offset + error.valid_up_to();
                decoded.extend_from_slice(&bytes[offset..valid_end]);
                offset = valid_end;
                let Some(invalid_length) = error.error_len() else {
                    return (decoded, bytes[offset..].to_vec());
                };
                decoded.extend_from_slice("�".as_bytes());
                offset = offset.saturating_add(invalid_length);
            }
        }
    }
    (decoded, Vec::new())
}

fn floor_utf8_boundary(bytes: &[u8], maximum: usize) -> usize {
    let text = std::str::from_utf8(bytes).expect("retained shell output must be valid UTF-8");
    let mut boundary = maximum.min(bytes.len());
    while !text.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    boundary
}

fn ceil_utf8_boundary(bytes: &[u8], minimum: usize) -> usize {
    let text = std::str::from_utf8(bytes).expect("retained shell output must be valid UTF-8");
    let mut boundary = minimum.min(bytes.len());
    while !text.is_char_boundary(boundary) {
        boundary = boundary.saturating_add(1);
    }
    boundary
}

#[cfg(test)]
mod output_tests {
    use super::HeadTailOutput;

    #[test]
    fn retains_utf8_characters_split_across_reader_chunks() {
        let mut output = HeadTailOutput::new();
        output.append("stdout", &[0xe4, 0xb8]);
        assert_eq!(output.snapshot_after(0).cursor, 0);

        output.append("stdout", &[0xad]);
        let snapshot = output.snapshot_after(0);
        assert_eq!(snapshot.chunks.len(), 1);
        assert_eq!(snapshot.chunks[0].content, "中");
    }

    #[test]
    fn head_tail_boundaries_do_not_split_utf8_characters() {
        let mut output = HeadTailOutput::new();
        output.append("stdout", &vec![b'x'; super::OUTPUT_HEAD_BYTES - 1]);
        output.append("stdout", "中".as_bytes());
        output.append("stdout", b"z");

        let snapshot = output.snapshot_after(0);
        let rendered = snapshot
            .chunks
            .iter()
            .map(|chunk| chunk.content.as_str())
            .collect::<String>();
        assert!(rendered.ends_with("中z"));
        assert!(!rendered.contains('�'));
    }
}

struct BufferedOutputChunk {
    sequence: u64,
    stream: String,
    bytes: Vec<u8>,
}

struct BufferedOutputSnapshot {
    chunks: Vec<ShellOutputChunk>,
    cursor: u64,
    truncated: bool,
    dropped_bytes: u64,
}

fn process_exited_error(record: &ShellProcessRecord) -> WorkerProtocolError {
    let snapshot = record.snapshot(0);
    shell_error(
        "shell process has already exited",
        serde_json::json!({
            "processId": record.process_id,
            "status": snapshot.status,
            "exitCode": snapshot.exit_code,
        }),
    )
}

fn unknown_process_error(process_id: &str) -> WorkerProtocolError {
    shell_error(
        "unknown shell process id",
        serde_json::json!({ "processId": process_id }),
    )
}

fn clamp_yield_time(yield_time_ms: u64) -> u64 {
    yield_time_ms.min(MAX_YIELD_TIME_MS)
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after Unix epoch")
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn exit_code_from_status(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    -1
}
