use super::approvals::{
    ApprovalRegistration, NativeAgentApprovalRequest, NativeAgentApprovalResolution,
};
use super::checkpoint::save_phase_checkpoint;
use super::result::cancelled_run_result;
use super::state::NativeAgentRunState;
use super::tool_dispatcher::{
    native_tool_call_supports_parallel, native_tool_cancellation_mode,
    native_tool_cleanup_timeout_ms, native_tool_is_permitted, native_tool_mutates_session,
    native_tool_mutates_workspace, native_tool_waits_for_runtime_cancellation,
};
use super::tool_projection::{
    assistant_tool_calls_message, completed_tool_result_entry, normalize_tool_result_for_context,
    subagent_activity_events_from_tool_result, subagent_link_event_from_tool_result,
    tool_error_observation_message, tool_observation_content, tool_observation_message,
};
use super::{
    AgentHookInvocation, AgentHookStage, NativeAgentRunContext, NativeAgentRuntimeServices,
    NativeAgentToolCall, NativeAgentToolDispatcher,
};
use crate::agent::runtime_protocol::AgentRuntimePhase;
use crate::agent::runtime_protocol::{AgentApprovalDecision, AgentApprovalScope};
use crate::tools::registry::{ToolApprovalMetadata, ToolCancellationMode};
use crate::tools::registry::{REQUEST_USER_INPUT_METHOD, TOOL_SEARCH_METHOD, UPDATE_PLAN_METHOD};
use futures_util::FutureExt;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
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

pub(super) enum OwnedToolCallResult {
    Completed(super::NativeAgentToolResult),
    Cancelled,
    CleanupTimedOut {
        cancellation_mode: ToolCancellationMode,
        timeout_ms: u64,
    },
}

struct ToolDispatchSuccess {
    tool_call: NativeAgentToolCall,
    result: super::NativeAgentToolResult,
}

enum ToolDispatchOutcome {
    Success(ToolDispatchSuccess),
    Failure {
        tool_call: NativeAgentToolCall,
        error: String,
    },
    Cancelled {
        tool_call: NativeAgentToolCall,
        terminal: bool,
    },
    CleanupTimedOut {
        tool_call: NativeAgentToolCall,
        cancellation_mode: ToolCancellationMode,
        timeout_ms: u64,
    },
    Skipped {
        tool_call: NativeAgentToolCall,
        terminal_outcome: ToolBatchTerminalOutcome,
    },
}

struct SequencedToolDispatchOutcome {
    sequence: usize,
    outcome: ToolDispatchOutcome,
}

struct OwnedToolTask {
    cancellation: CancellationToken,
    handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct OwnedToolBatch {
    tasks: BTreeMap<usize, OwnedToolTask>,
}

impl OwnedToolBatch {
    fn insert(&mut self, index: usize, task: OwnedToolTask) {
        self.tasks.insert(index, task);
    }

    fn cancel_all(&self) {
        for task in self.tasks.values() {
            task.cancellation.cancel();
        }
    }

    async fn finish(&mut self, index: usize) -> Result<(), String> {
        let Some(task) = self.tasks.remove(&index) else {
            return Err(format!("owned tool task {index} was not registered"));
        };
        task.handle
            .await
            .map_err(|error| format!("owned tool task {index} failed to join: {error}"))
    }
}

impl Drop for OwnedToolBatch {
    fn drop(&mut self) {
        for task in self.tasks.values() {
            task.cancellation.cancel();
            task.handle.abort();
        }
    }
}

enum ToolDispatchEvent {
    Running {
        tool_call: NativeAgentToolCall,
        parallel_mode: &'static str,
    },
    Finished {
        index: usize,
        result: SequencedToolDispatchOutcome,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolBatchTerminalOutcome {
    Failed,
    Cancelled,
}

struct ToolBatchTerminal {
    state: AtomicUsize,
}

impl ToolBatchTerminal {
    const NONE: usize = 0;
    const CANCELLED: usize = 1;
    const FAILED_INDEX_OFFSET: usize = 2;

    fn new() -> Self {
        Self {
            state: AtomicUsize::new(Self::NONE),
        }
    }

    fn try_claim_failure(&self, index: usize) -> bool {
        let failed_state = index
            .checked_add(Self::FAILED_INDEX_OFFSET)
            .expect("tool batch index should fit terminal state encoding");
        let mut current = self.state.load(Ordering::Acquire);
        loop {
            if current == Self::CANCELLED
                || (current >= Self::FAILED_INDEX_OFFSET && current <= failed_state)
            {
                return false;
            }
            match self.state.compare_exchange(
                current,
                failed_state,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(updated) => current = updated,
            }
        }
    }

    fn try_claim_cancelled(&self) -> bool {
        self.state
            .compare_exchange(
                Self::NONE,
                Self::CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn outcome(&self) -> Option<ToolBatchTerminalOutcome> {
        match self.state.load(Ordering::Acquire) {
            Self::CANCELLED => Some(ToolBatchTerminalOutcome::Cancelled),
            state if state >= Self::FAILED_INDEX_OFFSET => Some(ToolBatchTerminalOutcome::Failed),
            _ => None,
        }
    }

    fn skip_outcome_for(&self, index: usize) -> Option<ToolBatchTerminalOutcome> {
        match self.state.load(Ordering::Acquire) {
            Self::CANCELLED => Some(ToolBatchTerminalOutcome::Cancelled),
            state if state >= Self::FAILED_INDEX_OFFSET => {
                let failed_index = state - Self::FAILED_INDEX_OFFSET;
                (index > failed_index).then_some(ToolBatchTerminalOutcome::Failed)
            }
            _ => None,
        }
    }
}

impl ToolBatchTerminalOutcome {
    fn as_str(self) -> &'static str {
        match self {
            ToolBatchTerminalOutcome::Failed => "failed",
            ToolBatchTerminalOutcome::Cancelled => "cancelled",
        }
    }
}

#[cfg(test)]
mod terminal_tests {
    use super::*;

    #[test]
    fn lower_model_order_failure_replaces_a_faster_later_failure() {
        let terminal = ToolBatchTerminal::new();

        assert!(terminal.try_claim_failure(2));
        assert!(terminal.try_claim_failure(0));
        assert!(!terminal.try_claim_failure(1));
        assert_eq!(terminal.skip_outcome_for(0), None);
        assert_eq!(
            terminal.skip_outcome_for(1),
            Some(ToolBatchTerminalOutcome::Failed)
        );
        assert_eq!(
            terminal.skip_outcome_for(2),
            Some(ToolBatchTerminalOutcome::Failed)
        );
        assert_eq!(terminal.outcome(), Some(ToolBatchTerminalOutcome::Failed));
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ToolLockMode {
    Read,
    Write,
}

struct ToolReadWriteLock {
    state: Mutex<ToolReadWriteLockState>,
    available: Notify,
}

struct ToolReadWriteLockState {
    pending: BTreeMap<usize, ToolLockMode>,
    active_readers: usize,
    active_writer: bool,
}

struct ToolReadWriteGuard {
    lock: Arc<ToolReadWriteLock>,
    mode: ToolLockMode,
}

impl ToolReadWriteLock {
    fn new(modes: impl IntoIterator<Item = (usize, ToolLockMode)>) -> Self {
        Self {
            state: Mutex::new(ToolReadWriteLockState {
                pending: modes.into_iter().collect(),
                active_readers: 0,
                active_writer: false,
            }),
            available: Notify::new(),
        }
    }

    async fn read(self: &Arc<Self>, index: usize) -> Result<ToolReadWriteGuard, String> {
        loop {
            let notified = self.available.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let acquired = {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|error| format!("native tool scheduler lock poisoned: {error}"))?;
                if !state.active_writer && !state.pending_write_before(index) {
                    state.pending.remove(&index);
                    state.active_readers += 1;
                    true
                } else {
                    false
                }
            };
            if acquired {
                return Ok(ToolReadWriteGuard {
                    lock: self.clone(),
                    mode: ToolLockMode::Read,
                });
            }
            notified.await;
        }
    }

    async fn write(self: &Arc<Self>, index: usize) -> Result<ToolReadWriteGuard, String> {
        loop {
            let notified = self.available.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let acquired = {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|error| format!("native tool scheduler lock poisoned: {error}"))?;
                if !state.active_writer && state.active_readers == 0 && !state.pending_before(index)
                {
                    state.pending.remove(&index);
                    state.active_writer = true;
                    true
                } else {
                    false
                }
            };
            if acquired {
                return Ok(ToolReadWriteGuard {
                    lock: self.clone(),
                    mode: ToolLockMode::Write,
                });
            }
            notified.await;
        }
    }
}

impl ToolReadWriteLockState {
    fn pending_before(&self, index: usize) -> bool {
        self.pending
            .keys()
            .any(|pending_index| *pending_index < index)
    }

    fn pending_write_before(&self, index: usize) -> bool {
        self.pending
            .iter()
            .any(|(pending_index, mode)| *pending_index < index && *mode == ToolLockMode::Write)
    }
}

impl Drop for ToolReadWriteGuard {
    fn drop(&mut self) {
        let Ok(mut state) = self.lock.state.lock() else {
            return;
        };
        match self.mode {
            ToolLockMode::Read => {
                state.active_readers = state.active_readers.saturating_sub(1);
            }
            ToolLockMode::Write => {
                state.active_writer = false;
            }
        }
        self.lock.available.notify_waiters();
    }
}

pub(super) async fn execute_tool_calls_for_iteration(
    services: &NativeAgentRuntimeServices,
    context: &mut NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    final_content: String,
    tool_calls: Vec<NativeAgentToolCall>,
) -> NativeAgentToolExecutionOutcome {
    state.transition_phase(
        AgentRuntimePhase::ToolCalling,
        iteration,
        "agent.tool_call.delta",
    );
    state
        .history
        .record_message(assistant_tool_calls_message(&final_content, &tool_calls))
        .expect("runtime-generated assistant tool call message must be valid");

    for tool_call in &tool_calls {
        state.emit_event(
            "agent.tool_call.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "name": tool_call.name,
                "argumentsDelta": tool_call.arguments_json,
            }),
        );
        if !native_tool_is_permitted(context, &tool_call.name) {
            return policy_denied_result(services, context, state, iteration, tool_call);
        }
    }

    if context_is_cancelled(context) {
        return cancelled_result(services, context, state, iteration);
    }

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
        let tool_call = match prepare_special_tool_call(context, state, tool_call.clone()) {
            Ok(tool_call) => tool_call,
            Err(error) => {
                return tool_error_result(services, context, state, iteration, &tool_call, error);
            }
        };
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
        let tool_call = match prepare_special_tool_call(context, state, tool_call.clone()) {
            Ok(tool_call) => tool_call,
            Err(error) => {
                return tool_error_result(services, context, state, iteration, &tool_call, error);
            }
        };
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
        let tool_call = match prepare_special_tool_call(context, state, tool_call.clone()) {
            Ok(tool_call) => tool_call,
            Err(error) => {
                return tool_error_result(services, context, state, iteration, &tool_call, error);
            }
        };
        return match super::user_input::awaiting_user_input_result(
            services,
            context,
            state,
            iteration,
            tool_call.clone(),
        ) {
            Ok(result) => NativeAgentToolExecutionOutcome::Finished(result),
            Err(error) => tool_error_result(services, context, state, iteration, &tool_call, error),
        };
    }

