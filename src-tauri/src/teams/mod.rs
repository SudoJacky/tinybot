pub(crate) mod board;
mod model;
mod native;
mod planner;
mod runtime;
mod store;
#[cfg(test)]
mod tests;
pub(crate) mod tools;

use model::{RunStatus, TaskRecord, TaskStatus, SCHEMA_VERSION};
pub(crate) use model::{TeamModel, TeamPlan, TeamRun, TeamSpec};
pub(crate) use native::NativeTeamExecutor;
pub(crate) use planner::plan;
pub(crate) use runtime::execute;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareTeamInput {
    pub spec: TeamSpec,
    pub plan: Option<TeamPlan>,
    pub planner_model: Option<TeamModel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamRunInput {
    pub run_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamAction {
    Pause,
    Cancel,
    Retry,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlTeamInput {
    pub run_id: String,
    pub action: TeamAction,
    pub expected_revision: u64,
    #[serde(default)]
    pub task_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviseTeamInput {
    pub run_id: String,
    pub expected_revision: u64,
    pub plan: TeamPlan,
}

pub(crate) fn prepare(root: &Path, mut spec: TeamSpec, plan: TeamPlan) -> Result<TeamRun, String> {
    model::validate_plan(&spec, &plan)?;
    let workspace =
        crate::workspace_registry::canonical_workspace(Path::new(&spec.workspace_path))?;
    spec.workspace_path = crate::workspace_registry::workspace_id(&workspace);
    let dir = store::directory(root)?;
    let _lock = store::lock()?;
    let id = loop {
        let id = store::next_id();
        if !store::path(&dir, &id)?.exists() {
            break id;
        }
    };
    let mut run = TeamRun {
        schema_version: SCHEMA_VERSION,
        id,
        revision: 0,
        spec,
        final_task_id: plan.final_task_id,
        tasks: plan
            .tasks
            .into_iter()
            .map(|task| TaskRecord {
                task,
                status: TaskStatus::Pending,
                attempts: vec![],
            })
            .collect(),
        status: RunStatus::Planned,
        created_at: store::now(),
        updated_at: store::now(),
        error: None,
    };
    store::save(&store::path(&dir, &run.id)?, &mut run)?;
    Ok(run)
}

pub(crate) fn get(root: &Path, id: &str) -> Result<TeamRun, String> {
    let path = store::path(&store::directory(root)?, id)?;
    let active = store::lock()?;
    store::read(&path, &active)
}

pub(crate) fn list(root: &Path) -> Result<Vec<TeamRun>, String> {
    let dir = store::directory(root)?;
    let active = store::lock()?;
    let mut runs = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| format!("List Team runs: {error}"))? {
        let path = entry
            .map_err(|error| format!("List Team entry: {error}"))?
            .path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            runs.push(store::read(&path, &active)?);
        }
    }
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(runs)
}

pub(crate) fn revise(root: &Path, input: ReviseTeamInput) -> Result<TeamRun, String> {
    let path = store::path(&store::directory(root)?, &input.run_id)?;
    let active = store::lock()?;
    let mut run = store::read(&path, &active)?;
    store::expect_revision(&run, input.expected_revision)?;
    if active.contains_key(&path) || run.status == RunStatus::Completed {
        return Err("Pause Team execution before revising an unfinished plan".into());
    }
    model::validate_plan(&run.spec, &input.plan)?;
    for record in &run.tasks {
        if !record.attempts.is_empty() && !input.plan.tasks.contains(&record.task) {
            return Err(format!(
                "Cannot rewrite attempted Team task {}",
                record.task.id
            ));
        }
    }
    run.tasks = input
        .plan
        .tasks
        .into_iter()
        .map(|task| {
            run.tasks
                .iter()
                .find(|r| r.task.id == task.id)
                .cloned()
                .map(|mut record| {
                    record.task = task.clone();
                    record
                })
                .unwrap_or_else(|| TaskRecord {
                    task,
                    status: TaskStatus::Pending,
                    attempts: vec![],
                })
        })
        .collect();
    run.final_task_id = input.plan.final_task_id;
    store::save(&path, &mut run)?;
    Ok(run)
}

pub(crate) fn control(root: &Path, input: ControlTeamInput) -> Result<TeamRun, String> {
    let path = store::path(&store::directory(root)?, &input.run_id)?;
    let active = store::lock()?;
    let mut run = store::read(&path, &active)?;
    store::expect_revision(&run, input.expected_revision)?;
    match input.action {
        TeamAction::Pause | TeamAction::Cancel => {
            if !input.task_ids.is_empty() {
                return Err("Task IDs only apply to retry".into());
            }
            if let Some(control) = active.get(&path) {
                eprintln!(
                    "team_control_requested run_id={} action={:?}",
                    run.id, input.action
                );
                match input.action {
                    TeamAction::Pause => control
                        .pause
                        .store(true, std::sync::atomic::Ordering::SeqCst),
                    TeamAction::Cancel => control.cancel.cancel(),
                    _ => unreachable!(),
                }
                // The scheduler owns persisted transitions and drains all active attempts.
                return Ok(run);
            }
            if run.status == RunStatus::Completed {
                return Err("Completed Team run cannot be controlled".into());
            }
            run.status = match input.action {
                TeamAction::Pause => RunStatus::Paused,
                _ => RunStatus::Cancelled,
            };
        }
        TeamAction::Retry => {
            if active.contains_key(&path) || input.task_ids.is_empty() {
                return Err("Retry requires an idle Team run and explicit task IDs".into());
            }
            let ids: std::collections::HashSet<_> = input.task_ids.iter().collect();
            if ids.len() != input.task_ids.len() {
                return Err("Duplicate retry task IDs".into());
            }
            for id in &input.task_ids {
                let record = run
                    .tasks
                    .iter()
                    .find(|r| &r.task.id == id)
                    .ok_or_else(|| format!("Unknown Team task {id}"))?;
                if !matches!(
                    record.status,
                    TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Interrupted
                ) {
                    return Err(format!("Task {id} is not retryable"));
                }
            }
            for record in &mut run.tasks {
                if ids.contains(&record.task.id) {
                    record.status = TaskStatus::Pending;
                }
            }
            run.status = RunStatus::Paused;
            run.error = None;
        }
    }
    store::save(&path, &mut run)?;
    Ok(run)
}
