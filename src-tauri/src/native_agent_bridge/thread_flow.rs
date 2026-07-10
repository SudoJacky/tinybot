use crate::call_rust_state_service;
use crate::native_agent_bridge::{
    native_agent_assistant_messages, native_agent_current_user_message, native_agent_model,
    native_agent_provider, native_agent_run_id, native_agent_string_field, native_agent_usage,
};
use crate::worker_agent_runtime::NativeAgentRuntimeServices;
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::agent_flow::run_agent_with_services;
use super::webui_continuation::{
    resolve_agent_ui_form_body_with_services, resolve_approval_body_with_services,
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
) -> Result<serde_json::Value, String> {
    let thread = ensure_thread_turn_target(
        input.thread_id,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let thread_id = thread_thread_id(&thread)?;
    let session_id = match thread_session_key(&thread) {
        Some(session_key) => session_key,
        None => {
            let session_key = thread_id.clone();
            assign_thread_turn_session_key(
                &thread_id,
                &session_key,
                workspace_root.clone(),
                config_snapshot.clone(),
            )?;
            session_key
        }
    };
    let run_id = native_agent_run_id(&input.spec).unwrap_or_else(generate_thread_turn_run_id);
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
            normalize_thread_turn_messages(input.input),
        );
    }
    let metadata = spec_object
        .entry("metadata".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(metadata_object) = metadata.as_object_mut() {
        metadata_object.insert(
            "threadId".to_string(),
            serde_json::Value::String(thread_id.clone()),
        );
    }

    start_native_agent_thread_turn(
        &thread_id,
        &run_id,
        &spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let mut agent_result = run_agent_with_services(
        base_services,
        spec,
        workspace_root.clone(),
        config_snapshot.clone(),
        None,
    )
    .await?;
    if let Some(thread_persistence) = apply_native_agent_thread_result(
        &thread_id,
        &agent_result,
        workspace_root.clone(),
        config_snapshot.clone(),
    )? {
        agent_result["threadPersistence"] = thread_persistence;
    }
    let snapshot = read_thread_snapshot(
        &thread_id,
        workspace_root.clone(),
        config_snapshot.clone(),
        "submitted thread turn snapshot",
    )?;
    agent_result["threadId"] = serde_json::Value::String(thread_id.clone());
    agent_result["threadSnapshot"] = snapshot.clone();
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
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let thread = read_thread_target(
        &input.thread_id,
        workspace_root.clone(),
        config_snapshot.clone(),
        "thread approval target read",
    )?;
    let thread_id = thread_thread_id(&thread)?;
    let session_id = thread_session_key(&thread).unwrap_or_else(|| thread_id.clone());
    let approval_id = input.approval_id.clone();
    let approved = input.approved;
    let scope = input.scope.clone();
    let guidance = input.guidance.clone();
    let body = serde_json::json!({
        "session_key": session_id,
        "scope": input.scope,
        "guidance": input.guidance,
    });
    let mut result = resolve_approval_body_with_services(
        base_services,
        input.approval_id,
        &body,
        input.approved,
        workspace_root.clone(),
        config_snapshot.clone(),
    )
    .await?;
    if let Some(run_id) = native_agent_run_id(&result) {
        let decision = apply_native_agent_thread_op(
            &thread_id,
            Some(format!(
                "native-agent-thread-approval:{run_id}:{approval_id}:{approved}"
            )),
            serde_json::json!({
                "type": "approval_decision",
                "runId": run_id,
                "turnId": run_id,
                "approvalId": approval_id,
                "approved": approved,
                "scope": scope,
                "guidance": guidance,
                "payload": result,
            }),
            workspace_root.clone(),
            config_snapshot.clone(),
            "native agent thread approval decision append",
        )?;
        result["threadApprovalPersistence"] = decision;
    }
    if let Some(thread_persistence) = apply_native_agent_thread_result(
        &thread_id,
        &result,
        workspace_root.clone(),
        config_snapshot.clone(),
    )? {
        result["threadPersistence"] = thread_persistence;
    }
    let snapshot = read_thread_snapshot(
        &thread_id,
        workspace_root,
        config_snapshot,
        "thread approval snapshot",
    )?;
    result["threadId"] = serde_json::Value::String(thread_id.clone());
    result["threadSnapshot"] = snapshot.clone();
    Ok(serde_json::json!({
        "threadId": thread_id,
        "sessionId": session_id,
        "approvalResult": result,
        "snapshot": snapshot,
    }))
}

pub(crate) async fn submit_thread_form_with_services(
    base_services: NativeAgentRuntimeServices,
    input: SubmitThreadFormInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let thread = read_thread_target(
        &input.thread_id,
        workspace_root.clone(),
        config_snapshot.clone(),
        "thread form target read",
    )?;
    let thread_id = thread_thread_id(&thread)?;
    let session_id = thread_session_key(&thread).unwrap_or_else(|| thread_id.clone());
    let cancelled = thread_form_action_is_cancel(input.action.as_deref());
    let body = serde_json::json!({
        "session_key": session_id,
        "values": input.values,
        "action": input.action,
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
    if let Some(thread_persistence) = apply_native_agent_thread_result(
        &thread_id,
        &result,
        workspace_root.clone(),
        config_snapshot.clone(),
    )? {
        result["threadPersistence"] = thread_persistence;
    }
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
                        "sessionKey": generated_thread_id,
                    }),
                ),
                "thread turn target create",
            )
        }
    }
}

