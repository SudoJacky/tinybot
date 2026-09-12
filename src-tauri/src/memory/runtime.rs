use super::model::{MemoryModel, TurnEvidence};
use super::store::{MemoryStore, PendingMemoryTurn};
use crate::threads::turn::AgentTurnStatus;
use crate::threads::workspace_store::WorkspaceThreadStore;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const MEMORY_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const MAX_PENDING_EXTRACTIONS_PER_TICK: usize = 10;

struct WorkspaceMemoryRuntime {
    store: MemoryStore,
    thread_store: WorkspaceThreadStore,
    thread_store_path: String,
    latest_config: Arc<Mutex<Value>>,
    model: Arc<dyn MemoryModel>,
    cancellation: CancellationToken,
}

struct MemoryWorker {
    store: MemoryStore,
    thread_store_path: String,
    config: Arc<Mutex<Value>>,
    sender: mpsc::UnboundedSender<PendingMemoryTurn>,
    cancellation: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct MemoryRuntimeState {
    workers: HashMap<(PathBuf, PathBuf), MemoryWorker>,
    stopped: bool,
    shutting_down: bool,
}

/// Application-owned workers. Accepted jobs are durable before they enter the queue.
#[derive(Clone)]
pub(crate) struct MemoryRuntime {
    state: Arc<Mutex<MemoryRuntimeState>>,
    model: Arc<dyn MemoryModel>,
    heartbeat_interval: Duration,
}

impl MemoryRuntime {
    pub(crate) fn new(model: Arc<dyn MemoryModel>) -> Self {
        Self {
            state: Arc::new(Mutex::new(MemoryRuntimeState::default())),
            model,
            heartbeat_interval: MEMORY_HEARTBEAT_INTERVAL,
        }
    }

    pub(crate) fn start(&self, threads: WorkspaceThreadStore, config: Value) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "memory runtime lock is poisoned")?;
        if state.shutting_down {
            return Err("memory workers are still shutting down".into());
        }
        self.worker(&mut state, threads, config)?;
        state.stopped = false;
        Ok(())
    }

    pub(crate) fn schedule_turn_extraction(
        &self,
        threads: WorkspaceThreadStore,
        config: Value,
        thread_id: String,
        turn_id: String,
        workspace_path: String,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "memory runtime lock is poisoned")?;
        if state.stopped {
            return Err("memory runtime is not accepting extractions".into());
        }
        let worker = self.worker(&mut state, threads, config)?;
        worker.store.enqueue_turn(
            &worker.thread_store_path,
            &thread_id,
            &turn_id,
            &workspace_path,
        )?;
        worker
            .sender
            .send(PendingMemoryTurn {
                thread_store_path: worker.thread_store_path.clone(),
                thread_id,
                turn_id,
                workspace_path,
            })
            .map_err(|_| "memory worker exited; extraction remains queued in storage".to_string())
    }

    fn worker<'a>(
        &self,
        state: &'a mut MemoryRuntimeState,
        threads: WorkspaceThreadStore,
        config: Value,
    ) -> Result<&'a MemoryWorker, String> {
        let root = std::fs::canonicalize(threads.workspace_root()).map_err(|error| {
            format!(
                "failed to resolve memory workspace `{}`: {error}",
                threads.workspace_root().display()
            )
        })?;
        let key = (root.clone(), threads.data_root().to_path_buf());
        if !state.workers.contains_key(&key) {
            let store = MemoryStore::new(threads.data_root());
            store.initialize()?;
            let thread_store_path = super::normalized_workspace_path(&root)?;
            let latest_config = Arc::new(Mutex::new(config.clone()));
            let cancellation = CancellationToken::new();
            let (sender, receiver) = mpsc::unbounded_channel();
            let runtime = WorkspaceMemoryRuntime {
                store: store.clone(),
                thread_store: threads,
                thread_store_path: thread_store_path.clone(),
                latest_config: latest_config.clone(),
                model: self.model.clone(),
                cancellation: cancellation.clone(),
            };
            let task = tauri::async_runtime::spawn(runtime.run(receiver, self.heartbeat_interval));
            state.workers.insert(
                key.clone(),
                MemoryWorker {
                    store,
                    thread_store_path,
                    config: latest_config,
                    sender,
                    cancellation,
                    task,
                },
            );
        }
        let worker = state.workers.get(&key).expect("worker was inserted");
        if worker.sender.is_closed() {
            return Err("memory worker has exited unexpectedly".into());
        }
        *worker
            .config
            .lock()
            .map_err(|_| "memory config lock is poisoned")? = config;
        Ok(worker)
    }

    pub(crate) async fn shutdown(&self, timeout: Duration) -> Result<(), String> {
        // Prevent a new generation from starting until every old worker has exited.
        let tasks = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "memory runtime lock is poisoned")?;
            if state.shutting_down {
                return Err("memory shutdown is already in progress".into());
            }
            state.stopped = true;
            state.shutting_down = true;
            for worker in state.workers.values() {
                worker.cancellation.cancel();
            }
            std::mem::take(&mut state.workers)
        };
        let deadline = tokio::time::Instant::now() + timeout;
        let mut failures = Vec::new();
        for ((workspace, _), mut worker) in tasks {
            match tokio::time::timeout_at(deadline, &mut worker.task).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(format!(
                    "memory worker `{}` failed: {error}",
                    workspace.display()
                )),
                Err(_) => {
                    worker.task.abort();
                    let _cancelled = worker.task.await;
                    failures.push(format!("memory worker `{}` exceeded shutdown timeout; pending extractions remain durable", workspace.display()));
                }
            }
        }
        self.state
            .lock()
            .map_err(|_| "memory runtime lock is poisoned")?
            .shutting_down = false;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

