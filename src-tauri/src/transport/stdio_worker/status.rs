use crate::native_backend_contract::NativeBackendKind;
use crate::protocol::{WorkerDiagnosticLine, WorkerTransportMode};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerRuntimeState {
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

    pub fn running(
        transport_mode: WorkerTransportMode,
        diagnostics: Vec<WorkerDiagnosticLine>,
    ) -> Self {
        Self {
            state: WorkerRuntimeState::Running,
            backend_kind: NativeBackendKind::Rust,
            transport_mode: Some(transport_mode),
            diagnostics,
            last_error: None,
            recovery_hint: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{WorkerDiagnosticLine, WorkerTransportMode};

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
    fn running_worker_status_includes_transport_and_diagnostics() {
        let status = WorkerRuntimeStatus::running(
            WorkerTransportMode::Stdio,
            vec![WorkerDiagnosticLine::new("stdout", "worker ready")],
        );

        assert_eq!(status.state, WorkerRuntimeState::Running);
        assert_eq!(status.backend_kind, NativeBackendKind::Rust);
        assert_eq!(status.transport_mode, Some(WorkerTransportMode::Stdio));
        assert_eq!(
            status.diagnostics,
            vec![WorkerDiagnosticLine::new("stdout", "worker ready")]
        );
    }
}
