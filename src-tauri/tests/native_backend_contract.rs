use serde_json::json;
use tinybot_desktop_lib::native_backend_contract::{
    native_route_owner_summary, native_runtime_component_inventory, native_tauri_command_inventory,
    native_webui_route_inventory, webui_route_inventory_entry, CompatibilityWorkerKind,
    CompatibilityWorkerState, NativeBackendEvent, NativeBackendEventSource, NativeBackendKind,
    NativeBackendRunSpec, NativeBackendRuntimeStatus, NativeRouteOwner, NATIVE_AGENT_EVENT_NAMES,
    NATIVE_TAURI_COMMANDS,
};
use tinybot_desktop_lib::worker_protocol::{
    WorkerEvent, WorkerRequest, WorkerResponse, WorkerTransportMode,
};
use tinybot_desktop_lib::worker_runtime::WorkerRuntimeStatus;

#[test]
fn contract_inventory_lists_native_commands_and_events_used_by_frontend() {
    assert!(NATIVE_TAURI_COMMANDS.contains(&"worker_run_agent"));
    assert!(NATIVE_TAURI_COMMANDS.contains(&"worker_cancel_agent"));
    assert!(NATIVE_TAURI_COMMANDS.contains(&"worker_restore_agent_checkpoint"));
    assert!(NATIVE_TAURI_COMMANDS.contains(&"worker_submit_agent_form"));
    assert!(NATIVE_TAURI_COMMANDS.contains(&"worker_resume_agent_approval"));

    assert!(NATIVE_AGENT_EVENT_NAMES.contains(&"agent.delta"));
    assert!(NATIVE_AGENT_EVENT_NAMES.contains(&"agent.awaiting_approval"));
    assert!(NATIVE_AGENT_EVENT_NAMES.contains(&"agent.awaiting_form"));
    assert!(NATIVE_AGENT_EVENT_NAMES.contains(&"agent.delegate.trace.updated"));
    assert!(NATIVE_AGENT_EVENT_NAMES.contains(&"heartbeat.delivery"));
}

#[test]
fn route_inventory_classifies_webui_routes_and_tauri_commands() {
    let webui = native_webui_route_inventory();
    let tauri = native_tauri_command_inventory();
    let summary = native_route_owner_summary();

    assert!(webui.iter().any(|entry| {
        entry.method == Some("GET")
            && entry.path == "/webui/bootstrap"
            && entry.owner == NativeRouteOwner::RustOwned
    }));
    assert!(webui.iter().any(|entry| {
        entry.method == Some("POST")
            && entry.path == "/api/provider-models"
            && entry.owner == NativeRouteOwner::RustOwned
    }));
    assert!(webui.iter().any(|entry| {
        entry.method == Some("POST")
            && entry.path == "/v1/knowledge/query"
            && entry.owner == NativeRouteOwner::TsFallback
            && !entry.replacement_plan.is_empty()
    }));
    assert!(webui.iter().any(|entry| {
        entry.method == Some("GET")
            && entry.path == "/api/tools"
            && entry.owner == NativeRouteOwner::Unsupported
    }));
    assert!(tauri.iter().any(|entry| {
        entry.path == "worker_run_agent" && entry.owner == NativeRouteOwner::RustOwned
    }));
    assert!(tauri.iter().any(|entry| {
        entry.path == "worker_channel_start" && entry.owner == NativeRouteOwner::TsFallback
    }));
    assert!(summary.rust_owned > 0);
    assert!(summary.ts_fallback > 0);
    assert!(summary.unsupported > 0);
}

#[test]
fn fallback_webui_routes_must_have_inventory_entries() {
    let fallback_routes = [
        ("PATCH", "/api/config"),
        ("POST", "/v1/knowledge/query"),
        ("POST", "/v1/knowledge/graph/extract"),
        ("GET", "/v1/knowledge/graphrag"),
        ("POST", "/api/cowork/sessions"),
    ];

    for (method, path) in fallback_routes {
        let entry = webui_route_inventory_entry(method, path)
            .unwrap_or_else(|| panic!("{method} {path} must be inventoried"));
        assert_eq!(
            entry.owner,
            NativeRouteOwner::TsFallback,
            "{method} {path} must be an explicit TS fallback while delegated"
        );
    }
}

