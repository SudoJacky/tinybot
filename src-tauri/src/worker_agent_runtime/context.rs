use super::continuations::queued_user_continuation_message;
use super::tool_router::NativeToolRouter;
use super::{
    string_field, AgentTurnSettings, ComposedInstructions, NativeAgentCancellation,
    NativeAgentCancellationContext, NativeAgentRunContext,
};
use crate::worker_capability::default_desktop_capability_policy;
use crate::worker_tool_registry::ToolExecutionTarget;
use crate::worker_tool_registry::WorkerToolRegistryRpc;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl NativeAgentRunContext {
    pub(super) fn from_spec(spec: Value, config_snapshot: Value) -> Self {
        let run_id = string_field(&spec, "runId")
            .or_else(|| string_field(&spec, "run_id"))
            .unwrap_or_else(|| "native-rust-run".to_string());
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
            .unwrap_or(1);
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
            WorkerToolRegistryRpc::new(default_desktop_capability_policy())
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
        Self {
            run_id,
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
            stream,
            max_iterations,
            settings,
            cancellation: None,
            tool_router,
        }
    }

    pub(super) fn attach_cancellation(
        &mut self,
        cancellations: Arc<dyn NativeAgentCancellation>,
        task_runtime: crate::runtime::agent_task::AgentTaskRuntime,
    ) {
        self.cancellation = Some(NativeAgentCancellationContext::new(
            self.run_id.clone(),
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
            return vec![serde_json::json!({ "role": role, "content": content })];
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
        .unwrap_or_else(|| crate::native_provider_runtime::configured_model(config_snapshot))
}

fn normalized_provider(spec: &Value, metadata: &Value, config_snapshot: &Value) -> Option<String> {
    string_field(spec, "provider")
        .or_else(|| string_field(spec, "providerId"))
        .or_else(|| string_field(spec, "provider_id"))
        .or_else(|| string_field(metadata, "provider"))
        .or_else(|| {
            config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| string_field(defaults, "provider"))
        })
}
