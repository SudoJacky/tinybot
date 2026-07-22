use super::*;
use std::fmt::Debug;
use std::sync::Arc;

pub trait ToolContributor: Debug + Send + Sync {
    fn id(&self) -> &str;
    fn contribute(&self) -> Vec<ToolRegistryEntry>;
}

#[derive(Debug)]
struct CoreToolContributor {
    id: &'static str,
    entries: Vec<ToolRegistryEntry>,
}

impl ToolContributor for CoreToolContributor {
    fn id(&self) -> &str {
        self.id
    }

    fn contribute(&self) -> Vec<ToolRegistryEntry> {
        self.entries.clone()
    }
}

#[derive(Debug)]
struct WorkspaceToolContributor;

impl ToolContributor for WorkspaceToolContributor {
    fn id(&self) -> &str {
        "builtin.workspace"
    }

    fn contribute(&self) -> Vec<ToolRegistryEntry> {
        workspace_tool_entries()
    }
}

#[derive(Debug)]
struct BuiltinMcpToolContributor;

impl ToolContributor for BuiltinMcpToolContributor {
    fn id(&self) -> &str {
        "builtin.mcp"
    }

    fn contribute(&self) -> Vec<ToolRegistryEntry> {
        vec![tool(
            "mcp.call_tool",
            "mcp",
            "Call MCP tool",
            "Call a tool exposed by a configured MCP server.",
            ToolExposure::Deferred,
            true,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, true, true),
            vec![WorkerCapability::McpCall],
            approval(true, Some("mcp_tool"), Some("per_request")),
            json!({
                "type": "object",
                "required": ["server", "tool"],
                "properties": {
                    "server": { "type": "string" },
                    "tool": { "type": "string" },
                    "arguments": { "type": "object" }
                }
            }),
        )]
    }
}

#[derive(Clone, Debug)]
pub struct McpToolContributor {
    id: String,
    entries: Vec<ToolRegistryEntry>,
}

impl McpToolContributor {
    pub fn from_discovery(
        server_name: &str,
        server_config: &Value,
        discovered_tools: &[Value],
    ) -> Result<Self, String> {
        let server_name = server_name.trim();
        let entries =
            build_discovered_mcp_tool_entries(server_name, server_config, discovered_tools)?;
        Ok(Self {
            id: format!("mcp.{server_name}"),
            entries,
        })
    }
}

impl ToolContributor for McpToolContributor {
    fn id(&self) -> &str {
        &self.id
    }

    fn contribute(&self) -> Vec<ToolRegistryEntry> {
        self.entries.clone()
    }
}

pub(super) fn default_tool_contributors() -> Vec<Arc<dyn ToolContributor>> {
    let mut control_tools = Vec::new();
    let mut context_tools = Vec::new();
    let mut runtime_tools = Vec::new();
    for entry in core_tool_entries() {
        match entry.namespace.as_str() {
            "tool_registry" | "interaction" | "planning" => control_tools.push(entry),
            "memory" => context_tools.push(entry),
            "browser" | "shell" | "subagent" => runtime_tools.push(entry),
            namespace => panic!(
                "core tool `{}` has no contributor for namespace `{namespace}`",
                entry.tool_id
            ),
        }
    }
    vec![
        Arc::new(CoreToolContributor {
            id: "builtin.control",
            entries: control_tools,
        }),
        Arc::new(WorkspaceToolContributor),
        Arc::new(CoreToolContributor {
            id: "builtin.context_tools",
            entries: context_tools,
        }),
        Arc::new(BuiltinMcpToolContributor),
        Arc::new(CoreToolContributor {
            id: "builtin.runtime_tools",
            entries: runtime_tools,
        }),
    ]
}

