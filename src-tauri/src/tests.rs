use super::*;
use crate::desktop_commands::gateway::{
    classify_bootstrap_response, current_status, persist_gateway_exit_policy, GatewayRuntimeStatus,
};
use crate::desktop_cron::{
    cron_model_from_config, worker_cron_dispatch_due_with_options,
    worker_cron_next_wake_delay_with_options,
};
use crate::desktop_files::{
    allowed_workspace_file_path, mime_type_for_path, reveal_workspace_file_path_from_config_path,
    upload_file_from_path, write_export_file,
};
use crate::desktop_heartbeat::build_worker_heartbeat_lifecycle_request;
use crate::desktop_menu::desktop_menu_item_descriptors;
use crate::worker_manager::WorkerManagerStatus;

fn test_request_correlation(suffix: &str) -> WorkerRequestCorrelation {
    WorkerRequestCorrelation::from_suffix(suffix)
}

#[test]
fn close_shutdown_stops_background_worker_child() {
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    {
        let runtime = lock_runtime(&shared);
        runtime
            .experimental_worker
            .start(test_gateway_worker_spec("ts-backend-close-worker"))
            .expect("test worker should start");
    }

    stop_owned_gateway(&shared, false).expect("background worker child should stop");

    let runtime = lock_runtime(&shared);
    assert_eq!(
        runtime.experimental_worker.status().state,
        crate::worker_manager::WorkerManagerState::Stopped
    );
    assert!(runtime
        .logs
        .iter()
        .any(|line| line == "stopped background worker"));
}

#[test]
fn start_gateway_defaults_to_rust_backend() {
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let status = crate::desktop_commands::gateway::start_gateway_with_options(&shared)
        .expect("Rust backend startup should not require TS worker");

    assert_eq!(status.owner, "shell");
    assert_eq!(status.state, "running");
    assert_eq!(status.command, "Tauri Rust backend");
    assert_eq!(
        status.worker_runtime.state,
        crate::worker_runtime::WorkerRuntimeState::Running
    );
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
    assert!(lock_runtime(&shared)
        .logs
        .iter()
        .any(|line| line == "Rust native backend active"));
}

#[test]
fn desktop_smoke_default_chat_runs_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let status = crate::desktop_commands::gateway::start_gateway_with_options(&shared)
        .expect("default desktop runtime should start Rust backend");

    let chat = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "messages": [{ "role": "user", "content": "desktop smoke" }],
                "stream": false
            })),
        },
        fixture.root.clone(),
        serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "smoke response from rust" }] } }
        }),
        Duration::from_millis(10),
    )
    .expect("desktop smoke chat should use Rust-owned route");

    assert_eq!(status.command, "Tauri Rust backend");
    assert_eq!(chat["status"], 200);
    assert_eq!(chat["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(
        chat["body"]["choices"][0]["message"]["content"],
        "smoke response from rust"
    );
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn gateway_status_reflects_running_managed_worker() {
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let worker = {
        let runtime = lock_runtime(&shared);
        runtime.experimental_worker.clone()
    };
    worker
        .start(test_gateway_short_worker_spec("gateway-runtime-worker"))
        .expect("test worker should start");

    let status = current_status(&shared);

    assert_eq!(
        status.worker_runtime.state,
        crate::worker_runtime::WorkerRuntimeState::Running
    );
    assert_eq!(
        status.worker_runtime.transport_mode,
        Some(crate::worker_protocol::WorkerTransportMode::Stdio)
    );
}

#[test]
fn gateway_status_reports_managed_worker_diagnostics() {
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let worker = {
        let runtime = lock_runtime(&shared);
        runtime.experimental_worker.clone()
    };
    worker
        .start(test_logging_sleep_worker_spec(
            "managed-worker",
            "managed worker diagnostic",
        ))
        .expect("managed worker should start");
    let _ = wait_for_worker_diagnostics(&worker, |diagnostics| {
        diagnostics
            .iter()
            .any(|line| line.line.contains("managed worker diagnostic"))
    });

    let status = current_status(&shared);
    let log_text = status.logs.join("\n");
    let diagnostic_text = status
        .worker_runtime
        .diagnostics
        .iter()
        .map(|line| line.line.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    assert!(log_text.contains("managed worker diagnostic"));
    assert!(diagnostic_text.contains("managed worker diagnostic"));
    assert_eq!(status.command, "Tauri Rust backend");
}

#[test]
fn worker_echo_agent_uses_experimental_fixture_worker() {
    let fixture = WorkspaceFixture::new();
    fixture.write("AGENTS.md", "agents");
    fixture.write("notes/today.md", "hello command");
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_echo_agent_with_options(
        &shared,
        "hello command".to_string(),
        fixture.root.clone(),
        serde_json::json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
        Duration::from_secs(5),
    )
    .expect("experimental worker echo should complete");

    assert!(result.ok);
    assert_eq!(result.echo, "hello command");
    assert_eq!(result.config_value, serde_json::json!("gpt-5"));
    assert_eq!(result.workspace_file_count, 2);

    let runtime = lock_runtime(&shared);
    assert_eq!(
        runtime.experimental_worker.status().state,
        WorkerManagerState::Running
    );
}

#[test]
fn native_backend_uses_default_tinybot_workspace_root() {
    let fixture = WorkspaceFixture::new();
    let expected = default_tinybot_workspace_root();

    assert_eq!(
        resolve_native_backend_workspace_root_from_config_path(&fixture.root.join("missing.json")),
        expected
    );
}

#[test]
fn native_backend_uses_configured_workspace_root() {
    let fixture = WorkspaceFixture::new();
    let workspace_root = fixture.root.join("workspace");
    fixture.write(
        "config.json",
        &serde_json::json!({
            "agents": {
                "defaults": {
                    "workspace": workspace_root.display().to_string()
                }
            }
        })
        .to_string(),
    );

    assert_eq!(
        resolve_native_backend_workspace_root_from_config_path(&fixture.root.join("config.json")),
        workspace_root
    );
}

#[test]
fn workspace_reveal_uses_configured_tinybot_workspace_root() {
    let fixture = WorkspaceFixture::new();
    let workspace_root = fixture.root.join("workspace");
    fixture.write(
        "config.json",
        &serde_json::json!({
            "agents": {
                "defaults": {
                    "workspace": workspace_root.display().to_string()
                }
            }
        })
        .to_string(),
    );

    assert_eq!(
        reveal_workspace_file_path_from_config_path(&fixture.root.join("config.json"), "AGENTS.md")
            .expect("allowed workspace file should resolve"),
        workspace_root.join("AGENTS.md")
    );
}

#[test]
fn experimental_worker_router_keeps_builtin_skills_root_separate_from_workspace_root() {
    let fixture = WorkspaceFixture::new();
    let workspace_root = fixture.root.join("workspace");
    let builtin_root = fixture.root.join("repo");
    std::fs::create_dir_all(&workspace_root).expect("workspace root should create");
    fixture.write(
        "repo/builtin-skills/builtin-fixture/SKILL.md",
        "---\nname: builtin-fixture\ndescription: Builtin fixture\n---\n",
    );
    let mut router = experimental_worker_router(workspace_root, serde_json::json!({}))
        .with_builtin_skills_root(builtin_root);
    let request = WorkerRequest::new("req-1", "trace-1", "skills.list", serde_json::json!({}));

    let response = router.dispatch(&request);
    let skills = response
        .result
        .as_ref()
        .and_then(|result| result.get("skills"))
        .and_then(serde_json::Value::as_array)
        .expect("skills.list should return skills array");

    assert!(response.error.is_none());
    assert!(skills.iter().any(|skill| {
        skill.get("source").and_then(serde_json::Value::as_str) == Some("builtin")
            && skill
                .get("path")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|path| path.starts_with("builtin-skills/"))
    }));
}

#[test]
fn experimental_worker_router_ignores_corrupt_session_store() {
    let fixture = WorkspaceFixture::new();
    fixture.write("sessions/store.json", "{not valid json");
    let mut router = experimental_worker_router(fixture.root.clone(), serde_json::json!({}));

    let response = router.dispatch(&WorkerRequest::new(
        "req-sessions",
        "trace-sessions",
        "session.list_metadata",
        serde_json::json!({}),
    ));

    assert_eq!(response.error, None);
    assert_eq!(
        response.result,
        Some(serde_json::json!([])),
        "corrupt session stores should not block native worker startup"
    );
}

#[test]
fn experimental_worker_config_snapshot_loads_real_tinybot_config() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
        "config.json",
        r#"{
          "agents": {
            "defaults": {
              "provider": "deepseek",
              "model": "deepseek-v4-flash"
            }
          },
          "knowledge": {
            "semanticLlmTimeout": 30.0,
            "semanticLlmMaxTokens": 1200
          }
        }"#,
    );
    let config_path = fixture.root.join("config.json");

    let snapshot = experimental_worker_config_snapshot_from_path(&config_path);

    assert_eq!(snapshot["agents"]["defaults"]["provider"], "deepseek");
    assert_eq!(snapshot["agents"]["defaults"]["model"], "deepseek-v4-flash");
    assert_eq!(snapshot["knowledge"]["semanticLlmTimeout"], 30.0);
}

#[test]
fn experimental_worker_config_defaults_to_schema_v1_deepseek_profile_without_config_file() {
    let fixture = WorkspaceFixture::new();
    assert_eq!(
        experimental_worker_config_snapshot_from_path(&fixture.root.join("missing-config.json")),
        serde_json::json!({
            "schemaVersion": 1,
            "agents": {
                "defaults": {
                    "activeProfile": "deepseek-default",
                    "model": "deepseek-v4-pro",
                    "workspace": "~/.tinybot/workspace"
                }
            },
            "providers": {
                "profiles": {
                    "deepseek-default": {
                        "provider": "deepseek",
                        "displayName": "DeepSeek",
                        "enabled": true,
                        "apiBase": "https://api.deepseek.com",
                        "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
                        "defaultModel": "deepseek-v4-pro",
                        "supportsModelDiscovery": true
                    }
                }
            },
            "gateway": {
                "host": "127.0.0.1",
                "port": 18790
            }
        })
    );
}

#[test]
fn experimental_worker_router_allows_registered_native_agent_tools() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
        "memory/notes.jsonl",
        &format!(
            "{}\n",
            serde_json::json!({
                "id": "note-workspace-policy",
                "scope": "user",
                "type": "preference",
                "status": "active",
                "content": "Use workspace command policies.",
                "priority": 0.8,
                "confidence": 0.9,
                "sources": []
            })
        ),
    );
    let mut router = experimental_worker_router(
        fixture.root.clone(),
        serde_json::json!({
            "tools": {
                "mcp_servers": {
                    "docs": {
                        "enabled_tools": ["search"],
                        "fixture_tools": {
                            "search": { "content": "docs result" }
                        }
                    }
                }
            }
        }),
    );

    let memory_response = router.dispatch(&crate::worker_protocol::WorkerRequest::new(
        "memory-search-1",
        "trace-memory-search",
        "memory.search",
        serde_json::json!({ "query": "uv", "limit": 3 }),
    ));
    let mcp_response = router.dispatch(&crate::worker_protocol::WorkerRequest::new(
        "mcp-call-1",
        "trace-mcp-call",
        "mcp.call_tool",
        serde_json::json!({
            "server": "docs",
            "tool": "search",
            "arguments": { "query": "agent loop" }
        }),
    ));

    assert!(
        memory_response.error.is_none(),
        "{:?}",
        memory_response.error
    );
    assert!(mcp_response.error.is_none(), "{:?}", mcp_response.error);
}

#[test]
fn experimental_worker_router_runtime_restart_restarts_stdio_worker() {
    let fixture = WorkspaceFixture::new();
    fixture.write("AGENTS.md", "agents");
    let manager = WorkerManager::new(20);
    let restart_spec = test_stdio_agent_echo_worker_spec();
    let router = experimental_worker_router_with_runtime_restart(
        manager.clone(),
        restart_spec.clone(),
        fixture.root.clone(),
        serde_json::json!({}),
    );

    manager
        .start_stdio_rpc(test_stdio_runtime_restart_worker_spec(), router)
        .expect("runtime restart worker should start");

    let status = wait_for_worker_status(&manager, |status| {
        status.state == WorkerManagerState::Running
            && status.label.as_deref() == Some("stdio-agent-echo-worker")
    });
    assert_eq!(status.state, WorkerManagerState::Running);
    assert_eq!(status.label.as_deref(), Some("stdio-agent-echo-worker"));

    let request = WorkerRequest::new(
        "agent-req-1",
        "trace-agent",
        "agent.echo",
        serde_json::json!({ "input": "hello after runtime restart" }),
    );
    let response = manager
        .send_stdio_request(&request, Duration::from_secs(15))
        .expect("restarted worker should accept stdio request");

    assert_eq!(response.result.as_ref().unwrap()["ok"], true);
    assert_eq!(
        response.result.as_ref().unwrap()["echo"],
        "hello after runtime restart"
    );

    manager.stop().expect("worker should stop");
}

