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
mod tests {
    use super::*;
    use crate::protocol::capability::CapabilityPolicy;
    use crate::rpc::WorkerRpcRouter;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn fixture_root(name: &str) -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-rpc-runtime-{name}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("runtime fixture root should be created");
        root
    }

    #[test]
    fn runtime_restart_dispatches_request_to_handler() {
        let restart_requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = restart_requests.clone();
        let rpc = WorkerRuntimeRpc::with_restart_handler(move |request| {
            captured
                .lock()
                .expect("restart request log should lock")
                .push(request);
        });
        let request = WorkerRequest::new(
            "req-restart",
            "trace-restart",
            "runtime.restart",
            json!({
                "turn_id": "turn-1",
                "session_id": "session-1"
            }),
        );

        let result = rpc
            .restart_from_request(&request)
            .expect("runtime restart should return result");

        assert_eq!(
            result,
            json!({
                "restart_requested": true,
                "turn_id": "turn-1",
                "session_id": "session-1"
            })
        );
        assert_eq!(
            restart_requests
                .lock()
                .expect("restart request log should lock")
                .as_slice(),
            [RuntimeRestartRequest {
                turn_id: Some("turn-1".to_string()),
                session_id: Some("session-1".to_string())
            }]
        );
    }

    #[test]
    fn runtime_restart_dispatch_routes_to_runtime_module() {
        let restart_requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = restart_requests.clone();
        let mut router = WorkerRpcRouter::new(
            fixture_root("dispatch"),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        )
        .with_runtime_restart_handler(move |request| {
            captured
                .lock()
                .expect("restart request log should lock")
                .push(request);
        });
        let request = WorkerRequest::new(
            "req-restart",
            "trace-restart",
            "runtime.restart",
            json!({
                "turn_id": "turn-1",
                "session_id": "session-1"
            }),
        );

        let response = router.dispatch(&request);

        assert!(response.error.is_none());
        assert_eq!(
            response.result.expect("restart result should be present"),
            json!({
                "restart_requested": true,
                "turn_id": "turn-1",
                "session_id": "session-1"
            })
        );
        assert_eq!(
            restart_requests
                .lock()
                .expect("restart request log should lock")
                .as_slice(),
            [RuntimeRestartRequest {
                turn_id: Some("turn-1".to_string()),
                session_id: Some("session-1".to_string())
            }]
        );
    }

    #[test]
    fn runtime_restart_accepts_camel_case_aliases() {
        let restart_requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = restart_requests.clone();
        let rpc = WorkerRuntimeRpc::with_restart_handler(move |request| {
            captured
                .lock()
                .expect("restart request log should lock")
                .push(request);
        });
        let request = WorkerRequest::new(
            "req-restart",
            "trace-restart",
            "runtime.restart",
            json!({
                "turnId": "turn-1",
                "sessionId": "session-1"
            }),
        );

        rpc.restart_from_request(&request)
            .expect("runtime restart should parse aliases");

        assert_eq!(
            restart_requests
                .lock()
                .expect("restart request log should lock")
                .as_slice(),
            [RuntimeRestartRequest {
                turn_id: Some("turn-1".to_string()),
                session_id: Some("session-1".to_string())
            }]
        );
    }

    #[test]
    fn runtime_now_returns_current_time_with_timezone() {
        let rpc = WorkerRuntimeRpc::new();
        let request = WorkerRequest::new(
            "req-now",
            "trace-now",
            "runtime.now",
            json!({ "timezone": "Asia/Shanghai" }),
        );

        let result = rpc
            .now_from_request(&request)
            .expect("runtime now should return result");

        assert_eq!(result["timezone"], "Asia/Shanghai");
        assert!(result["current_time"]
            .as_str()
            .expect("current_time should be a string")
            .starts_with("unix-ms:"));
    }

    #[test]
    fn runtime_metrics_returns_process_observability_snapshot() {
        crate::runtime::observability::global_agent_runtime_metrics().increment("turn.started");
        let mut router = WorkerRpcRouter::new(
            fixture_root("metrics"),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );
        let request =
            WorkerRequest::new("req-metrics", "trace-metrics", "runtime.metrics", json!({}));

        let response = router.dispatch(&request);
        let result = response.result.expect("metrics result should be present");

        assert!(response.error.is_none());
        assert_eq!(result["schemaVersion"], 1);
        assert!(result["counters"]["turn.started"].as_u64().unwrap_or(0) >= 1);
        assert!(result["generatedAtUnixMs"].as_u64().is_some());
    }
}
