#![recursion_limit = "256"]

use serde::Serialize;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, Runtime, State, WindowEvent};

#[cfg(test)]
use std::path::Path;

mod adapters;
mod agent;
mod automation;
mod collaboration;
mod config;
mod context_checkpoint_lineage;
mod context_checkpoint_lock;
pub mod desktop_commands;
pub mod desktop_files;
#[cfg(test)]
pub mod desktop_heartbeat;
pub mod desktop_logging;
pub mod desktop_menu;
mod desktop_update;
mod mcp_capability_catalog;
mod memory;
pub mod native_backend_contract;
mod native_browser;
mod protocol;
mod rpc;
mod runtime;
mod skill_definition;
mod skill_resolver;
mod storage;
mod system_prompt;
mod threads;
mod tools;
mod transport;
mod workspace;

#[cfg(test)]
use crate::agent::bridge::{native_agent_run_record, persist_native_agent_run_start};
use crate::agent::runtime::NativeAgentRuntimeServices;
#[cfg(test)]
use crate::agent::runtime::NativeAgentTraceSink;
use crate::collaboration::subagents::SubagentThreadManager;
#[cfg(test)]
use crate::config::application::{
    apply_config_operations_to_path, apply_config_patch_result_to_path,
    config_editor_snapshot_from_path, default_tinybot_workspace_root,
    experimental_worker_config_snapshot_from_path, experimental_worker_default_config_snapshot,
    get_settings_snapshot_from_path,
};
use crate::config::application::{
    default_tinybot_config_path, ensure_default_config_file, experimental_worker_config_snapshot,
    native_backend_workspace_root, resolve_native_backend_workspace_root_from_config_path,
};
use crate::config::store::ConfigDiagnosticCode;
#[cfg(test)]
use crate::desktop_commands::agent::{
    build_worker_background_subagent_enqueue_input_request,
    build_worker_background_trace_get_artifact_request,
    build_worker_background_trace_get_delegate_trace_request,
    build_worker_background_trace_list_request,
    worker_background_subagent_enqueue_input_with_options,
    worker_background_trace_append_with_options, worker_background_trace_list_with_options,
    worker_restore_agent_checkpoint_with_options, worker_run_agent_with_options,
    worker_submit_thread_turn_with_options, worker_task_plan_delete_with_options,
    worker_task_plan_get_with_options, worker_task_plan_list_with_options,
    worker_task_plan_save_with_options, WorkerBackgroundSubagentInputInput,
    WorkerBackgroundTraceAppendInput, WorkerBackgroundTraceGetArtifactInput,
    WorkerBackgroundTraceGetDelegateTraceInput, WorkerBackgroundTraceListInput,
    WorkerSubmitThreadTurnInput, WorkerTaskPlanListInput,
};
use crate::desktop_commands::agent::{
    worker_background_subagent_enqueue_input, worker_background_trace_append,
    worker_background_trace_get_artifact, worker_background_trace_get_delegate_trace,
    worker_background_trace_list, worker_cancel_agent, worker_resolve_thread_approval,
    worker_restore_agent_checkpoint, worker_resume_agent_approval, worker_run_agent,
    worker_run_agent_input, worker_subagent_cancel, worker_subagent_close, worker_subagent_list,
    worker_subagent_query, worker_subagent_resume, worker_subagent_send_input,
    worker_subagent_spawn, worker_subagent_wait, worker_submit_agent_form,
    worker_submit_thread_form, worker_submit_thread_turn, worker_task_plan_delete,
    worker_task_plan_get, worker_task_plan_list, worker_task_plan_save,
};
use crate::desktop_commands::config::{
    apply_config_operations, apply_config_patch_result, get_config_editor_snapshot,
    get_settings_snapshot,
};
#[cfg(test)]
use crate::desktop_commands::gateway::stop_owned_gateway;
use crate::desktop_commands::gateway::{
    gateway_exit_policy_preference_path, gateway_status, load_gateway_exit_policy,
    native_backend_log_path, set_gateway_keep_running, start_gateway,
    start_gateway_with_workspace_root, stop_gateway, stop_owned_gateway_for_window_close,
};
use crate::desktop_commands::session::{
    worker_agent_run_runtime_state, worker_agent_runs_list, worker_session_branch,
    worker_session_clear, worker_session_clear_temporary_files, worker_session_delete,
    worker_session_effective_capabilities, worker_session_messages, worker_session_patch,
    worker_session_task_progress, worker_session_temporary_files,
    worker_session_upload_temporary_file, worker_sessions_list,
};
#[cfg(test)]
use crate::desktop_commands::session::{
    worker_agent_run_runtime_state_with_options, worker_agent_runs_list_with_options,
    worker_session_branch_with_options, worker_session_clear_temporary_files_with_options,
    worker_session_clear_with_options, worker_session_delete_with_options,
    worker_session_messages_with_options, worker_session_patch_with_options,
    worker_session_task_progress_with_options, worker_session_temporary_files_with_options,
    worker_session_upload_temporary_file_with_options, worker_sessions_list_with_options,
};
#[cfg(test)]
use crate::desktop_commands::skills::{
    build_worker_skills_create_request, build_worker_skills_delete_request,
    build_worker_skills_detail_request, build_worker_skills_list_request,
    build_worker_skills_update_request, build_worker_skills_validate_request,
    worker_skills_list_with_options,
};
use crate::desktop_commands::skills::{
    worker_skills_create, worker_skills_delete, worker_skills_detail, worker_skills_list,
    worker_skills_update, worker_skills_validate,
};
#[cfg(test)]
use crate::desktop_commands::thread::worker_thread_request_with_options;
use crate::desktop_commands::thread::{
    worker_thread_activity, worker_thread_agent_registry, worker_thread_apply_op,
    worker_thread_archive, worker_thread_continue_turn, worker_thread_create, worker_thread_delete,
    worker_thread_events, worker_thread_fork, worker_thread_interrupt, worker_thread_read,
    worker_thread_restore_checkpoint, worker_thread_resume, worker_thread_search,
    worker_thread_start_turn, worker_thread_status, worker_thread_unarchive,
    worker_thread_update_metadata, worker_threads_list,
};
use crate::desktop_commands::transport::worker_dispatch_tinyos_host_command;
#[cfg(test)]
use crate::desktop_commands::transport::{
    native_websocket_transport_result, validate_tinyos_host_command_frame,
    worker_transport_dispatch_websocket_message_with_options,
    WorkerTransportWebSocketDispatchInput,
};
use crate::desktop_commands::webui::{
    worker_cowork_route, worker_probe_status, worker_webui_route,
};
#[cfg(test)]
use crate::desktop_commands::webui::{
    worker_cowork_route_with_options, worker_webui_route_with_options, WorkerCoworkRouteInput,
    WorkerWebuiRouteInput,
};
use crate::desktop_commands::workspace::{
    worker_workspace_directory, worker_workspace_file, worker_workspace_file_chunk,
    worker_workspace_files, worker_workspace_put_file,
};
#[cfg(test)]
use crate::desktop_commands::workspace::{
    worker_workspace_file_with_options, worker_workspace_files_with_options,
    worker_workspace_put_file_with_options,
};
use crate::desktop_files::{
    pick_chat_files, pick_upload_file, reveal_workspace_file, save_export_file,
};
use crate::desktop_logging::append_native_backend_log_line;
use crate::desktop_menu::{
    install_desktop_application_menu, is_desktop_menu_command, DesktopMenuCommandPayload,
};
use crate::native_backend_contract::NativeCompatibilityFallbackDiagnostic;
use crate::native_browser::{
    browser_activate_tab, browser_back, browser_capabilities, browser_close_session,
    browser_close_tab, browser_create_session, browser_create_tab, browser_delete_profile,
    browser_forward, browser_interact, browser_metrics, browser_navigate, browser_observe,
    browser_reload, browser_resolve_policy_request, browser_restart_tab, browser_snapshot,
    browser_stop, browser_update_surface,
};
use crate::protocol::capability::default_desktop_capability_policy;
#[cfg(test)]
use crate::protocol::request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::protocol::WorkerRequest;
use crate::rpc::WorkerRpcRouter;
use crate::runtime::lifecycle::RuntimeLifecycleStatus;
use crate::runtime::mcp::McpRuntime;
use crate::system_prompt::{load_or_create_system_prompt, SYSTEM_PROMPT_FILE_NAME};
#[cfg(test)]
use crate::transport::stdio_worker::manager::{WorkerCommandSpec, WorkerManagerState};
use crate::transport::stdio_worker::manager::{WorkerManager, WorkerManagerEvent};

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