#[test]
fn worker_run_agent_uses_rust_runtime_when_selected() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-rust-1",
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
    assert_eq!(result["events"][0]["eventName"], "agent.delta");
    assert_eq!(result["events"][1]["eventName"], "agent.usage");
    assert_eq!(result["events"][2]["eventName"], "agent.message.completed");
    assert_eq!(result["events"][3]["eventName"], "agent.done");
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_run_agent_preserves_legacy_tool_content_with_envelope_payload() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-rust-tool-envelope",
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
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "README excerpt" }
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
    assert_eq!(tool_result["payload"]["content"], "README excerpt");
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
fn worker_run_agent_persists_rust_turn_messages_in_session_store() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(UsageNativeAgentProvider),
            Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::default()
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "unused fixture response" }] } }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-persist",
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
    assert_eq!(history["messages"][1]["usage"]["prompt_tokens"], 10);
    assert_eq!(history["messages"][1]["usage"]["completion_tokens"], 97);
    assert_eq!(history["messages"][1]["usage"]["total_tokens"], 107);
}

#[test]
fn native_agent_run_record_includes_structured_token_usage_info() {
    let spec = serde_json::json!({
        "runtime": "rust",
        "runId": "run-token-info",
        "sessionId": "websocket:chat-token-info",
        "messages": [{ "role": "user", "content": "hello" }]
    });
    let result = serde_json::json!({
        "runtime": "rust",
        "runId": "run-token-info",
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

    let record = native_agent_run_record(
        &spec,
        &result,
        &serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } }
        }),
        "websocket:chat-token-info",
        "run-token-info",
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

impl crate::worker_agent_runtime::NativeAgentProvider for UsageNativeAgentProvider {
    fn complete(
        &self,
        _context: &crate::worker_agent_runtime::NativeAgentRunContext,
    ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
        Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
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

#[derive(Clone)]
struct RecordingNativeAgentProvider {
    calls: Arc<Mutex<Vec<Vec<serde_json::Value>>>>,
}

impl crate::worker_agent_runtime::NativeAgentProvider for RecordingNativeAgentProvider {
    fn complete(
        &self,
        context: &crate::worker_agent_runtime::NativeAgentRunContext,
    ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
        self.calls
            .lock()
            .expect("recording provider calls lock should not be poisoned")
            .push(context.messages.clone());
        Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
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

impl crate::worker_agent_runtime::NativeAgentProvider for ToolLoopRecordingNativeAgentProvider {
    fn complete(
        &self,
        context: &crate::worker_agent_runtime::NativeAgentRunContext,
    ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
        let call_count = {
            let mut calls = self
                .calls
                .lock()
                .expect("recording provider calls lock should not be poisoned");
            calls.push(context.messages.clone());
            calls.len()
        };
        if call_count == 1 {
            Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![crate::worker_agent_runtime::NativeAgentToolCall {
                    id: "call-durable-history".to_string(),
                    name: "workspace.read_file".to_string(),
                    arguments_json: "{\"path\":\"README.md\"}".to_string(),
                    result: serde_json::json!({ "content": "README durable body" }),
                }],
            })
        } else {
            Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
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

impl crate::worker_agent_runtime::NativeAgentProvider for MultiExchangeRecallProvider {
    fn complete(
        &self,
        context: &crate::worker_agent_runtime::NativeAgentRunContext,
    ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
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
        Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
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
            Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::default()
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "req-seed-history",
            "trace-seed-history",
            "session.persist_turn",
            serde_json::json!({
                "session_id": "websocket:chat-memory",
                "run_id": "run-previous",
                "messages": [
                    { "role": "user", "content": "a" },
                    { "role": "assistant", "content": "agent replied a" }
                ],
                "clear_checkpoint": true
            }),
        ),
        "seed session history",
    )
    .expect("session history should seed");

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-next",
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
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "a");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "agent replied a");
    assert_eq!(messages[2]["role"], "user");
    assert_eq!(messages[2]["content"], "what did I say before?");
}

#[test]
fn worker_run_agent_combines_session_history_with_current_tool_results() {
    let fixture = WorkspaceFixture::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: NativeAgentRuntimeServices::new(
            Arc::new(ToolLoopRecordingNativeAgentProvider {
                calls: calls.clone(),
            }),
            Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::default()
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "req-seed-tool-history",
            "trace-seed-tool-history",
            "session.persist_turn",
            serde_json::json!({
                "session_id": "websocket:chat-tool-memory",
                "run_id": "run-previous-tool-memory",
                "messages": [
                    { "role": "user", "content": "remember alpha" },
                    { "role": "assistant", "content": "alpha stored" }
                ],
                "clear_checkpoint": true
            }),
        ),
        "seed tool session history",
    )
    .expect("session history should seed");

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-tool-memory",
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
        config,
        Duration::from_millis(10),
    )
    .expect("session messages should stay compact after hydrated run");
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
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("README durable body"))
    }));
    assert_eq!(history["messages"].as_array().unwrap().len(), 4);
    assert!(history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|message| message["role"] != "tool"));
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
            Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::default()
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });
    let session_id = "websocket:chat-multi-recall";

    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-recall-1",
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
            "runId": "run-recall-2",
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
            "runId": "run-recall-3",
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
            Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::default()
    }));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
    });

    let first = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-terminal-reentry",
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
            "runId": "run-terminal-reentry",
            "sessionId": "websocket:chat-terminal-reentry",
            "messages": [{ "role": "user", "content": "try to continue" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("terminal reentry should return structured rejection");
    let run = read_agent_run_record(
        fixture.root.clone(),
        config,
        "websocket:chat-terminal-reentry",
        "run-terminal-reentry",
    );

    assert_eq!(first["stopReason"], "final_response");
    assert_eq!(second["stopReason"], "terminal_turn");
    assert_eq!(second["terminalRun"]["status"], "completed");
    assert_eq!(second["events"][0]["eventName"], "agent.error");
    assert_eq!(
        calls
            .lock()
            .expect("recording provider calls lock should not be poisoned")
            .len(),
        1
    );
    assert_eq!(run["status"], "completed");
    assert_eq!(run["phase"], "completed");
}

#[test]
fn worker_run_agent_persists_agent_run_record_and_keeps_history_compact() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-run-trace",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}",
                            "result": { "content": "README trace body" }
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
                "runId": "run-trace-persist",
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
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "req-agent-run-get",
            "trace-agent-run-get",
            "agent_run.get",
            serde_json::json!({
                "session_id": "websocket:chat-run-trace",
                "run_id": "run-trace-persist"
            }),
        ),
        "agent run read",
    )
    .expect("agent run record should persist");
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
    let trace_events = run["traceEvents"]
        .as_array()
        .expect("trace events should be an array");
    let result_runtime_events = result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be returned");
    assert_eq!(trace_events.len(), result_runtime_events.len());
    for (persisted, emitted) in trace_events.iter().zip(result_runtime_events) {
        assert_eq!(persisted["eventId"], emitted["eventId"]);
    }
    assert_eq!(trace_events[0]["schemaVersion"], "tinybot.agent_event.v1");
    assert_eq!(trace_events[0]["eventName"], "agent.phase.changed");
    assert_eq!(trace_events[0]["sequence"], 1);
    assert_eq!(trace_events[0]["payload"]["nextPhase"], "hydrating_history");
    assert_eq!(trace_events[1]["eventName"], "agent.phase.changed");
    assert_eq!(trace_events[1]["payload"]["nextPhase"], "planning");
    let turn_started = trace_events
        .iter()
        .find(|event| event["eventName"] == "agent.turn.started")
        .expect("turn started trace event should persist");
    assert_eq!(turn_started["payload"]["userMessageId"], "user-read-answer");
    assert_eq!(
        turn_started["payload"]["userMessage"]["content"],
        "read and answer"
    );
    assert!(trace_events.iter().any(|event| {
        event["eventName"] == "agent.phase.changed"
            && event["payload"]["nextPhase"] == "calling_model"
    }));
    assert!(trace_events
        .iter()
        .any(|event| event["eventName"] == "agent.tool.result"));
    assert!(trace_events.iter().any(|event| {
        event["eventName"] == "agent.phase.changed"
            && event["payload"]["nextPhase"] == "tool_calling"
    }));
    let tool_result = trace_events
        .iter()
        .find(|event| event["eventName"] == "agent.tool.result")
        .expect("tool result trace event should persist");
    assert_eq!(tool_result["schemaVersion"], "tinybot.agent_event.v1");
    assert_eq!(tool_result["itemId"], "call-run-trace");
    assert_eq!(tool_result["phase"], "tool_running");
    assert!(tool_result["sequence"]
        .as_u64()
        .is_some_and(|value| value > 1));
    assert!(trace_events.iter().any(|event| {
        event["eventName"] == "agent.phase.changed" && event["payload"]["nextPhase"] == "finalizing"
    }));
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
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-thread-run-trace",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}",
                            "result": { "content": "README thread body" }
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
            "runId": "run-thread-real",
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
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "req-real-run-agent-get",
            "trace-real-run-agent-get",
            "agent_run.get",
            serde_json::json!({
                "session_id": session_id,
                "run_id": "run-thread-real"
            }),
        ),
        "real Rust run agent record",
    )
    .expect("real Rust run should persist an agent run record");
    assert_eq!(run["status"], "completed");
    assert_eq!(run["stopReason"], "final_response");
    assert_eq!(
        run["completedToolResults"][0]["toolCallId"],
        "call-thread-run-trace"
    );
    assert!(run["traceEvents"]
        .as_array()
        .expect("trace events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.tool.result"));
}

#[test]
fn worker_run_agent_uses_native_tool_executor_for_registered_workspace_tool() {
    let fixture = WorkspaceFixture::new();
    fixture.write("README.md", "actual executor README body");
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-native-executor-read",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}",
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
            "runId": "run-native-tool-executor",
            "sessionId": "websocket:chat-native-tool-executor",
            "maxIterations": 2,
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
        "workspace.read_file"
    );
    assert_eq!(
        tool_result["payload"]["envelope"]["raw"]["result"]["contents"],
        "actual executor README body"
    );
    assert_ne!(
        tool_result["payload"]["content"],
        "fixture result should not be used"
    );
}

#[test]
fn worker_run_agent_persists_waiting_approval_run_record() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({});

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-waiting-persist",
            "sessionId": "websocket:chat-waiting-persist",
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-waiting-persist",
                    "toolName": "workspace.write_file"
                }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should return waiting approval");
    let run = read_agent_run_record(
        fixture.root.clone(),
        config,
        "websocket:chat-waiting-persist",
        "run-waiting-persist",
    );

    assert_eq!(result["stopReason"], "awaiting_approval");
    assert_eq!(run["status"], "waiting");
    assert_eq!(run["phase"], "awaiting_approval");
    assert_eq!(
        run["checkpoint"]["resumeToken"],
        "approval:approval-waiting-persist"
    );
    assert_eq!(
        run["pendingToolCalls"][0]["toolCallId"],
        "approval-waiting-persist"
    );
}

#[test]
fn worker_submit_thread_turn_projects_waiting_approval_into_thread_status() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({});
    let run_id = "run-thread-waiting";

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "needs approval" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": run_id,
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-thread-waiting",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should return waiting approval");
    assert_eq!(result["agentResult"]["stopReason"], "awaiting_approval");
    let thread_id = result["threadId"].as_str().unwrap().to_string();

    let status = call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "req-waiting-thread-status",
            "trace-waiting-thread-status",
            "thread.status",
            serde_json::json!({ "threadId": thread_id.clone() }),
        ),
        "waiting approval thread status",
    )
    .expect("waiting approval thread status should read");
    assert_eq!(status["thread"]["status"], "waiting_for_approval");
    assert_eq!(status["activeRun"]["runId"], run_id);
    assert_eq!(status["activeRun"]["status"], "waiting_for_approval");

    let snapshot = call_rust_state_service(
        fixture.root.clone(),
        config,
        WorkerRequest::new(
            "req-waiting-thread-read",
            "trace-waiting-thread-read",
            "thread.read",
            serde_json::json!({ "threadId": thread_id }),
        ),
        "waiting approval thread read",
    )
    .expect("waiting approval thread should be readable");
    assert!(snapshot["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["kind"]["type"] == "approval_requested"));
}

#[test]
fn worker_submit_thread_turn_creates_thread_and_runs_native_agent() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "thread-first answer" }]
            }
        }
    });

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "answer from a new thread" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": "run-thread-submit-new"
            }),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("thread-first submit should run native agent");

    let thread_id = result["threadId"].as_str().expect("thread id").to_string();
    assert_eq!(result["runId"], "run-thread-submit-new");
    assert_eq!(result["sessionId"], thread_id);
    assert_eq!(result["agentResult"]["stopReason"], "final_response");
    assert!(result["agentResult"]["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present")
        .iter()
        .all(|event| event["threadId"] == thread_id));
    assert_eq!(
        result["snapshot"]["thread"]["sessionKey"],
        serde_json::Value::String(thread_id)
    );
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["kind"]["type"] == "assistant_message_completed"));
}

