use super::support::*;
use crate::agent::bridge::native_agent_turn_record;
use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::desktop::state::GatewayRuntime;
use crate::desktop_commands::agent::worker_run_agent_with_options;
use crate::desktop_commands::session::worker_session_messages_with_options;
use crate::desktop_commands::session::worker_turn_runtime_state_with_options;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

#[test]
fn worker_run_agent_uses_rust_runtime_when_selected() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-rust-1",
            "sessionId": "websocket:chat-1",
            "stream": true,
            "messages": [{ "role": "user", "content": "hello rust" }]
        }),
        fixture.root.clone(),
        serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "rust fixture answer" }] } }
        }),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should run deterministic fixture provider");

    assert_eq!(result["runtime"], "rust");
    assert_eq!(result["finalContent"], "rust fixture answer");
    let events = result["events"]
        .as_array()
        .expect("Rust runtime events should be an array");
    assert_eq!(events[0]["eventName"], "agent.delta");
    assert!(events
        .iter()
        .any(|event| event["eventName"] == "agent.usage"));
    assert_eq!(
        events[events.len() - 2]["eventName"],
        "agent.message.completed"
    );
    assert_eq!(events.last().unwrap()["eventName"], "agent.done");
}

#[test]
fn worker_run_agent_preserves_trace_context_without_persisting_runtime_trace() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "traced answer" }] } }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "requestId": "request-ingress-persistence",
            "traceId": "trace-ingress-persistence",
            "turnId": "turn-ingress-persistence",
            "sessionId": "session-ingress-persistence",
            "messages": [{ "role": "user", "content": "trace this turn" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("traced Rust runtime should complete");
    let turn = read_agent_turn_record(
        &fixture.thread_store,
        config.clone(),
        "session-ingress-persistence",
        "turn-ingress-persistence",
    );

    assert_eq!(
        result["traceContext"]["requestId"],
        "request-ingress-persistence"
    );
    assert_eq!(
        result["traceContext"]["traceId"],
        "trace-ingress-persistence"
    );
    assert_eq!(
        turn["traceContext"]["requestId"],
        "request-ingress-persistence"
    );
    assert_eq!(turn["traceContext"]["traceId"], "trace-ingress-persistence");
    assert!(turn.get("traceEvents").is_none());
}

#[test]
fn worker_run_agent_preserves_runtime_tool_content_with_envelope_payload() {
    let fixture = WorkspaceFixture::new();
    fixture.write("README.md", "README excerpt");
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-rust-tool-envelope",
            "sessionId": "websocket:chat-tool-envelope",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read with envelope" }]
        }),
        fixture.root.clone(),
        serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-envelope",
                                "name": "update_plan",
                                "argumentsJson": "{\"plan\":[{\"step\":\"Inspect the input\",\"status\":\"completed\"}]}",
                                "result": { "content": "fixture result should not be used" }
                            }]
                        },
                        { "content": "final after envelope" }
                    ]
                }
            }
        }),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should return enriched tool result payloads");
    let tool_result = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.tool.result")
        .expect("tool result event should be present");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "final after envelope");
    assert_eq!(tool_result["payload"]["content"], "Plan updated");
    assert_eq!(tool_result["payload"]["envelope"]["status"], "ok");
    assert_eq!(
        tool_result["payload"]["envelope"]["trace"]["toolCallId"],
        "call-envelope"
    );
    assert_eq!(
        tool_result["payload"]["envelope"]["ui"]["type"],
        "generic_result"
    );
}

