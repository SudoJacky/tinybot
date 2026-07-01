const AGENT_RUNS_KEY: &str = "agent_runs";

impl WorkerSessionRpc {
    pub fn upsert_agent_run(
        &mut self,
        record: AgentRunRecord,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_agent_run_key(&record.session_id, &record.run_id)?;
        let record = {
            let session = self.session_mut_or_create(&record.session_id);
            ensure_extra_object(session);
            ensure_agent_runs_array(session);
            let runs = session
                .extra
                .get_mut(AGENT_RUNS_KEY)
                .and_then(Value::as_array_mut)
                .expect("agent_runs should be an array after ensure");
            if let Some(existing) = runs
                .iter_mut()
                .find(|value| value.get("runId").and_then(Value::as_str) == Some(&record.run_id))
            {
                let mut next = record.clone();
                if let Ok(existing_record) = serde_json::from_value::<AgentRunRecord>((*existing).clone()) {
                    next.started_at = existing_record.started_at;
                }
                *existing = serde_json::to_value(&next).map_err(session_serialization_error)?;
            } else {
                runs.push(serde_json::to_value(&record).map_err(session_serialization_error)?);
            }
            session.updated_at = now_session_timestamp();
            record
        };
        self.persist_sessions()?;
        Ok(record)
    }

