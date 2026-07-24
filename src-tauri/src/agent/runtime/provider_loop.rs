use super::checkpoint::save_phase_checkpoint;
use super::continuations::{
    maybe_approval_resume_result, restore_activated_tools_for_continuation,
    ApprovalContinuationOutcome, ApprovalResume,
};
use super::events::runtime_event_timestamp;
use super::hooks::AgentHookEvaluation;
use super::result::{cancelled_result, cancelled_turn_result, error_result};
use super::state::AgentTurnState;
use super::tool_runtime::{execute_tool_calls_for_iteration, NativeAgentToolExecutionOutcome};
use super::usage::{
    context_window_action_payload, context_window_projection_async,
    context_with_projected_messages, estimate_context_tokens_for_request,
};
use super::user_input::{
    prepare_user_input_continuation, UserInputContinuationOutcome, UserInputResume,
};
use super::{
    AgentContextRequest, AgentHookInvocation, AgentHookStage, AgentTurnContext,
    ComposedInstructions, InstructionComposer, NativeAgentContextCheckpointCommit,
    NativeAgentProviderFailure, NativeAgentProviderFailureKind, NativeAgentProviderResponse,
    NativeAgentProviderStreamEvent, NativeAgentRuntimeServices,
};
use crate::agent::runtime_protocol::{
    AgentAssistantMessagePhase, AgentRuntimeEventAppendInput, AgentRuntimeEventEnvelope,
    AgentRuntimeEventSource, AgentRuntimeEventVisibility, AgentRuntimePhase, AgentTurnEmitter,
};
use crate::runtime::turn_execution::StartAgentTurn;
use crate::tools::registry::{McpToolContributor, WorkerToolRegistryRpc};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(test)]
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

#[cfg(test)]
pub async fn run_native_agent_turn_with_config_async(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
) -> Result<Value, String> {
    run_owned_native_agent_turn_async(services, spec, config_snapshot, None, None).await
}

#[cfg(test)]
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
    let instructions = InstructionComposer::default().compose_with_config(
        workspace_root,
        &spec,
        &config_snapshot,
    )?;
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
    let mut identity = AgentTurnContext::from_spec(spec.clone(), config_snapshot.clone());
    identity.attach_observability(services);
    let continuation_metadata = identity
        .metadata
        .get("agentContinuation")
        .or_else(|| identity.metadata.get("continuation"))
        .cloned();
    let restored_continuation_checkpoint = continuation_metadata.as_ref().and_then(|_| {
        services
            .checkpoints
            .restore_for_turn(&identity.session_id, &identity.turn_id)
    });
    if services
        .task_runtime
        .status(&identity.turn_id)
        .and_then(|status| status.terminal_outcome)
        .as_deref()
        == Some("cancelled")
    {
        return services
            .task_runtime
            .terminal_result(&identity.turn_id)
            .ok_or_else(|| {
                format!(
                    "cancelled agent turn `{}` is missing its owned terminal result",
                    identity.turn_id
                )
            })?;
    }
    let request = StartAgentTurn::new(identity.turn_id.clone(), identity.session_id.clone());
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
    if handle.turn_id() != identity.turn_id || handle.session_id() != identity.session_id {
        return Err("owned agent task identity does not match the normalized turn".to_string());
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
    if let Some(continuation) = continuation_metadata {
        if result.get("continuation").is_none() {
            result["continuation"] = continuation;
        }
        if result.get("restoredCheckpoint").is_none() {
            if let Some(checkpoint) = restored_continuation_checkpoint {
                result["restoredCheckpoint"] = checkpoint;
            }
        }
    }
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
    result["turnMetrics"] = serde_json::json!({
        "turnDurationMs": duration.as_millis().min(u128::from(u64::MAX)) as u64,
        "outcome": if completed { "completed" } else { "aborted" },
    });
    if let Some(instructions) = result_instructions {
        instructions.attach_diagnostics(&mut result)?;
    }
    Ok(result)
}

struct ProviderStreamState {
    streamed_content: bool,
    streamed_reasoning: bool,
    reasoning_content: String,
    message_phase: AgentAssistantMessagePhase,
    observer_cancelled: bool,
}

impl ProviderStreamState {
    fn new() -> Self {
        Self {
            streamed_content: false,
            streamed_reasoning: false,
            reasoning_content: String::new(),
            message_phase: AgentAssistantMessagePhase::Unknown,
            observer_cancelled: false,
        }
    }

