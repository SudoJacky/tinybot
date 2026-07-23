use super::support::*;
use crate::agent::bridge::native_agent_turn_record;
use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::config::application::default_tinybot_workspace_root;
use crate::config::application::native_config_snapshot_from_path;
use crate::config::application::resolve_native_backend_workspace_root_from_config_path;
use crate::desktop::files::reveal_workspace_file_path_from_config_path;
use crate::desktop::state::lock_runtime;
use crate::desktop::state::GatewayRuntime;
use crate::desktop_commands::gateway::current_status;
use crate::desktop_commands::gateway::stop_owned_gateway;
use crate::desktop_commands::webui::worker_webui_route_with_options;
use crate::desktop_commands::webui::WorkerWebuiRouteInput;
use crate::protocol::capability::default_desktop_capability_policy;
use crate::protocol::WorkerRequest;
use crate::rpc::native_request_router;
use crate::runtime::mcp::McpRuntime;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

#[test]
fn close_shutdown_cancels_and_drains_owned_agent_task() {
    let services = NativeAgentRuntimeServices::default();
    let task_runtime = services.task_runtime();
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: services,
        ..GatewayRuntime::default()
    }));
    let operation_runtime = task_runtime.clone();
    let handle = task_runtime
        .start_blocking(
            crate::runtime::turn_execution::StartAgentTurn::new(
                "turn-shutdown-owned",
                "session-shutdown-owned",
            ),
            move || {
                while !operation_runtime.is_cancelled("turn-shutdown-owned") {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(serde_json::json!({ "stopReason": "late_completion" }))
            },
        )
        .expect("owned agent task should start");
    assert_eq!(task_runtime.active_count(), 1);

    stop_owned_gateway(&shared, true).expect("owned agent task should drain during shutdown");
    let result = handle
        .wait()
        .expect("owned agent runner should return cancellation");

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(task_runtime.active_count(), 0);
    assert_eq!(task_runtime.draining_count(), 0);
    assert_eq!(
        task_runtime
            .status("turn-shutdown-owned")
            .and_then(|status| status.terminal_outcome),
        Some("cancelled".to_string())
    );
}

#[test]
fn close_shutdown_stops_mcp_stdio_child() {
    let fixture = WorkspaceFixture::new();
    let script = fixture.root.join("mcp-shutdown-server.js");
    let closed_marker = fixture.root.join("mcp-closed.txt");
    std::fs::write(
        &script,
        r#"
const fs = require("fs");
const readline = require("readline");
const closedMarker = process.argv[2];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tinybot-shutdown-mcp", version: "1.0.0" }
    }});
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  }
});
lines.on("close", () => {
  fs.writeFileSync(closedMarker, "closed");
  process.exit(0);
});
"#,
    )
    .expect("MCP shutdown fixture should write");
    let server = serde_json::json!({
        "transport": "stdio",
        "command": "node",
        "args": [script.to_string_lossy(), closed_marker.to_string_lossy()],
        "cwd": fixture.root.to_string_lossy(),
        "timeout_seconds": 5
    });
    let mcp_runtime = McpRuntime::new();
    tauri::async_runtime::block_on(mcp_runtime.list_tools(
        &fixture.root,
        "shutdown",
        &server,
        None,
    ))
    .expect("MCP shutdown fixture should start");
    let mut gateway = GatewayRuntime::default();
    gateway.mcp_runtime = mcp_runtime.clone();
    gateway.native_agent_runtime = gateway
        .native_agent_runtime
        .clone()
        .with_mcp_runtime(mcp_runtime.clone());
    let shared = Arc::new(Mutex::new(gateway));

    stop_owned_gateway(&shared, false).expect("app shutdown should stop MCP runtime");

    assert_eq!(
        tauri::async_runtime::block_on(mcp_runtime.server_status(&fixture.root, "shutdown"))
            ["state"],
        "stopped"
    );
    for _ in 0..20 {
        if closed_marker.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        closed_marker.exists(),
        "MCP child should observe stdin close"
    );
}

