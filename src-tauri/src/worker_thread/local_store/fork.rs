use super::checkpoint::is_checkpoint_item;
use super::metadata::set_metadata_extra_string;
use super::query::descendant_thread_ids;
use super::{
    generate_thread_id, now_timestamp, unknown_thread_error, validate_thread_id, LocalThreadStore,
    ThreadStore, CLIENT_FORK_THREAD_IDS_KEY, MAX_READ_LIMIT,
};
use crate::worker_protocol::WorkerProtocolError;
use crate::worker_thread::types::{
    ForkThreadRequest, ReadThreadRequest, ThreadItem, ThreadItemKind, ThreadMetadata, ThreadRecord,
    ThreadStatus,
};
use serde_json::Value;
use std::collections::HashMap;

pub(super) fn fork_thread(
    store: &LocalThreadStore,
    request: ForkThreadRequest,
) -> Result<ThreadRecord, WorkerProtocolError> {
    validate_thread_id(&request.thread_id)?;
    let source = store.read_thread(ReadThreadRequest {
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
    let mut index = store.read_index()?;
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
    record.session_key = Some(fork_id.clone());
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
    set_metadata_extra_string(
        &mut record.metadata.extra,
        "forkedFromThreadId",
        &source.thread.thread_id,
    );

    let fork_after_sequence = request.fork_after_sequence.unwrap_or(u64::MAX);
    let source_items = store.read_items(&source.thread.thread_id)?;
    let mut items = source_items
        .iter()
        .filter(|item| item.sequence <= fork_after_sequence)
        .filter(|item| request.include_checkpoints || !is_checkpoint_item(item))
        .filter(|item| context_compaction_survives_fork(item, &source_items, fork_after_sequence))
        .cloned()
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
            copied_child.session_key = Some(copied_child_id.clone());
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
            set_metadata_extra_string(
                &mut copied_child.metadata.extra,
                "forkedFromThreadId",
                &child.thread_id,
            );
            let mut copied_items = store
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
    store.write_index(&index)?;
    store.write_items(&fork_id, &items)?;
    for (thread_id, items) in forked_child_items {
        store.write_items(&thread_id, &items)?;
    }
    Ok(record)
}

pub(super) fn context_compaction_survives_fork(
    item: &ThreadItem,
    source_items: &[ThreadItem],
    fork_after_sequence: u64,
) -> bool {
    if !matches!(item.kind, ThreadItemKind::ContextCompaction(_)) {
        return true;
    }
    // Canonical compaction items can carry the owning run's finalized replacement history.
    // Dropping a later item from that run must also invalidate the earlier checkpoint, otherwise
    // the fork would inherit model context from after its requested sequence.
    let same_compaction_segment =
        |candidate: &ThreadItem| match (item.run_id.as_deref(), item.turn_id.as_deref()) {
            (Some(run_id), _) => candidate.run_id.as_deref() == Some(run_id),
            (None, Some(turn_id)) => candidate.turn_id.as_deref() == Some(turn_id),
            (None, None) => true,
        };
    !source_items.iter().any(|candidate| {
        candidate.sequence > fork_after_sequence && same_compaction_segment(candidate)
    })
}

fn client_fork_thread_id(metadata: &ThreadMetadata, client_event_id: &str) -> Option<String> {
    metadata
        .extra
        .get(CLIENT_FORK_THREAD_IDS_KEY)
        .and_then(Value::as_object)
        .and_then(|values| values.get(client_event_id))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
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
