use super::support::*;
use crate::desktop::state::GatewayRuntime;
use crate::desktop_commands::agent::build_worker_background_subagent_enqueue_input_request;
use crate::desktop_commands::agent::build_worker_background_trace_get_artifact_request;
use crate::desktop_commands::agent::build_worker_background_trace_get_delegate_trace_request;
use crate::desktop_commands::agent::build_worker_background_trace_list_request;
use crate::desktop_commands::agent::worker_background_subagent_enqueue_input_with_options;
use crate::desktop_commands::agent::worker_background_trace_append_with_options;
use crate::desktop_commands::agent::worker_background_trace_list_with_options;
use crate::desktop_commands::agent::worker_task_plan_delete_with_options;
use crate::desktop_commands::agent::worker_task_plan_get_with_options;
use crate::desktop_commands::agent::worker_task_plan_list_with_options;
use crate::desktop_commands::agent::worker_task_plan_save_with_options;
use crate::desktop_commands::agent::WorkerBackgroundSubagentInputInput;
use crate::desktop_commands::agent::WorkerBackgroundTraceAppendInput;
use crate::desktop_commands::agent::WorkerBackgroundTraceGetArtifactInput;
use crate::desktop_commands::agent::WorkerBackgroundTraceGetDelegateTraceInput;
use crate::desktop_commands::agent::WorkerBackgroundTraceListInput;
use crate::desktop_commands::agent::WorkerTaskPlanListInput;
use crate::desktop_commands::session::worker_session_branch_with_options;
use crate::desktop_commands::session::worker_session_clear_with_options;
use crate::desktop_commands::session::worker_session_delete_with_options;
use crate::desktop_commands::session::worker_session_messages_with_options;
use crate::desktop_commands::session::worker_session_patch_with_options;
use crate::desktop_commands::session::worker_session_task_progress_with_options;
use crate::desktop_commands::session::worker_sessions_list_with_options;
use crate::desktop_commands::session::worker_turn_runtime_state_with_options;
use crate::desktop_commands::session::worker_turns_list_with_options;
use crate::desktop_commands::skills::build_worker_skills_create_request;
use crate::desktop_commands::skills::build_worker_skills_delete_request;
use crate::desktop_commands::skills::build_worker_skills_detail_request;
use crate::desktop_commands::skills::build_worker_skills_list_request;
use crate::desktop_commands::skills::build_worker_skills_update_request;
use crate::desktop_commands::skills::build_worker_skills_validate_request;
use crate::desktop_commands::skills::worker_skills_list_with_options;
use crate::desktop_commands::webui::worker_cowork_route_with_options;
use crate::desktop_commands::webui::worker_webui_route_with_options;
use crate::desktop_commands::webui::WorkerCoworkRouteInput;
use crate::desktop_commands::webui::WorkerWebuiRouteInput;
use crate::desktop_commands::workspace::worker_workspace_file_with_options;
use crate::desktop_commands::workspace::worker_workspace_files_with_options;
use crate::desktop_commands::workspace::worker_workspace_put_file_with_options;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