#[test]
fn worker_submit_thread_turn_uses_existing_thread_session_key() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "existing thread answer" }]
            }
        }
    });
    let create_request = next_worker_request_correlation();
    let thread = call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            create_request.id("existing-thread-create"),
            create_request.trace_id("existing-thread-create"),
            "thread.create",
            serde_json::json!({
                "threadId": "thread-existing-submit",
                "sessionKey": "session-existing-submit",
                "title": "Existing thread"
            }),
        ),
        "existing thread create",
    )
    .expect("existing thread should create");

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: Some(
                thread["threadId"]
                    .as_str()
                    .expect("created thread id")
                    .to_string(),
            ),
            input: serde_json::json!("continue existing thread"),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": "run-thread-submit-existing"
            }),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("existing thread submit should run native agent");

    assert_eq!(result["threadId"], "thread-existing-submit");
    assert_eq!(result["sessionId"], "session-existing-submit");
    assert_eq!(
        result["agentResult"]["sessionId"],
        "session-existing-submit"
    );
    assert_eq!(
        result["snapshot"]["thread"]["threadId"],
        "thread-existing-submit"
    );
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["runId"] == "run-thread-submit-existing"));
}

#[test]
fn worker_submit_thread_turn_backfills_missing_existing_thread_session_key() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "backfilled thread answer" }]
            }
        }
    });
    let create_request = next_worker_request_correlation();
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            create_request.id("thread-without-session-create"),
            create_request.trace_id("thread-without-session-create"),
            "thread.create",
            serde_json::json!({
                "threadId": "thread-submit-backfill",
                "title": "Existing thread without session"
            }),
        ),
        "existing thread without session create",
    )
    .expect("thread without session key should create");

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: Some("thread-submit-backfill".to_string()),
            input: serde_json::json!("continue backfilled thread"),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": "run-thread-submit-backfill"
            }),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("thread submit should backfill session key and run native agent");

    assert_eq!(result["threadId"], "thread-submit-backfill");
    assert_eq!(result["sessionId"], "thread-submit-backfill");
    assert_eq!(
        result["snapshot"]["thread"]["sessionKey"],
        "thread-submit-backfill"
    );
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["runId"] == "run-thread-submit-backfill"));
}

#[test]
fn worker_thread_commands_expose_thread_service_surface() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({});

    let created = worker_thread_request_with_options(
        &shared,
        "test-thread-command-create",
        "thread.create",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "sessionKey": "session-command-surface",
            "title": "Command surface thread"
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread create command should work");
    assert_eq!(created["threadId"], "thread-command-surface");

    let list = worker_thread_request_with_options(
        &shared,
        "test-thread-command-list",
        "thread.list",
        serde_json::json!({ "includeArchived": true }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread list command should work");
    assert!(list["threads"]
        .as_array()
        .expect("threads should be an array")
        .iter()
        .any(|thread| thread["threadId"] == "thread-command-surface"));

    let search = worker_thread_request_with_options(
        &shared,
        "test-thread-command-search",
        "thread.search",
        serde_json::json!({
            "query": "surface",
            "includeArchived": true,
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread search command should work");
    assert!(search["threads"]
        .as_array()
        .expect("search threads should be an array")
        .iter()
        .any(|thread| thread["threadId"] == "thread-command-surface"));

    let read = worker_thread_request_with_options(
        &shared,
        "test-thread-command-read",
        "thread.read",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread read command should work");
    assert_eq!(read["thread"]["threadId"], "thread-command-surface");

    let resumed = worker_thread_request_with_options(
        &shared,
        "test-thread-command-resume",
        "thread.resume",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread resume command should work");
    assert_eq!(resumed["thread"]["threadId"], "thread-command-surface");

    let activity = worker_thread_request_with_options(
        &shared,
        "test-thread-command-activity",
        "thread.activity",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread activity command should work");
    assert_eq!(activity["threadId"], "thread-command-surface");

    let status = worker_thread_request_with_options(
        &shared,
        "test-thread-command-status",
        "thread.status",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread status command should work");
    assert_eq!(status["thread"]["threadId"], "thread-command-surface");

    let updated = worker_thread_request_with_options(
        &shared,
        "test-thread-command-update-metadata",
        "thread.update_metadata",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "metadata": { "title": "Renamed command surface" }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread update metadata command should work");
    assert_eq!(updated["title"], "Renamed command surface");

    let registry = worker_thread_request_with_options(
        &shared,
        "test-thread-command-agent-registry",
        "thread.agent_registry",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread agent registry command should work");
    assert_eq!(registry["rootThreadId"], "thread-command-surface");

    let archived = worker_thread_request_with_options(
        &shared,
        "test-thread-command-archive",
        "thread.archive",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread archive command should work");
    assert_eq!(archived["status"], "archived");

    let unarchived = worker_thread_request_with_options(
        &shared,
        "test-thread-command-unarchive",
        "thread.unarchive",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread unarchive command should work");
    assert_eq!(unarchived["status"], "empty");

    let started = worker_thread_request_with_options(
        &shared,
        "test-thread-command-start-turn",
        "thread.start_turn",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "runId": "run-command-surface",
            "input": { "text": "start from command" }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread start turn command should work");
    assert_eq!(started["run"]["runId"], "run-command-surface");
    assert!(
        started["appendedItems"]
            .as_array()
            .expect("start appended items should be an array")
            .len()
            >= 2
    );

    let continued = worker_thread_request_with_options(
        &shared,
        "test-thread-command-continue-turn",
        "thread.continue_turn",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "runId": "run-command-surface",
            "input": { "text": "continue from command" }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread continue turn command should work");
    assert!(continued["appendedItems"]
        .as_array()
        .expect("continue appended items should be an array")
        .iter()
        .any(|item| item["runId"] == "run-command-surface"));

    let applied = worker_thread_request_with_options(
        &shared,
        "test-thread-command-apply-op",
        "thread.apply_op",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "op": {
                "type": "tool_call_started",
                "runId": "run-command-surface",
                "toolCallId": "tool-command-surface",
                "toolName": "workspace.read_file",
                "args": { "path": "README.md" }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread apply op command should work");
    assert!(applied["appendedItems"]
        .as_array()
        .expect("apply-op appended items should be an array")
        .iter()
        .any(|item| item["kind"]["type"] == "tool_call_started"));

    let interrupted = worker_thread_request_with_options(
        &shared,
        "test-thread-command-interrupt",
        "thread.interrupt",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "runId": "run-command-surface",
            "reason": "test interrupt"
        }),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("thread interrupt command should work");
    assert!(interrupted["appendedItems"]
        .as_array()
        .expect("interrupt appended items should be an array")
        .iter()
        .any(|item| item["kind"]["type"] == "cancelled"));
}

#[test]
fn worker_resolve_thread_approval_resumes_checkpoint_and_updates_thread() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "approval command final" }]
            }
        }
    });
    let run_id = "run-thread-approval-command";
    let awaiting = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "needs approval command" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": run_id,
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-thread-command",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("awaiting approval run should persist");
    assert_eq!(awaiting["agentResult"]["stopReason"], "awaiting_approval");
    let thread_id = awaiting["threadId"].as_str().unwrap().to_string();
    let session_id = awaiting["sessionId"].as_str().unwrap().to_string();

    let result = worker_resolve_thread_approval_with_options(
        &shared,
        WorkerResolveThreadApprovalInput {
            thread_id: thread_id.clone(),
            approval_id: "approval-thread-command".to_string(),
            approved: true,
            scope: Some("once".to_string()),
            guidance: None,
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("thread approval command should resume run");

    assert_eq!(result["threadId"], thread_id);
    assert_eq!(result["sessionId"], session_id);
    assert_eq!(result["approvalResult"]["stopReason"], "final_response");
    assert_eq!(result["snapshot"]["thread"]["status"], "idle");
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(
            |item| item["kind"]["type"] == "assistant_message_completed" && item["runId"] == run_id
        ));
}

#[test]
fn worker_submit_thread_form_resumes_checkpoint_and_updates_thread() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({});
    let run_id = "run-thread-form-command";
    let awaiting = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "needs form command" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": run_id,
                "metadata": {
                    "fakeAwaitingForm": {
                        "formId": "form-thread-command",
                        "title": "Configure thread run"
                    }
                }
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("awaiting form run should persist");
    assert_eq!(awaiting["agentResult"]["stopReason"], "awaiting_form");
    let thread_id = awaiting["threadId"].as_str().unwrap().to_string();
    let session_id = awaiting["sessionId"].as_str().unwrap().to_string();

    let result = worker_submit_thread_form_with_options(
        &shared,
        WorkerSubmitThreadFormInput {
            thread_id: thread_id.clone(),
            form_id: "form-thread-command".to_string(),
            values: serde_json::json!({}),
            action: Some("submit".to_string()),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("thread form command should resume run");

    assert_eq!(result["threadId"], thread_id);
    assert_eq!(result["sessionId"], session_id);
    assert_eq!(result["formResult"]["statusCode"], 200);
    assert_eq!(result["formResult"]["stopReason"], "final_response");
    assert_eq!(result["snapshot"]["thread"]["status"], "idle");
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(
            |item| item["kind"]["type"] == "assistant_message_completed" && item["runId"] == run_id
        ));
}

#[test]
fn native_agent_trace_sink_updates_runtime_state_before_final_persistence() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({});
    let session_id = "websocket:chat-trace-sink";
    let run_id = "run-trace-sink";
    let spec = serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
    });
    persist_native_agent_run_start(spec, fixture.root.clone(), config.clone())
        .expect("run start should persist");
    let mut emitter = crate::agent_loop_runtime_protocol::AgentRunEmitter::new(session_id, run_id);
    let event = emitter.awaiting_approval(
        "unix-ms:1",
        "approval-trace-sink",
        serde_json::json!({
            "toolName": "workspace.write_file",
            "summary": "Approval required: workspace.write_file",
        }),
    );
    let sink = crate::native_agent_bridge::NativeAgentRunTraceSink::new(
        fixture.root.clone(),
        config.clone(),
    );

    sink.append_trace_event(session_id, run_id, &event)
        .expect("trace sink should append event");
    let runtime_state = worker_agent_run_runtime_state_with_options(
        &shared,
        session_id.to_string(),
        run_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("runtime state should read appended trace event");

    assert!(runtime_state["runtimeEvents"]
        .as_array()
        .expect("runtime events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.awaiting_approval"));
    let approval_item = runtime_state["turnItems"]
        .as_array()
        .expect("turn items should be an array")
        .iter()
        .find(|item| item["kind"] == "approval_request")
        .expect("approval request item should be restored");
    assert_eq!(approval_item["status"], "waiting");
    assert_eq!(
        approval_item["payload"]["approvalId"],
        "approval-trace-sink"
    );
}

#[test]
fn worker_run_agent_persists_failed_tool_run_with_accumulated_trace() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{
                    "content": "",
                    "toolCalls": [
                        {
                            "id": "call-before-tool-error",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}",
                            "result": { "content": "README before tool error" }
                        },
                        {
                            "id": "call-tool-error",
                            "name": "workspace.list_files",
                            "argumentsJson": "{not json",
                            "result": { "content": "unused" }
                        }
                    ]
                }]
            }
        }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-tool-error-persist",
            "sessionId": "websocket:chat-tool-error-persist",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "read then fail" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should return structured tool error");
    let run = read_agent_run_record(
        fixture.root.clone(),
        config,
        "websocket:chat-tool-error-persist",
        "run-tool-error-persist",
    );

    assert_eq!(result["stopReason"], "tool_error");
    assert_eq!(run["status"], "failed");
    assert_eq!(run["stopReason"], "tool_error");
    assert_eq!(
        run["completedToolResults"][0]["toolCallId"],
        "call-before-tool-error"
    );
    assert!(run["traceEvents"]
        .as_array()
        .expect("trace events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.error"
            && event["payload"]["toolCallId"] == "call-tool-error"));
}

#[test]
fn worker_run_agent_persists_cancelled_run_as_cancelled() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({});

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-cancel-persist",
            "sessionId": "websocket:chat-cancel-persist",
            "metadata": { "fakeCancel": true },
            "messages": [{ "role": "user", "content": "cancel me" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should return structured cancellation");
    let run = read_agent_run_record(
        fixture.root.clone(),
        config,
        "websocket:chat-cancel-persist",
        "run-cancel-persist",
    );

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(run["status"], "cancelled");
    assert_eq!(run["phase"], "cancelled");
    assert_eq!(run["checkpoint"]["phase"], "cancelled");
}

#[test]
fn worker_run_agent_persists_redacted_bounded_tool_trace() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": {
            "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "maxToolResultChars": 12
            }
        },
        "providers": {
            "fixture": {
                "api_key": "secret-token",
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-redacted",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}",
                            "result": { "content": "secret-token ABCDEFGHIJKLMNOP" }
                        }]
                    },
                    { "content": "bounded final" }
                ]
            }
        }
    });

    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-redacted-trace",
            "sessionId": "websocket:chat-redacted-trace",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read bounded" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete bounded tool run");
    let run = read_agent_run_record(
        fixture.root.clone(),
        config,
        "websocket:chat-redacted-trace",
        "run-redacted-trace",
    );
    let serialized = run.to_string();
    let envelope = &run["completedToolResults"][0]["envelope"];

    assert!(!serialized.contains("secret-token"));
    assert_eq!(envelope["truncation"]["truncated"], true);
    assert_eq!(envelope["continuation"]["nextOffset"], 12);
    assert!(envelope["modelContent"].as_str().unwrap().chars().count() <= 12);
}

