use super::index::ThreadIndex;
use super::{
    active_child_run_id_for_status, agent_registry_entry, agent_run_record_from_thread_run,
    apply_metadata_patch, bounded_limit, checkpoint_from_item, descendant_thread_ids,
    generate_item_id, generate_thread_id, inherited_subagent_history_items, invalid_thread_request,
    latest_checkpoint_from_items, non_empty_string, now_timestamp, parse_sequence_cursor,
    parse_trace_cursor, pending_approvals_from_items, read_cursor_from_request,
    recompute_dynamic_metadata, remember_client_event_items, run_summaries_from_items,
    running_tools_from_items, runtime_events_from_thread_items, status_value,
    subagent_agent_control_payload, subagent_child_status_item, subagent_initial_child_items,
    subagent_input_item, subagent_lifecycle_item_label, subagent_parent_item,
    thread_items_match_query, thread_matches_list_filters, thread_matches_query,
    thread_status_for_subagent, trace_event_from_thread_item, turn_items_from_thread_items,
    unknown_thread_error, validate_context_checkpoint_lineage, validate_thread_id, AgentRunRecord,
    AgentRunRuntimeState, AgentRunTracePage, AppendThreadItemsResult, CreateThreadRequest,
    DeleteThreadRequest, DeleteThreadResult, ForkThreadRequest, ListThreadsRequest,
    ListThreadsResult, ReadThreadRequest, RestoreThreadCheckpointRequest,
    RestoreThreadCheckpointResult, ResumeThreadRequest, SearchThreadsRequest, SearchThreadsResult,
    SubagentMailboxInput, SubagentThreadStatus, SubagentThreadSummary, ThreadActivityRequest,
    ThreadActivityResult, ThreadActivitySummary, ThreadAgentRegistryRequest,
    ThreadAgentRegistryResult, ThreadChildActivity, ThreadChildSummary, ThreadEvent,
    ThreadEventsRequest, ThreadEventsResult, ThreadItem, ThreadItemKind, ThreadMetadata,
    ThreadMetadataPatch, ThreadPagination, ThreadRecord, ThreadSnapshot, ThreadStatus,
    ThreadStatusResult, ThreadStore, CLIENT_EVENT_IDS_KEY, DEFAULT_LIST_LIMIT, DEFAULT_READ_LIMIT,
    DEFAULT_SEARCH_LIMIT, DEFAULT_THREAD_TITLE, MAX_LIST_LIMIT, MAX_READ_LIMIT, MAX_SEARCH_LIMIT,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_thread::ThreadRunSummary;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Debug, Default)]
pub struct MemoryThreadStore {
    state: Arc<Mutex<MemoryThreadState>>,
}

#[derive(Debug, Default)]
struct MemoryThreadState {
    threads: Vec<ThreadRecord>,
    items: BTreeMap<String, Vec<ThreadItem>>,
    client_events: HashMap<(String, String), Vec<String>>,
    client_forks: HashMap<(String, String), String>,
}

impl MemoryThreadStore {
    pub(crate) fn replace_projection(
        &self,
        threads: Vec<ThreadRecord>,
        items: BTreeMap<String, Vec<ThreadItem>>,
    ) -> Result<(), WorkerProtocolError> {
        let client_events = threads
            .iter()
            .flat_map(|thread| {
                thread
                    .metadata
                    .extra
                    .get(CLIENT_EVENT_IDS_KEY)
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .map(|(client_event_id, item_ids)| {
                        (
                            (thread.thread_id.clone(), client_event_id.clone()),
                            item_ids
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect::<Vec<_>>(),
                        )
                    })
            })
            .collect::<HashMap<_, _>>();
        let client_forks = threads
            .iter()
            .filter_map(|thread| {
                let source_thread_id = thread
                    .metadata
                    .extra
                    .get("forkedFromThreadId")
                    .and_then(Value::as_str)?;
                let client_event_id = thread
                    .metadata
                    .extra
                    .get("forkClientEventId")
                    .and_then(Value::as_str)?;
                Some((
                    (source_thread_id.to_string(), client_event_id.to_string()),
                    thread.thread_id.clone(),
                ))
            })
            .collect::<HashMap<_, _>>();
        let mut state = self.lock()?;
        state.threads = threads;
        state.items = items;
        state.client_events = client_events;
        state.client_forks = client_forks;
        Ok(())
    }