#[test]
fn startup_reconciles_orphaned_turn_and_preserves_waiting_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let policy = default_desktop_capability_policy();
    let thread_log = crate::threads::rollout::store::WorkerThreadLogRpc::new(
        fixture.root.clone(),
        policy.clone(),
    );
    let thread = crate::threads::domain::WorkerThreadRpc::new(fixture.root.clone(), policy);
    let created = thread
        .create_thread(crate::threads::domain::CreateThreadRequest {
            thread_id: Some("thread-recovery".to_string()),
            session_key: Some("session-recovery".to_string()),
            ..Default::default()
        })
        .expect("recovery thread should be created");
    thread_log
        .create_from_thread_record(&created)
        .expect("recovery thread Rollout should be created");
    let started = thread
        .start_turn(crate::threads::domain::StartThreadTurnRequest {
            thread_id: "thread-recovery".to_string(),
            turn_id: Some("turn-orphaned".to_string()),
            input: serde_json::json!({ "content": "unfinished" }),
            ..Default::default()
        })
        .expect("orphaned thread turn should start");
    thread_log
        .append_thread_items("thread-recovery", &started.appended_items)
        .expect("orphaned thread turn should persist to Rollout");

    let mut running_record: crate::threads::session::AgentTurnRecord =
        serde_json::from_value(native_agent_turn_record(
            &serde_json::json!({
                "turnId": "turn-orphaned",
                "sessionId": "session-recovery",
                "threadId": "thread-recovery"
            }),
            &serde_json::json!({
                "turnId": "turn-orphaned",
                "sessionId": "session-recovery"
            }),
            &serde_json::json!({}),
            "session-recovery",
            "turn-orphaned",
        ))
        .expect("running recovery record should deserialize");
    running_record.thread_id = Some("thread-recovery".to_string());
    thread_log
        .start_turn(running_record, None, Vec::new())
        .expect("running recovery record should persist");
    let waiting_record: crate::threads::session::AgentTurnRecord =
        serde_json::from_value(native_agent_turn_record(
            &serde_json::json!({
                "turnId": "turn-waiting",
                "sessionId": "session-recovery"
            }),
            &serde_json::json!({
                "turnId": "turn-waiting",
                "sessionId": "session-recovery",
                "stopReason": "awaiting_approval",
                "checkpoint": {
                    "phase": "awaiting_approval",
                    "turnId": "turn-waiting"
                }
            }),
            &serde_json::json!({}),
            "session-recovery",
            "turn-waiting",
        ))
        .expect("waiting recovery record should deserialize");
    let waiting_checkpoint = waiting_record
        .checkpoint
        .clone()
        .expect("waiting recovery record should contain a checkpoint");
    thread_log
        .start_turn(waiting_record, None, Vec::new())
        .expect("waiting recovery record should persist");
    thread_log
        .set_turn_checkpoint("session-recovery", "turn-waiting", waiting_checkpoint)
        .expect("waiting recovery checkpoint should persist");

    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let recovery_metrics_before =
        crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    crate::desktop_commands::gateway::start_gateway_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
    .expect("startup reconciliation should succeed");

    let recovered = thread_log
        .get_turn("session-recovery", "turn-orphaned")
        .expect("orphaned turn should remain queryable")
        .expect("orphaned turn should exist");
    assert_eq!(
        recovered.status,
        crate::threads::session::AgentTurnStatus::Interrupted
    );
    assert_eq!(recovered.phase, "interrupted");
    assert_eq!(recovered.stop_reason.as_deref(), Some("runtime_restarted"));
    assert_eq!(
        recovered
            .error
            .as_ref()
            .and_then(|error| error["code"].as_str()),
        Some("orphaned_turn")
    );
    let waiting = thread_log
        .get_turn("session-recovery", "turn-waiting")
        .expect("waiting turn should remain queryable")
        .expect("waiting turn should exist");
    assert_eq!(
        waiting.status,
        crate::threads::session::AgentTurnStatus::Waiting
    );
    assert!(waiting.checkpoint.is_some());
    let (threads, items) = thread_log
        .thread_projection()
        .expect("reconciled Rollout should project thread state");
    assert!(items.values().flatten().any(|item| {
        item.turn_id == "turn-orphaned"
            && matches!(
                &item.kind,
                crate::threads::domain::ThreadItemKind::TurnCompleted(_)
            )
    }));
    thread
        .replace_projection(threads, items)
        .expect("reconciled thread projection should refresh");
    let thread_status = thread
        .get_thread_status(crate::threads::domain::ThreadIdParams {
            thread_id: "thread-recovery".to_string(),
        })
        .expect("reconciled thread should remain queryable");
    let active_turn = thread_status
        .active_turn
        .expect("waiting recovery turn should remain active");
    assert_eq!(active_turn.turn_id, "turn-waiting");
    assert_eq!(
        active_turn.status,
        crate::threads::domain::ThreadStatus::WaitingForApproval
    );

    let status = current_status(&shared);
    let recovery = status
        .lifecycle
        .last_startup_recovery
        .expect("startup recovery report should be exposed");
    assert!(recovery
        .interrupted_turns
        .iter()
        .any(|turn| turn.turn_id == "turn-orphaned"));
    assert_eq!(
        recovery
            .interrupted_turns
            .iter()
            .filter(|turn| turn.turn_id == "turn-orphaned")
            .count(),
        1
    );
    assert!(recovery
        .resumable_turns
        .iter()
        .any(|turn| turn.turn_id == "turn-waiting"));
    assert!(status.lifecycle.diagnostics.is_empty());
    let recovery_metrics_after =
        crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    assert!(
        recovery_metrics_after["counters"]["recovery.orphaned_turns.interrupted"]
            .as_u64()
            .unwrap_or_default()
            >= recovery_metrics_before["counters"]["recovery.orphaned_turns.interrupted"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
    );
    assert!(
        recovery_metrics_after["durations"]["recovery.orphaned_turns.durationMs"]["count"]
            .as_u64()
            .unwrap_or_default()
            >= recovery_metrics_before["durations"]["recovery.orphaned_turns.durationMs"]["count"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
    );

    let restarted = Arc::new(Mutex::new(GatewayRuntime::default()));
    crate::desktop_commands::gateway::start_gateway_with_workspace_root(
        &restarted,
        fixture.root.clone(),
    )
    .expect("repeated process startup recovery should be idempotent");
    let repeated = current_status(&restarted)
        .lifecycle
        .last_startup_recovery
        .expect("repeated startup should expose its report");
    assert!(repeated.interrupted_turns.is_empty());
    assert!(repeated
        .resumable_turns
        .iter()
        .any(|turn| turn.turn_id == "turn-waiting"));
}

#[test]
fn startup_recovery_failure_pauses_runtime_and_exposes_diagnostic() {
    let fixture = WorkspaceFixture::new();
    let invalid_workspace = fixture.root.join("workspace-is-a-file");
    std::fs::write(&invalid_workspace, "not a directory")
        .expect("invalid workspace fixture should write");
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let error = match crate::desktop_commands::gateway::start_gateway_with_workspace_root(
        &shared,
        invalid_workspace,
    ) {
        Ok(_) => panic!("startup recovery storage failure must fail closed"),
        Err(error) => error,
    };

    assert!(error.contains("startup recovery failed"));
    let status = current_status(&shared);
    assert_eq!(status.state, "failed");
    assert!(!status.agent_tasks.accepting);
    assert!(!status.lifecycle.startup_reconciled);
    assert!(status
        .lifecycle
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.stage == "startup_recovery"));
    assert!(status
        .last_error
        .as_deref()
        .is_some_and(|message| message.contains("startup recovery failed")));
}