    if tool_calls.iter().any(|tool_call| {
        context
            .tool_router
            .approval_metadata(&tool_call.name)
            .is_some_and(|approval| approval.required)
    }) {
        return execute_approval_gated_tool_batch(services, context, state, iteration, tool_calls)
            .await;
    }

    if tool_calls.len() == 1 {
        execute_sequential_tool_batch(services, context, state, iteration, tool_calls).await
    } else {
        execute_locked_tool_batch(services, context, state, iteration, tool_calls).await
    }
}

fn prepare_special_tool_call(
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    mut tool_call: NativeAgentToolCall,
) -> Result<NativeAgentToolCall, String> {
    let normalized_input =
        serde_json::from_str::<Value>(&tool_call.arguments_json).map_err(|error| {
            format!(
                "native tool `{}` arguments are invalid JSON before hook dispatch: {error}",
                tool_call.name
            )
        })?;
    let invocation = AgentHookInvocation::tool(
        AgentHookStage::BeforeToolUse,
        context.trace_context.clone(),
        tool_call.id.clone(),
        tool_call.name.clone(),
        Some(normalized_input),
        None,
    );
    let evaluation = context.evaluate_hook(invocation.clone())?;
    state.emit_hook_evaluation(&invocation, &evaluation);
    if let Some(reason) = evaluation.denied_reason {
        context.metrics().increment("tool.denied");
        return Err(format!(
            "native tool `{}` denied by hook: {reason}",
            tool_call.name
        ));
    }
    if evaluation.input_replaced {
        let replacement = evaluation.normalized_input.ok_or_else(|| {
            format!(
                "native tool `{}` hook replacement is missing normalized input",
                tool_call.name
            )
        })?;
        if !replacement.is_object() {
            return Err(format!(
                "native tool `{}` hook replacement must be a JSON object",
                tool_call.name
            ));
        }
        tool_call.arguments_json = serde_json::to_string(&replacement).map_err(|error| {
            format!(
                "native tool `{}` hook replacement failed to serialize: {error}",
                tool_call.name
            )
        })?;
    }
    Ok(tool_call)
}

enum AwaitToolApprovalOutcome {
    Resolved(NativeAgentApprovalResolution),
    Cancelled,
    Failed(String),
}

async fn execute_approval_gated_tool_batch(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_calls: Vec<NativeAgentToolCall>,
) -> NativeAgentToolExecutionOutcome {
    for mut tool_call in tool_calls {
        if context_is_cancelled(context) {
            return cancelled_result(services, context, state, iteration);
        }
        if let Some(approval) = context
            .tool_router
            .approval_metadata(&tool_call.name)
            .filter(|approval| approval.required)
        {
            tool_call = match prepare_special_tool_call(context, state, tool_call.clone()) {
                Ok(tool_call) => tool_call,
                Err(error) => {
                    return tool_error_result(
                        services, context, state, iteration, &tool_call, error,
                    );
                }
            };
            match await_tool_approval(services, context, state, iteration, &tool_call, approval)
                .await
            {
                AwaitToolApprovalOutcome::Resolved(resolution) => {
                    emit_approval_decision(context, state, iteration, &resolution);
                    state.clear_pending_tool_calls();
                    if resolution.decision == AgentApprovalDecision::Denied {
                        context.metrics().increment("approval.denied_by_user");
                        let mut error =
                            format!("native tool `{}` was rejected by the user", tool_call.name);
                        if let Some(guidance) = resolution
                            .guidance
                            .as_deref()
                            .map(str::trim)
                            .filter(|guidance| !guidance.is_empty())
                        {
                            error.push_str(": ");
                            error.push_str(guidance);
                        }
                        record_tool_failure(context, state, iteration, &tool_call, &error);
                        state.transition_phase(
                            AgentRuntimePhase::Planning,
                            iteration,
                            "agent.tool.result",
                        );
                        save_phase_checkpoint(
                            services,
                            context,
                            state.phase.as_str(),
                            state.active_checkpoint_payload("tool_rejected"),
                        );
                        continue;
                    }
                    context.metrics().increment("approval.approved");
                }
                AwaitToolApprovalOutcome::Cancelled => {
                    return cancelled_result(services, context, state, iteration);
                }
                AwaitToolApprovalOutcome::Failed(error) => {
                    return tool_error_result(
                        services, context, state, iteration, &tool_call, error,
                    );
                }
            }
        }
        let outcome =
            execute_sequential_tool_batch(services, context, state, iteration, vec![tool_call])
                .await;
        if !matches!(outcome, NativeAgentToolExecutionOutcome::Continue) {
            return outcome;
        }
    }
    NativeAgentToolExecutionOutcome::Continue
}

async fn await_tool_approval(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    approval: ToolApprovalMetadata,
) -> AwaitToolApprovalOutcome {
    let arguments = match serde_json::from_str::<Value>(&tool_call.arguments_json) {
        Ok(arguments) => arguments,
        Err(error) => {
            return AwaitToolApprovalOutcome::Failed(format!(
                "native tool `{}` arguments are invalid JSON: {error}",
                tool_call.name
            ));
        }
    };
    let permission_invocation = AgentHookInvocation::tool(
        AgentHookStage::PermissionRequest,
        context.trace_context.clone(),
        tool_call.id.clone(),
        tool_call.name.clone(),
        Some(arguments.clone()),
        None,
    );
    let permission_evaluation = match context.evaluate_hook(permission_invocation.clone()) {
        Ok(evaluation) => evaluation,
        Err(error) => {
            return AwaitToolApprovalOutcome::Failed(error);
        }
    };
    state.emit_hook_evaluation(&permission_invocation, &permission_evaluation);
    if let Some(reason) = permission_evaluation.denied_reason {
        context.metrics().increment("approval.denied_by_hook");
        return AwaitToolApprovalOutcome::Failed(format!(
            "native tool `{}` approval denied by hook: {reason}",
            tool_call.name
        ));
    }
    let approval_id = format!("approval:{}:{}", context.run_id, tool_call.id);
    let (scope_key, scope_label) = match context
        .tool_router
        .approval_session_scope(&tool_call.name, &arguments)
    {
        Ok(scope) => scope,
        Err(error) => return AwaitToolApprovalOutcome::Failed(error),
    };
    let broker = services.approval_broker();
    let receiver = match broker.register(NativeAgentApprovalRequest {
        approval_id: approval_id.clone(),
        session_id: context.session_id.clone(),
        run_id: context.run_id.clone(),
        scope_key: scope_key.clone(),
    }) {
        Ok(ApprovalRegistration::ApprovedForSession(resolution)) => {
            return AwaitToolApprovalOutcome::Resolved(resolution);
        }
        Ok(ApprovalRegistration::Pending(receiver)) => receiver,
        Err(error) => return AwaitToolApprovalOutcome::Failed(error),
    };
    context.metrics().increment("approval.requested");
    let summary = format!("Approval required: {}", tool_call.name);
    let risk = if matches!(
        tool_call.name.as_str(),
        "shell.execute" | "exec_command" | "mcp.call_tool"
    ) {
        "high"
    } else {
        "medium"
    };
    state.set_pending_tool_call(&tool_call);
    state.transition_phase(
        AgentRuntimePhase::AwaitingApproval,
        iteration,
        "agent.awaiting_approval",
    );
    let operation = serde_json::json!({
        "toolCallId": tool_call.id,
        "toolName": tool_call.name,
        "arguments": arguments,
    });
    state.emit_event(
        "agent.awaiting_approval",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "approvalId": approval_id,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "detailId": format!("approval:{approval_id}"),
            "status": "waiting",
            "summary": summary,
            "content": summary,
            "risk": risk,
            "scope": approval.scope,
            "lifetime": approval.lifetime,
            "scopeKey": scope_key,
            "scopeLabel": scope_label,
            "options": [
                { "decision": "approved", "scope": "once" },
                { "decision": "approved", "scope": "session" },
                { "decision": "denied" }
            ],
            "operation": operation,
        }),
    );
    let approval_wait_started = std::time::Instant::now();
    tokio::select! {
        resolution = receiver => match resolution {
            Ok(resolution) => {
                context
                    .metrics()
                    .record_duration("approval.wait.durationMs", approval_wait_started.elapsed());
                context.metrics().increment("approval.resolved");
                AwaitToolApprovalOutcome::Resolved(resolution)
            },
            Err(_) if context_is_cancelled(context) => AwaitToolApprovalOutcome::Cancelled,
            Err(_) => AwaitToolApprovalOutcome::Failed(format!(
                "native approval `{approval_id}` was closed before a decision was received"
            )),
        },
        _ = wait_for_context_cancellation(context) => {
            broker.cancel(&approval_id);
            AwaitToolApprovalOutcome::Cancelled
        }
    }
}

