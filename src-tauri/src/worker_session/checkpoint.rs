use super::*;

impl WorkerSessionRpc {
    pub fn get_checkpoint(&self, session_id: &str) -> Result<Option<Value>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_session_id(session_id)?;
        let session = self
            .sessions
            .iter()
            .find(|session| session.session_id == session_id);
        if let Some(checkpoint) =
            session.and_then(|session| session.extra.get("runtime_checkpoint").cloned())
        {
            return Ok(Some(checkpoint));
        }
        Ok(session.and_then(|session| {
            latest_resumable_checkpoint_for_session(session).map(|checkpoint| checkpoint.checkpoint)
        }))
    }

    pub fn set_checkpoint(
        &mut self,
        session_id: &str,
        checkpoint: Value,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let timestamp = now_session_timestamp();
        let session = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            session.extra["runtime_checkpoint"] = checkpoint.clone();
            mirror_checkpoint_to_agent_run(session, session_id, checkpoint, &timestamp)?;
            session.updated_at = timestamp;
            session.clone()
        };
        self.persist_sessions()?;
        Ok(session)
    }

    pub fn clear_checkpoint(
        &mut self,
        session_id: &str,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let session = {
            let session = self.session_mut_or_create(session_id);
            let legacy_checkpoint = session.extra.get("runtime_checkpoint").cloned();
            if let Some(extra) = session.extra.as_object_mut() {
                extra.remove("runtime_checkpoint");
            }
            clear_compatible_agent_run_checkpoint(session, legacy_checkpoint.as_ref())?;
            session.updated_at = now_session_timestamp();
            session.clone()
        };
        self.persist_sessions()?;
        Ok(session)
    }
}