#[test]
fn worker_run_agent_omits_large_raw_tool_trace_from_persisted_run_record() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let large_output = "A".repeat(12_000);
    let config = serde_json::json!({
        "agents": {
            "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "maxToolResultChars": 128
            }
        },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-large",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"large.txt\"}",
                            "result": { "content": large_output }
                        }]
                    },
                    { "content": "large final" }
                ]
            }
        }
    });

    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-large-trace",
            "sessionId": "websocket:chat-large-trace",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read large" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete large tool run");
    let run = read_agent_run_record(
        fixture.root.clone(),
        config,
        "websocket:chat-large-trace",
        "run-large-trace",
    );
    let serialized = run.to_string();

    assert!(
        serialized.len() < large_output.len() + 10_000,
        "run record was {} bytes",
        serialized.len()
    );
    assert!(!serialized.contains(&"A".repeat(512)));
    assert_eq!(
        run["completedToolResults"][0]["tracePersistence"]["truncated"],
        true
    );
}

fn read_agent_run_record(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    session_id: &str,
    run_id: &str,
) -> serde_json::Value {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            "req-agent-run-get",
            "trace-agent-run-get",
            "agent_run.get",
            serde_json::json!({
                "session_id": session_id,
                "run_id": run_id,
            }),
        ),
        "agent run read",
    )
    .expect("agent run record should persist")
}

#[test]
fn worker_rust_agent_restore_and_cancel_use_native_runtime_state() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let rust_config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    let awaiting = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-approval",
            "sessionId": "WebSocket:chat-approval",
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-1",
                    "toolName": "workspace.write_file"
                }
            }
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create an approval checkpoint");
    let restored = worker_restore_agent_checkpoint_with_options(
        &shared,
        "WebSocket:chat-approval".to_string(),
        fixture.root.clone(),
        rust_config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should restore checkpoints without TS worker");
    let cancelled = worker_cancel_agent_with_options(
        &shared,
        "run-cancel".to_string(),
        rust_config,
        Duration::from_millis(10),
    )
    .expect("Rust runtime should cancel without TS worker");

    assert_eq!(awaiting["stopReason"], "awaiting_approval");
    assert_eq!(restored["runtime"], "rust");
    assert_eq!(restored["checkpoint"]["phase"], "awaiting_approval");
    assert_eq!(restored["checkpoint"]["schemaVersion"], 1);
    assert_eq!(restored["checkpoint"]["iteration"], 0);
    assert_eq!(restored["checkpoint"]["maxIterations"], 1);
    assert_eq!(
        restored["checkpoint"]["pendingToolCalls"]
            .as_array()
            .expect("pending tool calls should be an array")
            .len(),
        1
    );
    assert_eq!(
        restored["checkpoint"]["completedToolResults"]
            .as_array()
            .expect("completed tool results should be an array")
            .len(),
        0
    );
    assert_eq!(cancelled["stopReason"], "cancelled");
    assert_eq!(cancelled["error"], "cancelled");
    assert_eq!(cancelled["events"][0]["eventName"], "agent.cancelled");
    assert_eq!(cancelled["events"][0]["payload"]["stopReason"], "cancelled");
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_rust_agent_restores_checkpoint_from_session_store_after_runtime_restart() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let rust_config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    let awaiting = worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-persisted-approval",
            "sessionId": "websocket:chat-persisted-approval",
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-persisted",
                    "toolName": "workspace.write_file"
                }
            }
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create an approval checkpoint");
    let restored = worker_restore_agent_checkpoint_with_options(
        &restarted_runtime,
        "websocket:chat-persisted-approval".to_string(),
        fixture.root.clone(),
        rust_config,
        Duration::from_millis(10),
    )
    .expect("Rust runtime should restore persisted checkpoint after restart");

    assert_eq!(awaiting["stopReason"], "awaiting_approval");
    assert_eq!(restored["runtime"], "rust");
    assert_eq!(restored["checkpoint"]["phase"], "awaiting_approval");
    assert_eq!(restored["checkpoint"]["schemaVersion"], 1);
    assert_eq!(
        restored["checkpoint"]["resumeToken"],
        "approval:approval-persisted"
    );
    assert_eq!(
        restored["checkpoint"]["payload"]["approval_id"],
        "approval-persisted"
    );
    assert_eq!(
        lock_runtime(&restarted_runtime)
            .experimental_worker
            .status()
            .state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_rust_agent_restore_rejects_unknown_checkpoint_schema_version() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    {
        let services = {
            let runtime = lock_runtime(&shared);
            runtime.native_agent_runtime.clone()
        };
        services.save_checkpoint(
            "websocket:chat-future-checkpoint",
            serde_json::json!({
                "schemaVersion": 999,
                "runtime": "rust",
                "runId": "run-future-checkpoint",
                "sessionId": "websocket:chat-future-checkpoint",
                "phase": "awaiting_approval"
            }),
        );
    }

    let error = worker_restore_agent_checkpoint_with_options(
        &shared,
        "websocket:chat-future-checkpoint".to_string(),
        fixture.root.clone(),
        serde_json::json!({ "desktop": { "nativeAgentRuntime": "rust" } }),
        Duration::from_millis(10),
    )
    .expect_err("unknown checkpoint versions should fail visibly");

    assert!(
        error.contains("unsupported Rust agent checkpoint schemaVersion 999"),
        "unexpected error: {error}"
    );
}

#[test]
fn worker_webui_approvals_lists_persisted_rust_approval_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-persisted-approval-list";

    worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-persisted-approval-list",
            "sessionId": session_id,
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-persisted-list",
                    "toolName": "workspace.write_file",
                    "summary": "write notes"
                }
            }
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create an approval checkpoint");

    let approvals = worker_webui_route_with_options(
        &restarted_runtime,
        WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/approvals?session_key=websocket%3Achat-persisted-approval-list".to_string(),
            headers: None,
            body: None,
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("approvals route should read persisted Rust checkpoint");

    assert_eq!(approvals["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(approvals["body"]["session_key"], session_id);
    assert_eq!(
        approvals["body"]["approvals"][0]["id"],
        "approval-persisted-list"
    );
    assert_eq!(
        approvals["body"]["approvals"][0]["tool_name"],
        "workspace.write_file"
    );
    assert_eq!(
        lock_runtime(&restarted_runtime)
            .experimental_worker
            .status()
            .state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_webui_approval_resolution_clears_persisted_rust_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-persisted-approval-resolve";
    let rust_config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-persisted-approval-resolve",
            "sessionId": session_id,
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-persisted-resolve",
                    "toolName": "workspace.write_file"
                }
            }
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create an approval checkpoint");

    let approval_resolution = worker_webui_route_with_options(
        &restarted_runtime,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/approvals/approval-persisted-resolve/approve".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "session_key": session_id,
                "scope": "session"
            })),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("approval resolution route should read persisted Rust checkpoint");
    let restored_after_resolution = worker_restore_agent_checkpoint_with_options(
        &restarted_runtime,
        session_id.to_string(),
        fixture.root.clone(),
        rust_config,
        Duration::from_millis(10),
    )
    .expect("checkpoint restore should still be Rust-owned after approval resolution");

    assert_eq!(
        approval_resolution["headers"]["x-tinybot-route-owner"],
        "rust"
    );
    assert_eq!(approval_resolution["body"]["ok"], true);
    assert_eq!(approval_resolution["body"]["status"], "approved");
    assert_eq!(
        approval_resolution["body"]["approvalId"],
        "approval-persisted-resolve"
    );
    assert_eq!(
        approval_resolution["body"]["restoredCheckpoint"]["phase"],
        "awaiting_approval"
    );
    assert!(restored_after_resolution["checkpoint"].is_null());
}

#[test]
fn worker_webui_approval_resolution_finalizes_rust_turn_and_persists_result() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-approval-finalize";
    let config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-approval-finalize",
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "write the note" }],
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-finalize",
                    "toolName": "workspace.write_file"
                }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create an approval checkpoint");

    let approval_resolution = worker_webui_route_with_options(
        &restarted_runtime,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/approvals/approval-finalize/approve".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "session_key": session_id,
                "scope": "once",
                "finalContent": "Approved route completed."
            })),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("approval resolution route should finalize the Rust turn");
    let history = worker_session_messages_with_options(
        &restarted_runtime,
        session_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("session messages route should read finalized approval turn");

    assert_eq!(
        approval_resolution["headers"]["x-tinybot-route-owner"],
        "rust"
    );
    assert_eq!(approval_resolution["body"]["ok"], true);
    assert_eq!(approval_resolution["body"]["status"], "approved");
    assert_eq!(approval_resolution["body"]["stopReason"], "final_response");
    assert_eq!(
        approval_resolution["body"]["finalContent"],
        "Approved route completed."
    );
    assert_eq!(history["messages"][0]["role"], "user");
    assert_eq!(history["messages"][0]["content"], "write the note");
    assert_eq!(history["messages"][1]["role"], "assistant");
    assert_eq!(
        history["messages"][1]["content"],
        "Approved route completed."
    );
}

#[test]
fn worker_webui_approval_denial_finalizes_with_rust_error_result() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-approval-deny";
    let config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-approval-deny",
            "sessionId": session_id,
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-deny",
                    "toolName": "workspace.write_file"
                }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create an approval checkpoint");

    let approval_resolution = worker_webui_route_with_options(
        &restarted_runtime,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/approvals/approval-deny/deny".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "session_key": session_id,
                "guidance": "Do not write files; summarize instead."
            })),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("approval denial route should finalize the Rust turn");
    let restored_after_resolution = worker_restore_agent_checkpoint_with_options(
        &restarted_runtime,
        session_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("checkpoint restore should remain Rust-owned after denial");

    assert_eq!(
        approval_resolution["headers"]["x-tinybot-route-owner"],
        "rust"
    );
    assert_eq!(approval_resolution["body"]["ok"], true);
    assert_eq!(approval_resolution["body"]["status"], "denied");
    assert_eq!(approval_resolution["body"]["stopReason"], "provider_error");
    assert!(approval_resolution["body"]["error"]
        .as_str()
        .unwrap_or_default()
        .contains("provider"));
    assert_eq!(
        approval_resolution["body"]["guidance"],
        "Do not write files; summarize instead."
    );
    assert_eq!(
        approval_resolution["body"]["completedToolResults"][0]["status"],
        "denied"
    );
    assert!(restored_after_resolution["checkpoint"].is_null());
}

