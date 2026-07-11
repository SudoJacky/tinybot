use super::agent_run_projection::run_summaries_from_items;
use super::checkpoint::latest_checkpoint_from_items;
use super::index::ThreadIndex;
use super::{bool_field, string_field, turn_items_from_thread_items, u64_field, LocalThreadStore};
use crate::worker_protocol::WorkerProtocolError;
use crate::worker_thread::types::{
    ThreadAgentRegistryEntry, ThreadChildActivity, ThreadChildSummary, ThreadItem, ThreadItemKind,
    ThreadPendingApproval, ThreadRecord, ThreadRunSummary, ThreadRunningTool, ThreadStatus,
};
use serde_json::Value;

pub(super) fn agent_registry_entry(
    thread: &ThreadRecord,
    index: &ThreadIndex,
    items: &[ThreadItem],
) -> ThreadAgentRegistryEntry {
    let runs = run_summaries_from_items(thread, items);
    let active_run = runs.iter().find(|run| run.active).cloned();
    let session_id = thread.session_key.as_deref().unwrap_or_default();
    let turn_items = active_run
        .as_ref()
        .map(|run| turn_items_from_thread_items(items, session_id, &run.run_id))
        .unwrap_or_default();
    let latest_checkpoint = latest_checkpoint_from_items(&thread.thread_id, items);
    let agent_control = thread.metadata.extra.get("agentControl").cloned();
    let lifecycle = agent_control
        .as_ref()
        .and_then(|control| control.get("lifecycle"));
    let child_count = index
        .threads
        .iter()
        .filter(|candidate| candidate.parent_thread_id.as_deref() == Some(&thread.thread_id))
        .count() as u64;
    let default_agent_id = if thread.parent_thread_id.is_none() {
        format!("main:{}", thread.thread_id)
    } else {
        format!("agent:{}", thread.thread_id)
    };
    let role = agent_control
        .as_ref()
        .and_then(|control| string_field(control, "role"))
        .unwrap_or_else(|| {
            if thread.parent_thread_id.is_none() {
                "main".to_string()
            } else {
                "subagent".to_string()
            }
        });
    let nickname = agent_control
        .as_ref()
        .and_then(|control| string_field(control, "nickname"))
        .unwrap_or_else(|| thread.title.clone());
    let active = lifecycle
        .and_then(|value| bool_field(value, "active"))
        .unwrap_or_else(|| active_run.is_some());
    let terminal = lifecycle
        .and_then(|value| bool_field(value, "terminal"))
        .unwrap_or_else(|| matches!(thread.status, ThreadStatus::Failed));
    ThreadAgentRegistryEntry {
        agent_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "agentId"))
            .unwrap_or(default_agent_id),
        thread_id: thread.thread_id.clone(),
        session_key: thread.session_key.clone(),
        parent_thread_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "parentThreadId"))
            .or_else(|| thread.parent_thread_id.clone()),
        parent_agent_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "parentAgentId")),
        parent_run_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "parentRunId")),
        run_id: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "childRunId"))
            .or_else(|| active_run.as_ref().map(|run| run.run_id.clone()))
            .or_else(|| thread.active_run_id.clone()),
        title: thread.title.clone(),
        role,
        nickname,
        status: thread.status.clone(),
        active,
        terminal,
        source: thread.source.clone(),
        depth: agent_control
            .as_ref()
            .and_then(|control| u64_field(control, "depth"))
            .unwrap_or_else(|| {
                if thread.parent_thread_id.is_none() {
                    0
                } else {
                    1
                }
            }),
        agent_path: agent_control
            .as_ref()
            .and_then(|control| control.get("agentPath"))
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| {
                if thread.parent_thread_id.is_none() {
                    serde_json::json!(["main"])
                } else {
                    serde_json::json!(["main", thread.thread_id])
                }
            }),
        child_count,
        created_at: thread.created_at.clone(),
        updated_at: thread.updated_at.clone(),
        trace_ref: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "traceRef"))
            .or_else(|| string_field(&thread.metadata.extra, "traceRef")),
        task: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "task"))
            .or_else(|| thread.metadata.preview.clone()),
        history_mode: agent_control
            .as_ref()
            .and_then(|control| string_field(control, "historyMode")),
        mailbox_depth: lifecycle.and_then(|value| u64_field(value, "mailboxDepth")),
        pending_approval: lifecycle
            .and_then(|value| value.get("pendingApproval"))
            .filter(|value| !value.is_null())
            .cloned(),
        capacity: agent_control
            .as_ref()
            .and_then(|control| control.get("capacity"))
            .filter(|value| !value.is_null())
            .cloned(),
        agent_control,
        active_run,
        latest_checkpoint,
        turn_items,
    }
}

