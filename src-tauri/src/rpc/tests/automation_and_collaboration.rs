use super::*;

#[test]
fn dispatches_diagnostics_append_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::DiagnosticsWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "diagnostics.append",
        json!({ "stream": "stderr", "line": "worker warning" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({ "stream": "stderr", "line": "worker warning" }))
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_task_store_load_missing_as_empty_store() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-task-load",
        "trace-1",
        "task.store.load",
        json!({}),
    ));

    assert_eq!(response.result, Some(json!({ "version": 1, "plans": [] })));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_task_plan_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead, WorkerCapability::TaskWrite]),
    );
    let plan = json!({
        "id": "plan-1",
        "title": "Backend migration",
        "original_request": "Move backend runtime to TS",
        "status": "executing",
        "current_subtask_ids": ["sub-1"],
        "context": { "channel": "desktop" },
        "subtasks": [
            {
                "id": "sub-1",
                "title": "Foundation",
                "description": "Build foundation",
                "status": "in_progress",
                "dependencies": [],
                "parallel_safe": true,
                "retry_count": 0,
                "max_retries": 2
            }
        ]
    });

    let save_response = router.dispatch(&WorkerRequest::new(
        "req-task-save",
        "trace-1",
        "task.plan.save",
        json!({ "plan": plan }),
    ));
    let get_response = router.dispatch(&WorkerRequest::new(
        "req-task-get",
        "trace-1",
        "task.plan.get",
        json!({ "plan_id": "plan-1" }),
    ));
    assert!(fixture.read("plans/store.json").contains("\"plan-1\""));
    let list_response = router.dispatch(&WorkerRequest::new(
        "req-task-list",
        "trace-1",
        "task.plan.list",
        json!({}),
    ));
    let delete_response = router.dispatch(&WorkerRequest::new(
        "req-task-delete",
        "trace-1",
        "task.plan.delete",
        json!({ "plan_id": "plan-1" }),
    ));
    let missing_response = router.dispatch(&WorkerRequest::new(
        "req-task-get-missing",
        "trace-1",
        "task.plan.get",
        json!({ "plan_id": "plan-1" }),
    ));

    assert!(save_response.error.is_none());
    assert_eq!(
        save_response.result.as_ref().unwrap()["plan"]["id"],
        "plan-1"
    );
    assert_eq!(
        get_response.result.as_ref().unwrap()["plan"]["id"],
        "plan-1"
    );
    assert_eq!(
        list_response.result.as_ref().unwrap()["plans"][0]["id"],
        "plan-1"
    );
    assert_eq!(delete_response.result, Some(json!({ "deleted": true })));
    assert_eq!(missing_response.result, Some(json!({ "plan": null })));
}

#[test]
fn dispatches_task_plan_list_filters_completed_by_default() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
        "plans/store.json",
        &json!({
            "version": 1,
            "plans": [
                { "id": "active", "title": "Active", "status": "executing", "subtasks": [] },
                { "id": "done", "title": "Done", "status": "completed", "subtasks": [] }
            ]
        })
        .to_string(),
    );
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead]),
    );

    let default_response = router.dispatch(&WorkerRequest::new(
        "req-task-list",
        "trace-1",
        "task.plan.list",
        json!({}),
    ));
    let include_response = router.dispatch(&WorkerRequest::new(
        "req-task-list-all",
        "trace-1",
        "task.plan.list",
        json!({ "include_completed": true }),
    ));

    assert_eq!(
        default_response.result.as_ref().unwrap()["plans"],
        json!([{ "id": "active", "title": "Active", "status": "executing", "subtasks": [] }])
    );
    assert_eq!(
        include_response.result.as_ref().unwrap()["plans"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn denies_task_plan_save_without_write_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-task-save",
        "trace-1",
        "task.plan.save",
        json!({
            "plan": { "id": "plan-1", "title": "Plan", "subtasks": [] }
        }),
    ));

    let error = response.error.expect("task write should be denied");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "task.write");
    assert!(response.result.is_none());
}

