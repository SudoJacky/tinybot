use super::{ThreadLogItem, ThreadLogLine, ThreadMeta};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const THREAD_LOG_HEAD_TAIL_BYTES: u64 = 8 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ThreadLogHead {
    pub(super) byte_length: i64,
    pub(super) tail_hash: String,
}

#[derive(Clone, Debug)]
pub struct ThreadRecorder {
    root: PathBuf,
}

impl ThreadRecorder {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            root: workspace_root.join(".tinybot").join("threads"),
        }
    }

    pub fn create_thread(&self, meta: ThreadMeta) -> Result<PathBuf, WorkerProtocolError> {
        let path = self.thread_path(&meta.thread_id, &meta.created_at)?;
        self.append_line(
            &path,
            ThreadLogLine {
                timestamp: meta.created_at.clone(),
                item: ThreadLogItem::ThreadMeta(meta),
            },
        )?;
        Ok(path)
    }

    pub fn append_item(
        &self,
        path: &Path,
        timestamp: String,
        item: ThreadLogItem,
    ) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        self.append_line(path, ThreadLogLine { timestamp, item })
    }

    pub fn append_items(
        &self,
        path: &Path,
        timestamp: String,
        items: Vec<ThreadLogItem>,
    ) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        let lines = items
            .into_iter()
            .map(|item| ThreadLogLine {
                timestamp: timestamp.clone(),
                item,
            })
            .collect();
        self.append_lines(path, lines)
    }

    pub fn validate_thread_path(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        validate_thread_path(&self.root, path)
    }

    pub(super) fn thread_log_head(
        &self,
        path: &Path,
    ) -> Result<ThreadLogHead, WorkerProtocolError> {
        self.validate_thread_path(path)?;
        let mut file = fs::File::open(path).map_err(thread_log_io_error)?;
        let byte_length = file.metadata().map_err(thread_log_io_error)?.len();
        let tail_start = byte_length.saturating_sub(THREAD_LOG_HEAD_TAIL_BYTES);
        file.seek(SeekFrom::Start(tail_start))
            .map_err(thread_log_io_error)?;
        let mut tail =
            Vec::with_capacity(usize::try_from(byte_length - tail_start).map_err(|_| {
                thread_log_validation_error("thread log tail exceeds supported buffer size")
            })?);
        file.read_to_end(&mut tail).map_err(thread_log_io_error)?;
        Ok(ThreadLogHead {
            byte_length: i64::try_from(byte_length).map_err(|_| {
                thread_log_validation_error("thread log exceeds SQLite length range")
            })?,
            tail_hash: format!("sha256:{:x}", Sha256::digest(tail)),
        })
    }

    fn append_line(&self, path: &Path, line: ThreadLogLine) -> Result<(), WorkerProtocolError> {
        self.append_lines(path, vec![line])
    }

    fn append_lines(
        &self,
        path: &Path,
        lines: Vec<ThreadLogLine>,
    ) -> Result<(), WorkerProtocolError> {
        if lines.is_empty() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(thread_log_io_error)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(thread_log_io_error)?;
        for line in lines {
            let mut serialized = serde_json::to_string(&line).map_err(thread_log_json_error)?;
            serialized.push('\n');
            file.write_all(serialized.as_bytes())
                .map_err(thread_log_io_error)?;
        }
        file.flush().map_err(thread_log_io_error)
    }

    fn thread_path(
        &self,
        thread_id: &str,
        created_at: &str,
    ) -> Result<PathBuf, WorkerProtocolError> {
        validate_created_at(created_at)?;
        validate_thread_id(thread_id)?;
        let year = &created_at[0..4];
        let month = &created_at[5..7];
        let day = &created_at[8..10];
        let safe_timestamp = created_at
            .replace(':', "-")
            .replace('.', "-")
            .replace('Z', "");
        validate_safe_timestamp(&safe_timestamp)?;
        let path = self
            .root
            .join(year)
            .join(month)
            .join(day)
            .join(format!("thread-{safe_timestamp}-{thread_id}.jsonl"));
        if !path.starts_with(&self.root) {
            return Err(thread_log_validation_error(
                "generated thread log path escaped thread root",
            ));
        }
        Ok(path)
    }
}

