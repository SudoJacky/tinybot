use super::events::event;
use super::tool_dispatcher::is_subagent_tool;
use super::{
    string_field, NativeAgentEvent, NativeAgentRunContext, NativeAgentToolCall,
    NativeAgentToolResult,
};
use serde_json::Value;

pub(super) fn assistant_tool_calls_message(
    content: &str,
    tool_calls: &[NativeAgentToolCall],
) -> Value {
    serde_json::json!({
        "role": "assistant",
        "content": content,
        "tool_calls": tool_calls
            .iter()
            .map(|tool_call| {
                serde_json::json!({
                    "id": tool_call.id,
                    "type": "function",
                    "function": {
                        "name": tool_call.name,
                        "arguments": tool_call.arguments_json,
                    }
                })
            })
            .collect::<Vec<_>>()
    })
}

pub(super) fn tool_observation_message(tool_call: &NativeAgentToolCall, content: &str) -> Value {
    serde_json::json!({
        "role": "tool",
        "tool_call_id": tool_call.id,
        "name": tool_call.name,
        "content": content,
    })
}

pub(super) fn tool_observation_content(result: &NativeAgentToolResult) -> String {
    if let Some(content) = result.envelope.get("modelContent").and_then(Value::as_str) {
        return content.to_string();
    }
    legacy_tool_content(&result.content)
}

pub(super) fn subagent_link_event_from_tool_result(
    context: &NativeAgentRunContext,
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
) -> Option<NativeAgentEvent> {
    if !matches!(tool_call.name.as_str(), "subagent.spawn" | "spawn_agent") {
        return None;
    }
    let raw = result.envelope.get("raw")?;
    if raw.get("accepted").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let subagent = raw.get("subagent")?;
    let subagent_id = string_field(subagent, "subagentId").or_else(|| {
        raw.get("event")
            .and_then(|event| string_field(event, "delegateId"))
    })?;
    let child_run_id = string_field(subagent, "childRunId")
        .or_else(|| {
            raw.get("event")
                .and_then(|event| string_field(event, "childRunId"))
        })
        .unwrap_or_else(|| subagent_id.clone());
    Some(event(
        "agent.delegate.linked",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "parentTurnId": context.run_id,
            "parentRunId": context.run_id,
            "delegateId": subagent_id,
            "subagentId": subagent_id,
            "childRunId": child_run_id,
            "traceRef": subagent.get("traceRef").cloned().unwrap_or(Value::Null),
            "name": subagent.get("name").cloned().unwrap_or(Value::Null),
            "task": subagent.get("task").cloned().unwrap_or(Value::Null),
            "status": subagent.get("status").cloned().unwrap_or(Value::Null),
            "linkType": "parent_child",
            "sourceToolCallId": tool_call.id,
        }),
    ))
}

pub(super) fn subagent_activity_events_from_tool_result(
    context: &NativeAgentRunContext,
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
) -> Vec<NativeAgentEvent> {
    if !is_subagent_tool(&tool_call.name) {
        return Vec::new();
    }
    let Some(raw) = result.envelope.get("raw") else {
        return Vec::new();
    };
    let mut events = Vec::new();
    if let Some(background_event) = raw.get("event") {
        if background_event.get("eventType").and_then(Value::as_str)
            != Some("agent.delegate.started")
        {
            if let Some(event) = subagent_background_activity_event(context, background_event) {
                events.push(event);
            }
        }
    }

    match tool_call.name.as_str() {
        "subagent.wait" | "wait_agent" => {
            events.push(event(
                "agent.delegate.wait",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "parentTurnId": context.run_id,
                    "parentRunId": context.run_id,
                    "timedOut": raw.get("timedOut").cloned().unwrap_or(Value::Null),
                    "statuses": raw.get("statuses").cloned().unwrap_or_else(|| serde_json::json!([])),
                    "sourceToolCallId": tool_call.id,
                }),
            ));
            if let Some(statuses) = raw.get("statuses").and_then(Value::as_array) {
                for status in statuses {
                    if status
                        .get("terminalResult")
                        .and_then(Value::as_str)
                        .is_some()
                    {
                        events.push(subagent_status_activity_event(
                            context,
                            "agent.delegate.result",
                            "result",
                            status,
                            &tool_call.id,
                        ));
                    }
                    if status
                        .get("blockerSummary")
                        .and_then(Value::as_str)
                        .is_some()
                        || status
                            .get("pendingApproval")
                            .is_some_and(|value| !value.is_null())
                    {
                        events.push(subagent_status_activity_event(
                            context,
                            "agent.delegate.notification",
                            "notification",
                            status,
                            &tool_call.id,
                        ));
                    }
                }
            }
        }
        "subagent.query" => {
            if let Some(subagent) = raw.get("subagent") {
                events.push(subagent_status_activity_event(
                    context,
                    "agent.delegate.queried",
                    "query",
                    subagent,
                    &tool_call.id,
                ));
            }
        }
        _ => {}
    }
    events
}

