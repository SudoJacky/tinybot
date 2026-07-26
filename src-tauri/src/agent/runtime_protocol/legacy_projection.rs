use super::appender::deterministic_event_id;
use super::{
    resolve_event_name, AgentRuntimeEventEnvelope, AgentRuntimeEventSource,
    AgentRuntimeEventVisibility, AgentRuntimePhase, EventNameResolution,
    LegacyNativeAgentEventEnvelopeInput, LegacyNativeAgentEventProjection,
    AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
};

#[cfg(test)]
pub fn project_legacy_native_agent_events(
    events: &[AgentRuntimeEventEnvelope],
) -> Vec<LegacyNativeAgentEventProjection> {
    events
        .iter()
        .filter_map(|event| match resolve_event_name(&event.event_name) {
            EventNameResolution::Canonical(_) => Some(project_legacy_native_agent_event(event)),
            EventNameResolution::DeprecatedIgnored(kind) => {
                eprintln!(
                    "agent_runtime_deprecated_event_ignored event_name={} session_id={} turn_id={} terminal_reason=deprecated_provider_lifecycle",
                    kind.wire_name(),
                    event.session_id,
                    event.turn_id,
                );
                None
            }
            EventNameResolution::Unknown => {
                eprintln!(
                    "agent_runtime_unknown_legacy_projection event_name={} session_id={} turn_id={}",
                    event.event_name, event.session_id, event.turn_id,
                );
                None
            }
        })
        .collect()
}

pub fn project_legacy_native_agent_event(
    event: &AgentRuntimeEventEnvelope,
) -> LegacyNativeAgentEventProjection {
    LegacyNativeAgentEventProjection {
        event_name: event.event_name.clone(),
        payload: event.payload.clone(),
    }
}

impl AgentRuntimeEventEnvelope {
    pub fn from_legacy_native_event(input: LegacyNativeAgentEventEnvelopeInput) -> Self {
        let (phase, source, visibility) = match resolve_event_name(&input.event_name) {
            EventNameResolution::Canonical(kind) => {
                let definition = kind.definition();
                (
                    AgentRuntimePhase::for_legacy_event(&input.event_name),
                    definition.source,
                    definition.visibility,
                )
            }
            EventNameResolution::DeprecatedIgnored(kind) => {
                (kind.phase(), kind.source(), kind.visibility())
            }
            EventNameResolution::Unknown => {
                eprintln!(
                    "agent_runtime_unknown_legacy_event event_name={} session_id={} turn_id={}",
                    input.event_name, input.session_id, input.turn_id
                );
                (
                    AgentRuntimePhase::Planning,
                    AgentRuntimeEventSource::RustBackend,
                    AgentRuntimeEventVisibility::Debug,
                )
            }
        };
        Self {
            schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
            event_id: deterministic_event_id(&input.turn_id, &input.event_name, input.sequence),
            sequence: input.sequence,
            session_id: input.session_id,
            thread_id: input.thread_id,
            turn_id: input.turn_id,
            parent_turn_id: input.parent_turn_id,
            item_id: input.item_id,
            event_name: input.event_name,
            phase,
            timestamp: input.timestamp,
            source,
            visibility,
            trace_context: None,
            payload: input.payload,
        }
    }
}
