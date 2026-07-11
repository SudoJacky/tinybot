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
    Ok(lines)
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
            item: ThreadLogItem::ThreadMeta(ThreadMeta {
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
}
