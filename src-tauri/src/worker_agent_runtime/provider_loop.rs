use super::checkpoint::{maybe_emit_checkpoint, save_phase_checkpoint};
use super::continuations::{
    maybe_approval_resume_result, maybe_awaiting_approval_result, maybe_awaiting_form_result,
    maybe_form_submit_result, restore_activated_tools_for_continuation,
};
use super::events::runtime_event_timestamp;
use super::hooks::AgentHookEvaluation;
use super::result::{cancelled_result, cancelled_run_result, error_result};
use super::state::NativeAgentRunState;
use super::tool_runtime::{execute_tool_calls_for_iteration, NativeAgentToolExecutionOutcome};
use super::usage::{
    context_window_action_payload, context_window_projection_async,
    context_with_projected_messages, estimate_context_tokens_for_request,
};
use super::user_input::{
    prepare_user_input_continuation, UserInputContinuationOutcome, UserInputResume,
};
use super::{
    bool_field, AgentContextRequest, AgentHookInvocation, AgentHookStage, ComposedInstructions,
    InstructionComposer, NativeAgentProviderFailure, NativeAgentProviderFailureKind,
    NativeAgentProviderStreamEvent, NativeAgentRunContext, NativeAgentRuntimeServices,
};
use crate::agent_loop_runtime_protocol::{
    AgentRunEmitter, AgentRuntimeEventAppendInput, AgentRuntimeEventEnvelope,
    AgentRuntimeEventSource, AgentRuntimeEventVisibility, AgentRuntimePhase,
};
use crate::runtime::agent_task::StartAgentRun;
use crate::worker_tool_registry::{McpToolContributor, WorkerToolRegistryRpc};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub fn run_native_agent_turn_with_config(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
) -> Result<Value, String> {
    tauri::async_runtime::block_on(run_native_agent_turn_with_config_async(
        services,
        spec,
        config_snapshot,
    ))
}

pub async fn run_native_agent_turn_with_config_async(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
) -> Result<Value, String> {
    run_owned_native_agent_turn_async(services, spec, config_snapshot, None, None).await
}

pub fn run_native_agent_turn_with_workspace(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    workspace_root: &Path,
) -> Result<Value, String> {
    tauri::async_runtime::block_on(run_native_agent_turn_with_workspace_async(
        services,
        spec,
        config_snapshot,
        workspace_root,
    ))
}

pub async fn run_native_agent_turn_with_workspace_async(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    workspace_root: &Path,
) -> Result<Value, String> {
    let instructions = InstructionComposer::default().compose(workspace_root, &spec)?;
    run_owned_native_agent_turn_async(
        services,
        spec,
        config_snapshot,
        Some(workspace_root.to_path_buf()),
        Some(instructions),
    )
    .await
}

pub(crate) async fn run_native_agent_turn_with_workspace_and_instructions_async(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    workspace_root: &Path,
    instructions: ComposedInstructions,
) -> Result<Value, String> {
    run_owned_native_agent_turn_async(
        services,
        spec,
        config_snapshot,
        Some(workspace_root.to_path_buf()),
        Some(instructions),
    )
    .await
}

