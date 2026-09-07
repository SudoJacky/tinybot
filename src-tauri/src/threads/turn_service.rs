use super::rollout::format::{ResponseItem, TurnContextItem};
use super::turn::{AgentTurnCheckpoint, AgentTurnRecord, AgentTurnRuntimeState};
use super::workspace_store::{WorkspaceThreadOperation, WorkspaceThreadStore};
use crate::agent::runtime_protocol::AgentRuntimeEventEnvelope;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use serde_json::Value;

impl WorkspaceThreadStore {
    pub(crate) fn agent_history(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> Result<Option<super::rollout::store::ThreadHistoryProjection>, WorkerProtocolError> {
        self.turn_operation(|operation| operation.thread_log().get_thread_context(thread_id, limit))
    }
    pub(crate) fn turn_operation<T>(
        &self,
        operation: impl FnOnce(&mut WorkspaceThreadOperation<'_>) -> Result<T, WorkerProtocolError>,
    ) -> Result<T, WorkerProtocolError> {
        let mut guard = self.begin_operation()?;
        let result = operation(&mut guard);
        if let Err(error) = &result {
            if let Err(reload) = guard.reload_projection() {
                eprintln!(
                    "turn_projection_reload_failed operation_error={} reload_error={}",
                    error.message, reload.message
                );
                // Keep the original error category and the recovery failure together.
                let mut combined = error.clone();
                combined.details = serde_json::json!({"operationDetails": error.details, "projectionReloadError": reload});
                return Err(combined);
            }
        }
        result
    }

    pub(crate) fn start_agent_turn(
        &self,
        record: AgentTurnRecord,
        context: Option<TurnContextItem>,
        messages: Vec<ResponseItem>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let thread_id = record
                .thread_id
                .clone()
                .unwrap_or_else(|| record.session_id.clone());
            let record = operation
                .thread_log()
                .start_turn(record, context, messages)?;
            operation.sync_thread_projection(&thread_id)?;
            Ok(record)
        })
    }

    pub(crate) fn agent_turns(
        &self,
        thread_id: &str,
    ) -> Result<Vec<AgentTurnRecord>, WorkerProtocolError> {
        self.turn_operation(|operation| operation.thread_log().list_turns(thread_id))
    }

    pub(crate) fn agent_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Option<AgentTurnRecord>, WorkerProtocolError> {
        self.turn_operation(|operation| operation.thread_log().get_turn(thread_id, turn_id))
    }

    pub(crate) fn agent_turn_runtime_state(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<AgentTurnRuntimeState, WorkerProtocolError> {
        self.turn_operation(|operation| {
            operation
                .thread_log()
                .get_turn_runtime_state(thread_id, turn_id)?
                .ok_or_else(|| turn_not_found_error(thread_id, turn_id))
        })
    }

    pub(crate) fn append_agent_turn_events(
        &self,
        thread_id: &str,
        turn_id: &str,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        // Encode once at the canonical rollout projection boundary.
        let events = events
            .iter()
            .map(|event| serde_json::to_value(event).expect("runtime event must serialize"))
            .collect();
        self.append_agent_turn_semantic_values(thread_id, turn_id, events)
    }

    // The external RPC also accepts legacy semantic events without an envelope.
    pub(crate) fn append_agent_turn_semantic_values(
        &self,
        thread_id: &str,
        turn_id: &str,
        events: Vec<Value>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let record = operation
                .thread_log()
                .append_turn_semantic_events(thread_id, turn_id, events)?;
            operation.sync_thread_projection(thread_id)?;
            Ok(record)
        })
    }

    pub(crate) fn set_agent_turn_checkpoint(
        &self,
        thread_id: &str,
        turn_id: &str,
        checkpoint: Value,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let record = operation
                .thread_log()
                .set_turn_checkpoint(thread_id, turn_id, checkpoint)?;
            operation.sync_thread_projection(thread_id)?;
            Ok(record)
        })
    }

    pub(crate) fn agent_turn_checkpoint(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Option<AgentTurnCheckpoint>, WorkerProtocolError> {
        self.turn_operation(|operation| {
            operation
                .thread_log()
                .get_turn_checkpoint(thread_id, turn_id)
        })
    }

    pub(crate) fn clear_agent_turn_checkpoint(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let record = operation
                .thread_log()
                .clear_turn_checkpoint(thread_id, turn_id)?;
            operation.sync_thread_projection(thread_id)?;
            Ok(record)
        })
    }

    pub(crate) fn complete_agent_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        stop_reason: &str,
        final_content: Option<String>,
        checkpoint: Option<Value>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let record = operation.thread_log().mark_turn_completed(
                thread_id,
                turn_id,
                stop_reason,
                final_content,
                checkpoint,
            )?;
            operation.sync_thread_projection(thread_id)?;
            Ok(record)
        })
    }

    pub(crate) fn fail_agent_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        stop_reason: &str,
        error: Value,
        checkpoint: Option<Value>,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let record = operation.thread_log().mark_turn_failed(
                thread_id,
                turn_id,
                stop_reason,
                error,
                checkpoint,
            )?;
            operation.sync_thread_projection(thread_id)?;
            Ok(record)
        })
    }

    pub(crate) fn cancel_agent_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let record = operation
                .thread_log()
                .mark_turn_cancelled(thread_id, turn_id)?;
            operation.sync_thread_projection(thread_id)?;
            Ok(record)
        })
    }

    pub(crate) fn interrupt_agent_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        reason: &str,
    ) -> Result<AgentTurnRecord, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let record = operation
                .thread_log()
                .mark_turn_interrupted_terminal(thread_id, turn_id, reason)?;
            operation.sync_thread_projection(thread_id)?;
            Ok(record)
        })
    }
}

pub(crate) fn turn_not_found_error(thread_id: &str, turn_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "turn not found",
        serde_json::json!({"threadId":thread_id,"turnId":turn_id}),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
