use super::checkpoint::{checkpoint_value, test_compat_runtime_metadata};
use super::events::{
    event, legacy_result_events_from_runtime_events, runtime_event_item_id, runtime_event_timestamp,
};
use super::result::{append_runtime_events_to_sink, cancelled_result, waiting_runtime_events};
use super::state::NativeAgentRunState;
use super::tool_projection::{
    append_continuation_tool_error_observation, append_continuation_tool_observation,
    assistant_tool_calls_message, completed_tool_result_entry, normalize_tool_result_for_context,
    prepare_continuation_tool_observation, tool_observation_content,
};
use super::tool_runtime::{dispatch_owned_tool_call, OwnedToolCallResult};
use super::usage::{enrich_usage_with_context_window, estimate_context_tokens_for_request};
use super::{
    string_field, NativeAgentEvent, NativeAgentProviderFailureKind, NativeAgentProviderStreamEvent,
    NativeAgentRunContext, NativeAgentRuntimeServices, NativeAgentToolCall, NativeAgentToolResult,
    NativeToolResultEnvelope, TEST_COMPAT_FAKE_AWAITING_APPROVAL, TEST_COMPAT_FAKE_AWAITING_FORM,
};
use crate::agent_loop_runtime_protocol::{
    AgentApprovalDecision, AgentApprovalScope, AgentContinuationInput, AgentFormAction,
    AgentRuntimeEventAppender, AgentRuntimeEventEnvelope, AgentRuntimePhase,
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
    context: &mut NativeAgentRunContext,
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
        .restore_for_run(&context.session_id, &context.run_id)
        .ok_or_else(|| {
            "approval and form continuations require a matching run checkpoint".to_string()
        })?;
    let checkpoint_kind = checkpoint.pointer("/payload/kind").and_then(Value::as_str);
    let is_approval_checkpoint = checkpoint_kind == Some("tool_approval")
        || (cfg!(test) && checkpoint_kind == Some("test_approval"));
    let is_form_checkpoint = checkpoint_kind == Some("user_input")
        || (cfg!(test) && checkpoint_kind == Some("test_form"));
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

pub(super) fn maybe_awaiting_approval_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let approval =
        test_compat_runtime_metadata(&context.metadata, TEST_COMPAT_FAKE_AWAITING_APPROVAL)?
            .clone();
    let approval_id = string_field(&approval, "approvalId")
        .or_else(|| string_field(&approval, "approval_id"))
        .unwrap_or_else(|| "approval-1".to_string());
    let tool_name = string_field(&approval, "toolName")
        .or_else(|| string_field(&approval, "tool_name"))
        .unwrap_or_else(|| "approval".to_string());
    let tool_call_id = string_field(&approval, "toolCallId")
        .or_else(|| string_field(&approval, "tool_call_id"))
        .unwrap_or_else(|| approval_id.clone());
    let arguments_json = string_field(&approval, "argumentsJson")
        .or_else(|| string_field(&approval, "arguments_json"))
        .unwrap_or_else(|| "{}".to_string());
    let tool_call = NativeAgentToolCall {
        id: tool_call_id.clone(),
        name: tool_name.clone(),
        arguments_json: arguments_json.clone(),
        result: Value::Null,
    };
    let mut messages = context.messages.clone();
    messages.push(assistant_tool_calls_message("", &[tool_call]));
    let checkpoint = checkpoint_value(
        context,
        "awaiting_approval",
        serde_json::json!({
            "kind": "test_approval",
            "iteration": 0,
            "approvalId": approval_id,
            "approval_id": approval_id,
            "operation": approval,
            "pendingToolCalls": [{
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "argumentsJson": arguments_json,
            }],
            "resumeToken": format!("approval:{approval_id}"),
            "messages": messages,
        }),
    );
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    let runtime_events = waiting_runtime_events(
        context,
        AgentRuntimePhase::AwaitingApproval,
        "agent.awaiting_approval",
        vec![
            (
                "agent.checkpoint",
                None,
                AgentRuntimePhase::Planning,
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "phase": "awaiting_approval",
                    "checkpoint": checkpoint.clone(),
                }),
            ),
            (
                "agent.awaiting_approval",
                Some(approval_id.clone()),
                AgentRuntimePhase::AwaitingApproval,
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "approvalId": approval_id.clone(),
                    "toolCallId": tool_call_id.clone(),
                    "toolName": tool_name.clone(),
                    "detailId": format!("approval:{approval_id}"),
                    "status": "waiting",
                    "summary": format!("Approval required: {tool_name}"),
                    "options": approval_request_options(),
                    "operation": approval.clone(),
                    "content": format!("Approval required: {tool_name}"),
                }),
            ),
            (
                "agent.done",
                None,
                AgentRuntimePhase::AwaitingApproval,
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "stopReason": "awaiting_approval",
                }),
            ),
        ],
    );
    append_runtime_events_to_sink(context, services.trace_sink.as_ref(), &runtime_events);
    let events = legacy_result_events_from_runtime_events(&runtime_events);
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "awaiting_approval",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}

