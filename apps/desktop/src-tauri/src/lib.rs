use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Runtime, State, WindowEvent,
};

pub mod config_store;
pub mod worker_background;
pub mod worker_capability;
pub mod worker_config;
pub mod worker_connection;
pub mod worker_cron;
pub mod worker_diagnostics;
pub mod worker_knowledge;
pub mod worker_manager;
pub mod worker_protocol;
pub mod worker_rpc;
pub mod worker_runtime;
pub mod worker_secret;
pub mod worker_session;
pub mod worker_shell;
pub mod worker_stdio;
pub mod worker_task;
pub mod worker_workspace;

use crate::config_store::{ConfigPatchApplyResult, ConfigPatchBridgeResult, ConfigStore};
use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_manager::{
    WorkerCommandSpec, WorkerManager, WorkerManagerEvent, WorkerManagerState, WorkerManagerStatus,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_rpc::WorkerRpcRouter;
use crate::worker_runtime::WorkerRuntimeStatus;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
    worker: WorkerManager,
    experimental_worker: WorkerManager,
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
            worker: WorkerManager::new(200),
            experimental_worker: WorkerManager::new(200),
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

#[derive(Serialize)]
struct GatewayRuntimeStatus {
    state: String,
    owner: String,
    http_ok: bool,
    gateway_http: &'static str,
    gateway_ws: &'static str,
    command: &'static str,
    port: u16,
    repo_root: String,
    log_path: String,
    log_tail: Vec<String>,
    logs: Vec<String>,
    last_error: Option<String>,
    exit_policy: &'static str,
    bootstrap_status: String,
    response_class: Option<String>,
    recovery_hint: Option<String>,
    worker_runtime: WorkerRuntimeStatus,
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

#[derive(Deserialize, Serialize)]
struct GatewayExitPolicyPreference {
    keep_running: bool,
}

#[derive(Clone, Debug)]
enum GatewayBootstrapProbe {
    Ready,
    Offline(String),
    Incompatible { detail: String },
    BootstrapError { status: u16, detail: String },
}

impl GatewayBootstrapProbe {
    fn is_ready(&self) -> bool {
        matches!(self, Self::Ready)
    }

    fn is_conflict_or_error(&self) -> bool {
        matches!(
            self,
            Self::Incompatible { .. } | Self::BootstrapError { .. }
        )
    }

    fn bootstrap_status(&self) -> String {
        match self {
            Self::Ready => "ready",
            Self::Offline(_) => "offline",
            Self::Incompatible { .. } => "incompatible",
            Self::BootstrapError { .. } => "bootstrap_error",
        }
        .to_string()
    }

    fn response_class(&self) -> Option<String> {
        match self {
            Self::Ready => Some("tinybot-bootstrap".to_string()),
            Self::Offline(_) => Some("unreachable".to_string()),
            Self::Incompatible { .. } => Some("incompatible-bootstrap".to_string()),
            Self::BootstrapError { status, .. } => Some(format!("HTTP {status}")),
        }
    }

    fn last_error(&self) -> Option<String> {
        match self {
            Self::Ready => None,
            Self::Offline(error) => Some(error.clone()),
            Self::Incompatible { detail } | Self::BootstrapError { detail, .. } => {
                Some(detail.clone())
            }
        }
    }

    fn recovery_hint(&self) -> Option<String> {
        match self {
            Self::Incompatible { .. } => Some(
                "Port 18790 is reachable, but /webui/bootstrap is not a Tinybot gateway. Stop the conflicting process on port 18790, then retry Tinybot gateway startup."
                    .to_string(),
            ),
            Self::BootstrapError { .. } => Some(
                "The process on port 18790 returned a bootstrap error. Check whether it is Tinybot, then retry or restart the gateway."
                    .to_string(),
            ),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
struct UploadFilePickerOptions {
    title: Option<String>,
    filters: Option<Vec<UploadFilePickerFilter>>,
}

#[derive(Deserialize)]
struct UploadFilePickerFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFileOptions {
    title: Option<String>,
    default_path: Option<String>,
    filters: Option<Vec<UploadFilePickerFilter>>,
    contents: String,
}

#[derive(Serialize)]
struct PickedUploadFile {
    name: String,
    path: String,
    mime_type: String,
    size_bytes: u64,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
struct SavedExportFile {
    path: String,
}

#[derive(Clone, Copy)]
struct DesktopMenuItemDescriptor {
    id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
    enabled: bool,
    checked: bool,
}

#[derive(Clone, Serialize)]
struct DesktopMenuCommandPayload {
    id: String,
}

const ALLOWED_WORKSPACE_FILES: &[&str] = &[
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "memory/MEMORY.md",
];

const DESKTOP_MENU_ITEM_DESCRIPTORS: &[DesktopMenuItemDescriptor] = &[
    DesktopMenuItemDescriptor {
        id: "new-chat",
        label: "New Chat",
        accelerator: Some("Ctrl+N"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "stop-generation",
        label: "Stop Generation",
        accelerator: Some("Ctrl+."),
        enabled: false,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "search-sessions",
        label: "Search Sessions",
        accelerator: Some("Ctrl+F"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-settings",
        label: "Settings",
        accelerator: Some("Ctrl+,"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-docs",
        label: "Documentation",
        accelerator: Some("F1"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-shortcut-help",
        label: "Shortcut Help",
        accelerator: Some("Ctrl+/"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-page-help",
        label: "Page Help",
        accelerator: Some("Ctrl+Shift+/"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "open-backend-logs",
        label: "Backend Logs",
        accelerator: None,
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "toggle-theme",
        label: "Toggle Theme",
        accelerator: Some("Ctrl+Shift+T"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        accelerator: Some("Ctrl+B"),
        enabled: true,
        checked: true,
    },
    DesktopMenuItemDescriptor {
        id: "open-command-palette",
        label: "Command Palette",
        accelerator: Some("Ctrl+Shift+P"),
        enabled: true,
        checked: false,
    },
    DesktopMenuItemDescriptor {
        id: "refresh-gateway-status",
        label: "Gateway Status",
        accelerator: Some("Ctrl+Shift+G"),
        enabled: true,
        checked: false,
    },
];

#[tauri::command]
fn gateway_status(state: State<'_, SharedGateway>) -> GatewayRuntimeStatus {
    current_status(state.inner())
}

#[tauri::command]
fn worker_probe_status() -> WorkerRuntimeStatus {
    WorkerRuntimeStatus::running(
        crate::worker_protocol::WorkerTransportMode::Stdio,
        vec![crate::worker_protocol::WorkerDiagnosticLine::new(
            "stdout",
            format!(
                "worker protocol {}",
                crate::worker_protocol::WORKER_PROTOCOL_VERSION
            ),
        )],
    )
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
fn worker_transport_dispatch_websocket_message(
    input: WorkerTransportWebSocketDispatchInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_transport_dispatch_websocket_message_with_options(
        state.inner(),
        input,
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(60),
    )
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
    worker_cancel_agent_with_options(state.inner(), input.run_id, Duration::from_secs(10))
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
fn worker_cron_dispatch_due(state: State<'_, SharedGateway>) -> Result<serde_json::Value, String> {
    worker_cron_dispatch_due_with_options(
        state.inner(),
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        now_unix_ms() as i64,
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
fn start_gateway(state: State<'_, SharedGateway>) -> Result<GatewayRuntimeStatus, String> {
    let repo_root = repo_root();
    let worker = {
        let runtime = lock_runtime(state.inner());
        runtime.experimental_worker.clone()
    };
    match ensure_ts_agent_worker_running(
        &worker,
        ts_agent_worker_workspace_root(),
        experimental_worker_config_snapshot(),
    ) {
        Ok(()) => {
            let mut runtime = lock_runtime(state.inner());
            runtime.last_error = None;
            append_log(
                &mut runtime,
                "started native TS backend with `node workers/ts-agent-worker/src/index.ts`",
            );
        }
        Err(error) if error.contains("AlreadyRunning") => {
            push_log(
                state.inner(),
                "native TS backend worker is already running",
            );
        }
        Err(error) => {
            let message = format!("failed to start native TS backend: {error}");
            let mut runtime = lock_runtime(state.inner());
            runtime.last_error = Some(message.clone());
            return Err(message);
        }
    }

    {
        let mut runtime = lock_runtime(state.inner());
        append_log(
            &mut runtime,
            &format!("native TS backend cwd: {}", repo_root.display()),
        );
    }

    Ok(current_status(state.inner()))
}

#[tauri::command]
fn stop_gateway(state: State<'_, SharedGateway>) -> Result<GatewayRuntimeStatus, String> {
    stop_owned_gateway(state.inner(), true)?;
    Ok(current_status(state.inner()))
}

#[tauri::command]
fn set_gateway_keep_running(
    keep_running: bool,
    state: State<'_, SharedGateway>,
) -> Result<GatewayRuntimeStatus, String> {
    persist_gateway_exit_policy(&gateway_exit_policy_preference_path(), keep_running)?;
    {
        let mut runtime = lock_runtime(state.inner());
        runtime.keep_background = keep_running;
        append_log(
            &mut runtime,
            if keep_running {
                "configured native TS backend to keep running after desktop exits"
            } else {
                "configured native TS backend to stop when desktop exits"
            },
        );
    }
    Ok(current_status(state.inner()))
}

#[tauri::command]
fn pick_upload_file(options: UploadFilePickerOptions) -> Result<Option<PickedUploadFile>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = options.title {
        dialog = dialog.set_title(&title);
    }
    for filter in options.filters.unwrap_or_default() {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let Some(path) = dialog.pick_file() else {
        return Ok(None);
    };
    upload_file_from_path(&path).map(Some)
}

#[tauri::command]
fn reveal_workspace_file(path: String) -> Result<(), String> {
    let target_path = reveal_workspace_file_path(&path)?;
    reveal_file_in_folder(&target_path)
}

#[tauri::command]
fn save_export_file(options: ExportFileOptions) -> Result<Option<SavedExportFile>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = options.title {
        dialog = dialog.set_title(&title);
    }
    if let Some(default_path) = options.default_path {
        dialog = dialog.set_file_name(safe_export_file_name(&default_path));
    }
    for filter in options.filters.unwrap_or_default() {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let Some(path) = dialog.save_file() else {
        return Ok(None);
    };
    write_export_file(&path, &options.contents)?;
    Ok(Some(SavedExportFile {
        path: path.display().to_string(),
    }))
}

fn desktop_menu_item_descriptors() -> &'static [DesktopMenuItemDescriptor] {
    DESKTOP_MENU_ITEM_DESCRIPTORS
}

fn install_desktop_application_menu<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let menu = build_desktop_application_menu(app.app_handle())?;
    app.set_menu(menu)?;
    Ok(())
}

fn build_desktop_application_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_chat = menu_item(app, "new-chat")?;
    let stop_generation = menu_item(app, "stop-generation")?;
    let search_sessions = menu_item(app, "search-sessions")?;
    let open_settings = menu_item(app, "open-settings")?;
    let open_docs = menu_item(app, "open-docs")?;
    let toggle_theme = check_menu_item(app, "toggle-theme")?;
    let toggle_sidebar = check_menu_item(app, "toggle-sidebar")?;
    let open_command_palette = menu_item(app, "open-command-palette")?;
    let refresh_gateway_status = menu_item(app, "refresh-gateway-status")?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_chat,
            &stop_generation,
            &PredefinedMenuItem::separator(app)?,
            &open_command_palette,
        ],
    )?;
    let navigate_menu = Submenu::with_items(
        app,
        "Navigate",
        true,
        &[
            &search_sessions,
            &open_settings,
            &open_docs,
            &refresh_gateway_status,
        ],
    )?;
    let view_menu = Submenu::with_items(app, "View", true, &[&toggle_theme, &toggle_sidebar])?;

    Menu::with_items(app, &[&file_menu, &navigate_menu, &view_menu])
}

fn menu_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &'static str,
) -> tauri::Result<MenuItem<R>> {
    let descriptor = desktop_menu_descriptor(id);
    MenuItem::with_id(
        app,
        descriptor.id,
        descriptor.label,
        descriptor.enabled,
        descriptor.accelerator,
    )
}

fn check_menu_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &'static str,
) -> tauri::Result<CheckMenuItem<R>> {
    let descriptor = desktop_menu_descriptor(id);
    CheckMenuItem::with_id(
        app,
        descriptor.id,
        descriptor.label,
        descriptor.enabled,
        descriptor.checked,
        descriptor.accelerator,
    )
}

fn desktop_menu_descriptor(id: &str) -> DesktopMenuItemDescriptor {
    desktop_menu_item_descriptors()
        .iter()
        .copied()
        .find(|item| item.id == id)
        .expect("desktop menu descriptor should exist")
}

fn is_desktop_menu_command(id: &str) -> bool {
    desktop_menu_item_descriptors()
        .iter()
        .any(|item| item.id == id)
}

fn upload_file_from_path(path: &Path) -> Result<PickedUploadFile, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("failed to read selected file: {error}"))?;
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("failed to inspect selected file: {error}"))?;
    Ok(PickedUploadFile {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("upload")
            .to_string(),
        path: path.display().to_string(),
        mime_type: mime_type_for_path(path).to_string(),
        size_bytes: metadata.len(),
        bytes,
    })
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "csv" => "text/csv",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "json" => "application/json",
        "markdown" | "md" => "text/markdown",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "jpeg" | "jpg" => "image/jpeg",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

fn allowed_workspace_file_path(repo_root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_workspace_file_path(requested_path)
        .ok_or_else(|| "workspace file is not revealable".to_string())?;
    if !ALLOWED_WORKSPACE_FILES
        .iter()
        .any(|allowed| *allowed == normalized)
    {
        return Err("workspace file is not revealable".to_string());
    }
    Ok(repo_root.join(normalized))
}

fn reveal_workspace_file_path(requested_path: &str) -> Result<PathBuf, String> {
    reveal_workspace_file_path_from_config_path(&default_tinybot_config_path(), requested_path)
}

fn reveal_workspace_file_path_from_config_path(
    config_path: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    let root = resolve_ts_agent_worker_workspace_root_from_config_path(config_path);
    allowed_workspace_file_path(&root, requested_path)
}

fn normalize_workspace_file_path(requested_path: &str) -> Option<String> {
    let normalized = requested_path.replace('\\', "/");
    let normalized = normalized.trim_matches('/');
    if normalized.is_empty()
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(normalized.to_string())
}

fn reveal_file_in_folder(path: &Path) -> Result<(), String> {
    let parent = if path.is_dir() {
        path
    } else {
        path.parent()
            .ok_or_else(|| "workspace file has no containing folder".to_string())?
    };

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        if path.exists() {
            command.arg(format!("/select,{}", path.display()));
        } else {
            command.arg(parent);
        }
        command.creation_flags(0x08000000);
        return spawn_reveal_command(command);
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if path.exists() {
            command.args(["-R", &path.display().to_string()]);
        } else {
            command.arg(parent);
        }
        return spawn_reveal_command(command);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(parent);
        return spawn_reveal_command(command);
    }

    #[allow(unreachable_code)]
    Err("revealing workspace files is not supported on this platform".to_string())
}

fn spawn_reveal_command(mut command: Command) -> Result<(), String> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to reveal workspace file: {error}"))
}

fn write_export_file(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|error| format!("failed to write export file: {error}"))
}

fn gateway_exit_policy_preference_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("Tinybot")
        .join("Desktop")
        .join("gateway-exit-policy.json")
}

fn native_backend_log_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .or_else(|| std::env::var_os("XDG_STATE_HOME"))
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join("tinybot").join("logs").join("native-backend.log")
}

fn load_gateway_exit_policy(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<GatewayExitPolicyPreference>(&contents).ok())
        .map(|preference| preference.keep_running)
        .unwrap_or(false)
}

fn persist_gateway_exit_policy(path: &Path, keep_running: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create gateway preference directory: {error}"))?;
    }
    let contents = serde_json::to_string_pretty(&GatewayExitPolicyPreference { keep_running })
        .map_err(|error| format!("failed to encode gateway preference: {error}"))?;
    std::fs::write(path, contents)
        .map_err(|error| format!("failed to persist gateway preference: {error}"))
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

fn safe_export_file_name(default_path: &str) -> String {
    default_path
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-")
        .trim()
        .trim_matches('-')
        .to_string()
}

fn current_status(shared: &SharedGateway) -> GatewayRuntimeStatus {
    let probe = gateway_bootstrap_probe();
    let http_ok = probe.is_ready();
    let runtime = lock_runtime(shared);
    let worker_status = runtime.experimental_worker.status();

    let owner = if worker_status.state == WorkerManagerState::Running {
        "shell"
    } else {
        "none"
    };
    let state = if worker_status.state == WorkerManagerState::Running {
        "running"
    } else if worker_status.state == WorkerManagerState::Failed || probe.is_conflict_or_error() {
        "failed"
    } else {
        "offline"
    };
    let exit_policy = if runtime.keep_background {
        "keep_running"
    } else {
        "stop_on_exit"
    };

    GatewayRuntimeStatus {
        state: state.to_string(),
        owner: owner.to_string(),
        http_ok,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "node workers/ts-agent-worker/src/index.ts",
        port: 18790,
        repo_root: repo_root().display().to_string(),
        log_path: runtime.persistent_log_path.display().to_string(),
        log_tail: read_native_backend_log_tail(
            &runtime.persistent_log_path,
            NATIVE_BACKEND_LOG_TAIL_LINES,
        ),
        logs: gateway_runtime_logs(&runtime.logs, &worker_status.diagnostics),
        last_error: runtime
            .last_error
            .clone()
            .or_else(|| worker_status.last_error.clone())
            .or_else(|| probe.last_error()),
        exit_policy,
        bootstrap_status: probe.bootstrap_status(),
        response_class: probe.response_class(),
        recovery_hint: probe.recovery_hint(),
        worker_runtime: gateway_worker_runtime_status(http_ok, &worker_status),
    }
}

fn gateway_worker_runtime_status(
    gateway_available: bool,
    worker_status: &WorkerManagerStatus,
) -> WorkerRuntimeStatus {
    match worker_status.state {
        WorkerManagerState::Running => WorkerRuntimeStatus::running(
            crate::worker_protocol::WorkerTransportMode::Stdio,
            worker_status.diagnostics.clone(),
        ),
        WorkerManagerState::Failed => WorkerRuntimeStatus::startup_failed(
            worker_status
                .last_error
                .clone()
                .unwrap_or_else(|| "worker manager failed".to_string()),
        ),
        WorkerManagerState::Stopped => {
            WorkerRuntimeStatus::compatibility_fallback(gateway_available)
        }
    }
}

fn gateway_bootstrap_probe() -> GatewayBootstrapProbe {
    let addr: SocketAddr = match "127.0.0.1:18790".parse() {
        Ok(addr) => addr,
        Err(error) => return GatewayBootstrapProbe::Offline(error.to_string()),
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(700)) {
        Ok(stream) => stream,
        Err(error) => return GatewayBootstrapProbe::Offline(error.to_string()),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    if stream
        .write_all(b"GET /webui/bootstrap HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return GatewayBootstrapProbe::Offline("failed to write bootstrap request".to_string());
    }
    let mut first_line = String::new();
    let mut reader = BufReader::new(stream);
    if reader.read_line(&mut first_line).is_err() {
        return GatewayBootstrapProbe::Offline("failed to read bootstrap response".to_string());
    }
    let mut rest = String::new();
    let _ = reader.read_to_string(&mut rest);
    let status = first_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok());
    classify_bootstrap_response(status, &rest)
}

fn classify_bootstrap_response(status: Option<u16>, response: &str) -> GatewayBootstrapProbe {
    let Some(status) = status else {
        return GatewayBootstrapProbe::Offline(
            "bootstrap response missing HTTP status".to_string(),
        );
    };
    let body = http_response_body(response);
    if !(200..300).contains(&status) {
        return GatewayBootstrapProbe::BootstrapError {
            status,
            detail: if body.trim().is_empty() {
                format!("bootstrap returned HTTP {status}")
            } else {
                format!("bootstrap returned HTTP {status}: {}", body.trim())
            },
        };
    }
    let payload: serde_json::Value = match serde_json::from_str(body.trim()) {
        Ok(payload) => payload,
        Err(error) => {
            return GatewayBootstrapProbe::Incompatible {
                detail: format!("bootstrap response is not valid JSON: {error}"),
            };
        }
    };
    if payload
        .get("token")
        .and_then(|value| value.as_str())
        .is_some_and(|token| !token.is_empty())
    {
        return GatewayBootstrapProbe::Ready;
    }
    GatewayBootstrapProbe::Incompatible {
        detail: "bootstrap response missing token".to_string(),
    }
}

fn http_response_body(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .or_else(|| response.split_once("\n\n").map(|(_, body)| body))
        .unwrap_or(response)
}

fn worker_echo_agent_with_options(
    shared: &SharedGateway,
    input: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<WorkerAgentEchoResult, String> {
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_experimental_fixture_worker_running(&worker, workspace_root, config_snapshot)?;

    let request_id = now_unix_ms();
    let request = WorkerRequest::new(
        format!("agent-echo-{request_id}"),
        format!("trace-agent-echo-{request_id}"),
        "agent.echo",
        serde_json::json!({ "input": input }),
    );
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker echo request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!("worker echo returned error: {}", error.message));
    }
    let result = response
        .result
        .ok_or_else(|| "worker echo response missing result".to_string())?;
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_run_agent_request(now_unix_ms(), spec);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker agent run request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker agent run returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker agent run response missing result".to_string())
}

fn build_worker_run_agent_request(request_id: u128, spec: serde_json::Value) -> WorkerRequest {
    WorkerRequest::new(
        format!("agent-run-{request_id}"),
        format!("trace-agent-run-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_run_agent_input_request(now_unix_ms(), input);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker agent run input request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker agent run input returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker agent run input response missing result".to_string())
}

fn build_worker_run_agent_input_request(
    request_id: u128,
    input: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        format!("agent-run-input-{request_id}"),
        format!("trace-agent-run-input-{request_id}"),
        "agent.run_input",
        serde_json::json!({ "input": input }),
    )
}

fn worker_cron_dispatch_due_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    now_ms: i64,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let Some(_dispatch_guard) = CronDispatchGuard::begin(shared) else {
        return Ok(serde_json::json!({
            "dispatched": 0,
            "records": [],
            "recorded": { "updated": [], "deleted": [], "missing": [] },
            "skipped": "already_running"
        }));
    };

    let mut router = experimental_worker_router(workspace_root.clone(), config_snapshot.clone());
    let due_response = router.dispatch(&WorkerRequest::new(
        format!("cron-due-{now_ms}"),
        format!("trace-cron-due-{now_ms}"),
        "cron.job.due",
        serde_json::json!({ "now_ms": now_ms }),
    ));
    if let Some(error) = due_response.error {
        return Err(format!("native cron due returned error: {}", error.message));
    }
    let jobs = due_response
        .result
        .as_ref()
        .and_then(|result| result.get("jobs"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let dispatched = jobs.as_array().map_or(0, Vec::len);
    if dispatched == 0 {
        return Ok(serde_json::json!({
            "dispatched": 0,
            "records": [],
            "recorded": { "updated": [], "deleted": [], "missing": [] }
        }));
    }

    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };
    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot.clone())?;

    let request = build_worker_cron_run_due_request(
        now_unix_ms(),
        jobs,
        cron_model_from_config(&config_snapshot),
    );
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker cron due request failed: {}", error.message))?;
    if let Some(error) = response.error {
        return Err(format!("worker cron due returned error: {}", error.message));
    }
    let result = response
        .result
        .ok_or_else(|| "worker cron due response missing result".to_string())?;
    let records = result
        .get("records")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));

    let record_response = router.dispatch(&WorkerRequest::new(
        format!("cron-record-{now_ms}"),
        format!("trace-cron-record-{now_ms}"),
        "cron.job.record_runs",
        serde_json::json!({ "now_ms": now_ms, "records": records.clone() }),
    ));
    if let Some(error) = record_response.error {
        return Err(format!(
            "native cron record_runs returned error: {}",
            error.message
        ));
    }
    let recorded = record_response
        .result
        .ok_or_else(|| "native cron record_runs response missing result".to_string())?;

    Ok(serde_json::json!({
        "dispatched": dispatched,
        "records": records,
        "recorded": recorded
    }))
}

