use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_runtime_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "runtime.now" => self.runtime.now_from_request(request),
            "runtime.restart" => self.runtime.restart_from_request(request),
            _ => Err(unknown_method_error(request)),
        }
    }
}