async fn run_owned_native_agent_turn_async(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    workspace_root: Option<PathBuf>,
    instructions: Option<ComposedInstructions>,
) -> Result<Value, String> {
    let mut identity = NativeAgentRunContext::from_spec(spec.clone(), config_snapshot.clone());
    identity.attach_observability(services);
    if services
        .task_runtime
        .status(&identity.run_id)
        .and_then(|status| status.terminal_outcome)
        .as_deref()
        == Some("cancelled")
    {
        return services
            .task_runtime
            .terminal_result(&identity.run_id)
            .ok_or_else(|| {
                format!(
                    "cancelled agent run `{}` is missing its owned terminal result",
                    identity.run_id
                )
            })?;
    }
    let request = StartAgentRun::new(identity.run_id.clone(), identity.session_id.clone());
    let owned_services = services.clone();
    let result_instructions = instructions.clone();
    let handle = services
        .task_runtime
        .start_cooperative_async(request, Duration::from_secs(5), async move {
            run_native_agent_turn_with_instructions_async(
                &owned_services,
                spec,
                config_snapshot,
                instructions,
                workspace_root.as_deref(),
            )
            .await
        })
        .map_err(|error| format!("failed to start owned agent task: {error}"))?;
    if handle.run_id() != identity.run_id || handle.session_id() != identity.session_id {
        return Err("owned agent task identity does not match the normalized run".to_string());
    }
    if handle.status().is_none() {
        return Err("owned agent task did not publish a runtime status".to_string());
    }
    let turn_started_at = Instant::now();
    identity.metrics().increment("turn.started");
    let mut result = match handle.wait_async().await {
        Ok(result) => result,
        Err(error) => {
            identity.metrics().increment("turn.aborted");
            identity
                .metrics()
                .record_duration("turn.durationMs", turn_started_at.elapsed());
            let invocation = AgentHookInvocation::lifecycle(
                AgentHookStage::TurnAbort,
                identity.trace_context.clone(),
            );
            identity
                .evaluate_hook(invocation)
                .map_err(|hook_error| format!("{error}; turn abort hook failed: {hook_error}"))?;
            return Err(error);
        }
    };
    attach_context_contributions_to_result(&mut result)?;
    let stop_reason = result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let completed = matches!(
        stop_reason,
        "final_response" | "awaiting_approval" | "awaiting_form" | "awaiting_subagent"
    );
    let stage = if completed {
        identity.metrics().increment("turn.completed");
        AgentHookStage::TurnComplete
    } else {
        identity.metrics().increment("turn.aborted");
        AgentHookStage::TurnAbort
    };
    let duration = turn_started_at.elapsed();
    identity
        .metrics()
        .record_duration("turn.durationMs", duration);
    let invocation = AgentHookInvocation::lifecycle(stage, identity.trace_context.clone());
    let evaluation = identity.evaluate_hook(invocation.clone())?;
    append_hook_evaluation_to_result(&mut result, &identity, &invocation, &evaluation)?;
    result["traceContext"] = serde_json::to_value(&identity.trace_context)
        .map_err(|error| format!("failed to serialize agent trace context: {error}"))?;
    result["runMetrics"] = serde_json::json!({
        "turnDurationMs": duration.as_millis().min(u128::from(u64::MAX)) as u64,
        "outcome": if completed { "completed" } else { "aborted" },
    });
    if let Some(instructions) = result_instructions {
        instructions.attach_diagnostics(&mut result)?;
    }
    Ok(result)
}

