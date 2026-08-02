use super::*;

const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
const END_PATCH_MARKER: &str = "*** End Patch";
const ADD_FILE_MARKER: &str = "*** Add File: ";
const DELETE_FILE_MARKER: &str = "*** Delete File: ";
const UPDATE_FILE_MARKER: &str = "*** Update File: ";
const MOVE_TO_MARKER: &str = "*** Move to: ";
const END_OF_FILE_MARKER: &str = "*** End of File";
const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATCH_OPERATIONS: usize = 256;
const MAX_PATCH_HUNKS_PER_FILE: usize = 256;

pub(super) fn parse_patch(patch: &str) -> Result<Vec<PatchOperation>, WorkerProtocolError> {
    if patch.len() > MAX_PATCH_BYTES {
        return Err(patch_error(
            format!("patch must not exceed {MAX_PATCH_BYTES} bytes"),
            serde_json::json!({ "bytes": patch.len() }),
        ));
    }
    let patch = patch.trim();
    let lines = patch.lines().collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some(BEGIN_PATCH_MARKER) {
        return Err(patch_error(
            "patch must begin with *** Begin Patch",
            serde_json::json!({ "line": 1 }),
        ));
    }
    if lines.last().map(|line| line.trim()) != Some(END_PATCH_MARKER) {
        return Err(patch_error(
            "patch must end with *** End Patch",
            serde_json::json!({ "line": lines.len().max(1) }),
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
        let marker = lines[index].trim();
        if let Some(path) = marker.strip_prefix(ADD_FILE_MARKER) {
            let path = patch_path(path, index + 1)?;
            index += 1;
            let content_start = index;
            let mut contents = String::new();
            while index < lines.len() - 1 && !is_file_operation(lines[index]) {
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
            if index == content_start {
                return Err(patch_error(
                    "add file operation must contain at least one content line",
                    serde_json::json!({ "line": index + 1 }),
                ));
            }
            operations.push(PatchOperation::Add {
                path,
                contents,
                added_lines: index - content_start,
            });
            continue;
        }
        if let Some(path) = marker.strip_prefix(UPDATE_FILE_MARKER) {
            let path = patch_path(path, index + 1)?;
            index += 1;
            let mut move_path = None;
            if index < lines.len() - 1 {
                if let Some(path) = lines[index].trim_end().strip_prefix(MOVE_TO_MARKER) {
                    move_path = Some(patch_path(path, index + 1)?);
                    index += 1;
                }
            }
            let (chunks, next_index) = parse_update_chunks(&lines, index)?;
            if chunks.is_empty() && move_path.is_none() {
                return Err(patch_error(
                    "update file operation must contain at least one hunk or a move target",
                    serde_json::json!({ "line": index + 1 }),
                ));
            }
            operations.push(PatchOperation::Update {
                path,
                move_path,
                chunks,
            });
            index = next_index;
            continue;
        }
        if let Some(path) = marker.strip_prefix(DELETE_FILE_MARKER) {
            operations.push(PatchOperation::Delete {
                path: patch_path(path, index + 1)?,
            });
            index += 1;
            continue;
        }
        return Err(patch_error(
            "patch contains an invalid file operation",
            serde_json::json!({ "line": index + 1, "content": marker }),
        ));
    }
    Ok(operations)
}

fn parse_update_chunks(
    lines: &[&str],
    mut index: usize,
) -> Result<(Vec<PatchChunk>, usize), WorkerProtocolError> {
    let mut chunks = Vec::new();
    while index < lines.len() - 1 && !is_update_file_operation(lines[index]) {
        if chunks.len() >= MAX_PATCH_HUNKS_PER_FILE {
            return Err(patch_error(
                format!(
                    "update file operation must not contain more than {MAX_PATCH_HUNKS_PER_FILE} hunks"
                ),
                serde_json::json!({ "line": index + 1 }),
            ));
        }
        let marker = lines[index].trim_end();
        let change_context = if let Some(context) = marker.strip_prefix("@@") {
            index += 1;
            (!context.trim().is_empty()).then(|| context.trim().to_string())
        } else if is_update_hunk_content(lines[index]) {
            None
        } else {
            return Err(patch_error(
                "update hunks must begin with @@ or a space, +, -, or blank content line",
                serde_json::json!({ "line": index + 1 }),
            ));
        };
        let hunk_line = index + 1;
        let mut old_lines = Vec::new();
        let mut new_lines = Vec::new();
        let mut removed_lines = 0;
        let mut added_lines = 0;
        let mut is_end_of_file = false;
        while index < lines.len() - 1 {
            if is_update_file_operation(lines[index]) || is_update_hunk_header(lines[index]) {
                break;
            }
            if lines[index].trim_end() == END_OF_FILE_MARKER {
                is_end_of_file = true;
                index += 1;
                break;
            }
            let line = lines[index];
            if line.is_empty() {
                old_lines.push(String::new());
                new_lines.push(String::new());
                index += 1;
                continue;
            }
            let Some((prefix, content)) = line.split_at_checked(1) else {
                return Err(patch_error(
                    "update hunk lines must begin with space, +, or -",
                    serde_json::json!({ "line": index + 1 }),
                ));
            };
            match prefix {
                " " => {
                    old_lines.push(content.to_string());
                    new_lines.push(content.to_string());
                }
                "-" => {
                    old_lines.push(content.to_string());
                    removed_lines += 1;
                }
                "+" => {
                    new_lines.push(content.to_string());
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
        if removed_lines == 0 && added_lines == 0 {
            return Err(patch_error(
                "update hunk must change at least one line",
                serde_json::json!({ "line": hunk_line }),
            ));
        }
        chunks.push(PatchChunk {
            change_context,
            old_lines,
            new_lines,
            removed_lines,
            added_lines,
            is_end_of_file,
        });
        if is_end_of_file {
            while index < lines.len() - 1 && lines[index].trim().is_empty() {
                index += 1;
            }
            if index < lines.len() - 1 && !is_update_file_operation(lines[index]) {
                return Err(patch_error(
                    "*** End of File must terminate an update operation",
                    serde_json::json!({ "line": index + 1 }),
                ));
            }
        }
    }
    Ok((chunks, index))
}

fn patch_path(path: &str, line: usize) -> Result<String, WorkerProtocolError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(patch_error(
            "patch file path must not be empty",
            serde_json::json!({ "line": line }),
        ));
    }
    Ok(path.to_string())
}

fn is_file_operation(line: &str) -> bool {
    let marker = line.trim();
    marker == END_PATCH_MARKER
        || marker.starts_with(ADD_FILE_MARKER)
        || marker.starts_with(UPDATE_FILE_MARKER)
        || marker.starts_with(DELETE_FILE_MARKER)
}

fn is_update_file_operation(line: &str) -> bool {
    let marker = line.trim_end();
    marker == END_PATCH_MARKER
        || marker.starts_with(ADD_FILE_MARKER)
        || marker.starts_with(UPDATE_FILE_MARKER)
        || marker.starts_with(DELETE_FILE_MARKER)
}

fn is_update_hunk_header(line: &str) -> bool {
    line.trim_end().starts_with("@@")
}

fn is_update_hunk_content(line: &str) -> bool {
    line.is_empty() || matches!(line.as_bytes().first(), Some(b' ' | b'+' | b'-'))
}
