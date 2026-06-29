#![recursion_limit = "256"]

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager, Runtime, State, WindowEvent};

pub mod config_store;
pub mod desktop_cron;
pub mod desktop_files;
pub mod desktop_gateway;
pub mod desktop_heartbeat;
pub mod desktop_logging;
pub mod desktop_menu;
pub mod native_backend_contract;
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
    stop_owned_gateway, ts_compatibility_worker_enabled,
};
use crate::desktop_heartbeat::{
    start_worker_heartbeat_runtime_with_options, stop_worker_heartbeat_runtime_with_options,
};
use crate::desktop_logging::append_native_backend_log_line;
use crate::desktop_menu::{
    install_desktop_application_menu, is_desktop_menu_command, DesktopMenuCommandPayload,
};
use crate::worker_agent_runtime::{
    resolve_native_agent_runtime_mode, run_native_agent_turn_with_services, NativeAgentRuntimeMode,
    NativeAgentRuntimeServices,
};
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

struct GatewayRuntime {
    experimental_worker: WorkerManager,
    native_agent_runtime: NativeAgentRuntimeServices,
    logs: VecDeque<String>,
    persistent_log_path: PathBuf,
    last_error: Option<String>,
    keep_background: bool,
    cron_dispatch_running: Arc<AtomicBool>,
    cron_timer_started: Arc<AtomicBool>,
    cron_timer_stop: Arc<AtomicBool>,
}

