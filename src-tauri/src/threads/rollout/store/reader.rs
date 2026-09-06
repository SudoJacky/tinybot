use super::compression::open_rollout_reader;
use super::ThreadLogLine;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::runtime::observability::global_agent_runtime_metrics;
#[cfg(test)]
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ThreadDiscoveryScan {
    pub(super) lines: Vec<ThreadLogLine>,
    pub(super) diagnostics: Vec<String>,
}

pub fn read_thread_lines(path: &Path) -> Result<Vec<ThreadLogLine>, WorkerProtocolError> {
    let metrics = global_agent_runtime_metrics();
    metrics.measure("storage.rollout.readAndParse.durationMs", || {
        let reader = metrics.measure("storage.rollout.open.durationMs", || {
            open_rollout_reader(path)
        })?;
        let mut read_duration = Duration::ZERO;
        let mut parse_duration = Duration::ZERO;
        let mut source_bytes = 0u64;
        let mut lines = Vec::new();
        let mut raw_lines = BufReader::new(reader).lines().enumerate();
        loop {
            let started = Instant::now();
            let next = raw_lines.next();
            read_duration += started.elapsed();
            let Some((index, raw_line)) = next else {
                break;
            };
            let raw_line = raw_line.map_err(thread_log_read_error)?;
            source_bytes += raw_line.len() as u64;
            let started = Instant::now();
            let trimmed = raw_line.trim();
            if trimmed.is_empty() {
                return Err(invalid_thread_log_line_error(
                    path,
                    index,
                    "blank thread log line",
                ));
            }
            let line = serde_json::from_str::<ThreadLogLine>(trimmed).map_err(|error| {
                invalid_thread_log_line_error(
                    path,
                    index,
                    &format!("invalid thread log JSON at line {}: {error}", index + 1),
                )
            })?;
            parse_duration += started.elapsed();
            lines.push(line);
        }
        metrics.record_duration(
            "storage.rollout.readAndDecompress.durationMs",
            read_duration,
        );
        metrics.record_duration("storage.rollout.parseJson.durationMs", parse_duration);
        metrics.increment_by("storage.rollout.decodedLineBytes", source_bytes);
        metrics.increment_by("storage.rollout.lines", lines.len() as u64);
        metrics.measure("storage.rollout.validateOrdinals.durationMs", || {
            validate_rollout_ordinals(path, &lines)
        })?;
        Ok(lines)
    })
}

pub(super) fn read_thread_lines_for_discovery(
    path: &Path,
) -> Result<ThreadDiscoveryScan, WorkerProtocolError> {
    let reader = open_rollout_reader(path)?;
    let mut scan = ThreadDiscoveryScan::default();
    let mut previous_ordinal = None;
    for (index, raw_line) in BufReader::new(reader).lines().enumerate() {
        let raw_line = match raw_line {
            Ok(raw_line) => raw_line,
            Err(error) => {
                scan.diagnostics
                    .push(format!("line {} read error: {error}", index + 1));
                continue;
            }
        };
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            scan.diagnostics
                .push(format!("line {} is blank", index + 1));
            continue;
        }
        let line = match serde_json::from_str::<ThreadLogLine>(trimmed) {
            Ok(line) => line,
            Err(error) => {
                scan.diagnostics
                    .push(format!("line {} is invalid JSON: {error}", index + 1));
                continue;
            }
        };
        if let Some(ordinal) = line.ordinal {
            if previous_ordinal.is_some_and(|previous| ordinal <= previous) {
                scan.diagnostics.push(format!(
                    "line {} has non-monotonic ordinal {ordinal}",
                    index + 1
                ));
                continue;
            }
            previous_ordinal = Some(ordinal);
        } else if previous_ordinal.is_some() {
            scan.diagnostics.push(format!(
                "line {} is missing an ordinal after numbered records",
                index + 1
            ));
            continue;
        }
        scan.lines.push(line);
    }
    Ok(scan)
}

fn validate_rollout_ordinals(
    path: &Path,
    lines: &[ThreadLogLine],
) -> Result<(), WorkerProtocolError> {
    let mut observed_numbered_record = false;
    for (index, line) in lines.iter().enumerate() {
        let expected = u64::try_from(index).map_err(|_| {
            invalid_thread_log_line_error(path, index, "thread log ordinal range overflow")
        })?;
        match line.ordinal {
            Some(actual) if actual == expected => observed_numbered_record = true,
            Some(actual) => {
                return Err(invalid_thread_log_line_error(
                    path,
                    index,
                    &format!(
                        "thread log ordinal mismatch at line {}: expected {expected}, found {actual}",
                        index + 1
                    ),
                ));
            }
            None if observed_numbered_record => {
                return Err(invalid_thread_log_line_error(
                    path,
                    index,
                    &format!(
                        "thread log line {} is missing an ordinal after numbered records",
                        index + 1
                    ),
                ));
            }
            None => {}
        }
    }
    Ok(())
}

fn invalid_thread_log_line_error(path: &Path, index: usize, message: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        serde_json::json!({
            "method": "thread_log.read",
            "path": path.display().to_string(),
            "line": index + 1
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_log_read_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread log read error: {error}"),
        serde_json::json!({ "method": "thread_log.read" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
#[path = "reader_tests.rs"]
mod tests;
