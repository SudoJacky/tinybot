use super::{
    now_thread_timestamp, read_thread_lines, thread_id_for_session_id, value_event,
    AgentRunRecoveryEntry, AgentRunRecoveryReport, WorkerThreadLogRpc,
};
use crate::agent_loop_runtime_protocol::{
    AgentRuntimeEventEnvelope, LegacyNativeAgentEventEnvelopeInput,
};
use crate::worker_capability::WorkerCapability;
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_session::{
    AgentRunCheckpoint, AgentRunRecord, AgentRunRuntimeState, AgentRunStatus, AgentRunTracePage,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

impl WorkerThreadLogRpc {
    pub fn upsert_agent_run(
        &self,
        mut record: AgentRunRecord,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_agent_run_key(&record.session_id, &record.run_id)?;
        let existing = self.get_agent_run_record(&record.session_id, &record.run_id)?;
        if let Some(existing) = existing {
            record.started_at = existing.started_at;
        }
        let timestamp = now_thread_timestamp();
        let mut state = self.ensure_agent_run_thread(&record.session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            value_event("agent_run_upsert", serde_json::json!({ "record": record })),
        )?;
        state.updated_at = timestamp;
        if !record.model.trim().is_empty() {
            state.model = Some(record.model.clone());
        }
        state.model_provider = record.provider.clone();
        if let Some(info) = record.token_usage_info.as_ref() {
            state.tokens_used = info.total_token_usage.total_tokens;
        }
        self.state.upsert_thread(&state)?;
        Ok(record)
    }

    pub fn append_agent_run_trace_event(
        &self,
        session_id: &str,
        run_id: &str,
        event: Value,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.append_agent_run_trace_events(session_id, run_id, vec![event])
    }

    pub fn append_agent_run_trace_events(
        &self,
        session_id: &str,
        run_id: &str,
        events: Vec<Value>,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_agent_run_key(session_id, run_id)?;
        if events.is_empty() {
            return Err(empty_agent_run_trace_batch_error(session_id, run_id));
        }
        let mut record = self
            .get_agent_run_record(session_id, run_id)?
            .ok_or_else(|| unknown_agent_run_error(session_id, run_id))?;
        let timestamp = now_thread_timestamp();
        let state = self.ensure_agent_run_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let items = events
            .iter()
            .cloned()
            .map(|event| {
                value_event(
                    "agent_run_trace",
                    serde_json::json!({
                        "sessionId": session_id,
                        "runId": run_id,
                        "event": event,
                    }),
                )
            })
            .collect();
        self.recorder
            .append_items(&path, timestamp.clone(), items)?;
        for event in events {
            upsert_trace_event(&mut record.trace_events, event.clone());
            apply_agent_status_snapshot(&mut record, &event);
        }
        record.updated_at = timestamp.clone();
        Ok(record)
    }

    pub fn list_agent_runs(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentRunRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.agent_run_records_for_session(session_id)
    }

    pub fn reconcile_orphaned_agent_runs(
        &self,
    ) -> Result<AgentRunRecoveryReport, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.require(WorkerCapability::SessionWrite)?;
        self.ensure_state_index()?;
        let mut session_ids = self
            .state
            .list_all_threads()?
            .into_iter()
            .map(|record| record.session_id.unwrap_or(record.id))
            .collect::<Vec<_>>();
        session_ids.sort();
        session_ids.dedup();
        let mut report = AgentRunRecoveryReport {
            scanned_sessions: session_ids.len(),
            ..Default::default()
        };
        for session_id in session_ids {
            for run in self.agent_run_records_for_session(&session_id)? {
                report.scanned_runs = report.scanned_runs.saturating_add(1);
                let entry = AgentRunRecoveryEntry {
                    session_id: run.session_id.clone(),
                    run_id: run.run_id.clone(),
                    thread_id: run.thread_id.clone(),
                };
                match run.status {
                    AgentRunStatus::Running => {
                        self.mark_agent_run_interrupted(
                            &run.session_id,
                            &run.run_id,
                            "Runtime restarted before the run reached a terminal state.",
                        )?;
                        report.interrupted_runs.push(entry);
                    }
                    AgentRunStatus::Waiting if run.checkpoint.is_some() => {
                        report.resumable_runs.push(entry);
                    }
                    AgentRunStatus::Waiting => {
                        report.awaiting_interaction_runs.push(entry);
                    }
                    AgentRunStatus::Completed
                    | AgentRunStatus::Failed
                    | AgentRunStatus::Cancelled
                    | AgentRunStatus::Interrupted => {}
                }
            }
        }
        report.interrupted_runs.sort();
        report.interrupted_runs.dedup();
        report.awaiting_interaction_runs.sort();
        report.awaiting_interaction_runs.dedup();
        report.resumable_runs.sort();
        report.resumable_runs.dedup();
        Ok(report)
    }

    pub fn get_agent_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_agent_run_key(session_id, run_id)?;
        self.get_agent_run_record(session_id, run_id)
    }

    pub fn list_agent_run_trace_events(
        &self,
        session_id: &str,
        run_id: &str,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Option<AgentRunTracePage>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        let Some(record) = self.get_agent_run(session_id, run_id)? else {
            return Ok(None);
        };
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
        let next_cursor =
            (next_offset < record.trace_events.len()).then(|| next_offset.to_string());
        Ok(Some(AgentRunTracePage {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            items,
            next_cursor,
        }))
    }

    pub fn get_agent_run_runtime_state(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRuntimeState>, WorkerProtocolError> {
        let Some(record) = self.get_agent_run(session_id, run_id)? else {
            return Ok(None);
        };
        let runtime_events = record
            .trace_events
            .iter()
            .enumerate()
            .filter_map(|(index, event)| runtime_event_from_trace_value(&record, index, event))
            .collect::<Vec<_>>();
        Ok(Some(AgentRunRuntimeState::from_runtime_events(
            session_id,
            run_id,
            runtime_events,
        )?))
    }

    pub fn set_agent_run_checkpoint(
        &self,
        session_id: &str,
        run_id: &str,
        checkpoint: Value,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_agent_run_key(session_id, run_id)?;
        let timestamp = now_thread_timestamp();
        let mut record = self
            .get_agent_run_record(session_id, run_id)?
            .unwrap_or_else(|| {
                agent_run_from_checkpoint(session_id, run_id, &checkpoint, &timestamp)
            });
        let mut state = self.ensure_agent_run_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            value_event(
                "agent_run_checkpoint_set",
                serde_json::json!({
                    "sessionId": session_id,
                    "runId": run_id,
                    "checkpoint": checkpoint,
                }),
            ),
        )?;
        apply_checkpoint_to_record(&mut record, checkpoint, &timestamp);
        state.updated_at = timestamp;
        self.state.upsert_thread(&state)?;
        Ok(record)
    }

    pub fn latest_agent_run_checkpoint(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentRunCheckpoint>, WorkerProtocolError> {
        let mut runs = self.list_agent_runs(session_id)?;
        runs.retain(|run| run.checkpoint.is_some() && agent_run_status_is_resumable(&run.status));
        Ok(runs.into_iter().next().and_then(|run| {
            run.checkpoint.map(|checkpoint| AgentRunCheckpoint {
                session_id: run.session_id,
                run_id: run.run_id,
                checkpoint,
            })
        }))
    }

    pub fn clear_latest_agent_run_checkpoint(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentRunRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut runs = self.agent_run_records_for_session(session_id)?;
        runs.retain(|run| run.checkpoint.is_some() && agent_run_status_is_resumable(&run.status));
        let Some(run) = runs.into_iter().next() else {
            return Ok(None);
        };
        self.clear_agent_run_checkpoint(session_id, &run.run_id)
            .map(Some)
    }

    pub fn get_agent_run_checkpoint(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunCheckpoint>, WorkerProtocolError> {
        let Some(record) = self.get_agent_run(session_id, run_id)? else {
            return Ok(None);
        };
        Ok(record.checkpoint.map(|checkpoint| AgentRunCheckpoint {
            session_id: record.session_id,
            run_id: record.run_id,
            checkpoint,
        }))
    }

    pub fn clear_agent_run_checkpoint(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_agent_run_key(session_id, run_id)?;
        let mut record = self
            .get_agent_run_record(session_id, run_id)?
            .ok_or_else(|| unknown_agent_run_error(session_id, run_id))?;
        let timestamp = now_thread_timestamp();
        let mut state = self.ensure_agent_run_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            value_event(
                "agent_run_checkpoint_clear",
                serde_json::json!({ "sessionId": session_id, "runId": run_id }),
            ),
        )?;
        record.checkpoint = None;
        record.updated_at = timestamp.clone();
        state.updated_at = timestamp;
        self.state.upsert_thread(&state)?;
        Ok(record)
    }

    pub fn mark_agent_run_completed(
        &self,
        session_id: &str,
        run_id: &str,
        stop_reason: &str,
        final_content: Option<String>,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        let mut record = self.mark_agent_run_terminal(
            session_id,
            run_id,
            AgentRunStatus::Completed,
            "completed",
            Some(stop_reason.to_string()),
            final_content,
            None,
        )?;
        if let Some(info) = record.token_usage_info.clone() {
            let info_value = serde_json::to_value(info).map_err(thread_log_serialization_error)?;
            let info = serde_json::from_value::<super::TokenUsageInfo>(info_value)
                .map_err(thread_log_serialization_error)?;
            self.append_token_count(session_id, info)?;
            record.checkpoint = None;
        }
        Ok(record)
    }

    pub fn mark_agent_run_failed(
        &self,
        session_id: &str,
        run_id: &str,
        stop_reason: &str,
        error: Value,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.mark_agent_run_terminal(
            session_id,
            run_id,
            AgentRunStatus::Failed,
            "failed",
            Some(stop_reason.to_string()),
            None,
            Some(error),
        )
    }

    pub fn mark_agent_run_cancelled(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.mark_agent_run_terminal(
            session_id,
            run_id,
            AgentRunStatus::Cancelled,
            "cancelled",
            Some("cancelled".to_string()),
            None,
            None,
        )
    }

    pub fn mark_agent_run_interrupted(
        &self,
        session_id: &str,
        run_id: &str,
        reason: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        let record = self
            .get_agent_run_record(session_id, run_id)?
            .ok_or_else(|| unknown_agent_run_error(session_id, run_id))?;
        if record.status != AgentRunStatus::Running {
            return Ok(record);
        }
        self.append_agent_run_trace_event(
            session_id,
            run_id,
            serde_json::json!({
                "eventId": format!("startup-recovery:{session_id}:{run_id}"),
                "eventName": "agent.cancelled",
                "timestamp": now_thread_timestamp(),
                "payload": {
                    "runId": run_id,
                    "sessionId": session_id,
                    "cancelled": true,
                    "stopReason": "runtime_restarted",
                    "reason": reason,
                    "source": "startup_recovery"
                }
            }),
        )?;
        self.mark_agent_run_terminal(
            session_id,
            run_id,
            AgentRunStatus::Interrupted,
            "interrupted",
            Some("runtime_restarted".to_string()),
            None,
            Some(serde_json::json!({
                "code": "orphaned_run",
                "message": reason,
                "source": "startup_recovery"
            })),
        )
    }

    fn get_agent_run_record(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRecord>, WorkerProtocolError> {
        Ok(self
            .agent_run_records_for_session(session_id)?
            .into_iter()
            .find(|record| record.run_id == run_id))
    }

    fn agent_run_records_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentRunRecord>, WorkerProtocolError> {
        self.ensure_state_index()?;
        let Some(record) = self.find_live_record(session_id)? else {
            return Ok(Vec::new());
        };
        let path = PathBuf::from(record.thread_path);
        self.recorder.validate_thread_path(&path)?;
        let lines = read_thread_lines(&path)?;
        let mut runs = agent_run_records_from_lines(session_id, &lines);
        runs.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.run_id.cmp(&right.run_id))
        });
        Ok(runs)
    }

    fn ensure_agent_run_thread(
        &self,
        session_id: &str,
        timestamp: &str,
    ) -> Result<super::ThreadStateRecord, WorkerProtocolError> {
        self.ensure_state_index()?;
        if let Some(record) = self.state.find_by_session_or_thread_id(session_id)? {
            return Ok(record);
        }
        let thread_id = thread_id_for_session_id(session_id);
        let meta = super::ThreadMeta {
            schema_version: super::THREAD_LOG_SCHEMA_VERSION,
            thread_id: thread_id.clone(),
            session_id: Some(session_id.to_string()),
            created_at: timestamp.to_string(),
            cwd: String::new(),
            source: "desktop".to_string(),
            model_provider: None,
            model: None,
            base_instructions: None,
            history_mode: Some("default".to_string()),
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: Some("Tinybot Desktop".to_string()),
        };
        let path = self.recorder.create_thread(meta)?;
        let record = super::ThreadStateRecord {
            id: thread_id,
            session_id: Some(session_id.to_string()),
            thread_path: path.display().to_string(),
            created_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
            source: "desktop".to_string(),
            title: "New session".to_string(),
            preview: String::new(),
            cwd: String::new(),
            model_provider: None,
            model: None,
            tokens_used: 0,
            archived: false,
            archived_at: None,
        };
        self.state.upsert_thread(&record)?;
        Ok(record)
    }

    fn mark_agent_run_terminal(
        &self,
        session_id: &str,
        run_id: &str,
        status: AgentRunStatus,
        phase: &str,
        stop_reason: Option<String>,
        final_content: Option<String>,
        error: Option<Value>,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_agent_run_key(session_id, run_id)?;
        let mut record = self
            .get_agent_run_record(session_id, run_id)?
            .ok_or_else(|| unknown_agent_run_error(session_id, run_id))?;
        let timestamp = now_thread_timestamp();
        let mut state = self.ensure_agent_run_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            value_event(
                "agent_run_terminal",
                serde_json::json!({
                    "sessionId": session_id,
                    "runId": run_id,
                    "status": status,
                    "phase": phase,
                    "stopReason": stop_reason,
                    "finalContent": final_content,
                    "error": error,
                }),
            ),
        )?;
        apply_terminal_to_record(
            &mut record,
            status,
            phase,
            stop_reason,
            final_content,
            error,
            &timestamp,
        );
        state.updated_at = timestamp;
        state.preview = final_content_preview(&record).unwrap_or(state.preview);
        self.state.upsert_thread(&state)?;
        Ok(record)
    }
}

