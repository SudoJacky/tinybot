use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Runtime, State, WindowEvent,
};

pub mod worker_capability;
pub mod worker_manager;
pub mod worker_protocol;
pub mod worker_runtime;

use crate::worker_manager::{
    WorkerCommandSpec, WorkerManager, WorkerManagerError, WorkerManagerState, WorkerManagerStatus,
};
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

struct GatewayRuntime {
    worker: WorkerManager,
    logs: VecDeque<String>,
    last_error: Option<String>,
    keep_background: bool,
}

impl Default for GatewayRuntime {
    fn default() -> Self {
        Self {
            worker: WorkerManager::new(200),
            logs: VecDeque::with_capacity(200),
            last_error: None,
            keep_background: false,
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
    logs: Vec<String>,
    last_error: Option<String>,
    exit_policy: &'static str,
    bootstrap_status: String,
    response_class: Option<String>,
    recovery_hint: Option<String>,
    worker_runtime: WorkerRuntimeStatus,
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
        matches!(self, Self::Incompatible { .. } | Self::BootstrapError { .. })
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
fn start_gateway(state: State<'_, SharedGateway>) -> Result<GatewayRuntimeStatus, String> {
    match gateway_bootstrap_probe() {
        GatewayBootstrapProbe::Ready => {
            push_log(
                state.inner(),
                "gateway already reachable; treating process as external",
            );
            return Ok(current_status(state.inner()));
        }
        GatewayBootstrapProbe::Incompatible { detail } => {
            push_log(state.inner(), &detail);
            return Ok(current_status(state.inner()));
        }
        GatewayBootstrapProbe::BootstrapError { detail, .. } => {
            push_log(state.inner(), &detail);
            return Ok(current_status(state.inner()));
        }
        GatewayBootstrapProbe::Offline(_) => {}
    }

    let repo_root = repo_root();
    let worker = {
        let runtime = lock_runtime(state.inner());
        runtime.worker.clone()
    };
    match worker.start(gateway_worker_command_spec()) {
        Ok(()) => {
            let mut runtime = lock_runtime(state.inner());
            runtime.last_error = None;
            append_log(
                &mut runtime,
                "started shell-owned gateway with `uv run tinybot gateway`",
            );
        }
        Err(WorkerManagerError::AlreadyRunning) => {
            push_log(state.inner(), "shell-owned gateway worker is already running");
        }
        Err(error) => {
            let message = format!("failed to start gateway: {error:?}");
            let mut runtime = lock_runtime(state.inner());
            runtime.last_error = Some(message.clone());
            return Err(message);
        }
    }

    {
        let mut runtime = lock_runtime(state.inner());
        append_log(
            &mut runtime,
            &format!("gateway worker cwd: {}", repo_root.display()),
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
                "configured shell-owned gateway to keep running after desktop exits"
            } else {
                "configured shell-owned gateway to stop when desktop exits"
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
    let target_path = allowed_workspace_file_path(&repo_root(), &path)?;
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
    let worker_status = runtime.worker.status();
    let worker_running = worker_status.state == WorkerManagerState::Running;

    let owner = if worker_running {
        "shell"
    } else if http_ok {
        "external"
    } else {
        "none"
    };
    let state = if http_ok {
        "running"
    } else if probe.is_conflict_or_error() {
        "failed"
    } else if worker_running {
        "starting"
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
        command: "uv run tinybot gateway",
        port: 18790,
        repo_root: repo_root().display().to_string(),
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
        WorkerManagerState::Stopped => WorkerRuntimeStatus::compatibility_fallback(gateway_available),
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
        return GatewayBootstrapProbe::Offline("bootstrap response missing HTTP status".to_string());
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

fn gateway_worker_command_spec() -> WorkerCommandSpec {
    WorkerCommandSpec::new("uv", ["run", "tinybot", "gateway"], repo_root())
        .with_label("tinybot-gateway")
}

fn stop_owned_gateway(shared: &SharedGateway, explicit: bool) -> Result<(), String> {
    let worker = {
        let runtime = lock_runtime(shared);
        if !explicit && runtime.keep_background {
            drop(runtime);
            push_log(shared, "leaving shell-owned gateway running in background");
            return Ok(());
        }
        runtime.worker.clone()
    };

    let was_running = worker.status().state == WorkerManagerState::Running;
    worker
        .stop()
        .map_err(|error| format!("failed to stop gateway: {error:?}"))?;
    if was_running {
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, "stopped shell-owned gateway");
    }
    Ok(())
}

fn push_log(shared: &SharedGateway, line: &str) {
    let mut runtime = lock_runtime(shared);
    append_log(&mut runtime, line);
}

fn append_log(runtime: &mut GatewayRuntime, line: &str) {
    if runtime.logs.len() >= 200 {
        runtime.logs.pop_front();
    }
    runtime.logs.push_back(line.to_string());
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(gateway_state)
        .setup(|app| {
            install_desktop_application_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            gateway_status,
            start_gateway,
            stop_gateway,
            set_gateway_keep_running,
            worker_probe_status,
            pick_upload_file,
            reveal_workspace_file,
            save_export_file
        ])
        .on_window_event(move |_window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
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
    fn close_shutdown_stops_shell_owned_gateway_child() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        {
            let runtime = lock_runtime(&shared);
            runtime
                .worker
                .start(test_gateway_worker_spec("gateway-close-worker"))
                .expect("test worker should start");
        }

        stop_owned_gateway(&shared, false).expect("shell-owned gateway child should stop");

        let runtime = lock_runtime(&shared);
        assert_eq!(
            runtime.worker.status().state,
            crate::worker_manager::WorkerManagerState::Stopped
        );
        assert!(runtime
            .logs
            .iter()
            .any(|line| line == "stopped shell-owned gateway"));
    }

    #[test]
    fn gateway_worker_command_spec_uses_uv_gateway_in_repo_root() {
        let spec = gateway_worker_command_spec();

        assert_eq!(spec.label, "tinybot-gateway");
        assert_eq!(spec.program, "uv");
        assert_eq!(spec.args, vec!["run", "tinybot", "gateway"]);
        assert_eq!(spec.cwd, repo_root());
    }

    #[test]
    fn gateway_status_uses_worker_manager_for_shell_owned_process() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let worker = {
            let runtime = lock_runtime(&shared);
            runtime.worker.clone()
        };
        worker
            .start(test_gateway_short_worker_spec("gateway-status-worker"))
            .expect("test worker should start");

        let status = current_status(&shared);

        assert_eq!(status.owner, "shell");
        assert_eq!(
            status.state,
            if status.http_ok { "running" } else { "starting" }
        );
    }

    #[test]
    fn gateway_status_reflects_running_worker_runtime() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
        let worker = {
            let runtime = lock_runtime(&shared);
            runtime.worker.clone()
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
    fn gateway_status_exposes_port_and_exit_policy() {
        let shared = Arc::new(Mutex::new(GatewayRuntime {
            worker: WorkerManager::new(200),
            logs: VecDeque::with_capacity(200),
            last_error: None,
            keep_background: true,
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
    fn bootstrap_probe_classifies_incompatible_2xx_response() {
        let probe = classify_bootstrap_response(
            Some(200),
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>not tinybot</html>",
        );

        assert_eq!(probe.bootstrap_status(), "incompatible");
        assert_eq!(probe.response_class(), Some("incompatible-bootstrap".to_string()));
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
            command: "uv run tinybot gateway",
            port: 18790,
            repo_root: "/repo".to_string(),
            logs: vec![],
            last_error: None,
            exit_policy: "stop_on_exit",
            bootstrap_status: "ready".to_string(),
            response_class: Some("tinybot-bootstrap".to_string()),
            recovery_hint: None,
            worker_runtime: crate::worker_runtime::WorkerRuntimeStatus::compatibility_fallback(true),
        };

        let value = serde_json::to_value(status).expect("status should serialize");

        assert_eq!(value["worker_runtime"]["state"], "stopped");
        assert_eq!(value["worker_runtime"]["gateway_compatibility_available"], true);
    }

    #[test]
    fn worker_probe_status_reports_protocol_metadata() {
        let status = worker_probe_status();
        let value = serde_json::to_value(status).expect("worker probe status should serialize");

        assert_eq!(value["state"], "running");
        assert_eq!(value["transport_mode"], "stdio");
        assert_eq!(
            value["diagnostics"][0]["line"],
            format!("worker protocol {}", crate::worker_protocol::WORKER_PROTOCOL_VERSION)
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
}
