use super::events::event;
use super::result::cancelled_result;
use super::state::AgentTurnState;
use super::tool_projection::{commit_tool_observation, prepare_continuation_tool_observation};
use super::tool_runtime::{dispatch_owned_tool_call, OwnedToolCallResult};
use super::{
    string_field, AgentTurnContext, NativeAgentEvent, NativeAgentRuntimeServices,
    NativeAgentToolCall, NativeAgentToolResult, NativeToolResultEnvelope,
};
use crate::agent::runtime_protocol::{
    AgentApprovalDecision, AgentApprovalScope, AgentContinuationInput, AgentEventKind,
    AgentRuntimeEventEnvelope, PendingAgentEvent,
};
use serde_json::Value;

pub(super) fn typed_continuation_from_metadata(metadata: &Value) -> Option<AgentContinuationInput> {
    metadata
        .get("agentContinuation")
        .or_else(|| metadata.get("continuation"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(super) fn restore_activated_tools_for_continuation(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
) -> Result<(), String> {
    let Some(continuation) = typed_continuation_from_metadata(&context.metadata) else {
        return Ok(());
    };
    if !matches!(
        &continuation,
        AgentContinuationInput::Approval { .. } | AgentContinuationInput::Form { .. }
    ) {
        return Ok(());
    }
    let checkpoint = services
        .checkpoints
        .restore_for_turn(&context.session_id, &context.turn_id)
        .ok_or_else(|| {
            "approval and form continuations require a matching turn checkpoint".to_string()
        })?;
    let checkpoint_kind = checkpoint.pointer("/payload/kind").and_then(Value::as_str);
    let is_approval_checkpoint = checkpoint_kind == Some("tool_approval");
    let is_form_checkpoint = checkpoint_kind == Some("user_input");
    if is_approval_checkpoint {
        if checkpoint.get("phase").and_then(Value::as_str) != Some("awaiting_approval") {
            return Err("invalid approval checkpoint: phase must be awaiting_approval".to_string());
        }
        let expected_approval_id = checkpoint
            .pointer("/payload/approvalId")
            .and_then(Value::as_str)
            .ok_or_else(|| "invalid tool approval checkpoint: approvalId is missing".to_string())?;
        let AgentContinuationInput::Approval { approval_id, .. } = &continuation else {
            return Err(
                "tool approval checkpoint cannot be resumed by a form continuation".to_string(),
            );
        };
        if approval_id != expected_approval_id {
            return Err(format!(
                "approval continuation ID `{approval_id}` does not match checkpoint `{expected_approval_id}`"
            ));
        }
    } else if is_form_checkpoint {
        if checkpoint.get("phase").and_then(Value::as_str) != Some("awaiting_form") {
            return Err("invalid form checkpoint: phase must be awaiting_form".to_string());
        }
        let expected_form_id = checkpoint
            .pointer("/payload/formId")
            .and_then(Value::as_str)
            .ok_or_else(|| "invalid user input checkpoint: formId is missing".to_string())?;
        let AgentContinuationInput::Form { form_id, .. } = &continuation else {
            return Err(
                "user input checkpoint cannot be resumed by an approval continuation".to_string(),
            );
        };
        if form_id != expected_form_id {
            return Err(format!(
                "form continuation ID `{form_id}` does not match checkpoint `{expected_form_id}`"
            ));
        }
    } else {
        return Err(format!(
            "unsupported continuation checkpoint kind: {}",
            checkpoint_kind.unwrap_or("missing")
        ));
    }
    context
        .tool_router
        .restore_from_checkpoint(&checkpoint)
        .map_err(|error| format!("failed to restore activated tools from checkpoint: {error}"))
}

pub(super) fn queued_user_continuation_message(metadata: &Value) -> Option<Value> {
    let AgentContinuationInput::QueuedUserMessage { content, .. } =
        typed_continuation_from_metadata(metadata)?
    else {
        return None;
    };
    user_continuation_message(content)
}

pub(super) fn guidance_continuation_message(metadata: &Value) -> Option<Value> {
    let AgentContinuationInput::Guidance { content, .. } =
        typed_continuation_from_metadata(metadata)?
    else {
        return None;
    };
    user_continuation_message(content)
}

fn user_continuation_message(content: String) -> Option<Value> {
    if content.trim().is_empty() {
        None
    } else {
        Some(serde_json::json!({ "role": "user", "content": content }))
    }
}

pub(super) async fn maybe_approval_resume_result(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
) -> Result<Option<ApprovalContinuationOutcome>, String> {
    let Some(continuation) = approval_resume_metadata(context) else {
        return Ok(None);
    };
    let approved = matches!(continuation.decision, AgentApprovalDecision::Approved);
    let checkpoint = services
        .checkpoints
        .restore_for_turn(&context.session_id, &context.turn_id);
    if checkpoint.is_none() {
        return Err("approval continuation checkpoint is missing".to_string());
    }
    if let Some(requested_at) = checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint.pointer("/payload/approvalRequestedAtUnixMs"))
        .and_then(Value::as_u64)
    {
        let waited_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or_default()
            .saturating_sub(requested_at);
        context
            .metrics()
            .record_duration_ms("approval.wait.durationMs", waited_ms);
        context.metrics().increment("approval.resolved");
    }
    if approved {
        let checkpoint = checkpoint
            .ok_or_else(|| "tool approval continuation checkpoint disappeared".to_string())?;
        if checkpoint.pointer("/payload/kind").and_then(Value::as_str) != Some("tool_approval") {
            return Err(
                "approved continuation requires an exact tool_approval checkpoint".to_string(),
            );
        }
        return approved_tool_continuation_outcome(services, context, &continuation, checkpoint)
            .await
            .map(Some);
    }
    if let Some(guidance) = continuation.guidance.clone() {
        let checkpoint = checkpoint
            .ok_or_else(|| "denied approval continuation checkpoint disappeared".to_string())?;
        return denied_approval_resume(services, context, &continuation, guidance, checkpoint)
            .map(ApprovalContinuationOutcome::Resume)
            .map(Some);
    }
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);
    let message = "Rust agent approval was denied.".to_string();
    let events = vec![
        approval_decision_event(context, &continuation),
        event(
            AgentEventKind::Error,
            serde_json::json!({
                "stopReason": "approval_denied",
                "message": message,
                "error": message,
            }),
        ),
    ];
    let runtime_events = continuation_runtime_events(services, context, &events)?;
    Ok(Some(ApprovalContinuationOutcome::Finished(
        serde_json::json!({
            "runtime": "rust",
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "finalContent": "",
            "stopReason": "approval_denied",
            "messages": [],
            "toolsUsed": [],
            "error": message,
            "events": events,
            "runtimeEvents": runtime_events,
        }),
    )))
}

async fn approved_tool_continuation_outcome(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
    continuation: &ApprovalContinuationData,
    checkpoint: Value,
) -> Result<ApprovalContinuationOutcome, String> {
    let tool_call = approved_pending_tool_call(&checkpoint)?;
    if !context.tool_router.is_permitted(&tool_call.name) {
        return Err(format!(
            "approved deferred tool `{}` is no longer permitted by the restored router",
            tool_call.name
        ));
    }
    let mut messages = checkpoint
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "invalid tool approval checkpoint: messages must be an array".to_string())?;
    prepare_continuation_tool_observation(&mut messages, &tool_call, false)
        .map_err(|error| format!("invalid tool approval checkpoint: {error}"))?;
    let mut resumed_context = context.clone();
    resumed_context.messages = messages.clone();
    resumed_context.spec["messages"] = Value::Array(messages.clone());
    let dispatch_result = dispatch_owned_tool_call(
        services.tools.clone(),
        resumed_context.clone(),
        tool_call.clone(),
    )
    .await;
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);
    let result = match dispatch_result.map_err(|error| {
        format!(
            "approved native tool `{}` dispatch failed: {error}",
            tool_call.name
        )
    })? {
        OwnedToolCallResult::Completed(result) => result,
        OwnedToolCallResult::Cancelled => {
            return Ok(ApprovalContinuationOutcome::Finished(cancelled_result(
                services,
                &context.turn_id,
                &context.session_id,
                checkpoint,
            )));
        }
        OwnedToolCallResult::CleanupTimedOut {
            cancellation_mode,
            timeout_ms,
        } => {
            return Ok(ApprovalContinuationOutcome::Finished(
                approved_tool_cleanup_timeout_result(
                    context,
                    continuation,
                    &tool_call,
                    checkpoint,
                    cancellation_mode,
                    timeout_ms,
                ),
            ));
        }
    };
    let restored_completed_results = checkpoint
        .get("completedToolResults")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let iteration = checkpoint
        .get("iteration")
        .and_then(Value::as_i64)
        .or_else(|| {
            checkpoint
                .pointer("/payload/iteration")
                .and_then(Value::as_i64)
        })
        .ok_or_else(|| "invalid tool approval checkpoint: iteration is missing".to_string())?;
    context.messages = messages.clone();
    context.spec["messages"] = Value::Array(messages);

    Ok(ApprovalContinuationOutcome::Resume(ApprovalResume {
        iteration,
        tool_call,
        result,
        restored_completed_results,
        continuation: continuation.clone(),
    }))
}

