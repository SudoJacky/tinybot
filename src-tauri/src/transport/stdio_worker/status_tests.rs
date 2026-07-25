use super::*;
use crate::protocol::WorkerDiagnosticLine;

#[test]
fn rust_backend_active_reports_diagnostics() {
    let status = WorkerRuntimeStatus::rust_backend_active(vec![WorkerDiagnosticLine::new(
        "stdout",
        "rust backend ready",
    )]);

    assert_eq!(status.state, WorkerRuntimeState::Running);
    assert_eq!(status.backend_kind, NativeBackendKind::Rust);
    assert_eq!(status.transport_mode, None);
    assert_eq!(
        status.diagnostics,
        vec![WorkerDiagnosticLine::new("stdout", "rust backend ready")]
    );
}

#[test]
fn startup_failure_status_includes_error_and_recovery_hint() {
    let status = WorkerRuntimeStatus::startup_failed("worker executable missing");

    assert_eq!(status.state, WorkerRuntimeState::Failed);
    assert_eq!(status.backend_kind, NativeBackendKind::Rust);
    assert_eq!(
        status.last_error.as_deref(),
        Some("worker executable missing")
    );
    assert!(status
        .recovery_hint
        .as_deref()
        .expect("failed worker should expose recovery hint")
        .contains("check native backend logs"));
}

#[test]
fn stopped_rust_backend_has_no_transport_or_error() {
    let status = WorkerRuntimeStatus::rust_backend_stopped();

    assert_eq!(status.state, WorkerRuntimeState::Stopped);
    assert_eq!(status.backend_kind, NativeBackendKind::Rust);
    assert_eq!(status.transport_mode, None);
    assert!(status.last_error.is_none());
}
