use crate::threads::domain::types::{ThreadItem, ThreadItemKind};

pub(super) fn context_compaction_survives_fork(
    item: &ThreadItem,
    source_items: &[ThreadItem],
    fork_after_sequence: u64,
) -> bool {
    if !matches!(item.kind, ThreadItemKind::ContextCompaction(_)) {
        return true;
    }
    let same_compaction_segment = |candidate: &ThreadItem| candidate.turn_id == item.turn_id;
    !source_items.iter().any(|candidate| {
        candidate.sequence > fork_after_sequence && same_compaction_segment(candidate)
    })
}
