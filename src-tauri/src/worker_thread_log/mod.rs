mod agent_run;
mod reader;
mod recorder;
mod rollout_writer;
mod session_adapter;
mod state_db;

use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_session::{
    AgentRunRecord, AgentRunStatus, ClearSessionResult, DeleteSessionResult, PersistTurnResult,
    SessionHistoryProjection, SessionMetadata,
};
use crate::worker_thread::{
    ThreadCheckpoint, ThreadItem, ThreadItemKind, ThreadPagination, ThreadRecord, ThreadRunSummary,
    ThreadSnapshot, ThreadStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static CONTEXT_CHECKPOINT_COMMIT_LOCK: Mutex<()> = Mutex::new(());

pub use self::reader::read_thread_lines;
use self::recorder::ThreadLogHead;
use self::recorder::{canonicalize_thread_timestamp, is_canonical_thread_log_path};
pub use self::recorder::{now_thread_timestamp, value_event, ThreadRecorder};
pub use self::session_adapter::{history_from_replay, metadata_from_state};
pub use self::state_db::ThreadStateDb;
use self::state_db::{LatestContextCheckpointRecord, ThreadLogHeadRecord};
pub use crate::worker_rollout::reconstruct_rollout as replay_thread;
use crate::worker_rollout::reconstruct_transcript as replay_thread_transcript;
pub use crate::worker_rollout::{
    RolloutItem as ThreadLogItem, RolloutLine as ThreadLogLine,
    RolloutReconstruction as ThreadReplay, SessionMeta as ThreadMeta, ThreadStateRecord,
    TokenUsage, TokenUsageInfo,
};
pub const THREAD_LOG_SCHEMA_VERSION: u32 = crate::worker_rollout::ROLLOUT_SCHEMA_VERSION;

#[derive(Clone, Debug)]
pub struct WorkerThreadLogRpc {
    recorder: ThreadRecorder,
    state: ThreadStateDb,
    thread_root: PathBuf,
    archive_root: PathBuf,
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCheckpointCommitResult {
    pub session_id: String,
    pub context_id: String,
    pub committed: bool,
    pub duplicate: bool,
    pub index_synchronized: bool,
    pub index_recovered: bool,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRollbackResult {
    pub thread_id: String,
    pub num_turns: u32,
    pub remaining_message_count: usize,
    pub context_checkpoint_retained: bool,
}

struct DerivedIndexSyncResult {
    synchronized: bool,
    recovered: bool,
    diagnostics: Vec<String>,
}

struct CanonicalThreadState {
    record: ThreadStateRecord,
    latest_checkpoint: Option<LatestContextCheckpointRecord>,
    log_head: ThreadLogHeadRecord,
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
            archive_root: workspace_root.join(".tinybot").join("archived_threads"),
            state: ThreadStateDb::new(workspace_root),
            policy,
        }
    }

    pub fn create_from_thread_record(
        &self,
        thread: &ThreadRecord,
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        if let Some(existing) = self.state.find_by_session_or_thread_id(&thread.thread_id)? {
            let expected_session_id = thread
                .session_key
                .as_deref()
                .unwrap_or(thread.thread_id.as_str());
            if existing.id == thread.thread_id
                && existing.session_id.as_deref() == Some(expected_session_id)
            {
                return self.sync_thread_record_projection(&existing, thread);
            }
            return Err(thread_log_consistency_error(
                "canonical Rollout identity conflicts with thread record",
                serde_json::json!({
                    "threadId": thread.thread_id,
                    "sessionId": expected_session_id,
                    "existingThreadId": existing.id,
                    "existingSessionId": existing.session_id,
                }),
            ));
        }
        let session_id = thread
            .session_key
            .clone()
            .unwrap_or_else(|| thread.thread_id.clone());
        let created_at = canonicalize_thread_timestamp(&thread.created_at)?;
        let updated_at = canonicalize_thread_timestamp(
            thread
                .metadata
                .last_activity_at
                .as_deref()
                .unwrap_or(&thread.updated_at),
        )?;
        let meta = ThreadMeta {
            schema_version: THREAD_LOG_SCHEMA_VERSION,
            thread_id: thread.thread_id.clone(),
            session_id: Some(session_id.clone()),
            created_at: created_at.clone(),
            cwd: thread
                .metadata
                .working_directory
                .clone()
                .unwrap_or_default(),
            source: thread.source.clone(),
            model_provider: None,
            model: thread.metadata.model.clone(),
            base_instructions: None,
            history_mode: Some("default".to_string()),
            forked_from_thread_id: None,
            parent_thread_id: thread.parent_thread_id.clone(),
            originator: Some("Tinybot Desktop".to_string()),
        };
        let path = self.recorder.create_thread(meta)?;
        let result = (|| {
            self.recorder.append_item(
                &path,
                updated_at.clone(),
                value_event(
                    "metadata_updated",
                    serde_json::json!({
                        "metadata": {
                            "title": thread.title,
                            "preview": thread.metadata.preview,
                        },
                        "threadRecord": thread,
                    }),
                ),
            )?;
            let record = ThreadStateRecord {
                id: thread.thread_id.clone(),
                session_id: Some(session_id),
                thread_path: path.display().to_string(),
                created_at: created_at.clone(),
                updated_at,
                source: thread.source.clone(),
                title: thread.title.clone(),
                preview: thread.metadata.preview.clone().unwrap_or_default(),
                cwd: thread
                    .metadata
                    .working_directory
                    .clone()
                    .unwrap_or_default(),
                model_provider: None,
                model: thread.metadata.model.clone(),
                tokens_used: 0,
                archived: false,
                archived_at: None,
            };
            let log_head = self.recorder.thread_log_head(&path)?;
            self.state.upsert_thread_projection(&record, &log_head)
        })();
        if let Err(error) = result {
            if let Err(cleanup_error) = self.recorder.delete_rollout(&path) {
                eprintln!(
                    "canonical_thread_create_cleanup_failed thread_id={} error={}",
                    thread.thread_id, cleanup_error.message
                );
            }
            return Err(error);
        }
        Ok(())
    }

    fn sync_thread_record_projection(
        &self,
        existing: &ThreadStateRecord,
        thread: &ThreadRecord,
    ) -> Result<(), WorkerProtocolError> {
        let target_preview = thread.metadata.preview.clone().unwrap_or_default();
        let target_cwd = thread
            .metadata
            .working_directory
            .clone()
            .unwrap_or_default();
        let mut metadata = serde_json::Map::new();
        if existing.title != thread.title {
            metadata.insert("title".to_string(), Value::String(thread.title.clone()));
        }
        if existing.preview != target_preview {
            metadata.insert("preview".to_string(), Value::String(target_preview));
        }
        if existing.cwd != target_cwd {
            metadata.insert("cwd".to_string(), Value::String(target_cwd));
        }
        if existing.model != thread.metadata.model {
            metadata.insert(
                "model".to_string(),
                thread
                    .metadata
                    .model
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
        }
        if metadata.is_empty() {
            return Ok(());
        }
        let timestamp = canonicalize_thread_timestamp(
            thread
                .metadata
                .last_activity_at
                .as_deref()
                .unwrap_or(&thread.updated_at),
        )?;
        let path = PathBuf::from(&existing.thread_path);
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp,
            value_event(
                "metadata_updated",
                serde_json::json!({
                    "metadata": metadata,
                    "threadRecord": thread,
                }),
            ),
        )?;
        let canonical = self.canonical_thread_state(&path)?;
        self.state.replace_thread_projection(
            &canonical.record,
            canonical.latest_checkpoint.as_ref(),
            &ThreadLogHead {
                byte_length: canonical.log_head.byte_length,
                tail_hash: canonical.log_head.tail_hash,
            },
        )
    }

    pub(crate) fn import_legacy_sessions(
        &self,
        sessions: &[SessionMetadata],
    ) -> Result<(), WorkerProtocolError> {
        if sessions.is_empty() {
            return Ok(());
        }
        self.ensure_state_index()?;
        for session in sessions {
            if self
                .state
                .find_by_session_or_thread_id(&session.session_id)?
                .is_some()
            {
                continue;
            }
            self.import_legacy_session(session)?;
        }
        Ok(())
    }

    fn import_legacy_session(&self, session: &SessionMetadata) -> Result<(), WorkerProtocolError> {
        let created_at = canonicalize_thread_timestamp(&session.created_at)?;
        let updated_at = canonicalize_thread_timestamp(&session.updated_at)?;
        let thread_id = thread_id_for_session_id(&session.session_id);
        let model = session
            .extra
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        let meta = ThreadMeta {
            schema_version: THREAD_LOG_SCHEMA_VERSION,
            thread_id: thread_id.clone(),
            session_id: Some(session.session_id.clone()),
            created_at: created_at.clone(),
            cwd: session.workspace_dir.clone(),
            source: "legacy_session_import".to_string(),
            model_provider: session
                .extra
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string),
            model,
            base_instructions: None,
            history_mode: Some("default".to_string()),
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: Some("Tinybot Desktop".to_string()),
        };
        let path = self.recorder.create_thread(meta)?;
        let result = (|| {
            let mut lines = vec![ThreadLogLine {
                timestamp: updated_at.clone(),
                ordinal: None,
                item: value_event(
                    "metadata_updated",
                    serde_json::json!({
                        "metadata": {
                            "title": session.title,
                            "preview": session.extra.get("preview").cloned().unwrap_or(Value::Null),
                            "userProfile": session.extra.get("user_profile").cloned().unwrap_or_else(|| serde_json::json!({})),
                        },
                        "sessionMetadata": session.extra.get("metadata").cloned().unwrap_or_else(|| serde_json::json!({})),
                        "legacySessionExtra": session.extra,
                    }),
                ),
            }];
            if let Some(messages) = session.extra.get("messages").and_then(Value::as_array) {
                lines.extend(messages.iter().cloned().map(|message| {
                    ThreadLogLine {
                        timestamp: message
                            .get("timestamp")
                            .and_then(Value::as_str)
                            .unwrap_or(updated_at.as_str())
                            .to_string(),
                        ordinal: None,
                        item: ThreadLogItem::ResponseItem(message),
                    }
                }));
            }
            if let Some(runs) = session.extra.get("agent_runs").and_then(Value::as_array) {
                for value in runs {
                    let run: AgentRunRecord =
                        serde_json::from_value(value.clone()).map_err(|error| {
                            thread_log_consistency_error(
                                "legacy session contains an invalid agent run",
                                serde_json::json!({
                                    "sessionId": session.session_id,
                                    "error": error.to_string(),
                                }),
                            )
                        })?;
                    if run.session_id != session.session_id {
                        return Err(thread_log_consistency_error(
                            "legacy agent run session identity does not match its container",
                            serde_json::json!({
                                "sessionId": session.session_id,
                                "runId": run.run_id,
                                "runSessionId": run.session_id,
                            }),
                        ));
                    }
                    lines.push(ThreadLogLine {
                        timestamp: run.updated_at.clone(),
                        ordinal: None,
                        item: value_event("agent_run_upsert", serde_json::json!({ "record": run })),
                    });
                }
            }
            if let Some(checkpoint) = session.extra.get("runtime_checkpoint") {
                let run_id = checkpoint
                    .get("runId")
                    .or_else(|| checkpoint.get("run_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("legacy-checkpoint:{}", session.session_id));
                lines.push(ThreadLogLine {
                    timestamp: updated_at.clone(),
                    ordinal: None,
                    item: value_event(
                        "agent_run_checkpoint_set",
                        serde_json::json!({
                            "sessionId": session.session_id,
                            "runId": run_id,
                            "checkpoint": checkpoint,
                        }),
                    ),
                });
            }
            self.recorder.append_lines(&path, lines)?;
            let canonical = self.canonical_thread_state(&path)?;
            let log_head = ThreadLogHead {
                byte_length: canonical.log_head.byte_length,
                tail_hash: canonical.log_head.tail_hash.clone(),
            };
            self.state.replace_thread_projection(
                &canonical.record,
                canonical.latest_checkpoint.as_ref(),
                &log_head,
            )
        })();
        if let Err(error) = result {
            if let Err(cleanup_error) = self.recorder.delete_rollout(&path) {
                eprintln!(
                    "legacy_session_import_cleanup_failed session_id={} error={}",
                    session.session_id, cleanup_error.message
                );
            }
            return Err(error);
        }
        eprintln!(
            "legacy_session_imported session_id={} thread_id={}",
            session.session_id, thread_id
        );
        Ok(())
    }

    pub fn append_legacy_thread_items(
        &self,
        thread_id: &str,
        items: &[ThreadItem],
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(record) = self.state.find_by_session_or_thread_id(thread_id)? else {
            return Err(thread_log_consistency_error(
                "canonical Rollout is missing for thread append",
                serde_json::json!({ "threadId": thread_id }),
            ));
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let existing = read_thread_lines(&path)?;
        let persisted_item_ids = existing
            .iter()
            .filter_map(thread_item_id_from_rollout_line)
            .collect::<HashSet<_>>();
        let lines = items
            .iter()
            .filter(|item| !persisted_item_ids.contains(item.item_id.as_str()))
            .flat_map(|item| {
                thread_item_to_rollout_items(item)
                    .into_iter()
                    .map(|rollout_item| ThreadLogLine {
                        timestamp: item.created_at.clone(),
                        ordinal: None,
                        item: rollout_item,
                    })
            })
            .collect::<Vec<_>>();
        if lines.is_empty() {
            return Ok(());
        }
        self.recorder.append_lines(&path, lines)?;
        let canonical = self.canonical_thread_state(&path)?;
        let log_head = ThreadLogHead {
            byte_length: canonical.log_head.byte_length,
            tail_hash: canonical.log_head.tail_hash.clone(),
        };
        self.state.replace_thread_projection(
            &canonical.record,
            canonical.latest_checkpoint.as_ref(),
            &log_head,
        )
    }

    pub fn append_turn_context(
        &self,
        session_id: &str,
        context: crate::worker_rollout::TurnContextItem,
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let record = self.ensure_session_record(session_id, &timestamp)?;
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let run_id = context.turn_id.clone().unwrap_or_default();
        let mut items = Vec::with_capacity(2);
        if !run_id.is_empty() && thread_run_state(&path, &run_id)? == ThreadRunState::Missing {
            items.push(value_event(
                "turn_started",
                serde_json::json!({ "runId": run_id }),
            ));
        }
        items.push(ThreadLogItem::TurnContext(context));
        self.recorder.append_items(&path, timestamp, items)?;
        let log_head = self.recorder.thread_log_head(&path)?;
        self.state.upsert_thread_projection(&record, &log_head)
    }

    pub fn append_world_state(
        &self,
        session_id: &str,
        world_state: crate::worker_rollout::WorldStateItem,
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let record = self.ensure_session_record(session_id, &timestamp)?;
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        self.recorder
            .append_item(&path, timestamp, ThreadLogItem::WorldState(world_state))?;
        let log_head = self.recorder.thread_log_head(&path)?;
        self.state.upsert_thread_projection(&record, &log_head)
    }

    pub fn fork_from_rollout(
        &self,
        source_thread_id: &str,
        fork: &ThreadRecord,
        fork_after_sequence: Option<u64>,
        include_checkpoints: bool,
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        if let Some(existing) = self.state.find_by_session_or_thread_id(&fork.thread_id)? {
            let path = PathBuf::from(existing.thread_path);
            let lines = read_thread_lines(&path)?;
            let meta = thread_meta_from_lines(&lines)?;
            if meta.forked_from_thread_id.as_deref() == Some(source_thread_id) {
                return Ok(());
            }
            return Err(thread_log_consistency_error(
                "existing fork Rollout has different lineage",
                serde_json::json!({
                    "threadId": fork.thread_id,
                    "expectedForkedFromThreadId": source_thread_id,
                    "actualForkedFromThreadId": meta.forked_from_thread_id,
                }),
            ));
        }
        let Some(source_record) = self.state.find_by_session_or_thread_id(source_thread_id)? else {
            return Err(thread_log_consistency_error(
                "source Rollout is missing for thread fork",
                serde_json::json!({ "threadId": source_thread_id }),
            ));
        };
        let source_path = PathBuf::from(source_record.thread_path);
        self.recorder.validate_thread_path(&source_path)?;
        self.recorder.flush(&source_path)?;
        let source_lines = read_thread_lines(&source_path)?;
        let inherited_indexes =
            fork_rollout_line_indexes(&source_lines, fork_after_sequence, &fork.thread_id)?;
        let inherited_lines = inherited_indexes
            .into_iter()
            .filter_map(|index| {
                let line = &source_lines[index];
                fork_inherits_rollout_item(&line.item, include_checkpoints).then(|| ThreadLogLine {
                    timestamp: line.timestamp.clone(),
                    ordinal: None,
                    item: line.item.clone(),
                })
            })
            .collect::<Vec<_>>();
        let inherited_record_count = inherited_lines.len();
        let created_at = canonicalize_thread_timestamp(&fork.created_at)?;
        let updated_at = canonicalize_thread_timestamp(&fork.updated_at)?;
        let meta = ThreadMeta {
            schema_version: THREAD_LOG_SCHEMA_VERSION,
            thread_id: fork.thread_id.clone(),
            session_id: Some(
                fork.session_key
                    .clone()
                    .unwrap_or_else(|| fork.thread_id.clone()),
            ),
            created_at: created_at.clone(),
            cwd: fork
                .metadata
                .working_directory
                .clone()
                .unwrap_or_else(|| source_record.cwd.clone()),
            source: "fork".to_string(),
            model_provider: source_record.model_provider,
            model: fork.metadata.model.clone().or(source_record.model),
            base_instructions: None,
            history_mode: Some("default".to_string()),
            forked_from_thread_id: Some(source_thread_id.to_string()),
            parent_thread_id: fork.parent_thread_id.clone(),
            originator: Some("Tinybot Desktop".to_string()),
        };
        let path = self.recorder.create_thread(meta)?;
        let result = (|| {
            if !inherited_lines.is_empty() {
                self.recorder.append_lines(&path, inherited_lines)?;
            }
            self.recorder.append_item(
                &path,
                updated_at,
                value_event(
                    "metadata_updated",
                    serde_json::json!({
                        "metadata": {
                            "title": fork.title,
                            "preview": fork.metadata.preview,
                            "archived": false,
                        },
                        "forkedFromThreadId": source_thread_id,
                        "threadRecord": fork,
                    }),
                ),
            )?;
            let canonical = self.canonical_thread_state(&path)?;
            self.state.replace_thread_projection(
                &canonical.record,
                canonical.latest_checkpoint.as_ref(),
                &ThreadLogHead {
                    byte_length: canonical.log_head.byte_length,
                    tail_hash: canonical.log_head.tail_hash,
                },
            )
        })();
        if let Err(error) = result {
            if let Err(cleanup_error) = self.recorder.delete_rollout(&path) {
                eprintln!(
                    "canonical_thread_fork_cleanup_failed thread_id={} error={}",
                    fork.thread_id, cleanup_error.message
                );
            }
            return Err(error);
        }
        eprintln!(
            "thread_rollout_forked source_thread_id={} thread_id={} inherited_records={}",
            source_thread_id, fork.thread_id, inherited_record_count
        );
        Ok(())
    }

    pub fn rollback_thread(
        &self,
        thread_id: &str,
        num_turns: u32,
    ) -> Result<ThreadRollbackResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        if num_turns == 0 {
            return Err(thread_rollback_error(thread_id, "numTurns must be >= 1"));
        }
        self.ensure_state_index()?;
        let Some(mut record) = self.find_live_record(thread_id)? else {
            return Err(thread_rollback_error(
                thread_id,
                "thread rollback requires persisted Rollout history",
            ));
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        self.ensure_thread_log_head_current(&record, &path)?;
        let lines = read_thread_lines(&path)?;
        if rollout_has_active_turn(&lines) {
            return Err(thread_rollback_error(
                thread_id,
                "cannot rollback while a turn is in progress",
            ));
        }

        let timestamp = now_thread_timestamp();
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            value_event(
                "thread_rolled_back",
                serde_json::json!({ "num_turns": num_turns }),
            ),
        )?;

        let lines = read_thread_lines(&path)?;
        let context = replay_thread(&lines)?;
        let transcript = replay_thread_transcript(&lines)?;
        let latest_checkpoint = latest_context_checkpoint_from_lines(&record.id, &lines)?;
        let log_head = self.recorder.thread_log_head(&path)?;
        record.updated_at = timestamp;
        record.preview = preview_from_messages(&transcript.messages);
        record.tokens_used = context
            .token_usage_info
            .as_ref()
            .map(|info| info.total_token_usage.total_tokens)
            .unwrap_or_default();
        self.state
            .replace_thread_projection(&record, latest_checkpoint.as_ref(), &log_head)?;

        Ok(ThreadRollbackResult {
            thread_id: record.id,
            num_turns,
            remaining_message_count: transcript.messages.len(),
            context_checkpoint_retained: latest_checkpoint.is_some(),
        })
    }

    #[cfg(test)]
    pub(crate) fn fail_next_state_index_upserts(&self, count: usize) {
        self.state.fail_next_upserts(count);
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
        let path = PathBuf::from(&record.thread_path);
        Ok(Some(self.session_metadata_from_rollout(record, &path)?))
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
        let path = PathBuf::from(&record.thread_path);
        Ok(Some(self.session_metadata_from_rollout(record, &path)?))
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
        let replay = replay_thread_transcript(&lines)?;
        Ok(Some(history_from_replay(replay, limit)))
    }

    pub fn get_agent_context(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Option<SessionHistoryProjection>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        if !self.state.path().exists() {
            self.ensure_state_index()?;
        }
        let Some(record) = self.find_live_record(session_id)? else {
            return Ok(None);
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        if let Err(error) = self.ensure_thread_log_head_current(&record, &path) {
            eprintln!(
                "thread_state_index_targeted_rebuild thread_id={} reason={}",
                record.id, error.message
            );
            return self.get_agent_context_from_canonical_rollout(&path, limit);
        }
        let lines = read_thread_lines(&path)?;
        if let Err(error) = self.ensure_thread_log_head_current(&record, &path) {
            eprintln!(
                "thread_state_index_targeted_rebuild thread_id={} reason={}",
                record.id, error.message
            );
            return self.get_agent_context_from_canonical_rollout(&path, limit);
        }
        let latest_checkpoint = match self.state.latest_context_checkpoint(session_id) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                eprintln!(
                    "thread_state_index_targeted_rebuild thread_id={} reason={}",
                    record.id, error.message
                );
                return self.get_agent_context_from_canonical_rollout(&path, limit);
            }
        };
        let replay = match replay_agent_context_from_checkpoint(&lines, latest_checkpoint.as_ref())
        {
            Ok(replay) => replay,
            Err(error) => {
                eprintln!(
                    "thread_state_index_targeted_rebuild thread_id={} reason={}",
                    record.id, error.message
                );
                return self.get_agent_context_from_canonical_rollout(&path, limit);
            }
        };
        Ok(Some(history_from_replay(replay, limit)))
    }

    fn get_agent_context_from_canonical_rollout(
        &self,
        path: &Path,
        limit: usize,
    ) -> Result<Option<SessionHistoryProjection>, WorkerProtocolError> {
        let canonical = self.canonical_thread_state(path)?;
        let lines = read_thread_lines(path)?;
        let replay =
            replay_agent_context_from_checkpoint(&lines, canonical.latest_checkpoint.as_ref())?;
        let log_head = ThreadLogHead {
            byte_length: canonical.log_head.byte_length,
            tail_hash: canonical.log_head.tail_hash.clone(),
        };
        if let Err(error) = self.state.replace_thread_projection(
            &canonical.record,
            canonical.latest_checkpoint.as_ref(),
            &log_head,
        ) {
            eprintln!(
                "thread_state_index_targeted_rebuild_failed thread_id={} error={}",
                canonical.record.id, error.message
            );
        }
        Ok(Some(history_from_replay(replay, limit)))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn hydrate_thread_snapshot(
        &self,
        mut snapshot: ThreadSnapshot,
        cursor: Option<&str>,
        before_sequence: Option<u64>,
        checkpoint_sequence: Option<u64>,
        checkpoint_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        self.ensure_state_index()?;
        let mut record = self
            .state
            .find_by_session_or_thread_id(&snapshot.thread.thread_id)?;
        if record.is_none() {
            if let Some(session_id) = snapshot.thread.session_key.as_deref() {
                record = self.state.find_by_session_or_thread_id(session_id)?;
            }
        }
        let Some(record) = record else {
            return Err(thread_log_consistency_error(
                "canonical Rollout is missing for thread hydration",
                serde_json::json!({ "threadId": snapshot.thread.thread_id }),
            ));
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let lines = read_thread_lines(&path)?;
        let meta = thread_meta_from_lines(&lines)?;
        let all_items = thread_items_from_rollout(&lines, &record.id)?;
        let runs = agent_run::agent_run_records_from_lines(
            record.session_id.as_deref().unwrap_or(&record.id),
            &lines,
        )
        .into_iter()
        .map(|run| thread_run_summary_from_agent_run(&run, &all_items))
        .collect::<Vec<_>>();
        let active_run = runs.iter().find(|run| run.active).cloned();
        let checkpoints = all_items
            .iter()
            .filter_map(|item| thread_checkpoint_from_item(&record.id, item))
            .collect::<Vec<_>>();
        let latest_checkpoint = checkpoints
            .iter()
            .max_by_key(|checkpoint| checkpoint.sequence)
            .cloned();
        let requested_cursor = resolve_thread_snapshot_cursor(
            cursor,
            checkpoint_sequence,
            checkpoint_id,
            &checkpoints,
        )?;
        let limit = limit.unwrap_or(200).clamp(1, 1_000);
        let mut filtered = all_items
            .iter()
            .filter(|item| {
                item.sequence > requested_cursor
                    && before_sequence.is_none_or(|before| item.sequence < before)
            })
            .cloned()
            .collect::<Vec<_>>();
        filtered.sort_by_key(|item| item.sequence);
        if before_sequence.is_some() && filtered.len() > limit {
            filtered = filtered.split_off(filtered.len() - limit);
        } else {
            filtered.truncate(limit);
        }
        let previous_cursor = filtered.first().and_then(|first| {
            all_items
                .iter()
                .any(|item| item.sequence < first.sequence)
                .then(|| first.sequence.to_string())
        });
        let next_cursor = filtered.last().and_then(|last| {
            all_items
                .iter()
                .any(|item| item.sequence > last.sequence)
                .then(|| last.sequence.to_string())
        });
        let has_more_before = previous_cursor.is_some();
        let has_more_after = next_cursor.is_some();

        snapshot.thread.session_key = record.session_id.clone();
        snapshot.thread.parent_thread_id = meta.parent_thread_id;
        snapshot.thread.source = record.source;
        snapshot.thread.created_at = record.created_at;
        snapshot.thread.updated_at = record.updated_at;
        snapshot.thread.archived_at = record.archived_at;
        snapshot.thread.title = record.title;
        snapshot.thread.metadata.preview = (!record.preview.is_empty()).then_some(record.preview);
        snapshot.thread.metadata.working_directory = (!record.cwd.is_empty()).then_some(record.cwd);
        snapshot.thread.metadata.model = record.model;
        snapshot.thread.metadata.item_count = u64::try_from(all_items.len()).unwrap_or(u64::MAX);
        snapshot.thread.metadata.run_count = u64::try_from(runs.len()).unwrap_or(u64::MAX);
        snapshot.thread.metadata.has_active_run = active_run.is_some();
        snapshot.thread.active_run_id = active_run.as_ref().map(|run| run.run_id.clone());
        snapshot.thread.status =
            canonical_thread_status(record.archived, &all_items, &runs, active_run.as_ref());
        snapshot.items = filtered;
        snapshot.runs = runs;
        snapshot.active_run = active_run;
        snapshot.latest_checkpoint = latest_checkpoint;
        snapshot.pagination = ThreadPagination {
            cursor: requested_cursor.to_string(),
            limit,
            item_count: all_items.len(),
            previous_cursor,
            next_cursor: next_cursor.clone(),
            has_more_before,
            has_more_after,
        };
        snapshot.next_cursor = next_cursor;
        Ok(snapshot)
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
        let rebuilt_thread_count = match mode {
            ThreadLogIndexRepairMode::RebuildIndex => self.rebuild_state_index_from_rollouts()?,
        };
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
            rebuilt_thread_count,
        })
    }

    pub fn prepare_state_index_for_startup(
        &self,
    ) -> Result<Option<ThreadLogIndexRepairReport>, WorkerProtocolError> {
        let report = self.state_index_consistency()?;
        match report.status {
            ThreadLogIndexConsistencyStatus::Clean => Ok(None),
            ThreadLogIndexConsistencyStatus::MissingIndex
            | ThreadLogIndexConsistencyStatus::Diverged
            | ThreadLogIndexConsistencyStatus::Unreadable => {
                let rebuilt_thread_count = self.rebuild_state_index_from_rollouts()?;
                let after = self.state_index_consistency()?;
                if after.status != ThreadLogIndexConsistencyStatus::Clean {
                    return Err(thread_log_consistency_error(
                        "automatic thread state index rebuild did not produce a clean index",
                        serde_json::to_value(&after).unwrap_or_default(),
                    ));
                }
                Ok(Some(ThreadLogIndexRepairReport {
                    mode: ThreadLogIndexRepairMode::RebuildIndex,
                    before: report,
                    after,
                    rebuilt_thread_count,
                }))
            }
        }
    }

    fn ensure_state_index(&self) -> Result<(), WorkerProtocolError> {
        let report = self.state_index_consistency()?;
        if report.status == ThreadLogIndexConsistencyStatus::Clean {
            return Ok(());
        }
        eprintln!(
            "thread_state_index_rebuild status={:?} canonical_threads={} indexed_threads={} diagnostics={}",
            report.status,
            report.canonical_thread_count,
            report.indexed_thread_count,
            report.diagnostics.join("; ")
        );
        self.rebuild_state_index_from_rollouts()?;
        let after = self.state_index_consistency()?;
        if after.status == ThreadLogIndexConsistencyStatus::Clean {
            return Ok(());
        }
        Err(thread_log_consistency_error(
            "automatic thread state index rebuild did not produce a clean index",
            serde_json::to_value(after).unwrap_or_default(),
        ))
    }

    fn rebuild_state_index_from_rollouts(&self) -> Result<usize, WorkerProtocolError> {
        let canonical = self.canonical_thread_states()?;
        self.state.reset()?;
        for state in &canonical {
            self.state.replace_thread_projection(
                &state.record,
                state.latest_checkpoint.as_ref(),
                &ThreadLogHead {
                    byte_length: state.log_head.byte_length,
                    tail_hash: state.log_head.tail_hash.clone(),
                },
            )?;
        }
        Ok(canonical.len())
    }

    fn ensure_thread_log_head_current(
        &self,
        record: &ThreadStateRecord,
        path: &Path,
    ) -> Result<(), WorkerProtocolError> {
        let indexed = self.state.thread_log_head(&record.id)?;
        let actual = self.recorder.thread_log_head(path)?;
        if indexed.as_ref().is_some_and(|indexed| {
            indexed.byte_length == actual.byte_length && indexed.tail_hash == actual.tail_hash
        }) {
            return Ok(());
        }
        Err(thread_log_consistency_error(
            "thread log file version does not match the SQLite state index; run session.persistence.repair explicitly",
            serde_json::json!({
                "threadId": record.id,
                "threadPath": record.thread_path,
                "indexedByteLength": indexed.as_ref().map(|head| head.byte_length),
                "actualByteLength": actual.byte_length,
                "indexedTailHash": indexed.as_ref().map(|head| head.tail_hash.as_str()),
                "actualTailHash": actual.tail_hash,
            }),
        ))
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

    fn ensure_session_record(
        &self,
        session_id: &str,
        timestamp: &str,
    ) -> Result<ThreadStateRecord, WorkerProtocolError> {
        if let Some(record) = self.state.find_by_session_or_thread_id(session_id)? {
            return Ok(record);
        }
        let thread_id = thread_id_for_session_id(session_id);
        let meta = ThreadMeta {
            schema_version: THREAD_LOG_SCHEMA_VERSION,
            thread_id: thread_id.clone(),
            session_id: Some(session_id.to_string()),
            created_at: timestamp.to_string(),
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
            id: thread_id,
            session_id: Some(session_id.to_string()),
            thread_path: path.display().to_string(),
            created_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
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
        let log_head = self.recorder.thread_log_head(&path)?;
        self.state.upsert_thread_projection(&record, &log_head)?;
        Ok(record)
    }

    fn canonical_thread_states(&self) -> Result<Vec<CanonicalThreadState>, WorkerProtocolError> {
        let mut paths = Vec::new();
        collect_thread_log_paths(&self.thread_root, &self.thread_root, &mut paths)?;
        collect_thread_log_paths(&self.archive_root, &self.archive_root, &mut paths)?;
        let mut states = Vec::with_capacity(paths.len());
        let mut thread_ids = HashSet::with_capacity(paths.len());
        for path in paths {
            let state = self.canonical_thread_state(&path)?;
            if !thread_ids.insert(state.record.id.clone()) {
                return Err(thread_log_consistency_error(
                    "duplicate canonical Rollouts exist for the same thread",
                    serde_json::json!({
                        "threadId": state.record.id,
                        "threadPath": state.record.thread_path,
                    }),
                ));
            }
            states.push(state);
        }
        states.sort_by(|left, right| left.record.id.cmp(&right.record.id));
        Ok(states)
    }

    fn canonical_thread_state(
        &self,
        path: &Path,
    ) -> Result<CanonicalThreadState, WorkerProtocolError> {
        self.recorder.validate_thread_path(path)?;
        let lines = read_thread_lines(path)?;
        let meta = thread_meta_from_lines(&lines)?;
        let replay = replay_thread(&lines)?;
        let latest_checkpoint = latest_context_checkpoint_from_lines(&meta.thread_id, &lines)?;
        let log_head = self.recorder.thread_log_head(path)?;
        let updated_at = state_projection_updated_at(&meta.created_at, &lines);
        let archived = self.recorder.is_archived_path(path);
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
            archived,
            archived_at: None,
        };
        apply_metadata_events_to_record(&mut record, &lines)?;
        apply_agent_run_events_to_record(&mut record, &lines)?;
        record.updated_at = updated_at;
        record.archived = archived;
        record.archived_at = if archived {
            record
                .archived_at
                .or_else(|| Some(record.updated_at.clone()))
        } else {
            None
        };
        Ok(CanonicalThreadState {
            log_head: ThreadLogHeadRecord {
                thread_id: record.id.clone(),
                byte_length: log_head.byte_length,
                tail_hash: log_head.tail_hash,
            },
            record,
            latest_checkpoint,
        })
    }

    fn state_index_consistency(
        &self,
    ) -> Result<ThreadLogIndexConsistencyReport, WorkerProtocolError> {
        let canonical = self.canonical_thread_states()?;
        let canonical_records = canonical
            .iter()
            .map(|state| state.record.clone())
            .collect::<Vec<_>>();
        let canonical_checkpoints = canonical
            .iter()
            .filter_map(|state| state.latest_checkpoint.clone())
            .collect::<Vec<_>>();
        let canonical_heads = canonical
            .iter()
            .map(|state| state.log_head.clone())
            .collect::<Vec<_>>();
        if !self.state.path().exists() {
            return Ok(ThreadLogIndexConsistencyReport {
                status: if canonical_records.is_empty() {
                    ThreadLogIndexConsistencyStatus::Clean
                } else {
                    ThreadLogIndexConsistencyStatus::MissingIndex
                },
                canonical_thread_count: canonical_records.len(),
                indexed_thread_count: 0,
                diagnostics: (!canonical_records.is_empty())
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
        let indexed_checkpoints = match self.state.list_latest_context_checkpoints() {
            Ok(checkpoints) => checkpoints,
            Err(error) => {
                return Ok(ThreadLogIndexConsistencyReport {
                    status: ThreadLogIndexConsistencyStatus::Unreadable,
                    canonical_thread_count: canonical_records.len(),
                    indexed_thread_count: indexed.len(),
                    diagnostics: vec![error.message],
                });
            }
        };
        let indexed_heads = match self.state.list_thread_log_heads() {
            Ok(heads) => heads,
            Err(error) => {
                return Ok(ThreadLogIndexConsistencyReport {
                    status: ThreadLogIndexConsistencyStatus::Unreadable,
                    canonical_thread_count: canonical_records.len(),
                    indexed_thread_count: indexed.len(),
                    diagnostics: vec![error.message],
                });
            }
        };
        let records_match = canonical_records == indexed;
        let checkpoints_match = canonical_checkpoints == indexed_checkpoints;
        let heads_match = canonical_heads == indexed_heads;
        let status = if records_match && checkpoints_match && heads_match {
            ThreadLogIndexConsistencyStatus::Clean
        } else if indexed.is_empty() && !canonical_records.is_empty()
            || records_match && indexed_checkpoints.is_empty() && !canonical_checkpoints.is_empty()
            || records_match && indexed_heads.is_empty() && !canonical_heads.is_empty()
        {
            ThreadLogIndexConsistencyStatus::MissingIndex
        } else {
            ThreadLogIndexConsistencyStatus::Diverged
        };
        let diagnostics = (status != ThreadLogIndexConsistencyStatus::Clean)
            .then(|| {
                if records_match && checkpoints_match {
                    "canonical thread log file versions differ from the SQLite state index"
                        .to_string()
                } else if records_match {
                    "canonical latest context checkpoints differ from the SQLite state index"
                        .to_string()
                } else {
                    let fields = canonical_records
                        .iter()
                        .zip(&indexed)
                        .find(|(canonical, indexed)| canonical != indexed)
                        .map(|(canonical, indexed)| {
                            format!(
                                "{} ({})",
                                thread_state_record_mismatch_fields(canonical, indexed).join(","),
                                thread_state_record_mismatch_detail(canonical, indexed)
                            )
                        })
                        .unwrap_or_else(|| "record_count".to_string());
                    format!(
                        "canonical thread log records differ from the SQLite state index in fields: {fields}"
                    )
                }
            })
            .into_iter()
            .collect();
        Ok(ThreadLogIndexConsistencyReport {
            status,
            canonical_thread_count: canonical_records.len(),
            indexed_thread_count: indexed.len(),
            diagnostics,
        })
    }

    pub fn commit_context_checkpoint(
        &self,
        session_id: &str,
        run_id: &str,
        mut checkpoint: Value,
    ) -> Result<ContextCheckpointCommitResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let _commit_guard = CONTEXT_CHECKPOINT_COMMIT_LOCK.lock().map_err(|_| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "context compaction checkpoint commit lock is poisoned",
                serde_json::json!({ "runId": run_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        let tinybot_root = self
            .thread_root
            .parent()
            .unwrap_or(self.thread_root.as_path());
        let _file_guard = crate::context_checkpoint_lock::acquire_context_checkpoint_lock(
            tinybot_root,
        )
        .map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                format!("failed to acquire cross-process context checkpoint lock: {error}"),
                serde_json::json!({
                    "runId": run_id,
                    "sessionId": session_id,
                }),
                true,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        self.ensure_state_index()?;
        let context_id = checkpoint
            .get("contextId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "context compaction checkpoint is missing contextId",
                    serde_json::json!({ "runId": run_id }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                )
            })?
            .to_string();
        let replacement_history = checkpoint
            .get("replacementHistory")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "context compaction checkpoint is missing replacementHistory",
                    serde_json::json!({ "runId": run_id, "contextId": context_id }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                )
            })?
            .clone();
        checkpoint["preserveTranscript"] = Value::Bool(true);

        let timestamp = now_thread_timestamp();
        let mut record = self.ensure_session_record(session_id, &timestamp)?;
        let thread_path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&thread_path)?;
        let lines = read_thread_lines(&thread_path)?;
        let latest_checkpoint = self.state.latest_context_checkpoint(session_id)?;
        let current_checkpoint = latest_checkpoint
            .as_ref()
            .map(|record| {
                indexed_context_checkpoint(&lines, record)
                    .map(|(_line_number, checkpoint)| checkpoint)
            })
            .transpose()?;
        let current_context_id = current_checkpoint
            .and_then(|checkpoint| checkpoint.get("contextId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        if current_context_id == Some(context_id.as_str()) {
            let installed = lines.iter().rev().find_map(|line| match &line.item {
                ThreadLogItem::Compacted(existing)
                    if existing.get("contextId").and_then(Value::as_str)
                        == Some(context_id.as_str())
                        && existing.get("checkpointStage").and_then(Value::as_str)
                            == Some("installed") =>
                {
                    Some(existing)
                }
                _ => None,
            });
            if installed != Some(&checkpoint) {
                return Err(WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "context compaction checkpoint identity already has different content",
                    serde_json::json!({
                        "runId": run_id,
                        "contextId": context_id,
                        "threadPath": thread_path.display().to_string(),
                    }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                ));
            }
            return Ok(ContextCheckpointCommitResult {
                session_id: session_id.to_string(),
                context_id,
                committed: false,
                duplicate: true,
                index_synchronized: true,
                index_recovered: false,
                diagnostics: Vec::new(),
            });
        }
        if lines.iter().any(|line| {
            matches!(
                &line.item,
                ThreadLogItem::Compacted(existing)
                    if existing.get("contextId").and_then(Value::as_str)
                        == Some(context_id.as_str())
            )
        }) {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "context compaction checkpoint identity is historical and no longer current",
                serde_json::json!({
                    "runId": run_id,
                    "contextId": context_id,
                    "currentContextId": current_context_id,
                    "threadPath": thread_path.display().to_string(),
                }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }

        let current_checkpoint = current_checkpoint.and_then(|checkpoint| {
            checkpoint
                .get("contextId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(|_| checkpoint)
        });
        crate::context_checkpoint_lineage::validate_context_checkpoint_successor(
            session_id,
            current_checkpoint,
            &checkpoint,
        )
        .map_err(|error| stale_context_checkpoint_error(run_id, &context_id, error))?;

        let derived_title = is_default_session_title(&record.title)
            .then(|| title_from_messages(&replacement_history))
            .flatten();
        let mut items = vec![ThreadLogItem::Compacted(checkpoint)];
        if let Some(title) = derived_title.as_ref() {
            items.push(value_event(
                "metadata_updated",
                serde_json::json!({ "metadata": { "title": title } }),
            ));
        }
        self.recorder
            .append_items(&thread_path, timestamp.clone(), items)?;
        let persisted_lines = read_thread_lines(&thread_path)?;
        let checkpoint_record = latest_context_checkpoint_from_lines(&record.id, &persisted_lines)?
            .ok_or_else(|| {
                thread_log_consistency_error(
                    "persisted context checkpoint is absent from the canonical Rollout",
                    serde_json::json!({
                        "threadId": record.id,
                        "contextId": context_id,
                    }),
                )
            })?;
        let log_head = self.recorder.thread_log_head(&thread_path)?;
        record.updated_at = timestamp;
        record.tokens_used = 0;
        if let Some(title) = derived_title {
            record.title = title;
        }
        record.preview = preview_from_messages(&replacement_history);
        let index =
            self.synchronize_derived_index_after_checkpoint(&record, &checkpoint_record, &log_head);
        Ok(ContextCheckpointCommitResult {
            session_id: session_id.to_string(),
            context_id,
            committed: true,
            duplicate: false,
            index_synchronized: index.synchronized,
            index_recovered: index.recovered,
            diagnostics: index.diagnostics,
        })
    }

    fn synchronize_derived_index_after_checkpoint(
        &self,
        record: &ThreadStateRecord,
        checkpoint: &LatestContextCheckpointRecord,
        log_head: &ThreadLogHead,
    ) -> DerivedIndexSyncResult {
        let first_error =
            match self
                .state
                .replace_thread_projection(record, Some(checkpoint), log_head)
            {
                Ok(()) => {
                    return DerivedIndexSyncResult {
                        synchronized: true,
                        recovered: false,
                        diagnostics: Vec::new(),
                    }
                }
                Err(error) => error,
            };
        match self
            .state
            .replace_thread_projection(record, Some(checkpoint), log_head)
        {
            Ok(()) => DerivedIndexSyncResult {
                synchronized: true,
                recovered: true,
                diagnostics: vec![format!(
                    "thread state index synchronization recovered after retry: {}",
                    first_error.message
                )],
            },
            Err(retry_error) => DerivedIndexSyncResult {
                synchronized: false,
                recovered: false,
                diagnostics: vec![format!(
                    "context checkpoint is durable but thread state index synchronization failed: {}; retry failed: {}",
                    first_error.message, retry_error.message
                )],
            },
        }
    }

    pub fn persist_session_turn(
        &self,
        session_id: &str,
        run_id: &str,
        messages: Vec<Value>,
        context_checkpoint: Option<Value>,
    ) -> Result<PersistTurnResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let _checkpoint_guard = if context_checkpoint.is_some() {
            let process_guard = CONTEXT_CHECKPOINT_COMMIT_LOCK.lock().map_err(|_| {
                WorkerProtocolError::new(
                    WorkerProtocolErrorCode::WorkerError,
                    "context compaction checkpoint commit lock is poisoned",
                    serde_json::json!({ "runId": run_id }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                )
            })?;
            let tinybot_root = self
                .thread_root
                .parent()
                .unwrap_or(self.thread_root.as_path());
            let file_guard =
                crate::context_checkpoint_lock::acquire_context_checkpoint_lock(tinybot_root)
                    .map_err(|error| {
                        WorkerProtocolError::new(
                            WorkerProtocolErrorCode::WorkerError,
                            format!(
                                "failed to acquire cross-process context checkpoint lock: {error}"
                            ),
                            serde_json::json!({
                                "runId": run_id,
                                "sessionId": session_id,
                            }),
                            true,
                            WorkerProtocolErrorSource::RustCore,
                        )
                    })?;
            Some((process_guard, file_guard))
        } else {
            None
        };
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let mut record = self.ensure_session_record(session_id, &timestamp)?;
        let thread_path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&thread_path)?;
        let lines = read_thread_lines(&thread_path)?;
        let replay = replay_thread(&lines)?;
        let messages_before = replay.messages.len();
        let (saved_messages, duplicate_message_count) =
            filter_new_session_messages(&replay.messages, messages);
        let turn_already_started = match thread_run_state(&thread_path, run_id)? {
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
            ThreadRunState::Incomplete => true,
            ThreadRunState::Missing => false,
        };

        let compacted = context_checkpoint
            .map(|mut checkpoint| {
                let replacement_history = checkpoint
                    .get("replacementHistory")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        WorkerProtocolError::new(
                            WorkerProtocolErrorCode::InvalidProtocol,
                            "context compaction checkpoint is missing replacementHistory",
                            serde_json::json!({ "runId": run_id }),
                            false,
                            WorkerProtocolErrorSource::RustCore,
                        )
                    })?
                    .clone();
                checkpoint["preserveTranscript"] = Value::Bool(true);
                Ok::<_, WorkerProtocolError>((checkpoint, replacement_history))
            })
            .transpose()?;
        if let Some((checkpoint, _replacement_history)) = compacted.as_ref() {
            if let Some(context_id) = checkpoint
                .get("contextId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                let latest_checkpoint = self.state.latest_context_checkpoint(session_id)?;
                let current_checkpoint = latest_checkpoint
                    .as_ref()
                    .map(|record| {
                        indexed_context_checkpoint(&lines, record)
                            .map(|(_line_number, checkpoint)| checkpoint)
                    })
                    .transpose()?;
                crate::context_checkpoint_lineage::validate_context_checkpoint_revision(
                    current_checkpoint,
                    checkpoint,
                )
                .map_err(|error| stale_context_checkpoint_error(run_id, context_id, error))?;
            }
        }
        let mut next_messages = compacted
            .as_ref()
            .map(|(_, replacement_history)| replacement_history.clone())
            .unwrap_or_else(|| replay.messages.clone());
        if compacted.is_none() {
            next_messages.extend(saved_messages.clone());
        }
        let derived_title = is_default_session_title(&record.title)
            .then(|| title_from_messages(&next_messages))
            .flatten();
        let persists_checkpoint = compacted.is_some();
        let mut turn_items = Vec::with_capacity(saved_messages.len() + 3);
        if !turn_already_started {
            turn_items.push(value_event(
                "turn_started",
                serde_json::json!({ "runId": run_id }),
            ));
        }
        turn_items.extend(
            saved_messages
                .iter()
                .cloned()
                .map(ThreadLogItem::ResponseItem),
        );
        if let Some((checkpoint, _replacement_history)) = compacted {
            turn_items.push(ThreadLogItem::Compacted(checkpoint));
        }
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
        let indexed_checkpoint = if persists_checkpoint {
            let persisted_lines = read_thread_lines(&thread_path)?;
            Some(
                latest_context_checkpoint_from_lines(&record.id, &persisted_lines)?.ok_or_else(
                    || {
                        thread_log_consistency_error(
                            "persisted context checkpoint is absent from the canonical Rollout",
                            serde_json::json!({ "threadId": record.id, "runId": run_id }),
                        )
                    },
                )?,
            )
        } else {
            None
        };
        let log_head = self.recorder.thread_log_head(&thread_path)?;

        let saved_message_count = saved_messages.len();
        let messages_after = next_messages.len();
        record.updated_at = timestamp;
        if let Some(title) = derived_title {
            record.title = title;
        }
        record.preview = preview_from_messages(&next_messages);
        if indexed_checkpoint.is_some() {
            record.tokens_used = 0;
        }
        match indexed_checkpoint.as_ref() {
            Some(checkpoint) => {
                self.state
                    .replace_thread_projection(&record, Some(checkpoint), &log_head)?
            }
            None => self.state.upsert_thread_projection(&record, &log_head)?,
        }
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
        let log_head = self.recorder.thread_log_head(&path)?;
        record.updated_at = timestamp;
        record.tokens_used = info.total_token_usage.total_tokens;
        self.state.upsert_thread_projection(&record, &log_head)
    }

    pub fn clear_session(
        &self,
        session_id: &str,
    ) -> Result<Option<ClearSessionResult>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let _process_guard = CONTEXT_CHECKPOINT_COMMIT_LOCK.lock().map_err(|_| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "context compaction checkpoint commit lock is poisoned",
                serde_json::json!({ "sessionId": session_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        let tinybot_root = self
            .thread_root
            .parent()
            .unwrap_or(self.thread_root.as_path());
        let _file_guard = crate::context_checkpoint_lock::acquire_context_checkpoint_lock(
            tinybot_root,
        )
        .map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                format!("failed to acquire cross-process context checkpoint lock: {error}"),
                serde_json::json!({ "sessionId": session_id }),
                true,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        self.ensure_state_index()?;
        let Some(mut record) = self.state.find_by_session_or_thread_id(session_id)? else {
            return Ok(None);
        };
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let lines = read_thread_lines(&path)?;
        let replay = replay_thread(&lines)?;
        let checkpoint_cleared = agent_run::agent_run_records_from_lines(session_id, &lines)
            .iter()
            .any(|run| run.checkpoint.is_some());
        let timestamp = now_thread_timestamp();
        let checkpoint = serde_json::json!({ "replacementHistory": [] });
        self.recorder.append_items(
            &path,
            timestamp.clone(),
            vec![
                ThreadLogItem::Compacted(checkpoint),
                value_event(
                    "session_cleared",
                    serde_json::json!({ "sessionId": session_id }),
                ),
            ],
        )?;
        let persisted_lines = read_thread_lines(&path)?;
        let indexed_checkpoint =
            latest_context_checkpoint_from_lines(&record.id, &persisted_lines)?.ok_or_else(
                || {
                    thread_log_consistency_error(
                        "persisted clear checkpoint is absent from the canonical Rollout",
                        serde_json::json!({ "threadId": record.id }),
                    )
                },
            )?;
        let log_head = self.recorder.thread_log_head(&path)?;
        let messages_before = replay.messages.len();
        record.updated_at = timestamp.clone();
        record.preview.clear();
        record.tokens_used = 0;
        self.state
            .replace_thread_projection(&record, Some(&indexed_checkpoint), &log_head)?;
        let mut session = metadata_from_state(record.clone());
        session.extra["messages"] = serde_json::json!([]);
        session.extra["user_profile"] = serde_json::json!({});
        Ok(Some(ClearSessionResult {
            session_id: record
                .session_id
                .clone()
                .unwrap_or_else(|| record.id.clone()),
            messages_before,
            messages_after: 0,
            checkpoint_cleared,
            session,
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
            self.recorder.delete_rollout(&path)?;
        }
        let deleted = self.state.delete_thread(&record.id)?;
        Ok(DeleteSessionResult {
            session_id: record.session_id.unwrap_or(record.id),
            deleted,
        })
    }

    pub fn set_thread_archived(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<Option<ThreadStateRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(record) = self.state.find_by_session_or_thread_id(thread_id)? else {
            return Ok(None);
        };
        let source = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&source)?;
        if !source.exists() {
            return Err(thread_log_consistency_error(
                "thread log indexed path does not exist",
                serde_json::json!({
                    "threadId": record.id,
                    "threadPath": record.thread_path,
                }),
            ));
        }
        if self.recorder.is_archived_path(&source) == archived {
            return Ok(Some(record));
        }
        let target = if archived {
            self.recorder.archive_rollout(&source)?
        } else {
            self.recorder.unarchive_rollout(&source)?
        };
        let timestamp = now_thread_timestamp();
        self.recorder.append_item(
            &target,
            timestamp,
            value_event(
                "metadata_updated",
                serde_json::json!({
                    "metadata": {
                        "archived": archived,
                    }
                }),
            ),
        )?;
        let canonical = self.canonical_thread_state(&target)?;
        self.state.replace_thread_projection(
            &canonical.record,
            canonical.latest_checkpoint.as_ref(),
            &ThreadLogHead {
                byte_length: canonical.log_head.byte_length,
                tail_hash: canonical.log_head.tail_hash,
            },
        )?;
        eprintln!(
            "thread_rollout_relocated thread_id={} archived={} source={} target={}",
            canonical.record.id,
            archived,
            source.display(),
            target.display()
        );
        Ok(Some(canonical.record))
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
                    "metadata": metadata,
                    "sessionMetadata": metadata
                }
            })),
        )?;
        let log_head = self.recorder.thread_log_head(&path)?;
        apply_metadata_patch_to_record(&mut record, patch, &timestamp);
        self.state.upsert_thread_projection(&record, &log_head)?;
        Ok(Some(self.session_metadata_from_rollout(record, &path)?))
    }

    fn session_metadata_from_rollout(
        &self,
        record: ThreadStateRecord,
        path: &Path,
    ) -> Result<SessionMetadata, WorkerProtocolError> {
        self.recorder.validate_thread_path(path)?;
        let lines = read_thread_lines(path)?;
        let mut metadata = serde_json::Map::new();
        for line in lines {
            let ThreadLogItem::EventMsg(event) = line.item else {
                continue;
            };
            if event.get("type").and_then(Value::as_str) != Some("metadata_updated") {
                continue;
            }
            let Some(patch) = event
                .get("payload")
                .and_then(|payload| payload.get("sessionMetadata"))
                .and_then(Value::as_object)
            else {
                continue;
            };
            metadata.extend(patch.clone());
        }
        let mut session = metadata_from_state(record);
        if !metadata.is_empty() {
            session.extra["metadata"] = Value::Object(metadata);
        }
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
}

fn thread_state_record_mismatch_fields(
    canonical: &ThreadStateRecord,
    indexed: &ThreadStateRecord,
) -> Vec<&'static str> {
    let mut fields = Vec::new();
    macro_rules! compare {
        ($field:ident) => {
            if canonical.$field != indexed.$field {
                fields.push(stringify!($field));
            }
        };
    }
    compare!(id);
    compare!(session_id);
    compare!(thread_path);
    compare!(created_at);
    compare!(updated_at);
    compare!(source);
    compare!(title);
    compare!(preview);
    compare!(cwd);
    compare!(model_provider);
    compare!(model);
    compare!(tokens_used);
    compare!(archived);
    compare!(archived_at);
    fields
}

fn thread_state_record_mismatch_detail(
    canonical: &ThreadStateRecord,
    indexed: &ThreadStateRecord,
) -> String {
    fn fingerprint(value: &str) -> String {
        format!("{}:{:x}", value.len(), Sha256::digest(value.as_bytes()))
    }
    format!(
        "updated_at={}/{}, title={}/{}, preview={}/{}",
        canonical.updated_at,
        indexed.updated_at,
        fingerprint(&canonical.title),
        fingerprint(&indexed.title),
        fingerprint(&canonical.preview),
        fingerprint(&indexed.preview)
    )
}

fn latest_context_checkpoint_from_lines(
    thread_id: &str,
    lines: &[ThreadLogLine],
) -> Result<Option<LatestContextCheckpointRecord>, WorkerProtocolError> {
    let Some(line_index) = crate::worker_rollout::latest_effective_compaction_index(lines) else {
        return Ok(None);
    };
    let line = &lines[line_index];
    let ThreadLogItem::Compacted(checkpoint) = &line.item else {
        unreachable!("effective compaction index must point to a compacted item");
    };
    let ordinal = line
        .ordinal
        .unwrap_or(u64::try_from(line_index).map_err(|_| {
            thread_log_consistency_error(
                "thread log checkpoint index exceeds the Rollout ordinal range",
                serde_json::json!({ "threadId": thread_id }),
            )
        })?);
    let ordinal = i64::try_from(ordinal).map_err(|_| {
        thread_log_consistency_error(
            "thread log checkpoint ordinal exceeds SQLite index range",
            serde_json::json!({ "threadId": thread_id }),
        )
    })?;
    Ok(Some(LatestContextCheckpointRecord {
        thread_id: thread_id.to_string(),
        ordinal,
        timestamp: line.timestamp.clone(),
        checkpoint_hash: context_checkpoint_hash(checkpoint)?,
    }))
}

fn rollout_has_active_turn(lines: &[ThreadLogLine]) -> bool {
    let mut active = false;
    for line in lines {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("task_started" | "turn_started") => active = true,
            Some("task_complete" | "turn_complete" | "turn_aborted") => active = false,
            _ => {}
        }
    }
    active
}