fn continuation_runtime_events(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    events: &[NativeAgentEvent],
) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
    let mut state = AgentTurnState::new_for_continuation(context, services.trace_sink.clone())?;
    for event in events {
        state.emit(PendingAgentEvent::try_from_wire_name(
            &event.event_name,
            event.payload.clone(),
        )?)?;
    }
    Ok(state.take_runtime_events())
}

fn approved_tool_cleanup_timeout_result(
    context: &AgentTurnContext,
    continuation: &ApprovalContinuationData,
    tool_call: &NativeAgentToolCall,
    checkpoint: Value,
    cancellation_mode: crate::tools::registry::ToolCancellationMode,
    timeout_ms: u64,
) -> Value {
    let error = format!(
        "approved native tool `{}` cleanup exceeded {} ms for cancellation mode `{}`",
        tool_call.name,
        timeout_ms,
        cancellation_mode.as_str()
    );
    let events = vec![
        approval_decision_event(context, continuation),
        event(
            AgentEventKind::ToolCleanupTimeout,
            serde_json::json!({
                "stopReason": "tool_cleanup_timeout",
                "error": error,
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "name": tool_call.name,
                "cancellationMode": cancellation_mode.as_str(),
                "timeoutMs": timeout_ms,
            }),
        ),
    ];
    serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "tool_cleanup_timeout",
        "messages": [],
        "toolsUsed": [tool_call.name],
        "completedToolResults": [],
        "error": error,
        "restoredCheckpoint": checkpoint,
        "continuation": {
            "kind": "approval",
            "approvalId": continuation.approval_id,
            "decision": "approved",
            "scope": approval_scope_str(&continuation.scope),
            "guidance": continuation.guidance,
        },
        "events": events,
    })
}

