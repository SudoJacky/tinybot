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
        input.messages = crate::agent::runtime::AgentItemHistory::from_legacy_messages(&messages)?;
    } else if !input.messages.is_empty() && !messages.is_empty() {
        input.messages = native_agent_merge_history_messages(
            &crate::agent::runtime::AgentItemHistory::from_legacy_messages(&messages)?,
            &input.messages,
        );
    }
    input.api_mode = Some(
        match api_mode {
            SessionApiMode::ChatCompletions => "chat_completions",
            SessionApiMode::Responses => "responses",
        }
        .into(),
    );
    input.responses_input_items =
        match api_mode {
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
                    if let Some(item) = input.messages.items.iter().rev().find(|item| {
                        matches!(item, crate::agent::runtime::AgentItem::UserMessage(_))
                    }) {
                        let mut user = item.to_legacy_message()?;
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
    history: &crate::agent::runtime::AgentItemHistory,
    requested: &crate::agent::runtime::AgentItemHistory,
) -> crate::agent::runtime::AgentItemHistory {
    use crate::agent::runtime::{AgentItem, AgentItemHistory};
    let is_instruction = |item: &&AgentItem| matches!(item, AgentItem::Instruction(_));
    let mut items: Vec<_> = requested
        .items
        .iter()
        .filter(is_instruction)
        .cloned()
        .collect();
    let requested: Vec<_> = requested
        .items
        .iter()
        .filter(|item| !is_instruction(item))
        .cloned()
        .collect();
    let history: Vec<_> = history
        .items
        .iter()
        .filter(|item| !is_instruction(item))
        .cloned()
        .collect();
    if !history.is_empty() && requested.starts_with(&history) {
        items.extend(requested);
    } else if !requested.is_empty()
        && history.len() >= requested.len()
        && history[history.len() - requested.len()..]
            .iter()
            .zip(&requested)
            .all(|(left, right)| logical_message_equal(left, right))
    {
        items.extend(history);
    } else {
        items.extend(history);
        items.extend(requested);
    }
    AgentItemHistory { items }
}

fn logical_message_equal(
    left: &crate::agent::runtime::AgentItem,
    right: &crate::agent::runtime::AgentItem,
) -> bool {
    use crate::agent::runtime::{AgentItem, AgentMessageContent};
    let text = AgentMessageContent::plain_text;
    match (left, right) {
        (AgentItem::UserMessage(a), AgentItem::UserMessage(b)) => {
            text(&a.content) == text(&b.content)
        }
        (AgentItem::AssistantMessage(a), AgentItem::AssistantMessage(b)) => {
            a.content.as_ref().map(text).unwrap_or_default()
                == b.content.as_ref().map(text).unwrap_or_default()
        }
        (AgentItem::ToolResult(a), AgentItem::ToolResult(b)) => {
            text(&a.content) == text(&b.content)
        }
        _ => left == right,
    }
}