#[tauri::command]
fn record_renderer_diagnostic(
    input: serde_json::Value,
    state: State<'_, SharedGateway>,
) -> Result<(), String> {
    record_renderer_diagnostic_with_options(state.inner(), input)
}

pub(crate) type SharedGateway = Arc<Mutex<GatewayRuntime>>;
const WORKER_WEBUI_ROUTE_TIMEOUT: Duration = Duration::from_secs(10);
const NATIVE_BACKEND_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const NATIVE_BACKEND_LOG_TAIL_LINES: usize = 100;

pub(crate) struct GatewayRuntime {
    experimental_worker: WorkerManager,
    native_agent_runtime: NativeAgentRuntimeServices,
    mcp_runtime: McpRuntime,
    subagent_manager: SubagentThreadManager,
    lifecycle_status: RuntimeLifecycleStatus,
    logs: VecDeque<String>,
    compatibility_fallbacks: VecDeque<NativeCompatibilityFallbackDiagnostic>,
    persistent_log_path: PathBuf,
    last_error: Option<String>,
    keep_background: bool,
}

impl Default for GatewayRuntime {
    fn default() -> Self {
        let subagent_manager = SubagentThreadManager::default();
        let mcp_runtime = McpRuntime::new();
        Self {
            experimental_worker: WorkerManager::new(200),
            native_agent_runtime: NativeAgentRuntimeServices::with_subagent_manager(
                subagent_manager.clone(),
            )
            .with_mcp_runtime(mcp_runtime.clone()),
            mcp_runtime,
            subagent_manager,
            lifecycle_status: RuntimeLifecycleStatus::default(),
            logs: VecDeque::with_capacity(200),
            compatibility_fallbacks: VecDeque::with_capacity(50),
            persistent_log_path: native_backend_log_path(),
            last_error: None,
            keep_background: false,
        }
    }
}

