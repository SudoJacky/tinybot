use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct WorkerToolRegistryRpc {
    policy: CapabilityPolicy,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRegistryListResult {
    pub tools: Vec<ToolRegistryEntry>,
    pub total: usize,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRegistrySearchRequest {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub exposure: Option<ToolExposure>,
    #[serde(default)]
    pub available_only: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRegistrySearchResult {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exposure: Option<ToolExposure>,
    pub available_only: bool,
    pub tools: Vec<ToolRegistryEntry>,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRegistryEntry {
    pub tool_id: &'static str,
    pub method: &'static str,
    pub namespace: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub exposure: ToolExposure,
    pub dynamic: bool,
    pub supports_parallel_tool_calls: bool,
    #[serde(skip_serializing)]
    pub runtime_policy: ToolRuntimePolicy,
    pub required_capabilities: Vec<WorkerCapability>,
    pub available: bool,
    pub approval: ToolApprovalMetadata,
    pub input_schema: Value,
    pub output_schema: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolRuntimePolicy {
    pub supports_parallel_tool_calls: bool,
    pub waits_for_runtime_cancellation: bool,
    pub mutates_workspace: bool,
    pub mutates_session: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolExposure {
    Direct,
    Model,
    Deferred,
    Hidden,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalMetadata {
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<&'static str>,
}

impl WorkerToolRegistryRpc {
    pub fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    pub fn list_tools(&self) -> ToolRegistryListResult {
        let tools = builtin_tool_entries()
            .into_iter()
            .map(|mut tool| {
                tool.available = tool
                    .required_capabilities
                    .iter()
                    .all(|capability| self.policy.allows(capability));
                tool
            })
            .collect::<Vec<_>>();
        ToolRegistryListResult {
            total: tools.len(),
            tools,
        }
    }

    pub fn get_tool(&self, tool_id: &str) -> Option<ToolRegistryEntry> {
        let normalized_tool_id = tool_id.trim();
        self.list_tools()
            .tools
            .into_iter()
            .find(|tool| tool.tool_id == normalized_tool_id || tool.method == normalized_tool_id)
    }

    pub fn missing_capabilities(&self, tool: &ToolRegistryEntry) -> Vec<WorkerCapability> {
        tool.required_capabilities
            .iter()
            .filter(|capability| !self.policy.allows(capability))
            .cloned()
            .collect()
    }

    pub fn search_tools(&self, request: ToolRegistrySearchRequest) -> ToolRegistrySearchResult {
        let query = request.query.unwrap_or_default();
        let normalized_query = query.trim().to_lowercase();
        let namespace = request
            .namespace
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty());
        let mut tools = self
            .list_tools()
            .tools
            .into_iter()
            .filter(|tool| {
                namespace
                    .as_deref()
                    .map(|namespace| tool.namespace == namespace)
                    .unwrap_or(true)
            })
            .filter(|tool| {
                request
                    .exposure
                    .map(|exposure| tool.exposure == exposure)
                    .unwrap_or(true)
            })
            .filter(|tool| !request.available_only || tool.available)
            .filter(|tool| {
                normalized_query.is_empty() || tool_matches_query(tool, normalized_query.as_str())
            })
            .collect::<Vec<_>>();
        tools.sort_by(|left, right| {
            left.namespace
                .cmp(right.namespace)
                .then_with(|| left.method.cmp(right.method))
        });
        if let Some(limit) = request.limit {
            tools.truncate(limit.min(100));
        }
        ToolRegistrySearchResult {
            query,
            namespace,
            exposure: request.exposure,
            available_only: request.available_only,
            total: tools.len(),
            tools,
        }
    }
}

fn tool_matches_query(tool: &ToolRegistryEntry, query: &str) -> bool {
    tool.tool_id.to_lowercase().contains(query)
        || tool.method.to_lowercase().contains(query)
        || tool.namespace.to_lowercase().contains(query)
        || tool.title.to_lowercase().contains(query)
        || tool.description.to_lowercase().contains(query)
}

fn builtin_tool_entries() -> Vec<ToolRegistryEntry> {
    vec![
        tool(
            "workspace.read_file",
            "workspace",
            "Read workspace file",
            "Read a file under the current workspace.",
            ToolExposure::Model,
            false,
            runtime_policy(true, false, false, false),
            vec![WorkerCapability::FsWorkspaceRead],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer" },
                    "limit": { "type": "integer" },
                    "format": { "type": "string" }
                }
            }),
        ),
        tool(
            "workspace.write_file",
            "workspace",
            "Write workspace file",
            "Write a file under the current workspace.",
            ToolExposure::Deferred,
            false,
            runtime_policy(false, false, true, false),
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
            "workspace.delete_file",
            "workspace",
            "Delete workspace file",
            "Delete a file or directory under the current workspace.",
            ToolExposure::Deferred,
            false,
            runtime_policy(false, false, true, false),
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
        tool(
            "knowledge.query",
            "knowledge",
            "Query knowledge",
            "Search the local knowledge index.",
            ToolExposure::Model,
            false,
            runtime_policy(true, false, false, false),
            vec![WorkerCapability::KnowledgeRead],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": { "type": "string" },
                    "category": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "limit": { "type": "integer" }
                }
            }),
        ),
        tool(
            "memory.search",
            "memory",
            "Search memory",
            "Search saved memory notes.",
            ToolExposure::Model,
            false,
            runtime_policy(true, false, false, false),
            vec![WorkerCapability::MemoryRead],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer" }
                }
            }),
        ),
        tool(
            "memory.recall",
            "memory",
            "Recall memory",
            "Recall memory context for the current turn.",
            ToolExposure::Model,
            false,
            runtime_policy(true, false, false, false),
            vec![WorkerCapability::MemoryRead],
            approval(false, None, None),
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "sessionId": { "type": "string" }
                }
            }),
        ),
        tool(
            "mcp.call_tool",
            "mcp",
            "Call MCP tool",
            "Call a tool exposed by a configured MCP server.",
            ToolExposure::Deferred,
            true,
            runtime_policy(false, true, true, true),
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
        ),
        tool(
            "shell.execute",
            "shell",
            "Execute shell command",
            "Run a shell command in the workspace.",
            ToolExposure::Deferred,
            false,
            runtime_policy(false, true, true, false),
            vec![WorkerCapability::ShellExecute],
            approval(true, Some("command"), Some("per_request")),
            json!({
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": { "type": "string" },
                    "workingDir": { "type": "string" },
                    "timeout": { "type": "integer" }
                }
            }),
        ),
        tool(
            "subagent.spawn",
            "subagent",
            "Spawn subagent",
            "Create a child agent thread for delegated work.",
            ToolExposure::Model,
            false,
            runtime_policy(false, true, false, true),
            vec![
                WorkerCapability::BackgroundWrite,
                WorkerCapability::SessionWrite,
            ],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["sessionKey"],
                "properties": {
                    "sessionKey": { "type": "string" },
                    "subagentId": { "type": "string" },
                    "task": { "type": "string" },
                    "metadata": { "type": "object" }
                }
            }),
        ),
        tool(
            "subagent.send_input",
            "subagent",
            "Send subagent input",
            "Send input to an active child agent thread.",
            ToolExposure::Model,
            false,
            runtime_policy(false, true, false, true),
            vec![
                WorkerCapability::BackgroundWrite,
                WorkerCapability::SessionWrite,
            ],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["sessionKey", "subagentId", "content", "sender"],
                "properties": {
                    "sessionKey": { "type": "string" },
                    "subagentId": { "type": "string" },
                    "content": { "type": "string" },
                    "sender": { "type": "string" }
                }
            }),
        ),
    ]
}

