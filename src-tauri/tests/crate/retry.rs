use super::support::*;
use crate::desktop::state::NativeRuntimeState;
use crate::desktop_commands::agent::worker_run_agent_with_options;
use crate::desktop_commands::retry::{
    retry_thread_operation_with_options, WorkerThreadOperationRetryInput,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[test]
fn operation_retry_requires_a_distinct_target_turn() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let error = retry_thread_operation_with_options(
        &shared,
        WorkerThreadOperationRetryInput {
            command_id: "command-retry-1".to_string(),
            source: serde_json::json!({ "surface": "chat" }),
            source_item_id: "turn-failed:error".to_string(),
            source_turn_id: "turn-same".to_string(),
            target_turn_id: "turn-same".to_string(),
            thread_id: "thread-1".to_string(),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(100),
    )
    .expect_err("operation retry must not reuse its source turn");

    assert_eq!(error, "operation.retry requires a new targetTurnId");
}

#[test]
fn operation_retry_starts_new_correlated_turn() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let thread_id = "websocket:chat-operation-retry";
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
            "sessionId": thread_id,
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
        thread_id,
        source_turn_id,
    );
    let source_item_id = source_state["timeline"]["items"]
        .as_array()
        .and_then(|items| items.iter().rev().find(|item| item["status"] == "failed"))
        .and_then(|item| item["itemId"].as_str())
        .expect("failed source item should exist")
        .to_string();

    let target_turn_id = "turn-operation-retry-target";
    let retry_config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "Recovered after retry" }] } }
    });
    let dispatched = retry_thread_operation_with_options(
        &shared,
        WorkerThreadOperationRetryInput {
            command_id: "command-operation-retry-1".to_string(),
            source: serde_json::json!({ "surface": "chat", "control": "error-recovery" }),
            source_item_id,
            source_turn_id: source_turn_id.to_string(),
            target_turn_id: target_turn_id.to_string(),
            thread_id: thread_id.to_string(),
        },
        fixture.root.clone(),
        retry_config,
        Duration::from_millis(100),
    )
    .expect("operation retry should start a new Agent turn");
    let retry_state = read_thread_turn_runtime_state(
        &fixture.thread_store,
        serde_json::json!({}),
        thread_id,
        target_turn_id,
    );

    assert_eq!(dispatched["threadId"], thread_id);
    assert_eq!(dispatched["turnId"], target_turn_id);
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