fn agent_run_status_is_resumable(status: &AgentRunStatus) -> bool {
    matches!(status, AgentRunStatus::Running | AgentRunStatus::Waiting)
}

fn agent_run_records_from_lines(
    session_id: &str,
    lines: &[super::ThreadLogLine],
) -> Vec<AgentRunRecord> {
    let mut runs: HashMap<String, AgentRunRecord> = HashMap::new();
    for line in lines {
        let super::ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        let payload = event.get("payload").unwrap_or(event);
        match event_type {
            "agent_run_upsert" => {
                if let Some(record) = payload
                    .get("record")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<AgentRunRecord>(value).ok())
                    .filter(|record| record.session_id == session_id)
                {
                    runs.entry(record.run_id.clone())
                        .and_modify(|existing| {
                            let started_at = existing.started_at.clone();
                            *existing = record.clone();
                            existing.started_at = started_at;
                        })
                        .or_insert(record);
                }
            }
            "agent_run_trace" => {
                let Some(run_id) = payload_run_id(payload) else {
                    continue;
                };
                let Some(event) = payload.get("event").cloned() else {
                    continue;
                };
                if let Some(record) = runs.get_mut(&run_id) {
                    upsert_trace_event(&mut record.trace_events, event.clone());
                    apply_agent_status_snapshot(record, &event);
                    record.updated_at = line.timestamp.clone();
                }
            }
            "agent_run_checkpoint_set" => {
                let Some(run_id) = payload_run_id(payload) else {
                    continue;
                };
                let Some(checkpoint) = payload.get("checkpoint").cloned() else {
                    continue;
                };
                let record = runs.entry(run_id.clone()).or_insert_with(|| {
                    agent_run_from_checkpoint(session_id, &run_id, &checkpoint, &line.timestamp)
                });
                apply_checkpoint_to_record(record, checkpoint, &line.timestamp);
            }
            "agent_run_checkpoint_clear" => {
                let Some(run_id) = payload_run_id(payload) else {
                    continue;
                };
                if let Some(record) = runs.get_mut(&run_id) {
                    record.checkpoint = None;
                    record.updated_at = line.timestamp.clone();
                }
            }
            "agent_run_terminal" => {
                let Some(run_id) = payload_run_id(payload) else {
                    continue;
                };
                if let Some(record) = runs.get_mut(&run_id) {
                    let status = match payload.get("status").and_then(Value::as_str) {
                        Some("completed") => AgentRunStatus::Completed,
                        Some("failed") => AgentRunStatus::Failed,
                        Some("cancelled") => AgentRunStatus::Cancelled,
                        Some("interrupted") => AgentRunStatus::Interrupted,
                        _ => record.status.clone(),
                    };
                    let phase = payload
                        .get("phase")
                        .and_then(Value::as_str)
                        .unwrap_or(record.phase.as_str())
                        .to_string();
                    let stop_reason = payload
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let final_content = payload
                        .get("finalContent")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let error = payload
                        .get("error")
                        .filter(|value| !value.is_null())
                        .cloned();
                    apply_terminal_to_record(
                        record,
                        status,
                        &phase,
                        stop_reason,
                        final_content,
                        error,
                        &line.timestamp,
                    );
                }
            }
            _ => {}
        }
    }
    runs.into_values().collect()
}

