use super::*;
use std::collections::HashSet;

const MAX_PATCH_TARGET_BYTES: u64 = 64 * 1024 * 1024;

pub(super) fn apply_patch_operations(
    root: &Path,
    operations: Vec<PatchOperation>,
    file_system: &dyn PatchFileSystem,
) -> Result<WorkspacePatchApplyResult, PatchFailure> {
    let prepared =
        prepare_patch_operations(root, operations).map_err(PatchFailure::before_commit)?;
    let mut committed = Vec::with_capacity(prepared.len());
    for operation in &prepared {
        if let Err((error, operation_change, exact)) =
            commit_patch_operation(root, operation, file_system)
        {
            if let Some(operation_change) = operation_change {
                committed.push(operation_change);
            }
            return Err(PatchFailure {
                error,
                committed,
                exact,
            });
        }
        committed.push(operation.success_change());
    }
    let hunks_applied = committed.iter().map(|change| change.hunks.len()).sum();
    Ok(WorkspacePatchApplyResult {
        files_changed: committed.len(),
        hunks_applied,
        changed_files: committed,
    })
}

fn prepare_patch_operations(
    root: &Path,
    operations: Vec<PatchOperation>,
) -> Result<Vec<PreparedPatchOperation>, WorkerProtocolError> {
    let mut seen_paths = HashSet::new();
    let mut prepared = Vec::with_capacity(operations.len());
    for operation in operations {
        let relative_path = normalize_workspace_path(operation.path())?;
        let absolute_path = join_workspace_relative(root, &relative_path);
        register_patch_path(&mut seen_paths, &absolute_path, &relative_path)?;
        match operation {
            PatchOperation::Add {
                contents,
                added_lines,
                ..
            } => {
                ensure_write_target_inside_workspace(root, &absolute_path)?;
                if workspace_path_exists(&absolute_path)? {
                    return Err(patch_error(
                        "add patch target already exists",
                        serde_json::json!({ "path": relative_path }),
                    ));
                }
                prepared.push(PreparedPatchOperation::Add {
                    relative_path,
                    absolute_path,
                    contents,
                    added_lines,
                });
            }
            PatchOperation::Update {
                move_path, chunks, ..
            } => {
                ensure_existing_patch_file(root, &absolute_path, &relative_path, "update")?;
                let source = read_patch_file(&absolute_path, &relative_path)?;
                let (contents, delta) = apply_update_chunks(&source, &chunks, &relative_path)?;
                let (delta, delta_truncated) = bounded_patch_delta(delta);
                let source_permissions = std::fs::metadata(&absolute_path)
                    .map_err(|error| {
                        filesystem_error(
                            "failed to inspect workspace patch target permissions",
                            serde_json::json!({
                                "path": relative_path,
                                "error": error.to_string(),
                            }),
                        )
                    })?
                    .permissions();
                let (move_relative_path, move_absolute_path) = match move_path {
                    Some(move_path) => {
                        let move_relative_path = normalize_workspace_path(&move_path)?;
                        let move_absolute_path = join_workspace_relative(root, &move_relative_path);
                        register_patch_path(
                            &mut seen_paths,
                            &move_absolute_path,
                            &move_relative_path,
                        )?;
                        ensure_write_target_inside_workspace(root, &move_absolute_path)?;
                        if workspace_path_exists(&move_absolute_path)? {
                            return Err(patch_error(
                                "move patch target already exists",
                                serde_json::json!({ "path": move_relative_path }),
                            ));
                        }
                        (Some(move_relative_path), Some(move_absolute_path))
                    }
                    None => (None, None),
                };
                prepared.push(PreparedPatchOperation::Update {
                    relative_path,
                    absolute_path,
                    move_relative_path,
                    move_absolute_path,
                    source,
                    contents,
                    chunks,
                    delta,
                    delta_truncated,
                    source_permissions,
                });
            }
            PatchOperation::Delete { .. } => {
                ensure_existing_patch_file(root, &absolute_path, &relative_path, "delete")?;
                let source = read_patch_file(&absolute_path, &relative_path)?;
                let source_revision = patch_file_revision(&absolute_path, &relative_path)?;
                prepared.push(PreparedPatchOperation::Delete {
                    relative_path,
                    absolute_path,
                    source,
                    source_revision,
                });
            }
        }
    }
    Ok(prepared)
}

type CommitFailure = (WorkerProtocolError, Option<WorkspacePatchFileChange>, bool);

