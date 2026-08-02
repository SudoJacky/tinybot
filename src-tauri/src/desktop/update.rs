use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::desktop_commands::runtime::shutdown_native_runtime;

use super::{
    logging::append_native_backend_log_line,
    state::{append_log, lock_runtime, SharedNativeRuntime, NATIVE_BACKEND_LOG_MAX_BYTES},
};

pub(crate) const DESKTOP_UPDATE_STATUS_EVENT: &str = "desktop-update-status";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopUpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateSnapshot {
    current_version: String,
    available_version: Option<String>,
    release_notes: Option<String>,
    display_notes: Option<String>,
    published_at: Option<String>,
    phase: DesktopUpdatePhase,
    progress_percent: Option<u8>,
    error: Option<String>,
}

impl DesktopUpdateSnapshot {
    fn idle(current_version: impl Into<String>) -> Self {
        Self {
            current_version: current_version.into(),
            available_version: None,
            release_notes: None,
            display_notes: None,
            published_at: None,
            phase: DesktopUpdatePhase::Idle,
            progress_percent: None,
            error: None,
        }
    }

    fn is_busy(&self) -> bool {
        matches!(
            self.phase,
            DesktopUpdatePhase::Checking
                | DesktopUpdatePhase::Downloading
                | DesktopUpdatePhase::Installing
        )
    }
}

pub(crate) type SharedDesktopUpdateState = Arc<Mutex<DesktopUpdateSnapshot>>;

pub(crate) fn new_shared_desktop_update_state(
    current_version: impl Into<String>,
) -> SharedDesktopUpdateState {
    Arc::new(Mutex::new(DesktopUpdateSnapshot::idle(current_version)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopInstallUpdateInput {
    expected_version: String,
}

#[derive(Serialize)]
struct UpdateDiagnostic<'a> {
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

fn update_diagnostic_line(
    event: &str,
    current_version: Option<&str>,
    available_version: Option<&str>,
    detail: Option<&str>,
) -> Result<String, String> {
    serde_json::to_string(&UpdateDiagnostic {
        event,
        current_version,
        available_version,
        detail,
    })
    .map_err(|error| format!("failed to serialize updater diagnostic: {error}"))
}

fn record_update_event(
    shared: &SharedNativeRuntime,
    event: &str,
    current_version: Option<&str>,
    available_version: Option<&str>,
    detail: Option<&str>,
) -> Result<(), String> {
    let line = update_diagnostic_line(event, current_version, available_version, detail)?;
    let log_path = {
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, &format!("updater {line}"));
        runtime.persistent_log_path.clone()
    };
    append_native_backend_log_line(&log_path, NATIVE_BACKEND_LOG_MAX_BYTES, "updater", &line)
}

fn report_update_event(
    shared: &SharedNativeRuntime,
    event: &str,
    current_version: Option<&str>,
    available_version: Option<&str>,
    detail: Option<&str>,
) {
    if let Err(error) =
        record_update_event(shared, event, current_version, available_version, detail)
    {
        eprintln!("[tinybot updater] {event}; diagnostic write failed: {error}");
    }
}

fn lock_update_state(
    shared: &SharedDesktopUpdateState,
) -> Result<std::sync::MutexGuard<'_, DesktopUpdateSnapshot>, String> {
    shared
        .lock()
        .map_err(|_| "desktop updater state lock poisoned".to_string())
}

fn current_update_snapshot(
    shared: &SharedDesktopUpdateState,
) -> Result<DesktopUpdateSnapshot, String> {
    Ok(lock_update_state(shared)?.clone())
}

fn publish_update_snapshot(
    app: &AppHandle,
    shared: &SharedDesktopUpdateState,
    snapshot: DesktopUpdateSnapshot,
) -> Result<DesktopUpdateSnapshot, String> {
    *lock_update_state(shared)? = snapshot.clone();
    if let Err(error) = app.emit(DESKTOP_UPDATE_STATUS_EVENT, snapshot.clone()) {
        eprintln!("[tinybot updater] status event emission failed: {error}");
    }
    Ok(snapshot)
}

fn begin_update_operation(
    app: &AppHandle,
    shared: &SharedDesktopUpdateState,
    phase: DesktopUpdatePhase,
) -> Result<DesktopUpdateSnapshot, String> {
    let snapshot = {
        let mut current = lock_update_state(shared)?;
        if current.is_busy() {
            return Err(format!(
                "desktop updater is busy in phase {:?}",
                current.phase
            ));
        }
        current.current_version = app.package_info().version.to_string();
        current.phase = phase;
        current.progress_percent = None;
        current.error = None;
        current.clone()
    };
    if let Err(error) = app.emit(DESKTOP_UPDATE_STATUS_EVENT, snapshot.clone()) {
        eprintln!("[tinybot updater] status event emission failed: {error}");
    }
    Ok(snapshot)
}

fn publish_update_failure(
    app: &AppHandle,
    update_state: &SharedDesktopUpdateState,
    runtime_state: &SharedNativeRuntime,
    error: String,
) -> String {
    let current = current_update_snapshot(update_state);
    match current {
        Ok(mut snapshot) => {
            snapshot.phase = DesktopUpdatePhase::Failed;
            snapshot.progress_percent = None;
            snapshot.error = Some(error.clone());
            report_update_event(
                runtime_state,
                "update_failed",
                Some(&snapshot.current_version),
                snapshot.available_version.as_deref(),
                Some(&error),
            );
            if let Err(publish_error) = publish_update_snapshot(app, update_state, snapshot) {
                eprintln!("[tinybot updater] failed to publish failure state: {publish_error}");
            }
        }
        Err(state_error) => {
            report_update_event(
                runtime_state,
                "update_failed",
                None,
                None,
                Some(&format!("{error}; {state_error}")),
            );
        }
    }
    error
}

fn non_empty_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn display_notes_from_manifest(raw_json: &serde_json::Value) -> Option<String> {
    ["display_notes", "displayNotes"]
        .iter()
        .find_map(|key| raw_json.get(key).and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .and_then(|value| non_empty_text(Some(value)))
}

fn available_snapshot_from_parts(
    current_version: impl Into<String>,
    available_version: impl Into<String>,
    release_notes: Option<String>,
    published_at: Option<String>,
    raw_json: &serde_json::Value,
) -> DesktopUpdateSnapshot {
    DesktopUpdateSnapshot {
        current_version: current_version.into(),
        available_version: Some(available_version.into()),
        release_notes: non_empty_text(release_notes),
        display_notes: display_notes_from_manifest(raw_json),
        published_at,
        phase: DesktopUpdatePhase::Available,
        progress_percent: None,
        error: None,
    }
}

fn available_snapshot(current_version: &str, update: &Update) -> DesktopUpdateSnapshot {
    available_snapshot_from_parts(
        current_version,
        update.version.clone(),
        update.body.clone(),
        update.date.as_ref().map(ToString::to_string),
        &update.raw_json,
    )
}

fn require_clean_shutdown(shutdown_result: Result<(), String>) -> Result<(), String> {
    shutdown_result.map_err(|error| {
        format!("update installation aborted because runtime shutdown failed: {error}")
    })
}

pub(crate) fn spawn_startup_update_check(
    app: AppHandle,
    update_state: SharedDesktopUpdateState,
    runtime_state: SharedNativeRuntime,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            perform_update_check(&app, &update_state, &runtime_state, "startup").await
        {
            eprintln!("[tinybot updater] startup check failed: {error}");
        }
    });
}