    fn observe(
        &mut self,
        context: &AgentTurnContext,
        state: &mut AgentTurnState,
        iteration: i64,
        provider_attempt_id: &str,
        assistant_message_id: &str,
        reasoning_item_id: &str,
        event: NativeAgentProviderStreamEvent,
    ) {
        if turn_context_is_cancelled(context) {
            self.observer_cancelled = true;
            return;
        }
        match event {
            NativeAgentProviderStreamEvent::MessagePhase(phase) => {
                self.message_phase = phase;
                state.emit_event(
                    "agent.message.phase",
                    serde_json::json!({
                        "turnId": context.turn_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "modelCallId": provider_attempt_id,
                        "messageId": assistant_message_id,
                        "messagePhase": phase,
                    }),
                );
            }
            NativeAgentProviderStreamEvent::ContentDelta(delta) => {
                if delta.is_empty() {
                    return;
                }
                self.streamed_content = true;
                state.transition_phase(AgentRuntimePhase::StreamingModel, iteration, "agent.delta");
                state.emit_event(
                    "agent.delta",
                    serde_json::json!({
                        "turnId": context.turn_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "modelCallId": provider_attempt_id,
                        "messageId": assistant_message_id,
                        "messagePhase": self.message_phase,
                        "delta": delta,
                    }),
                );
            }
            NativeAgentProviderStreamEvent::ReasoningDelta(delta) => {
                if delta.is_empty() {
                    return;
                }
                self.streamed_reasoning = true;
                self.reasoning_content.push_str(&delta);
                state.transition_phase(
                    AgentRuntimePhase::StreamingModel,
                    iteration,
                    "agent.reasoning_delta",
                );
                state.emit_event(
                    "agent.reasoning_delta",
                    serde_json::json!({
                        "turnId": context.turn_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "modelCallId": provider_attempt_id,
                        "reasoningId": reasoning_item_id,
                        "delta": delta,
                    }),
                );
            }
        }
    }
}

struct NativeAgentTurnExecution<'a> {
    dependencies: &'a NativeAgentRuntimeServices,
    context: AgentTurnContext,
    state: AgentTurnState,
}

enum PreparedNativeAgentTurnExecution<'a> {
    Ready {
        execution: NativeAgentTurnExecution<'a>,
        start_iteration: i64,
    },
    Finished(Value),
}

enum ExecutionStage<T> {
    Ready(T),
    Finished(Value),
}

enum IterationOutcome {
    Continue,
    Finished(Value),
}

struct ProviderAttempt {
    iteration: i64,
    id: String,
    assistant_message_id: String,
    reasoning_item_id: String,
    estimated_context_tokens: i64,
    stream: ProviderStreamState,
}

impl ProviderAttempt {
    fn new(context: &AgentTurnContext, iteration: i64, estimated_context_tokens: i64) -> Self {
        Self {
            iteration,
            id: format!("{}:provider:{}", context.turn_id, iteration + 1),
            assistant_message_id: format!("{}:assistant:{iteration}", context.turn_id),
            reasoning_item_id: format!("{}:reasoning:{iteration}", context.turn_id),
            estimated_context_tokens,
            stream: ProviderStreamState::new(),
        }
    }
}

struct PreparedProviderIteration {
    provider_context: AgentTurnContext,
    attempt: ProviderAttempt,
}

struct CompletedProviderIteration {
    response: NativeAgentProviderResponse,
    attempt: ProviderAttempt,
}

impl<'a> NativeAgentTurnExecution<'a> {
    async fn execute(
        dependencies: &'a NativeAgentRuntimeServices,
        spec: Value,
        config_snapshot: Value,
        instructions: Option<ComposedInstructions>,
        workspace_root: Option<&Path>,
    ) -> Result<Value, String> {
        match Self::prepare(
            dependencies,
            spec,
            config_snapshot,
            instructions,
            workspace_root,
        )
        .await?
        {
            PreparedNativeAgentTurnExecution::Ready {
                execution,
                start_iteration,
            } => execution.run_loop(start_iteration).await,
            PreparedNativeAgentTurnExecution::Finished(result) => Ok(result),
        }
    }

