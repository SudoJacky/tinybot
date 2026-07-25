use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::rpc::WorkerRpcRouter;
use serde_json::json;
use std::path::PathBuf;

#[test]
fn manager_emits_status_events_on_start_and_stop() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let event_log = events.clone();
    let manager = WorkerManager::new(20).with_event_sink(move |event| {
        event_log.lock().expect("event log should lock").push(event);
    });

    manager
        .start(test_worker_spec("manager-status-events"))
        .expect("worker should start");
    manager.stop().expect("worker should stop");

    let events = events.lock().expect("event log should lock");

    assert!(events.iter().any(|event| matches!(
        event,
        WorkerManagerEvent::Status(status)
            if status.state == WorkerManagerState::Running
                && status.label.as_deref() == Some("manager-status-events")
                && status.pid.is_some()
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        WorkerManagerEvent::Status(status)
            if status.state == WorkerManagerState::Stopped && status.pid.is_none()
    )));
}

#[test]
fn manager_emits_diagnostics_events_for_stdout_and_stderr() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let event_log = events.clone();
    let manager = WorkerManager::new(20).with_event_sink(move |event| {
        event_log.lock().expect("event log should lock").push(event);
    });

    manager
        .start(test_logging_worker_spec())
        .expect("logging worker should start");

    let events = wait_for_events(&events, |events| {
        has_diagnostics_event(events, "stdout", "worker stdout")
            && has_diagnostics_event(events, "stderr", "worker stderr")
    });

    assert!(has_diagnostics_event(&events, "stdout", "worker stdout"));
    assert!(has_diagnostics_event(&events, "stderr", "worker stderr"));
}

#[test]
fn manager_starts_worker_once_and_reports_pid() {
    let manager = WorkerManager::new(20);
    let spec = test_worker_spec("manager-starts-once");

    manager.start(spec.clone()).expect("worker should start");
    let duplicate = manager
        .start(spec)
        .expect_err("running worker should not start twice");
    let status = manager.status();

    assert_eq!(duplicate, WorkerManagerError::AlreadyRunning);
    assert_eq!(status.state, WorkerManagerState::Running);
    assert!(status.pid.is_some());

    manager.stop().expect("worker should stop");
}

#[test]
fn manager_records_failed_state_when_startup_fails() {
    let manager = WorkerManager::new(20);
    let error = manager
        .start(
            WorkerCommandSpec::new(
                "definitely-not-a-real-tinybot-worker",
                std::iter::empty::<&str>(),
                PathBuf::from("."),
            )
            .with_label("missing-worker"),
        )
        .expect_err("missing worker executable should fail startup");
    let status = manager.status();

    assert!(matches!(error, WorkerManagerError::SpawnFailed(_)));
    assert_eq!(status.state, WorkerManagerState::Failed);
    assert_eq!(status.label.as_deref(), Some("missing-worker"));
    assert!(status.pid.is_none());
    assert!(status
        .last_error
        .as_deref()
        .is_some_and(|message| message.contains("failed to spawn worker")));
}

#[test]
fn manager_concurrent_stdio_start_spawns_only_one_worker() {
    let fixture = WorkspaceFixture::new();
    let manager = WorkerManager::new(20);
    let mut handles = Vec::new();

    for _ in 0..8 {
        let manager = manager.clone();
        let workspace_root = fixture.root.clone();
        handles.push(std::thread::spawn(move || {
            let router = WorkerRpcRouter::new(
                workspace_root,
                json!({}),
                vec![],
                20,
                CapabilityPolicy::default(),
            );
            manager.start_stdio_rpc(test_stdio_blocking_event_worker_spec(), router)
        }));
    }

    let mut started = 0;
    let mut already_running = 0;
    for handle in handles {
        match handle.join().expect("start thread should not panic") {
            Ok(()) => started += 1,
            Err(WorkerManagerError::AlreadyRunning) => already_running += 1,
            Err(error) => panic!("unexpected start error: {error:?}"),
        }
    }

    assert_eq!(started, 1);
    assert_eq!(already_running, 7);
    assert_eq!(manager.status().state, WorkerManagerState::Running);
    manager.stop().expect("worker should stop");
}

