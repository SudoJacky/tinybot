use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager, State, WindowEvent};

use crate::config::application::{
    default_tinybot_config_path, ensure_default_config_file, native_backend_workspace_root,
};
use crate::config::store::ConfigDiagnosticCode;
use crate::desktop_commands::gateway::{
    gateway_exit_policy_preference_path, load_gateway_exit_policy,
    start_gateway_with_workspace_root, stop_owned_gateway_for_window_close,
};
use crate::native_browser;
use crate::system_prompt::{load_or_create_system_prompt, SYSTEM_PROMPT_FILE_NAME};

use super::logging::append_native_backend_log_line;
use super::menu::{
    install_desktop_application_menu, is_desktop_menu_command, DesktopMenuCommandPayload,
};
use super::state::{
    append_log, lock_runtime, push_log, GatewayRuntime, SharedGateway, NATIVE_BACKEND_LOG_MAX_BYTES,
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

#[tauri::command]
fn record_renderer_diagnostic(
    input: serde_json::Value,
    state: State<'_, SharedGateway>,
) -> Result<(), String> {
    record_renderer_diagnostic_with_options(state.inner(), input)
}

pub(crate) fn record_renderer_diagnostic_with_options(
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

pub(crate) fn truncate_utf8_with_ellipsis(mut value: String, max_bytes: usize) -> String {
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

pub(crate) fn run() {
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
            #[cfg(windows)]
            super::update::spawn_startup_auto_update(app.handle().clone(), setup_state.clone());
            push_log(
                &setup_state,
                "Rust backend startup skipped legacy heartbeat worker",
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            record_renderer_diagnostic,
            crate::desktop_commands::gateway::gateway_status,
            crate::desktop_commands::gateway::start_gateway,
            crate::desktop_commands::gateway::stop_gateway,
            crate::desktop_commands::gateway::set_gateway_keep_running,
            crate::desktop_commands::webui::worker_probe_status,
            crate::desktop_commands::agent::worker_run_agent,
            crate::desktop_commands::agent::worker_run_agent_input,
            crate::desktop_commands::agent::worker_submit_thread_turn,
            crate::desktop_commands::skills::worker_skills_list,
            crate::desktop_commands::skills::worker_skills_detail,
            crate::desktop_commands::skills::worker_skills_create,
            crate::desktop_commands::skills::worker_skills_update,
            crate::desktop_commands::skills::worker_skills_delete,
            crate::desktop_commands::skills::worker_skills_validate,
            crate::desktop_commands::workspace::worker_workspace_files,
            crate::desktop_commands::workspace::worker_workspace_file,
            crate::desktop_commands::workspace::worker_workspace_put_file,
            crate::desktop_commands::workspace::worker_workspace_directory,
            crate::desktop_commands::workspace::worker_workspace_file_chunk,
            crate::desktop_commands::session::worker_sessions_list,
            crate::desktop_commands::session::worker_session_messages,
            crate::desktop_commands::session::worker_agent_runs_list,
            crate::desktop_commands::session::worker_agent_run_runtime_state,
            crate::desktop_commands::session::worker_session_effective_capabilities,
            crate::desktop_commands::session::worker_session_temporary_files,
            crate::desktop_commands::session::worker_session_upload_temporary_file,
            crate::desktop_commands::session::worker_session_clear_temporary_files,
            crate::desktop_commands::session::worker_session_delete,
            crate::desktop_commands::session::worker_session_patch,
            crate::desktop_commands::session::worker_session_branch,
            crate::desktop_commands::session::worker_session_clear,
            crate::desktop_commands::session::worker_session_task_progress,
            crate::desktop_commands::thread::worker_thread_create,
            crate::desktop_commands::thread::worker_thread_read,
            crate::desktop_commands::thread::worker_thread_resume,
            crate::desktop_commands::thread::worker_threads_list,
            crate::desktop_commands::thread::worker_thread_search,
            crate::desktop_commands::thread::worker_thread_activity,
            crate::desktop_commands::thread::worker_thread_status,
            crate::desktop_commands::thread::worker_thread_update_metadata,
            crate::desktop_commands::thread::worker_thread_agent_registry,
            crate::desktop_commands::thread::worker_thread_start_turn,
            crate::desktop_commands::thread::worker_thread_continue_turn,
            crate::desktop_commands::thread::worker_thread_interrupt,
            crate::desktop_commands::thread::worker_thread_apply_op,
            crate::desktop_commands::thread::worker_thread_archive,
            crate::desktop_commands::thread::worker_thread_unarchive,
            crate::desktop_commands::thread::worker_thread_delete,
            crate::desktop_commands::thread::worker_thread_fork,
            crate::desktop_commands::thread::worker_thread_events,
            crate::desktop_commands::thread::worker_thread_restore_checkpoint,
            crate::desktop_commands::webui::worker_cowork_route,
            crate::desktop_commands::webui::worker_webui_route,
            crate::desktop_commands::transport::worker_dispatch_tinyos_host_command,
            crate::desktop_commands::agent::worker_cancel_agent,
            crate::desktop_commands::agent::worker_restore_agent_checkpoint,
            crate::desktop_commands::agent::worker_background_trace_list,
            crate::desktop_commands::agent::worker_background_trace_get_delegate_trace,
            crate::desktop_commands::agent::worker_background_trace_get_artifact,
            crate::desktop_commands::agent::worker_background_trace_append,
            crate::desktop_commands::agent::worker_background_subagent_enqueue_input,
            crate::desktop_commands::agent::worker_subagent_spawn,
            crate::desktop_commands::agent::worker_subagent_list,
            crate::desktop_commands::agent::worker_subagent_query,
            crate::desktop_commands::agent::worker_subagent_send_input,
            crate::desktop_commands::agent::worker_subagent_wait,
            crate::desktop_commands::agent::worker_subagent_cancel,
            crate::desktop_commands::agent::worker_subagent_close,
            crate::desktop_commands::agent::worker_subagent_resume,
            crate::desktop_commands::agent::worker_task_plan_list,
            crate::desktop_commands::agent::worker_task_plan_get,
            crate::desktop_commands::agent::worker_task_plan_save,
            crate::desktop_commands::agent::worker_task_plan_delete,
            crate::desktop_commands::agent::worker_submit_agent_form,
            crate::desktop_commands::agent::worker_resume_agent_approval,
            crate::desktop_commands::agent::worker_resolve_thread_approval,
            crate::desktop_commands::agent::worker_submit_thread_form,
            crate::desktop_commands::config::get_settings_snapshot,
            crate::desktop_commands::config::get_config_editor_snapshot,
            crate::desktop_commands::config::apply_config_patch_result,
            crate::desktop_commands::config::apply_config_operations,
            crate::desktop::files::pick_chat_files,
            crate::desktop::files::pick_upload_file,
            crate::desktop::files::reveal_workspace_file,
            crate::desktop::files::save_export_file,
            crate::native_browser::commands::browser_capabilities,
            crate::native_browser::commands::browser_metrics,
            crate::native_browser::commands::browser_snapshot,
            crate::native_browser::commands::browser_create_session,
            crate::native_browser::commands::browser_close_session,
            crate::native_browser::commands::browser_create_tab,
            crate::native_browser::commands::browser_activate_tab,
            crate::native_browser::commands::browser_close_tab,
            crate::native_browser::commands::browser_navigate,
            crate::native_browser::commands::browser_back,
            crate::native_browser::commands::browser_forward,
            crate::native_browser::commands::browser_reload,
            crate::native_browser::commands::browser_stop,
            crate::native_browser::commands::browser_restart_tab,
            crate::native_browser::commands::browser_update_surface,
            crate::native_browser::commands::browser_observe,
            crate::native_browser::commands::browser_interact,
            crate::native_browser::commands::browser_resolve_policy_request,
            crate::native_browser::commands::browser_delete_profile,
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
