use crate::worker_storage::{write_text_atomic, AtomicWriteOptions};
use std::collections::HashSet;

const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATCH_OPERATIONS: usize = 256;
const MAX_PATCH_HUNKS_PER_FILE: usize = 256;

impl WorkerWorkspaceRpc {
    pub fn apply_patch(
        &self,
        patch: &str,
    ) -> Result<WorkspacePatchApplyResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let operations = parse_patch(patch)?;
        let prepared = self.prepare_patch_operations(operations)?;
        self.write_prepared_patch_operations(&prepared)?;

        let hunks_applied = prepared
            .iter()
            .map(PreparedPatchOperation::hunk_count)
            .sum();
        let changed_files = prepared
            .into_iter()
            .map(PreparedPatchOperation::file_change)
            .collect::<Vec<_>>();

        Ok(WorkspacePatchApplyResult {
            files_changed: changed_files.len(),
            hunks_applied,
            changed_files,
        })
    }

    pub(crate) fn inspect_patch_targets(
        &self,
        patch: &str,
    ) -> Result<Vec<String>, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let operations = parse_patch(patch)?;
        let mut seen_paths = HashSet::new();
        let mut targets = Vec::with_capacity(operations.len());
        for operation in operations {
            let path = normalize_workspace_path(operation.path())?;
            if !seen_paths.insert(path.clone()) {
                return Err(patch_error(
                    "patch may not modify the same file more than once",
                    serde_json::json!({ "path": path }),
                ));
            }
            targets.push(path);
        }
        Ok(targets)
    }

    fn prepare_patch_operations(
        &self,
        operations: Vec<PatchOperation>,
    ) -> Result<Vec<PreparedPatchOperation>, WorkerProtocolError> {
        let mut seen_paths = HashSet::new();
        let mut prepared = Vec::with_capacity(operations.len());
        for operation in operations {
            let relative_path = normalize_workspace_path(operation.path())?;
            if !seen_paths.insert(relative_path.clone()) {
                return Err(patch_error(
                    "patch may not modify the same file more than once",
                    serde_json::json!({ "path": relative_path }),
                ));
            }
            let absolute_path = join_workspace_relative(&self.root, &relative_path);
            match operation {
                PatchOperation::Add {
                    contents,
                    added_lines,
                    ..
                } => {
                    ensure_write_target_inside_workspace(&self.root, &absolute_path)?;
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
                PatchOperation::Update { hunks, .. } => {
                    ensure_existing_patch_file(
                        &self.root,
                        &absolute_path,
                        &relative_path,
                        "update",
                    )?;
                    let source = read_patch_file(&absolute_path, &relative_path)?;
                    let contents = apply_update_hunks(&source, &hunks, &relative_path)?;
                    prepared.push(PreparedPatchOperation::Update {
                        relative_path,
                        absolute_path,
                        source,
                        contents,
                        hunks,
                    });
                }
                PatchOperation::Delete { .. } => {
                    ensure_existing_patch_file(
                        &self.root,
                        &absolute_path,
                        &relative_path,
                        "delete",
                    )?;
                    prepared.push(PreparedPatchOperation::Delete {
                        relative_path,
                        absolute_path,
                    });
                }
            }
        }
        Ok(prepared)
    }

    fn write_prepared_patch_operations(
        &self,
        prepared: &[PreparedPatchOperation],
    ) -> Result<(), WorkerProtocolError> {
        for operation in prepared {
            match operation {
                PreparedPatchOperation::Add {
                    relative_path,
                    absolute_path,
                    contents,
                    ..
                } => {
                    ensure_write_target_inside_workspace(&self.root, absolute_path)?;
                    if let Some(parent) = absolute_path.parent() {
                        std::fs::create_dir_all(parent).map_err(|error| {
                            filesystem_error(
                                "failed to create workspace patch parent directory",
                                serde_json::json!({
                                    "path": relative_path,
                                    "error": error.to_string(),
                                }),
                            )
                        })?;
                        ensure_inside_workspace(&self.root, parent)?;
                    }
                    if workspace_path_exists(absolute_path)? {
                        return Err(patch_error(
                            "add patch target already exists",
                            serde_json::json!({ "path": relative_path }),
                        ));
                    }
                    write_patch_file(absolute_path, contents, relative_path)?;
                }
                PreparedPatchOperation::Update {
                    relative_path,
                    absolute_path,
                    source,
                    contents,
                    ..
                } => {
                    ensure_existing_patch_file(&self.root, absolute_path, relative_path, "update")?;
                    let current = read_patch_file(absolute_path, relative_path)?;
                    if &current != source {
                        return Err(patch_error(
                            "update patch precondition no longer matches file contents",
                            serde_json::json!({ "path": relative_path }),
                        ));
                    }
                    write_patch_file(absolute_path, contents, relative_path)?;
                }
                PreparedPatchOperation::Delete {
                    relative_path,
                    absolute_path,
                } => {
                    ensure_existing_patch_file(&self.root, absolute_path, relative_path, "delete")?;
                    std::fs::remove_file(absolute_path).map_err(|error| {
                        filesystem_error(
                            "failed to delete workspace patch target",
                            serde_json::json!({
                                "path": relative_path,
                                "error": error.to_string(),
                            }),
                        )
                    })?;
                }
            }
        }
        Ok(())
    }
}

