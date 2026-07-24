use super::*;

impl WorkerWorkspaceRpc {
    pub fn write_file(
        &self,
        requested_path: &str,
        contents: &str,
    ) -> Result<WorkspaceWriteResult, WorkerProtocolError> {
        self.write_file_with_expected(requested_path, contents, None)
    }

    pub fn create_dir(
        &self,
        requested_path: &str,
    ) -> Result<WorkspaceCreateDirResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let relative_path = normalize_workspace_dir_path(requested_path)?;
        if relative_path == "." || relative_path == ".git" || relative_path.starts_with(".git/") {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "refusing to create protected workspace path",
                serde_json::json!({ "path": relative_path }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let absolute_path = workspace_dir_absolute_path(&self.root, &relative_path);
        ensure_write_target_inside_workspace(&self.root, &absolute_path)?;
        std::fs::create_dir_all(&absolute_path).map_err(|error| {
            filesystem_error(
                "failed to create workspace directory",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        ensure_inside_workspace(&self.root, &absolute_path)?;
        if !absolute_path.is_dir() {
            return Err(filesystem_error(
                "workspace path is not a directory",
                serde_json::json!({ "path": relative_path }),
            ));
        }
        Ok(WorkspaceCreateDirResult {
            path: relative_path,
            kind: "dir".to_string(),
            created: true,
        })
    }

    pub fn write_file_with_expected(
        &self,
        requested_path: &str,
        contents: &str,
        expected_updated_at: Option<&str>,
    ) -> Result<WorkspaceWriteResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let relative_path = normalize_workspace_path(requested_path)?;
        let absolute_path = join_workspace_relative(&self.root, &relative_path);
        ensure_write_target_inside_workspace(&self.root, &absolute_path)?;
        let current_updated_at = workspace_updated_at(&absolute_path);
        if let Some(expected) = expected_updated_at {
            if current_updated_at.as_deref() != Some(expected) {
                return Err(WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "version conflict",
                    serde_json::json!({
                        "path": relative_path,
                        "updated_at": current_updated_at,
                    }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                ));
            }
        }
        if let Some(parent) = absolute_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                filesystem_error(
                    "failed to create workspace file parent directory",
                    serde_json::json!({
                        "path": relative_path,
                        "error": error.to_string(),
                    }),
                )
            })?;
            ensure_inside_workspace(&self.root, parent)?;
        }
        std::fs::write(&absolute_path, contents).map_err(|error| {
            filesystem_error(
                "failed to write workspace file",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        Ok(WorkspaceWriteResult {
            path: relative_path,
            bytes_written: contents.len() as u64,
            updated_at: workspace_updated_at(&absolute_path),
        })
    }

    pub fn write_file_with_base_revision(
        &self,
        requested_path: &str,
        contents: &str,
        base_revision: Option<&str>,
        create_only: bool,
    ) -> Result<WorkspaceWriteResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let relative_path = normalize_workspace_path(requested_path)?;
        let absolute_path = join_workspace_relative(&self.root, &relative_path);
        ensure_write_target_inside_workspace(&self.root, &absolute_path)?;
        if create_only && absolute_path.exists() {
            return Err(workspace_revision_conflict(
                &relative_path,
                Some("target already exists"),
                absolute_path.metadata().ok().as_ref(),
            ));
        }
        validate_file_base_revision(&relative_path, &absolute_path, base_revision)?;
        if let Some(parent) = absolute_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                filesystem_error(
                    "failed to create workspace file parent directory",
                    serde_json::json!({
                        "path": relative_path,
                        "error": error.to_string(),
                    }),
                )
            })?;
            ensure_inside_workspace(&self.root, parent)?;
        }
        std::fs::write(&absolute_path, contents).map_err(|error| {
            filesystem_error(
                "failed to write workspace file",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        Ok(WorkspaceWriteResult {
            path: relative_path,
            bytes_written: contents.len() as u64,
            updated_at: workspace_updated_at(&absolute_path),
        })
    }

    pub fn move_file_with_base_revision(
        &self,
        source_path: &str,
        target_path: &str,
        base_revision: &str,
    ) -> Result<WorkspaceMoveResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let source_path = normalize_workspace_path(source_path)?;
        let target_path = normalize_workspace_path(target_path)?;
        if source_path == target_path {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "source and target workspace paths are identical",
                serde_json::json!({ "path": source_path }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let source = join_workspace_relative(&self.root, &source_path);
        let target = join_workspace_relative(&self.root, &target_path);
        ensure_write_target_inside_workspace(&self.root, &source)?;
        ensure_write_target_inside_workspace(&self.root, &target)?;
        validate_file_base_revision(&source_path, &source, Some(base_revision))?;
        if target.exists() {
            return Err(workspace_revision_conflict(
                &target_path,
                Some("target already exists"),
                target.metadata().ok().as_ref(),
            ));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                filesystem_error(
                    "failed to create workspace move target directory",
                    serde_json::json!({
                        "path": target_path,
                        "error": error.to_string(),
                    }),
                )
            })?;
            ensure_inside_workspace(&self.root, parent)?;
        }
        std::fs::rename(&source, &target).map_err(|error| {
            filesystem_error(
                "failed to move workspace file",
                serde_json::json!({
                    "source_path": source_path,
                    "target_path": target_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        Ok(WorkspaceMoveResult {
            source_path,
            target_path,
            updated_at: workspace_updated_at(&target),
        })
    }

    pub fn delete_file_with_base_revision(
        &self,
        requested_path: &str,
        base_revision: &str,
    ) -> Result<WorkspaceDeleteResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let relative_path = normalize_workspace_path(requested_path)?;
        let absolute_path = join_workspace_relative(&self.root, &relative_path);
        ensure_write_target_inside_workspace(&self.root, &absolute_path)?;
        validate_file_base_revision(&relative_path, &absolute_path, Some(base_revision))?;
        std::fs::remove_file(&absolute_path).map_err(|error| {
            filesystem_error(
                "failed to delete workspace file",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        Ok(WorkspaceDeleteResult {
            path: relative_path,
            kind: "file".to_string(),
            deleted: true,
        })
    }

    pub fn delete_file(
        &self,
        requested_path: &str,
        recursive: bool,
    ) -> Result<WorkspaceDeleteResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let relative_path = normalize_workspace_dir_path(requested_path)?;
        if relative_path == "." || relative_path == ".git" || relative_path.starts_with(".git/") {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "refusing to delete protected workspace path",
                serde_json::json!({ "path": relative_path }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let absolute_path = workspace_dir_absolute_path(&self.root, &relative_path);
        if !absolute_path.exists() {
            return Err(filesystem_error(
                "workspace path does not exist",
                serde_json::json!({ "path": relative_path }),
            ));
        }
        ensure_inside_workspace(&self.root, &absolute_path)?;
        let metadata = std::fs::symlink_metadata(&absolute_path).map_err(|error| {
            filesystem_error(
                "failed to inspect workspace path",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        if metadata.is_dir() {
            if recursive {
                std::fs::remove_dir_all(&absolute_path).map_err(|error| {
                    filesystem_error(
                        "failed to delete workspace directory",
                        serde_json::json!({
                            "path": relative_path,
                            "error": error.to_string(),
                        }),
                    )
                })?;
            } else {
                std::fs::remove_dir(&absolute_path).map_err(|error| {
                    let message = if absolute_path
                        .read_dir()
                        .map(|mut items| items.next().is_some())
                        .unwrap_or(false)
                    {
                        "workspace directory is not empty"
                    } else {
                        "failed to delete workspace directory"
                    };
                    filesystem_error(
                        message,
                        serde_json::json!({
                            "path": relative_path,
                            "error": error.to_string(),
                        }),
                    )
                })?;
            }
            return Ok(WorkspaceDeleteResult {
                path: relative_path,
                kind: "dir".to_string(),
                deleted: true,
            });
        }
        if metadata.is_file() {
            std::fs::remove_file(&absolute_path).map_err(|error| {
                filesystem_error(
                    "failed to delete workspace file",
                    serde_json::json!({
                        "path": relative_path,
                        "error": error.to_string(),
                    }),
                )
            })?;
            return Ok(WorkspaceDeleteResult {
                path: relative_path,
                kind: "file".to_string(),
                deleted: true,
            });
        }
        Err(filesystem_error(
            "workspace path is not a regular file or directory",
            serde_json::json!({ "path": relative_path }),
        ))
    }
}

fn validate_file_base_revision(
    relative_path: &str,
    absolute_path: &Path,
    base_revision: Option<&str>,
) -> Result<(), WorkerProtocolError> {
    let Some(base_revision) = base_revision else {
        return Ok(());
    };
    let metadata = absolute_path.metadata().map_err(|error| {
        filesystem_error(
            "failed to read workspace file revision",
            serde_json::json!({
                "path": relative_path,
                "error": error.to_string(),
            }),
        )
    })?;
    let current_revision = file_metadata_revision(&metadata);
    if current_revision != base_revision {
        return Err(workspace_revision_conflict(
            relative_path,
            None,
            Some(&metadata),
        ));
    }
    Ok(())
}

fn workspace_revision_conflict(
    path: &str,
    reason: Option<&str>,
    metadata: Option<&std::fs::Metadata>,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "version conflict",
        serde_json::json!({
            "path": path,
            "reason": reason,
            "revision": metadata.map(file_metadata_revision),
            "updated_at": metadata.and_then(|value| workspace_updated_at_from_metadata(value)),
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn workspace_updated_at_from_metadata(metadata: &std::fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string())
}