fn worker_cron_next_wake_delay_with_options(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    now_ms: i64,
    max_poll: Duration,
) -> Result<Duration, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&WorkerRequest::new(
        format!("cron-next-wake-{now_ms}"),
        format!("trace-cron-next-wake-{now_ms}"),
        "cron.job.list",
        serde_json::json!({}),
    ));
    if let Some(error) = response.error {
        return Err(format!(
            "native cron list returned error: {}",
            error.message
        ));
    }
    let jobs = response
        .result
        .as_ref()
        .and_then(|result| result.get("jobs"))
        .and_then(serde_json::Value::as_array);
    let Some(next_run_at_ms) = jobs.and_then(|jobs| {
        jobs.iter()
            .filter(|job| {
                job.get("enabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true)
            })
            .filter_map(|job| {
                job.pointer("/state/nextRunAtMs")
                    .and_then(serde_json::Value::as_i64)
            })
            .min()
    }) else {
        return Ok(max_poll);
    };
    if next_run_at_ms <= now_ms {
        return Ok(Duration::ZERO);
    }
    Ok(Duration::from_millis((next_run_at_ms - now_ms) as u64).min(max_poll))
}

fn start_worker_heartbeat_runtime_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_worker_heartbeat_lifecycle_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_heartbeat_lifecycle_request(now_unix_ms(), "start"),
        timeout,
    )
}

