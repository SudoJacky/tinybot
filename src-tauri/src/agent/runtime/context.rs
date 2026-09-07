use super::hooks::AgentHookEvaluation;
use super::tool_router::NativeToolRouter;
use super::{
    string_field, AgentHookInvocation, AgentTurnContext, ComposedInstructions,
    NativeAgentCancellation, NativeAgentCancellationContext, NativeAgentRuntimeServices,
};
use crate::agent::runtime_protocol::AgentTraceContext;
use crate::protocol::capability::default_desktop_capability_policy;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::tools::registry::ToolExecutionTarget;
use crate::tools::registry::WorkerToolRegistryRpc;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl AgentTurnContext {
    #[cfg(test)]
    pub(super) fn from_spec(spec: Value, config_snapshot: Value) -> Self {
        let input = super::AgentTurnInput::from_wire(&spec, &config_snapshot)
            .expect("test turn input must be valid");
        Self::from_input(input, config_snapshot)
    }

    pub(super) fn from_input(input: super::AgentTurnInput, config_snapshot: Value) -> Self {
        let tool_router = NativeToolRouter::new(
            WorkerToolRegistryRpc::new_with_config(
                default_desktop_capability_policy(),
                config_snapshot.clone(),
            )
            .list_tools()
            .tools,
        );
        Self {
            turn_id: input.trace_context.turn_id.clone(),
            session_id: input.session_id,
            thread_id: input.trace_context.thread_id.clone(),
            model: input.settings.model.clone(),
            provider: input.settings.provider.clone(),
            stream: input.settings.stream,
            max_iterations: input.settings.max_iterations,
            settings: input.settings,
            trace_context: input.trace_context,
            messages: input.messages,
            responses_input_items: input.responses_input_items,
            api_mode: input.api_mode,
            metadata: input.metadata,
            continuation: input.continuation,
            controls: input.controls,
            context_window_projected: false,
            config_snapshot,
            system_prompt: None,
            instructions: None,
            prepared_provider_request: None,
            cancellation: None,
            hooks: super::hooks::AgentHookPipeline::default(),
            metrics: crate::runtime::observability::global_agent_runtime_metrics().clone(),
            pending_hook_evaluations: Arc::new(std::sync::Mutex::new(Vec::new())),
            pending_tool_hook_context: Vec::new(),
            deferred_hook_response_items: Vec::new(),
            tool_router,
        }
    }

    pub(super) fn attach_observability(&mut self, services: &NativeAgentRuntimeServices) {
        self.hooks = services.hooks.clone();
        self.metrics = services.metrics.clone();
    }

    pub(crate) fn evaluate_hook(
        &self,
        invocation: AgentHookInvocation,
    ) -> Result<AgentHookEvaluation, String> {
        self.hooks.evaluate(invocation, &self.metrics)
    }

    pub(crate) async fn evaluate_command_hook(
        &self,
        invocation: AgentHookInvocation,
    ) -> Result<AgentHookEvaluation, String> {
        self.hooks
            .evaluate_command_hooks(invocation, &self.metrics)
            .await
    }

    pub(crate) fn hook_permission_mode(&self) -> String {
        self.settings
            .permission_profile
            .clone()
            .unwrap_or_else(|| "local-worker".to_string())
    }

    pub(crate) fn queue_tool_hook_context(&mut self, evaluation: &AgentHookEvaluation) {
        self.pending_tool_hook_context
            .extend(evaluation.additional_context.iter().cloned());
    }

    pub(crate) fn pending_tool_hook_context(&self) -> &[String] {
        &self.pending_tool_hook_context
    }

    pub(crate) fn take_pending_tool_hook_context(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending_tool_hook_context)
    }

    pub(crate) fn restore_pending_tool_hook_context(&mut self, context: Vec<String>) {
        self.pending_tool_hook_context.extend(context);
    }

    pub(crate) fn defer_hook_response_item(&mut self, item: Value) {
        if self.responses_input_items.is_some() {
            self.deferred_hook_response_items.push(item);
        }
    }

    pub(crate) fn flush_deferred_hook_response_items(&mut self) {
        if let Some(response_items) = self.responses_input_items.as_mut() {
            response_items.append(&mut self.deferred_hook_response_items);
        } else {
            self.deferred_hook_response_items.clear();
        }
    }

    pub(crate) fn metrics(&self) -> &crate::runtime::observability::AgentRuntimeMetrics {
        &self.metrics
    }

    pub(crate) fn drain_hook_evaluations(&self) -> Vec<(AgentHookInvocation, AgentHookEvaluation)> {
        std::mem::take(
            &mut *self
                .pending_hook_evaluations
                .lock()
                .expect("pending agent hook evaluation lock should not be poisoned"),
        )
    }

    pub(super) fn attach_cancellation(
        &mut self,
        cancellations: Arc<dyn NativeAgentCancellation>,
        task_runtime: crate::runtime::turn_execution::TurnExecutionRuntime,
    ) {
        self.cancellation = Some(NativeAgentCancellationContext::new(
            self.turn_id.clone(),
            cancellations,
            task_runtime,
        ));
    }

    pub(super) fn with_child_cancellation(&self, child_token: CancellationToken) -> Self {
        let mut child = self.clone();
        child.cancellation = child
            .cancellation
            .as_ref()
            .map(|cancellation| cancellation.with_child_token(child_token));
        child
    }

    pub(crate) fn tool_execution_target(&self, method: &str) -> Option<ToolExecutionTarget> {
        self.tool_router.execution_target(method)
    }

    pub(crate) fn system_instruction_prompt(&self) -> Option<&str> {
        self.instructions
            .as_ref()
            .map(ComposedInstructions::rendered_prompt)
            .or(self.system_prompt.as_deref())
    }

    pub(super) fn prepared_provider_request(&self) -> Option<&Value> {
        self.prepared_provider_request.as_ref()
    }

    pub(super) fn set_prepared_provider_request(&mut self, request: Value) {
        self.prepared_provider_request = Some(request);
    }
}

