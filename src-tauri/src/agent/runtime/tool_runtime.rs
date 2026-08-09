use super::checkpoint::save_phase_checkpoint;
use super::result::cancelled_turn_result;
use super::state::AgentTurnState;
use super::tool_dispatcher::{
    native_tool_call_supports_parallel, native_tool_cancellation_mode,
    native_tool_cleanup_timeout_ms, native_tool_is_permitted, native_tool_mutates_session,
    native_tool_mutates_workspace, native_tool_rejection_reason,
    native_tool_waits_for_runtime_cancellation,
};
use super::tool_loop_guard::ToolLoopBlock;
use super::tool_projection::{assistant_tool_calls_message, commit_tool_observation};
use super::{
    AgentTurnContext, NativeAgentRuntimeServices, NativeAgentToolCall, NativeAgentToolDispatcher,
    NativeToolOutcome, NativeToolRetry, PreparedToolCall,
};
use crate::agent::runtime_protocol::{
    AgentEventKind, AgentRuntimePhase, PendingAgentEvent, TerminalEvent, ToolLifecycleEvent,
};
use crate::tools::registry::ToolCancellationMode;
use crate::tools::registry::{REQUEST_USER_INPUT_METHOD, TOOL_SEARCH_METHOD, UPDATE_PLAN_METHOD};
use futures_util::{future::join_all, FutureExt};
use serde::Deserialize;
use serde_json::Value;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) enum NativeAgentToolExecutionOutcome {
    Continue,
    Finished(Value),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdatePlanArgs {
    #[serde(default)]
    explanation: Option<String>,
    plan: Vec<super::AgentPlanStep>,
}

struct ToolDispatchCompleted {
    tool_call: PreparedToolCall,
    result: super::NativeAgentToolResult,
}

enum ToolDispatchOutcome {
    Completed(ToolDispatchCompleted),
    RuntimeFailure {
        tool_call: PreparedToolCall,
        error: String,
    },
    Cancelled {
        tool_call: PreparedToolCall,
    },
    CleanupTimedOut {
        tool_call: PreparedToolCall,
        cancellation_mode: ToolCancellationMode,
        timeout_ms: u64,
    },
}

fn completed_tool_error(tool_call: PreparedToolCall, error: String) -> ToolDispatchOutcome {
    let result = super::NativeAgentToolResult::generic_error(&tool_call, error);
    ToolDispatchOutcome::Completed(ToolDispatchCompleted { tool_call, result })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolExecutionMode {
    Parallel,
    Exclusive,
}

impl ToolExecutionMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Parallel => "read",
            Self::Exclusive => "write",
        }
    }
}

struct PlannedToolCall {
    index: usize,
    tool_call: PreparedToolCall,
    mode: ToolExecutionMode,
}

enum ToolWave {
    Parallel(Vec<PlannedToolCall>),
    Exclusive(PlannedToolCall),
}

impl ToolWave {
    fn calls(&self) -> &[PlannedToolCall] {
        match self {
            Self::Parallel(calls) => calls,
            Self::Exclusive(call) => std::slice::from_ref(call),
        }
    }
}

struct IndexedToolDispatchOutcome {
    index: usize,
    outcome: ToolDispatchOutcome,
}

struct ToolWaveDecision {
    completed: Vec<ToolDispatchCompleted>,
    terminal: Option<IndexedToolDispatchOutcome>,
    ignored: Vec<IndexedToolDispatchOutcome>,
}

fn plan_tool_waves(calls: Vec<PlannedToolCall>) -> Vec<ToolWave> {
    let mut waves = Vec::new();
    let mut parallel_calls = Vec::new();
    for call in calls {
        match call.mode {
            ToolExecutionMode::Parallel => parallel_calls.push(call),
            ToolExecutionMode::Exclusive => {
                if !parallel_calls.is_empty() {
                    waves.push(ToolWave::Parallel(std::mem::take(&mut parallel_calls)));
                }
                waves.push(ToolWave::Exclusive(call));
            }
        }
    }
    if !parallel_calls.is_empty() {
        waves.push(ToolWave::Parallel(parallel_calls));
    }
    waves
}

fn terminal_priority(outcome: &ToolDispatchOutcome) -> Option<u8> {
    match outcome {
        ToolDispatchOutcome::CleanupTimedOut { .. } => Some(0),
        ToolDispatchOutcome::RuntimeFailure { .. } => Some(1),
        ToolDispatchOutcome::Cancelled { .. } => Some(2),
        ToolDispatchOutcome::Completed(_) => None,
    }
}