#[test]
fn worker_run_agent_persists_rust_turn_messages_in_canonical_rollout() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(UsageNativeAgentProvider),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "unused fixture response" }] } }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-persist",
            "sessionId": "websocket:chat-persist",
            "messages": [{ "role": "user", "content": "persist me" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete fixture-backed turn");
    let history = worker_session_messages_with_options(
        &shared,
        "websocket:chat-persist".to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("session messages route should read persisted Rust turn");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(history["messages"][0]["role"], "user");
    assert_eq!(history["messages"][0]["content"], "persist me");
    assert_eq!(history["messages"][1]["role"], "assistant");
    assert_eq!(history["messages"][1]["content"], "persisted assistant");
    assert_eq!(history["messages"][1]["usage"]["promptTokens"], 10);
    assert_eq!(history["messages"][1]["usage"]["completionTokens"], 97);
    assert_eq!(history["messages"][1]["usage"]["totalTokens"], 107);
}

#[test]
fn worker_run_agent_persists_one_lossless_long_final_response() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(LongFinalNativeAgentProvider),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });
    let session_id = "websocket:chat-long-final";
    let turn_id = "turn-long-final";
    let expected = long_final_content();

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": turn_id,
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "return a long answer" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should durably complete a long final response");
    let runtime_state = worker_turn_runtime_state_with_options(
        &shared,
        session_id.to_string(),
        turn_id.to_string(),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("long final response should project from canonical Rollout");
    let history = worker_session_messages_with_options(
        &shared,
        session_id.to_string(),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("long final response should reload from canonical Rollout");
    let metadata = call_rust_state_service(
        &fixture.thread_store,
        config,
        WorkerRequest::new(
            "req-long-final-metadata",
            "trace-long-final-metadata",
            "thread.read",
            serde_json::json!({
                "threadId": crate::threads::rollout::store::thread_id_for_session_id(session_id)
            }),
        ),
        "long final thread",
    )
    .expect("long final thread should be readable");
    assert_eq!(metadata["thread"]["sessionKey"], session_id);
    let rollout_paths = compatibility_thread_log_paths(&fixture.root);
    assert_eq!(rollout_paths.len(), 1, "{rollout_paths:?}");
    let rollout_lines = std::fs::read_to_string(&rollout_paths[0])
        .expect("canonical Rollout should be readable")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let assistant_items = rollout_lines
        .iter()
        .filter(|line| line["type"] == "response_item" && line["payload"]["role"] == "assistant")
        .collect::<Vec<_>>();
    assert!(rollout_lines.iter().all(|line| {
        line["type"] != "event_msg" || line["payload"]["type"] != "agent_run_trace"
    }));
    let session_meta = rollout_lines
        .first()
        .expect("rollout should start with session metadata");
    let turn_context = rollout_lines
        .iter()
        .find(|line| line["type"] == "turn_context")
        .expect("turn context should be persisted");
    let terminal = rollout_lines
        .iter()
        .find(|line| line["type"] == "event_msg" && line["payload"]["type"] == "turn_complete")
        .expect("run terminal boundary should be persisted");

    assert_eq!(result["finalContent"], expected);
    assert_eq!(history["messages"][1]["content"], expected);
    assert_eq!(assistant_items.len(), 1);
    assert_eq!(assistant_items[0]["payload"]["type"], "message");
    assert_eq!(assistant_items[0]["payload"]["phase"], "final_answer");
    assert_eq!(
        assistant_items[0]["payload"]["content"][0]["text"],
        long_final_content()
    );
    assert!(session_meta["payload"]["id"].as_str().is_some());
    assert_eq!(session_meta["payload"]["session_id"], session_id);
    assert!(session_meta["payload"].get("threadId").is_none());
    assert!(session_meta["payload"].get("schemaVersion").is_none());
    assert_eq!(turn_context["payload"]["turn_id"], turn_id);
    assert!(turn_context["payload"].get("turnId").is_none());
    assert!(
        terminal["ordinal"].as_u64().unwrap() > assistant_items[0]["ordinal"].as_u64().unwrap(),
        "terminal boundary must be persisted after the canonical final response"
    );
    assert_eq!(
        runtime_state["timeline"]["items"]
            .as_array()
            .expect("runtime timeline items should be an array")
            .iter()
            .filter(|item| item["kind"] == "assistant_message")
            .count(),
        1
    );
}

#[test]
fn worker_run_agent_stops_before_provider_when_run_start_persistence_fails() {
    #[derive(Clone)]
    struct CountingProvider {
        calls: Arc<Mutex<usize>>,
    }

    impl crate::agent::runtime::NativeAgentProvider for CountingProvider {
        fn complete(
            &self,
            _context: &crate::agent::runtime::AgentTurnContext,
        ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
            *self
                .calls
                .lock()
                .expect("counting provider lock should not be poisoned") += 1;
            Ok(crate::agent::runtime::NativeAgentProviderResponse {
                final_content: "provider should not run".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let fixture = WorkspaceFixture::new();
    fixture.write(".tinybot/threads", "blocks thread-log directory creation");
    let calls = Arc::new(Mutex::new(0));
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(CountingProvider {
                calls: calls.clone(),
            }),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));

    let error = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-persistence-failure",
            "messages": [{ "role": "user", "content": "do not call provider" }]
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect_err("turn-start persistence failure should fail the command");

    assert!(error.contains("turn start persistence failed"), "{error}");
    assert_eq!(
        *calls
            .lock()
            .expect("counting provider lock should not be poisoned"),
        0,
        "provider must not run after turn-start persistence fails"
    );
}

#[test]
fn worker_run_agent_fails_when_trace_persistence_breaks_after_provider_response() {
    #[derive(Clone)]
    struct PersistenceBreakingProvider {
        workspace_root: PathBuf,
        calls: Arc<Mutex<usize>>,
    }

    impl crate::agent::runtime::NativeAgentProvider for PersistenceBreakingProvider {
        fn complete(
            &self,
            _context: &crate::agent::runtime::AgentTurnContext,
        ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
            *self
                .calls
                .lock()
                .expect("persistence-breaking provider lock should not be poisoned") += 1;
            let thread_root = self.workspace_root.join(".tinybot").join("threads");
            std::fs::remove_dir_all(&thread_root)
                .expect("provider fixture should remove the initialized thread log");
            std::fs::write(&thread_root, "blocks later thread-log writes")
                .expect("provider fixture should replace thread log directory");
            Ok(crate::agent::runtime::NativeAgentProviderResponse {
                final_content: "result must not be reported as durable".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let fixture = WorkspaceFixture::new();
    let calls = Arc::new(Mutex::new(0));
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(PersistenceBreakingProvider {
                workspace_root: fixture.root.clone(),
                calls: calls.clone(),
            }),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));

    let error = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-record-persistence-failure",
            "sessionId": "session-record-persistence-failure",
            "messages": [{ "role": "user", "content": "break persistence after start" }]
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect_err("trace persistence failure should fail the command");

    assert!(
        error.contains("native agent semantic batch append failed"),
        "{error}"
    );
    assert_eq!(
        *calls
            .lock()
            .expect("persistence-breaking provider lock should not be poisoned"),
        1
    );
}

#[test]
fn native_agent_turn_record_includes_structured_token_usage_info() {
    let spec = serde_json::json!({
        "runtime": "rust",
        "turnId": "turn-token-info",
        "sessionId": "websocket:chat-token-info",
        "messages": [{ "role": "user", "content": "hello" }]
    });
    let result = serde_json::json!({
        "runtime": "rust",
        "turnId": "turn-token-info",
        "sessionId": "websocket:chat-token-info",
        "stopReason": "final_response",
        "events": [{
            "eventName": "agent.usage",
            "payload": {
                "usage": {
                    "prompt_tokens": 5,
                    "completion_tokens": 167,
                    "total_tokens": 172,
                    "contextWindowTokens": 128000,
                    "contextUsageTokens": 172,
                    "cumulativeUsageTokens": 1172
                }
            }
        }]
    });

    let record = native_agent_turn_record(
        &spec,
        &result,
        &serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } }
        }),
        "websocket:chat-token-info",
        "turn-token-info",
    );

    assert_eq!(
        record["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
        172
    );
    assert_eq!(record["tokenUsageInfo"]["lastTokenUsage"]["inputTokens"], 5);
    assert_eq!(
        record["tokenUsageInfo"]["lastTokenUsage"]["outputTokens"],
        167
    );
    assert_eq!(
        record["tokenUsageInfo"]["totalTokenUsage"]["totalTokens"],
        1172
    );
    assert_eq!(record["tokenUsageInfo"]["modelContextWindow"], 128000);
}

#[derive(Clone)]
struct UsageNativeAgentProvider;

impl crate::agent::runtime::NativeAgentProvider for UsageNativeAgentProvider {
    fn complete(
        &self,
        _context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        Ok(crate::agent::runtime::NativeAgentProviderResponse {
            final_content: "persisted assistant".to_string(),
            reasoning_delta: None,
            usage: Some(serde_json::json!({
                "prompt_tokens": 10,
                "completion_tokens": 97,
                "total_tokens": 107,
            })),
            tool_calls: Vec::new(),
        })
    }
}

fn long_final_content() -> String {
    "完整的最终结论🦀".repeat(48)
}

#[derive(Clone)]
struct LongFinalNativeAgentProvider;

impl crate::agent::runtime::NativeAgentProvider for LongFinalNativeAgentProvider {
    fn complete(
        &self,
        _context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        Ok(crate::agent::runtime::NativeAgentProviderResponse {
            final_content: long_final_content(),
            reasoning_delta: None,
            usage: None,
            tool_calls: Vec::new(),
        })
    }
}

#[derive(Clone)]
struct RecordingNativeAgentProvider {
    calls: Arc<Mutex<Vec<Vec<serde_json::Value>>>>,
}

impl crate::agent::runtime::NativeAgentProvider for RecordingNativeAgentProvider {
    fn complete(
        &self,
        context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        self.calls
            .lock()
            .expect("recording provider calls lock should not be poisoned")
            .push(context.messages.clone());
        Ok(crate::agent::runtime::NativeAgentProviderResponse {
            final_content: "remembered answer".to_string(),
            reasoning_delta: None,
            usage: None,
            tool_calls: Vec::new(),
        })
    }
}

#[derive(Clone)]
struct ToolLoopRecordingNativeAgentProvider {
    calls: Arc<Mutex<Vec<Vec<serde_json::Value>>>>,
}

impl crate::agent::runtime::NativeAgentProvider for ToolLoopRecordingNativeAgentProvider {
    fn complete(
        &self,
        context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        let call_count = {
            let mut calls = self
                .calls
                .lock()
                .expect("recording provider calls lock should not be poisoned");
            calls.push(context.messages.clone());
            calls.len()
        };
        if call_count == 1 {
            Ok(crate::agent::runtime::NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![crate::agent::runtime::NativeAgentToolCall {
                    id: "call-durable-history".to_string(),
                    name: "update_plan".to_string(),
                    arguments_json:
                        "{\"plan\":[{\"step\":\"Inspect history\",\"status\":\"completed\"}]}"
                            .to_string(),
                    result: serde_json::json!({ "content": "fixture result should not be used" }),
                }],
            })
        } else {
            Ok(crate::agent::runtime::NativeAgentProviderResponse {
                final_content: "combined history and tool result".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }
}

#[derive(Clone)]
struct MultiExchangeRecallProvider {
    calls: Arc<Mutex<Vec<Vec<serde_json::Value>>>>,
}

impl crate::agent::runtime::NativeAgentProvider for MultiExchangeRecallProvider {
    fn complete(
        &self,
        context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        let call_count = {
            let mut calls = self
                .calls
                .lock()
                .expect("recall provider calls lock should not be poisoned");
            calls.push(context.messages.clone());
            calls.len()
        };
        let final_content = match call_count {
            1 => "stored apple",
            2 => "stored banana",
            _ => "You previously said apple and banana.",
        };
        Ok(crate::agent::runtime::NativeAgentProviderResponse {
            final_content: final_content.to_string(),
            reasoning_delta: None,
            usage: None,
            tool_calls: Vec::new(),
        })
    }
}

#[test]
fn worker_run_agent_hydrates_session_history_before_provider_call() {
    let fixture = WorkspaceFixture::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(RecordingNativeAgentProvider {
                calls: calls.clone(),
            }),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });
    fixture.seed_thread_messages(
        "websocket:chat-memory",
        "turn-previous",
        vec![
            serde_json::json!({ "role": "user", "content": "a" }),
            serde_json::json!({ "role": "assistant", "content": "agent replied a" }),
        ],
    );

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-next",
            "sessionId": "websocket:chat-memory",
            "input": { "role": "user", "content": "what did I say before?" }
        }),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete with hydrated history");
    let calls = calls
        .lock()
        .expect("recording provider calls lock should not be poisoned");
    let messages = calls.first().expect("provider should be called once");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["content"], "a");
    assert_eq!(messages[1]["content"], "agent replied a");
    assert_eq!(messages[2]["content"], "what did I say before?");
}

