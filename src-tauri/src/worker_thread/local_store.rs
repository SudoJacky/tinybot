use super::types::{
    AppendThreadItemsResult, CreateThreadRequest, DeleteThreadRequest, DeleteThreadResult,
    ForkThreadRequest, ListThreadsRequest, ListThreadsResult, ReadThreadRequest,
    RestoreThreadCheckpointRequest, RestoreThreadCheckpointResult, ResumeThreadRequest,
    SearchThreadsRequest, SearchThreadsResult, ThreadActivityRequest, ThreadActivityResult,
    ThreadActivitySummary, ThreadAgentRegistryEntry, ThreadAgentRegistryRequest,
    ThreadAgentRegistryResult, ThreadCheckpoint, ThreadChildActivity, ThreadChildSummary,
    ThreadEvent, ThreadEventsRequest, ThreadEventsResult, ThreadItem, ThreadItemKind,
    ThreadMetadata, ThreadMetadataPatch, ThreadPagination, ThreadPendingApproval, ThreadRecord,
    ThreadRunSummary, ThreadRunningTool, ThreadSnapshot, ThreadStatus, ThreadStatusResult,
};
use crate::agent_loop_runtime_protocol::{
    project_turn_items_from_trace_events, AgentRuntimeEventEnvelope, AgentTurnItem,
    LegacyNativeAgentEventEnvelopeInput,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_session::{
    AgentRunRecord, AgentRunRuntimeState, AgentRunStatus, AgentRunTracePage,
};
use crate::worker_subagent_manager::{
    SubagentMailboxInput, SubagentThreadStatus, SubagentThreadSummary,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, path::PathBuf};

const THREAD_STORE_VERSION: usize = 1;
const DEFAULT_READ_LIMIT: usize = 200;
const DEFAULT_LIST_LIMIT: usize = 100;
const DEFAULT_SEARCH_LIMIT: usize = 25;
const MAX_READ_LIMIT: usize = 1_000;
const MAX_LIST_LIMIT: usize = 500;
const MAX_SEARCH_LIMIT: usize = 100;
const CLIENT_EVENT_IDS_KEY: &str = "clientEventIds";
const CLIENT_FORK_THREAD_IDS_KEY: &str = "clientForkThreadIds";
const DEFAULT_THREAD_TITLE: &str = "New session";
const TITLE_SOURCE_KEY: &str = "titleSource";
const TITLE_SOURCE_MANUAL: &str = "manual";

static THREAD_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static ITEM_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub trait ThreadStore {
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
}

#[derive(Clone, Debug)]
pub struct LocalThreadStore {
    root: PathBuf,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct ThreadIndex {
    version: usize,
    threads: Vec<ThreadRecord>,
}

impl LocalThreadStore {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            root: workspace_root.join(".tinybot").join("threads"),
        }
    }

    fn sqlite_path(&self) -> PathBuf {
        self.root.join("threads.sqlite")
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
        let turn_items = project_turn_items_from_trace_events(&runtime_events);
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
        self.write_index(&index)?;
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

    fn read_index(&self) -> Result<ThreadIndex, WorkerProtocolError> {
        let connection = self.open_connection()?;
        let mut statement = connection
            .prepare("SELECT record_json FROM threads ORDER BY rowid ASC")
            .map_err(thread_sqlite_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(thread_sqlite_error)?;
        let mut threads = Vec::new();
        for row in rows {
            let record_json = row.map_err(thread_sqlite_error)?;
            threads.push(serde_json::from_str(&record_json).map_err(thread_json_error)?);
        }
        Ok(ThreadIndex {
            version: THREAD_STORE_VERSION,
            threads,
        })
    }

    fn write_index(&self, index: &ThreadIndex) -> Result<(), WorkerProtocolError> {
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction().map_err(thread_sqlite_error)?;
        transaction
            .execute("DELETE FROM threads", [])
            .map_err(thread_sqlite_error)?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO threads (
                        thread_id,
                        title,
                        status,
                        session_key,
                        parent_thread_id,
                        source,
                        created_at,
                        updated_at,
                        archived_at,
                        record_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(thread_sqlite_error)?;
            for thread in &index.threads {
                let record_json = serde_json::to_string(thread).map_err(thread_json_error)?;
                statement
                    .execute(params![
                        thread.thread_id.as_str(),
                        thread.title.as_str(),
                        format!("{:?}", thread.status),
                        thread.session_key.as_deref(),
                        thread.parent_thread_id.as_deref(),
                        thread.source.as_str(),
                        thread.created_at.as_str(),
                        thread.updated_at.as_str(),
                        thread.archived_at.as_deref(),
                        record_json
                    ])
                    .map_err(thread_sqlite_error)?;
            }
        }
        transaction.commit().map_err(thread_sqlite_error)
    }

    fn read_items(&self, thread_id: &str) -> Result<Vec<ThreadItem>, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let connection = self.open_connection()?;
        let mut statement = connection
            .prepare(
                "SELECT item_json
                 FROM thread_items
                 WHERE thread_id = ?1
                 ORDER BY sequence ASC",
            )
            .map_err(thread_sqlite_error)?;
        let rows = statement
            .query_map(params![thread_id], |row| row.get::<_, String>(0))
            .map_err(thread_sqlite_error)?;
        let mut items = Vec::new();
        for row in rows {
            let item_json = row.map_err(thread_sqlite_error)?;
            items.push(serde_json::from_str(&item_json).map_err(thread_json_error)?);
        }
        Ok(items)
    }

    fn write_items(
        &self,
        thread_id: &str,
        items: &[ThreadItem],
    ) -> Result<(), WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction().map_err(thread_sqlite_error)?;
        transaction
            .execute(
                "DELETE FROM thread_items WHERE thread_id = ?1",
                params![thread_id],
            )
            .map_err(thread_sqlite_error)?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO thread_items (
                        thread_id,
                        sequence,
                        item_id,
                        run_id,
                        turn_id,
                        parent_item_id,
                        created_at,
                        kind,
                        item_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .map_err(thread_sqlite_error)?;
            for item in items {
                let item_json = serde_json::to_string(item).map_err(thread_json_error)?;
                statement
                    .execute(params![
                        item.thread_id.as_str(),
                        item.sequence,
                        item.item_id.as_str(),
                        item.run_id.as_deref(),
                        item.turn_id.as_deref(),
                        item.parent_item_id.as_deref(),
                        item.created_at.as_str(),
                        thread_item_kind_name(&item.kind),
                        item_json
                    ])
                    .map_err(thread_sqlite_error)?;
            }
        }
        transaction.commit().map_err(thread_sqlite_error)
    }

    fn delete_items(&self, thread_id: &str) -> Result<(), WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let connection = self.open_connection()?;
        connection
            .execute(
                "DELETE FROM thread_items WHERE thread_id = ?1",
                params![thread_id],
            )
            .map_err(thread_sqlite_error)?;
        Ok(())
    }

    fn open_connection(&self) -> Result<Connection, WorkerProtocolError> {
        fs::create_dir_all(&self.root).map_err(|error| thread_io_error("create", error))?;
        let connection = Connection::open(self.sqlite_path()).map_err(thread_sqlite_error)?;
        ensure_thread_schema(&connection)?;
        Ok(connection)
    }

    pub fn record_agent_run(
        &self,
        record: &AgentRunRecord,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        let thread = self.ensure_thread_for_agent_run(record)?;
        let item = match record.status {
            AgentRunStatus::Running | AgentRunStatus::Waiting => agent_run_started_item(record),
            AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled => {
                agent_run_terminal_item(record)
            }
        };
        self.append_items(&thread.thread_id, vec![item])
    }

    pub fn record_agent_run_trace(
        &self,
        record: &AgentRunRecord,
        event: Value,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        let thread = self.ensure_thread_for_agent_run(record)?;
        self.append_items(
            &thread.thread_id,
            vec![agent_trace_event_item(record, event)],
        )
    }

    pub fn record_agent_run_checkpoint(
        &self,
        record: &AgentRunRecord,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        let thread = self.ensure_thread_for_agent_run(record)?;
        self.append_items(&thread.thread_id, vec![agent_run_checkpoint_item(record)])
    }

    pub fn record_agent_run_terminal(
        &self,
        record: &AgentRunRecord,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        let thread = self.ensure_thread_for_agent_run(record)?;
        self.append_items(&thread.thread_id, vec![agent_run_terminal_item(record)])
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

    fn ensure_thread_for_agent_run(
        &self,
        record: &AgentRunRecord,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let mut index = self.read_index()?;
        if let Some(position) = index
            .threads
            .iter()
            .position(|thread| thread.active_run_id.as_deref() == Some(record.run_id.as_str()))
            .or_else(|| {
                index.threads.iter().position(|thread| {
                    thread.root_run_id.as_deref() == Some(record.run_id.as_str())
                        && thread.session_key.as_deref() == Some(record.session_id.as_str())
                })
            })
            .or_else(|| {
                index.threads.iter().position(|thread| {
                    thread.session_key.as_deref() == Some(record.session_id.as_str())
                        && thread.parent_thread_id.is_none()
                })
            })
        {
            let thread = &mut index.threads[position];
            thread.active_run_id = active_run_id_for_status(record);
            if thread.root_run_id.is_none() {
                thread.root_run_id = Some(record.run_id.clone());
            }
            if thread.metadata.model.is_none() && !record.model.trim().is_empty() {
                thread.metadata.model = Some(record.model.clone());
            }
            thread.updated_at = record.updated_at.clone();
            let updated = thread.clone();
            self.write_index(&index)?;
            return Ok(updated);
        }

        let mut metadata = ThreadMetadata {
            model: (!record.model.trim().is_empty()).then(|| record.model.clone()),
            last_activity_at: Some(record.updated_at.clone()),
            has_active_run: active_run_id_for_status(record).is_some(),
            extra: serde_json::json!({
                "provider": record.provider,
                "legacyAgentRun": true
            }),
            ..ThreadMetadata::default()
        };
        if let Some(provider) = &record.provider {
            metadata.extra["provider"] = Value::String(provider.clone());
        }
        let thread = ThreadRecord {
            thread_id: generate_thread_id(),
            title: format!("Desktop Session {}", record.session_id),
            status: ThreadStatus::Empty,
            session_key: Some(record.session_id.clone()),
            root_run_id: Some(record.run_id.clone()),
            active_run_id: active_run_id_for_status(record),
            parent_thread_id: None,
            source: "legacy_agent_run".to_string(),
            created_at: record.started_at.clone(),
            updated_at: record.updated_at.clone(),
            archived_at: None,
            metadata,
        };
        index.threads.push(thread.clone());
        self.write_index(&index)?;
        self.write_items(&thread.thread_id, &[])?;
        Ok(thread)
    }

    fn ensure_parent_thread_for_subagent(
        &self,
        summary: &SubagentThreadSummary,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
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
        self.write_index(&index)?;
        self.write_items(&thread.thread_id, &[])?;
        Ok(thread)
    }

    fn ensure_child_thread_for_subagent(
        &self,
        summary: &SubagentThreadSummary,
        parent_thread_id: &str,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
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
            self.write_index(&index)?;
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
        self.write_index(&index)?;
        self.write_items(&thread.thread_id, &[])?;
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

fn run_summaries_from_items(thread: &ThreadRecord, items: &[ThreadItem]) -> Vec<ThreadRunSummary> {
    let mut runs = Vec::<ThreadRunSummary>::new();
    for item in items {
        let Some(run_id) = item.run_id.as_ref() else {
            continue;
        };
        let position = runs
            .iter()
            .position(|run| run.run_id == *run_id)
            .unwrap_or_else(|| {
                runs.push(ThreadRunSummary {
                    run_id: run_id.clone(),
                    status: ThreadStatus::Idle,
                    started_at: None,
                    updated_at: None,
                    completed_at: None,
                    model: None,
                    provider: None,
                    item_count: 0,
                    active: false,
                });
                runs.len() - 1
            });
        let run = &mut runs[position];
        run.item_count = run.item_count.saturating_add(1);
        run.updated_at = Some(item.created_at.clone());
        update_run_summary_from_item(run, item);
    }
    if runs.is_empty() {
        if let Some(run_id) = thread.root_run_id.clone() {
            runs.push(ThreadRunSummary {
                run_id,
                status: thread.status.clone(),
                started_at: Some(thread.created_at.clone()),
                updated_at: Some(thread.updated_at.clone()),
                completed_at: thread.archived_at.clone(),
                model: thread.metadata.model.clone(),
                provider: thread
                    .metadata
                    .extra
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                item_count: 0,
                active: thread.active_run_id.is_some(),
            });
        }
    }
    runs
}

fn update_run_summary_from_item(run: &mut ThreadRunSummary, item: &ThreadItem) {
    match &item.kind {
        ThreadItemKind::AgentRunStarted(payload) => {
            run.status = ThreadStatus::Running;
            run.active = true;
            run.completed_at = None;
            run.started_at =
                string_field(payload, "startedAt").or_else(|| Some(item.created_at.clone()));
            run.model = string_field(payload, "model").or_else(|| run.model.clone());
            run.provider = string_field(payload, "provider").or_else(|| run.provider.clone());
        }
        ThreadItemKind::AgentRunCompleted(payload) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::Idle;
                run.active = false;
                run.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::Error(payload) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::Failed;
                run.active = false;
                run.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::Cancelled(payload) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::Idle;
                run.active = false;
                run.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::ApprovalRequested(_) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::WaitingForApproval;
                run.active = true;
            }
        }
        ThreadItemKind::ApprovalResolved(_) => {
            if run.active && run.completed_at.is_none() {
                run.status = ThreadStatus::Running;
            }
        }
        _ => {}
    }
}

