use super::support::*;
use crate::desktop::state::NativeRuntimeState;
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
use crate::desktop_commands::skills::build_worker_skills_create_request;
use crate::desktop_commands::skills::build_worker_skills_delete_request;
use crate::desktop_commands::skills::build_worker_skills_detail_request;
use crate::desktop_commands::skills::build_worker_skills_list_request;
use crate::desktop_commands::skills::build_worker_skills_update_request;
use crate::desktop_commands::skills::build_worker_skills_validate_request;
use crate::desktop_commands::skills::worker_skills_list_with_options;
use crate::desktop_commands::webui::worker_webui_route_with_options;
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
fn worker_webui_form_route_reports_missing_checkpoint_with_rust_metadata() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

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
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

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
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

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
        &fixture.thread_store,
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
        &fixture.thread_store,
        serde_json::json!({}),
        WorkerRequest::new(
            "req-seed-agent-turn-semantic",
            "trace-seed-agent-turn-thread-log",
            "thread.turn.append_semantic_batch",
            serde_json::json!({
                "threadId": "websocket:chat-1",
                "turnId": "turn-1",
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
    let turns = list_thread_turns(
        &fixture.thread_store,
        serde_json::json!({}),
        "websocket:chat-1",
    );
    let runtime_state = read_thread_turn_runtime_state(
        &fixture.thread_store,
        serde_json::json!({}),
        "websocket:chat-1",
        "turn-1",
    );

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
fn thread_clear_removes_persisted_history() {
    let fixture = WorkspaceFixture::new();
    fixture.seed_rollout_sessions(serde_json::json!({
        "version": 1,
        "sessions": [{
            "session_id": "websocket:chat-1",
            "title": "Native thread",
            "workspace_dir": fixture.root.display().to_string(),
            "created_at": "2026-06-29T08:00:00Z",
            "updated_at": "2026-06-29T08:30:00Z",
            "extra": {
                "messages": [{ "role": "user", "content": "Clear this" }]
            }
        }]
    }));
    let before = read_thread_history(
        &fixture.thread_store,
        serde_json::json!({}),
        "websocket:chat-1",
    );
    let cleared = call_rust_state_service(
        &fixture.thread_store,
        serde_json::json!({}),
        WorkerRequest::new(
            "req-thread-clear",
            "trace-thread-clear",
            "thread.clear",
            serde_json::json!({ "threadId": "websocket:chat-1" }),
        ),
        "thread clear",
    )
    .expect("thread history should clear");
    let after = read_thread_history(
        &fixture.thread_store,
        serde_json::json!({}),
        "websocket:chat-1",
    );

    assert_eq!(before["messages"].as_array().map(Vec::len), Some(1));
    assert_eq!(cleared["messagesBefore"], 1);
    assert_eq!(cleared["messagesAfter"], 0);
    assert_eq!(after["messages"].as_array().map(Vec::len), Some(0));
}

#[test]
fn worker_webui_tools_route_returns_effective_catalog() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

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
fn worker_webui_route_serves_rust_owned_routes_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    fixture.write("docs/readme.md", "hello route");
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

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
    assert_eq!(workspace_file["body"]["content"], "hello route");
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
}

#[test]
fn worker_webui_route_rejects_removed_openai_and_unknown_routes() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

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
    .expect("removed chat route should return a structured response");
    let models = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/v1/models".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("removed models route should return a structured response");
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

    assert_eq!(chat["status"], 404);
    assert_eq!(chat["headers"]["x-tinybot-route-owner"], "unsupported");
    assert_eq!(chat["headers"]["x-tinybot-route-group"], "openai");
    assert_eq!(chat["body"]["diagnostic"], "unsupported-route");
    assert_eq!(chat["body"]["inventoryStatus"], "not-inventoried");
    assert_eq!(chat["body"]["method"], "POST");
    assert_eq!(chat["body"]["path"], "/v1/chat/completions");
    assert_eq!(models["status"], 404);
    assert_eq!(models["headers"]["x-tinybot-route-owner"], "unsupported");
    assert_eq!(models["headers"]["x-tinybot-route-group"], "openai");
    assert_eq!(models["body"]["diagnostic"], "unsupported-route");
    assert_eq!(models["body"]["inventoryStatus"], "not-inventoried");
    assert_eq!(models["body"]["method"], "GET");
    assert_eq!(models["body"]["path"], "/v1/models");
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
fn worker_webui_route_rejects_removed_config_routes() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

    for method in ["GET", "PATCH"] {
        let response = worker_webui_route_with_options(
            &shared,
            WorkerWebuiRouteInput {
                method: method.to_string(),
                path: "/api/config".to_string(),
                headers: None,
                body: None,
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_millis(10),
        )
        .expect("removed config route should return a structured response");

        assert_eq!(response["status"], 404);
        assert_eq!(response["headers"]["x-tinybot-route-owner"], "unsupported");
        assert_eq!(response["body"]["diagnostic"], "unsupported-route");
        assert_eq!(response["body"]["inventoryStatus"], "not-inventoried");
        assert_eq!(response["body"]["routeGroup"], "unsupported");
        assert_eq!(response["body"]["method"], method);
        assert_eq!(response["body"]["path"], "/api/config");
    }
}

#[test]
fn worker_webui_route_rejects_removed_session_routes() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

    for (method, path) in [
        ("GET", "/api/sessions"),
        ("POST", "/api/sessions/branch"),
        ("GET", "/api/sessions/thread-1/messages"),
        ("GET", "/api/sessions/thread-1/effective-capabilities"),
        ("POST", "/api/sessions/thread-1/clear"),
        ("PATCH", "/api/sessions/thread-1"),
        ("DELETE", "/api/sessions/thread-1"),
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
        .expect("removed Session route should return a structured response");

        assert_eq!(response["status"], 404);
        assert_eq!(response["headers"]["x-tinybot-route-owner"], "unsupported");
        assert_eq!(response["body"]["diagnostic"], "unsupported-route");
        assert_eq!(response["body"]["inventoryStatus"], "not-inventoried");
        assert_eq!(response["body"]["routeGroup"], "unsupported");
        assert_eq!(response["body"]["method"], method);
        assert_eq!(response["body"]["path"], path);
    }
}

#[test]
fn worker_webui_route_rejects_removed_bootstrap_and_status_routes() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

    for (method, path) in [
        ("GET", "/health"),
        ("GET", "/webui/bootstrap"),
        ("POST", "/webui/refresh-token"),
        ("GET", "/api/status"),
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
        .expect("removed bootstrap/status route should return a structured response");

        assert_eq!(response["status"], 404);
        assert_eq!(response["headers"]["x-tinybot-route-owner"], "unsupported");
        assert_eq!(response["body"]["diagnostic"], "unsupported-route");
        assert_eq!(response["body"]["inventoryStatus"], "not-inventoried");
        assert_eq!(response["body"]["routeGroup"], "unsupported");
        assert_eq!(response["body"]["method"], method);
        assert_eq!(response["body"]["path"], path);
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
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));
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
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));
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
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));

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
