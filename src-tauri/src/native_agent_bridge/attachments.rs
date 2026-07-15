use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const ATTACHMENTS_ROOT: &str = ".tinybot/attachments";

pub(crate) fn materialize_turn_attachments(
    spec: &mut Value,
    workspace_root: &Path,
) -> Result<(), String> {
    let Some(messages) = spec.get("messages").and_then(Value::as_array) else {
        return Ok(());
    };
    let has_inline_attachments = messages.iter().any(|message| {
        message
            .get("attachments")
            .and_then(Value::as_array)
            .is_some_and(|attachments| {
                attachments
                    .iter()
                    .any(|attachment| attachment.get("content").and_then(Value::as_str).is_some())
            })
    });
    if !has_inline_attachments {
        return Ok(());
    }

    let run_key = attachment_run_key(spec)?;
    let relative_dir = format!("{ATTACHMENTS_ROOT}/{run_key}");
    let absolute_dir = workspace_root
        .join(".tinybot")
        .join("attachments")
        .join(&run_key);
    std::fs::create_dir_all(&absolute_dir).map_err(|error| {
        format!(
            "failed to create turn attachment directory {}: {error}",
            absolute_dir.display()
        )
    })?;

    let materialize_result = (|| {
        let messages = spec
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "turn messages disappeared during attachment storage".to_string())?;
        let mut attachment_index = 0_usize;
        for message in messages {
            let Some(attachments) = message.get_mut("attachments").and_then(Value::as_array_mut)
            else {
                continue;
            };
            for attachment in attachments {
                let Some(object) = attachment.as_object_mut() else {
                    return Err("turn attachment must be a JSON object".to_string());
                };
                let Some(content) = object
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                let name = object
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("attachment.txt");
                let stored_name = format!("{attachment_index:02}-{}", safe_attachment_name(name));
                let absolute_path = absolute_dir.join(&stored_name);
                std::fs::write(&absolute_path, content.as_bytes()).map_err(|error| {
                    format!(
                        "failed to write turn attachment {}: {error}",
                        absolute_path.display()
                    )
                })?;
                object.remove("content");
                object.insert(
                    "path".to_string(),
                    Value::String(format!("{relative_dir}/{stored_name}")),
                );
                object.insert(
                    "sizeBytes".to_string(),
                    Value::Number(serde_json::Number::from(content.len() as u64)),
                );
                attachment_index += 1;
            }
        }
        Ok(())
    })();
    if materialize_result.is_err() {
        let _ = std::fs::remove_dir_all(&absolute_dir);
    }
    materialize_result
}

pub(crate) struct TurnAttachmentLease {
    directory: Option<PathBuf>,
}

impl TurnAttachmentLease {
    pub(crate) fn for_spec(spec: &Value, workspace_root: &Path) -> Self {
        let directory = spec
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|message| {
                message
                    .get("attachments")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .any(|attachment| attachment.get("path").and_then(Value::as_str).is_some())
            .then(|| {
                attachment_run_key(spec).ok().map(|run_key| {
                    workspace_root
                        .join(".tinybot")
                        .join("attachments")
                        .join(run_key)
                })
            })
            .flatten();
        Self { directory }
    }

    pub(crate) fn preserve(&mut self) {
        self.directory = None;
    }
}

impl Drop for TurnAttachmentLease {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

pub(crate) fn cleanup_turn_attachments(spec: &Value, workspace_root: &Path) {
    drop(TurnAttachmentLease::for_spec(spec, workspace_root));
}

pub(crate) fn turn_result_needs_attachment_files(result: &Value) -> bool {
    matches!(
        result.get("stopReason").and_then(Value::as_str),
        Some(
            "awaiting_approval"
                | "awaiting_form"
                | "awaiting_tool"
                | "tool_running"
                | "awaiting_subagent"
        )
    )
}

fn attachment_run_key(spec: &Value) -> Result<String, String> {
    let session_id = string_field(
        spec,
        &["sessionId", "session_id", "sessionKey", "session_key"],
    )
    .ok_or_else(|| "turn attachments require a session id".to_string())?;
    let run_id = string_field(spec, &["runId", "run_id"])
        .ok_or_else(|| "turn attachments require a run id".to_string())?;
    let digest = Sha256::digest(format!("{session_id}\0{run_id}").as_bytes());
    Ok(format!("{:x}", digest)[..24].to_string())
}

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn safe_attachment_name(name: &str) -> String {
    let normalized = name.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or_default();
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim_matches('.');
    if sanitized.is_empty() {
        "attachment.txt".to_string()
    } else {
        sanitized.chars().take(180).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{cleanup_turn_attachments, materialize_turn_attachments};
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_workspace::WorkerWorkspaceRpc;

    #[test]
    fn materializes_attachment_content_as_workspace_file_and_keeps_only_metadata() {
        let root =
            std::env::temp_dir().join(format!("tinybot-turn-attachment-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temporary workspace should exist");
        let mut spec = serde_json::json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "messages": [{
                "role": "user",
                "content": "Review it",
                "attachments": [{
                    "type": "text",
                    "name": "../notes.md",
                    "mimeType": "text/markdown",
                    "sizeBytes": 7,
                    "content": "# Notes"
                }]
            }]
        });

        materialize_turn_attachments(&mut spec, &root).expect("attachment should materialize");

        let attachment = &spec["messages"][0]["attachments"][0];
        assert!(attachment.get("content").is_none());
        let relative_path = attachment["path"]
            .as_str()
            .expect("materialized attachment should have a path");
        assert!(relative_path.starts_with(".tinybot/attachments/"));
        assert!(relative_path.ends_with("/00-notes.md"));
        let workspace = WorkerWorkspaceRpc::new(
            root.clone(),
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        assert_eq!(
            workspace
                .read_file(relative_path)
                .expect("workspace.read_file should read the materialized attachment")
                .contents,
            "# Notes"
        );

        cleanup_turn_attachments(&spec, &root);
        assert!(!root.join(relative_path).exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
