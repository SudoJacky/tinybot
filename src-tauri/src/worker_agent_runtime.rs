use crate::worker_subagent_manager::{
    SubagentInputSender, SubagentSendInputParams, SubagentSpawnParams, SubagentTargetParams,
    SubagentThreadManager, SubagentThreadStatus, SubagentWaitParams,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    ops::{Deref, DerefMut},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeAgentRuntimeMode {
    Rust,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NativeAgentEvent {
    #[serde(rename = "eventName")]
    pub event_name: String,
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct NativeAgentRunContext {
    pub run_id: String,
    pub session_id: String,
    pub spec: Value,
    pub messages: Vec<Value>,
    pub config_snapshot: Value,
    pub metadata: Value,
    pub model: String,
    pub provider: Option<String>,
    pub stream: bool,
    pub max_iterations: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NativeAgentRunPhase {
    ActiveTurn,
    AwaitingTool,
    Cancelled,
    Terminal,
}

impl NativeAgentRunPhase {
    fn as_str(&self) -> &'static str {
        match self {
            Self::ActiveTurn => "active_turn",
            Self::AwaitingTool => "awaiting_tool",
            Self::Cancelled => "cancelled",
            Self::Terminal => "terminal",
        }
    }
}

#[derive(Clone, Debug)]
struct NativeAgentRunState {
    phase: NativeAgentRunPhase,
    iteration: i64,
    max_iterations: i64,
    pending_tool_calls: Vec<Value>,
    completed_tool_results: Vec<Value>,
    messages: Vec<Value>,
    events: Vec<NativeAgentEvent>,
    usage: Vec<Value>,
    tools_used: Vec<String>,
    stop_reason: Option<String>,
}

impl NativeAgentRunState {
    fn new(context: &NativeAgentRunContext) -> Self {
        Self {
            phase: NativeAgentRunPhase::ActiveTurn,
            iteration: 0,
            max_iterations: context.max_iterations,
            pending_tool_calls: Vec::new(),
            completed_tool_results: Vec::new(),
            messages: context.messages.clone(),
            events: Vec::new(),
            usage: Vec::new(),
            tools_used: Vec::new(),
            stop_reason: None,
        }
    }

    fn set_phase(&mut self, phase: NativeAgentRunPhase, iteration: i64) {
        self.phase = phase;
        self.iteration = iteration;
    }

    fn set_stop_reason(&mut self, stop_reason: &str) {
        self.stop_reason = Some(stop_reason.to_string());
        self.phase = NativeAgentRunPhase::Terminal;
    }

    fn active_checkpoint_payload(&self, status: &str) -> Value {
        serde_json::json!({
            "status": status,
            "iteration": self.iteration,
            "maxIterations": self.max_iterations,
            "pendingToolCalls": self.pending_tool_calls,
            "completedToolResults": self.completed_tool_results,
            "stopReason": self.stop_reason,
        })
    }

    fn set_pending_tool_call(&mut self, tool_call: &NativeAgentToolCall) {
        self.phase = NativeAgentRunPhase::AwaitingTool;
        self.pending_tool_calls = vec![serde_json::json!({
            "toolCallId": tool_call.id,
            "toolName": tool_call.name,
            "argumentsJson": tool_call.arguments_json,
        })];
    }

    fn clear_pending_tool_calls(&mut self) {
        self.pending_tool_calls.clear();
    }
}

#[derive(Clone, Debug)]
pub struct NativeAgentProviderResponse {
    pub final_content: String,
    pub reasoning_delta: Option<String>,
    pub usage: Option<Value>,
    pub tool_calls: Vec<NativeAgentToolCall>,
}

#[derive(Clone, Debug)]
pub struct NativeAgentToolCall {
    pub id: String,
    pub name: String,
    pub arguments_json: String,
    pub result: Value,
}

#[derive(Clone, Debug)]
pub struct NativeAgentToolResult {
    pub content: Value,
    pub envelope: NativeToolResultEnvelope,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct NativeToolResultEnvelope {
    value: Value,
}

impl NativeToolResultEnvelope {
    pub fn generic_success(tool_call: &NativeAgentToolCall, raw_content: Value) -> Self {
        let model_content = legacy_tool_content(&raw_content);
        Self::from_parts(
            "ok",
            model_content.clone(),
            model_content,
            "generic_result",
            tool_call.name.clone(),
            serde_json::json!({
                "kind": "generic_result",
                "value": raw_content,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            raw_content,
        )
    }

    pub fn generic_error(
        tool_call: &NativeAgentToolCall,
        summary: String,
        raw_content: Value,
    ) -> Self {
        Self::from_parts(
            "error",
            summary.clone(),
            summary,
            "generic_error",
            tool_call.name.clone(),
            serde_json::json!({
                "kind": "generic_error",
                "value": raw_content,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            raw_content,
        )
    }

    pub fn file_excerpt(tool_call: &NativeAgentToolCall, path: String, excerpt: String) -> Self {
        Self::from_parts(
            "ok",
            format!("Read file excerpt: {path}"),
            excerpt.clone(),
            "file_excerpt",
            path.clone(),
            serde_json::json!({
                "kind": "file_excerpt",
                "path": path,
                "excerpt": excerpt,
            }),
            serde_json::json!([{ "type": "workspace_file", "path": path }]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            serde_json::json!({ "path": path, "excerpt": excerpt }),
        )
    }

    pub fn search_results(tool_call: &NativeAgentToolCall, query: String, matches: Value) -> Self {
        let match_count = matches.as_array().map_or(0, Vec::len);
        Self::from_parts(
            "ok",
            format!("Found {match_count} result(s) for {query}"),
            matches.to_string(),
            "search_results",
            query.clone(),
            serde_json::json!({
                "kind": "search_results",
                "query": query,
                "matches": matches,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            serde_json::json!({ "query": query, "matches": matches }),
        )
    }

    pub fn command_output(
        tool_call: &NativeAgentToolCall,
        command: String,
        exit_code: i64,
        stdout: String,
        stderr: String,
    ) -> Self {
        let summary = format!("Command exited with code {exit_code}: {command}");
        let model_content = if stderr.trim().is_empty() {
            stdout.clone()
        } else {
            format!("{stdout}\n{stderr}")
        };
        Self::from_parts(
            "ok",
            summary,
            model_content,
            "command_output",
            command.clone(),
            serde_json::json!({
                "kind": "command_output",
                "command": command,
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([{ "type": "command", "command": command, "exitCode": exit_code }]),
            tool_call,
            serde_json::json!({
                "command": command,
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
            }),
        )
    }

    pub fn knowledge_context(
        tool_call: &NativeAgentToolCall,
        summary: String,
        snippets: Value,
    ) -> Self {
        Self::from_parts(
            "ok",
            summary.clone(),
            snippets.to_string(),
            "knowledge_context",
            summary,
            serde_json::json!({
                "kind": "knowledge_context",
                "snippets": snippets,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            serde_json::json!({ "snippets": snippets }),
        )
    }

    fn from_parts(
        status: &str,
        summary: String,
        model_content: String,
        ui_type: &str,
        title: String,
        structured: Value,
        references: Value,
        artifacts: Value,
        side_effects: Value,
        tool_call: &NativeAgentToolCall,
        raw_content: Value,
    ) -> Self {
        Self {
            value: serde_json::json!({
                "status": status,
                "summary": summary,
                "modelContent": model_content,
                "structured": structured,
                "ui": {
                    "type": ui_type,
                    "title": title,
                    "actions": [],
                },
                "references": references,
                "artifacts": artifacts,
                "sideEffects": side_effects,
                "metrics": {
                    "durationMs": Value::Null,
                    "modelChars": model_content.chars().count(),
                    "rawChars": raw_content.to_string().chars().count(),
                },
                "trace": {
                    "toolCallId": tool_call.id,
                    "toolName": tool_call.name,
                },
                "continuation": Value::Null,
                "redactions": [],
                "truncation": {
                    "truncated": false,
                },
                "raw": raw_content,
            }),
        }
    }
}

impl Deref for NativeToolResultEnvelope {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl DerefMut for NativeToolResultEnvelope {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.value
    }
}

impl NativeAgentToolResult {
    fn generic_success(tool_call: &NativeAgentToolCall, raw_content: Value) -> Self {
        let envelope = NativeToolResultEnvelope::generic_success(tool_call, raw_content);
        let model_content = envelope
            .get("modelContent")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Self {
            content: Value::String(model_content),
            envelope,
        }
    }
}

pub trait NativeAgentProvider: Send + Sync {
    fn complete(
        &self,
        context: &NativeAgentRunContext,
    ) -> Result<NativeAgentProviderResponse, String>;
}

pub trait NativeAgentToolDispatcher: Send + Sync {
    fn dispatch(
        &self,
        context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String>;
}

pub trait NativeAgentCheckpointStore: Send + Sync {
    fn save(&self, session_id: &str, checkpoint: Value);
    fn save_for_run(&self, session_id: &str, run_id: &str, checkpoint: Value);
    fn restore(&self, session_id: &str) -> Option<Value>;
    fn restore_for_run(&self, session_id: &str, run_id: &str) -> Option<Value>;
    fn clear(&self, session_id: &str);
    fn clear_for_run(&self, session_id: &str, run_id: &str);
}

pub trait NativeAgentCancellation: Send + Sync {
    fn cancel(&self, run_id: &str);
    fn is_cancelled(&self, run_id: &str) -> bool;
}

#[derive(Clone)]
pub struct NativeAgentRuntimeServices {
    provider: Arc<dyn NativeAgentProvider>,
    tools: Arc<dyn NativeAgentToolDispatcher>,
    checkpoints: Arc<dyn NativeAgentCheckpointStore>,
    cancellations: Arc<dyn NativeAgentCancellation>,
    subagents: SubagentThreadManager,
}

impl NativeAgentRuntimeServices {
    pub fn new(
        provider: Arc<dyn NativeAgentProvider>,
        tools: Arc<dyn NativeAgentToolDispatcher>,
        checkpoints: Arc<dyn NativeAgentCheckpointStore>,
        cancellations: Arc<dyn NativeAgentCancellation>,
    ) -> Self {
        Self {
            provider,
            tools,
            checkpoints,
            cancellations,
            subagents: SubagentThreadManager::default(),
        }
    }

    pub fn with_subagent_manager(subagents: SubagentThreadManager) -> Self {
        Self::new(
            Arc::new(RustNativeAgentProvider),
            Arc::new(SubagentNativeAgentToolDispatcher::new(subagents.clone())),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_subagents(subagents)
    }

    fn with_subagents(mut self, subagents: SubagentThreadManager) -> Self {
        self.subagents = subagents;
        self
    }

    pub fn subagent_manager(&self) -> SubagentThreadManager {
        self.subagents.clone()
    }

    pub fn cancel(&self, run_id: &str) -> Value {
        self.cancellations.cancel(run_id);
        serde_json::json!({
            "runtime": "rust",
            "runId": run_id,
            "cancelled": true,
            "finalContent": "",
            "stopReason": "cancelled",
            "error": "cancelled",
            "messages": [],
            "toolsUsed": [],
            "events": [event_value("agent.cancelled", serde_json::json!({
                "runId": run_id,
                "cancelled": true,
                "stopReason": "cancelled",
                "error": "cancelled",
            }))],
        })
    }

    pub fn restore_checkpoint(&self, session_id: &str) -> Value {
        serde_json::json!({
            "runtime": "rust",
            "sessionId": session_id,
            "checkpoint": self.checkpoints.restore(session_id),
        })
    }

    pub fn restore_run_checkpoint(&self, session_id: &str, run_id: &str) -> Value {
        serde_json::json!({
            "runtime": "rust",
            "sessionId": session_id,
            "runId": run_id,
            "checkpoint": self.checkpoints.restore_for_run(session_id, run_id),
        })
    }

    pub fn save_checkpoint(&self, session_id: &str, checkpoint: Value) {
        self.checkpoints.save(session_id, checkpoint);
    }

    pub fn save_run_checkpoint(&self, session_id: &str, run_id: &str, checkpoint: Value) {
        self.checkpoints
            .save_for_run(session_id, run_id, checkpoint);
    }

    pub fn clear_run_checkpoint(&self, session_id: &str, run_id: &str) {
        self.checkpoints.clear_for_run(session_id, run_id);
    }
}

impl Default for NativeAgentRuntimeServices {
    fn default() -> Self {
        let subagents = SubagentThreadManager::default();
        Self::new(
            Arc::new(RustNativeAgentProvider),
            Arc::new(SubagentNativeAgentToolDispatcher::new(subagents.clone())),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_subagents(subagents)
    }
}

#[derive(Default)]
pub struct InMemoryNativeAgentCheckpointStore {
    checkpoints: Mutex<HashMap<String, StoredNativeCheckpoint>>,
    sequence: AtomicU64,
}

#[derive(Clone, Debug)]
struct StoredNativeCheckpoint {
    checkpoint: Value,
    sequence: u64,
}

impl NativeAgentCheckpointStore for InMemoryNativeAgentCheckpointStore {
    fn save(&self, session_id: &str, checkpoint: Value) {
        let run_id =
            checkpoint_run_id(&checkpoint).unwrap_or_else(|| legacy_session_run_id(session_id));
        self.save_for_run(session_id, &run_id, checkpoint);
    }

    fn save_for_run(&self, session_id: &str, run_id: &str, checkpoint: Value) {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .insert(
                checkpoint_key(session_id, run_id),
                StoredNativeCheckpoint {
                    checkpoint,
                    sequence,
                },
            );
    }

    fn restore(&self, session_id: &str) -> Option<Value> {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .iter()
            .filter_map(|(key, stored)| {
                checkpoint_key_session(key)
                    .filter(|key_session_id| *key_session_id == session_id)
                    .map(|_| stored)
            })
            .max_by_key(|stored| stored.sequence)
            .map(|stored| stored.checkpoint.clone())
    }

    fn restore_for_run(&self, session_id: &str, run_id: &str) -> Option<Value> {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .get(&checkpoint_key(session_id, run_id))
            .map(|stored| stored.checkpoint.clone())
    }

    fn clear(&self, session_id: &str) {
        let mut checkpoints = self
            .checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned");
        let Some(key) = checkpoints
            .iter()
            .filter(|(key, _stored)| {
                checkpoint_key_session(key)
                    .is_some_and(|key_session_id| key_session_id == session_id)
            })
            .max_by_key(|(_key, stored)| stored.sequence)
            .map(|(key, _stored)| key.clone())
        else {
            return;
        };
        checkpoints.remove(&key);
    }

    fn clear_for_run(&self, session_id: &str, run_id: &str) {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .remove(&checkpoint_key(session_id, run_id));
    }
}

fn checkpoint_key(session_id: &str, run_id: &str) -> String {
    format!("{session_id}\u{1f}{run_id}")
}

fn checkpoint_key_session(key: &str) -> Option<&str> {
    key.split_once('\u{1f}')
        .map(|(session_id, _run_id)| session_id)
}

fn checkpoint_run_id(checkpoint: &Value) -> Option<String> {
    checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn legacy_session_run_id(session_id: &str) -> String {
    format!("legacy-session:{session_id}")
}

#[derive(Default)]
pub struct InMemoryNativeAgentCancellation {
    cancelled_runs: Mutex<HashSet<String>>,
}

impl NativeAgentCancellation for InMemoryNativeAgentCancellation {
    fn cancel(&self, run_id: &str) {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .insert(run_id.to_string());
    }

    fn is_cancelled(&self, run_id: &str) -> bool {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .contains(run_id)
    }
}

pub struct RustNativeAgentProvider;

impl NativeAgentProvider for RustNativeAgentProvider {
    fn complete(
        &self,
        context: &NativeAgentRunContext,
    ) -> Result<NativeAgentProviderResponse, String> {
        let request = agent_chat_completion_request(context)?;
        let provider_config = agent_provider_config(context);
        let completion =
            crate::native_provider_runtime::complete_chat_for_agent(&provider_config, &request)?;
        let fixture_response = fixture_agent_response(&context.config_snapshot, &context.messages);

        Ok(NativeAgentProviderResponse {
            final_content: fixture_response
                .as_ref()
                .and_then(|response| string_field(response, "content"))
                .unwrap_or_else(|| chat_completion_content(&completion)),
            reasoning_delta: chat_completion_reasoning_delta(&completion),
            usage: completion.get("usage").cloned(),
            tool_calls: {
                let chat_tool_calls = chat_completion_tool_calls(&completion);
                if chat_tool_calls.is_empty() {
                    fixture_response
                        .as_ref()
                        .map(fixture_agent_tool_calls)
                        .unwrap_or_default()
                } else {
                    chat_tool_calls
                }
            },
        })
    }
}

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

fn native_tool_is_permitted(name: &str) -> bool {
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

fn is_subagent_tool(name: &str) -> bool {
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

fn agent_chat_completion_request(context: &NativeAgentRunContext) -> Result<Value, String> {
    let messages = agent_chat_messages(context)?;
    let mut request = serde_json::json!({
        "model": context.model.clone(),
        "messages": messages,
        "stream": false,
    });
    if let Some(max_tokens) = context
        .spec
        .get("maxCompletionTokens")
        .or_else(|| context.spec.get("max_completion_tokens"))
        .or_else(|| context.spec.get("max_tokens"))
        .cloned()
    {
        request["max_completion_tokens"] = max_tokens;
    }
    Ok(request)
}

fn agent_provider_config(context: &NativeAgentRunContext) -> Value {
    let mut config = context.config_snapshot.clone();
    set_agent_default(&mut config, "model", Value::String(context.model.clone()));
    if let Some(provider) = context.provider.as_deref() {
        set_agent_default(&mut config, "provider", Value::String(provider.to_string()));
    }
    config
}

fn set_agent_default(config: &mut Value, key: &str, value: Value) {
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let config_object = config
        .as_object_mut()
        .expect("config should be an object after normalization");
    let agents = config_object
        .entry("agents".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !agents.is_object() {
        *agents = serde_json::json!({});
    }
    let agents_object = agents
        .as_object_mut()
        .expect("agents should be an object after normalization");
    let defaults = agents_object
        .entry("defaults".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !defaults.is_object() {
        *defaults = serde_json::json!({});
    }
    defaults
        .as_object_mut()
        .expect("defaults should be an object after normalization")
        .insert(key.to_string(), value);
}

fn agent_chat_messages(context: &NativeAgentRunContext) -> Result<Value, String> {
    if !context.messages.is_empty() {
        return Ok(Value::Array(context.messages.clone()));
    }
    Err("agent run requires at least one chat message".to_string())
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

fn chat_completion_content(completion: &Value) -> String {
    completion
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn chat_completion_reasoning_delta(completion: &Value) -> Option<String> {
    completion
        .pointer("/choices/0/message/reasoning_content")
        .or_else(|| completion.pointer("/choices/0/message/reasoningContent"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn chat_completion_tool_calls(completion: &Value) -> Vec<NativeAgentToolCall> {
    completion
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .enumerate()
                .filter_map(|(index, tool)| {
                    let function = tool.get("function")?;
                    let name = string_field(function, "name")?;
                    Some(NativeAgentToolCall {
                        id: string_field(tool, "id")
                            .unwrap_or_else(|| format!("tool-call-{}", index + 1)),
                        name,
                        arguments_json: string_field(function, "arguments")
                            .unwrap_or_else(|| "{}".to_string()),
                        result: serde_json::json!({ "ok": true }),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn fixture_agent_response(config_snapshot: &Value, messages: &[Value]) -> Option<Value> {
    let response_index = messages
        .iter()
        .filter(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|tool_calls| !tool_calls.is_empty())
        })
        .count();
    config_snapshot
        .get("providers")
        .and_then(|providers| providers.get("fixture"))
        .and_then(|fixture| fixture.get("responses"))
        .and_then(Value::as_array)
        .and_then(|responses| responses.get(response_index).or_else(|| responses.first()))
        .cloned()
}

fn fixture_agent_tool_calls(response: &Value) -> Vec<NativeAgentToolCall> {
    response
        .get("toolCalls")
        .or_else(|| response.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .enumerate()
                .filter_map(|(index, tool)| {
                    let name = string_field(tool, "name")?;
                    Some(NativeAgentToolCall {
                        id: string_field(tool, "id")
                            .unwrap_or_else(|| format!("fixture-call-{index}")),
                        name,
                        arguments_json: string_field(tool, "argumentsJson")
                            .or_else(|| string_field(tool, "arguments_json"))
                            .unwrap_or_else(|| "{}".to_string()),
                        result: tool
                            .get("result")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({ "ok": true })),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn resolve_native_agent_runtime_mode(
    spec: &Value,
    config_snapshot: &Value,
) -> NativeAgentRuntimeMode {
    let _ = (spec, config_snapshot);
    NativeAgentRuntimeMode::Rust
}

pub fn run_native_agent_turn(spec: Value) -> Result<Value, String> {
    let services = NativeAgentRuntimeServices::default();
    let config_snapshot = spec
        .get("config")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    run_native_agent_turn_with_config(&services, spec, config_snapshot)
}

pub fn run_native_agent_turn_with_services(
    services: &NativeAgentRuntimeServices,
    spec: Value,
) -> Result<Value, String> {
    run_native_agent_turn_with_config(services, spec, serde_json::json!({}))
}

pub fn run_native_agent_turn_with_config(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
) -> Result<Value, String> {
    let mut context = NativeAgentRunContext::from_spec(spec, config_snapshot);
    if context.max_iterations <= 0 {
        return Ok(error_result(
            &context.run_id,
            &context.session_id,
            "max_iterations",
            "Rust agent runtime reached max iterations before provider call.",
        ));
    }
    if services.cancellations.is_cancelled(&context.run_id)
        || bool_field(&context.metadata, "fakeCancel")
    {
        let checkpoint = save_phase_checkpoint(
            services,
            &context,
            "cancelled",
            serde_json::json!({ "cancelled": true }),
        );
        return Ok(cancelled_result(
            &context.run_id,
            &context.session_id,
            checkpoint,
        ));
    }
    if let Some(result) = maybe_awaiting_approval_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_approval_resume_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_awaiting_form_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_form_submit_result(services, &context) {
        return Ok(result);
    }
    if context.messages.is_empty() {
        return Ok(error_result(
            &context.run_id,
            &context.session_id,
            "invalid_request",
            "Rust agent runtime requires at least one user input or chat message.",
        ));
    }

    let mut state = NativeAgentRunState::new(&context);
    for iteration in 0..context.max_iterations {
        state.set_phase(NativeAgentRunPhase::ActiveTurn, iteration);
        if services.cancellations.is_cancelled(&context.run_id) {
            state.phase = NativeAgentRunPhase::Cancelled;
            return Ok(cancelled_run_result(
                services,
                &context,
                std::mem::take(&mut state.events),
                std::mem::take(&mut state.tools_used),
                std::mem::take(&mut state.completed_tool_results),
                iteration,
            ));
        }
        save_phase_checkpoint(
            services,
            &context,
            state.phase.as_str(),
            state.active_checkpoint_payload("running"),
        );
        context.messages = state.messages.clone();
        context.spec["messages"] = Value::Array(state.messages.clone());
        let provider_response = match services.provider.complete(&context) {
            Ok(response) => response,
            Err(error) => {
                state.set_stop_reason("provider_error");
                state.events.push(event(
                    "agent.error",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "stopReason": "provider_error",
                        "message": error,
                        "error": error,
                    }),
                ));
                return Ok(serde_json::json!({
                    "runtime": "rust",
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "finalContent": "",
                    "stopReason": "provider_error",
                    "messages": [],
                    "toolsUsed": state.tools_used,
                    "completedToolResults": state.completed_tool_results,
                    "error": error,
                    "events": state.events,
                }));
            }
        };

        maybe_emit_checkpoint(services, &context, &mut state.events, "running");
        if let Some(reasoning_delta) = provider_response.reasoning_delta.clone() {
            state.events.push(event(
                "agent.reasoning_delta",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "iteration": iteration,
                    "delta": reasoning_delta,
                }),
            ));
        }
        if context.stream && !provider_response.final_content.is_empty() {
            state.events.push(event(
                "agent.delta",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "iteration": iteration,
                    "delta": provider_response.final_content,
                }),
            ));
        }

        if !provider_response.tool_calls.is_empty() {
            let tool_calls = provider_response.tool_calls;
            state.messages.push(assistant_tool_calls_message(
                &provider_response.final_content,
                &tool_calls,
            ));
            for tool_call in tool_calls {
                state.events.push(event(
                    "agent.tool_call.delta",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                        "argumentsDelta": tool_call.arguments_json,
                    }),
                ));
                if !native_tool_is_permitted(&tool_call.name) {
                    state.set_stop_reason("policy_denied");
                    state.events.push(event(
                        "agent.error",
                        serde_json::json!({
                            "runId": context.run_id,
                            "sessionId": context.session_id,
                            "iteration": iteration,
                            "stopReason": "policy_denied",
                            "error": format!("native tool `{}` is not permitted by Rust capability policy", tool_call.name),
                            "toolCallId": tool_call.id,
                            "toolName": tool_call.name,
                            "name": tool_call.name,
                        }),
                    ));
                    services
                        .checkpoints
                        .clear_for_run(&context.session_id, &context.run_id);
                    return Ok(serde_json::json!({
                        "runtime": "rust",
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "finalContent": "",
                        "stopReason": "policy_denied",
                        "messages": [],
                        "toolsUsed": state.tools_used,
                        "completedToolResults": state.completed_tool_results,
                        "error": format!("native tool `{}` is not permitted by Rust capability policy", tool_call.name),
                        "events": state.events,
                    }));
                }
                if services.cancellations.is_cancelled(&context.run_id) {
                    state.phase = NativeAgentRunPhase::Cancelled;
                    return Ok(cancelled_run_result(
                        services,
                        &context,
                        std::mem::take(&mut state.events),
                        std::mem::take(&mut state.tools_used),
                        std::mem::take(&mut state.completed_tool_results),
                        iteration,
                    ));
                }
                state.tools_used.push(tool_call.name.clone());
                state.events.push(event(
                    "agent.tool.start",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                    }),
                ));
                state.set_pending_tool_call(&tool_call);
                save_phase_checkpoint(
                    services,
                    &context,
                    state.phase.as_str(),
                    serde_json::json!({
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "argumentsJson": tool_call.arguments_json,
                        "pendingToolCalls": state.pending_tool_calls.clone(),
                        "completedToolResults": state.completed_tool_results.clone(),
                    }),
                );
                let result = match services.tools.dispatch(&context, &tool_call) {
                    Ok(result) => result,
                    Err(error) => {
                        state.set_stop_reason("tool_error");
                        state.events.push(event(
                            "agent.error",
                            serde_json::json!({
                                "runId": context.run_id,
                                "sessionId": context.session_id,
                                "iteration": iteration,
                                "stopReason": "tool_error",
                                "error": error,
                                "toolCallId": tool_call.id,
                                "toolName": tool_call.name,
                                "name": tool_call.name,
                            }),
                        ));
                        services
                            .checkpoints
                            .clear_for_run(&context.session_id, &context.run_id);
                        return Ok(serde_json::json!({
                            "runtime": "rust",
                            "runId": context.run_id,
                            "sessionId": context.session_id,
                            "finalContent": "",
                            "stopReason": "tool_error",
                            "messages": [],
                            "toolsUsed": state.tools_used,
                            "completedToolResults": state.completed_tool_results,
                            "error": error,
                            "events": state.events,
                        }));
                    }
                };
                let result = normalize_tool_result_for_context(result, &context);
                let observation_content = tool_observation_content(&result);
                let completed_result = completed_tool_result_entry(&tool_call, &result);
                state
                    .messages
                    .push(tool_observation_message(&tool_call, &observation_content));
                state.events.push(event(
                    "agent.tool.result",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                        "content": observation_content,
                        "envelope": result.envelope.clone(),
                    }),
                ));
                state.completed_tool_results.push(completed_result);
                state.clear_pending_tool_calls();
                state.set_phase(NativeAgentRunPhase::ActiveTurn, iteration);
                save_phase_checkpoint(
                    services,
                    &context,
                    state.phase.as_str(),
                    state.active_checkpoint_payload("tool_completed"),
                );
                if services.cancellations.is_cancelled(&context.run_id) {
                    state.phase = NativeAgentRunPhase::Cancelled;
                    return Ok(cancelled_run_result(
                        services,
                        &context,
                        std::mem::take(&mut state.events),
                        std::mem::take(&mut state.tools_used),
                        std::mem::take(&mut state.completed_tool_results),
                        iteration,
                    ));
                }
            }

            if let Some(usage) = provider_response.usage {
                state.usage.push(usage.clone());
                state.events.push(event(
                    "agent.usage",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "iteration": iteration,
                        "usage": usage,
                    }),
                ));
            }
            continue;
        }

        let final_content = provider_response.final_content;
        if let Some(usage) = provider_response.usage {
            state.usage.push(usage.clone());
            state.events.push(event(
                "agent.usage",
                serde_json::json!({
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "iteration": iteration,
                    "usage": usage,
                }),
            ));
        }
        state.set_stop_reason("final_response");
        services
            .checkpoints
            .clear_for_run(&context.session_id, &context.run_id);
        state.events.push(event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "iteration": iteration,
                "stopReason": "final_response",
            }),
        ));

        return Ok(serde_json::json!({
            "runtime": "rust",
            "runId": context.run_id,
            "sessionId": context.session_id,
            "finalContent": final_content,
            "stopReason": "final_response",
            "messages": [{
                "role": "assistant",
                "content": final_content
            }],
            "toolsUsed": state.tools_used,
            "completedToolResults": state.completed_tool_results,
            "events": state.events,
        }));
    }

    let error = "Rust agent runtime reached max iterations before final response.";
    state.set_stop_reason("max_iterations");
    state.events.push(event(
        "agent.error",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "stopReason": "max_iterations",
            "error": error,
        }),
    ));
    Ok(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "max_iterations",
        "messages": [],
        "toolsUsed": state.tools_used,
        "completedToolResults": state.completed_tool_results,
        "error": error,
        "events": state.events,
    }))
}

impl NativeAgentRunContext {
    fn from_spec(spec: Value, config_snapshot: Value) -> Self {
        let run_id = string_field(&spec, "runId")
            .or_else(|| string_field(&spec, "run_id"))
            .unwrap_or_else(|| "native-rust-run".to_string());
        let session_id =
            normalized_session_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
        let metadata = spec
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
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
        Self {
            run_id,
            session_id,
            messages: initial_agent_messages(&spec),
            spec,
            config_snapshot,
            metadata,
            model,
            provider,
            stream,
            max_iterations,
        }
    }
}

fn assistant_tool_calls_message(content: &str, tool_calls: &[NativeAgentToolCall]) -> Value {
    serde_json::json!({
        "role": "assistant",
        "content": content,
        "tool_calls": tool_calls
            .iter()
            .map(|tool_call| {
                serde_json::json!({
                    "id": tool_call.id,
                    "type": "function",
                    "function": {
                        "name": tool_call.name,
                        "arguments": tool_call.arguments_json,
                    }
                })
            })
            .collect::<Vec<_>>()
    })
}

fn tool_observation_message(tool_call: &NativeAgentToolCall, content: &str) -> Value {
    serde_json::json!({
        "role": "tool",
        "tool_call_id": tool_call.id,
        "name": tool_call.name,
        "content": content,
    })
}

fn tool_observation_content(result: &NativeAgentToolResult) -> String {
    if let Some(content) = result.envelope.get("modelContent").and_then(Value::as_str) {
        return content.to_string();
    }
    legacy_tool_content(&result.content)
}

fn normalize_tool_result_for_context(
    mut result: NativeAgentToolResult,
    context: &NativeAgentRunContext,
) -> NativeAgentToolResult {
    let secrets = config_redaction_values(&context.config_snapshot);
    let max_model_chars = configured_max_tool_result_chars(context);
    let mut redactions = Vec::new();
    let mut model_content = result
        .envelope
        .get("modelContent")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| legacy_tool_content(&result.content));
    model_content = redact_sensitive_text(&model_content, &secrets, &mut redactions);
    let original_model_chars = model_content.chars().count();
    let mut truncated = false;
    if let Some(max_model_chars) = max_model_chars {
        if original_model_chars > max_model_chars {
            model_content = model_content.chars().take(max_model_chars).collect();
            truncated = true;
        }
    }

    if let Some(envelope) = result.envelope.as_object_mut() {
        envelope.insert(
            "modelContent".to_string(),
            Value::String(model_content.clone()),
        );
        let summary = envelope
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| model_content.clone());
        envelope.insert(
            "summary".to_string(),
            Value::String(redact_sensitive_text(&summary, &secrets, &mut redactions)),
        );
        if let Some(structured) = envelope.get_mut("structured") {
            redact_sensitive_value(structured, &secrets, &mut redactions);
        }
        if let Some(raw) = envelope.get_mut("raw") {
            redact_sensitive_value(raw, &secrets, &mut redactions);
        }
        if let Some(metrics) = envelope.get_mut("metrics").and_then(Value::as_object_mut) {
            metrics.insert(
                "modelChars".to_string(),
                serde_json::json!(model_content.chars().count()),
            );
            metrics.insert(
                "originalModelChars".to_string(),
                serde_json::json!(original_model_chars),
            );
        }
        envelope.insert(
            "redactions".to_string(),
            Value::Array(redactions.into_iter().map(Value::String).collect()),
        );
        envelope.insert(
            "truncation".to_string(),
            serde_json::json!({
                "truncated": truncated,
                "maxModelChars": max_model_chars,
                "originalModelChars": original_model_chars,
            }),
        );
        if truncated {
            envelope.insert(
                "continuation".to_string(),
                serde_json::json!({
                    "cursor": format!("modelContent:{original_model_chars}"),
                    "nextOffset": model_content.chars().count(),
                }),
            );
        }
    }
    result.content = Value::String(model_content);
    result
}

fn configured_max_tool_result_chars(context: &NativeAgentRunContext) -> Option<usize> {
    context
        .spec
        .get("maxToolResultChars")
        .or_else(|| context.spec.get("max_tool_result_chars"))
        .or_else(|| context.metadata.get("maxToolResultChars"))
        .or_else(|| context.metadata.get("max_tool_result_chars"))
        .or_else(|| {
            context
                .config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| {
                    defaults
                        .get("maxToolResultChars")
                        .or_else(|| defaults.get("max_tool_result_chars"))
                })
        })
        .or_else(|| context.config_snapshot.get("maxToolResultChars"))
        .or_else(|| context.config_snapshot.get("max_tool_result_chars"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn config_redaction_values(value: &Value) -> Vec<String> {
    let mut redactions = Vec::new();
    collect_config_redaction_values(value, None, &mut redactions);
    redactions
}

fn collect_config_redaction_values(value: &Value, key: Option<&str>, redactions: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (child_key, child_value) in map {
                collect_config_redaction_values(child_value, Some(child_key), redactions);
            }
        }
        Value::Array(values) => {
            for child_value in values {
                collect_config_redaction_values(child_value, key, redactions);
            }
        }
        Value::String(secret) => {
            let key = key.unwrap_or_default().to_ascii_lowercase();
            let sensitive_key = key.contains("api_key")
                || key.contains("apikey")
                || key.contains("token")
                || key.contains("secret")
                || key.contains("password");
            if sensitive_key && secret.chars().count() >= 4 {
                redactions.push(secret.clone());
            }
        }
        _ => {}
    }
}

fn redact_sensitive_text(text: &str, secrets: &[String], redactions: &mut Vec<String>) -> String {
    let mut redacted = text.to_string();
    for secret in secrets {
        if secret.is_empty() || !redacted.contains(secret) {
            continue;
        }
        redacted = redacted.replace(secret, "[REDACTED]");
        if !redactions.iter().any(|entry| entry == "config_secret") {
            redactions.push("config_secret".to_string());
        }
    }
    redacted
}

fn redact_sensitive_value(value: &mut Value, secrets: &[String], redactions: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            *text = redact_sensitive_text(text, secrets, redactions);
        }
        Value::Array(values) => {
            for child in values {
                redact_sensitive_value(child, secrets, redactions);
            }
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                redact_sensitive_value(child, secrets, redactions);
            }
        }
        _ => {}
    }
}

fn completed_tool_result_entry(
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
) -> Value {
    serde_json::json!({
        "toolCallId": tool_call.id,
        "toolName": tool_call.name,
        "status": result
            .envelope
            .get("status")
            .cloned()
            .unwrap_or_else(|| serde_json::json!("ok")),
        "summary": result
            .envelope
            .get("summary")
            .cloned()
            .unwrap_or_else(|| result.content.clone()),
        "envelope": result.envelope,
    })
}

fn legacy_tool_content(value: &Value) -> String {
    if let Some(content) = value.as_str() {
        return content.to_string();
    }
    if let Some(content) = value.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    value.to_string()
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

fn maybe_awaiting_approval_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let approval = context.metadata.get("fakeAwaitingApproval")?.clone();
    let approval_id = string_field(&approval, "approvalId")
        .or_else(|| string_field(&approval, "approval_id"))
        .unwrap_or_else(|| "approval-1".to_string());
    let tool_name = string_field(&approval, "toolName")
        .or_else(|| string_field(&approval, "tool_name"))
        .unwrap_or_else(|| "approval".to_string());
    let checkpoint = checkpoint_value(
        context,
        "awaiting_approval",
        serde_json::json!({
            "iteration": 0,
            "approval_id": approval_id,
            "operation": approval,
            "pendingToolCalls": [{
                "toolCallId": approval_id,
                "toolName": tool_name,
                "argumentsJson": Value::Null,
            }],
            "resumeToken": format!("approval:{approval_id}"),
        }),
    );
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    let events = vec![
        event(
            "agent.checkpoint",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "phase": "awaiting_approval",
                "checkpoint": checkpoint,
            }),
        ),
        event(
            "agent.awaiting_approval",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "approvalId": approval_id,
                "toolName": tool_name,
                "operation": approval,
                "content": format!("Approval required: {tool_name}"),
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "awaiting_approval",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "awaiting_approval",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_approval_resume_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let approval = context.metadata.get("fakeApprovalResume")?.clone();
    let approved = approval
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| string_field(&approval, "decision").as_deref() == Some("approved"));
    let checkpoint = services
        .checkpoints
        .restore_for_run(&context.session_id, &context.run_id);
    if !approved {
        services
            .checkpoints
            .clear_for_run(&context.session_id, &context.run_id);
        let message = string_field(&approval, "guidance")
            .map(|guidance| format!("Rust agent approval was denied. User guidance: {guidance}"))
            .unwrap_or_else(|| "Rust agent approval was denied.".to_string());
        return Some(error_result(
            &context.run_id,
            &context.session_id,
            "approval_denied",
            &message,
        ));
    }
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let final_content = string_field(&approval, "finalContent")
        .or_else(|| string_field(&approval, "final_content"))
        .unwrap_or_else(|| "Approved tool completed.".to_string());
    let events = vec![
        event(
            "agent.tool.result",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": string_field(&approval, "toolCallId").unwrap_or_else(|| "approval-1".to_string()),
                "toolName": string_field(&approval, "toolName").unwrap_or_else(|| "approval".to_string()),
                "content": string_field(&approval, "toolResult").unwrap_or_else(|| "approved".to_string()),
            }),
        ),
        event(
            "agent.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": final_content,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "final_response",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": final_content,
        "stopReason": "final_response",
        "messages": [{ "role": "assistant", "content": final_content }],
        "toolsUsed": [],
        "restoredCheckpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_awaiting_form_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let form = context.metadata.get("fakeAwaitingForm")?.clone();
    let form_id = string_field(&form, "formId")
        .or_else(|| string_field(&form, "form_id"))
        .unwrap_or_else(|| "form-1".to_string());
    let checkpoint = checkpoint_value(
        context,
        "awaiting_form",
        serde_json::json!({
            "iteration": 0,
            "form_id": form_id,
            "form": form,
            "pendingToolCalls": [],
            "resumeToken": format!("form:{form_id}"),
        }),
    );
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    let events = vec![
        event(
            "agent.checkpoint",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "phase": "awaiting_form",
                "checkpoint": checkpoint,
            }),
        ),
        event(
            "agent.awaiting_form",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "formId": form_id,
                "form": form,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "awaiting_form",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "awaiting_form",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_form_submit_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let form = context.metadata.get("fakeFormSubmit")?.clone();
    if bool_field(&form, "cancelled") {
        services
            .checkpoints
            .clear_for_run(&context.session_id, &context.run_id);
        return Some(error_result(
            &context.run_id,
            &context.session_id,
            "form_cancelled",
            "Rust agent form was cancelled.",
        ));
    }
    let checkpoint = services
        .checkpoints
        .restore_for_run(&context.session_id, &context.run_id);
    services
        .checkpoints
        .clear_for_run(&context.session_id, &context.run_id);
    let final_content = string_field(&form, "finalContent")
        .or_else(|| string_field(&form, "final_content"))
        .unwrap_or_else(|| "Form submitted.".to_string());
    let events = vec![
        event(
            "agent.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": final_content,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "final_response",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": final_content,
        "stopReason": "final_response",
        "messages": [{ "role": "assistant", "content": final_content }],
        "toolsUsed": [],
        "restoredCheckpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_emit_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    events: &mut Vec<NativeAgentEvent>,
    default_phase: &str,
) {
    let Some(checkpoint_metadata) = context.metadata.get("fakeCheckpoint") else {
        return;
    };
    let phase =
        string_field(checkpoint_metadata, "phase").unwrap_or_else(|| default_phase.to_string());
    let checkpoint = checkpoint_value(context, &phase, checkpoint_metadata.clone());
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    events.push(event(
        "agent.checkpoint",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "phase": phase,
            "checkpoint": checkpoint,
        }),
    ));
}

fn checkpoint_value(context: &NativeAgentRunContext, phase: &str, payload: Value) -> Value {
    serde_json::json!({
        "schemaVersion": 1,
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "phase": phase,
        "iteration": payload.get("iteration").cloned().unwrap_or(Value::Null),
        "maxIterations": context.max_iterations,
        "pendingToolCalls": checkpoint_pending_tool_calls(&payload),
        "completedToolResults": payload
            .get("completedToolResults")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "resumeToken": payload.get("resumeToken").cloned().unwrap_or(Value::Null),
        "stopReason": payload.get("stopReason").cloned().unwrap_or(Value::Null),
        "payload": payload,
        "messages": context.spec.get("messages").cloned().unwrap_or_else(|| serde_json::json!([])),
    })
}

fn checkpoint_pending_tool_calls(payload: &Value) -> Value {
    if let Some(pending) = payload.get("pendingToolCalls") {
        return pending.clone();
    }
    let Some(tool_call_id) = payload.get("toolCallId").cloned() else {
        return serde_json::json!([]);
    };
    serde_json::json!([{
        "toolCallId": tool_call_id,
        "toolName": payload.get("toolName").cloned().unwrap_or(Value::Null),
        "argumentsJson": payload.get("argumentsJson").cloned().unwrap_or(Value::Null),
    }])
}

fn error_result(run_id: &str, session_id: &str, stop_reason: &str, message: &str) -> Value {
    let events = vec![event(
        "agent.error",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "stopReason": stop_reason,
            "message": message,
            "error": message,
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "messages": [],
        "toolsUsed": [],
        "error": message,
        "events": events,
    })
}

fn save_phase_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    phase: &str,
    payload: Value,
) -> Value {
    let checkpoint = checkpoint_value(context, phase, payload);
    services
        .checkpoints
        .save_for_run(&context.session_id, &context.run_id, checkpoint.clone());
    checkpoint
}

fn cancelled_result(run_id: &str, session_id: &str, checkpoint: Value) -> Value {
    let events = vec![event(
        "agent.cancelled",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "cancelled": true,
            "stopReason": "cancelled",
            "error": "cancelled",
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "error": "cancelled",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
    })
}

fn cancelled_run_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    mut events: Vec<NativeAgentEvent>,
    tools_used: Vec<String>,
    completed_tool_results: Vec<Value>,
    iteration: i64,
) -> Value {
    let checkpoint = save_phase_checkpoint(
        services,
        context,
        "cancelled",
        serde_json::json!({
            "cancelled": true,
            "iteration": iteration,
            "completedToolResults": completed_tool_results.clone(),
            "stopReason": "cancelled",
        }),
    );
    events.push(event(
        "agent.cancelled",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "iteration": iteration,
            "cancelled": true,
            "stopReason": "cancelled",
            "error": "cancelled",
        }),
    ));
    serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "messages": [],
        "toolsUsed": tools_used,
        "completedToolResults": completed_tool_results,
        "error": "cancelled",
        "checkpoint": checkpoint,
        "events": events,
    })
}

fn event(event_name: &str, payload: Value) -> NativeAgentEvent {
    NativeAgentEvent {
        event_name: event_name.to_string(),
        payload,
    }
}

fn event_value(event_name: &str, payload: Value) -> Value {
    serde_json::json!({
        "eventName": event_name,
        "payload": payload,
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn selects_rust_runtime_from_spec_or_config() {
        assert_eq!(
            resolve_native_agent_runtime_mode(&json!({ "runtime": "rust" }), &json!({})),
            NativeAgentRuntimeMode::Rust
        );
        assert_eq!(
            resolve_native_agent_runtime_mode(
                &json!({}),
                &json!({ "desktop": { "nativeAgentRuntime": "rust" } })
            ),
            NativeAgentRuntimeMode::Rust
        );
        assert_eq!(
            resolve_native_agent_runtime_mode(&json!({}), &json!({})),
            NativeAgentRuntimeMode::Rust
        );
    }

    #[test]
    fn normalizes_desktop_run_spec_inputs_for_rust_turns() {
        let context = NativeAgentRunContext::from_spec(
            json!({
                "runtime": "rust",
                "runId": "run-normalized",
                "activeSessionId": "websocket:active-chat",
                "provider": "fixture",
                "model": "fixture-model",
                "max_iterations": 4,
                "input": { "role": "user", "content": "hello normalized" },
                "metadata": {
                    "_wants_stream": true,
                    "source": "desktop"
                }
            }),
            json!({
                "agents": { "defaults": { "provider": "auto", "model": "fallback-model" } },
                "providers": { "fixture": { "responses": [{ "content": "normalized answer" }] } }
            }),
        );
        let request = agent_chat_completion_request(&context)
            .expect("normalized run spec should produce a chat completion request");
        let provider_config = agent_provider_config(&context);

        assert_eq!(context.session_id, "websocket:active-chat");
        assert_eq!(context.model, "fixture-model");
        assert_eq!(context.provider.as_deref(), Some("fixture"));
        assert_eq!(context.max_iterations, 4);
        assert!(context.stream);
        assert_eq!(context.metadata["source"], "desktop");
        assert_eq!(request["model"], "fixture-model");
        assert_eq!(request["messages"][0]["content"], "hello normalized");
        assert_eq!(provider_config["agents"]["defaults"]["provider"], "fixture");
        assert_eq!(
            provider_config["agents"]["defaults"]["model"],
            "fixture-model"
        );
    }

    #[test]
    fn invalid_request_stops_before_provider_call() {
        let result = run_native_agent_turn_with_config(
            &NativeAgentRuntimeServices::default(),
            json!({
                "runtime": "rust",
                "runId": "run-invalid",
                "sessionId": "websocket:chat-invalid"
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "should not be used" }] } }
            }),
        )
        .expect("invalid request should return a structured result");

        assert_eq!(result["stopReason"], "invalid_request");
        assert_eq!(result["finalContent"], "");
        assert_eq!(event_names(&result), vec!["agent.error"]);
        assert_eq!(
            result["events"][0]["payload"]["stopReason"],
            "invalid_request"
        );
    }

    #[test]
    fn runs_fixture_streaming_final_answer_with_frontend_events() {
        let result = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-1",
            "sessionId": "websocket:chat-1",
            "stream": true,
            "messages": [{ "role": "user", "content": "hello" }],
            "config": fixture_provider_config("fixture answer")
        }))
        .expect("fixture provider run should succeed");

        assert_eq!(result["runtime"], "rust");
        assert_eq!(result["finalContent"], "fixture answer");
        assert_eq!(result["events"][0]["eventName"], "agent.delta");
        assert_eq!(result["events"][1]["eventName"], "agent.usage");
        assert_eq!(result["events"][2]["eventName"], "agent.done");
    }

    #[test]
    fn runs_fixture_tool_event_sequence() {
        let services = NativeAgentRuntimeServices::default();
        let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-tool",
                "sessionId": "websocket:chat-1",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-1",
                                    "name": "workspace.read_file",
                                    "argumentsJson": "{\"path\":\"README.md\"}",
                                    "result": { "content": "README" }
                                }]
                            },
                            { "content": "tool complete" }
                        ]
                    }
                }
            }),
        )
        .expect("fixture tool run should succeed");

        let event_names = event_names(&result);
        assert_eq!(
            &event_names[..3],
            &[
                "agent.tool_call.delta",
                "agent.tool.start",
                "agent.tool.result"
            ]
        );
        assert_eq!(event_names.last().copied(), Some("agent.done"));
        assert_eq!(result["finalContent"], "tool complete");
        assert_eq!(result["toolsUsed"][0], "workspace.read_file");
    }

    #[test]
    fn feeds_tool_observation_back_into_second_provider_call() {
        struct TwoStepProvider {
            seen_messages: Mutex<Vec<Value>>,
        }

        impl NativeAgentProvider for TwoStepProvider {
            fn complete(
                &self,
                context: &NativeAgentRunContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                let request = agent_chat_completion_request(context)
                    .expect("provider context should build request messages");
                self.seen_messages
                    .lock()
                    .expect("seen messages lock should not be poisoned")
                    .push(request["messages"].clone());
                let call_count = self
                    .seen_messages
                    .lock()
                    .expect("seen messages lock should not be poisoned")
                    .len();

                if call_count == 1 {
                    Ok(NativeAgentProviderResponse {
                        final_content: String::new(),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: vec![NativeAgentToolCall {
                            id: "call-read".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: "{\"path\":\"README.md\"}".to_string(),
                            result: json!({ "content": "README body" }),
                        }],
                    })
                } else {
                    Ok(NativeAgentProviderResponse {
                        final_content: "I read README body.".to_string(),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: Vec::new(),
                    })
                }
            }
        }

        let provider = Arc::new(TwoStepProvider {
            seen_messages: Mutex::new(Vec::new()),
        });
        let services = NativeAgentRuntimeServices::new(
            provider.clone(),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        );

        let result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-tool-loop",
                "sessionId": "websocket:chat-tool-loop",
                "maxIterations": 4,
                "messages": [{ "role": "user", "content": "read README then answer" }]
            }),
        )
        .expect("multi-iteration tool run should complete");

        let seen_messages = provider
            .seen_messages
            .lock()
            .expect("seen messages lock should not be poisoned");
        assert_eq!(seen_messages.len(), 2);
        assert_eq!(result["finalContent"], "I read README body.");
        assert_eq!(result["stopReason"], "final_response");
        assert!(seen_messages[1]
            .as_array()
            .expect("messages should be an array")
            .iter()
            .any(|message| message["role"] == "tool"
                && message["tool_call_id"] == "call-read"
                && message["content"]
                    .as_str()
                    .expect("tool observation should be text")
                    .contains("README body")));
    }

    #[test]
    fn provider_error_after_tool_result_preserves_accumulated_tool_state() {
        struct ToolThenErrorProvider {
            calls: Mutex<usize>,
        }

        impl NativeAgentProvider for ToolThenErrorProvider {
            fn complete(
                &self,
                _context: &NativeAgentRunContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                let mut calls = self.calls.lock().expect("provider calls lock");
                *calls += 1;
                if *calls == 1 {
                    return Ok(NativeAgentProviderResponse {
                        final_content: String::new(),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: vec![NativeAgentToolCall {
                            id: "call-before-provider-error".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: "{\"path\":\"README.md\"}".to_string(),
                            result: json!({ "content": "README before provider error" }),
                        }],
                    });
                }

                Err("provider failed after tool result".to_string())
            }
        }

        let services = NativeAgentRuntimeServices::new(
            Arc::new(ToolThenErrorProvider {
                calls: Mutex::new(0),
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        );
        let result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-provider-error-after-tool",
                "sessionId": "websocket:chat-provider-error-after-tool",
                "maxIterations": 3,
                "messages": [{ "role": "user", "content": "read then fail" }]
            }),
        )
        .expect("provider error should return a structured result");

        assert_eq!(result["stopReason"], "provider_error");
        assert_eq!(result["toolsUsed"], json!(["workspace.read_file"]));
        assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["completedToolResults"][0]["toolCallId"],
            "call-before-provider-error"
        );
        assert_eq!(
            event_names(&result),
            vec![
                "agent.tool_call.delta",
                "agent.tool.start",
                "agent.tool.result",
                "agent.error"
            ]
        );
    }

    #[test]
    fn emits_tool_result_envelope_with_legacy_content_projection() {
        let services = NativeAgentRuntimeServices::default();
        let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-tool-envelope",
                "sessionId": "websocket:chat-tool-envelope",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-envelope",
                                    "name": "workspace.read_file",
                                    "argumentsJson": "{\"path\":\"README.md\"}",
                                    "result": { "content": "README envelope body" }
                                }]
                            },
                            { "content": "envelope final" }
                        ]
                    }
                }
            }),
        )
        .expect("fixture tool run should succeed");

        let tool_result = result["events"]
            .as_array()
            .expect("events should be an array")
            .iter()
            .find(|event| event["eventName"] == "agent.tool.result")
            .expect("tool result event should be emitted");
        let payload = &tool_result["payload"];

        assert_eq!(payload["content"], "README envelope body");
        assert_eq!(payload["envelope"]["status"], "ok");
        assert_eq!(payload["envelope"]["summary"], "README envelope body");
        assert_eq!(payload["envelope"]["modelContent"], "README envelope body");
        assert_eq!(payload["envelope"]["ui"]["type"], "generic_result");
        assert_eq!(payload["envelope"]["ui"]["title"], "workspace.read_file");
        assert!(payload["envelope"]["references"]
            .as_array()
            .expect("references should be an array")
            .is_empty());
        assert_eq!(payload["envelope"]["metrics"]["modelChars"], 20);
        assert_eq!(payload["envelope"]["trace"]["toolCallId"], "call-envelope");
        assert_eq!(
            payload["envelope"]["trace"]["toolName"],
            "workspace.read_file"
        );
    }

    #[test]
    fn subagent_tools_share_manager_state_without_copying_child_transcript_to_parent() {
        let services = NativeAgentRuntimeServices::default();
        let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-subagent-tools",
                "sessionId": "websocket:chat-subagent-tools",
                "maxIterations": 5,
                "messages": [{ "role": "user", "content": "delegate then close" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-spawn",
                                    "name": "subagent.spawn",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\",\"childRunId\":\"child-1\",\"traceRef\":\"trace-delegate-1\",\"name\":\"Goodall\",\"task\":\"Inspect a bounded topic\"}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-send",
                                    "name": "subagent.send_input",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\",\"content\":\"Please continue\"}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-wait",
                                    "name": "subagent.wait",
                                    "argumentsJson": "{\"subagentIds\":[\"delegate-1\"],\"timeoutMs\":1}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-close",
                                    "name": "subagent.close",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\"}"
                                }]
                            },
                            { "content": "Subagent lifecycle handled." }
                        ]
                    }
                }
            }),
        )
        .expect("subagent tool run should succeed");

        assert_eq!(result["stopReason"], "final_response");
        assert_eq!(
            result["toolsUsed"],
            json!([
                "subagent.spawn",
                "subagent.send_input",
                "subagent.wait",
                "subagent.close"
            ])
        );
        let completed = result["completedToolResults"]
            .as_array()
            .expect("completed tool results should be present");
        assert_eq!(completed.len(), 4);
        assert_eq!(completed[0]["envelope"]["raw"]["accepted"], true);
        assert_eq!(
            completed[1]["envelope"]["raw"]["delivery"],
            "live_delivered"
        );
        assert_eq!(
            completed[1]["envelope"]["raw"]["subagent"]["mailboxDepth"],
            1
        );
        assert_eq!(completed[2]["envelope"]["raw"]["timedOut"], true);
        assert_eq!(
            completed[3]["envelope"]["raw"]["subagent"]["status"],
            "closed"
        );
        assert_eq!(
            result["messages"],
            json!([{ "role": "assistant", "content": "Subagent lifecycle handled." }])
        );
    }

    #[test]
    fn tool_result_projection_redacts_and_truncates_model_content() {
        let result = run_native_agent_turn_with_config(
            &NativeAgentRuntimeServices::default(),
            json!({
                "runtime": "rust",
                "runId": "run-tool-budget",
                "sessionId": "websocket:chat-tool-budget",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read bounded result" }]
            }),
            json!({
                "agents": {
                    "defaults": {
                        "provider": "fixture",
                        "model": "fixture-model",
                        "maxToolResultChars": 12
                    }
                },
                "providers": {
                    "fixture": {
                        "api_key": "secret-token",
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-budget",
                                    "name": "workspace.read_file",
                                    "argumentsJson": "{\"path\":\"README.md\"}",
                                    "result": { "content": "secret-token ABCDEFGHIJKLMNOP" }
                                }]
                            },
                            { "content": "bounded final" }
                        ]
                    }
                }
            }),
        )
        .expect("bounded tool result run should complete");
        let tool_result = result["events"]
            .as_array()
            .expect("events should be an array")
            .iter()
            .find(|event| event["eventName"] == "agent.tool.result")
            .expect("tool result event should be emitted");
        let content = tool_result["payload"]["content"]
            .as_str()
            .expect("legacy content should be text");

        assert!(!content.contains("secret-token"));
        assert!(content.chars().count() <= 12);
        assert_eq!(
            tool_result["payload"]["envelope"]["truncation"]["truncated"],
            true
        );
        assert_eq!(
            tool_result["payload"]["envelope"]["redactions"][0],
            "config_secret"
        );
        assert!(!tool_result["payload"]["envelope"]["modelContent"]
            .as_str()
            .unwrap()
            .contains("secret-token"));
        assert!(!tool_result["payload"]["envelope"]
            .to_string()
            .contains("secret-token"));
        assert_eq!(
            tool_result["payload"]["envelope"]["continuation"]["nextOffset"],
            12
        );
    }

    #[test]
    fn dispatches_multiple_tool_calls_from_one_provider_response_in_order() {
        let services = NativeAgentRuntimeServices::default();
        let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-multiple-tools",
                "sessionId": "websocket:chat-multiple-tools",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "inspect workspace" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [
                                    {
                                        "id": "call-read",
                                        "name": "workspace.read_file",
                                        "argumentsJson": "{\"path\":\"README.md\"}",
                                        "result": { "content": "README body" }
                                    },
                                    {
                                        "id": "call-list",
                                        "name": "workspace.list_files",
                                        "argumentsJson": "{\"path\":\"src\"}",
                                        "result": { "content": "src/main.ts" }
                                    }
                                ]
                            },
                            { "content": "workspace inspected" }
                        ]
                    }
                }
            }),
        )
        .expect("multiple tool run should succeed");

        let tool_results = result["events"]
            .as_array()
            .expect("events should be an array")
            .iter()
            .filter(|event| event["eventName"] == "agent.tool.result")
            .collect::<Vec<_>>();

        assert_eq!(
            result["toolsUsed"],
            json!(["workspace.read_file", "workspace.list_files"])
        );
        assert_eq!(tool_results.len(), 2);
        assert_eq!(tool_results[0]["payload"]["toolCallId"], "call-read");
        assert_eq!(tool_results[1]["payload"]["toolCallId"], "call-list");
        assert_eq!(result["finalContent"], "workspace inspected");
    }

    #[test]
    fn later_tool_error_preserves_earlier_completed_tool_result() {
        struct TwoToolProvider;

        impl NativeAgentProvider for TwoToolProvider {
            fn complete(
                &self,
                _context: &NativeAgentRunContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                Ok(NativeAgentProviderResponse {
                    final_content: "".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![
                        NativeAgentToolCall {
                            id: "call-first-ok".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: "{\"path\":\"README.md\"}".to_string(),
                            result: json!({ "content": "README" }),
                        },
                        NativeAgentToolCall {
                            id: "call-second-fails".to_string(),
                            name: "workspace.list_files".to_string(),
                            arguments_json: "{\"path\":\"missing\"}".to_string(),
                            result: json!({ "content": "unused" }),
                        },
                    ],
                })
            }
        }

        struct FailingSecondToolDispatcher;

        impl NativeAgentToolDispatcher for FailingSecondToolDispatcher {
            fn dispatch(
                &self,
                _context: &NativeAgentRunContext,
                tool_call: &NativeAgentToolCall,
            ) -> Result<NativeAgentToolResult, String> {
                if tool_call.id == "call-second-fails" {
                    return Err("missing path".to_string());
                }
                Ok(NativeAgentToolResult::generic_success(
                    tool_call,
                    tool_call.result.clone(),
                ))
            }
        }

        let result = run_native_agent_turn_with_services(
            &NativeAgentRuntimeServices::new(
                Arc::new(TwoToolProvider),
                Arc::new(FailingSecondToolDispatcher),
                Arc::new(InMemoryNativeAgentCheckpointStore::default()),
                Arc::new(InMemoryNativeAgentCancellation::default()),
            ),
            json!({
                "runtime": "rust",
                "runId": "run-later-tool-error",
                "sessionId": "websocket:chat-later-tool-error",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "run two tools" }]
            }),
        )
        .expect("later tool error should return structured failure");

        assert_eq!(result["stopReason"], "tool_error");
        assert_eq!(
            result["toolsUsed"],
            json!(["workspace.read_file", "workspace.list_files"])
        );
        assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["completedToolResults"][0]["toolCallId"],
            "call-first-ok"
        );
        assert_eq!(
            result["events"].as_array().unwrap().last().unwrap()["eventName"],
            "agent.error"
        );
        assert_eq!(
            result["events"].as_array().unwrap().last().unwrap()["payload"]["toolCallId"],
            "call-second-fails"
        );
    }

    #[test]
    fn rejects_unpermitted_native_tool_with_structured_error_result() {
        let services = NativeAgentRuntimeServices::default();
        let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-tool-denied",
                "sessionId": "websocket:chat-tool-denied",
                "messages": [{ "role": "user", "content": "run shell" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [{
                            "content": "should not finish",
                            "toolCalls": [{
                                "id": "call-denied",
                                "name": "shell.exec",
                                "argumentsJson": "{\"command\":\"rm -rf .\"}",
                                "result": { "content": "denied" }
                            }]
                        }]
                    }
                }
            }),
        )
        .expect("tool denial should return a structured result");

        assert_eq!(result["stopReason"], "policy_denied");
        assert_eq!(result["toolsUsed"], json!([]));
        assert!(result["error"]
            .as_str()
            .expect("tool error should be a string")
            .contains("not permitted"));
        assert_eq!(
            event_names(&result),
            vec!["agent.tool_call.delta", "agent.error"]
        );
        assert_eq!(result["events"][1]["payload"]["toolName"], "shell.exec");
    }

    #[test]
    fn reports_provider_and_iteration_errors_as_frontend_events() {
        let provider_error = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-error",
            "sessionId": "websocket:chat-1",
            "messages": [{ "role": "user", "content": "hello" }],
            "config": {
                "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
                "providers": { "openai": { "api_key": "" } }
            }
        }))
        .expect("provider error should return compatibility result");
        let iteration_error = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-iteration",
            "sessionId": "websocket:chat-1",
            "maxIterations": 0
        }))
        .expect("iteration error should return compatibility result");

        assert_eq!(provider_error["stopReason"], "provider_error");
        assert_eq!(provider_error["events"][0]["eventName"], "agent.error");
        assert_eq!(iteration_error["stopReason"], "max_iterations");
        assert_eq!(iteration_error["events"][0]["eventName"], "agent.error");
    }

    #[test]
    fn stops_with_max_iterations_after_bounded_tool_iterations() {
        let result = run_native_agent_turn_with_config(
            &NativeAgentRuntimeServices::default(),
            json!({
                "runtime": "rust",
                "runId": "run-max-iterations",
                "sessionId": "websocket:chat-max-iterations",
                "maxIterations": 1,
                "messages": [{ "role": "user", "content": "read forever" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-read",
                                    "name": "workspace.read_file",
                                    "argumentsJson": "{\"path\":\"README.md\"}",
                                    "result": { "content": "README body" }
                                }]
                            },
                            { "content": "unreachable final" }
                        ]
                    }
                }
            }),
        )
        .expect("max iteration run should return a structured result");

        assert_eq!(result["stopReason"], "max_iterations");
        assert_eq!(result["finalContent"], "");
        assert_eq!(result["toolsUsed"], json!(["workspace.read_file"]));
        assert_eq!(
            result["events"].as_array().unwrap().last().unwrap()["eventName"],
            "agent.error"
        );
        assert_eq!(
            result["events"].as_array().unwrap().last().unwrap()["payload"]["stopReason"],
            "max_iterations"
        );
    }

    #[test]
    fn denied_tool_stops_with_policy_denied_without_tool_dispatch() {
        let result = run_native_agent_turn_with_config(
            &NativeAgentRuntimeServices::default(),
            json!({
                "runtime": "rust",
                "runId": "run-policy-denied",
                "sessionId": "websocket:chat-policy-denied",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "run shell" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [{
                            "content": "",
                            "toolCalls": [{
                                "id": "call-denied",
                                "name": "shell.exec",
                                "argumentsJson": "{\"command\":\"rm -rf .\"}",
                                "result": { "content": "must not execute" }
                            }]
                        }]
                    }
                }
            }),
        )
        .expect("policy denial should return a structured result");

        assert_eq!(result["stopReason"], "policy_denied");
        assert_eq!(result["toolsUsed"], json!([]));
        assert_eq!(
            event_names(&result),
            vec!["agent.tool_call.delta", "agent.error"]
        );
        assert_eq!(result["events"][1]["payload"]["toolName"], "shell.exec");
    }

    #[test]
    fn cancellation_before_tool_dispatch_stops_without_dispatching_tool() {
        struct CancellingProvider {
            cancellations: Arc<InMemoryNativeAgentCancellation>,
        }

        impl NativeAgentProvider for CancellingProvider {
            fn complete(
                &self,
                context: &NativeAgentRunContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                self.cancellations.cancel(&context.run_id);
                Ok(NativeAgentProviderResponse {
                    final_content: "needs cancelled tool".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-cancel-before-tool".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "must not run" }),
                    }],
                })
            }
        }

        struct PanickingToolDispatcher;

        impl NativeAgentToolDispatcher for PanickingToolDispatcher {
            fn dispatch(
                &self,
                _context: &NativeAgentRunContext,
                _tool_call: &NativeAgentToolCall,
            ) -> Result<NativeAgentToolResult, String> {
                panic!("tool dispatch should be skipped after cancellation");
            }
        }

        let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
        let services = NativeAgentRuntimeServices::new(
            Arc::new(CancellingProvider {
                cancellations: cancellations.clone(),
            }),
            Arc::new(PanickingToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            cancellations,
        );

        let result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-cancel-before-tool",
                "sessionId": "websocket:chat-cancel-before-tool",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read then cancel" }]
            }),
        )
        .expect("cancelled run should return a structured result");

        assert_eq!(result["stopReason"], "cancelled");
        assert_eq!(result["toolsUsed"], json!([]));
        assert!(result["completedToolResults"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            event_names(&result),
            vec!["agent.tool_call.delta", "agent.cancelled"]
        );
        assert_eq!(result["checkpoint"]["phase"], "cancelled");
        assert_eq!(result["checkpoint"]["iteration"], 0);
    }

    #[test]
    fn cancellation_after_tool_result_preserves_completed_tool_state() {
        struct SingleToolProvider {
            calls: Mutex<u32>,
        }

        impl NativeAgentProvider for SingleToolProvider {
            fn complete(
                &self,
                _context: &NativeAgentRunContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                let mut calls = self
                    .calls
                    .lock()
                    .expect("provider calls lock should not be poisoned");
                *calls += 1;
                assert_eq!(
                    *calls, 1,
                    "provider should not be called after cancellation"
                );
                Ok(NativeAgentProviderResponse {
                    final_content: "needs one tool".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-cancel-after-result".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "README" }),
                    }],
                })
            }
        }

        struct CancellingToolDispatcher {
            cancellations: Arc<InMemoryNativeAgentCancellation>,
        }

        impl NativeAgentToolDispatcher for CancellingToolDispatcher {
            fn dispatch(
                &self,
                context: &NativeAgentRunContext,
                tool_call: &NativeAgentToolCall,
            ) -> Result<NativeAgentToolResult, String> {
                self.cancellations.cancel(&context.run_id);
                Ok(NativeAgentToolResult::generic_success(
                    tool_call,
                    tool_call.result.clone(),
                ))
            }
        }

        let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
        let services = NativeAgentRuntimeServices::new(
            Arc::new(SingleToolProvider {
                calls: Mutex::new(0),
            }),
            Arc::new(CancellingToolDispatcher {
                cancellations: cancellations.clone(),
            }),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            cancellations,
        );

        let result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-cancel-after-result",
                "sessionId": "websocket:chat-cancel-after-result",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read then cancel" }]
            }),
        )
        .expect("cancelled run should preserve completed tool result state");

        assert_eq!(result["stopReason"], "cancelled");
        assert_eq!(result["toolsUsed"], json!(["workspace.read_file"]));
        assert_eq!(
            result["completedToolResults"][0]["toolCallId"],
            "call-cancel-after-result"
        );
        assert_eq!(
            event_names(&result),
            vec![
                "agent.tool_call.delta",
                "agent.tool.start",
                "agent.tool.result",
                "agent.cancelled"
            ]
        );
        assert_eq!(
            result["checkpoint"]["completedToolResults"][0]["toolCallId"],
            "call-cancel-after-result"
        );
    }

    #[test]
    fn stores_active_turn_tool_wait_and_cancellation_checkpoints() {
        struct CheckpointAwareProvider {
            checkpoints: Arc<InMemoryNativeAgentCheckpointStore>,
            calls: Mutex<u32>,
        }

        impl NativeAgentProvider for CheckpointAwareProvider {
            fn complete(
                &self,
                context: &NativeAgentRunContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                let checkpoint = self
                    .checkpoints
                    .restore(&context.session_id)
                    .expect("active turn checkpoint should be present during provider call");
                assert_eq!(checkpoint["phase"], "active_turn");
                let mut calls = self
                    .calls
                    .lock()
                    .expect("provider call lock should not be poisoned");
                *calls += 1;
                if *calls == 1 {
                    Ok(NativeAgentProviderResponse {
                        final_content: "needs tool".to_string(),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: vec![NativeAgentToolCall {
                            id: "call-checkpoint".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: "{\"path\":\"README.md\"}".to_string(),
                            result: json!({ "content": "README" }),
                        }],
                    })
                } else {
                    Ok(NativeAgentProviderResponse {
                        final_content: "checkpoint-aware final".to_string(),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: Vec::new(),
                    })
                }
            }
        }

        struct CheckpointAwareToolDispatcher {
            checkpoints: Arc<InMemoryNativeAgentCheckpointStore>,
        }

        impl NativeAgentToolDispatcher for CheckpointAwareToolDispatcher {
            fn dispatch(
                &self,
                context: &NativeAgentRunContext,
                tool_call: &NativeAgentToolCall,
            ) -> Result<NativeAgentToolResult, String> {
                let checkpoint = self
                    .checkpoints
                    .restore(&context.session_id)
                    .expect("tool wait checkpoint should be present during tool dispatch");
                assert_eq!(checkpoint["phase"], "awaiting_tool");
                assert_eq!(checkpoint["schemaVersion"], 1);
                assert_eq!(checkpoint["runtime"], "rust");
                assert_eq!(checkpoint["runId"], context.run_id);
                assert_eq!(checkpoint["sessionId"], context.session_id);
                assert_eq!(checkpoint["iteration"], 0);
                assert_eq!(checkpoint["maxIterations"], 2);
                assert_eq!(
                    checkpoint["pendingToolCalls"][0]["toolCallId"],
                    tool_call.id
                );
                assert_eq!(
                    checkpoint["pendingToolCalls"][0]["toolName"],
                    tool_call.name
                );
                assert!(checkpoint["completedToolResults"]
                    .as_array()
                    .expect("completed results should be an array")
                    .is_empty());
                Ok(NativeAgentToolResult::generic_success(
                    tool_call,
                    tool_call.result.clone(),
                ))
            }
        }

        let checkpoints = Arc::new(InMemoryNativeAgentCheckpointStore::default());
        let services = NativeAgentRuntimeServices::new(
            Arc::new(CheckpointAwareProvider {
                checkpoints: checkpoints.clone(),
                calls: Mutex::new(0),
            }),
            Arc::new(CheckpointAwareToolDispatcher {
                checkpoints: checkpoints.clone(),
            }),
            checkpoints.clone(),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        );
        let result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-checkpoint-storage",
                "sessionId": "websocket:chat-checkpoint-storage",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "read" }]
            }),
        )
        .expect("checkpoint-aware run should complete");

        assert_eq!(result["stopReason"], "final_response");
        assert!(
            services.restore_checkpoint("websocket:chat-checkpoint-storage")["checkpoint"]
                .is_null()
        );

        services.cancel("run-cancel-checkpoint");
        let cancelled = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-cancel-checkpoint",
                "sessionId": "websocket:chat-cancel-checkpoint"
            }),
        )
        .expect("cancelled run should return a checkpointed cancellation result");

        assert_eq!(cancelled["stopReason"], "cancelled");
        assert_eq!(cancelled["checkpoint"]["phase"], "cancelled");
        assert_eq!(
            services.restore_checkpoint("websocket:chat-cancel-checkpoint")["checkpoint"]["phase"],
            "cancelled"
        );
    }

    #[test]
    fn runtime_checkpoint_store_isolates_same_session_runs() {
        let services = NativeAgentRuntimeServices::default();
        services.save_run_checkpoint(
            "websocket:chat-1",
            "run-1",
            json!({
                "sessionId": "websocket:chat-1",
                "runId": "run-1",
                "phase": "awaiting_tool"
            }),
        );
        services.save_run_checkpoint(
            "websocket:chat-1",
            "run-2",
            json!({
                "sessionId": "websocket:chat-1",
                "runId": "run-2",
                "phase": "awaiting_approval"
            }),
        );

        assert_eq!(
            services.restore_run_checkpoint("websocket:chat-1", "run-1")["checkpoint"]["runId"],
            "run-1"
        );
        assert_eq!(
            services.restore_run_checkpoint("websocket:chat-1", "run-2")["checkpoint"]["runId"],
            "run-2"
        );

        services.clear_run_checkpoint("websocket:chat-1", "run-1");
        assert!(
            services.restore_run_checkpoint("websocket:chat-1", "run-1")["checkpoint"].is_null()
        );
        assert_eq!(
            services.restore_run_checkpoint("websocket:chat-1", "run-2")["checkpoint"]["runId"],
            "run-2"
        );
    }

    #[test]
    fn runtime_checkpoint_restore_by_session_uses_latest_resumable_run() {
        let services = NativeAgentRuntimeServices::default();
        services.save_run_checkpoint(
            "websocket:chat-1",
            "run-old",
            json!({
                "sessionId": "websocket:chat-1",
                "runId": "run-old",
                "phase": "awaiting_tool"
            }),
        );
        services.save_run_checkpoint(
            "websocket:chat-1",
            "run-new",
            json!({
                "sessionId": "websocket:chat-1",
                "runId": "run-new",
                "phase": "awaiting_form"
            }),
        );

        let restored = services.restore_checkpoint("websocket:chat-1");

        assert_eq!(restored["checkpoint"]["runId"], "run-new");
    }

    #[test]
    fn saves_and_restores_approval_checkpoint_before_resume() {
        let services = NativeAgentRuntimeServices::default();
        let awaiting = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-approval",
                "sessionId": "websocket:chat-approval",
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-1",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
        )
        .expect("approval checkpoint should be created");

        assert_eq!(awaiting["stopReason"], "awaiting_approval");
        assert_eq!(awaiting["checkpoint"]["schemaVersion"], 1);
        assert_eq!(awaiting["checkpoint"]["runId"], "run-approval");
        assert_eq!(
            awaiting["checkpoint"]["sessionId"],
            "websocket:chat-approval"
        );
        assert_eq!(awaiting["checkpoint"]["phase"], "awaiting_approval");
        assert_eq!(awaiting["checkpoint"]["iteration"], 0);
        assert_eq!(awaiting["checkpoint"]["maxIterations"], 1);
        assert_eq!(
            awaiting["checkpoint"]["pendingToolCalls"][0]["toolCallId"],
            "approval-1"
        );
        assert_eq!(
            awaiting["checkpoint"]["pendingToolCalls"][0]["toolName"],
            "workspace.write_file"
        );
        assert!(awaiting["checkpoint"]["completedToolResults"]
            .as_array()
            .expect("approval completed results should be an array")
            .is_empty());
        assert_eq!(awaiting["checkpoint"]["resumeToken"], "approval:approval-1");
        assert_eq!(
            services.restore_checkpoint("websocket:chat-approval")["checkpoint"]["phase"],
            "awaiting_approval"
        );

        let resumed = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-approval",
                "sessionId": "websocket:chat-approval",
                "metadata": {
                    "fakeApprovalResume": {
                        "approved": true,
                        "finalContent": "Approved write completed."
                    }
                }
            }),
        )
        .expect("approval resume should complete");

        assert_eq!(resumed["stopReason"], "final_response");
        assert_eq!(resumed["restoredCheckpoint"]["phase"], "awaiting_approval");
        assert!(services.restore_checkpoint("websocket:chat-approval")["checkpoint"].is_null());
    }

    #[test]
    fn handles_approval_denial_form_submit_and_cancel_events() {
        let services = NativeAgentRuntimeServices::default();
        let denied = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-denied",
                "sessionId": "websocket:chat-denied",
                "metadata": { "fakeApprovalResume": { "approved": false } }
            }),
        )
        .expect("approval denial should return error compatibility result");
        let awaiting_form = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-form",
                "sessionId": "websocket:chat-form",
                "metadata": {
                    "fakeAwaitingForm": {
                        "formId": "form-1",
                        "title": "Configure run"
                    }
                }
            }),
        )
        .expect("form checkpoint should be created");
        let submitted = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-form",
                "sessionId": "websocket:chat-form",
                "metadata": {
                    "fakeFormSubmit": {
                        "finalContent": "Form values accepted."
                    }
                }
            }),
        )
        .expect("form submit should complete");
        let cancelled = services.cancel("run-cancel");
        let cancel_result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-cancel",
                "sessionId": "websocket:chat-cancel"
            }),
        )
        .expect("cancelled run should return cancellation result");

        assert_eq!(denied["stopReason"], "approval_denied");
        assert_eq!(
            awaiting_form["events"][1]["eventName"],
            "agent.awaiting_form"
        );
        assert_eq!(awaiting_form["checkpoint"]["schemaVersion"], 1);
        assert_eq!(awaiting_form["checkpoint"]["runId"], "run-form");
        assert_eq!(
            awaiting_form["checkpoint"]["sessionId"],
            "websocket:chat-form"
        );
        assert_eq!(awaiting_form["checkpoint"]["phase"], "awaiting_form");
        assert_eq!(awaiting_form["checkpoint"]["iteration"], 0);
        assert_eq!(awaiting_form["checkpoint"]["maxIterations"], 1);
        assert!(awaiting_form["checkpoint"]["pendingToolCalls"]
            .as_array()
            .expect("form pending tool calls should be an array")
            .is_empty());
        assert!(awaiting_form["checkpoint"]["completedToolResults"]
            .as_array()
            .expect("form completed results should be an array")
            .is_empty());
        assert_eq!(awaiting_form["checkpoint"]["resumeToken"], "form:form-1");
        assert_eq!(submitted["finalContent"], "Form values accepted.");
        assert_eq!(cancelled["stopReason"], "cancelled");
        assert_eq!(cancelled["error"], "cancelled");
        assert_eq!(cancelled["events"][0]["eventName"], "agent.cancelled");
        assert_eq!(cancelled["events"][0]["payload"]["stopReason"], "cancelled");
        assert_eq!(cancel_result["stopReason"], "cancelled");
    }

    fn event_names(result: &Value) -> Vec<&str> {
        result["events"]
            .as_array()
            .expect("events should be an array")
            .iter()
            .map(|event| event["eventName"].as_str().unwrap_or_default())
            .collect::<Vec<_>>()
    }

    fn fixture_provider_config(content: &str) -> Value {
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": content }] } }
        })
    }
}