pub(crate) fn call_rust_state_service(
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

pub(crate) fn call_rust_state_service_with_mcp_runtime(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    mcp_runtime: McpRuntime,
    shell_runtime: crate::tools::shell::WorkerShellRuntime,
    subagent_manager: SubagentThreadManager,
    request: WorkerRequest,
    label: &str,
) -> Result<serde_json::Value, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot)
        .with_mcp_runtime(mcp_runtime)
        .with_shell_runtime(shell_runtime)
        .with_subagent_manager(subagent_manager);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{label} failed: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{label} failed: missing response result"))
}

pub(crate) fn experimental_worker_router(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> WorkerRpcRouter {
    WorkerRpcRouter::new_persistent_sessions(
        workspace_root,
        config_snapshot,
        vec![],
        200,
        default_desktop_capability_policy(),
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

fn record_renderer_diagnostic_with_options(
    shared: &SharedGateway,
    input: serde_json::Value,
) -> Result<(), String> {
    let line = renderer_diagnostic_log_line(input);
    let log_path = {
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, &format!("renderer {line}"));
        runtime.persistent_log_path.clone()
    };
    append_native_backend_log_line(&log_path, NATIVE_BACKEND_LOG_MAX_BYTES, "renderer", &line)
}

fn renderer_diagnostic_log_line(input: serde_json::Value) -> String {
    let line = serde_json::to_string(&input)
        .unwrap_or_else(|_| "{\"type\":\"renderer.diagnostic.serialize_failed\"}".to_string());
    const MAX_RENDERER_DIAGNOSTIC_LOG_LINE: usize = 16 * 1024;
    if line.len() <= MAX_RENDERER_DIAGNOSTIC_LOG_LINE {
        return line;
    }
    truncate_utf8_with_ellipsis(line, MAX_RENDERER_DIAGNOSTIC_LOG_LINE)
}

fn truncate_utf8_with_ellipsis(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let boundary = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or(0);
    value.truncate(boundary);
    format!("{value}...")
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

pub(crate) fn repo_root() -> PathBuf {
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
    let close_started = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(gateway_state)
        .setup(move |app| {
            let browser_runtime = native_browser::create_runtime(app.handle())?;
            {
                let mut runtime = lock_runtime(&setup_state);
                runtime.native_agent_runtime = runtime
                    .native_agent_runtime
                    .clone()
                    .with_browser_runtime(browser_runtime.clone());
            }
            app.manage(browser_runtime);
            install_desktop_application_menu(app)?;
            match ensure_default_config_file(&default_tinybot_config_path()) {
                Ok(diagnostics) => {
                    for diagnostic in diagnostics {
                        if diagnostic.code == ConfigDiagnosticCode::DefaultConfigCreateFailed {
                            push_log(&setup_state, &diagnostic.message);
                        }
                    }
                }
                Err(error) => {
                    push_log(
                        &setup_state,
                        &format!("failed to initialize default config: {error}"),
                    );
                }
            }
            let workspace_root = native_backend_workspace_root();
            let system_prompt_path = workspace_root.join(SYSTEM_PROMPT_FILE_NAME);
            let system_prompt_existed = system_prompt_path.exists();
            match load_or_create_system_prompt(&workspace_root) {
                Ok(_) if !system_prompt_existed => push_log(
                    &setup_state,
                    &format!(
                        "default system prompt created at {}",
                        system_prompt_path.display()
                    ),
                ),
                Ok(_) => {}
                Err(error) => push_log(
                    &setup_state,
                    &format!("failed to initialize system prompt: {error}"),
                ),
            }
            if let Err(error) =
                start_gateway_with_workspace_root(&setup_state, workspace_root.clone())
            {
                push_log(
                    &setup_state,
                    &format!(
                        "native agent runtime remains paused because startup recovery failed: {error}"
                    ),
                );
            }
            let app_handle = app.handle().clone();
            let log_state = setup_state.clone();
            let runtime = lock_runtime(&setup_state);
            runtime.experimental_worker.set_event_sink(move |event| {
                record_worker_manager_event_for_logs(&log_state, &event);
                emit_worker_manager_frontend_event(&app_handle, event);
            });
            drop(runtime);
            #[cfg(windows)]
            desktop_update::spawn_startup_auto_update(app.handle().clone(), setup_state.clone());
            push_log(
                &setup_state,
                "Rust backend startup skipped legacy heartbeat worker",
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            record_renderer_diagnostic,
            gateway_status,
            start_gateway,
            stop_gateway,
            set_gateway_keep_running,
            worker_probe_status,
            worker_run_agent,
            worker_run_agent_input,
            worker_submit_thread_turn,
            worker_skills_list,
            worker_skills_detail,
            worker_skills_create,
            worker_skills_update,
            worker_skills_delete,
            worker_skills_validate,
            worker_workspace_files,
            worker_workspace_file,
            worker_workspace_put_file,
            worker_workspace_directory,
            worker_workspace_file_chunk,
            worker_sessions_list,
            worker_session_messages,
            worker_agent_runs_list,
            worker_agent_run_runtime_state,
            worker_session_effective_capabilities,
            worker_session_temporary_files,
            worker_session_upload_temporary_file,
            worker_session_clear_temporary_files,
            worker_session_delete,
            worker_session_patch,
            worker_session_branch,
            worker_session_clear,
            worker_session_task_progress,
            worker_thread_create,
            worker_thread_read,
            worker_thread_resume,
            worker_threads_list,
            worker_thread_search,
            worker_thread_activity,
            worker_thread_status,
            worker_thread_update_metadata,
            worker_thread_agent_registry,
            worker_thread_start_turn,
            worker_thread_continue_turn,
            worker_thread_interrupt,
            worker_thread_apply_op,
            worker_thread_archive,
            worker_thread_unarchive,
            worker_thread_delete,
            worker_thread_fork,
            worker_thread_events,
            worker_thread_restore_checkpoint,
            worker_cowork_route,
            worker_webui_route,
            worker_dispatch_tinyos_host_command,
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
            worker_subagent_resume,
            worker_task_plan_list,
            worker_task_plan_get,
            worker_task_plan_save,
            worker_task_plan_delete,
            worker_submit_agent_form,
            worker_resume_agent_approval,
            worker_resolve_thread_approval,
            worker_submit_thread_form,
            get_settings_snapshot,
            get_config_editor_snapshot,
            apply_config_patch_result,
            apply_config_operations,
            pick_chat_files,
            pick_upload_file,
            reveal_workspace_file,
            save_export_file
            ,browser_capabilities
            ,browser_metrics
            ,browser_snapshot
            ,browser_create_session
            ,browser_close_session
            ,browser_create_tab
            ,browser_activate_tab
            ,browser_close_tab
            ,browser_navigate
            ,browser_back
            ,browser_forward
            ,browser_reload
            ,browser_stop
            ,browser_restart_tab
            ,browser_update_surface
            ,browser_observe
            ,browser_interact
            ,browser_resolve_policy_request
            ,browser_delete_profile
        ])
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !close_started.swap(true, Ordering::AcqRel) {
                    api.prevent_close();
                    eprintln!("desktop_window_close_cleanup_started");
                    let browser_runtime = window
                        .app_handle()
                        .state::<native_browser::SharedBrowserRuntime>()
                        .inner()
                        .clone();
                    let close_state = close_state.clone();
                    let close_started = close_started.clone();
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = browser_runtime.shutdown().await {
                            eprintln!("desktop_window_close_browser_cleanup_failed error={error}");
                        } else {
                            eprintln!("desktop_window_close_browser_cleanup_completed");
                        }
                        if let Err(error) =
                            stop_owned_gateway_for_window_close(close_state, false).await
                        {
                            eprintln!("desktop_window_close_gateway_cleanup_failed error={error}");
                        } else {
                            eprintln!("desktop_window_close_gateway_cleanup_completed");
                        }
                        if let Err(error) = window.destroy() {
                            close_started.store(false, Ordering::Release);
                            eprintln!("desktop_window_close_destroy_failed error={error}");
                        } else {
                            eprintln!("desktop_window_close_destroy_completed");
                        }
                    });
                } else {
                    api.prevent_close();
                }
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

#[cfg(feature = "native-browser-integration")]
pub fn run_native_browser_integration() -> Result<(), String> {
    #[cfg(windows)]
    {
        native_browser::integration::run()
    }
    #[cfg(not(windows))]
    {
        Err("The native browser integration harness is available only on Windows".to_string())
    }
}

#[cfg(test)]
mod tests;