pub(super) async fn maybe_approval_resume_result(
    services: &NativeAgentRuntimeServices,
    context: &mut NativeAgentRunContext,
) -> Result<Option<ApprovalContinuationOutcome>, String> {
    let Some((approval, continuation)) = approval_resume_metadata(context) else {
        return Ok(None);
    };
    let approved = matches!(continuation.decision, AgentApprovalDecision::Approved);
    let checkpoint = services
        .checkpoints
        .restore_for_run(&context.session_id, &context.run_id);
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
    if approved
        && checkpoint
            .as_ref()
            .and_then(|checkpoint| checkpoint.pointer("/payload/kind"))
            .and_then(Value::as_str)
            == Some("tool_approval")
    {
        let checkpoint = checkpoint
            .ok_or_else(|| "tool approval continuation checkpoint disappeared".to_string())?;
        return approved_tool_continuation_outcome(services, context, &continuation, checkpoint)
            .await
            .map(Some);
    }
    if approved
        && !(cfg!(test)
            && checkpoint
                .as_ref()
                .and_then(|checkpoint| checkpoint.pointer("/payload/kind"))
                .and_then(Value::as_str)
                == Some("test_approval"))
    {
        return Err("approved continuation requires an exact tool_approval checkpoint".to_string());
    }
    if !approved {
        if let Some(guidance) = continuation.guidance.clone() {
            return Ok(Some(ApprovalContinuationOutcome::Finished(
                approval_denied_guidance_result(
                    services,
                    context,
                    &approval,
                    &continuation,
                    guidance,
                    checkpoint,
                )
                .await?,
            )));
        }
        services
            .checkpoints
            .clear_for_run(&context.session_id, &context.run_id);
        let message = continuation
            .guidance
            .clone()
            .or_else(|| string_field(&approval, "guidance"))
            .map(|guidance| format!("Rust agent approval was denied. User guidance: {guidance}"))
            .unwrap_or_else(|| "Rust agent approval was denied.".to_string());
        let events = vec![
            approval_decision_event(context, &continuation),
            event(
                "agent.error",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "stopReason": "approval_denied",
                    "message": message,
                    "error": message,
                }),
            ),
        ];
        let runtime_events = continuation_runtime_events(services, context, &events)?;
        append_runtime_events_to_sink(context, services.trace_sink.as_ref(), &runtime_events);
        return Ok(Some(ApprovalContinuationOutcome::Finished(
            serde_json::json!({
                "runtime": "rust",
                "runId": context.run_id,
                "sessionId": context.session_id,
                "finalContent": "",
                "stopReason": "approval_denied",
                "messages": [],
                "toolsUsed": [],
                "error": message,
                "events": events,
                "runtimeEvents": runtime_events,
            }),
        )));
    }
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let final_content = string_field(&approval, "finalContent")
        .or_else(|| string_field(&approval, "final_content"))
        .unwrap_or_else(|| "Approved tool completed.".to_string());
    let tool_call_id = string_field(&approval, "toolCallId")
        .filter(|tool_call_id| tool_call_id != &continuation.approval_id)
        .unwrap_or_else(|| format!("{}:tool", continuation.approval_id));
    let events = vec![
        approval_decision_event(context, &continuation),
        event(
            "agent.tool.result",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": tool_call_id,
                "toolName": string_field(&approval, "toolName").unwrap_or_else(|| "approval".to_string()),
                "content": string_field(&approval, "toolResult").unwrap_or_else(|| "approved".to_string()),
            }),
        ),
        event(
            "agent.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": final_content,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "final_response",
            }),
        ),
    ];
    let runtime_events = continuation_runtime_events(services, context, &events)?;
    append_runtime_events_to_sink(context, services.trace_sink.as_ref(), &runtime_events);
    Ok(Some(ApprovalContinuationOutcome::Finished(
        serde_json::json!({
            "runtime": "rust",
            "runId": context.run_id,
            "sessionId": context.session_id,
            "finalContent": final_content,
            "stopReason": "final_response",
            "messages": [{ "role": "assistant", "content": final_content }],
            "toolsUsed": [],
            "restoredCheckpoint": checkpoint,
            "continuation": {
                "kind": "approval",
                "approvalId": continuation.approval_id,
                "decision": if approved { "approved" } else { "denied" },
                "scope": match continuation.scope {
                    AgentApprovalScope::Once => "once",
                    AgentApprovalScope::Session => "session",
                },
                "guidance": continuation.guidance,
            },
            "events": events,
            "runtimeEvents": runtime_events,
        }),
    )))
}