async fn perform_update_check(
    app: &AppHandle,
    update_state: &SharedDesktopUpdateState,
    runtime_state: &SharedNativeRuntime,
    source: &str,
) -> Result<DesktopUpdateSnapshot, String> {
    let checking = begin_update_operation(app, update_state, DesktopUpdatePhase::Checking)?;
    report_update_event(
        runtime_state,
        "check_started",
        Some(&checking.current_version),
        None,
        Some(source),
    );

    let result = async {
        app.updater()
            .map_err(|error| format!("failed to initialize updater: {error}"))?
            .check()
            .await
            .map_err(|error| format!("update check failed: {error}"))
    }
    .await;

    let update = match result {
        Ok(update) => update,
        Err(error) => {
            return Err(publish_update_failure(
                app,
                update_state,
                runtime_state,
                error,
            ));
        }
    };

    let current_version = app.package_info().version.to_string();
    let Some(update) = update else {
        report_update_event(
            runtime_state,
            "up_to_date",
            Some(&current_version),
            None,
            Some(source),
        );
        return publish_update_snapshot(
            app,
            update_state,
            DesktopUpdateSnapshot {
                current_version,
                available_version: None,
                release_notes: None,
                display_notes: None,
                published_at: None,
                phase: DesktopUpdatePhase::UpToDate,
                progress_percent: None,
                error: None,
            },
        );
    };

    let snapshot = available_snapshot(&current_version, &update);
    report_update_event(
        runtime_state,
        "update_available",
        Some(&current_version),
        snapshot.available_version.as_deref(),
        Some(source),
    );
    publish_update_snapshot(app, update_state, snapshot)
}

#[tauri::command]
pub(crate) fn desktop_update_status(
    state: State<'_, SharedDesktopUpdateState>,
) -> Result<DesktopUpdateSnapshot, String> {
    current_update_snapshot(state.inner())
}

