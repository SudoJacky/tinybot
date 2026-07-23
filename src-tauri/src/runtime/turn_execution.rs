use futures_util::FutureExt;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
#[cfg(test)]
use std::panic::catch_unwind;
use std::panic::AssertUnwindSafe;
#[cfg(test)]
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
#[cfg(test)]
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StartAgentTurn {
    pub(crate) turn_id: String,
    pub(crate) session_id: String,
}

impl StartAgentTurn {
    pub(crate) fn new(turn_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            turn_id: turn_id.into(),
            session_id: session_id.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AgentCancelReason {
    UserRequested,
    Shutdown,
}

impl AgentCancelReason {
    fn as_str(&self) -> &'static str {
        match self {
            Self::UserRequested => "user_requested",
            Self::Shutdown => "shutdown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnExecutionStatus {
    pub(crate) turn_id: String,
    pub(crate) session_id: String,
    pub(crate) generation: u64,
    pub(crate) phase: String,
    pub(crate) active: bool,
    pub(crate) cancellation_requested: bool,
    pub(crate) cancellation_reason: Option<String>,
    pub(crate) pause_requested: bool,
    pub(crate) checkpoint_ref: Option<String>,
    pub(crate) terminal_outcome: Option<String>,
    pub(crate) late_results_ignored: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelOutcome {
    pub(crate) turn_id: String,
    pub(crate) state: String,
    pub(crate) reason: String,
    pub(crate) active_task_removed: bool,
    pub(crate) cleanup_pending: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PauseOutcome {
    pub(crate) turn_id: String,
    pub(crate) state: String,
    pub(crate) command_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShutdownReport {
    pub(crate) cancelled_turns: Vec<String>,
    pub(crate) cleanup_pending_turns: Vec<String>,
    pub(crate) timed_out: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TurnExecutionError {
    message: String,
}

impl TurnExecutionError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for TurnExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Clone)]
pub(crate) struct TurnExecutionRuntime {
    inner: Arc<TurnExecutionRuntimeInner>,
}

struct TurnExecutionRuntimeInner {
    state: Mutex<TurnExecutionRuntimeState>,
    task_finished: Condvar,
}

struct TurnExecutionRuntimeState {
    accepting: bool,
    active: HashMap<String, OwnedTurnExecution>,
    draining: HashMap<TurnExecutionKey, OwnedTurnExecution>,
    statuses: HashMap<String, TurnExecutionStatus>,
    terminal_results: HashMap<String, Result<Value, String>>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TurnExecutionKey {
    turn_id: String,
    generation: u64,
}

#[derive(Clone)]
struct OwnedTurnExecution {
    request: StartAgentTurn,
    generation: u64,
    cancellation: CancellationToken,
    pause: Arc<TurnPauseControl>,
    completion: Arc<TurnExecutionCompletion>,
    execution: OwnedExecutionHandle,
    prior_waiting_phase: Option<String>,
    prior_checkpoint_ref: Option<String>,
}

#[derive(Default)]
struct TurnPauseControl {
    state: Mutex<AgentPauseState>,
    changed: Notify,
}

#[derive(Default)]
struct AgentPauseState {
    requested: bool,
    paused: bool,
    pause_command_id: Option<String>,
    resume_command_id: Option<String>,
}

#[derive(Clone)]
enum OwnedExecutionHandle {
    #[cfg(test)]
    Blocking(Arc<Mutex<Option<JoinHandle<()>>>>),
    Async(Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>),
}

#[derive(Clone, Copy)]
enum AsyncTaskCancellation {
    #[cfg(test)]
    Immediate,
    Cooperative {
        grace: Duration,
    },
}

impl OwnedExecutionHandle {
    #[cfg(test)]
    fn blocking() -> Self {
        Self::Blocking(Arc::new(Mutex::new(None)))
    }

    fn asynchronous() -> Self {
        Self::Async(Arc::new(Mutex::new(None)))
    }

    fn supports_cooperative_cancellation(&self) -> bool {
        match self {
            Self::Async(_) => true,
            #[cfg(test)]
            Self::Blocking(_) => false,
        }
    }

    #[cfg(test)]
    fn store_blocking(&self, handle: JoinHandle<()>) {
        let Self::Blocking(slot) = self else {
            unreachable!("blocking agent task must own a thread handle");
        };
        *slot
            .lock()
            .expect("agent task thread handle lock should not be poisoned") = Some(handle);
    }

    fn store_async(&self, handle: tauri::async_runtime::JoinHandle<()>) {
        let slot = match self {
            Self::Async(slot) => slot,
            #[cfg(test)]
            Self::Blocking(_) => unreachable!("async agent task must own an async handle"),
        };
        *slot
            .lock()
            .expect("agent task async handle lock should not be poisoned") = Some(handle);
    }
}

struct TurnExecutionCompletion {
    result: Mutex<Option<Result<Value, String>>>,
    #[cfg(test)]
    ready: Condvar,
    async_ready: Notify,
}

impl TurnExecutionCompletion {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            #[cfg(test)]
            ready: Condvar::new(),
            async_ready: Notify::new(),
        }
    }

    fn complete(&self, result: Result<Value, String>) -> bool {
        let mut completion = self
            .result
            .lock()
            .expect("agent task completion lock should not be poisoned");
        if completion.is_some() {
            return false;
        }
        *completion = Some(result);
        #[cfg(test)]
        self.ready.notify_all();
        self.async_ready.notify_one();
        true
    }

    #[cfg(test)]
    fn wait(&self) -> Result<Value, String> {
        let mut completion = self
            .result
            .lock()
            .expect("agent task completion lock should not be poisoned");
        while completion.is_none() {
            completion = self
                .ready
                .wait(completion)
                .expect("agent task completion lock should not be poisoned");
        }
        completion
            .as_ref()
            .expect("agent task completion was checked")
            .clone()
    }

    async fn wait_async(&self) -> Result<Value, String> {
        loop {
            let notified = self.async_ready.notified();
            if let Some(result) = self
                .result
                .lock()
                .expect("agent task completion lock should not be poisoned")
                .clone()
            {
                return result;
            }
            notified.await;
        }
    }
}

impl Default for TurnExecutionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl TurnExecutionRuntime {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(TurnExecutionRuntimeInner {
                state: Mutex::new(TurnExecutionRuntimeState {
                    accepting: true,
                    active: HashMap::new(),
                    draining: HashMap::new(),
                    statuses: HashMap::new(),
                    terminal_results: HashMap::new(),
                }),
                task_finished: Condvar::new(),
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn start_blocking<F>(
        &self,
        request: StartAgentTurn,
        operation: F,
    ) -> Result<AgentTurnHandle, TurnExecutionError>
    where
        F: FnOnce() -> Result<Value, String> + Send + 'static,
    {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        let task = register_turn_execution(&mut state, request, OwnedExecutionHandle::blocking())?;
        let request = task.request.clone();
        let generation = task.generation;

        let inner = self.inner.clone();
        let thread_task = task.clone();
        let (start_sender, start_receiver) = mpsc::sync_channel(0);
        let thread_name = turn_execution_thread_name(&request.turn_id);
        let join_handle = match thread::Builder::new().name(thread_name).spawn(move || {
            if start_receiver.recv().is_err() {
                finish_turn_execution(
                    &inner,
                    &thread_task,
                    Err("agent task start barrier closed before execution".to_string()),
                );
                return;
            }
            let result = match catch_unwind(AssertUnwindSafe(operation)) {
                Ok(result) => result,
                Err(_) => Err("agent task panicked during execution".to_string()),
            };
            finish_turn_execution(&inner, &thread_task, result);
        }) {
            Ok(handle) => handle,
            Err(error) => {
                state.active.remove(&request.turn_id);
                state.statuses.remove(&request.turn_id);
                return Err(TurnExecutionError::new(format!(
                    "failed to spawn agent turn `{}`: {error}",
                    request.turn_id
                )));
            }
        };
        task.execution.store_blocking(join_handle);
        start_sender.send(()).map_err(|_| {
            state.active.remove(&request.turn_id);
            state.statuses.remove(&request.turn_id);
            TurnExecutionError::new(format!(
                "failed to release agent turn `{}` start barrier",
                request.turn_id
            ))
        })?;
        drop(state);

        Ok(AgentTurnHandle {
            runtime: self.clone(),
            request,
            generation,
            completion: task.completion,
        })
    }

    #[cfg(test)]
    pub(crate) fn start_async<Fut>(
        &self,
        request: StartAgentTurn,
        operation: Fut,
    ) -> Result<AgentTurnHandle, TurnExecutionError>
    where
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        self.start_async_with_cancellation(request, operation, AsyncTaskCancellation::Immediate)
    }

    pub(crate) fn start_cooperative_async<Fut>(
        &self,
        request: StartAgentTurn,
        cancellation_grace: Duration,
        operation: Fut,
    ) -> Result<AgentTurnHandle, TurnExecutionError>
    where
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        self.start_async_with_cancellation(
            request,
            operation,
            AsyncTaskCancellation::Cooperative {
                grace: cancellation_grace,
            },
        )
    }

    fn start_async_with_cancellation<Fut>(
        &self,
        request: StartAgentTurn,
        operation: Fut,
        cancellation_mode: AsyncTaskCancellation,
    ) -> Result<AgentTurnHandle, TurnExecutionError>
    where
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        let task =
            register_turn_execution(&mut state, request, OwnedExecutionHandle::asynchronous())?;
        let request = task.request.clone();
        let generation = task.generation;
        let cancellation = task.cancellation.clone();
        let inner = self.inner.clone();
        let async_task = task.clone();
        let join_handle = tauri::async_runtime::spawn(async move {
            let result = {
                let operation = AssertUnwindSafe(operation).catch_unwind();
                tokio::pin!(operation);
                match cancellation_mode {
                    #[cfg(test)]
                    AsyncTaskCancellation::Immediate => {
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => None,
                            result = &mut operation => Some(async_operation_result(result)),
                        }
                    }
                    AsyncTaskCancellation::Cooperative { grace } => {
                        tokio::select! {
                            biased;
                            result = &mut operation => Some(async_operation_result(result)),
                            _ = cancellation.cancelled() => {
                                let cleanup_started = Instant::now();
                                let result = match tokio::time::timeout(grace, &mut operation).await {
                                    Ok(result) => async_operation_result(result),
                                    Err(_) => Ok(cancellation_cleanup_timeout_result(
                                        &async_task.request,
                                        grace,
                                    )),
                                };
                                let metrics = crate::runtime::observability::global_agent_runtime_metrics();
                                metrics.record_duration(
                                    "cancellation.cleanup.durationMs",
                                    cleanup_started.elapsed(),
                                );
                                metrics.increment(if result.as_ref().is_ok_and(|value| {
                                    value.get("stopReason").and_then(Value::as_str)
                                        == Some("cancellation_cleanup_timeout")
                                }) {
                                    "cancellation.cleanup.timed_out"
                                } else {
                                    "cancellation.cleanup.completed"
                                });
                                Some(result)
                            }
                        }
                    }
                }
            };
            if let Some(result) = result {
                finish_turn_execution(&inner, &async_task, result);
            } else {
                finish_cancelled_turn_execution(&inner, &async_task);
            }
        });
        task.execution.store_async(join_handle);
        drop(state);

        Ok(AgentTurnHandle {
            runtime: self.clone(),
            request,
            generation,
            completion: task.completion,
        })
    }

    pub(crate) fn request_pause(
        &self,
        turn_id: &str,
        command_id: &str,
    ) -> Result<PauseOutcome, TurnExecutionError> {
        let turn_id = turn_id.trim();
        let command_id = command_id.trim();
        if command_id.is_empty() {
            return Err(TurnExecutionError::new(
                "agent pause command ID must not be empty",
            ));
        }
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        let pause = state
            .active
            .get(turn_id)
            .map(|task| task.pause.clone())
            .ok_or_else(|| {
                TurnExecutionError::new(format!("active agent turn `{turn_id}` was not found"))
            })?;
        let status = state.statuses.get_mut(turn_id).ok_or_else(|| {
            TurnExecutionError::new(format!("agent turn `{turn_id}` status disappeared"))
        })?;
        if !status.active {
            return Err(TurnExecutionError::new(format!(
                "agent turn `{turn_id}` completed before pause could be requested"
            )));
        }
        if status.cancellation_requested {
            return Err(TurnExecutionError::new(format!(
                "agent turn `{turn_id}` is already cancelling"
            )));
        }
        let mut pause_state = pause
            .state
            .lock()
            .expect("agent pause state lock should not be poisoned");
        if pause_state.requested {
            return Err(TurnExecutionError::new(format!(
                "agent turn `{turn_id}` already has a pending pause"
            )));
        }
        pause_state.requested = true;
        pause_state.pause_command_id = Some(command_id.to_string());
        pause_state.resume_command_id = None;
        status.phase = "pause_requested".to_string();
        status.pause_requested = true;
        Ok(PauseOutcome {
            turn_id: turn_id.to_string(),
            state: "pause_requested".to_string(),
            command_id: command_id.to_string(),
        })
    }

    pub(crate) fn request_resume(
        &self,
        turn_id: &str,
        command_id: &str,
    ) -> Result<PauseOutcome, TurnExecutionError> {
        let turn_id = turn_id.trim();
        let command_id = command_id.trim();
        if command_id.is_empty() {
            return Err(TurnExecutionError::new(
                "agent resume command ID must not be empty",
            ));
        }
        let pause = {
            let state = self
                .inner
                .state
                .lock()
                .expect("agent task runtime state lock should not be poisoned");
            state
                .active
                .get(turn_id)
                .map(|task| task.pause.clone())
                .ok_or_else(|| {
                    TurnExecutionError::new(format!("paused agent turn `{turn_id}` was not found"))
                })?
        };
        {
            let mut pause_state = pause
                .state
                .lock()
                .expect("agent pause state lock should not be poisoned");
            if !pause_state.requested || !pause_state.paused {
                return Err(TurnExecutionError::new(format!(
                    "agent turn `{turn_id}` has not reached a paused boundary"
                )));
            }
            pause_state.requested = false;
            pause_state.resume_command_id = Some(command_id.to_string());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        let status = state.statuses.get_mut(turn_id).ok_or_else(|| {
            TurnExecutionError::new(format!("agent turn `{turn_id}` status disappeared"))
        })?;
        status.phase = "resuming".to_string();
        status.pause_requested = false;
        pause.changed.notify_waiters();
        Ok(PauseOutcome {
            turn_id: turn_id.to_string(),
            state: "resume_requested".to_string(),
            command_id: command_id.to_string(),
        })
    }

    pub(crate) fn begin_pause(&self, turn_id: &str) -> Option<String> {
        let pause = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .active
            .get(turn_id)
            .map(|task| task.pause.clone())?;
        let command_id = {
            let mut pause_state = pause
                .state
                .lock()
                .expect("agent pause state lock should not be poisoned");
            if !pause_state.requested || pause_state.paused {
                return None;
            }
            pause_state.paused = true;
            pause_state.pause_command_id.clone()?
        };
        if let Some(status) = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .statuses
            .get_mut(turn_id)
        {
            status.phase = "paused".to_string();
            status.pause_requested = true;
        }
        Some(command_id)
    }

    pub(crate) async fn wait_for_resume(
        &self,
        turn_id: &str,
    ) -> Result<String, TurnExecutionError> {
        let pause = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .active
            .get(turn_id)
            .map(|task| task.pause.clone())
            .ok_or_else(|| {
                TurnExecutionError::new(format!("paused agent turn `{turn_id}` was not found"))
            })?;
        loop {
            let changed = pause.changed.notified();
            if let Some(command_id) = {
                let mut pause_state = pause
                    .state
                    .lock()
                    .expect("agent pause state lock should not be poisoned");
                if pause_state.requested {
                    None
                } else {
                    pause_state.paused = false;
                    pause_state.pause_command_id = None;
                    pause_state.resume_command_id.take()
                }
            } {
                if let Some(status) = self
                    .inner
                    .state
                    .lock()
                    .expect("agent task runtime state lock should not be poisoned")
                    .statuses
                    .get_mut(turn_id)
                {
                    status.phase = "running".to_string();
                    status.pause_requested = false;
                }
                return Ok(command_id);
            }
            changed.await;
        }
    }

    pub(crate) fn request_cancel(&self, turn_id: &str, reason: AgentCancelReason) -> CancelOutcome {
        let turn_id = turn_id.trim();
        let reason_value = reason.as_str().to_string();
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        if state
            .active
            .get(turn_id)
            .is_some_and(|task| !task.execution.supports_cooperative_cancellation())
        {
            drop(state);
            return self.cancel(turn_id, reason);
        }
        if let Some(task) = state.active.get(turn_id) {
            task.cancellation.cancel();
            let status = state
                .statuses
                .get_mut(turn_id)
                .expect("active agent task must have a status");
            status.phase = "cancelling".to_string();
            status.cancellation_requested = true;
            status.cancellation_reason = Some(reason_value.clone());
            status.checkpoint_ref = None;
            self.inner.task_finished.notify_all();
            return CancelOutcome {
                turn_id: turn_id.to_string(),
                state: "cancel_requested".to_string(),
                reason: reason_value,
                active_task_removed: false,
                cleanup_pending: true,
            };
        }
        drop(state);
        self.cancel(turn_id, reason)
    }

    pub(crate) fn cancel(&self, turn_id: &str, reason: AgentCancelReason) -> CancelOutcome {
        let turn_id = turn_id.trim();
        let reason_value = reason.as_str().to_string();
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        if let Some(task) = state.active.remove(turn_id) {
            task.cancellation.cancel();
            let key = TurnExecutionKey {
                turn_id: turn_id.to_string(),
                generation: task.generation,
            };
            let status = state
                .statuses
                .get_mut(turn_id)
                .expect("active agent task must have a status");
            status.phase = "cancelled".to_string();
            status.active = false;
            status.cancellation_requested = true;
            status.cancellation_reason = Some(reason_value.clone());
            status.checkpoint_ref = None;
            status.terminal_outcome = Some("cancelled".to_string());
            let cancelled_result = cancelled_task_result(&task.request, &reason_value);
            state
                .terminal_results
                .insert(turn_id.to_string(), Ok(cancelled_result.clone()));
            task.completion.complete(Ok(cancelled_result));
            state.draining.insert(key, task);
            self.inner.task_finished.notify_all();
            return CancelOutcome {
                turn_id: turn_id.to_string(),
                state: "cancel_requested".to_string(),
                reason: reason_value,
                active_task_removed: true,
                cleanup_pending: true,
            };
        }

        let Some(status) = state.statuses.get_mut(turn_id) else {
            return CancelOutcome {
                turn_id: turn_id.to_string(),
                state: "not_found".to_string(),
                reason: reason_value,
                active_task_removed: false,
                cleanup_pending: false,
            };
        };
        if status.terminal_outcome.is_some() {
            return CancelOutcome {
                turn_id: turn_id.to_string(),
                state: "already_terminal".to_string(),
                reason: status.cancellation_reason.clone().unwrap_or(reason_value),
                active_task_removed: false,
                cleanup_pending: state.draining.keys().any(|key| key.turn_id == turn_id),
            };
        }

        status.phase = "cancelled".to_string();
        status.active = false;
        status.cancellation_requested = true;
        status.cancellation_reason = Some(reason_value.clone());
        status.checkpoint_ref = None;
        status.terminal_outcome = Some("cancelled".to_string());
        let request = StartAgentTurn::new(status.turn_id.clone(), status.session_id.clone());
        state.terminal_results.insert(
            turn_id.to_string(),
            Ok(cancelled_task_result(&request, &reason_value)),
        );
        CancelOutcome {
            turn_id: turn_id.to_string(),
            state: "cancelled_waiting".to_string(),
            reason: reason_value,
            active_task_removed: false,
            cleanup_pending: false,
        }
    }

    pub(crate) fn status(&self, turn_id: &str) -> Option<TurnExecutionStatus> {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .statuses
            .get(turn_id)
            .cloned()
    }

    pub(crate) fn terminal_result(&self, turn_id: &str) -> Option<Result<Value, String>> {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .terminal_results
            .get(turn_id)
            .cloned()
    }

    pub(crate) fn is_cancelled(&self, turn_id: &str) -> bool {
        let state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        state
            .active
            .get(turn_id)
            .is_some_and(|task| task.cancellation.is_cancelled())
            || state
                .draining
                .iter()
                .any(|(key, task)| key.turn_id == turn_id && task.cancellation.is_cancelled())
            || state
                .statuses
                .get(turn_id)
                .is_some_and(|status| status.cancellation_requested)
    }

    pub(crate) fn cancellation_token(&self, turn_id: &str) -> Option<CancellationToken> {
        let state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        state
            .active
            .get(turn_id)
            .or_else(|| {
                state
                    .draining
                    .iter()
                    .find(|(key, _)| key.turn_id == turn_id)
                    .map(|(_, task)| task)
            })
            .map(|task| task.cancellation.clone())
    }

    pub(crate) fn is_accepting(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .accepting
    }

    pub(crate) fn active_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .active
            .len()
    }

    pub(crate) fn draining_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .draining
            .len()
    }

    pub(crate) fn shutdown(&self, timeout: Duration) -> ShutdownReport {
        let active_turn_ids = {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("agent task runtime state lock should not be poisoned");
            state.accepting = false;
            let mut turn_ids = state.active.keys().cloned().collect::<Vec<_>>();
            turn_ids.sort();
            turn_ids
        };
        for turn_id in &active_turn_ids {
            self.request_cancel(turn_id, AgentCancelReason::Shutdown);
        }

        let deadline = Instant::now() + timeout;
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        while !state.active.is_empty() || !state.draining.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(now);
            let (updated, wait_result) = self
                .inner
                .task_finished
                .wait_timeout(state, remaining)
                .expect("agent task runtime state lock should not be poisoned");
            state = updated;
            if wait_result.timed_out() {
                break;
            }
        }
        let mut cleanup_pending_turns = state
            .active
            .keys()
            .cloned()
            .chain(state.draining.keys().map(|key| key.turn_id.clone()))
            .collect::<Vec<_>>();
        cleanup_pending_turns.sort();
        cleanup_pending_turns.dedup();
        ShutdownReport {
            cancelled_turns: active_turn_ids,
            timed_out: !cleanup_pending_turns.is_empty(),
            cleanup_pending_turns,
        }
    }

