use super::*;

#[test]
fn workspace_write_executes() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-write",
        "trace-1",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "hello",
            "session_id": "session-1"
        }),
    ));
    assert!(response.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "hello");

    let second = router.dispatch(&WorkerRequest::new(
        "req-write-again",
        "trace-4",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "changed",
            "session_id": "session-1"
        }),
    ));
    assert!(second.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "changed");
}

#[test]
fn workspace_write_does_not_need_an_internal_trust_marker() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-write",
        "trace-1",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "agent write",
            "session_id": "session-1"
        }),
    ));
    assert!(response.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "agent write");
}

#[test]
fn shell_execute_runs() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-shell-denied",
        "trace-1",
        "shell.execute",
        json!({
            "command": "echo tinybot",
            "working_dir": ".",
            "timeout": 30,
            "session_id": "session-1"
        }),
    ));

    assert!(response.error.is_none());
    assert_eq!(response.result.as_ref().unwrap()["exit_code"], 0);
    assert!(response.result.as_ref().unwrap()["content"]
        .as_str()
        .unwrap()
        .contains("tinybot"));
}

#[test]
fn dispatches_workspace_list_dir_and_delete_file_requests() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "hello");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::FsWorkspaceWrite,
        ]),
    );

    let list_response = router.dispatch(&WorkerRequest::new(
        "req-list",
        "trace-1",
        "workspace.list_dir",
        json!({ "path": ".", "recursive": true, "max_entries": 10 }),
    ));
    let delete_response = router.dispatch(&WorkerRequest::new(
        "req-delete",
        "trace-1",
        "workspace.delete_file",
        json!({ "path": "notes", "recursive": true, "session_id": "session-1" }),
    ));

    assert_eq!(
        list_response.result.as_ref().unwrap()["entries"][0]["path"],
        "notes/"
    );
    assert_eq!(
        list_response.result.as_ref().unwrap()["entries"][1]["path"],
        "notes/today.md"
    );
    assert_eq!(
        delete_response.result,
        Some(json!({ "path": "notes", "kind": "dir", "deleted": true }))
    );
    assert!(list_response.error.is_none());
    assert!(delete_response.error.is_none());
}

#[test]
fn dispatches_shell_execute_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-shell",
        "trace-1",
        "shell.execute",
        json!({
            "command": "echo tinybot",
            "working_dir": ".",
            "timeout": 5,
            "session_id": "session-1"
        }),
    ));

    let result = response.result.expect("shell.execute should return result");
    assert_eq!(result["exit_code"], 0);
    assert_eq!(result["timed_out"], false);
    assert!(result["content"].as_str().unwrap().contains("tinybot"));
    assert!(response.error.is_none());
}

#[test]
fn removed_shell_sandbox_fields_do_not_restrict_execution() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );
    let command = "echo runs-with-current-user-permissions";

    let response = router.dispatch(&WorkerRequest::new(
        "req-shell-legacy-fields",
        "trace-shell-read-only",
        "shell.execute",
        json!({
            "command": command,
            "sandboxMode": "unsandboxed",
            "networkMode": "unrestricted",
            "sessionId": "session-1",
            "turnId": "turn-shell-read-only"
        }),
    ));
    assert!(response.error.is_none());
    assert_eq!(response.result.as_ref().unwrap()["exit_code"], 0);
    assert_eq!(router.shell.active_process_count(), 0);
}

#[test]
fn dispatches_owned_shell_process_lifecycle() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );
    let command = blocking_shell_command_with_marker();
    let started = router.dispatch(&WorkerRequest::new(
        "req-shell-start",
        "trace-shell-process",
        "shell.start",
        json!({
            "command": command,
            "workingDir": ".",
            "yieldTimeMs": 0,
            "tty": false,
            "sessionId": "session-shell-process",
            "turnId": "turn-shell-process",
            "toolCallId": "tool-shell-process"
        }),
    ));
    let started = started.result.expect("shell.start should return a process");
    assert_eq!(started["running"], true, "{started:?}");
    assert_eq!(started["ownerId"], "turn-shell-process");
    assert_eq!(started["toolCallId"], "tool-shell-process");
    let process_id = started["processId"]
        .as_str()
        .expect("shell process id should be present")
        .to_string();

    let wrong_owner = router.dispatch(&WorkerRequest::new(
        "req-shell-poll-wrong-owner",
        "trace-shell-process",
        "shell.poll",
        json!({ "processId": process_id, "cursor": 0, "yieldTimeMs": 0 }),
    ));
    let error = wrong_owner
        .error
        .expect("ownerless poll must not access an owned process");
    assert!(error.message.contains("owner does not match"));

    let listed = router.dispatch(&WorkerRequest::new(
        "req-shell-list",
        "trace-shell-process",
        "shell.list",
        json!({ "ownerId": "turn-shell-process" }),
    ));
    let listed = listed
        .result
        .expect("shell.list should return owned processes");
    assert_eq!(listed.as_array().map(Vec::len), Some(1), "{listed:?}");
    assert_eq!(listed[0]["processId"], process_id);

    let terminated = router.dispatch(&WorkerRequest::new(
        "req-shell-terminate",
        "trace-shell-process",
        "shell.terminate",
        json!({
            "processId": process_id,
            "ownerId": "turn-shell-process"
        }),
    ));
    let terminated = terminated
        .result
        .expect("shell.terminate should return the final process snapshot");
    assert_eq!(terminated["status"], "terminated", "{terminated:?}");
    assert_eq!(terminated["running"], false);
}