pub fn now_thread_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must not be earlier than UNIX_EPOCH for thread log timestamps");
    let millis = duration.subsec_millis();
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(duration.as_secs());
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

pub fn value_event(event_type: &str, payload: Value) -> ThreadLogItem {
    ThreadLogItem::EventMsg(serde_json::json!({
        "type": event_type,
        "payload": payload
    }))
}

fn thread_log_io_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread log IO error: {error}"),
        serde_json::json!({ "method": "thread_log" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_log_json_error(error: serde_json::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread log JSON error: {error}"),
        serde_json::json!({ "method": "thread_log" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn validate_thread_id(thread_id: &str) -> Result<(), WorkerProtocolError> {
    if thread_id.trim().is_empty() || thread_id.contains("..") {
        return Err(thread_log_validation_error(
            "invalid thread_id for thread log path",
        ));
    }
    if !thread_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(thread_log_validation_error(
            "invalid thread_id for thread log path",
        ));
    }
    Ok(())
}

fn validate_created_at(created_at: &str) -> Result<(), WorkerProtocolError> {
    let bytes = created_at.as_bytes();
    if bytes.len() < 10 {
        return Err(thread_log_validation_error(
            "invalid thread log timestamp: expected YYYY-MM-DD prefix",
        ));
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return Err(thread_log_validation_error(
            "invalid thread log timestamp: expected YYYY-MM-DD prefix",
        ));
    }
    if created_at.contains("..") || created_at.contains('/') || created_at.contains('\\') {
        return Err(thread_log_validation_error(
            "invalid thread log timestamp for thread log path",
        ));
    }
    Ok(())
}

fn validate_safe_timestamp(safe_timestamp: &str) -> Result<(), WorkerProtocolError> {
    if safe_timestamp.is_empty()
        || !safe_timestamp
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(thread_log_validation_error(
            "invalid thread log timestamp for thread log path",
        ));
    }
    Ok(())
}

fn validate_thread_path(root: &Path, path: &Path) -> Result<(), WorkerProtocolError> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(thread_log_validation_error(
            "thread log path must not contain parent directory components",
        ));
    }
    if !path.starts_with(root) {
        return Err(thread_log_validation_error(
            "thread log path escaped thread root",
        ));
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
        return Err(thread_log_validation_error(
            "thread log path must point to a jsonl file",
        ));
    }
    let Some(file_name) = path.file_name().and_then(|file_name| file_name.to_str()) else {
        return Err(thread_log_validation_error(
            "thread log path missing file name",
        ));
    };
    if !file_name.starts_with("thread-") {
        return Err(thread_log_validation_error(
            "thread log file name must start with thread-",
        ));
    }
    if !is_canonical_thread_log_path(root, path) {
        return Err(thread_log_validation_error(
            "thread log path must match canonical YYYY/MM/DD/thread timestamp layout",
        ));
    }
    Ok(())
}

pub(crate) fn is_canonical_thread_log_path(root: &Path, path: &Path) -> bool {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return false;
    }
    if !path.starts_with(root) {
        return false;
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let Some(parts) = relative
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    if parts.len() != 4 {
        return false;
    }
    let [year, month, day, file_name] = parts.as_slice() else {
        return false;
    };
    if !is_fixed_ascii_digits(year, 4)
        || !is_fixed_ascii_digits(month, 2)
        || !is_fixed_ascii_digits(day, 2)
    {
        return false;
    }
    let expected_file_prefix = format!("thread-{year}-{month}-{day}T");
    file_name.starts_with(&expected_file_prefix) && file_name.ends_with(".jsonl")
}

fn is_fixed_ascii_digits(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn thread_log_validation_error(message: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        serde_json::json!({ "method": "thread_log" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn unix_seconds_to_utc(seconds: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    let (year, month, day) = civil_from_days(days);
    (year, month, day, hour, minute, second)
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let month_prime = (5 * doy + 2) / 153;
    let day = doy - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_thread_log::read_thread_lines;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tinybot-thread-log-{name}-{}", std::process::id()))
    }

    fn thread_meta(root: &Path, thread_id: &str, created_at: &str) -> ThreadMeta {
        ThreadMeta {
            schema_version: crate::worker_thread_log::THREAD_LOG_SCHEMA_VERSION,
            thread_id: thread_id.to_string(),
            session_id: Some("session-a".to_string()),
            created_at: created_at.to_string(),
            cwd: root.display().to_string(),
            source: "desktop".to_string(),
            model_provider: Some("deepseek".to_string()),
            model: Some("deepseek-v4-pro".to_string()),
            base_instructions: None,
            history_mode: Some("default".to_string()),
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: Some("Tinybot Desktop".to_string()),
        }
    }

    #[test]
    fn recorder_creates_single_thread_jsonl_with_meta_first() {
        let root = temp_root("create");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(&root, "thread-a", "2026-07-08T10:12:30Z"))
            .unwrap();

        assert!(path.ends_with("thread-2026-07-08T10-12-30-thread-a.jsonl"));
        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 1);
        assert!(matches!(lines[0].item, ThreadLogItem::ThreadMeta(_)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_appends_items_after_meta() {
        let root = temp_root("append");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(&root, "thread-append", "2026-07-08T10:12:30Z"))
            .unwrap();

        recorder
            .append_item(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                value_event("turn_started", serde_json::json!({ "runId": "run-1" })),
            )
            .unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(matches!(lines[0].item, ThreadLogItem::ThreadMeta(_)));
        assert!(matches!(lines[1].item, ThreadLogItem::EventMsg(_)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_batch_appends_items_after_meta_in_order() {
        let root = temp_root("batch-append");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(
                &root,
                "thread-batch-append",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();

        recorder
            .append_items(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                vec![
                    value_event("turn_started", serde_json::json!({ "runId": "run-1" })),
                    ThreadLogItem::ResponseItem(serde_json::json!({
                        "type": "message",
                        "role": "assistant",
                        "content": "done"
                    })),
                    value_event("turn_complete", serde_json::json!({ "runId": "run-1" })),
                ],
            )
            .unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 4);
        assert!(matches!(lines[0].item, ThreadLogItem::ThreadMeta(_)));
        assert!(matches!(lines[1].item, ThreadLogItem::EventMsg(_)));
        assert!(matches!(lines[2].item, ThreadLogItem::ResponseItem(_)));
        assert!(matches!(lines[3].item, ThreadLogItem::EventMsg(_)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_rejects_unsafe_thread_id() {
        let root = temp_root("unsafe-id");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());

        let error = recorder
            .create_thread(thread_meta(&root, "../thread", "2026-07-08T10:12:30Z"))
            .unwrap_err();

        assert!(error.message.contains("invalid thread_id"));
        assert!(!root.join(".tinybot").join("threads").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_rejects_malformed_created_at() {
        let root = temp_root("bad-time");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());

        let error = recorder
            .create_thread(thread_meta(&root, "thread-a", "not-a-date"))
            .unwrap_err();

        assert!(error.message.contains("invalid thread log timestamp"));
        assert!(!root.join(".tinybot").join("threads").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn now_thread_timestamp_can_create_thread_log_path() {
        let root = temp_root("now-time");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let timestamp = now_thread_timestamp();
        assert!(timestamp.contains(':'));
        assert!(timestamp.contains('.'));

        let path = recorder
            .create_thread(thread_meta(&root, "thread-now", &timestamp))
            .unwrap();

        assert!(path.exists());
        assert!(path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .starts_with(&format!(
                "thread-{}-thread-now",
                timestamp
                    .replace(':', "-")
                    .replace('.', "-")
                    .trim_end_matches('Z')
            )));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unix_seconds_to_utc_handles_unix_epoch() {
        assert_eq!(unix_seconds_to_utc(0), (1970, 1, 1, 0, 0, 0));
    }
}
