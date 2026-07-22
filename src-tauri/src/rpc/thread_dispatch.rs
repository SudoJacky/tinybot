use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_thread_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.refresh_thread_projection()?;
        match request.method.as_str() {
            "thread.create" => {
                let params: CreateThreadRequest = parse_params(request)?;
                let thread = self.thread.create_thread(params)?;
                if let Err(error) = self.thread_log.create_from_thread_record(&thread) {
                    if let Err(cleanup_error) = self.thread.delete_thread(DeleteThreadRequest {
                        thread_id: thread.thread_id.clone(),
                        delete_children: false,
                    }) {
                        eprintln!(
                            "thread_create_cleanup_failed thread_id={} error={}",
                            thread.thread_id, cleanup_error.message
                        );
                    }
                    return Err(error);
                }
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.read" => {
                let params: ReadThreadRequest = parse_params(request)?;
                let cursor = params.cursor.clone();
                let before_sequence = params.before_sequence;
                let checkpoint_sequence = params.checkpoint_sequence;
                let checkpoint_id = params.checkpoint_id.clone();
                let limit = params.limit;
                let snapshot = self.thread.read_thread(params)?;
                serde_json::to_value(self.thread_log.hydrate_thread_snapshot(
                    snapshot,
                    cursor.as_deref(),
                    before_sequence,
                    checkpoint_sequence,
                    checkpoint_id.as_deref(),
                    limit,
                )?)
                .map_err(serialization_error)
            }
            "thread.resume" => {
                let params: ResumeThreadRequest = parse_params(request)?;
                let cursor = params.cursor.clone();
                let checkpoint_sequence = params.checkpoint_sequence;
                let checkpoint_id = params.checkpoint_id.clone();
                let limit = params.limit;
                let snapshot = self.thread.resume_thread(params)?;
                self.thread_log
                    .create_from_thread_record(&snapshot.thread)?;
                self.thread_log
                    .set_thread_archived(&snapshot.thread.thread_id, false)?;
                serde_json::to_value(self.thread_log.hydrate_thread_snapshot(
                    snapshot,
                    cursor.as_deref(),
                    None,
                    checkpoint_sequence,
                    checkpoint_id.as_deref(),
                    limit,
                )?)
                .map_err(serialization_error)
            }
            "thread.status" => {
                let params: ThreadIdParams = parse_params(request)?;
                serde_json::to_value(self.thread.get_thread_status(params)?)
                    .map_err(serialization_error)
            }
            "thread.list" => {
                let params: ListThreadsRequest = parse_params(request)?;
                serde_json::to_value(self.thread.list_threads(params)?).map_err(serialization_error)
            }
            "thread.search" => {
                let params: SearchThreadsRequest = parse_params(request)?;
                serde_json::to_value(self.thread.search_threads(params)?)
                    .map_err(serialization_error)
            }
            "thread.update_metadata" => {
                let params: UpdateThreadMetadataRequest = parse_params(request)?;
                let thread = self.thread.update_thread_metadata(params)?;
                self.thread_log.create_from_thread_record(&thread)?;
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.archive" => {
                let params: ArchiveThreadRequest = parse_params(request)?;
                let archived = params.archived.unwrap_or(true);
                let targets = self
                    .thread
                    .archive_target_records(&params.thread_id, params.archive_children)?;
                let thread = self.thread.archive_thread(params)?;
                for target in targets {
                    self.thread_log.create_from_thread_record(&target)?;
                    self.thread_log
                        .set_thread_archived(&target.thread_id, archived)?;
                }
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.unarchive" => {
                let mut params: ArchiveThreadRequest = parse_params(request)?;
                params.archived = Some(false);
                let targets = self
                    .thread
                    .archive_target_records(&params.thread_id, params.archive_children)?;
                let thread = self.thread.unarchive_thread(params)?;
                for target in targets {
                    self.thread_log.create_from_thread_record(&target)?;
                    self.thread_log
                        .set_thread_archived(&target.thread_id, false)?;
                }
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.delete" => {
                let params: DeleteThreadRequest = parse_params(request)?;
                let thread_id = params.thread_id.clone();
                let result = self.thread.delete_thread(params)?;
                for deleted_thread_id in result
                    .deleted_children
                    .iter()
                    .chain(std::iter::once(&thread_id))
                {
                    self.thread_log.delete_thread(deleted_thread_id)?;
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.fork" => {
                let params: ForkThreadRequest = parse_params(request)?;
                let source_thread_id = params.thread_id.clone();
                let fork_after_sequence = params.fork_after_sequence;
                let include_children = params.include_children;
                let include_checkpoints = params.include_checkpoints;
                let fork = self.thread.fork_thread(params)?;
                let targets = self
                    .thread
                    .archive_target_records(&fork.thread_id, include_children)?;
                for target in targets {
                    let forked_from_thread_id = target
                        .metadata
                        .extra
                        .get("forkedFromThreadId")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            (target.thread_id == fork.thread_id)
                                .then_some(source_thread_id.as_str())
                        })
                        .ok_or_else(|| {
                            WorkerProtocolError::new(
                                WorkerProtocolErrorCode::InvalidProtocol,
                                "forked thread metadata is missing source Rollout identity",
                                serde_json::json!({ "threadId": target.thread_id }),
                                false,
                                WorkerProtocolErrorSource::RustCore,
                            )
                        })?;
                    self.thread_log.fork_from_rollout(
                        forked_from_thread_id,
                        &target,
                        (target.thread_id == fork.thread_id)
                            .then_some(fork_after_sequence)
                            .flatten(),
                        include_checkpoints,
                    )?;
                }
                serde_json::to_value(fork).map_err(serialization_error)
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
                let result = self.thread.append_items(params)?;
                self.thread_log.create_from_thread_record(&result.thread)?;
                self.thread_log
                    .append_thread_items(&result.thread.thread_id, &result.items)?;
                serde_json::to_value(result).map_err(serialization_error)
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
                            Some(crate::agent::runtime_protocol::AgentTraceContext {
                                request_id: request.id.clone(),
                                trace_id: request.trace_id.clone(),
                                run_id: run_id.clone(),
                                turn_id: params.turn_id.clone().unwrap_or_else(|| run_id.clone()),
                                thread_id: Some(params.thread_id.clone()),
                                parent_run_id: None,
                            });
                    }
                }
                let result = self.thread.start_turn(params)?;
                self.persist_thread_runtime_result(&result)?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.apply_op" => {
                let params: ThreadApplyOpRequest = parse_params(request)?;
                let source_thread_id = params.thread_id.clone();
                let op = params.op.clone();
                let archive_targets = match &op {
                    ThreadOp::Archive { archive_children } => Some(
                        self.thread
                            .archive_target_records(&source_thread_id, *archive_children)?,
                    ),
                    ThreadOp::Unarchive { unarchive_children } => Some(
                        self.thread
                            .archive_target_records(&source_thread_id, *unarchive_children)?,
                    ),
                    _ => None,
                };
                let archive_state = matches!(&op, ThreadOp::Archive { .. });
                let result = self.thread.apply_op(params)?;
                match op {
                    ThreadOp::Archive { .. } | ThreadOp::Unarchive { .. } => {
                        for target in archive_targets.unwrap_or_default() {
                            self.thread_log.create_from_thread_record(&target)?;
                            self.thread_log
                                .set_thread_archived(&target.thread_id, archive_state)?;
                        }
                    }
                    ThreadOp::Fork {
                        fork_after_sequence,
                        include_children,
                        include_checkpoints,
                        ..
                    } => {
                        let targets = self.thread.archive_target_records(
                            &result.snapshot.thread.thread_id,
                            include_children,
                        )?;
                        for target in targets {
                            let forked_from_thread_id = target
                                .metadata
                                .extra
                                .get("forkedFromThreadId")
                                .and_then(Value::as_str)
                                .or_else(|| {
                                    (target.thread_id == result.snapshot.thread.thread_id)
                                        .then_some(source_thread_id.as_str())
                                })
                                .ok_or_else(|| {
                                    WorkerProtocolError::new(
                                        WorkerProtocolErrorCode::InvalidProtocol,
                                        "forked thread metadata is missing source Rollout identity",
                                        serde_json::json!({ "threadId": target.thread_id }),
                                        false,
                                        WorkerProtocolErrorSource::RustCore,
                                    )
                                })?;
                            self.thread_log.fork_from_rollout(
                                forked_from_thread_id,
                                &target,
                                (target.thread_id == result.snapshot.thread.thread_id)
                                    .then_some(fork_after_sequence)
                                    .flatten(),
                                include_checkpoints,
                            )?;
                        }
                    }
                    _ => self.persist_thread_runtime_result(&result)?,
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.continue_turn" => {
                let params: ContinueThreadTurnRequest = parse_params(request)?;
                let result = self.thread.continue_turn(params)?;
                self.persist_thread_runtime_result(&result)?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.interrupt" => {
                let params: InterruptThreadRequest = parse_params(request)?;
                let result = self.thread.interrupt(params)?;
                self.persist_thread_runtime_result(&result)?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.persistence.check" => {
                serde_json::to_value(self.thread_log.check_state_index()?)
                    .map_err(serialization_error)
            }
            "thread.persistence.repair" => {
                let params: ThreadPersistenceRepairRequest = parse_params(request)?;
                let mode = match params.mode {
                    crate::threads::domain::ThreadPersistenceRepairMode::MigrateLegacyProjection
                    | crate::threads::domain::ThreadPersistenceRepairMode::RebuildProjection => {
                        crate::threads::rollout::store::ThreadLogIndexRepairMode::RebuildIndex
                    }
                };
                serde_json::to_value(self.thread_log.repair_state_index(mode)?)
                    .map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }

    pub(super) fn persist_thread_runtime_result(
        &mut self,
        result: &crate::threads::domain::ThreadTurnRuntimeResult,
    ) -> Result<(), WorkerProtocolError> {
        self.persist_thread_append_result(&result.snapshot.thread, &result.appended_items)
    }

    pub(super) fn persist_thread_append_result(
        &mut self,
        thread: &crate::threads::domain::ThreadRecord,
        items: &[crate::threads::domain::ThreadItem],
    ) -> Result<(), WorkerProtocolError> {
        self.thread_log.create_from_thread_record(thread)?;
        self.thread_log
            .append_thread_items(&thread.thread_id, items)?;
        Ok(())
    }

    pub(super) fn refresh_thread_projection(&mut self) -> Result<(), WorkerProtocolError> {
        let (threads, items) = self.thread_log.thread_projection()?;
        self.thread.replace_projection(threads, items)
    }
}