fn emit_approval_decision(
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    resolution: &NativeAgentApprovalResolution,
) {
    state.emit_event(
        "agent.approval.decision",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "approvalId": resolution.approval_id,
            "detailId": format!("approval:{}", resolution.approval_id),
            "status": "completed",
            "decision": match resolution.decision {
                AgentApprovalDecision::Approved => "approved",
                AgentApprovalDecision::Denied => "denied",
            },
            "scope": match resolution.scope {
                AgentApprovalScope::Once => "once",
                AgentApprovalScope::Session => "session",
            },
            "guidance": resolution.guidance,
            "commandId": resolution.command_id,
        }),
    );
}

fn execute_tool_search(
    services: &NativeAgentRuntimeServices,
    context: &mut NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: NativeAgentToolCall,
) -> NativeAgentToolExecutionOutcome {
    start_tool_call(services, context, state, iteration, &tool_call);
    context.metrics().increment("tool.started");
    let tool_started_at = std::time::Instant::now();
    let raw_result = match context
        .tool_router
        .search_and_activate(&tool_call.arguments_json)
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
    let after_invocation = AgentHookInvocation::tool(
        AgentHookStage::AfterToolUse,
        context.trace_context.clone(),
        tool_call.id.clone(),
        tool_call.name.clone(),
        None,
        Some("completed".to_string()),
    );
    let after_evaluation = match context.evaluate_hook(after_invocation.clone()) {
        Ok(evaluation) => evaluation,
        Err(error) => {
            return tool_error_result(services, context, state, iteration, &tool_call, error);
        }
    };
    state.emit_hook_evaluation(&after_invocation, &after_evaluation);
    record_tool_success(&*context, state, iteration, tool_call, result);
    state.clear_pending_tool_calls();
    state.transition_phase(AgentRuntimePhase::Planning, iteration, "agent.tool.result");
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
    NativeAgentToolExecutionOutcome::Continue
}

