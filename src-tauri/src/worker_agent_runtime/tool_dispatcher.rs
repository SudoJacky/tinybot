use super::{
    NativeAgentRunContext, NativeAgentToolCall, NativeAgentToolDispatcher, NativeAgentToolResult,
};
use crate::worker_subagent_manager::{
    SubagentInputSender, SubagentSendInputParams, SubagentSpawnParams, SubagentTargetParams,
    SubagentThreadManager, SubagentThreadStatus, SubagentWaitParams,
};
use serde_json::Value;

pub struct FakeNativeAgentToolDispatcher;

impl NativeAgentToolDispatcher for FakeNativeAgentToolDispatcher {
    fn dispatch(
        &self,
        _context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        if !native_tool_is_permitted(_context, &tool_call.name) {
            return Err(format!(
                "native tool `{}` is not permitted by Rust capability policy",
                tool_call.name
            ));
        }
        let _: Value = serde_json::from_str(&tool_call.arguments_json).map_err(|error| {
            format!(
                "native tool `{}` arguments are invalid JSON: {error}",
                tool_call.name
            )
        })?;
        Ok(NativeAgentToolResult::generic_success(
            tool_call,
            tool_call.result.clone(),
        ))
    }
}

pub struct SubagentNativeAgentToolDispatcher {
    subagents: SubagentThreadManager,
    fallback: FakeNativeAgentToolDispatcher,
}

impl SubagentNativeAgentToolDispatcher {
    pub fn new(subagents: SubagentThreadManager) -> Self {
        Self {
            subagents,
            fallback: FakeNativeAgentToolDispatcher,
        }
    }
}

