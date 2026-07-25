mod compression;
mod projection;
mod reader;
mod reconstruction;
mod recorder;
mod rollout_writer;
mod state_db;
mod turn;

pub use self::projection::ThreadHistoryProjection;
pub(crate) use self::turn::is_turn_semantic_event;

use self::projection::{thread_agent_context_from_replay, thread_history_from_replay};
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::threads::domain::{
    turn_summaries_from_items, ThreadCheckpoint, ThreadItem, ThreadItemKind, ThreadMetadata,
    ThreadPagination, ThreadRecord, ThreadSnapshot, ThreadStatus, ThreadTurnSummary,
};
use crate::threads::turn::{AgentTurnRecord, AgentTurnStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

mod checkpoint_lock;

static CONTEXT_CHECKPOINT_COMMIT_LOCK: Mutex<()> = Mutex::new(());
static THREAD_RECORD_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedThreadRecord>>> = OnceLock::new();
const THREAD_RECORD_CACHE_CAPACITY: usize = 64;
const STATE_INDEX_STABILITY_RETRY_COUNT: usize = 200;
const STATE_INDEX_STABILITY_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);
pub use self::reader::read_thread_lines;
use self::reader::read_thread_lines_for_discovery;
use self::recorder::ThreadLogHead;
use self::recorder::{canonicalize_thread_timestamp, is_canonical_thread_log_path};
pub use self::recorder::{value_event, ThreadRecorder};
pub use self::state_db::ThreadStateDb;
use self::state_db::{thread_projection_hash, LatestContextCheckpointRecord, ThreadLogHeadRecord};
pub use crate::threads::rollout::format::reconstruct_rollout as replay_thread;
use crate::threads::rollout::format::reconstruct_transcript as replay_thread_transcript;
pub use crate::threads::rollout::format::{
    CompactedItem, EventKind, EventMsg, ResponseItem, RolloutItem as ThreadLogItem,
    RolloutLine as ThreadLogLine, RolloutReconstruction as ThreadReplay, SessionMeta as ThreadMeta,
    ThreadStateRecord,
};
pub(crate) use crate::threads::time::now_thread_timestamp;
pub const THREAD_LOG_SCHEMA_VERSION: u32 = crate::threads::rollout::format::ROLLOUT_SCHEMA_VERSION;