fn fork_rollout_line_indexes(
    lines: &[ThreadLogLine],
    fork_after_sequence: Option<u64>,
    fork_thread_id: &str,
) -> Result<Vec<usize>, WorkerProtocolError> {
    let cutoff = match fork_after_sequence {
        None => lines.len().checked_sub(1),
        Some(sequence) => {
            let sequenced = lines
                .iter()
                .enumerate()
                .filter_map(|(index, line)| {
                    thread_item_sequence_from_rollout_line(line).map(|value| (index, value))
                })
                .collect::<Vec<_>>();
            let Some(max_sequence) = sequenced.iter().map(|(_, value)| *value).max() else {
                return Err(thread_fork_error(
                    fork_thread_id,
                    "forkAfterSequence cannot be resolved from canonical Rollout records",
                ));
            };
            if sequence >= max_sequence {
                sequenced.last().map(|(index, _)| *index)
            } else {
                sequenced
                    .iter()
                    .rev()
                    .find(|(_, value)| *value <= sequence)
                    .map(|(index, _)| *index)
            }
        }
    };
    let Some(cutoff) = cutoff else {
        return Ok(Vec::new());
    };
    let completed_cutoff = completed_turn_boundary(lines, cutoff).ok_or_else(|| {
        thread_fork_error(
            fork_thread_id,
            "fork boundary must end at a completed persisted turn",
        )
    })?;
    Ok(crate::worker_rollout::effective_rollout_line_indexes(lines)
        .into_iter()
        .filter(|index| *index <= completed_cutoff)
        .collect())
}

