use super::model::{extract_memories, select_diff, TurnEvidence};
use super::store::{MemoryStore, PendingMemoryTurn};
use crate::threads::turn::AgentTurnStatus;
use crate::threads::workspace_store::WorkspaceThreadStore;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const MEMORY_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const MAX_PENDING_EXTRACTIONS_PER_TICK: usize = 10;

struct WorkspaceMemoryRuntime {
    store: MemoryStore,
    thread_store: WorkspaceThreadStore,
    thread_store_path: String,
    latest_config: Mutex<Value>,
    phase_lock: tokio::sync::Mutex<()>,
    heartbeat_started: AtomicBool,
}

static MEMORY_RUNTIMES: OnceLock<Mutex<HashMap<PathBuf, Arc<WorkspaceMemoryRuntime>>>> =
    OnceLock::new();

pub(crate) fn start_workspace_runtime(
    workspace_root: PathBuf,
    thread_store: WorkspaceThreadStore,
    config_snapshot: Value,
) {
    match workspace_runtime(&workspace_root, thread_store, config_snapshot) {
        Ok(runtime) => runtime.start_heartbeat(),
        Err(error) => report_failure("startup", &workspace_root, None, None, &error),
    }
}

pub(crate) fn schedule_turn_extraction(
    workspace_root: PathBuf,
    thread_store: WorkspaceThreadStore,
    config_snapshot: Value,
    thread_id: String,
    turn_id: String,
    workspace_path: String,
) {
    let runtime = match workspace_runtime(&workspace_root, thread_store, config_snapshot) {
        Ok(runtime) => runtime,
        Err(error) => {
            report_failure(
                "phase1_schedule",
                &workspace_root,
                Some(&thread_id),
                Some(&turn_id),
                &error,
            );
            return;
        }
    };
    runtime.start_heartbeat();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = runtime
            .enqueue_and_process(thread_id.clone(), turn_id.clone(), workspace_path)
            .await
        {
            report_failure(
                "phase1",
                &workspace_root,
                Some(&thread_id),
                Some(&turn_id),
                &error,
            );
        }
    });
}

fn workspace_runtime(
    workspace_root: &Path,
    thread_store: WorkspaceThreadStore,
    config_snapshot: Value,
) -> Result<Arc<WorkspaceMemoryRuntime>, String> {
    let key = std::fs::canonicalize(workspace_root).map_err(|error| {
        format!(
            "failed to canonicalize memory runtime workspace `{}`: {error}",
            workspace_root.display()
        )
    })?;
    let runtimes = MEMORY_RUNTIMES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut runtimes = runtimes
        .lock()
        .map_err(|_| "memory runtime registry lock is poisoned".to_string())?;
    if let Some(runtime) = runtimes.get(&key) {
        *runtime
            .latest_config
            .lock()
            .map_err(|_| "memory runtime config lock is poisoned".to_string())? = config_snapshot;
        return Ok(runtime.clone());
    }
    let store = MemoryStore::for_workspace(&key);
    store.initialize()?;
    let thread_store_path = super::normalized_workspace_path(&key)?;
    let runtime = Arc::new(WorkspaceMemoryRuntime {
        store,
        thread_store,
        thread_store_path,
        latest_config: Mutex::new(config_snapshot),
        phase_lock: tokio::sync::Mutex::new(()),
        heartbeat_started: AtomicBool::new(false),
    });
    runtimes.insert(key, runtime.clone());
    Ok(runtime)
}

impl WorkspaceMemoryRuntime {
    fn start_heartbeat(self: &Arc<Self>) {
        if self.heartbeat_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(MEMORY_HEARTBEAT_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = runtime.run_heartbeat().await {
                    report_failure(
                        "heartbeat",
                        runtime.store_workspace_root(),
                        None,
                        None,
                        &error,
                    );
                }
            }
        });
    }

    async fn enqueue_and_process(
        &self,
        thread_id: String,
        turn_id: String,
        workspace_path: String,
    ) -> Result<(), String> {
        self.store.enqueue_turn(
            &self.thread_store_path,
            &thread_id,
            &turn_id,
            &workspace_path,
        )?;
        let _guard = self.phase_lock.lock().await;
        let pending = PendingMemoryTurn {
            thread_store_path: self.thread_store_path.clone(),
            thread_id,
            turn_id,
            workspace_path,
        };
        self.process_pending_turn(&pending).await
    }

    async fn run_heartbeat(&self) -> Result<(), String> {
        let _guard = self.phase_lock.lock().await;
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
        let evidence =
            persisted_turn_evidence(&self.thread_store, &pending.thread_id, &pending.turn_id)?;
        if evidence.user_messages.is_empty() && evidence.successful_tool_results.is_empty() {
            self.store.complete_extraction(pending, &[])?;
            increment_metric("memory.phase1.empty.completed");
            return Ok(());
        }
        let config = self.config_snapshot()?;
        increment_metric("memory.phase1.model.started");
        let memories = extract_memories(&config, &evidence)
            .await
            .map_err(|error| {
                increment_metric("memory.phase1.model.failed");
                error
            })?;
        increment_metric("memory.phase1.model.completed");
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
        let diff = select_diff(&config, &input).await.map_err(|error| {
            increment_metric("memory.phase2.model.failed");
            error
        })?;
        increment_metric("memory.phase2.model.completed");
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
