use crate::agent_loop_runtime_protocol::{
    AgentRuntimeEventAppendInput, AgentRuntimeEventAppender, AgentRuntimeEventSource,
    AgentRuntimeEventVisibility, AgentRuntimePhase, AgentTraceContext,
};
use crate::native_agent_bridge::{
    attach_native_agent_latest_usage, native_agent_artifacts, native_agent_assistant_messages,
    native_agent_current_iteration, native_agent_current_user_message, native_agent_max_iterations,
    native_agent_message_id, native_agent_model, native_agent_persisted_runtime_event,
    native_agent_persisted_trace_values, native_agent_provider, native_agent_run_completed_at,
    native_agent_run_id, native_agent_run_phase_from_stop_reason, native_agent_run_status,
    native_agent_session_id, native_agent_thread_id, native_agent_token_usage_info,
    native_agent_trace_event_item_id, native_agent_usage, native_agent_user_messages,
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
    let mut record = native_agent_run_record(
        &spec,
        &serde_json::json!({ "sessionId": session_id, "runId": run_id }),
        &config_snapshot,
        &session_id,
        &run_id,
    );
    record["traceEvents"] = serde_json::json!([]);
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
        "turnId": if trace_context.turn_id.trim().is_empty() {
            run_id
        } else {
            trace_context.turn_id.as_str()
        },
        "cwd": cwd,
        "workspaceRoots": if cwd.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!([cwd])
        },
        "currentDate": spec.get("currentDate").cloned().unwrap_or(serde_json::Value::Null),
        "timezone": spec.get("timezone").cloned().unwrap_or(serde_json::Value::Null),
        "approvalPolicy": spec
            .get("approvalPolicy")
            .or_else(|| defaults.get("approvalPolicy"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!("on_request")),
        "sandboxPolicy": spec
            .get("sandboxPolicy")
            .or_else(|| defaults.get("sandboxPolicy"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!("workspace_write")),
        "permissionProfile": spec
            .get("permissionProfile")
            .or_else(|| defaults.get("permissionProfile"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "network": spec.get("network").cloned().unwrap_or(serde_json::Value::Null),
        "model": native_agent_model(spec, config_snapshot),
        "provider": native_agent_provider(spec, config_snapshot),
        "compHash": spec
            .get("compHash")
            .or_else(|| spec.get("comp_hash"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "personality": spec
            .get("personality")
            .or_else(|| defaults.get("personality"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "collaborationMode": spec
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

pub(crate) fn persist_native_agent_run_record(
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
    let record = native_agent_run_record(&spec, result, &config_snapshot, &session_id, &run_id);
    let trace_context = trace_context_from_result_or_spec(result, &spec);
    let persisted = call_traced_state_service(
        workspace_root,
        config_snapshot,
        &trace_context,
        "run-record",
        WorkerRequest::new(
            format!("{}:run-record", trace_context.request_id),
            trace_context.trace_id.clone(),
            "agent_run.upsert",
            serde_json::json!({ "record": record }),
        ),
        "native agent run persistence",
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
        "traceMessages": native_agent_assistant_messages(result),
        "traceEvents": native_agent_runtime_trace_events(spec, result, session_id, run_id, &timestamp),
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
    let mut messages = native_agent_user_messages(&spec);
    let mut assistant_messages = native_agent_assistant_messages(result);
    attach_native_agent_latest_usage(&mut assistant_messages, result);
    messages.extend(assistant_messages);
    if messages.is_empty() {
        return Ok(());
    }
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
                "messages": messages,
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

fn native_agent_runtime_trace_events(
    spec: &serde_json::Value,
    result: &serde_json::Value,
    session_id: &str,
    run_id: &str,
    timestamp: &str,
) -> Vec<serde_json::Value> {
    if let Some(runtime_events) = result
        .get("runtimeEvents")
        .and_then(serde_json::Value::as_array)
        .filter(|events| !events.is_empty())
    {
        return native_agent_persisted_trace_values(runtime_events);
    }

    let mut trace_context = trace_context_from_result_or_spec(result, spec);
    trace_context.run_id = run_id.to_string();
    if trace_context.turn_id.trim().is_empty() {
        trace_context.turn_id = run_id.to_string();
    }
    trace_context.thread_id = trace_context
        .thread_id
        .or_else(|| native_agent_thread_id(spec));
    let mut appender = AgentRuntimeEventAppender::new_with_trace_context(session_id, trace_context);
    let user_message = native_agent_current_user_message(spec);
    let user_message_id = user_message.as_ref().and_then(native_agent_message_id);
    let mut trace_events = vec![native_agent_persisted_runtime_event(appender.append(
        AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.turn.started".to_string(),
            phase: AgentRuntimePhase::Planning,
            timestamp: timestamp.to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: serde_json::json!({
                "sessionId": session_id,
                "runId": run_id,
                "userMessageId": user_message_id,
                "userMessage": user_message,
            }),
        },
    ))];

    let mut current_phase = AgentRuntimePhase::Planning;
    native_agent_push_phase_transition(
        &mut trace_events,
        &mut appender,
        &mut current_phase,
        AgentRuntimePhase::HydratingHistory,
        timestamp,
        "agent.history.hydrated",
    );
    native_agent_push_phase_transition(
        &mut trace_events,
        &mut appender,
        &mut current_phase,
        AgentRuntimePhase::CallingModel,
        timestamp,
        "agent.model.calling",
    );
    if let Some(events) = result.get("events").and_then(serde_json::Value::as_array) {
        for event in events {
            let event_name = event
                .get("eventName")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty());
            let Some(event_name) = event_name else {
                continue;
            };
            let next_phase = AgentRuntimePhase::for_legacy_event(event_name);
            if event_name == "agent.done" {
                native_agent_push_phase_transition(
                    &mut trace_events,
                    &mut appender,
                    &mut current_phase,
                    AgentRuntimePhase::Finalizing,
                    timestamp,
                    event_name,
                );
            }
            native_agent_push_phase_transition(
                &mut trace_events,
                &mut appender,
                &mut current_phase,
                next_phase,
                timestamp,
                event_name,
            );
            let payload = event
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            trace_events.push(native_agent_persisted_runtime_event(
                appender.append_legacy_native_event(
                    event_name,
                    native_agent_trace_event_item_id(event),
                    timestamp,
                    payload,
                ),
            ));
        }
    }

    trace_events
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

fn native_agent_push_phase_transition(
    trace_events: &mut Vec<serde_json::Value>,
    appender: &mut AgentRuntimeEventAppender,
    current_phase: &mut AgentRuntimePhase,
    next_phase: AgentRuntimePhase,
    timestamp: &str,
    trigger_event_name: &str,
) {
    if next_phase == *current_phase {
        return;
    }
    trace_events.push(native_agent_persisted_runtime_event(appender.append(
        AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.phase.changed".to_string(),
            phase: next_phase.clone(),
            timestamp: timestamp.to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::Debug,
            payload: serde_json::json!({
                "previousPhase": current_phase.clone(),
                "nextPhase": next_phase.clone(),
                "triggerEventName": trigger_event_name,
            }),
        },
    )));
    *current_phase = next_phase;
}
