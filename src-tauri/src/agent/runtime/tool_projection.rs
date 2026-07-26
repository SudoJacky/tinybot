use super::state::AgentTurnState;
use super::subagent_projection::project_subagent_tool_result;
use super::{
    AgentAssistantMessage, AgentItem, AgentMessageContent, AgentToolCallItem, AgentToolResultItem,
    AgentTurnContext, NativeAgentToolCall, NativeAgentToolResult, NativeToolResultEnvelope,
};
use crate::agent::runtime_protocol::{AgentEventKind, AgentRuntimePhase, ToolLifecycleEvent};
use serde_json::Value;

pub(super) fn assistant_tool_calls_message(
    content: &str,
    tool_calls: &[NativeAgentToolCall],
) -> Value {
    AgentItem::AssistantMessage(AgentAssistantMessage {
        id: None,
        content: Some(AgentMessageContent::text(content)),
        reasoning: None,
        tool_calls: tool_calls
            .iter()
            .map(|tool_call| AgentToolCallItem {
                id: tool_call.id.clone(),
                name: tool_call.name.clone(),
                arguments_json: tool_call.arguments_json.clone(),
            })
            .collect(),
    })
    .to_legacy_message()
    .expect("constructed assistant tool-call item must serialize")
}

fn tool_observation_message_with_error(
    tool_call: &NativeAgentToolCall,
    content: &str,
    is_error: bool,
) -> Value {
    AgentItem::ToolResult(AgentToolResultItem {
        id: None,
        tool_call_id: tool_call.id.clone(),
        name: Some(tool_call.name.clone()),
        content: AgentMessageContent::text(content),
        is_error,
    })
    .to_legacy_message()
    .expect("constructed tool-result item must serialize")
}

pub(super) fn prepare_continuation_tool_observation(
    messages: &mut Vec<Value>,
    tool_call: &NativeAgentToolCall,
    synthesize_missing_call: bool,
) -> Result<(), String> {
    let matching_call_count = messages
        .iter()
        .filter_map(|message| message.get("tool_calls").and_then(Value::as_array))
        .flatten()
        .filter(|call| call.get("id").and_then(Value::as_str) == Some(tool_call.id.as_str()))
        .count();
    match matching_call_count {
        0 if synthesize_missing_call => {
            messages.push(assistant_tool_calls_message("", &[tool_call.clone()]));
        }
        0 => {
            return Err(format!(
                "continuation checkpoint is missing assistant tool call `{}`",
                tool_call.id
            ));
        }
        1 => {}
        count => {
            return Err(format!(
                "continuation checkpoint contains {count} assistant tool calls for `{}`",
                tool_call.id
            ));
        }
    }

    let matching_result_count = messages
        .iter()
        .filter(|message| {
            message.get("role").and_then(Value::as_str) == Some("tool")
                && message
                    .get("tool_call_id")
                    .or_else(|| message.get("toolCallId"))
                    .and_then(Value::as_str)
                    == Some(tool_call.id.as_str())
        })
        .count();
    if matching_result_count != 0 {
        return Err(format!(
            "continuation checkpoint already contains {matching_result_count} tool results for `{}`",
            tool_call.id
        ));
    }

    Ok(())
}

