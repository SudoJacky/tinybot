use super::continuations::guidance_continuation_message;
use super::events::{
    legacy_result_events_from_runtime_events, runtime_event_item_id, runtime_event_source,
    runtime_event_timestamp, runtime_event_visibility, runtime_status_label,
};
use super::hooks::AgentHookEvaluation;
use super::item_event_projection::attach_agent_item;
use super::usage::{
    enrich_usage_with_context_window, latest_cumulative_usage_tokens, usage_context_used_tokens,
};
use super::{
    string_field, AgentHookInvocation, NativeAgentEvent, NativeAgentRunContext,
    NativeAgentToolCall, NativeAgentTraceSink,
};
use crate::agent_loop_runtime_protocol::{
    project_timeline_patch, AgentRunEmitter, AgentRuntimeEventAppendInput,
    AgentRuntimeEventEnvelope, AgentRuntimeEventSource, AgentRuntimeEventVisibility,
    AgentRuntimePhase,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct NativeAgentRunState {
    pub(super) run_id: String,
    pub(super) session_id: String,
    pub(super) phase: AgentRuntimePhase,
    pub(super) iteration: i64,
    pub(super) max_iterations: i64,
    pub(super) pending_tool_calls: Vec<Value>,
    pub(super) completed_tool_results: Vec<Value>,
    pub(super) messages: Vec<Value>,
    emitter: AgentRunEmitter,
    usage: Vec<Value>,
    pub(super) tools_used: Vec<String>,
    stop_reason: Option<String>,
    pending_guidance_message: Option<Value>,
    trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
}

impl NativeAgentRunState {
    pub(super) fn new(
        context: &NativeAgentRunContext,
        trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    ) -> Self {
        Self {
            run_id: context.run_id.clone(),
            session_id: context.session_id.clone(),
            phase: AgentRuntimePhase::Queued,
            iteration: 0,
            max_iterations: context.max_iterations,
            pending_tool_calls: Vec::new(),
            completed_tool_results: Vec::new(),
            messages: context.messages.clone(),
            emitter: AgentRunEmitter::new_with_trace_context(
                &context.session_id,
                context.trace_context.clone(),
            ),
            usage: Vec::new(),
            tools_used: Vec::new(),
            stop_reason: None,
            pending_guidance_message: guidance_continuation_message(&context.metadata),
            trace_sink,
        }
    }

    fn append_trace_event(&self, event: &AgentRuntimeEventEnvelope) {
        if let Some(trace_sink) = self.trace_sink.as_ref() {
            if let Err(error) = trace_sink.append_trace_event(&self.session_id, &self.run_id, event)
            {
                crate::runtime::observability::global_agent_runtime_metrics()
                    .increment("trace.sink.failed");
                eprintln!(
                    "native agent trace sink failed for run {} event {}: {}",
                    self.run_id, event.event_id, error
                );
            }
            match project_timeline_patch(&self.session_id, &self.run_id, self.emitter.events()) {
                Ok(Some(patch)) => {
                    if let Err(error) =
                        trace_sink.append_timeline_patch(&self.session_id, &self.run_id, &patch)
                    {
                        crate::runtime::observability::global_agent_runtime_metrics()
                            .increment("timeline.patch.sink.failed");
                        eprintln!(
                            "canonical timeline patch sink failed for run {} item {} revision {}: {}",
                            self.run_id, patch.item.item_id, patch.item.revision, error
                        );
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    crate::runtime::observability::global_agent_runtime_metrics()
                        .increment("timeline.patch.projection.failed");
                    eprintln!(
                        "canonical timeline patch projection failed for run {} event {}: {}",
                        self.run_id, event.event_id, error
                    );
                }
            }
        }
    }

    pub(super) fn new_for_continuation(
        context: &NativeAgentRunContext,
        trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    ) -> Result<Self, String> {
        let existing = trace_sink
            .as_ref()
            .map(|sink| sink.load_runtime_events(&context.session_id, &context.run_id))
            .transpose()?
            .unwrap_or_default();
        let mut state = Self::new(context, trace_sink);
        if !existing.is_empty() {
            state.emitter = AgentRunEmitter::from_existing_events_with_thread_id(
                &context.session_id,
                &context.run_id,
                context.thread_id.clone(),
                &existing,
            );
        }
        Ok(state)
    }

    pub(super) fn transition_phase(
        &mut self,
        phase: AgentRuntimePhase,
        iteration: i64,
        trigger_event_name: &str,
    ) {
        let previous_phase = self.phase.clone();
        self.iteration = iteration;
        if previous_phase == phase {
            self.phase = phase;
            return;
        }
        self.phase = phase.clone();
        let event = self.emitter.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.phase.changed".to_string(),
            phase,
            timestamp: runtime_event_timestamp(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::Debug,
            payload: serde_json::json!({
                "runId": self.run_id,
                "sessionId": self.session_id,
                "iteration": iteration,
                "previousPhase": previous_phase.as_str(),
                "nextPhase": self.phase.as_str(),
                "triggerEventName": trigger_event_name,
            }),
        });
        self.append_trace_event(&event);
        self.emit_status_for_phase(iteration, trigger_event_name);
    }

    fn emit_status_for_phase(&mut self, iteration: i64, trigger_event_name: &str) {
        let Some(label) = runtime_status_label(&self.phase) else {
            return;
        };
        let is_blocking = matches!(
            self.phase,
            AgentRuntimePhase::AwaitingApproval
                | AgentRuntimePhase::AwaitingForm
                | AgentRuntimePhase::AwaitingSubagent
        );
        let event = self.emitter.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.status".to_string(),
            phase: self.phase.clone(),
            timestamp: runtime_event_timestamp(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: serde_json::json!({
                "runId": self.run_id.clone(),
                "sessionId": self.session_id.clone(),
                "phase": self.phase.as_str(),
                "label": label,
                "detail": trigger_event_name,
                "iteration": iteration,
                "isBlocking": is_blocking,
            }),
        });
        self.append_trace_event(&event);
    }

    pub(super) fn set_stop_reason(
        &mut self,
        stop_reason: &str,
        iteration: i64,
        trigger_event_name: &str,
    ) {
        self.stop_reason = Some(stop_reason.to_string());
        let phase = match stop_reason {
            "final_response" => AgentRuntimePhase::Completed,
            "cancelled" => AgentRuntimePhase::Cancelled,
            "awaiting_approval" => AgentRuntimePhase::AwaitingApproval,
            "awaiting_form" => AgentRuntimePhase::AwaitingForm,
            _ => AgentRuntimePhase::Failed,
        };
        self.transition_phase(phase, iteration, trigger_event_name);
    }

    pub(super) fn active_checkpoint_payload(&self, status: &str) -> Value {
        serde_json::json!({
            "status": status,
            "iteration": self.iteration,
            "maxIterations": self.max_iterations,
            "pendingToolCalls": self.pending_tool_calls,
            "completedToolResults": self.completed_tool_results,
            "stopReason": self.stop_reason,
        })
    }

    pub(super) fn set_pending_tool_call(&mut self, tool_call: &NativeAgentToolCall) {
        self.phase = AgentRuntimePhase::ToolRunning;
        self.pending_tool_calls = vec![serde_json::json!({
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "argumentsJson": tool_call.arguments_json,
        })];
    }

    pub(super) fn set_queued_tool_calls(&mut self, tool_calls: &[(NativeAgentToolCall, &str)]) {
        self.phase = AgentRuntimePhase::ToolRunning;
        self.pending_tool_calls = tool_calls
            .iter()
            .map(|(tool_call, parallel_mode)| {
                serde_json::json!({
                    "toolCallId": tool_call.id,
                    "toolName": tool_call.name,
                    "argumentsJson": tool_call.arguments_json,
                    "parallelMode": parallel_mode,
                    "status": "queued",
                })
            })
            .collect();
    }

    pub(super) fn mark_pending_tool_running(&mut self, tool_call_id: &str) {
        for pending_tool_call in &mut self.pending_tool_calls {
            if pending_tool_call.get("toolCallId").and_then(Value::as_str) == Some(tool_call_id) {
                pending_tool_call["status"] = Value::String("running".to_string());
                break;
            }
        }
    }

    pub(super) fn clear_pending_tool_calls(&mut self) {
        self.pending_tool_calls.clear();
    }

    pub(super) fn emit_event(&mut self, event_name: &str, payload: Value) {
        let payload = attach_agent_item(event_name, payload);
        let event = self.emitter.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: runtime_event_item_id(event_name, &payload),
            event_name: event_name.to_string(),
            phase: AgentRuntimePhase::for_legacy_event(event_name),
            timestamp: runtime_event_timestamp(),
            source: runtime_event_source(event_name),
            visibility: runtime_event_visibility(event_name),
            payload,
        });
        self.append_trace_event(&event);
    }

    pub(super) fn emit_native_event(&mut self, event: NativeAgentEvent) {
        self.emit_event(&event.event_name, event.payload);
    }

    pub(super) fn emit_hook_evaluation(
        &mut self,
        invocation: &AgentHookInvocation,
        evaluation: &AgentHookEvaluation,
    ) {
        if evaluation.decisions.is_empty() {
            return;
        }
        self.emit_event("agent.hook.decision", evaluation.event_payload(invocation));
    }

    pub(super) fn emit_turn_started(&mut self, context: &NativeAgentRunContext) {
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
            .unwrap_or_else(|| format!("{}:user", context.run_id));
        let content = current.as_ref().map(user_message_text).unwrap_or_default();
        let reference_payloads = current
            .as_ref()
            .map(|message| user_reference_payloads(context, message, &message_id))
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
        let event = self.emitter.user_turn_started(
            runtime_event_timestamp(),
            Some(message_id),
            client_event_id,
            content,
        );
        self.append_trace_event(&event);
        for payload in reference_payloads {
            self.emit_event("agent.file.reference", payload);
        }
    }

    pub(super) fn runtime_events(&self) -> Vec<AgentRuntimeEventEnvelope> {
        self.emitter.events().to_vec()
    }

    pub(super) fn legacy_events(&self) -> Vec<NativeAgentEvent> {
        legacy_result_events_from_runtime_events(self.emitter.events())
    }

    pub(super) fn take_runtime_events(&mut self) -> Vec<AgentRuntimeEventEnvelope> {
        self.emitter.take_events()
    }

    pub(super) fn drain_pending_guidance(&mut self) -> Option<Value> {
        let message = self.pending_guidance_message.take()?;
        self.messages.push(message.clone());
        Some(message)
    }

    pub(super) fn record_usage(
        &mut self,
        context: &NativeAgentRunContext,
        iteration: i64,
        usage: Value,
        estimated_context_tokens: i64,
    ) {
        let cumulative_before = latest_cumulative_usage_tokens(&self.usage).unwrap_or_else(|| {
            self.usage
                .iter()
                .filter_map(usage_context_used_tokens)
                .fold(0i64, i64::saturating_add)
        });
        let usage = enrich_usage_with_context_window(
            context,
            usage,
            estimated_context_tokens,
            cumulative_before,
        );
        self.usage.push(usage.clone());
        self.emit_event(
            "agent.usage",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "usage": usage,
            }),
        );
    }
}

fn user_message_text(message: &Value) -> String {
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
    context: &NativeAgentRunContext,
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
                "runId": context.run_id,
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

fn current_user_message(messages: &[Value]) -> Option<Value> {
    messages
        .iter()
        .rev()
        .find(|message| {
            message
                .get("role")
                .and_then(Value::as_str)
                .map(|role| role == "user")
                .unwrap_or(false)
        })
        .cloned()
}