    pub(crate) fn resume_accepting(&self) {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .accepting = true;
    }

    pub(crate) fn pause_accepting(&self) {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .accepting = false;
    }
}

pub(crate) struct AgentTurnHandle {
    runtime: TurnExecutionRuntime,
    request: StartAgentTurn,
    generation: u64,
    completion: Arc<TurnExecutionCompletion>,
}

impl fmt::Debug for AgentTurnHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentTurnHandle")
            .field("turn_id", &self.request.turn_id)
            .field("session_id", &self.request.session_id)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl AgentTurnHandle {
    #[cfg(test)]
    pub(crate) fn wait(self) -> Result<Value, String> {
        self.completion.wait()
    }

    pub(crate) async fn wait_async(self) -> Result<Value, String> {
        self.completion.wait_async().await
    }

    pub(crate) fn turn_id(&self) -> &str {
        &self.request.turn_id
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.request.session_id
    }

    pub(crate) fn status(&self) -> Option<TurnExecutionStatus> {
        self.runtime.status(&self.request.turn_id)
    }
}

fn validate_start_request(request: StartAgentTurn) -> Result<StartAgentTurn, TurnExecutionError> {
    let turn_id = request.turn_id.trim();
    let session_id = request.session_id.trim();
    if turn_id.is_empty() {
        return Err(TurnExecutionError::new("agent turn ID must not be empty"));
    }
    if session_id.is_empty() {
        return Err(TurnExecutionError::new(
            "agent session ID must not be empty",
        ));
    }
    Ok(StartAgentTurn::new(turn_id, session_id))
}

