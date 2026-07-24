use super::*;

#[test]
fn update_plan_is_an_always_available_runtime_control_tool() {
    let tool = WorkerToolRegistryRpc::new(CapabilityPolicy::default())
        .get_tool(UPDATE_PLAN_METHOD)
        .expect("update_plan should be registered");

    assert_eq!(tool.exposure, ToolExposure::Model);
    assert!(tool.available);
    assert!(!tool.approval.required);
    assert!(tool.runtime_policy.mutates_session);
    assert!(!tool.supports_parallel_tool_calls);
    assert_eq!(
        tool.execution_target,
        ToolExecutionTarget::RuntimeControl(ToolRuntimeControl::UpdatePlan)
    );
    assert_eq!(tool.input_schema["properties"]["plan"]["minItems"], 1);
    assert_eq!(
        tool.input_schema["properties"]["plan"]["items"]["properties"]["status"]["enum"],
        json!(["pending", "in_progress", "completed"])
    );
}

#[test]
fn tool_search_is_a_registered_runtime_control_tool() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::default());
    let tool = registry
        .get_tool(TOOL_SEARCH_METHOD)
        .expect("tool_search should be registered");

    assert_eq!(tool.exposure, ToolExposure::Model);
    assert!(tool.available);
    assert_eq!(
        tool.execution_target,
        ToolExecutionTarget::RuntimeControl(ToolRuntimeControl::ToolSearch)
    );
    assert_eq!(tool.input_schema["properties"]["limit"]["maximum"], 20);
}

#[test]
fn request_user_input_requires_form_capability() {
    let denied = WorkerToolRegistryRpc::new(CapabilityPolicy::default())
        .get_tool(REQUEST_USER_INPUT_METHOD)
        .expect("request_user_input should be registered");
    let available =
        WorkerToolRegistryRpc::new(CapabilityPolicy::new([WorkerCapability::FormRequest]))
            .get_tool(REQUEST_USER_INPUT_METHOD)
            .expect("request_user_input should be registered");

    assert!(!denied.available);
    assert!(available.available);
    assert_eq!(
        available.execution_target,
        ToolExecutionTarget::RuntimeControl(ToolRuntimeControl::RequestUserInput)
    );
    assert!(available.runtime_policy.mutates_session);
    assert_eq!(
        available.input_schema["properties"]["fields"]["minItems"],
        1
    );
}

#[test]
fn canonical_apply_patch_is_model_visible_and_legacy_name_is_hidden() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::FsWorkspaceWrite,
        WorkerCapability::ApprovalRequest,
    ]));
    let tool = registry
        .get_tool("apply_patch")
        .expect("apply_patch should be registered");
    let legacy = registry
        .get_tool("workspace.apply_patch")
        .expect("workspace.apply_patch should remain an internal adapter");

    assert_eq!(tool.exposure, ToolExposure::Model);
    assert!(tool.available);
    assert!(tool.approval.required);
    assert!(tool.runtime_policy.mutates_workspace);
    assert_eq!(
        tool.execution_target,
        ToolExecutionTarget::WorkerRpc {
            method: "workspace.apply_patch".to_string()
        }
    );
    assert_eq!(legacy.exposure, ToolExposure::Hidden);
}

#[test]
fn browser_tools_are_deferred_and_interaction_requires_approval() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::BrowserObserve,
        WorkerCapability::BrowserInteract,
        WorkerCapability::ApprovalRequest,
    ]));
    let observe = registry
        .get_tool("browser.observe")
        .expect("browser.observe should be registered");
    let interact = registry
        .get_tool("browser.interact")
        .expect("browser.interact should be registered");

    assert_eq!(observe.exposure, ToolExposure::Deferred);
    assert!(observe.available);
    assert!(!observe.approval.required);
    assert!(observe.runtime_policy.mutates_session);
    assert_eq!(interact.exposure, ToolExposure::Deferred);
    assert!(interact.available);
    assert!(interact.approval.required);
    assert_eq!(interact.approval.scope, Some("browser"));
    assert_eq!(
        interact.runtime_policy.cancellation_mode,
        ToolCancellationMode::DetachForbidden
    );
    assert_eq!(
        interact.input_schema["required"],
        json!(["browserSessionId", "tabId", "controlEpoch", "action"])
    );
}

#[test]
fn retained_shell_tools_use_owned_process_rpc_targets() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::ShellExecute,
        WorkerCapability::ApprovalRequest,
    ]));
    let start = registry
        .get_tool("exec_command")
        .expect("exec_command should be registered");
    let input = registry
        .get_tool("write_stdin")
        .expect("write_stdin should be registered");

    assert_eq!(start.exposure, ToolExposure::Model);
    assert!(start.available);
    assert!(start.approval.required);
    assert_eq!(
        start.runtime_policy.cancellation_mode,
        ToolCancellationMode::TerminateProcess
    );
    assert_eq!(
        start.execution_target,
        ToolExecutionTarget::WorkerRpc {
            method: "shell.start".to_string()
        }
    );
    assert_eq!(input.exposure, ToolExposure::Model);
    assert!(input.available);
    assert!(!input.approval.required);
    assert_eq!(
        input.runtime_policy.cancellation_mode,
        ToolCancellationMode::DetachForbidden
    );
    assert_eq!(
        input.execution_target,
        ToolExecutionTarget::WorkerRpc {
            method: "shell.write_stdin".to_string()
        }
    );
}

