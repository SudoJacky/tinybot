use crate::protocol::WorkerProtocolError;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentErrorCode {
    InvalidRequest,
    RuntimeError,
    PersistenceError,
}

/// Keeps service failures intact through task ownership and asynchronous persistence.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    pub code: AgentErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_error: Option<WorkerProtocolError>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<AgentError>,
}

impl AgentError {
    pub fn stop_reason(&self) -> super::AgentStopReason {
        match self.code {
            AgentErrorCode::InvalidRequest => super::AgentStopReason::InvalidRequest,
            AgentErrorCode::RuntimeError | AgentErrorCode::PersistenceError => {
                super::AgentStopReason::RuntimeError
            }
        }
    }
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            code: AgentErrorCode::InvalidRequest,
            message: message.into(),
            service_error: None,
            related: Vec::new(),
        }
    }
    pub fn persistence(operation: &str, error: WorkerProtocolError) -> Self {
        Self {
            code: AgentErrorCode::PersistenceError,
            message: format!(
                "{operation} failed: {}; details={}",
                error.message, error.details
            ),
            service_error: Some(error),
            related: Vec::new(),
        }
    }
    pub fn context(mut self, context: impl std::fmt::Display) -> Self {
        self.message = format!("{context}: {}", self.message);
        self
    }
    pub fn combine(mut self, other: Self) -> Self {
        self.message = format!("{}; {}", self.message, other.message);
        self.related.push(other);
        self
    }
}

impl From<String> for AgentError {
    fn from(message: String) -> Self {
        Self {
            code: AgentErrorCode::RuntimeError,
            message,
            service_error: None,
            related: Vec::new(),
        }
    }
}
impl From<&str> for AgentError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}
impl From<WorkerProtocolError> for AgentError {
    fn from(error: WorkerProtocolError) -> Self {
        Self::persistence("native service", error)
    }
}
impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for AgentError {}
