use super::local_store::{LocalThreadStore, ThreadStore};
use super::types::{
    ListThreadsRequest, ListThreadsResult, ReadThreadRequest, SearchThreadsRequest,
    SearchThreadsResult, ThreadIdParams, ThreadItem, ThreadItemKind, ThreadMetadata, ThreadRecord,
    ThreadStatus, ThreadStatusResult,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_session::{SessionHistoryProjection, SessionMetadata};
use serde_json::{json, Value};
use std::collections::HashSet;

const SESSION_ADAPTER_LIST_LIMIT: usize = 1000;
const DEFAULT_LIST_LIMIT: usize = 100;
const MAX_LIST_LIMIT: usize = 500;
const DEFAULT_SEARCH_LIMIT: usize = 25;
const MAX_SEARCH_LIMIT: usize = 100;
const LEGACY_SESSION_PROJECTION_SOURCE: &str = "legacy_session_projection";
const THREAD_METADATA_PROJECTION_SOURCE: &str = "thread.metadata_projection";

pub fn list_session_metadata_with_threads(
    store: &LocalThreadStore,
    sessions: &[SessionMetadata],
) -> Result<Vec<SessionMetadata>, WorkerProtocolError> {
    let mut projected = sessions.to_vec();
    let mut known_session_ids = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect::<HashSet<_>>();

    for thread in store.list_all_thread_records(false)? {
        let session_id = thread
            .session_key
            .clone()
            .unwrap_or_else(|| thread.thread_id.clone());
        if known_session_ids.insert(session_id.clone()) {
            projected.push(project_thread_metadata(&thread, session_id));
        }
    }

    projected.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(projected)
}

pub fn get_session_metadata_from_threads(
    store: &LocalThreadStore,
    session_id: &str,
) -> Result<Option<SessionMetadata>, WorkerProtocolError> {
    let Some(thread) = find_thread_for_session(store, session_id)? else {
        return Ok(None);
    };
    Ok(Some(project_thread_metadata(
        &thread,
        session_id.to_string(),
    )))
}

pub fn get_session_history_from_threads(
    store: &LocalThreadStore,
    session_id: &str,
    limit: usize,
) -> Result<Option<SessionHistoryProjection>, WorkerProtocolError> {
    let Some(thread) = find_thread_for_session(store, session_id)? else {
        return Ok(None);
    };
    let snapshot = store.read_thread(ReadThreadRequest {
        thread_id: thread.thread_id.clone(),
        cursor: None,
        before_sequence: Some(u64::MAX),
        checkpoint_sequence: None,
        checkpoint_id: None,
        limit: Some(MAX_LIST_LIMIT),
    })?;
    let mut messages = snapshot
        .items
        .iter()
        .filter_map(thread_item_to_session_message)
        .collect::<Vec<_>>();
    if limit == 0 {
        messages.clear();
    } else if messages.len() > limit {
        let start = messages.len() - limit;
        messages = messages.split_off(start);
    }
    attach_thread_token_usage_to_history(&mut messages, &snapshot.thread.metadata);
    let updated_at = snapshot
        .items
        .iter()
        .rev()
        .find_map(|item| non_empty_string(&item.created_at))
        .unwrap_or_else(|| {
            thread
                .metadata
                .last_activity_at
                .clone()
                .unwrap_or_else(|| thread.updated_at.clone())
        });
    Ok(Some(SessionHistoryProjection {
        session_id: session_id.to_string(),
        messages,
        user_profile: json!({}),
        updated_at,
        context_checkpoint: None,
    }))
}

pub fn get_agent_context_from_threads(
    store: &LocalThreadStore,
    session_id: &str,
    limit: usize,
) -> Result<Option<SessionHistoryProjection>, WorkerProtocolError> {
    let Some(thread) = find_thread_for_session(store, session_id)? else {
        return Ok(None);
    };
    let items = store.context_items(&thread.thread_id)?;
    let checkpoint = items
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, item)| match &item.kind {
            ThreadItemKind::ContextCompaction(payload) => {
                context_checkpoint(payload).and_then(|checkpoint| {
                    context_checkpoint_replacement(checkpoint)
                        .map(|replacement| (index, replacement, checkpoint.clone()))
                })
            }
            _ => None,
        });

    let has_checkpoint = checkpoint.is_some();
    let context_checkpoint = checkpoint
        .as_ref()
        .map(|(_, _, checkpoint)| checkpoint.clone());
    let mut messages = if let Some((checkpoint_index, mut replacement, _)) = checkpoint {
        let suffix = items[checkpoint_index + 1..]
            .iter()
            .filter_map(thread_item_to_session_message)
            .collect::<Vec<_>>();
        let overlap = replacement_suffix_overlap(&replacement, &suffix);
        replacement.extend(suffix.into_iter().skip(overlap));
        replacement
    } else {
        items
            .iter()
            .filter_map(thread_item_to_session_message)
            .collect::<Vec<_>>()
    };
    if !has_checkpoint && messages.len() > limit {
        messages = messages.split_off(messages.len() - limit);
    }
    let updated_at = items
        .last()
        .and_then(|item| non_empty_string(&item.created_at))
        .unwrap_or_else(|| thread.updated_at.clone());
    Ok(Some(SessionHistoryProjection {
        session_id: session_id.to_string(),
        messages,
        user_profile: json!({}),
        updated_at,
        context_checkpoint,
    }))
}

