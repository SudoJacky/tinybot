use std::{path::PathBuf, time::Duration};

use crate::worker_client::WorkerClient;
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::SharedGateway;

pub(crate) fn start_worker_heartbeat_runtime_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_worker_heartbeat_lifecycle_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_heartbeat_lifecycle_request(next_worker_request_correlation(), "start"),
        timeout,
    )
}

pub(crate) fn stop_worker_heartbeat_runtime_with_options(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_worker_heartbeat_lifecycle_request(
        shared,
        workspace_root,
        config_snapshot,
        build_worker_heartbeat_lifecycle_request(next_worker_request_correlation(), "stop"),
        timeout,
    )
}

fn send_worker_heartbeat_lifecycle_request(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_ts_agent_running(workspace_root, config_snapshot)?;
    let method = request.method.clone();
    client.call(&request, timeout, &format!("worker {method}"))
}

pub(crate) fn build_worker_heartbeat_lifecycle_request(
    request_id: WorkerRequestCorrelation,
    action: &str,
) -> WorkerRequest {
    let prefix = format!("heartbeat-{action}");
    WorkerRequest::new(
        request_id.id(&prefix),
        request_id.trace_id(&prefix),
        format!("heartbeat.{action}"),
        serde_json::json!({}),
    )
}