    pub fn get_agent_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_agent_run_key(session_id, run_id)?;
        self.sessions
            .iter()
            .find(|session| session.session_id == session_id)
            .and_then(|session| agent_run_records(session).into_iter().find(|run| run.run_id == run_id))
            .ok_or_else(|| unknown_agent_run_error(session_id, run_id))
    }

    pub fn list_agent_runs(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentRunRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_session_id(session_id)?;
        let mut runs = self
            .sessions
            .iter()
            .find(|session| session.session_id == session_id)
            .map(agent_run_records)
            .unwrap_or_default();
        runs.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.run_id.cmp(&right.run_id))
        });
        Ok(runs)
    }

    pub fn list_agent_run_trace_events(
        &self,
        session_id: &str,
        run_id: &str,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<AgentRunTracePage, WorkerProtocolError> {
        let record = self.get_agent_run(session_id, run_id)?;
        let offset = parse_trace_cursor(cursor)?;
        let limit = limit.unwrap_or(100).clamp(1, 500);
        let items = record
            .trace_events
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_offset = offset.saturating_add(items.len());
        let next_cursor = (next_offset < record.trace_events.len()).then(|| next_offset.to_string());
        Ok(AgentRunTracePage {
            session_id: record.session_id,
            run_id: record.run_id,
            items,
            next_cursor,
        })
    }

    pub fn append_agent_run_trace_event(
        &mut self,
        session_id: &str,
        run_id: &str,
        event: Value,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut record = self.get_agent_run_for_update(session_id, run_id)?;
        record.trace_events.push(event);
        record.updated_at = now_session_timestamp();
        self.upsert_agent_run(record)
    }

    pub fn set_agent_run_checkpoint(
        &mut self,
        session_id: &str,
        run_id: &str,
        checkpoint: Value,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut record = self.get_agent_run_for_update(session_id, run_id)?;
        record.checkpoint = Some(checkpoint);
        record.updated_at = now_session_timestamp();
        self.upsert_agent_run(record)
    }

    pub fn get_agent_run_checkpoint(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunCheckpoint>, WorkerProtocolError> {
        let record = self.get_agent_run(session_id, run_id)?;
        Ok(record.checkpoint.map(|checkpoint| AgentRunCheckpoint {
            session_id: record.session_id,
            run_id: record.run_id,
            checkpoint,
        }))
    }

    pub fn clear_agent_run_checkpoint(
        &mut self,
        session_id: &str,
        run_id: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut record = self.get_agent_run_for_update(session_id, run_id)?;
        record.checkpoint = None;
        record.updated_at = now_session_timestamp();
        self.upsert_agent_run(record)
    }

    pub fn mark_agent_run_completed(
        &mut self,
        session_id: &str,
        run_id: &str,
        stop_reason: &str,
        final_content: Option<String>,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut record = self.get_agent_run_for_update(session_id, run_id)?;
        let timestamp = now_session_timestamp();
        if let Some(final_content) = final_content.filter(|content| !content.trim().is_empty()) {
            record.trace_messages.push(serde_json::json!({
                "role": "assistant",
                "content": final_content,
            }));
        }
        record.status = AgentRunStatus::Completed;
        record.phase = "done".to_string();
        record.stop_reason = Some(stop_reason.to_string());
        record.completed_at = Some(timestamp.clone());
        record.updated_at = timestamp;
        record.checkpoint = None;
        self.upsert_agent_run(record)
    }

    pub fn mark_agent_run_failed(
        &mut self,
        session_id: &str,
        run_id: &str,
        stop_reason: &str,
        error: Value,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut record = self.get_agent_run_for_update(session_id, run_id)?;
        let timestamp = now_session_timestamp();
        record.status = AgentRunStatus::Failed;
        record.phase = "failed".to_string();
        record.stop_reason = Some(stop_reason.to_string());
        record.error = Some(error);
        record.completed_at = Some(timestamp.clone());
        record.updated_at = timestamp;
        self.upsert_agent_run(record)
    }

    pub fn mark_agent_run_cancelled(
        &mut self,
        session_id: &str,
        run_id: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut record = self.get_agent_run_for_update(session_id, run_id)?;
        let timestamp = now_session_timestamp();
        record.status = AgentRunStatus::Cancelled;
        record.phase = "cancelled".to_string();
        record.stop_reason = Some("cancelled".to_string());
        record.completed_at = Some(timestamp.clone());
        record.updated_at = timestamp;
        self.upsert_agent_run(record)
    }

    pub fn latest_resumable_agent_run_checkpoint(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentRunCheckpoint>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_session_id(session_id)?;
        let mut runs = self.list_agent_runs(session_id)?;
        runs.retain(|run| run.status.is_resumable() && run.checkpoint.is_some());
        Ok(runs.into_iter().next().and_then(|run| {
            run.checkpoint.map(|checkpoint| AgentRunCheckpoint {
                session_id: run.session_id,
                run_id: run.run_id,
                checkpoint,
            })
        }))
    }

    fn get_agent_run_for_update(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        validate_agent_run_key(session_id, run_id)?;
        self.sessions
            .iter()
            .find(|session| session.session_id == session_id)
            .and_then(|session| agent_run_records(session).into_iter().find(|run| run.run_id == run_id))
            .ok_or_else(|| unknown_agent_run_error(session_id, run_id))
    }
}

impl AgentRunStatus {
    fn is_resumable(&self) -> bool {
        matches!(self, AgentRunStatus::Running | AgentRunStatus::Waiting)
    }
}

fn mirror_checkpoint_to_agent_run(
    session: &mut SessionMetadata,
    session_id: &str,
    checkpoint: Value,
    timestamp: &str,
) -> Result<(), WorkerProtocolError> {
    let Some(run_id) = checkpoint_run_id(&checkpoint) else {
        return Ok(());
    };
    ensure_agent_runs_array(session);
    let runs = session
        .extra
        .get_mut(AGENT_RUNS_KEY)
        .and_then(Value::as_array_mut)
        .expect("agent_runs should be an array after ensure");
    let mut record = runs
        .iter()
        .find_map(|value| {
            serde_json::from_value::<AgentRunRecord>(value.clone())
                .ok()
                .filter(|record| record.run_id == run_id)
        })
        .unwrap_or_else(|| agent_run_from_checkpoint(session_id, &run_id, &checkpoint, timestamp));
    record.phase = checkpoint
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or(record.phase.as_str())
        .to_string();
    record.status = agent_run_status_from_checkpoint(&checkpoint);
    record.updated_at = timestamp.to_string();
    if matches!(record.status, AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled)
        && record.completed_at.is_none()
    {
        record.completed_at = Some(timestamp.to_string());
    }
    record.current_iteration = checkpoint
        .get("iteration")
        .and_then(Value::as_i64)
        .unwrap_or(record.current_iteration);
    record.max_iterations = checkpoint
        .get("maxIterations")
        .or_else(|| checkpoint.get("max_iterations"))
        .and_then(Value::as_i64)
        .unwrap_or(record.max_iterations);
    record.pending_tool_calls = checkpoint
        .get("pendingToolCalls")
        .or_else(|| checkpoint.get("pending_tool_calls"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    record.completed_tool_results = checkpoint
        .get("completedToolResults")
        .or_else(|| checkpoint.get("completed_tool_results"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    record.checkpoint = Some(checkpoint);
    let value = serde_json::to_value(&record).map_err(session_serialization_error)?;
    if let Some(existing) = runs
        .iter_mut()
        .find(|value| value.get("runId").and_then(Value::as_str) == Some(run_id.as_str()))
    {
        *existing = value;
    } else {
        runs.push(value);
    }
    Ok(())
}

fn latest_resumable_checkpoint_for_session(session: &SessionMetadata) -> Option<AgentRunCheckpoint> {
    let mut runs = agent_run_records(session);
    runs.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    runs.into_iter().find_map(|run| {
        if !run.status.is_resumable() {
            return None;
        }
        run.checkpoint.map(|checkpoint| AgentRunCheckpoint {
            session_id: run.session_id,
            run_id: run.run_id,
            checkpoint,
        })
    })
}

fn clear_compatible_agent_run_checkpoint(
    session: &mut SessionMetadata,
    legacy_checkpoint: Option<&Value>,
) -> Result<(), WorkerProtocolError> {
    let selected_run_id = legacy_checkpoint
        .and_then(checkpoint_run_id)
        .or_else(|| latest_resumable_checkpoint_for_session(session).map(|checkpoint| checkpoint.run_id));
    let Some(run_id) = selected_run_id else {
        return Ok(());
    };
    let mut runs = agent_run_records(session);
    for run in &mut runs {
        if run.run_id == run_id {
            run.checkpoint = None;
            run.updated_at = now_session_timestamp();
            break;
        }
    }
    ensure_agent_runs_array(session);
    session.extra[AGENT_RUNS_KEY] = serde_json::to_value(runs).map_err(session_serialization_error)?;
    Ok(())
}

fn checkpoint_run_id(checkpoint: &Value) -> Option<String> {
    checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn agent_run_from_checkpoint(
    session_id: &str,
    run_id: &str,
    checkpoint: &Value,
    timestamp: &str,
) -> AgentRunRecord {
    AgentRunRecord {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        status: AgentRunStatus::Waiting,
        phase: checkpoint
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("awaiting_checkpoint")
            .to_string(),
        started_at: timestamp.to_string(),
        updated_at: timestamp.to_string(),
        completed_at: None,
        stop_reason: checkpoint
            .get("stopReason")
            .or_else(|| checkpoint.get("stop_reason"))
            .and_then(Value::as_str)
            .map(str::to_string),
        model: checkpoint
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        provider: checkpoint
            .get("provider")
            .and_then(Value::as_str)
            .map(str::to_string),
        max_iterations: checkpoint
            .get("maxIterations")
            .or_else(|| checkpoint.get("max_iterations"))
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        current_iteration: checkpoint
            .get("iteration")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        conversation_message_ids: Vec::new(),
        trace_messages: checkpoint
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        trace_events: Vec::new(),
        completed_tool_results: checkpoint
            .get("completedToolResults")
            .or_else(|| checkpoint.get("completed_tool_results"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        pending_tool_calls: checkpoint
            .get("pendingToolCalls")
            .or_else(|| checkpoint.get("pending_tool_calls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        checkpoint: Some(checkpoint.clone()),
        artifacts: Vec::new(),
        usage: Vec::new(),
        error: None,
    }
}

fn agent_run_status_from_checkpoint(checkpoint: &Value) -> AgentRunStatus {
    match checkpoint
        .get("stopReason")
        .or_else(|| checkpoint.get("stop_reason"))
        .and_then(Value::as_str)
        .or_else(|| checkpoint.get("phase").and_then(Value::as_str))
    {
        Some("final_response") | Some("done") | Some("terminal") => AgentRunStatus::Completed,
        Some("cancelled") => AgentRunStatus::Cancelled,
        Some("provider_error")
        | Some("tool_error")
        | Some("policy_denied")
        | Some("max_iterations")
        | Some("invalid_request")
        | Some("approval_denied")
        | Some("form_cancelled")
        | Some("failed") => AgentRunStatus::Failed,
        _ => AgentRunStatus::Waiting,
    }
}

fn validate_agent_run_key(session_id: &str, run_id: &str) -> Result<(), WorkerProtocolError> {
    validate_session_id(session_id)?;
    validate_session_id(run_id)
}

fn ensure_agent_runs_array(session: &mut SessionMetadata) {
    if !session.extra.get(AGENT_RUNS_KEY).is_some_and(Value::is_array) {
        session.extra[AGENT_RUNS_KEY] = serde_json::json!([]);
    }
}

fn agent_run_records(session: &SessionMetadata) -> Vec<AgentRunRecord> {
    session
        .extra
        .get(AGENT_RUNS_KEY)
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|value| serde_json::from_value(value.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_trace_cursor(cursor: Option<&str>) -> Result<usize, WorkerProtocolError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .parse::<usize>()
        .map_err(|_| WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid agent run trace cursor",
            serde_json::json!({ "cursor": cursor }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
}

fn unknown_agent_run_error(session_id: &str, run_id: &str) -> WorkerProtocolError {
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