fn reduce_wave_outcomes(mut outcomes: Vec<IndexedToolDispatchOutcome>) -> ToolWaveDecision {
    outcomes.sort_by_key(|outcome| outcome.index);
    let completed_prefix_len = outcomes
        .iter()
        .take_while(|outcome| matches!(outcome.outcome, ToolDispatchOutcome::Completed(_)))
        .count();
    let terminal_position = outcomes
        .iter()
        .enumerate()
        .filter_map(|(position, outcome)| {
            terminal_priority(&outcome.outcome).map(|priority| (position, priority, outcome.index))
        })
        .min_by_key(|(_, priority, index)| (*priority, *index))
        .map(|(position, _, _)| position);
    let terminal = terminal_position.map(|position| outcomes.remove(position));
    let completed = outcomes
        .drain(..completed_prefix_len)
        .map(|outcome| match outcome.outcome {
            ToolDispatchOutcome::Completed(completed) => completed,
            _ => unreachable!("completed prefix must only contain completed tool outcomes"),
        })
        .collect();
    ToolWaveDecision {
        completed,
        terminal,
        ignored: outcomes,
    }
}

#[cfg(test)]
#[path = "tool_runtime_wave_tests.rs"]
mod wave_tests;

pub(super) async fn execute_tool_calls_for_iteration(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    final_content: String,
    tool_calls: Vec<NativeAgentToolCall>,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    state.transition_phase(
        AgentRuntimePhase::ToolCalling,
        iteration,
        AgentEventKind::ToolCallDelta.wire_name(),
    )?;
    state
        .history
        .record_message(assistant_tool_calls_message(&final_content, &tool_calls))
        .expect("runtime-generated assistant tool call message must be valid");

    for tool_call in &tool_calls {
        state.emit(ToolLifecycleEvent::Delta(serde_json::json!({
            "iteration": iteration,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "argumentsDelta": tool_call.arguments_json,
        })))?;
        if !native_tool_is_permitted(context, &tool_call.name) {
            return policy_denied_tool_result(services, context, state, iteration, tool_call);
        }
    }

    if context_is_cancelled(context) {
        return cancelled_result(services, context, state, iteration);
    }

    let tool_calls = tool_calls
        .into_iter()
        .map(PreparedToolCall::prepare)
        .collect::<Result<Vec<_>, _>>()?;

    if tool_calls
        .iter()
        .any(|tool_call| tool_call.name == TOOL_SEARCH_METHOD)
    {
        if tool_calls.len() != 1 {
            let tool_call = tool_calls
                .iter()
                .find(|tool_call| tool_call.name == TOOL_SEARCH_METHOD)
                .expect("tool_search presence was checked");
            return tool_error_result(
                services,
                context,
                state,
                iteration,
                tool_call,
                "tool_search must be the only tool call in its provider response".to_string(),
            );
        }
        let tool_call = tool_calls
            .into_iter()
            .next()
            .expect("single tool_search call should exist");
        return execute_tool_search(services, context, state, iteration, tool_call);
    }

    if tool_calls
        .iter()
        .any(|tool_call| tool_call.name == UPDATE_PLAN_METHOD)
    {
        if tool_calls.len() != 1 {
            let tool_call = tool_calls
                .iter()
                .find(|tool_call| tool_call.name == UPDATE_PLAN_METHOD)
                .expect("update_plan presence was checked");
            return tool_error_result(
                services,
                context,
                state,
                iteration,
                tool_call,
                "update_plan must be the only tool call in its provider response".to_string(),
            );
        }
        let tool_call = tool_calls
            .into_iter()
            .next()
            .expect("single update_plan call should exist");
        return execute_update_plan(services, context, state, iteration, tool_call);
    }

    if tool_calls
        .iter()
        .any(|tool_call| tool_call.name == REQUEST_USER_INPUT_METHOD)
    {
        if tool_calls.len() != 1 {
            let tool_call = tool_calls
                .iter()
                .find(|tool_call| tool_call.name == REQUEST_USER_INPUT_METHOD)
                .expect("request_user_input presence was checked");
            return tool_error_result(
                services,
                context,
                state,
                iteration,
                tool_call,
                "request_user_input must be the only tool call in its provider response"
                    .to_string(),
            );
        }
        let tool_call = tool_calls
            .into_iter()
            .next()
            .expect("single request_user_input call should exist");
        return match super::user_input::awaiting_user_input_result(
            services,
            context,
            state,
            iteration,
            tool_call.clone(),
        ) {
            Ok(result) => Ok(NativeAgentToolExecutionOutcome::Finished(result)),
            Err(error) => tool_error_result(services, context, state, iteration, &tool_call, error),
        };
    }

    execute_tool_batch(services, context, state, iteration, tool_calls).await
}

