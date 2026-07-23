use super::*;

#[test]
fn workspace_write_consumes_matching_once_approval_grant() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::FsWorkspaceWrite,
        ]),
    );

    let denied = router.dispatch(&WorkerRequest::new(
        "req-write-denied",
        "trace-1",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "hello",
            "session_id": "session-1"
        }),
    ));
    let error = denied.error.expect("write without approval should fail");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["boundary"], "security");
    assert!(!fixture.root.join("notes").join("today.md").exists());

    approve_once(
        &mut router,
        "run-1",
        "session-1",
        json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md" }
        }),
        "filesystem_write",
        "medium",
        "File write/edit/delete tools can modify workspace state.",
    );

    let allowed = router.dispatch(&WorkerRequest::new(
        "req-write-allowed",
        "trace-3",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "hello",
            "session_id": "session-1"
        }),
    ));
    assert!(allowed.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "hello");

    let reused = router.dispatch(&WorkerRequest::new(
        "req-write-reused",
        "trace-4",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "changed",
            "session_id": "session-1"
        }),
    ));
    assert_eq!(
        reused.error.expect("once approval should be consumed").code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(fixture.read("notes/today.md"), "hello");
}

#[test]
fn workspace_write_allows_trusted_internal_operations_without_approval() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
    );

    let denied = router.dispatch(&WorkerRequest::new(
        "req-write-denied",
        "trace-1",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "agent write",
            "session_id": "session-1"
        }),
    ));
    assert_eq!(
        denied
            .error
            .expect("agent write should require approval")
            .code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert!(!fixture.root.join("notes").join("today.md").exists());

    let spoofed = router.dispatch(&WorkerRequest::new(
        "req-write-spoofed",
        "trace-2",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "spoofed write",
            "internal_operation": true
        }),
    ));
    assert_eq!(
        spoofed
            .error
            .expect("serialized internal flag must not bypass approval")
            .code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );

    let allowed = router.dispatch(
        &WorkerRequest::new(
            "req-write-internal",
            "trace-3",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "webui write"
            }),
        )
        .with_trusted_internal(),
    );
    assert!(allowed.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "webui write");
}

#[test]
fn shell_execute_requires_matching_approval_grant() {
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

    let error = response.error.expect("shell without approval should fail");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["boundary"], "security");
    assert_eq!(error.details["category"], "shell");
    assert!(error.details["fingerprint"]
        .as_str()
        .unwrap()
        .starts_with("exec:sha256:"));
    assert_eq!(error.details["effects"]["sandboxMode"], "unsandboxed");
    assert_eq!(error.details["effects"]["network"]["mode"], "unrestricted");
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
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
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
    approve_once(
        &mut router,
        "run-delete",
        "session-1",
        json!({
            "toolName": "delete_file",
            "arguments": { "path": "notes" }
        }),
        "filesystem_write",
        "medium",
        "File write/edit/delete tools can modify workspace state.",
    );
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
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    approve_once(
        &mut router,
        "run-shell",
        "session-1",
        json!({
            "toolName": "exec",
            "arguments": { "command": "echo tinybot" }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
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
    assert_eq!(result["blocked"], false);
    assert_eq!(result["sandbox_mode"], "unsandboxed_approved");
    assert_eq!(result["network_mode"], "unrestricted");
    assert_eq!(result["approval_decision"], "approved");
    assert!(result["content"].as_str().unwrap().contains("tinybot"));
    assert!(response.error.is_none());
}

#[test]
fn read_only_shell_approval_cannot_authorize_unsandboxed_execution() {
    let fixture = WorkspaceFixture::new();
    fixture.write("readable.txt", "readable-content");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = "type readable.txt & echo blocked>blocked.txt";
    approve_once(
        &mut router,
        "run-shell-read-only",
        "session-1",
        json!({
            "toolName": "exec",
            "arguments": {
                "command": command,
                "sandboxMode": "read_only",
                "networkMode": "unrestricted"
            }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

    let unsandboxed = router.dispatch(&WorkerRequest::new(
        "req-shell-unsandboxed",
        "trace-shell-read-only",
        "shell.execute",
        json!({
            "command": command,
            "sessionId": "session-1",
            "turnId": "run-shell-read-only"
        }),
    ));
    let error = unsandboxed
        .error
        .expect("read-only approval must not authorize unsandboxed execution");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["effects"]["sandboxMode"], "unsandboxed");

    let read_only = router.dispatch(&WorkerRequest::new(
        "req-shell-read-only",
        "trace-shell-read-only",
        "shell.execute",
        json!({
            "command": command,
            "sandboxMode": "read_only",
            "networkMode": "unrestricted",
            "sessionId": "session-1",
            "turnId": "run-shell-read-only"
        }),
    ));
    assert!(read_only.error.is_none(), "{read_only:?}");
    let result = read_only.result.unwrap();
    assert!(result["stdout"]
        .as_str()
        .unwrap()
        .contains("readable-content"));
    assert_ne!(result["exit_code"], 0);
    assert_eq!(
        result["sandbox_mode"],
        "windows_restricted_low_integrity_read_only"
    );
    assert_eq!(result["network_mode"], "unrestricted");
    assert_eq!(result["approval_decision"], "approved");
    assert!(!fixture.root.join("blocked.txt").exists());
}

#[test]
fn dispatches_owned_shell_process_lifecycle() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = blocking_shell_command_with_marker();
    approve_once(
        &mut router,
        "run-shell-process",
        "session-shell-process",
        json!({
            "toolName": "exec_command",
            "arguments": { "command": command.clone() }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

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
    assert_eq!(started["sandboxMode"], "unsandboxed_approved");
    assert_eq!(started["networkMode"], "unrestricted");
    assert_eq!(started["approvalDecision"], "approved");
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
fn tool_executor_injects_turn_ownership_into_exec_command() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = blocking_shell_command_with_marker();
    approve_once(
        &mut router,
        "run-exec-command",
        "session-exec-command",
        json!({
            "toolName": "exec_command",
            "arguments": { "command": command.clone() }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

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
    let started = first_router.dispatch(
        &WorkerRequest::new(
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
        )
        .with_trusted_internal(),
    );
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
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = blocking_shell_command_with_marker();
    approve_once(
        &mut router,
        "run-shell-cancel",
        "session-1",
        json!({
            "toolName": "exec",
            "arguments": { "command": command.clone() }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

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
                "turnId": "run-shell-cancel"
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
