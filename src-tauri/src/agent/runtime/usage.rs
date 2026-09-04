use super::context_window_config::resolve_context_window_tokens;
use super::{
    agent_provider_config, bool_field, chat_completion_content, AgentTurnContext,
    NativeAgentProviderFailure,
};
use super::{
    chat_completions_adapter::ChatCompletionsAdapter, provider_protocol::ProviderProtocolAdapter,
    responses_adapter::ResponsesAdapter,
};
use crate::agent::runtime_protocol::AgentEventKind;
use crate::threads::rollout::format::TokenUsage;
use serde_json::Value;
use std::sync::Arc;

const DEFAULT_COMPACT_TRIGGER_PERCENT: i64 = 90;
const DEFAULT_COMPACT_SUMMARY_MAX_TOKENS: i64 = 1024;
const COMPACT_USER_MESSAGE_MAX_TOKENS: i64 = 20_000;
const COMPACT_USER_MESSAGE_BUDGET_PERCENT: i64 = 25;
const APPROX_BYTES_PER_TOKEN: usize = 4;
const MAX_COMPACT_TOOL_OUTPUT_CHARS: usize = 16_000;
const MIN_COMPACT_TOOL_OUTPUT_CHARS: usize = 64;
const MAX_COMPACTION_SUMMARY_LAYERS: usize = 8;
const COMPACTION_REQUEST_LIMIT_PERCENT: i64 = 95;
const COMPACTION_SUMMARY_PREFIX: &str = "Conversation summary so far:\n";
const SOURCE_SUMMARY_INSTRUCTION: &str = "User messages are retained separately. Summarize assistant and tool work: decisions, constraints, files, commands, results, errors, tests, and next steps. Be concise and factual.";
const MERGE_SUMMARY_INSTRUCTION: &str = "Merge partial coding-agent conversation summaries into one concise, factual continuation summary. Preserve goals, decisions, constraints, paths, tool results, progress, and unresolved tasks without duplicating facts.";

#[derive(Clone, Debug)]
pub(super) struct ContextWindowProjection {
    pub(super) messages: Vec<Value>,
    pub(super) action: Option<ContextWindowAction>,
}

#[derive(Clone, Debug)]
pub(super) struct ContextWindowAction {
    pub(super) event_kind: AgentEventKind,
    strategy: &'static str,
    trigger: &'static str,
    reason: &'static str,
    phase: &'static str,
    dropped_message_count: usize,
    retained_message_count: usize,
    replacement_message_count: usize,
    context_window_tokens: i64,
    estimated_tokens_before: i64,
    estimated_tokens_after: i64,
    masked_tool_output_count: usize,
    summary_request_count: usize,
    preserved_user_message_count: usize,
    dropped_user_message_count: usize,
    dropped_assistant_message_count: usize,
    dropped_tool_message_count: usize,
    merged_compaction_summary_count: usize,
}

#[derive(Clone, Debug)]
struct CompactedContextMessages {
    messages: Vec<Value>,
    dropped_count: usize,
    retained_count: usize,
    masked_tool_output_count: usize,
    summary_request_count: usize,
    preserved_user_message_count: usize,
    dropped_user_message_count: usize,
    dropped_assistant_message_count: usize,
    dropped_tool_message_count: usize,
    merged_compaction_summary_count: usize,
}

#[derive(Clone, Debug)]
struct CompactionSummary {
    content: String,
    request_count: usize,
}

#[cfg(test)]
pub(super) fn context_window_messages(context: &AgentTurnContext) -> Result<Vec<Value>, String> {
    if bool_field(&context.spec, "_contextWindowProjected") {
        return Ok(context.messages.clone());
    }
    context_window_projection(context).map(|projection| projection.messages)
}

pub(super) async fn context_window_messages_async(
    context: &AgentTurnContext,
) -> Result<Vec<Value>, NativeAgentProviderFailure> {
    if bool_field(&context.spec, "_contextWindowProjected") {
        return Ok(context.messages.clone());
    }
    context_window_projection_async(context)
        .await
        .map(|projection| projection.messages)
}

#[cfg(test)]
pub(super) fn context_window_projection(
    context: &AgentTurnContext,
) -> Result<ContextWindowProjection, String> {
    tauri::async_runtime::block_on(context_window_projection_async(context))
        .map_err(|error| error.to_string())
}

