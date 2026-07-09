use super::checkpoint::{maybe_emit_checkpoint, save_phase_checkpoint};
use super::continuations::{
    maybe_approval_resume_result, maybe_awaiting_approval_result, maybe_awaiting_form_result,
    maybe_form_submit_result,
};
use super::result::{cancelled_result, cancelled_run_result, error_result};
use super::state::NativeAgentRunState;
use super::tool_dispatcher::native_tool_is_permitted;
use super::tool_projection::{
    assistant_tool_calls_message, completed_tool_result_entry, normalize_tool_result_for_context,
    subagent_activity_events_from_tool_result, subagent_link_event_from_tool_result,
    tool_observation_content, tool_observation_message,
};
use super::usage::{
    context_window_action_payload, context_window_projection, context_with_projected_messages,
    estimate_context_tokens_for_request,
};
use super::{
    bool_field, NativeAgentProviderStreamEvent, NativeAgentRunContext, NativeAgentRuntimeServices,
};
use crate::agent_loop_runtime_protocol::AgentRuntimePhase;
use serde_json::Value;

pub fn run_native_agent_turn_with_config(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
) -> Result<Value, String> {
    let mut context = NativeAgentRunContext::from_spec(spec, config_snapshot);
    context.attach_cancellation(services.cancellations.clone());
    if context.max_iterations <= 0 {
        return Ok(error_result(
            &context.run_id,
            &context.session_id,
            "max_iterations",
            "Rust agent runtime reached max iterations before provider call.",
        ));
    }
    if services.cancellations.is_cancelled(&context.run_id)
        || bool_field(&context.metadata, "fakeCancel")
    {
        let checkpoint = save_phase_checkpoint(
            services,
            &context,
            "cancelled",
            serde_json::json!({ "cancelled": true }),
        );
        return Ok(cancelled_result(
            &context.run_id,
            &context.session_id,
            checkpoint,
        ));
    }
    if let Some(result) = maybe_awaiting_approval_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_approval_resume_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_awaiting_form_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_form_submit_result(services, &context) {
        return Ok(result);
    }
    if context.messages.is_empty() {
        return Ok(error_result(
            &context.run_id,
            &context.session_id,
            "invalid_request",
            "Rust agent runtime requires at least one user input or chat message.",
        ));
    }

    let mut state = NativeAgentRunState::new(&context, services.trace_sink.clone());
    state.transition_phase(
        AgentRuntimePhase::HydratingHistory,
        0,
        "agent.history.hydrated",
    );
    state.transition_phase(AgentRuntimePhase::Planning, 0, "agent.turn.started");
    state.emit_turn_started(&context);
    for iteration in 0..context.max_iterations {
        state.transition_phase(AgentRuntimePhase::CallingModel, iteration, "provider_call");
        if services.cancellations.is_cancelled(&context.run_id) {
            state.transition_phase(AgentRuntimePhase::Cancelled, iteration, "agent.cancelled");
            return Ok(cancelled_run_result(
                services,
                &context,
                state.take_runtime_events(),
                std::mem::take(&mut state.tools_used),
                std::mem::take(&mut state.completed_tool_results),
                iteration,
            ));
        }
        save_phase_checkpoint(
            services,
            &context,
            state.phase.as_str(),
            state.active_checkpoint_payload("running"),
        );
        context.messages = state.messages.clone();
        context.spec["messages"] = Value::Array(state.messages.clone());
        let projection = context_window_projection(&context);
        if let Some(action) = projection.action.as_ref() {
            let payload = context_window_action_payload(&context, iteration, action);
            state.emit_event(action.event_name, payload);
        }
        let provider_context = context_with_projected_messages(&context, projection.messages);
        let estimated_context_tokens = estimate_context_tokens_for_request(&provider_context);
        let mut provider_streamed_content = false;
        let mut provider_streamed_reasoning = false;
        let provider_response = {
            let mut stream_observer = |event: NativeAgentProviderStreamEvent| match event {
                NativeAgentProviderStreamEvent::ContentDelta(delta) => {
                    if delta.is_empty() {
                        return;
                    }
                    provider_streamed_content = true;
                    state.transition_phase(
                        AgentRuntimePhase::StreamingModel,
                        iteration,
                        "agent.delta",
                    );
                    state.emit_event(
                        "agent.delta",
                        serde_json::json!({
                            "runId": context.run_id,
                            "sessionId": context.session_id,
                            "iteration": iteration,
                            "delta": delta,
                        }),
                    );
                }
                NativeAgentProviderStreamEvent::ReasoningDelta(delta) => {
                    if delta.is_empty() {
                        return;
                    }
                    provider_streamed_reasoning = true;
                    state.transition_phase(
                        AgentRuntimePhase::StreamingModel,
                        iteration,
                        "agent.reasoning_delta",
                    );
                    state.emit_event(
                        "agent.reasoning_delta",
                        serde_json::json!({
                            "runId": context.run_id,
                            "sessionId": context.session_id,
                            "iteration": iteration,
                            "delta": delta,
                        }),
                    );
                }
            };
            services
                .provider
                .complete_streaming(&provider_context, &mut stream_observer)
        };
        let provider_response = match provider_response {
            Ok(response) => response,
            Err(error) => {
                state.set_stop_reason("provider_error", iteration, "agent.error");
                state.emit_event(
                    "agent.error",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "stopReason": "provider_error",
                        "message": error,
                        "error": error,
                    }),
                );
                let runtime_events = state.runtime_events();
                let events = state.legacy_events();
                return Ok(serde_json::json!({
                    "runtime": "rust",
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "finalContent": "",
                    "stopReason": "provider_error",
                    "messages": [],
                    "toolsUsed": state.tools_used,
                    "completedToolResults": state.completed_tool_results,
                    "error": error,
                    "events": events,
                    "runtimeEvents": runtime_events,
                }));
            }
        };

        let current_phase = state.phase.as_str().to_string();
        maybe_emit_checkpoint(services, &context, &mut state, &current_phase);
        if let Some(reasoning_delta) = provider_response
            .reasoning_delta
            .clone()
            .filter(|_| !provider_streamed_reasoning)
        {
            state.transition_phase(
                AgentRuntimePhase::StreamingModel,
                iteration,
                "agent.reasoning_delta",
            );
            state.emit_event(
                "agent.reasoning_delta",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "iteration": iteration,
                    "delta": reasoning_delta,
                }),
            );
        }
        if context.stream
            && !provider_response.final_content.is_empty()
            && !provider_streamed_content
        {
            state.transition_phase(AgentRuntimePhase::StreamingModel, iteration, "agent.delta");
            state.emit_event(
                "agent.delta",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "iteration": iteration,
                    "delta": provider_response.final_content,
                }),
            );
        }

        if !provider_response.tool_calls.is_empty() {
            let tool_calls = provider_response.tool_calls;
            state.transition_phase(
                AgentRuntimePhase::ToolCalling,
                iteration,
                "agent.tool_call.delta",
            );
            state.messages.push(assistant_tool_calls_message(
                &provider_response.final_content,
                &tool_calls,
            ));
            for tool_call in tool_calls {
                state.emit_event(
                    "agent.tool_call.delta",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                        "argumentsDelta": tool_call.arguments_json,
                    }),
                );
                if !native_tool_is_permitted(&tool_call.name) {
                    state.set_stop_reason("policy_denied", iteration, "agent.error");
                    state.emit_event(
                        "agent.error",
                        serde_json::json!({
                            "runId": context.run_id,
                            "sessionId": context.session_id,
                            "iteration": iteration,
                            "stopReason": "policy_denied",
                            "error": format!("native tool `{}` is not permitted by Rust capability policy", tool_call.name),
                            "toolCallId": tool_call.id,
                            "toolName": tool_call.name,
                            "name": tool_call.name,
                        }),
                    );
                    services
                        .checkpoints
                        .clear_for_run(&context.session_id, &context.run_id);
                    let runtime_events = state.runtime_events();
                    let events = state.legacy_events();
                    return Ok(serde_json::json!({
                        "runtime": "rust",
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "finalContent": "",
                        "stopReason": "policy_denied",
                        "messages": [],
                        "toolsUsed": state.tools_used,
                        "completedToolResults": state.completed_tool_results,
                        "error": format!("native tool `{}` is not permitted by Rust capability policy", tool_call.name),
                        "events": events,
                        "runtimeEvents": runtime_events,
                    }));
                }
                if services.cancellations.is_cancelled(&context.run_id) {
                    state.transition_phase(
                        AgentRuntimePhase::Cancelled,
                        iteration,
                        "agent.cancelled",
                    );
                    return Ok(cancelled_run_result(
                        services,
                        &context,
                        state.take_runtime_events(),
                        std::mem::take(&mut state.tools_used),
                        std::mem::take(&mut state.completed_tool_results),
                        iteration,
                    ));
                }
                state.tools_used.push(tool_call.name.clone());
                state.transition_phase(
                    AgentRuntimePhase::ToolRunning,
                    iteration,
                    "agent.tool.start",
                );
                state.emit_event(
                    "agent.tool.start",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                        "detailId": format!("tool:{}", tool_call.id),
                        "status": "running",
                    }),
                );
                state.set_pending_tool_call(&tool_call);
                save_phase_checkpoint(
                    services,
                    &context,
                    state.phase.as_str(),
                    serde_json::json!({
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "argumentsJson": tool_call.arguments_json,
                        "pendingToolCalls": state.pending_tool_calls.clone(),
                        "completedToolResults": state.completed_tool_results.clone(),
                    }),
                );
                let result = match services.tools.dispatch(&context, &tool_call) {
                    Ok(result) => result,
                    Err(error) => {
                        state.set_stop_reason("tool_error", iteration, "agent.error");
                        state.emit_event(
                            "agent.error",
                            serde_json::json!({
                                "runId": context.run_id,
                                "sessionId": context.session_id,
                                "iteration": iteration,
                                "stopReason": "tool_error",
                                "error": error,
                                "toolCallId": tool_call.id,
                                "toolName": tool_call.name,
                                "name": tool_call.name,
                            }),
                        );
                        services
                            .checkpoints
                            .clear_for_run(&context.session_id, &context.run_id);
                        let runtime_events = state.runtime_events();
                        let events = state.legacy_events();
                        return Ok(serde_json::json!({
                            "runtime": "rust",
                            "runId": context.run_id,
                            "sessionId": context.session_id,
                            "finalContent": "",
                            "stopReason": "tool_error",
                            "messages": [],
                            "toolsUsed": state.tools_used,
                            "completedToolResults": state.completed_tool_results,
                            "error": error,
                            "events": events,
                            "runtimeEvents": runtime_events,
                        }));
                    }
                };
                let result = normalize_tool_result_for_context(result, &context);
                let observation_content = tool_observation_content(&result);
                let completed_result = completed_tool_result_entry(&tool_call, &result);
                state
                    .messages
                    .push(tool_observation_message(&tool_call, &observation_content));
                state.emit_event(
                    "agent.tool.result",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                        "detailId": format!("tool:{}", tool_call.id),
                        "status": "completed",
                        "resultStatus": result.envelope.get("status").cloned().unwrap_or_else(|| serde_json::json!("ok")),
                        "summary": result.envelope.get("summary").cloned().unwrap_or_else(|| Value::String(observation_content.clone())),
                        "timing": {
                            "durationMs": result
                                .envelope
                                .get("metrics")
                                .and_then(|metrics| metrics.get("durationMs"))
                                .cloned()
                                .unwrap_or(Value::Null),
                        },
                        "content": observation_content,
                        "envelope": result.envelope.clone(),
                    }),
                );
                if let Some(link_event) =
                    subagent_link_event_from_tool_result(&context, &tool_call, &result)
                {
                    state.emit_native_event(link_event);
                }
                for event in
                    subagent_activity_events_from_tool_result(&context, &tool_call, &result)
                {
                    if event.event_name == "agent.delegate.wait" {
                        state.transition_phase(
                            AgentRuntimePhase::AwaitingSubagent,
                            iteration,
                            "agent.delegate.wait",
                        );
                    }
                    state.emit_native_event(event);
                }
                state.completed_tool_results.push(completed_result);
                state.clear_pending_tool_calls();
                state.transition_phase(AgentRuntimePhase::Planning, iteration, "agent.tool.result");
                save_phase_checkpoint(
                    services,
                    &context,
                    state.phase.as_str(),
                    state.active_checkpoint_payload("tool_completed"),
                );
                if services.cancellations.is_cancelled(&context.run_id) {
                    state.transition_phase(
                        AgentRuntimePhase::Cancelled,
                        iteration,
                        "agent.cancelled",
                    );
                    return Ok(cancelled_run_result(
                        services,
                        &context,
                        state.take_runtime_events(),
                        std::mem::take(&mut state.tools_used),
                        std::mem::take(&mut state.completed_tool_results),
                        iteration,
                    ));
                }
            }

            if let Some(message) = state.drain_pending_guidance() {
                state.emit_event(
                    "agent.guidance",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "content": message.get("content").cloned().unwrap_or(Value::Null),
                    }),
                );
            }

            state.record_usage(
                &context,
                iteration,
                provider_response
                    .usage
                    .unwrap_or_else(|| serde_json::json!({})),
                estimated_context_tokens,
            );
            continue;
        }

        let final_content = provider_response.final_content;
        state.record_usage(
            &context,
            iteration,
            provider_response
                .usage
                .unwrap_or_else(|| serde_json::json!({})),
            estimated_context_tokens,
        );
        state.transition_phase(
            AgentRuntimePhase::Finalizing,
            iteration,
            "agent.message.completed",
        );
        services
            .checkpoints
            .clear_for_run(&context.session_id, &context.run_id);
        state.emit_event(
            "agent.message.completed",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "messageId": format!("{}:assistant", context.run_id),
                "content": final_content.clone(),
            }),
        );
        state.set_stop_reason("final_response", iteration, "agent.done");
        state.emit_event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "stopReason": "final_response",
            }),
        );
        let runtime_events = state.runtime_events();
        let events = state.legacy_events();

        return Ok(serde_json::json!({
            "runtime": "rust",
            "runId": context.run_id,
            "sessionId": context.session_id,
            "finalContent": final_content,
            "stopReason": "final_response",
            "messages": [{
                "role": "assistant",
                "content": final_content
            }],
            "toolsUsed": state.tools_used,
            "completedToolResults": state.completed_tool_results,
            "events": events,
            "runtimeEvents": runtime_events,
        }));
    }

    let error = "Rust agent runtime reached max iterations before final response.";
    state.set_stop_reason("max_iterations", state.iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "stopReason": "max_iterations",
            "error": error,
        }),
    );
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    Ok(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "max_iterations",
        "messages": [],
        "toolsUsed": state.tools_used,
        "completedToolResults": state.completed_tool_results,
        "error": error,
        "events": events,
        "runtimeEvents": runtime_events,
    }))
}