fn context_checkpoint(payload: &Value) -> Option<&Value> {
    let checkpoint = payload
        .get("payload")
        .and_then(|payload| payload.get("contextCheckpoint"))
        .or_else(|| payload.get("contextCheckpoint"))
        .unwrap_or(payload);
    context_checkpoint_replacement(checkpoint).map(|_| checkpoint)
}

fn context_checkpoint_replacement(checkpoint: &Value) -> Option<Vec<Value>> {
    checkpoint
        .get("replacementHistory")
        .or_else(|| checkpoint.get("replacement_history"))
        .or_else(|| checkpoint.get("installedReplacementHistory"))
        .or_else(|| checkpoint.get("installed_replacement_history"))
        .and_then(Value::as_array)
        .cloned()
}

fn replacement_suffix_overlap(replacement: &[Value], suffix: &[Value]) -> usize {
    let max_overlap = replacement.len().min(suffix.len());
    (1..=max_overlap)
        .rev()
        .find(|overlap| {
            replacement[replacement.len() - *overlap..]
                .iter()
                .zip(suffix[..*overlap].iter())
                .all(|(left, right)| context_messages_equivalent(left, right))
        })
        .unwrap_or(0)
}

fn context_messages_equivalent(left: &Value, right: &Value) -> bool {
    left.get("role") == right.get("role")
        && left.get("content") == right.get("content")
        && aliased_context_field(left, "tool_calls", "toolCalls")
            == aliased_context_field(right, "tool_calls", "toolCalls")
        && aliased_context_field(left, "tool_call_id", "toolCallId")
            == aliased_context_field(right, "tool_call_id", "toolCallId")
}

fn aliased_context_field<'a>(message: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    message.get(snake).or_else(|| message.get(camel))
}

pub fn get_session_checkpoint_from_threads(
    store: &LocalThreadStore,
    session_id: &str,
) -> Result<Option<Value>, WorkerProtocolError> {
    let Some(thread) = find_thread_for_session(store, session_id)? else {
        return Ok(None);
    };
    Ok(Some(
        store
            .get_thread_status(&thread.thread_id)?
            .latest_checkpoint
            .map(|checkpoint| checkpoint.restore_payload)
            .unwrap_or(Value::Null),
    ))
}

pub fn get_thread_status_with_legacy_sessions(
    store: &LocalThreadStore,
    params: ThreadIdParams,
    sessions: &[SessionMetadata],
) -> Result<ThreadStatusResult, WorkerProtocolError> {
    if let Some(session) = sessions
        .iter()
        .find(|session| legacy_projection_thread_id(&session.session_id) == params.thread_id)
    {
        return Ok(ThreadStatusResult {
            thread: project_session_metadata(session),
            active_run: None,
            latest_checkpoint: None,
            runs: Vec::new(),
            children: Vec::new(),
            turn_items: Vec::new(),
            child_activities: Vec::new(),
        });
    }
    store.get_thread_status(&params.thread_id)
}

