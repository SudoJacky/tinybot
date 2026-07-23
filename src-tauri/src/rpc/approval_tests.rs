use super::*;
use serde_json::json;

fn approval_rpc() -> WorkerApprovalRpc {
    WorkerApprovalRpc::new(CapabilityPolicy::new([
        WorkerCapability::ApprovalRequest,
        WorkerCapability::ApprovalResolve,
    ]))
}

fn approval_request(
    request_id: &'static str,
    turn_id: &str,
    session_id: &str,
    mut operation: Value,
    _legacy_fingerprint: &str,
    _legacy_session_fingerprint: &str,
) -> WorkerRequest {
    let path = operation["arguments"]["path"]
        .as_str()
        .expect("workspace approval fixture should include a path")
        .to_string();
    let effects = operation
        .get("effects")
        .cloned()
        .map(serde_json::from_value::<PermissionEffects>)
        .transpose()
        .expect("fixture effects should deserialize")
        .unwrap_or_else(|| workspace_write_permission_effects(&path));
    operation.as_object_mut().unwrap().insert(
        "effects".to_string(),
        serde_json::to_value(&effects).unwrap(),
    );
    let fingerprint =
        permission_fingerprint("write_file", &normalize_approval_path(&path), &effects);
    WorkerRequest::new(
        request_id,
        "trace-1",
        "approval.request",
        json!({
            "turn_id": turn_id,
            "session_id": session_id,
            "operation": operation,
            "classification": {
                "category": "filesystem_write",
                "risk": "medium",
                "reason": "File write/edit/delete tools can modify workspace state."
            },
            "effects": effects,
            "fingerprint": fingerprint,
            "session_fingerprint": fingerprint,
            "summary": "write_file path=\"notes/today.md\""
        }),
    )
}

#[test]
fn approval_request_returns_pending_record() {
    let operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
    });
    let mut approval =
        WorkerApprovalRpc::new(CapabilityPolicy::new([WorkerCapability::ApprovalRequest]));
    let request = approval_request(
        "req-1",
        "turn-1",
        "session-1",
        operation.clone(),
        "write_file:notes/today.md",
        "write_file:notes/today.md",
    );

    let result = approval
        .request_from_request(&request)
        .expect("approval request should return result");

    assert_eq!(result["content"], "Waiting for approval.");
    assert_eq!(result["awaitingUserInput"], true);
    assert_eq!(result["stopReason"], "awaiting_approval");
    assert!(result["approvalId"]
        .as_str()
        .unwrap()
        .starts_with("approval-"));
    assert_eq!(result["operation"]["toolName"], operation["toolName"]);
    assert_eq!(result["operation"]["arguments"], operation["arguments"]);
    assert_eq!(result["operation"]["effects"], result["effects"]);
    assert_eq!(result["turnId"], "turn-1");
    assert_eq!(result["sessionId"], "session-1");
    assert_eq!(result["category"], "filesystem_write");
    assert_eq!(result["risk"], "medium");
    assert_eq!(
        result["reason"],
        "Workspace file changes require user approval."
    );
    assert_eq!(result["summary"], "write_file path=\"notes/today.md\"");
    assert!(result["fingerprint"]
        .as_str()
        .unwrap()
        .starts_with("write_file:sha256:"));
    assert_eq!(result["sessionFingerprint"], result["fingerprint"]);
}

#[test]
fn approval_resolve_returns_stored_pending_operation() {
    let operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
        "toolCallId": "call-1"
    });
    let mut approval = approval_rpc();
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
    let response = approval
        .resolve_from_request(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "session"
            }),
        ))
        .unwrap();

    assert_eq!(response["approvalId"], approval_id);
    assert_eq!(response["approved"], true);
    assert_eq!(response["scope"], "session");
    assert_eq!(response["status"], "approved");
    assert_eq!(response["sessionId"], "session-1");
    assert_eq!(response["operation"]["toolName"], operation["toolName"]);
    assert_eq!(response["operation"]["arguments"], operation["arguments"]);
    assert_eq!(response["operation"]["effects"], response["effects"]);
    assert_eq!(response["category"], "filesystem_write");
    assert_eq!(response["risk"], "medium");
    assert_eq!(
        response["reason"],
        "Workspace file changes require user approval."
    );
    assert_eq!(response["summary"], "write_file path=\"notes/today.md\"");
    assert_eq!(response["sessionFingerprint"], response["fingerprint"]);
}

#[test]
fn approval_resolve_matches_websocket_session_key_case_insensitively() {
    let operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
        "toolCallId": "call-1"
    });
    let mut approval = approval_rpc();
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "WebSocket:chat-1",
            operation,
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();

    let response = approval
        .resolve_from_request(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "websocket:chat-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ))
        .unwrap();

    assert_eq!(response["status"], "approved");
    assert_eq!(response["sessionId"], "websocket:chat-1");
}

