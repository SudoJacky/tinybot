use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct WorkerSessionRpc {
    sessions: Vec<SessionMetadata>,
    policy: CapabilityPolicy,
}

impl WorkerSessionRpc {
    pub fn new(sessions: Vec<SessionMetadata>, policy: CapabilityPolicy) -> Self {
        Self { sessions, policy }
    }

    pub fn get_metadata(&self, session_id: &str) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_session_id(session_id)?;
        self.sessions
            .iter()
            .find(|session| session.session_id == session_id)
            .cloned()
            .ok_or_else(|| unknown_session_error(session_id))
    }

    pub fn list_metadata(&self) -> Result<Vec<SessionMetadata>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        let mut sessions = self.sessions.clone();
        sessions.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        Ok(sessions)
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

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SessionMetadata {
    pub session_id: String,
    pub title: String,
    pub workspace_dir: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub extra: Value,
}

fn validate_session_id(session_id: &str) -> Result<(), WorkerProtocolError> {
    if session_id.is_empty()
        || session_id.contains('\0')
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid session id",
            serde_json::json!({ "session_id": session_id }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ));
    }
    Ok(())
}

fn unknown_session_error(session_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "session metadata not found",
        serde_json::json!({ "session_id": session_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::{WorkerProtocolErrorCode, WorkerProtocolErrorSource};
    use serde_json::json;

    #[test]
    fn default_policy_denies_session_metadata_read() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .get_metadata("session-1")
            .expect_err("session metadata should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["capability"], "session.metadata.read");
    }

    #[test]
    fn get_metadata_returns_matching_session_with_capability() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        let metadata = rpc
            .get_metadata("session-1")
            .expect("session metadata should read");

        assert_eq!(metadata.session_id, "session-1");
        assert_eq!(metadata.title, "Native Core Migration");
        assert_eq!(metadata.workspace_dir, "D:/code/tinybot/tinybot");
        assert_eq!(metadata.extra["mode"], "desktop");
    }

    #[test]
    fn get_metadata_rejects_unknown_session_id() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        let error = rpc
            .get_metadata("missing-session")
            .expect_err("unknown session should fail");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["session_id"], "missing-session");
    }

    #[test]
    fn get_metadata_rejects_invalid_session_id() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        assert!(rpc.get_metadata("").is_err());
        assert!(rpc.get_metadata("../session").is_err());
        assert!(rpc.get_metadata("session\0id").is_err());
    }

    #[test]
    fn list_metadata_returns_sorted_sessions() {
        let mut later = session_fixture();
        later.session_id = "session-2".to_string();
        later.updated_at = "2026-06-09T10:30:00Z".to_string();
        let mut earlier = session_fixture();
        earlier.session_id = "session-1".to_string();
        earlier.updated_at = "2026-06-09T09:30:00Z".to_string();
        let rpc = WorkerSessionRpc::new(vec![earlier, later], read_policy());

        let sessions = rpc.list_metadata().expect("sessions should list");
        let ids: Vec<String> = sessions
            .into_iter()
            .map(|session| session.session_id)
            .collect();

        assert_eq!(ids, vec!["session-2", "session-1"]);
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead])
    }

    fn session_fixture() -> SessionMetadata {
        SessionMetadata {
            session_id: "session-1".to_string(),
            title: "Native Core Migration".to_string(),
            workspace_dir: "D:/code/tinybot/tinybot".to_string(),
            created_at: "2026-06-09T09:00:00Z".to_string(),
            updated_at: "2026-06-09T09:30:00Z".to_string(),
            extra: json!({ "mode": "desktop" }),
        }
    }
}
