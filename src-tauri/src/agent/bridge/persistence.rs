use crate::agent::bridge::{
    native_agent_current_user_message, native_agent_max_iterations, native_agent_model,
    native_agent_provider, native_agent_session_id, native_agent_thread_id, native_agent_turn_id,
};
use crate::agent::runtime::AgentError;
use crate::agent::runtime::{agent_trace_context_from_value, manual_context_compaction_requested};
use crate::agent::runtime::{
    AgentExecutionStatus, AgentResultError, AgentStopReason, AgentTurnResult,
};
use crate::agent::runtime_protocol::AgentTraceContext;
use crate::protocol::WorkerProtocolError;
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::time::Instant;

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

pub(crate) fn reject_native_agent_terminal_turn_reentry(
    spec: &serde_json::Value,
    thread_store: &WorkspaceThreadStore,
    _config_snapshot: serde_json::Value,
) -> Result<Option<AgentTurnResult>, AgentError> {
    let Some(session_id) = native_agent_rollout_id(spec) else {
        return Ok(None);
    };
    let Some(turn_id) = native_agent_turn_id(spec) else {
        return Ok(None);
    };
    let trace_context = agent_trace_context_from_value(spec);
    let existing = traced_persistence(&trace_context, "terminal-check", "read", || {
        thread_store.agent_turn(&session_id, &turn_id)
    })?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    use crate::threads::turn::AgentTurnStatus;
    let status = match existing.status {
        AgentTurnStatus::Completed => "completed",
        AgentTurnStatus::Failed => "failed",
        AgentTurnStatus::Cancelled => "cancelled",
        AgentTurnStatus::Interrupted => "interrupted",
        AgentTurnStatus::Running | AgentTurnStatus::Waiting => return Ok(None),
    };
    let phase = existing.phase.as_str();
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
) -> AgentTurnResult {
    let message = format!("agent turn `{turn_id}` is terminal ({status}) and cannot continue");
    AgentTurnResult {
        completed_tool_results: Some(Vec::new()),
        error: Some(AgentResultError::Message(message)),
        terminal_turn: Some(serde_json::json!({ "status": status, "phase": phase })),
        ..AgentTurnResult::new(turn_id, session_id, AgentStopReason::TerminalTurn)
    }
}

pub(crate) fn persist_native_agent_turn_start(
    spec: serde_json::Value,
    thread_store: &WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
) -> Result<(), AgentError> {
    let session_id =
        native_agent_rollout_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
    let turn_id = native_agent_turn_id(&spec).unwrap_or_else(|| "native-rust-turn".to_string());
    let record = native_agent_turn_start_record(&spec, &config_snapshot, &session_id, &turn_id);
    let turn_context = native_agent_turn_context(&spec, &config_snapshot, &turn_id);
    let messages = materialized_turn_messages(&spec, &turn_id);
    let trace_context = agent_trace_context_from_value(&spec);
    let record =
        serde_json::from_value(record).map_err(|error| format!("invalid turn record: {error}"))?;
    let context = serde_json::from_value(turn_context)
        .map_err(|error| format!("invalid turn context: {error}"))?;
    let messages = messages
        .into_iter()
        .map(|message| {
            serde_json::from_value(message)
                .map_err(|error| format!("invalid turn message: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    traced_persistence(
        &trace_context,
        "native agent turn start persistence",
        "write",
        || thread_store.start_agent_turn(record, Some(context), messages),
    )?;
    Ok(())
}

fn materialized_turn_messages(spec: &serde_json::Value, turn_id: &str) -> Vec<serde_json::Value> {
    if manual_context_compaction_requested(spec) {
        return Vec::new();
    }
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
    let reasoning = spec.get("reasoning").and_then(serde_json::Value::as_object);
    let api_mode = spec
        .get("apiMode")
        .or_else(|| spec.get("api_mode"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            crate::agent::provider::resolve_provider_profile(
                config_snapshot,
                native_agent_provider(spec, config_snapshot).as_deref(),
                None,
            )
            .map(|profile| profile.api_mode)
        })
        .unwrap_or_else(|| "chat_completions".to_string());
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
        "api_mode": api_mode,
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
            .or_else(|| spec.get("reasoning_effort"))
            .or_else(|| reasoning.and_then(|value| value.get("effort")))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "summary": spec
            .get("reasoningSummary")
            .or_else(|| spec.get("reasoning_summary"))
            .or_else(|| reasoning.and_then(|value| value.get("summary")))
            .cloned()
            .unwrap_or_else(|| serde_json::json!("auto")),
    })
}

pub(crate) fn persist_native_agent_turn_terminal_if_present(
    spec: serde_json::Value,
    result: &mut AgentTurnResult,
    thread_store: &WorkspaceThreadStore,
    _config_snapshot: serde_json::Value,
) -> Result<(), AgentError> {
    let session_id = &result.session_id;
    let turn_id = &result.turn_id;
    let stop_reason = result.stop_reason;
    if stop_reason.status() == AgentExecutionStatus::Waiting {
        return Ok(());
    }
    let trace_context = result
        .trace_context
        .clone()
        .unwrap_or_else(|| agent_trace_context_from_value(&spec));
    let error_value = result
        .error
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| error.to_string())?;
    if stop_reason.status() == AgentExecutionStatus::Failed && error_value.is_none() {
        return Err(format!(
            "failed agent turn `{turn_id}` is missing its error ({})",
            stop_reason.as_str()
        )
        .into());
    }
    let persisted = traced_persistence(
        &trace_context,
        "turn-record",
        "write",
        || match stop_reason.status() {
            AgentExecutionStatus::Completed => thread_store.complete_agent_turn(
                session_id,
                turn_id,
                stop_reason.as_str(),
                Some(result.final_content.clone()),
                result.context_checkpoint.clone(),
            ),
            AgentExecutionStatus::Failed => thread_store.fail_agent_turn(
                session_id,
                turn_id,
                stop_reason.as_str(),
                error_value.expect("failed result error was checked"),
                result.context_checkpoint.clone(),
            ),
            AgentExecutionStatus::Cancelled => thread_store.cancel_agent_turn(session_id, turn_id),
            AgentExecutionStatus::Interrupted => thread_store.interrupt_agent_turn(
                session_id,
                turn_id,
                result
                    .error
                    .as_ref()
                    .map(AgentResultError::message)
                    .unwrap_or(stop_reason.as_str()),
            ),
            AgentExecutionStatus::Waiting => {
                unreachable!("waiting results do not persist terminal state")
            }
        },
    )?;
    result.turn_persistence =
        Some(serde_json::to_value(persisted).map_err(|error| error.to_string())?);
    Ok(())
}