#[test]
fn worker_webui_approval_and_form_routes_report_missing_checkpoints_with_rust_metadata() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    let approval = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/approvals/missing-approval/approve".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "session_key": "websocket:missing-approval"
            })),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("missing approval route should return Rust diagnostic");
    let form = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/agent-ui/forms/missing-form/submit".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "correlation": { "session_key": "websocket:missing-form" },
                "values": {}
            })),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("missing form route should return Rust diagnostic");

    assert_eq!(approval["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(approval["headers"]["x-tinybot-route-group"], "approvals");
    assert_eq!(approval["body"]["ok"], false);
    assert_eq!(approval["body"]["status"], "not_found");
    assert_eq!(
        approval["body"]["error"]["message"],
        "pending approval not found"
    );
    assert_eq!(form["status"], 404);
    assert_eq!(form["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(form["headers"]["x-tinybot-route-group"], "agent-ui");
    assert_eq!(form["body"]["submitted"], false);
    assert_eq!(form["body"]["error"], "pending form checkpoint not found");
}

#[test]
fn worker_skills_requests_target_rust_webui_skill_methods() {
    let list_request = build_worker_skills_list_request(test_request_correlation("42"));
    let detail_request = build_worker_skills_detail_request(
        test_request_correlation("43"),
        "planner/phase".to_string(),
    );
    let create_request = build_worker_skills_create_request(
        test_request_correlation("44"),
        serde_json::json!({ "name": "planner" }),
    );
    let update_request = build_worker_skills_update_request(
        test_request_correlation("45"),
        "planner/phase".to_string(),
        serde_json::json!({ "content": "Updated" }),
    );
    let delete_request = build_worker_skills_delete_request(
        test_request_correlation("46"),
        "planner/phase".to_string(),
    );
    let validate_request = build_worker_skills_validate_request(
        test_request_correlation("47"),
        "planner/phase".to_string(),
    );

    assert_eq!(list_request.id, "skills-list-42");
    assert_eq!(list_request.trace_id, "trace-skills-list-42");
    assert_eq!(list_request.method, "skills.webui_list");
    assert_eq!(list_request.params, serde_json::json!({}));
    assert_eq!(detail_request.id, "skills-detail-43");
    assert_eq!(detail_request.trace_id, "trace-skills-detail-43");
    assert_eq!(detail_request.method, "skills.webui_detail");
    assert_eq!(
        detail_request.params,
        serde_json::json!({ "name": "planner/phase" })
    );
    assert_eq!(create_request.id, "skills-create-44");
    assert_eq!(create_request.trace_id, "trace-skills-create-44");
    assert_eq!(create_request.method, "skills.webui_create");
    assert_eq!(
        create_request.params,
        serde_json::json!({ "body": { "name": "planner" } })
    );
    assert_eq!(update_request.id, "skills-update-45");
    assert_eq!(update_request.trace_id, "trace-skills-update-45");
    assert_eq!(update_request.method, "skills.webui_update");
    assert_eq!(
        update_request.params,
        serde_json::json!({ "name": "planner/phase", "body": { "content": "Updated" } })
    );
    assert_eq!(delete_request.id, "skills-delete-46");
    assert_eq!(delete_request.trace_id, "trace-skills-delete-46");
    assert_eq!(delete_request.method, "skills.webui_delete");
    assert_eq!(
        delete_request.params,
        serde_json::json!({ "name": "planner/phase" })
    );
    assert_eq!(validate_request.id, "skills-validate-47");
    assert_eq!(validate_request.trace_id, "trace-skills-validate-47");
    assert_eq!(validate_request.method, "skills.webui_validate");
    assert_eq!(
        validate_request.params,
        serde_json::json!({ "name": "planner/phase" })
    );
}

#[test]
fn worker_skills_list_reads_rust_workspace() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
        "skills/planner/SKILL.md",
        "---\nname: planner\ndescription: Plan work\n---\nPlan.",
    );
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_skills_list_with_options(
        &shared,
        fixture.root.clone(),
        serde_json::json!({ "skills": { "enabled": ["planner"] } }),
        Duration::from_millis(10),
    )
    .expect("skills list should be served by Rust workspace state");

    assert_eq!(result["skills"][0]["name"], "planner");
    assert_eq!(result["skills"][0]["description"], "Plan work");
    assert_eq!(result["skills"][0]["enabled"], true);
}

#[test]
fn worker_workspace_file_commands_use_rust_workspace() {
    let fixture = WorkspaceFixture::new();
    fixture.write("docs/readme.md", "old readme");
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let files = worker_workspace_files_with_options(
        &shared,
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("workspace files should be served by Rust workspace state");
    let file = worker_workspace_file_with_options(
        &shared,
        "docs/readme.md".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("workspace file should be served by Rust workspace state");
    let write = worker_workspace_put_file_with_options(
        &shared,
        "docs/readme.md".to_string(),
        serde_json::json!({ "content": "new readme", "expected_updated_at": null }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("workspace write should be served by Rust workspace state");

    assert_eq!(files["items"][0]["path"], "docs/readme.md");
    assert_eq!(file["path"], "docs/readme.md");
    assert_eq!(file["content"], "old readme");
    assert_eq!(write["path"], "docs/readme.md");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("docs").join("readme.md"))
            .expect("written file should read"),
        "new readme"
    );
}

#[test]
fn worker_session_read_commands_use_rollout_state() {
    let fixture = WorkspaceFixture::new();
    fixture.seed_rollout_sessions(serde_json::json!({
        "version": 1,
        "sessions": [{
            "session_id": "websocket:chat-1",
            "title": "Native session",
            "workspace_dir": "D:/Code/py/tinybot",
            "created_at": "2026-06-29T08:00:00Z",
            "updated_at": "2026-06-29T08:30:00Z",
            "extra": {
                "messages": [
                    {
                        "role": "user",
                        "content": "Use Rust state",
                        "message_id": "msg-1",
                        "timestamp": "2026-06-29T08:00:01Z"
                    }
                ]
            }
        }]
    }));
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let sessions = worker_sessions_list_with_options(
        &shared,
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session list should be served by Rust session state");
    let messages = worker_session_messages_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session messages should be served by Rust session state");

    assert_eq!(sessions["items"][0]["key"], "websocket:chat-1");
    assert_eq!(sessions["items"][0]["chat_id"], "chat-1");
    assert_eq!(sessions["items"][0]["title"], "Native session");
    assert_eq!(messages["key"], "websocket:chat-1");
    assert_eq!(messages["chat_id"], "chat-1");
    assert_eq!(messages["messages"][0]["content"], "Use Rust state");
}

#[test]
fn worker_agent_turn_runtime_commands_use_thread_log_turn_store() {
    let fixture = WorkspaceFixture::new();
    let record = serde_json::json!({
        "sessionId": "websocket:chat-1",
        "turnId": "turn-1",
        "status": "completed",
        "phase": "completed",
        "startedAt": "2026-07-03T01:00:00Z",
        "updatedAt": "2026-07-03T01:00:02Z",
        "completedAt": "2026-07-03T01:00:02Z",
        "stopReason": "stop",
        "model": "test-model",
        "provider": "test",
        "maxIterations": 4,
        "currentIteration": 1,
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });
    call_rust_state_service(
        fixture.root.clone(),
        serde_json::json!({}),
        WorkerRequest::new(
            "req-seed-agent-turn-thread-log",
            "trace-seed-agent-turn-thread-log",
            "thread.turn.start",
            serde_json::json!({ "record": record }),
        ),
        "agent turn thread log seed",
    )
    .expect("agent turn should seed thread log store");
    call_rust_state_service(
        fixture.root.clone(),
        serde_json::json!({}),
        WorkerRequest::new(
            "req-seed-agent-turn-semantic",
            "trace-seed-agent-turn-thread-log",
            "thread.turn.append_semantic_batch",
            serde_json::json!({
                "session_id": "websocket:chat-1",
                "turn_id": "turn-1",
                "events": [{
                    "schemaVersion": "tinybot.agent_event.v1",
                    "eventId": "turn-1:agent-done:0000000000000001",
                    "sequence": 1,
                    "sessionId": "websocket:chat-1",
                    "turnId": "turn-1",
                    "itemId": "turn-1:assistant",
                    "eventName": "agent.message.completed",
                    "phase": "completed",
                    "timestamp": "2026-07-03T01:00:02Z",
                    "source": "rust_backend",
                    "visibility": "user",
                    "payload": {
                        "content": "Done from runtime state",
                        "messageId": "turn-1:assistant",
                        "messagePhase": "final_answer"
                    }
                }]
            }),
        ),
        "agent turn semantic seed",
    )
    .expect("agent turn semantic records should seed thread log store");
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let turns = worker_turns_list_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("agent turn list should be served by thread log store");
    let runtime_state = worker_turn_runtime_state_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        "turn-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("agent turn runtime state should be served by thread log store");

    assert_eq!(turns["turns"][0]["turnId"], "turn-1");
    assert_eq!(runtime_state["timeline"]["sessionId"], "websocket:chat-1");
    assert_eq!(runtime_state["timeline"]["turnId"], "turn-1");
    assert_eq!(
        runtime_state["timeline"]["items"][0]["kind"],
        "assistant_message"
    );
    assert_eq!(
        runtime_state["timeline"]["items"][0]["data"]["content"],
        "Done from runtime state"
    );
}

#[test]
fn worker_session_write_commands_use_rollout_state_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    fixture.seed_rollout_sessions(serde_json::json!({
        "version": 1,
        "sessions": [{
            "session_id": "websocket:chat-1",
            "title": "Native session",
            "workspace_dir": "D:/Code/py/tinybot",
            "created_at": "2026-06-29T08:00:00Z",
            "updated_at": "2026-06-29T08:30:00Z",
            "extra": {
                "messages": [{ "role": "user", "content": "Keep this" }],
                "metadata": { "pinned": false }
            }
        }]
    }));
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let patch = worker_session_patch_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        serde_json::json!({ "metadata": { "pinned": true } }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session patch should be served by Rust session state");
    let cleared_session = worker_session_clear_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session clear should be served by Rust session state");
    let progress = worker_session_task_progress_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        serde_json::json!({
            "turnId": "turn-task-progress-1",
            "planId": "plan-1",
            "progress": {
                "completed": 1,
                "total": 2,
                "steps": [
                    { "step": "Inspect session", "status": "completed" },
                    { "step": "Finish session", "status": "in_progress" }
                ]
            },
            "content": "Half done"
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("task progress should be served by Rust session state");
    let deleted = worker_session_delete_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session delete should be served by Rust session state");

    assert_eq!(patch["key"], "websocket:chat-1");
    assert_eq!(patch["metadata"]["pinned"], true);
    assert_eq!(cleared_session["messages_before"], 1);
    assert_eq!(progress["key"], "websocket:chat-1");
    assert_eq!(
        progress["extra"]["messages"][0]["_task_progress"]["completed"],
        1
    );
    assert_eq!(deleted["key"], "websocket:chat-1");
    assert_eq!(deleted["deleted"], true);
}

#[test]
fn worker_session_branch_creates_new_session_without_runtime_state() {
    let fixture = WorkspaceFixture::new();
    fixture.seed_rollout_sessions(serde_json::json!({
        "version": 1,
        "sessions": [{
            "session_id": "websocket:chat-1",
            "title": "Source session",
            "workspace_dir": "D:/Code/py/tinybot",
            "created_at": "2026-06-29T08:00:00Z",
            "updated_at": "2026-06-29T08:30:00Z",
            "extra": {
                "messages": [{ "role": "user", "content": "Keep this", "message_id": "m1" }],
                "runtime_checkpoint": { "phase": "running" }
            }
        }]
    }));
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let branch = worker_session_branch_with_options(
        &shared,
        serde_json::json!({
            "title": "Source session · 分叉",
            "branchedFromSessionId": "websocket:chat-1",
            "branchedFromMessageId": "m1",
            "messages": [
                { "messageId": "m1", "role": "user", "content": "Keep this" },
                { "messageId": "m2", "role": "assistant", "content": "Use this point" }
            ],
            "portableContext": {
                "chatId": "chat-1",
                "sessionKey": "websocket:chat-1"
            },
            "runtimeState": {
                "queuedInputs": [{ "id": "queued-1" }],
                "pendingApprovals": [{ "id": "approval-1" }]
            }
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("branch session should be created by Rust session state");
    let branch_key = branch["key"].as_str().expect("branch should include key");
    let history = worker_session_messages_with_options(
        &shared,
        branch_key.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("branch history should be readable");

    assert!(branch_key.starts_with("websocket:branch-"));
    assert_eq!(branch["title"], "Source session · 分叉");
    assert_eq!(history["messages"][0]["content"], "Keep this");
    assert_eq!(history["messages"][1]["content"], "Use this point");
    assert_eq!(
        history["branch"]["branchedFromSessionId"],
        "websocket:chat-1"
    );
    assert_eq!(history["branch"]["branchedFromMessageId"], "m1");
    assert_eq!(history["branch"]["portableContext"]["chatId"], "chat-1");
    assert!(history["runtimeState"].is_null());
    assert!(history["runtime_checkpoint"].is_null());
}

#[test]
fn worker_cowork_route_serves_rust_sessions_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let created = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "POST".to_string(),
            path: "/api/cowork/sessions".to_string(),
            body: Some(serde_json::json!({
                "goal": "Plan the Rust migration",
                "title": "Rust migration"
            })),
            query: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork create route should be Rust-owned");
    let session_id = created["body"]["id"]
        .as_str()
        .expect("created cowork session should include id")
        .to_string();
    let listed = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "GET".to_string(),
            path: "/api/cowork/sessions".to_string(),
            body: None,
            query: Some(serde_json::json!({ "include_completed": "true" })),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork list route should be Rust-owned");
    let trace = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "GET".to_string(),
            path: format!("/api/cowork/sessions/{session_id}/trace"),
            body: None,
            query: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork trace route should be Rust-owned");
    let run = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "POST".to_string(),
            path: format!("/api/cowork/sessions/{session_id}/run"),
            body: Some(serde_json::json!({ "delegateId": "delegate-rust" })),
            query: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork run route should be Rust-owned");
    let task = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "POST".to_string(),
            path: format!("/api/cowork/sessions/{session_id}/tasks"),
            body: Some(serde_json::json!({ "id": "task-rust", "title": "Rust task" })),
            query: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork task route should be Rust-owned");
    let budget = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "PATCH".to_string(),
            path: format!("/api/cowork/sessions/{session_id}/budget"),
            body: Some(serde_json::json!({ "max_spawned_agents": 1 })),
            query: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork budget route should be Rust-owned");
    let activity = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "GET".to_string(),
            path: format!("/api/cowork/sessions/{session_id}/agents/delegate-rust/activity"),
            body: None,
            query: Some(serde_json::json!({ "limit": "10" })),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork agent activity route should be Rust-owned");
    let blueprint = worker_cowork_route_with_options(
        &shared,
        WorkerCoworkRouteInput {
            method: "POST".to_string(),
            path: "/api/cowork/blueprints/validate".to_string(),
            body: Some(serde_json::json!({ "title": "Rust blueprint" })),
            query: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Cowork blueprint route should be Rust-owned");

    assert_eq!(created["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(listed["body"]["sessions"][0]["id"], session_id);
    assert_eq!(trace["body"]["events"][0]["type"], "session.created");
    assert_eq!(
        run["body"]["agents"]["delegate-rust"]["status"],
        "completed"
    );
    assert_eq!(task["body"]["id"], "task-rust");
    assert_eq!(budget["body"]["budget_limits"]["max_spawned_agents"], 1);
    assert_eq!(activity["body"]["agent_id"], "delegate-rust");
    assert_eq!(blueprint["body"]["valid"], true);
}

#[test]
fn worker_webui_tools_route_returns_effective_catalog() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let response = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/tools".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_secs(1),
    )
    .expect("tools route should be Rust-owned");

    assert_eq!(response["status"], 200);
    assert_eq!(response["headers"]["x-tinybot-route-owner"], "rust");
    assert!(response["body"]["total"]
        .as_u64()
        .is_some_and(|total| total > 0));
    assert!(response["body"]["tools"].as_array().is_some());
    assert_eq!(response["body"]["mcpServers"], serde_json::json!([]));
}

#[test]
fn worker_webui_route_serves_rust_owned_state_routes_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    fixture.write("docs/readme.md", "hello route");
    fixture.seed_rollout_sessions(serde_json::json!({
        "version": 1,
        "sessions": [{
            "session_id": "websocket:chat-1",
            "title": "Route session",
            "workspace_dir": "D:/Code/py/tinybot",
            "created_at": "2026-06-29T08:00:00Z",
            "updated_at": "2026-06-29T08:30:00Z",
            "extra": { "messages": [{ "role": "user", "content": "route" }] }
        }]
    }));
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let bootstrap = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/webui/bootstrap".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({ "agents": { "defaults": { "provider": "auto" } } }),
        Duration::from_millis(10),
    )
    .expect("bootstrap route should be Rust-owned");
    let sessions = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/sessions".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session route should be Rust-owned");
    let effective_capabilities = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/sessions/websocket%3Achat-1/effective-capabilities".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("effective capabilities route should be Rust-owned");
    let branch = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/sessions/branch".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "title": "Route session · 分叉",
                "branchedFromSessionId": "websocket:chat-1",
                "branchedFromMessageId": "route-m1",
                "messages": [{
                    "messageId": "route-m1",
                    "role": "user",
                    "content": "route"
                }],
                "portableContext": { "chatId": "chat-1" }
            })),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session branch route should be Rust-owned");
    let workspace_file = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/workspace/files/docs%2Freadme.md".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("workspace route should be Rust-owned");
    let approvals = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/approvals?session_key=websocket%3Achat-1".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("approvals list route should be Rust-owned");
    let providers = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/providers".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({
            "providers": {
                "openai": {
                    "api_key": "sk-secret",
                    "api_base": "https://example.test/v1"
                }
            }
        }),
        Duration::from_millis(10),
    )
    .expect("providers route should be Rust-owned");
    let provider_models = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/provider-models".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "provider": "openai",
                "manual_models": "manual-model",
                "refreshLive": true,
                "liveModelIds": ["live-model"]
            })),
        },
        fixture.root.clone(),
        serde_json::json!({
            "providers": {
                "openai": {
                    "api_key": "sk-secret",
                    "models": ["profile-model"]
                }
            }
        }),
        Duration::from_millis(10),
    )
    .expect("provider models route should be Rust-owned");
    let openai_models = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/v1/models".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({
            "agents": { "defaults": { "model": "gpt-4.1-mini" } }
        }),
        Duration::from_millis(10),
    )
    .expect("OpenAI models route should be Rust-owned");
    let approval_resolution = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/approvals/approval%2F1/approve".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "session_key": "websocket:chat-1",
                "scope": "session"
            })),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("approval resolution route should be Rust-owned");

    assert_eq!(bootstrap["status"], 200);
    assert_eq!(bootstrap["headers"]["x-tinybot-route-owner"], "rust");
    assert!(bootstrap["body"]["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));
    assert_eq!(sessions["body"]["items"][0]["title"], "Route session");
    assert_eq!(
        effective_capabilities["headers"]["x-tinybot-route-owner"],
        "rust"
    );
    assert_eq!(
        effective_capabilities["body"]["schemaVersion"],
        "tinybot.effective_capabilities.v1"
    );
    assert_eq!(
        effective_capabilities["body"]["capabilities"]["agent"]["cancel"]["reasonCode"],
        "no_active_turn"
    );
    assert_eq!(branch["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(branch["body"]["title"], "Route session · 分叉");
    assert_eq!(workspace_file["body"]["content"], "hello route");
    assert_eq!(approvals["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(approvals["headers"]["x-tinybot-route-group"], "approvals");
    assert_eq!(approvals["body"]["session_key"], "websocket:chat-1");
    assert_eq!(providers["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(providers["headers"]["x-tinybot-route-group"], "providers");
    assert_eq!(providers["body"]["source"], "rust");
    assert_eq!(
        providers["body"]["providers"][0]["api_key_configured"],
        true
    );
    assert!(providers["body"]["providers"][0].get("api_key").is_none());
    assert_eq!(provider_models["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(provider_models["body"]["ok"], true);
    assert!(provider_models["body"]["models"]
        .as_array()
        .expect("models should be an array")
        .iter()
        .any(|model| model == "live-model"));
    assert_eq!(openai_models["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(openai_models["body"]["data"][0]["id"], "gpt-4.1-mini");
    assert_eq!(
        approval_resolution["headers"]["x-tinybot-route-owner"],
        "rust"
    );
    assert_eq!(approval_resolution["body"]["approvalId"], "approval/1");
    assert_eq!(approval_resolution["body"]["approved"], true);
    assert_eq!(approval_resolution["body"]["status"], "not_found");
}

#[test]
fn worker_webui_route_classifies_rust_owned_chat_and_unsupported_routes_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let chat = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "messages": [{ "role": "user", "content": "hello" }],
                "stream": true
            })),
        },
        fixture.root.clone(),
        serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "route stream" }] } }
        }),
        Duration::from_millis(10),
    )
    .expect("chat route should be Rust-owned");
    let unsupported = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/not-a-route".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("unsupported route should return a structured response");

    assert_eq!(chat["status"], 200);
    assert_eq!(chat["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(chat["headers"]["x-tinybot-route-group"], "openai");
    assert_eq!(chat["headers"]["content-type"], "text/event-stream");
    assert!(chat["body"]
        .as_str()
        .expect("streaming chat route should return text/event-stream body")
        .contains("route stream"));
    assert_eq!(unsupported["status"], 404);
    assert_eq!(
        unsupported["headers"]["x-tinybot-route-owner"],
        "unsupported"
    );
    assert_eq!(unsupported["body"]["diagnostic"], "unsupported-route");
    assert_eq!(unsupported["body"]["inventoryStatus"], "not-inventoried");
    assert_eq!(unsupported["body"]["routeGroup"], "unsupported");
    assert_eq!(unsupported["body"]["method"], "GET");
    assert_eq!(unsupported["body"]["path"], "/api/not-a-route");
}

#[test]
fn worker_webui_known_unsupported_routes_keep_targeted_policy_metadata() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    for (method, path, route_group) in [
        ("PATCH", "/api/config", "config"),
        ("GET", "/api/cowork/not-implemented", "cowork"),
    ] {
        let response = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: method.to_string(),
                path: path.to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("known unsupported route should return a targeted response");

        assert_eq!(response["status"], 501);
        assert_eq!(response["body"]["inventoryStatus"], "unsupported");
        assert_eq!(response["body"]["routeGroup"], route_group);
        assert!(response["body"]["reason"].is_string());
        assert!(response["body"]["replacementPlan"].is_string());
    }
}