#[derive(Clone, Debug)]
pub struct WorkerThreadLogRpc {
    recorder: ThreadRecorder,
    state: ThreadStateDb,
    thread_root: PathBuf,
    archive_root: PathBuf,
    policy: CapabilityPolicy,
    reconstruction_cache: Arc<Mutex<HashMap<PathBuf, CachedRolloutReconstruction>>>,
    state_index_ready: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRecoveryEntry {
    pub session_id: String,
    pub turn_id: String,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRecoveryReport {
    pub scanned_sessions: usize,
    pub scanned_turns: usize,
    pub interrupted_turns: Vec<AgentTurnRecoveryEntry>,
    pub awaiting_interaction_turns: Vec<AgentTurnRecoveryEntry>,
    pub resumable_turns: Vec<AgentTurnRecoveryEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCheckpointCommitResult {
    pub thread_id: String,
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadClearResult {
    pub thread_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub checkpoint_cleared: bool,
    pub thread: ThreadRecord,
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

#[derive(Clone, Debug)]
struct CachedRolloutReconstruction {
    head: ThreadLogHead,
    reconstruction: reconstruction::CanonicalRolloutReconstruction,
}

#[derive(Clone, Debug)]
struct CachedThreadRecord {
    head: ThreadLogHead,
    record: ThreadRecord,
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
pub struct ThreadLogIndexRepairReport {
    pub mode: ThreadLogIndexRepairMode,
    pub before: ThreadLogIndexConsistencyReport,
    pub after: ThreadLogIndexConsistencyReport,
    pub rebuilt_thread_count: usize,
}

impl WorkerThreadLogRpc {
    pub fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        let recorder = ThreadRecorder::new(workspace_root.clone());
        compression::spawn_rollout_compression_worker(workspace_root.clone(), recorder.clone());
        Self {
            recorder,
            thread_root: workspace_root.join(".tinybot").join("threads"),
            archive_root: workspace_root.join(".tinybot").join("archived_threads"),
            state: ThreadStateDb::new(workspace_root),
            policy,
            reconstruction_cache: Arc::new(Mutex::new(HashMap::new())),
            state_index_ready: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn flush_all(&self) -> Result<(), WorkerProtocolError> {
        self.recorder.flush_all()
    }

    pub(crate) fn shutdown_all(&self) -> Result<(), WorkerProtocolError> {
        self.recorder.shutdown_all()
    }

    pub(crate) fn invalidate_state_index(&self) {
        self.state_index_ready.store(false, Ordering::Release);
    }

    pub fn thread_projection(
        &self,
    ) -> Result<(Vec<ThreadRecord>, BTreeMap<String, Vec<ThreadItem>>), WorkerProtocolError> {
        self.ensure_state_index()?;
        let mut threads = Vec::new();
        let mut items = BTreeMap::new();
        for record in self.state.list_all_threads()? {
            let path = PathBuf::from(&record.thread_path);
            self.recorder.validate_thread_path(&path)?;
            let reconstructed = self.reconstruct_cached(&path)?;
            let thread = self.thread_record_from_rollout(&record, &path, &reconstructed)?;
            items.insert(thread.thread_id.clone(), reconstructed.thread_items);
            threads.push(thread);
        }
        Ok((threads, items))
    }

    pub(crate) fn thread_projection_for(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadRecord, Vec<ThreadItem>), WorkerProtocolError> {
        self.ensure_state_index()?;
        let record = self
            .state
            .find_by_session_or_thread_id(thread_id)?
            .ok_or_else(|| {
                thread_log_consistency_error(
                    "canonical Rollout is missing its derived thread projection",
                    serde_json::json!({ "threadId": thread_id }),
                )
            })?;
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let reconstructed = self.reconstruct_cached(&path)?;
        let thread = self.thread_record_from_rollout(&record, &path, &reconstructed)?;
        Ok((thread, reconstructed.thread_items))
    }

    fn thread_record_from_rollout(
        &self,
        record: &ThreadStateRecord,
        path: &Path,
        reconstructed: &reconstruction::CanonicalRolloutReconstruction,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let lines = read_thread_lines(path)?;
        let mut thread = ThreadRecord {
            thread_id: record.id.clone(),
            title: record.title.clone(),
            status: ThreadStatus::Empty,
            session_key: record.session_id.clone(),
            root_turn_id: None,
            active_turn_id: None,
            parent_thread_id: reconstructed.meta.parent_thread_id.clone(),
            source: record.source.clone(),
            created_at: record.created_at.clone(),
            updated_at: record.updated_at.clone(),
            archived_at: record.archived_at.clone(),
            metadata: ThreadMetadata::default(),
        };
        for event in lines.iter().filter_map(|line| match &line.item {
            ThreadLogItem::EventMsg(event) if event.kind() == &EventKind::MetadataUpdated => {
                event.payload().get("metadata").and_then(Value::as_object)
            }
            _ => None,
        }) {
            apply_metadata_patch_to_thread(&mut thread, event)?;
        }
        let mut turns = reconstructed
            .turns
            .iter()
            .map(|turn| thread_turn_summary_from_turn(turn, &reconstructed.thread_items))
            .collect::<Vec<_>>();
        for turn in turn_summaries_from_items(&thread, &reconstructed.thread_items) {
            if !turns
                .iter()
                .any(|existing| existing.turn_id == turn.turn_id)
            {
                turns.push(turn);
            }
        }
        let active_turn = turns.iter().find(|turn| turn.active);
        thread.thread_id = record.id.clone();
        thread.title = record.title.clone();
        thread.session_key = record.session_id.clone();
        thread.parent_thread_id = reconstructed.meta.parent_thread_id.clone();
        thread.source = record.source.clone();
        thread.created_at = record.created_at.clone();
        thread.updated_at = reconstructed.semantic.updated_at.clone();
        thread.archived_at = record.archived_at.clone();
        thread.metadata.preview = (!record.preview.is_empty()).then(|| record.preview.clone());
        thread.metadata.working_directory = (!record.cwd.is_empty()).then(|| record.cwd.clone());
        thread.metadata.model = record.model.clone();
        thread.metadata.item_count =
            u64::try_from(reconstructed.thread_items.len()).unwrap_or(u64::MAX);
        thread.metadata.turn_count = u64::try_from(turns.len()).unwrap_or(u64::MAX);
        thread.metadata.has_active_turn = active_turn.is_some();
        thread.active_turn_id = active_turn.map(|turn| turn.turn_id.clone());
        thread.status = canonical_thread_status(
            record.archived,
            &reconstructed.thread_items,
            &turns,
            active_turn,
        );
        Ok(thread)
    }

    pub fn create_from_thread_record(
        &self,
        thread: &ThreadRecord,
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let session_id = thread.session_key.clone();
        if let Some(existing) = self.state.find_by_session_or_thread_id(&thread.thread_id)? {
            if existing.id == thread.thread_id && existing.session_id == session_id {
                return self.sync_thread_record_projection(&existing, thread);
            }
            return Err(thread_log_consistency_error(
                "canonical Rollout identity conflicts with thread record",
                serde_json::json!({
                    "threadId": thread.thread_id,
                    "sessionId": session_id,
                    "existingThreadId": existing.id,
                    "existingSessionId": existing.session_id,
                }),
            ));
        }
        if let Some(session_id) = session_id.as_deref() {
            let implicit_thread_id = thread_id_for_session_id(session_id);
            if implicit_thread_id == thread.thread_id {
                // This is already the canonical identity for an implicit session thread.
            } else {
                if let Some(existing) = self
                    .state
                    .find_by_session_or_thread_id(&implicit_thread_id)?
                {
                    if existing.id == implicit_thread_id {
                        let implicit_path = PathBuf::from(&existing.thread_path);
                        self.recorder.validate_thread_path(&implicit_path)?;
                        let existing_lines = read_thread_lines(&implicit_path)?;
                        let explicitly_created = existing_lines.iter().any(|line| {
                            matches!(
                                &line.item,
                                ThreadLogItem::EventMsg(event)
                                    if event.kind() == &EventKind::MetadataUpdated
                                        && event
                                            .payload()
                                            .get("metadata")
                                            .and_then(|metadata| metadata.get("initial"))
                                            .and_then(Value::as_bool)
                                            == Some(true)
                            )
                        });
                        if !explicitly_created {
                            self.recorder.delete_rollout(&implicit_path)?;
                            if !self.state.delete_thread(&existing.id)? {
                                return Err(thread_log_consistency_error(
                                    "superseded implicit Rollout state could not be deleted",
                                    serde_json::json!({
                                        "threadId": thread.thread_id,
                                        "sessionId": session_id,
                                        "implicitThreadId": existing.id,
                                    }),
                                ));
                            }
                            eprintln!(
                            "implicit_session_rollout_superseded session_id={} implicit_thread_id={} canonical_thread_id={}",
                            session_id, existing.id, thread.thread_id
                        );
                        }
                    }
                }
            }
        }
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
            session_id: session_id.clone(),
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
                    EventKind::MetadataUpdated,
                    serde_json::json!({ "metadata": initial_thread_metadata(thread) }),
                ),
            )?;
            let record = ThreadStateRecord {
                id: thread.thread_id.clone(),
                session_id,
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
            self.state.upsert_thread_projection(&record, &log_head)?;
            cache_thread_record(&path, log_head, thread.clone());
            Ok(())
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
        let path = PathBuf::from(&existing.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let persisted = self.latest_persisted_thread_record(&path)?;
        if persisted == *thread {
            crate::runtime::observability::global_agent_runtime_metrics()
                .increment("persistence.metadata.noop");
            return Ok(());
        }
        let mut metadata = serde_json::Map::new();
        if persisted.title != thread.title {
            metadata.insert("title".to_string(), Value::String(thread.title.clone()));
        }
        insert_changed_json_field(
            &mut metadata,
            "rootTurnId",
            &persisted.root_turn_id,
            &thread.root_turn_id,
        )?;
        insert_changed_json_field(
            &mut metadata,
            "archivedAt",
            &persisted.archived_at,
            &thread.archived_at,
        )?;
        let thread_metadata_patch = json_object_diff(
            durable_thread_metadata(&persisted.metadata)?,
            durable_thread_metadata(&thread.metadata)?,
        );
        if !thread_metadata_patch.is_empty() {
            metadata.insert(
                "threadMetadataPatch".to_string(),
                Value::Object(thread_metadata_patch),
            );
        }
        if metadata.is_empty() {
            crate::runtime::observability::global_agent_runtime_metrics()
                .increment("persistence.metadata.noop");
            return Ok(());
        }
        let timestamp = canonicalize_thread_timestamp(
            thread
                .metadata
                .last_activity_at
                .as_deref()
                .unwrap_or(&thread.updated_at),
        )?;
        self.recorder.append_item(
            &path,
            timestamp,
            value_event(
                EventKind::MetadataUpdated,
                serde_json::json!({ "metadata": metadata }),
            ),
        )?;
        let canonical = self.canonical_thread_state(&path)?;
        self.state.replace_thread_projection(
            &canonical.record,
            canonical.latest_checkpoint.as_ref(),
            &ThreadLogHead {
                byte_length: canonical.log_head.byte_length,
                tail_hash: canonical.log_head.tail_hash.clone(),
            },
        )?;
        cache_thread_record(
            &path,
            ThreadLogHead {
                byte_length: canonical.log_head.byte_length,
                tail_hash: canonical.log_head.tail_hash,
            },
            thread.clone(),
        );
        Ok(())
    }

    fn latest_persisted_thread_record(
        &self,
        path: &Path,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let head = self.recorder.thread_log_head(path)?;
        {
            let cache = thread_record_cache().lock().map_err(|_| {
                thread_log_consistency_error(
                    "thread record cache lock was poisoned",
                    serde_json::json!({ "threadPath": path.display().to_string() }),
                )
            })?;
            if let Some(cached) = cache.get(path) {
                if cached.head == head {
                    return Ok(cached.record.clone());
                }
            }
        }
        let lines = read_thread_lines(path)?;
        let thread_id = lines
            .iter()
            .find_map(|line| match &line.item {
                ThreadLogItem::SessionMeta(meta) => Some(meta.thread_id.as_str()),
                _ => None,
            })
            .ok_or_else(|| {
                thread_log_consistency_error(
                    "canonical Rollout is missing session metadata",
                    serde_json::json!({ "threadPath": path.display().to_string() }),
                )
            })?;
        let state = self
            .state
            .find_by_session_or_thread_id(thread_id)?
            .ok_or_else(|| {
                thread_log_consistency_error(
                    "canonical Rollout is missing its derived thread projection",
                    serde_json::json!({ "threadId": thread_id }),
                )
            })?;
        let reconstructed = self.reconstruct_cached(path)?;
        let record = self.thread_record_from_rollout(&state, path, &reconstructed)?;
        cache_thread_record_checked(path, head, record.clone())?;
        Ok(record)
    }

    pub fn append_thread_items(
        &self,
        thread_id: &str,
        items: &[ThreadItem],
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        if let Some(item) = items.iter().find(|item| item.turn_id.trim().is_empty()) {
            return Err(thread_log_consistency_error(
                "thread item turnId must not be empty",
                serde_json::json!({
                    "threadId": thread_id,
                    "itemId": item.item_id,
                }),
            ));
        }
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
        let mut pending_items = items
            .iter()
            .filter(|item| !persisted_item_ids.contains(item.item_id.as_str()))
            .collect::<Vec<_>>();
        pending_items
            .sort_by_key(|item| (!matches!(item.kind, ThreadItemKind::TurnStarted(_))) as u8);
        let mut lines = Vec::new();
        for item in pending_items {
            let timestamp = canonicalize_thread_timestamp(&item.created_at)?;
            for rollout_item in thread_item_to_rollout_items(item)? {
                lines.push(ThreadLogLine {
                    timestamp: timestamp.clone(),
                    ordinal: None,
                    item: rollout_item,
                });
            }
        }
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
        thread_id: &str,
        context: crate::threads::rollout::format::TurnContextItem,
    ) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let record = self.require_thread_record(thread_id)?;
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let turn_id = context.turn_id.clone();
        if turn_id.trim().is_empty() {
            return Err(thread_log_consistency_error(
                "turn context turnId must not be empty",
                serde_json::json!({ "threadId": thread_id }),
            ));
        }
        let mut items = Vec::with_capacity(2);
        if thread_turn_state(&path, &turn_id)? == ThreadTurnState::Missing {
            items.push(value_event(
                EventKind::TurnStarted,
                serde_json::json!({ "turnId": turn_id }),
            ));
        }
        items.push(ThreadLogItem::TurnContext(context));
        self.recorder.append_items(&path, timestamp, items)?;
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
        let reconstructed = reconstruction::reconstruct_canonical_rollout(&source_lines)?;
        let inherited_indexes = fork_rollout_line_indexes(
            &source_lines,
            &reconstructed.semantic.effective_line_indexes,
            fork_after_sequence,
            &fork.thread_id,
        )?;
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
            session_id: fork.session_key.clone(),
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
                    EventKind::MetadataUpdated,
                    serde_json::json!({
                        "metadata": initial_thread_metadata(&fork),
                        "forkedFromThreadId": source_thread_id,
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
        if reconstruction::reconstruct_canonical_rollout(&lines)?.active_turn {
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
                EventKind::ThreadRolledBack,
                serde_json::json!({ "num_turns": num_turns }),
            ),
        )?;

        let updated_lines = read_thread_lines(&path)?;
        let reconstructed = reconstruction::reconstruct_canonical_rollout(&updated_lines)?;
        let context = reconstructed.semantic;
        let transcript = reconstructed.transcript;
        let latest_checkpoint = latest_context_checkpoint_from_lines(&record.id, &updated_lines)?;
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

    pub fn get_thread_history(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> Result<Option<ThreadHistoryProjection>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.ensure_state_index()?;
        let Some(record) = self.find_live_record(thread_id)? else {
            return Ok(None);
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let reconstructed = self.reconstruct_cached(&path)?;
        Ok(Some(thread_history_from_replay(
            &record.id,
            reconstructed.transcript,
            limit,
        )))
    }

    pub fn resolve_thread_id(&self, identity: &str) -> Result<String, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.ensure_state_index()?;
        self.state
            .find_by_session_or_thread_id(identity)?
            .map(|record| record.id)
            .ok_or_else(|| thread_mutation_error("thread not found", identity))
    }

    pub fn get_thread_context(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> Result<Option<ThreadHistoryProjection>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        if !self.state.path().exists() {
            self.ensure_state_index()?;
        }
        let Some(record) = self.find_live_record(thread_id)? else {
            return Ok(None);
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        if let Err(error) = self.ensure_thread_log_head_current(&record, &path) {
            eprintln!(
                "thread_state_index_targeted_rebuild thread_id={} reason={} details={}",
                record.id, error.message, error.details
            );
            return self.get_thread_context_from_canonical_rollout(&path, limit);
        }
        let lines = read_thread_lines(&path)?;
        if let Err(error) = self.ensure_thread_log_head_current(&record, &path) {
            eprintln!(
                "thread_state_index_targeted_rebuild thread_id={} reason={} details={}",
                record.id, error.message, error.details
            );
            return self.get_thread_context_from_canonical_rollout(&path, limit);
        }
        let latest_checkpoint = match self.state.latest_context_checkpoint(&record.id) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                eprintln!(
                    "thread_state_index_targeted_rebuild thread_id={} reason={} details={}",
                    record.id, error.message, error.details
                );
                return self.get_thread_context_from_canonical_rollout(&path, limit);
            }
        };
        let replay = match replay_agent_context_from_checkpoint(&lines, latest_checkpoint.as_ref())
        {
            Ok(replay) => replay,
            Err(error) => {
                eprintln!(
                    "thread_state_index_targeted_rebuild thread_id={} reason={} details={}",
                    record.id, error.message, error.details
                );
                return self.get_thread_context_from_canonical_rollout(&path, limit);
            }
        };
        Ok(Some(thread_agent_context_from_replay(
            &record.id, replay, limit,
        )))
    }

    fn get_thread_context_from_canonical_rollout(
        &self,
        path: &Path,
        limit: usize,
    ) -> Result<Option<ThreadHistoryProjection>, WorkerProtocolError> {
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
        Ok(Some(thread_agent_context_from_replay(
            &canonical.record.id,
            replay,
            limit,
        )))
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
        let reconstructed = self.reconstruct_cached(&path)?;
        let replay = reconstructed.semantic;
        let meta = reconstructed.meta;
        let all_items = reconstructed.thread_items;
        let mut turns = reconstructed
            .turns
            .into_iter()
            .map(|turn| thread_turn_summary_from_turn(&turn, &all_items))
            .collect::<Vec<_>>();
        for turn in turn_summaries_from_items(&snapshot.thread, &all_items) {
            if !turns
                .iter()
                .any(|existing| existing.turn_id == turn.turn_id)
            {
                turns.push(turn);
            }
        }
        let active_turn = turns.iter().find(|turn| turn.active).cloned();
        let checkpoints = reconstructed.checkpoints;
        let latest_checkpoint = active_turn.as_ref().and_then(|turn| {
            checkpoints
                .iter()
                .filter(|checkpoint| checkpoint.turn_id == turn.turn_id)
                .max_by_key(|checkpoint| checkpoint.sequence)
                .cloned()
        });
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
        snapshot.thread.updated_at = replay.updated_at;
        snapshot.thread.archived_at = record.archived_at;
        snapshot.thread.title = record.title;
        snapshot.thread.metadata.preview = (!record.preview.is_empty()).then_some(record.preview);
        snapshot.thread.metadata.working_directory = (!record.cwd.is_empty()).then_some(record.cwd);
        snapshot.thread.metadata.model = record.model;
        snapshot.thread.metadata.item_count = u64::try_from(all_items.len()).unwrap_or(u64::MAX);
        snapshot.thread.metadata.turn_count = u64::try_from(turns.len()).unwrap_or(u64::MAX);
        snapshot.thread.metadata.has_active_turn = active_turn.is_some();
        snapshot.thread.active_turn_id = active_turn.as_ref().map(|turn| turn.turn_id.clone());
        snapshot.thread.status =
            canonical_thread_status(record.archived, &all_items, &turns, active_turn.as_ref());
        snapshot.items = filtered;
        snapshot.turns = turns;
        snapshot.active_turn = active_turn;
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

    fn reconstruct_cached(
        &self,
        path: &Path,
    ) -> Result<reconstruction::CanonicalRolloutReconstruction, WorkerProtocolError> {
        const MAX_CACHED_ROLLOUTS: usize = 16;

        let head = self.recorder.thread_log_head(path)?;
        {
            let cache = self.reconstruction_cache.lock().map_err(|_| {
                thread_log_consistency_error(
                    "thread Rollout reconstruction cache lock was poisoned",
                    serde_json::json!({ "threadPath": path.display().to_string() }),
                )
            })?;
            if let Some(cached) = cache.get(path) {
                if cached.head == head {
                    return Ok(cached.reconstruction.clone());
                }
            }
        }
        let lines = read_thread_lines(path)?;
        let reconstruction = reconstruction::reconstruct_canonical_rollout(&lines)?;
        let mut cache = self.reconstruction_cache.lock().map_err(|_| {
            thread_log_consistency_error(
                "thread Rollout reconstruction cache lock was poisoned",
                serde_json::json!({ "threadPath": path.display().to_string() }),
            )
        })?;
        if cache.len() >= MAX_CACHED_ROLLOUTS && !cache.contains_key(path) {
            if let Some(evicted) = cache.keys().next().cloned() {
                cache.remove(&evicted);
            }
        }
        cache.insert(
            path.to_path_buf(),
            CachedRolloutReconstruction {
                head,
                reconstruction: reconstruction.clone(),
            },
        );
        Ok(reconstruction)
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
        if self.state_index_ready.load(Ordering::Acquire) {
            return Ok(());
        }
        self.ensure_state_index_uncached()?;
        self.state_index_ready.store(true, Ordering::Release);
        Ok(())
    }

    fn ensure_state_index_uncached(&self) -> Result<(), WorkerProtocolError> {
        if self.state_index_fast_path()? {
            return Ok(());
        }
        let mut report = self.state_index_consistency()?;
        if report.status == ThreadLogIndexConsistencyStatus::Clean {
            return Ok(());
        }
        if report.status == ThreadLogIndexConsistencyStatus::Diverged {
            for attempt in 1..=STATE_INDEX_STABILITY_RETRY_COUNT {
                std::thread::sleep(STATE_INDEX_STABILITY_RETRY_DELAY);
                if self.state_index_fast_path()? {
                    eprintln!(
                        "thread_state_index_transient_divergence_resolved attempts={attempt}"
                    );
                    return Ok(());
                }
            }
            report = self.state_index_consistency()?;
            if report.status == ThreadLogIndexConsistencyStatus::Clean {
                return Ok(());
            }
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

    fn state_index_fast_path(&self) -> Result<bool, WorkerProtocolError> {
        if !self.state.path().exists() {
            return Ok(false);
        }
        let mut paths = Vec::new();
        collect_thread_log_paths(&self.thread_root, &self.thread_root, &mut paths)?;
        collect_thread_log_paths(&self.archive_root, &self.archive_root, &mut paths)?;
        let records = match self.state.list_all_threads() {
            Ok(records) => records,
            Err(_) => return Ok(false),
        };
        let heads = match self.state.list_thread_log_heads() {
            Ok(heads) => heads,
            Err(_) => return Ok(false),
        };
        let checkpoints = match self.state.list_latest_context_checkpoints() {
            Ok(checkpoints) => checkpoints,
            Err(_) => return Ok(false),
        };
        if records.len() != paths.len() || heads.len() != records.len() {
            return Ok(false);
        }
        let path_set = paths.into_iter().collect::<HashSet<_>>();
        let head_by_thread = heads
            .into_iter()
            .map(|head| (head.thread_id.clone(), head))
            .collect::<HashMap<_, _>>();
        let checkpoint_by_thread = checkpoints
            .into_iter()
            .map(|checkpoint| (checkpoint.thread_id.clone(), checkpoint))
            .collect::<HashMap<_, _>>();
        if checkpoint_by_thread
            .keys()
            .any(|thread_id| !head_by_thread.contains_key(thread_id))
        {
            return Ok(false);
        }
        for record in &records {
            let path = PathBuf::from(&record.thread_path);
            if !path_set.contains(&path) {
                return Ok(false);
            }
            let Some(indexed_head) = head_by_thread.get(&record.id) else {
                return Ok(false);
            };
            let physical_head = self.recorder.thread_log_head(&path)?;
            if indexed_head.byte_length != physical_head.byte_length
                || indexed_head.tail_hash != physical_head.tail_hash
            {
                return Ok(false);
            }
            let projection_hash =
                thread_projection_hash(record, checkpoint_by_thread.get(&record.id));
            if indexed_head.projection_hash.is_empty()
                || indexed_head.projection_hash != projection_hash
            {
                return Ok(false);
            }
        }
        Ok(true)
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
            "thread log file version does not match the SQLite state index; run thread.persistence.repair explicitly",
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
            if !compression::rollout_exists(&path)? {
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

    fn require_thread_record(
        &self,
        thread_id: &str,
    ) -> Result<ThreadStateRecord, WorkerProtocolError> {
        self.find_live_record(thread_id)?
            .ok_or_else(|| thread_mutation_error("thread not found", thread_id))
    }

    fn canonical_thread_states(&self) -> Result<Vec<CanonicalThreadState>, WorkerProtocolError> {
        let mut paths = Vec::new();
        collect_thread_log_paths(&self.thread_root, &self.thread_root, &mut paths)?;
        collect_thread_log_paths(&self.archive_root, &self.archive_root, &mut paths)?;
        let mut states = Vec::with_capacity(paths.len());
        let mut thread_ids = HashSet::with_capacity(paths.len());
        for path in paths {
            let state = match self.canonical_thread_state(&path) {
                Ok(state) => state,
                Err(strict_error) => match self.discovered_thread_state(&path) {
                    Ok(state) => {
                        eprintln!(
                            "thread_rollout_discovery_degraded path={} strict_error={}",
                            path.display(),
                            strict_error.message
                        );
                        state
                    }
                    Err(discovery_error) => {
                        eprintln!(
                            "thread_rollout_discovery_skipped path={} strict_error={} \
                             discovery_error={}",
                            path.display(),
                            strict_error.message,
                            discovery_error.message
                        );
                        continue;
                    }
                },
            };
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

    fn discovered_thread_state(
        &self,
        path: &Path,
    ) -> Result<CanonicalThreadState, WorkerProtocolError> {
        self.recorder.validate_thread_path(path)?;
        let scan = read_thread_lines_for_discovery(path)?;
        if scan.lines.is_empty() {
            return Err(thread_log_consistency_error(
                "Rollout discovery found no valid records",
                serde_json::json!({ "threadPath": path.display().to_string() }),
            ));
        }
        if !scan.diagnostics.is_empty() {
            eprintln!(
                "thread_rollout_discovery_bad_rows path={} skipped_rows={} diagnostics={}",
                path.display(),
                scan.diagnostics.len(),
                scan.diagnostics.join(" | ")
            );
        }
        let meta = thread_meta_from_lines(&scan.lines)?;
        let replay_lines = scan
            .lines
            .iter()
            .filter(|line| {
                !matches!(
                    &line.item,
                    ThreadLogItem::EventMsg(event)
                        if event.kind() == &EventKind::TokenCount
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        let replay = replay_thread_transcript(&replay_lines)?;
        let updated_at = state_projection_updated_at(&meta.created_at, &scan.lines);
        let archived = self.recorder.is_archived_path(path);
        let model_provider = replay
            .previous_turn_settings
            .as_ref()
            .and_then(|settings| settings.provider.clone())
            .or(meta.model_provider);
        let model = replay
            .previous_turn_settings
            .as_ref()
            .map(|settings| settings.model.clone())
            .filter(|model| !model.trim().is_empty())
            .or(meta.model);
        let title = if is_default_thread_title(&replay.title) {
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
            model_provider,
            model,
            tokens_used: 0,
            archived,
            archived_at: None,
        };
        for line in &scan.lines {
            let ThreadLogItem::EventMsg(event) = &line.item else {
                continue;
            };
            if event.kind() != &EventKind::MetadataUpdated {
                continue;
            }
            if let Some(metadata) = event.payload().get("metadata").and_then(Value::as_object) {
                apply_metadata_patch_to_record(&mut record, metadata, &line.timestamp);
            }
        }
        record.updated_at = updated_at;
        record.archived = archived;
        record.archived_at = archived.then(|| record.updated_at.clone());
        let log_head = self.recorder.thread_log_head(path)?;
        let projection_hash = thread_projection_hash(&record, None);
        Ok(CanonicalThreadState {
            log_head: ThreadLogHeadRecord {
                thread_id: record.id.clone(),
                byte_length: log_head.byte_length,
                tail_hash: log_head.tail_hash,
                projection_hash,
            },
            record,
            latest_checkpoint: None,
        })
    }

    fn canonical_thread_state(
        &self,
        path: &Path,
    ) -> Result<CanonicalThreadState, WorkerProtocolError> {
        self.recorder.validate_thread_path(path)?;
        let lines = read_thread_lines(path)?;
        let reconstructed = reconstruction::reconstruct_canonical_rollout(&lines)?;
        let meta = reconstructed.meta;
        let replay = reconstructed.semantic;
        let latest_checkpoint = latest_context_checkpoint_from_lines(&meta.thread_id, &lines)?;
        let log_head = self.recorder.thread_log_head(path)?;
        let updated_at = state_projection_updated_at(&meta.created_at, &lines);
        let archived = self.recorder.is_archived_path(path);
        let model_provider = replay
            .previous_turn_settings
            .as_ref()
            .and_then(|settings| settings.provider.clone())
            .or(meta.model_provider);
        let model = replay
            .previous_turn_settings
            .as_ref()
            .map(|settings| settings.model.clone())
            .filter(|model| !model.trim().is_empty())
            .or(meta.model);
        let title = if is_default_thread_title(&replay.title) {
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
            model_provider,
            model,
            tokens_used: replay
                .token_usage_info
                .as_ref()
                .map(|info| info.total_token_usage.total_tokens)
                .unwrap_or_default(),
            archived,
            archived_at: None,
        };
        apply_metadata_events_to_record(&mut record, &lines)?;
        apply_turn_events_to_record(&mut record, &lines)?;
        record.updated_at = updated_at;
        record.archived = archived;
        record.archived_at = if archived {
            record
                .archived_at
                .or_else(|| Some(record.updated_at.clone()))
        } else {
            None
        };
        let projection_hash = thread_projection_hash(&record, latest_checkpoint.as_ref());
        Ok(CanonicalThreadState {
            log_head: ThreadLogHeadRecord {
                thread_id: record.id.clone(),
                byte_length: log_head.byte_length,
                tail_hash: log_head.tail_hash,
                projection_hash,
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
        thread_id: &str,
        turn_id: &str,
        mut checkpoint: Value,
    ) -> Result<ContextCheckpointCommitResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let _commit_guard = CONTEXT_CHECKPOINT_COMMIT_LOCK.lock().map_err(|_| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "context compaction checkpoint commit lock is poisoned",
                serde_json::json!({ "turnId": turn_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        let tinybot_root = self
            .thread_root
            .parent()
            .unwrap_or(self.thread_root.as_path());
        let _file_guard =
            checkpoint_lock::acquire_context_checkpoint_lock(tinybot_root).map_err(|error| {
                WorkerProtocolError::new(
                    WorkerProtocolErrorCode::WorkerError,
                    format!("failed to acquire cross-process context checkpoint lock: {error}"),
                    serde_json::json!({
                        "turnId": turn_id,
                        "threadId": thread_id,
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
                    serde_json::json!({ "turnId": turn_id }),
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
                    serde_json::json!({ "turnId": turn_id, "contextId": context_id }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                )
            })?
            .clone();
        insert_required_turn_id(&mut checkpoint, turn_id, "context checkpoint commit")?;
        checkpoint["preserveTranscript"] = Value::Bool(true);

        let timestamp = now_thread_timestamp();
        let mut record = self.require_thread_record(thread_id)?;
        let thread_path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&thread_path)?;
        let lines = read_thread_lines(&thread_path)?;
        let latest_checkpoint = self.state.latest_context_checkpoint(thread_id)?;
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
            if installed.map(CompactedItem::as_value) != Some(&checkpoint) {
                return Err(WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "context compaction checkpoint identity already has different content",
                    serde_json::json!({
                        "turnId": turn_id,
                        "contextId": context_id,
                        "threadPath": thread_path.display().to_string(),
                    }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                ));
            }
            return Ok(ContextCheckpointCommitResult {
                thread_id: record.id,
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
                    "turnId": turn_id,
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
        crate::threads::rollout::checkpoint_lineage::validate_context_checkpoint_successor(
            thread_id,
            current_checkpoint,
            &checkpoint,
        )
        .map_err(|error| stale_context_checkpoint_error(turn_id, &context_id, error))?;

        let derived_title = is_default_thread_title(&record.title)
            .then(|| title_from_messages(&replacement_history))
            .flatten();
        let mut items = vec![ThreadLogItem::Compacted(typed_compacted_item(
            checkpoint,
            "context checkpoint commit",
        )?)];
        if let Some(title) = derived_title.as_ref() {
            items.push(value_event(
                EventKind::MetadataUpdated,
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
            thread_id: record.id,
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

    pub fn append_thread_messages(
        &self,
        thread_id: &str,
        turn_id: &str,
        messages: Vec<Value>,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        if turn_id.trim().is_empty() {
            return Err(thread_mutation_error(
                "thread message append requires a non-empty turn id",
                thread_id,
            ));
        }
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let Some(mut record) = self.find_live_record(thread_id)? else {
            return Err(thread_mutation_error("thread not found", thread_id));
        };
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let replay =
            reconstruction::reconstruct_canonical_rollout(&read_thread_lines(&path)?)?.semantic;
        let (saved_messages, _) = filter_new_session_messages(&replay.messages, messages);
        let saved_messages = saved_messages
            .into_iter()
            .map(|mut message| {
                insert_required_turn_id(&mut message, turn_id, "append thread messages")?;
                Ok(message)
            })
            .collect::<Result<Vec<_>, WorkerProtocolError>>()?;
        let mut next_messages = replay.messages;
        next_messages.extend(saved_messages.iter().cloned());
        let derived_title = is_default_thread_title(&record.title)
            .then(|| title_from_messages(&next_messages))
            .flatten();
        let mut items = Vec::with_capacity(saved_messages.len() + 3);
        if !saved_messages.is_empty()
            && thread_turn_state(&path, turn_id)? == ThreadTurnState::Missing
        {
            items.push(value_event(
                EventKind::TurnStarted,
                serde_json::json!({ "turnId": turn_id }),
            ));
        }
        items.extend(
            saved_messages
                .into_iter()
                .map(|message| {
                    typed_response_item(message, "append thread messages")
                        .map(ThreadLogItem::ResponseItem)
                })
                .collect::<Result<Vec<_>, _>>()?,
        );
        if items
            .iter()
            .any(|item| matches!(item, ThreadLogItem::ResponseItem(_)))
        {
            items.push(value_event(
                EventKind::TurnComplete,
                serde_json::json!({ "turnId": turn_id }),
            ));
        }
        if let Some(title) = derived_title.as_ref() {
            items.push(value_event(
                EventKind::MetadataUpdated,
                serde_json::json!({ "metadata": { "title": title } }),
            ));
        }
        if !items.is_empty() {
            self.recorder
                .append_items(&path, timestamp.clone(), items)?;
            record.updated_at = timestamp;
            if let Some(title) = derived_title {
                record.title = title;
            }
            record.preview = preview_from_messages(&next_messages);
            let log_head = self.recorder.thread_log_head(&path)?;
            self.state.upsert_thread_projection(&record, &log_head)?;
        }
        self.latest_persisted_thread_record(&path)
    }

    pub fn upsert_thread_task_progress(
        &self,
        thread_id: &str,
        turn_id: &str,
        plan_id: &str,
        progress: Value,
        content: String,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut message = normalized_task_progress_message(plan_id, progress, content)?;
        insert_required_turn_id(&mut message, turn_id, "task progress message")?;
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let Some(mut record) = self.find_live_record(thread_id)? else {
            return Err(thread_mutation_error("thread not found", thread_id));
        };
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let replay =
            reconstruction::reconstruct_canonical_rollout(&read_thread_lines(&path)?)?.semantic;
        let mut next_messages = replay.messages;
        if let Some(existing) = next_messages.iter_mut().find(|existing| {
            existing
                .get("_task_plan_id")
                .and_then(Value::as_str)
                .is_some_and(|existing_plan_id| existing_plan_id == plan_id)
        }) {
            *existing = message.clone();
        } else {
            next_messages.push(message.clone());
        }
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            ThreadLogItem::ResponseItem(typed_response_item(message, "task progress message")?),
        )?;
        record.updated_at = timestamp;
        record.preview = preview_from_messages(&next_messages);
        let log_head = self.recorder.thread_log_head(&path)?;
        self.state.upsert_thread_projection(&record, &log_head)?;
        self.latest_persisted_thread_record(&path)
    }

    pub fn clear_thread(&self, thread_id: &str) -> Result<ThreadClearResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let _process_guard = CONTEXT_CHECKPOINT_COMMIT_LOCK.lock().map_err(|_| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "context compaction checkpoint commit lock is poisoned",
                serde_json::json!({ "threadId": thread_id }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        let tinybot_root = self
            .thread_root
            .parent()
            .unwrap_or(self.thread_root.as_path());
        let _file_guard =
            checkpoint_lock::acquire_context_checkpoint_lock(tinybot_root).map_err(|error| {
                WorkerProtocolError::new(
                    WorkerProtocolErrorCode::WorkerError,
                    format!("failed to acquire cross-process context checkpoint lock: {error}"),
                    serde_json::json!({ "threadId": thread_id }),
                    true,
                    WorkerProtocolErrorSource::RustCore,
                )
            })?;
        self.ensure_state_index()?;
        let timestamp = now_thread_timestamp();
        let Some(mut record) = self.find_live_record(thread_id)? else {
            return Err(thread_mutation_error("thread not found", thread_id));
        };
        let path = PathBuf::from(record.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let lines = read_thread_lines(&path)?;
        let reconstructed = reconstruction::reconstruct_canonical_rollout(&lines)?;
        let replay = reconstructed.semantic;
        let checkpoint_cleared = reconstructed
            .turns
            .iter()
            .any(|turn| turn.checkpoint.is_some());
        let checkpoint = serde_json::json!({
            "replacementHistory": [],
            "threadScoped": true
        });
        self.recorder.append_items(
            &path,
            timestamp.clone(),
            vec![
                ThreadLogItem::Compacted(typed_compacted_item(checkpoint, "thread clear")?),
                value_event(
                    EventKind::SessionCleared,
                    serde_json::json!({ "threadId": record.id }),
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
        let thread = self.latest_persisted_thread_record(&path)?;
        Ok(ThreadClearResult {
            thread_id: record.id,
            messages_before,
            messages_after: 0,
            checkpoint_cleared,
            thread,
        })
    }

    pub fn delete_thread(&self, thread_id: &str) -> Result<bool, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let Some(record) = self.state.find_by_session_or_thread_id(thread_id)? else {
            return Ok(false);
        };
        let path = PathBuf::from(&record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        self.recorder.delete_rollout(&path)?;
        self.reconstruction_cache
            .lock()
            .map_err(|_| {
                thread_log_consistency_error(
                    "thread Rollout reconstruction cache lock was poisoned",
                    serde_json::json!({ "threadId": record.id }),
                )
            })?
            .remove(&path);
        if !self.state.delete_thread(&record.id)? {
            return Err(thread_log_consistency_error(
                "deleted Rollout still has a derived state record",
                serde_json::json!({ "threadId": record.id }),
            ));
        }
        Ok(true)
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
        if !compression::rollout_exists(&source)? {
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
        let timestamp = now_thread_timestamp();
        let archive_event = || {
            value_event(
                EventKind::MetadataUpdated,
                serde_json::json!({
                    "metadata": {
                        "archived": archived,
                    }
                }),
            )
        };
        let target = if archived {
            self.recorder
                .append_item(&source, timestamp.clone(), archive_event())?;
            match self.recorder.archive_rollout(&source) {
                Ok(target) => target,
                Err(error) => {
                    let rollback_timestamp = now_thread_timestamp();
                    if let Err(rollback_error) = self.recorder.append_item(
                        &source,
                        rollback_timestamp,
                        value_event(
                            EventKind::MetadataUpdated,
                            serde_json::json!({
                                "metadata": {
                                    "archived": false,
                                }
                            }),
                        ),
                    ) {
                        eprintln!(
                            "thread_rollout_archive_marker_rollback_failed thread_id={} \
                             archive_error={} rollback_error={}",
                            record.id, error.message, rollback_error.message
                        );
                    }
                    return Err(error);
                }
            }
        } else {
            let target = self.recorder.unarchive_rollout(&source)?;
            self.recorder
                .append_item(&target, timestamp, archive_event())?;
            target
        };
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
    let semantic = reconstruction::reconstruct_canonical_rollout(lines)?.semantic;
    let Some(line_index) = semantic
        .effective_line_indexes
        .iter()
        .rev()
        .copied()
        .find(|index| matches!(lines[*index].item, ThreadLogItem::Compacted(_)))
    else {
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

fn fork_rollout_line_indexes(
    lines: &[ThreadLogLine],
    effective_line_indexes: &[usize],
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
                    thread_item_sequence_from_rollout_line(line, index).map(|value| (index, value))
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
    let completed_cutoff = completed_turn_boundary(lines, effective_line_indexes, cutoff)
        .ok_or_else(|| {
            thread_fork_error(
                fork_thread_id,
                "fork boundary must end at a completed persisted turn",
            )
        })?;
    Ok(effective_line_indexes
        .iter()
        .copied()
        .filter(|index| *index <= completed_cutoff)
        .collect())
}

fn completed_turn_boundary(
    lines: &[ThreadLogLine],
    effective_line_indexes: &[usize],
    cutoff: usize,
) -> Option<usize> {
    let mut active = false;
    for index in effective_line_indexes
        .iter()
        .copied()
        .take_while(|index| *index <= cutoff)
    {
        let line = &lines[index];
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        if event.kind().starts_turn() {
            active = true;
        } else if event.kind().ends_turn() {
            active = false;
        }
    }
    if !active {
        return Some(cutoff);
    }
    for index in effective_line_indexes
        .iter()
        .copied()
        .filter(|index| *index > cutoff)
    {
        let line = &lines[index];
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        if event.kind().ends_turn() {
            return Some(index);
        }
        if event.kind().starts_turn() {
            return None;
        }
    }
    None
}

fn fork_inherits_rollout_item(item: &ThreadLogItem, include_checkpoints: bool) -> bool {
    let ThreadLogItem::EventMsg(event) = item else {
        return !matches!(item, ThreadLogItem::SessionMeta(_));
    };
    if matches!(event.kind(), EventKind::ThreadRolledBack) || event.kind().is_turn_lifecycle() {
        return false;
    }
    if !matches!(event.kind(), EventKind::ThreadItem) {
        return true;
    }
    let item_type = event
        .payload()
        .get("item")
        .and_then(|item| item.get("kind"))
        .and_then(|kind| kind.get("type"))
        .and_then(Value::as_str);
    match item_type {
        Some(value) if value.starts_with("turn_") => false,
        Some("checkpoint_created") if !include_checkpoints => false,
        _ => true,
    }
}

fn thread_item_sequence_from_rollout_line(line: &ThreadLogLine, index: usize) -> Option<u64> {
    let rollout_sequence = line.ordinal.unwrap_or(index as u64);
    match &line.item {
        ThreadLogItem::ResponseItem(message) => message
            .get("threadItemSequence")
            .or_else(|| message.get("thread_item_sequence"))
            .and_then(Value::as_u64)
            .or(Some(rollout_sequence)),
        ThreadLogItem::Compacted(_) | ThreadLogItem::InterAgentCommunication(_) => {
            Some(rollout_sequence)
        }
        ThreadLogItem::EventMsg(event) if event.kind() == &EventKind::ThreadItem => event
            .payload()
            .get("item")
            .and_then(|item| item.get("sequence"))
            .and_then(Value::as_u64)
            .filter(|sequence| *sequence != 0)
            .or(Some(rollout_sequence)),
        ThreadLogItem::EventMsg(event)
            if matches!(
                event.kind(),
                EventKind::TurnStarted | EventKind::TurnComplete | EventKind::UserMessage
            ) =>
        {
            event
                .payload()
                .get("_threadItemSequence")
                .and_then(Value::as_u64)
                .or(Some(rollout_sequence))
        }
        ThreadLogItem::EventMsg(event) if event.kind() == &EventKind::TurnCheckpointSet => {
            Some(rollout_sequence)
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
        return Ok(reconstruction::reconstruct_canonical_rollout(lines)?.semantic);
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
    Ok(reconstruction::reconstruct_canonical_rollout(&replay_lines)?.semantic)
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
        } else if let Some(logical_path) = compression::logical_rollout_path(&path) {
            if !is_canonical_thread_log_path(thread_root, &logical_path) {
                continue;
            }
            if paths.contains(&logical_path) {
                return Err(thread_log_consistency_error(
                    "materialized and compressed Rollouts both exist",
                    serde_json::json!({
                        "threadPath": logical_path.display().to_string(),
                    }),
                ));
            }
            paths.push(logical_path);
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

fn is_default_thread_title(title: &str) -> bool {
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

fn thread_mutation_error(message: &str, thread_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "threadId": thread_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn invalid_task_plan(plan_id: &str, reason: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        format!("invalid task plan: {reason}"),
        serde_json::json!({ "plan_id": plan_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn normalized_task_progress_message(
    plan_id: &str,
    mut progress: Value,
    content: String,
) -> Result<Value, WorkerProtocolError> {
    if plan_id.is_empty() {
        return Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid task plan id",
            serde_json::json!({ "plan_id": plan_id }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ));
    }
    let mut steps = progress
        .get("steps")
        .or_else(|| progress.get("plan"))
        .cloned()
        .ok_or_else(|| invalid_task_plan(plan_id, "plan steps are required"))
        .and_then(|steps| {
            serde_json::from_value::<Vec<crate::agent::runtime::AgentPlanStep>>(steps)
                .map_err(|error| invalid_task_plan(plan_id, &error.to_string()))
        })?;
    let derived = crate::agent::runtime::validate_and_normalize_plan_steps(&mut steps)
        .map_err(|error| invalid_task_plan(plan_id, &error))?;
    let provided_current_step = progress
        .get("currentStep")
        .or_else(|| progress.get("current_step"))
        .and_then(Value::as_str);
    if progress
        .get("completed")
        .and_then(Value::as_u64)
        .is_some_and(|value| value != u64::from(derived.completed))
        || progress
            .get("total")
            .and_then(Value::as_u64)
            .is_some_and(|value| value != u64::from(derived.total))
        || provided_current_step.is_some_and(|value| Some(value) != derived.current_step.as_deref())
    {
        return Err(invalid_task_plan(
            plan_id,
            "progress counters or current step do not match plan steps",
        ));
    }
    let progress_object = progress
        .as_object_mut()
        .ok_or_else(|| invalid_task_plan(plan_id, "progress must be an object"))?;
    progress_object.insert("steps".to_string(), serde_json::json!(steps));
    progress_object.insert(
        "completed".to_string(),
        Value::from(u64::from(derived.completed)),
    );
    progress_object.insert("total".to_string(), Value::from(u64::from(derived.total)));
    match derived.current_step.as_ref() {
        Some(current_step) => {
            progress_object.insert(
                "currentStep".to_string(),
                Value::String(current_step.clone()),
            );
        }
        None => {
            progress_object.remove("currentStep");
            progress_object.remove("current_step");
        }
    }
    let agent_item = crate::agent::runtime::AgentItem::PlanProgress(
        crate::agent::runtime::AgentPlanProgressItem {
            id: plan_id.to_string(),
            explanation: progress
                .get("explanation")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            steps,
            summary: content.clone(),
            completed: derived.completed,
            total: derived.total,
            current_step: derived.current_step,
        },
    );
    Ok(serde_json::json!({
        "role": "progress",
        "content": content,
        "timestamp": now_thread_timestamp(),
        "_progress": true,
        "_task_event": true,
        "_task_progress": progress,
        "_task_plan_id": plan_id,
        "_tool_name": "task",
        "_agent_item": agent_item,
    }))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ThreadTurnState {
    Missing,
    Incomplete,
    Complete,
}

fn thread_turn_state(path: &Path, turn_id: &str) -> Result<ThreadTurnState, WorkerProtocolError> {
    if !compression::rollout_exists(path)? {
        return Ok(ThreadTurnState::Missing);
    }
    let lines = read_thread_lines(path)?;
    let mut saw_turn = false;
    for line in lines {
        match line.item {
            ThreadLogItem::EventMsg(event) => {
                let event_turn_id = event
                    .payload()
                    .get("turnId")
                    .or_else(|| event.payload().get("turn_id"))
                    .and_then(Value::as_str);
                match (event.kind(), event_turn_id) {
                    (EventKind::TurnComplete | EventKind::TaskComplete, Some(value))
                        if value == turn_id =>
                    {
                        return Ok(ThreadTurnState::Complete);
                    }
                    (EventKind::TurnStarted | EventKind::TaskStarted, Some(value))
                        if value == turn_id =>
                    {
                        saw_turn = true;
                    }
                    _ => {}
                }
            }
            ThreadLogItem::ResponseItem(item) => {
                if item
                    .get("turnId")
                    .or_else(|| item.get("turn_id"))
                    .and_then(Value::as_str)
                    == Some(turn_id)
                {
                    saw_turn = true;
                }
            }
            _ => {}
        }
    }
    Ok(if saw_turn {
        ThreadTurnState::Incomplete
    } else {
        ThreadTurnState::Missing
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
        if event.kind() != &EventKind::MetadataUpdated {
            continue;
        }
        let Some(metadata) = event.payload().get("metadata").and_then(Value::as_object) else {
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

fn thread_items_from_effective_rollout(
    lines: &[ThreadLogLine],
    effective_indexes: &[usize],
    thread_id: &str,
) -> Result<Vec<ThreadItem>, WorkerProtocolError> {
    let after_clear = effective_indexes
        .iter()
        .copied()
        .filter(|index| {
            matches!(
                &lines[*index].item,
                ThreadLogItem::EventMsg(event)
                    if event.kind() == &EventKind::SessionCleared
            )
        })
        .max()
        .map(|index| index.saturating_add(1))
        .unwrap_or(0);
    let mut items = Vec::new();
    let mut item_ids = HashSet::new();
    let mut active_turn_id = None::<String>;
    for index in effective_indexes
        .iter()
        .copied()
        .filter(|index| *index >= after_clear)
    {
        let line = &lines[index];
        let sequence = line.ordinal.unwrap_or_else(|| index as u64);
        let projected = match &line.item {
            ThreadLogItem::ResponseItem(item) => {
                let item_sequence = item
                    .as_value()
                    .get("threadItemSequence")
                    .or_else(|| item.as_value().get("thread_item_sequence"))
                    .and_then(Value::as_u64)
                    .unwrap_or(sequence);
                Some(ThreadItem {
                    item_id: rollout_thread_item_id(item.as_value(), thread_id, item_sequence),
                    thread_id: thread_id.to_string(),
                    turn_id: required_thread_item_turn_id(
                        string_value(item.as_value(), "turnId")
                            .or_else(|| string_value(item.as_value(), "turn_id"))
                            .or_else(|| active_turn_id.clone()),
                        thread_id,
                        line,
                        "response_item",
                    )?,
                    parent_item_id: string_value(item.as_value(), "parentItemId")
                        .or_else(|| string_value(item.as_value(), "parent_item_id")),
                    sequence: item_sequence,
                    created_at: line.timestamp.clone(),
                    kind: response_item_thread_kind(item.as_value()),
                })
            }
            ThreadLogItem::EventMsg(event) if event.kind() == &EventKind::ThreadItem => Some(
                thread_item_from_event_payload(event.payload(), thread_id, sequence, line)?,
            ),
            ThreadLogItem::EventMsg(event)
                if matches!(
                    event.kind(),
                    EventKind::TurnStarted | EventKind::TurnComplete | EventKind::TurnAborted
                ) =>
            {
                Some(thread_boundary_item_from_rollout_event(
                    event, thread_id, sequence, line,
                )?)
            }
            ThreadLogItem::EventMsg(event) if event.kind() == &EventKind::UserMessage => Some(
                thread_user_item_from_rollout_event(event.payload(), thread_id, sequence, line)?,
            ),
            ThreadLogItem::EventMsg(event) if event.kind() == &EventKind::TurnCheckpointSet => {
                Some(thread_checkpoint_item_from_turn_event(
                    event.payload(),
                    thread_id,
                    sequence,
                    line,
                )?)
            }
            ThreadLogItem::Compacted(checkpoint)
                if checkpoint
                    .get("threadScoped")
                    .and_then(Value::as_bool)
                    .unwrap_or(false) =>
            {
                None
            }
            ThreadLogItem::Compacted(checkpoint) => Some(ThreadItem {
                item_id: checkpoint
                    .get("_threadItemId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("rollout:{thread_id}:{sequence}")),
                thread_id: thread_id.to_string(),
                turn_id: required_thread_item_turn_id(
                    string_value(checkpoint.as_value(), "turnId")
                        .or_else(|| string_value(checkpoint.as_value(), "turn_id"))
                        .or_else(|| active_turn_id.clone()),
                    thread_id,
                    line,
                    "compacted",
                )
                .map_err(|mut error| {
                    error.details["checkpointStage"] = checkpoint
                        .get("checkpointStage")
                        .cloned()
                        .unwrap_or(Value::Null);
                    error.details["contextId"] =
                        checkpoint.get("contextId").cloned().unwrap_or(Value::Null);
                    error
                })?,
                parent_item_id: None,
                sequence,
                created_at: line.timestamp.clone(),
                kind: ThreadItemKind::ContextCompaction(serde_json::json!({
                    "payload": {
                        "contextCheckpoint": checkpoint
                    }
                })),
            }),
            ThreadLogItem::InterAgentCommunication(communication) => Some(ThreadItem {
                item_id: format!("rollout:{thread_id}:{sequence}"),
                thread_id: thread_id.to_string(),
                turn_id: required_thread_item_turn_id(
                    string_value(communication.as_value(), "turnId")
                        .or_else(|| string_value(communication.as_value(), "turn_id"))
                        .or_else(|| active_turn_id.clone()),
                    thread_id,
                    line,
                    "inter_agent_communication",
                )?,
                parent_item_id: None,
                sequence,
                created_at: line.timestamp.clone(),
                kind: ThreadItemKind::SubagentMessage(communication.as_value().clone()),
            }),
            ThreadLogItem::SessionMeta(_)
            | ThreadLogItem::EventMsg(_)
            | ThreadLogItem::TurnContext(_)
            | ThreadLogItem::InterAgentCommunicationMetadata { .. } => None,
        };
        if let ThreadLogItem::EventMsg(event) = &line.item {
            if event.kind().starts_turn() {
                active_turn_id = string_value(event.payload(), "turnId")
                    .or_else(|| string_value(event.payload(), "turn_id"));
            } else if event.kind().ends_turn() {
                active_turn_id = None;
            }
        }
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
    items = collapse_context_compaction_items(items);
    items = collapse_logical_user_messages(items);
    items.sort_by_key(|item| item.sequence);
    Ok(items)
}

fn thread_item_from_event_payload(
    payload: &Value,
    thread_id: &str,
    sequence: u64,
    line: &ThreadLogLine,
) -> Result<ThreadItem, WorkerProtocolError> {
    let mut item =
        serde_json::from_value::<ThreadItem>(payload.get("item").cloned().ok_or_else(|| {
            thread_log_consistency_error(
                "canonical thread_item event is missing its item",
                serde_json::json!({
                    "threadId": thread_id,
                    "ordinal": line.ordinal,
                }),
            )
        })?)
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
    if item.sequence == 0 {
        item.sequence = sequence;
    }
    item.created_at = line.timestamp.clone();
    Ok(item)
}

fn thread_boundary_item_from_rollout_event(
    event: &EventMsg,
    thread_id: &str,
    sequence: u64,
    line: &ThreadLogLine,
) -> Result<ThreadItem, WorkerProtocolError> {
    let payload = event.payload().clone();
    let item_sequence = payload
        .get("_threadItemSequence")
        .and_then(Value::as_u64)
        .unwrap_or(sequence);
    let turn_id = required_thread_item_turn_id(
        string_value(&payload, "turnId").or_else(|| string_value(&payload, "turn_id")),
        thread_id,
        line,
        event.kind().as_str(),
    )?;
    let item_id = payload
        .get("_threadItemId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "rollout:{thread_id}:{item_sequence}:{}",
                event.kind().as_str()
            )
        });
    let mut logical_payload = payload.clone();
    if let Some(object) = logical_payload.as_object_mut() {
        object.remove("_threadItemId");
        object.remove("_threadItemSequence");
    }
    let kind = match event.kind() {
        EventKind::TurnStarted => ThreadItemKind::TurnStarted(logical_payload),
        EventKind::TurnComplete | EventKind::TurnAborted => {
            ThreadItemKind::TurnCompleted(logical_payload)
        }
        _ => {
            return Err(thread_log_consistency_error(
                "non-boundary event cannot project a thread lifecycle item",
                serde_json::json!({
                    "threadId": thread_id,
                    "ordinal": line.ordinal,
                    "eventType": event.kind().as_str(),
                }),
            ));
        }
    };
    Ok(ThreadItem {
        item_id,
        thread_id: thread_id.to_string(),
        turn_id,
        parent_item_id: None,
        sequence: item_sequence,
        created_at: line.timestamp.clone(),
        kind,
    })
}

fn thread_user_item_from_rollout_event(
    payload: &Value,
    thread_id: &str,
    sequence: u64,
    line: &ThreadLogLine,
) -> Result<ThreadItem, WorkerProtocolError> {
    let item_sequence = payload
        .get("_threadItemSequence")
        .and_then(Value::as_u64)
        .unwrap_or(sequence);
    let turn_id = required_thread_item_turn_id(
        string_value(payload, "turnId").or_else(|| string_value(payload, "turn_id")),
        thread_id,
        line,
        "user_message",
    )?;
    let item_id = payload
        .get("_threadItemId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("rollout:{thread_id}:{item_sequence}:user_message"));
    let mut logical_payload = payload.clone();
    if let Some(object) = logical_payload.as_object_mut() {
        object.remove("_threadItemId");
        object.remove("_threadItemSequence");
        object.remove("message");
        object.remove("turnId");
        object.remove("turn_id");
    }
    Ok(ThreadItem {
        item_id,
        thread_id: thread_id.to_string(),
        turn_id,
        parent_item_id: None,
        sequence: item_sequence,
        created_at: line.timestamp.clone(),
        kind: ThreadItemKind::UserMessage(logical_payload),
    })
}

fn thread_checkpoint_item_from_turn_event(
    payload: &Value,
    thread_id: &str,
    sequence: u64,
    line: &ThreadLogLine,
) -> Result<ThreadItem, WorkerProtocolError> {
    let turn_id = string_value(payload, "turnId")
        .or_else(|| string_value(payload, "turn_id"))
        .ok_or_else(|| {
            thread_log_consistency_error(
                "turn_checkpoint_set event is missing its turn id",
                serde_json::json!({
                    "threadId": thread_id,
                    "ordinal": line.ordinal,
                }),
            )
        })?;
    let checkpoint = payload.get("checkpoint").cloned().ok_or_else(|| {
        thread_log_consistency_error(
            "turn_checkpoint_set event is missing its checkpoint",
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "ordinal": line.ordinal,
            }),
        )
    })?;
    let checkpoint_id = string_value(&checkpoint, "resumeToken")
        .or_else(|| string_value(&checkpoint, "checkpointId"))
        .or_else(|| string_value(&checkpoint, "checkpoint_id"))
        .unwrap_or_else(|| format!("{turn_id}:checkpoint:{sequence}"));
    let label = string_value(&checkpoint, "phase");
    Ok(ThreadItem {
        item_id: format!("rollout:{thread_id}:{turn_id}:checkpoint:{checkpoint_id}"),
        thread_id: thread_id.to_string(),
        turn_id,
        parent_item_id: None,
        sequence,
        created_at: line.timestamp.clone(),
        kind: ThreadItemKind::CheckpointCreated(serde_json::json!({
            "checkpointId": checkpoint_id,
            "label": label,
            "restorePayload": checkpoint,
            "source": "rollout.turn_checkpoint_set",
        })),
    })
}

fn collapse_context_compaction_items(items: Vec<ThreadItem>) -> Vec<ThreadItem> {
    let mut collapsed = Vec::with_capacity(items.len());
    let mut compaction_indexes = HashMap::<String, usize>::new();
    for item in items {
        let ThreadItemKind::ContextCompaction(payload) = &item.kind else {
            collapsed.push(item);
            continue;
        };
        let checkpoint = payload
            .get("contextCheckpoint")
            .or_else(|| {
                payload
                    .get("payload")
                    .and_then(|payload| payload.get("contextCheckpoint"))
            })
            .unwrap_or(payload);
        let identity = string_value(checkpoint, "windowId")
            .or_else(|| string_value(checkpoint, "window_id"))
            .or_else(|| string_value(checkpoint, "contextId"))
            .or_else(|| string_value(checkpoint, "context_id"));
        let Some(identity) = identity else {
            collapsed.push(item);
            continue;
        };
        if let Some(index) = compaction_indexes.get(&identity).copied() {
            collapsed[index] = item;
        } else {
            compaction_indexes.insert(identity, collapsed.len());
            collapsed.push(item);
        }
    }
    collapsed
}

fn collapse_logical_user_messages(items: Vec<ThreadItem>) -> Vec<ThreadItem> {
    let mut collapsed = Vec::with_capacity(items.len());
    let mut user_message_indexes = HashMap::<String, usize>::new();
    for item in items {
        let ThreadItemKind::UserMessage(payload) = &item.kind else {
            collapsed.push(item);
            continue;
        };
        let content = string_value(payload, "content")
            .or_else(|| string_value(payload, "text"))
            .unwrap_or_default();
        let message_id = string_value(payload, "messageId")
            .or_else(|| string_value(payload, "message_id"))
            .unwrap_or_default();
        let turn_id = item.turn_id.as_str();
        let identity = format!("{turn_id}\u{1f}{message_id}\u{1f}{content}");
        if !user_message_indexes.contains_key(&identity) {
            user_message_indexes.insert(identity, collapsed.len());
            collapsed.push(item);
        }
    }
    collapsed
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
        Some("user") => ThreadItemKind::UserMessage(response_item_thread_message_payload(item)),
        Some("assistant") => {
            ThreadItemKind::AssistantMessageCompleted(response_item_thread_message_payload(item))
        }
        Some("tool") => ThreadItemKind::ToolCallOutput(item.clone()),
        _ => match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => ThreadItemKind::Reasoning(item.clone()),
            Some("function_call" | "tool_call" | "custom_tool_call") => {
                ThreadItemKind::ToolCallStarted(item.clone())
            }
            Some("function_call_output" | "tool_result" | "custom_tool_call_output") => {
                ThreadItemKind::ToolCallOutput(item.clone())
            }
            _ => ThreadItemKind::Event(item.clone()),
        },
    }
}

fn response_item_thread_message_payload(item: &Value) -> Value {
    let mut payload = item.clone();
    let content = match item.get("content") {
        Some(Value::String(content)) => content.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(Value::as_str))
            })
            .collect(),
        Some(Value::Null) | None => String::new(),
        Some(content) => content.to_string(),
    };
    payload["content"] = Value::String(content);
    if let Some(object) = payload.as_object_mut() {
        object.remove("threadItemPayload");
    }
    payload
}

fn thread_turn_summary_from_turn(
    turn: &AgentTurnRecord,
    items: &[ThreadItem],
) -> ThreadTurnSummary {
    let active = matches!(
        &turn.status,
        AgentTurnStatus::Running | AgentTurnStatus::Waiting
    );
    let status = match &turn.status {
        AgentTurnStatus::Running => ThreadStatus::Running,
        AgentTurnStatus::Waiting if turn.phase.contains("approval") => {
            ThreadStatus::WaitingForApproval
        }
        AgentTurnStatus::Waiting => ThreadStatus::WaitingForInput,
        AgentTurnStatus::Failed => ThreadStatus::Failed,
        AgentTurnStatus::Cancelled | AgentTurnStatus::Interrupted | AgentTurnStatus::Completed => {
            ThreadStatus::Idle
        }
    };
    ThreadTurnSummary {
        turn_id: turn.turn_id.clone(),
        status,
        started_at: Some(turn.started_at.clone()),
        updated_at: Some(turn.updated_at.clone()),
        completed_at: turn.completed_at.clone(),
        model: (!turn.model.is_empty()).then(|| turn.model.clone()),
        provider: turn.provider.clone(),
        item_count: u64::try_from(
            items
                .iter()
                .filter(|item| item.turn_id == turn.turn_id)
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
        turn_id: item.turn_id.clone(),
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
    turns: &[ThreadTurnSummary],
    active_turn: Option<&ThreadTurnSummary>,
) -> ThreadStatus {
    if archived {
        return ThreadStatus::Archived;
    }
    if let Some(active_turn) = active_turn {
        return active_turn.status.clone();
    }
    if turns
        .iter()
        .max_by_key(|turn| turn.updated_at.clone())
        .is_some_and(|turn| turn.status == ThreadStatus::Failed)
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

fn insert_required_turn_id(
    value: &mut Value,
    turn_id: &str,
    context: &str,
) -> Result<(), WorkerProtocolError> {
    let turn_id = turn_id.trim();
    if turn_id.is_empty() {
        return Err(thread_log_consistency_error(
            "canonical Rollout item turn id must not be empty",
            serde_json::json!({ "context": context }),
        ));
    }
    let object = value.as_object_mut().ok_or_else(|| {
        thread_log_consistency_error(
            "canonical Rollout item must be an object before assigning its turn id",
            serde_json::json!({ "context": context }),
        )
    })?;
    if let Some(existing) = object
        .get("turnId")
        .or_else(|| object.get("turn_id"))
        .and_then(Value::as_str)
        .filter(|existing| *existing != turn_id)
    {
        return Err(thread_log_consistency_error(
            "canonical Rollout item turn id conflicts with its enclosing turn",
            serde_json::json!({
                "context": context,
                "expectedTurnId": turn_id,
                "actualTurnId": existing,
            }),
        ));
    }
    object.remove("turn_id");
    object.insert("turnId".to_string(), Value::String(turn_id.to_string()));
    Ok(())
}

fn required_thread_item_turn_id(
    turn_id: Option<String>,
    thread_id: &str,
    line: &ThreadLogLine,
    item_type: &str,
) -> Result<String, WorkerProtocolError> {
    turn_id
        .filter(|turn_id| !turn_id.trim().is_empty())
        .ok_or_else(|| {
            thread_log_consistency_error(
                "canonical Rollout item is missing its turn id",
                serde_json::json!({
                    "threadId": thread_id,
                    "ordinal": line.ordinal,
                    "itemType": item_type,
                }),
            )
        })
}

fn thread_item_to_rollout_items(
    item: &ThreadItem,
) -> Result<Vec<ThreadLogItem>, WorkerProtocolError> {
    let rollout_item = match &item.kind {
        ThreadItemKind::UserMessage(payload) => value_event(
            EventKind::UserMessage,
            thread_user_message_event_payload(item, payload),
        ),
        ThreadItemKind::AssistantMessageCompleted(payload) => {
            ThreadLogItem::ResponseItem(typed_response_item(
                thread_item_message(item, payload, "assistant"),
                "assistant thread projection",
            )?)
        }
        ThreadItemKind::AssistantMessageDelta(_) => return Ok(Vec::new()),
        ThreadItemKind::ContextCompaction(payload) => {
            let checkpoint = payload
                .get("payload")
                .and_then(|payload| payload.get("contextCheckpoint"))
                .or_else(|| payload.get("contextCheckpoint"))
                .unwrap_or(payload);
            let mut checkpoint = checkpoint.clone();
            if let Some(object) = checkpoint.as_object_mut() {
                object.insert("turnId".to_string(), Value::String(item.turn_id.clone()));
                object.insert(
                    "_threadItemId".to_string(),
                    Value::String(item.item_id.clone()),
                );
                object.insert(
                    "_threadItemSequence".to_string(),
                    Value::Number(item.sequence.into()),
                );
            }
            ThreadLogItem::Compacted(typed_compacted_item(
                checkpoint,
                "context compaction thread projection",
            )?)
        }
        ThreadItemKind::TurnStarted(payload) => value_event(
            EventKind::TurnStarted,
            thread_boundary_event_payload(item, payload),
        ),
        ThreadItemKind::TurnCompleted(payload) => {
            let mut items = vec![value_event(
                EventKind::TurnComplete,
                thread_boundary_event_payload(item, payload),
            )];
            if let Some(info) = payload.get("tokenUsageInfo") {
                items.push(value_event(
                    EventKind::TokenCount,
                    serde_json::json!({
                        "info": {
                            "usage": info.get("lastTokenUsage").cloned().unwrap_or(Value::Null),
                            "modelContextWindow": info.get("modelContextWindow").cloned().unwrap_or(Value::Null),
                        }
                    }),
                ));
            }
            return Ok(items);
        }
        _ => thread_projection_event(item),
    };
    Ok(vec![rollout_item])
}

fn thread_projection_event(item: &ThreadItem) -> ThreadLogItem {
    value_event(EventKind::ThreadItem, serde_json::json!({ "item": item }))
}

fn thread_boundary_event_payload(item: &ThreadItem, payload: &Value) -> Value {
    let mut payload = payload
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| serde_json::json!({ "value": payload }));
    payload["turnId"] = Value::String(item.turn_id.clone());
    payload["_threadItemId"] = Value::String(item.item_id.clone());
    payload["_threadItemSequence"] = Value::Number(item.sequence.into());
    payload
}

fn thread_user_message_event_payload(item: &ThreadItem, payload: &Value) -> Value {
    let mut event = thread_boundary_event_payload(item, payload);
    let message = payload
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| payload.get("text").and_then(Value::as_str))
        .or_else(|| payload.as_str())
        .unwrap_or_default();
    event["message"] = Value::String(message.to_string());
    event["turnId"] = Value::String(item.turn_id.clone());
    event
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
    message["threadItemPayload"] = payload.clone();
    message["turnId"] = Value::String(item.turn_id.clone());
    if let Some(parent_item_id) = &item.parent_item_id {
        message["parentItemId"] = Value::String(parent_item_id.clone());
    }
    message
}

fn thread_item_id_from_rollout_line(line: &ThreadLogLine) -> Option<&str> {
    match &line.item {
        ThreadLogItem::ResponseItem(message) => message.get("threadItemId").and_then(Value::as_str),
        ThreadLogItem::Compacted(checkpoint) => {
            checkpoint.get("_threadItemId").and_then(Value::as_str)
        }
        ThreadLogItem::EventMsg(event) if event.kind() == &EventKind::ThreadItem => event
            .payload()
            .get("item")
            .and_then(|item| item.get("itemId"))
            .and_then(Value::as_str),
        ThreadLogItem::EventMsg(event)
            if matches!(
                event.kind(),
                EventKind::TurnStarted | EventKind::TurnComplete | EventKind::UserMessage
            ) =>
        {
            event.payload().get("_threadItemId").and_then(Value::as_str)
        }
        _ => None,
    }
}

fn state_projection_updated_at(created_at: &str, lines: &[ThreadLogLine]) -> String {
    let mut updated_at = created_at.to_string();
    for line in lines {
        let advances_projection = match &line.item {
            ThreadLogItem::ResponseItem(_) | ThreadLogItem::Compacted(_) => true,
            ThreadLogItem::EventMsg(event) => match event.kind() {
                EventKind::TokenCount
                | EventKind::TurnComplete
                | EventKind::TaskComplete
                | EventKind::ThreadRolledBack
                | EventKind::MetadataUpdated
                | EventKind::SessionTrimmed
                | EventKind::TurnCheckpointSet
                | EventKind::TurnCheckpointClear => true,
                EventKind::TurnStarted | EventKind::TurnAborted => true,
                EventKind::TaskStarted
                | EventKind::UserMessage
                | EventKind::SessionCleared
                | EventKind::ThreadItem => false,
            },
            ThreadLogItem::SessionMeta(_)
            | ThreadLogItem::TurnContext(_)
            | ThreadLogItem::InterAgentCommunication(_)
            | ThreadLogItem::InterAgentCommunicationMetadata { .. } => false,
        };
        if advances_projection {
            updated_at = line.timestamp.clone();
        }
    }
    updated_at
}

fn apply_turn_events_to_record(
    record: &mut ThreadStateRecord,
    lines: &[ThreadLogLine],
) -> Result<(), WorkerProtocolError> {
    for line in lines {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        let payload = event.payload();
        match event.kind() {
            EventKind::TurnStarted if payload.get("turn").is_some() => {
                let turn = payload.get("turn").ok_or_else(|| {
                    thread_log_consistency_error(
                        "turn_started event is missing turn",
                        serde_json::json!({ "timestamp": line.timestamp }),
                    )
                })?;
                if let Some(model) = turn
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                {
                    record.model = Some(model.to_string());
                }
                record.model_provider = turn
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(total_tokens) = turn
                    .get("tokenUsageInfo")
                    .and_then(|info| info.get("totalTokenUsage"))
                    .and_then(|usage| usage.get("totalTokens"))
                    .and_then(Value::as_i64)
                {
                    record.tokens_used = total_tokens;
                }
                record.updated_at = line.timestamp.clone();
            }
            EventKind::TurnCheckpointSet | EventKind::TurnCheckpointClear => {
                record.updated_at = line.timestamp.clone();
            }
            EventKind::TurnStarted
            | EventKind::TaskStarted
            | EventKind::TurnComplete
            | EventKind::TaskComplete
            | EventKind::TurnAborted
            | EventKind::UserMessage
            | EventKind::ThreadRolledBack
            | EventKind::TokenCount
            | EventKind::MetadataUpdated
            | EventKind::SessionCleared
            | EventKind::SessionTrimmed
            | EventKind::ThreadItem => {}
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
    let thread_metadata = patch
        .get("threadMetadata")
        .or_else(|| patch.get("threadMetadataPatch"))
        .and_then(Value::as_object);
    if let Some(thread_metadata) = thread_metadata {
        if let Some(preview) = thread_metadata.get("preview") {
            record.preview = preview.as_str().unwrap_or_default().to_string();
        }
        if let Some(cwd) = thread_metadata.get("workingDirectory") {
            record.cwd = cwd.as_str().unwrap_or_default().to_string();
        }
        if let Some(model) = thread_metadata.get("model") {
            record.model = model.as_str().map(str::to_string);
        }
    }
    if let Some(archived) = patch.get("archived").and_then(Value::as_bool) {
        record.archived = archived;
        record.archived_at = archived.then(|| timestamp.to_string());
    }
    record.updated_at = timestamp.to_string();
}

fn initial_thread_metadata(thread: &ThreadRecord) -> serde_json::Map<String, Value> {
    let mut metadata = serde_json::Map::new();
    metadata.insert("initial".to_string(), Value::Bool(true));
    metadata.insert("title".to_string(), Value::String(thread.title.clone()));
    metadata.insert(
        "sessionKey".to_string(),
        serde_json::to_value(&thread.session_key).expect("thread session key should serialize"),
    );
    metadata.insert(
        "rootTurnId".to_string(),
        serde_json::to_value(&thread.root_turn_id).expect("root turn id should serialize"),
    );
    metadata.insert(
        "archivedAt".to_string(),
        serde_json::to_value(&thread.archived_at).expect("archived timestamp should serialize"),
    );
    metadata.insert(
        "threadMetadata".to_string(),
        durable_thread_metadata(&thread.metadata).expect("thread metadata should serialize"),
    );
    metadata
}

fn durable_thread_metadata(
    metadata: &crate::threads::domain::ThreadMetadata,
) -> Result<Value, WorkerProtocolError> {
    let mut value = serde_json::to_value(metadata).map_err(thread_metadata_serialization_error)?;
    let object = value.as_object_mut().ok_or_else(|| {
        thread_log_consistency_error("thread metadata must serialize as an object", Value::Null)
    })?;
    for derived in [
        "preview",
        "lastActivityAt",
        "itemCount",
        "turnCount",
        "hasActiveTurn",
    ] {
        object.remove(derived);
    }
    Ok(value)
}

fn insert_changed_json_field<T: Serialize>(
    metadata: &mut serde_json::Map<String, Value>,
    key: &str,
    previous: &T,
    current: &T,
) -> Result<(), WorkerProtocolError> {
    let previous = serde_json::to_value(previous).map_err(thread_metadata_serialization_error)?;
    let current = serde_json::to_value(current).map_err(thread_metadata_serialization_error)?;
    if previous != current {
        metadata.insert(key.to_string(), current);
    }
    Ok(())
}

fn json_object_diff(previous: Value, current: Value) -> serde_json::Map<String, Value> {
    let previous = previous.as_object().cloned().unwrap_or_default();
    let current = current.as_object().cloned().unwrap_or_default();
    previous
        .keys()
        .chain(current.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .filter_map(|key| {
            let value = current.get(&key).cloned().unwrap_or(Value::Null);
            (previous.get(&key) != Some(&value)).then_some((key, value))
        })
        .collect()
}

fn thread_metadata_serialization_error(error: serde_json::Error) -> WorkerProtocolError {
    thread_log_consistency_error(
        "thread metadata could not be serialized",
        serde_json::json!({ "error": error.to_string() }),
    )
}

fn apply_metadata_patch_to_thread(
    thread: &mut ThreadRecord,
    patch: &serde_json::Map<String, Value>,
) -> Result<(), WorkerProtocolError> {
    if let Some(title) = patch.get("title").and_then(Value::as_str) {
        thread.title = title.to_string();
    }
    if let Some(status) = patch.get("status") {
        thread.status = serde_json::from_value(status.clone()).map_err(|error| {
            thread_log_consistency_error(
                "thread metadata patch contains invalid status",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    if let Some(session_key) = patch.get("sessionKey") {
        thread.session_key = serde_json::from_value(session_key.clone()).map_err(|error| {
            thread_log_consistency_error(
                "thread metadata patch contains invalid sessionKey",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    if let Some(value) = patch.get("rootTurnId") {
        thread.root_turn_id = serde_json::from_value(value.clone()).map_err(|error| {
            thread_log_consistency_error(
                "thread metadata patch contains invalid rootTurnId",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    if let Some(value) = patch.get("activeTurnId") {
        thread.active_turn_id = serde_json::from_value(value.clone()).map_err(|error| {
            thread_log_consistency_error(
                "thread metadata patch contains invalid activeTurnId",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    if let Some(value) = patch.get("archivedAt") {
        thread.archived_at = serde_json::from_value(value.clone()).map_err(|error| {
            thread_log_consistency_error(
                "thread metadata patch contains invalid archivedAt",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    if let Some(value) = patch.get("threadMetadata") {
        thread.metadata = serde_json::from_value(value.clone()).map_err(|error| {
            thread_log_consistency_error(
                "thread metadata patch contains invalid threadMetadata",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    if let Some(metadata_patch) = patch.get("threadMetadataPatch").and_then(Value::as_object) {
        let mut metadata =
            serde_json::to_value(&thread.metadata).map_err(thread_metadata_serialization_error)?;
        let target = metadata.as_object_mut().ok_or_else(|| {
            thread_log_consistency_error("thread metadata must serialize as an object", Value::Null)
        })?;
        for (key, value) in metadata_patch {
            target.insert(key.clone(), value.clone());
        }
        thread.metadata = serde_json::from_value(metadata).map_err(|error| {
            thread_log_consistency_error(
                "thread metadata patch is invalid",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    Ok(())
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

fn thread_record_cache() -> &'static Mutex<HashMap<PathBuf, CachedThreadRecord>> {
    THREAD_RECORD_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_thread_record(path: &Path, head: ThreadLogHead, record: ThreadRecord) {
    cache_thread_record_checked(path, head, record)
        .expect("thread record cache lock should not be poisoned");
}

fn cache_thread_record_checked(
    path: &Path,
    head: ThreadLogHead,
    record: ThreadRecord,
) -> Result<(), WorkerProtocolError> {
    let mut cache = thread_record_cache().lock().map_err(|_| {
        thread_log_consistency_error(
            "thread record cache lock was poisoned",
            serde_json::json!({ "threadPath": path.display().to_string() }),
        )
    })?;
    if cache.len() >= THREAD_RECORD_CACHE_CAPACITY && !cache.contains_key(path) {
        if let Some(evicted) = cache.keys().next().cloned() {
            cache.remove(&evicted);
        }
    }
    cache.insert(path.to_path_buf(), CachedThreadRecord { head, record });
    Ok(())
}

fn typed_response_item(
    mut value: Value,
    context: &str,
) -> Result<ResponseItem, WorkerProtocolError> {
    normalize_response_item_for_rollout(&mut value);
    let diagnostic_value = value.clone();
    ResponseItem::from_value(value).map_err(|error| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "response item cannot be persisted to canonical Rollout",
            serde_json::json!({
                "context": context,
                "error": error,
                "item": diagnostic_value,
            }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })
}

fn normalize_response_item_for_rollout(value: &mut Value) {
    let Some(item) = value.as_object_mut() else {
        return;
    };
    let role = item.get("role").and_then(Value::as_str).map(str::to_string);
    if role.is_some() && !item.contains_key("type") {
        item.insert("type".to_string(), Value::String("message".to_string()));
    }
    if item.get("type").and_then(Value::as_str) != Some("message") {
        return;
    }
    if !item.contains_key("id") {
        if let Some(message_id) = item
            .get("messageId")
            .or_else(|| item.get("message_id"))
            .cloned()
        {
            item.insert("id".to_string(), message_id);
        }
    }
    let Some(Value::String(content)) = item.get("content").cloned() else {
        return;
    };
    let part_type = if role.as_deref() == Some("user") {
        "input_text"
    } else {
        "output_text"
    };
    item.insert(
        "content".to_string(),
        serde_json::json!([{
            "type": part_type,
            "text": content,
        }]),
    );
}

fn typed_compacted_item(value: Value, context: &str) -> Result<CompactedItem, WorkerProtocolError> {
    let diagnostic_value = value.clone();
    CompactedItem::from_value(value).map_err(|error| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "compaction item cannot be persisted to canonical Rollout",
            serde_json::json!({
                "context": context,
                "error": error,
                "item": diagnostic_value,
            }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })
}

fn stale_context_checkpoint_error(
    turn_id: &str,
    context_id: &str,
    error: crate::threads::rollout::checkpoint_lineage::ContextCheckpointLineageError,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        error.to_string(),
        serde_json::json!({
            "turnId": turn_id,
            "contextId": context_id,
            "field": error.field,
            "expected": error.expected,
            "actual": error.actual,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(crate) fn thread_id_for_session_id(session_id: &str) -> String {
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
#[path = "store_schema_tests.rs"]
mod schema_tests;