#[test]
fn tool_executor_injects_turn_ownership_into_retained_shell_calls() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );
    let command = blocking_shell_command_with_marker();
    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-exec-command",
        "trace-tool-exec-command",
        "tool_executor.execute",
        json!({
            "toolId": "exec_command",
            "arguments": {
                "command": command,
                "workingDir": ".",
                "yieldTimeMs": 0,
                "tty": false,
                "sessionId": "spoofed-session",
                "ownerId": "spoofed-owner",
                "toolCallId": "spoofed-tool-call"
            },
            "sessionId": "session-exec-command",
            "turnId": "turn-exec-command",
            "toolCallId": "tool-exec-command"
        }),
    ));
    let result = response
        .result
        .expect("exec_command should dispatch through tool executor");
    let process = &result["result"];
    assert_eq!(process["ownerId"], "turn-exec-command", "{result:?}");
    assert_eq!(process["toolCallId"], "tool-exec-command", "{result:?}");
    let process_id = process["processId"]
        .as_str()
        .expect("retained process id should be present")
        .to_string();

    let written = router.dispatch(&WorkerRequest::new(
        "req-tool-write-stdin",
        "trace-tool-exec-command",
        "tool_executor.execute",
        json!({
            "toolId": "write_stdin",
            "arguments": {
                "processId": process_id,
                "input": "",
                "yieldTimeMs": 0
            },
            "sessionId": "session-exec-command",
            "turnId": "turn-exec-command",
            "toolCallId": "tool-write-stdin"
        }),
    ));
    assert!(
        written.error.is_none(),
        "write_stdin should dispatch through tool executor: {:?}",
        written.error
    );
    let written = written.result.expect("write_stdin should return a result");
    assert_eq!(written["result"]["processId"], process_id, "{written:?}");
    assert_eq!(written["result"]["running"], true, "{written:?}");

    let terminated = router.dispatch(&WorkerRequest::new(
        "req-tool-exec-command-terminate",
        "trace-tool-exec-command",
        "shell.terminate",
        json!({
            "processId": process_id,
            "ownerId": "turn-exec-command"
        }),
    ));
    assert_eq!(terminated.result.as_ref().unwrap()["status"], "terminated");
    assert!(terminated.error.is_none());
}

#[test]
fn shared_shell_runtime_survives_router_reconstruction() {
    let fixture = WorkspaceFixture::new();
    let shell_runtime = WorkerShellRuntime::default();
    let policy = CapabilityPolicy::new([WorkerCapability::ShellExecute]);
    let mut first_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone())
            .with_shell_runtime(shell_runtime.clone());
    let command = blocking_shell_command_with_marker();
    let started = first_router.dispatch(&WorkerRequest::new(
        "req-shared-shell-start",
        "trace-shared-shell",
        "shell.start",
        json!({
            "command": command,
            "workingDir": ".",
            "yieldTimeMs": 0,
            "sessionId": "session-shared-shell",
            "turnId": "turn-shared-shell",
            "toolCallId": "tool-shared-shell"
        }),
    ));
    let process_id = started.result.as_ref().unwrap()["processId"]
        .as_str()
        .expect("shared process id should be present")
        .to_string();
    drop(first_router);

    let mut second_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy)
            .with_shell_runtime(shell_runtime);
    let polled = second_router.dispatch(&WorkerRequest::new(
        "req-shared-shell-poll",
        "trace-shared-shell",
        "shell.poll",
        json!({
            "processId": process_id,
            "ownerId": "turn-shared-shell",
            "cursor": 0,
            "yieldTimeMs": 0
        }),
    ));
    assert_eq!(polled.result.as_ref().unwrap()["running"], true);

    let terminated = second_router.dispatch(&WorkerRequest::new(
        "req-shared-shell-terminate",
        "trace-shared-shell",
        "shell.terminate",
        json!({
            "processId": process_id,
            "ownerId": "turn-shared-shell"
        }),
    ));
    assert_eq!(terminated.result.as_ref().unwrap()["status"], "terminated");
    assert!(terminated.error.is_none());
}

#[test]
fn tool_executor_forwards_request_cancellation_to_shell_execute() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );
    let command = blocking_shell_command_with_marker();
    let cancellation = Arc::new(TestCancellation::default());
    let request = WorkerRequest::new(
        "req-tool-shell-cancel",
        "trace-tool-shell-cancel",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "arguments": {
                "command": command,
                "working_dir": ".",
                "timeout": 30,
                "sessionId": "session-1",
                "turnId": "turn-shell-cancel"
            }
        }),
    )
    .with_cancellation(Some(cancellation.clone()));

    let started = std::time::Instant::now();
    let marker = fixture.root.join("started.txt");
    let handle = thread::spawn(move || router.dispatch(&request));
    while !marker.exists() {
        if handle.is_finished() {
            let response = handle
                .join()
                .expect("tool executor dispatch should not panic");
            panic!("tool executor shell command finished before marker: {response:?}");
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "tool executor shell command should create started marker"
        );
        thread::sleep(Duration::from_millis(20));
    }
    cancellation.cancel();

    let response = handle
        .join()
        .expect("tool executor dispatch should not panic");
    let result = response
        .result
        .expect("cancelled tool executor shell command should return result");
    assert!(response.error.is_none());
    assert_eq!(result["result"]["cancelled"], true);
    assert_eq!(result["result"]["timed_out"], false);
    assert!(result["result"]["content"]
        .as_str()
        .unwrap()
        .contains("aborted by user"));
}
