use crate::agent::bridge::{native_agent_model, native_agent_provider};
use crate::agent::runtime::AgentError;
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
    input: &crate::agent::runtime::AgentTurnInput,
    thread_store: &WorkspaceThreadStore,
) -> Result<Option<AgentTurnResult>, AgentError> {
    let session_id = input
        .trace_context
        .thread_id
        .as_deref()
        .unwrap_or(&input.session_id);
    let turn_id = &input.trace_context.turn_id;
    let trace_context = &input.trace_context;
    let existing = traced_persistence(&trace_context, "terminal-check", "read", || {
        thread_store.agent_turn(&session_id, &turn_id)
    })?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    use crate::threads::turn::AgentTurnStatus;
    match existing.status {
        AgentTurnStatus::Completed => {}
        AgentTurnStatus::Failed => {}
        AgentTurnStatus::Cancelled => {}
        AgentTurnStatus::Interrupted => {}
        AgentTurnStatus::Running | AgentTurnStatus::Waiting => return Ok(None),
    };
    let phase = existing.phase.as_str();
    Ok(Some(terminal_turn_rejection(
        &turn_id,
        &session_id,
        existing.status,
        phase,
    )))
}

fn terminal_turn_rejection(
    turn_id: &str,
    session_id: &str,
    status: crate::threads::turn::AgentTurnStatus,
    phase: &str,
) -> AgentTurnResult {
    let message = format!("agent turn `{turn_id}` is terminal ({status:?}) and cannot continue");
    AgentTurnResult {
        completed_tool_results: Some(Vec::new()),
        error: Some(AgentResultError::Message(message)),
        terminal_turn: Some(crate::agent::runtime::TerminalAgentTurn {
            status,
            phase: phase.into(),
        }),
        ..AgentTurnResult::new(turn_id, session_id, AgentStopReason::TerminalTurn)
    }
}

pub(crate) fn persist_native_agent_turn_start(
    request: &super::turn_request::AgentTurnRequest,
    instructions: &crate::agent::runtime::ComposedInstructions,
    thread_store: &WorkspaceThreadStore,
) -> Result<(), AgentError> {
    let input = &request.input;
    let session_id = input
        .trace_context
        .thread_id
        .as_deref()
        .unwrap_or(&input.session_id);
    let mut record =
        native_agent_turn_start_record(input, session_id, &input.trace_context.turn_id);
    record.instruction_provenance =
        Some(serde_json::to_value(instructions.provenance()).map_err(|error| error.to_string())?);
    record.instruction_diagnostics = instructions
        .diagnostics()
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    let mut context = request.context.clone();
    context.cwd = instructions.working_directory.display().to_string();
    context.workspace_roots = Some(vec![context.cwd.clone()]);
    let messages = materialized_turn_messages(
        request,
        instructions.rendered_prompt(),
        &instructions.content_hash,
    )?;
    traced_persistence(
        &input.trace_context,
        "native agent turn start persistence",
        "write",
        || thread_store.start_agent_turn(record, Some(context), messages),
    )?;
    Ok(())
}

fn materialized_turn_messages(
    request: &super::turn_request::AgentTurnRequest,
    prompt: &str,
    content_hash: &str,
) -> Result<Vec<crate::threads::rollout::format::ResponseItem>, AgentError> {
    let mut messages = Vec::new();
    if request.input.controls.manual_compaction {
        return Ok(messages);
    }
    if !prompt.is_empty() {
        messages.push(crate::threads::rollout::format::ResponseItem::from_value(
            serde_json::json!({
                "type":"message", "id":format!("system:{content_hash}"), "role":"system",
                "content":[{"type":"input_text", "text":prompt}], "contentHash":content_hash
            }),
        )?);
    }
    messages.extend(request.user_message.clone());
    Ok(messages)
}

