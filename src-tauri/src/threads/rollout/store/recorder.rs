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
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard};

use super::compression::{
    compress_rollout, compressed_rollout_path, is_rollout_compressed,
    materialize_rollout_for_append, remove_rollout,
};
use super::rollout_writer::RolloutWriter;

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
    writer_pool: Arc<WriterPool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WriterPoolLifecycle {
    Running,
    Closing,
    Closed,
}

struct WriterPool {
    lifecycle: RwLock<WriterPoolLifecycle>,
    writers: Mutex<HashMap<PathBuf, Arc<RolloutWriter>>>,
    path_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl WriterPool {
    fn new() -> Self {
        Self {
            lifecycle: RwLock::new(WriterPoolLifecycle::Running),
            writers: Mutex::new(HashMap::new()),
            path_locks: Mutex::new(HashMap::new()),
        }
    }
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
            writer_pool: Arc::new(WriterPool::new()),
        }
    }

    pub fn create_thread(&self, meta: ThreadMeta) -> Result<PathBuf, WorkerProtocolError> {
        let path = self.thread_path(&meta.thread_id, &meta.created_at)?;
        self.append_lines_persisted(
            &path,
            vec![ThreadLogLine {
                timestamp: meta.created_at.clone(),
                ordinal: None,
                item: ThreadLogItem::SessionMeta(meta),
            }],
        )?;
        Ok(path)
    }

    pub fn append_item(
        &self,
        path: &Path,
        timestamp: String,
        item: ThreadLogItem,
    ) -> Result<(), WorkerProtocolError> {
        self.append_lines_persisted(
            path,
            vec![ThreadLogLine {
                timestamp,
                ordinal: None,
                item,
            }],
        )
    }

    pub fn append_items(
        &self,
        path: &Path,
        timestamp: String,
        items: Vec<ThreadLogItem>,
    ) -> Result<(), WorkerProtocolError> {
        let lines = items
            .into_iter()
            .map(|item| ThreadLogLine {
                timestamp: timestamp.clone(),
                ordinal: None,
                item,
            })
            .collect();
        self.append_lines_persisted(path, lines)
    }

    pub fn append_lines(
        &self,
        path: &Path,
        lines: Vec<ThreadLogLine>,
    ) -> Result<(), WorkerProtocolError> {
        self.append_lines_persisted(path, lines)
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

    #[cfg(test)]
    pub fn persist(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.with_existing_writer(path, |writer| writer.persist())
    }

    pub fn flush(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.with_existing_writer(path, |writer| writer.flush())
    }

    pub fn flush_all(&self) -> Result<(), WorkerProtocolError> {
        let lifecycle = self
            .writer_pool
            .lifecycle
            .write()
            .map_err(|_| writer_pool_lock_error("flush lifecycle"))?;
        ensure_writer_pool_running(*lifecycle)?;
        let writers = self.writer_snapshot()?;
        let failures = writers
            .into_iter()
            .filter_map(|(path, writer)| writer.flush().err().map(|error| (path, error)))
            .collect::<Vec<_>>();
        writer_batch_result("flush_all", failures)
    }

    pub fn shutdown_all(&self) -> Result<(), WorkerProtocolError> {
        let mut lifecycle = self
            .writer_pool
            .lifecycle
            .write()
            .map_err(|_| writer_pool_lock_error("shutdown lifecycle"))?;
        if *lifecycle == WriterPoolLifecycle::Closed {
            return Ok(());
        }
        *lifecycle = WriterPoolLifecycle::Closing;
        let writers = self.writer_snapshot()?;
        let mut failures = Vec::new();
        for (path, writer) in writers {
            match writer.shutdown() {
                Ok(()) => self.remove_writer_if_current(&path, &writer)?,
                Err(error) => failures.push((path, error)),
            }
        }
        if failures.is_empty() {
            *lifecycle = WriterPoolLifecycle::Closed;
        }
        writer_batch_result("shutdown_all", failures)
    }

    pub(super) fn with_inactive_writer_path<T>(
        &self,
        path: &Path,
        operation: impl FnOnce() -> Result<T, WorkerProtocolError>,
    ) -> Result<Option<T>, WorkerProtocolError> {
        let _operation_guard = self.running_operation()?;
        self.validate_thread_path(path)?;
        let path_lock = self.path_lock(path)?;
        let _path_guard = path_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("inactive writer path lifecycle"))?;
        if self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?
            .contains_key(path)
        {
            return Ok(None);
        }
        operation().map(Some)
    }

    #[cfg(test)]
    pub fn shutdown(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        self.retire_path(path, || Ok(()))
    }

    pub fn delete_rollout(&self, path: &Path) -> Result<(), WorkerProtocolError> {
        self.validate_thread_path(path)?;
        self.retire_path(path, || remove_rollout(path))
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

    #[cfg(test)]
    fn add_lines(&self, path: &Path, lines: Vec<ThreadLogLine>) -> Result<(), WorkerProtocolError> {
        let lines = persistable_lines(lines)?;
        if lines.is_empty() {
            return Ok(());
        }
        self.with_writer(path, move |writer| writer.add_items(lines))
    }

    fn append_lines_persisted(
        &self,
        path: &Path,
        lines: Vec<ThreadLogLine>,
    ) -> Result<(), WorkerProtocolError> {
        let _operation_guard = self.running_operation()?;
        self.validate_thread_path(path)?;
        let lines = persistable_lines(lines)?;
        if lines.is_empty() {
            return Ok(());
        }
        let path_lock = self.path_lock(path)?;
        let _path_guard = path_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("writer path lifecycle"))?;
        let writer = self.writer_locked(path)?;
        writer.add_items(lines)?;
        writer.persist()
    }

    #[cfg(test)]
    fn with_writer<T>(
        &self,
        path: &Path,
        operation: impl FnOnce(&RolloutWriter) -> Result<T, WorkerProtocolError>,
    ) -> Result<T, WorkerProtocolError> {
        let _operation_guard = self.running_operation()?;
        self.validate_thread_path(path)?;
        let path_lock = self.path_lock(path)?;
        let _path_guard = path_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("writer path lifecycle"))?;
        let writer = self.writer_locked(path)?;
        operation(&writer)
    }

    fn with_existing_writer(
        &self,
        path: &Path,
        operation: impl FnOnce(&RolloutWriter) -> Result<(), WorkerProtocolError>,
    ) -> Result<(), WorkerProtocolError> {
        let _operation_guard = self.running_operation()?;
        self.validate_thread_path(path)?;
        let path_lock = self.path_lock(path)?;
        let _path_guard = path_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("writer path lifecycle"))?;
        let writer = self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?
            .get(path)
            .cloned();
        match writer {
            Some(writer) => operation(&writer),
            None => Ok(()),
        }
    }

    fn writer_locked(&self, path: &Path) -> Result<Arc<RolloutWriter>, WorkerProtocolError> {
        materialize_rollout_for_append(path)?;
        let mut writers = self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?;
        if let Some(writer) = writers.get(path) {
            return Ok(writer.clone());
        }
        let writer = Arc::new(RolloutWriter::spawn(path.to_path_buf())?);
        writers.insert(path.to_path_buf(), writer.clone());
        Ok(writer)
    }

    fn running_operation(
        &self,
    ) -> Result<RwLockReadGuard<'_, WriterPoolLifecycle>, WorkerProtocolError> {
        let lifecycle = self
            .writer_pool
            .lifecycle
            .read()
            .map_err(|_| writer_pool_lock_error("operation lifecycle"))?;
        ensure_writer_pool_running(*lifecycle)?;
        Ok(lifecycle)
    }

    fn path_lock(&self, path: &Path) -> Result<Arc<Mutex<()>>, WorkerProtocolError> {
        let mut path_locks = self
            .writer_pool
            .path_locks
            .lock()
            .map_err(|_| writer_pool_lock_error("path lock registry"))?;
        Ok(path_locks
            .entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    fn writer_snapshot(&self) -> Result<Vec<(PathBuf, Arc<RolloutWriter>)>, WorkerProtocolError> {
        let mut writers = self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?
            .iter()
            .map(|(path, writer)| (path.clone(), writer.clone()))
            .collect::<Vec<_>>();
        writers.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(writers)
    }

    fn remove_writer_if_current(
        &self,
        path: &Path,
        expected: &Arc<RolloutWriter>,
    ) -> Result<(), WorkerProtocolError> {
        let mut writers = self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?;
        if writers
            .get(path)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            writers.remove(path);
        }
        Ok(())
    }

    fn retire_path<T>(
        &self,
        path: &Path,
        operation: impl FnOnce() -> Result<T, WorkerProtocolError>,
    ) -> Result<T, WorkerProtocolError> {
        let _operation_guard = self.running_operation()?;
        let path_lock = self.path_lock(path)?;
        let _path_guard = path_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("writer path lifecycle"))?;
        let writer = self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?
            .get(path)
            .cloned();
        if let Some(writer) = writer {
            writer.shutdown()?;
            self.remove_writer_if_current(path, &writer)?;
        }
        operation()
    }

    #[cfg(test)]
    fn writer(&self, path: &Path) -> Result<Arc<RolloutWriter>, WorkerProtocolError> {
        let _operation_guard = self.running_operation()?;
        self.validate_thread_path(path)?;
        let path_lock = self.path_lock(path)?;
        let _path_guard = path_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("writer path lifecycle"))?;
        self.writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?
            .get(path)
            .cloned()
            .ok_or_else(|| thread_log_validation_error("thread log writer is not active"))
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
        let _operation_guard = self.running_operation()?;
        let source_lock = self.path_lock(path)?;
        let target_lock = self.path_lock(&target)?;
        let (first_lock, second_lock) = if path <= target.as_path() {
            (&source_lock, &target_lock)
        } else {
            (&target_lock, &source_lock)
        };
        let _first_guard = first_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("relocation path lifecycle"))?;
        let _second_guard = second_lock
            .lock()
            .map_err(|_| writer_pool_lock_error("relocation path lifecycle"))?;
        if self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?
            .contains_key(&target)
        {
            return Err(thread_log_validation_error(
                "thread log relocation target has an active writer",
            ));
        }
        let source_writer = self
            .writer_pool
            .writers
            .lock()
            .map_err(|_| writer_pool_lock_error("writer registry"))?
            .get(path)
            .cloned();
        if let Some(writer) = source_writer {
            writer.shutdown()?;
            self.remove_writer_if_current(path, &writer)?;
        }
        materialize_rollout_for_append(path)?;
        if target.exists() {
            return Err(thread_log_validation_error(
                "thread log relocation target already exists",
            ));
        }
        fs::rename(path, &target).map_err(thread_log_io_error)?;
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

