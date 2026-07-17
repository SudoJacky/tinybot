use super::{ThreadLogItem, ThreadLogLine, ThreadMeta};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
#[cfg(test)]
use crate::worker_rollout::ResponseItem;
use crate::worker_rollout::{EventKind, EventMsg};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use super::rollout_writer::{retire_writer_for_path, writer_for_path, RolloutWriter};

const THREAD_LOG_HEAD_TAIL_BYTES: u64 = 8 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ThreadLogHead {
    pub(super) byte_length: i64,
    pub(super) tail_hash: String,
}

#[derive(Clone)]
pub struct ThreadRecorder {
    root: PathBuf,
    archive_root: PathBuf,
    writers: Arc<Mutex<HashMap<PathBuf, Arc<RolloutWriter>>>>,
}

impl std::fmt::Debug for ThreadRecorder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ThreadRecorder")
            .field("root", &self.root)
            .field("archive_root", &self.archive_root)
            .finish_non_exhaustive()
    }
}

impl ThreadRecorder {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            root: workspace_root.join(".tinybot").join("threads"),
            archive_root: workspace_root.join(".tinybot").join("archived_threads"),
            writers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_thread(&self, meta: ThreadMeta) -> Result<PathBuf, WorkerProtocolError> {
        let path = self.thread_path(&meta.thread_id, &meta.created_at)?;
        self.add_lines(
            &path,
            vec![ThreadLogLine {
                timestamp: meta.created_at.clone(),
                ordinal: None,
                item: ThreadLogItem::SessionMeta(meta),
            }],
        )?;
        self.persist(&path)?;
        Ok(path)
    }

