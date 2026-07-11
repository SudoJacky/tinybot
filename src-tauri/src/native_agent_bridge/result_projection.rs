use crate::agent_loop_runtime_protocol::AgentRuntimeEventEnvelope;

const NATIVE_AGENT_RUN_TRACE_STRING_LIMIT: usize = 256;

pub(crate) fn native_agent_run_status(stop_reason: Option<&str>) -> &'static str {
    match stop_reason {
        Some("final_response") => "completed",
        Some("cancelled") => "cancelled",
        Some("interrupted") | Some("runtime_restarted") => "interrupted",
        Some("awaiting_approval")
        | Some("awaiting_form")
        | Some("awaiting_tool")
        | Some("tool_running")
        | Some("awaiting_subagent") => "waiting",
        Some(_) => "failed",
        None => "running",
    }
}

pub(crate) fn native_agent_run_phase_from_stop_reason(
    stop_reason: Option<&str>,
) -> Option<&'static str> {
    match stop_reason {
        Some("final_response") => Some("completed"),
        Some("cancelled") => Some("cancelled"),
        Some("interrupted") | Some("runtime_restarted") => Some("interrupted"),
        Some("awaiting_approval") => Some("awaiting_approval"),
        Some("awaiting_form") => Some("awaiting_form"),
        Some("awaiting_tool") => Some("tool_running"),
        Some(_) => Some("failed"),
        None => None,
    }
}

pub(crate) fn native_agent_run_completed_at(status: &str, timestamp: &str) -> Option<String> {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
        .then(|| timestamp.to_string())
}

pub(crate) fn native_agent_session_id(value: &serde_json::Value) -> Option<String> {
    native_agent_string_field(value, "sessionId")
        .or_else(|| native_agent_string_field(value, "session_id"))
        .or_else(|| native_agent_string_field(value, "activeSessionId"))
        .or_else(|| native_agent_string_field(value, "active_session_id"))
        .or_else(|| native_agent_string_field(value, "sessionKey"))
        .or_else(|| native_agent_string_field(value, "session_key"))
}

pub(crate) fn native_agent_run_id(value: &serde_json::Value) -> Option<String> {
    native_agent_string_field(value, "runId").or_else(|| native_agent_string_field(value, "run_id"))
}

pub(crate) fn native_agent_model(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
) -> String {
    native_agent_string_field(spec, "model")
        .or_else(|| native_agent_string_field(spec, "modelId"))
        .or_else(|| native_agent_string_field(spec, "model_id"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "model"))
        })
        .unwrap_or_else(|| crate::native_provider_runtime::configured_model(config_snapshot))
}

pub(crate) fn native_agent_provider(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
) -> Option<String> {
    native_agent_string_field(spec, "provider")
        .or_else(|| native_agent_string_field(spec, "providerId"))
        .or_else(|| native_agent_string_field(spec, "provider_id"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "provider"))
        })
        .or_else(|| {
            config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| native_agent_string_field(defaults, "provider"))
        })
}

pub(crate) fn native_agent_max_iterations(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
) -> i64 {
    spec.get("maxIterations")
        .or_else(|| spec.get("max_iterations"))
        .or_else(|| {
            spec.get("metadata").and_then(|metadata| {
                metadata
                    .get("maxIterations")
                    .or_else(|| metadata.get("max_iterations"))
            })
        })
        .or_else(|| {
            config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| {
                    defaults
                        .get("maxIterations")
                        .or_else(|| defaults.get("max_iterations"))
                })
        })
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
}

pub(crate) fn native_agent_current_iteration(
    result: &serde_json::Value,
    checkpoint: Option<&serde_json::Value>,
) -> i64 {
    checkpoint
        .and_then(|value| value.get("iteration"))
        .and_then(serde_json::Value::as_i64)
        .or_else(|| {
            result
                .get("events")
                .and_then(serde_json::Value::as_array)
                .and_then(|events| {
                    events
                        .iter()
                        .rev()
                        .filter_map(|event| event.get("payload"))
                        .filter_map(|payload| payload.get("iteration"))
                        .find_map(serde_json::Value::as_i64)
                })
        })
        .unwrap_or(0)
}

