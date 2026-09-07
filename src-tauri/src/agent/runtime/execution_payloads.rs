use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAgentToolCall {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<PendingToolStatus>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingToolStatus {
    Queued,
    Running,
}

impl PendingAgentToolCall {
    pub(super) fn new(call: &super::NativeAgentToolCall) -> Self {
        Self {
            tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            arguments_json: call.arguments_json.clone(),
            parallel_mode: None,
            status: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolResultStatus {
    Ok,
    Error,
    Denied,
}

impl std::str::FromStr for AgentToolResultStatus {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "ok" => Ok(Self::Ok),
            "error" => Ok(Self::Error),
            "denied" => Ok(Self::Denied),
            _ => Err(format!("unsupported tool result status `{value}`")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedAgentToolResult {
    pub tool_call_id: String,
    pub tool_name: String,
    pub status: AgentToolResultStatus,
    /// Tool-specific data remains extensible; orchestration never infers identity from it.
    pub envelope: super::NativeToolResultEnvelope,
}

#[derive(Clone, Debug, Serialize)]
pub struct TerminalAgentTurn {
    pub status: crate::threads::turn::AgentTurnStatus,
    pub phase: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum AgentCancellationCleanup {
    Timeout {
        #[serde(rename = "timeoutMs")]
        timeout_ms: u128,
    },
}
