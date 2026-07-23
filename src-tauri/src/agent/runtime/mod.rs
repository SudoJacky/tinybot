use crate::agent::runtime_protocol::{
    AgentRuntimeEventEnvelope, AgentTraceContext, LegacyNativeAgentEventProjection,
};
use crate::collaboration::subagents::SubagentThreadManager;
#[cfg(test)]
use crate::collaboration::subagents::{
    SubagentInputSender, SubagentSendInputParams, SubagentTargetParams,
};
use crate::runtime::mcp::McpRuntime;
use crate::runtime::turn_execution::{AgentCancelReason, TurnExecutionRuntime};
use crate::tools::shell::WorkerShellRuntime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(crate) const DEFAULT_NATIVE_AGENT_MAX_ITERATIONS: i64 = 200;

pub(crate) mod approvals;
mod checkpoint;
mod context;
mod context_contributors;
mod context_manager;
mod continuations;
mod events;
mod hooks;
mod instructions;
mod item_event_projection;
mod items;
mod provider;
mod provider_adapter;
mod provider_loop;
mod result;
mod settings;
mod state;
mod stores;
mod tool_dispatcher;
mod tool_projection;
mod tool_result;
mod tool_router;
mod tool_runtime;
mod usage;
mod user_input;

pub(crate) use self::context::{agent_trace_context_from_value, ensure_agent_trace_context};
pub(crate) use self::hooks::AgentHookEvaluation;

#[cfg(test)]
pub use self::context_contributors::AgentContextContribution;
pub use self::context_contributors::{AgentContextContributor, AgentContextRequest};
#[cfg(test)]
pub use self::hooks::AgentHookDecision;
pub use self::hooks::{AgentHook, AgentHookInvocation, AgentHookStage};
pub(crate) use self::instructions::{ComposedInstructions, InstructionComposer};
#[cfg(test)]
pub use self::items::AgentPlanStepStatus;
pub use self::items::{
    validate_and_normalize_plan_steps, AgentAssistantMessage, AgentInstructionMessage,
    AgentInstructionRole, AgentItem, AgentItemHistory, AgentMessageContent, AgentPlanProgressItem,
    AgentPlanStep, AgentReasoningItem, AgentToolCallItem, AgentToolResultItem, AgentUsageItem,
};
#[cfg(test)]
use self::provider::agent_chat_completion_request;
use self::provider::{agent_provider_config, chat_completion_content, RustNativeAgentProvider};
use self::result::event_value;
pub use self::settings::AgentTurnSettings;
use self::tool_router::NativeToolRouter;
use self::usage::context_window_messages_async;
#[cfg(test)]
use self::usage::{context_window_messages, enrich_usage_with_context_window};
pub use crate::runtime::observability::AgentRuntimeMetrics;
pub(crate) use provider_loop::run_native_agent_turn_with_workspace_and_instructions_async;
pub use provider_loop::run_native_agent_turn_with_workspace_async;
#[cfg(test)]
pub use provider_loop::{
    run_native_agent_turn_with_config, run_native_agent_turn_with_config_async,
    run_native_agent_turn_with_workspace,
};
pub use stores::{InMemoryNativeAgentCancellation, InMemoryNativeAgentCheckpointStore};
#[cfg(test)]
pub use tool_dispatcher::FakeNativeAgentToolDispatcher;
pub use tool_dispatcher::SubagentNativeAgentToolDispatcher;

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeAgentRuntimeMode {
    Rust,
}

#[derive(Clone)]
pub struct NativeAgentCancellationContext {
    turn_id: String,
    cancellations: Arc<dyn NativeAgentCancellation>,
    task_runtime: TurnExecutionRuntime,
    root_token: Option<CancellationToken>,
    child_token: Option<CancellationToken>,
}

impl NativeAgentCancellationContext {
    fn new(
        turn_id: String,
        cancellations: Arc<dyn NativeAgentCancellation>,
        task_runtime: TurnExecutionRuntime,
    ) -> Self {
        let root_token = task_runtime.cancellation_token(&turn_id);
        Self {
            turn_id,
            cancellations,
            task_runtime,
            root_token,
            child_token: None,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.child_token
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
            || self
                .root_token
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            || self.task_runtime.is_cancelled(&self.turn_id)
            || self.cancellations.is_cancelled(&self.turn_id)
    }

    fn with_child_token(&self, child_token: CancellationToken) -> Self {
        let mut child = self.clone();
        child.child_token = Some(child_token);
        child
    }

    pub(crate) async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    fn begin_pause(&self) -> Option<String> {
        self.task_runtime.begin_pause(&self.turn_id)
    }

    async fn wait_for_resume(&self) -> Result<String, String> {
        self.task_runtime
            .wait_for_resume(&self.turn_id)
            .await
            .map_err(|error| error.to_string())
    }
}

impl fmt::Debug for NativeAgentCancellationContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeAgentCancellationContext")
            .field("turn_id", &self.turn_id)
            .finish_non_exhaustive()
    }
}