fn stop_worker_heartbeat_runtime_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_worker_heartbeat_lifecycle_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_heartbeat_lifecycle_request(now_unix_ms(), "stop"),
        timeout,
    )
}

fn send_worker_heartbeat_lifecycle_request(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };
    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;
    let method = request.method.clone();
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker {method} request failed: {}", error.message))?;
    if let Some(error) = response.error {
        return Err(format!("worker {method} returned error: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("worker {method} response missing result"))
}

fn build_worker_heartbeat_lifecycle_request(request_id: u128, action: &str) -> WorkerRequest {
    WorkerRequest::new(
        format!("heartbeat-{action}-{request_id}"),
        format!("trace-heartbeat-{action}-{request_id}"),
        format!("heartbeat.{action}"),
        serde_json::json!({}),
    )
}

struct CronDispatchGuard {
    running: Arc<AtomicBool>,
}

impl CronDispatchGuard {
    fn begin(shared: &SharedGateway) -> Option<Self> {
        let running = {
            let runtime = lock_runtime(shared);
            runtime.cron_dispatch_running.clone()
        };
        running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(Self { running })
    }
}

impl Drop for CronDispatchGuard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

fn start_worker_cron_timer(shared: &SharedGateway) -> bool {
    let (started, stop) = {
        let runtime = lock_runtime(shared);
        (
            runtime.cron_timer_started.clone(),
            runtime.cron_timer_stop.clone(),
        )
    };
    if started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    stop.store(false, Ordering::SeqCst);
    let timer_shared = shared.clone();
    let log_shared = shared.clone();
    let builder = thread::Builder::new().name("tinybot-cron-timer".to_string());
    match builder.spawn(move || worker_cron_timer_loop(timer_shared, stop, started)) {
        Ok(_handle) => true,
        Err(error) => {
            log_shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .cron_timer_started
                .store(false, Ordering::SeqCst);
            push_log(
                &log_shared,
                &format!("failed to start native cron timer: {error}"),
            );
            false
        }
    }
}

fn stop_worker_cron_timer(shared: &SharedGateway) {
    let stop = {
        let runtime = lock_runtime(shared);
        runtime.cron_timer_stop.clone()
    };
    stop.store(true, Ordering::SeqCst);
}

fn worker_cron_timer_loop(shared: SharedGateway, stop: Arc<AtomicBool>, started: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        let delay = worker_cron_next_wake_delay_with_options(
            ts_agent_worker_workspace_root(),
            experimental_worker_config_snapshot(),
            now_unix_ms() as i64,
            WORKER_CRON_TIMER_MAX_POLL,
        )
        .unwrap_or(WORKER_CRON_TIMER_MAX_POLL);
        if sleep_cron_timer_or_stopped(delay, &stop) {
            break;
        }
        match worker_cron_dispatch_due_with_options(
            &shared,
            ts_agent_worker_workspace_root(),
            experimental_worker_config_snapshot(),
            now_unix_ms() as i64,
            Duration::from_secs(120),
        ) {
            Ok(result)
                if result.get("dispatched").and_then(serde_json::Value::as_u64) != Some(0) =>
            {
                push_log(
                    &shared,
                    &format!("native cron dispatched due jobs: {result}"),
                );
            }
            Ok(_) => {}
            Err(error) => push_log(&shared, &format!("native cron dispatch failed: {error}")),
        }
    }
    started.store(false, Ordering::SeqCst);
}

fn sleep_cron_timer_or_stopped(delay: Duration, stop: &AtomicBool) -> bool {
    let mut remaining = delay;
    while !remaining.is_zero() {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        let chunk = remaining.min(Duration::from_millis(250));
        thread::sleep(chunk);
        remaining = remaining.saturating_sub(chunk);
    }
    stop.load(Ordering::SeqCst)
}

fn build_worker_cron_run_due_request(
    request_id: u128,
    jobs: serde_json::Value,
    model: String,
) -> WorkerRequest {
    WorkerRequest::new(
        format!("cron-run-due-{request_id}"),
        format!("trace-cron-run-due-{request_id}"),
        "cron.run_due",
        serde_json::json!({
            "jobs": jobs,
            "model": model,
            "maxIterations": 4,
            "stream": false
        }),
    )
}

fn cron_model_from_config(config_snapshot: &serde_json::Value) -> String {
    config_snapshot
        .pointer("/agents/defaults/model")
        .and_then(serde_json::Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .unwrap_or("gpt-5")
        .to_string()
}

fn worker_skills_list_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_skills_list_request(now_unix_ms());
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker skills list request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker skills list returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker skills list response missing result".to_string())
}

fn build_worker_skills_list_request(request_id: u128) -> WorkerRequest {
    WorkerRequest::new(
        format!("skills-list-{request_id}"),
        format!("trace-skills-list-{request_id}"),
        "skills.webui_list",
        serde_json::json!({}),
    )
}

fn worker_skills_detail_with_options(
    shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_skills_detail_request(now_unix_ms(), name);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker skills detail request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker skills detail returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker skills detail response missing result".to_string())
}

fn build_worker_skills_detail_request(request_id: u128, name: String) -> WorkerRequest {
    WorkerRequest::new(
        format!("skills-detail-{request_id}"),
        format!("trace-skills-detail-{request_id}"),
        "skills.webui_detail",
        serde_json::json!({ "name": name }),
    )
}

fn worker_skills_create_with_options(
    shared: &SharedGateway,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_skills_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_skills_create_request(now_unix_ms(), body),
        timeout,
        "create",
    )
}

