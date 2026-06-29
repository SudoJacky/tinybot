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
