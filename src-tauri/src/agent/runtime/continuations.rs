use super::{AgentTurnContext, NativeAgentRuntimeServices};
use crate::agent::runtime_protocol::AgentContinuationInput;
use serde_json::Value;

pub(super) fn restore_activated_tools_for_continuation(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
) -> Result<(), String> {
    let Some(AgentContinuationInput::Form { form_id, .. }) = context.continuation.clone() else {
        return Ok(());
    };
    let checkpoint = services
        .checkpoints
        .restore_for_turn(&context.session_id, &context.turn_id)
        .ok_or_else(|| "form continuations require a matching turn checkpoint".to_string())?;
    let checkpoint_kind = checkpoint.pointer("/payload/kind").and_then(Value::as_str);
    if checkpoint_kind != Some("user_input") {
        return Err(format!(
            "unsupported continuation checkpoint kind: {}",
            checkpoint_kind.unwrap_or("missing")
        ));
    }
    if checkpoint.get("phase").and_then(Value::as_str) != Some("awaiting_form") {
        return Err("invalid form checkpoint: phase must be awaiting_form".to_string());
    }
    let expected_form_id = checkpoint
        .pointer("/payload/formId")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid user input checkpoint: formId is missing".to_string())?;
    if form_id != expected_form_id {
        return Err(format!(
            "form continuation ID `{form_id}` does not match checkpoint `{expected_form_id}`"
        ));
    }
    context
        .tool_router
        .restore_from_checkpoint(&checkpoint)
        .map_err(|error| format!("failed to restore activated tools from checkpoint: {error}"))
}

pub(super) fn queued_user_continuation_message(
    continuation: Option<&AgentContinuationInput>,
) -> Option<Value> {
    let AgentContinuationInput::QueuedUserMessage { content, .. } = continuation? else {
        return None;
    };
    user_continuation_message(content.clone())
}

pub(super) fn guidance_continuation_message(
    continuation: Option<&AgentContinuationInput>,
) -> Option<Value> {
    let AgentContinuationInput::Guidance { content, .. } = continuation? else {
        return None;
    };
    user_continuation_message(content.clone())
}

fn user_continuation_message(content: String) -> Option<Value> {
    if content.trim().is_empty() {
        None
    } else {
        Some(serde_json::json!({ "role": "user", "content": content }))
    }
}
