use super::ThreadLogLine;
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use std::fs;
use std::path::Path;

pub fn read_thread_lines(path: &Path) -> Result<Vec<ThreadLogLine>, WorkerProtocolError> {
    let content = fs::read_to_string(path).map_err(thread_log_read_error)?;
    let mut lines = Vec::new();
    for (index, raw_line) in content.lines().enumerate() {
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
    use crate::worker_thread_log::{ThreadLogItem, ThreadLogLine, ThreadMeta};
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
                schema_version: crate::worker_thread_log::THREAD_LOG_SCHEMA_VERSION,
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
            item: ThreadLogItem::EventMsg(serde_json::json!({ "type": "turn_started" })),
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
            item: ThreadLogItem::EventMsg(serde_json::json!({ "type": "turn_started" })),
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
}
