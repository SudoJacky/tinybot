use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_subagent_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "subagent.spawn" => {
                let params: SubagentSpawnParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                let result = manager.spawn(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_spawn(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.list" => {
                let params: SubagentListParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                serde_json::to_value(manager.list(&params.session_key)).map_err(serialization_error)
            }
            "subagent.query" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                serde_json::to_value(manager.query(params)).map_err(serialization_error)
            }
            "subagent.send_input" => {
                let params: SubagentSendInputParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                let result = manager.enqueue_input(params);
                if result.accepted {
                    if let (Some(subagent), Some(input)) = (&result.subagent, &result.input) {
                        self.thread.record_subagent_input(
                            subagent,
                            input,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.wait" => {
                let params: SubagentWaitParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                let cancellation = request.cancellation();
                let result = manager.wait_with_cancellation(params, || {
                    cancellation
                        .as_ref()
                        .is_some_and(|cancellation| cancellation.is_cancelled())
                });
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.cancel" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                let result = manager.cancel(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_status(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.close" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                let result = manager.close(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_status(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.resume" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let manager = self.restore_subagent_session(&params.session_key)?;
                let result = manager.resume(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_status(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }

    fn restore_subagent_session(
        &self,
        session_key: &str,
    ) -> Result<SubagentThreadManager, WorkerProtocolError> {
        let manager = self
            .subagents
            .clone()
            .ok_or_else(unavailable_subagent_manager)?;
        let registry = self.thread.agent_registry(ThreadAgentRegistryRequest {
            thread_id: None,
            include_archived: true,
            include_child_threads: true,
        })?;
        let durable = registry
            .agents
            .iter()
            .filter_map(durable_subagent_summary)
            .filter(|summary| summary.session_key == session_key)
            .collect::<Vec<_>>();
        if durable.is_empty() {
            let trace_events = self
                .background
                .list_trace_events(BackgroundTraceListParams {
                    filter: Some(BackgroundTraceListFilter {
                        session_key: Some(session_key.to_string()),
                        ..Default::default()
                    }),
                })?
                .events;
            manager.restore_interrupted_from_trace_events(session_key, &trace_events);
            return Ok(manager);
        }
        let active_ids = durable
            .iter()
            .filter(|summary| summary.status.is_active())
            .map(|summary| summary.subagent_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let restored = manager.restore_from_durable_summaries(session_key, &durable);
        for summary in restored
            .iter()
            .filter(|summary| active_ids.contains(&summary.subagent_id))
        {
            self.thread.record_subagent_status(summary, None)?;
        }
        Ok(manager)
    }
}

fn durable_subagent_summary(entry: &ThreadAgentRegistryEntry) -> Option<SubagentThreadSummary> {
    if entry.source != "subagent" {
        return None;
    }
    let control = entry.agent_control.as_ref()?;
    let lifecycle = control.get("lifecycle")?;
    let session_key = entry
        .session_key
        .clone()
        .or_else(|| string_value(control, "sessionKey"))?;
    let status = lifecycle
        .get("status")
        .cloned()
        .and_then(|value| serde_json::from_value::<SubagentThreadStatus>(value).ok())?;
    Some(SubagentThreadSummary {
        session_key,
        parent_run_id: entry.parent_run_id.clone(),
        parent_subagent_id: entry
            .parent_agent_id
            .clone()
            .or_else(|| string_value(control, "parentAgentId")),
        subagent_id: entry.agent_id.clone(),
        child_run_id: entry
            .run_id
            .clone()
            .unwrap_or_else(|| entry.agent_id.clone()),
        delegation_depth: usize::try_from(entry.depth).unwrap_or(usize::MAX),
        history_mode: entry
            .history_mode
            .as_ref()
            .and_then(|value| {
                serde_json::from_value::<SubagentHistoryMode>(Value::String(value.clone())).ok()
            })
            .unwrap_or_default(),
        trace_ref: entry.trace_ref.clone(),
        name: entry.nickname.clone(),
        task: entry.task.clone().unwrap_or_default(),
        status,
        created_at: entry.created_at.clone(),
        updated_at: entry.updated_at.clone(),
        closed_at: string_value(lifecycle, "closedAt"),
        mailbox_depth: lifecycle
            .get("mailboxDepth")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0),
        terminal_result: string_value(lifecycle, "terminalResult"),
        blocker_summary: string_value(lifecycle, "blockerSummary"),
        pending_approval: lifecycle
            .get("pendingApproval")
            .filter(|value| !value.is_null())
            .cloned(),
        metadata: control
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    })
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
