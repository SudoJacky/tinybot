use super::items::{parse_tool_call, AgentUsageItem};
use super::provider_adapter::{
    attach_provider_tools, provider_message_with_user_context,
    reject_image_attachments_for_chat_completions, require_provider_capability,
    DecodedProviderTurn,
};
use super::tool_router::AgentToolDefinition;
use super::{
    AgentAssistantMessage, AgentInstructionMessage, AgentInstructionRole, AgentItem,
    AgentItemHistory, AgentMessageContent, AgentReasoningItem, AgentToolCallItem,
    AgentTurnSettings,
};
use serde_json::Value;

pub(super) struct ChatCompletionsAdapter;

impl ChatCompletionsAdapter {
    pub fn build_request(
        legacy_messages: &[Value],
        system_prompt: Option<&str>,
        tools: &[AgentToolDefinition],
        settings: &AgentTurnSettings,
        config_snapshot: &Value,
        enable_parallel_tool_calls: bool,
    ) -> Result<Value, String> {
        let mut request = serde_json::json!({
            "model": settings.model.clone(),
            "messages": Self::encode_history(legacy_messages, system_prompt)?,
            "stream": settings.stream,
        });
        if settings.stream {
            request["stream_options"] = serde_json::json!({ "include_usage": true });
        }
        Self::apply_turn_settings(&mut request, settings, config_snapshot)?;
        attach_provider_tools(
            &mut request,
            Self::encode_tools(tools),
            enable_parallel_tool_calls,
        );
        Ok(request)
    }

    pub fn encode_tools(tools: &[AgentToolDefinition]) -> Vec<Value> {
        tools
            .iter()
            .map(|tool| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                })
            })
            .collect()
    }

    pub fn encode_history(
        legacy_messages: &[Value],
        system_prompt: Option<&str>,
    ) -> Result<Value, String> {
        let provider_messages = legacy_messages
            .iter()
            .map(|message| {
                reject_image_attachments_for_chat_completions(message)?;
                provider_message_with_user_context(message)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut history = AgentItemHistory::from_legacy_messages(&provider_messages)?;
        if let Some(system_prompt) = system_prompt {
            history.items.insert(
                0,
                AgentItem::Instruction(AgentInstructionMessage {
                    id: None,
                    role: AgentInstructionRole::System,
                    content: AgentMessageContent::text(system_prompt),
                }),
            );
        }
        Ok(Value::Array(history.to_provider_messages()?))
    }

    pub fn decode_response(
        completion: &Value,
        resolve_tool_name: impl Fn(&str) -> Result<String, String>,
    ) -> Result<DecodedProviderTurn, String> {
        let message = completion
            .pointer("/choices/0/message")
            .and_then(Value::as_object)
            .ok_or_else(|| "chat/completions response is missing choices[0].message".to_string())?;
        let content = decode_assistant_content(message.get("content"))?;
        let tool_calls = decode_provider_tool_calls(message.get("tool_calls"), resolve_tool_name)?;
        let reasoning = message
            .get("reasoning_content")
            .or_else(|| message.get("reasoningContent"))
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .map(|summary| AgentReasoningItem {
                        id: None,
                        summary: summary.to_string(),
                    })
                    .ok_or_else(|| "provider reasoning content must be a string".to_string())
            })
            .transpose()?;
        let usage = completion
            .get("usage")
            .filter(|value| !value.is_null())
            .cloned()
            .map(AgentUsageItem::from_provider_payload)
            .transpose()?;
        Ok(DecodedProviderTurn {
            assistant: AgentAssistantMessage {
                id: message
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                content,
                reasoning: reasoning
                    .as_ref()
                    .map(|reasoning| reasoning.summary.clone()),
                tool_calls,
                context_compaction: false,
            },
            reasoning,
            usage,
        })
    }

    pub fn assistant_text(completion: &Value) -> Result<String, String> {
        let message = completion
            .pointer("/choices/0/message")
            .and_then(Value::as_object)
            .ok_or_else(|| "chat/completions response is missing choices[0].message".to_string())?;
        let content = decode_assistant_content(message.get("content"))?;
        match content {
            Some(AgentMessageContent::Text(text)) => Ok(text),
            Some(AgentMessageContent::Parts(_)) => Err(
                "chat/completions assistant content parts are unsupported for text completion"
                    .to_string(),
            ),
            None => Ok(String::new()),
        }
    }

    pub fn apply_turn_settings(
        request: &mut Value,
        settings: &AgentTurnSettings,
        config_snapshot: &Value,
    ) -> Result<(), String> {
        settings.validate()?;
        if let Some(temperature) = settings.temperature {
            request["temperature"] = serde_json::json!(temperature);
        }
        if let Some(max_completion_tokens) = settings.max_completion_tokens {
            request["max_completion_tokens"] = serde_json::json!(max_completion_tokens);
        }
        if let Some(service_tier) = settings.service_tier.as_deref() {
            require_provider_capability(settings, config_snapshot, "service_tier")?;
            request["service_tier"] = Value::String(service_tier.to_string());
        }
        if let Some(reasoning) = settings.reasoning.as_ref() {
            require_provider_capability(settings, config_snapshot, "reasoning")?;
            if let Some(effort) = reasoning.effort.as_deref() {
                request["reasoning_effort"] = Value::String(effort.to_string());
            }
            if let Some(summary) = reasoning.summary.as_deref() {
                request["reasoning"] = serde_json::json!({ "summary": summary });
            }
        }
        if let Some(output_schema) = settings.output_schema.as_ref() {
            require_provider_capability(settings, config_snapshot, "structured_output")?;
            request["response_format"] = serde_json::json!({
                "type": "json_schema",
                "json_schema": {
                    "name": output_schema.name,
                    "strict": output_schema.strict,
                    "schema": output_schema.schema,
                }
            });
        }
        Ok(())
    }
}

fn decode_assistant_content(value: Option<&Value>) -> Result<Option<AgentMessageContent>, String> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|content| Some(AgentMessageContent::text(content)))
        .ok_or_else(|| "provider assistant content must be a string or null".to_string())
}

fn decode_provider_tool_calls(
    value: Option<&Value>,
    resolve_tool_name: impl Fn(&str) -> Result<String, String>,
) -> Result<Vec<AgentToolCallItem>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let calls = value
        .as_array()
        .ok_or_else(|| "provider tool_calls must be an array".to_string())?;
    calls
        .iter()
        .enumerate()
        .map(|(index, call)| parse_tool_call(call, index, |name| resolve_tool_name(name)))
        .collect()
}

#[cfg(test)]
#[path = "provider_adapter_tinyos_reference_tests.rs"]
mod tinyos_reference_tests;