fn register_turn_execution(
    state: &mut TurnExecutionRuntimeState,
    request: StartAgentTurn,
    execution: OwnedExecutionHandle,
) -> Result<OwnedTurnExecution, TurnExecutionError> {
    let request = validate_start_request(request)?;
    if !state.accepting {
        return Err(TurnExecutionError::new(
            "agent task runtime is not accepting new turns",
        ));
    }
    if state.active.contains_key(&request.turn_id) {
        return Err(TurnExecutionError::new(format!(
            "agent turn `{}` is already active",
            request.turn_id
        )));
    }
    if state
        .statuses
        .get(&request.turn_id)
        .and_then(|status| status.terminal_outcome.as_ref())
        .is_some()
    {
        return Err(TurnExecutionError::new(format!(
            "agent turn `{}` is already terminal",
            request.turn_id
        )));
    }

    let generation = state
        .statuses
        .get(&request.turn_id)
        .map(|status| status.generation.saturating_add(1))
        .unwrap_or(1);
    let prior_late_results = state
        .statuses
        .get(&request.turn_id)
        .map(|status| status.late_results_ignored)
        .unwrap_or(0);
    let prior_waiting_phase = state.statuses.get(&request.turn_id).and_then(|status| {
        matches!(
            status.phase.as_str(),
            "awaiting_approval" | "awaiting_form" | "awaiting_tool" | "awaiting_subagent"
        )
        .then(|| status.phase.clone())
    });
    let prior_checkpoint_ref = state
        .statuses
        .get(&request.turn_id)
        .and_then(|status| status.checkpoint_ref.clone());
    let task = OwnedTurnExecution {
        request: request.clone(),
        generation,
        cancellation: CancellationToken::new(),
        pause: Arc::new(TurnPauseControl::default()),
        completion: Arc::new(TurnExecutionCompletion::new()),
        execution,
        prior_waiting_phase,
        prior_checkpoint_ref,
    };
    state.statuses.insert(
        request.turn_id.clone(),
        TurnExecutionStatus {
            turn_id: request.turn_id.clone(),
            session_id: request.session_id.clone(),
            generation,
            phase: "running".to_string(),
            active: true,
            cancellation_requested: false,
            cancellation_reason: None,
            pause_requested: false,
            checkpoint_ref: None,
            terminal_outcome: None,
            late_results_ignored: prior_late_results,
        },
    );
    state.active.insert(request.turn_id.clone(), task.clone());
    Ok(task)
}