#[test]
fn worker_run_agent_combines_session_history_with_current_tool_results() {
    let fixture = WorkspaceFixture::new();
    fixture.write("README.md", "README durable body");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(ToolLoopRecordingNativeAgentProvider {
                calls: calls.clone(),
            }),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });
    fixture.seed_thread_messages(
        "websocket:chat-tool-memory",
        "turn-previous-tool-memory",
        vec![
            serde_json::json!({ "role": "user", "content": "remember alpha" }),
            serde_json::json!({ "role": "assistant", "content": "alpha stored" }),
        ],
    );

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-tool-memory",
            "sessionId": "websocket:chat-tool-memory",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "read README and combine" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete with history and tool context");
    let history = worker_session_messages_with_options(
        &shared,
        "websocket:chat-tool-memory".to_string(),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("session messages should stay compact after hydrated run");
    let metadata = call_rust_state_service(
        &fixture.thread_store,
        config,
        WorkerRequest::new(
            "req-tool-memory-metadata",
            "trace-tool-memory-metadata",
            "thread.read",
            serde_json::json!({
                "threadId": crate::threads::rollout::store::thread_id_for_session_id(
                    "websocket:chat-tool-memory"
                )
            }),
        ),
        "tool memory thread",
    )
    .expect("tool memory thread should be readable");
    assert_eq!(
        metadata["thread"]["sessionKey"],
        "websocket:chat-tool-memory"
    );
    let rollout_paths = compatibility_thread_log_paths(&fixture.root);
    assert_eq!(rollout_paths.len(), 1, "{rollout_paths:?}");
    let rollout =
        std::fs::read_to_string(&rollout_paths[0]).expect("tool memory Rollout should be readable");
    let response_items = rollout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|line| line["type"] == "response_item")
        .collect::<Vec<_>>();
    let response_types = response_items
        .iter()
        .filter_map(|line| line["payload"]["type"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    let tool_output = response_items
        .iter()
        .find(|line| line["payload"]["type"] == "custom_tool_call_output")
        .expect("Rollout should contain a tool output");
    let tool_output_fields = tool_output["payload"]
        .as_object()
        .expect("tool output payload should be an object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let calls = calls
        .lock()
        .expect("recording provider calls lock should not be poisoned");
    let first_messages = calls.first().expect("first provider call should run");
    let second_messages = calls.get(1).expect("second provider call should run");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(calls.len(), 2);
    assert_eq!(first_messages[0]["content"], "remember alpha");
    assert_eq!(first_messages[1]["content"], "alpha stored");
    assert_eq!(first_messages[2]["content"], "read README and combine");
    assert!(second_messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["tool_calls"]
                .as_array()
                .is_some_and(|tool_calls| tool_calls[0]["id"] == "call-durable-history")
    }));
    assert!(second_messages.iter().any(|message| {
        message["role"] == "tool"
            && message["tool_call_id"] == "call-durable-history"
            && message["content"] == "Plan updated"
    }));
    assert_eq!(history["messages"].as_array().unwrap().len(), 4);
    assert!(history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|message| message["role"] != "tool"));
    assert!(response_types.contains(&"custom_tool_call".to_string()));
    assert!(response_types.contains(&"custom_tool_call_output".to_string()));
    assert_eq!(
        tool_output_fields,
        std::collections::BTreeSet::from(["call_id", "id", "output", "turnId", "turnId", "type"])
    );
    assert_eq!(
        tool_output["payload"]["id"],
        "tool-output:call-durable-history"
    );
    assert_eq!(tool_output["payload"]["call_id"], "call-durable-history");
    assert_eq!(tool_output["payload"]["turnId"], "turn-tool-memory");
    assert_eq!(tool_output["payload"]["turnId"], "turn-tool-memory");
    assert!(tool_output["payload"]["output"]
        .as_str()
        .is_some_and(|output| output.contains("Plan updated")));
}

