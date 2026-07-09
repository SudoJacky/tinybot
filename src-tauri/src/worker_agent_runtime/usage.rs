use super::{
    agent_provider_config, bool_field, chat_completion_content, string_field, NativeAgentRunContext,
};
use serde_json::Value;

const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS: i64 = 128_000;
const DEFAULT_COMPACT_TRIGGER_PERCENT: i64 = 90;
const DEFAULT_COMPACT_SUMMARY_MAX_TOKENS: i64 = 1024;
const APPROX_BYTES_PER_TOKEN: usize = 4;

#[derive(Clone, Debug)]
pub(super) struct ContextWindowProjection {
    pub(super) messages: Vec<Value>,
    pub(super) action: Option<ContextWindowAction>,
}

#[derive(Clone, Debug)]
pub(super) struct ContextWindowAction {
    pub(super) event_name: &'static str,
    strategy: &'static str,
    dropped_message_count: usize,
    retained_message_count: usize,
    replacement_message_count: usize,
    context_window_tokens: i64,
    estimated_tokens_before: i64,
    estimated_tokens_after: i64,
}

#[derive(Clone, Debug)]
struct CompactedContextMessages {
    messages: Vec<Value>,
    old_count: usize,
    recent_count: usize,
}

pub(super) fn context_window_messages(context: &NativeAgentRunContext) -> Vec<Value> {
    if bool_field(&context.spec, "_contextWindowProjected") {
        return context.messages.clone();
    }
    context_window_projection(context).messages
}

pub(super) fn context_window_projection(
    context: &NativeAgentRunContext,
) -> ContextWindowProjection {
    let context_window_tokens = effective_context_window_tokens(context);
    let full_estimate = estimate_messages_tokens(&context.messages);
    if context_window_strategy(context) == "compact"
        && compact_threshold_reached(context, full_estimate, context_window_tokens)
    {
        if let Some(compacted) = compact_messages_to_context_window(context, context_window_tokens)
        {
            let estimated_tokens_after = estimate_messages_tokens(&compacted.messages);
            let replacement_message_count = compacted.messages.len();
            return ContextWindowProjection {
                messages: compacted.messages,
                action: Some(ContextWindowAction {
                    event_name: "agent.context.compacted",
                    strategy: "compact",
                    dropped_message_count: compacted.old_count,
                    retained_message_count: compacted.recent_count,
                    replacement_message_count,
                    context_window_tokens,
                    estimated_tokens_before: full_estimate,
                    estimated_tokens_after,
                }),
            };
        }
    }

    if full_estimate <= context_window_tokens {
        return ContextWindowProjection {
            messages: context.messages.clone(),
            action: None,
        };
    }

    let messages = trim_messages_to_context_window(&context.messages, context_window_tokens);
    let dropped_message_count = context.messages.len().saturating_sub(messages.len());
    let retained_message_count = messages.len();
    let estimated_tokens_after = estimate_messages_tokens(&messages);
    ContextWindowProjection {
        messages,
        action: (dropped_message_count > 0).then_some(ContextWindowAction {
            event_name: "agent.context.trimmed",
            strategy: "discard",
            dropped_message_count,
            retained_message_count,
            replacement_message_count: retained_message_count,
            context_window_tokens,
            estimated_tokens_before: full_estimate,
            estimated_tokens_after,
        }),
    }
}

pub(super) fn context_window_action_payload(
    context: &NativeAgentRunContext,
    iteration: i64,
    action: &ContextWindowAction,
) -> Value {
    serde_json::json!({
        "runId": context.run_id,
        "sessionId": context.session_id,
        "iteration": iteration,
        "strategy": action.strategy,
        "droppedMessageCount": action.dropped_message_count,
        "retainedMessageCount": action.retained_message_count,
        "replacementMessageCount": action.replacement_message_count,
        "contextWindowTokens": action.context_window_tokens,
        "estimatedTokensBefore": action.estimated_tokens_before,
        "estimatedTokensAfter": action.estimated_tokens_after,
    })
}

pub(super) fn context_with_projected_messages(
    context: &NativeAgentRunContext,
    messages: Vec<Value>,
) -> NativeAgentRunContext {
    let mut projected = context.clone();
    projected.messages = messages.clone();
    projected.spec["messages"] = Value::Array(messages);
    projected.spec["_contextWindowProjected"] = Value::Bool(true);
    projected
}

pub(super) fn estimate_context_tokens_for_request(context: &NativeAgentRunContext) -> i64 {
    context_window_messages(context)
        .iter()
        .map(estimate_message_tokens)
        .fold(0i64, i64::saturating_add)
}

