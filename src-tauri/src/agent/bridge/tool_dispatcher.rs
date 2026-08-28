use crate::agent::runtime::{
    AgentTurnContext, NativeAgentCancellationContext, NativeAgentRuntimeServices,
    NativeAgentToolDispatcher, NativeAgentToolResult, NativeToolNextAction, NativeToolOutcome,
    NativeToolRetry, PreparedToolCall,
};
use crate::collaboration::subagents::SubagentThreadManager;
use crate::protocol::{WorkerRequest, WorkerRequestCancellation};
use crate::rpc::call_rust_state_service_with_mcp_runtime;
use crate::runtime::mcp::{
    configured_mcp_servers, mcp_tool_is_enabled, McpRuntime, McpRuntimeError, McpRuntimeErrorKind,
};
use crate::threads::workspace_store::WorkspaceThreadStore;
use crate::tools::registry::ToolExecutionTarget;
use crate::tools::shell::WorkerShellRuntime;
use crate::tools::web::{self, WebToolCancellation};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
struct NativeAgentToolExecutorDispatcher {
    workspace_root: PathBuf,
    thread_store: WorkspaceThreadStore,
    base_services: NativeAgentRuntimeServices,
    base_config_snapshot: serde_json::Value,
    fallback: Arc<dyn NativeAgentToolDispatcher>,
    mcp_runtime: McpRuntime,
    shell_runtime: WorkerShellRuntime,
    subagent_manager: SubagentThreadManager,
    browser_runtime: Option<crate::native_browser::SharedBrowserRuntime>,
}

impl WebToolCancellation for NativeAgentCancellationContext {
    fn is_cancelled(&self) -> bool {
        NativeAgentCancellationContext::is_cancelled(self)
    }

    fn cancelled(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(NativeAgentCancellationContext::cancelled(self))
    }
}

impl NativeAgentToolDispatcher for NativeAgentToolExecutorDispatcher {
    fn dispatch(
        &self,
        context: &AgentTurnContext,
        tool_call: &PreparedToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        if web::is_web_tool(&tool_call.name) {
            return Err(format!(
                "native tool `{}` requires asynchronous shared-browser dispatch",
                tool_call.name
            ));
        }
        if native_agent_tool_executor_should_fallback(&tool_call.name) {
            return self.fallback.dispatch(context, tool_call);
        }
        let mut arguments = tool_call.arguments_value();
        apply_turn_working_directory(
            context.settings.working_directory.as_deref(),
            &tool_call.name,
            &mut arguments,
            &self.workspace_root,
        )?;
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
        if matches!(
            &execution_target,
            Some(ToolExecutionTarget::AgentGraph { .. })
        ) {
            return Err(format!(
                "native tool `{}` requires asynchronous Agent Graph dispatch",
                tool_call.name
            ));
        }
        let cancellation = context
            .cancellation
            .clone()
            .map(|cancellation| Arc::new(cancellation) as Arc<dyn WorkerRequestCancellation>);
        let tool_workspace_root = match &execution_target {
            Some(ToolExecutionTarget::WorkerRpc { method }) if method.starts_with("workspace.") => {
                context
                    .settings
                    .working_directory
                    .clone()
                    .unwrap_or_else(|| self.workspace_root.clone())
            }
            Some(ToolExecutionTarget::Mcp { .. }) => context
                .settings
                .working_directory
                .clone()
                .unwrap_or_else(|| self.workspace_root.clone()),
            _ => self.workspace_root.clone(),
        };
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
                    "turnId": context.turn_id,
                    "toolCallId": tool_call.id,
                }),
                "native tool executor",
            ),
        };
        let executor_result = call_rust_state_service_with_mcp_runtime(
            &self.thread_store,
            tool_workspace_root,
            context.config_snapshot.clone(),
            self.mcp_runtime.clone(),
            self.shell_runtime.clone(),
            self.subagent_manager.clone(),
            WorkerRequest::new(
                format!("{}:tool:{}", context.trace_context.request_id, tool_call.id),
                context.trace_context.trace_id.clone(),
                method,
                params,
            )
            .with_cancellation(cancellation),
            label,
        );
        match executor_result {
            Ok(executor_result) => {
                native_tool_result_from_executor_response(tool_call, executor_result)
            }
            Err(error) if is_shell_agent_tool(&tool_call.name) => {
                Ok(native_shell_dispatch_error_result(tool_call, error))
            }
            Err(error) => Err(error),
        }
    }

    fn dispatch_async(
        self: Arc<Self>,
        context: AgentTurnContext,
        tool_call: PreparedToolCall,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send>,
    > {
        Box::pin(async move {
            if let Some(result) = self
                .dispatch_agent_graph_if_needed(&context, &tool_call)
                .await
            {
                return result;
            }
            if let Some(result) = self.dispatch_web_if_needed(&context, &tool_call).await {
                return result;
            }
            if let Some(result) = self.dispatch_mcp_if_needed(&context, &tool_call).await {
                return result;
            }
            self.dispatch(&context, &tool_call)
        })
    }
}