pub fn list_threads_with_legacy_sessions(
    store: &LocalThreadStore,
    request: ListThreadsRequest,
    sessions: &[SessionMetadata],
) -> Result<ListThreadsResult, WorkerProtocolError> {
    let all_stored_threads = store.list_all_thread_records(true)?;
    let known_session_keys = known_session_keys(&all_stored_threads);
    let mut known_thread_ids = known_thread_ids(&all_stored_threads);
    let mut threads = all_stored_threads
        .iter()
        .filter(|thread| request.include_archived || thread.status != ThreadStatus::Archived)
        .filter(|thread| {
            store.thread_matches_list_request(thread, &all_stored_threads, &request)
                && (request.include_child_threads
                    || request.parent_thread_id.is_some()
                    || request.ancestor_thread_id.is_some()
                    || thread.parent_thread_id.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();

    if request.parent_thread_id.is_none() && request.ancestor_thread_id.is_none() {
        for session in sessions {
            if known_session_keys.contains(&session.session_id) {
                continue;
            }
            let projection = project_session_metadata(session);
            if known_thread_ids.insert(projection.thread_id.clone()) {
                threads.push(projection);
            }
        }
    }

    sort_thread_records(&mut threads);
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

pub fn search_threads_with_legacy_sessions(
    store: &LocalThreadStore,
    request: SearchThreadsRequest,
    sessions: &[SessionMetadata],
) -> Result<SearchThreadsResult, WorkerProtocolError> {
    let query = request.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(SearchThreadsResult {
            query: request.query,
            threads: Vec::new(),
        });
    }

    let all_stored_threads = store.list_all_thread_records(true)?;
    let known_session_keys = known_session_keys(&all_stored_threads);
    let mut known_thread_ids = known_thread_ids(&all_stored_threads);
    let mut threads = store
        .search_threads(SearchThreadsRequest {
            query: request.query.clone(),
            include_archived: request.include_archived,
            include_child_threads: request.include_child_threads,
            parent_thread_id: request.parent_thread_id.clone(),
            ancestor_thread_id: request.ancestor_thread_id.clone(),
            limit: Some(MAX_SEARCH_LIMIT),
        })?
        .threads;

    if request.parent_thread_id.is_none() && request.ancestor_thread_id.is_none() {
        for session in sessions {
            if known_session_keys.contains(&session.session_id) {
                continue;
            }
            let projection = project_session_metadata(session);
            if !legacy_session_matches(session, &projection, &query) {
                continue;
            }
            if known_thread_ids.insert(projection.thread_id.clone()) {
                threads.push(projection);
            }
        }
    }

    sort_thread_records(&mut threads);
    let limit = bounded_limit(request.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    Ok(SearchThreadsResult {
        query: request.query,
        threads: threads.into_iter().take(limit).collect(),
    })
}

pub fn read_thread_with_legacy_sessions(
    store: &LocalThreadStore,
    request: ReadThreadRequest,
    sessions: &[SessionMetadata],
) -> Result<super::types::ThreadSnapshot, WorkerProtocolError> {
    match store.read_thread(request.clone()) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            if let Some(snapshot) = read_legacy_session_projection(request, sessions)? {
                Ok(snapshot)
            } else {
                Err(error)
            }
        }
    }
}

pub fn archive_session_thread(
    store: &LocalThreadStore,
    session_id: &str,
) -> Result<Option<ThreadRecord>, WorkerProtocolError> {
    let Some(thread_id) = find_thread_id_for_session(store, session_id)? else {
        return Ok(None);
    };
    store.archive_thread(&thread_id, true).map(Some)
}

fn find_thread_id_for_session(
    store: &LocalThreadStore,
    session_id: &str,
) -> Result<Option<String>, WorkerProtocolError> {
    Ok(store
        .list_threads(ListThreadsRequest {
            include_archived: true,
            include_child_threads: false,
            parent_thread_id: None,
            ancestor_thread_id: None,
            offset: None,
            limit: Some(SESSION_ADAPTER_LIST_LIMIT),
        })?
        .threads
        .into_iter()
        .find(|thread| thread.session_key.as_deref() == Some(session_id))
        .map(|thread| thread.thread_id))
}

fn project_session_metadata(session: &SessionMetadata) -> ThreadRecord {
    let messages = session_messages(session);
    let message_count = messages.len() as u64;
    let preview = messages.iter().rev().find_map(message_preview);
    ThreadRecord {
        thread_id: legacy_projection_thread_id(&session.session_id),
        title: session_title(session),
        status: if message_count == 0 {
            ThreadStatus::Empty
        } else {
            ThreadStatus::Idle
        },
        session_key: Some(session.session_id.clone()),
        root_run_id: session
            .extra
            .get("last_persisted_run_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        active_run_id: None,
        parent_thread_id: None,
        source: LEGACY_SESSION_PROJECTION_SOURCE.to_string(),
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        archived_at: None,
        metadata: ThreadMetadata {
            preview,
            working_directory: non_empty_string(&session.workspace_dir),
            last_user_message_at: messages
                .iter()
                .rev()
                .find(|message| message_role(message) == Some("user"))
                .and_then(message_timestamp)
                .or_else(|| (message_count > 0).then(|| session.updated_at.clone())),
            last_assistant_message_at: messages
                .iter()
                .rev()
                .find(|message| message_role(message) == Some("assistant"))
                .and_then(message_timestamp),
            last_activity_at: Some(session.updated_at.clone()),
            item_count: message_count,
            extra: json!({
                "sessionId": session.session_id,
                "source": LEGACY_SESSION_PROJECTION_SOURCE,
                "legacySessionProjection": true,
                "sessionMetadata": session.extra.get("metadata").cloned().unwrap_or_else(|| json!({}))
            }),
            ..ThreadMetadata::default()
        },
    }
}

fn project_thread_metadata(thread: &ThreadRecord, session_id: String) -> SessionMetadata {
    SessionMetadata {
        session_id,
        title: thread.title.clone(),
        workspace_dir: thread
            .metadata
            .working_directory
            .clone()
            .unwrap_or_default(),
        created_at: thread.created_at.clone(),
        updated_at: thread
            .metadata
            .last_activity_at
            .clone()
            .unwrap_or_else(|| thread.updated_at.clone()),
        extra: json!({
            "threadId": thread.thread_id,
            "threadSource": thread.source,
            "source": THREAD_METADATA_PROJECTION_SOURCE,
            "metadata": thread.metadata.extra,
            "preview": thread.metadata.preview,
            "summary": thread.metadata.summary,
            "legacySessionProjection": false,
            "threadMetadataProjection": true
        }),
    }
}

fn read_legacy_session_projection(
    request: ReadThreadRequest,
    sessions: &[SessionMetadata],
) -> Result<Option<super::types::ThreadSnapshot>, WorkerProtocolError> {
    let Some(session) = sessions
        .iter()
        .find(|session| legacy_projection_thread_id(&session.session_id) == request.thread_id)
    else {
        return Ok(None);
    };
    let thread = project_session_metadata(session);
    let cursor = parse_legacy_projection_cursor(request.cursor.as_deref())?;
    let limit = bounded_limit(request.limit, 200, 1_000);
    let mut items = session_messages(session)
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let mut item =
                session_message_item(&session.session_id, "legacy-history", index, message);
            item.thread_id = thread.thread_id.clone();
            item.sequence = (index + 1) as u64;
            item.created_at =
                message_timestamp(message).unwrap_or_else(|| session.updated_at.clone());
            item
        })
        .filter(|item| {
            item.sequence > cursor
                && request
                    .before_sequence
                    .is_none_or(|before_sequence| item.sequence < before_sequence)
        })
        .collect::<Vec<_>>();
    items.sort_by_key(|item| item.sequence);
    let item_count = session_messages(session).len();
    let items = if request.before_sequence.is_some() && items.len() > limit {
        items.split_off(items.len() - limit)
    } else {
        items.truncate(limit);
        items
    };
    let all_sequences = 1..=(item_count as u64);
    let previous_cursor = items.first().and_then(|first| {
        all_sequences
            .clone()
            .any(|sequence| sequence < first.sequence)
            .then(|| first.sequence.to_string())
    });
    let next_cursor = items.last().and_then(|last| {
        all_sequences
            .clone()
            .any(|sequence| sequence > last.sequence)
            .then(|| last.sequence.to_string())
    });
    let has_more_before = previous_cursor.is_some();
    let has_more_after = next_cursor.is_some();
    Ok(Some(super::types::ThreadSnapshot {
        thread,
        items,
        runs: Vec::new(),
        active_run: None,
        latest_checkpoint: None,
        children: Vec::new(),
        turn_items: Vec::new(),
        child_activities: Vec::new(),
        pagination: super::types::ThreadPagination {
            cursor: cursor.to_string(),
            limit,
            item_count,
            previous_cursor,
            next_cursor: next_cursor.clone(),
            has_more_before,
            has_more_after,
        },
        next_cursor,
    }))
}

fn parse_legacy_projection_cursor(cursor: Option<&str>) -> Result<u64, WorkerProtocolError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor.parse::<u64>().map_err(|_| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid thread cursor",
            json!({ "cursor": cursor }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })
}