#[test]
fn worker_run_agent_recalls_history_after_multiple_exchanges() {
    let fixture = WorkspaceFixture::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(MultiExchangeRecallProvider {
                calls: calls.clone(),
            }),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });
    let session_id = "websocket:chat-multi-recall";

    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-recall-1",
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "I said apple" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("first exchange should persist");
    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-recall-2",
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "I said banana" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("second exchange should persist");
    let recalled = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-recall-3",
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "What did I say earlier?" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("third exchange should hydrate prior history");
    let history = worker_session_messages_with_options(
        &shared,
        session_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("history should include all compact exchanges");
    let calls = calls
        .lock()
        .expect("recall provider calls lock should not be poisoned");
    let recall_messages = calls.get(2).expect("third provider call should exist");

    assert_eq!(
        recalled["finalContent"],
        "You previously said apple and banana."
    );
    assert_eq!(recall_messages.len(), 5);
    assert_eq!(recall_messages[0]["content"], "I said apple");
    assert_eq!(recall_messages[1]["content"], "stored apple");
    assert_eq!(recall_messages[2]["content"], "I said banana");
    assert_eq!(recall_messages[3]["content"], "stored banana");
    assert_eq!(recall_messages[4]["content"], "What did I say earlier?");
    assert_eq!(history["messages"].as_array().unwrap().len(), 6);
}

