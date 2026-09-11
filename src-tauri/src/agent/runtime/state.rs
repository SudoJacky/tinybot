use super::context_checkpoint::{AgentContextCheckpoint, ContextCheckpointStage};
use super::context_manager::ContextManager;
use super::continuations::guidance_continuation_message;
use super::events::{prepare_runtime_event_input, runtime_event_timestamp, runtime_status_label};
use super::hooks::AgentHookEvaluation;
use super::tool_loop_guard::ToolLoopGuard;
use super::trace_commit::TraceCommitter;
use super::usage::{
    enrich_usage_with_context_window, latest_cumulative_usage_tokens, usage_context_used_tokens,
};
use super::{
    string_field, AgentHookInvocation, AgentTurnContext, NativeAgentToolCall, NativeAgentTraceSink,
};
use super::{AgentStopReason, AgentTurnResult};
use crate::agent::runtime::AgentError;
use crate::agent::runtime_protocol::{
    AgentEventKind, AgentRuntimeEventEnvelope, AgentRuntimePhase, AgentTurnEmitter,
    ModelOutputEvent, PendingAgentEvent,
};
use crate::threads::rollout::checkpoint_lineage::ContextCheckpointParent;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct AgentTurnState {
    pub(super) turn_id: String,
    pub(super) session_id: String,
    pub(super) phase: AgentRuntimePhase,
    pub(super) iteration: i64,
    pub(super) pending_tool_calls: Vec<super::PendingAgentToolCall>,
    pub(super) completed_tool_results: Vec<super::CompletedAgentToolResult>,
    pub(super) history: ContextManager,
    emitter: AgentTurnEmitter,
    trace_committer: TraceCommitter,
    usage: Vec<Value>,
    pub(super) tools_used: Vec<String>,
    stop_reason: Option<AgentStopReason>,
    context_checkpoint: Option<AgentContextCheckpoint>,
    source_context_checkpoint: Option<ContextCheckpointParent>,
    pending_guidance_message: Option<Value>,
    pub(super) tool_loop_guard: ToolLoopGuard,
}

