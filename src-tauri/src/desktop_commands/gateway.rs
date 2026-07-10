use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    time::Duration,
};

use tauri::State;

use crate::desktop_logging::{gateway_runtime_logs, read_native_backend_log_tail};
use crate::native_backend_contract::{
    native_route_owner_summary, native_webui_route_inventory,
    NativeCompatibilityFallbackDiagnostic, NativeRouteInventoryEntry, NativeRouteOwnerSummary,
};
use crate::worker_manager::WorkerManagerState;
use crate::worker_runtime::WorkerRuntimeStatus;
use crate::{
    append_log, lock_runtime, push_log, repo_root, SharedGateway, NATIVE_BACKEND_LOG_TAIL_LINES,
};

const RUST_BACKEND_COMMAND: &str = "Tauri Rust backend";

#[derive(Serialize)]
pub(crate) struct GatewayRuntimeStatus {
    pub(crate) state: String,
    pub(crate) owner: String,
    pub(crate) http_ok: bool,
    pub(crate) gateway_http: &'static str,
    pub(crate) gateway_ws: &'static str,
    pub(crate) command: &'static str,
    pub(crate) port: u16,
    pub(crate) repo_root: String,
    pub(crate) log_path: String,
    pub(crate) log_tail: Vec<String>,
    pub(crate) logs: Vec<String>,
    pub(crate) last_error: Option<String>,
    pub(crate) exit_policy: &'static str,
    pub(crate) bootstrap_status: String,
    pub(crate) response_class: Option<String>,
    pub(crate) recovery_hint: Option<String>,
    pub(crate) worker_runtime: WorkerRuntimeStatus,
    pub(crate) agent_tasks: AgentTaskRuntimeStatus,
    pub(crate) route_owner_summary: NativeRouteOwnerSummary,
    pub(crate) webui_route_inventory: Vec<NativeRouteInventoryEntry>,
    pub(crate) compatibility_fallback_diagnostics: Vec<NativeCompatibilityFallbackDiagnostic>,
}

