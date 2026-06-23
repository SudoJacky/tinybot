use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_RUN_HISTORY: usize = 20;

#[derive(Clone, Debug)]
pub struct WorkerCronRpc {
    root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerCronRpc {
    pub fn new(root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self { root, policy }
    }

    pub fn list_jobs(&self) -> Result<CronJobListResult, WorkerProtocolError> {
        self.require(WorkerCapability::CronRead)?;
        Ok(CronJobListResult {
            jobs: self.read_store()?.jobs,
        })
    }

    pub fn add_job(
        &self,
        params: CronJobAddParams,
    ) -> Result<CronJobAddResult, WorkerProtocolError> {
        self.require(WorkerCapability::CronWrite)?;
        validate_job_input(&params.job)?;

        let now = now_ms();
        let id = params
            .job
            .id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| generate_job_id(&params.job.name, now));
        let created_at_ms = params.job.created_at_ms.unwrap_or(now);
        let mut state = params.job.state.unwrap_or_default();
        if state.next_run_at_ms.is_none() {
            state.next_run_at_ms = compute_next_run_at_ms(&params.job.schedule, now);
        }
        let job = CronJob {
            id,
            name: params.job.name,
            enabled: params.job.enabled.unwrap_or(true),
            schedule: params.job.schedule,
            payload: params.job.payload,
            state,
            created_at_ms,
            updated_at_ms: now,
            delete_after_run: params.job.delete_after_run.unwrap_or(false),
        };

        let mut store = self.read_store()?;
        match store.jobs.iter().position(|existing| existing.id == job.id) {
            Some(index) => store.jobs[index] = job.clone(),
            None => store.jobs.push(job.clone()),
        }
        self.write_store(&store)?;

        Ok(CronJobAddResult { job })
    }

    pub fn remove_job(
        &self,
        params: CronJobRemoveParams,
    ) -> Result<CronJobRemoveResult, WorkerProtocolError> {
        self.require(WorkerCapability::CronWrite)?;
        let mut store = self.read_store()?;
        let Some(index) = store.jobs.iter().position(|job| job.id == params.job_id) else {
            return Ok(CronJobRemoveResult {
                status: CronJobRemoveStatus::NotFound,
            });
        };
        if matches!(store.jobs[index].payload, CronPayload::SystemEvent { .. }) {
            return Ok(CronJobRemoveResult {
                status: CronJobRemoveStatus::Protected,
            });
        }
        store.jobs.remove(index);
        self.write_store(&store)?;
        Ok(CronJobRemoveResult {
            status: CronJobRemoveStatus::Removed,
        })
    }

    pub fn due_jobs(
        &self,
        params: CronJobDueParams,
    ) -> Result<CronJobListResult, WorkerProtocolError> {
        self.require(WorkerCapability::CronRun)?;
        let now = params.now_ms.unwrap_or_else(now_ms);
        let jobs = self
            .read_store()?
            .jobs
            .into_iter()
            .filter(|job| {
                job.enabled
                    && job
                        .state
                        .next_run_at_ms
                        .is_some_and(|next_run_at_ms| next_run_at_ms <= now)
            })
            .collect();
        Ok(CronJobListResult { jobs })
    }