pub(super) async fn context_window_projection_async(
    context: &AgentTurnContext,
) -> Result<ContextWindowProjection, NativeAgentProviderFailure> {
    let context_window_tokens = resolve_context_window_tokens(context);
    let fixed_request_tokens =
        estimate_fixed_request_tokens(context).map_err(NativeAgentProviderFailure::provider)?;
    let message_budget = context_window_tokens
        .saturating_sub(fixed_request_tokens)
        .max(1);
    let full_estimate = estimate_context_tokens_for_request(context)
        .map_err(NativeAgentProviderFailure::provider)?;
    let manual_compaction = manual_context_compaction_requested(&context.spec);
    let automatic_compaction = context_window_strategy(context) == "compact"
        && compact_threshold_reached(context, full_estimate, context_window_tokens);
    if manual_compaction || automatic_compaction {
        if let Some(compacted) =
            compact_messages_to_context_window_async(context, message_budget).await?
        {
            let estimated_tokens_after =
                estimate_context_tokens_for_messages(context, compacted.messages.clone())
                    .map_err(NativeAgentProviderFailure::provider)?;
            let replacement_message_count = compacted.messages.len();
            return Ok(ContextWindowProjection {
                messages: compacted.messages,
                action: Some(ContextWindowAction {
                    event_kind: AgentEventKind::ContextCompacted,
                    strategy: "compact",
                    trigger: if manual_compaction { "manual" } else { "auto" },
                    reason: if manual_compaction {
                        "user_requested"
                    } else {
                        "context_limit"
                    },
                    phase: if manual_compaction {
                        "standalone_turn"
                    } else {
                        "pre_turn"
                    },
                    dropped_message_count: compacted.dropped_count,
                    retained_message_count: compacted.retained_count,
                    replacement_message_count,
                    context_window_tokens,
                    estimated_tokens_before: full_estimate,
                    estimated_tokens_after,
                    masked_tool_output_count: compacted.masked_tool_output_count,
                    summary_request_count: compacted.summary_request_count,
                    preserved_user_message_count: compacted.preserved_user_message_count,
                    dropped_user_message_count: compacted.dropped_user_message_count,
                    dropped_assistant_message_count: compacted.dropped_assistant_message_count,
                    dropped_tool_message_count: compacted.dropped_tool_message_count,
                    merged_compaction_summary_count: compacted.merged_compaction_summary_count,
                }),
            });
        }
        if manual_compaction {
            return Ok(ContextWindowProjection {
                messages: context.messages.clone(),
                action: None,
            });
        }
    }

    if full_estimate <= context_window_tokens {
        return Ok(ContextWindowProjection {
            messages: context.messages.clone(),
            action: None,
        });
    }

    let (bounded_messages, masked_tool_output_count) = mask_oversized_tool_outputs(
        &context.messages,
        compact_tool_output_char_limit(message_budget),
    );
    let messages = trim_messages_to_context_window(&bounded_messages, message_budget);
    let dropped_message_count = context.messages.len().saturating_sub(messages.len());
    let retained_message_count = messages.len();
    let estimated_tokens_after = estimate_context_tokens_for_messages(context, messages.clone())
        .map_err(NativeAgentProviderFailure::provider)?;
    Ok(ContextWindowProjection {
        messages,
        action: (dropped_message_count > 0).then_some(ContextWindowAction {
            event_kind: AgentEventKind::ContextTrimmed,
            strategy: "discard",
            trigger: "auto",
            reason: "context_limit",
            phase: "pre_turn",
            dropped_message_count,
            retained_message_count,
            replacement_message_count: retained_message_count,
            context_window_tokens,
            estimated_tokens_before: full_estimate,
            estimated_tokens_after,
            masked_tool_output_count,
            summary_request_count: 0,
            preserved_user_message_count: 0,
            dropped_user_message_count: 0,
            dropped_assistant_message_count: 0,
            dropped_tool_message_count: 0,
            merged_compaction_summary_count: 0,
        }),
    })
}

