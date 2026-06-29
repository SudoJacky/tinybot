impl WorkerSessionRpc {
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
            .map(|items| project_history_messages(items, session_last_consolidated(session), limit))
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

    pub fn trim_session(
        &mut self,
        session_id: &str,
        keep_recent_messages: usize,
    ) -> Result<TrimSessionResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let result = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            ensure_messages_array(session);
            let messages_before = session
                .extra
                .get("messages")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);

            let retained = if keep_recent_messages == 0 {
                Vec::new()
            } else {
                session
                    .extra
                    .get("messages")
                    .and_then(Value::as_array)
                    .map(|messages| recent_legal_suffix(messages, keep_recent_messages))
                    .unwrap_or_default()
            };
            let messages_after = retained.len();
            let dropped = messages_before.saturating_sub(messages_after);
            let last_consolidated = session_last_consolidated(session).saturating_sub(dropped);
            if let Some(extra) = session.extra.as_object_mut() {
                extra.insert("messages".to_string(), Value::Array(retained));
                extra.insert(
                    "last_consolidated".to_string(),
                    serde_json::json!(last_consolidated),
                );
                if keep_recent_messages == 0 {
                    extra.insert("user_profile".to_string(), serde_json::json!({}));
                    extra.remove("runtime_checkpoint");
                    extra.remove("last_context_metadata");
                    extra.remove("last_persisted_run_id");
                }
            }
            session.updated_at = now_session_timestamp();
            TrimSessionResult {
                session_id: session.session_id.clone(),
                messages_before,
                messages_after,
                session: session.clone(),
            }
        };
        self.persist_sessions()?;
        Ok(result)
    }
}