fn commit_patch_operation(
    root: &Path,
    operation: &PreparedPatchOperation,
    file_system: &dyn PatchFileSystem,
) -> Result<(), CommitFailure> {
    match operation {
        PreparedPatchOperation::Add {
            relative_path,
            absolute_path,
            contents,
            added_lines,
        } => {
            ensure_write_target_inside_workspace(root, absolute_path).map_err(no_commit)?;
            create_patch_parent(root, absolute_path, relative_path, file_system)?;
            if workspace_path_exists(absolute_path).map_err(no_commit)? {
                return Err(no_commit(patch_error(
                    "add patch target already exists",
                    serde_json::json!({ "path": relative_path }),
                )));
            }
            file_system
                .write_text(absolute_path, contents, relative_path, false, None)
                .map_err(|failure| {
                    let change = failure
                        .textual_change_committed
                        .then(|| added_file_change(relative_path, contents, *added_lines));
                    (failure.error, change, true)
                })
        }
        PreparedPatchOperation::Update {
            relative_path,
            absolute_path,
            move_relative_path,
            move_absolute_path,
            source,
            contents,
            source_permissions,
            ..
        } => {
            ensure_existing_patch_file(root, absolute_path, relative_path, "update")
                .map_err(no_commit)?;
            ensure_patch_source_unchanged(absolute_path, relative_path, source)
                .map_err(no_commit)?;
            let Some(move_absolute_path) = move_absolute_path else {
                return file_system
                    .write_text(absolute_path, contents, relative_path, true, None)
                    .map_err(|failure| {
                        let change = failure
                            .textual_change_committed
                            .then(|| operation.success_change());
                        (failure.error, change, true)
                    });
            };
            let move_relative_path = move_relative_path
                .as_deref()
                .expect("prepared move destination must include a relative path");
            ensure_write_target_inside_workspace(root, move_absolute_path).map_err(no_commit)?;
            create_patch_parent(root, move_absolute_path, move_relative_path, file_system)?;
            if workspace_path_exists(move_absolute_path).map_err(no_commit)? {
                return Err(no_commit(patch_error(
                    "move patch target already exists",
                    serde_json::json!({ "path": move_relative_path }),
                )));
            }
            file_system
                .write_text(
                    move_absolute_path,
                    contents,
                    move_relative_path,
                    false,
                    Some(source_permissions.clone()),
                )
                .map_err(|failure| {
                    let change = failure.textual_change_committed.then(|| {
                        added_file_change(move_relative_path, contents, contents.lines().count())
                    });
                    (failure.error, change, true)
                })?;
            let destination_change = || {
                Some(added_file_change(
                    move_relative_path,
                    contents,
                    contents.lines().count(),
                ))
            };
            if let Err(error) = ensure_patch_source_unchanged(absolute_path, relative_path, source)
            {
                return Err((error, destination_change(), true));
            }
            file_system
                .remove_file(absolute_path, relative_path)
                .map_err(|failure| (failure.error, destination_change(), true))
        }
        PreparedPatchOperation::Delete {
            relative_path,
            absolute_path,
            source_revision,
            ..
        } => {
            ensure_existing_patch_file(root, absolute_path, relative_path, "delete")
                .map_err(no_commit)?;
            let current_revision =
                patch_file_revision(absolute_path, relative_path).map_err(no_commit)?;
            if &current_revision != source_revision {
                return Err(no_commit(patch_error(
                    "delete patch precondition no longer matches file revision",
                    serde_json::json!({
                        "path": relative_path,
                        "expected_revision": source_revision,
                        "actual_revision": current_revision,
                    }),
                )));
            }
            file_system
                .remove_file(absolute_path, relative_path)
                .map_err(|failure| (failure.error, None, true))
        }
    }
}

fn create_patch_parent(
    root: &Path,
    absolute_path: &Path,
    relative_path: &str,
    file_system: &dyn PatchFileSystem,
) -> Result<(), CommitFailure> {
    file_system
        .create_parent(absolute_path, relative_path)
        .map_err(|failure| (failure.error, None, true))?;
    if let Some(parent) = absolute_path.parent() {
        ensure_inside_workspace(root, parent).map_err(no_commit)?;
    }
    Ok(())
}

fn ensure_patch_source_unchanged(
    absolute_path: &Path,
    relative_path: &str,
    source: &str,
) -> Result<(), WorkerProtocolError> {
    let current = read_patch_file(absolute_path, relative_path)?;
    if current != source {
        return Err(patch_error(
            "update patch precondition no longer matches file contents",
            serde_json::json!({ "path": relative_path }),
        ));
    }
    Ok(())
}