    async fn prepare(
        dependencies: &'a NativeAgentRuntimeServices,
        spec: Value,
        config_snapshot: Value,
        instructions: Option<ComposedInstructions>,
        workspace_root: Option<&Path>,
    ) -> Result<PreparedNativeAgentTurnExecution<'a>, String> {
        let mut context = AgentTurnContext::from_spec(spec, config_snapshot.clone());
        context.attach_observability(dependencies);
        if let Some(instructions) = instructions.as_ref() {
            context.settings.working_directory = Some(instructions.working_directory.clone());
        }
        context.settings.validate()?;
        context.instructions = instructions;
        context.attach_cancellation(
            dependencies.cancellations.clone(),
            dependencies.task_runtime.clone(),
        );
        if context.max_iterations <= 0 {
            return Ok(PreparedNativeAgentTurnExecution::Finished(error_result(
                &context.turn_id,
                &context.session_id,
                "max_iterations",
                "Rust agent runtime reached max iterations before provider call.",
            )));
        }
        if turn_context_is_cancelled(&context) {
            let checkpoint = save_phase_checkpoint(
                dependencies,
                &context,
                "cancelled",
                serde_json::json!({ "cancelled": true }),
            );
            return Ok(PreparedNativeAgentTurnExecution::Finished(
                cancelled_result(
                    dependencies,
                    &context.turn_id,
                    &context.session_id,
                    checkpoint,
                ),
            ));
        }
        if let Some(workspace_root) = workspace_root {
            let cancellation = context.cancellation.clone().map(|cancellation| {
                Arc::new(cancellation) as Arc<dyn crate::protocol::WorkerRequestCancellation>
            });
            let discovered = match dependencies
                .mcp_runtime
                .discover_configured_tools(workspace_root, &config_snapshot, cancellation)
                .await
            {
                Ok(discovered) => discovered,
                Err(error) if error.cancelled => {
                    let checkpoint = save_phase_checkpoint(
                        dependencies,
                        &context,
                        "cancelled",
                        serde_json::json!({
                            "cancelled": true,
                            "phase": "mcp_discovery",
                            "server": error.server,
                            "transport": error.transport,
                        }),
                    );
                    return Ok(PreparedNativeAgentTurnExecution::Finished(
                        cancelled_result(
                            dependencies,
                            &context.turn_id,
                            &context.session_id,
                            checkpoint,
                        ),
                    ));
                }
                Err(error) => {
                    return Err(format!(
                        "MCP discovery failed for server `{}` over {}: {}",
                        error.server, error.transport, error.message
                    ));
                }
            };
            let mut tool_registry = WorkerToolRegistryRpc::new_with_config(
                context.settings.capability_policy()?,
                config_snapshot,
            );
            for server in discovered {
                tool_registry = tool_registry.with_contributor(Arc::new(
                    McpToolContributor::from_discovery(
                        &server.server_id,
                        &server.server_config,
                        &server.tools,
                    )?,
                ))?;
            }
            context.tool_router =
                super::tool_router::NativeToolRouter::new(tool_registry.list_tools().tools);
        }
        #[cfg(test)]
        if let Some(entries) = dependencies.test_tool_registry_entries.clone() {
            context.tool_router = super::tool_router::NativeToolRouter::new(entries);
        }
        context.tool_router.configure_for_turn(
            &context.settings.selected_tools,
            context.settings.effective_approval_policy(),
        )?;
        #[cfg(test)]
        context
            .tool_router
            .activate_for_turn(&dependencies.test_activated_tool_ids)?;

        let (mut context, continuation_resume) =
            match prepare_continuation(dependencies.clone(), context).await? {
                PreparedContinuation::Finished(result) => {
                    return Ok(PreparedNativeAgentTurnExecution::Finished(result));
                }
                PreparedContinuation::Continue { context, resume } => (context, resume),
            };
        if context.messages.is_empty() {
            return Ok(PreparedNativeAgentTurnExecution::Finished(error_result(
                &context.turn_id,
                &context.session_id,
                "invalid_request",
                "Rust agent runtime requires at least one user input or chat message.",
            )));
        }
        if let Some(workspace_root) = workspace_root {
            let request =
                AgentContextRequest::from_turn_context(workspace_root.to_path_buf(), &context);
            let hydration = dependencies
                .context_contributors
                .hydrate(&request, context.system_instruction_prompt())?;
            context.apply_context_hydration(hydration);
        }

        let mut state = if continuation_resume.is_some() {
            AgentTurnState::new_for_continuation(&context, dependencies.trace_sink.clone())?
        } else {
            AgentTurnState::new(&context, dependencies.trace_sink.clone())?
        };
        state.transition_phase(
            AgentRuntimePhase::HydratingHistory,
            0,
            "agent.history.hydrated",
        );
        if !context.context_contribution_diagnostics().is_empty() {
            state.emit_event(
                "agent.context.hydrated",
                serde_json::json!({
                    "turnId": context.turn_id,
                    "sessionId": context.session_id,
                    "contributors": context.context_contribution_diagnostics(),
                }),
            );
        }
        state.transition_phase(AgentRuntimePhase::Planning, 0, "agent.turn.started");
        let start_iteration = match continuation_resume {
            Some(PreparedTurnResume::Approval(resume)) => resume.apply(&context, &mut state),
            Some(PreparedTurnResume::UserInput(resume)) => resume.apply(&context, &mut state),
            None => {
                state.emit_turn_started(&context);
                state.emit_tinyos_command_acknowledgement(&context)?;
                0
            }
        };
        let turn_start_invocation = AgentHookInvocation::lifecycle(
            AgentHookStage::TurnStart,
            context.trace_context.clone(),
        );
        let turn_start_evaluation = context.evaluate_hook(turn_start_invocation.clone())?;
        state.emit_hook_evaluation(&turn_start_invocation, &turn_start_evaluation);
        if let Some(reason) = turn_start_evaluation.denied_reason {
            return Ok(PreparedNativeAgentTurnExecution::Finished(
                hook_denied_result(dependencies, &context, &mut state, start_iteration, reason),
            ));
        }