fn approved_pending_tool_call(checkpoint: &Value) -> Result<NativeAgentToolCall, String> {
    let pending = checkpoint
        .get("pendingToolCalls")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "invalid tool approval checkpoint: pendingToolCalls must be an array".to_string()
        })?;
    if pending.len() != 1 {
        return Err(format!(
            "invalid tool approval checkpoint: expected one pending tool call, found {}",
            pending.len()
        ));
    }
    let pending = &pending[0];
    Ok(NativeAgentToolCall {
        id: string_field(pending, "toolCallId").ok_or_else(|| {
            "invalid tool approval checkpoint: pending toolCallId is missing".to_string()
        })?,
        name: string_field(pending, "toolName").ok_or_else(|| {
            "invalid tool approval checkpoint: pending toolName is missing".to_string()
        })?,
        arguments_json: string_field(pending, "argumentsJson").ok_or_else(|| {
            "invalid tool approval checkpoint: pending argumentsJson is missing".to_string()
        })?,
        result: Value::Null,
    })
}

fn denied_approval_resume(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
    continuation: &ApprovalContinuationData,
    guidance: String,
    checkpoint: Value,
) -> Result<ApprovalResume, String> {
    if checkpoint.pointer("/payload/kind").and_then(Value::as_str) != Some("tool_approval") {
        return Err("denied continuation requires an exact tool_approval checkpoint".to_string());
    }
    let tool_call = approved_pending_tool_call(&checkpoint)?;
    let mut messages = checkpoint
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            "invalid denied approval checkpoint: messages must be an array".to_string()
        })?;
    prepare_continuation_tool_observation(&mut messages, &tool_call, false)
        .map_err(|error| format!("invalid denied approval checkpoint: {error}"))?;
    let restored_completed_results = checkpoint
        .get("completedToolResults")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let iteration = checkpoint
        .get("iteration")
        .and_then(Value::as_i64)
        .or_else(|| {
            checkpoint
                .pointer("/payload/iteration")
                .and_then(Value::as_i64)
        })
        .ok_or_else(|| "invalid denied approval checkpoint: iteration is missing".to_string())?;
    let summary = format!("Approval denied by user. Guidance: {guidance}");
    let result = NativeAgentToolResult {
        content: Value::String(summary.clone()),
        envelope: NativeToolResultEnvelope::approval_denied(&tool_call, summary, guidance),
    };
    context.messages = messages.clone();
    context.spec["messages"] = Value::Array(messages);
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);
    Ok(ApprovalResume {
        iteration,
        tool_call,
        result,
        restored_completed_results,
        continuation: continuation.clone(),
    })
}

