use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::tools::registry::WorkerToolRegistryRpc;
use serde_json::json;

#[test]
fn shell_effects_are_current_user_and_ignore_removed_sandbox_fields() {
    let registry =
        WorkerToolRegistryRpc::new(CapabilityPolicy::new([WorkerCapability::ShellExecute]));
    let tool = registry
        .get_tool("exec_command")
        .expect("exec_command should be registered");

    let effects = normalize_tool_effects(
        &tool,
        &json!({
            "command": "echo hi",
            "sandboxMode": "read_only",
            "networkMode": "denied",
            "tty": true
        }),
    )
    .expect("legacy sandbox fields must not constrain execution");

    assert_eq!(
        effects.filesystem.read_roots,
        vec!["filesystem://unrestricted"]
    );
    assert_eq!(
        effects.filesystem.write_roots,
        vec!["filesystem://unrestricted"]
    );
    assert_eq!(effects.network.mode, PermissionNetworkMode::Unrestricted);
    assert_eq!(effects.network.destinations, vec!["network://unrestricted"]);
    assert!(effects.process.execute);
    assert!(effects.process.interactive);
    assert!(effects.environment.inherit);
}

#[test]
fn approval_fingerprint_preserves_semantic_internal_whitespace() {
    let registry =
        WorkerToolRegistryRpc::new(CapabilityPolicy::new([WorkerCapability::ShellExecute]));
    let tool = registry.get_tool("exec_command").unwrap();
    let effects = normalize_tool_effects(&tool, &json!({ "command": "echo hi" })).unwrap();

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
fn registered_shell_tool_is_allowed_without_approval_request() {
    let policy = CapabilityPolicy::new([WorkerCapability::ShellExecute]);
    let registry = WorkerToolRegistryRpc::new(policy.clone());
    let profile = WorkerPermissionProfileRpc::new(policy);
    let tool = registry.get_tool("exec_command").unwrap();

    let evaluation = profile
        .evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: "exec_command".to_string(),
                arguments: json!({ "command": "echo Hi" }),
                session_id: Some("session-1".to_string()),
                turn_id: Some("turn-1".to_string()),
            },
        )
        .expect("shell request should normalize");

    assert_eq!(evaluation.decision, PermissionDecision::Allow);
    assert!(!evaluation.requires_approval);
    assert!(evaluation.approval_request.is_none());
}