fn completed_turn_boundary(lines: &[ThreadLogLine], cutoff: usize) -> Option<usize> {
    let mut active = false;
    for line in lines.iter().take(cutoff.saturating_add(1)) {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("task_started" | "turn_started") => active = true,
            Some("task_complete" | "turn_complete" | "turn_aborted") => active = false,
            _ => {}
        }
    }
    if !active {
        return Some(cutoff);
    }
    for (index, line) in lines.iter().enumerate().skip(cutoff.saturating_add(1)) {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("task_complete" | "turn_complete" | "turn_aborted") => return Some(index),
            Some("task_started" | "turn_started") => return None,
            _ => {}
        }
    }
    None
}

fn fork_inherits_rollout_item(item: &ThreadLogItem, include_checkpoints: bool) -> bool {
    let ThreadLogItem::EventMsg(event) = item else {
        return !matches!(item, ThreadLogItem::SessionMeta(_));
    };
    let Some(event_type) = event.get("type").and_then(Value::as_str) else {
        return true;
    };
    if event_type == "thread_rolled_back" || event_type.starts_with("agent_run_") {
        return false;
    }
    if event_type != "thread_item" {
        return true;
    }
    let item_type = event
        .get("payload")
        .and_then(|payload| payload.get("item"))
        .and_then(|item| item.get("kind"))
        .and_then(|kind| kind.get("type"))
        .and_then(Value::as_str);
    match item_type {
        Some(value) if value.starts_with("agent_run_") => false,
        Some("checkpoint_created") if !include_checkpoints => false,
        _ => true,
    }
}