#[cfg(test)]
fn turn_execution_thread_name(turn_id: &str) -> String {
    let suffix = turn_id
        .chars()
        .take(32)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("tinybot-agent-{suffix}")
}

fn cancelled_task_result(request: &StartAgentTurn, reason: &str) -> Value {
    serde_json::json!({
        "runtime": "rust",
        "turnId": request.turn_id,
        "sessionId": request.session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "cancellationReason": reason,
        "checkpoint": {
            "schemaVersion": 1,
            "runtime": "rust",
            "turnId": request.turn_id,
            "sessionId": request.session_id,
            "phase": "cancelled",
            "resumeToken": null,
            "payload": {
                "cancelled": true,
                "reason": reason
            }
        },
        "messages": [],
        "toolsUsed": [],
        "events": [{
            "eventName": "agent.cancelled",
            "payload": {
                "turnId": request.turn_id,
                "sessionId": request.session_id,
                "cancelled": true,
                "stopReason": "cancelled",
                "reason": reason
            }
        }]
    })
}

fn cancellation_cleanup_timeout_result(request: &StartAgentTurn, grace: Duration) -> Value {
    serde_json::json!({
        "runtime": "rust",
        "turnId": request.turn_id,
        "sessionId": request.session_id,
        "finalContent": "",
        "stopReason": "cancellation_cleanup_timeout",
        "error": format!(
            "agent cancellation cleanup exceeded {} ms",
            grace.as_millis()
        ),
        "messages": [],
        "toolsUsed": [],
        "events": [{
            "eventName": "agent.cleanup_timeout",
            "payload": {
                "turnId": request.turn_id,
                "sessionId": request.session_id,
                "stopReason": "cancellation_cleanup_timeout",
                "timeoutMs": grace.as_millis(),
            }
        }]
    })
}

