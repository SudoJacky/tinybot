use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::tools::registry::WorkerToolRegistryRpc;
use serde_json::json;

#[test]
fn file_search_is_scoped_read_only_without_shell_capability() {
    let policy = CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]);
    let registry = WorkerToolRegistryRpc::new(policy.clone());
    let tool = registry.get_tool("search_file_content").unwrap();
    assert!(tool.available);
    assert!(tool.supports_parallel_tool_calls);
    assert!(!tool.runtime_policy.mutates_workspace);
    let evaluation = WorkerPermissionProfileRpc::new(policy)
        .evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: tool.tool_id.clone(),
                arguments: json!({"pattern": "needle", "path": "notes"}),
            },
        )
        .unwrap();
    assert_eq!(evaluation.decision, PermissionDecision::Allow);
    assert_eq!(
        evaluation.effects.filesystem.read_roots,
        vec!["workspace://current/notes"]
    );
    assert!(evaluation.effects.filesystem.write_roots.is_empty());
    assert_eq!(
        evaluation.effects.network.mode,
        PermissionNetworkMode::Denied
    );
    assert!(!evaluation.effects.environment.inherit);
}

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
fn registered_shell_tool_is_allowed_when_capability_is_granted() {
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
            },
        )
        .expect("shell request should normalize");

    assert_eq!(evaluation.decision, PermissionDecision::Allow);
}

#[test]
fn saved_automation_creation_requires_its_own_write_capability() {
    let policy = crate::protocol::capability::default_desktop_capability_policy();
    let tool = WorkerToolRegistryRpc::new(policy.clone())
        .get_tool("create_automation")
        .unwrap();
    for granted in [true, false] {
        let profile = WorkerPermissionProfileRpc::new(CapabilityPolicy::new(
            policy
                .granted_capabilities()
                .into_iter()
                .filter(|capability| granted || capability != &WorkerCapability::AutomationWrite),
        ));
        let evaluation = profile
            .evaluate_tool(
                &tool,
                PermissionEvaluateToolRequest {
                    tool_id: tool.tool_id.clone(),
                    arguments: json!({}),
                },
            )
            .unwrap();
        assert_eq!(
            evaluation.decision,
            if granted {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            }
        );
        assert_eq!(
            evaluation.missing_capabilities,
            if granted {
                vec![]
            } else {
                vec![WorkerCapability::AutomationWrite]
            }
        );
        assert!(evaluation.effects.mutates_background);
        if granted {
            let snapshot = profile.current_profile(vec![tool.clone()]);
            let capability = snapshot
                .capabilities
                .iter()
                .find(|state| state.capability == WorkerCapability::AutomationWrite)
                .unwrap();
            assert_eq!(capability.scope, "automation://definitions");
        }
    }
}