fn execute_tool_search(
    services: &NativeAgentRuntimeServices,
    context: &mut AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: PreparedToolCall,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    start_tool_call(services, context, state, iteration, &tool_call)?;
    context.metrics().increment("tool.started");
    let tool_started_at = std::time::Instant::now();
    let raw_result = match context
        .tool_router
        .search_and_activate(tool_call.arguments())
    {
        Ok(result) => result,
        Err(error) => {
            context
                .metrics()
                .record_duration("tool.durationMs", tool_started_at.elapsed());
            context.metrics().increment("tool.failed");
            return tool_error_result(services, &*context, state, iteration, &tool_call, error);
        }
    };
    context
        .metrics()
        .record_duration("tool.durationMs", tool_started_at.elapsed());
    context.metrics().increment("tool.completed");
    let result = super::NativeAgentToolResult::generic_success(&tool_call, raw_result);
    commit_tool_observation(
        &*context,
        state,
        iteration,
        tool_call.into_original(),
        result,
    )?;
    state.clear_pending_tool_calls();
    state.transition_phase(
        AgentRuntimePhase::Planning,
        iteration,
        AgentEventKind::ToolResult.wire_name(),
    )?;
    save_phase_checkpoint(
        services,
        &*context,
        state.phase.as_str(),
        serde_json::json!({
            "iteration": iteration,
            "pendingToolCalls": state.pending_tool_calls.clone(),
            "completedToolResults": state.completed_tool_results.clone(),
            "activatedToolIds": context.tool_router.activated_tool_ids(),
        }),
    );
    Ok(NativeAgentToolExecutionOutcome::Continue)
}

fn execute_update_plan(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: PreparedToolCall,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    context.metrics().increment("tool.started");
    let tool_started_at = std::time::Instant::now();
    let mut plan = match parse_update_plan_args(tool_call.arguments()) {
        Ok(plan) => plan,
        Err(error) => {
            context
                .metrics()
                .record_duration("tool.durationMs", tool_started_at.elapsed());
            context.metrics().increment("tool.failed");
            return recoverable_update_plan_error(
                services, context, state, iteration, tool_call, error,
            );
        }
    };
    let derived = super::validate_and_normalize_plan_steps(&mut plan.plan)
        .expect("update_plan arguments were validated before execution");
    let completed = derived.completed;
    let total = derived.total;
    let current_step = derived.current_step;
    let summary = plan
        .explanation
        .clone()
        .or_else(|| current_step.clone())
        .unwrap_or_else(|| "Plan completed".to_string());
    let plan_id = format!("{}:plan", context.turn_id);

    state.tools_used.push(tool_call.name.clone());
    state.transition_phase(
        AgentRuntimePhase::ToolRunning,
        iteration,
        AgentEventKind::PlanProgress.wire_name(),
    )?;
    state.emit(PendingAgentEvent::new(
        AgentEventKind::PlanProgress,
        serde_json::json!({
            "iteration": iteration,
            "planId": plan_id,
            "explanation": plan.explanation,
            "steps": plan.plan,
            "summary": summary,
            "completed": completed,
            "total": total,
            "currentStep": current_step,
        }),
    ))?;

    let result = super::NativeAgentToolResult::generic_success(
        &tool_call,
        Value::String("Plan updated".to_string()),
    );
    context
        .metrics()
        .record_duration("tool.durationMs", tool_started_at.elapsed());
    context.metrics().increment("tool.completed");

    commit_tool_observation(context, state, iteration, tool_call.into_original(), result)?;
    state.clear_pending_tool_calls();
    state.transition_phase(
        AgentRuntimePhase::Planning,
        iteration,
        AgentEventKind::ToolResult.wire_name(),
    )?;
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("plan_updated"),
    );
    Ok(NativeAgentToolExecutionOutcome::Continue)
}

