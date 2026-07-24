use super::{
    finish_native_agent_turn, native_approval_continuation_spec, pending_approvals_from_checkpoint,
};

#[test]
fn pending_approvals_preserve_runtime_tool_approval_id() {
    let checkpoint = serde_json::json!({
        "phase": "awaiting_approval",
        "turnId": "turn-deferred-write",
        "sessionId": "session-deferred-write",
        "payload": {
            "kind": "tool_approval",
            "approvalId": "approval:turn-deferred-write:call-write",
            "operation": {
                "toolCallId": "call-write",
                "toolName": "workspace.write_file",
                "arguments": {
                    "path": "notes.txt",
                    "contents": "hello"
                }
            }
        }
    });

    let approvals = pending_approvals_from_checkpoint(Some(&checkpoint));

    assert_eq!(approvals.len(), 1);
    assert_eq!(
        approvals[0]["id"],
        "approval:turn-deferred-write:call-write"
    );
    assert_eq!(approvals[0]["tool_name"], "workspace.write_file");
}

#[test]
fn approval_continuation_preserves_checkpoint_trace_context() {
    let checkpoint = serde_json::json!({
        "phase": "awaiting_approval",
        "turnId": "turn-traced-approval",
        "sessionId": "session-traced-approval",
        "traceContext": {
            "requestId": "request-traced-approval",
            "traceId": "trace-traced-approval",
            "turnId": "turn-traced-approval",
            "threadId": "thread-traced-approval"
        },
        "payload": { "operation": { "toolName": "workspace.write_file" } }
    });

    let continuation = native_approval_continuation_spec(
        &checkpoint,
        &serde_json::json!({ "scope": "once", "commandId": "command-approval-1" }),
        "approval-traced",
        true,
    );

    assert_eq!(continuation["traceContext"], checkpoint["traceContext"]);
    assert_eq!(continuation["metadata"]["commandId"], "command-approval-1");
}

#[test]
fn continuation_turn_reports_both_runtime_and_flush_failures() {
    let error = finish_native_agent_turn::<()>(
        Err("runtime failed".to_string()),
        Err("flush failed".to_string()),
        "native agent continuation",
    )
    .expect_err("both failures should be reported");

    assert_eq!(
        error,
        "native agent continuation failed: runtime failed; trace persistence flush failed: \
             flush failed"
    );
}
