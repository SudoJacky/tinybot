use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_turn_persistence(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        let mut operation = self.threads.begin_operation()?;
        let result = (|| match request.method.as_str() {
            "thread.turn.start" => {
                let params: AgentTurnStartParams = parse_params(request)?;
                let thread_id = params
                    .record
                    .thread_id
                    .clone()
                    .unwrap_or_else(|| params.record.session_id.clone());
                let record = operation.thread_log().start_turn(
                    params.record,
                    params.context,
                    params.messages,
                )?;
                operation.sync_thread_projection(&thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.list" => {
                let params: AgentTurnListParams = parse_params(request)?;
                let mut records = operation.thread_log().list_turns(&params.thread_id)?;
                records.sort_by(|left, right| {
                    right
                        .updated_at
                        .cmp(&left.updated_at)
                        .then_with(|| left.turn_id.cmp(&right.turn_id))
                });
                let turns = records
                    .iter()
                    .map(AgentTurnSummary::from_record)
                    .collect::<Vec<_>>();
                Ok(serde_json::json!({
                    "threadId": params.thread_id,
                    "turns": turns,
                }))
            }
            "thread.turn.get" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let record = operation
                    .thread_log()
                    .get_turn(&params.thread_id, &params.turn_id)?
                    .ok_or_else(|| turn_not_found_error(&params.thread_id, &params.turn_id))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.runtime_state" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let runtime_state = operation
                    .thread_log()
                    .get_turn_runtime_state(&params.thread_id, &params.turn_id)?
                    .ok_or_else(|| turn_not_found_error(&params.thread_id, &params.turn_id))?;
                serde_json::to_value(runtime_state).map_err(serialization_error)
            }
            "thread.turn.append_semantic_batch" => {
                let params: AgentTurnAppendSemanticBatchParams = parse_params(request)?;
                let record = operation.thread_log().append_turn_semantic_events(
                    &params.thread_id,
                    &params.turn_id,
                    params.events,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.set_checkpoint" => {
                let params: AgentTurnCheckpointParams = parse_params(request)?;
                let record = operation.thread_log().set_turn_checkpoint(
                    &params.thread_id,
                    &params.turn_id,
                    params.checkpoint,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.get_checkpoint" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let checkpoint = operation
                    .thread_log()
                    .get_turn_checkpoint(&params.thread_id, &params.turn_id)?;
                serde_json::to_value(checkpoint).map_err(serialization_error)
            }
            "thread.turn.clear_checkpoint" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let record = operation
                    .thread_log()
                    .clear_turn_checkpoint(&params.thread_id, &params.turn_id)?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_completed" => {
                let params: AgentTurnMarkCompletedParams = parse_params(request)?;
                let record = operation.thread_log().mark_turn_completed(
                    &params.thread_id,
                    &params.turn_id,
                    &params.stop_reason,
                    params.final_content,
                    params.context_checkpoint,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_failed" => {
                let params: AgentTurnMarkFailedParams = parse_params(request)?;
                let record = operation.thread_log().mark_turn_failed(
                    &params.thread_id,
                    &params.turn_id,
                    &params.stop_reason,
                    params.error,
                    params.context_checkpoint,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_cancelled" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let record = operation
                    .thread_log()
                    .mark_turn_cancelled(&params.thread_id, &params.turn_id)?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_interrupted" => {
                let params: AgentTurnMarkInterruptedParams = parse_params(request)?;
                let record = operation.thread_log().mark_turn_interrupted_terminal(
                    &params.thread_id,
                    &params.turn_id,
                    &params.reason,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        })();
        if result.is_err() {
            operation.reload_projection()?;
        }
        result
    }
}

fn turn_not_found_error(thread_id: &str, turn_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "turn not found",
        serde_json::json!({
            "threadId": thread_id,
            "turnId": turn_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
