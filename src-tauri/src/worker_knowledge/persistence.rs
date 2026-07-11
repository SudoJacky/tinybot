use super::*;

pub(super) fn append_jsonl<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), WorkerProtocolError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            knowledge_filesystem_error(
                "failed to create knowledge index directory",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            knowledge_filesystem_error(
                "failed to open knowledge index",
                serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
            )
        })?;
    let line = serde_json::to_string(value).map_err(|error| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "failed to serialize knowledge record",
            serde_json::json!({ "error": error.to_string() }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })?;
    writeln!(file, "{line}").map_err(|error| {
        knowledge_filesystem_error(
            "failed to write knowledge index",
            serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
        )
    })
}

pub(super) fn read_jsonl<T: for<'de> Deserialize<'de>>(
    path: &Path,
) -> Result<Vec<T>, WorkerProtocolError> {
    read_jsonl_strict(path).map_err(knowledge_storage_error)
}

pub(super) fn write_jsonl<T: Serialize>(
    path: &Path,
    records: &[T],
) -> Result<(), WorkerProtocolError> {
    write_jsonl_atomic(path, records, AtomicWriteOptions::default())
        .map_err(knowledge_storage_error)
}

#[derive(Debug)]
pub(super) struct KnowledgeJsonlBackup {
    target: PathBuf,
    backup: PathBuf,
    existed: bool,
}

pub(super) fn run_knowledge_jsonl_update<F>(
    paths: &[&Path],
    update: F,
) -> Result<(), WorkerProtocolError>
where
    F: FnOnce() -> Result<(), WorkerProtocolError>,
{
    let backups = prepare_knowledge_jsonl_backups(paths)?;
    match update() {
        Ok(()) => {
            cleanup_knowledge_jsonl_backups(&backups);
            Ok(())
        }
        Err(error) => {
            let recovery_error = restore_knowledge_jsonl_backups(&backups).err();
            Err(knowledge_partial_update_error(error, recovery_error))
        }
    }
}

pub(super) fn prepare_knowledge_jsonl_backups(
    paths: &[&Path],
) -> Result<Vec<KnowledgeJsonlBackup>, WorkerProtocolError> {
    let mut backups = Vec::new();
    for path in paths {
        let backup = backup_path_for(path, ".bak").map_err(knowledge_storage_error)?;
        let existed = path.exists();
        if existed {
            fs::copy(path, &backup).map_err(|error| {
                knowledge_filesystem_error(
                    "failed to backup knowledge index before multi-file update",
                    serde_json::json!({
                        "path": path.display().to_string(),
                        "backup": backup.display().to_string(),
                        "error": error.to_string()
                    }),
                )
            })?;
        }
        backups.push(KnowledgeJsonlBackup {
            target: path.to_path_buf(),
            backup,
            existed,
        });
    }
    Ok(backups)
}

pub(super) fn cleanup_knowledge_jsonl_backups(backups: &[KnowledgeJsonlBackup]) {
    for backup in backups {
        if backup.existed {
            let _ = fs::remove_file(&backup.backup);
        }
    }
}

pub(super) fn restore_knowledge_jsonl_backups(
    backups: &[KnowledgeJsonlBackup],
) -> Result<(), String> {
    let mut errors = Vec::new();
    for backup in backups.iter().rev() {
        let result = if backup.existed {
            fs::copy(&backup.backup, &backup.target).map(|_| ())
        } else if backup.target.exists() {
            fs::remove_file(&backup.target)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            errors.push(format!("{}: {}", backup.target.display(), error));
        }
        if backup.existed {
            let _ = fs::remove_file(&backup.backup);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub(super) fn knowledge_partial_update_error(
    error: WorkerProtocolError,
    recovery_error: Option<String>,
) -> WorkerProtocolError {
    let recovery = recovery_error
        .map(|error| serde_json::json!({ "status": "failed", "error": error }))
        .unwrap_or_else(|| serde_json::json!({ "status": "restored" }));
    WorkerProtocolError::new(
        error.code,
        "knowledge multi-file update failed",
        serde_json::json!({
            "error": error.message,
            "details": error.details,
            "recovery": recovery
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn knowledge_storage_error(error: WorkerStorageError) -> WorkerProtocolError {
    let code = match error {
        WorkerStorageError::Io { .. } => WorkerProtocolErrorCode::WorkerError,
        WorkerStorageError::SerializeJson(_)
        | WorkerStorageError::ParseJson { .. }
        | WorkerStorageError::ParseJsonLine { .. } => WorkerProtocolErrorCode::InvalidProtocol,
    };
    WorkerProtocolError::new(
        code,
        "knowledge storage error",
        serde_json::json!({ "error": error.to_string() }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn is_text_like_knowledge_file_type(file_type: &str) -> bool {
    matches!(file_type, "txt" | "md" | "json" | "csv")
}