fn recoverable_update_plan_error(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: PreparedToolCall,
    error: String,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    state.tools_used.push(tool_call.name.clone());
    let result = super::NativeAgentToolResult::generic_error(&tool_call, error);
    commit_tool_observation(context, state, iteration, tool_call.into_original(), result)?;
    state.clear_pending_tool_calls();
    state.transition_phase(
        AgentRuntimePhase::Planning,
        iteration,
        AgentEventKind::ToolResult.wire_name(),
    )?;
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("plan_rejected"),
    );
    Ok(NativeAgentToolExecutionOutcome::Continue)
}

fn parse_update_plan_args(
    arguments: &serde_json::Map<String, Value>,
) -> Result<UpdatePlanArgs, String> {
    let mut args = serde_json::from_value::<UpdatePlanArgs>(Value::Object(arguments.clone()))
        .map_err(|error| format!("invalid update_plan arguments: {error}"))?;
    if let Some(explanation) = args.explanation.as_mut() {
        *explanation = explanation.trim().to_string();
        if explanation.is_empty() {
            return Err("invalid update_plan arguments: explanation must not be empty".to_string());
        }
        if explanation.chars().count() > 1024 {
            return Err(
                "invalid update_plan arguments: explanation must not exceed 1024 characters"
                    .to_string(),
            );
        }
    }

    super::validate_and_normalize_plan_steps(&mut args.plan)
        .map_err(|error| format!("invalid update_plan arguments: {error}"))?;
    Ok(args)
}

async fn dispatch_owned_tool(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: AgentTurnContext,
    tool_call: PreparedToolCall,
) -> ToolDispatchOutcome {
    let child_cancellation = CancellationToken::new();
    let child_context = context.with_child_cancellation(child_cancellation.clone());
    let panic_tool_call = tool_call.clone();
    let task_tool_call = tool_call.clone();
    let task = async move {
        dispatch_tool_with_cancellation_policy(dispatcher, child_context, task_tool_call).await
    };
    let mut handle = tauri::async_runtime::spawn(async move {
        match AssertUnwindSafe(task).catch_unwind().await {
            Ok(outcome) => outcome,
            Err(_) => ToolDispatchOutcome::RuntimeFailure {
                tool_call: panic_tool_call,
                error: "owned native tool task panicked".to_string(),
            },
        }
    });
    let joined = if let Some(parent_cancellation) = context.cancellation.clone() {
        tokio::select! {
            biased;
            _ = parent_cancellation.cancelled() => {
                child_cancellation.cancel();
                (&mut handle).await
            }
            result = &mut handle => result,
        }
    } else {
        handle.await
    };
    joined.unwrap_or_else(|error| ToolDispatchOutcome::RuntimeFailure {
        tool_call,
        error: format!("owned native tool task failed to join: {error}"),
    })
}

async fn dispatch_tool_with_cancellation_policy(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: AgentTurnContext,
    tool_call: PreparedToolCall,
) -> ToolDispatchOutcome {
    let cancellation_mode = native_tool_cancellation_mode(&context, &tool_call.name);
    let cleanup_timeout_ms = native_tool_cleanup_timeout_ms(&context, &tool_call.name).max(1);
    let dispatch_call = tool_call.clone();
    context.metrics().increment("tool.started");
    let tool_started_at = std::time::Instant::now();
    let operation = dispatcher.dispatch_async(context.clone(), dispatch_call);
    tokio::pin!(operation);
    let outcome = tokio::select! {
        biased;
        _ = wait_for_context_cancellation(&context) => {
            let cleanup = tokio::time::timeout(
                Duration::from_millis(cleanup_timeout_ms),
                &mut operation,
            )
            .await;
            match cleanup {
                Ok(Ok(result)) => ToolDispatchOutcome::Completed(ToolDispatchCompleted {
                    tool_call,
                    result,
                }),
                Err(_) if cancellation_mode != ToolCancellationMode::Cooperative => {
                    ToolDispatchOutcome::CleanupTimedOut {
                        tool_call,
                        cancellation_mode,
                        timeout_ms: cleanup_timeout_ms,
                    }
                }
                Ok(Err(_)) | Err(_) => ToolDispatchOutcome::Cancelled { tool_call },
            }
        }
        result = &mut operation => match result {
            Ok(result) => ToolDispatchOutcome::Completed(ToolDispatchCompleted {
                tool_call,
                result,
            }),
            Err(error) => completed_tool_error(tool_call, error),
        },
    };
    let tool_duration = tool_started_at.elapsed();
    context
        .metrics()
        .record_duration("tool.durationMs", tool_duration);
    let outcome_label = match &outcome {
        ToolDispatchOutcome::Completed(completed)
            if completed
                .result
                .envelope
                .get("status")
                .and_then(Value::as_str)
                == Some("error") =>
        {
            "failed"
        }
        ToolDispatchOutcome::Completed(_) => "completed",
        ToolDispatchOutcome::RuntimeFailure { .. } => "failed",
        ToolDispatchOutcome::Cancelled { .. } => "cancelled",
        ToolDispatchOutcome::CleanupTimedOut { .. } => "cleanup_timeout",
    };
    context
        .metrics()
        .increment(&format!("tool.{outcome_label}"));
    outcome
}