    pub fn append_item(
        &self,
        path: &Path,
        timestamp: String,
        item: ThreadLogItem,
    ) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        self.add_lines(
            path,
            vec![ThreadLogLine {
                timestamp,
                ordinal: None,
                item,
            }],
        )?;
        self.persist(path)
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
                ordinal: None,
                item,
            })
            .collect();
        self.add_lines(path, lines)?;
        self.persist(path)
    }

    pub fn append_lines(
        &self,
        path: &Path,
        lines: Vec<ThreadLogLine>,
    ) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        self.add_lines(path, lines)?;
        self.persist(path)
    }

    pub fn add_items(
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
                ordinal: None,
                item,
            })
            .collect();
        self.add_lines(path, lines)
    }

    pub fn persist(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.writer(path)?.persist()
    }

    pub fn flush(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.writer(path)?.flush()
    }

    pub fn shutdown(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        let writer = {
            let writers = self.writers.lock().map_err(|_| {
                thread_log_validation_error("thread log writer registry lock is poisoned")
            })?;
            writers.get(path).cloned()
        };
        let Some(writer) = writer else {
            return Ok(());
        };
        if Arc::strong_count(&writer) > 2 {
            return Err(thread_log_validation_error(
                "cannot shutdown rollout writer while another recorder owns it",
            ));
        }
        writer.shutdown()?;
        self.writers
            .lock()
            .map_err(|_| {
                thread_log_validation_error("thread log writer registry lock is poisoned")
            })?
            .remove(path);
        Ok(())
    }

    pub fn shutdown_all(&self) -> Result<(), WorkerProtocolError> {
        let paths = {
            let writers = self.writers.lock().map_err(|_| {
                thread_log_validation_error("thread log writer registry lock is poisoned")
            })?;
            writers.keys().cloned().collect::<Vec<_>>()
        };
        for path in paths {
            self.shutdown(&path)?;
        }
        Ok(())
    }

    pub fn delete_rollout(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        retire_writer_for_path(path, || fs::remove_file(path).map_err(thread_log_io_error))?;
        self.writers
            .lock()
            .map_err(|_| {
                thread_log_validation_error("thread log writer registry lock is poisoned")
            })?
            .remove(path);
        Ok(())
    }

    pub fn archive_rollout(&self, path: &Path) -> Result<PathBuf, WorkerProtocolError> {
        self.relocate_rollout(path, &self.root, &self.archive_root)
    }

    pub fn unarchive_rollout(&self, path: &Path) -> Result<PathBuf, WorkerProtocolError> {
        self.relocate_rollout(path, &self.archive_root, &self.root)
    }

    pub fn validate_thread_path(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        if path.starts_with(&self.root) {
            return validate_thread_path(&self.root, path);
        }
        validate_thread_path(&self.archive_root, path)
    }

    pub fn is_archived_path(&self, path: &Path) -> bool {
        is_canonical_thread_log_path(&self.archive_root, path)
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

    fn add_lines(&self, path: &Path, lines: Vec<ThreadLogLine>) -> Result<(), WorkerProtocolError> {
        if lines.is_empty() {
            return Ok(());
        }
        self.writer(path)?.add_items(lines)
    }

    fn writer(&self, path: &Path) -> Result<std::sync::Arc<RolloutWriter>, WorkerProtocolError> {
        self.validate_thread_path(path)?;
        let mut writers = self.writers.lock().map_err(|_| {
            thread_log_validation_error("thread log writer registry lock is poisoned")
        })?;
        if let Some(writer) = writers.get(path) {
            return Ok(writer.clone());
        }
        let writer = writer_for_path(path)?;
        writers.insert(path.to_path_buf(), writer.clone());
        Ok(writer)
    }

    fn relocate_rollout(
        &self,
        path: &Path,
        from_root: &Path,
        to_root: &Path,
    ) -> Result<PathBuf, WorkerProtocolError> {
        validate_thread_path(from_root, path)?;
        let relative = path.strip_prefix(from_root).map_err(|_| {
            thread_log_validation_error("thread log path escaped relocation source root")
        })?;
        let target = to_root.join(relative);
        validate_thread_path(to_root, &target)?;
        let parent = target.parent().ok_or_else(|| {
            thread_log_validation_error("thread log relocation target has no parent directory")
        })?;
        fs::create_dir_all(parent).map_err(thread_log_io_error)?;
        retire_writer_for_path(path, || {
            if target.exists() {
                return Err(thread_log_validation_error(
                    "thread log relocation target already exists",
                ));
            }
            fs::rename(path, &target).map_err(thread_log_io_error)
        })?;
        self.writers
            .lock()
            .map_err(|_| {
                thread_log_validation_error("thread log writer registry lock is poisoned")
            })?
            .remove(path);
        Ok(target)
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

pub(super) fn canonicalize_thread_timestamp(
    timestamp: &str,
) -> Result<String, WorkerProtocolError> {
    if validate_created_at(timestamp).is_ok() {
        return Ok(timestamp.to_string());
    }
    let millis = timestamp
        .strip_prefix("unix-ms:")
        .unwrap_or(timestamp)
        .parse::<u64>()
        .ok()
        .ok_or_else(|| {
            thread_log_validation_error(
                "invalid thread log timestamp: expected ISO-8601 or unix-ms timestamp",
            )
        })?;
    let seconds = millis / 1_000;
    let fractional_millis = millis % 1_000;
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(seconds);
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fractional_millis:03}Z"
    ))
}

