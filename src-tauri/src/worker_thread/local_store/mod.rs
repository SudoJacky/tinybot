mod activity;
mod agent_run_projection;
mod checkpoint;
mod fork;
mod index;
mod journal;
mod memory;
mod metadata;
mod query;
mod runtime_projection;
mod subagent_projection;

use super::types::{
    AppendThreadItemsResult, CreateThreadRequest, DeleteThreadRequest, DeleteThreadResult,
    ForkThreadRequest, ListThreadsRequest, ListThreadsResult, ReadThreadRequest,
    RestoreThreadCheckpointRequest, RestoreThreadCheckpointResult, ResumeThreadRequest,
    SearchThreadsRequest, SearchThreadsResult, ThreadActivityRequest, ThreadActivityResult,
    ThreadActivitySummary, ThreadAgentRegistryRequest, ThreadAgentRegistryResult,
    ThreadChildActivity, ThreadChildSummary, ThreadEvent, ThreadEventsRequest, ThreadEventsResult,
    ThreadItem, ThreadItemKind, ThreadMetadata, ThreadMetadataPatch, ThreadPagination,
    ThreadRecord, ThreadSnapshot, ThreadStatus, ThreadStatusResult,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_session::{AgentRunRecord, AgentRunRuntimeState, AgentRunTracePage};
use crate::worker_subagent_manager::{
    SubagentMailboxInput, SubagentThreadStatus, SubagentThreadSummary,
};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use self::activity::{
    agent_registry_entry, child_activities_for_thread as project_child_activities_for_thread,
    pending_approvals_from_items, running_tools_from_items,
};
use self::agent_run_projection::{agent_run_record_from_thread_run, run_summaries_from_items};
use self::checkpoint::{checkpoint_from_item, latest_checkpoint_from_items};
use self::journal::ThreadJournalMutation;
pub use self::journal::{
    ThreadPersistenceConsistencyReport, ThreadPersistenceConsistencyStatus,
    ThreadPersistenceRepairMode, ThreadPersistenceRepairReport, ThreadPersistenceRepairRequest,
};
pub use self::memory::MemoryThreadStore;
use self::metadata::{apply_metadata_patch, recompute_dynamic_metadata, set_metadata_extra_string};
use self::query::{
    bounded_limit, descendant_thread_ids, items_match_query as thread_items_match_query,
    parse_sequence_cursor, parse_trace_cursor, read_cursor_from_request,
    thread_matches_list_filters, thread_matches_query,
};
use self::runtime_projection::{
    runtime_events_from_thread_items, trace_event_from_thread_item, turn_items_from_thread_items,
};
use self::subagent_projection::{
    active_child_run_id_for_status, status_value, subagent_agent_control_payload,
    subagent_child_status_item, subagent_initial_child_items, subagent_input_item,
    subagent_parent_item, thread_status_for_subagent,
};

const THREAD_STORE_VERSION: usize = 1;
const DEFAULT_READ_LIMIT: usize = 200;
const DEFAULT_LIST_LIMIT: usize = 100;
const DEFAULT_SEARCH_LIMIT: usize = 25;
const MAX_READ_LIMIT: usize = 1_000;
const MAX_LIST_LIMIT: usize = 500;
const MAX_SEARCH_LIMIT: usize = 100;
const CLIENT_EVENT_IDS_KEY: &str = "clientEventIds";
pub(super) const CLIENT_FORK_THREAD_IDS_KEY: &str = "clientForkThreadIds";
pub(super) const DEFAULT_THREAD_TITLE: &str = "New session";
pub(super) const TITLE_SOURCE_KEY: &str = "titleSource";
pub(super) const TITLE_SOURCE_MANUAL: &str = "manual";

static THREAD_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static ITEM_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub trait ThreadStore: Clone + std::fmt::Debug + Send + Sync + 'static {
    fn create_thread(
        &self,
        request: CreateThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn read_thread(
        &self,
        request: ReadThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError>;
    fn resume_thread(
        &self,
        request: ResumeThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError>;
    fn get_thread_status(&self, thread_id: &str)
        -> Result<ThreadStatusResult, WorkerProtocolError>;
    fn list_threads(
        &self,
        request: ListThreadsRequest,
    ) -> Result<ListThreadsResult, WorkerProtocolError>;
    fn search_threads(
        &self,
        request: SearchThreadsRequest,
    ) -> Result<SearchThreadsResult, WorkerProtocolError>;
    fn update_thread_metadata(
        &self,
        thread_id: &str,
        patch: ThreadMetadataPatch,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn update_thread_session_key(
        &self,
        thread_id: &str,
        session_key: String,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn archive_thread(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn archive_thread_with_children(
        &self,
        thread_id: &str,
        archived: bool,
        archive_children: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn delete_thread(
        &self,
        request: DeleteThreadRequest,
    ) -> Result<DeleteThreadResult, WorkerProtocolError>;
    fn fork_thread(&self, request: ForkThreadRequest) -> Result<ThreadRecord, WorkerProtocolError>;
    fn append_items(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError>;
    fn append_items_with_client_event_id(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError>;
    fn client_event_items(
        &self,
        thread_id: &str,
        client_event_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError>;
}

#[derive(Clone, Debug)]
pub struct LocalThreadStore {
    root: PathBuf,
    mutation_lock: Arc<Mutex<()>>,
}

impl LocalThreadStore {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            root: workspace_root.join(".tinybot").join("threads"),
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    fn sqlite_path(&self) -> PathBuf {
        self.root.join("threads.sqlite")
    }

    pub fn exists(&self) -> bool {
        self.sqlite_path().exists()
    }

    pub fn append_items_with_client_event_id(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.append_items_internal(thread_id, items, client_event_id)
    }

    pub fn client_event_items(
        &self,
        thread_id: &str,
        client_event_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let index = self.read_index()?;
        let record = index
            .threads
            .iter()
            .find(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        let Some(item_ids) = client_event_item_ids(&record.metadata, client_event_id) else {
            return Ok(None);
        };
        let existing = self.read_items(thread_id)?;
        let replayed = item_ids
            .iter()
            .filter_map(|item_id| {
                existing
                    .iter()
                    .find(|existing_item| existing_item.item_id == *item_id)
                    .cloned()
            })
            .collect::<Vec<_>>();
        if replayed.len() == item_ids.len() {
            Ok(Some(replayed))
        } else {
            Ok(None)
        }
    }

    pub fn list_all_thread_records(
        &self,
        include_archived: bool,
    ) -> Result<Vec<ThreadRecord>, WorkerProtocolError> {
        let mut threads = self.read_index()?.threads;
        if !include_archived {
            threads.retain(|thread| thread.status != ThreadStatus::Archived);
        }
        threads.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
        });
        Ok(threads)
    }

    pub fn thread_matches_list_request(
        &self,
        thread: &ThreadRecord,
        all_threads: &[ThreadRecord],
        request: &ListThreadsRequest,
    ) -> bool {
        thread_matches_list_filters(thread, all_threads, request)
    }

    pub fn list_agent_run_trace_events(
        &self,
        session_id: &str,
        run_id: &str,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Option<AgentRunTracePage>, WorkerProtocolError> {
        let offset = parse_trace_cursor(cursor)?;
        let limit = bounded_limit(limit, 100, 500);
        let Some(items) = self.agent_run_thread_items(session_id, run_id)? else {
            return Ok(None);
        };
        let events = items
            .iter()
            .filter_map(trace_event_from_thread_item)
            .collect::<Vec<_>>();
        let page_items = events
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_offset = offset.saturating_add(page_items.len());
        let next_cursor = (next_offset < events.len()).then(|| next_offset.to_string());
        Ok(Some(AgentRunTracePage {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            items: page_items,
            next_cursor,
        }))
    }

    pub fn get_agent_run_runtime_state(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRuntimeState>, WorkerProtocolError> {
        let Some(items) = self.agent_run_thread_items(session_id, run_id)? else {
            return Ok(None);
        };
        let runtime_events = runtime_events_from_thread_items(&items, session_id, run_id);
        let turn_items = turn_items_from_thread_items(&items, session_id, run_id);
        Ok(Some(AgentRunRuntimeState {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            runtime_events,
            turn_items,
        }))
    }

    pub fn list_agent_runs_from_threads(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentRunRecord>, WorkerProtocolError> {
        let index = self.read_index()?;
        let mut records = Vec::new();
        for thread in index
            .threads
            .iter()
            .filter(|thread| thread.session_key.as_deref() == Some(session_id))
            .filter(|thread| thread.status != ThreadStatus::Archived)
        {
            let items = self.read_items(&thread.thread_id)?;
            records.extend(
                run_summaries_from_items(thread, &items)
                    .into_iter()
                    .map(|run| agent_run_record_from_thread_run(session_id, thread, &run, &items)),
            );
        }
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.run_id.cmp(&right.run_id))
        });
        Ok(records)
    }

    pub fn get_agent_run_from_threads(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRecord>, WorkerProtocolError> {
        Ok(self
            .list_agent_runs_from_threads(session_id)?
            .into_iter()
            .find(|record| record.run_id == run_id))
    }

    pub fn thread_events(
        &self,
        request: ThreadEventsRequest,
    ) -> Result<ThreadEventsResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let cursor = match request.cursor.as_deref() {
            Some(value) => parse_sequence_cursor(Some(value))?,
            None => request.after_sequence.unwrap_or(0),
        };
        let limit = bounded_limit(request.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
        let index = self.read_index()?;
        let thread = index
            .threads
            .iter()
            .find(|thread| thread.thread_id == request.thread_id)
            .cloned()
            .ok_or_else(|| unknown_thread_error(&request.thread_id))?;

        let all_items = self.read_items(&request.thread_id)?;
        let runs = run_summaries_from_items(&thread, &all_items);
        let active_run = runs.iter().find(|run| run.active).cloned();
        let latest_checkpoint = latest_checkpoint_from_items(&thread.thread_id, &all_items);
        let child_activities = self.child_activities_for_thread(&request.thread_id)?;
        let mut items = all_items
            .into_iter()
            .filter(|item| item.sequence > cursor)
            .collect::<Vec<_>>();
        items.sort_by_key(|item| item.sequence);
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next_cursor = items
            .last()
            .map(|item| item.sequence)
            .unwrap_or(cursor)
            .to_string();
        let mut events = vec![ThreadEvent::ThreadSnapshot {
            thread: thread.clone(),
            active_run: active_run.clone(),
            latest_checkpoint: latest_checkpoint.clone(),
            runs: runs.clone(),
            child_activities: child_activities.clone(),
        }];
        events.push(ThreadEvent::ThreadStatus {
            thread: thread.clone(),
            active_run: active_run.clone(),
            latest_checkpoint: latest_checkpoint.clone(),
            runs: runs.clone(),
        });
        events.extend(
            child_activities
                .iter()
                .cloned()
                .map(|child_activity| ThreadEvent::ChildActivity { child_activity }),
        );
        events.extend(items.iter().cloned().map(|item| ThreadEvent::ItemAppended {
            sequence: item.sequence,
            item,
        }));

        Ok(ThreadEventsResult {
            thread_id: request.thread_id,
            thread,
            active_run,
            latest_checkpoint,
            runs,
            child_activities,
            cursor: cursor.to_string(),
            events,
            items,
            next_cursor,
            has_more,
        })
    }

    pub fn restore_checkpoint(
        &self,
        request: RestoreThreadCheckpointRequest,
    ) -> Result<RestoreThreadCheckpointResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let all_items = self.read_items(&request.thread_id)?;
        let checkpoint = if let Some(checkpoint_id) = request.checkpoint_id.as_deref() {
            all_items
                .iter()
                .filter_map(|item| checkpoint_from_item(&request.thread_id, item))
                .find(|checkpoint| checkpoint.checkpoint_id == checkpoint_id)
                .ok_or_else(|| {
                    invalid_thread_request(
                        "unknown checkpoint id",
                        serde_json::json!({
                            "threadId": request.thread_id,
                            "checkpointId": checkpoint_id
                        }),
                    )
                })?
        } else {
            latest_checkpoint_from_items(&request.thread_id, &all_items).ok_or_else(|| {
                invalid_thread_request(
                    "thread has no checkpoint to restore",
                    serde_json::json!({ "threadId": request.thread_id }),
                )
            })?
        };
        let snapshot = self.read_thread(ReadThreadRequest {
            thread_id: request.thread_id.clone(),
            cursor: None,
            before_sequence: None,
            checkpoint_sequence: None,
            checkpoint_id: Some(checkpoint.checkpoint_id.clone()),
            limit: request.limit,
        })?;
        Ok(RestoreThreadCheckpointResult {
            thread_id: request.thread_id,
            restore_payload: checkpoint.restore_payload.clone(),
            checkpoint,
            snapshot,
        })
    }

    pub fn agent_registry(
        &self,
        request: ThreadAgentRegistryRequest,
    ) -> Result<ThreadAgentRegistryResult, WorkerProtocolError> {
        if let Some(thread_id) = request.thread_id.as_deref() {
            validate_thread_id(thread_id)?;
        }
        let index = self.read_index()?;
        if let Some(thread_id) = request.thread_id.as_deref() {
            if !index
                .threads
                .iter()
                .any(|thread| thread.thread_id == thread_id)
            {
                return Err(unknown_thread_error(thread_id));
            }
        }

        let scoped_thread_ids = request.thread_id.as_deref().map(|thread_id| {
            let mut ids = vec![thread_id.to_string()];
            if request.include_child_threads {
                ids.extend(descendant_thread_ids(&index, thread_id));
            }
            ids
        });
        let mut agents = Vec::new();
        for thread in index.threads.iter().filter(|thread| {
            (request.include_archived || thread.status != ThreadStatus::Archived)
                && scoped_thread_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&thread.thread_id))
                && (request.include_child_threads || thread.parent_thread_id.is_none())
        }) {
            let items = self.read_items(&thread.thread_id)?;
            agents.push(agent_registry_entry(thread, &index, &items));
        }
        agents.sort_by(|left, right| {
            left.depth
                .cmp(&right.depth)
                .then_with(|| {
                    left.agent_path
                        .to_string()
                        .cmp(&right.agent_path.to_string())
                })
                .then_with(|| left.thread_id.cmp(&right.thread_id))
        });
        let active_count = agents.iter().filter(|agent| agent.active).count();
        let waiting_for_approval_count = agents
            .iter()
            .filter(|agent| agent.status == ThreadStatus::WaitingForApproval)
            .count();
        Ok(ThreadAgentRegistryResult {
            root_thread_id: request.thread_id,
            total: agents.len(),
            active_count,
            waiting_for_approval_count,
            agents,
        })
    }

    pub fn activity(
        &self,
        request: ThreadActivityRequest,
    ) -> Result<ThreadActivityResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let index = self.read_index()?;
        let thread = index
            .threads
            .iter()
            .find(|thread| thread.thread_id == request.thread_id)
            .cloned()
            .ok_or_else(|| unknown_thread_error(&request.thread_id))?;
        let mut thread_ids = vec![request.thread_id.clone()];
        if request.include_child_threads {
            thread_ids.extend(descendant_thread_ids(&index, &request.thread_id));
        }

        let mut pending_approvals = Vec::new();
        let mut running_tools = Vec::new();
        let mut checkpoints = Vec::new();
        for thread_id in &thread_ids {
            let items = self.read_items(thread_id)?;
            pending_approvals.extend(pending_approvals_from_items(thread_id, &items));
            running_tools.extend(running_tools_from_items(thread_id, &items));
            if let Some(checkpoint) = latest_checkpoint_from_items(thread_id, &items) {
                checkpoints.push(checkpoint);
            }
        }
        pending_approvals.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.item_id.cmp(&right.item_id))
        });
        running_tools.sort_by(|left, right| {
            right
                .started_at
                .cmp(&left.started_at)
                .then_with(|| left.item_id.cmp(&right.item_id))
        });
        checkpoints.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.checkpoint_id.cmp(&right.checkpoint_id))
        });

        let status = self.get_thread_status(&request.thread_id)?;
        let agents = self.agent_registry(ThreadAgentRegistryRequest {
            thread_id: Some(request.thread_id.clone()),
            include_archived: false,
            include_child_threads: request.include_child_threads,
        })?;
        let summary = ThreadActivitySummary {
            active_children: status.child_activities.len(),
            pending_approvals: pending_approvals.len(),
            running_tools: running_tools.len(),
            checkpoints: checkpoints.len(),
        };
        Ok(ThreadActivityResult {
            thread_id: request.thread_id,
            thread,
            active_run: status.active_run,
            active_children: status.child_activities,
            pending_approvals,
            running_tools,
            checkpoints,
            agents,
            summary,
        })
    }

    pub fn archive_thread_with_children(
        &self,
        thread_id: &str,
        archived: bool,
        archive_children: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.archive_thread_inner(thread_id, archived, archive_children)
    }

    fn archive_thread_inner(
        &self,
        thread_id: &str,
        archived: bool,
        archive_children: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        let timestamp = now_timestamp();
        let mut archive_ids = vec![thread_id.to_string()];
        if archive_children {
            archive_ids.extend(descendant_thread_ids(&index, thread_id));
        }
        let mut updated = None;
        for record in index
            .threads
            .iter_mut()
            .filter(|thread| archive_ids.contains(&thread.thread_id))
        {
            record.updated_at = timestamp.clone();
            if archived {
                record.status = ThreadStatus::Archived;
                record.archived_at = Some(timestamp.clone());
            } else {
                record.status = if record.metadata.item_count == 0 {
                    ThreadStatus::Empty
                } else {
                    ThreadStatus::Idle
                };
                record.archived_at = None;
            }
            if record.thread_id == thread_id {
                updated = Some(record.clone());
            }
        }
        let Some(updated) = updated else {
            return Err(unknown_thread_error(thread_id));
        };
        let changed = index
            .threads
            .iter()
            .filter(|record| archive_ids.contains(&record.thread_id))
            .cloned()
            .map(|record| ThreadJournalMutation::UpsertThread {
                record: Box::new(record),
            })
            .collect();
        let journal_head = self.begin_persistence_operation(None, changed)?;
        self.write_index(&index)?;
        self.complete_persistence_operation(&journal_head)?;
        Ok(updated)
    }

    fn agent_run_thread_items(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError> {
        let index = self.read_index()?;
        let mut matched = false;
        let mut items = Vec::new();
        for thread in index
            .threads
            .iter()
            .filter(|thread| thread.session_key.as_deref() == Some(session_id))
        {
            let mut thread_items = self
                .read_items(&thread.thread_id)?
                .into_iter()
                .filter(|item| item.run_id.as_deref() == Some(run_id))
                .collect::<Vec<_>>();
            let thread_matches_run = thread.root_run_id.as_deref() == Some(run_id)
                || thread.active_run_id.as_deref() == Some(run_id)
                || !thread_items.is_empty();
            if thread_matches_run {
                matched = true;
                items.append(&mut thread_items);
            }
        }
        if !matched {
            return Ok(None);
        }
        items.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.sequence.cmp(&right.sequence))
                .then_with(|| left.item_id.cmp(&right.item_id))
        });
        Ok(Some(items))
    }

    pub fn record_subagent_spawn(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        let parent = self.ensure_parent_thread_for_subagent(summary)?;
        let child = self.ensure_child_thread_for_subagent(summary, &parent.thread_id)?;
        let child_items = subagent_initial_child_items(summary, event.clone());
        if !child_items.is_empty() {
            self.append_items(&child.thread_id, child_items)?;
        }
        self.append_items(
            &parent.thread_id,
            vec![subagent_parent_item(
                summary,
                event,
                "spawned",
                ThreadItemKind::SubagentSpawned,
            )],
        )
    }

    pub fn record_subagent_input(
        &self,
        summary: &SubagentThreadSummary,
        input: &SubagentMailboxInput,
        event: Option<Value>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        let parent = self.ensure_parent_thread_for_subagent(summary)?;
        let child = self.ensure_child_thread_for_subagent(summary, &parent.thread_id)?;
        self.append_items(
            &child.thread_id,
            vec![subagent_input_item(summary, input, event)],
        )
    }

    pub fn record_subagent_status(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        let parent = self.ensure_parent_thread_for_subagent(summary)?;
        let child = self.ensure_child_thread_for_subagent(summary, &parent.thread_id)?;
        let child_result = self.append_items(
            &child.thread_id,
            vec![subagent_child_status_item(summary, event.clone())],
        )?;
        if matches!(
            summary.status,
            SubagentThreadStatus::Completed
                | SubagentThreadStatus::Failed
                | SubagentThreadStatus::Cancelled
                | SubagentThreadStatus::Closed
                | SubagentThreadStatus::Interrupted
        ) {
            return self.append_items(
                &parent.thread_id,
                vec![subagent_parent_item(
                    summary,
                    event,
                    "completed",
                    ThreadItemKind::SubagentCompleted,
                )],
            );
        }
        Ok(child_result)
    }

    fn ensure_parent_thread_for_subagent(
        &self,
        summary: &SubagentThreadSummary,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        if let Some(position) = index.threads.iter().position(|thread| {
            thread.session_key.as_deref() == Some(summary.session_key.as_str())
                && thread.parent_thread_id.is_none()
        }) {
            return Ok(index.threads[position].clone());
        }
        let timestamp = summary.created_at.clone();
        let thread = ThreadRecord {
            thread_id: generate_thread_id(),
            title: format!("Desktop Session {}", summary.session_key),
            status: ThreadStatus::Idle,
            session_key: Some(summary.session_key.clone()),
            root_run_id: summary.parent_run_id.clone(),
            active_run_id: summary.parent_run_id.clone(),
            parent_thread_id: None,
            source: "legacy_subagent_parent".to_string(),
            created_at: timestamp.clone(),
            updated_at: summary.updated_at.clone(),
            archived_at: None,
            metadata: ThreadMetadata {
                last_activity_at: Some(timestamp),
                extra: serde_json::json!({ "legacySubagentParent": true }),
                ..ThreadMetadata::default()
            },
        };
        index.threads.push(thread.clone());
        let journal_head = self.begin_persistence_operation(
            None,
            vec![ThreadJournalMutation::UpsertThread {
                record: Box::new(thread.clone()),
            }],
        )?;
        self.write_index(&index)?;
        self.write_items(&thread.thread_id, &[])?;
        self.complete_persistence_operation(&journal_head)?;
        Ok(thread)
    }

    fn ensure_child_thread_for_subagent(
        &self,
        summary: &SubagentThreadSummary,
        parent_thread_id: &str,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        if let Some(position) = index.threads.iter().position(|thread| {
            thread.source == "subagent"
                && thread.session_key.as_deref() == Some(summary.session_key.as_str())
                && thread
                    .metadata
                    .extra
                    .get("subagentId")
                    .and_then(Value::as_str)
                    == Some(summary.subagent_id.as_str())
        }) {
            let thread = &mut index.threads[position];
            thread.title = summary.name.clone();
            thread.active_run_id = active_child_run_id_for_status(summary);
            thread.status = thread_status_for_subagent(&summary.status);
            thread.updated_at = summary.updated_at.clone();
            thread.metadata.preview = non_empty_string(&summary.task);
            thread.metadata.has_active_run = active_child_run_id_for_status(summary).is_some();
            thread.metadata.last_activity_at = Some(summary.updated_at.clone());
            thread.metadata.extra["status"] = status_value(&summary.status);
            thread.metadata.extra["agentControl"] =
                subagent_agent_control_payload(summary, parent_thread_id);
            let updated = thread.clone();
            let journal_head = self.begin_persistence_operation(
                None,
                vec![ThreadJournalMutation::UpsertThread {
                    record: Box::new(updated.clone()),
                }],
            )?;
            self.write_index(&index)?;
            self.complete_persistence_operation(&journal_head)?;
            return Ok(updated);
        }
        let thread = ThreadRecord {
            thread_id: generate_thread_id(),
            title: summary.name.clone(),
            status: thread_status_for_subagent(&summary.status),
            session_key: Some(summary.session_key.clone()),
            root_run_id: Some(summary.child_run_id.clone()),
            active_run_id: active_child_run_id_for_status(summary),
            parent_thread_id: Some(parent_thread_id.to_string()),
            source: "subagent".to_string(),
            created_at: summary.created_at.clone(),
            updated_at: summary.updated_at.clone(),
            archived_at: None,
            metadata: ThreadMetadata {
                preview: non_empty_string(&summary.task),
                tags: vec!["subagent".to_string()],
                last_activity_at: Some(summary.updated_at.clone()),
                has_active_run: active_child_run_id_for_status(summary).is_some(),
                extra: serde_json::json!({
                    "subagentId": summary.subagent_id,
                    "childRunId": summary.child_run_id,
                    "parentRunId": summary.parent_run_id,
                    "traceRef": summary.trace_ref,
                    "status": summary.status,
                    "agentControl": subagent_agent_control_payload(summary, parent_thread_id),
                }),
                ..ThreadMetadata::default()
            },
        };
        index.threads.push(thread.clone());
        let journal_head = self.begin_persistence_operation(
            None,
            vec![ThreadJournalMutation::UpsertThread {
                record: Box::new(thread.clone()),
            }],
        )?;
        self.write_index(&index)?;
        self.write_items(&thread.thread_id, &[])?;
        self.complete_persistence_operation(&journal_head)?;
        Ok(thread)
    }
}