async fn execute_planned_tool_call(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: AgentTurnContext,
    planned: PlannedToolCall,
) -> IndexedToolDispatchOutcome {
    let index = planned.index;
    let outcome = dispatch_owned_tool(dispatcher, context, planned.tool_call).await;
    IndexedToolDispatchOutcome { index, outcome }
}

async fn execute_tool_wave(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    wave: ToolWave,
) -> Vec<IndexedToolDispatchOutcome> {
    match wave {
        ToolWave::Exclusive(call) => {
            vec![execute_planned_tool_call(services.tools.clone(), context.clone(), call).await]
        }
        ToolWave::Parallel(calls) => {
            join_all(calls.into_iter().map(|call| {
                execute_planned_tool_call(services.tools.clone(), context.clone(), call)
            }))
            .await
        }
    }
}

async fn execute_tool_batch(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_calls: Vec<PreparedToolCall>,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    let (tool_calls, blocked_calls) = partition_repeated_no_progress_calls(state, tool_calls);
    commit_loop_blocked_calls(context, state, iteration, blocked_calls)?;
    if tool_calls.is_empty() {
        state.clear_pending_tool_calls();
        state.transition_phase(
            AgentRuntimePhase::Planning,
            iteration,
            AgentEventKind::ToolResult.wire_name(),
        )?;
        save_phase_checkpoint(
            services,
            context,
            state.phase.as_str(),
            state.active_checkpoint_payload("tool_loop_blocked"),
        );
        return Ok(NativeAgentToolExecutionOutcome::Continue);
    }
    let is_multi_call = tool_calls.len() > 1;
    if !is_multi_call && context_is_cancelled(context) {
        return cancelled_result(services, context, state, iteration);
    }

    let planned_calls = tool_calls
        .into_iter()
        .enumerate()
        .map(|(index, tool_call)| PlannedToolCall {
            index,
            mode: if native_tool_call_supports_parallel(context, &tool_call) {
                ToolExecutionMode::Parallel
            } else {
                ToolExecutionMode::Exclusive
            },
            tool_call,
        })
        .collect::<Vec<_>>();

    if is_multi_call {
        queue_tool_batch(services, context, state, iteration, &planned_calls)?;
    } else if let Some(call) = planned_calls.first() {
        start_tool_call(services, context, state, iteration, &call.tool_call)?;
    }

    for (wave_index, wave) in plan_tool_waves(planned_calls).into_iter().enumerate() {
        if context_is_cancelled(context) {
            state.clear_pending_tool_calls();
            return cancelled_result(services, context, state, iteration);
        }
        if is_multi_call {
            mark_tool_wave_running(services, context, state, iteration, wave_index, &wave)?;
        }

        let decision = reduce_wave_outcomes(execute_tool_wave(services, context, wave).await);
        for completed in decision.completed {
            commit_tool_observation(
                context,
                state,
                iteration,
                completed.tool_call.into_original(),
                completed.result,
            )?;
        }

        if let Some(terminal) = decision.terminal {
            let terminal_reason = tool_dispatch_outcome_name(&terminal.outcome);
            emit_ignored_wave_outcomes(
                state,
                iteration,
                wave_index,
                terminal_reason,
                decision.ignored,
            )?;
            state.clear_pending_tool_calls();
            return finish_wave_terminal(services, context, state, iteration, terminal);
        }

        if context_is_cancelled(context) {
            state.clear_pending_tool_calls();
            return cancelled_result(services, context, state, iteration);
        }
    }

    state.clear_pending_tool_calls();
    state.transition_phase(
        AgentRuntimePhase::Planning,
        iteration,
        AgentEventKind::ToolResult.wire_name(),
    )?;
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("tool_completed"),
    );
    Ok(NativeAgentToolExecutionOutcome::Continue)
}

