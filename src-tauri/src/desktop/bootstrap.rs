use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tauri::{Emitter, Manager, State, WindowEvent};

use crate::config::application::{
    default_tinybot_config_path, ensure_default_config_file, native_backend_workspace_root,
};
use crate::config::store::ConfigDiagnosticCode;
use crate::desktop_commands::runtime::{
    shutdown_native_runtime_for_window_close, start_native_runtime_with_workspace_root,
};
use crate::desktop_terminal;
use crate::native_browser;
use crate::system_prompt::{load_or_create_system_prompt, SYSTEM_PROMPT_FILE_NAME};
use crate::tool_notes::{create_default_tool_notes_if_missing, TOOL_NOTES_FILE_NAME};

use super::logging::{NativeLogEvent, NativeLogLevel};
use super::menu::{
    install_desktop_application_menu, is_desktop_menu_command, DesktopMenuCommandPayload,
};
use super::state::{
    lock_runtime, push_log, record_native_log, NativeRuntimeState, SharedNativeRuntime,
};

#[tauri::command]
fn record_renderer_diagnostic(
    input: serde_json::Value,
    state: State<'_, SharedNativeRuntime>,
) -> Result<(), String> {
    record_renderer_diagnostic_with_options(state.inner(), input)
}

#[tauri::command]
fn record_renderer_log(
    input: serde_json::Value,
    state: State<'_, SharedNativeRuntime>,
) -> Result<(), String> {
    record_renderer_log_with_options(state.inner(), input)
}

pub(crate) fn record_renderer_diagnostic_with_options(
    shared: &SharedNativeRuntime,
    input: serde_json::Value,
) -> Result<(), String> {
    record_native_log(
        shared,
        "renderer",
        NativeLogEvent::new(NativeLogLevel::Error, "renderer.diagnostic", input),
    )
}