fn execute_update_plan(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: NativeAgentToolCall,
) -> NativeAgentToolExecutionOutcome {
    context.metrics().increment("tool.started");
    let tool_started_at = std::time::Instant::now();
    let mut plan = match parse_update_plan_args(&tool_call.arguments_json) {
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
    let plan_id = format!("{}:plan", context.run_id);

    state.tools_used.push(tool_call.name.clone());
    state.transition_phase(
        AgentRuntimePhase::ToolRunning,
        iteration,
        "agent.plan.progress",
    );
    state.emit_event(
        "agent.plan.progress",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "planId": plan_id,
            "explanation": plan.explanation,
            "steps": plan.plan,
            "summary": summary,
            "completed": completed,
            "total": total,
            "currentStep": current_step,
        }),
    );

    let result = super::NativeAgentToolResult::generic_success(
        &tool_call,
        Value::String("Plan updated".to_string()),
    );
    context
        .metrics()
        .record_duration("tool.durationMs", tool_started_at.elapsed());
    context.metrics().increment("tool.completed");

    let after_invocation = AgentHookInvocation::tool(
        AgentHookStage::AfterToolUse,
        context.trace_context.clone(),
        tool_call.id.clone(),
        tool_call.name.clone(),
        None,
        Some("completed".to_string()),
    );
    let after_evaluation = match context.evaluate_hook(after_invocation.clone()) {
        Ok(evaluation) => evaluation,
        Err(error) => {
            return tool_error_result(services, context, state, iteration, &tool_call, error);
        }
    };
    state.emit_hook_evaluation(&after_invocation, &after_evaluation);
    record_tool_success(context, state, iteration, tool_call, result);
    state.clear_pending_tool_calls();
    state.transition_phase(AgentRuntimePhase::Planning, iteration, "agent.tool.result");
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("plan_updated"),
    );
    NativeAgentToolExecutionOutcome::Continue
}

fn recoverable_update_plan_error(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: NativeAgentToolCall,
    error: String,
) -> NativeAgentToolExecutionOutcome {
    state.tools_used.push(tool_call.name.clone());
    let result = super::NativeAgentToolResult::generic_error(&tool_call, error);
    record_tool_success(context, state, iteration, tool_call.clone(), result);
    let after_invocation = AgentHookInvocation::tool(
        AgentHookStage::AfterToolUse,
        context.trace_context.clone(),
        tool_call.id.clone(),
        tool_call.name.clone(),
        None,
        Some("failed".to_string()),
    );
    let after_evaluation = match context.evaluate_hook(after_invocation.clone()) {
        Ok(evaluation) => evaluation,
        Err(error) => {
            return tool_error_result(services, context, state, iteration, &tool_call, error);
        }
    };
    state.emit_hook_evaluation(&after_invocation, &after_evaluation);
    state.clear_pending_tool_calls();
    state.transition_phase(AgentRuntimePhase::Planning, iteration, "agent.tool.result");
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("plan_rejected"),
    );
    NativeAgentToolExecutionOutcome::Continue
}

