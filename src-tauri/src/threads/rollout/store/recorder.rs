use super::{ThreadLogItem, ThreadLogLine, ThreadMeta};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
#[cfg(test)]
use crate::threads::rollout::format::ResponseItem;
use crate::threads::rollout::format::{should_persist_rollout_item, EventKind, EventMsg};
#[cfg(test)]
use crate::threads::time::now_thread_timestamp;
use crate::threads::time::unix_seconds_to_utc;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::compression::{
    compress_rollout, compressed_rollout_path, is_rollout_compressed,
    materialize_rollout_for_append, remove_rollout,
};
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

    #[cfg(test)]
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

    #[cfg(test)]
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

    pub fn delete_rollout(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        retire_writer_for_path(path, || remove_rollout(path))?;
        self.writers
            .lock()
            .map_err(|_| {
                thread_log_validation_error("thread log writer registry lock is poisoned")
            })?
            .remove(path);
        Ok(())
    }

    pub fn archive_rollout(&self, path: &Path) -> Result<PathBuf, WorkerProtocolError> {
        let target = self.relocate_rollout(path, &self.root, &self.archive_root)?;
        if let Err(error) = compress_rollout(&target) {
            if let Err(rollback_error) =
                self.relocate_rollout(&target, &self.archive_root, &self.root)
            {
                eprintln!(
                    "rollout_archive_compression_rollback_failed source={} target={} \
                     compression_error={} rollback_error={}",
                    path.display(),
                    target.display(),
                    error.message,
                    rollback_error.message
                );
            }
            return Err(error);
        }
        Ok(target)
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

    #[cfg(test)]
    pub(super) fn is_compressed(&self, path: &Path) -> Result<bool, WorkerProtocolError> {
        is_rollout_compressed(path)
    }

    pub(super) fn thread_log_head(
        &self,
        path: &Path,
    ) -> Result<ThreadLogHead, WorkerProtocolError> {
        self.validate_thread_path(path)?;
        let storage_path = if is_rollout_compressed(path)? {
            compressed_rollout_path(path)?
        } else {
            path.to_path_buf()
        };
        let mut file = fs::File::open(&storage_path).map_err(thread_log_io_error)?;
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
        let lines = lines
            .into_iter()
            .filter_map(|line| match should_persist_rollout_item(&line.item) {
                Ok(true) => Some(Ok(line)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if lines.is_empty() {
            return Ok(());
        }
        self.writer(path)?.add_items(lines)
    }

    fn writer(&self, path: &Path) -> Result<std::sync::Arc<RolloutWriter>, WorkerProtocolError> {
        self.validate_thread_path(path)?;
        materialize_rollout_for_append(path)?;
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
            materialize_rollout_for_append(path)?;
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

#[cfg(test)]
#[path = "recorder_tests.rs"]
mod tests;
