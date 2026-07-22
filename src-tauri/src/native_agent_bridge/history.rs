use crate::call_rust_state_service;
use crate::native_agent_bridge::{native_agent_session_id, native_agent_string_field};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use std::path::PathBuf;

pub(crate) fn native_agent_user_messages(spec: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(messages) = spec.get("messages").and_then(serde_json::Value::as_array) {
        return messages
            .iter()
            .filter(|message| {
                message.get("role").and_then(serde_json::Value::as_str) == Some("user")
            })
            .cloned()
            .collect();
    }
    let Some(input) = spec.get("input").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    let content = input
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if content.trim().is_empty() {
        Vec::new()
    } else {
        let mut message = serde_json::Value::Object(input.clone());
        message["role"] = serde_json::Value::String(
            input
                .get("role")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("user")
                .to_string(),
        );
        message["content"] = serde_json::Value::String(content.to_string());
        vec![message]
    }
}

pub(crate) fn native_agent_current_user_message(
    spec: &serde_json::Value,
) -> Option<serde_json::Value> {
    native_agent_user_messages(spec).into_iter().last()
}

pub(crate) fn native_agent_thread_id(spec: &serde_json::Value) -> Option<String> {
    native_agent_string_field(spec, "threadId")
        .or_else(|| native_agent_string_field(spec, "thread_id"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "threadId"))
        })
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "thread_id"))
        })
}

pub(crate) fn hydrate_native_agent_history_for_runtime(
    mut spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let Some(session_id) = native_agent_session_id(&spec) else {
        return Ok(spec);
    };
    let requested_messages = native_agent_runtime_messages(&spec);
    if requested_messages.is_empty() {
        return Ok(spec);
    }
    let (history_messages, source_checkpoint) =
        native_agent_session_history_messages(&session_id, workspace_root, config_snapshot)?;
    if history_messages.is_empty() {
        return Ok(spec);
    }

    let combined_messages =
        native_agent_merge_history_messages(&history_messages, &requested_messages);
    if let Some(object) = spec.as_object_mut() {
        object.insert(
            "messages".to_string(),
            serde_json::Value::Array(combined_messages),
        );
        if let Some(source_checkpoint) = source_checkpoint {
            let metadata = object
                .entry("metadata".to_string())
                .or_insert_with(|| serde_json::json!({}));
            if !metadata.is_object() {
                *metadata = serde_json::json!({});
            }
            metadata["contextSourceCheckpointId"] = source_checkpoint
                .get("contextId")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            metadata["contextSourceCheckpoint"] = source_checkpoint;
        }
    }
    Ok(spec)
}

fn native_agent_runtime_messages(spec: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(messages) = spec.get("messages").and_then(serde_json::Value::as_array) {
        if !messages.is_empty() {
            return messages.clone();
        }
    }
    native_agent_user_messages(spec)
}

fn native_agent_session_history_messages(
    session_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(Vec<serde_json::Value>, Option<serde_json::Value>), String> {
    let request_id = next_worker_request_correlation();
    let history = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-history-for-agent-run"),
            request_id.trace_id("session-history-for-agent-run"),
            "session.get_agent_context",
            serde_json::json!({ "session_id": session_id, "limit": 500 }),
        ),
        "native agent context hydration",
    )?;
    let messages = history
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_checkpoint = history
        .get("contextCheckpoint")
        .or_else(|| history.get("context_checkpoint"))
        .and_then(crate::context_checkpoint_lineage::checkpoint_lineage_metadata);
    Ok((messages, source_checkpoint))
}

fn native_agent_merge_history_messages(
    history_messages: &[serde_json::Value],
    requested_messages: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut combined = Vec::new();
    for message in requested_messages
        .iter()
        .filter(|message| native_agent_instruction_message(message))
    {
        combined.push(message.clone());
    }

    let requested_body: Vec<_> = requested_messages
        .iter()
        .filter(|message| !native_agent_instruction_message(message))
        .cloned()
        .collect();
    let history_body: Vec<_> = history_messages
        .iter()
        .filter(|message| !native_agent_instruction_message(message))
        .cloned()
        .collect();

    if native_agent_messages_start_with(&requested_body, &history_body) {
        combined.extend(requested_body);
    } else if native_agent_messages_end_with(&history_body, &requested_body) {
        combined.extend(history_body);
    } else {
        combined.extend(history_body);
        combined.extend(requested_body);
    }
    combined
}

fn native_agent_messages_end_with(
    messages: &[serde_json::Value],
    suffix: &[serde_json::Value],
) -> bool {
    !suffix.is_empty()
        && messages.len() >= suffix.len()
        && messages[messages.len() - suffix.len()..]
            .iter()
            .zip(suffix.iter())
            .all(|(message, suffix)| native_agent_logical_message_equal(message, suffix))
}

fn native_agent_logical_message_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    left.get("role") == right.get("role")
        && native_agent_message_text(left) == native_agent_message_text(right)
}

fn native_agent_message_text(message: &serde_json::Value) -> String {
    match message.get("content") {
        Some(serde_json::Value::String(content)) => content.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(serde_json::Value::as_str))
            })
            .collect(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(content) => content.to_string(),
    }
}

fn native_agent_instruction_message(message: &serde_json::Value) -> bool {
    matches!(
        message.get("role").and_then(serde_json::Value::as_str),
        Some("system" | "developer")
    )
}

fn native_agent_messages_start_with(
    messages: &[serde_json::Value],
    prefix: &[serde_json::Value],
) -> bool {
    !prefix.is_empty()
        && messages.len() >= prefix.len()
        && messages
            .iter()
            .zip(prefix.iter())
            .all(|(message, prefix)| message == prefix)
}
