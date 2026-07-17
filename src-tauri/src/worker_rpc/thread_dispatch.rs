use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_thread_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "thread.create" => {
                let params: CreateThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.create_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.read" => {
                let params: ReadThreadRequest = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .read_thread_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.resume" => {
                let params: ResumeThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.resume_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.status" => {
                let params: ThreadIdParams = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .get_thread_status_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.list" => {
                let params: ListThreadsRequest = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .list_threads_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.search" => {
                let params: SearchThreadsRequest = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .search_threads_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.update_metadata" => {
                let params: UpdateThreadMetadataRequest = parse_params(request)?;
                serde_json::to_value(self.thread.update_thread_metadata(params)?)
                    .map_err(serialization_error)
            }
            "thread.archive" => {
                let params: ArchiveThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.archive_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.unarchive" => {
                let mut params: ArchiveThreadRequest = parse_params(request)?;
                params.archived = Some(false);
                serde_json::to_value(self.thread.unarchive_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.delete" => {
                let params: DeleteThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.delete_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.fork" => {
                let params: ForkThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.fork_thread(params)?).map_err(serialization_error)
            }
            "thread.rollback" => {
                let params: ThreadRollbackParams = parse_params(request)?;
                serde_json::to_value(
                    self.thread_log
                        .rollback_thread(&params.thread_id, params.num_turns)?,
                )
                .map_err(serialization_error)
            }
            "thread.append_items" => {
                let params: AppendThreadItemsRequest = parse_params(request)?;
                serde_json::to_value(self.thread.append_items(params)?).map_err(serialization_error)
            }
            "thread.events" => {
                let params: ThreadEventsRequest = parse_params(request)?;
                serde_json::to_value(self.thread.thread_events(params)?)
                    .map_err(serialization_error)
            }
            "thread.restore_checkpoint" => {
                let params: RestoreThreadCheckpointRequest = parse_params(request)?;
                serde_json::to_value(self.thread.restore_checkpoint(params)?)
                    .map_err(serialization_error)
            }
            "thread.agent_registry" => {
                let params: ThreadAgentRegistryRequest = parse_params(request)?;
                serde_json::to_value(self.thread.agent_registry(params)?)
                    .map_err(serialization_error)
            }
            "thread.activity" => {
                let params: ThreadActivityRequest = parse_params(request)?;
                serde_json::to_value(self.thread.activity(params)?).map_err(serialization_error)
            }
            "thread.start_turn" => {
                let mut params: StartThreadTurnRequest = parse_params(request)?;
                if params.trace_context.is_none() {
                    if let Some(run_id) = params.run_id.clone() {
                        params.trace_context =
                            Some(crate::agent_loop_runtime_protocol::AgentTraceContext {
                                request_id: request.id.clone(),
                                trace_id: request.trace_id.clone(),
                                run_id: run_id.clone(),
                                turn_id: params.turn_id.clone().unwrap_or_else(|| run_id.clone()),
                                thread_id: Some(params.thread_id.clone()),
                                parent_run_id: None,
                            });
                    }
                }
                serde_json::to_value(self.thread.start_turn(params)?).map_err(serialization_error)
            }
            "thread.apply_op" => {
                let params: ThreadApplyOpRequest = parse_params(request)?;
                serde_json::to_value(self.thread.apply_op(params)?).map_err(serialization_error)
            }
            "thread.continue_turn" => {
                let params: ContinueThreadTurnRequest = parse_params(request)?;
                serde_json::to_value(self.thread.continue_turn(params)?)
                    .map_err(serialization_error)
            }
            "thread.interrupt" => {
                let params: InterruptThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.interrupt(params)?).map_err(serialization_error)
            }
            "thread.persistence.check" => {
                serde_json::to_value(self.thread.check_persistence()?).map_err(serialization_error)
            }
            "thread.persistence.repair" => {
                let params: ThreadPersistenceRepairRequest = parse_params(request)?;
                serde_json::to_value(self.thread.repair_persistence(params.mode)?)
                    .map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}
