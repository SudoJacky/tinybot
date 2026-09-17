use super::model::*;
use crate::protocol::capability::CapabilityPolicy;
use crate::workspace::WorkerWorkspaceRpc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const SUMMARY_BYTES: usize = 1024;
pub const MESSAGE_BYTES: usize = 4096;
pub const READ_BYTES: usize = 8192;
const ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Artifact {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BoardMessage {
    pub summary: String,
    pub artifacts: Vec<Artifact>,
    pub unresolved: String,
    pub sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Completion {
    summary: String,
    artifacts: Vec<String>,
    unresolved: String,
}

impl BoardMessage {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let mut size_probe = self.clone();
        size_probe.sequence = u64::MAX; // Reserve host-assigned sequence space before accepting a message.
        if self.summary.trim().is_empty()
            || self.summary.len() > SUMMARY_BYTES
            || self.unresolved.len() > SUMMARY_BYTES
            || self.artifacts.len() > 8
            || serde_json::to_vec(&size_probe)
                .map_err(|e| e.to_string())?
                .len()
                > MESSAGE_BYTES
        {
            return Err(format!("Invalid Team message: summary must be nonblank and <= {SUMMARY_BYTES} UTF-8 bytes, unresolved <= {SUMMARY_BYTES} bytes, at most 8 artifacts, total <= {MESSAGE_BYTES} bytes. Store detailed evidence in files."));
        }
        let mut paths = std::collections::HashSet::new();
        for artifact in &self.artifacts {
            if artifact.path.is_empty()
                || artifact.path.len() > 512
                || artifact.bytes > ARTIFACT_BYTES
                || artifact.sha256.len() != 64
                || !artifact.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || !paths.insert(&artifact.path)
            {
                return Err("Invalid or duplicate Team artifact reference".into());
            }
        }
        Ok(())
    }
}

pub(crate) fn complete(
    workspace: &Path,
    policy: CapabilityPolicy,
    args: Value,
) -> Result<BoardMessage, String> {
    if args.to_string().len() > MESSAGE_BYTES {
        return Err(format!(
            "Team completion exceeds {MESSAGE_BYTES} bytes; keep only the handoff and file paths"
        ));
    }
    let input: Completion =
        serde_json::from_value(args).map_err(|e| format!("Invalid Team completion: {e}"))?;
    let mut message = BoardMessage {
        summary: input.summary,
        unresolved: input.unresolved,
        artifacts: vec![],
        sequence: 0,
    };
    message.validate()?;
    if input.artifacts.len() > 8 {
        return Err("At most 8 Team artifacts are allowed".into());
    }
    let files = WorkerWorkspaceRpc::new(workspace.to_path_buf(), policy);
    for path in input.artifacts {
        if path.len() > 512 {
            return Err("Team artifact path exceeds 512 bytes".into());
        }
        let resolved = files.resolve_path(&path).map_err(|e| e.message)?;
        let bytes = files
            .read_file_bytes(&resolved.relative_path, None, ARTIFACT_BYTES)
            .map_err(|e| format!("Artifact {}: {}", path, e.message))?;
        message.artifacts.push(Artifact {
            path: resolved.relative_path,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.len() as u64,
        });
    }
    message.validate()?;
    Ok(message)
}

pub(crate) fn entry<'a>(
    run: &'a TeamRun,
    entry_id: &str,
) -> Result<(&'a TaskRecord, &'a TeamAttempt), String> {
    run.tasks
        .iter()
        .flat_map(|r| r.attempts.iter().map(move |a| (r, a)))
        .find(|(_, a)| a.thread_id == entry_id && a.status == TaskStatus::Succeeded)
        .ok_or_else(|| format!("No published Team message {entry_id} in this run"))
}

fn index(record: &TaskRecord, attempt: &TeamAttempt) -> Value {
    json!({"entryId": attempt.thread_id, "taskId": record.task.id, "memberId": record.task.member_id,
        "sequence": attempt.message.as_ref().map(|m| m.sequence).unwrap_or(0), "legacy": attempt.message.is_none()})
}

