use crate::threads::domain::types::{
    ThreadItem, ThreadItemKind, ThreadRecord, ThreadStatus, ThreadTurnSummary,
};
use serde_json::Value;

use super::string_field;

pub(crate) fn turn_summaries_from_items(
    thread: &ThreadRecord,
    items: &[ThreadItem],
) -> Vec<ThreadTurnSummary> {
    let mut turns = Vec::<ThreadTurnSummary>::new();
    for item in items {
        let turn_id = &item.turn_id;
        let position = turns
            .iter()
            .position(|turn| turn.turn_id == *turn_id)
            .unwrap_or_else(|| {
                turns.push(ThreadTurnSummary {
                    turn_id: turn_id.clone(),
                    status: ThreadStatus::Idle,
                    started_at: None,
                    updated_at: None,
                    completed_at: None,
                    model: None,
                    provider: None,
                    item_count: 0,
                    active: false,
                });
                turns.len() - 1
            });
        let turn = &mut turns[position];
        turn.item_count = turn.item_count.saturating_add(1);
        turn.updated_at = Some(item.created_at.clone());
        update_turn_summary_from_item(turn, item);
    }
    if turns.is_empty() {
        if let Some(turn_id) = thread.root_turn_id.clone() {
            turns.push(ThreadTurnSummary {
                turn_id,
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
                active: thread.active_turn_id.is_some(),
            });
        }
    }
    turns
}

fn update_turn_summary_from_item(turn: &mut ThreadTurnSummary, item: &ThreadItem) {
    match &item.kind {
        ThreadItemKind::TurnStarted(payload) => {
            turn.status = ThreadStatus::Running;
            turn.active = true;
            turn.completed_at = None;
            turn.started_at =
                string_field(payload, "startedAt").or_else(|| Some(item.created_at.clone()));
            turn.model = string_field(payload, "model").or_else(|| turn.model.clone());
            turn.provider = string_field(payload, "provider").or_else(|| turn.provider.clone());
        }
        ThreadItemKind::TurnCompleted(payload) => {
            if turn.completed_at.is_none() {
                turn.status = ThreadStatus::Idle;
                turn.active = false;
                turn.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::Error(payload) => {
            if turn.completed_at.is_none() {
                turn.status = ThreadStatus::Failed;
                turn.active = false;
                turn.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::Cancelled(payload) => {
            if turn.completed_at.is_none() {
                turn.status = ThreadStatus::Idle;
                turn.active = false;
                turn.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::CheckpointCreated(payload) => {
            if turn.completed_at.is_none() {
                match string_field(payload, "label").as_deref() {
                    Some("awaiting_form") => turn.status = ThreadStatus::WaitingForInput,
                    Some("awaiting_approval") => turn.status = ThreadStatus::WaitingForApproval,
                    _ => {}
                }
                turn.active = true;
            }
        }
        ThreadItemKind::ApprovalRequested(_) => {
            if turn.completed_at.is_none() {
                turn.status = ThreadStatus::WaitingForApproval;
                turn.active = true;
            }
        }
        ThreadItemKind::ApprovalResolved(_) => {
            if turn.active && turn.completed_at.is_none() {
                turn.status = ThreadStatus::Running;
            }
        }
        _ => {}
    }
}