impl From<&ThreadRecord> for ThreadChildSummary {
    fn from(record: &ThreadRecord) -> Self {
        Self {
            thread_id: record.thread_id.clone(),
            title: record.title.clone(),
            status: record.status.clone(),
            source: record.source.clone(),
            subagent_id: record
                .metadata
                .extra
                .get("subagentId")
                .and_then(Value::as_str)
                .map(str::to_string),
            child_run_id: record
                .metadata
                .extra
                .get("childRunId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| record.root_run_id.clone()),
            preview: record.metadata.preview.clone(),
            agent_control: record.metadata.extra.get("agentControl").cloned(),
            updated_at: record.updated_at.clone(),
        }
    }
}

impl ThreadStore for LocalThreadStore {
    fn create_thread(
        &self,
        request: CreateThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let thread_id = request.thread_id.unwrap_or_else(generate_thread_id);
        validate_thread_id(&thread_id)?;
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        if index
            .threads
            .iter()
            .any(|thread| thread.thread_id == thread_id)
        {
            return Err(invalid_thread_request(
                "thread already exists",
                serde_json::json!({ "threadId": thread_id }),
            ));
        }

        let timestamp = now_timestamp();
        let has_explicit_title = request.title.is_some() || request.metadata.title.is_some();
        let title = request
            .title
            .or_else(|| request.metadata.title.clone())
            .unwrap_or_else(|| DEFAULT_THREAD_TITLE.to_string());
        let mut metadata = ThreadMetadata {
            summary: request.metadata.summary,
            preview: request.metadata.preview,
            tags: request.metadata.tags.unwrap_or_default(),
            model: request.metadata.model,
            working_directory: request.metadata.working_directory,
            last_user_message_at: request.metadata.last_user_message_at,
            last_assistant_message_at: request.metadata.last_assistant_message_at,
            last_activity_at: request
                .metadata
                .last_activity_at
                .or_else(|| Some(timestamp.clone())),
            has_active_run: request.metadata.has_active_run.unwrap_or(false),
            extra: request
                .metadata
                .extra
                .unwrap_or(Value::Object(Default::default())),
            ..ThreadMetadata::default()
        };
        if has_explicit_title {
            set_metadata_extra_string(&mut metadata.extra, TITLE_SOURCE_KEY, TITLE_SOURCE_MANUAL);
        }
        if request.root_run_id.is_some() {
            metadata.run_count = 1;
        }
        let record = ThreadRecord {
            thread_id: thread_id.clone(),
            title,
            status: ThreadStatus::Empty,
            session_key: request.session_key,
            root_run_id: request.root_run_id,
            active_run_id: request.active_run_id,
            parent_thread_id: request.parent_thread_id,
            source: request.source.unwrap_or_else(|| "user".to_string()),
            created_at: timestamp.clone(),
            updated_at: timestamp,
            archived_at: None,
            metadata,
        };
        index.threads.push(record.clone());
        let journal_head = self.begin_persistence_operation(
            None,
            vec![ThreadJournalMutation::UpsertThread {
                record: Box::new(record.clone()),
            }],
        )?;
        self.write_index(&index)?;
        self.write_items(&thread_id, &[])?;
        self.complete_persistence_operation(&journal_head)?;
        Ok(record)
    }

