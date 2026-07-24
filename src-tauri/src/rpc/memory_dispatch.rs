use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_memory_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "memory.search" => self.memory.search_from_request(request),
            "memory.recall" => self.memory.recall_from_request(request),
            "memory.rebuild_index" => self.memory.rebuild_index(),
            "memory.refresh_views" => self.memory.refresh_views(),
            "memory.migrate_legacy_notes" => self.memory.migrate_legacy_notes(),
            "memory.dream_run" => self.memory.dream_run_from_request(request),
            "memory.dream_pending" => self.memory.dream_pending_from_request(request),
            "memory.dream_apply" => self.memory.dream_apply_from_request(request),
            "memory.dream_log" => self.memory.dream_log_from_request(request),
            "memory.dream_restore" => self.memory.dream_restore_from_request(request),
            "memory.capture_evidence" => self.memory.capture_evidence_from_request(request),
            "memory.list_evidence" => self.memory.list_evidence_from_request(request),
            "memory.save" => self.memory.save_from_request(request),
            "memory.trace" => self.memory.trace_from_request(request),
            "memory.reject" => self.memory.reject_from_request(request),
            "memory.supersede" => self.memory.supersede_from_request(request),
            _ => Err(unknown_method_error(request)),
        }
    }
}