pub(super) fn enrich_usage_with_context_window(
    context: &NativeAgentRunContext,
    usage: Value,
    estimated_context_tokens: i64,
    cumulative_usage_tokens_before: i64,
) -> Value {
    let mut usage = match usage {
        Value::Object(map) => Value::Object(map),
        other => serde_json::json!({ "raw": other }),
    };
    normalize_provider_usage_fields(&mut usage);
    let context_window_tokens = effective_context_window_tokens(context);
    let usage_source = if usage_context_used_tokens(&usage).is_some() {
        "provider_usage"
    } else {
        "local_estimator"
    };
    let used_tokens = usage_context_used_tokens(&usage).unwrap_or(estimated_context_tokens);
    let cumulative_usage_tokens = cumulative_usage_tokens_before.saturating_add(used_tokens);
    let remaining_tokens = context_window_tokens.saturating_sub(used_tokens).max(0);
    let percent = if context_window_tokens > 0 {
        ((used_tokens as f64 / context_window_tokens as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    usage["context_window_strategy"] = serde_json::json!(context_window_strategy(context));
    usage["contextWindowStrategy"] = serde_json::json!(context_window_strategy(context));
    usage["context_window_tokens"] = serde_json::json!(context_window_tokens);
    usage["contextWindowTokens"] = serde_json::json!(context_window_tokens);
    usage["context_window_used_tokens"] = serde_json::json!(used_tokens);
    usage["contextWindowUsedTokens"] = serde_json::json!(used_tokens);
    usage["context_usage_tokens"] = serde_json::json!(used_tokens);
    usage["contextUsageTokens"] = serde_json::json!(used_tokens);
    usage["cumulative_usage_tokens"] = serde_json::json!(cumulative_usage_tokens);
    usage["cumulativeUsageTokens"] = serde_json::json!(cumulative_usage_tokens);
    usage["token_usage_source"] = serde_json::json!(usage_source);
    usage["tokenUsageSource"] = serde_json::json!(usage_source);
    usage["context_window_remaining_tokens"] = serde_json::json!(remaining_tokens);
    usage["contextWindowRemainingTokens"] = serde_json::json!(remaining_tokens);
    usage["estimated_context_tokens"] = serde_json::json!(estimated_context_tokens);
    usage["estimatedContextTokens"] = serde_json::json!(estimated_context_tokens);
    usage["percent"] = serde_json::json!(percent);
    usage
}

pub(super) fn usage_context_used_tokens(usage: &Value) -> Option<i64> {
    [
        "total_tokens",
        "totalTokens",
        "context_usage_tokens",
        "contextUsageTokens",
        "total",
        "prompt_tokens",
        "promptTokens",
    ]
    .iter()
    .find_map(|key| positive_i64_field(usage, key))
}

pub(super) fn latest_cumulative_usage_tokens(usages: &[Value]) -> Option<i64> {
    usages
        .iter()
        .rev()
        .find_map(|usage| positive_i64_field(usage, "cumulative_usage_tokens"))
        .or_else(|| {
            usages
                .iter()
                .rev()
                .find_map(|usage| positive_i64_field(usage, "cumulativeUsageTokens"))
        })
}

fn effective_context_window_tokens(context: &NativeAgentRunContext) -> i64 {
    positive_i64_field(&context.spec, "contextWindowTokens")
        .or_else(|| positive_i64_field(&context.spec, "context_window_tokens"))
        .or_else(|| {
            context
                .config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| {
                    positive_i64_field(defaults, "contextWindowTokens")
                        .or_else(|| positive_i64_field(defaults, "context_window_tokens"))
                })
        })
        .unwrap_or(DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS)
}

fn context_window_strategy(context: &NativeAgentRunContext) -> String {
    string_config_field(context, "contextWindowStrategy")
        .or_else(|| string_config_field(context, "context_window_strategy"))
        .map(|strategy| strategy.to_ascii_lowercase())
        .filter(|strategy| strategy == "compact")
        .unwrap_or_else(|| "discard".to_string())
}

fn compact_trigger_percent(context: &NativeAgentRunContext) -> i64 {
    positive_i64_field(&context.spec, "compactTriggerPercent")
        .or_else(|| positive_i64_field(&context.spec, "compact_trigger_percent"))
        .or_else(|| {
            context
                .config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| {
                    positive_i64_field(defaults, "compactTriggerPercent")
                        .or_else(|| positive_i64_field(defaults, "compact_trigger_percent"))
                })
        })
        .unwrap_or(DEFAULT_COMPACT_TRIGGER_PERCENT)
        .clamp(1, 100)
}

fn compact_summary_max_tokens(context: &NativeAgentRunContext) -> i64 {
    positive_i64_field(&context.spec, "compactSummaryMaxTokens")
        .or_else(|| positive_i64_field(&context.spec, "compact_summary_max_tokens"))
        .or_else(|| {
            context
                .config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| {
                    positive_i64_field(defaults, "compactSummaryMaxTokens")
                        .or_else(|| positive_i64_field(defaults, "compact_summary_max_tokens"))
                })
        })
        .unwrap_or(DEFAULT_COMPACT_SUMMARY_MAX_TOKENS)
}

