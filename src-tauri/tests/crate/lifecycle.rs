use super::support::*;
use crate::agent::bridge::native_agent_turn_start_record;
use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::agent::runtime::{AgentStopReason, AgentTurnResult};
use crate::config::application::default_tinybot_workspace_root;
use crate::config::application::native_config_snapshot_from_path;
use crate::config::application::resolve_native_backend_workspace_root_from_config_path;
use crate::desktop::files::reveal_workspace_file_path_from_config_path;
use crate::desktop::state::lock_runtime;
use crate::desktop::state::NativeRuntimeState;
use crate::desktop_commands::agent::worker_run_agent_with_options;
use crate::desktop_commands::runtime::shutdown_native_runtime;
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
    let shared = Arc::new(Mutex::new(NativeRuntimeState {
        native_agent_runtime: services,
        ..NativeRuntimeState::default()
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
                Ok(AgentTurnResult::new(
                    "turn-shutdown-owned",
                    "session-shutdown-owned",
                    AgentStopReason::FinalResponse,
                ))
            },
        )
        .expect("owned agent task should start");
    assert_eq!(task_runtime.active_count(), 1);

    shutdown_native_runtime(&shared, true).expect("owned agent task should drain during shutdown");
    let result = handle
        .wait()
        .expect("owned agent runner should return cancellation");

    assert_eq!(result.stop_reason, AgentStopReason::Cancelled);
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
    let mut runtime = NativeRuntimeState::default();
    runtime.mcp_runtime = mcp_runtime.clone();
    let shared = Arc::new(Mutex::new(runtime));

    shutdown_native_runtime(&shared, false).expect("app shutdown should stop MCP runtime");

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

    let mut running_record: crate::threads::turn::AgentTurnRecord = native_agent_turn_start_record(
        &crate::agent::runtime::AgentTurnInput::from_wire(
            &serde_json::json!({
                "turnId": "turn-orphaned",
                "sessionId": "session-recovery",
                "threadId": "thread-recovery"
            }),
            &serde_json::json!({}),
        )
        .unwrap(),
        "session-recovery",
        "turn-orphaned",
    );
    running_record.thread_id = Some("thread-recovery".to_string());
    thread_log
        .start_turn(running_record, None, Vec::new())
        .expect("running recovery record should persist");
    let mut waiting_record: crate::threads::turn::AgentTurnRecord = native_agent_turn_start_record(
        &crate::agent::runtime::AgentTurnInput::from_wire(
            &serde_json::json!({
                "turnId": "turn-waiting",
                "sessionId": "session-recovery"
            }),
            &serde_json::json!({}),
        )
        .unwrap(),
        "session-recovery",
        "turn-waiting",
    );
    waiting_record.status = crate::threads::turn::AgentTurnStatus::Waiting;
    waiting_record.phase = "awaiting_form".to_string();
    waiting_record.stop_reason = Some("awaiting_form".to_string());
    waiting_record.checkpoint =
        Some(serde_json::json!({ "phase": "awaiting_form", "turnId": "turn-waiting" }));
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

    let shared = Arc::new(Mutex::new(NativeRuntimeState::default()));
    let recovery_metrics_before =
        crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    crate::desktop_commands::runtime::start_native_runtime_with_workspace_root(
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
        crate::threads::turn::AgentTurnStatus::Interrupted
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
        crate::threads::turn::AgentTurnStatus::Waiting
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
        crate::threads::domain::ThreadStatus::WaitingForInput
    );

    let lifecycle = lock_runtime(&shared).lifecycle_status.clone();
    let live_store = lock_runtime(&shared).thread_store.clone();
    let live_operation = live_store.begin_operation().unwrap();
    let live_status = live_operation
        .thread()
        .get_thread_status(crate::threads::domain::ThreadIdParams {
            thread_id: "thread-recovery".to_string(),
        })
        .unwrap();
    assert_eq!(live_status.active_turn.unwrap().turn_id, "turn-waiting");
    drop(live_operation);
    let recovery = lifecycle
        .last_startup_recovery
        .as_ref()
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
    assert!(lifecycle.diagnostics.is_empty());
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

    let restarted = Arc::new(Mutex::new(NativeRuntimeState::default()));
    crate::desktop_commands::runtime::start_native_runtime_with_workspace_root(
        &restarted,
        fixture.root.clone(),
    )
    .expect("repeated process startup recovery should be idempotent");
    let repeated_lifecycle = lock_runtime(&restarted).lifecycle_status.clone();
    let repeated = repeated_lifecycle
        .last_startup_recovery
        .as_ref()
        .expect("repeated startup should expose its report");
    assert!(repeated.interrupted_turns.is_empty());
    assert!(repeated
        .resumable_turns
        .iter()
        .any(|turn| turn.turn_id == "turn-waiting"));
}

