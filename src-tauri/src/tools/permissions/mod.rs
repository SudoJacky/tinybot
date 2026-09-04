use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::tools::registry::{ToolExposure, ToolRegistryEntry};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod effects;
#[cfg(test)]
mod effects_tests;

#[cfg(test)]
pub use effects::PermissionNetworkMode;
pub use effects::{normalize_tool_effects, PermissionEffects};

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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileSnapshot {
    pub profile_id: &'static str,
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
    pub missing_capabilities: Vec<WorkerCapability>,
    pub effects: PermissionEffects,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolDecision {
    pub tool_id: String,
    pub method: String,
    pub namespace: String,
    pub exposure: ToolExposure,
    pub decision: PermissionDecision,
    pub missing_capabilities: Vec<WorkerCapability>,
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
    Deny,
}

impl WorkerPermissionProfileRpc {
    pub fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    pub fn current_profile(&self, tools: Vec<ToolRegistryEntry>) -> PermissionProfileSnapshot {
        PermissionProfileSnapshot {
            profile_id: "local-worker",
            sandbox: PermissionSandboxSummary {
                mode: "none",
                filesystem: "current_user",
                network: "current_user",
                process: "current_user",
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
        Ok(PermissionToolEvaluation {
            tool: tool_summary(tool),
            decision: decision_for_tool(&missing_capabilities),
            missing_capabilities,
            effects,
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
            decision: decision_for_tool(&missing_capabilities),
            missing_capabilities,
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

fn decision_for_tool(missing_capabilities: &[WorkerCapability]) -> PermissionDecision {
    if missing_capabilities.is_empty() {
        PermissionDecision::Allow
    } else {
        PermissionDecision::Deny
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

fn capability_scope(capability: &WorkerCapability) -> &'static str {
    match capability {
        WorkerCapability::FsWorkspaceRead | WorkerCapability::FsWorkspaceWrite => {
            "workspace://current"
        }
        WorkerCapability::NetworkOpenAi => "network://openai",
        WorkerCapability::ProviderSecretRead => "provider://runtime",
        WorkerCapability::FormRequest => "agent-ui://current",
        WorkerCapability::TaskRead | WorkerCapability::TaskWrite => "task://plans",
        WorkerCapability::CronRead | WorkerCapability::CronWrite | WorkerCapability::CronRun => {
            "cron://jobs"
        }
        WorkerCapability::BackgroundRead | WorkerCapability::BackgroundWrite => {
            "background://registry"
        }
        WorkerCapability::McpCall => "mcp://configured",
        WorkerCapability::McpConfigWrite => "mcp://configuration",
        WorkerCapability::ShellExecute => "process://current-user",
        WorkerCapability::ConfigRead | WorkerCapability::ConfigWrite => "config://workspace",
        WorkerCapability::SessionMetadataRead | WorkerCapability::SessionWrite => {
            "session://workspace"
        }
        WorkerCapability::DiagnosticsWrite => "diagnostics://worker",
        WorkerCapability::ChannelConnector => "channel://connector",
        WorkerCapability::BrowserObserve | WorkerCapability::BrowserInteract => "browser://session",
    }
}