#[test]
fn dispatches_cron_job_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronWrite]),
    );

    let add_response = router.dispatch(&WorkerRequest::new(
        "req-cron-add",
        "trace-1",
        "cron.job.add",
        json!({
            "job": {
                "name": "Check status",
                "schedule": { "kind": "every", "everyMs": 60000 },
                "payload": {
                    "kind": "agent_turn",
                    "message": "Check status",
                    "deliver": true,
                    "channel": "native",
                    "to": "run-1"
                },
                "deleteAfterRun": false
            }
        }),
    ));
    let add_result = add_response
        .result
        .as_ref()
        .expect("cron.job.add should return result");
    assert_eq!(add_response.error, None);
    let job_id = add_result["job"]["id"]
        .as_str()
        .expect("cron job should receive id")
        .to_string();
    assert_eq!(add_result["job"]["name"], "Check status");
    assert_eq!(add_result["job"]["schedule"]["everyMs"], 60000);
    assert_eq!(add_result["job"]["payload"]["to"], "run-1");
    assert!(add_result["job"]["enabled"].as_bool().unwrap());
    assert!(add_result["job"]["createdAtMs"].as_i64().unwrap() > 0);
    assert!(add_result["job"]["state"]["nextRunAtMs"].as_i64().unwrap() > 0);
    assert!(fixture.read("cron/jobs.json").contains(&job_id));

    let list_response = router.dispatch(&WorkerRequest::new(
        "req-cron-list",
        "trace-1",
        "cron.job.list",
        json!({}),
    ));
    assert_eq!(list_response.error, None);
    assert_eq!(
        list_response.result.as_ref().unwrap()["jobs"][0]["id"],
        job_id
    );

    let remove_response = router.dispatch(&WorkerRequest::new(
        "req-cron-remove",
        "trace-1",
        "cron.job.remove",
        json!({ "job_id": job_id }),
    ));
    assert_eq!(remove_response.error, None);
    assert_eq!(remove_response.result, Some(json!({ "status": "removed" })));

    let empty_response = router.dispatch(&WorkerRequest::new(
        "req-cron-list-empty",
        "trace-1",
        "cron.job.list",
        json!({}),
    ));
    assert_eq!(empty_response.result, Some(json!({ "jobs": [] })));
}

#[test]
fn dispatches_cron_job_remove_protects_system_events() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
            "cron/jobs.json",
            &json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "system-job",
                        "name": "System upkeep",
                        "enabled": true,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "system_event", "message": "upkeep" },
                        "state": { "nextRunAtMs": 1234, "lastRunAtMs": null, "lastError": null, "runCount": 0, "history": [] },
                        "createdAtMs": 1000,
                        "updatedAtMs": 1000,
                        "deleteAfterRun": false
                    }
                ]
            })
            .to_string(),
        );
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-cron-protected",
        "trace-1",
        "cron.job.remove",
        json!({ "job_id": "system-job" }),
    ));

    assert_eq!(response.error, None);
    assert_eq!(response.result, Some(json!({ "status": "protected" })));
    assert!(fixture.read("cron/jobs.json").contains("system-job"));
}

#[test]
fn denies_cron_job_add_without_write_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-cron-add",
        "trace-1",
        "cron.job.add",
        json!({
            "job": {
                "name": "Check status",
                "schedule": { "kind": "every", "everyMs": 60000 },
                "payload": { "kind": "agent_turn", "message": "Check status" }
            }
        }),
    ));

    let error = response.error.expect("cron write should be denied");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "cron.write");
    assert!(response.result.is_none());
}

#[test]
fn dispatches_cron_due_and_record_run_updates_store() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
            "cron/jobs.json",
            &json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "due-every",
                        "name": "Every",
                        "enabled": true,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "agent_turn", "message": "check", "deliver": true },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": false
                    },
                    {
                        "id": "due-at",
                        "name": "Once",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 1000 },
                        "payload": { "kind": "agent_turn", "message": "once", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "future",
                        "name": "Future",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 100000 },
                        "payload": { "kind": "agent_turn", "message": "later", "deliver": false },
                        "state": { "nextRunAtMs": 100000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "disabled",
                        "name": "Disabled",
                        "enabled": false,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "agent_turn", "message": "skip", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": false
                    }
                ]
            })
            .to_string(),
        );
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronRun]),
    );

    let due_response = router.dispatch(&WorkerRequest::new(
        "req-cron-due",
        "trace-1",
        "cron.job.due",
        json!({ "now_ms": 2000 }),
    ));

    assert_eq!(due_response.error, None);
    assert_eq!(
        due_response.result.as_ref().unwrap()["jobs"],
        json!([
            {
                "id": "due-every",
                "name": "Every",
                "enabled": true,
                "schedule": { "kind": "every", "everyMs": 60000 },
                "payload": { "kind": "agent_turn", "message": "check", "deliver": true, "channel": null, "to": null },
                "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                "createdAtMs": 1,
                "updatedAtMs": 1,
                "deleteAfterRun": false
            },
            {
                "id": "due-at",
                "name": "Once",
                "enabled": true,
                "schedule": { "kind": "at", "atMs": 1000 },
                "payload": { "kind": "agent_turn", "message": "once", "deliver": false, "channel": null, "to": null },
                "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                "createdAtMs": 1,
                "updatedAtMs": 1,
                "deleteAfterRun": true
            }
        ])
    );

    let record_response = router.dispatch(&WorkerRequest::new(
            "req-cron-record",
            "trace-1",
            "cron.job.record_runs",
            json!({
                "now_ms": 3000,
                "records": [
                    { "job_id": "due-every", "run_at_ms": 2000, "status": "ok", "duration_ms": 25 },
                    { "job_id": "due-at", "run_at_ms": 2000, "status": "error", "duration_ms": 5, "error": "boom" }
                ]
            }),
        ));

    assert_eq!(record_response.error, None);
    assert_eq!(
        record_response.result,
        Some(json!({ "updated": ["due-every"], "deleted": ["due-at"], "missing": [] }))
    );
    let store: Value = serde_json::from_str(&fixture.read("cron/jobs.json")).unwrap();
    let every = store["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|job| job["id"] == "due-every")
        .unwrap();
    assert_eq!(every["state"]["lastRunAtMs"], 2000);
    assert_eq!(every["state"]["lastStatus"], "ok");
    assert_eq!(every["state"]["lastError"], Value::Null);
    assert_eq!(every["state"]["nextRunAtMs"], 63000);
    assert_eq!(every["state"]["runHistory"][0]["durationMs"], 25);
    assert!(!fixture.read("cron/jobs.json").contains("due-at"));
}

