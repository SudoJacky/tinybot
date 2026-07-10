use super::checkpoint::{maybe_emit_checkpoint, save_phase_checkpoint};
use super::continuations::{
    maybe_approval_resume_result, maybe_awaiting_approval_result, maybe_awaiting_form_result,
    maybe_form_submit_result, restore_activated_tools_for_continuation,
};
use super::result::{cancelled_result, cancelled_run_result, error_result};
use super::state::NativeAgentRunState;
use super::tool_runtime::{execute_tool_calls_for_iteration, NativeAgentToolExecutionOutcome};
use super::usage::{
    context_window_action_payload, context_window_projection, context_with_projected_messages,
    estimate_context_tokens_for_request,
};
use super::user_input::{prepare_user_input_continuation, UserInputContinuationOutcome};
use super::{
    bool_field, NativeAgentProviderStreamEvent, NativeAgentRunContext, NativeAgentRuntimeServices,
};
use crate::agent_loop_runtime_protocol::AgentRuntimePhase;
use crate::worker_capability::default_desktop_capability_policy;
use crate::worker_tool_registry::{mcp_tool_registry_entries, WorkerToolRegistryRpc};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

pub fn run_native_agent_turn_with_config(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
) -> Result<Value, String> {
    run_native_agent_turn_with_system_prompt(services, spec, config_snapshot, None, None)
}

pub fn run_native_agent_turn_with_workspace(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    workspace_root: &Path,
) -> Result<Value, String> {
    let system_prompt = crate::system_prompt::load_or_create_system_prompt(workspace_root)?;
    run_native_agent_turn_with_system_prompt(
        services,
        spec,
        config_snapshot,
        Some(system_prompt),
        Some(workspace_root),
    )
}

fn run_native_agent_turn_with_system_prompt(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    system_prompt: Option<String>,
    workspace_root: Option<&Path>,
) -> Result<Value, String> {
    let mut context = NativeAgentRunContext::from_spec(spec, config_snapshot.clone());
    context.system_prompt = system_prompt;
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
    if let Some(workspace_root) = workspace_root {
        let cancellation = context.cancellation.clone().map(|cancellation| {
            Arc::new(cancellation) as Arc<dyn crate::worker_protocol::WorkerRequestCancellation>
        });
        let discovered =
            match tauri::async_runtime::block_on(services.mcp_runtime.discover_configured_tools(
                workspace_root,
                &config_snapshot,
                cancellation,
            )) {
                Ok(discovered) => discovered,
                Err(error) if error.cancelled => {
                    let checkpoint = save_phase_checkpoint(
                        services,
                        &context,
                        "cancelled",
                        serde_json::json!({
                            "cancelled": true,
                            "phase": "mcp_discovery",
                            "server": error.server,
                            "transport": error.transport,
                        }),
                    );
                    return Ok(cancelled_result(
                        &context.run_id,
                        &context.session_id,
                        checkpoint,
                    ));
                }
                Err(error) => {
                    return Err(format!(
                        "MCP discovery failed for server `{}` over {}: {}",
                        error.server, error.transport, error.message
                    ));
                }
            };
        let mut dynamic_tools = Vec::new();
        for server in discovered {
            dynamic_tools.extend(mcp_tool_registry_entries(
                &server.server_id,
                &server.server_config,
                &server.tools,
            )?);
        }
        context.tool_router = super::tool_router::NativeToolRouter::new(
            WorkerToolRegistryRpc::new(default_desktop_capability_policy())
                .with_dynamic_tools(dynamic_tools)?
                .list_tools()
                .tools,
        );
    }
    #[cfg(test)]
    if let Some(entries) = services.test_tool_registry_entries.clone() {
        context.tool_router = super::tool_router::NativeToolRouter::new(entries);
    }
    #[cfg(test)]
    context
        .tool_router
        .activate_for_turn(&services.test_activated_tool_ids)?;
    restore_activated_tools_for_continuation(services, &mut context)?;
    if let Some(result) = maybe_awaiting_approval_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_approval_resume_result(services, &context)? {
        return Ok(result);
    }
    if let Some(result) = maybe_awaiting_form_result(services, &context) {
        return Ok(result);
    }
    let user_input_resume = match prepare_user_input_continuation(services, &mut context)? {
        Some(UserInputContinuationOutcome::Finished(result)) => return Ok(result),
        Some(UserInputContinuationOutcome::Resume(resume)) => Some(resume),
        None => {
            if let Some(result) = maybe_form_submit_result(services, &context)? {
                return Ok(result);
            }
            None
        }
    };
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
    let start_iteration = if let Some(resume) = user_input_resume {
        resume.apply(&context, &mut state)
    } else {
        state.emit_turn_started(&context);
        0
    };
    for iteration in start_iteration..context.max_iterations {
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
            match execute_tool_calls_for_iteration(
                services,
                &mut context,
                &mut state,
                iteration,
                provider_response.final_content.clone(),
                provider_response.tool_calls,
            ) {
                NativeAgentToolExecutionOutcome::Continue => {}
                NativeAgentToolExecutionOutcome::Finished(result) => return Ok(result),
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
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
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