async fn run_native_agent_turn_with_instructions_async(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    instructions: Option<ComposedInstructions>,
    workspace_root: Option<&Path>,
) -> Result<Value, String> {
    let mut context = NativeAgentRunContext::from_spec(spec, config_snapshot.clone());
    context.attach_observability(services);
    if let Some(instructions) = instructions.as_ref() {
        context.settings.working_directory = Some(instructions.working_directory.clone());
    }
    context.settings.validate()?;
    context.instructions = instructions;
    context.attach_cancellation(
        services.cancellations.clone(),
        services.task_runtime.clone(),
    );
    if context.max_iterations <= 0 {
        return Ok(error_result(
            &context.run_id,
            &context.session_id,
            "max_iterations",
            "Rust agent runtime reached max iterations before provider call.",
        ));
    }
    if run_context_is_cancelled(&context) || bool_field(&context.metadata, "fakeCancel") {
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
        let discovered = match services
            .mcp_runtime
            .discover_configured_tools(workspace_root, &config_snapshot, cancellation)
            .await
        {
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
        let mut tool_registry = WorkerToolRegistryRpc::new(context.settings.capability_policy()?);
        for server in discovered {
            tool_registry =
                tool_registry.with_contributor(Arc::new(McpToolContributor::from_discovery(
                    &server.server_id,
                    &server.server_config,
                    &server.tools,
                )?))?;
        }
        context.tool_router =
            super::tool_router::NativeToolRouter::new(tool_registry.list_tools().tools);
    }
    #[cfg(test)]
    if let Some(entries) = services.test_tool_registry_entries.clone() {
        context.tool_router = super::tool_router::NativeToolRouter::new(entries);
    }
    context.tool_router.configure_for_turn(
        &context.settings.selected_tools,
        context.settings.effective_approval_policy(),
    )?;
    #[cfg(test)]
    context
        .tool_router
        .activate_for_turn(&services.test_activated_tool_ids)?;
    let (next_context, user_input_resume) =
        match prepare_continuation(services.clone(), context).await? {
            PreparedContinuation::Finished(result) => return Ok(result),
            PreparedContinuation::Continue {
                context,
                user_input_resume,
            } => (context, user_input_resume),
        };
    context = next_context;
    if context.messages.is_empty() {
        return Ok(error_result(
            &context.run_id,
            &context.session_id,
            "invalid_request",
            "Rust agent runtime requires at least one user input or chat message.",
        ));
    }
    if let Some(workspace_root) = workspace_root {
        let request = AgentContextRequest::from_run_context(workspace_root.to_path_buf(), &context);
        let hydration = services
            .context_contributors
            .hydrate(&request, context.system_instruction_prompt())?;
        context.apply_context_hydration(hydration);
    }

    let mut state = NativeAgentRunState::new(&context, services.trace_sink.clone());
    state.transition_phase(
        AgentRuntimePhase::HydratingHistory,
        0,
        "agent.history.hydrated",
    );
    if !context.context_contribution_diagnostics().is_empty() {
        state.emit_event(
            "agent.context.hydrated",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "contributors": context.context_contribution_diagnostics(),
            }),
        );
    }
    state.transition_phase(AgentRuntimePhase::Planning, 0, "agent.turn.started");
    let start_iteration = if let Some(resume) = user_input_resume {
        resume.apply(&context, &mut state)
    } else {
        state.emit_turn_started(&context);
        0
    };
    let turn_start_invocation =
        AgentHookInvocation::lifecycle(AgentHookStage::TurnStart, context.trace_context.clone());
    let turn_start_evaluation = context.evaluate_hook(turn_start_invocation.clone())?;
    state.emit_hook_evaluation(&turn_start_invocation, &turn_start_evaluation);
    if let Some(reason) = turn_start_evaluation.denied_reason {
        return Ok(hook_denied_result(
            services,
            &context,
            &mut state,
            start_iteration,
            reason,
        ));
    }
    for iteration in start_iteration..context.max_iterations {
        state.transition_phase(AgentRuntimePhase::CallingModel, iteration, "provider_call");
        if run_context_is_cancelled(&context) {
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
        let projection = match context_window_projection_async(&context).await {
            Ok(projection) => projection,
            Err(error) if error.kind() == NativeAgentProviderFailureKind::Cancelled => {
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
            Err(error) => {
                return Ok(provider_failure_result(
                    services, &context, &mut state, iteration, error,
                ));
            }
        };
        if let Some(action) = projection.action.as_ref() {
            let payload = context_window_action_payload(&context, iteration, action);
            if let Some(tokens) = payload.get("estimatedTokensBefore").and_then(Value::as_i64) {
                context.metrics().set_gauge("context.tokens.before", tokens);
            }
            if let Some(tokens) = payload.get("estimatedTokensAfter").and_then(Value::as_i64) {
                context.metrics().set_gauge("context.tokens.after", tokens);
            }
            state.emit_event(action.event_name, payload);
            if action.event_name == "agent.context.compacted" {
                context.metrics().increment("compaction.completed");
                let invocation = AgentHookInvocation::lifecycle(
                    AgentHookStage::CompactionComplete,
                    context.trace_context.clone(),
                );
                let evaluation = context.evaluate_hook(invocation.clone())?;
                state.emit_hook_evaluation(&invocation, &evaluation);
            }
        }
        let provider_context = context_with_projected_messages(&context, projection.messages);
        let estimated_context_tokens = estimate_context_tokens_for_request(&provider_context);
        let provider_attempt_id = format!("{}:provider:{}", context.run_id, iteration + 1);
        let before_provider_invocation = AgentHookInvocation::provider(
            AgentHookStage::BeforeProviderRequest,
            context.trace_context.clone(),
            provider_attempt_id.clone(),
            None,
        );
        let before_provider_evaluation =
            context.evaluate_hook(before_provider_invocation.clone())?;
        state.emit_hook_evaluation(&before_provider_invocation, &before_provider_evaluation);
        if let Some(reason) = before_provider_evaluation.denied_reason {
            return Ok(hook_denied_result(
                services, &context, &mut state, iteration, reason,
            ));
        }
        context.metrics().increment("provider.attempted");
        state.emit_event(
            "agent.provider.requested",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "providerAttemptId": provider_attempt_id,
            }),
        );
        let provider_started_at = Instant::now();
        let mut provider_streamed_content = false;
        let mut provider_streamed_reasoning = false;
        let mut provider_observer_cancelled = false;
        let provider_response = {
            let mut stream_observer = |event: NativeAgentProviderStreamEvent| {
                if run_context_is_cancelled(&context) {
                    provider_observer_cancelled = true;
                    return;
                }
                match event {
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
                }
            };
            let provider_call = services
                .provider
                .clone()
                .complete_streaming_async(&provider_context, &mut stream_observer);
            tokio::pin!(provider_call);
            if let Some(cancellation) = provider_context.cancellation.clone() {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(NativeAgentProviderFailure::new(
                        NativeAgentProviderFailureKind::Cancelled,
                        "provider call was cancelled",
                    )),
                    result = &mut provider_call => result,
                }
            } else {
                provider_call.await
            }
        };
        let provider_duration = provider_started_at.elapsed();
        context
            .metrics()
            .record_duration("provider.durationMs", provider_duration);
        let provider_outcome = if provider_observer_cancelled {
            "cancelled"
        } else {
            match &provider_response {
                Ok(_) => "completed",
                Err(error) if error.kind() == NativeAgentProviderFailureKind::Cancelled => {
                    "cancelled"
                }
                Err(_) => "failed",
            }
        };
        context
            .metrics()
            .increment(&format!("provider.{provider_outcome}"));
        state.emit_event(
            "agent.provider.completed",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "providerAttemptId": provider_attempt_id,
                "outcome": provider_outcome,
                "durationMs": provider_duration.as_millis().min(u128::from(u64::MAX)) as u64,
            }),
        );
        let after_provider_invocation = AgentHookInvocation::provider(
            AgentHookStage::AfterProviderResponse,
            context.trace_context.clone(),
            provider_attempt_id,
            Some(provider_outcome.to_string()),
        );
        let after_provider_evaluation = context.evaluate_hook(after_provider_invocation.clone())?;
        state.emit_hook_evaluation(&after_provider_invocation, &after_provider_evaluation);
        if provider_observer_cancelled {
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
        let provider_response = match provider_response {
            Ok(response) => response,
            Err(error) if error.kind() == NativeAgentProviderFailureKind::Cancelled => {
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
            Err(error) => {
                return Ok(provider_failure_result(
                    services, &context, &mut state, iteration, error,
                ));
            }
        };
        if run_context_is_cancelled(&context) && provider_response.tool_calls.is_empty() {
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
            let outcome = execute_tool_calls_for_iteration(
                services,
                &mut context,
                &mut state,
                iteration,
                provider_response.final_content.clone(),
                provider_response.tool_calls,
            )
            .await;
            match outcome {
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

fn run_context_is_cancelled(context: &NativeAgentRunContext) -> bool {
    context
        .cancellation
        .as_ref()
        .is_some_and(|cancellation| cancellation.is_cancelled())
}

fn provider_failure_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    error: NativeAgentProviderFailure,
) -> Value {
    let stop_reason = error.stop_reason();
    let message = error.message().to_string();
    state.set_stop_reason(stop_reason, iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": stop_reason,
            "message": message,
            "error": message,
        }),
    );
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "messages": [],
        "toolsUsed": std::mem::take(&mut state.tools_used),
        "completedToolResults": std::mem::take(&mut state.completed_tool_results),
        "error": message,
        "events": events,
        "runtimeEvents": runtime_events,
    })
}