pub(super) fn native_agent_turn_context(
    spec: &serde_json::Value,
    config: &serde_json::Value,
    turn_id: &str,
) -> Result<crate::threads::rollout::format::TurnContextItem, AgentError> {
    use crate::threads::rollout::format::TurnContextItem;
    use serde_json::Value;
    fn decode<T: serde::de::DeserializeOwned>(
        value: Option<&Value>,
        name: &str,
    ) -> Result<Option<T>, AgentError> {
        value
            .filter(|v| !v.is_null())
            .map(|v| {
                serde_json::from_value(v.clone()).map_err(|e| {
                    AgentError::invalid_input(format!("invalid turn context field `{name}`: {e}"))
                })
            })
            .transpose()
    }
    let defaults = config.pointer("/agents/defaults").unwrap_or(&Value::Null);
    let reasoning = spec.get("reasoning").unwrap_or(&Value::Null);
    let provider = native_agent_provider(spec, config);
    let api = spec
        .get("apiMode")
        .or_else(|| spec.get("api_mode"))
        .cloned()
        .or_else(|| {
            crate::agent::provider::resolve_provider_profile(config, provider.as_deref(), None)
                .map(|p| Value::String(p.api_mode))
        });
    let cwd: String = decode(
        spec.pointer("/instructionProvenance/workingDirectory")
            .or_else(|| spec.get("workingDirectory"))
            .or_else(|| spec.get("working_directory"))
            .or_else(|| spec.get("cwd")),
        "cwd",
    )?
    .unwrap_or_default();
    Ok(TurnContextItem {
        turn_id: turn_id.into(),
        workspace_roots: (!cwd.is_empty()).then(|| vec![cwd.clone()]),
        cwd,
        current_date: decode(spec.get("currentDate"), "currentDate")?,
        timezone: decode(spec.get("timezone"), "timezone")?,
        sandbox_policy: spec
            .get("sandboxPolicy")
            .or_else(|| defaults.get("sandboxPolicy"))
            .cloned()
            .unwrap_or_else(|| Value::String("workspace_write".into())),
        permission_profile: decode(
            spec.get("permissionProfile")
                .or_else(|| defaults.get("permissionProfile")),
            "permissionProfile",
        )?,
        network: decode(spec.get("network"), "network")?,
        model: native_agent_model(spec, config),
        provider,
        api_mode: Some(decode(api.as_ref(), "apiMode")?.unwrap_or_default()),
        comp_hash: decode(
            spec.get("compHash").or_else(|| spec.get("comp_hash")),
            "compHash",
        )?,
        personality: decode(
            spec.get("personality")
                .or_else(|| defaults.get("personality")),
            "personality",
        )?,
        collaboration_mode: decode(
            spec.get("collaborationMode")
                .or_else(|| defaults.get("collaborationMode")),
            "collaborationMode",
        )?,
        effort: decode(
            spec.get("reasoningEffort")
                .or_else(|| spec.get("reasoning_effort"))
                .or_else(|| reasoning.get("effort")),
            "effort",
        )?,
        summary: spec
            .get("reasoningSummary")
            .or_else(|| spec.get("reasoning_summary"))
            .or_else(|| reasoning.get("summary"))
            .cloned()
            .unwrap_or_else(|| Value::String("auto".into())),
    })
}

pub(crate) fn persist_native_agent_turn_terminal_if_present(
    trace: &AgentTraceContext,
    result: &mut AgentTurnResult,
    thread_store: &WorkspaceThreadStore,
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
        .unwrap_or_else(|| trace.clone());
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
    result.turn_persistence = Some(persisted);
    Ok(())
}

pub(crate) fn native_agent_turn_start_record(
    input: &crate::agent::runtime::AgentTurnInput,
    session_id: &str,
    turn_id: &str,
) -> crate::threads::turn::AgentTurnRecord {
    use crate::threads::turn::{AgentTurnRecord, AgentTurnStatus};
    let timestamp = now_unix_ms().to_string();
    AgentTurnRecord {
        session_id: session_id.into(),
        turn_id: turn_id.into(),
        thread_id: None,
        parent_thread_id: None,
        child_thread_ids: Vec::new(),
        status: AgentTurnStatus::Running,
        phase: "planning".into(),
        started_at: timestamp.clone(),
        updated_at: timestamp,
        completed_at: None,
        stop_reason: None,
        model: input.settings.model.clone(),
        provider: input.settings.provider.clone(),
        max_iterations: input.settings.max_iterations,
        current_iteration: 0,
        conversation_message_ids: Vec::new(),
        trace_messages: Vec::new(),
        completed_tool_results: Vec::new(),
        pending_tool_calls: Vec::new(),
        checkpoint: None,
        artifacts: Vec::new(),
        usage: Vec::new(),
        token_usage_info: None,
        instruction_provenance: None,
        instruction_diagnostics: Vec::new(),
        trace_context: Some(input.trace_context.clone()),
        error: None,
    }
}

pub(crate) fn persist_native_agent_checkpoint_if_present(
    result: &AgentTurnResult,
    thread_store: &WorkspaceThreadStore,
) -> Result<(), AgentError> {
    let Some(checkpoint) = result.checkpoint.as_ref() else {
        return Ok(());
    };
    let session_id = &result.session_id;
    let turn_id = &checkpoint.turn_id;
    let trace_context = result
        .trace_context
        .as_ref()
        .ok_or_else(|| "agent checkpoint result is missing trace context".to_string())?;
    traced_persistence(trace_context, "checkpoint-write", "write", || {
        thread_store.set_agent_turn_checkpoint(
            session_id,
            turn_id,
            serde_json::to_value(checkpoint).expect("checkpoint contains serializable fields"),
        )
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
