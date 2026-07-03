#![recursion_limit = "256"]

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, Runtime, State, WindowEvent};

pub mod agent_loop_runtime_protocol;
pub mod config_store;
pub mod desktop_cron;
pub mod desktop_files;
pub mod desktop_gateway;
#[cfg(test)]
pub mod desktop_heartbeat;
pub mod desktop_logging;
pub mod desktop_menu;
pub mod native_backend_contract;
pub mod native_provider_runtime;
pub mod worker_agent_runtime;
pub mod worker_background;
pub mod worker_capability;
pub mod worker_client;
pub mod worker_config;
pub mod worker_connection;
pub mod worker_cowork_runtime;
pub mod worker_cron;
pub mod worker_diagnostics;
pub mod worker_knowledge;
pub mod worker_manager;
pub mod worker_memory;
pub mod worker_protocol;
pub mod worker_request_id;
pub mod worker_rpc;
pub mod worker_runtime;
pub mod worker_secret;
pub mod worker_session;
pub mod worker_shell;
pub mod worker_stdio;
pub mod worker_storage;
pub mod worker_subagent_manager;
pub mod worker_task;
pub mod worker_workspace;

use crate::config_store::{
    ConfigEditorSnapshot, ConfigOperationRequest, ConfigPatchApplyResult, ConfigPatchBridgeResult,
    ConfigStore,
};
use crate::desktop_cron::{
    start_worker_cron_timer, stop_worker_cron_timer, worker_cron_dispatch_due,
};
use crate::desktop_files::{pick_upload_file, reveal_workspace_file, save_export_file};
use crate::desktop_gateway::{
    gateway_exit_policy_preference_path, gateway_status, load_gateway_exit_policy,
    native_backend_log_path, set_gateway_keep_running, start_gateway, stop_gateway,
    stop_owned_gateway,
};
use crate::desktop_logging::append_native_backend_log_line;
use crate::desktop_menu::{
    install_desktop_application_menu, is_desktop_menu_command, DesktopMenuCommandPayload,
};
use crate::agent_loop_runtime_protocol::{
    AgentRuntimeEventAppendInput, AgentRuntimeEventAppender, AgentRuntimeEventEnvelope,
    AgentRuntimeEventSource, AgentRuntimeEventVisibility, AgentRuntimePhase,
};
use crate::native_backend_contract::{
    webui_route_inventory_entry, NativeCompatibilityFallbackDiagnostic,
};
use crate::worker_agent_runtime::{run_native_agent_turn_with_config, NativeAgentRuntimeServices};
use crate::worker_background::BackgroundTraceEvent;
use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_client::WorkerClient;
use crate::worker_cowork_runtime::WorkerCoworkRuntime;
use crate::worker_manager::{
    WorkerCommandSpec, WorkerManager, WorkerManagerEvent, WorkerManagerState,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::worker_rpc::WorkerRpcRouter;
use crate::worker_runtime::WorkerRuntimeStatus;
use crate::worker_subagent_manager::{
    SubagentSendInputParams, SubagentSpawnParams, SubagentTargetParams, SubagentThreadManager,
    SubagentWaitParams,
};

#[derive(Serialize)]
struct DesktopStatus {
    app_name: &'static str,
    gateway_http: &'static str,
    gateway_ws: &'static str,
    browser_mode: &'static str,
}

#[tauri::command]
fn desktop_status() -> DesktopStatus {
    DesktopStatus {
        app_name: "Tinybot Desktop",
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        browser_mode: "External browser",
    }
}

type SharedGateway = Arc<Mutex<GatewayRuntime>>;
const WORKER_CRON_TIMER_MAX_POLL: Duration = Duration::from_secs(30);
const WORKER_WEBUI_ROUTE_TIMEOUT: Duration = Duration::from_secs(10);
const NATIVE_BACKEND_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const NATIVE_BACKEND_LOG_TAIL_LINES: usize = 100;
const NATIVE_AGENT_RUN_TRACE_STRING_LIMIT: usize = 256;

struct GatewayRuntime {
    experimental_worker: WorkerManager,
    native_agent_runtime: NativeAgentRuntimeServices,
    subagent_manager: SubagentThreadManager,
    logs: VecDeque<String>,
    compatibility_fallbacks: VecDeque<NativeCompatibilityFallbackDiagnostic>,
    persistent_log_path: PathBuf,
    last_error: Option<String>,
    keep_background: bool,
    cron_dispatch_running: Arc<AtomicBool>,
    cron_timer_started: Arc<AtomicBool>,
    cron_timer_stop: Arc<AtomicBool>,
}

impl Default for GatewayRuntime {
    fn default() -> Self {
        let subagent_manager = SubagentThreadManager::default();
        Self {
            experimental_worker: WorkerManager::new(200),
            native_agent_runtime: NativeAgentRuntimeServices::with_subagent_manager(
                subagent_manager.clone(),
            ),
            subagent_manager,
            logs: VecDeque::with_capacity(200),
            compatibility_fallbacks: VecDeque::with_capacity(50),
            persistent_log_path: native_backend_log_path(),
            last_error: None,
            keep_background: false,
            cron_dispatch_running: Arc::new(AtomicBool::new(false)),
            cron_timer_started: Arc::new(AtomicBool::new(false)),
            cron_timer_stop: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerAgentEchoResult {
    ok: bool,
    echo: String,
    config_value: serde_json::Value,
    workspace_file_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRunAgentInput {
    spec: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRunAgentWithInputInput {
    input: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSkillDetailInput {
    name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSkillCreateInput {
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSkillUpdateInput {
    name: String,
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWorkspaceFileInput {
    path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWorkspacePutFileInput {
    path: String,
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSessionInput {
    key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSessionPatchInput {
    key: String,
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSessionBranchInput {
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSessionTemporaryFileUploadInput {
    key: String,
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSessionTaskProgressInput {
    key: String,
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerCoworkRouteInput {
    method: String,
    path: String,
    #[serde(default)]
    body: Option<serde_json::Value>,
    #[serde(default)]
    query: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWebuiRouteInput {
    method: String,
    path: String,
    #[serde(default)]
    headers: Option<serde_json::Value>,
    #[serde(default)]
    body: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerTransportGatewayFrameInput {
    kind: String,
    chat_id: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    usage: Option<serde_json::Value>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerTransportWebSocketMessageInput {
    client_id: String,
    frame: serde_json::Value,
    #[serde(default)]
    attached_chat_id: Option<String>,
    #[serde(default)]
    session_exists: Option<bool>,
    #[serde(default)]
    editable_paths: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerTransportWebSocketDispatchInput {
    client_id: String,
    frame: serde_json::Value,
    #[serde(default)]
    attached_chat_id: Option<String>,
    #[serde(default)]
    session_exists: Option<bool>,
    #[serde(default)]
    editable_paths: Option<Vec<String>>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    max_iterations: Option<u32>,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    stream: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerChannelDispatchInboundInput {
    message: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerChannelLoginInput {
    channel: String,
    #[serde(default)]
    force: bool,
}

#[derive(Clone, Debug, Default)]
struct WorkerTransportWebSocketDispatchOptions {
    model: Option<String>,
    max_iterations: Option<u32>,
    run_id: Option<String>,
    stream: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerCancelAgentInput {
    run_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRestoreAgentCheckpointInput {
    session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBackgroundTraceListInput {
    #[serde(default)]
    filter: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBackgroundTraceGetDelegateTraceInput {
    #[serde(default)]
    filter: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBackgroundTraceGetArtifactInput {
    #[serde(default)]
    filter: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBackgroundTraceAppendInput {
    event: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBackgroundSubagentInputInput {
    session_key: String,
    subagent_id: String,
    content: String,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    trace_ref: Option<String>,
    #[serde(default)]
    child_run_id: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    metadata: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerTaskPlanListInput {
    #[serde(default)]
    include_completed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerTaskPlanIdInput {
    plan_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerTaskPlanSaveInput {
    plan: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerKnowledgeDocumentsInput {
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerKnowledgeBodyInput {
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerKnowledgeDocumentIdInput {
    doc_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerKnowledgeJobIdInput {
    job_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerKnowledgeRebuildIndexInput {
    #[serde(default)]
    rebuild_type: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerKnowledgeGraphInput {
    #[serde(default)]
    doc_id: Option<String>,
    #[serde(default)]
    graph_type: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    edge_limit: Option<usize>,
    #[serde(default)]
    min_confidence: Option<f64>,
    #[serde(default)]
    include_orphans: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSubmitAgentFormInput {
    session_id: String,
    form_id: String,
    #[serde(default)]
    values: serde_json::Value,
    #[serde(default)]
    action: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResumeAgentApprovalInput {
    session_id: String,
    approval_id: String,
    approved: bool,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    guidance: Option<String>,
}

#[tauri::command]
fn worker_probe_status() -> WorkerRuntimeStatus {
    WorkerRuntimeStatus::rust_backend_active(vec![
        crate::worker_protocol::WorkerDiagnosticLine::new(
            "stdout",
            format!(
                "rust backend protocol {}",
                crate::worker_protocol::WORKER_PROTOCOL_VERSION
            ),
        ),
    ])
}

#[tauri::command]
fn worker_echo_agent(
    input: String,
    state: State<'_, SharedGateway>,
) -> Result<WorkerAgentEchoResult, String> {
    worker_echo_agent_with_options(
        state.inner(),
        input,
        experimental_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_run_agent(
    input: WorkerRunAgentInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_run_agent_with_options(
        state.inner(),
        input.spec,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
fn worker_run_agent_input(
    input: WorkerRunAgentWithInputInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_run_agent_input_with_options(
        state.inner(),
        input.input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
fn worker_skills_list(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_skills_list_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_skills_detail(
    input: WorkerSkillDetailInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_detail_with_options(
        state.inner(),
        input.name,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_skills_create(
    input: WorkerSkillCreateInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_create_with_options(
        state.inner(),
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_skills_update(
    input: WorkerSkillUpdateInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_update_with_options(
        state.inner(),
        input.name,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_skills_delete(
    input: WorkerSkillDetailInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_delete_with_options(
        state.inner(),
        input.name,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_skills_validate(
    input: WorkerSkillDetailInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_validate_with_options(
        state.inner(),
        input.name,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_workspace_files(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_workspace_files_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_workspace_file(
    input: WorkerWorkspaceFileInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_workspace_file_with_options(
        state.inner(),
        input.path,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_workspace_put_file(
    input: WorkerWorkspacePutFileInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_workspace_put_file_with_options(
        state.inner(),
        input.path,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_sessions_list(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_sessions_list_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_messages(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_messages_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_temporary_files(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_temporary_files_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_upload_temporary_file(
    input: WorkerSessionTemporaryFileUploadInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_upload_temporary_file_with_options(
        state.inner(),
        input.key,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_clear_temporary_files(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_clear_temporary_files_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_delete(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_delete_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_patch(
    input: WorkerSessionPatchInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_patch_with_options(
        state.inner(),
        input.key,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_branch(
    input: WorkerSessionBranchInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_branch_with_options(
        state.inner(),
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_clear(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_clear_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_session_task_progress(
    input: WorkerSessionTaskProgressInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_task_progress_with_options(
        state.inner(),
        input.key,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_cowork_route(
    input: WorkerCoworkRouteInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_cowork_route_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(30),
    )
}

#[tauri::command]
fn worker_webui_route(
    input: WorkerWebuiRouteInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let timeout = worker_webui_route_timeout(&input);
    worker_webui_route_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        timeout,
    )
}

#[tauri::command]
fn worker_transport_gateway_frame(
    input: WorkerTransportGatewayFrameInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_transport_gateway_frame_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_transport_websocket_message(
    input: WorkerTransportWebSocketMessageInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_transport_websocket_message_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
async fn worker_transport_dispatch_websocket_message(
    input: WorkerTransportWebSocketDispatchInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let shared = state.inner().clone();
    let workspace_root = native_backend_workspace_root();
    let config_snapshot = experimental_worker_config_snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        worker_transport_dispatch_websocket_message_with_options(
            &shared,
            input,
            workspace_root,
            config_snapshot,
            Duration::from_secs(60),
        )
    })
    .await
    .map_err(|error| format!("worker transport websocket dispatch task failed: {error}"))?
}

#[tauri::command]
fn worker_channel_dispatch_inbound(
    input: WorkerChannelDispatchInboundInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_channel_dispatch_inbound_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
fn worker_channel_start(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_channel_start_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
fn worker_channel_status(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_channel_status_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_channel_stop(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_channel_stop_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
fn worker_channel_login(
    input: WorkerChannelLoginInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_channel_login_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
        input.channel,
        input.force,
    )
}

#[tauri::command]
fn worker_cancel_agent(
    input: WorkerCancelAgentInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_cancel_agent_with_options(
        state.inner(),
        input.run_id,
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_restore_agent_checkpoint(
    input: WorkerRestoreAgentCheckpointInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_restore_agent_checkpoint_with_options(
        state.inner(),
        input.session_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_background_trace_list(
    input: WorkerBackgroundTraceListInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_list_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_background_trace_get_delegate_trace(
    input: WorkerBackgroundTraceGetDelegateTraceInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_get_delegate_trace_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_background_trace_get_artifact(
    input: WorkerBackgroundTraceGetArtifactInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_get_artifact_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_background_trace_append(
    input: WorkerBackgroundTraceAppendInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_append_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_background_subagent_enqueue_input(
    input: WorkerBackgroundSubagentInputInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_subagent_enqueue_input_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSubagentListInput {
    session_key: String,
}

#[tauri::command]
fn worker_subagent_spawn(
    input: SubagentSpawnParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.spawn(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent spawn serialization failed: {error}"))
}

#[tauri::command]
fn worker_subagent_list(
    input: WorkerSubagentListInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    serde_json::to_value(manager.list(&input.session_key))
        .map_err(|error| format!("worker subagent list serialization failed: {error}"))
}

#[tauri::command]
fn worker_subagent_query(
    input: SubagentTargetParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    serde_json::to_value(manager.query(input))
        .map_err(|error| format!("worker subagent query serialization failed: {error}"))
}

#[tauri::command]
fn worker_subagent_send_input(
    input: SubagentSendInputParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.enqueue_input(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent send input serialization failed: {error}"))
}

#[tauri::command]
fn worker_subagent_wait(
    input: SubagentWaitParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    serde_json::to_value(manager.wait(input))
        .map_err(|error| format!("worker subagent wait serialization failed: {error}"))
}

#[tauri::command]
fn worker_subagent_cancel(
    input: SubagentTargetParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.cancel(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent cancel serialization failed: {error}"))
}

#[tauri::command]
fn worker_subagent_close(
    input: SubagentTargetParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.close(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent close serialization failed: {error}"))
}

#[tauri::command]
fn worker_task_plan_list(
    input: WorkerTaskPlanListInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_list_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_task_plan_get(
    input: WorkerTaskPlanIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_get_with_options(
        state.inner(),
        input.plan_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_task_plan_save(
    input: WorkerTaskPlanSaveInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_save_with_options(
        state.inner(),
        input.plan,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_task_plan_delete(
    input: WorkerTaskPlanIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_delete_with_options(
        state.inner(),
        input.plan_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_documents(
    input: WorkerKnowledgeDocumentsInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_documents_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_add_document(
    input: WorkerKnowledgeBodyInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_add_document_with_options(
        state.inner(),
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_document(
    input: WorkerKnowledgeDocumentIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_document_with_options(
        state.inner(),
        input.doc_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_delete_document(
    input: WorkerKnowledgeDocumentIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_delete_document_with_options(
        state.inner(),
        input.doc_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_job(
    input: WorkerKnowledgeJobIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_job_with_options(
        state.inner(),
        input.job_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_rebuild_index(
    input: WorkerKnowledgeRebuildIndexInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_rebuild_index_with_options(
        state.inner(),
        input.rebuild_type,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_stats(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_knowledge_stats_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_graph(
    input: WorkerKnowledgeGraphInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_graph_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_submit_agent_form(
    input: WorkerSubmitAgentFormInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_submit_agent_form_with_options(
        state.inner(),
        input.session_id,
        input.form_id,
        input.values,
        input.action,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
fn worker_resume_agent_approval(
    input: WorkerResumeAgentApprovalInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_resume_agent_approval_with_options(
        state.inner(),
        input.session_id,
        input.approval_id,
        input.approved,
        input.scope,
        input.guidance,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
fn apply_config_patch_result(
    result: ConfigPatchBridgeResult,
) -> Result<ConfigPatchApplyResult, String> {
    apply_config_patch_result_to_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
        result,
    )
}

#[tauri::command]
fn get_config_editor_snapshot() -> Result<ConfigEditorSnapshot, String> {
    config_editor_snapshot_from_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
    )
}

#[tauri::command]
fn apply_config_operations(
    request: ConfigOperationRequest,
) -> Result<ConfigPatchApplyResult, String> {
    apply_config_operations_to_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
        request,
    )
}

fn default_tinybot_config_path() -> PathBuf {
    tinybot_home_dir().join(".tinybot").join("config.json")
}

fn tinybot_home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

fn default_tinybot_workspace_root() -> PathBuf {
    tinybot_home_dir().join(".tinybot").join("workspace")
}

fn apply_config_patch_result_to_path(
    config_path: &Path,
    default_snapshot: serde_json::Value,
    result: ConfigPatchBridgeResult,
) -> Result<ConfigPatchApplyResult, String> {
    let mut store = ConfigStore::load(config_path.to_path_buf(), default_snapshot)
        .map_err(|error| format!("failed to load config store: {error}"))?;
    store
        .apply_validated_patch_result(result)
        .map_err(|error| format!("failed to apply native config patch: {error}"))
}

fn config_editor_snapshot_from_path(
    config_path: &Path,
    default_snapshot: serde_json::Value,
) -> Result<ConfigEditorSnapshot, String> {
    let store = ConfigStore::load(config_path.to_path_buf(), default_snapshot)
        .map_err(|error| format!("failed to load config store: {error}"))?;
    Ok(store.editor_snapshot())
}

fn apply_config_operations_to_path(
    config_path: &Path,
    default_snapshot: serde_json::Value,
    request: ConfigOperationRequest,
) -> Result<ConfigPatchApplyResult, String> {
    let mut store = ConfigStore::load(config_path.to_path_buf(), default_snapshot)
        .map_err(|error| format!("failed to load config store: {error}"))?;
    store
        .apply_operations(request)
        .map_err(|error| format!("failed to apply native config operations: {error}"))
}

fn worker_echo_agent_with_options(
    shared: &SharedGateway,
    input: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<WorkerAgentEchoResult, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_experimental_fixture_running(workspace_root, config_snapshot)?;

    let request_id = next_worker_request_correlation();
    let request = WorkerRequest::new(
        request_id.id("agent-echo"),
        request_id.trace_id("agent-echo"),
        "agent.echo",
        serde_json::json!({ "input": input }),
    );
    let result = client.call(&request, timeout, "worker echo")?;
    serde_json::from_value(result)
        .map_err(|error| format!("worker echo response shape is invalid: {error}"))
}

fn worker_run_agent_with_options(
    shared: &SharedGateway,
    spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = timeout;
    let persistence_spec = spec.clone();
    if let Some(rejection) = reject_native_agent_terminal_run_reentry(
        &persistence_spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )? {
        return Ok(rejection);
    }
    let runtime_spec = hydrate_native_agent_history_for_runtime(
        spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    let start_persistence_error = persist_native_agent_run_start(
        persistence_spec.clone(),
        workspace_root.clone(),
        config_snapshot.clone(),
    )
    .err();
    let mut result =
        run_native_agent_turn_with_config(&services, runtime_spec, config_snapshot.clone())?;
    if let Err(error) = persist_native_agent_run_record(
        persistence_spec.clone(),
        &mut result,
        workspace_root.clone(),
        config_snapshot.clone(),
    ) {
        result["runPersistence"] = serde_json::json!({
            "ok": false,
            "error": error,
        });
    }
    if let Some(error) = start_persistence_error {
        result["runPersistenceDiagnostics"] = serde_json::json!([{
            "phase": "start",
            "ok": false,
            "error": error,
        }]);
    }
    persist_native_agent_checkpoint_if_present(
        &result,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_turn_if_final(
        persistence_spec,
        &mut result,
        workspace_root,
        config_snapshot,
    )?;
    Ok(result)
}

fn reject_native_agent_terminal_run_reentry(
    spec: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let Some(session_id) = native_agent_session_id(spec) else {
        return Ok(None);
    };
    let Some(run_id) = native_agent_run_id(spec) else {
        return Ok(None);
    };
    let request_id = next_worker_request_correlation();
    let existing = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("agent-run-terminal-check"),
            request_id.trace_id("agent-run-terminal-check"),
            "agent_run.get",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
            }),
        ),
        "native agent terminal run check",
    );
    let Ok(existing) = existing else {
        return Ok(None);
    };
    let status = existing
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !matches!(status, "completed" | "failed" | "cancelled") {
        return Ok(None);
    }
    let phase = existing
        .get("phase")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(status);
    let message = format!("agent run `{run_id}` is terminal ({status}) and cannot continue");
    Ok(Some(serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "terminal_turn",
        "messages": [],
        "toolsUsed": [],
        "completedToolResults": [],
        "error": message,
        "terminalRun": {
            "status": status,
            "phase": phase,
        },
        "events": [{
            "eventName": "agent.error",
            "payload": {
                "runId": run_id,
                "sessionId": session_id,
                "stopReason": "terminal_turn",
                "message": message,
                "error": message,
            }
        }],
    })))
}

fn persist_native_agent_run_start(
    spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let session_id =
        native_agent_session_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
    let run_id = native_agent_run_id(&spec).unwrap_or_else(|| "native-rust-run".to_string());
    let record = native_agent_run_record(
        &spec,
        &serde_json::json!({ "sessionId": session_id, "runId": run_id }),
        &config_snapshot,
        &session_id,
        &run_id,
    );
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("agent-run-start-native"),
            request_id.trace_id("agent-run-start-native"),
            "agent_run.upsert",
            serde_json::json!({ "record": record }),
        ),
        "native agent run start persistence",
    )?;
    Ok(())
}

fn persist_native_agent_run_record(
    spec: serde_json::Value,
    result: &mut serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let session_id = native_agent_session_id(result)
        .or_else(|| native_agent_session_id(&spec))
        .ok_or_else(|| "Rust agent run missing session id for persistence".to_string())?;
    let run_id = native_agent_run_id(result)
        .or_else(|| native_agent_run_id(&spec))
        .unwrap_or_else(|| "native-rust-run".to_string());
    let record = native_agent_run_record(&spec, result, &config_snapshot, &session_id, &run_id);
    let request_id = next_worker_request_correlation();
    let persisted = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("agent-run-upsert-native"),
            request_id.trace_id("agent-run-upsert-native"),
            "agent_run.upsert",
            serde_json::json!({ "record": record }),
        ),
        "native agent run persistence",
    )?;
    result["runPersistence"] = persisted;
    Ok(())
}

fn native_agent_run_record(
    spec: &serde_json::Value,
    result: &serde_json::Value,
    config_snapshot: &serde_json::Value,
    session_id: &str,
    run_id: &str,
) -> serde_json::Value {
    let timestamp = now_unix_ms().to_string();
    let stop_reason = result
        .get("stopReason")
        .or_else(|| result.get("stop_reason"))
        .and_then(serde_json::Value::as_str);
    let status = native_agent_run_status(stop_reason);
    let checkpoint = result
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .cloned();
    let phase = checkpoint
        .as_ref()
        .and_then(|value| value.get("phase"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| native_agent_run_phase_from_stop_reason(stop_reason))
        .unwrap_or("planning");
    let error = result
        .get("error")
        .filter(|value| !value.is_null())
        .cloned();

    serde_json::json!({
        "sessionId": session_id,
        "runId": run_id,
        "status": status,
        "phase": phase,
        "startedAt": timestamp,
        "updatedAt": timestamp,
        "completedAt": native_agent_run_completed_at(status, &timestamp),
        "stopReason": stop_reason,
        "model": native_agent_model(spec, config_snapshot),
        "provider": native_agent_provider(spec, config_snapshot),
        "maxIterations": native_agent_max_iterations(spec, config_snapshot),
        "currentIteration": native_agent_current_iteration(result, checkpoint.as_ref()),
        "conversationMessageIds": [],
        "traceMessages": native_agent_assistant_messages(result),
        "traceEvents": native_agent_runtime_trace_events(result, session_id, run_id, &timestamp),
        "completedToolResults": result
            .get("completedToolResults")
            .or_else(|| result.get("completed_tool_results"))
            .and_then(serde_json::Value::as_array)
            .map(|values| native_agent_persisted_trace_values(values))
            .unwrap_or_default(),
        "pendingToolCalls": checkpoint
            .as_ref()
            .and_then(|value| value.get("pendingToolCalls").or_else(|| value.get("pending_tool_calls")))
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default(),
        "checkpoint": checkpoint,
        "artifacts": native_agent_artifacts(result),
        "usage": native_agent_usage(result),
        "error": error,
    })
}

fn native_agent_run_status(stop_reason: Option<&str>) -> &'static str {
    match stop_reason {
        Some("final_response") => "completed",
        Some("cancelled") => "cancelled",
        Some("awaiting_approval")
        | Some("awaiting_form")
        | Some("awaiting_tool")
        | Some("tool_running")
        | Some("awaiting_subagent") => "waiting",
        Some(_) => "failed",
        None => "running",
    }
}

fn native_agent_run_phase_from_stop_reason(stop_reason: Option<&str>) -> Option<&'static str> {
    match stop_reason {
        Some("final_response") => Some("completed"),
        Some("cancelled") => Some("cancelled"),
        Some("awaiting_approval") => Some("awaiting_approval"),
        Some("awaiting_form") => Some("awaiting_form"),
        Some("awaiting_tool") => Some("tool_running"),
        Some(_) => Some("failed"),
        None => None,
    }
}

fn native_agent_run_completed_at(status: &str, timestamp: &str) -> Option<String> {
    matches!(status, "completed" | "failed" | "cancelled").then(|| timestamp.to_string())
}

fn native_agent_session_id(value: &serde_json::Value) -> Option<String> {
    native_agent_string_field(value, "sessionId")
        .or_else(|| native_agent_string_field(value, "session_id"))
        .or_else(|| native_agent_string_field(value, "activeSessionId"))
        .or_else(|| native_agent_string_field(value, "active_session_id"))
        .or_else(|| native_agent_string_field(value, "sessionKey"))
        .or_else(|| native_agent_string_field(value, "session_key"))
}

fn native_agent_run_id(value: &serde_json::Value) -> Option<String> {
    native_agent_string_field(value, "runId").or_else(|| native_agent_string_field(value, "run_id"))
}

fn native_agent_model(spec: &serde_json::Value, config_snapshot: &serde_json::Value) -> String {
    native_agent_string_field(spec, "model")
        .or_else(|| native_agent_string_field(spec, "modelId"))
        .or_else(|| native_agent_string_field(spec, "model_id"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "model"))
        })
        .unwrap_or_else(|| crate::native_provider_runtime::configured_model(config_snapshot))
}

fn native_agent_provider(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
) -> Option<String> {
    native_agent_string_field(spec, "provider")
        .or_else(|| native_agent_string_field(spec, "providerId"))
        .or_else(|| native_agent_string_field(spec, "provider_id"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "provider"))
        })
        .or_else(|| {
            config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| native_agent_string_field(defaults, "provider"))
        })
}

fn native_agent_max_iterations(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
) -> i64 {
    spec.get("maxIterations")
        .or_else(|| spec.get("max_iterations"))
        .or_else(|| {
            spec.get("metadata").and_then(|metadata| {
                metadata
                    .get("maxIterations")
                    .or_else(|| metadata.get("max_iterations"))
            })
        })
        .or_else(|| {
            config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| {
                    defaults
                        .get("maxIterations")
                        .or_else(|| defaults.get("max_iterations"))
                })
        })
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
}

fn native_agent_current_iteration(
    result: &serde_json::Value,
    checkpoint: Option<&serde_json::Value>,
) -> i64 {
    checkpoint
        .and_then(|value| value.get("iteration"))
        .and_then(serde_json::Value::as_i64)
        .or_else(|| {
            result
                .get("events")
                .and_then(serde_json::Value::as_array)
                .and_then(|events| {
                    events
                        .iter()
                        .rev()
                        .filter_map(|event| event.get("payload"))
                        .filter_map(|payload| payload.get("iteration"))
                        .find_map(serde_json::Value::as_i64)
                })
        })
        .unwrap_or(0)
}

fn native_agent_usage(result: &serde_json::Value) -> Vec<serde_json::Value> {
    result
        .get("events")
        .and_then(serde_json::Value::as_array)
        .map(|events| {
            events
                .iter()
                .filter(|event| {
                    event.get("eventName").and_then(serde_json::Value::as_str)
                        == Some("agent.usage")
                })
                .filter_map(|event| event.get("payload"))
                .filter_map(|payload| payload.get("usage"))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn native_agent_runtime_trace_events(
    result: &serde_json::Value,
    session_id: &str,
    run_id: &str,
    timestamp: &str,
) -> Vec<serde_json::Value> {
    let mut appender = AgentRuntimeEventAppender::new(session_id, run_id);
    let mut trace_events = vec![native_agent_persisted_runtime_event(appender.append(
        AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.turn.started".to_string(),
            phase: AgentRuntimePhase::Planning,
            timestamp: timestamp.to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: serde_json::json!({
                "sessionId": session_id,
                "runId": run_id,
            }),
        },
    ))];

    let mut current_phase = AgentRuntimePhase::Planning;
    native_agent_push_phase_transition(
        &mut trace_events,
        &mut appender,
        &mut current_phase,
        AgentRuntimePhase::HydratingHistory,
        timestamp,
        "agent.history.hydrated",
    );
    native_agent_push_phase_transition(
        &mut trace_events,
        &mut appender,
        &mut current_phase,
        AgentRuntimePhase::CallingModel,
        timestamp,
        "agent.model.calling",
    );
    if let Some(events) = result.get("events").and_then(serde_json::Value::as_array) {
        for event in events {
            let event_name = event
                .get("eventName")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty());
            let Some(event_name) = event_name else {
                continue;
            };
            let next_phase = AgentRuntimePhase::for_legacy_event(event_name);
            if event_name == "agent.done" {
                native_agent_push_phase_transition(
                    &mut trace_events,
                    &mut appender,
                    &mut current_phase,
                    AgentRuntimePhase::Finalizing,
                    timestamp,
                    event_name,
                );
            }
            native_agent_push_phase_transition(
                &mut trace_events,
                &mut appender,
                &mut current_phase,
                next_phase,
                timestamp,
                event_name,
            );
            let payload = event.get("payload").cloned().unwrap_or(serde_json::Value::Null);
            trace_events.push(native_agent_persisted_runtime_event(
                appender.append_legacy_native_event(
                    event_name,
                    native_agent_trace_event_item_id(event),
                    timestamp,
                    payload,
                ),
            ));
        }
    }

    trace_events
}

fn native_agent_push_phase_transition(
    trace_events: &mut Vec<serde_json::Value>,
    appender: &mut AgentRuntimeEventAppender,
    current_phase: &mut AgentRuntimePhase,
    next_phase: AgentRuntimePhase,
    timestamp: &str,
    trigger_event_name: &str,
) {
    if next_phase == *current_phase {
        return;
    }
    trace_events.push(native_agent_persisted_runtime_event(appender.append(
        AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.phase.changed".to_string(),
            phase: next_phase.clone(),
            timestamp: timestamp.to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::Debug,
            payload: serde_json::json!({
                "previousPhase": current_phase.clone(),
                "nextPhase": next_phase.clone(),
                "triggerEventName": trigger_event_name,
            }),
        },
    )));
    *current_phase = next_phase;
}

fn native_agent_persisted_runtime_event(
    event: AgentRuntimeEventEnvelope,
) -> serde_json::Value {
    let value = serde_json::to_value(event).unwrap_or_else(|error| {
        serde_json::json!({
            "schemaVersion": crate::agent_loop_runtime_protocol::AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
            "eventName": "agent.trace.serialization_failed",
            "payload": {
                "error": error.to_string(),
            },
        })
    });
    native_agent_bound_persisted_trace_value(value).0
}

fn native_agent_trace_event_item_id(event: &serde_json::Value) -> Option<String> {
    event
        .get("payload")
        .and_then(|payload| {
            native_agent_string_field(payload, "toolCallId")
                .or_else(|| native_agent_string_field(payload, "tool_call_id"))
                .or_else(|| native_agent_string_field(payload, "approvalId"))
                .or_else(|| native_agent_string_field(payload, "approval_id"))
                .or_else(|| native_agent_string_field(payload, "formId"))
                .or_else(|| native_agent_string_field(payload, "form_id"))
                .or_else(|| native_agent_string_field(payload, "delegateId"))
                .or_else(|| native_agent_string_field(payload, "delegate_id"))
        })
}

fn native_agent_persisted_trace_values(values: &[serde_json::Value]) -> Vec<serde_json::Value> {
    values
        .iter()
        .cloned()
        .map(|value| native_agent_bound_persisted_trace_value(value).0)
        .collect()
}

fn native_agent_bound_persisted_trace_value(value: serde_json::Value) -> (serde_json::Value, bool) {
    match value {
        serde_json::Value::String(content) => {
            let char_count = content.chars().count();
            if char_count <= NATIVE_AGENT_RUN_TRACE_STRING_LIMIT {
                (serde_json::Value::String(content), false)
            } else {
                (
                    serde_json::Value::String(
                        content
                            .chars()
                            .take(NATIVE_AGENT_RUN_TRACE_STRING_LIMIT)
                            .collect(),
                    ),
                    true,
                )
            }
        }
        serde_json::Value::Array(items) => {
            let mut truncated = false;
            let items = items
                .into_iter()
                .map(|item| {
                    let (item, item_truncated) = native_agent_bound_persisted_trace_value(item);
                    truncated |= item_truncated;
                    item
                })
                .collect();
            (serde_json::Value::Array(items), truncated)
        }
        serde_json::Value::Object(entries) => {
            let mut truncated = false;
            let mut entries = entries
                .into_iter()
                .map(|(key, value)| {
                    let (value, value_truncated) = native_agent_bound_persisted_trace_value(value);
                    truncated |= value_truncated;
                    (key, value)
                })
                .collect::<serde_json::Map<_, _>>();
            if truncated {
                entries.insert(
                    "tracePersistence".to_string(),
                    serde_json::json!({
                        "truncated": true,
                        "maxStringChars": NATIVE_AGENT_RUN_TRACE_STRING_LIMIT,
                    }),
                );
            }
            (serde_json::Value::Object(entries), truncated)
        }
        value => (value, false),
    }
}

fn native_agent_artifacts(result: &serde_json::Value) -> Vec<serde_json::Value> {
    result
        .get("completedToolResults")
        .or_else(|| result.get("completed_tool_results"))
        .and_then(serde_json::Value::as_array)
        .map(|results| {
            results
                .iter()
                .flat_map(|result| {
                    result
                        .get("envelope")
                        .and_then(|envelope| envelope.get("artifacts"))
                        .and_then(serde_json::Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn native_agent_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn persist_native_agent_checkpoint_if_present(
    result: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let Some(checkpoint) = result.get("checkpoint").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let session_id = result
        .get("sessionId")
        .or_else(|| result.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Rust agent checkpoint missing session id".to_string())?;
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-set-native-checkpoint"),
            request_id.trace_id("session-set-native-checkpoint"),
            "session.set_checkpoint",
            serde_json::json!({
                "session_id": session_id,
                "checkpoint": checkpoint,
            }),
        ),
        "native agent checkpoint persistence",
    )?;
    Ok(())
}

fn persist_native_agent_turn_if_final(
    spec: serde_json::Value,
    result: &mut serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    if result.get("stopReason").and_then(serde_json::Value::as_str) != Some("final_response") {
        return Ok(());
    }
    let session_id = spec
        .get("sessionId")
        .or_else(|| spec.get("session_id"))
        .or_else(|| spec.get("activeSessionId"))
        .or_else(|| spec.get("active_session_id"))
        .or_else(|| spec.get("sessionKey"))
        .or_else(|| spec.get("session_key"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Rust agent turn missing session id for persistence".to_string())?;
    let run_id = result
        .get("runId")
        .or_else(|| result.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-rust-run");
    let mut messages = native_agent_user_messages(&spec);
    messages.extend(native_agent_assistant_messages(result));
    if messages.is_empty() {
        return Ok(());
    }
    let request_id = next_worker_request_correlation();
    let persisted = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-persist-native-turn"),
            request_id.trace_id("session-persist-native-turn"),
            "session.persist_turn",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
                "messages": messages,
                "clear_checkpoint": true,
                "context_metadata": {
                    "runtime": "rust",
                    "historyMessageCount": native_agent_user_messages(&spec).len(),
                }
            }),
        ),
        "native agent session persistence",
    )?;
    result["sessionPersistence"] = persisted;
    Ok(())
}

fn native_agent_user_messages(spec: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(messages) = spec.get("messages").and_then(serde_json::Value::as_array) {
        return messages
            .iter()
            .filter(|message| {
                message.get("role").and_then(serde_json::Value::as_str) == Some("user")
            })
            .cloned()
            .collect();
    }
    let Some(input) = spec.get("input").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    let content = input
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if content.trim().is_empty() {
        Vec::new()
    } else {
        vec![serde_json::json!({
            "role": input
                .get("role")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("user"),
            "content": content,
        })]
    }
}

fn native_agent_assistant_messages(result: &serde_json::Value) -> Vec<serde_json::Value> {
    result
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter(|message| {
                    message.get("role").and_then(serde_json::Value::as_str) == Some("assistant")
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn hydrate_native_agent_history_for_runtime(
    mut spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let Some(session_id) = native_agent_session_id(&spec) else {
        return Ok(spec);
    };
    let requested_messages = native_agent_runtime_messages(&spec);
    if requested_messages.is_empty() {
        return Ok(spec);
    }
    let history_messages =
        native_agent_session_history_messages(&session_id, workspace_root, config_snapshot)?;
    if history_messages.is_empty() {
        return Ok(spec);
    }

    let combined_messages =
        native_agent_merge_history_messages(&history_messages, &requested_messages);
    if let Some(object) = spec.as_object_mut() {
        object.insert(
            "messages".to_string(),
            serde_json::Value::Array(combined_messages),
        );
    }
    Ok(spec)
}

fn native_agent_runtime_messages(spec: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(messages) = spec.get("messages").and_then(serde_json::Value::as_array) {
        if !messages.is_empty() {
            return messages.clone();
        }
    }
    native_agent_user_messages(spec)
}

fn native_agent_session_history_messages(
    session_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<Vec<serde_json::Value>, String> {
    let request_id = next_worker_request_correlation();
    let history = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-history-for-agent-run"),
            request_id.trace_id("session-history-for-agent-run"),
            "session.get_history",
            serde_json::json!({ "session_id": session_id, "limit": 500 }),
        ),
        "native agent session history hydration",
    )?;
    Ok(history
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn native_agent_merge_history_messages(
    history_messages: &[serde_json::Value],
    requested_messages: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut combined = Vec::new();
    for message in requested_messages
        .iter()
        .filter(|message| native_agent_instruction_message(message))
    {
        combined.push(message.clone());
    }

    let requested_body: Vec<_> = requested_messages
        .iter()
        .filter(|message| !native_agent_instruction_message(message))
        .cloned()
        .collect();
    let history_body: Vec<_> = history_messages
        .iter()
        .filter(|message| !native_agent_instruction_message(message))
        .cloned()
        .collect();

    if native_agent_messages_start_with(&requested_body, &history_body) {
        combined.extend(requested_body);
    } else {
        combined.extend(history_body);
        combined.extend(requested_body);
    }
    combined
}

fn native_agent_instruction_message(message: &serde_json::Value) -> bool {
    matches!(
        message.get("role").and_then(serde_json::Value::as_str),
        Some("system" | "developer")
    )
}

fn native_agent_messages_start_with(
    messages: &[serde_json::Value],
    prefix: &[serde_json::Value],
) -> bool {
    !prefix.is_empty()
        && messages.len() >= prefix.len()
        && messages
            .iter()
            .zip(prefix.iter())
            .all(|(message, prefix)| message == prefix)
}

fn worker_run_agent_input_with_options(
    shared: &SharedGateway,
    input: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    worker_run_agent_with_options(shared, input, workspace_root, config_snapshot, timeout)
}

fn worker_skills_list_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_list_request(next_worker_request_correlation()),
        "worker skills list",
    )
}

fn build_worker_skills_list_request(request_id: WorkerRequestCorrelation) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-list"),
        request_id.trace_id("skills-list"),
        "skills.webui_list",
        serde_json::json!({}),
    )
}

fn worker_skills_detail_with_options(
    _shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_detail_request(next_worker_request_correlation(), name),
        "worker skills detail",
    )
}

fn build_worker_skills_detail_request(
    request_id: WorkerRequestCorrelation,
    name: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-detail"),
        request_id.trace_id("skills-detail"),
        "skills.webui_detail",
        serde_json::json!({ "name": name }),
    )
}

fn worker_skills_create_with_options(
    _shared: &SharedGateway,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_create_request(next_worker_request_correlation(), body),
        "worker skills create",
    )
}

fn build_worker_skills_create_request(
    request_id: WorkerRequestCorrelation,
    body: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-create"),
        request_id.trace_id("skills-create"),
        "skills.webui_create",
        serde_json::json!({ "body": body }),
    )
}

fn worker_skills_update_with_options(
    _shared: &SharedGateway,
    name: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_update_request(next_worker_request_correlation(), name, body),
        "worker skills update",
    )
}

fn build_worker_skills_update_request(
    request_id: WorkerRequestCorrelation,
    name: String,
    body: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-update"),
        request_id.trace_id("skills-update"),
        "skills.webui_update",
        serde_json::json!({ "name": name, "body": body }),
    )
}

fn worker_skills_delete_with_options(
    _shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_delete_request(next_worker_request_correlation(), name),
        "worker skills delete",
    )
}

fn build_worker_skills_delete_request(
    request_id: WorkerRequestCorrelation,
    name: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-delete"),
        request_id.trace_id("skills-delete"),
        "skills.webui_delete",
        serde_json::json!({ "name": name }),
    )
}

fn worker_skills_validate_with_options(
    _shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_validate_request(next_worker_request_correlation(), name),
        "worker skills validate",
    )
}

fn build_worker_skills_validate_request(
    request_id: WorkerRequestCorrelation,
    name: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-validate"),
        request_id.trace_id("skills-validate"),
        "skills.webui_validate",
        serde_json::json!({ "name": name }),
    )
}

fn worker_workspace_files_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let items = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-files"),
            request_id.trace_id("workspace-files"),
            "workspace.list_files",
            serde_json::json!({}),
        ),
        "worker workspace files",
    )?;
    Ok(serde_json::json!({ "items": items }))
}

fn worker_workspace_file_with_options(
    _shared: &SharedGateway,
    path: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-file"),
            request_id.trace_id("workspace-file"),
            "workspace.read_file",
            serde_json::json!({ "path": path, "format": "raw" }),
        ),
        "worker workspace file",
    )
}

fn worker_workspace_put_file_with_options(
    _shared: &SharedGateway,
    path: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let contents = body
        .get("content")
        .or_else(|| body.get("contents"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "worker workspace put file failed: content is required".to_string())?;
    let expected_updated_at = body
        .get("expectedUpdatedAt")
        .or_else(|| body.get("expected_updated_at"))
        .and_then(|value| value.as_str());
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-put-file"),
            request_id.trace_id("workspace-put-file"),
            "workspace.write_file",
            serde_json::json!({
                "path": path,
                "contents": contents,
                "expected_updated_at": expected_updated_at,
                "internal_operation": true,
            }),
        ),
        "worker workspace put file",
    )
}

fn worker_sessions_list_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let sessions = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("sessions-list"),
            request_id.trace_id("sessions-list"),
            "session.list_metadata",
            serde_json::json!({}),
        ),
        "worker sessions list",
    )?;
    let items = sessions
        .as_array()
        .ok_or_else(|| "worker sessions list failed: response was not an array".to_string())?
        .iter()
        .map(webui_session_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(serde_json::json!({ "items": items }))
}

fn worker_session_messages_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut history = call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("session-messages"),
            request_id.trace_id("session-messages"),
            "session.get_history",
            serde_json::json!({ "session_id": key, "limit": 500 }),
        ),
        "worker session messages",
    )?;
    let object = history
        .as_object_mut()
        .ok_or_else(|| "worker session messages failed: response was not an object".to_string())?;
    let session_id = object
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    object.insert(
        "key".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    object.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&session_id)),
    );
    enrich_session_history_metadata(object, &session_id, workspace_root, config_snapshot);
    Ok(history)
}

fn worker_session_temporary_files_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-temporary-files"),
            request_id.trace_id("session-temporary-files"),
            "knowledge.session_list",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session temporary files",
    )?;
    add_session_key_fields(&mut result)?;
    Ok(result)
}

fn worker_session_upload_temporary_file_with_options(
    _shared: &SharedGateway,
    key: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-upload-temporary-file"),
            request_id.trace_id("session-upload-temporary-file"),
            "session.temporary_file.upload",
            serde_json::json!({
                "session_id": key,
                "name": body.get("name").and_then(serde_json::Value::as_str).unwrap_or_default(),
                "file_type": body.get("file_type")
                    .or_else(|| body.get("fileType"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
                "content": body.get("content").and_then(serde_json::Value::as_str).unwrap_or_default(),
                "size_bytes": body.get("size_bytes")
                    .or_else(|| body.get("sizeBytes"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default(),
            }),
        ),
        "worker session temporary file upload",
    )
}

fn worker_session_clear_temporary_files_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-clear-temporary-files"),
            request_id.trace_id("session-clear-temporary-files"),
            "knowledge.session_clear",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session temporary files clear",
    )?;
    add_session_key_fields(&mut result)?;
    Ok(result)
}

fn worker_session_delete_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-delete"),
            request_id.trace_id("session-delete"),
            "session.delete",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session delete",
    )?;
    add_session_key_fields(&mut result)?;
    Ok(result)
}

fn worker_session_patch_with_options(
    _shared: &SharedGateway,
    key: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let metadata = body
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| body.clone());
    let request_id = next_worker_request_correlation();
    let session = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-patch"),
            request_id.trace_id("session-patch"),
            "session.patch_metadata",
            serde_json::json!({ "session_id": key, "metadata": metadata }),
        ),
        "worker session patch",
    )?;
    webui_session_item(&session)
}

fn worker_session_branch_with_options(
    _shared: &SharedGateway,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let branch_key = branch_session_key(&body, request_id.suffix());
    let messages = branch_messages(&body);
    if messages.is_empty() {
        return Err("worker session branch failed: branch messages are required".to_string());
    }
    let title = branch_string(&body, "title").unwrap_or_else(|| "Branched session".to_string());
    let source_session = branch_string(&body, "branchedFromSessionId")
        .or_else(|| branch_string(&body, "branched_from_session_id"))
        .unwrap_or_default();
    let source_message = branch_string(&body, "branchedFromMessageId")
        .or_else(|| branch_string(&body, "branched_from_message_id"))
        .unwrap_or_default();
    let portable_context = body
        .get("portableContext")
        .or_else(|| body.get("portable_context"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("session-branch-append"),
            request_id.trace_id("session-branch-append"),
            "session.append_messages",
            serde_json::json!({
                "session_id": branch_key.clone(),
                "messages": messages,
            }),
        ),
        "worker session branch append",
    )?;
    let session = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-branch-metadata"),
            request_id.trace_id("session-branch-metadata"),
            "session.patch_metadata",
            serde_json::json!({
                "session_id": branch_key,
                "metadata": {
                    "title": title,
                    "branch": {
                        "branchedFromSessionId": source_session,
                        "branchedFromMessageId": source_message,
                        "portableContext": portable_context,
                    },
                },
            }),
        ),
        "worker session branch metadata",
    )?;
    webui_session_item(&session)
}

fn worker_session_clear_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-clear"),
            request_id.trace_id("session-clear"),
            "session.clear",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session clear",
    )?;
    add_session_key_fields(&mut result)?;
    Ok(result)
}

fn worker_session_task_progress_with_options(
    _shared: &SharedGateway,
    key: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let plan_id = body
        .get("planId")
        .or_else(|| body.get("plan_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let progress = body
        .get("progress")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let content = body
        .get("content")
        .or_else(|| body.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Task progress updated.");
    let request_id = next_worker_request_correlation();
    let session = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-task-progress"),
            request_id.trace_id("session-task-progress"),
            "session.task_progress.upsert",
            serde_json::json!({
                "session_id": key,
                "plan_id": plan_id,
                "progress": progress,
                "content": content,
            }),
        ),
        "worker session task progress",
    )?;
    webui_session_item(&session)
}

fn webui_session_item(session: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut item = session
        .as_object()
        .cloned()
        .ok_or_else(|| "worker sessions list failed: session item was not an object".to_string())?;
    let session_id = item
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    item.insert(
        "key".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    item.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&session_id)),
    );
    if let Some(metadata) = item
        .get("extra")
        .and_then(|extra| extra.get("metadata"))
        .cloned()
    {
        if let Some(title) = metadata.get("title").and_then(serde_json::Value::as_str) {
            item.insert(
                "title".to_string(),
                serde_json::Value::String(title.to_string()),
            );
        }
        item.insert("metadata".to_string(), metadata);
    }
    Ok(serde_json::Value::Object(item))
}

fn enrich_session_history_metadata(
    object: &mut serde_json::Map<String, serde_json::Value>,
    session_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) {
    let request_id = next_worker_request_correlation();
    let Ok(metadata) = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-history-metadata"),
            request_id.trace_id("session-history-metadata"),
            "session.get_metadata",
            serde_json::json!({ "session_id": session_id }),
        ),
        "worker session history metadata",
    ) else {
        return;
    };
    if let Some(branch) = metadata
        .get("extra")
        .and_then(|extra| extra.get("metadata"))
        .and_then(|metadata| metadata.get("branch"))
        .cloned()
    {
        object.insert("branch".to_string(), branch);
    }
}

fn branch_session_key(body: &serde_json::Value, fallback_suffix: &str) -> String {
    branch_string(body, "sessionKey")
        .or_else(|| branch_string(body, "session_key"))
        .unwrap_or_else(|| format!("websocket:branch-{fallback_suffix}"))
}

fn branch_messages(body: &serde_json::Value) -> Vec<serde_json::Value> {
    body.get("messages")
        .and_then(serde_json::Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .map(|message| {
                    serde_json::json!({
                        "message_id": branch_string(message, "messageId")
                            .or_else(|| branch_string(message, "message_id"))
                            .unwrap_or_default(),
                        "role": branch_string(message, "role").unwrap_or_else(|| "assistant".to_string()),
                        "content": branch_string(message, "content").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn branch_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn add_session_key_fields(value: &mut serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "worker session operation failed: response was not an object".to_string())?;
    let session_id = object
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    object.insert(
        "key".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    object.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&session_id)),
    );
    Ok(())
}

fn session_chat_id_from_key(key: &str) -> String {
    key.split_once(':')
        .map(|(_, chat_id)| chat_id)
        .unwrap_or(key)
        .to_string()
}

fn worker_cowork_route_with_options(
    _shared: &SharedGateway,
    input: WorkerCoworkRouteInput,
    workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    if let Some(response) = worker_cowork_rust_route_with_options(&input, workspace_root.clone()) {
        return response;
    }

    let method = input.method.to_ascii_uppercase();
    let (path, _) = split_webui_route_path(&input.path);
    Ok(unsupported_webui_route_response(
        &method,
        &path,
        "cowork route unavailable in the Rust-only backend",
    ))
}

fn worker_cowork_rust_route_with_options(
    input: &WorkerCoworkRouteInput,
    workspace_root: PathBuf,
) -> Option<Result<serde_json::Value, String>> {
    let method = input.method.to_ascii_uppercase();
    let (path, path_query) = split_webui_route_path(&input.path);
    let mut query = path_query;
    if let Some(input_query) = input.query.as_ref().and_then(serde_json::Value::as_object) {
        for (key, value) in input_query {
            if let Some(value) = value.as_str() {
                query.insert(key.clone(), value.to_string());
            }
        }
    }
    let runtime = WorkerCoworkRuntime::new(workspace_root);
    let result = match (method.as_str(), path.as_str()) {
        ("GET", "/api/cowork/sessions") => Some(
            runtime.list_sessions(
                query
                    .get("include_completed")
                    .is_some_and(|value| matches!(value.as_str(), "1" | "true")),
            ),
        ),
        ("POST", "/api/cowork/sessions") => Some(
            runtime.create_session(input.body.clone().unwrap_or_else(|| serde_json::json!({}))),
        ),
        ("POST", "/api/cowork/blueprints/validate") => Some(runtime.validate_blueprint(
            input.body.clone().unwrap_or_else(|| serde_json::json!({})),
            false,
        )),
        ("POST", "/api/cowork/blueprints/preview") => Some(runtime.validate_blueprint(
            input.body.clone().unwrap_or_else(|| serde_json::json!({})),
            true,
        )),
        _ => worker_cowork_rust_dynamic_route(
            &runtime,
            &method,
            &path,
            input.body.clone().unwrap_or_else(|| serde_json::json!({})),
            &query,
        ),
    };

    result.map(|result| {
        result
            .map(|body| webui_route_response(200, body, "rust", "cowork"))
            .or_else(|error| {
                Ok(webui_route_response(
                    500,
                    serde_json::json!({ "error": { "message": error } }),
                    "rust",
                    "cowork",
                ))
            })
    })
}

fn worker_cowork_rust_dynamic_route(
    runtime: &WorkerCoworkRuntime,
    method: &str,
    path: &str,
    body: serde_json::Value,
    query: &HashMap<String, String>,
) -> Option<Result<serde_json::Value, String>> {
    let rest = path.strip_prefix("/api/cowork/sessions/")?;
    let mut parts = rest.split('/').map(percent_decode).collect::<Vec<_>>();
    if parts.is_empty() || parts[0].is_empty() {
        return None;
    }
    let session_id = parts.remove(0);
    if method == "GET" && parts.is_empty() {
        return Some(runtime.get_session(&session_id).map(|session| {
            session.unwrap_or_else(|| serde_json::json!({ "error": "cowork session not found" }))
        }));
    }
    if method == "GET" && parts.len() == 1 {
        return Some(runtime.session_view(&session_id, &parts[0]).map(|view| {
            view.unwrap_or_else(|| serde_json::json!({ "error": "cowork session not found" }))
        }));
    }
    if method == "DELETE" && parts.is_empty() {
        return Some(runtime.delete_session(&session_id));
    }
    if method == "POST" && parts.len() == 1 {
        return match parts[0].as_str() {
            "run" => Some(runtime.run_session(&session_id, body)),
            "budget" => Some(runtime.update_budget(&session_id, body)),
            "pause" | "resume" | "emergency-stop" => {
                Some(runtime.session_action(&session_id, &parts[0], body))
            }
            "messages" => Some(runtime.append_message(&session_id, body)),
            "tasks" => Some(runtime.add_task(&session_id, body)),
            _ => None,
        };
    }
    if method == "PATCH" && parts.len() == 1 && parts[0] == "budget" {
        return Some(runtime.update_budget(&session_id, body));
    }
    if method == "GET" && parts.len() == 3 && parts[0] == "agents" && parts[2] == "activity" {
        let limit = query
            .get("limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(50);
        return Some(runtime.agent_activity(&session_id, &parts[1], limit));
    }
    if method == "GET" && parts.len() == 2 && parts[0] == "observations" {
        return Some(runtime.observation(&session_id, &parts[1]));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "tasks" {
        return Some(runtime.task_action(&session_id, &parts[1], &parts[2], body));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "work-units" {
        return Some(runtime.work_unit_action(&session_id, &parts[1], &parts[2], body));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "branches" && parts[2] == "select" {
        return Some(runtime.select_branch(&session_id, &parts[1], body));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "branches" && parts[2] == "derive" {
        return Some(runtime.derive_branch(&session_id, Some(&parts[1]), body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "branches" && parts[1] == "derive" {
        return Some(runtime.derive_branch(&session_id, None, body));
    }
    if method == "POST"
        && parts.len() == 4
        && parts[0] == "branches"
        && parts[2] == "result"
        && parts[3] == "select-final"
    {
        return Some(runtime.select_branch_result(&session_id, &parts[1], body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "branch-results" && parts[1] == "merge" {
        return Some(runtime.merge_branch_results(&session_id, body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "final-result" && parts[1] == "select" {
        return Some(runtime.select_final_result(&session_id, body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "final-result" && parts[1] == "merge" {
        return Some(runtime.merge_final_result(&session_id, body));
    }
    None
}

fn worker_webui_route_with_options(
    shared: &SharedGateway,
    input: WorkerWebuiRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let method = input.method.to_ascii_uppercase();
    let (path, _) = split_webui_route_path(&input.path);
    if let Some(response) = worker_webui_rust_route_with_options(
        shared,
        &input,
        workspace_root.clone(),
        config_snapshot.clone(),
        timeout,
    )? {
        return Ok(response);
    }

    Ok(unsupported_webui_route_response(
        &method,
        &path,
        "webui control route unavailable in the Rust-only backend",
    ))
}

fn worker_webui_rust_route_with_options(
    shared: &SharedGateway,
    input: &WorkerWebuiRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<Option<serde_json::Value>, String> {
    let method = input.method.to_ascii_uppercase();
    let (path, query) = split_webui_route_path(&input.path);
    let body = input.body.clone().unwrap_or(serde_json::Value::Null);

    if method == "POST" && path == "/v1/chat/completions" {
        return Ok(Some(
            crate::native_provider_runtime::openai_chat_completions_route(&config_snapshot, &body),
        ));
    }
    if method == "POST" {
        if let Some((form_id, cancelled)) = webui_agent_ui_form_route(&path) {
            let (status, body) = native_webui_agent_ui_form_resolution_body(
                shared,
                form_id,
                &body,
                cancelled,
                workspace_root,
                config_snapshot,
            )?;
            return Ok(Some(webui_route_response(
                status,
                body,
                "rust",
                webui_route_group(&path),
            )));
        }
    }

    let result = match (method.as_str(), path.as_str()) {
        ("GET", "/health") => Some(Ok(serde_json::json!({
            "ok": true,
            "status": "ok",
            "runtime": "native-rust"
        }))),
        ("GET", "/webui/bootstrap") => Some(Ok(native_webui_bootstrap_body())),
        ("POST", "/webui/refresh-token") => Some(Ok(native_webui_bootstrap_body())),
        ("GET", "/api/status") => Some(Ok(native_webui_status_body(shared))),
        ("GET", "/api/config") => Some(worker_webui_config_body(
            workspace_root.clone(),
            config_snapshot.clone(),
        )),
        ("GET", "/api/providers") => Some(Ok(
            crate::native_provider_runtime::provider_catalog_body(&config_snapshot),
        )),
        ("POST", "/api/provider-models") => Some(Ok(
            crate::native_provider_runtime::provider_models_body(&config_snapshot, &body),
        )),
        ("GET", "/v1/models") => Some(Ok(crate::native_provider_runtime::openai_models_body(
            &config_snapshot,
        ))),
        ("GET", "/api/sessions") => Some(worker_sessions_list_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("POST", "/api/sessions/branch") => Some(worker_session_branch_with_options(
            shared,
            body,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/skills") => Some(worker_skills_list_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/approvals") => Some(native_webui_approvals_body(
            &query,
            workspace_root.clone(),
            config_snapshot.clone(),
        )),
        ("POST", "/api/skills") => Some(worker_skills_create_with_options(
            shared,
            body,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/workspace/files") => Some(worker_workspace_files_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/v1/knowledge/documents") => Some(worker_knowledge_documents_with_options(
            shared,
            WorkerKnowledgeDocumentsInput {
                category: query.get("category").cloned(),
                limit: query
                    .get("limit")
                    .and_then(|value| value.parse::<usize>().ok()),
            },
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("POST", "/v1/knowledge/documents") => Some(worker_knowledge_add_document_with_options(
            shared,
            body,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("POST", "/v1/knowledge/documents/upload") => {
            Some(worker_knowledge_add_document_with_options(
                shared,
                body,
                workspace_root.clone(),
                config_snapshot.clone(),
                timeout,
            ))
        }
        ("GET", "/v1/knowledge/stats") => Some(worker_knowledge_stats_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("POST", "/v1/knowledge/rebuild-index") => {
            Some(worker_knowledge_rebuild_index_with_options(
                shared,
                query.get("type").cloned(),
                workspace_root.clone(),
                config_snapshot.clone(),
                timeout,
            ))
        }
        ("GET", "/v1/knowledge/graph") => Some(worker_knowledge_graph_with_options(
            shared,
            WorkerKnowledgeGraphInput {
                doc_id: query.get("doc_id").cloned(),
                graph_type: query.get("graph_type").cloned(),
                limit: query
                    .get("limit")
                    .and_then(|value| value.parse::<usize>().ok()),
                edge_limit: query
                    .get("edge_limit")
                    .and_then(|value| value.parse::<usize>().ok()),
                min_confidence: query
                    .get("min_confidence")
                    .and_then(|value| value.parse::<f64>().ok()),
                include_orphans: query
                    .get("include_orphans")
                    .and_then(|value| value.parse::<bool>().ok()),
            },
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        _ => worker_webui_rust_dynamic_route(
            shared,
            &method,
            &path,
            &body,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        ),
    };

    match result {
        Some(Ok(body)) => Ok(Some(webui_route_response(
            200,
            body,
            "rust",
            webui_route_group(&path),
        ))),
        Some(Err(error)) => Ok(Some(webui_route_response(
            500,
            serde_json::json!({ "error": { "message": error } }),
            "rust",
            webui_route_group(&path),
        ))),
        None if webui_route_inventory_entry(&method, &path).is_some() => {
            Ok(Some(unsupported_webui_route_response(
                &method,
                &path,
                "webui control route unavailable in the Rust-only backend",
            )))
        }
        None => {
            let route_group = webui_route_group(&path);
            Ok(Some(webui_route_response(
                404,
                serde_json::json!({
                    "diagnostic": "unsupported-route",
                    "inventoryStatus": "not-inventoried",
                    "routeGroup": route_group,
                    "error": {
                        "message": "webui control route unavailable",
                    },
                    "method": method,
                    "path": path,
                    "route": format!("{} {}", method, path),
                }),
                "unsupported",
                route_group,
            )))
        }
    }
}

fn worker_webui_rust_dynamic_route(
    shared: &SharedGateway,
    method: &str,
    path: &str,
    body: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Option<Result<serde_json::Value, String>> {
    if let Some(key) = webui_session_route_key(path, "/messages") {
        if method == "GET" {
            return Some(worker_session_messages_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    if let Some(key) = webui_session_route_key(path, "/temporary-files") {
        return match method {
            "GET" => Some(worker_session_temporary_files_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "POST" => Some(worker_session_upload_temporary_file_with_options(
                shared,
                key,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "DELETE" => Some(worker_session_clear_temporary_files_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(key) = webui_session_route_key(path, "/clear") {
        if method == "POST" {
            return Some(worker_session_clear_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    if let Some(key) = webui_session_item_key(path) {
        return match method {
            "PATCH" => Some(worker_session_patch_with_options(
                shared,
                key,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "DELETE" => Some(worker_session_delete_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(path) = webui_workspace_file_path(path) {
        return match method {
            "GET" => Some(worker_workspace_file_with_options(
                shared,
                path,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "PUT" => Some(worker_workspace_put_file_with_options(
                shared,
                path,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(name) = webui_skill_route_name(path, "/validate") {
        if method == "POST" {
            return Some(worker_skills_validate_with_options(
                shared,
                name,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    if let Some(name) = webui_skill_item_name(path) {
        return match method {
            "GET" => Some(worker_skills_detail_with_options(
                shared,
                name,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "PATCH" => Some(worker_skills_update_with_options(
                shared,
                name,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "DELETE" => Some(worker_skills_delete_with_options(
                shared,
                name,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(approval_id) = webui_approval_route_id(path, "/approve") {
        if method == "POST" {
            return Some(native_webui_approval_resolution_body(
                shared,
                approval_id,
                body,
                true,
                workspace_root,
                config_snapshot,
            ));
        }
    }
    if let Some(approval_id) = webui_approval_route_id(path, "/deny") {
        if method == "POST" {
            return Some(native_webui_approval_resolution_body(
                shared,
                approval_id,
                body,
                false,
                workspace_root,
                config_snapshot,
            ));
        }
    }
    if let Some(doc_id) = webui_path_param(path, "/v1/knowledge/documents/") {
        return match method {
            "GET" => Some(worker_knowledge_document_with_options(
                shared,
                doc_id,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "DELETE" => Some(worker_knowledge_delete_document_with_options(
                shared,
                doc_id,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(job_id) = webui_path_param(path, "/v1/knowledge/jobs/") {
        if method == "GET" {
            return Some(worker_knowledge_job_with_options(
                shared,
                job_id,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    None
}

fn native_webui_bootstrap_body() -> serde_json::Value {
    serde_json::json!({
        "token": "native-rust-local",
        "ws_path": "/ws",
        "refresh_token_path": "/webui/refresh-token",
        "token_ttl_s": 300,
    })
}

fn native_webui_status_body(shared: &SharedGateway) -> serde_json::Value {
    let status = lock_runtime(shared).experimental_worker.status();
    serde_json::json!({
        "channels": {
            "websocket": {
                "enabled": true,
                "running": matches!(status.state, WorkerManagerState::Running | WorkerManagerState::Starting)
            }
        },
        "native_backend": status,
        "provider": crate::native_provider_runtime::resolve_provider_profile(
            &experimental_worker_config_snapshot(),
            None,
            None,
        ).map(|profile| serde_json::json!({
            "id": profile.provider_id,
            "displayName": profile.display_name,
            "api_base": profile.api_base,
            "api_key_configured": profile.api_key_configured,
        })),
        "model": crate::native_provider_runtime::configured_model(&experimental_worker_config_snapshot()),
    })
}

fn worker_webui_config_body(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let snapshot = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("webui-config"),
            request_id.trace_id("webui-config"),
            "config.snapshot_public",
            serde_json::json!({}),
        ),
        "worker webui config",
    )?;
    Ok(snapshot.get("value").cloned().unwrap_or(snapshot))
}

fn native_webui_approvals_body(
    query: &HashMap<String, String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_key = query
        .get("session_key")
        .or_else(|| query.get("chat_id"))
        .cloned()
        .unwrap_or_default();
    let checkpoint = if session_key.is_empty() {
        None
    } else {
        native_session_checkpoint(
            &session_key,
            workspace_root,
            config_snapshot,
            "native approvals checkpoint lookup",
        )?
    };
    Ok(serde_json::json!({
        "session_key": session_key,
        "approvals": pending_approvals_from_checkpoint(checkpoint.as_ref()),
        "source": "rust",
    }))
}

fn pending_approvals_from_checkpoint(
    checkpoint: Option<&serde_json::Value>,
) -> Vec<serde_json::Value> {
    let Some(checkpoint) = checkpoint else {
        return Vec::new();
    };
    if checkpoint.get("phase").and_then(serde_json::Value::as_str) != Some("awaiting_approval") {
        return Vec::new();
    }
    let payload = checkpoint
        .get("payload")
        .and_then(serde_json::Value::as_object);
    let operation = payload
        .and_then(|payload| payload.get("operation"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let approval_id = payload
        .and_then(|payload| payload.get("approval_id"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            operation
                .get("approvalId")
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("approval-1");
    let tool_name = operation
        .get("toolName")
        .or_else(|| operation.get("tool_name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("approval");
    let run_id = checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let session_id = checkpoint
        .get("sessionId")
        .or_else(|| checkpoint.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    vec![serde_json::json!({
        "id": approval_id,
        "runId": run_id,
        "sessionId": session_id,
        "operation": operation,
        "category": operation.get("category").and_then(serde_json::Value::as_str).unwrap_or("tool"),
        "risk": operation.get("risk").and_then(serde_json::Value::as_str).unwrap_or("medium"),
        "reason": operation.get("reason").and_then(serde_json::Value::as_str).unwrap_or("This tool requires user approval before execution."),
        "summary": operation.get("summary").and_then(serde_json::Value::as_str).unwrap_or(tool_name),
        "fingerprint": operation.get("fingerprint").and_then(serde_json::Value::as_str).unwrap_or(approval_id),
        "sessionFingerprint": operation.get("sessionFingerprint").and_then(serde_json::Value::as_str).unwrap_or(approval_id),
        "tool_name": tool_name,
    })]
}

fn native_webui_approval_resolution_body(
    shared: &SharedGateway,
    approval_id: String,
    body: &serde_json::Value,
    approved: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_key = body
        .get("session_key")
        .or_else(|| body.get("sessionId"))
        .or_else(|| body.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let scope = body
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("once");
    let Some(checkpoint) = native_session_checkpoint(
        session_key,
        workspace_root.clone(),
        config_snapshot.clone(),
        "native approval resolution checkpoint lookup",
    )?
    else {
        return Ok(native_webui_approval_not_found_body(
            approval_id,
            body,
            approved,
        ));
    };
    let pending = pending_approvals_from_checkpoint(Some(&checkpoint));
    let Some(approval) = pending.iter().find(|approval| {
        approval.get("id").and_then(serde_json::Value::as_str) == Some(&approval_id)
    }) else {
        return Ok(native_webui_approval_not_found_body(
            approval_id,
            body,
            approved,
        ));
    };

    let continuation_spec =
        native_approval_continuation_spec(&checkpoint, body, &approval_id, approved);
    let services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    services.save_checkpoint(session_key, checkpoint.clone());
    let mut continuation = run_native_agent_turn_with_config(
        &services,
        continuation_spec.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_turn_if_final(
        continuation_spec,
        &mut continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    clear_native_session_checkpoint(
        session_key,
        workspace_root,
        config_snapshot,
        "native approval resolution checkpoint clear",
    )?;
    continuation["ok"] = serde_json::Value::Bool(true);
    continuation["status"] =
        serde_json::Value::String(if approved { "approved" } else { "denied" }.to_string());
    continuation["approvalId"] = serde_json::Value::String(approval_id);
    continuation["approved"] = serde_json::Value::Bool(approved);
    continuation["scope"] = serde_json::Value::String(scope.to_string());
    continuation["session_key"] = serde_json::Value::String(session_key.to_string());
    continuation["source"] = serde_json::Value::String("rust".to_string());
    if let Some(guidance) = approval_guidance_value(body) {
        continuation["guidance"] = serde_json::Value::String(guidance);
    }
    continuation["operation"] = approval
        .get("operation")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["category"] = approval
        .get("category")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["risk"] = approval
        .get("risk")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["reason"] = approval
        .get("reason")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["summary"] = approval
        .get("summary")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["fingerprint"] = approval
        .get("fingerprint")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    continuation["sessionFingerprint"] = approval
        .get("sessionFingerprint")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(continuation)
}

fn native_approval_continuation_spec(
    checkpoint: &serde_json::Value,
    body: &serde_json::Value,
    approval_id: &str,
    approved: bool,
) -> serde_json::Value {
    let run_id = checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-approval-resolution");
    let session_id = checkpoint
        .get("sessionId")
        .or_else(|| checkpoint.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-rust-session");
    let operation = checkpoint
        .get("payload")
        .and_then(|payload| payload.get("operation"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let tool_name = operation
        .get("toolName")
        .or_else(|| operation.get("tool_name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("approval");
    let guidance = approval_guidance_value(body);
    let tool_result = if approved {
        "approved".to_string()
    } else if let Some(guidance) = guidance.as_deref() {
        format!("denied: {guidance}")
    } else {
        "denied".to_string()
    };
    let mut resume = serde_json::json!({
        "approved": approved,
        "toolCallId": approval_id,
        "toolName": tool_name,
        "toolResult": tool_result,
    });
    if let Some(guidance) = guidance {
        resume["guidance"] = serde_json::Value::String(guidance);
    }
    if let Some(final_content) = body
        .get("finalContent")
        .or_else(|| body.get("final_content"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        resume["finalContent"] = serde_json::Value::String(final_content.to_string());
    }
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "messages": checkpoint
            .get("messages")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "metadata": {
            "fakeApprovalResume": resume,
        },
    })
}

fn approval_guidance_value(body: &serde_json::Value) -> Option<String> {
    body.get("guidance")
        .or_else(|| body.get("user_guidance"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn native_webui_approval_not_found_body(
    approval_id: String,
    body: &serde_json::Value,
    approved: bool,
) -> serde_json::Value {
    let session_key = body
        .get("session_key")
        .or_else(|| body.get("sessionId"))
        .or_else(|| body.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let scope = body
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("once");
    serde_json::json!({
        "ok": false,
        "status": "not_found",
        "approvalId": approval_id,
        "approved": approved,
        "scope": scope,
        "session_key": session_key,
        "source": "rust",
        "error": {
            "message": "pending approval not found",
        },
    })
}

fn native_webui_agent_ui_form_resolution_body(
    shared: &SharedGateway,
    form_id: String,
    body: &serde_json::Value,
    cancelled: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(u16, serde_json::Value), String> {
    let session_key = agent_ui_form_session_key(body).unwrap_or_default();
    let values = body
        .get("values")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(checkpoint) = native_session_checkpoint(
        &session_key,
        workspace_root.clone(),
        config_snapshot.clone(),
        "native Agent UI form checkpoint lookup",
    )?
    else {
        return Ok((404, native_webui_agent_ui_form_not_found_body(form_id)));
    };
    if checkpoint.get("phase").and_then(serde_json::Value::as_str) != Some("awaiting_form")
        || checkpoint
            .get("payload")
            .and_then(|payload| payload.get("form_id"))
            .and_then(serde_json::Value::as_str)
            != Some(&form_id)
    {
        return Ok((404, native_webui_agent_ui_form_not_found_body(form_id)));
    }
    let errors = validate_agent_ui_form_values(&checkpoint, &values);
    if !cancelled && !errors.is_empty() {
        return Ok((
            400,
            serde_json::json!({
                "submitted": false,
                "form_id": form_id,
                "values": values,
                "errors": errors,
                "event": native_agent_ui_form_event("ui.form.validation_failed", &form_id, &values),
                "source": "rust",
            }),
        ));
    }

    let continuation_spec =
        native_agent_ui_form_continuation_spec(&checkpoint, body, &form_id, &values, cancelled);
    let services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    services.save_checkpoint(&session_key, checkpoint);
    let mut continuation = run_native_agent_turn_with_config(
        &services,
        continuation_spec.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_turn_if_final(
        continuation_spec,
        &mut continuation,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    clear_native_session_checkpoint(
        &session_key,
        workspace_root,
        config_snapshot,
        "native Agent UI form checkpoint clear",
    )?;
    continuation["form_id"] = serde_json::Value::String(form_id.clone());
    continuation["source"] = serde_json::Value::String("rust".to_string());
    continuation["continuation"] = serde_json::json!({
        "mode": "resume",
        "delivered": true,
        "target": "agent_loop",
    });
    if cancelled {
        continuation["cancelled"] = serde_json::Value::Bool(true);
        continuation["event"] = native_agent_ui_form_event("ui.form.cancelled", &form_id, &values);
    } else {
        continuation["submitted"] = serde_json::Value::Bool(true);
        continuation["values"] = values.clone();
        continuation["event"] = native_agent_ui_form_event("ui.form.submitted", &form_id, &values);
    }
    Ok((200, continuation))
}

fn native_webui_agent_ui_form_not_found_body(form_id: String) -> serde_json::Value {
    serde_json::json!({
        "submitted": false,
        "cancelled": false,
        "form_id": form_id,
        "source": "rust",
        "error": "pending form checkpoint not found",
    })
}

fn agent_ui_form_session_key(body: &serde_json::Value) -> Option<String> {
    body.get("correlation")
        .and_then(|correlation| {
            correlation
                .get("session_key")
                .or_else(|| correlation.get("sessionId"))
                .or_else(|| correlation.get("session_id"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            body.get("session_key")
                .or_else(|| body.get("sessionId"))
                .or_else(|| body.get("session_id"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_agent_ui_form_values(
    checkpoint: &serde_json::Value,
    values: &serde_json::Value,
) -> serde_json::Map<String, serde_json::Value> {
    let mut errors = serde_json::Map::new();
    let Some(fields) = checkpoint
        .get("payload")
        .and_then(|payload| payload.get("form"))
        .and_then(|form| form.get("fields"))
        .and_then(serde_json::Value::as_array)
    else {
        return errors;
    };
    for field in fields {
        if field.get("required").and_then(serde_json::Value::as_bool) != Some(true) {
            continue;
        }
        let Some(name) = field.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let missing = values
            .get(name)
            .is_none_or(|value| value.is_null() || value.as_str().is_some_and(str::is_empty));
        if missing {
            errors.insert(
                name.to_string(),
                serde_json::Value::String("Required".to_string()),
            );
        }
    }
    errors
}

fn native_agent_ui_form_continuation_spec(
    checkpoint: &serde_json::Value,
    body: &serde_json::Value,
    form_id: &str,
    values: &serde_json::Value,
    cancelled: bool,
) -> serde_json::Value {
    let run_id = checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-form-resolution");
    let session_id = checkpoint
        .get("sessionId")
        .or_else(|| checkpoint.get("session_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native-rust-session");
    let mut form_submit = serde_json::json!({
        "formId": form_id,
        "values": values,
        "cancelled": cancelled,
    });
    if let Some(final_content) = body
        .get("finalContent")
        .or_else(|| body.get("final_content"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        form_submit["finalContent"] = serde_json::Value::String(final_content.to_string());
    }
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "messages": checkpoint
            .get("messages")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "metadata": {
            "fakeFormSubmit": form_submit,
        },
    })
}

fn native_agent_ui_form_event(
    event_type: &str,
    form_id: &str,
    values: &serde_json::Value,
) -> serde_json::Value {
    let mut payload = serde_json::json!({ "form_id": form_id });
    if event_type == "ui.form.submitted" || event_type == "ui.form.validation_failed" {
        payload["values"] = values.clone();
    }
    serde_json::json!({
        "event_type": event_type,
        "payload": payload,
    })
}

fn native_session_checkpoint(
    session_key: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<Option<serde_json::Value>, String> {
    let request_id = next_worker_request_correlation();
    let checkpoint = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-get-checkpoint"),
            request_id.trace_id("session-get-checkpoint"),
            "session.get_checkpoint",
            serde_json::json!({ "session_id": session_key }),
        ),
        label,
    )?;
    Ok(if checkpoint.is_null() {
        None
    } else {
        Some(checkpoint)
    })
}

fn clear_native_session_checkpoint(
    session_key: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-clear-checkpoint"),
            request_id.trace_id("session-clear-checkpoint"),
            "session.clear_checkpoint",
            serde_json::json!({ "session_id": session_key }),
        ),
        label,
    )?;
    Ok(())
}

fn webui_route_response(
    status: u16,
    body: serde_json::Value,
    owner: &str,
    route_group: &str,
) -> serde_json::Value {
    serde_json::json!({
        "status": status,
        "body": body,
        "headers": {
            "x-tinybot-route-owner": owner,
            "x-tinybot-route-group": route_group,
        }
    })
}

fn split_webui_route_path(path: &str) -> (String, HashMap<String, String>) {
    let (path_only, query) = path.split_once('?').unwrap_or((path, ""));
    let mut params = HashMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(percent_decode(key), percent_decode(value));
    }
    (path_only.to_string(), params)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = &input[index + 1..index + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    output.push(value);
                    index += 3;
                    continue;
                }
                output.push(bytes[index]);
                index += 1;
            }
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).to_string()
}

fn webui_session_route_key(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/sessions/")?;
    let key = rest.strip_suffix(suffix)?;
    if key.is_empty() || key.contains('/') {
        return None;
    }
    Some(percent_decode(key))
}

fn webui_session_item_key(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/sessions/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(percent_decode(rest))
}

fn webui_workspace_file_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/workspace/files/")?;
    if rest.is_empty() {
        return None;
    }
    Some(percent_decode(rest))
}

fn webui_skill_route_name(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/skills/")?;
    let name = rest.strip_suffix(suffix)?;
    if name.is_empty() || name.contains('/') {
        return None;
    }
    Some(percent_decode(name))
}

fn webui_skill_item_name(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/skills/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(percent_decode(rest))
}

fn webui_approval_route_id(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/approvals/")?;
    let approval_id = rest.strip_suffix(suffix)?;
    if approval_id.is_empty() || approval_id.contains('/') {
        return None;
    }
    Some(percent_decode(approval_id))
}

fn webui_agent_ui_form_route(path: &str) -> Option<(String, bool)> {
    webui_agent_ui_form_route_id(path, "/submit")
        .map(|form_id| (form_id, false))
        .or_else(|| webui_agent_ui_form_route_id(path, "/cancel").map(|form_id| (form_id, true)))
}

fn webui_agent_ui_form_route_id(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/agent-ui/forms/")?;
    let form_id = rest.strip_suffix(suffix)?;
    if form_id.is_empty() || form_id.contains('/') {
        return None;
    }
    Some(percent_decode(form_id))
}

fn webui_path_param(path: &str, prefix: &str) -> Option<String> {
    let rest = path.strip_prefix(prefix)?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(percent_decode(rest))
}

fn webui_route_group(path: &str) -> &'static str {
    if path == "/health" {
        "health"
    } else if path.starts_with("/webui/") {
        "bootstrap"
    } else if path == "/api/status" {
        "status"
    } else if path == "/api/config" {
        "config"
    } else if path.starts_with("/api/sessions") {
        "sessions"
    } else if path.starts_with("/api/workspace") {
        "workspace"
    } else if path.starts_with("/api/skills") {
        "skills"
    } else if path == "/api/providers" || path == "/api/provider-models" {
        "providers"
    } else if path.starts_with("/v1/knowledge") {
        "knowledge"
    } else if path.starts_with("/api/cowork") {
        "cowork"
    } else if path.starts_with("/api/approvals") {
        "approvals"
    } else if path.starts_with("/api/agent-ui") {
        "agent-ui"
    } else if path.starts_with("/v1/") {
        "openai"
    } else {
        "unsupported"
    }
}

fn unsupported_webui_route_response(method: &str, path: &str, message: &str) -> serde_json::Value {
    let inventory = webui_route_inventory_entry(method, path);
    let route_group = inventory
        .as_ref()
        .map(|entry| entry.route_group)
        .unwrap_or_else(|| webui_route_group(path));
    let mut body = serde_json::json!({
        "diagnostic": "unsupported-route",
        "inventoryStatus": if inventory.is_some() { "unsupported" } else { "not-inventoried" },
        "routeGroup": route_group,
        "error": { "message": message },
        "method": method,
        "path": path,
        "route": format!("{} {}", method, path),
    });
    if let Some(entry) = inventory {
        body["reason"] = serde_json::Value::String(entry.reason.to_string());
        body["replacementPlan"] = serde_json::Value::String(entry.replacement_plan.to_string());
    }
    webui_route_response(501, body, "unsupported", route_group)
}

fn worker_webui_route_timeout(input: &WorkerWebuiRouteInput) -> Duration {
    let _ = input;
    WORKER_WEBUI_ROUTE_TIMEOUT
}

fn worker_transport_gateway_frame_with_options(
    _shared: &SharedGateway,
    _input: WorkerTransportGatewayFrameInput,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_transport_gateway_frame")
}

fn worker_transport_websocket_message_with_options(
    _shared: &SharedGateway,
    _input: WorkerTransportWebSocketMessageInput,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_transport_websocket_message")
}

fn worker_transport_dispatch_websocket_message_with_options(
    shared: &SharedGateway,
    input: WorkerTransportWebSocketDispatchInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let Some(transport_result) = native_websocket_transport_result(&input) else {
        return unsupported_rust_only_command("worker_transport_dispatch_websocket_message");
    };
    let dispatch_options = WorkerTransportWebSocketDispatchOptions {
        model: input.model,
        max_iterations: input.max_iterations,
        run_id: input.run_id,
        stream: input.stream,
    };
    let Some(run_request) = build_worker_transport_websocket_run_input_request(
        next_worker_request_correlation(),
        &transport_result,
        dispatch_options,
    ) else {
        return Ok(serde_json::json!({ "transport": transport_result }));
    };

    let run_spec = run_request
        .params
        .get("input")
        .cloned()
        .ok_or_else(|| "native websocket dispatch missing run input".to_string())?;
    let agent_result =
        worker_run_agent_with_options(shared, run_spec, workspace_root, config_snapshot, timeout)?;

    Ok(serde_json::json!({
        "transport": transport_result,
        "agent": agent_result,
    }))
}

fn native_websocket_transport_result(
    input: &WorkerTransportWebSocketDispatchInput,
) -> Option<serde_json::Value> {
    let frame = input.frame.as_object()?;
    if json_string_field(frame, "type") != Some("message") {
        return None;
    }
    let content = json_string_field(frame, "content")?;
    let chat_id = json_string_field(frame, "chat_id")
        .or(input.attached_chat_id.as_deref())
        .unwrap_or_default();
    if chat_id.is_empty() {
        return None;
    }
    let session_id = format!("websocket:{chat_id}");
    let mut metadata = frame
        .get("metadata")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(use_persistent_rag) = frame
        .get("use_persistent_rag")
        .and_then(serde_json::Value::as_bool)
    {
        metadata.insert(
            "_use_persistent_rag".to_string(),
            serde_json::Value::Bool(use_persistent_rag),
        );
    }

    Some(serde_json::json!({
        "kind": "message",
        "chatId": chat_id,
        "sessionId": session_id,
        "frames": [],
        "inbound": {
            "channel": "websocket",
            "sender_id": input.client_id,
            "chat_id": chat_id,
            "content": content,
            "metadata": serde_json::Value::Object(metadata),
            "session_key": session_id,
        }
    }))
}

fn build_worker_transport_websocket_run_input_request(
    request_id: WorkerRequestCorrelation,
    transport_result: &serde_json::Value,
    options: WorkerTransportWebSocketDispatchOptions,
) -> Option<WorkerRequest> {
    let inbound = transport_result.get("inbound")?.as_object()?;
    let session_id = json_string_field(inbound, "session_key")?;
    let content = json_string_field(inbound, "content")?;
    let channel = json_string_field(inbound, "channel").unwrap_or("websocket");
    let chat_id = json_string_field(inbound, "chat_id").unwrap_or("");
    let mut metadata = inbound
        .get("metadata")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    metadata.insert("_wants_stream".to_string(), serde_json::Value::Bool(true));

    let run_id = options.run_id.unwrap_or_else(|| {
        format!(
            "websocket-{}-{}",
            sanitize_worker_run_id_part(if chat_id.is_empty() {
                session_id
            } else {
                chat_id
            }),
            request_id.suffix()
        )
    });
    let mut input = serde_json::json!({
        "runId": run_id,
        "sessionId": session_id,
        "input": {
            "role": "user",
            "content": content,
        },
        "channel": channel,
        "chatId": chat_id,
        "stream": options.stream.unwrap_or(true),
        "metadata": serde_json::Value::Object(metadata),
    });
    if let Some(model) = options.model {
        input["model"] = serde_json::Value::String(model);
    }
    if let Some(max_iterations) = options.max_iterations {
        input["maxIterations"] = serde_json::json!(max_iterations);
    }

    Some(WorkerRequest::new(
        request_id.id("transport-websocket-run-input"),
        request_id.trace_id("transport-websocket-run-input"),
        "agent.run_input",
        serde_json::json!({ "input": input }),
    ))
}

fn worker_channel_dispatch_inbound_with_options(
    _shared: &SharedGateway,
    _input: WorkerChannelDispatchInboundInput,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_channel_dispatch_inbound")
}

fn worker_channel_start_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_start_request(next_worker_request_correlation()),
        timeout,
        "start",
    )
}

fn worker_channel_status_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_status_request(next_worker_request_correlation()),
        timeout,
        "status",
    )
}

fn worker_channel_stop_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_stop_request(next_worker_request_correlation()),
        timeout,
        "stop",
    )
}

fn worker_channel_login_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
    channel: String,
    force: bool,
) -> Result<serde_json::Value, String> {
    send_channel_lifecycle_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_channel_login_request(next_worker_request_correlation(), channel, force),
        timeout,
        "login",
    )
}

fn send_channel_lifecycle_worker_request(
    _shared: &SharedGateway,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    request: WorkerRequest,
    _timeout: Duration,
    action: &str,
) -> Result<serde_json::Value, String> {
    let _ = request;
    unsupported_rust_only_command(&format!("worker_channel_{action}"))
}

fn build_worker_channel_start_request(request_id: WorkerRequestCorrelation) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-start"),
        request_id.trace_id("channel-start"),
        "channel.start",
        serde_json::json!({}),
    )
}

fn build_worker_channel_status_request(request_id: WorkerRequestCorrelation) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-status"),
        request_id.trace_id("channel-status"),
        "channel.status",
        serde_json::json!({}),
    )
}

fn build_worker_channel_stop_request(request_id: WorkerRequestCorrelation) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-stop"),
        request_id.trace_id("channel-stop"),
        "channel.stop",
        serde_json::json!({}),
    )
}

fn build_worker_channel_login_request(
    request_id: WorkerRequestCorrelation,
    channel: String,
    force: bool,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-login"),
        request_id.trace_id("channel-login"),
        "channel.login",
        serde_json::json!({
            "channel": channel,
            "force": force,
        }),
    )
}

fn json_string_field<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    object.get(key).and_then(serde_json::Value::as_str)
}

fn sanitize_worker_run_id_part(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "chat".to_string()
    } else {
        sanitized
    }
}

fn call_rust_state_service(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    label: &str,
) -> Result<serde_json::Value, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{label} failed: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{label} failed: missing response result"))
}

fn unsupported_rust_only_command(command: &str) -> Result<serde_json::Value, String> {
    Err(format!("{command} is unsupported in the Rust-only backend"))
}

fn worker_cancel_agent_with_options(
    shared: &SharedGateway,
    run_id: String,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = (config_snapshot, timeout);
    let services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    Ok(services.cancel(&run_id))
}

fn worker_restore_agent_checkpoint_with_options(
    shared: &SharedGateway,
    session_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = timeout;
    let services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    let restored = services.restore_checkpoint(&session_id);
    if !restored
        .get("checkpoint")
        .is_some_and(|value| !value.is_null())
    {
        return restore_native_agent_checkpoint_from_session_store(
            session_id,
            workspace_root,
            config_snapshot,
        );
    }
    validate_native_agent_checkpoint_version(restored.get("checkpoint"))?;
    Ok(restored)
}

fn restore_native_agent_checkpoint_from_session_store(
    session_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let checkpoint = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-get-native-checkpoint"),
            request_id.trace_id("session-get-native-checkpoint"),
            "session.get_checkpoint",
            serde_json::json!({ "session_id": session_id.clone() }),
        ),
        "native agent checkpoint restore",
    )?;
    validate_native_agent_checkpoint_version(Some(&checkpoint))?;
    Ok(serde_json::json!({
        "runtime": "rust",
        "sessionId": session_id,
        "checkpoint": checkpoint,
    }))
}

fn validate_native_agent_checkpoint_version(
    checkpoint: Option<&serde_json::Value>,
) -> Result<(), String> {
    let Some(checkpoint) = checkpoint.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let Some(schema_version) = checkpoint
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
    else {
        return Ok(());
    };
    if schema_version == 1 {
        return Ok(());
    }
    Err(format!(
        "unsupported Rust agent checkpoint schemaVersion {schema_version}"
    ))
}

fn worker_background_trace_list_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceListInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request =
        build_worker_background_trace_list_request(next_worker_request_correlation(), input);
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background trace list",
    )
}

fn build_worker_background_trace_list_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundTraceListInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-trace-list"),
        request_id.trace_id("background-trace-list"),
        "background.trace.list",
        serde_json::json!({ "filter": input.filter }),
    )
}

fn worker_background_trace_get_delegate_trace_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceGetDelegateTraceInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request = build_worker_background_trace_get_delegate_trace_request(
        next_worker_request_correlation(),
        input,
    );
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background delegate trace get",
    )
}

fn build_worker_background_trace_get_delegate_trace_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundTraceGetDelegateTraceInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-trace-get-delegate-trace"),
        request_id.trace_id("background-trace-get-delegate-trace"),
        "background.trace.get_delegate_trace",
        serde_json::json!({ "filter": input.filter }),
    )
}

fn worker_background_trace_get_artifact_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceGetArtifactInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request = build_worker_background_trace_get_artifact_request(
        next_worker_request_correlation(),
        input,
    );
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background trace artifact get",
    )
}

fn build_worker_background_trace_get_artifact_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundTraceGetArtifactInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-trace-get-artifact"),
        request_id.trace_id("background-trace-get-artifact"),
        "background.trace.get_artifact",
        serde_json::json!({ "filter": input.filter }),
    )
}

fn worker_background_trace_append_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceAppendInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let request = WorkerRequest::new(
        request_id.id("background-trace-append"),
        request_id.trace_id("background-trace-append"),
        "background.trace.append",
        serde_json::json!({ "event": input.event }),
    );
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background trace append",
    )
}

fn worker_background_subagent_enqueue_input_with_options(
    shared: &SharedGateway,
    input: WorkerBackgroundSubagentInputInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request = build_worker_background_subagent_enqueue_input_request(
        next_worker_request_correlation(),
        input,
    );
    let manager = {
        let runtime = lock_runtime(shared);
        runtime.subagent_manager.clone()
    };
    let mut router =
        experimental_worker_router(workspace_root, config_snapshot).with_subagent_manager(manager);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!(
            "worker background subagent input enqueue returned error: {}",
            error.message
        ));
    }
    response.result.ok_or_else(|| {
        "worker background subagent input enqueue response missing result".to_string()
    })
}

fn build_worker_background_subagent_enqueue_input_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundSubagentInputInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-subagent-enqueue-input"),
        request_id.trace_id("background-subagent-enqueue-input"),
        "background.subagent.enqueue_input",
        serde_json::json!({
            "sessionKey": input.session_key,
            "subagentId": input.subagent_id,
            "content": input.content,
            "turnId": input.turn_id,
            "traceRef": input.trace_ref,
            "childRunId": input.child_run_id,
            "createdAt": input.created_at,
            "metadata": input.metadata,
        }),
    )
}

fn dispatch_worker_background_trace_request(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    context: &str,
) -> Result<serde_json::Value, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{context} returned error: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{context} response missing result"))
}

fn persist_subagent_manager_event_if_present(
    event: Option<&BackgroundTraceEvent>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let Some(event) = event else {
        return Ok(());
    };
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("subagent-manager-trace-append"),
            request_id.trace_id("subagent-manager-trace-append"),
            "background.trace.append",
            serde_json::json!({ "event": event }),
        ),
        "subagent manager trace append",
    )?;
    Ok(())
}

fn worker_task_plan_list_with_options(
    _shared: &SharedGateway,
    input: WorkerTaskPlanListInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-list"),
            request_id.trace_id("task-plan-list"),
            "task.plan.list",
            serde_json::json!({ "include_completed": input.include_completed }),
        ),
        "worker task plan list",
    )
}

fn worker_task_plan_get_with_options(
    _shared: &SharedGateway,
    plan_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-get"),
            request_id.trace_id("task-plan-get"),
            "task.plan.get",
            serde_json::json!({ "plan_id": plan_id }),
        ),
        "worker task plan get",
    )
}

fn worker_task_plan_save_with_options(
    _shared: &SharedGateway,
    plan: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-save"),
            request_id.trace_id("task-plan-save"),
            "task.plan.save",
            serde_json::json!({ "plan": plan }),
        ),
        "worker task plan save",
    )
}

fn worker_task_plan_delete_with_options(
    _shared: &SharedGateway,
    plan_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-delete"),
            request_id.trace_id("task-plan-delete"),
            "task.plan.delete",
            serde_json::json!({ "plan_id": plan_id }),
        ),
        "worker task plan delete",
    )
}

fn dispatch_rust_task_request(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    context: &str,
) -> Result<serde_json::Value, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{context} returned error: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{context} response missing result"))
}

fn worker_knowledge_documents_with_options(
    _shared: &SharedGateway,
    input: WorkerKnowledgeDocumentsInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-documents",
        "knowledge.list_documents",
        serde_json::json!({
            "category": input.category,
            "limit": input.limit,
        }),
        "worker knowledge documents",
    )
}

fn worker_knowledge_add_document_with_options(
    _shared: &SharedGateway,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-add-document",
        "knowledge.add_document",
        body,
        "worker knowledge add document",
    )
}

fn worker_knowledge_document_with_options(
    _shared: &SharedGateway,
    doc_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-document",
        "knowledge.get_document",
        serde_json::json!({ "doc_id": doc_id }),
        "worker knowledge document",
    )
}

fn worker_knowledge_delete_document_with_options(
    _shared: &SharedGateway,
    doc_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-delete-document",
        "knowledge.delete_document",
        serde_json::json!({ "doc_id": doc_id }),
        "worker knowledge delete document",
    )
}

fn worker_knowledge_job_with_options(
    _shared: &SharedGateway,
    job_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-job",
        "knowledge.get_job",
        serde_json::json!({ "job_id": job_id }),
        "worker knowledge job",
    )
}

fn worker_knowledge_rebuild_index_with_options(
    _shared: &SharedGateway,
    rebuild_type: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-rebuild-index",
        "knowledge.rebuild_index",
        serde_json::json!({ "type": rebuild_type }),
        "worker knowledge rebuild index",
    )
}

fn worker_knowledge_stats_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-stats",
        "knowledge.stats",
        serde_json::json!({}),
        "worker knowledge stats",
    )
}

fn worker_knowledge_graph_with_options(
    _shared: &SharedGateway,
    input: WorkerKnowledgeGraphInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-graph",
        "knowledge.graph",
        serde_json::json!({
            "doc_id": input.doc_id,
            "graph_type": input.graph_type,
            "limit": input.limit,
            "edge_limit": input.edge_limit,
            "min_confidence": input.min_confidence,
            "include_orphans": input.include_orphans,
        }),
        "worker knowledge graph",
    )
}

fn dispatch_rust_knowledge_request(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request_suffix: &str,
    method: &str,
    params: serde_json::Value,
    context: &str,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let request = WorkerRequest::new(
        request_id.id(request_suffix),
        request_id.trace_id(request_suffix),
        method,
        params,
    );
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{context} returned error: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{context} response missing result"))
}

fn worker_submit_agent_form_with_options(
    _shared: &SharedGateway,
    _session_id: String,
    _form_id: String,
    _values: serde_json::Value,
    _action: Option<String>,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_submit_agent_form")
}

fn worker_resume_agent_approval_with_options(
    _shared: &SharedGateway,
    _session_id: String,
    _approval_id: String,
    _approved: bool,
    _scope: Option<String>,
    _guidance: Option<String>,
    _workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    unsupported_rust_only_command("worker_resume_agent_approval")
}

fn ensure_experimental_fixture_worker_running(
    worker: &WorkerManager,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    if worker.status().state == WorkerManagerState::Running {
        return Ok(());
    }
    worker
        .start_stdio_rpc(
            stdio_worker_fixture_command_spec(),
            experimental_worker_router(workspace_root, config_snapshot),
        )
        .map_err(|error| format!("failed to start TS worker fixture: {error:?}"))
}

fn stdio_worker_fixture_command_spec() -> WorkerCommandSpec {
    let desktop_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have repo parent")
        .to_path_buf();
    WorkerCommandSpec::new(
        "node",
        ["workers/ts-worker-fixture/src/index.ts"],
        desktop_dir,
    )
    .with_label("ts-worker-fixture")
}

fn experimental_worker_router(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> WorkerRpcRouter {
    WorkerRpcRouter::new_persistent_sessions(
        workspace_root,
        config_snapshot,
        vec![],
        200,
        CapabilityPolicy::new([
            WorkerCapability::ConfigRead,
            WorkerCapability::ProviderSecretRead,
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::FsWorkspaceWrite,
            WorkerCapability::ShellExecute,
            WorkerCapability::DiagnosticsWrite,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::FormRequest,
            WorkerCapability::MemoryRead,
            WorkerCapability::MemoryWrite,
            WorkerCapability::KnowledgeRead,
            WorkerCapability::KnowledgeWrite,
            WorkerCapability::CronRead,
            WorkerCapability::CronWrite,
            WorkerCapability::CronRun,
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::TaskRead,
            WorkerCapability::TaskWrite,
            WorkerCapability::McpCall,
            WorkerCapability::ChannelConnector,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .expect("persistent session store should initialize")
    .with_builtin_skills_root(repo_root())
}

#[cfg(test)]
fn experimental_worker_router_with_runtime_restart(
    worker: WorkerManager,
    spec: WorkerCommandSpec,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> WorkerRpcRouter {
    let restart_worker = worker.clone();
    let restart_spec = spec.clone();
    let restart_workspace_root = workspace_root.clone();
    let restart_config_snapshot = config_snapshot.clone();
    experimental_worker_router(workspace_root, config_snapshot).with_runtime_restart_handler(
        move |_request| {
            let worker = restart_worker.clone();
            let spec = restart_spec.clone();
            let workspace_root = restart_workspace_root.clone();
            let config_snapshot = restart_config_snapshot.clone();
            std::thread::spawn(move || {
                // Let the worker receive the runtime.restart response before replacing it.
                std::thread::sleep(Duration::from_millis(25));
                let router = experimental_worker_router_with_runtime_restart(
                    worker.clone(),
                    spec.clone(),
                    workspace_root,
                    config_snapshot,
                );
                let _ = worker.restart_stdio_rpc(spec, router);
            });
        },
    )
}

fn experimental_worker_workspace_root() -> PathBuf {
    let root = repo_root();
    let current_layout = root.join("workers").join("ts-worker-fixture");
    if current_layout.exists() {
        current_layout
    } else {
        root.join("apps")
            .join("desktop")
            .join("workers")
            .join("ts-worker-fixture")
    }
}

fn native_backend_workspace_root() -> PathBuf {
    let root =
        resolve_native_backend_workspace_root_from_config_path(&default_tinybot_config_path());
    let _ = std::fs::create_dir_all(&root);
    root
}

fn resolve_native_backend_workspace_root_from_config_path(config_path: &Path) -> PathBuf {
    configured_tinybot_workspace(config_path)
        .map(|workspace| expand_tinybot_workspace_path(&workspace))
        .unwrap_or_else(default_tinybot_workspace_root)
}

fn configured_tinybot_workspace(config_path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(config_path).ok()?;
    let config = serde_json::from_str::<serde_json::Value>(&contents).ok()?;
    config
        .pointer("/agents/defaults/workspace")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|workspace| !workspace.is_empty())
        .map(str::to_string)
}

fn expand_tinybot_workspace_path(workspace: &str) -> PathBuf {
    let workspace = workspace.trim();
    if workspace == "~" {
        return tinybot_home_dir();
    }
    if let Some(relative) = workspace
        .strip_prefix("~/")
        .or_else(|| workspace.strip_prefix("~\\"))
    {
        return tinybot_home_dir().join(relative);
    }
    PathBuf::from(workspace)
}

fn experimental_worker_default_config_snapshot() -> serde_json::Value {
    serde_json::json!({
        "agents": {
            "defaults": {
                "provider": "auto"
            }
        }
    })
}

fn experimental_worker_config_snapshot_from_path(config_path: &Path) -> serde_json::Value {
    ConfigStore::load(
        config_path.to_path_buf(),
        experimental_worker_default_config_snapshot(),
    )
    .map(|store| store.snapshot().clone())
    .unwrap_or_else(|_| experimental_worker_default_config_snapshot())
}

fn experimental_worker_config_snapshot() -> serde_json::Value {
    experimental_worker_config_snapshot_from_path(&default_tinybot_config_path())
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn push_log(shared: &SharedGateway, line: &str) {
    let log_path = {
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, line);
        runtime.persistent_log_path.clone()
    };
    let _ =
        append_native_backend_log_line(&log_path, NATIVE_BACKEND_LOG_MAX_BYTES, "runtime", line);
}

fn append_log(runtime: &mut GatewayRuntime, line: &str) {
    if runtime.logs.len() >= 200 {
        runtime.logs.pop_front();
    }
    runtime.logs.push_back(line.to_string());
}

fn record_worker_manager_event_for_logs(shared: &SharedGateway, event: &WorkerManagerEvent) {
    let WorkerManagerEvent::Diagnostics(line) = event else {
        return;
    };
    let log_path = {
        let runtime = lock_runtime(shared);
        runtime.persistent_log_path.clone()
    };
    let _ = append_native_backend_log_line(
        &log_path,
        NATIVE_BACKEND_LOG_MAX_BYTES,
        &line.stream,
        &line.line,
    );
}

fn worker_manager_frontend_event(event: WorkerManagerEvent) -> (String, serde_json::Value) {
    match event {
        WorkerManagerEvent::Status(status) => (
            tauri_safe_event_name("worker.status"),
            serde_json::to_value(status).unwrap_or_else(|_| serde_json::json!({})),
        ),
        WorkerManagerEvent::Diagnostics(line) => (
            tauri_safe_event_name("diagnostics.log"),
            serde_json::to_value(line).unwrap_or_else(|_| serde_json::json!({})),
        ),
        WorkerManagerEvent::Protocol(event) => (
            tauri_safe_event_name(&event.event),
            serde_json::to_value(event.payload).unwrap_or_else(|_| serde_json::json!({})),
        ),
    }
}

fn tauri_safe_event_name(event_name: &str) -> String {
    event_name.replace('.', ":")
}

fn emit_worker_manager_frontend_event<R: Runtime>(
    app: &tauri::AppHandle<R>,
    event: WorkerManagerEvent,
) {
    let (event_name, payload) = worker_manager_frontend_event(event);
    let _ = app.emit(&event_name, payload);
}

fn lock_runtime(shared: &SharedGateway) -> std::sync::MutexGuard<'_, GatewayRuntime> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .ancestors()
        .find(|path| path.join("package.json").exists())
        .map(PathBuf::from)
        .or_else(|| manifest_dir.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gateway_state = Arc::new(Mutex::new(GatewayRuntime {
        keep_background: load_gateway_exit_policy(&gateway_exit_policy_preference_path()),
        ..GatewayRuntime::default()
    }));
    let close_state = gateway_state.clone();
    let setup_state = gateway_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(gateway_state)
        .setup(move |app| {
            install_desktop_application_menu(app)?;
            let app_handle = app.handle().clone();
            let log_state = setup_state.clone();
            let runtime = lock_runtime(&setup_state);
            runtime.experimental_worker.set_event_sink(move |event| {
                record_worker_manager_event_for_logs(&log_state, &event);
                emit_worker_manager_frontend_event(&app_handle, event);
            });
            drop(runtime);
            start_worker_cron_timer(&setup_state);
            push_log(
                &setup_state,
                "Rust backend startup skipped legacy heartbeat worker",
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            gateway_status,
            start_gateway,
            stop_gateway,
            set_gateway_keep_running,
            worker_probe_status,
            worker_echo_agent,
            worker_run_agent,
            worker_run_agent_input,
            worker_skills_list,
            worker_skills_detail,
            worker_skills_create,
            worker_skills_update,
            worker_skills_delete,
            worker_skills_validate,
            worker_workspace_files,
            worker_workspace_file,
            worker_workspace_put_file,
            worker_sessions_list,
            worker_session_messages,
            worker_session_temporary_files,
            worker_session_upload_temporary_file,
            worker_session_clear_temporary_files,
            worker_session_delete,
            worker_session_patch,
            worker_session_branch,
            worker_session_clear,
            worker_session_task_progress,
            worker_cowork_route,
            worker_webui_route,
            worker_transport_gateway_frame,
            worker_transport_websocket_message,
            worker_transport_dispatch_websocket_message,
            worker_channel_dispatch_inbound,
            worker_channel_start,
            worker_channel_status,
            worker_channel_stop,
            worker_channel_login,
            worker_cancel_agent,
            worker_restore_agent_checkpoint,
            worker_background_trace_list,
            worker_background_trace_get_delegate_trace,
            worker_background_trace_get_artifact,
            worker_background_trace_append,
            worker_background_subagent_enqueue_input,
            worker_subagent_spawn,
            worker_subagent_list,
            worker_subagent_query,
            worker_subagent_send_input,
            worker_subagent_wait,
            worker_subagent_cancel,
            worker_subagent_close,
            worker_task_plan_list,
            worker_task_plan_get,
            worker_task_plan_save,
            worker_task_plan_delete,
            worker_knowledge_documents,
            worker_knowledge_add_document,
            worker_knowledge_document,
            worker_knowledge_delete_document,
            worker_knowledge_job,
            worker_knowledge_rebuild_index,
            worker_knowledge_stats,
            worker_knowledge_graph,
            worker_submit_agent_form,
            worker_resume_agent_approval,
            worker_cron_dispatch_due,
            get_config_editor_snapshot,
            apply_config_patch_result,
            apply_config_operations,
            pick_upload_file,
            reveal_workspace_file,
            save_export_file
        ])
        .on_window_event(move |_window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                stop_worker_cron_timer(&close_state);
                let _ = stop_owned_gateway(&close_state, false);
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if is_desktop_menu_command(&id) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("desktop-menu-command", DesktopMenuCommandPayload { id });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_cron::{
        cron_model_from_config, worker_cron_dispatch_due_with_options,
        worker_cron_next_wake_delay_with_options,
    };
    use crate::desktop_files::{
        allowed_workspace_file_path, mime_type_for_path,
        reveal_workspace_file_path_from_config_path, upload_file_from_path, write_export_file,
    };
    use crate::desktop_gateway::{
        classify_bootstrap_response, current_status, persist_gateway_exit_policy,
        GatewayRuntimeStatus,
    };
    use crate::desktop_heartbeat::build_worker_heartbeat_lifecycle_request;
    use crate::desktop_menu::desktop_menu_item_descriptors;
    use crate::worker_manager::WorkerManagerStatus;

    fn test_request_correlation(suffix: &str) -> WorkerRequestCorrelation {
        WorkerRequestCorrelation::from_suffix(suffix)
    }

    #[test]
    fn close_shutdown_stops_background_worker_child() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        {
            let runtime = lock_runtime(&shared);
            runtime
                .experimental_worker
                .start(test_gateway_worker_spec("ts-backend-close-worker"))
                .expect("test worker should start");
        }

        stop_owned_gateway(&shared, false).expect("background worker child should stop");

        let runtime = lock_runtime(&shared);
        assert_eq!(
            runtime.experimental_worker.status().state,
            crate::worker_manager::WorkerManagerState::Stopped
        );
        assert!(runtime
            .logs
            .iter()
            .any(|line| line == "stopped background worker"));
    }

    #[test]
    fn start_gateway_defaults_to_rust_backend() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let status = crate::desktop_gateway::start_gateway_with_options(&shared)
            .expect("Rust backend startup should not require TS worker");

        assert_eq!(status.owner, "shell");
        assert_eq!(status.state, "running");
        assert_eq!(status.command, "Tauri Rust backend");
        assert_eq!(
            status.worker_runtime.state,
            crate::worker_runtime::WorkerRuntimeState::Running
        );
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
        assert!(lock_runtime(&shared)
            .logs
            .iter()
            .any(|line| line == "Rust native backend active"));
    }

    #[test]
    fn desktop_smoke_default_chat_runs_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let status = crate::desktop_gateway::start_gateway_with_options(&shared)
            .expect("default desktop runtime should start Rust backend");

        let chat = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/v1/chat/completions".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "messages": [{ "role": "user", "content": "desktop smoke" }],
                    "stream": false
                })),
            },
            fixture.root.clone(),
            serde_json::json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "smoke response from rust" }] } }
            }),
            Duration::from_millis(10),
        )
        .expect("desktop smoke chat should use Rust-owned route");

        assert_eq!(status.command, "Tauri Rust backend");
        assert_eq!(chat["status"], 200);
        assert_eq!(chat["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(
            chat["body"]["choices"][0]["message"]["content"],
            "smoke response from rust"
        );
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn gateway_status_reflects_running_managed_worker() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let worker = {
            let runtime = lock_runtime(&shared);
            runtime.experimental_worker.clone()
        };
        worker
            .start(test_gateway_short_worker_spec("gateway-runtime-worker"))
            .expect("test worker should start");

        let status = current_status(&shared);

        assert_eq!(
            status.worker_runtime.state,
            crate::worker_runtime::WorkerRuntimeState::Running
        );
        assert_eq!(
            status.worker_runtime.transport_mode,
            Some(crate::worker_protocol::WorkerTransportMode::Stdio)
        );
    }

    #[test]
    fn gateway_status_reports_managed_worker_diagnostics() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let worker = {
            let runtime = lock_runtime(&shared);
            runtime.experimental_worker.clone()
        };
        worker
            .start(test_logging_sleep_worker_spec(
                "managed-worker",
                "managed worker diagnostic",
            ))
            .expect("managed worker should start");
        let _ = wait_for_worker_diagnostics(&worker, |diagnostics| {
            diagnostics
                .iter()
                .any(|line| line.line.contains("managed worker diagnostic"))
        });

        let status = current_status(&shared);
        let log_text = status.logs.join("\n");
        let diagnostic_text = status
            .worker_runtime
            .diagnostics
            .iter()
            .map(|line| line.line.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(log_text.contains("managed worker diagnostic"));
        assert!(diagnostic_text.contains("managed worker diagnostic"));
        assert_eq!(status.command, "Tauri Rust backend");
    }

    #[test]
    fn worker_echo_agent_uses_experimental_fixture_worker() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        fixture.write("notes/today.md", "hello command");
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result = worker_echo_agent_with_options(
            &shared,
            "hello command".to_string(),
            fixture.root.clone(),
            serde_json::json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
            Duration::from_secs(5),
        )
        .expect("experimental worker echo should complete");

        assert!(result.ok);
        assert_eq!(result.echo, "hello command");
        assert_eq!(result.config_value, serde_json::json!("gpt-5"));
        assert_eq!(result.workspace_file_count, 2);

        let runtime = lock_runtime(&shared);
        assert_eq!(
            runtime.experimental_worker.status().state,
            WorkerManagerState::Running
        );
    }

    #[test]
    fn native_backend_uses_default_tinybot_workspace_root() {
        let fixture = WorkspaceFixture::new();
        let expected = default_tinybot_workspace_root();

        assert_eq!(
            resolve_native_backend_workspace_root_from_config_path(
                &fixture.root.join("missing.json")
            ),
            expected
        );
    }

    #[test]
    fn native_backend_uses_configured_workspace_root() {
        let fixture = WorkspaceFixture::new();
        let workspace_root = fixture.root.join("workspace");
        fixture.write(
            "config.json",
            &serde_json::json!({
                "agents": {
                    "defaults": {
                        "workspace": workspace_root.display().to_string()
                    }
                }
            })
            .to_string(),
        );

        assert_eq!(
            resolve_native_backend_workspace_root_from_config_path(
                &fixture.root.join("config.json")
            ),
            workspace_root
        );
    }

    #[test]
    fn workspace_reveal_uses_configured_tinybot_workspace_root() {
        let fixture = WorkspaceFixture::new();
        let workspace_root = fixture.root.join("workspace");
        fixture.write(
            "config.json",
            &serde_json::json!({
                "agents": {
                    "defaults": {
                        "workspace": workspace_root.display().to_string()
                    }
                }
            })
            .to_string(),
        );

        assert_eq!(
            reveal_workspace_file_path_from_config_path(
                &fixture.root.join("config.json"),
                "AGENTS.md"
            )
            .expect("allowed workspace file should resolve"),
            workspace_root.join("AGENTS.md")
        );
    }

    #[test]
    fn experimental_worker_router_keeps_builtin_skills_root_separate_from_workspace_root() {
        let fixture = WorkspaceFixture::new();
        let workspace_root = fixture.root.join("workspace");
        let builtin_root = fixture.root.join("repo");
        std::fs::create_dir_all(&workspace_root).expect("workspace root should create");
        fixture.write(
            "repo/builtin-skills/builtin-fixture/SKILL.md",
            "---\nname: builtin-fixture\ndescription: Builtin fixture\n---\n",
        );
        let mut router = experimental_worker_router(workspace_root, serde_json::json!({}))
            .with_builtin_skills_root(builtin_root);
        let request = WorkerRequest::new("req-1", "trace-1", "skills.list", serde_json::json!({}));

        let response = router.dispatch(&request);
        let skills = response
            .result
            .as_ref()
            .and_then(|result| result.get("skills"))
            .and_then(serde_json::Value::as_array)
            .expect("skills.list should return skills array");

        assert!(response.error.is_none());
        assert!(skills.iter().any(|skill| {
            skill.get("source").and_then(serde_json::Value::as_str) == Some("builtin")
                && skill
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|path| path.starts_with("builtin-skills/"))
        }));
    }

    #[test]
    fn experimental_worker_router_ignores_corrupt_session_store() {
        let fixture = WorkspaceFixture::new();
        fixture.write("sessions/store.json", "{not valid json");
        let mut router = experimental_worker_router(fixture.root.clone(), serde_json::json!({}));

        let response = router.dispatch(&WorkerRequest::new(
            "req-sessions",
            "trace-sessions",
            "session.list_metadata",
            serde_json::json!({}),
        ));

        assert_eq!(response.error, None);
        assert_eq!(
            response.result,
            Some(serde_json::json!([])),
            "corrupt session stores should not block native worker startup"
        );
    }

    #[test]
    fn experimental_worker_config_snapshot_loads_real_tinybot_config() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "config.json",
            r#"{
          "agents": {
            "defaults": {
              "provider": "deepseek",
              "model": "deepseek-v4-flash"
            }
          },
          "knowledge": {
            "semanticLlmTimeout": 30.0,
            "semanticLlmMaxTokens": 1200
          }
        }"#,
        );
        let config_path = fixture.root.join("config.json");

        let snapshot = experimental_worker_config_snapshot_from_path(&config_path);

        assert_eq!(snapshot["agents"]["defaults"]["provider"], "deepseek");
        assert_eq!(snapshot["agents"]["defaults"]["model"], "deepseek-v4-flash");
        assert_eq!(snapshot["knowledge"]["semanticLlmTimeout"], 30.0);
    }

    #[test]
    fn experimental_worker_config_defaults_to_auto_provider_without_config_file() {
        let fixture = WorkspaceFixture::new();
        assert_eq!(
            experimental_worker_config_snapshot_from_path(
                &fixture.root.join("missing-config.json")
            ),
            serde_json::json!({
                "agents": {
                    "defaults": {
                        "provider": "auto"
                    }
                }
            })
        );
    }

    #[test]
    fn experimental_worker_router_allows_registered_native_agent_tools() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\n",
                serde_json::json!({
                    "id": "note-workspace-policy",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "Use workspace command policies.",
                    "priority": 0.8,
                    "confidence": 0.9,
                    "sources": []
                })
            ),
        );
        let mut router = experimental_worker_router(
            fixture.root.clone(),
            serde_json::json!({
                "tools": {
                    "mcp_servers": {
                        "docs": {
                            "enabled_tools": ["search"],
                            "fixture_tools": {
                                "search": { "content": "docs result" }
                            }
                        }
                    }
                }
            }),
        );

        let memory_response = router.dispatch(&crate::worker_protocol::WorkerRequest::new(
            "memory-search-1",
            "trace-memory-search",
            "memory.search",
            serde_json::json!({ "query": "uv", "limit": 3 }),
        ));
        let mcp_response = router.dispatch(&crate::worker_protocol::WorkerRequest::new(
            "mcp-call-1",
            "trace-mcp-call",
            "mcp.call_tool",
            serde_json::json!({
                "server": "docs",
                "tool": "search",
                "arguments": { "query": "agent loop" }
            }),
        ));

        assert!(
            memory_response.error.is_none(),
            "{:?}",
            memory_response.error
        );
        assert!(mcp_response.error.is_none(), "{:?}", mcp_response.error);
    }

    #[test]
    fn experimental_worker_router_runtime_restart_restarts_stdio_worker() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        let manager = WorkerManager::new(20);
        let restart_spec = test_stdio_agent_echo_worker_spec();
        let router = experimental_worker_router_with_runtime_restart(
            manager.clone(),
            restart_spec.clone(),
            fixture.root.clone(),
            serde_json::json!({}),
        );

        manager
            .start_stdio_rpc(test_stdio_runtime_restart_worker_spec(), router)
            .expect("runtime restart worker should start");

        let status = wait_for_worker_status(&manager, |status| {
            status.state == WorkerManagerState::Running
                && status.label.as_deref() == Some("stdio-agent-echo-worker")
        });
        assert_eq!(status.state, WorkerManagerState::Running);
        assert_eq!(status.label.as_deref(), Some("stdio-agent-echo-worker"));

        let request = WorkerRequest::new(
            "agent-req-1",
            "trace-agent",
            "agent.echo",
            serde_json::json!({ "input": "hello after runtime restart" }),
        );
        let response = manager
            .send_stdio_request(&request, Duration::from_secs(15))
            .expect("restarted worker should accept stdio request");

        assert_eq!(response.result.as_ref().unwrap()["ok"], true);
        assert_eq!(
            response.result.as_ref().unwrap()["echo"],
            "hello after runtime restart"
        );

        manager.stop().expect("worker should stop");
    }

    #[test]
    fn worker_run_agent_uses_rust_runtime_when_selected() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-rust-1",
                "sessionId": "websocket:chat-1",
                "stream": true,
                "messages": [{ "role": "user", "content": "hello rust" }]
            }),
            fixture.root.clone(),
            serde_json::json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "rust fixture answer" }] } }
            }),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should run deterministic fixture provider");

        assert_eq!(result["runtime"], "rust");
        assert_eq!(result["finalContent"], "rust fixture answer");
        assert_eq!(result["events"][0]["eventName"], "agent.delta");
        assert_eq!(result["events"][1]["eventName"], "agent.usage");
        assert_eq!(result["events"][2]["eventName"], "agent.done");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_run_agent_preserves_legacy_tool_content_with_envelope_payload() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-rust-tool-envelope",
                "sessionId": "websocket:chat-tool-envelope",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read with envelope" }]
            }),
            fixture.root.clone(),
            serde_json::json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-envelope",
                                    "name": "workspace.read_file",
                                    "argumentsJson": "{\"path\":\"README.md\"}",
                                    "result": { "content": "README excerpt" }
                                }]
                            },
                            { "content": "final after envelope" }
                        ]
                    }
                }
            }),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should return enriched tool result payloads");
        let tool_result = result["events"]
            .as_array()
            .expect("events should be an array")
            .iter()
            .find(|event| event["eventName"] == "agent.tool.result")
            .expect("tool result event should be present");

        assert_eq!(result["stopReason"], "final_response");
        assert_eq!(result["finalContent"], "final after envelope");
        assert_eq!(tool_result["payload"]["content"], "README excerpt");
        assert_eq!(tool_result["payload"]["envelope"]["status"], "ok");
        assert_eq!(
            tool_result["payload"]["envelope"]["trace"]["toolCallId"],
            "call-envelope"
        );
        assert_eq!(
            tool_result["payload"]["envelope"]["ui"]["type"],
            "generic_result"
        );
    }

    #[test]
    fn worker_run_agent_persists_rust_turn_messages_in_session_store() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let config = serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "persisted assistant" }] } }
        });

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-persist",
                "sessionId": "websocket:chat-persist",
                "messages": [{ "role": "user", "content": "persist me" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should complete fixture-backed turn");
        let history = worker_session_messages_with_options(
            &shared,
            "websocket:chat-persist".to_string(),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("session messages route should read persisted Rust turn");

        assert_eq!(result["stopReason"], "final_response");
        assert_eq!(history["messages"][0]["role"], "user");
        assert_eq!(history["messages"][0]["content"], "persist me");
        assert_eq!(history["messages"][1]["role"], "assistant");
        assert_eq!(history["messages"][1]["content"], "persisted assistant");
    }

    #[derive(Clone)]
    struct RecordingNativeAgentProvider {
        calls: Arc<Mutex<Vec<Vec<serde_json::Value>>>>,
    }

    impl crate::worker_agent_runtime::NativeAgentProvider for RecordingNativeAgentProvider {
        fn complete(
            &self,
            context: &crate::worker_agent_runtime::NativeAgentRunContext,
        ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
            self.calls
                .lock()
                .expect("recording provider calls lock should not be poisoned")
                .push(context.messages.clone());
            Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
                final_content: "remembered answer".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    #[test]
    fn worker_run_agent_hydrates_session_history_before_provider_call() {
        let fixture = WorkspaceFixture::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::new(Mutex::new(GatewayRuntime {
            native_agent_runtime: NativeAgentRuntimeServices::new(
                Arc::new(RecordingNativeAgentProvider {
                    calls: calls.clone(),
                }),
                Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
                Arc::new(
                    crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default(),
                ),
                Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
            ),
            ..GatewayRuntime::default()
        }));
        let config = serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        });
        call_rust_state_service(
            fixture.root.clone(),
            config.clone(),
            WorkerRequest::new(
                "req-seed-history",
                "trace-seed-history",
                "session.persist_turn",
                serde_json::json!({
                    "session_id": "websocket:chat-memory",
                    "run_id": "run-previous",
                    "messages": [
                        { "role": "user", "content": "a" },
                        { "role": "assistant", "content": "agent replied a" }
                    ],
                    "clear_checkpoint": true
                }),
            ),
            "seed session history",
        )
        .expect("session history should seed");

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-next",
                "sessionId": "websocket:chat-memory",
                "input": { "role": "user", "content": "what did I say before?" }
            }),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("Rust runtime should complete with hydrated history");
        let calls = calls
            .lock()
            .expect("recording provider calls lock should not be poisoned");
        let messages = calls.first().expect("provider should be called once");

        assert_eq!(result["stopReason"], "final_response");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "a");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "agent replied a");
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"], "what did I say before?");
    }

    #[test]
    fn worker_run_agent_rejects_terminal_run_reentry_before_provider_call() {
        let fixture = WorkspaceFixture::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::new(Mutex::new(GatewayRuntime {
            native_agent_runtime: NativeAgentRuntimeServices::new(
                Arc::new(RecordingNativeAgentProvider {
                    calls: calls.clone(),
                }),
                Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
                Arc::new(
                    crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default(),
                ),
                Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
            ),
            ..GatewayRuntime::default()
        }));
        let config = serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        });

        let first = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-terminal-reentry",
                "sessionId": "websocket:chat-terminal-reentry",
                "messages": [{ "role": "user", "content": "finish once" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("first Rust runtime turn should complete");
        let second = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-terminal-reentry",
                "sessionId": "websocket:chat-terminal-reentry",
                "messages": [{ "role": "user", "content": "try to continue" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("terminal reentry should return structured rejection");
        let run = read_agent_run_record(
            fixture.root.clone(),
            config,
            "websocket:chat-terminal-reentry",
            "run-terminal-reentry",
        );

        assert_eq!(first["stopReason"], "final_response");
        assert_eq!(second["stopReason"], "terminal_turn");
        assert_eq!(second["terminalRun"]["status"], "completed");
        assert_eq!(second["events"][0]["eventName"], "agent.error");
        assert_eq!(
            calls
                .lock()
                .expect("recording provider calls lock should not be poisoned")
                .len(),
            1
        );
        assert_eq!(run["status"], "completed");
        assert_eq!(run["phase"], "completed");
    }

    #[test]
    fn worker_run_agent_persists_agent_run_record_and_keeps_history_compact() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let config = serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-run-trace",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "README trace body" }
                            }]
                        },
                        { "content": "run trace final" }
                    ]
                }
            }
        });

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-trace-persist",
                "sessionId": "websocket:chat-run-trace",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read and answer" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should complete tool-backed turn");
        let run = call_rust_state_service(
            fixture.root.clone(),
            config.clone(),
            WorkerRequest::new(
                "req-agent-run-get",
                "trace-agent-run-get",
                "agent_run.get",
                serde_json::json!({
                    "session_id": "websocket:chat-run-trace",
                    "run_id": "run-trace-persist"
                }),
            ),
            "agent run read",
        )
        .expect("agent run record should persist");
        let history = worker_session_messages_with_options(
            &shared,
            "websocket:chat-run-trace".to_string(),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("session messages should read");

        assert_eq!(result["stopReason"], "final_response");
        assert_eq!(run["status"], "completed");
        assert_eq!(run["stopReason"], "final_response");
        assert_eq!(
            run["completedToolResults"][0]["toolCallId"],
            "call-run-trace"
        );
        let trace_events = run["traceEvents"]
            .as_array()
            .expect("trace events should be an array");
        assert_eq!(trace_events[0]["schemaVersion"], "tinybot.agent_event.v1");
        assert_eq!(trace_events[0]["eventName"], "agent.turn.started");
        assert_eq!(trace_events[0]["sequence"], 1);
        assert!(trace_events.iter().any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "hydrating_history"
        }));
        assert!(trace_events.iter().any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "calling_model"
        }));
        assert!(trace_events
            .iter()
            .any(|event| event["eventName"] == "agent.tool.result"));
        assert!(trace_events.iter().any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "tool_calling"
        }));
        let tool_result = trace_events
            .iter()
            .find(|event| event["eventName"] == "agent.tool.result")
            .expect("tool result trace event should persist");
        assert_eq!(tool_result["schemaVersion"], "tinybot.agent_event.v1");
        assert_eq!(tool_result["itemId"], "call-run-trace");
        assert_eq!(tool_result["phase"], "tool_running");
        assert!(tool_result["sequence"].as_u64().is_some_and(|value| value > 1));
        assert!(trace_events.iter().any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "finalizing"
        }));
        assert_eq!(history["messages"].as_array().unwrap().len(), 2);
        assert!(history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|message| message["role"] != "tool"));
    }

    #[test]
    fn worker_run_agent_persists_waiting_approval_run_record() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let config = serde_json::json!({});

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-waiting-persist",
                "sessionId": "websocket:chat-waiting-persist",
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-waiting-persist",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should return waiting approval");
        let run = read_agent_run_record(
            fixture.root.clone(),
            config,
            "websocket:chat-waiting-persist",
            "run-waiting-persist",
        );

        assert_eq!(result["stopReason"], "awaiting_approval");
        assert_eq!(run["status"], "waiting");
        assert_eq!(run["phase"], "awaiting_approval");
        assert_eq!(
            run["checkpoint"]["resumeToken"],
            "approval:approval-waiting-persist"
        );
        assert_eq!(
            run["pendingToolCalls"][0]["toolCallId"],
            "approval-waiting-persist"
        );
    }

    #[test]
    fn worker_run_agent_persists_failed_tool_run_with_accumulated_trace() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let config = serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [{
                        "content": "",
                        "toolCalls": [
                            {
                                "id": "call-before-tool-error",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "README before tool error" }
                            },
                            {
                                "id": "call-tool-error",
                                "name": "workspace.list_files",
                                "argumentsJson": "{not json",
                                "result": { "content": "unused" }
                            }
                        ]
                    }]
                }
            }
        });

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-tool-error-persist",
                "sessionId": "websocket:chat-tool-error-persist",
                "maxIterations": 3,
                "messages": [{ "role": "user", "content": "read then fail" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should return structured tool error");
        let run = read_agent_run_record(
            fixture.root.clone(),
            config,
            "websocket:chat-tool-error-persist",
            "run-tool-error-persist",
        );

        assert_eq!(result["stopReason"], "tool_error");
        assert_eq!(run["status"], "failed");
        assert_eq!(run["stopReason"], "tool_error");
        assert_eq!(
            run["completedToolResults"][0]["toolCallId"],
            "call-before-tool-error"
        );
        assert!(run["traceEvents"]
            .as_array()
            .expect("trace events should be an array")
            .iter()
            .any(|event| event["eventName"] == "agent.error"
                && event["payload"]["toolCallId"] == "call-tool-error"));
    }

    #[test]
    fn worker_run_agent_persists_cancelled_run_as_cancelled() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let config = serde_json::json!({});

        let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-cancel-persist",
                "sessionId": "websocket:chat-cancel-persist",
                "metadata": { "fakeCancel": true },
                "messages": [{ "role": "user", "content": "cancel me" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should return structured cancellation");
        let run = read_agent_run_record(
            fixture.root.clone(),
            config,
            "websocket:chat-cancel-persist",
            "run-cancel-persist",
        );

        assert_eq!(result["stopReason"], "cancelled");
        assert_eq!(run["status"], "cancelled");
        assert_eq!(run["phase"], "cancelled");
        assert_eq!(run["checkpoint"]["phase"], "cancelled");
    }

    #[test]
    fn worker_run_agent_persists_redacted_bounded_tool_trace() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let config = serde_json::json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "maxToolResultChars": 12
                }
            },
            "providers": {
                "fixture": {
                    "api_key": "secret-token",
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-redacted",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "secret-token ABCDEFGHIJKLMNOP" }
                            }]
                        },
                        { "content": "bounded final" }
                    ]
                }
            }
        });

        worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-redacted-trace",
                "sessionId": "websocket:chat-redacted-trace",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read bounded" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should complete bounded tool run");
        let run = read_agent_run_record(
            fixture.root.clone(),
            config,
            "websocket:chat-redacted-trace",
            "run-redacted-trace",
        );
        let serialized = run.to_string();
        let envelope = &run["completedToolResults"][0]["envelope"];

        assert!(!serialized.contains("secret-token"));
        assert_eq!(envelope["truncation"]["truncated"], true);
        assert_eq!(envelope["continuation"]["nextOffset"], 12);
        assert!(envelope["modelContent"].as_str().unwrap().chars().count() <= 12);
    }

    #[test]
    fn worker_run_agent_omits_large_raw_tool_trace_from_persisted_run_record() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let large_output = "A".repeat(12_000);
        let config = serde_json::json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "maxToolResultChars": 128
                }
            },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-large",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"large.txt\"}",
                                "result": { "content": large_output }
                            }]
                        },
                        { "content": "large final" }
                    ]
                }
            }
        });

        worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-large-trace",
                "sessionId": "websocket:chat-large-trace",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read large" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should complete large tool run");
        let run = read_agent_run_record(
            fixture.root.clone(),
            config,
            "websocket:chat-large-trace",
            "run-large-trace",
        );
        let serialized = run.to_string();

        assert!(
            serialized.len() < 9_000,
            "run record was {} bytes",
            serialized.len()
        );
        assert_eq!(
            run["completedToolResults"][0]["tracePersistence"]["truncated"],
            true
        );
    }

    fn read_agent_run_record(
        workspace_root: PathBuf,
        config_snapshot: serde_json::Value,
        session_id: &str,
        run_id: &str,
    ) -> serde_json::Value {
        call_rust_state_service(
            workspace_root,
            config_snapshot,
            WorkerRequest::new(
                "req-agent-run-get",
                "trace-agent-run-get",
                "agent_run.get",
                serde_json::json!({
                    "session_id": session_id,
                    "run_id": run_id,
                }),
            ),
            "agent run read",
        )
        .expect("agent run record should persist")
    }

    #[test]
    fn worker_rust_agent_restore_and_cancel_use_native_runtime_state() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let rust_config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        let awaiting = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-approval",
                "sessionId": "WebSocket:chat-approval",
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-1",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create an approval checkpoint");
        let restored = worker_restore_agent_checkpoint_with_options(
            &shared,
            "WebSocket:chat-approval".to_string(),
            fixture.root.clone(),
            rust_config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should restore checkpoints without TS worker");
        let cancelled = worker_cancel_agent_with_options(
            &shared,
            "run-cancel".to_string(),
            rust_config,
            Duration::from_millis(10),
        )
        .expect("Rust runtime should cancel without TS worker");

        assert_eq!(awaiting["stopReason"], "awaiting_approval");
        assert_eq!(restored["runtime"], "rust");
        assert_eq!(restored["checkpoint"]["phase"], "awaiting_approval");
        assert_eq!(restored["checkpoint"]["schemaVersion"], 1);
        assert_eq!(restored["checkpoint"]["iteration"], 0);
        assert_eq!(restored["checkpoint"]["maxIterations"], 1);
        assert_eq!(
            restored["checkpoint"]["pendingToolCalls"]
                .as_array()
                .expect("pending tool calls should be an array")
                .len(),
            1
        );
        assert_eq!(
            restored["checkpoint"]["completedToolResults"]
                .as_array()
                .expect("completed tool results should be an array")
                .len(),
            0
        );
        assert_eq!(cancelled["stopReason"], "cancelled");
        assert_eq!(cancelled["error"], "cancelled");
        assert_eq!(cancelled["events"][0]["eventName"], "agent.cancelled");
        assert_eq!(cancelled["events"][0]["payload"]["stopReason"], "cancelled");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_rust_agent_restores_checkpoint_from_session_store_after_runtime_restart() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let rust_config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        let awaiting = worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-persisted-approval",
                "sessionId": "websocket:chat-persisted-approval",
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-persisted",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create an approval checkpoint");
        let restored = worker_restore_agent_checkpoint_with_options(
            &restarted_runtime,
            "websocket:chat-persisted-approval".to_string(),
            fixture.root.clone(),
            rust_config,
            Duration::from_millis(10),
        )
        .expect("Rust runtime should restore persisted checkpoint after restart");

        assert_eq!(awaiting["stopReason"], "awaiting_approval");
        assert_eq!(restored["runtime"], "rust");
        assert_eq!(restored["checkpoint"]["phase"], "awaiting_approval");
        assert_eq!(restored["checkpoint"]["schemaVersion"], 1);
        assert_eq!(
            restored["checkpoint"]["resumeToken"],
            "approval:approval-persisted"
        );
        assert_eq!(
            restored["checkpoint"]["payload"]["approval_id"],
            "approval-persisted"
        );
        assert_eq!(
            lock_runtime(&restarted_runtime)
                .experimental_worker
                .status()
                .state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_rust_agent_restore_rejects_unknown_checkpoint_schema_version() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        {
            let services = {
                let runtime = lock_runtime(&shared);
                runtime.native_agent_runtime.clone()
            };
            services.save_checkpoint(
                "websocket:chat-future-checkpoint",
                serde_json::json!({
                    "schemaVersion": 999,
                    "runtime": "rust",
                    "runId": "run-future-checkpoint",
                    "sessionId": "websocket:chat-future-checkpoint",
                    "phase": "awaiting_approval"
                }),
            );
        }

        let error = worker_restore_agent_checkpoint_with_options(
            &shared,
            "websocket:chat-future-checkpoint".to_string(),
            fixture.root.clone(),
            serde_json::json!({ "desktop": { "nativeAgentRuntime": "rust" } }),
            Duration::from_millis(10),
        )
        .expect_err("unknown checkpoint versions should fail visibly");

        assert!(
            error.contains("unsupported Rust agent checkpoint schemaVersion 999"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn worker_webui_approvals_lists_persisted_rust_approval_checkpoint() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let session_id = "websocket:chat-persisted-approval-list";

        worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-persisted-approval-list",
                "sessionId": session_id,
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-persisted-list",
                        "toolName": "workspace.write_file",
                        "summary": "write notes"
                    }
                }
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create an approval checkpoint");

        let approvals = worker_webui_route_with_options(
            &restarted_runtime,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/approvals?session_key=websocket%3Achat-persisted-approval-list"
                    .to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("approvals route should read persisted Rust checkpoint");

        assert_eq!(approvals["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(approvals["body"]["session_key"], session_id);
        assert_eq!(
            approvals["body"]["approvals"][0]["id"],
            "approval-persisted-list"
        );
        assert_eq!(
            approvals["body"]["approvals"][0]["tool_name"],
            "workspace.write_file"
        );
        assert_eq!(
            lock_runtime(&restarted_runtime)
                .experimental_worker
                .status()
                .state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_webui_approval_resolution_clears_persisted_rust_checkpoint() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let session_id = "websocket:chat-persisted-approval-resolve";
        let rust_config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-persisted-approval-resolve",
                "sessionId": session_id,
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-persisted-resolve",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create an approval checkpoint");

        let approval_resolution = worker_webui_route_with_options(
            &restarted_runtime,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/approvals/approval-persisted-resolve/approve".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "session_key": session_id,
                    "scope": "session"
                })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("approval resolution route should read persisted Rust checkpoint");
        let restored_after_resolution = worker_restore_agent_checkpoint_with_options(
            &restarted_runtime,
            session_id.to_string(),
            fixture.root.clone(),
            rust_config,
            Duration::from_millis(10),
        )
        .expect("checkpoint restore should still be Rust-owned after approval resolution");

        assert_eq!(
            approval_resolution["headers"]["x-tinybot-route-owner"],
            "rust"
        );
        assert_eq!(approval_resolution["body"]["ok"], true);
        assert_eq!(approval_resolution["body"]["status"], "approved");
        assert_eq!(
            approval_resolution["body"]["approvalId"],
            "approval-persisted-resolve"
        );
        assert_eq!(
            approval_resolution["body"]["restoredCheckpoint"]["phase"],
            "awaiting_approval"
        );
        assert!(restored_after_resolution["checkpoint"].is_null());
    }

    #[test]
    fn worker_webui_approval_resolution_finalizes_rust_turn_and_persists_result() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let session_id = "websocket:chat-approval-finalize";
        let config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-approval-finalize",
                "sessionId": session_id,
                "messages": [{ "role": "user", "content": "write the note" }],
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-finalize",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create an approval checkpoint");

        let approval_resolution = worker_webui_route_with_options(
            &restarted_runtime,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/approvals/approval-finalize/approve".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "session_key": session_id,
                    "scope": "once",
                    "finalContent": "Approved route completed."
                })),
            },
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("approval resolution route should finalize the Rust turn");
        let history = worker_session_messages_with_options(
            &restarted_runtime,
            session_id.to_string(),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("session messages route should read finalized approval turn");

        assert_eq!(
            approval_resolution["headers"]["x-tinybot-route-owner"],
            "rust"
        );
        assert_eq!(approval_resolution["body"]["ok"], true);
        assert_eq!(approval_resolution["body"]["status"], "approved");
        assert_eq!(approval_resolution["body"]["stopReason"], "final_response");
        assert_eq!(
            approval_resolution["body"]["finalContent"],
            "Approved route completed."
        );
        assert_eq!(history["messages"][0]["role"], "user");
        assert_eq!(history["messages"][0]["content"], "write the note");
        assert_eq!(history["messages"][1]["role"], "assistant");
        assert_eq!(
            history["messages"][1]["content"],
            "Approved route completed."
        );
    }

    #[test]
    fn worker_webui_approval_denial_finalizes_with_rust_error_result() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let session_id = "websocket:chat-approval-deny";
        let config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-approval-deny",
                "sessionId": session_id,
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-deny",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create an approval checkpoint");

        let approval_resolution = worker_webui_route_with_options(
            &restarted_runtime,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/approvals/approval-deny/deny".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "session_key": session_id,
                    "guidance": "Do not write files; summarize instead."
                })),
            },
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("approval denial route should finalize the Rust turn");
        let restored_after_resolution = worker_restore_agent_checkpoint_with_options(
            &restarted_runtime,
            session_id.to_string(),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("checkpoint restore should remain Rust-owned after denial");

        assert_eq!(
            approval_resolution["headers"]["x-tinybot-route-owner"],
            "rust"
        );
        assert_eq!(approval_resolution["body"]["ok"], true);
        assert_eq!(approval_resolution["body"]["status"], "denied");
        assert_eq!(approval_resolution["body"]["stopReason"], "approval_denied");
        assert_eq!(
            approval_resolution["body"]["error"],
            "Rust agent approval was denied. User guidance: Do not write files; summarize instead."
        );
        assert_eq!(
            approval_resolution["body"]["guidance"],
            "Do not write files; summarize instead."
        );
        assert!(restored_after_resolution["checkpoint"].is_null());
    }

    #[test]
    fn worker_webui_agent_ui_form_submit_finalizes_rust_turn_and_persists_result() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let session_id = "websocket:chat-form-submit";
        let config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-form-submit",
                "sessionId": session_id,
                "messages": [{ "role": "user", "content": "collect travel details" }],
                "metadata": {
                    "fakeAwaitingForm": {
                        "formId": "travel_plan",
                        "title": "Travel plan",
                        "fields": [
                            { "name": "destination", "type": "text", "required": true }
                        ]
                    }
                }
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create a form checkpoint");

        let form_submission = worker_webui_route_with_options(
            &restarted_runtime,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/agent-ui/forms/travel_plan/submit".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "correlation": { "session_key": session_id },
                    "values": { "destination": "Paris" },
                    "finalContent": "Submitted values received."
                })),
            },
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("form submit route should finalize the Rust turn");
        let history = worker_session_messages_with_options(
            &restarted_runtime,
            session_id.to_string(),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("session messages route should read finalized form turn");

        assert_eq!(form_submission["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(form_submission["body"]["submitted"], true);
        assert_eq!(form_submission["body"]["form_id"], "travel_plan");
        assert_eq!(form_submission["body"]["values"]["destination"], "Paris");
        assert_eq!(form_submission["body"]["stopReason"], "final_response");
        assert_eq!(
            form_submission["body"]["finalContent"],
            "Submitted values received."
        );
        assert_eq!(history["messages"][0]["content"], "collect travel details");
        assert_eq!(
            history["messages"][1]["content"],
            "Submitted values received."
        );
    }

    #[test]
    fn worker_webui_agent_ui_form_cancel_finalizes_with_rust_error_result() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let session_id = "websocket:chat-form-cancel";
        let config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-form-cancel",
                "sessionId": session_id,
                "metadata": {
                    "fakeAwaitingForm": {
                        "formId": "travel_cancel",
                        "title": "Travel cancellation"
                    }
                }
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create a form checkpoint");

        let form_cancellation = worker_webui_route_with_options(
            &restarted_runtime,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/agent-ui/forms/travel_cancel/cancel".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "correlation": { "session_id": session_id }
                })),
            },
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("form cancel route should finalize the Rust turn");
        let restored_after_resolution = worker_restore_agent_checkpoint_with_options(
            &restarted_runtime,
            session_id.to_string(),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("checkpoint restore should remain Rust-owned after form cancellation");

        assert_eq!(
            form_cancellation["headers"]["x-tinybot-route-owner"],
            "rust"
        );
        assert_eq!(form_cancellation["body"]["cancelled"], true);
        assert_eq!(form_cancellation["body"]["form_id"], "travel_cancel");
        assert_eq!(form_cancellation["body"]["stopReason"], "form_cancelled");
        assert_eq!(
            form_cancellation["body"]["error"],
            "Rust agent form was cancelled."
        );
        assert!(restored_after_resolution["checkpoint"].is_null());
    }

    #[test]
    fn worker_webui_agent_ui_form_submit_reports_validation_errors_without_consuming_checkpoint() {
        let fixture = WorkspaceFixture::new();
        let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let session_id = "websocket:chat-form-validation";
        let config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        worker_run_agent_with_options(
            &first_runtime,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-form-validation",
                "sessionId": session_id,
                "metadata": {
                    "fakeAwaitingForm": {
                        "formId": "travel_validation",
                        "fields": [
                            { "name": "destination", "type": "text", "required": true }
                        ]
                    }
                }
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should create a form checkpoint");

        let form_submission = worker_webui_route_with_options(
            &restarted_runtime,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/agent-ui/forms/travel_validation/submit".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "correlation": { "session_key": session_id },
                    "values": {}
                })),
            },
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("form submit route should return validation errors");
        let restored_after_validation = worker_restore_agent_checkpoint_with_options(
            &restarted_runtime,
            session_id.to_string(),
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("checkpoint restore should remain Rust-owned after validation failure");

        assert_eq!(form_submission["status"], 400);
        assert_eq!(form_submission["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(form_submission["body"]["submitted"], false);
        assert_eq!(form_submission["body"]["errors"]["destination"], "Required");
        assert_eq!(
            restored_after_validation["checkpoint"]["phase"],
            "awaiting_form"
        );
    }

    #[test]
    fn worker_webui_approval_and_form_routes_report_missing_checkpoints_with_rust_metadata() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let config = serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" }
        });

        let approval = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/approvals/missing-approval/approve".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "session_key": "websocket:missing-approval"
                })),
            },
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("missing approval route should return Rust diagnostic");
        let form = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/agent-ui/forms/missing-form/submit".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "correlation": { "session_key": "websocket:missing-form" },
                    "values": {}
                })),
            },
            fixture.root.clone(),
            config,
            Duration::from_millis(10),
        )
        .expect("missing form route should return Rust diagnostic");

        assert_eq!(approval["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(approval["headers"]["x-tinybot-route-group"], "approvals");
        assert_eq!(approval["body"]["ok"], false);
        assert_eq!(approval["body"]["status"], "not_found");
        assert_eq!(
            approval["body"]["error"]["message"],
            "pending approval not found"
        );
        assert_eq!(form["status"], 404);
        assert_eq!(form["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(form["headers"]["x-tinybot-route-group"], "agent-ui");
        assert_eq!(form["body"]["submitted"], false);
        assert_eq!(form["body"]["error"], "pending form checkpoint not found");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn cron_model_from_config_defaults_to_agent_model() {
        assert_eq!(
            cron_model_from_config(&serde_json::json!({})),
            "deepseek-reasoner"
        );
    }

    #[test]
    fn worker_heartbeat_lifecycle_requests_target_native_worker_methods() {
        let start =
            build_worker_heartbeat_lifecycle_request(test_request_correlation("42"), "start");
        assert_eq!(start.id, "heartbeat-start-42");
        assert_eq!(start.trace_id, "trace-heartbeat-start-42");
        assert_eq!(start.method, "heartbeat.start");
        assert_eq!(start.params, serde_json::json!({}));

        let stop = build_worker_heartbeat_lifecycle_request(test_request_correlation("43"), "stop");
        assert_eq!(stop.id, "heartbeat-stop-43");
        assert_eq!(stop.trace_id, "trace-heartbeat-stop-43");
        assert_eq!(stop.method, "heartbeat.stop");
        assert_eq!(stop.params, serde_json::json!({}));
    }

    #[test]
    fn worker_cron_dispatch_due_noops_without_due_jobs() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "cron/jobs.json",
            &serde_json::json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "future",
                        "name": "Future",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 100000 },
                        "payload": { "kind": "agent_turn", "message": "later", "deliver": false },
                        "state": { "nextRunAtMs": 100000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    }
                ]
            })
            .to_string(),
        );
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result = worker_cron_dispatch_due_with_options(
            &shared,
            fixture.root.clone(),
            serde_json::json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
            2000,
            Duration::from_secs(1),
        )
        .expect("cron due dispatch should no-op");

        assert_eq!(
            result,
            serde_json::json!({
                "dispatched": 0,
                "records": [],
                "recorded": { "updated": [], "deleted": [], "missing": [] }
            })
        );
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_cron_next_wake_delay_uses_earliest_enabled_job() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "cron/jobs.json",
            &serde_json::json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "later",
                        "name": "Later",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 5000 },
                        "payload": { "kind": "agent_turn", "message": "later", "deliver": false },
                        "state": { "nextRunAtMs": 5000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "disabled-earlier",
                        "name": "Disabled",
                        "enabled": false,
                        "schedule": { "kind": "at", "atMs": 2500 },
                        "payload": { "kind": "agent_turn", "message": "disabled", "deliver": false },
                        "state": { "nextRunAtMs": 2500, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "earliest",
                        "name": "Earliest",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 3500 },
                        "payload": { "kind": "agent_turn", "message": "soon", "deliver": false },
                        "state": { "nextRunAtMs": 3500, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    }
                ]
            })
            .to_string(),
        );

        let delay = worker_cron_next_wake_delay_with_options(
            fixture.root.clone(),
            serde_json::json!({}),
            2000,
            Duration::from_secs(30),
        )
        .expect("cron next wake should be derived from store");

        assert_eq!(delay, Duration::from_millis(1500));
    }

    #[test]
    fn worker_cron_next_wake_delay_backs_off_due_jobs_while_dispatch_is_unsupported() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "cron/jobs.json",
            &serde_json::json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "due",
                        "name": "Due",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 1000 },
                        "payload": { "kind": "agent_turn", "message": "now", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    }
                ]
            })
            .to_string(),
        );

        let delay = worker_cron_next_wake_delay_with_options(
            fixture.root.clone(),
            serde_json::json!({}),
            2000,
            Duration::from_secs(30),
        )
        .expect("cron next wake should back off due jobs");

        assert_eq!(delay, Duration::from_secs(30));
    }

    #[test]
    fn worker_cron_dispatch_due_skips_when_dispatch_already_running() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        {
            let runtime = lock_runtime(&shared);
            runtime
                .cron_dispatch_running
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }

        let result = worker_cron_dispatch_due_with_options(
            &shared,
            fixture.root.clone(),
            serde_json::json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
            2000,
            Duration::from_secs(1),
        )
        .expect("overlapping cron dispatch should skip");

        assert_eq!(
            result,
            serde_json::json!({
                "dispatched": 0,
                "records": [],
                "recorded": { "updated": [], "deleted": [], "missing": [] },
                "skipped": "already_running"
            })
        );
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_skills_requests_target_rust_webui_skill_methods() {
        let list_request = build_worker_skills_list_request(test_request_correlation("42"));
        let detail_request = build_worker_skills_detail_request(
            test_request_correlation("43"),
            "planner/phase".to_string(),
        );
        let create_request = build_worker_skills_create_request(
            test_request_correlation("44"),
            serde_json::json!({ "name": "planner" }),
        );
        let update_request = build_worker_skills_update_request(
            test_request_correlation("45"),
            "planner/phase".to_string(),
            serde_json::json!({ "content": "Updated" }),
        );
        let delete_request = build_worker_skills_delete_request(
            test_request_correlation("46"),
            "planner/phase".to_string(),
        );
        let validate_request = build_worker_skills_validate_request(
            test_request_correlation("47"),
            "planner/phase".to_string(),
        );

        assert_eq!(list_request.id, "skills-list-42");
        assert_eq!(list_request.trace_id, "trace-skills-list-42");
        assert_eq!(list_request.method, "skills.webui_list");
        assert_eq!(list_request.params, serde_json::json!({}));
        assert_eq!(detail_request.id, "skills-detail-43");
        assert_eq!(detail_request.trace_id, "trace-skills-detail-43");
        assert_eq!(detail_request.method, "skills.webui_detail");
        assert_eq!(
            detail_request.params,
            serde_json::json!({ "name": "planner/phase" })
        );
        assert_eq!(create_request.id, "skills-create-44");
        assert_eq!(create_request.trace_id, "trace-skills-create-44");
        assert_eq!(create_request.method, "skills.webui_create");
        assert_eq!(
            create_request.params,
            serde_json::json!({ "body": { "name": "planner" } })
        );
        assert_eq!(update_request.id, "skills-update-45");
        assert_eq!(update_request.trace_id, "trace-skills-update-45");
        assert_eq!(update_request.method, "skills.webui_update");
        assert_eq!(
            update_request.params,
            serde_json::json!({ "name": "planner/phase", "body": { "content": "Updated" } })
        );
        assert_eq!(delete_request.id, "skills-delete-46");
        assert_eq!(delete_request.trace_id, "trace-skills-delete-46");
        assert_eq!(delete_request.method, "skills.webui_delete");
        assert_eq!(
            delete_request.params,
            serde_json::json!({ "name": "planner/phase" })
        );
        assert_eq!(validate_request.id, "skills-validate-47");
        assert_eq!(validate_request.trace_id, "trace-skills-validate-47");
        assert_eq!(validate_request.method, "skills.webui_validate");
        assert_eq!(
            validate_request.params,
            serde_json::json!({ "name": "planner/phase" })
        );
    }

    #[test]
    fn worker_skills_list_reads_rust_workspace() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "skills/planner/SKILL.md",
            "---\nname: planner\ndescription: Plan work\n---\nPlan.",
        );
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result = worker_skills_list_with_options(
            &shared,
            fixture.root.clone(),
            serde_json::json!({ "skills": { "enabled": ["planner"] } }),
            Duration::from_millis(10),
        )
        .expect("skills list should be served by Rust workspace state");

        assert_eq!(result["skills"][0]["name"], "planner");
        assert_eq!(result["skills"][0]["description"], "Plan work");
        assert_eq!(result["skills"][0]["enabled"], true);
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_workspace_file_commands_use_rust_workspace() {
        let fixture = WorkspaceFixture::new();
        fixture.write("docs/readme.md", "old readme");
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let files = worker_workspace_files_with_options(
            &shared,
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("workspace files should be served by Rust workspace state");
        let file = worker_workspace_file_with_options(
            &shared,
            "docs/readme.md".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("workspace file should be served by Rust workspace state");
        let write = worker_workspace_put_file_with_options(
            &shared,
            "docs/readme.md".to_string(),
            serde_json::json!({ "content": "new readme", "expected_updated_at": null }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("workspace write should be served by Rust workspace state");

        assert_eq!(files["items"][0]["path"], "docs/readme.md");
        assert_eq!(file["path"], "docs/readme.md");
        assert_eq!(file["content"], "old readme");
        assert_eq!(write["path"], "docs/readme.md");
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("docs").join("readme.md"))
                .expect("written file should read"),
            "new readme"
        );
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_session_read_commands_use_rust_session_store() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "sessions/store.json",
            &serde_json::json!({
                "version": 1,
                "sessions": [{
                    "session_id": "websocket:chat-1",
                    "title": "Native session",
                    "workspace_dir": "D:/Code/py/tinybot",
                    "created_at": "2026-06-29T08:00:00Z",
                    "updated_at": "2026-06-29T08:30:00Z",
                    "extra": {
                        "messages": [
                            {
                                "role": "user",
                                "content": "Use Rust state",
                                "message_id": "msg-1",
                                "timestamp": "2026-06-29T08:00:01Z"
                            }
                        ]
                    }
                }]
            })
            .to_string(),
        );
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let sessions = worker_sessions_list_with_options(
            &shared,
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("session list should be served by Rust session state");
        let messages = worker_session_messages_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("session messages should be served by Rust session state");

        assert_eq!(sessions["items"][0]["key"], "websocket:chat-1");
        assert_eq!(sessions["items"][0]["chat_id"], "chat-1");
        assert_eq!(sessions["items"][0]["title"], "Native session");
        assert_eq!(messages["key"], "websocket:chat-1");
        assert_eq!(messages["chat_id"], "chat-1");
        assert_eq!(messages["messages"][0]["content"], "Use Rust state");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_session_write_commands_use_rust_session_store_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "sessions/store.json",
            &serde_json::json!({
                "version": 1,
                "sessions": [{
                    "session_id": "websocket:chat-1",
                    "title": "Native session",
                    "workspace_dir": "D:/Code/py/tinybot",
                    "created_at": "2026-06-29T08:00:00Z",
                    "updated_at": "2026-06-29T08:30:00Z",
                    "extra": {
                        "messages": [{ "role": "user", "content": "Keep this" }],
                        "metadata": { "pinned": false }
                    }
                }]
            })
            .to_string(),
        );
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let uploaded = worker_session_upload_temporary_file_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            serde_json::json!({
                "name": "context.md",
                "file_type": "md",
                "content": "hello native",
                "size_bytes": 12
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("temporary upload should be served by Rust session state");
        let temporary_files = worker_session_temporary_files_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("temporary file list should be served by Rust session state");
        let patch = worker_session_patch_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            serde_json::json!({ "metadata": { "pinned": true } }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("session patch should be served by Rust session state");
        let cleared_files = worker_session_clear_temporary_files_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("temporary file clear should be served by Rust session state");
        let cleared_session = worker_session_clear_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("session clear should be served by Rust session state");
        let progress = worker_session_task_progress_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            serde_json::json!({
                "planId": "plan-1",
                "progress": { "completed": 1, "total": 2 },
                "content": "Half done"
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("task progress should be served by Rust session state");
        let deleted = worker_session_delete_with_options(
            &shared,
            "websocket:chat-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("session delete should be served by Rust session state");

        assert_eq!(uploaded["name"], "context.md");
        assert_eq!(temporary_files["key"], "websocket:chat-1");
        assert_eq!(temporary_files["temporary_files"][0]["name"], "context.md");
        assert_eq!(patch["key"], "websocket:chat-1");
        assert_eq!(patch["metadata"]["pinned"], true);
        assert_eq!(cleared_files["cleared"], 1);
        assert_eq!(cleared_session["messages_before"], 1);
        assert_eq!(progress["key"], "websocket:chat-1");
        assert_eq!(
            progress["extra"]["messages"][0]["_task_progress"]["completed"],
            1
        );
        assert_eq!(deleted["key"], "websocket:chat-1");
        assert_eq!(deleted["deleted"], true);
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_session_branch_creates_new_session_without_runtime_state() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "sessions/store.json",
            &serde_json::json!({
                "version": 1,
                "sessions": [{
                    "session_id": "websocket:chat-1",
                    "title": "Source session",
                    "workspace_dir": "D:/Code/py/tinybot",
                    "created_at": "2026-06-29T08:00:00Z",
                    "updated_at": "2026-06-29T08:30:00Z",
                    "extra": {
                        "messages": [{ "role": "user", "content": "Keep this", "message_id": "m1" }],
                        "runtime_checkpoint": { "phase": "running" }
                    }
                }]
            })
            .to_string(),
        );
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let branch = worker_session_branch_with_options(
            &shared,
            serde_json::json!({
                "title": "Source session · 分叉",
                "branchedFromSessionId": "websocket:chat-1",
                "branchedFromMessageId": "m1",
                "messages": [
                    { "messageId": "m1", "role": "user", "content": "Keep this" },
                    { "messageId": "m2", "role": "assistant", "content": "Use this point" }
                ],
                "portableContext": {
                    "chatId": "chat-1",
                    "sessionKey": "websocket:chat-1"
                },
                "runtimeState": {
                    "queuedInputs": [{ "id": "queued-1" }],
                    "pendingApprovals": [{ "id": "approval-1" }]
                }
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("branch session should be created by Rust session state");
        let branch_key = branch["key"].as_str().expect("branch should include key");
        let history = worker_session_messages_with_options(
            &shared,
            branch_key.to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("branch history should be readable");

        assert!(branch_key.starts_with("websocket:branch-"));
        assert_eq!(branch["title"], "Source session · 分叉");
        assert_eq!(history["messages"][0]["content"], "Keep this");
        assert_eq!(history["messages"][1]["content"], "Use this point");
        assert_eq!(
            history["branch"]["branchedFromSessionId"],
            "websocket:chat-1"
        );
        assert_eq!(history["branch"]["branchedFromMessageId"], "m1");
        assert_eq!(history["branch"]["portableContext"]["chatId"], "chat-1");
        assert!(history["runtimeState"].is_null());
        assert!(history["runtime_checkpoint"].is_null());
    }

    #[test]
    fn worker_cowork_route_serves_rust_sessions_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let created = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "POST".to_string(),
                path: "/api/cowork/sessions".to_string(),
                body: Some(serde_json::json!({
                    "goal": "Plan the Rust migration",
                    "title": "Rust migration"
                })),
                query: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork create route should be Rust-owned");
        let session_id = created["body"]["id"]
            .as_str()
            .expect("created cowork session should include id")
            .to_string();
        let listed = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "GET".to_string(),
                path: "/api/cowork/sessions".to_string(),
                body: None,
                query: Some(serde_json::json!({ "include_completed": "true" })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork list route should be Rust-owned");
        let trace = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "GET".to_string(),
                path: format!("/api/cowork/sessions/{session_id}/trace"),
                body: None,
                query: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork trace route should be Rust-owned");
        let run = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "POST".to_string(),
                path: format!("/api/cowork/sessions/{session_id}/run"),
                body: Some(serde_json::json!({ "delegateId": "delegate-rust" })),
                query: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork run route should be Rust-owned");
        let task = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "POST".to_string(),
                path: format!("/api/cowork/sessions/{session_id}/tasks"),
                body: Some(serde_json::json!({ "id": "task-rust", "title": "Rust task" })),
                query: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork task route should be Rust-owned");
        let budget = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "PATCH".to_string(),
                path: format!("/api/cowork/sessions/{session_id}/budget"),
                body: Some(serde_json::json!({ "max_spawned_agents": 1 })),
                query: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork budget route should be Rust-owned");
        let activity = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "GET".to_string(),
                path: format!("/api/cowork/sessions/{session_id}/agents/delegate-rust/activity"),
                body: None,
                query: Some(serde_json::json!({ "limit": "10" })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork agent activity route should be Rust-owned");
        let blueprint = worker_cowork_route_with_options(
            &shared,
            WorkerCoworkRouteInput {
                method: "POST".to_string(),
                path: "/api/cowork/blueprints/validate".to_string(),
                body: Some(serde_json::json!({ "title": "Rust blueprint" })),
                query: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Cowork blueprint route should be Rust-owned");

        assert_eq!(created["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(listed["body"]["sessions"][0]["id"], session_id);
        assert_eq!(trace["body"]["events"][0]["type"], "session.created");
        assert_eq!(
            run["body"]["agents"]["delegate-rust"]["status"],
            "completed"
        );
        assert_eq!(task["body"]["id"], "task-rust");
        assert_eq!(budget["body"]["budget_limits"]["max_spawned_agents"], 1);
        assert_eq!(activity["body"]["agent_id"], "delegate-rust");
        assert_eq!(blueprint["body"]["valid"], true);
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_webui_route_serves_rust_owned_state_routes_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        fixture.write("docs/readme.md", "hello route");
        fixture.write(
            "sessions/store.json",
            &serde_json::json!({
                "version": 1,
                "sessions": [{
                    "session_id": "websocket:chat-1",
                    "title": "Route session",
                    "workspace_dir": "D:/Code/py/tinybot",
                    "created_at": "2026-06-29T08:00:00Z",
                    "updated_at": "2026-06-29T08:30:00Z",
                    "extra": { "messages": [{ "role": "user", "content": "route" }] }
                }]
            })
            .to_string(),
        );
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let bootstrap = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/webui/bootstrap".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({ "agents": { "defaults": { "provider": "auto" } } }),
            Duration::from_millis(10),
        )
        .expect("bootstrap route should be Rust-owned");
        let sessions = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/sessions".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("session route should be Rust-owned");
        let branch = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/sessions/branch".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "title": "Route session · 分叉",
                    "branchedFromSessionId": "websocket:chat-1",
                    "branchedFromMessageId": "route-m1",
                    "messages": [{
                        "messageId": "route-m1",
                        "role": "user",
                        "content": "route"
                    }],
                    "portableContext": { "chatId": "chat-1" }
                })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("session branch route should be Rust-owned");
        let workspace_file = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/workspace/files/docs%2Freadme.md".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("workspace route should be Rust-owned");
        let knowledge = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/v1/knowledge/documents".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "name": "Route Knowledge.md",
                    "content": "# Route Knowledge\n\nRust owns route metadata.\n",
                    "file_type": "md"
                })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge route should be Rust-owned");
        let approvals = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/approvals?session_key=websocket%3Achat-1".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("approvals list route should be Rust-owned");
        let providers = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/providers".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({
                "providers": {
                    "openai": {
                        "api_key": "sk-secret",
                        "api_base": "https://example.test/v1"
                    }
                }
            }),
            Duration::from_millis(10),
        )
        .expect("providers route should be Rust-owned");
        let provider_models = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/provider-models".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "provider": "openai",
                    "manual_models": "manual-model",
                    "refreshLive": true,
                    "liveModelIds": ["live-model"]
                })),
            },
            fixture.root.clone(),
            serde_json::json!({
                "providers": {
                    "openai": {
                        "api_key": "sk-secret",
                        "models": ["profile-model"]
                    }
                }
            }),
            Duration::from_millis(10),
        )
        .expect("provider models route should be Rust-owned");
        let openai_models = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/v1/models".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({
                "agents": { "defaults": { "model": "gpt-4.1-mini" } }
            }),
            Duration::from_millis(10),
        )
        .expect("OpenAI models route should be Rust-owned");
        let approval_resolution = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/api/approvals/approval%2F1/approve".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "session_key": "websocket:chat-1",
                    "scope": "session"
                })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("approval resolution route should be Rust-owned");

        assert_eq!(bootstrap["status"], 200);
        assert_eq!(bootstrap["headers"]["x-tinybot-route-owner"], "rust");
        assert!(bootstrap["body"]["token"]
            .as_str()
            .is_some_and(|token| !token.is_empty()));
        assert_eq!(sessions["body"]["items"][0]["title"], "Route session");
        assert_eq!(branch["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(branch["body"]["title"], "Route session · 分叉");
        assert_eq!(workspace_file["body"]["content"], "hello route");
        assert_eq!(knowledge["body"]["document"]["name"], "Route Knowledge.md");
        assert_eq!(approvals["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(approvals["headers"]["x-tinybot-route-group"], "approvals");
        assert_eq!(approvals["body"]["session_key"], "websocket:chat-1");
        assert_eq!(providers["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(providers["headers"]["x-tinybot-route-group"], "providers");
        assert_eq!(providers["body"]["source"], "rust");
        assert_eq!(
            providers["body"]["providers"][0]["api_key_configured"],
            true
        );
        assert!(providers["body"]["providers"][0].get("api_key").is_none());
        assert_eq!(provider_models["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(provider_models["body"]["ok"], true);
        assert!(provider_models["body"]["models"]
            .as_array()
            .expect("models should be an array")
            .iter()
            .any(|model| model == "live-model"));
        assert_eq!(openai_models["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(openai_models["body"]["data"][0]["id"], "gpt-4.1-mini");
        assert_eq!(
            approval_resolution["headers"]["x-tinybot-route-owner"],
            "rust"
        );
        assert_eq!(approval_resolution["body"]["approvalId"], "approval/1");
        assert_eq!(approval_resolution["body"]["approved"], true);
        assert_eq!(approval_resolution["body"]["status"], "not_found");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_webui_route_classifies_rust_owned_chat_and_unsupported_routes_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let chat = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/v1/chat/completions".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "messages": [{ "role": "user", "content": "hello" }],
                    "stream": true
                })),
            },
            fixture.root.clone(),
            serde_json::json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "route stream" }] } }
            }),
            Duration::from_millis(10),
        )
        .expect("chat route should be Rust-owned");
        let unsupported = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/not-a-route".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("unsupported route should return a structured response");

        assert_eq!(chat["status"], 200);
        assert_eq!(chat["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(chat["headers"]["x-tinybot-route-group"], "openai");
        assert_eq!(chat["headers"]["content-type"], "text/event-stream");
        assert!(chat["body"]
            .as_str()
            .expect("streaming chat route should return text/event-stream body")
            .contains("route stream"));
        assert_eq!(unsupported["status"], 404);
        assert_eq!(
            unsupported["headers"]["x-tinybot-route-owner"],
            "unsupported"
        );
        assert_eq!(unsupported["body"]["diagnostic"], "unsupported-route");
        assert_eq!(unsupported["body"]["inventoryStatus"], "not-inventoried");
        assert_eq!(unsupported["body"]["routeGroup"], "unsupported");
        assert_eq!(unsupported["body"]["method"], "GET");
        assert_eq!(unsupported["body"]["path"], "/api/not-a-route");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
        assert!(current_status(&shared)
            .compatibility_fallback_diagnostics
            .is_empty());
    }

    #[test]
    fn worker_webui_route_returns_unsupported_for_unimplemented_inventory_route_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let response = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/v1/knowledge/graph/extract".to_string(),
                headers: None,
                body: Some(serde_json::json!({ "text": "hello" })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(1),
        )
        .expect("unsupported route should return a structured response");

        let status = current_status(&shared);
        assert_eq!(response["status"], 501);
        assert_eq!(response["headers"]["x-tinybot-route-owner"], "unsupported");
        assert_eq!(response["headers"]["x-tinybot-route-group"], "knowledge");
        assert_eq!(response["body"]["inventoryStatus"], "unsupported");
        assert_eq!(response["body"]["routeGroup"], "knowledge");
        assert!(response["body"]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("not implemented")));
        assert!(status.compatibility_fallback_diagnostics.is_empty());
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_webui_route_uses_default_timeout_for_graph_extraction_start() {
        assert_eq!(
            worker_webui_route_timeout(&WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/v1/knowledge/graph/extract".to_string(),
                body: None,
                headers: None,
            }),
            Duration::from_secs(10)
        );
        assert_eq!(
            worker_webui_route_timeout(&WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/status".to_string(),
                body: None,
                headers: None,
            }),
            Duration::from_secs(10)
        );
    }

    #[test]
    fn worker_transport_websocket_inbound_result_builds_agent_run_input_request() {
        let mapper_result = serde_json::json!({
            "kind": "message",
            "chatId": "chat-1",
            "sessionId": "websocket:chat-1",
            "frames": [],
            "inbound": {
                "channel": "websocket",
                "sender_id": "client-1",
                "chat_id": "chat-1",
                "content": "hello",
                "metadata": { "_use_persistent_rag": true },
                "session_key": "websocket:chat-1"
            }
        });

        let request = build_worker_transport_websocket_run_input_request(
            test_request_correlation("42"),
            &mapper_result,
            WorkerTransportWebSocketDispatchOptions {
                model: Some("gpt-5".to_string()),
                max_iterations: Some(6),
                stream: None,
                ..WorkerTransportWebSocketDispatchOptions::default()
            },
        )
        .expect("message mapper result should build a run request");

        assert_eq!(request.id, "transport-websocket-run-input-42");
        assert_eq!(request.trace_id, "trace-transport-websocket-run-input-42");
        assert_eq!(request.method, "agent.run_input");
        assert_eq!(
            request.params,
            serde_json::json!({
                "input": {
                    "runId": "websocket-chat-1-42",
                    "sessionId": "websocket:chat-1",
                    "input": { "role": "user", "content": "hello" },
                    "channel": "websocket",
                    "chatId": "chat-1",
                    "model": "gpt-5",
                    "maxIterations": 6,
                    "stream": true,
                    "metadata": {
                        "_use_persistent_rag": true,
                        "_wants_stream": true
                    }
                }
            })
        );

        assert!(build_worker_transport_websocket_run_input_request(
            test_request_correlation("43"),
            &serde_json::json!({ "kind": "ping", "frames": [{ "event": "pong" }] }),
            WorkerTransportWebSocketDispatchOptions::default(),
        )
        .is_none());
    }

    #[test]
    fn worker_transport_websocket_dispatch_uses_preallocated_run_id_for_streaming() {
        let mapper_result = serde_json::json!({
            "kind": "message",
            "chatId": "chat-1",
            "sessionId": "websocket:chat-1",
            "frames": [],
            "inbound": {
                "channel": "websocket",
                "sender_id": "client-1",
                "chat_id": "chat-1",
                "content": "hello",
                "metadata": {},
                "session_key": "websocket:chat-1"
            }
        });

        let request = build_worker_transport_websocket_run_input_request(
            test_request_correlation("42"),
            &mapper_result,
            WorkerTransportWebSocketDispatchOptions {
                run_id: Some("websocket-chat-1-preallocated".to_string()),
                ..WorkerTransportWebSocketDispatchOptions::default()
            },
        )
        .expect("message mapper result should build a run request");

        assert_eq!(
            request.params["input"]["runId"],
            serde_json::Value::String("websocket-chat-1-preallocated".to_string())
        );
    }

    #[test]
    fn worker_transport_websocket_dispatch_runs_basic_message_through_rust_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result = worker_transport_dispatch_websocket_message_with_options(
            &shared,
            WorkerTransportWebSocketDispatchInput {
                client_id: "client-1".to_string(),
                frame: serde_json::json!({
                    "type": "message",
                    "chat_id": "chat-1",
                    "content": "hello native websocket",
                    "metadata": { "source": "test" }
                }),
                attached_chat_id: Some("chat-1".to_string()),
                session_exists: Some(true),
                editable_paths: None,
                model: Some("fixture-model".to_string()),
                max_iterations: Some(4),
                run_id: Some("websocket-chat-1-rust".to_string()),
                stream: Some(true),
            },
            fixture.root.clone(),
            serde_json::json!({
                "desktop": { "nativeAgentRuntime": "rust" },
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "rust websocket answer" }] } }
            }),
            Duration::from_millis(10),
        )
        .expect("basic websocket message should dispatch through Rust");

        assert_eq!(result["transport"]["kind"], "message");
        assert_eq!(result["transport"]["sessionId"], "websocket:chat-1");
        assert_eq!(result["agent"]["runtime"], "rust");
        assert_eq!(result["agent"]["runId"], "websocket-chat-1-rust");
        assert_eq!(result["agent"]["stopReason"], "final_response");
        assert_eq!(result["agent"]["finalContent"], "rust websocket answer");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_background_trace_list_request_wraps_filter_for_background_rpc() {
        let request = build_worker_background_trace_list_request(
            test_request_correlation("42"),
            WorkerBackgroundTraceListInput {
                filter: serde_json::json!({ "sessionKey": "WebSocket:chat-1" }),
            },
        );

        assert_eq!(request.id, "background-trace-list-42");
        assert_eq!(request.trace_id, "trace-background-trace-list-42");
        assert_eq!(request.method, "background.trace.list");
        assert_eq!(
            request.params,
            serde_json::json!({ "filter": { "sessionKey": "WebSocket:chat-1" } })
        );
    }

    #[test]
    fn worker_background_trace_list_reads_rust_registry_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let append = worker_background_trace_append_with_options(
            &shared,
            WorkerBackgroundTraceAppendInput {
                event: serde_json::json!({
                    "eventId": "event-1",
                    "eventType": "agent.delegate.started",
                    "sessionKey": "WebSocket:chat-1",
                    "turnId": "turn-1",
                    "delegateId": "delegate-1",
                    "childRunId": "delegate-1",
                    "traceRef": "trace-ref-1",
                    "sequence": 1,
                    "createdAt": "2026-06-29T02:25:30.000Z",
                    "payload": { "status": "running" }
                }),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect(
            "trace append should write the Rust background registry without starting TS worker",
        );

        let result = worker_background_trace_list_with_options(
            &shared,
            WorkerBackgroundTraceListInput {
                filter: serde_json::json!({ "sessionKey": "WebSocket:chat-1" }),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("trace list should read the Rust background registry without starting TS worker");

        assert_eq!(append["event"]["eventId"], "event-1");
        assert_eq!(result["events"][0]["eventId"], "event-1");
        assert_eq!(result["events"][0]["delegateId"], "delegate-1");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_task_plan_commands_use_rust_store() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let plan = serde_json::json!({
            "id": "plan-1",
            "title": "Move state service",
            "status": "active",
            "subtasks": [
                { "id": "task-1", "title": "Persist through Rust", "status": "done" }
            ]
        });

        let saved = worker_task_plan_save_with_options(
            &shared,
            plan.clone(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("task plan save should use Rust task store without starting TS worker");
        let listed = worker_task_plan_list_with_options(
            &shared,
            WorkerTaskPlanListInput {
                include_completed: false,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("task plan list should use Rust task store without starting TS worker");
        let loaded = worker_task_plan_get_with_options(
            &shared,
            "plan-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("task plan get should use Rust task store without starting TS worker");
        let deleted = worker_task_plan_delete_with_options(
            &shared,
            "plan-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("task plan delete should use Rust task store without starting TS worker");
        let missing = worker_task_plan_get_with_options(
            &shared,
            "plan-1".to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("deleted task plan lookup should still be served by Rust task store");

        assert_eq!(saved["plan"], plan);
        assert_eq!(listed["plans"][0]["id"], "plan-1");
        assert_eq!(loaded["plan"]["title"], "Move state service");
        assert_eq!(deleted["deleted"], true);
        assert_eq!(missing["plan"], serde_json::Value::Null);
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_knowledge_state_commands_use_rust_store_on_rust_backend() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let added = worker_knowledge_add_document_with_options(
            &shared,
            serde_json::json!({
                "name": "Native Knowledge.md",
                "content": "# Native Knowledge\n\nRust state services own knowledge metadata.\n",
                "category": "desktop",
                "tags": ["native", "rust"],
                "file_type": "md"
            }),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge add should use Rust store without starting TS worker");
        let doc_id = added["document"]["id"]
            .as_str()
            .expect("added document should include an id")
            .to_string();
        let listed = worker_knowledge_documents_with_options(
            &shared,
            WorkerKnowledgeDocumentsInput {
                category: Some("desktop".to_string()),
                limit: Some(5),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge list should use Rust store without starting TS worker");
        let document = worker_knowledge_document_with_options(
            &shared,
            doc_id.clone(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge get should use Rust store without starting TS worker");
        let stats = worker_knowledge_stats_with_options(
            &shared,
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge stats should use Rust store without starting TS worker");
        let graph = worker_knowledge_graph_with_options(
            &shared,
            WorkerKnowledgeGraphInput {
                doc_id: Some(doc_id.clone()),
                graph_type: Some("document".to_string()),
                limit: Some(10),
                edge_limit: Some(10),
                min_confidence: None,
                include_orphans: Some(true),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge graph should use Rust store without starting TS worker");
        let rebuild = worker_knowledge_rebuild_index_with_options(
            &shared,
            Some("tree".to_string()),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge rebuild should use Rust store without starting TS worker");
        let job = worker_knowledge_job_with_options(
            &shared,
            rebuild["id"]
                .as_str()
                .expect("rebuild job should include id")
                .to_string(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge job should use Rust store without starting TS worker");
        let deleted = worker_knowledge_delete_document_with_options(
            &shared,
            doc_id.clone(),
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("knowledge delete should use Rust store without starting TS worker");

        assert_eq!(listed["documents"][0]["id"], doc_id);
        assert_eq!(document["document"]["name"], "Native Knowledge.md");
        assert_eq!(stats["document_count"], 1);
        assert_eq!(graph["object"], "knowledge_graph");
        assert_eq!(job["status"], "completed");
        assert_eq!(deleted["deleted"], true);
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_background_trace_get_delegate_trace_request_wraps_filter_for_background_rpc() {
        let request = build_worker_background_trace_get_delegate_trace_request(
            test_request_correlation("42"),
            WorkerBackgroundTraceGetDelegateTraceInput {
                filter: serde_json::json!({
                    "sessionKey": "WebSocket:chat-1",
                    "delegateId": "delegate-1"
                }),
            },
        );

        assert_eq!(request.id, "background-trace-get-delegate-trace-42");
        assert_eq!(
            request.trace_id,
            "trace-background-trace-get-delegate-trace-42"
        );
        assert_eq!(request.method, "background.trace.get_delegate_trace");
        assert_eq!(
            request.params,
            serde_json::json!({
                "filter": {
                    "sessionKey": "WebSocket:chat-1",
                    "delegateId": "delegate-1"
                }
            })
        );
    }

    #[test]
    fn worker_background_trace_get_artifact_request_wraps_filter_for_background_rpc() {
        let request = build_worker_background_trace_get_artifact_request(
            test_request_correlation("42"),
            WorkerBackgroundTraceGetArtifactInput {
                filter: serde_json::json!({
                    "sessionKey": "WebSocket:chat-1",
                    "delegateId": "delegate-1",
                    "artifactId": "artifact-1"
                }),
            },
        );

        assert_eq!(request.id, "background-trace-get-artifact-42");
        assert_eq!(request.trace_id, "trace-background-trace-get-artifact-42");
        assert_eq!(request.method, "background.trace.get_artifact");
        assert_eq!(
            request.params,
            serde_json::json!({
                "filter": {
                    "sessionKey": "WebSocket:chat-1",
                    "delegateId": "delegate-1",
                    "artifactId": "artifact-1"
                }
            })
        );
    }

    #[test]
    fn worker_background_subagent_enqueue_input_request_wraps_subagent_payload() {
        let request = build_worker_background_subagent_enqueue_input_request(
            test_request_correlation("42"),
            WorkerBackgroundSubagentInputInput {
                session_key: "WebSocket:chat-1".to_string(),
                subagent_id: "delegate-1".to_string(),
                content: "Use the safer option.".to_string(),
                turn_id: Some("turn-1".to_string()),
                trace_ref: Some("trace-1".to_string()),
                child_run_id: Some("run-1".to_string()),
                created_at: Some("2026-06-29T02:25:31.000Z".to_string()),
                metadata: serde_json::json!({ "surface": "rebuilt-chat" }),
            },
        );

        assert_eq!(request.id, "background-subagent-enqueue-input-42");
        assert_eq!(
            request.trace_id,
            "trace-background-subagent-enqueue-input-42"
        );
        assert_eq!(request.method, "background.subagent.enqueue_input");
        assert_eq!(
            request.params,
            serde_json::json!({
                "sessionKey": "WebSocket:chat-1",
                "subagentId": "delegate-1",
                "content": "Use the safer option.",
                "turnId": "turn-1",
                "traceRef": "trace-1",
                "childRunId": "run-1",
                "createdAt": "2026-06-29T02:25:31.000Z",
                "metadata": { "surface": "rebuilt-chat" }
            })
        );
    }

    #[test]
    fn worker_background_subagent_enqueue_input_writes_rust_registry() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result = worker_background_subagent_enqueue_input_with_options(
            &shared,
            WorkerBackgroundSubagentInputInput {
                session_key: "WebSocket:chat-1".to_string(),
                subagent_id: "delegate-1".to_string(),
                content: "Use the safer option.".to_string(),
                turn_id: Some("turn-1".to_string()),
                trace_ref: Some("trace-1".to_string()),
                child_run_id: Some("run-1".to_string()),
                created_at: Some("2026-06-29T02:25:31.000Z".to_string()),
                metadata: serde_json::json!({ "surface": "rebuilt-chat" }),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("subagent input enqueue should write the Rust background registry");

        assert_eq!(result["accepted"], true);
        assert_eq!(result["delivery"], "queued_for_runtime");
        assert_eq!(
            result["event"]["eventType"],
            "agent.delegate.message_queued"
        );
        assert_eq!(result["event"]["delegateId"], "delegate-1");
        assert_eq!(
            result["event"]["payload"]["content"],
            "Use the safer option."
        );
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn gateway_status_exposes_port_and_exit_policy() {
        let shared = Arc::new(Mutex::new(GatewayRuntime {
            experimental_worker: WorkerManager::new(200),
            logs: VecDeque::with_capacity(200),
            last_error: None,
            keep_background: true,
            ..GatewayRuntime::default()
        }));

        let status = current_status(&shared);

        assert_eq!(status.port, 18790);
        assert_eq!(status.exit_policy, "keep_running");
    }

    #[test]
    fn gateway_exit_policy_preference_persists_across_runtime_restart() {
        let path = std::env::temp_dir().join(format!(
            "tinybot-desktop-gateway-exit-policy-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        persist_gateway_exit_policy(&path, true).expect("preference should persist");

        assert!(load_gateway_exit_policy(&path));

        persist_gateway_exit_policy(&path, false).expect("preference should update");

        assert!(!load_gateway_exit_policy(&path));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn worker_diagnostics_append_to_persistent_backend_log() {
        let fixture = WorkspaceFixture::new();
        let log_path = fixture.root.join("logs").join("native-backend.log");
        let shared = Arc::new(Mutex::new(GatewayRuntime {
            persistent_log_path: log_path.clone(),
            ..GatewayRuntime::default()
        }));

        record_worker_manager_event_for_logs(
            &shared,
            &WorkerManagerEvent::Diagnostics(crate::worker_protocol::WorkerDiagnosticLine::new(
                "stderr",
                "[native-backend] worker.request.start route=POST /v1/knowledge/graph/extract",
            )),
        );

        let contents =
            std::fs::read_to_string(log_path).expect("persistent backend log should be written");
        assert!(contents.contains(
            "stderr [native-backend] worker.request.start route=POST /v1/knowledge/graph/extract"
        ));
    }

    #[test]
    fn gateway_status_exposes_recent_persistent_backend_log_tail() {
        let fixture = WorkspaceFixture::new();
        let log_path = fixture.root.join("logs").join("native-backend.log");
        std::fs::create_dir_all(log_path.parent().expect("log path should have parent"))
            .expect("log directory should create");
        std::fs::write(
            &log_path,
            "older line\nworker.request.start route=POST /v1/knowledge/graph/extract\nknowledge.graph.extract.progress percent=60\n",
        )
        .expect("persistent log should write");
        let shared = Arc::new(Mutex::new(GatewayRuntime {
            persistent_log_path: log_path,
            ..GatewayRuntime::default()
        }));

        let status = current_status(&shared);

        assert_eq!(status.log_tail.len(), 3);
        assert!(status
            .log_tail
            .iter()
            .any(|line| line.contains("POST /v1/knowledge/graph/extract")));
        assert!(status
            .log_tail
            .iter()
            .any(|line| line.contains("knowledge.graph.extract.progress")));
    }

    #[test]
    fn persistent_backend_log_rotates_when_size_limit_is_exceeded() {
        let fixture = WorkspaceFixture::new();
        let log_path = fixture.root.join("logs").join("native-backend.log");
        std::fs::create_dir_all(log_path.parent().expect("log path should have parent"))
            .expect("log directory should create");
        std::fs::write(&log_path, "older diagnostic line\n").expect("old log should write");

        append_native_backend_log_line(&log_path, 8, "stderr", "new diagnostic line")
            .expect("new log line should append");

        let rotated = std::fs::read_to_string(log_path.with_extension("log.1"))
            .expect("rotated log should exist");
        let current = std::fs::read_to_string(log_path).expect("current log should exist");
        assert!(rotated.contains("older diagnostic line"));
        assert!(current.contains("stderr new diagnostic line"));
    }

    #[test]
    fn native_config_patch_result_persists_legacy_compatible_config_file() {
        let fixture = WorkspaceFixture::new();
        let config_path = fixture.root.join(".tinybot").join("config.json");
        let result = apply_config_patch_result_to_path(
            &config_path,
            serde_json::json!({"agents":{"defaults":{"model":"gpt-4.1-mini","provider":"openai"}}}),
            crate::config_store::ConfigPatchBridgeResult {
                ok: true,
                config: serde_json::json!({"agents":{"defaults":{"model":"gpt-4.1","provider":"openai"}}}),
                updated_fields: vec!["agents.defaults.model".to_string()],
                side_effects: crate::config_store::ConfigPatchSideEffects {
                    applied: vec!["providerRuntimeChanged".to_string()],
                    restart_required: vec![],
                    warnings: vec![],
                },
                error: None,
            },
        )
        .expect("native config patch should persist");

        assert!(result.ok);
        assert_eq!(result.config["agents"]["defaults"]["model"], "gpt-4.1");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(config_path).expect("config file should save")
            )
            .expect("saved config should be JSON")["agents"]["defaults"]["model"],
            "gpt-4.1"
        );
    }

    #[test]
    fn native_config_editor_snapshot_returns_redacted_revisioned_view() {
        let fixture = WorkspaceFixture::new();
        let config_path = fixture.root.join(".tinybot").join("config.json");
        std::fs::create_dir_all(
            config_path
                .parent()
                .expect("config path should have parent"),
        )
        .expect("config directory should create");
        std::fs::write(
            &config_path,
            r#"{
              "agents": { "defaults": { "model": "gpt-5" } },
              "providers": { "openai": { "api_key": "sk-secret" } }
            }"#,
        )
        .expect("fixture config should write");

        let snapshot = config_editor_snapshot_from_path(
            &config_path,
            serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
        )
        .expect("editor snapshot should load");

        assert_eq!(snapshot.config_path, config_path);
        assert!(snapshot.revision.starts_with("hash:"));
        assert_eq!(
            snapshot.explicit_public_config["providers"]["openai"]["api_key_configured"],
            true
        );
        assert!(snapshot.explicit_public_config["providers"]["openai"]
            .get("api_key")
            .is_none());
        assert_eq!(
            snapshot.secret_presence["providers.openai.api_key"]["configured"],
            true
        );
    }

    #[test]
    fn native_config_operations_preserve_secret_while_saving_unrelated_field() {
        let fixture = WorkspaceFixture::new();
        let config_path = fixture.root.join(".tinybot").join("config.json");
        std::fs::create_dir_all(
            config_path
                .parent()
                .expect("config path should have parent"),
        )
        .expect("config directory should create");
        std::fs::write(
            &config_path,
            r#"{
              "agents": { "defaults": { "model": "gpt-5", "timezone": "UTC" } },
              "providers": { "openai": { "api_key": "sk-secret" } }
            }"#,
        )
        .expect("fixture config should write");
        let store = crate::config_store::ConfigStore::load(
            config_path.clone(),
            serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
        )
        .expect("fixture config should load");

        let result = apply_config_operations_to_path(
            &config_path,
            serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
            crate::config_store::ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![crate::config_store::ConfigOperation::Replace {
                    path: "agents.defaults.timezone".to_string(),
                    value: serde_json::json!("Asia/Shanghai"),
                }],
            },
        )
        .expect("native config operations should persist");

        assert!(result.ok);
        assert_eq!(result.updated_fields, vec!["agents.defaults.timezone"]);
        assert_eq!(
            result.config["providers"]["openai"]["api_key_configured"],
            true
        );
        assert!(result.config["providers"]["openai"]
            .get("api_key")
            .is_none());
        let saved = serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(config_path).expect("config file should save"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
        assert_eq!(saved["providers"]["openai"]["api_key"], "sk-secret");
    }

    #[test]
    fn native_config_operations_save_to_custom_config_path() {
        let fixture = WorkspaceFixture::new();
        let config_path = fixture.root.join("portable").join("custom-config.json");
        std::fs::create_dir_all(
            config_path
                .parent()
                .expect("config path should have parent"),
        )
        .expect("config directory should create");
        std::fs::write(&config_path, r#"{"agents":{"defaults":{"model":"gpt-5"}}}"#)
            .expect("fixture config should write");
        let store =
            crate::config_store::ConfigStore::load(config_path.clone(), serde_json::json!({}))
                .expect("custom config should load");

        let result = apply_config_operations_to_path(
            &config_path,
            serde_json::json!({}),
            crate::config_store::ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![crate::config_store::ConfigOperation::Replace {
                    path: "agents.defaults.timezone".to_string(),
                    value: serde_json::json!("Asia/Shanghai"),
                }],
            },
        )
        .expect("custom config operation should persist");

        assert!(result.ok);
        let saved = serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(&config_path).expect("custom config should save"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["agents"]["defaults"]["model"], "gpt-5");
        assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
        assert!(!fixture.root.join(".tinybot").join("config.json").exists());
    }

    #[test]
    fn bootstrap_probe_classifies_incompatible_2xx_response() {
        let probe = classify_bootstrap_response(
            Some(200),
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>not tinybot</html>",
        );

        assert_eq!(probe.bootstrap_status(), "incompatible");
        assert_eq!(
            probe.response_class(),
            Some("incompatible-bootstrap".to_string())
        );
        assert!(probe
            .last_error()
            .expect("incompatible probe should explain the response")
            .contains("not valid JSON"));
    }

    #[test]
    fn bootstrap_probe_classifies_http_error_response() {
        let probe = classify_bootstrap_response(
            Some(403),
            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{\"error\":\"forbidden\"}",
        );

        assert_eq!(probe.bootstrap_status(), "bootstrap_error");
        assert_eq!(probe.response_class(), Some("HTTP 403".to_string()));
    }

    #[test]
    fn gateway_runtime_status_serializes_worker_runtime_status() {
        let status = GatewayRuntimeStatus {
            state: "running".to_string(),
            owner: "external".to_string(),
            http_ok: true,
            gateway_http: "http://127.0.0.1:18790",
            gateway_ws: "ws://127.0.0.1:18790/ws",
            command: "Tauri Rust backend",
            port: 18790,
            repo_root: "/repo".to_string(),
            log_path: "/logs/native-backend.log".to_string(),
            log_tail: vec![],
            logs: vec![],
            last_error: None,
            exit_policy: "stop_on_exit",
            bootstrap_status: "ready".to_string(),
            response_class: Some("tinybot-bootstrap".to_string()),
            recovery_hint: None,
            worker_runtime: crate::worker_runtime::WorkerRuntimeStatus::stopped(),
            route_owner_summary: crate::native_backend_contract::native_route_owner_summary(),
            webui_route_inventory: crate::native_backend_contract::native_webui_route_inventory(),
            compatibility_fallback_diagnostics: vec![],
        };

        let value = serde_json::to_value(status).expect("status should serialize");

        assert_eq!(value["worker_runtime"]["state"], "stopped");
        assert!(value["worker_runtime"]["transport_mode"].is_null());
        assert!(value["route_owner_summary"]["rustOwned"]
            .as_u64()
            .is_some_and(|count| count > 0));
        assert!(value["webui_route_inventory"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
    }

    #[test]
    fn worker_manager_status_event_maps_to_frontend_worker_status_event() {
        let (event_name, payload) =
            worker_manager_frontend_event(WorkerManagerEvent::Status(WorkerManagerStatus {
                state: WorkerManagerState::Running,
                label: Some("tinybot-gateway".to_string()),
                pid: Some(1234),
                started_at_unix_ms: Some(42),
                diagnostics: vec![],
                last_error: None,
            }));

        assert_eq!(event_name, "worker:status");
        assert_eq!(payload["state"], "running");
        assert_eq!(payload["label"], "tinybot-gateway");
        assert_eq!(payload["pid"], 1234);
    }

    #[test]
    fn worker_manager_diagnostics_event_maps_to_frontend_diagnostics_log_event() {
        let (event_name, payload) = worker_manager_frontend_event(WorkerManagerEvent::Diagnostics(
            crate::worker_protocol::WorkerDiagnosticLine::new("stderr", "worker ready"),
        ));

        assert_eq!(event_name, "diagnostics:log");
        assert_eq!(payload["stream"], "stderr");
        assert_eq!(payload["line"], "worker ready");
    }

    #[test]
    fn worker_manager_protocol_event_maps_to_frontend_protocol_event_name() {
        let (event_name, payload) = worker_manager_frontend_event(WorkerManagerEvent::Protocol(
            crate::worker_protocol::WorkerEvent {
                protocol_version: crate::worker_protocol::WORKER_PROTOCOL_VERSION.to_string(),
                trace_id: "trace-agent".to_string(),
                event: "agent.delta".to_string(),
                payload: serde_json::json!({ "message": "starting" }),
            },
        ));

        assert_eq!(event_name, "agent:delta");
        assert_eq!(payload["message"], "starting");
    }

    #[test]
    fn worker_probe_status_reports_protocol_metadata() {
        let status = worker_probe_status();
        let value = serde_json::to_value(status).expect("worker probe status should serialize");

        assert_eq!(value["state"], "running");
        assert!(value["transport_mode"].is_null());
        assert_eq!(
            value["diagnostics"][0]["line"],
            format!(
                "rust backend protocol {}",
                crate::worker_protocol::WORKER_PROTOCOL_VERSION
            )
        );
    }

    #[test]
    fn selected_upload_file_response_preserves_name_mime_size_and_bytes() {
        let path =
            std::env::temp_dir().join(format!("tinybot-desktop-upload-{}.md", std::process::id()));
        std::fs::write(&path, b"hello desktop").expect("test upload fixture should write");

        let file = upload_file_from_path(&path).expect("selected file should read");

        assert_eq!(file.name, path.file_name().unwrap().to_string_lossy());
        assert_eq!(file.mime_type, "text/markdown");
        assert_eq!(file.size_bytes, 13);
        assert_eq!(file.bytes, b"hello desktop");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn selected_upload_file_mime_fallback_is_octet_stream() {
        assert_eq!(
            mime_type_for_path(Path::new("archive.tinybot")),
            "application/octet-stream"
        );
        assert_eq!(mime_type_for_path(Path::new("image.PNG")), "image/png");
    }

    #[test]
    fn workspace_reveal_path_accepts_only_allowed_workspace_files() {
        let root = Path::new("/repo");

        assert_eq!(
            allowed_workspace_file_path(root, "AGENTS.md").expect("allowed workspace file"),
            root.join("AGENTS.md")
        );
        assert_eq!(
            allowed_workspace_file_path(root, "memory/MEMORY.md")
                .expect("allowed nested workspace file"),
            root.join("memory").join("MEMORY.md")
        );
        assert!(allowed_workspace_file_path(root, "../secret.txt").is_err());
        assert!(allowed_workspace_file_path(root, "notes/private.md").is_err());
    }

    #[test]
    fn export_file_write_preserves_utf8_contents() {
        let path =
            std::env::temp_dir().join(format!("tinybot-desktop-export-{}.md", std::process::id()));

        write_export_file(&path, "# Export\n\nHello.").expect("export file should write");

        assert_eq!(
            std::fs::read_to_string(&path).expect("export file should read"),
            "# Export\n\nHello."
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn desktop_application_menu_describes_core_workbench_commands() {
        let ids: Vec<&str> = desktop_menu_item_descriptors()
            .iter()
            .map(|item| item.id)
            .collect();

        assert_eq!(
            ids,
            vec![
                "new-chat",
                "stop-generation",
                "search-sessions",
                "open-settings",
                "open-docs",
                "open-shortcut-help",
                "open-page-help",
                "open-backend-logs",
                "toggle-theme",
                "toggle-sidebar",
                "open-command-palette",
                "refresh-gateway-status",
            ]
        );
        assert!(desktop_menu_item_descriptors()
            .iter()
            .any(|item| item.id == "toggle-sidebar" && item.checked));
        assert!(desktop_menu_item_descriptors()
            .iter()
            .any(|item| item.id == "stop-generation" && !item.enabled));
        assert_eq!(
            desktop_menu_item_descriptors()
                .iter()
                .map(|item| item.accelerator)
                .collect::<Vec<_>>(),
            vec![
                Some("Ctrl+N"),
                Some("Ctrl+."),
                Some("Ctrl+F"),
                Some("Ctrl+,"),
                Some("F1"),
                Some("Ctrl+/"),
                Some("Ctrl+Shift+/"),
                None,
                Some("Ctrl+Shift+T"),
                Some("Ctrl+B"),
                Some("Ctrl+Shift+P"),
                Some("Ctrl+Shift+G"),
            ]
        );
    }

    fn test_gateway_worker_spec(label: &str) -> crate::worker_manager::WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "cmd",
                ["/C", "ping", "-n", "30", "127.0.0.1", ">", "NUL"],
                PathBuf::from("."),
            )
            .with_label(label)
        }

        #[cfg(not(target_os = "windows"))]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "sh",
                ["-c", "sleep 30"],
                PathBuf::from("."),
            )
            .with_label(label)
        }
    }

    fn test_gateway_short_worker_spec(label: &str) -> crate::worker_manager::WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "cmd",
                ["/C", "ping", "-n", "3", "127.0.0.1", ">", "NUL"],
                PathBuf::from("."),
            )
            .with_label(label)
        }

        #[cfg(not(target_os = "windows"))]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "sh",
                ["-c", "sleep 2"],
                PathBuf::from("."),
            )
            .with_label(label)
        }
    }

    fn test_stdio_runtime_restart_worker_spec() -> crate::worker_manager::WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","id":"req-restart","trace_id":"trace-restart","method":"runtime.restart","params":{"run_id":"run-1","session_id":"session-1"}}'; [Console]::Out.WriteLine($json); $line = [Console]::In.ReadLine(); [Console]::Error.WriteLine($line)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-runtime-restart-worker")
        }

        #[cfg(not(target_os = "windows"))]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","id":"req-restart","trace_id":"trace-restart","method":"runtime.restart","params":{"run_id":"run-1","session_id":"session-1"}}'; printf '%s\n' "$json"; IFS= read -r line; printf '%s\n' "$line" >&2"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-runtime-restart-worker")
        }
    }

    fn test_stdio_agent_echo_worker_spec() -> crate::worker_manager::WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$agent = [Console]::In.ReadLine(); $agentObj = $agent | ConvertFrom-Json; $final = @{ protocol_version = '1'; id = $agentObj.id; trace_id = $agentObj.trace_id; result = @{ ok = $true; echo = $agentObj.params.input; workspaceFileCount = 1 } } | ConvertTo-Json -Compress -Depth 8; [Console]::Out.WriteLine($final)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
        }

        #[cfg(not(target_os = "windows"))]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"IFS= read -r agent; printf '%s\n' '{"protocol_version":"1","id":"agent-req-1","trace_id":"trace-agent","result":{"ok":true,"echo":"hello after runtime restart","workspaceFileCount":1}}'"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
        }
    }

    fn wait_for_worker_status(
        manager: &WorkerManager,
        predicate: impl Fn(&WorkerManagerStatus) -> bool,
    ) -> WorkerManagerStatus {
        for _ in 0..100 {
            let status = manager.status();
            if predicate(&status) {
                return status;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        manager.status()
    }

    fn test_logging_sleep_worker_spec(
        label: &str,
        message: &str,
    ) -> crate::worker_manager::WorkerCommandSpec {
        #[cfg(target_os = "windows")]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "cmd",
                ["/C", &format!("echo {message} & ping -n 3 127.0.0.1 > NUL")],
                PathBuf::from("."),
            )
            .with_label(label)
        }

        #[cfg(not(target_os = "windows"))]
        {
            crate::worker_manager::WorkerCommandSpec::new(
                "sh",
                ["-c", &format!("echo {message}; sleep 2")],
                PathBuf::from("."),
            )
            .with_label(label)
        }
    }

    fn wait_for_worker_diagnostics(
        manager: &WorkerManager,
        predicate: impl Fn(&[crate::worker_protocol::WorkerDiagnosticLine]) -> bool,
    ) -> Vec<crate::worker_protocol::WorkerDiagnosticLine> {
        for _ in 0..30 {
            let diagnostics = manager.status().diagnostics;
            if predicate(&diagnostics) {
                return diagnostics;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        manager.status().diagnostics
    }

    struct WorkspaceFixture {
        root: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-echo-command-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            Self { root }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
