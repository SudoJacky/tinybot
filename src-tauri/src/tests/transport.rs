use super::support::*;
use crate::desktop::state::lock_runtime;
use crate::desktop::state::GatewayRuntime;
use crate::desktop_commands::agent::worker_run_agent_with_options;
use crate::desktop_commands::session::worker_agent_run_runtime_state_with_options;
use crate::desktop_commands::session::worker_agent_runs_list_with_options;
use crate::desktop_commands::transport::native_websocket_transport_result;
use crate::desktop_commands::transport::validate_tinyos_host_command_frame;
use crate::desktop_commands::transport::worker_transport_dispatch_websocket_message_with_options;
use crate::desktop_commands::transport::WorkerTransportWebSocketDispatchInput;
use crate::protocol::capability::default_desktop_capability_policy;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

#[test]
fn tinyos_host_command_interface_rejects_chat_frames() {
    let chat_frames = [
        serde_json::json!({ "type": "new_chat" }),
        serde_json::json!({ "type": "message", "content": "hello" }),
        serde_json::json!({ "type": "interrupt" }),
    ];
    for frame in chat_frames {
        let error = validate_tinyos_host_command_frame(&frame)
            .expect_err("chat frames must use the typed Thread interface");
        assert!(error.contains("accepts only TinyOS host commands"));
    }

    for command_kind in [
        "agent.cancel",
        "approval.resolve",
        "form.submit",
        "form.cancel",
    ] {
        let error = validate_tinyos_host_command_frame(&serde_json::json!({
            "type": "command",
            "command_kind": command_kind,
        }))
        .expect_err("chat control commands must use the typed Thread interface");
        assert!(error.contains("typed Thread API"));
    }
}

#[test]
fn worker_transport_websocket_maps_controlled_host_commands() {
    let file = native_websocket_transport_result(&WorkerTransportWebSocketDispatchInput {
        client_id: "client-1".to_string(),
        frame: serde_json::json!({
            "type": "command",
            "chat_id": "chat-1",
            "session_id": "websocket:chat-1",
            "command_id": "command-file-save-1",
            "command_kind": "file.save",
            "run_id": "tinyos-host-file-1",
            "path": "notes/today.md",
            "content": "updated\n",
            "base_revision": "metadata:12:34",
            "create_only": false,
            "confirmed": true
        }),
        attached_chat_id: Some("chat-1".to_string()),
        session_exists: Some(true),
        editable_paths: None,
        model: None,
        max_iterations: None,
        run_id: Some("tinyos-host-file-1".to_string()),
        stream: None,
    })
    .expect("file command frame should produce a transport result");
    let browser = native_websocket_transport_result(&WorkerTransportWebSocketDispatchInput {
        client_id: "client-1".to_string(),
        frame: serde_json::json!({
            "type": "command",
            "chat_id": "chat-1",
            "session_id": "websocket:chat-1",
            "command_id": "command-browser-1",
            "command_kind": "browser.interact",
            "run_id": "tinyos-host-browser-1",
            "browser_session_id": "browser-session-1",
            "control_epoch": 0,
            "capture_id": "capture-1",
            "tab_id": "tab-1",
            "action": { "type": "click", "x": 12, "y": 34 },
            "confirmed": true
        }),
        attached_chat_id: Some("chat-1".to_string()),
        session_exists: Some(true),
        editable_paths: None,
        model: None,
        max_iterations: None,
        run_id: Some("tinyos-host-browser-1".to_string()),
        stream: None,
    })
    .expect("browser command frame should produce a transport result");

    assert_eq!(file["commandKind"], "file.save");
    assert_eq!(file["path"], "notes/today.md");
    assert_eq!(file["baseRevision"], "metadata:12:34");
    assert_eq!(file["confirmed"], true);
    assert_eq!(browser["commandKind"], "browser.interact");
    assert_eq!(browser["browserSessionId"], "browser-session-1");
    assert_eq!(browser["controlEpoch"], 0);
    assert_eq!(browser["captureId"], "capture-1");
    assert_eq!(browser["tabId"], "tab-1");
    assert_eq!(browser["action"]["type"], "click");
}