        Ok(PreparedNativeAgentTurnExecution::Ready {
            execution: Self {
                dependencies,
                context,
                state,
            },
            start_iteration,
        })
    }

    async fn run_loop(mut self, start_iteration: i64) -> Result<Value, String> {
        for iteration in start_iteration..self.context.max_iterations {
            match self.advance_iteration(iteration).await? {
                IterationOutcome::Continue => {}
                IterationOutcome::Finished(result) => return Ok(result),
            }
        }
        Ok(self.finish_max_iterations())
    }

    async fn advance_iteration(&mut self, iteration: i64) -> Result<IterationOutcome, String> {
        let prepared = match self.prepare_provider_iteration(iteration).await? {
            ExecutionStage::Ready(prepared) => prepared,
            ExecutionStage::Finished(result) => return Ok(IterationOutcome::Finished(result)),
        };
        let completed = match self.call_provider(prepared).await? {
            ExecutionStage::Ready(completed) => completed,
            ExecutionStage::Finished(result) => return Ok(IterationOutcome::Finished(result)),
        };
        self.reduce_provider_iteration(completed).await
    }

    async fn prepare_provider_iteration(
        &mut self,
        iteration: i64,
    ) -> Result<ExecutionStage<PreparedProviderIteration>, String> {
        self.state
            .transition_phase(AgentRuntimePhase::CallingModel, iteration, "provider_call");
        if turn_context_is_cancelled(&self.context) {
            return Ok(ExecutionStage::Finished(self.finish_cancelled(iteration)));
        }
        honor_pause_request(self.dependencies, &self.context, &mut self.state, iteration).await?;
        if turn_context_is_cancelled(&self.context) {
            return Ok(ExecutionStage::Finished(self.finish_cancelled(iteration)));
        }
        save_phase_checkpoint(
            self.dependencies,
            &self.context,
            self.state.phase.as_str(),
            self.state.active_checkpoint_payload("running"),
        );
        let prompt_messages = self.state.history.for_prompt()?;
        self.context.messages = prompt_messages.clone();
        self.context.spec["messages"] = Value::Array(prompt_messages);
        let projection = match context_window_projection_async(&self.context).await {
            Ok(projection) => projection,
            Err(error) if error.kind() == NativeAgentProviderFailureKind::Cancelled => {
                return Ok(ExecutionStage::Finished(self.finish_cancelled(iteration)));
            }
            Err(error) => {
                emit_context_compaction_failure(
                    &self.context,
                    &mut self.state,
                    iteration,
                    error.stop_reason(),
                    error.message(),
                );
                return Ok(ExecutionStage::Finished(provider_failure_result(
                    self.dependencies,
                    &self.context,
                    &mut self.state,
                    iteration,
                    error,
                )));
            }
        };
        if let Some(action) = projection.action.as_ref() {
            let mut payload = context_window_action_payload(&self.context, iteration, action);
            if let Some(tokens) = payload.get("estimatedTokensBefore").and_then(Value::as_i64) {
                self.context
                    .metrics()
                    .set_gauge("context.tokens.before", tokens);
            }
            if let Some(tokens) = payload.get("estimatedTokensAfter").and_then(Value::as_i64) {
                self.context
                    .metrics()
                    .set_gauge("context.tokens.after", tokens);
            }
            if action.event_name == "agent.context.compacted" {
                let checkpoint = self
                    .state
                    .compacted_context_checkpoint(&projection.messages, &payload);
                for field in [
                    "sourceContextId",
                    "windowNumber",
                    "firstWindowId",
                    "previousWindowId",
                    "windowId",
                ] {
                    payload[field] = checkpoint.get(field).cloned().unwrap_or(Value::Null);
                }
                let commit = NativeAgentContextCheckpointCommit {
                    session_id: self.context.session_id.clone(),
                    turn_id: self.context.turn_id.clone(),
                    thread_id: self.context.thread_id.clone(),
                    checkpoint: checkpoint.clone(),
                };
                if let Err(error) = self.dependencies.commit_context_checkpoint(commit).await {
                    let message = format!("context compaction checkpoint commit failed: {error}");
                    emit_context_compaction_failure(
                        &self.context,
                        &mut self.state,
                        iteration,
                        "context_compaction_commit_failed",
                        &message,
                    );
                    return Ok(ExecutionStage::Finished(agent_failure_result(
                        self.dependencies,
                        &self.context,
                        &mut self.state,
                        iteration,
                        "context_compaction_commit_failed",
                        message,
                    )));
                }
                self.state
                    .install_compacted_context(projection.messages.clone(), checkpoint)?;
                let prompt_messages = self.state.history.for_prompt()?;
                self.context.messages = prompt_messages.clone();
                self.context.spec["messages"] = Value::Array(prompt_messages);
                self.context.metrics().increment("compaction.completed");
            }
            self.state.emit_event(action.event_name, payload);
            if action.event_name == "agent.context.compacted" {
                let invocation = AgentHookInvocation::lifecycle(
                    AgentHookStage::CompactionComplete,
                    self.context.trace_context.clone(),
                );
                let evaluation = self.context.evaluate_hook(invocation.clone())?;
                self.state.emit_hook_evaluation(&invocation, &evaluation);
            }
        }

        let provider_context = context_with_projected_messages(&self.context, projection.messages);
        let estimated_context_tokens = estimate_context_tokens_for_request(&provider_context);
        let attempt = ProviderAttempt::new(&self.context, iteration, estimated_context_tokens);
        let before_provider_invocation = AgentHookInvocation::provider(
            AgentHookStage::BeforeProviderRequest,
            self.context.trace_context.clone(),
            attempt.id.clone(),
            None,
        );
        let before_provider_evaluation = self
            .context
            .evaluate_hook(before_provider_invocation.clone())?;
        self.state
            .emit_hook_evaluation(&before_provider_invocation, &before_provider_evaluation);
        if let Some(reason) = before_provider_evaluation.denied_reason {
            return Ok(ExecutionStage::Finished(hook_denied_result(
                self.dependencies,
                &self.context,
                &mut self.state,
                iteration,
                reason,
            )));
        }
        self.context.metrics().increment("provider.attempted");
        self.state.emit_event(
            "agent.provider.requested",
            serde_json::json!({
                "turnId": self.context.turn_id,
                "sessionId": self.context.session_id,
                "iteration": iteration,
                "providerAttemptId": attempt.id,
            }),
        );
        Ok(ExecutionStage::Ready(PreparedProviderIteration {
            provider_context,
            attempt,
        }))
    }

    async fn call_provider(
        &mut self,
        prepared: PreparedProviderIteration,
    ) -> Result<ExecutionStage<CompletedProviderIteration>, String> {
        let PreparedProviderIteration {
            provider_context,
            mut attempt,
        } = prepared;
        let provider_started_at = Instant::now();
        let provider_response = {
            let mut stream_observer = |event: NativeAgentProviderStreamEvent| {
                attempt.stream.observe(
                    &self.context,
                    &mut self.state,
                    attempt.iteration,
                    &attempt.id,
                    &attempt.assistant_message_id,
                    &attempt.reasoning_item_id,
                    event,
                );
            };
            let provider_call = self
                .dependencies
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
        self.context
            .metrics()
            .record_duration("provider.durationMs", provider_duration);
        let provider_outcome = if attempt.stream.observer_cancelled {
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
        self.context
            .metrics()
            .increment(&format!("provider.{provider_outcome}"));
        self.state.emit_event(
            "agent.provider.completed",
            serde_json::json!({
                "turnId": self.context.turn_id,
                "sessionId": self.context.session_id,
                "iteration": attempt.iteration,
                "providerAttemptId": attempt.id,
                "outcome": provider_outcome,
                "durationMs": provider_duration.as_millis().min(u128::from(u64::MAX)) as u64,
            }),
        );
        let after_provider_invocation = AgentHookInvocation::provider(
            AgentHookStage::AfterProviderResponse,
            self.context.trace_context.clone(),
            attempt.id.clone(),
            Some(provider_outcome.to_string()),
        );
        let after_provider_evaluation = self
            .context
            .evaluate_hook(after_provider_invocation.clone())?;
        self.state
            .emit_hook_evaluation(&after_provider_invocation, &after_provider_evaluation);
        if attempt.stream.observer_cancelled {
            return Ok(ExecutionStage::Finished(
                self.finish_cancelled(attempt.iteration),
            ));
        }
        let response = match provider_response {
            Ok(response) => response,
            Err(error) if error.kind() == NativeAgentProviderFailureKind::Cancelled => {
                return Ok(ExecutionStage::Finished(
                    self.finish_cancelled(attempt.iteration),
                ));
            }
            Err(error) => {
                return Ok(ExecutionStage::Finished(provider_failure_result(
                    self.dependencies,
                    &self.context,
                    &mut self.state,
                    attempt.iteration,
                    error,
                )));
            }
        };
        Ok(ExecutionStage::Ready(CompletedProviderIteration {
            response,
            attempt,
        }))
    }

    async fn reduce_provider_iteration(
        &mut self,
        mut completed: CompletedProviderIteration,
    ) -> Result<IterationOutcome, String> {
        let iteration = completed.attempt.iteration;
        honor_pause_request(self.dependencies, &self.context, &mut self.state, iteration).await?;
        let provider_phase_conflict = match completed.attempt.stream.message_phase {
            AgentAssistantMessagePhase::FinalAnswer
                if !completed.response.tool_calls.is_empty() =>
            {
                Some("provider emitted final_answer phase together with tool calls")
            }
            AgentAssistantMessagePhase::Commentary if completed.response.tool_calls.is_empty() => {
                Some("provider emitted commentary phase for a terminal response without tool calls")
            }
            _ => None,
        };
        if let Some(message) = provider_phase_conflict {
            return Ok(IterationOutcome::Finished(provider_failure_result(
                self.dependencies,
                &self.context,
                &mut self.state,
                iteration,
                NativeAgentProviderFailure::provider(message),
            )));
        }
        if turn_context_is_cancelled(&self.context) && completed.response.tool_calls.is_empty() {
            return Ok(IterationOutcome::Finished(self.finish_cancelled(iteration)));
        }

        self.project_provider_fallbacks(&mut completed);
        if completed.response.tool_calls.is_empty() {
            Ok(IterationOutcome::Finished(
                self.finish_final_response(completed),
            ))
        } else {
            self.complete_tool_iteration(completed).await
        }
    }

    fn project_provider_fallbacks(&mut self, completed: &mut CompletedProviderIteration) {
        let iteration = completed.attempt.iteration;
        if let Some(reasoning_delta) = completed
            .response
            .reasoning_delta
            .clone()
            .filter(|_| !completed.attempt.stream.streamed_reasoning)
        {
            completed
                .attempt
                .stream
                .reasoning_content
                .push_str(&reasoning_delta);
            self.state.transition_phase(
                AgentRuntimePhase::StreamingModel,
                iteration,
                "agent.reasoning_delta",
            );
            self.state.emit_event(
                "agent.reasoning_delta",
                serde_json::json!({
                    "turnId": self.context.turn_id,
                    "sessionId": self.context.session_id,
                    "iteration": iteration,
                    "modelCallId": completed.attempt.id,
                    "reasoningId": completed.attempt.reasoning_item_id,
                    "delta": reasoning_delta,
                }),
            );
        }
        if !completed.attempt.stream.reasoning_content.is_empty() {
            self.state.emit_event(
                "agent.reasoning.completed",
                serde_json::json!({
                    "turnId": self.context.turn_id,
                    "sessionId": self.context.session_id,
                    "iteration": iteration,
                    "modelCallId": completed.attempt.id,
                    "reasoningId": completed.attempt.reasoning_item_id,
                    "summary": completed.attempt.stream.reasoning_content,
                }),
            );
        }
        if self.context.stream
            && !completed.response.final_content.is_empty()
            && !completed.attempt.stream.streamed_content
        {
            self.state.transition_phase(
                AgentRuntimePhase::StreamingModel,
                iteration,
                "agent.delta",
            );
            self.state.emit_event(
                "agent.delta",
                serde_json::json!({
                    "turnId": self.context.turn_id,
                    "sessionId": self.context.session_id,
                    "iteration": iteration,
                    "modelCallId": completed.attempt.id,
                    "messageId": completed.attempt.assistant_message_id,
                    "messagePhase": completed.attempt.stream.message_phase,
                    "delta": completed.response.final_content,
                }),
            );
        }
    }

    async fn complete_tool_iteration(
        &mut self,
        completed: CompletedProviderIteration,
    ) -> Result<IterationOutcome, String> {
        let CompletedProviderIteration { response, attempt } = completed;
        if attempt.stream.streamed_content || !response.final_content.is_empty() {
            self.state.emit_event(
                "agent.message.classified",
                serde_json::json!({
                    "turnId": self.context.turn_id,
                    "sessionId": self.context.session_id,
                    "iteration": attempt.iteration,
                    "modelCallId": attempt.id,
                    "messageId": attempt.assistant_message_id,
                    "messagePhase": "commentary",
                    "classificationSource": if attempt.stream.message_phase == AgentAssistantMessagePhase::Commentary {
                        "provider"
                    } else {
                        "completion_fallback"
                    },
                    "content": response.final_content,
                }),
            );
        }
        let outcome = execute_tool_calls_for_iteration(
            self.dependencies,
            &mut self.context,
            &mut self.state,
            attempt.iteration,
            response.final_content.clone(),
            response.tool_calls,
        )
        .await;
        if let NativeAgentToolExecutionOutcome::Finished(mut result) = outcome {
            self.state.attach_context_checkpoint(&mut result, None);
            return Ok(IterationOutcome::Finished(result));
        }

        if let Some(message) = self.state.drain_pending_guidance()? {
            self.state.emit_event(
                "agent.guidance",
                serde_json::json!({
                    "turnId": self.context.turn_id,
                    "sessionId": self.context.session_id,
                    "iteration": attempt.iteration,
                    "content": message.get("content").cloned().unwrap_or(Value::Null),
                }),
            );
        }
        self.state.record_usage(
            &self.context,
            attempt.iteration,
            &attempt.id,
            response.usage.unwrap_or_else(|| serde_json::json!({})),
            attempt.estimated_context_tokens,
        );
        Ok(IterationOutcome::Continue)
    }

    fn finish_final_response(&mut self, completed: CompletedProviderIteration) -> Value {
        let CompletedProviderIteration { response, attempt } = completed;
        let final_content = response.final_content;
        self.state.record_usage(
            &self.context,
            attempt.iteration,
            &attempt.id,
            response.usage.unwrap_or_else(|| serde_json::json!({})),
            attempt.estimated_context_tokens,
        );
        self.state.transition_phase(
            AgentRuntimePhase::Finalizing,
            attempt.iteration,
            "agent.message.completed",
        );
        self.dependencies
            .checkpoints
            .clear_for_turn(&self.context.session_id, &self.context.turn_id);
        self.state.emit_event(
            "agent.message.completed",
            serde_json::json!({
                "turnId": self.context.turn_id,
                "sessionId": self.context.session_id,
                "iteration": attempt.iteration,
                "modelCallId": attempt.id,
                "messageId": attempt.assistant_message_id,
                "messagePhase": "final_answer",
                "classificationSource": if attempt.stream.message_phase == AgentAssistantMessagePhase::FinalAnswer {
                    "provider"
                } else {
                    "completion_fallback"
                },
                "content": final_content.clone(),
            }),
        );
        self.state
            .set_stop_reason("final_response", attempt.iteration, "agent.done");
        self.state.emit_event(
            "agent.done",
            serde_json::json!({
                "turnId": self.context.turn_id,
                "sessionId": self.context.session_id,
                "iteration": attempt.iteration,
                "stopReason": "final_response",
            }),
        );
        let runtime_events = self.state.runtime_events();
        let events = self.state.legacy_events();
        let final_message = serde_json::json!({
            "role": "assistant",
            "content": final_content
        });
        let context_checkpoint = self
            .state
            .finalized_context_checkpoint(Some(final_message.clone()));
        let mut result = serde_json::json!({
            "runtime": "rust",
            "turnId": self.context.turn_id,
            "sessionId": self.context.session_id,
            "finalContent": final_message["content"],
            "stopReason": "final_response",
            "messages": [final_message.clone()],
            "toolsUsed": self.state.tools_used,
            "completedToolResults": self.state.completed_tool_results,
            "events": events,
            "runtimeEvents": runtime_events,
        });
        if let Some(context_checkpoint) = context_checkpoint {
            result["contextCheckpoint"] = context_checkpoint;
        }
        result
    }

    fn finish_cancelled(&mut self, iteration: i64) -> Value {
        self.state
            .transition_phase(AgentRuntimePhase::Cancelled, iteration, "agent.cancelled");
        cancelled_turn_result(
            self.dependencies,
            &self.context,
            self.state.take_runtime_events(),
            std::mem::take(&mut self.state.tools_used),
            std::mem::take(&mut self.state.completed_tool_results),
            iteration,
        )
    }

    fn finish_max_iterations(&mut self) -> Value {
        let error = "Rust agent runtime reached max iterations before final response.";
        self.state
            .set_stop_reason("max_iterations", self.state.iteration, "agent.error");
        self.state.emit_event(
            "agent.error",
            serde_json::json!({
                "turnId": self.context.turn_id,
                "sessionId": self.context.session_id,
                "stopReason": "max_iterations",
                "error": error,
            }),
        );
        self.dependencies
            .checkpoints
            .clear_for_turn(&self.context.session_id, &self.context.turn_id);
        let runtime_events = self.state.runtime_events();
        let events = self.state.legacy_events();
        let context_checkpoint = self.state.finalized_context_checkpoint(None);
        let mut result = serde_json::json!({
            "runtime": "rust",
            "turnId": self.context.turn_id,
            "sessionId": self.context.session_id,
            "finalContent": "",
            "stopReason": "max_iterations",
            "messages": [],
            "toolsUsed": self.state.tools_used,
            "completedToolResults": self.state.completed_tool_results,
            "error": error,
            "events": events,
            "runtimeEvents": runtime_events,
        });
        if let Some(context_checkpoint) = context_checkpoint {
            result["contextCheckpoint"] = context_checkpoint;
        }
        result
    }
}

async fn run_native_agent_turn_with_instructions_async(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
    instructions: Option<ComposedInstructions>,
    workspace_root: Option<&Path>,
) -> Result<Value, String> {
    NativeAgentTurnExecution::execute(
        services,
        spec,
        config_snapshot,
        instructions,
        workspace_root,
    )
    .await
}

async fn honor_pause_request(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
) -> Result<(), String> {
    let Some(cancellation) = context.cancellation.as_ref() else {
        return Ok(());
    };
    let Some(pause_command_id) = cancellation.begin_pause() else {
        return Ok(());
    };
    let previous_phase = state.phase.clone();
    state.transition_phase(AgentRuntimePhase::Paused, iteration, "agent.paused");
    save_phase_checkpoint(
        services,
        context,
        "paused",
        state.active_checkpoint_payload("waiting"),
    );
    state.emit_event(
        "agent.paused",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "commandId": pause_command_id,
            "status": "completed",
            "message": "Agent turn paused at a safe boundary",
        }),
    );
    let resume_command_id = tokio::select! {
        result = cancellation.wait_for_resume() => result?,
        _ = cancellation.cancelled() => return Ok(()),
    };
    state.transition_phase(previous_phase, iteration, "agent.resumed");
    save_phase_checkpoint(
        services,
        context,
        state.phase.as_str(),
        state.active_checkpoint_payload("running"),
    );
    state.emit_event(
        "agent.resumed",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "commandId": resume_command_id,
            "status": "completed",
            "message": "Agent turn resumed",
        }),
    );
    Ok(())
}

