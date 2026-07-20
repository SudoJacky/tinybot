use super::checkpoint::checkpoint_from_item;
use super::index::ThreadIndex;
use super::invalid_thread_request;
use crate::worker_protocol::WorkerProtocolError;
use crate::worker_thread::types::{
    ListThreadsRequest, ReadThreadRequest, ThreadItem, ThreadRecord,
};

pub(super) fn thread_matches_query(thread: &ThreadRecord, query: &str) -> bool {
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

pub(super) fn items_match_query(items: &[ThreadItem], query: &str) -> bool {
    items.iter().any(|item| {
        serde_json::to_string(item)
            .unwrap_or_default()
            .to_lowercase()
            .contains(query)
    })
}

pub(super) fn read_cursor_from_request(
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

pub(super) fn bounded_limit(limit: Option<usize>, default: usize, max: usize) -> usize {
    limit.unwrap_or(default).max(1).min(max)
}

pub(super) fn thread_matches_list_filters(
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

pub(super) fn descendant_thread_ids(index: &ThreadIndex, thread_id: &str) -> Vec<String> {
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

pub(super) fn parse_sequence_cursor(cursor: Option<&str>) -> Result<u64, WorkerProtocolError> {
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