#[test]
fn worker_webui_agent_ui_form_submit_finalizes_rust_turn_and_persists_result() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-form-submit";
    let config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-form-submit",
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "collect travel details" }],
            "metadata": {
                "fakeAwaitingForm": {
                    "formId": "travel_plan",
                    "title": "Travel plan",
                    "fields": [
                        { "name": "destination", "type": "text", "required": true }
                    ]
                }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create a form checkpoint");

    let form_submission = worker_webui_route_with_options(
        &restarted_runtime,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/agent-ui/forms/travel_plan/submit".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "correlation": { "session_key": session_id },
                "values": { "destination": "Paris" },
                "finalContent": "Submitted values received."
            })),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("form submit route should finalize the Rust turn");
    let history = worker_session_messages_with_options(
        &restarted_runtime,
        session_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("session messages route should read finalized form turn");

    assert_eq!(form_submission["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(form_submission["body"]["submitted"], true);
    assert_eq!(form_submission["body"]["form_id"], "travel_plan");
    assert_eq!(form_submission["body"]["values"]["destination"], "Paris");
    assert_eq!(form_submission["body"]["stopReason"], "final_response");
    assert_eq!(
        form_submission["body"]["finalContent"],
        "Submitted values received."
    );
    assert_eq!(history["messages"][0]["content"], "collect travel details");
    assert_eq!(
        history["messages"][1]["content"],
        "Submitted values received."
    );
}

#[test]
fn worker_webui_agent_ui_form_cancel_finalizes_with_rust_error_result() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-form-cancel";
    let config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-form-cancel",
            "sessionId": session_id,
            "metadata": {
                "fakeAwaitingForm": {
                    "formId": "travel_cancel",
                    "title": "Travel cancellation"
                }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create a form checkpoint");

    let form_cancellation = worker_webui_route_with_options(
        &restarted_runtime,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/agent-ui/forms/travel_cancel/cancel".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "correlation": { "session_id": session_id }
            })),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("form cancel route should finalize the Rust turn");
    let restored_after_resolution = worker_restore_agent_checkpoint_with_options(
        &restarted_runtime,
        session_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("checkpoint restore should remain Rust-owned after form cancellation");

    assert_eq!(
        form_cancellation["headers"]["x-tinybot-route-owner"],
        "rust"
    );
    assert_eq!(form_cancellation["body"]["cancelled"], true);
    assert_eq!(form_cancellation["body"]["form_id"], "travel_cancel");
    assert_eq!(form_cancellation["body"]["stopReason"], "form_cancelled");
    assert_eq!(
        form_cancellation["body"]["error"],
        "Rust agent form was cancelled."
    );
    assert!(restored_after_resolution["checkpoint"].is_null());
}

#[test]
fn worker_webui_agent_ui_form_submit_reports_validation_errors_without_consuming_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let first_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let restarted_runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let session_id = "websocket:chat-form-validation";
    let config = serde_json::json!({
        "desktop": { "nativeAgentRuntime": "rust" }
    });

    worker_run_agent_with_options(
        &first_runtime,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-form-validation",
            "sessionId": session_id,
            "metadata": {
                "fakeAwaitingForm": {
                    "formId": "travel_validation",
                    "fields": [
                        { "name": "destination", "type": "text", "required": true }
                    ]
                }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should create a form checkpoint");

    let form_submission = worker_webui_route_with_options(
        &restarted_runtime,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/api/agent-ui/forms/travel_validation/submit".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "correlation": { "session_key": session_id },
                "values": {}
            })),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("form submit route should return validation errors");
    let restored_after_validation = worker_restore_agent_checkpoint_with_options(
        &restarted_runtime,
        session_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("checkpoint restore should remain Rust-owned after validation failure");

    assert_eq!(form_submission["status"], 400);
    assert_eq!(form_submission["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(form_submission["body"]["submitted"], false);
    assert_eq!(form_submission["body"]["errors"]["destination"], "Required");
    assert_eq!(
        restored_after_validation["checkpoint"]["phase"],
        "awaiting_form"
    );
}

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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn cron_model_from_config_defaults_to_agent_model() {
    assert_eq!(
        cron_model_from_config(&serde_json::json!({})),
        "deepseek-v4-pro"
    );
}

#[test]
fn worker_heartbeat_lifecycle_requests_target_native_worker_methods() {
    let start = build_worker_heartbeat_lifecycle_request(test_request_correlation("42"), "start");
    assert_eq!(start.id, "heartbeat-start-42");
    assert_eq!(start.trace_id, "trace-heartbeat-start-42");
    assert_eq!(start.method, "heartbeat.start");
    assert_eq!(start.params, serde_json::json!({}));

    let stop = build_worker_heartbeat_lifecycle_request(test_request_correlation("43"), "stop");
    assert_eq!(stop.id, "heartbeat-stop-43");
    assert_eq!(stop.trace_id, "trace-heartbeat-stop-43");
    assert_eq!(stop.method, "heartbeat.stop");
    assert_eq!(stop.params, serde_json::json!({}));
}

#[test]
fn worker_cron_dispatch_due_noops_without_due_jobs() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
            "cron/jobs.json",
            &serde_json::json!({
                "version": 1,
                "jobs": [
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
                    }
                ]
            })
            .to_string(),
        );
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_cron_dispatch_due_with_options(
        &shared,
        fixture.root.clone(),
        serde_json::json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
        2000,
        Duration::from_secs(1),
    )
    .expect("cron due dispatch should no-op");

    assert_eq!(
        result,
        serde_json::json!({
            "dispatched": 0,
            "records": [],
            "recorded": { "updated": [], "deleted": [], "missing": [] }
        })
    );
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_cron_next_wake_delay_uses_earliest_enabled_job() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
            "cron/jobs.json",
            &serde_json::json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "later",
                        "name": "Later",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 5000 },
                        "payload": { "kind": "agent_turn", "message": "later", "deliver": false },
                        "state": { "nextRunAtMs": 5000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "disabled-earlier",
                        "name": "Disabled",
                        "enabled": false,
                        "schedule": { "kind": "at", "atMs": 2500 },
                        "payload": { "kind": "agent_turn", "message": "disabled", "deliver": false },
                        "state": { "nextRunAtMs": 2500, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "earliest",
                        "name": "Earliest",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 3500 },
                        "payload": { "kind": "agent_turn", "message": "soon", "deliver": false },
                        "state": { "nextRunAtMs": 3500, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    }
                ]
            })
            .to_string(),
        );

    let delay = worker_cron_next_wake_delay_with_options(
        fixture.root.clone(),
        serde_json::json!({}),
        2000,
        Duration::from_secs(30),
    )
    .expect("cron next wake should be derived from store");

    assert_eq!(delay, Duration::from_millis(1500));
}

#[test]
fn worker_cron_next_wake_delay_backs_off_due_jobs_while_dispatch_is_unsupported() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
            "cron/jobs.json",
            &serde_json::json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "due",
                        "name": "Due",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 1000 },
                        "payload": { "kind": "agent_turn", "message": "now", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    }
                ]
            })
            .to_string(),
        );

    let delay = worker_cron_next_wake_delay_with_options(
        fixture.root.clone(),
        serde_json::json!({}),
        2000,
        Duration::from_secs(30),
    )
    .expect("cron next wake should back off due jobs");

    assert_eq!(delay, Duration::from_secs(30));
}