fn partition_repeated_no_progress_calls(
    state: &AgentTurnState,
    tool_calls: Vec<PreparedToolCall>,
) -> (
    Vec<PreparedToolCall>,
    Vec<(PreparedToolCall, ToolLoopBlock)>,
) {
    let mut allowed = Vec::new();
    let mut blocked = Vec::new();
    for tool_call in tool_calls {
        match state.tool_loop_guard.block_for(&tool_call) {
            Some(reason) => blocked.push((tool_call, reason)),
            None => allowed.push(tool_call),
        }
    }
    (allowed, blocked)
}

fn commit_loop_blocked_calls(
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    blocked_calls: Vec<(PreparedToolCall, ToolLoopBlock)>,
) -> Result<(), String> {
    if blocked_calls.is_empty() {
        return Ok(());
    }
    state.transition_phase(
        AgentRuntimePhase::ToolRunning,
        iteration,
        AgentEventKind::ToolStarted.wire_name(),
    )?;
    for (tool_call, blocked) in blocked_calls {
        state.emit(ToolLifecycleEvent::Started(serde_json::json!({
            "iteration": iteration,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "status": "blocked",
            "reasonCode": "repeated_no_progress",
        })))?;
        let reason = format!(
            "An equivalent `{}` call already returned `{}` (`{}`), and no relevant state-changing tool has completed since then.",
            tool_call.name, blocked.previous_effect, blocked.previous_reason_code
        );
        let raw = serde_json::json!({
            "status": "blocked",
            "reasonCode": "repeated_no_progress",
            "previousEffect": blocked.previous_effect,
            "previousReasonCode": blocked.previous_reason_code,
        });
        let result = super::NativeAgentToolResult::success_with_outcome(
            &tool_call,
            raw,
            NativeToolOutcome {
                effect: "blocked".to_string(),
                action_executed: Some(false),
                reason_code: "repeated_no_progress".to_string(),
                reason,
                retry: NativeToolRetry::Replan,
                next_action: None,
            },
        );
        commit_tool_observation(context, state, iteration, tool_call.into_original(), result)?;
    }
    Ok(())
}

fn queue_tool_batch(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    calls: &[PlannedToolCall],
) -> Result<(), String> {
    state.transition_phase(
        AgentRuntimePhase::ToolRunning,
        iteration,
        AgentEventKind::ToolStarted.wire_name(),
    )?;
    let queued_tool_calls = calls
        .iter()
        .map(|call| (call.tool_call.original().clone(), call.mode.as_str()))
        .collect::<Vec<_>>();
    for call in calls {
        let tool_call = &call.tool_call;
        let runtime_policy = tool_runtime_policy_payload(context, &tool_call.name);
        state.tools_used.push(tool_call.name.clone());
        state.emit(ToolLifecycleEvent::Started(serde_json::json!({
            "iteration": iteration,
            "modelIndex": call.index,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "status": "queued",
            "parallelMode": call.mode.as_str(),
            "runtimePolicy": runtime_policy,
        })))?;
    }
    state.set_queued_tool_calls(&queued_tool_calls);
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        serde_json::json!({
            "iteration": iteration,
            "pendingToolCalls": state.pending_tool_calls.clone(),
            "completedToolResults": state.completed_tool_results.clone(),
        }),
    );
    Ok(())
}

fn mark_tool_wave_running(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    wave_index: usize,
    wave: &ToolWave,
) -> Result<(), String> {
    for call in wave.calls() {
        let tool_call = &call.tool_call;
        state.mark_pending_tool_running(&tool_call.id);
        let runtime_policy = tool_runtime_policy_payload(context, &tool_call.name);
        state.emit(ToolLifecycleEvent::Started(serde_json::json!({
            "iteration": iteration,
            "waveIndex": wave_index,
            "modelIndex": call.index,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "status": "running",
            "parallelMode": call.mode.as_str(),
            "runtimePolicy": runtime_policy,
        })))?;
    }
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        serde_json::json!({
            "iteration": iteration,
            "pendingToolCalls": state.pending_tool_calls.clone(),
            "completedToolResults": state.completed_tool_results.clone(),
        }),
    );
    Ok(())
}

