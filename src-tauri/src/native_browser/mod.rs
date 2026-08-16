pub(crate) mod commands;
#[cfg(all(windows, feature = "native-browser-integration"))]
pub(crate) mod integration;
mod manager;
mod model;
mod platform;
#[cfg(any(test, all(windows, feature = "native-browser-integration")))]
#[path = "tests/fixture.rs"]
mod test_fixture;
#[cfg(any(
    test,
    not(windows),
    all(windows, not(feature = "native-browser-runtime"))
))]
mod unsupported;
#[cfg(all(windows, feature = "native-browser-runtime"))]
mod windows;

use crate::desktop::logging::{
    append_default_native_backend_log_event, NativeLogEvent, NativeLogLevel,
};
pub(crate) use manager::{
    BrowserAgentPageState, BrowserAgentPageText, SharedBrowserRuntime, AGENT_SNAPSHOT_STALE,
};
use manager::{BrowserDiagnosticSink, BrowserSessionManager, BrowserSnapshotSink};
pub(crate) use model::{
    BrowserControlState, BrowserCreateSessionInput, BrowserInteractionInput, BrowserNativeSnapshot,
    BrowserObserveInput, BrowserSemanticNode, BrowserSessionLifecycle,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn create_runtime(app: &AppHandle) -> Result<SharedBrowserRuntime, String> {
    let profile_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve browser profile root: {error}"))?
        .join("browser-profiles");

    let snapshot_app = app.clone();
    let snapshot_sink: BrowserSnapshotSink = Arc::new(move |snapshot| {
        if let Err(error) = snapshot_app.emit("tinyos:browser-snapshot", snapshot) {
            report_native_browser_log(
                NativeLogLevel::Error,
                "browser.snapshot.emit_failed",
                serde_json::json!({ "error": error.to_string() }),
            );
        }
    });
    let diagnostic_app = app.clone();
    let diagnostic_sink: BrowserDiagnosticSink = Arc::new(move |diagnostic| {
        let level = native_browser_diagnostic_level(&diagnostic.event);
        match serde_json::to_value(&diagnostic) {
            Ok(context) => report_native_browser_log(level, &diagnostic.event, context),
            Err(error) => report_native_browser_log(
                NativeLogLevel::Error,
                "browser.diagnostic.serialize_failed",
                serde_json::json!({ "error": error.to_string() }),
            ),
        }
        if let Err(error) = diagnostic_app.emit("tinyos:browser-diagnostic", diagnostic) {
            report_native_browser_log(
                NativeLogLevel::Error,
                "browser.diagnostic.emit_failed",
                serde_json::json!({ "error": error.to_string() }),
            );
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

fn native_browser_diagnostic_level(event: &str) -> NativeLogLevel {
    if event.contains("failed") || event.contains("error") || event.contains("crashed") {
        NativeLogLevel::Error
    } else if event.contains("blocked") || event.contains("denied") || event.contains("orphaned") {
        NativeLogLevel::Warn
    } else {
        NativeLogLevel::Info
    }
}

fn report_native_browser_log(level: NativeLogLevel, event: &str, context: serde_json::Value) {
    if let Err(error) = append_default_native_backend_log_event(
        "browser",
        NativeLogEvent::new(level, event, context),
    ) {
        eprintln!("native browser log write failed: {error}; event={event}");
    }
}
