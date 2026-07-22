use crate::agent_loop_runtime_protocol::AgentTraceContext;
use crate::agent_loop_runtime_protocol::{AgentApprovalDecision, AgentApprovalScope};
use crate::call_rust_state_service;
use crate::native_agent_bridge::{
    native_agent_current_user_message, native_agent_model, native_agent_provider,
    native_agent_run_id, native_agent_string_field,
};
use crate::worker_agent_runtime::{
    ensure_agent_trace_context, AgentHookInvocation, AgentHookStage, NativeAgentRuntimeServices,
    NativeAgentTraceSink,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::agent_flow::run_agent_with_services;
use super::webui_continuation::{
    native_session_checkpoint, resolve_agent_ui_form_body_with_services,
};

pub(crate) struct SubmitThreadTurnInput {
    pub(crate) thread_id: Option<String>,
    pub(crate) input: serde_json::Value,
    pub(crate) spec: serde_json::Value,
}

pub(crate) struct ResolveThreadApprovalInput {
    pub(crate) thread_id: String,
    pub(crate) approval_id: String,
    pub(crate) approved: bool,
    pub(crate) command_id: String,
    pub(crate) scope: Option<String>,
    pub(crate) guidance: Option<String>,
}

pub(crate) struct SubmitThreadFormInput {
    pub(crate) thread_id: String,
    pub(crate) form_id: String,
    pub(crate) values: serde_json::Value,
    pub(crate) action: Option<String>,
}

pub(crate) async fn submit_thread_turn_with_services(
    base_services: NativeAgentRuntimeServices,
    input: SubmitThreadTurnInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let thread = ensure_thread_turn_target(
        input.thread_id,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let thread_id = thread_thread_id(&thread)?;
    let thread_working_directory = thread_working_directory(&thread);
    let session_id = thread_id.clone();
    let run_id = native_agent_run_id(&input.spec).unwrap_or_else(generate_thread_turn_run_id);
    let spec_has_working_directory = native_agent_string_field(&input.spec, "cwd")
        .or_else(|| native_agent_string_field(&input.spec, "workingDirectory"))
        .or_else(|| native_agent_string_field(&input.spec, "working_directory"))
        .or_else(|| {
            input
                .spec
                .get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "cwd"))
        })
        .or_else(|| {
            input
                .spec
                .get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "workingDirectory"))
        })
        .or_else(|| {
            input
                .spec
                .get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "working_directory"))
        })
        .is_some();
    let mut spec = if input.spec.is_object() {
        input.spec
    } else {
        serde_json::json!({})
    };
    let spec_object = spec
        .as_object_mut()
        .ok_or_else(|| "thread turn spec must be a JSON object".to_string())?;
    spec_object.insert(
        "runtime".to_string(),
        spec_object
            .get("runtime")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::String("rust".to_string())),
    );
    spec_object.insert(
        "sessionId".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    spec_object.insert(
        "runId".to_string(),
        serde_json::Value::String(run_id.clone()),
    );
    if !spec_object.contains_key("messages") {
        spec_object.insert(
            "messages".to_string(),
            normalize_thread_turn_messages(input.input)?,
        );
    }
    validate_turn_messages(
        spec_object
            .get("messages")
            .ok_or_else(|| "thread turn spec must include messages".to_string())?,
    )?;
    let metadata = spec_object
        .entry("metadata".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(metadata_object) = metadata.as_object_mut() {
        metadata_object.insert(
            "threadId".to_string(),
            serde_json::Value::String(thread_id.clone()),
        );
        if !spec_has_working_directory {
            if let Some(working_directory) = thread_working_directory {
                metadata_object.insert(
                    "workingDirectory".to_string(),
                    serde_json::Value::String(working_directory),
                );
            }
        }
    }
    let trace_context = ensure_agent_trace_context(&mut spec)?;
    let thread_hook_services = base_services.clone();
    let thread_start_invocation =
        AgentHookInvocation::lifecycle(AgentHookStage::ThreadStart, trace_context.clone());
    let thread_start_evaluation =
        thread_hook_services.evaluate_hook_invocation(thread_start_invocation.clone())?;
    if let Some(reason) = thread_start_evaluation.denied_reason.clone() {
        return Ok(serde_json::json!({
            "threadId": thread_id,
            "sessionId": session_id,
            "runId": run_id,
            "agentResult": {
                "runtime": "rust",
                "runId": run_id,
                "sessionId": session_id,
                "threadId": thread_id,
                "stopReason": "hook_denied",
                "finalContent": "",
                "messages": [],
                "toolsUsed": [],
                "error": reason,
                "traceContext": trace_context,
                "threadHookDiagnostics": [
                    thread_start_evaluation.event_payload(&thread_start_invocation)
                ],
            }
        }));
    }

    start_native_agent_thread_turn(
        &thread_id,
        &run_id,
        &spec,
        &trace_context,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let mut agent_result = run_agent_with_services(
        base_services,
        spec,
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink,
    )
    .await?;
    let snapshot = read_thread_snapshot(
        &thread_id,
        workspace_root.clone(),
        config_snapshot.clone(),
        "submitted thread turn snapshot",
    )?;
    agent_result["threadId"] = serde_json::Value::String(thread_id.clone());
    agent_result["threadSnapshot"] = snapshot.clone();
    let thread_stop_invocation =
        AgentHookInvocation::lifecycle(AgentHookStage::ThreadStop, trace_context);
    let thread_stop_evaluation =
        thread_hook_services.evaluate_hook_invocation(thread_stop_invocation.clone())?;
    agent_result["threadHookDiagnostics"] = serde_json::json!([
        thread_start_evaluation.event_payload(&thread_start_invocation),
        thread_stop_evaluation.event_payload(&thread_stop_invocation),
    ]);
    Ok(serde_json::json!({
        "threadId": thread_id,
        "sessionId": session_id,
        "runId": run_id,
        "agentResult": agent_result,
        "snapshot": snapshot,
    }))
}

pub(crate) async fn resolve_thread_approval_with_services(
    base_services: NativeAgentRuntimeServices,
    input: ResolveThreadApprovalInput,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let decision = if input.approved {
        AgentApprovalDecision::Approved
    } else {
        AgentApprovalDecision::Denied
    };
    let scope = match input.scope.as_deref().unwrap_or("once") {
        "once" => AgentApprovalScope::Once,
        "session" if input.approved => AgentApprovalScope::Session,
        "session" => AgentApprovalScope::Once,
        unsupported => {
            return Err(format!(
                "unsupported approval scope `{unsupported}`; expected `once` or `session`"
            ));
        }
    };
    let command_id = (!input.command_id.trim().is_empty()).then_some(input.command_id);
    let acknowledgement = base_services.approval_broker().resolve(
        &input.thread_id,
        &input.approval_id,
        decision.clone(),
        scope.clone(),
        input.guidance,
        command_id.clone(),
    )?;
    let status = match acknowledgement.decision {
        AgentApprovalDecision::Approved => "approved",
        AgentApprovalDecision::Denied => "denied",
    };
    let scope_name = match acknowledgement.scope {
        AgentApprovalScope::Once => "once",
        AgentApprovalScope::Session => "session",
    };
    Ok(serde_json::json!({
        "threadId": input.thread_id,
        "sessionId": input.thread_id,
        "approvalResult": {
            "runtime": "rust",
            "approvalId": acknowledgement.approval_id,
            "status": status,
            "decision": status,
            "scope": scope_name,
            "commandId": acknowledgement.command_id,
            "delivered": true,
        },
    }))
}

pub(crate) async fn submit_thread_form_with_services(
    base_services: NativeAgentRuntimeServices,
    input: SubmitThreadFormInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let target_snapshot = read_thread_snapshot(
        &input.thread_id,
        workspace_root.clone(),
        config_snapshot.clone(),
        "thread form target read",
    )?;
    let thread = target_snapshot
        .get("thread")
        .cloned()
        .ok_or_else(|| "thread form target read returned no thread".to_string())?;
    let thread_id = thread_thread_id(&thread)?;
    let session_id = thread_id.clone();
    let thread_checkpoint = native_session_checkpoint(
        &session_id,
        workspace_root.clone(),
        config_snapshot.clone(),
        "thread form Rollout checkpoint lookup",
    )?
    .ok_or_else(|| "thread form target has no Rollout checkpoint".to_string())?;
    let cancelled = thread_form_action_is_cancel(input.action.as_deref());
    let body = serde_json::json!({
        "session_key": session_id.clone(),
        "thread_id": thread_id.clone(),
        "values": input.values,
        "action": input.action,
        "threadCheckpoint": thread_checkpoint,
    });
    let (status_code, mut result) = resolve_agent_ui_form_body_with_services(
        base_services,
        input.form_id,
        &body,
        cancelled,
        workspace_root.clone(),
        config_snapshot.clone(),
    )
    .await?;
    result["statusCode"] = serde_json::Value::Number(status_code.into());
    let snapshot = read_thread_snapshot(
        &thread_id,
        workspace_root,
        config_snapshot,
        "thread form snapshot",
    )?;
    result["threadId"] = serde_json::Value::String(thread_id.clone());
    result["threadSnapshot"] = snapshot.clone();
    Ok(serde_json::json!({
        "threadId": thread_id,
        "sessionId": session_id,
        "formResult": result,
        "snapshot": snapshot,
    }))
}

fn ensure_thread_turn_target(
    thread_id: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match thread_id {
        Some(thread_id) if !thread_id.trim().is_empty() => {
            let snapshot = read_thread_snapshot(
                &thread_id,
                workspace_root,
                config_snapshot,
                "thread turn target read",
            )?;
            snapshot
                .get("thread")
                .cloned()
                .ok_or_else(|| "thread turn target read returned no thread".to_string())
        }
        _ => {
            let generated_thread_id = generate_thread_turn_thread_id();
            let request_id = next_worker_request_correlation();
            call_rust_state_service(
                workspace_root,
                config_snapshot,
                WorkerRequest::new(
                    request_id.id("thread-turn-create"),
                    request_id.trace_id("thread-turn-create"),
                    "thread.create",
                    serde_json::json!({
                        "threadId": generated_thread_id,
                    }),
                ),
                "thread turn target create",
            )
        }
    }
}

pub(crate) fn read_thread_snapshot(
    thread_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-turn-read"),
            request_id.trace_id("thread-turn-read"),
            "thread.read",
            serde_json::json!({ "threadId": thread_id }),
        ),
        label,
    )
}

