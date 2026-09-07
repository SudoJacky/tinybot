use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_turn_persistence(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "thread.turn.start" => {
                let params: AgentTurnStartParams = parse_params(request)?;
                let record = self.threads.start_agent_turn(
                    params.record,
                    params.context,
                    params.messages,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.list" => {
                let params: AgentTurnListParams = parse_params(request)?;
                let mut records = self.threads.agent_turns(&params.thread_id)?;
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
                let record = self
                    .threads
                    .agent_turn(&params.thread_id, &params.turn_id)?
                    .ok_or_else(|| turn_not_found_error(&params.thread_id, &params.turn_id))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.runtime_state" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let runtime_state = self
                    .threads
                    .agent_turn_runtime_state(&params.thread_id, &params.turn_id)?;
                serde_json::to_value(runtime_state).map_err(serialization_error)
            }
            "thread.turn.append_semantic_batch" => {
                let params: AgentTurnAppendSemanticBatchParams = parse_params(request)?;
                let record = self.threads.append_agent_turn_semantic_values(
                    &params.thread_id,
                    &params.turn_id,
                    params.events,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.set_checkpoint" => {
                let params: AgentTurnCheckpointParams = parse_params(request)?;
                let record = self.threads.set_agent_turn_checkpoint(
                    &params.thread_id,
                    &params.turn_id,
                    params.checkpoint,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.get_checkpoint" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let checkpoint = self
                    .threads
                    .agent_turn_checkpoint(&params.thread_id, &params.turn_id)?;
                serde_json::to_value(checkpoint).map_err(serialization_error)
            }
            "thread.turn.clear_checkpoint" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let record = self
                    .threads
                    .clear_agent_turn_checkpoint(&params.thread_id, &params.turn_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_completed" => {
                let params: AgentTurnMarkCompletedParams = parse_params(request)?;
                let record = self.threads.complete_agent_turn(
                    &params.thread_id,
                    &params.turn_id,
                    &params.stop_reason,
                    params.final_content,
                    params.context_checkpoint,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_failed" => {
                let params: AgentTurnMarkFailedParams = parse_params(request)?;
                let record = self.threads.fail_agent_turn(
                    &params.thread_id,
                    &params.turn_id,
                    &params.stop_reason,
                    params.error,
                    params.context_checkpoint,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_cancelled" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let record = self
                    .threads
                    .cancel_agent_turn(&params.thread_id, &params.turn_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_interrupted" => {
                let params: AgentTurnMarkInterruptedParams = parse_params(request)?;
                let record = self.threads.interrupt_agent_turn(
                    &params.thread_id,
                    &params.turn_id,
                    &params.reason,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}

use crate::threads::turn_service::turn_not_found_error;
