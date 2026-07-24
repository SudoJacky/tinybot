use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::threads::rollout::format::{RolloutItem, RolloutLine};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};

enum RolloutWriterCommand {
    AddItems(Vec<RolloutLine>),
    #[cfg(test)]
    PendingItemCount {
        ack: mpsc::Sender<usize>,
    },
    Persist {
        ack: mpsc::Sender<Result<(), WorkerProtocolError>>,
    },
    Flush {
        ack: mpsc::Sender<Result<(), WorkerProtocolError>>,
    },
    Shutdown {
        ack: mpsc::Sender<Result<(), WorkerProtocolError>>,
    },
}

pub(super) struct RolloutWriter {
    path: PathBuf,
    tx: Mutex<Option<mpsc::Sender<RolloutWriterCommand>>>,
    terminal_failure: Arc<Mutex<Option<WorkerProtocolError>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for RolloutWriter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RolloutWriter")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl RolloutWriter {
    pub(super) fn spawn(path: PathBuf) -> Result<Self, WorkerProtocolError> {
        let (tx, rx) = mpsc::channel();
        let terminal_failure = Arc::new(Mutex::new(None));
        let worker_failure = terminal_failure.clone();
        let worker_path = path.clone();
        let thread_name = format!(
            "tinybot-rollout-writer-{}",
            path.file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("thread")
        );
        let worker = thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let mut state = RolloutWriterState::new(worker_path);
                run_rollout_writer(&mut state, rx, &worker_failure);
            })
            .map_err(|error| writer_error(&path, "spawn", error.to_string(), false))?;
        Ok(Self {
            path,
            tx: Mutex::new(Some(tx)),
            terminal_failure,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub(super) fn add_items(&self, items: Vec<RolloutLine>) -> Result<(), WorkerProtocolError> {
        if items.is_empty() {
            return Ok(());
        }
        self.send_command("add_items", RolloutWriterCommand::AddItems(items))
    }

    pub(super) fn persist(&self) -> Result<(), WorkerProtocolError> {
        self.barrier("persist", |ack| RolloutWriterCommand::Persist { ack })
    }

    pub(super) fn flush(&self) -> Result<(), WorkerProtocolError> {
        self.barrier("flush", |ack| RolloutWriterCommand::Flush { ack })
    }

    #[cfg(test)]
    pub(super) fn pending_item_count(&self) -> Result<usize, WorkerProtocolError> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_command(
            "pending_item_count",
            RolloutWriterCommand::PendingItemCount { ack: ack_tx },
        )?;
        ack_rx
            .recv()
            .map_err(|_| self.command_channel_error("pending_item_count"))
    }

    pub(super) fn shutdown(&self) -> Result<(), WorkerProtocolError> {
        let mut tx = self
            .tx
            .lock()
            .map_err(|_| writer_lock_error(&self.path, "shutdown command channel"))?;
        let Some(sender) = tx.as_ref() else {
            return Ok(());
        };
        let (ack_tx, ack_rx) = mpsc::channel();
        sender
            .send(RolloutWriterCommand::Shutdown { ack: ack_tx })
            .map_err(|_| self.command_channel_error("shutdown"))?;
        let result = ack_rx
            .recv()
            .map_err(|_| self.command_channel_error("shutdown"))?;
        if result.is_ok() {
            tx.take();
            drop(tx);
            let worker = self
                .worker
                .lock()
                .map_err(|_| writer_lock_error(&self.path, "shutdown worker handle"))?
                .take();
            if let Some(worker) = worker {
                worker.join().map_err(|_| {
                    writer_error(
                        &self.path,
                        "shutdown",
                        "rollout writer thread panicked".to_string(),
                        false,
                    )
                })?;
            }
        }
        result
    }

    fn barrier(
        &self,
        operation: &str,
        command: impl FnOnce(mpsc::Sender<Result<(), WorkerProtocolError>>) -> RolloutWriterCommand,
    ) -> Result<(), WorkerProtocolError> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send_command(operation, command(ack_tx))?;
        ack_rx
            .recv()
            .map_err(|_| self.command_channel_error(operation))?
    }

    fn command_channel_error(&self, operation: &str) -> WorkerProtocolError {
        self.terminal_failure
            .lock()
            .ok()
            .and_then(|failure| failure.clone())
            .unwrap_or_else(|| {
                writer_error(
                    &self.path,
                    operation,
                    "rollout writer stopped before acknowledging command".to_string(),
                    false,
                )
            })
    }

    fn send_command(
        &self,
        operation: &str,
        command: RolloutWriterCommand,
    ) -> Result<(), WorkerProtocolError> {
        self.tx
            .lock()
            .map_err(|_| writer_lock_error(&self.path, "command channel"))?
            .as_ref()
            .ok_or_else(|| self.command_channel_error(operation))
            .and_then(|sender| {
                sender
                    .send(command)
                    .map_err(|_| self.command_channel_error(operation))
            })
    }
}