fn hook_denied_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    state: &mut NativeAgentRunState,
    iteration: i64,
    reason: String,
) -> Value {
    state.set_stop_reason("hook_denied", iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": "hook_denied",
            "message": reason,
            "error": reason,
        }),
    );
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "hook_denied",
        "messages": [],
        "toolsUsed": std::mem::take(&mut state.tools_used),
        "completedToolResults": std::mem::take(&mut state.completed_tool_results),
        "error": reason,
        "events": events,
        "runtimeEvents": runtime_events,
    })
}

fn append_hook_evaluation_to_result(
    result: &mut Value,
    context: &NativeAgentRunContext,
    invocation: &AgentHookInvocation,
    evaluation: &AgentHookEvaluation,
) -> Result<(), String> {
    if evaluation.decisions.is_empty() {
        return Ok(());
    }
    let existing = result
        .get("runtimeEvents")
        .filter(|events| events.is_array())
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let existing: Vec<AgentRuntimeEventEnvelope> = serde_json::from_value(existing)
        .map_err(|error| format!("failed to read runtime events for lifecycle hook: {error}"))?;
    let mut emitter = if existing.is_empty() {
        AgentRunEmitter::new_with_trace_context(&context.session_id, context.trace_context.clone())
    } else {
        AgentRunEmitter::from_existing_events_with_thread_id(
            &context.session_id,
            &context.trace_context.turn_id,
            context.trace_context.thread_id.clone(),
            &existing,
        )
    };
    let phase = match invocation.stage {
        AgentHookStage::TurnComplete => AgentRuntimePhase::Completed,
        AgentHookStage::TurnAbort => AgentRuntimePhase::Failed,
        _ => AgentRuntimePhase::Planning,
    };
    let event = emitter.emit(AgentRuntimeEventAppendInput {
        parent_turn_id: context.trace_context.parent_run_id.clone(),
        item_id: None,
        event_name: "agent.hook.decision".to_string(),
        phase,
        timestamp: runtime_event_timestamp(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::Debug,
        payload: evaluation.event_payload(invocation),
    });
    let events = result
        .as_object_mut()
        .ok_or_else(|| "agent result must be a JSON object".to_string())?
        .entry("runtimeEvents".to_string())
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| "agent result runtimeEvents must be an array".to_string())?;
    events.push(
        serde_json::to_value(event)
            .map_err(|error| format!("failed to serialize lifecycle hook event: {error}"))?,
    );
    Ok(())
}