#[test]
fn worker_cron_dispatch_due_skips_when_dispatch_already_running() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    {
        let runtime = lock_runtime(&shared);
        runtime
            .cron_dispatch_running
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    let result = worker_cron_dispatch_due_with_options(
        &shared,
        fixture.root.clone(),
        serde_json::json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
        2000,
        Duration::from_secs(1),
    )
    .expect("overlapping cron dispatch should skip");

    assert_eq!(
        result,
        serde_json::json!({
            "dispatched": 0,
            "records": [],
            "recorded": { "updated": [], "deleted": [], "missing": [] },
            "skipped": "already_running"
        })
    );
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_session_read_commands_use_rust_session_store() {
    let fixture = WorkspaceFixture::new();
    fixture.write_session_store(serde_json::json!({
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_agent_run_runtime_commands_use_rust_session_store() {
    let fixture = WorkspaceFixture::new();
    fixture.write_session_store(serde_json::json!({
        "version": 1,
        "sessions": [{
            "session_id": "websocket:chat-1",
            "title": "Native session",
            "workspace_dir": "D:/Code/py/tinybot",
            "created_at": "2026-07-03T01:00:00Z",
            "updated_at": "2026-07-03T01:00:02Z",
            "extra": {
                "agent_runs": [{
                    "sessionId": "websocket:chat-1",
                    "runId": "run-1",
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
                    "traceEvents": [{
                        "schemaVersion": "tinybot.agent_event.v1",
                        "eventId": "run-1:agent-done:0000000000000001",
                        "sequence": 1,
                        "sessionId": "websocket:chat-1",
                        "turnId": "run-1",
                        "itemId": "run-1:assistant",
                        "eventName": "agent.done",
                        "phase": "completed",
                        "timestamp": "2026-07-03T01:00:02Z",
                        "source": "rust_backend",
                        "visibility": "user",
                        "payload": { "finalContent": "Done from runtime state" }
                    }],
                    "completedToolResults": [],
                    "pendingToolCalls": [],
                    "checkpoint": null,
                    "artifacts": [],
                    "usage": [],
                    "error": null
                }]
            }
        }]
    }));
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let runs = worker_agent_runs_list_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("agent run list should be served by Rust session state");
    let runtime_state = worker_agent_run_runtime_state_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        "run-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("agent run runtime state should be served by Rust session state");

    assert_eq!(runs["runs"][0]["runId"], "run-1");
    assert_eq!(runtime_state["sessionId"], "websocket:chat-1");
    assert_eq!(runtime_state["runId"], "run-1");
    assert_eq!(runtime_state["turnItems"][0]["kind"], "assistant_message");
    assert_eq!(
        runtime_state["turnItems"][0]["payload"]["content"],
        "Done from runtime state"
    );
}

#[test]
fn worker_session_write_commands_use_rust_session_store_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    fixture.write_session_store(serde_json::json!({
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

    let uploaded = worker_session_upload_temporary_file_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        serde_json::json!({
            "name": "context.md",
            "file_type": "md",
            "content": "hello native",
            "size_bytes": 12
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("temporary upload should be served by Rust session state");
    let temporary_files = worker_session_temporary_files_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("temporary file list should be served by Rust session state");
    let patch = worker_session_patch_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        serde_json::json!({ "metadata": { "pinned": true } }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("session patch should be served by Rust session state");
    let cleared_files = worker_session_clear_temporary_files_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("temporary file clear should be served by Rust session state");
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
            "planId": "plan-1",
            "progress": { "completed": 1, "total": 2 },
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

    assert_eq!(uploaded["name"], "context.md");
    assert_eq!(temporary_files["key"], "websocket:chat-1");
    assert_eq!(temporary_files["temporary_files"][0]["name"], "context.md");
    assert_eq!(patch["key"], "websocket:chat-1");
    assert_eq!(patch["metadata"]["pinned"], true);
    assert_eq!(cleared_files["cleared"], 1);
    assert_eq!(cleared_session["messages_before"], 1);
    assert_eq!(progress["key"], "websocket:chat-1");
    assert_eq!(
        progress["extra"]["messages"][0]["_task_progress"]["completed"],
        1
    );
    assert_eq!(deleted["key"], "websocket:chat-1");
    assert_eq!(deleted["deleted"], true);
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_session_branch_creates_new_session_without_runtime_state() {
    let fixture = WorkspaceFixture::new();
    fixture.write_session_store(serde_json::json!({
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_webui_route_serves_rust_owned_state_routes_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    fixture.write("docs/readme.md", "hello route");
    fixture.write_session_store(serde_json::json!({
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
    let knowledge = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/v1/knowledge/documents".to_string(),
            headers: None,
            body: Some(serde_json::json!({
                "name": "Route Knowledge.md",
                "content": "# Route Knowledge\n\nRust owns route metadata.\n",
                "file_type": "md"
            })),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge route should be Rust-owned");
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
    assert_eq!(branch["headers"]["x-tinybot-route-owner"], "rust");
    assert_eq!(branch["body"]["title"], "Route session · 分叉");
    assert_eq!(workspace_file["body"]["content"], "hello route");
    assert_eq!(knowledge["body"]["document"]["name"], "Route Knowledge.md");
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
    assert!(current_status(&shared)
        .compatibility_fallback_diagnostics
        .is_empty());
}

#[test]
fn worker_webui_route_returns_unsupported_for_unimplemented_inventory_route_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let response = worker_webui_route_with_options(
        &shared,
        WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/v1/knowledge/graph/extract".to_string(),
            headers: None,
            body: Some(serde_json::json!({ "text": "hello" })),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(1),
    )
    .expect("unsupported route should return a structured response");

    let status = current_status(&shared);
    assert_eq!(response["status"], 501);
    assert_eq!(response["headers"]["x-tinybot-route-owner"], "unsupported");
    assert_eq!(response["headers"]["x-tinybot-route-group"], "knowledge");
    assert_eq!(response["body"]["inventoryStatus"], "unsupported");
    assert_eq!(response["body"]["routeGroup"], "knowledge");
    assert!(response["body"]["reason"]
        .as_str()
        .is_some_and(|reason| reason.contains("not implemented")));
    assert!(status.compatibility_fallback_diagnostics.is_empty());
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_webui_route_uses_default_timeout_for_graph_extraction_start() {
    assert_eq!(
        worker_webui_route_timeout(&WorkerWebuiRouteInput {
            method: "POST".to_string(),
            path: "/v1/knowledge/graph/extract".to_string(),
            body: None,
            headers: None,
        }),
        Duration::from_secs(10)
    );
    assert_eq!(
        worker_webui_route_timeout(&WorkerWebuiRouteInput {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            body: None,
            headers: None,
        }),
        Duration::from_secs(10)
    );
}

#[test]
fn worker_transport_websocket_inbound_result_builds_agent_run_input_request() {
    let mapper_result = serde_json::json!({
        "kind": "message",
        "chatId": "chat-1",
        "sessionId": "websocket:chat-1",
        "frames": [],
        "inbound": {
            "channel": "websocket",
            "sender_id": "client-1",
            "chat_id": "chat-1",
            "content": "hello",
            "metadata": { "_use_persistent_rag": true },
            "session_key": "websocket:chat-1"
        }
    });

    let request = build_worker_transport_websocket_run_input_request(
        test_request_correlation("42"),
        &mapper_result,
        WorkerTransportWebSocketDispatchOptions {
            model: Some("gpt-5".to_string()),
            max_iterations: Some(6),
            stream: None,
            ..WorkerTransportWebSocketDispatchOptions::default()
        },
    )
    .expect("message mapper result should build a run request");

    assert_eq!(request.id, "transport-websocket-run-input-42");
    assert_eq!(request.trace_id, "trace-transport-websocket-run-input-42");
    assert_eq!(request.method, "agent.run_input");
    assert_eq!(
        request.params,
        serde_json::json!({
            "input": {
                "runId": "websocket-chat-1-42",
                "sessionId": "websocket:chat-1",
                "input": { "role": "user", "content": "hello" },
                "channel": "websocket",
                "chatId": "chat-1",
                "model": "gpt-5",
                "maxIterations": 6,
                "stream": true,
                "metadata": {
                    "_use_persistent_rag": true,
                    "_wants_stream": true
                }
            }
        })
    );

    assert!(build_worker_transport_websocket_run_input_request(
        test_request_correlation("43"),
        &serde_json::json!({ "kind": "ping", "frames": [{ "event": "pong" }] }),
        WorkerTransportWebSocketDispatchOptions::default(),
    )
    .is_none());
}

#[test]
fn worker_transport_websocket_new_chat_returns_created_frame_without_run_request() {
    let input = WorkerTransportWebSocketDispatchInput {
        client_id: "client-1".to_string(),
        frame: serde_json::json!({ "type": "new_chat" }),
        attached_chat_id: None,
        session_exists: None,
        editable_paths: None,
        model: None,
        max_iterations: None,
        run_id: None,
        stream: None,
    };

    let result = native_websocket_transport_result(&input)
        .expect("new chat websocket frame should produce a transport result");

    assert_eq!(result["kind"], "new_chat");
    assert!(result["chatId"]
        .as_str()
        .is_some_and(|chat_id| chat_id.starts_with("chat-")));
    assert!(result["sessionId"]
        .as_str()
        .is_some_and(|session_id| session_id.starts_with("websocket:chat-")));
    assert_eq!(result["attachedChatId"], result["chatId"]);
    assert_eq!(result["frames"][0]["event"], "chat_created");
    assert_eq!(result["frames"][0]["chat_id"], result["chatId"]);
    assert!(build_worker_transport_websocket_run_input_request(
        test_request_correlation("44"),
        &result,
        WorkerTransportWebSocketDispatchOptions::default(),
    )
    .is_none());
}

#[test]
fn worker_transport_websocket_dispatch_uses_preallocated_run_id_for_streaming() {
    let mapper_result = serde_json::json!({
        "kind": "message",
        "chatId": "chat-1",
        "sessionId": "websocket:chat-1",
        "frames": [],
        "inbound": {
            "channel": "websocket",
            "sender_id": "client-1",
            "chat_id": "chat-1",
            "content": "hello",
            "metadata": {},
            "session_key": "websocket:chat-1"
        }
    });

    let request = build_worker_transport_websocket_run_input_request(
        test_request_correlation("42"),
        &mapper_result,
        WorkerTransportWebSocketDispatchOptions {
            run_id: Some("websocket-chat-1-preallocated".to_string()),
            ..WorkerTransportWebSocketDispatchOptions::default()
        },
    )
    .expect("message mapper result should build a run request");

    assert_eq!(
        request.params["input"]["runId"],
        serde_json::Value::String("websocket-chat-1-preallocated".to_string())
    );
}

#[test]
fn worker_transport_websocket_dispatch_runs_basic_message_through_rust_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_transport_dispatch_websocket_message_with_options(
        &shared,
        WorkerTransportWebSocketDispatchInput {
            client_id: "client-1".to_string(),
            frame: serde_json::json!({
                "type": "message",
                "chat_id": "chat-1",
                "content": "hello native websocket",
                "metadata": { "source": "test" }
            }),
            attached_chat_id: Some("chat-1".to_string()),
            session_exists: Some(true),
            editable_paths: None,
            model: Some("fixture-model".to_string()),
            max_iterations: Some(4),
            run_id: Some("websocket-chat-1-rust".to_string()),
            stream: Some(true),
        },
        fixture.root.clone(),
        serde_json::json!({
            "desktop": { "nativeAgentRuntime": "rust" },
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "rust websocket answer" }] } }
        }),
        Duration::from_millis(10),
    )
    .expect("basic websocket message should dispatch through Rust");

    assert_eq!(result["transport"]["kind"], "message");
    assert_eq!(result["transport"]["sessionId"], "websocket:chat-1");
    assert_eq!(result["agent"]["runtime"], "rust");
    assert_eq!(result["agent"]["runId"], "websocket-chat-1-rust");
    assert_eq!(result["agent"]["stopReason"], "final_response");
    assert_eq!(result["agent"]["finalContent"], "rust websocket answer");
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
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
                "childRunId": "delegate-1",
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_knowledge_state_commands_use_rust_store_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let added = worker_knowledge_add_document_with_options(
        &shared,
        serde_json::json!({
            "name": "Native Knowledge.md",
            "content": "# Native Knowledge\n\nRust state services own knowledge metadata.\n",
            "category": "desktop",
            "tags": ["native", "rust"],
            "file_type": "md"
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge add should use Rust store without starting TS worker");
    let doc_id = added["document"]["id"]
        .as_str()
        .expect("added document should include an id")
        .to_string();
    let listed = worker_knowledge_documents_with_options(
        &shared,
        WorkerKnowledgeDocumentsInput {
            category: Some("desktop".to_string()),
            limit: Some(5),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge list should use Rust store without starting TS worker");
    let document = worker_knowledge_document_with_options(
        &shared,
        doc_id.clone(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge get should use Rust store without starting TS worker");
    let stats = worker_knowledge_stats_with_options(
        &shared,
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge stats should use Rust store without starting TS worker");
    let graph = worker_knowledge_graph_with_options(
        &shared,
        WorkerKnowledgeGraphInput {
            doc_id: Some(doc_id.clone()),
            graph_type: Some("document".to_string()),
            limit: Some(10),
            edge_limit: Some(10),
            min_confidence: None,
            include_orphans: Some(true),
        },
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge graph should use Rust store without starting TS worker");
    let rebuild = worker_knowledge_rebuild_index_with_options(
        &shared,
        Some("tree".to_string()),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge rebuild should use Rust store without starting TS worker");
    let job = worker_knowledge_job_with_options(
        &shared,
        rebuild["id"]
            .as_str()
            .expect("rebuild job should include id")
            .to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge job should use Rust store without starting TS worker");
    let deleted = worker_knowledge_delete_document_with_options(
        &shared,
        doc_id.clone(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("knowledge delete should use Rust store without starting TS worker");

    assert_eq!(listed["documents"][0]["id"], doc_id);
    assert_eq!(document["document"]["name"], "Native Knowledge.md");
    assert_eq!(stats["document_count"], 1);
    assert_eq!(graph["object"], "knowledge_graph");
    assert_eq!(job["status"], "completed");
    assert_eq!(deleted["deleted"], true);
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
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
            child_run_id: Some("run-1".to_string()),
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
            "childRunId": "run-1",
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
            child_run_id: Some("run-1".to_string()),
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn gateway_status_exposes_port_and_exit_policy() {
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        experimental_worker: WorkerManager::new(200),
        logs: VecDeque::with_capacity(200),
        last_error: None,
        keep_background: true,
        ..GatewayRuntime::default()
    }));

    let status = current_status(&shared);

    assert_eq!(status.port, 18790);
    assert_eq!(status.exit_policy, "keep_running");
}

#[test]
fn gateway_exit_policy_preference_persists_across_runtime_restart() {
    let path = std::env::temp_dir().join(format!(
        "tinybot-desktop-gateway-exit-policy-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);

    persist_gateway_exit_policy(&path, true).expect("preference should persist");

    assert!(load_gateway_exit_policy(&path));

    persist_gateway_exit_policy(&path, false).expect("preference should update");

    assert!(!load_gateway_exit_policy(&path));

    let _ = std::fs::remove_file(path);
}

#[test]
fn worker_diagnostics_append_to_persistent_backend_log() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        persistent_log_path: log_path.clone(),
        ..GatewayRuntime::default()
    }));

    record_worker_manager_event_for_logs(
        &shared,
        &WorkerManagerEvent::Diagnostics(crate::worker_protocol::WorkerDiagnosticLine::new(
            "stderr",
            "[native-backend] worker.request.start route=POST /v1/knowledge/graph/extract",
        )),
    );

    let contents =
        std::fs::read_to_string(log_path).expect("persistent backend log should be written");
    assert!(contents.contains(
        "stderr [native-backend] worker.request.start route=POST /v1/knowledge/graph/extract"
    ));
}

#[test]
fn renderer_diagnostics_append_to_persistent_backend_log() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        persistent_log_path: log_path.clone(),
        ..GatewayRuntime::default()
    }));

    record_renderer_diagnostic_with_options(
        &shared,
        serde_json::json!({
            "id": "renderer-1",
            "type": "react.render",
            "message": "render exploded",
            "recentDebugStages": [
                { "stage": "socket.frame", "at": "2026-07-06T01:00:00.000Z" }
            ]
        }),
    )
    .expect("renderer diagnostic should persist");

    let contents =
        std::fs::read_to_string(log_path).expect("persistent backend log should be written");
    assert!(contents.contains("renderer"));
    assert!(contents.contains("\"type\":\"react.render\""));
    assert!(contents.contains("\"message\":\"render exploded\""));
    assert!(contents.contains("\"stage\":\"socket.frame\""));
}

#[test]
fn renderer_diagnostics_truncate_on_utf8_boundary() {
    let line = format!("{}你好", "a".repeat((16 * 1024) - 1));

    let truncated = truncate_utf8_with_ellipsis(line, 16 * 1024);

    assert!(truncated.ends_with("..."));
    assert!(truncated.is_char_boundary(truncated.len()));
    assert_eq!(truncated, format!("{}...", "a".repeat((16 * 1024) - 1)));
}

#[test]
fn gateway_status_exposes_recent_persistent_backend_log_tail() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    std::fs::create_dir_all(log_path.parent().expect("log path should have parent"))
        .expect("log directory should create");
    std::fs::write(
            &log_path,
            "older line\nworker.request.start route=POST /v1/knowledge/graph/extract\nknowledge.graph.extract.progress percent=60\n",
        )
        .expect("persistent log should write");
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        persistent_log_path: log_path,
        ..GatewayRuntime::default()
    }));

    let status = current_status(&shared);

    assert_eq!(status.log_tail.len(), 3);
    assert!(status
        .log_tail
        .iter()
        .any(|line| line.contains("POST /v1/knowledge/graph/extract")));
    assert!(status
        .log_tail
        .iter()
        .any(|line| line.contains("knowledge.graph.extract.progress")));
}

#[test]
fn persistent_backend_log_rotates_when_size_limit_is_exceeded() {
    let fixture = WorkspaceFixture::new();
    let log_path = fixture.root.join("logs").join("native-backend.log");
    std::fs::create_dir_all(log_path.parent().expect("log path should have parent"))
        .expect("log directory should create");
    std::fs::write(&log_path, "older diagnostic line\n").expect("old log should write");

    append_native_backend_log_line(&log_path, 8, "stderr", "new diagnostic line")
        .expect("new log line should append");

    let rotated = std::fs::read_to_string(log_path.with_extension("log.1"))
        .expect("rotated log should exist");
    let current = std::fs::read_to_string(log_path).expect("current log should exist");
    assert!(rotated.contains("older diagnostic line"));
    assert!(current.contains("stderr new diagnostic line"));
}

#[test]
fn native_config_patch_result_persists_legacy_compatible_config_file() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    let result = apply_config_patch_result_to_path(
            &config_path,
            serde_json::json!({"agents":{"defaults":{"model":"gpt-4.1-mini","provider":"openai"}}}),
            crate::config_store::ConfigPatchBridgeResult {
                ok: true,
                config: serde_json::json!({"agents":{"defaults":{"model":"gpt-4.1","provider":"openai"}}}),
                updated_fields: vec!["agents.defaults.model".to_string()],
                side_effects: crate::config_store::ConfigPatchSideEffects {
                    applied: vec!["providerRuntimeChanged".to_string()],
                    restart_required: vec![],
                    warnings: vec![],
                },
                error: None,
            },
        )
        .expect("native config patch should persist");

    assert!(result.ok);
    assert_eq!(result.config["agents"]["defaults"]["model"], "gpt-4.1");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(config_path).expect("config file should save")
        )
        .expect("saved config should be JSON")["agents"]["defaults"]["model"],
        "gpt-4.1"
    );
}

#[test]
fn native_config_editor_snapshot_returns_redacted_revisioned_view() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(
        &config_path,
        r#"{
              "agents": { "defaults": { "model": "gpt-5" } },
              "providers": { "openai": { "api_key": "sk-secret" } }
            }"#,
    )
    .expect("fixture config should write");

    let snapshot = config_editor_snapshot_from_path(
        &config_path,
        serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
    )
    .expect("editor snapshot should load");

    assert_eq!(snapshot.config_path, config_path);
    assert!(snapshot.revision.starts_with("hash:"));
    assert_eq!(
        snapshot.explicit_public_config["providers"]["openai"]["api_key_configured"],
        true
    );
    assert!(snapshot.explicit_public_config["providers"]["openai"]
        .get("api_key")
        .is_none());
    assert_eq!(
        snapshot.secret_presence["providers.openai.api_key"]["configured"],
        true
    );
}

#[test]
fn ensure_default_config_file_creates_schema_v1_deepseek_profile_when_missing() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");

    let diagnostics = ensure_default_config_file(&config_path)
        .expect("missing config should initialize default file");

    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>(),
        vec![crate::config_store::ConfigDiagnosticCode::DefaultConfigCreated]
    );
    let saved = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(&config_path).expect("default config should be created"),
    )
    .expect("default config should be JSON");
    assert_eq!(saved["schemaVersion"], 1);
    assert_eq!(
        saved["agents"]["defaults"]["activeProfile"],
        "deepseek-default"
    );
    assert_eq!(saved["agents"]["defaults"]["model"], "deepseek-v4-pro");
    assert!(saved["agents"]["defaults"].get("provider").is_none());
    assert_eq!(
        saved["providers"]["profiles"]["deepseek-default"]["provider"],
        "deepseek"
    );
    assert_eq!(
        saved["providers"]["profiles"]["deepseek-default"]["models"],
        serde_json::json!(["deepseek-v4-pro", "deepseek-v4-flash"])
    );
    assert_eq!(saved["gateway"]["host"], "127.0.0.1");
    assert_eq!(saved["gateway"]["port"], 18790);
    assert!(!fixture.root.join(".tinybot").join("workspace").exists());
}

#[test]
fn ensure_default_config_file_does_not_overwrite_existing_or_invalid_config() {
    let fixture = WorkspaceFixture::new();
    let valid_path = fixture.root.join("valid").join("config.json");
    if let Some(parent) = valid_path.parent() {
        std::fs::create_dir_all(parent).expect("valid parent should create");
    }
    std::fs::write(&valid_path, r#"{"agents":{"defaults":{"model":"custom"}}}"#)
        .expect("fixture config should write");

    let diagnostics =
        ensure_default_config_file(&valid_path).expect("existing config should not be overwritten");

    assert!(diagnostics.is_empty());
    assert_eq!(
        std::fs::read_to_string(&valid_path).expect("valid config should remain"),
        r#"{"agents":{"defaults":{"model":"custom"}}}"#
    );

    let invalid_path = fixture.root.join("invalid").join("config.json");
    if let Some(parent) = invalid_path.parent() {
        std::fs::create_dir_all(parent).expect("invalid parent should create");
    }
    std::fs::write(&invalid_path, "{ invalid json").expect("invalid fixture should write");

    let diagnostics = ensure_default_config_file(&invalid_path)
        .expect("invalid existing config should not be overwritten");

    assert!(diagnostics.is_empty());
    assert_eq!(
        std::fs::read_to_string(&invalid_path).expect("invalid config should remain"),
        "{ invalid json"
    );
}

#[test]
fn config_editor_snapshot_ensures_missing_default_config_before_loading() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");

    let snapshot = config_editor_snapshot_from_path(
        &config_path,
        experimental_worker_default_config_snapshot(),
    )
    .expect("editor snapshot should initialize missing config");

    assert!(config_path.exists());
    assert_eq!(
        snapshot.effective_public_config["agents"]["defaults"]["activeProfile"],
        "deepseek-default"
    );
    assert_eq!(
        snapshot
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>(),
        vec![crate::config_store::ConfigDiagnosticCode::DefaultConfigCreated]
    );
}

#[test]
fn config_editor_snapshot_reports_default_config_create_failure_as_diagnostic() {
    let fixture = WorkspaceFixture::new();
    let blocked_parent = fixture.root.join("blocked");
    std::fs::write(&blocked_parent, "not a directory").expect("blocking parent file should write");
    let config_path = blocked_parent.join("config.json");

    let snapshot = config_editor_snapshot_from_path(
        &config_path,
        experimental_worker_default_config_snapshot(),
    )
    .expect("editor snapshot should remain readable with in-memory defaults");

    assert_eq!(
        snapshot
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>(),
        vec![
            crate::config_store::ConfigDiagnosticCode::DefaultConfigCreateFailed,
            crate::config_store::ConfigDiagnosticCode::MissingConfig,
        ]
    );
    assert_eq!(
        snapshot.effective_public_config["agents"]["defaults"]["activeProfile"],
        "deepseek-default"
    );
    assert_eq!(
        std::fs::read_to_string(&blocked_parent).expect("blocked parent should remain a file"),
        "not a directory"
    );
}

#[test]
fn native_settings_snapshot_returns_registry_projection() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(
        &config_path,
        r#"{
              "agents": { "defaults": { "active_profile": "openai-work", "model": "gpt-5" } },
              "providers": {
                "profiles": {
                  "openai-work": {
                    "provider": "openai",
                    "api_key": "sk-secret",
                    "default_model": "gpt-5-mini"
                  }
                }
              },
              "gateway": { "host": "0.0.0.0", "port": 18791 }
            }"#,
    )
    .expect("fixture config should write");

    let snapshot = get_settings_snapshot_from_path(
        &config_path,
        serde_json::json!({ "gateway": { "host": "127.0.0.1", "port": 18790 } }),
    )
    .expect("settings snapshot should load");

    let group_ids: Vec<&str> = snapshot
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();
    assert_eq!(group_ids[0], "general");
    assert!(group_ids.contains(&"provider-models"));
    assert!(group_ids.contains(&"expert-config"));
    assert!(!group_ids.contains(&"knowledge"));

    let provider_group = snapshot
        .groups
        .iter()
        .find(|group| group.id == "provider-models")
        .expect("provider group should exist");
    let api_key = provider_group
        .fields
        .iter()
        .find(|field| field.path == "providers.profiles.openai-work.apiKey")
        .expect("api key field should exist");
    assert_eq!(api_key.value, serde_json::Value::Null);
    assert_eq!(
        api_key
            .secret
            .as_ref()
            .expect("secret metadata should exist")
            .configured,
        true
    );

    let gateway_group = snapshot
        .groups
        .iter()
        .find(|group| group.id == "gateway-runtime")
        .expect("gateway group should exist");
    let host = gateway_group
        .fields
        .iter()
        .find(|field| field.path == "gateway.host")
        .expect("host field should exist");
    assert!(!host.editable);
    assert_eq!(host.value, serde_json::json!("127.0.0.1"));
}

#[test]
fn native_config_operations_preserve_secret_while_saving_unrelated_field() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(
        &config_path,
        r#"{
              "agents": { "defaults": { "model": "gpt-5", "timezone": "UTC" } },
              "providers": { "openai": { "api_key": "sk-secret" } }
            }"#,
    )
    .expect("fixture config should write");
    let store = crate::config_store::ConfigStore::load(
        config_path.clone(),
        serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
    )
    .expect("fixture config should load");

    let result = apply_config_operations_to_path(
        &config_path,
        serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
        crate::config_store::ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![crate::config_store::ConfigOperation::Replace {
                path: "agents.defaults.timezone".to_string(),
                value: serde_json::json!("Asia/Shanghai"),
            }],
        },
    )
    .expect("native config operations should persist");

    assert!(result.ok);
    assert_eq!(result.updated_fields, vec!["agents.defaults.timezone"]);
    assert_eq!(
        result.config["providers"]["openai"]["api_key_configured"],
        true
    );
    assert!(result.config["providers"]["openai"]
        .get("api_key")
        .is_none());
    let saved = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(config_path).expect("config file should save"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
    assert_eq!(saved["providers"]["openai"]["api_key"], "sk-secret");
}

#[test]
fn native_config_operations_save_to_custom_config_path() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join("portable").join("custom-config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(&config_path, r#"{"agents":{"defaults":{"model":"gpt-5"}}}"#)
        .expect("fixture config should write");
    let store = crate::config_store::ConfigStore::load(config_path.clone(), serde_json::json!({}))
        .expect("custom config should load");

    let result = apply_config_operations_to_path(
        &config_path,
        serde_json::json!({}),
        crate::config_store::ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![crate::config_store::ConfigOperation::Replace {
                path: "agents.defaults.timezone".to_string(),
                value: serde_json::json!("Asia/Shanghai"),
            }],
        },
    )
    .expect("custom config operation should persist");

    assert!(result.ok);
    let saved = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(&config_path).expect("custom config should save"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["model"], "gpt-5");
    assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
    assert!(!fixture.root.join(".tinybot").join("config.json").exists());
}

