use super::item_event_projection::attach_agent_item;
use super::string_field;
use crate::agent::runtime_protocol::{
    AgentEventKind, AgentRuntimeEventAppendInput, AgentRuntimePhase, ItemIdentityRule,
    PendingAgentEvent,
};
use serde_json::Value;

pub(crate) fn standalone_runtime_event(
    turn_id: &str,
    session_id: &str,
    kind: AgentEventKind,
    payload: Value,
) -> crate::agent::runtime_protocol::AgentRuntimeEventEnvelope {
    let definition = kind.definition();
    let payload = attach_agent_item(kind, payload);
    let phase = definition
        .resolve_phase(&AgentRuntimePhase::Planning, &payload)
        .expect("typed standalone runtime event must resolve catalog metadata");
    crate::agent::runtime_protocol::AgentRuntimeEventEnvelope::from_event_kind(
        crate::agent::runtime_protocol::AgentRuntimeEventEnvelopeInput {
            session_id: session_id.to_string(),
            thread_id: None,
            turn_id: turn_id.to_string(),
            parent_turn_id: None,
            item_id: runtime_event_item_id(kind, &payload),
            event_kind: kind,
            phase,
            sequence: 1,
            timestamp: runtime_event_timestamp(),
            trace_context: None,
            payload,
        },
    )
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
        event_kind: kind,
        phase,
        timestamp,
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
