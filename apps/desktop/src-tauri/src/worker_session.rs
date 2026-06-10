use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

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

    pub fn get_checkpoint(&self, session_id: &str) -> Result<Option<Value>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_session_id(session_id)?;
        let session = self
            .sessions
            .iter()
            .find(|session| session.session_id == session_id);
        Ok(session.and_then(|session| session.extra.get("runtime_checkpoint").cloned()))
    }

    pub fn get_history(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<SessionHistoryProjection, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_session_id(session_id)?;
        let Some(session) = self
            .sessions
            .iter()
            .find(|session| session.session_id == session_id)
        else {
            return Ok(SessionHistoryProjection {
                session_id: session_id.to_string(),
                messages: Vec::new(),
                user_profile: serde_json::json!({}),
                updated_at: String::new(),
            });
        };
        let messages = session
            .extra
            .get("messages")
            .and_then(Value::as_array)
            .map(|items| {
                let start = items.len().saturating_sub(limit);
                items[start..].to_vec()
            })
            .unwrap_or_default();
        let user_profile = session
            .extra
            .get("user_profile")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(SessionHistoryProjection {
            session_id: session.session_id.clone(),
            messages,
            user_profile,
            updated_at: session.updated_at.clone(),
        })
    }

    pub fn set_checkpoint(
        &mut self,
        session_id: &str,
        checkpoint: Value,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let session = self.session_mut_or_create(session_id);
        ensure_extra_object(session);
        session.extra["runtime_checkpoint"] = checkpoint;
        session.updated_at = now_session_timestamp();
        Ok(session.clone())
    }

    pub fn clear_checkpoint(
        &mut self,
        session_id: &str,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let session = self.session_mut_or_create(session_id);
        if let Some(extra) = session.extra.as_object_mut() {
            extra.remove("runtime_checkpoint");
        }
        session.updated_at = now_session_timestamp();
        Ok(session.clone())
    }

    pub fn append_messages(
        &mut self,
        session_id: &str,
        messages: Vec<Value>,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let session = self.session_mut_or_create(session_id);
        ensure_extra_object(session);
        ensure_messages_array(session);
        if let Some(existing) = session
            .extra
            .get_mut("messages")
            .and_then(Value::as_array_mut)
        {
            existing.extend(messages);
        }
        session.updated_at = now_session_timestamp();
        Ok(session.clone())
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

    fn session_mut_or_create(&mut self, session_id: &str) -> &mut SessionMetadata {
        if let Some(index) = self
            .sessions
            .iter()
            .position(|session| session.session_id == session_id)
        {
            return &mut self.sessions[index];
        }
        let timestamp = now_session_timestamp();
        self.sessions.push(SessionMetadata {
            session_id: session_id.to_string(),
            title: format!("Desktop Session {session_id}"),
            workspace_dir: String::new(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
            extra: serde_json::json!({}),
        });
        self.sessions
            .last_mut()
            .expect("newly pushed session should be present")
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

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SessionHistoryProjection {
    pub session_id: String,
    pub messages: Vec<Value>,
    pub user_profile: Value,
    pub updated_at: String,
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

fn ensure_extra_object(session: &mut SessionMetadata) {
    if !session.extra.is_object() {
        session.extra = serde_json::json!({});
    }
}

fn ensure_messages_array(session: &mut SessionMetadata) {
    if !session.extra.get("messages").is_some_and(Value::is_array) {
        session.extra["messages"] = serde_json::json!([]);
    }
}

fn now_session_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("unix-ms:{millis}")
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

    #[test]
    fn set_and_clear_checkpoint_update_session_extra_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], write_policy());

        let updated = rpc
            .set_checkpoint(
                "session-1",
                json!({ "phase": "awaiting_tools", "iteration": 0 }),
            )
            .expect("checkpoint should set");

        assert_eq!(
            updated.extra["runtime_checkpoint"],
            json!({ "phase": "awaiting_tools", "iteration": 0 })
        );

        let cleared = rpc
            .clear_checkpoint("session-1")
            .expect("checkpoint should clear");

        assert!(cleared.extra.get("runtime_checkpoint").is_none());
    }

    #[test]
    fn set_checkpoint_creates_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .set_checkpoint(
                "desktop-session-1",
                json!({ "phase": "awaiting_tools", "iteration": 0 }),
            )
            .expect("checkpoint write should create session metadata");

        assert_eq!(updated.session_id, "desktop-session-1");
        assert_eq!(updated.title, "Desktop Session desktop-session-1");
        assert_eq!(
            updated.extra["runtime_checkpoint"]["phase"],
            "awaiting_tools"
        );
    }

    #[test]
    fn clear_checkpoint_creates_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .clear_checkpoint("desktop-session-1")
            .expect("checkpoint clear should be idempotent for new sessions");

        assert_eq!(updated.session_id, "desktop-session-1");
        assert!(updated.extra.get("runtime_checkpoint").is_none());
    }

    #[test]
    fn get_checkpoint_returns_runtime_checkpoint_with_read_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "runtime_checkpoint": {
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let checkpoint = rpc
            .get_checkpoint("session-1")
            .expect("checkpoint should read");

        assert_eq!(
            checkpoint,
            Some(json!({
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }))
        );
    }

    #[test]
    fn get_checkpoint_returns_none_when_session_has_no_runtime_checkpoint() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        let checkpoint = rpc
            .get_checkpoint("session-1")
            .expect("checkpoint read should allow missing checkpoint");

        assert_eq!(checkpoint, None);
    }

    #[test]
    fn get_checkpoint_returns_none_for_missing_session_with_read_capability() {
        let rpc = WorkerSessionRpc::new(vec![], read_policy());

        let checkpoint = rpc
            .get_checkpoint("desktop-session-1")
            .expect("missing session should behave like no checkpoint");

        assert_eq!(checkpoint, None);
    }

    #[test]
    fn get_history_returns_messages_user_profile_and_updated_at() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "second" },
                { "role": "user", "content": "third" }
            ],
            "user_profile": {
                "name": "Ada",
                "preferences": ["concise"]
            },
            "runtime_checkpoint": { "phase": "awaiting_tools" }
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 2)
            .expect("history should read");

        assert_eq!(history.session_id, "session-1");
        assert_eq!(history.updated_at, "2026-06-09T09:30:00Z");
        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "assistant", "content": "second" }),
                json!({ "role": "user", "content": "third" })
            ]
        );
        assert_eq!(
            history.user_profile,
            json!({ "name": "Ada", "preferences": ["concise"] })
        );
    }

    #[test]
    fn get_history_returns_empty_projection_for_missing_session() {
        let rpc = WorkerSessionRpc::new(vec![], read_policy());

        let history = rpc
            .get_history("desktop-session-1", 80)
            .expect("missing session should project empty history");

        assert_eq!(history.session_id, "desktop-session-1");
        assert_eq!(history.messages, Vec::<serde_json::Value>::new());
        assert_eq!(history.user_profile, json!({}));
    }

    #[test]
    fn default_policy_denies_session_checkpoint_read() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .get_checkpoint("session-1")
            .expect_err("checkpoint reads should require metadata read capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "session.metadata.read");
    }

    #[test]
    fn default_policy_denies_session_checkpoint_write() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .set_checkpoint("session-1", json!({ "phase": "awaiting_tools" }))
            .expect_err("checkpoint writes should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "session.write");
    }

    #[test]
    fn append_messages_extends_session_extra_messages_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "existing" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .append_messages(
                "session-1",
                vec![
                    json!({ "role": "assistant", "content": "hello" }),
                    json!({ "role": "tool", "content": "result", "toolCallId": "call-1" }),
                ],
            )
            .expect("messages should append");

        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "existing" },
                { "role": "assistant", "content": "hello" },
                { "role": "tool", "content": "result", "toolCallId": "call-1" }
            ])
        );
    }

    #[test]
    fn append_messages_creates_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .append_messages(
                "desktop-session-1",
                vec![json!({ "role": "assistant", "content": "hello" })],
            )
            .expect("append should create session metadata");

        assert_eq!(updated.session_id, "desktop-session-1");
        assert_eq!(
            updated.extra["messages"],
            json!([{ "role": "assistant", "content": "hello" }])
        );
    }

    #[test]
    fn default_policy_denies_session_append_messages() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .append_messages(
                "session-1",
                vec![json!({ "role": "assistant", "content": "hello" })],
            )
            .expect_err("append should require session write capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "session.write");
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead])
    }

    fn write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::SessionWrite])
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