fn parse_update_plan_args(arguments_json: &str) -> Result<UpdatePlanArgs, String> {
    let mut args = serde_json::from_str::<UpdatePlanArgs>(arguments_json)
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

async fn execute_sequential_tool_batch(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_calls: Vec<NativeAgentToolCall>,
) -> NativeAgentToolExecutionOutcome {
    for tool_call in tool_calls {
        if context_is_cancelled(context) {
            return cancelled_result(services, context, state, iteration);
        }
        start_tool_call(services, context, state, iteration, &tool_call);
        let result = match dispatch_owned_sequential_tool(
            services.tools.clone(),
            context.clone(),
            tool_call.clone(),
        )
        .await
        {
            ToolDispatchOutcome::Success(success) => success.result,
            ToolDispatchOutcome::Failure { error, .. } => {
                return tool_error_result(services, context, state, iteration, &tool_call, error);
            }
            ToolDispatchOutcome::Cancelled { .. } => {
                return cancelled_result(services, context, state, iteration);
            }
            ToolDispatchOutcome::CleanupTimedOut {
                cancellation_mode,
                timeout_ms,
                ..
            } => {
                return tool_cleanup_timeout_result(
                    services,
                    context,
                    state,
                    iteration,
                    &tool_call,
                    cancellation_mode,
                    timeout_ms,
                );
            }
            ToolDispatchOutcome::Skipped { .. } => {
                return tool_error_result(
                    services,
                    context,
                    state,
                    iteration,
                    &tool_call,
                    "sequential tool dispatch was skipped unexpectedly".to_string(),
                );
            }
        };
        record_tool_success(context, state, iteration, tool_call, result);
        state.clear_pending_tool_calls();
        state.transition_phase(AgentRuntimePhase::Planning, iteration, "agent.tool.result");
        save_phase_checkpoint(
            services,
            context,
            state.phase.as_str(),
            state.active_checkpoint_payload("tool_completed"),
        );
        if context_is_cancelled(context) {
            return cancelled_result(services, context, state, iteration);
        }
    }
    NativeAgentToolExecutionOutcome::Continue
}

async fn dispatch_owned_sequential_tool(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: NativeAgentRunContext,
    tool_call: NativeAgentToolCall,
) -> ToolDispatchOutcome {
    let child_cancellation = CancellationToken::new();
    let child_context = context.with_child_cancellation(child_cancellation.clone());
    let panic_tool_call = tool_call.clone();
    let task_tool_call = tool_call.clone();
    let task = async move {
        match dispatch_tool_with_cancellation_policy(dispatcher, child_context, task_tool_call)
            .await
        {
            ToolDispatchOutcome::Cancelled { tool_call, .. } => ToolDispatchOutcome::Cancelled {
                tool_call,
                terminal: true,
            },
            outcome => outcome,
        }
    };
    let mut handle = tauri::async_runtime::spawn(async move {
        match AssertUnwindSafe(task).catch_unwind().await {
            Ok(outcome) => outcome,
            Err(_) => ToolDispatchOutcome::Failure {
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
    joined.unwrap_or_else(|error| ToolDispatchOutcome::Failure {
        tool_call,
        error: format!("owned native tool task failed to join: {error}"),
    })
}

pub(super) async fn dispatch_owned_tool_call(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: NativeAgentRunContext,
    tool_call: NativeAgentToolCall,
) -> Result<OwnedToolCallResult, String> {
    match dispatch_owned_sequential_tool(dispatcher, context, tool_call).await {
        ToolDispatchOutcome::Success(success) => Ok(OwnedToolCallResult::Completed(success.result)),
        ToolDispatchOutcome::Failure { error, .. } => Err(error),
        ToolDispatchOutcome::Cancelled { .. } => Ok(OwnedToolCallResult::Cancelled),
        ToolDispatchOutcome::CleanupTimedOut {
            cancellation_mode,
            timeout_ms,
            ..
        } => Ok(OwnedToolCallResult::CleanupTimedOut {
            cancellation_mode,
            timeout_ms,
        }),
        ToolDispatchOutcome::Skipped { .. } => {
            Err("owned native tool dispatch was skipped unexpectedly".to_string())
        }
    }
}

async fn dispatch_tool_with_cancellation_policy(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: NativeAgentRunContext,
    mut tool_call: NativeAgentToolCall,
) -> ToolDispatchOutcome {
    let normalized_input = match serde_json::from_str::<Value>(&tool_call.arguments_json) {
        Ok(input) => input,
        Err(error) => {
            return ToolDispatchOutcome::Failure {
                error: format!(
                    "native tool `{}` arguments are invalid JSON before hook dispatch: {error}",
                    tool_call.name
                ),
                tool_call,
            };
        }
    };
    let before_invocation = AgentHookInvocation::tool(
        AgentHookStage::BeforeToolUse,
        context.trace_context.clone(),
        tool_call.id.clone(),
        tool_call.name.clone(),
        Some(normalized_input),
        None,
    );
    let before_evaluation = match context.evaluate_hook(before_invocation.clone()) {
        Ok(evaluation) => evaluation,
        Err(error) => return ToolDispatchOutcome::Failure { tool_call, error },
    };
    let denied_reason = before_evaluation.denied_reason.clone();
    let replacement = before_evaluation
        .input_replaced
        .then(|| before_evaluation.normalized_input.clone())
        .flatten();
    context.queue_hook_evaluation(before_invocation, before_evaluation);
    if let Some(reason) = denied_reason {
        context.metrics().increment("tool.denied");
        return ToolDispatchOutcome::Failure {
            error: format!("native tool `{}` denied by hook: {reason}", tool_call.name),
            tool_call,
        };
    }
    if let Some(replacement) = replacement {
        if !replacement.is_object() {
            return ToolDispatchOutcome::Failure {
                error: format!(
                    "native tool `{}` hook replacement must be a JSON object",
                    tool_call.name
                ),
                tool_call,
            };
        }
        tool_call.arguments_json = match serde_json::to_string(&replacement) {
            Ok(arguments) => arguments,
            Err(error) => {
                return ToolDispatchOutcome::Failure {
                    error: format!(
                        "native tool `{}` hook replacement failed to serialize: {error}",
                        tool_call.name
                    ),
                    tool_call,
                };
            }
        };
    }
    let cancellation_mode = native_tool_cancellation_mode(&context, &tool_call.name);
    let cleanup_timeout_ms = native_tool_cleanup_timeout_ms(&context, &tool_call.name).max(1);
    let dispatch_call = tool_call.clone();
    let tool_call_id = tool_call.id.clone();
    let tool_name = tool_call.name.clone();
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
                Ok(Ok(result)) => ToolDispatchOutcome::Success(ToolDispatchSuccess {
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
                Ok(Err(_)) | Err(_) => ToolDispatchOutcome::Cancelled {
                    tool_call,
                    terminal: false,
                },
            }
        }
        result = &mut operation => match result {
            Ok(result) => ToolDispatchOutcome::Success(ToolDispatchSuccess {
                tool_call,
                result,
            }),
            Err(error) => ToolDispatchOutcome::Failure {
                tool_call,
                error,
            },
        },
    };
    let tool_duration = tool_started_at.elapsed();
    context
        .metrics()
        .record_duration("tool.durationMs", tool_duration);
    let outcome_label = match &outcome {
        ToolDispatchOutcome::Success(_) => "completed",
        ToolDispatchOutcome::Failure { .. } => "failed",
        ToolDispatchOutcome::Cancelled { .. } => "cancelled",
        ToolDispatchOutcome::CleanupTimedOut { .. } => "cleanup_timeout",
        ToolDispatchOutcome::Skipped { .. } => "skipped",
    };
    context
        .metrics()
        .increment(&format!("tool.{outcome_label}"));
    let after_invocation = AgentHookInvocation::tool(
        AgentHookStage::AfterToolUse,
        context.trace_context.clone(),
        tool_call_id,
        tool_name,
        None,
        Some(outcome_label.to_string()),
    );
    let after_evaluation = match context.evaluate_hook(after_invocation.clone()) {
        Ok(evaluation) => evaluation,
        Err(error) => {
            return ToolDispatchOutcome::Failure {
                tool_call: tool_dispatch_outcome_tool_call(&outcome).clone(),
                error,
            };
        }
    };
    context.queue_hook_evaluation(after_invocation, after_evaluation);
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn execute_owned_locked_tool(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: NativeAgentRunContext,
    tool_call: NativeAgentToolCall,
    lock: Arc<ToolReadWriteLock>,
    index: usize,
    supports_parallel: bool,
    parallel_mode: &'static str,
    task_cancellation: CancellationToken,
    sender: mpsc::UnboundedSender<ToolDispatchEvent>,
    terminal: Arc<ToolBatchTerminal>,
) -> ToolDispatchOutcome {
    let context = context.with_child_cancellation(task_cancellation);
    if context_is_cancelled(&context) {
        return ToolDispatchOutcome::Cancelled {
            tool_call,
            terminal: terminal.try_claim_cancelled(),
        };
    }

    let lock_result = if supports_parallel {
        tokio::select! {
            biased;
            _ = wait_for_context_cancellation(&context) => {
                return ToolDispatchOutcome::Cancelled {
                    tool_call,
                    terminal: terminal.try_claim_cancelled(),
                };
            }
            result = lock.read(index) => result,
        }
    } else {
        tokio::select! {
            biased;
            _ = wait_for_context_cancellation(&context) => {
                return ToolDispatchOutcome::Cancelled {
                    tool_call,
                    terminal: terminal.try_claim_cancelled(),
                };
            }
            result = lock.write(index) => result,
        }
    };
    let _guard = match lock_result {
        Ok(guard) => guard,
        Err(error) => {
            terminal.try_claim_failure(index);
            return ToolDispatchOutcome::Failure {
                tool_call,
                error: format!("native tool scheduler lock acquisition failed: {error}"),
            };
        }
    };

    if context_is_cancelled(&context) {
        return ToolDispatchOutcome::Cancelled {
            tool_call,
            terminal: terminal.try_claim_cancelled(),
        };
    }
    if let Some(terminal_outcome) = terminal.skip_outcome_for(index) {
        return ToolDispatchOutcome::Skipped {
            tool_call,
            terminal_outcome,
        };
    }
    let _ = sender.send(ToolDispatchEvent::Running {
        tool_call: tool_call.clone(),
        parallel_mode,
    });

    match dispatch_tool_with_cancellation_policy(dispatcher, context, tool_call).await {
        ToolDispatchOutcome::Failure { tool_call, error } => {
            terminal.try_claim_failure(index);
            ToolDispatchOutcome::Failure { tool_call, error }
        }
        ToolDispatchOutcome::Cancelled { tool_call, .. } => ToolDispatchOutcome::Cancelled {
            tool_call,
            terminal: terminal.try_claim_cancelled(),
        },
        outcome @ ToolDispatchOutcome::CleanupTimedOut { .. } => {
            terminal.try_claim_cancelled();
            outcome
        }
        outcome => outcome,
    }
}

async fn execute_locked_tool_batch(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_calls: Vec<NativeAgentToolCall>,
) -> NativeAgentToolExecutionOutcome {
    state.transition_phase(
        AgentRuntimePhase::ToolRunning,
        iteration,
        "agent.tool.start",
    );
    let queued_tool_calls = tool_calls
        .iter()
        .map(|tool_call| {
            (
                tool_call.clone(),
                parallel_mode_for_tool_call(context, tool_call),
            )
        })
        .collect::<Vec<_>>();
    for tool_call in &tool_calls {
        let parallel_mode = parallel_mode_for_tool_call(context, tool_call);
        let runtime_policy = tool_runtime_policy_payload(context, &tool_call.name);
        state.tools_used.push(tool_call.name.clone());
        state.emit_event(
            "agent.tool.start",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "name": tool_call.name,
                "detailId": format!("tool:{}", tool_call.id),
                "status": "queued",
                "parallelMode": parallel_mode,
                "runtimePolicy": runtime_policy,
            }),
        );
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

    let scheduler_lock = Arc::new(ToolReadWriteLock::new(
        queued_tool_calls
            .iter()
            .enumerate()
            .map(|(index, (_tool_call, parallel_mode))| {
                let mode = if *parallel_mode == "read" {
                    ToolLockMode::Read
                } else {
                    ToolLockMode::Write
                };
                (index, mode)
            }),
    ));
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let terminal = Arc::new(ToolBatchTerminal::new());
    let finish_sequence = Arc::new(AtomicUsize::new(0));
    let task_count = tool_calls.len();
    let mut owned_batch = OwnedToolBatch::default();
    for (index, tool_call) in tool_calls.into_iter().enumerate() {
        let dispatcher = services.tools.clone();
        let task_context = context.clone();
        let lock = scheduler_lock.clone();
        let sender = sender.clone();
        let terminal = terminal.clone();
        let panic_terminal = terminal.clone();
        let finish_sequence = finish_sequence.clone();
        let supports_parallel = native_tool_call_supports_parallel(&task_context, &tool_call);
        let parallel_mode = if supports_parallel { "read" } else { "write" };
        let child_cancellation = CancellationToken::new();
        let task_cancellation = child_cancellation.clone();
        let panic_tool_call = tool_call.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let operation = execute_owned_locked_tool(
                dispatcher,
                task_context,
                tool_call,
                lock,
                index,
                supports_parallel,
                parallel_mode,
                task_cancellation,
                sender.clone(),
                terminal,
            );
            let outcome = match AssertUnwindSafe(operation).catch_unwind().await {
                Ok(outcome) => outcome,
                Err(_) => {
                    panic_terminal.try_claim_failure(index);
                    ToolDispatchOutcome::Failure {
                        tool_call: panic_tool_call,
                        error: "owned native tool task panicked".to_string(),
                    }
                }
            };
            send_tool_dispatch_finished(&sender, &finish_sequence, index, outcome);
        });
        owned_batch.insert(
            index,
            OwnedToolTask {
                cancellation: child_cancellation,
                handle,
            },
        );
    }
    drop(sender);

    let mut indexed_results = (0..task_count).map(|_| None).collect::<Vec<_>>();
    let mut finished_count = 0usize;
    let mut cancellation_terminal_claimed = false;
    while finished_count < task_count {
        if context_is_cancelled(context) {
            terminal.try_claim_cancelled();
            cancellation_terminal_claimed = true;
            owned_batch.cancel_all();
        }
        let event = tokio::select! {
            biased;
            _ = wait_for_context_cancellation(context), if !cancellation_terminal_claimed => {
                terminal.try_claim_cancelled();
                cancellation_terminal_claimed = true;
                owned_batch.cancel_all();
                continue;
            }
            event = receiver.recv() => event,
        };
        match event {
            Some(ToolDispatchEvent::Running {
                tool_call,
                parallel_mode,
            }) => {
                if context_is_cancelled(context) {
                    terminal.try_claim_cancelled();
                    cancellation_terminal_claimed = true;
                    owned_batch.cancel_all();
                }
                state.mark_pending_tool_running(&tool_call.id);
                let runtime_policy = tool_runtime_policy_payload(context, &tool_call.name);
                state.emit_event(
                    "agent.tool.start",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                        "detailId": format!("tool:{}", tool_call.id),
                        "status": "running",
                        "parallelMode": parallel_mode,
                        "runtimePolicy": runtime_policy,
                    }),
                );
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
            }
            Some(ToolDispatchEvent::Finished { index, result }) => {
                if let Err(error) = owned_batch.finish(index).await {
                    state.clear_pending_tool_calls();
                    return tool_error_result(
                        services,
                        context,
                        state,
                        iteration,
                        tool_dispatch_outcome_tool_call(&result.outcome),
                        error,
                    );
                }
                finished_count += 1;
                indexed_results[index] = Some(result);
                if context_is_cancelled(context) {
                    terminal.try_claim_cancelled();
                    cancellation_terminal_claimed = true;
                    owned_batch.cancel_all();
                }
            }
            None => {
                state.clear_pending_tool_calls();
                return tool_error_result(
                    services,
                    context,
                    state,
                    iteration,
                    &NativeAgentToolCall {
                        id: "parallel-dispatch".to_string(),
                        name: "parallel-dispatch".to_string(),
                        arguments_json: "{}".to_string(),
                        result: Value::Null,
                    },
                    "native tool dispatch event channel closed before completion".to_string(),
                );
            }
        }
    }

    let indexed_results = indexed_results
        .into_iter()
        .map(|result| result.expect("tool dispatch should return one result per index"))
        .collect::<Vec<_>>();
    if let Some((timeout_index, timeout_sequence, tool_call, cancellation_mode, timeout_ms)) =
        indexed_results
            .iter()
            .enumerate()
            .filter_map(|(index, result)| match &result.outcome {
                ToolDispatchOutcome::CleanupTimedOut {
                    tool_call,
                    cancellation_mode,
                    timeout_ms,
                } => Some((
                    index,
                    result.sequence,
                    tool_call,
                    *cancellation_mode,
                    *timeout_ms,
                )),
                _ => None,
            })
            .min_by_key(|(index, _, _, _, _)| *index)
    {
        for (index, indexed_result) in indexed_results.iter().enumerate() {
            match &indexed_result.outcome {
                ToolDispatchOutcome::Success(success)
                    if indexed_result.sequence < timeout_sequence || index < timeout_index =>
                {
                    record_tool_success(
                        context,
                        state,
                        iteration,
                        success.tool_call.clone(),
                        success.result.clone(),
                    );
                }
                ToolDispatchOutcome::Failure {
                    tool_call, error, ..
                } => emit_late_terminal_debug(
                    context,
                    state,
                    iteration,
                    tool_call,
                    ToolBatchTerminalOutcome::Cancelled,
                    "cleanup_timeout_already_terminal",
                    Some(error),
                ),
                ToolDispatchOutcome::Cancelled { tool_call, .. }
                | ToolDispatchOutcome::Skipped { tool_call, .. } => emit_late_terminal_debug(
                    context,
                    state,
                    iteration,
                    tool_call,
                    ToolBatchTerminalOutcome::Cancelled,
                    "cleanup_timeout_already_terminal",
                    None,
                ),
                _ => {}
            }
        }
        state.clear_pending_tool_calls();
        return tool_cleanup_timeout_result(
            services,
            context,
            state,
            iteration,
            tool_call,
            cancellation_mode,
            timeout_ms,
        );
    }
    let terminal_result = match terminal.outcome() {
        Some(ToolBatchTerminalOutcome::Failed) => indexed_results
            .iter()
            .enumerate()
            .filter_map(|(index, result)| match &result.outcome {
                ToolDispatchOutcome::Failure {
                    tool_call, error, ..
                } => Some((
                    index,
                    result.sequence,
                    ToolBatchTerminalOutcome::Failed,
                    tool_call,
                    Some(error.as_str()),
                )),
                _ => None,
            })
            .min_by_key(|(index, _, _, _, _)| *index),
        Some(ToolBatchTerminalOutcome::Cancelled) => indexed_results
            .iter()
            .enumerate()
            .filter_map(|(index, result)| match &result.outcome {
                ToolDispatchOutcome::Cancelled { tool_call, .. } => Some((
                    index,
                    result.sequence,
                    ToolBatchTerminalOutcome::Cancelled,
                    tool_call,
                    None,
                )),
                _ => None,
            })
            .min_by_key(|(_, sequence, _, _, _)| *sequence),
        None => None,
    };

    if let Some((
        terminal_index,
        terminal_sequence,
        terminal_outcome,
        terminal_tool_call,
        terminal_error,
    )) = terminal_result
    {
        emit_pending_tool_hook_evaluations(context, state);
        for (index, indexed_result) in indexed_results.iter().enumerate() {
            match &indexed_result.outcome {
                ToolDispatchOutcome::Success(success)
                    if match terminal_outcome {
                        ToolBatchTerminalOutcome::Failed => index < terminal_index,
                        ToolBatchTerminalOutcome::Cancelled => {
                            indexed_result.sequence < terminal_sequence || index < terminal_index
                        }
                    } =>
                {
                    record_tool_success(
                        context,
                        state,
                        iteration,
                        success.tool_call.clone(),
                        success.result.clone(),
                    );
                }
                ToolDispatchOutcome::Failure {
                    tool_call, error, ..
                } => {
                    record_tool_failure(context, state, iteration, tool_call, error);
                    if index != terminal_index {
                        emit_late_terminal_debug(
                            context,
                            state,
                            iteration,
                            tool_call,
                            terminal_outcome,
                            "terminal_outcome_already_claimed",
                            Some(error),
                        );
                    }
                }
                ToolDispatchOutcome::Cancelled {
                    tool_call,
                    terminal: false,
                } => emit_late_terminal_debug(
                    context,
                    state,
                    iteration,
                    tool_call,
                    terminal_outcome,
                    "terminal_outcome_already_claimed",
                    None,
                ),
                ToolDispatchOutcome::Skipped {
                    tool_call,
                    terminal_outcome: skipped_terminal_outcome,
                } => emit_late_terminal_debug(
                    context,
                    state,
                    iteration,
                    tool_call,
                    *skipped_terminal_outcome,
                    "dispatch_skipped_after_terminal",
                    None,
                ),
                _ => {}
            }
        }
        state.clear_pending_tool_calls();
        return match terminal_outcome {
            ToolBatchTerminalOutcome::Failed => finish_tool_error_result(
                services,
                context,
                state,
                iteration,
                terminal_tool_call,
                terminal_error.unwrap_or("native tool failed").to_string(),
            ),
            ToolBatchTerminalOutcome::Cancelled => {
                cancelled_result(services, context, state, iteration)
            }
        };
    }

    for indexed_result in indexed_results {
        if let ToolDispatchOutcome::Success(success) = indexed_result.outcome {
            record_tool_success(context, state, iteration, success.tool_call, success.result);
        }
    }
    state.clear_pending_tool_calls();
    state.transition_phase(AgentRuntimePhase::Planning, iteration, "agent.tool.result");
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("tool_completed"),
    );
    if context_is_cancelled(context) {
        return cancelled_result(services, context, state, iteration);
    }
    NativeAgentToolExecutionOutcome::Continue
}

