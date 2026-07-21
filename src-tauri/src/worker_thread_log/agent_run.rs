use super::{
    is_default_session_title, now_thread_timestamp, preview_from_messages, read_thread_lines,
    thread_id_for_session_id, title_from_messages, value_event, AgentRunRecoveryEntry,
    AgentRunRecoveryReport, ThreadLogItem, WorkerThreadLogRpc,
};
use crate::worker_capability::WorkerCapability;
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_session::{
    AgentRunCheckpoint, AgentRunRecord, AgentRunRuntimeState, AgentRunStatus, AgentRunTracePage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAgentRunSeed {
    session_id: String,
    run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    child_thread_ids: Vec<String>,
    started_at: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    max_iterations: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instruction_provenance: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    instruction_diagnostics: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trace_context: Option<crate::agent_loop_runtime_protocol::AgentTraceContext>,
}

impl PersistedAgentRunSeed {
    fn from_record(record: &AgentRunRecord) -> Self {
        Self {
            session_id: record.session_id.clone(),
            run_id: record.run_id.clone(),
            thread_id: record.thread_id.clone(),
            turn_id: record.turn_id.clone(),
            parent_thread_id: record.parent_thread_id.clone(),
            child_thread_ids: record.child_thread_ids.clone(),
            started_at: record.started_at.clone(),
            model: record.model.clone(),
            provider: record.provider.clone(),
            max_iterations: record.max_iterations,
            instruction_provenance: record.instruction_provenance.clone(),
            instruction_diagnostics: record.instruction_diagnostics.clone(),
            trace_context: record.trace_context.clone(),
        }
    }

    fn into_record(self) -> AgentRunRecord {
        AgentRunRecord {
            session_id: self.session_id,
            run_id: self.run_id,
            thread_id: self.thread_id,
            turn_id: self.turn_id,
            parent_thread_id: self.parent_thread_id,
            child_thread_ids: self.child_thread_ids,
            status: AgentRunStatus::Running,
            phase: "planning".to_string(),
            started_at: self.started_at.clone(),
            updated_at: self.started_at,
            completed_at: None,
            stop_reason: None,
            model: self.model,
            provider: self.provider,
            max_iterations: self.max_iterations,
            current_iteration: 0,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            trace_events: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: self.instruction_provenance,
            instruction_diagnostics: self.instruction_diagnostics,
            trace_context: self.trace_context,
            error: None,
        }
    }

    fn apply_metadata_to(self, record: &mut AgentRunRecord) {
        record.thread_id = self.thread_id;
        record.turn_id = self.turn_id;
        record.parent_thread_id = self.parent_thread_id;
        record.child_thread_ids = self.child_thread_ids;
        record.model = self.model;
        record.provider = self.provider;
        record.max_iterations = self.max_iterations;
        record.instruction_provenance = self.instruction_provenance;
        record.instruction_diagnostics = self.instruction_diagnostics;
        record.trace_context = self.trace_context;
    }
}

impl WorkerThreadLogRpc {
    pub fn upsert_agent_run(
        &self,
        record: AgentRunRecord,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        let timestamp = now_thread_timestamp();
        self.upsert_agent_run_at(record, timestamp)
    }

    fn upsert_agent_run_at(
        &self,
        record: AgentRunRecord,
        timestamp: String,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_agent_run_key(&record.session_id, &record.run_id)?;
        if !record.trace_events.is_empty() {
            return Err(embedded_agent_run_trace_error(
                &record.session_id,
                &record.run_id,
            ));
        }
        let existing = self.get_agent_run_record(&record.session_id, &record.run_id)?;
        let mut persisted_record = record.clone();
        if let Some(existing) = existing {
            persisted_record.started_at = existing.started_at;
        }
        let mut state = self.ensure_agent_run_thread(&record.session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let items = vec![value_event(
            super::EventKind::AgentRunUpsert,
            serde_json::json!({
                "record": PersistedAgentRunSeed::from_record(&persisted_record)
            }),
        )];
        self.recorder
            .append_items(&path, timestamp.clone(), items)?;
        let log_head = self.recorder.thread_log_head(&path)?;
        state.updated_at = timestamp;
        if !record.model.trim().is_empty() {
            state.model = Some(record.model.clone());
        }
        state.model_provider = record.provider.clone();
        self.state.upsert_thread_projection(&state, &log_head)?;
        Ok(persisted_record)
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
        for (index, event) in events.iter().enumerate() {
            validate_agent_run_trace_event(session_id, run_id, index, event)?;
        }
        let mut record = self
            .get_agent_run_record(session_id, run_id)?
            .ok_or_else(|| unknown_agent_run_error(session_id, run_id))?;
        let timestamp = now_thread_timestamp();
        let mut state = self.ensure_agent_run_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let latest_total_tokens = events.iter().rev().find_map(|event| {
            if event.get("eventName").and_then(Value::as_str) != Some("agent.token_count") {
                return None;
            }
            event
                .get("payload")
                .and_then(|payload| payload.get("info"))
                .and_then(|info| {
                    info.get("totalTokenUsage")
                        .or_else(|| info.get("total_token_usage"))
                })
                .and_then(|total| {
                    total
                        .get("totalTokens")
                        .or_else(|| total.get("total_tokens"))
                })
                .and_then(Value::as_i64)
        });
        let has_response_items = events.iter().any(|event| {
            event
                .get("eventName")
                .and_then(Value::as_str)
                .is_some_and(agent_run_trace_event_is_response_backed)
        });
        let mut items = Vec::new();
        let mut persisted_events = Vec::with_capacity(events.len());
        for event in events.iter().cloned() {
            let response_item = response_item_from_runtime_event(&event)
                .map(|mut item| {
                    item["runId"] = Value::String(run_id.to_string());
                    item["turnId"] = Value::String(
                        event
                            .get("turnId")
                            .and_then(Value::as_str)
                            .unwrap_or(run_id)
                            .to_string(),
                    );
                    item["threadItemPayload"] = event.clone();
                    item
                })
                .map(|item| super::typed_response_item(item, "agent run trace"))
                .transpose()?;
            let token_info = (event.get("eventName").and_then(Value::as_str)
                == Some("agent.token_count"))
            .then(|| {
                event
                    .get("payload")
                    .and_then(|payload| payload.get("info"))
                    .cloned()
            })
            .flatten();
            let persisted_event = crate::worker_rollout::bound_persisted_trace_value(event.clone());
            items.push(value_event(
                super::EventKind::AgentRunTrace,
                serde_json::json!({
                    "sessionId": session_id,
                    "runId": run_id,
                    "event": persisted_event.clone(),
                }),
            ));
            if let Some(info) = token_info {
                items.push(value_event(
                    super::EventKind::TokenCount,
                    serde_json::json!({ "info": info }),
                ));
            }
            if let Some(response_item) = response_item {
                items.push(ThreadLogItem::ResponseItem(response_item));
            }
            persisted_events.push(persisted_event);
        }
        self.recorder
            .append_items(&path, timestamp.clone(), items)?;
        let log_head = self.recorder.thread_log_head(&path)?;
        for event in persisted_events {
            upsert_trace_event(&mut record.trace_events, event.clone());
            apply_agent_status_snapshot(&mut record, &event);
        }
        record.updated_at = timestamp.clone();
        if let Some(total_tokens) = latest_total_tokens {
            state.tokens_used = total_tokens;
            state.updated_at = timestamp.clone();
        }
        if has_response_items {
            let replay =
                super::reconstruction::reconstruct_canonical_rollout(&read_thread_lines(&path)?)?
                    .semantic;
            if is_default_session_title(&state.title) {
                if let Some(title) = title_from_messages(&replay.messages) {
                    state.title = title;
                }
            }
            state.preview = preview_from_messages(&replay.messages);
            state.updated_at = timestamp;
        }
        self.state.upsert_thread_projection(&state, &log_head)?;
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
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_agent_run_key(session_id, run_id)?;
        self.ensure_state_index()?;
        let mut selected = None;
        for state_record in self.state.list_threads()?.into_iter().filter(|record| {
            !record.archived
                && (record.id == session_id || record.session_id.as_deref() == Some(session_id))
        }) {
            let path = PathBuf::from(state_record.thread_path);
            self.recorder.validate_thread_path(&path)?;
            let reconstructed =
                super::reconstruction::reconstruct_canonical_rollout(&read_thread_lines(&path)?)?;
            let Some(record) = reconstructed
                .agent_runs
                .iter()
                .find(|record| record.run_id == run_id)
                .cloned()
            else {
                continue;
            };
            if selected
                .as_ref()
                .is_none_or(|(current, _): &(AgentRunRecord, Vec<_>)| {
                    record.updated_at > current.updated_at
                })
            {
                selected = Some((record, reconstructed.thread_items));
            }
        }
        let Some((_, thread_items)) = selected else {
            return Ok(None);
        };
        let runtime_events = crate::worker_thread::runtime_events_from_thread_items(
            &thread_items,
            session_id,
            run_id,
        );
        let runtime_state =
            AgentRunRuntimeState::from_runtime_events(session_id, run_id, runtime_events.clone())
                .map_err(|error| {
                    let diagnostics = runtime_events
                        .iter()
                        .map(|event| {
                            serde_json::json!({
                                "eventId": event.event_id,
                                "eventName": event.event_name,
                                "itemId": event.item_id,
                                "sequence": event.sequence,
                            })
                        })
                        .collect::<Vec<_>>();
                    eprintln!(
                        "agent_run_runtime_state_projection_failed session_id={} run_id={} error={} details={} events={}",
                        session_id,
                        run_id,
                        error.message,
                        error.details,
                        Value::Array(diagnostics),
                    );
                    error
                })?;
        Ok(Some(runtime_state))
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
                super::EventKind::AgentRunCheckpointSet,
                serde_json::json!({
                    "sessionId": session_id,
                    "runId": run_id,
                    "checkpoint": checkpoint,
                }),
            ),
        )?;
        let log_head = self.recorder.thread_log_head(&path)?;
        apply_checkpoint_to_record(&mut record, checkpoint, &timestamp);
        state.updated_at = timestamp;
        self.state.upsert_thread_projection(&state, &log_head)?;
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
                super::EventKind::AgentRunCheckpointClear,
                serde_json::json!({ "sessionId": session_id, "runId": run_id }),
            ),
        )?;
        let log_head = self.recorder.thread_log_head(&path)?;
        record.checkpoint = None;
        record.updated_at = timestamp.clone();
        state.updated_at = timestamp;
        self.state.upsert_thread_projection(&state, &log_head)?;
        Ok(record)
    }

    pub fn mark_agent_run_completed(
        &self,
        session_id: &str,
        run_id: &str,
        stop_reason: &str,
        final_content: Option<String>,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
        self.mark_agent_run_terminal(
            session_id,
            run_id,
            AgentRunStatus::Completed,
            "completed",
            Some(stop_reason.to_string()),
            final_content,
            None,
        )
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
        self.mark_agent_run_interrupted_terminal(session_id, run_id, reason)
    }

    pub fn mark_agent_run_interrupted_terminal(
        &self,
        session_id: &str,
        run_id: &str,
        reason: &str,
    ) -> Result<AgentRunRecord, WorkerProtocolError> {
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
        let mut runs_by_id = HashMap::<String, AgentRunRecord>::new();
        for record in self.state.list_threads()?.into_iter().filter(|record| {
            !record.archived
                && (record.id == session_id || record.session_id.as_deref() == Some(session_id))
        }) {
            let path = PathBuf::from(record.thread_path);
            self.recorder.validate_thread_path(&path)?;
            let lines = read_thread_lines(&path)?;
            let reconstructed = super::reconstruction::reconstruct_canonical_rollout(&lines)?;
            for run in reconstructed.agent_runs {
                match runs_by_id.entry(run.run_id.clone()) {
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(run);
                    }
                    std::collections::hash_map::Entry::Occupied(mut entry)
                        if run.updated_at > entry.get().updated_at =>
                    {
                        entry.insert(run);
                    }
                    std::collections::hash_map::Entry::Occupied(_) => {}
                }
            }
        }
        let mut runs = runs_by_id.into_values().collect::<Vec<_>>();
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
        let log_head = self.recorder.thread_log_head(&path)?;
        self.state.upsert_thread_projection(&record, &log_head)?;
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
        let mut items = vec![value_event(
            super::EventKind::AgentRunTerminal,
            serde_json::json!({
                "sessionId": session_id,
                "runId": run_id,
                "status": status,
                "phase": phase,
                "stopReason": stop_reason,
                "finalContent": final_content,
                "error": error,
            }),
        )];
        if status == AgentRunStatus::Interrupted {
            items.push(value_event(
                super::EventKind::TurnAborted,
                serde_json::json!({
                    "sessionId": session_id,
                    "runId": run_id,
                    "turnId": record.turn_id,
                    "status": status,
                    "phase": phase,
                    "stopReason": stop_reason,
                    "error": error,
                }),
            ));
        }
        self.recorder
            .append_items(&path, timestamp.clone(), items)?;
        let log_head = self.recorder.thread_log_head(&path)?;
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
        self.state.upsert_thread_projection(&state, &log_head)?;
        Ok(record)
    }
}