async fn approved_tool_continuation_outcome(
    services: &NativeAgentRuntimeServices,
    context: &mut NativeAgentRunContext,
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
        .clear_for_run(&context.session_id, &context.run_id);
    let result = match dispatch_result.map_err(|error| {
        format!(
            "approved native tool `{}` dispatch failed: {error}",
            tool_call.name
        )
    })? {
        OwnedToolCallResult::Completed(result) => {
            normalize_tool_result_for_context(result, context)
        }
        OwnedToolCallResult::Cancelled => {
            return Ok(ApprovalContinuationOutcome::Finished(cancelled_result(
                services,
                &context.run_id,
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
    let observation_content = tool_observation_content(&result);
    let completed_result = completed_tool_result_entry(&tool_call, &result);
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
    append_continuation_tool_observation(&mut messages, &tool_call, &observation_content, false)
        .map_err(|error| format!("invalid tool approval checkpoint: {error}"))?;
    context.messages = messages.clone();
    context.spec["messages"] = Value::Array(messages);

    Ok(ApprovalContinuationOutcome::Resume(ApprovalResume {
        iteration,
        tool_call,
        completed_result,
        restored_completed_results,
        observation_content,
        envelope: result.envelope,
        continuation: continuation.clone(),
    }))
}

fn continuation_runtime_events(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    events: &[NativeAgentEvent],
) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
    let existing = services
        .trace_sink
        .as_ref()
        .map(|sink| sink.load_runtime_events(&context.session_id, &context.run_id))
        .transpose()?
        .unwrap_or_default();
    let mut appender = if existing.is_empty() {
        AgentRuntimeEventAppender::new_with_trace_context(
            &context.session_id,
            context.trace_context.clone(),
        )
    } else {
        AgentRuntimeEventAppender::from_existing_events_with_thread_id(
            &context.session_id,
            &context.run_id,
            context.thread_id.clone(),
            &existing,
        )
    };
    Ok(events
        .iter()
        .map(|event| {
            appender.append_legacy_native_event(
                event.event_name.clone(),
                runtime_event_item_id(&event.event_name, &event.payload),
                runtime_event_timestamp(),
                event.payload.clone(),
            )
        })
        .collect())
}

fn approved_tool_cleanup_timeout_result(
    context: &NativeAgentRunContext,
    continuation: &ApprovalContinuationData,
    tool_call: &NativeAgentToolCall,
    checkpoint: Value,
    cancellation_mode: crate::worker_tool_registry::ToolCancellationMode,
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
            "agent.tool.cleanup_timeout",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
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
        "runId": context.run_id,
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

async fn approval_denied_guidance_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    approval: &Value,
    continuation: &ApprovalContinuationData,
    guidance: String,
    checkpoint: Option<Value>,
) -> Result<Value, String> {
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let tool_call = approval_resume_tool_call(checkpoint.as_ref(), approval)?;
    let summary = format!("Approval denied by user. Guidance: {guidance}");
    let result = NativeAgentToolResult {
        content: Value::String(summary.clone()),
        envelope: NativeToolResultEnvelope::approval_denied(
            &tool_call,
            summary.clone(),
            guidance.clone(),
        ),
    };
    let completed_result = completed_tool_result_entry(&tool_call, &result);
    let mut messages = checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint.get("messages"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| context.messages.clone());
    append_continuation_tool_error_observation(&mut messages, &tool_call, &summary, false)
        .map_err(|error| format!("invalid denied approval checkpoint: {error}"))?;

    let mut resumed_context = context.clone();
    resumed_context.messages = messages.clone();
    resumed_context.spec["messages"] = Value::Array(messages);
    let mut events = vec![
        approval_decision_event(context, continuation),
        event(
            "agent.tool.result",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "name": tool_call.name,
                "detailId": format!("tool:{}", tool_call.id),
                "status": "completed",
                "resultStatus": result.envelope.get("status").cloned().unwrap_or(Value::Null),
                "summary": summary,
                "content": summary,
                "envelope": result.envelope.clone(),
            }),
        ),
    ];

    let mut provider_observer = |_event: NativeAgentProviderStreamEvent| {};
    let provider_call = services
        .provider
        .clone()
        .complete_streaming_async(&resumed_context, &mut provider_observer);
    tokio::pin!(provider_call);
    let provider_response = if let Some(cancellation) = resumed_context.cancellation.clone() {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return Ok(cancelled_result(
                    services,
                    &context.run_id,
                    &context.session_id,
                    checkpoint.unwrap_or(Value::Null),
                ));
            }
            result = &mut provider_call => result,
        }
    } else {
        provider_call.await
    };
    let mut result = match provider_response {
        Ok(provider_response) => {
            let final_content = provider_response.final_content;
            if let Some(usage) = provider_response.usage {
                let estimated_context_tokens =
                    estimate_context_tokens_for_request(&resumed_context);
                let usage = enrich_usage_with_context_window(
                    &resumed_context,
                    usage,
                    estimated_context_tokens,
                    0,
                );
                events.push(event(
                    "agent.usage",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "usage": usage,
                    }),
                ));
            }
            events.push(event(
                "agent.done",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "stopReason": "final_response",
                }),
            ));
            serde_json::json!({
                "runtime": "rust",
                "runId": context.run_id,
                "sessionId": context.session_id,
                "finalContent": final_content,
                "stopReason": "final_response",
                "messages": [{ "role": "assistant", "content": final_content }],
                "toolsUsed": [],
                "completedToolResults": [completed_result],
                "restoredCheckpoint": checkpoint,
                "continuation": {
                    "kind": "approval",
                    "approvalId": continuation.approval_id,
                    "decision": "denied",
                    "scope": approval_scope_str(&continuation.scope),
                    "guidance": guidance,
                },
                "events": events.clone(),
            })
        }
        Err(error) if error.kind() == NativeAgentProviderFailureKind::Cancelled => {
            cancelled_result(
                services,
                &context.run_id,
                &context.session_id,
                checkpoint.unwrap_or(Value::Null),
            )
        }
        Err(error) => {
            let stop_reason = error.stop_reason();
            let message = error.message().to_string();
            events.push(event(
                "agent.error",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "stopReason": stop_reason,
                    "message": message,
                    "error": message,
                }),
            ));
            serde_json::json!({
                "runtime": "rust",
                "runId": context.run_id,
                "sessionId": context.session_id,
                "finalContent": "",
                "stopReason": stop_reason,
                "messages": [],
                "toolsUsed": [],
                "completedToolResults": [completed_result],
                "restoredCheckpoint": checkpoint,
                "error": message,
                "events": events.clone(),
            })
        }
    };
    let runtime_events = continuation_runtime_events(services, context, &events)?;
    append_runtime_events_to_sink(context, services.trace_sink.as_ref(), &runtime_events);
    result["runtimeEvents"] = serde_json::to_value(runtime_events)
        .map_err(|error| format!("failed to serialize denied approval runtime events: {error}"))?;
    Ok(result)
}

