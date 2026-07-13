use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};

const DIRECTORY_PAGE_SIZE: usize = 200;
const COMPLETE_TEXT_FILE_LIMIT: u64 = 1024 * 1024;
const FILE_CHUNK_SIZE: usize = 256 * 1024;
const FILE_PROBE_SIZE: usize = 8 * 1024;

#[derive(Debug, Deserialize, Serialize)]
struct DirectoryCursor {
    offset: usize,
    revision: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct FileCursor {
    byte_offset: u64,
    line_start: usize,
    revision: String,
}

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

    pub fn list_dir_page(
        &self,
        requested_path: &str,
        cursor: Option<&str>,
        name_query: Option<&str>,
    ) -> Result<WorkspaceDirectoryPage, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let root = canonicalize_workspace_root(&self.root)?;
        let relative_path = normalize_workspace_dir_path(requested_path)?;
        let absolute_path = workspace_dir_absolute_path(&self.root, &relative_path);
        ensure_inside_workspace(&self.root, &absolute_path)?;
        if !absolute_path.is_dir() {
            return Err(workspace_query_error(
                "not_directory",
                "workspace path is not a directory",
                &relative_path,
                false,
            ));
        }
        let base = absolute_path.canonicalize().map_err(|error| {
            workspace_query_error(
                "root_unavailable",
                format!("failed to resolve workspace directory: {error}"),
                &relative_path,
                true,
            )
        })?;
        let mut legacy_entries = Vec::new();
        collect_workspace_dir_entries(&root, &base, &base, false, &mut legacy_entries)?;
        let mut entries = legacy_entries
            .into_iter()
            .map(|entry| {
                let absolute_path = root.join(entry.path.trim_end_matches('/'));
                WorkspaceDirectoryPageEntry {
                    path: entry.path,
                    kind: entry.kind,
                    size_bytes: entry.size_bytes,
                    updated_at: workspace_updated_at(&absolute_path),
                }
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            directory_kind_rank(&left.kind)
                .cmp(&directory_kind_rank(&right.kind))
                .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
                .then_with(|| left.path.cmp(&right.path))
        });
        if let Some(query) = name_query.map(str::trim).filter(|query| !query.is_empty()) {
            let query = query.to_lowercase();
            entries.retain(|entry| {
                workspace_entry_name(&entry.path)
                    .to_lowercase()
                    .contains(&query)
            });
        }
        let listing_revision = directory_listing_revision(&relative_path, &entries);
        let offset = match cursor {
            Some(raw) => {
                let cursor = serde_json::from_str::<DirectoryCursor>(raw).map_err(|_| {
                    workspace_query_error(
                        "invalid_path",
                        "invalid directory cursor",
                        &relative_path,
                        false,
                    )
                })?;
                if cursor.revision != listing_revision {
                    return Err(workspace_query_error(
                        "listing_changed",
                        "workspace directory changed while loading another page",
                        &relative_path,
                        true,
                    ));
                }
                cursor.offset
            }
            None => 0,
        };
        if offset > entries.len() {
            return Err(workspace_query_error(
                "listing_changed",
                "workspace directory cursor is beyond the current listing",
                &relative_path,
                true,
            ));
        }
        let end = (offset + DIRECTORY_PAGE_SIZE).min(entries.len());
        let page_entries = entries[offset..end].to_vec();
        let next_cursor =
            if end < entries.len() {
                Some(serde_json::to_string(&DirectoryCursor {
                offset: end,
                revision: listing_revision.clone(),
            }).map_err(|error| filesystem_error(
                "failed to encode workspace directory cursor",
                serde_json::json!({ "path": relative_path, "error": error.to_string() }),
            ))?)
            } else {
                None
            };
        Ok(WorkspaceDirectoryPage {
            path: relative_path,
            listing_revision,
            entries: page_entries,
            next_cursor,
        })
    }

    pub fn read_file_chunk(
        &self,
        requested_path: &str,
        cursor: Option<&str>,
    ) -> Result<WorkspaceFileChunk, WorkerProtocolError> {
        let resolved = self.resolve_path(requested_path)?;
        ensure_inside_workspace(&self.root, &resolved.absolute_path)?;
        let metadata = std::fs::metadata(&resolved.absolute_path).map_err(|error| {
            workspace_query_error(
                "not_found",
                format!("failed to inspect workspace file: {error}"),
                &resolved.relative_path,
                true,
            )
        })?;
        if !metadata.is_file() {
            return Err(workspace_query_error(
                "not_found",
                "workspace path is not a file",
                &resolved.relative_path,
                false,
            ));
        }
        let updated_at = workspace_updated_at(&resolved.absolute_path);
        let revision = file_metadata_revision(&metadata);
        let (byte_offset, line_start) = match cursor {
            Some(raw) => {
                let cursor = serde_json::from_str::<FileCursor>(raw).map_err(|_| {
                    workspace_query_error(
                        "invalid_path",
                        "invalid file cursor",
                        &resolved.relative_path,
                        false,
                    )
                })?;
                if cursor.revision != revision {
                    return Err(workspace_query_error(
                        "source_changed",
                        "workspace file changed while loading another chunk",
                        &resolved.relative_path,
                        true,
                    ));
                }
                (cursor.byte_offset, cursor.line_start.max(1))
            }
            None => (0, 1),
        };
        if byte_offset > metadata.len() {
            return Err(workspace_query_error(
                "source_changed",
                "workspace file cursor is beyond the current file",
                &resolved.relative_path,
                true,
            ));
        }
        let mut file = std::fs::File::open(&resolved.absolute_path).map_err(|error| {
            workspace_query_error(
                "io_error",
                format!("failed to open workspace file: {error}"),
                &resolved.relative_path,
                true,
            )
        })?;
        if byte_offset == 0 {
            let mut probe = vec![0_u8; FILE_PROBE_SIZE.min(metadata.len() as usize)];
            file.read_exact(&mut probe).map_err(|error| {
                workspace_query_error(
                    "io_error",
                    format!("failed to inspect workspace file content: {error}"),
                    &resolved.relative_path,
                    true,
                )
            })?;
            if probe.contains(&0) || valid_utf8_prefix_len(&probe).is_none() {
                return Ok(WorkspaceFileChunk {
                    path: resolved.relative_path,
                    content_type: "binary".to_string(),
                    revision,
                    size_bytes: metadata.len(),
                    updated_at,
                    content: None,
                    line_start: None,
                    line_end: None,
                    next_cursor: None,
                });
            }
        }
        let chunk_limit = if metadata.len() <= COMPLETE_TEXT_FILE_LIMIT {
            metadata.len().saturating_sub(byte_offset) as usize
        } else {
            FILE_CHUNK_SIZE.min(metadata.len().saturating_sub(byte_offset) as usize)
        };
        file.seek(SeekFrom::Start(byte_offset)).map_err(|error| {
            workspace_query_error(
                "io_error",
                format!("failed to seek workspace file: {error}"),
                &resolved.relative_path,
                true,
            )
        })?;
        let remaining = metadata.len().saturating_sub(byte_offset) as usize;
        let mut bytes = vec![0_u8; (chunk_limit + 4).min(remaining)];
        file.read_exact(&mut bytes).map_err(|error| {
            workspace_query_error(
                "io_error",
                format!("failed to read workspace file chunk: {error}"),
                &resolved.relative_path,
                true,
            )
        })?;
        let valid_prefix_len = valid_utf8_prefix_len(&bytes).ok_or_else(|| {
            workspace_query_error(
                "io_error",
                "workspace text file contains invalid UTF-8",
                &resolved.relative_path,
                false,
            )
        })?;
        let mut valid_len = valid_prefix_len.min(chunk_limit);
        while valid_len > 0 && std::str::from_utf8(&bytes[..valid_len]).is_err() {
            valid_len -= 1;
        }
        let content = String::from_utf8(bytes[..valid_len].to_vec()).map_err(|_| {
            workspace_query_error(
                "io_error",
                "workspace text file contains invalid UTF-8",
                &resolved.relative_path,
                false,
            )
        })?;
        let newline_count = content.bytes().filter(|byte| *byte == b'\n').count();
        let line_end = line_start + newline_count;
        let next_offset = byte_offset + valid_len as u64;
        let next_cursor = if next_offset < metadata.len() {
            Some(serde_json::to_string(&FileCursor {
                byte_offset: next_offset,
                line_start: if content.ends_with('\n') { line_end + 1 } else { line_end },
                revision: revision.clone(),
            }).map_err(|error| filesystem_error(
                "failed to encode workspace file cursor",
                serde_json::json!({ "path": resolved.relative_path, "error": error.to_string() }),
            ))?)
        } else {
            None
        };
        Ok(WorkspaceFileChunk {
            path: resolved.relative_path,
            content_type: "text".to_string(),
            revision,
            size_bytes: metadata.len(),
            updated_at,
            content: Some(content),
            line_start: Some(line_start),
            line_end: Some(line_end),
            next_cursor,
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

fn directory_kind_rank(kind: &str) -> u8 {
    if kind == "dir" {
        0
    } else {
        1
    }
}

fn workspace_entry_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

fn directory_listing_revision(path: &str, entries: &[WorkspaceDirectoryPageEntry]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    for entry in entries {
        hasher.update([0]);
        hasher.update(entry.kind.as_bytes());
        hasher.update([0]);
        hasher.update(entry.path.as_bytes());
        hasher.update([0]);
        hasher.update(entry.size_bytes.unwrap_or_default().to_le_bytes());
        hasher.update(entry.updated_at.as_deref().unwrap_or_default().as_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn file_metadata_revision(metadata: &std::fs::Metadata) -> String {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    format!("metadata:{}:{modified_nanos}", metadata.len())
}

fn valid_utf8_prefix_len(bytes: &[u8]) -> Option<usize> {
    match std::str::from_utf8(bytes) {
        Ok(_) => Some(bytes.len()),
        Err(error) if error.error_len().is_none() => Some(error.valid_up_to()),
        Err(_) => None,
    }
}

fn workspace_query_error(
    query_code: &str,
    message: impl Into<String>,
    path: &str,
    retryable: bool,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        serde_json::json!({ "query_code": query_code, "path": path }),
        retryable,
        WorkerProtocolErrorSource::RustCore,
    )
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