pub(crate) fn dependencies(run: &TeamRun, task: &TeamTask) -> Vec<Value> {
    let mut summary_bytes = 0;
    task.dependencies
        .iter()
        .map(|id| {
            let record = run
                .tasks
                .iter()
                .find(|r| &r.task.id == id)
                .expect("validated dependency");
            let attempt = record.attempts.last().expect("successful dependency");
            let mut value = index(record, attempt);
            if let Some(message) = &attempt.message {
                // Keep the total automatic summary budget bounded even at maximum fan-in.
                if summary_bytes + message.summary.len() <= READ_BYTES {
                    value["summary"] = json!(message.summary);
                    summary_bytes += message.summary.len();
                }
            }
            value
        })
        .collect()
}

pub(crate) fn list(
    run: &TeamRun,
    after: u64,
    offset: usize,
    limit: usize,
    task_id: Option<&str>,
) -> Result<Value, String> {
    if !(1..=8).contains(&limit) {
        return Err("Board list limit must be 1–8".into());
    }
    let mut entries: Vec<_> = run
        .tasks
        .iter()
        .filter(|r| task_id.is_none_or(|id| r.task.id == id))
        .flat_map(|r| {
            r.attempts
                .iter()
                .filter(|a| a.status == TaskStatus::Succeeded)
                .filter(move |a| {
                    after == 0 || a.message.as_ref().is_some_and(|m| m.sequence > after)
                })
                .map(move |a| (r, a))
        })
        .collect();
    entries.sort_by_key(|(_, a)| {
        (
            a.message.as_ref().map(|m| m.sequence).unwrap_or(0),
            &a.thread_id,
        )
    });
    if offset > entries.len() {
        return Err("Board offset is beyond the result list".into());
    }
    let page: Vec<_> = entries
        .iter()
        .skip(offset)
        .take(limit)
        .map(|(r, a)| {
            let mut value = index(r, a);
            if let Some(m) = &a.message {
                value["summary"] = json!(m.summary);
            }
            value
        })
        .collect();
    let next = offset + page.len();
    Ok(
        json!({"entries": page, "nextOffset": (next < entries.len()).then_some(next), "revision": run.revision}),
    )
}

pub(crate) fn text_page(text: &str, offset: usize, max_bytes: usize) -> Result<Value, String> {
    if !(4..=READ_BYTES).contains(&max_bytes)
        || offset > text.len()
        || !text.is_char_boundary(offset)
    {
        return Err(format!(
            "Read requires a valid UTF-8 byte offset and maxBytes between 4 and {READ_BYTES}"
        ));
    }
    let mut end = offset.saturating_add(max_bytes).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(
        json!({"text": &text[offset..end], "byteOffset": offset, "nextByteOffset": (end < text.len()).then_some(end), "totalBytes": text.len()}),
    )
}

pub(crate) fn read(
    run: &TeamRun,
    entry_id: &str,
    offset: usize,
    max_bytes: usize,
) -> Result<Value, String> {
    let (record, attempt) = entry(run, entry_id)?;
    let mut value = index(record, attempt);
    if let Some(message) = &attempt.message {
        value["message"] = serde_json::to_value(message).map_err(|e| e.to_string())?;
    } else {
        value["legacyOutput"] = text_page(
            attempt.output.as_deref().ok_or("Missing legacy output")?,
            offset,
            max_bytes,
        )?;
    }
    Ok(value)
}

pub(crate) fn read_artifact(
    run: &TeamRun,
    policy: CapabilityPolicy,
    entry_id: &str,
    artifact_index: usize,
    offset: usize,
    max_bytes: usize,
) -> Result<Value, String> {
    let (_, attempt) = entry(run, entry_id)?;
    let artifact = attempt
        .message
        .as_ref()
        .and_then(|m| m.artifacts.get(artifact_index))
        .ok_or("Unknown Team artifact index; read the message first")?;
    let files = WorkerWorkspaceRpc::new(run.spec.workspace_path.clone().into(), policy);
    let bytes = files
        .read_file_bytes(&artifact.path, None, ARTIFACT_BYTES)
        .map_err(|e| format!("Artifact {}: {}", artifact.path, e.message))?;
    if bytes.len() as u64 != artifact.bytes
        || format!("{:x}", Sha256::digest(&bytes)) != artifact.sha256
    {
        return Err(format!("Artifact {} changed since publication; inspect the producing task instead of treating the current file as its original result", artifact.path));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "This artifact is binary; open it in its native viewer")?;
    let mut page = text_page(text, offset, max_bytes)?;
    page["path"] = json!(artifact.path);
    page["sha256"] = json!(artifact.sha256);
    Ok(page)
}