enum PatchOperation {
    Add {
        path: String,
        contents: String,
        added_lines: usize,
    },
    Update {
        path: String,
        hunks: Vec<PatchHunk>,
    },
    Delete {
        path: String,
    },
}

impl PatchOperation {
    fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Update { path, .. } | Self::Delete { path } => path,
        }
    }
}

struct PatchHunk {
    original: Vec<String>,
    replacement: Vec<String>,
    removed_lines: usize,
    added_lines: usize,
}

enum PreparedPatchOperation {
    Add {
        relative_path: String,
        absolute_path: PathBuf,
        contents: String,
        added_lines: usize,
    },
    Update {
        relative_path: String,
        absolute_path: PathBuf,
        source: String,
        contents: String,
        hunks: Vec<PatchHunk>,
    },
    Delete {
        relative_path: String,
        absolute_path: PathBuf,
    },
}

impl PreparedPatchOperation {
    fn hunk_count(&self) -> usize {
        match self {
            Self::Add { .. } => 1,
            Self::Update { hunks, .. } => hunks.len(),
            Self::Delete { .. } => 0,
        }
    }

    fn file_change(self) -> WorkspacePatchFileChange {
        match self {
            Self::Add {
                relative_path,
                added_lines,
                ..
            } => WorkspacePatchFileChange {
                path: relative_path,
                operation: "add".to_string(),
                hunks: vec![WorkspacePatchHunkSummary {
                    index: 1,
                    removed_lines: 0,
                    added_lines,
                }],
            },
            Self::Update {
                relative_path,
                hunks,
                ..
            } => WorkspacePatchFileChange {
                path: relative_path,
                operation: "update".to_string(),
                hunks: hunks
                    .into_iter()
                    .enumerate()
                    .map(|(index, hunk)| WorkspacePatchHunkSummary {
                        index: index + 1,
                        removed_lines: hunk.removed_lines,
                        added_lines: hunk.added_lines,
                    })
                    .collect(),
            },
            Self::Delete { relative_path, .. } => WorkspacePatchFileChange {
                path: relative_path,
                operation: "delete".to_string(),
                hunks: Vec::new(),
            },
        }
    }
}

fn parse_patch(patch: &str) -> Result<Vec<PatchOperation>, WorkerProtocolError> {
    if patch.len() > MAX_PATCH_BYTES {
        return Err(patch_error(
            format!("patch must not exceed {MAX_PATCH_BYTES} bytes"),
            serde_json::json!({ "bytes": patch.len() }),
        ));
    }
    let lines: Vec<&str> = patch.lines().collect();
    if lines.first() != Some(&"*** Begin Patch") {
        return Err(patch_error(
            "patch must begin with *** Begin Patch",
            serde_json::json!({}),
        ));
    }
    if lines.last() != Some(&"*** End Patch") {
        return Err(patch_error(
            "patch must end with *** End Patch",
            serde_json::json!({}),
        ));
    }
    if lines.len() < 3 {
        return Err(patch_error(
            "patch must contain at least one file operation",
            serde_json::json!({}),
        ));
    }

    let mut operations = Vec::new();
    let mut index = 1;
    while index < lines.len() - 1 {
        if operations.len() >= MAX_PATCH_OPERATIONS {
            return Err(patch_error(
                format!("patch must not contain more than {MAX_PATCH_OPERATIONS} file operations"),
                serde_json::json!({ "line": index + 1 }),
            ));
        }
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let path = patch_path(path, index + 1)?;
            index += 1;
            let content_start = index;
            let mut contents = String::new();
            while index < lines.len() - 1 && !lines[index].starts_with("*** ") {
                let Some(content) = lines[index].strip_prefix('+') else {
                    return Err(patch_error(
                        "add file content lines must begin with +",
                        serde_json::json!({ "line": index + 1 }),
                    ));
                };
                contents.push_str(content);
                contents.push('\n');
                index += 1;
            }
            operations.push(PatchOperation::Add {
                path,
                contents,
                added_lines: index - content_start,
            });
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            let path = patch_path(path, index + 1)?;
            index += 1;
            let (hunks, next_index) = parse_update_hunks(&lines, index)?;
            operations.push(PatchOperation::Update { path, hunks });
            index = next_index;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            operations.push(PatchOperation::Delete {
                path: patch_path(path, index + 1)?,
            });
            index += 1;
            continue;
        }
        return Err(patch_error(
            "patch contains an invalid file operation",
            serde_json::json!({ "line": index + 1 }),
        ));
    }
    Ok(operations)
}

fn patch_path(path: &str, line: usize) -> Result<String, WorkerProtocolError> {
    if path.is_empty() {
        return Err(patch_error(
            "patch file path must not be empty",
            serde_json::json!({ "line": line }),
        ));
    }
    Ok(path.to_string())
}