#[test]
fn worker_transport_dispatches_a_revision_guarded_file_command_and_rejects_fake_browser_control() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-host-file";
    let run_id = "tinyos-host-file-test";
    let dispatched = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-host-file".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-host-file",
                "session_id": session_id,
                "command_id": "command-file-create-1",
                "command_kind": "file.save",
                "run_id": run_id,
                "path": "notes/created.md",
                "content": "created through TinyOS\n",
                "create_only": true,
                "confirmed": true
            }),
            attached_chat_id: Some("chat-host-file".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some(run_id.to_string()),
            stream: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(100),
    )
    .expect("confirmed file command should dispatch");
    let state = worker_agent_run_runtime_state_with_options(
        &shared,
        session_id.to_string(),
        run_id.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("host file run should be persisted");
    let runs = worker_agent_runs_list_with_options(
        &shared,
        session_id.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("host file run list should be readable");

    assert_eq!(dispatched["transport"]["commandKind"], "file.save");
    assert_eq!(dispatched["operation"]["path"], "notes/created.md");
    assert_eq!(runs["runs"][0]["status"], "completed");
    assert!(state["runtimeEvents"]
        .as_array()
        .expect("host file runtime events should exist")
        .iter()
        .any(|event| event["eventName"] == "agent.tool.result"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("notes/created.md"))
            .expect("created file should read"),
        "created through TinyOS\n"
    );

    let browser_error = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-host-browser".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-host-file",
                "session_id": session_id,
                "command_id": "command-browser-1",
                "command_kind": "browser.interact",
                "run_id": "tinyos-host-browser-test",
                "browser_session_id": "browser-session-1",
                "control_epoch": 0,
                "capture_id": "capture-1",
                "tab_id": "tab-1",
                "action": { "type": "click", "x": 12, "y": 34 },
                "confirmed": true
            }),
            attached_chat_id: Some("chat-host-file".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some("tinyos-host-browser-test".to_string()),
            stream: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(100),
    )
    .expect_err("browser control must fail closed without a real backend");
    assert!(
        browser_error.contains("native browser runtime is not managed"),
        "{browser_error}"
    );

    let missing_identity_error = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-host-browser".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-host-file",
                "session_id": session_id,
                "command_id": "command-browser-2",
                "command_kind": "browser.interact",
                "run_id": "tinyos-host-browser-missing-identity",
                "control_epoch": 0,
                "capture_id": "capture-1",
                "tab_id": "tab-1",
                "action": { "type": "click", "x": 12, "y": 34 },
                "confirmed": true
            }),
            attached_chat_id: Some("chat-host-file".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some("tinyos-host-browser-missing-identity".to_string()),
            stream: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(100),
    )
    .expect_err("browser control must reject incomplete capture identity");
    assert!(
        missing_identity_error.contains("missing browserSessionId"),
        "{missing_identity_error}"
    );

    let invalid_action_error = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-host-browser".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-host-file",
                "session_id": session_id,
                "command_id": "command-browser-3",
                "command_kind": "browser.interact",
                "run_id": "tinyos-host-browser-invalid-action",
                "browser_session_id": "browser-session-1",
                "control_epoch": 0,
                "capture_id": "capture-1",
                "tab_id": "tab-1",
                "action": { "type": "unsupported" },
                "confirmed": true
            }),
            attached_chat_id: Some("chat-host-file".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some("tinyos-host-browser-invalid-action".to_string()),
            stream: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(100),
    )
    .expect_err("browser control must reject an invalid action type");
    assert!(
        invalid_action_error.contains("payload is invalid")
            && invalid_action_error.contains("unsupported"),
        "{invalid_action_error}"
    );
    let runs_after_rejections = worker_agent_runs_list_with_options(
        &shared,
        session_id.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("host run list should remain readable after browser rejections");
    assert_eq!(
        runs_after_rejections["runs"]
            .as_array()
            .expect("host runs should be an array")
            .len(),
        1,
        "rejected browser commands must not create runtime state"
    );
}

#[test]
fn tinyos_terminal_output_is_bounded_and_sanitized() {
    let secret = "tiny-secret-value";
    let text = format!(
        "{}\nAPI_KEY=visible-secret\nconfigured={secret}\n",
        "x".repeat(12_000)
    );
    let sanitized = crate::desktop_commands::transport::sanitize_tinyos_host_text(
        &text,
        &serde_json::json!({ "provider": { "api_key": secret } }),
    );

    assert!(sanitized.chars().count() <= 10_000);
    assert!(!sanitized.contains(secret));
    assert!(!sanitized.contains("visible-secret"));
    assert!(sanitized.contains("API_KEY=[REDACTED]"));
}

