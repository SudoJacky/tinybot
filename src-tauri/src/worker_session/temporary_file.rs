use super::*;

impl WorkerSessionRpc {
    pub fn upload_temporary_file(
        &mut self,
        session_id: &str,
        name: &str,
        file_type: &str,
        content: &str,
        size_bytes: u64,
    ) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        if !session_id.starts_with("websocket:") {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "temporary files are only supported for websocket sessions",
                serde_json::json!({ "session_id": session_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "file is required",
                serde_json::json!({ "session_id": session_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let clean_file_type = file_type.trim().trim_start_matches('.').to_lowercase();
        if !matches!(clean_file_type.as_str(), "txt" | "md" | "pdf") {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "supported temporary file types: txt, md, pdf",
                serde_json::json!({ "file_type": clean_file_type }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        if content.trim().is_empty() {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "Uploaded file contains no extractable text",
                serde_json::json!({ "session_id": session_id, "name": clean_name }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }

        let document = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            if !session
                .extra
                .get("temporary_files")
                .is_some_and(Value::is_array)
            {
                session.extra["temporary_files"] = serde_json::json!([]);
            }
            let timestamp = now_session_timestamp();
            let digest = stable_upload_digest(session_id, clean_name, &timestamp, content);
            let chunk_count = temporary_chunk_count(content);
            let document = serde_json::json!({
                "id": format!("session_doc_{digest}"),
                "name": clean_name,
                "file_type": clean_file_type,
                "content": content,
                "created_at": timestamp,
                "chunk_count": chunk_count,
                "metadata": { "size_bytes": size_bytes },
                "size_bytes": size_bytes,
                "source": "session_upload",
                "temporary": true,
            });
            if let Some(files) = session
                .extra
                .get_mut("temporary_files")
                .and_then(Value::as_array_mut)
            {
                files.push(document.clone());
            }
            session.updated_at = timestamp;
            document
        };
        self.persist_sessions()?;
        Ok(document)
    }

    pub fn list_temporary_files(&self, session_id: &str) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_session_id(session_id)?;
        let session = self
            .sessions
            .iter()
            .find(|session| session.session_id == session_id)
            .ok_or_else(|| unknown_session_error(session_id))?;
        let temporary_files = session
            .extra
            .get("temporary_files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(serde_json::json!({
            "session_id": session_id,
            "temporary_files": temporary_files,
        }))
    }

    pub fn clear_temporary_files(
        &mut self,
        session_id: &str,
    ) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
        let result = {
            let session = self.session_mut_or_create(session_id);
            ensure_extra_object(session);
            let cleared = session
                .extra
                .get("temporary_files")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if let Some(extra) = session.extra.as_object_mut() {
                extra.insert("temporary_files".to_string(), serde_json::json!([]));
            }
            session.updated_at = now_session_timestamp();
            serde_json::json!({
                "session_id": session_id,
                "cleared": cleared,
                "temporary_files": [],
            })
        };
        self.persist_sessions()?;
        Ok(result)
    }
}