fn apply_turn_working_directory(
    turn_working_directory: Option<&std::path::Path>,
    tool_name: &str,
    arguments: &mut serde_json::Value,
    workspace_root: &std::path::Path,
) -> Result<(), String> {
    if !matches!(tool_name, "exec_command" | "shell.start" | "shell.execute") {
        return Ok(());
    }
    let object = arguments.as_object_mut().ok_or_else(|| {
        format!("native shell tool `{tool_name}` arguments must be a JSON object")
    })?;
    if ["workingDir", "working_dir", "workdir", "cwd"]
        .iter()
        .any(|key| object.contains_key(*key))
    {
        return Ok(());
    }
    let Some(working_directory) = turn_working_directory else {
        return Ok(());
    };
    let working_directory = match working_directory.strip_prefix(workspace_root) {
        Ok(relative) if relative.as_os_str().is_empty() => ".".to_string(),
        Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
        Err(_) => working_directory.to_string_lossy().to_string(),
    };
    object.insert(
        "workingDir".to_string(),
        serde_json::Value::String(working_directory),
    );
    Ok(())
}

#[cfg(test)]
#[path = "tool_dispatcher_tests.rs"]
mod tests;

impl NativeAgentToolExecutorDispatcher {
    async fn dispatch_agent_graph_if_needed(
        &self,
        context: &AgentTurnContext,
        tool_call: &PreparedToolCall,
    ) -> Option<Result<NativeAgentToolResult, String>> {
        let target = context.tool_execution_target(&tool_call.name);
        let ToolExecutionTarget::AgentGraph {
            definition_workspace_path,
            graph_id,
            graph_revision,
        } = target?
        else {
            return None;
        };
        let arguments = tool_call.arguments_value();
        let input = arguments
            .as_object()
            .filter(|object| object.len() == 1)
            .and_then(|object| object.get("input"))
            .and_then(serde_json::Value::as_str)
            .filter(|input| !input.trim().is_empty())
            .map(str::to_string);
        let Some(input) = input else {
            return Some(Ok(NativeAgentToolResult::generic_error(
                tool_call,
                "Agent Graph tool requires exactly one non-empty string field: `input`".to_string(),
            )));
        };
        let run = crate::graph_runs::start(
            self.thread_store.data_root(),
            self.base_services.clone(),
            self.workspace_root.clone(),
            self.base_config_snapshot.clone(),
            crate::graph_runs::StartAgentGraphRunInput {
                graph_id,
                graph_revision,
                definition_workspace_path,
                input,
            },
            context.cancellation.clone(),
        )
        .await;
        Some(run.and_then(|run| {
            let raw = serde_json::to_value(&run)
                .map_err(|error| format!("Agent Graph Run serialization failed: {error}"))?;
            native_agent_graph_tool_result(tool_call, raw)
        }))
    }