#[test]
fn manager_stop_clears_starting_state_without_process() {
    let manager = WorkerManager::new(20);
    {
        let mut inner = lock_inner(&manager.inner);
        inner.lifecycle = WorkerProcessLifecycle::Starting;
        inner.label = Some("starting-worker".to_string());
        inner.started_at_unix_ms = Some(42);
    }

    manager.stop().expect("stop while starting should succeed");
    let status = manager.status();

    assert_eq!(status.state, WorkerManagerState::Stopped);
    assert!(status.label.is_none());
    assert!(status.pid.is_none());
    assert!(status.started_at_unix_ms.is_none());
}

#[test]
fn manager_restart_replaces_running_worker() {
    let manager = WorkerManager::new(20);

    manager
        .start(test_worker_spec("manager-restart-before"))
        .expect("worker should start");
    let before = manager
        .status()
        .pid
        .expect("running worker should expose pid");

    manager
        .restart(test_worker_spec("manager-restart-after"))
        .expect("worker should restart");
    let after = manager
        .status()
        .pid
        .expect("restarted worker should expose pid");

    assert_ne!(before, after);
    assert_eq!(manager.health_check(), WorkerHealth::Running);

    manager.stop().expect("worker should stop");
}

#[test]
fn manager_captures_stdout_and_stderr_diagnostics() {
    let manager = WorkerManager::new(20);

    manager
        .start(test_logging_worker_spec())
        .expect("logging worker should start");

    let diagnostics = wait_for_diagnostics(&manager, |diagnostics| {
        has_diagnostic_line(diagnostics, "stdout", "worker stdout")
            && has_diagnostic_line(diagnostics, "stderr", "worker stderr")
    });

    assert!(has_diagnostic_line(&diagnostics, "stdout", "worker stdout"));
    assert!(has_diagnostic_line(&diagnostics, "stderr", "worker stderr"));
}

#[test]
fn manager_status_records_last_error_after_exited_worker_health_check() {
    let manager = WorkerManager::new(20);

    manager
        .start(test_logging_worker_spec())
        .expect("short worker should start");

    let status = wait_for_status(&manager, |status| {
        status.state == WorkerManagerState::Stopped
            && status.pid.is_none()
            && status
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains("worker exited"))
    });

    assert_eq!(status.state, WorkerManagerState::Stopped);
    assert!(status.pid.is_none());
    assert!(status
        .last_error
        .as_deref()
        .is_some_and(|error| error.contains("worker exited")));
}

#[test]
fn manager_serves_stdio_worker_rpc_requests() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "hello manager rpc");
    let manager = WorkerManager::new(20);
    let router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    manager
        .start_stdio_rpc(test_stdio_rpc_worker_spec(), router)
        .expect("stdio RPC worker should start");

    let diagnostics = wait_for_diagnostics(&manager, |diagnostics| {
        has_diagnostic_line(diagnostics, "stderr", "hello manager rpc")
    });

    assert!(has_diagnostic_line(
        &diagnostics,
        "stderr",
        "hello manager rpc"
    ));
}

#[test]
fn manager_records_stdio_worker_diagnostics_events() {
    let fixture = WorkspaceFixture::new();
    let manager = WorkerManager::new(20);
    let router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::default(),
    );

    manager
        .start_stdio_rpc(test_stdio_event_worker_spec(), router)
        .expect("stdio event worker should start");

    let diagnostics = wait_for_diagnostics(&manager, |diagnostics| {
        has_diagnostic_line(diagnostics, "stdout", "protocol event ready")
    });

    assert!(has_diagnostic_line(
        &diagnostics,
        "stdout",
        "protocol event ready"
    ));
}

#[test]
fn manager_full_duplex_stdio_request_allows_worker_rust_rpc_before_response() {
    let fixture = WorkspaceFixture::new();
    fixture.write("AGENTS.md", "agents");
    let manager = WorkerManager::new(20);
    let router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    manager
        .start_stdio_rpc(test_stdio_agent_echo_worker_spec(), router)
        .expect("stdio agent worker should start");

    let request = WorkerRequest::new(
        "agent-req-1",
        "trace-agent",
        "agent.echo",
        json!({ "input": "hello" }),
    );
    let response = manager
        .send_stdio_request(&request, worker_request_timeout())
        .expect("agent request should complete");

    assert_eq!(response.result.as_ref().unwrap()["ok"], true);
    assert_eq!(response.result.as_ref().unwrap()["echo"], "hello");
    assert_eq!(response.result.as_ref().unwrap()["workspaceFileCount"], 1);
}

