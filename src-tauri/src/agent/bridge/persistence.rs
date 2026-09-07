use crate::agent::bridge::{
    native_agent_current_user_message, native_agent_max_iterations, native_agent_model,
    native_agent_provider, native_agent_session_id, native_agent_thread_id, native_agent_turn_id,
};
use crate::agent::runtime::{agent_trace_context_from_value, manual_context_compaction_requested};
use crate::agent::runtime::{
    AgentExecutionStatus, AgentResultError, AgentStopReason, AgentTurnResult,
};
use crate::agent::runtime_protocol::AgentTraceContext;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
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
    config_snapshot: serde_json::Value,
) -> Result<Option<AgentTurnResult>, String> {
    let Some(session_id) = native_agent_rollout_id(spec) else {
        return Ok(None);
    };
    let Some(turn_id) = native_agent_turn_id(spec) else {
        return Ok(None);
    };
    let trace_context = agent_trace_context_from_value(spec);
    let existing = call_traced_state_service(
        thread_store,
        config_snapshot,
        &trace_context,
        "terminal-check",
        WorkerRequest::new(
            format!("{}:terminal-check", trace_context.request_id),
            trace_context.trace_id.clone(),
            "thread.turn.list",
            serde_json::json!({ "threadId": session_id }),
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
    if !matches!(status, "completed" | "failed" | "cancelled" | "interrupted") {
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
) -> Result<(), String> {
    let session_id =
        native_agent_rollout_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
    let turn_id = native_agent_turn_id(&spec).unwrap_or_else(|| "native-rust-turn".to_string());
    let record = native_agent_turn_start_record(&spec, &config_snapshot, &session_id, &turn_id);
    let turn_context = native_agent_turn_context(&spec, &config_snapshot, &turn_id);
    let messages = materialized_turn_messages(&spec, &turn_id);
    let trace_context = agent_trace_context_from_value(&spec);
    call_traced_state_service(
        thread_store,
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
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let session_id = &result.session_id;
    let turn_id = &result.turn_id;
    let stop_reason = result.stop_reason;
    let (method, params) = match stop_reason.status() {
        AgentExecutionStatus::Completed => (
            "thread.turn.mark_completed",
            serde_json::json!({
                "threadId": session_id,
                "turnId": turn_id,
                "stopReason": stop_reason,
                "finalContent": result.final_content,
                "contextCheckpoint": result.context_checkpoint,
            }),
        ),
        AgentExecutionStatus::Failed => (
            "thread.turn.mark_failed",
            serde_json::json!({
                "threadId": session_id,
                "turnId": turn_id,
                "stopReason": stop_reason,
                "error": result.error.as_ref().ok_or_else(|| format!(
                    "failed agent turn `{turn_id}` is missing its error ({})", stop_reason.as_str()
                ))?,
                "contextCheckpoint": result.context_checkpoint,
            }),
        ),
        AgentExecutionStatus::Cancelled => (
            "thread.turn.mark_cancelled",
            serde_json::json!({ "threadId": session_id, "turnId": turn_id }),
        ),
        AgentExecutionStatus::Interrupted => (
            "thread.turn.mark_interrupted",
            serde_json::json!({
                "threadId": session_id,
                "turnId": turn_id,
                "reason": result.error.as_ref().map(AgentResultError::message).unwrap_or(stop_reason.as_str()),
            }),
        ),
        AgentExecutionStatus::Waiting => return Ok(()),
    };
    let trace_context = result
        .trace_context
        .clone()
        .unwrap_or_else(|| agent_trace_context_from_value(&spec));
    let persisted = call_traced_state_service(
        thread_store,
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
    result.turn_persistence = Some(persisted);
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
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
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
    call_traced_state_service(
        thread_store,
        config_snapshot,
        trace_context,
        "checkpoint-write",
        WorkerRequest::new(
            format!("{}:checkpoint-write", trace_context.request_id),
            trace_context.trace_id.clone(),
            "thread.turn.set_checkpoint",
            serde_json::json!({
                "threadId": session_id,
                "turnId": turn_id,
                "checkpoint": checkpoint,
            }),
        ),
        "native agent checkpoint persistence",
        "write",
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn call_traced_state_service(
    thread_store: &WorkspaceThreadStore,
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
    let result = call_rust_state_service(thread_store, config_snapshot, request, label);
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