    async fn dispatch_web_if_needed(
        &self,
        context: &AgentTurnContext,
        tool_call: &PreparedToolCall,
    ) -> Option<Result<NativeAgentToolResult, String>> {
        if !web::is_web_tool(&tool_call.name) {
            return None;
        }
        let runtime = match self.browser_runtime.clone() {
            Some(runtime) => runtime,
            None => {
                return Some(Err(
                    "Native browser runtime is not attached to the Agent service".to_string(),
                ));
            }
        };
        let mut arguments = tool_call.arguments_value();
        let result = match tool_call.name.as_str() {
            "web.open" => {
                arguments["commandId"] = serde_json::Value::String(tool_call.id.clone());
                web::dispatch_web_open(
                    &runtime,
                    &context.session_id,
                    context
                        .cancellation
                        .as_ref()
                        .map(|cancellation| cancellation as &dyn WebToolCancellation),
                    arguments,
                )
                .await
            }
            "web.read" => web::dispatch_web_read(&runtime, &context.session_id, arguments).await,
            "web.act" => {
                arguments["commandId"] = serde_json::Value::String(tool_call.id.clone());
                web::dispatch_web_act(
                    &runtime,
                    &context.session_id,
                    context
                        .cancellation
                        .as_ref()
                        .map(|cancellation| cancellation as &dyn WebToolCancellation),
                    arguments,
                )
                .await
            }
            _ => unreachable!("web tool dispatch should be exhaustive"),
        };
        Some(result.and_then(|raw| {
            let mut raw = serde_json::to_value(raw).map_err(|error| {
                format!("native browser tool result serialization failed: {error}")
            })?;
            web::strip_browser_capture_data(&mut raw);
            Ok(native_web_tool_result(tool_call, raw))
        }))
    }

    async fn dispatch_mcp_if_needed(
        &self,
        context: &AgentTurnContext,
        tool_call: &PreparedToolCall,
    ) -> Option<Result<NativeAgentToolResult, String>> {
        let arguments = tool_call.arguments_value();
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
                let (server, tool) = match (server, tool) {
                    (Some(server), Some(tool)) => (server, tool),
                    (server, tool) => {
                        return Some(Ok(native_mcp_failure_result(
                            tool_call,
                            server.as_deref(),
                            tool.as_deref(),
                            "invalid_request",
                            "mcp_request_invalid",
                            "mcp.call_tool requires non-empty server and tool fields".to_string(),
                            NativeToolRetry::Replan,
                        )));
                    }
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
            return Some(Ok(native_mcp_failure_result(
                tool_call,
                Some(&server_name),
                Some(&tool_name),
                "invalid_request",
                "mcp_arguments_invalid",
                "MCP tool arguments must be a JSON object".to_string(),
                NativeToolRetry::Replan,
            )));
        }
        let Some(server_config) = configured_mcp_servers(&context.config_snapshot)
            .and_then(|servers| servers.get(&server_name))
        else {
            return Some(Ok(native_mcp_failure_result(
                tool_call,
                Some(&server_name),
                Some(&tool_name),
                "user_action_required",
                "mcp_server_not_configured",
                format!("MCP server is not configured: {server_name}"),
                NativeToolRetry::AfterUserAction,
            )));
        };
        if server_config
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        {
            return Some(Ok(native_mcp_failure_result(
                tool_call,
                Some(&server_name),
                Some(&tool_name),
                "user_action_required",
                "mcp_server_disabled",
                format!("MCP server is disabled: {server_name}"),
                NativeToolRetry::AfterUserAction,
            )));
        }
        if !mcp_tool_is_enabled(&server_name, &tool_name, server_config) {
            return Some(Ok(native_mcp_failure_result(
                tool_call,
                Some(&server_name),
                Some(&tool_name),
                "user_action_required",
                "mcp_tool_not_allowlisted",
                format!("MCP tool is not allowlisted: {server_name}.{tool_name}"),
                NativeToolRetry::AfterUserAction,
            )));
        }
        let cancellation = context
            .cancellation
            .clone()
            .map(|cancellation| Arc::new(cancellation) as Arc<dyn WorkerRequestCancellation>);
        let result = self
            .mcp_runtime
            .call_tool(
                context
                    .settings
                    .working_directory
                    .as_deref()
                    .unwrap_or(&self.workspace_root),
                &server_name,
                server_config,
                &tool_name,
                Some(tool_arguments),
                cancellation,
            )
            .await;
        Some(result.map_or_else(
            |error| {
                Ok(native_mcp_runtime_error_result(
                    tool_call, &tool_name, error,
                ))
            },
            |result| {
                let model_content = native_tool_executor_model_content(&result);
                let raw = serde_json::json!({
                    "content": model_content,
                    "result": result,
                    "server": server_name,
                    "tool": tool_name,
                });
                Ok(native_mcp_tool_result(tool_call, raw))
            },
        ))
    }
}