pub(super) fn pending_approvals_from_items(
    thread_id: &str,
    items: &[ThreadItem],
) -> Vec<ThreadPendingApproval> {
    items
        .iter()
        .filter_map(|item| {
            let ThreadItemKind::ApprovalRequested(payload) = &item.kind else {
                return None;
            };
            let approval_id = string_field(payload, "approvalId")
                .or_else(|| string_field(payload, "approval_id"))?;
            let resolved = items.iter().any(|candidate| {
                candidate.sequence > item.sequence
                    && candidate.run_id == item.run_id
                    && matches!(
                        &candidate.kind,
                        ThreadItemKind::ApprovalResolved(candidate_payload)
                            if string_field(candidate_payload, "approvalId")
                                .or_else(|| string_field(candidate_payload, "approval_id"))
                                .as_deref()
                                == Some(approval_id.as_str())
                    )
            });
            if resolved {
                return None;
            }
            Some(ThreadPendingApproval {
                thread_id: thread_id.to_string(),
                item_id: item.item_id.clone(),
                run_id: item.run_id.clone(),
                turn_id: item.turn_id.clone(),
                approval_id,
                summary: string_field(payload, "summary"),
                scope: string_field(payload, "scope"),
                created_at: item.created_at.clone(),
                payload: payload.clone(),
            })
        })
        .collect()
}

pub(super) fn running_tools_from_items(
    thread_id: &str,
    items: &[ThreadItem],
) -> Vec<ThreadRunningTool> {
    items
        .iter()
        .filter_map(|item| {
            let ThreadItemKind::ToolCallStarted(payload) = &item.kind else {
                return None;
            };
            let tool_call_id = string_field(payload, "toolCallId")
                .or_else(|| string_field(payload, "tool_call_id"))?;
            let completed = items.iter().any(|candidate| {
                candidate.sequence > item.sequence
                    && candidate.run_id == item.run_id
                    && matches!(
                        &candidate.kind,
                        ThreadItemKind::ToolCallOutput(candidate_payload)
                            if string_field(candidate_payload, "toolCallId")
                                .or_else(|| string_field(candidate_payload, "tool_call_id"))
                                .as_deref()
                                == Some(tool_call_id.as_str())
                    )
            });
            if completed {
                return None;
            }
            Some(ThreadRunningTool {
                thread_id: thread_id.to_string(),
                item_id: item.item_id.clone(),
                run_id: item.run_id.clone(),
                turn_id: item.turn_id.clone(),
                tool_call_id,
                tool_name: string_field(payload, "toolName")
                    .or_else(|| string_field(payload, "tool_name")),
                args: payload.get("args").cloned().unwrap_or(Value::Null),
                started_at: item.created_at.clone(),
                payload: payload.clone(),
            })
        })
        .collect()
}

pub(super) fn child_activities_for_thread(
    store: &LocalThreadStore,
    thread_id: &str,
) -> Result<Vec<ThreadChildActivity>, WorkerProtocolError> {
    let index = store.read_index()?;
    let mut activities = Vec::new();
    for child in index.threads.iter().filter(|thread| {
        thread.parent_thread_id.as_deref() == Some(thread_id)
            && thread.status != ThreadStatus::Archived
            && thread.active_run_id.is_some()
    }) {
        let items = store.read_items(&child.thread_id)?;
        let runs = run_summaries_from_items(child, &items);
        let active_run = runs.iter().find(|run| run.active).cloned().or_else(|| {
            child.active_run_id.as_ref().map(|run_id| ThreadRunSummary {
                run_id: run_id.clone(),
                status: child.status.clone(),
                started_at: Some(child.created_at.clone()),
                updated_at: Some(child.updated_at.clone()),
                completed_at: child.archived_at.clone(),
                model: child.metadata.model.clone(),
                provider: child
                    .metadata
                    .extra
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                item_count: items.len() as u64,
                active: true,
            })
        });
        let turn_items = active_run
            .as_ref()
            .map(|run| {
                let child_session_id = child.session_key.as_deref().unwrap_or_default();
                turn_items_from_thread_items(&items, child_session_id, &run.run_id)
            })
            .unwrap_or_default();
        activities.push(ThreadChildActivity {
            child: ThreadChildSummary::from(child),
            active_run,
            turn_items,
        });
    }
    activities.sort_by(|left, right| {
        right
            .child
            .updated_at
            .cmp(&left.child.updated_at)
            .then_with(|| left.child.thread_id.cmp(&right.child.thread_id))
    });
    Ok(activities)
}