fn parallel_mode_for_tool_call(
    context: &NativeAgentRunContext,
    tool_call: &NativeAgentToolCall,
) -> &'static str {
    if native_tool_call_supports_parallel(context, tool_call) {
        "read"
    } else {
        "write"
    }
}

fn tool_runtime_policy_payload(context: &NativeAgentRunContext, tool_name: &str) -> Value {
    let cancellation_mode = native_tool_cancellation_mode(context, tool_name);
    serde_json::json!({
        "waitsForRuntimeCancellation": native_tool_waits_for_runtime_cancellation(context, tool_name),
        "cancellationMode": cancellation_mode.as_str(),
        "cleanupTimeoutMs": native_tool_cleanup_timeout_ms(context, tool_name),
        "mutatesWorkspace": native_tool_mutates_workspace(context, tool_name),
        "mutatesSession": native_tool_mutates_session(context, tool_name),
    })
}

fn context_is_cancelled(context: &NativeAgentRunContext) -> bool {
    context
        .cancellation
        .as_ref()
        .is_some_and(|cancellation| cancellation.is_cancelled())
}

async fn wait_for_context_cancellation(context: &NativeAgentRunContext) {
    if let Some(cancellation) = context.cancellation.as_ref() {
        cancellation.cancelled().await;
    } else {
        std::future::pending::<()>().await;
    }
}

