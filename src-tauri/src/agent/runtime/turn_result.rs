use super::instructions::{InstructionDiagnostic, InstructionProvenance};
use crate::agent::runtime_protocol::{
    AgentRuntimeEventEnvelope, AgentRuntimePhase, AgentTraceContext,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Why an execution attempt stopped. Waiting reasons do not terminate the Turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStopReason {
    FinalResponse,
    ContextCompacted,
    Cancelled,
    Interrupted,
    RuntimeRestarted,
    AwaitingForm,
    AwaitingTool,
    ToolRunning,
    AwaitingSubagent,
    MaxIterations,
    InvalidRequest,
    ProviderRequestTimeout,
    ProviderStreamIdleTimeout,
    ProviderTransportError,
    ProviderError,
    ContextCompactionCommitFailed,
    ContextCompactionNotNeeded,
    HookDenied,
    ToolError,
    ToolCleanupTimeout,
    FormCancelled,
    RuntimeError,
    TerminalTurn,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentExecutionStatus {
    Completed,
    Waiting,
    Cancelled,
    Interrupted,
    Failed,
}

impl AgentExecutionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Waiting => "waiting",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
        }
    }
}

impl AgentStopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FinalResponse => "final_response",
            Self::ContextCompacted => "context_compacted",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::RuntimeRestarted => "runtime_restarted",
            Self::AwaitingForm => "awaiting_form",
            Self::AwaitingTool => "awaiting_tool",
            Self::ToolRunning => "tool_running",
            Self::AwaitingSubagent => "awaiting_subagent",
            Self::MaxIterations => "max_iterations",
            Self::InvalidRequest => "invalid_request",
            Self::ProviderRequestTimeout => "provider_request_timeout",
            Self::ProviderStreamIdleTimeout => "provider_stream_idle_timeout",
            Self::ProviderTransportError => "provider_transport_error",
            Self::ProviderError => "provider_error",
            Self::ContextCompactionCommitFailed => "context_compaction_commit_failed",
            Self::ContextCompactionNotNeeded => "context_compaction_not_needed",
            Self::HookDenied => "hook_denied",
            Self::ToolError => "tool_error",
            Self::ToolCleanupTimeout => "tool_cleanup_timeout",
            Self::FormCancelled => "form_cancelled",
            Self::RuntimeError => "runtime_error",
            Self::TerminalTurn => "terminal_turn",
        }
    }

    pub fn status(self) -> AgentExecutionStatus {
        match self {
            Self::FinalResponse | Self::ContextCompacted => AgentExecutionStatus::Completed,
            Self::Cancelled => AgentExecutionStatus::Cancelled,
            Self::Interrupted | Self::RuntimeRestarted => AgentExecutionStatus::Interrupted,
            Self::AwaitingForm
            | Self::AwaitingTool
            | Self::ToolRunning
            | Self::AwaitingSubagent => AgentExecutionStatus::Waiting,
            Self::MaxIterations
            | Self::InvalidRequest
            | Self::ProviderRequestTimeout
            | Self::ProviderStreamIdleTimeout
            | Self::ProviderTransportError
            | Self::ProviderError
            | Self::ContextCompactionCommitFailed
            | Self::ContextCompactionNotNeeded
            | Self::HookDenied
            | Self::ToolError
            | Self::ToolCleanupTimeout
            | Self::FormCancelled
            | Self::RuntimeError
            | Self::TerminalTurn => AgentExecutionStatus::Failed,
        }
    }

    pub fn phase(self) -> &'static str {
        match self {
            Self::AwaitingForm => "awaiting_form",
            Self::AwaitingTool | Self::ToolRunning => "tool_running",
            Self::AwaitingSubagent => "awaiting_subagent",
            Self::FinalResponse
            | Self::ContextCompacted
            | Self::Cancelled
            | Self::Interrupted
            | Self::RuntimeRestarted
            | Self::MaxIterations
            | Self::InvalidRequest
            | Self::ProviderRequestTimeout
            | Self::ProviderStreamIdleTimeout
            | Self::ProviderTransportError
            | Self::ProviderError
            | Self::ContextCompactionCommitFailed
            | Self::ContextCompactionNotNeeded
            | Self::HookDenied
            | Self::ToolError
            | Self::ToolCleanupTimeout
            | Self::FormCancelled
            | Self::RuntimeError
            | Self::TerminalTurn => self.status().as_str(),
        }
    }

    pub(crate) fn runtime_phase(self) -> AgentRuntimePhase {
        match self {
            Self::FinalResponse => AgentRuntimePhase::Completed,
            Self::ContextCompacted => AgentRuntimePhase::Completed,
            Self::Cancelled => AgentRuntimePhase::Cancelled,
            Self::Interrupted => AgentRuntimePhase::Cancelled,
            Self::RuntimeRestarted => AgentRuntimePhase::Cancelled,
            Self::AwaitingForm => AgentRuntimePhase::AwaitingForm,
            Self::AwaitingTool => AgentRuntimePhase::ToolRunning,
            Self::ToolRunning => AgentRuntimePhase::ToolRunning,
            Self::AwaitingSubagent => AgentRuntimePhase::AwaitingSubagent,
            Self::MaxIterations => AgentRuntimePhase::Failed,
            Self::InvalidRequest => AgentRuntimePhase::Failed,
            Self::ProviderRequestTimeout => AgentRuntimePhase::Failed,
            Self::ProviderStreamIdleTimeout => AgentRuntimePhase::Failed,
            Self::ProviderTransportError => AgentRuntimePhase::Failed,
            Self::ProviderError => AgentRuntimePhase::Failed,
            Self::ContextCompactionCommitFailed => AgentRuntimePhase::Failed,
            Self::ContextCompactionNotNeeded => AgentRuntimePhase::Failed,
            Self::HookDenied => AgentRuntimePhase::Failed,
            Self::ToolError => AgentRuntimePhase::Failed,
            Self::ToolCleanupTimeout => AgentRuntimePhase::Failed,
            Self::FormCancelled => AgentRuntimePhase::Failed,
            Self::RuntimeError => AgentRuntimePhase::Failed,
            Self::TerminalTurn => AgentRuntimePhase::Failed,
        }
    }
}

