use super::{
    AgentTurnContext, NativeAgentToolCall, NativeAgentToolDispatcher, NativeAgentToolResult,
};
use crate::collaboration::subagents::{
    SubagentHistoryMode, SubagentInputSender, SubagentSendInputParams, SubagentSpawnParams,
    SubagentTargetParams, SubagentThreadManager, SubagentThreadStatus, SubagentWaitParams,
};
use crate::tools::registry::ToolCancellationMode;
use serde_json::Value;

pub struct FakeNativeAgentToolDispatcher;

impl NativeAgentToolDispatcher for FakeNativeAgentToolDispatcher {
    fn dispatch(
        &self,
        _context: &AgentTurnContext,
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
        context: &AgentTurnContext,
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
                    parent_turn_id: Some(context.turn_id.clone()),
                    parent_subagent_id: tool_arg_string(&context.metadata, "subagentId")
                        .or_else(|| tool_arg_string(&context.metadata, "subagent_id")),
                    delegation_depth: Some(
                        context
                            .metadata
                            .get("delegationDepth")
                            .or_else(|| context.metadata.get("delegation_depth"))
                            .or_else(|| context.metadata.get("depth"))
                            .and_then(Value::as_u64)
                            .and_then(|value| usize::try_from(value).ok())
                            .unwrap_or(0)
                            .saturating_add(1),
                    ),
                    history_mode: args
                        .get("historyMode")
                        .or_else(|| args.get("history_mode"))
                        .cloned()
                        .map(serde_json::from_value::<SubagentHistoryMode>)
                        .transpose()
                        .map_err(|error| {
                            format!("subagent.spawn historyMode is invalid: {error}")
                        })?,
                    subagent_id: tool_arg_string(&args, "subagentId")
                        .or_else(|| tool_arg_string(&args, "subagent_id"))
                        .or_else(|| tool_arg_string(&args, "agentId"))
                        .or_else(|| tool_arg_string(&args, "agent_id")),
                    child_turn_id: tool_arg_string(&args, "childTurnId")
                        .or_else(|| tool_arg_string(&args, "child_turn_id")),
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
                    turn_id: Some(context.turn_id.clone()),
                    child_turn_id: tool_arg_string(&args, "childTurnId")
                        .or_else(|| tool_arg_string(&args, "child_turn_id")),
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
                    self.subagents.wait_with_cancellation(
                        SubagentWaitParams {
                            session_key: tool_arg_string(&args, "sessionKey")
                                .or_else(|| tool_arg_string(&args, "session_key"))
                                .unwrap_or_else(|| context.session_id.clone()),
                            subagent_ids: ids,
                            timeout_ms: args
                                .get("timeoutMs")
                                .or_else(|| args.get("timeout_ms"))
                                .and_then(Value::as_u64),
                        },
                        || {
                            context
                                .cancellation
                                .as_ref()
                                .is_some_and(|cancellation| cancellation.is_cancelled())
                        },
                    ),
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
            "subagent.resume" | "resume_agent" => serde_json::to_value(
                self.subagents.resume(SubagentTargetParams {
                    session_key: tool_arg_string(&args, "sessionKey")
                        .or_else(|| tool_arg_string(&args, "session_key"))
                        .unwrap_or_else(|| context.session_id.clone()),
                    subagent_id: tool_arg_string(&args, "subagentId")
                        .or_else(|| tool_arg_string(&args, "subagent_id"))
                        .or_else(|| tool_arg_string(&args, "target"))
                        .or_else(|| tool_arg_string(&args, "id"))
                        .unwrap_or_default(),
                }),
            ),
            _ => unreachable!("subagent tool dispatch should be exhaustive"),
        }
        .map_err(|error| format!("native subagent tool result serialization failed: {error}"))?;
        Ok(NativeAgentToolResult::generic_success(tool_call, raw))
    }

    fn dispatch_async(
        self: std::sync::Arc<Self>,
        context: AgentTurnContext,
        tool_call: NativeAgentToolCall,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send>,
    > {
        Box::pin(async move { self.dispatch(&context, &tool_call) })
    }
}

pub(super) fn native_tool_is_permitted(context: &AgentTurnContext, name: &str) -> bool {
    registry_tool_available(context, name) || legacy_native_tool_alias_is_permitted(context, name)
}

pub(super) fn native_tool_supports_parallel(context: &AgentTurnContext, name: &str) -> bool {
    registry_tool_supports_parallel(context, name)
}

pub(super) fn native_tool_call_supports_parallel(
    context: &AgentTurnContext,
    tool_call: &NativeAgentToolCall,
) -> bool {
    if matches!(tool_call.name.as_str(), "shell.execute" | "exec_command") {
        return shell_call_supports_parallel(context, tool_call);
    }
    native_tool_supports_parallel(context, &tool_call.name)
}

pub(super) fn native_tool_waits_for_runtime_cancellation(
    context: &AgentTurnContext,
    name: &str,
) -> bool {
    registry_tool_waits_for_runtime_cancellation(context, name)
        || legacy_native_tool_alias_waits_for_runtime_cancellation(context, name)
}

pub(super) fn native_tool_mutates_workspace(context: &AgentTurnContext, name: &str) -> bool {
    registry_tool_mutates_workspace(context, name)
}

pub(super) fn native_tool_mutates_session(context: &AgentTurnContext, name: &str) -> bool {
    registry_tool_mutates_session(context, name)
        || legacy_native_tool_alias_mutates_session(context, name)
}