    pub fn record_runs(
        &self,
        params: CronJobRecordRunsParams,
    ) -> Result<CronJobRecordRunsResult, WorkerProtocolError> {
        self.require(WorkerCapability::CronRun)?;
        let now = params.now_ms.unwrap_or_else(now_ms);
        let mut store = self.read_store()?;
        let mut updated = Vec::new();
        let mut deleted = Vec::new();
        let mut missing = Vec::new();

        for record in params.records {
            let Some(index) = store.jobs.iter().position(|job| job.id == record.job_id) else {
                missing.push(record.job_id);
                continue;
            };

            let job = &mut store.jobs[index];
            job.state.last_run_at_ms = Some(record.run_at_ms);
            job.state.last_status = Some(record.status.as_str().to_string());
            job.state.last_error = record.error.clone();
            job.state.run_history.push(CronRunRecord {
                run_at_ms: record.run_at_ms,
                status: record.status,
                duration_ms: record.duration_ms,
                error: record.error,
            });
            if job.state.run_history.len() > MAX_RUN_HISTORY {
                let remove_count = job.state.run_history.len() - MAX_RUN_HISTORY;
                job.state.run_history.drain(0..remove_count);
            }
            job.updated_at_ms = now;

            match job.schedule {
                CronSchedule::At { .. } => {
                    if job.delete_after_run {
                        let removed = store.jobs.remove(index);
                        deleted.push(removed.id);
                    } else {
                        job.enabled = false;
                        job.state.next_run_at_ms = None;
                        updated.push(job.id.clone());
                    }
                }
                _ => {
                    job.state.next_run_at_ms = compute_next_run_at_ms(&job.schedule, now);
                    updated.push(job.id.clone());
                }
            }
        }

        self.write_store(&store)?;
        Ok(CronJobRecordRunsResult {
            updated,
            deleted,
            missing,
        })
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }

    fn store_path(&self) -> PathBuf {
        self.root.join("cron").join("jobs.json")
    }

