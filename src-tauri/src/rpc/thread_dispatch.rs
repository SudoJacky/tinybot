use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_thread_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        let mut operation = self.threads.begin_operation()?;
        let result = (|| match request.method.as_str() {
            "thread.create" => {
                let mut params: CreateThreadRequest = parse_params(request)?;
                pin_thread_api_mode(&mut params, self.config.snapshot())?;
                let thread = operation.thread().create_thread(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::Create { thread: &thread },
                )?;
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.read" => {
                let params: ReadThreadRequest = parse_params(request)?;
                let cursor = params.cursor.clone();
                let before_sequence = params.before_sequence;
                let checkpoint_sequence = params.checkpoint_sequence;
                let checkpoint_id = params.checkpoint_id.clone();
                let limit = params.limit;
                let snapshot = operation.thread().read_thread(params)?;
                serde_json::to_value(operation.thread_log().hydrate_thread_snapshot(
                    snapshot,
                    cursor.as_deref(),
                    before_sequence,
                    checkpoint_sequence,
                    checkpoint_id.as_deref(),
                    limit,
                )?)
                .map_err(serialization_error)
            }
            "thread.history" => {
                let params: ThreadHistoryParams = parse_params(request)?;
                let projection = operation
                    .thread_log()
                    .get_thread_history(&params.thread_id, params.limit.unwrap_or(500))?;
                serde_json::to_value(projection).map_err(serialization_error)
            }
            "thread.resolve" => {
                let params: ThreadResolveParams = parse_params(request)?;
                Ok(serde_json::json!({
                    "threadId": operation.thread_log().resolve_thread_id(&params.identity)?,
                }))
            }
            "thread.context" => {
                let params: ThreadHistoryParams = parse_params(request)?;
                let projection = operation
                    .thread_log()
                    .get_thread_context(&params.thread_id, params.limit.unwrap_or(500))?;
                serde_json::to_value(projection).map_err(serialization_error)
            }
            "thread.resume" => {
                let params: ResumeThreadRequest = parse_params(request)?;
                let cursor = params.cursor.clone();
                let checkpoint_sequence = params.checkpoint_sequence;
                let checkpoint_id = params.checkpoint_id.clone();
                let limit = params.limit;
                let snapshot = operation.thread().resume_thread(params)?;
                operation
                    .thread_log()
                    .create_from_thread_record(&snapshot.thread)?;
                operation
                    .thread_log()
                    .set_thread_archived(&snapshot.thread.thread_id, false)?;
                serde_json::to_value(operation.thread_log().hydrate_thread_snapshot(
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
                serde_json::to_value(operation.thread().get_thread_status(params)?)
                    .map_err(serialization_error)
            }
            "thread.list" => {
                let params: ListThreadsRequest = parse_params(request)?;
                serde_json::to_value(operation.thread().list_threads(params)?)
                    .map_err(serialization_error)
            }
            "thread.search" => {
                let params: SearchThreadsRequest = parse_params(request)?;
                serde_json::to_value(operation.thread().search_threads(params)?)
                    .map_err(serialization_error)
            }
            "thread.update_metadata" => {
                let params: UpdateThreadMetadataRequest = parse_params(request)?;
                let thread = operation.thread().update_thread_metadata(params)?;
                operation.thread_log().create_from_thread_record(&thread)?;
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.archive" => {
                let params: ArchiveThreadRequest = parse_params(request)?;
                let archived = params.archived.unwrap_or(true);
                let targets = operation
                    .thread()
                    .archive_target_records(&params.thread_id, params.archive_children)?;
                let thread = operation.thread().archive_thread(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::Archive { targets, archived },
                )?;
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.unarchive" => {
                let mut params: ArchiveThreadRequest = parse_params(request)?;
                params.archived = Some(false);
                let targets = operation
                    .thread()
                    .archive_target_records(&params.thread_id, params.archive_children)?;
                let thread = operation.thread().unarchive_thread(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::Archive {
                        targets,
                        archived: false,
                    },
                )?;
                serde_json::to_value(thread).map_err(serialization_error)
            }
            "thread.delete" => {
                let params: DeleteThreadRequest = parse_params(request)?;
                let thread_id = params.thread_id.clone();
                let result = operation.thread().delete_thread(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::Delete {
                        thread_id: &thread_id,
                        deleted_children: &result.deleted_children,
                    },
                )?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.fork" => {
                let params: ForkThreadRequest = parse_params(request)?;
                let source_thread_id = params.thread_id.clone();
                let fork_after_sequence = params.fork_after_sequence;
                let include_children = params.include_children;
                let include_checkpoints = params.include_checkpoints;
                let fork = operation.thread().fork_thread(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::Fork {
                        source_thread_id: &source_thread_id,
                        fork_thread_id: &fork.thread_id,
                        fork_after_sequence,
                        include_children,
                        include_checkpoints,
                    },
                )?;
                serde_json::to_value(fork).map_err(serialization_error)
            }
            "thread.rollback" => {
                let params: ThreadRollbackParams = parse_params(request)?;
                serde_json::to_value(
                    operation
                        .thread_log()
                        .rollback_thread(&params.thread_id, params.num_turns)?,
                )
                .map_err(serialization_error)
                .and_then(|value| {
                    operation.sync_thread_projection(&params.thread_id)?;
                    Ok(value)
                })
            }
            "thread.append_items" => {
                let params: AppendThreadItemsRequest = parse_params(request)?;
                let result = operation.thread().append_items(params)?;
                operation
                    .thread_log()
                    .create_from_thread_record(&result.thread)?;
                operation
                    .thread_log()
                    .append_thread_items(&result.thread.thread_id, &result.items)?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.append_messages" => {
                let params: ThreadAppendMessagesParams = parse_params(request)?;
                let value = operation.thread_log().append_thread_messages(
                    &params.thread_id,
                    &params.turn_id,
                    params.messages,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(value).map_err(serialization_error)
            }
            "thread.task_progress.upsert" => {
                let params: ThreadTaskProgressUpsertParams = parse_params(request)?;
                let value = operation.thread_log().upsert_thread_task_progress(
                    &params.thread_id,
                    &params.turn_id,
                    &params.plan_id,
                    params.progress,
                    params.content,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(value).map_err(serialization_error)
            }
            "thread.events" => {
                let params: ThreadEventsRequest = parse_params(request)?;
                serde_json::to_value(operation.thread().thread_events(params)?)
                    .map_err(serialization_error)
            }
            "thread.restore_checkpoint" => {
                let params: RestoreThreadCheckpointRequest = parse_params(request)?;
                serde_json::to_value(operation.thread().restore_checkpoint(params)?)
                    .map_err(serialization_error)
            }
            "thread.agent_registry" => {
                let params: ThreadAgentRegistryRequest = parse_params(request)?;
                serde_json::to_value(operation.thread().agent_registry(params)?)
                    .map_err(serialization_error)
            }
            "thread.activity" => {
                let params: ThreadActivityRequest = parse_params(request)?;
                serde_json::to_value(operation.thread().activity(params)?)
                    .map_err(serialization_error)
            }
            "thread.start_turn" => {
                let mut params: StartThreadTurnRequest = parse_params(request)?;
                if params.trace_context.is_none() {
                    if let Some(turn_id) = params.turn_id.clone() {
                        params.trace_context =
                            Some(crate::agent::runtime_protocol::AgentTraceContext {
                                request_id: request.id.clone(),
                                trace_id: request.trace_id.clone(),
                                turn_id: params.turn_id.clone().unwrap_or_else(|| turn_id.clone()),
                                thread_id: Some(params.thread_id.clone()),
                                parent_turn_id: None,
                            });
                    }
                }
                let result = operation.thread().start_turn(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::RuntimeResult { result: &result },
                )?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.apply_op" => {
                let params: ThreadApplyOpRequest = parse_params(request)?;
                let source_thread_id = params.thread_id.clone();
                let op = params.op.clone();
                let archive_targets = match &op {
                    ThreadOp::Archive { archive_children } => Some(
                        operation
                            .thread()
                            .archive_target_records(&source_thread_id, *archive_children)?,
                    ),
                    ThreadOp::Unarchive { unarchive_children } => Some(
                        operation
                            .thread()
                            .archive_target_records(&source_thread_id, *unarchive_children)?,
                    ),
                    _ => None,
                };
                let archive_state = matches!(&op, ThreadOp::Archive { .. });
                let result = operation.thread().apply_op(params)?;
                let persistence = match op {
                    ThreadOp::Archive { .. } | ThreadOp::Unarchive { .. } => {
                        ThreadPersistenceOperation::Archive {
                            targets: archive_targets.unwrap_or_default(),
                            archived: archive_state,
                        }
                    }
                    ThreadOp::Fork {
                        fork_after_sequence,
                        include_children,
                        include_checkpoints,
                        ..
                    } => ThreadPersistenceOperation::Fork {
                        source_thread_id: &source_thread_id,
                        fork_thread_id: &result.snapshot.thread.thread_id,
                        fork_after_sequence,
                        include_children,
                        include_checkpoints,
                    },
                    _ => ThreadPersistenceOperation::RuntimeResult { result: &result },
                };
                persist_thread_operation(&operation, request, persistence)?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.continue_turn" => {
                let params: ContinueThreadTurnRequest = parse_params(request)?;
                let result = operation.thread().continue_turn(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::RuntimeResult { result: &result },
                )?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.interrupt" => {
                let params: InterruptThreadRequest = parse_params(request)?;
                let result = operation.thread().interrupt(params)?;
                persist_thread_operation(
                    &operation,
                    request,
                    ThreadPersistenceOperation::RuntimeResult { result: &result },
                )?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.append_turn_context" => {
                let params: ThreadAppendTurnContextParams = parse_params(request)?;
                operation
                    .thread_log()
                    .append_turn_context(&params.thread_id, params.context)?;
                operation.sync_thread_projection(&params.thread_id)?;
                Ok(serde_json::json!({ "persisted": true }))
            }
            "thread.latest_checkpoint" => {
                let params: ThreadIdParams = parse_params(request)?;
                let checkpoint = operation
                    .thread_log()
                    .latest_turn_checkpoint(&params.thread_id)?
                    .map(|checkpoint| checkpoint.checkpoint);
                serde_json::to_value(checkpoint).map_err(serialization_error)
            }
            "thread.clear_latest_checkpoint" => {
                let params: ThreadIdParams = parse_params(request)?;
                let value = operation
                    .thread_log()
                    .clear_latest_turn_checkpoint(&params.thread_id)?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(value).map_err(serialization_error)
            }
            "thread.commit_context_checkpoint" => {
                let params: ThreadCommitContextCheckpointParams = parse_params(request)?;
                let value = operation.thread_log().commit_context_checkpoint(
                    &params.thread_id,
                    &params.turn_id,
                    params.checkpoint,
                )?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(value).map_err(serialization_error)
            }
            "thread.clear" => {
                let params: ThreadIdParams = parse_params(request)?;
                let value = operation.thread_log().clear_thread(&params.thread_id)?;
                operation.sync_thread_projection(&params.thread_id)?;
                serde_json::to_value(value).map_err(serialization_error)
            }
            "thread.persistence.check" => {
                serde_json::to_value(operation.thread_log().check_state_index()?)
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
                let value = operation.thread_log().repair_state_index(mode)?;
                operation.reload_projection()?;
                serde_json::to_value(value).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        })();
        if let Err(error) = &result {
            if let Err(reload_error) = operation.reload_projection() {
                eprintln!(
                    "thread_projection_reload_failed method={} request_id={} trace_id={} operation_error={} reload_error={}",
                    request.method,
                    request.id,
                    request.trace_id,
                    error.message,
                    reload_error.message
                );
                return Err(reload_error);
            }
        }
        result
    }
}

fn pin_thread_api_mode(
    request: &mut CreateThreadRequest,
    config_snapshot: &Value,
) -> Result<(), WorkerProtocolError> {
    let api_mode = crate::agent::provider::resolve_provider_profile(config_snapshot, None, None)
        .map(|profile| profile.parsed_api_mode())
        .transpose()
        .map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                error,
                serde_json::json!({ "method": "thread.create" }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?
        .unwrap_or(crate::agent::provider::NativeProviderApiMode::ChatCompletions);
    if !request
        .metadata
        .extra
        .as_ref()
        .is_some_and(Value::is_object)
    {
        request.metadata.extra = Some(serde_json::json!({}));
    }
    if let Some(extra) = request.metadata.extra.as_mut() {
        extra["apiMode"] = Value::String(api_mode.as_str().to_string());
    }
    Ok(())
}

enum ThreadPersistenceOperation<'a> {
    Create {
        thread: &'a crate::threads::domain::ThreadRecord,
    },
    Archive {
        targets: Vec<crate::threads::domain::ThreadRecord>,
        archived: bool,
    },
    Delete {
        thread_id: &'a str,
        deleted_children: &'a [String],
    },
    Fork {
        source_thread_id: &'a str,
        fork_thread_id: &'a str,
        fork_after_sequence: Option<u64>,
        include_children: bool,
        include_checkpoints: bool,
    },
    RuntimeResult {
        result: &'a crate::threads::domain::ThreadTurnRuntimeResult,
    },
}

fn persist_thread_operation(
    operation: &crate::threads::workspace_store::WorkspaceThreadOperation<'_>,
    request: &WorkerRequest,
    persistence: ThreadPersistenceOperation<'_>,
) -> Result<(), WorkerProtocolError> {
    match persistence {
        ThreadPersistenceOperation::Create { thread } => {
            if let Err(error) = operation.thread_log().create_from_thread_record(thread) {
                if let Err(cleanup_error) = operation.thread().delete_thread(DeleteThreadRequest {
                    thread_id: thread.thread_id.clone(),
                    delete_children: false,
                }) {
                    eprintln!(
                        "thread_create_cleanup_failed request_id={} trace_id={} thread_id={} persistence_error={} cleanup_error={}",
                        request.id,
                        request.trace_id,
                        thread.thread_id,
                        error.message,
                        cleanup_error.message
                    );
                }
                return Err(error);
            }
            operation.sync_thread_projection(&thread.thread_id)
        }
        ThreadPersistenceOperation::Archive { targets, archived } => {
            for target in targets {
                operation.thread_log().create_from_thread_record(&target)?;
                operation
                    .thread_log()
                    .set_thread_archived(&target.thread_id, archived)?;
                operation.sync_thread_projection(&target.thread_id)?;
            }
            Ok(())
        }
        ThreadPersistenceOperation::Delete {
            thread_id,
            deleted_children,
        } => {
            for deleted_thread_id in deleted_children
                .iter()
                .map(String::as_str)
                .chain(std::iter::once(thread_id))
            {
                operation.thread_log().delete_thread(deleted_thread_id)?;
            }
            Ok(())
        }
        ThreadPersistenceOperation::Fork {
            source_thread_id,
            fork_thread_id,
            fork_after_sequence,
            include_children,
            include_checkpoints,
        } => {
            let targets = operation
                .thread()
                .archive_target_records(fork_thread_id, include_children)?;
            for target in targets {
                let forked_from_thread_id = target
                    .metadata
                    .extra
                    .get("forkedFromThreadId")
                    .and_then(Value::as_str)
                    .or_else(|| (target.thread_id == fork_thread_id).then_some(source_thread_id))
                    .ok_or_else(|| {
                        WorkerProtocolError::new(
                            WorkerProtocolErrorCode::InvalidProtocol,
                            "forked thread metadata is missing source Rollout identity",
                            serde_json::json!({ "threadId": target.thread_id }),
                            false,
                            WorkerProtocolErrorSource::RustCore,
                        )
                    })?;
                operation.thread_log().fork_from_rollout(
                    forked_from_thread_id,
                    &target,
                    (target.thread_id == fork_thread_id)
                        .then_some(fork_after_sequence)
                        .flatten(),
                    include_checkpoints,
                )?;
                operation.sync_thread_projection(&target.thread_id)?;
            }
            Ok(())
        }
        ThreadPersistenceOperation::RuntimeResult { result } => {
            persist_thread_runtime_result(operation, result)?;
            operation.sync_thread_projection(&result.snapshot.thread.thread_id)
        }
    }
}

pub(super) fn persist_thread_runtime_result(
    operation: &crate::threads::workspace_store::WorkspaceThreadOperation<'_>,
    result: &crate::threads::domain::ThreadTurnRuntimeResult,
) -> Result<(), WorkerProtocolError> {
    persist_thread_append_result(operation, &result.snapshot.thread, &result.appended_items)
}

pub(super) fn persist_thread_append_result(
    operation: &crate::threads::workspace_store::WorkspaceThreadOperation<'_>,
    thread: &crate::threads::domain::ThreadRecord,
    items: &[crate::threads::domain::ThreadItem],
) -> Result<(), WorkerProtocolError> {
    operation.thread_log().create_from_thread_record(thread)?;
    operation
        .thread_log()
        .append_thread_items(&thread.thread_id, items)
}