#[test]
fn worker_run_agent_rejects_terminal_run_reentry_before_provider_call() {
    let fixture = WorkspaceFixture::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(RecordingNativeAgentProvider {
                calls: calls.clone(),
            }),
            Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });

    let first = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-terminal-reentry",
            "sessionId": "websocket:chat-terminal-reentry",
            "messages": [{ "role": "user", "content": "finish once" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("first Rust runtime turn should complete");
    let second = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-terminal-reentry",
            "sessionId": "websocket:chat-terminal-reentry",
            "messages": [{ "role": "user", "content": "try to continue" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("terminal reentry should return structured rejection");
    let turn = read_agent_turn_record(
        &fixture.thread_store,
        config,
        "websocket:chat-terminal-reentry",
        "turn-terminal-reentry",
    );

    assert_eq!(first["stopReason"], "final_response");
    assert_eq!(second["stopReason"], "terminal_turn");
    assert_eq!(second["terminalTurn"]["status"], "completed");
    assert_eq!(second["events"][0]["eventName"], "agent.error");
    assert_eq!(
        calls
            .lock()
            .expect("recording provider calls lock should not be poisoned")
            .len(),
        1
    );
    assert_eq!(turn["status"], "completed");
    assert_eq!(turn["phase"], "completed");
}

#[test]
fn worker_run_agent_persists_agent_turn_record_and_keeps_history_compact() {
    let fixture = WorkspaceFixture::new();
    fixture.write("README.md", "README trace body");
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-run-trace",
                            "name": "update_plan",
                            "argumentsJson": "{\"plan\":[{\"step\":\"Inspect trace\",\"status\":\"completed\"}]}",
                            "result": { "content": "fixture result should not be used" }
                        }]
                    },
                    { "content": "run trace final" }
                ]
            }
        }
    });

    let result = worker_run_agent_with_options(
            &shared,
            serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-trace-persist",
                "sessionId": "websocket:chat-run-trace",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read and answer", "messageId": "user-read-answer" }]
            }),
            fixture.root.clone(),
            config.clone(),
            Duration::from_millis(10),
        )
        .expect("Rust runtime should complete tool-backed turn");
    let run = call_rust_state_service(
        &fixture.thread_store,
        config.clone(),
        WorkerRequest::new(
            "req-agent-turn-get",
            "trace-agent-turn-get",
            "thread.turn.get",
            serde_json::json!({
                "threadId": "websocket:chat-run-trace",
                "turnId": "turn-trace-persist"
            }),
        ),
        "agent turn read",
    )
    .expect("agent turn record should persist");
    let history = worker_session_messages_with_options(
        &shared,
        "websocket:chat-run-trace".to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("session messages should read");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(run["status"], "completed");
    assert_eq!(run["stopReason"], "final_response");
    assert_eq!(
        run["completedToolResults"][0]["toolCallId"],
        "call-run-trace"
    );
    let result_runtime_events = result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be returned");
    assert!(result_runtime_events
        .iter()
        .any(|event| event["eventName"] == "agent.provider.requested"));
    assert!(
        run.get("traceEvents").is_none(),
        "runtime trace must not be canonical"
    );
    assert_eq!(history["messages"].as_array().unwrap().len(), 2);
    assert!(history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|message| message["role"] != "tool"));
}