#[test]
fn manager_restart_stdio_rpc_replaces_connection_and_preserves_full_duplex_requests() {
    let fixture = WorkspaceFixture::new();
    fixture.write("AGENTS.md", "agents");
    let manager = WorkerManager::new(20);
    let initial_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    manager
        .start_stdio_rpc(test_stdio_agent_echo_worker_spec(), initial_router)
        .expect("stdio agent worker should start");
    let before = manager
        .status()
        .pid
        .expect("running stdio worker should expose pid");

    let restarted_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );
    manager
        .restart_stdio_rpc(test_stdio_agent_echo_worker_spec(), restarted_router)
        .expect("stdio RPC worker should restart");
    let after = manager
        .status()
        .pid
        .expect("restarted stdio worker should expose pid");

    assert_ne!(before, after);
    let request = WorkerRequest::new(
        "agent-req-1",
        "trace-agent",
        "agent.echo",
        json!({ "input": "hello after restart" }),
    );
    let response = manager
        .send_stdio_request(&request, worker_request_timeout())
        .expect("agent request should complete after restart");

    assert_eq!(response.result.as_ref().unwrap()["ok"], true);
    assert_eq!(
        response.result.as_ref().unwrap()["echo"],
        "hello after restart"
    );
    assert_eq!(response.result.as_ref().unwrap()["workspaceFileCount"], 1);

    manager.stop().expect("worker should stop");
}

#[test]
fn manager_forwards_non_diagnostic_worker_protocol_events() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let event_log = events.clone();
    let fixture = WorkspaceFixture::new();
    let manager = WorkerManager::new(20).with_event_sink(move |event| {
        event_log.lock().expect("event log should lock").push(event);
    });
    let router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::default(),
    );

    manager
        .start_stdio_rpc(test_stdio_agent_event_worker_spec(), router)
        .expect("stdio event worker should start");

    let events = wait_for_events(&events, |events| {
        events.iter().any(|event| {
            matches!(
                event,
                WorkerManagerEvent::Protocol(protocol_event)
                    if protocol_event.event == "agent.delta"
                        && protocol_event.payload["message"] == "starting"
            )
        })
    });

    assert!(events.iter().any(|event| {
        matches!(
            event,
            WorkerManagerEvent::Protocol(protocol_event)
                if protocol_event.event == "agent.delta"
                    && protocol_event.payload["message"] == "starting"
        )
    }));
}

fn test_worker_spec(label: &str) -> WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        WorkerCommandSpec::new(
            "cmd",
            ["/C", "ping", "-n", "30", "127.0.0.1", ">", "NUL"],
            PathBuf::from("."),
        )
        .with_label(label)
    }

    #[cfg(not(target_os = "windows"))]
    {
        WorkerCommandSpec::new("sh", ["-c", "sleep 30"], PathBuf::from(".")).with_label(label)
    }
}

fn test_logging_worker_spec() -> WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        WorkerCommandSpec::new(
            "cmd",
            ["/C", "echo worker stdout && echo worker stderr 1>&2"],
            PathBuf::from("."),
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        WorkerCommandSpec::new(
            "sh",
            ["-c", "echo worker stdout && echo worker stderr >&2"],
            PathBuf::from("."),
        )
    }
}

fn test_stdio_rpc_worker_spec() -> WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","method":"workspace.read_file","params":{"path":"notes/today.md"}}'; [Console]::Out.WriteLine($json); $line = [Console]::In.ReadLine(); [Console]::Error.WriteLine($line)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-rpc-worker")
    }

    #[cfg(not(target_os = "windows"))]
    {
        WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","id":"req-123","trace_id":"trace-abc","method":"workspace.read_file","params":{"path":"notes/today.md"}}'; printf '%s\n' "$json"; IFS= read -r line; printf '%s\n' "$line" >&2"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-rpc-worker")
    }
}

fn test_stdio_event_worker_spec() -> WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","trace_id":"trace-event","event":"diagnostics.log","payload":{"stream":"stdout","line":"protocol event ready"}}'; [Console]::Out.WriteLine($json)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-event-worker")
    }

    #[cfg(not(target_os = "windows"))]
    {
        WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","trace_id":"trace-event","event":"diagnostics.log","payload":{"stream":"stdout","line":"protocol event ready"}}'; printf '%s\n' "$json""#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-event-worker")
    }
}

