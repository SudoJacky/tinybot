use super::{non_empty_string, string_field};
use crate::worker_thread::types::{ThreadCheckpoint, ThreadItem, ThreadItemKind};

pub(super) fn latest_checkpoint_from_items(
    thread_id: &str,
    items: &[ThreadItem],
) -> Option<ThreadCheckpoint> {
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

pub(super) fn checkpoint_from_item(thread_id: &str, item: &ThreadItem) -> Option<ThreadCheckpoint> {
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

fn is_terminal_run_item(item: &ThreadItem) -> bool {
    matches!(
        item.kind,
        ThreadItemKind::AgentRunCompleted(_)
            | ThreadItemKind::Error(_)
            | ThreadItemKind::Cancelled(_)
    )
}