fn response_item_from_runtime_event(event: &Value) -> Option<Value> {
    let payload = event.get("payload")?;
    match event.get("eventName").and_then(Value::as_str)? {
        "agent.turn.started" => {
            let mut message = payload.get("userMessage")?.clone();
            let content = message.get("content").cloned().unwrap_or(Value::Null);
            message["type"] = Value::String("message".to_string());
            message["role"] = Value::String("user".to_string());
            message["content"] = canonical_message_content(content, "input_text");
            if message.get("id").is_none() {
                message["id"] = message
                    .get("messageId")
                    .or_else(|| message.get("message_id"))
                    .or_else(|| payload.get("userMessageId"))
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            if message.get("messageId").is_none() {
                message["messageId"] = message.get("id").cloned().unwrap_or(Value::Null);
            }
            Some(message)
        }
        "agent.message.completed" => {
            let content = payload.get("content")?.as_str()?;
            let message_id = payload.get("messageId").cloned().unwrap_or(Value::Null);
            Some(serde_json::json!({
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": canonical_message_content(Value::String(content.to_string()), "output_text"),
                "messageId": message_id,
                "phase": payload
                    .get("messagePhase")
                    .cloned()
                    .unwrap_or_else(|| Value::String("final_answer".to_string())),
            }))
        }
        "agent.message.classified" => {
            let message_id = payload.get("messageId").cloned().unwrap_or(Value::Null);
            Some(serde_json::json!({
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": canonical_message_content(
                    payload.get("content").cloned().unwrap_or(Value::Null),
                    "output_text",
                ),
                "messageId": message_id,
                "phase": payload
                    .get("messagePhase")
                    .cloned()
                    .unwrap_or_else(|| Value::String("commentary".to_string())),
            }))
        }
        "agent.reasoning.completed" => {
            let summary = payload.get("summary")?.as_str()?;
            Some(serde_json::json!({
                "type": "reasoning",
                "id": payload
                    .get("reasoningId")
                    .cloned()
                    .unwrap_or_else(|| payload.get("modelCallId").cloned().unwrap_or(Value::Null)),
                "summary": [{
                    "type": "summary_text",
                    "text": summary,
                }],
                "content": null,
                "encrypted_content": null,
                "modelCallId": payload.get("modelCallId").cloned().unwrap_or(Value::Null),
                "reasoningId": payload.get("reasoningId").cloned().unwrap_or(Value::Null),
            }))
        }
        "agent.tool_call.delta" => Some(serde_json::json!({
            "type": "custom_tool_call",
            "id": payload.get("toolCallId")?.clone(),
            "call_id": payload.get("toolCallId")?.clone(),
            "name": payload
                .get("toolName")
                .or_else(|| payload.get("name"))?
                .clone(),
            "input": payload
                .get("argumentsDelta")
                .cloned()
                .unwrap_or_else(|| serde_json::json!("{}")),
        })),
        "agent.tool.result" => Some(serde_json::json!({
            "type": "custom_tool_call_output",
            "call_id": payload.get("toolCallId")?.clone(),
            "output": payload.get("content").cloned().unwrap_or(Value::Null),
        })),
        _ => None,
    }
}

