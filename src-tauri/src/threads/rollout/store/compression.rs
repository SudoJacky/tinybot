use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

const ZSTD_LEVEL: i32 = 3;
const MIN_ROLLOUT_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RUN_MARKER_STALE_AFTER: Duration = Duration::from_secs(6 * 60 * 60);
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn spawn_rollout_compression_worker(workspace_root: PathBuf) {
    if let Err(error) = std::thread::Builder::new()
        .name("tinybot-rollout-compression".to_string())
        .spawn(move || {
            if let Err(error) = run_rollout_compression_worker(&workspace_root) {
                eprintln!(
                    "rollout_compression_worker_failed workspace={} error={}",
                    workspace_root.display(),
                    error.message
                );
            }
        })
    {
        eprintln!("rollout_compression_worker_spawn_failed error={error}");
    }
}

pub(super) fn open_rollout_reader(
    logical_path: &Path,
) -> Result<Box<dyn Read>, WorkerProtocolError> {
    if logical_path.exists() {
        if compressed_rollout_path(logical_path)
            .is_ok_and(|compressed_path| compressed_path.exists())
        {
            return Err(compression_error(
                "materialized and compressed Rollouts both exist",
                logical_path,
                None,
            ));
        }
        return File::open(logical_path)
            .map(|file| Box::new(BufReader::new(file)) as Box<dyn Read>)
            .map_err(|error| compression_io_error("open_plain", logical_path, error));
    }
    let compressed_path = compressed_rollout_path(logical_path)?;
    let file = File::open(&compressed_path)
        .map_err(|error| compression_io_error("open_compressed", &compressed_path, error))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|error| compression_io_error("open_decoder", &compressed_path, error))?;
    Ok(Box::new(decoder))
}

pub(super) fn rollout_exists(logical_path: &Path) -> Result<bool, WorkerProtocolError> {
    Ok(logical_path.exists() || compressed_rollout_path(logical_path)?.exists())
}

pub(super) fn is_rollout_compressed(logical_path: &Path) -> Result<bool, WorkerProtocolError> {
    Ok(!logical_path.exists() && compressed_rollout_path(logical_path)?.exists())
}