#[test]
fn approval_list_pending_matches_websocket_session_key_case_insensitively() {
    let operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
        "toolCallId": "call-1"
    });
    let mut approval = approval_rpc();
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "WebSocket:chat-1",
            operation,
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();

    let response = approval
        .list_pending_from_request(&WorkerRequest::new(
            "req-list",
            "trace-1",
            "approval.list_pending",
            json!({ "session_id": "websocket:chat-1" }),
        ))
        .unwrap();

    assert_eq!(response["approvals"][0]["id"], approval_id);
}

#[test]
fn approval_session_scope_matches_websocket_session_key_case_insensitively() {
    let operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
        "toolCallId": "call-1"
    });
    let mut approval = approval_rpc();
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "WebSocket:chat-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
    approval
        .resolve_from_request(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "websocket:chat-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "session"
            }),
        ))
        .unwrap();

    let response = approval
        .request_from_request(&approval_request(
            "req-request-again",
            "turn-2",
            "websocket:chat-1",
            operation,
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();

    assert_eq!(response["status"], "approved");
    assert_eq!(response["scope"], "session");
}

#[test]
fn approval_list_pending_returns_session_scoped_records() {
    let operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
        "toolCallId": "call-1"
    });
    let mut approval = approval_rpc();
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request-1",
            "turn-1",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
    approval
        .request_from_request(&approval_request(
            "req-request-2",
            "turn-2",
            "session-2",
            operation,
            "write_file:notes/other.md",
            "write_file:notes/other.md",
        ))
        .unwrap();

    let response = approval
        .list_pending_from_request(&WorkerRequest::new(
            "req-list",
            "trace-1",
            "approval.list_pending",
            json!({ "session_id": "session-1" }),
        ))
        .unwrap();

    assert_eq!(response["sessionId"], "session-1");
    assert_eq!(response["approvals"].as_array().map(Vec::len), Some(1));
    let pending = &response["approvals"][0];
    assert_eq!(pending["id"], approval_id);
    assert_eq!(pending["turnId"], "turn-1");
    assert_eq!(pending["sessionId"], "session-1");
    assert_eq!(pending["operation"]["toolName"], "write_file");
    assert_eq!(
        pending["operation"]["arguments"],
        json!({ "path": "notes/today.md", "contents": "hello" })
    );
    assert_eq!(pending["operation"]["effects"], pending["effects"]);
    assert_eq!(pending["category"], "filesystem_write");
    assert_eq!(pending["risk"], "medium");
    assert_eq!(pending["sessionFingerprint"], pending["fingerprint"]);
}

#[test]
fn approval_resolve_rejects_missing_pending_request() {
    let mut approval =
        WorkerApprovalRpc::new(CapabilityPolicy::new([WorkerCapability::ApprovalResolve]));

    let error = approval
        .resolve_from_request(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": "approval-1",
                "approved": true,
                "scope": "session"
            }),
        ))
        .expect_err("missing pending approval should fail");

    assert_eq!(error.message, "pending approval not found");
}

#[test]
fn approval_once_scope_is_consumed_by_next_matching_request() {
    let operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
        "toolCallId": "call-1"
    });
    let mut approval = approval_rpc();
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
    approval
        .resolve_from_request(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ))
        .unwrap();

    let allowed = approval
        .request_from_request(&approval_request(
            "req-allowed",
            "turn-2",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    assert_eq!(allowed["decision"], "allow");
    assert_eq!(allowed["scope"], "once");
    assert_eq!(allowed["operation"]["toolName"], operation["toolName"]);
    assert_eq!(allowed["operation"]["arguments"], operation["arguments"]);
    assert_eq!(allowed["operation"]["effects"], allowed["effects"]);

    let pending_again = approval
        .request_from_request(&approval_request(
            "req-pending-again",
            "turn-3",
            "session-1",
            operation,
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ))
        .unwrap();
    assert_eq!(pending_again["stopReason"], "awaiting_approval");
    assert_eq!(pending_again["awaitingUserInput"], true);
}

#[test]
fn approval_session_scope_allows_matching_session_fingerprint_only_in_same_session() {
    let mut approval = approval_rpc();
    let original_operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "hello" },
        "toolCallId": "call-1"
    });
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "session-1",
            original_operation,
            "write_file:notes/today.md:hello",
            "write_file:notes/today.md",
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
    approval
        .resolve_from_request(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "session"
            }),
        ))
        .unwrap();

    let changed_operation = json!({
        "toolName": "write_file",
        "arguments": { "path": "notes/today.md", "contents": "changed" },
        "toolCallId": "call-2"
    });
    let allowed = approval
        .request_from_request(&approval_request(
            "req-allowed",
            "turn-2",
            "session-1",
            changed_operation.clone(),
            "write_file:notes/today.md:changed",
            "write_file:notes/today.md",
        ))
        .unwrap();
    assert_eq!(allowed["decision"], "allow");
    assert_eq!(allowed["scope"], "session");
    assert_eq!(
        allowed["operation"]["toolName"],
        changed_operation["toolName"]
    );
    assert_eq!(
        allowed["operation"]["arguments"],
        changed_operation["arguments"]
    );
    assert_eq!(allowed["operation"]["effects"], allowed["effects"]);

    let other_session = approval
        .request_from_request(&approval_request(
            "req-other-session",
            "turn-3",
            "session-2",
            changed_operation,
            "write_file:notes/today.md:changed",
            "write_file:notes/today.md",
        ))
        .unwrap();
    assert_eq!(other_session["stopReason"], "awaiting_approval");
    assert_eq!(other_session["awaitingUserInput"], true);
}