fn canonical_message_content(content: Value, part_type: &str) -> Value {
    match content {
        Value::Array(_) => content,
        Value::String(text) => serde_json::json!([{
            "type": part_type,
            "text": text,
        }]),
        Value::Null => Value::Array(Vec::new()),
        value => serde_json::json!([{
            "type": part_type,
            "text": value.to_string(),
        }]),
    }
}

fn agent_run_trace_event_is_response_backed(event_name: &str) -> bool {
    matches!(
        event_name,
        "agent.turn.started"
            | "agent.reasoning.completed"
            | "agent.message.classified"
            | "agent.message.completed"
            | "agent.tool_call.delta"
            | "agent.tool.result"
    )
}

fn validate_agent_run_trace_event(
    session_id: &str,
    run_id: &str,
    index: usize,
    event: &Value,
) -> Result<(), WorkerProtocolError> {
    let event_name = event
        .get("eventName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_agent_run_trace_event_error(
                "agent run trace event is missing eventName",
                session_id,
                run_id,
                index,
                None,
            )
        })?;
    event
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_agent_run_trace_event_error(
                "agent run trace event is missing eventId",
                session_id,
                run_id,
                index,
                Some(event_name),
            )
        })?;
    if !agent_run_trace_event_is_response_backed(event_name) {
        return Ok(());
    }
    let materializes_response = response_item_from_runtime_event(event).is_some();
    if !materializes_response {
        return Err(invalid_agent_run_trace_event_error(
            "response-backed agent run trace event cannot be materialized",
            session_id,
            run_id,
            index,
            Some(event_name),
        ));
    }
    Ok(())
}

