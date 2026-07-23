use super::{
    replay_thread, replay_thread_transcript, thread_checkpoint_from_item,
    thread_items_from_effective_rollout, thread_meta_from_lines, turn, EventKind, ThreadLogItem,
    ThreadLogLine, ThreadMeta, ThreadReplay,
};
use crate::protocol::WorkerProtocolError;
use crate::threads::domain::{ThreadCheckpoint, ThreadItem};
use crate::threads::session::AgentTurnRecord;

#[derive(Clone, Debug)]
pub(super) struct CanonicalRolloutReconstruction {
    pub(super) semantic: ThreadReplay,
    pub(super) transcript: ThreadReplay,
    pub(super) meta: ThreadMeta,
    pub(super) thread_items: Vec<ThreadItem>,
    pub(super) turns: Vec<AgentTurnRecord>,
    pub(super) checkpoints: Vec<ThreadCheckpoint>,
    pub(super) active_turn: bool,
}

pub(super) fn reconstruct_canonical_rollout(
    lines: &[ThreadLogLine],
) -> Result<CanonicalRolloutReconstruction, WorkerProtocolError> {
    let meta = thread_meta_from_lines(lines)?;
    let thread_id = meta.thread_id.clone();
    let session_id = meta.session_id.clone().unwrap_or_else(|| thread_id.clone());
    let semantic = replay_thread(lines)?;
    let transcript = replay_thread_transcript(lines)?;
    let effective_lines = semantic
        .effective_line_indexes
        .iter()
        .map(|index| lines[*index].clone())
        .collect::<Vec<_>>();
    let turns = turn::turn_records_from_lines(&session_id, &thread_id, &effective_lines)?;
    let thread_items =
        thread_items_from_effective_rollout(lines, &semantic.effective_line_indexes, &thread_id)?;
    let active_turn = effective_lines.iter().fold(false, |active, line| {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            return active;
        };
        match event.kind() {
            kind if kind.starts_turn() => true,
            kind if kind.ends_turn() => false,
            EventKind::UserMessage
            | EventKind::ThreadRolledBack
            | EventKind::TokenCount
            | EventKind::MetadataUpdated
            | EventKind::SessionCleared
            | EventKind::SessionTrimmed
            | EventKind::ThreadItem
            | EventKind::TurnCheckpointSet
            | EventKind::TurnCheckpointClear => active,
            EventKind::TurnStarted
            | EventKind::TaskStarted
            | EventKind::TurnComplete
            | EventKind::TaskComplete
            | EventKind::TurnAborted => unreachable!("turn boundaries handled above"),
        }
    });
    let checkpoints = thread_items
        .iter()
        .filter_map(|item| thread_checkpoint_from_item(&thread_id, item))
        .collect();
    Ok(CanonicalRolloutReconstruction {
        semantic,
        transcript,
        meta,
        thread_items,
        turns,
        checkpoints,
        active_turn,
    })
}

#[cfg(test)]
#[path = "reconstruction_tests.rs"]
mod tests;
