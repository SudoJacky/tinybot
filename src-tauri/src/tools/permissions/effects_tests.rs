use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::tools::registry::WorkerToolRegistryRpc;
use serde_json::json;

#[test]
fn shell_effects_distinguish_unsandboxed_and_read_only_requests() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::ShellExecute,
        WorkerCapability::ApprovalRequest,
    ]));
    let tool = registry
        .get_tool("exec_command")
        .expect("exec_command should be registered");

    let unsandboxed = normalize_tool_effects(&tool, &json!({ "command": "echo hi", "tty": true }))
        .expect("default shell effects should normalize");
    let read_only = normalize_tool_effects(
        &tool,
        &json!({
            "command": "echo hi",
            "sandboxMode": "read_only",
            "networkMode": "unrestricted",
            "tty": false
        }),
    )
    .expect("read-only shell effects should normalize");

    assert_eq!(
        unsandboxed.sandbox_mode,
        Some(ShellSandboxMode::Unsandboxed)
    );
    assert_eq!(
        unsandboxed.filesystem.write_roots,
        vec!["filesystem://unrestricted"]
    );
    assert_eq!(
        unsandboxed.filesystem.read_roots,
        vec!["filesystem://unrestricted"]
    );
    assert_eq!(
        unsandboxed.network.mode,
        PermissionNetworkMode::Unrestricted
    );
    assert!(unsandboxed.process.execute);
    assert!(unsandboxed.process.interactive);
    assert!(unsandboxed.environment.inherit);
    assert_eq!(read_only.sandbox_mode, Some(ShellSandboxMode::ReadOnly));
    #[cfg(target_os = "windows")]
    assert_eq!(
        read_only.filesystem.write_roots,
        vec!["windows://low-integrity"]
    );
    #[cfg(not(target_os = "windows"))]
    assert!(read_only.filesystem.write_roots.is_empty());
    assert!(!read_only.process.interactive);
    assert_ne!(
        permission_fingerprint("start", "echo hi", &unsandboxed),
        permission_fingerprint("start", "echo hi", &read_only)
    );
}

#[test]
fn shell_effects_reject_unknown_sandbox_or_network_modes() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::ShellExecute,
        WorkerCapability::ApprovalRequest,
    ]));
    let tool = registry.get_tool("exec_command").unwrap();

    let sandbox_error = normalize_tool_effects(
        &tool,
        &json!({ "command": "echo hi", "sandboxMode": "pretend" }),
    )
    .expect_err("unknown sandbox mode must fail");
    assert!(sandbox_error.message.contains("sandboxMode"));

    let network_error = normalize_tool_effects(
        &tool,
        &json!({ "command": "echo hi", "networkMode": "sometimes" }),
    )
    .expect_err("unknown network mode must fail");
    assert!(network_error.message.contains("networkMode"));
}

#[test]
fn approval_fingerprint_preserves_semantic_internal_whitespace() {
    let effects = shell_permission_effects(
        ShellSandboxMode::Unsandboxed,
        PermissionNetworkMode::Unrestricted,
        false,
    );

    assert_ne!(
        permission_fingerprint("exec", "printf \"a  b\"", &effects),
        permission_fingerprint("exec", "printf \"a b\"", &effects)
    );
    assert_eq!(
        permission_fingerprint("apply_patch", "line one\r\nline two\r\n", &effects),
        permission_fingerprint("apply_patch", "line one\nline two\n", &effects)
    );

    let mut one_value = effects.clone();
    one_value.mcp = vec!["server.tool,other.value".to_string()];
    let mut two_values = effects;
    two_values.mcp = vec!["server.tool".to_string(), "other.value".to_string()];
    assert_ne!(
        permission_fingerprint("mcp", "server.tool", &one_value),
        permission_fingerprint("mcp", "server.tool", &two_values)
    );
}

#[test]
fn mcp_and_subagent_effects_are_explicit() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::McpCall,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionWrite,
    ]));
    let mcp = registry.get_tool("mcp.call_tool").unwrap();
    let subagent = registry.get_tool("subagent.spawn").unwrap();

    let mcp_effects = normalize_tool_effects(
        &mcp,
        &json!({ "server": "docs", "tool": "search", "arguments": {} }),
    )
    .expect("MCP effects should normalize");
    assert_eq!(mcp_effects.network.mode, PermissionNetworkMode::Configured);
    assert_eq!(mcp_effects.network.destinations, vec!["mcp://docs"]);
    assert_eq!(mcp_effects.mcp, vec!["docs.search"]);

    let subagent_effects =
        normalize_tool_effects(&subagent, &json!({})).expect("subagent effects should normalize");
    assert!(subagent_effects.mutates_session);
    assert!(subagent_effects.mutates_background);
}

#[test]
fn approval_request_serializes_effects_and_binds_them_to_the_fingerprint() {
    let policy = CapabilityPolicy::new([
        WorkerCapability::ShellExecute,
        WorkerCapability::ApprovalRequest,
    ]);
    let registry = WorkerToolRegistryRpc::new(policy.clone());
    let profile = WorkerPermissionProfileRpc::new(policy);
    let tool = registry.get_tool("exec_command").unwrap();

    let unsandboxed = profile
        .evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: "exec_command".to_string(),
                arguments: json!({ "command": "echo Hi" }),
                session_id: Some("session-1".to_string()),
                turn_id: Some("run-1".to_string()),
            },
        )
        .expect("unsandboxed request should normalize");
    let read_only = profile
        .evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: "exec_command".to_string(),
                arguments: json!({
                    "command": "echo Hi",
                    "sandboxMode": "read_only",
                    "networkMode": "unrestricted"
                }),
                session_id: Some("session-1".to_string()),
                turn_id: Some("run-1".to_string()),
            },
        )
        .expect("read-only request should normalize");

    let unsandboxed_approval = unsandboxed.approval_request.unwrap();
    let read_only_approval = read_only.approval_request.unwrap();
    assert_eq!(
        unsandboxed_approval.operation["effects"],
        serde_json::to_value(&unsandboxed_approval.effects).unwrap()
    );
    assert_eq!(
        read_only_approval.operation["effects"],
        serde_json::to_value(&read_only_approval.effects).unwrap()
    );
    assert_ne!(
        unsandboxed_approval.fingerprint,
        read_only_approval.fingerprint
    );
    assert!(unsandboxed_approval
        .fingerprint
        .starts_with("start:sha256:"));
}

#[test]
fn evaluate_tool_fails_closed_for_an_invalid_effect_request() {
    let policy = CapabilityPolicy::new([
        WorkerCapability::ShellExecute,
        WorkerCapability::ApprovalRequest,
    ]);
    let registry = WorkerToolRegistryRpc::new(policy.clone());
    let profile = WorkerPermissionProfileRpc::new(policy);
    let tool = registry.get_tool("exec_command").unwrap();

    let error = profile
        .evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: "exec_command".to_string(),
                arguments: json!({
                    "command": "echo hi",
                    "sandboxMode": "imaginary"
                }),
                session_id: None,
                turn_id: None,
            },
        )
        .expect_err("invalid sandbox requests must not produce an approval");

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert_eq!(error.details["sandboxMode"], "imaginary");
}
