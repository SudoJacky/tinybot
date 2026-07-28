use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

const COMPARE_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ThreadStorageMigrationReport {
    pub(crate) moved_file_count: usize,
    pub(crate) deduplicated_file_count: usize,
    pub(crate) removed_legacy_index: bool,
}

pub(crate) fn migrate_legacy_thread_storage(
    workspace_root: &Path,
    data_root: &Path,
) -> Result<ThreadStorageMigrationReport, WorkerProtocolError> {
    let workspace_root = absolute_root(workspace_root, data_root)?;
    let data_root = absolute_root(data_root, workspace_root.as_path())?;
    let legacy_root = workspace_root.join(".tinybot");
    if roots_match(&legacy_root, &data_root)? {
        return Ok(ThreadStorageMigrationReport::default());
    }

    let roots = [
        (legacy_root.join("threads"), data_root.join("threads")),
        (
            legacy_root.join("archived_threads"),
            data_root.join("archived_threads"),
        ),
    ];
    for (source, target) in &roots {
        preflight_merge(source, target)?;
    }

    let mut report = ThreadStorageMigrationReport::default();
    for (source, target) in &roots {
        merge_tree(source, target, &mut report)?;
    }
    report.removed_legacy_index = remove_legacy_state(&legacy_root)?;
    remove_if_empty(&legacy_root.join("state"))?;
    remove_if_empty(&legacy_root)?;

    if report != ThreadStorageMigrationReport::default() {
        eprintln!(
            "thread_storage_migrated workspace={} data_root={} moved_files={} deduplicated_files={} removed_legacy_index={}",
            workspace_root.display(),
            data_root.display(),
            report.moved_file_count,
            report.deduplicated_file_count,
            report.removed_legacy_index
        );
    }
    Ok(report)
}

fn preflight_merge(source: &Path, target: &Path) -> Result<(), WorkerProtocolError> {
    let source_metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error("inspect_source", source, target, error)),
    };
    if !source_metadata.is_dir() {
        return Err(migration_error(
            "validate_source",
            source,
            target,
            "legacy thread storage source must be a directory",
        ));
    }
    match fs::symlink_metadata(target) {
        Ok(target_metadata) => {
            if !target_metadata.is_dir() {
                return Err(migration_conflict(source, target));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("inspect_target", source, target, error)),
    }

    for entry in
        fs::read_dir(source).map_err(|error| io_error("read_source", source, target, error))?
    {
        let entry = entry.map_err(|error| io_error("read_source_entry", source, target, error))?;
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            io_error("inspect_source_entry", &source_child, &target_child, error)
        })?;
        if file_type.is_symlink() {
            return Err(migration_error(
                "validate_source_entry",
                &source_child,
                &target_child,
                "legacy thread storage must not contain symbolic links",
            ));
        }
        if file_type.is_dir() {
            preflight_merge(&source_child, &target_child)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(migration_error(
                "validate_source_entry",
                &source_child,
                &target_child,
                "legacy thread storage contains an unsupported entry",
            ));
        }
        let target_metadata = match fs::symlink_metadata(&target_child) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(io_error(
                    "inspect_target_entry",
                    &source_child,
                    &target_child,
                    error,
                ))
            }
        };
        if !target_metadata.is_file() || !files_equal(&source_child, &target_child)? {
            return Err(migration_conflict(&source_child, &target_child));
        }
    }
    Ok(())
}

fn merge_tree(
    source: &Path,
    target: &Path,
    report: &mut ThreadStorageMigrationReport,
) -> Result<(), WorkerProtocolError> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|error| io_error("create_target", source, target, error))?;
    let entries = fs::read_dir(source)
        .map_err(|error| io_error("read_source", source, target, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error("read_source_entry", source, target, error))?;
    for entry in entries {
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            io_error("inspect_source_entry", &source_child, &target_child, error)
        })?;
        if file_type.is_dir() {
            merge_tree(&source_child, &target_child, report)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(migration_error(
                "move_source_entry",
                &source_child,
                &target_child,
                "legacy thread storage contains an unsupported entry",
            ));
        }
        if target_child.exists() {
            if !files_equal(&source_child, &target_child)? {
                return Err(migration_conflict(&source_child, &target_child));
            }
            fs::remove_file(&source_child).map_err(|error| {
                io_error("remove_duplicate", &source_child, &target_child, error)
            })?;
            report.deduplicated_file_count += 1;
        } else {
            move_file(&source_child, &target_child)?;
            report.moved_file_count += 1;
        }
    }
    remove_if_empty(source)
}