pub(super) fn context_window_action_payload(
    context: &AgentTurnContext,
    iteration: i64,
    action: &ContextWindowAction,
) -> Value {
    let compacted = action.event_kind == AgentEventKind::ContextCompacted;
    serde_json::json!({
        "iteration": iteration,
        "contextId": compacted.then(|| format!("{}:context:{}", context.turn_id, iteration + 1)),
        "trigger": compacted.then_some(action.trigger),
        "reason": compacted.then_some(action.reason),
        "phase": compacted.then_some(if action.trigger == "manual" {
            action.phase
        } else if iteration == 0 {
            "pre_turn"
        } else {
            "mid_turn"
        }),
        "method": compacted.then_some("summary"),
        "provider": context.provider,
        "model": context.model,
        "strategy": action.strategy,
        "droppedMessageCount": action.dropped_message_count,
        "retainedMessageCount": action.retained_message_count,
        "replacementMessageCount": action.replacement_message_count,
        "contextWindowTokens": action.context_window_tokens,
        "estimatedTokensBefore": action.estimated_tokens_before,
        "estimatedTokensAfter": action.estimated_tokens_after,
        "maskedToolOutputCount": action.masked_tool_output_count,
        "summaryRequestCount": action.summary_request_count,
        "preservedUserMessageCount": action.preserved_user_message_count,
        "droppedUserMessageCount": action.dropped_user_message_count,
        "droppedAssistantMessageCount": action.dropped_assistant_message_count,
        "droppedToolMessageCount": action.dropped_tool_message_count,
        "mergedCompactionSummaryCount": action.merged_compaction_summary_count,
    })
}

pub(crate) fn manual_context_compaction_requested(spec: &Value) -> bool {
    spec.get("contextCompaction")
        .or_else(|| spec.get("context_compaction"))
        .and_then(|request| request.get("trigger"))
        .and_then(Value::as_str)
        == Some("manual")
}

pub(super) fn context_with_projected_messages(
    context: &AgentTurnContext,
    messages: Vec<Value>,
) -> AgentTurnContext {
    let mut projected = context.clone();
    projected.messages = messages.clone();
    projected.spec["messages"] = Value::Array(messages);
    projected.spec["_contextWindowProjected"] = Value::Bool(true);
    projected.prepared_provider_request = None;
    projected
}

pub(super) fn estimate_context_tokens_for_request(
    context: &AgentTurnContext,
) -> Result<i64, String> {
    prepare_provider_request(context).map(|(_, estimated_tokens)| estimated_tokens)
}

pub(super) fn prepare_provider_request(context: &AgentTurnContext) -> Result<(Value, i64), String> {
    let adapter = ProviderProtocolAdapter::for_runtime_request(context)?;
    let request = adapter.build_request_from_window(context, context.messages.clone())?;
    let estimated_tokens = estimate_message_tokens(&request);
    Ok((request, estimated_tokens))
}

fn estimate_context_tokens_for_messages(
    context: &AgentTurnContext,
    messages: Vec<Value>,
) -> Result<i64, String> {
    estimate_context_tokens_for_request(&context_with_projected_messages(context, messages))
}