fn approval_resume_tool_call(
    checkpoint: Option<&Value>,
    approval: &Value,
) -> Result<NativeAgentToolCall, String> {
    let pending_tool_call = checkpoint
        .and_then(|checkpoint| checkpoint.get("pendingToolCalls"))
        .and_then(Value::as_array)
        .and_then(|pending_tool_calls| pending_tool_calls.first());
    Ok(NativeAgentToolCall {
        id: pending_tool_call
            .and_then(|tool_call| string_field(tool_call, "toolCallId"))
            .or_else(|| string_field(approval, "toolCallId"))
            .ok_or_else(|| {
                "invalid denied approval checkpoint: pending toolCallId is missing".to_string()
            })?,
        name: pending_tool_call
            .and_then(|tool_call| string_field(tool_call, "toolName"))
            .or_else(|| string_field(approval, "toolName"))
            .unwrap_or_else(|| "approval".to_string()),
        arguments_json: pending_tool_call
            .and_then(|tool_call| string_field(tool_call, "argumentsJson"))
            .or_else(|| string_field(approval, "argumentsJson"))
            .unwrap_or_else(|| "{}".to_string()),
        result: Value::Null,
    })
}

fn approval_request_options() -> Value {
    serde_json::json!([
        { "decision": "approved", "scope": "once" },
        { "decision": "approved", "scope": "session" },
        { "decision": "denied" }
    ])
}

