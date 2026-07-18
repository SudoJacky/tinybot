use super::*;
use crate::desktop_commands::gateway::{
    current_status, persist_gateway_exit_policy, GatewayRuntimeStatus,
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

fn compatibility_thread_log_paths(workspace_root: &std::path::Path) -> Vec<std::path::PathBuf> {
    fn collect(directory: &std::path::Path, paths: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, paths);
            } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
                paths.push(path);
            }
        }
    }

    let mut paths = Vec::new();
    collect(&workspace_root.join(".tinybot").join("threads"), &mut paths);
    paths.sort();
    paths
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
fn close_shutdown_cancels_and_drains_owned_agent_task() {
    struct ShutdownAwareProvider {
        started: std::sync::mpsc::Sender<()>,
    }

    impl crate::worker_agent_runtime::NativeAgentProvider for ShutdownAwareProvider {
        fn complete(
            &self,
            context: &crate::worker_agent_runtime::NativeAgentRunContext,
        ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
            self.started.send(()).expect("provider start should send");
            while !context
                .cancellation
                .as_ref()
                .is_some_and(|cancellation| cancellation.is_cancelled())
            {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
                final_content: "late shutdown response".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let fixture = WorkspaceFixture::new();
    let (started_sender, started_receiver) = std::sync::mpsc::channel();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ShutdownAwareProvider {
            started: started_sender,
        }),
        Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
        Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
    );
    let task_runtime = services.task_runtime();
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: services,
        ..GatewayRuntime::default()
    }));
    let runner_shared = shared.clone();
    let runner_root = fixture.root.clone();
    let runner = std::thread::spawn(move || {
        worker_run_agent_with_options(
            &runner_shared,
            serde_json::json!({
                "runtime": "rust",
                "runId": "run-shutdown-owned",
                "sessionId": "session-shutdown-owned",
                "messages": [{ "role": "user", "content": "wait for shutdown" }]
            }),
            runner_root,
            serde_json::json!({}),
            Duration::from_secs(10),
        )
    });
    started_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("owned provider should start");

    stop_owned_gateway(&shared, true).expect("owned agent task should drain during shutdown");
    let result = runner
        .join()
        .expect("owned agent runner should not panic")
        .expect("owned agent runner should return cancellation");

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(task_runtime.active_count(), 0);
    assert_eq!(task_runtime.draining_count(), 0);
    assert_eq!(
        task_runtime
            .status("run-shutdown-owned")
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
fn startup_reconciles_orphaned_run_and_preserves_waiting_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let policy = default_desktop_capability_policy();
    let thread_log =
        crate::worker_thread_log::WorkerThreadLogRpc::new(fixture.root.clone(), policy.clone());
    let thread = crate::worker_thread::WorkerThreadRpc::new(fixture.root.clone(), policy);
    let created = thread
        .create_thread(crate::worker_thread::CreateThreadRequest {
            thread_id: Some("thread-recovery".to_string()),
            session_key: Some("session-recovery".to_string()),
            ..Default::default()
        })
        .expect("recovery thread should be created");
    thread_log
        .create_from_thread_record(&created)
        .expect("recovery thread Rollout should be created");
    let started = thread
        .start_turn(crate::worker_thread::StartThreadTurnRequest {
            thread_id: "thread-recovery".to_string(),
            run_id: Some("run-orphaned".to_string()),
            input: serde_json::json!({ "content": "unfinished" }),
            ..Default::default()
        })
        .expect("orphaned thread run should start");
    thread_log
        .append_thread_items("thread-recovery", &started.appended_items)
        .expect("orphaned thread run should persist to Rollout");

    let mut running_record: crate::worker_session::AgentRunRecord =
        serde_json::from_value(native_agent_run_record(
            &serde_json::json!({
                "runId": "run-orphaned",
                "sessionId": "session-recovery",
                "threadId": "thread-recovery"
            }),
            &serde_json::json!({
                "runId": "run-orphaned",
                "sessionId": "session-recovery"
            }),
            &serde_json::json!({}),
            "session-recovery",
            "run-orphaned",
        ))
        .expect("running recovery record should deserialize");
    running_record.thread_id = Some("thread-recovery".to_string());
    thread_log
        .upsert_agent_run(running_record)
        .expect("running recovery record should persist");
    let waiting_record: crate::worker_session::AgentRunRecord =
        serde_json::from_value(native_agent_run_record(
            &serde_json::json!({
                "runId": "run-waiting",
                "sessionId": "session-recovery"
            }),
            &serde_json::json!({
                "runId": "run-waiting",
                "sessionId": "session-recovery",
                "stopReason": "awaiting_approval",
                "checkpoint": {
                    "phase": "awaiting_approval",
                    "runId": "run-waiting"
                }
            }),
            &serde_json::json!({}),
            "session-recovery",
            "run-waiting",
        ))
        .expect("waiting recovery record should deserialize");
    thread_log
        .upsert_agent_run(waiting_record)
        .expect("waiting recovery record should persist");

    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let recovery_metrics_before =
        crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    crate::desktop_commands::gateway::start_gateway_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
    .expect("startup reconciliation should succeed");

    let recovered = thread_log
        .get_agent_run("session-recovery", "run-orphaned")
        .expect("orphaned run should remain queryable")
        .expect("orphaned run should exist");
    assert_eq!(
        recovered.status,
        crate::worker_session::AgentRunStatus::Interrupted
    );
    assert_eq!(recovered.phase, "interrupted");
    assert_eq!(recovered.stop_reason.as_deref(), Some("runtime_restarted"));
    assert_eq!(
        recovered
            .error
            .as_ref()
            .and_then(|error| error["code"].as_str()),
        Some("orphaned_run")
    );
    let waiting = thread_log
        .get_agent_run("session-recovery", "run-waiting")
        .expect("waiting run should remain queryable")
        .expect("waiting run should exist");
    assert_eq!(
        waiting.status,
        crate::worker_session::AgentRunStatus::Waiting
    );
    assert!(waiting.checkpoint.is_some());
    let (threads, items) = thread_log
        .thread_projection()
        .expect("reconciled Rollout should project thread state");
    thread
        .replace_projection(threads, items)
        .expect("reconciled thread projection should refresh");
    let thread_status = thread
        .get_thread_status(crate::worker_thread::ThreadIdParams {
            thread_id: "thread-recovery".to_string(),
        })
        .expect("reconciled thread should remain queryable");
    assert!(thread_status.active_run.is_none());

    let status = current_status(&shared);
    let recovery = status
        .lifecycle
        .last_startup_recovery
        .expect("startup recovery report should be exposed");
    assert!(recovery
        .interrupted_runs
        .iter()
        .any(|run| run.run_id == "run-orphaned"));
    assert_eq!(
        recovery
            .interrupted_runs
            .iter()
            .filter(|run| run.run_id == "run-orphaned")
            .count(),
        1
    );
    assert!(recovery
        .resumable_runs
        .iter()
        .any(|run| run.run_id == "run-waiting"));
    assert!(status.lifecycle.diagnostics.is_empty());
    let recovery_metrics_after =
        crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    assert!(
        recovery_metrics_after["counters"]["recovery.orphaned_runs.interrupted"]
            .as_u64()
            .unwrap_or_default()
            >= recovery_metrics_before["counters"]["recovery.orphaned_runs.interrupted"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
    );
    assert!(
        recovery_metrics_after["durations"]["recovery.orphaned_runs.durationMs"]["count"]
            .as_u64()
            .unwrap_or_default()
            >= recovery_metrics_before["durations"]["recovery.orphaned_runs.durationMs"]["count"]
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
    assert!(repeated.interrupted_runs.is_empty());
    assert!(repeated
        .resumable_runs
        .iter()
        .any(|run| run.run_id == "run-waiting"));
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
    let shell = crate::worker_shell::WorkerShellRpc::with_runtime(
        fixture.root.clone(),
        crate::worker_capability::CapabilityPolicy::new([
            crate::worker_capability::WorkerCapability::ShellExecute,
        ]),
        shell_runtime.clone(),
    );
    let process = shell
        .start(crate::worker_shell::ShellStartParams {
            command: lifecycle_blocking_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-shell-shutdown".to_string()),
            tool_call_id: Some("tool-shell-shutdown".to_string()),
            cancellation: None,
        })
        .expect("shutdown shell fixture should start");
    let spawned = subagents.spawn(crate::worker_subagent_manager::SubagentSpawnParams {
        session_key: "session-shutdown".to_string(),
        parent_run_id: Some("run-parent".to_string()),
        parent_subagent_id: None,
        delegation_depth: None,
        history_mode: None,
        subagent_id: Some("delegate-shutdown".to_string()),
        child_run_id: Some("run-child".to_string()),
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
        crate::worker_subagent_manager::SubagentThreadStatus::Interrupted
    );
    let report = current_status(&shared)
        .lifecycle
        .last_shutdown
        .expect("shutdown report should be exposed");
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
        .start(crate::worker_shell::ShellStartParams {
            command: lifecycle_echo_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(1_000),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-shell-resumed".to_string()),
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
            crate::runtime::agent_task::StartAgentRun::new(
                "run-cleanup-timeout",
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

#[cfg(target_os = "windows")]
fn lifecycle_blocking_command() -> String {
    "for /L %i in (0,0,1) do @rem".to_string()
}

#[cfg(not(target_os = "windows"))]
fn lifecycle_blocking_command() -> String {
    "while true; do :; done".to_string()
}

#[cfg(target_os = "windows")]
fn lifecycle_echo_command() -> String {
    "echo resumed".to_string()
}

#[cfg(not(target_os = "windows"))]
fn lifecycle_echo_command() -> String {
    "printf 'resumed\\n'".to_string()
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
          }
        }"#,
    );
    let config_path = fixture.root.join("config.json");

    let snapshot = experimental_worker_config_snapshot_from_path(&config_path);

    assert_eq!(snapshot["agents"]["defaults"]["provider"], "deepseek");
    assert_eq!(snapshot["agents"]["defaults"]["model"], "deepseek-v4-flash");
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
    let mut router = experimental_worker_router(
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

    let memory_response = router.dispatch(&crate::worker_protocol::WorkerRequest::new(
        "memory-search-1",
        "trace-memory-search",
        "memory.search",
        serde_json::json!({ "query": "uv", "limit": 3 }),
    ));
    let mcp_response = router.dispatch(
        &crate::worker_protocol::WorkerRequest::new(
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
    let shutdown = router.dispatch(&crate::worker_protocol::WorkerRequest::new(
        "mcp-shutdown-1",
        "trace-mcp-shutdown",
        "mcp.shutdown",
        serde_json::json!({}),
    ));
    assert!(shutdown.error.is_none(), "{:?}", shutdown.error);
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
fn worker_run_agent_preserves_trace_from_ingress_through_persistence() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
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
            "runId": "run-ingress-persistence",
            "turnId": "turn-ingress-persistence",
            "sessionId": "session-ingress-persistence",
            "messages": [{ "role": "user", "content": "trace this turn" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("traced Rust runtime should complete");
    let run = read_agent_run_record(
        fixture.root.clone(),
        config.clone(),
        "session-ingress-persistence",
        "run-ingress-persistence",
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
        run["traceContext"]["requestId"],
        "request-ingress-persistence"
    );
    assert_eq!(run["traceContext"]["traceId"], "trace-ingress-persistence");
    let trace_events = run["traceEvents"]
        .as_array()
        .expect("persisted trace events should be an array");
    assert!(trace_events
        .iter()
        .any(|event| event["eventName"] == "agent.provider.completed"));
    for event_name in ["agent.provider.completed"] {
        let event = trace_events
            .iter()
            .find(|event| event["eventName"] == event_name)
            .expect("provider boundary event should be persisted");
        assert_eq!(
            event["traceContext"]["requestId"],
            "request-ingress-persistence"
        );
        assert_eq!(
            event["traceContext"]["traceId"],
            "trace-ingress-persistence"
        );
    }
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
fn worker_run_agent_persists_rust_turn_messages_in_canonical_rollout() {
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
    assert_eq!(history["messages"][1]["usage"]["promptTokens"], 10);
    assert_eq!(history["messages"][1]["usage"]["completionTokens"], 97);
    assert_eq!(history["messages"][1]["usage"]["totalTokens"], 107);
}

#[test]
fn worker_run_agent_stops_before_provider_when_run_start_persistence_fails() {
    #[derive(Clone)]
    struct CountingProvider {
        calls: Arc<Mutex<usize>>,
    }

    impl crate::worker_agent_runtime::NativeAgentProvider for CountingProvider {
        fn complete(
            &self,
            _context: &crate::worker_agent_runtime::NativeAgentRunContext,
        ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
            *self
                .calls
                .lock()
                .expect("counting provider lock should not be poisoned") += 1;
            Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
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
            Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::default()
    }));

    let error = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-persistence-failure",
            "messages": [{ "role": "user", "content": "do not call provider" }]
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect_err("run-start persistence failure should fail the command");

    assert!(error.contains("run start persistence failed"), "{error}");
    assert_eq!(
        *calls
            .lock()
            .expect("counting provider lock should not be poisoned"),
        0,
        "provider must not run after run-start persistence fails"
    );
}

#[test]
fn worker_run_agent_fails_when_trace_persistence_breaks_after_provider_response() {
    #[derive(Clone)]
    struct PersistenceBreakingProvider {
        workspace_root: PathBuf,
        calls: Arc<Mutex<usize>>,
    }

    impl crate::worker_agent_runtime::NativeAgentProvider for PersistenceBreakingProvider {
        fn complete(
            &self,
            _context: &crate::worker_agent_runtime::NativeAgentRunContext,
        ) -> Result<crate::worker_agent_runtime::NativeAgentProviderResponse, String> {
            *self
                .calls
                .lock()
                .expect("persistence-breaking provider lock should not be poisoned") += 1;
            let thread_root = self.workspace_root.join(".tinybot").join("threads");
            std::fs::remove_dir_all(&thread_root)
                .expect("provider fixture should remove the initialized thread log");
            std::fs::write(&thread_root, "blocks later thread-log writes")
                .expect("provider fixture should replace thread log directory");
            Ok(crate::worker_agent_runtime::NativeAgentProviderResponse {
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
            Arc::new(crate::worker_agent_runtime::FakeNativeAgentToolDispatcher),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(crate::worker_agent_runtime::InMemoryNativeAgentCancellation::default()),
        ),
        ..GatewayRuntime::default()
    }));

    let error = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-record-persistence-failure",
            "sessionId": "session-record-persistence-failure",
            "messages": [{ "role": "user", "content": "break persistence after start" }]
        }),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect_err("trace persistence failure should fail the command");

    assert!(
        error.contains("native agent run trace batch append failed"),
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
    let durable_runtime_events = result_runtime_events
        .iter()
        .filter(|event| event["eventName"] != "agent.provider.requested")
        .collect::<Vec<_>>();
    assert!(result_runtime_events
        .iter()
        .any(|event| event["eventName"] == "agent.provider.requested"));
    assert_eq!(trace_events.len(), durable_runtime_events.len());
    for (persisted, emitted) in trace_events.iter().zip(durable_runtime_events) {
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
fn session_owned_compaction_commits_installed_checkpoint_before_final_turn_persistence() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
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
            "runId": "run-session-context-commit",
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
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "req-session-context-after-commit",
            "trace-session-context-after-commit",
            "session.get_agent_context",
            serde_json::json!({ "session_id": session_id, "limit": 50 }),
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
    let hydrated = crate::native_agent_bridge::hydrate_native_agent_history_for_runtime(
        serde_json::json!({
            "runtime": "rust",
            "runId": "run-session-context-commit-next",
            "sessionId": session_id,
            "messages": [{ "role": "user", "content": "next current question" }]
        }),
        fixture.root.clone(),
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
    let lines = crate::worker_thread_log::read_thread_lines(&thread_logs[0])
        .expect("session thread log should be readable");
    let stages = lines
        .iter()
        .filter_map(|line| match &line.item {
            crate::worker_thread_log::ThreadLogItem::Compacted(checkpoint) => checkpoint
                .get("checkpointStage")
                .and_then(serde_json::Value::as_str),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(stages, vec!["installed", "finalized"]);
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
        config.clone(),
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
    let trace_id = result["agentResult"]["traceContext"]["traceId"]
        .as_str()
        .expect("thread agent result should expose traceId");
    assert!(result["agentResult"]["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present")
        .iter()
        .all(|event| event["traceContext"]["traceId"] == trace_id));
    assert!(result["snapshot"]["thread"]["sessionKey"].is_null());
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["kind"]["type"] == "assistant_message_completed"));
    let started = result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .find(|item| item["kind"]["type"] == "agent_run_started")
        .expect("thread run start item should be present");
    assert_eq!(
        started["kind"]["payload"]["traceContext"]["traceId"],
        trace_id
    );
    let metadata = call_rust_state_service(
        fixture.root.clone(),
        config,
        WorkerRequest::new(
            "req-thread-submit-session-metadata",
            "trace-thread-submit-session-metadata",
            "session.get_metadata",
            serde_json::json!({ "session_id": thread_id }),
        ),
        "thread submit session metadata",
    )
    .expect("agent run session metadata should be readable");
    assert_eq!(metadata["session_id"], thread_id);
    let rollout_path = metadata["extra"]["threadPath"]
        .as_str()
        .expect("Rollout metadata should expose its journal path");
    assert!(std::path::Path::new(rollout_path).exists());
    assert_eq!(metadata["extra"]["threadSource"], "thread_log");
    let rollout =
        std::fs::read_to_string(rollout_path).expect("Rollout journal should be readable");
    let rollout_items = rollout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(rollout_items.iter().any(|line| {
        line["type"] == "turn_context"
            && line["payload"]["turnId"] == "run-thread-submit-new"
            && line["payload"]["model"] == "fixture-model"
    }));
    let turn_started = rollout_items
        .iter()
        .position(|line| line["type"] == "event_msg" && line["payload"]["type"] == "turn_started")
        .unwrap();
    let turn_context = rollout_items
        .iter()
        .position(|line| line["type"] == "turn_context")
        .unwrap();
    let user_item = rollout_items
        .iter()
        .position(|line| line["type"] == "response_item" && line["payload"]["role"] == "user")
        .unwrap();
    let turn_complete = rollout_items
        .iter()
        .position(|line| line["type"] == "event_msg" && line["payload"]["type"] == "turn_complete")
        .unwrap();
    assert!(turn_started < turn_context);
    assert!(turn_context < user_item);
    assert!(user_item < turn_complete);
    let history = call_rust_state_service(
        fixture.root.clone(),
        serde_json::json!({}),
        WorkerRequest::new(
            "req-thread-submit-rollout-history",
            "trace-thread-submit-rollout-history",
            "session.get_history",
            serde_json::json!({ "session_id": thread_id }),
        ),
        "thread submit Rollout history",
    )
    .expect("thread submit Rollout history should be readable");
    let messages = history["messages"]
        .as_array()
        .expect("Rollout history should contain messages");
    assert!(messages.iter().any(|message| {
        message["role"] == "user" && message["content"] == "answer from a new thread"
    }));
    let assistant = messages
        .iter()
        .find(|message| message["role"] == "assistant")
        .expect("Rollout history should contain the assistant response");
    assert_eq!(assistant["content"], "thread-first answer");
    assert!(assistant["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"]
        .as_i64()
        .is_some());
    assert_eq!(assistant["tokenUsageInfo"]["modelContextWindow"], 128_000);
}

#[test]
fn thread_owned_compaction_commits_installed_checkpoint_before_finalization() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
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
            { "content": "thread compact summary" },
            { "content": "thread compact answer" }
        ] } }
    });

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "current question" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": "run-thread-context-commit",
                "messages": [
                    { "role": "user", "content": "old context ".repeat(200) },
                    { "role": "assistant", "content": "old answer ".repeat(200) },
                    { "role": "user", "content": "current question" }
                ]
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread compaction should commit through thread authority");

    let compactions = result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .filter(|item| item["kind"]["type"] == "context_compaction")
        .collect::<Vec<_>>();
    assert_eq!(compactions.len(), 1);
    assert!(compactions.iter().all(|item| {
        item["kind"]["payload"]["payload"]["contextCheckpoint"]["checkpointStage"] == "finalized"
    }));
    assert!(compactions.iter().all(|item| {
        let checkpoint = &item["kind"]["payload"]["payload"]["contextCheckpoint"];
        checkpoint["windowNumber"] == 1 && checkpoint["windowId"] == checkpoint["contextId"]
    }));
    let thread_id = result["threadId"].as_str().unwrap();
    let metadata = call_rust_state_service(
        fixture.root.clone(),
        config,
        WorkerRequest::new(
            "req-thread-compact-rollout-metadata",
            "trace-thread-compact-rollout-metadata",
            "session.get_metadata",
            serde_json::json!({ "session_id": thread_id }),
        ),
        "thread compact Rollout metadata",
    )
    .expect("thread compact Rollout metadata should be readable");
    let rollout_path = metadata["extra"]["threadPath"].as_str().unwrap();
    let rollout = std::fs::read_to_string(rollout_path).unwrap();
    let compacted = rollout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|line| line["type"] == "compacted")
        .collect::<Vec<_>>();
    assert_eq!(compacted.len(), 2);
    assert!(compacted
        .iter()
        .any(|line| line["payload"]["checkpointStage"] == "installed"));
    assert!(compacted
        .iter()
        .any(|line| line["payload"]["checkpointStage"] == "finalized"));
}

#[test]
fn thread_owned_terminal_reentry_uses_rollout_authority_after_restart() {
    let fixture = WorkspaceFixture::new();
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "terminal answer" }] } }
    });
    let first_shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let first = worker_submit_thread_turn_with_options(
        &first_shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "complete once" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": "run-thread-terminal-reentry"
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("initial thread turn should complete");
    let thread_id = first["threadId"].as_str().unwrap().to_string();

    let restarted_shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let retry = worker_submit_thread_turn_with_options(
        &restarted_shared,
        WorkerSubmitThreadTurnInput {
            thread_id: Some(thread_id.clone()),
            input: serde_json::json!({ "content": "complete once" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "runId": "run-thread-terminal-reentry"
            }),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("terminal retry should return a stable rejection");

    assert_eq!(retry["threadId"], thread_id);
    assert_eq!(retry["agentResult"]["stopReason"], "terminal_turn");
    assert_eq!(retry["snapshot"]["thread"]["status"], "idle");
    let rollout_paths = compatibility_thread_log_paths(&fixture.root);
    assert_eq!(rollout_paths.len(), 1, "{rollout_paths:?}");
}

#[test]
fn canonical_thread_reads_supersede_stale_session_and_share_rollout_writes() {
    let fixture = WorkspaceFixture::new();
    let config = serde_json::json!({});
    let session_id = "canonical-thread-session";
    let stale_record = native_agent_run_record(
        &serde_json::json!({
            "runtime": "rust",
            "runId": "stale-session-run",
            "sessionId": session_id,
        }),
        &serde_json::json!({
            "runId": "stale-session-run",
            "sessionId": session_id,
            "stopReason": "awaiting_form",
        }),
        &config,
        session_id,
        "stale-session-run",
    );
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "seed-stale-session-run",
            "trace-stale-session-run",
            "agent_run.upsert",
            serde_json::json!({ "record": stale_record }),
        ),
        "seed stale session run",
    )
    .expect("stale compatibility run should seed before thread ownership exists");
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "seed-stale-session-checkpoint",
            "trace-stale-session-checkpoint",
            "session.set_checkpoint",
            serde_json::json!({
                "session_id": session_id,
                "checkpoint": {
                    "schemaVersion": 1,
                    "runId": "stale-session-run",
                    "sessionId": session_id,
                    "phase": "awaiting_form"
                }
            }),
        ),
        "seed stale session checkpoint",
    )
    .expect("stale compatibility checkpoint should seed before thread ownership exists");

    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "create-canonical-thread",
            "trace-canonical-thread",
            "thread.create",
            serde_json::json!({
                "threadId": "canonical-thread",
                "sessionKey": session_id,
            }),
        ),
        "create canonical thread",
    )
    .expect("canonical thread should create");
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "start-canonical-thread-run",
            "trace-canonical-thread",
            "thread.start_turn",
            serde_json::json!({
                "threadId": "canonical-thread",
                "runId": "canonical-thread-run",
                "turnId": "canonical-thread-run",
                "input": { "role": "user", "content": "canonical input" },
            }),
        ),
        "start canonical thread run",
    )
    .expect("canonical thread run should start");
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "complete-canonical-thread-run",
            "trace-canonical-thread",
            "thread.apply_op",
            serde_json::json!({
                "threadId": "canonical-thread",
                "op": {
                    "type": "assistant_response",
                    "runId": "canonical-thread-run",
                    "turnId": "canonical-thread-run",
                    "content": "canonical answer",
                    "stopReason": "final_response"
                }
            }),
        ),
        "complete canonical thread run",
    )
    .expect("canonical thread run should complete");

    let runs = call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "list-canonical-thread-runs",
            "trace-canonical-thread",
            "agent_run.list",
            serde_json::json!({ "session_id": session_id }),
        ),
        "list canonical thread runs",
    )
    .expect("compatibility run list should project canonical thread");
    assert_eq!(runs["runs"].as_array().map(Vec::len), Some(1));
    assert_eq!(runs["runs"][0]["runId"], "canonical-thread-run");
    let checkpoint = call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "get-canonical-thread-checkpoint",
            "trace-canonical-thread",
            "session.get_checkpoint",
            serde_json::json!({ "session_id": session_id }),
        ),
        "get canonical thread checkpoint",
    )
    .expect("compatibility checkpoint read should use canonical thread");
    assert!(checkpoint.is_null());

    let compatibility_turn = call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            "reject-duplicate-session-turn",
            "trace-canonical-thread",
            "session.persist_turn",
            serde_json::json!({
                "session_id": session_id,
                "run_id": "duplicate-run",
                "messages": [{ "role": "assistant", "content": "duplicate" }]
            }),
        ),
        "persist compatibility session turn",
    )
    .expect("thread-owned session.persist_turn should append to canonical Rollout");
    assert_eq!(compatibility_turn["saved_message_count"], 1);

    let duplicate_record = native_agent_run_record(
        &serde_json::json!({
            "runtime": "rust",
            "sessionId": session_id,
            "runId": "duplicate-run",
        }),
        &serde_json::json!({
            "sessionId": session_id,
            "runId": "duplicate-run",
        }),
        &config,
        session_id,
        "duplicate-run",
    );
    let compatibility_run = call_rust_state_service(
        fixture.root.clone(),
        config,
        WorkerRequest::new(
            "reject-duplicate-agent-run",
            "trace-canonical-thread",
            "agent_run.upsert",
            serde_json::json!({ "record": duplicate_record }),
        ),
        "persist compatibility agent run",
    )
    .expect("thread-owned agent_run.upsert should append to canonical Rollout");
    assert_eq!(compatibility_run["runId"], "duplicate-run");
}