fn emit_late_terminal_debug(
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    terminal_outcome: ToolBatchTerminalOutcome,
    ignored_reason: &str,
    error: Option<&str>,
) {
    state.emit_event(
        "agent.tool.debug",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "ignoredReason": ignored_reason,
            "terminalOutcome": terminal_outcome.as_str(),
            "error": error,
        }),
    );
}

fn tool_dispatch_outcome_tool_call(outcome: &ToolDispatchOutcome) -> &NativeAgentToolCall {
    match outcome {
        ToolDispatchOutcome::Success(success) => &success.tool_call,
        ToolDispatchOutcome::Failure { tool_call, .. }
        | ToolDispatchOutcome::Cancelled { tool_call, .. }
        | ToolDispatchOutcome::CleanupTimedOut { tool_call, .. }
        | ToolDispatchOutcome::Skipped { tool_call, .. } => tool_call,
    }
}

fn send_tool_dispatch_finished(
    sender: &mpsc::UnboundedSender<ToolDispatchEvent>,
    finish_sequence: &AtomicUsize,
    index: usize,
    result: ToolDispatchOutcome,
) {
    let sequence = finish_sequence.fetch_add(1, Ordering::AcqRel);
    let _ = sender.send(ToolDispatchEvent::Finished {
        index,
        result: SequencedToolDispatchOutcome {
            sequence,
            outcome: result,
        },
    });
}

fn start_tool_call(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
) {
    state.tools_used.push(tool_call.name.clone());
    state.transition_phase(
        AgentRuntimePhase::ToolRunning,
        iteration,
        "agent.tool.start",
    );
    state.emit_event(
        "agent.tool.start",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "status": "running",
        }),
    );
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
}

