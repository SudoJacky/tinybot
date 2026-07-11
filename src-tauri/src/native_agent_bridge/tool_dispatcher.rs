use crate::call_rust_state_service_with_mcp_runtime;
use crate::runtime::mcp::{configured_mcp_servers, mcp_tool_is_enabled, McpRuntime};
use crate::worker_agent_runtime::{
    NativeAgentRunContext, NativeAgentRuntimeServices, NativeAgentToolCall,
    NativeAgentToolDispatcher, NativeAgentToolResult,
};
use crate::worker_protocol::{WorkerRequest, WorkerRequestCancellation};
use crate::worker_shell::WorkerShellRuntime;
use crate::worker_subagent_manager::SubagentThreadManager;
use crate::worker_tool_registry::ToolExecutionTarget;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
struct NativeAgentToolExecutorDispatcher {
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    fallback: Arc<dyn NativeAgentToolDispatcher>,
    mcp_runtime: McpRuntime,
    shell_runtime: WorkerShellRuntime,
    subagent_manager: SubagentThreadManager,
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
        let mut arguments: serde_json::Value = serde_json::from_str(&tool_call.arguments_json)
            .map_err(|error| {
                format!(
                    "native tool `{}` arguments are invalid JSON: {error}",
                    tool_call.name
                )
            })?;
        normalize_subagent_arguments(context, &tool_call.name, &mut arguments)?;
        let execution_target = context.tool_execution_target(&tool_call.name);
        if matches!(
            &execution_target,
            Some(ToolExecutionTarget::RuntimeControl(_))
        ) {
            return Err(format!(
                "runtime control tool `{}` must be handled by the native agent runtime",
                tool_call.name
            ));
        }
        let cancellation = context
            .cancellation
            .clone()
            .map(|cancellation| Arc::new(cancellation) as Arc<dyn WorkerRequestCancellation>);
        let (method, params, label) = match execution_target {
            Some(ToolExecutionTarget::Mcp { server, tool }) => (
                "mcp.call_tool",
                serde_json::json!({
                    "server": server,
                    "tool": tool,
                    "arguments": arguments,
                }),
                "native MCP tool",
            ),
            _ => (
                "tool_executor.execute",
                serde_json::json!({
                    "toolId": tool_call.name,
                    "arguments": arguments,
                    "sessionId": context.session_id,
                    "runId": context.run_id,
                    "toolCallId": tool_call.id,
                }),
                "native tool executor",
            ),
        };
        let executor_result = call_rust_state_service_with_mcp_runtime(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            self.mcp_runtime.clone(),
            self.shell_runtime.clone(),
            self.subagent_manager.clone(),
            WorkerRequest::new(
                format!("{}:tool:{}", context.trace_context.request_id, tool_call.id),
                context.trace_context.trace_id.clone(),
                method,
                params,
            )
            .with_trusted_internal()
            .with_cancellation(cancellation),
            label,
        );
        match executor_result {
            Ok(executor_result) => {
                let raw_result = executor_result
                    .get("result")
                    .cloned()
                    .unwrap_or_else(|| executor_result.clone());
                let model_content = native_tool_executor_model_content(&raw_result);
                if is_persisted_subagent_tool(&tool_call.name) {
                    Ok(NativeAgentToolResult::generic_success(
                        tool_call, raw_result,
                    ))
                } else {
                    Ok(NativeAgentToolResult::generic_success(
                        tool_call,
                        serde_json::json!({
                            "content": model_content,
                            "result": raw_result,
                            "executor": executor_result,
                        }),
                    ))
                }
            }
            Err(_error) if native_agent_tool_executor_can_fallback(tool_call) => {
                self.fallback.dispatch(context, tool_call)
            }
            Err(error) => Err(error),
        }
    }

    fn dispatch_async(
        self: Arc<Self>,
        context: NativeAgentRunContext,
        tool_call: NativeAgentToolCall,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send>,
    > {
        Box::pin(async move {
            if let Some(result) = self.dispatch_mcp_if_needed(&context, &tool_call).await {
                return result;
            }
            tauri::async_runtime::spawn_blocking(move || self.dispatch(&context, &tool_call))
                .await
                .map_err(|error| format!("native tool execution task failed: {error}"))?
        })
    }
}