fn approval_decision_event(
    context: &AgentTurnContext,
    continuation: &ApprovalContinuationData,
) -> NativeAgentEvent {
    event(
        AgentEventKind::ApprovalDecision,
        approval_decision_payload(context, continuation),
    )
}

fn approval_decision_pending(
    context: &AgentTurnContext,
    continuation: &ApprovalContinuationData,
) -> PendingAgentEvent {
    PendingAgentEvent::new(
        AgentEventKind::ApprovalDecision,
        approval_decision_payload(context, continuation),
    )
}

fn approval_decision_payload(
    context: &AgentTurnContext,
    continuation: &ApprovalContinuationData,
) -> Value {
    let mut payload = serde_json::json!({
        "approvalId": continuation.approval_id,
        "detailId": format!("approval:{}", continuation.approval_id),
        "status": "completed",
        "decision": match continuation.decision {
            AgentApprovalDecision::Approved => "approved",
            AgentApprovalDecision::Denied => "denied",
        },
        "scope": approval_scope_str(&continuation.scope),
        "guidance": continuation.guidance,
    });
    if let Some(command_id) = context
        .metadata
        .get("commandId")
        .or_else(|| context.metadata.get("command_id"))
        .and_then(serde_json::Value::as_str)
    {
        payload["commandId"] = serde_json::Value::String(command_id.to_string());
    }
    payload
}

fn approval_scope_str(scope: &AgentApprovalScope) -> &'static str {
    match scope {
        AgentApprovalScope::Once => "once",
        AgentApprovalScope::Session => "session",
    }
}

pub(super) enum ApprovalContinuationOutcome {
    Resume(ApprovalResume),
    Finished(Value),
}

pub(super) struct ApprovalResume {
    iteration: i64,
    tool_call: NativeAgentToolCall,
    result: NativeAgentToolResult,
    restored_completed_results: Vec<Value>,
    continuation: ApprovalContinuationData,
}

