use super::support::*;
use crate::desktop::files::allowed_workspace_file_path;
use crate::desktop::files::mime_type_for_path;
use crate::desktop::files::upload_file_from_path;
use crate::desktop::files::write_export_file;
use crate::desktop::logging::{append_native_backend_log_event, NativeLogEvent, NativeLogLevel};
use crate::desktop::menu::{
    desktop_menu_item_descriptors, validate_desktop_menu_shortcut_bindings,
    DesktopMenuShortcutBinding,
};
use crate::desktop::state::NativeRuntimeState;
use crate::desktop::{
    desktop_performance_snapshot_with_options, record_renderer_diagnostic_with_options,
    record_renderer_log_with_options,
};
use crate::runtime::observability::AgentRuntimeMetrics;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

#[test]
fn renderer_diagnostics_append_to_persistent_backend_log() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    let shared = Arc::new(Mutex::new(NativeRuntimeState {
        persistent_log_path: log_path.clone(),
        ..NativeRuntimeState::default()
    }));

    record_renderer_diagnostic_with_options(
        &shared,
        serde_json::json!({
            "id": "renderer-1",
            "type": "react.render",
            "message": "render exploded",
            "recentDebugStages": [
                { "stage": "socket.frame", "at": "2026-07-06T01:00:00.000Z" }
            ]
        }),
    )
    .expect("renderer diagnostic should persist");

    let contents =
        std::fs::read_to_string(log_path).expect("persistent backend log should be written");
    assert!(contents.contains("renderer"));
    assert!(contents.contains("\"event\":\"renderer.diagnostic\""));
    assert!(contents.contains("\"type\":\"react.render\""));
    assert!(contents.contains("\"message\":\"render exploded\""));
    assert!(contents.contains("\"stage\":\"socket.frame\""));
}

#[test]
fn renderer_logs_validate_and_append_to_the_shared_backend_log() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    let shared = Arc::new(Mutex::new(NativeRuntimeState {
        persistent_log_path: log_path.clone(),
        ..NativeRuntimeState::default()
    }));

    record_renderer_log_with_options(
        &shared,
        serde_json::json!({
            "schemaVersion": "tinybot.renderer_log.v1",
            "at": "2026-08-16T01:02:03.000Z",
            "level": "error",
            "stage": "native.event_bridge.failed",
            "details": {
                "sessionId": "thread-1",
                "authorization": "Bearer must-not-leak"
            }
        }),
    )
    .expect("renderer log should persist");

    let contents = std::fs::read_to_string(log_path).expect("renderer log should be written");
    assert!(contents.contains("\"level\":\"error\""));
    assert!(contents.contains("\"event\":\"native.event_bridge.failed\""));
    assert!(contents.contains("thread-1"));
    assert!(!contents.contains("must-not-leak"));
    assert!(contents.contains("[redacted]"));

    let invalid = record_renderer_log_with_options(
        &shared,
        serde_json::json!({
            "schemaVersion": "tinybot.renderer_log.v1",
            "at": "2026-08-16T01:02:03.000Z",
            "level": "fatal",
            "stage": "native.event_bridge.failed",
            "details": {}
        }),
    )
    .expect_err("unknown renderer log level should fail fast");
    assert!(invalid.contains("renderer log input"));

    let empty_stage = record_renderer_log_with_options(
        &shared,
        serde_json::json!({
            "schemaVersion": "tinybot.renderer_log.v1",
            "at": "2026-08-16T01:02:03.000Z",
            "level": "error",
            "stage": "",
            "details": {}
        }),
    )
    .expect_err("empty renderer log stage should fail fast");
    assert!(empty_stage.contains("event must be non-empty"));
}

#[test]
fn desktop_performance_snapshot_combines_runtime_metrics_and_recent_events() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState {
        persistent_log_path: fixture.root.join("logs").join("native-backend.log"),
        ..NativeRuntimeState::default()
    }));
    let metrics = AgentRuntimeMetrics::isolated();
    metrics.increment_by("tool.calls", 3);
    metrics.record_duration_ms("tool.duration", 120);
    metrics.record_duration_ms("tool.duration", 80);
    metrics.set_gauge("runtime.active", 2);

    record_renderer_log_with_options(
        &shared,
        serde_json::json!({
            "schemaVersion": "tinybot.renderer_log.v1",
            "at": "2026-08-16T01:02:03.000Z",
            "level": "warn",
            "stage": "trace.fixture",
            "details": { "threadId": "thread-1" }
        }),
    )
    .expect("renderer event should be recorded");

    let snapshot = desktop_performance_snapshot_with_options(&shared, &metrics);
    assert_eq!(snapshot["schemaVersion"], "tinybot.performance_trace.v1");
    assert_eq!(snapshot["metrics"]["counters"]["tool.calls"], 3);
    assert_eq!(
        snapshot["metrics"]["durations"]["tool.duration"]["count"],
        2
    );
    assert_eq!(
        snapshot["metrics"]["durations"]["tool.duration"]["totalMs"],
        200
    );
    assert_eq!(
        snapshot["metrics"]["durations"]["tool.duration"]["maxMs"],
        120
    );
    assert_eq!(
        snapshot["metrics"]["durations"]["tool.duration"]["averageMs"],
        100.0
    );
    assert_eq!(snapshot["metrics"]["gauges"]["runtime.active"], 2);
    assert_eq!(snapshot["recentEvents"][0]["stream"], "renderer");
    assert_eq!(snapshot["recentEvents"][0]["event"], "trace.fixture");
    assert_eq!(
        snapshot["recentEvents"][0]["context"]["details"]["threadId"],
        "thread-1"
    );
    assert!(snapshot["recentEvents"][0]["timestampUnixMs"].is_u64());
}

