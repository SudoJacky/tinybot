use super::rollout::format::{ResponseItem, TurnContextItem};
use super::turn::{AgentTurnCheckpoint, AgentTurnRecord, AgentTurnRuntimeState};
use super::workspace_store::{WorkspaceThreadOperation, WorkspaceThreadStore};
use crate::agent::runtime_protocol::AgentRuntimeEventEnvelope;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use serde_json::Value;

impl WorkspaceThreadStore {
    pub(crate) fn read_agent_thread(
        &self,
        thread_id: &str,
    ) -> Result<super::domain::ThreadSnapshot, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let snapshot = operation
                .thread()
                .read_thread(super::domain::ReadThreadRequest {
                    thread_id: thread_id.into(),
                    ..Default::default()
                })?;
            operation
                .thread_log()
                .hydrate_thread_snapshot(snapshot, None, None, None, None, None)
        })
    }

    pub(crate) fn create_agent_thread(
        &self,
        thread_id: String,
        config: &Value,
    ) -> Result<super::domain::ThreadRecord, WorkerProtocolError> {
        let api_mode = crate::agent::provider::resolve_provider_profile(config, None, None)
            .map(|profile| profile.parsed_api_mode())
            .transpose()
            .map_err(|error| {
                WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    error,
                    serde_json::json!({"method":"thread.create"}),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                )
            })?
            .unwrap_or(crate::agent::provider::NativeProviderApiMode::ChatCompletions);
        self.turn_operation(|operation| {
            let mut request = super::domain::CreateThreadRequest {
                thread_id: Some(thread_id),
                ..Default::default()
            };
            request.metadata.extra = Some(serde_json::json!({"apiMode": api_mode.as_str()}));
            let thread = operation.thread().create_thread(request)?;
            operation.thread_log().create_from_thread_record(&thread)?;
            operation.sync_thread_projection(&thread.thread_id)?;
            Ok(thread)
        })
    }

    pub(crate) fn start_agent_thread_turn(
        &self,
        request: super::domain::StartThreadTurnRequest,
    ) -> Result<super::domain::ThreadTurnRuntimeResult, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let result = operation.thread().start_turn(request)?;
            let thread = &result.snapshot.thread;
            operation.thread_log().create_from_thread_record(thread)?;
            operation
                .thread_log()
                .append_thread_items(&thread.thread_id, &result.appended_items)?;
            operation.sync_thread_projection(&thread.thread_id)?;
            Ok(result)
        })
    }

    pub(crate) fn latest_agent_checkpoint(
        &self,
        thread_id: &str,
    ) -> Result<Option<crate::agent::runtime::AgentCheckpoint>, crate::agent::runtime::AgentError>
    {
        let checkpoint = self
            .turn_operation(|operation| operation.thread_log().latest_turn_checkpoint(thread_id))?;
        checkpoint
            .map(|checkpoint| {
                crate::agent::runtime::AgentCheckpoint::from_wire(checkpoint.checkpoint)
            })
            .transpose()
    }

    pub(crate) fn clear_latest_agent_checkpoint(
        &self,
        thread_id: &str,
    ) -> Result<(), WorkerProtocolError> {
        self.turn_operation(|operation| {
            operation
                .thread_log()
                .clear_latest_turn_checkpoint(thread_id)?;
            operation.sync_thread_projection(thread_id)
        })
    }

    pub(crate) fn commit_agent_context_checkpoint(
        &self,
        thread_id: &str,
        turn_id: &str,
        checkpoint: &crate::agent::runtime::AgentContextCheckpoint,
    ) -> Result<super::rollout::store::ContextCheckpointCommitResult, WorkerProtocolError> {
        self.turn_operation(|operation| {
            let checkpoint =
                serde_json::to_value(checkpoint).expect("context checkpoint must serialize");
            let result = operation
                .thread_log()
                .commit_context_checkpoint(thread_id, turn_id, checkpoint)?;
            operation.sync_thread_projection(thread_id)?;
            Ok(result)
        })
    }

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