impl Drop for RolloutWriter {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            eprintln!(
                "rollout_writer_shutdown_error path={} error={}",
                self.path.display(),
                error.message
            );
            self.force_disconnect_and_join();
        }
    }
}

impl RolloutWriter {
    fn force_disconnect_and_join(&mut self) {
        let tx = match self.tx.get_mut() {
            Ok(tx) => tx,
            Err(poisoned) => {
                eprintln!(
                    "rollout_writer_shutdown_error path={} error=command_channel_lock_poisoned",
                    self.path.display()
                );
                poisoned.into_inner()
            }
        };
        tx.take();
        let worker_slot = match self.worker.get_mut() {
            Ok(worker) => worker,
            Err(poisoned) => {
                eprintln!(
                    "rollout_writer_shutdown_error path={} error=worker_handle_lock_poisoned",
                    self.path.display()
                );
                poisoned.into_inner()
            }
        };
        let worker = worker_slot.take();
        if worker.is_some_and(|worker| worker.join().is_err()) {
            eprintln!(
                "rollout_writer_shutdown_error path={} error=writer_thread_panicked",
                self.path.display()
            );
        }
    }
}

struct RolloutWriterState {
    path: PathBuf,
    file: Option<File>,
    pending_items: Vec<RolloutLine>,
    next_ordinal: Option<u64>,
    last_error: Option<String>,
}

