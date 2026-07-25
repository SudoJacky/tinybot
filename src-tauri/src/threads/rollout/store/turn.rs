use super::{
    is_default_thread_title, now_thread_timestamp, preview_from_messages, read_thread_lines,
    thread_id_for_session_id, title_from_messages, value_event, AgentTurnRecoveryEntry,
    AgentTurnRecoveryReport, ThreadLogItem, WorkerThreadLogRpc,
};
use crate::protocol::capability::WorkerCapability;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::threads::turn::{
    AgentTurnCheckpoint, AgentTurnRecord, AgentTurnRuntimeState, AgentTurnStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAgentTurnSeed {
    session_id: String,
    turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
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
    trace_context: Option<crate::agent::runtime_protocol::AgentTraceContext>,
}

impl PersistedAgentTurnSeed {
    fn from_record(record: &AgentTurnRecord) -> Self {
        Self {
            session_id: record.session_id.clone(),
            turn_id: record.turn_id.clone(),
            thread_id: record.thread_id.clone(),
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

    fn into_record(self) -> AgentTurnRecord {
        AgentTurnRecord {
            session_id: self.session_id,
            turn_id: self.turn_id,
            thread_id: self.thread_id,
            parent_thread_id: self.parent_thread_id,
            child_thread_ids: self.child_thread_ids,
            status: AgentTurnStatus::Running,
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

    fn apply_metadata_to(self, record: &mut AgentTurnRecord) {
        record.thread_id = self.thread_id;
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
    pub fn start_turn(
        &self,
        record: AgentTurnRecord,
        context: Option<crate::threads::rollout::format::TurnContextItem>,
        messages: Vec<crate::threads::rollout::format::ResponseItem>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        let timestamp = now_thread_timestamp();
        self.start_turn_at(record, context, messages, timestamp)
    }

    fn start_turn_at(
        &self,
        record: AgentTurnRecord,
        context: Option<crate::threads::rollout::format::TurnContextItem>,
        messages: Vec<crate::threads::rollout::format::ResponseItem>,
        timestamp: String,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_turn_key(&record.session_id, &record.turn_id)?;
        let existing = self.get_turn_record(&record.session_id, &record.turn_id)?;
        let mut persisted_record = record.clone();
        if let Some(existing) = existing {
            persisted_record.started_at = existing.started_at;
        }
        let mut state = self.ensure_turn_thread(&record.session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let mut items = vec![value_event(
            super::EventKind::TurnStarted,
            serde_json::json!({
                "sessionId": &record.session_id,
                "turnId": &record.turn_id,
                "turn": PersistedAgentTurnSeed::from_record(&persisted_record)
            }),
        )];
        if let Some(context) = context {
            items.push(ThreadLogItem::TurnContext(context));
        }
        let existing_lines = read_thread_lines(&path)?;
        for message in messages {
            let content_hash = message
                .get("contentHash")
                .or_else(|| message.get("content_hash"))
                .and_then(Value::as_str);
            let message_id = message
                .get("id")
                .or_else(|| message.get("messageId"))
                .and_then(Value::as_str);
            let already_persisted = existing_lines.iter().any(|line| match &line.item {
                ThreadLogItem::ResponseItem(existing) => {
                    existing.role() == message.role()
                        && (content_hash.is_some_and(|content_hash| {
                            existing
                                .get("contentHash")
                                .or_else(|| existing.get("content_hash"))
                                .and_then(Value::as_str)
                                == Some(content_hash)
                        }) || message_id.is_some_and(|message_id| {
                            existing
                                .get("id")
                                .or_else(|| existing.get("messageId"))
                                .and_then(Value::as_str)
                                == Some(message_id)
                        }))
                }
                _ => false,
            });
            if !already_persisted {
                items.push(ThreadLogItem::ResponseItem(message));
            }
        }
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

    pub fn append_turn_semantic_event(
        &self,
        session_id: &str,
        turn_id: &str,
        event: Value,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.append_turn_semantic_events(session_id, turn_id, vec![event])
    }

    pub fn append_turn_semantic_events(
        &self,
        session_id: &str,
        turn_id: &str,
        events: Vec<Value>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_turn_key(session_id, turn_id)?;
        if events.is_empty() {
            return Err(empty_turn_semantic_batch_error(session_id, turn_id));
        }
        for (index, event) in events.iter().enumerate() {
            validate_turn_semantic_event(session_id, turn_id, index, event)?;
        }
        let mut record = self
            .get_turn_record(session_id, turn_id)?
            .ok_or_else(|| unknown_turn_error(session_id, turn_id))?;
        let timestamp = now_thread_timestamp();
        let mut state = self.ensure_turn_thread(session_id, &timestamp)?;
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
                .is_some_and(|event_name| response_item_from_runtime_event_name(event_name))
        });
        let mut items = Vec::new();
        for event in events.iter().cloned() {
            let response_item = response_item_from_runtime_event(&event)
                .map(|mut item| {
                    item["turnId"] = Value::String(
                        event
                            .get("turnId")
                            .and_then(Value::as_str)
                            .unwrap_or(turn_id)
                            .to_string(),
                    );
                    item
                })
                .map(|item| super::typed_response_item(item, "agent turn semantic event"))
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
            if let Some(info) = token_info {
                let usage = canonical_provider_call_usage(&info).ok_or_else(|| {
                    invalid_turn_semantic_event_error(
                        "agent.token_count is missing lastTokenUsage",
                        session_id,
                        turn_id,
                        0,
                        Some("agent.token_count"),
                    )
                })?;
                items.push(value_event(
                    super::EventKind::TokenCount,
                    serde_json::json!({
                        "turnId": event.get("turnId").cloned().unwrap_or_else(|| Value::String(turn_id.to_string())),
                        "providerCallId": event
                            .get("payload")
                            .and_then(|payload| payload.get("modelCallId").or_else(|| payload.get("providerCallId")))
                            .cloned()
                            .unwrap_or(Value::Null),
                        "info": usage,
                    }),
                ));
            }
            if let Some(response_item) = response_item {
                items.push(ThreadLogItem::ResponseItem(response_item));
            }
            if let Some(thread_item) =
                semantic_thread_item_from_runtime_event(session_id, turn_id, &timestamp, &event)
            {
                items.push(value_event(
                    super::EventKind::ThreadItem,
                    serde_json::json!({ "item": thread_item }),
                ));
            }
        }
        if items.is_empty() {
            return Err(invalid_turn_semantic_event_error(
                "agent turn semantic batch contains no canonical records",
                session_id,
                turn_id,
                0,
                None,
            ));
        }
        self.recorder
            .append_items(&path, timestamp.clone(), items)?;
        let log_head = self.recorder.thread_log_head(&path)?;
        record.updated_at = timestamp.clone();
        if let Some(total_tokens) = latest_total_tokens {
            state.tokens_used = total_tokens;
            state.updated_at = timestamp.clone();
        }
        if has_response_items {
            let replay =
                super::reconstruction::reconstruct_canonical_rollout(&read_thread_lines(&path)?)?
                    .semantic;
            if is_default_thread_title(&state.title) {
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

    pub fn list_turns(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentTurnRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.turn_records_for_session(session_id)
    }

    pub fn reconcile_orphaned_turns(&self) -> Result<AgentTurnRecoveryReport, WorkerProtocolError> {
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
        let mut report = AgentTurnRecoveryReport {
            scanned_sessions: session_ids.len(),
            ..Default::default()
        };
        for session_id in session_ids {
            for turn in self.turn_records_for_session(&session_id)? {
                report.scanned_turns = report.scanned_turns.saturating_add(1);
                let entry = AgentTurnRecoveryEntry {
                    session_id: turn.session_id.clone(),
                    turn_id: turn.turn_id.clone(),
                    thread_id: turn.thread_id.clone(),
                };
                match turn.status {
                    AgentTurnStatus::Running => {
                        self.mark_turn_interrupted(
                            &turn.session_id,
                            &turn.turn_id,
                            "Runtime restarted before the turn reached a terminal state.",
                        )?;
                        report.interrupted_turns.push(entry);
                    }
                    AgentTurnStatus::Waiting if turn.checkpoint.is_some() => {
                        report.resumable_turns.push(entry);
                    }
                    AgentTurnStatus::Waiting => {
                        report.awaiting_interaction_turns.push(entry);
                    }
                    AgentTurnStatus::Completed
                    | AgentTurnStatus::Failed
                    | AgentTurnStatus::Cancelled
                    | AgentTurnStatus::Interrupted => {}
                }
            }
        }
        report.interrupted_turns.sort();
        report.interrupted_turns.dedup();
        report.awaiting_interaction_turns.sort();
        report.awaiting_interaction_turns.dedup();
        report.resumable_turns.sort();
        report.resumable_turns.dedup();
        Ok(report)
    }

    pub fn get_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<AgentTurnRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_turn_key(session_id, turn_id)?;
        self.get_turn_record(session_id, turn_id)
    }

    pub fn get_turn_runtime_state(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<AgentTurnRuntimeState>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        validate_turn_key(session_id, turn_id)?;
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
                .turns
                .iter()
                .find(|record| record.turn_id == turn_id)
                .cloned()
            else {
                continue;
            };
            if selected
                .as_ref()
                .is_none_or(|(current, _): &(AgentTurnRecord, Vec<_>)| {
                    record.updated_at > current.updated_at
                })
            {
                selected = Some((record, reconstructed.thread_items));
            }
        }
        let Some((_, thread_items)) = selected else {
            return Ok(None);
        };
        let runtime_events = crate::threads::domain::runtime_events_from_thread_items(
            &thread_items,
            session_id,
            turn_id,
        );
        let runtime_state =
            AgentTurnRuntimeState::from_runtime_events(session_id, turn_id, runtime_events.clone())
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
                        "turn_runtime_state_projection_failed session_id={} turn_id={} error={} details={} events={}",
                        session_id,
                        turn_id,
                        error.message,
                        error.details,
                        Value::Array(diagnostics),
                    );
                    error
                })?;
        Ok(Some(runtime_state))
    }

    pub fn set_turn_checkpoint(
        &self,
        session_id: &str,
        turn_id: &str,
        checkpoint: Value,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_turn_key(session_id, turn_id)?;
        let timestamp = now_thread_timestamp();
        let mut record = self
            .get_turn_record(session_id, turn_id)?
            .unwrap_or_else(|| turn_from_checkpoint(session_id, turn_id, &checkpoint, &timestamp));
        let mut state = self.ensure_turn_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            value_event(
                super::EventKind::TurnCheckpointSet,
                serde_json::json!({
                    "sessionId": session_id,
                    "turnId": turn_id,
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

    pub fn latest_turn_checkpoint(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentTurnCheckpoint>, WorkerProtocolError> {
        let mut turns = self.list_turns(session_id)?;
        turns.retain(|turn| turn.checkpoint.is_some() && turn_status_is_resumable(&turn.status));
        Ok(turns.into_iter().next().and_then(|turn| {
            turn.checkpoint.map(|checkpoint| AgentTurnCheckpoint {
                session_id: turn.session_id,
                turn_id: turn.turn_id,
                checkpoint,
            })
        }))
    }

    pub fn clear_latest_turn_checkpoint(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentTurnRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut turns = self.turn_records_for_session(session_id)?;
        turns.retain(|turn| turn.checkpoint.is_some() && turn_status_is_resumable(&turn.status));
        let Some(turn) = turns.into_iter().next() else {
            return Ok(None);
        };
        self.clear_turn_checkpoint(session_id, &turn.turn_id)
            .map(Some)
    }

    pub fn get_turn_checkpoint(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<AgentTurnCheckpoint>, WorkerProtocolError> {
        let Some(record) = self.get_turn(session_id, turn_id)? else {
            return Ok(None);
        };
        Ok(record.checkpoint.map(|checkpoint| AgentTurnCheckpoint {
            session_id: record.session_id,
            turn_id: record.turn_id,
            checkpoint,
        }))
    }

    pub fn clear_turn_checkpoint(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_turn_key(session_id, turn_id)?;
        let mut record = self
            .get_turn_record(session_id, turn_id)?
            .ok_or_else(|| unknown_turn_error(session_id, turn_id))?;
        let timestamp = now_thread_timestamp();
        let mut state = self.ensure_turn_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        self.recorder.append_item(
            &path,
            timestamp.clone(),
            value_event(
                super::EventKind::TurnCheckpointClear,
                serde_json::json!({ "sessionId": session_id, "turnId": turn_id }),
            ),
        )?;
        let log_head = self.recorder.thread_log_head(&path)?;
        record.checkpoint = None;
        record.updated_at = timestamp.clone();
        state.updated_at = timestamp;
        self.state.upsert_thread_projection(&state, &log_head)?;
        Ok(record)
    }

    pub fn mark_turn_completed(
        &self,
        session_id: &str,
        turn_id: &str,
        stop_reason: &str,
        final_content: Option<String>,
        context_checkpoint: Option<Value>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.mark_turn_terminal(
            session_id,
            turn_id,
            AgentTurnStatus::Completed,
            "completed",
            Some(stop_reason.to_string()),
            final_content,
            None,
            context_checkpoint,
        )
    }

    pub fn mark_turn_failed(
        &self,
        session_id: &str,
        turn_id: &str,
        stop_reason: &str,
        error: Value,
        context_checkpoint: Option<Value>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.mark_turn_terminal(
            session_id,
            turn_id,
            AgentTurnStatus::Failed,
            "failed",
            Some(stop_reason.to_string()),
            None,
            Some(error),
            context_checkpoint,
        )
    }

    pub fn mark_turn_cancelled(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.mark_turn_terminal(
            session_id,
            turn_id,
            AgentTurnStatus::Cancelled,
            "cancelled",
            Some("cancelled".to_string()),
            None,
            None,
            None,
        )
    }

    pub fn mark_turn_interrupted(
        &self,
        session_id: &str,
        turn_id: &str,
        reason: &str,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        let record = self
            .get_turn_record(session_id, turn_id)?
            .ok_or_else(|| unknown_turn_error(session_id, turn_id))?;
        if record.status != AgentTurnStatus::Running {
            return Ok(record);
        }
        self.append_turn_semantic_event(
            session_id,
            turn_id,
            serde_json::json!({
                "eventId": format!("startup-recovery:{session_id}:{turn_id}"),
                "eventName": "agent.cancelled",
                "timestamp": now_thread_timestamp(),
                "payload": {
                    "turnId": turn_id,
                    "sessionId": session_id,
                    "cancelled": true,
                    "stopReason": "runtime_restarted",
                    "reason": reason,
                    "source": "startup_recovery"
                }
            }),
        )?;
        self.mark_turn_interrupted_terminal(session_id, turn_id, reason)
    }

    pub fn mark_turn_interrupted_terminal(
        &self,
        session_id: &str,
        turn_id: &str,
        reason: &str,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.mark_turn_terminal(
            session_id,
            turn_id,
            AgentTurnStatus::Interrupted,
            "interrupted",
            Some("runtime_restarted".to_string()),
            None,
            Some(serde_json::json!({
                "code": "orphaned_turn",
                "message": reason,
                "source": "startup_recovery"
            })),
            None,
        )
    }

    fn get_turn_record(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<AgentTurnRecord>, WorkerProtocolError> {
        Ok(self
            .turn_records_for_session(session_id)?
            .into_iter()
            .find(|record| record.turn_id == turn_id))
    }

    fn turn_records_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentTurnRecord>, WorkerProtocolError> {
        self.ensure_state_index()?;
        let mut turns_by_id = HashMap::<String, AgentTurnRecord>::new();
        for record in self.state.list_threads()?.into_iter().filter(|record| {
            !record.archived
                && (record.id == session_id || record.session_id.as_deref() == Some(session_id))
        }) {
            let path = PathBuf::from(record.thread_path);
            self.recorder.validate_thread_path(&path)?;
            let lines = read_thread_lines(&path)?;
            let reconstructed = super::reconstruction::reconstruct_canonical_rollout(&lines)?;
            for turn in reconstructed.turns {
                match turns_by_id.entry(turn.turn_id.clone()) {
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(turn);
                    }
                    std::collections::hash_map::Entry::Occupied(mut entry)
                        if turn.updated_at > entry.get().updated_at =>
                    {
                        entry.insert(turn);
                    }
                    std::collections::hash_map::Entry::Occupied(_) => {}
                }
            }
        }
        let mut turns = turns_by_id.into_values().collect::<Vec<_>>();
        turns.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });
        Ok(turns)
    }

    fn ensure_turn_thread(
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

    fn mark_turn_terminal(
        &self,
        session_id: &str,
        turn_id: &str,
        status: AgentTurnStatus,
        phase: &str,
        stop_reason: Option<String>,
        final_content: Option<String>,
        error: Option<Value>,
        context_checkpoint: Option<Value>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        validate_turn_key(session_id, turn_id)?;
        let mut record = self
            .get_turn_record(session_id, turn_id)?
            .ok_or_else(|| unknown_turn_error(session_id, turn_id))?;
        let timestamp = now_thread_timestamp();
        let mut state = self.ensure_turn_thread(session_id, &timestamp)?;
        let path = PathBuf::from(state.thread_path.clone());
        self.recorder.validate_thread_path(&path)?;
        let lifecycle_kind = if status == AgentTurnStatus::Completed {
            super::EventKind::TurnComplete
        } else {
            super::EventKind::TurnAborted
        };
        let mut items = vec![value_event(
            lifecycle_kind,
            serde_json::json!({
                "sessionId": session_id,
                "turnId": record.turn_id,
                "status": status,
                "phase": phase,
                "stopReason": stop_reason,
                "error": error,
            }),
        )];
        if let Some(mut context_checkpoint) = context_checkpoint {
            super::insert_required_turn_id(
                &mut context_checkpoint,
                turn_id,
                "agent turn terminal context finalization",
            )?;
            validate_finalized_context_checkpoint(&path, &context_checkpoint)?;
            items.insert(
                0,
                ThreadLogItem::Compacted(super::typed_compacted_item(
                    context_checkpoint,
                    "agent turn terminal context finalization",
                )?),
            );
        }
        if record.checkpoint.is_some() {
            items.push(value_event(
                super::EventKind::TurnCheckpointClear,
                serde_json::json!({ "sessionId": session_id, "turnId": turn_id }),
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
        "agent.command.acknowledged" => Some(serde_json::json!({
            "type": "custom_tool_call",
            "id": payload.get("commandId")?.clone(),
            "call_id": payload.get("commandId")?.clone(),
            "name": payload.get("commandKind")?.clone(),
            "input": payload.get("target").cloned().unwrap_or_else(|| serde_json::json!({})),
        })),
        "agent.tool.result" => {
            let call_id = payload.get("toolCallId")?.clone();
            let item_id = call_id
                .as_str()
                .map(|call_id| format!("tool-output:{call_id}"))?;
            Some(serde_json::json!({
                "type": "custom_tool_call_output",
                "id": item_id,
                "call_id": call_id,
                "output": payload
                    .get("content")
                    .or_else(|| payload.get("result"))
                    .or_else(|| payload.get("summary"))
                    .cloned()
                    .unwrap_or(Value::Null),
            }))
        }
        _ => None,
    }
}

fn validate_finalized_context_checkpoint(
    path: &std::path::Path,
    checkpoint: &Value,
) -> Result<(), WorkerProtocolError> {
    if checkpoint.get("checkpointStage").and_then(Value::as_str) != Some("finalized") {
        return Err(super::thread_log_consistency_error(
            "terminal context checkpoint must be finalized",
            serde_json::json!({ "threadPath": path.display().to_string() }),
        ));
    }
    let context_id = checkpoint
        .get("contextId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            super::thread_log_consistency_error(
                "terminal context checkpoint is missing contextId",
                serde_json::json!({ "threadPath": path.display().to_string() }),
            )
        })?;
    let lines = read_thread_lines(path)?;
    let latest = lines.iter().rev().find_map(|line| match &line.item {
        ThreadLogItem::Compacted(existing) => Some(existing),
        _ => None,
    });
    let Some(installed) = latest else {
        return Err(super::thread_log_consistency_error(
            "terminal context checkpoint has no installed predecessor",
            serde_json::json!({ "contextId": context_id }),
        ));
    };
    if installed.get("contextId").and_then(Value::as_str) != Some(context_id)
        || installed.get("checkpointStage").and_then(Value::as_str) != Some("installed")
    {
        return Err(super::thread_log_consistency_error(
            "terminal context checkpoint does not finalize the latest installed checkpoint",
            serde_json::json!({
                "contextId": context_id,
                "latestContextId": installed.get("contextId"),
                "latestCheckpointStage": installed.get("checkpointStage"),
            }),
        ));
    }
    Ok(())
}

fn canonical_provider_call_usage(info: &Value) -> Option<Value> {
    let usage = info
        .get("lastTokenUsage")
        .or_else(|| info.get("last_token_usage"))?
        .clone();
    Some(serde_json::json!({
        "usage": usage,
        "modelContextWindow": info
            .get("modelContextWindow")
            .or_else(|| info.get("model_context_window"))
            .cloned()
            .unwrap_or(Value::Null),
    }))
}

fn semantic_thread_item_from_runtime_event(
    session_id: &str,
    turn_id: &str,
    timestamp: &str,
    event: &Value,
) -> Option<crate::threads::domain::ThreadItem> {
    let event_name = event.get("eventName").and_then(Value::as_str)?;
    let payload = event.get("payload").cloned().unwrap_or(Value::Null);
    let kind = match event_name {
        "agent.awaiting_approval" => {
            crate::threads::domain::ThreadItemKind::ApprovalRequested(payload)
        }
        "agent.approval.decision" => {
            crate::threads::domain::ThreadItemKind::ApprovalResolved(payload)
        }
        "agent.error" => crate::threads::domain::ThreadItemKind::Error(payload),
        "agent.cancelled" => crate::threads::domain::ThreadItemKind::Cancelled(payload),
        "agent.delegate.spawned" => {
            crate::threads::domain::ThreadItemKind::SubagentSpawned(payload)
        }
        "agent.delegate.message" => {
            crate::threads::domain::ThreadItemKind::SubagentMessage(payload)
        }
        "agent.delegate.completed" => {
            crate::threads::domain::ThreadItemKind::SubagentCompleted(payload)
        }
        _ => return None,
    };
    let event_id = event.get("eventId").and_then(Value::as_str)?;
    Some(crate::threads::domain::ThreadItem {
        item_id: format!("semantic:{session_id}:{turn_id}:{event_id}"),
        thread_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: timestamp.to_string(),
        kind,
    })
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

pub(crate) fn is_turn_semantic_event(event_name: &str) -> bool {
    event_name != "agent.turn.started"
        && crate::agent::runtime_protocol::is_durable_agent_timeline_event(event_name)
        || matches!(
            event_name,
            "agent.command.acknowledged" | "agent.token_count"
        )
}

fn response_item_from_runtime_event_name(event_name: &str) -> bool {
    matches!(
        event_name,
        "agent.turn.started"
            | "agent.reasoning.completed"
            | "agent.message.classified"
            | "agent.message.completed"
            | "agent.tool_call.delta"
            | "agent.tool.result"
            | "agent.command.acknowledged"
    )
}

fn validate_turn_semantic_event(
    session_id: &str,
    turn_id: &str,
    index: usize,
    event: &Value,
) -> Result<(), WorkerProtocolError> {
    let event_name = event
        .get("eventName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_turn_semantic_event_error(
                "agent turn semantic event is missing eventName",
                session_id,
                turn_id,
                index,
                None,
            )
        })?;
    event
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_turn_semantic_event_error(
                "agent turn semantic event is missing eventId",
                session_id,
                turn_id,
                index,
                Some(event_name),
            )
        })?;
    if !is_turn_semantic_event(event_name) {
        return Err(invalid_turn_semantic_event_error(
            "runtime event has no canonical semantic representation",
            session_id,
            turn_id,
            index,
            Some(event_name),
        ));
    }
    let requires_response_item = matches!(
        event_name,
        "agent.turn.started"
            | "agent.reasoning.completed"
            | "agent.message.classified"
            | "agent.message.completed"
            | "agent.tool_call.delta"
            | "agent.tool.result"
            | "agent.command.acknowledged"
    );
    if requires_response_item && response_item_from_runtime_event(event).is_none() {
        return Err(invalid_turn_semantic_event_error(
            "semantic runtime event cannot be materialized as a typed response item",
            session_id,
            turn_id,
            index,
            Some(event_name),
        ));
    }
    Ok(())
}

fn turn_status_is_resumable(status: &AgentTurnStatus) -> bool {
    matches!(status, AgentTurnStatus::Running | AgentTurnStatus::Waiting)
}

pub(super) fn turn_records_from_lines(
    session_id: &str,
    thread_id: &str,
    lines: &[super::ThreadLogLine],
) -> Result<Vec<AgentTurnRecord>, WorkerProtocolError> {
    let mut turns: HashMap<String, AgentTurnRecord> = HashMap::new();
    for line in lines {
        if let super::ThreadLogItem::ResponseItem(item) = &line.item {
            apply_response_item_to_turns(&mut turns, item.as_value(), line)?;
            continue;
        }
        let super::ThreadLogItem::EventMsg(event) = &line.item else {
            continue;
        };
        let payload = event.payload();
        match event.kind() {
            super::EventKind::TurnStarted if payload.get("turn").is_some() => {
                let record_value = payload.get("turn").cloned().ok_or_else(|| {
                    turn_replay_error("turn_started is missing turn", line, payload)
                })?;
                let seed = serde_json::from_value::<PersistedAgentTurnSeed>(record_value).map_err(
                    |error| {
                        turn_replay_error(
                            "turn_started contains an invalid turn",
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
                    return Err(turn_replay_error(
                        "turn_started turn belongs to a different session",
                        line,
                        &serde_json::json!({
                            "expectedSessionId": session_id,
                            "expectedThreadId": thread_id,
                            "actualSessionId": seed.session_id,
                            "turnId": seed.turn_id,
                        }),
                    ));
                }
                match turns.entry(seed.turn_id.clone()) {
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        seed.apply_metadata_to(entry.get_mut());
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(seed.into_record());
                    }
                }
            }
            super::EventKind::TurnCheckpointSet => {
                let turn_id = payload_turn_id(payload).ok_or_else(|| {
                    turn_replay_error(
                        "turn_checkpoint_set event is missing its turn id",
                        line,
                        payload,
                    )
                })?;
                let checkpoint = payload.get("checkpoint").cloned().ok_or_else(|| {
                    turn_replay_error(
                        "turn_checkpoint_set event is missing its checkpoint",
                        line,
                        payload,
                    )
                })?;
                let record = turns.entry(turn_id.clone()).or_insert_with(|| {
                    turn_from_checkpoint(session_id, &turn_id, &checkpoint, &line.timestamp)
                });
                apply_checkpoint_to_record(record, checkpoint, &line.timestamp);
            }
            super::EventKind::TurnCheckpointClear => {
                let turn_id = payload_turn_id(payload).ok_or_else(|| {
                    turn_replay_error(
                        "turn_checkpoint_clear event is missing its turn id",
                        line,
                        payload,
                    )
                })?;
                let record = turns.get_mut(&turn_id).ok_or_else(|| {
                    turn_replay_error(
                        "turn_checkpoint_clear event references an unknown turn",
                        line,
                        payload,
                    )
                })?;
                record.checkpoint = None;
                record.updated_at = line.timestamp.clone();
            }
            kind @ (super::EventKind::TurnComplete | super::EventKind::TurnAborted) => {
                let Some(turn_id) = payload_turn_id(payload) else {
                    continue;
                };
                let Some(record) = turns.get_mut(&turn_id) else {
                    continue;
                };
                let status = match payload.get("status").and_then(Value::as_str) {
                    Some("completed") => AgentTurnStatus::Completed,
                    Some("failed") => AgentTurnStatus::Failed,
                    Some("cancelled") => AgentTurnStatus::Cancelled,
                    Some("interrupted") => AgentTurnStatus::Interrupted,
                    _ if kind == &super::EventKind::TurnComplete => AgentTurnStatus::Completed,
                    _ => AgentTurnStatus::Interrupted,
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
                let error = payload
                    .get("error")
                    .filter(|value| !value.is_null())
                    .cloned();
                apply_terminal_to_record(
                    record,
                    status,
                    &phase,
                    stop_reason,
                    None,
                    error,
                    &line.timestamp,
                );
            }
            super::EventKind::SessionCleared => {
                for record in turns.values_mut() {
                    record.checkpoint = None;
                    record.updated_at = line.timestamp.clone();
                }
            }
            super::EventKind::TurnStarted
            | super::EventKind::TaskStarted
            | super::EventKind::TaskComplete
            | super::EventKind::UserMessage
            | super::EventKind::ThreadRolledBack
            | super::EventKind::TokenCount
            | super::EventKind::MetadataUpdated
            | super::EventKind::SessionTrimmed
            | super::EventKind::ThreadItem => {}
        }
    }
    Ok(turns.into_values().collect())
}

fn apply_response_item_to_turns(
    turns: &mut HashMap<String, AgentTurnRecord>,
    item: &Value,
    _line: &super::ThreadLogLine,
) -> Result<(), WorkerProtocolError> {
    let Some(turn_id) = item
        .get("turnId")
        .or_else(|| item.get("turn_id"))
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    let Some(record) = turns.get_mut(turn_id) else {
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
    serde_json::json!({
        "toolCallId": item.get("call_id").cloned().unwrap_or(Value::Null),
        "summary": bounded_derived_tool_summary(
            item.get("output").cloned().unwrap_or(Value::Null)
        ),
    })
}

fn bounded_derived_tool_summary(summary: Value) -> Value {
    let serialized = summary.to_string();
    let original_chars = serialized.chars().count();
    if original_chars <= 2_048 {
        return summary;
    }
    serde_json::json!({
        "truncated": true,
        "originalChars": original_chars,
    })
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

fn turn_replay_error(
    message: &str,
    line: &super::ThreadLogLine,
    detail: &Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({
            "method": "rollout.reconstruct.turns",
            "timestamp": line.timestamp,
            "ordinal": line.ordinal,
            "detail": detail,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn payload_turn_id(payload: &Value) -> Option<String> {
    payload
        .get("turnId")
        .or_else(|| payload.get("turn_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn apply_checkpoint_to_record(record: &mut AgentTurnRecord, checkpoint: Value, timestamp: &str) {
    record.phase = checkpoint
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or(record.phase.as_str())
        .to_string();
    record.status = turn_status_from_checkpoint(&checkpoint);
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
    record: &mut AgentTurnRecord,
    status: AgentTurnStatus,
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

fn final_content_preview(record: &AgentTurnRecord) -> Option<String> {
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

fn turn_from_checkpoint(
    session_id: &str,
    turn_id: &str,
    checkpoint: &Value,
    timestamp: &str,
) -> AgentTurnRecord {
    AgentTurnRecord {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        thread_id: checkpoint
            .get("threadId")
            .or_else(|| checkpoint.get("thread_id"))
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
        status: AgentTurnStatus::Waiting,
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

fn turn_status_from_checkpoint(checkpoint: &Value) -> AgentTurnStatus {
    match checkpoint
        .get("stopReason")
        .or_else(|| checkpoint.get("stop_reason"))
        .and_then(Value::as_str)
        .or_else(|| checkpoint.get("phase").and_then(Value::as_str))
    {
        Some("final_response") | Some("completed") | Some("done") | Some("terminal") => {
            AgentTurnStatus::Completed
        }
        Some("cancelled") => AgentTurnStatus::Cancelled,
        Some("interrupted") | Some("runtime_restarted") => AgentTurnStatus::Interrupted,
        Some("provider_error")
        | Some("tool_error")
        | Some("policy_denied")
        | Some("max_iterations")
        | Some("invalid_request")
        | Some("approval_denied")
        | Some("form_cancelled")
        | Some("failed") => AgentTurnStatus::Failed,
        _ => AgentTurnStatus::Waiting,
    }
}

fn validate_turn_key(session_id: &str, turn_id: &str) -> Result<(), WorkerProtocolError> {
    validate_path_safe_id(session_id, "session_id")?;
    validate_path_safe_id(turn_id, "turn_id")
}

fn validate_path_safe_id(value: &str, field: &str) -> Result<(), WorkerProtocolError> {
    if value.trim().is_empty() || value.contains('\0') || value.contains("..") {
        return Err(invalid_turn_key(field, value));
    }
    Ok(())
}

fn invalid_turn_key(field: &str, value: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "invalid agent turn key",
        serde_json::json!({ field: value }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn invalid_turn_semantic_event_error(
    message: &str,
    session_id: &str,
    turn_id: &str,
    index: usize,
    event_name: Option<&str>,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({
            "session_id": session_id,
            "turn_id": turn_id,
            "event_index": index,
            "event_name": event_name,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn unknown_turn_error(session_id: &str, turn_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "agent turn not found",
        serde_json::json!({
            "session_id": session_id,
            "turn_id": turn_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
#[path = "turn_tests.rs"]
mod tests;

fn empty_turn_semantic_batch_error(session_id: &str, turn_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "agent turn semantic batch must contain at least one event",
        serde_json::json!({
            "session_id": session_id,
            "turn_id": turn_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