fn agent_run_status_is_resumable(status: &AgentRunStatus) -> bool {
    matches!(status, AgentRunStatus::Running | AgentRunStatus::Waiting)
}

pub(super) fn agent_run_records_from_lines(
    session_id: &str,
    thread_id: &str,
    lines: &[super::ThreadLogLine],
) -> Result<Vec<AgentRunRecord>, WorkerProtocolError> {
    let mut runs: HashMap<String, AgentRunRecord> = HashMap::new();
    for line in lines {
        if let super::ThreadLogItem::ResponseItem(item) = &line.item {
            apply_response_item_to_agent_runs(&mut runs, item.as_value(), line)?;
            continue;
        }
        let super::ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        let payload = event.payload();
        match event.kind() {
            super::EventKind::AgentRunUpsert => {
                let record_value = payload.get("record").cloned().ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_upsert event is missing its record",
                        line,
                        payload,
                    )
                })?;
                let seed = serde_json::from_value::<PersistedAgentRunSeed>(record_value).map_err(
                    |error| {
                        agent_run_replay_error(
                            "agent_run_upsert event contains an invalid record",
                            line,
                            &serde_json::json!({
                                "payload": payload,
                                "error": error.to_string(),
                            }),
                        )
                    },
                )?;
                let belongs_to_session = seed.session_id == session_id;
                let belongs_to_thread = seed.session_id == thread_id;
                if !belongs_to_session && !belongs_to_thread {
                    return Err(agent_run_replay_error(
                        "agent_run_upsert record belongs to a different session",
                        line,
                        &serde_json::json!({
                            "expectedSessionId": session_id,
                            "expectedThreadId": thread_id,
                            "actualSessionId": seed.session_id,
                            "runId": seed.run_id,
                        }),
                    ));
                }
                match runs.entry(seed.run_id.clone()) {
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        seed.apply_metadata_to(entry.get_mut());
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(seed.into_record());
                    }
                }
            }
            super::EventKind::AgentRunTrace => {
                let run_id = payload_run_id(payload).ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_trace event is missing its run id",
                        line,
                        payload,
                    )
                })?;
                let event = payload.get("event").cloned().ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_trace event is missing its event payload",
                        line,
                        payload,
                    )
                })?;
                let record = runs.get_mut(&run_id).ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_trace event references an unknown run",
                        line,
                        payload,
                    )
                })?;
                upsert_trace_event(&mut record.trace_events, event.clone());
                apply_agent_status_snapshot(record, &event);
                record.updated_at = line.timestamp.clone();
            }
            super::EventKind::AgentRunCheckpointSet => {
                let run_id = payload_run_id(payload).ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_checkpoint_set event is missing its run id",
                        line,
                        payload,
                    )
                })?;
                let checkpoint = payload.get("checkpoint").cloned().ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_checkpoint_set event is missing its checkpoint",
                        line,
                        payload,
                    )
                })?;
                let record = runs.entry(run_id.clone()).or_insert_with(|| {
                    agent_run_from_checkpoint(session_id, &run_id, &checkpoint, &line.timestamp)
                });
                apply_checkpoint_to_record(record, checkpoint, &line.timestamp);
            }
            super::EventKind::AgentRunCheckpointClear => {
                let run_id = payload_run_id(payload).ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_checkpoint_clear event is missing its run id",
                        line,
                        payload,
                    )
                })?;
                let record = runs.get_mut(&run_id).ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_checkpoint_clear event references an unknown run",
                        line,
                        payload,
                    )
                })?;
                record.checkpoint = None;
                record.updated_at = line.timestamp.clone();
            }
            super::EventKind::AgentRunTerminal => {
                let run_id = payload_run_id(payload).ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_terminal event is missing its run id",
                        line,
                        payload,
                    )
                })?;
                let record = runs.get_mut(&run_id).ok_or_else(|| {
                    agent_run_replay_error(
                        "agent_run_terminal event references an unknown run",
                        line,
                        payload,
                    )
                })?;
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
            super::EventKind::SessionCleared => {
                for record in runs.values_mut() {
                    record.checkpoint = None;
                    record.updated_at = line.timestamp.clone();
                }
            }
            super::EventKind::TurnStarted
            | super::EventKind::TaskStarted
            | super::EventKind::TurnComplete
            | super::EventKind::TaskComplete
            | super::EventKind::TurnAborted
            | super::EventKind::UserMessage
            | super::EventKind::ThreadRolledBack
            | super::EventKind::TokenCount
            | super::EventKind::MetadataUpdated
            | super::EventKind::SessionTrimmed
            | super::EventKind::TaskProgressUpdated
            | super::EventKind::ThreadItem
            | super::EventKind::Legacy(_) => {}
        }
    }
    Ok(runs.into_values().collect())
}

