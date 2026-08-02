use crate::threads::rollout::format::{
    RolloutReconstruction as ThreadReplay, SessionApiMode, TokenUsageInfo,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryProjection {
    pub thread_id: String,
    pub messages: Vec<Value>,
    pub api_mode: SessionApiMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub response_items: Vec<Value>,
    pub user_profile: Value,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_checkpoint: Option<Value>,
}

fn history_from_replay(
    thread_id: &str,
    replay: ThreadReplay,
    limit: usize,
) -> ThreadHistoryProjection {
    let mut messages = replay.messages;
    let mut response_items = replay.response_items;
    if limit == 0 {
        messages.clear();
        response_items.clear();
    } else if messages.len() > limit {
        let start = messages.len() - limit;
        messages = messages.split_off(start);
    }
    attach_usage(&mut messages, replay.token_usage_info.as_ref());
    ThreadHistoryProjection {
        thread_id: thread_id.to_string(),
        messages,
        api_mode: replay.api_mode,
        response_items,
        user_profile: if replay.user_profile.is_null() {
            json!({})
        } else {
            replay.user_profile
        },
        updated_at: replay.updated_at,
        context_checkpoint: replay.context_checkpoint,
    }
}

pub(super) fn thread_history_from_replay(
    thread_id: &str,
    mut replay: ThreadReplay,
    limit: usize,
) -> ThreadHistoryProjection {
    replay.messages.retain(is_visible_thread_message);
    replay.response_items.clear();
    history_from_replay(thread_id, replay, limit)
}

pub(super) fn thread_agent_context_from_replay(
    thread_id: &str,
    mut replay: ThreadReplay,
    limit: usize,
) -> ThreadHistoryProjection {
    replay
        .messages
        .retain(|message| !is_materialized_instruction(message));
    if replay.api_mode != SessionApiMode::Responses {
        replay.response_items.clear();
    } else {
        replay
            .response_items
            .retain(|item| !is_materialized_instruction(item));
    }
    history_from_replay(thread_id, replay, limit)
}

fn is_materialized_instruction(item: &Value) -> bool {
    matches!(
        item.get("role").and_then(Value::as_str),
        Some("system" | "developer")
    ) && item.get("contentHash").is_some()
}

fn is_visible_thread_message(message: &Value) -> bool {
    if matches!(
        message.get("role").and_then(Value::as_str),
        Some("system" | "developer")
    ) {
        return false;
    }
    if message
        .get("_progress")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || message.get("role").and_then(Value::as_str) == Some("tool")
    {
        return false;
    }
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return true;
    }
    let has_visible_content = message
        .get("content")
        .and_then(Value::as_str)
        .is_some_and(|content| !content.trim().is_empty());
    let has_tool_calls = message
        .get("toolCalls")
        .or_else(|| message.get("tool_calls"))
        .and_then(Value::as_array)
        .is_some_and(|tool_calls| !tool_calls.is_empty());
    has_visible_content || !has_tool_calls
}

fn attach_usage(messages: &mut [Value], token_usage_info: Option<&TokenUsageInfo>) {
    if messages.is_empty() {
        return;
    }
    let Some(token_usage_info) = token_usage_info else {
        return;
    };
    let target_index = messages
        .iter()
        .rev()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .map(|reverse_index| messages.len() - 1 - reverse_index)
        .unwrap_or_else(|| messages.len() - 1);
    let target = &mut messages[target_index];
    if target.get("tokenUsageInfo").is_none() {
        target["tokenUsageInfo"] = serde_json::to_value(token_usage_info)
            .expect("TokenUsageInfo serialization should not fail");
    }
    if target.get("usage").is_none() {
        target["usage"] = usage_from_token_usage_info(token_usage_info);
    }
}

fn usage_from_token_usage_info(info: &TokenUsageInfo) -> Value {
    let used_tokens = info.last_token_usage.total_tokens;
    let context_window = info.model_context_window;
    let remaining_tokens = context_window.map(|window| window.saturating_sub(used_tokens).max(0));
    let percent = context_window
        .filter(|window| *window > 0)
        .map(|window| ((used_tokens as f64 / window as f64) * 100.0).clamp(0.0, 100.0));
    json!({
        "cachedTokens": info.last_token_usage.cached_input_tokens,
        "completionTokens": info.last_token_usage.output_tokens,
        "contextWindowRemainingTokens": remaining_tokens,
        "contextWindowTokens": context_window,
        "contextWindowUsedTokens": used_tokens,
        "estimatedContextTokens": used_tokens,
        "promptTokens": info.last_token_usage.input_tokens,
        "reasoningOutputTokens": info.last_token_usage.reasoning_output_tokens,
        "totalTokens": used_tokens,
        "cumulativeUsageTokens": info.total_token_usage.total_tokens,
        "percent": percent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_context_reuses_current_instructions_without_replaying_materialized_ones() {
        let materialized_instruction = serde_json::json!({
            "role": "system",
            "content": "old instructions",
            "contentHash": "hash-old",
        });
        let user = serde_json::json!({ "role": "user", "content": "hello" });
        let replay = ThreadReplay {
            messages: vec![materialized_instruction.clone(), user.clone()],
            response_items: vec![materialized_instruction, user.clone()],
            api_mode: SessionApiMode::Responses,
            ..ThreadReplay::default()
        };

        let context = thread_agent_context_from_replay("thread-1", replay, 50);

        assert_eq!(context.messages, vec![user.clone()]);
        assert_eq!(context.response_items, vec![user]);
    }
}
