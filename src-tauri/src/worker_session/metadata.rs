impl WorkerSessionRpc {
    pub fn new(sessions: Vec<SessionMetadata>, policy: CapabilityPolicy) -> Self {
        Self {
            sessions,
            policy,
            store_path: None,
        }
    }

    pub fn new_persistent(
        root: PathBuf,
        sessions: Vec<SessionMetadata>,
        policy: CapabilityPolicy,
    ) -> Result<Self, WorkerProtocolError> {
        let store_path = session_store_path(&root);
        let sessions = match read_session_store(&store_path) {
            Ok(Some(store)) => store.sessions,
            Ok(None) | Err(_) => sessions,
        };
        Ok(Self {
            sessions,
            policy,
            store_path: Some(store_path),
        })
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

    pub fn clear_session(
        &mut self,
        session_id: &str,
    ) -> Result<ClearSessionResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let result = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            let messages_before = session
                .extra
                .get("messages")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let checkpoint_cleared = session.extra.get("runtime_checkpoint").is_some();
            if let Some(extra) = session.extra.as_object_mut() {
                extra.insert("messages".to_string(), serde_json::json!([]));
                extra.insert("last_consolidated".to_string(), serde_json::json!(0));
                extra.insert("user_profile".to_string(), serde_json::json!({}));
                extra.remove("temporary_files");
                extra.remove("runtime_checkpoint");
                extra.remove("last_context_metadata");
                extra.remove("last_persisted_run_id");
            }
            session.updated_at = now_session_timestamp();
            ClearSessionResult {
                session_id: session.session_id.clone(),
                messages_before,
                messages_after: 0,
                checkpoint_cleared,
                session: session.clone(),
            }
        };
        self.persist_sessions()?;
        Ok(result)
    }

    pub fn delete_session(
        &mut self,
        session_id: &str,
    ) -> Result<DeleteSessionResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let deleted = if let Some(index) = self
            .sessions
            .iter()
            .position(|session| session.session_id == session_id)
        {
            self.sessions.remove(index);
            true
        } else {
            false
        };
        if deleted {
            self.persist_sessions()?;
        }
        Ok(DeleteSessionResult {
            session_id: session_id.to_string(),
            deleted,
        })
    }

    pub fn patch_metadata(
        &mut self,
        session_id: &str,
        metadata: Value,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let Some(patch) = metadata.as_object() else {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "session metadata patch must be a JSON object",
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
            if !session.extra.get("metadata").is_some_and(Value::is_object) {
                session.extra["metadata"] = serde_json::json!({});
            }
            if let Some(existing) = session
                .extra
                .get_mut("metadata")
                .and_then(Value::as_object_mut)
            {
                for (key, value) in patch {
                    existing.insert(key.clone(), value.clone());
                }
            }
            session.updated_at = now_session_timestamp();
            session.clone()
        };
        self.persist_sessions()?;
        Ok(session)
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

    fn persist_sessions(&self) -> Result<(), WorkerProtocolError> {
        let Some(store_path) = &self.store_path else {
            return Ok(());
        };
        if let Some(parent) = store_path.parent() {
            fs::create_dir_all(parent).map_err(session_io_error)?;
        }
        let store = SessionStore {
            version: 1,
            sessions: self.sessions.clone(),
        };
        let contents = serde_json::to_string_pretty(&store).map_err(session_serialization_error)?;
        fs::write(store_path, format!("{contents}\n")).map_err(session_io_error)
    }
}
