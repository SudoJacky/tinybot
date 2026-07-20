use crate::agent_loop_runtime_protocol::AgentTraceContext;
use crate::native_agent_bridge::{
    native_agent_artifacts, native_agent_current_iteration, native_agent_max_iterations,
    native_agent_model, native_agent_persisted_trace_values, native_agent_provider,
    native_agent_run_completed_at, native_agent_run_id, native_agent_run_phase_from_stop_reason,
    native_agent_run_status, native_agent_session_id, native_agent_thread_id,
    native_agent_token_usage_info, native_agent_usage, native_agent_user_messages,
};
use crate::worker_agent_runtime::{agent_trace_context_from_value, NativeAgentRuntimeServices};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use crate::{call_rust_state_service, now_unix_ms};
use std::path::PathBuf;
use std::time::Instant;

pub(crate) fn reject_native_agent_terminal_run_reentry(
    spec: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let Some(session_id) = native_agent_rollout_id(spec) else {
        return Ok(None);
    };
    let Some(run_id) = native_agent_run_id(spec) else {
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
            "agent_run.list",
            serde_json::json!({ "session_id": session_id }),
        ),
        "native agent terminal run check",
        "read",
    )?;
    let Some(existing) = existing
        .get("runs")
        .and_then(serde_json::Value::as_array)
        .and_then(|runs| {
            runs.iter().find(|run| {
                run.get("runId").and_then(serde_json::Value::as_str) == Some(run_id.as_str())
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
    Ok(Some(terminal_run_rejection(
        &run_id,
        &session_id,
        status,
        phase,
    )))
}

fn native_agent_rollout_id(value: &serde_json::Value) -> Option<String> {
    native_agent_thread_id(value).or_else(|| native_agent_session_id(value))
}

fn terminal_run_rejection(
    run_id: &str,
    session_id: &str,
    status: &str,
    phase: &str,
) -> serde_json::Value {
    let message = format!("agent run `{run_id}` is terminal ({status}) and cannot continue");
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "terminal_turn",
        "messages": [],
        "toolsUsed": [],
        "completedToolResults": [],
        "error": message,
        "terminalRun": {
            "status": status,
            "phase": phase,
        },
        "events": [{
            "eventName": "agent.error",
            "payload": {
                "runId": run_id,
                "sessionId": session_id,
                "stopReason": "terminal_turn",
                "message": message,
                "error": message,
            }
        }],
    })
}

pub(crate) fn persist_native_agent_run_start(
    spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let session_id =
        native_agent_rollout_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
    let run_id = native_agent_run_id(&spec).unwrap_or_else(|| "native-rust-run".to_string());
    let record = native_agent_run_record(
        &spec,
        &serde_json::json!({ "sessionId": session_id, "runId": run_id }),
        &config_snapshot,
        &session_id,
        &run_id,
    );
    let turn_context = native_agent_turn_context(&spec, &config_snapshot, &run_id);
    let trace_context = agent_trace_context_from_value(&spec);
    call_traced_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        &trace_context,
        "run-start",
        WorkerRequest::new(
            format!("{}:run-start", trace_context.request_id),
            trace_context.trace_id.clone(),
            "agent_run.upsert",
            serde_json::json!({ "record": record }),
        ),
        "native agent run start persistence",
        "write",
    )?;
    call_traced_state_service(
        workspace_root,
        config_snapshot,
        &trace_context,
        "turn-context",
        WorkerRequest::new(
            format!("{}:turn-context", trace_context.request_id),
            trace_context.trace_id.clone(),
            "rollout.append_turn_context",
            serde_json::json!({
                "sessionId": session_id,
                "context": turn_context,
            }),
        ),
        "native agent turn context persistence",
        "write",
    )?;
    Ok(())
}

