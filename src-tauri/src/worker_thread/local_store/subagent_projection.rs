use super::string_field;
use crate::worker_subagent_manager::{
    SubagentMailboxInput, SubagentThreadStatus, SubagentThreadSummary,
};
use crate::worker_thread::types::{ThreadItem, ThreadItemKind, ThreadStatus};
use serde_json::Value;

pub(super) fn subagent_initial_child_items(
    summary: &SubagentThreadSummary,
    event: Option<Value>,
) -> Vec<ThreadItem> {
    let mut items = Vec::new();
    if !summary.task.trim().is_empty() {
        items.push(ThreadItem {
            item_id: format!(
                "subagent:{}:{}:task",
                summary.session_key, summary.subagent_id
            ),
            thread_id: String::new(),
            run_id: Some(summary.child_run_id.clone()),
            turn_id: summary.parent_run_id.clone(),
            parent_item_id: None,
            sequence: 0,
            created_at: summary.created_at.clone(),
            kind: ThreadItemKind::UserMessage(serde_json::json!({
                "text": summary.task,
                "source": "subagent_task",
                "subagent": subagent_summary_payload(summary, None),
            })),
        });
    }
    items.push(ThreadItem {
        item_id: format!(
            "subagent:{}:{}:started",
            summary.session_key, summary.subagent_id
        ),
        thread_id: String::new(),
        run_id: Some(summary.child_run_id.clone()),
        turn_id: summary.parent_run_id.clone(),
        parent_item_id: None,
        sequence: 0,
        created_at: summary.created_at.clone(),
        kind: ThreadItemKind::AgentRunStarted(subagent_summary_payload(summary, event)),
    });
    items
}

pub(super) fn subagent_input_item(
    summary: &SubagentThreadSummary,
    input: &SubagentMailboxInput,
    event: Option<Value>,
) -> ThreadItem {
    ThreadItem {
        item_id: input.input_id.clone(),
        thread_id: String::new(),
        run_id: Some(summary.child_run_id.clone()),
        turn_id: input
            .turn_id
            .clone()
            .or_else(|| summary.parent_run_id.clone()),
        parent_item_id: None,
        sequence: 0,
        created_at: input.created_at.clone(),
        kind: ThreadItemKind::UserMessage(serde_json::json!({
            "text": input.content,
            "sender": input.sender,
            "metadata": input.metadata,
            "event": event,
            "subagent": subagent_summary_payload(summary, None),
        })),
    }
}

pub(super) fn subagent_child_status_item(
    summary: &SubagentThreadSummary,
    event: Option<Value>,
) -> ThreadItem {
    let payload = subagent_summary_payload(summary, event);
    let kind = match summary.status {
        SubagentThreadStatus::Completed | SubagentThreadStatus::Closed => {
            ThreadItemKind::AgentRunCompleted(payload)
        }
        SubagentThreadStatus::Failed | SubagentThreadStatus::Interrupted => {
            ThreadItemKind::Error(payload)
        }
        SubagentThreadStatus::Cancelled => ThreadItemKind::Cancelled(payload),
        SubagentThreadStatus::AwaitingApproval => ThreadItemKind::ApprovalRequested(payload),
        SubagentThreadStatus::Running
        | SubagentThreadStatus::WaitingMainAgent
        | SubagentThreadStatus::WaitingUser => ThreadItemKind::SubagentMessage(payload),
    };
    ThreadItem {
        item_id: format!(
            "subagent:{}:{}:status:{}",
            summary.session_key,
            summary.subagent_id,
            status_string(&summary.status)
        ),
        thread_id: String::new(),
        run_id: Some(summary.child_run_id.clone()),
        turn_id: summary.parent_run_id.clone(),
        parent_item_id: None,
        sequence: 0,
        created_at: summary.updated_at.clone(),
        kind,
    }
}

pub(super) fn subagent_parent_item(
    summary: &SubagentThreadSummary,
    event: Option<Value>,
    label: &str,
    kind: impl FnOnce(Value) -> ThreadItemKind,
) -> ThreadItem {
    ThreadItem {
        item_id: format!(
            "subagent:{}:{}:{label}",
            summary.session_key, summary.subagent_id
        ),
        thread_id: String::new(),
        run_id: summary.parent_run_id.clone(),
        turn_id: summary.parent_run_id.clone(),
        parent_item_id: None,
        sequence: 0,
        created_at: summary.updated_at.clone(),
        kind: kind(subagent_summary_payload(summary, event)),
    }
}