pub(crate) fn thread_thread_id(thread: &serde_json::Value) -> Result<String, String> {
    thread
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "thread target is missing threadId".to_string())
}

fn thread_working_directory(thread: &serde_json::Value) -> Option<String> {
    thread
        .get("metadata")
        .and_then(|metadata| {
            native_agent_string_field(metadata, "workingDirectory")
                .or_else(|| native_agent_string_field(metadata, "working_directory"))
                .or_else(|| native_agent_string_field(metadata, "cwd"))
        })
        .or_else(|| native_agent_string_field(thread, "workingDirectory"))
        .or_else(|| native_agent_string_field(thread, "working_directory"))
        .or_else(|| native_agent_string_field(thread, "cwd"))
}

fn normalize_thread_turn_messages(input: serde_json::Value) -> Result<serde_json::Value, String> {
    if input
        .as_array()
        .is_some_and(|messages| !messages.is_empty())
    {
        validate_turn_messages(&input)?;
        return Ok(input);
    }
    if input
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|messages| !messages.is_empty())
    {
        let messages = input
            .get("messages")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        validate_turn_messages(&messages)?;
        return Ok(messages);
    }
    let content = input
        .get("content")
        .or_else(|| input.get("text"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if input.is_string() {
                input.as_str().unwrap_or_default().to_string()
            } else {
                input.to_string()
            }
        });
    let mut message = if input.is_object() {
        input
    } else {
        serde_json::json!({})
    };
    let object = message
        .as_object_mut()
        .ok_or_else(|| "thread turn input must be a JSON object or string".to_string())?;
    object.insert(
        "role".to_string(),
        serde_json::Value::String("user".to_string()),
    );
    object.insert("content".to_string(), serde_json::Value::String(content));
    object.remove("text");
    let messages = serde_json::json!([message]);
    validate_turn_messages(&messages)?;
    Ok(messages)
}

