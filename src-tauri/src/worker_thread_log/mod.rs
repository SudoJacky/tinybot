mod agent_run;
mod reader;
mod recorder;
mod replay;
mod session_adapter;
mod state_db;
mod types;

use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_session::{
    ClearSessionResult, DeleteSessionResult, PersistTurnResult, SessionHistoryProjection,
    SessionMetadata,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub use self::reader::read_thread_lines;
use self::recorder::is_canonical_thread_log_path;
pub use self::recorder::{now_thread_timestamp, value_event, ThreadRecorder};
pub use self::replay::replay_thread;
pub use self::session_adapter::{history_from_replay, metadata_from_state};
pub use self::state_db::ThreadStateDb;
pub use self::types::{
    ThreadLogItem, ThreadLogLine, ThreadMeta, ThreadReplay, ThreadStateRecord, TokenUsage,
    TokenUsageInfo, THREAD_LOG_SCHEMA_VERSION,
};

#[derive(Clone, Debug)]
pub struct WorkerThreadLogRpc {
    recorder: ThreadRecorder,
    state: ThreadStateDb,
    thread_root: PathBuf,
    policy: CapabilityPolicy,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecoveryEntry {
    pub session_id: String,
    pub run_id: String,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecoveryReport {
    pub scanned_sessions: usize,
    pub scanned_runs: usize,
    pub interrupted_runs: Vec<AgentRunRecoveryEntry>,
    pub awaiting_interaction_runs: Vec<AgentRunRecoveryEntry>,
    pub resumable_runs: Vec<AgentRunRecoveryEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadLogIndexConsistencyStatus {
    Clean,
    MissingIndex,
    Diverged,
    Unreadable,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLogIndexConsistencyReport {
    pub status: ThreadLogIndexConsistencyStatus,
    pub canonical_thread_count: usize,
    pub indexed_thread_count: usize,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadLogIndexRepairMode {
    RebuildIndex,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLogIndexRepairRequest {
    pub mode: ThreadLogIndexRepairMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLogIndexRepairReport {
    pub mode: ThreadLogIndexRepairMode,
    pub before: ThreadLogIndexConsistencyReport,
    pub after: ThreadLogIndexConsistencyReport,
    pub rebuilt_thread_count: usize,
}

impl WorkerThreadLogRpc {
    pub fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self {
            recorder: ThreadRecorder::new(workspace_root.clone()),
            thread_root: workspace_root.join(".tinybot").join("threads"),
            state: ThreadStateDb::new(workspace_root),
            policy,
        }
    }

    pub fn list_session_metadata(&self) -> Result<Vec<SessionMetadata>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.ensure_state_index()?;
        self.state
            .list_threads()
            .map(|records| records.into_iter().map(metadata_from_state).collect())
    }

    pub fn get_session_metadata(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionMetadata>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.ensure_state_index()?;
        let Some(record) = self.find_live_record(session_id)? else {
            return Ok(None);
        };
        Ok(Some(metadata_from_state(record)))
    }

    pub fn get_session_metadata_for_write_response(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionMetadata>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(record) = self.find_live_record(session_id)? else {
            return Ok(None);
        };
        Ok(Some(metadata_from_state(record)))
    }

    pub fn get_session_history(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Option<SessionHistoryProjection>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.ensure_state_index()?;
        let Some(record) = self.find_live_record(session_id)? else {
            return Ok(None);
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let lines = read_thread_lines(&path)?;
        let replay = replay_thread(&lines)?;
        Ok(Some(history_from_replay(replay, limit)))
    }

    pub fn check_state_index(
        &self,
    ) -> Result<ThreadLogIndexConsistencyReport, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.state_index_consistency()
    }

    pub fn repair_state_index(
        &self,
        mode: ThreadLogIndexRepairMode,
    ) -> Result<ThreadLogIndexRepairReport, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let before = self.state_index_consistency()?;
        let canonical = self.canonical_state_records()?;
        match mode {
            ThreadLogIndexRepairMode::RebuildIndex => {
                self.state.reset()?;
                for record in &canonical {
                    self.state.upsert_thread(record)?;
                }
            }
        }
        let after = self.state_index_consistency()?;
        if after.status != ThreadLogIndexConsistencyStatus::Clean {
            return Err(thread_log_consistency_error(
                "thread log index repair did not produce a clean index",
                serde_json::to_value(&after).unwrap_or_default(),
            ));
        }
        Ok(ThreadLogIndexRepairReport {
            mode,
            before,
            after,
            rebuilt_thread_count: canonical.len(),
        })
    }

    pub fn prepare_state_index_for_startup(
        &self,
    ) -> Result<Option<ThreadLogIndexRepairReport>, WorkerProtocolError> {
        let report = self.state_index_consistency()?;
        match report.status {
            ThreadLogIndexConsistencyStatus::Clean => Ok(None),
            ThreadLogIndexConsistencyStatus::MissingIndex => self
                .repair_state_index(ThreadLogIndexRepairMode::RebuildIndex)
                .map(Some),
            ThreadLogIndexConsistencyStatus::Diverged
            | ThreadLogIndexConsistencyStatus::Unreadable => Err(thread_log_consistency_error(
                "thread log and SQLite state index diverged; run session.persistence.repair explicitly",
                serde_json::to_value(report).unwrap_or_default(),
            )),
        }
    }

    fn ensure_state_index(&self) -> Result<(), WorkerProtocolError> {
        let report = self.state_index_consistency()?;
        if report.status == ThreadLogIndexConsistencyStatus::Clean {
            Ok(())
        } else {
            Err(thread_log_consistency_error(
                "thread log state index is not consistent; run session.persistence.repair explicitly",
                serde_json::to_value(report).unwrap_or_default(),
            ))
        }
    }

    fn find_live_record(
        &self,
        session_id: &str,
    ) -> Result<Option<ThreadStateRecord>, WorkerProtocolError> {
        let record = self.state.find_by_session_or_thread_id(session_id)?;
        if let Some(record) = record.as_ref() {
            let path = PathBuf::from(&record.thread_path);
            self.recorder.validate_thread_path(&path)?;
            if !path.exists() {
                return Err(thread_log_consistency_error(
                    "thread log indexed path does not exist",
                    serde_json::json!({
                        "threadId": record.id,
                        "threadPath": record.thread_path,
                    }),
                ));
            }
        }
        Ok(record)
    }

    fn canonical_state_records(&self) -> Result<Vec<ThreadStateRecord>, WorkerProtocolError> {
        let mut paths = Vec::new();
        collect_thread_log_paths(&self.thread_root, &self.thread_root, &mut paths)?;
        let mut records = Vec::with_capacity(paths.len());
        for path in paths {
            self.recorder.validate_thread_path(&path)?;
            let lines = read_thread_lines(&path)?;
            let meta = thread_meta_from_lines(&lines)?;
            let replay = replay_thread(&lines)?;
            let updated_at = state_projection_updated_at(&meta.created_at, &lines);
            let title = if is_default_session_title(&replay.title) {
                title_from_messages(&replay.messages).unwrap_or(replay.title)
            } else {
                replay.title
            };
            let mut record = ThreadStateRecord {
                id: meta.thread_id,
                session_id: meta.session_id,
                thread_path: path.display().to_string(),
                created_at: meta.created_at,
                updated_at: updated_at.clone(),
                source: meta.source,
                title,
                preview: preview_from_messages(&replay.messages),
                cwd: meta.cwd,
                model_provider: meta.model_provider,
                model: meta.model,
                tokens_used: replay
                    .token_usage_info
                    .as_ref()
                    .map(|info| info.total_token_usage.total_tokens)
                    .unwrap_or_default(),
                archived: false,
                archived_at: None,
            };
            apply_metadata_events_to_record(&mut record, &lines)?;
            apply_agent_run_events_to_record(&mut record, &lines)?;
            record.updated_at = updated_at;
            records.push(record);
        }
        records.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(records)
    }

    fn state_index_consistency(
        &self,
    ) -> Result<ThreadLogIndexConsistencyReport, WorkerProtocolError> {
        let canonical = self.canonical_state_records()?;
        if !self.state.path().exists() {
            return Ok(ThreadLogIndexConsistencyReport {
                status: if canonical.is_empty() {
                    ThreadLogIndexConsistencyStatus::Clean
                } else {
                    ThreadLogIndexConsistencyStatus::MissingIndex
                },
                canonical_thread_count: canonical.len(),
                indexed_thread_count: 0,
                diagnostics: (!canonical.is_empty())
                    .then(|| {
                        "canonical thread logs exist but the SQLite state index is missing"
                            .to_string()
                    })
                    .into_iter()
                    .collect(),
            });
        }
        let mut indexed = match self.state.list_all_threads() {
            Ok(indexed) => indexed,
            Err(error) => {
                return Ok(ThreadLogIndexConsistencyReport {
                    status: ThreadLogIndexConsistencyStatus::Unreadable,
                    canonical_thread_count: canonical.len(),
                    indexed_thread_count: 0,
                    diagnostics: vec![error.message],
                });
            }
        };
        indexed.sort_by(|left, right| left.id.cmp(&right.id));
        let status = if canonical == indexed {
            ThreadLogIndexConsistencyStatus::Clean
        } else if indexed.is_empty() && !canonical.is_empty() {
            ThreadLogIndexConsistencyStatus::MissingIndex
        } else {
            ThreadLogIndexConsistencyStatus::Diverged
        };
        let diagnostics = (status != ThreadLogIndexConsistencyStatus::Clean)
            .then(|| "canonical thread log records differ from the SQLite state index".to_string())
            .into_iter()
            .collect();
        Ok(ThreadLogIndexConsistencyReport {
            status,
            canonical_thread_count: canonical.len(),
            indexed_thread_count: indexed.len(),
            diagnostics,
        })
    }

    pub fn persist_session_turn(
        &self,
        session_id: &str,
        run_id: &str,
        messages: Vec<Value>,
    ) -> Result<PersistTurnResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let existing = self.state.find_by_session_or_thread_id(session_id)?;
        let mut record = match existing {
            Some(record) => record,
            None => {
                let thread_id = thread_id_for_session_id(session_id);
                let meta = ThreadMeta {
                    schema_version: THREAD_LOG_SCHEMA_VERSION,
                    thread_id: thread_id.clone(),
                    session_id: Some(session_id.to_string()),
                    created_at: timestamp.clone(),
                    cwd: String::new(),
                    source: "desktop".to_string(),
                    model_provider: None,
                    model: None,
                    base_instructions: None,
                    history_mode: Some("default".to_string()),
                    forked_from_thread_id: None,
                    parent_thread_id: None,
                    originator: Some("Tinybot Desktop".to_string()),
                };
                let path = self.recorder.create_thread(meta)?;
                let record = ThreadStateRecord {
                    id: thread_id.clone(),
                    session_id: Some(session_id.to_string()),
                    thread_path: path.display().to_string(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                    source: "desktop".to_string(),
                    title: "New session".to_string(),
                    preview: String::new(),
                    cwd: String::new(),
                    model_provider: None,
                    model: None,
                    tokens_used: 0,
                    archived: false,
                    archived_at: None,
                };
                self.state.upsert_thread(&record)?;
                record
            }
        };
        let thread_path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&thread_path)?;
        let lines = read_thread_lines(&thread_path)?;
        let replay = replay_thread(&lines)?;
        let messages_before = replay.messages.len();
        let (saved_messages, duplicate_message_count) =
            filter_new_session_messages(&replay.messages, messages);
        match thread_run_state(&thread_path, run_id)? {
            ThreadRunState::Complete if saved_messages.is_empty() => {
                return Ok(PersistTurnResult {
                    session_id: session_id.to_string(),
                    messages_before,
                    messages_after: messages_before,
                    saved_message_count: 0,
                    saved_messages,
                    checkpoint_cleared: false,
                    duplicate_message_count,
                    truncated_tool_result_count: 0,
                    omitted_side_effects: default_omitted_side_effects(),
                });
            }
            ThreadRunState::Complete => {
                return Err(WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "thread log already contains a completed turn for this run_id with different messages",
                    serde_json::json!({
                        "method": "thread_log.persist_turn",
                        "runId": run_id,
                        "threadPath": thread_path.display().to_string()
                    }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                ));
            }
            ThreadRunState::Incomplete => {
                return Err(WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "thread log contains an incomplete turn for this run_id",
                    serde_json::json!({
                        "method": "thread_log.persist_turn",
                        "runId": run_id,
                        "threadPath": thread_path.display().to_string()
                    }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                ));
            }
            ThreadRunState::Missing => {}
        }

        let mut next_messages = replay.messages;
        next_messages.extend(saved_messages.clone());
        let derived_title = is_default_session_title(&record.title)
            .then(|| title_from_messages(&next_messages))
            .flatten();
        let mut turn_items = Vec::with_capacity(saved_messages.len() + 3);
        turn_items.push(value_event(
            "turn_started",
            serde_json::json!({ "runId": run_id }),
        ));
        turn_items.extend(
            saved_messages
                .iter()
                .cloned()
                .map(ThreadLogItem::ResponseItem),
        );
        if let Some(title) = derived_title.as_ref() {
            turn_items.push(value_event(
                "metadata_updated",
                serde_json::json!({ "metadata": { "title": title } }),
            ));
        }
        turn_items.push(value_event(
            "turn_complete",
            serde_json::json!({ "runId": run_id }),
        ));
        self.recorder
            .append_items(&thread_path, timestamp.clone(), turn_items)?;

        let saved_message_count = saved_messages.len();
        let messages_after = messages_before + saved_message_count;
        record.updated_at = timestamp;
        if let Some(title) = derived_title {
            record.title = title;
        }
        record.preview = preview_from_messages(&next_messages);
        self.state.upsert_thread(&record)?;
        Ok(PersistTurnResult {
            session_id: session_id.to_string(),
            messages_before,
            messages_after,
            saved_message_count,
            saved_messages,
            checkpoint_cleared: false,
            duplicate_message_count,
            truncated_tool_result_count: 0,
            omitted_side_effects: default_omitted_side_effects(),
        })
    }

    pub fn append_token_count(
        &self,
        session_id: &str,
        info: TokenUsageInfo,
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(mut record) = self.state.find_by_session_or_thread_id(session_id)? else {
            return Ok(());
        };
        let timestamp = now_thread_timestamp();
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            ThreadLogItem::EventMsg(serde_json::json!({
                "type": "token_count",
                "info": info
            })),
        )?;
        record.updated_at = timestamp;
        record.tokens_used = info.total_token_usage.total_tokens;
        self.state.upsert_thread(&record)
    }

    pub fn clear_session(
        &self,
        session_id: &str,
    ) -> Result<Option<ClearSessionResult>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(mut record) = self.state.find_by_session_or_thread_id(session_id)? else {
            return Ok(None);
        };
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let lines = read_thread_lines(&path)?;
        let replay = replay_thread(&lines)?;
        let timestamp = now_thread_timestamp();
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            ThreadLogItem::Compacted(serde_json::json!({ "replacementHistory": [] })),
        )?;
        let messages_before = replay.messages.len();
        record.updated_at = timestamp.clone();
        record.preview.clear();
        record.tokens_used = 0;
        self.state.upsert_thread(&record)?;
        Ok(Some(ClearSessionResult {
            session_id: record
                .session_id
                .clone()
                .unwrap_or_else(|| record.id.clone()),
            messages_before,
            messages_after: 0,
            checkpoint_cleared: false,
            session: metadata_from_state(record),
        }))
    }

    pub fn delete_session(
        &self,
        session_id: &str,
    ) -> Result<DeleteSessionResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(record) = self.state.find_by_session_or_thread_id(session_id)? else {
            return Ok(DeleteSessionResult {
                session_id: session_id.to_string(),
                deleted: false,
            });
        };
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        if path.exists() {
            fs::remove_file(&path).map_err(thread_log_state_io_error)?;
        }
        let deleted = self.state.delete_thread(&record.id)?;
        Ok(DeleteSessionResult {
            session_id: record.session_id.unwrap_or(record.id),
            deleted,
        })
    }

    pub fn patch_metadata(
        &self,
        session_id: &str,
        metadata: &Value,
    ) -> Result<Option<SessionMetadata>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(mut record) = self.state.find_by_session_or_thread_id(session_id)? else {
            return Ok(None);
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
        let timestamp = now_thread_timestamp();
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            ThreadLogItem::EventMsg(serde_json::json!({
                "type": "metadata_updated",
                "payload": {
                    "metadata": metadata
                }
            })),
        )?;
        apply_metadata_patch_to_record(&mut record, patch, &timestamp);
        self.state.upsert_thread(&record)?;
        Ok(Some(metadata_from_state(record)))
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

fn collect_thread_log_paths(
    thread_root: &Path,
    root: &Path,
    paths: &mut Vec<PathBuf>,
) -> Result<(), WorkerProtocolError> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(thread_log_state_io_error)? {
        let entry = entry.map_err(thread_log_state_io_error)?;
        let path = entry.path();
        if path.is_dir() {
            collect_thread_log_paths(thread_root, &path, paths)?;
        } else if is_canonical_thread_log_path(thread_root, &path) {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(())
}

fn thread_meta_from_lines(lines: &[ThreadLogLine]) -> Result<ThreadMeta, WorkerProtocolError> {
    let meta = lines
        .iter()
        .find_map(|line| match &line.item {
            ThreadLogItem::ThreadMeta(meta) => Some(meta.clone()),
            _ => None,
        })
        .ok_or_else(|| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "thread log is missing thread_meta",
                serde_json::json!({ "method": "thread_log.rebuild_state" }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
    if meta.schema_version > THREAD_LOG_SCHEMA_VERSION {
        return Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            format!(
                "unsupported thread log schema version {}",
                meta.schema_version
            ),
            serde_json::json!({
                "method": "thread_log.read_meta",
                "schemaVersion": meta.schema_version,
                "supportedSchemaVersion": THREAD_LOG_SCHEMA_VERSION,
            }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ));
    }
    Ok(meta)
}

fn is_default_session_title(title: &str) -> bool {
    let title = title.trim();
    title.is_empty() || title == "New session" || title.starts_with("Desktop Session websocket:")
}

fn title_from_messages(messages: &[Value]) -> Option<String> {
    messages.iter().find_map(|message| {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            return None;
        }
        let content = message.get("content").and_then(Value::as_str)?.trim();
        let first_line = content.lines().next()?.trim();
        if first_line.is_empty() {
            return None;
        }
        Some(first_line.chars().take(80).collect())
    })
}

fn preview_from_messages(messages: &[Value]) -> String {
    messages
        .iter()
        .rev()
        .filter_map(|message| message.get("content"))
        .filter_map(|content| {
            content
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(content.to_string()))
        })
        .find(|content| !content.trim().is_empty())
        .map(|content| content.chars().take(160).collect())
        .unwrap_or_default()
}

fn filter_new_session_messages(existing: &[Value], messages: Vec<Value>) -> (Vec<Value>, usize) {
    let mut seen: HashSet<String> = existing.iter().map(session_message_key).collect();
    let mut saved_messages = Vec::new();
    let mut duplicate_message_count = 0;
    for message in messages {
        let key = session_message_key(&message);
        if seen.contains(&key) {
            duplicate_message_count += 1;
            continue;
        }
        seen.insert(key);
        saved_messages.push(message);
    }
    (saved_messages, duplicate_message_count)
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
        _ => serde_json::json!([role, message.get("content").cloned().unwrap_or(Value::Null)]),
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

fn message_string(message: &Value, key: &str) -> Option<String> {
    message.get(key).and_then(Value::as_str).map(str::to_string)
}

fn message_array_any<'a>(message: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter()
        .find_map(|key| message.get(key).and_then(Value::as_array))
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ThreadRunState {
    Missing,
    Incomplete,
    Complete,
}

fn thread_run_state(path: &Path, run_id: &str) -> Result<ThreadRunState, WorkerProtocolError> {
    if !path.exists() {
        return Ok(ThreadRunState::Missing);
    }
    let lines = read_thread_lines(path)?;
    let mut saw_run = false;
    for line in lines {
        match line.item {
            ThreadLogItem::EventMsg(event) => {
                let event_type = event.get("type").and_then(Value::as_str);
                let event_run_id = event
                    .get("payload")
                    .and_then(|payload| payload.get("runId").or_else(|| payload.get("run_id")))
                    .and_then(Value::as_str);
                match (event_type, event_run_id) {
                    (Some("turn_complete"), Some(value)) if value == run_id => {
                        return Ok(ThreadRunState::Complete);
                    }
                    (Some("turn_started"), Some(value)) if value == run_id => {
                        saw_run = true;
                    }
                    _ => {}
                }
            }
            ThreadLogItem::ResponseItem(item) => {
                if item
                    .get("runId")
                    .or_else(|| item.get("run_id"))
                    .and_then(Value::as_str)
                    == Some(run_id)
                {
                    saw_run = true;
                }
            }
            _ => {}
        }
    }
    Ok(if saw_run {
        ThreadRunState::Incomplete
    } else {
        ThreadRunState::Missing
    })
}

fn apply_metadata_events_to_record(
    record: &mut ThreadStateRecord,
    lines: &[ThreadLogLine],
) -> Result<(), WorkerProtocolError> {
    for line in lines {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("metadata_updated") {
            continue;
        }
        let Some(metadata) = event
            .get("payload")
            .and_then(|payload| payload.get("metadata"))
            .and_then(Value::as_object)
        else {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "thread log metadata_updated event is missing metadata object",
                serde_json::json!({
                    "method": "thread_log.rebuild_state",
                    "timestamp": line.timestamp
                }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        };
        apply_metadata_patch_to_record(record, metadata, &line.timestamp);
    }
    Ok(())
}

fn state_projection_updated_at(created_at: &str, lines: &[ThreadLogLine]) -> String {
    let mut updated_at = created_at.to_string();
    for line in lines {
        let advances_projection = match &line.item {
            ThreadLogItem::ResponseItem(_) | ThreadLogItem::Compacted(_) => true,
            ThreadLogItem::EventMsg(event) => matches!(
                event.get("type").and_then(Value::as_str),
                Some(
                    "token_count"
                        | "turn_complete"
                        | "metadata_updated"
                        | "agent_run_upsert"
                        | "agent_run_checkpoint_set"
                        | "agent_run_checkpoint_clear"
                        | "agent_run_terminal"
                )
            ),
            ThreadLogItem::ThreadMeta(_)
            | ThreadLogItem::TurnContext(_)
            | ThreadLogItem::WorldState(_)
            | ThreadLogItem::InterAgentCommunication(_) => false,
        };
        if advances_projection {
            updated_at = line.timestamp.clone();
        }
    }
    updated_at
}

fn apply_agent_run_events_to_record(
    record: &mut ThreadStateRecord,
    lines: &[ThreadLogLine],
) -> Result<(), WorkerProtocolError> {
    for line in lines {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        let payload = event.get("payload").unwrap_or(&Value::Null);
        match event_type {
            "agent_run_upsert" => {
                let run = payload.get("record").ok_or_else(|| {
                    thread_log_consistency_error(
                        "agent_run_upsert event is missing its record",
                        serde_json::json!({ "timestamp": line.timestamp }),
                    )
                })?;
                if let Some(model) = run
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                {
                    record.model = Some(model.to_string());
                }
                record.model_provider = run
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(total_tokens) = run
                    .get("tokenUsageInfo")
                    .and_then(|info| info.get("totalTokenUsage"))
                    .and_then(|usage| usage.get("totalTokens"))
                    .and_then(Value::as_i64)
                {
                    record.tokens_used = total_tokens;
                }
                record.updated_at = line.timestamp.clone();
            }
            "agent_run_checkpoint_set" | "agent_run_checkpoint_clear" => {
                record.updated_at = line.timestamp.clone();
            }
            "agent_run_terminal" => {
                record.updated_at = line.timestamp.clone();
                if let Some(final_content) = payload
                    .get("finalContent")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|content| !content.is_empty())
                {
                    record.preview = final_content.chars().take(160).collect();
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn apply_metadata_patch_to_record(
    record: &mut ThreadStateRecord,
    patch: &serde_json::Map<String, Value>,
    timestamp: &str,
) {
    if let Some(title) = patch
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        record.title = title.to_string();
    }
    if let Some(preview) = patch.get("preview").and_then(Value::as_str) {
        record.preview = preview.to_string();
    }
    if let Some(archived) = patch.get("archived").and_then(Value::as_bool) {
        record.archived = archived;
        record.archived_at = archived.then(|| timestamp.to_string());
    }
    record.updated_at = timestamp.to_string();
}

fn thread_log_state_io_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread log state IO error: {error}"),
        serde_json::json!({ "method": "thread_log.rebuild_state" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_log_consistency_error(message: impl Into<String>, details: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_id_for_session_id(session_id: &str) -> String {
    if is_path_safe_id(session_id) {
        return session_id.to_string();
    }
    let fragment = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(32)
        .collect::<String>();
    let fragment = if fragment.is_empty() {
        "session".to_string()
    } else {
        fragment
    };
    format!("thread-{fragment}-{:016x}", stable_hash(session_id))
}

fn is_path_safe_id(value: &str) -> bool {
    !value.trim().is_empty()
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn stable_hash(value: &str) -> u64 {
    value.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    #[test]
    fn future_thread_log_schema_is_rejected_explicitly() {
        let error = thread_meta_from_lines(&[ThreadLogLine {
            timestamp: "2026-07-10T00:00:00Z".to_string(),
            item: ThreadLogItem::ThreadMeta(ThreadMeta {
                schema_version: THREAD_LOG_SCHEMA_VERSION + 1,
                thread_id: "thread-future-schema".to_string(),
                session_id: None,
                created_at: "2026-07-10T00:00:00Z".to_string(),
                cwd: String::new(),
                source: "test".to_string(),
                model_provider: None,
                model: None,
                base_instructions: None,
                history_mode: None,
                forked_from_thread_id: None,
                parent_thread_id: None,
                originator: None,
            }),
        }])
        .unwrap_err();

        assert!(error
            .message
            .contains("unsupported thread log schema version"));
        assert_eq!(error.details["supportedSchemaVersion"], 1);
    }
}