    pub(crate) fn archive_target_records(
        &self,
        thread_id: &str,
        archive_children: bool,
    ) -> Result<Vec<ThreadRecord>, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let state = self.lock()?;
        if !state
            .threads
            .iter()
            .any(|thread| thread.thread_id == thread_id)
        {
            return Err(unknown_thread_error(thread_id));
        }
        let index = ThreadIndex {
            threads: state.threads.clone(),
        };
        let mut target_ids = vec![thread_id.to_string()];
        if archive_children {
            target_ids.extend(descendant_thread_ids(&index, thread_id));
        }
        Ok(state
            .threads
            .iter()
            .filter(|thread| target_ids.contains(&thread.thread_id))
            .cloned()
            .collect())
    }

    pub(crate) fn thread_events(
        &self,
        request: ThreadEventsRequest,
    ) -> Result<ThreadEventsResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let cursor = match request.cursor.as_deref() {
            Some(value) => parse_sequence_cursor(Some(value))?,
            None => request.after_sequence.unwrap_or(0),
        };
        let limit = bounded_limit(request.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
        let state = self.lock()?;
        let thread = state
            .threads
            .iter()
            .find(|thread| thread.thread_id == request.thread_id)
            .cloned()
            .ok_or_else(|| unknown_thread_error(&request.thread_id))?;
        let all_items = state
            .items
            .get(&request.thread_id)
            .cloned()
            .unwrap_or_default();
        let runs = run_summaries_from_items(&thread, &all_items);
        let active_run = runs.iter().find(|run| run.active).cloned();
        let latest_checkpoint = latest_checkpoint_from_items(&thread.thread_id, &all_items);
        let child_activities = child_activities(&state, &request.thread_id);
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

    pub(crate) fn restore_checkpoint(
        &self,
        request: RestoreThreadCheckpointRequest,
    ) -> Result<RestoreThreadCheckpointResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let all_items = self
            .lock()?
            .items
            .get(&request.thread_id)
            .cloned()
            .unwrap_or_default();
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

    pub(crate) fn agent_registry(
        &self,
        request: ThreadAgentRegistryRequest,
    ) -> Result<ThreadAgentRegistryResult, WorkerProtocolError> {
        if let Some(thread_id) = request.thread_id.as_deref() {
            validate_thread_id(thread_id)?;
        }
        let state = self.lock()?;
        let index = ThreadIndex {
            threads: state.threads.clone(),
        };
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
        let mut agents = index
            .threads
            .iter()
            .filter(|thread| {
                (request.include_archived || thread.status != ThreadStatus::Archived)
                    && scoped_thread_ids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&thread.thread_id))
                    && (request.include_child_threads || thread.parent_thread_id.is_none())
            })
            .map(|thread| {
                agent_registry_entry(
                    thread,
                    &index,
                    state
                        .items
                        .get(&thread.thread_id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                )
            })
            .collect::<Vec<_>>();
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

    pub(crate) fn activity(
        &self,
        request: ThreadActivityRequest,
    ) -> Result<ThreadActivityResult, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let (thread, thread_ids, pending_approvals, running_tools, checkpoints) = {
            let state = self.lock()?;
            let thread = state
                .threads
                .iter()
                .find(|thread| thread.thread_id == request.thread_id)
                .cloned()
                .ok_or_else(|| unknown_thread_error(&request.thread_id))?;
            let index = ThreadIndex {
                threads: state.threads.clone(),
            };
            let mut thread_ids = vec![request.thread_id.clone()];
            if request.include_child_threads {
                thread_ids.extend(descendant_thread_ids(&index, &request.thread_id));
            }
            let mut pending_approvals = Vec::new();
            let mut running_tools = Vec::new();
            let mut checkpoints = Vec::new();
            for thread_id in &thread_ids {
                let items = state.items.get(thread_id).map(Vec::as_slice).unwrap_or(&[]);
                pending_approvals.extend(pending_approvals_from_items(thread_id, items));
                running_tools.extend(running_tools_from_items(thread_id, items));
                if let Some(checkpoint) = latest_checkpoint_from_items(thread_id, items) {
                    checkpoints.push(checkpoint);
                }
            }
            (
                thread,
                thread_ids,
                pending_approvals,
                running_tools,
                checkpoints,
            )
        };
        let _ = thread_ids;
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

    pub(crate) fn list_agent_run_trace_events(
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
            .filter(|item| !matches!(&item.kind, ThreadItemKind::UserMessage(_)))
            .filter_map(trace_event_from_thread_item)
            .collect::<Vec<_>>();
        let page_items = events
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_offset = offset.saturating_add(page_items.len());
        Ok(Some(AgentRunTracePage {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            items: page_items,
            next_cursor: (next_offset < events.len()).then(|| next_offset.to_string()),
        }))
    }

    pub(crate) fn get_agent_run_runtime_state(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRuntimeState>, WorkerProtocolError> {
        let Some(items) = self.agent_run_thread_items(session_id, run_id)? else {
            return Ok(None);
        };
        Ok(Some(AgentRunRuntimeState::from_runtime_events(
            session_id,
            run_id,
            runtime_events_from_thread_items(&items, session_id, run_id),
        )?))
    }

    pub(crate) fn list_agent_runs_from_threads(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentRunRecord>, WorkerProtocolError> {
        let state = self.lock()?;
        let mut records = Vec::new();
        for thread in state
            .threads
            .iter()
            .filter(|thread| thread.session_key.as_deref() == Some(session_id))
            .filter(|thread| thread.status != ThreadStatus::Archived)
        {
            let items = state
                .items
                .get(&thread.thread_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            records.extend(
                run_summaries_from_items(thread, items)
                    .into_iter()
                    .map(|run| agent_run_record_from_thread_run(session_id, thread, &run, items)),
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

    pub(crate) fn get_agent_run_from_threads(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRecord>, WorkerProtocolError> {
        Ok(self
            .list_agent_runs_from_threads(session_id)?
            .into_iter()
            .find(|record| record.run_id == run_id))
    }

    fn agent_run_thread_items(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError> {
        let state = self.lock()?;
        let mut matched = false;
        let mut items = Vec::new();
        for thread in state
            .threads
            .iter()
            .filter(|thread| thread.session_key.as_deref() == Some(session_id))
        {
            let mut thread_items = state
                .items
                .get(&thread.thread_id)
                .into_iter()
                .flatten()
                .filter(|item| item.run_id.as_deref() == Some(run_id))
                .cloned()
                .collect::<Vec<_>>();
            if thread.root_run_id.as_deref() == Some(run_id)
                || thread.active_run_id.as_deref() == Some(run_id)
                || !thread_items.is_empty()
            {
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

    pub(crate) fn record_subagent_spawn(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<Vec<AppendThreadItemsResult>, WorkerProtocolError> {
        let parent = self.ensure_parent_thread_for_subagent(summary)?;
        let child = self.ensure_child_thread_for_subagent(summary, &parent.thread_id)?;
        let parent_items = self
            .lock()?
            .items
            .get(&parent.thread_id)
            .cloned()
            .unwrap_or_default();
        let mut child_items =
            inherited_subagent_history_items(summary, &parent.thread_id, &parent_items);
        child_items.extend(subagent_initial_child_items(summary, event.clone()));
        let mut results = Vec::with_capacity(2);
        if !child_items.is_empty() {
            results.push(self.append_items(&child.thread_id, child_items)?);
        }
        results.push(self.append_items(
            &parent.thread_id,
            vec![subagent_parent_item(
                summary,
                event,
                "spawned",
                ThreadItemKind::SubagentSpawned,
            )],
        )?);
        Ok(results)
    }

    pub(crate) fn record_subagent_input(
        &self,
        summary: &SubagentThreadSummary,
        input: &SubagentMailboxInput,
        event: Option<Value>,
    ) -> Result<Vec<AppendThreadItemsResult>, WorkerProtocolError> {
        let parent = self.ensure_parent_thread_for_subagent(summary)?;
        let child = self.ensure_child_thread_for_subagent(summary, &parent.thread_id)?;
        Ok(vec![self.append_items(
            &child.thread_id,
            vec![subagent_input_item(summary, input, event)],
        )?])
    }

    pub(crate) fn record_subagent_status(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<Vec<AppendThreadItemsResult>, WorkerProtocolError> {
        let parent = self.ensure_parent_thread_for_subagent(summary)?;
        let child = self.ensure_child_thread_for_subagent(summary, &parent.thread_id)?;
        let child_result = self.append_items(
            &child.thread_id,
            vec![subagent_child_status_item(summary, event.clone())],
        )?;
        let lifecycle_label = format!(
            "lifecycle:{}",
            subagent_lifecycle_item_label(summary, event.as_ref())
        );
        let kind = if matches!(
            summary.status,
            SubagentThreadStatus::Completed
                | SubagentThreadStatus::Failed
                | SubagentThreadStatus::Cancelled
                | SubagentThreadStatus::Closed
                | SubagentThreadStatus::Interrupted
        ) {
            ThreadItemKind::SubagentCompleted
        } else {
            ThreadItemKind::SubagentMessage
        };
        let parent_result = self.append_items(
            &parent.thread_id,
            vec![subagent_parent_item(summary, event, &lifecycle_label, kind)],
        )?;
        Ok(vec![child_result, parent_result])
    }

    fn ensure_parent_thread_for_subagent(
        &self,
        summary: &SubagentThreadSummary,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let mut state = self.lock()?;
        if let Some(parent_subagent_id) = summary.parent_subagent_id.as_deref() {
            return state
                .threads
                .iter()
                .find(|thread| {
                    thread.source == "subagent"
                        && thread.session_key.as_deref() == Some(summary.session_key.as_str())
                        && thread
                            .metadata
                            .extra
                            .get("subagentId")
                            .and_then(Value::as_str)
                            == Some(parent_subagent_id)
                })
                .cloned()
                .ok_or_else(|| {
                    WorkerProtocolError::new(
                        WorkerProtocolErrorCode::InvalidProtocol,
                        "durable parent subagent thread is missing",
                        serde_json::json!({
                            "sessionKey": summary.session_key,
                            "parentSubagentId": parent_subagent_id,
                            "subagentId": summary.subagent_id,
                        }),
                        false,
                        WorkerProtocolErrorSource::RustCore,
                    )
                });
        }
        if let Some(parent) = state.threads.iter().find(|thread| {
            thread.session_key.as_deref() == Some(summary.session_key.as_str())
                && thread.parent_thread_id.is_none()
        }) {
            return Ok(parent.clone());
        }
        let thread = ThreadRecord {
            thread_id: generate_thread_id(),
            title: format!("Desktop Session {}", summary.session_key),
            status: ThreadStatus::Idle,
            session_key: Some(summary.session_key.clone()),
            root_run_id: summary.parent_run_id.clone(),
            active_run_id: summary.parent_run_id.clone(),
            parent_thread_id: None,
            source: "subagent_parent".to_string(),
            created_at: summary.created_at.clone(),
            updated_at: summary.updated_at.clone(),
            archived_at: None,
            metadata: ThreadMetadata {
                last_activity_at: Some(summary.created_at.clone()),
                extra: serde_json::json!({ "subagentParent": true }),
                ..ThreadMetadata::default()
            },
        };
        state.items.insert(thread.thread_id.clone(), Vec::new());
        state.threads.push(thread.clone());
        Ok(thread)
    }

    fn ensure_child_thread_for_subagent(
        &self,
        summary: &SubagentThreadSummary,
        parent_thread_id: &str,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let mut state = self.lock()?;
        if let Some(thread) = state.threads.iter_mut().find(|thread| {
            thread.source == "subagent"
                && thread.session_key.as_deref() == Some(summary.session_key.as_str())
                && thread
                    .metadata
                    .extra
                    .get("subagentId")
                    .and_then(Value::as_str)
                    == Some(summary.subagent_id.as_str())
        }) {
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
            return Ok(thread.clone());
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
        state.items.insert(thread.thread_id.clone(), Vec::new());
        state.threads.push(thread.clone());
        Ok(thread)
    }

    pub fn append_items_with_client_event_id(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let mut state = self.lock()?;
        if let Some(client_event_id) = normalized_client_event_id(client_event_id) {
            if let Some(item_ids) = state
                .client_events
                .get(&(thread_id.to_string(), client_event_id.to_string()))
            {
                let replayed = item_ids
                    .iter()
                    .filter_map(|item_id| {
                        state
                            .items
                            .get(thread_id)
                            .and_then(|items| items.iter().find(|item| item.item_id == *item_id))
                            .cloned()
                    })
                    .collect::<Vec<_>>();
                if replayed.len() == item_ids.len() {
                    let thread = state
                        .threads
                        .iter()
                        .find(|thread| thread.thread_id == thread_id)
                        .cloned()
                        .ok_or_else(|| unknown_thread_error(thread_id))?;
                    return Ok(AppendThreadItemsResult {
                        thread,
                        items: replayed,
                    });
                }
            }
        }
        let thread_position = state
            .threads
            .iter()
            .position(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        let checkpoint_session_id = state.threads[thread_position]
            .session_key
            .as_deref()
            .unwrap_or(thread_id)
            .to_string();
        validate_context_checkpoint_lineage(
            &checkpoint_session_id,
            state.items.get(thread_id).map(Vec::as_slice).unwrap_or(&[]),
            &items,
        )?;
        let timestamp = now_timestamp();
        let existing = state.items.entry(thread_id.to_string()).or_default();
        let mut next_sequence = existing
            .iter()
            .map(|item| item.sequence)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let mut appended = Vec::new();
        for mut item in items {
            item.thread_id = thread_id.to_string();
            if item.item_id.trim().is_empty() {
                item.item_id = generate_item_id();
            }
            if let Some(position) = existing
                .iter()
                .position(|stored| stored.item_id == item.item_id)
            {
                if item.sequence == 0 {
                    item.sequence = existing[position].sequence;
                }
                if item.created_at.trim().is_empty() {
                    item.created_at = existing[position].created_at.clone();
                }
                existing[position] = item.clone();
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
        existing.sort_by_key(|item| item.sequence);
        let existing_snapshot = existing.clone();
        if let Some(client_event_id) = normalized_client_event_id(client_event_id) {
            state.client_events.insert(
                (thread_id.to_string(), client_event_id.to_string()),
                appended.iter().map(|item| item.item_id.clone()).collect(),
            );
        }
        let record = &mut state.threads[thread_position];
        if let Some(client_event_id) = normalized_client_event_id(client_event_id) {
            remember_client_event_items(&mut record.metadata.extra, client_event_id, &appended);
        }
        recompute_dynamic_metadata(record, &existing_snapshot);
        record.updated_at = timestamp;
        Ok(AppendThreadItemsResult {
            thread: record.clone(),
            items: appended,
        })
    }

    pub fn client_event_items(
        &self,
        thread_id: &str,
        client_event_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError> {
        let state = self.lock()?;
        let Some(item_ids) = state
            .client_events
            .get(&(thread_id.to_string(), client_event_id.to_string()))
        else {
            return Ok(None);
        };
        let Some(items) = state.items.get(thread_id) else {
            return Ok(None);
        };
        let replayed = item_ids
            .iter()
            .filter_map(|item_id| items.iter().find(|item| item.item_id == *item_id).cloned())
            .collect::<Vec<_>>();
        Ok((replayed.len() == item_ids.len()).then_some(replayed))
    }

    pub fn archive_thread_with_children(
        &self,
        thread_id: &str,
        archived: bool,
        archive_children: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let mut state = self.lock()?;
        let index = ThreadIndex {
            threads: state.threads.clone(),
        };
        let mut target_ids = vec![thread_id.to_string()];
        if archive_children {
            target_ids.extend(descendant_thread_ids(&index, thread_id));
        }
        let timestamp = now_timestamp();
        let mut updated = None;
        for record in state
            .threads
            .iter_mut()
            .filter(|record| target_ids.contains(&record.thread_id))
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
        updated.ok_or_else(|| unknown_thread_error(thread_id))
    }

    fn lock(&self) -> Result<MutexGuard<'_, MemoryThreadState>, WorkerProtocolError> {
        self.state.lock().map_err(|_| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "in-memory thread store lock is poisoned",
                serde_json::json!({ "method": "thread" }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })
    }
}

impl ThreadStore for MemoryThreadStore {
    fn create_thread(
        &self,
        request: CreateThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let thread_id = request.thread_id.unwrap_or_else(generate_thread_id);
        validate_thread_id(&thread_id)?;
        let mut state = self.lock()?;
        if state
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
        let title = request
            .title
            .or(request.metadata.title)
            .unwrap_or_else(|| DEFAULT_THREAD_TITLE.to_string());
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
            updated_at: timestamp.clone(),
            archived_at: None,
            metadata: ThreadMetadata {
                summary: request.metadata.summary,
                preview: request.metadata.preview,
                tags: request.metadata.tags.unwrap_or_default(),
                model: request.metadata.model,
                working_directory: request.metadata.working_directory,
                last_user_message_at: request.metadata.last_user_message_at,
                last_assistant_message_at: request.metadata.last_assistant_message_at,
                last_activity_at: request.metadata.last_activity_at.or(Some(timestamp)),
                has_active_run: request.metadata.has_active_run.unwrap_or(false),
                extra: request
                    .metadata
                    .extra
                    .unwrap_or_else(|| Value::Object(Default::default())),
                ..ThreadMetadata::default()
            },
        };
        state.items.insert(thread_id, Vec::new());
        state.threads.push(record.clone());
        Ok(record)
    }

    fn read_thread(
        &self,
        request: ReadThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        validate_thread_id(&request.thread_id)?;
        let state = self.lock()?;
        let thread = state
            .threads
            .iter()
            .find(|thread| thread.thread_id == request.thread_id)
            .cloned()
            .ok_or_else(|| unknown_thread_error(&request.thread_id))?;
        let all_items = state
            .items
            .get(&request.thread_id)
            .cloned()
            .unwrap_or_default();
        let cursor = read_cursor_from_request(&request, &all_items)?;
        let limit = bounded_limit(request.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
        let item_count = all_items.len();
        let mut matching = all_items
            .iter()
            .filter(|item| {
                item.sequence > cursor
                    && request
                        .before_sequence
                        .is_none_or(|before| item.sequence < before)
            })
            .cloned()
            .collect::<Vec<_>>();
        if request.before_sequence.is_some() && matching.len() > limit {
            matching = matching.split_off(matching.len() - limit);
        } else {
            matching.truncate(limit);
        }
        let previous_cursor = matching.first().and_then(|first| {
            all_items
                .iter()
                .any(|item| item.sequence < first.sequence)
                .then(|| first.sequence.to_string())
        });
        let next_cursor = matching.last().and_then(|last| {
            all_items
                .iter()
                .any(|item| item.sequence > last.sequence)
                .then(|| last.sequence.to_string())
        });
        let runs = run_summaries_from_items(&thread, &all_items);
        let active_run = runs.iter().find(|run| run.active).cloned();
        let latest_checkpoint = latest_checkpoint_from_items(&thread.thread_id, &all_items);
        let turn_items = active_run
            .as_ref()
            .map(|run| {
                turn_items_from_thread_items(
                    &all_items,
                    thread.session_key.as_deref().unwrap_or_default(),
                    &run.run_id,
                )
            })
            .unwrap_or_default();
        let children = state
            .threads
            .iter()
            .filter(|candidate| {
                candidate.parent_thread_id.as_deref() == Some(thread.thread_id.as_str())
            })
            .map(Into::into)
            .collect();
        Ok(ThreadSnapshot {
            thread,
            items: matching,
            runs,
            active_run,
            latest_checkpoint,
            children,
            turn_items,
            child_activities: child_activities(&state, &request.thread_id),
            pagination: ThreadPagination {
                cursor: cursor.to_string(),
                limit,
                item_count,
                previous_cursor: previous_cursor.clone(),
                next_cursor: next_cursor.clone(),
                has_more_before: previous_cursor.is_some(),
                has_more_after: next_cursor.is_some(),
            },
            next_cursor,
        })
    }

    fn resume_thread(
        &self,
        request: ResumeThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        {
            let mut state = self.lock()?;
            let record = state
                .threads
                .iter_mut()
                .find(|thread| thread.thread_id == request.thread_id)
                .ok_or_else(|| unknown_thread_error(&request.thread_id))?;
            if record.status == ThreadStatus::Archived {
                record.status = if record.metadata.item_count == 0 {
                    ThreadStatus::Empty
                } else {
                    ThreadStatus::Idle
                };
                record.archived_at = None;
                record.updated_at = now_timestamp();
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
            limit: Some(MAX_READ_LIMIT),
        })?;
        Ok(ThreadStatusResult {
            thread: snapshot.thread,
            active_run: snapshot.active_run,
            latest_checkpoint: snapshot.latest_checkpoint,
            runs: snapshot.runs,
            children: snapshot.children,
            turn_items: snapshot.turn_items,
            child_activities: snapshot.child_activities,
        })
    }

    fn list_threads(
        &self,
        request: ListThreadsRequest,
    ) -> Result<ListThreadsResult, WorkerProtocolError> {
        let state = self.lock()?;
        let mut threads = state
            .threads
            .iter()
            .filter(|thread| request.include_archived || thread.archived_at.is_none())
            .filter(|thread| {
                request.include_child_threads
                    || request.parent_thread_id.is_some()
                    || request.ancestor_thread_id.is_some()
                    || thread.parent_thread_id.is_none()
            })
            .filter(|thread| thread_matches_list_filters(thread, &state.threads, &request))
            .cloned()
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
        });
        let total = threads.len();
        let offset = request.offset.unwrap_or(0).min(total);
        let limit = bounded_limit(request.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        let threads = threads
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let next_offset = (offset + threads.len() < total).then_some(offset + threads.len());
        Ok(ListThreadsResult {
            threads,
            total,
            next_offset,
        })
    }

    fn search_threads(
        &self,
        request: SearchThreadsRequest,
    ) -> Result<SearchThreadsResult, WorkerProtocolError> {
        let query = request.query.trim().to_ascii_lowercase();
        let list_request = ListThreadsRequest {
            include_archived: request.include_archived,
            include_child_threads: request.include_child_threads,
            parent_thread_id: request.parent_thread_id.clone(),
            ancestor_thread_id: request.ancestor_thread_id.clone(),
            offset: None,
            limit: Some(MAX_LIST_LIMIT),
        };
        let state = self.lock()?;
        let mut threads = state
            .threads
            .iter()
            .filter(|thread| request.include_archived || thread.archived_at.is_none())
            .filter(|thread| {
                request.include_child_threads
                    || request.parent_thread_id.is_some()
                    || request.ancestor_thread_id.is_some()
                    || thread.parent_thread_id.is_none()
            })
            .filter(|thread| thread_matches_list_filters(thread, &state.threads, &list_request))
            .filter(|thread| {
                thread_matches_query(thread, &query)
                    || state
                        .items
                        .get(&thread.thread_id)
                        .is_some_and(|items| thread_items_match_query(items, &query))
            })
            .cloned()
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        threads.truncate(bounded_limit(
            request.limit,
            DEFAULT_SEARCH_LIMIT,
            MAX_SEARCH_LIMIT,
        ));
        Ok(SearchThreadsResult {
            query: request.query,
            threads,
        })
    }

    fn update_thread_metadata(
        &self,
        thread_id: &str,
        patch: ThreadMetadataPatch,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let mut state = self.lock()?;
        let record = state
            .threads
            .iter_mut()
            .find(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        apply_metadata_patch(record, patch);
        record.updated_at = now_timestamp();
        Ok(record.clone())
    }

    fn update_thread_session_key(
        &self,
        thread_id: &str,
        session_key: String,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        let mut state = self.lock()?;
        let session_key = session_key.trim().to_string();
        if session_key.is_empty() {
            return Err(invalid_thread_request(
                "field must not be empty",
                serde_json::json!({ "field": "sessionKey" }),
            ));
        }
        if state.threads.iter().any(|thread| {
            thread.thread_id != thread_id
                && thread.session_key.as_deref() == Some(session_key.as_str())
        }) {
            return Err(invalid_thread_request(
                "session key is already assigned to another thread",
                serde_json::json!({ "threadId": thread_id, "sessionKey": session_key }),
            ));
        }
        let record = state
            .threads
            .iter_mut()
            .find(|thread| thread.thread_id == thread_id)
            .ok_or_else(|| unknown_thread_error(thread_id))?;
        record.session_key = Some(session_key);
        record.updated_at = now_timestamp();
        Ok(record.clone())
    }

    fn archive_thread(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.archive_thread_with_children(thread_id, archived, false)
    }

    fn archive_thread_with_children(
        &self,
        thread_id: &str,
        archived: bool,
        archive_children: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        MemoryThreadStore::archive_thread_with_children(self, thread_id, archived, archive_children)
    }

    fn delete_thread(
        &self,
        request: DeleteThreadRequest,
    ) -> Result<DeleteThreadResult, WorkerProtocolError> {
        let mut state = self.lock()?;
        let Some(_) = state
            .threads
            .iter()
            .find(|thread| thread.thread_id == request.thread_id)
        else {
            return Ok(DeleteThreadResult {
                thread_id: request.thread_id,
                deleted: false,
                deleted_children: Vec::new(),
            });
        };
        let index = ThreadIndex {
            threads: state.threads.clone(),
        };
        let deleted_children = descendant_thread_ids(&index, &request.thread_id);
        if !request.delete_children && !deleted_children.is_empty() {
            return Err(invalid_thread_request(
                "thread has child threads; pass deleteChildren to delete the tree",
                serde_json::json!({
                    "threadId": request.thread_id,
                    "childThreadIds": deleted_children,
                }),
            ));
        }
        let mut deleted_ids = if request.delete_children {
            deleted_children.clone()
        } else {
            Vec::new()
        };
        deleted_ids.push(request.thread_id.clone());
        state
            .threads
            .retain(|thread| !deleted_ids.contains(&thread.thread_id));
        for thread_id in &deleted_ids {
            state.items.remove(thread_id);
        }
        Ok(DeleteThreadResult {
            thread_id: request.thread_id,
            deleted: true,
            deleted_children,
        })
    }

    fn fork_thread(&self, request: ForkThreadRequest) -> Result<ThreadRecord, WorkerProtocolError> {
        let mut state = self.lock()?;
        if let Some(client_event_id) =
            normalized_client_event_id(request.client_event_id.as_deref())
        {
            if let Some(thread_id) = state
                .client_forks
                .get(&(request.thread_id.clone(), client_event_id.to_string()))
            {
                return state
                    .threads
                    .iter()
                    .find(|thread| thread.thread_id == *thread_id)
                    .cloned()
                    .ok_or_else(|| unknown_thread_error(thread_id));
            }
        }
        let source = state
            .threads
            .iter()
            .find(|thread| thread.thread_id == request.thread_id)
            .cloned()
            .ok_or_else(|| unknown_thread_error(&request.thread_id))?;
        let source_index = ThreadIndex {
            threads: state.threads.clone(),
        };
        let source_items = state
            .items
            .get(&source.thread_id)
            .cloned()
            .unwrap_or_default();
        let fork_after_sequence = request.fork_after_sequence.unwrap_or(u64::MAX);
        let mut copied_items = source_items
            .iter()
            .filter(|item| item.sequence <= fork_after_sequence)
            .filter(|item| {
                request.include_checkpoints
                    || !matches!(item.kind, super::ThreadItemKind::CheckpointCreated(_))
            })
            .filter(|item| {
                super::fork::context_compaction_survives_fork(
                    item,
                    &source_items,
                    fork_after_sequence,
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        let thread_id = generate_thread_id();
        for item in &mut copied_items {
            item.thread_id = thread_id.clone();
        }
        let timestamp = now_timestamp();
        let mut forked = source.clone();
        forked.thread_id = thread_id.clone();
        forked.session_key = Some(thread_id.clone());
        forked.title = request
            .title
            .unwrap_or_else(|| format!("{} (fork)", source.title));
        forked.parent_thread_id = Some(source.thread_id.clone());
        forked.source = "fork".to_string();
        forked.active_run_id = None;
        forked.created_at = timestamp.clone();
        forked.updated_at = timestamp.clone();
        forked.archived_at = None;
        forked.status = if copied_items.is_empty() {
            ThreadStatus::Empty
        } else {
            ThreadStatus::Idle
        };
        forked.metadata.has_active_run = false;
        forked.metadata.last_activity_at = Some(timestamp);
        if !forked.metadata.extra.is_object() {
            forked.metadata.extra = Value::Object(Default::default());
        }
        forked.metadata.extra["forkedFromThreadId"] = Value::String(source.thread_id.clone());
        if let Some(client_event_id) =
            normalized_client_event_id(request.client_event_id.as_deref())
        {
            forked.metadata.extra["forkClientEventId"] = Value::String(client_event_id.to_string());
        }
        recompute_dynamic_metadata(&mut forked, &copied_items);
        state.items.insert(thread_id.clone(), copied_items);
        state.threads.push(forked.clone());
        if request.include_children {
            let mut fork_ids =
                HashMap::from([(source.thread_id.clone(), forked.thread_id.clone())]);
            for source_child_id in descendant_thread_ids(&source_index, &source.thread_id) {
                let source_child = source_index
                    .threads
                    .iter()
                    .find(|thread| thread.thread_id == source_child_id)
                    .cloned()
                    .ok_or_else(|| unknown_thread_error(&source_child_id))?;
                let parent_thread_id = source_child
                    .parent_thread_id
                    .as_ref()
                    .and_then(|parent_id| fork_ids.get(parent_id))
                    .cloned()
                    .ok_or_else(|| {
                        invalid_thread_request(
                            "forked child parent projection is missing",
                            serde_json::json!({
                                "threadId": source_child.thread_id,
                                "parentThreadId": source_child.parent_thread_id,
                            }),
                        )
                    })?;
                let child_thread_id = generate_thread_id();
                let mut child_items = state
                    .items
                    .get(&source_child.thread_id)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|item| {
                        request.include_checkpoints
                            || !matches!(item.kind, super::ThreadItemKind::CheckpointCreated(_))
                    })
                    .collect::<Vec<_>>();
                for item in &mut child_items {
                    item.thread_id = child_thread_id.clone();
                }
                let mut child = source_child.clone();
                child.thread_id = child_thread_id.clone();
                child.session_key = Some(child_thread_id.clone());
                child.parent_thread_id = Some(parent_thread_id);
                child.active_run_id = None;
                child.created_at = now_timestamp();
                child.updated_at = child.created_at.clone();
                child.archived_at = None;
                child.status = if child_items.is_empty() {
                    ThreadStatus::Empty
                } else {
                    ThreadStatus::Idle
                };
                child.metadata.has_active_run = false;
                child.metadata.last_activity_at = Some(child.updated_at.clone());
                if !child.metadata.extra.is_object() {
                    child.metadata.extra = Value::Object(Default::default());
                }
                child.metadata.extra["forkedFromThreadId"] =
                    Value::String(source_child.thread_id.clone());
                recompute_dynamic_metadata(&mut child, &child_items);
                fork_ids.insert(source_child.thread_id, child_thread_id.clone());
                state.items.insert(child_thread_id, child_items);
                state.threads.push(child);
            }
        }
        if let Some(client_event_id) =
            normalized_client_event_id(request.client_event_id.as_deref())
        {
            state
                .client_forks
                .insert((request.thread_id, client_event_id.to_string()), thread_id);
        }
        Ok(forked)
    }

    fn append_items(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.append_items_with_client_event_id(thread_id, items, None)
    }

    fn append_items_with_client_event_id(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        MemoryThreadStore::append_items_with_client_event_id(
            self,
            thread_id,
            items,
            client_event_id,
        )
    }

    fn client_event_items(
        &self,
        thread_id: &str,
        client_event_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError> {
        MemoryThreadStore::client_event_items(self, thread_id, client_event_id)
    }
}

fn normalized_client_event_id(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn child_activities(state: &MemoryThreadState, thread_id: &str) -> Vec<ThreadChildActivity> {
    let mut activities = state
        .threads
        .iter()
        .filter(|thread| {
            thread.parent_thread_id.as_deref() == Some(thread_id)
                && thread.status != ThreadStatus::Archived
                && thread.active_run_id.is_some()
        })
        .map(|child| {
            let items = state
                .items
                .get(&child.thread_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let runs = run_summaries_from_items(child, items);
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
                    item_count: u64::try_from(items.len()).unwrap_or(u64::MAX),
                    active: true,
                })
            });
            let turn_items = active_run
                .as_ref()
                .map(|run| {
                    turn_items_from_thread_items(
                        items,
                        child.session_key.as_deref().unwrap_or_default(),
                        &run.run_id,
                    )
                })
                .unwrap_or_default();
            ThreadChildActivity {
                child: ThreadChildSummary::from(child),
                active_run,
                turn_items,
            }
        })
        .collect::<Vec<_>>();
    activities.sort_by(|left, right| {
        right
            .child
            .updated_at
            .cmp(&left.child.updated_at)
            .then_with(|| left.child.thread_id.cmp(&right.child.thread_id))
    });
    activities
}