fn build_worker_skills_create_request(request_id: u128, body: serde_json::Value) -> WorkerRequest {
    WorkerRequest::new(
        format!("skills-create-{request_id}"),
        format!("trace-skills-create-{request_id}"),
        "skills.webui_create",
        serde_json::json!({ "body": body }),
    )
}

fn worker_skills_update_with_options(
    shared: &SharedGateway,
    name: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_skills_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_skills_update_request(now_unix_ms(), name, body),
        timeout,
        "update",
    )
}

fn build_worker_skills_update_request(
    request_id: u128,
    name: String,
    body: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        format!("skills-update-{request_id}"),
        format!("trace-skills-update-{request_id}"),
        "skills.webui_update",
        serde_json::json!({ "name": name, "body": body }),
    )
}

fn worker_skills_delete_with_options(
    shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_skills_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_skills_delete_request(now_unix_ms(), name),
        timeout,
        "delete",
    )
}

fn build_worker_skills_delete_request(request_id: u128, name: String) -> WorkerRequest {
    WorkerRequest::new(
        format!("skills-delete-{request_id}"),
        format!("trace-skills-delete-{request_id}"),
        "skills.webui_delete",
        serde_json::json!({ "name": name }),
    )
}

fn worker_skills_validate_with_options(
    shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_skills_worker_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_skills_validate_request(now_unix_ms(), name),
        timeout,
        "validate",
    )
}