impl NativeAgentToolExecutorDispatcher {
    async fn dispatch_mcp_if_needed(
        &self,
        context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Option<Result<NativeAgentToolResult, String>> {
        let arguments = match serde_json::from_str::<serde_json::Value>(&tool_call.arguments_json) {
            Ok(arguments) => arguments,
            Err(error) => {
                return Some(Err(format!(
                    "native tool `{}` arguments are invalid JSON: {error}",
                    tool_call.name
                )));
            }
        };
        let target = context.tool_execution_target(&tool_call.name);
        let (server_name, tool_name, tool_arguments) = match target {
            Some(ToolExecutionTarget::Mcp { server, tool }) => (server, tool, arguments),
            _ if tool_call.name == "mcp.call_tool" => {
                let server = arguments
                    .get("server")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let tool = arguments
                    .get("tool")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let (Some(server), Some(tool)) = (server, tool) else {
                    return Some(Err(
                        "mcp.call_tool requires non-empty server and tool fields".to_string(),
                    ));
                };
                let tool_arguments = arguments
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                (server, tool, tool_arguments)
            }
            _ => return None,
        };
        if !tool_arguments.is_object() {
            return Some(Err("MCP tool arguments must be a JSON object".to_string()));
        }
        let Some(server_config) = configured_mcp_servers(&context.config_snapshot)
            .and_then(|servers| servers.get(&server_name))
        else {
            return Some(Err(format!("MCP server is not configured: {server_name}")));
        };
        if server_config
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        {
            return Some(Err(format!("MCP server is disabled: {server_name}")));
        }
        if !mcp_tool_is_enabled(&server_name, &tool_name, server_config) {
            return Some(Err(format!(
                "MCP tool is not allowlisted: {server_name}.{tool_name}"
            )));
        }
        let cancellation = context
            .cancellation
            .clone()
            .map(|cancellation| Arc::new(cancellation) as Arc<dyn WorkerRequestCancellation>);
        let result = self
            .mcp_runtime
            .call_tool(
                &self.workspace_root,
                &server_name,
                server_config,
                &tool_name,
                Some(tool_arguments),
                cancellation,
            )
            .await
            .map_err(|error| error.message);
        Some(result.map(|result| {
            let model_content = native_tool_executor_model_content(&result);
            NativeAgentToolResult::generic_success(
                tool_call,
                serde_json::json!({
                    "content": model_content,
                    "result": result,
                    "server": server_name,
                    "tool": tool_name,
                }),
            )
        }))
    }
}

pub(crate) fn native_agent_services_with_tool_executor(
    services: NativeAgentRuntimeServices,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> NativeAgentRuntimeServices {
    let fallback = services.tool_dispatcher();
    let mcp_runtime = services.mcp_runtime();
    let shell_runtime = services.shell_runtime();
    let subagent_manager = services.subagent_manager();
    services.with_tool_dispatcher(Arc::new(NativeAgentToolExecutorDispatcher {
        workspace_root,
        config_snapshot,
        fallback,
        mcp_runtime,
        shell_runtime,
        subagent_manager,
    }))
}

fn normalize_subagent_arguments(
    context: &NativeAgentRunContext,
    tool_name: &str,
    arguments: &mut serde_json::Value,
) -> Result<(), String> {
    if !is_persisted_subagent_tool(tool_name) {
        return Ok(());
    }
    let object = arguments.as_object_mut().ok_or_else(|| {
        format!("native subagent tool `{tool_name}` arguments must be a JSON object")
    })?;
    object.remove("session_key");
    object.insert(
        "sessionKey".to_string(),
        serde_json::Value::String(context.session_id.clone()),
    );
    if tool_name == "subagent.send_input" {
        object.insert(
            "sender".to_string(),
            serde_json::Value::String("main_agent".to_string()),
        );
    }
    if tool_name != "subagent.spawn" {
        return Ok(());
    }
    object.remove("parent_run_id");
    object.insert(
        "parentRunId".to_string(),
        serde_json::Value::String(context.run_id.clone()),
    );
    object.remove("trace_ref");
    object.insert(
        "traceRef".to_string(),
        serde_json::Value::String(context.trace_context.trace_id.clone()),
    );
    let parent_subagent_id = ["subagentId", "subagent_id", "agentId", "agent_id"]
        .iter()
        .find_map(|key| {
            context
                .metadata
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
    if let Some(parent_subagent_id) = parent_subagent_id {
        object.insert(
            "parentSubagentId".to_string(),
            serde_json::Value::String(parent_subagent_id),
        );
    } else {
        object.remove("parentSubagentId");
        object.remove("parentAgentId");
    }
    let parent_depth = context
        .metadata
        .get("delegationDepth")
        .or_else(|| context.metadata.get("delegation_depth"))
        .or_else(|| context.metadata.get("depth"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    object.insert(
        "delegationDepth".to_string(),
        serde_json::json!(parent_depth.saturating_add(1)),
    );
    Ok(())
}

fn is_persisted_subagent_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "subagent.spawn"
            | "subagent.send_input"
            | "subagent.wait"
            | "subagent.close"
            | "subagent.resume"
    )
}

fn native_agent_tool_executor_should_fallback(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "subagent.query"
            | "subagent.cancel"
            | "spawn_agent"
            | "send_input"
            | "wait_agent"
            | "close_agent"
            | "resume_agent"
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