#[test]
fn clean_startup_avoids_redundant_canonical_scans_and_projection_rebuilds() {
    let fixture = WorkspaceFixture::new();
    let policy = default_desktop_capability_policy();
    let writer = crate::threads::rollout::store::WorkerThreadLogRpc::new(
        fixture.root.clone(),
        policy.clone(),
    );
    let thread = crate::threads::domain::WorkerThreadRpc::new(fixture.root.clone(), policy);
    for index in 0..24 {
        let created = thread
            .create_thread(crate::threads::domain::CreateThreadRequest {
                thread_id: Some(format!("startup-budget-{index}")),
                session_key: Some(format!("startup-budget-session-{index}")),
                ..Default::default()
            })
            .unwrap();
        writer.create_from_thread_record(&created).unwrap();
    }
    writer.flush_all().unwrap();
    let started = std::time::Instant::now();
    let report =
        crate::runtime::lifecycle::RuntimeLifecycle::reconcile_startup(&fixture.thread_store)
            .unwrap();
    let elapsed = started.elapsed();
    let metrics = crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    for name in [
        "storage.operation.lockWait.durationMs",
        "storage.index.rebuild.durationMs",
        "storage.index.populate.durationMs",
        "storage.canonical.discoverPaths.durationMs",
        "storage.rollout.headHash.durationMs",
        "storage.rollout.readAndDecompress.durationMs",
        "storage.rollout.parseJson.durationMs",
        "storage.rollout.reconstruct.durationMs",
        "storage.projection.build.durationMs",
        "storage.projection.install.durationMs",
    ] {
        assert!(
            metrics["durations"][name]["count"].as_u64().unwrap_or(0) > 0,
            "missing phase {name}"
        );
    }
    assert_eq!(report.scanned_threads, 24);
    assert!(report.interrupted_turns.is_empty());
    assert_eq!(
        report.session_log_index.unwrap().status,
        crate::threads::rollout::store::ThreadLogIndexConsistencyStatus::Clean
    );
    let operation = fixture.thread_store.begin_operation().unwrap();
    let (scans, projections) = operation.thread_log().startup_work_counts();
    eprintln!("startup_work_budget threads=24 canonical_scans={scans} projections={projections} elapsed_us={}", elapsed.as_micros());
    assert_eq!(
        scans, 2,
        "one index build and one independent consistency validation"
    );
    assert_eq!(
        projections, 1,
        "clean recovery should reuse the initialized projection"
    );
}

#[test]
fn startup_refreshes_a_previously_loaded_projection_after_index_repair() {
    let fixture = WorkspaceFixture::new();
    // Simulate a stale in-memory projection before a canonical writer adds a Thread.
    drop(fixture.thread_store.begin_operation().unwrap());
    let policy = default_desktop_capability_policy();
    let writer = crate::threads::rollout::store::WorkerThreadLogRpc::new(
        fixture.root.clone(),
        policy.clone(),
    );
    let thread = crate::threads::domain::WorkerThreadRpc::new(fixture.root.clone(), policy);
    let created = thread
        .create_thread(crate::threads::domain::CreateThreadRequest {
            thread_id: Some("new-canonical-thread".to_string()),
            ..Default::default()
        })
        .unwrap();
    writer.create_from_thread_record(&created).unwrap();
    writer.flush_all().unwrap();

    let report =
        crate::runtime::lifecycle::RuntimeLifecycle::reconcile_startup(&fixture.thread_store)
            .unwrap();
    assert!(report.session_log_index_migration.is_some());
    assert_eq!(report.scanned_threads, 1);
    let operation = fixture.thread_store.begin_operation().unwrap();
    let status = operation
        .thread()
        .get_thread_status(crate::threads::domain::ThreadIdParams {
            thread_id: created.thread_id,
        })
        .unwrap();
    assert_eq!(status.thread.thread_id, "new-canonical-thread");
}