fn build_worker_skills_validate_request(request_id: u128, name: String) -> WorkerRequest {
    WorkerRequest::new(
        format!("skills-validate-{request_id}"),
        format!("trace-skills-validate-{request_id}"),
        "skills.webui_validate",
        serde_json::json!({ "name": name }),
    )
}

fn worker_cowork_route_with_options(
    shared: &SharedGateway,
    input: WorkerCoworkRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_cowork_route_request(now_unix_ms(), input);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker cowork route request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker cowork route returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker cowork route response missing result".to_string())
}

fn build_worker_cowork_route_request(
    request_id: u128,
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
        format!("cowork-route-{request_id}"),
        format!("trace-cowork-route-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_webui_route_request(now_unix_ms(), input);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker webui route request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker webui route returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker webui route response missing result".to_string())
}

fn worker_webui_route_timeout(input: &WorkerWebuiRouteInput) -> Duration {
    let _ = input;
    WORKER_WEBUI_ROUTE_TIMEOUT
}

fn build_worker_webui_route_request(
    request_id: u128,
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
        format!("webui-route-{request_id}"),
        format!("trace-webui-route-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_transport_gateway_frame_request(now_unix_ms(), input);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| {
            format!(
                "worker transport gateway frame request failed: {}",
                error.message
            )
        })?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker transport gateway frame returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker transport gateway frame response missing result".to_string())
}

