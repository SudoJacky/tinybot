use super::item_event_projection::attach_agent_item;
use super::{string_field, NativeAgentEvent};
use crate::agent_loop_runtime_protocol::{
    project_legacy_native_agent_events, AgentRuntimeEventEnvelope, AgentRuntimeEventSource,
    AgentRuntimeEventVisibility, AgentRuntimePhase,
};
use serde_json::Value;

pub(super) fn event(event_name: &str, payload: Value) -> NativeAgentEvent {
    NativeAgentEvent {
        event_name: event_name.to_string(),
        payload: attach_agent_item(event_name, payload),
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
                && event.event_name != "agent.hook.decision"
                && event.event_name != "agent.provider.requested"
                && event.event_name != "agent.provider.completed"
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

pub(super) fn runtime_event_item_id(event_name: &str, payload: &Value) -> Option<String> {
    if let Some(item_id) = string_field(payload.get("agentItem").unwrap_or(&Value::Null), "id") {
        return Some(item_id);
    }
    match event_name {
        "agent.delta"
        | "agent.message.phase"
        | "agent.message.classified"
        | "agent.message.completed" => string_field(payload, "messageId")
            .or_else(|| string_field(payload, "message_id"))
            .or_else(|| string_field(payload, "modelCallId").map(|id| format!("assistant:{id}"))),
        "agent.reasoning_delta" => string_field(payload, "reasoningId")
            .or_else(|| string_field(payload, "reasoning_id"))
            .or_else(|| string_field(payload, "modelCallId").map(|id| format!("reasoning:{id}"))),
        "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" | "agent.tool.debug" => {
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
        "agent.delta"
        | "agent.message.phase"
        | "agent.message.classified"
        | "agent.message.completed"
        | "agent.reasoning_delta"
        | "agent.usage"
        | "agent.provider.requested"
        | "agent.provider.completed" => AgentRuntimeEventSource::Provider,
        "agent.tool_call.delta"
        | "agent.tool.start"
        | "agent.tool.result"
        | "agent.tool.debug"
        | "agent.plan.progress" => AgentRuntimeEventSource::Tool,
        "agent.guidance" | "agent.approval.decision" | "agent.form.resolution" => {
            AgentRuntimeEventSource::User
        }
        _ if event_name.starts_with("agent.delegate.") => AgentRuntimeEventSource::Subagent,
        _ => AgentRuntimeEventSource::RustBackend,
    }
}

pub(super) fn runtime_event_visibility(event_name: &str) -> AgentRuntimeEventVisibility {
    match event_name {
        "agent.checkpoint"
        | "agent.usage"
        | "agent.done"
        | "agent.phase.changed"
        | "agent.tool.debug"
        | "agent.hook.decision"
        | "agent.provider.requested"
        | "agent.provider.completed"
        | "agent.context.hydrated" => AgentRuntimeEventVisibility::Debug,
        _ => AgentRuntimeEventVisibility::User,
    }
}
