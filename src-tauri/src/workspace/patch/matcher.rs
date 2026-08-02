use super::*;

pub(super) fn apply_update_chunks(
    source: &str,
    chunks: &[PatchChunk],
    relative_path: &str,
) -> Result<(String, Vec<WorkspacePatchHunkDelta>), WorkerProtocolError> {
    if chunks.is_empty() {
        return Ok((source.to_string(), Vec::new()));
    }
    let line_ending = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let normalized = source.replace("\r\n", "\n");
    let mut original_lines = if normalized.is_empty() {
        Vec::new()
    } else {
        normalized
            .split('\n')
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    if original_lines.last().is_some_and(String::is_empty) {
        original_lines.pop();
    }

    let mut replacements = Vec::new();
    let mut delta = Vec::with_capacity(chunks.len());
    let mut line_offset = 0isize;
    let mut line_index = 0;
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        if let Some(context) = chunk.change_context.as_ref() {
            let context_pattern = vec![context.clone()];
            let context_index = find_unique_sequence(
                &original_lines,
                &context_pattern,
                line_index,
                false,
                relative_path,
                chunk_index,
            )?
            .ok_or_else(|| {
                patch_error(
                    "update patch context does not match file contents",
                    serde_json::json!({
                        "path": relative_path,
                        "hunk": chunk_index + 1,
                        "context": context,
                    }),
                )
            })?;
            line_index = context_index + 1;
        }

        if chunk.old_lines.is_empty() {
            let match_index = original_lines.len();
            delta.push(WorkspacePatchHunkDelta {
                old_start: match_index + 1,
                new_start: (match_index as isize + line_offset).max(0) as usize + 1,
                old_lines: Vec::new(),
                new_lines: chunk.new_lines.clone(),
            });
            line_offset += chunk.new_lines.len() as isize;
            replacements.push((match_index, 0, chunk.new_lines.clone()));
            continue;
        }
        let match_index = find_unique_sequence(
            &original_lines,
            &chunk.old_lines,
            line_index,
            chunk.is_end_of_file,
            relative_path,
            chunk_index,
        )?
        .ok_or_else(|| {
            patch_error(
                "update patch hunk does not match file contents",
                serde_json::json!({
                    "path": relative_path,
                    "hunk": chunk_index + 1,
                    "expected": bounded_expected_lines(&chunk.old_lines),
                }),
            )
        })?;
        let old_len = chunk.old_lines.len();
        delta.push(WorkspacePatchHunkDelta {
            old_start: match_index + 1,
            new_start: (match_index as isize + line_offset).max(0) as usize + 1,
            old_lines: original_lines[match_index..match_index + old_len].to_vec(),
            new_lines: chunk.new_lines.clone(),
        });
        line_offset += chunk.new_lines.len() as isize - old_len as isize;
        replacements.push((match_index, old_len, chunk.new_lines.clone()));
        line_index = match_index + chunk.old_lines.len();
    }

    for (start, old_len, new_lines) in replacements.into_iter().rev() {
        original_lines.splice(start..start + old_len, new_lines);
    }
    if original_lines.is_empty() {
        Ok((String::new(), delta))
    } else {
        Ok((
            format!("{}{line_ending}", original_lines.join(line_ending)),
            delta,
        ))
    }
}

fn find_unique_sequence(
    lines: &[String],
    pattern: &[String],
    start: usize,
    eof: bool,
    relative_path: &str,
    chunk_index: usize,
) -> Result<Option<usize>, WorkerProtocolError> {
    if pattern.is_empty() {
        return Ok(Some(start.min(lines.len())));
    }
    if pattern.len() > lines.len() || start > lines.len().saturating_sub(pattern.len()) {
        return Ok(None);
    }
    let strategies: [fn(&str) -> String; 4] = [
        str::to_string,
        |value| value.trim_end().to_string(),
        |value| value.trim().to_string(),
        normalize_unicode_punctuation,
    ];
    for normalize in strategies {
        let candidate_range = if eof {
            let end = lines.len() - pattern.len();
            end..=end
        } else {
            start..=lines.len() - pattern.len()
        };
        let matches = candidate_range
            .filter(|candidate| {
                pattern.iter().enumerate().all(|(offset, expected)| {
                    normalize(&lines[*candidate + offset]) == normalize(expected)
                })
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => continue,
            [single] => return Ok(Some(*single)),
            _ => {
                return Err(patch_error(
                    "update patch hunk matches file contents more than once",
                    serde_json::json!({
                        "path": relative_path,
                        "hunk": chunk_index + 1,
                        "matches": matches.len(),
                    }),
                ));
            }
        }
    }
    Ok(None)
}

fn normalize_unicode_punctuation(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| match character {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

fn bounded_expected_lines(lines: &[String]) -> String {
    const MAX_EXPECTED_CHARS: usize = 2_048;
    let expected = lines.join("\n");
    if expected.chars().count() <= MAX_EXPECTED_CHARS {
        return expected;
    }
    format!(
        "{}…",
        expected
            .chars()
            .take(MAX_EXPECTED_CHARS)
            .collect::<String>()
    )
}
