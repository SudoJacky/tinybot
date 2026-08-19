use super::support::*;
use crate::desktop::state::NativeRuntimeState;
use crate::desktop_commands::agent::worker_run_agent_with_options;
use crate::desktop_commands::transport::native_websocket_transport_result;
use crate::desktop_commands::transport::validate_tinyos_host_command_frame;
use crate::desktop_commands::transport::worker_transport_dispatch_websocket_message_with_options;
use crate::desktop_commands::transport::WorkerTransportWebSocketDispatchInput;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

#[test]
fn tinyos_host_command_interface_accepts_only_operation_retry() {
    for frame in [
        serde_json::json!({ "type": "new_chat" }),
        serde_json::json!({ "type": "message", "content": "hello" }),
        serde_json::json!({ "type": "interrupt" }),
    ] {
        let error = validate_tinyos_host_command_frame(&frame)
            .expect_err("chat frames must use the typed Thread interface");
        assert!(error.contains("accepts only TinyOS host commands"));
    }

    for command_kind in [
        "agent.cancel",
        "form.submit",
        "form.cancel",
        "agent.pause",
        "agent.request_change",
        "file.save",
        "terminal.execute",
        "browser.interact",
    ] {
        let error = validate_tinyos_host_command_frame(&serde_json::json!({
            "type": "command",
            "command_kind": command_kind,
        }))
        .expect_err("retired host commands must be rejected");
        assert!(error.contains("accepts only operation.retry"), "{error}");
    }

    validate_tinyos_host_command_frame(&serde_json::json!({
        "type": "command",
        "command_kind": "operation.retry",
    }))
    .expect("operation.retry remains available for Chat error recovery");
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
            "turn_id": "turn-retry-1",
            "source_turn_id": "turn-failed-1",
            "item_id": "turn-failed-1:error"
        }),
        attached_chat_id: Some("chat-1".to_string()),
        session_exists: Some(true),
        editable_paths: None,
        model: None,
        max_iterations: None,
        stream: None,
    })
    .expect("operation retry command frame should produce a transport result");

    assert_eq!(transport["kind"], "command");
    assert_eq!(transport["commandKind"], "operation.retry");
    assert_eq!(transport["turnId"], "turn-retry-1");
    assert_eq!(transport["sourceTurnId"], "turn-failed-1");
    assert_eq!(transport["itemId"], "turn-failed-1:error");
}

#[test]
fn worker_transport_operation_retry_starts_new_correlated_turn() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let session_id = "websocket:chat-operation-retry";
    let source_turn_id = "turn-operation-retry-source";
    let failed_config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{
                    "content": "",
                    "toolCalls": [{
                        "id": "call-operation-retry-failure",
                        "name": "workspace.write_file",
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
            "turnId": source_turn_id,
            "sessionId": session_id,
            "maxIterations": 1,
            "messages": [{ "role": "user", "content": "Run the failing operation" }]
        }),
        fixture.root.clone(),
        failed_config,
        Duration::from_millis(100),
    )
    .expect("source Agent turn should persist a canonical failure");
    let source_state = read_thread_turn_runtime_state(
        &fixture.thread_store,
        serde_json::json!({}),
        session_id,
        source_turn_id,
    );
    let source_item_id = source_state["timeline"]["items"]
        .as_array()
        .and_then(|items| items.iter().rev().find(|item| item["status"] == "failed"))
        .and_then(|item| item["itemId"].as_str())
        .expect("failed source item should exist")
        .to_string();

    let retry_turn_id = "turn-operation-retry-target";
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
                "turn_id": retry_turn_id,
                "source_turn_id": source_turn_id,
                "item_id": source_item_id,
                "source": { "surface": "chat", "control": "error-recovery" }
            }),
            attached_chat_id: Some("chat-operation-retry".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: None,
            max_iterations: None,
            stream: None,
        },
        fixture.root.clone(),
        retry_config,
        Duration::from_millis(100),
    )
    .expect("operation retry should start a new Agent turn");
    let retry_state = read_thread_turn_runtime_state(
        &fixture.thread_store,
        serde_json::json!({}),
        session_id,
        retry_turn_id,
    );

    assert_eq!(dispatched["sessionId"], session_id);
    assert_eq!(dispatched["turnId"], retry_turn_id);
    assert!(retry_state["timeline"]["items"]
        .as_array()
        .expect("retry timeline items should exist")
        .iter()
        .any(|item| {
            item["kind"] == "tool_call"
                && item["data"]["toolCallId"] == "command-operation-retry-1"
                && item["data"]["name"] == "operation.retry"
        }));
    assert!(retry_state["timeline"]["items"]
        .as_array()
        .expect("retry timeline items should exist")
        .iter()
        .any(|item| {
            item["kind"] == "assistant_message"
                && item["data"]["content"] == "Recovered after retry"
        }));
}

#[test]
fn chat_effective_capabilities_are_backend_authored_and_turn_scoped() {
    let running = crate::desktop_commands::thread::build_thread_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "turns": [{ "turnId": "turn-1", "status": "running" }]
        }),
    );
    assert_eq!(
        running["schemaVersion"],
        "tinybot.effective_capabilities.v2"
    );
    assert_eq!(running["threadId"], "websocket:chat-1");
    assert_eq!(running["evaluatedTurnId"], "turn-1");
    assert_eq!(
        running["capabilities"]["agent"]["cancel"]["available"],
        true
    );
    assert_eq!(
        running["capabilities"]["agent"]["retry"]["reasonCode"],
        "turn_active"
    );
    assert_eq!(
        running["capabilities"]["agent"]
            .as_object()
            .expect("agent capability object")
            .len(),
        2
    );

    let waiting = crate::desktop_commands::thread::build_thread_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "turns": [{ "turnId": "turn-wait", "status": "waiting" }]
        }),
    );
    assert_eq!(
        waiting["capabilities"]["agent"]["cancel"]["reasonCode"],
        "turn_waiting"
    );

    let paused = crate::desktop_commands::thread::build_thread_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "turns": [{ "turnId": "turn-paused", "status": "waiting", "phase": "paused" }]
        }),
    );
    assert_eq!(paused["capabilities"]["agent"]["cancel"]["available"], true);

    let failed = crate::desktop_commands::thread::build_thread_effective_capabilities(
        "websocket:chat-1",
        &serde_json::json!({
            "turns": [
                { "turnId": "turn-failed", "status": "failed" },
                { "turnId": "turn-older", "status": "completed" }
            ]
        }),
    );
    assert_eq!(failed["evaluatedTurnId"], "turn-failed");
    assert_eq!(failed["capabilities"]["agent"]["retry"]["available"], true);
}