pub(super) fn enrich_usage_with_context_window(
    context: &AgentTurnContext,
    provider_usage: Option<&TokenUsage>,
    estimated_context_tokens: i64,
    cumulative_usage_tokens_before: i64,
) -> Value {
    let mut usage = provider_usage
        .map(|usage| serde_json::to_value(usage).expect("TokenUsage must serialize"))
        .unwrap_or_else(|| serde_json::json!({}));
    let context_window_tokens = resolve_context_window_tokens(context);
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

    usage["contextWindowStrategy"] = serde_json::json!(context_window_strategy(context));
    usage["contextWindowTokens"] = serde_json::json!(context_window_tokens);
    usage["contextWindowUsedTokens"] = serde_json::json!(used_tokens);
    usage["contextUsageTokens"] = serde_json::json!(used_tokens);
    usage["cumulativeUsageTokens"] = serde_json::json!(cumulative_usage_tokens);
    usage["tokenUsageSource"] = serde_json::json!(usage_source);
    usage["contextWindowRemainingTokens"] = serde_json::json!(remaining_tokens);
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

fn context_window_strategy(context: &AgentTurnContext) -> String {
    context
        .settings
        .context_window_strategy
        .as_str()
        .to_string()
}

fn compact_trigger_percent(context: &AgentTurnContext) -> i64 {
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

fn compact_summary_max_tokens(context: &AgentTurnContext) -> i64 {
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

fn compact_threshold_reached(
    context: &AgentTurnContext,
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
    let units = context_message_units(messages);
    let mut selected = Vec::new();
    let mut used_tokens = 0i64;

    for unit in units.into_iter().rev() {
        let unit_tokens = estimate_messages_tokens(&unit);
        if selected.is_empty() || used_tokens.saturating_add(unit_tokens) <= budget {
            selected.push(unit);
            used_tokens = used_tokens.saturating_add(unit_tokens);
        } else {
            break;
        }
    }

    selected.reverse();
    selected.into_iter().flatten().collect()
}

fn context_message_units(messages: &[Value]) -> Vec<Vec<Value>> {
    let mut units = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        let message = &messages[index];
        let tool_call_ids = assistant_tool_call_ids(message);
        if message_role(message) == Some("assistant") && !tool_call_ids.is_empty() {
            let mut unit = vec![message.clone()];
            index += 1;
            while index < messages.len() && message_role(&messages[index]) == Some("tool") {
                let belongs_to_batch = tool_result_call_id(&messages[index])
                    .is_some_and(|tool_call_id| tool_call_ids.contains(&tool_call_id));
                if !belongs_to_batch {
                    break;
                }
                unit.push(messages[index].clone());
                index += 1;
            }
            units.push(unit);
            continue;
        }
        units.push(vec![message.clone()]);
        index += 1;
    }
    units
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn assistant_tool_call_ids(message: &Value) -> Vec<String> {
    message
        .get("tool_calls")
        .or_else(|| message.get("toolCalls"))
        .and_then(Value::as_array)
        .map(|tool_calls| {
            tool_calls
                .iter()
                .filter_map(|tool_call| tool_call.get("id").and_then(Value::as_str))
                .filter(|tool_call_id| !tool_call_id.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn tool_result_call_id(message: &Value) -> Option<String> {
    message
        .get("tool_call_id")
        .or_else(|| message.get("toolCallId"))
        .and_then(Value::as_str)
        .filter(|tool_call_id| !tool_call_id.trim().is_empty())
        .map(str::to_string)
}

fn compact_tool_output_char_limit(context_window_tokens: i64) -> usize {
    usize::try_from(context_window_tokens.max(1))
        .unwrap_or(usize::MAX)
        .clamp(MIN_COMPACT_TOOL_OUTPUT_CHARS, MAX_COMPACT_TOOL_OUTPUT_CHARS)
}

fn mask_oversized_tool_outputs(messages: &[Value], max_chars: usize) -> (Vec<Value>, usize) {
    let mut masked_count = 0;
    let messages = messages
        .iter()
        .map(|message| {
            let mut masked = message.clone();
            if message_role(message) != Some("tool") {
                return masked;
            }
            let Some(content) = message.get("content").and_then(Value::as_str) else {
                return masked;
            };
            if content.chars().count() <= max_chars {
                return masked;
            }
            masked["content"] = Value::String(mask_tool_output(content, max_chars));
            masked_count += 1;
            masked
        })
        .collect();
    (messages, masked_count)
}

fn mask_tool_output(content: &str, max_chars: usize) -> String {
    let marker = "\n[tool output compacted: middle omitted]\n";
    let available = max_chars.saturating_sub(marker.chars().count());
    let head_chars = available.saturating_mul(2) / 3;
    let tail_chars = available.saturating_sub(head_chars);
    let head = content.chars().take(head_chars).collect::<String>();
    let mut tail = content.chars().rev().take(tail_chars).collect::<Vec<_>>();
    tail.reverse();
    format!("{head}{marker}{}", tail.into_iter().collect::<String>())
}

async fn compact_messages_to_context_window_async(
    context: &AgentTurnContext,
    context_window_tokens: i64,
) -> Result<Option<CompactedContextMessages>, NativeAgentProviderFailure> {
    let (bounded_messages, masked_tool_output_count) = mask_oversized_tool_outputs(
        &context.messages,
        compact_tool_output_char_limit(context_window_tokens),
    );
    if bounded_messages.is_empty() {
        return Ok(None);
    }

    let instruction_messages = bounded_messages
        .iter()
        .filter(|message| {
            matches!(message_role(message), Some("system") | Some("developer"))
                && !is_context_compaction_summary(message)
        })
        .cloned()
        .collect::<Vec<_>>();
    let user_messages = bounded_messages
        .iter()
        .filter(|message| {
            message_role(message) == Some("user") && !is_context_compaction_summary(message)
        })
        .cloned()
        .collect::<Vec<_>>();
    let instruction_tokens = estimate_messages_tokens(&instruction_messages);
    let summary_reserve = effective_compact_summary_max_tokens(context).saturating_add(32);
    let user_budget = context_window_tokens
        .saturating_sub(instruction_tokens)
        .saturating_sub(summary_reserve)
        .min(
            context_window_tokens
                .saturating_mul(COMPACT_USER_MESSAGE_BUDGET_PERCENT)
                .saturating_div(100),
        )
        .min(COMPACT_USER_MESSAGE_MAX_TOKENS)
        .max(1);
    let selected_user_messages = trim_messages_to_context_window(&user_messages, user_budget);
    let compactable_message_count = bounded_messages
        .len()
        .saturating_sub(instruction_messages.len())
        .saturating_sub(user_messages.len());
    if compactable_message_count == 0 && selected_user_messages.len() == user_messages.len() {
        return Ok(None);
    }

    let dropped_user_source_count = user_messages
        .len()
        .saturating_sub(selected_user_messages.len());
    let mut seen_user_messages = 0usize;
    let summary_source_messages = bounded_messages
        .iter()
        .filter_map(|message| {
            if message_role(message) == Some("user") && !is_context_compaction_summary(message) {
                let include = seen_user_messages < dropped_user_source_count;
                seen_user_messages = seen_user_messages.saturating_add(1);
                return include.then(|| message.clone());
            }
            if matches!(message_role(message), Some("system") | Some("developer"))
                && !is_context_compaction_summary(message)
            {
                return None;
            }
            Some(message.clone())
        })
        .collect::<Vec<_>>();
    if summary_source_messages.is_empty() {
        return Ok(None);
    }
    let summary = compact_old_messages_async(context, &summary_source_messages).await?;
    if summary.content.trim().is_empty() {
        return Err(NativeAgentProviderFailure::provider(
            "context compaction produced an empty summary",
        ));
    }

    let merged_compaction_summary_count = bounded_messages
        .iter()
        .filter(|message| is_context_compaction_summary(message))
        .count();
    let dropped_assistant_message_count = bounded_messages
        .iter()
        .filter(|message| message_role(message) == Some("assistant"))
        .count();
    let dropped_tool_message_count = bounded_messages
        .iter()
        .filter(|message| message_role(message) == Some("tool"))
        .count();
    let mut compacted = instruction_messages;
    compacted.extend(selected_user_messages);
    compacted.push(serde_json::json!({
        "role": "assistant",
        "content": format!("{COMPACTION_SUMMARY_PREFIX}{}", summary.content.trim()),
        "contextCompaction": true,
    }));
    let messages = trim_messages_to_context_window(&compacted, context_window_tokens);
    let preserved_user_message_count = messages
        .iter()
        .filter(|message| {
            message_role(message) == Some("user") && !is_context_compaction_summary(message)
        })
        .count();
    let retained_instruction_count = messages
        .iter()
        .filter(|message| {
            matches!(message_role(message), Some("system") | Some("developer"))
                && !is_context_compaction_summary(message)
        })
        .count();
    let retained_count = retained_instruction_count.saturating_add(preserved_user_message_count);
    let dropped_count = bounded_messages.len().saturating_sub(retained_count);
    Ok(Some(CompactedContextMessages {
        messages,
        dropped_count,
        retained_count,
        masked_tool_output_count,
        summary_request_count: summary.request_count,
        preserved_user_message_count,
        dropped_user_message_count: user_messages
            .len()
            .saturating_sub(preserved_user_message_count),
        dropped_assistant_message_count,
        dropped_tool_message_count,
        merged_compaction_summary_count,
    }))
}

fn is_context_compaction_summary(message: &Value) -> bool {
    message
        .get("contextCompaction")
        .or_else(|| message.get("context_compaction"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || message
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|content| content.starts_with(COMPACTION_SUMMARY_PREFIX))
}

async fn compact_old_messages_async(
    context: &AgentTurnContext,
    messages: &[Value],
) -> Result<CompactionSummary, NativeAgentProviderFailure> {
    let mut summaries = summarize_compaction_layer(context, messages, false).await?;
    let mut request_count = summaries.len();
    let mut layer = 1;
    while summaries.len() > 1 {
        if layer >= MAX_COMPACTION_SUMMARY_LAYERS {
            return Err(NativeAgentProviderFailure::provider(format!(
                "context compaction summaries did not converge within {MAX_COMPACTION_SUMMARY_LAYERS} layers"
            )));
        }
        let merge_messages = summaries
            .iter()
            .enumerate()
            .map(|(index, summary)| {
                serde_json::json!({
                    "role": "user",
                    "content": format!("Partial summary {}:\n{}", index + 1, summary),
                })
            })
            .collect::<Vec<_>>();
        let merged = summarize_compaction_layer(context, &merge_messages, true).await?;
        if merged.len() >= summaries.len() {
            return Err(NativeAgentProviderFailure::provider(format!(
                "context compaction summary merge did not reduce {} partial summaries within the summary request budget",
                summaries.len()
            )));
        }
        request_count = request_count.saturating_add(merged.len());
        summaries = merged;
        layer += 1;
    }
    Ok(CompactionSummary {
        content: summaries.pop().unwrap_or_default(),
        request_count,
    })
}

async fn summarize_compaction_layer(
    context: &AgentTurnContext,
    messages: &[Value],
    merge: bool,
) -> Result<Vec<String>, NativeAgentProviderFailure> {
    let chunks = compaction_summary_chunks(context, messages, merge)?;
    let mut summaries = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        summaries.push(compact_messages_once_async(context, &chunk, merge).await?);
    }
    Ok(summaries)
}

fn compaction_summary_chunks(
    context: &AgentTurnContext,
    messages: &[Value],
    merge: bool,
) -> Result<Vec<Vec<Value>>, NativeAgentProviderFailure> {
    let units = context_message_units(messages);
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    for (unit_index, unit) in units.into_iter().enumerate() {
        let mut candidate = current.clone();
        candidate.extend(unit.clone());
        if compaction_summary_request_fits(context, &candidate, merge) {
            current = candidate;
            continue;
        }
        if current.is_empty() {
            return Err(oversized_compaction_unit_error(
                context, &unit, unit_index, merge,
            ));
        }
        chunks.push(current);
        if !compaction_summary_request_fits(context, &unit, merge) {
            return Err(oversized_compaction_unit_error(
                context, &unit, unit_index, merge,
            ));
        }
        current = unit;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

fn oversized_compaction_unit_error(
    context: &AgentTurnContext,
    unit: &[Value],
    unit_index: usize,
    merge: bool,
) -> NativeAgentProviderFailure {
    let request_tokens = estimate_messages_tokens(&compaction_summary_prompt_messages(unit, merge));
    NativeAgentProviderFailure::provider(format!(
        "context compaction single context unit {unit_index} requires approximately {request_tokens} input tokens and cannot fit the {} token summary request budget",
        compaction_summary_request_limit(context)
    ))
}

fn compaction_summary_request_fits(
    context: &AgentTurnContext,
    messages: &[Value],
    merge: bool,
) -> bool {
    estimate_messages_tokens(&compaction_summary_prompt_messages(messages, merge))
        .saturating_add(effective_compact_summary_max_tokens(context))
        <= compaction_summary_request_limit(context)
}

fn compaction_summary_request_limit(context: &AgentTurnContext) -> i64 {
    resolve_context_window_tokens(context)
        .saturating_mul(COMPACTION_REQUEST_LIMIT_PERCENT)
        .saturating_div(100)
        .max(1)
}

fn effective_compact_summary_max_tokens(context: &AgentTurnContext) -> i64 {
    compact_summary_max_tokens(context).min(
        resolve_context_window_tokens(context)
            .saturating_div(4)
            .max(1),
    )
}

fn compaction_summary_prompt_messages(messages: &[Value], merge: bool) -> Vec<Value> {
    let instruction = if merge {
        MERGE_SUMMARY_INSTRUCTION
    } else {
        SOURCE_SUMMARY_INSTRUCTION
    };
    let request = if merge {
        "Merge these partial summaries into one continuation summary"
    } else {
        "Summarize these earlier messages so the next model call can continue without the full transcript"
    };
    vec![
        serde_json::json!({ "role": "system", "content": instruction }),
        serde_json::json!({
            "role": "user",
            "content": format!(
                "{request}:\n{}",
                serde_json::to_string(messages).unwrap_or_else(|_| "[]".to_string())
            )
        }),
    ]
}

async fn compact_messages_once_async(
    context: &AgentTurnContext,
    messages: &[Value],
    merge: bool,
) -> Result<String, NativeAgentProviderFailure> {
    let body = serde_json::json!({
        "model": context.model,
        "stream": false,
        "max_completion_tokens": effective_compact_summary_max_tokens(context),
        "messages": compaction_summary_prompt_messages(messages, merge),
    });
    let provider_config = agent_provider_config(context);
    let cancellation = context.cancellation.clone().map(|cancellation| {
        Arc::new(cancellation) as Arc<dyn crate::protocol::WorkerRequestCancellation>
    });
    let mut observer = |_event: crate::agent::provider::NativeProviderStreamEvent| {};
    let completion = crate::agent::provider::complete_chat_for_agent_with_observer_async(
        &provider_config,
        &body,
        &mut observer,
        cancellation,
    )
    .await
    .map_err(|error| {
        NativeAgentProviderFailure::new(
            match error.kind() {
                crate::agent::provider::NativeProviderFailureKind::Cancelled => {
                    super::NativeAgentProviderFailureKind::Cancelled
                }
                crate::agent::provider::NativeProviderFailureKind::RequestTimeout => {
                    super::NativeAgentProviderFailureKind::RequestTimeout
                }
                crate::agent::provider::NativeProviderFailureKind::StreamIdleTimeout => {
                    super::NativeAgentProviderFailureKind::StreamIdleTimeout
                }
                crate::agent::provider::NativeProviderFailureKind::Transport => {
                    super::NativeAgentProviderFailureKind::Transport
                }
                crate::agent::provider::NativeProviderFailureKind::Provider => {
                    super::NativeAgentProviderFailureKind::Provider
                }
            },
            error.message(),
        )
    })?;
    chat_completion_content(&completion).map_err(NativeAgentProviderFailure::provider)
}

fn estimate_messages_tokens(messages: &[Value]) -> i64 {
    messages
        .iter()
        .map(estimate_message_tokens)
        .fold(0i64, i64::saturating_add)
}

fn estimate_system_prompt_tokens(context: &AgentTurnContext) -> i64 {
    context
        .system_instruction_prompt()
        .map(|content| {
            estimate_message_tokens(&serde_json::json!({
                "role": "system",
                "content": content,
            }))
        })
        .unwrap_or(0)
}

fn estimate_fixed_request_tokens(context: &AgentTurnContext) -> Result<i64, String> {
    let definitions = context.tool_router.tool_definitions()?;
    let encoded_tools = match ProviderProtocolAdapter::for_runtime_request(context)? {
        ProviderProtocolAdapter::ChatCompletions => {
            ChatCompletionsAdapter::encode_tools(&definitions)
        }
        ProviderProtocolAdapter::Responses => ResponsesAdapter::encode_tools(&definitions),
    };
    let tool_tokens = if encoded_tools.is_empty() {
        0
    } else {
        estimate_message_tokens(&Value::Array(encoded_tools))
    };
    Ok(estimate_system_prompt_tokens(context).saturating_add(tool_tokens))
}

fn estimate_message_tokens(message: &Value) -> i64 {
    let text = serde_json::to_string(message).unwrap_or_default();
    let tokens = (text
        .len()
        .saturating_add(APPROX_BYTES_PER_TOKEN.saturating_sub(1)))
        / APPROX_BYTES_PER_TOKEN;
    i64::try_from(tokens.max(1)).unwrap_or(i64::MAX)
}
