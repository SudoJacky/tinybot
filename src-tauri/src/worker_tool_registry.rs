use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
mod contributors;

use contributors::default_tool_contributors;
#[cfg(test)]
use contributors::workspace_tool_entries;
pub use contributors::{McpToolContributor, ToolContributor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

pub const TOOL_SEARCH_METHOD: &str = "tool_search";
pub const REQUEST_USER_INPUT_METHOD: &str = "request_user_input";
pub const UPDATE_PLAN_METHOD: &str = "update_plan";
pub const DEFAULT_TOOL_SEARCH_LIMIT: usize = 5;
pub const MAX_TOOL_SEARCH_LIMIT: usize = 20;

#[derive(Clone, Debug)]
pub struct WorkerToolRegistryRpc {
    policy: CapabilityPolicy,
    config_snapshot: Value,
    contributors: Vec<Arc<dyn ToolContributor>>,
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
    UpdatePlan,
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
        Self::new_with_config(policy, Value::Null)
    }

    pub fn new_with_config(policy: CapabilityPolicy, config_snapshot: Value) -> Self {
        Self {
            policy,
            config_snapshot,
            contributors: default_tool_contributors(),
        }
    }

    pub fn update_config_snapshot(&mut self, config_snapshot: Value) {
        self.config_snapshot = config_snapshot;
    }

    pub fn with_contributor(
        mut self,
        contributor: Arc<dyn ToolContributor>,
    ) -> Result<Self, String> {
        let contributor_id = contributor.id().trim();
        if contributor_id.is_empty() {
            return Err("tool contributor ID must not be empty".to_string());
        }
        if self
            .contributors
            .iter()
            .any(|existing| existing.id().trim() == contributor_id)
        {
            return Err(format!("duplicate tool contributor ID: {contributor_id}"));
        }
        let mut known_ids = self
            .contributed_tools()
            .into_iter()
            .map(|entry| entry.tool_id)
            .collect::<std::collections::BTreeSet<_>>();
        let mut known_methods = self
            .contributed_tools()
            .into_iter()
            .map(|entry| entry.method)
            .collect::<std::collections::BTreeSet<_>>();
        for tool in contributor.contribute() {
            if !known_ids.insert(tool.tool_id.clone()) {
                return Err(format!(
                    "tool contributor `{contributor_id}` produced duplicate tool ID `{}`",
                    tool.tool_id
                ));
            }
            if !known_methods.insert(tool.method.clone()) {
                return Err(format!(
                    "tool contributor `{contributor_id}` produced duplicate tool method `{}`",
                    tool.method
                ));
            }
        }
        self.contributors.push(contributor);
        Ok(self)
    }

    pub fn list_tools(&self) -> ToolRegistryListResult {
        let tools = self
            .contributed_tools()
            .into_iter()
            .map(|mut tool| {
                tool.available = tool
                    .required_capabilities
                    .iter()
                    .all(|capability| self.policy.allows(capability))
                    && tool_enabled_by_config(&tool, &self.config_snapshot);
                tool
            })
            .collect::<Vec<_>>();
        ToolRegistryListResult {
            total: tools.len(),
            tools,
        }
    }

    pub fn contributor_ids(&self) -> Vec<String> {
        self.contributors
            .iter()
            .map(|contributor| contributor.id().to_string())
            .collect()
    }

    pub fn contributor_id_for_tool(&self, tool_id: &str) -> Option<String> {
        let tool_id = tool_id.trim();
        self.contributors.iter().find_map(|contributor| {
            contributor
                .contribute()
                .into_iter()
                .any(|entry| entry.tool_id == tool_id || entry.method == tool_id)
                .then(|| contributor.id().to_string())
        })
    }

    fn contributed_tools(&self) -> Vec<ToolRegistryEntry> {
        self.contributors
            .iter()
            .flat_map(|contributor| contributor.contribute())
            .collect()
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

fn tool_enabled_by_config(tool: &ToolRegistryEntry, config_snapshot: &Value) -> bool {
    if matches!(
        tool.method.as_str(),
        "shell.execute" | "shell.start" | "exec_command"
    ) {
        return config_snapshot
            .pointer("/tools/exec/enable")
            .and_then(Value::as_bool)
            != Some(false);
    }
    true
}

fn tool_matches_query(tool: &ToolRegistryEntry, query: &str) -> bool {
    tool.tool_id.to_lowercase().contains(query)
        || tool.method.to_lowercase().contains(query)
        || tool.namespace.to_lowercase().contains(query)
        || tool.title.to_lowercase().contains(query)
        || tool.description.to_lowercase().contains(query)
}

fn core_tool_entries() -> Vec<ToolRegistryEntry> {
    vec![
        runtime_control_tool(
            UPDATE_PLAN_METHOD,
            "planning",
            "Update task plan",
            "Update the execution checklist for a non-trivial task. Submit the complete current plan on every call. Each step must have a short step description and a status of pending, in_progress, or completed. Until all steps are completed, exactly one step must be in_progress. Provide explanation when revising the plan. Do not repeat the full plan in a message because the timeline renders it.",
            ToolRuntimeControl::UpdatePlan,
            runtime_policy(false, ToolCancellationMode::Cooperative, false, true),
            Vec::new(),
            json!({
                "type": "object",
                "required": ["plan"],
                "properties": {
                    "explanation": { "type": "string", "minLength": 1, "maxLength": 1024 },
                    "plan": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 50,
                        "items": {
                            "type": "object",
                            "required": ["step", "status"],
                            "properties": {
                                "step": { "type": "string", "minLength": 1, "maxLength": 512 },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"]
                                }
                            },
                            "additionalProperties": false
                        }
                    }
                },
                "additionalProperties": false
            }),
        ),
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
                    "timeout": { "type": "integer" },
                    "sandboxMode": {
                        "type": "string",
                        "enum": ["read_only", "unsandboxed"]
                    },
                    "networkMode": {
                        "type": "string",
                        "enum": ["denied", "configured", "unrestricted"]
                    }
                }
            }),
        ),
        worker_rpc_tool(
            "exec_command",
            "shell.start",
            "shell",
            "Start shell command",
            "Start a workspace shell command and retain it when it remains active.",
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
                    "yieldTimeMs": { "type": "integer", "minimum": 0, "maximum": 30000 },
                    "tty": { "type": "boolean" },
                    "rows": { "type": "integer", "minimum": 1 },
                    "cols": { "type": "integer", "minimum": 1 },
                    "sandboxMode": {
                        "type": "string",
                        "enum": ["read_only", "unsandboxed"]
                    },
                    "networkMode": {
                        "type": "string",
                        "enum": ["denied", "configured", "unrestricted"]
                    }
                }
            }),
        ),
        worker_rpc_tool(
            "write_stdin",
            "shell.write_stdin",
            "shell",
            "Write shell input",
            "Write input to a retained shell process and return newly available output.",
            ToolExposure::Deferred,
            false,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, true, false),
            vec![WorkerCapability::ShellExecute],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["processId"],
                "properties": {
                    "processId": { "type": "string" },
                    "input": { "type": "string" },
                    "cursor": { "type": "integer", "minimum": 0 },
                    "yieldTimeMs": { "type": "integer", "minimum": 0, "maximum": 30000 }
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
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["task"],
                "properties": {
                    "sessionKey": { "type": "string" },
                    "subagentId": { "type": "string" },
                    "task": { "type": "string" },
                    "historyMode": {
                        "type": "string",
                        "enum": ["isolated", "parent_turn", "full_history"]
                    },
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
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["subagentId", "content"],
                "properties": {
                    "sessionKey": { "type": "string" },
                    "subagentId": { "type": "string" },
                    "content": { "type": "string" },
                    "sender": { "type": "string" }
                }
            }),
        ),
        tool(
            "subagent.wait",
            "subagent",
            "Wait for subagent",
            "Wait until a selected child agent reaches a result or input boundary.",
            ToolExposure::Model,
            false,
            runtime_policy(false, ToolCancellationMode::Cooperative, false, false),
            vec![
                WorkerCapability::BackgroundRead,
                WorkerCapability::SessionMetadataRead,
            ],
            approval(false, None, None),
            json!({
                "type": "object",
                "properties": {
                    "sessionKey": { "type": "string" },
                    "subagentIds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 1
                    },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 30000 }
                }
            }),
        ),
        tool(
            "subagent.close",
            "subagent",
            "Close subagent",
            "Explicitly close a retained child agent. Closed children cannot be resumed.",
            ToolExposure::Model,
            false,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, false, true),
            vec![
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["subagentId"],
                "properties": {
                    "sessionKey": { "type": "string" },
                    "subagentId": { "type": "string" }
                }
            }),
        ),
        tool(
            "subagent.resume",
            "subagent",
            "Resume subagent",
            "Resume one interrupted child agent after runtime restart.",
            ToolExposure::Model,
            false,
            runtime_policy(false, ToolCancellationMode::DetachForbidden, false, true),
            vec![
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ],
            approval(false, None, None),
            json!({
                "type": "object",
                "required": ["subagentId"],
                "properties": {
                    "sessionKey": { "type": "string" },
                    "subagentId": { "type": "string" }
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

#[allow(clippy::too_many_arguments)]
fn worker_rpc_tool(
    method: &'static str,
    target_method: &'static str,
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
    let mut entry = tool(
        method,
        namespace,
        title,
        description,
        exposure,
        dynamic,
        runtime_policy,
        required_capabilities,
        approval,
        input_schema,
    );
    entry.execution_target = ToolExecutionTarget::WorkerRpc {
        method: target_method.to_string(),
    };
    entry
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

        assert_eq!(start.exposure, ToolExposure::Deferred);
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
        assert_eq!(input.exposure, ToolExposure::Deferred);
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
    fn model_registry_exposes_complete_subagent_lifecycle_controls() {
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
            assert_eq!(tool.exposure, ToolExposure::Model);
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
    fn workspace_and_mcp_tools_are_owned_by_named_contributors() {
        let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::McpCall,
        ]));
        assert_eq!(
            registry.contributor_id_for_tool("workspace.read_file"),
            Some("builtin.workspace".to_string())
        );
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
        assert!(error.contains("workspace.read_file"));
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
}