#[test]
fn worker_background_trace_list_request_wraps_filter_for_background_rpc() {
    let request = build_worker_background_trace_list_request(
        test_request_correlation("42"),
        WorkerBackgroundTraceListInput {
            filter: serde_json::json!({ "sessionKey": "WebSocket:chat-1" }),
        },
    );

    assert_eq!(request.id, "background-trace-list-42");
    assert_eq!(request.trace_id, "trace-background-trace-list-42");
    assert_eq!(request.method, "background.trace.list");
    assert_eq!(
        request.params,
        serde_json::json!({ "filter": { "sessionKey": "WebSocket:chat-1" } })
    );
}

#[test]
fn worker_background_trace_list_reads_rust_registry_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let append = worker_background_trace_append_with_options(
        &shared,
        WorkerBackgroundTraceAppendInput {
            event: serde_json::json!({
                "eventId": "event-1",
                "eventType": "agent.delegate.started",
                "sessionKey": "WebSocket:chat-1",
                "turnId": "turn-1",
                "delegateId": "delegate-1",
                "childTurnId": "delegate-1",
                "traceRef": "trace-ref-1",
                "sequence": 1,
                "createdAt": "2026-06-29T02:25:30.000Z",
                "payload": { "status": "running" }
            }),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("trace append should write the Rust background registry without starting TS worker");

    let result = worker_background_trace_list_with_options(
        &shared,
        WorkerBackgroundTraceListInput {
            filter: serde_json::json!({ "sessionKey": "WebSocket:chat-1" }),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("trace list should read the Rust background registry without starting TS worker");

    assert_eq!(append["event"]["eventId"], "event-1");
    assert_eq!(result["events"][0]["eventId"], "event-1");
    assert_eq!(result["events"][0]["delegateId"], "delegate-1");
}

#[test]
fn worker_task_plan_commands_use_rust_store() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let plan = serde_json::json!({
        "id": "plan-1",
        "title": "Move state service",
        "status": "active",
        "subtasks": [
            { "id": "task-1", "title": "Persist through Rust", "status": "done" }
        ]
    });

    let saved = worker_task_plan_save_with_options(
        &shared,
        plan.clone(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("task plan save should use Rust task store without starting TS worker");
    let listed = worker_task_plan_list_with_options(
        &shared,
        WorkerTaskPlanListInput {
            include_completed: false,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("task plan list should use Rust task store without starting TS worker");
    let loaded = worker_task_plan_get_with_options(
        &shared,
        "plan-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("task plan get should use Rust task store without starting TS worker");
    let deleted = worker_task_plan_delete_with_options(
        &shared,
        "plan-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("task plan delete should use Rust task store without starting TS worker");
    let missing = worker_task_plan_get_with_options(
        &shared,
        "plan-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("deleted task plan lookup should still be served by Rust task store");

    assert_eq!(saved["plan"], plan);
    assert_eq!(listed["plans"][0]["id"], "plan-1");
    assert_eq!(loaded["plan"]["title"], "Move state service");
    assert_eq!(deleted["deleted"], true);
    assert_eq!(missing["plan"], serde_json::Value::Null);
}

#[test]
fn worker_background_trace_get_delegate_trace_request_wraps_filter_for_background_rpc() {
    let request = build_worker_background_trace_get_delegate_trace_request(
        test_request_correlation("42"),
        WorkerBackgroundTraceGetDelegateTraceInput {
            filter: serde_json::json!({
                "sessionKey": "WebSocket:chat-1",
                "delegateId": "delegate-1"
            }),
        },
    );

    assert_eq!(request.id, "background-trace-get-delegate-trace-42");
    assert_eq!(
        request.trace_id,
        "trace-background-trace-get-delegate-trace-42"
    );
    assert_eq!(request.method, "background.trace.get_delegate_trace");
    assert_eq!(
        request.params,
        serde_json::json!({
            "filter": {
                "sessionKey": "WebSocket:chat-1",
                "delegateId": "delegate-1"
            }
        })
    );
}

#[test]
fn worker_background_trace_get_artifact_request_wraps_filter_for_background_rpc() {
    let request = build_worker_background_trace_get_artifact_request(
        test_request_correlation("42"),
        WorkerBackgroundTraceGetArtifactInput {
            filter: serde_json::json!({
                "sessionKey": "WebSocket:chat-1",
                "delegateId": "delegate-1",
                "artifactId": "artifact-1"
            }),
        },
    );

    assert_eq!(request.id, "background-trace-get-artifact-42");
    assert_eq!(request.trace_id, "trace-background-trace-get-artifact-42");
    assert_eq!(request.method, "background.trace.get_artifact");
    assert_eq!(
        request.params,
        serde_json::json!({
            "filter": {
                "sessionKey": "WebSocket:chat-1",
                "delegateId": "delegate-1",
                "artifactId": "artifact-1"
            }
        })
    );
}

#[test]
fn worker_background_subagent_enqueue_input_request_wraps_subagent_payload() {
    let request = build_worker_background_subagent_enqueue_input_request(
        test_request_correlation("42"),
        WorkerBackgroundSubagentInputInput {
            session_key: "WebSocket:chat-1".to_string(),
            subagent_id: "delegate-1".to_string(),
            content: "Use the safer option.".to_string(),
            turn_id: Some("turn-1".to_string()),
            trace_ref: Some("trace-1".to_string()),
            child_turn_id: Some("turn-1".to_string()),
            created_at: Some("2026-06-29T02:25:31.000Z".to_string()),
            metadata: serde_json::json!({ "surface": "rebuilt-chat" }),
        },
    );

    assert_eq!(request.id, "background-subagent-enqueue-input-42");
    assert_eq!(
        request.trace_id,
        "trace-background-subagent-enqueue-input-42"
    );
    assert_eq!(request.method, "background.subagent.enqueue_input");
    assert_eq!(
        request.params,
        serde_json::json!({
            "sessionKey": "WebSocket:chat-1",
            "subagentId": "delegate-1",
            "content": "Use the safer option.",
            "turnId": "turn-1",
            "traceRef": "trace-1",
            "childTurnId": "turn-1",
            "createdAt": "2026-06-29T02:25:31.000Z",
            "metadata": { "surface": "rebuilt-chat" }
        })
    );
}

#[test]
fn worker_background_subagent_enqueue_input_writes_rust_registry() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_background_subagent_enqueue_input_with_options(
        &shared,
        WorkerBackgroundSubagentInputInput {
            session_key: "WebSocket:chat-1".to_string(),
            subagent_id: "delegate-1".to_string(),
            content: "Use the safer option.".to_string(),
            turn_id: Some("turn-1".to_string()),
            trace_ref: Some("trace-1".to_string()),
            child_turn_id: Some("turn-1".to_string()),
            created_at: Some("2026-06-29T02:25:31.000Z".to_string()),
            metadata: serde_json::json!({ "surface": "rebuilt-chat" }),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("subagent input enqueue should write the Rust background registry");

    assert_eq!(result["accepted"], true);
    assert_eq!(result["delivery"], "queued_for_runtime");
    assert_eq!(
        result["event"]["eventType"],
        "agent.delegate.message_queued"
    );
    assert_eq!(result["event"]["delegateId"], "delegate-1");
    assert_eq!(
        result["event"]["payload"]["content"],
        "Use the safer option."
    );
}
