use super::*;

const MAX_PATCH_DELTA_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(super) enum PatchOperation {
    Add {
        path: String,
        contents: String,
        added_lines: usize,
    },
    Update {
        path: String,
        move_path: Option<String>,
        chunks: Vec<PatchChunk>,
    },
    Delete {
        path: String,
    },
}

impl PatchOperation {
    pub(super) fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Update { path, .. } | Self::Delete { path } => path,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct PatchChunk {
    pub(super) change_context: Option<String>,
    pub(super) old_lines: Vec<String>,
    pub(super) new_lines: Vec<String>,
    pub(super) removed_lines: usize,
    pub(super) added_lines: usize,
    pub(super) is_end_of_file: bool,
}

#[derive(Debug)]
pub(super) enum PreparedPatchOperation {
    Add {
        relative_path: String,
        absolute_path: PathBuf,
        contents: String,
        added_lines: usize,
    },
    Update {
        relative_path: String,
        absolute_path: PathBuf,
        move_relative_path: Option<String>,
        move_absolute_path: Option<PathBuf>,
        source: String,
        contents: String,
        chunks: Vec<PatchChunk>,
        delta: Vec<WorkspacePatchHunkDelta>,
        delta_truncated: bool,
        source_permissions: std::fs::Permissions,
    },
    Delete {
        relative_path: String,
        absolute_path: PathBuf,
        source: String,
        source_revision: String,
    },
}

impl PreparedPatchOperation {
    pub(super) fn success_change(&self) -> WorkspacePatchFileChange {
        match self {
            Self::Add {
                relative_path,
                contents,
                added_lines,
                ..
            } => added_file_change(relative_path, contents, *added_lines),
            Self::Update {
                relative_path,
                move_relative_path,
                chunks,
                delta,
                delta_truncated,
                ..
            } => WorkspacePatchFileChange {
                path: relative_path.clone(),
                operation: "update".to_string(),
                move_path: move_relative_path.clone(),
                hunks: chunks
                    .iter()
                    .enumerate()
                    .map(|(index, chunk)| WorkspacePatchHunkSummary {
                        index: index + 1,
                        removed_lines: chunk.removed_lines,
                        added_lines: chunk.added_lines,
                    })
                    .collect(),
                delta: delta.clone(),
                delta_truncated: *delta_truncated,
            },
            Self::Delete {
                relative_path,
                source,
                ..
            } => deleted_file_change(relative_path, source),
        }
    }
}

pub(super) fn added_file_change(
    path: &str,
    contents: &str,
    added_lines: usize,
) -> WorkspacePatchFileChange {
    let (delta, delta_truncated) = if contents.len() > MAX_PATCH_DELTA_BYTES {
        (Vec::new(), true)
    } else {
        bounded_patch_delta(vec![WorkspacePatchHunkDelta {
            old_start: 1,
            new_start: 1,
            old_lines: Vec::new(),
            new_lines: patch_text_lines(contents),
        }])
    };
    WorkspacePatchFileChange {
        path: path.to_string(),
        operation: "add".to_string(),
        move_path: None,
        hunks: vec![WorkspacePatchHunkSummary {
            index: 1,
            removed_lines: 0,
            added_lines,
        }],
        delta,
        delta_truncated,
    }
}

fn deleted_file_change(path: &str, source: &str) -> WorkspacePatchFileChange {
    let (delta, delta_truncated) = if source.len() > MAX_PATCH_DELTA_BYTES {
        (Vec::new(), true)
    } else {
        bounded_patch_delta(vec![WorkspacePatchHunkDelta {
            old_start: 1,
            new_start: 1,
            old_lines: patch_text_lines(source),
            new_lines: Vec::new(),
        }])
    };
    WorkspacePatchFileChange {
        path: path.to_string(),
        operation: "delete".to_string(),
        move_path: None,
        hunks: Vec::new(),
        delta,
        delta_truncated,
    }
}

pub(super) fn bounded_patch_delta(
    delta: Vec<WorkspacePatchHunkDelta>,
) -> (Vec<WorkspacePatchHunkDelta>, bool) {
    let bytes = delta
        .iter()
        .flat_map(|hunk| hunk.old_lines.iter().chain(&hunk.new_lines))
        .try_fold(0usize, |total, line| {
            total
                .checked_add(line.len())
                .and_then(|value| value.checked_add(1))
        });
    if bytes.is_none_or(|bytes| bytes > MAX_PATCH_DELTA_BYTES) {
        return (Vec::new(), true);
    }
    (delta, false)
}

fn patch_text_lines(contents: &str) -> Vec<String> {
    contents.lines().map(str::to_string).collect()
}

#[derive(Debug)]
pub(super) struct PatchFailure {
    pub(super) error: WorkerProtocolError,
    pub(super) committed: Vec<WorkspacePatchFileChange>,
    pub(super) exact: bool,
}

impl PatchFailure {
    pub(super) fn before_commit(error: WorkerProtocolError) -> Self {
        Self {
            error,
            committed: Vec::new(),
            exact: true,
        }
    }

    pub(super) fn into_protocol_error(mut self) -> WorkerProtocolError {
        let files_changed = self.committed.len();
        let hunks_applied = self
            .committed
            .iter()
            .map(|change| change.hunks.len())
            .sum::<usize>();
        let committed = serde_json::json!({
            "changed_files": self.committed,
            "files_changed": files_changed,
            "hunks_applied": hunks_applied,
            "exact": self.exact,
        });
        match &mut self.error.details {
            serde_json::Value::Object(details) => {
                details.insert("committed".to_string(), committed);
            }
            original => {
                *original = serde_json::json!({
                    "cause": original.clone(),
                    "committed": committed,
                });
            }
        }
        self.error
    }
}
