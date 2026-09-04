use crate::runtime::mcp::{McpRuntime, McpRuntimeError};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpCapabilityCatalog {
    pub(crate) revision: u64,
    pub(crate) servers: Vec<McpServerCapability>,
    pub(crate) tools: Vec<McpToolCapability>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerCapability {
    pub(crate) id: String,
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) stale: bool,
    pub(crate) transport: String,
    pub(crate) status: Value,
    pub(crate) tool_count: usize,
    pub(crate) source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpToolCapability {
    // IDs are opaque. Consumers must return this exact value rather than rebuilding it.
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) namespace: &'static str,
    pub(crate) source: &'static str,
    pub(crate) server_id: String,
    pub(crate) available: bool,
    pub(crate) allowed: bool,
    pub(crate) default_selected: bool,
    pub(crate) selected: bool,
    pub(crate) callable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    pub(crate) parameters: Value,
    pub(crate) raw: Value,
}

pub(crate) async fn build_mcp_capability_catalog(
    runtime: &McpRuntime,
    workspace_root: &Path,
    config_snapshot: &Value,
    mcp_capability_allowed: bool,
) -> Result<McpCapabilityCatalog, McpRuntimeError> {
    let snapshot = runtime
        .registry_snapshot(workspace_root, config_snapshot, None)
        .await?;
    let mut servers = Vec::with_capacity(snapshot.servers.len());
    let mut tools = Vec::new();

    for server in &snapshot.servers {
        let transport = server
            .server_config
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("stdio")
            .to_ascii_lowercase();
        let source = server
            .server_config
            .get("workspace_source")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                server
                    .server_config
                    .get("agent_plugin")
                    .and_then(Value::as_bool)
                    .filter(|enabled| *enabled)
                    .map(|_| "plugin".to_string())
            })
            .unwrap_or_else(|| "configuration".to_string());

        for tool in &server.tools {
            let available = server.available;
            let allowed = mcp_capability_allowed && tool.allowed;
            let callable = available && allowed;
            let default_selected = allowed && tool.default_selected;
            let selected = available && default_selected;
            let reason = if !mcp_capability_allowed {
                Some("MCP capability is denied by the active permission profile".to_string())
            } else if !tool.allowed {
                Some("tool is not included in the server allowlist".to_string())
            } else if !available {
                Some(
                    server
                        .error
                        .clone()
                        .unwrap_or_else(|| "MCP server is not ready".to_string()),
                )
            } else {
                None
            };
            tools.push(McpToolCapability {
                id: tool.id.clone(),
                name: format!("{}.{}", server.server_id, tool.name),
                display_name: tool.name.clone(),
                description: tool
                    .definition
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                namespace: "mcp",
                source: "mcp",
                server_id: server.server_id.clone(),
                available,
                allowed,
                default_selected,
                selected,
                callable,
                reason,
                parameters: tool
                    .definition
                    .get("inputSchema")
                    .or_else(|| tool.definition.get("input_schema"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
                raw: tool.definition.clone(),
            });
        }
        servers.push(McpServerCapability {
            id: server.server_id.clone(),
            enabled: server.enabled,
            available: server.available,
            stale: server.stale,
            transport,
            status: server.status.clone(),
            tool_count: server.tools.len(),
            source,
            error: server.error.clone(),
        });
    }

    Ok(McpCapabilityCatalog {
        revision: snapshot.revision,
        servers,
        tools,
    })
}

#[cfg(test)]
#[path = "mcp_capability_catalog_tests.rs"]
mod tests;
