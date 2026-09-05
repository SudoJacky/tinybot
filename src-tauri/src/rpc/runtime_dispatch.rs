use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_runtime_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "runtime.metrics" => {
                Ok(crate::runtime::observability::global_agent_runtime_metrics().snapshot())
            }
            "runtime.now" => runtime::now_from_request(request),
            _ => Err(unknown_method_error(request)),
        }
    }
}
