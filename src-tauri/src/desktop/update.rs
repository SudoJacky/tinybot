use serde::Serialize;

use super::{
    logging::append_native_backend_log_line,
    state::{append_log, lock_runtime, SharedGateway, NATIVE_BACKEND_LOG_MAX_BYTES},
};

#[cfg(windows)]
use crate::desktop_commands::gateway::stop_owned_gateway;
#[cfg(windows)]
use tauri::AppHandle;
#[cfg(windows)]
use tauri_plugin_updater::UpdaterExt;

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
    shared: &SharedGateway,
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
    shared: &SharedGateway,
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

fn require_clean_shutdown(shutdown_result: Result<(), String>) -> Result<(), String> {
    shutdown_result.map_err(|error| {
        format!("automatic update installation aborted because runtime shutdown failed: {error}")
    })
}

#[cfg(windows)]
pub(crate) fn spawn_startup_auto_update(app: AppHandle, shared: SharedGateway) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_startup_auto_update(app, shared.clone()).await {
            report_update_event(&shared, "update_failed", None, None, Some(&error));
            eprintln!("[tinybot updater] {error}");
        }
    });
}

#[cfg(windows)]
async fn run_startup_auto_update(app: AppHandle, shared: SharedGateway) -> Result<(), String> {
    let current_version = app.package_info().version.to_string();
    report_update_event(&shared, "check_started", Some(&current_version), None, None);

    let updater = app
        .updater()
        .map_err(|error| format!("failed to initialize updater: {error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("update check failed: {error}"))?
    else {
        report_update_event(&shared, "up_to_date", Some(&current_version), None, None);
        return Ok(());
    };

    report_update_event(
        &shared,
        "update_available",
        Some(&current_version),
        Some(&update.version),
        None,
    );
    report_update_event(
        &shared,
        "download_started",
        Some(&current_version),
        Some(&update.version),
        None,
    );
    let bytes = update
        .download(|_chunk_length, _content_length| {}, || {})
        .await
        .map_err(|error| format!("update download or signature verification failed: {error}"))?;
    report_update_event(
        &shared,
        "signature_verified",
        Some(&current_version),
        Some(&update.version),
        None,
    );

    let shutdown_shared = shared.clone();
    let shutdown_result =
        tauri::async_runtime::spawn_blocking(move || stop_owned_gateway(&shutdown_shared, true))
            .await
            .map_err(|error| format!("runtime shutdown task failed: {error}"))?;
    require_clean_shutdown(shutdown_result)?;
    report_update_event(
        &shared,
        "install_started",
        Some(&current_version),
        Some(&update.version),
        None,
    );

    update
        .install(bytes)
        .map_err(|error| format!("failed to launch update installer: {error}"))?;
    Err("update installer returned without terminating the application".to_string())
}

#[cfg(test)]
mod tests {
    use super::{require_clean_shutdown, update_diagnostic_line};

    #[test]
    fn update_diagnostic_records_version_selection() {
        let line = update_diagnostic_line("update_available", Some("0.1.0"), Some("0.2.0"), None)
            .expect("update diagnostic should serialize");
        let value: serde_json::Value =
            serde_json::from_str(&line).expect("update diagnostic should be JSON");

        assert_eq!(value["event"], "update_available");
        assert_eq!(value["current_version"], "0.1.0");
        assert_eq!(value["available_version"], "0.2.0");
        assert!(value.get("detail").is_none());
    }

    #[test]
    fn installation_gate_accepts_clean_shutdown() {
        assert_eq!(require_clean_shutdown(Ok(())), Ok(()));
    }

    #[test]
    fn installation_gate_rejects_failed_shutdown_with_cause() {
        let error = require_clean_shutdown(Err("worker drain timed out".to_string()))
            .expect_err("failed cleanup must abort installation");

        assert!(error.contains("installation aborted"));
        assert!(error.contains("worker drain timed out"));
    }
}
