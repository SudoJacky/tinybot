use super::*;

impl WorkerSessionRpc {
    pub fn patch_user_profile(
        &mut self,
        session_id: &str,
        user_profile: Value,
        metadata: Value,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        if !user_profile.is_object() {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "session user_profile patch must be a JSON object",
                serde_json::json!({ "session_id": session_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let Some(metadata_patch) = metadata.as_object() else {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "session profile metadata patch must be a JSON object",
                serde_json::json!({ "session_id": session_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        };
        let session = {
            let Some(session) = self
                .sessions
                .iter_mut()
                .find(|session| session.session_id == session_id)
            else {
                return Err(unknown_session_error(session_id));
            };
            ensure_extra_object(session);
            session.extra["user_profile"] = user_profile;
            if !session.extra.get("metadata").is_some_and(Value::is_object) {
                session.extra["metadata"] = serde_json::json!({});
            }
            if let Some(existing) = session
                .extra
                .get_mut("metadata")
                .and_then(Value::as_object_mut)
            {
                for (key, value) in metadata_patch {
                    existing.insert(key.clone(), value.clone());
                }
            }
            session.updated_at = now_session_timestamp();
            session.clone()
        };
        self.persist_sessions()?;
        Ok(session)
    }
}