fn finish_wave_terminal(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    terminal: IndexedToolDispatchOutcome,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    match terminal.outcome {
        ToolDispatchOutcome::RuntimeFailure { tool_call, error } => {
            fatal_tool_error_result(services, context, state, iteration, &tool_call, error)
        }
        ToolDispatchOutcome::Cancelled { .. } => {
            cancelled_result(services, context, state, iteration)
        }
        ToolDispatchOutcome::CleanupTimedOut {
            tool_call,
            cancellation_mode,
            timeout_ms,
        } => tool_cleanup_timeout_result(
            services,
            context,
            state,
            iteration,
            &tool_call,
            cancellation_mode,
            timeout_ms,
        ),
        ToolDispatchOutcome::Completed(_) => {
            unreachable!("completed tool outcome cannot terminate a wave")
        }
    }
}

fn emit_ignored_wave_outcomes(
    state: &mut AgentTurnState,
    iteration: i64,
    wave_index: usize,
    terminal_reason: &str,
    ignored: Vec<IndexedToolDispatchOutcome>,
) -> Result<(), String> {
    for ignored_outcome in ignored {
        let model_index = ignored_outcome.index;
        let (tool_call, ignored_reason, error) = match ignored_outcome.outcome {
            ToolDispatchOutcome::Completed(completed) => {
                (completed.tool_call, "completed_after_terminal", None)
            }
            ToolDispatchOutcome::RuntimeFailure { tool_call, error } => {
                (tool_call, "runtime_failure_after_terminal", Some(error))
            }
            ToolDispatchOutcome::Cancelled { tool_call } => {
                (tool_call, "cancelled_after_terminal", None)
            }
            ToolDispatchOutcome::CleanupTimedOut { tool_call, .. } => {
                (tool_call, "cleanup_timeout_after_terminal", None)
            }
        };
        state.emit(ToolLifecycleEvent::Debug(serde_json::json!({
            "iteration": iteration,
            "waveIndex": wave_index,
            "modelIndex": model_index,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "ignoredReason": ignored_reason,
            "terminalOutcome": terminal_reason,
            "error": error,
        })))?;
    }
    Ok(())
}

fn tool_dispatch_outcome_name(outcome: &ToolDispatchOutcome) -> &'static str {
    match outcome {
        ToolDispatchOutcome::Completed(_) => "completed",
        ToolDispatchOutcome::RuntimeFailure { .. } => "runtime_failure",
        ToolDispatchOutcome::Cancelled { .. } => "cancelled",
        ToolDispatchOutcome::CleanupTimedOut { .. } => "cleanup_timeout",
    }
}

fn tool_runtime_policy_payload(context: &AgentTurnContext, tool_name: &str) -> Value {
    let cancellation_mode = native_tool_cancellation_mode(context, tool_name);
    serde_json::json!({
        "waitsForRuntimeCancellation": native_tool_waits_for_runtime_cancellation(context, tool_name),
        "cancellationMode": cancellation_mode.as_str(),
        "cleanupTimeoutMs": native_tool_cleanup_timeout_ms(context, tool_name),
        "mutatesWorkspace": native_tool_mutates_workspace(context, tool_name),
        "mutatesSession": native_tool_mutates_session(context, tool_name),
    })
}

fn context_is_cancelled(context: &AgentTurnContext) -> bool {
    context
        .cancellation
        .as_ref()
        .is_some_and(|cancellation| cancellation.is_cancelled())
}

async fn wait_for_context_cancellation(context: &AgentTurnContext) {
    if let Some(cancellation) = context.cancellation.as_ref() {
        cancellation.cancelled().await;
    } else {
        std::future::pending::<()>().await;
    }
}

