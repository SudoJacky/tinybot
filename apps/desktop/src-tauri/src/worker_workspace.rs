use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const BOOTSTRAP_FILES: &[&str] = &["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"];
const DEFAULT_READ_LIMIT: usize = 2000;
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
];

#[derive(Clone, Debug)]
pub struct WorkerWorkspaceRpc {
    root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerWorkspaceRpc {
    pub fn new(root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self { root, policy }
    }

    pub fn resolve_path(
        &self,
        requested_path: &str,
    ) -> Result<WorkspaceResolvedPath, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let relative_path = normalize_workspace_path(requested_path)?;
        Ok(WorkspaceResolvedPath {
            absolute_path: join_workspace_relative(&self.root, &relative_path),
            relative_path,
        })
    }

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

    pub fn write_file(
        &self,
        requested_path: &str,
        contents: &str,
    ) -> Result<WorkspaceWriteResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let relative_path = normalize_workspace_path(requested_path)?;
        let absolute_path = join_workspace_relative(&self.root, &relative_path);
        ensure_write_target_inside_workspace(&self.root, &absolute_path)?;
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
                    let message = if absolute_path.read_dir().map(|mut items| items.next().is_some()).unwrap_or(false) {
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

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceResolvedPath {
    pub relative_path: String,
    pub absolute_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceFileContent {
    pub path: String,
    pub contents: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub enum WorkspaceReadFormat {
    Raw,
    NumberedLines,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceReadOptions {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub format: WorkspaceReadFormat,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceReadFileResult {
    pub path: String,
    pub contents: String,
    pub content: String,
    pub content_type: String,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    pub line_total: Option<usize>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceDirectoryEntry {
    pub path: String,
    pub kind: String,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceDirectoryListing {
    pub path: String,
    pub entries: Vec<WorkspaceDirectoryEntry>,
    pub total_entries: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceBootstrapFiles {
    pub files: Vec<WorkspaceFileContent>,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceWriteResult {
    pub path: String,
    pub bytes_written: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceDeleteResult {
    pub path: String,
    pub kind: String,
    pub deleted: bool,
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
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_workspace_files(root, &path, entries)?;
        } else if metadata.is_file() {
            entries.push(WorkspaceFileEntry {
                path: workspace_relative_path(root, &path)?,
                size_bytes: metadata.len(),
            });
        }
    }
    Ok(())
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

fn normalize_workspace_path(requested_path: &str) -> Result<String, WorkerProtocolError> {
    let normalized = requested_path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid_workspace_path(requested_path));
    }
    Ok(normalized)
}

fn normalize_workspace_dir_path(requested_path: &str) -> Result<String, WorkerProtocolError> {
    let normalized = requested_path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if normalized == "." {
        return Ok(".".to_string());
    }
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid_workspace_path(requested_path));
    }
    Ok(normalized.to_string())
}

fn join_workspace_relative(root: &Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn workspace_dir_absolute_path(root: &Path, relative_path: &str) -> PathBuf {
    if relative_path == "." {
        return root.to_path_buf();
    }
    join_workspace_relative(root, relative_path)
}

fn ensure_inside_workspace(root: &Path, path: &Path) -> Result<(), WorkerProtocolError> {
    let root = canonicalize_workspace_root(root)?;
    ensure_inside_canonical_workspace(&root, path)
}

fn ensure_write_target_inside_workspace(
    root: &Path,
    path: &Path,
) -> Result<(), WorkerProtocolError> {
    let root = canonicalize_workspace_root(root)?;
    if path.exists() {
        return ensure_inside_canonical_workspace(&root, path);
    }
    let parent = path.parent().ok_or_else(|| invalid_workspace_path(""))?;
    if parent.exists() {
        return ensure_inside_canonical_workspace(&root, parent);
    }
    ensure_new_parent_chain_inside_workspace(&root, parent)
}

fn ensure_new_parent_chain_inside_workspace(
    root: &Path,
    parent: &Path,
) -> Result<(), WorkerProtocolError> {
    let existing_parent = parent
        .ancestors()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            filesystem_error(
                "failed to locate existing workspace parent directory",
                serde_json::json!({ "path": parent.display().to_string() }),
            )
        })?;
    ensure_inside_canonical_workspace(root, existing_parent)
}

fn ensure_inside_canonical_workspace(root: &Path, path: &Path) -> Result<(), WorkerProtocolError> {
    let path = path.canonicalize().map_err(|error| {
        filesystem_error(
            "failed to resolve workspace path",
            serde_json::json!({
                "path": path.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })?;
    if path.starts_with(root) {
        return Ok(());
    }
    Err(WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "workspace path escapes workspace root",
        serde_json::json!({
            "root": root.display().to_string(),
            "path": path.display().to_string(),
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    ))
}

fn workspace_relative_path(root: &Path, path: &Path) -> Result<String, WorkerProtocolError> {
    path.strip_prefix(root)
        .map_err(|error| {
            filesystem_error(
                "failed to compute workspace relative path",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn canonicalize_workspace_root(root: &Path) -> Result<PathBuf, WorkerProtocolError> {
    root.canonicalize().map_err(|error| {
        filesystem_error(
            "failed to resolve workspace root",
            serde_json::json!({
                "root": root.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })
}

fn invalid_workspace_path(requested_path: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "invalid workspace relative path",
        serde_json::json!({ "path": requested_path }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn filesystem_error(message: impl Into<String>, details: serde_json::Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::{WorkerProtocolErrorCode, WorkerProtocolErrorSource};
    use std::path::PathBuf;

    #[test]
    fn default_policy_denies_workspace_read() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), CapabilityPolicy::default());

        let error = rpc
            .read_file("AGENTS.md")
            .expect_err("read should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["capability"], "fs.workspace.read");
    }

    #[test]
    fn read_file_returns_utf8_content_with_read_capability() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "hello worker");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let file = rpc
            .read_file("AGENTS.md")
            .expect("allowed workspace file should read");

        assert_eq!(file.path, "AGENTS.md");
        assert_eq!(file.contents, "hello worker");
    }

    #[test]
    fn list_files_returns_workspace_relative_paths() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        fixture.write("memory/MEMORY.md", "memory");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let files = rpc.list_files().expect("workspace files should list");
        let paths: Vec<String> = files.into_iter().map(|file| file.path).collect();

        assert_eq!(paths, vec!["AGENTS.md", "memory/MEMORY.md"]);
    }

    #[test]
    fn read_bootstrap_files_returns_present_files_and_missing_names() {
        let fixture = WorkspaceFixture::new();
        fixture.write("USER.md", "user rules");
        fixture.write("AGENTS.md", "agent rules");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let result = rpc
            .read_bootstrap_files(&["AGENTS.md".to_string(), "TOOLS.md".to_string(), "USER.md".to_string()])
            .expect("bootstrap files should read");

        assert_eq!(
            result.files,
            vec![
                WorkspaceFileContent { path: "AGENTS.md".to_string(), contents: "agent rules".to_string() },
                WorkspaceFileContent { path: "USER.md".to_string(), contents: "user rules".to_string() },
            ]
        );
        assert_eq!(result.missing, vec!["TOOLS.md"]);
    }

    #[test]
    fn read_bootstrap_files_rejects_non_allowlisted_paths() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let error = rpc
            .read_bootstrap_files(&["../secret.txt".to_string()])
            .expect_err("bootstrap reader should reject traversal");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    }

    #[test]
    fn list_files_skips_symlinked_directories() {
        let fixture = WorkspaceFixture::new();
        fixture.write("real/NOTE.md", "note");
        let link = fixture.root.join("linked-real");

        #[cfg(target_os = "windows")]
        if let Err(error) = std::os::windows::fs::symlink_dir(fixture.root.join("real"), &link) {
            eprintln!("skipping symlink test because symlink creation failed: {error}");
            return;
        }

        #[cfg(not(target_os = "windows"))]
        if let Err(error) = std::os::unix::fs::symlink(fixture.root.join("real"), &link) {
            eprintln!("skipping symlink test because symlink creation failed: {error}");
            return;
        }

        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let files = rpc.list_files().expect("workspace files should list");
        let paths: Vec<String> = files.into_iter().map(|file| file.path).collect();

        assert_eq!(paths, vec!["real/NOTE.md"]);
    }

    #[test]
    fn resolve_path_normalizes_slashes_without_touching_filesystem() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let resolved = rpc
            .resolve_path("memory\\MEMORY.md")
            .expect("workspace path should resolve");

        assert_eq!(resolved.relative_path, "memory/MEMORY.md");
        assert_eq!(resolved.absolute_path, fixture.root.join("memory").join("MEMORY.md"));
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        assert!(rpc.resolve_path("../secret.txt").is_err());
        assert!(rpc.resolve_path("memory/../secret.txt").is_err());
        assert!(rpc.resolve_path("C:/Windows/System32").is_err());
        assert!(rpc.resolve_path("/etc/passwd").is_err());
    }

    #[test]
    fn symlink_escape_is_rejected_when_reading_existing_file() {
        let fixture = WorkspaceFixture::new();
        let outside = fixture.outside.join("secret.txt");
        std::fs::write(&outside, "secret").expect("outside fixture should write");

        #[cfg(target_os = "windows")]
        std::os::windows::fs::symlink_file(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        #[cfg(not(target_os = "windows"))]
        std::os::unix::fs::symlink(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let error = rpc
            .read_file("linked-secret.txt")
            .expect_err("symlink escape should be blocked");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    }

    #[test]
    fn default_policy_denies_workspace_write() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), CapabilityPolicy::default());

        let error = rpc
            .write_file("notes/today.md", "hello")
            .expect_err("write should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "fs.workspace.write");
    }

    #[test]
    fn read_policy_does_not_allow_workspace_write() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let error = rpc
            .write_file("notes/today.md", "hello")
            .expect_err("read capability should not allow write");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "fs.workspace.write");
    }

    #[test]
    fn write_file_creates_parent_directories_inside_workspace() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        let written = rpc
            .write_file("notes/today.md", "hello writer")
            .expect("write should succeed");

        assert_eq!(written.path, "notes/today.md");
        assert_eq!(written.bytes_written, 12);
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("notes").join("today.md"))
                .expect("written file should read"),
            "hello writer"
        );
    }

    #[test]
    fn write_file_rejects_traversal_and_absolute_paths() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        assert!(rpc.write_file("../secret.txt", "secret").is_err());
        assert!(rpc.write_file("notes/../secret.txt", "secret").is_err());
        assert!(rpc.write_file("C:/Windows/System32", "secret").is_err());
        assert!(rpc.write_file("/etc/passwd", "secret").is_err());
    }

    #[test]
    fn write_file_rejects_symlink_escape_overwrite() {
        let fixture = WorkspaceFixture::new();
        let outside = fixture.outside.join("secret.txt");
        std::fs::write(&outside, "secret").expect("outside fixture should write");

        #[cfg(target_os = "windows")]
        std::os::windows::fs::symlink_file(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        #[cfg(not(target_os = "windows"))]
        std::os::unix::fs::symlink(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        let error = rpc
            .write_file("linked-secret.txt", "overwrite")
            .expect_err("symlink escape should be blocked");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(
            std::fs::read_to_string(outside).expect("outside file should read"),
            "secret"
        );
    }

    #[test]
    fn read_file_with_options_returns_numbered_paginated_lines() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "one\ntwo\nthree\nfour\n");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let file = rpc
            .read_file_with_options(
                "notes/today.md",
                WorkspaceReadOptions {
                    offset: Some(2),
                    limit: Some(2),
                    format: WorkspaceReadFormat::NumberedLines,
                },
            )
            .expect("paginated file should read");

        assert_eq!(file.path, "notes/today.md");
        assert_eq!(file.content, "2| two\n3| three\n\n(Showing lines 2-3 of 4. Use offset=4 to continue.)");
        assert_eq!(file.content_type, "text");
        assert_eq!(file.line_start, Some(2));
        assert_eq!(file.line_end, Some(3));
        assert_eq!(file.line_total, Some(4));
        assert!(file.truncated);
    }

    #[test]
    fn list_dir_respects_path_recursion_max_entries_and_ignores_noise() {
        let fixture = WorkspaceFixture::new();
        fixture.write("README.md", "readme");
        fixture.write("src/main.ts", "main");
        fixture.write("node_modules/pkg/index.js", "noise");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let listing = rpc
            .list_dir(".", true, Some(10))
            .expect("workspace directory should list");
        let paths: Vec<String> = listing.entries.into_iter().map(|entry| entry.path).collect();

        assert_eq!(paths, vec!["README.md", "src/", "src/main.ts"]);
        assert_eq!(listing.path, ".");
        assert!(!listing.truncated);
    }

    #[test]
    fn list_dir_reports_workspace_relative_paths_from_subdirectories() {
        let fixture = WorkspaceFixture::new();
        fixture.write("src/main.ts", "main");
        fixture.write("src/components/button.ts", "button");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let listing = rpc
            .list_dir("src", true, Some(10))
            .expect("subdirectory should list");
        let paths: Vec<String> = listing.entries.into_iter().map(|entry| entry.path).collect();

        assert_eq!(listing.path, "src");
        assert_eq!(paths, vec!["src/components/", "src/components/button.ts", "src/main.ts"]);
    }

    #[test]
    fn delete_file_refuses_workspace_root_and_requires_recursive_for_nonempty_dirs() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        let root_error = rpc
            .delete_file(".", true)
            .expect_err("workspace root should be protected");
        let nonempty_error = rpc
            .delete_file("notes", false)
            .expect_err("non-empty dir should require recursive");
        let deleted = rpc
            .delete_file("notes", true)
            .expect("recursive delete should delete directory");

        assert_eq!(root_error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(nonempty_error.message, "workspace directory is not empty");
        assert_eq!(deleted.path, "notes");
        assert_eq!(deleted.kind, "dir");
        assert!(!fixture.root.join("notes").exists());
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead])
    }

    fn write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite])
    }

    struct WorkspaceFixture {
        root: PathBuf,
        outside: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "tinybot-worker-workspace-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos()
            ));
            let root = base.join("workspace");
            let outside = base.join("outside");
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            std::fs::create_dir_all(&outside).expect("outside fixture should create");
            Self { root, outside }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self.root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }
}
