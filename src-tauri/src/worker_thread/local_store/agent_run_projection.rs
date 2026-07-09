use crate::worker_session::{AgentRunRecord, AgentRunStatus};
use crate::worker_thread::types::{
    ThreadItem, ThreadItemKind, ThreadRecord, ThreadRunSummary, ThreadStatus,
};
use serde_json::Value;

use super::{string_field, trace_event_from_thread_item};

pub(super) fn run_summaries_from_items(
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

pub(super) fn agent_run_record_from_thread_run(
    session_id: &str,
    thread: &ThreadRecord,
    run: &ThreadRunSummary,
    items: &[ThreadItem],
) -> AgentRunRecord {
    let trace_events = items
        .iter()
        .filter(|item| item.run_id.as_deref() == Some(run.run_id.as_str()))
        .filter_map(trace_event_from_thread_item)
        .collect::<Vec<_>>();
    AgentRunRecord {
        session_id: session_id.to_string(),
        run_id: run.run_id.clone(),
        thread_id: Some(thread.thread_id.clone()),
        turn_id: turn_id_for_run(run, items),
        parent_thread_id: thread.parent_thread_id.clone(),
        child_thread_ids: child_thread_ids_for_run(thread, run, items),
        status: agent_run_status_from_thread_run(run),
        phase: agent_run_phase_from_thread_run(run).to_string(),
        started_at: run
            .started_at
            .clone()
            .unwrap_or_else(|| thread.created_at.clone()),
        updated_at: run
            .updated_at
            .clone()
            .unwrap_or_else(|| thread.updated_at.clone()),
        completed_at: run.completed_at.clone(),
        stop_reason: run
            .completed_at
            .as_ref()
            .map(|_| "thread_projected".to_string()),
        model: run
            .model
            .clone()
            .or_else(|| thread.metadata.model.clone())
            .unwrap_or_default(),
        provider: run.provider.clone(),
        max_iterations: 0,
        current_iteration: 0,
        conversation_message_ids: Vec::new(),
        trace_messages: Vec::new(),
        trace_events,
        completed_tool_results: Vec::new(),
        pending_tool_calls: Vec::new(),
        checkpoint: None,
        artifacts: Vec::new(),
        usage: Vec::new(),
        token_usage_info: thread_token_usage_info(thread),
        error: (run.status == ThreadStatus::Failed).then(|| {
            serde_json::json!({
                "message": "thread run failed"
            })
        }),
    }
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

fn thread_token_usage_info(thread: &ThreadRecord) -> Option<crate::worker_session::TokenUsageInfo> {
    thread
        .metadata
        .extra
        .get("tokenUsageInfo")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn child_thread_ids_for_run(
    thread: &ThreadRecord,
    run: &ThreadRunSummary,
    items: &[ThreadItem],
) -> Vec<String> {
    let mut child_thread_ids = items
        .iter()
        .filter(|item| item.run_id.as_deref() == Some(run.run_id.as_str()))
        .filter_map(|item| child_thread_id_from_item(&item.kind))
        .collect::<Vec<_>>();
    child_thread_ids.sort();
    child_thread_ids.dedup();
    if thread.parent_thread_id.is_some() || !child_thread_ids.is_empty() {
        return child_thread_ids;
    }
    Vec::new()
}

fn turn_id_for_run(run: &ThreadRunSummary, items: &[ThreadItem]) -> Option<String> {
    items
        .iter()
        .find(|item| item.run_id.as_deref() == Some(run.run_id.as_str()))
        .and_then(|item| item.turn_id.clone())
        .or_else(|| Some(run.run_id.clone()))
}

fn child_thread_id_from_item(kind: &ThreadItemKind) -> Option<String> {
    match kind {
        ThreadItemKind::SubagentSpawned(value)
        | ThreadItemKind::SubagentMessage(value)
        | ThreadItemKind::SubagentCompleted(value) => value
            .get("childThreadId")
            .or_else(|| value.get("child_thread_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn agent_run_status_from_thread_run(run: &ThreadRunSummary) -> AgentRunStatus {
    match &run.status {
        ThreadStatus::Failed => AgentRunStatus::Failed,
        ThreadStatus::Cancelling => AgentRunStatus::Cancelled,
        ThreadStatus::WaitingForApproval | ThreadStatus::WaitingForInput => AgentRunStatus::Waiting,
        ThreadStatus::Running => AgentRunStatus::Running,
        ThreadStatus::Empty | ThreadStatus::Idle | ThreadStatus::Archived => {
            if run.active {
                AgentRunStatus::Running
            } else {
                AgentRunStatus::Completed
            }
        }
    }
}

fn agent_run_phase_from_thread_run(run: &ThreadRunSummary) -> &'static str {
    match agent_run_status_from_thread_run(run) {
        AgentRunStatus::Running => "active_turn",
        AgentRunStatus::Waiting => "waiting",
        AgentRunStatus::Completed => "completed",
        AgentRunStatus::Failed => "failed",
        AgentRunStatus::Cancelled => "cancelled",
    }
}
