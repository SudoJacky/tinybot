use super::chat_completions_adapter::ChatCompletionsAdapter;
use super::provider_protocol::ProviderProtocolAdapter;
use super::{
    string_field, AgentItemHistory, AgentMessageContent, AgentToolCallItem, AgentTurnContext,
    NativeAgentProvider, NativeAgentProviderFailure, NativeAgentProviderFailureKind,
    NativeAgentProviderResponse, NativeAgentProviderStreamEvent, NativeAgentToolCall,
};
use serde_json::Value;
use std::sync::Arc;

pub(super) struct RustNativeAgentProvider;

impl NativeAgentProvider for RustNativeAgentProvider {
    #[cfg(test)]
    fn complete(&self, context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String> {
        let mut observer = |_event: NativeAgentProviderStreamEvent| {};
        self.complete_streaming(context, &mut observer)
    }

    #[cfg(test)]
    fn complete_streaming(
        &self,
        context: &AgentTurnContext,
        observer: &mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
    ) -> Result<NativeAgentProviderResponse, String> {
        let provider_config = agent_provider_config(context);
        let adapter = ProviderProtocolAdapter::resolve(context, &provider_config)?;
        let request = context
            .prepared_provider_request()
            .cloned()
            .map(Ok)
            .unwrap_or_else(|| adapter.build_request(context))?;
        let mut provider_observer =
            |event: crate::agent::provider::NativeProviderStreamEvent| match event {
                crate::agent::provider::NativeProviderStreamEvent::MessagePhase(phase) => {
                    observer(NativeAgentProviderStreamEvent::MessagePhase(
                        parse_message_phase(&phase),
                    ));
                }
                crate::agent::provider::NativeProviderStreamEvent::ContentDelta(delta) => {
                    observer(NativeAgentProviderStreamEvent::ContentDelta(delta));
                }
                crate::agent::provider::NativeProviderStreamEvent::ReasoningDelta(delta) => {
                    observer(NativeAgentProviderStreamEvent::ReasoningDelta(delta));
                }
            };
        let completion = adapter.complete(&provider_config, &request, &mut provider_observer)?;
        emit_completion_phase(&completion, adapter, observer);
        provider_response_from_completion(context, adapter, completion)
    }

    fn complete_streaming_async<'a>(
        self: Arc<Self>,
        context: &'a AgentTurnContext,
        observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<NativeAgentProviderResponse, NativeAgentProviderFailure>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let provider_config = agent_provider_config(context);
            let adapter = ProviderProtocolAdapter::resolve(context, &provider_config)
                .map_err(NativeAgentProviderFailure::provider)?;
            let request = match context.prepared_provider_request() {
                Some(request) => request.clone(),
                None => adapter.build_request_async(context).await?,
            };
            let cancellation = context.cancellation.clone().map(|cancellation| {
                Arc::new(cancellation) as Arc<dyn crate::protocol::WorkerRequestCancellation>
            });
            let mut provider_observer =
                |event: crate::agent::provider::NativeProviderStreamEvent| match event {
                    crate::agent::provider::NativeProviderStreamEvent::MessagePhase(phase) => {
                        observer(NativeAgentProviderStreamEvent::MessagePhase(
                            parse_message_phase(&phase),
                        ))
                    }
                    crate::agent::provider::NativeProviderStreamEvent::ContentDelta(delta) => {
                        observer(NativeAgentProviderStreamEvent::ContentDelta(delta))
                    }
                    crate::agent::provider::NativeProviderStreamEvent::ReasoningDelta(delta) => {
                        observer(NativeAgentProviderStreamEvent::ReasoningDelta(delta))
                    }
                };
            let completion = adapter
                .complete_async(
                    &provider_config,
                    &request,
                    &mut provider_observer,
                    cancellation,
                )
                .await
                .map_err(|error| {
                    NativeAgentProviderFailure::new(
                        map_provider_failure_kind(error.kind()),
                        error.message(),
                    )
                })?;
            emit_completion_phase(&completion, adapter, observer);
            provider_response_from_completion(context, adapter, completion)
                .map_err(NativeAgentProviderFailure::provider)
        })
    }
}

fn parse_message_phase(phase: &str) -> crate::agent::runtime_protocol::AgentAssistantMessagePhase {
    match phase {
        "commentary" => crate::agent::runtime_protocol::AgentAssistantMessagePhase::Commentary,
        "final_answer" => crate::agent::runtime_protocol::AgentAssistantMessagePhase::FinalAnswer,
        "unknown" => crate::agent::runtime_protocol::AgentAssistantMessagePhase::Unknown,
        other => panic!("provider emitted unsupported assistant message phase `{other}`"),
    }
}

fn emit_completion_phase(
    completion: &Value,
    adapter: ProviderProtocolAdapter,
    observer: &mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
) {
    let phase = adapter.message_phase(completion);
    if let Some(phase) = phase {
        observer(NativeAgentProviderStreamEvent::MessagePhase(
            parse_message_phase(phase),
        ));
    }
}