impl WorkspaceMemoryRuntime {
    async fn run(
        self,
        mut receiver: mpsc::UnboundedReceiver<PendingMemoryTurn>,
        heartbeat_interval: Duration,
    ) {
        let mut interval = tokio::time::interval(heartbeat_interval);
        interval.tick().await;
        loop {
            let work = async {
                tokio::select! {
                    pending = receiver.recv() => {
                        let Some(pending) = pending else { return false; };
                        if let Err(error) = self.process_pending_turn(&pending).await {
                            report_failure("phase1", self.store_workspace_root(), Some(&pending.thread_id), Some(&pending.turn_id), &error);
                        }
                    }
                    _ = interval.tick() => {
                        if let Err(error) = self.run_heartbeat().await {
                            report_failure("heartbeat", self.store_workspace_root(), None, None, &error);
                        }
                    }
                }
                true
            };
            tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => break,
                keep_running = work => if !keep_running { break; },
            }
        }
    }

    async fn run_heartbeat(&self) -> Result<(), String> {
        for pending in self
            .store
            .pending_turns(&self.thread_store_path, MAX_PENDING_EXTRACTIONS_PER_TICK)?
        {
            if let Err(error) = self.process_pending_turn(&pending).await {
                report_failure(
                    "phase1_retry",
                    self.store_workspace_root(),
                    Some(&pending.thread_id),
                    Some(&pending.turn_id),
                    &error,
                );
            }
        }
        self.run_phase2().await?;
        self.store.write_latest_markdown()?;
        Ok(())
    }

    async fn process_pending_turn(&self, pending: &PendingMemoryTurn) -> Result<(), String> {
        // Heartbeats and notifications share this serial worker. A heartbeat
        // can finish durable work before its queued notification is received.
        if !self.store.is_turn_pending(pending)? {
            increment_metric("memory.phase1.stale_notification.skipped");
            return Ok(());
        }
        let evidence =
            persisted_turn_evidence(&self.thread_store, &pending.thread_id, &pending.turn_id)?;
        if evidence.user_messages.is_empty() && evidence.successful_tool_results.is_empty() {
            self.store.complete_extraction(pending, &[])?;
            increment_metric("memory.phase1.empty.completed");
            return Ok(());
        }
        let config = self.config_snapshot()?;
        increment_metric("memory.phase1.model.started");
        let memories = self
            .model
            .extract(&config, &evidence)
            .await
            .map_err(|error| {
                increment_metric("memory.phase1.model.failed");
                error
            })?;
        increment_metric("memory.phase1.model.completed");
        if self.cancellation.is_cancelled() {
            return Err("memory extraction cancelled".into());
        }
        let inserted = self.store.complete_extraction(pending, &memories)?;
        increment_metric("memory.phase1.fragments.inserted");
        if inserted == 0 {
            increment_metric("memory.phase1.empty.completed");
        }
        Ok(())
    }

    async fn run_phase2(&self) -> Result<(), String> {
        let Some(input) = self.store.phase2_input()? else {
            return Ok(());
        };
        let config = self.config_snapshot()?;
        increment_metric("memory.phase2.model.started");
        let diff = self.model.select(&config, &input).await.map_err(|error| {
            increment_metric("memory.phase2.model.failed");
            error
        })?;
        increment_metric("memory.phase2.model.completed");
        if self.cancellation.is_cancelled() {
            return Err("memory selection cancelled".into());
        }
        let changed = self.store.apply_selection_diff(&input, &diff)?;
        increment_metric(if changed {
            "memory.phase2.diff.changed"
        } else {
            "memory.phase2.diff.unchanged"
        });
        Ok(())
    }

    fn config_snapshot(&self) -> Result<Value, String> {
        self.latest_config
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "memory runtime config lock is poisoned".to_string())
    }

    fn store_workspace_root(&self) -> &Path {
        self.thread_store.workspace_root()
    }
}

