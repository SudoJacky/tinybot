use crate::storage::atomic::{read_json_store, write_json_pretty_atomic, AtomicWriteOptions};
use crate::workspace_registry::{canonical_workspace, workspace_id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOCK: Mutex<()> = Mutex::new(());
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static PROCESS: OnceLock<String> = OnceLock::new();

pub(super) fn identity() -> String {
    format!(
        "{}-{}-{}",
        now(),
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock predates Unix epoch")
        .as_millis() as u64
}
fn process() -> &'static str {
    PROCESS.get_or_init(identity)
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Definition {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub workspace_path: String,
    pub revision: u64,
    pub model_policy: ModelPolicy,
    pub updated_at_ms: u64,
    #[serde(default)]
    pub execution: ExecutionOptions,
    #[serde(default)]
    pub schedule: super::schedule::Schedule,
    #[serde(default)]
    pub next_run_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionOptions {
    pub thread_id: Option<String>,
    pub provider: Option<String>,
    pub profile: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelPolicy {
    InheritDefault,
    Explicit,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveDefinition {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    pub name: String,
    pub instructions: String,
    pub workspace_path: String,
    #[serde(default)]
    pub execution: ExecutionOptions,
    #[serde(default)]
    pub schedule: super::schedule::Schedule,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    pub id: String,
    pub definition: Definition,
    pub effective_model: Value,
    pub thread_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub started_at_ms: u64,
    #[serde(default)]
    pub scheduled_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub stop_reason: Option<String>,
    pub process_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub definitions: Vec<Definition>,
    pub runs: Vec<Run>,
}

#[derive(Clone)]
pub(crate) struct Store {
    path: PathBuf,
}
impl Store {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join("automations").join("store.json"),
        }
    }

    fn transaction<T>(
        &self,
        change: impl FnOnce(&mut Snapshot) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = LOCK.lock().map_err(|_| "automation store lock poisoned")?;
        let mut snapshot: Snapshot = read_json_store(&self.path).map_err(|e| e.to_string())?;
        let previous = snapshot.clone();
        for run in &mut snapshot.runs {
            if run.status == "running" && run.process_id != process() {
                run.status = "interrupted".into();
                run.stop_reason = Some("runtime_restarted".into());
                run.error = Some(
                    "Tinybot stopped before this run completed. Start a new run explicitly.".into(),
                );
                run.finished_at_ms = Some(now());
                eprintln!(
                    "automation_run_interrupted run_id={} reason=runtime_restarted",
                    run.id
                );
            }
        }
        let result = change(&mut snapshot)?;
        if snapshot != previous {
            write_json_pretty_atomic(&self.path, &snapshot, AtomicWriteOptions::default())
                .map_err(|e| e.to_string())?;
        }
        Ok(result)
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        self.transaction(|s| Ok(s.clone()))
    }

    pub fn fail(&self, id: &str, error: String) -> Result<(), String> {
        self.transaction(|s| {
            let run = s
                .runs
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or("Automation run missing")?;
            run.status = "failed".into();
            run.error = Some(error);
            run.finished_at_ms = Some(now());
            Ok(())
        })
    }

    pub fn save(&self, input: SaveDefinition) -> Result<Definition, String> {
        if input.name.trim().is_empty() || input.instructions.trim().is_empty() {
            return Err("Automation name and instructions are required".into());
        }
        let workspace_path = workspace_id(&canonical_workspace(Path::new(&input.workspace_path))?);
        let first_run = input.schedule.first()?;
        if input.execution.provider.is_some() != input.execution.model.is_some() {
            return Err("Select both a provider and a model".into());
        }
        if input
            .execution
            .reasoning_effort
            .as_deref()
            .is_some_and(|v| !["low", "medium", "high", "xhigh", "max"].contains(&v))
        {
            return Err("Invalid reasoning effort".into());
        }
        self.transaction(|s| {
            let previous = input
                .id
                .as_ref()
                .map(|id| {
                    s.definitions
                        .iter()
                        .position(|d| &d.id == id)
                        .ok_or_else(|| "Automation no longer exists".to_string())
                })
                .transpose()?;
            let revision = match previous {
                Some(i) => {
                    if input.expected_revision != Some(s.definitions[i].revision) {
                        return Err("Automation changed; reload before saving".into());
                    }
                    s.definitions[i].revision + 1
                }
                None => 1,
            };
            let definition = Definition {
                id: input.id.unwrap_or_else(identity),
                name: input.name.trim().into(),
                instructions: input.instructions,
                workspace_path,
                revision,
                model_policy: if input.execution.provider.is_some() {
                    ModelPolicy::Explicit
                } else {
                    ModelPolicy::InheritDefault
                },
                updated_at_ms: now(),
                next_run_at_ms: previous
                    .filter(|&i| s.definitions[i].schedule == input.schedule)
                    .map(|i| s.definitions[i].next_run_at_ms)
                    .unwrap_or(first_run),
                execution: input.execution,
                schedule: input.schedule,
            };
            if let Some(i) = previous {
                s.definitions[i] = definition.clone();
            } else {
                s.definitions.push(definition.clone());
            }
            Ok(definition)
        })
    }

    pub fn delete(&self, id: &str, expected_revision: u64) -> Result<(), String> {
        self.transaction(|s| {
            let index = s
                .definitions
                .iter()
                .position(|d| d.id == id)
                .ok_or("Automation no longer exists")?;
            if s.definitions[index].revision != expected_revision {
                return Err("Automation changed; reload before deleting".into());
            }
            s.definitions.remove(index);
            Ok(())
        })
    }

    pub fn begin(&self, definition: Definition, effective_model: Value) -> Result<Run, String> {
        self.transaction(|s| {
            if !s
                .definitions
                .iter()
                .any(|d| d.id == definition.id && d.revision == definition.revision)
            {
                return Err("Automation changed; reload before running".into());
            }
            if s.runs.iter().any(|r| {
                r.definition.id == definition.id
                    && matches!(r.status.as_str(), "running" | "waiting")
            }) {
                return Err(
                    "This automation already has active work; open its conversation".into(),
                );
            }
            let run = Run {
                id: identity(),
                definition,
                effective_model,
                thread_id: None,
                status: "running".into(),
                error: None,
                started_at_ms: now(),
                scheduled_at_ms: None,
                finished_at_ms: None,
                stop_reason: None,
                process_id: process().into(),
            };
            s.runs.insert(0, run.clone());
            Ok(run)
        })
    }

    pub fn update(&self, run: &Run) -> Result<(), String> {
        self.transaction(|s| {
            let existing = s
                .runs
                .iter_mut()
                .find(|r| r.id == run.id)
                .ok_or("Automation run missing")?;
            *existing = run.clone();
            Ok(())
        })
    }

    // Three polling intervals allow ordinary timer jitter. A longer wall-clock
    // gap (including sleep) skips overdue occurrences instead of replaying them.
    // The first tick has no previous time and skips the stopped-app backlog.
    pub fn claim_due(&self, at: u64, previous_tick: Option<u64>) -> Result<Vec<Run>, String> {
        let recovering =
            previous_tick.map_or(true, |previous| at.saturating_sub(previous) > 15_000);
        self.transaction(|s| {
            let mut claimed = Vec::new();
            for definition in &mut s.definitions {
                let Some(scheduled_at) = definition.next_run_at_ms.filter(|&next| next <= at) else {
                    continue;
                };
                // An occurrence already blocked before the gap keeps its existing
                // waiting behavior; it was not missed because the scheduler stopped.
                let missed = recovering && scheduled_at < at
                    && previous_tick.map_or(true, |previous| scheduled_at > previous);
                if !missed && s.runs.iter().any(|r| {
                    r.definition.id == definition.id
                        && matches!(r.status.as_str(), "running" | "waiting")
                }) {
                    continue;
                }
                let snapshot = definition.clone();
                definition.next_run_at_ms = definition.schedule.after(at)?;
                let run = Run {
                    id: identity(),
                    definition: snapshot,
                    effective_model: Value::Null,
                    thread_id: None,
                    status: if missed { "missed" } else { "running" }.into(),
                    error: None,
                    started_at_ms: at,
                    scheduled_at_ms: Some(scheduled_at),
                    finished_at_ms: missed.then_some(at),
                    stop_reason: missed.then(|| "scheduler_unavailable".into()),
                    process_id: process().into(),
                };
                s.runs.insert(0, run.clone());
                if missed {
                    eprintln!("automation_schedule_missed automation_id={} run_id={} scheduled_at_ms={scheduled_at} detected_at_ms={at}", definition.id, run.id);
                } else {
                    claimed.push(run);
                }
            }
            Ok(claimed)
        })
    }
}