pub fn value_event(event_kind: EventKind, payload: Value) -> ThreadLogItem {
    ThreadLogItem::EventMsg(EventMsg::new(event_kind, payload))
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
        assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
        assert_eq!(lines[0].ordinal, Some(0));
        recorder.shutdown(&path).unwrap();
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
                value_event(
                    EventKind::TurnStarted,
                    serde_json::json!({ "runId": "run-1" }),
                ),
            )
            .unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
        assert!(matches!(lines[1].item, ThreadLogItem::EventMsg(_)));
        assert_eq!(
            lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
            vec![Some(0), Some(1)]
        );
        recorder.shutdown(&path).unwrap();
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
                    value_event(
                        EventKind::TurnStarted,
                        serde_json::json!({ "runId": "run-1" }),
                    ),
                    ThreadLogItem::ResponseItem(
                        ResponseItem::from_value(serde_json::json!({
                            "type": "message",
                            "role": "assistant",
                            "content": "done"
                        }))
                        .unwrap(),
                    ),
                    value_event(
                        EventKind::TurnComplete,
                        serde_json::json!({ "runId": "run-1" }),
                    ),
                ],
            )
            .unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 4);
        assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
        assert!(matches!(lines[1].item, ThreadLogItem::EventMsg(_)));
        assert!(matches!(lines[2].item, ThreadLogItem::ResponseItem(_)));
        assert!(matches!(lines[3].item, ThreadLogItem::EventMsg(_)));
        assert_eq!(
            lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
            vec![Some(0), Some(1), Some(2), Some(3)]
        );
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_retries_buffered_items_after_initial_filesystem_failure() {
        let root = temp_root("retry-buffered");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".tinybot"), "blocks thread directory").unwrap();
        let recorder = ThreadRecorder::new(root.clone());
        let created_at = "2026-07-08T10:12:30Z";

        let error = recorder
            .create_thread(thread_meta(&root, "thread-retry", created_at))
            .unwrap_err();

        assert!(error.retryable);
        assert_eq!(error.details["operation"], "persist");
        assert_eq!(error.details["pendingCount"], 1);

        fs::remove_file(root.join(".tinybot")).unwrap();
        let path = root
            .join(".tinybot")
            .join("threads")
            .join("2026")
            .join("07")
            .join("08")
            .join("thread-2026-07-08T10-12-30-thread-retry.jsonl");
        recorder.persist(&path).unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].ordinal, Some(0));
        assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_repairs_missing_trailing_newline_before_append() {
        let root = temp_root("repair-newline");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(
                &root,
                "thread-repair-newline",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();
        recorder.shutdown(&path).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.pop(), Some(b'\n'));
        fs::write(&path, bytes).unwrap();

        recorder
            .append_item(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                value_event(
                    EventKind::TurnStarted,
                    serde_json::json!({ "runId": "run-1" }),
                ),
            )
            .unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].ordinal, Some(0));
        assert_eq!(lines[1].ordinal, Some(1));
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_continues_ordinals_after_legacy_prefix() {
        let root = temp_root("legacy-prefix");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(
                &root,
                "thread-legacy-prefix",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();
        recorder.shutdown(&path).unwrap();
        let mut legacy_lines = read_thread_lines(&path).unwrap();
        legacy_lines[0].ordinal = None;
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&legacy_lines[0]).unwrap()),
        )
        .unwrap();

        recorder
            .append_item(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                value_event(
                    EventKind::TurnStarted,
                    serde_json::json!({ "runId": "run-1" }),
                ),
            )
            .unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines[0].ordinal, None);
        assert_eq!(lines[1].ordinal, Some(1));
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_instances_share_one_process_writer_per_thread() {
        let root = temp_root("shared-writer");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(
                &root,
                "thread-shared-writer",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();
        let mut workers = Vec::new();
        for index in 0..8 {
            let recorder = ThreadRecorder::new(root.clone());
            let path = path.clone();
            workers.push(std::thread::spawn(move || {
                recorder
                    .append_item(
                        &path,
                        "2026-07-08T10:13:30Z".to_string(),
                        value_event(
                            EventKind::Legacy("worker_event".to_string()),
                            serde_json::json!({ "workerIndex": index }),
                        ),
                    )
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 9);
        assert_eq!(
            lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
            (0..9).map(Some).collect::<Vec<_>>()
        );
        let mut worker_indexes = lines[1..]
            .iter()
            .map(|line| match &line.item {
                ThreadLogItem::EventMsg(event) => event["payload"]["workerIndex"]
                    .as_u64()
                    .expect("worker event index"),
                other => panic!("expected worker event, found {other:?}"),
            })
            .collect::<Vec<_>>();
        worker_indexes.sort_unstable();
        assert_eq!(worker_indexes, (0..8).collect::<Vec<_>>());
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_flush_and_shutdown_are_acknowledged_barriers() {
        let root = temp_root("barriers");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(
                &root,
                "thread-barriers",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();

        recorder
            .add_items(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                vec![value_event(
                    EventKind::Legacy("first".to_string()),
                    serde_json::json!({ "barrier": "flush" }),
                )],
            )
            .unwrap();
        recorder.flush(&path).unwrap();
        assert_eq!(read_thread_lines(&path).unwrap().len(), 2);

        recorder
            .add_items(
                &path,
                "2026-07-08T10:14:30Z".to_string(),
                vec![value_event(
                    EventKind::Legacy("second".to_string()),
                    serde_json::json!({ "barrier": "shutdown" }),
                )],
            )
            .unwrap();
        recorder.shutdown(&path).unwrap();

        let lines = read_thread_lines(&path).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
            vec![Some(0), Some(1), Some(2)]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_fails_fast_on_corrupt_canonical_ordinal() {
        let root = temp_root("corrupt-ordinal");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(
                &root,
                "thread-corrupt-ordinal",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();
        recorder.shutdown(&path).unwrap();
        let mut lines = read_thread_lines(&path).unwrap();
        lines[0].ordinal = Some(7);
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&lines[0]).unwrap()),
        )
        .unwrap();

        let error = recorder
            .append_item(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                value_event(
                    EventKind::TurnStarted,
                    serde_json::json!({ "runId": "run-1" }),
                ),
            )
            .unwrap_err();

        assert!(!error.retryable);
        assert!(error.message.contains("ordinal mismatch"));
        lines[0].ordinal = Some(0);
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&lines[0]).unwrap()),
        )
        .unwrap();
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_delete_fences_live_writers_before_removing_rollout() {
        let root = temp_root("delete-fences-writer");
        let _ = fs::remove_dir_all(&root);
        let owner = ThreadRecorder::new(root.clone());
        let path = owner
            .create_thread(thread_meta(
                &root,
                "thread-delete-fence",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();
        let concurrent = ThreadRecorder::new(root.clone());
        concurrent
            .add_items(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                vec![value_event(
                    EventKind::Legacy("pending_before_delete".to_string()),
                    serde_json::json!({ "runId": "run-delete-fence" }),
                )],
            )
            .unwrap();

        owner.delete_rollout(&path).unwrap();

        assert!(!path.exists());
        let error = concurrent
            .append_item(
                &path,
                "2026-07-08T10:14:30Z".to_string(),
                value_event(
                    EventKind::Legacy("write_after_delete".to_string()),
                    serde_json::json!({ "runId": "run-delete-fence" }),
                ),
            )
            .unwrap_err();
        assert!(error
            .message
            .contains("stopped before acknowledging command"));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recorder_archive_and_unarchive_fence_writers_and_preserve_rollout() {
        let root = temp_root("archive-fences-writer");
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(thread_meta(
                &root,
                "thread-archive-fence",
                "2026-07-08T10:12:30Z",
            ))
            .unwrap();
        recorder
            .append_item(
                &path,
                "2026-07-08T10:13:30Z".to_string(),
                value_event(
                    EventKind::Legacy("before_archive".to_string()),
                    serde_json::json!({ "runId": "run-archive-fence" }),
                ),
            )
            .unwrap();

        let archived_path = recorder.archive_rollout(&path).unwrap();

        assert!(!path.exists());
        assert!(archived_path.exists());
        assert!(recorder.is_archived_path(&archived_path));
        assert_eq!(read_thread_lines(&archived_path).unwrap().len(), 2);
        recorder
            .append_item(
                &archived_path,
                "2026-07-08T10:14:30Z".to_string(),
                value_event(
                    EventKind::Legacy("while_archived".to_string()),
                    serde_json::json!({ "runId": "run-archive-fence" }),
                ),
            )
            .unwrap();

        let restored_path = recorder.unarchive_rollout(&archived_path).unwrap();

        assert_eq!(restored_path, path);
        assert!(!archived_path.exists());
        assert!(restored_path.exists());
        assert!(!recorder.is_archived_path(&restored_path));
        recorder
            .append_item(
                &restored_path,
                "2026-07-08T10:15:30Z".to_string(),
                value_event(
                    EventKind::Legacy("after_unarchive".to_string()),
                    serde_json::json!({ "runId": "run-archive-fence" }),
                ),
            )
            .unwrap();
        assert_eq!(read_thread_lines(&restored_path).unwrap().len(), 4);
        recorder.shutdown(&restored_path).unwrap();
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
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unix_seconds_to_utc_handles_unix_epoch() {
        assert_eq!(unix_seconds_to_utc(0), (1970, 1, 1, 0, 0, 0));
    }
}