#[test]
fn startup_recovery_failure_pauses_runtime_and_exposes_diagnostic() {
    let fixture = WorkspaceFixture::new();
    let invalid_thread_root = fixture.root.join(".tinybot").join("threads");
    std::fs::create_dir_all(invalid_thread_root.parent().unwrap())
        .expect("invalid thread storage parent should create");
    std::fs::write(&invalid_thread_root, "not a directory")
        .expect("invalid thread storage fixture should write");
    let shared = Arc::new(Mutex::new(NativeRuntimeState::default()));

    let error = match crate::desktop_commands::runtime::start_native_runtime_with_workspace_root(
        &shared,
        fixture.root.clone(),
    ) {
        Ok(_) => panic!("startup recovery storage failure must fail closed"),
        Err(error) => error,
    };

    assert!(error.contains("startup recovery failed"));
    let runtime = lock_runtime(&shared);
    assert!(!runtime.native_agent_runtime.task_runtime().is_accepting());
    assert!(!runtime.lifecycle_status.startup_reconciled);
    assert!(runtime
        .lifecycle_status
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.stage == "startup_recovery"));
    assert!(runtime
        .last_error
        .as_deref()
        .is_some_and(|message| message.contains("startup recovery failed")));
}

#[test]
fn close_shutdown_stops_shell_and_interrupts_subagents_with_report() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::default()));
    let (shell_runtime, subagents) = {
        let runtime = lock_runtime(&shared);
        (
            runtime.shell_runtime.clone(),
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
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
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

    shutdown_native_runtime(&shared, true).expect("unified shutdown should complete");

    assert_eq!(shell_runtime.active_process_count(), 0);
    assert_eq!(
        subagents.list("session-shutdown").subagents[0].status,
        crate::collaboration::subagents::SubagentThreadStatus::Interrupted
    );
    let runtime = lock_runtime(&shared);
    let report = runtime
        .lifecycle_status
        .last_shutdown
        .as_ref()
        .expect("shutdown report should be exposed");
    assert!(!runtime.native_agent_runtime.task_runtime().is_accepting());
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
    drop(runtime);

    crate::desktop_commands::runtime::start_native_runtime_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
    .expect("same-process runtime restart should resume shell starts");
    let resumed = shell
        .start(crate::tools::shell::ShellStartParams {
            command: lifecycle_echo_command(),
            working_dir: Some(".".to_string()),
            tty: Some(false),
            yield_time_ms: Some(1_000),
            rows: None,
            cols: None,
            owner_id: Some("turn-shell-resumed".to_string()),
            tool_call_id: Some("tool-shell-resumed".to_string()),
            cancellation: None,
        })
        .expect("shell manager should accept starts after runtime restart");
    assert_eq!(resumed.exit_code, Some(0));
}

#[test]
fn close_shutdown_exposes_cleanup_timeout_diagnostics() {
    let shared = Arc::new(Mutex::new(NativeRuntimeState::default()));
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
                Ok(AgentTurnResult::new(
                    "turn-cleanup-timeout",
                    "session-cleanup-timeout",
                    AgentStopReason::FinalResponse,
                ))
            },
        )
        .expect("cleanup timeout fixture should start");

    let error = crate::desktop_commands::runtime::shutdown_native_runtime_with_timeout(
        &shared,
        true,
        Duration::from_millis(20),
    )
    .expect_err("cleanup timeout must fail explicitly");
    assert!(error.contains("agent task cleanup timed out"));
    let runtime = lock_runtime(&shared);
    let report = runtime
        .lifecycle_status
        .last_shutdown
        .as_ref()
        .expect("failed shutdown should still expose its report");
    assert!(!report.completed);
    assert!(report
        .failures
        .iter()
        .any(|failure| failure.stage == "agent_tasks"));
    assert!(runtime
        .lifecycle_status
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.stage == "agent_tasks"));
    assert!(runtime
        .last_error
        .as_deref()
        .is_some_and(|message| message.contains("agent task cleanup timed out")));
    drop(runtime);

    release_sender
        .send(())
        .expect("cleanup timeout fixture should release");
    let _ = handle.wait();
}

#[test]
fn native_runtime_starts_with_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::default()));

    crate::desktop_commands::runtime::start_native_runtime_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
    .expect("Rust backend startup should not require TS worker");

    let runtime = lock_runtime(&shared);
    assert!(runtime.native_agent_runtime.task_runtime().is_accepting());
    assert!(runtime
        .logs
        .iter()
        .any(|line| line == "Rust native backend active"));
}