fn tool(
    method: &'static str,
    namespace: &'static str,
    title: &'static str,
    description: &'static str,
    exposure: ToolExposure,
    dynamic: bool,
    runtime_policy: ToolRuntimePolicy,
    required_capabilities: Vec<WorkerCapability>,
    approval: ToolApprovalMetadata,
    input_schema: Value,
) -> ToolRegistryEntry {
    ToolRegistryEntry {
        tool_id: method,
        method,
        namespace,
        title,
        description,
        exposure,
        dynamic,
        supports_parallel_tool_calls: runtime_policy.supports_parallel_tool_calls,
        runtime_policy,
        required_capabilities,
        available: false,
        approval,
        input_schema,
        output_schema: json!({ "type": "object" }),
    }
}

fn runtime_policy(
    supports_parallel_tool_calls: bool,
    waits_for_runtime_cancellation: bool,
    mutates_workspace: bool,
    mutates_session: bool,
) -> ToolRuntimePolicy {
    ToolRuntimePolicy {
        supports_parallel_tool_calls,
        waits_for_runtime_cancellation,
        mutates_workspace,
        mutates_session,
    }
}

fn approval(
    required: bool,
    scope: Option<&'static str>,
    lifetime: Option<&'static str>,
) -> ToolApprovalMetadata {
    ToolApprovalMetadata {
        required,
        scope,
        lifetime,
    }
}