fn async_operation_result(
    result: Result<Result<Value, String>, Box<dyn std::any::Any + Send>>,
) -> Result<Value, String> {
    match result {
        Ok(result) => result,
        Err(_) => Err("agent task panicked during async execution".to_string()),
    }
}

fn finish_turn_execution(
    inner: &TurnExecutionRuntimeInner,
    task: &OwnedTurnExecution,
    result: Result<Value, String>,
) {
    let key = TurnExecutionKey {
        turn_id: task.request.turn_id.clone(),
        generation: task.generation,
    };
    let mut state = inner
        .state
        .lock()
        .expect("agent task runtime state lock should not be poisoned");
    let is_active_generation = state
        .active
        .get(&task.request.turn_id)
        .is_some_and(|active| active.generation == task.generation);
    if is_active_generation {
        state.active.remove(&task.request.turn_id);
    }
    state.draining.remove(&key);

    let status = state
        .statuses
        .get_mut(&task.request.turn_id)
        .expect("owned agent task must have a status");
    if status.generation != task.generation || status.terminal_outcome.is_some() {
        status.late_results_ignored = status.late_results_ignored.saturating_add(1);
    } else {
        apply_completion_status(task, status, &result);
        if status.terminal_outcome.is_some() {
            state
                .terminal_results
                .insert(task.request.turn_id.clone(), result.clone());
        }
        task.completion.complete(result);
    }
    inner.task_finished.notify_all();
}

