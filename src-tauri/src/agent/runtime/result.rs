use super::checkpoint::save_phase_checkpoint;
use super::events::{event, legacy_result_events_from_runtime_events, runtime_event_timestamp};
use super::item_event_projection::attach_agent_item;
use super::{AgentTurnContext, NativeAgentRuntimeServices};
use crate::agent::runtime_protocol::{AgentRuntimeEventEnvelope, AgentTurnEmitter};
use serde_json::Value;

pub(super) fn error_result(
    turn_id: &str,
    session_id: &str,
    stop_reason: &str,
    message: &str,
) -> Value {
    let events = vec![event(
        "agent.error",
        serde_json::json!({
            "turnId": turn_id,
            "sessionId": session_id,
            "stopReason": stop_reason,
            "message": message,
            "error": message,
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "turnId": turn_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "messages": [],
        "toolsUsed": [],
        "error": message,
        "events": events,
    })
}

pub(super) fn cancelled_result(
    services: &NativeAgentRuntimeServices,
    turn_id: &str,
    session_id: &str,
    checkpoint: Value,
) -> Value {
    let events = vec![event(
        "agent.cancelled",
        serde_json::json!({
            "turnId": turn_id,
            "sessionId": session_id,
            "commandId": services.cancellations.command_id(turn_id),
            "cancelled": true,
            "stopReason": "cancelled",
            "error": "cancelled",
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "turnId": turn_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "error": "cancelled",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
    })
}

pub(super) fn cancelled_turn_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    mut runtime_events: Vec<AgentRuntimeEventEnvelope>,
    tools_used: Vec<String>,
    completed_tool_results: Vec<Value>,
    iteration: i64,
) -> Value {
    let checkpoint = save_phase_checkpoint(
        services,
        context,
        "cancelled",
        serde_json::json!({
            "cancelled": true,
            "iteration": iteration,
            "completedToolResults": completed_tool_results.clone(),
            "stopReason": "cancelled",
        }),
    );
    let mut emitter = AgentTurnEmitter::from_existing_events_with_thread_id(
        &context.session_id,
        &context.turn_id,
        context.thread_id.clone(),
        &runtime_events,
    );
    runtime_events.push(emitter.cancelled_with_payload(
        runtime_event_timestamp(),
        "cancelled",
        attach_agent_item(
            "agent.cancelled",
            serde_json::json!({
                "turnId": context.turn_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "commandId": services.cancellations.command_id(&context.turn_id),
                "cancelled": true,
                "stopReason": "cancelled",
                "error": "cancelled",
            }),
        ),
    ));
    let events = legacy_result_events_from_runtime_events(&runtime_events);
    serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "messages": [],
        "toolsUsed": tools_used,
        "completedToolResults": completed_tool_results,
        "error": "cancelled",
        "checkpoint": checkpoint,
        "events": events,
        "runtimeEvents": runtime_events,
    })
}

pub(super) fn event_value(event_name: &str, payload: Value) -> Value {
    serde_json::json!({
        "eventName": event_name,
        "payload": payload,
    })
}
