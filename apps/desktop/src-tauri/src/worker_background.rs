use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};

#[derive(Clone, Debug)]
pub struct WorkerBackgroundRpc {
    root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerBackgroundRpc {
    pub fn new(root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self { root, policy }
    }

    pub fn list_runs(&self) -> Result<BackgroundRunListResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundRead)?;
        Ok(BackgroundRunListResult {
            runs: self.read_store()?.runs,
        })
    }

    pub fn upsert_run(
        &self,
        params: BackgroundRunUpsertParams,
    ) -> Result<BackgroundRunResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundWrite)?;
        validate_run(&params.run)?;
        let mut store = self.read_store()?;
        match store.runs.iter().position(|run| run.id == params.run.id) {
            Some(index) => store.runs[index] = params.run.clone(),
            None => store.runs.push(params.run.clone()),
        }
        self.write_store(&store)?;
        Ok(BackgroundRunResult { run: params.run })
    }

    pub fn complete_run(
        &self,
        params: BackgroundRunCompleteParams,
    ) -> Result<BackgroundRunResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundWrite)?;
        if params.run_id.trim().is_empty() {
            return Err(invalid_background_request("run_id is required"));
        }
        if params.status != BackgroundRunStatus::Completed
            && params.status != BackgroundRunStatus::Failed
            && params.status != BackgroundRunStatus::Cancelled
        {
            return Err(invalid_background_request(
                "completed run status must be completed, failed, or cancelled",
            ));
        }
        let mut store = self.read_store()?;
        let Some(run) = store.runs.iter_mut().find(|run| run.id == params.run_id) else {
            return Err(invalid_background_request("background run not found"));
        };
        run.status = params.status;
        run.completed_at_ms = Some(params.completed_at_ms);
        run.updated_at_ms = params.completed_at_ms;
        run.result = params.result;
        run.error = params.error;
        let result = run.clone();
        self.write_store(&store)?;
        Ok(BackgroundRunResult { run: result })
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
        self.root.join("background").join("registry.json")
    }

    fn read_store(&self) -> Result<BackgroundRegistryStore, WorkerProtocolError> {
        let path = self.store_path();
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BackgroundRegistryStore::default());
            }
            Err(error) => return Err(background_io_error(error)),
        };
        if contents.trim().is_empty() {
            return Ok(BackgroundRegistryStore::default());
        }
        serde_json::from_str(&contents).map_err(|error| {
            invalid_background_request(format!("failed to parse background registry: {error}"))
        })
    }

    fn write_store(&self, store: &BackgroundRegistryStore) -> Result<(), WorkerProtocolError> {
        let path = self.store_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(background_io_error)?;
        }
        let contents = serde_json::to_string_pretty(store).map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                format!("failed to serialize background registry: {error}"),
                serde_json::json!({ "method": "background" }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        fs::write(path, format!("{contents}\n")).map_err(background_io_error)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct BackgroundRunUpsertParams {
    pub run: BackgroundRun,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BackgroundRunCompleteParams {
    #[serde(alias = "runId")]
    pub run_id: String,
    pub status: BackgroundRunStatus,
    #[serde(alias = "completedAtMs")]
    pub completed_at_ms: i64,
    pub result: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BackgroundRegistryStore {
    pub version: usize,
    pub runs: Vec<BackgroundRun>,
}

impl Default for BackgroundRegistryStore {
    fn default() -> Self {
        Self {
            version: 1,
            runs: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRun {
    pub id: String,
    pub kind: BackgroundRunKind,
    pub source: BackgroundRunSource,
    pub status: BackgroundRunStatus,
    pub label: Option<String>,
    pub session_key: Option<String>,
    pub plan_id: Option<String>,
    pub subtask_id: Option<String>,
    pub cron_job_id: Option<String>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub result: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundRunKind {
    Subagent,
    Cron,
    Task,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundRunSource {
    Task,
    Subagent,
    Cron,
    Approval,
    Cowork,
    File,
    Provider,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundRunListResult {
    pub runs: Vec<BackgroundRun>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundRunResult {
    pub run: BackgroundRun,
}

fn validate_run(run: &BackgroundRun) -> Result<(), WorkerProtocolError> {
    if run.id.trim().is_empty() {
        return Err(invalid_background_request("run.id is required"));
    }
    if run.started_at_ms <= 0 {
        return Err(invalid_background_request(
            "run.startedAtMs must be positive",
        ));
    }
    if run.updated_at_ms <= 0 {
        return Err(invalid_background_request(
            "run.updatedAtMs must be positive",
        ));
    }
    Ok(())
}

fn invalid_background_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "background" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn background_io_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("background registry filesystem error: {error}"),
        serde_json::json!({ "method": "background" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
