use super::{string_field, NativeAgentEvent};
use crate::agent_loop_runtime_protocol::{
    project_legacy_native_agent_events, AgentRuntimeEventEnvelope, AgentRuntimeEventSource,
    AgentRuntimeEventVisibility, AgentRuntimePhase,
};
use serde_json::Value;

pub(super) fn event(event_name: &str, payload: Value) -> NativeAgentEvent {
    NativeAgentEvent {
        event_name: event_name.to_string(),
        payload,
    }
}

pub(super) fn legacy_result_events_from_runtime_events(
    runtime_events: &[AgentRuntimeEventEnvelope],
) -> Vec<NativeAgentEvent> {
    project_legacy_native_agent_events(runtime_events)
        .into_iter()
        .filter(|event| {
            event.event_name != "agent.turn.started"
                && event.event_name != "agent.phase.changed"
                && event.event_name != "agent.status"
        })
        .map(NativeAgentEvent::from)
        .collect()
}

pub(super) fn runtime_status_label(phase: &AgentRuntimePhase) -> Option<&'static str> {
    match phase {
        AgentRuntimePhase::CallingModel => Some("Calling model"),
        AgentRuntimePhase::StreamingModel => Some("Streaming response"),
        AgentRuntimePhase::ToolCalling => Some("Preparing tool call"),
        AgentRuntimePhase::ToolRunning => Some("Running tool"),
        AgentRuntimePhase::AwaitingApproval => Some("Waiting for approval"),
        AgentRuntimePhase::AwaitingForm => Some("Waiting for form input"),
        AgentRuntimePhase::AwaitingSubagent => Some("Waiting for subagent"),
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

pub(super) fn runtime_event_item_id(event_name: &str, payload: &Value) -> Option<String> {
    match event_name {
        "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" => {
            string_field(payload, "toolCallId")
                .or_else(|| string_field(payload, "tool_call_id"))
                .or_else(|| string_field(payload, "id"))
        }
        "agent.awaiting_approval" | "agent.approval.decision" => {
            string_field(payload, "approvalId").or_else(|| string_field(payload, "approval_id"))
        }
        "agent.awaiting_form" | "agent.form.resolution" => {
            string_field(payload, "formId").or_else(|| string_field(payload, "form_id"))
        }
        _ if event_name.starts_with("agent.delegate.") => {
            string_field(payload, "delegateId").or_else(|| string_field(payload, "delegate_id"))
        }
        _ => None,
    }
}

pub(super) fn runtime_event_source(event_name: &str) -> AgentRuntimeEventSource {
    match event_name {
        "agent.delta" | "agent.reasoning_delta" | "agent.usage" => {
            AgentRuntimeEventSource::Provider
        }
        "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" => {
            AgentRuntimeEventSource::Tool
        }
        "agent.guidance" | "agent.approval.decision" | "agent.form.resolution" => {
            AgentRuntimeEventSource::User
        }
        _ if event_name.starts_with("agent.delegate.") => AgentRuntimeEventSource::Subagent,
        _ => AgentRuntimeEventSource::RustBackend,
    }
}

pub(super) fn runtime_event_visibility(event_name: &str) -> AgentRuntimeEventVisibility {
    match event_name {
        "agent.checkpoint" | "agent.usage" | "agent.done" | "agent.phase.changed" => {
            AgentRuntimeEventVisibility::Debug
        }
        _ => AgentRuntimeEventVisibility::User,
    }
}