    fn read_thread(
        &self,
        request: ReadThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let index = self.read_index()?;
        let thread = index
            .threads
            .iter()
            .find(|thread| thread.thread_id == request.thread_id)
            .cloned()
            .ok_or_else(|| unknown_thread_error(&request.thread_id))?;
        let children = index
            .threads
            .iter()
            .filter(|candidate| {
                candidate.parent_thread_id.as_deref() == Some(thread.thread_id.as_str())
            })
            .map(ThreadChildSummary::from)
            .collect::<Vec<_>>();
        let limit = bounded_limit(request.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
        let all_items = self.read_items(&request.thread_id)?;
        let cursor = read_cursor_from_request(&request, &all_items)?;
        let item_count = all_items.len();
        let runs = run_summaries_from_items(&thread, &all_items);
        let active_run = runs.iter().find(|run| run.active).cloned();
        let latest_checkpoint = latest_checkpoint_from_items(&thread.thread_id, &all_items);
        let session_id = thread.session_key.as_deref().unwrap_or_default();
        let turn_items = active_run
            .as_ref()
            .map(|run| turn_items_from_thread_items(&all_items, session_id, &run.run_id))
            .unwrap_or_default();
        let child_activities = self.child_activities_for_thread(&request.thread_id)?;
        let mut filtered = all_items
            .iter()
            .filter(|item| {
                item.sequence > cursor
                    && request
                        .before_sequence
                        .is_none_or(|before_sequence| item.sequence < before_sequence)
            })
            .cloned()
            .collect::<Vec<_>>();
        filtered.sort_by_key(|item| item.sequence);
        let items = if request.before_sequence.is_some() && filtered.len() > limit {
            filtered.split_off(filtered.len() - limit)
        } else {
            filtered.truncate(limit);
            filtered
        };
        let previous_cursor = items.first().and_then(|first| {
            all_items
                .iter()
                .any(|item| item.sequence < first.sequence)
                .then(|| first.sequence.to_string())
        });
        let next_cursor = items.last().and_then(|last| {
            all_items
                .iter()
                .any(|item| item.sequence > last.sequence)
                .then(|| last.sequence.to_string())
        });
        let has_more_before = previous_cursor.is_some();
        let has_more_after = next_cursor.is_some();
        Ok(ThreadSnapshot {
            thread,
            items,
            active_run,
            latest_checkpoint,
            runs,
            children,
            turn_items,
            child_activities,
            pagination: ThreadPagination {
                cursor: cursor.to_string(),
                limit,
                item_count,
                previous_cursor,
                next_cursor: next_cursor.clone(),
                has_more_before,
                has_more_after,
            },
            next_cursor,
        })
    }

    fn resume_thread(
        &self,
        request: ResumeThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        {
            let _guard = self.lock_mutation()?;
            let mut index = self.read_index()?;
            let Some(record) = index
                .threads
                .iter_mut()
                .find(|thread| thread.thread_id == request.thread_id)
            else {
                return Err(unknown_thread_error(&request.thread_id));
            };
            if record.status == ThreadStatus::Archived {
                record.status = if record.metadata.item_count == 0 {
                    ThreadStatus::Empty
                } else {
                    ThreadStatus::Idle
                };
                record.archived_at = None;
                record.updated_at = now_timestamp();
                let updated = record.clone();
                let journal_head = self.begin_persistence_operation(
                    None,
                    vec![ThreadJournalMutation::UpsertThread {
                        record: Box::new(updated),
                    }],
                )?;
                self.write_index(&index)?;
                self.complete_persistence_operation(&journal_head)?;
            }
        }
        self.read_thread(ReadThreadRequest {
            thread_id: request.thread_id,
            cursor: request.cursor,
            before_sequence: None,
            checkpoint_sequence: request.checkpoint_sequence,
            checkpoint_id: request.checkpoint_id,
            limit: request.limit,
        })
    }

    fn get_thread_status(
        &self,
        thread_id: &str,
    ) -> Result<ThreadStatusResult, WorkerProtocolError> {
        let snapshot = self.read_thread(ReadThreadRequest {
            thread_id: thread_id.to_string(),
            cursor: None,
            before_sequence: None,
            checkpoint_sequence: None,
            checkpoint_id: None,
            limit: Some(1),
        })?;
        let active_run_id = snapshot.active_run.as_ref().map(|run| run.run_id.as_str());
        let session_id = snapshot.thread.session_key.as_deref().unwrap_or_default();
        let turn_items = active_run_id
            .map(|run_id| {
                self.read_items(thread_id)
                    .map(|items| turn_items_from_thread_items(&items, session_id, run_id))
            })
            .transpose()?
            .unwrap_or_default();
        let child_activities = self.child_activities_for_thread(thread_id)?;
        Ok(ThreadStatusResult {
            thread: snapshot.thread,
            active_run: snapshot.active_run,
            latest_checkpoint: snapshot.latest_checkpoint,
            runs: snapshot.runs,
            children: snapshot.children,
            turn_items,
            child_activities,
        })
    }

    fn list_threads(
        &self,
        request: ListThreadsRequest,
    ) -> Result<ListThreadsResult, WorkerProtocolError> {
        let mut threads = self.read_index()?.threads;
        if !request.include_archived {
            threads.retain(|thread| thread.status != ThreadStatus::Archived);
        }
        validate_optional_thread_id(request.parent_thread_id.as_deref())?;
        validate_optional_thread_id(request.ancestor_thread_id.as_deref())?;
        let all_threads = threads.clone();
        threads.retain(|thread| thread_matches_list_filters(thread, &all_threads, &request));
        if !request.include_child_threads
            && request.parent_thread_id.is_none()
            && request.ancestor_thread_id.is_none()
        {
            threads.retain(|thread| thread.parent_thread_id.is_none());
        }
        threads.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
        });
        let total = threads.len();
        let offset = request.offset.unwrap_or(0).min(total);
        let limit = bounded_limit(request.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        let next_offset = (offset + limit < total).then_some(offset + limit);
        Ok(ListThreadsResult {
            threads: threads.into_iter().skip(offset).take(limit).collect(),
            total,
            next_offset,
        })
    }