#[test]
fn worker_transport_websocket_maps_correlated_operation_retry_command() {
    let transport = native_websocket_transport_result(&WorkerTransportWebSocketDispatchInput {
        client_id: "client-1".to_string(),
        frame: serde_json::json!({
            "type": "command",
            "chat_id": "chat-1",
            "session_id": "websocket:chat-1",
            "command_id": "command-retry-1",
            "command_kind": "operation.retry",
            "run_id": "run-retry-1",
            "source_turn_id": "run-failed-1",
            "item_id": "run-failed-1:error"
        }),
        attached_chat_id: Some("chat-1".to_string()),
        session_exists: Some(true),
        editable_paths: None,
        model: None,
        max_iterations: None,
        run_id: Some("run-retry-1".to_string()),
        stream: None,
    })
    .expect("operation retry command frame should produce a transport result");

    assert_eq!(transport["kind"], "command");
    assert_eq!(transport["commandKind"], "operation.retry");
    assert_eq!(transport["runId"], "run-retry-1");
    assert_eq!(transport["sourceTurnId"], "run-failed-1");
    assert_eq!(transport["itemId"], "run-failed-1:error");
}

#[test]
fn worker_transport_websocket_maps_correlated_agent_request_change_command() {
    let references = serde_json::json!([{
        "kind": "reference",
        "title": "src/main.ts · L2–3",
        "detail": "TinyOS file selection",
        "type": "tinyos.file",
        "sourcePath": "src/main.ts",
        "sourceLine": 2,
        "sourceEndLine": 3,
        "sourceText": "let value = 1;\nreturn value;"
    }]);
    let transport = native_websocket_transport_result(&WorkerTransportWebSocketDispatchInput {
        client_id: "client-1".to_string(),
        frame: serde_json::json!({
            "type": "command",
            "chat_id": "chat-1",
            "session_id": "websocket:chat-1",
            "command_id": "command-request-1",
            "command_kind": "agent.request_change",
            "run_id": "run-request-1",
            "observed_run_id": "run-completed-1",
            "instruction": "Explain this selection.",
            "references": references.clone()
        }),
        attached_chat_id: Some("chat-1".to_string()),
        session_exists: Some(true),
        editable_paths: None,
        model: None,
        max_iterations: None,
        run_id: Some("run-request-1".to_string()),
        stream: None,
    })
    .expect("Agent request command frame should produce a transport result");

    assert_eq!(transport["kind"], "command");
    assert_eq!(transport["commandKind"], "agent.request_change");
    assert_eq!(transport["runId"], "run-request-1");
    assert_eq!(transport["observedRunId"], "run-completed-1");
    assert_eq!(transport["instruction"], "Explain this selection.");
    assert_eq!(transport["references"], references);
}

#[test]
fn worker_transport_websocket_maps_correlated_agent_pause_command() {
    let transport = native_websocket_transport_result(&WorkerTransportWebSocketDispatchInput {
        client_id: "client-1".to_string(),
        frame: serde_json::json!({
            "type": "command",
            "chat_id": "chat-1",
            "session_id": "websocket:chat-1",
            "command_id": "command-pause-1",
            "command_kind": "agent.pause",
            "run_id": "run-1",
            "turn_id": "run-1"
        }),
        attached_chat_id: Some("chat-1".to_string()),
        session_exists: Some(true),
        editable_paths: None,
        model: None,
        max_iterations: None,
        run_id: Some("run-1".to_string()),
        stream: None,
    })
    .expect("Agent pause command frame should produce a transport result");

    assert_eq!(transport["kind"], "command");
    assert_eq!(transport["commandKind"], "agent.pause");
    assert_eq!(transport["commandId"], "command-pause-1");
    assert_eq!(transport["runId"], "run-1");
}

