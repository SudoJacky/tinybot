use super::{AgentItem, AgentItemHistory};
use crate::worker_rollout::{TokenUsage, TokenUsageInfo};
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
        validate_tool_pairs(&self.items)?;
        AgentItemHistory {
            items: self.items.clone(),
        }
        .to_provider_messages()
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
        ),
        output_tokens,
        reasoning_output_tokens: i64_field(
            usage,
            &[
                "reasoningOutputTokens",
                "reasoning_output_tokens",
                "reasoningTokens",
                "reasoning_tokens",
            ],
        ),
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
            | AgentItem::Approval(_)
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replace_bumps_history_version() {
        let mut history =
            ContextManager::from_legacy_messages(&[json!({"role": "user", "content": "one"})])
                .unwrap();

        history
            .replace(vec![json!({"role": "user", "content": "two"})])
            .unwrap();

        assert_eq!(history.history_version(), 1);
        assert_eq!(history.messages()[0]["content"], "two");
    }

    #[test]
    fn prompt_requires_complete_tool_pairs() {
        let history = ContextManager::from_legacy_messages(&[json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {"name": "lookup", "arguments": "{}"}
            }]
        })])
        .unwrap();

        assert!(history.for_prompt().unwrap_err().contains("has no result"));
    }

    #[test]
    fn prompt_accepts_complete_tool_pairs() {
        let history = ContextManager::from_legacy_messages(&[
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{}"}
                }]
            }),
            json!({
                "role": "tool",
                "tool_call_id": "call-1",
                "name": "lookup",
                "content": "done"
            }),
        ])
        .unwrap();

        assert_eq!(history.for_prompt().unwrap().len(), 2);
    }

    #[test]
    fn token_info_tracks_total_and_last_model_call_usage() {
        let mut history = ContextManager::from_legacy_messages(&[]).unwrap();

        history.update_token_info(
            &json!({"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}),
            Some(128_000),
        );
        history.update_token_info(
            &json!({"input_tokens": 7, "output_tokens": 2, "total_tokens": 9}),
            Some(128_000),
        );

        let info = history.token_info().unwrap();
        assert_eq!(info.total_token_usage.total_tokens, 22);
        assert_eq!(info.total_token_usage.input_tokens, 17);
        assert_eq!(info.last_token_usage.total_tokens, 9);
        assert_eq!(info.model_context_window, Some(128_000));
    }
}