pub(super) fn commit_tool_observation(
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: NativeAgentToolCall,
    result: NativeAgentToolResult,
) -> Result<(), String> {
    state.emit_pending_hook_evaluations(context)?;
    let result = normalize_tool_result_for_context(result, context).map_err(|error| {
        format!(
            "invalid tool result for `{}` (`{}`): {error}",
            tool_call.name, tool_call.id
        )
    })?;
    let status = required_envelope_string(&result.envelope, "status")?.to_string();
    let summary = required_envelope_string(&result.envelope, "summary")?.to_string();
    let observation_content =
        required_envelope_string(&result.envelope, "modelContent")?.to_string();
    let observation_message =
        tool_observation_message_with_error(&tool_call, &observation_content, status != "ok");
    state
        .history
        .record_message(observation_message)
        .map_err(|error| {
            format!(
                "failed to record tool observation for `{}` (`{}`): {error}",
                tool_call.name, tool_call.id
            )
        })?;
    state.emit(ToolLifecycleEvent::Result(serde_json::json!({
        "iteration": iteration,
        "toolCallId": tool_call.id,
        "toolName": tool_call.name,
        "name": tool_call.name,
        "detailId": format!("tool:{}", tool_call.id),
        "status": "completed",
        "resultStatus": status,
        "summary": summary,
        "timing": {
            "durationMs": result
                .envelope
                .get("metrics")
                .and_then(|metrics| metrics.get("durationMs"))
                .cloned()
                .unwrap_or(Value::Null),
        },
        "content": observation_content,
        "envelope": result.envelope.clone(),
    })))?;
    for event in project_subagent_tool_result(context, &tool_call, &result)? {
        if event.kind() == crate::agent::runtime_protocol::AgentEventKind::DelegateWait {
            state.transition_phase(
                AgentRuntimePhase::AwaitingSubagent,
                iteration,
                AgentEventKind::DelegateWait.wire_name(),
            )?;
        }
        state.emit(event)?;
    }
    state
        .completed_tool_results
        .push(completed_tool_result_entry(
            &tool_call, &result, &status, &summary,
        ));
    Ok(())
}

fn normalize_tool_result_for_context(
    mut result: NativeAgentToolResult,
    context: &AgentTurnContext,
) -> Result<NativeAgentToolResult, String> {
    if !result.envelope.is_object() {
        return Err("tool result envelope must be an object".to_string());
    }
    let status = required_envelope_string(&result.envelope, "status")?;
    if !matches!(status, "ok" | "error" | "denied") {
        return Err(format!(
            "tool result envelope has unsupported status `{status}`"
        ));
    }
    let summary = required_envelope_string(&result.envelope, "summary")?.to_string();
    let mut model_content = required_envelope_string(&result.envelope, "modelContent")?.to_string();
    let secrets = config_redaction_values(&context.config_snapshot);
    let max_model_chars = configured_max_tool_result_chars(context);
    let mut redactions = Vec::new();
    model_content = redact_sensitive_text(&model_content, &secrets, &mut redactions);
    let original_model_chars = model_content.chars().count();
    let mut truncated = false;
    if let Some(max_model_chars) = max_model_chars {
        if original_model_chars > max_model_chars {
            model_content = model_content.chars().take(max_model_chars).collect();
            truncated = true;
        }
    }

    let envelope = result
        .envelope
        .as_object_mut()
        .ok_or_else(|| "tool result envelope must be an object".to_string())?;
    envelope.insert(
        "modelContent".to_string(),
        Value::String(model_content.clone()),
    );
    envelope.insert(
        "summary".to_string(),
        Value::String(redact_sensitive_text(&summary, &secrets, &mut redactions)),
    );
    if let Some(structured) = envelope.get_mut("structured") {
        redact_sensitive_value(structured, &secrets, &mut redactions);
    }
    if let Some(raw) = envelope.get_mut("raw") {
        redact_sensitive_value(raw, &secrets, &mut redactions);
    }
    if let Some(metrics) = envelope.get_mut("metrics").and_then(Value::as_object_mut) {
        metrics.insert(
            "modelChars".to_string(),
            serde_json::json!(model_content.chars().count()),
        );
        metrics.insert(
            "originalModelChars".to_string(),
            serde_json::json!(original_model_chars),
        );
    }
    envelope.insert(
        "redactions".to_string(),
        Value::Array(redactions.into_iter().map(Value::String).collect()),
    );
    envelope.insert(
        "truncation".to_string(),
        serde_json::json!({
            "truncated": truncated,
            "maxModelChars": max_model_chars,
            "originalModelChars": original_model_chars,
        }),
    );
    if truncated {
        envelope.insert(
            "continuation".to_string(),
            serde_json::json!({
                "cursor": format!("modelContent:{original_model_chars}"),
                "nextOffset": model_content.chars().count(),
            }),
        );
    }
    result.content = Value::String(model_content);
    Ok(result)
}

fn required_envelope_string<'a>(
    envelope: &'a NativeToolResultEnvelope,
    field: &str,
) -> Result<&'a str, String> {
    envelope
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("tool result envelope field `{field}` must be a string"))
}