#[test]
fn worker_transport_agent_request_change_starts_new_correlated_run() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-agent-request";
    let request_run_id = "run-agent-request-target";
    let references = serde_json::json!([{
        "kind": "reference",
        "title": "README.md · L1",
        "detail": "TinyOS file selection",
        "type": "tinyos.file",
        "sourcePath": "README.md",
        "sourceLine": 1,
        "sourceEndLine": 1,
        "sourceText": "# Tinybot",
        "scope": "workspace-a"
    }, {
        "kind": "reference",
        "title": "cargo test · L4–6",
        "detail": "TinyOS terminal output selection",
        "type": "tinyos.terminal",
        "sourceLine": 4,
        "sourceEndLine": 6,
        "sourceText": "test failed",
        "evidenceId": "terminal-item-1",
        "scope": "run-terminal-1"
    }, {
        "kind": "reference",
        "title": "Execution plan",
        "detail": "TinyOS plan snapshot",
        "type": "tinyos.plan",
        "sourceText": "{\"steps\":[{\"step\":\"Verify\",\"status\":\"pending\"}]}",
        "evidenceId": "plan-item-1",
        "scope": "run-plan-1"
    }]);
    let request_config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "The selected line is the project heading." }] } }
    });
    let invalid_error = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-agent-request-invalid".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-agent-request",
                "session_id": session_id,
                "command_id": "command-agent-request-invalid",
                "command_kind": "agent.request_change",
                "run_id": "run-agent-request-invalid",
                "instruction": "Explain the selected file range.",
                "references": []
            }),
            attached_chat_id: Some("chat-agent-request".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some("run-agent-request-invalid".to_string()),
            stream: None,
        },
        fixture.root.clone(),
        request_config.clone(),
        Duration::from_millis(100),
    )
    .expect_err("Agent request without references should fail before provider work");
    assert!(invalid_error.contains("requires references"));

    let dispatched = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-agent-request".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-agent-request",
                "session_id": session_id,
                "command_id": "command-agent-request-1",
                "command_kind": "agent.request_change",
                "run_id": request_run_id,
                "instruction": "Explain the selected file range. Do not modify files.",
                "references": references.clone(),
                "source": { "surface": "tinyos", "control": "files-explain-selection" }
            }),
            attached_chat_id: Some("chat-agent-request".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some(request_run_id.to_string()),
            stream: None,
        },
        fixture.root.clone(),
        request_config,
        Duration::from_millis(100),
    )
    .expect("Agent request should start a new Agent run");
    let request_state = worker_agent_run_runtime_state_with_options(
        &shared,
        session_id.to_string(),
        request_run_id.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Agent request runtime state should be readable");
    let items = request_state["timeline"]["items"]
        .as_array()
        .expect("Agent request timeline items should exist");

    assert_eq!(dispatched["agent"]["stopReason"], "final_response");
    assert_eq!(
        dispatched["agent"]["finalContent"],
        "The selected line is the project heading."
    );
    assert!(items.iter().any(|item| {
        item["kind"] == "tool_call"
            && item["data"]["toolCallId"] == "command-agent-request-1"
            && item["data"]["name"] == "agent.request_change"
    }));
    assert!(
        items.iter().any(|item| {
            item["kind"] == "user_message"
                && item["data"]["references"] == references
                && item["data"]["content"]
                    == "Explain the selected file range. Do not modify files."
        }),
        "{items:?}"
    );
}

#[test]
fn worker_transport_operation_retry_starts_new_correlated_run() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-operation-retry";
    let source_run_id = "run-operation-retry-source";
    let failed_config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{
                    "content": "",
                    "toolCalls": [{
                        "id": "call-operation-retry-failure",
                        "name": "memory.search",
                        "argumentsJson": "{not json",
                        "result": { "content": "unused" }
                    }]
                }]
            }
        }
    });
    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": source_run_id,
            "sessionId": session_id,
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "Run the failing operation" }]
        }),
        fixture.root.clone(),
        failed_config,
        Duration::from_millis(100),
    )
    .expect("source Agent run should persist a canonical failure");
    let source_state = worker_agent_run_runtime_state_with_options(
        &shared,
        session_id.to_string(),
        source_run_id.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("failed source runtime state should be readable");
    let source_item_id = source_state["timeline"]["items"]
        .as_array()
        .and_then(|items| items.iter().rev().find(|item| item["status"] == "failed"))
        .and_then(|item| item["itemId"].as_str())
        .expect("failed source item should exist")
        .to_string();

    let retry_run_id = "run-operation-retry-target";
    let retry_config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "Recovered after retry" }] } }
    });
    let dispatched = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-operation-retry".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-operation-retry",
                "session_id": session_id,
                "command_id": "command-operation-retry-1",
                "command_kind": "operation.retry",
                "run_id": retry_run_id,
                "source_turn_id": source_run_id,
                "item_id": source_item_id,
                "source": { "surface": "chat", "control": "error-recovery" }
            }),
            attached_chat_id: Some("chat-operation-retry".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some(retry_run_id.to_string()),
            stream: None,
        },
        fixture.root.clone(),
        retry_config,
        Duration::from_millis(100),
    )
    .expect("operation retry should start a new Agent run");
    let retry_state = worker_agent_run_runtime_state_with_options(
        &shared,
        session_id.to_string(),
        retry_run_id.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("retry runtime state should be readable");

    assert_eq!(dispatched["agent"]["stopReason"], "final_response");
    assert_eq!(dispatched["agent"]["finalContent"], "Recovered after retry");
    assert!(retry_state["timeline"]["items"]
        .as_array()
        .expect("retry timeline items should exist")
        .iter()
        .any(|item| {
            item["kind"] == "tool_call"
                && item["data"]["toolCallId"] == "command-operation-retry-1"
                && item["data"]["name"] == "operation.retry"
        }));
}

