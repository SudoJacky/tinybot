use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const TOOL_SEARCH_METHOD: &str = "tool_search";
pub const REQUEST_USER_INPUT_METHOD: &str = "request_user_input";
pub const DEFAULT_TOOL_SEARCH_LIMIT: usize = 5;
pub const MAX_TOOL_SEARCH_LIMIT: usize = 20;

#[derive(Clone, Debug)]
pub struct WorkerToolRegistryRpc {
    policy: CapabilityPolicy,
    dynamic_tools: Vec<ToolRegistryEntry>,
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
    pub tool_id: String,
    pub method: String,
    pub namespace: String,
    pub title: String,
    pub description: String,
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
    #[serde(skip_serializing)]
    pub execution_target: ToolExecutionTarget,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolExecutionTarget {
    WorkerRpc { method: String },
    Mcp { server: String, tool: String },
    RuntimeControl(ToolRuntimeControl),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolRuntimeControl {
    ToolSearch,
    RequestUserInput,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolRuntimePolicy {
    pub supports_parallel_tool_calls: bool,
    pub cancellation_mode: ToolCancellationMode,
    pub cleanup_timeout_ms: u64,
    pub mutates_workspace: bool,
    pub mutates_session: bool,
}

impl ToolRuntimePolicy {
    pub fn waits_for_runtime_cancellation(self) -> bool {
        self.cancellation_mode != ToolCancellationMode::Cooperative
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCancellationMode {
    Cooperative,
    TerminateProcess,
    DetachForbidden,
}

impl ToolCancellationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cooperative => "cooperative",
            Self::TerminateProcess => "terminate_process",
            Self::DetachForbidden => "detach_forbidden",
        }
    }
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
        Self {
            policy,
            dynamic_tools: Vec::new(),
        }
    }

    pub fn with_dynamic_tools(
        mut self,
        dynamic_tools: Vec<ToolRegistryEntry>,
    ) -> Result<Self, String> {
        let mut known_ids = builtin_tool_entries()
            .into_iter()
            .map(|entry| entry.tool_id)
            .collect::<std::collections::BTreeSet<_>>();
        let mut known_methods = builtin_tool_entries()
            .into_iter()
            .map(|entry| entry.method)
            .collect::<std::collections::BTreeSet<_>>();
        for tool in &dynamic_tools {
            if !known_ids.insert(tool.tool_id.clone()) {
                return Err(format!("duplicate tool ID in registry: {}", tool.tool_id));
            }
            if !known_methods.insert(tool.method.clone()) {
                return Err(format!(
                    "duplicate tool method in registry: {}",
                    tool.method
                ));
            }
        }
        self.dynamic_tools = dynamic_tools;
        Ok(self)
    }

    pub fn list_tools(&self) -> ToolRegistryListResult {
        let tools = builtin_tool_entries()
            .into_iter()
            .chain(self.dynamic_tools.clone())
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
                .cmp(&right.namespace)
                .then_with(|| left.method.cmp(&right.method))
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

pub fn mcp_tool_registry_entries(
    server_name: &str,
    server_config: &Value,
    discovered_tools: &[Value],
) -> Result<Vec<ToolRegistryEntry>, String> {
    let server_name = server_name.trim();
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

fn builtin_tool_entries() -> Vec<ToolRegistryEntry> {
    vec![
        runtime_control_tool(
            TOOL_SEARCH_METHOD,
            "tool_registry",
            "Search deferred tools",
            "Search available deferred tools and activate matching tools for this turn.",
            ToolRuntimeControl::ToolSearch,
            runtime_policy(false, ToolCancellationMode::Cooperative, false, false),
            Vec::new(),
            json!({
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": { "type": "string" },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_TOOL_SEARCH_LIMIT,
                        "default": DEFAULT_TOOL_SEARCH_LIMIT
                    }
                },
                "additionalProperties": false
            }),
        ),
        runtime_control_tool(
            REQUEST_USER_INPUT_METHOD,
            "interaction",
            "Request user input",
            "Pause the current run and ask the user to complete a structured form when required information cannot be inferred safely.",
            ToolRuntimeControl::RequestUserInput,
            runtime_policy(false, ToolCancellationMode::Cooperative, false, true),
            vec![WorkerCapability::FormRequest],
            json!({
                "type": "object",
                "required": ["title", "fields"],
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 256 },
                    "description": { "type": "string", "maxLength": 1024 },
                    "submit_label": { "type": "string", "maxLength": 128 },
                    "cancel_label": { "type": "string", "maxLength": 128 },
                    "fields": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 50,
                        "items": {
                            "type": "object",
                            "required": ["name", "type", "label"],
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 64,
                                    "pattern": "^[A-Za-z_][A-Za-z0-9_.-]*$"
                                },
                                "type": {
                                    "type": "string",
                                    "enum": [
                                        "text",
                                        "textarea",
                                        "number",
                                        "select",
                                        "multiselect",
                                        "radio",
                                        "checkbox"
                                    ]
                                },
                                "label": { "type": "string", "minLength": 1, "maxLength": 256 },
                                "required": { "type": "boolean", "default": false },
                                "placeholder": { "type": "string", "maxLength": 512 },
                                "help": { "type": "string", "maxLength": 512 },
                                "options": {
                                    "type": "array",
                                    "minItems": 1,
                                    "maxItems": 100,
                                    "items": {
                                        "type": "object",
                                        "required": ["label", "value"],
                                        "properties": {
                                            "label": { "type": "string", "minLength": 1, "maxLength": 256 },
                                            "value": { "type": "string", "maxLength": 2000 }
                                        },
                                        "additionalProperties": false
                                    }
                                }
                            },
                            "additionalProperties": false
                        }
                    }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "workspace.read_file",
            "workspace",
            "Read workspace file",
            "Read a file under the current workspace.",
            ToolExposure::Model,
            false,
            runtime_policy(true, ToolCancellationMode::Cooperative, false, false),
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
            ToolExposure::Deferred,
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
            ToolExposure::Deferred,
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
        tool(
            "knowledge.query",
            "knowledge",
            "Query knowledge",
            "Search the local knowledge index.",
            ToolExposure::Model,
            false,
            runtime_policy(true, ToolCancellationMode::Cooperative, false, false),
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
            runtime_policy(true, ToolCancellationMode::Cooperative, false, false),
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
            runtime_policy(true, ToolCancellationMode::Cooperative, false, false),
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
        ),
        tool(
            "shell.execute",
            "shell",
            "Execute shell command",
            "Run a shell command in the workspace.",
            ToolExposure::Deferred,
            false,
            runtime_policy(false, ToolCancellationMode::TerminateProcess, true, false),
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
            runtime_policy(false, ToolCancellationMode::DetachForbidden, false, true),
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
            runtime_policy(false, ToolCancellationMode::DetachForbidden, false, true),
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
        tool_id: method.to_string(),
        method: method.to_string(),
        namespace: namespace.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        exposure,
        dynamic,
        supports_parallel_tool_calls: runtime_policy.supports_parallel_tool_calls,
        runtime_policy,
        required_capabilities,
        available: false,
        approval,
        input_schema,
        output_schema: json!({ "type": "object" }),
        execution_target: ToolExecutionTarget::WorkerRpc {
            method: method.to_string(),
        },
    }
}

fn runtime_control_tool(
    method: &'static str,
    namespace: &'static str,
    title: &'static str,
    description: &'static str,
    control: ToolRuntimeControl,
    runtime_policy: ToolRuntimePolicy,
    required_capabilities: Vec<WorkerCapability>,
    input_schema: Value,
) -> ToolRegistryEntry {
    ToolRegistryEntry {
        tool_id: method.to_string(),
        method: method.to_string(),
        namespace: namespace.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        exposure: ToolExposure::Model,
        dynamic: false,
        supports_parallel_tool_calls: runtime_policy.supports_parallel_tool_calls,
        runtime_policy,
        required_capabilities,
        available: false,
        approval: approval(false, None, None),
        input_schema,
        output_schema: json!({ "type": "object" }),
        execution_target: ToolExecutionTarget::RuntimeControl(control),
    }
}

fn runtime_policy(
    supports_parallel_tool_calls: bool,
    cancellation_mode: ToolCancellationMode,
    mutates_workspace: bool,
    mutates_session: bool,
) -> ToolRuntimePolicy {
    ToolRuntimePolicy {
        supports_parallel_tool_calls,
        cancellation_mode,
        cleanup_timeout_ms: match cancellation_mode {
            ToolCancellationMode::Cooperative => 100,
            ToolCancellationMode::TerminateProcess | ToolCancellationMode::DetachForbidden => 2_000,
        },
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn apply_patch_is_deferred_and_approval_required() {
        let tool = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceWrite,
            WorkerCapability::ApprovalRequest,
        ]))
        .get_tool("workspace.apply_patch")
        .expect("workspace.apply_patch should be registered");

        assert_eq!(tool.exposure, ToolExposure::Deferred);
        assert!(tool.available);
        assert!(tool.approval.required);
        assert!(tool.runtime_policy.mutates_workspace);
        assert_eq!(
            tool.execution_target,
            ToolExecutionTarget::WorkerRpc {
                method: "workspace.apply_patch".to_string()
            }
        );
    }

    #[test]
    fn discovered_mcp_tool_becomes_deferred_registry_entry() {
        let entries = mcp_tool_registry_entries(
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
        .expect("valid MCP definition should normalize");

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
        let error = mcp_tool_registry_entries(
            "docs",
            &json!({}),
            &[json!({ "name": "bad", "inputSchema": { "type": "string" } })],
        )
        .expect_err("non-object MCP input schema must fail");

        assert!(error.contains("input schema type must be object"));
    }
}