impl crate::protocol::WorkerRequestCancellation for NativeAgentCancellationContext {
    fn is_cancelled(&self) -> bool {
        self.is_cancelled()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NativeAgentEvent {
    #[serde(rename = "eventName")]
    pub event_name: String,
    pub payload: Value,
}

impl From<LegacyNativeAgentEventProjection> for NativeAgentEvent {
    fn from(event: LegacyNativeAgentEventProjection) -> Self {
        Self {
            event_name: event.event_name,
            payload: event.payload,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentTurnContext {
    pub turn_id: String,
    pub session_id: String,
    pub thread_id: Option<String>,
    pub spec: Value,
    pub messages: Vec<Value>,
    pub config_snapshot: Value,
    pub metadata: Value,
    pub model: String,
    pub provider: Option<String>,
    pub system_prompt: Option<String>,
    pub instructions: Option<ComposedInstructions>,
    assembled_system_prompt: Option<String>,
    context_contributions: Vec<Value>,
    pub stream: bool,
    pub max_iterations: i64,
    pub settings: AgentTurnSettings,
    pub cancellation: Option<NativeAgentCancellationContext>,
    pub trace_context: AgentTraceContext,
    hooks: hooks::AgentHookPipeline,
    metrics: AgentRuntimeMetrics,
    pending_hook_evaluations:
        Arc<std::sync::Mutex<Vec<(AgentHookInvocation, hooks::AgentHookEvaluation)>>>,
    tool_router: NativeToolRouter,
}

#[derive(Clone, Debug)]
pub struct NativeAgentProviderResponse {
    pub final_content: String,
    pub reasoning_delta: Option<String>,
    pub usage: Option<Value>,
    pub tool_calls: Vec<NativeAgentToolCall>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NativeAgentProviderStreamEvent {
    MessagePhase(crate::agent::runtime_protocol::AgentAssistantMessagePhase),
    ContentDelta(String),
    ReasoningDelta(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeAgentProviderFailureKind {
    Cancelled,
    RequestTimeout,
    StreamIdleTimeout,
    Transport,
    Provider,
}

impl NativeAgentProviderFailureKind {
    fn stop_reason(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::RequestTimeout => "provider_request_timeout",
            Self::StreamIdleTimeout => "provider_stream_idle_timeout",
            Self::Transport => "provider_transport_error",
            Self::Provider => "provider_error",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeAgentProviderFailure {
    kind: NativeAgentProviderFailureKind,
    message: String,
}

impl NativeAgentProviderFailure {
    pub fn new(kind: NativeAgentProviderFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(NativeAgentProviderFailureKind::Provider, message)
    }

    pub fn kind(&self) -> NativeAgentProviderFailureKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn stop_reason(&self) -> &'static str {
        self.kind.stop_reason()
    }
}

impl fmt::Display for NativeAgentProviderFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for NativeAgentProviderFailure {}

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

pub trait NativeAgentProvider: Send + Sync + 'static {
    #[cfg(test)]
    fn complete(&self, context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String>;

    #[cfg(test)]
    fn complete_streaming(
        &self,
        context: &AgentTurnContext,
        _observer: &mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
    ) -> Result<NativeAgentProviderResponse, String> {
        self.complete(context)
    }

    fn complete_streaming_async<'a>(
        self: Arc<Self>,
        context: &'a AgentTurnContext,
        observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
    ) -> Pin<
        Box<
            dyn Future<Output = Result<NativeAgentProviderResponse, NativeAgentProviderFailure>>
                + Send
                + 'a,
        >,
    > {
        #[cfg(test)]
        {
            let context = context.clone();
            return Box::pin(async move {
                let (result, events) = tauri::async_runtime::spawn_blocking(move || {
                    let mut events = Vec::new();
                    let result = self.complete_streaming(&context, &mut |event| events.push(event));
                    (result, events)
                })
                .await
                .map_err(|error| {
                    NativeAgentProviderFailure::provider(format!(
                        "blocking provider test task failed: {error}"
                    ))
                })?;
                for event in events {
                    observer(event);
                }
                result.map_err(NativeAgentProviderFailure::provider)
            });
        }
        #[cfg(not(test))]
        {
            let _ = (self, context, observer);
            Box::pin(async {
                Err(NativeAgentProviderFailure::provider(
                    "native agent provider must implement complete_streaming_async",
                ))
            })
        }
    }
}

pub trait NativeAgentToolDispatcher: Send + Sync + 'static {
    fn dispatch(
        &self,
        context: &AgentTurnContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String>;

    fn dispatch_async(
        self: Arc<Self>,
        context: AgentTurnContext,
        tool_call: NativeAgentToolCall,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send>,
    > {
        #[cfg(test)]
        {
            return Box::pin(async move {
                tauri::async_runtime::spawn_blocking(move || self.dispatch(&context, &tool_call))
                    .await
                    .map_err(|error| format!("blocking native tool test task failed: {error}"))?
            });
        }
        #[cfg(not(test))]
        {
            let _ = (self, context, tool_call);
            Box::pin(async {
                Err("native agent tool dispatcher must implement dispatch_async".to_string())
            })
        }
    }
}

pub trait NativeAgentCheckpointStore: Send + Sync {
    fn save(&self, session_id: &str, checkpoint: Value);
    fn save_for_turn(&self, session_id: &str, turn_id: &str, checkpoint: Value);
    fn restore(&self, session_id: &str) -> Option<Value>;
    fn restore_for_turn(&self, session_id: &str, turn_id: &str) -> Option<Value>;
    fn clear_for_turn(&self, session_id: &str, turn_id: &str);
}

#[derive(Clone, Debug)]
pub struct NativeAgentContextCheckpointCommit {
    pub session_id: String,
    pub turn_id: String,
    pub thread_id: Option<String>,
    pub checkpoint: Value,
}

pub trait NativeAgentContextCheckpointCommitter: Send + Sync {
    fn commit(&self, input: &NativeAgentContextCheckpointCommit) -> Result<(), String>;
}

#[derive(Default)]
struct InMemoryNativeAgentContextCheckpointCommitter {
    state: std::sync::Mutex<InMemoryContextCheckpointState>,
}

#[derive(Default)]
struct InMemoryContextCheckpointState {
    checkpoints: std::collections::HashMap<(String, String), Value>,
    latest_checkpoints: std::collections::HashMap<String, Value>,
}

impl NativeAgentContextCheckpointCommitter for InMemoryNativeAgentContextCheckpointCommitter {
    fn commit(&self, input: &NativeAgentContextCheckpointCommit) -> Result<(), String> {
        let context_id = input
            .checkpoint
            .get("contextId")
            .and_then(Value::as_str)
            .ok_or_else(|| "context checkpoint is missing contextId".to_string())?;
        let key = (input.session_id.clone(), context_id.to_string());
        let mut state = self
            .state
            .lock()
            .map_err(|_| "in-memory context checkpoint lock is poisoned".to_string())?;
        if let Some(existing) = state.checkpoints.get(&key) {
            if existing != &input.checkpoint {
                return Err(format!(
                    "context checkpoint identity `{context_id}` already has different content"
                ));
            }
            return Ok(());
        }
        if let Some(current) = state.latest_checkpoints.get(&input.session_id) {
            crate::threads::rollout::checkpoint_lineage::validate_context_checkpoint_successor(
                &input.session_id,
                Some(current),
                &input.checkpoint,
            )
            .map_err(|error| error.to_string())?;
        }
        state.checkpoints.insert(key, input.checkpoint.clone());
        state
            .latest_checkpoints
            .insert(input.session_id.clone(), input.checkpoint.clone());
        Ok(())
    }
}

pub trait NativeAgentCancellation: Send + Sync {
    fn cancel(&self, turn_id: &str);
    fn cancel_with_command_id(&self, turn_id: &str, command_id: &str) {
        let _ = command_id;
        self.cancel(turn_id);
    }
    fn command_id(&self, _turn_id: &str) -> Option<String> {
        None
    }
    fn is_cancelled(&self, turn_id: &str) -> bool;
}

pub trait NativeAgentTraceSink: Send + Sync {
    fn load_runtime_events(
        &self,
        _session_id: &str,
        _turn_id: &str,
    ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
        Ok(Vec::new())
    }

    fn append_trace_event(
        &self,
        session_id: &str,
        turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String>;

    fn append_trace_events(
        &self,
        session_id: &str,
        turn_id: &str,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Result<(), String> {
        for event in events {
            self.append_trace_event(session_id, turn_id, event)?;
        }
        Ok(())
    }

    fn append_timeline_patch(
        &self,
        _session_id: &str,
        _turn_id: &str,
        _patch: &crate::agent::runtime_protocol::AgentTimelinePatch,
    ) -> Result<(), String> {
        Ok(())
    }

    fn flush(&self) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct NativeAgentRuntimeServices {
    provider: Arc<dyn NativeAgentProvider>,
    tools: Arc<dyn NativeAgentToolDispatcher>,
    checkpoints: Arc<dyn NativeAgentCheckpointStore>,
    context_checkpoint_committer: Arc<dyn NativeAgentContextCheckpointCommitter>,
    cancellations: Arc<dyn NativeAgentCancellation>,
    subagents: SubagentThreadManager,
    trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    mcp_runtime: McpRuntime,
    shell_runtime: WorkerShellRuntime,
    browser_runtime: Option<crate::native_browser::SharedBrowserRuntime>,
    task_runtime: TurnExecutionRuntime,
    hooks: hooks::AgentHookPipeline,
    context_contributors: context_contributors::AgentContextContributorRegistry,
    metrics: AgentRuntimeMetrics,
    approvals: approvals::NativeAgentApprovalBroker,
    thread_store: Option<crate::threads::workspace_store::WorkspaceThreadStore>,
    #[cfg(test)]
    test_activated_tool_ids: Vec<String>,
    #[cfg(test)]
    test_tool_registry_entries: Option<Vec<crate::tools::registry::ToolRegistryEntry>>,
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
            context_checkpoint_committer: Arc::new(
                InMemoryNativeAgentContextCheckpointCommitter::default(),
            ),
            cancellations,
            subagents: SubagentThreadManager::default(),
            trace_sink: None,
            mcp_runtime: McpRuntime::new(),
            shell_runtime: WorkerShellRuntime::default(),
            browser_runtime: None,
            task_runtime: TurnExecutionRuntime::new(),
            hooks: hooks::AgentHookPipeline::default(),
            context_contributors: context_contributors::AgentContextContributorRegistry::default(),
            metrics: crate::runtime::observability::global_agent_runtime_metrics().clone(),
            approvals: approvals::NativeAgentApprovalBroker::default(),
            thread_store: None,
            #[cfg(test)]
            test_activated_tool_ids: Vec::new(),
            #[cfg(test)]
            test_tool_registry_entries: None,
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

    pub fn with_trace_sink(mut self, trace_sink: Arc<dyn NativeAgentTraceSink>) -> Self {
        self.trace_sink = Some(trace_sink);
        self
    }

    pub fn with_context_checkpoint_committer(
        mut self,
        committer: Arc<dyn NativeAgentContextCheckpointCommitter>,
    ) -> Self {
        self.context_checkpoint_committer = committer;
        self
    }

    pub(crate) async fn commit_context_checkpoint(
        &self,
        input: NativeAgentContextCheckpointCommit,
    ) -> Result<(), String> {
        let committer = self.context_checkpoint_committer.clone();
        tauri::async_runtime::spawn_blocking(move || committer.commit(&input))
            .await
            .map_err(|error| format!("context checkpoint commit task failed: {error}"))?
    }

    pub(crate) fn flush_trace_sink(&self) -> Result<(), String> {
        self.trace_sink
            .as_ref()
            .map_or(Ok(()), |trace_sink| trace_sink.flush())
    }

    #[cfg(test)]
    pub fn with_hook(mut self, hook: Arc<dyn AgentHook>) -> Self {
        self.hooks = self.hooks.with_hook(hook);
        self
    }

    #[cfg(test)]
    pub fn try_with_context_contributor(
        mut self,
        contributor: Arc<dyn AgentContextContributor>,
    ) -> Result<Self, String> {
        self.context_contributors = self.context_contributors.with_contributor(contributor)?;
        Ok(self)
    }

    #[cfg(test)]
    pub fn with_metrics(mut self, metrics: AgentRuntimeMetrics) -> Self {
        self.metrics = metrics;
        self
    }

    pub(crate) fn evaluate_hook_invocation(
        &self,
        invocation: AgentHookInvocation,
    ) -> Result<AgentHookEvaluation, String> {
        self.hooks.evaluate(invocation, &self.metrics)
    }

    pub fn tool_dispatcher(&self) -> Arc<dyn NativeAgentToolDispatcher> {
        self.tools.clone()
    }

    pub fn with_tool_dispatcher(mut self, tools: Arc<dyn NativeAgentToolDispatcher>) -> Self {
        self.tools = tools;
        self
    }

    pub(crate) fn with_mcp_runtime(mut self, runtime: McpRuntime) -> Self {
        self.mcp_runtime = runtime;
        self
    }

    pub(crate) fn with_thread_store(
        mut self,
        thread_store: crate::threads::workspace_store::WorkspaceThreadStore,
    ) -> Self {
        self.thread_store = Some(thread_store);
        self
    }

    pub(crate) fn thread_store(
        &self,
    ) -> Result<crate::threads::workspace_store::WorkspaceThreadStore, String> {
        self.thread_store
            .clone()
            .ok_or_else(|| "native agent workspace thread store is unavailable".to_string())
    }

    pub(crate) fn mcp_runtime(&self) -> McpRuntime {
        self.mcp_runtime.clone()
    }

    pub(crate) fn shell_runtime(&self) -> WorkerShellRuntime {
        self.shell_runtime.clone()
    }

    pub(crate) fn with_browser_runtime(
        mut self,
        runtime: crate::native_browser::SharedBrowserRuntime,
    ) -> Self {
        self.browser_runtime = Some(runtime);
        self
    }

    pub(crate) fn browser_runtime(&self) -> Option<crate::native_browser::SharedBrowserRuntime> {
        self.browser_runtime.clone()
    }

    pub(crate) fn task_runtime(&self) -> TurnExecutionRuntime {
        self.task_runtime.clone()
    }

    #[cfg(test)]
    fn with_test_activated_tools(mut self, tool_ids: &[&str]) -> Self {
        self.test_activated_tool_ids = tool_ids
            .iter()
            .map(|tool_id| (*tool_id).to_string())
            .collect();
        self
    }

    #[cfg(test)]
    fn with_test_tool_registry_entries(
        mut self,
        entries: Vec<crate::tools::registry::ToolRegistryEntry>,
    ) -> Self {
        self.test_tool_registry_entries = Some(entries);
        self
    }

    pub fn subagent_manager(&self) -> SubagentThreadManager {
        self.subagents.clone()
    }

    pub fn cancel(&self, turn_id: &str) -> Value {
        self.cancel_with_command_id(turn_id, None)
    }

    pub fn cancel_with_command_id(&self, turn_id: &str, command_id: Option<&str>) -> Value {
        if let Some(command_id) = command_id.filter(|value| !value.trim().is_empty()) {
            self.cancellations
                .cancel_with_command_id(turn_id, command_id);
        } else {
            self.cancellations.cancel(turn_id);
        }
        let task = self
            .task_runtime
            .request_cancel(turn_id, AgentCancelReason::UserRequested);
        self.approvals.cancel_turn(turn_id);
        serde_json::json!({
            "runtime": "rust",
            "turnId": turn_id,
            "cancelled": true,
            "finalContent": "",
            "stopReason": "cancelled",
            "commandId": command_id,
            "error": "cancelled",
            "messages": [],
            "toolsUsed": [],
            "task": task,
            "events": [event_value("agent.cancelled", serde_json::json!({
                "turnId": turn_id,
                "cancelled": true,
                "commandId": command_id,
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

    #[cfg(test)]
    pub fn restore_turn_checkpoint(&self, session_id: &str, turn_id: &str) -> Value {
        serde_json::json!({
            "runtime": "rust",
            "sessionId": session_id,
            "turnId": turn_id,
            "checkpoint": self.checkpoints.restore_for_turn(session_id, turn_id),
        })
    }

    pub fn save_checkpoint(&self, session_id: &str, checkpoint: Value) {
        self.checkpoints.save(session_id, checkpoint);
    }

    #[cfg(test)]
    pub fn save_turn_checkpoint(&self, session_id: &str, turn_id: &str, checkpoint: Value) {
        self.checkpoints
            .save_for_turn(session_id, turn_id, checkpoint);
    }

    #[cfg(test)]
    pub fn clear_turn_checkpoint(&self, session_id: &str, turn_id: &str) {
        self.checkpoints.clear_for_turn(session_id, turn_id);
    }

    pub(crate) fn approval_broker(&self) -> approvals::NativeAgentApprovalBroker {
        self.approvals.clone()
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

#[cfg(test)]
pub fn resolve_native_agent_runtime_mode(
    spec: &Value,
    config_snapshot: &Value,
) -> NativeAgentRuntimeMode {
    let _ = (spec, config_snapshot);
    NativeAgentRuntimeMode::Rust
}

#[cfg(test)]
pub fn run_native_agent_turn(spec: Value) -> Result<Value, String> {
    let services = NativeAgentRuntimeServices::default();
    let config_snapshot = spec
        .get("config")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    run_native_agent_turn_with_config(&services, spec, config_snapshot)
}

#[cfg(test)]
pub fn run_native_agent_turn_with_services(
    services: &NativeAgentRuntimeServices,
    spec: Value,
) -> Result<Value, String> {
    run_native_agent_turn_with_config(services, spec, serde_json::json!({}))
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
mod tests;