#[test]
fn dispatches_session_task_progress_upsert_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );

    let first = router.dispatch(&WorkerRequest::new(
        "req-progress-1",
        "trace-1",
        "session.task_progress.upsert",
        json!({
            "session_id": "session-1",
            "turn_id": "turn-progress-1",
            "plan_id": "plan-1",
            "content": "first progress",
            "progress": {
                "completed": 0,
                "total": 2,
                "steps": [
                    { "step": "Inspect session", "status": "in_progress" },
                    { "step": "Finish session", "status": "pending" }
                ]
            }
        }),
    ));
    let second = router.dispatch(&WorkerRequest::new(
        "req-progress-2",
        "trace-2",
        "session.task_progress.upsert",
        json!({
            "session_id": "session-1",
            "turn_id": "turn-progress-1",
            "plan_id": "plan-1",
            "content": "updated progress",
            "progress": {
                "completed": 1,
                "total": 2,
                "steps": [
                    { "step": "Inspect session", "status": "completed" },
                    { "step": "Finish session", "status": "in_progress" }
                ]
            }
        }),
    ));

    assert_eq!(first.error, None);
    assert_eq!(second.error, None);
    let messages = second.result.as_ref().unwrap()["extra"]["messages"]
        .as_array()
        .expect("messages should be an array");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "progress");
    assert_eq!(messages[0]["content"], "updated progress");
    assert_eq!(messages[0]["_task_plan_id"], "plan-1");
    assert_eq!(messages[0]["_task_progress"]["completed"], 1);
}