#[test]
fn sensitive_operation_requires_matching_approval_grant() {
    let mut approval = approval_rpc();
    let requirement = workspace_write_approval(
        "notes/today.md",
        Some("session-1".to_string()),
        Some("turn-write".to_string()),
    );
    let record = requirement.to_record();
    let error = approval
        .require_sensitive_operation(requirement.clone())
        .expect_err("write without approval should fail");
    assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
    assert_eq!(error.details["boundary"], "security");

    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "session-1",
            record.operation,
            &record.fingerprint,
            &record.session_fingerprint,
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
    approval
        .resolve_from_request(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ))
        .unwrap();

    approval
        .require_sensitive_operation(requirement)
        .expect("matching once approval should be consumed");
}

#[test]
fn sensitive_operation_accepts_current_turn_after_once_request_allows() {
    let mut approval = approval_rpc();
    let requirement = workspace_write_approval(
        "notes/today.md",
        Some("session-1".to_string()),
        Some("turn-1".to_string()),
    );
    let record = requirement.to_record();
    let request_response = approval
        .request_from_request(&approval_request(
            "req-request",
            "turn-1",
            "session-1",
            record.operation.clone(),
            &record.fingerprint,
            &record.session_fingerprint,
        ))
        .unwrap();
    let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
    approval
        .resolve_from_request(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ))
        .unwrap();

    let allowed = approval
        .request_from_request(&approval_request(
            "req-allowed",
            "turn-1",
            "session-1",
            record.operation,
            &record.fingerprint,
            &record.session_fingerprint,
        ))
        .unwrap();
    assert_eq!(allowed["decision"], "allow");
    assert_eq!(allowed["scope"], "once");

    approval
        .require_sensitive_operation(requirement.clone())
        .expect("same-turn native operation should use the consumed once approval");

    approval
        .require_sensitive_operation(requirement)
        .expect_err("same-turn once bridge should be consumed");
}

#[test]
fn workspace_write_approval_derives_fingerprint_from_actual_effects() {
    let requirement = workspace_write_approval(
        "notes/today.md",
        Some("session-1".to_string()),
        Some("turn-1".to_string()),
    );
    let record = requirement.to_record();

    assert!(record.fingerprint.starts_with("write_file:sha256:"));
    assert_eq!(record.session_fingerprint, record.fingerprint);
    assert_eq!(
        record.effects.unwrap()["filesystem"]["writeRoots"],
        json!(["workspace://current/notes/today.md"])
    );
}

#[test]
fn approval_request_rejects_a_fingerprint_not_bound_to_operation_effects() {
    let effects = workspace_write_permission_effects("notes/today.md");
    let mut approval = approval_rpc();
    let error = approval
        .request_from_request(&WorkerRequest::new(
            "req-forged-fingerprint",
            "trace-1",
            "approval.request",
            json!({
                "turn_id": "turn-1",
                "session_id": "session-1",
                "operation": {
                    "toolName": "write_file",
                    "arguments": { "path": "notes/today.md" },
                    "effects": effects
                },
                "classification": {
                    "category": "filesystem_write",
                    "risk": "medium",
                    "reason": "Workspace file changes require user approval."
                },
                "effects": effects,
                "fingerprint": "write_file:notes/other.md:effects:forged",
                "session_fingerprint": "write_file:notes/other.md:effects:forged"
            }),
        ))
        .expect_err("forged approval fingerprints must fail before user presentation");

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert!(error.message.contains("fingerprint"));
}

#[test]
fn approval_request_normalizes_known_tool_risk_scope_and_lifetime() {
    let effects = shell_permission_effects(
        ShellSandboxMode::Unsandboxed,
        PermissionNetworkMode::Unrestricted,
        false,
    );
    let fingerprint = permission_fingerprint("exec", "echo hi", &effects);
    let mut approval = approval_rpc();
    let result = approval
        .request_from_request(&WorkerRequest::new(
            "req-normalized-presentation",
            "trace-1",
            "approval.request",
            json!({
                "turn_id": "turn-1",
                "session_id": "session-1",
                "operation": {
                    "toolName": "exec",
                    "arguments": { "command": "echo hi" },
                    "effects": effects
                },
                "classification": {
                    "category": "tool",
                    "risk": "low",
                    "reason": "Caller supplied presentation"
                },
                "effects": effects,
                "fingerprint": fingerprint,
                "session_fingerprint": fingerprint,
                "summary": "harmless"
            }),
        ))
        .expect("valid effect-bound request should be presented");

    assert_eq!(result["category"], "shell");
    assert_eq!(result["risk"], "high");
    assert_eq!(result["reason"], "Shell execution requires user approval.");
    assert_eq!(result["summary"], "exec command=\"echo hi\"");
    assert_eq!(result["scope"], "command");
    assert_eq!(result["lifetime"], "per_request");
}