#[test]
fn close_shutdown_stops_shell_and_interrupts_subagents_with_report() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let (shell_runtime, subagents) = {
        let runtime = lock_runtime(&shared);
        (
            runtime.native_agent_runtime.shell_runtime(),
            runtime.subagent_manager.clone(),
        )
    };
    let shell = crate::tools::shell::WorkerShellRpc::with_runtime(
        fixture.root.clone(),
        crate::protocol::capability::CapabilityPolicy::new([
            crate::protocol::capability::WorkerCapability::ShellExecute,
        ]),
        shell_runtime.clone(),
    );
    let process = shell
        .start(crate::tools::shell::ShellStartParams {
            command: lifecycle_blocking_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            owner_id: Some("turn-shell-shutdown".to_string()),
            tool_call_id: Some("tool-shell-shutdown".to_string()),
            cancellation: None,
        })
        .expect("shutdown shell fixture should start");
    let spawned = subagents.spawn(crate::collaboration::subagents::SubagentSpawnParams {
        session_key: "session-shutdown".to_string(),
        parent_turn_id: Some("turn-parent".to_string()),
        parent_subagent_id: None,
        delegation_depth: None,
        history_mode: None,
        subagent_id: Some("delegate-shutdown".to_string()),
        child_turn_id: Some("turn-child".to_string()),
        trace_ref: None,
        name: Some("shutdown-child".to_string()),
        task: Some("wait for shutdown".to_string()),
        status: None,
        created_at: None,
        metadata: serde_json::json!({}),
    });
    assert!(spawned.accepted);

    stop_owned_gateway(&shared, true).expect("unified shutdown should complete");

    assert_eq!(shell_runtime.active_process_count(), 0);
    assert_eq!(
        subagents.list("session-shutdown").subagents[0].status,
        crate::collaboration::subagents::SubagentThreadStatus::Interrupted
    );
    let report = current_status(&shared)
        .lifecycle
        .last_shutdown
        .expect("shutdown report should be exposed");
    let stopped_status = current_status(&shared);
    assert_eq!(stopped_status.state, "offline");
    assert_eq!(
        stopped_status.worker_runtime.state,
        crate::transport::stdio_worker::status::WorkerRuntimeState::Stopped
    );
    assert!(report.completed);
    assert!(report
        .shell
        .terminated_process_ids
        .contains(&process.process_id));
    assert!(report
        .subagents
        .interrupted
        .iter()
        .any(|subagent| subagent.subagent_id == "delegate-shutdown"));
    assert!(report.failures.is_empty());

    crate::desktop_commands::gateway::start_gateway_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
    .expect("same-process runtime restart should resume shell starts");
    let resumed = shell
        .start(crate::tools::shell::ShellStartParams {
            command: lifecycle_echo_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(1_000),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            owner_id: Some("turn-shell-resumed".to_string()),
            tool_call_id: Some("tool-shell-resumed".to_string()),
            cancellation: None,
        })
        .expect("shell manager should accept starts after gateway restart");
    assert_eq!(resumed.exit_code, Some(0));
}

