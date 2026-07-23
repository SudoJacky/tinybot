use crate::agent::bridge::{
    native_agent_artifacts, native_agent_current_iteration, native_agent_current_user_message,
    native_agent_max_iterations, native_agent_model, native_agent_provider,
    native_agent_session_id, native_agent_thread_id, native_agent_token_usage_info,
    native_agent_turn_completed_at, native_agent_turn_id, native_agent_turn_phase_from_stop_reason,
    native_agent_turn_status, native_agent_usage,
};
use crate::agent::runtime::{agent_trace_context_from_value, NativeAgentRuntimeServices};
use crate::agent::runtime_protocol::AgentTraceContext;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use std::path::PathBuf;
use std::time::Instant;

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

pub(crate) fn reject_native_agent_terminal_turn_reentry(
    spec: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let Some(session_id) = native_agent_rollout_id(spec) else {
        return Ok(None);
    };
    let Some(turn_id) = native_agent_turn_id(spec) else {
        return Ok(None);
    };
    let trace_context = agent_trace_context_from_value(spec);
    let existing = call_traced_state_service(
        workspace_root,
        config_snapshot,
        &trace_context,
        "terminal-check",
        WorkerRequest::new(
            format!("{}:terminal-check", trace_context.request_id),
            trace_context.trace_id.clone(),
            "thread.turn.list",
            serde_json::json!({ "session_id": session_id }),
        ),
        "native agent terminal turn check",
        "read",
    )?;
    let Some(existing) = existing
        .get("turns")
        .and_then(serde_json::Value::as_array)
        .and_then(|turns| {
            turns.iter().find(|turn| {
                turn.get("turnId").and_then(serde_json::Value::as_str) == Some(turn_id.as_str())
            })
        })
    else {
        return Ok(None);
    };
    let status = existing
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !matches!(status, "completed" | "failed" | "cancelled") {
        return Ok(None);
    }
    let phase = existing
        .get("phase")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(status);
    Ok(Some(terminal_turn_rejection(
        &turn_id,
        &session_id,
        status,
        phase,
    )))
}

fn native_agent_rollout_id(value: &serde_json::Value) -> Option<String> {
    native_agent_thread_id(value).or_else(|| native_agent_session_id(value))
}

fn terminal_turn_rejection(
    turn_id: &str,
    session_id: &str,
    status: &str,
    phase: &str,
) -> serde_json::Value {
    let message = format!("agent turn `{turn_id}` is terminal ({status}) and cannot continue");
    serde_json::json!({
        "runtime": "rust",
        "turnId": turn_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "terminal_turn",
        "messages": [],
        "toolsUsed": [],
        "completedToolResults": [],
        "error": message,
        "terminalTurn": {
            "status": status,
            "phase": phase,
        },
        "events": [{
            "eventName": "agent.error",
            "payload": {
                "turnId": turn_id,
                "sessionId": session_id,
                "stopReason": "terminal_turn",
                "message": message,
                "error": message,
            }
        }],
    })
}

pub(crate) fn persist_native_agent_turn_start(
    spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let session_id =
        native_agent_rollout_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
    let turn_id = native_agent_turn_id(&spec).unwrap_or_else(|| "native-rust-turn".to_string());
    let record = native_agent_turn_record(
        &spec,
        &serde_json::json!({ "sessionId": session_id, "turnId": turn_id }),
        &config_snapshot,
        &session_id,
        &turn_id,
    );
    let turn_context = native_agent_turn_context(&spec, &config_snapshot, &turn_id);
    let messages = materialized_turn_messages(&spec, &turn_id);
    let trace_context = agent_trace_context_from_value(&spec);
    call_traced_state_service(
        workspace_root,
        config_snapshot,
        &trace_context,
        "turn-start",
        WorkerRequest::new(
            format!("{}:turn-start", trace_context.request_id),
            trace_context.trace_id.clone(),
            "thread.turn.start",
            serde_json::json!({
                "record": record,
                "context": turn_context,
                "messages": messages,
            }),
        ),
        "native agent turn start persistence",
        "write",
    )?;
    Ok(())
}