impl NativeAgentToolDispatcher for SubagentNativeAgentToolDispatcher {
    fn dispatch(
        &self,
        context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        if !is_subagent_tool(&tool_call.name) {
            return self.fallback.dispatch(context, tool_call);
        }
        if !native_tool_is_permitted(context, &tool_call.name) {
            return Err(format!(
                "native tool `{}` is not permitted by Rust capability policy",
                tool_call.name
            ));
        }
        let args: Value = serde_json::from_str(&tool_call.arguments_json).map_err(|error| {
            format!(
                "native tool `{}` arguments are invalid JSON: {error}",
                tool_call.name
            )
        })?;
        let raw = match tool_call.name.as_str() {
            "subagent.spawn" | "spawn_agent" => serde_json::to_value(
                self.subagents.spawn(SubagentSpawnParams {
                    session_key: tool_arg_string(&args, "sessionKey")
                        .or_else(|| tool_arg_string(&args, "session_key"))
                        .unwrap_or_else(|| context.session_id.clone()),
                    parent_run_id: Some(context.run_id.clone()),
                    subagent_id: tool_arg_string(&args, "subagentId")
                        .or_else(|| tool_arg_string(&args, "subagent_id"))
                        .or_else(|| tool_arg_string(&args, "agentId"))
                        .or_else(|| tool_arg_string(&args, "agent_id")),
                    child_run_id: tool_arg_string(&args, "childRunId")
                        .or_else(|| tool_arg_string(&args, "child_run_id")),
                    trace_ref: tool_arg_string(&args, "traceRef")
                        .or_else(|| tool_arg_string(&args, "trace_ref")),
                    name: tool_arg_string(&args, "name")
                        .or_else(|| tool_arg_string(&args, "agentName"))
                        .or_else(|| tool_arg_string(&args, "agent_name")),
                    task: tool_arg_string(&args, "task")
                        .or_else(|| tool_arg_string(&args, "prompt"))
                        .or_else(|| tool_arg_string(&args, "message")),
                    status: Some(SubagentThreadStatus::Running),
                    created_at: None,
                    metadata: args.clone(),
                }),
            ),
            "subagent.send_input" | "send_input" => serde_json::to_value(
                self.subagents.enqueue_input(SubagentSendInputParams {
                    session_key: tool_arg_string(&args, "sessionKey")
                        .or_else(|| tool_arg_string(&args, "session_key"))
                        .unwrap_or_else(|| context.session_id.clone()),
                    subagent_id: tool_arg_string(&args, "subagentId")
                        .or_else(|| tool_arg_string(&args, "subagent_id"))
                        .or_else(|| tool_arg_string(&args, "target"))
                        .unwrap_or_default(),
                    content: tool_arg_string(&args, "content")
                        .or_else(|| tool_arg_string(&args, "message"))
                        .unwrap_or_default(),
                    sender: SubagentInputSender::MainAgent,
                    turn_id: Some(context.run_id.clone()),
                    child_run_id: tool_arg_string(&args, "childRunId")
                        .or_else(|| tool_arg_string(&args, "child_run_id")),
                    trace_ref: tool_arg_string(&args, "traceRef")
                        .or_else(|| tool_arg_string(&args, "trace_ref")),
                    created_at: None,
                    metadata: args.clone(),
                }),
            ),
            "subagent.wait" | "wait_agent" => {
                let ids = args
                    .get("targets")
                    .or_else(|| args.get("subagentIds"))
                    .or_else(|| args.get("subagent_ids"))
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .or_else(|| tool_arg_string(&args, "target").map(|value| vec![value]))
                    .unwrap_or_default();
                serde_json::to_value(
                    self.subagents.wait(SubagentWaitParams {
                        session_key: tool_arg_string(&args, "sessionKey")
                            .or_else(|| tool_arg_string(&args, "session_key"))
                            .unwrap_or_else(|| context.session_id.clone()),
                        subagent_ids: ids,
                        timeout_ms: args
                            .get("timeoutMs")
                            .or_else(|| args.get("timeout_ms"))
                            .and_then(Value::as_u64),
                    }),
                )
            }
            "subagent.query" => serde_json::to_value(
                self.subagents.query(SubagentTargetParams {
                    session_key: tool_arg_string(&args, "sessionKey")
                        .or_else(|| tool_arg_string(&args, "session_key"))
                        .unwrap_or_else(|| context.session_id.clone()),
                    subagent_id: tool_arg_string(&args, "subagentId")
                        .or_else(|| tool_arg_string(&args, "subagent_id"))
                        .or_else(|| tool_arg_string(&args, "target"))
                        .unwrap_or_default(),
                }),
            ),
            "subagent.cancel" => serde_json::to_value(
                self.subagents.cancel(SubagentTargetParams {
                    session_key: tool_arg_string(&args, "sessionKey")
                        .or_else(|| tool_arg_string(&args, "session_key"))
                        .unwrap_or_else(|| context.session_id.clone()),
                    subagent_id: tool_arg_string(&args, "subagentId")
                        .or_else(|| tool_arg_string(&args, "subagent_id"))
                        .or_else(|| tool_arg_string(&args, "target"))
                        .unwrap_or_default(),
                }),
            ),
            "subagent.close" | "close_agent" => serde_json::to_value(
                self.subagents.close(SubagentTargetParams {
                    session_key: tool_arg_string(&args, "sessionKey")
                        .or_else(|| tool_arg_string(&args, "session_key"))
                        .unwrap_or_else(|| context.session_id.clone()),
                    subagent_id: tool_arg_string(&args, "subagentId")
                        .or_else(|| tool_arg_string(&args, "subagent_id"))
                        .or_else(|| tool_arg_string(&args, "target"))
                        .unwrap_or_default(),
                }),
            ),
            _ => unreachable!("subagent tool dispatch should be exhaustive"),
        }
        .map_err(|error| format!("native subagent tool result serialization failed: {error}"))?;
        Ok(NativeAgentToolResult::generic_success(tool_call, raw))
    }
}

pub(super) fn native_tool_is_permitted(context: &NativeAgentRunContext, name: &str) -> bool {
    registry_tool_available(context, name) || legacy_native_tool_alias_is_permitted(context, name)
}

pub(super) fn native_tool_supports_parallel(context: &NativeAgentRunContext, name: &str) -> bool {
    registry_tool_supports_parallel(context, name)
        || legacy_native_tool_alias_supports_parallel(context, name)
}

pub(super) fn native_tool_call_supports_parallel(
    context: &NativeAgentRunContext,
    tool_call: &NativeAgentToolCall,
) -> bool {
    if tool_call.name == "mcp.call_tool" {
        return mcp_call_supports_parallel(context, tool_call);
    }
    if tool_call.name == "shell.execute" {
        return shell_call_supports_parallel(context, tool_call);
    }
    native_tool_supports_parallel(context, &tool_call.name)
}