#[test]
fn close_shutdown_exposes_cleanup_timeout_diagnostics() {
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let task_runtime = lock_runtime(&shared).native_agent_runtime.task_runtime();
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    let handle = task_runtime
        .start_blocking(
            crate::runtime::turn_execution::StartAgentTurn::new(
                "turn-cleanup-timeout",
                "session-cleanup-timeout",
            ),
            move || {
                release_receiver
                    .recv()
                    .expect("cleanup timeout fixture should release");
                Ok(serde_json::json!({ "stopReason": "final_response" }))
            },
        )
        .expect("cleanup timeout fixture should start");

    let error = crate::desktop_commands::gateway::stop_owned_gateway_with_timeout(
        &shared,
        true,
        Duration::from_millis(20),
    )
    .expect_err("cleanup timeout must fail explicitly");
    assert!(error.contains("agent task cleanup timed out"));
    let status = current_status(&shared);
    let report = status
        .lifecycle
        .last_shutdown
        .expect("failed shutdown should still expose its report");
    assert!(!report.completed);
    assert!(report
        .failures
        .iter()
        .any(|failure| failure.stage == "agent_tasks"));
    assert!(status
        .lifecycle
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.stage == "agent_tasks"));
    assert!(status
        .last_error
        .as_deref()
        .is_some_and(|message| message.contains("agent task cleanup timed out")));

    release_sender
        .send(())
        .expect("cleanup timeout fixture should release");
    let _ = handle.wait();
}

