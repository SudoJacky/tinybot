use super::*;

impl WorkerWorkspaceRpc {
    pub fn read_file(
        &self,
        requested_path: &str,
    ) -> Result<WorkspaceFileContent, WorkerProtocolError> {
        let resolved = self.resolve_path(requested_path)?;
        ensure_inside_workspace(&self.root, &resolved.absolute_path)?;
        let contents = std::fs::read_to_string(&resolved.absolute_path).map_err(|error| {
            filesystem_error(
                "failed to read workspace file",
                serde_json::json!({
                    "path": resolved.relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        Ok(WorkspaceFileContent {
            path: resolved.relative_path,
            contents,
            updated_at: workspace_updated_at(&resolved.absolute_path),
        })
    }

    pub fn read_file_with_options(
        &self,
        requested_path: &str,
        options: WorkspaceReadOptions,
    ) -> Result<WorkspaceReadFileResult, WorkerProtocolError> {
        let file = self.read_file(requested_path)?;
        match options.format {
            WorkspaceReadFormat::Raw => Ok(WorkspaceReadFileResult {
                path: file.path,
                contents: file.contents.clone(),
                content: file.contents,
                updated_at: file.updated_at,
                content_type: "text".to_string(),
                line_start: None,
                line_end: None,
                line_total: None,
                truncated: false,
            }),
            WorkspaceReadFormat::NumberedLines => {
                let lines: Vec<&str> = file.contents.lines().collect();
                if lines.is_empty() {
                    return Ok(WorkspaceReadFileResult {
                        path: file.path,
                        contents: file.contents,
                        content: format!("(Empty file: {requested_path})"),
                        updated_at: file.updated_at,
                        content_type: "text".to_string(),
                        line_start: Some(1),
                        line_end: Some(0),
                        line_total: Some(0),
                        truncated: false,
                    });
                }
                let total = lines.len();
                let offset = options.offset.unwrap_or(1).max(1);
                if offset > total {
                    return Err(filesystem_error(
                        "workspace read offset is beyond end of file",
                        serde_json::json!({
                            "path": file.path,
                            "offset": offset,
                            "line_total": total,
                        }),
                    ));
                }
                let limit = options.limit.unwrap_or(DEFAULT_READ_LIMIT).max(1);
                let start = offset - 1;
                let end_exclusive = (start + limit).min(total);
                let line_end = end_exclusive;
                let mut content = lines[start..end_exclusive]
                    .iter()
                    .enumerate()
                    .map(|(index, line)| format!("{}| {}", start + index + 1, line))
                    .collect::<Vec<_>>()
                    .join("\n");
                let truncated = line_end < total;
                if truncated {
                    content.push_str(&format!(
                        "\n\n(Showing lines {offset}-{line_end} of {total}. Use offset={} to continue.)",
                        line_end + 1
                    ));
                } else {
                    content.push_str(&format!("\n\n(End of file - {total} lines total)"));
                }
                Ok(WorkspaceReadFileResult {
                    path: file.path,
                    contents: file.contents,
                    content,
                    updated_at: file.updated_at,
                    content_type: "text".to_string(),
                    line_start: Some(offset),
                    line_end: Some(line_end),
                    line_total: Some(total),
                    truncated,
                })
            }
        }
    }

    pub fn list_files(&self) -> Result<Vec<WorkspaceFileEntry>, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let root = canonicalize_workspace_root(&self.root)?;
        let mut entries = Vec::new();
        collect_workspace_files(&root, &root, &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    pub fn list_dir(
        &self,
        requested_path: &str,
        recursive: bool,
        max_entries: Option<usize>,
    ) -> Result<WorkspaceDirectoryListing, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let root = canonicalize_workspace_root(&self.root)?;
        let relative_path = normalize_workspace_dir_path(requested_path)?;
        let absolute_path = workspace_dir_absolute_path(&self.root, &relative_path);
        ensure_inside_workspace(&self.root, &absolute_path)?;
        if !absolute_path.is_dir() {
            return Err(filesystem_error(
                "workspace path is not a directory",
                serde_json::json!({ "path": relative_path }),
            ));
        }
        let base = absolute_path.canonicalize().map_err(|error| {
            filesystem_error(
                "failed to resolve workspace directory",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        let mut entries = Vec::new();
        collect_workspace_dir_entries(&root, &base, &base, recursive, &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let total_entries = entries.len();
        let cap = max_entries.unwrap_or(200).max(1);
        let truncated = total_entries > cap;
        entries.truncate(cap);
        Ok(WorkspaceDirectoryListing {
            path: relative_path,
            entries,
            total_entries,
            truncated,
        })
    }

    pub fn read_bootstrap_files(
        &self,
        files: &[String],
    ) -> Result<WorkspaceBootstrapFiles, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let mut found = Vec::new();
        let mut missing = Vec::new();
        for requested in files {
            if !BOOTSTRAP_FILES.contains(&requested.as_str()) {
                return Err(WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "bootstrap file is not allowlisted",
                    serde_json::json!({ "path": requested }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                ));
            }
            match self.read_file(requested) {
                Ok(file) => found.push(file),
                Err(_) => missing.push(requested.clone()),
            }
        }
        Ok(WorkspaceBootstrapFiles {
            files: found,
            missing,
        })
    }
}
fn collect_workspace_files(
    root: &Path,
    current: &Path,
    entries: &mut Vec<WorkspaceFileEntry>,
) -> Result<(), WorkerProtocolError> {
    for entry in std::fs::read_dir(current).map_err(|error| {
        filesystem_error(
            "failed to list workspace directory",
            serde_json::json!({
                "path": current.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })? {
        let entry = entry.map_err(|error| {
            filesystem_error(
                "failed to inspect workspace directory entry",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let path = entry.path();
        ensure_inside_canonical_workspace(root, &path)?;
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            filesystem_error(
                "failed to read workspace file metadata",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })?;
        if metadata.file_type().is_symlink()
            || ignored_workspace_path(root, &path)
            || hidden_workspace_path(root, &path)
        {
            continue;
        }
        if metadata.is_dir() {
            collect_workspace_files(root, &path, entries)?;
        } else if metadata.is_file() {
            entries.push(WorkspaceFileEntry {
                path: workspace_relative_path(root, &path)?,
                size_bytes: metadata.len(),
                updated_at: workspace_updated_at(&path),
            });
        }
    }
    Ok(())
}

pub(super) fn workspace_updated_at(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis().to_string())
}

fn collect_workspace_dir_entries(
    root: &Path,
    base: &Path,
    current: &Path,
    recursive: bool,
    entries: &mut Vec<WorkspaceDirectoryEntry>,
) -> Result<(), WorkerProtocolError> {
    for entry in std::fs::read_dir(current).map_err(|error| {
        filesystem_error(
            "failed to list workspace directory",
            serde_json::json!({
                "path": current.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })? {
        let entry = entry.map_err(|error| {
            filesystem_error(
                "failed to inspect workspace directory entry",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let path = entry.path();
        ensure_inside_canonical_workspace(root, &path)?;
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            filesystem_error(
                "failed to read workspace path metadata",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })?;
        if metadata.file_type().is_symlink() || ignored_workspace_path(base, &path) {
            continue;
        }
        if metadata.is_dir() {
            entries.push(WorkspaceDirectoryEntry {
                path: format!("{}/", workspace_relative_path(root, &path)?),
                kind: "dir".to_string(),
                size_bytes: None,
            });
            if recursive {
                collect_workspace_dir_entries(root, base, &path, recursive, entries)?;
            }
        } else if metadata.is_file() {
            entries.push(WorkspaceDirectoryEntry {
                path: workspace_relative_path(root, &path)?,
                kind: "file".to_string(),
                size_bytes: Some(metadata.len()),
            });
        }
    }
    Ok(())
}

fn ignored_workspace_path(base: &Path, path: &Path) -> bool {
    path.strip_prefix(base)
        .ok()
        .map(|relative| {
            relative.components().any(|component| {
                let name = component.as_os_str().to_string_lossy();
                IGNORED_DIRS.iter().any(|ignored| *ignored == name)
            })
        })
        .unwrap_or(false)
}

fn hidden_workspace_path(base: &Path, path: &Path) -> bool {
    path.strip_prefix(base)
        .ok()
        .map(|relative| {
            relative.components().any(|component| {
                let name = component.as_os_str().to_string_lossy();
                name.starts_with('.') && name.len() > 1
            })
        })
        .unwrap_or(false)
}