fn build_worker_transport_gateway_frame_request(
    request_id: u128,
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
        format!("transport-gateway-frame-{request_id}"),
        format!("trace-transport-gateway-frame-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_transport_websocket_message_request(now_unix_ms(), input);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| {
            format!(
                "worker transport websocket message request failed: {}",
                error.message
            )
        })?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker transport websocket message returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker transport websocket message response missing result".to_string())
}

fn build_worker_transport_websocket_message_request(
    request_id: u128,
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
        format!("transport-websocket-message-{request_id}"),
        format!("trace-transport-websocket-message-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let transport_request = build_worker_transport_websocket_message_request(
        now_unix_ms(),
        WorkerTransportWebSocketMessageInput {
            client_id: input.client_id,
            frame: input.frame,
            attached_chat_id: input.attached_chat_id,
            session_exists: input.session_exists,
            editable_paths: input.editable_paths,
        },
    );
    let transport_response = worker
        .send_stdio_request(&transport_request, timeout)
        .map_err(|error| {
            format!(
                "worker transport websocket dispatch mapper request failed: {}",
                error.message
            )
        })?;

    if let Some(error) = transport_response.error {
        return Err(format!(
            "worker transport websocket dispatch mapper returned error: {}",
            error.message
        ));
    }
    let transport_result = transport_response.result.ok_or_else(|| {
        "worker transport websocket dispatch mapper response missing result".to_string()
    })?;

    let dispatch_options = WorkerTransportWebSocketDispatchOptions {
        model: input.model,
        max_iterations: input.max_iterations,
        stream: input.stream,
    };
    let Some(run_request) = build_worker_transport_websocket_run_input_request(
        now_unix_ms(),
        &transport_result,
        dispatch_options,
    ) else {
        return Ok(serde_json::json!({ "transport": transport_result }));
    };

    let agent_response = worker
        .send_stdio_request(&run_request, timeout)
        .map_err(|error| {
            format!(
                "worker transport websocket dispatch agent request failed: {}",
                error.message
            )
        })?;
    if let Some(error) = agent_response.error {
        return Err(format!(
            "worker transport websocket dispatch agent returned error: {}",
            error.message
        ));
    }
    let agent_result = agent_response.result.ok_or_else(|| {
        "worker transport websocket dispatch agent response missing result".to_string()
    })?;

    Ok(serde_json::json!({
        "transport": transport_result,
        "agent": agent_result,
    }))
}

fn build_worker_transport_websocket_run_input_request(
    request_id: u128,
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

    let mut input = serde_json::json!({
        "runId": format!(
            "websocket-{}-{request_id}",
            sanitize_worker_run_id_part(if chat_id.is_empty() { session_id } else { chat_id })
        ),
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
        format!("transport-websocket-run-input-{request_id}"),
        format!("trace-transport-websocket-run-input-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_channel_dispatch_inbound_request(now_unix_ms(), input);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| {
            format!(
                "worker channel dispatch inbound request failed: {}",
                error.message
            )
        })?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker channel dispatch inbound returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker channel dispatch inbound response missing result".to_string())
}

fn build_worker_channel_dispatch_inbound_request(
    request_id: u128,
    input: WorkerChannelDispatchInboundInput,
) -> WorkerRequest {
    WorkerRequest::new(
        format!("channel-dispatch-inbound-{request_id}"),
        format!("trace-channel-dispatch-inbound-{request_id}"),
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
        build_worker_channel_start_request(now_unix_ms()),
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
        build_worker_channel_status_request(now_unix_ms()),
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
        build_worker_channel_stop_request(now_unix_ms()),
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
        build_worker_channel_login_request(now_unix_ms(), channel, force),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker channel {action} request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker channel {action} returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| format!("worker channel {action} response missing result"))
}

fn build_worker_channel_start_request(request_id: u128) -> WorkerRequest {
    WorkerRequest::new(
        format!("channel-start-{request_id}"),
        format!("trace-channel-start-{request_id}"),
        "channel.start",
        serde_json::json!({}),
    )
}

fn build_worker_channel_status_request(request_id: u128) -> WorkerRequest {
    WorkerRequest::new(
        format!("channel-status-{request_id}"),
        format!("trace-channel-status-{request_id}"),
        "channel.status",
        serde_json::json!({}),
    )
}

fn build_worker_channel_stop_request(request_id: u128) -> WorkerRequest {
    WorkerRequest::new(
        format!("channel-stop-{request_id}"),
        format!("trace-channel-stop-{request_id}"),
        "channel.stop",
        serde_json::json!({}),
    )
}

fn build_worker_channel_login_request(
    request_id: u128,
    channel: String,
    force: bool,
) -> WorkerRequest {
    WorkerRequest::new(
        format!("channel-login-{request_id}"),
        format!("trace-channel-login-{request_id}"),
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

fn send_skills_worker_request(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    timeout: Duration,
    action: &str,
) -> Result<serde_json::Value, String> {
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker skills {action} request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker skills {action} returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| format!("worker skills {action} response missing result"))
}

fn worker_cancel_agent_with_options(
    shared: &SharedGateway,
    run_id: String,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };
    if worker.status().state != WorkerManagerState::Running {
        return Err("TS agent worker is not running".to_string());
    }

    let request = build_worker_cancel_agent_request(now_unix_ms(), run_id);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| format!("worker agent cancel request failed: {}", error.message))?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker agent cancel returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker agent cancel response missing result".to_string())
}

fn build_worker_cancel_agent_request(request_id: u128, run_id: String) -> WorkerRequest {
    WorkerRequest::new(
        format!("agent-cancel-{request_id}"),
        format!("trace-agent-cancel-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_restore_agent_checkpoint_request(now_unix_ms(), session_id);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| {
            format!(
                "worker agent checkpoint restore request failed: {}",
                error.message
            )
        })?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker agent checkpoint restore returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker agent checkpoint restore response missing result".to_string())
}

fn build_worker_restore_agent_checkpoint_request(
    request_id: u128,
    session_id: String,
) -> WorkerRequest {
    WorkerRequest::new(
        format!("agent-restore-checkpoint-{request_id}"),
        format!("trace-agent-restore-checkpoint-{request_id}"),
        "agent.restore_checkpoint",
        serde_json::json!({ "sessionId": session_id }),
    )
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request =
        build_worker_submit_agent_form_request(now_unix_ms(), session_id, form_id, values, action);
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| {
            format!(
                "worker agent form submission request failed: {}",
                error.message
            )
        })?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker agent form submission returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker agent form submission response missing result".to_string())
}

fn build_worker_submit_agent_form_request(
    request_id: u128,
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
        format!("agent-submit-form-{request_id}"),
        format!("trace-agent-submit-form-{request_id}"),
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
    let worker = {
        let runtime = lock_runtime(shared);
        runtime.experimental_worker.clone()
    };

    ensure_ts_agent_worker_running(&worker, workspace_root, config_snapshot)?;

    let request = build_worker_resume_agent_approval_request(
        now_unix_ms(),
        session_id,
        approval_id,
        approved,
        scope,
    );
    let response = worker
        .send_stdio_request(&request, timeout)
        .map_err(|error| {
            format!(
                "worker agent approval resume request failed: {}",
                error.message
            )
        })?;

    if let Some(error) = response.error {
        return Err(format!(
            "worker agent approval resume returned error: {}",
            error.message
        ));
    }
    response
        .result
        .ok_or_else(|| "worker agent approval resume response missing result".to_string())
}

