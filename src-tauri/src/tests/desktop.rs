use super::support::*;
use crate::desktop::files::allowed_workspace_file_path;
use crate::desktop::files::mime_type_for_path;
use crate::desktop::files::upload_file_from_path;
use crate::desktop::files::write_export_file;
use crate::desktop::logging::append_native_backend_log_line;
use crate::desktop::menu::desktop_menu_item_descriptors;
use crate::desktop::state::GatewayRuntime;
use crate::desktop::{record_renderer_diagnostic_with_options, truncate_utf8_with_ellipsis};
use crate::desktop_commands::gateway::current_status;
use crate::desktop_commands::gateway::load_gateway_exit_policy;
use crate::desktop_commands::gateway::persist_gateway_exit_policy;
use crate::desktop_commands::gateway::GatewayRuntimeStatus;
use crate::desktop_commands::webui::worker_probe_status;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

#[test]
fn gateway_status_exposes_port_and_exit_policy() {
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        logs: VecDeque::with_capacity(200),
        last_error: None,
        keep_background: true,
        ..GatewayRuntime::default()
    }));

    let status = current_status(&shared);

    assert_eq!(status.port, 18790);
    assert_eq!(status.exit_policy, "keep_running");
    assert_eq!(status.state, "running");
    assert!(!status.http_ok);
    assert_eq!(status.bootstrap_status, "not_required");
    assert_eq!(status.response_class, Some("tauri-native".to_string()));
    assert!(status.recovery_hint.is_none());
}

#[test]
fn gateway_exit_policy_preference_persists_across_runtime_restart() {
    let path = std::env::temp_dir().join(format!(
        "tinybot-desktop-gateway-exit-policy-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);

    persist_gateway_exit_policy(&path, true).expect("preference should persist");

    assert!(load_gateway_exit_policy(&path));

    persist_gateway_exit_policy(&path, false).expect("preference should update");

    assert!(!load_gateway_exit_policy(&path));

    let _ = std::fs::remove_file(path);
}

#[test]
fn renderer_diagnostics_append_to_persistent_backend_log() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        persistent_log_path: log_path.clone(),
        ..GatewayRuntime::default()
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
    assert!(contents.contains("\"type\":\"react.render\""));
    assert!(contents.contains("\"message\":\"render exploded\""));
    assert!(contents.contains("\"stage\":\"socket.frame\""));
}

#[test]
fn renderer_diagnostics_truncate_on_utf8_boundary() {
    let line = format!("{}你好", "a".repeat((16 * 1024) - 1));

    let truncated = truncate_utf8_with_ellipsis(line, 16 * 1024);

    assert!(truncated.ends_with("..."));
    assert!(truncated.is_char_boundary(truncated.len()));
    assert_eq!(truncated, format!("{}...", "a".repeat((16 * 1024) - 1)));
}

#[test]
fn gateway_status_exposes_recent_persistent_backend_log_tail() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    std::fs::create_dir_all(log_path.parent().expect("log path should have parent"))
        .expect("log directory should create");
    std::fs::write(
            &log_path,
            "older line\nworker.request.start route=POST /api/cowork/sessions\ncowork.session.progress percent=60\n",
        )
        .expect("persistent log should write");
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        persistent_log_path: log_path,
        ..GatewayRuntime::default()
    }));

    let status = current_status(&shared);

    assert_eq!(status.log_tail.len(), 3);
    assert!(status
        .log_tail
        .iter()
        .any(|line| line.contains("POST /api/cowork/sessions")));
    assert!(status
        .log_tail
        .iter()
        .any(|line| line.contains("cowork.session.progress")));
}

#[test]
fn persistent_backend_log_rotates_when_size_limit_is_exceeded() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    std::fs::create_dir_all(log_path.parent().expect("log path should have parent"))
        .expect("log directory should create");
    std::fs::write(&log_path, "older diagnostic line\n").expect("old log should write");

    append_native_backend_log_line(&log_path, 8, "stderr", "new diagnostic line")
        .expect("new log line should append");

    let rotated = std::fs::read_to_string(log_path.with_extension("log.1"))
        .expect("rotated log should exist");
    let current = std::fs::read_to_string(log_path).expect("current log should exist");
    assert!(rotated.contains("older diagnostic line"));
    assert!(current.contains("stderr new diagnostic line"));
}

#[test]
fn gateway_runtime_status_serializes_worker_runtime_status() {
    let status = GatewayRuntimeStatus {
        state: "running".to_string(),
        owner: "external".to_string(),
        http_ok: true,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "Tauri Rust backend",
        port: 18790,
        repo_root: "/repo".to_string(),
        log_path: "/logs/native-backend.log".to_string(),
        log_tail: vec![],
        logs: vec![],
        last_error: None,
        exit_policy: "stop_on_exit",
        bootstrap_status: "ready".to_string(),
        response_class: Some("tinybot-bootstrap".to_string()),
        recovery_hint: None,
        worker_runtime:
            crate::transport::stdio_worker::status::WorkerRuntimeStatus::rust_backend_active(vec![]),
        agent_tasks: crate::desktop_commands::gateway::AgentTaskRuntimeStatus {
            accepting: true,
            active_runs: 0,
            draining_runs: 0,
        },
        lifecycle: crate::runtime::lifecycle::RuntimeLifecycleStatus::default(),
    };

    let value = serde_json::to_value(status).expect("status should serialize");

    assert_eq!(value["worker_runtime"]["state"], "running");
    assert_eq!(value["agent_tasks"]["accepting"], true);
    assert_eq!(value["agent_tasks"]["activeRuns"], 0);
    assert_eq!(value["lifecycle"]["startupReconciled"], false);
    assert!(value["worker_runtime"]["transport_mode"].is_null());
}

#[test]
fn worker_probe_status_reports_protocol_metadata() {
    let status = worker_probe_status();
    let value = serde_json::to_value(status).expect("worker probe status should serialize");

    assert_eq!(value["state"], "running");
    assert!(value["transport_mode"].is_null());
    assert_eq!(
        value["diagnostics"][0]["line"],
        format!(
            "rust backend protocol {}",
            crate::protocol::WORKER_PROTOCOL_VERSION
        )
    );
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
    assert_eq!(
        allowed_workspace_file_path(root, "memory/MEMORY.md")
            .expect("allowed nested workspace file"),
        root.join("memory").join("MEMORY.md")
    );
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
            "refresh-gateway-status",
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
            Some("Ctrl+Shift+G"),
        ]
    );
}
