use crate::call_rust_state_service;
use crate::worker_agent_runtime::{
    NativeAgentRunContext, NativeAgentRuntimeServices, NativeAgentToolCall,
    NativeAgentToolDispatcher, NativeAgentToolResult,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
struct NativeAgentToolExecutorDispatcher {
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    fallback: Arc<dyn NativeAgentToolDispatcher>,
}

impl NativeAgentToolDispatcher for NativeAgentToolExecutorDispatcher {
    fn dispatch(
        &self,
        context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        if native_agent_tool_executor_should_fallback(&tool_call.name) {
            return self.fallback.dispatch(context, tool_call);
        }
        let arguments: serde_json::Value = serde_json::from_str(&tool_call.arguments_json)
            .map_err(|error| {
                format!(
                    "native tool `{}` arguments are invalid JSON: {error}",
                    tool_call.name
                )
            })?;
        let request_id = next_worker_request_correlation();
        let executor_result = call_rust_state_service(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            WorkerRequest::new(
                request_id.id("native-tool-executor"),
                request_id.trace_id("native-tool-executor"),
                "tool_executor.execute",
                serde_json::json!({
                    "toolId": tool_call.name,
                    "arguments": arguments,
                }),
            ),
            "native tool executor",
        );
        match executor_result {
            Ok(executor_result) => {
                let raw_result = executor_result
                    .get("result")
                    .cloned()
                    .unwrap_or_else(|| executor_result.clone());
                let model_content = native_tool_executor_model_content(&raw_result);
                Ok(NativeAgentToolResult::generic_success(
                    tool_call,
                    serde_json::json!({
                        "content": model_content,
                        "result": raw_result,
                        "executor": executor_result,
                    }),
                ))
            }
            Err(_error) if native_agent_tool_executor_can_fallback(tool_call) => {
                self.fallback.dispatch(context, tool_call)
            }
            Err(error) => Err(error),
        }
    }
}

pub(crate) fn native_agent_services_with_tool_executor(
    services: NativeAgentRuntimeServices,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> NativeAgentRuntimeServices {
    let fallback = services.tool_dispatcher();
    services.with_tool_dispatcher(Arc::new(NativeAgentToolExecutorDispatcher {
        workspace_root,
        config_snapshot,
        fallback,
    }))
}

fn native_agent_tool_executor_should_fallback(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "subagent.spawn"
            | "subagent.send_input"
            | "subagent.wait"
            | "subagent.query"
            | "subagent.cancel"
            | "subagent.close"
            | "spawn_agent"
            | "send_input"
            | "wait_agent"
            | "close_agent"
    )
}

fn native_agent_tool_executor_can_fallback(tool_call: &NativeAgentToolCall) -> bool {
    !tool_call.result.is_null()
}

fn native_tool_executor_model_content(value: &serde_json::Value) -> String {
    if let Some(content) = value.as_str() {
        return content.to_string();
    }
    if let Some(content) = value.get("content").and_then(serde_json::Value::as_str) {
        return content.to_string();
    }
    value.to_string()
}
