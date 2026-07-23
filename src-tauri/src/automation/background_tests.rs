use super::*;
use serde_json::json;
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn list_runs_reads_existing_background_registry_fixture() {
    let root = temp_workspace_root("existing-background-store");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let store_path = root.join("background").join("registry.json");
    std::fs::create_dir_all(store_path.parent().unwrap()).unwrap();
    std::fs::write(
        &store_path,
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "runs": [
                {
                    "id": "run-existing",
                    "kind": "task",
                    "source": "task",
                    "status": "running",
                    "label": "Existing task run",
                    "sessionKey": "desktop:session-1",
                    "planId": "plan-existing",
                    "subtaskId": "step-1",
                    "cronJobId": null,
                    "startedAtMs": 1710000000000i64,
                    "updatedAtMs": 1710000005000i64,
                    "completedAtMs": null,
                    "result": null,
                    "error": null,
                    "metadata": { "source": "pre-storage-refactor" }
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let rpc = WorkerBackgroundRpc::new(
        root,
        CapabilityPolicy::new([WorkerCapability::BackgroundRead]),
    );

    let result = rpc
        .list_runs()
        .expect("existing background registry should load");

    assert_eq!(result.runs.len(), 1);
    let run = &result.runs[0];
    assert_eq!(run.id, "run-existing");
    assert_eq!(run.status, BackgroundRunStatus::Running);
    assert_eq!(run.metadata["source"], "pre-storage-refactor");
}

#[test]
fn upsert_accepts_awaiting_approval_runs() {
    let root = temp_workspace_root("awaiting-approval-store");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let rpc = WorkerBackgroundRpc::new(
        root,
        CapabilityPolicy::new([WorkerCapability::BackgroundWrite]),
    );

    let result = rpc
        .upsert_run(BackgroundRunUpsertParams {
            run: BackgroundRun {
                id: "run-awaiting".to_string(),
                kind: BackgroundRunKind::Subagent,
                source: BackgroundRunSource::Subagent,
                status: BackgroundRunStatus::AwaitingApproval,
                label: Some("Writer".to_string()),
                session_key: Some("desktop:session-1".to_string()),
                plan_id: None,
                subtask_id: None,
                cron_job_id: None,
                started_at_ms: 1710000000000,
                updated_at_ms: 1710000005000,
                completed_at_ms: None,
                result: Some("Waiting for approval.".to_string()),
                error: None,
                metadata: json!({ "stopReason": "awaiting_approval" }),
            },
        })
        .expect("awaiting approval should be a valid non-final background status");

    assert_eq!(result.run.status, BackgroundRunStatus::AwaitingApproval);
    assert_eq!(result.run.metadata["stopReason"], "awaiting_approval");
}

#[test]
fn appends_and_filters_trace_events() {
    let root = temp_workspace_root("trace-event-store");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let rpc = WorkerBackgroundRpc::new(
        root.clone(),
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    );

    rpc.append_trace_event(BackgroundTraceAppendParams {
        event: BackgroundTraceEvent {
            event_id: "event-1".to_string(),
            event_type: "agent.delegate.started".to_string(),
            session_key: "WebSocket:chat-1".to_string(),
            turn_id: "turn-1".to_string(),
            parent_step_id: None,
            delegate_id: Some("delegate-1".to_string()),
            child_turn_id: Some("delegate-1".to_string()),
            child_step_id: None,
            trace_ref: Some("trace-delegate-1".to_string()),
            sequence: 1,
            created_at: "2026-06-28T00:00:00.000Z".to_string(),
            payload: json!({ "status": "running" }),
        },
    })
    .expect("trace event append should succeed");
    rpc.append_trace_event(BackgroundTraceAppendParams {
        event: BackgroundTraceEvent {
            event_id: "event-2".to_string(),
            event_type: "agent.delegate.completed".to_string(),
            session_key: "WebSocket:chat-2".to_string(),
            turn_id: "turn-2".to_string(),
            parent_step_id: None,
            delegate_id: Some("delegate-2".to_string()),
            child_turn_id: Some("delegate-2".to_string()),
            child_step_id: None,
            trace_ref: Some("trace-delegate-2".to_string()),
            sequence: 2,
            created_at: "2026-06-28T00:00:01.000Z".to_string(),
            payload: json!({ "status": "completed" }),
        },
    })
    .expect("second trace event append should succeed");

    let result = rpc
        .list_trace_events(BackgroundTraceListParams {
            filter: Some(BackgroundTraceListFilter {
                session_key: Some("WebSocket:chat-1".to_string()),
                delegate_id: Some("delegate-1".to_string()),
                trace_ref: None,
                event_type: None,
                artifact_id: None,
            }),
        })
        .expect("trace events should list");

    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].event_id, "event-1");
    assert_eq!(result.events[0].payload["status"], "running");
    assert!(
        std::fs::read_to_string(root.join("background").join("registry.json"))
            .unwrap()
            .contains("traceEvents")
    );
}

#[test]
fn reconstructs_delegate_trace_from_journal_events() {
    let root = temp_workspace_root("delegate-trace-store");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let rpc = WorkerBackgroundRpc::new(
        root,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    );

    rpc.append_trace_event(BackgroundTraceAppendParams {
        event: BackgroundTraceEvent {
            event_id: "event-1".to_string(),
            event_type: "agent.delegate.started".to_string(),
            session_key: "WebSocket:chat-1".to_string(),
            turn_id: "turn-1".to_string(),
            parent_step_id: None,
            delegate_id: Some("delegate-1".to_string()),
            child_turn_id: Some("child-1".to_string()),
            child_step_id: None,
            trace_ref: Some("trace-delegate-1".to_string()),
            sequence: 1,
            created_at: "2026-06-28T00:00:00.000Z".to_string(),
            payload: json!({ "status": "running" }),
        },
    })
    .expect("start event should append");
    rpc.append_trace_event(BackgroundTraceAppendParams {
        event: BackgroundTraceEvent {
            event_id: "event-2".to_string(),
            event_type: "child.approval.resolved".to_string(),
            session_key: "WebSocket:chat-1".to_string(),
            turn_id: "turn-1".to_string(),
            parent_step_id: None,
            delegate_id: Some("delegate-1".to_string()),
            child_turn_id: Some("child-1".to_string()),
            child_step_id: Some("approval-1".to_string()),
            trace_ref: Some("trace-delegate-1".to_string()),
            sequence: 2,
            created_at: "2026-06-28T00:00:01.000Z".to_string(),
            payload: json!({
                "approvalId": "approval-1",
                "status": "approved",
                "toolName": "write_file"
            }),
        },
    })
    .expect("approval event should append");
    rpc.append_trace_event(BackgroundTraceAppendParams {
        event: BackgroundTraceEvent {
            event_id: "event-3".to_string(),
            event_type: "agent.delegate.completed".to_string(),
            session_key: "WebSocket:chat-1".to_string(),
            turn_id: "turn-1".to_string(),
            parent_step_id: None,
            delegate_id: Some("delegate-1".to_string()),
            child_turn_id: Some("child-1".to_string()),
            child_step_id: None,
            trace_ref: Some("trace-delegate-1".to_string()),
            sequence: 3,
            created_at: "2026-06-28T00:00:02.000Z".to_string(),
            payload: json!({ "status": "completed", "finalOutput": "Done" }),
        },
    })
    .expect("completed event should append");

    let result = rpc
        .get_delegate_trace(BackgroundTraceGetDelegateTraceParams {
            filter: BackgroundTraceListFilter {
                session_key: Some("WebSocket:chat-1".to_string()),
                delegate_id: Some("delegate-1".to_string()),
                trace_ref: None,
                event_type: None,
                artifact_id: None,
            },
        })
        .expect("delegate trace should reconstruct");

    assert_eq!(result.trace.session_key, "WebSocket:chat-1");
    assert_eq!(result.trace.delegate_id.as_deref(), Some("delegate-1"));
    assert_eq!(result.trace.child_turn_id.as_deref(), Some("child-1"));
    assert_eq!(result.trace.trace_ref.as_deref(), Some("trace-delegate-1"));
    assert_eq!(result.trace.status.as_deref(), Some("completed"));
    assert_eq!(result.trace.final_output.as_deref(), Some("Done"));
    assert_eq!(result.trace.events.len(), 3);
    assert_eq!(result.trace.approvals.len(), 1);
    assert_eq!(result.trace.approvals[0]["approvalId"], "approval-1");
}

#[test]
fn retrieves_artifact_from_trace_journal_events() {
    let root = temp_workspace_root("trace-artifact-store");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let rpc = WorkerBackgroundRpc::new(
        root,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    );

    rpc.append_trace_event(BackgroundTraceAppendParams {
        event: BackgroundTraceEvent {
            event_id: "event-artifact".to_string(),
            event_type: "child.artifact.created".to_string(),
            session_key: "WebSocket:chat-1".to_string(),
            turn_id: "turn-1".to_string(),
            parent_step_id: None,
            delegate_id: Some("delegate-1".to_string()),
            child_turn_id: Some("child-1".to_string()),
            child_step_id: Some("artifact-1".to_string()),
            trace_ref: Some("trace-delegate-1".to_string()),
            sequence: 1,
            created_at: "2026-06-28T00:00:00.000Z".to_string(),
            payload: json!({
                "artifactId": "artifact-1",
                "kind": "diff",
                "title": "Patch",
                "content": "--- a/file\n+++ b/file"
            }),
        },
    })
    .expect("artifact event should append");

    let result = rpc
        .get_artifact(BackgroundTraceGetArtifactParams {
            filter: BackgroundTraceListFilter {
                session_key: Some("WebSocket:chat-1".to_string()),
                delegate_id: Some("delegate-1".to_string()),
                trace_ref: None,
                event_type: None,
                artifact_id: Some("artifact-1".to_string()),
            },
        })
        .expect("artifact should load");

    assert_eq!(result.artifact["artifactId"], "artifact-1");
    assert_eq!(result.artifact["kind"], "diff");
    assert_eq!(result.artifact["title"], "Patch");
}

fn temp_workspace_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let root = std::env::temp_dir().join(format!(
        "tinybot-worker-background-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    root
}

struct TempWorkspaceCleanup(PathBuf);

impl Drop for TempWorkspaceCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