pub(super) fn active_child_run_id_for_status(summary: &SubagentThreadSummary) -> Option<String> {
    match summary.status {
        SubagentThreadStatus::Running
        | SubagentThreadStatus::WaitingMainAgent
        | SubagentThreadStatus::WaitingUser
        | SubagentThreadStatus::AwaitingApproval => Some(summary.child_run_id.clone()),
        SubagentThreadStatus::Completed
        | SubagentThreadStatus::Failed
        | SubagentThreadStatus::Cancelled
        | SubagentThreadStatus::Closed
        | SubagentThreadStatus::Interrupted => None,
    }
}

pub(super) fn thread_status_for_subagent(status: &SubagentThreadStatus) -> ThreadStatus {
    match status {
        SubagentThreadStatus::Running => ThreadStatus::Running,
        SubagentThreadStatus::WaitingMainAgent | SubagentThreadStatus::WaitingUser => {
            ThreadStatus::WaitingForInput
        }
        SubagentThreadStatus::AwaitingApproval => ThreadStatus::WaitingForApproval,
        SubagentThreadStatus::Failed | SubagentThreadStatus::Interrupted => ThreadStatus::Failed,
        SubagentThreadStatus::Cancelled
        | SubagentThreadStatus::Completed
        | SubagentThreadStatus::Closed => ThreadStatus::Idle,
    }
}

pub(super) fn subagent_agent_control_payload(
    summary: &SubagentThreadSummary,
    parent_thread_id: &str,
) -> Value {
    let role = string_field(&summary.metadata, "role").unwrap_or_else(|| "subagent".to_string());
    let nickname =
        string_field(&summary.metadata, "nickname").unwrap_or_else(|| summary.name.clone());
    let agent_path = summary
        .metadata
        .get("agentPath")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| serde_json::json!(["main", summary.subagent_id]));
    let depth = summary
        .metadata
        .get("depth")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let capacity = summary
        .metadata
        .get("capacity")
        .cloned()
        .unwrap_or(Value::Null);

    serde_json::json!({
        "agentId": summary.subagent_id,
        "agentPath": agent_path,
        "parentThreadId": parent_thread_id,
        "parentRunId": summary.parent_run_id,
        "childRunId": summary.child_run_id,
        "role": role,
        "nickname": nickname,
        "depth": depth,
        "capacity": capacity,
        "lifecycle": {
            "status": status_value(&summary.status),
            "active": active_child_run_id_for_status(summary).is_some(),
            "terminal": subagent_status_is_terminal(&summary.status),
            "mailboxDepth": summary.mailbox_depth,
            "closedAt": summary.closed_at,
            "terminalResult": summary.terminal_result,
            "blockerSummary": summary.blocker_summary,
            "pendingApproval": summary.pending_approval,
        }
    })
}

fn subagent_summary_payload(summary: &SubagentThreadSummary, event: Option<Value>) -> Value {
    serde_json::json!({
        "sessionKey": summary.session_key,
        "parentRunId": summary.parent_run_id,
        "subagentId": summary.subagent_id,
        "childRunId": summary.child_run_id,
        "traceRef": summary.trace_ref,
        "name": summary.name,
        "task": summary.task,
        "status": summary.status,
        "mailboxDepth": summary.mailbox_depth,
        "terminalResult": summary.terminal_result,
        "blockerSummary": summary.blocker_summary,
        "pendingApproval": summary.pending_approval,
        "metadata": summary.metadata,
        "event": event,
    })
}

pub(super) fn status_value(status: &SubagentThreadStatus) -> Value {
    serde_json::to_value(status)
        .unwrap_or_else(|_| Value::String(status_string(status).to_string()))
}

fn subagent_status_is_terminal(status: &SubagentThreadStatus) -> bool {
    matches!(
        status,
        SubagentThreadStatus::Completed
            | SubagentThreadStatus::Failed
            | SubagentThreadStatus::Cancelled
            | SubagentThreadStatus::Closed
            | SubagentThreadStatus::Interrupted
    )
}

fn status_string(status: &SubagentThreadStatus) -> &'static str {
    match status {
        SubagentThreadStatus::Running => "running",
        SubagentThreadStatus::WaitingMainAgent => "waiting_main_agent",
        SubagentThreadStatus::WaitingUser => "waiting_user",
        SubagentThreadStatus::AwaitingApproval => "awaiting_approval",
        SubagentThreadStatus::Completed => "completed",
        SubagentThreadStatus::Failed => "failed",
        SubagentThreadStatus::Cancelled => "cancelled",
        SubagentThreadStatus::Closed => "closed",
        SubagentThreadStatus::Interrupted => "interrupted",
    }
}