pub(super) fn compress_rollout(logical_path: &Path) -> Result<(), WorkerProtocolError> {
    if !logical_path.exists() {
        if compressed_rollout_path(logical_path)?.exists() {
            return Ok(());
        }
        return Err(compression_error(
            "Rollout does not exist for compression",
            logical_path,
            None,
        ));
    }
    let compressed_path = compressed_rollout_path(logical_path)?;
    if compressed_path.exists() {
        return Err(compression_error(
            "compressed Rollout target already exists",
            &compressed_path,
            None,
        ));
    }
    let source_state = rollout_file_state(logical_path)?;
    let temp_path = temp_path_for(&compressed_path);
    let input = File::open(logical_path)
        .map_err(|error| compression_io_error("compress_open_source", logical_path, error))?;
    let output = create_new_file(&temp_path)?;
    let mut output = BufWriter::new(output);
    let result = zstd::stream::copy_encode(BufReader::new(input), &mut output, ZSTD_LEVEL)
        .map_err(|error| compression_io_error("compress_encode", logical_path, error))
        .and_then(|_| {
            output
                .flush()
                .map_err(|error| compression_io_error("compress_flush", &temp_path, error))
        })
        .and_then(|_| {
            output
                .get_ref()
                .sync_all()
                .map_err(|error| compression_io_error("compress_sync", &temp_path, error))
        })
        .and_then(|_| verify_compressed_rollout(&temp_path))
        .and_then(|_| {
            if rollout_file_state(logical_path)? != source_state {
                return Err(compression_error(
                    "Rollout changed while it was being compressed",
                    logical_path,
                    None,
                ));
            }
            Ok(())
        })
        .and_then(|_| install_no_clobber(&temp_path, &compressed_path))
        .and_then(|_| {
            if rollout_file_state(logical_path)? != source_state {
                let _ = fs::remove_file(&compressed_path);
                return Err(compression_error(
                    "Rollout changed before compressed representation was installed",
                    logical_path,
                    None,
                ));
            }
            match fs::remove_file(logical_path) {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = fs::remove_file(&compressed_path);
                    Err(compression_io_error(
                        "compress_remove_source",
                        logical_path,
                        error,
                    ))
                }
            }
        });
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub(super) fn materialize_rollout_for_append(
    logical_path: &Path,
) -> Result<(), WorkerProtocolError> {
    if logical_path.exists() {
        if compressed_rollout_path(logical_path)?.exists() {
            return Err(compression_error(
                "materialized and compressed Rollouts both exist",
                logical_path,
                None,
            ));
        }
        return Ok(());
    }
    let compressed_path = compressed_rollout_path(logical_path)?;
    if !compressed_path.exists() {
        return Ok(());
    }
    let temp_path = temp_path_for(logical_path);
    let input = File::open(&compressed_path).map_err(|error| {
        compression_io_error("materialize_open_source", &compressed_path, error)
    })?;
    let mut decoder = zstd::stream::read::Decoder::new(input).map_err(|error| {
        compression_io_error("materialize_open_decoder", &compressed_path, error)
    })?;
    let output = create_new_file(&temp_path)?;
    let mut output = BufWriter::new(output);
    let result = std::io::copy(&mut decoder, &mut output)
        .map_err(|error| compression_io_error("materialize_decode", &compressed_path, error))
        .and_then(|_| {
            output
                .flush()
                .map_err(|error| compression_io_error("materialize_flush", &temp_path, error))
        })
        .and_then(|_| {
            output
                .get_ref()
                .sync_all()
                .map_err(|error| compression_io_error("materialize_sync", &temp_path, error))
        })
        .and_then(|_| install_no_clobber(&temp_path, logical_path))
        .and_then(|_| match fs::remove_file(&compressed_path) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(logical_path);
                Err(compression_io_error(
                    "materialize_remove_compressed",
                    &compressed_path,
                    error,
                ))
            }
        });
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub(super) fn remove_rollout(logical_path: &Path) -> Result<(), WorkerProtocolError> {
    let compressed_path = compressed_rollout_path(logical_path)?;
    match (logical_path.exists(), compressed_path.exists()) {
        (true, true) => Err(compression_error(
            "materialized and compressed Rollouts both exist",
            logical_path,
            None,
        )),
        (true, false) => fs::remove_file(logical_path)
            .map_err(|error| compression_io_error("remove_plain", logical_path, error)),
        (false, true) => fs::remove_file(&compressed_path)
            .map_err(|error| compression_io_error("remove_compressed", &compressed_path, error)),
        (false, false) => Err(compression_error(
            "Rollout does not exist for removal",
            logical_path,
            None,
        )),
    }
}

pub(super) fn logical_rollout_path(storage_path: &Path) -> Option<PathBuf> {
    let file_name = storage_path.file_name()?.to_str()?;
    if file_name.ends_with(".jsonl.zst") {
        return Some(storage_path.with_extension(""));
    }
    (storage_path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .then(|| storage_path.to_path_buf())
}

pub(super) fn compressed_rollout_path(logical_path: &Path) -> Result<PathBuf, WorkerProtocolError> {
    if logical_path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err(compression_error(
            "logical Rollout path must end with .jsonl",
            logical_path,
            None,
        ));
    }
    Ok(logical_path.with_extension("jsonl.zst"))
}

fn create_new_file(path: &Path) -> Result<File, WorkerProtocolError> {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| compression_io_error("create_temp", path, error))
}

fn install_no_clobber(temp_path: &Path, target: &Path) -> Result<(), WorkerProtocolError> {
    fs::hard_link(temp_path, target)
        .map_err(|error| compression_io_error("install_no_clobber", target, error))?;
    fs::remove_file(temp_path)
        .map_err(|error| compression_io_error("remove_temp_link", temp_path, error))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RolloutFileState {
    byte_length: u64,
    modified: SystemTime,
}

fn rollout_file_state(path: &Path) -> Result<RolloutFileState, WorkerProtocolError> {
    let metadata = fs::metadata(path)
        .map_err(|error| compression_io_error("read_source_metadata", path, error))?;
    Ok(RolloutFileState {
        byte_length: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|error| compression_io_error("read_source_modified_time", path, error))?,
    })
}

fn verify_compressed_rollout(path: &Path) -> Result<(), WorkerProtocolError> {
    let input =
        File::open(path).map_err(|error| compression_io_error("verify_open", path, error))?;
    let mut decoder = zstd::stream::read::Decoder::new(input)
        .map_err(|error| compression_io_error("verify_decoder", path, error))?;
    std::io::copy(&mut decoder, &mut std::io::sink())
        .map_err(|error| compression_io_error("verify_decode", path, error))?;
    Ok(())
}

