use crate::agent::runtime::{
    AgentError, AgentTurnContext, NativeAgentToolCatalog, NativeAgentToolPreparation,
};
use crate::runtime::mcp::McpRuntime;
use crate::threads::workspace_store::WorkspaceThreadStore;
use crate::tools::registry::{AgentGraphToolContributor, McpToolContributor, ToolContributor};
use std::{path::Path, sync::Arc};

pub(super) async fn prepare_tools(
    context: &AgentTurnContext,
    config_snapshot: &serde_json::Value,
    workspace_root: &Path,
    thread_store: &WorkspaceThreadStore,
    mcp_runtime: &McpRuntime,
) -> Result<NativeAgentToolPreparation, AgentError> {
    let capability_policy = context.settings.capability_policy()?;
    let mcp_workspace_root = context
        .settings
        .working_directory
        .as_deref()
        .unwrap_or(workspace_root);
    let cancellation = context
        .cancellation
        .clone()
        .map(|c| Arc::new(c) as Arc<dyn crate::protocol::WorkerRequestCancellation>);
    let mcp_snapshot =
        if capability_policy.allows(&crate::protocol::capability::WorkerCapability::McpCall) {
            match mcp_runtime
                .registry_snapshot(mcp_workspace_root, config_snapshot, cancellation)
                .await
            {
                Ok(snapshot) => Some(snapshot),
                Err(error) if error.cancelled => {
                    return Ok(NativeAgentToolPreparation::Cancelled {
                        phase: "mcp_discovery".into(),
                        server: Some(error.server),
                        transport: Some(error.transport),
                    })
                }
                Err(error) => {
                    return Err(format!(
                        "MCP registry snapshot failed for server `{}` over {}: {}",
                        error.server, error.transport, error.message
                    )
                    .into())
                }
            }
        } else {
            None
        };
    let mut contributors: Vec<Arc<dyn ToolContributor>> = Vec::new();
    let graph_node_turn = ["graphRunId", "graph_run_id"]
        .iter()
        .any(|key| context.metadata.get(*key).is_some());
    if !graph_node_turn && context.controls.declares_working_directory {
        if let Some(definition_workspace_root) = context.settings.working_directory.as_deref() {
            let definition_workspace =
                crate::workspace_registry::canonical_workspace(definition_workspace_root)?;
            let discovery =
                crate::agent_graphs::discover_tools_for_workspace(&definition_workspace)?;
            if !discovery.graphs.is_empty() {
                contributors.push(Arc::new(AgentGraphToolContributor::new(
                    crate::workspace_registry::workspace_id(&definition_workspace),
                    discovery.graphs,
                )?));
            }
        }
    }

    if let Some(contributor) = super::workspace_threads::tool_contributor(thread_store, context)? {
        contributors.push(Arc::new(contributor));
    }
    let mut selected_tools = context.settings.selected_tools.clone();
    for server in mcp_snapshot
        .as_deref()
        .into_iter()
        .flat_map(|snapshot| snapshot.servers.iter())
        .filter(|server| server.available && server.tools.iter().any(|tool| tool.allowed))
    {
        contributors.push(Arc::new(McpToolContributor::from_registry(server)?));
    }
    if let (Some(snapshot), Some(selected_tools)) =
        (mcp_snapshot.as_deref(), selected_tools.as_mut())
    {
        let unavailable_mcp_tools = snapshot
            .servers
            .iter()
            .filter(|server| !server.available)
            .flat_map(|server| server.tools.iter().map(|tool| tool.id.as_str()))
            .collect::<std::collections::BTreeSet<_>>();
        let dropped_concrete_mcp = selected_tools
            .iter()
            .any(|tool_id| unavailable_mcp_tools.contains(tool_id.as_str()));
        selected_tools.retain(|tool_id| {
            !unavailable_mcp_tools.contains(tool_id.as_str())
                && (!dropped_concrete_mcp
                    || tool_id != crate::tools::registry::MCP_CALL_TOOL_METHOD)
        });
    }

    Ok(NativeAgentToolPreparation::Ready(NativeAgentToolCatalog {
        contributors,
        selected_tools,
    }))
}
