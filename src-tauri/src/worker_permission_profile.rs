use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_tool_registry::{
    ToolApprovalMetadata, ToolExecutionTarget, ToolExposure, ToolRegistryEntry,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod effects;
#[cfg(test)]
mod effects_tests;

pub use effects::{
    mcp_permission_effects, normalize_permission_effects, normalize_permission_path,
    normalize_tool_effects, permission_fingerprint, shell_permission_effects,
    workspace_patch_permission_effects, workspace_write_permission_effects, PermissionEffects,
    PermissionNetworkMode, ShellSandboxMode,
};

#[derive(Clone, Debug)]
pub struct WorkerPermissionProfileRpc {
    policy: CapabilityPolicy,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEvaluateToolRequest {
    #[serde(alias = "toolId")]
    pub tool_id: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default, alias = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestToolApprovalRequest {
    #[serde(alias = "toolId")]
    pub tool_id: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default, alias = "threadId")]
    pub thread_id: Option<String>,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
    #[serde(default, alias = "turnId")]
    pub turn_id: Option<String>,
    #[serde(default, alias = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, alias = "clientEventId")]
    pub client_event_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResolveToolApprovalRequest {
    #[serde(alias = "approvalId")]
    pub approval_id: String,
    pub approved: bool,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(alias = "sessionId")]
    pub session_id: String,
    #[serde(default, alias = "threadId")]
    pub thread_id: Option<String>,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
    #[serde(default, alias = "turnId")]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub guidance: Option<String>,
    #[serde(default, alias = "clientEventId")]
    pub client_event_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileSnapshot {
    pub profile_id: &'static str,
    pub approval_policy: &'static str,
    pub sandbox: PermissionSandboxSummary,
    pub capabilities: Vec<PermissionCapabilityState>,
    pub tools: Vec<PermissionToolDecision>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSandboxSummary {
    pub mode: &'static str,
    pub filesystem: &'static str,
    pub network: &'static str,
    pub process: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionCapabilityState {
    pub capability: WorkerCapability,
    pub granted: bool,
    pub scope: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolEvaluation {
    pub tool: PermissionToolSummary,
    pub decision: PermissionDecision,
    pub requires_approval: bool,
    pub missing_capabilities: Vec<WorkerCapability>,
    pub approval: ToolApprovalMetadata,
    pub effects: PermissionEffects,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_request: Option<PermissionApprovalRequest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolDecision {
    pub tool_id: String,
    pub method: String,
    pub namespace: String,
    pub exposure: ToolExposure,
    pub decision: PermissionDecision,
    pub requires_approval: bool,
    pub missing_capabilities: Vec<WorkerCapability>,
    pub approval: ToolApprovalMetadata,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolSummary {
    pub tool_id: String,
    pub method: String,
    pub namespace: String,
    pub exposure: ToolExposure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    NeedsApproval,
    Deny,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionApprovalRequest {
    pub method: String,
    pub tool_id: String,
    pub category: &'static str,
    pub risk: &'static str,
    pub reason: String,
    pub summary: String,
    pub scope: Option<&'static str>,
    pub lifetime: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub fingerprint: String,
    pub session_fingerprint: String,
    pub effects: PermissionEffects,
    pub operation: Value,
}

impl WorkerPermissionProfileRpc {
    pub fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    pub fn current_profile(&self, tools: Vec<ToolRegistryEntry>) -> PermissionProfileSnapshot {
        PermissionProfileSnapshot {
            profile_id: "local-worker",
            approval_policy: "on_request",
            sandbox: PermissionSandboxSummary {
                mode: sandbox_mode(&self.policy),
                filesystem: filesystem_scope(&self.policy),
                network: network_scope(&self.policy),
                process: process_scope(&self.policy),
            },
            capabilities: self.capability_states(),
            tools: tools.iter().map(|tool| self.tool_decision(tool)).collect(),
        }
    }

    pub fn evaluate_tool(
        &self,
        tool: &ToolRegistryEntry,
        request: PermissionEvaluateToolRequest,
    ) -> Result<PermissionToolEvaluation, WorkerProtocolError> {
        let effects = normalize_tool_effects(tool, &request.arguments)?;
        let missing_capabilities = self.missing_capabilities(tool);
        let decision = decision_for_tool(tool, &missing_capabilities);
        let approval_request = (decision == PermissionDecision::NeedsApproval).then(|| {
            approval_request_for_tool(
                tool,
                request.arguments,
                request.session_id,
                request.run_id,
                effects.clone(),
            )
        });
        Ok(PermissionToolEvaluation {
            tool: tool_summary(tool),
            decision,
            requires_approval: tool.approval.required,
            missing_capabilities,
            approval: tool.approval.clone(),
            effects,
            approval_request,
        })
    }

    pub fn tool_not_found_error(&self, tool_id: &str) -> WorkerProtocolError {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "registered tool not found",
            serde_json::json!({
                "method": "permission_profile.evaluate_tool",
                "toolId": tool_id,
            }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    }

    fn tool_decision(&self, tool: &ToolRegistryEntry) -> PermissionToolDecision {
        let missing_capabilities = self.missing_capabilities(tool);
        PermissionToolDecision {
            tool_id: tool.tool_id.clone(),
            method: tool.method.clone(),
            namespace: tool.namespace.clone(),
            exposure: tool.exposure,
            decision: decision_for_tool(tool, &missing_capabilities),
            requires_approval: tool.approval.required,
            missing_capabilities,
            approval: tool.approval.clone(),
        }
    }

    fn missing_capabilities(&self, tool: &ToolRegistryEntry) -> Vec<WorkerCapability> {
        tool.required_capabilities
            .iter()
            .filter(|capability| !self.policy.allows(capability))
            .cloned()
            .collect()
    }

    fn capability_states(&self) -> Vec<PermissionCapabilityState> {
        self.policy
            .granted_capabilities()
            .into_iter()
            .map(|capability| PermissionCapabilityState {
                scope: capability_scope(&capability).to_string(),
                capability,
                granted: true,
            })
            .collect()
    }
}

fn decision_for_tool(
    tool: &ToolRegistryEntry,
    missing_capabilities: &[WorkerCapability],
) -> PermissionDecision {
    if !missing_capabilities.is_empty() {
        PermissionDecision::Deny
    } else if tool.approval.required {
        PermissionDecision::NeedsApproval
    } else {
        PermissionDecision::Allow
    }
}

fn tool_summary(tool: &ToolRegistryEntry) -> PermissionToolSummary {
    PermissionToolSummary {
        tool_id: tool.tool_id.clone(),
        method: tool.method.clone(),
        namespace: tool.namespace.clone(),
        exposure: tool.exposure,
    }
}

fn approval_request_for_tool(
    tool: &ToolRegistryEntry,
    arguments: Value,
    session_id: Option<String>,
    run_id: Option<String>,
    effects: PermissionEffects,
) -> PermissionApprovalRequest {
    let category = approval_category(tool);
    let risk = approval_risk(tool);
    let summary = approval_summary(tool, &arguments);
    PermissionApprovalRequest {
        method: tool.method.clone(),
        tool_id: tool.tool_id.clone(),
        category,
        risk,
        reason: approval_reason(tool, category),
        summary,
        scope: tool.approval.scope,
        lifetime: tool.approval.lifetime,
        session_id,
        run_id,
        fingerprint: approval_fingerprint(tool, &arguments, &effects),
        session_fingerprint: approval_session_fingerprint(tool, &arguments, &effects),
        effects: effects.clone(),
        operation: serde_json::json!({
            "toolName": tool.tool_id,
            "arguments": arguments,
            "effects": effects,
        }),
    }
}

fn approval_category(tool: &ToolRegistryEntry) -> &'static str {
    match tool.namespace.as_str() {
        "workspace" => "filesystem_write",
        "shell" => "shell",
        "mcp" => "mcp_tool",
        _ => "tool",
    }
}

fn approval_risk(tool: &ToolRegistryEntry) -> &'static str {
    match tool.namespace.as_str() {
        "shell" => "high",
        "workspace" | "mcp" => "medium",
        _ => "low",
    }
}

fn approval_reason(tool: &ToolRegistryEntry, category: &str) -> String {
    match category {
        "filesystem_write" => "Workspace file changes require user approval.".to_string(),
        "shell" => "Shell execution requires user approval.".to_string(),
        "mcp_tool" => "MCP tool calls require user approval.".to_string(),
        _ => format!("{} requires user approval.", tool.title),
    }
}

fn approval_summary(tool: &ToolRegistryEntry, arguments: &Value) -> String {
    if let ToolExecutionTarget::Mcp {
        server,
        tool: tool_name,
    } = &tool.execution_target
    {
        return format!("mcp.call_tool {server}.{tool_name}");
    }
    match tool.method.as_str() {
        "shell.execute" | "exec_command" => arguments
            .get("command")
            .and_then(Value::as_str)
            .map(|command| format!("{} command=\"{}\"", tool.method, normalize_summary(command)))
            .unwrap_or_else(|| tool.method.to_string()),
        "workspace.write_file" | "workspace.delete_file" => arguments
            .get("path")
            .and_then(Value::as_str)
            .map(|path| format!("{} path=\"{}\"", tool.method, path))
            .unwrap_or_else(|| tool.method.to_string()),
        "workspace.apply_patch" | "apply_patch" => tool.method.to_string(),
        "mcp.call_tool" => {
            let server = arguments
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let name = arguments
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("mcp.call_tool {server}.{name}")
        }
        _ => tool.method.to_string(),
    }
}

fn normalize_summary(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn approval_fingerprint(
    tool: &ToolRegistryEntry,
    arguments: &Value,
    effects: &PermissionEffects,
) -> String {
    if let ToolExecutionTarget::Mcp {
        server,
        tool: tool_name,
    } = &tool.execution_target
    {
        return permission_fingerprint("mcp", &format!("{server}.{tool_name}"), effects);
    }
    match tool.method.as_str() {
        "shell.execute" => arguments
            .get("command")
            .and_then(Value::as_str)
            .map(|command| permission_fingerprint("exec", command, effects))
            .unwrap_or_else(|| permission_fingerprint("exec", "", effects)),
        "exec_command" => arguments
            .get("command")
            .and_then(Value::as_str)
            .map(|command| permission_fingerprint("start", command, effects))
            .unwrap_or_else(|| permission_fingerprint("start", "", effects)),
        "workspace.write_file" => arguments
            .get("path")
            .and_then(Value::as_str)
            .map(|path| permission_fingerprint("write_file", &normalize_path(path), effects))
            .unwrap_or_else(|| permission_fingerprint("write_file", "", effects)),
        "workspace.apply_patch" | "apply_patch" => arguments
            .get("patch")
            .and_then(Value::as_str)
            .map(|patch| permission_fingerprint("apply_patch", patch, effects))
            .unwrap_or_else(|| permission_fingerprint("apply_patch", "", effects)),
        "workspace.delete_file" => arguments
            .get("path")
            .and_then(Value::as_str)
            .map(|path| permission_fingerprint("delete_file", &normalize_path(path), effects))
            .unwrap_or_else(|| permission_fingerprint("delete_file", "", effects)),
        "mcp.call_tool" => {
            let server = arguments
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let name = arguments
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            permission_fingerprint("mcp", &format!("{server}.{name}"), effects)
        }
        _ => permission_fingerprint(
            &format!("tool:{}", tool.tool_id),
            &normalize_summary(&arguments.to_string()),
            effects,
        ),
    }
}

fn approval_session_fingerprint(
    tool: &ToolRegistryEntry,
    arguments: &Value,
    effects: &PermissionEffects,
) -> String {
    approval_fingerprint(tool, arguments, effects)
}

fn normalize_path(path: &str) -> String {
    normalize_permission_path(path)
}

fn capability_scope(capability: &WorkerCapability) -> &'static str {
    match capability {
        WorkerCapability::FsWorkspaceRead | WorkerCapability::FsWorkspaceWrite => {
            "workspace://current"
        }
        WorkerCapability::NetworkOpenAi => "network://openai",
        WorkerCapability::ProviderSecretRead => "provider://runtime",
        WorkerCapability::ApprovalRequest | WorkerCapability::ApprovalResolve => {
            "approval://current"
        }
        WorkerCapability::FormRequest => "agent-ui://current",
        WorkerCapability::MemoryRead | WorkerCapability::MemoryWrite => "memory://notes",
        WorkerCapability::TaskRead | WorkerCapability::TaskWrite => "task://plans",
        WorkerCapability::CronRead | WorkerCapability::CronWrite | WorkerCapability::CronRun => {
            "cron://jobs"
        }
        WorkerCapability::BackgroundRead | WorkerCapability::BackgroundWrite => {
            "background://registry"
        }
        WorkerCapability::McpCall => "mcp://configured",
        WorkerCapability::ShellExecute => "process://workspace-shell",
        WorkerCapability::ConfigRead | WorkerCapability::ConfigWrite => "config://workspace",
        WorkerCapability::SessionMetadataRead | WorkerCapability::SessionWrite => {
            "session://workspace"
        }
        WorkerCapability::DiagnosticsWrite => "diagnostics://worker",
        WorkerCapability::ChannelConnector => "channel://connector",
        WorkerCapability::BrowserObserve | WorkerCapability::BrowserInteract => {
            "browser://tinyos-session"
        }
    }
}

fn sandbox_mode(policy: &CapabilityPolicy) -> &'static str {
    if policy.allows(&WorkerCapability::FsWorkspaceWrite) {
        "workspace_write"
    } else if policy.allows(&WorkerCapability::FsWorkspaceRead) {
        "read_only"
    } else {
        "restricted"
    }
}

fn filesystem_scope(policy: &CapabilityPolicy) -> &'static str {
    if policy.allows(&WorkerCapability::FsWorkspaceWrite) {
        "workspace_write"
    } else if policy.allows(&WorkerCapability::FsWorkspaceRead) {
        "workspace_read"
    } else {
        "none"
    }
}

fn network_scope(policy: &CapabilityPolicy) -> &'static str {
    if policy.allows(&WorkerCapability::NetworkOpenAi) || policy.allows(&WorkerCapability::McpCall)
    {
        "configured"
    } else {
        "none"
    }
}

fn process_scope(policy: &CapabilityPolicy) -> &'static str {
    if policy.allows(&WorkerCapability::ShellExecute) {
        "workspace_shell"
    } else {
        "none"
    }
}