fn materialized_turn_messages(spec: &serde_json::Value, turn_id: &str) -> Vec<serde_json::Value> {
    let mut messages = Vec::new();
    if let Some(content) = spec
        .get("materializedSystemPrompt")
        .and_then(serde_json::Value::as_str)
        .filter(|content| !content.is_empty())
    {
        let content_hash = spec
            .get("instructionProvenance")
            .and_then(|provenance| provenance.get("contentHash"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        messages.push(serde_json::json!({
            "type": "message",
            "id": format!("system:{content_hash}"),
            "role": "system",
            "content": [{ "type": "input_text", "text": content }],
            "contentHash": content_hash,
        }));
    }
    if let Some(mut user) = native_agent_current_user_message(spec) {
        user["type"] = serde_json::Value::String("message".to_string());
        user["role"] = serde_json::Value::String("user".to_string());
        let message_id = user
            .get("id")
            .or_else(|| user.get("messageId"))
            .cloned()
            .unwrap_or_else(|| serde_json::Value::String(format!("user:{turn_id}")));
        user["id"] = message_id.clone();
        user["messageId"] = message_id;
        user["turnId"] = serde_json::Value::String(turn_id.to_string());
        messages.push(user);
    }
    messages
}

fn native_agent_turn_context(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
    turn_id: &str,
) -> serde_json::Value {
    let defaults = config_snapshot
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .unwrap_or(&serde_json::Value::Null);
    let cwd = spec
        .get("instructionProvenance")
        .and_then(|provenance| provenance.get("workingDirectory"))
        .or_else(|| spec.get("workingDirectory"))
        .or_else(|| spec.get("working_directory"))
        .or_else(|| spec.get("cwd"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let trace_context = agent_trace_context_from_value(spec);
    serde_json::json!({
        "turn_id": if trace_context.turn_id.trim().is_empty() {
            turn_id
        } else {
            trace_context.turn_id.as_str()
        },
        "cwd": cwd,
        "workspace_roots": if cwd.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!([cwd])
        },
        "current_date": spec.get("currentDate").cloned().unwrap_or(serde_json::Value::Null),
        "timezone": spec.get("timezone").cloned().unwrap_or(serde_json::Value::Null),
        "approval_policy": spec
            .get("approvalPolicy")
            .or_else(|| defaults.get("approvalPolicy"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!("on_request")),
        "sandbox_policy": spec
            .get("sandboxPolicy")
            .or_else(|| defaults.get("sandboxPolicy"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!("workspace_write")),
        "permission_profile": spec
            .get("permissionProfile")
            .or_else(|| defaults.get("permissionProfile"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "network": spec.get("network").cloned().unwrap_or(serde_json::Value::Null),
        "model": native_agent_model(spec, config_snapshot),
        "provider": native_agent_provider(spec, config_snapshot),
        "comp_hash": spec
            .get("compHash")
            .or_else(|| spec.get("comp_hash"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "personality": spec
            .get("personality")
            .or_else(|| defaults.get("personality"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "collaboration_mode": spec
            .get("collaborationMode")
            .or_else(|| defaults.get("collaborationMode"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "effort": spec
            .get("reasoningEffort")
            .or_else(|| defaults.get("reasoningEffort"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "summary": spec
            .get("reasoningSummary")
            .or_else(|| defaults.get("reasoningSummary"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!("auto")),
    })
}

pub(crate) fn persist_native_agent_turn_terminal_if_present(
    spec: serde_json::Value,
    result: &mut serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let session_id = native_agent_rollout_id(result)
        .or_else(|| native_agent_rollout_id(&spec))
        .ok_or_else(|| "Rust agent turn missing session id for persistence".to_string())?;
    let turn_id = native_agent_turn_id(result)
        .or_else(|| native_agent_turn_id(&spec))
        .unwrap_or_else(|| "native-rust-turn".to_string());
    let Some(stop_reason) = result
        .get("stopReason")
        .or_else(|| result.get("stop_reason"))
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    let status = native_agent_turn_status(Some(stop_reason));
    let (method, params) = match status {
        "completed" => (
            "thread.turn.mark_completed",
            serde_json::json!({
                "session_id": session_id,
                "turn_id": turn_id,
                "stop_reason": stop_reason,
                "final_content": result
                    .get("finalContent")
                    .or_else(|| result.get("final_content"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "context_checkpoint": result
                    .get("contextCheckpoint")
                    .or_else(|| result.get("context_checkpoint"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            }),
        ),
        "failed" => (
            "thread.turn.mark_failed",
            serde_json::json!({
                "session_id": session_id,
                "turn_id": turn_id,
                "stop_reason": stop_reason,
                "error": result
                    .get("error")
                    .filter(|value| !value.is_null())
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({
                        "code": stop_reason,
                        "message": format!("agent turn stopped: {stop_reason}"),
                    })),
                "context_checkpoint": result
                    .get("contextCheckpoint")
                    .or_else(|| result.get("context_checkpoint"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            }),
        ),
        "cancelled" => (
            "thread.turn.mark_cancelled",
            serde_json::json!({
                "session_id": session_id,
                "turn_id": turn_id,
            }),
        ),
        "interrupted" => (
            "thread.turn.mark_interrupted",
            serde_json::json!({
                "session_id": session_id,
                "turn_id": turn_id,
                "reason": result
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(stop_reason),
            }),
        ),
        "running" | "waiting" => return Ok(()),
        _ => {
            return Err(format!(
                "unsupported native agent terminal status `{status}`"
            ))
        }
    };
    let trace_context = trace_context_from_result_or_spec(result, &spec);
    let persisted = call_traced_state_service(
        workspace_root,
        config_snapshot,
        &trace_context,
        "turn-record",
        WorkerRequest::new(
            format!("{}:turn-terminal", trace_context.request_id),
            trace_context.trace_id.clone(),
            method,
            params,
        ),
        "native agent turn terminal persistence",
        "write",
    )?;
    result["turnPersistence"] = persisted;
    Ok(())
}

pub(crate) fn native_agent_turn_record(
    spec: &serde_json::Value,
    result: &serde_json::Value,
    config_snapshot: &serde_json::Value,
    session_id: &str,
    turn_id: &str,
) -> serde_json::Value {
    let timestamp = now_unix_ms().to_string();
    let stop_reason = result
        .get("stopReason")
        .or_else(|| result.get("stop_reason"))
        .and_then(serde_json::Value::as_str);
    let status = native_agent_turn_status(stop_reason);
    let checkpoint = result
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .cloned();
    let phase = checkpoint
        .as_ref()
        .and_then(|value| value.get("phase"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| native_agent_turn_phase_from_stop_reason(stop_reason))
        .unwrap_or("planning");
    let error = result
        .get("error")
        .filter(|value| !value.is_null())
        .cloned();
    let instruction_provenance = result
        .get("instructionProvenance")
        .or_else(|| spec.get("instructionProvenance"))
        .filter(|value| !value.is_null())
        .cloned();
    let instruction_diagnostics = result
        .get("instructionDiagnostics")
        .or_else(|| spec.get("instructionDiagnostics"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let trace_context = trace_context_from_result_or_spec(result, spec);

    serde_json::json!({
        "sessionId": session_id,
        "turnId": turn_id,
        "status": status,
        "phase": phase,
        "startedAt": timestamp,
        "updatedAt": timestamp,
        "completedAt": native_agent_turn_completed_at(status, &timestamp),
        "stopReason": stop_reason,
        "model": native_agent_model(spec, config_snapshot),
        "provider": native_agent_provider(spec, config_snapshot),
        "maxIterations": native_agent_max_iterations(spec, config_snapshot),
        "currentIteration": native_agent_current_iteration(result, checkpoint.as_ref()),
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": checkpoint
            .as_ref()
            .and_then(|value| value.get("pendingToolCalls").or_else(|| value.get("pending_tool_calls")))
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default(),
        "checkpoint": checkpoint,
        "artifacts": native_agent_artifacts(result),
        "usage": native_agent_usage(result),
        "tokenUsageInfo": native_agent_token_usage_info(result),
        "instructionProvenance": instruction_provenance,
        "instructionDiagnostics": instruction_diagnostics,
        "traceContext": trace_context,
        "error": error,
    })
}

pub(crate) fn persist_native_agent_checkpoint_if_present(
    result: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let Some(checkpoint) = result.get("checkpoint").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let session_id = native_agent_rollout_id(result)
        .ok_or_else(|| "Rust agent checkpoint missing session id".to_string())?;
    let trace_context = agent_trace_context_from_value(result);
    call_traced_state_service(
        workspace_root,
        config_snapshot,
        &trace_context,
        "checkpoint-write",
        WorkerRequest::new(
            format!("{}:checkpoint-write", trace_context.request_id),
            trace_context.trace_id.clone(),
            "session.set_checkpoint",
            serde_json::json!({
                "session_id": session_id,
                "checkpoint": checkpoint,
            }),
        ),
        "native agent checkpoint persistence",
        "write",
    )?;
    Ok(())
}

pub(crate) fn cancel_agent_with_services(
    services: NativeAgentRuntimeServices,
    turn_id: &str,
) -> serde_json::Value {
    services.cancel(turn_id)
}

pub(crate) fn restore_agent_checkpoint_with_services(
    services: NativeAgentRuntimeServices,
    session_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let restored = services.restore_checkpoint(&session_id);
    if !restored
        .get("checkpoint")
        .is_some_and(|value| !value.is_null())
    {
        return restore_native_agent_checkpoint_from_session_store(
            session_id,
            workspace_root,
            config_snapshot,
        );
    }
    validate_native_agent_checkpoint_version(restored.get("checkpoint"))?;
    Ok(restored)
}

fn restore_native_agent_checkpoint_from_session_store(
    session_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let checkpoint = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-get-native-checkpoint"),
            request_id.trace_id("session-get-native-checkpoint"),
            "session.get_checkpoint",
            serde_json::json!({ "session_id": session_id.clone() }),
        ),
        "native agent checkpoint restore",
    )?;
    validate_native_agent_checkpoint_version(Some(&checkpoint))?;
    Ok(serde_json::json!({
        "runtime": "rust",
        "sessionId": session_id,
        "checkpoint": checkpoint,
    }))
}

fn validate_native_agent_checkpoint_version(
    checkpoint: Option<&serde_json::Value>,
) -> Result<(), String> {
    let Some(checkpoint) = checkpoint.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let Some(schema_version) = checkpoint
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
    else {
        return Ok(());
    };
    if schema_version == 1 {
        return Ok(());
    }
    Err(format!(
        "unsupported Rust agent checkpoint schemaVersion {schema_version}"
    ))
}

fn trace_context_from_result_or_spec(
    result: &serde_json::Value,
    spec: &serde_json::Value,
) -> AgentTraceContext {
    if result.get("traceContext").is_some()
        || result.get("traceId").is_some()
        || result.get("trace_id").is_some()
    {
        return agent_trace_context_from_value(result);
    }
    agent_trace_context_from_value(spec)
}

#[allow(clippy::too_many_arguments)]
fn call_traced_state_service(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    trace_context: &AgentTraceContext,
    operation: &str,
    request: WorkerRequest,
    label: &str,
    metric_kind: &str,
) -> Result<serde_json::Value, String> {
    let metrics = crate::runtime::observability::global_agent_runtime_metrics();
    metrics.increment(&format!("persistence.{metric_kind}.started"));
    if request.trace_id != trace_context.trace_id
        || !request.id.starts_with(&trace_context.request_id)
    {
        metrics.increment(&format!("persistence.{metric_kind}.failed"));
        return Err(format!(
            "persistence operation `{operation}` lost its root request/trace correlation"
        ));
    }
    let started_at = Instant::now();
    let result = call_rust_state_service(workspace_root, config_snapshot, request, label);
    metrics.record_duration(
        &format!("persistence.{metric_kind}.durationMs"),
        started_at.elapsed(),
    );
    metrics.increment(&format!(
        "persistence.{metric_kind}.{}",
        if result.is_ok() {
            "completed"
        } else {
            "failed"
        }
    ));
    result
}

#[cfg(test)]
#[path = "persistence_tests.rs"]
mod tests;