/// The existing wire error shapes, retained without hiding the structured code.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum AgentResultError {
    Message(String),
    Coded {
        code: AgentStopReason,
        message: String,
    },
}

impl AgentResultError {
    pub fn message(&self) -> &str {
        match self {
            Self::Message(message) | Self::Coded { message, .. } => message,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnMetrics {
    pub turn_duration_ms: u64,
    pub outcome: &'static str,
}

/// Internal execution result. Serialize only when returning a protocol response.
/// Checkpoint and legacy message payloads retain their existing storage schemas.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnResult {
    pub runtime: &'static str,
    pub turn_id: String,
    pub session_id: String,
    pub final_content: String,
    pub stop_reason: AgentStopReason,
    pub messages: Vec<Value>,
    pub tools_used: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_tool_results: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentResultError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_checkpoint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_checkpoint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_turn: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_events: Option<Vec<AgentRuntimeEventEnvelope>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_context: Option<AgentTraceContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_metrics: Option<AgentTurnMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction_provenance: Option<InstructionProvenance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction_diagnostics: Option<Vec<InstructionDiagnostic>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_persistence: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancellation_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancellation_cleanup: Option<Value>,
}

impl AgentTurnResult {
    pub fn new(turn_id: &str, session_id: &str, stop_reason: AgentStopReason) -> Self {
        Self {
            runtime: "rust",
            turn_id: turn_id.to_string(),
            session_id: session_id.to_string(),
            stop_reason,
            final_content: String::new(),
            messages: Vec::new(),
            tools_used: Vec::new(),
            completed_tool_results: None,
            error: None,
            checkpoint: None,
            context_checkpoint: None,
            restored_checkpoint: None,
            continuation: None,
            form: None,
            terminal_turn: None,
            runtime_events: None,
            trace_context: None,
            turn_metrics: None,
            instruction_provenance: None,
            instruction_diagnostics: None,
            turn_persistence: None,
            cancellation_reason: None,
            cancellation_cleanup: None,
        }
    }

    pub fn into_value(self) -> Result<Value, String> {
        serde_json::to_value(self)
            .map_err(|error| format!("failed to serialize agent turn result: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_results_keep_their_resumable_phase() {
        for (reason, phase) in [
            (AgentStopReason::AwaitingForm, "awaiting_form"),
            (AgentStopReason::AwaitingTool, "tool_running"),
            (AgentStopReason::ToolRunning, "tool_running"),
            (AgentStopReason::AwaitingSubagent, "awaiting_subagent"),
        ] {
            assert_eq!(reason.status(), AgentExecutionStatus::Waiting);
            assert_eq!(reason.phase(), phase);
            assert_eq!(reason.runtime_phase().as_str(), phase);
        }
    }

    #[test]
    fn stop_reason_wire_values_reject_unknown_states() {
        assert_eq!(
            serde_json::from_value::<AgentStopReason>(serde_json::json!("awaiting_subagent"))
                .unwrap(),
            AgentStopReason::AwaitingSubagent,
        );
        assert!(
            serde_json::from_value::<AgentStopReason>(serde_json::json!("awaitng_subagent"))
                .is_err()
        );
    }

    #[test]
    fn result_serialization_preserves_wire_fields_and_error_shapes() {
        let mut result = AgentTurnResult::new(
            "turn-1",
            "thread-1",
            AgentStopReason::ProviderRequestTimeout,
        );
        result.error = Some(AgentResultError::Message("request timed out".to_string()));
        let value = result.clone().into_value().unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-1",
                "sessionId": "thread-1",
                "finalContent": "",
                "stopReason": "provider_request_timeout",
                "messages": [],
                "toolsUsed": [],
                "error": "request timed out",
            })
        );
        result.stop_reason = AgentStopReason::RuntimeError;
        result.error = Some(AgentResultError::Coded {
            code: AgentStopReason::RuntimeError,
            message: "trace flush failed".to_string(),
        });
        let value = result.into_value().unwrap();
        assert_eq!(
            value["error"],
            serde_json::json!({
                "code": "runtime_error",
                "message": "trace flush failed",
            })
        );
    }
}