fn apply_response_item_to_agent_runs(
    runs: &mut HashMap<String, AgentRunRecord>,
    item: &Value,
    _line: &super::ThreadLogLine,
) -> Result<(), WorkerProtocolError> {
    let Some(run_id) = item
        .get("runId")
        .or_else(|| item.get("run_id"))
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    let Some(record) = runs.get_mut(run_id) else {
        return Ok(());
    };
    if item.get("type").and_then(Value::as_str) == Some("custom_tool_call_output") {
        let completed_result = completed_tool_result_from_response_item(item);
        let call_id = completed_result
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(index) = record.completed_tool_results.iter().position(|candidate| {
            candidate.get("toolCallId").and_then(Value::as_str) == Some(call_id)
        }) {
            record.completed_tool_results[index] = completed_result;
        } else {
            record.completed_tool_results.push(completed_result);
        }
        return Ok(());
    }
    if item.get("type").and_then(Value::as_str) != Some("message")
        || item.get("role").and_then(Value::as_str) != Some("assistant")
    {
        return Ok(());
    }
    let content = response_message_text(item);
    let message_id = item
        .get("id")
        .or_else(|| item.get("messageId"))
        .or_else(|| item.get("message_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut message = serde_json::json!({
        "role": "assistant",
        "content": content,
    });
    if let Some(message_id) = message_id.as_ref() {
        message["messageId"] = Value::String(message_id.clone());
    }
    if let Some(index) = message_id.as_ref().and_then(|message_id| {
        record.trace_messages.iter().position(|candidate| {
            candidate
                .get("messageId")
                .and_then(Value::as_str)
                .is_some_and(|candidate_id| candidate_id == message_id)
        })
    }) {
        record.trace_messages[index] = message;
    } else {
        record.trace_messages.push(message);
    }
    Ok(())
}

