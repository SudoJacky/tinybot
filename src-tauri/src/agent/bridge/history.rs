use crate::threads::workspace_store::WorkspaceThreadStore;

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

pub(crate) fn hydrate_native_agent_memory_snapshot_for_runtime(
    request: &mut super::turn_request::AgentTurnRequest,
    thread_store: &WorkspaceThreadStore,
) -> Result<(), crate::agent::runtime::AgentError> {
    use crate::agent::runtime::AgentError;
    let thread_id = request
        .input
        .trace_context
        .thread_id
        .as_deref()
        .unwrap_or(&request.input.session_id);
    let operation = thread_store
        .begin_operation()
        .map_err(|error| AgentError::persistence("open Thread memory snapshot", error))?;
    if let Some(snapshot) = operation
        .thread_log()
        .get_thread_memory_snapshot(thread_id)
        .map_err(|error| AgentError::persistence("read Thread memory snapshot", error))?
    {
        request.instructions.memory_snapshot = Some(snapshot);
    }
    Ok(())
}

pub(crate) fn hydrate_native_agent_history_for_runtime(
    input: &mut crate::agent::runtime::AgentTurnInput,
    thread_store: &WorkspaceThreadStore,
) -> Result<(), crate::agent::runtime::AgentError> {
    use crate::threads::rollout::format::SessionApiMode;
    let history = thread_store
        .agent_history(&input.session_id, 500)
        .map_err(|error| {
            crate::agent::runtime::AgentError::persistence("native agent context hydration", error)
        })?;
    let (api_mode, messages, mut response_items, checkpoint) = match history {
        Some(history) => (
            history.api_mode,
            history.messages,
            history.response_items,
            history.context_checkpoint,
        ),
        None => (
            SessionApiMode::ChatCompletions,
            Vec::new(),
            Vec::new(),
            None,
        ),
    };
    if input.controls.manual_compaction && !messages.is_empty() {
        input.messages = messages;
    } else if !input.messages.is_empty() && !messages.is_empty() {
        input.messages = native_agent_merge_history_messages(&messages, &input.messages);
    }
    input.api_mode = Some(
        match api_mode {
            SessionApiMode::ChatCompletions => "chat_completions",
            SessionApiMode::Responses => "responses",
        }
        .into(),
    );
    input.responses_input_items = match api_mode {
        SessionApiMode::ChatCompletions => None,
        SessionApiMode::Responses => {
            let has_current_user = response_items.iter().any(|item| {
                item.get("role").and_then(serde_json::Value::as_str) == Some("user")
                    && item
                        .get("turnId")
                        .or_else(|| item.get("turn_id"))
                        .and_then(serde_json::Value::as_str)
                        == Some(&input.trace_context.turn_id)
            });
            if !has_current_user {
                if let Some(user) = input.messages.iter().rev().find(|message| {
                    message.get("role").and_then(serde_json::Value::as_str) == Some("user")
                }) {
                    let mut user = user.clone();
                    user["turnId"] = input.trace_context.turn_id.clone().into();
                    response_items.push(user);
                }
            }
            Some(response_items)
        }
    };
    if let Some(source) = checkpoint
        .as_ref()
        .and_then(crate::threads::rollout::checkpoint_lineage::checkpoint_lineage_metadata)
    {
        input.metadata["contextSourceCheckpointId"] = source["contextId"].clone();
        input.metadata["contextSourceCheckpoint"] = source;
    }
    Ok(())
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