struct CompressionRunMarker {
    path: PathBuf,
    keep: bool,
}

impl CompressionRunMarker {
    fn claim(workspace_root: &Path) -> Result<Option<Self>, WorkerProtocolError> {
        let marker_path = workspace_root
            .join(".tinybot")
            .join("state")
            .join("rollout-compression.lock");
        if let Some(parent) = marker_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| compression_io_error("create_marker_dir", parent, error))?;
        }
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&marker_path)
        {
            Ok(mut marker) => {
                writeln!(
                    marker,
                    "pid={} started_at={:?}",
                    std::process::id(),
                    SystemTime::now()
                )
                .map_err(|error| compression_io_error("write_marker", &marker_path, error))?;
                Ok(Some(Self {
                    path: marker_path,
                    keep: false,
                }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&marker_path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age >= RUN_MARKER_STALE_AFTER);
                if !stale {
                    return Ok(None);
                }
                fs::remove_file(&marker_path).map_err(|error| {
                    compression_io_error("remove_stale_marker", &marker_path, error)
                })?;
                Self::claim(workspace_root)
            }
            Err(error) => Err(compression_io_error("create_marker", &marker_path, error)),
        }
    }

    fn persist(mut self) {
        self.keep = true;
    }
}

impl Drop for CompressionRunMarker {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn run_rollout_compression_worker(workspace_root: &Path) -> Result<(), WorkerProtocolError> {
    run_rollout_compression_worker_with_age(workspace_root, MIN_ROLLOUT_AGE)
}

fn run_rollout_compression_worker_with_age(
    workspace_root: &Path,
    minimum_age: Duration,
) -> Result<(), WorkerProtocolError> {
    let rollout_roots = [
        workspace_root.join(".tinybot").join("archived_threads"),
        workspace_root.join(".tinybot").join("threads"),
    ];
    if !rollout_roots.iter().any(|root| root.exists()) {
        return Ok(());
    }
    let Some(marker) = CompressionRunMarker::claim(workspace_root)? else {
        return Ok(());
    };
    let mut scanned = 0usize;
    let mut compressed = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    for root in rollout_roots {
        let mut stack = vec![root];
        while let Some(directory) = stack.pop() {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    failed = failed.saturating_add(1);
                    eprintln!(
                        "rollout_compression_scan_failed path={} error={error}",
                        directory.display()
                    );
                    continue;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        failed = failed.saturating_add(1);
                        eprintln!("rollout_compression_entry_failed error={error}");
                        continue;
                    }
                };
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                scanned = scanned.saturating_add(1);
                let state = match rollout_file_state(&path) {
                    Ok(state) => state,
                    Err(error) => {
                        failed = failed.saturating_add(1);
                        eprintln!(
                            "rollout_compression_metadata_failed path={} error={}",
                            path.display(),
                            error.message
                        );
                        continue;
                    }
                };
                let age = SystemTime::now()
                    .duration_since(state.modified)
                    .unwrap_or(Duration::ZERO);
                if age < minimum_age {
                    skipped = skipped.saturating_add(1);
                    continue;
                }
                match super::rollout_writer::with_inactive_writer_path(&path, || {
                    compress_rollout(&path)
                }) {
                    Ok(Some(())) => compressed = compressed.saturating_add(1),
                    Ok(None) => skipped = skipped.saturating_add(1),
                    Err(error) => {
                        failed = failed.saturating_add(1);
                        eprintln!(
                            "rollout_compression_file_failed path={} error={}",
                            path.display(),
                            error.message
                        );
                    }
                }
            }
        }
    }
    eprintln!(
        "rollout_compression_worker_finished workspace={} scanned={} compressed={} skipped={} failed={}",
        workspace_root.display(),
        scanned,
        compressed,
        skipped,
        failed
    );
    marker.persist();
    Ok(())
}

fn temp_path_for(target: &Path) -> PathBuf {
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("rollout")
        .to_string();
    name.push_str(&format!(".tmp-{}-{sequence}", std::process::id()));
    target.with_file_name(name)
}

fn compression_io_error(
    operation: &str,
    path: &Path,
    error: std::io::Error,
) -> WorkerProtocolError {
    compression_error(
        &format!("Rollout compression IO error during {operation}: {error}"),
        path,
        Some(error.kind()),
    )
}