fn string_config_field(context: &NativeAgentRunContext, key: &str) -> Option<String> {
    string_field(&context.spec, key).or_else(|| {
        context
            .config_snapshot
            .get("agents")
            .and_then(|agents| agents.get("defaults"))
            .and_then(|defaults| string_field(defaults, key))
    })
}

fn compact_threshold_reached(
    context: &NativeAgentRunContext,
    full_estimate: i64,
    context_window_tokens: i64,
) -> bool {
    let threshold = context_window_tokens.saturating_mul(compact_trigger_percent(context)) / 100;
    full_estimate >= threshold.max(1)
}

fn positive_i64_field(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(value_as_i64)
        .filter(|number| *number > 0)
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
}

fn trim_messages_to_context_window(messages: &[Value], context_window_tokens: i64) -> Vec<Value> {
    if messages.is_empty() {
        return Vec::new();
    }
    let budget = context_window_tokens.max(1);
    let mut selected = Vec::new();
    let mut used_tokens = 0i64;

    for message in messages.iter().rev() {
        let message_tokens = estimate_message_tokens(message);
        if selected.is_empty() || used_tokens.saturating_add(message_tokens) <= budget {
            selected.push(message.clone());
            used_tokens = used_tokens.saturating_add(message_tokens);
        } else {
            break;
        }
    }

    selected.reverse();
    selected
}

fn compact_messages_to_context_window(
    context: &NativeAgentRunContext,
    context_window_tokens: i64,
) -> Option<CompactedContextMessages> {
    let recent_budget = (context_window_tokens.saturating_mul(2) / 3).max(1);
    let recent_messages = trim_messages_to_context_window(&context.messages, recent_budget);
    let recent_count = recent_messages.len();
    let old_count = context.messages.len().saturating_sub(recent_messages.len());
    if old_count == 0 {
        return None;
    }
    let old_messages = &context.messages[..old_count];
    let summary = compact_old_messages(context, old_messages).ok()?;
    if summary.trim().is_empty() {
        return None;
    }

    let mut compacted = vec![serde_json::json!({
        "role": "system",
        "content": format!("Conversation summary so far:\n{}", summary.trim()),
    })];
    compacted.extend(recent_messages);
    Some(CompactedContextMessages {
        messages: trim_messages_to_context_window(&compacted, context_window_tokens),
        old_count,
        recent_count,
    })
}

fn compact_old_messages(
    context: &NativeAgentRunContext,
    messages: &[Value],
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": context.model,
        "stream": false,
        "max_completion_tokens": compact_summary_max_tokens(context),
        "messages": [
            {
                "role": "system",
                "content": "Summarize earlier conversation context for a coding agent. Preserve user goals, decisions, constraints, file paths, commands, tool results, and unresolved tasks. Be concise and factual."
            },
            {
                "role": "user",
                "content": format!(
                    "Summarize these earlier messages so the next model call can continue without the full transcript:\n{}",
                    serde_json::to_string(messages).unwrap_or_else(|_| "[]".to_string())
                )
            }
        ]
    });
    let provider_config = agent_provider_config(context);
    let completion =
        crate::native_provider_runtime::complete_chat_for_agent(&provider_config, &body)?;
    Ok(chat_completion_content(&completion))
}

fn estimate_messages_tokens(messages: &[Value]) -> i64 {
    messages
        .iter()
        .map(estimate_message_tokens)
        .fold(0i64, i64::saturating_add)
}

fn estimate_message_tokens(message: &Value) -> i64 {
    let text = serde_json::to_string(message).unwrap_or_default();
    let tokens = (text
        .len()
        .saturating_add(APPROX_BYTES_PER_TOKEN.saturating_sub(1)))
        / APPROX_BYTES_PER_TOKEN;
    i64::try_from(tokens.max(1)).unwrap_or(i64::MAX)
}

fn normalize_provider_usage_fields(usage: &mut Value) {
    copy_usage_number(usage, "prompt_tokens", "promptTokens");
    copy_usage_number(usage, "completion_tokens", "completionTokens");
    copy_usage_number(usage, "total_tokens", "totalTokens");
}

fn copy_usage_number(usage: &mut Value, snake_key: &str, camel_key: &str) {
    if usage.get(camel_key).is_some() {
        return;
    }
    let Some(value) = usage.get(snake_key).cloned() else {
        return;
    };
    if value.is_number() {
        usage[camel_key] = value;
    }
}
