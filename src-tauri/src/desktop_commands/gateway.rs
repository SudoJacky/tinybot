use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use tauri::State;

use crate::desktop_logging::{gateway_runtime_logs, read_native_backend_log_tail};
use crate::native_backend_contract::{
    native_route_owner_summary, native_webui_route_inventory,
    NativeCompatibilityFallbackDiagnostic, NativeRouteInventoryEntry, NativeRouteOwnerSummary,
};
use crate::runtime::lifecycle::{RuntimeLifecycle, RuntimeLifecycleStatus};
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
    pub(crate) lifecycle: RuntimeLifecycleStatus,
}

#[derive(Deserialize, Serialize)]
struct GatewayExitPolicyPreference {
    keep_running: bool,
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
    start_gateway_with_workspace_root(shared, crate::native_backend_workspace_root())
}

pub(crate) fn start_gateway_with_workspace_root(
    shared: &SharedGateway,
    workspace_root: PathBuf,
) -> Result<GatewayRuntimeStatus, String> {
    let (agent_task_runtime, shell_runtime, startup_reconciled) = {
        let runtime = lock_runtime(shared);
        (
            runtime.native_agent_runtime.task_runtime(),
            runtime.native_agent_runtime.shell_runtime(),
            runtime.lifecycle_status.startup_reconciled,
        )
    };
    if !startup_reconciled {
        agent_task_runtime.pause_accepting();
        match RuntimeLifecycle::reconcile_startup(&workspace_root) {
            Ok(report) => {
                let report_line = serde_json::to_string(&report)
                    .expect("startup recovery report should serialize");
                {
                    let mut runtime = lock_runtime(shared);
                    runtime.last_error = None;
                    runtime.lifecycle_status.record_startup_recovery(report);
                }
                push_log(shared, &format!("runtime startup recovery {report_line}"));
            }
            Err(error) => {
                let message = format!("runtime startup recovery failed: {}", error.message);
                {
                    let mut runtime = lock_runtime(shared);
                    runtime.last_error = Some(message.clone());
                    runtime
                        .lifecycle_status
                        .record_startup_failure(message.clone());
                }
                push_log(shared, &message);
                return Err(message);
            }
        }
    }
    if let Err(error) = shell_runtime.resume_accepting() {
        let message = format!("runtime resume failed: {}", error.message);
        {
            let mut runtime = lock_runtime(shared);
            runtime.last_error = Some(message.clone());
            runtime
                .lifecycle_status
                .record_resume_failure(message.clone());
        }
        push_log(shared, &message);
        return Err(message);
    }
    agent_task_runtime.resume_accepting();
    push_log(shared, "Rust native backend active");
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
    let runtime = lock_runtime(shared);
    let worker_status = runtime.experimental_worker.status();
    let agent_task_runtime = runtime.native_agent_runtime.task_runtime();

    let owner = "shell";
    let state = if runtime.last_error.is_some() || worker_status.state == WorkerManagerState::Failed
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
        http_ok: false,
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
            .or_else(|| worker_status.last_error.clone()),
        exit_policy,
        bootstrap_status: "not_required".to_string(),
        response_class: Some("tauri-native".to_string()),
        recovery_hint: None,
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
        lifecycle: runtime.lifecycle_status.clone(),
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

pub(crate) fn stop_owned_gateway(shared: &SharedGateway, explicit: bool) -> Result<(), String> {
    stop_owned_gateway_with_timeout(shared, explicit, Duration::from_secs(5))
}

pub(crate) async fn stop_owned_gateway_for_window_close(
    shared: SharedGateway,
    explicit: bool,
) -> Result<(), String> {
    stop_owned_gateway_async_with_timeout(&shared, explicit, Duration::from_secs(5)).await
}

pub(crate) fn stop_owned_gateway_with_timeout(
    shared: &SharedGateway,
    explicit: bool,
    timeout: Duration,
) -> Result<(), String> {
    tauri::async_runtime::block_on(stop_owned_gateway_async_with_timeout(
        shared, explicit, timeout,
    ))
}

async fn stop_owned_gateway_async_with_timeout(
    shared: &SharedGateway,
    explicit: bool,
    timeout: Duration,
) -> Result<(), String> {
    let (lifecycle, worker_was_running) = {
        let runtime = lock_runtime(shared);
        if !explicit && runtime.keep_background {
            drop(runtime);
            push_log(shared, "leaving native backend running in background");
            return Ok(());
        }
        (
            RuntimeLifecycle::new(
                runtime.native_agent_runtime.task_runtime(),
                runtime.native_agent_runtime.shell_runtime(),
                runtime.mcp_runtime.clone(),
                runtime.subagent_manager.clone(),
                runtime.experimental_worker.clone(),
            ),
            runtime.experimental_worker.status().state == WorkerManagerState::Running,
        )
    };
    let report = lifecycle.shutdown(timeout).await;
    let report_line =
        serde_json::to_string(&report).expect("runtime shutdown report should serialize");
    let failures = report
        .failures
        .iter()
        .map(|failure| failure.message.clone())
        .collect::<Vec<_>>();
    {
        let mut runtime = lock_runtime(shared);
        runtime.last_error = failures.first().cloned();
        runtime.lifecycle_status.record_shutdown(report);
    }
    push_log(shared, &format!("runtime shutdown {report_line}"));
    if worker_was_running {
        push_log(shared, "stopped background worker");
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GatewayRuntime;
    use std::sync::{Arc, Mutex};

    #[test]
    fn window_close_shutdown_does_not_nest_async_runtime() {
        let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

        let result =
            tauri::async_runtime::block_on(stop_owned_gateway_for_window_close(shared, false));

        assert!(result.is_ok(), "{result:?}");
    }
}