#[test]
fn tinyos_terminal_execute_fails_closed_without_network_enforcement_and_leaks_no_process() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-host-terminal";
    let run_id = "tinyos-host-terminal-cancel-test";
    let error = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-host-terminal".to_string(),
            frame: serde_json::json!({
                "type": "command",
                "chat_id": "chat-host-terminal",
                "session_id": session_id,
                "command_id": "command-terminal-execute-1",
                "command_kind": "terminal.execute",
                "run_id": run_id,
                "command": lifecycle_blocking_command(),
                "cwd": ".",
                "confirmed": true
            }),
            attached_chat_id: Some("chat-host-terminal".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            run_id: Some(run_id.to_string()),
            stream: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(100),
    )
    .expect_err(
        "terminal execution must fail before process start when network denial cannot be enforced",
    );

    assert!(error.contains("network enforcement is unavailable"));
    assert_eq!(
        lock_runtime(&shared)
            .native_agent_runtime
            .shell_runtime()
            .active_process_count(),
        0
    );

    let runs = worker_agent_runs_list_with_options(
        &shared,
        session_id.to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("failed terminal run should remain inspectable");
    assert_eq!(runs["runs"][0]["status"], "failed");
}

#[test]
fn tinyos_effective_capabilities_are_backend_authored_and_run_scoped() {
    let policy = default_desktop_capability_policy();
    let running = crate::desktop_commands::session::build_worker_session_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "runs": [{ "runId": "run-1", "status": "running" }]
        }),
        true,
        &policy,
    );
    assert_eq!(
        running["schemaVersion"],
        "tinybot.effective_capabilities.v1"
    );
    assert_eq!(running["sessionId"], "websocket:chat-1");
    assert_eq!(running["evaluatedRunId"], "run-1");
    assert_eq!(
        running["capabilities"]["agent"]["cancel"]["available"],
        true
    );
    assert_eq!(running["capabilities"]["agent"]["pause"]["available"], true);
    assert_eq!(running["capabilities"]["files"]["read"]["available"], true);
    assert_eq!(
        running["capabilities"]["agent"]["retry"]["reasonCode"],
        "run_active"
    );
    assert_eq!(
        running["capabilities"]["files"]["requestChange"]["reasonCode"],
        "run_active"
    );

    let waiting = crate::desktop_commands::session::build_worker_session_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "runs": [{ "runId": "run-wait", "status": "waiting" }]
        }),
        true,
        &policy,
    );
    assert_eq!(
        waiting["capabilities"]["agent"]["cancel"]["available"],
        false
    );
    assert_eq!(
        waiting["capabilities"]["agent"]["cancel"]["reasonCode"],
        "run_waiting"
    );

    let paused = crate::desktop_commands::session::build_worker_session_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "runs": [{ "runId": "run-paused", "status": "waiting", "phase": "paused" }]
        }),
        true,
        &policy,
    );
    assert_eq!(paused["capabilities"]["agent"]["resume"]["available"], true);
    assert_eq!(paused["capabilities"]["agent"]["cancel"]["available"], true);
    assert_eq!(paused["capabilities"]["agent"]["pause"]["available"], false);

    let failed = crate::desktop_commands::session::build_worker_session_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "runs": [
                { "runId": "run-failed", "status": "failed" },
                { "runId": "run-older", "status": "completed" }
            ]
        }),
        true,
        &policy,
    );
    assert_eq!(failed["evaluatedRunId"], "run-failed");
    assert_eq!(failed["capabilities"]["agent"]["retry"]["available"], true);
    assert_eq!(
        failed["capabilities"]["files"]["requestChange"]["available"],
        true
    );
    assert_eq!(
        failed["capabilities"]["files"]["directEdit"]["available"],
        true
    );
    assert_eq!(failed["capabilities"]["files"]["save"]["available"], true);
    assert_eq!(
        failed["capabilities"]["terminal"]["execute"]["available"],
        false
    );
    assert_eq!(
        failed["capabilities"]["terminal"]["execute"]["reasonCode"],
        "network_enforcement_unavailable"
    );
    assert_eq!(
        failed["capabilities"]["browser"]["structured"]["available"],
        true
    );
    assert_eq!(
        failed["capabilities"]["browser"]["realCapture"]["available"],
        false
    );
    assert_eq!(
        failed["capabilities"]["browser"]["interact"]["available"],
        false
    );
    assert_eq!(
        failed["capabilities"]["browser"]["projectionContract"],
        "structured_projection_v1"
    );
    assert_eq!(
        failed["capabilities"]["browser"]["sessionContract"],
        "browser_session_v1"
    );
    assert_eq!(failed["capabilities"]["browser"]["sessionSnapshot"], false);

    let terminal = crate::desktop_commands::session::build_worker_session_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "runs": [{ "runId": "tinyos-host-terminal-1", "status": "running" }]
        }),
        true,
        &policy,
    );
    assert_eq!(
        terminal["capabilities"]["agent"]["cancel"]["available"],
        false
    );
    assert_eq!(
        terminal["capabilities"]["terminal"]["cancel"]["available"],
        true
    );
    assert_eq!(
        terminal["capabilities"]["terminal"]["execute"]["available"],
        false
    );
    assert_eq!(
        terminal["capabilities"]["terminal"]["contract"],
        "retained_execution_v1"
    );
    assert_eq!(terminal["capabilities"]["terminal"]["persistentPty"], false);
}