#[test]
fn remaining_fallback_areas_are_explicitly_inventoried() {
    let webui = native_webui_route_inventory();
    let tauri = native_tauri_command_inventory();
    let runtime = native_runtime_component_inventory();

    assert_inventory_area(&webui, "knowledge", NativeRouteOwner::TsFallback);
    assert_inventory_area(&webui, "cowork", NativeRouteOwner::TsFallback);
    assert_inventory_area(&tauri, "channel", NativeRouteOwner::TsFallback);
    assert_inventory_area(&tauri, "cron", NativeRouteOwner::TsFallback);
    assert_inventory_area(&runtime, "heartbeat", NativeRouteOwner::TsFallback);
    assert_inventory_area(&runtime, "tools", NativeRouteOwner::RustOwned);
    assert_inventory_area(&webui, "tools", NativeRouteOwner::Unsupported);
    assert_inventory_area(&runtime, "background", NativeRouteOwner::RustOwned);
    assert_inventory_area(&webui, "agent-ui", NativeRouteOwner::RustOwned);

    for entry in webui.iter().chain(tauri.iter()).chain(runtime.iter()) {
        assert!(
            !entry.reason.is_empty(),
            "{} {} must explain why it has its current owner",
            entry.surface,
            entry.path
        );
        assert!(
            !entry.replacement_plan.is_empty(),
            "{} {} must include a replacement or stability plan",
            entry.surface,
            entry.path
        );
    }
}

fn assert_inventory_area(
    entries: &[tinybot_desktop_lib::native_backend_contract::NativeRouteInventoryEntry],
    route_group: &str,
    owner: NativeRouteOwner,
) {
    assert!(
        entries
            .iter()
            .any(|entry| entry.route_group == route_group && entry.owner == owner),
        "{route_group} should have a {owner:?} inventory entry"
    );
}

#[test]
fn run_spec_accepts_frontend_payload_and_preserves_unknown_metadata() {
    let spec = NativeBackendRunSpec::from_value(json!({
        "runId": "run-1",
        "sessionId": "session-1",
        "messages": [{ "role": "user", "content": "hello" }],
        "model": "gpt-4.1-mini",
        "maxIterations": 8,
        "stream": true,
        "metadata": { "route": "desktop", "futureField": { "kept": true } },
        "futureTopLevel": "kept"
    }))
    .expect("frontend run spec should parse");

    assert_eq!(spec.run_id, "run-1");
    assert_eq!(spec.session_id, "session-1");
    assert_eq!(spec.model, "gpt-4.1-mini");
    assert_eq!(spec.additional.get("futureTopLevel"), Some(&json!("kept")));
    assert_eq!(
        spec.metadata.get("futureField"),
        Some(&json!({ "kept": true }))
    );
}

#[test]
fn native_event_wraps_worker_event_with_frontend_correlation_fields() {
    let event = NativeBackendEvent::from_worker_event(
        WorkerEvent {
            protocol_version: "1".to_string(),
            trace_id: "trace-1".to_string(),
            event: "agent.delta".to_string(),
            payload: json!({ "runId": "run-1", "delta": "hi" }),
        },
        "session-1",
        Some("run-1"),
        "2026-06-29T14:30:00.000Z",
    );

    assert_eq!(event.session_id, "session-1");
    assert_eq!(event.run_id.as_deref(), Some("run-1"));
    assert_eq!(event.trace_id, "trace-1");
    assert_eq!(event.event_name, "agent.delta");
    assert_eq!(event.source, NativeBackendEventSource::CompatibilityWorker);
    assert_eq!(event.payload["delta"], "hi");
}

#[test]
fn runtime_status_reports_rust_owner_and_optional_ts_compatibility_worker() {
    let status = NativeBackendRuntimeStatus::rust_with_ts_compatibility(
        WorkerRuntimeStatus::running(WorkerTransportMode::Stdio, vec![]),
        vec!["agent.run".to_string(), "agent.cancel".to_string()],
    );

    assert_eq!(status.backend_kind, NativeBackendKind::Rust);
    let worker = status
        .compatibility_worker
        .as_ref()
        .expect("TS compatibility worker should be present");
    assert_eq!(worker.kind, CompatibilityWorkerKind::TsAgentWorker);
    assert_eq!(worker.state, CompatibilityWorkerState::Running);
    assert_eq!(worker.delegated_capabilities, ["agent.run", "agent.cancel"]);
}

#[test]
fn response_correlation_requires_request_id_and_trace_id() {
    let request = WorkerRequest::new("req-1", "trace-1", "agent.run", json!({}));
    let matching = WorkerResponse::success(&request, json!({ "ok": true }));
    let wrong_trace = WorkerResponse {
        trace_id: "trace-2".to_string(),
        ..matching.clone()
    };

    assert!(matching.matches_request(&request));
    assert!(!wrong_trace.matches_request(&request));
}