fn register_patch_path(
    seen_paths: &mut HashSet<String>,
    absolute_path: &Path,
    relative_path: &str,
) -> Result<(), WorkerProtocolError> {
    let identity = patch_path_identity(absolute_path, relative_path)?;
    if seen_paths.insert(identity) {
        return Ok(());
    }
    Err(patch_error(
        "patch may not modify the same file more than once",
        serde_json::json!({ "path": relative_path }),
    ))
}

fn patch_path_identity(
    absolute_path: &Path,
    relative_path: &str,
) -> Result<String, WorkerProtocolError> {
    let identity_path = if workspace_path_exists(absolute_path)? {
        canonical_patch_identity_path(absolute_path, relative_path)?
    } else {
        let existing_ancestor = absolute_path
            .ancestors()
            .find(|candidate| candidate.exists())
            .ok_or_else(|| {
                filesystem_error(
                    "failed to locate workspace patch target ancestor",
                    serde_json::json!({ "path": relative_path }),
                )
            })?;
        let unresolved_suffix = absolute_path
            .strip_prefix(existing_ancestor)
            .map_err(|error| {
                filesystem_error(
                    "failed to resolve workspace patch target identity suffix",
                    serde_json::json!({
                        "path": relative_path,
                        "error": error.to_string(),
                    }),
                )
            })?;
        canonical_patch_identity_path(existing_ancestor, relative_path)?.join(unresolved_suffix)
    };
    let identity = identity_path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        Ok(identity.to_lowercase())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(identity)
    }
}

fn canonical_patch_identity_path(
    path: &Path,
    relative_path: &str,
) -> Result<PathBuf, WorkerProtocolError> {
    path.canonicalize().map_err(|error| {
        filesystem_error(
            "failed to resolve workspace patch target identity",
            serde_json::json!({
                "path": relative_path,
                "error": error.to_string(),
            }),
        )
    })
}

fn ensure_existing_patch_file(
    root: &Path,
    absolute_path: &Path,
    relative_path: &str,
    operation: &str,
) -> Result<(), WorkerProtocolError> {
    if !workspace_path_exists(absolute_path)? {
        return Err(patch_error(
            format!("{operation} patch target does not exist"),
            serde_json::json!({ "path": relative_path }),
        ));
    }
    ensure_inside_workspace(root, absolute_path)?;
    let metadata = std::fs::symlink_metadata(absolute_path).map_err(|error| {
        filesystem_error(
            "failed to inspect workspace patch target",
            serde_json::json!({
                "path": relative_path,
                "error": error.to_string(),
            }),
        )
    })?;
    if !metadata.is_file() {
        return Err(patch_error(
            format!("{operation} patch target is not a regular file"),
            serde_json::json!({ "path": relative_path }),
        ));
    }
    Ok(())
}

fn read_patch_file(path: &Path, relative_path: &str) -> Result<String, WorkerProtocolError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        filesystem_error(
            "failed to inspect workspace patch target size",
            serde_json::json!({
                "path": relative_path,
                "error": error.to_string(),
            }),
        )
    })?;
    if metadata.len() > MAX_PATCH_TARGET_BYTES {
        return Err(patch_error(
            format!("patch target must not exceed {MAX_PATCH_TARGET_BYTES} bytes"),
            serde_json::json!({ "path": relative_path, "bytes": metadata.len() }),
        ));
    }
    std::fs::read_to_string(path).map_err(|error| {
        filesystem_error(
            "failed to read workspace patch target",
            serde_json::json!({
                "path": relative_path,
                "error": error.to_string(),
            }),
        )
    })
}

fn patch_file_revision(path: &Path, relative_path: &str) -> Result<String, WorkerProtocolError> {
    path.metadata()
        .map(|metadata| file_metadata_revision(&metadata))
        .map_err(|error| {
            filesystem_error(
                "failed to read workspace patch target revision",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            )
        })
}

fn workspace_path_exists(path: &Path) -> Result<bool, WorkerProtocolError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(filesystem_error(
            "failed to inspect workspace patch target",
            serde_json::json!({
                "path": path.display().to_string(),
                "error": error.to_string(),
            }),
        )),
    }
}

fn no_commit(error: WorkerProtocolError) -> CommitFailure {
    (error, None, true)
}