pub(super) fn native_tool_waits_for_runtime_cancellation(
    context: &NativeAgentRunContext,
    name: &str,
) -> bool {
    registry_tool_waits_for_runtime_cancellation(context, name)
        || legacy_native_tool_alias_waits_for_runtime_cancellation(context, name)
}

pub(super) fn native_tool_mutates_workspace(context: &NativeAgentRunContext, name: &str) -> bool {
    registry_tool_mutates_workspace(context, name)
}

pub(super) fn native_tool_mutates_session(context: &NativeAgentRunContext, name: &str) -> bool {
    registry_tool_mutates_session(context, name)
        || legacy_native_tool_alias_mutates_session(context, name)
}

fn registry_tool_available(context: &NativeAgentRunContext, name: &str) -> bool {
    context
        .tool_registry_entries
        .iter()
        .any(|entry| entry.available && entry.method == name)
}

fn registry_tool_supports_parallel(context: &NativeAgentRunContext, name: &str) -> bool {
    context
        .tool_registry_entries
        .iter()
        .any(|entry| entry.available && entry.method == name && entry.supports_parallel_tool_calls)
}

fn registry_tool_waits_for_runtime_cancellation(
    context: &NativeAgentRunContext,
    name: &str,
) -> bool {
    context.tool_registry_entries.iter().any(|entry| {
        entry.available
            && entry.method == name
            && entry.runtime_policy.waits_for_runtime_cancellation
    })
}

fn registry_tool_mutates_workspace(context: &NativeAgentRunContext, name: &str) -> bool {
    context.tool_registry_entries.iter().any(|entry| {
        entry.available && entry.method == name && entry.runtime_policy.mutates_workspace
    })
}

fn registry_tool_mutates_session(context: &NativeAgentRunContext, name: &str) -> bool {
    context.tool_registry_entries.iter().any(|entry| {
        entry.available && entry.method == name && entry.runtime_policy.mutates_session
    })
}

fn legacy_native_tool_alias_is_permitted(context: &NativeAgentRunContext, name: &str) -> bool {
    match name {
        "workspace.list_files" => registry_tool_available(context, "workspace.read_file"),
        "knowledge.search" => registry_tool_available(context, "knowledge.query"),
        "spawn_agent" => registry_tool_available(context, "subagent.spawn"),
        "send_input" => registry_tool_available(context, "subagent.send_input"),
        "subagent.wait" | "subagent.query" | "subagent.cancel" | "subagent.close"
        | "wait_agent" | "close_agent" => {
            registry_tool_available(context, "subagent.spawn")
                || registry_tool_available(context, "subagent.send_input")
        }
        _ => false,
    }
}

fn legacy_native_tool_alias_supports_parallel(context: &NativeAgentRunContext, name: &str) -> bool {
    match name {
        "workspace.list_files" => registry_tool_supports_parallel(context, "workspace.read_file"),
        "knowledge.search" => registry_tool_supports_parallel(context, "knowledge.query"),
        _ => false,
    }
}

fn legacy_native_tool_alias_waits_for_runtime_cancellation(
    context: &NativeAgentRunContext,
    name: &str,
) -> bool {
    match name {
        "spawn_agent" => registry_tool_waits_for_runtime_cancellation(context, "subagent.spawn"),
        "send_input" => {
            registry_tool_waits_for_runtime_cancellation(context, "subagent.send_input")
        }
        "subagent.wait" | "subagent.query" | "subagent.cancel" | "subagent.close"
        | "wait_agent" | "close_agent" => {
            registry_tool_waits_for_runtime_cancellation(context, "subagent.spawn")
                || registry_tool_waits_for_runtime_cancellation(context, "subagent.send_input")
        }
        _ => false,
    }
}

fn legacy_native_tool_alias_mutates_session(context: &NativeAgentRunContext, name: &str) -> bool {
    match name {
        "spawn_agent" => registry_tool_mutates_session(context, "subagent.spawn"),
        "send_input" => registry_tool_mutates_session(context, "subagent.send_input"),
        "subagent.wait" | "subagent.query" | "subagent.cancel" | "subagent.close"
        | "wait_agent" | "close_agent" => {
            registry_tool_mutates_session(context, "subagent.spawn")
                || registry_tool_mutates_session(context, "subagent.send_input")
        }
        _ => false,
    }
}