fn native_agent_graph_tool_result(
    tool_call: &PreparedToolCall,
    raw: serde_json::Value,
) -> Result<NativeAgentToolResult, String> {
    let status = raw
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("failed");
    if status != "completed" {
        let error = raw
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Agent Graph Run did not complete");
        return Ok(NativeAgentToolResult::generic_error(
            tool_call,
            format!("Agent Graph Run {status}: {error}"),
        ));
    }
    let output = raw
        .get("output")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "completed Agent Graph Run has no output".to_string())?
        .to_string();
    let run_id = raw
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    Ok(NativeAgentToolResult::generic_success_with_model_content(
        tool_call,
        format!("Agent Graph Run `{run_id}` completed."),
        output.clone(),
        serde_json::json!({
            "graphRunId": run_id,
            "status": status,
            "output": output,
        }),
    ))
}

fn native_web_tool_result(
    tool_call: &PreparedToolCall,
    raw: serde_json::Value,
) -> NativeAgentToolResult {
    if let Some(outcome) = native_web_tool_outcome(&tool_call.name, &raw) {
        return NativeAgentToolResult::success_with_outcome(tool_call, raw, outcome);
    }
    let summary = web::result_summary(&tool_call.name, &raw);
    let model_content = raw.to_string();
    NativeAgentToolResult::generic_success_with_model_content(
        tool_call,
        summary,
        model_content,
        raw,
    )
}

