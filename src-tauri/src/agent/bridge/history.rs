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

/// Rollout already includes the admitted input. Hydration never merges client history.
pub(crate) fn hydrate_native_agent_history_for_runtime(
    input: &mut crate::agent::runtime::AgentTurnInput,
    thread_store: &WorkspaceThreadStore,
) -> Result<(), crate::agent::runtime::AgentError> {
    use crate::agent::runtime::{AgentError, AgentItem, AgentItemHistory};
    use crate::threads::rollout::format::SessionApiMode;
    let thread_id = input
        .trace_context
        .thread_id
        .as_deref()
        .unwrap_or(&input.session_id);
    let history = thread_store
        .agent_history(thread_id)
        .map_err(|error| AgentError::persistence("native agent context hydration", error))?
        .ok_or_else(|| {
            AgentError::invalid_input(format!(
                "admitted thread history is missing: thread={thread_id} turn={}",
                input.trace_context.turn_id
            ))
        })?;
    let checkpoint = history.context_checkpoint;
    let mut instructions = input.messages.clone();
    instructions
        .items
        .retain(|item| matches!(item, AgentItem::Instruction(_)));
    let mut messages = instructions.clone();
    messages
        .items
        .extend(AgentItemHistory::from_legacy_messages(&history.messages)?.items);
    let mut response_items = instructions.to_legacy_messages()?;
    response_items.extend(history.response_items);
    eprintln!(
        "agent_history_loaded thread_id={} turn_id={} messages={} response_items={} checkpoint={}",
        thread_id,
        input.trace_context.turn_id,
        messages.items.len(),
        response_items.len(),
        checkpoint
            .as_ref()
            .and_then(|value| value.get("contextId"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("none")
    );
    input.messages = messages;
    input.api_mode = Some(
        match history.api_mode {
            SessionApiMode::ChatCompletions => "chat_completions",
            SessionApiMode::Responses => "responses",
        }
        .into(),
    );
    input.responses_input_items = match history.api_mode {
        SessionApiMode::ChatCompletions => None,
        SessionApiMode::Responses => Some(response_items),
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
