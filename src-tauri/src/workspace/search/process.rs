use super::{filesystem_error, search_io, WorkerProtocolError, WorkerRequestCancellation};
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, ExitStatus},
    sync::mpsc::{sync_channel, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

const MAX_RECORD_BYTES: usize = 256 * 1024;
const MAX_STDERR_BYTES: usize = 8192;

pub(super) struct Execution {
    pub record_limit: bool,
}

enum Output {
    Line(Vec<u8>),
    RecordLimit,
    Error(std::io::Error),
}

// Also reap on unwinding: searches must not leave detached background processes.
struct SearchChild(Child);
impl Drop for SearchChild {
    fn drop(&mut self) {
        if let Err(error) = self.0.kill().and_then(|_| self.0.wait()) {
            eprintln!("workspace_search_cleanup_failed error={error}");
        }
    }
}

pub(super) fn run(
    command: &mut Command,
    cancellation: Option<&dyn WorkerRequestCancellation>,
    timeout: Duration,
    mut consume: impl FnMut(&[u8]) -> Result<bool, WorkerProtocolError>,
) -> Result<Execution, WorkerProtocolError> {
    check_interrupt(cancellation, Instant::now(), timeout)?;
    let mut child = SearchChild(
        command
            .spawn()
            .map_err(|e| search_io("start bundled ripgrep", e))?,
    );
    let stdout = child.0.stdout.take().expect("search stdout must be piped");
    let stderr = child.0.stderr.take().expect("search stderr must be piped");
    let (sender, receiver) = sync_channel(8);
    thread::scope(move |scope| {
        let output = scope.spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take((MAX_RECORD_BYTES + 1) as u64)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(_) if line.len() > MAX_RECORD_BYTES => {
                        let _ = sender.send(Output::RecordLimit);
                        break;
                    }
                    Ok(_) => {
                        if sender.send(Output::Line(line)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Output::Error(error));
                        break;
                    }
                }
            }
        });
        let errors = scope.spawn(move || -> std::io::Result<Vec<u8>> {
            let mut reader = BufReader::new(stderr);
            let mut bytes = Vec::new();
            reader
                .by_ref()
                .take(MAX_STDERR_BYTES as u64)
                .read_to_end(&mut bytes)?;
            // Continue draining to avoid a full stderr pipe blocking the process.
            std::io::copy(&mut reader, &mut std::io::sink())?;
            Ok(bytes)
        });
        let started = Instant::now();
        let mut record_limit = false;
        let result = (|| {
            loop {
                check_interrupt(cancellation, started, timeout)?;
                match receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(Output::Line(line)) => {
                        if !consume(&line)? {
                            return Ok(None);
                        }
                    }
                    Ok(Output::RecordLimit) => {
                        record_limit = true;
                        return Ok(None);
                    }
                    Ok(Output::Error(error)) => {
                        return Err(search_io("read ripgrep stdout", error))
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            loop {
                check_interrupt(cancellation, started, timeout)?;
                if let Some(status) = child
                    .0
                    .try_wait()
                    .map_err(|e| search_io("wait for ripgrep", e))?
                {
                    return Ok(Some(status));
                }
                thread::sleep(Duration::from_millis(20));
            }
        })();
        // Disconnect before joining the bounded producer; it may be blocked on send.
        drop(receiver);
        let status: Result<ExitStatus, WorkerProtocolError> = match &result {
            Ok(Some(status)) => Ok(*status),
            _ => child
                .0
                .kill()
                .and_then(|_| child.0.wait())
                .map_err(|e| search_io("terminate ripgrep", e)),
        };
        output
            .join()
            .map_err(|_| filesystem_error("ripgrep stdout reader panicked", json!({})))?;
        let stderr = errors
            .join()
            .map_err(|_| filesystem_error("ripgrep stderr reader panicked", json!({})))?
            .map_err(|e| search_io("read ripgrep stderr", e))?;
        let completed = result?;
        let status = status?;
        if !stderr.is_empty() || (completed.is_some() && !matches!(status.code(), Some(0 | 1))) {
            return Err(filesystem_error(
                "ripgrep search failed",
                json!({
                    "exitCode": status.code(), "stderr": String::from_utf8_lossy(&stderr),
                    "stderrMayBeTruncated": stderr.len() == MAX_STDERR_BYTES,
                }),
            ));
        }
        Ok(Execution { record_limit })
    })
}

fn check_interrupt(
    cancellation: Option<&dyn WorkerRequestCancellation>,
    started: Instant,
    timeout: Duration,
) -> Result<(), WorkerProtocolError> {
    if cancellation.is_some_and(WorkerRequestCancellation::is_cancelled) {
        return Err(filesystem_error(
            "file content search cancelled",
            json!({"cancelled": true}),
        ));
    }
    if started.elapsed() >= timeout {
        return Err(filesystem_error(
            "file content search timed out",
            json!({"timedOut": true}),
        ));
    }
    Ok(())
}