fn absolute_root(path: &Path, other_root: &Path) -> Result<PathBuf, WorkerProtocolError> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    std::env::current_dir()
        .map(|current_dir| current_dir.join(path))
        .map_err(|error| io_error("resolve_root", path, other_root, error))
}

fn roots_match(left: &Path, right: &Path) -> Result<bool, WorkerProtocolError> {
    if left == right {
        return Ok(true);
    }
    let left_metadata = match fs::symlink_metadata(left) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error("inspect_root", left, right, error)),
    };
    let right_metadata = match fs::symlink_metadata(right) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error("inspect_root", left, right, error)),
    };
    if !left_metadata.is_dir() || !right_metadata.is_dir() {
        return Ok(false);
    }
    let canonical_left =
        fs::canonicalize(left).map_err(|error| io_error("resolve_root", left, right, error))?;
    let canonical_right =
        fs::canonicalize(right).map_err(|error| io_error("resolve_root", right, left, error))?;
    Ok(canonical_left == canonical_right)
}

fn move_file(source: &Path, target: &Path) -> Result<(), WorkerProtocolError> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_file_without_overwrite(source, target)?;
            fs::remove_file(source)
                .map_err(|error| io_error("remove_copied_source", source, target, error))
        }
        Err(error) => Err(io_error("move_file", source, target, error)),
    }
}

fn copy_file_without_overwrite(source: &Path, target: &Path) -> Result<(), WorkerProtocolError> {
    let mut source_file =
        fs::File::open(source).map_err(|error| io_error("copy_file", source, target, error))?;
    let mut target_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| io_error("copy_file", source, target, error))?;
    let copy_result = (|| -> Result<(), std::io::Error> {
        std::io::copy(&mut source_file, &mut target_file)?;
        target_file.flush()?;
        target_file.sync_all()
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_file(target);
        return Err(io_error("copy_file", source, target, error));
    }
    if !files_equal(source, target)? {
        let _ = fs::remove_file(target);
        return Err(migration_error(
            "verify_copy",
            source,
            target,
            "copied thread file does not match its source",
        ));
    }
    Ok(())
}

fn remove_legacy_state(legacy_root: &Path) -> Result<bool, WorkerProtocolError> {
    let state_root = legacy_root.join("state");
    let mut removed_index = false;
    for name in [
        "state.sqlite",
        "state.sqlite-wal",
        "state.sqlite-shm",
        "rollout-compression.lock",
    ] {
        let path = state_root.join(name);
        match fs::remove_file(&path) {
            Ok(()) => removed_index |= name == "state.sqlite",
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error("remove_legacy_state", &path, &state_root, error)),
        }
    }
    Ok(removed_index)
}

fn remove_if_empty(path: &Path) -> Result<(), WorkerProtocolError> {
    let mut entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error("read_for_cleanup", path, path, error)),
    };
    if entries.next().is_none() {
        fs::remove_dir(path)
            .map_err(|error| io_error("remove_empty_directory", path, path, error))?;
    }
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, WorkerProtocolError> {
    let left_metadata =
        fs::metadata(left).map_err(|error| io_error("compare_files", left, right, error))?;
    let right_metadata =
        fs::metadata(right).map_err(|error| io_error("compare_files", left, right, error))?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    let mut left_reader = BufReader::new(
        fs::File::open(left).map_err(|error| io_error("compare_files", left, right, error))?,
    );
    let mut right_reader = BufReader::new(
        fs::File::open(right).map_err(|error| io_error("compare_files", left, right, error))?,
    );
    let mut left_buffer = vec![0; COMPARE_BUFFER_BYTES];
    let mut right_buffer = vec![0; COMPARE_BUFFER_BYTES];
    loop {
        let left_read = left_reader
            .read(&mut left_buffer)
            .map_err(|error| io_error("compare_files", left, right, error))?;
        let right_read = right_reader
            .read(&mut right_buffer)
            .map_err(|error| io_error("compare_files", left, right, error))?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn migration_conflict(source: &Path, target: &Path) -> WorkerProtocolError {
    migration_error(
        "preflight",
        source,
        target,
        "thread storage migration conflict: target exists with different content",
    )
}

fn io_error(
    operation: &str,
    source: &Path,
    target: &Path,
    error: std::io::Error,
) -> WorkerProtocolError {
    migration_error(operation, source, target, &error.to_string())
}

fn migration_error(
    operation: &str,
    source: &Path,
    target: &Path,
    message: &str,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread storage migration failed during {operation}: {message}"),
        serde_json::json!({
            "operation": operation,
            "source": source.display().to_string(),
            "target": target.display().to_string(),
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