fn parse_update_hunks(
    lines: &[&str],
    mut index: usize,
) -> Result<(Vec<PatchHunk>, usize), WorkerProtocolError> {
    let mut hunks = Vec::new();
    while index < lines.len() - 1 && !lines[index].starts_with("*** ") {
        if hunks.len() >= MAX_PATCH_HUNKS_PER_FILE {
            return Err(patch_error(
                format!(
                    "update file operation must not contain more than {MAX_PATCH_HUNKS_PER_FILE} hunks"
                ),
                serde_json::json!({ "line": index + 1 }),
            ));
        }
        if lines[index] != "@@" {
            return Err(patch_error(
                "update file operations must begin each hunk with @@",
                serde_json::json!({ "line": index + 1 }),
            ));
        }
        index += 1;
        let hunk_line = index + 1;
        let mut original = Vec::new();
        let mut replacement = Vec::new();
        let mut removed_lines = 0;
        let mut added_lines = 0;
        while index < lines.len() - 1 && lines[index] != "@@" && !lines[index].starts_with("*** ") {
            let line = lines[index];
            let Some((prefix, content)) = line.split_at_checked(1) else {
                return Err(patch_error(
                    "update hunk lines must begin with space, +, or -",
                    serde_json::json!({ "line": index + 1 }),
                ));
            };
            match prefix {
                " " => {
                    original.push(content.to_string());
                    replacement.push(content.to_string());
                }
                "-" => {
                    original.push(content.to_string());
                    removed_lines += 1;
                }
                "+" => {
                    replacement.push(content.to_string());
                    added_lines += 1;
                }
                _ => {
                    return Err(patch_error(
                        "update hunk lines must begin with space, +, or -",
                        serde_json::json!({ "line": index + 1 }),
                    ));
                }
            }
            index += 1;
        }
        if original.is_empty() {
            return Err(patch_error(
                "update hunk must include at least one context or removed line",
                serde_json::json!({ "line": hunk_line }),
            ));
        }
        if removed_lines == 0 && added_lines == 0 {
            return Err(patch_error(
                "update hunk must change at least one line",
                serde_json::json!({ "line": hunk_line }),
            ));
        }
        hunks.push(PatchHunk {
            original,
            replacement,
            removed_lines,
            added_lines,
        });
    }
    if hunks.is_empty() {
        return Err(patch_error(
            "update file operation must contain at least one hunk",
            serde_json::json!({ "line": index + 1 }),
        ));
    }
    Ok((hunks, index))
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

fn apply_update_hunks(
    source: &str,
    hunks: &[PatchHunk],
    relative_path: &str,
) -> Result<String, WorkerProtocolError> {
    let line_ending = if source.contains("\r\n") { "\r\n" } else { "\n" };
    if !source.is_empty() && !source.ends_with(line_ending) {
        return Err(patch_error(
            "update patch target must end with a newline",
            serde_json::json!({ "path": relative_path }),
        ));
    }
    let source_lines = if source.is_empty() {
        Vec::new()
    } else {
        source
            .strip_suffix(line_ending)
            .expect("non-empty patch target must have a trailing newline")
            .split(line_ending)
            .map(str::to_string)
            .collect()
    };
    let mut output = Vec::new();
    let mut source_index = 0;
    for (hunk_index, hunk) in hunks.iter().enumerate() {
        let match_index =
            find_exact_hunk(&source_lines, source_index, &hunk.original).ok_or_else(|| {
                patch_error(
                    "update patch hunk does not match file contents",
                    serde_json::json!({
                        "path": relative_path,
                        "hunk": hunk_index + 1,
                    }),
                )
            })?;
        if find_exact_hunk(&source_lines, match_index + 1, &hunk.original).is_some() {
            return Err(patch_error(
                "update patch hunk matches file contents more than once",
                serde_json::json!({
                    "path": relative_path,
                    "hunk": hunk_index + 1,
                }),
            ));
        }
        output.extend_from_slice(&source_lines[source_index..match_index]);
        output.extend(hunk.replacement.iter().cloned());
        source_index = match_index + hunk.original.len();
    }
    output.extend_from_slice(&source_lines[source_index..]);
    if output.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!("{}{line_ending}", output.join(line_ending)))
    }
}

fn find_exact_hunk(source: &[String], start: usize, expected: &[String]) -> Option<usize> {
    source
        .windows(expected.len())
        .enumerate()
        .skip(start)
        .find_map(|(index, candidate)| (candidate == expected).then_some(index))
}

fn write_patch_file(
    absolute_path: &Path,
    contents: &str,
    relative_path: &str,
) -> Result<(), WorkerProtocolError> {
    write_text_atomic(absolute_path, contents, AtomicWriteOptions::default()).map_err(|error| {
        filesystem_error(
            "failed to write workspace patch target",
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

fn patch_error(message: impl Into<String>, details: serde_json::Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