impl ApprovalResume {
    pub(super) fn apply(
        self,
        context: &AgentTurnContext,
        state: &mut AgentTurnState,
    ) -> Result<i64, String> {
        state
            .completed_tool_results
            .extend(self.restored_completed_results);
        state.tools_used.push(self.tool_call.name.clone());
        state.clear_pending_tool_calls();
        state.emit(approval_decision_pending(context, &self.continuation))?;
        commit_tool_observation(context, state, self.iteration, self.tool_call, self.result)?;
        Ok(self.iteration.saturating_add(1))
    }
}

#[derive(Clone, Debug)]
struct ApprovalContinuationData {
    approval_id: String,
    decision: AgentApprovalDecision,
    scope: AgentApprovalScope,
    guidance: Option<String>,
}

fn approval_resume_metadata(context: &AgentTurnContext) -> Option<ApprovalContinuationData> {
    let AgentContinuationInput::Approval {
        approval_id,
        decision,
        scope,
        guidance,
    } = typed_continuation_metadata(context)?
    else {
        return None;
    };
    Some(ApprovalContinuationData {
        approval_id,
        decision,
        scope,
        guidance,
    })
}

fn typed_continuation_metadata(context: &AgentTurnContext) -> Option<AgentContinuationInput> {
    typed_continuation_from_metadata(&context.metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn guided_approval_denial_resumes_through_the_common_tool_commit() {
        let services = NativeAgentRuntimeServices::default();
        let mut context = AgentTurnContext::from_spec(
            json!({
                "turnId": "turn-guided-denial",
                "sessionId": "session-guided-denial",
                "messages": [],
                "metadata": {
                    "agentContinuation": {
                        "kind": "approval",
                        "approvalId": "call-write",
                        "decision": "denied",
                        "scope": "once",
                        "guidance": "Use a read-only tool."
                    }
                }
            }),
            json!({}),
        );
        services.save_turn_checkpoint(
            &context.session_id,
            &context.turn_id,
            json!({
                "turnId": context.turn_id,
                "sessionId": context.session_id,
                "phase": "awaiting_approval",
                "iteration": 2,
                "payload": {
                    "kind": "tool_approval",
                    "approvalId": "call-write",
                    "iteration": 2
                },
                "pendingToolCalls": [{
                    "toolCallId": "call-write",
                    "toolName": "exec_command",
                    "argumentsJson": "{\"command\":\"write\"}"
                }],
                "completedToolResults": [{
                    "toolCallId": "call-prior",
                    "toolName": "workspace.read_file",
                    "status": "ok",
                    "summary": "prior"
                }],
                "messages": [
                    { "role": "user", "content": "change the file" },
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": "call-write",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"command\":\"write\"}"
                            }
                        }]
                    }
                ]
            }),
        );

        let outcome = maybe_approval_resume_result(&services, &mut context)
            .await
            .expect("guided denial should prepare")
            .expect("guided denial metadata should be recognized");
        let ApprovalContinuationOutcome::Resume(resume) = outcome else {
            panic!("guided denial must return to the ordinary provider/tool loop");
        };
        let mut state =
            AgentTurnState::new_for_continuation(&context, None).expect("state should resume");

        let next_iteration = resume
            .apply(&context, &mut state)
            .expect("guided denial should commit");

        assert_eq!(next_iteration, 3);
        assert_eq!(state.completed_tool_results.len(), 2);
        assert_eq!(state.completed_tool_results[0]["toolCallId"], "call-prior");
        assert_eq!(state.completed_tool_results[1]["status"], "denied");
        let runtime_events = state.runtime_events();
        let event_names = runtime_events
            .iter()
            .map(|event| event.event_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            event_names,
            vec!["agent.approval.decision", "agent.tool.result"]
        );
        assert_eq!(runtime_events[1].payload["resultStatus"], "denied");
        assert!(state.history.messages().iter().any(|message| {
            message["role"] == "tool"
                && message["tool_call_id"] == "call-write"
                && message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("Use a read-only tool."))
        }));
        assert!(
            services.restore_turn_checkpoint(&context.session_id, &context.turn_id)["checkpoint"]
                .is_null()
        );
    }
}
