use super::{AgentTurnSettings, DEFAULT_NATIVE_AGENT_MAX_ITERATIONS};
use crate::agent::runtime_protocol::{AgentContinuationInput, AgentTraceContext};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

/// Normalized execution input. JSON aliases and defaults are resolved before a task is owned.
#[derive(Clone, Debug)]
pub struct AgentTurnInput {
    pub(crate) session_id: String,
    pub(crate) trace_context: AgentTraceContext,
    pub(crate) settings: AgentTurnSettings,
    // Legacy history and provider-native Responses items retain their protocol extensions.
    pub(crate) messages: super::AgentItemHistory,
    pub(crate) responses_input_items: Option<Vec<Value>>,
    pub(crate) api_mode: Option<String>,
    pub(crate) metadata: Value,
    pub(crate) continuation: Option<AgentContinuationInput>,
    pub(crate) controls: AgentTurnControls,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AgentTurnControls {
    pub(crate) manual_compaction: bool,
    pub(crate) declares_working_directory: bool,
    pub(crate) context_window_tokens: Option<i64>,
    pub(crate) compact_trigger_percent: Option<i64>,
    pub(crate) compact_summary_max_tokens: Option<i64>,
    pub(crate) max_tool_result_chars: Option<usize>,
    pub(crate) shell_parallel_policy: Option<String>,
}

#[derive(Deserialize)]
struct ContextCompactionRequest {
    trigger: Option<String>,
}

impl AgentTurnInput {
    pub(crate) fn from_wire(spec: &Value, config: &Value) -> Result<Self, String> {
        if !spec.is_object() {
            return Err("agent turn spec must be an object".to_string());
        }
        let metadata = object_field(spec, "metadata")?;
        let trace = object_field(spec, "traceContext")?;
        let defaults = config.pointer("/agents/defaults").unwrap_or(&Value::Null);
        let session_id = string(
            &[spec],
            &[
                "sessionId",
                "session_id",
                "activeSessionId",
                "active_session_id",
                "sessionKey",
                "session_key",
            ],
        )?
        .unwrap_or_else(|| "native-rust-session".to_string());
        let turn_id = string(&[spec, trace, metadata], &["turnId", "turn_id"])?
            .unwrap_or_else(|| "native-rust-turn".to_string());
        let trace_context = AgentTraceContext {
            request_id: string(&[spec, trace, metadata], &["requestId", "request_id"])?
                .unwrap_or_else(|| format!("agent-turn-{turn_id}")),
            trace_id: string(&[spec, trace, metadata], &["traceId", "trace_id"])?
                .unwrap_or_else(|| format!("trace-agent-turn-{turn_id}")),
            thread_id: string(&[spec, metadata], &["threadId", "thread_id"])?,
            parent_turn_id: string(
                &[spec, trace, metadata],
                &["parentTurnId", "parent_turn_id"],
            )?,
            turn_id,
        };
        let model = string(&[spec], &["model", "modelId", "model_id"])?
            .or(string(&[metadata], &["model"])?)
            .unwrap_or_else(|| crate::agent::provider::configured_model(config));
        let provider = string(&[spec], &["provider", "providerId", "provider_id"])?
            .or(string(&[metadata], &["provider"])?)
            .or_else(|| {
                crate::agent::provider::resolve_provider_profile(config, None, None)
                    .map(|profile| profile.provider_id)
            });
        let max_iterations = optional(
            &[spec, metadata, defaults],
            &["maxIterations", "max_iterations"],
        )?
        .unwrap_or(DEFAULT_NATIVE_AGENT_MAX_ITERATIONS);
        let stream = optional(&[spec, metadata], &["stream"])?
            .or(optional(&[metadata], &["_wants_stream"])?)
            .unwrap_or(false);
        let settings = AgentTurnSettings::from_sources(
            spec,
            metadata,
            config,
            model,
            provider,
            max_iterations,
            stream,
        );
        settings.validate()?;
        let continuation = optional(&[metadata], &["agentContinuation", "continuation"])?;
        let mut messages = initial_messages(spec)?;
        if let Some(message) =
            super::continuations::queued_user_continuation_message(continuation.as_ref())
        {
            messages.push(message);
        }
        let api_mode = string(&[spec, metadata], &["apiMode", "api_mode"])?;
        let response_items = optional::<Vec<Value>>(&[spec], &["responseItems", "response_items"])?;
        let mut responses_input_items =
            (api_mode.as_deref() == Some("responses")).then(|| response_items.unwrap_or_default());
        if let Some(items) = responses_input_items.as_mut() {
            let has_current_user = items.iter().any(|item| {
                item.get("role").and_then(Value::as_str) == Some("user")
                    && item
                        .get("turnId")
                        .or_else(|| item.get("turn_id"))
                        .and_then(Value::as_str)
                        == Some(trace_context.turn_id.as_str())
            });
            if !has_current_user {
                if let Some(user) = messages
                    .iter()
                    .rev()
                    .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
                {
                    let mut user = user.clone();
                    user["turnId"] = Value::String(trace_context.turn_id.clone());
                    items.push(user);
                }
            }
        }
        let compaction = optional::<ContextCompactionRequest>(
            &[spec],
            &["contextCompaction", "context_compaction"],
        )?;
        let manual_compaction =
            compaction.and_then(|request| request.trigger).as_deref() == Some("manual");
        let controls = AgentTurnControls {
            manual_compaction,
            declares_working_directory: string(
                &[spec, metadata],
                &["cwd", "workingDirectory", "working_directory", "workspace"],
            )?
            .is_some(),
            context_window_tokens: positive(
                &[spec],
                &["contextWindowTokens", "context_window_tokens"],
            )?,
            compact_trigger_percent: positive(
                &[spec, defaults],
                &["compactTriggerPercent", "compact_trigger_percent"],
            )?,
            compact_summary_max_tokens: positive(
                &[spec, defaults],
                &["compactSummaryMaxTokens", "compact_summary_max_tokens"],
            )?,
            max_tool_result_chars: optional::<usize>(
                &[spec, metadata, defaults, config],
                &["maxToolResultChars", "max_tool_result_chars"],
            )?
            .filter(|value| *value > 0),
            shell_parallel_policy: string(
                &[
                    object_field(spec, "nativeAgent")?,
                    spec,
                    object_field(config, "nativeAgent")?,
                ],
                &["shellParallelPolicy"],
            )?,
        };
        Ok(Self {
            session_id,
            trace_context,
            settings,
            messages: super::AgentItemHistory::from_legacy_messages(&messages)?,
            responses_input_items,
            api_mode,
            metadata: if metadata.is_null() {
                serde_json::json!({})
            } else {
                metadata.clone()
            },
            continuation,
            controls,
        })
    }
}

fn object_field<'a>(source: &'a Value, key: &str) -> Result<&'a Value, String> {
    match source.get(key) {
        None | Some(Value::Null) => Ok(&Value::Null),
        Some(value) if value.is_object() => Ok(value),
        Some(_) => Err(format!(
            "invalid agent turn field `{key}`: expected an object"
        )),
    }
}

