use super::{AgentItem, AgentItemHistory, AgentMessageContent};
use crate::threads::rollout::format::{TokenUsage, TokenUsageInfo};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default)]
pub(super) struct ContextManager {
    items: Vec<AgentItem>,
    history_version: u64,
    token_info: Option<TokenUsageInfo>,
}

impl ContextManager {
    pub(super) fn from_legacy_messages(messages: &[Value]) -> Result<Self, String> {
        Ok(Self {
            items: AgentItemHistory::from_legacy_messages(messages)?.items,
            history_version: 0,
            token_info: None,
        })
    }

    pub(super) fn history_version(&self) -> u64 {
        self.history_version
    }

    pub(super) fn token_info(&self) -> Option<TokenUsageInfo> {
        self.token_info.clone()
    }

    pub(super) fn update_token_info(
        &mut self,
        provider_usage: &Value,
        model_context_window: Option<i64>,
    ) {
        let last = token_usage_from_provider(provider_usage);
        self.token_info = Some(TokenUsageInfo::new_or_append(
            self.token_info.as_ref(),
            last,
            model_context_window,
        ));
    }

    pub(super) fn messages(&self) -> Vec<Value> {
        AgentItemHistory {
            items: self.items.clone(),
        }
        .to_legacy_messages()
        .expect("ContextManager stores only model-visible history items")
    }

    pub(super) fn for_prompt(&self) -> Result<Vec<Value>, String> {
        let mut items = self.items.clone();
        project_superseded_web_targets(&mut items);
        validate_tool_pairs(&items)?;
        AgentItemHistory { items }.to_provider_messages()
    }

    pub(super) fn record_message(&mut self, message: Value) -> Result<(), String> {
        self.items.push(AgentItem::from_legacy_message(&message)?);
        Ok(())
    }

    pub(super) fn replace(&mut self, messages: Vec<Value>) -> Result<(), String> {
        self.items = AgentItemHistory::from_legacy_messages(&messages)?.items;
        self.history_version = self.history_version.saturating_add(1);
        Ok(())
    }
}

fn project_superseded_web_targets(items: &mut [AgentItem]) {
    let web_call_ids = items
        .iter()
        .filter_map(|item| match item {
            AgentItem::AssistantMessage(message) => Some(&message.tool_calls),
            _ => None,
        })
        .flatten()
        .filter(|call| crate::tools::web::is_web_tool(&call.name))
        .map(|call| call.id.clone())
        .collect::<HashSet<_>>();
    let mut retained_targets = false;
    for item in items.iter_mut().rev() {
        let AgentItem::ToolResult(result) = item else {
            continue;
        };
        let is_web_result = result
            .name
            .as_deref()
            .is_some_and(crate::tools::web::is_web_tool)
            || web_call_ids.contains(result.tool_call_id.as_str());
        if !is_web_result {
            continue;
        }
        let AgentMessageContent::Text(content) = &mut result.content else {
            continue;
        };
        if crate::tools::web::project_web_result_history(content, !retained_targets) {
            retained_targets = true;
        }
    }
}

fn token_usage_from_provider(usage: &Value) -> TokenUsage {
    let input_tokens = i64_field(
        usage,
        &[
            "inputTokens",
            "input_tokens",
            "promptTokens",
            "prompt_tokens",
        ],
    );
    let output_tokens = i64_field(
        usage,
        &[
            "outputTokens",
            "output_tokens",
            "completionTokens",
            "completion_tokens",
        ],
    );
    let detailed_cached_input_tokens = [
        "inputTokensDetails",
        "input_tokens_details",
        "promptTokensDetails",
        "prompt_tokens_details",
    ]
    .iter()
    .filter_map(|key| usage.get(key))
    .map(|details| {
        i64_field(
            details,
            &[
                "cachedInputTokens",
                "cached_input_tokens",
                "cachedTokens",
                "cached_tokens",
            ],
        )
    })
    .max()
    .unwrap_or_default();
    let detailed_reasoning_output_tokens = [
        "outputTokensDetails",
        "output_tokens_details",
        "completionTokensDetails",
        "completion_tokens_details",
    ]
    .iter()
    .filter_map(|key| usage.get(key))
    .map(|details| {
        i64_field(
            details,
            &[
                "reasoningOutputTokens",
                "reasoning_output_tokens",
                "reasoningTokens",
                "reasoning_tokens",
            ],
        )
    })
    .max()
    .unwrap_or_default();
    TokenUsage {
        input_tokens,
        cached_input_tokens: i64_field(
            usage,
            &[
                "cachedInputTokens",
                "cached_input_tokens",
                "cachedTokens",
                "cached_tokens",
            ],
        )
        .max(detailed_cached_input_tokens),
        output_tokens,
        reasoning_output_tokens: i64_field(
            usage,
            &[
                "reasoningOutputTokens",
                "reasoning_output_tokens",
                "reasoningTokens",
                "reasoning_tokens",
            ],
        )
        .max(detailed_reasoning_output_tokens),
        total_tokens: i64_field(
            usage,
            &[
                "totalTokens",
                "total_tokens",
                "contextUsageTokens",
                "context_usage_tokens",
                "total",
            ],
        )
        .max(input_tokens.saturating_add(output_tokens)),
    }
}

fn i64_field(value: &Value, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_i64))
        .unwrap_or_default()
        .max(0)
}

fn validate_tool_pairs(items: &[AgentItem]) -> Result<(), String> {
    let mut calls = HashMap::<String, &str>::new();
    let mut outputs = HashSet::<String>::new();

    for item in items {
        match item {
            AgentItem::AssistantMessage(message) => {
                for call in &message.tool_calls {
                    if calls.insert(call.id.clone(), call.name.as_str()).is_some() {
                        return Err(format!(
                            "duplicate tool call id `{}` in agent context",
                            call.id
                        ));
                    }
                }
            }
            AgentItem::ToolResult(result) => {
                if !calls.contains_key(&result.tool_call_id) {
                    return Err(format!(
                        "orphan tool result `{}` in agent context",
                        result.tool_call_id
                    ));
                }
                if !outputs.insert(result.tool_call_id.clone()) {
                    return Err(format!(
                        "duplicate tool result `{}` in agent context",
                        result.tool_call_id
                    ));
                }
            }
            AgentItem::Instruction(_)
            | AgentItem::UserMessage(_)
            | AgentItem::Reasoning(_)
            | AgentItem::UserInput(_)
            | AgentItem::PlanProgress(_)
            | AgentItem::Subagent(_)
            | AgentItem::SubagentMessage(_)
            | AgentItem::ContextCompaction(_)
            | AgentItem::Error(_)
            | AgentItem::Usage(_)
            | AgentItem::FileReference(_) => {}
        }
    }

    if let Some((call_id, tool_name)) = calls
        .iter()
        .find(|(call_id, _)| !outputs.contains(call_id.as_str()))
    {
        return Err(format!(
            "tool call `{call_id}` (`{tool_name}`) has no result in agent context"
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "context_manager_tests.rs"]
mod tests;
