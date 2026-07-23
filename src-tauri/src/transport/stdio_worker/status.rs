use crate::protocol::{WorkerDiagnosticLine, WorkerTransportMode};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeBackendKind {
    Rust,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerRuntimeState {
    Stopped,
    Running,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkerRuntimeStatus {
    pub state: WorkerRuntimeState,
    pub backend_kind: NativeBackendKind,
    pub transport_mode: Option<WorkerTransportMode>,
    pub diagnostics: Vec<WorkerDiagnosticLine>,
    pub last_error: Option<String>,
    pub recovery_hint: Option<String>,
}

impl WorkerRuntimeStatus {
    pub fn rust_backend_stopped() -> Self {
        Self {
            state: WorkerRuntimeState::Stopped,
            backend_kind: NativeBackendKind::Rust,
            transport_mode: None,
            diagnostics: Vec::new(),
            last_error: None,
            recovery_hint: None,
        }
    }

    pub fn rust_backend_active(diagnostics: Vec<WorkerDiagnosticLine>) -> Self {
        Self {
            state: WorkerRuntimeState::Running,
            backend_kind: NativeBackendKind::Rust,
            transport_mode: None,
            diagnostics,
            last_error: None,
            recovery_hint: None,
        }
    }

    pub fn startup_failed(error: impl Into<String>) -> Self {
        let error = error.into();
        Self {
            state: WorkerRuntimeState::Failed,
            backend_kind: NativeBackendKind::Rust,
            transport_mode: None,
            diagnostics: Vec::new(),
            last_error: Some(error),
            recovery_hint: Some(
                "Managed worker startup failed; check native backend logs.".to_string(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
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
}
