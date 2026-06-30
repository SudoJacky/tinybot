use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::WorkerRequestCorrelation;

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