fn turn_context_is_cancelled(context: &AgentTurnContext) -> bool {
    context
        .cancellation
        .as_ref()
        .is_some_and(|cancellation| cancellation.is_cancelled())
}

fn provider_failure_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    error: NativeAgentProviderFailure,
) -> Value {
    agent_failure_result(
        services,
        context,
        state,
        iteration,
        error.stop_reason(),
        error.message().to_string(),
    )
}

fn agent_failure_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    stop_reason: &str,
    message: String,
) -> Value {
    state.set_stop_reason(stop_reason, iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": stop_reason,
            "message": message,
            "error": message,
        }),
    );
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    let mut result = serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "messages": [],
        "toolsUsed": std::mem::take(&mut state.tools_used),
        "completedToolResults": std::mem::take(&mut state.completed_tool_results),
        "error": message,
        "events": events,
        "runtimeEvents": runtime_events,
    });
    state.attach_context_checkpoint(&mut result, None);
    result
}

fn emit_context_compaction_failure(
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    failure_stop_reason: &str,
    message: &str,
) {
    context.metrics().increment("compaction.failed");
    state.emit_event(
        "agent.context.compaction_failed",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "contextId": format!("{}:context:{}", context.turn_id, iteration + 1),
            "trigger": "auto",
            "reason": "context_limit",
            "phase": if iteration == 0 { "pre_turn" } else { "mid_turn" },
            "method": "summary",
            "provider": context.provider,
            "model": context.model,
            "status": "failed",
            "code": "context_compaction_failed",
            "failureStopReason": failure_stop_reason,
            "message": message,
            "error": message,
            "estimatedTokensBefore": estimate_context_tokens_for_request(context),
            "canonicalContextChanged": false,
        }),
    );
}