#[derive(Deserialize, Serialize)]
struct GatewayExitPolicyPreference {
    keep_running: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum GatewayBootstrapProbe {
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

    pub(crate) fn bootstrap_status(&self) -> String {
        match self {
            Self::Ready => "ready",
            Self::Offline(_) => "offline",
            Self::Incompatible { .. } => "incompatible",
            Self::BootstrapError { .. } => "bootstrap_error",
        }
        .to_string()
    }

    pub(crate) fn response_class(&self) -> Option<String> {
        match self {
            Self::Ready => Some("tinybot-bootstrap".to_string()),
            Self::Offline(_) => Some("unreachable".to_string()),
            Self::Incompatible { .. } => Some("incompatible-bootstrap".to_string()),
            Self::BootstrapError { status, .. } => Some(format!("HTTP {status}")),
        }
    }

    pub(crate) fn last_error(&self) -> Option<String> {
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

#[tauri::command]
pub(crate) fn gateway_status(state: State<'_, SharedGateway>) -> GatewayRuntimeStatus {
    current_status(state.inner())
}

#[tauri::command]
pub(crate) fn start_gateway(
    state: State<'_, SharedGateway>,
) -> Result<GatewayRuntimeStatus, String> {
    start_gateway_with_options(state.inner())
}

pub(crate) fn start_gateway_with_options(
    shared: &SharedGateway,
) -> Result<GatewayRuntimeStatus, String> {
    let agent_task_runtime = {
        let mut runtime = lock_runtime(shared);
        runtime.last_error = None;
        append_log(&mut runtime, "Rust native backend active");
        runtime.native_agent_runtime.task_runtime()
    };
    agent_task_runtime.resume_accepting();
    Ok(current_status(shared))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskRuntimeStatus {
    pub(crate) accepting: bool,
    pub(crate) active_runs: usize,
    pub(crate) draining_runs: usize,
}

#[tauri::command]
pub(crate) fn stop_gateway(
    state: State<'_, SharedGateway>,
) -> Result<GatewayRuntimeStatus, String> {
    stop_owned_gateway(state.inner(), true)?;
    Ok(current_status(state.inner()))
}

#[tauri::command]
pub(crate) fn set_gateway_keep_running(
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
                "configured native backend to keep running after desktop exits"
            } else {
                "configured native backend to stop when desktop exits"
            },
        );
    }
    Ok(current_status(state.inner()))
}

pub(crate) fn gateway_exit_policy_preference_path() -> PathBuf {
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

pub(crate) fn native_backend_log_path() -> PathBuf {
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

pub(crate) fn load_gateway_exit_policy(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<GatewayExitPolicyPreference>(&contents).ok())
        .map(|preference| preference.keep_running)
        .unwrap_or(false)
}

pub(crate) fn persist_gateway_exit_policy(path: &Path, keep_running: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create gateway preference directory: {error}"))?;
    }
    let contents = serde_json::to_string_pretty(&GatewayExitPolicyPreference { keep_running })
        .map_err(|error| format!("failed to encode gateway preference: {error}"))?;
    std::fs::write(path, contents)
        .map_err(|error| format!("failed to persist gateway preference: {error}"))
}

pub(crate) fn current_status(shared: &SharedGateway) -> GatewayRuntimeStatus {
    let probe = gateway_bootstrap_probe();
    let http_ok = probe.is_ready();
    let runtime = lock_runtime(shared);
    let worker_status = runtime.experimental_worker.status();
    let agent_task_runtime = runtime.native_agent_runtime.task_runtime();

    let owner = "shell";
    let state = if worker_status.state == WorkerManagerState::Failed || probe.is_conflict_or_error()
    {
        "failed"
    } else {
        "running"
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
        command: RUST_BACKEND_COMMAND,
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
            .or_else(|| {
                if probe.is_conflict_or_error() {
                    probe.last_error()
                } else {
                    None
                }
            }),
        exit_policy,
        bootstrap_status: probe.bootstrap_status(),
        response_class: probe.response_class(),
        recovery_hint: probe.recovery_hint(),
        worker_runtime: gateway_worker_runtime_status(&worker_status),
        agent_tasks: AgentTaskRuntimeStatus {
            accepting: agent_task_runtime.is_accepting(),
            active_runs: agent_task_runtime.active_count(),
            draining_runs: agent_task_runtime.draining_count(),
        },
        route_owner_summary: native_route_owner_summary(),
        webui_route_inventory: native_webui_route_inventory(),
        compatibility_fallback_diagnostics: runtime
            .compatibility_fallbacks
            .iter()
            .cloned()
            .collect(),
    }
}

fn gateway_worker_runtime_status(
    worker_status: &crate::worker_manager::WorkerManagerStatus,
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
        WorkerManagerState::Stopped
        | WorkerManagerState::Starting
        | WorkerManagerState::Stopping => WorkerRuntimeStatus::rust_backend_active(vec![
            crate::worker_protocol::WorkerDiagnosticLine::new(
                "stdout",
                "Rust backend services active",
            ),
        ]),
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

pub(crate) fn classify_bootstrap_response(
    status: Option<u16>,
    response: &str,
) -> GatewayBootstrapProbe {
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

pub(crate) fn stop_owned_gateway(shared: &SharedGateway, explicit: bool) -> Result<(), String> {
    let (experimental_worker, agent_task_runtime, mcp_runtime) = {
        let runtime = lock_runtime(shared);
        if !explicit && runtime.keep_background {
            drop(runtime);
            push_log(shared, "leaving native backend running in background");
            return Ok(());
        }
        (
            runtime.experimental_worker.clone(),
            runtime.native_agent_runtime.task_runtime(),
            runtime.mcp_runtime.clone(),
        )
    };

    let mut failures = Vec::new();
    let task_report = agent_task_runtime.shutdown(Duration::from_secs(5));
    if task_report.timed_out {
        failures.push(format!(
            "agent task cleanup timed out for runs: {}",
            task_report.cleanup_pending_runs.join(", ")
        ));
    }
    if let Err(error) = tauri::async_runtime::block_on(mcp_runtime.shutdown()) {
        failures.push(format!("failed to stop MCP runtime: {}", error.message));
    }
    let was_running = experimental_worker.status().state == WorkerManagerState::Running;
    if let Err(error) = experimental_worker.stop() {
        failures.push(format!("failed to stop background worker: {error:?}"));
    }
    if was_running {
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, "stopped background worker");
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
