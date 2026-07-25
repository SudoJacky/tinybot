use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

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

    pub fn append_trace_event(
        &self,
        params: BackgroundTraceAppendParams,
    ) -> Result<BackgroundTraceEventResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundWrite)?;
        validate_trace_event(&params.event)?;
        let mut store = self.read_store()?;
        match store
            .trace_events
            .iter()
            .position(|event| event.event_id == params.event.event_id)
        {
            Some(index) => store.trace_events[index] = params.event.clone(),
            None => store.trace_events.push(params.event.clone()),
        }
        store.trace_events.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then(left.event_id.cmp(&right.event_id))
        });
        self.write_store(&store)?;
        Ok(BackgroundTraceEventResult {
            event: params.event,
        })
    }

    pub fn list_trace_events(
        &self,
        params: BackgroundTraceListParams,
    ) -> Result<BackgroundTraceEventListResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundRead)?;
        let filter = params.filter.unwrap_or_default();
        let events = self
            .read_store()?
            .trace_events
            .into_iter()
            .filter(|event| {
                filter
                    .session_key
                    .as_ref()
                    .map_or(true, |session_key| event.session_key == *session_key)
            })
            .filter(|event| {
                filter.delegate_id.as_ref().map_or(true, |delegate_id| {
                    event.delegate_id.as_ref() == Some(delegate_id)
                })
            })
            .filter(|event| {
                filter.trace_ref.as_ref().map_or(true, |trace_ref| {
                    event.trace_ref.as_ref() == Some(trace_ref)
                })
            })
            .filter(|event| {
                filter
                    .event_type
                    .as_ref()
                    .map_or(true, |event_type| event.event_type == *event_type)
            })
            .filter(|event| {
                filter.artifact_id.as_ref().map_or(true, |artifact_id| {
                    trace_event_artifact_id(event).as_deref() == Some(artifact_id)
                })
            })
            .collect();
        Ok(BackgroundTraceEventListResult { events })
    }

    pub fn get_delegate_trace(
        &self,
        params: BackgroundTraceGetDelegateTraceParams,
    ) -> Result<BackgroundDelegateTraceResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundRead)?;
        let events = self
            .list_trace_events(BackgroundTraceListParams {
                filter: Some(params.filter),
            })?
            .events;
        let Some(first) = events.first() else {
            return Ok(BackgroundDelegateTraceResult {
                trace: BackgroundDelegateTrace {
                    session_key: String::new(),
                    delegate_id: None,
                    child_turn_id: None,
                    trace_ref: None,
                    status: None,
                    final_output: None,
                    events,
                    approvals: Vec::new(),
                    artifacts: Vec::new(),
                },
            });
        };
        let mut status = None;
        let mut final_output = None;
        let mut approvals = Vec::new();
        let mut artifacts = Vec::new();
        for event in &events {
            if let Some(value) = json_string(&event.payload, "status") {
                status = Some(value);
            } else if event.event_type.ends_with(".completed") {
                status = Some("completed".to_string());
            } else if event.event_type.ends_with(".failed") {
                status = Some("failed".to_string());
            } else if event.event_type.ends_with(".requested")
                || event.event_type.ends_with(".awaiting_approval")
            {
                status = Some("awaiting_approval".to_string());
            }
            if let Some(value) = json_string(&event.payload, "finalOutput")
                .or_else(|| json_string(&event.payload, "final_output"))
                .or_else(|| json_string(&event.payload, "resultPreview"))
                .or_else(|| json_string(&event.payload, "result_preview"))
            {
                final_output = Some(value);
            }
            if event.event_type.starts_with("child.approval.")
                || event.payload.get("approvalId").is_some()
                || event.payload.get("approval_id").is_some()
            {
                approvals.push(event.payload.clone());
            }
            if event.event_type.starts_with("child.artifact.")
                || event.payload.get("artifactId").is_some()
                || event.payload.get("artifact_id").is_some()
            {
                artifacts.push(event.payload.clone());
            }
        }

        Ok(BackgroundDelegateTraceResult {
            trace: BackgroundDelegateTrace {
                session_key: first.session_key.clone(),
                delegate_id: events.iter().find_map(|event| event.delegate_id.clone()),
                child_turn_id: events.iter().find_map(|event| event.child_turn_id.clone()),
                trace_ref: events.iter().find_map(|event| event.trace_ref.clone()),
                status,
                final_output,
                events,
                approvals,
                artifacts,
            },
        })
    }

    pub fn get_artifact(
        &self,
        params: BackgroundTraceGetArtifactParams,
    ) -> Result<BackgroundTraceArtifactResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundRead)?;
        let events = self
            .list_trace_events(BackgroundTraceListParams {
                filter: Some(params.filter),
            })?
            .events;
        let artifact = events
            .iter()
            .filter(|event| {
                event.event_type.starts_with("child.artifact.")
                    || trace_event_artifact_id(event).is_some()
            })
            .find_map(trace_event_artifact_payload)
            .unwrap_or(Value::Null);
        Ok(BackgroundTraceArtifactResult { artifact })
    }

    pub fn enqueue_subagent_input(
        &self,
        params: BackgroundSubagentEnqueueInputParams,
    ) -> Result<BackgroundSubagentInputResult, WorkerProtocolError> {
        self.require(WorkerCapability::BackgroundWrite)?;
        let session_key = params.session_key.trim();
        let subagent_id = params.subagent_id.trim();
        let content = params.content.trim();
        if session_key.is_empty() {
            return Err(invalid_background_request("session_key is required"));
        }
        if subagent_id.is_empty() {
            return Err(invalid_background_request("subagent_id is required"));
        }
        if content.is_empty() {
            return Err(invalid_background_request("content is required"));
        }

        let mut store = self.read_store()?;
        let sequence = store
            .trace_events
            .iter()
            .map(|event| event.sequence)
            .max()
            .unwrap_or(0)
            + 1;
        let delivery = params
            .delivery
            .as_deref()
            .filter(|delivery| !delivery.trim().is_empty())
            .unwrap_or("queued_for_runtime")
            .to_string();
        let event = BackgroundTraceEvent {
            event_id: format!(
                "subagent-input-{}-{sequence}",
                safe_event_id_part(subagent_id)
            ),
            event_type: "agent.delegate.message_queued".to_string(),
            session_key: session_key.to_string(),
            turn_id: params
                .turn_id
                .filter(|turn_id| !turn_id.trim().is_empty())
                .unwrap_or_else(|| "subagent-direct-input".to_string()),
            parent_step_id: None,
            delegate_id: Some(subagent_id.to_string()),
            child_turn_id: params
                .child_turn_id
                .filter(|child_turn_id| !child_turn_id.trim().is_empty()),
            child_step_id: None,
            trace_ref: params
                .trace_ref
                .filter(|trace_ref| !trace_ref.trim().is_empty()),
            sequence,
            created_at: params
                .created_at
                .filter(|created_at| !created_at.trim().is_empty())
                .unwrap_or_else(now_unix_ms_timestamp),
            payload: serde_json::json!({
                "content": content,
                "delivery": delivery,
                "source": "user",
                "metadata": params.metadata,
            }),
        };
        store.trace_events.push(event.clone());
        store.trace_events.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then(left.event_id.cmp(&right.event_id))
        });
        self.write_store(&store)?;
        Ok(BackgroundSubagentInputResult {
            accepted: true,
            delivery,
            event,
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
    #[serde(default, rename = "traceEvents")]
    pub trace_events: Vec<BackgroundTraceEvent>,
}

impl Default for BackgroundRegistryStore {
    fn default() -> Self {
        Self {
            version: 1,
            runs: Vec::new(),
            trace_events: Vec::new(),
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
    AwaitingApproval,
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

#[derive(Clone, Debug, Deserialize)]
pub struct BackgroundTraceAppendParams {
    pub event: BackgroundTraceEvent,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTraceListFilter {
    pub session_key: Option<String>,
    pub delegate_id: Option<String>,
    pub trace_ref: Option<String>,
    pub event_type: Option<String>,
    pub artifact_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct BackgroundTraceListParams {
    pub filter: Option<BackgroundTraceListFilter>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BackgroundTraceGetDelegateTraceParams {
    pub filter: BackgroundTraceListFilter,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BackgroundTraceGetArtifactParams {
    pub filter: BackgroundTraceListFilter,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSubagentEnqueueInputParams {
    pub session_key: String,
    #[serde(alias = "delegateId")]
    pub subagent_id: String,
    pub content: String,
    pub turn_id: Option<String>,
    pub trace_ref: Option<String>,
    pub child_turn_id: Option<String>,
    pub created_at: Option<String>,
    #[serde(default)]
    pub delivery: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTraceEvent {
    pub event_id: String,
    pub event_type: String,
    pub session_key: String,
    pub turn_id: String,
    pub parent_step_id: Option<String>,
    pub delegate_id: Option<String>,
    pub child_turn_id: Option<String>,
    pub child_step_id: Option<String>,
    pub trace_ref: Option<String>,
    pub sequence: i64,
    pub created_at: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundTraceEventResult {
    pub event: BackgroundTraceEvent,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundTraceEventListResult {
    pub events: Vec<BackgroundTraceEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundDelegateTrace {
    pub session_key: String,
    pub delegate_id: Option<String>,
    pub child_turn_id: Option<String>,
    pub trace_ref: Option<String>,
    pub status: Option<String>,
    pub final_output: Option<String>,
    pub events: Vec<BackgroundTraceEvent>,
    pub approvals: Vec<Value>,
    pub artifacts: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundDelegateTraceResult {
    pub trace: BackgroundDelegateTrace,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundTraceArtifactResult {
    pub artifact: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundSubagentInputResult {
    pub accepted: bool,
    pub delivery: String,
    pub event: BackgroundTraceEvent,
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

fn safe_event_id_part(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "subagent".to_string()
    } else {
        trimmed.to_string()
    }
}

fn now_unix_ms_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("unix-ms:{millis}")
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|item| !item.is_empty())
}

fn trace_event_artifact_id(event: &BackgroundTraceEvent) -> Option<String> {
    event
        .child_step_id
        .clone()
        .filter(|value| value.starts_with("artifact"))
        .or_else(|| json_string(&trace_event_artifact_payload(event)?, "artifactId"))
        .or_else(|| json_string(&trace_event_artifact_payload(event)?, "artifact_id"))
        .or_else(|| json_string(&trace_event_artifact_payload(event)?, "id"))
}

fn trace_event_artifact_payload(event: &BackgroundTraceEvent) -> Option<Value> {
    if let Some(artifact) = event.payload.get("artifact") {
        return Some(artifact.clone());
    }
    if event.event_type.starts_with("child.artifact.")
        || event.payload.get("artifactId").is_some()
        || event.payload.get("artifact_id").is_some()
        || event.payload.get("id").is_some()
    {
        return Some(event.payload.clone());
    }
    None
}

fn validate_trace_event(event: &BackgroundTraceEvent) -> Result<(), WorkerProtocolError> {
    if event.event_id.trim().is_empty() {
        return Err(invalid_background_request("event.eventId is required"));
    }
    if event.event_type.trim().is_empty() {
        return Err(invalid_background_request("event.eventType is required"));
    }
    if event.session_key.trim().is_empty() {
        return Err(invalid_background_request("event.sessionKey is required"));
    }
    if event.turn_id.trim().is_empty() {
        return Err(invalid_background_request("event.turnId is required"));
    }
    if event.sequence <= 0 {
        return Err(invalid_background_request(
            "event.sequence must be positive",
        ));
    }
    if event.created_at.trim().is_empty() {
        return Err(invalid_background_request("event.createdAt is required"));
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

#[cfg(test)]
#[path = "background_tests.rs"]
mod tests;