fn agent_run_record_from_thread_run(
    session_id: &str,
    thread: &ThreadRecord,
    run: &ThreadRunSummary,
    items: &[ThreadItem],
) -> AgentRunRecord {
    let trace_events = items
        .iter()
        .filter(|item| item.run_id.as_deref() == Some(run.run_id.as_str()))
        .filter_map(trace_event_from_thread_item)
        .collect::<Vec<_>>();
    AgentRunRecord {
        session_id: session_id.to_string(),
        run_id: run.run_id.clone(),
        thread_id: Some(thread.thread_id.clone()),
        turn_id: turn_id_for_run(run, items),
        parent_thread_id: thread.parent_thread_id.clone(),
        child_thread_ids: child_thread_ids_for_run(thread, run, items),
        status: agent_run_status_from_thread_run(run),
        phase: agent_run_phase_from_thread_run(run).to_string(),
        started_at: run
            .started_at
            .clone()
            .unwrap_or_else(|| thread.created_at.clone()),
        updated_at: run
            .updated_at
            .clone()
            .unwrap_or_else(|| thread.updated_at.clone()),
        completed_at: run.completed_at.clone(),
        stop_reason: run
            .completed_at
            .as_ref()
            .map(|_| "thread_projected".to_string()),
        model: run
            .model
            .clone()
            .or_else(|| thread.metadata.model.clone())
            .unwrap_or_default(),
        provider: run.provider.clone(),
        max_iterations: 0,
        current_iteration: 0,
        conversation_message_ids: Vec::new(),
        trace_messages: Vec::new(),
        trace_events,
        completed_tool_results: Vec::new(),
        pending_tool_calls: Vec::new(),
        checkpoint: None,
        artifacts: Vec::new(),
        usage: Vec::new(),
        token_usage_info: thread_token_usage_info(thread),
        error: (run.status == ThreadStatus::Failed).then(|| {
            serde_json::json!({
                "message": "thread run failed"
            })
        }),
    }
}

