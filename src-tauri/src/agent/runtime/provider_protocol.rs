use super::chat_completions_adapter::ChatCompletionsAdapter;
#[cfg(test)]
use super::context_window_messages;
use super::provider_adapter::DecodedProviderTurn;
use super::responses_adapter::ResponsesAdapter;
use super::{context_window_messages_async, AgentTurnContext, NativeAgentProviderFailure};
use crate::agent::provider::{
    NativeProviderApiMode, NativeProviderFailure, NativeProviderStreamEvent,
};
use crate::protocol::WorkerRequestCancellation;
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProviderProtocolAdapter {
    ChatCompletions,
    Responses,
}

pub(super) struct DecodedProtocolResponse {
    pub turn: DecodedProviderTurn,
    pub response_items: Vec<Value>,
}

impl ProviderProtocolAdapter {
    pub fn resolve(context: &AgentTurnContext, provider_config: &Value) -> Result<Self, String> {
        let api_mode = if let Some(api_mode) = context.api_mode.as_deref() {
            NativeProviderApiMode::parse(api_mode)
                .map_err(|_| format!("agent session has unsupported api_mode `{api_mode}`"))?
        } else {
            let profile = crate::agent::provider::resolve_provider_profile(
                provider_config,
                context.settings.provider.as_deref(),
                None,
            )
            .ok_or_else(|| {
                let provider = context
                    .settings
                    .provider
                    .as_deref()
                    .unwrap_or("active profile");
                format!("provider `{provider}` is not configured")
            })?;
            profile.parsed_api_mode()?
        };
        Ok(match api_mode {
            NativeProviderApiMode::ChatCompletions => Self::ChatCompletions,
            NativeProviderApiMode::Responses => Self::Responses,
        })
    }

    pub fn from_runtime_context(context: &AgentTurnContext) -> Result<Self, String> {
        let Some(api_mode) = context.api_mode.as_deref() else {
            return Ok(if context.responses_input_items.is_some() {
                Self::Responses
            } else {
                Self::ChatCompletions
            });
        };
        Ok(
            match NativeProviderApiMode::parse(api_mode)
                .map_err(|_| format!("agent session has unsupported api_mode `{api_mode}`"))?
            {
                NativeProviderApiMode::ChatCompletions => Self::ChatCompletions,
                NativeProviderApiMode::Responses => Self::Responses,
            },
        )
    }

    #[cfg(test)]
    pub fn build_request(self, context: &AgentTurnContext) -> Result<Value, String> {
        if context.messages.is_empty() {
            return Err("agent turn requires at least one chat message".to_string());
        }
        self.build_request_from_window(context, context_window_messages(context)?)
    }

    pub async fn build_request_async(
        self,
        context: &AgentTurnContext,
    ) -> Result<Value, NativeAgentProviderFailure> {
        if context.messages.is_empty() {
            return Err(NativeAgentProviderFailure::provider(
                "agent turn requires at least one chat message",
            ));
        }
        self.build_request_from_window(context, context_window_messages_async(context).await?)
            .map_err(NativeAgentProviderFailure::provider)
    }

    fn build_request_from_window(
        self,
        context: &AgentTurnContext,
        messages: Vec<Value>,
    ) -> Result<Value, String> {
        let definitions = context.tool_router.tool_definitions()?;
        let enable_parallel_tool_calls = context.settings.parallel_tool_calls.unwrap_or(false)
            && context.tool_router.has_parallel_provider_tool();
        match self {
            Self::ChatCompletions => ChatCompletionsAdapter::build_request(
                &messages,
                context.system_instruction_prompt(),
                &definitions,
                &context.settings,
                &context.config_snapshot,
                enable_parallel_tool_calls,
            ),
            Self::Responses => ResponsesAdapter::build_request(
                &messages,
                context.system_instruction_prompt(),
                context.responses_input_items.as_deref(),
                &definitions,
                &context.settings,
                &context.config_snapshot,
                enable_parallel_tool_calls,
            ),
        }
    }

