use super::item_event_projection::attach_agent_item;
use super::{string_field, NativeAgentEvent};
use crate::agent::runtime_protocol::{
    project_legacy_native_agent_event, resolve_event_name, AgentEventKind,
    AgentRuntimeEventAppendInput, AgentRuntimeEventEnvelope, AgentRuntimePhase,
    EventNameResolution, ItemIdentityRule, LegacyPolicy, PendingAgentEvent,
};
use serde_json::Value;

pub(super) fn event(kind: AgentEventKind, payload: Value) -> NativeAgentEvent {
    let definition = kind.definition();
    NativeAgentEvent {
        event_name: definition.wire_name.to_string(),
        payload: attach_agent_item(kind, payload),
    }
}

pub(super) fn legacy_result_events_from_runtime_events(
    runtime_events: &[AgentRuntimeEventEnvelope],
) -> Vec<NativeAgentEvent> {
    runtime_events
        .iter()
        .filter_map(|event| match resolve_event_name(&event.event_name) {
            EventNameResolution::Canonical(kind)
                if kind.definition().legacy == LegacyPolicy::Include =>
            {
                Some(NativeAgentEvent::from(project_legacy_native_agent_event(
                    event,
                )))
            }
            EventNameResolution::Canonical(_) => None,
            EventNameResolution::DeprecatedIgnored(_) => {
                log_deprecated_event_ignored(event);
                None
            }
            EventNameResolution::Unknown => {
                panic!(
                    "unknown legacy runtime event `{}` cannot be projected",
                    event.event_name
                )
            }
        })
        .collect()
}

pub(super) fn runtime_status_label(phase: &AgentRuntimePhase) -> Option<&'static str> {
    match phase {
        AgentRuntimePhase::CallingModel => Some("Calling model"),
        AgentRuntimePhase::StreamingModel => Some("Streaming response"),
        AgentRuntimePhase::ToolCalling => Some("Preparing tool call"),
        AgentRuntimePhase::ToolRunning => Some("Running tool"),
        AgentRuntimePhase::AwaitingForm => Some("Waiting for form input"),
        AgentRuntimePhase::AwaitingSubagent => Some("Waiting for subagent"),
        AgentRuntimePhase::Paused => Some("Paused"),
        AgentRuntimePhase::Finalizing => Some("Finalizing response"),
        AgentRuntimePhase::Completed => Some("Completed"),
        AgentRuntimePhase::Failed => Some("Failed"),
        AgentRuntimePhase::Cancelling => Some("Cancelling"),
        AgentRuntimePhase::Cancelled => Some("Cancelled"),
        AgentRuntimePhase::Queued
        | AgentRuntimePhase::HydratingHistory
        | AgentRuntimePhase::Planning => None,
    }
}

pub(super) fn runtime_event_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub(super) fn prepare_runtime_event_input(
    session_id: &str,
    turn_id: &str,
    current_phase: &AgentRuntimePhase,
    timestamp: String,
    event: PendingAgentEvent,
) -> Result<AgentRuntimeEventAppendInput, String> {
    let (kind, payload, parent_turn_id, explicit_item_id) = event.into_parts();
    let definition = kind.definition();
    let payload = attach_runtime_identity(payload, session_id, turn_id, definition.wire_name)?;
    let payload = attach_agent_item(kind, payload);
    let item_id = explicit_item_id.or_else(|| runtime_event_item_id(kind, &payload));
    let phase = definition.resolve_phase(current_phase, &payload)?;
    Ok(AgentRuntimeEventAppendInput {
        parent_turn_id,
        item_id,
        event_name: definition.wire_name.to_string(),
        phase,
        timestamp,
        source: definition.source,
        visibility: definition.visibility,
        payload,
    })
}

pub(super) fn runtime_event_item_id(kind: AgentEventKind, payload: &Value) -> Option<String> {
    if let Some(item_id) = string_field(payload.get("agentItem").unwrap_or(&Value::Null), "id") {
        return Some(item_id);
    }
    match kind.definition().identity {
        ItemIdentityRule::Message => string_field(payload, "messageId")
            .or_else(|| string_field(payload, "message_id"))
            .or_else(|| string_field(payload, "modelCallId").map(|id| format!("assistant:{id}"))),
        ItemIdentityRule::Reasoning => string_field(payload, "reasoningId")
            .or_else(|| string_field(payload, "reasoning_id"))
            .or_else(|| string_field(payload, "modelCallId").map(|id| format!("reasoning:{id}"))),
        ItemIdentityRule::Tool => string_field(payload, "toolCallId")
            .or_else(|| string_field(payload, "tool_call_id"))
            .or_else(|| string_field(payload, "id")),
        ItemIdentityRule::Form => {
            string_field(payload, "formId").or_else(|| string_field(payload, "form_id"))
        }
        ItemIdentityRule::Delegate => {
            string_field(payload, "delegateId").or_else(|| string_field(payload, "delegate_id"))
        }
        ItemIdentityRule::None | ItemIdentityRule::AgentItem => None,
    }
}

fn attach_runtime_identity(
    payload: Value,
    session_id: &str,
    turn_id: &str,
    event_name: &str,
) -> Result<Value, String> {
    let mut payload = payload.as_object().cloned().ok_or_else(|| {
        format!("canonical runtime event `{event_name}` payload must be an object")
    })?;
    validate_identity_field(&payload, "sessionId", session_id, event_name)?;
    validate_identity_field(&payload, "turnId", turn_id, event_name)?;
    payload.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    payload.insert("turnId".to_string(), Value::String(turn_id.to_string()));
    Ok(Value::Object(payload))
}

fn validate_identity_field(
    payload: &serde_json::Map<String, Value>,
    field: &str,
    expected: &str,
    event_name: &str,
) -> Result<(), String> {
    let Some(value) = payload.get(field) else {
        return Ok(());
    };
    let actual = value.as_str().ok_or_else(|| {
        format!("canonical runtime event `{event_name}` field `{field}` must be a string")
    })?;
    if actual != expected {
        return Err(format!(
            "canonical runtime event `{event_name}` field `{field}` is `{actual}`, expected `{expected}`"
        ));
    }
    Ok(())
}

pub(super) fn log_deprecated_event_ignored(event: &AgentRuntimeEventEnvelope) {
    eprintln!(
        "agent_runtime_deprecated_event_ignored event_name={} session_id={} turn_id={}",
        event.event_name, event.session_id, event.turn_id
    );
}