fn mcp_call_supports_parallel(
    context: &NativeAgentRunContext,
    tool_call: &NativeAgentToolCall,
) -> bool {
    let Ok(arguments) = serde_json::from_str::<Value>(&tool_call.arguments_json) else {
        return false;
    };
    let Some(server_name) = arguments
        .get("server")
        .and_then(Value::as_str)
        .map(str::trim)
    else {
        return false;
    };
    let Some(tool_name) = arguments.get("tool").and_then(Value::as_str).map(str::trim) else {
        return false;
    };
    if server_name.is_empty() || tool_name.is_empty() {
        return false;
    }
    let Some(server) = context
        .config_snapshot
        .get("tools")
        .and_then(|tools| tools.get("mcp_servers").or_else(|| tools.get("mcpServers")))
        .and_then(|servers| servers.get(server_name))
    else {
        return false;
    };
    if !mcp_tool_is_enabled(server_name, tool_name, server) {
        return false;
    }
    server
        .get("supportsParallelToolCalls")
        .or_else(|| server.get("supports_parallel_tool_calls"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || mcp_tool_read_only_hint(server, tool_name)
}

fn mcp_tool_is_enabled(server_name: &str, tool_name: &str, server: &Value) -> bool {
    let Some(enabled_tools) = server
        .get("enabled_tools")
        .or_else(|| server.get("enabledTools"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    let wrapped_name = format!("mcp_{server_name}_{tool_name}");
    enabled_tools.iter().any(|value| {
        value.as_str().is_some_and(|enabled| {
            enabled == "*" || enabled == tool_name || enabled == wrapped_name
        })
    })
}

fn mcp_tool_read_only_hint(server: &Value, tool_name: &str) -> bool {
    let Some(tool) = server
        .get("fixture_tools")
        .or_else(|| server.get("fixtureTools"))
        .and_then(|tools| tools.get(tool_name))
    else {
        return false;
    };
    tool.get("annotations")
        .and_then(|annotations| {
            annotations
                .get("readOnlyHint")
                .or_else(|| annotations.get("read_only_hint"))
        })
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || tool
            .get("readOnlyHint")
            .or_else(|| tool.get("read_only_hint"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn shell_call_supports_parallel(
    context: &NativeAgentRunContext,
    tool_call: &NativeAgentToolCall,
) -> bool {
    if shell_parallel_policy(context) != Some("readOnlyCommandAllowlist") {
        return false;
    }
    let Ok(arguments) = serde_json::from_str::<Value>(&tool_call.arguments_json) else {
        return false;
    };
    let Some(command) = arguments.get("command").and_then(Value::as_str) else {
        return false;
    };
    shell_command_is_read_only_allowlisted(command)
}

fn shell_parallel_policy(context: &NativeAgentRunContext) -> Option<&str> {
    context
        .spec
        .get("nativeAgent")
        .and_then(|native_agent| native_agent.get("shellParallelPolicy"))
        .or_else(|| context.spec.get("shellParallelPolicy"))
        .or_else(|| {
            context
                .config_snapshot
                .get("nativeAgent")
                .and_then(|native_agent| native_agent.get("shellParallelPolicy"))
        })
        .and_then(Value::as_str)
}

fn shell_command_is_read_only_allowlisted(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() || shell_command_contains_unsafe_syntax(command) {
        return false;
    }
    let parts = command.split_whitespace().collect::<Vec<_>>();
    let Some(program) = parts.first().map(|part| part.to_ascii_lowercase()) else {
        return false;
    };
    match program.as_str() {
        "pwd" => parts.len() == 1,
        "ls" | "dir" | "rg" => true,
        "git" => parts.get(1).is_some_and(|subcommand| {
            matches!(
                subcommand.to_ascii_lowercase().as_str(),
                "status" | "diff" | "show"
            )
        }),
        "cargo" => {
            parts.len() == 3
                && parts[1].eq_ignore_ascii_case("fmt")
                && parts[2].eq_ignore_ascii_case("--check")
        }
        _ => false,
    }
}

fn shell_command_contains_unsafe_syntax(command: &str) -> bool {
    command.contains('|')
        || command.contains(';')
        || command.contains('>')
        || command.contains('<')
        || command.contains('`')
        || command.contains("&&")
        || command.contains("||")
        || command.contains("$(")
}

pub(super) fn is_subagent_tool(name: &str) -> bool {
    matches!(
        name,
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

fn tool_arg_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