impl AgentTurnState {
    pub(super) fn new(
        context: &AgentTurnContext,
        trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    ) -> Result<Self, AgentError> {
        Ok(Self {
            turn_id: context.turn_id.clone(),
            session_id: context.session_id.clone(),
            phase: AgentRuntimePhase::Queued,
            iteration: 0,
            pending_tool_calls: Vec::new(),
            completed_tool_results: Vec::new(),
            history: ContextManager::from_history(&context.messages),
            emitter: AgentTurnEmitter::new_with_trace_context(
                &context.session_id,
                context.trace_context.clone(),
            ),
            trace_committer: TraceCommitter::new(&context.session_id, &context.turn_id, trace_sink),
            usage: Vec::new(),
            tools_used: Vec::new(),
            stop_reason: None,
            context_checkpoint: None,
            source_context_checkpoint: context
                .metadata
                .get("contextSourceCheckpoint")
                .or_else(|| context.metadata.get("context_source_checkpoint"))
                .cloned()
                .or_else(|| {
                    string_field(&context.metadata, "contextSourceCheckpointId")
                        .or_else(|| string_field(&context.metadata, "context_source_checkpoint_id"))
                        .map(|context_id| serde_json::json!({ "contextId": context_id }))
                })
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| {
                    AgentError::invalid_input(format!("invalid context checkpoint parent: {error}"))
                })?,
            pending_guidance_message: guidance_continuation_message(context.continuation.as_ref()),
            tool_loop_guard: ToolLoopGuard::default(),
        })
    }

    fn append_trace_event(&mut self, event: &AgentRuntimeEventEnvelope) -> Result<(), AgentError> {
        self.trace_committer.commit(event).map_err(AgentError::from)
    }

    pub(super) fn new_for_continuation(
        context: &AgentTurnContext,
        trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    ) -> Result<Self, AgentError> {
        let (trace_committer, existing) =
            TraceCommitter::resume(&context.session_id, &context.turn_id, trace_sink)
                .map_err(AgentError::from)?;
        let mut state = Self::new(context, None)?;
        state.trace_committer = trace_committer;
        if !existing.is_empty() {
            state.emitter = AgentTurnEmitter::from_existing_events_with_thread_id(
                &context.session_id,
                &context.turn_id,
                context.thread_id.clone(),
                &existing,
            );
        }
        Ok(state)
    }

    pub(super) fn new_for_result_append(
        context: &AgentTurnContext,
        trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
        existing_events: &[AgentRuntimeEventEnvelope],
    ) -> Result<Self, AgentError> {
        let mut state = Self::new_for_continuation(context, trace_sink)?;
        if !existing_events.is_empty() {
            state.emitter = AgentTurnEmitter::from_existing_events_with_thread_id(
                &context.session_id,
                &context.turn_id,
                context.thread_id.clone(),
                existing_events,
            );
        }
        Ok(state)
    }

    pub(super) fn transition_phase(
        &mut self,
        phase: AgentRuntimePhase,
        iteration: i64,
        trigger_event_name: &str,
    ) -> Result<(), AgentError> {
        let previous_phase = self.phase.clone();
        self.iteration = iteration;
        if previous_phase == phase {
            self.phase = phase;
            return Ok(());
        }
        self.phase = phase.clone();
        self.emit(PendingAgentEvent::new(
            AgentEventKind::PhaseChanged,
            serde_json::json!({
                "iteration": iteration,
                "previousPhase": previous_phase.as_str(),
                "nextPhase": self.phase.as_str(),
                "triggerEventName": trigger_event_name,
            }),
        ))?;
        self.emit_status_for_phase(iteration, trigger_event_name)
    }

    fn emit_status_for_phase(
        &mut self,
        iteration: i64,
        trigger_event_name: &str,
    ) -> Result<(), AgentError> {
        let Some(label) = runtime_status_label(&self.phase) else {
            return Ok(());
        };
        let is_blocking = matches!(
            self.phase,
            AgentRuntimePhase::AwaitingForm
                | AgentRuntimePhase::AwaitingSubagent
                | AgentRuntimePhase::Paused
        );
        self.emit(PendingAgentEvent::new(
            AgentEventKind::Status,
            serde_json::json!({
                "phase": self.phase.as_str(),
                "label": label,
                "detail": trigger_event_name,
                "iteration": iteration,
                "isBlocking": is_blocking,
            }),
        ))
    }

    pub(super) fn set_stop_reason(
        &mut self,
        stop_reason: AgentStopReason,
        iteration: i64,
        trigger_event_name: &str,
    ) -> Result<(), AgentError> {
        self.stop_reason = Some(stop_reason);
        let phase = stop_reason.runtime_phase();
        self.transition_phase(phase, iteration, trigger_event_name)
    }

    pub(super) fn active_checkpoint_payload(
        &self,
        status: &str,
    ) -> super::checkpoint_types::PhaseCheckpointInput {
        use super::checkpoint_types::{
            AgentCheckpointPayload, ExecutionCheckpoint, PhaseCheckpointInput,
        };
        PhaseCheckpointInput {
            iteration: Some(self.iteration),
            pending_tool_calls: self.pending_tool_calls.clone(),
            completed_tool_results: self.completed_tool_results.clone(),
            stop_reason: self.stop_reason,
            messages: Some(self.history.history()),
            payload: AgentCheckpointPayload::Execution(ExecutionCheckpoint {
                status: Some(status.into()),
                context_checkpoint: self.context_checkpoint.clone(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    pub(super) fn compacted_context_checkpoint(
        &self,
        replacement_history: &[Value],
        event: &super::usage::ContextWindowActionPayload,
    ) -> Result<AgentContextCheckpoint, AgentError> {
        let context_id = event
            .context_id
            .clone()
            .ok_or_else(|| AgentError::invalid_input("compaction action is missing contextId"))?;
        let parent = self
            .context_checkpoint
            .as_ref()
            .map(AgentContextCheckpoint::parent);
        let lineage = crate::threads::rollout::checkpoint_lineage::next_context_window_from_parent(
            &self.session_id,
            &context_id,
            parent.as_ref().or(self.source_context_checkpoint.as_ref()),
        );
        let history = super::AgentItemHistory::from_legacy_messages(replacement_history)?;
        Ok(AgentContextCheckpoint {
            schema_version: 1,
            context_id,
            source_version: context_messages_version(&self.history.messages()),
            history_version: self.history.history_version(),
            lineage,
            trigger: event.trigger.clone(),
            reason: event.reason.clone(),
            phase: event.phase.clone(),
            method: event.method.clone(),
            provider: event.provider.clone(),
            model: event.model.clone(),
            estimated_tokens_before: event.estimated_tokens_before,
            estimated_tokens_after: event.estimated_tokens_after,
            masked_tool_output_count: event.masked_tool_output_count,
            summary_request_count: event.summary_request_count,
            installed_replacement_history: history.clone(),
            replacement_history: history,
            checkpoint_stage: ContextCheckpointStage::Installed,
        })
    }

    pub(super) fn install_compacted_context(&mut self, checkpoint: AgentContextCheckpoint) {
        self.history
            .replace_history(&checkpoint.replacement_history);
        self.context_checkpoint = Some(checkpoint);
    }

    pub(super) fn finalized_context_checkpoint(
        &self,
        final_message: Option<Value>,
    ) -> Option<AgentContextCheckpoint> {
        let mut checkpoint = self.context_checkpoint.clone()?;
        let mut history = self.history.history();
        if let Some(message) = final_message {
            history.items.extend(
                super::AgentItemHistory::from_legacy_messages(&[message])
                    .expect("runtime final message must be a valid agent item")
                    .items,
            );
        }
        checkpoint.replacement_history = history;
        checkpoint.checkpoint_stage = ContextCheckpointStage::Finalized;
        Some(checkpoint)
    }

    pub(super) fn attach_context_checkpoint(
        &self,
        result: &mut AgentTurnResult,
        final_message: Option<Value>,
    ) {
        result.context_checkpoint = self.finalized_context_checkpoint(final_message);
    }

    pub(super) fn set_pending_tool_call(&mut self, tool_call: &NativeAgentToolCall) {
        self.phase = AgentRuntimePhase::ToolRunning;
        self.pending_tool_calls = vec![super::PendingAgentToolCall::new(tool_call)];
    }

    pub(super) fn set_queued_tool_calls(&mut self, tool_calls: &[(NativeAgentToolCall, &str)]) {
        self.phase = AgentRuntimePhase::ToolRunning;
        self.pending_tool_calls = tool_calls
            .iter()
            .map(|(call, mode)| super::PendingAgentToolCall {
                parallel_mode: Some((*mode).into()),
                status: Some(super::execution_payloads::PendingToolStatus::Queued),
                ..super::PendingAgentToolCall::new(call)
            })
            .collect();
    }

    pub(super) fn mark_pending_tool_running(&mut self, tool_call_id: &str) {
        let pending = self
            .pending_tool_calls
            .iter_mut()
            .find(|pending| pending.tool_call_id == tool_call_id)
            .expect("a running tool must already belong to the pending batch");
        pending.status = Some(super::execution_payloads::PendingToolStatus::Running);
    }

    pub(super) fn clear_pending_tool_calls(&mut self) {
        self.pending_tool_calls.clear();
    }

    pub(super) fn emit(&mut self, event: impl Into<PendingAgentEvent>) -> Result<(), AgentError> {
        let input = prepare_runtime_event_input(
            &self.session_id,
            &self.turn_id,
            &self.phase,
            runtime_event_timestamp(),
            event.into(),
        )?;
        let event = self.emitter.emit(input);
        self.append_trace_event(&event)
    }

    pub(super) fn emit_hook_evaluation(
        &mut self,
        invocation: &AgentHookInvocation,
        evaluation: &AgentHookEvaluation,
    ) -> Result<(), AgentError> {
        if evaluation.decisions.is_empty() && evaluation.command_runs.is_empty() {
            return Ok(());
        }
        self.emit(PendingAgentEvent::new(
            AgentEventKind::HookDecision,
            evaluation.event_payload(invocation),
        ))
    }

    pub(super) fn apply_hook_evaluation(
        &mut self,
        context: &mut AgentTurnContext,
        evaluation: &AgentHookEvaluation,
    ) -> Result<(), AgentError> {
        self.apply_additional_context(context, evaluation.additional_context.clone(), false)
    }

    pub(super) fn apply_pending_tool_hook_context(
        &mut self,
        context: &mut AgentTurnContext,
    ) -> Result<(), AgentError> {
        let pending = context.take_pending_tool_hook_context();
        self.apply_additional_context(context, pending, true)
    }

    fn apply_additional_context(
        &mut self,
        context: &mut AgentTurnContext,
        additional_contexts: Vec<String>,
        defer_response_items: bool,
    ) -> Result<(), AgentError> {
        for additional_context in additional_contexts {
            let message = serde_json::json!({
                "role": "developer",
                "content": additional_context,
            });
            self.history.record_message(message.clone())?;
            if defer_response_items {
                context.defer_hook_response_item(message);
            } else if let Some(response_items) = context.responses_input_items.as_mut() {
                response_items.push(message);
            }
        }
        Ok(())
    }

    pub(super) fn emit_pending_hook_evaluations(
        &mut self,
        context: &AgentTurnContext,
    ) -> Result<(), AgentError> {
        for (invocation, evaluation) in context.drain_hook_evaluations() {
            self.emit_hook_evaluation(&invocation, &evaluation)?;
        }
        Ok(())
    }

    pub(super) fn emit_turn_started(
        &mut self,
        context: &AgentTurnContext,
    ) -> Result<(), AgentError> {
        let current = current_user_message(&context.messages);
        let message_id = current
            .as_ref()
            .and_then(|message| string_field(message, "messageId"))
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|message| string_field(message, "message_id"))
            })
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|message| string_field(message, "id"))
            })
            .unwrap_or_else(|| format!("{}:user", context.turn_id));
        let content = current.as_ref().map(user_message_text).unwrap_or_default();
        let reference_payloads = current
            .as_ref()
            .map(|message| user_reference_payloads(context, message, &message_id))
            .unwrap_or_default();
        let references = current
            .as_ref()
            .and_then(|message| message.get("references"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let client_event_id = current
            .as_ref()
            .and_then(|message| string_field(message, "clientEventId"))
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|message| string_field(message, "client_event_id"))
            })
            .or_else(|| string_field(&context.metadata, "clientEventId"))
            .or_else(|| string_field(&context.metadata, "client_event_id"));
        let mut payload = serde_json::json!({
            "experiments": context.settings.experiments,
            "clientEventId": client_event_id,
            "userMessageId": message_id,
            "userMessage": {
                "id": message_id,
                "clientEventId": client_event_id,
                "content": content,
                "references": references.clone()
            }
        });
        if client_event_id.is_none() {
            payload
                .as_object_mut()
                .expect("turn-started payload must be an object")
                .remove("clientEventId");
            payload["userMessage"]
                .as_object_mut()
                .expect("turn-started user message must be an object")
                .remove("clientEventId");
        }
        if references.is_empty() {
            payload["userMessage"]
                .as_object_mut()
                .expect("turn-started user message must be an object")
                .remove("references");
        }
        self.emit(PendingAgentEvent::new(AgentEventKind::TurnStarted, payload))?;
        for payload in reference_payloads {
            self.emit(PendingAgentEvent::new(
                AgentEventKind::FileReference,
                payload,
            ))?;
        }
        Ok(())
    }

    pub(super) fn emit_thread_command_acknowledgement(
        &mut self,
        context: &AgentTurnContext,
    ) -> Result<(), AgentError> {
        let Some(command) = context.metadata.get("_threadCommand") else {
            return Ok(());
        };
        let command_id = string_field(command, "commandId")
            .ok_or_else(|| "Thread command metadata is missing commandId".to_string())?;
        let command_kind = string_field(command, "commandKind")
            .ok_or_else(|| "Thread command metadata is missing commandKind".to_string())?;
        self.emit(
            PendingAgentEvent::new(
                AgentEventKind::CommandAcknowledged,
                serde_json::json!({
                    "commandId": command_id,
                    "commandKind": command_kind,
                    "commandStatus": "acknowledged",
                    "message": "Agent command acknowledged",
                    "form": command.get("form").cloned().unwrap_or(Value::Null),
                    "operation": command.get("operation").cloned().unwrap_or(Value::Null),
                    "source": command.get("source").cloned().unwrap_or(Value::Null),
                    "target": command.get("target").cloned().unwrap_or(Value::Null),
                }),
            )
            .with_item_id(Some(format!("{}:command-ack:{}", self.turn_id, command_id))),
        )
    }

    pub(super) fn runtime_events(&self) -> Vec<AgentRuntimeEventEnvelope> {
        self.emitter.events().to_vec()
    }

    pub(super) fn take_runtime_events(&mut self) -> Vec<AgentRuntimeEventEnvelope> {
        self.emitter.take_events()
    }

    pub(super) fn drain_pending_guidance(&mut self) -> Result<Option<Value>, AgentError> {
        let Some(message) = self.pending_guidance_message.take() else {
            return Ok(None);
        };
        self.history.record_message(message.clone())?;
        Ok(Some(message))
    }

    pub(super) fn record_usage(
        &mut self,
        context: &AgentTurnContext,
        iteration: i64,
        model_call_id: &str,
        provider_usage: Option<Value>,
        estimated_context_tokens: i64,
        model_timing: crate::agent::runtime_protocol::AgentModelTiming,
    ) -> Result<(), AgentError> {
        let normalized_provider_usage = crate::token_usage::normalize_provider_token_usage(
            provider_usage.as_ref().unwrap_or(&Value::Null),
        )?;
        let provider_usage = provider_usage.unwrap_or_else(|| serde_json::json!({}));
        let cumulative_before = latest_cumulative_usage_tokens(&self.usage).unwrap_or_else(|| {
            self.usage
                .iter()
                .filter_map(usage_context_used_tokens)
                .fold(0i64, i64::saturating_add)
        });
        let usage = enrich_usage_with_context_window(
            context,
            normalized_provider_usage.as_ref(),
            estimated_context_tokens,
            cumulative_before,
        );
        let model_context_window = usage
            .get("contextWindowTokens")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0);
        let token_info = if let Some(token_usage) = normalized_provider_usage {
            self.history
                .update_token_info(token_usage, model_context_window);
            self.history.token_info()
        } else {
            None
        };
        self.usage.push(usage.clone());
        self.emit(ModelOutputEvent::ModelCallCompleted(serde_json::json!({
            "iteration": iteration,
            "modelCallId": model_call_id,
            "tokenUsage": provider_usage.clone(),
        })))?;
        if let Some(token_info) = token_info {
            self.emit(PendingAgentEvent::new(
                AgentEventKind::TokenCount,
                serde_json::json!({
                    "iteration": iteration,
                    "modelCallId": model_call_id,
                    "info": token_info,
                }),
            ))?;
        }
        self.emit(ModelOutputEvent::Usage(serde_json::json!({
            "iteration": iteration,
            "modelCallId": model_call_id,
            "usage": usage,
            "providerUsage": provider_usage,
            "modelTiming": model_timing,
        })))
    }
}