fn native_web_tool_outcome(tool_name: &str, raw: &serde_json::Value) -> Option<NativeToolOutcome> {
    let status = raw.get("status").and_then(serde_json::Value::as_str)?;
    let action_executed = raw
        .get("actionExecuted")
        .and_then(serde_json::Value::as_bool);
    let result_reason_code = || {
        raw.get("reasonCode")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let result_reason = || {
        raw.get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };

    let outcome = match status {
        "completed" => return None,
        "unchanged" => NativeToolOutcome {
            effect: "unchanged".to_string(),
            action_executed,
            reason_code: "page_unchanged".to_string(),
            reason: "The page has not changed since the supplied snapshot.".to_string(),
            retry: NativeToolRetry::DoNotRetry,
            next_action: None,
        },
        "stale_snapshot" => {
            let reason = if tool_name == "web.read" {
                "The page changed while paginated text was being read. The returned content restarted at offset 0 with a new snapshot."
            } else {
                "The page changed after the supplied snapshot was captured, so the requested action was not executed."
            };
            NativeToolOutcome {
                effect: "stale_state".to_string(),
                action_executed: Some(false),
                reason_code: "snapshot_stale".to_string(),
                reason: reason.to_string(),
                retry: NativeToolRetry::RetryWithUpdatedState,
                next_action: None,
            }
        }
        "navigation_required" => {
            let next_action = raw
                .get("suggestedUrl")
                .and_then(serde_json::Value::as_str)
                .map(|url| NativeToolNextAction {
                    tool: "web.open".to_string(),
                    arguments: serde_json::json!({ "url": url }),
                });
            NativeToolOutcome {
                effect: "alternative_required".to_string(),
                action_executed: Some(false),
                reason_code: result_reason_code()
                    .unwrap_or_else(|| "navigation_required".to_string()),
                reason: result_reason().unwrap_or_else(|| {
                    "The requested target cannot be activated in the current browser tab."
                        .to_string()
                }),
                retry: NativeToolRetry::DoNotRetry,
                next_action,
            }
        }
        "user_required" => NativeToolOutcome {
            effect: "user_action_required".to_string(),
            action_executed: Some(false),
            reason_code: result_reason_code().unwrap_or_else(|| "user_required".to_string()),
            reason: result_reason().unwrap_or_else(|| {
                "The browser requires direct user interaction before Agent work can continue."
                    .to_string()
            }),
            retry: NativeToolRetry::AfterUserAction,
            next_action: None,
        },
        "failed" | "cancelled" | "timed_out" => NativeToolOutcome {
            effect: status.to_string(),
            action_executed: Some(false),
            reason_code: result_reason_code().unwrap_or_else(|| status.to_string()),
            reason: result_reason()
                .unwrap_or_else(|| format!("The browser action returned {status}.")),
            retry: NativeToolRetry::Replan,
            next_action: None,
        },
        other => NativeToolOutcome {
            effect: "unrecognized".to_string(),
            action_executed,
            reason_code: result_reason_code().unwrap_or_else(|| other.to_string()),
            reason: result_reason()
                .unwrap_or_else(|| format!("The web tool returned the special status `{other}`.")),
            retry: NativeToolRetry::Replan,
            next_action: None,
        },
    };
    Some(outcome)
}

pub(crate) fn native_agent_services_with_tool_executor(
    services: NativeAgentRuntimeServices,
    workspace_root: PathBuf,
    base_config_snapshot: serde_json::Value,
) -> Result<NativeAgentRuntimeServices, String> {
    let base_services = services.clone();
    let fallback = services.tool_dispatcher();
    let thread_store = services.thread_store()?;
    let mcp_runtime = services.mcp_runtime();
    let shell_runtime = services.shell_runtime();
    let subagent_manager = services.subagent_manager();
    let browser_runtime = services.browser_runtime();
    Ok(
        services.with_tool_dispatcher(Arc::new(NativeAgentToolExecutorDispatcher {
            workspace_root,
            thread_store,
            base_services,
            base_config_snapshot,
            fallback,
            mcp_runtime,
            shell_runtime,
            subagent_manager,
            browser_runtime,
        })),
    )
}

fn normalize_subagent_arguments(
    context: &AgentTurnContext,
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
    object.remove("parent_turn_id");
    object.insert(
        "parentTurnId".to_string(),
        serde_json::Value::String(context.turn_id.clone()),
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

fn native_tool_executor_result(
    mut executor_result: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let raw_result = executor_result
        .as_object_mut()
        .ok_or_else(|| "native tool executor result must be an object".to_string())?
        .remove("result")
        .ok_or_else(|| "native tool executor result is missing `result`".to_string())?;
    Ok(raw_result)
}

fn native_tool_result_from_executor_response(
    tool_call: &PreparedToolCall,
    executor_result: serde_json::Value,
) -> Result<NativeAgentToolResult, String> {
    let raw_result = native_tool_executor_result(executor_result)?;
    if is_persisted_subagent_tool(&tool_call.name) {
        return Ok(NativeAgentToolResult::generic_success(
            tool_call, raw_result,
        ));
    }
    if let Some(outcome) = native_shell_tool_outcome(&tool_call.name, &raw_result) {
        return Ok(NativeAgentToolResult::success_with_outcome(
            tool_call, raw_result, outcome,
        ));
    }
    let model_content = native_tool_executor_model_content(&raw_result);
    let summary = native_tool_executor_summary(&raw_result, &model_content);
    Ok(NativeAgentToolResult::generic_success_with_model_content(
        tool_call,
        summary,
        model_content,
        raw_result,
    ))
}

fn is_shell_agent_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "exec_command" | "write_stdin" | "shell.start" | "shell.execute"
    )
}

fn native_shell_tool_outcome(
    tool_name: &str,
    raw: &serde_json::Value,
) -> Option<NativeToolOutcome> {
    if !is_shell_agent_tool(tool_name) {
        return None;
    }

    let cancelled = bool_field(raw, "cancelled", "cancelled").unwrap_or(false)
        || string_field(raw, "status", "status") == Some("cancelled");
    if cancelled {
        return Some(NativeToolOutcome {
            effect: "cancelled".to_string(),
            action_executed: None,
            reason_code: "shell_cancelled".to_string(),
            reason: "The shell command was cancelled before a complete result was available."
                .to_string(),
            retry: NativeToolRetry::DoNotRetry,
            next_action: None,
        });
    }

    let timed_out = bool_field(raw, "timedOut", "timed_out").unwrap_or(false)
        || string_field(raw, "status", "status") == Some("timed_out");
    if timed_out {
        return Some(NativeToolOutcome {
            effect: "timed_out".to_string(),
            action_executed: None,
            reason_code: "shell_timed_out".to_string(),
            reason:
                "The shell command exceeded its time limit and did not produce a complete result."
                    .to_string(),
            retry: NativeToolRetry::Replan,
            next_action: None,
        });
    }

    let status = string_field(raw, "status", "status");
    let running = bool_field(raw, "running", "running").unwrap_or(false)
        || matches!(status, Some("running" | "terminating"));
    if running {
        let process_id = string_field(raw, "processId", "process_id");
        let truncated = bool_field(raw, "truncated", "truncated").unwrap_or(false);
        let reason = match (process_id, truncated) {
            (Some(process_id), true) => format!(
                "Shell process `{process_id}` is still running; earlier output was truncated."
            ),
            (Some(process_id), false) => {
                format!("Shell process `{process_id}` is still running.")
            }
            (None, true) => {
                "The shell command is still running; earlier output was truncated.".to_string()
            }
            (None, false) => "The shell command is still running.".to_string(),
        };
        let next_action = process_id.map(|process_id| {
            let mut arguments = serde_json::json!({
                "processId": process_id,
                "input": "",
                "yieldTimeMs": 1000,
            });
            if let Some(cursor) = integer_field(raw, "cursor", "cursor") {
                arguments["cursor"] = serde_json::json!(cursor);
            }
            NativeToolNextAction {
                tool: "write_stdin".to_string(),
                arguments,
            }
        });
        return Some(NativeToolOutcome {
            effect: "in_progress".to_string(),
            action_executed: Some(true),
            reason_code: if truncated {
                "shell_running_output_truncated".to_string()
            } else {
                "shell_process_running".to_string()
            },
            reason,
            retry: NativeToolRetry::RetryWithUpdatedState,
            next_action,
        });
    }

    if matches!(status, Some("failed" | "terminated"))
        || raw.get("failure").is_some_and(|failure| !failure.is_null())
    {
        let reason = raw
            .get("failure")
            .and_then(serde_json::Value::as_str)
            .filter(|reason| !reason.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| match status {
                Some("terminated") => "The shell process was terminated.".to_string(),
                _ => "The shell process failed before completing.".to_string(),
            });
        return Some(NativeToolOutcome {
            effect: "failed".to_string(),
            action_executed: None,
            reason_code: match status {
                Some("terminated") => "shell_terminated".to_string(),
                _ => "shell_process_failed".to_string(),
            },
            reason,
            retry: NativeToolRetry::Replan,
            next_action: None,
        });
    }

    if let Some(exit_code) = integer_field(raw, "exitCode", "exit_code") {
        if exit_code != 0 {
            return Some(NativeToolOutcome {
                effect: "failed".to_string(),
                action_executed: Some(true),
                reason_code: "shell_nonzero_exit".to_string(),
                reason: format!("The shell command exited with code {exit_code}."),
                retry: NativeToolRetry::Replan,
                next_action: None,
            });
        }
    }

    if bool_field(raw, "truncated", "truncated").unwrap_or(false) {
        let dropped_bytes = integer_field(raw, "droppedBytes", "dropped_bytes").unwrap_or(0);
        let reason = if dropped_bytes > 0 {
            format!("The shell command completed, but {dropped_bytes} output bytes were discarded.")
        } else {
            "The shell command completed, but its output was truncated.".to_string()
        };
        return Some(NativeToolOutcome {
            effect: "partial_result".to_string(),
            action_executed: Some(true),
            reason_code: "shell_output_truncated".to_string(),
            reason,
            retry: NativeToolRetry::DoNotRetry,
            next_action: None,
        });
    }

    None
}

fn native_shell_dispatch_error_result(
    tool_call: &PreparedToolCall,
    error: String,
) -> NativeAgentToolResult {
    let raw = serde_json::json!({
        "status": "failed",
        "error": {
            "message": error,
        },
    });
    let outcome = NativeToolOutcome {
        effect: "failed".to_string(),
        action_executed: Some(false),
        reason_code: "shell_dispatch_failed".to_string(),
        reason: raw["error"]["message"]
            .as_str()
            .unwrap_or("Shell dispatch failed")
            .to_string(),
        retry: NativeToolRetry::Replan,
        next_action: None,
    };
    NativeAgentToolResult::success_with_outcome(tool_call, raw, outcome)
}

fn native_mcp_tool_result(
    tool_call: &PreparedToolCall,
    raw: serde_json::Value,
) -> NativeAgentToolResult {
    let is_error = raw
        .get("result")
        .and_then(|result| {
            bool_field(result, "isError", "is_error")
                .or_else(|| bool_field(result, "is_error", "isError"))
        })
        .unwrap_or(false);
    if !is_error {
        return NativeAgentToolResult::generic_success(tool_call, raw);
    }
    let server = raw
        .get("server")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let tool = raw
        .get("tool")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let outcome = NativeToolOutcome {
        effect: "failed".to_string(),
        action_executed: Some(true),
        reason_code: "mcp_tool_error".to_string(),
        reason: format!("MCP tool `{server}.{tool}` returned an error result."),
        retry: NativeToolRetry::Replan,
        next_action: None,
    };
    NativeAgentToolResult::success_with_outcome(tool_call, raw, outcome)
}

fn native_mcp_runtime_error_result(
    tool_call: &PreparedToolCall,
    tool_name: &str,
    error: McpRuntimeError,
) -> NativeAgentToolResult {
    let effect = match error.kind {
        McpRuntimeErrorKind::Configuration => "user_action_required",
        McpRuntimeErrorKind::Timeout => "timed_out",
        McpRuntimeErrorKind::Cancelled => "cancelled",
        McpRuntimeErrorKind::InvalidArguments
        | McpRuntimeErrorKind::ServerStarting
        | McpRuntimeErrorKind::Operation
        | McpRuntimeErrorKind::Shutdown => "failed",
    };
    let reason_code = error.kind.reason_code();
    let retry = match error.kind {
        McpRuntimeErrorKind::Configuration => NativeToolRetry::AfterUserAction,
        McpRuntimeErrorKind::Cancelled => NativeToolRetry::DoNotRetry,
        McpRuntimeErrorKind::InvalidArguments
        | McpRuntimeErrorKind::ServerStarting
        | McpRuntimeErrorKind::Timeout
        | McpRuntimeErrorKind::Operation
        | McpRuntimeErrorKind::Shutdown => NativeToolRetry::Replan,
    };
    let reason = error.message.clone();
    let raw = serde_json::json!({
        "status": effect,
        "server": error.server,
        "tool": tool_name,
        "error": {
            "reasonCode": reason_code,
            "message": error.message,
            "transport": error.transport,
            "retryable": error.retryable,
            "cancelled": error.cancelled,
        },
    });
    NativeAgentToolResult::success_with_outcome(
        tool_call,
        raw,
        NativeToolOutcome {
            effect: effect.to_string(),
            action_executed: None,
            reason_code: reason_code.to_string(),
            reason,
            retry,
            next_action: None,
        },
    )
}

fn native_mcp_failure_result(
    tool_call: &PreparedToolCall,
    server: Option<&str>,
    tool: Option<&str>,
    effect: &str,
    reason_code: &str,
    reason: String,
    retry: NativeToolRetry,
) -> NativeAgentToolResult {
    let outcome_reason = reason.clone();
    let raw = serde_json::json!({
        "status": "failed",
        "server": server,
        "tool": tool,
        "error": {
            "reasonCode": reason_code,
            "message": reason,
        },
    });
    NativeAgentToolResult::success_with_outcome(
        tool_call,
        raw,
        NativeToolOutcome {
            effect: effect.to_string(),
            action_executed: Some(false),
            reason_code: reason_code.to_string(),
            reason: outcome_reason,
            retry,
            next_action: None,
        },
    )
}

fn bool_field(value: &serde_json::Value, primary: &str, alias: &str) -> Option<bool> {
    value
        .get(primary)
        .or_else(|| value.get(alias))
        .and_then(serde_json::Value::as_bool)
}

fn string_field<'a>(value: &'a serde_json::Value, primary: &str, alias: &str) -> Option<&'a str> {
    value
        .get(primary)
        .or_else(|| value.get(alias))
        .and_then(serde_json::Value::as_str)
}