fn known_session_keys(threads: &[ThreadRecord]) -> HashSet<String> {
    threads
        .iter()
        .filter_map(|thread| thread.session_key.clone())
        .collect()
}

fn known_thread_ids(threads: &[ThreadRecord]) -> HashSet<String> {
    threads
        .iter()
        .map(|thread| thread.thread_id.clone())
        .collect()
}

fn sort_thread_records(threads: &mut [ThreadRecord]) {
    threads.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
}

fn find_thread_for_session(
    store: &LocalThreadStore,
    session_id: &str,
) -> Result<Option<ThreadRecord>, WorkerProtocolError> {
    Ok(store
        .list_all_thread_records(false)?
        .into_iter()
        .find(|thread| {
            thread.session_key.as_deref() == Some(session_id) || thread.thread_id == session_id
        }))
}

fn thread_item_to_session_message(item: &ThreadItem) -> Option<Value> {
    let (role, payload) = match &item.kind {
        ThreadItemKind::UserMessage(payload) => ("user", payload),
        ThreadItemKind::AssistantMessageCompleted(payload) => ("assistant", payload),
        _ => return None,
    };
    let mut message = json!({
        "role": role,
        "content": thread_item_content(payload),
        "timestamp": item.created_at
    });
    copy_optional_message_fields(
        payload,
        &mut message,
        &[
            "id",
            "messageId",
            "message_id",
            "usage",
            "tokenUsageInfo",
            "metadata",
            "references",
            "contextReferences",
            "context_references",
            "toolActivities",
            "tool_activities",
            "artifacts",
            "reasoningContent",
            "reasoning_content",
        ],
    );
    Some(message)
}