#[test]
fn dispatches_background_run_registry_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    );

    let upsert_response = router.dispatch(&WorkerRequest::new(
        "req-background-upsert",
        "trace-1",
        "background.run.upsert",
        json!({
            "run": {
                "id": "subagent-1",
                "kind": "subagent",
                "source": "task",
                "status": "running",
                "label": "Inspect",
                "sessionKey": "desktop:chat-1",
                "planId": "plan-1",
                "subtaskId": "a",
                "startedAtMs": 1000,
                "updatedAtMs": 1000,
                "metadata": { "traceId": "trace-1" }
            }
        }),
    ));
    assert_eq!(upsert_response.error, None);
    assert_eq!(
        upsert_response.result.as_ref().unwrap()["run"]["id"],
        "subagent-1"
    );
    assert!(fixture
        .read("background/registry.json")
        .contains("subagent-1"));

    let list_response = router.dispatch(&WorkerRequest::new(
        "req-background-list",
        "trace-1",
        "background.run.list",
        json!({}),
    ));
    assert_eq!(list_response.error, None);
    assert_eq!(
        list_response.result.as_ref().unwrap()["runs"][0]["status"],
        "running"
    );

    let complete_response = router.dispatch(&WorkerRequest::new(
        "req-background-complete",
        "trace-1",
        "background.run.complete",
        json!({
            "run_id": "subagent-1",
            "status": "completed",
            "completedAtMs": 2000,
            "result": "inspection complete"
        }),
    ));
    assert_eq!(complete_response.error, None);
    assert_eq!(
        complete_response.result.as_ref().unwrap()["run"]["status"],
        "completed"
    );
    assert_eq!(
        complete_response.result.as_ref().unwrap()["run"]["result"],
        "inspection complete"
    );
    assert_eq!(
        complete_response.result.as_ref().unwrap()["run"]["completedAtMs"],
        2000
    );

    let append_trace_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-append",
        "trace-1",
        "background.trace.append",
        json!({
            "event": {
                "eventId": "event-1",
                "eventType": "agent.delegate.started",
                "sessionKey": "desktop:chat-1",
                "turnId": "turn-1",
                "delegateId": "subagent-1",
                "childTurnId": "subagent-1",
                "traceRef": "trace-1",
                "sequence": 1,
                "createdAt": "2026-06-28T00:00:00.000Z",
                "payload": { "status": "running" }
            }
        }),
    ));
    assert_eq!(append_trace_response.error, None);
    assert_eq!(
        append_trace_response.result.as_ref().unwrap()["event"]["eventId"],
        "event-1"
    );

    let list_trace_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-list",
        "trace-1",
        "background.trace.list",
        json!({
            "filter": {
                "sessionKey": "desktop:chat-1",
                "delegateId": "subagent-1"
            }
        }),
    ));
    assert_eq!(list_trace_response.error, None);
    assert_eq!(
        list_trace_response.result.as_ref().unwrap()["events"][0]["eventType"],
        "agent.delegate.started"
    );

    let get_trace_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-get",
        "trace-1",
        "background.trace.get_delegate_trace",
        json!({
            "filter": {
                "sessionKey": "desktop:chat-1",
                "delegateId": "subagent-1"
            }
        }),
    ));
    assert_eq!(get_trace_response.error, None);
    assert_eq!(
        get_trace_response.result.as_ref().unwrap()["trace"]["status"],
        "running"
    );
    assert_eq!(
        get_trace_response.result.as_ref().unwrap()["trace"]["events"][0]["eventType"],
        "agent.delegate.started"
    );

    let append_artifact_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-artifact-append",
        "trace-1",
        "background.trace.append",
        json!({
            "event": {
                "eventId": "event-artifact-1",
                "eventType": "child.artifact.created",
                "sessionKey": "desktop:chat-1",
                "turnId": "turn-1",
                "delegateId": "subagent-1",
                "childTurnId": "subagent-1",
                "childStepId": "artifact-1",
                "traceRef": "trace-1",
                "sequence": 2,
                "createdAt": "2026-06-28T00:00:01.000Z",
                "payload": {
                    "artifactId": "artifact-1",
                    "kind": "diff",
                    "title": "Patch"
                }
            }
        }),
    ));
    assert_eq!(append_artifact_response.error, None);
    let get_artifact_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-get-artifact",
        "trace-1",
        "background.trace.get_artifact",
        json!({
            "filter": {
                "sessionKey": "desktop:chat-1",
                "delegateId": "subagent-1",
                "artifactId": "artifact-1"
            }
        }),
    ));
    assert_eq!(get_artifact_response.error, None);
    assert_eq!(
        get_artifact_response.result.as_ref().unwrap()["artifact"]["artifactId"],
        "artifact-1"
    );
}

#[test]
fn background_subagent_enqueue_input_writes_user_message_trace_event() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-background-subagent-input",
        "trace-1",
        "background.subagent.enqueue_input",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "subagent-1",
            "content": "Use the safer option.",
            "traceRef": "trace-subagent-1",
            "childTurnId": "turn-subagent-1",
            "createdAt": "2026-06-28T00:00:02.000Z"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response
        .result
        .as_ref()
        .expect("enqueue should return a result");
    assert_eq!(result["accepted"], true);
    assert_eq!(result["delivery"], "queued_for_runtime");
    assert_eq!(
        result["event"]["eventType"],
        "agent.delegate.message_queued"
    );
    assert_eq!(result["event"]["sessionKey"], "desktop:chat-1");
    assert_eq!(result["event"]["delegateId"], "subagent-1");
    assert_eq!(
        result["event"]["payload"]["content"],
        "Use the safer option."
    );
    assert_eq!(result["event"]["payload"]["source"], "user");
}