#[test]
fn worker_run_agent_projects_real_rust_run_into_canonical_session_history() {
    let fixture = WorkspaceFixture::new();
    fixture.write("README.md", "README thread body");
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-thread-run-trace",
                            "name": "update_plan",
                            "argumentsJson": "{\"plan\":[{\"step\":\"Project thread\",\"status\":\"completed\"}]}",
                            "result": { "content": "fixture result should not be used" }
                        }]
                    },
                    { "content": "thread projected answer" }
                ]
            }
        }
    });
    let session_id = "websocket:chat-thread-real-run";

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-thread-real",
            "sessionId": session_id,
            "maxIterations": 2,
            "messages": [{
                "role": "user",
                "content": "read README into thread",
                "messageId": "user-thread-real"
            }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete tool-backed turn");
    assert_eq!(result["stopReason"], "final_response");

    let history = worker_session_messages_with_options(
        &shared,
        session_id.to_string(),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("real Rust run should be visible in canonical session history");
    let messages = history["messages"]
        .as_array()
        .expect("session messages should be an array");
    assert!(messages.iter().any(|message| {
        message["role"] == "user" && message["content"] == "read README into thread"
    }));
    assert!(messages.iter().any(|message| {
        message["role"] == "assistant" && message["content"] == "thread projected answer"
    }));
    assert!(messages.iter().all(|message| message["role"] != "tool"));

    let run = call_rust_state_service(
        &fixture.thread_store,
        config.clone(),
        WorkerRequest::new(
            "req-real-run-agent-get",
            "trace-real-run-agent-get",
            "thread.turn.get",
            serde_json::json!({
                "threadId": session_id,
                "turnId": "turn-thread-real"
            }),
        ),
        "real Rust run agent record",
    )
    .expect("real Rust turn should persist an agent turn record");
    assert_eq!(run["status"], "completed");
    assert_eq!(run["stopReason"], "final_response");
    assert_eq!(
        run["completedToolResults"][0]["toolCallId"],
        "call-thread-run-trace"
    );
    assert!(run.get("traceEvents").is_none());
}

#[test]
fn session_owned_compaction_commits_installed_checkpoint_before_final_turn_persistence() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let session_id = "session-context-commit-integration";
    let config = serde_json::json!({
        "agents": { "defaults": {
            "provider": "fixture",
            "model": "fixture-model",
            "contextWindowTokens": 800,
            "contextWindowStrategy": "compact",
            "compactTriggerPercent": 50,
            "compactSummaryMaxTokens": 32
        } },
        "providers": { "fixture": { "responses": [
            { "content": "session compact answer" }
        ] } }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-session-context-commit",
            "sessionId": session_id,
            "messages": [
                { "role": "user", "content": "old context ".repeat(200) },
                { "role": "assistant", "content": "old answer ".repeat(200) },
                { "role": "user", "content": "current question" }
            ]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("session compaction should commit through thread-log authority");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["contextCheckpoint"]["checkpointStage"], "finalized");
    assert_eq!(result["contextCheckpoint"]["windowNumber"], 1);
    assert_eq!(
        result["contextCheckpoint"]["windowId"],
        result["contextCheckpoint"]["contextId"]
    );
    let context = call_rust_state_service(
        &fixture.thread_store,
        config.clone(),
        WorkerRequest::new(
            "req-session-context-after-commit",
            "trace-session-context-after-commit",
            "thread.context",
            serde_json::json!({ "threadId": session_id, "limit": 50 }),
        ),
        "session context after durable compaction",
    )
    .expect("durable session context should hydrate");
    assert!(context["messages"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|message| message["content"]
            .as_str()
            .is_some_and(|content| content.contains("session compact answer")))));
    assert!(
        context["messages"]
            .as_array()
            .is_some_and(|messages| messages
                .iter()
                .any(|message| { message["content"] == "session compact answer" })),
        "hydrated context should include the final answer: {context}"
    );

    let first_context_id = result["contextCheckpoint"]["contextId"]
        .as_str()
        .expect("first context checkpoint should have an id")
        .to_string();
    assert_eq!(context["contextCheckpoint"]["contextId"], first_context_id);
    let hydrated = crate::agent::bridge::hydrate_native_agent_history_for_runtime(
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-session-context-commit-next",
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "next current question" }]
        }),
        &fixture.thread_store,
        config,
    )
    .expect("next session run should hydrate canonical checkpoint lineage");
    assert_eq!(
        hydrated["metadata"]["contextSourceCheckpointId"],
        first_context_id
    );
    assert_eq!(
        hydrated["metadata"]["contextSourceCheckpoint"]["windowNumber"],
        1
    );
    assert_eq!(
        hydrated["metadata"]["contextSourceCheckpoint"]["windowId"],
        first_context_id
    );

    let thread_logs = compatibility_thread_log_paths(&fixture.root);
    assert_eq!(thread_logs.len(), 1);
    let lines = crate::threads::rollout::store::read_thread_lines(&thread_logs[0])
        .expect("session thread log should be readable");
    let stages = lines
        .iter()
        .filter_map(|line| match &line.item {
            crate::threads::rollout::store::ThreadLogItem::Compacted(checkpoint) => checkpoint
                .get("checkpointStage")
                .and_then(serde_json::Value::as_str),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(stages, vec!["installed", "finalized"]);
}

#[test]
fn worker_run_agent_uses_native_tool_executor_for_registered_memory_tool() {
    let fixture = WorkspaceFixture::new();
    fixture.write("README.md", "actual executor README body");
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-native-executor-search",
                            "name": "memory.search",
                            "argumentsJson": "{\"query\":\"README\"}",
                            "result": { "content": "fixture result should not be used" }
                        }]
                    },
                    { "content": "executor-backed final" }
                ]
            }
        }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-native-tool-executor",
            "sessionId": "websocket:chat-native-tool-executor",
            "maxIterations": 2,
            "selectedTools": ["memory.search"],
            "messages": [{
                "role": "user",
                "content": "read README through executor"
            }]
        }),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete executor-backed tool call");

    assert_eq!(result["stopReason"], "final_response");
    let tool_result = result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.tool.result")
        .expect("tool result event should be emitted");
    assert_eq!(
        tool_result["payload"]["envelope"]["raw"]["executor"]["toolId"],
        "memory.search"
    );
    assert_ne!(
        tool_result["payload"]["content"],
        "fixture result should not be used"
    );
}

#[test]
fn worker_run_agent_does_not_fallback_to_fixture_result_after_executor_error() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{
                    "content": "",
                    "toolCalls": [{
                        "id": "call-native-executor-missing",
                        "name": "memory.search",
                        "argumentsJson": "{not json",
                        "result": { "content": "fixture success must not be used" }
                    }]
                }]
            }
        }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-native-tool-executor-error",
            "sessionId": "websocket:chat-native-tool-executor-error",
            "maxIterations": 2,
            "selectedTools": ["memory.search"],
            "messages": [{ "role": "user", "content": "read a missing file" }]
        }),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("executor failure should return a structured tool error");

    assert_eq!(result["stopReason"], "tool_error");
    assert_eq!(result["completedToolResults"][0]["status"], "error");
    assert!(!result
        .to_string()
        .contains("fixture success must not be used"));
}