fn test_stdio_blocking_event_worker_spec() -> WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","trace_id":"trace-event","event":"diagnostics.log","payload":{"stream":"stdout","line":"protocol event ready"}}'; [Console]::Out.WriteLine($json); Start-Sleep -Seconds 30"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-blocking-event-worker")
    }

    #[cfg(not(target_os = "windows"))]
    {
        WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","trace_id":"trace-event","event":"diagnostics.log","payload":{"stream":"stdout","line":"protocol event ready"}}'; printf '%s\n' "$json"; sleep 30"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-blocking-event-worker")
    }
}

fn test_stdio_agent_echo_worker_spec() -> WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$agent = [Console]::In.ReadLine(); $nativeReq = '{"protocol_version":"1","id":"worker-req-1","trace_id":"trace-worker","method":"workspace.list_files","params":{}}'; [Console]::Out.WriteLine($nativeReq); $nativeResp = [Console]::In.ReadLine() | ConvertFrom-Json; $agentObj = $agent | ConvertFrom-Json; $count = $nativeResp.result.Count; $echo = $agentObj.params.input; $final = @{ protocol_version = '1'; id = $agentObj.id; trace_id = $agentObj.trace_id; result = @{ ok = $true; echo = $echo; workspaceFileCount = $count } } | ConvertTo-Json -Compress -Depth 8; [Console]::Out.WriteLine($final)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
    }

    #[cfg(not(target_os = "windows"))]
    {
        WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"IFS= read -r agent; printf '%s\n' '{"protocol_version":"1","id":"worker-req-1","trace_id":"trace-worker","method":"workspace.list_files","params":{}}'; IFS= read -r native_resp; echo_value=$(printf '%s' "$agent" | sed -n 's/.*"input":"\([^"]*\)".*/\1/p'); printf '{"protocol_version":"1","id":"agent-req-1","trace_id":"trace-agent","result":{"ok":true,"echo":"%s","workspaceFileCount":1}}\n' "$echo_value""#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-echo-worker")
    }
}

fn test_stdio_agent_event_worker_spec() -> WorkerCommandSpec {
    #[cfg(target_os = "windows")]
    {
        WorkerCommandSpec::new(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    r#"$json = '{"protocol_version":"1","trace_id":"trace-agent-event","event":"agent.delta","payload":{"message":"starting"}}'; [Console]::Out.WriteLine($json)"#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-event-worker")
    }

    #[cfg(not(target_os = "windows"))]
    {
        WorkerCommandSpec::new(
                "sh",
                [
                    "-c",
                    r#"json='{"protocol_version":"1","trace_id":"trace-agent-event","event":"agent.delta","payload":{"message":"starting"}}'; printf '%s\n' "$json""#,
                ],
                PathBuf::from("."),
            )
            .with_label("stdio-agent-event-worker")
    }
}

fn wait_for_status(
    manager: &WorkerManager,
    predicate: impl Fn(&WorkerManagerStatus) -> bool,
) -> WorkerManagerStatus {
    for _ in 0..100 {
        let status = manager.status();
        if predicate(&status) {
            return status;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    manager.status()
}

fn worker_request_timeout() -> std::time::Duration {
    std::time::Duration::from_secs(15)
}

fn wait_for_diagnostics(
    manager: &WorkerManager,
    predicate: impl Fn(&[WorkerDiagnosticLine]) -> bool,
) -> Vec<WorkerDiagnosticLine> {
    for _ in 0..100 {
        let diagnostics = manager.status().diagnostics;
        if predicate(&diagnostics) {
            return diagnostics;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    manager.status().diagnostics
}

fn wait_for_events(
    events: &Arc<Mutex<Vec<WorkerManagerEvent>>>,
    predicate: impl Fn(&[WorkerManagerEvent]) -> bool,
) -> Vec<WorkerManagerEvent> {
    for _ in 0..30 {
        let snapshot = events.lock().expect("event log should lock").clone();
        if predicate(&snapshot) {
            return snapshot;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    events.lock().expect("event log should lock").clone()
}

fn has_diagnostic_line(diagnostics: &[WorkerDiagnosticLine], stream: &str, expected: &str) -> bool {
    diagnostics
        .iter()
        .any(|line| line.stream == stream && line.line.contains(expected))
}

fn has_diagnostics_event(events: &[WorkerManagerEvent], stream: &str, expected: &str) -> bool {
    events.iter().any(|event| {
        matches!(
            event,
            WorkerManagerEvent::Diagnostics(line)
                if line.stream == stream && line.line.contains(expected)
        )
    })
}

struct WorkspaceFixture {
    root: PathBuf,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-manager-rpc-{}-{}",
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
}

impl Drop for WorkspaceFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
