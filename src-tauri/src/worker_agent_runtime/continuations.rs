use super::checkpoint::{checkpoint_value, test_compat_runtime_metadata};
use super::events::{event, legacy_result_events_from_runtime_events};
use super::result::{append_runtime_events_to_sink, waiting_runtime_events};
use super::tool_projection::{
    assistant_tool_calls_message, completed_tool_result_entry, tool_observation_message,
};
use super::usage::{enrich_usage_with_context_window, estimate_context_tokens_for_request};
use super::{
    string_field, NativeAgentEvent, NativeAgentRunContext, NativeAgentRuntimeServices,
    NativeAgentToolCall, NativeAgentToolResult, NativeToolResultEnvelope,
    TEST_COMPAT_FAKE_AWAITING_APPROVAL, TEST_COMPAT_FAKE_AWAITING_FORM,
};
use crate::agent_loop_runtime_protocol::{
    AgentApprovalDecision, AgentApprovalScope, AgentContinuationInput, AgentFormAction,
    AgentRuntimePhase,
};
use serde_json::Value;

fn typed_continuation_from_metadata(metadata: &Value) -> Option<AgentContinuationInput> {
    metadata
        .get("agentContinuation")
        .or_else(|| metadata.get("continuation"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
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
    let checkpoint = checkpoint_value(
        context,
        "awaiting_approval",
        serde_json::json!({
            "iteration": 0,
            "approval_id": approval_id,
            "operation": approval,
            "pendingToolCalls": [{
                "toolCallId": approval_id,
                "toolName": tool_name,
                "argumentsJson": Value::Null,
            }],
            "resumeToken": format!("approval:{approval_id}"),
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

pub(super) fn maybe_approval_resume_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let (approval, continuation) = approval_resume_metadata(context)?;
    let approved = matches!(continuation.decision, AgentApprovalDecision::Approved);
    let checkpoint = services
        .checkpoints
        .restore_for_run(&context.session_id, &context.run_id);
    if !approved {
        if let Some(guidance) = continuation.guidance.clone() {
            return Some(approval_denied_guidance_result(
                services,
                context,
                &approval,
                &continuation,
                guidance,
                checkpoint,
            ));
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
        return Some(serde_json::json!({
            "runtime": "rust",
            "runId": context.run_id,
            "sessionId": context.session_id,
            "finalContent": "",
            "stopReason": "approval_denied",
            "messages": [],
            "toolsUsed": [],
            "error": message,
            "events": events,
        }));
    }
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let final_content = string_field(&approval, "finalContent")
        .or_else(|| string_field(&approval, "final_content"))
        .unwrap_or_else(|| "Approved tool completed.".to_string());
    let events = vec![
        approval_decision_event(context, &continuation),
        event(
            "agent.tool.result",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": string_field(&approval, "toolCallId").unwrap_or(continuation.approval_id.clone()),
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
    Some(serde_json::json!({
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
    }))
}

fn approval_denied_guidance_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    approval: &Value,
    continuation: &ApprovalContinuationData,
    guidance: String,
    checkpoint: Option<Value>,
) -> Value {
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let tool_call = approval_resume_tool_call(checkpoint.as_ref(), approval, continuation);
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
    messages.push(assistant_tool_calls_message("", &[tool_call.clone()]));
    messages.push(tool_observation_message(&tool_call, &summary));

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

    match services.provider.complete(&resumed_context) {
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
                "events": events,
            })
        }
        Err(error) => {
            events.push(event(
                "agent.error",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "stopReason": "provider_error",
                    "message": error,
                    "error": error,
                }),
            ));
            serde_json::json!({
                "runtime": "rust",
                "runId": context.run_id,
                "sessionId": context.session_id,
                "finalContent": "",
                "stopReason": "provider_error",
                "messages": [],
                "toolsUsed": [],
                "completedToolResults": [completed_result],
                "restoredCheckpoint": checkpoint,
                "error": error,
                "events": events,
            })
        }
    }
}

fn approval_resume_tool_call(
    checkpoint: Option<&Value>,
    approval: &Value,
    continuation: &ApprovalContinuationData,
) -> NativeAgentToolCall {
    let pending_tool_call = checkpoint
        .and_then(|checkpoint| checkpoint.get("pendingToolCalls"))
        .and_then(Value::as_array)
        .and_then(|pending_tool_calls| pending_tool_calls.first());
    NativeAgentToolCall {
        id: pending_tool_call
            .and_then(|tool_call| string_field(tool_call, "toolCallId"))
            .or_else(|| string_field(approval, "toolCallId"))
            .unwrap_or_else(|| continuation.approval_id.clone()),
        name: pending_tool_call
            .and_then(|tool_call| string_field(tool_call, "toolName"))
            .or_else(|| string_field(approval, "toolName"))
            .unwrap_or_else(|| "approval".to_string()),
        arguments_json: pending_tool_call
            .and_then(|tool_call| string_field(tool_call, "argumentsJson"))
            .or_else(|| string_field(approval, "argumentsJson"))
            .unwrap_or_else(|| "{}".to_string()),
        result: Value::Null,
    }
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
    event(
        "agent.approval.decision",
        serde_json::json!({
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
        }),
    )
}

fn approval_scope_str(scope: &AgentApprovalScope) -> &'static str {
    match scope {
        AgentApprovalScope::Once => "once",
        AgentApprovalScope::Session => "session",
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
            "iteration": 0,
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
) -> Option<Value> {
    let (form, continuation) = form_submit_metadata(context)?;
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
        return Some(serde_json::json!({
            "runtime": "rust",
            "runId": context.run_id,
            "sessionId": context.session_id,
            "finalContent": "",
            "stopReason": "form_cancelled",
            "messages": [],
            "toolsUsed": [],
            "error": message,
            "events": events,
        }));
    }
    let checkpoint = services
        .checkpoints
        .restore_for_run(&context.session_id, &context.run_id);
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
    Some(serde_json::json!({
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
    }))
}

fn form_resolution_event(
    context: &NativeAgentRunContext,
    continuation: &FormContinuationData,
) -> NativeAgentEvent {
    event(
        "agent.form.resolution",
        serde_json::json!({
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
        }),
    )
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
