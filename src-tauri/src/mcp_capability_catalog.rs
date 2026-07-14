use crate::runtime::mcp::{configured_mcp_servers, mcp_tool_is_enabled, McpRuntime};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpCapabilityCatalog {
    pub(crate) servers: Vec<McpServerCapability>,
    pub(crate) tools: Vec<McpToolCapability>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerCapability {
    pub(crate) id: String,
    pub(crate) enabled: bool,
    pub(crate) transport: String,
    pub(crate) status: Value,
    pub(crate) tool_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpToolCapability {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) namespace: &'static str,
    pub(crate) source: &'static str,
    pub(crate) server_id: String,
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) callable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    pub(crate) approval: McpApprovalCapability,
    pub(crate) parameters: Value,
    pub(crate) raw: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpApprovalCapability {
    pub(crate) required: bool,
    pub(crate) scope: &'static str,
    pub(crate) lifetime: &'static str,
    pub(crate) configured_policy: String,
}

pub(crate) async fn build_mcp_capability_catalog(
    runtime: &McpRuntime,
    workspace_root: &Path,
    config_snapshot: &Value,
    mcp_capability_allowed: bool,
) -> McpCapabilityCatalog {
    let Some(configured_servers) = configured_mcp_servers(config_snapshot) else {
        return McpCapabilityCatalog {
            servers: Vec::new(),
            tools: Vec::new(),
        };
    };
    let default_approval = config_snapshot
        .get("mcp")
        .and_then(|mcp| mcp.get("default_approval_policy"))
        .and_then(Value::as_str)
        .unwrap_or("always");
    let mut servers = Vec::with_capacity(configured_servers.len());
    let mut tools = Vec::new();

    for (server_id, server_config) in configured_servers {
        let enabled = server_config.get("enabled").and_then(Value::as_bool) != Some(false);
        let transport = server_config
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("stdio")
            .to_ascii_lowercase();
        let approval_policy = server_config
            .get("approval")
            .and_then(Value::as_str)
            .unwrap_or(default_approval)
            .to_string();

        if !enabled || !mcp_capability_allowed {
            let reason = if enabled {
                "MCP capability is denied by the active permission profile"
            } else {
                "MCP server is disabled"
            };
            servers.push(McpServerCapability {
                id: server_id.clone(),
                enabled,
                transport: transport.clone(),
                status: serde_json::json!({
                    "state": if enabled { "blocked" } else { "disabled" },
                    "transport": transport,
                    "toolCount": 0,
                    "elapsedMs": 0,
                    "lastError": Value::Null,
                    "reason": reason,
                }),
                tool_count: 0,
                error: None,
            });
            continue;
        }

        let discovered = runtime
            .list_tools(workspace_root, server_id, server_config, None)
            .await;
        let status = runtime.server_status(workspace_root, server_id).await;
        let mut server_error = None;
        let definitions = match discovered {
            Ok(definitions) => definitions,
            Err(error) => {
                server_error = Some(error.message);
                Vec::new()
            }
        };
        for definition in &definitions {
            let Some(tool_name) = definition.get("name").and_then(Value::as_str) else {
                continue;
            };
            let allowlisted = mcp_tool_is_enabled(server_id, tool_name, server_config);
            let callable =
                allowlisted && status.get("state").and_then(Value::as_str) == Some("ready");
            let reason = if !allowlisted {
                Some("tool is not included in the server allowlist".to_string())
            } else if !callable {
                Some("MCP server is not ready".to_string())
            } else {
                None
            };
            tools.push(McpToolCapability {
                id: format!("mcp.{server_id}.{tool_name}"),
                name: format!("{server_id}.{tool_name}"),
                display_name: tool_name.to_string(),
                description: definition
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                namespace: "mcp",
                source: "mcp",
                server_id: server_id.clone(),
                enabled: allowlisted,
                available: callable,
                callable,
                reason,
                approval: McpApprovalCapability {
                    // The current dispatcher always requires approval. Expose the configured
                    // policy separately instead of claiming that it already changes execution.
                    required: true,
                    scope: "mcp_tool",
                    lifetime: "per_request",
                    configured_policy: approval_policy.clone(),
                },
                parameters: definition
                    .get("inputSchema")
                    .or_else(|| definition.get("input_schema"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
                raw: definition.clone(),
            });
        }
        servers.push(McpServerCapability {
            id: server_id.clone(),
            enabled: true,
            transport,
            status,
            tool_count: definitions.len(),
            error: server_error,
        });
    }

    McpCapabilityCatalog { servers, tools }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_servers_are_visible_without_starting_a_transport() {
        let catalog = tauri::async_runtime::block_on(build_mcp_capability_catalog(
            &McpRuntime::new(),
            Path::new("."),
            &serde_json::json!({
                "tools": { "mcp_servers": { "docs": {
                    "enabled": false,
                    "transport": "stdio",
                    "command": "does-not-run"
                }}}
            }),
            true,
        ));

        assert_eq!(catalog.servers.len(), 1);
        assert_eq!(catalog.servers[0].status["state"], "disabled");
        assert!(catalog.tools.is_empty());
    }
}