fn completed_tool_result_from_response_item(item: &Value) -> Value {
    let payload = item
        .get("threadItemPayload")
        .or_else(|| item.get("thread_item_payload"))
        .and_then(|event| event.get("payload"))
        .unwrap_or(&Value::Null);
    let envelope = payload.get("envelope").cloned().unwrap_or(Value::Null);
    let status = envelope
        .get("status")
        .or_else(|| payload.get("resultStatus"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!("ok"));
    let summary = envelope
        .get("summary")
        .or_else(|| payload.get("summary"))
        .or_else(|| item.get("output"))
        .cloned()
        .unwrap_or(Value::Null);
    crate::worker_rollout::bound_persisted_trace_value(serde_json::json!({
        "toolCallId": payload
            .get("toolCallId")
            .or_else(|| payload.get("tool_call_id"))
            .or_else(|| item.get("call_id"))
            .cloned()
            .unwrap_or(Value::Null),
        "toolName": payload
            .get("toolName")
            .or_else(|| payload.get("tool_name"))
            .or_else(|| payload.get("name"))
            .cloned()
            .unwrap_or(Value::Null),
        "status": status,
        "summary": summary,
        "envelope": envelope,
    }))
}

fn response_message_text(item: &Value) -> String {
    match item.get("content") {
        Some(Value::String(content)) => content.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(Value::as_str))
            })
            .collect(),
        Some(Value::Null) | None => String::new(),
        Some(content) => content.to_string(),
    }
}

