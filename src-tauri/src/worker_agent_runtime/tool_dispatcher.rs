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
        if !native_tool_is_permitted(&tool_call.name) {
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
        if !native_tool_is_permitted(&tool_call.name) {
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

pub(super) fn native_tool_is_permitted(name: &str) -> bool {
    matches!(
        name,
        "workspace.read_file"
            | "workspace.list_files"
            | "knowledge.search"
            | "mcp.call_tool"
            | "subagent.spawn"
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