#[test]
fn explicit_exec_disable_marks_new_shell_commands_unavailable() {
    let policy = CapabilityPolicy::new([
        WorkerCapability::ShellExecute,
        WorkerCapability::ApprovalRequest,
    ]);
    let disabled = WorkerToolRegistryRpc::new_with_config(
        policy.clone(),
        json!({ "tools": { "exec": { "enable": false } } }),
    );
    let enabled = WorkerToolRegistryRpc::new_with_config(
        policy,
        json!({ "tools": { "exec": { "enable": true } } }),
    );

    assert!(!disabled.get_tool("shell.execute").unwrap().available);
    assert!(!disabled.get_tool("exec_command").unwrap().available);
    assert!(enabled.get_tool("shell.execute").unwrap().available);
    assert!(enabled.get_tool("exec_command").unwrap().available);
}

#[test]
fn registry_keeps_complete_subagent_lifecycle_controls_deferred() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::BackgroundRead,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]));

    for method in [
        "subagent.spawn",
        "subagent.send_input",
        "subagent.wait",
        "subagent.close",
        "subagent.resume",
    ] {
        let tool = registry
            .get_tool(method)
            .unwrap_or_else(|| panic!("{method} should be registered"));
        assert_eq!(tool.exposure, ToolExposure::Deferred);
        assert!(tool.available);
        assert_eq!(
            tool.execution_target,
            ToolExecutionTarget::WorkerRpc {
                method: method.to_string()
            }
        );
    }

    let wait = registry.get_tool("subagent.wait").unwrap();
    assert_eq!(
        wait.runtime_policy.cancellation_mode,
        ToolCancellationMode::Cooperative
    );
    assert!(!wait.runtime_policy.mutates_session);
    assert_eq!(
        registry.get_tool("subagent.spawn").unwrap().input_schema["properties"]["historyMode"]
            ["enum"],
        json!(["isolated", "parent_turn", "full_history"])
    );
    assert_eq!(
        registry.get_tool("subagent.spawn").unwrap().input_schema["required"],
        json!(["task"])
    );
    assert_eq!(
        registry
            .get_tool("subagent.send_input")
            .unwrap()
            .input_schema["required"],
        json!(["subagentId", "content"])
    );
}

#[derive(Debug)]
struct DuplicateWorkspaceContributor;

impl ToolContributor for DuplicateWorkspaceContributor {
    fn id(&self) -> &str {
        "test.duplicate_workspace"
    }

    fn contribute(&self) -> Vec<ToolRegistryEntry> {
        vec![workspace_tool_entries()[0].clone()]
    }
}

#[test]
fn workspace_internal_and_mcp_tools_are_owned_by_named_contributors() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::FsWorkspaceWrite,
        WorkerCapability::McpCall,
    ]));
    assert_eq!(
        registry.contributor_id_for_tool("workspace.write_file"),
        Some("builtin.workspace".to_string())
    );
    assert!(registry.get_tool("workspace.read_file").is_none());
    assert_eq!(
        registry.contributor_id_for_tool("mcp.call_tool"),
        Some("builtin.mcp".to_string())
    );

    let registry = registry
        .with_contributor(std::sync::Arc::new(
            McpToolContributor::from_discovery(
                "search",
                &json!({ "supportsParallelToolCalls": true }),
                &[json!({
                    "name": "lookup",
                    "description": "Look up a record",
                    "inputSchema": { "type": "object" }
                })],
            )
            .expect("valid discovery should build a contributor"),
        ))
        .expect("MCP contributor should register");
    assert_eq!(
        registry.contributor_id_for_tool("mcp.6:search.6:lookup"),
        Some("mcp.search".to_string())
    );

    let error = registry
        .with_contributor(std::sync::Arc::new(DuplicateWorkspaceContributor))
        .expect_err("duplicate tool methods must fail before activation");
    assert!(error.contains("workspace.write_file"));
    assert!(error.contains("test.duplicate_workspace"));
}

#[test]
fn discovered_mcp_tool_becomes_deferred_registry_entry() {
    let entries = McpToolContributor::from_discovery(
        "docs",
        &json!({}),
        &[json!({
            "name": "search",
            "description": "Search documentation.",
            "inputSchema": {
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            },
            "annotations": { "readOnlyHint": true }
        })],
    )
    .expect("valid MCP definition should normalize")
    .contribute();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].exposure, ToolExposure::Deferred);
    assert!(entries[0].dynamic);
    assert!(entries[0].approval.required);
    assert!(entries[0].supports_parallel_tool_calls);
    assert_eq!(entries[0].input_schema["type"], "object");
    assert_eq!(
        entries[0].execution_target,
        ToolExecutionTarget::Mcp {
            server: "docs".to_string(),
            tool: "search".to_string()
        }
    );
}

#[test]
fn malformed_mcp_tool_schema_fails_explicitly() {
    let error = McpToolContributor::from_discovery(
        "docs",
        &json!({}),
        &[json!({ "name": "bad", "inputSchema": { "type": "string" } })],
    )
    .expect_err("non-object MCP input schema must fail");

    assert!(error.contains("input schema type must be object"));
}