#[test]
fn desktop_performance_snapshot_bounds_recent_events() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState {
        persistent_log_path: fixture.root.join("logs").join("native-backend.log"),
        ..NativeRuntimeState::default()
    }));
    let metrics = AgentRuntimeMetrics::isolated();

    for sequence in 0..205 {
        record_renderer_log_with_options(
            &shared,
            serde_json::json!({
                "schemaVersion": "tinybot.renderer_log.v1",
                "at": "2026-08-16T01:02:03.000Z",
                "level": "debug",
                "stage": "trace.sequence",
                "details": { "sequence": sequence }
            }),
        )
        .expect("bounded renderer event should be recorded");
    }

    let snapshot = desktop_performance_snapshot_with_options(&shared, &metrics);
    let events = snapshot["recentEvents"]
        .as_array()
        .expect("recent events should be an array");
    assert_eq!(events.len(), 200);
    assert_eq!(events[0]["context"]["details"]["sequence"], 5);
    assert_eq!(events[199]["context"]["details"]["sequence"], 204);
}

#[test]
fn structured_backend_log_redacts_sensitive_context() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");

    append_native_backend_log_event(
        &log_path,
        1024 * 1024,
        "runtime",
        NativeLogEvent::new(
            NativeLogLevel::Error,
            "runtime.start.failed",
            serde_json::json!({
                "authorization": "Bearer must-not-leak",
                "phase": "startup"
            }),
        ),
    )
    .expect("structured log should append");

    let contents = std::fs::read_to_string(log_path).expect("backend log should be written");
    let json = contents
        .splitn(3, ' ')
        .nth(2)
        .expect("log line should contain a JSON record");
    let record: serde_json::Value =
        serde_json::from_str(json).expect("structured backend log should be JSON");
    assert_eq!(record["schemaVersion"], "tinybot.native_log.v1");
    assert_eq!(record["level"], "error");
    assert_eq!(record["event"], "runtime.start.failed");
    assert_eq!(record["context"]["authorization"], "[redacted]");
    assert_eq!(record["context"]["phase"], "startup");
}

#[test]
fn structured_backend_log_truncates_utf8_context_on_a_character_boundary() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");

    append_native_backend_log_event(
        &log_path,
        1024 * 1024,
        "runtime",
        NativeLogEvent::new(
            NativeLogLevel::Warn,
            "runtime.large_context",
            serde_json::json!({ "detail": format!("{}你好", "a".repeat(2047)) }),
        ),
    )
    .expect("structured log should append");

    let contents = std::fs::read_to_string(log_path).expect("backend log should be written");
    let json = contents
        .splitn(3, ' ')
        .nth(2)
        .expect("log line should contain a JSON record");
    let record: serde_json::Value =
        serde_json::from_str(json).expect("structured backend log should be valid JSON");
    assert_eq!(
        record["context"]["detail"],
        format!("{}...", "a".repeat(2047))
    );
}

#[test]
fn persistent_backend_log_rotates_when_size_limit_is_exceeded() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    std::fs::create_dir_all(log_path.parent().expect("log path should have parent"))
        .expect("log directory should create");
    std::fs::write(&log_path, "older diagnostic line\n").expect("old log should write");

    append_native_backend_log_event(
        &log_path,
        8,
        "stderr",
        NativeLogEvent::new(
            NativeLogLevel::Warn,
            "legacy.stderr",
            serde_json::json!({ "message": "new diagnostic line" }),
        ),
    )
    .expect("new log line should append");

    let rotated = std::fs::read_to_string(log_path.with_extension("log.1"))
        .expect("rotated log should exist");
    let current = std::fs::read_to_string(log_path).expect("current log should exist");
    assert!(rotated.contains("older diagnostic line"));
    assert!(current.contains("stderr"));
    assert!(current.contains("new diagnostic line"));
}