    fn search_threads(
        &self,
        request: SearchThreadsRequest,
    ) -> Result<SearchThreadsResult, WorkerProtocolError> {
        let query = request.query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(SearchThreadsResult {
                query: request.query,
                threads: Vec::new(),
            });
        }
        let limit = bounded_limit(request.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        let mut matches = Vec::new();
        for thread in self
            .list_threads(ListThreadsRequest {
                include_archived: request.include_archived,
                include_child_threads: request.include_child_threads,
                parent_thread_id: request.parent_thread_id,
                ancestor_thread_id: request.ancestor_thread_id,
                offset: None,
                limit: Some(MAX_LIST_LIMIT),
            })?
            .threads
        {
            if thread_matches_query(&thread, &query)
                || self.items_match_query(&thread.thread_id, &query)?
            {
                matches.push(thread);
            }
            if matches.len() >= limit {
                break;
            }
        }
        Ok(SearchThreadsResult {
            query: request.query,
            threads: matches,
        })
    }

    fn update_thread_metadata(
        &self,
        thread_id: &str,
        patch: ThreadMetadataPatch,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        let record = index
            .threads
            .iter_mut()
            .find(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        apply_metadata_patch(record, patch);
        record.updated_at = now_timestamp();
        let updated = record.clone();
        let journal_head = self.begin_persistence_operation(
            None,
            vec![ThreadJournalMutation::UpsertThread {
                record: Box::new(updated.clone()),
            }],
        )?;
        self.write_index(&index)?;
        self.complete_persistence_operation(&journal_head)?;
        Ok(updated)
    }

    fn update_thread_session_key(
        &self,
        thread_id: &str,
        session_key: String,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let normalized_session_key = non_empty_trimmed(session_key, "sessionKey")?;
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        if index.threads.iter().any(|thread| {
            thread.thread_id != thread_id
                && thread.session_key.as_deref() == Some(normalized_session_key.as_str())
        }) {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "session key is already assigned to another thread",
                serde_json::json!({
                    "threadId": thread_id,
                    "sessionKey": normalized_session_key,
                }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        let record = index
            .threads
            .iter_mut()
            .find(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        record.session_key = Some(normalized_session_key);
        record.updated_at = now_timestamp();
        let updated = record.clone();
        let journal_head = self.begin_persistence_operation(
            None,
            vec![ThreadJournalMutation::UpsertThread {
                record: Box::new(updated.clone()),
            }],
        )?;
        self.write_index(&index)?;
        self.complete_persistence_operation(&journal_head)?;
        Ok(updated)
    }

    fn archive_thread(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.archive_thread_inner(thread_id, archived, false)
    }

    fn archive_thread_with_children(
        &self,
        thread_id: &str,
        archived: bool,
        archive_children: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        LocalThreadStore::archive_thread_with_children(self, thread_id, archived, archive_children)
    }

    fn delete_thread(
        &self,
        request: DeleteThreadRequest,
    ) -> Result<DeleteThreadResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        let Some(target_index) = index
            .threads
            .iter()
            .position(|thread| thread.thread_id == request.thread_id)
        else {
            return Ok(DeleteThreadResult {
                thread_id: request.thread_id,
                deleted: false,
                deleted_children: Vec::new(),
            });
        };
        let child_ids = index
            .threads
            .iter()
            .filter(|thread| thread.parent_thread_id.as_deref() == Some(request.thread_id.as_str()))
            .map(|thread| thread.thread_id.clone())
            .collect::<Vec<_>>();
        if !child_ids.is_empty() && !request.delete_children {
            return Err(invalid_thread_request(
                "thread has child threads; pass deleteChildren to delete the tree",
                serde_json::json!({
                    "threadId": request.thread_id,
                    "childThreadIds": child_ids,
                }),
            ));
        }
        let deleted_children = if request.delete_children {
            descendant_thread_ids(&index, &request.thread_id)
        } else {
            Vec::new()
        };
        let mut delete_ids = deleted_children.clone();
        delete_ids.push(index.threads[target_index].thread_id.clone());
        index
            .threads
            .retain(|thread| !delete_ids.contains(&thread.thread_id));
        let journal_head = self.begin_persistence_operation(
            None,
            delete_ids
                .iter()
                .cloned()
                .map(|thread_id| ThreadJournalMutation::DeleteThread { thread_id })
                .collect(),
        )?;
        self.write_index(&index)?;
        for thread_id in &delete_ids {
            self.delete_items(thread_id)?;
        }
        self.complete_persistence_operation(&journal_head)?;
        Ok(DeleteThreadResult {
            thread_id: request.thread_id,
            deleted: true,
            deleted_children,
        })
    }

    fn fork_thread(&self, request: ForkThreadRequest) -> Result<ThreadRecord, WorkerProtocolError> {
        fork::fork_thread(self, request)
    }

    fn append_items(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.append_items_internal(thread_id, items, None)
    }

    fn append_items_with_client_event_id(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.append_items_internal(thread_id, items, client_event_id)
    }

    fn client_event_items(
        &self,
        thread_id: &str,
        client_event_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError> {
        LocalThreadStore::client_event_items(self, thread_id, client_event_id)
    }
}

impl LocalThreadStore {
    fn append_items_internal(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let client_event_id = client_event_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let _guard = self.lock_mutation()?;
        let mut index = self.read_index()?;
        let record = index
            .threads
            .iter_mut()
            .find(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        let mut existing = self.read_items(thread_id)?;
        let mut next_sequence = existing
            .iter()
            .map(|item| item.sequence)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let timestamp = now_timestamp();
        let mut appended = Vec::new();
        if let Some(client_event_id) = client_event_id {
            if let Some(item_ids) = client_event_item_ids(&record.metadata, client_event_id) {
                let replayed = item_ids
                    .iter()
                    .filter_map(|item_id| {
                        existing
                            .iter()
                            .find(|existing_item| existing_item.item_id == *item_id)
                            .cloned()
                    })
                    .collect::<Vec<_>>();
                if replayed.len() == item_ids.len() {
                    return Ok(AppendThreadItemsResult {
                        thread: record.clone(),
                        items: replayed,
                    });
                }
            }
        }
        for mut item in items {
            item.thread_id = thread_id.to_string();
            if item.item_id.trim().is_empty() {
                item.item_id = generate_item_id();
            }
            if let Some(existing_index) = existing
                .iter()
                .position(|existing_item| existing_item.item_id == item.item_id)
            {
                if item.sequence == 0 {
                    item.sequence = existing[existing_index].sequence;
                }
                if item.created_at.trim().is_empty() {
                    item.created_at = existing[existing_index].created_at.clone();
                }
                existing[existing_index] = item.clone();
            } else {
                if item.created_at.trim().is_empty() {
                    item.created_at = timestamp.clone();
                }
                item.sequence = next_sequence;
                next_sequence = next_sequence.saturating_add(1);
                existing.push(item.clone());
            }
            appended.push(item);
        }
        if let Some(client_event_id) = client_event_id {
            remember_client_event_items(&mut record.metadata.extra, client_event_id, &appended);
        }
        existing.sort_by_key(|item| item.sequence);
        recompute_dynamic_metadata(record, &existing);
        record.updated_at = timestamp;
        let updated = record.clone();
        let operation_id =
            client_event_id.map(|client_event_id| format!("client:{thread_id}:{client_event_id}"));
        let journal_head = self.begin_persistence_operation(
            operation_id.as_deref(),
            vec![
                ThreadJournalMutation::UpsertThread {
                    record: Box::new(updated.clone()),
                },
                ThreadJournalMutation::UpsertItems {
                    thread_id: thread_id.to_string(),
                    items: appended.clone(),
                },
            ],
        )?;
        self.write_items(thread_id, &existing)?;
        self.write_index(&index)?;
        self.complete_persistence_operation(&journal_head)?;
        Ok(AppendThreadItemsResult {
            thread: updated,
            items: appended,
        })
    }
}

impl LocalThreadStore {
    fn items_match_query(&self, thread_id: &str, query: &str) -> Result<bool, WorkerProtocolError> {
        let items = self.read_items(thread_id)?;
        Ok(thread_items_match_query(&items, query))
    }

    fn child_activities_for_thread(
        &self,
        thread_id: &str,
    ) -> Result<Vec<ThreadChildActivity>, WorkerProtocolError> {
        project_child_activities_for_thread(self, thread_id)
    }
}

pub(super) fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn non_empty_trimmed(value: String, field: &str) -> Result<String, WorkerProtocolError> {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }
    Err(invalid_thread_request(
        "field must not be empty",
        serde_json::json!({ "field": field }),
    ))
}

pub(super) fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(super) fn bool_field(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

pub(super) fn u64_field(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn validate_thread_id(thread_id: &str) -> Result<(), WorkerProtocolError> {
    let valid = !thread_id.is_empty()
        && thread_id.len() <= 128
        && thread_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    if valid {
        return Ok(());
    }
    Err(invalid_thread_request(
        "thread id must be 1-128 ascii characters using letters, numbers, '-', '_' or '.'",
        serde_json::json!({ "threadId": thread_id }),
    ))
}

fn validate_optional_thread_id(thread_id: Option<&str>) -> Result<(), WorkerProtocolError> {
    if let Some(thread_id) = thread_id {
        validate_thread_id(thread_id)?;
    }
    Ok(())
}

fn generate_thread_id() -> String {
    format!(
        "thread-{}-{}",
        now_millis(),
        THREAD_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn generate_item_id() -> String {
    format!(
        "item-{}-{}",
        now_millis(),
        ITEM_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn client_event_item_ids(metadata: &ThreadMetadata, client_event_id: &str) -> Option<Vec<String>> {
    metadata
        .extra
        .get(CLIENT_EVENT_IDS_KEY)?
        .get(client_event_id)?
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
}

fn remember_client_event_items(extra: &mut Value, client_event_id: &str, items: &[ThreadItem]) {
    if !extra.is_object() {
        *extra = Value::Object(Default::default());
    }
    let Some(extra_object) = extra.as_object_mut() else {
        return;
    };
    let entry = extra_object
        .entry(CLIENT_EVENT_IDS_KEY.to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !entry.is_object() {
        *entry = Value::Object(Default::default());
    }
    if let Some(client_events) = entry.as_object_mut() {
        client_events.insert(
            client_event_id.to_string(),
            Value::Array(
                items
                    .iter()
                    .map(|item| Value::String(item.item_id.clone()))
                    .collect(),
            ),
        );
    }
}

fn now_timestamp() -> String {
    now_millis().to_string()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn unknown_thread_error(thread_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "unknown thread",
        serde_json::json!({ "threadId": thread_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn invalid_thread_request(
    message: impl Into<String>,
    details: Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_thread_store_creates_appends_and_reads_thread_items() {
        let root = temp_root("create-read");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);

        let thread = store
            .create_thread(CreateThreadRequest {
                title: Some("Research Reactbits".to_string()),
                ..CreateThreadRequest::default()
            })
            .expect("thread should create");

        let result = store
            .append_items(
                &thread.thread_id,
                vec![ThreadItem {
                    item_id: String::new(),
                    thread_id: String::new(),
                    run_id: Some("run-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    parent_item_id: None,
                    sequence: 0,
                    created_at: String::new(),
                    kind: ThreadItemKind::UserMessage(json!({ "text": "Summarize this document" })),
                }],
            )
            .expect("items should append");

        assert_eq!(result.items[0].sequence, 1);
        assert_eq!(result.thread.metadata.item_count, 1);
        assert_eq!(
            result.thread.metadata.preview.as_deref(),
            Some("Summarize this document")
        );

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .expect("thread should read");

        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].run_id.as_deref(), Some("run-1"));
    }

    #[test]
    fn local_thread_store_assigns_sequence_for_new_appended_items() {
        let root = temp_root("assigns-sequence");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();

        let result = store
            .append_items(
                &thread.thread_id,
                vec![ThreadItem {
                    item_id: String::new(),
                    thread_id: String::new(),
                    run_id: Some("run-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    parent_item_id: None,
                    sequence: 99,
                    created_at: String::new(),
                    kind: ThreadItemKind::UserMessage(json!({
                        "text": "Caller supplied a bogus sequence"
                    })),
                }],
            )
            .unwrap();

        assert_eq!(result.items[0].sequence, 1);
    }

    #[test]
    fn local_thread_store_generates_title_from_first_user_message() {
        let root = temp_root("auto-title");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let default_title_thread = store.create_thread(CreateThreadRequest::default()).unwrap();

        let default_result = store
            .append_items(
                &default_title_thread.thread_id,
                vec![ThreadItem {
                    item_id: String::new(),
                    thread_id: String::new(),
                    run_id: Some("run-title".to_string()),
                    turn_id: Some("turn-title".to_string()),
                    parent_item_id: None,
                    sequence: 0,
                    created_at: String::new(),
                    kind: ThreadItemKind::UserMessage(json!({
                        "text": "Summarize the backend migration plan"
                    })),
                }],
            )
            .unwrap();

        assert_eq!(
            default_result.thread.title,
            "Summarize the backend migration plan"
        );

        let manual_title_thread = store
            .create_thread(CreateThreadRequest {
                title: Some("Pinned investigation".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();

        let manual_result = store
            .append_items(
                &manual_title_thread.thread_id,
                vec![ThreadItem {
                    item_id: String::new(),
                    thread_id: String::new(),
                    run_id: Some("run-title-2".to_string()),
                    turn_id: Some("turn-title-2".to_string()),
                    parent_item_id: None,
                    sequence: 0,
                    created_at: String::new(),
                    kind: ThreadItemKind::UserMessage(json!({
                        "text": "This should not replace a manual title"
                    })),
                }],
            )
            .unwrap();

        assert_eq!(manual_result.thread.title, "Pinned investigation");
    }

    #[test]
    fn local_thread_store_does_not_replace_manually_set_default_title() {
        let root = temp_root("manual-default-title");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();

        let updated = store
            .update_thread_metadata(
                &thread.thread_id,
                ThreadMetadataPatch {
                    title: Some("New session".to_string()),
                    ..ThreadMetadataPatch::default()
                },
            )
            .unwrap();
        assert_eq!(updated.title, "New session");

        let result = store
            .append_items(
                &thread.thread_id,
                vec![ThreadItem {
                    item_id: String::new(),
                    thread_id: String::new(),
                    run_id: Some("run-manual-title".to_string()),
                    turn_id: Some("turn-manual-title".to_string()),
                    parent_item_id: None,
                    sequence: 0,
                    created_at: String::new(),
                    kind: ThreadItemKind::UserMessage(json!({
                        "text": "This should not override the manual default title"
                    })),
                }],
            )
            .unwrap();

        assert_eq!(result.thread.title, "New session");
    }

    #[test]
    fn local_thread_store_status_stays_running_when_one_of_multiple_runs_completes() {
        let root = temp_root("multi-run-status");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();

        let result = store
            .append_items(
                &thread.thread_id,
                vec![
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunStarted(json!({ "runId": "run-1" })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-2".to_string()),
                        turn_id: Some("run-2".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunStarted(json!({ "runId": "run-2" })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunCompleted(json!({ "runId": "run-1" })),
                    },
                ],
            )
            .unwrap();

        assert_eq!(result.thread.status, ThreadStatus::Running);
        assert_eq!(result.thread.metadata.has_active_run, true);
        assert_eq!(result.thread.root_run_id.as_deref(), Some("run-1"));
        assert_eq!(result.thread.active_run_id.as_deref(), Some("run-2"));
    }

    #[test]
    fn local_thread_store_status_ignores_late_approval_for_terminal_run() {
        let root = temp_root("late-terminal-approval-status");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();

        let result = store
            .append_items(
                &thread.thread_id,
                vec![
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunStarted(json!({ "runId": "run-1" })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunCompleted(json!({ "runId": "run-1" })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::ApprovalRequested(json!({
                            "runId": "run-1",
                            "approvalId": "approval-late"
                        })),
                    },
                ],
            )
            .unwrap();

        assert_eq!(result.thread.status, ThreadStatus::Idle);
        assert_eq!(result.thread.metadata.has_active_run, false);

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id.clone(),
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(snapshot.active_run, None);
        assert_eq!(snapshot.runs.len(), 1);
        assert_eq!(snapshot.runs[0].active, false);
        assert_eq!(snapshot.runs[0].status, ThreadStatus::Idle);
    }

    #[test]
    fn local_thread_store_ignores_late_terminal_transition_for_completed_run() {
        let root = temp_root("late-terminal-transition-status");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();

        let result = store
            .append_items(
                &thread.thread_id,
                vec![
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunStarted(json!({ "runId": "run-1" })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunCompleted(json!({ "runId": "run-1" })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: Some("run-1".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::Error(json!({
                            "runId": "run-1",
                            "message": "late error"
                        })),
                    },
                ],
            )
            .unwrap();

        assert_eq!(result.thread.status, ThreadStatus::Idle);

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id.clone(),
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(snapshot.active_run, None);
        assert_eq!(snapshot.runs[0].status, ThreadStatus::Idle);
        assert_eq!(snapshot.runs[0].active, false);
    }

    #[test]
    fn local_thread_store_filters_archived_threads_from_default_list() {
        let root = temp_root("archive-filter");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let first = store
            .create_thread(CreateThreadRequest {
                title: Some("Active".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let second = store
            .create_thread(CreateThreadRequest {
                title: Some("Archived".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();

        store.archive_thread(&second.thread_id, true).unwrap();

        let listed = store.list_threads(ListThreadsRequest::default()).unwrap();
        assert_eq!(listed.threads.len(), 1);
        assert_eq!(listed.threads[0].thread_id, first.thread_id);

        let listed_with_archived = store
            .list_threads(ListThreadsRequest {
                include_archived: true,
                include_child_threads: false,
                parent_thread_id: None,
                ancestor_thread_id: None,
                offset: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(listed_with_archived.threads.len(), 2);
    }

    #[test]
    fn local_thread_store_delete_children_deletes_full_descendant_tree() {
        let root = temp_root("delete-descendant-tree");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let parent = store
            .create_thread(CreateThreadRequest {
                thread_id: Some("delete-parent".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let child = store
            .create_thread(CreateThreadRequest {
                thread_id: Some("delete-child".to_string()),
                parent_thread_id: Some(parent.thread_id.clone()),
                source: Some("subagent".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let grandchild = store
            .create_thread(CreateThreadRequest {
                thread_id: Some("delete-grandchild".to_string()),
                parent_thread_id: Some(child.thread_id.clone()),
                source: Some("subagent".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();

        let deleted = store
            .delete_thread(DeleteThreadRequest {
                thread_id: parent.thread_id.clone(),
                delete_children: true,
            })
            .unwrap();

        assert_eq!(deleted.deleted, true);
        assert_eq!(
            deleted.deleted_children,
            vec![child.thread_id.clone(), grandchild.thread_id.clone()]
        );
        assert!(store
            .read_thread(ReadThreadRequest {
                thread_id: grandchild.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .is_err());
    }

    #[test]
    fn local_thread_store_hides_child_threads_by_default_in_list_and_search() {
        let root = temp_root("child-thread-filter");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let parent = store
            .create_thread(CreateThreadRequest {
                title: Some("Parent planning thread".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let child = store
            .create_thread(CreateThreadRequest {
                title: Some("Hidden child research needle".to_string()),
                parent_thread_id: Some(parent.thread_id.clone()),
                source: Some("subagent".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();

        let listed = store.list_threads(ListThreadsRequest::default()).unwrap();
        assert_eq!(listed.threads.len(), 1);
        assert_eq!(listed.threads[0].thread_id, parent.thread_id);

        let listed_with_children = store
            .list_threads(ListThreadsRequest {
                include_archived: false,
                include_child_threads: true,
                parent_thread_id: None,
                ancestor_thread_id: None,
                offset: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(listed_with_children.threads.len(), 2);
        assert!(listed_with_children
            .threads
            .iter()
            .any(|thread| thread.thread_id == child.thread_id));

        let hidden_search = store
            .search_threads(SearchThreadsRequest {
                query: "needle".to_string(),
                include_archived: false,
                include_child_threads: false,
                parent_thread_id: None,
                ancestor_thread_id: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(hidden_search.threads, Vec::new());

        let expanded_search = store
            .search_threads(SearchThreadsRequest {
                query: "needle".to_string(),
                include_archived: false,
                include_child_threads: true,
                parent_thread_id: None,
                ancestor_thread_id: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(expanded_search.threads.len(), 1);
        assert_eq!(expanded_search.threads[0].thread_id, child.thread_id);
    }

    #[test]
    fn local_thread_store_filters_child_threads_by_parent_and_ancestor() {
        let root = temp_root("child-thread-parent-filter");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let parent = store
            .create_thread(CreateThreadRequest {
                title: Some("Parent workspace".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let child = store
            .create_thread(CreateThreadRequest {
                title: Some("Direct child alpha".to_string()),
                parent_thread_id: Some(parent.thread_id.clone()),
                source: Some("subagent".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let grandchild = store
            .create_thread(CreateThreadRequest {
                title: Some("Nested descendant beta".to_string()),
                parent_thread_id: Some(child.thread_id.clone()),
                source: Some("subagent".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();

        let direct_children = store
            .list_threads(ListThreadsRequest {
                parent_thread_id: Some(parent.thread_id.clone()),
                ..ListThreadsRequest::default()
            })
            .unwrap();
        assert_eq!(direct_children.threads.len(), 1);
        assert_eq!(direct_children.threads[0].thread_id, child.thread_id);

        let descendants = store
            .list_threads(ListThreadsRequest {
                ancestor_thread_id: Some(parent.thread_id.clone()),
                ..ListThreadsRequest::default()
            })
            .unwrap();
        let mut descendant_ids = descendants
            .threads
            .iter()
            .map(|thread| thread.thread_id.as_str())
            .collect::<Vec<_>>();
        descendant_ids.sort_unstable();
        let mut expected_descendant_ids =
            vec![child.thread_id.as_str(), grandchild.thread_id.as_str()];
        expected_descendant_ids.sort_unstable();
        assert_eq!(descendant_ids, expected_descendant_ids);

        let scoped_search = store
            .search_threads(SearchThreadsRequest {
                query: "beta".to_string(),
                ancestor_thread_id: Some(parent.thread_id),
                ..SearchThreadsRequest::default()
            })
            .unwrap();
        assert_eq!(scoped_search.threads.len(), 1);
        assert_eq!(scoped_search.threads[0].thread_id, grandchild.thread_id);
    }

    #[test]
    fn local_thread_store_searches_metadata_and_items() {
        let root = temp_root("search");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store
            .create_thread(CreateThreadRequest {
                title: Some("Planning".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![ThreadItem {
                    item_id: String::new(),
                    thread_id: String::new(),
                    run_id: None,
                    turn_id: None,
                    parent_item_id: None,
                    sequence: 0,
                    created_at: String::new(),
                    kind: ThreadItemKind::AssistantMessageCompleted(
                        json!({ "text": "Thread platform notes" }),
                    ),
                }],
            )
            .unwrap();

        let result = store
            .search_threads(SearchThreadsRequest {
                query: "platform".to_string(),
                include_archived: false,
                include_child_threads: false,
                parent_thread_id: None,
                ancestor_thread_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(result.threads.len(), 1);
        assert_eq!(result.threads[0].thread_id, thread.thread_id);
    }

    #[test]
    fn local_thread_store_read_thread_reports_latest_checkpoint() {
        let root = temp_root("latest-checkpoint");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![
                    item("before checkpoint"),
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-1",
                            "runId": "run-1",
                            "label": "First checkpoint",
                            "restorePayload": { "phase": "first" }
                        })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-2".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-2",
                            "runId": "run-2",
                            "label": "Second checkpoint",
                            "restorePayload": { "phase": "second" }
                        })),
                    },
                ],
            )
            .unwrap();

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id.clone(),
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();
        let checkpoint = snapshot.latest_checkpoint.as_ref().unwrap();

        assert_eq!(checkpoint.checkpoint_id, "checkpoint-2");
        assert_eq!(checkpoint.thread_id, thread.thread_id);
        assert_eq!(checkpoint.run_id.as_deref(), Some("run-2"));
        assert_eq!(checkpoint.sequence, 3);
        assert_eq!(checkpoint.label.as_deref(), Some("Second checkpoint"));
        assert_eq!(checkpoint.restore_payload["phase"], "second");
    }

    #[test]
    fn local_thread_store_read_thread_can_start_at_checkpoint_sequence() {
        let root = temp_root("read-from-checkpoint-sequence");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![
                    item("before checkpoint"),
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-1",
                            "runId": "run-1",
                            "restorePayload": { "phase": "checkpoint" }
                        })),
                    },
                    item("after checkpoint"),
                ],
            )
            .unwrap();

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: Some(2),
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(
            snapshot
                .items
                .iter()
                .map(|item| item.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(snapshot.pagination.cursor, "1");
    }

    #[test]
    fn local_thread_store_read_thread_can_start_at_checkpoint_id() {
        let root = temp_root("read-from-checkpoint-id");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![
                    item("before checkpoint"),
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-1",
                            "runId": "run-1",
                            "restorePayload": { "phase": "checkpoint" }
                        })),
                    },
                    item("after checkpoint"),
                ],
            )
            .unwrap();

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: Some("checkpoint-1".to_string()),
                limit: None,
            })
            .unwrap();

        assert_eq!(
            snapshot
                .items
                .iter()
                .map(|item| item.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(
            snapshot.latest_checkpoint.unwrap().checkpoint_id,
            "checkpoint-1"
        );
    }

    #[test]
    fn local_thread_store_read_thread_ignores_checkpoint_after_run_terminal_item() {
        let root = temp_root("latest-checkpoint-terminal");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-1",
                            "runId": "run-1",
                            "restorePayload": { "phase": "awaiting_tool" }
                        })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunCompleted(json!({
                            "runId": "run-1",
                            "completedAt": "unix-ms:2"
                        })),
                    },
                ],
            )
            .unwrap();

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(snapshot.latest_checkpoint, None);
    }

    #[test]
    fn local_thread_store_read_thread_reports_later_checkpoint_after_prior_run_terminal_item() {
        let root = temp_root("latest-checkpoint-after-terminal");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-1",
                            "runId": "run-1",
                            "restorePayload": { "phase": "old" }
                        })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunCompleted(json!({
                            "runId": "run-1",
                            "completedAt": "unix-ms:2"
                        })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-2".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-2",
                            "runId": "run-2",
                            "restorePayload": { "phase": "new" }
                        })),
                    },
                ],
            )
            .unwrap();

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();
        let checkpoint = snapshot.latest_checkpoint.as_ref().unwrap();

        assert_eq!(checkpoint.checkpoint_id, "checkpoint-2");
        assert_eq!(checkpoint.restore_payload["phase"], "new");
    }

    #[test]
    fn local_thread_store_persists_context_window_items_and_token_usage_metadata() {
        let root = temp_root("context-window-items-token-usage");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        let token_usage_info = json!({
            "totalTokenUsage": {
                "inputTokens": 0,
                "cachedInputTokens": 0,
                "outputTokens": 0,
                "reasoningOutputTokens": 0,
                "totalTokens": 172
            },
            "lastTokenUsage": {
                "inputTokens": 10,
                "cachedInputTokens": 0,
                "outputTokens": 162,
                "reasoningOutputTokens": 41,
                "totalTokens": 172
            },
            "modelContextWindow": 128000
        });

        store
            .append_items(
                &thread.thread_id,
                vec![
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-context".to_string()),
                        turn_id: Some("run-context".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::ContextTrimmed(json!({
                            "runId": "run-context",
                            "strategy": "discard",
                            "droppedMessageCount": 2
                        })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-context".to_string()),
                        turn_id: Some("run-context".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::ContextCompaction(json!({
                            "runId": "run-context",
                            "strategy": "compact",
                            "droppedMessageCount": 2
                        })),
                    },
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-context".to_string()),
                        turn_id: Some("run-context".to_string()),
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::AgentRunCompleted(json!({
                            "runId": "run-context",
                            "tokenUsageInfo": token_usage_info
                        })),
                    },
                ],
            )
            .unwrap();

        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert!(matches!(
            snapshot.items[0].kind,
            ThreadItemKind::ContextTrimmed(_)
        ));
        assert!(matches!(
            snapshot.items[1].kind,
            ThreadItemKind::ContextCompaction(_)
        ));
        assert_eq!(
            snapshot.thread.metadata.extra["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            172
        );
        assert_eq!(
            snapshot.thread.metadata.extra["tokenUsageInfo"]["modelContextWindow"],
            128000
        );
    }

    #[test]
    fn local_thread_store_forks_thread_history_up_to_sequence() {
        let root = temp_root("fork");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![item("first"), item("second"), item("third")],
            )
            .unwrap();

        let fork = store
            .fork_thread(ForkThreadRequest {
                thread_id: thread.thread_id.clone(),
                client_event_id: None,
                title: Some("Forked".to_string()),
                fork_after_sequence: Some(2),
                include_children: false,
                include_checkpoints: false,
            })
            .unwrap();
        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: fork.thread_id.clone(),
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(
            fork.parent_thread_id.as_deref(),
            Some(thread.thread_id.as_str())
        );
        assert_eq!(snapshot.items.len(), 2);
        assert!(snapshot
            .items
            .iter()
            .all(|item| item.thread_id == fork.thread_id));
    }

    #[test]
    fn local_thread_store_fork_excludes_checkpoints_by_default() {
        let root = temp_root("fork-checkpoint-default");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![
                    item("before checkpoint"),
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-1",
                            "runId": "run-1"
                        })),
                    },
                ],
            )
            .unwrap();

        let fork = store
            .fork_thread(ForkThreadRequest {
                thread_id: thread.thread_id.clone(),
                client_event_id: None,
                title: None,
                fork_after_sequence: None,
                include_children: false,
                include_checkpoints: false,
            })
            .unwrap();
        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: fork.thread_id.clone(),
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot
            .items
            .iter()
            .all(|item| !matches!(item.kind, ThreadItemKind::CheckpointCreated(_))));
    }

    #[test]
    fn local_thread_store_fork_can_include_checkpoints() {
        let root = temp_root("fork-checkpoint-include");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store.create_thread(CreateThreadRequest::default()).unwrap();
        store
            .append_items(
                &thread.thread_id,
                vec![
                    item("before checkpoint"),
                    ThreadItem {
                        item_id: String::new(),
                        thread_id: String::new(),
                        run_id: Some("run-1".to_string()),
                        turn_id: None,
                        parent_item_id: None,
                        sequence: 0,
                        created_at: String::new(),
                        kind: ThreadItemKind::CheckpointCreated(json!({
                            "checkpointId": "checkpoint-1",
                            "runId": "run-1"
                        })),
                    },
                ],
            )
            .unwrap();

        let fork = store
            .fork_thread(ForkThreadRequest {
                thread_id: thread.thread_id.clone(),
                client_event_id: None,
                title: None,
                fork_after_sequence: None,
                include_children: false,
                include_checkpoints: true,
            })
            .unwrap();
        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: fork.thread_id.clone(),
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(snapshot.items.len(), 2);
        assert!(snapshot
            .items
            .iter()
            .any(|item| matches!(item.kind, ThreadItemKind::CheckpointCreated(_))));
    }

    fn item(text: &str) -> ThreadItem {
        ThreadItem {
            item_id: String::new(),
            thread_id: String::new(),
            run_id: None,
            turn_id: None,
            parent_item_id: None,
            sequence: 0,
            created_at: String::new(),
            kind: ThreadItemKind::UserMessage(json!({ "text": text })),
        }
    }

    #[test]
    fn persistence_consistency_detects_projection_divergence_and_repairs_explicitly() {
        let root = temp_root("persistence-divergence");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let thread = store
            .create_thread(CreateThreadRequest {
                thread_id: Some("thread-persistence-divergence".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        store
            .append_items(&thread.thread_id, vec![item("canonical")])
            .unwrap();

        assert_eq!(
            store.check_persistence_consistency().unwrap().status,
            ThreadPersistenceConsistencyStatus::Clean
        );

        store.write_items(&thread.thread_id, &[]).unwrap();
        let divergence = store.check_persistence_consistency().unwrap();
        assert_eq!(
            divergence.status,
            ThreadPersistenceConsistencyStatus::Diverged
        );
        assert_eq!(divergence.projection_item_count, 0);
        assert_eq!(divergence.canonical_item_count, 1);

        let repaired = store
            .repair_persistence(ThreadPersistenceRepairMode::RebuildProjection)
            .unwrap();
        assert_eq!(
            repaired.after.status,
            ThreadPersistenceConsistencyStatus::Clean
        );
        assert_eq!(
            store
                .read_thread(ReadThreadRequest {
                    thread_id: thread.thread_id,
                    cursor: None,
                    before_sequence: None,
                    checkpoint_sequence: None,
                    checkpoint_id: None,
                    limit: None,
                })
                .unwrap()
                .items
                .len(),
            1
        );
    }

    #[test]
    fn legacy_sqlite_projection_requires_explicit_journal_migration() {
        let root = temp_root("persistence-legacy-migration");
        let _cleanup = Cleanup(root.clone());
        let store = LocalThreadStore::new(root);
        let timestamp = now_timestamp();
        let record = ThreadRecord {
            thread_id: "thread-legacy-projection".to_string(),
            title: "Legacy".to_string(),
            status: ThreadStatus::Idle,
            session_key: Some("session-legacy".to_string()),
            root_run_id: None,
            active_run_id: None,
            parent_thread_id: None,
            source: "legacy".to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
            archived_at: None,
            metadata: ThreadMetadata::default(),
        };
        store
            .write_index(&index::ThreadIndex {
                version: THREAD_STORE_VERSION,
                threads: vec![record],
            })
            .unwrap();
        store.write_items("thread-legacy-projection", &[]).unwrap();

        assert_eq!(
            store.check_persistence_consistency().unwrap().status,
            ThreadPersistenceConsistencyStatus::LegacyProjection
        );
        let migrated = store
            .repair_persistence(ThreadPersistenceRepairMode::MigrateLegacyProjection)
            .unwrap();
        assert_eq!(
            migrated.before.status,
            ThreadPersistenceConsistencyStatus::LegacyProjection
        );
        assert_eq!(
            migrated.after.status,
            ThreadPersistenceConsistencyStatus::Clean
        );
        assert_eq!(migrated.migrated_thread_count, 1);
    }

    #[test]
    fn local_and_memory_adapters_share_the_thread_store_contract() {
        let root = temp_root("store-contract");
        let _cleanup = Cleanup(root.clone());
        assert_thread_store_contract(&LocalThreadStore::new(root));
        assert_thread_store_contract(&MemoryThreadStore::default());
    }

    #[test]
    fn thread_runtime_uses_memory_store_and_replays_client_event_ids() {
        let store = MemoryThreadStore::default();
        let thread = store
            .create_thread(CreateThreadRequest {
                thread_id: Some("thread-memory-runtime".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let runtime = crate::worker_thread::ThreadRuntime::new(store);
        let request = crate::worker_thread::StartThreadTurnRequest {
            thread_id: thread.thread_id,
            client_event_id: Some("memory-runtime-start-1".to_string()),
            run_id: Some("run-memory-1".to_string()),
            turn_id: Some("turn-memory-1".to_string()),
            input: json!({ "text": "hello" }),
            model: Some("test-model".to_string()),
            provider: Some("fixture".to_string()),
            metadata: ThreadMetadataPatch::default(),
            trace_context: None,
        };

        let first = runtime.start_turn(request.clone()).unwrap();
        let replayed = runtime.start_turn(request).unwrap();

        assert_eq!(first.appended_items, replayed.appended_items);
        assert_eq!(replayed.snapshot.items.len(), 2);
    }

    fn assert_thread_store_contract<S: ThreadStore>(store: &S) {
        let thread = store
            .create_thread(CreateThreadRequest {
                thread_id: Some(format!("thread-contract-{}", now_millis())),
                title: Some("Contract".to_string()),
                ..CreateThreadRequest::default()
            })
            .unwrap();
        let appended = store
            .append_items(&thread.thread_id, vec![item("shared contract")])
            .unwrap();
        let snapshot = store
            .read_thread(ReadThreadRequest {
                thread_id: thread.thread_id,
                cursor: None,
                before_sequence: None,
                checkpoint_sequence: None,
                checkpoint_id: None,
                limit: None,
            })
            .unwrap();

        assert_eq!(appended.items.len(), 1);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.thread.metadata.item_count, 1);
    }

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tinybot-thread-{name}-{}", now_millis()))
    }

    struct Cleanup(PathBuf);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