fn compression_error(
    message: &str,
    path: &Path,
    kind: Option<std::io::ErrorKind>,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        serde_json::json!({
            "method": "rollout.compression",
            "path": path.display().to_string(),
            "ioKind": kind.map(|value| format!("{value:?}")),
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threads::rollout::format::{EventKind, SessionMeta};
    use crate::threads::rollout::store::{read_thread_lines, value_event, ThreadRecorder};

    fn test_rollout_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "tinybot-rollout-compression-{}-{}-{name}",
                std::process::id(),
                TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ))
            .join("rollout.jsonl")
    }

    #[test]
    fn compressed_rollout_reads_exactly_and_materializes_for_append() {
        let path = test_rollout_path("roundtrip");
        let root = path.parent().unwrap();
        let _ = fs::remove_dir_all(root);
        fs::create_dir_all(root).unwrap();
        let contents = b"{\"ordinal\":1,\"type\":\"session_meta\"}\n\
{\"ordinal\":2,\"type\":\"event_msg\"}\n";
        fs::write(&path, contents).unwrap();

        compress_rollout(&path).unwrap();
        let compressed = compressed_rollout_path(&path).unwrap();
        assert!(!path.exists());
        assert!(compressed.exists());
        let mut decoded = Vec::new();
        open_rollout_reader(&path)
            .unwrap()
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, contents);

        materialize_rollout_for_append(&path).unwrap();
        assert!(path.exists());
        assert!(!compressed.exists());
        assert_eq!(fs::read(&path).unwrap(), contents);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reader_rejects_dual_materialized_and_compressed_state() {
        let path = test_rollout_path("dual");
        let root = path.parent().unwrap();
        let _ = fs::remove_dir_all(root);
        fs::create_dir_all(root).unwrap();
        fs::write(&path, b"plain").unwrap();
        fs::write(compressed_rollout_path(&path).unwrap(), b"compressed").unwrap();

        let error = match open_rollout_reader(&path) {
            Ok(_) => panic!("dual Rollout state must be rejected"),
            Err(error) => error,
        };
        assert!(error
            .message
            .contains("materialized and compressed Rollouts both exist"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cold_rollout_worker_compresses_plain_rollouts_without_changing_logical_path() {
        let root = test_rollout_path("cold-worker")
            .parent()
            .unwrap()
            .to_path_buf();
        let _ = fs::remove_dir_all(&root);
        let path = root
            .join(".tinybot")
            .join("threads")
            .join("2026")
            .join("07")
            .join("17")
            .join("thread-2026-07-17T00-00-00-thread-cold.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{\"ordinal\":0,\"type\":\"session_meta\"}\n").unwrap();

        run_rollout_compression_worker_with_age(&root, Duration::ZERO).unwrap();

        assert!(!path.exists());
        assert!(compressed_rollout_path(&path).unwrap().exists());
        let mut decoded = Vec::new();
        open_rollout_reader(&path)
            .unwrap()
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, b"{\"ordinal\":0,\"type\":\"session_meta\"}\n");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cold_rollout_worker_skips_live_writer_and_future_append_remains_valid() {
        let root = test_rollout_path("live-writer")
            .parent()
            .unwrap()
            .to_path_buf();
        let _ = fs::remove_dir_all(&root);
        let recorder = ThreadRecorder::new(root.clone());
        let path = recorder
            .create_thread(SessionMeta {
                schema_version: 1,
                thread_id: "thread-live-writer".to_string(),
                session_id: Some("session-live-writer".to_string()),
                created_at: "2026-07-17T00:00:00Z".to_string(),
                cwd: root.display().to_string(),
                source: "test".to_string(),
                model_provider: None,
                model: None,
                base_instructions: None,
                history_mode: None,
                forked_from_thread_id: None,
                parent_thread_id: None,
                originator: None,
            })
            .unwrap();

        run_rollout_compression_worker_with_age(&root, Duration::ZERO).unwrap();
        assert!(path.exists());
        assert!(!compressed_rollout_path(&path).unwrap().exists());

        recorder
            .append_item(
                &path,
                "2026-07-17T00:01:00Z".to_string(),
                value_event(
                    EventKind::UserMessage,
                    serde_json::json!({"content": "still writable"}),
                ),
            )
            .unwrap();
        assert_eq!(read_thread_lines(&path).unwrap().len(), 2);
        recorder.shutdown(&path).unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
