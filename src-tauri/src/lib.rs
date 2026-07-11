#![recursion_limit = "256"]

use serde::Serialize;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, Runtime, State, WindowEvent};

mod adapters;
pub mod agent_loop_runtime_protocol;
pub mod config_store;
pub mod desktop_commands;
pub mod desktop_cron;
pub mod desktop_files;
#[cfg(test)]
pub mod desktop_heartbeat;
pub mod desktop_logging;
pub mod desktop_menu;
pub mod native_agent_bridge;
pub mod native_backend_contract;
pub mod native_provider_runtime;
mod runtime;
pub mod settings_registry;
mod system_prompt;
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
pub mod worker_permission_profile;
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
pub mod worker_thread;
pub mod worker_thread_log;
pub mod worker_tool_executor;
pub mod worker_tool_registry;
pub mod worker_workspace;

use crate::config_store::ConfigDiagnosticCode;
#[cfg(test)]
use crate::desktop_commands::agent::{
    build_worker_background_subagent_enqueue_input_request,
    build_worker_background_trace_get_artifact_request,
    build_worker_background_trace_get_delegate_trace_request,
    build_worker_background_trace_list_request,
    worker_background_subagent_enqueue_input_with_options,
    worker_background_trace_append_with_options, worker_background_trace_list_with_options,
    worker_cancel_agent_with_options, worker_echo_agent_with_options,
    worker_resolve_thread_approval_with_options, worker_restore_agent_checkpoint_with_options,
    worker_run_agent_with_options, worker_submit_thread_form_with_options,
    worker_submit_thread_turn_with_options, worker_task_plan_delete_with_options,
    worker_task_plan_get_with_options, worker_task_plan_list_with_options,
    worker_task_plan_save_with_options, WorkerBackgroundSubagentInputInput,
    WorkerBackgroundTraceAppendInput, WorkerBackgroundTraceGetArtifactInput,
    WorkerBackgroundTraceGetDelegateTraceInput, WorkerBackgroundTraceListInput,
    WorkerResolveThreadApprovalInput, WorkerSubmitThreadFormInput, WorkerSubmitThreadTurnInput,
    WorkerTaskPlanListInput,
};
use crate::desktop_commands::agent::{
    worker_background_subagent_enqueue_input, worker_background_trace_append,
    worker_background_trace_get_artifact, worker_background_trace_get_delegate_trace,
    worker_background_trace_list, worker_cancel_agent, worker_echo_agent,
    worker_resolve_thread_approval, worker_restore_agent_checkpoint, worker_resume_agent_approval,
    worker_run_agent, worker_run_agent_input, worker_subagent_cancel, worker_subagent_close,
    worker_subagent_list, worker_subagent_query, worker_subagent_resume,
    worker_subagent_send_input, worker_subagent_spawn, worker_subagent_wait,
    worker_submit_agent_form, worker_submit_thread_form, worker_submit_thread_turn,
    worker_task_plan_delete, worker_task_plan_get, worker_task_plan_list, worker_task_plan_save,
};
use crate::desktop_commands::config::{
    apply_config_operations, apply_config_operations_to_path, apply_config_patch_result,
    apply_config_patch_result_to_path, config_editor_snapshot_from_path,
    default_tinybot_config_path, default_tinybot_workspace_root, ensure_default_config_file,
    experimental_worker_config_snapshot, experimental_worker_config_snapshot_from_path,
    experimental_worker_default_config_snapshot, get_config_editor_snapshot, get_settings_snapshot,
    get_settings_snapshot_from_path, native_backend_workspace_root,
    resolve_native_backend_workspace_root_from_config_path,
};
use crate::desktop_commands::gateway::{
    gateway_exit_policy_preference_path, gateway_status, load_gateway_exit_policy,
    native_backend_log_path, set_gateway_keep_running, start_gateway,
    start_gateway_with_workspace_root, stop_gateway, stop_owned_gateway,
};
use crate::desktop_commands::knowledge::{
    worker_knowledge_add_document, worker_knowledge_add_document_with_options,
    worker_knowledge_delete_document, worker_knowledge_delete_document_with_options,
    worker_knowledge_document, worker_knowledge_document_with_options, worker_knowledge_documents,
    worker_knowledge_documents_with_options, worker_knowledge_graph,
    worker_knowledge_graph_with_options, worker_knowledge_job, worker_knowledge_job_with_options,
    worker_knowledge_rebuild_index, worker_knowledge_rebuild_index_with_options,
    worker_knowledge_stats, worker_knowledge_stats_with_options, WorkerKnowledgeDocumentsInput,
    WorkerKnowledgeGraphInput,
};
use crate::desktop_commands::session::{
    worker_agent_run_runtime_state, worker_agent_run_runtime_state_with_options,
    worker_agent_runs_list, worker_agent_runs_list_with_options, worker_session_branch,
    worker_session_branch_with_options, worker_session_clear, worker_session_clear_temporary_files,
    worker_session_clear_temporary_files_with_options, worker_session_clear_with_options,
    worker_session_delete, worker_session_delete_with_options, worker_session_messages,
    worker_session_messages_with_options, worker_session_patch, worker_session_patch_with_options,
    worker_session_task_progress, worker_session_task_progress_with_options,
    worker_session_temporary_files, worker_session_temporary_files_with_options,
    worker_session_upload_temporary_file, worker_session_upload_temporary_file_with_options,
    worker_sessions_list, worker_sessions_list_with_options,
};
#[cfg(test)]
use crate::desktop_commands::skills::{
    build_worker_skills_create_request, build_worker_skills_delete_request,
    build_worker_skills_detail_request, build_worker_skills_list_request,
    build_worker_skills_update_request, build_worker_skills_validate_request,
};
use crate::desktop_commands::skills::{
    worker_skills_create, worker_skills_delete, worker_skills_detail, worker_skills_list,
    worker_skills_list_with_options, worker_skills_update, worker_skills_validate,
};
use crate::desktop_commands::thread::{
    worker_thread_activity, worker_thread_agent_registry, worker_thread_apply_op,
    worker_thread_archive, worker_thread_continue_turn, worker_thread_create, worker_thread_delete,
    worker_thread_events, worker_thread_fork, worker_thread_interrupt, worker_thread_read,
    worker_thread_request_with_options, worker_thread_restore_checkpoint, worker_thread_resume,
    worker_thread_search, worker_thread_start_turn, worker_thread_status, worker_thread_unarchive,
    worker_thread_update_metadata, worker_threads_list,
};
#[cfg(test)]
use crate::desktop_commands::transport::{
    build_worker_transport_websocket_run_input_request, native_websocket_transport_result,
    worker_transport_dispatch_websocket_message_with_options,
    WorkerTransportWebSocketDispatchInput, WorkerTransportWebSocketDispatchOptions,
};
use crate::desktop_commands::transport::{
    worker_channel_dispatch_inbound, worker_channel_login, worker_channel_start,
    worker_channel_status, worker_channel_stop, worker_transport_dispatch_websocket_message,
    worker_transport_gateway_frame, worker_transport_websocket_message,
};
use crate::desktop_commands::webui::{
    worker_cowork_route, worker_probe_status, worker_webui_route,
};
#[cfg(test)]
use crate::desktop_commands::webui::{
    worker_cowork_route_with_options, worker_webui_route_timeout, worker_webui_route_with_options,
    WorkerCoworkRouteInput, WorkerWebuiRouteInput,
};
use crate::desktop_commands::workspace::{
    worker_workspace_file, worker_workspace_file_with_options, worker_workspace_files,
    worker_workspace_files_with_options, worker_workspace_put_file,
    worker_workspace_put_file_with_options,
};
use crate::desktop_cron::{
    start_worker_cron_timer, stop_worker_cron_timer, worker_cron_dispatch_due,
};
use crate::desktop_files::{pick_upload_file, reveal_workspace_file, save_export_file};
use crate::desktop_logging::append_native_backend_log_line;
use crate::desktop_menu::{
    install_desktop_application_menu, is_desktop_menu_command, DesktopMenuCommandPayload,
};
use crate::native_agent_bridge::{native_agent_run_record, persist_native_agent_run_start};
use crate::native_backend_contract::NativeCompatibilityFallbackDiagnostic;
use crate::runtime::lifecycle::RuntimeLifecycleStatus;
use crate::runtime::mcp::McpRuntime;
use crate::system_prompt::{load_or_create_system_prompt, SYSTEM_PROMPT_FILE_NAME};
use crate::worker_agent_runtime::NativeAgentRuntimeServices;
#[cfg(test)]
use crate::worker_agent_runtime::NativeAgentTraceSink;
use crate::worker_capability::default_desktop_capability_policy;
use crate::worker_manager::{
    WorkerCommandSpec, WorkerManager, WorkerManagerEvent, WorkerManagerState,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::worker_rpc::WorkerRpcRouter;
use crate::worker_subagent_manager::SubagentThreadManager;

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
const WORKER_CRON_TIMER_MAX_POLL: Duration = Duration::from_secs(30);
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
    cron_dispatch_running: Arc<AtomicBool>,
    cron_timer_started: Arc<AtomicBool>,
    cron_timer_stop: Arc<AtomicBool>,
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
            cron_dispatch_running: Arc::new(AtomicBool::new(false)),
            cron_timer_started: Arc::new(AtomicBool::new(false)),
            cron_timer_stop: Arc::new(AtomicBool::new(false)),
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
    shell_runtime: crate::worker_shell::WorkerShellRuntime,
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(gateway_state)
        .setup(move |app| {
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
            start_worker_cron_timer(&setup_state);
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
            worker_echo_agent,
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
            worker_sessions_list,
            worker_session_messages,
            worker_agent_runs_list,
            worker_agent_run_runtime_state,
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
            worker_subagent_resume,
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
            worker_resolve_thread_approval,
            worker_submit_thread_form,
            worker_cron_dispatch_due,
            get_settings_snapshot,
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
mod tests;