fn native_agent_turn_context(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
    run_id: &str,
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
            run_id
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

pub(crate) fn persist_native_agent_run_terminal_if_present(
    spec: serde_json::Value,
    result: &mut serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let session_id = native_agent_rollout_id(result)
        .or_else(|| native_agent_rollout_id(&spec))
        .ok_or_else(|| "Rust agent run missing session id for persistence".to_string())?;
    let run_id = native_agent_run_id(result)
        .or_else(|| native_agent_run_id(&spec))
        .unwrap_or_else(|| "native-rust-run".to_string());
    let Some(stop_reason) = result
        .get("stopReason")
        .or_else(|| result.get("stop_reason"))
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    let status = native_agent_run_status(Some(stop_reason));
    let (method, params) = match status {
        "completed" => (
            "agent_run.mark_completed",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "stop_reason": stop_reason,
                "final_content": result
                    .get("finalContent")
                    .or_else(|| result.get("final_content"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            }),
        ),
        "failed" => (
            "agent_run.mark_failed",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "stop_reason": stop_reason,
                "error": result
                    .get("error")
                    .filter(|value| !value.is_null())
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({
                        "code": stop_reason,
                        "message": format!("agent run stopped: {stop_reason}"),
                    })),
            }),
        ),
        "cancelled" => (
            "agent_run.mark_cancelled",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
            }),
        ),
        "interrupted" => (
            "agent_run.mark_interrupted",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
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
        "run-record",
        WorkerRequest::new(
            format!("{}:run-terminal", trace_context.request_id),
            trace_context.trace_id.clone(),
            method,
            params,
        ),
        "native agent run terminal persistence",
        "write",
    )?;
    result["runPersistence"] = persisted;
    Ok(())
}

pub(crate) fn native_agent_run_record(
    spec: &serde_json::Value,
    result: &serde_json::Value,
    config_snapshot: &serde_json::Value,
    session_id: &str,
    run_id: &str,
) -> serde_json::Value {
    let timestamp = now_unix_ms().to_string();
    let stop_reason = result
        .get("stopReason")
        .or_else(|| result.get("stop_reason"))
        .and_then(serde_json::Value::as_str);
    let status = native_agent_run_status(stop_reason);
    let checkpoint = result
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .cloned();
    let phase = checkpoint
        .as_ref()
        .and_then(|value| value.get("phase"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| native_agent_run_phase_from_stop_reason(stop_reason))
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
        "runId": run_id,
        "status": status,
        "phase": phase,
        "startedAt": timestamp,
        "updatedAt": timestamp,
        "completedAt": native_agent_run_completed_at(status, &timestamp),
        "stopReason": stop_reason,
        "model": native_agent_model(spec, config_snapshot),
        "provider": native_agent_provider(spec, config_snapshot),
        "maxIterations": native_agent_max_iterations(spec, config_snapshot),
        "currentIteration": native_agent_current_iteration(result, checkpoint.as_ref()),
        "conversationMessageIds": [],
        "traceMessages": [],
        "traceEvents": [],
        "completedToolResults": result
            .get("completedToolResults")
            .or_else(|| result.get("completed_tool_results"))
            .and_then(serde_json::Value::as_array)
            .map(|values| native_agent_persisted_trace_values(values))
            .unwrap_or_default(),
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

pub(crate) fn persist_native_agent_turn_if_final(
    spec: serde_json::Value,
    result: &mut serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    if result.get("stopReason").and_then(serde_json::Value::as_str) != Some("final_response") {
        return Ok(());
    }
    let session_id = native_agent_rollout_id(&spec)
        .ok_or_else(|| "Rust agent turn missing session id for persistence".to_string())?;
    let run_id = result
        .get("runId")
        .or_else(|| result.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-rust-run");
    let trace_context = trace_context_from_result_or_spec(result, &spec);
    let persisted = call_traced_state_service(
        workspace_root,
        config_snapshot,
        &trace_context,
        "session-turn-write",
        WorkerRequest::new(
            format!("{}:session-turn-write", trace_context.request_id),
            trace_context.trace_id.clone(),
            "session.persist_turn",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "messages": [],
                "clear_checkpoint": true,
                "context_metadata": {
                    "runtime": "rust",
                    "historyMessageCount": native_agent_user_messages(&spec).len(),
                    "contextCheckpoint": result
                        .get("contextCheckpoint")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                }
            }),
        ),
        "native agent session persistence",
        "write",
    )?;
    result["sessionPersistence"] = persisted;
    Ok(())
}

pub(crate) fn cancel_agent_with_services(
    services: NativeAgentRuntimeServices,
    run_id: &str,
) -> serde_json::Value {
    services.cancel(run_id)
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
