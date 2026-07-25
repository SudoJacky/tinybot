use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{
    WorkerDiagnosticLine, WorkerDiagnostics, WorkerProtocolError, WorkerProtocolErrorCode,
    WorkerProtocolErrorSource,
};

#[derive(Clone, Debug)]
pub struct WorkerDiagnosticsRpc {
    diagnostics: WorkerDiagnostics,
    policy: CapabilityPolicy,
}

impl WorkerDiagnosticsRpc {
    pub fn new(capacity: usize, policy: CapabilityPolicy) -> Self {
        Self {
            diagnostics: WorkerDiagnostics::new(capacity),
            policy,
        }
    }

    pub fn append(
        &mut self,
        stream: &str,
        line: &str,
    ) -> Result<WorkerDiagnosticLine, WorkerProtocolError> {
        self.require(WorkerCapability::DiagnosticsWrite)?;
        validate_diagnostic_stream(stream)?;
        let diagnostic = WorkerDiagnosticLine::new(stream, line);
        self.diagnostics
            .push(diagnostic.stream.clone(), diagnostic.line.clone());
        Ok(diagnostic)
    }

    #[cfg(test)]
    pub fn lines(&self) -> Vec<WorkerDiagnosticLine> {
        self.diagnostics.lines()
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

fn validate_diagnostic_stream(stream: &str) -> Result<(), WorkerProtocolError> {
    if matches!(stream, "stdout" | "stderr") {
        return Ok(());
    }
    Err(WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "invalid diagnostics stream",
        serde_json::json!({ "stream": stream }),
        false,
        WorkerProtocolErrorSource::RustCore,
    ))
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
