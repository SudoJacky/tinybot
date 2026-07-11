use super::index::ThreadIndex;
use super::{
    apply_metadata_patch, bounded_limit, descendant_thread_ids, generate_item_id,
    generate_thread_id, invalid_thread_request, latest_checkpoint_from_items, now_timestamp,
    read_cursor_from_request, recompute_dynamic_metadata, run_summaries_from_items,
    thread_items_match_query, thread_matches_list_filters, thread_matches_query,
    turn_items_from_thread_items, unknown_thread_error, validate_thread_id,
    AppendThreadItemsResult, CreateThreadRequest, DeleteThreadRequest, DeleteThreadResult,
    ForkThreadRequest, ListThreadsRequest, ListThreadsResult, ReadThreadRequest,
    ResumeThreadRequest, SearchThreadsRequest, SearchThreadsResult, ThreadItem, ThreadMetadata,
    ThreadMetadataPatch, ThreadPagination, ThreadRecord, ThreadSnapshot, ThreadStatus,
    ThreadStatusResult, ThreadStore, DEFAULT_LIST_LIMIT, DEFAULT_READ_LIMIT, DEFAULT_SEARCH_LIMIT,
    DEFAULT_THREAD_TITLE, MAX_LIST_LIMIT, MAX_READ_LIMIT, MAX_SEARCH_LIMIT,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
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
            version: 1,
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
            source: request.source.unwrap_or_else(|| "memory".to_string()),
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
                    &run.run_id,
                    thread.session_key.as_deref().unwrap_or_default(),
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
            child_activities: Vec::new(),
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
            .filter(|thread| request.include_child_threads || thread.parent_thread_id.is_none())
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
            .filter(|thread| request.include_child_threads || thread.parent_thread_id.is_none())
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
            version: 1,
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
        let mut copied_items = state
            .items
            .get(&source.thread_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                request
                    .fork_after_sequence
                    .is_none_or(|seq| item.sequence <= seq)
            })
            .filter(|item| {
                request.include_checkpoints
                    || !matches!(item.kind, super::ThreadItemKind::CheckpointCreated(_))
            })
            .collect::<Vec<_>>();
        let thread_id = generate_thread_id();
        for item in &mut copied_items {
            item.thread_id = thread_id.clone();
        }
        let timestamp = now_timestamp();
        let mut forked = source.clone();
        forked.thread_id = thread_id.clone();
        forked.title = request
            .title
            .unwrap_or_else(|| format!("{} (fork)", source.title));
        forked.parent_thread_id = Some(source.thread_id.clone());
        forked.created_at = timestamp.clone();
        forked.updated_at = timestamp;
        forked.archived_at = None;
        forked.status = if copied_items.is_empty() {
            ThreadStatus::Empty
        } else {
            ThreadStatus::Idle
        };
        recompute_dynamic_metadata(&mut forked, &copied_items);
        state.items.insert(thread_id.clone(), copied_items);
        state.threads.push(forked.clone());
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
