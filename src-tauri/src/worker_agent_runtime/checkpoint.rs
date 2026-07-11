use super::state::NativeAgentRunState;
use super::{
    string_field, NativeAgentRunContext, NativeAgentRuntimeServices, TEST_COMPAT_FAKE_CHECKPOINT,
};
use serde_json::Value;

pub(super) fn maybe_emit_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    default_phase: &str,
) {
    let Some(checkpoint_metadata) =
        test_compat_runtime_metadata(&context.metadata, TEST_COMPAT_FAKE_CHECKPOINT)
    else {
        return;
    };
    let phase =
        string_field(checkpoint_metadata, "phase").unwrap_or_else(|| default_phase.to_string());
    let checkpoint = checkpoint_value(context, &phase, checkpoint_metadata.clone());
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    state.emit_event(
        "agent.checkpoint",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "phase": phase,
            "checkpoint": checkpoint,
        }),
    );
}

pub(super) fn test_compat_runtime_metadata<'a>(
    metadata: &'a Value,
    key: &str,
) -> Option<&'a Value> {
    // Compatibility fixture hooks only. Normal runtime control should use typed
    // continuations, checkpoints, provider responses, or tool/subagent results.
    #[cfg(test)]
    {
        metadata.get(key)
    }
    #[cfg(not(test))]
    {
        let _ = (metadata, key);
        None
    }
}

pub(super) fn checkpoint_value(
    context: &NativeAgentRunContext,
    phase: &str,
    payload: Value,
) -> Value {
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
        "runId": context.run_id,
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
    context: &NativeAgentRunContext,
    phase: &str,
    payload: Value,
) -> Value {
    let checkpoint = checkpoint_value(context, phase, payload);
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    checkpoint
}