#[test]
fn worker_submit_thread_turn_uses_thread_id_as_rollout_id() {
    let fixture = WorkspaceFixture::new();
    let working_directory = fixture.root.join("existing-thread-project");
    std::fs::create_dir_all(working_directory.join(".git"))
        .expect("existing thread project marker should create");
    std::fs::write(
        working_directory.join("AGENTS.md"),
        "existing thread project instructions",
    )
    .expect("existing thread project instructions should write");
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
                "title": "Existing thread",
                "metadata": {
                    "workingDirectory": working_directory
                }
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
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("existing thread submit should run native agent");

    assert_eq!(result["threadId"], "thread-existing-submit");
    assert_eq!(result["sessionId"], "thread-existing-submit");
    assert_eq!(result["agentResult"]["sessionId"], "thread-existing-submit");
    assert_eq!(
        result["snapshot"]["thread"]["threadId"],
        "thread-existing-submit"
    );
    assert_eq!(
        result["agentResult"]["instructionProvenance"]["workingDirectory"],
        working_directory.display().to_string()
    );
    assert!(result["agentResult"]["instructionProvenance"]["sources"]
        .as_array()
        .expect("thread instruction provenance should list sources")
        .iter()
        .any(|source| source["kind"] == "project_agents"));
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["runId"] == "run-thread-submit-existing"));
    let run_request = next_worker_request_correlation();
    let persisted_run = call_rust_state_service(
        fixture.root.clone(),
        config,
        WorkerRequest::new(
            run_request.id("existing-thread-agent-run-read"),
            run_request.trace_id("existing-thread-agent-run-read"),
            "agent_run.get",
            serde_json::json!({
                "session_id": "thread-existing-submit",
                "run_id": "run-thread-submit-existing"
            }),
        ),
        "existing thread agent run read",
    )
    .expect("existing thread agent run should persist");
    assert_eq!(
        persisted_run["instructionProvenance"]["workingDirectory"],
        working_directory.display().to_string()
    );
}

