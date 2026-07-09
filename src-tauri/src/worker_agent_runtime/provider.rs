use super::{
    context_window_messages, string_field, NativeAgentProvider, NativeAgentProviderResponse,
    NativeAgentProviderStreamEvent, NativeAgentRunContext, NativeAgentToolCall,
};
use serde_json::Value;

pub(super) struct RustNativeAgentProvider;

impl NativeAgentProvider for RustNativeAgentProvider {
    fn complete(
        &self,
        context: &NativeAgentRunContext,
    ) -> Result<NativeAgentProviderResponse, String> {
        let mut observer = |_event: NativeAgentProviderStreamEvent| {};
        self.complete_streaming(context, &mut observer)
    }

    fn complete_streaming(
        &self,
        context: &NativeAgentRunContext,
        observer: &mut dyn FnMut(NativeAgentProviderStreamEvent),
    ) -> Result<NativeAgentProviderResponse, String> {
        let request = agent_chat_completion_request(context)?;
        let provider_config = agent_provider_config(context);
        let mut provider_observer =
            |event: crate::native_provider_runtime::NativeProviderStreamEvent| match event {
                crate::native_provider_runtime::NativeProviderStreamEvent::ContentDelta(delta) => {
                    observer(NativeAgentProviderStreamEvent::ContentDelta(delta));
                }
                crate::native_provider_runtime::NativeProviderStreamEvent::ReasoningDelta(
                    delta,
                ) => {
                    observer(NativeAgentProviderStreamEvent::ReasoningDelta(delta));
                }
            };
        let completion = crate::native_provider_runtime::complete_chat_for_agent_with_observer(
            &provider_config,
            &request,
            &mut provider_observer,
        )?;
        let fixture_response = fixture_agent_response(&context.config_snapshot, &context.messages);
        Ok(NativeAgentProviderResponse {
            final_content: fixture_response
                .as_ref()
                .and_then(|response| string_field(response, "content"))
                .unwrap_or_else(|| chat_completion_content(&completion)),
            reasoning_delta: chat_completion_reasoning_delta(&completion),
            usage: completion.get("usage").cloned(),
            tool_calls: {
                let chat_tool_calls = chat_completion_tool_calls(&completion);
                if chat_tool_calls.is_empty() {
                    fixture_response
                        .as_ref()
                        .map(fixture_agent_tool_calls)
                        .unwrap_or_default()
                } else {
                    chat_tool_calls
                }
            },
        })
    }
}

pub(super) fn agent_chat_completion_request(
    context: &NativeAgentRunContext,
) -> Result<Value, String> {
    let messages = agent_chat_messages(context)?;
    let mut request = serde_json::json!({
        "model": context.model.clone(),
        "messages": messages,
        "stream": context.stream,
    });
    if context.stream {
        request["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    if let Some(max_tokens) = context
        .spec
        .get("maxCompletionTokens")
        .or_else(|| context.spec.get("max_completion_tokens"))
        .or_else(|| context.spec.get("max_tokens"))
        .cloned()
    {
        request["max_completion_tokens"] = max_tokens;
    }
    Ok(request)
}

pub(super) fn agent_provider_config(context: &NativeAgentRunContext) -> Value {
    let mut config = context.config_snapshot.clone();
    set_agent_default(&mut config, "model", Value::String(context.model.clone()));
    if let Some(provider) = context.provider.as_deref() {
        set_agent_default(&mut config, "provider", Value::String(provider.to_string()));
    }
    config
}

fn set_agent_default(config: &mut Value, key: &str, value: Value) {
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let config_object = config
        .as_object_mut()
        .expect("config should be an object after normalization");
    let agents = config_object
        .entry("agents".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !agents.is_object() {
        *agents = serde_json::json!({});
    }
    let agents_object = agents
        .as_object_mut()
        .expect("agents should be an object after normalization");
    let defaults = agents_object
        .entry("defaults".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !defaults.is_object() {
        *defaults = serde_json::json!({});
    }
    defaults
        .as_object_mut()
        .expect("defaults should be an object after normalization")
        .insert(key.to_string(), value);
}

fn agent_chat_messages(context: &NativeAgentRunContext) -> Result<Value, String> {
    if !context.messages.is_empty() {
        return Ok(Value::Array(context_window_messages(context)));
    }
    Err("agent run requires at least one chat message".to_string())
}

pub(super) fn chat_completion_content(completion: &Value) -> String {
    completion
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn chat_completion_reasoning_delta(completion: &Value) -> Option<String> {
    completion
        .pointer("/choices/0/message/reasoning_content")
        .or_else(|| completion.pointer("/choices/0/message/reasoningContent"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn chat_completion_tool_calls(completion: &Value) -> Vec<NativeAgentToolCall> {
    completion
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .enumerate()
                .filter_map(|(index, tool)| {
                    let function = tool.get("function")?;
                    let name = string_field(function, "name")?;
                    Some(NativeAgentToolCall {
                        id: string_field(tool, "id")
                            .unwrap_or_else(|| format!("tool-call-{}", index + 1)),
                        name,
                        arguments_json: string_field(function, "arguments")
                            .unwrap_or_else(|| "{}".to_string()),
                        result: serde_json::json!({ "ok": true }),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn fixture_agent_response(config_snapshot: &Value, messages: &[Value]) -> Option<Value> {
    let response_index = messages
        .iter()
        .filter(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|tool_calls| !tool_calls.is_empty())
        })
        .count();
    config_snapshot
        .get("providers")
        .and_then(|providers| providers.get("fixture"))
        .and_then(|fixture| fixture.get("responses"))
        .and_then(Value::as_array)
        .and_then(|responses| responses.get(response_index).or_else(|| responses.first()))
        .cloned()
}

fn fixture_agent_tool_calls(response: &Value) -> Vec<NativeAgentToolCall> {
    response
        .get("toolCalls")
        .or_else(|| response.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .enumerate()
                .filter_map(|(index, tool)| {
                    let name = string_field(tool, "name")?;
                    Some(NativeAgentToolCall {
                        id: string_field(tool, "id")
                            .unwrap_or_else(|| format!("fixture-call-{index}")),
                        name,
                        arguments_json: string_field(tool, "argumentsJson")
                            .or_else(|| string_field(tool, "arguments_json"))
                            .unwrap_or_else(|| "{}".to_string()),
                        result: tool
                            .get("result")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({ "ok": true })),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