impl RolloutWriterState {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            pending_items: Vec::new(),
            next_ordinal: None,
            last_error: None,
        }
    }

    fn add_items(&mut self, items: Vec<RolloutLine>) {
        self.pending_items.extend(items);
    }

    fn persist(&mut self) -> Result<(), WorkerProtocolError> {
        self.write_pending_with_recovery("persist")
    }

    fn flush(&mut self) -> Result<(), WorkerProtocolError> {
        if self.file.is_none() && self.pending_items.is_empty() && !self.path.exists() {
            return Ok(());
        }
        self.write_pending_with_recovery("flush")
    }

    fn shutdown(&mut self) -> Result<(), WorkerProtocolError> {
        if self.file.is_none() && self.pending_items.is_empty() && !self.path.exists() {
            return Ok(());
        }
        self.write_pending_with_recovery("shutdown")
    }

    fn write_pending_with_recovery(&mut self, operation: &str) -> Result<(), WorkerProtocolError> {
        match self.write_pending_once() {
            Ok(()) => {
                self.last_error = None;
                Ok(())
            }
            Err(first_error) => {
                self.enter_recovery_mode(&first_error);
                if !first_error.retryable {
                    return Err(first_error);
                }
                eprintln!(
                    "tinybot rollout writer {operation} failed; reopening and retrying; path={}; \
                     pending_items={}; error={}",
                    self.path.display(),
                    self.pending_items.len(),
                    first_error.message
                );
                match self.write_pending_once() {
                    Ok(()) => {
                        self.last_error = None;
                        Ok(())
                    }
                    Err(final_error) => {
                        self.enter_recovery_mode(&final_error);
                        eprintln!(
                            "tinybot rollout writer {operation} retry failed; path={}; \
                             pending_items={}; first_error={}; final_error={}",
                            self.path.display(),
                            self.pending_items.len(),
                            first_error.message,
                            final_error.message
                        );
                        Err(writer_retry_error(
                            &self.path,
                            operation,
                            &first_error,
                            &final_error,
                            self.pending_items.len(),
                        ))
                    }
                }
            }
        }
    }

    fn enter_recovery_mode(&mut self, error: &WorkerProtocolError) {
        self.last_error = Some(error.message.clone());
        self.file = None;
        self.next_ordinal = None;
    }

    fn write_pending_once(&mut self) -> Result<(), WorkerProtocolError> {
        self.ensure_writer_open()?;
        self.validate_pending_items()?;
        self.write_pending_items_once()?;
        if let Some(file) = self.file.as_mut() {
            file.flush()
                .map_err(|error| writer_io_error(&self.path, "flush", error))?;
        }
        Ok(())
    }

    fn ensure_writer_open(&mut self) -> Result<(), WorkerProtocolError> {
        if self.file.is_some() {
            return Ok(());
        }
        if !self.path.exists()
            && !matches!(
                self.pending_items.first().map(|line| &line.item),
                Some(RolloutItem::SessionMeta(_))
            )
        {
            return Err(writer_error(
                &self.path,
                "open",
                "new rollout must begin with session metadata".to_string(),
                false,
            ));
        }
        let parent = self.path.parent().ok_or_else(|| {
            writer_error(
                &self.path,
                "open",
                "rollout path has no parent directory".to_string(),
                false,
            )
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| writer_io_error(&self.path, "create_parent", error))?;
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(&self.path)
            .map_err(|error| writer_io_error(&self.path, "open", error))?;
        ensure_newline_terminated(&mut file, &self.path)?;
        let existing_lines = super::reader::read_thread_lines(&self.path).map_err(|error| {
            writer_error(
                &self.path,
                "resume",
                format!(
                    "failed to reconstruct rollout ordinal state: {}",
                    error.message
                ),
                false,
            )
        })?;
        let next_ordinal = next_rollout_ordinal(&self.path, &existing_lines)?;
        self.file = Some(file);
        self.next_ordinal = Some(next_ordinal);
        Ok(())
    }

    fn validate_pending_items(&self) -> Result<(), WorkerProtocolError> {
        let mut ordinal = self.next_ordinal.ok_or_else(|| {
            writer_error(
                &self.path,
                "validate",
                "rollout ordinal state is unavailable".to_string(),
                false,
            )
        })?;
        for line in &self.pending_items {
            if ordinal == 0 && !matches!(line.item, RolloutItem::SessionMeta(_)) {
                return Err(writer_error(
                    &self.path,
                    "validate",
                    "rollout ordinal 0 must contain session metadata".to_string(),
                    false,
                ));
            }
            if ordinal > 0 && matches!(line.item, RolloutItem::SessionMeta(_)) {
                return Err(writer_error(
                    &self.path,
                    "validate",
                    "session metadata may only appear at rollout ordinal 0".to_string(),
                    false,
                ));
            }
            ordinal = ordinal.checked_add(1).ok_or_else(|| {
                writer_error(
                    &self.path,
                    "validate",
                    "rollout record ordinal overflow".to_string(),
                    false,
                )
            })?;
        }
        Ok(())
    }

    fn write_pending_items_once(&mut self) -> Result<(), WorkerProtocolError> {
        let file = self.file.as_mut().ok_or_else(|| {
            writer_error(
                &self.path,
                "write",
                "rollout writer is not open".to_string(),
                false,
            )
        })?;
        let mut next_ordinal = self.next_ordinal.ok_or_else(|| {
            writer_error(
                &self.path,
                "write",
                "rollout ordinal state is unavailable".to_string(),
                false,
            )
        })?;
        let mut written_count = 0usize;
        let mut write_result = Ok(());
        for line in &self.pending_items {
            let mut persisted = line.clone();
            persisted.ordinal = Some(next_ordinal);
            let serialized = match serde_json::to_string(&persisted) {
                Ok(serialized) => serialized,
                Err(error) => {
                    write_result = Err(writer_error(
                        &self.path,
                        "serialize",
                        format!("thread log JSON error: {error}"),
                        false,
                    ));
                    break;
                }
            };
            if let Err(error) = file
                .write_all(serialized.as_bytes())
                .and_then(|_| file.write_all(b"\n"))
            {
                write_result = Err(writer_io_error(&self.path, "write", error));
                break;
            }
            written_count += 1;
            next_ordinal = match next_ordinal.checked_add(1) {
                Some(ordinal) => ordinal,
                None => {
                    write_result = Err(writer_error(
                        &self.path,
                        "write",
                        "rollout record ordinal overflow".to_string(),
                        false,
                    ));
                    break;
                }
            };
        }
        if written_count > 0 {
            self.pending_items.drain(..written_count);
            self.next_ordinal = Some(next_ordinal);
        }
        write_result
    }
}

