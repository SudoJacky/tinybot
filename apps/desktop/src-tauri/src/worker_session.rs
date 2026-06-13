use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
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

    pub fn clear_session(
        &mut self,
        session_id: &str,
    ) -> Result<ClearSessionResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
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
        Ok(ClearSessionResult {
            session_id: session.session_id.clone(),
            messages_before,
            messages_after: 0,
            checkpoint_cleared,
            session: session.clone(),
        })
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
        let Some(session) = self
            .sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
        else {
            return Err(unknown_session_error(session_id));
        };
        let Some(patch) = metadata.as_object() else {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "session metadata patch must be a JSON object",
                serde_json::json!({ "session_id": session_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
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
        Ok(session.clone())
    }

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
        Ok(serde_json::json!({
            "session_id": session_id,
            "cleared": cleared,
            "temporary_files": [],
        }))
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
        Ok(session.clone())
    }

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
        Ok(session.clone())
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
                existing.push(message);
                saved_message_count += 1;
            }
        }
        let mut checkpoint_cleared = false;
        if clear_checkpoint {
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
        Ok(PersistTurnResult {
            session_id: session.session_id.clone(),
            messages_before,
            messages_after,
            saved_message_count,
            checkpoint_cleared,
            duplicate_message_count,
            truncated_tool_result_count: 0,
            omitted_side_effects: default_omitted_side_effects(),
        })
    }

    pub fn trim_session(
        &mut self,
        session_id: &str,
        keep_recent_messages: usize,
    ) -> Result<TrimSessionResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_session_id(session_id)?;
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
        Ok(TrimSessionResult {
            session_id: session.session_id.clone(),
            messages_before,
            messages_after,
            session: session.clone(),
        })
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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PersistTurnResult {
    pub session_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub saved_message_count: usize,
    pub checkpoint_cleared: bool,
    pub duplicate_message_count: usize,
    pub truncated_tool_result_count: usize,
    pub omitted_side_effects: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClearSessionResult {
    pub session_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub checkpoint_cleared: bool,
    pub session: SessionMetadata,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TrimSessionResult {
    pub session_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub session: SessionMetadata,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeleteSessionResult {
    pub session_id: String,
    pub deleted: bool,
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

fn session_message_key(message: &Value) -> String {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let key = match role {
        "tool" => serde_json::json!(["tool", message_field(message, "toolCallId", "tool_call_id")]),
        "assistant" => serde_json::json!([
            "assistant",
            message.get("content").cloned().unwrap_or(Value::Null),
            normalized_tool_calls_for_key(message),
        ]),
        "user" => serde_json::json!([
            "user",
            message.get("content").cloned().unwrap_or(Value::Null),
        ]),
        _ => serde_json::json!([role, message.get("content").cloned().unwrap_or(Value::Null),]),
    };
    serde_json::to_string(&key).unwrap_or_default()
}

fn message_field(message: &Value, camel: &str, snake: &str) -> Value {
    message
        .get(camel)
        .or_else(|| message.get(snake))
        .cloned()
        .unwrap_or(Value::Null)
}

fn normalized_tool_calls_for_key(message: &Value) -> Value {
    let Some(tool_calls) = message_array_any(message, &["toolCalls", "tool_calls"]) else {
        return Value::Null;
    };
    Value::Array(
        tool_calls
            .iter()
            .map(normalized_tool_call_for_key)
            .collect(),
    )
}

fn normalized_tool_call_for_key(tool_call: &Value) -> Value {
    let function = tool_call.get("function").and_then(Value::as_object);
    serde_json::json!({
        "id": message_string(tool_call, "id"),
        "name": message_string(tool_call, "name")
            .or_else(|| function.and_then(|payload| payload.get("name")).and_then(Value::as_str).map(str::to_string)),
        "arguments": message_string(tool_call, "argumentsJson")
            .or_else(|| message_string(tool_call, "arguments_json"))
            .or_else(|| function.and_then(|payload| payload.get("arguments")).and_then(Value::as_str).map(str::to_string)),
    })
}

fn project_history_messages(
    messages: &[Value],
    last_consolidated: usize,
    limit: usize,
) -> Vec<Value> {
    let unconsolidated_start = last_consolidated.min(messages.len());
    let unconsolidated = &messages[unconsolidated_start..];
    let limit_start = unconsolidated.len().saturating_sub(limit);
    let mut sliced = &unconsolidated[limit_start..];
    if let Some(first_user) = sliced
        .iter()
        .position(|message| message_role(message) == Some("user"))
    {
        sliced = &sliced[first_user..];
    }
    let legal_start = find_legal_message_start(sliced);
    sliced[legal_start..]
        .iter()
        .filter(|message| !is_progress_message(message))
        .filter_map(project_history_message)
        .collect()
}

fn recent_legal_suffix(messages: &[Value], keep_recent_messages: usize) -> Vec<Value> {
    if messages.len() <= keep_recent_messages {
        return messages.to_vec();
    }
    let mut start_idx = messages.len().saturating_sub(keep_recent_messages);
    while start_idx > 0 && message_role(&messages[start_idx]) != Some("user") {
        start_idx -= 1;
    }
    let retained = &messages[start_idx..];
    let legal_start = find_legal_message_start(retained);
    retained[legal_start..].to_vec()
}

fn session_last_consolidated(session: &SessionMetadata) -> usize {
    session
        .extra
        .get("last_consolidated")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or_default()
}

fn temporary_chunk_count(content: &str) -> usize {
    let len = content.chars().count();
    if len == 0 {
        0
    } else {
        len.div_ceil(900)
    }
}

fn stable_upload_digest(session_id: &str, name: &str, timestamp: &str, content: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    session_id.hash(&mut hasher);
    name.hash(&mut hasher);
    timestamp.hash(&mut hasher);
    content
        .chars()
        .take(200)
        .collect::<String>()
        .hash(&mut hasher);
    format!("{:010x}", hasher.finish())[..10].to_string()
}

fn find_legal_message_start(messages: &[Value]) -> usize {
    let mut declared: Vec<String> = Vec::new();
    let mut start = 0;
    for (index, message) in messages.iter().enumerate() {
        match message_role(message) {
            Some("assistant") => {
                for tool_call_id in assistant_tool_call_ids(message) {
                    if !declared.contains(&tool_call_id) {
                        declared.push(tool_call_id);
                    }
                }
            }
            Some("tool") => {
                if let Some(tool_call_id) =
                    message_string_any(message, &["tool_call_id", "toolCallId"])
                {
                    if !declared.contains(&tool_call_id) {
                        start = index + 1;
                        declared.clear();
                        for previous in &messages[start..=index] {
                            if message_role(previous) == Some("assistant") {
                                for previous_tool_call_id in assistant_tool_call_ids(previous) {
                                    if !declared.contains(&previous_tool_call_id) {
                                        declared.push(previous_tool_call_id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    start
}

fn project_history_message(message: &Value) -> Option<Value> {
    let object = message.as_object()?;
    let role = object.get("role")?.as_str()?;
    let mut projected = serde_json::Map::new();
    projected.insert("role".to_string(), Value::String(role.to_string()));
    projected.insert(
        "content".to_string(),
        object
            .get("content")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    for key in [
        "tool_calls",
        "toolCalls",
        "tool_call_id",
        "toolCallId",
        "name",
        "reasoning_content",
        "reasoningContent",
        "thinking_blocks",
        "thinkingBlocks",
    ] {
        if let Some(value) = object.get(key) {
            projected.insert(key.to_string(), value.clone());
        }
    }
    Some(Value::Object(projected))
}

fn assistant_tool_call_ids(message: &Value) -> Vec<String> {
    message_array_any(message, &["tool_calls", "toolCalls"])
        .map(|tool_calls| {
            tool_calls
                .iter()
                .filter_map(|tool_call| message_string(tool_call, "id"))
                .collect()
        })
        .unwrap_or_default()
}

fn is_progress_message(message: &Value) -> bool {
    message_role(message) == Some("progress")
        || message
            .get("_task_event")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn message_string(message: &Value, key: &str) -> Option<String> {
    message.get(key).and_then(Value::as_str).map(str::to_string)
}

fn message_string_any(message: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| message_string(message, key))
}

fn message_array_any<'a>(message: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter()
        .find_map(|key| message.get(key).and_then(Value::as_array))
}

fn now_session_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("unix-ms:{millis}")
}

fn default_omitted_side_effects() -> Vec<String> {
    [
        "conversation_evidence",
        "memory_extraction",
        "consolidation",
        "user_profile_update",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
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
    fn clear_session_resets_messages_profile_and_checkpoint_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "last_consolidated": 1,
            "user_profile": { "name": "Ada" },
            "runtime_checkpoint": { "phase": "awaiting_tools" },
            "last_context_metadata": { "historyMessageCount": 2 },
            "last_persisted_run_id": "run-1"
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let result = rpc
            .clear_session("session-1")
            .expect("session should clear");

        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.messages_before, 2);
        assert_eq!(result.messages_after, 0);
        assert!(result.checkpoint_cleared);
        assert_eq!(result.session.extra["messages"], json!([]));
        assert_eq!(result.session.extra["last_consolidated"], json!(0));
        assert_eq!(result.session.extra["user_profile"], json!({}));
        assert!(result.session.extra.get("runtime_checkpoint").is_none());
        assert!(result.session.extra.get("last_context_metadata").is_none());
        assert!(result.session.extra.get("last_persisted_run_id").is_none());
    }

    #[test]
    fn delete_session_removes_existing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], write_policy());

        let result = rpc
            .delete_session("session-1")
            .expect("session should delete");

        assert_eq!(result.session_id, "session-1");
        assert!(result.deleted);
        assert!(rpc.get_metadata("session-1").is_err());
    }

    #[test]
    fn delete_session_reports_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], write_policy());

        let result = rpc
            .delete_session("missing-session")
            .expect("missing session delete should be reported");

        assert_eq!(result.session_id, "missing-session");
        assert!(!result.deleted);
    }

    #[test]
    fn patch_metadata_merges_existing_metadata_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "metadata": {
                "pinned": false,
                "topic": "old"
            },
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .patch_metadata("session-1", json!({ "pinned": true }))
            .expect("metadata should patch");

        assert_eq!(updated.session_id, "session-1");
        assert_eq!(updated.extra["metadata"]["pinned"], json!(true));
        assert_eq!(updated.extra["metadata"]["topic"], json!("old"));
        assert_eq!(
            updated.extra["messages"],
            json!([{ "role": "user", "content": "hello" }])
        );
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
            vec![json!({ "role": "user", "content": "third" })]
        );
        assert_eq!(
            history.user_profile,
            json!({ "name": "Ada", "preferences": ["concise"] })
        );
    }

    #[test]
    fn get_history_projects_from_legal_user_and_tool_boundary() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "tool", "content": "orphan", "tool_call_id": "orphan-call", "name": "read_file" },
                { "role": "assistant", "content": "previous answer" },
                { "role": "user", "content": "run a task" },
                { "role": "progress", "content": "Task Progress", "_task_event": true },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done", "_task_event": true },
                { "role": "assistant", "content": "final done" }
            ]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 80)
            .expect("history should read");

        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "user", "content": "run a task" }),
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                }),
                json!({ "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" }),
                json!({ "role": "assistant", "content": "final done" })
            ]
        );
    }

    #[test]
    fn get_history_preserves_camel_case_model_fields() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "inspect" },
                {
                    "role": "assistant",
                    "content": "",
                    "reasoningContent": "Need a tool.",
                    "thinkingBlocks": [{ "type": "thinking", "text": "trace" }],
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                },
                { "role": "tool", "content": "README", "toolCallId": "call-read", "name": "read_file" }
            ]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 80)
            .expect("history should preserve model fields");

        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "user", "content": "inspect" }),
                json!({
                    "role": "assistant",
                    "content": "",
                    "reasoningContent": "Need a tool.",
                    "thinkingBlocks": [{ "type": "thinking", "text": "trace" }],
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                }),
                json!({ "role": "tool", "content": "README", "toolCallId": "call-read", "name": "read_file" })
            ]
        );
    }

    #[test]
    fn get_history_uses_camel_case_tool_calls_for_legal_boundary() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "inspect" },
                {
                    "role": "assistant",
                    "content": "",
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done" }
            ]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 80)
            .expect("history should keep legal camelCase tool-call pairs");

        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "user", "content": "inspect" }),
                json!({
                    "role": "assistant",
                    "content": "",
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                }),
                json!({ "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" }),
                json!({ "role": "assistant", "content": "done" })
            ]
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
    fn append_messages_skips_duplicate_session_messages_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .append_messages(
                "session-1",
                vec![
                    json!({ "role": "user", "content": "hello" }),
                    json!({ "role": "assistant", "content": "next" }),
                    json!({ "role": "tool", "tool_call_id": "call-1", "name": "lookup", "content": "new" }),
                ],
            )
            .expect("messages should append without duplicating existing session history");

        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" },
                { "role": "assistant", "content": "next" }
            ])
        );
    }

    #[test]
    fn append_messages_dedupes_equivalent_tool_calls_across_field_shapes() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{}" }
                        }
                    ]
                }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .append_messages(
                "session-1",
                vec![
                    json!({
                        "role": "assistant",
                        "content": "",
                        "toolCalls": [
                            {
                                "id": "call-1",
                                "name": "lookup",
                                "argumentsJson": "{}"
                            }
                        ]
                    }),
                    json!({ "role": "assistant", "content": "done" }),
                ],
            )
            .expect("equivalent tool call messages should dedupe across field shapes");

        assert_eq!(
            updated.extra["messages"],
            json!([
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "assistant", "content": "done" }
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
    fn trim_session_keeps_recent_legal_suffix_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "last_consolidated": 2,
            "messages": [
                { "role": "user", "content": "old question" },
                { "role": "assistant", "content": "old answer" },
                { "role": "tool", "content": "orphan", "tool_call_id": "orphan-call", "name": "read_file" },
                { "role": "assistant", "content": "previous answer" },
                { "role": "user", "content": "run heartbeat task" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let result = rpc
            .trim_session("session-1", 3)
            .expect("session should trim to a legal suffix");

        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.messages_before, 8);
        assert_eq!(result.messages_after, 4);
        assert_eq!(result.session.extra["last_consolidated"], json!(0));
        assert_eq!(
            result.session.extra["messages"],
            json!([
                { "role": "user", "content": "run heartbeat task" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done" }
            ])
        );
    }

    #[test]
    fn trim_session_zero_clears_session_like_python_retain_suffix() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "last_consolidated": 1,
            "user_profile": { "name": "Ada" },
            "runtime_checkpoint": { "phase": "awaiting_tools" },
            "last_context_metadata": { "historyMessageCount": 2 },
            "last_persisted_run_id": "run-1"
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let result = rpc
            .trim_session("session-1", 0)
            .expect("zero trim should clear session state");

        assert_eq!(result.messages_before, 2);
        assert_eq!(result.messages_after, 0);
        assert_eq!(result.session.extra["messages"], json!([]));
        assert_eq!(result.session.extra["last_consolidated"], json!(0));
        assert_eq!(result.session.extra["user_profile"], json!({}));
        assert!(result.session.extra.get("runtime_checkpoint").is_none());
        assert!(result.session.extra.get("last_context_metadata").is_none());
        assert!(result.session.extra.get("last_persisted_run_id").is_none());
    }

    #[test]
    fn upsert_task_progress_updates_existing_progress_message() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "existing" },
                {
                    "role": "progress",
                    "content": "old progress",
                    "_task_event": true,
                    "_task_plan_id": "plan-1",
                    "_task_progress": { "completed": 0 }
                }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .upsert_task_progress(
                "session-1",
                "plan-1",
                json!({ "completed": 1, "total": 2 }),
                "new progress".to_string(),
            )
            .expect("task progress should upsert");

        let messages = updated.extra["messages"]
            .as_array()
            .expect("messages should be an array");
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0],
            json!({ "role": "user", "content": "existing" })
        );
        assert_eq!(messages[1]["role"], "progress");
        assert_eq!(messages[1]["content"], "new progress");
        assert_eq!(messages[1]["_progress"], true);
        assert_eq!(messages[1]["_task_event"], true);
        assert_eq!(
            messages[1]["_task_progress"],
            json!({ "completed": 1, "total": 2 })
        );
        assert_eq!(messages[1]["_task_plan_id"], "plan-1");
        assert_eq!(messages[1]["_tool_name"], "task");
        assert!(messages[1]["timestamp"].is_string());
    }

    #[test]
    fn upsert_task_progress_creates_progress_message() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .upsert_task_progress(
                "desktop:chat-1",
                "plan-1",
                json!({ "completed": 0, "total": 2 }),
                "progress".to_string(),
            )
            .expect("task progress should create session and message");

        assert_eq!(updated.session_id, "desktop:chat-1");
        let messages = updated.extra["messages"]
            .as_array()
            .expect("messages should be an array");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "progress");
        assert_eq!(messages[0]["content"], "progress");
        assert_eq!(messages[0]["_progress"], true);
        assert_eq!(messages[0]["_task_event"], true);
        assert_eq!(
            messages[0]["_task_progress"],
            json!({ "completed": 0, "total": 2 })
        );
        assert_eq!(messages[0]["_task_plan_id"], "plan-1");
        assert_eq!(messages[0]["_tool_name"], "task");
        assert!(messages[0]["timestamp"].is_string());
    }

    #[test]
    fn persist_turn_appends_messages_and_clears_checkpoint() {
        let mut session = session_fixture();
        session.extra = json!({
            "runtime_checkpoint": { "phase": "tools_completed" },
            "messages": [
                { "role": "user", "content": "existing" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let result = rpc
            .persist_turn(
                "session-1",
                "run-1",
                vec![
                    json!({ "role": "user", "content": "hello" }),
                    json!({ "role": "assistant", "content": "done" }),
                ],
                true,
                Some(json!({
                    "historyMessageCount": 1,
                    "bridge": {
                        "missingSession": false
                    }
                })),
            )
            .expect("turn should persist");

        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.messages_before, 1);
        assert_eq!(result.messages_after, 3);
        assert_eq!(result.saved_message_count, 2);
        assert!(result.checkpoint_cleared);
        assert_eq!(result.duplicate_message_count, 0);
        assert_eq!(result.truncated_tool_result_count, 0);
        assert_eq!(
            result.omitted_side_effects,
            vec![
                "conversation_evidence",
                "memory_extraction",
                "consolidation",
                "user_profile_update"
            ]
        );
        let updated = rpc.get_metadata("session-1").expect("session should exist");
        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "existing" },
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ])
        );
        assert!(updated.extra.get("runtime_checkpoint").is_none());
        assert_eq!(updated.extra["last_persisted_run_id"], "run-1");
        assert_eq!(
            updated.extra["last_context_metadata"],
            json!({
                "historyMessageCount": 1,
                "bridge": {
                    "missingSession": false
                }
            })
        );
    }

    #[test]
    fn persist_turn_skips_duplicate_session_messages() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let result = rpc
            .persist_turn(
                "session-1",
                "run-duplicate-1",
                vec![
                    json!({ "role": "user", "content": "hello" }),
                    json!({ "role": "assistant", "content": "next" }),
                    json!({ "role": "tool", "tool_call_id": "call-1", "name": "lookup", "content": "new" }),
                ],
                false,
                None,
            )
            .expect("turn should persist");

        assert_eq!(result.messages_before, 3);
        assert_eq!(result.messages_after, 4);
        assert_eq!(result.saved_message_count, 1);
        assert_eq!(result.duplicate_message_count, 2);
        let updated = rpc.get_metadata("session-1").expect("session should exist");
        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" },
                { "role": "assistant", "content": "next" }
            ])
        );
    }

    #[test]
    fn persist_turn_dedupes_equivalent_tool_calls_across_field_shapes() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{}" }
                        }
                    ]
                }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let result = rpc
            .persist_turn(
                "session-1",
                "run-1",
                vec![
                    json!({
                        "role": "assistant",
                        "content": "",
                        "toolCalls": [
                            {
                                "id": "call-1",
                                "name": "lookup",
                                "argumentsJson": "{}"
                            }
                        ]
                    }),
                    json!({ "role": "assistant", "content": "done" }),
                ],
                false,
                None,
            )
            .expect("equivalent tool call messages should dedupe across field shapes");

        assert_eq!(result.messages_before, 1);
        assert_eq!(result.messages_after, 2);
        assert_eq!(result.saved_message_count, 1);
        assert_eq!(result.duplicate_message_count, 1);
        let updated = rpc.get_metadata("session-1").expect("session should exist");
        assert_eq!(updated.extra["messages"].as_array().map(Vec::len), Some(2));
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

    #[test]
    fn upload_temporary_file_adds_python_shaped_session_document() {
        let mut session = session_fixture();
        session.session_id = "websocket:chat-1".to_string();
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let doc = rpc
            .upload_temporary_file("websocket:chat-1", "context.md", "md", "hello native", 12)
            .expect("temporary upload should be stored");

        assert_eq!(doc["name"], "context.md");
        assert_eq!(doc["file_type"], "md");
        assert_eq!(doc["content"], "hello native");
        assert_eq!(doc["chunk_count"], 1);
        assert_eq!(doc["size_bytes"], 12);
        assert_eq!(doc["temporary"], true);

        let updated = rpc
            .get_metadata("websocket:chat-1")
            .expect("session should exist");
        assert_eq!(updated.extra["temporary_files"][0], doc);
    }

    #[test]
    fn default_policy_denies_task_progress_upsert() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .upsert_task_progress(
                "session-1",
                "plan-1",
                json!({ "completed": 1 }),
                "progress".to_string(),
            )
            .expect_err("progress upsert should require session write capability");

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
