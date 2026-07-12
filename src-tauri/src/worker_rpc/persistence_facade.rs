use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_session_persistence(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "session.get_metadata" => {
                let params: SessionIdParams = parse_params(request)?;
                if self.thread.has_thread_store() {
                    if let Some(session) = self
                        .thread
                        .get_session_metadata_from_threads(&params.session_id)?
                    {
                        return serde_json::to_value(session).map_err(serialization_error);
                    }
                }
                if let Some(session) = self.thread_log.get_session_metadata(&params.session_id)? {
                    return serde_json::to_value(session).map_err(serialization_error);
                }
                let session = self.session.get_metadata(&params.session_id)?;
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.get_history" => {
                let params: SessionHistoryParams = parse_params(request)?;
                let limit = params.limit.unwrap_or(80);
                if self.thread.has_thread_store() {
                    if let Some(projection) = self
                        .thread
                        .get_session_history_from_threads(&params.session_id, limit)?
                    {
                        return serde_json::to_value(projection).map_err(serialization_error);
                    }
                }
                if let Some(projection) = self
                    .thread_log
                    .get_session_history(&params.session_id, limit)?
                {
                    return serde_json::to_value(projection).map_err(serialization_error);
                }
                let projection = self.session.get_history(&params.session_id, limit)?;
                serde_json::to_value(projection).map_err(serialization_error)
            }
            "session.list_metadata" => {
                let thread_log_sessions = self.thread_log.list_session_metadata()?;
                let sessions = self.session.list_metadata()?;
                let mut merged = if self.thread.has_thread_store() {
                    self.thread.list_session_metadata_with_threads(&sessions)?
                } else {
                    sessions
                };
                for session in thread_log_sessions {
                    if let Some(existing_index) = merged
                        .iter()
                        .position(|existing| existing.session_id == session.session_id)
                    {
                        if merged[existing_index]
                            .extra
                            .get("threadMetadataProjection")
                            .and_then(Value::as_bool)
                            != Some(true)
                        {
                            merged[existing_index] = session;
                        }
                    } else {
                        merged.push(session);
                    }
                }
                merged.sort_by(|left, right| {
                    session_updated_sort_millis(&right.updated_at)
                        .cmp(&session_updated_sort_millis(&left.updated_at))
                        .then_with(|| left.session_id.cmp(&right.session_id))
                });
                serde_json::to_value(merged).map_err(serialization_error)
            }
            "session.get_checkpoint" => {
                let params: SessionIdParams = parse_params(request)?;
                if self.thread.has_thread_store() {
                    if let Some(checkpoint) = self
                        .thread
                        .get_session_checkpoint_from_threads(&params.session_id)?
                    {
                        return serde_json::to_value(checkpoint).map_err(serialization_error);
                    }
                }
                let checkpoint = self
                    .thread_log
                    .latest_agent_run_checkpoint(&params.session_id)?
                    .map(|checkpoint| checkpoint.checkpoint);
                let checkpoint = match checkpoint {
                    Some(checkpoint) => Some(checkpoint),
                    None => self.session.get_checkpoint(&params.session_id)?,
                };
                serde_json::to_value(checkpoint).map_err(serialization_error)
            }
            "session.set_checkpoint" => {
                let params: SessionCheckpointParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "session.set_checkpoint",
                )?;
                let run_id = params
                    .checkpoint
                    .get("runId")
                    .or_else(|| params.checkpoint.get("run_id"))
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        WorkerProtocolError::new(
                            WorkerProtocolErrorCode::InvalidProtocol,
                            "session checkpoint must include runId",
                            serde_json::json!({ "session_id": params.session_id }),
                            false,
                            WorkerProtocolErrorSource::RustCore,
                        )
                    })?
                    .to_string();
                let record = self.thread_log.set_agent_run_checkpoint(
                    &params.session_id,
                    &run_id,
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
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "session.clear_checkpoint",
                )?;
                let _ = self
                    .thread_log
                    .clear_latest_agent_run_checkpoint(&params.session_id)?;
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
                let legacy_result = self.session.clear_session(&params.session_id)?;
                let thread_log_result = self.thread_log.clear_session(&params.session_id)?;
                serde_json::to_value(thread_log_result.unwrap_or(legacy_result))
                    .map_err(serialization_error)
            }
            "session.trim" => {
                let params: SessionTrimParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .trim_session(&params.session_id, params.keep_recent_messages)?,
                )
                .map_err(serialization_error)
            }
            "session.delete" => {
                let params: SessionIdParams = parse_params(request)?;
                let result = self.session.delete_session(&params.session_id)?;
                let thread_log_result = self.thread_log.delete_session(&params.session_id)?;
                if result.deleted {
                    self.thread.archive_session_thread(&params.session_id)?;
                }
                let deleted = result.deleted || thread_log_result.deleted;
                serde_json::to_value(crate::worker_session::DeleteSessionResult {
                    session_id: params.session_id,
                    deleted,
                })
                .map_err(serialization_error)
            }
            "session.patch_metadata" => {
                let params: SessionPatchMetadataParams = parse_params(request)?;
                let session = match self
                    .thread_log
                    .patch_metadata(&params.session_id, &params.metadata)?
                {
                    Some(session) => session,
                    None => self
                        .session
                        .patch_metadata(&params.session_id, params.metadata)?,
                };
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.patch_user_profile" => {
                let params: SessionPatchUserProfileParams = parse_params(request)?;
                serde_json::to_value(self.session.patch_user_profile(
                    &params.session_id,
                    params.user_profile,
                    params.metadata.unwrap_or_else(|| serde_json::json!({})),
                )?)
                .map_err(serialization_error)
            }
            "session.temporary_file.upload" => {
                let params: SessionTemporaryFileUploadParams = parse_params(request)?;
                self.session.upload_temporary_file(
                    &params.session_id,
                    &params.name,
                    &params.file_type,
                    &params.content,
                    params
                        .size_bytes
                        .unwrap_or_else(|| params.content.len() as u64),
                )
            }
            "session.append_messages" => {
                let params: SessionAppendMessagesParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .append_messages(&params.session_id, params.messages)?,
                )
                .map_err(serialization_error)
            }
            "session.task_progress.upsert" => {
                let params: SessionTaskProgressUpsertParams = parse_params(request)?;
                serde_json::to_value(self.session.upsert_task_progress(
                    &params.session_id,
                    &params.plan_id,
                    params.progress,
                    params.content,
                )?)
                .map_err(serialization_error)
            }
            "session.persist_turn" => {
                let params: SessionPersistTurnParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "session.persist_turn",
                )?;
                let _legacy_clear_checkpoint = params.clear_checkpoint;
                let _legacy_context_metadata = params.context_metadata();
                let result = self.thread_log.persist_session_turn(
                    &params.session_id,
                    &params.run_id,
                    params.messages,
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

    pub(super) fn dispatch_agent_run_persistence(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "agent_run.upsert" => {
                let params: AgentRunUpsertParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.record.session_id,
                    "agent_run.upsert",
                )?;
                let record = self.thread_log.upsert_agent_run(params.record)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.list" => {
                let params: AgentRunListParams = parse_params(request)?;
                let thread_owned = self.thread_owned_session(&params.session_id)?;
                let mut records = if thread_owned {
                    self.thread
                        .list_agent_runs_from_threads(&params.session_id)?
                } else {
                    self.thread_log.list_agent_runs(&params.session_id)?
                };
                let mut seen_run_ids = records
                    .iter()
                    .map(|record| record.run_id.clone())
                    .collect::<std::collections::HashSet<_>>();
                if !thread_owned {
                    for record in self.session.list_agent_runs(&params.session_id)? {
                        if seen_run_ids.insert(record.run_id.clone()) {
                            records.push(record);
                        }
                    }
                    if self.thread.has_thread_store() {
                        for record in self
                            .thread
                            .list_agent_runs_from_threads(&params.session_id)?
                        {
                            if seen_run_ids.insert(record.run_id.clone()) {
                                records.push(record);
                            }
                        }
                    }
                }
                records.sort_by(|left, right| {
                    right
                        .updated_at
                        .cmp(&left.updated_at)
                        .then_with(|| left.run_id.cmp(&right.run_id))
                });
                let runs = records
                    .iter()
                    .map(AgentRunSummary::from_record)
                    .collect::<Vec<_>>();
                Ok(serde_json::json!({
                    "sessionId": params.session_id,
                    "runs": runs,
                }))
            }
            "agent_run.get" => {
                let params: AgentRunIdParams = parse_params(request)?;
                let thread_owned = self.thread_owned_session(&params.session_id)?;
                let record = if thread_owned {
                    self.thread
                        .get_agent_run_from_threads(&params.session_id, &params.run_id)?
                        .ok_or_else(|| {
                            agent_run_not_found_error(&params.session_id, &params.run_id)
                        })?
                } else {
                    match self
                        .thread_log
                        .get_agent_run(&params.session_id, &params.run_id)?
                    {
                        Some(record) => record,
                        None => match self
                            .session
                            .get_agent_run(&params.session_id, &params.run_id)
                        {
                            Ok(record) => record,
                            Err(session_error) => match if self.thread.has_thread_store() {
                                self.thread.get_agent_run_from_threads(
                                    &params.session_id,
                                    &params.run_id,
                                )?
                            } else {
                                None
                            } {
                                Some(record) => record,
                                None => {
                                    if matches!(
                                        session_error.code,
                                        WorkerProtocolErrorCode::InvalidProtocol
                                    ) {
                                        return Err(agent_run_not_found_error(
                                            &params.session_id,
                                            &params.run_id,
                                        ));
                                    }
                                    return Err(session_error);
                                }
                            },
                        },
                    }
                };
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.list_trace" => {
                let params: AgentRunListTraceParams = parse_params(request)?;
                let thread_owned = self.thread_owned_session(&params.session_id)?;
                let trace_page = if thread_owned {
                    self.thread
                        .list_agent_run_trace_events(
                            &params.session_id,
                            &params.run_id,
                            params.cursor.as_deref(),
                            params.limit,
                        )?
                        .ok_or_else(|| {
                            agent_run_not_found_error(&params.session_id, &params.run_id)
                        })?
                } else {
                    match self.thread_log.list_agent_run_trace_events(
                        &params.session_id,
                        &params.run_id,
                        params.cursor.as_deref(),
                        params.limit,
                    )? {
                        Some(trace_page) => trace_page,
                        None => match self.session.list_agent_run_trace_events(
                            &params.session_id,
                            &params.run_id,
                            params.cursor.as_deref(),
                            params.limit,
                        ) {
                            Ok(trace_page) => trace_page,
                            Err(session_error) => match if self.thread.has_thread_store() {
                                self.thread.list_agent_run_trace_events(
                                    &params.session_id,
                                    &params.run_id,
                                    params.cursor.as_deref(),
                                    params.limit,
                                )?
                            } else {
                                None
                            } {
                                Some(trace_page) => trace_page,
                                None => {
                                    if matches!(
                                        session_error.code,
                                        WorkerProtocolErrorCode::InvalidProtocol
                                    ) {
                                        return Err(agent_run_not_found_error(
                                            &params.session_id,
                                            &params.run_id,
                                        ));
                                    }
                                    return Err(session_error);
                                }
                            },
                        },
                    }
                };
                serde_json::to_value(trace_page).map_err(serialization_error)
            }
            "agent_run.runtime_state" => {
                let params: AgentRunIdParams = parse_params(request)?;
                let thread_owned = self.thread_owned_session(&params.session_id)?;
                let runtime_state = if thread_owned {
                    self.thread
                        .get_agent_run_runtime_state(&params.session_id, &params.run_id)?
                        .ok_or_else(|| {
                            agent_run_not_found_error(&params.session_id, &params.run_id)
                        })?
                } else {
                    match self
                        .thread_log
                        .get_agent_run_runtime_state(&params.session_id, &params.run_id)?
                    {
                        Some(runtime_state) => runtime_state,
                        None => match self
                            .session
                            .get_agent_run_runtime_state(&params.session_id, &params.run_id)
                        {
                            Ok(runtime_state) => runtime_state,
                            Err(session_error) => match if self.thread.has_thread_store() {
                                self.thread.get_agent_run_runtime_state(
                                    &params.session_id,
                                    &params.run_id,
                                )?
                            } else {
                                None
                            } {
                                Some(runtime_state) => runtime_state,
                                None => {
                                    if matches!(
                                        session_error.code,
                                        WorkerProtocolErrorCode::InvalidProtocol
                                    ) {
                                        return Err(agent_run_not_found_error(
                                            &params.session_id,
                                            &params.run_id,
                                        ));
                                    }
                                    return Err(session_error);
                                }
                            },
                        },
                    }
                };
                serde_json::to_value(runtime_state).map_err(serialization_error)
            }
            "agent_run.append_trace" => {
                let params: AgentRunAppendTraceParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "agent_run.append_trace",
                )?;
                let record = self.thread_log.append_agent_run_trace_event(
                    &params.session_id,
                    &params.run_id,
                    params.event,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.append_trace_batch" => {
                let params: AgentRunAppendTraceBatchParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "agent_run.append_trace_batch",
                )?;
                let record = self.thread_log.append_agent_run_trace_events(
                    &params.session_id,
                    &params.run_id,
                    params.events,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.set_checkpoint" => {
                let params: AgentRunCheckpointParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "agent_run.set_checkpoint",
                )?;
                let record = self.thread_log.set_agent_run_checkpoint(
                    &params.session_id,
                    &params.run_id,
                    params.checkpoint,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.get_checkpoint" => {
                let params: AgentRunIdParams = parse_params(request)?;
                let thread_checkpoint = if self.thread.has_thread_store() {
                    self.thread
                        .get_session_checkpoint_from_threads(&params.session_id)?
                } else {
                    None
                };
                if let Some(checkpoint) = thread_checkpoint {
                    return Ok(checkpoint);
                }
                let checkpoint = match self
                    .thread_log
                    .get_agent_run_checkpoint(&params.session_id, &params.run_id)?
                {
                    Some(checkpoint) => Some(checkpoint),
                    None => self
                        .session
                        .get_agent_run_checkpoint(&params.session_id, &params.run_id)?,
                };
                serde_json::to_value(checkpoint).map_err(serialization_error)
            }
            "agent_run.clear_checkpoint" => {
                let params: AgentRunIdParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "agent_run.clear_checkpoint",
                )?;
                serde_json::to_value(
                    self.thread_log
                        .clear_agent_run_checkpoint(&params.session_id, &params.run_id)?,
                )
                .map_err(serialization_error)
            }
            "agent_run.mark_completed" => {
                let params: AgentRunMarkCompletedParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "agent_run.mark_completed",
                )?;
                let record = self.thread_log.mark_agent_run_completed(
                    &params.session_id,
                    &params.run_id,
                    &params.stop_reason,
                    params.final_content,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.mark_failed" => {
                let params: AgentRunMarkFailedParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "agent_run.mark_failed",
                )?;
                let record = self.thread_log.mark_agent_run_failed(
                    &params.session_id,
                    &params.run_id,
                    &params.stop_reason,
                    params.error,
                )?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.mark_cancelled" => {
                let params: AgentRunIdParams = parse_params(request)?;
                self.require_compatibility_persistence_authority(
                    &params.session_id,
                    "agent_run.mark_cancelled",
                )?;
                let record = self
                    .thread_log
                    .mark_agent_run_cancelled(&params.session_id, &params.run_id)?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }

    fn require_compatibility_persistence_authority(
        &self,
        session_id: &str,
        method: &str,
    ) -> Result<(), WorkerProtocolError> {
        if self.thread_owned_session(session_id)? {
            return Err(thread_owned_persistence_error(session_id, method));
        }
        Ok(())
    }

    fn thread_owned_session(&self, session_id: &str) -> Result<bool, WorkerProtocolError> {
        if !self.thread.has_thread_store() {
            return Ok(false);
        }
        Ok(self
            .thread
            .get_session_metadata_from_threads(session_id)?
            .is_some())
    }
}

fn thread_owned_persistence_error(session_id: &str, method: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "thread-owned persistence must use thread.* operations",
        serde_json::json!({
            "session_id": session_id,
            "method": method,
            "authority": "thread",
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn agent_run_not_found_error(session_id: &str, run_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "agent run not found",
        serde_json::json!({
            "session_id": session_id,
            "run_id": run_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
