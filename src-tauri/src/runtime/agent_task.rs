use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StartAgentRun {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
}

impl StartAgentRun {
    pub(crate) fn new(run_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
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
pub(crate) struct AgentTaskStatus {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) generation: u64,
    pub(crate) phase: String,
    pub(crate) active: bool,
    pub(crate) cancellation_requested: bool,
    pub(crate) cancellation_reason: Option<String>,
    pub(crate) checkpoint_ref: Option<String>,
    pub(crate) terminal_outcome: Option<String>,
    pub(crate) late_results_ignored: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelOutcome {
    pub(crate) run_id: String,
    pub(crate) state: String,
    pub(crate) reason: String,
    pub(crate) active_task_removed: bool,
    pub(crate) cleanup_pending: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShutdownReport {
    pub(crate) cancelled_runs: Vec<String>,
    pub(crate) cleanup_pending_runs: Vec<String>,
    pub(crate) timed_out: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentTaskError {
    message: String,
}

impl AgentTaskError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for AgentTaskError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Clone)]
pub(crate) struct AgentTaskRuntime {
    inner: Arc<AgentTaskRuntimeInner>,
}

struct AgentTaskRuntimeInner {
    state: Mutex<AgentTaskRuntimeState>,
    task_finished: Condvar,
}

struct AgentTaskRuntimeState {
    accepting: bool,
    active: HashMap<String, OwnedRunTask>,
    draining: HashMap<AgentTaskKey, OwnedRunTask>,
    statuses: HashMap<String, AgentTaskStatus>,
    terminal_results: HashMap<String, Result<Value, String>>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AgentTaskKey {
    run_id: String,
    generation: u64,
}

#[derive(Clone)]
struct OwnedRunTask {
    request: StartAgentRun,
    generation: u64,
    cancellation: CancellationToken,
    completion: Arc<AgentTaskCompletion>,
    thread: Arc<Mutex<Option<JoinHandle<()>>>>,
    prior_waiting_phase: Option<String>,
    prior_checkpoint_ref: Option<String>,
}

struct AgentTaskCompletion {
    result: Mutex<Option<Result<Value, String>>>,
    ready: Condvar,
}

impl AgentTaskCompletion {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
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
        self.ready.notify_all();
        true
    }

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
}

impl Default for AgentTaskRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentTaskRuntime {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(AgentTaskRuntimeInner {
                state: Mutex::new(AgentTaskRuntimeState {
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

    pub(crate) fn start_blocking<F>(
        &self,
        request: StartAgentRun,
        operation: F,
    ) -> Result<AgentRunHandle, AgentTaskError>
    where
        F: FnOnce() -> Result<Value, String> + Send + 'static,
    {
        let request = validate_start_request(request)?;
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        if !state.accepting {
            return Err(AgentTaskError::new(
                "agent task runtime is not accepting new runs",
            ));
        }
        if state.active.contains_key(&request.run_id) {
            return Err(AgentTaskError::new(format!(
                "agent run `{}` is already active",
                request.run_id
            )));
        }
        if state
            .statuses
            .get(&request.run_id)
            .and_then(|status| status.terminal_outcome.as_ref())
            .is_some()
        {
            return Err(AgentTaskError::new(format!(
                "agent run `{}` is already terminal",
                request.run_id
            )));
        }

        let generation = state
            .statuses
            .get(&request.run_id)
            .map(|status| status.generation.saturating_add(1))
            .unwrap_or(1);
        let prior_late_results = state
            .statuses
            .get(&request.run_id)
            .map(|status| status.late_results_ignored)
            .unwrap_or(0);
        let prior_waiting_phase = state.statuses.get(&request.run_id).and_then(|status| {
            matches!(
                status.phase.as_str(),
                "awaiting_approval" | "awaiting_form" | "awaiting_tool" | "awaiting_subagent"
            )
            .then(|| status.phase.clone())
        });
        let prior_checkpoint_ref = state
            .statuses
            .get(&request.run_id)
            .and_then(|status| status.checkpoint_ref.clone());
        let task = OwnedRunTask {
            request: request.clone(),
            generation,
            cancellation: CancellationToken::new(),
            completion: Arc::new(AgentTaskCompletion::new()),
            thread: Arc::new(Mutex::new(None)),
            prior_waiting_phase,
            prior_checkpoint_ref,
        };
        state.statuses.insert(
            request.run_id.clone(),
            AgentTaskStatus {
                run_id: request.run_id.clone(),
                session_id: request.session_id.clone(),
                generation,
                phase: "running".to_string(),
                active: true,
                cancellation_requested: false,
                cancellation_reason: None,
                checkpoint_ref: None,
                terminal_outcome: None,
                late_results_ignored: prior_late_results,
            },
        );
        state.active.insert(request.run_id.clone(), task.clone());

        let inner = self.inner.clone();
        let thread_task = task.clone();
        let (start_sender, start_receiver) = mpsc::sync_channel(0);
        let thread_name = agent_task_thread_name(&request.run_id);
        let join_handle = match thread::Builder::new().name(thread_name).spawn(move || {
            if start_receiver.recv().is_err() {
                finish_owned_task(
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
            finish_owned_task(&inner, &thread_task, result);
        }) {
            Ok(handle) => handle,
            Err(error) => {
                state.active.remove(&request.run_id);
                state.statuses.remove(&request.run_id);
                return Err(AgentTaskError::new(format!(
                    "failed to spawn agent run `{}`: {error}",
                    request.run_id
                )));
            }
        };
        *task
            .thread
            .lock()
            .expect("agent task thread handle lock should not be poisoned") = Some(join_handle);
        start_sender.send(()).map_err(|_| {
            state.active.remove(&request.run_id);
            state.statuses.remove(&request.run_id);
            AgentTaskError::new(format!(
                "failed to release agent run `{}` start barrier",
                request.run_id
            ))
        })?;
        drop(state);

        Ok(AgentRunHandle {
            runtime: self.clone(),
            request,
            generation,
            completion: task.completion,
        })
    }

    pub(crate) fn cancel(&self, run_id: &str, reason: AgentCancelReason) -> CancelOutcome {
        let run_id = run_id.trim();
        let reason_value = reason.as_str().to_string();
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        if let Some(task) = state.active.remove(run_id) {
            task.cancellation.cancel();
            let key = AgentTaskKey {
                run_id: run_id.to_string(),
                generation: task.generation,
            };
            let status = state
                .statuses
                .get_mut(run_id)
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
                .insert(run_id.to_string(), Ok(cancelled_result.clone()));
            task.completion.complete(Ok(cancelled_result));
            state.draining.insert(key, task);
            self.inner.task_finished.notify_all();
            return CancelOutcome {
                run_id: run_id.to_string(),
                state: "cancel_requested".to_string(),
                reason: reason_value,
                active_task_removed: true,
                cleanup_pending: true,
            };
        }

        let Some(status) = state.statuses.get_mut(run_id) else {
            return CancelOutcome {
                run_id: run_id.to_string(),
                state: "not_found".to_string(),
                reason: reason_value,
                active_task_removed: false,
                cleanup_pending: false,
            };
        };
        if status.terminal_outcome.is_some() {
            return CancelOutcome {
                run_id: run_id.to_string(),
                state: "already_terminal".to_string(),
                reason: status.cancellation_reason.clone().unwrap_or(reason_value),
                active_task_removed: false,
                cleanup_pending: state.draining.keys().any(|key| key.run_id == run_id),
            };
        }

        status.phase = "cancelled".to_string();
        status.active = false;
        status.cancellation_requested = true;
        status.cancellation_reason = Some(reason_value.clone());
        status.checkpoint_ref = None;
        status.terminal_outcome = Some("cancelled".to_string());
        let request = StartAgentRun::new(status.run_id.clone(), status.session_id.clone());
        state.terminal_results.insert(
            run_id.to_string(),
            Ok(cancelled_task_result(&request, &reason_value)),
        );
        CancelOutcome {
            run_id: run_id.to_string(),
            state: "cancelled_waiting".to_string(),
            reason: reason_value,
            active_task_removed: false,
            cleanup_pending: false,
        }
    }

    pub(crate) fn status(&self, run_id: &str) -> Option<AgentTaskStatus> {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .statuses
            .get(run_id)
            .cloned()
    }

    pub(crate) fn terminal_result(&self, run_id: &str) -> Option<Result<Value, String>> {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .terminal_results
            .get(run_id)
            .cloned()
    }

    pub(crate) fn is_cancelled(&self, run_id: &str) -> bool {
        let state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        state
            .active
            .get(run_id)
            .is_some_and(|task| task.cancellation.is_cancelled())
            || state
                .draining
                .iter()
                .any(|(key, task)| key.run_id == run_id && task.cancellation.is_cancelled())
            || state
                .statuses
                .get(run_id)
                .is_some_and(|status| status.cancellation_requested)
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
        let active_run_ids = {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("agent task runtime state lock should not be poisoned");
            state.accepting = false;
            let mut run_ids = state.active.keys().cloned().collect::<Vec<_>>();
            run_ids.sort();
            run_ids
        };
        for run_id in &active_run_ids {
            self.cancel(run_id, AgentCancelReason::Shutdown);
        }

        let deadline = Instant::now() + timeout;
        let mut state = self
            .inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned");
        while !state.draining.is_empty() {
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
        let mut cleanup_pending_runs = state
            .draining
            .keys()
            .map(|key| key.run_id.clone())
            .collect::<Vec<_>>();
        cleanup_pending_runs.sort();
        cleanup_pending_runs.dedup();
        ShutdownReport {
            cancelled_runs: active_run_ids,
            timed_out: !cleanup_pending_runs.is_empty(),
            cleanup_pending_runs,
        }
    }

    pub(crate) fn resume_accepting(&self) {
        self.inner
            .state
            .lock()
            .expect("agent task runtime state lock should not be poisoned")
            .accepting = true;
    }
}

pub(crate) struct AgentRunHandle {
    runtime: AgentTaskRuntime,
    request: StartAgentRun,
    generation: u64,
    completion: Arc<AgentTaskCompletion>,
}

impl fmt::Debug for AgentRunHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentRunHandle")
            .field("run_id", &self.request.run_id)
            .field("session_id", &self.request.session_id)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl AgentRunHandle {
    pub(crate) fn wait(self) -> Result<Value, String> {
        self.completion.wait()
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.request.run_id
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.request.session_id
    }

    pub(crate) fn status(&self) -> Option<AgentTaskStatus> {
        self.runtime.status(&self.request.run_id)
    }
}

fn validate_start_request(request: StartAgentRun) -> Result<StartAgentRun, AgentTaskError> {
    let run_id = request.run_id.trim();
    let session_id = request.session_id.trim();
    if run_id.is_empty() {
        return Err(AgentTaskError::new("agent run ID must not be empty"));
    }
    if session_id.is_empty() {
        return Err(AgentTaskError::new("agent session ID must not be empty"));
    }
    Ok(StartAgentRun::new(run_id, session_id))
}

fn agent_task_thread_name(run_id: &str) -> String {
    let suffix = run_id
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

fn cancelled_task_result(request: &StartAgentRun, reason: &str) -> Value {
    serde_json::json!({
        "runtime": "rust",
        "runId": request.run_id,
        "sessionId": request.session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "cancellationReason": reason,
        "checkpoint": {
            "schemaVersion": 1,
            "runtime": "rust",
            "runId": request.run_id,
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
                "runId": request.run_id,
                "sessionId": request.session_id,
                "cancelled": true,
                "stopReason": "cancelled",
                "reason": reason
            }
        }]
    })
}

fn finish_owned_task(
    inner: &AgentTaskRuntimeInner,
    task: &OwnedRunTask,
    result: Result<Value, String>,
) {
    let key = AgentTaskKey {
        run_id: task.request.run_id.clone(),
        generation: task.generation,
    };
    let mut state = inner
        .state
        .lock()
        .expect("agent task runtime state lock should not be poisoned");
    let is_active_generation = state
        .active
        .get(&task.request.run_id)
        .is_some_and(|active| active.generation == task.generation);
    if is_active_generation {
        state.active.remove(&task.request.run_id);
    }
    state.draining.remove(&key);

    let status = state
        .statuses
        .get_mut(&task.request.run_id)
        .expect("owned agent task must have a status");
    if status.generation != task.generation || status.terminal_outcome.is_some() {
        status.late_results_ignored = status.late_results_ignored.saturating_add(1);
    } else {
        apply_completion_status(task, status, &result);
        if status.terminal_outcome.is_some() {
            state
                .terminal_results
                .insert(task.request.run_id.clone(), result.clone());
        }
        task.completion.complete(result);
    }
    inner.task_finished.notify_all();
}

fn apply_completion_status(
    task: &OwnedRunTask,
    status: &mut AgentTaskStatus,
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
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn request(run_id: &str) -> StartAgentRun {
        StartAgentRun::new(run_id, format!("session:{run_id}"))
    }

    fn final_result(run_id: &str) -> Value {
        serde_json::json!({
            "runtime": "rust",
            "runId": run_id,
            "sessionId": format!("session:{run_id}"),
            "stopReason": "final_response",
            "finalContent": "done"
        })
    }

    fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while !condition() {
            assert!(Instant::now() < deadline, "condition did not become true");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn completed_run_releases_its_active_handle_and_records_one_terminal_outcome() {
        let runtime = AgentTaskRuntime::new();
        let handle = runtime
            .start_blocking(request("run-complete"), || Ok(final_result("run-complete")))
            .expect("run should start");

        let result = handle.wait().expect("run should complete");
        let status = runtime
            .status("run-complete")
            .expect("status should remain");

        assert_eq!(result["stopReason"], "final_response");
        assert_eq!(runtime.active_count(), 0);
        assert_eq!(runtime.draining_count(), 0);
        assert_eq!(status.phase, "completed");
        assert_eq!(status.terminal_outcome.as_deref(), Some("completed"));
        assert_eq!(status.late_results_ignored, 0);
    }

    #[test]
    fn duplicate_active_run_is_rejected() {
        let runtime = AgentTaskRuntime::new();
        let (release_sender, release_receiver) = mpsc::channel();
        let handle = runtime
            .start_blocking(request("run-duplicate"), move || {
                release_receiver.recv().expect("release should arrive");
                Ok(final_result("run-duplicate"))
            })
            .expect("first run should start");

        let error = runtime
            .start_blocking(request("run-duplicate"), || {
                Ok(final_result("run-duplicate"))
            })
            .expect_err("duplicate active run should fail");
        assert!(error.to_string().contains("already active"));

        release_sender.send(()).expect("release should send");
        handle.wait().expect("first run should finish");
    }

    #[test]
    fn cancellation_removes_active_handle_and_ignores_late_completion() {
        let runtime = AgentTaskRuntime::new();
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let handle = runtime
            .start_blocking(request("run-cancel"), move || {
                started_sender.send(()).expect("start should send");
                release_receiver.recv().expect("release should arrive");
                Ok(final_result("run-cancel"))
            })
            .expect("run should start");
        started_receiver.recv().expect("run should enter operation");

        let outcome = runtime.cancel("run-cancel", AgentCancelReason::UserRequested);
        let result = handle.wait().expect("cancel should produce a result");

        assert_eq!(outcome.state, "cancel_requested");
        assert!(outcome.active_task_removed);
        assert!(outcome.cleanup_pending);
        assert_eq!(runtime.active_count(), 0);
        assert_eq!(runtime.draining_count(), 1);
        assert_eq!(result["stopReason"], "cancelled");

        release_sender.send(()).expect("release should send");
        wait_until(Duration::from_secs(1), || runtime.draining_count() == 0);
        let status = runtime.status("run-cancel").expect("status should remain");
        assert_eq!(status.terminal_outcome.as_deref(), Some("cancelled"));
        assert_eq!(status.late_results_ignored, 1);
    }

    #[test]
    fn waiting_run_releases_task_and_can_resume_with_same_identity() {
        let runtime = AgentTaskRuntime::new();
        let first = runtime
            .start_blocking(request("run-wait"), || {
                Ok(serde_json::json!({
                    "runtime": "rust",
                    "runId": "run-wait",
                    "sessionId": "session:run-wait",
                    "stopReason": "awaiting_form",
                    "checkpoint": { "resumeToken": "form:run-wait" }
                }))
            })
            .expect("waiting run should start");
        first.wait().expect("waiting result should complete task");

        let waiting = runtime
            .status("run-wait")
            .expect("waiting status should remain");
        assert!(!waiting.active);
        assert_eq!(waiting.phase, "awaiting_form");
        assert_eq!(waiting.terminal_outcome, None);
        assert_eq!(waiting.checkpoint_ref.as_deref(), Some("form:run-wait"));

        let second = runtime
            .start_blocking(request("run-wait"), || Ok(final_result("run-wait")))
            .expect("waiting run should resume");
        second.wait().expect("resumed run should finish");
        let completed = runtime
            .status("run-wait")
            .expect("completed status should remain");
        assert_eq!(completed.generation, 2);
        assert_eq!(completed.terminal_outcome.as_deref(), Some("completed"));
    }

    #[test]
    fn shutdown_is_bounded_reports_cleanup_and_can_resume_accepting() {
        let runtime = AgentTaskRuntime::new();
        let (release_sender, release_receiver) = mpsc::channel();
        let handle = runtime
            .start_blocking(request("run-shutdown"), move || {
                release_receiver.recv().expect("release should arrive");
                Ok(final_result("run-shutdown"))
            })
            .expect("run should start");

        let report = runtime.shutdown(Duration::from_millis(25));
        assert_eq!(report.cancelled_runs, vec!["run-shutdown"]);
        assert_eq!(report.cleanup_pending_runs, vec!["run-shutdown"]);
        assert!(report.timed_out);
        assert_eq!(runtime.active_count(), 0);
        assert!(runtime
            .start_blocking(request("run-rejected"), || Ok(final_result("run-rejected")))
            .is_err());
        assert_eq!(handle.wait().unwrap()["stopReason"], "cancelled");

        release_sender.send(()).expect("release should send");
        wait_until(Duration::from_secs(1), || runtime.draining_count() == 0);
        runtime.resume_accepting();
        runtime
            .start_blocking(request("run-restarted"), || {
                Ok(final_result("run-restarted"))
            })
            .expect("runtime should accept after resume")
            .wait()
            .expect("restarted run should finish");
    }
}