    #[cfg(test)]
    pub fn complete(
        self,
        provider_config: &Value,
        request: &Value,
        observer: &mut (dyn FnMut(NativeProviderStreamEvent) + Send),
    ) -> Result<Value, String> {
        match self {
            Self::ChatCompletions => crate::agent::provider::complete_chat_for_agent_with_observer(
                provider_config,
                request,
                observer,
            ),
            Self::Responses => crate::agent::provider::complete_responses_for_agent_with_observer(
                provider_config,
                request,
                observer,
            ),
        }
    }

    pub async fn complete_async(
        self,
        provider_config: &Value,
        request: &Value,
        observer: &mut (dyn FnMut(NativeProviderStreamEvent) + Send),
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Result<Value, NativeProviderFailure> {
        match self {
            Self::ChatCompletions => {
                crate::agent::provider::complete_chat_for_agent_with_observer_async(
                    provider_config,
                    request,
                    observer,
                    cancellation,
                )
                .await
            }
            Self::Responses => {
                crate::agent::provider::complete_responses_for_agent_with_observer_async(
                    provider_config,
                    request,
                    observer,
                    cancellation,
                )
                .await
            }
        }
    }

    pub fn decode_response(
        self,
        context: &AgentTurnContext,
        response: &Value,
    ) -> Result<DecodedProtocolResponse, String> {
        let turn = match self {
            Self::ChatCompletions => {
                ChatCompletionsAdapter::decode_response(response, |provider_name| {
                    context.tool_router.resolve_provider_name(provider_name)
                })?
            }
            Self::Responses => ResponsesAdapter::decode_response(response, |provider_name| {
                context.tool_router.resolve_provider_name(provider_name)
            })?,
        };
        let response_items = match self {
            Self::ChatCompletions => Vec::new(),
            Self::Responses => response
                .get("output")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| "Responses API response is missing output".to_string())?,
        };
        Ok(DecodedProtocolResponse {
            turn,
            response_items,
        })
    }

    pub fn message_phase<'a>(self, response: &'a Value) -> Option<&'a str> {
        match self {
            Self::ChatCompletions => response
                .pointer("/choices/0/message/phase")
                .or_else(|| response.pointer("/choices/0/message/message_phase"))
                .or_else(|| response.pointer("/choices/0/message/messagePhase"))
                .and_then(Value::as_str),
            Self::Responses => ResponsesAdapter::message_phase(response),
        }
    }

    pub fn reset_replay_after_context_projection(
        self,
        context: &mut AgentTurnContext,
    ) -> Result<(), String> {
        match self {
            Self::ChatCompletions => ensure_chat_has_no_responses_replay(context),
            Self::Responses => {
                context.responses_input_items = None;
                Ok(())
            }
        }
    }

    pub fn record_provider_response_items(
        self,
        context: &mut AgentTurnContext,
        response_items: &[Value],
    ) -> Result<(), String> {
        match self {
            Self::ChatCompletions => {
                ensure_chat_has_no_responses_replay(context)?;
                if response_items.is_empty() {
                    Ok(())
                } else {
                    Err("Chat Completions returned Responses-native output items".to_string())
                }
            }
            Self::Responses => {
                // `None` means compaction deliberately switched this turn to the shared
                // canonical message history; the provider output is recorded there instead.
                if let Some(input_items) = context.responses_input_items.as_mut() {
                    input_items.extend(response_items.iter().cloned());
                }
                Ok(())
            }
        }
    }

    pub fn record_tool_outputs(
        self,
        context: &mut AgentTurnContext,
        results: &[Value],
    ) -> Result<(), String> {
        match self {
            Self::ChatCompletions => ensure_chat_has_no_responses_replay(context),
            Self::Responses => {
                let outputs = ResponsesAdapter::encode_tool_outputs(results)?;
                // See `record_provider_response_items`: canonical-history mode already
                // receives these tool results through the shared AgentItem history.
                if let Some(input_items) = context.responses_input_items.as_mut() {
                    input_items.extend(outputs);
                }
                Ok(())
            }
        }
    }
}

fn ensure_chat_has_no_responses_replay(context: &AgentTurnContext) -> Result<(), String> {
    if context.responses_input_items.is_some() {
        Err("Chat Completions context contains Responses-native replay items".to_string())
    } else {
        Ok(())
    }
}