fn thread_token_usage_info(thread: &ThreadRecord) -> Option<crate::worker_session::TokenUsageInfo> {
    thread
        .metadata
        .extra
        .get("tokenUsageInfo")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn child_thread_ids_for_run(
    thread: &ThreadRecord,
    run: &ThreadRunSummary,
    items: &[ThreadItem],
) -> Vec<String> {
    let mut child_thread_ids = items
        .iter()
        .filter(|item| item.run_id.as_deref() == Some(run.run_id.as_str()))
        .filter_map(|item| child_thread_id_from_item(&item.kind))
        .collect::<Vec<_>>();
    child_thread_ids.sort();
    child_thread_ids.dedup();
    if thread.parent_thread_id.is_some() || !child_thread_ids.is_empty() {
        return child_thread_ids;
    }
    Vec::new()
}

fn turn_id_for_run(run: &ThreadRunSummary, items: &[ThreadItem]) -> Option<String> {
    items
        .iter()
        .find(|item| item.run_id.as_deref() == Some(run.run_id.as_str()))
        .and_then(|item| item.turn_id.clone())
        .or_else(|| Some(run.run_id.clone()))
}

fn child_thread_id_from_item(kind: &ThreadItemKind) -> Option<String> {
    match kind {
        ThreadItemKind::SubagentSpawned(value)
        | ThreadItemKind::SubagentMessage(value)
        | ThreadItemKind::SubagentCompleted(value) => value
            .get("childThreadId")
            .or_else(|| value.get("child_thread_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn agent_run_status_from_thread_run(run: &ThreadRunSummary) -> AgentRunStatus {
    match &run.status {
        ThreadStatus::Failed => AgentRunStatus::Failed,
        ThreadStatus::Cancelling => AgentRunStatus::Cancelled,
        ThreadStatus::WaitingForApproval | ThreadStatus::WaitingForInput => AgentRunStatus::Waiting,
        ThreadStatus::Running => AgentRunStatus::Running,
        ThreadStatus::Empty | ThreadStatus::Idle | ThreadStatus::Archived => {
            if run.active {
                AgentRunStatus::Running
            } else {
                AgentRunStatus::Completed
            }
        }
    }
}

fn agent_run_phase_from_thread_run(run: &ThreadRunSummary) -> &'static str {
    match agent_run_status_from_thread_run(run) {
        AgentRunStatus::Running => "active_turn",
        AgentRunStatus::Waiting => "waiting",
        AgentRunStatus::Completed => "completed",
        AgentRunStatus::Failed => "failed",
        AgentRunStatus::Cancelled => "cancelled",
    }
}

impl ThreadStore for LocalThreadStore {
    fn create_thread(
        &self,
        request: CreateThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let thread_id = request.thread_id.unwrap_or_else(generate_thread_id);
        validate_thread_id(&thread_id)?;
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
        self.write_index(&index)?;
        self.write_items(&thread_id, &[])?;
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
            self.write_index(&index)?;
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
        let mut index = self.read_index()?;
        let record = index
            .threads
            .iter_mut()
            .find(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        apply_metadata_patch(record, patch);
        record.updated_at = now_timestamp();
        let updated = record.clone();
        self.write_index(&index)?;
        Ok(updated)
    }

    fn update_thread_session_key(
        &self,
        thread_id: &str,
        session_key: String,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let normalized_session_key = non_empty_trimmed(session_key, "sessionKey")?;
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
        self.write_index(&index)?;
        Ok(updated)
    }

    fn archive_thread(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.archive_thread_inner(thread_id, archived, false)
    }

    fn delete_thread(
        &self,
        request: DeleteThreadRequest,
    ) -> Result<DeleteThreadResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
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
        self.write_index(&index)?;
        for thread_id in &delete_ids {
            self.delete_items(thread_id)?;
        }
        Ok(DeleteThreadResult {
            thread_id: request.thread_id,
            deleted: true,
            deleted_children,
        })
    }

    fn fork_thread(&self, request: ForkThreadRequest) -> Result<ThreadRecord, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let source = self.read_thread(ReadThreadRequest {
            thread_id: request.thread_id.clone(),
            cursor: None,
            before_sequence: None,
            checkpoint_sequence: None,
            checkpoint_id: None,
            limit: Some(MAX_READ_LIMIT),
        })?;
        let client_event_id = request
            .client_event_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut index = self.read_index()?;
        if let Some(client_event_id) = client_event_id.as_deref() {
            if let Some(fork_thread_id) =
                client_fork_thread_id(&source.thread.metadata, client_event_id)
            {
                if let Some(existing) = index
                    .threads
                    .iter()
                    .find(|thread| thread.thread_id == fork_thread_id)
                    .cloned()
                {
                    return Ok(existing);
                }
            }
        }
        let fork_id = generate_thread_id();
        let timestamp = now_timestamp();
        let title = request
            .title
            .unwrap_or_else(|| format!("{} (fork)", source.thread.title));
        let mut record = source.thread.clone();
        record.thread_id = fork_id.clone();
        record.title = title;
        record.status = ThreadStatus::Idle;
        record.parent_thread_id = Some(source.thread.thread_id.clone());
        record.source = "fork".to_string();
        record.created_at = timestamp.clone();
        record.updated_at = timestamp.clone();
        record.archived_at = None;
        record.active_run_id = None;
        record.metadata.has_active_run = false;
        record.metadata.last_activity_at = Some(timestamp.clone());

        let fork_after_sequence = request.fork_after_sequence.unwrap_or(u64::MAX);
        let mut items = self
            .read_items(&source.thread.thread_id)?
            .into_iter()
            .filter(|item| item.sequence <= fork_after_sequence)
            .filter(|item| request.include_checkpoints || !is_checkpoint_item(item))
            .collect::<Vec<_>>();
        for item in &mut items {
            item.thread_id = fork_id.clone();
        }
        record.metadata.item_count = items.len() as u64;

        let mut forked_children = Vec::new();
        let mut forked_child_items = Vec::new();
        if request.include_children {
            let child_ids = descendant_thread_ids(&index, &source.thread.thread_id);
            let mut id_map = HashMap::from([(source.thread.thread_id.clone(), fork_id.clone())]);
            for child_id in &child_ids {
                id_map.insert(child_id.clone(), generate_thread_id());
            }
            for child_id in child_ids {
                let child = index
                    .threads
                    .iter()
                    .find(|thread| thread.thread_id == child_id)
                    .cloned()
                    .ok_or_else(|| unknown_thread_error(&child_id))?;
                let copied_child_id = id_map
                    .get(&child.thread_id)
                    .expect("copied child id should be mapped")
                    .clone();
                let mut copied_child = child.clone();
                copied_child.thread_id = copied_child_id.clone();
                copied_child.parent_thread_id = child
                    .parent_thread_id
                    .as_ref()
                    .and_then(|parent_id| id_map.get(parent_id).cloned());
                copied_child.created_at = timestamp.clone();
                copied_child.updated_at = timestamp.clone();
                copied_child.archived_at = None;
                copied_child.active_run_id = None;
                copied_child.status = if child.metadata.item_count == 0 {
                    ThreadStatus::Empty
                } else {
                    ThreadStatus::Idle
                };
                copied_child.metadata.has_active_run = false;
                copied_child.metadata.last_activity_at = Some(timestamp.clone());
                let mut copied_items = self
                    .read_items(&child.thread_id)?
                    .into_iter()
                    .filter(|item| request.include_checkpoints || !is_checkpoint_item(item))
                    .collect::<Vec<_>>();
                for item in &mut copied_items {
                    item.thread_id = copied_child_id.clone();
                }
                copied_child.metadata.item_count = copied_items.len() as u64;
                forked_child_items.push((copied_child_id, copied_items));
                forked_children.push(copied_child);
            }
        }
        if let Some(client_event_id) = client_event_id.as_deref() {
            if let Some(source_record) = index
                .threads
                .iter_mut()
                .find(|thread| thread.thread_id == source.thread.thread_id)
            {
                remember_client_fork_thread_id(
                    &mut source_record.metadata.extra,
                    client_event_id,
                    &fork_id,
                );
            }
        }
        index.threads.push(record.clone());
        index.threads.extend(forked_children);
        self.write_index(&index)?;
        self.write_items(&fork_id, &items)?;
        for (thread_id, items) in forked_child_items {
            self.write_items(&thread_id, &items)?;
        }
        Ok(record)
    }

    fn append_items(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.append_items_internal(thread_id, items, None)
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
        self.write_items(thread_id, &existing)?;
        self.write_index(&index)?;
        Ok(AppendThreadItemsResult {
            thread: updated,
            items: appended,
        })
    }
}

impl LocalThreadStore {
    fn items_match_query(&self, thread_id: &str, query: &str) -> Result<bool, WorkerProtocolError> {
        Ok(self.read_items(thread_id)?.iter().any(|item| {
            serde_json::to_string(item)
                .unwrap_or_default()
                .to_lowercase()
                .contains(query)
        }))
    }

    fn child_activities_for_thread(
        &self,
        thread_id: &str,
    ) -> Result<Vec<ThreadChildActivity>, WorkerProtocolError> {
        let index = self.read_index()?;
        let mut activities = Vec::new();
        for child in index.threads.iter().filter(|thread| {
            thread.parent_thread_id.as_deref() == Some(thread_id)
                && thread.status != ThreadStatus::Archived
                && thread.active_run_id.is_some()
        }) {
            let items = self.read_items(&child.thread_id)?;
            let runs = run_summaries_from_items(child, &items);
            let active_run = runs.iter().find(|run| run.active).cloned().or_else(|| {
                child.active_run_id.as_ref().map(|run_id| ThreadRunSummary {
                    run_id: run_id.clone(),
                    status: child.status.clone(),
                    started_at: Some(child.created_at.clone()),
                    updated_at: Some(child.updated_at.clone()),
                    completed_at: child.archived_at.clone(),
                    model: child.metadata.model.clone(),
                    provider: child
                        .metadata
                        .extra
                        .get("provider")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    item_count: items.len() as u64,
                    active: true,
                })
            });
            let turn_items = active_run
                .as_ref()
                .map(|run| {
                    let child_session_id = child.session_key.as_deref().unwrap_or_default();
                    turn_items_from_thread_items(&items, child_session_id, &run.run_id)
                })
                .unwrap_or_default();
            activities.push(ThreadChildActivity {
                child: ThreadChildSummary::from(child),
                active_run,
                turn_items,
            });
        }
        activities.sort_by(|left, right| {
            right
                .child
                .updated_at
                .cmp(&left.child.updated_at)
                .then_with(|| left.child.thread_id.cmp(&right.child.thread_id))
        });
        Ok(activities)
    }
}

fn agent_registry_entry(
    thread: &ThreadRecord,
    index: &ThreadIndex,
    items: &[ThreadItem],
) -> ThreadAgentRegistryEntry {
    let runs = run_summaries_from_items(thread, items);
    let active_run = runs.iter().find(|run| run.active).cloned();
    let session_id = thread.session_key.as_deref().unwrap_or_default();
    let turn_items = active_run
        .as_ref()
        .map(|run| turn_items_from_thread_items(items, session_id, &run.run_id))
        .unwrap_or_default();
    let latest_checkpoint = latest_checkpoint_from_items(&thread.thread_id, items);
    let agent_control = thread.metadata.extra.get("agentControl").cloned();
    let lifecycle = agent_control
        .as_ref()
        .and_then(|control| control.get("lifecycle"));
    let child_count = index
        .threads
        .iter()
        .filter(|candidate| candidate.parent_thread_id.as_deref() == Some(&thread.thread_id))
        .count() as u64;
    let default_agent_id = if thread.parent_thread_id.is_none() {
        format!("main:{}", thread.thread_id)
    } else {
        format!("agent:{}", thread.thread_id)
    };
    let role = agent_control
        .as_ref()
        .and_then(|control| string_field(control, "role"))
        .unwrap_or_else(|| {
            if thread.parent_thread_id.is_none() {
                "main".to_string()
            } else {
                "subagent".to_string()
            }
        });
    let nickname = agent_control
        .as_ref()
        .and_then(|control| string_field(control, "nickname"))
        .unwrap_or_else(|| thread.title.clone());
    let active = lifecycle
        .and_then(|value| bool_field(value, "active"))
        .unwrap_or_else(|| active_run.is_some());
    let terminal = lifecycle
        .and_then(|value| bool_field(value, "terminal"))
        .unwrap_or_else(|| matches!(thread.status, ThreadStatus::Failed));
    ThreadAgentRegistryEntry {
        agent_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "agentId"))
            .unwrap_or(default_agent_id),
        thread_id: thread.thread_id.clone(),
        parent_thread_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "parentThreadId"))
            .or_else(|| thread.parent_thread_id.clone()),
        parent_run_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "parentRunId")),
        run_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "childRunId"))
            .or_else(|| active_run.as_ref().map(|run| run.run_id.clone()))
            .or_else(|| thread.active_run_id.clone()),
        title: thread.title.clone(),
        role,
        nickname,
        status: thread.status.clone(),
        active,
        terminal,
        source: thread.source.clone(),
        depth: agent_control
            .as_ref()
            .and_then(|control| u64_field(control, "depth"))
            .unwrap_or_else(|| {
                if thread.parent_thread_id.is_none() {
                    0
                } else {
                    1
                }
            }),
        agent_path: agent_control
            .as_ref()
            .and_then(|control| control.get("agentPath"))
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| {
                if thread.parent_thread_id.is_none() {
                    serde_json::json!(["main"])
                } else {
                    serde_json::json!(["main", thread.thread_id])
                }
            }),
        child_count,
        updated_at: thread.updated_at.clone(),
        mailbox_depth: lifecycle.and_then(|value| u64_field(value, "mailboxDepth")),
        pending_approval: lifecycle
            .and_then(|value| value.get("pendingApproval"))
            .filter(|value| !value.is_null())
            .cloned(),
        capacity: agent_control
            .as_ref()
            .and_then(|control| control.get("capacity"))
            .filter(|value| !value.is_null())
            .cloned(),
        agent_control,
        active_run,
        latest_checkpoint,
        turn_items,
    }
}

