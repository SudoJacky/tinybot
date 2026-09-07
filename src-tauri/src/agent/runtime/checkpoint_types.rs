use super::{AgentStopReason, AgentTurnContext};
use crate::agent::runtime_protocol::{AgentRuntimePhase, AgentTraceContext};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AgentCheckpointPhase {
    Runtime(AgentRuntimePhase),
    Stop(AgentStopReason),
}

impl From<AgentRuntimePhase> for AgentCheckpointPhase {
    fn from(value: AgentRuntimePhase) -> Self {
        Self::Runtime(value)
    }
}
impl From<AgentStopReason> for AgentCheckpointPhase {
    fn from(value: AgentStopReason) -> Self {
        Self::Stop(value)
    }
}
impl AgentCheckpointPhase {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Runtime(phase) => phase.as_str(),
            Self::Stop(reason) => reason.as_str(),
        }
    }
    fn retains_activated_tools(&self) -> bool {
        match self {
            Self::Stop(reason) => reason.status() == super::AgentExecutionStatus::Waiting,
            Self::Runtime(phase) => !matches!(
                phase,
                AgentRuntimePhase::Cancelled
                    | AgentRuntimePhase::Completed
                    | AgentRuntimePhase::Failed
            ),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckpoint {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default = "runtime_name")]
    pub runtime: String,
    #[serde(alias = "turn_id")]
    pub turn_id: String,
    pub session_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub trace_context: Option<AgentTraceContext>,
    pub phase: AgentCheckpointPhase,
    #[serde(default)]
    pub iteration: Option<i64>,
    #[serde(default)]
    pub max_iterations: i64,
    #[serde(default)]
    pub pending_tool_calls: Vec<Value>,
    #[serde(default)]
    pub activated_tool_ids: Vec<String>,
    #[serde(default)]
    pub completed_tool_results: Vec<Value>,
    #[serde(default)]
    pub resume_token: Option<String>,
    #[serde(default)]
    pub stop_reason: Option<AgentStopReason>,
    #[serde(default)]
    pub payload: AgentCheckpointPayload,
    #[serde(default)]
    #[serde(with = "super::items::legacy_history")]
    pub messages: super::AgentItemHistory,
}

fn schema_version() -> u32 {
    1
}
fn runtime_name() -> String {
    "rust".into()
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum AgentCheckpointPayload {
    UserInput(UserInputCheckpoint),
    Execution(ExecutionCheckpoint),
}
impl<'de> Deserialize<'de> for AgentCheckpointPayload {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = Value::deserialize(deserializer)?;
        match value.get("kind") {
            Some(Value::String(kind)) if kind == "user_input" => serde_json::from_value(value)
                .map(Self::UserInput)
                .map_err(D::Error::custom),
            Some(kind) => Err(D::Error::custom(format!(
                "unsupported checkpoint kind: {kind}"
            ))),
            None => serde_json::from_value(value)
                .map(Self::Execution)
                .map_err(D::Error::custom),
        }
    }
}
impl Default for AgentCheckpointPayload {
    fn default() -> Self {
        Self::Execution(ExecutionCheckpoint::default())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UserInputCheckpointKind {
    UserInput,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserInputCheckpoint {
    pub kind: UserInputCheckpointKind,
    pub form_id: String,
    pub form: super::user_input::AgentUserInputForm,
    #[serde(default)]
    pub pending_hook_context: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionCheckpoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_checkpoint: Option<Value>,
}

/// Internal construction data: fields are assigned directly rather than promoted from JSON.
#[derive(Default)]
pub(super) struct PhaseCheckpointInput {
    pub iteration: Option<i64>,
    pub pending_tool_calls: Vec<Value>,
    pub completed_tool_results: Vec<Value>,
    pub resume_token: Option<String>,
    pub stop_reason: Option<AgentStopReason>,
    pub messages: Option<super::AgentItemHistory>,
    pub payload: AgentCheckpointPayload,
}

impl AgentCheckpoint {
    pub(crate) fn cancelled(
        turn_id: &str,
        session_id: &str,
        stop_reason: AgentStopReason,
        reason: &str,
    ) -> Self {
        Self {
            schema_version: 1,
            runtime: runtime_name(),
            turn_id: turn_id.into(),
            session_id: session_id.into(),
            thread_id: None,
            trace_context: None,
            phase: stop_reason.into(),
            iteration: None,
            max_iterations: 0,
            pending_tool_calls: Vec::new(),
            activated_tool_ids: Vec::new(),
            completed_tool_results: Vec::new(),
            resume_token: None,
            stop_reason: None,
            messages: super::AgentItemHistory::default(),
            payload: AgentCheckpointPayload::Execution(ExecutionCheckpoint {
                cancelled: Some(true),
                reason: Some(reason.into()),
                ..Default::default()
            }),
        }
    }

    pub(super) fn new(
        context: &AgentTurnContext,
        phase: AgentCheckpointPhase,
        input: PhaseCheckpointInput,
    ) -> Self {
        let activated_tool_ids = if phase.retains_activated_tools() {
            context.tool_router.activated_tool_ids()
        } else {
            Vec::new()
        };
        Self {
            schema_version: 1,
            runtime: runtime_name(),
            turn_id: context.turn_id.clone(),
            session_id: context.session_id.clone(),
            thread_id: context.thread_id.clone(),
            trace_context: Some(context.trace_context.clone()),
            phase,
            iteration: input.iteration,
            max_iterations: context.max_iterations,
            pending_tool_calls: input.pending_tool_calls,
            activated_tool_ids,
            completed_tool_results: input.completed_tool_results,
            resume_token: input.resume_token,
            stop_reason: input.stop_reason,
            payload: input.payload,
            messages: input.messages.unwrap_or_else(|| context.messages.clone()),
        }
    }

    pub(crate) fn from_wire(value: Value) -> Result<Self, super::AgentError> {
        let checkpoint: Self = serde_json::from_value(value).map_err(|error| {
            super::AgentError::invalid_input(format!("invalid agent checkpoint: {error}"))
        })?;
        if checkpoint.schema_version != 1
            || checkpoint.runtime != "rust"
            || checkpoint.turn_id.trim().is_empty()
            || checkpoint.session_id.trim().is_empty()
        {
            return Err(super::AgentError::invalid_input(
                "invalid agent checkpoint identity or schema version",
            ));
        }
        Ok(checkpoint)
    }

    pub(super) fn user_input(&self, form_id: &str) -> Result<&UserInputCheckpoint, String> {
        let AgentCheckpointPayload::UserInput(payload) = &self.payload else {
            return Err("unsupported continuation checkpoint kind: expected user_input".into());
        };
        if self.phase.as_str() != "awaiting_form" {
            return Err("invalid form checkpoint: phase must be awaiting_form".into());
        }
        if payload.form_id != form_id {
            return Err(format!(
                "form continuation ID `{form_id}` does not match checkpoint `{}`",
                payload.form_id
            ));
        }
        Ok(payload)
    }
}