#[tauri::command]
pub(crate) async fn desktop_check_for_update(
    app: AppHandle,
    update_state: State<'_, SharedDesktopUpdateState>,
    runtime_state: State<'_, SharedNativeRuntime>,
) -> Result<DesktopUpdateSnapshot, String> {
    perform_update_check(&app, update_state.inner(), runtime_state.inner(), "manual").await
}

#[tauri::command]
pub(crate) async fn desktop_install_update(
    input: DesktopInstallUpdateInput,
    app: AppHandle,
    update_state: State<'_, SharedDesktopUpdateState>,
    runtime_state: State<'_, SharedNativeRuntime>,
) -> Result<DesktopUpdateSnapshot, String> {
    let shared_update = update_state.inner().clone();
    let shared_runtime = runtime_state.inner().clone();
    let available = current_update_snapshot(&shared_update)?;
    if available.available_version.as_deref() != Some(input.expected_version.as_str()) {
        return Err(format!(
            "requested update {} is not the currently available version",
            input.expected_version
        ));
    }
    let mut downloading =
        begin_update_operation(&app, &shared_update, DesktopUpdatePhase::Downloading)?;
    downloading.progress_percent = Some(0);
    publish_update_snapshot(&app, &shared_update, downloading.clone())?;
    report_update_event(
        &shared_runtime,
        "download_started",
        Some(&downloading.current_version),
        downloading.available_version.as_deref(),
        Some("manual"),
    );

    let update = match async {
        app.updater()
            .map_err(|error| format!("failed to initialize updater: {error}"))?
            .check()
            .await
            .map_err(|error| format!("update check failed before download: {error}"))?
            .ok_or_else(|| "the requested update is no longer available".to_string())
    }
    .await
    {
        Ok(update) => update,
        Err(error) => {
            return Err(publish_update_failure(
                &app,
                &shared_update,
                &shared_runtime,
                error,
            ));
        }
    };

    if update.version != input.expected_version {
        let current_version = app.package_info().version.to_string();
        let latest = available_snapshot(&current_version, &update);
        publish_update_snapshot(&app, &shared_update, latest)?;
        return Err(format!(
            "available update changed from {} to {}; review the new release before installing",
            input.expected_version, update.version
        ));
    }

    let current_version = app.package_info().version.to_string();
    let mut downloaded_bytes = 0_u64;
    let progress_app = app.clone();
    let progress_state = shared_update.clone();
    let bytes = match update
        .download(
            move |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                let Some(total) = content_length.filter(|total| *total > 0) else {
                    return;
                };
                let progress = ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8;
                let Ok(mut snapshot) = current_update_snapshot(&progress_state) else {
                    eprintln!("[tinybot updater] failed to read download progress state");
                    return;
                };
                if snapshot.phase != DesktopUpdatePhase::Downloading {
                    return;
                }
                if snapshot.progress_percent == Some(progress) {
                    return;
                }
                snapshot.progress_percent = Some(progress);
                if let Err(error) =
                    publish_update_snapshot(&progress_app, &progress_state, snapshot)
                {
                    eprintln!("[tinybot updater] failed to publish download progress: {error}");
                }
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(publish_update_failure(
                &app,
                &shared_update,
                &shared_runtime,
                format!("update download or signature verification failed: {error}"),
            ));
        }
    };
    report_update_event(
        &shared_runtime,
        "signature_verified",
        Some(&current_version),
        Some(&update.version),
        None,
    );

    let mut installing = current_update_snapshot(&shared_update)?;
    installing.phase = DesktopUpdatePhase::Installing;
    installing.progress_percent = Some(100);
    publish_update_snapshot(&app, &shared_update, installing)?;

    let shutdown_shared = shared_runtime.clone();
    let shutdown_result = match tauri::async_runtime::spawn_blocking(move || {
        shutdown_native_runtime(&shutdown_shared, true)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            return Err(publish_update_failure(
                &app,
                &shared_update,
                &shared_runtime,
                format!("runtime shutdown task failed: {error}"),
            ));
        }
    };
    if let Err(error) = require_clean_shutdown(shutdown_result) {
        return Err(publish_update_failure(
            &app,
            &shared_update,
            &shared_runtime,
            error,
        ));
    }
    report_update_event(
        &shared_runtime,
        "install_started",
        Some(&current_version),
        Some(&update.version),
        Some("manual"),
    );

    if let Err(error) = update.install(bytes) {
        return Err(publish_update_failure(
            &app,
            &shared_update,
            &shared_runtime,
            format!("failed to launch update installer: {error}"),
        ));
    }
    Err(publish_update_failure(
        &app,
        &shared_update,
        &shared_runtime,
        "update installer returned without terminating the application".to_string(),
    ))
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