fn copy_optional_message_fields(payload: &Value, message: &mut Value, fields: &[&str]) {
    let Some(message_object) = message.as_object_mut() else {
        return;
    };
    for field in fields {
        if let Some(value) = payload.get(*field) {
            message_object.insert((*field).to_string(), value.clone());
        }
    }
}

fn attach_thread_token_usage_to_history(messages: &mut [Value], metadata: &ThreadMetadata) {
    if messages.is_empty() {
        return;
    }
    let Some(token_usage_info) = metadata
        .extra
        .get("tokenUsageInfo")
        .filter(|value| value.is_object())
    else {
        return;
    };
    let target_index = messages
        .iter()
        .rev()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .map(|reverse_index| messages.len() - 1 - reverse_index)
        .unwrap_or_else(|| messages.len() - 1);
    let target = &mut messages[target_index];
    if target.get("tokenUsageInfo").is_none() {
        target["tokenUsageInfo"] = token_usage_info.clone();
    }
    if target.get("usage").is_none() {
        if let Some(usage) = usage_from_token_usage_info(token_usage_info) {
            target["usage"] = usage;
        }
    }
}

fn usage_from_token_usage_info(token_usage_info: &Value) -> Option<Value> {
    let last = token_usage_info.get("lastTokenUsage")?;
    let total = token_usage_info.get("totalTokenUsage");
    let used_tokens = i64_field(last, "totalTokens")?;
    let context_window = i64_field(token_usage_info, "modelContextWindow");
    let remaining_tokens = context_window.map(|window| window.saturating_sub(used_tokens).max(0));
    let percent = context_window
        .filter(|window| *window > 0)
        .map(|window| ((used_tokens as f64 / window as f64) * 100.0).clamp(0.0, 100.0));
    Some(json!({
        "cachedTokens": i64_field(last, "cachedInputTokens"),
        "completionTokens": i64_field(last, "outputTokens"),
        "contextWindowRemainingTokens": remaining_tokens,
        "contextWindowTokens": context_window,
        "contextWindowUsedTokens": used_tokens,
        "estimatedContextTokens": used_tokens,
        "promptTokens": i64_field(last, "inputTokens"),
        "reasoningOutputTokens": i64_field(last, "reasoningOutputTokens"),
        "totalTokens": used_tokens,
        "cumulativeUsageTokens": total.and_then(|usage| i64_field(usage, "totalTokens")),
        "percent": percent,
    }))
}