#[test]
fn worker_submit_thread_turn_does_not_require_a_session_key() {
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
    .expect("thread submit should use the thread id as the Rollout id");

    assert_eq!(result["threadId"], "thread-submit-backfill");
    assert_eq!(result["sessionId"], "thread-submit-backfill");
    assert!(result["snapshot"]["thread"]["sessionKey"].is_null());
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

    let task_runtime = {
        let runtime = lock_runtime(&shared);
        runtime.native_agent_runtime.task_runtime()
    };
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    let owned_handle = task_runtime
        .start_blocking(
            crate::runtime::agent_task::StartAgentRun::new(
                "run-command-surface",
                "session-command-surface",
            ),
            move || {
                release_receiver
                    .recv()
                    .expect("owned thread command task release should arrive");
                Ok(serde_json::json!({
                    "runtime": "rust",
                    "runId": "run-command-surface",
                    "sessionId": "session-command-surface",
                    "stopReason": "final_response"
                }))
            },
        )
        .expect("thread command run should have an active owner");

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
    assert_eq!(
        interrupted["taskCancellation"]["task"]["state"],
        "cancel_requested"
    );
    assert_eq!(
        owned_handle
            .wait()
            .expect("thread interrupt should complete the owned handle")["stopReason"],
        "cancelled"
    );
    release_sender
        .send(())
        .expect("owned thread command task should release");
    for _ in 0..100 {
        if task_runtime.draining_count() == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(task_runtime.draining_count(), 0);
}

#[test]
fn worker_resolve_thread_approval_requires_rollout_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "runtime checkpoint approval final" }]
            }
        }
    });
    let thread_id = "thread-runtime-checkpoint-approval";
    let session_id = "session-runtime-checkpoint-approval";
    let run_id = "run-runtime-checkpoint-approval";
    let approval_id = "approval-runtime-checkpoint-approval";
    let create_request = next_worker_request_correlation();
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            create_request.id("runtime-checkpoint-thread-create"),
            create_request.trace_id("runtime-checkpoint-thread-create"),
            "thread.create",
            serde_json::json!({
                "threadId": thread_id,
                "sessionKey": session_id,
                "title": "Runtime checkpoint approval"
            }),
        ),
        "runtime checkpoint thread create",
    )
    .expect("approval thread should create");
    let start_request = next_worker_request_correlation();
    call_rust_state_service(
        fixture.root.clone(),
        config.clone(),
        WorkerRequest::new(
            start_request.id("runtime-checkpoint-thread-start"),
            start_request.trace_id("runtime-checkpoint-thread-start"),
            "thread.start_turn",
            serde_json::json!({
                "threadId": thread_id,
                "runId": run_id,
                "turnId": run_id,
                "input": { "role": "user", "content": "run shell command" }
            }),
        ),
        "runtime checkpoint thread start",
    )
    .expect("approval thread turn should start");

    let runtime_services = lock_runtime(&shared).native_agent_runtime.clone();
    let awaiting = crate::worker_agent_runtime::run_native_agent_turn_with_services(
        &runtime_services,
        serde_json::json!({
            "runtime": "rust",
            "runId": run_id,
            "sessionId": session_id,
            "threadId": thread_id,
            "metadata": {
                "threadId": thread_id,
                "fakeAwaitingApproval": {
                    "approvalId": approval_id,
                    "toolName": "shell.execute"
                }
            }
        }),
    )
    .expect("runtime approval checkpoint should exist before thread projection");
    assert_eq!(awaiting["stopReason"], "awaiting_approval");

    let snapshot = worker_thread_request_with_options(
        &shared,
        "runtime-checkpoint-thread-read",
        "thread.read",
        serde_json::json!({ "threadId": thread_id }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("approval thread should remain readable");
    assert!(snapshot["latestCheckpoint"].is_null());

    let result = worker_resolve_thread_approval_with_options(
        &shared,
        WorkerResolveThreadApprovalInput {
            thread_id: thread_id.to_string(),
            approval_id: approval_id.to_string(),
            approved: true,
            scope: Some("once".to_string()),
            guidance: None,
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("missing Rollout checkpoint should return a not-found approval result");

    assert_eq!(result["approvalResult"]["status"], "not_found");
    assert_eq!(result["snapshot"]["thread"]["status"], "running");
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
    assert_eq!(
        awaiting["snapshot"]["activeRun"]["status"],
        "waiting_for_approval"
    );
    assert_eq!(
        awaiting["snapshot"]["latestCheckpoint"]["restorePayload"]["phase"],
        "awaiting_approval"
    );
    let thread_id = awaiting["threadId"].as_str().unwrap().to_string();
    let session_id = awaiting["sessionId"].as_str().unwrap().to_string();
    let resumed_shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_resolve_thread_approval_with_options(
        &resumed_shared,
        WorkerResolveThreadApprovalInput {
            thread_id: thread_id.clone(),
            approval_id: "approval-thread-command".to_string(),
            approved: true,
            scope: Some("once".to_string()),
            guidance: None,
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread approval command should resume run");

    assert_eq!(result["threadId"], thread_id);
    assert_eq!(result["sessionId"], session_id);
    assert_eq!(result["approvalResult"]["stopReason"], "final_response");
    assert_eq!(result["snapshot"]["thread"]["status"], "idle");
    assert!(result["snapshot"]["latestCheckpoint"].is_null());
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(
            |item| item["kind"]["type"] == "assistant_message_completed" && item["runId"] == run_id
        ));
    let history = call_rust_state_service(
        fixture.root.clone(),
        config,
        WorkerRequest::new(
            "req-thread-approval-rollout-history",
            "trace-thread-approval-rollout-history",
            "session.get_history",
            serde_json::json!({ "session_id": session_id }),
        ),
        "thread approval Rollout history",
    )
    .expect("thread approval Rollout history should be readable");
    assert!(history["messages"]
        .as_array()
        .expect("Rollout history should contain messages")
        .iter()
        .any(|message| {
            message["role"] == "assistant"
                && message["content"] == result["approvalResult"]["finalContent"]
        }));
}

#[test]
fn thread_turn_trace_is_preserved_and_redacted_across_provider_mcp_subagent_and_approval() {
    let fixture = WorkspaceFixture::new();
    let script = fixture.root.join("trace-acceptance-mcp-server.js");
    std::fs::write(
        &script,
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
      serverInfo: { name: "tinybot-trace-acceptance", version: "1.0.0" }
    }});
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "inspect",
      description: "Inspect a bounded trace fixture.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false }
    }] }});
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: "trace-secret-value inspected" }],
      structuredContent: { result: "trace-secret-value inspected" },
      isError: false
    }});
  }
});
"#,
    )
    .expect("trace acceptance MCP fixture should write");
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "api_key": "trace-secret-value",
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "trace-search-mcp",
                            "name": "tool_search",
                            "argumentsJson": "{\"query\":\"inspect bounded trace fixture\",\"limit\":1}"
                        }]
                    },
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "trace-spawn-subagent",
                            "name": "subagent.spawn",
                            "argumentsJson": "{\"subagentId\":\"trace-child\",\"childRunId\":\"trace-child-run\",\"task\":\"Inspect one bounded trace boundary\"}"
                        }]
                    },
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "trace-call-mcp",
                            "name": "mcp.4:docs.7:inspect",
                            "argumentsJson": "{}"
                        }]
                    },
                    { "content": "trace acceptance complete" }
                ]
            }
        },
        "mcp": { "servers": { "docs": {
            "enabled": true,
            "transport": "stdio",
            "command": "node",
            "args": [script.to_string_lossy()],
            "cwd": fixture.root.to_string_lossy(),
            "timeout_seconds": 5,
            "enabled_tools": ["inspect"]
        }}}
    });
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));
    let run_id = "run-thread-trace-acceptance";
    let trace_id = "trace-thread-acceptance";
    let request_id = "request-thread-acceptance";

    let awaiting = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "exercise the traced runtime path" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "requestId": request_id,
                "traceId": trace_id,
                "runId": run_id,
                "maxIterations": 6
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_secs(10),
    )
    .expect("traced thread turn should reach MCP approval");
    assert_eq!(awaiting["agentResult"]["stopReason"], "awaiting_approval");
    let thread_id = awaiting["threadId"]
        .as_str()
        .expect("traced thread ID should be present")
        .to_string();
    let approval_id = awaiting["agentResult"]["approval"]["approvalId"]
        .as_str()
        .expect("traced MCP approval ID should be present")
        .to_string();

    let completed = worker_resolve_thread_approval_with_options(
        &shared,
        WorkerResolveThreadApprovalInput {
            thread_id: thread_id.clone(),
            approval_id,
            approved: true,
            scope: Some("once".to_string()),
            guidance: None,
        },
        fixture.root.clone(),
        config,
        Duration::from_secs(10),
    )
    .expect("approved traced MCP tool should complete");
    assert_eq!(completed["approvalResult"]["stopReason"], "final_response");

    let runtime_events = awaiting["agentResult"]["runtimeEvents"]
        .as_array()
        .expect("awaiting runtime events should be present")
        .iter()
        .chain(
            completed["approvalResult"]["runtimeEvents"]
                .as_array()
                .expect("resumed runtime events should be present"),
        )
        .collect::<Vec<_>>();
    for event_name in [
        "agent.provider.requested",
        "agent.provider.completed",
        "agent.delegate.linked",
        "agent.awaiting_approval",
        "agent.approval.decision",
    ] {
        let event = runtime_events
            .iter()
            .find(|event| event["eventName"] == event_name)
            .unwrap_or_else(|| panic!("{event_name} should be emitted"));
        assert_eq!(event["traceContext"]["traceId"], trace_id);
        assert_eq!(event["traceContext"]["requestId"], request_id);
    }
    let mcp_result = runtime_events
        .iter()
        .find(|event| {
            event["eventName"] == "agent.tool.result"
                && event["payload"]["toolName"] == "mcp.4:docs.7:inspect"
        })
        .expect("real MCP result should be emitted");
    assert_eq!(mcp_result["traceContext"]["traceId"], trace_id);
    assert!(!mcp_result.to_string().contains("trace-secret-value"));
    assert!(mcp_result.to_string().contains("[REDACTED]"));

    let rollout_paths = compatibility_thread_log_paths(&fixture.root);
    assert!(!rollout_paths.is_empty());
    let rollout = rollout_paths
        .iter()
        .map(|path| std::fs::read_to_string(path).expect("canonical Rollout should be readable"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rollout.contains(trace_id));
    assert!(rollout.contains("agent.delegate.linked"));
    assert!(rollout.contains("agent.approval.decision"));
    assert!(rollout.contains("mcp.4:docs.7:inspect"));
    assert!(!rollout.contains("trace-secret-value"));
    assert!(rollout.contains("[REDACTED]"));

    stop_owned_gateway(&shared, false).expect("trace acceptance MCP runtime should stop");
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
    assert_eq!(
        awaiting["snapshot"]["activeRun"]["status"],
        "waiting_for_input"
    );
    assert_eq!(
        awaiting["snapshot"]["latestCheckpoint"]["restorePayload"]["phase"],
        "awaiting_form"
    );
    let thread_id = awaiting["threadId"].as_str().unwrap().to_string();
    let session_id = awaiting["sessionId"].as_str().unwrap().to_string();
    let resumed_shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = worker_submit_thread_form_with_options(
        &resumed_shared,
        WorkerSubmitThreadFormInput {
            thread_id: thread_id.clone(),
            form_id: "form-thread-command".to_string(),
            values: serde_json::json!({}),
            action: Some("submit".to_string()),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread form command should resume run");

    assert_eq!(result["threadId"], thread_id);
    assert_eq!(result["sessionId"], session_id);
    assert_eq!(result["formResult"]["statusCode"], 200);
    assert_eq!(result["formResult"]["stopReason"], "final_response");
    assert_eq!(result["snapshot"]["thread"]["status"], "idle");
    assert!(result["snapshot"]["latestCheckpoint"].is_null());
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(
            |item| item["kind"]["type"] == "assistant_message_completed" && item["runId"] == run_id
        ));
    let history = call_rust_state_service(
        fixture.root.clone(),
        config,
        WorkerRequest::new(
            "req-thread-form-rollout-history",
            "trace-thread-form-rollout-history",
            "session.get_history",
            serde_json::json!({ "session_id": session_id }),
        ),
        "thread form Rollout history",
    )
    .expect("thread form Rollout history should be readable");
    assert!(history["messages"]
        .as_array()
        .expect("Rollout history should contain messages")
        .iter()
        .any(|message| message["role"] == "assistant"));
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
    let approval_item = runtime_state["timeline"]["items"]
        .as_array()
        .expect("timeline items should be an array")
        .iter()
        .find(|item| item["kind"] == "approval")
        .expect("approval item should be restored");
    assert_eq!(approval_item["status"], "waiting");
    assert_eq!(approval_item["data"]["approvalId"], "approval-trace-sink");
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
        serialized.len() < 25_000,
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
    assert_eq!(restored["checkpoint"]["maxIterations"], 200);
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
}

#[test]
fn worker_agent_run_runtime_commands_use_thread_log_agent_run_store() {
    let fixture = WorkspaceFixture::new();
    let record = serde_json::json!({
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
    });
    call_rust_state_service(
        fixture.root.clone(),
        serde_json::json!({}),
        WorkerRequest::new(
            "req-seed-agent-run-thread-log",
            "trace-seed-agent-run-thread-log",
            "agent_run.upsert",
            serde_json::json!({ "record": record }),
        ),
        "agent run thread log seed",
    )
    .expect("agent run should seed thread log store");
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let runs = worker_agent_runs_list_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("agent run list should be served by thread log store");
    let runtime_state = worker_agent_run_runtime_state_with_options(
        &shared,
        "websocket:chat-1".to_string(),
        "run-1".to_string(),
        fixture.root.clone(),
        serde_json::json!({}),
        Duration::from_millis(10),
    )
    .expect("agent run runtime state should be served by thread log store");

    assert_eq!(runs["runs"][0]["runId"], "run-1");
    assert_eq!(runtime_state["timeline"]["sessionId"], "websocket:chat-1");
    assert_eq!(runtime_state["timeline"]["runId"], "run-1");
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
    assert_eq!(
        lock_runtime(&shared).experimental_worker.status().state,
        WorkerManagerState::Stopped
    );
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
        "no_active_run"
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
        item["kind"] == "system_notice"
            && item["data"]["detail"]["commandId"] == "command-agent-request-1"
            && item["data"]["detail"]["commandKind"] == "agent.request_change"
    }));
    assert!(items.iter().any(|item| {
        item["kind"] == "user_message"
            && item["data"]["references"] == references
            && item["data"]["content"] == "Explain the selected file range. Do not modify files."
    }));
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
                        "name": "workspace.list_files",
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
            item["kind"] == "system_notice"
                && item["data"]["detail"]["commandId"] == "command-operation-retry-1"
                && item["data"]["detail"]["commandKind"] == "operation.retry"
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
    let output = crate::worker_shell::ShellProcessOutput {
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
    assert_eq!(status.state, "running");
    assert!(!status.http_ok);
    assert_eq!(status.bootstrap_status, "not_required");
    assert_eq!(status.response_class, Some("tauri-native".to_string()));
    assert!(status.recovery_hint.is_none());
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
            "[native-backend] worker.request.start route=POST /api/cowork/sessions",
        )),
    );

    let contents =
        std::fs::read_to_string(log_path).expect("persistent backend log should be written");
    assert!(contents
        .contains("stderr [native-backend] worker.request.start route=POST /api/cowork/sessions"));
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
            "older line\nworker.request.start route=POST /api/cowork/sessions\ncowork.session.progress percent=60\n",
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
        .any(|line| line.contains("POST /api/cowork/sessions")));
    assert!(status
        .log_tail
        .iter()
        .any(|line| line.contains("cowork.session.progress")));
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
    assert_eq!(
        saved["providers"]["profiles"]["deepseek-default"]["capabilities"],
        serde_json::json!(["reasoning"])
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
        agent_tasks: crate::desktop_commands::gateway::AgentTaskRuntimeStatus {
            accepting: true,
            active_runs: 0,
            draining_runs: 0,
        },
        route_owner_summary: crate::native_backend_contract::native_route_owner_summary(),
        webui_route_inventory: crate::native_backend_contract::native_webui_route_inventory(),
        compatibility_fallback_diagnostics: vec![],
        lifecycle: crate::runtime::lifecycle::RuntimeLifecycleStatus::default(),
    };

    let value = serde_json::to_value(status).expect("status should serialize");

    assert_eq!(value["worker_runtime"]["state"], "stopped");
    assert_eq!(value["agent_tasks"]["accepting"], true);
    assert_eq!(value["agent_tasks"]["activeRuns"], 0);
    assert_eq!(value["lifecycle"]["startupReconciled"], false);
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
        allowed_workspace_file_path(root, "SYSTEM.md").expect("system prompt should be editable"),
        root.join("SYSTEM.md")
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

    fn seed_rollout_sessions(&self, store: serde_json::Value) {
        let rpc = crate::worker_thread_log::WorkerThreadLogRpc::new(
            self.root.clone(),
            crate::worker_capability::CapabilityPolicy::new([
                crate::worker_capability::WorkerCapability::SessionMetadataRead,
                crate::worker_capability::WorkerCapability::SessionWrite,
            ]),
        );
        let sessions = store
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .expect("fixture Rollout seed should contain sessions");
        for session in sessions {
            let session_id = session["session_id"]
                .as_str()
                .expect("fixture session id should be a string");
            let messages = session["extra"]["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            rpc.append_session_messages(session_id, messages)
                .expect("fixture Rollout messages should append");
            let mut metadata = session["extra"]["metadata"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            metadata.insert("title".to_string(), session["title"].clone());
            metadata.insert(
                "workingDirectory".to_string(),
                session["workspace_dir"].clone(),
            );
            rpc.patch_metadata(session_id, &serde_json::Value::Object(metadata))
                .expect("fixture Rollout metadata should patch");
            if let Some(user_profile) = session["extra"].get("user_profile") {
                rpc.patch_user_profile(session_id, user_profile.clone(), serde_json::json!({}))
                    .expect("fixture Rollout user profile should patch");
            }
        }
    }
}

impl Drop for WorkspaceFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