fn registry_tool_available(context: &AgentTurnContext, name: &str) -> bool {
    context.tool_router.is_permitted(name)
}

pub(super) fn native_tool_cancellation_mode(
    context: &AgentTurnContext,
    name: &str,
) -> ToolCancellationMode {
    if context.tool_router.is_permitted(name) {
        return context.tool_router.cancellation_mode(name);
    }
    legacy_native_tool_alias_policy_method(name)
        .map(|method| context.tool_router.cancellation_mode(method))
        .unwrap_or(ToolCancellationMode::Cooperative)
}

pub(super) fn native_tool_cleanup_timeout_ms(context: &AgentTurnContext, name: &str) -> u64 {
    if context.tool_router.is_permitted(name) {
        return context.tool_router.cleanup_timeout_ms(name);
    }
    legacy_native_tool_alias_policy_method(name)
        .map(|method| context.tool_router.cleanup_timeout_ms(method))
        .unwrap_or(100)
}

fn registry_tool_supports_parallel(context: &AgentTurnContext, name: &str) -> bool {
    context.tool_router.supports_parallel(name)
}

fn registry_tool_waits_for_runtime_cancellation(context: &AgentTurnContext, name: &str) -> bool {
    context.tool_router.waits_for_runtime_cancellation(name)
}

fn registry_tool_mutates_workspace(context: &AgentTurnContext, name: &str) -> bool {
    context.tool_router.mutates_workspace(name)
}

fn registry_tool_mutates_session(context: &AgentTurnContext, name: &str) -> bool {
    context.tool_router.mutates_session(name)
}

fn legacy_native_tool_alias_is_permitted(context: &AgentTurnContext, name: &str) -> bool {
    match name {
        "spawn_agent" => registry_tool_available(context, "subagent.spawn"),
        "send_input" => registry_tool_available(context, "subagent.send_input"),
        "wait_agent" => registry_tool_available(context, "subagent.wait"),
        "close_agent" => registry_tool_available(context, "subagent.close"),
        "resume_agent" => registry_tool_available(context, "subagent.resume"),
        "subagent.query" | "subagent.cancel" => {
            registry_tool_available(context, "subagent.spawn")
                || registry_tool_available(context, "subagent.send_input")
        }
        _ => false,
    }
}

fn legacy_native_tool_alias_waits_for_runtime_cancellation(
    context: &AgentTurnContext,
    name: &str,
) -> bool {
    match name {
        "spawn_agent" => registry_tool_waits_for_runtime_cancellation(context, "subagent.spawn"),
        "send_input" => {
            registry_tool_waits_for_runtime_cancellation(context, "subagent.send_input")
        }
        "wait_agent" => registry_tool_waits_for_runtime_cancellation(context, "subagent.wait"),
        "close_agent" => registry_tool_waits_for_runtime_cancellation(context, "subagent.close"),
        "resume_agent" => registry_tool_waits_for_runtime_cancellation(context, "subagent.resume"),
        "subagent.query" | "subagent.cancel" => {
            registry_tool_waits_for_runtime_cancellation(context, "subagent.spawn")
                || registry_tool_waits_for_runtime_cancellation(context, "subagent.send_input")
        }
        _ => false,
    }
}

fn legacy_native_tool_alias_mutates_session(context: &AgentTurnContext, name: &str) -> bool {
    match name {
        "spawn_agent" => registry_tool_mutates_session(context, "subagent.spawn"),
        "send_input" => registry_tool_mutates_session(context, "subagent.send_input"),
        "wait_agent" => registry_tool_mutates_session(context, "subagent.wait"),
        "close_agent" => registry_tool_mutates_session(context, "subagent.close"),
        "resume_agent" => registry_tool_mutates_session(context, "subagent.resume"),
        "subagent.query" | "subagent.cancel" => {
            registry_tool_mutates_session(context, "subagent.spawn")
                || registry_tool_mutates_session(context, "subagent.send_input")
        }
        _ => false,
    }
}

fn legacy_native_tool_alias_policy_method(name: &str) -> Option<&'static str> {
    match name {
        "spawn_agent" => Some("subagent.spawn"),
        "send_input" => Some("subagent.send_input"),
        "wait_agent" => Some("subagent.wait"),
        "close_agent" => Some("subagent.close"),
        "resume_agent" => Some("subagent.resume"),
        "subagent.query" | "subagent.cancel" => Some("subagent.spawn"),
        _ => None,
    }
}

fn shell_call_supports_parallel(
    context: &AgentTurnContext,
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

fn shell_parallel_policy(context: &AgentTurnContext) -> Option<&str> {
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
        || command.contains('&')
        || command.contains('>')
        || command.contains('<')
        || command.contains('`')
        || command.contains("&&")
        || command.contains("||")
        || command.contains("$(")
}

#[cfg(test)]
#[path = "tool_dispatcher_tests.rs"]
mod tests;

pub(super) fn is_subagent_tool(name: &str) -> bool {
    matches!(
        name,
        "subagent.spawn"
            | "subagent.send_input"
            | "subagent.wait"
            | "subagent.query"
            | "subagent.cancel"
            | "subagent.close"
            | "subagent.resume"
            | "spawn_agent"
            | "send_input"
            | "wait_agent"
            | "close_agent"
            | "resume_agent"
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