fn approval_decision_event(
    context: &NativeAgentRunContext,
    continuation: &ApprovalContinuationData,
) -> NativeAgentEvent {
    let mut payload = serde_json::json!({
        "runId": context.run_id,
        "sessionId": context.session_id,
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
    event("agent.approval.decision", payload)
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
    completed_result: Value,
    restored_completed_results: Vec<Value>,
    observation_content: String,
    envelope: NativeToolResultEnvelope,
    continuation: ApprovalContinuationData,
}

impl ApprovalResume {
    pub(super) fn apply(
        self,
        context: &NativeAgentRunContext,
        state: &mut NativeAgentRunState,
    ) -> i64 {
        state
            .completed_tool_results
            .extend(self.restored_completed_results);
        state.tools_used.push(self.tool_call.name.clone());
        state.completed_tool_results.push(self.completed_result);
        state.clear_pending_tool_calls();
        state.emit_native_event(approval_decision_event(context, &self.continuation));
        state.emit_event(
            "agent.tool.result",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": self.iteration,
                "toolCallId": self.tool_call.id,
                "toolName": self.tool_call.name,
                "name": self.tool_call.name,
                "detailId": format!("tool:{}", self.tool_call.id),
                "status": "completed",
                "resultStatus": self.envelope.get("status").cloned().unwrap_or(Value::Null),
                "summary": self
                    .envelope
                    .get("summary")
                    .cloned()
                    .unwrap_or_else(|| Value::String(self.observation_content.clone())),
                "content": self.observation_content,
                "envelope": self.envelope,
            }),
        );
        self.iteration.saturating_add(1)
    }
}