fn pending_approvals_from_items(
    thread_id: &str,
    items: &[ThreadItem],
) -> Vec<ThreadPendingApproval> {
    items
        .iter()
        .filter_map(|item| {
            let ThreadItemKind::ApprovalRequested(payload) = &item.kind else {
                return None;
            };
            let approval_id = string_field(payload, "approvalId")
                .or_else(|| string_field(payload, "approval_id"))?;
            let resolved = items.iter().any(|candidate| {
                candidate.sequence > item.sequence
                    && candidate.run_id == item.run_id
                    && matches!(
                        &candidate.kind,
                        ThreadItemKind::ApprovalResolved(candidate_payload)
                            if string_field(candidate_payload, "approvalId")
                                .or_else(|| string_field(candidate_payload, "approval_id"))
                                .as_deref()
                                == Some(approval_id.as_str())
                    )
            });
            if resolved {
                return None;
            }
            Some(ThreadPendingApproval {
                thread_id: thread_id.to_string(),
                item_id: item.item_id.clone(),
                run_id: item.run_id.clone(),
                turn_id: item.turn_id.clone(),
                approval_id,
                summary: string_field(payload, "summary"),
                scope: string_field(payload, "scope"),
                created_at: item.created_at.clone(),
                payload: payload.clone(),
            })
        })
        .collect()
}

fn running_tools_from_items(thread_id: &str, items: &[ThreadItem]) -> Vec<ThreadRunningTool> {
    items
        .iter()
        .filter_map(|item| {
            let ThreadItemKind::ToolCallStarted(payload) = &item.kind else {
                return None;
            };
            let tool_call_id = string_field(payload, "toolCallId")
                .or_else(|| string_field(payload, "tool_call_id"))?;
            let completed = items.iter().any(|candidate| {
                candidate.sequence > item.sequence
                    && candidate.run_id == item.run_id
                    && matches!(
                        &candidate.kind,
                        ThreadItemKind::ToolCallOutput(candidate_payload)
                            if string_field(candidate_payload, "toolCallId")
                                .or_else(|| string_field(candidate_payload, "tool_call_id"))
                                .as_deref()
                                == Some(tool_call_id.as_str())
                    )
            });
            if completed {
                return None;
            }
            Some(ThreadRunningTool {
                thread_id: thread_id.to_string(),
                item_id: item.item_id.clone(),
                run_id: item.run_id.clone(),
                turn_id: item.turn_id.clone(),
                tool_call_id,
                tool_name: string_field(payload, "toolName")
                    .or_else(|| string_field(payload, "tool_name")),
                args: payload.get("args").cloned().unwrap_or(Value::Null),
                started_at: item.created_at.clone(),
                payload: payload.clone(),
            })
        })
        .collect()
}

fn apply_metadata_patch(record: &mut ThreadRecord, patch: ThreadMetadataPatch) {
    let has_explicit_title = patch.title.is_some();
    if let Some(title) = patch.title {
        record.title = title;
    }
    if let Some(summary) = patch.summary {
        record.metadata.summary = Some(summary);
    }
    if let Some(preview) = patch.preview {
        record.metadata.preview = Some(preview);
    }
    if let Some(tags) = patch.tags {
        record.metadata.tags = tags;
    }
    if let Some(model) = patch.model {
        record.metadata.model = Some(model);
    }
    if let Some(working_directory) = patch.working_directory {
        record.metadata.working_directory = Some(working_directory);
    }
    if let Some(last_user_message_at) = patch.last_user_message_at {
        record.metadata.last_user_message_at = Some(last_user_message_at);
    }
    if let Some(last_assistant_message_at) = patch.last_assistant_message_at {
        record.metadata.last_assistant_message_at = Some(last_assistant_message_at);
    }
    if let Some(last_activity_at) = patch.last_activity_at {
        record.metadata.last_activity_at = Some(last_activity_at);
    }
    if let Some(has_active_run) = patch.has_active_run {
        record.metadata.has_active_run = has_active_run;
    }
    if let Some(extra) = patch.extra {
        record.metadata.extra = extra;
    }
    if has_explicit_title {
        set_metadata_extra_string(
            &mut record.metadata.extra,
            TITLE_SOURCE_KEY,
            TITLE_SOURCE_MANUAL,
        );
    }
}

fn metadata_extra_string<'a>(metadata: &'a ThreadMetadata, key: &str) -> Option<&'a str> {
    metadata.extra.get(key).and_then(Value::as_str)
}