#[test]
fn tinyos_terminal_result_payload_preserves_retained_execution_boundaries() {
    let output = crate::tools::shell::ShellProcessOutput {
        process_id: "shell-1".to_string(),
        system_process_id: Some(42),
        run_id: Some("tinyos-host-terminal-1".to_string()),
        tool_call_id: Some("command-1".to_string()),
        command: "cargo test".to_string(),
        working_dir: ".".to_string(),
        tty: false,
        status: "completed".to_string(),
        running: false,
        exit_code: Some(0),
        stdout: "ignored unsanitized output".to_string(),
        stderr: "ignored unsanitized error".to_string(),
        output: String::new(),
        chunks: Vec::new(),
        cursor: 3,
        truncated: true,
        dropped_bytes: 17,
        started_at_ms: 1_000,
        last_activity_ms: 1_250,
        sandbox_mode: "read_only".to_string(),
        network_mode: "denied".to_string(),
        approval_decision: "user_confirmed".to_string(),
        failure: None,
    };

    let payload = crate::desktop_commands::transport::tinyos_terminal_result_payload(
        &output,
        "safe stdout",
        "safe stderr",
    );

    assert_eq!(payload["executionContract"], "retained_execution_v1");
    assert_eq!(payload["processId"], "shell-1");
    assert_eq!(payload["tty"], false);
    assert_eq!(payload["sandboxMode"], "read_only");
    assert_eq!(payload["networkMode"], "denied");
    assert_eq!(payload["durationMs"], 250);
    assert_eq!(payload["stdout"], "safe stdout");
    assert_eq!(payload["stdoutBytes"], 11);
    assert_eq!(payload["stderr"], "safe stderr");
    assert_eq!(payload["stderrBytes"], 11);
    assert_eq!(payload["truncated"], true);
    assert_eq!(payload["droppedBytes"], 17);
}

#[test]
fn tinyos_host_restart_recovery_keeps_live_terminal_and_marks_stale_runs() {
    let live_process_runs =
        std::collections::HashSet::from(["tinyos-host-terminal-live".to_string()]);
    let interrupted = crate::desktop_commands::session::interrupted_tinyos_host_run_ids(
        &serde_json::json!({
            "runs": [
                { "runId": "tinyos-host-terminal-live", "status": "running" },
                { "runId": "tinyos-host-terminal-stale", "status": "running" },
                { "runId": "tinyos-host-file-stale", "status": "waiting" },
                { "runId": "tinyos-host-terminal-done", "status": "completed" },
                { "runId": "agent-run", "status": "running" }
            ]
        }),
        &live_process_runs,
    );

    assert_eq!(
        interrupted,
        vec![
            "tinyos-host-terminal-stale".to_string(),
            "tinyos-host-file-stale".to_string(),
        ]
    );
}
