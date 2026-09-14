use super::{
    execution,
    saved::{ExecutionOptions, SaveDefinition, Store},
    schedule::{Repeat, Schedule},
};
use crate::threads::workspace_store::WorkspaceThreadStore;
use chrono::{DateTime, Local};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateAutomation {
    name: String,
    instructions: String,
    workspace_path: Option<PathBuf>,
    schedule: CreateSchedule,
    #[serde(default)]
    execution: ExecutionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSchedule {
    repeat: Repeat,
    start_at: String,
}

pub(crate) fn create(
    threads: &WorkspaceThreadStore,
    current_workspace: Option<&Path>,
    current_thread_id: &str,
    config: &Value,
    arguments: Value,
) -> Result<Value, String> {
    let mut input: CreateAutomation = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid automation arguments: {error}"))?;
    let workspace = input
        .workspace_path
        .as_deref()
        .or(current_workspace)
        .ok_or("No current workspace; provide an absolute workspacePath")?;
    if !workspace.is_absolute() {
        return Err("workspacePath must be absolute".into());
    }
    if input.execution.thread_id.as_deref() == Some("current") {
        input.execution.thread_id = Some(current_thread_id.to_string());
    }
    if input.schedule.repeat == Repeat::Manual {
        return Err("Choose once, daily, weekdays, or weekly for a scheduled task".into());
    }
    let start = DateTime::parse_from_rfc3339(&input.schedule.start_at)
        .map_err(|error| format!("schedule.startAt must be RFC 3339 with a UTC offset: {error}"))?;
    let start_at_ms = u64::try_from(start.timestamp_millis())
        .map_err(|_| "schedule.startAt must not predate the Unix epoch")?;
    let definition = execution::save(
        &Store::new(threads.data_root()),
        threads,
        config,
        SaveDefinition {
            id: None,
            expected_revision: None,
            name: input.name,
            instructions: input.instructions,
            workspace_path: workspace.to_string_lossy().into_owned(),
            execution: input.execution,
            schedule: Schedule {
                repeat: input.schedule.repeat,
                start_at_ms: Some(start_at_ms),
            },
        },
    )?;
    let next_run_at = definition.next_run_at_ms.map(|timestamp| {
        DateTime::from_timestamp_millis(timestamp as i64)
            .expect("saved schedule has a validated timestamp")
            .with_timezone(&Local)
            .to_rfc3339()
    });
    eprintln!(
        "automation_created automation_id={} source_thread_id={} next_run_at={next_run_at:?}",
        definition.id, current_thread_id,
    );
    Ok(json!({"definition": definition, "nextRunAt": next_run_at}))
}