fn agent_run_replay_error(
    message: &str,
    line: &super::ThreadLogLine,
    detail: &Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({
            "method": "rollout.reconstruct.agent_runs",
            "timestamp": line.timestamp,
            "ordinal": line.ordinal,
            "detail": detail,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
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
    _final_content: Option<String>,
    error: Option<Value>,
    timestamp: &str,
) {
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
        "awaiting_approval" | "awaiting_form" | "awaiting_subagent" | "paused" | "queued" => {
            AgentRunStatus::Waiting
        }
        "interrupted" => AgentRunStatus::Interrupted,
        _ => AgentRunStatus::Running,
    }
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

fn embedded_agent_run_trace_error(session_id: &str, run_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "agent_run.upsert must not embed trace events; use agent_run.append_trace",
        serde_json::json!({
            "session_id": session_id,
            "run_id": run_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn invalid_agent_run_trace_event_error(
    message: &str,
    session_id: &str,
    run_id: &str,
    index: usize,
    event_name: Option<&str>,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({
            "session_id": session_id,
            "run_id": run_id,
            "event_index": index,
            "event_name": event_name,
        }),
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

#[cfg(test)]
mod tests {
    use super::response_item_from_runtime_event;
    use serde_json::json;

    #[test]
    fn runtime_tool_events_materialize_a_complete_model_visible_pair() {
        let call = response_item_from_runtime_event(&json!({
            "eventName": "agent.tool_call.delta",
            "payload": {
                "toolCallId": "call-1",
                "toolName": "workspace.read_file",
                "argumentsDelta": "{\"path\":\"README.md\"}"
            }
        }))
        .unwrap();
        let result = response_item_from_runtime_event(&json!({
            "eventName": "agent.tool.result",
            "payload": {
                "toolCallId": "call-1",
                "toolName": "workspace.read_file",
                "content": "contents"
            }
        }))
        .unwrap();

        assert_eq!(call["type"], "custom_tool_call");
        assert_eq!(call["call_id"], "call-1");
        assert_eq!(call["input"], "{\"path\":\"README.md\"}");
        assert_eq!(result["type"], "custom_tool_call_output");
        assert_eq!(result["call_id"], "call-1");
        assert_eq!(result["output"], "contents");
    }
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
