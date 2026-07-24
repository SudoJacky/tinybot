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
#[path = "status_tests.rs"]
mod tests;
