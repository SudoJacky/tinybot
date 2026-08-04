use super::checkpoint::save_phase_checkpoint;
use super::events::standalone_runtime_event;
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
    let runtime_events = vec![standalone_runtime_event(
        turn_id,
        session_id,
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
        "runtimeEvents": runtime_events,
    })
}

pub(super) fn cancelled_result(
    services: &NativeAgentRuntimeServices,
    turn_id: &str,
    session_id: &str,
    checkpoint: Value,
) -> Value {
    let stop_reason = cancellation_stop_reason(services, turn_id);
    let runtime_events = vec![standalone_runtime_event(
        turn_id,
        session_id,
        AgentEventKind::Cancelled,
        serde_json::json!({
            "turnId": turn_id,
            "sessionId": session_id,
            "commandId": services.cancellations.command_id(turn_id),
            "cancelled": true,
            "stopReason": stop_reason,
            "error": stop_reason,
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "turnId": turn_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "error": stop_reason,
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "runtimeEvents": runtime_events,
    })
}

pub(super) fn cancelled_turn_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
) -> Result<Value, String> {
    let stop_reason = cancellation_stop_reason(services, &context.turn_id);
    let completed_tool_results = state.completed_tool_results.clone();
    let checkpoint = save_phase_checkpoint(
        services,
        context,
        stop_reason,
        serde_json::json!({
            "cancelled": true,
            "iteration": iteration,
            "completedToolResults": completed_tool_results.clone(),
            "stopReason": stop_reason,
        }),
    );
    state.emit(TerminalEvent::Cancelled(serde_json::json!({
        "iteration": iteration,
        "commandId": services.cancellations.command_id(&context.turn_id),
        "cancelled": true,
        "stopReason": stop_reason,
        "error": stop_reason,
    })))?;
    let runtime_events = state.take_runtime_events();
    Ok(serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "messages": [],
        "toolsUsed": std::mem::take(&mut state.tools_used),
        "completedToolResults": std::mem::take(&mut state.completed_tool_results),
        "error": stop_reason,
        "checkpoint": checkpoint,
        "runtimeEvents": runtime_events,
    }))
}

fn cancellation_stop_reason(services: &NativeAgentRuntimeServices, turn_id: &str) -> &'static str {
    if services
        .task_runtime
        .status(turn_id)
        .and_then(|status| status.cancellation_reason)
        .as_deref()
        == Some("user_requested")
    {
        "interrupted"
    } else {
        "cancelled"
    }
}