fn record_tool_success(
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: NativeAgentToolCall,
    result: super::NativeAgentToolResult,
) {
    emit_pending_tool_hook_evaluations(context, state);
    let result = normalize_tool_result_for_context(result, context);
    let observation_content = tool_observation_content(&result);
    let completed_result = completed_tool_result_entry(&tool_call, &result);
    state
        .history
        .record_message(tool_observation_message(&tool_call, &observation_content))
        .expect("runtime-generated tool observation message must be valid");
    state.emit_event(
        "agent.tool.result",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "status": "completed",
            "resultStatus": result.envelope.get("status").cloned().unwrap_or_else(|| serde_json::json!("ok")),
            "summary": result.envelope.get("summary").cloned().unwrap_or_else(|| Value::String(observation_content.clone())),
            "timing": {
                "durationMs": result
                    .envelope
                    .get("metrics")
                    .and_then(|metrics| metrics.get("durationMs"))
                    .cloned()
                    .unwrap_or(Value::Null),
            },
            "content": observation_content,
            "envelope": result.envelope.clone(),
        }),
    );
    if let Some(link_event) = subagent_link_event_from_tool_result(context, &tool_call, &result) {
        state.emit_native_event(link_event);
    }
    for event in subagent_activity_events_from_tool_result(context, &tool_call, &result) {
        if event.event_name == "agent.delegate.wait" {
            state.transition_phase(
                AgentRuntimePhase::AwaitingSubagent,
                iteration,
                "agent.delegate.wait",
            );
        }
        state.emit_native_event(event);
    }
    state.completed_tool_results.push(completed_result);
}

fn record_tool_failure(
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    error: &str,
) {
    let result = super::NativeAgentToolResult::generic_error(tool_call, error.to_string());
    let observation_content = tool_observation_content(&result);
    let completed_result = completed_tool_result_entry(tool_call, &result);
    state
        .history
        .record_message(tool_error_observation_message(
            tool_call,
            &observation_content,
        ))
        .expect("runtime-generated tool error observation message must be valid");
    state.emit_event(
        "agent.tool.result",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "detailId": format!("tool:{}", tool_call.id),
            "status": "completed",
            "resultStatus": result.envelope.get("status").cloned().unwrap_or_else(|| serde_json::json!("error")),
            "summary": result.envelope.get("summary").cloned().unwrap_or_else(|| Value::String(observation_content.clone())),
            "content": observation_content,
            "envelope": result.envelope.clone(),
        }),
    );
    state.completed_tool_results.push(completed_result);
}

fn policy_denied_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
) -> NativeAgentToolExecutionOutcome {
    emit_pending_tool_hook_evaluations(context, state);
    let error = format!(
        "native tool `{}` is not permitted by Rust capability policy",
        tool_call.name
    );
    record_tool_failure(context, state, iteration, tool_call, &error);
    state.set_stop_reason("policy_denied", iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": "policy_denied",
            "error": error,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
        }),
    );
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    NativeAgentToolExecutionOutcome::Finished(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "policy_denied",
        "messages": [],
        "toolsUsed": state.tools_used,
        "completedToolResults": state.completed_tool_results,
        "error": error,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}

fn tool_error_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    error: String,
) -> NativeAgentToolExecutionOutcome {
    emit_pending_tool_hook_evaluations(context, state);
    record_tool_failure(context, state, iteration, tool_call, &error);
    finish_tool_error_result(services, context, state, iteration, tool_call, error)
}

fn finish_tool_error_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    error: String,
) -> NativeAgentToolExecutionOutcome {
    state.set_stop_reason("tool_error", iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": "tool_error",
            "error": error,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
        }),
    );
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    NativeAgentToolExecutionOutcome::Finished(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "tool_error",
        "messages": [],
        "toolsUsed": state.tools_used,
        "completedToolResults": state.completed_tool_results,
        "error": error,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}

fn tool_cleanup_timeout_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
    cancellation_mode: ToolCancellationMode,
    timeout_ms: u64,
) -> NativeAgentToolExecutionOutcome {
    emit_pending_tool_hook_evaluations(context, state);
    let error = format!(
        "native tool `{}` cleanup exceeded {} ms for cancellation mode `{}`",
        tool_call.name,
        timeout_ms,
        cancellation_mode.as_str()
    );
    record_tool_failure(context, state, iteration, tool_call, &error);
    state.set_stop_reason(
        "tool_cleanup_timeout",
        iteration,
        "agent.tool.cleanup_timeout",
    );
    state.emit_event(
        "agent.tool.cleanup_timeout",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": "tool_cleanup_timeout",
            "error": error,
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "name": tool_call.name,
            "cancellationMode": cancellation_mode.as_str(),
            "timeoutMs": timeout_ms,
        }),
    );
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    NativeAgentToolExecutionOutcome::Finished(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "tool_cleanup_timeout",
        "messages": [],
        "toolsUsed": state.tools_used,
        "completedToolResults": state.completed_tool_results,
        "error": error,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}

fn cancelled_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
) -> NativeAgentToolExecutionOutcome {
    emit_pending_tool_hook_evaluations(context, state);
    state.transition_phase(AgentRuntimePhase::Cancelled, iteration, "agent.cancelled");
    NativeAgentToolExecutionOutcome::Finished(cancelled_run_result(
        services,
        context,
        state.take_runtime_events(),
        std::mem::take(&mut state.tools_used),
        std::mem::take(&mut state.completed_tool_results),
        iteration,
    ))
}

fn emit_pending_tool_hook_evaluations(
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
) {
    for (invocation, evaluation) in context.drain_hook_evaluations() {
        state.emit_hook_evaluation(&invocation, &evaluation);
    }
}

#[cfg(test)]
mod update_plan_tests {
    use super::*;

    #[test]
    fn update_plan_arguments_are_trimmed_and_typed() {
        let args = parse_update_plan_args(
            r#"{"explanation":"  Adjusted order  ","plan":[{"step":"  Inspect code  ","status":"in_progress"},{"step":"Run tests","status":"pending"}]}"#,
        )
        .expect("valid update_plan arguments should parse");

        assert_eq!(args.explanation.as_deref(), Some("Adjusted order"));
        assert_eq!(args.plan[0].step, "Inspect code");
        assert_eq!(
            args.plan[0].status,
            super::super::AgentPlanStepStatus::InProgress
        );
    }

    #[test]
    fn update_plan_rejects_invalid_execution_state() {
        for (arguments, expected) in [
            (
                r#"{"plan":[{"step":"One","status":"pending"}]}"#,
                "exactly one in_progress",
            ),
            (
                r#"{"plan":[{"step":"One","status":"in_progress"},{"step":"Two","status":"in_progress"}]}"#,
                "at most one step",
            ),
            (
                r#"{"plan":[{"step":"One","status":"in_progress"},{"step":"One","status":"pending"}]}"#,
                "duplicate step",
            ),
            (r#"{"plan":[],"ignored":true}"#, "unknown field"),
        ] {
            let error = parse_update_plan_args(arguments)
                .expect_err("invalid update_plan arguments should fail visibly");
            assert!(
                error.contains(expected),
                "expected `{expected}` in `{error}`"
            );
        }
    }
}