fn context_messages_version(messages: &[Value]) -> String {
    let encoded = serde_json::to_vec(messages).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(encoded))
}

pub(super) fn user_message_text(message: &Value) -> String {
    let content = message.get("content").or_else(|| message.get("text"));
    if let Some(text) = content.and_then(Value::as_str) {
        return text.to_string();
    }
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn user_reference_payloads(
    context: &AgentTurnContext,
    message: &Value,
    message_id: &str,
) -> Vec<Value> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, part)| {
            let part_type = part.get("type").and_then(Value::as_str)?;
            let (path, reference_kind) = match part_type {
                "file" | "input_file" => (
                    part.get("path")
                        .or_else(|| part.get("file_id"))
                        .or_else(|| part.get("filename"))
                        .and_then(Value::as_str)?
                        .to_string(),
                    "file",
                ),
                "image_url" | "input_image" => {
                    let image = part.get("image_url").or_else(|| part.get("url"))?;
                    let url = image
                        .as_str()
                        .or_else(|| image.get("url").and_then(Value::as_str))?;
                    (url.to_string(), "image")
                }
                _ => return None,
            };
            Some(serde_json::json!({
                "turnId": context.turn_id,
                "sessionId": context.session_id,
                "referenceId": format!("{message_id}:reference:{index}"),
                "messageId": message_id,
                "path": path,
                "mimeType": part.get("mime_type").or_else(|| part.get("mimeType")).cloned().unwrap_or(Value::Null),
                "referenceKind": reference_kind,
            }))
        })
        .collect()
}

pub(super) fn current_user_message(history: &super::AgentItemHistory) -> Option<Value> {
    history.items.iter().rev().find_map(|item| {
        let super::AgentItem::UserMessage(message) = item else {
            return None;
        };
        let mut value = item.to_legacy_message().expect("user item must serialize");
        if let Some(id) = &message.id {
            value["messageId"] = id.clone().into();
        }
        if let Some(id) = &message.client_event_id {
            value["clientEventId"] = id.clone().into();
        }
        Some(value)
    })
}