fn set_metadata_extra_string(extra: &mut Value, key: &str, value: &str) {
    if !extra.is_object() {
        *extra = Value::Object(Default::default());
    }
    if let Some(map) = extra.as_object_mut() {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn set_metadata_extra_value(extra: &mut Value, key: &str, value: Value) {
    if !extra.is_object() {
        *extra = Value::Object(Default::default());
    }
    if let Some(map) = extra.as_object_mut() {
        map.insert(key.to_string(), value);
    }
}

fn recompute_dynamic_metadata(record: &mut ThreadRecord, items: &[ThreadItem]) {
    const DEFAULT_RUN_KEY: &str = "__thread_default_run__";

    #[derive(Default)]
    struct RunLifecycle {
        active: bool,
        waiting_for_approval: bool,
        terminal: bool,
        last_sequence: u64,
    }

    record.metadata.item_count = items.len() as u64;
    record.metadata.run_count = 0;
    record.metadata.has_active_run = false;
    record.metadata.last_user_message_at = None;
    record.metadata.last_assistant_message_at = None;
    record.metadata.last_activity_at = items.last().map(|item| item.created_at.clone());
    let mut preview = record.metadata.preview.clone();
    let mut status_when_no_active = if items.is_empty() {
        ThreadStatus::Empty
    } else {
        ThreadStatus::Idle
    };
    let mut run_lifecycles: HashMap<String, RunLifecycle> = HashMap::new();
    for item in items {
        let run_key = item
            .run_id
            .clone()
            .unwrap_or_else(|| DEFAULT_RUN_KEY.to_string());
        match &item.kind {
            ThreadItemKind::UserMessage(payload) => {
                record.metadata.last_user_message_at = Some(item.created_at.clone());
                let user_preview = preview_from_payload(payload);
                if preview.is_none() {
                    preview = user_preview.clone();
                }
                if record.title == DEFAULT_THREAD_TITLE
                    && metadata_extra_string(&record.metadata, TITLE_SOURCE_KEY)
                        != Some(TITLE_SOURCE_MANUAL)
                {
                    if let Some(title) = user_preview {
                        record.title = title;
                    }
                }
            }
            ThreadItemKind::AssistantMessageCompleted(payload) => {
                record.metadata.last_assistant_message_at = Some(item.created_at.clone());
                preview = preview_from_payload(payload).or(preview);
            }
            ThreadItemKind::AgentRunStarted(_) => {
                record.metadata.run_count = record.metadata.run_count.saturating_add(1);
                if record.root_run_id.is_none() {
                    record.root_run_id = item.run_id.clone();
                }
                let lifecycle = run_lifecycles.entry(run_key).or_default();
                lifecycle.active = true;
                lifecycle.waiting_for_approval = false;
                lifecycle.terminal = false;
                lifecycle.last_sequence = item.sequence;
            }
            ThreadItemKind::AgentRunCompleted(_) => {
                if let ThreadItemKind::AgentRunCompleted(payload) = &item.kind {
                    if let Some(token_usage_info) = payload.get("tokenUsageInfo") {
                        set_metadata_extra_value(
                            &mut record.metadata.extra,
                            "tokenUsageInfo",
                            token_usage_info.clone(),
                        );
                    }
                }
                let lifecycle = run_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Idle;
                }
            }
            ThreadItemKind::SubagentCompleted(_) => {
                let lifecycle = run_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Idle;
                }
            }
            ThreadItemKind::ApprovalRequested(_) => {
                let lifecycle = run_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = true;
                    lifecycle.waiting_for_approval = true;
                    lifecycle.last_sequence = item.sequence;
                }
            }
            ThreadItemKind::ApprovalResolved(_) => {
                if let Some(lifecycle) = run_lifecycles.get_mut(&run_key) {
                    if lifecycle.active && !lifecycle.terminal {
                        lifecycle.waiting_for_approval = false;
                        lifecycle.last_sequence = item.sequence;
                    }
                }
            }
            ThreadItemKind::Error(_) => {
                let lifecycle = run_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Failed;
                }
            }
            ThreadItemKind::Cancelled(_) => {
                let lifecycle = run_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Idle;
                }
            }
            _ => {}
        }
    }
    record.metadata.has_active_run = run_lifecycles.values().any(|lifecycle| lifecycle.active);
    record.active_run_id = run_lifecycles
        .iter()
        .filter(|(run_id, lifecycle)| lifecycle.active && run_id.as_str() != DEFAULT_RUN_KEY)
        .max_by_key(|(_, lifecycle)| lifecycle.last_sequence)
        .map(|(run_id, _)| run_id.clone());
    let status = if run_lifecycles
        .values()
        .any(|lifecycle| lifecycle.active && lifecycle.waiting_for_approval)
    {
        ThreadStatus::WaitingForApproval
    } else if record.metadata.has_active_run {
        ThreadStatus::Running
    } else {
        status_when_no_active
    };
    record.metadata.preview = preview;
    if record.status != ThreadStatus::Archived {
        record.status = status;
    }
}

fn agent_run_started_item(record: &AgentRunRecord) -> ThreadItem {
    ThreadItem {
        item_id: format!("agent-run:{}:{}:started", record.session_id, record.run_id),
        thread_id: String::new(),
        run_id: Some(record.run_id.clone()),
        turn_id: Some(record.run_id.clone()),
        parent_item_id: None,
        sequence: 0,
        created_at: record.started_at.clone(),
        kind: ThreadItemKind::AgentRunStarted(agent_run_payload(record)),
    }
}

fn agent_run_checkpoint_item(record: &AgentRunRecord) -> ThreadItem {
    ThreadItem {
        item_id: format!(
            "agent-run:{}:{}:checkpoint",
            record.session_id, record.run_id
        ),
        thread_id: String::new(),
        run_id: Some(record.run_id.clone()),
        turn_id: Some(record.run_id.clone()),
        parent_item_id: None,
        sequence: 0,
        created_at: record.updated_at.clone(),
        kind: ThreadItemKind::CheckpointCreated(agent_run_checkpoint_payload(record)),
    }
}

fn agent_run_terminal_item(record: &AgentRunRecord) -> ThreadItem {
    let kind = match record.status {
        AgentRunStatus::Completed => ThreadItemKind::AgentRunCompleted(agent_run_payload(record)),
        AgentRunStatus::Failed => ThreadItemKind::Error(agent_run_payload(record)),
        AgentRunStatus::Cancelled => ThreadItemKind::Cancelled(agent_run_payload(record)),
        AgentRunStatus::Running | AgentRunStatus::Waiting => {
            ThreadItemKind::AgentRunStep(agent_run_payload(record))
        }
    };
    ThreadItem {
        item_id: format!("agent-run:{}:{}:terminal", record.session_id, record.run_id),
        thread_id: String::new(),
        run_id: Some(record.run_id.clone()),
        turn_id: Some(record.run_id.clone()),
        parent_item_id: None,
        sequence: 0,
        created_at: record
            .completed_at
            .clone()
            .unwrap_or_else(|| record.updated_at.clone()),
        kind,
    }
}

