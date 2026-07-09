use super::checkpoint::save_phase_checkpoint;
use super::result::cancelled_run_result;
use super::state::NativeAgentRunState;
use super::tool_dispatcher::{
    native_tool_call_supports_parallel, native_tool_is_permitted, native_tool_mutates_session,
    native_tool_mutates_workspace, native_tool_waits_for_runtime_cancellation,
};
use super::tool_projection::{
    assistant_tool_calls_message, completed_tool_result_entry, normalize_tool_result_for_context,
    subagent_activity_events_from_tool_result, subagent_link_event_from_tool_result,
    tool_observation_content, tool_observation_message,
};
use super::{
    NativeAgentRunContext, NativeAgentRuntimeServices, NativeAgentToolCall,
    NativeAgentToolDispatcher,
};
use crate::agent_loop_runtime_protocol::AgentRuntimePhase;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

pub(super) enum NativeAgentToolExecutionOutcome {
    Continue,
    Finished(Value),
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
        terminal: bool,
    },
    Cancelled {
        tool_call: NativeAgentToolCall,
        terminal: bool,
    },
}

struct SequencedToolDispatchOutcome {
    sequence: usize,
    outcome: ToolDispatchOutcome,
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

#[derive(Clone, Copy, Eq, PartialEq)]
enum ToolBatchTerminalOutcome {
    Failed,
    Cancelled,
}

struct ToolBatchTerminal {
    outcome: AtomicU8,
}

impl ToolBatchTerminal {
    const NONE: u8 = 0;
    const FAILED: u8 = 1;
    const CANCELLED: u8 = 2;

    fn new() -> Self {
        Self {
            outcome: AtomicU8::new(Self::NONE),
        }
    }