fn persistable_lines(lines: Vec<ThreadLogLine>) -> Result<Vec<ThreadLogLine>, WorkerProtocolError> {
    lines
        .into_iter()
        .filter_map(|line| match should_persist_rollout_item(&line.item) {
            Ok(true) => Some(Ok(line)),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn ensure_writer_pool_running(lifecycle: WriterPoolLifecycle) -> Result<(), WorkerProtocolError> {
    match lifecycle {
        WriterPoolLifecycle::Running => Ok(()),
        WriterPoolLifecycle::Closing => Err(thread_log_validation_error(
            "thread log writer pool is shutting down",
        )),
        WriterPoolLifecycle::Closed => Err(thread_log_validation_error(
            "thread log writer pool has shut down",
        )),
    }
}

fn writer_pool_lock_error(operation: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        "thread log writer pool lock is poisoned",
        serde_json::json!({
            "method": "thread_log.writer_pool",
            "operation": operation,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn writer_batch_result(
    operation: &str,
    mut failures: Vec<(PathBuf, WorkerProtocolError)>,
) -> Result<(), WorkerProtocolError> {
    if failures.is_empty() {
        return Ok(());
    }
    failures.sort_by(|left, right| left.0.cmp(&right.0));
    let retryable = failures.iter().all(|(_, error)| error.retryable);
    let details = failures
        .iter()
        .map(|(path, error)| {
            serde_json::json!({
                "path": path.display().to_string(),
                "code": format!("{:?}", error.code),
                "message": error.message,
                "retryable": error.retryable,
            })
        })
        .collect::<Vec<_>>();
    Err(WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!(
            "thread log writer {operation} failed for {} path(s)",
            failures.len()
        ),
        serde_json::json!({
            "method": "thread_log.writer_pool",
            "operation": operation,
            "failures": details,
        }),
        retryable,
        WorkerProtocolErrorSource::RustCore,
    ))
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