fn start_tool_call(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
) -> Result<(), String> {
    state.tools_used.push(tool_call.name.clone());
    state.transition_phase(
        AgentRuntimePhase::ToolRunning,
        iteration,
        AgentEventKind::ToolStarted.wire_name(),
    )?;
    state.emit(ToolLifecycleEvent::Started(serde_json::json!({
        "iteration": iteration,
        "toolCallId": tool_call.id,
        "toolName": tool_call.name,
        "name": tool_call.name,
        "detailId": format!("tool:{}", tool_call.id),
        "status": "running",
    })))?;
    state.set_pending_tool_call(tool_call);
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        serde_json::json!({
            "iteration": iteration,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "argumentsJson": tool_call.arguments_json,
            "pendingToolCalls": state.pending_tool_calls.clone(),
            "completedToolResults": state.completed_tool_results.clone(),
        }),
    );
    Ok(())
}

fn record_tool_failure(
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    error: &str,
) -> Result<(), String> {
    let result = super::NativeAgentToolResult::generic_error(tool_call, error.to_string());
    commit_tool_observation(context, state, iteration, tool_call.clone(), result)
}

fn policy_denied_tool_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    let error = native_tool_rejection_reason(context, &tool_call.name);
    tool_error_result(services, context, state, iteration, tool_call, error)
}

fn tool_error_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    error: String,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    record_tool_failure(context, state, iteration, tool_call, &error)?;
    state.clear_pending_tool_calls();
    state.transition_phase(
        AgentRuntimePhase::Planning,
        iteration,
        AgentEventKind::ToolResult.wire_name(),
    )?;
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("tool_failed"),
    );
    if context_is_cancelled(context) {
        return cancelled_result(services, context, state, iteration);
    }
    Ok(NativeAgentToolExecutionOutcome::Continue)
}

fn fatal_tool_error_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    error: String,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    record_tool_failure(context, state, iteration, tool_call, &error)?;
    finish_tool_error_result(services, context, state, iteration, tool_call, error)
}

fn finish_tool_error_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    error: String,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    state.set_stop_reason("tool_error", iteration, AgentEventKind::Error.wire_name())?;
    state.emit(TerminalEvent::Error(serde_json::json!({
        "iteration": iteration,
        "stopReason": "tool_error",
        "error": error,
        "toolCallId": tool_call.id,
        "toolName": tool_call.name,
        "name": tool_call.name,
    })))?;
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);
    let runtime_events = state.runtime_events();
    Ok(NativeAgentToolExecutionOutcome::Finished(
        serde_json::json!({
            "runtime": "rust",
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "finalContent": "",
            "stopReason": "tool_error",
            "messages": [],
            "toolsUsed": state.tools_used,
            "completedToolResults": state.completed_tool_results,
            "error": error,
            "runtimeEvents": runtime_events,
        }),
    ))
}

fn tool_cleanup_timeout_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    cancellation_mode: ToolCancellationMode,
    timeout_ms: u64,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    let error = format!(
        "native tool `{}` cleanup exceeded {} ms for cancellation mode `{}`",
        tool_call.name,
        timeout_ms,
        cancellation_mode.as_str()
    );
    record_tool_failure(context, state, iteration, tool_call, &error)?;
    state.set_stop_reason(
        "tool_cleanup_timeout",
        iteration,
        AgentEventKind::ToolCleanupTimeout.wire_name(),
    )?;
    state.emit(PendingAgentEvent::new(
        AgentEventKind::ToolCleanupTimeout,
        serde_json::json!({
            "iteration": iteration,
            "stopReason": "tool_cleanup_timeout",
            "error": error,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "cancellationMode": cancellation_mode.as_str(),
            "timeoutMs": timeout_ms,
        }),
    ))?;
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);
    let runtime_events = state.runtime_events();
    Ok(NativeAgentToolExecutionOutcome::Finished(
        serde_json::json!({
            "runtime": "rust",
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "finalContent": "",
            "stopReason": "tool_cleanup_timeout",
            "messages": [],
            "toolsUsed": state.tools_used,
            "completedToolResults": state.completed_tool_results,
            "error": error,
            "runtimeEvents": runtime_events,
        }),
    ))
}

fn cancelled_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
) -> Result<NativeAgentToolExecutionOutcome, String> {
    state.emit_pending_hook_evaluations(context)?;
    state.transition_phase(
        AgentRuntimePhase::Cancelled,
        iteration,
        AgentEventKind::Cancelled.wire_name(),
    )?;
    Ok(NativeAgentToolExecutionOutcome::Finished(
        cancelled_turn_result(services, context, state, iteration)?,
    ))
}

#[cfg(test)]
#[path = "tool_runtime_update_plan_tests.rs"]
mod update_plan_tests;