pub(crate) fn native_agent_turn_start_record(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
    session_id: &str,
    turn_id: &str,
) -> serde_json::Value {
    let timestamp = now_unix_ms().to_string();
    serde_json::json!({
        "sessionId": session_id,
        "turnId": turn_id,
        "status": "running",
        "phase": "planning",
        "startedAt": timestamp,
        "updatedAt": timestamp,
        "completedAt": null,
        "stopReason": null,
        "model": native_agent_model(spec, config_snapshot),
        "provider": native_agent_provider(spec, config_snapshot),
        "maxIterations": native_agent_max_iterations(spec, config_snapshot),
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "tokenUsageInfo": null,
        "instructionProvenance": spec.get("instructionProvenance"),
        "instructionDiagnostics": spec.get("instructionDiagnostics")
            .and_then(serde_json::Value::as_array).cloned().unwrap_or_default(),
        "traceContext": agent_trace_context_from_value(spec),
        "error": null,
    })
}

pub(crate) fn persist_native_agent_checkpoint_if_present(
    result: &AgentTurnResult,
    thread_store: &WorkspaceThreadStore,
    _config_snapshot: serde_json::Value,
) -> Result<(), AgentError> {
    let Some(checkpoint) = result.checkpoint.as_ref() else {
        return Ok(());
    };
    let session_id = &result.session_id;
    let turn_id = checkpoint
        .get("turnId")
        .or_else(|| checkpoint.get("turn_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Rust agent checkpoint missing turn id".to_string())?;
    let trace_context = result
        .trace_context
        .as_ref()
        .ok_or_else(|| "agent checkpoint result is missing trace context".to_string())?;
    traced_persistence(trace_context, "checkpoint-write", "write", || {
        thread_store.set_agent_turn_checkpoint(session_id, turn_id, checkpoint.clone())
    })?;
    Ok(())
}

fn traced_persistence<T>(
    trace_context: &AgentTraceContext,
    operation: &str,
    metric_kind: &str,
    action: impl FnOnce() -> Result<T, WorkerProtocolError>,
) -> Result<T, AgentError> {
    let metrics = crate::runtime::observability::global_agent_runtime_metrics();
    metrics.increment(&format!("persistence.{metric_kind}.started"));
    let started_at = Instant::now();
    let result = action();
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
    result.map_err(|error| {
        eprintln!("agent_persistence_failed operation={} request_id={} trace_id={} turn_id={} error={} details={}", operation, trace_context.request_id, trace_context.trace_id, trace_context.turn_id, error.message, error.details);
        AgentError::persistence(operation, error)
    })
}

#[cfg(test)]
#[path = "persistence_tests.rs"]
mod tests;