pub(crate) fn ensure_agent_trace_context(spec: &mut Value) -> Result<AgentTraceContext, String> {
    if !spec.is_object() {
        return Err(
            "agent turn spec must be a JSON object before trace initialization".to_string(),
        );
    }
    let existing_turn_id = string_field(spec, "turnId").or_else(|| string_field(spec, "turn_id"));
    let correlation = next_worker_request_correlation();
    let turn_id = existing_turn_id.unwrap_or_else(|| correlation.id("agent-turn"));
    let request_id = string_field(spec, "requestId")
        .or_else(|| string_field(spec, "request_id"))
        .or_else(|| {
            spec.get("traceContext")
                .and_then(|trace| string_field(trace, "requestId"))
        })
        .unwrap_or_else(|| correlation.id("agent-turn-request"));
    let trace_id = string_field(spec, "traceId")
        .or_else(|| string_field(spec, "trace_id"))
        .or_else(|| {
            spec.get("traceContext")
                .and_then(|trace| string_field(trace, "traceId"))
        })
        .unwrap_or_else(|| correlation.trace_id("agent-turn"));
    let object = spec
        .as_object_mut()
        .ok_or_else(|| "agent turn spec must remain a JSON object".to_string())?;
    object.insert("turnId".to_string(), Value::String(turn_id));
    object.insert("requestId".to_string(), Value::String(request_id));
    object.insert("traceId".to_string(), Value::String(trace_id));
    Ok(agent_trace_context_from_value(spec))
}

pub(crate) fn agent_trace_context_from_value(value: &Value) -> AgentTraceContext {
    let trace_value = value.get("traceContext").unwrap_or(&Value::Null);
    let metadata = value.get("metadata").unwrap_or(&Value::Null);
    let turn_id = string_field(value, "turnId")
        .or_else(|| string_field(value, "turn_id"))
        .or_else(|| string_field(trace_value, "turnId"))
        .or_else(|| string_field(trace_value, "turn_id"))
        .unwrap_or_else(|| "native-rust-turn".to_string());
    AgentTraceContext {
        request_id: string_field(value, "requestId")
            .or_else(|| string_field(value, "request_id"))
            .or_else(|| string_field(trace_value, "requestId"))
            .or_else(|| string_field(trace_value, "request_id"))
            .unwrap_or_else(|| format!("agent-turn-{turn_id}")),
        trace_id: string_field(value, "traceId")
            .or_else(|| string_field(value, "trace_id"))
            .or_else(|| string_field(trace_value, "traceId"))
            .or_else(|| string_field(trace_value, "trace_id"))
            .unwrap_or_else(|| format!("trace-agent-turn-{turn_id}")),
        turn_id,
        thread_id: string_field(value, "threadId")
            .or_else(|| string_field(value, "thread_id"))
            .or_else(|| string_field(trace_value, "threadId"))
            .or_else(|| string_field(trace_value, "thread_id"))
            .or_else(|| string_field(metadata, "threadId"))
            .or_else(|| string_field(metadata, "thread_id")),
        parent_turn_id: string_field(value, "parentTurnId")
            .or_else(|| string_field(value, "parent_turn_id"))
            .or_else(|| string_field(trace_value, "parentTurnId"))
            .or_else(|| string_field(trace_value, "parent_turn_id"))
            .or_else(|| string_field(metadata, "parentTurnId"))
            .or_else(|| string_field(metadata, "parent_turn_id")),
    }
}