fn run_rollout_writer(
    state: &mut RolloutWriterState,
    rx: mpsc::Receiver<RolloutWriterCommand>,
    terminal_failure: &Mutex<Option<WorkerProtocolError>>,
) {
    while let Ok(command) = rx.recv() {
        match command {
            RolloutWriterCommand::AddItems(items) => {
                state.add_items(items);
            }
            #[cfg(test)]
            RolloutWriterCommand::PendingItemCount { ack } => {
                let _ = ack.send(state.pending_items.len());
            }
            RolloutWriterCommand::Persist { ack } => {
                let _ = ack.send(state.persist());
            }
            RolloutWriterCommand::Flush { ack } => {
                let _ = ack.send(state.flush());
            }
            RolloutWriterCommand::Shutdown { ack } => match state.shutdown() {
                Ok(()) => {
                    let _ = ack.send(Ok(()));
                    return;
                }
                Err(error) => {
                    let _ = ack.send(Err(error));
                }
            },
        }
    }
    if let Err(error) = state.shutdown() {
        if let Ok(mut failure) = terminal_failure.lock() {
            *failure = Some(error);
        }
    }
}

fn ensure_newline_terminated(file: &mut File, path: &Path) -> Result<(), WorkerProtocolError> {
    let length = file
        .metadata()
        .map_err(|error| writer_io_error(path, "inspect", error))?
        .len();
    if length == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|error| writer_io_error(path, "inspect_tail", error))?;
    let mut tail = [0u8; 1];
    file.read_exact(&mut tail)
        .map_err(|error| writer_io_error(path, "inspect_tail", error))?;
    if tail[0] != b'\n' {
        file.write_all(b"\n")
            .and_then(|_| file.flush())
            .map_err(|error| writer_io_error(path, "repair_newline", error))?;
    }
    Ok(())
}

fn next_rollout_ordinal(path: &Path, lines: &[RolloutLine]) -> Result<u64, WorkerProtocolError> {
    if lines.is_empty() {
        return Ok(0);
    }
    if !matches!(lines[0].item, RolloutItem::SessionMeta(_)) {
        return Err(writer_error(
            path,
            "resume",
            "rollout does not start with session metadata".to_string(),
            false,
        ));
    }
    let mut observed_numbered_record = false;
    for (index, line) in lines.iter().enumerate() {
        let expected = u64::try_from(index).map_err(|_| {
            writer_error(
                path,
                "resume",
                "rollout contains more records than the ordinal range supports".to_string(),
                false,
            )
        })?;
        match line.ordinal {
            Some(actual) if actual == expected => observed_numbered_record = true,
            Some(actual) => {
                return Err(writer_error(
                    path,
                    "resume",
                    format!(
                        "rollout ordinal mismatch at physical line {}: expected {expected}, found {actual}",
                        index + 1
                    ),
                    false,
                ));
            }
            None if observed_numbered_record => {
                return Err(writer_error(
                    path,
                    "resume",
                    format!(
                        "rollout record at physical line {} is missing an ordinal after numbered records",
                        index + 1
                    ),
                    false,
                ));
            }
            None => {}
        }
    }
    u64::try_from(lines.len()).map_err(|_| {
        writer_error(
            path,
            "resume",
            "rollout contains more records than the ordinal range supports".to_string(),
            false,
        )
    })
}

fn writer_retry_error(
    path: &Path,
    operation: &str,
    first_error: &WorkerProtocolError,
    final_error: &WorkerProtocolError,
    pending_count: usize,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!(
            "rollout writer {operation} failed after reopen retry: {}",
            final_error.message
        ),
        serde_json::json!({
            "method": "thread_log.writer",
            "operation": operation,
            "path": path.display().to_string(),
            "pendingCount": pending_count,
            "firstError": first_error.message,
            "finalError": final_error.message,
        }),
        final_error.retryable,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn writer_io_error(path: &Path, operation: &str, error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("rollout writer {operation} IO error: {error}"),
        serde_json::json!({
            "method": "thread_log.writer",
            "operation": operation,
            "path": path.display().to_string(),
            "errorKind": format!("{:?}", error.kind()),
            "rawOsError": error.raw_os_error(),
        }),
        true,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn writer_error(
    path: &Path,
    operation: &str,
    message: String,
    retryable: bool,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        serde_json::json!({
            "method": "thread_log.writer",
            "operation": operation,
            "path": path.display().to_string(),
        }),
        retryable,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn writer_lock_error(path: &Path, operation: &str) -> WorkerProtocolError {
    writer_error(
        path,
        operation,
        "rollout writer lock is poisoned".to_string(),
        false,
    )
}
