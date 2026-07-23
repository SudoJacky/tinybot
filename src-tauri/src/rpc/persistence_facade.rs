use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_session_persistence(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "rollout.append_turn_context" => {
                let params: RolloutAppendTurnContextParams = parse_params(request)?;
                self.thread_log
                    .append_turn_context(&params.session_id, params.context)?;
                Ok(serde_json::json!({ "persisted": true }))
            }
            "session.get_metadata" => {
                let params: SessionIdParams = parse_params(request)?;
                let session = self.thread_log.get_session_metadata(&params.session_id)?;
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.get_history" => {
                let params: SessionHistoryParams = parse_params(request)?;
                let limit = params.limit.unwrap_or(80);
                let projection = self
                    .thread_log
                    .get_session_history(&params.session_id, limit)?;
                serde_json::to_value(projection).map_err(serialization_error)
            }
            "session.get_agent_context" => {
                let params: SessionHistoryParams = parse_params(request)?;
                let limit = params.limit.unwrap_or(500);
                let projection = self
                    .thread_log
                    .get_agent_context(&params.session_id, limit)?;
                serde_json::to_value(projection).map_err(serialization_error)
            }
            "session.list_metadata" => {
                let mut sessions = self.thread_log.list_session_metadata()?;
                sessions.sort_by(|left, right| {
                    session_updated_sort_millis(&right.updated_at)
                        .cmp(&session_updated_sort_millis(&left.updated_at))
                        .then_with(|| left.session_id.cmp(&right.session_id))
                });
                serde_json::to_value(sessions).map_err(serialization_error)
            }
            "session.get_checkpoint" => {
                let params: SessionIdParams = parse_params(request)?;
                let checkpoint = self
                    .thread_log
                    .latest_turn_checkpoint(&params.session_id)?
                    .map(|checkpoint| checkpoint.checkpoint);
                serde_json::to_value(checkpoint).map_err(serialization_error)
            }
            "session.set_checkpoint" => {
                let params: SessionCheckpointParams = parse_params(request)?;
                let turn_id = params
                    .checkpoint
                    .get("turnId")
                    .or_else(|| params.checkpoint.get("turn_id"))
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        WorkerProtocolError::new(
                            WorkerProtocolErrorCode::InvalidProtocol,
                            "session checkpoint must include turnId",
                            serde_json::json!({ "session_id": params.session_id }),
                            false,
                            WorkerProtocolErrorSource::RustCore,
                        )
                    })?
                    .to_string();
                let record = self.thread_log.set_turn_checkpoint(
                    &params.session_id,
                    &turn_id,
                    params.checkpoint,
                )?;
                let session = self
                    .thread_log
                    .get_session_metadata_for_write_response(&params.session_id)?
                    .ok_or_else(|| {
                        WorkerProtocolError::new(
                            WorkerProtocolErrorCode::WorkerError,
                            "session metadata missing after checkpoint persistence",
                            serde_json::json!({ "session_id": params.session_id }),
                            false,
                            WorkerProtocolErrorSource::RustCore,
                        )
                    })?;
                let mut value = serde_json::to_value(session).map_err(serialization_error)?;
                value["extra"]["runtime_checkpoint"] =
                    record.checkpoint.unwrap_or(serde_json::Value::Null);
                return Ok(value);
            }
            "session.clear_checkpoint" => {
                let params: SessionIdParams = parse_params(request)?;
                let _ = self
                    .thread_log
                    .clear_latest_turn_checkpoint(&params.session_id)?;
                let session = self
                    .thread_log
                    .get_session_metadata_for_write_response(&params.session_id)?
                    .ok_or_else(|| {
                        WorkerProtocolError::new(
                            WorkerProtocolErrorCode::InvalidProtocol,
                            "session metadata not found",
                            serde_json::json!({ "session_id": params.session_id }),
                            false,
                            WorkerProtocolErrorSource::RustCore,
                        )
                    })?;
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.clear" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.thread_log.clear_session(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.trim" => {
                let params: SessionTrimParams = parse_params(request)?;
                serde_json::to_value(
                    self.thread_log
                        .trim_session(&params.session_id, params.keep_recent_messages)?,
                )
                .map_err(serialization_error)
            }
            "session.delete" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.thread_log.delete_session(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.patch_metadata" => {
                let params: SessionPatchMetadataParams = parse_params(request)?;
                let session = self
                    .thread_log
                    .patch_metadata(&params.session_id, &params.metadata)?
                    .ok_or_else(|| missing_session_error(&params.session_id))?;
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.patch_user_profile" => {
                let params: SessionPatchUserProfileParams = parse_params(request)?;
                serde_json::to_value(self.thread_log.patch_user_profile(
                    &params.session_id,
                    params.user_profile,
                    params.metadata.unwrap_or_else(|| serde_json::json!({})),
                )?)
                .map_err(serialization_error)
            }
            "session.append_messages" => {
                let params: SessionAppendMessagesParams = parse_params(request)?;
                serde_json::to_value(self.thread_log.append_session_messages(
                    &params.session_id,
                    &params.turn_id,
                    params.messages,
                )?)
                .map_err(serialization_error)
            }
            "session.task_progress.upsert" => {
                let params: SessionTaskProgressUpsertParams = parse_params(request)?;
                serde_json::to_value(self.thread_log.upsert_task_progress(
                    &params.session_id,
                    &params.turn_id,
                    &params.plan_id,
                    params.progress,
                    params.content,
                )?)
                .map_err(serialization_error)
            }
            "session.persist_turn" => {
                let params: SessionPersistTurnParams = parse_params(request)?;
                let _legacy_clear_checkpoint = params.clear_checkpoint;
                let context_checkpoint = params
                    .context_metadata()
                    .and_then(|metadata| metadata.get("contextCheckpoint").cloned())
                    .filter(|checkpoint| !checkpoint.is_null());
                let result = self.thread_log.persist_session_turn(
                    &params.session_id,
                    &params.turn_id,
                    params.messages,
                    context_checkpoint,
                )?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "session.commit_context_checkpoint" => {
                let params: SessionCommitContextCheckpointParams = parse_params(request)?;
                let result = self.thread_log.commit_context_checkpoint(
                    &params.session_id,
                    &params.turn_id,
                    params.checkpoint,
                )?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "session.persistence.check" => {
                serde_json::to_value(self.thread_log.check_state_index()?)
                    .map_err(serialization_error)
            }
            "session.persistence.repair" => {
                let params: ThreadLogIndexRepairRequest = parse_params(request)?;
                serde_json::to_value(self.thread_log.repair_state_index(params.mode)?)
                    .map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }

    pub(super) fn dispatch_turn_persistence(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.refresh_thread_projection()?;
        match request.method.as_str() {
            "thread.turn.start" => {
                let params: AgentTurnStartParams = parse_params(request)?;
                let record =
                    self.thread_log
                        .start_turn(params.record, params.context, params.messages)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.list" => {
                let params: AgentTurnListParams = parse_params(request)?;
                let mut records = self.thread_log.list_turns(&params.session_id)?;
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
                    "sessionId": params.session_id,
                    "turns": turns,
                }))
            }
            "thread.turn.get" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let record = self
                    .thread_log
                    .get_turn(&params.session_id, &params.turn_id)?
                    .ok_or_else(|| turn_not_found_error(&params.session_id, &params.turn_id))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.runtime_state" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let runtime_state = self
                    .thread_log
                    .get_turn_runtime_state(&params.session_id, &params.turn_id)?
                    .ok_or_else(|| turn_not_found_error(&params.session_id, &params.turn_id))?;
                serde_json::to_value(runtime_state).map_err(serialization_error)
            }
            "thread.turn.append_semantic_batch" => {
                let params: AgentTurnAppendSemanticBatchParams = parse_params(request)?;
                let record = self.thread_log.append_turn_semantic_events(
                    &params.session_id,
                    &params.turn_id,
                    params.events,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.set_checkpoint" => {
                let params: AgentTurnCheckpointParams = parse_params(request)?;
                let record = self.thread_log.set_turn_checkpoint(
                    &params.session_id,
                    &params.turn_id,
                    params.checkpoint,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.get_checkpoint" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                let checkpoint = self
                    .thread_log
                    .get_turn_checkpoint(&params.session_id, &params.turn_id)?;
                serde_json::to_value(checkpoint).map_err(serialization_error)
            }
            "thread.turn.clear_checkpoint" => {
                let params: AgentTurnIdParams = parse_params(request)?;
                serde_json::to_value(
                    self.thread_log
                        .clear_turn_checkpoint(&params.session_id, &params.turn_id)?,
                )
                .map_err(serialization_error)
            }
            "thread.turn.mark_completed" => {
                let params: AgentTurnMarkCompletedParams = parse_params(request)?;
                let record = self.thread_log.mark_turn_completed(
                    &params.session_id,
                    &params.turn_id,
                    &params.stop_reason,
                    params.final_content,
                    params.context_checkpoint,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_failed" => {
                let params: AgentTurnMarkFailedParams = parse_params(request)?;
                let record = self.thread_log.mark_turn_failed(
                    &params.session_id,
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
                    .thread_log
                    .mark_turn_cancelled(&params.session_id, &params.turn_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "thread.turn.mark_interrupted" => {
                let params: AgentTurnMarkInterruptedParams = parse_params(request)?;
                let record = self.thread_log.mark_turn_interrupted_terminal(
                    &params.session_id,
                    &params.turn_id,
                    &params.reason,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RolloutAppendTurnContextParams {
    session_id: String,
    context: crate::threads::rollout::format::TurnContextItem,
}

fn turn_not_found_error(session_id: &str, turn_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "turn not found",
        serde_json::json!({
            "session_id": session_id,
            "turn_id": turn_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn missing_session_error(session_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "session metadata not found",
        serde_json::json!({ "session_id": session_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