#[test]
fn start_gateway_defaults_to_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let status = crate::desktop_commands::gateway::start_gateway_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
    .expect("Rust backend startup should not require TS worker");

    assert_eq!(status.owner, "shell");
    assert_eq!(status.state, "running");
    assert_eq!(status.command, "Tauri Rust backend");
    assert_eq!(
        status.worker_runtime.state,
        crate::transport::stdio_worker::status::WorkerRuntimeState::Running
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
    let status = crate::desktop_commands::gateway::start_gateway_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
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
fn native_request_router_keeps_builtin_skills_root_separate_from_workspace_root() {
    let fixture = WorkspaceFixture::new();
    let workspace_root = fixture.root.join("workspace");
    let builtin_root = fixture.root.join("repo");
    std::fs::create_dir_all(&workspace_root).expect("workspace root should create");
    fixture.write(
        "repo/builtin-skills/builtin-fixture/SKILL.md",
        "---\nname: builtin-fixture\ndescription: Builtin fixture\n---\n",
    );
    let mut router = native_request_router(workspace_root, serde_json::json!({}))
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
fn native_request_router_ignores_corrupt_session_store() {
    let fixture = WorkspaceFixture::new();
    fixture.write("sessions/store.json", "{not valid json");
    let mut router = native_request_router(fixture.root.clone(), serde_json::json!({}));

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
fn native_config_snapshot_loads_real_tinybot_config() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
        "config.json",
        r#"{
          "agents": {
            "defaults": {
              "provider": "deepseek",
              "model": "deepseek-v4-flash"
            }
          }
        }"#,
    );
    let config_path = fixture.root.join("config.json");

    let snapshot = native_config_snapshot_from_path(&config_path);

    assert_eq!(snapshot["agents"]["defaults"]["provider"], "deepseek");
    assert_eq!(snapshot["agents"]["defaults"]["model"], "deepseek-v4-flash");
}

#[test]
fn native_config_defaults_to_schema_v1_deepseek_profile_without_config_file() {
    let fixture = WorkspaceFixture::new();
    assert_eq!(
        native_config_snapshot_from_path(&fixture.root.join("missing-config.json")),
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
                        "supportsModelDiscovery": true,
                        "capabilities": ["reasoning"]
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
fn native_request_router_allows_registered_native_agent_tools() {
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
    fixture.write(
        "mcp-server.js",
        r#"
const readline = require("readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tinybot-router-test", version: "1.0.0" }
    }});
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "search", description: "Search docs.", inputSchema: { type: "object" }
    }] }});
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: "docs result" }], isError: false
    }});
  }
});
"#,
    );
    let mut router = native_request_router(
        fixture.root.clone(),
        serde_json::json!({
            "tools": {
                "mcp_servers": {
                    "docs": {
                        "transport": "stdio",
                        "command": "node",
                        "args": [fixture.root.join("mcp-server.js").to_string_lossy()],
                        "cwd": fixture.root.to_string_lossy(),
                        "enabled_tools": ["search"],
                        "timeout_seconds": 5
                    }
                }
            }
        }),
    );

    let memory_response = router.dispatch(&crate::protocol::WorkerRequest::new(
        "memory-search-1",
        "trace-memory-search",
        "memory.search",
        serde_json::json!({ "query": "uv", "limit": 3 }),
    ));
    let mcp_response = router.dispatch(
        &crate::protocol::WorkerRequest::new(
            "mcp-call-1",
            "trace-mcp-call",
            "mcp.call_tool",
            serde_json::json!({
                "server": "docs",
                "tool": "search",
                "arguments": { "query": "agent loop" }
            }),
        )
        .with_trusted_internal(),
    );

    assert!(
        memory_response.error.is_none(),
        "{:?}",
        memory_response.error
    );
    assert!(mcp_response.error.is_none(), "{:?}", mcp_response.error);
    assert_eq!(
        mcp_response.result.as_ref().unwrap()["content"][0]["text"],
        "docs result"
    );
    let shutdown = router.dispatch(&crate::protocol::WorkerRequest::new(
        "mcp-shutdown-1",
        "trace-mcp-shutdown",
        "mcp.shutdown",
        serde_json::json!({}),
    ));
    assert!(shutdown.error.is_none(), "{:?}", shutdown.error);
}