impl Default for GatewayRuntime {
    fn default() -> Self {
        Self {
            experimental_worker: WorkerManager::new(200),
            native_agent_runtime: NativeAgentRuntimeServices::default(),
            logs: VecDeque::with_capacity(200),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
fn worker_skills_list(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_skills_list_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_workspace_files(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_workspace_files_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_sessions_list(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_sessions_list_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
    let workspace_root = ts_agent_worker_workspace_root();
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
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
fn worker_channel_start(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_channel_start_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
}

#[tauri::command]
fn worker_channel_status(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_channel_status_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_channel_stop(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_channel_stop_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_task_plan_list(
    input: WorkerTaskPlanListInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_list_with_options(
        state.inner(),
        input,
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
fn worker_knowledge_stats(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_knowledge_stats_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
        ts_agent_worker_workspace_root(),
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
    if resolve_native_agent_runtime_mode(&spec, &config_snapshot) == NativeAgentRuntimeMode::Rust {
        let services = {
            let runtime = lock_runtime(shared);
            runtime.native_agent_runtime.clone()
        };
        return run_native_agent_turn_with_services(&services, spec);
    }

    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request = build_worker_run_agent_request(next_worker_request_correlation(), spec);
    client.call(&request, timeout, "worker agent run")
}

fn build_worker_run_agent_request(
    request_id: WorkerRequestCorrelation,
    spec: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("agent-run"),
        request_id.trace_id("agent-run"),
        "agent.run",
        serde_json::json!({ "spec": spec }),
    )
}

fn worker_run_agent_input_with_options(
    shared: &SharedGateway,
    input: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request = build_worker_run_agent_input_request(next_worker_request_correlation(), input);
    client.call(&request, timeout, "worker agent run input")
}

fn build_worker_run_agent_input_request(
    request_id: WorkerRequestCorrelation,
    input: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("agent-run-input"),
        request_id.trace_id("agent-run-input"),
        "agent.run_input",
        serde_json::json!({ "input": input }),
    )
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
        workspace_root,
        config_snapshot,
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
        item.insert("metadata".to_string(), metadata);
    }
    Ok(serde_json::Value::Object(item))
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
    shared: &SharedGateway,
    input: WorkerCoworkRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    if let Some(response) = worker_cowork_rust_route_with_options(&input, workspace_root.clone()) {
        return response;
    }

    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request = build_worker_cowork_route_request(next_worker_request_correlation(), input);
    client.call(&request, timeout, "worker cowork route")
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
        _ => worker_cowork_rust_dynamic_route(&runtime, &method, &path),
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
    None
}

fn build_worker_cowork_route_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerCoworkRouteInput,
) -> WorkerRequest {
    let mut params = serde_json::json!({
        "method": input.method,
        "path": input.path,
    });
    if let Some(body) = input.body {
        params["body"] = body;
    }
    if let Some(query) = input.query {
        params["query"] = query;
    }
    WorkerRequest::new(
        request_id.id("cowork-route"),
        request_id.trace_id("cowork-route"),
        "cowork.route_request",
        params,
    )
}

fn worker_webui_route_with_options(
    shared: &SharedGateway,
    input: WorkerWebuiRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    if let Some(response) = worker_webui_rust_route_with_options(
        shared,
        &input,
        workspace_root.clone(),
        config_snapshot.clone(),
        timeout,
    )? {
        return Ok(response);
    }

    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request = build_worker_webui_route_request(next_worker_request_correlation(), input);
    client.call(&request, timeout, "worker webui route")
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
        ("GET", "/api/sessions") => Some(worker_sessions_list_with_options(
            shared,
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
        ("GET", "/api/approvals") => Some(Ok(native_webui_approvals_body(&query))),
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
        None if is_delegated_webui_route(&method, &path) => Ok(None),
        None => Ok(Some(webui_route_response(
            404,
            serde_json::json!({
                "error": {
                    "message": "webui control route unavailable",
                },
                "method": method,
                "path": path,
                "route": format!("{} {}", method, path),
            }),
            "unsupported",
            webui_route_group(&path),
        ))),
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
            return Some(Ok(native_webui_approval_resolution_body(
                approval_id,
                body,
                true,
            )));
        }
    }
    if let Some(approval_id) = webui_approval_route_id(path, "/deny") {
        if method == "POST" {
            return Some(Ok(native_webui_approval_resolution_body(
                approval_id,
                body,
                false,
            )));
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
        "provider": serde_json::Value::Null,
        "model": serde_json::Value::Null,
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

fn native_webui_approvals_body(query: &HashMap<String, String>) -> serde_json::Value {
    let session_key = query
        .get("session_key")
        .or_else(|| query.get("chat_id"))
        .cloned()
        .unwrap_or_default();
    serde_json::json!({
        "session_key": session_key,
        "approvals": [],
        "source": "rust",
    })
}

fn native_webui_approval_resolution_body(
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

fn is_delegated_webui_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/v1/models")
            | ("POST", "/v1/chat/completions")
            | ("PATCH", "/api/config")
            | ("GET", "/api/providers")
            | ("POST", "/api/provider-models")
            | ("POST", "/v1/knowledge/query")
            | ("POST", "/v1/knowledge/graph/extract")
            | ("GET", "/v1/knowledge/graphrag")
    ) || path.starts_with("/api/agent-ui/")
        || path.starts_with("/api/cowork/")
}

fn worker_webui_route_timeout(input: &WorkerWebuiRouteInput) -> Duration {
    let _ = input;
    WORKER_WEBUI_ROUTE_TIMEOUT
}

fn build_worker_webui_route_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerWebuiRouteInput,
) -> WorkerRequest {
    let mut params = serde_json::json!({
        "method": input.method,
        "path": input.path,
    });
    if let Some(body) = input.body {
        params["body"] = body;
    }
    if let Some(headers) = input.headers {
        params["headers"] = headers;
    }
    WorkerRequest::new(
        request_id.id("webui-route"),
        request_id.trace_id("webui-route"),
        "webui.handle_request",
        params,
    )
}

fn worker_transport_gateway_frame_with_options(
    shared: &SharedGateway,
    input: WorkerTransportGatewayFrameInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request =
        build_worker_transport_gateway_frame_request(next_worker_request_correlation(), input);
    client.call(&request, timeout, "worker transport gateway frame")
}

fn build_worker_transport_gateway_frame_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerTransportGatewayFrameInput,
) -> WorkerRequest {
    let mut params = serde_json::json!({
        "kind": input.kind,
        "chatId": input.chat_id,
    });
    if let Some(content) = input.content {
        params["content"] = serde_json::Value::String(content);
    }
    if let Some(delta) = input.delta {
        params["delta"] = serde_json::Value::String(delta);
    }
    if let Some(usage) = input.usage {
        params["usage"] = usage;
    }
    if let Some(metadata) = input.metadata {
        params["metadata"] = metadata;
    }
    WorkerRequest::new(
        request_id.id("transport-gateway-frame"),
        request_id.trace_id("transport-gateway-frame"),
        "transport.gateway_frame",
        params,
    )
}

fn worker_transport_websocket_message_with_options(
    shared: &SharedGateway,
    input: WorkerTransportWebSocketMessageInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request =
        build_worker_transport_websocket_message_request(next_worker_request_correlation(), input);
    client.call(&request, timeout, "worker transport websocket message")
}

fn build_worker_transport_websocket_message_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerTransportWebSocketMessageInput,
) -> WorkerRequest {
    let mut params = serde_json::json!({
        "clientId": input.client_id,
        "frame": input.frame,
    });
    if let Some(attached_chat_id) = input.attached_chat_id {
        params["attachedChatId"] = serde_json::Value::String(attached_chat_id);
    }
    if let Some(session_exists) = input.session_exists {
        params["sessionExists"] = serde_json::Value::Bool(session_exists);
    }
    if let Some(editable_paths) = input.editable_paths {
        params["editablePaths"] = serde_json::json!(editable_paths);
    }
    WorkerRequest::new(
        request_id.id("transport-websocket-message"),
        request_id.trace_id("transport-websocket-message"),
        "transport.websocket_message",
        params,
    )
}

fn worker_transport_dispatch_websocket_message_with_options(
    shared: &SharedGateway,
    input: WorkerTransportWebSocketDispatchInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let transport_request = build_worker_transport_websocket_message_request(
        next_worker_request_correlation(),
        WorkerTransportWebSocketMessageInput {
            client_id: input.client_id,
            frame: input.frame,
            attached_chat_id: input.attached_chat_id,
            session_exists: input.session_exists,
            editable_paths: input.editable_paths,
        },
    );
    let transport_result = client.call(
        &transport_request,
        timeout,
        "worker transport websocket dispatch mapper",
    )?;

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

    let agent_result = client.call(
        &run_request,
        timeout,
        "worker transport websocket dispatch agent",
    )?;

    Ok(serde_json::json!({
        "transport": transport_result,
        "agent": agent_result,
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
    shared: &SharedGateway,
    input: WorkerChannelDispatchInboundInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request =
        build_worker_channel_dispatch_inbound_request(next_worker_request_correlation(), input);
    client.call(&request, timeout, "worker channel dispatch inbound")
}

fn build_worker_channel_dispatch_inbound_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerChannelDispatchInboundInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("channel-dispatch-inbound"),
        request_id.trace_id("channel-dispatch-inbound"),
        "channel.dispatch_inbound",
        serde_json::json!({ "message": input.message }),
    )
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
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    timeout: Duration,
    action: &str,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;
    client.call(&request, timeout, &format!("worker channel {action}"))
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

fn worker_cancel_agent_with_options(
    shared: &SharedGateway,
    run_id: String,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    if resolve_native_agent_runtime_mode(&serde_json::json!({}), &config_snapshot)
        == NativeAgentRuntimeMode::Rust
    {
        let services = {
            let runtime = lock_runtime(shared);
            runtime.native_agent_runtime.clone()
        };
        return Ok(services.cancel(&run_id));
    }

    let client = WorkerClient::experimental(shared);
    client.require_running()?;

    let request = build_worker_cancel_agent_request(next_worker_request_correlation(), run_id);
    client.call(&request, timeout, "worker agent cancel")
}

fn build_worker_cancel_agent_request(
    request_id: WorkerRequestCorrelation,
    run_id: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("agent-cancel"),
        request_id.trace_id("agent-cancel"),
        "agent.cancel",
        serde_json::json!({ "runId": run_id }),
    )
}

fn worker_restore_agent_checkpoint_with_options(
    shared: &SharedGateway,
    session_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    if resolve_native_agent_runtime_mode(&serde_json::json!({}), &config_snapshot)
        == NativeAgentRuntimeMode::Rust
    {
        let services = {
            let runtime = lock_runtime(shared);
            runtime.native_agent_runtime.clone()
        };
        return Ok(services.restore_checkpoint(&session_id));
    }

    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request = build_worker_restore_agent_checkpoint_request(
        next_worker_request_correlation(),
        session_id,
    );
    client.call(&request, timeout, "worker agent checkpoint restore")
}

fn build_worker_restore_agent_checkpoint_request(
    request_id: WorkerRequestCorrelation,
    session_id: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("agent-restore-checkpoint"),
        request_id.trace_id("agent-restore-checkpoint"),
        "agent.restore_checkpoint",
        serde_json::json!({ "sessionId": session_id }),
    )
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
    shared: &SharedGateway,
    session_id: String,
    form_id: String,
    values: serde_json::Value,
    action: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request = build_worker_submit_agent_form_request(
        next_worker_request_correlation(),
        session_id,
        form_id,
        values,
        action,
    );
    client.call(&request, timeout, "worker agent form submission")
}

fn build_worker_submit_agent_form_request(
    request_id: WorkerRequestCorrelation,
    session_id: String,
    form_id: String,
    values: serde_json::Value,
    action: Option<String>,
) -> WorkerRequest {
    let mut params = serde_json::json!({
        "sessionId": session_id,
        "formId": form_id,
        "values": if values.is_null() { serde_json::json!({}) } else { values },
    });
    if let Some(action) = action {
        params["action"] = serde_json::Value::String(action);
    }
    WorkerRequest::new(
        request_id.id("agent-submit-form"),
        request_id.trace_id("agent-submit-form"),
        "agent.submit_form",
        params,
    )
}

fn worker_resume_agent_approval_with_options(
    shared: &SharedGateway,
    session_id: String,
    approval_id: String,
    approved: bool,
    scope: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;

    let request = build_worker_resume_agent_approval_request(
        next_worker_request_correlation(),
        session_id,
        approval_id,
        approved,
        scope,
    );
    client.call(&request, timeout, "worker agent approval resume")
}

fn build_worker_resume_agent_approval_request(
    request_id: WorkerRequestCorrelation,
    session_id: String,
    approval_id: String,
    approved: bool,
    scope: Option<String>,
) -> WorkerRequest {
    let mut params = serde_json::json!({
        "sessionId": session_id,
        "approvalId": approval_id,
        "approved": approved,
    });
    if let Some(scope) = scope {
        params["scope"] = serde_json::Value::String(scope);
    }
    WorkerRequest::new(
        request_id.id("agent-resume-approval"),
        request_id.trace_id("agent-resume-approval"),
        "agent.resume_approval",
        params,
    )
}

fn ensure_ts_agent_worker_running(
    worker: &WorkerManager,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    if worker.status().state == WorkerManagerState::Running {
        return Ok(());
    }
    let spec = ts_agent_worker_command_spec();
    worker
        .start_stdio_rpc(
            spec.clone(),
            experimental_worker_router_with_runtime_restart(
                worker.clone(),
                spec,
                workspace_root,
                config_snapshot,
            ),
        )
        .map_err(|error| format!("failed to start TS agent worker: {error:?}"))
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
            ts_worker_fixture_command_spec(),
            experimental_worker_router(workspace_root, config_snapshot),
        )
        .map_err(|error| format!("failed to start TS worker fixture: {error:?}"))
}

fn ts_agent_worker_command_spec() -> WorkerCommandSpec {
    let desktop_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have repo parent")
        .to_path_buf();
    WorkerCommandSpec::new(
        "node",
        ["workers/ts-agent-worker/src/index.ts"],
        desktop_dir,
    )
    .with_label("ts-agent-worker")
}

fn ts_worker_fixture_command_spec() -> WorkerCommandSpec {
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
            thread::spawn(move || {
                // Let the worker receive the runtime.restart response before replacing it.
                thread::sleep(Duration::from_millis(25));
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

fn ts_agent_worker_workspace_root() -> PathBuf {
    let root =
        resolve_ts_agent_worker_workspace_root_from_config_path(&default_tinybot_config_path());
    let _ = std::fs::create_dir_all(&root);
    root
}

fn resolve_ts_agent_worker_workspace_root_from_config_path(config_path: &Path) -> PathBuf {
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
        .find(|path| path.join("workers").join("ts-agent-worker").exists())
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
            if ts_compatibility_worker_enabled() {
                if let Err(error) = start_worker_heartbeat_runtime_with_options(
                    &setup_state,
                    ts_agent_worker_workspace_root(),
                    experimental_worker_config_snapshot(),
                    Duration::from_secs(10),
                ) {
                    push_log(
                        &setup_state,
                        &format!("TS compatibility heartbeat start failed: {error}"),
                    );
                }
            } else {
                push_log(
                    &setup_state,
                    "Rust backend startup skipped TS compatibility heartbeat",
                );
            }
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
                if ts_compatibility_worker_enabled() {
                    if let Err(error) = stop_worker_heartbeat_runtime_with_options(
                        &close_state,
                        ts_agent_worker_workspace_root(),
                        experimental_worker_config_snapshot(),
                        Duration::from_secs(10),
                    ) {
                        push_log(
                            &close_state,
                            &format!("TS compatibility heartbeat stop failed: {error}"),
                        );
                    }
                }
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
        build_worker_cron_run_due_request, cron_model_from_config,
        worker_cron_dispatch_due_with_options, worker_cron_next_wake_delay_with_options,
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
    fn close_shutdown_stops_ts_compatibility_worker_child() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        {
            let runtime = lock_runtime(&shared);
            runtime
                .experimental_worker
                .start(test_gateway_worker_spec("ts-backend-close-worker"))
                .expect("test worker should start");
        }

        stop_owned_gateway(&shared, false).expect("TS compatibility worker child should stop");

        let runtime = lock_runtime(&shared);
        assert_eq!(
            runtime.experimental_worker.status().state,
            crate::worker_manager::WorkerManagerState::Stopped
        );
        assert!(runtime
            .logs
            .iter()
            .any(|line| line == "stopped TS compatibility worker"));
    }

    #[test]
    fn start_gateway_defaults_to_rust_backend_without_ts_worker() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let status = crate::desktop_gateway::start_gateway_with_options(&shared, false)
            .expect("Rust backend startup should not require TS worker");

        assert_eq!(status.owner, "shell");
        assert_eq!(status.state, "running");
        assert_eq!(status.command, "Tauri Rust backend");
        assert_eq!(
            status.worker_runtime.state,
            crate::worker_runtime::WorkerRuntimeState::Running
        );
        assert!(status.worker_runtime.compatibility_worker.is_none());
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
        assert!(lock_runtime(&shared)
            .logs
            .iter()
            .any(|line| line == "Rust native backend active; TS compatibility worker disabled"));
    }

    #[test]
    fn gateway_status_reflects_running_ts_compatibility_worker_runtime() {
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
    fn gateway_status_reports_ts_compatibility_worker_diagnostics() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let ts_worker = {
            let runtime = lock_runtime(&shared);
            runtime.experimental_worker.clone()
        };
        ts_worker
            .start(test_logging_sleep_worker_spec(
                "ts-agent-worker",
                "ts native backend",
            ))
            .expect("ts worker should start");
        let _ = wait_for_worker_diagnostics(&ts_worker, |diagnostics| {
            diagnostics
                .iter()
                .any(|line| line.line.contains("ts native backend"))
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

        assert!(log_text.contains("ts native backend"));
        assert!(diagnostic_text.contains("ts native backend"));
        assert_eq!(status.command, "Tauri Rust backend");
    }

    #[test]
    fn worker_echo_agent_uses_ts_agent_worker() {
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
    fn experimental_worker_command_spec_points_at_ts_agent_worker() {
        let spec = ts_agent_worker_command_spec();

        assert_eq!(spec.program, "node");
        assert_eq!(spec.args, vec!["workers/ts-agent-worker/src/index.ts"]);
        assert_eq!(spec.label, "ts-agent-worker");
    }

    #[test]
    fn ts_agent_worker_uses_default_tinybot_workspace_root() {
        let fixture = WorkspaceFixture::new();
        let expected = default_tinybot_workspace_root();

        assert_eq!(
            resolve_ts_agent_worker_workspace_root_from_config_path(
                &fixture.root.join("missing.json")
            ),
            expected
        );
    }

    #[test]
    fn ts_agent_worker_uses_configured_workspace_root() {
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
            resolve_ts_agent_worker_workspace_root_from_config_path(
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
        let mut router = experimental_worker_router(fixture.root.clone(), serde_json::json!({}));
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
                    .is_some_and(|path| path.starts_with("workers/ts-agent-worker/skills/"))
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
    fn experimental_worker_router_allows_registered_ts_agent_native_tools() {
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

        let diagnostics = wait_for_worker_diagnostics(&manager, |diagnostics| {
            diagnostics.iter().any(|line| {
                line.stream == "stderr" && line.line.contains("\"restart_requested\":true")
            })
        });
        assert!(diagnostics.iter().any(|line| {
            line.stream == "stderr" && line.line.contains("\"restart_requested\":true")
        }));

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
            .send_stdio_request(&request, Duration::from_secs(3))
            .expect("restarted worker should accept stdio request");

        assert_eq!(response.result.as_ref().unwrap()["ok"], true);
        assert_eq!(
            response.result.as_ref().unwrap()["echo"],
            "hello after runtime restart"
        );

        manager.stop().expect("worker should stop");
    }

    #[test]
    fn worker_run_agent_request_wraps_agent_spec_for_ts_worker() {
        let agent_spec = serde_json::json!({
            "runId": "run-1",
            "messages": [{ "role": "user", "content": "hello" }],
            "model": "gpt-5",
            "maxIterations": 3,
            "stream": true
        });

        let request =
            build_worker_run_agent_request(test_request_correlation("42"), agent_spec.clone());

        assert_eq!(request.id, "agent-run-42");
        assert_eq!(request.trace_id, "trace-agent-run-42");
        assert_eq!(request.method, "agent.run");
        assert_eq!(request.params, serde_json::json!({ "spec": agent_spec }));
    }

    #[test]
    fn worker_run_agent_uses_rust_runtime_when_selected_without_ts_worker() {
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
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should run deterministic fake provider");

        assert_eq!(result["runtime"], "rust");
        assert_eq!(result["finalContent"], "Echo: hello rust");
        assert_eq!(result["events"][0]["eventName"], "agent.delta");
        assert_eq!(result["events"][1]["eventName"], "agent.done");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
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
        assert_eq!(cancelled["events"][0]["eventName"], "agent.cancelled");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_run_agent_requests_use_unique_rust_owned_correlation_keys() {
        let generator = crate::worker_request_id::WorkerRequestIdGenerator::with_run_prefix("test");
        let first_spec = serde_json::json!({ "runId": "run-1" });
        let second_spec = serde_json::json!({ "runId": "run-2" });

        let first = build_worker_run_agent_request(generator.next(), first_spec.clone());
        let second = build_worker_run_agent_request(generator.next(), second_spec.clone());

        assert_ne!(first.id, second.id);
        assert_ne!(first.trace_id, second.trace_id);
        assert!(first.id.starts_with("agent-run-test-"));
        assert!(first.trace_id.starts_with("trace-agent-run-test-"));
        assert_eq!(first.method, "agent.run");
        assert_eq!(second.method, "agent.run");
        assert_eq!(first.params, serde_json::json!({ "spec": first_spec }));
        assert_eq!(second.params, serde_json::json!({ "spec": second_spec }));
    }

    #[test]
    fn worker_run_agent_input_request_wraps_high_level_input_for_ts_worker() {
        let agent_input = serde_json::json!({
            "runId": "run-input-1",
            "sessionId": "session-1",
            "input": { "content": "hello" },
            "model": "gpt-5",
            "maxIterations": 3,
            "stream": true
        });

        let request = build_worker_run_agent_input_request(
            test_request_correlation("42"),
            agent_input.clone(),
        );

        assert_eq!(request.id, "agent-run-input-42");
        assert_eq!(request.trace_id, "trace-agent-run-input-42");
        assert_eq!(request.method, "agent.run_input");
        assert_eq!(request.params, serde_json::json!({ "input": agent_input }));
    }

    #[test]
    fn worker_cron_run_due_request_wraps_due_jobs_for_ts_worker() {
        let jobs = serde_json::json!([
            {
                "id": "job-1",
                "name": "Check status",
                "enabled": true,
                "schedule": { "kind": "every", "everyMs": 60000 },
                "payload": { "kind": "agent_turn", "message": "Check", "deliver": true },
                "state": { "nextRunAtMs": 1000 },
                "createdAtMs": 1,
                "updatedAtMs": 1,
                "deleteAfterRun": false
            }
        ]);

        let request = build_worker_cron_run_due_request(
            test_request_correlation("42"),
            jobs.clone(),
            "gpt-5".to_string(),
        );

        assert_eq!(request.id, "cron-run-due-42");
        assert_eq!(request.trace_id, "trace-cron-run-due-42");
        assert_eq!(request.method, "cron.run_due");
        assert_eq!(
            request.params,
            serde_json::json!({
                "jobs": jobs,
                "model": "gpt-5",
                "maxIterations": 4,
                "stream": false
            })
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
    fn worker_heartbeat_lifecycle_requests_target_ts_worker_methods() {
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
    fn worker_skills_list_reads_rust_workspace_without_ts_worker() {
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
    fn worker_workspace_file_commands_use_rust_workspace_without_ts_worker() {
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
    fn worker_session_read_commands_use_rust_session_store_without_ts_worker() {
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
    fn worker_session_write_commands_use_rust_session_store_without_ts_worker() {
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
    fn worker_cowork_route_request_targets_ts_route_bridge() {
        let request = build_worker_cowork_route_request(
            test_request_correlation("42"),
            WorkerCoworkRouteInput {
                method: "POST".to_string(),
                path: "/api/cowork/sessions/cw_1/tasks/task_1/retry".to_string(),
                body: Some(serde_json::json!({ "reason": "Retry" })),
                query: Some(serde_json::json!({ "limit": "5" })),
            },
        );

        assert_eq!(request.id, "cowork-route-42");
        assert_eq!(request.trace_id, "trace-cowork-route-42");
        assert_eq!(request.method, "cowork.route_request");
        assert_eq!(
            request.params,
            serde_json::json!({
                "method": "POST",
                "path": "/api/cowork/sessions/cw_1/tasks/task_1/retry",
                "body": { "reason": "Retry" },
                "query": { "limit": "5" }
            })
        );
    }

    #[test]
    fn worker_cowork_route_serves_rust_sessions_without_ts_worker() {
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

        assert_eq!(created["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(listed["body"]["sessions"][0]["id"], session_id);
        assert_eq!(trace["body"]["events"][0]["type"], "session.created");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_webui_route_serves_rust_owned_state_routes_without_ts_worker() {
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
        assert_eq!(workspace_file["body"]["content"], "hello route");
        assert_eq!(knowledge["body"]["document"]["name"], "Route Knowledge.md");
        assert_eq!(approvals["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(approvals["headers"]["x-tinybot-route-group"], "approvals");
        assert_eq!(approvals["body"]["session_key"], "websocket:chat-1");
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
    fn worker_webui_route_classifies_delegated_and_unsupported_routes_without_ts_worker() {
        let fixture = WorkspaceFixture::new();
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let delegated = worker_webui_rust_route_with_options(
            &shared,
            &WorkerWebuiRouteInput {
                method: "POST".to_string(),
                path: "/v1/chat/completions".to_string(),
                headers: None,
                body: Some(serde_json::json!({ "messages": [] })),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("delegated classification should not fail");
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

        assert!(delegated.is_none());
        assert_eq!(unsupported["status"], 404);
        assert_eq!(
            unsupported["headers"]["x-tinybot-route-owner"],
            "unsupported"
        );
        assert_eq!(unsupported["body"]["method"], "GET");
        assert_eq!(unsupported["body"]["path"], "/api/not-a-route");
        assert_eq!(
            lock_runtime(&shared).experimental_worker.status().state,
            WorkerManagerState::Stopped
        );
    }

    #[test]
    fn worker_webui_route_request_targets_ts_route_bridge() {
        let request = build_worker_webui_route_request(
            test_request_correlation("42"),
            WorkerWebuiRouteInput {
                method: "GET".to_string(),
                path: "/api/status".to_string(),
                body: None,
                headers: Some(serde_json::json!({ "Authorization": "Bearer token-1" })),
            },
        );

        assert_eq!(request.id, "webui-route-42");
        assert_eq!(request.trace_id, "trace-webui-route-42");
        assert_eq!(request.method, "webui.handle_request");
        assert_eq!(
            request.params,
            serde_json::json!({
                "method": "GET",
                "path": "/api/status",
                "headers": { "Authorization": "Bearer token-1" }
            })
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
    fn worker_transport_gateway_frame_request_targets_ts_transport_mapper() {
        let request = build_worker_transport_gateway_frame_request(
            test_request_correlation("42"),
            WorkerTransportGatewayFrameInput {
                kind: "message".to_string(),
                chat_id: "chat-1".to_string(),
                content: Some("reading file".to_string()),
                delta: None,
                usage: None,
                metadata: Some(serde_json::json!({
                    "_stream_id": "msg-1",
                    "_progress": true,
                    "_tool_name": "read_file"
                })),
            },
        );

        assert_eq!(request.id, "transport-gateway-frame-42");
        assert_eq!(request.trace_id, "trace-transport-gateway-frame-42");
        assert_eq!(request.method, "transport.gateway_frame");
        assert_eq!(
            request.params,
            serde_json::json!({
                "kind": "message",
                "chatId": "chat-1",
                "content": "reading file",
                "metadata": {
                    "_stream_id": "msg-1",
                    "_progress": true,
                    "_tool_name": "read_file"
                }
            })
        );
    }

    #[test]
    fn worker_transport_websocket_message_request_targets_ts_inbound_mapper() {
        let request = build_worker_transport_websocket_message_request(
            test_request_correlation("42"),
            WorkerTransportWebSocketMessageInput {
                client_id: "client-1".to_string(),
                frame: serde_json::json!({
                    "type": "message",
                    "chat_id": "chat-1",
                    "content": "hello",
                    "use_persistent_rag": true
                }),
                attached_chat_id: Some("chat-1".to_string()),
                session_exists: None,
                editable_paths: Some(vec!["AGENTS.md".to_string()]),
            },
        );

        assert_eq!(request.id, "transport-websocket-message-42");
        assert_eq!(request.trace_id, "trace-transport-websocket-message-42");
        assert_eq!(request.method, "transport.websocket_message");
        assert_eq!(
            request.params,
            serde_json::json!({
                "clientId": "client-1",
                "frame": {
                    "type": "message",
                    "chat_id": "chat-1",
                    "content": "hello",
                    "use_persistent_rag": true
                },
                "attachedChatId": "chat-1",
                "editablePaths": ["AGENTS.md"]
            })
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
    fn worker_channel_dispatch_inbound_request_targets_ts_channel_runtime() {
        let request = build_worker_channel_dispatch_inbound_request(
            test_request_correlation("42"),
            WorkerChannelDispatchInboundInput {
                message: serde_json::json!({
                    "channel": "feishu",
                    "sender_id": "ou_1",
                    "chat_id": "oc_1",
                    "content": "hello",
                    "timestamp": "2026-06-13T02:00:00.000Z",
                    "media": ["file://clip.png"],
                    "metadata": { "message_id": "mid-1" },
                    "session_key_override": "thread:42"
                }),
            },
        );

        assert_eq!(request.id, "channel-dispatch-inbound-42");
        assert_eq!(request.trace_id, "trace-channel-dispatch-inbound-42");
        assert_eq!(request.method, "channel.dispatch_inbound");
        assert_eq!(
            request.params,
            serde_json::json!({
                "message": {
                    "channel": "feishu",
                    "sender_id": "ou_1",
                    "chat_id": "oc_1",
                    "content": "hello",
                    "timestamp": "2026-06-13T02:00:00.000Z",
                    "media": ["file://clip.png"],
                    "metadata": { "message_id": "mid-1" },
                    "session_key_override": "thread:42"
                }
            })
        );
    }

    #[test]
    fn worker_channel_lifecycle_requests_target_ts_channel_manager() {
        let start_request = build_worker_channel_start_request(test_request_correlation("42"));
        let status_request = build_worker_channel_status_request(test_request_correlation("43"));
        let stop_request = build_worker_channel_stop_request(test_request_correlation("44"));
        let login_request = build_worker_channel_login_request(
            test_request_correlation("45"),
            "feishu".to_string(),
            true,
        );

        assert_eq!(start_request.id, "channel-start-42");
        assert_eq!(start_request.trace_id, "trace-channel-start-42");
        assert_eq!(start_request.method, "channel.start");
        assert_eq!(start_request.params, serde_json::json!({}));

        assert_eq!(status_request.id, "channel-status-43");
        assert_eq!(status_request.trace_id, "trace-channel-status-43");
        assert_eq!(status_request.method, "channel.status");
        assert_eq!(status_request.params, serde_json::json!({}));

        assert_eq!(stop_request.id, "channel-stop-44");
        assert_eq!(stop_request.trace_id, "trace-channel-stop-44");
        assert_eq!(stop_request.method, "channel.stop");
        assert_eq!(stop_request.params, serde_json::json!({}));

        assert_eq!(login_request.id, "channel-login-45");
        assert_eq!(login_request.trace_id, "trace-channel-login-45");
        assert_eq!(login_request.method, "channel.login");
        assert_eq!(
            login_request.params,
            serde_json::json!({ "channel": "feishu", "force": true })
        );
    }

    #[test]
    fn worker_cancel_agent_request_wraps_run_id_for_ts_worker() {
        let request =
            build_worker_cancel_agent_request(test_request_correlation("42"), "run-1".to_string());

        assert_eq!(request.id, "agent-cancel-42");
        assert_eq!(request.trace_id, "trace-agent-cancel-42");
        assert_eq!(request.method, "agent.cancel");
        assert_eq!(request.params, serde_json::json!({ "runId": "run-1" }));
    }

    #[test]
    fn worker_restore_agent_checkpoint_request_wraps_session_id_for_ts_worker() {
        let request = build_worker_restore_agent_checkpoint_request(
            test_request_correlation("42"),
            "WebSocket:chat-1".to_string(),
        );

        assert_eq!(request.id, "agent-restore-checkpoint-42");
        assert_eq!(request.trace_id, "trace-agent-restore-checkpoint-42");
        assert_eq!(request.method, "agent.restore_checkpoint");
        assert_eq!(
            request.params,
            serde_json::json!({ "sessionId": "WebSocket:chat-1" })
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
    fn worker_background_trace_list_reads_rust_registry_without_ts_worker() {
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
    fn worker_task_plan_commands_use_rust_store_without_ts_worker() {
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
    fn worker_knowledge_state_commands_use_rust_store_without_ts_worker() {
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
    fn worker_submit_agent_form_request_wraps_form_submission_for_ts_worker() {
        let request = build_worker_submit_agent_form_request(
            test_request_correlation("42"),
            "WebSocket:chat-1".to_string(),
            "travel_plan".to_string(),
            serde_json::json!({ "destination": "Paris" }),
            Some("cancelled".to_string()),
        );

        assert_eq!(request.id, "agent-submit-form-42");
        assert_eq!(request.trace_id, "trace-agent-submit-form-42");
        assert_eq!(request.method, "agent.submit_form");
        assert_eq!(
            request.params,
            serde_json::json!({
                "sessionId": "WebSocket:chat-1",
                "formId": "travel_plan",
                "values": { "destination": "Paris" },
                "action": "cancelled"
            })
        );
    }

    #[test]
    fn worker_resume_agent_approval_request_wraps_approval_for_ts_worker() {
        let request = build_worker_resume_agent_approval_request(
            test_request_correlation("42"),
            "WebSocket:chat-1".to_string(),
            "approval-1".to_string(),
            true,
            Some("session".to_string()),
        );

        assert_eq!(request.id, "agent-resume-approval-42");
        assert_eq!(request.trace_id, "trace-agent-resume-approval-42");
        assert_eq!(request.method, "agent.resume_approval");
        assert_eq!(
            request.params,
            serde_json::json!({
                "sessionId": "WebSocket:chat-1",
                "approvalId": "approval-1",
                "approved": true,
                "scope": "session"
            })
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
                "[ts-agent-worker] worker.request.start route=POST /v1/knowledge/graph/extract",
            )),
        );

        let contents =
            std::fs::read_to_string(log_path).expect("persistent backend log should be written");
        assert!(contents.contains(
            "stderr [ts-agent-worker] worker.request.start route=POST /v1/knowledge/graph/extract"
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
        };

        let value = serde_json::to_value(status).expect("status should serialize");

        assert_eq!(value["worker_runtime"]["state"], "stopped");
        assert!(value["worker_runtime"]["transport_mode"].is_null());
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
        assert!(value.get("compatibility_worker").is_none());
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
        for _ in 0..30 {
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