fn finish_cancelled_turn_execution(inner: &TurnExecutionRuntimeInner, task: &OwnedTurnExecution) {
    let key = TurnExecutionKey {
        turn_id: task.request.turn_id.clone(),
        generation: task.generation,
    };
    let mut state = inner
        .state
        .lock()
        .expect("agent task runtime state lock should not be poisoned");
    if state
        .active
        .get(&task.request.turn_id)
        .is_some_and(|active| active.generation == task.generation)
    {
        state.active.remove(&task.request.turn_id);
    }
    state.draining.remove(&key);
    inner.task_finished.notify_all();
}

fn apply_completion_status(
    task: &OwnedTurnExecution,
    status: &mut TurnExecutionStatus,
    result: &Result<Value, String>,
) {
    status.active = false;
    status.checkpoint_ref = None;
    match result {
        Err(_) => {
            status.phase = task
                .prior_waiting_phase
                .clone()
                .unwrap_or_else(|| "attempt_failed".to_string());
            status.checkpoint_ref = task.prior_checkpoint_ref.clone();
            status.terminal_outcome = None;
        }
        Ok(result) => {
            let stop_reason = result
                .get("stopReason")
                .or_else(|| result.get("stop_reason"))
                .and_then(Value::as_str);
            match stop_reason {
                Some("final_response") => {
                    status.phase = "completed".to_string();
                    status.terminal_outcome = Some("completed".to_string());
                }
                Some("cancelled") => {
                    status.phase = "cancelled".to_string();
                    status.cancellation_requested = true;
                    status.terminal_outcome = Some("cancelled".to_string());
                }
                Some(
                    phase @ ("awaiting_approval" | "awaiting_form" | "awaiting_tool"
                    | "awaiting_subagent"),
                ) => {
                    status.phase = phase.to_string();
                    status.checkpoint_ref = result
                        .pointer("/checkpoint/resumeToken")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    status.terminal_outcome = None;
                }
                Some(_) | None => {
                    status.phase = "failed".to_string();
                    status.terminal_outcome = Some("failed".to_string());
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "turn_execution_tests.rs"]
mod tests;
