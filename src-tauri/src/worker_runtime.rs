use crate::native_backend_contract::{
    CompatibilityWorkerKind, CompatibilityWorkerRuntimeStatus, CompatibilityWorkerState,
    NativeBackendKind,
};
use crate::worker_protocol::{WorkerDiagnosticLine, WorkerTransportMode};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerRuntimeState {
    Stopped,
    Starting,
    Running,
    Failed,
    Incompatible,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkerRuntimeStatus {
    pub state: WorkerRuntimeState,
    pub backend_kind: NativeBackendKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_worker: Option<CompatibilityWorkerRuntimeStatus>,
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
            compatibility_worker: None,
            transport_mode: None,
            diagnostics,
            last_error: None,
            recovery_hint: None,
        }
    }

    pub fn stopped() -> Self {
        Self {
            state: WorkerRuntimeState::Stopped,
            backend_kind: NativeBackendKind::Rust,
            compatibility_worker: None,
            transport_mode: None,
            diagnostics: Vec::new(),
            last_error: None,
            recovery_hint: None,
        }
    }

    pub fn startup_failed(error: impl Into<String>) -> Self {
        let error = error.into();
        Self {
            state: WorkerRuntimeState::Failed,
            backend_kind: NativeBackendKind::Rust,
            compatibility_worker: Some(CompatibilityWorkerRuntimeStatus {
                kind: CompatibilityWorkerKind::TsAgentWorker,
                state: CompatibilityWorkerState::Failed,
                transport_mode: None,
                diagnostics: Vec::new(),
                last_error: Some(error.clone()),
                delegated_capabilities: compatibility_worker_capabilities(),
            }),
            transport_mode: None,
            diagnostics: Vec::new(),
            last_error: Some(error),
            recovery_hint: Some(
                "Managed worker startup failed; retry native TS worker startup.".to_string(),
            ),
        }
    }

    pub fn running(
        transport_mode: WorkerTransportMode,
        diagnostics: Vec<WorkerDiagnosticLine>,
    ) -> Self {
        let compatibility_worker = CompatibilityWorkerRuntimeStatus {
            kind: CompatibilityWorkerKind::TsAgentWorker,
            state: CompatibilityWorkerState::Running,
            transport_mode: Some(transport_mode.clone()),
            diagnostics: diagnostics.clone(),
            last_error: None,
            delegated_capabilities: compatibility_worker_capabilities(),
        };
        Self {
            state: WorkerRuntimeState::Running,
            backend_kind: NativeBackendKind::Rust,
            compatibility_worker: Some(compatibility_worker),
            transport_mode: Some(transport_mode),
            diagnostics,
            last_error: None,
            recovery_hint: None,
        }
    }
}

fn compatibility_worker_capabilities() -> Vec<String> {
    vec![
        "agent.run".to_string(),
        "agent.cancel".to_string(),
        "agent.checkpoint.restore".to_string(),
        "agent.form.submit".to_string(),
        "agent.approval.resume".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_protocol::{WorkerDiagnosticLine, WorkerTransportMode};

    #[test]
    fn stopped_worker_status_reports_no_transport_or_diagnostics() {
        let status = WorkerRuntimeStatus::stopped();

        assert_eq!(status.state, WorkerRuntimeState::Stopped);
        assert_eq!(status.backend_kind, NativeBackendKind::Rust);
        assert!(status.compatibility_worker.is_none());
        assert_eq!(status.transport_mode, None);
        assert!(status.diagnostics.is_empty());
        assert!(status.last_error.is_none());
    }

    #[test]
    fn rust_backend_active_reports_no_compatibility_worker() {
        let status = WorkerRuntimeStatus::rust_backend_active(vec![WorkerDiagnosticLine::new(
            "stdout",
            "rust backend ready",
        )]);

        assert_eq!(status.state, WorkerRuntimeState::Running);
        assert_eq!(status.backend_kind, NativeBackendKind::Rust);
        assert!(status.compatibility_worker.is_none());
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
            status
                .compatibility_worker
                .as_ref()
                .map(|worker| &worker.state),
            Some(&CompatibilityWorkerState::Failed)
        );
        assert_eq!(
            status.last_error.as_deref(),
            Some("worker executable missing")
        );
        assert!(status
            .recovery_hint
            .as_deref()
            .expect("failed worker should expose recovery hint")
            .contains("retry native TS worker startup"));
    }

    #[test]
    fn running_worker_status_includes_transport_and_diagnostics() {
        let status = WorkerRuntimeStatus::running(
            WorkerTransportMode::Stdio,
            vec![WorkerDiagnosticLine::new("stdout", "worker ready")],
        );

        assert_eq!(status.state, WorkerRuntimeState::Running);
        assert_eq!(status.backend_kind, NativeBackendKind::Rust);
        assert_eq!(
            status
                .compatibility_worker
                .as_ref()
                .map(|worker| &worker.state),
            Some(&CompatibilityWorkerState::Running)
        );
        assert_eq!(status.transport_mode, Some(WorkerTransportMode::Stdio));
        assert_eq!(
            status.diagnostics,
            vec![WorkerDiagnosticLine::new("stdout", "worker ready")]
        );
    }
}