    fn read_store(&self) -> Result<CronStoreResult, WorkerProtocolError> {
        let path = self.store_path();
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CronStoreResult::default());
            }
            Err(error) => return Err(cron_io_error(error)),
        };
        if contents.trim().is_empty() {
            return Ok(CronStoreResult::default());
        }
        serde_json::from_str(&contents)
            .map_err(|error| invalid_cron_request(format!("failed to parse cron store: {error}")))
    }

    fn write_store(&self, store: &CronStoreResult) -> Result<(), WorkerProtocolError> {
        let path = self.store_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(cron_io_error)?;
        }
        let contents = serde_json::to_string_pretty(store).map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                format!("failed to serialize cron store: {error}"),
                serde_json::json!({ "method": "cron" }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        fs::write(path, format!("{contents}\n")).map_err(cron_io_error)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct CronJobAddParams {
    pub job: CronJobInput,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CronJobRemoveParams {
    pub job_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CronJobDueParams {
    pub now_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CronJobRecordRunsParams {
    pub now_ms: Option<i64>,
    pub records: Vec<CronJobRunRecordInput>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CronJobRunRecordInput {
    #[serde(alias = "jobId")]
    pub job_id: String,
    #[serde(alias = "runAtMs")]
    pub run_at_ms: i64,
    pub status: CronRunStatus,
    #[serde(alias = "durationMs")]
    pub duration_ms: i64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobInput {
    pub id: Option<String>,
    pub name: String,
    pub enabled: Option<bool>,
    pub schedule: CronSchedule,
    pub payload: CronPayload,
    pub state: Option<CronJobState>,
    pub created_at_ms: Option<i64>,
    pub delete_after_run: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CronStoreResult {
    pub version: usize,
    pub jobs: Vec<CronJob>,
}

impl Default for CronStoreResult {
    fn default() -> Self {
        Self {
            version: 1,
            jobs: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJob {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub schedule: CronSchedule,
    pub payload: CronPayload,
    pub state: CronJobState,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub delete_after_run: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CronSchedule {
    At {
        #[serde(rename = "atMs")]
        at_ms: i64,
    },
    Every {
        #[serde(rename = "everyMs")]
        every_ms: i64,
    },
    Cron {
        expr: String,
        tz: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CronPayload {
    SystemEvent {
        message: String,
    },
    AgentTurn {
        message: String,
        deliver: Option<bool>,
        channel: Option<String>,
        to: Option<String>,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobState {
    pub next_run_at_ms: Option<i64>,
    pub last_run_at_ms: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    #[serde(default)]
    pub run_history: Vec<CronRunRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    pub run_at_ms: i64,
    pub status: CronRunStatus,
    pub duration_ms: i64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CronRunStatus {
    Ok,
    Error,
    Skipped,
}

impl CronRunStatus {
    fn as_str(&self) -> &'static str {
        match self {
            CronRunStatus::Ok => "ok",
            CronRunStatus::Error => "error",
            CronRunStatus::Skipped => "skipped",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CronJobListResult {
    pub jobs: Vec<CronJob>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CronJobAddResult {
    pub job: CronJob,
}

#[derive(Clone, Debug, Serialize)]
pub struct CronJobRemoveResult {
    pub status: CronJobRemoveStatus,
}

#[derive(Clone, Debug, Serialize)]
pub struct CronJobRecordRunsResult {
    pub updated: Vec<String>,
    pub deleted: Vec<String>,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CronJobRemoveStatus {
    Removed,
    Protected,
    NotFound,
}

fn validate_job_input(job: &CronJobInput) -> Result<(), WorkerProtocolError> {
    if job.name.trim().is_empty() {
        return Err(invalid_cron_request("job.name is required"));
    }
    match &job.schedule {
        CronSchedule::At { at_ms } if *at_ms <= 0 => {
            Err(invalid_cron_request("job.schedule.atMs must be positive"))
        }
        CronSchedule::Every { every_ms } if *every_ms <= 0 => Err(invalid_cron_request(
            "job.schedule.everyMs must be positive",
        )),
        CronSchedule::Cron { expr, tz } => {
            if expr.trim().is_empty() {
                return Err(invalid_cron_request("job.schedule.expr is required"));
            }
            if tz.as_deref().is_some_and(|value| value.trim().is_empty()) {
                return Err(invalid_cron_request("job.schedule.tz must be non-empty"));
            }
            Ok(())
        }
        _ => Ok(()),
    }?;
    match &job.payload {
        CronPayload::SystemEvent { message } | CronPayload::AgentTurn { message, .. } => {
            if message.trim().is_empty() {
                return Err(invalid_cron_request("job.payload.message is required"));
            }
        }
    }
    Ok(())
}

fn compute_next_run_at_ms(schedule: &CronSchedule, now: i64) -> Option<i64> {
    match schedule {
        CronSchedule::At { at_ms } if *at_ms > now => Some(*at_ms),
        CronSchedule::At { .. } => None,
        CronSchedule::Every { every_ms } => Some(now.saturating_add(*every_ms)),
        CronSchedule::Cron { .. } => None,
    }
}

fn generate_job_id(name: &str, now: i64) -> String {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    now.hash(&mut hasher);
    format!("cron_{:016x}", hasher.finish())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn invalid_cron_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "cron" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn cron_io_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("cron store filesystem error: {error}"),
        serde_json::json!({ "method": "cron" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn list_jobs_reads_existing_cron_store_fixture() {
        let root = temp_workspace_root("existing-cron-store");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        let store_path = root.join("cron").join("jobs.json");
        std::fs::create_dir_all(store_path.parent().unwrap()).unwrap();
        std::fs::write(
            &store_path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "cron-existing",
                        "name": "Existing check-in",
                        "enabled": true,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": {
                            "kind": "agent_turn",
                            "message": "Run existing check-in",
                            "deliver": true,
                            "channel": "desktop",
                            "to": null
                        },
                        "state": {
                            "nextRunAtMs": 1710000000000i64,
                            "lastRunAtMs": 1709999900000i64,
                            "lastStatus": "ok",
                            "lastError": null,
                            "runHistory": [
                                {
                                    "runAtMs": 1709999900000i64,
                                    "status": "ok",
                                    "durationMs": 1500,
                                    "error": null
                                }
                            ]
                        },
                        "createdAtMs": 1709999800000i64,
                        "updatedAtMs": 1709999900000i64,
                        "deleteAfterRun": false
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let rpc = WorkerCronRpc::new(root, CapabilityPolicy::new([WorkerCapability::CronRead]));

        let result = rpc.list_jobs().expect("existing cron store should load");

        assert_eq!(result.jobs.len(), 1);
        let job = &result.jobs[0];
        assert_eq!(job.id, "cron-existing");
        assert_eq!(job.state.last_status.as_deref(), Some("ok"));
        assert_eq!(job.state.run_history.len(), 1);
    }

    fn temp_workspace_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-cron-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    struct TempWorkspaceCleanup(PathBuf);

    impl Drop for TempWorkspaceCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