fn validate_turn_messages(messages: &serde_json::Value) -> Result<(), String> {
    if !messages.is_array() {
        return Err("thread turn messages must be a JSON array".to_string());
    }
    Ok(())
}

fn generate_thread_turn_run_id() -> String {
    format!("run-thread-turn-{}", now_unix_ms())
}

fn generate_thread_turn_thread_id() -> String {
    format!("thread-turn-{}", now_unix_ms())
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn thread_form_action_is_cancel(action: Option<&str>) -> bool {
    matches!(action, Some("cancel" | "cancelled" | "dismiss"))
}

fn start_native_agent_thread_turn(
    thread_id: &str,
    run_id: &str,
    spec: &serde_json::Value,
    trace_context: &AgentTraceContext,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let input = native_agent_current_user_message(spec)
        .unwrap_or_else(|| serde_json::json!({ "role": "user", "content": "" }));
    call_rust_state_service(
        workspace_root,
        config_snapshot.clone(),
        WorkerRequest::new(
            format!("{}:thread-start", trace_context.request_id),
            trace_context.trace_id.clone(),
            "thread.start_turn",
            serde_json::json!({
                "threadId": thread_id,
                "clientEventId": format!("native-agent-thread-start:{run_id}"),
                "runId": run_id,
                "turnId": run_id,
                "input": input,
                "model": native_agent_model(spec, &config_snapshot),
                "provider": native_agent_provider(spec, &config_snapshot),
                "traceContext": trace_context,
            }),
        ),
        "native agent thread turn start",
    )
}

#[cfg(test)]
mod approval_tests {
    use super::{resolve_thread_approval_with_services, ResolveThreadApprovalInput};
    use crate::agent_loop_runtime_protocol::{AgentApprovalDecision, AgentApprovalScope};
    use crate::worker_agent_runtime::approvals::{
        ApprovalRegistration, NativeAgentApprovalRequest,
    };
    use crate::worker_agent_runtime::NativeAgentRuntimeServices;

    #[test]
    fn thread_approval_resolution_only_delivers_the_decision() {
        let services = NativeAgentRuntimeServices::default();
        let receiver = match services
            .approval_broker()
            .register(NativeAgentApprovalRequest {
                approval_id: "approval-live-1".to_string(),
                session_id: "thread-live-1".to_string(),
                run_id: "run-live-1".to_string(),
                scope_key: "exec:echo-hi".to_string(),
            })
            .expect("approval should register")
        {
            ApprovalRegistration::Pending(receiver) => receiver,
            ApprovalRegistration::ApprovedForSession(_) => panic!("unexpected session grant"),
        };

        let result = tauri::async_runtime::block_on(resolve_thread_approval_with_services(
            services,
            ResolveThreadApprovalInput {
                thread_id: "thread-live-1".to_string(),
                approval_id: "approval-live-1".to_string(),
                approved: true,
                command_id: "command-live-1".to_string(),
                scope: Some("once".to_string()),
                guidance: None,
            },
            std::path::PathBuf::new(),
            serde_json::json!({}),
        ))
        .expect("approval decision should be delivered");
        assert_eq!(result["approvalResult"]["delivered"], true);
        assert_eq!(result["approvalResult"]["status"], "approved");

        let resolution = tauri::async_runtime::block_on(receiver)
            .expect("original tool future should receive the decision");
        assert_eq!(resolution.decision, AgentApprovalDecision::Approved);
        assert_eq!(resolution.scope, AgentApprovalScope::Once);
        assert_eq!(resolution.command_id.as_deref(), Some("command-live-1"));
    }
}