#[derive(Clone, Debug)]
struct ApprovalContinuationData {
    approval_id: String,
    decision: AgentApprovalDecision,
    scope: AgentApprovalScope,
    guidance: Option<String>,
}

fn approval_resume_metadata(
    context: &NativeAgentRunContext,
) -> Option<(Value, ApprovalContinuationData)> {
    if let Some(AgentContinuationInput::Approval {
        approval_id,
        decision,
        scope,
        guidance,
    }) = typed_continuation_metadata(context)
    {
        let approved = matches!(decision, AgentApprovalDecision::Approved);
        let tool_result = if approved {
            "approved".to_string()
        } else if let Some(guidance) = guidance.as_deref() {
            format!("denied: {guidance}")
        } else {
            "denied".to_string()
        };
        let mut approval = serde_json::json!({
            "approvalId": approval_id,
            "approved": approved,
            "toolCallId": approval_id,
            "toolName": "approval",
            "toolResult": tool_result,
        });
        if let Some(guidance) = guidance.as_ref() {
            approval["guidance"] = Value::String(guidance.clone());
        }
        if let Some(final_content) = string_field(&context.metadata, "finalContent")
            .or_else(|| string_field(&context.metadata, "final_content"))
        {
            approval["finalContent"] = Value::String(final_content);
        }
        return Some((
            approval,
            ApprovalContinuationData {
                approval_id,
                decision,
                scope,
                guidance,
            },
        ));
    }

    None
}

fn typed_continuation_metadata(context: &NativeAgentRunContext) -> Option<AgentContinuationInput> {
    typed_continuation_from_metadata(&context.metadata)
}

pub(super) fn maybe_awaiting_form_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let form =
        test_compat_runtime_metadata(&context.metadata, TEST_COMPAT_FAKE_AWAITING_FORM)?.clone();
    let form_id = string_field(&form, "formId")
        .or_else(|| string_field(&form, "form_id"))
        .unwrap_or_else(|| "form-1".to_string());
    let checkpoint = checkpoint_value(
        context,
        "awaiting_form",
        serde_json::json!({
            "kind": "test_form",
            "iteration": 0,
            "formId": form_id,
            "form_id": form_id,
            "form": form,
            "pendingToolCalls": [],
            "resumeToken": format!("form:{form_id}"),
        }),
    );
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    let runtime_events = waiting_runtime_events(
        context,
        AgentRuntimePhase::AwaitingForm,
        "agent.awaiting_form",
        vec![
            (
                "agent.checkpoint",
                None,
                AgentRuntimePhase::Planning,
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "phase": "awaiting_form",
                    "checkpoint": checkpoint.clone(),
                }),
            ),
            (
                "agent.awaiting_form",
                Some(form_id.clone()),
                AgentRuntimePhase::AwaitingForm,
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "formId": form_id.clone(),
                    "detailId": format!("form:{form_id}"),
                    "status": "waiting",
                    "summary": string_field(&form, "title")
                        .unwrap_or_else(|| "Form input required".to_string()),
                    "form": form,
                }),
            ),
            (
                "agent.done",
                None,
                AgentRuntimePhase::AwaitingForm,
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "stopReason": "awaiting_form",
                }),
            ),
        ],
    );
    append_runtime_events_to_sink(context, services.trace_sink.as_ref(), &runtime_events);
    let events = legacy_result_events_from_runtime_events(&runtime_events);
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "awaiting_form",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}