fn persisted_turn_evidence(
    thread_store: &WorkspaceThreadStore,
    thread_id: &str,
    turn_id: &str,
) -> Result<TurnEvidence, String> {
    let operation = thread_store.begin_operation().map_err(|error| {
        format!(
            "failed to open persisted Turn for memory: {}",
            error.message
        )
    })?;
    let record = operation
        .thread_log()
        .get_turn(thread_id, turn_id)
        .map_err(|error| {
            format!(
                "failed to read persisted Turn for memory: {}",
                error.message
            )
        })?
        .ok_or_else(|| format!("persisted Turn `{turn_id}` was not found"))?;
    if record.status != AgentTurnStatus::Completed {
        return Err(format!(
            "persisted Turn `{turn_id}` is not completed: {:?}",
            record.status
        ));
    }
    let context = operation
        .thread_log()
        .get_thread_context(thread_id, 500)
        .map_err(|error| {
            format!(
                "failed to read persisted Turn context for memory: {}",
                error.message
            )
        })?
        .ok_or_else(|| format!("persisted Thread `{thread_id}` was not found"))?;
    let user_messages = context
        .messages
        .iter()
        .filter(|message| {
            message.get("role").and_then(Value::as_str) == Some("user")
                && message
                    .get("turnId")
                    .or_else(|| message.get("turn_id"))
                    .and_then(Value::as_str)
                    == Some(turn_id)
        })
        .map(message_text)
        .filter(|content| !content.trim().is_empty())
        .collect::<Vec<_>>();
    let successful_tool_results = record
        .completed_tool_results
        .into_iter()
        .filter(successful_tool_result)
        .collect::<Vec<_>>();
    Ok(TurnEvidence {
        user_messages,
        successful_tool_results,
    })
}

fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(content)) => content.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(content) => content.to_string(),
        None => String::new(),
    }
}

fn successful_tool_result(result: &Value) -> bool {
    let has_tool_identity = result
        .get("toolName")
        .or_else(|| result.get("tool_name"))
        .and_then(Value::as_str)
        .is_some_and(|name| !name.trim().is_empty());
    let status = result
        .get("status")
        .or_else(|| result.get("envelope").and_then(|value| value.get("status")))
        .or_else(|| result.get("summary").and_then(|value| value.get("status")))
        .and_then(Value::as_str);
    has_tool_identity && status == Some("ok")
}

fn increment_metric(key: &str) {
    crate::runtime::observability::global_agent_runtime_metrics().increment(key);
}

fn report_failure(
    phase: &str,
    workspace_root: &Path,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    error: &str,
) {
    increment_metric(&format!("memory.{phase}.failed"));
    eprintln!(
        "memory_operation_failed phase={} workspace={} thread_id={} turn_id={} error={}",
        phase,
        workspace_root.display(),
        thread_id.unwrap_or("-"),
        turn_id.unwrap_or("-"),
        error
    );
}

#[cfg(test)]
pub(super) fn successful_tool_result_for_test(result: &Value) -> bool {
    successful_tool_result(result)
}

impl Drop for MemoryRuntimeState {
    fn drop(&mut self) {
        for worker in self.workers.values() {
            worker.cancellation.cancel();
        }
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