fn subagent_background_activity_event(
    context: &NativeAgentRunContext,
    background_event: &Value,
) -> Option<NativeAgentEvent> {
    let event_name = string_field(background_event, "eventType")?;
    let mut payload = background_event
        .get("payload")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    payload.insert("runId".to_string(), Value::String(context.run_id.clone()));
    payload.insert(
        "sessionId".to_string(),
        Value::String(context.session_id.clone()),
    );
    if let Some(parent_turn_id) = string_field(background_event, "turnId") {
        payload.insert(
            "parentTurnId".to_string(),
            Value::String(parent_turn_id.clone()),
        );
        payload.insert("parentRunId".to_string(), Value::String(parent_turn_id));
    }
    if let Some(delegate_id) = string_field(background_event, "delegateId") {
        payload.insert("delegateId".to_string(), Value::String(delegate_id.clone()));
        payload.insert("subagentId".to_string(), Value::String(delegate_id));
    }
    if let Some(child_run_id) = string_field(background_event, "childRunId") {
        payload.insert("childRunId".to_string(), Value::String(child_run_id));
    }
    if let Some(trace_ref) = string_field(background_event, "traceRef") {
        payload.insert("traceRef".to_string(), Value::String(trace_ref));
    }
    if let Some(sequence) = background_event.get("sequence").cloned() {
        payload.insert("delegateSequence".to_string(), sequence);
    }
    if let Some(event_id) = string_field(background_event, "eventId") {
        payload.insert("delegateEventId".to_string(), Value::String(event_id));
    }
    Some(event(&event_name, Value::Object(payload)))
}

fn subagent_status_activity_event(
    context: &NativeAgentRunContext,
    event_name: &str,
    activity: &str,
    subagent: &Value,
    source_tool_call_id: &str,
) -> NativeAgentEvent {
    event(
        event_name,
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "parentTurnId": subagent.get("parentRunId").cloned().unwrap_or_else(|| Value::String(context.run_id.clone())),
            "parentRunId": subagent.get("parentRunId").cloned().unwrap_or_else(|| Value::String(context.run_id.clone())),
            "delegateId": subagent.get("subagentId").cloned().unwrap_or(Value::Null),
            "subagentId": subagent.get("subagentId").cloned().unwrap_or(Value::Null),
            "childRunId": subagent.get("childRunId").cloned().unwrap_or(Value::Null),
            "traceRef": subagent.get("traceRef").cloned().unwrap_or(Value::Null),
            "name": subagent.get("name").cloned().unwrap_or(Value::Null),
            "task": subagent.get("task").cloned().unwrap_or(Value::Null),
            "status": subagent.get("status").cloned().unwrap_or(Value::Null),
            "terminalResult": subagent.get("terminalResult").cloned().unwrap_or(Value::Null),
            "blockerSummary": subagent.get("blockerSummary").cloned().unwrap_or(Value::Null),
            "pendingApproval": subagent.get("pendingApproval").cloned().unwrap_or(Value::Null),
            "activity": activity,
            "sourceToolCallId": source_tool_call_id,
        }),
    )
}

pub(super) fn normalize_tool_result_for_context(
    mut result: NativeAgentToolResult,
    context: &NativeAgentRunContext,
) -> NativeAgentToolResult {
    let secrets = config_redaction_values(&context.config_snapshot);
    let max_model_chars = configured_max_tool_result_chars(context);
    let mut redactions = Vec::new();
    let mut model_content = result
        .envelope
        .get("modelContent")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| legacy_tool_content(&result.content));
    model_content = redact_sensitive_text(&model_content, &secrets, &mut redactions);
    let original_model_chars = model_content.chars().count();
    let mut truncated = false;
    if let Some(max_model_chars) = max_model_chars {
        if original_model_chars > max_model_chars {
            model_content = model_content.chars().take(max_model_chars).collect();
            truncated = true;
        }
    }

    if let Some(envelope) = result.envelope.as_object_mut() {
        envelope.insert(
            "modelContent".to_string(),
            Value::String(model_content.clone()),
        );
        let summary = envelope
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| model_content.clone());
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
    }
    result.content = Value::String(model_content);
    result
}

fn configured_max_tool_result_chars(context: &NativeAgentRunContext) -> Option<usize> {
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

pub(super) fn completed_tool_result_entry(
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
) -> Value {
    serde_json::json!({
        "toolCallId": tool_call.id,
        "toolName": tool_call.name,
        "status": result
            .envelope
            .get("status")
            .cloned()
            .unwrap_or_else(|| serde_json::json!("ok")),
        "summary": result
            .envelope
            .get("summary")
            .cloned()
            .unwrap_or_else(|| result.content.clone()),
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