#[test]
fn selected_upload_file_response_preserves_name_mime_size_and_bytes() {
    let path =
        std::env::temp_dir().join(format!("tinybot-desktop-upload-{}.md", std::process::id()));
    std::fs::write(&path, b"hello desktop").expect("test upload fixture should write");

    let file = upload_file_from_path(&path).expect("selected file should read");

    assert_eq!(file.name, path.file_name().unwrap().to_string_lossy());
    assert_eq!(file.mime_type, "text/markdown");
    assert_eq!(file.size_bytes, 13);
    assert_eq!(file.bytes, b"hello desktop");

    let _ = std::fs::remove_file(path);
}

#[test]
fn selected_upload_file_mime_fallback_is_octet_stream() {
    assert_eq!(
        mime_type_for_path(Path::new("archive.tinybot")),
        "application/octet-stream"
    );
    assert_eq!(mime_type_for_path(Path::new("image.PNG")), "image/png");
}

#[test]
fn workspace_reveal_path_accepts_only_allowed_workspace_files() {
    let root = Path::new("/repo");

    assert_eq!(
        allowed_workspace_file_path(root, "AGENTS.md").expect("allowed workspace file"),
        root.join("AGENTS.md")
    );
    assert_eq!(
        allowed_workspace_file_path(root, "SYSTEM.md").expect("system prompt should be editable"),
        root.join("SYSTEM.md")
    );
    assert!(allowed_workspace_file_path(root, "docs/context.md").is_err());
    assert!(allowed_workspace_file_path(root, "../secret.txt").is_err());
    assert!(allowed_workspace_file_path(root, "notes/private.md").is_err());
}

#[test]
fn export_file_write_preserves_utf8_contents() {
    let path =
        std::env::temp_dir().join(format!("tinybot-desktop-export-{}.md", std::process::id()));

    write_export_file(&path, "# Export\n\nHello.").expect("export file should write");

    assert_eq!(
        std::fs::read_to_string(&path).expect("export file should read"),
        "# Export\n\nHello."
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn desktop_application_menu_describes_core_workbench_commands() {
    let ids: Vec<&str> = desktop_menu_item_descriptors()
        .iter()
        .map(|item| item.id)
        .collect();

    assert_eq!(
        ids,
        vec![
            "new-chat",
            "stop-generation",
            "search-sessions",
            "open-settings",
            "open-docs",
            "open-shortcut-help",
            "open-page-help",
            "open-backend-logs",
            "toggle-theme",
            "toggle-sidebar",
            "open-command-palette",
        ]
    );
    assert!(desktop_menu_item_descriptors()
        .iter()
        .any(|item| item.id == "toggle-sidebar" && item.checked));
    assert!(desktop_menu_item_descriptors()
        .iter()
        .any(|item| item.id == "stop-generation" && !item.enabled));
    assert_eq!(
        desktop_menu_item_descriptors()
            .iter()
            .map(|item| item.accelerator)
            .collect::<Vec<_>>(),
        vec![
            Some("Ctrl+N"),
            Some("Ctrl+."),
            Some("Ctrl+F"),
            Some("Ctrl+,"),
            Some("F1"),
            Some("Ctrl+/"),
            Some("Ctrl+Shift+/"),
            None,
            Some("Ctrl+Shift+T"),
            Some("Ctrl+B"),
            Some("Ctrl+Shift+P"),
        ]
    );
}

#[test]
fn desktop_menu_shortcut_bindings_require_the_complete_unique_command_set() {
    let bindings = configurable_desktop_menu_shortcuts();

    assert!(validate_desktop_menu_shortcut_bindings(&bindings).is_ok());

    let mut duplicate_command = bindings.clone();
    duplicate_command[1].id = duplicate_command[0].id.clone();
    assert!(validate_desktop_menu_shortcut_bindings(&duplicate_command)
        .expect_err("duplicate commands should fail")
        .contains("appears more than once"));

    let mut duplicate_accelerator = bindings.clone();
    duplicate_accelerator[1].accelerator = duplicate_accelerator[0].accelerator.clone();
    assert!(
        validate_desktop_menu_shortcut_bindings(&duplicate_accelerator)
            .expect_err("duplicate accelerators should fail")
            .contains("assigned more than once")
    );
}

#[test]
fn desktop_menu_shortcut_bindings_reject_unsupported_accelerators() {
    let mut bindings = configurable_desktop_menu_shortcuts();
    bindings[0].accelerator = Some("N".to_string());

    assert!(validate_desktop_menu_shortcut_bindings(&bindings)
        .expect_err("plain keys should fail")
        .contains("is not supported"));
}

fn configurable_desktop_menu_shortcuts() -> Vec<DesktopMenuShortcutBinding> {
    vec![
        ("new-chat", Some("Ctrl+N")),
        ("stop-generation", Some("Ctrl+.")),
        ("toggle-theme", Some("Ctrl+Shift+T")),
        ("toggle-sidebar", Some("Ctrl+B")),
        ("open-settings", Some("Ctrl+,")),
        ("open-docs", None),
    ]
    .into_iter()
    .map(|(id, accelerator)| DesktopMenuShortcutBinding {
        id: id.to_string(),
        accelerator: accelerator.map(str::to_string),
    })
    .collect()
}