#[test]
fn desktop_smoke_default_chat_runs_on_rust_backend() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(NativeRuntimeState::default()));
    crate::desktop_commands::runtime::start_native_runtime_with_workspace_root(
        &shared,
        fixture.root.clone(),
    )
    .expect("default desktop runtime should start Rust backend");

    let chat = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-desktop-smoke",
            "sessionId": "websocket:desktop-smoke",
            "messages": [{ "role": "user", "content": "desktop smoke" }]
        }),
        fixture.root.clone(),
        serde_json::json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "smoke response from rust" }] } }
        }),
        Duration::from_millis(10),
    )
    .expect("desktop smoke chat should use the native Rust Turn flow");

    assert_eq!(chat["runtime"], "rust");
    assert_eq!(chat["finalContent"], "smoke response from rust");
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
    let thread_store = crate::threads::workspace_store::WorkspaceThreadStore::new(
        workspace_root,
        crate::protocol::capability::default_desktop_capability_policy(),
    );
    let mut router = native_request_router(thread_store, serde_json::json!({}))
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
fn native_request_router_ignores_removed_session_store() {
    let fixture = WorkspaceFixture::new();
    fixture.write("sessions/store.json", "{not valid json");
    let mut router = native_request_router(fixture.thread_store.clone(), serde_json::json!({}));

    let response = router.dispatch(&WorkerRequest::new(
        "req-sessions",
        "trace-sessions",
        "thread.list",
        serde_json::json!({}),
    ));

    assert_eq!(response.error, None);
    assert_eq!(
        response
            .result
            .as_ref()
            .and_then(|result| result["threads"].as_array())
            .map(Vec::len),
        Some(0),
        "removed session stores should not affect canonical thread reads"
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
fn native_config_defaults_to_schema_v2_deepseek_profile_without_config_file() {
    let fixture = WorkspaceFixture::new();
    assert_eq!(
        native_config_snapshot_from_path(&fixture.root.join("missing-config.json")),
        serde_json::json!({
            "schemaVersion": 2,
            "tools": {
                "web": { "enable": true },
                "exec": { "enable": true }
            },
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
                        "models": ["deepseek-v4-pro", "deepseek-flash"],
                        "defaultModel": "deepseek-v4-pro",
                        "supportsModelDiscovery": true,
                        "capabilities": ["reasoning"]
                    }
                }
            }
        })
    );
}

#[test]
fn native_request_router_allows_registered_mcp_tools() {
    let fixture = WorkspaceFixture::new();
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
        fixture.thread_store.clone(),
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

    let mcp_response = router.dispatch(&crate::protocol::WorkerRequest::new(
        "mcp-call-1",
        "trace-mcp-call",
        "mcp.call_tool",
        serde_json::json!({
            "server": "docs",
            "tool": "search",
            "arguments": { "query": "agent loop" }
        }),
    ));

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
#[test]
fn runtime_initialization_reports_migration_conflicts_before_creating_state() {
    let fixture = WorkspaceFixture::new();
    let data_root = fixture.root.join("application-data");
    let legacy = fixture.root.join(".tinybot/threads/initialization-fixture");
    let target = data_root.join("threads/initialization-fixture");
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&legacy, "legacy content").unwrap();
    std::fs::write(&target, "conflicting content").unwrap();

    let error = match NativeRuntimeState::initialize(fixture.root.clone(), data_root.clone()) {
        Ok(_) => panic!("conflicting storage must prevent runtime initialization"),
        Err(error) => error,
    };
    assert!(error.contains("thread storage initialization failed"));
    assert!(error.contains(&fixture.root.display().to_string()));
    assert!(error.contains(&data_root.display().to_string()));
    assert_eq!(std::fs::read_to_string(&legacy).unwrap(), "legacy content");
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "conflicting content"
    );

    std::fs::remove_file(&target).unwrap();
    let state = NativeRuntimeState::initialize(fixture.root.clone(), data_root.clone()).unwrap();
    assert_eq!(state.thread_store.data_root(), data_root);
    assert_eq!(state.thread_store.workspace_root(), fixture.root);
    assert_eq!(std::fs::read_to_string(target).unwrap(), "legacy content");
    assert!(!legacy.exists());
    assert!(state.last_error.is_none());
}
