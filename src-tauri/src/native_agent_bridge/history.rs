use crate::call_rust_state_service;
use crate::native_agent_bridge::{
    native_agent_session_id, native_agent_string_field, native_agent_usage,
};
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
        vec![serde_json::json!({
            "role": input
                .get("role")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("user"),
            "content": content,
        })]
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

pub(crate) fn native_agent_message_id(message: &serde_json::Value) -> Option<String> {
    message
        .get("messageId")
        .or_else(|| message.get("message_id"))
        .or_else(|| message.get("id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(crate) fn native_agent_assistant_messages(
    result: &serde_json::Value,
) -> Vec<serde_json::Value> {
    result
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter(|message| {
                    message.get("role").and_then(serde_json::Value::as_str) == Some("assistant")
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn attach_native_agent_latest_usage(
    messages: &mut [serde_json::Value],
    result: &serde_json::Value,
) {
    let Some(usage) = native_agent_usage(result).into_iter().last() else {
        return;
    };
    let Some(message) = messages.iter_mut().rev().find(|message| {
        message.get("role").and_then(serde_json::Value::as_str) == Some("assistant")
    }) else {
        return;
    };
    let Some(object) = message.as_object_mut() else {
        return;
    };
    if !object.get("usage").is_some_and(|value| !value.is_null()) {
        object.insert("usage".to_string(), usage);
    }
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
    let history_messages =
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
) -> Result<Vec<serde_json::Value>, String> {
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
    Ok(history
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default())
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
    } else {
        combined.extend(history_body);
        combined.extend(requested_body);
    }
    combined
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