fn configured_max_tool_result_chars(context: &AgentTurnContext) -> Option<usize> {
    context
        .spec
        .get("maxToolResultChars")
        .or_else(|| context.spec.get("max_tool_result_chars"))
        .or_else(|| context.metadata.get("maxToolResultChars"))
        .or_else(|| context.metadata.get("max_tool_result_chars"))
        .or_else(|| {
            context
                .config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| {
                    defaults
                        .get("maxToolResultChars")
                        .or_else(|| defaults.get("max_tool_result_chars"))
                })
        })
        .or_else(|| context.config_snapshot.get("maxToolResultChars"))
        .or_else(|| context.config_snapshot.get("max_tool_result_chars"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn config_redaction_values(value: &Value) -> Vec<String> {
    let mut redactions = Vec::new();
    collect_config_redaction_values(value, None, &mut redactions);
    redactions
}

fn collect_config_redaction_values(value: &Value, key: Option<&str>, redactions: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (child_key, child_value) in map {
                collect_config_redaction_values(child_value, Some(child_key), redactions);
            }
        }
        Value::Array(values) => {
            for child_value in values {
                collect_config_redaction_values(child_value, key, redactions);
            }
        }
        Value::String(secret) => {
            let key = key.unwrap_or_default().to_ascii_lowercase();
            let sensitive_key = key.contains("api_key")
                || key.contains("apikey")
                || key.contains("token")
                || key.contains("secret")
                || key.contains("password");
            if sensitive_key && secret.chars().count() >= 4 {
                redactions.push(secret.clone());
            }
        }
        _ => {}
    }
}

fn redact_sensitive_text(text: &str, secrets: &[String], redactions: &mut Vec<String>) -> String {
    let mut redacted = text.to_string();
    for secret in secrets {
        if secret.is_empty() || !redacted.contains(secret) {
            continue;
        }
        redacted = redacted.replace(secret, "[REDACTED]");
        if !redactions.iter().any(|entry| entry == "config_secret") {
            redactions.push("config_secret".to_string());
        }
    }
    redacted
}

fn redact_sensitive_value(value: &mut Value, secrets: &[String], redactions: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            *text = redact_sensitive_text(text, secrets, redactions);
        }
        Value::Array(values) => {
            for child in values {
                redact_sensitive_value(child, secrets, redactions);
            }
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                redact_sensitive_value(child, secrets, redactions);
            }
        }
        _ => {}
    }
}

fn completed_tool_result_entry(
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
    status: &str,
    summary: &str,
) -> Value {
    serde_json::json!({
        "toolCallId": tool_call.id,
        "toolName": tool_call.name,
        "status": status,
        "summary": summary,
        "envelope": result.envelope,
    })
}

pub(super) fn legacy_tool_content(value: &Value) -> String {
    if let Some(content) = value.as_str() {
        return content.to_string();
    }
    if let Some(content) = value.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commit_tool_observation_rejects_a_malformed_envelope_without_partial_projection() {
        let context = AgentTurnContext::from_spec(
            json!({
                "turnId": "turn-malformed-tool-result",
                "sessionId": "session-malformed-tool-result",
                "messages": [{ "role": "user", "content": "run a tool" }]
            }),
            json!({}),
        );
        let mut state = AgentTurnState::new(&context, None).expect("state should initialize");
        let tool_call = NativeAgentToolCall {
            id: "call-malformed".to_string(),
            name: "workspace.read_file".to_string(),
            arguments_json: r#"{"path":"README.md"}"#.to_string(),
            result: Value::Null,
        };
        let mut result =
            NativeAgentToolResult::generic_success(&tool_call, json!({ "content": "README" }));
        result
            .envelope
            .as_object_mut()
            .expect("test envelope should be an object")
            .remove("status");

        let error = commit_tool_observation(&context, &mut state, 0, tool_call, result)
            .expect_err("malformed tool result must fail fast");

        assert!(error.contains("field `status` must be a string"));
        assert_eq!(state.history.messages().len(), 1);
        assert!(state.completed_tool_results.is_empty());
        assert!(state.runtime_events().is_empty());
    }
}