fn integer_field(value: &serde_json::Value, primary: &str, alias: &str) -> Option<i64> {
    value
        .get(primary)
        .or_else(|| value.get(alias))
        .and_then(serde_json::Value::as_i64)
}

fn native_tool_executor_summary(value: &serde_json::Value, model_content: &str) -> String {
    if value.get("processId").is_none() || value.get("output").is_none() {
        return model_content.to_string();
    }
    if value
        .get("running")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return "Command is running".to_string();
    }
    match value.get("exitCode").and_then(serde_json::Value::as_i64) {
        Some(0) => "Command completed".to_string(),
        Some(exit_code) => format!("Command exited with code {exit_code}"),
        None if value
            .get("failure")
            .is_some_and(|failure| !failure.is_null()) =>
        {
            "Command failed".to_string()
        }
        None => "Command finished".to_string(),
    }
}

fn native_tool_executor_model_content(value: &serde_json::Value) -> String {
    if let Some(content) = value.as_str() {
        return content.to_string();
    }
    if let Some(content) = value.get("content").and_then(serde_json::Value::as_str) {
        return content.to_string();
    }
    if let Some(content) = compact_shell_process_model_content(value) {
        return content;
    }
    value.to_string()
}

fn compact_shell_process_model_content(value: &serde_json::Value) -> Option<String> {
    let source = value.as_object()?;
    if !source.contains_key("processId") || !source.contains_key("output") {
        return None;
    }
    let mut compact = serde_json::Map::new();
    for field in [
        "processId",
        "status",
        "running",
        "exitCode",
        "output",
        "cursor",
        "truncated",
        "droppedBytes",
        "failure",
    ] {
        if let Some(field_value) = source
            .get(field)
            .filter(|field_value| !field_value.is_null())
        {
            compact.insert(field.to_string(), field_value.clone());
        }
    }
    Some(serde_json::Value::Object(compact).to_string())
}