#[test]
fn dispatches_subagent_control_requests() {
    let fixture = WorkspaceFixture::new();
    let manager = SubagentThreadManager::default();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .with_subagent_manager(manager);

    let spawn = router.dispatch(&WorkerRequest::new(
        "req-subagent-spawn",
        "trace-subagent",
        "subagent.spawn",
        json!({
            "sessionKey": "desktop:chat-1",
            "parentTurnId": "parent-turn-1",
            "subagentId": "delegate-1",
            "childTurnId": "child-1",
            "traceRef": "trace-delegate-1",
            "name": "Goodall",
            "task": "Inspect a narrow question",
            "metadata": {
                "role": "research",
                "nickname": "Scout",
                "depth": 1,
                "capacity": { "maxActivePerSession": 8 }
            }
        }),
    ));
    assert_eq!(spawn.error, None);
    assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);

    let send = router.dispatch(&WorkerRequest::new(
        "req-subagent-send",
        "trace-subagent",
        "subagent.send_input",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "delegate-1",
            "content": "Please continue",
            "sender": "main_agent"
        }),
    ));
    assert_eq!(send.error, None);
    assert_eq!(send.result.as_ref().unwrap()["delivery"], "live_delivered");
    assert_eq!(send.result.as_ref().unwrap()["subagent"]["mailboxDepth"], 1);

    let wait = router.dispatch(&WorkerRequest::new(
        "req-subagent-wait",
        "trace-subagent",
        "subagent.wait",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentIds": ["delegate-1"],
            "timeoutMs": 1
        }),
    ));
    assert_eq!(wait.error, None);
    assert_eq!(wait.result.as_ref().unwrap()["timedOut"], true);

    let close = router.dispatch(&WorkerRequest::new(
        "req-subagent-close",
        "trace-subagent",
        "subagent.close",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(close.error, None);
    assert_eq!(close.result.as_ref().unwrap()["accepted"], true);
    assert_eq!(
        close.result.as_ref().unwrap()["subagent"]["status"],
        "closed"
    );

    let default_thread_list = router.dispatch(&WorkerRequest::new(
        "req-subagent-default-thread-list",
        "trace-subagent",
        "thread.list",
        json!({ "includeArchived": true }),
    ));
    assert_eq!(default_thread_list.error, None);
    let default_threads = default_thread_list.result.as_ref().unwrap()["threads"]
        .as_array()
        .expect("thread list should be an array");
    assert_eq!(default_threads.len(), 1);
    assert_eq!(default_threads[0]["source"], "subagent_parent");

    let thread_list = router.dispatch(&WorkerRequest::new(
        "req-subagent-thread-list",
        "trace-subagent",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    assert_eq!(thread_list.error, None);
    let threads = thread_list.result.as_ref().unwrap()["threads"]
        .as_array()
        .expect("thread list should be an array");
    assert_eq!(threads.len(), 2);
    let parent_thread = threads
        .iter()
        .find(|thread| thread["source"] == "subagent_parent")
        .expect("parent thread should be projected");
    let child_thread = threads
        .iter()
        .find(|thread| thread["source"] == "subagent")
        .expect("child thread should be projected");
    assert_eq!(child_thread["parentThreadId"], parent_thread["threadId"]);
    assert_eq!(
        child_thread["metadata"]["extra"]["subagentId"],
        "delegate-1"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["agentId"],
        "delegate-1"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["agentPath"],
        json!(["main", "delegate-1"])
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["role"],
        "research"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["nickname"],
        "Scout"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["depth"],
        1
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["capacity"],
        json!({
            "maxActivePerSession": 8,
            "maxActiveGlobal": 32,
            "maxDelegationDepth": 4
        })
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["status"],
        "closed"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["active"],
        false
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["terminal"],
        true
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["mailboxDepth"],
        1
    );

    let direct_child_list = router.dispatch(&WorkerRequest::new(
        "req-subagent-direct-child-list",
        "trace-subagent",
        "thread.list",
        json!({
            "includeArchived": true,
            "parentThreadId": parent_thread["threadId"]
        }),
    ));
    assert_eq!(direct_child_list.error, None);
    assert_eq!(
        direct_child_list.result.as_ref().unwrap()["threads"][0]["threadId"],
        child_thread["threadId"]
    );

    let descendant_search = router.dispatch(&WorkerRequest::new(
        "req-subagent-descendant-search",
        "trace-subagent",
        "thread.search",
        json!({
            "query": "narrow question",
            "includeArchived": true,
            "ancestorThreadId": parent_thread["threadId"]
        }),
    ));
    assert_eq!(descendant_search.error, None);
    assert_eq!(
        descendant_search.result.as_ref().unwrap()["threads"][0]["threadId"],
        child_thread["threadId"]
    );

    let parent_read = router.dispatch(&WorkerRequest::new(
        "req-subagent-parent-thread-read",
        "trace-subagent",
        "thread.read",
        json!({ "threadId": parent_thread["threadId"] }),
    ));
    assert_eq!(parent_read.error, None);
    assert_eq!(
        parent_read.result.as_ref().unwrap()["children"][0]["threadId"],
        child_thread["threadId"]
    );
    assert_eq!(
        parent_read.result.as_ref().unwrap()["children"][0]["agentControl"]["agentId"],
        "delegate-1"
    );
    assert_eq!(
        parent_read.result.as_ref().unwrap()["children"][0]["agentControl"]["lifecycle"]["status"],
        "closed"
    );
    assert_eq!(
        parent_read.result.as_ref().unwrap()["pagination"]["itemCount"],
        2
    );
    let parent_kinds = parent_read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(parent_kinds, vec!["subagent_spawned", "subagent_completed"]);

    let child_read = router.dispatch(&WorkerRequest::new(
        "req-subagent-child-thread-read",
        "trace-subagent",
        "thread.read",
        json!({ "threadId": child_thread["threadId"] }),
    ));
    assert_eq!(child_read.error, None);
    assert_eq!(
        child_read.result.as_ref().unwrap()["turns"][0]["turnId"],
        "child-1"
    );
    assert_eq!(
        child_read.result.as_ref().unwrap()["turns"][0]["active"],
        false
    );
    assert_eq!(
        child_read.result.as_ref().unwrap()["pagination"]["itemCount"],
        4
    );
    let child_kinds = child_read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        child_kinds,
        vec![
            "user_message",
            "turn_started",
            "user_message",
            "turn_completed",
        ]
    );

    let delete_parent_only = router.dispatch(&WorkerRequest::new(
        "req-subagent-thread-delete-parent-only",
        "trace-subagent",
        "thread.delete",
        json!({ "threadId": parent_thread["threadId"] }),
    ));
    assert_eq!(
        delete_parent_only.error.as_ref().unwrap().code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );

    let delete_tree = router.dispatch(&WorkerRequest::new(
        "req-subagent-thread-delete-tree",
        "trace-subagent",
        "thread.delete",
        json!({ "threadId": parent_thread["threadId"], "deleteChildren": true }),
    ));
    assert_eq!(delete_tree.error, None);
    assert_eq!(delete_tree.result.as_ref().unwrap()["deleted"], true);
    assert_eq!(
        delete_tree.result.as_ref().unwrap()["deletedChildren"],
        json!([child_thread["threadId"].clone()])
    );
}

#[test]
fn subagent_history_modes_copy_only_public_parent_messages() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .with_subagent_manager(SubagentThreadManager::default());

    let create = router.dispatch(&WorkerRequest::new(
        "req-history-thread-create",
        "trace-history",
        "thread.create",
        json!({
            "threadId": "thread-history-parent",
            "title": "History parent",
            "sessionKey": "desktop:history",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-history-thread-append",
        "trace-history",
        "thread.append_items",
        json!({
            "threadId": "thread-history-parent",
            "items": [
                {
                    "itemId": "history:user:old",
                    "threadId": "",
                    "turnId": "turn-old",
                    "sequence": 0,
                    "createdAt": "1000",
                    "kind": { "type": "user_message", "payload": { "text": "old user" } }
                },
                {
                    "itemId": "history:assistant:old",
                    "threadId": "",
                    "turnId": "turn-old",
                    "sequence": 0,
                    "createdAt": "1001",
                    "kind": { "type": "assistant_message_completed", "payload": { "text": "old assistant" } }
                },
                {
                    "itemId": "history:reasoning:private",
                    "threadId": "",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1002",
                    "kind": { "type": "reasoning", "payload": { "text": "private reasoning" } }
                },
                {
                    "itemId": "history:tool:private",
                    "threadId": "",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1003",
                    "kind": { "type": "tool_call_output", "payload": { "text": "private tool output" } }
                },
                {
                    "itemId": "history:user:current",
                    "threadId": "",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1004",
                    "kind": { "type": "user_message", "payload": { "text": "current user" } }
                },
                {
                    "itemId": "history:assistant:current",
                    "threadId": "",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1005",
                    "kind": { "type": "assistant_message_completed", "payload": { "text": "current assistant" } }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    for (subagent_id, history_mode) in [
        ("delegate-parent-turn", "parent_turn"),
        ("delegate-full-history", "full_history"),
    ] {
        let spawn = router.dispatch(&WorkerRequest::new(
            format!("req-history-spawn-{subagent_id}"),
            "trace-history",
            "subagent.spawn",
            json!({
                "sessionKey": "desktop:history",
                "parentTurnId": "parent-turn",
                "subagentId": subagent_id,
                "childTurnId": format!("turn-{subagent_id}"),
                "task": "Inspect inherited context",
                "historyMode": history_mode
            }),
        ));
        assert_eq!(spawn.error, None);
        assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);
    }

    let list = router.dispatch(&WorkerRequest::new(
        "req-history-thread-list",
        "trace-history",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    assert_eq!(list.error, None);
    let threads = list.result.as_ref().unwrap()["threads"].as_array().unwrap();

    for (subagent_id, expected_messages) in [
        (
            "delegate-parent-turn",
            vec!["current user", "current assistant"],
        ),
        (
            "delegate-full-history",
            vec![
                "old user",
                "old assistant",
                "current user",
                "current assistant",
            ],
        ),
    ] {
        let child = threads
            .iter()
            .find(|thread| thread["metadata"]["extra"]["subagentId"] == subagent_id)
            .unwrap();
        let read = router.dispatch(&WorkerRequest::new(
            format!("req-history-read-{subagent_id}"),
            "trace-history",
            "thread.read",
            json!({ "threadId": child["threadId"] }),
        ));
        assert_eq!(read.error, None);
        let inherited = read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| !item["kind"]["payload"]["inherited"].is_null())
            .map(|item| item["kind"]["payload"]["text"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(inherited, expected_messages);
        assert!(read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(
                |item| item["kind"]["payload"]["text"] != "private reasoning"
                    && item["kind"]["payload"]["text"] != "private tool output"
            ));
    }
}

#[test]
fn nested_subagents_persist_their_direct_parent_thread_edge() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .with_subagent_manager(SubagentThreadManager::with_limits(4, 8, 3));

    for params in [
        json!({
            "sessionKey": "desktop:nested",
            "parentTurnId": "root-turn",
            "subagentId": "delegate-parent",
            "childTurnId": "delegate-parent-turn",
            "delegationDepth": 1,
            "task": "Delegate a bounded child task"
        }),
        json!({
            "sessionKey": "desktop:nested",
            "parentTurnId": "delegate-parent-turn",
            "parentSubagentId": "delegate-parent",
            "subagentId": "delegate-child",
            "childTurnId": "delegate-child-turn",
            "delegationDepth": 2,
            "task": "Inspect the nested detail"
        }),
    ] {
        let spawn = router.dispatch(&WorkerRequest::new(
            format!("req-nested-spawn-{}", params["subagentId"]),
            "trace-nested",
            "subagent.spawn",
            params,
        ));
        assert_eq!(spawn.error, None);
        assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);
    }

    let list = router.dispatch(&WorkerRequest::new(
        "req-nested-thread-list",
        "trace-nested",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    assert_eq!(list.error, None);
    let threads = list.result.as_ref().unwrap()["threads"].as_array().unwrap();
    let parent = threads
        .iter()
        .find(|thread| thread["metadata"]["extra"]["subagentId"] == "delegate-parent")
        .unwrap();
    let child = threads
        .iter()
        .find(|thread| thread["metadata"]["extra"]["subagentId"] == "delegate-child")
        .unwrap();
    assert_eq!(child["parentThreadId"], parent["threadId"]);
    assert_eq!(
        child["metadata"]["extra"]["agentControl"]["parentAgentId"],
        "delegate-parent"
    );
    assert_eq!(child["metadata"]["extra"]["agentControl"]["depth"], 2);
}

#[test]
fn background_subagent_enqueue_input_live_delivers_when_manager_has_child() {
    let fixture = WorkspaceFixture::new();
    let manager = SubagentThreadManager::default();
    manager.spawn(SubagentSpawnParams {
        session_key: "desktop:chat-1".to_string(),
        parent_turn_id: Some("parent-turn".to_string()),
        parent_subagent_id: None,
        delegation_depth: None,
        history_mode: None,
        subagent_id: Some("delegate-1".to_string()),
        child_turn_id: Some("child-1".to_string()),
        trace_ref: Some("trace-delegate-1".to_string()),
        name: Some("Goodall".to_string()),
        task: Some("Inspect a narrow question".to_string()),
        status: None,
        created_at: None,
        metadata: json!({}),
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    )
    .with_subagent_manager(manager);

    let response = router.dispatch(&WorkerRequest::new(
        "req-background-subagent-input",
        "trace-1",
        "background.subagent.enqueue_input",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "delegate-1",
            "content": "User intervention",
            "traceRef": "trace-delegate-1",
            "childTurnId": "child-1",
            "createdAt": "2026-06-28T00:00:02.000Z"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(result["delivery"], "live_delivered");
    assert_eq!(result["event"]["payload"]["delivery"], "live_delivered");
    assert_eq!(result["subagent"]["mailboxDepth"], 1);
}

#[test]
fn subagent_list_restores_interrupted_children_from_background_trace() {
    let fixture = WorkspaceFixture::new();
    let manager = SubagentThreadManager::default();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .with_subagent_manager(manager);

    let append = router.dispatch(&WorkerRequest::new(
        "req-background-trace-append",
        "trace-1",
        "background.trace.append",
        json!({
            "event": {
                "eventId": "event-running",
                "eventType": "agent.delegate.running",
                "sessionKey": "desktop:chat-1",
                "turnId": "parent-turn",
                "delegateId": "delegate-1",
                "childTurnId": "child-1",
                "traceRef": "trace-delegate-1",
                "sequence": 1,
                "createdAt": "2026-06-28T00:00:00.000Z",
                "payload": { "name": "Goodall", "task": "Inspect" }
            }
        }),
    ));
    assert_eq!(append.error, None);

    let list = router.dispatch(&WorkerRequest::new(
        "req-subagent-list",
        "trace-1",
        "subagent.list",
        json!({ "sessionKey": "desktop:chat-1" }),
    ));

    assert_eq!(list.error, None);
    let subagents = list.result.as_ref().unwrap()["subagents"]
        .as_array()
        .expect("subagent list should be an array");
    assert_eq!(subagents.len(), 1);
    assert_eq!(subagents[0]["subagentId"], "delegate-1");
    assert_eq!(subagents[0]["status"], "interrupted");
}

#[test]
fn subagent_restart_restores_canonical_edges_and_resumes_only_selected_children() {
    let fixture = WorkspaceFixture::new();
    let policy = CapabilityPolicy::new([
        WorkerCapability::BackgroundRead,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]);
    let first_manager = SubagentThreadManager::with_limits(4, 8, 3);
    let mut first_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone())
            .with_subagent_manager(first_manager);

    for subagent_id in ["delegate-1", "delegate-2"] {
        let spawn = first_router.dispatch(&WorkerRequest::new(
            format!("req-spawn-{subagent_id}"),
            "trace-subagent-restart",
            "subagent.spawn",
            json!({
                "sessionKey": "desktop:restart",
                "parentTurnId": "parent-turn",
                "subagentId": subagent_id,
                "childTurnId": format!("child-{subagent_id}"),
                "task": format!("Task for {subagent_id}"),
                "historyMode": "isolated"
            }),
        ));
        assert_eq!(spawn.error, None);
        assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);
    }
    let before_restart_input = first_router.dispatch(&WorkerRequest::new(
        "req-input-before-restart",
        "trace-subagent-restart",
        "subagent.send_input",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1",
            "content": "before restart",
            "sender": "main_agent"
        }),
    ));
    assert_eq!(before_restart_input.error, None);
    drop(first_router);

    let second_manager = SubagentThreadManager::with_limits(4, 8, 3);
    let mut second_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone())
            .with_subagent_manager(second_manager);
    let restored = second_router.dispatch(&WorkerRequest::new(
        "req-list-restored",
        "trace-subagent-restart",
        "subagent.list",
        json!({ "sessionKey": "desktop:restart" }),
    ));
    assert_eq!(restored.error, None);
    assert_eq!(
        restored.result.as_ref().unwrap()["subagents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(restored.result.as_ref().unwrap()["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|subagent| subagent["status"] == "interrupted"));

    let resumed = second_router.dispatch(&WorkerRequest::new(
        "req-resume-selected",
        "trace-subagent-restart",
        "subagent.resume",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(resumed.error, None);
    assert_eq!(resumed.result.as_ref().unwrap()["accepted"], true);
    assert_eq!(
        resumed.result.as_ref().unwrap()["subagent"]["status"],
        "running"
    );
    let after_restart_input = second_router.dispatch(&WorkerRequest::new(
        "req-input-after-restart",
        "trace-subagent-restart",
        "subagent.send_input",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1",
            "content": "after restart",
            "sender": "main_agent"
        }),
    ));
    assert_eq!(after_restart_input.error, None);

    let thread_list = second_router.dispatch(&WorkerRequest::new(
        "req-list-restarted-child-threads",
        "trace-subagent-restart",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    let delegate_thread = thread_list.result.as_ref().unwrap()["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["metadata"]["extra"]["subagentId"] == "delegate-1")
        .unwrap();
    let delegate_read = second_router.dispatch(&WorkerRequest::new(
        "req-read-restarted-child-thread",
        "trace-subagent-restart",
        "thread.read",
        json!({ "threadId": delegate_thread["threadId"] }),
    ));
    let delivered_inputs = delegate_read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"]["payload"]["sender"] == "main_agent")
        .map(|item| item["kind"]["payload"]["text"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(delivered_inputs, vec!["before restart", "after restart"]);

    let after_resume = second_router.dispatch(&WorkerRequest::new(
        "req-list-after-resume",
        "trace-subagent-restart",
        "subagent.list",
        json!({ "sessionKey": "desktop:restart" }),
    ));
    let statuses = after_resume.result.as_ref().unwrap()["subagents"]
        .as_array()
        .unwrap();
    assert_eq!(statuses[0]["status"], "running");
    assert_eq!(statuses[1]["status"], "interrupted");

    let closed = second_router.dispatch(&WorkerRequest::new(
        "req-close-selected",
        "trace-subagent-restart",
        "subagent.close",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(closed.error, None);
    assert_eq!(closed.result.as_ref().unwrap()["accepted"], true);
    drop(second_router);

    let third_manager = SubagentThreadManager::with_limits(4, 8, 3);
    let mut third_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy)
            .with_subagent_manager(third_manager);
    let closed_resume = third_router.dispatch(&WorkerRequest::new(
        "req-resume-explicitly-closed",
        "trace-subagent-restart",
        "subagent.resume",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(closed_resume.error, None);
    assert_eq!(closed_resume.result.as_ref().unwrap()["accepted"], false);
    assert_eq!(
        closed_resume.result.as_ref().unwrap()["error"]["code"],
        "forbidden"
    );
}

#[test]
fn denies_background_run_write_without_write_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::BackgroundRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-background-upsert",
        "trace-1",
        "background.run.upsert",
        json!({
            "run": {
                "id": "subagent-1",
                "kind": "subagent",
                "source": "task",
                "status": "running",
                "startedAtMs": 1000,
                "updatedAtMs": 1000
            }
        }),
    ));

    let error = response.error.expect("background write should be denied");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "background.write");
    assert!(response.result.is_none());
}
