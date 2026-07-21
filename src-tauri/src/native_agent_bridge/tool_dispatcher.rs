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
    browser_runtime: Option<crate::native_browser::SharedBrowserRuntime>,
}

impl NativeAgentToolDispatcher for NativeAgentToolExecutorDispatcher {
    fn dispatch(
        &self,
        context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        if matches!(
            tool_call.name.as_str(),
            "browser.observe" | "browser.interact"
        ) {
            return Err(format!(
                "native tool `{}` requires asynchronous shared-browser dispatch",
                tool_call.name
            ));
        }
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
            if let Some(result) = self.dispatch_browser_if_needed(&context, &tool_call).await {
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
    let relative = working_directory
        .strip_prefix(workspace_root)
        .map_err(|_| {
            format!(
                "agent working directory `{}` is outside workspace `{}`",
                working_directory.display(),
                workspace_root.display()
            )
        })?;
    let working_directory = if relative.as_os_str().is_empty() {
        ".".to_string()
    } else {
        relative.to_string_lossy().replace('\\', "/")
    };
    object.insert(
        "workingDir".to_string(),
        serde_json::Value::String(working_directory),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_turn_working_directory, strip_browser_capture_data};

    #[test]
    fn turn_working_directory_becomes_shell_default_without_overriding_tool_input() {
        let workspace = std::path::PathBuf::from("D:/workspace");
        let turn_directory = workspace.join("project").join("task");
        let mut defaulted = serde_json::json!({ "command": "pwd" });
        apply_turn_working_directory(
            Some(&turn_directory),
            "exec_command",
            &mut defaulted,
            &workspace,
        )
        .expect("turn working directory should become shell default");
        let mut explicit = serde_json::json!({
            "command": "pwd",
            "workingDir": "other"
        });
        apply_turn_working_directory(
            Some(&turn_directory),
            "shell.start",
            &mut explicit,
            &workspace,
        )
        .expect("explicit shell working directory should remain valid");

        assert_eq!(defaulted["workingDir"], "project/task");
        assert_eq!(explicit["workingDir"], "other");
    }

    #[test]
    fn turn_working_directory_rejects_a_path_outside_the_workspace() {
        let workspace = std::path::PathBuf::from("D:/workspace");
        let mut arguments = serde_json::json!({ "command": "pwd" });

        let error = apply_turn_working_directory(
            Some(std::path::Path::new("D:/outside")),
            "shell.execute",
            &mut arguments,
            &workspace,
        )
        .expect_err("outside turn working directory must not reach shell dispatch");

        assert!(error.contains("outside workspace"));
    }

    #[test]
    fn browser_capture_bytes_are_not_returned_to_the_model_context() {
        let mut result = serde_json::json!({
            "capture": { "captureId": "capture-1", "dataUrl": "data:image/png;base64,AAAA" },
            "snapshot": {
                "data": {
                    "tabs": [{ "captures": [{ "captureId": "capture-1", "dataUrl": "data:image/png;base64,BBBB" }] }]
                }
            }
        });

        strip_browser_capture_data(&mut result);

        assert_eq!(result["capture"]["captureId"], "capture-1");
        assert!(result["capture"].get("dataUrl").is_none());
        assert!(result["snapshot"]["data"]["tabs"][0]["captures"][0]
            .get("dataUrl")
            .is_none());
    }
}

impl NativeAgentToolExecutorDispatcher {
    async fn dispatch_browser_if_needed(
        &self,
        context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Option<Result<NativeAgentToolResult, String>> {
        if !matches!(
            tool_call.name.as_str(),
            "browser.observe" | "browser.interact"
        ) {
            return None;
        }
        let runtime = match self.browser_runtime.clone() {
            Some(runtime) => runtime,
            None => {
                return Some(Err(
                    "TinyOS native browser runtime is not attached to the Agent service"
                        .to_string(),
                ));
            }
        };
        let mut arguments =
            match serde_json::from_str::<serde_json::Value>(&tool_call.arguments_json) {
                Ok(arguments) if arguments.is_object() => arguments,
                Ok(_) => {
                    return Some(Err(format!(
                        "native tool `{}` arguments must be a JSON object",
                        tool_call.name
                    )));
                }
                Err(error) => {
                    return Some(Err(format!(
                        "native tool `{}` arguments are invalid JSON: {error}",
                        tool_call.name
                    )));
                }
            };
        let result = match tool_call.name.as_str() {
            "browser.observe" => {
                dispatch_agent_browser_observe(&runtime, &context.session_id, arguments).await
            }
            "browser.interact" => {
                arguments["commandId"] = serde_json::Value::String(tool_call.id.clone());
                dispatch_agent_browser_interact(
                    &runtime,
                    &context.session_id,
                    context.cancellation.clone(),
                    arguments,
                )
                .await
            }
            _ => unreachable!("browser tool dispatch should be exhaustive"),
        };
        Some(result.and_then(|raw| {
            let mut raw = serde_json::to_value(raw).map_err(|error| {
                format!("native browser tool result serialization failed: {error}")
            })?;
            strip_browser_capture_data(&mut raw);
            Ok(NativeAgentToolResult::generic_success(tool_call, raw))
        }))
    }

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
    let browser_runtime = services.browser_runtime();
    services.with_tool_dispatcher(Arc::new(NativeAgentToolExecutorDispatcher {
        workspace_root,
        config_snapshot,
        fallback,
        mcp_runtime,
        shell_runtime,
        subagent_manager,
        browser_runtime,
    }))
}

pub(crate) async fn dispatch_agent_browser_observe(
    runtime: &crate::native_browser::SharedBrowserRuntime,
    owner_session_id: &str,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let capabilities = runtime.capabilities();
    if !capabilities.session_snapshot.available {
        return Err(capabilities
            .session_snapshot
            .reason
            .unwrap_or_else(|| "TinyOS browser sessions are unavailable".to_string()));
    }
    let capture = arguments
        .get("capture")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let semantic = arguments
        .get("semantic")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    if capture && !capabilities.real_capture.available {
        return Err(capabilities
            .real_capture
            .reason
            .unwrap_or_else(|| "TinyOS browser capture is unavailable".to_string()));
    }
    if semantic && !capabilities.semantic_observation.available {
        return Err(capabilities
            .semantic_observation
            .reason
            .unwrap_or_else(|| "TinyOS browser semantic observation is unavailable".to_string()));
    }
    let requested_session_id = optional_text(&arguments, "browserSessionId")?;
    let snapshot = match runtime.snapshot_for_owner(owner_session_id) {
        Some(snapshot) => snapshot,
        None if requested_session_id.is_some() => {
            return Err(
                "The requested TinyOS browser session is not owned by this chat".to_string(),
            );
        }
        None => {
            runtime
                .create_session(
                    serde_json::from_value::<crate::native_browser::BrowserCreateSessionInput>(
                        serde_json::json!({ "ownerSessionId": owner_session_id }),
                    )
                    .map_err(|error| {
                        format!("failed to create TinyOS browser session input: {error}")
                    })?,
                )
                .await?
        }
    };
    ensure_agent_browser_owner(&snapshot, requested_session_id.as_deref())?;
    let requested_tab_id = optional_text(&arguments, "tabId")?;
    let tab_id = requested_tab_id
        .as_deref()
        .unwrap_or_else(|| snapshot.data.active_tab_id.as_str());
    ensure_agent_browser_tab(&snapshot, tab_id)?;
    let input =
        serde_json::from_value::<crate::native_browser::BrowserObserveInput>(serde_json::json!({
            "browserSessionId": snapshot.data.browser_session_id.as_str(),
            "tabId": tab_id,
            "capture": capture,
            "semantic": semantic,
        }))
        .map_err(|error| format!("browser.observe payload is invalid: {error}"))?;
    serde_json::to_value(runtime.observe(input).await?)
        .map_err(|error| format!("browser.observe result serialization failed: {error}"))
}

pub(crate) async fn dispatch_agent_browser_interact(
    runtime: &crate::native_browser::SharedBrowserRuntime,
    owner_session_id: &str,
    cancellation: Option<crate::worker_agent_runtime::NativeAgentCancellationContext>,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let capabilities = runtime.capabilities();
    if !capabilities.agent_interaction.available {
        return Err(capabilities
            .agent_interaction
            .reason
            .unwrap_or_else(|| "TinyOS Agent browser interaction is unavailable".to_string()));
    }
    let input = serde_json::from_value::<crate::native_browser::BrowserInteractionInput>(arguments)
        .map_err(|error| format!("browser.interact payload is invalid: {error}"))?;
    let snapshot = runtime
        .snapshot_for_owner(owner_session_id)
        .ok_or_else(|| {
            "Open or observe the TinyOS browser before interacting with it".to_string()
        })?;
    ensure_agent_browser_owner(&snapshot, Some(input.browser_session_id.as_str()))?;
    ensure_agent_browser_tab(&snapshot, input.tab_id.as_str())?;
    let tab_id = input.tab_id.clone();
    let command_id = input.command_id.clone();
    if cancellation
        .as_ref()
        .is_some_and(|cancellation| cancellation.is_cancelled())
    {
        return Err("Agent browser command was cancelled before dispatch".to_string());
    }
    let interaction = runtime.interact(input);
    tokio::pin!(interaction);
    let result = if let Some(cancellation) = cancellation {
        tokio::select! {
            result = &mut interaction => result,
            _ = cancellation.cancelled() => {
                if runtime.cancel_agent_command(&tab_id, &command_id) {
                    interaction.await
                } else {
                    return Err("Agent browser command was cancelled before dispatch".to_string());
                }
            }
        }
    } else {
        interaction.await
    }?;
    serde_json::to_value(result)
        .map_err(|error| format!("browser.interact result serialization failed: {error}"))
}

fn ensure_agent_browser_owner(
    snapshot: &crate::native_browser::BrowserNativeSnapshot,
    requested_session_id: Option<&str>,
) -> Result<(), String> {
    if snapshot.data.session_id.is_empty() {
        return Err("TinyOS browser snapshot has no owning chat session".to_string());
    }
    if requested_session_id
        .is_some_and(|requested| requested != snapshot.data.browser_session_id.as_str())
    {
        return Err("The requested TinyOS browser session is not owned by this chat".to_string());
    }
    Ok(())
}

fn ensure_agent_browser_tab(
    snapshot: &crate::native_browser::BrowserNativeSnapshot,
    tab_id: &str,
) -> Result<(), String> {
    snapshot
        .data
        .tabs
        .iter()
        .any(|tab| tab.tab_id.as_str() == tab_id)
        .then_some(())
        .ok_or_else(|| {
            "The requested TinyOS browser tab is not part of this chat session".to_string()
        })
}

fn optional_text(value: &serde_json::Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(text)) if !text.trim().is_empty() => {
            Ok(Some(text.trim().to_string()))
        }
        Some(_) => Err(format!("{key} must be a non-empty string")),
    }
}

fn strip_browser_capture_data(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.remove("dataUrl");
            for child in object.values_mut() {
                strip_browser_capture_data(child);
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                strip_browser_capture_data(child);
            }
        }
        _ => {}
    }
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

fn native_tool_executor_model_content(value: &serde_json::Value) -> String {
    if let Some(content) = value.as_str() {
        return content.to_string();
    }
    if let Some(content) = value.get("content").and_then(serde_json::Value::as_str) {
        return content.to_string();
    }
    value.to_string()
}