    fn try_claim_failure(&self) -> bool {
        self.outcome
            .compare_exchange(
                Self::NONE,
                Self::FAILED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn try_claim_cancelled(&self) -> bool {
        self.outcome
            .compare_exchange(
                Self::NONE,
                Self::CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn outcome(&self) -> Option<ToolBatchTerminalOutcome> {
        match self.outcome.load(Ordering::Acquire) {
            Self::FAILED => Some(ToolBatchTerminalOutcome::Failed),
            Self::CANCELLED => Some(ToolBatchTerminalOutcome::Cancelled),
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

#[derive(Clone, Copy, Eq, PartialEq)]
enum ToolLockMode {
    Read,
    Write,
}

struct ToolReadWriteLock {
    state: Mutex<ToolReadWriteLockState>,
    available: Condvar,
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
            available: Condvar::new(),
        }
    }

    fn read(self: &Arc<Self>, index: usize) -> Result<ToolReadWriteGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("native tool scheduler lock poisoned: {error}"))?;
        while state.active_writer || state.pending_write_before(index) {
            state = self
                .available
                .wait(state)
                .map_err(|error| format!("native tool scheduler lock poisoned: {error}"))?;
        }
        state.pending.remove(&index);
        state.active_readers += 1;
        Ok(ToolReadWriteGuard {
            lock: self.clone(),
            mode: ToolLockMode::Read,
        })
    }

    fn write(self: &Arc<Self>, index: usize) -> Result<ToolReadWriteGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("native tool scheduler lock poisoned: {error}"))?;
        while state.active_writer || state.active_readers > 0 || state.pending_before(index) {
            state = self
                .available
                .wait(state)
                .map_err(|error| format!("native tool scheduler lock poisoned: {error}"))?;
        }
        state.pending.remove(&index);
        state.active_writer = true;
        Ok(ToolReadWriteGuard {
            lock: self.clone(),
            mode: ToolLockMode::Write,
        })
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
        self.lock.available.notify_all();
    }
}

pub(super) fn execute_tool_calls_for_iteration(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
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
        .messages
        .push(assistant_tool_calls_message(&final_content, &tool_calls));

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

    if services.cancellations.is_cancelled(&context.run_id) {
        return cancelled_result(services, context, state, iteration);
    }

    if tool_calls.len() == 1 {
        execute_sequential_tool_batch(services, context, state, iteration, tool_calls)
    } else {
        execute_locked_tool_batch(services, context, state, iteration, tool_calls)
    }
}

fn execute_sequential_tool_batch(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_calls: Vec<NativeAgentToolCall>,
) -> NativeAgentToolExecutionOutcome {
    for tool_call in tool_calls {
        if services.cancellations.is_cancelled(&context.run_id) {
            return cancelled_result(services, context, state, iteration);
        }
        start_tool_call(services, context, state, iteration, &tool_call);
        let result = match dispatch_tool_blocking(
            services.tools.clone(),
            context.clone(),
            tool_call.clone(),
        ) {
            Ok(result) => result,
            Err(error) => {
                return tool_error_result(services, context, state, iteration, &tool_call, error);
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
        if services.cancellations.is_cancelled(&context.run_id) {
            return cancelled_result(services, context, state, iteration);
        }
    }
    NativeAgentToolExecutionOutcome::Continue
}

fn execute_locked_tool_batch(
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
    let (sender, receiver) = mpsc::channel();
    let terminal = Arc::new(ToolBatchTerminal::new());
    let finish_sequence = Arc::new(AtomicUsize::new(0));
    let task_count = tool_calls.len();
    for (index, tool_call) in tool_calls.into_iter().enumerate() {
        let dispatcher = services.tools.clone();
        let context = context.clone();
        let lock = scheduler_lock.clone();
        let sender = sender.clone();
        let terminal = terminal.clone();
        let finish_sequence = finish_sequence.clone();
        let supports_parallel = native_tool_call_supports_parallel(&context, &tool_call);
        let parallel_mode = if supports_parallel { "read" } else { "write" };
        tauri::async_runtime::spawn(async move {
            let result = if context_is_cancelled(&context) {
                let terminal = terminal.try_claim_cancelled();
                ToolDispatchOutcome::Cancelled {
                    tool_call,
                    terminal,
                }
            } else if supports_parallel {
                match lock.read(index) {
                    Ok(_guard) => {
                        if context_is_cancelled(&context) {
                            return send_tool_dispatch_finished(
                                sender,
                                finish_sequence,
                                index,
                                ToolDispatchOutcome::Cancelled {
                                    tool_call,
                                    terminal: terminal.try_claim_cancelled(),
                                },
                            );
                        }
                        let _ = sender.send(ToolDispatchEvent::Running {
                            tool_call: tool_call.clone(),
                            parallel_mode,
                        });
                        let dispatch_call = tool_call.clone();
                        match dispatcher.dispatch_async(context, dispatch_call).await {
                            Ok(result) => ToolDispatchOutcome::Success(ToolDispatchSuccess {
                                tool_call,
                                result,
                            }),
                            Err(error) => ToolDispatchOutcome::Failure {
                                tool_call,
                                error,
                                terminal: terminal.try_claim_failure(),
                            },
                        }
                    }
                    Err(error) => ToolDispatchOutcome::Failure {
                        tool_call,
                        error: format!(
                            "native tool scheduler read lock acquisition failed: {error}"
                        ),
                        terminal: terminal.try_claim_failure(),
                    },
                }
            } else {
                match lock.write(index) {
                    Ok(_guard) => {
                        if context_is_cancelled(&context) {
                            return send_tool_dispatch_finished(
                                sender,
                                finish_sequence,
                                index,
                                ToolDispatchOutcome::Cancelled {
                                    tool_call,
                                    terminal: terminal.try_claim_cancelled(),
                                },
                            );
                        }
                        let _ = sender.send(ToolDispatchEvent::Running {
                            tool_call: tool_call.clone(),
                            parallel_mode,
                        });
                        let dispatch_call = tool_call.clone();
                        match dispatcher.dispatch_async(context, dispatch_call).await {
                            Ok(result) => ToolDispatchOutcome::Success(ToolDispatchSuccess {
                                tool_call,
                                result,
                            }),
                            Err(error) => ToolDispatchOutcome::Failure {
                                tool_call,
                                error,
                                terminal: terminal.try_claim_failure(),
                            },
                        }
                    }
                    Err(error) => ToolDispatchOutcome::Failure {
                        tool_call,
                        error: format!(
                            "native tool scheduler write lock acquisition failed: {error}"
                        ),
                        terminal: terminal.try_claim_failure(),
                    },
                }
            };
            send_tool_dispatch_finished(sender, finish_sequence, index, result);
        });
    }
    drop(sender);

    let mut indexed_results = (0..task_count).map(|_| None).collect::<Vec<_>>();
    let mut finished_count = 0usize;
    let mut running_cleanup_tools = BTreeSet::<String>::new();
    let mut cancellation_terminal_claimed = false;
    while finished_count < task_count {
        if services.cancellations.is_cancelled(&context.run_id)
            && (terminal.try_claim_cancelled()
                || terminal.outcome() == Some(ToolBatchTerminalOutcome::Cancelled))
        {
            cancellation_terminal_claimed = true;
        }
        if cancellation_terminal_claimed && running_cleanup_tools.is_empty() {
            state.clear_pending_tool_calls();
            return cancelled_result(services, context, state, iteration);
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(ToolDispatchEvent::Running {
                tool_call,
                parallel_mode,
            }) => {
                if native_tool_waits_for_runtime_cancellation(context, &tool_call.name) {
                    running_cleanup_tools.insert(tool_call.id.clone());
                }
                if services.cancellations.is_cancelled(&context.run_id)
                    && (terminal.try_claim_cancelled()
                        || terminal.outcome() == Some(ToolBatchTerminalOutcome::Cancelled))
                {
                    cancellation_terminal_claimed = true;
                }
                if cancellation_terminal_claimed && running_cleanup_tools.is_empty() {
                    state.clear_pending_tool_calls();
                    return cancelled_result(services, context, state, iteration);
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
            Ok(ToolDispatchEvent::Finished { index, result }) => {
                finished_count += 1;
                if let Some(tool_call_id) = tool_dispatch_outcome_tool_call_id(&result.outcome) {
                    running_cleanup_tools.remove(tool_call_id);
                }
                indexed_results[index] = Some(result);
                if cancellation_terminal_claimed && running_cleanup_tools.is_empty() {
                    state.clear_pending_tool_calls();
                    return cancelled_result(services, context, state, iteration);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if services.cancellations.is_cancelled(&context.run_id)
                    && (terminal.try_claim_cancelled()
                        || terminal.outcome() == Some(ToolBatchTerminalOutcome::Cancelled))
                {
                    cancellation_terminal_claimed = true;
                }
                if cancellation_terminal_claimed && running_cleanup_tools.is_empty() {
                    state.clear_pending_tool_calls();
                    return cancelled_result(services, context, state, iteration);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
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
    let terminal_result = indexed_results
        .iter()
        .enumerate()
        .filter_map(|(index, result)| match &result.outcome {
            ToolDispatchOutcome::Failure {
                tool_call,
                error,
                terminal: true,
            } => Some((
                index,
                result.sequence,
                ToolBatchTerminalOutcome::Failed,
                tool_call,
                Some(error.as_str()),
            )),
            ToolDispatchOutcome::Cancelled {
                tool_call,
                terminal: true,
            } => Some((
                index,
                result.sequence,
                ToolBatchTerminalOutcome::Cancelled,
                tool_call,
                None,
            )),
            _ => None,
        })
        .min_by_key(|(_, sequence, _, _, _)| *sequence);

    if let Some((
        terminal_index,
        terminal_sequence,
        terminal_outcome,
        terminal_tool_call,
        terminal_error,
    )) = terminal_result
    {
        for (index, indexed_result) in indexed_results.iter().enumerate() {
            match &indexed_result.outcome {
                ToolDispatchOutcome::Success(success)
                    if indexed_result.sequence < terminal_sequence || index < terminal_index =>
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
                    tool_call,
                    error,
                    terminal: false,
                } => emit_late_terminal_debug(
                    context,
                    state,
                    iteration,
                    tool_call,
                    terminal_outcome,
                    "terminal_outcome_already_claimed",
                    Some(error),
                ),
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
                _ => {}
            }
        }
        state.clear_pending_tool_calls();
        return match terminal_outcome {
            ToolBatchTerminalOutcome::Failed => tool_error_result(
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
    if services.cancellations.is_cancelled(&context.run_id) {
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
    serde_json::json!({
        "waitsForRuntimeCancellation": native_tool_waits_for_runtime_cancellation(context, tool_name),
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

fn tool_dispatch_outcome_tool_call_id(outcome: &ToolDispatchOutcome) -> Option<&str> {
    match outcome {
        ToolDispatchOutcome::Success(success) => Some(&success.tool_call.id),
        ToolDispatchOutcome::Failure { tool_call, .. }
        | ToolDispatchOutcome::Cancelled { tool_call, .. } => Some(&tool_call.id),
    }
}

fn send_tool_dispatch_finished(
    sender: mpsc::Sender<ToolDispatchEvent>,
    finish_sequence: Arc<AtomicUsize>,
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

fn dispatch_tool_blocking(
    dispatcher: Arc<dyn NativeAgentToolDispatcher>,
    context: NativeAgentRunContext,
    tool_call: NativeAgentToolCall,
) -> Result<super::NativeAgentToolResult, String> {
    tauri::async_runtime::block_on(dispatcher.dispatch_async(context, tool_call))
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
    let result = normalize_tool_result_for_context(result, context);
    let observation_content = tool_observation_content(&result);
    let completed_result = completed_tool_result_entry(&tool_call, &result);
    state
        .messages
        .push(tool_observation_message(&tool_call, &observation_content));
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

fn policy_denied_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    tool_call: &NativeAgentToolCall,
) -> NativeAgentToolExecutionOutcome {
    let error = format!(
        "native tool `{}` is not permitted by Rust capability policy",
        tool_call.name
    );
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

fn cancelled_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
) -> NativeAgentToolExecutionOutcome {
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