pub(super) fn maybe_form_submit_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Result<Option<Value>, String> {
    let Some((form, continuation)) = form_submit_metadata(context) else {
        return Ok(None);
    };
    let checkpoint = services
        .checkpoints
        .restore_for_run(&context.session_id, &context.run_id)
        .ok_or_else(|| "form continuation checkpoint is missing".to_string())?;
    if !(cfg!(test)
        && checkpoint.pointer("/payload/kind").and_then(Value::as_str) == Some("test_form"))
    {
        return Err("legacy form continuation requires a test_form checkpoint".to_string());
    }
    if matches!(continuation.action, AgentFormAction::Cancel) {
        services
            .checkpoints
            .clear_for_run(&context.session_id, &context.run_id);
        let message = "Rust agent form was cancelled.";
        let events = vec![
            form_resolution_event(context, &continuation),
            event(
                "agent.error",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "stopReason": "form_cancelled",
                    "message": message,
                    "error": message,
                }),
            ),
        ];
        let runtime_events = continuation_runtime_events(services, context, &events)?;
        append_runtime_events_to_sink(context, services.trace_sink.as_ref(), &runtime_events);
        return Ok(Some(serde_json::json!({
            "runtime": "rust",
            "runId": context.run_id,
            "sessionId": context.session_id,
            "finalContent": "",
            "stopReason": "form_cancelled",
            "messages": [],
            "toolsUsed": [],
            "error": message,
            "events": events,
            "runtimeEvents": runtime_events,
            "restoredCheckpoint": checkpoint,
        })));
    }
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let final_content = string_field(&form, "finalContent")
        .or_else(|| string_field(&form, "final_content"))
        .unwrap_or_else(|| "Form submitted.".to_string());
    let events = vec![
        form_resolution_event(context, &continuation),
        event(
            "agent.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": final_content,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "final_response",
            }),
        ),
    ];
    let runtime_events = continuation_runtime_events(services, context, &events)?;
    append_runtime_events_to_sink(context, services.trace_sink.as_ref(), &runtime_events);
    Ok(Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": final_content,
        "stopReason": "final_response",
        "messages": [{ "role": "assistant", "content": final_content }],
        "toolsUsed": [],
        "restoredCheckpoint": checkpoint,
        "continuation": {
            "kind": "form",
            "formId": continuation.form_id,
            "action": match continuation.action {
                AgentFormAction::Submit => "submit",
                AgentFormAction::Cancel => "cancel",
            },
            "values": continuation.values,
        },
        "events": events,
        "runtimeEvents": runtime_events,
    })))
}

fn form_resolution_event(
    context: &NativeAgentRunContext,
    continuation: &FormContinuationData,
) -> NativeAgentEvent {
    let mut payload = serde_json::json!({
        "runId": context.run_id,
        "sessionId": context.session_id,
        "formId": continuation.form_id,
        "detailId": format!("form:{}", continuation.form_id),
        "status": "completed",
        "action": match continuation.action {
            AgentFormAction::Submit => "submit",
            AgentFormAction::Cancel => "cancel",
        },
        "values": continuation.values.clone(),
    });
    if let Some(command_id) = context
        .metadata
        .get("commandId")
        .or_else(|| context.metadata.get("command_id"))
        .and_then(serde_json::Value::as_str)
    {
        payload["commandId"] = serde_json::Value::String(command_id.to_string());
    }
    event("agent.form.resolution", payload)
}

#[derive(Clone, Debug)]
struct FormContinuationData {
    form_id: String,
    action: AgentFormAction,
    values: Option<Value>,
}

fn form_submit_metadata(context: &NativeAgentRunContext) -> Option<(Value, FormContinuationData)> {
    if let Some(AgentContinuationInput::Form {
        form_id,
        action,
        values,
    }) = typed_continuation_metadata(context)
    {
        let mut form = serde_json::json!({
            "formId": form_id,
            "values": values.clone().unwrap_or(Value::Null),
            "cancelled": matches!(action, AgentFormAction::Cancel),
        });
        if let Some(final_content) = string_field(&context.metadata, "finalContent")
            .or_else(|| string_field(&context.metadata, "final_content"))
        {
            form["finalContent"] = Value::String(final_content);
        }
        return Some((
            form,
            FormContinuationData {
                form_id,
                action,
                values,
            },
        ));
    }

    None
}