pub(super) fn workspace_tool_entries() -> Vec<ToolRegistryEntry> {
    vec![
        tool(
            "workspace.write_file",
            "workspace",
            "Write workspace file",
            "Write a file under the current workspace.",
            ToolExposure::Hidden,
            false,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, true, false),
            vec![
                WorkerCapability::FsWorkspaceWrite,
                WorkerCapability::ApprovalRequest,
            ],
            approval(true, Some("file"), Some("per_request")),
            json!({
                "type": "object",
                "required": ["path", "contents"],
                "properties": {
                    "path": { "type": "string" },
                    "contents": { "type": "string" },
                    "expectedUpdatedAt": { "type": "string" }
                }
            }),
        ),
        tool(
            "workspace.apply_patch",
            "workspace",
            "Apply workspace patch",
            "Apply a strict multi-file patch under the current workspace. Patch context must match exactly.",
            ToolExposure::Hidden,
            false,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, true, false),
            vec![
                WorkerCapability::FsWorkspaceWrite,
                WorkerCapability::ApprovalRequest,
            ],
            approval(true, Some("file"), Some("per_request")),
            json!({
                "type": "object",
                "required": ["patch"],
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": "Strict patch text delimited by *** Begin Patch and *** End Patch."
                    }
                },
                "additionalProperties": false
            }),
        ),
        worker_rpc_tool(
            "apply_patch",
            "workspace.apply_patch",
            "workspace",
            "Apply workspace patch",
            "Apply a strict multi-file patch under the current workspace. Patch context must match exactly.",
            ToolExposure::Model,
            false,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, true, false),
            vec![
                WorkerCapability::FsWorkspaceWrite,
                WorkerCapability::ApprovalRequest,
            ],
            approval(true, Some("file"), Some("per_request")),
            json!({
                "type": "object",
                "required": ["patch"],
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": "Strict patch text delimited by *** Begin Patch and *** End Patch."
                    }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "workspace.delete_file",
            "workspace",
            "Delete workspace file",
            "Delete a file or directory under the current workspace.",
            ToolExposure::Hidden,
            false,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, true, false),
            vec![
                WorkerCapability::FsWorkspaceWrite,
                WorkerCapability::ApprovalRequest,
            ],
            approval(true, Some("file"), Some("per_request")),
            json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" },
                    "recursive": { "type": "boolean" }
                }
            }),
        ),
    ]
}

pub(super) fn build_discovered_mcp_tool_entries(
    server_name: &str,
    server_config: &Value,
    discovered_tools: &[Value],
) -> Result<Vec<ToolRegistryEntry>, String> {
    if server_name.is_empty() {
        return Err("MCP server name must not be empty".to_string());
    }
    let server_parallel = server_config
        .get("supportsParallelToolCalls")
        .or_else(|| server_config.get("supports_parallel_tool_calls"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut entries = Vec::with_capacity(discovered_tools.len());
    for definition in discovered_tools {
        let tool_name = definition
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("MCP server `{server_name}` returned a tool without a name"))?;
        let mut input_schema = definition
            .get("inputSchema")
            .or_else(|| definition.get("input_schema"))
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object" }));
        let input = input_schema.as_object_mut().ok_or_else(|| {
            format!("MCP tool `{server_name}.{tool_name}` input schema must be a JSON object")
        })?;
        if let Some(schema_type) = input.get("type") {
            if schema_type.as_str() != Some("object") {
                return Err(format!(
                    "MCP tool `{server_name}.{tool_name}` input schema type must be object"
                ));
            }
        } else {
            input.insert("type".to_string(), Value::String("object".to_string()));
        }
        let output_schema = definition
            .get("outputSchema")
            .or_else(|| definition.get("output_schema"))
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object" }));
        if !output_schema.is_object() {
            return Err(format!(
                "MCP tool `{server_name}.{tool_name}` output schema must be a JSON object"
            ));
        }
        let read_only = definition
            .get("annotations")
            .and_then(Value::as_object)
            .and_then(|annotations| {
                annotations
                    .get("readOnlyHint")
                    .or_else(|| annotations.get("read_only_hint"))
            })
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tool_id = mcp_tool_id(server_name, tool_name);
        let title = definition
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{server_name}: {tool_name}"));
        let description = definition
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|description| !description.is_empty())
            .map(|description| format!("MCP server {server_name}: {description}"))
            .unwrap_or_else(|| format!("Call {tool_name} on MCP server {server_name}."));
        let runtime_policy = runtime_policy(
            server_parallel || read_only,
            ToolCancellationMode::DetachForbidden,
            !read_only,
            false,
        );
        entries.push(ToolRegistryEntry {
            tool_id: tool_id.clone(),
            method: tool_id,
            namespace: "mcp".to_string(),
            title,
            description,
            exposure: ToolExposure::Deferred,
            dynamic: true,
            supports_parallel_tool_calls: runtime_policy.supports_parallel_tool_calls,
            runtime_policy,
            required_capabilities: vec![WorkerCapability::McpCall],
            available: false,
            approval: approval(true, Some("mcp_tool"), Some("per_request")),
            input_schema,
            output_schema,
            execution_target: ToolExecutionTarget::Mcp {
                server: server_name.to_string(),
                tool: tool_name.to_string(),
            },
        });
    }
    Ok(entries)
}

fn mcp_tool_id(server_name: &str, tool_name: &str) -> String {
    format!(
        "mcp.{}:{server_name}.{}:{tool_name}",
        server_name.len(),
        tool_name.len()
    )
}
