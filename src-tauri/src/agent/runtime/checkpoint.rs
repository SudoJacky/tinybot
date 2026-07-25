use super::{string_field, AgentTurnContext, NativeAgentRuntimeServices};
use serde_json::Value;

pub(super) fn checkpoint_value(context: &AgentTurnContext, phase: &str, payload: Value) -> Value {
    let activated_tool_ids = if matches!(
        phase,
        "cancelled"
            | "interrupted"
            | "runtime_restarted"
            | "completed"
            | "failed"
            | "final_response"
            | "max_iterations"
    ) {
        Vec::new()
    } else {
        context.tool_router.activated_tool_ids()
    };
    serde_json::json!({
        "schemaVersion": 1,
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "threadId": string_field(&context.metadata, "threadId")
            .or_else(|| string_field(&context.metadata, "thread_id")),
        "traceContext": context.trace_context,
        "phase": phase,
        "iteration": payload.get("iteration").cloned().unwrap_or(Value::Null),
        "maxIterations": context.max_iterations,
        "pendingToolCalls": checkpoint_pending_tool_calls(&payload),
        "activatedToolIds": activated_tool_ids,
        "completedToolResults": payload
            .get("completedToolResults")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "resumeToken": payload.get("resumeToken").cloned().unwrap_or(Value::Null),
        "stopReason": payload.get("stopReason").cloned().unwrap_or(Value::Null),
        "payload": payload,
        "messages": payload
            .get("messages")
            .cloned()
            .or_else(|| context.spec.get("messages").cloned())
            .unwrap_or_else(|| serde_json::json!([])),
    })
}

fn checkpoint_pending_tool_calls(payload: &Value) -> Value {
    if let Some(pending) = payload.get("pendingToolCalls") {
        return pending.clone();
    }
    let Some(tool_call_id) = payload.get("toolCallId").cloned() else {
        return serde_json::json!([]);
    };
    serde_json::json!([{
        "toolCallId": tool_call_id,
        "toolName": payload.get("toolName").cloned().unwrap_or(Value::Null),
        "argumentsJson": payload.get("argumentsJson").cloned().unwrap_or(Value::Null),
    }])
}

pub(super) fn save_phase_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    phase: &str,
    payload: Value,
) -> Value {
    let checkpoint = checkpoint_value(context, phase, payload);
    services
        .checkpoints
        .save_for_turn(&context.session_id, &context.turn_id, checkpoint.clone());
    checkpoint
}