#[test]
fn bootstrap_probe_classifies_incompatible_2xx_response() {
    let probe = classify_bootstrap_response(
        Some(200),
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>not tinybot</html>",
    );

    assert_eq!(probe.bootstrap_status(), "incompatible");
    assert_eq!(
        probe.response_class(),
        Some("incompatible-bootstrap".to_string())
    );
    assert!(probe
        .last_error()
        .expect("incompatible probe should explain the response")
        .contains("not valid JSON"));
}

#[test]
fn bootstrap_probe_classifies_http_error_response() {
    let probe = classify_bootstrap_response(
        Some(403),
        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{\"error\":\"forbidden\"}",
    );

    assert_eq!(probe.bootstrap_status(), "bootstrap_error");
    assert_eq!(probe.response_class(), Some("HTTP 403".to_string()));
}

#[test]
fn gateway_runtime_status_serializes_worker_runtime_status() {
    let status = GatewayRuntimeStatus {
        state: "running".to_string(),
        owner: "external".to_string(),
        http_ok: true,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "Tauri Rust backend",
        port: 18790,
        repo_root: "/repo".to_string(),
        log_path: "/logs/native-backend.log".to_string(),
        log_tail: vec![],
        logs: vec![],
        last_error: None,
        exit_policy: "stop_on_exit",
        bootstrap_status: "ready".to_string(),
        response_class: Some("tinybot-bootstrap".to_string()),
        recovery_hint: None,
        worker_runtime: crate::worker_runtime::WorkerRuntimeStatus::stopped(),
        route_owner_summary: crate::native_backend_contract::native_route_owner_summary(),
        webui_route_inventory: crate::native_backend_contract::native_webui_route_inventory(),
        compatibility_fallback_diagnostics: vec![],
    };

    let value = serde_json::to_value(status).expect("status should serialize");

    assert_eq!(value["worker_runtime"]["state"], "stopped");
    assert!(value["worker_runtime"]["transport_mode"].is_null());
    assert!(value["route_owner_summary"]["rustOwned"]
        .as_u64()
        .is_some_and(|count| count > 0));
    assert!(value["webui_route_inventory"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
}

#[test]
fn worker_manager_status_event_maps_to_frontend_worker_status_event() {
    let (event_name, payload) =
        worker_manager_frontend_event(WorkerManagerEvent::Status(WorkerManagerStatus {
            state: WorkerManagerState::Running,
            label: Some("tinybot-gateway".to_string()),
            pid: Some(1234),
            started_at_unix_ms: Some(42),
            diagnostics: vec![],
            last_error: None,
        }));

    assert_eq!(event_name, "worker:status");
    assert_eq!(payload["state"], "running");
    assert_eq!(payload["label"], "tinybot-gateway");
    assert_eq!(payload["pid"], 1234);
}

#[test]
fn worker_manager_diagnostics_event_maps_to_frontend_diagnostics_log_event() {
    let (event_name, payload) = worker_manager_frontend_event(WorkerManagerEvent::Diagnostics(
        crate::worker_protocol::WorkerDiagnosticLine::new("stderr", "worker ready"),
    ));

    assert_eq!(event_name, "diagnostics:log");
    assert_eq!(payload["stream"], "stderr");
    assert_eq!(payload["line"], "worker ready");
}

#[test]
fn worker_manager_protocol_event_maps_to_frontend_protocol_event_name() {
    let (event_name, payload) = worker_manager_frontend_event(WorkerManagerEvent::Protocol(
        crate::worker_protocol::WorkerEvent {
            protocol_version: crate::worker_protocol::WORKER_PROTOCOL_VERSION.to_string(),
            trace_id: "trace-agent".to_string(),
            event: "agent.delta".to_string(),
            payload: serde_json::json!({ "message": "starting" }),
        },
    ));

    assert_eq!(event_name, "agent:delta");
    assert_eq!(payload["message"], "starting");
}

#[test]
fn worker_probe_status_reports_protocol_metadata() {
    let status = worker_probe_status();
    let value = serde_json::to_value(status).expect("worker probe status should serialize");

    assert_eq!(value["state"], "running");
    assert!(value["transport_mode"].is_null());
    assert_eq!(
        value["diagnostics"][0]["line"],
        format!(
            "rust backend protocol {}",
            crate::worker_protocol::WORKER_PROTOCOL_VERSION
        )
    );
}

#[test]
fn selected_upload_file_response_preserves_name_mime_size_and_bytes() {
    let path =
        std::env::temp_dir().join(format!("tinybot-desktop-upload-{}.md", std::process::id()));
    std::fs::write(&path, b"hello desktop").expect("test upload fixture should write");

    let file = upload_file_from_path(&path).expect("selected file should read");

    assert_eq!(file.name, path.file_name().unwrap().to_string_lossy());
    assert_eq!(file.mime_type, "text/markdown");
    assert_eq!(file.size_bytes, 13);
    assert_eq!(file.bytes, b"hello desktop");

    let _ = std::fs::remove_file(path);
}

#[test]
fn selected_upload_file_mime_fallback_is_octet_stream() {
    assert_eq!(
        mime_type_for_path(Path::new("archive.tinybot")),
        "application/octet-stream"
    );
    assert_eq!(mime_type_for_path(Path::new("image.PNG")), "image/png");
}

#[test]
fn workspace_reveal_path_accepts_only_allowed_workspace_files() {
    let root = Path::new("/repo");

    assert_eq!(
        allowed_workspace_file_path(root, "AGENTS.md").expect("allowed workspace file"),
        root.join("AGENTS.md")
    );
    assert_eq!(
        allowed_workspace_file_path(root, "memory/MEMORY.md")
            .expect("allowed nested workspace file"),
        root.join("memory").join("MEMORY.md")
    );
    assert!(allowed_workspace_file_path(root, "../secret.txt").is_err());
    assert!(allowed_workspace_file_path(root, "notes/private.md").is_err());
}

#[test]
fn export_file_write_preserves_utf8_contents() {
    let path =
        std::env::temp_dir().join(format!("tinybot-desktop-export-{}.md", std::process::id()));

    write_export_file(&path, "# Export\n\nHello.").expect("export file should write");

    assert_eq!(
        std::fs::read_to_string(&path).expect("export file should read"),
        "# Export\n\nHello."
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn desktop_application_menu_describes_core_workbench_commands() {
    let ids: Vec<&str> = desktop_menu_item_descriptors()
        .iter()
        .map(|item| item.id)
        .collect();

    assert_eq!(
        ids,
        vec![
            "new-chat",
            "stop-generation",
            "search-sessions",
            "open-settings",
            "open-docs",
            "open-shortcut-help",
            "open-page-help",
            "open-backend-logs",
            "toggle-theme",
            "toggle-sidebar",
            "open-command-palette",
            "refresh-gateway-status",
        ]
    );
    assert!(desktop_menu_item_descriptors()
        .iter()
        .any(|item| item.id == "toggle-sidebar" && item.checked));
    assert!(desktop_menu_item_descriptors()
        .iter()
        .any(|item| item.id == "stop-generation" && !item.enabled));
    assert_eq!(
        desktop_menu_item_descriptors()
            .iter()
            .map(|item| item.accelerator)
            .collect::<Vec<_>>(),
        vec![
            Some("Ctrl+N"),
            Some("Ctrl+."),
            Some("Ctrl+F"),
            Some("Ctrl+,"),
            Some("F1"),
            Some("Ctrl+/"),
            Some("Ctrl+Shift+/"),
            None,
            Some("Ctrl+Shift+T"),
            Some("Ctrl+B"),
            Some("Ctrl+Shift+P"),
            Some("Ctrl+Shift+G"),
        ]
    );
}

fn test_gateway_worker_spec(label: &str) -> crate::worker_manager::WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        crate::worker_manager::WorkerCommandSpec::new(
            "cmd",
            ["/C", "ping", "-n", "30", "127.0.0.1", ">", "NUL"],
            PathBuf::from("."),
        )
        .with_label(label)
    }

    #[cfg(not(target_os = "windows"))]
    {
        crate::worker_manager::WorkerCommandSpec::new("sh", ["-c", "sleep 30"], PathBuf::from("."))
            .with_label(label)
    }
}

fn test_gateway_short_worker_spec(label: &str) -> crate::worker_manager::WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        crate::worker_manager::WorkerCommandSpec::new(
            "cmd",
            ["/C", "ping", "-n", "3", "127.0.0.1", ">", "NUL"],
            PathBuf::from("."),
        )
        .with_label(label)
    }

    #[cfg(not(target_os = "windows"))]
    {
        crate::worker_manager::WorkerCommandSpec::new("sh", ["-c", "sleep 2"], PathBuf::from("."))
            .with_label(label)
    }
}

fn test_stdio_runtime_restart_worker_spec() -> crate::worker_manager::WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        crate::worker_manager::WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","id":"req-restart","trace_id":"trace-restart","method":"runtime.restart","params":{"run_id":"run-1","session_id":"session-1"}}'; [Console]::Out.WriteLine($json); $line = [Console]::In.ReadLine(); [Console]::Error.WriteLine($line)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-runtime-restart-worker")
    }

    #[cfg(not(target_os = "windows"))]
    {
        crate::worker_manager::WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","id":"req-restart","trace_id":"trace-restart","method":"runtime.restart","params":{"run_id":"run-1","session_id":"session-1"}}'; printf '%s\n' "$json"; IFS= read -r line; printf '%s\n' "$line" >&2"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-runtime-restart-worker")
    }
}