fn hook_denied_result(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    state: &mut AgentTurnState,
    iteration: i64,
    reason: String,
) -> Value {
    state.set_stop_reason("hook_denied", iteration, "agent.error");
    state.emit_event(
        "agent.error",
        serde_json::json!({
            "turnId": context.turn_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "stopReason": "hook_denied",
            "message": reason,
            "error": reason,
        }),
    );
    services
        .checkpoints
        .clear_for_turn(&context.session_id, &context.turn_id);
    let runtime_events = state.runtime_events();
    let events = state.legacy_events();
    let mut result = serde_json::json!({
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "hook_denied",
        "messages": [],
        "toolsUsed": std::mem::take(&mut state.tools_used),
        "completedToolResults": std::mem::take(&mut state.completed_tool_results),
        "error": reason,
        "events": events,
        "runtimeEvents": runtime_events,
    });
    state.attach_context_checkpoint(&mut result, None);
    result
}

fn append_hook_evaluation_to_result(
    result: &mut Value,
    context: &AgentTurnContext,
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
        AgentTurnEmitter::new_with_trace_context(&context.session_id, context.trace_context.clone())
    } else {
        AgentTurnEmitter::from_existing_events_with_thread_id(
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
        parent_turn_id: context.trace_context.parent_turn_id.clone(),
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
        context: AgentTurnContext,
        resume: Option<PreparedTurnResume>,
    },
}

enum PreparedTurnResume {
    Approval(ApprovalResume),
    UserInput(UserInputResume),
}

async fn prepare_continuation(
    services: NativeAgentRuntimeServices,
    mut context: AgentTurnContext,
) -> Result<PreparedContinuation, String> {
    restore_activated_tools_for_continuation(&services, &mut context)?;
    if let Some(outcome) = maybe_approval_resume_result(&services, &mut context).await? {
        return Ok(match outcome {
            ApprovalContinuationOutcome::Resume(resume) => PreparedContinuation::Continue {
                context,
                resume: Some(PreparedTurnResume::Approval(resume)),
            },
            ApprovalContinuationOutcome::Finished(result) => PreparedContinuation::Finished(result),
        });
    }
    let resume = match prepare_user_input_continuation(&services, &mut context)? {
        Some(UserInputContinuationOutcome::Finished(result)) => {
            return Ok(PreparedContinuation::Finished(result));
        }
        Some(UserInputContinuationOutcome::Resume(resume)) => {
            Some(PreparedTurnResume::UserInput(resume))
        }
        None => None,
    };
    Ok(PreparedContinuation::Continue { context, resume })
}
