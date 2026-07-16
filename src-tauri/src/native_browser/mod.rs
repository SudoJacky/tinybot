mod commands;
#[cfg(all(windows, feature = "native-browser-integration"))]
pub(crate) mod integration;
mod manager;
mod model;
mod platform;
#[cfg(any(test, all(windows, feature = "native-browser-integration")))]
mod test_fixture;
mod unsupported;
#[cfg(all(windows, feature = "native-browser-runtime"))]
mod windows;

pub(crate) use manager::SharedBrowserRuntime;
use manager::{BrowserDiagnosticSink, BrowserSessionManager, BrowserSnapshotSink};
pub(crate) use model::{
    BrowserCreateSessionInput, BrowserInteractionInput, BrowserNativeSnapshot, BrowserObserveInput,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) use commands::{
    browser_activate_tab, browser_back, browser_capabilities, browser_close_session,
    browser_close_tab, browser_create_session, browser_create_tab, browser_delete_profile,
    browser_forward, browser_interact, browser_metrics, browser_navigate, browser_observe,
    browser_reload, browser_resolve_policy_request, browser_restart_tab, browser_snapshot,
    browser_stop, browser_update_surface,
};

pub(crate) fn create_runtime(app: &AppHandle) -> Result<SharedBrowserRuntime, String> {
    let profile_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve browser profile root: {error}"))?
        .join("browser-profiles");

    let snapshot_app = app.clone();
    let snapshot_sink: BrowserSnapshotSink = Arc::new(move |snapshot| {
        if let Err(error) = snapshot_app.emit("tinyos:browser-snapshot", snapshot) {
            eprintln!("failed to emit native browser snapshot: {error}");
        }
    });
    let diagnostic_app = app.clone();
    let diagnostic_log_path = crate::native_backend_log_path();
    let diagnostic_sink: BrowserDiagnosticSink = Arc::new(move |diagnostic| {
        match serde_json::to_string(&diagnostic) {
            Ok(line) => {
                if let Err(error) = crate::desktop_logging::append_native_backend_log_line(
                    &diagnostic_log_path,
                    crate::NATIVE_BACKEND_LOG_MAX_BYTES,
                    "browser",
                    &line,
                ) {
                    eprintln!("failed to persist native browser diagnostic: {error}");
                }
            }
            Err(error) => eprintln!("failed to serialize native browser diagnostic: {error}"),
        }
        if let Err(error) = diagnostic_app.emit("tinyos:browser-diagnostic", diagnostic) {
            eprintln!("failed to emit native browser diagnostic: {error}");
        }
    });

    #[cfg(all(windows, feature = "native-browser-runtime"))]
    let adapter = windows::WindowsBrowserRuntime::new(app.clone(), profile_root.clone())?;
    #[cfg(all(windows, not(feature = "native-browser-runtime")))]
    let adapter = Arc::new(unsupported::UnsupportedBrowserRuntime::feature_disabled());
    #[cfg(not(windows))]
    let adapter = Arc::new(unsupported::UnsupportedBrowserRuntime::platform_unsupported());

    Ok(BrowserSessionManager::new(
        adapter,
        profile_root,
        snapshot_sink,
        diagnostic_sink,
    ))
}
