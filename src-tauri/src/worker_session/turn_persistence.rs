use super::*;

impl WorkerSessionRpc {
    pub fn append_messages(
        &mut self,
        session_id: &str,
        messages: Vec<Value>,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let session = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            ensure_messages_array(session);
            if let Some(existing) = session
                .extra
                .get_mut("messages")
                .and_then(Value::as_array_mut)
            {
                let mut seen: HashSet<String> = existing.iter().map(session_message_key).collect();
                for message in messages {
                    let key = session_message_key(&message);
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    existing.push(message);
                }
            }
            session.updated_at = now_session_timestamp();
            session.clone()
        };
        self.persist_sessions()?;
        Ok(session)
    }

    pub fn persist_turn(
        &mut self,
        session_id: &str,
        run_id: &str,
        messages: Vec<Value>,
        clear_checkpoint: bool,
        context_metadata: Option<Value>,
    ) -> Result<PersistTurnResult, WorkerProtocolError> {
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
            let mut saved_message_count = 0;
            let mut duplicate_message_count = 0;
            let mut saved_messages = Vec::new();
            if let Some(existing) = session
                .extra
                .get_mut("messages")
                .and_then(Value::as_array_mut)
            {
                let mut seen: HashSet<String> = existing.iter().map(session_message_key).collect();
                for message in messages {
                    let key = session_message_key(&message);
                    if seen.contains(&key) {
                        duplicate_message_count += 1;
                        continue;
                    }
                    seen.insert(key);
                    saved_messages.push(message.clone());
                    existing.push(message);
                    saved_message_count += 1;
                }
            }
            let mut checkpoint_cleared = false;
            if clear_checkpoint {
                clear_agent_run_checkpoint_by_id(session, run_id)?;
                if let Some(extra) = session.extra.as_object_mut() {
                    checkpoint_cleared = extra.remove("runtime_checkpoint").is_some();
                }
            }
            if let Some(extra) = session.extra.as_object_mut() {
                extra.insert(
                    "last_persisted_run_id".to_string(),
                    Value::String(run_id.to_string()),
                );
                match context_metadata {
                    Some(context_metadata) => {
                        extra.insert("last_context_metadata".to_string(), context_metadata);
                    }
                    None => {
                        extra.remove("last_context_metadata");
                    }
                }
            }
            let messages_after = session
                .extra
                .get("messages")
                .and_then(Value::as_array)
                .map_or(messages_before, Vec::len);
            session.updated_at = now_session_timestamp();
            PersistTurnResult {
                session_id: session.session_id.clone(),
                messages_before,
                messages_after,
                saved_message_count,
                saved_messages,
                checkpoint_cleared,
                duplicate_message_count,
                truncated_tool_result_count: 0,
                omitted_side_effects: default_omitted_side_effects(),
            }
        };
        self.persist_sessions()?;
        Ok(result)
    }
}
