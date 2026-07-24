use crate::protocol::capability::WorkerCapability;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::tools::permissions::PermissionToolEvaluation;
use crate::tools::registry::{ToolApprovalMetadata, ToolExposure, ToolRegistryEntry};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutorExecuteRequest {
    #[serde(alias = "toolId")]
    pub tool_id: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default, alias = "threadId")]
    pub thread_id: Option<String>,
    #[serde(default, alias = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, alias = "turnId")]
    pub turn_id: Option<String>,
    #[serde(default, alias = "toolCallId")]
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutorExecuteResult {
    pub tool_id: String,
    pub method: String,
    pub namespace: String,
    pub exposure: ToolExposure,
    pub dynamic: bool,
    pub approval: ToolApprovalMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub appended_items: Vec<Value>,
    pub permission: PermissionToolEvaluation,
    pub result: Value,
}

impl ToolExecutorExecuteResult {
    pub fn new(
        tool: &ToolRegistryEntry,
        request: &ToolExecutorExecuteRequest,
        tool_call_id: Option<String>,
        appended_items: Vec<Value>,
        permission: PermissionToolEvaluation,
        result: Value,
    ) -> Self {
        Self {
            tool_id: tool.tool_id.to_string(),
            method: tool.method.to_string(),
            namespace: tool.namespace.to_string(),
            exposure: tool.exposure,
            dynamic: tool.dynamic,
            approval: tool.approval.clone(),
            thread_id: request.thread_id.clone(),
            turn_id: request.turn_id.clone(),
            tool_call_id,
            appended_items,
            permission,
            result,
        }
    }
}

pub fn tool_not_found_error(tool_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "registered tool not found",
        serde_json::json!({
            "method": "tool_executor.execute",
            "toolId": tool_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub fn tool_unavailable_error(
    tool: &ToolRegistryEntry,
    missing_capabilities: Vec<WorkerCapability>,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::CapabilityDenied,
        "registered tool is unavailable",
        serde_json::json!({
            "method": "tool_executor.execute",
            "toolId": tool.tool_id,
            "targetMethod": tool.method,
            "missingCapabilities": missing_capabilities,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
