use super::model::*;
use super::runtime::Control;
use crate::storage::atomic::{write_json_pretty_atomic, AtomicWriteOptions};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

static ACTIVE: OnceLock<Mutex<HashMap<PathBuf, Arc<Control>>>> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub(super) type ActiveRuns = HashMap<PathBuf, Arc<Control>>;

pub(super) fn lock() -> Result<MutexGuard<'static, ActiveRuns>, String> {
    ACTIVE
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Team store lock poisoned".into())
}

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(super) fn next_id() -> String {
    format!(
        "team-{}-{}",
        chrono::Utc::now().timestamp_micros(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

pub(super) fn directory(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("team-runs");
    fs::create_dir_all(&dir).map_err(|error| format!("Create Team store: {error}"))?;
    fs::canonicalize(dir).map_err(|error| format!("Resolve Team store: {error}"))
}

pub(super) fn path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    identifier(id)?;
    Ok(dir.join(format!("{id}.json")))
}

// Callers hold the store lock for reads, reconciliation, and writes together.
pub(super) fn read(path: &Path, active: &ActiveRuns) -> Result<TeamRun, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Read Team run {}: {error}", path.display()))?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Parse Team run {}: {error}", path.display()))?;
    let migrated = value["schemaVersion"] == 1;
    if migrated {
        for member in value["spec"]["members"].as_array_mut().ok_or("Invalid legacy Team members")? {
            let member = member.as_object_mut().ok_or("Invalid legacy Team member")?;
            let id = member.get("id").ok_or("Missing legacy Team member ID")?.clone();
            member.insert("displayName".into(), id);
        }
        for record in value["tasks"].as_array_mut().ok_or("Invalid legacy Team tasks")? {
            let task = record.get_mut("task").and_then(serde_json::Value::as_object_mut)
                .ok_or("Invalid legacy Team task")?;
            let id = task.get("id").ok_or("Missing legacy Team task ID")?.clone();
            task.insert("title".into(), id);
        }
        value["schemaVersion"] = SCHEMA_VERSION.into();
    }
    let mut run: TeamRun = serde_json::from_value(value)
        .map_err(|error| format!("Parse Team run {}: {error}", path.display()))?;
    if run.schema_version != SCHEMA_VERSION
        || path.file_stem().and_then(|s| s.to_str()) != Some(&run.id)
    {
        return Err("Unsupported or mismatched Team run record".into());
    }
    validate_plan(&run.spec, &run.plan())?;
    for record in &run.tasks {
        if record.status != TaskStatus::Pending
            && record.attempts.last().map(|a| a.status) != Some(record.status)
        {
            return Err(format!(
                "Inconsistent Team task history: {}",
                record.task.id
            ));
        }
        if record.status == TaskStatus::Succeeded
            && record
                .attempts
                .last()
                .and_then(|a| a.output.as_deref())
                .is_none_or(|output| output.trim().is_empty())
        {
            return Err(format!(
                "Missing successful Team output: {}",
                record.task.id
            ));
        }
    }
    if migrated {
        eprintln!("team_run_migrated run_id={} from=1 to=2", run.id);
        save(path, &mut run)?;
    }
    if run.status == RunStatus::Running && !active.contains_key(path) {
        run.status = RunStatus::Interrupted;
        run.error =
            Some("Team execution was interrupted; inspect attempt Threads before retrying".into());
        for record in &mut run.tasks {
            if record.status == TaskStatus::Running {
                record.status = TaskStatus::Interrupted;
                let attempt = record
                    .attempts
                    .last_mut()
                    .ok_or("Running Team task has no attempt")?;
                attempt.status = TaskStatus::Interrupted;
                attempt.finished_at = Some(now());
                attempt.error = run.error.clone();
            }
        }
        save(path, &mut run)?;
    }
    Ok(run)
}

pub(super) fn save(path: &Path, run: &mut TeamRun) -> Result<(), String> {
    run.revision = run
        .revision
        .checked_add(1)
        .ok_or("Team revision overflow")?;
    run.updated_at = now();
    write_json_pretty_atomic(path, run, AtomicWriteOptions::default())
        .map_err(|error| format!("Persist Team run {}: {error}", run.id))?;
    eprintln!(
        "team_run_saved run_id={} revision={} status={:?}",
        run.id, run.revision, run.status
    );
    Ok(())
}

pub(super) fn expect_revision(run: &TeamRun, expected: u64) -> Result<(), String> {
    if run.revision != expected {
        return Err(format!(
            "Stale Team revision: expected {expected}, current {}",
            run.revision
        ));
    }
    Ok(())
}
