use crate::threads::domain::types::{
    ThreadItem, ThreadItemKind, ThreadRecord, ThreadRunSummary, ThreadStatus,
};
use serde_json::Value;

use super::string_field;

pub(crate) fn run_summaries_from_items(
    thread: &ThreadRecord,
    items: &[ThreadItem],
) -> Vec<ThreadRunSummary> {
    let mut runs = Vec::<ThreadRunSummary>::new();
    for item in items {
        let Some(run_id) = item.run_id.as_ref() else {
            continue;
        };
        let position = runs
            .iter()
            .position(|run| run.run_id == *run_id)
            .unwrap_or_else(|| {
                runs.push(ThreadRunSummary {
                    run_id: run_id.clone(),
                    status: ThreadStatus::Idle,
                    started_at: None,
                    updated_at: None,
                    completed_at: None,
                    model: None,
                    provider: None,
                    item_count: 0,
                    active: false,
                });
                runs.len() - 1
            });
        let run = &mut runs[position];
        run.item_count = run.item_count.saturating_add(1);
        run.updated_at = Some(item.created_at.clone());
        update_run_summary_from_item(run, item);
    }
    if runs.is_empty() {
        if let Some(run_id) = thread.root_run_id.clone() {
            runs.push(ThreadRunSummary {
                run_id,
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
                active: thread.active_run_id.is_some(),
            });
        }
    }
    runs
}

fn update_run_summary_from_item(run: &mut ThreadRunSummary, item: &ThreadItem) {
    match &item.kind {
        ThreadItemKind::AgentRunStarted(payload) => {
            run.status = ThreadStatus::Running;
            run.active = true;
            run.completed_at = None;
            run.started_at =
                string_field(payload, "startedAt").or_else(|| Some(item.created_at.clone()));
            run.model = string_field(payload, "model").or_else(|| run.model.clone());
            run.provider = string_field(payload, "provider").or_else(|| run.provider.clone());
        }
        ThreadItemKind::AgentRunCompleted(payload) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::Idle;
                run.active = false;
                run.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::Error(payload) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::Failed;
                run.active = false;
                run.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::Cancelled(payload) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::Idle;
                run.active = false;
                run.completed_at =
                    string_field(payload, "completedAt").or_else(|| Some(item.created_at.clone()));
            }
        }
        ThreadItemKind::CheckpointCreated(payload) => {
            if run.completed_at.is_none() {
                match string_field(payload, "label").as_deref() {
                    Some("awaiting_form") => run.status = ThreadStatus::WaitingForInput,
                    Some("awaiting_approval") => run.status = ThreadStatus::WaitingForApproval,
                    _ => {}
                }
                run.active = true;
            }
        }
        ThreadItemKind::ApprovalRequested(_) => {
            if run.completed_at.is_none() {
                run.status = ThreadStatus::WaitingForApproval;
                run.active = true;
            }
        }
        ThreadItemKind::ApprovalResolved(_) => {
            if run.active && run.completed_at.is_none() {
                run.status = ThreadStatus::Running;
            }
        }
        _ => {}
    }
}
