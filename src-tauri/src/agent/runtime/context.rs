use super::context_contributors::AgentContextHydration;
use super::continuations::queued_user_continuation_message;
use super::hooks::AgentHookEvaluation;
use super::tool_router::NativeToolRouter;
use super::{
    string_field, AgentHookInvocation, AgentTurnContext, AgentTurnSettings, ComposedInstructions,
    NativeAgentCancellation, NativeAgentCancellationContext, NativeAgentRuntimeServices,
    DEFAULT_NATIVE_AGENT_MAX_ITERATIONS,
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
    pub(super) fn from_spec(spec: Value, config_snapshot: Value) -> Self {
        let session_id =
            normalized_session_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
        let metadata = spec
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let thread_id = string_field(&spec, "threadId")
            .or_else(|| string_field(&spec, "thread_id"))
            .or_else(|| string_field(&metadata, "threadId"))
            .or_else(|| string_field(&metadata, "thread_id"));
        let model = normalized_model(&spec, &metadata, &config_snapshot);
        let provider = normalized_provider(&spec, &metadata, &config_snapshot);
        let max_iterations = spec
            .get("maxIterations")
            .or_else(|| spec.get("max_iterations"))
            .or_else(|| metadata.get("maxIterations"))
            .or_else(|| metadata.get("max_iterations"))
            .or_else(|| {
                config_snapshot
                    .get("agents")
                    .and_then(|agents| agents.get("defaults"))
                    .and_then(|defaults| {
                        defaults
                            .get("maxIterations")
                            .or_else(|| defaults.get("max_iterations"))
                    })
            })
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_NATIVE_AGENT_MAX_ITERATIONS);
        let stream = spec
            .get("stream")
            .or_else(|| metadata.get("stream"))
            .or_else(|| metadata.get("_wants_stream"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut messages = initial_agent_messages(&spec);
        if let Some(message) = queued_user_continuation_message(&metadata) {
            messages.push(message);
        }
        let tool_router = NativeToolRouter::new(
            WorkerToolRegistryRpc::new_with_config(
                default_desktop_capability_policy(),
                config_snapshot.clone(),
            )
            .list_tools()
            .tools,
        );
        let settings = AgentTurnSettings::from_sources(
            &spec,
            &metadata,
            &config_snapshot,
            model.clone(),
            provider.clone(),
            max_iterations,
            stream,
        );
        let trace_value = spec.get("traceContext").unwrap_or(&Value::Null);
        let turn_id = string_field(&spec, "turnId")
            .or_else(|| string_field(&spec, "turn_id"))
            .or_else(|| string_field(trace_value, "turnId"))
            .or_else(|| string_field(trace_value, "turn_id"))
            .or_else(|| string_field(&metadata, "turnId"))
            .or_else(|| string_field(&metadata, "turn_id"))
            .unwrap_or_else(|| "native-rust-turn".to_string());
        let request_id = string_field(&spec, "requestId")
            .or_else(|| string_field(&spec, "request_id"))
            .or_else(|| string_field(trace_value, "requestId"))
            .or_else(|| string_field(trace_value, "request_id"))
            .or_else(|| string_field(&metadata, "requestId"))
            .or_else(|| string_field(&metadata, "request_id"))
            .unwrap_or_else(|| format!("agent-turn-{turn_id}"));
        let trace_id = string_field(&spec, "traceId")
            .or_else(|| string_field(&spec, "trace_id"))
            .or_else(|| string_field(trace_value, "traceId"))
            .or_else(|| string_field(trace_value, "trace_id"))
            .or_else(|| string_field(&metadata, "traceId"))
            .or_else(|| string_field(&metadata, "trace_id"))
            .unwrap_or_else(|| format!("trace-agent-turn-{turn_id}"));
        let parent_turn_id = string_field(&spec, "parentTurnId")
            .or_else(|| string_field(&spec, "parent_turn_id"))
            .or_else(|| string_field(trace_value, "parentTurnId"))
            .or_else(|| string_field(trace_value, "parent_turn_id"))
            .or_else(|| string_field(&metadata, "parentTurnId"))
            .or_else(|| string_field(&metadata, "parent_turn_id"));
        let trace_context = AgentTraceContext {
            request_id,
            trace_id,
            turn_id: turn_id.clone(),
            thread_id: thread_id.clone(),
            parent_turn_id,
        };
        Self {
            turn_id,
            session_id,
            thread_id,
            messages,
            spec,
            config_snapshot,
            metadata,
            model,
            provider,
            system_prompt: None,
            instructions: None,
            assembled_system_prompt: None,
            context_contributions: Vec::new(),
            stream,
            max_iterations,
            settings,
            cancellation: None,
            trace_context,
            hooks: super::hooks::AgentHookPipeline::default(),
            metrics: crate::runtime::observability::global_agent_runtime_metrics().clone(),
            pending_hook_evaluations: Arc::new(std::sync::Mutex::new(Vec::new())),
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

    pub(crate) fn metrics(&self) -> &crate::runtime::observability::AgentRuntimeMetrics {
        &self.metrics
    }

    pub(crate) fn queue_hook_evaluation(
        &self,
        invocation: AgentHookInvocation,
        evaluation: AgentHookEvaluation,
    ) {
        self.pending_hook_evaluations
            .lock()
            .expect("pending agent hook evaluation lock should not be poisoned")
            .push((invocation, evaluation));
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
        self.assembled_system_prompt.as_deref().or_else(|| {
            self.instructions
                .as_ref()
                .map(ComposedInstructions::rendered_prompt)
                .or(self.system_prompt.as_deref())
        })
    }

    pub(super) fn apply_context_hydration(&mut self, hydration: AgentContextHydration) {
        self.assembled_system_prompt = hydration.rendered_prompt;
        self.context_contributions = hydration.diagnostics;
    }

    pub(super) fn context_contribution_diagnostics(&self) -> &[Value] {
        &self.context_contributions
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

fn initial_agent_messages(spec: &Value) -> Vec<Value> {
    if let Some(messages) = spec.get("messages").and_then(Value::as_array) {
        if !messages.is_empty() {
            return messages.clone();
        }
    }
    if let Some(input) = spec.get("input").and_then(Value::as_object) {
        let role = input
            .get("role")
            .and_then(Value::as_str)
            .filter(|role| !role.trim().is_empty())
            .unwrap_or("user");
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !content.trim().is_empty() {
            let mut message = serde_json::json!({ "role": role, "content": content });
            if let Some(client_event_id) = input
                .get("clientEventId")
                .or_else(|| input.get("client_event_id"))
                .and_then(Value::as_str)
            {
                message["clientEventId"] = Value::String(client_event_id.to_string());
            }
            if let Some(references) = input.get("references").filter(|value| value.is_array()) {
                message["references"] = references.clone();
            }
            return vec![message];
        }
    }
    Vec::new()
}

fn normalized_session_id(spec: &Value) -> Option<String> {
    string_field(spec, "sessionId")
        .or_else(|| string_field(spec, "session_id"))
        .or_else(|| string_field(spec, "activeSessionId"))
        .or_else(|| string_field(spec, "active_session_id"))
        .or_else(|| string_field(spec, "sessionKey"))
        .or_else(|| string_field(spec, "session_key"))
}

fn normalized_model(spec: &Value, metadata: &Value, config_snapshot: &Value) -> String {
    string_field(spec, "model")
        .or_else(|| string_field(spec, "modelId"))
        .or_else(|| string_field(spec, "model_id"))
        .or_else(|| string_field(metadata, "model"))
        .unwrap_or_else(|| crate::agent::provider::configured_model(config_snapshot))
}

fn normalized_provider(spec: &Value, metadata: &Value, config_snapshot: &Value) -> Option<String> {
    string_field(spec, "provider")
        .or_else(|| string_field(spec, "providerId"))
        .or_else(|| string_field(spec, "provider_id"))
        .or_else(|| string_field(metadata, "provider"))
        .or_else(|| {
            crate::agent::provider::resolve_provider_profile(config_snapshot, None, None)
                .map(|profile| profile.provider_id)
        })
}
