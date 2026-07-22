use super::compression::open_rollout_reader;
use super::ThreadLogLine;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
#[cfg(test)]
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ThreadDiscoveryScan {
    pub(super) lines: Vec<ThreadLogLine>,
    pub(super) diagnostics: Vec<String>,
}

pub fn read_thread_lines(path: &Path) -> Result<Vec<ThreadLogLine>, WorkerProtocolError> {
    let reader = open_rollout_reader(path)?;
    let mut lines = Vec::new();
    for (index, raw_line) in BufReader::new(reader).lines().enumerate() {
        let raw_line = raw_line.map_err(thread_log_read_error)?;
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
        lines.push(line);
    }
    validate_rollout_ordinals(path, &lines)?;
    Ok(lines)
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
mod tests {
    use super::*;
    use crate::threads::rollout::format::{EventKind, EventMsg};
    use crate::threads::rollout::store::{ThreadLogItem, ThreadLogLine, ThreadMeta};
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tinybot-thread-log-reader-{name}-{}",
            std::process::id()
        ))
    }

    fn valid_line() -> ThreadLogLine {
        ThreadLogLine {
            timestamp: "2026-07-08T10:12:30Z".to_string(),
            ordinal: None,
            item: ThreadLogItem::SessionMeta(ThreadMeta {
                schema_version: crate::threads::rollout::store::THREAD_LOG_SCHEMA_VERSION,
                thread_id: "thread-a".to_string(),
                session_id: Some("session-a".to_string()),
                created_at: "2026-07-08T10:12:30Z".to_string(),
                cwd: String::new(),
                source: "desktop".to_string(),
                model_provider: None,
                model: None,
                base_instructions: None,
                history_mode: Some("default".to_string()),
                forked_from_thread_id: None,
                parent_thread_id: None,
                originator: Some("Tinybot Desktop".to_string()),
            }),
        }
    }

    #[test]
    fn reader_surfaces_invalid_json_line_number() {
        let path = temp_path("invalid-json");
        let valid = serde_json::to_string(&valid_line()).unwrap();
        fs::write(&path, format!("{valid}\nnot-json\n")).unwrap();

        let error = read_thread_lines(&path).unwrap_err();

        assert!(error.message.contains("invalid thread log JSON at line 2"));
        assert_eq!(error.details["line"], 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reader_rejects_blank_lines() {
        let path = temp_path("blank-line");
        let valid = serde_json::to_string(&valid_line()).unwrap();
        fs::write(&path, format!("{valid}\n   \n")).unwrap();

        let error = read_thread_lines(&path).unwrap_err();

        assert!(error.message.contains("blank thread log line"));
        assert_eq!(error.details["line"], 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reader_rejects_missing_ordinal_after_numbered_records() {
        let path = temp_path("missing-ordinal");
        let mut first = valid_line();
        first.ordinal = Some(0);
        let second = ThreadLogLine {
            timestamp: "2026-07-08T10:13:30Z".to_string(),
            ordinal: None,
            item: ThreadLogItem::EventMsg(EventMsg::new(
                EventKind::TurnStarted,
                serde_json::json!({}),
            )),
        };
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                serde_json::to_string(&first).unwrap(),
                serde_json::to_string(&second).unwrap()
            ),
        )
        .unwrap();

        let error = read_thread_lines(&path).unwrap_err();

        assert!(error.message.contains("missing an ordinal"));
        assert_eq!(error.details["line"], 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reader_accepts_legacy_prefix_followed_by_numbered_records() {
        let path = temp_path("legacy-prefix");
        let first = valid_line();
        let second = ThreadLogLine {
            timestamp: "2026-07-08T10:13:30Z".to_string(),
            ordinal: Some(1),
            item: ThreadLogItem::EventMsg(EventMsg::new(
                EventKind::TurnStarted,
                serde_json::json!({}),
            )),
        };
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                serde_json::to_string(&first).unwrap(),
                serde_json::to_string(&second).unwrap()
            ),
        )
        .unwrap();

        assert_eq!(read_thread_lines(&path).unwrap().len(), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn discovery_reader_skips_bad_rows_but_full_replay_remains_strict() {
        let path = temp_path("discovery-bad-row");
        let mut first = valid_line();
        first.ordinal = Some(0);
        let third = ThreadLogLine {
            timestamp: "2026-07-08T10:13:30Z".to_string(),
            ordinal: Some(2),
            item: ThreadLogItem::EventMsg(EventMsg::new(
                EventKind::UserMessage,
                serde_json::json!({"content": "discoverable"}),
            )),
        };
        fs::write(
            &path,
            format!(
                "{}\nnot-json\n{}\n",
                serde_json::to_string(&first).unwrap(),
                serde_json::to_string(&third).unwrap()
            ),
        )
        .unwrap();

        assert!(read_thread_lines(&path).is_err());
        let scan = read_thread_lines_for_discovery(&path).unwrap();
        assert_eq!(scan.lines.len(), 2);
        assert_eq!(scan.diagnostics.len(), 1);
        assert!(scan.diagnostics[0].contains("line 2"));
        let _ = fs::remove_file(path);
    }
}
