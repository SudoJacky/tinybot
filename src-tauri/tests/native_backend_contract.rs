use serde_json::json;
use tinybot_desktop_lib::native_backend_contract::{
    CompatibilityWorkerKind, CompatibilityWorkerState, NativeBackendEvent,
    NativeBackendEventSource, NativeBackendKind, NativeBackendRunSpec, NativeBackendRuntimeStatus,
    NATIVE_AGENT_EVENT_NAMES, NATIVE_TAURI_COMMANDS,
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
