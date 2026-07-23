use crate::threads::domain::types::{ThreadItem, ThreadItemKind};

pub(super) fn context_compaction_survives_fork(
    item: &ThreadItem,
    source_items: &[ThreadItem],
    fork_after_sequence: u64,
) -> bool {
    if !matches!(item.kind, ThreadItemKind::ContextCompaction(_)) {
        return true;
    }
    let same_compaction_segment =
        |candidate: &ThreadItem| match (item.turn_id.as_deref(), item.turn_id.as_deref()) {
            (Some(turn_id), _) => candidate.turn_id.as_deref() == Some(turn_id),
            (None, Some(turn_id)) => candidate.turn_id.as_deref() == Some(turn_id),
            (None, None) => true,
        };
    !source_items.iter().any(|candidate| {
        candidate.sequence > fork_after_sequence && same_compaction_segment(candidate)
    })
}