pub(crate) fn read_thread_target(
    thread_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<serde_json::Value, String> {
    let snapshot = read_thread_snapshot(thread_id, workspace_root, config_snapshot, label)?;
    snapshot
        .get("thread")
        .cloned()
        .ok_or_else(|| "thread target read returned no thread".to_string())
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

fn assign_thread_turn_session_key(
    thread_id: &str,
    session_key: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-turn-session-key"),
            request_id.trace_id("thread-turn-session-key"),
            "thread.update_metadata",
            serde_json::json!({
                "threadId": thread_id,
                "sessionKey": session_key,
                "metadata": {}
            }),
        ),
        "thread turn session key update",
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

pub(crate) fn thread_session_key(thread: &serde_json::Value) -> Option<String> {
    thread
        .get("sessionKey")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn normalize_thread_turn_messages(input: serde_json::Value) -> serde_json::Value {
    if input
        .as_array()
        .is_some_and(|messages| !messages.is_empty())
    {
        return input;
    }
    if input
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|messages| !messages.is_empty())
    {
        return input
            .get("messages")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
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
    serde_json::json!([{ "role": "user", "content": content }])
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
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let input = native_agent_current_user_message(spec)
        .unwrap_or_else(|| serde_json::json!({ "role": "user", "content": "" }));
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("native-agent-thread-start"),
            request_id.trace_id("native-agent-thread-start"),
            "thread.start_turn",
            serde_json::json!({
                "threadId": thread_id,
                "clientEventId": format!("native-agent-thread-start:{run_id}"),
                "runId": run_id,
                "turnId": run_id,
                "input": input,
                "model": native_agent_model(spec, &config_snapshot),
                "provider": native_agent_provider(spec, &config_snapshot),
            }),
        ),
        "native agent thread turn start",
    )
}

pub(crate) fn apply_native_agent_thread_result(
    thread_id: &str,
    result: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let run_id = native_agent_run_id(result)
        .ok_or_else(|| "native agent result missing runId for thread update".to_string())?;
    let stop_reason = result
        .get("stopReason")
        .or_else(|| result.get("stop_reason"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let op = match stop_reason {
        "awaiting_approval" => native_agent_thread_approval_request_op(&run_id, result)?,
        "final_response" => serde_json::json!({
            "type": "assistant_response",
            "runId": run_id,
            "turnId": run_id,
            "content": native_agent_final_content(result),
            "message": native_agent_final_assistant_message(result),
            "stopReason": stop_reason,
            "usage": native_agent_usage(result).into_iter().last(),
        }),
        "awaiting_form" | "awaiting_tool" | "tool_running" | "awaiting_subagent" => {
            return Ok(None);
        }
        _ => serde_json::json!({
            "type": "error",
            "runId": run_id,
            "turnId": run_id,
            "message": result
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("native agent run failed"),
            "details": result,
        }),
    };
    let applied = apply_native_agent_thread_op(
        thread_id,
        Some(format!("native-agent-thread-final:{run_id}:{stop_reason}")),
        op,
        workspace_root,
        config_snapshot,
        "native agent thread result append",
    )?;
    Ok(Some(applied))
}

pub(crate) fn apply_native_agent_thread_op(
    thread_id: &str,
    client_event_id: Option<String>,
    op: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("native-agent-thread-op"),
            request_id.trace_id("native-agent-thread-op"),
            "thread.apply_op",
            serde_json::json!({
                "threadId": thread_id,
                "clientEventId": client_event_id,
                "op": op,
            }),
        ),
        label,
    )
}

fn native_agent_thread_approval_request_op(
    run_id: &str,
    result: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let payload = native_agent_awaiting_approval_payload(result).ok_or_else(|| {
        "native agent awaiting approval result missing approval payload".to_string()
    })?;
    let approval_id = native_agent_string_field(&payload, "approvalId")
        .or_else(|| native_agent_string_field(&payload, "approval_id"))
        .ok_or_else(|| "native agent awaiting approval result missing approvalId".to_string())?;
    Ok(serde_json::json!({
        "type": "approval_request",
        "runId": run_id,
        "turnId": run_id,
        "approvalId": approval_id,
        "summary": native_agent_string_field(&payload, "summary"),
        "scope": native_agent_string_field(&payload, "scope"),
        "payload": payload,
    }))
}

fn native_agent_awaiting_approval_payload(result: &serde_json::Value) -> Option<serde_json::Value> {
    result
        .get("runtimeEvents")
        .and_then(serde_json::Value::as_array)
        .and_then(|events| {
            events
                .iter()
                .find(|event| {
                    event.get("eventName").and_then(serde_json::Value::as_str)
                        == Some("agent.awaiting_approval")
                })
                .and_then(|event| event.get("payload"))
                .cloned()
        })
        .or_else(|| {
            result
                .get("events")
                .and_then(serde_json::Value::as_array)
                .and_then(|events| {
                    events
                        .iter()
                        .find(|event| {
                            event.get("eventName").and_then(serde_json::Value::as_str)
                                == Some("agent.awaiting_approval")
                        })
                        .and_then(|event| event.get("payload"))
                        .cloned()
                })
        })
        .or_else(|| {
            result.get("checkpoint").and_then(|checkpoint| {
                let payload = checkpoint.get("payload")?;
                let approval_id = native_agent_string_field(payload, "approval_id")
                    .or_else(|| native_agent_string_field(payload, "approvalId"))?;
                Some(serde_json::json!({
                    "approvalId": approval_id,
                    "summary": payload
                        .get("operation")
                        .and_then(|operation| native_agent_string_field(operation, "summary")),
                    "operation": payload.get("operation").cloned().unwrap_or(serde_json::Value::Null),
                    "checkpoint": checkpoint,
                }))
            })
        })
}

fn native_agent_final_content(result: &serde_json::Value) -> Option<String> {
    native_agent_string_field(result, "finalContent")
        .or_else(|| native_agent_string_field(result, "final_content"))
        .or_else(|| {
            native_agent_assistant_messages(result)
                .into_iter()
                .rev()
                .find_map(|message| {
                    message
                        .get("content")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
        })
}

fn native_agent_final_assistant_message(result: &serde_json::Value) -> serde_json::Value {
    native_agent_assistant_messages(result)
        .into_iter()
        .last()
        .unwrap_or_else(|| {
            serde_json::json!({
                "role": "assistant",
                "content": native_agent_final_content(result).unwrap_or_default(),
            })
        })
}
