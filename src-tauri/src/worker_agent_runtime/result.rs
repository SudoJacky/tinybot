use super::checkpoint::save_phase_checkpoint;
use super::events::{
    event, legacy_result_events_from_runtime_events, runtime_event_source, runtime_event_timestamp,
    runtime_event_visibility,
};
use super::item_event_projection::attach_agent_item;
use super::{NativeAgentRunContext, NativeAgentRuntimeServices, NativeAgentTraceSink};
use crate::agent_loop_runtime_protocol::{
    AgentRunEmitter, AgentRuntimeEventAppendInput, AgentRuntimeEventEnvelope,
    AgentRuntimeEventSource, AgentRuntimeEventVisibility, AgentRuntimePhase,
};
use serde_json::Value;
use std::sync::Arc;

pub(super) fn error_result(
    run_id: &str,
    session_id: &str,
    stop_reason: &str,
    message: &str,
) -> Value {
    let events = vec![event(
        "agent.error",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "stopReason": stop_reason,
            "message": message,
            "error": message,
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "messages": [],
        "toolsUsed": [],
        "error": message,
        "events": events,
    })
}

pub(super) fn cancelled_result(
    services: &NativeAgentRuntimeServices,
    run_id: &str,
    session_id: &str,
    checkpoint: Value,
) -> Value {
    let events = vec![event(
        "agent.cancelled",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "commandId": services.cancellations.command_id(run_id),
            "cancelled": true,
            "stopReason": "cancelled",
            "error": "cancelled",
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "error": "cancelled",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
    })
}

pub(super) fn cancelled_run_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    mut runtime_events: Vec<AgentRuntimeEventEnvelope>,
    tools_used: Vec<String>,
    completed_tool_results: Vec<Value>,
    iteration: i64,
) -> Value {
    let checkpoint = save_phase_checkpoint(
        services,
        context,
        "cancelled",
        serde_json::json!({
            "cancelled": true,
            "iteration": iteration,
            "completedToolResults": completed_tool_results.clone(),
            "stopReason": "cancelled",
        }),
    );
    let mut emitter = AgentRunEmitter::from_existing_events_with_thread_id(
        &context.session_id,
        &context.run_id,
        context.thread_id.clone(),
        &runtime_events,
    );
    runtime_events.push(emitter.cancelled_with_payload(
        runtime_event_timestamp(),
        "cancelled",
        attach_agent_item(
            "agent.cancelled",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "commandId": services.cancellations.command_id(&context.run_id),
                "cancelled": true,
                "stopReason": "cancelled",
                "error": "cancelled",
            }),
        ),
    ));
    let events = legacy_result_events_from_runtime_events(&runtime_events);
    serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "messages": [],
        "toolsUsed": tools_used,
        "completedToolResults": completed_tool_results,
        "error": "cancelled",
        "checkpoint": checkpoint,
        "events": events,
        "runtimeEvents": runtime_events,
    })
}

pub(super) fn waiting_runtime_events(
    context: &NativeAgentRunContext,
    waiting_phase: AgentRuntimePhase,
    trigger_event_name: &str,
    events: Vec<(&'static str, Option<String>, AgentRuntimePhase, Value)>,
) -> Vec<AgentRuntimeEventEnvelope> {
    let mut emitter =
        AgentRunEmitter::new_with_trace_context(&context.session_id, context.trace_context.clone());
    if let Some(message) = super::state::current_user_message(&context.messages) {
        let message_id = message
            .get("messageId")
            .or_else(|| message.get("message_id"))
            .or_else(|| message.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}:user", context.run_id));
        let client_event_id = message
            .get("clientEventId")
            .or_else(|| message.get("client_event_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let references = message
            .get("references")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        emitter.user_turn_started(
            runtime_event_timestamp(),
            Some(message_id),
            client_event_id,
            super::state::user_message_text(&message),
            references,
        );
    }
    emitter.emit(AgentRuntimeEventAppendInput {
        parent_turn_id: None,
        item_id: None,
        event_name: "agent.phase.changed".to_string(),
        phase: waiting_phase.clone(),
        timestamp: runtime_event_timestamp(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::Debug,
        payload: serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": 0,
            "previousPhase": "planning",
            "nextPhase": waiting_phase.as_str(),
            "triggerEventName": trigger_event_name,
        }),
    });
    for (event_name, item_id, phase, payload) in events {
        let payload = attach_agent_item(event_name, payload);
        emitter.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id,
            event_name: event_name.to_string(),
            phase,
            timestamp: runtime_event_timestamp(),
            source: runtime_event_source(event_name),
            visibility: runtime_event_visibility(event_name),
            payload,
        });
    }
    emitter.take_events()
}

pub(super) fn append_runtime_events_to_sink(
    context: &NativeAgentRunContext,
    trace_sink: Option<&Arc<dyn NativeAgentTraceSink>>,
    events: &[AgentRuntimeEventEnvelope],
) {
    if let Some(trace_sink) = trace_sink {
        let existing = match trace_sink.load_runtime_events(&context.session_id, &context.run_id) {
            Ok(existing) => existing,
            Err(error) => {
                eprintln!(
                    "canonical timeline history load failed for run {}: {}",
                    context.run_id, error
                );
                Vec::new()
            }
        };
        let mut projector =
            match crate::agent_loop_runtime_protocol::AgentTimelineProjector::from_events(
                &context.session_id,
                &context.run_id,
                &existing,
            ) {
                Ok(projector) => projector,
                Err(error) => {
                    eprintln!(
                        "canonical timeline history projection failed for run {}: {}",
                        context.run_id, error
                    );
                    return;
                }
            };
        for event in events {
            let _ = trace_sink.append_trace_event(&context.session_id, &context.run_id, event);
            match projector.apply_event(event) {
                Ok(Some(patch)) => {
                    if let crate::agent_loop_runtime_protocol::AgentTurnItemData::AssistantMessage {
                        model_call_id,
                        phase,
                        ..
                    } = &patch.item.data
                    {
                        if *phase
                            != crate::agent_loop_runtime_protocol::AgentAssistantMessagePhase::Unknown
                        {
                            let classification_source = event
                                .payload
                                .get("classificationSource")
                                .and_then(Value::as_str)
                                .unwrap_or_else(|| {
                                    if event.event_name == "agent.message.phase" {
                                        "provider"
                                    } else {
                                        "runtime_projection"
                                    }
                                });
                            eprintln!(
                                "agent assistant phase classified: {}",
                                serde_json::json!({
                                    "sessionId": context.session_id,
                                    "runId": context.run_id,
                                    "turnId": patch.item.turn_id,
                                    "modelCallId": model_call_id,
                                    "itemId": patch.item.item_id,
                                    "phase": phase,
                                    "source": classification_source,
                                    "sequence": patch.item.sequence,
                                    "revision": patch.item.revision,
                                })
                            );
                        }
                    }
                    let _ = trace_sink.append_timeline_patch(
                        &context.session_id,
                        &context.run_id,
                        &patch,
                    );
                }
                Ok(None) => {}
                Err(error) => eprintln!(
                    "canonical timeline patch projection failed for run {} event {}: {}",
                    context.run_id, event.event_id, error
                ),
            }
        }
    }
}

pub(super) fn event_value(event_name: &str, payload: Value) -> Value {
    serde_json::json!({
        "eventName": event_name,
        "payload": payload,
    })
}