fn agent_trace_event_item(record: &AgentRunRecord, event: Value) -> ThreadItem {
    let event_name = event
        .get("eventName")
        .or_else(|| event.get("event_name"))
        .and_then(Value::as_str)
        .unwrap_or("agent.event")
        .to_string();
    let event_id = event
        .get("eventId")
        .or_else(|| event.get("event_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| generate_item_id());
    let turn_id = event
        .get("turnId")
        .or_else(|| event.get("turn_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| Some(record.run_id.clone()));
    let parent_item_id = event
        .get("itemId")
        .or_else(|| event.get("item_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let created_at = event
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| record.updated_at.clone());
    ThreadItem {
        item_id: format!(
            "agent-run:{}:{}:trace:{event_id}",
            record.session_id, record.run_id
        ),
        thread_id: String::new(),
        run_id: Some(record.run_id.clone()),
        turn_id,
        parent_item_id,
        sequence: 0,
        created_at,
        kind: thread_item_kind_for_agent_event(&event_name, event),
    }
}

fn thread_item_kind_for_agent_event(event_name: &str, event: Value) -> ThreadItemKind {
    match event_name {
        "agent.delta" => ThreadItemKind::AssistantMessageDelta(event),
        "agent.message.completed" | "agent.done" => {
            ThreadItemKind::AssistantMessageCompleted(event)
        }
        "agent.reasoning_delta" => ThreadItemKind::Reasoning(event),
        "agent.tool_call.delta" | "agent.tool.start" => ThreadItemKind::ToolCallStarted(event),
        "agent.tool.result" => ThreadItemKind::ToolCallOutput(event),
        "agent.awaiting_approval" => ThreadItemKind::ApprovalRequested(event),
        "agent.approval.decision" => ThreadItemKind::ApprovalResolved(event),
        "agent.checkpoint" => ThreadItemKind::CheckpointCreated(event),
        "agent.context.trimmed" => ThreadItemKind::ContextTrimmed(event),
        "agent.context.compacted" => ThreadItemKind::ContextCompaction(event),
        "agent.error" => ThreadItemKind::Error(event),
        "agent.cancelled" => ThreadItemKind::Cancelled(event),
        name if name.starts_with("agent.delegate.spawn") => ThreadItemKind::SubagentSpawned(event),
        name if name.starts_with("agent.delegate.completed") => {
            ThreadItemKind::SubagentCompleted(event)
        }
        name if name.starts_with("agent.delegate.") => ThreadItemKind::SubagentMessage(event),
        _ => ThreadItemKind::AgentRunStep(event),
    }
}

fn agent_run_payload(record: &AgentRunRecord) -> Value {
    serde_json::to_value(record).unwrap_or_else(|_| {
        serde_json::json!({
            "sessionId": record.session_id,
            "runId": record.run_id,
            "status": record.status,
            "phase": record.phase,
        })
    })
}

fn agent_run_checkpoint_payload(record: &AgentRunRecord) -> Value {
    let mut payload = agent_run_payload(record);
    if let Some(checkpoint) = record.checkpoint.as_ref() {
        if let Some(object) = payload.as_object_mut() {
            object.insert("restorePayload".to_string(), checkpoint.clone());
            if let Some(checkpoint_id) = checkpoint
                .get("checkpointId")
                .or_else(|| checkpoint.get("checkpoint_id"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                object.insert(
                    "checkpointId".to_string(),
                    Value::String(checkpoint_id.to_string()),
                );
            }
            if let Some(label) = checkpoint
                .get("label")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                object.insert("label".to_string(), Value::String(label.to_string()));
            }
        }
    }
    payload
}

fn active_run_id_for_status(record: &AgentRunRecord) -> Option<String> {
    match record.status {
        AgentRunStatus::Running | AgentRunStatus::Waiting => Some(record.run_id.clone()),
        AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled => None,
    }
}

fn subagent_initial_child_items(
    summary: &SubagentThreadSummary,
    event: Option<Value>,
) -> Vec<ThreadItem> {
    let mut items = Vec::new();
    if !summary.task.trim().is_empty() {
        items.push(ThreadItem {
            item_id: format!(
                "subagent:{}:{}:task",
                summary.session_key, summary.subagent_id
            ),
            thread_id: String::new(),
            run_id: Some(summary.child_run_id.clone()),
            turn_id: summary.parent_run_id.clone(),
            parent_item_id: None,
            sequence: 0,
            created_at: summary.created_at.clone(),
            kind: ThreadItemKind::UserMessage(serde_json::json!({
                "text": summary.task,
                "source": "subagent_task",
                "subagent": subagent_summary_payload(summary, None),
            })),
        });
    }
    items.push(ThreadItem {
        item_id: format!(
            "subagent:{}:{}:started",
            summary.session_key, summary.subagent_id
        ),
        thread_id: String::new(),
        run_id: Some(summary.child_run_id.clone()),
        turn_id: summary.parent_run_id.clone(),
        parent_item_id: None,
        sequence: 0,
        created_at: summary.created_at.clone(),
        kind: ThreadItemKind::AgentRunStarted(subagent_summary_payload(summary, event)),
    });
    items
}

fn subagent_input_item(
    summary: &SubagentThreadSummary,
    input: &SubagentMailboxInput,
    event: Option<Value>,
) -> ThreadItem {
    ThreadItem {
        item_id: input.input_id.clone(),
        thread_id: String::new(),
        run_id: Some(summary.child_run_id.clone()),
        turn_id: input
            .turn_id
            .clone()
            .or_else(|| summary.parent_run_id.clone()),
        parent_item_id: None,
        sequence: 0,
        created_at: input.created_at.clone(),
        kind: ThreadItemKind::UserMessage(serde_json::json!({
            "text": input.content,
            "sender": input.sender,
            "metadata": input.metadata,
            "event": event,
            "subagent": subagent_summary_payload(summary, None),
        })),
    }
}

fn subagent_child_status_item(summary: &SubagentThreadSummary, event: Option<Value>) -> ThreadItem {
    let payload = subagent_summary_payload(summary, event);
    let kind = match summary.status {
        SubagentThreadStatus::Completed | SubagentThreadStatus::Closed => {
            ThreadItemKind::AgentRunCompleted(payload)
        }
        SubagentThreadStatus::Failed | SubagentThreadStatus::Interrupted => {
            ThreadItemKind::Error(payload)
        }
        SubagentThreadStatus::Cancelled => ThreadItemKind::Cancelled(payload),
        SubagentThreadStatus::AwaitingApproval => ThreadItemKind::ApprovalRequested(payload),
        SubagentThreadStatus::Running
        | SubagentThreadStatus::WaitingMainAgent
        | SubagentThreadStatus::WaitingUser => ThreadItemKind::SubagentMessage(payload),
    };
    ThreadItem {
        item_id: format!(
            "subagent:{}:{}:status:{}",
            summary.session_key,
            summary.subagent_id,
            status_string(&summary.status)
        ),
        thread_id: String::new(),
        run_id: Some(summary.child_run_id.clone()),
        turn_id: summary.parent_run_id.clone(),
        parent_item_id: None,
        sequence: 0,
        created_at: summary.updated_at.clone(),
        kind,
    }
}

fn subagent_parent_item(
    summary: &SubagentThreadSummary,
    event: Option<Value>,
    label: &str,
    kind: impl FnOnce(Value) -> ThreadItemKind,
) -> ThreadItem {
    ThreadItem {
        item_id: format!(
            "subagent:{}:{}:{label}",
            summary.session_key, summary.subagent_id
        ),
        thread_id: String::new(),
        run_id: summary.parent_run_id.clone(),
        turn_id: summary.parent_run_id.clone(),
        parent_item_id: None,
        sequence: 0,
        created_at: summary.updated_at.clone(),
        kind: kind(subagent_summary_payload(summary, event)),
    }
}

fn subagent_summary_payload(summary: &SubagentThreadSummary, event: Option<Value>) -> Value {
    serde_json::json!({
        "sessionKey": summary.session_key,
        "parentRunId": summary.parent_run_id,
        "subagentId": summary.subagent_id,
        "childRunId": summary.child_run_id,
        "traceRef": summary.trace_ref,
        "name": summary.name,
        "task": summary.task,
        "status": summary.status,
        "mailboxDepth": summary.mailbox_depth,
        "terminalResult": summary.terminal_result,
        "blockerSummary": summary.blocker_summary,
        "pendingApproval": summary.pending_approval,
        "metadata": summary.metadata,
        "event": event,
    })
}

fn active_child_run_id_for_status(summary: &SubagentThreadSummary) -> Option<String> {
    match summary.status {
        SubagentThreadStatus::Running
        | SubagentThreadStatus::WaitingMainAgent
        | SubagentThreadStatus::WaitingUser
        | SubagentThreadStatus::AwaitingApproval => Some(summary.child_run_id.clone()),
        SubagentThreadStatus::Completed
        | SubagentThreadStatus::Failed
        | SubagentThreadStatus::Cancelled
        | SubagentThreadStatus::Closed
        | SubagentThreadStatus::Interrupted => None,
    }
}

fn thread_status_for_subagent(status: &SubagentThreadStatus) -> ThreadStatus {
    match status {
        SubagentThreadStatus::Running => ThreadStatus::Running,
        SubagentThreadStatus::WaitingMainAgent | SubagentThreadStatus::WaitingUser => {
            ThreadStatus::WaitingForInput
        }
        SubagentThreadStatus::AwaitingApproval => ThreadStatus::WaitingForApproval,
        SubagentThreadStatus::Failed | SubagentThreadStatus::Interrupted => ThreadStatus::Failed,
        SubagentThreadStatus::Cancelled
        | SubagentThreadStatus::Completed
        | SubagentThreadStatus::Closed => ThreadStatus::Idle,
    }
}

fn status_value(status: &SubagentThreadStatus) -> Value {
    serde_json::to_value(status)
        .unwrap_or_else(|_| Value::String(status_string(status).to_string()))
}

fn subagent_agent_control_payload(
    summary: &SubagentThreadSummary,
    parent_thread_id: &str,
) -> Value {
    let role = string_field(&summary.metadata, "role").unwrap_or_else(|| "subagent".to_string());
    let nickname =
        string_field(&summary.metadata, "nickname").unwrap_or_else(|| summary.name.clone());
    let agent_path = summary
        .metadata
        .get("agentPath")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| serde_json::json!(["main", summary.subagent_id]));
    let depth = summary
        .metadata
        .get("depth")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let capacity = summary
        .metadata
        .get("capacity")
        .cloned()
        .unwrap_or(Value::Null);

    serde_json::json!({
        "agentId": summary.subagent_id,
        "agentPath": agent_path,
        "parentThreadId": parent_thread_id,
        "parentRunId": summary.parent_run_id,
        "childRunId": summary.child_run_id,
        "role": role,
        "nickname": nickname,
        "depth": depth,
        "capacity": capacity,
        "lifecycle": {
            "status": status_value(&summary.status),
            "active": active_child_run_id_for_status(summary).is_some(),
            "terminal": subagent_status_is_terminal(&summary.status),
            "mailboxDepth": summary.mailbox_depth,
            "closedAt": summary.closed_at,
            "terminalResult": summary.terminal_result,
            "blockerSummary": summary.blocker_summary,
            "pendingApproval": summary.pending_approval,
        }
    })
}

fn subagent_status_is_terminal(status: &SubagentThreadStatus) -> bool {
    matches!(
        status,
        SubagentThreadStatus::Completed
            | SubagentThreadStatus::Failed
            | SubagentThreadStatus::Cancelled
            | SubagentThreadStatus::Closed
            | SubagentThreadStatus::Interrupted
    )
}

fn status_string(status: &SubagentThreadStatus) -> &'static str {
    match status {
        SubagentThreadStatus::Running => "running",
        SubagentThreadStatus::WaitingMainAgent => "waiting_main_agent",
        SubagentThreadStatus::WaitingUser => "waiting_user",
        SubagentThreadStatus::AwaitingApproval => "awaiting_approval",
        SubagentThreadStatus::Completed => "completed",
        SubagentThreadStatus::Failed => "failed",
        SubagentThreadStatus::Cancelled => "cancelled",
        SubagentThreadStatus::Closed => "closed",
        SubagentThreadStatus::Interrupted => "interrupted",
    }
}

fn non_empty_string(value: &str) -> Option<String> {
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

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn bool_field(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

fn u64_field(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn preview_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("text")
        .or_else(|| payload.get("content"))
        .and_then(Value::as_str)
        .map(|value| value.trim().chars().take(160).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn thread_matches_query(thread: &ThreadRecord, query: &str) -> bool {
    let mut haystacks = vec![
        thread.thread_id.as_str(),
        thread.title.as_str(),
        thread.source.as_str(),
    ];
    if let Some(summary) = thread.metadata.summary.as_deref() {
        haystacks.push(summary);
    }
    if let Some(preview) = thread.metadata.preview.as_deref() {
        haystacks.push(preview);
    }
    if let Some(model) = thread.metadata.model.as_deref() {
        haystacks.push(model);
    }
    haystacks
        .iter()
        .any(|value| value.to_lowercase().contains(query))
        || thread
            .metadata
            .tags
            .iter()
            .any(|tag| tag.to_lowercase().contains(query))
}

fn is_checkpoint_item(item: &ThreadItem) -> bool {
    matches!(item.kind, ThreadItemKind::CheckpointCreated(_))
}

fn is_terminal_run_item(item: &ThreadItem) -> bool {
    matches!(
        item.kind,
        ThreadItemKind::AgentRunCompleted(_)
            | ThreadItemKind::Error(_)
            | ThreadItemKind::Cancelled(_)
    )
}

fn latest_checkpoint_from_items(thread_id: &str, items: &[ThreadItem]) -> Option<ThreadCheckpoint> {
    items
        .iter()
        .filter_map(|item| checkpoint_from_item(thread_id, item))
        .filter(|checkpoint| {
            !items.iter().any(|item| {
                item.sequence > checkpoint.sequence
                    && checkpoint
                        .run_id
                        .as_ref()
                        .is_some_and(|run_id| item.run_id.as_ref() == Some(run_id))
                    && is_terminal_run_item(item)
            })
        })
        .max_by_key(|checkpoint| checkpoint.sequence)
}

fn checkpoint_from_item(thread_id: &str, item: &ThreadItem) -> Option<ThreadCheckpoint> {
    let ThreadItemKind::CheckpointCreated(payload) = &item.kind else {
        return None;
    };
    let checkpoint_id = string_field(payload, "checkpointId")
        .or_else(|| string_field(payload, "checkpoint_id"))
        .or_else(|| non_empty_string(&item.item_id))
        .unwrap_or_else(|| format!("checkpoint:{}", item.sequence));
    let run_id = item
        .run_id
        .clone()
        .or_else(|| string_field(payload, "runId"))
        .or_else(|| string_field(payload, "run_id"));
    let restore_payload = payload
        .get("restorePayload")
        .or_else(|| payload.get("restore_payload"))
        .or_else(|| payload.get("checkpoint"))
        .cloned()
        .unwrap_or_else(|| payload.clone());
    Some(ThreadCheckpoint {
        checkpoint_id,
        thread_id: thread_id.to_string(),
        run_id,
        sequence: item.sequence,
        label: string_field(payload, "label"),
        created_at: item.created_at.clone(),
        restore_payload,
    })
}

fn read_cursor_from_request(
    request: &ReadThreadRequest,
    items: &[ThreadItem],
) -> Result<u64, WorkerProtocolError> {
    if request.cursor.is_some() {
        return parse_sequence_cursor(request.cursor.as_deref());
    }
    if let Some(checkpoint_id) = request.checkpoint_id.as_deref() {
        let checkpoint = items
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
            })?;
        return Ok(checkpoint.sequence.saturating_sub(1));
    }
    if let Some(sequence) = request.checkpoint_sequence {
        return Ok(sequence.saturating_sub(1));
    }
    Ok(0)
}

fn bounded_limit(limit: Option<usize>, default: usize, max: usize) -> usize {
    limit.unwrap_or(default).max(1).min(max)
}

fn thread_matches_list_filters(
    thread: &ThreadRecord,
    all_threads: &[ThreadRecord],
    request: &ListThreadsRequest,
) -> bool {
    if let Some(parent_thread_id) = request.parent_thread_id.as_deref() {
        if thread.parent_thread_id.as_deref() != Some(parent_thread_id) {
            return false;
        }
    }
    if let Some(ancestor_thread_id) = request.ancestor_thread_id.as_deref() {
        if !thread_is_descendant_of(thread, all_threads, ancestor_thread_id) {
            return false;
        }
    }
    true
}

fn thread_is_descendant_of(
    thread: &ThreadRecord,
    all_threads: &[ThreadRecord],
    ancestor_thread_id: &str,
) -> bool {
    let mut current_parent = thread.parent_thread_id.as_deref();
    for _ in 0..all_threads.len() {
        let Some(parent_id) = current_parent else {
            return false;
        };
        if parent_id == ancestor_thread_id {
            return true;
        }
        current_parent = all_threads
            .iter()
            .find(|candidate| candidate.thread_id == parent_id)
            .and_then(|candidate| candidate.parent_thread_id.as_deref());
    }
    false
}

fn descendant_thread_ids(index: &ThreadIndex, thread_id: &str) -> Vec<String> {
    let mut descendants = Vec::new();
    let mut stack = vec![thread_id.to_string()];
    while let Some(parent_id) = stack.pop() {
        for child in index
            .threads
            .iter()
            .filter(|thread| thread.parent_thread_id.as_deref() == Some(parent_id.as_str()))
        {
            descendants.push(child.thread_id.clone());
            stack.push(child.thread_id.clone());
        }
    }
    descendants
}

fn parse_trace_cursor(cursor: Option<&str>) -> Result<usize, WorkerProtocolError> {
    match cursor {
        Some(value) if !value.trim().is_empty() => value.parse::<usize>().map_err(|error| {
            invalid_thread_request(
                "agent run trace cursor must be an offset",
                serde_json::json!({ "cursor": value, "error": error.to_string() }),
            )
        }),
        _ => Ok(0),
    }
}

fn parse_sequence_cursor(cursor: Option<&str>) -> Result<u64, WorkerProtocolError> {
    match cursor {
        Some(value) if !value.trim().is_empty() => value.parse::<u64>().map_err(|error| {
            invalid_thread_request(
                "thread cursor must be a sequence number",
                serde_json::json!({ "cursor": value, "error": error.to_string() }),
            )
        }),
        _ => Ok(0),
    }
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

fn client_fork_thread_id(metadata: &ThreadMetadata, client_event_id: &str) -> Option<String> {
    metadata
        .extra
        .get(CLIENT_FORK_THREAD_IDS_KEY)?
        .get(client_event_id)?
        .as_str()
        .map(str::to_string)
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

fn remember_client_fork_thread_id(extra: &mut Value, client_event_id: &str, fork_thread_id: &str) {
    if !extra.is_object() {
        *extra = Value::Object(Default::default());
    }
    let Some(extra_object) = extra.as_object_mut() else {
        return;
    };
    let entry = extra_object
        .entry(CLIENT_FORK_THREAD_IDS_KEY.to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !entry.is_object() {
        *entry = Value::Object(Default::default());
    }
    if let Some(client_forks) = entry.as_object_mut() {
        client_forks.insert(
            client_event_id.to_string(),
            Value::String(fork_thread_id.to_string()),
        );
    }
}

fn trace_event_from_thread_item(item: &ThreadItem) -> Option<Value> {
    let (payload, fallback_event_name) = match &item.kind {
        ThreadItemKind::AssistantMessageDelta(value) => (value, Some("agent.assistant.delta")),
        ThreadItemKind::AssistantMessageCompleted(value) => {
            (value, Some("agent.assistant.completed"))
        }
        ThreadItemKind::Reasoning(value) => (value, Some("agent.reasoning")),
        ThreadItemKind::ToolCallStarted(value) => (value, Some("agent.tool.start")),
        ThreadItemKind::ToolCallOutput(value) => (value, Some("agent.tool.result")),
        ThreadItemKind::ApprovalRequested(value) => (value, Some("agent.awaiting_approval")),
        ThreadItemKind::ApprovalResolved(value) => (value, Some("agent.approval.decision")),
        ThreadItemKind::AgentRunStep(value) => (value, Some("agent.step")),
        ThreadItemKind::CheckpointCreated(value) => (value, None),
        ThreadItemKind::ContextTrimmed(value) => (value, Some("agent.context.trimmed")),
        ThreadItemKind::ContextCompaction(value) => (value, Some("agent.context.compacted")),
        ThreadItemKind::SubagentSpawned(value) => (value, Some("agent.delegate.spawned")),
        ThreadItemKind::SubagentMessage(value) => (value, Some("agent.delegate.message")),
        ThreadItemKind::SubagentCompleted(value) => (value, Some("agent.delegate.completed")),
        ThreadItemKind::Error(value) => (value, Some("agent.error")),
        ThreadItemKind::Cancelled(value) => (value, Some("agent.cancelled")),
        ThreadItemKind::Event(value) => (value, None),
        ThreadItemKind::UserMessage(_)
        | ThreadItemKind::AgentRunStarted(_)
        | ThreadItemKind::AgentRunCompleted(_)
        | ThreadItemKind::SettingsChanged(_) => return None,
    };
    let has_trace_shape = payload.get("eventName").is_some()
        || payload.get("event_name").is_some()
        || payload.get("schemaVersion").is_some()
        || payload.get("schema_version").is_some();
    if has_trace_shape {
        return Some(payload.clone());
    }
    fallback_event_name.map(|event_name| {
        serde_json::json!({
            "eventName": event_name,
            "payload": payload,
        })
    })
}

fn runtime_event_from_thread_item(
    item: &ThreadItem,
    session_id: &str,
    run_id: &str,
) -> Option<AgentRuntimeEventEnvelope> {
    let event = trace_event_from_thread_item(item)?;
    if let Ok(envelope) = serde_json::from_value::<AgentRuntimeEventEnvelope>(event.clone()) {
        return Some(envelope);
    }
    let event_name = event
        .get("eventName")
        .or_else(|| event.get("event_name"))
        .and_then(Value::as_str)?
        .to_string();
    let payload = event
        .get("payload")
        .cloned()
        .unwrap_or_else(|| event.clone());
    let item_id = event
        .get("itemId")
        .or_else(|| event.get("item_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| legacy_trace_item_id(&event_name, &payload))
        .or_else(|| Some(item.item_id.clone()));
    let sequence = event
        .get("sequence")
        .and_then(Value::as_u64)
        .unwrap_or(item.sequence);
    let timestamp = event
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| item.created_at.clone());
    Some(AgentRuntimeEventEnvelope::from_legacy_native_event(
        LegacyNativeAgentEventEnvelopeInput {
            session_id: event
                .get("sessionId")
                .or_else(|| event.get("session_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| session_id.to_string()),
            thread_id: event
                .get("threadId")
                .or_else(|| event.get("thread_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| Some(item.thread_id.clone())),
            turn_id: item
                .turn_id
                .clone()
                .or_else(|| item.run_id.clone())
                .unwrap_or_else(|| run_id.to_string()),
            parent_turn_id: event
                .get("parentTurnId")
                .or_else(|| event.get("parent_turn_id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            item_id,
            event_name,
            sequence,
            timestamp,
            payload,
        },
    ))
}

fn runtime_events_from_thread_items(
    items: &[ThreadItem],
    session_id: &str,
    run_id: &str,
) -> Vec<AgentRuntimeEventEnvelope> {
    items
        .iter()
        .filter(|item| item.run_id.as_deref() == Some(run_id))
        .filter_map(|item| runtime_event_from_thread_item(item, session_id, run_id))
        .collect()
}

fn turn_items_from_thread_items(
    items: &[ThreadItem],
    session_id: &str,
    run_id: &str,
) -> Vec<AgentTurnItem> {
    let runtime_events = runtime_events_from_thread_items(items, session_id, run_id);
    project_turn_items_from_trace_events(&runtime_events)
}

fn legacy_trace_item_id(event_name: &str, payload: &Value) -> Option<String> {
    match event_name {
        "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" => {
            string_from_trace_payload(payload, &["toolCallId", "tool_call_id"])
        }
        "agent.awaiting_approval" | "agent.approval.decision" => {
            string_from_trace_payload(payload, &["approvalId", "approval_id"])
        }
        "agent.awaiting_form" | "agent.form.resolution" => {
            string_from_trace_payload(payload, &["formId", "form_id"])
        }
        event_name if event_name.starts_with("agent.delegate.") => {
            string_from_trace_payload(payload, &["delegateId", "subagentId", "delegate_id"])
        }
        _ => None,
    }
}

fn string_from_trace_payload(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::to_string)
    })
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

fn ensure_thread_schema(connection: &Connection) -> Result<(), WorkerProtocolError> {
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS threads (
                thread_id TEXT PRIMARY KEY NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                session_key TEXT,
                parent_thread_id TEXT,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT,
                record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_threads_updated_at
                ON threads(updated_at DESC, thread_id ASC);
            CREATE INDEX IF NOT EXISTS idx_threads_session_key
                ON threads(session_key);
            CREATE INDEX IF NOT EXISTS idx_threads_parent
                ON threads(parent_thread_id);
            CREATE TABLE IF NOT EXISTS thread_items (
                thread_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                item_id TEXT NOT NULL,
                run_id TEXT,
                turn_id TEXT,
                parent_item_id TEXT,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                item_json TEXT NOT NULL,
                PRIMARY KEY (thread_id, sequence),
                UNIQUE (thread_id, item_id)
            );
            CREATE INDEX IF NOT EXISTS idx_thread_items_run
                ON thread_items(thread_id, run_id);
            CREATE INDEX IF NOT EXISTS idx_thread_items_created
                ON thread_items(thread_id, created_at);
            ",
        )
        .map_err(thread_sqlite_error)
}

fn thread_item_kind_name(kind: &ThreadItemKind) -> &'static str {
    match kind {
        ThreadItemKind::UserMessage(_) => "user_message",
        ThreadItemKind::AssistantMessageDelta(_) => "assistant_message_delta",
        ThreadItemKind::AssistantMessageCompleted(_) => "assistant_message_completed",
        ThreadItemKind::Reasoning(_) => "reasoning",
        ThreadItemKind::ToolCallStarted(_) => "tool_call_started",
        ThreadItemKind::ToolCallOutput(_) => "tool_call_output",
        ThreadItemKind::ApprovalRequested(_) => "approval_requested",
        ThreadItemKind::ApprovalResolved(_) => "approval_resolved",
        ThreadItemKind::AgentRunStarted(_) => "agent_run_started",
        ThreadItemKind::AgentRunStep(_) => "agent_run_step",
        ThreadItemKind::AgentRunCompleted(_) => "agent_run_completed",
        ThreadItemKind::CheckpointCreated(_) => "checkpoint_created",
        ThreadItemKind::ContextTrimmed(_) => "context_trimmed",
        ThreadItemKind::ContextCompaction(_) => "context_compaction",
        ThreadItemKind::SubagentSpawned(_) => "subagent_spawned",
        ThreadItemKind::SubagentMessage(_) => "subagent_message",
        ThreadItemKind::SubagentCompleted(_) => "subagent_completed",
        ThreadItemKind::SettingsChanged(_) => "settings_changed",
        ThreadItemKind::Error(_) => "error",
        ThreadItemKind::Cancelled(_) => "cancelled",
        ThreadItemKind::Event(_) => "event",
    }
}

fn thread_io_error(operation: &'static str, error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread store IO error during {operation}: {error}"),
        serde_json::json!({ "method": "thread" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_sqlite_error(error: rusqlite::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread store SQLite error: {error}"),
        serde_json::json!({ "method": "thread" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_json_error(error: serde_json::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        format!("thread store JSON error: {error}"),
        serde_json::json!({ "method": "thread" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
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

fn invalid_thread_request(message: impl Into<String>, details: Value) -> WorkerProtocolError {
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
    use std::fs;

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

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tinybot-thread-{name}-{}", now_millis()))
    }

    struct Cleanup(PathBuf);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