pub(crate) fn native_agent_usage(result: &serde_json::Value) -> Vec<serde_json::Value> {
    result
        .get("events")
        .and_then(serde_json::Value::as_array)
        .map(|events| {
            events
                .iter()
                .filter(|event| {
                    event.get("eventName").and_then(serde_json::Value::as_str)
                        == Some("agent.usage")
                })
                .filter_map(|event| event.get("payload"))
                .filter_map(|payload| payload.get("usage"))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn native_agent_token_usage_info(
    result: &serde_json::Value,
) -> Option<serde_json::Value> {
    let usage = native_agent_usage(result).into_iter().last()?;
    let last_total = usage_i64_field(
        &usage,
        &[
            "totalTokens",
            "total_tokens",
            "contextUsageTokens",
            "context_usage_tokens",
            "total",
        ],
    )
    .unwrap_or_default();
    let total_usage = usage_i64_field(
        &usage,
        &["cumulativeUsageTokens", "cumulative_usage_tokens"],
    )
    .unwrap_or(last_total);
    Some(serde_json::json!({
        "totalTokenUsage": {
            "inputTokens": 0,
            "cachedInputTokens": 0,
            "outputTokens": 0,
            "reasoningOutputTokens": 0,
            "totalTokens": total_usage,
        },
        "lastTokenUsage": {
            "inputTokens": usage_i64_field(&usage, &["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]).unwrap_or_default(),
            "cachedInputTokens": usage_i64_field(&usage, &["cachedInputTokens", "cached_input_tokens", "cachedTokens", "cached_tokens"]).unwrap_or_default(),
            "outputTokens": usage_i64_field(&usage, &["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]).unwrap_or_default(),
            "reasoningOutputTokens": usage_i64_field(&usage, &["reasoningOutputTokens", "reasoning_output_tokens", "reasoningTokens", "reasoning_tokens"]).unwrap_or_default(),
            "totalTokens": last_total,
        },
        "modelContextWindow": usage_i64_field(&usage, &["contextWindowTokens", "context_window_tokens"]),
    }))
}

pub(crate) fn native_agent_persisted_runtime_event(
    event: AgentRuntimeEventEnvelope,
) -> serde_json::Value {
    let value = serde_json::to_value(event).unwrap_or_else(|error| {
        serde_json::json!({
            "schemaVersion": crate::agent_loop_runtime_protocol::AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
            "eventName": "agent.trace.serialization_failed",
            "payload": {
                "error": error.to_string(),
            },
        })
    });
    native_agent_bound_persisted_trace_value(value).0
}

pub(crate) fn native_agent_trace_event_item_id(event: &serde_json::Value) -> Option<String> {
    event.get("payload").and_then(|payload| {
        native_agent_string_field(payload, "toolCallId")
            .or_else(|| native_agent_string_field(payload, "tool_call_id"))
            .or_else(|| native_agent_string_field(payload, "approvalId"))
            .or_else(|| native_agent_string_field(payload, "approval_id"))
            .or_else(|| native_agent_string_field(payload, "formId"))
            .or_else(|| native_agent_string_field(payload, "form_id"))
            .or_else(|| native_agent_string_field(payload, "delegateId"))
            .or_else(|| native_agent_string_field(payload, "delegate_id"))
    })
}

pub(crate) fn native_agent_persisted_trace_values(
    values: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    values
        .iter()
        .cloned()
        .map(|value| native_agent_bound_persisted_trace_value(value).0)
        .collect()
}

pub(crate) fn native_agent_artifacts(result: &serde_json::Value) -> Vec<serde_json::Value> {
    result
        .get("completedToolResults")
        .or_else(|| result.get("completed_tool_results"))
        .and_then(serde_json::Value::as_array)
        .map(|results| {
            results
                .iter()
                .flat_map(|result| {
                    result
                        .get("envelope")
                        .and_then(|envelope| envelope.get("artifacts"))
                        .and_then(serde_json::Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn native_agent_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn usage_i64_field(value: &serde_json::Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        })
    })
}

fn native_agent_bound_persisted_trace_value(value: serde_json::Value) -> (serde_json::Value, bool) {
    match value {
        serde_json::Value::String(content) => {
            let char_count = content.chars().count();
            if char_count <= NATIVE_AGENT_RUN_TRACE_STRING_LIMIT {
                (serde_json::Value::String(content), false)
            } else {
                (
                    serde_json::Value::String(
                        content
                            .chars()
                            .take(NATIVE_AGENT_RUN_TRACE_STRING_LIMIT)
                            .collect(),
                    ),
                    true,
                )
            }
        }
        serde_json::Value::Array(items) => {
            let mut truncated = false;
            let items = items
                .into_iter()
                .map(|item| {
                    let (item, item_truncated) = native_agent_bound_persisted_trace_value(item);
                    truncated |= item_truncated;
                    item
                })
                .collect();
            (serde_json::Value::Array(items), truncated)
        }
        serde_json::Value::Object(entries) => {
            let mut truncated = false;
            let mut entries = entries
                .into_iter()
                .map(|(key, value)| {
                    let (value, value_truncated) = native_agent_bound_persisted_trace_value(value);
                    truncated |= value_truncated;
                    (key, value)
                })
                .collect::<serde_json::Map<_, _>>();
            if truncated {
                entries.insert(
                    "tracePersistence".to_string(),
                    serde_json::json!({
                        "truncated": true,
                        "maxStringChars": NATIVE_AGENT_RUN_TRACE_STRING_LIMIT,
                    }),
                );
            }
            (serde_json::Value::Object(entries), truncated)
        }
        value => (value, false),
    }
}