fn thread_item_sequence_from_rollout_line(line: &ThreadLogLine) -> Option<u64> {
    match &line.item {
        ThreadLogItem::ResponseItem(message) => {
            message.get("threadItemSequence").and_then(Value::as_u64)
        }
        ThreadLogItem::Compacted(checkpoint) => checkpoint
            .get("_threadItemSequence")
            .and_then(Value::as_u64),
        ThreadLogItem::EventMsg(event)
            if event.get("type").and_then(Value::as_str) == Some("thread_item") =>
        {
            event
                .get("payload")
                .and_then(|payload| payload.get("item"))
                .and_then(|item| item.get("sequence"))
                .and_then(Value::as_u64)
        }
        _ => None,
    }
}

fn thread_rollback_error(thread_id: &str, message: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "threadId": thread_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_fork_error(thread_id: &str, message: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "threadId": thread_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn indexed_context_checkpoint<'a>(
    lines: &'a [ThreadLogLine],
    latest_checkpoint: &LatestContextCheckpointRecord,
) -> Result<(usize, &'a Value), WorkerProtocolError> {
    let expected_ordinal = u64::try_from(latest_checkpoint.ordinal).map_err(|_| {
        thread_log_consistency_error(
            "latest context checkpoint index has an invalid ordinal",
            serde_json::json!({
                "threadId": latest_checkpoint.thread_id,
                "ordinal": latest_checkpoint.ordinal,
            }),
        )
    })?;
    let mut indexed = None;
    for (line_index, line) in lines.iter().enumerate() {
        let ordinal = line
            .ordinal
            .unwrap_or(u64::try_from(line_index).map_err(|_| {
                thread_log_consistency_error(
                    "thread log index exceeds the Rollout ordinal range",
                    serde_json::json!({ "threadId": latest_checkpoint.thread_id }),
                )
            })?);
        if ordinal == expected_ordinal {
            if indexed.replace((line_index, line)).is_some() {
                return Err(thread_log_consistency_error(
                    "thread log contains duplicate Rollout ordinals",
                    serde_json::json!({
                        "threadId": latest_checkpoint.thread_id,
                        "ordinal": latest_checkpoint.ordinal,
                    }),
                ));
            }
        }
    }
    let (line_index, indexed_line) = indexed.ok_or_else(|| {
        thread_log_consistency_error(
            "latest context checkpoint ordinal is absent from the thread log",
            serde_json::json!({
                "threadId": latest_checkpoint.thread_id,
                "ordinal": latest_checkpoint.ordinal,
            }),
        )
    })?;
    let indexed_checkpoint = match &indexed_line.item {
        ThreadLogItem::Compacted(checkpoint) => checkpoint,
        _ => {
            return Err(thread_log_consistency_error(
                "latest context checkpoint index does not point to a compacted item",
                serde_json::json!({
                    "threadId": latest_checkpoint.thread_id,
                    "ordinal": latest_checkpoint.ordinal,
                }),
            ));
        }
    };
    if indexed_line.timestamp != latest_checkpoint.timestamp
        || context_checkpoint_hash(indexed_checkpoint)? != latest_checkpoint.checkpoint_hash
    {
        return Err(thread_log_consistency_error(
            "latest context checkpoint index differs from the canonical thread log",
            serde_json::json!({
                "threadId": latest_checkpoint.thread_id,
                "ordinal": latest_checkpoint.ordinal,
            }),
        ));
    }
    Ok((line_index, indexed_checkpoint))
}

fn replay_agent_context_from_checkpoint(
    lines: &[ThreadLogLine],
    latest_checkpoint: Option<&LatestContextCheckpointRecord>,
) -> Result<ThreadReplay, WorkerProtocolError> {
    let Some(latest_checkpoint) = latest_checkpoint else {
        return replay_thread(lines);
    };
    let (line_number, _indexed_checkpoint) = indexed_context_checkpoint(lines, latest_checkpoint)?;

    let mut replay_lines = Vec::with_capacity(lines.len().saturating_sub(line_number) + 1);
    if line_number > 0 {
        let meta = lines
            .iter()
            .find(|line| matches!(line.item, ThreadLogItem::SessionMeta(_)))
            .ok_or_else(|| {
                thread_log_consistency_error(
                    "thread log has no metadata before its latest context checkpoint",
                    serde_json::json!({ "threadId": latest_checkpoint.thread_id }),
                )
            })?;
        replay_lines.push(meta.clone());
    }
    replay_lines.extend_from_slice(&lines[line_number..]);
    replay_thread(&replay_lines)
}

fn context_checkpoint_hash(checkpoint: &Value) -> Result<String, WorkerProtocolError> {
    let encoded = serde_json::to_vec(checkpoint).map_err(|error| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::WorkerError,
            format!("failed to hash context checkpoint: {error}"),
            serde_json::json!({ "method": "thread_log.context_checkpoint_index" }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
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
            ThreadLogItem::SessionMeta(meta) => Some(meta.clone()),
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

fn thread_items_from_rollout(
    lines: &[ThreadLogLine],
    thread_id: &str,
) -> Result<Vec<ThreadItem>, WorkerProtocolError> {
    let effective_indexes = crate::worker_rollout::effective_rollout_line_indexes(lines);
    let after_clear = effective_indexes
        .iter()
        .copied()
        .filter(|index| {
            matches!(
                &lines[*index].item,
                ThreadLogItem::EventMsg(event)
                    if event.get("type").and_then(Value::as_str) == Some("session_cleared")
            )
        })
        .max()
        .map(|index| index.saturating_add(1))
        .unwrap_or(0);
    let mut items = Vec::new();
    let mut item_ids = HashSet::new();
    for index in effective_indexes
        .into_iter()
        .filter(|index| *index >= after_clear)
    {
        let line = &lines[index];
        let sequence = line.ordinal.unwrap_or_else(|| index as u64);
        let projected = match &line.item {
            ThreadLogItem::ResponseItem(item) => Some(ThreadItem {
                item_id: rollout_thread_item_id(item, thread_id, sequence),
                thread_id: thread_id.to_string(),
                run_id: string_value(item, "runId").or_else(|| string_value(item, "run_id")),
                turn_id: string_value(item, "turnId").or_else(|| string_value(item, "turn_id")),
                parent_item_id: string_value(item, "parentItemId")
                    .or_else(|| string_value(item, "parent_item_id")),
                sequence,
                created_at: line.timestamp.clone(),
                kind: response_item_thread_kind(item),
            }),
            ThreadLogItem::EventMsg(event)
                if event.get("type").and_then(Value::as_str) == Some("thread_item") =>
            {
                let mut item = serde_json::from_value::<ThreadItem>(
                    event
                        .get("payload")
                        .and_then(|payload| payload.get("item"))
                        .cloned()
                        .ok_or_else(|| {
                            thread_log_consistency_error(
                                "canonical thread_item event is missing its item",
                                serde_json::json!({
                                    "threadId": thread_id,
                                    "ordinal": line.ordinal,
                                }),
                            )
                        })?,
                )
                .map_err(|error| {
                    thread_log_consistency_error(
                        "canonical thread_item event is invalid",
                        serde_json::json!({
                            "threadId": thread_id,
                            "ordinal": line.ordinal,
                            "error": error.to_string(),
                        }),
                    )
                })?;
                item.thread_id = thread_id.to_string();
                item.sequence = sequence;
                item.created_at = line.timestamp.clone();
                Some(item)
            }
            ThreadLogItem::Compacted(checkpoint) => Some(ThreadItem {
                item_id: checkpoint
                    .get("_threadItemId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("rollout:{thread_id}:{sequence}")),
                thread_id: thread_id.to_string(),
                run_id: None,
                turn_id: None,
                parent_item_id: None,
                sequence,
                created_at: line.timestamp.clone(),
                kind: ThreadItemKind::ContextCompaction(serde_json::json!({
                    "contextCheckpoint": checkpoint
                })),
            }),
            ThreadLogItem::InterAgentCommunication(communication) => Some(ThreadItem {
                item_id: format!("rollout:{thread_id}:{sequence}"),
                thread_id: thread_id.to_string(),
                run_id: string_value(communication, "runId")
                    .or_else(|| string_value(communication, "run_id")),
                turn_id: string_value(communication, "turnId")
                    .or_else(|| string_value(communication, "turn_id")),
                parent_item_id: None,
                sequence,
                created_at: line.timestamp.clone(),
                kind: ThreadItemKind::SubagentMessage(communication.clone()),
            }),
            ThreadLogItem::SessionMeta(_)
            | ThreadLogItem::EventMsg(_)
            | ThreadLogItem::TurnContext(_)
            | ThreadLogItem::WorldState(_)
            | ThreadLogItem::InterAgentCommunicationMetadata { .. } => None,
        };
        let Some(item) = projected else {
            continue;
        };
        if !item_ids.insert(item.item_id.clone()) {
            return Err(thread_log_consistency_error(
                "canonical Rollout projects duplicate thread item identities",
                serde_json::json!({
                    "threadId": thread_id,
                    "itemId": item.item_id,
                    "ordinal": line.ordinal,
                }),
            ));
        }
        items.push(item);
    }
    items.sort_by_key(|item| item.sequence);
    Ok(items)
}

fn rollout_thread_item_id(item: &Value, thread_id: &str, sequence: u64) -> String {
    string_value(item, "threadItemId")
        .or_else(|| string_value(item, "itemId"))
        .or_else(|| string_value(item, "messageId"))
        .or_else(|| string_value(item, "id"))
        .unwrap_or_else(|| format!("rollout:{thread_id}:{sequence}"))
}

fn response_item_thread_kind(item: &Value) -> ThreadItemKind {
    match item.get("role").and_then(Value::as_str) {
        Some("user") => ThreadItemKind::UserMessage(item.clone()),
        Some("assistant") => ThreadItemKind::AssistantMessageCompleted(item.clone()),
        _ => match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => ThreadItemKind::Reasoning(item.clone()),
            Some("function_call" | "tool_call") => ThreadItemKind::ToolCallStarted(item.clone()),
            Some("function_call_output" | "tool_result") => {
                ThreadItemKind::ToolCallOutput(item.clone())
            }
            _ => ThreadItemKind::Event(item.clone()),
        },
    }
}

fn thread_run_summary_from_agent_run(
    run: &AgentRunRecord,
    items: &[ThreadItem],
) -> ThreadRunSummary {
    let active = matches!(
        &run.status,
        AgentRunStatus::Running | AgentRunStatus::Waiting
    );
    let status = match &run.status {
        AgentRunStatus::Running => ThreadStatus::Running,
        AgentRunStatus::Waiting if run.phase.contains("approval") => {
            ThreadStatus::WaitingForApproval
        }
        AgentRunStatus::Waiting => ThreadStatus::WaitingForInput,
        AgentRunStatus::Failed => ThreadStatus::Failed,
        AgentRunStatus::Cancelled | AgentRunStatus::Interrupted | AgentRunStatus::Completed => {
            ThreadStatus::Idle
        }
    };
    ThreadRunSummary {
        run_id: run.run_id.clone(),
        status,
        started_at: Some(run.started_at.clone()),
        updated_at: Some(run.updated_at.clone()),
        completed_at: run.completed_at.clone(),
        model: (!run.model.is_empty()).then(|| run.model.clone()),
        provider: run.provider.clone(),
        item_count: u64::try_from(
            items
                .iter()
                .filter(|item| item.run_id.as_deref() == Some(run.run_id.as_str()))
                .count(),
        )
        .unwrap_or(u64::MAX),
        active,
    }
}

fn thread_checkpoint_from_item(thread_id: &str, item: &ThreadItem) -> Option<ThreadCheckpoint> {
    let ThreadItemKind::CheckpointCreated(payload) = &item.kind else {
        return None;
    };
    let checkpoint_id = string_value(payload, "checkpointId")
        .or_else(|| string_value(payload, "checkpoint_id"))
        .unwrap_or_else(|| item.item_id.clone());
    Some(ThreadCheckpoint {
        checkpoint_id,
        thread_id: thread_id.to_string(),
        run_id: item
            .run_id
            .clone()
            .or_else(|| string_value(payload, "runId"))
            .or_else(|| string_value(payload, "run_id")),
        sequence: item.sequence,
        label: string_value(payload, "label"),
        created_at: item.created_at.clone(),
        restore_payload: payload
            .get("restorePayload")
            .or_else(|| payload.get("restore_payload"))
            .or_else(|| payload.get("checkpoint"))
            .cloned()
            .unwrap_or_else(|| payload.clone()),
    })
}

fn resolve_thread_snapshot_cursor(
    cursor: Option<&str>,
    checkpoint_sequence: Option<u64>,
    checkpoint_id: Option<&str>,
    checkpoints: &[ThreadCheckpoint],
) -> Result<u64, WorkerProtocolError> {
    if let Some(cursor) = cursor {
        if cursor.trim().is_empty() {
            return Ok(0);
        }
        return cursor.parse::<u64>().map_err(|error| {
            thread_log_consistency_error(
                "thread cursor must be a Rollout ordinal",
                serde_json::json!({ "cursor": cursor, "error": error.to_string() }),
            )
        });
    }
    if let Some(checkpoint_id) = checkpoint_id {
        let checkpoint = checkpoints
            .iter()
            .find(|checkpoint| checkpoint.checkpoint_id == checkpoint_id)
            .ok_or_else(|| {
                thread_log_consistency_error(
                    "unknown checkpoint id in canonical Rollout",
                    serde_json::json!({ "checkpointId": checkpoint_id }),
                )
            })?;
        return Ok(checkpoint.sequence.saturating_sub(1));
    }
    Ok(checkpoint_sequence.unwrap_or(1).saturating_sub(1))
}

fn canonical_thread_status(
    archived: bool,
    items: &[ThreadItem],
    runs: &[ThreadRunSummary],
    active_run: Option<&ThreadRunSummary>,
) -> ThreadStatus {
    if archived {
        return ThreadStatus::Archived;
    }
    if let Some(active_run) = active_run {
        return active_run.status.clone();
    }
    if runs
        .iter()
        .max_by_key(|run| run.updated_at.clone())
        .is_some_and(|run| run.status == ThreadStatus::Failed)
    {
        return ThreadStatus::Failed;
    }
    if items.is_empty() {
        ThreadStatus::Empty
    } else {
        ThreadStatus::Idle
    }
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn thread_item_to_rollout_items(item: &ThreadItem) -> Vec<ThreadLogItem> {
    let rollout_item = match &item.kind {
        ThreadItemKind::UserMessage(payload) => {
            ThreadLogItem::ResponseItem(thread_item_message(item, payload, "user"))
        }
        ThreadItemKind::AssistantMessageCompleted(payload) => {
            ThreadLogItem::ResponseItem(thread_item_message(item, payload, "assistant"))
        }
        ThreadItemKind::AssistantMessageDelta(_) => return Vec::new(),
        ThreadItemKind::ContextCompaction(payload) => {
            let checkpoint = payload
                .get("payload")
                .and_then(|payload| payload.get("contextCheckpoint"))
                .or_else(|| payload.get("contextCheckpoint"))
                .unwrap_or(payload);
            let mut checkpoint = checkpoint.clone();
            if let Some(object) = checkpoint.as_object_mut() {
                object.insert(
                    "_threadItemId".to_string(),
                    Value::String(item.item_id.clone()),
                );
                object.insert(
                    "_threadItemSequence".to_string(),
                    Value::Number(item.sequence.into()),
                );
            }
            ThreadLogItem::Compacted(checkpoint)
        }
        ThreadItemKind::AgentRunCompleted(payload) => {
            let mut items = vec![legacy_thread_item_event(item)];
            if let Some(info) = payload.get("tokenUsageInfo") {
                items.push(ThreadLogItem::EventMsg(serde_json::json!({
                    "type": "token_count",
                    "info": info
                })));
            }
            return items;
        }
        _ => legacy_thread_item_event(item),
    };
    vec![rollout_item]
}

fn legacy_thread_item_event(item: &ThreadItem) -> ThreadLogItem {
    ThreadLogItem::EventMsg(serde_json::json!({
        "type": "thread_item",
        "payload": { "item": item }
    }))
}

fn thread_item_message(item: &ThreadItem, payload: &Value, role: &str) -> Value {
    let mut message = payload
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| serde_json::json!({ "content": payload }));
    let content = payload
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| payload.get("text").and_then(Value::as_str))
        .or_else(|| payload.as_str())
        .unwrap_or_default()
        .to_string();
    message["role"] = Value::String(role.to_string());
    message["content"] = Value::String(content);
    message["timestamp"] = Value::String(item.created_at.clone());
    message["threadItemId"] = Value::String(item.item_id.clone());
    message["threadItemSequence"] = Value::Number(item.sequence.into());
    message
}

fn thread_item_id_from_rollout_line(line: &ThreadLogLine) -> Option<&str> {
    match &line.item {
        ThreadLogItem::ResponseItem(message) => message.get("threadItemId").and_then(Value::as_str),
        ThreadLogItem::Compacted(checkpoint) => {
            checkpoint.get("_threadItemId").and_then(Value::as_str)
        }
        ThreadLogItem::EventMsg(event)
            if event.get("type").and_then(Value::as_str) == Some("thread_item") =>
        {
            event
                .get("payload")
                .and_then(|payload| payload.get("item"))
                .and_then(|item| item.get("itemId"))
                .and_then(Value::as_str)
        }
        _ => None,
    }
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
                        | "thread_rolled_back"
                        | "metadata_updated"
                        | "agent_run_upsert"
                        | "agent_run_checkpoint_set"
                        | "agent_run_checkpoint_clear"
                        | "agent_run_terminal"
                )
            ),
            ThreadLogItem::SessionMeta(_)
            | ThreadLogItem::TurnContext(_)
            | ThreadLogItem::WorldState(_)
            | ThreadLogItem::InterAgentCommunication(_)
            | ThreadLogItem::InterAgentCommunicationMetadata { .. } => false,
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
    if let Some(cwd) = patch
        .get("cwd")
        .or_else(|| patch.get("workingDirectory"))
        .and_then(Value::as_str)
    {
        record.cwd = cwd.to_string();
    }
    if let Some(model) = patch.get("model") {
        record.model = model.as_str().map(str::to_string);
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

fn stale_context_checkpoint_error(
    run_id: &str,
    context_id: &str,
    error: crate::context_checkpoint_lineage::ContextCheckpointLineageError,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        error.to_string(),
        serde_json::json!({
            "runId": run_id,
            "contextId": context_id,
            "field": error.field,
            "expected": error.expected,
            "actual": error.actual,
        }),
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
            ordinal: None,
            item: ThreadLogItem::SessionMeta(ThreadMeta {
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
