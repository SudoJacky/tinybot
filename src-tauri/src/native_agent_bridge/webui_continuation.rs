use crate::call_rust_state_service;
use crate::native_agent_bridge::{
    native_agent_services_with_tool_executor, persist_native_agent_checkpoint_if_present,
    persist_native_agent_run_record, persist_native_agent_turn_if_final,
};
use crate::worker_agent_runtime::{
    run_native_agent_turn_with_workspace, NativeAgentRuntimeServices,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use std::path::PathBuf;

pub(crate) fn pending_approvals_from_checkpoint(
    checkpoint: Option<&serde_json::Value>,
) -> Vec<serde_json::Value> {
    let Some(checkpoint) = checkpoint else {
        return Vec::new();
    };
    if checkpoint.get("phase").and_then(serde_json::Value::as_str) != Some("awaiting_approval") {
        return Vec::new();
    }
    let payload = checkpoint
        .get("payload")
        .and_then(serde_json::Value::as_object);
    let operation = payload
        .and_then(|payload| payload.get("operation"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let approval_id = payload
        .and_then(|payload| payload.get("approval_id"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("approvalId"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            operation
                .get("approvalId")
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("approval-1");
    let tool_name = operation
        .get("toolName")
        .or_else(|| operation.get("tool_name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("approval");
    let run_id = checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let session_id = checkpoint
        .get("sessionId")
        .or_else(|| checkpoint.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    vec![serde_json::json!({
        "id": approval_id,
        "runId": run_id,
        "sessionId": session_id,
        "operation": operation,
        "category": operation.get("category").and_then(serde_json::Value::as_str).unwrap_or("tool"),
        "risk": operation.get("risk").and_then(serde_json::Value::as_str).unwrap_or("medium"),
        "reason": operation.get("reason").and_then(serde_json::Value::as_str).unwrap_or("This tool requires user approval before execution."),
        "summary": operation.get("summary").and_then(serde_json::Value::as_str).unwrap_or(tool_name),
        "fingerprint": operation.get("fingerprint").and_then(serde_json::Value::as_str).unwrap_or(approval_id),
        "sessionFingerprint": operation.get("sessionFingerprint").and_then(serde_json::Value::as_str).unwrap_or(approval_id),
        "tool_name": tool_name,
    })]
}

#[cfg(test)]
mod tests {
    use super::pending_approvals_from_checkpoint;

    #[test]
    fn pending_approvals_preserve_runtime_tool_approval_id() {
        let checkpoint = serde_json::json!({
            "phase": "awaiting_approval",
            "runId": "run-deferred-write",
            "sessionId": "session-deferred-write",
            "payload": {
                "kind": "tool_approval",
                "approvalId": "approval:run-deferred-write:call-write",
                "operation": {
                    "toolCallId": "call-write",
                    "toolName": "workspace.write_file",
                    "arguments": {
                        "path": "notes.txt",
                        "contents": "hello"
                    }
                }
            }
        });

        let approvals = pending_approvals_from_checkpoint(Some(&checkpoint));

        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0]["id"], "approval:run-deferred-write:call-write");
        assert_eq!(approvals[0]["tool_name"], "workspace.write_file");
    }
}

pub(crate) fn native_approval_continuation_spec(
    checkpoint: &serde_json::Value,
    body: &serde_json::Value,
    approval_id: &str,
    approved: bool,
) -> serde_json::Value {
    let run_id = checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-approval-resolution");
    let session_id = checkpoint
        .get("sessionId")
        .or_else(|| checkpoint.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-rust-session");
    let operation = checkpoint
        .get("payload")
        .and_then(|payload| payload.get("operation"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let tool_name = operation
        .get("toolName")
        .or_else(|| operation.get("tool_name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("approval");
    let guidance = approval_guidance_value(body);
    let mut agent_continuation = serde_json::json!({
        "kind": "approval",
        "approvalId": approval_id,
        "decision": if approved { "approved" } else { "denied" },
        "scope": if body.get("scope").and_then(serde_json::Value::as_str) == Some("session") {
            "session"
        } else {
            "once"
        },
    });
    if let Some(guidance) = guidance {
        agent_continuation["guidance"] = serde_json::Value::String(guidance);
    }
    let mut metadata = serde_json::json!({
        "agentContinuation": agent_continuation,
    });
    if let Some(final_content) = body
        .get("finalContent")
        .or_else(|| body.get("final_content"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        metadata["finalContent"] = serde_json::Value::String(final_content.to_string());
    }
    if tool_name != "approval" {
        metadata["toolName"] = serde_json::Value::String(tool_name.to_string());
    }
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "messages": checkpoint
            .get("messages")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "metadata": metadata,
    })
}

pub(crate) fn approval_guidance_value(body: &serde_json::Value) -> Option<String> {
    body.get("guidance")
        .or_else(|| body.get("user_guidance"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn native_webui_approval_not_found_body(
    approval_id: String,
    body: &serde_json::Value,
    approved: bool,
) -> serde_json::Value {
    let session_key = body
        .get("session_key")
        .or_else(|| body.get("sessionId"))
        .or_else(|| body.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let scope = body
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("once");
    serde_json::json!({
        "ok": false,
        "status": "not_found",
        "approvalId": approval_id,
        "approved": approved,
        "scope": scope,
        "session_key": session_key,
        "source": "rust",
        "error": {
            "message": "pending approval not found",
        },
    })
}

pub(crate) fn resolve_approval_body_with_services(
    base_services: NativeAgentRuntimeServices,
    approval_id: String,
    body: &serde_json::Value,
    approved: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_key = body
        .get("session_key")
        .or_else(|| body.get("sessionId"))
        .or_else(|| body.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let Some(checkpoint) = native_session_checkpoint(
        session_key,
        workspace_root.clone(),
        config_snapshot.clone(),
        "native approval resolution checkpoint lookup",
    )?
    else {
        return Ok(native_webui_approval_not_found_body(
            approval_id,
            body,
            approved,
        ));
    };
    let pending = pending_approvals_from_checkpoint(Some(&checkpoint));
    let Some(approval) = pending.iter().find(|approval| {
        approval.get("id").and_then(serde_json::Value::as_str) == Some(&approval_id)
    }) else {
        return Ok(native_webui_approval_not_found_body(
            approval_id,
            body,
            approved,
        ));
    };

    resolve_approval_continuation_with_services(
        base_services,
        session_key,
        checkpoint,
        approval,
        approval_id,
        body,
        approved,
        workspace_root,
        config_snapshot,
    )
}

pub(crate) fn resolve_approval_continuation_with_services(
    base_services: NativeAgentRuntimeServices,
    session_key: &str,
    checkpoint: serde_json::Value,
    approval: &serde_json::Value,
    approval_id: String,
    body: &serde_json::Value,
    approved: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let scope = body
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("once");
    let continuation_spec =
        native_approval_continuation_spec(&checkpoint, body, &approval_id, approved);
    base_services.save_checkpoint(session_key, checkpoint);
    let services = native_agent_services_with_tool_executor(
        base_services,
        workspace_root.clone(),
        config_snapshot.clone(),
    );
    let mut continuation = run_native_agent_turn_with_workspace(
        &services,
        continuation_spec.clone(),
        config_snapshot.clone(),
        &workspace_root,
    )?;
    persist_native_agent_run_record(
        continuation_spec.clone(),
        &mut continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_checkpoint_if_present(
        &continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_turn_if_final(
        continuation_spec,
        &mut continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    clear_native_session_checkpoint(
        session_key,
        workspace_root,
        config_snapshot,
        "native approval resolution checkpoint clear",
    )?;
    continuation["ok"] = serde_json::Value::Bool(true);
    continuation["status"] =
        serde_json::Value::String(if approved { "approved" } else { "denied" }.to_string());
    continuation["approvalId"] = serde_json::Value::String(approval_id);
    continuation["approved"] = serde_json::Value::Bool(approved);
    continuation["scope"] = serde_json::Value::String(scope.to_string());
    continuation["session_key"] = serde_json::Value::String(session_key.to_string());
    continuation["source"] = serde_json::Value::String("rust".to_string());
    if let Some(guidance) = approval_guidance_value(body) {
        continuation["guidance"] = serde_json::Value::String(guidance);
    }
    continuation["operation"] = approval
        .get("operation")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["category"] = approval
        .get("category")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["risk"] = approval
        .get("risk")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["reason"] = approval
        .get("reason")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["summary"] = approval
        .get("summary")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["fingerprint"] = approval
        .get("fingerprint")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["sessionFingerprint"] = approval
        .get("sessionFingerprint")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(continuation)
}

pub(crate) fn native_webui_agent_ui_form_not_found_body(form_id: String) -> serde_json::Value {
    serde_json::json!({
        "submitted": false,
        "cancelled": false,
        "form_id": form_id,
        "source": "rust",
        "error": "pending form checkpoint not found",
    })
}

pub(crate) fn resolve_agent_ui_form_body_with_services(
    base_services: NativeAgentRuntimeServices,
    form_id: String,
    body: &serde_json::Value,
    cancelled: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(u16, serde_json::Value), String> {
    let session_key = agent_ui_form_session_key(body).unwrap_or_default();
    let values = body
        .get("values")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(checkpoint) = native_session_checkpoint(
        &session_key,
        workspace_root.clone(),
        config_snapshot.clone(),
        "native Agent UI form checkpoint lookup",
    )?
    else {
        return Ok((404, native_webui_agent_ui_form_not_found_body(form_id)));
    };
    if checkpoint.get("phase").and_then(serde_json::Value::as_str) != Some("awaiting_form")
        || checkpoint
            .get("payload")
            .and_then(|payload| payload.get("form_id"))
            .and_then(serde_json::Value::as_str)
            != Some(&form_id)
    {
        return Ok((404, native_webui_agent_ui_form_not_found_body(form_id)));
    }
    let errors = validate_agent_ui_form_values(&checkpoint, &values);
    if !cancelled && !errors.is_empty() {
        return Ok((
            400,
            serde_json::json!({
                "submitted": false,
                "form_id": form_id,
                "values": values,
                "errors": errors,
                "event": native_agent_ui_form_event("ui.form.validation_failed", &form_id, &values),
                "source": "rust",
            }),
        ));
    }

    let continuation = resolve_agent_ui_form_with_services(
        base_services,
        &session_key,
        checkpoint,
        form_id,
        body,
        values,
        cancelled,
        workspace_root,
        config_snapshot,
    )?;
    Ok((200, continuation))
}

pub(crate) fn agent_ui_form_session_key(body: &serde_json::Value) -> Option<String> {
    body.get("correlation")
        .and_then(|correlation| {
            correlation
                .get("session_key")
                .or_else(|| correlation.get("sessionId"))
                .or_else(|| correlation.get("session_id"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            body.get("session_key")
                .or_else(|| body.get("sessionId"))
                .or_else(|| body.get("session_id"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn validate_agent_ui_form_values(
    checkpoint: &serde_json::Value,
    values: &serde_json::Value,
) -> serde_json::Map<String, serde_json::Value> {
    let mut errors = serde_json::Map::new();
    let Some(fields) = checkpoint
        .get("payload")
        .and_then(|payload| payload.get("form"))
        .and_then(|form| form.get("fields"))
        .and_then(serde_json::Value::as_array)
    else {
        return errors;
    };
    for field in fields {
        if field.get("required").and_then(serde_json::Value::as_bool) != Some(true) {
            continue;
        }
        let Some(name) = field.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let missing = values
            .get(name)
            .is_none_or(|value| value.is_null() || value.as_str().is_some_and(str::is_empty));
        if missing {
            errors.insert(
                name.to_string(),
                serde_json::Value::String("Required".to_string()),
            );
        }
    }
    errors
}

pub(crate) fn native_agent_ui_form_continuation_spec(
    checkpoint: &serde_json::Value,
    body: &serde_json::Value,
    form_id: &str,
    values: &serde_json::Value,
    cancelled: bool,
) -> serde_json::Value {
    let run_id = checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-form-resolution");
    let session_id = checkpoint
        .get("sessionId")
        .or_else(|| checkpoint.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-rust-session");
    let mut metadata = serde_json::json!({
        "agentContinuation": {
            "kind": "form",
            "formId": form_id,
            "action": if cancelled { "cancel" } else { "submit" },
            "values": values,
        },
    });
    if let Some(final_content) = body
        .get("finalContent")
        .or_else(|| body.get("final_content"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        metadata["finalContent"] = serde_json::Value::String(final_content.to_string());
    }
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "messages": checkpoint
            .get("messages")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "metadata": metadata,
    })
}

pub(crate) fn native_agent_ui_form_event(
    event_type: &str,
    form_id: &str,
    values: &serde_json::Value,
) -> serde_json::Value {
    let mut payload = serde_json::json!({ "form_id": form_id });
    if event_type == "ui.form.submitted" || event_type == "ui.form.validation_failed" {
        payload["values"] = values.clone();
    }
    serde_json::json!({
        "event_type": event_type,
        "payload": payload,
    })
}

pub(crate) fn resolve_agent_ui_form_with_services(
    base_services: NativeAgentRuntimeServices,
    session_key: &str,
    checkpoint: serde_json::Value,
    form_id: String,
    body: &serde_json::Value,
    values: serde_json::Value,
    cancelled: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let continuation_spec =
        native_agent_ui_form_continuation_spec(&checkpoint, body, &form_id, &values, cancelled);
    base_services.save_checkpoint(session_key, checkpoint);
    let services = native_agent_services_with_tool_executor(
        base_services,
        workspace_root.clone(),
        config_snapshot.clone(),
    );
    let mut continuation = run_native_agent_turn_with_workspace(
        &services,
        continuation_spec.clone(),
        config_snapshot.clone(),
        &workspace_root,
    )?;
    persist_native_agent_run_record(
        continuation_spec.clone(),
        &mut continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_checkpoint_if_present(
        &continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_turn_if_final(
        continuation_spec,
        &mut continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    clear_native_session_checkpoint(
        session_key,
        workspace_root,
        config_snapshot,
        "native Agent UI form checkpoint clear",
    )?;
    continuation["form_id"] = serde_json::Value::String(form_id.clone());
    continuation["source"] = serde_json::Value::String("rust".to_string());
    continuation["continuation"] = serde_json::json!({
        "mode": "resume",
        "delivered": true,
        "target": "agent_loop",
    });
    if cancelled {
        continuation["cancelled"] = serde_json::Value::Bool(true);
        continuation["event"] = native_agent_ui_form_event("ui.form.cancelled", &form_id, &values);
    } else {
        continuation["submitted"] = serde_json::Value::Bool(true);
        continuation["values"] = values.clone();
        continuation["event"] = native_agent_ui_form_event("ui.form.submitted", &form_id, &values);
    }
    Ok(continuation)
}

pub(crate) fn clear_native_session_checkpoint(
    session_key: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-clear-checkpoint"),
            request_id.trace_id("session-clear-checkpoint"),
            "session.clear_checkpoint",
            serde_json::json!({ "session_id": session_key }),
        ),
        label,
    )?;
    Ok(())
}

pub(crate) fn native_session_checkpoint(
    session_key: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<Option<serde_json::Value>, String> {
    let request_id = next_worker_request_correlation();
    let checkpoint = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-get-checkpoint"),
            request_id.trace_id("session-get-checkpoint"),
            "session.get_checkpoint",
            serde_json::json!({ "session_id": session_key }),
        ),
        label,
    )?;
    Ok(if checkpoint.is_null() {
        None
    } else {
        Some(checkpoint)
    })
}