fn optional<T: DeserializeOwned>(sources: &[&Value], keys: &[&str]) -> Result<Option<T>, String> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key) {
                if value.is_null() {
                    continue;
                }
                return serde_json::from_value(value.clone())
                    .map(Some)
                    .map_err(|error| format!("invalid agent turn field `{key}`: {error}"));
            }
        }
    }
    Ok(None)
}

fn string(sources: &[&Value], keys: &[&str]) -> Result<Option<String>, String> {
    for source in sources {
        for key in keys {
            if let Some(value) = optional::<String>(&[*source], &[*key])? {
                if !value.trim().is_empty() {
                    return Ok(Some(value.trim().to_string()));
                }
            }
        }
    }
    Ok(None)
}

fn positive(sources: &[&Value], keys: &[&str]) -> Result<Option<i64>, String> {
    for source in sources {
        for key in keys {
            if let Some(value) = optional::<i64>(&[*source], &[*key])?.filter(|value| *value > 0) {
                return Ok(Some(value));
            }
        }
    }
    Ok(None)
}

fn initial_messages(spec: &Value) -> Result<Vec<Value>, String> {
    if let Some(messages) = optional::<Vec<Value>>(&[spec], &["messages"])? {
        if !messages.is_empty() {
            return Ok(messages);
        }
    }
    let input = object_field(spec, "input")?;
    let Some(content) = optional::<String>(&[input], &["content"])? else {
        return Ok(Vec::new());
    };
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let role = string(&[input], &["role"])?.unwrap_or_else(|| "user".to_string());
    let mut message = serde_json::json!({ "role": role, "content": content });
    if let Some(id) = optional::<String>(&[input], &["clientEventId", "client_event_id"])? {
        message["clientEventId"] = Value::String(id);
    }
    if let Some(references) = optional::<Vec<Value>>(&[input], &["references"])? {
        message["references"] = Value::Array(references);
    }
    Ok(vec![message])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aliases_and_precedence_produce_one_execution_identity_and_settings() {
        let input = AgentTurnInput::from_wire(&json!({
            "session_key": " session-1 ", "turn_id": "turn-1", "model_id": "turn-model",
            "max_iterations": 3, "stream": false, "compactTriggerPercent": 0,
            "traceContext": { "turnId": "trace-turn", "request_id": "request-1" },
            "metadata": { "thread_id": "thread-1", "model": "metadata-model", "_wants_stream": true,
                "working_directory": "D:/work", "maxToolResultChars": 123 },
            "context_compaction": { "trigger": "manual" }
        }), &json!({ "agents": { "defaults": { "model": "default-model", "maxIterations": 20, "compactTriggerPercent": 80 } } }))
            .expect("aliases should normalize");
        assert_eq!(input.session_id, "session-1");
        assert_eq!(input.trace_context.turn_id, "turn-1");
        assert_eq!(input.trace_context.request_id, "request-1");
        assert_eq!(input.trace_context.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(input.settings.model, "turn-model");
        assert_eq!(input.settings.max_iterations, 3);
        assert!(!input.settings.stream);
        assert!(input.controls.manual_compaction);
        assert!(input.controls.declares_working_directory);
        assert_eq!(input.controls.max_tool_result_chars, Some(123));
        assert_eq!(input.controls.compact_trigger_percent, Some(80));
        let inherited = AgentTurnInput::from_wire(
            &json!({}),
            &json!({"agents":{"defaults":{"cwd":"D:/fallback"}}}),
        )
        .unwrap();
        assert!(!inherited.controls.declares_working_directory);
    }

    #[test]
    fn queued_continuation_is_parsed_once_and_added_to_responses_history() {
        let input = AgentTurnInput::from_wire(&json!({
            "turnId": "turn-2", "api_mode": "responses",
            "messages": [{"role":"user", "content":"old"}],
            "response_items": [{"role":"user", "content":"old", "turnId":"turn-1"}],
            "metadata": {"continuation": {"kind":"queued_user_message", "content":"next", "messageId":"message-2"}}
        }), &json!({})).unwrap();
        assert!(matches!(
            input.continuation,
            Some(AgentContinuationInput::QueuedUserMessage { .. })
        ));
        assert_eq!(input.messages.len(), 2);
        let items = input.responses_input_items.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["content"], "next");
        assert_eq!(items[1]["turnId"], "turn-2");
    }

    #[test]
    fn malformed_fields_fail_before_task_ownership_or_provider_dispatch() {
        use super::super::*;
        use std::sync::Arc;
        struct UnexpectedProvider;
        impl NativeAgentProvider for UnexpectedProvider {
            fn complete(
                &self,
                _: &AgentTurnContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                panic!("invalid input must never reach the provider");
            }
        }
        let services = NativeAgentRuntimeServices::new(
            Arc::new(UnexpectedProvider),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        );
        for (field, value, diagnostic) in [
            ("maxIterations", json!("3"), "maxIterations"),
            ("stream", json!("false"), "stream"),
            ("messages", json!({}), "messages"),
            ("metadata", json!([]), "metadata"),
            (
                "metadata",
                json!({"agentContinuation":{"kind":"unknown"}}),
                "agentContinuation",
            ),
            (
                "metadata",
                json!({"continuation":{"kind":"form","formId":"f"}}),
                "continuation",
            ),
            ("temperature", json!("hot"), "temperature"),
        ] {
            let mut spec =
                json!({"turnId":"invalid-turn","messages":[{"role":"user","content":"hello"}]});
            spec[field] = value;
            let error = run_native_agent_turn_with_config(&services, spec, json!({}))
                .expect_err("invalid input should fail");
            assert!(error.to_string().contains(diagnostic), "{error}");
            assert!(services.task_runtime.status("invalid-turn").is_none());
        }
    }
}