fn test_stdio_agent_echo_worker_spec() -> crate::worker_manager::WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        crate::worker_manager::WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$agent = [Console]::In.ReadLine(); $agentObj = $agent | ConvertFrom-Json; $final = @{ protocol_version = '1'; id = $agentObj.id; trace_id = $agentObj.trace_id; result = @{ ok = $true; echo = $agentObj.params.input; workspaceFileCount = 1 } } | ConvertTo-Json -Compress -Depth 8; [Console]::Out.WriteLine($final)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
    }

    #[cfg(not(target_os = "windows"))]
    {
        crate::worker_manager::WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"IFS= read -r agent; printf '%s\n' '{"protocol_version":"1","id":"agent-req-1","trace_id":"trace-agent","result":{"ok":true,"echo":"hello after runtime restart","workspaceFileCount":1}}'"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
    }
}

fn wait_for_worker_status(
    manager: &WorkerManager,
    predicate: impl Fn(&WorkerManagerStatus) -> bool,
) -> WorkerManagerStatus {
    for _ in 0..100 {
        let status = manager.status();
        if predicate(&status) {
            return status;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    manager.status()
}

fn test_logging_sleep_worker_spec(
    label: &str,
    message: &str,
) -> crate::worker_manager::WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        crate::worker_manager::WorkerCommandSpec::new(
            "cmd",
            ["/C", &format!("echo {message} & ping -n 3 127.0.0.1 > NUL")],
            PathBuf::from("."),
        )
        .with_label(label)
    }

    #[cfg(not(target_os = "windows"))]
    {
        crate::worker_manager::WorkerCommandSpec::new(
            "sh",
            ["-c", &format!("echo {message}; sleep 2")],
            PathBuf::from("."),
        )
        .with_label(label)
    }
}

fn wait_for_worker_diagnostics(
    manager: &WorkerManager,
    predicate: impl Fn(&[crate::worker_protocol::WorkerDiagnosticLine]) -> bool,
) -> Vec<crate::worker_protocol::WorkerDiagnosticLine> {
    for _ in 0..30 {
        let diagnostics = manager.status().diagnostics;
        if predicate(&diagnostics) {
            return diagnostics;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    manager.status().diagnostics
}

struct WorkspaceFixture {
    root: PathBuf,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-echo-command-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("workspace fixture should create");
        Self { root }
    }

    fn write(&self, relative_path: &str, contents: &str) {
        let path = self
            .root
            .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent should create");
        }
        std::fs::write(path, contents).expect("fixture file should write");
    }

    fn write_session_store(&self, store: serde_json::Value) {
        let path = self.root.join("sessions").join("sessions.sqlite");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture session parent should create");
        }
        let mut connection =
            rusqlite::Connection::open(path).expect("fixture session sqlite should open");
        connection
            .execute_batch(
                "
                    CREATE TABLE IF NOT EXISTS sessions (
                        session_id TEXT PRIMARY KEY NOT NULL,
                        title TEXT NOT NULL,
                        workspace_dir TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        session_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
                        ON sessions(updated_at DESC, session_id ASC);
                    ",
            )
            .expect("fixture session schema should create");
        let transaction = connection
            .transaction()
            .expect("fixture session transaction should start");
        transaction
            .execute("DELETE FROM sessions", [])
            .expect("fixture sessions should clear");
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO sessions (
                            session_id,
                            title,
                            workspace_dir,
                            created_at,
                            updated_at,
                            session_json
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .expect("fixture session insert should prepare");
            let sessions = store
                .get("sessions")
                .and_then(serde_json::Value::as_array)
                .expect("fixture session store should contain sessions");
            for session in sessions {
                statement
                    .execute(rusqlite::params![
                        session["session_id"]
                            .as_str()
                            .expect("fixture session id should be a string"),
                        session["title"]
                            .as_str()
                            .expect("fixture session title should be a string"),
                        session["workspace_dir"]
                            .as_str()
                            .expect("fixture workspace dir should be a string"),
                        session["created_at"]
                            .as_str()
                            .expect("fixture created_at should be a string"),
                        session["updated_at"]
                            .as_str()
                            .expect("fixture updated_at should be a string"),
                        serde_json::to_string(session).expect("fixture session should serialize")
                    ])
                    .expect("fixture session should insert");
            }
        }
        transaction
            .commit()
            .expect("fixture session transaction should commit");
    }
}

impl Drop for WorkspaceFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
