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
    pub transport_mode: Option<WorkerTransportMode>,
    pub diagnostics: Vec<WorkerDiagnosticLine>,
    pub last_error: Option<String>,
    pub recovery_hint: Option<String>,
}

impl WorkerRuntimeStatus {
    pub fn stopped() -> Self {
        Self {
            state: WorkerRuntimeState::Stopped,
            transport_mode: None,
            diagnostics: Vec::new(),
            last_error: None,
            recovery_hint: None,
        }
    }

    pub fn startup_failed(error: impl Into<String>) -> Self {
        Self {
            state: WorkerRuntimeState::Failed,
            transport_mode: None,
            diagnostics: Vec::new(),
            last_error: Some(error.into()),
            recovery_hint: Some(
                "Managed worker startup failed; retry native TS worker startup."
                    .to_string(),
            ),
        }
    }

    pub fn running(
        transport_mode: WorkerTransportMode,
        diagnostics: Vec<WorkerDiagnosticLine>,
    ) -> Self {
        Self {
            state: WorkerRuntimeState::Running,
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
    use crate::worker_protocol::{WorkerDiagnosticLine, WorkerTransportMode};

    #[test]
    fn stopped_worker_status_reports_no_transport_or_diagnostics() {
        let status = WorkerRuntimeStatus::stopped();

        assert_eq!(status.state, WorkerRuntimeState::Stopped);
        assert_eq!(status.transport_mode, None);
        assert!(status.diagnostics.is_empty());
        assert!(status.last_error.is_none());
    }

    #[test]
    fn startup_failure_status_includes_error_and_recovery_hint() {
        let status = WorkerRuntimeStatus::startup_failed("worker executable missing");

        assert_eq!(status.state, WorkerRuntimeState::Failed);
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
        assert_eq!(status.transport_mode, Some(WorkerTransportMode::Stdio));
        assert_eq!(
            status.diagnostics,
            vec![WorkerDiagnosticLine::new("stdout", "worker ready")]
        );
    }

}