fn i64_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|field| {
        field
            .as_i64()
            .or_else(|| field.as_u64().and_then(|number| i64::try_from(number).ok()))
    })
}

fn thread_item_content(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| payload.get("text").and_then(Value::as_str))
        .or_else(|| payload.as_str())
        .unwrap_or_default()
        .to_string()
}

fn bounded_limit(limit: Option<usize>, default: usize, max: usize) -> usize {
    limit.unwrap_or(default).clamp(1, max)
}

fn session_messages(session: &SessionMetadata) -> &[Value] {
    session
        .extra
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn session_title(session: &SessionMetadata) -> String {
    non_empty_string(&session.title).unwrap_or_else(|| "New session".to_string())
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn message_timestamp(message: &Value) -> Option<String> {
    message
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn message_preview(message: &Value) -> Option<String> {
    message
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| message.get("text").and_then(Value::as_str))
        .and_then(non_empty_string)
}

fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn legacy_projection_thread_id(session_id: &str) -> String {
    let suffix = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
            {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let suffix = if suffix.trim_matches('_').is_empty() {
        "session".to_string()
    } else {
        suffix
    };
    let prefix = "legacy-session-";
    let suffix = suffix
        .chars()
        .take(128usize.saturating_sub(prefix.len()))
        .collect::<String>();
    format!("{prefix}{suffix}")
}

fn legacy_projection_matches(thread: &ThreadRecord, query: &str) -> bool {
    let candidates = [
        Some(thread.thread_id.as_str()),
        Some(thread.title.as_str()),
        thread.session_key.as_deref(),
        Some(thread.source.as_str()),
        thread.metadata.preview.as_deref(),
        thread.metadata.summary.as_deref(),
        thread.metadata.model.as_deref(),
        thread.metadata.working_directory.as_deref(),
    ];
    candidates
        .iter()
        .flatten()
        .any(|candidate| candidate.to_lowercase().contains(query))
        || thread
            .metadata
            .tags
            .iter()
            .any(|tag| tag.to_lowercase().contains(query))
        || thread
            .metadata
            .extra
            .to_string()
            .to_lowercase()
            .contains(query)
}

fn legacy_session_matches(session: &SessionMetadata, thread: &ThreadRecord, query: &str) -> bool {
    legacy_projection_matches(thread, query)
        || session_messages(session).iter().any(|message| {
            message
                .get("content")
                .and_then(Value::as_str)
                .or_else(|| message.get("text").and_then(Value::as_str))
                .is_some_and(|text| text.to_lowercase().contains(query))
        })
}

fn session_message_item(
    session_id: &str,
    run_id: &str,
    index: usize,
    message: &Value,
) -> ThreadItem {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("message");
    ThreadItem {
        item_id: format!("legacy-session:{session_id}:{run_id}:message:{index}"),
        thread_id: String::new(),
        run_id: Some(run_id.to_string()),
        turn_id: Some(run_id.to_string()),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: thread_kind_for_session_message(role, message.clone()),
    }
}

fn thread_kind_for_session_message(role: &str, message: Value) -> ThreadItemKind {
    match role {
        "user" => ThreadItemKind::UserMessage(message),
        "assistant" => ThreadItemKind::AssistantMessageCompleted(message),
        "tool" => ThreadItemKind::ToolCallOutput(message),
        _ => ThreadItemKind::Event(json!({
            "eventName": "legacy_session.message",
            "payload": message
        })),
    }
}
