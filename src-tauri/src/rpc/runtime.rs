use crate::protocol::{WorkerProtocolError, WorkerRequest};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::protocol::params::parse_params;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeRestartRequest {
    pub turn_id: Option<String>,
    pub session_id: Option<String>,
}

type RuntimeRestartHandler = Arc<dyn Fn(RuntimeRestartRequest) + Send + Sync + 'static>;

#[derive(Clone)]
pub(super) struct WorkerRuntimeRpc {
    restart_handler: Option<RuntimeRestartHandler>,
}

impl fmt::Debug for WorkerRuntimeRpc {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerRuntimeRpc")
            .field("restart_handler", &self.restart_handler.is_some())
            .finish()
    }
}

impl WorkerRuntimeRpc {
    pub(super) fn new() -> Self {
        Self {
            restart_handler: None,
        }
    }

    #[cfg(test)]
    pub(super) fn with_restart_handler(
        handler: impl Fn(RuntimeRestartRequest) + Send + Sync + 'static,
    ) -> Self {
        Self {
            restart_handler: Some(Arc::new(handler)),
        }
    }

    pub(super) fn now_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        let params: RuntimeNowParams = parse_params(request)?;
        Ok(runtime_now(params.timezone))
    }

    pub(super) fn restart_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.restart(parse_params(request)?)
    }

    pub(super) fn metrics_from_request(
        &self,
        _request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        Ok(crate::runtime::observability::global_agent_runtime_metrics().snapshot())
    }

    fn restart(&self, params: RuntimeRestartParams) -> Result<Value, WorkerProtocolError> {
        let request = RuntimeRestartRequest {
            turn_id: params.turn_id,
            session_id: params.session_id,
        };
        if let Some(handler) = &self.restart_handler {
            handler(request.clone());
        }
        Ok(serde_json::json!({
            "restart_requested": true,
            "turn_id": request.turn_id,
            "session_id": request.session_id,
        }))
    }
}

#[derive(Deserialize)]
struct RuntimeNowParams {
    timezone: Option<String>,
}

#[derive(Deserialize)]
struct RuntimeRestartParams {
    #[serde(default, alias = "turnId")]
    turn_id: Option<String>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
}

fn runtime_now(timezone: Option<String>) -> Value {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let timezone = timezone.unwrap_or_else(|| "local".to_string());
    serde_json::json!({
        "current_time": format!("unix-ms:{millis} {timezone}"),
        "timezone": timezone,
    })
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