pub(crate) fn record_renderer_log_with_options(
    shared: &SharedNativeRuntime,
    input: serde_json::Value,
) -> Result<(), String> {
    let input: RendererLogInput = serde_json::from_value(input)
        .map_err(|error| format!("invalid renderer log input: {error}"))?;
    if input.schema_version != "tinybot.renderer_log.v1" {
        return Err(format!(
            "invalid renderer log input: unsupported schema {}",
            input.schema_version
        ));
    }
    if !input.details.is_object() {
        return Err("invalid renderer log input: details must be an object".to_string());
    }
    record_native_log(
        shared,
        "renderer",
        NativeLogEvent::new(
            input.level,
            input.stage,
            serde_json::json!({
                "rendererAt": input.at,
                "details": input.details,
            }),
        ),
    )
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererLogInput {
    schema_version: String,
    at: String,
    level: NativeLogLevel,
    stage: String,
    details: serde_json::Value,
}

pub(crate) fn run() {
    let runtime_state = Arc::new(Mutex::new(NativeRuntimeState::default()));
    let update_state = super::update::new_shared_desktop_update_state(env!("CARGO_PKG_VERSION"));
    let close_state = runtime_state.clone();
    let terminal_runtime = desktop_terminal::create_runtime();
    let close_terminal_runtime = terminal_runtime.clone();
    let setup_state = runtime_state.clone();
    let setup_update_state = update_state.clone();
    let close_started = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(runtime_state)
        .manage(terminal_runtime)
        .manage(update_state)
        .setup(move |app| {
            let setup_started = Instant::now();
            let startup_metrics = crate::runtime::observability::global_agent_runtime_metrics();

            let browser_runtime_started = Instant::now();
            let browser_runtime = native_browser::create_runtime(app.handle())?;
            {
                let mut runtime = lock_runtime(&setup_state);
                runtime.native_agent_runtime = runtime
                    .native_agent_runtime
                    .clone()
                    .with_browser_runtime(browser_runtime.clone());
            }
            app.manage(browser_runtime);
            startup_metrics.record_duration(
                "desktop.startup.browserRuntime.durationMs",
                browser_runtime_started.elapsed(),
            );

            let menu_started = Instant::now();
            install_desktop_application_menu(app)?;
            startup_metrics.record_duration(
                "desktop.startup.menu.durationMs",
                menu_started.elapsed(),
            );

            let auxiliary_windows_started = Instant::now();
            #[cfg(windows)]
            super::pet::create_desktop_pet_window(app)?;
            #[cfg(windows)]
            super::pet::create_desktop_pet_quick_chat_window(app)?;
            startup_metrics.record_duration(
                "desktop.startup.auxiliaryWindows.durationMs",
                auxiliary_windows_started.elapsed(),
            );

            let default_files_started = Instant::now();
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
            let tool_notes_path = workspace_root.join(TOOL_NOTES_FILE_NAME);
            match create_default_tool_notes_if_missing(&workspace_root) {
                Ok(true) => push_log(
                    &setup_state,
                    &format!("default tool notes created at {}", tool_notes_path.display()),
                ),
                Ok(false) => {}
                Err(error) => push_log(
                    &setup_state,
                    &format!("failed to initialize tool notes: {error}"),
                ),
            }
            startup_metrics.record_duration(
                "desktop.startup.defaultFiles.durationMs",
                default_files_started.elapsed(),
            );

            let bundled_plugins_started = Instant::now();
            match crate::plugins::PluginStore::default_global().ensure_bundled_plugins() {
                Ok(installed) => {
                    for plugin in installed {
                        push_log(
                            &setup_state,
                            &format!(
                                "bundled plugin installed name={} version={}",
                                plugin.name,
                                plugin.version.as_deref().unwrap_or("unknown")
                            ),
                        );
                    }
                }
                Err(error) => push_log(
                    &setup_state,
                    &format!("failed to initialize bundled plugins: {error}"),
                ),
            }
            startup_metrics.record_duration(
                "desktop.startup.bundledPlugins.durationMs",
                bundled_plugins_started.elapsed(),
            );

            let native_runtime_started = Instant::now();
            if let Err(error) =
                start_native_runtime_with_workspace_root(&setup_state, workspace_root.clone())
            {
                push_log(
                    &setup_state,
                    &format!(
                        "native agent runtime remains paused because startup recovery failed: {error}"
                    ),
                );
            }
            startup_metrics.record_duration(
                "desktop.startup.nativeRuntime.durationMs",
                native_runtime_started.elapsed(),
            );
            #[cfg(windows)]
            super::update::spawn_startup_update_check(
                app.handle().clone(),
                setup_update_state.clone(),
                setup_state.clone(),
            );
            startup_metrics.record_duration(
                "desktop.startup.setup.durationMs",
                setup_started.elapsed(),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            record_renderer_diagnostic,
            record_renderer_log,
            crate::desktop::diagnostics::desktop_performance_snapshot,
            crate::desktop::diagnostics::desktop_export_diagnostic_bundle,
            crate::desktop::update::desktop_update_status,
            crate::desktop::update::desktop_check_for_update,
            crate::desktop::update::desktop_install_update,
            crate::desktop::menu::desktop_set_menu_shortcuts,
            crate::desktop_commands::agent::worker_submit_thread_turn,
            crate::desktop_commands::agent::worker_compact_thread,
            crate::desktop_commands::agent_graphs::worker_agent_graphs_list,
            crate::desktop_commands::agent_graphs::worker_agent_graph_save,
            crate::desktop_commands::agent_graphs::worker_agent_graph_delete,
            crate::desktop_commands::graph_runs::worker_agent_graph_runs_list,
            crate::desktop_commands::graph_runs::worker_agent_graph_run,
            crate::desktop_commands::skills::worker_skills_list,
            crate::desktop_commands::skills::worker_skills_detail,
            crate::desktop_commands::skills::worker_skills_create,
            crate::desktop_commands::skills::worker_skills_update,
            crate::desktop_commands::skills::worker_skills_delete,
            crate::desktop_commands::skills::worker_skills_validate,
            crate::desktop_commands::plugins::worker_plugins_list,
            crate::desktop_commands::plugins::worker_plugin_install,
            crate::desktop_commands::plugins::worker_plugin_prepare_migration,
            crate::desktop_commands::plugins::worker_plugin_install_migration,
            crate::desktop_commands::plugins::worker_plugin_set_enabled,
            crate::desktop_commands::plugins::worker_plugin_uninstall,
            crate::desktop_commands::hooks::worker_hooks_snapshot,
            crate::desktop_commands::hooks::worker_hook_set_trusted,
            crate::desktop_commands::hooks::worker_managed_hook_save,
            crate::desktop_commands::hooks::worker_managed_hook_test,
            crate::desktop_commands::hooks::worker_managed_hook_archive,
            crate::desktop_commands::hooks::worker_managed_hook_script_read,
            crate::desktop_commands::hooks::worker_managed_hook_script_save,
            crate::desktop_commands::memory::worker_memory_snapshot,
            crate::desktop_commands::project_groups::worker_project_groups_list,
            crate::desktop_commands::project_groups::worker_project_group_save,
            crate::desktop_commands::project_groups::worker_project_group_delete,
            crate::desktop_commands::workspace::worker_workspace_files,
            crate::desktop_commands::workspace::worker_workspace_file,
            crate::desktop_commands::workspace::worker_workspace_bootstrap_files,
            crate::desktop_commands::workspace::worker_workspace_put_file,
            crate::desktop_commands::workspace::worker_workspace_directory,
            crate::desktop_commands::workspace::worker_workspace_file_chunk,
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
            crate::desktop_commands::thread::thread_list_turns,
            crate::desktop_commands::thread::thread_get_turn_runtime_state,
            crate::desktop_commands::thread::thread_get_effective_capabilities,
            crate::desktop_commands::webui::worker_webui_route,
            crate::desktop_commands::transport::worker_dispatch_tinyos_host_command,
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
            crate::desktop_commands::agent::worker_submit_thread_form,
            crate::desktop_commands::config::get_settings_snapshot,
            crate::desktop_commands::config::get_config_editor_snapshot,
            crate::desktop_commands::config::apply_config_patch_result,
            crate::desktop_commands::config::apply_config_operations,
            crate::desktop::files::pick_chat_files,
            crate::desktop::pet_file_drop::desktop_pet_drop_signal,
            crate::desktop::files::pick_workspace_directory,
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
            crate::desktop_terminal::terminal_create,
            crate::desktop_terminal::terminal_poll,
            crate::desktop_terminal::terminal_write,
            crate::desktop_terminal::terminal_resize,
            crate::desktop_terminal::terminal_terminate,
        ])
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if super::pet::is_desktop_pet_quick_chat_window(window.label()) {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("desktop_pet_quick_chat_window_hide_failed error={error}");
                    } else {
                        eprintln!("desktop_pet_quick_chat_window_hidden reason=close_requested");
                    }
                    return;
                }
                if super::pet::is_desktop_pet_window(window.label()) {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("desktop_pet_window_hide_failed error={error}");
                    } else {
                        eprintln!("desktop_pet_window_hidden reason=close_requested");
                    }
                    if let Err(error) = window.emit_to(
                        "main",
                        super::pet::DESKTOP_PET_CLOSE_REQUESTED_EVENT,
                        (),
                    ) {
                        eprintln!("desktop_pet_close_event_emit_failed error={error}");
                    }
                    return;
                }
                if !close_started.swap(true, Ordering::AcqRel) {
                    api.prevent_close();
                    eprintln!("desktop_window_close_cleanup_started");
                    let browser_runtime = window
                        .app_handle()
                        .state::<native_browser::SharedBrowserRuntime>()
                        .inner()
                        .clone();
                    let close_state = close_state.clone();
                    let terminal_runtime = close_terminal_runtime.clone();
                    let close_started = close_started.clone();
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = browser_runtime.shutdown().await {
                            eprintln!("desktop_window_close_browser_cleanup_failed error={error}");
                        } else {
                            eprintln!("desktop_window_close_browser_cleanup_completed");
                        }
                        match tauri::async_runtime::spawn_blocking(move || {
                            terminal_runtime.shutdown()
                        })
                        .await
                        {
                            Ok(Ok(())) => {
                                eprintln!("desktop_window_close_terminal_cleanup_completed")
                            }
                            Ok(Err(error)) => eprintln!(
                                "desktop_window_close_terminal_cleanup_failed error={error}"
                            ),
                            Err(error) => eprintln!(
                                "desktop_window_close_terminal_cleanup_task_failed error={error}"
                            ),
                        }
                        if let Err(error) =
                            shutdown_native_runtime_for_window_close(close_state, false).await
                        {
                            eprintln!("desktop_window_close_runtime_cleanup_failed error={error}");
                        } else {
                            eprintln!("desktop_window_close_runtime_cleanup_completed");
                        }
                        if let Some(pet_window) = window
                            .app_handle()
                            .get_webview_window(super::pet::DESKTOP_PET_WINDOW_LABEL)
                        {
                            if let Err(error) = pet_window.destroy() {
                                eprintln!("desktop_pet_window_destroy_failed error={error}");
                            } else {
                                eprintln!("desktop_pet_window_destroy_completed");
                            }
                        }
                        if let Some(quick_chat_window) = window
                            .app_handle()
                            .get_webview_window(super::pet::DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL)
                        {
                            if let Err(error) = quick_chat_window.destroy() {
                                eprintln!("desktop_pet_quick_chat_window_destroy_failed error={error}");
                            } else {
                                eprintln!("desktop_pet_quick_chat_window_destroy_completed");
                            }
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