fn build_worker_resume_agent_approval_request(
    request_id: u128,
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
        format!("agent-resume-approval-{request_id}"),
        format!("trace-agent-resume-approval-{request_id}"),
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
        .expect("src-tauri should have desktop parent")
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
        .expect("src-tauri should have desktop parent")
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
    WorkerRpcRouter::new(
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
            WorkerCapability::McpCall,
            WorkerCapability::ChannelConnector,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
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
    repo_root()
        .join("apps")
        .join("desktop")
        .join("workers")
        .join("ts-worker-fixture")
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

fn stop_owned_gateway(shared: &SharedGateway, explicit: bool) -> Result<(), String> {
    let (worker, experimental_worker) = {
        let runtime = lock_runtime(shared);
        if !explicit && runtime.keep_background {
            let worker = runtime.worker.clone();
            drop(runtime);
            let _ = worker.stop();
            push_log(shared, "leaving native TS backend running in background");
            return Ok(());
        }
        (runtime.worker.clone(), runtime.experimental_worker.clone())
    };

    let was_running = experimental_worker.status().state == WorkerManagerState::Running;
    worker
        .stop()
        .map_err(|error| format!("failed to stop gateway: {error:?}"))?;
    experimental_worker
        .stop()
        .map_err(|error| format!("failed to stop experimental worker: {error:?}"))?;
    if was_running {
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, "stopped native TS backend");
    }
    Ok(())
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

fn append_native_backend_log_line(
    path: &Path,
    max_bytes: u64,
    stream: &str,
    line: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create native backend log directory: {error}"))?;
    }
    rotate_native_backend_log_if_needed(path, max_bytes)
        .map_err(|error| format!("failed to rotate native backend log: {error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open native backend log: {error}"))?;
    writeln!(file, "{} {} {}", now_unix_ms(), stream, line)
        .map_err(|error| format!("failed to write native backend log: {error}"))
}

fn rotate_native_backend_log_if_needed(path: &Path, max_bytes: u64) -> std::io::Result<()> {
    if max_bytes == 0
        || std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            < max_bytes
    {
        return Ok(());
    }
    let rotated = native_backend_rotated_log_path(path);
    let _ = std::fs::remove_file(&rotated);
    std::fs::rename(path, rotated)
}

fn native_backend_rotated_log_path(path: &Path) -> PathBuf {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return path.with_extension("1");
    };
    path.with_file_name(format!("{file_name}.1"))
}

fn gateway_runtime_logs(
    runtime_logs: &VecDeque<String>,
    diagnostics: &[crate::worker_protocol::WorkerDiagnosticLine],
) -> Vec<String> {
    runtime_logs
        .iter()
        .cloned()
        .chain(
            diagnostics
                .iter()
                .map(|line| format!("{}: {}", line.stream, line.line)),
        )
        .collect()
}

fn read_native_backend_log_tail(path: &Path, max_lines: usize) -> Vec<String> {
    if max_lines == 0 {
        return Vec::new();
    }
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines = contents
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].to_vec()
}

