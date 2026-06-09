use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
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
mod tests {
    use super::*;
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::{WorkerProtocolErrorCode, WorkerProtocolErrorSource};

    #[test]
    fn default_policy_denies_diagnostics_append() {
        let mut rpc = WorkerDiagnosticsRpc::new(20, CapabilityPolicy::default());

        let error = rpc
            .append("stdout", "worker ready")
            .expect_err("diagnostics append should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["capability"], "diagnostics.write");
    }

    #[test]
    fn append_records_diagnostic_with_write_capability() {
        let mut rpc = WorkerDiagnosticsRpc::new(20, write_policy());

        let appended = rpc
            .append("stderr", "worker warning")
            .expect("diagnostic should append");

        assert_eq!(appended, WorkerDiagnosticLine::new("stderr", "worker warning"));
        assert_eq!(
            rpc.lines(),
            vec![WorkerDiagnosticLine::new("stderr", "worker warning")]
        );
    }

    #[test]
    fn diagnostics_append_keeps_recent_lines_only() {
        let mut rpc = WorkerDiagnosticsRpc::new(2, write_policy());

        rpc.append("stdout", "one").expect("first append");
        rpc.append("stderr", "two").expect("second append");
        rpc.append("stdout", "three").expect("third append");

        assert_eq!(
            rpc.lines(),
            vec![
                WorkerDiagnosticLine::new("stderr", "two"),
                WorkerDiagnosticLine::new("stdout", "three"),
            ]
        );
    }

    #[test]
    fn diagnostics_append_rejects_unknown_stream() {
        let mut rpc = WorkerDiagnosticsRpc::new(20, write_policy());

        let error = rpc
            .append("console", "unknown stream")
            .expect_err("unknown stream should be rejected");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["stream"], "console");
    }

    fn write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::DiagnosticsWrite])
    }
}