fn provider_response_from_completion(
    context: &AgentTurnContext,
    adapter: ProviderProtocolAdapter,
    completion: Value,
) -> Result<NativeAgentProviderResponse, String> {
    let fixture_response = fixture_agent_response(&context.config_snapshot, &context.messages)?;
    let decoded_response = adapter.decode_response(context, &completion)?;
    let response_items = decoded_response.response_items;
    let mut decoded = decoded_response.turn;
    let mut fixture_tool_calls = None;
    if let Some(response) = fixture_response.as_ref() {
        if let Some(content) = string_field(response, "content") {
            decoded.assistant.content = Some(AgentMessageContent::text(content));
        }
        if decoded.assistant.tool_calls.is_empty() {
            fixture_tool_calls = Some(fixture_agent_tool_calls(response)?);
        }
    }
    let final_content = match decoded.assistant.content.as_ref() {
        Some(AgentMessageContent::Text(content)) => content.clone(),
        Some(AgentMessageContent::Parts(_)) => {
            return Err(
                "provider assistant content parts cannot be used as final text".to_string(),
            );
        }
        None => String::new(),
    };
    Ok(NativeAgentProviderResponse {
        final_content,
        reasoning_delta: decoded.reasoning.map(|reasoning| reasoning.summary),
        usage: decoded.usage.map(|usage| usage.provider_payload),
        tool_calls: fixture_tool_calls
            .unwrap_or_else(|| native_tool_calls(decoded.assistant.tool_calls)),
        response_items,
    })
}

fn map_provider_failure_kind(
    kind: crate::agent::provider::NativeProviderFailureKind,
) -> NativeAgentProviderFailureKind {
    match kind {
        crate::agent::provider::NativeProviderFailureKind::Cancelled => {
            NativeAgentProviderFailureKind::Cancelled
        }
        crate::agent::provider::NativeProviderFailureKind::RequestTimeout => {
            NativeAgentProviderFailureKind::RequestTimeout
        }
        crate::agent::provider::NativeProviderFailureKind::StreamIdleTimeout => {
            NativeAgentProviderFailureKind::StreamIdleTimeout
        }
        crate::agent::provider::NativeProviderFailureKind::Transport => {
            NativeAgentProviderFailureKind::Transport
        }
        crate::agent::provider::NativeProviderFailureKind::Provider => {
            NativeAgentProviderFailureKind::Provider
        }
    }
}

#[cfg(test)]
pub(super) fn agent_chat_completion_request(context: &AgentTurnContext) -> Result<Value, String> {
    ProviderProtocolAdapter::ChatCompletions.build_request(context)
}

#[cfg(test)]
pub(super) fn agent_responses_request(context: &AgentTurnContext) -> Result<Value, String> {
    ProviderProtocolAdapter::Responses.build_request(context)
}

pub(super) fn agent_provider_config(context: &AgentTurnContext) -> Value {
    let mut config = context.config_snapshot.clone();
    set_agent_default(
        &mut config,
        "model",
        Value::String(context.settings.model.clone()),
    );
    if let Some(provider) = context.settings.provider.as_deref() {
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

pub(super) fn chat_completion_content(completion: &Value) -> Result<String, String> {
    ChatCompletionsAdapter::assistant_text(completion)
}

#[cfg(test)]
pub(super) fn chat_completion_tool_calls(
    completion: &Value,
    context: &AgentTurnContext,
) -> Result<Vec<NativeAgentToolCall>, String> {
    let decoded = ChatCompletionsAdapter::decode_response(completion, |provider_name| {
        context.tool_router.resolve_provider_name(provider_name)
    })?;
    Ok(native_tool_calls(decoded.assistant.tool_calls))
}

fn fixture_agent_response(
    config_snapshot: &Value,
    messages: &[Value],
) -> Result<Option<Value>, String> {
    let response_index =
        AgentItemHistory::from_legacy_messages(messages)?.assistant_tool_call_batch_count();
    Ok(config_snapshot
        .get("providers")
        .and_then(|providers| providers.get("fixture"))
        .and_then(|fixture| fixture.get("responses"))
        .and_then(Value::as_array)
        .and_then(|responses| responses.get(response_index).or_else(|| responses.first()))
        .cloned())
}

fn fixture_agent_tool_calls(response: &Value) -> Result<Vec<NativeAgentToolCall>, String> {
    let Some(tools) = response
        .get("toolCalls")
        .or_else(|| response.get("tool_calls"))
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };
    tools
        .iter()
        .enumerate()
        .map(|(index, tool)| {
            let id = string_field(tool, "id").unwrap_or_else(|| format!("fixture-call-{index}"));
            let name = string_field(tool, "name")
                .ok_or_else(|| format!("fixture tool call `{id}` requires name"))?;
            let arguments_json = tool
                .get("argumentsJson")
                .or_else(|| tool.get("arguments_json"))
                .and_then(Value::as_str)
                .ok_or_else(|| format!("fixture tool call `{id}` requires argumentsJson"))?
                .to_string();
            Ok(NativeAgentToolCall {
                id,
                name,
                arguments_json,
                result: tool.get("result").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn native_tool_calls(tool_calls: Vec<AgentToolCallItem>) -> Vec<NativeAgentToolCall> {
    tool_calls
        .into_iter()
        .map(|tool_call| NativeAgentToolCall {
            id: tool_call.id,
            name: tool_call.name,
            arguments_json: tool_call.arguments_json,
            result: Value::Null,
        })
        .collect()
}