fn worker_manager_frontend_event(event: WorkerManagerEvent) -> (String, serde_json::Value) {
    match event {
        WorkerManagerEvent::Status(status) => (
            "worker.status".to_string(),
            serde_json::to_value(status).unwrap_or_else(|_| serde_json::json!({})),
        ),
        WorkerManagerEvent::Diagnostics(line) => (
            "diagnostics.log".to_string(),
            serde_json::to_value(line).unwrap_or_else(|_| serde_json::json!({})),
        ),
        WorkerManagerEvent::Protocol(event) => (
            event.event,
            serde_json::to_value(event.payload).unwrap_or_else(|_| serde_json::json!({})),
        ),
    }
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(PathBuf::from)
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
            runtime.worker.set_event_sink(move |event| {
                record_worker_manager_event_for_logs(&log_state, &event);
                emit_worker_manager_frontend_event(&app_handle, event);
            });
            let app_handle = app.handle().clone();
            let log_state = setup_state.clone();
            runtime.experimental_worker.set_event_sink(move |event| {
                record_worker_manager_event_for_logs(&log_state, &event);
                emit_worker_manager_frontend_event(&app_handle, event);
            });
            drop(runtime);
            start_worker_cron_timer(&setup_state);
            if let Err(error) = start_worker_heartbeat_runtime_with_options(
                &setup_state,
                ts_agent_worker_workspace_root(),
                experimental_worker_config_snapshot(),
                Duration::from_secs(10),
            ) {
                push_log(
                    &setup_state,
                    &format!("native heartbeat start failed: {error}"),
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
            worker_submit_agent_form,
            worker_resume_agent_approval,
            worker_cron_dispatch_due,
            apply_config_patch_result,
            pick_upload_file,
            reveal_workspace_file,
            save_export_file
        ])
        .on_window_event(move |_window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                stop_worker_cron_timer(&close_state);
                if let Err(error) = stop_worker_heartbeat_runtime_with_options(
                    &close_state,
                    ts_agent_worker_workspace_root(),
                    experimental_worker_config_snapshot(),
                    Duration::from_secs(10),
                ) {
                    push_log(
                        &close_state,
                        &format!("native heartbeat stop failed: {error}"),
                    );
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

    #[test]
    fn close_shutdown_stops_native_ts_backend_child() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        {
            let runtime = lock_runtime(&shared);
            runtime
                .experimental_worker
                .start(test_gateway_worker_spec("ts-backend-close-worker"))
                .expect("test worker should start");
        }

        stop_owned_gateway(&shared, false).expect("native TS backend child should stop");

        let runtime = lock_runtime(&shared);
        assert_eq!(
            runtime.experimental_worker.status().state,
            crate::worker_manager::WorkerManagerState::Stopped
        );
        assert!(runtime
            .logs
            .iter()
            .any(|line| line == "stopped native TS backend"));
    }

    #[test]
    fn gateway_status_uses_ts_worker_manager_for_native_backend() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let worker = {
            let runtime = lock_runtime(&shared);
            runtime.experimental_worker.clone()
        };
        worker
            .start(test_gateway_short_worker_spec("gateway-status-worker"))
            .expect("test worker should start");

        let status = current_status(&shared);

        assert_eq!(status.owner, "shell");
        assert_eq!(status.state, "running");
    }

    #[test]
    fn gateway_status_reflects_running_worker_runtime() {
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
        assert!(!status.worker_runtime.gateway_compatibility_available);
    }

    #[test]
    fn gateway_status_reports_ts_worker_diagnostics_instead_of_legacy_gateway_logs() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let (legacy_worker, ts_worker) = {
            let runtime = lock_runtime(&shared);
            (runtime.worker.clone(), runtime.experimental_worker.clone())
        };
        legacy_worker
            .start(test_logging_sleep_worker_spec(
                "tinybot-gateway",
                "legacy python backend",
            ))
            .expect("legacy worker should start");
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
        assert!(!log_text.contains("legacy python backend"));
        assert!(diagnostic_text.contains("ts native backend"));
        assert!(!diagnostic_text.contains("legacy python backend"));
        assert_eq!(status.command, "node workers/ts-agent-worker/src/index.ts");
    }

    #[test]
    fn worker_echo_agent_uses_experimental_worker_without_starting_gateway_worker() {
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
        assert_eq!(runtime.worker.status().state, WorkerManagerState::Stopped);
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
                    .is_some_and(|path| path.starts_with("tinybot/skills/"))
        }));
    }

    #[test]
    fn experimental_worker_config_snapshot_loads_real_tinybot_config() {
        let fixture = WorkspaceFixture::new();
        fixture.write("config.json", r#"{
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
        }"#);
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
            experimental_worker_config_snapshot_from_path(&fixture.root.join("missing-config.json")),
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
        fixture.write("memory/notes.jsonl", "Use uv for Python commands.");
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

        let request = build_worker_run_agent_request(42, agent_spec.clone());

        assert_eq!(request.id, "agent-run-42");
        assert_eq!(request.trace_id, "trace-agent-run-42");
        assert_eq!(request.method, "agent.run");
        assert_eq!(request.params, serde_json::json!({ "spec": agent_spec }));
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

        let request = build_worker_run_agent_input_request(42, agent_input.clone());

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

        let request = build_worker_cron_run_due_request(42, jobs.clone(), "gpt-5".to_string());

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
    fn worker_heartbeat_lifecycle_requests_target_ts_worker_methods() {
        let start = build_worker_heartbeat_lifecycle_request(42, "start");
        assert_eq!(start.id, "heartbeat-start-42");
        assert_eq!(start.trace_id, "trace-heartbeat-start-42");
        assert_eq!(start.method, "heartbeat.start");
        assert_eq!(start.params, serde_json::json!({}));

        let stop = build_worker_heartbeat_lifecycle_request(43, "stop");
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
    fn worker_skills_requests_target_ts_webui_skill_methods() {
        let list_request = build_worker_skills_list_request(42);
        let detail_request = build_worker_skills_detail_request(43, "planner/phase".to_string());
        let create_request =
            build_worker_skills_create_request(44, serde_json::json!({ "name": "planner" }));
        let update_request = build_worker_skills_update_request(
            45,
            "planner/phase".to_string(),
            serde_json::json!({ "content": "Updated" }),
        );
        let delete_request = build_worker_skills_delete_request(46, "planner/phase".to_string());
        let validate_request =
            build_worker_skills_validate_request(47, "planner/phase".to_string());

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
    fn worker_cowork_route_request_targets_ts_route_bridge() {
        let request = build_worker_cowork_route_request(
            42,
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
    fn worker_webui_route_request_targets_ts_route_bridge() {
        let request = build_worker_webui_route_request(
            42,
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
            42,
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
            42,
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
            42,
            &mapper_result,
            WorkerTransportWebSocketDispatchOptions {
                model: Some("gpt-5".to_string()),
                max_iterations: Some(6),
                stream: None,
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
            43,
            &serde_json::json!({ "kind": "ping", "frames": [{ "event": "pong" }] }),
            WorkerTransportWebSocketDispatchOptions::default(),
        )
        .is_none());
    }

    #[test]
    fn worker_channel_dispatch_inbound_request_targets_ts_channel_runtime() {
        let request = build_worker_channel_dispatch_inbound_request(
            42,
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
        let start_request = build_worker_channel_start_request(42);
        let status_request = build_worker_channel_status_request(43);
        let stop_request = build_worker_channel_stop_request(44);
        let login_request = build_worker_channel_login_request(45, "feishu".to_string(), true);

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
        let request = build_worker_cancel_agent_request(42, "run-1".to_string());

        assert_eq!(request.id, "agent-cancel-42");
        assert_eq!(request.trace_id, "trace-agent-cancel-42");
        assert_eq!(request.method, "agent.cancel");
        assert_eq!(request.params, serde_json::json!({ "runId": "run-1" }));
    }

    #[test]
    fn worker_restore_agent_checkpoint_request_wraps_session_id_for_ts_worker() {
        let request =
            build_worker_restore_agent_checkpoint_request(42, "WebSocket:chat-1".to_string());

        assert_eq!(request.id, "agent-restore-checkpoint-42");
        assert_eq!(request.trace_id, "trace-agent-restore-checkpoint-42");
        assert_eq!(request.method, "agent.restore_checkpoint");
        assert_eq!(
            request.params,
            serde_json::json!({ "sessionId": "WebSocket:chat-1" })
        );
    }

    #[test]
    fn worker_submit_agent_form_request_wraps_form_submission_for_ts_worker() {
        let request = build_worker_submit_agent_form_request(
            42,
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
            42,
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
            worker: WorkerManager::new(200),
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
    fn native_config_patch_result_persists_python_compatible_config_file() {
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
            command: "node workers/ts-agent-worker/src/index.ts",
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
            worker_runtime: crate::worker_runtime::WorkerRuntimeStatus::compatibility_fallback(
                true,
            ),
        };

        let value = serde_json::to_value(status).expect("status should serialize");

        assert_eq!(value["worker_runtime"]["state"], "stopped");
        assert_eq!(
            value["worker_runtime"]["gateway_compatibility_available"],
            true
        );
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

        assert_eq!(event_name, "worker.status");
        assert_eq!(payload["state"], "running");
        assert_eq!(payload["label"], "tinybot-gateway");
        assert_eq!(payload["pid"], 1234);
    }

    #[test]
    fn worker_manager_diagnostics_event_maps_to_frontend_diagnostics_log_event() {
        let (event_name, payload) = worker_manager_frontend_event(WorkerManagerEvent::Diagnostics(
            crate::worker_protocol::WorkerDiagnosticLine::new("stderr", "worker ready"),
        ));

        assert_eq!(event_name, "diagnostics.log");
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

        assert_eq!(event_name, "agent.delta");
        assert_eq!(payload["message"], "starting");
    }

    #[test]
    fn worker_probe_status_reports_protocol_metadata() {
        let status = worker_probe_status();
        let value = serde_json::to_value(status).expect("worker probe status should serialize");

        assert_eq!(value["state"], "running");
        assert_eq!(value["transport_mode"], "stdio");
        assert_eq!(
            value["diagnostics"][0]["line"],
            format!(
                "worker protocol {}",
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
                [
                    "/C",
                    &format!("echo {message} & ping -n 3 127.0.0.1 > NUL"),
                ],
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
