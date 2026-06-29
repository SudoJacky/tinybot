impl WorkerSessionRpc {
    pub fn upsert_task_progress(
        &mut self,
        session_id: &str,
        plan_id: &str,
        progress: Value,
        content: String,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        if plan_id.is_empty() {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "invalid task plan id",
                serde_json::json!({ "plan_id": plan_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let session = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            ensure_messages_array(session);
            let timestamp = now_session_timestamp();
            let progress_message = serde_json::json!({
                "role": "progress",
                "content": content,
                "timestamp": timestamp,
                "_progress": true,
                "_task_event": true,
                "_task_progress": progress,
                "_task_plan_id": plan_id,
                "_tool_name": "task",
            });
            if let Some(existing) = session
                .extra
                .get_mut("messages")
                .and_then(Value::as_array_mut)
            {
                if let Some(message) = existing.iter_mut().find(|message| {
                    message
                        .get("_task_event")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                        && message
                            .get("_task_plan_id")
                            .and_then(Value::as_str)
                            .is_some_and(|existing_plan_id| existing_plan_id == plan_id)
                }) {
                    *message = progress_message;
                } else {
                    existing.push(progress_message);
                }
            }
            session.updated_at = now_session_timestamp();
            session.clone()
        };
        self.persist_sessions()?;
        Ok(session)
    }
}