fn payload_run_id(payload: &Value) -> Option<String> {
    payload
        .get("runId")
        .or_else(|| payload.get("run_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn upsert_trace_event(events: &mut Vec<Value>, event: Value) {
    if let Some(event_id) = event.get("eventId").and_then(Value::as_str) {
        if let Some(existing) = events
            .iter_mut()
            .find(|existing| existing.get("eventId").and_then(Value::as_str) == Some(event_id))
        {
            *existing = event;
            return;
        }
    }
    events.push(event);
}

fn apply_checkpoint_to_record(record: &mut AgentRunRecord, checkpoint: Value, timestamp: &str) {
    record.phase = checkpoint
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or(record.phase.as_str())
        .to_string();
    record.status = agent_run_status_from_checkpoint(&checkpoint);
    record.updated_at = timestamp.to_string();
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
}

fn apply_terminal_to_record(
    record: &mut AgentRunRecord,
    status: AgentRunStatus,
    phase: &str,
    stop_reason: Option<String>,
    final_content: Option<String>,
    error: Option<Value>,
    timestamp: &str,
) {
    if let Some(final_content) = final_content.filter(|content| !content.trim().is_empty()) {
        record.trace_messages.push(serde_json::json!({
            "role": "assistant",
            "content": final_content,
        }));
    }
    record.status = status;
    record.phase = phase.to_string();
    record.stop_reason = stop_reason;
    record.completed_at = Some(timestamp.to_string());
    record.updated_at = timestamp.to_string();
    record.checkpoint = None;
    record.error = error;
}

fn final_content_preview(record: &AgentRunRecord) -> Option<String> {
    record.trace_messages.iter().rev().find_map(|message| {
        let role = message.get("role").and_then(Value::as_str)?;
        if role != "assistant" {
            return None;
        }
        let content = message.get("content").and_then(Value::as_str)?.trim();
        if content.is_empty() {
            None
        } else {
            Some(content.chars().take(160).collect())
        }
    })
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
        thread_id: checkpoint
            .get("threadId")
            .or_else(|| checkpoint.get("thread_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        turn_id: checkpoint
            .get("turnId")
            .or_else(|| checkpoint.get("turn_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        parent_thread_id: checkpoint
            .get("parentThreadId")
            .or_else(|| checkpoint.get("parent_thread_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        child_thread_ids: checkpoint
            .get("childThreadIds")
            .or_else(|| checkpoint.get("child_thread_ids"))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
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
        token_usage_info: None,
        instruction_provenance: None,
        instruction_diagnostics: Vec::new(),
        trace_context: checkpoint
            .get("traceContext")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
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
        Some("final_response") | Some("completed") | Some("done") | Some("terminal") => {
            AgentRunStatus::Completed
        }
        Some("cancelled") => AgentRunStatus::Cancelled,
        Some("interrupted") | Some("runtime_restarted") => AgentRunStatus::Interrupted,
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

fn apply_agent_status_snapshot(record: &mut AgentRunRecord, event: &Value) {
    if event.get("eventName").and_then(Value::as_str) != Some("agent.status") {
        return;
    }
    let payload = event.get("payload").unwrap_or(event);
    if let Some(phase) = payload
        .get("phase")
        .or_else(|| event.get("phase"))
        .and_then(Value::as_str)
    {
        record.phase = phase.to_string();
        record.status = agent_run_status_from_phase(phase);
    }
    if let Some(iteration) = payload
        .get("iteration")
        .or_else(|| event.get("iteration"))
        .and_then(Value::as_i64)
    {
        record.current_iteration = iteration;
    }
}

fn agent_run_status_from_phase(phase: &str) -> AgentRunStatus {
    match phase {
        "awaiting_approval" | "awaiting_form" | "awaiting_subagent" | "queued" => {
            AgentRunStatus::Waiting
        }
        "interrupted" => AgentRunStatus::Interrupted,
        _ => AgentRunStatus::Running,
    }
}

fn runtime_event_from_trace_value(
    record: &AgentRunRecord,
    index: usize,
    event: &Value,
) -> Option<AgentRuntimeEventEnvelope> {
    if let Ok(envelope) = serde_json::from_value::<AgentRuntimeEventEnvelope>(event.clone()) {
        return Some(envelope);
    }
    let event_name = event.get("eventName").and_then(Value::as_str)?.to_string();
    let payload = event
        .get("payload")
        .cloned()
        .unwrap_or_else(|| event.clone());
    let sequence = event
        .get("sequence")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| index as u64 + 1);
    Some(AgentRuntimeEventEnvelope::from_legacy_native_event(
        LegacyNativeAgentEventEnvelopeInput {
            session_id: record.session_id.clone(),
            thread_id: record.thread_id.clone(),
            turn_id: record.run_id.clone(),
            parent_turn_id: event
                .get("parentTurnId")
                .and_then(Value::as_str)
                .map(str::to_string),
            item_id: event
                .get("itemId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| legacy_trace_item_id(&event_name, &payload)),
            event_name,
            sequence,
            timestamp: event
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| record.updated_at.clone()),
            payload,
        },
    ))
}

fn legacy_trace_item_id(event_name: &str, payload: &Value) -> Option<String> {
    match event_name {
        "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" => {
            string_from_trace_payload(payload, &["toolCallId", "tool_call_id"])
        }
        "agent.awaiting_approval" | "agent.approval.decision" => {
            string_from_trace_payload(payload, &["approvalId", "approval_id"])
        }
        "agent.awaiting_form" | "agent.form.resolution" => {
            string_from_trace_payload(payload, &["formId", "form_id"])
        }
        event_name if event_name.starts_with("agent.delegate.") => {
            string_from_trace_payload(payload, &["delegateId", "subagentId", "delegate_id"])
        }
        _ => None,
    }
}

fn string_from_trace_payload(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn parse_trace_cursor(cursor: Option<&str>) -> Result<usize, WorkerProtocolError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor.parse::<usize>().map_err(|_| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid agent run trace cursor",
            serde_json::json!({ "cursor": cursor }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })
}

fn validate_agent_run_key(session_id: &str, run_id: &str) -> Result<(), WorkerProtocolError> {
    validate_path_safe_id(session_id, "session_id")?;
    validate_path_safe_id(run_id, "run_id")
}

fn validate_path_safe_id(value: &str, field: &str) -> Result<(), WorkerProtocolError> {
    if value.trim().is_empty() || value.contains('\0') || value.contains("..") {
        return Err(invalid_agent_run_key(field, value));
    }
    Ok(())
}

fn invalid_agent_run_key(field: &str, value: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "invalid agent run key",
        serde_json::json!({ field: value }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
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

fn empty_agent_run_trace_batch_error(session_id: &str, run_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "agent run trace batch must contain at least one event",
        serde_json::json!({
            "session_id": session_id,
            "run_id": run_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_log_serialization_error(error: serde_json::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread log agent run serialization error: {error}"),
        serde_json::json!({ "method": "agent_run" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
