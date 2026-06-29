use crate::worker_protocol::{WorkerEvent, WorkerTransportMode};
use crate::worker_runtime::{WorkerRuntimeState, WorkerRuntimeStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const NATIVE_TAURI_COMMANDS: &[&str] = &[
    "worker_probe_status",
    "worker_run_agent",
    "worker_run_agent_input",
    "worker_cancel_agent",
    "worker_restore_agent_checkpoint",
    "worker_submit_agent_form",
    "worker_resume_agent_approval",
    "worker_background_trace_list",
    "worker_background_trace_get_delegate_trace",
    "worker_background_trace_get_artifact",
    "worker_background_trace_append",
    "worker_task_plan_list",
    "worker_task_plan_get",
    "worker_task_plan_save",
    "worker_task_plan_delete",
    "worker_webui_route",
    "worker_cowork_route",
    "worker_transport_gateway_frame",
    "worker_transport_websocket_message",
    "worker_transport_dispatch_websocket_message",
    "worker_channel_dispatch_inbound",
    "worker_channel_start",
    "worker_channel_status",
    "worker_channel_stop",
    "worker_channel_login",
    "worker_skills_list",
    "worker_skills_detail",
    "worker_skills_create",
    "worker_skills_update",
    "worker_skills_delete",
    "worker_skills_validate",
    "worker_workspace_files",
    "worker_workspace_file",
    "worker_workspace_put_file",
    "worker_sessions_list",
    "worker_session_messages",
    "worker_session_temporary_files",
    "worker_session_upload_temporary_file",
    "worker_session_clear_temporary_files",
    "worker_session_delete",
    "worker_session_patch",
    "worker_session_clear",
    "worker_session_task_progress",
];

pub const NATIVE_AGENT_EVENT_NAMES: &[&str] = &[
    "agent.delta",
    "agent.reasoning_delta",
    "agent.tool_call.delta",
    "agent.tool.start",
    "agent.tool.result",
    "agent.usage",
    "agent.checkpoint",
    "agent.awaiting_form",
    "agent.awaiting_approval",
    "agent.memory_reference",
    "agent.task_progress",
    "agent.browser_frame",
    "agent.delegate.started",
    "agent.delegate.running",
    "agent.delegate.message_queued",
    "agent.delegate.awaiting_approval",
    "agent.delegate.tool.approval_required",
    "agent.delegate.tool.completed",
    "agent.delegate.trace.updated",
    "agent.delegate.completed",
    "agent.delegate.failed",
    "agent.delegate.interrupted",
    "agent.delegate.closed",
    "heartbeat.delivery",
    "agent.cancelled",
    "agent.done",
    "agent.error",
    "diagnostics.log",
    "worker.status",
];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeBackendKind {
    Rust,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityWorkerKind {
    TsAgentWorker,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityWorkerState {
    Inactive,
    Starting,
    Running,
    Failed,
    Incompatible,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeBackendEventSource {
    RustBackend,
    CompatibilityWorker,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityWorkerRuntimeStatus {
    pub kind: CompatibilityWorkerKind,
    pub state: CompatibilityWorkerState,
    pub transport_mode: Option<WorkerTransportMode>,
    pub diagnostics: Vec<crate::worker_protocol::WorkerDiagnosticLine>,
    pub last_error: Option<String>,
    pub delegated_capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendRuntimeStatus {
    pub backend_kind: NativeBackendKind,
    pub backend_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_worker: Option<CompatibilityWorkerRuntimeStatus>,
}

impl NativeBackendRuntimeStatus {
    pub fn rust_without_compatibility() -> Self {
        Self {
            backend_kind: NativeBackendKind::Rust,
            backend_label: "rust".to_string(),
            compatibility_worker: None,
        }
    }

    pub fn rust_with_ts_compatibility(
        worker: WorkerRuntimeStatus,
        delegated_capabilities: Vec<String>,
    ) -> Self {
        Self {
            backend_kind: NativeBackendKind::Rust,
            backend_label: "rust".to_string(),
            compatibility_worker: Some(CompatibilityWorkerRuntimeStatus {
                kind: CompatibilityWorkerKind::TsAgentWorker,
                state: compatibility_state_from_worker(&worker.state),
                transport_mode: worker.transport_mode,
                diagnostics: worker.diagnostics,
                last_error: worker.last_error,
                delegated_capabilities,
            }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendEvent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub trace_id: String,
    pub event_name: String,
    pub timestamp: String,
    pub source: NativeBackendEventSource,
    #[serde(default)]
    pub payload: Value,
}

impl NativeBackendEvent {
    pub fn from_worker_event(
        event: WorkerEvent,
        session_id: impl Into<String>,
        run_id: Option<impl Into<String>>,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            run_id: run_id.map(Into::into),
            trace_id: event.trace_id,
            event_name: event.event,
            timestamp: timestamp.into(),
            source: NativeBackendEventSource::CompatibilityWorker,
            payload: event.payload,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendMessage {
    pub role: String,
    pub content: String,
    #[serde(default, flatten)]
    pub additional: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendRunSpec {
    pub run_id: String,
    pub session_id: String,
    #[serde(default)]
    pub messages: Vec<NativeBackendMessage>,
    pub model: String,
    pub max_iterations: u32,
    pub stream: bool,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(default, flatten)]
    pub additional: Map<String, Value>,
}

impl NativeBackendRunSpec {
    pub fn from_value(value: Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value)
    }
}

fn compatibility_state_from_worker(state: &WorkerRuntimeState) -> CompatibilityWorkerState {
    match state {
        WorkerRuntimeState::Stopped => CompatibilityWorkerState::Inactive,
        WorkerRuntimeState::Starting => CompatibilityWorkerState::Starting,
        WorkerRuntimeState::Running => CompatibilityWorkerState::Running,
        WorkerRuntimeState::Failed => CompatibilityWorkerState::Failed,
        WorkerRuntimeState::Incompatible => CompatibilityWorkerState::Incompatible,
    }
}