fn attach_context_contributions_to_result(result: &mut Value) -> Result<(), String> {
    let contributions = result
        .get("runtimeEvents")
        .and_then(Value::as_array)
        .and_then(|events| {
            events.iter().rev().find(|event| {
                event.get("eventName").and_then(Value::as_str) == Some("agent.context.hydrated")
            })
        })
        .and_then(|event| event.get("payload"))
        .and_then(|payload| payload.get("contributors"))
        .cloned();
    let Some(contributions) = contributions else {
        return Ok(());
    };
    if !contributions.is_array() {
        return Err("agent context contribution diagnostics must be an array".to_string());
    }
    result
        .as_object_mut()
        .ok_or_else(|| "agent result must be a JSON object".to_string())?
        .insert("contextContributions".to_string(), contributions);
    Ok(())
}

enum PreparedContinuation {
    Finished(Value),
    Continue {
        context: NativeAgentRunContext,
        user_input_resume: Option<UserInputResume>,
    },
}

async fn prepare_continuation(
    services: NativeAgentRuntimeServices,
    mut context: NativeAgentRunContext,
) -> Result<PreparedContinuation, String> {
    restore_activated_tools_for_continuation(&services, &mut context)?;
    if let Some(result) = maybe_awaiting_approval_result(&services, &context) {
        return Ok(PreparedContinuation::Finished(result));
    }
    if let Some(result) = maybe_approval_resume_result(&services, &context).await? {
        return Ok(PreparedContinuation::Finished(result));
    }
    if let Some(result) = maybe_awaiting_form_result(&services, &context) {
        return Ok(PreparedContinuation::Finished(result));
    }
    let user_input_resume = match prepare_user_input_continuation(&services, &mut context)? {
        Some(UserInputContinuationOutcome::Finished(result)) => {
            return Ok(PreparedContinuation::Finished(result));
        }
        Some(UserInputContinuationOutcome::Resume(resume)) => Some(resume),
        None => {
            if let Some(result) = maybe_form_submit_result(&services, &context)? {
                return Ok(PreparedContinuation::Finished(result));
            }
            None
        }
    };
    Ok(PreparedContinuation::Continue {
        context,
        user_input_resume,
    })
}
