use super::checkpoint::save_phase_checkpoint;
use super::events::{event, legacy_result_events_from_runtime_events};
use super::state::AgentTurnState;
use super::{AgentTurnContext, NativeAgentRuntimeServices};
use crate::agent::runtime_protocol::{AgentEventKind, TerminalEvent};
use serde_json::Value;

pub(super) fn error_result(
    turn_id: &str,
    session_id: &str,
    stop_reason: &str,
    message: &str,
) -> Value {
    let events = vec![event(
        AgentEventKind::Error,
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
        AgentEventKind::Cancelled,
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
    state: &mut AgentTurnState,
    iteration: i64,
) -> Result<Value, String> {
    let completed_tool_results = state.completed_tool_results.clone();
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
    state.emit(TerminalEvent::Cancelled(serde_json::json!({
        "iteration": iteration,
        "commandId": services.cancellations.command_id(&context.turn_id),
        "cancelled": true,
        "stopReason": "cancelled",
        "error": "cancelled",
    })))?;
    let runtime_events = state.take_runtime_events();
    let events = legacy_result_events_from_runtime_events(&runtime_events);
    Ok(serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "messages": [],
        "toolsUsed": std::mem::take(&mut state.tools_used),
        "completedToolResults": std::mem::take(&mut state.completed_tool_results),
        "error": "cancelled",
        "checkpoint": checkpoint,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}

pub(super) fn event_value(kind: AgentEventKind, payload: Value) -> Value {
    serde_json::json!({
        "eventName": kind.wire_name(),
        "payload": payload,
    })
}
