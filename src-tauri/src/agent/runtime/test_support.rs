//! Adapters for deliberately blocking test fixtures. Production implementations
//! must implement the same asynchronous contracts exercised by the runtime.
use super::{
    AgentError, AgentTurnContext, NativeAgentProvider, NativeAgentProviderFailure,
    NativeAgentProviderResponse, NativeAgentProviderStreamEvent, NativeAgentToolDispatcher,
    NativeAgentToolResult, PreparedToolCall,
};
use futures_util::future::BoxFuture;
use std::sync::Arc;

impl super::NativeAgentRuntimeServices {
    pub(crate) fn with_mcp_runtime(mut self, runtime: super::McpRuntime) -> Self {
        self.mcp_runtime = runtime;
        self
    }

    pub fn new(
        provider: Arc<dyn NativeAgentProvider>,
        tools: Arc<dyn NativeAgentToolDispatcher>,
        checkpoints: Arc<dyn super::NativeAgentCheckpointStore>,
        cancellations: Arc<dyn super::NativeAgentCancellation>,
    ) -> Self {
        Self::from_dependencies(super::NativeAgentRuntimeDependencies {
            provider,
            tools,
            checkpoints,
            context_checkpoint_committer: Arc::new(
                super::InMemoryNativeAgentContextCheckpointCommitter::default(),
            ),
            cancellations,
            subagents: super::SubagentThreadManager::default(),
            mcp_runtime: super::McpRuntime::new(),
            shell_runtime: super::WorkerShellRuntime::default(),
            task_runtime: super::TurnExecutionRuntime::new(),
            metrics: crate::runtime::observability::global_agent_runtime_metrics().clone(),
        })
    }

    pub fn with_subagent_manager(subagents: super::SubagentThreadManager) -> Self {
        Self::from_dependencies(super::NativeAgentRuntimeDependencies {
            provider: Arc::new(super::RustNativeAgentProvider),
            tools: Arc::new(super::SubagentNativeAgentToolDispatcher::new(
                subagents.clone(),
            )),
            checkpoints: Arc::new(super::InMemoryNativeAgentCheckpointStore::default()),
            context_checkpoint_committer: Arc::new(
                super::InMemoryNativeAgentContextCheckpointCommitter::default(),
            ),
            cancellations: Arc::new(super::InMemoryNativeAgentCancellation::default()),
            subagents,
            mcp_runtime: super::McpRuntime::new(),
            shell_runtime: super::WorkerShellRuntime::default(),
            task_runtime: super::TurnExecutionRuntime::new(),
            metrics: crate::runtime::observability::global_agent_runtime_metrics().clone(),
        })
    }
}

impl Default for super::NativeAgentRuntimeServices {
    fn default() -> Self {
        Self::with_subagent_manager(super::SubagentThreadManager::default())
    }
}

pub(crate) trait BlockingTestProvider: Send + Sync + 'static {
    fn complete(&self, context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String>;

    fn complete_streaming(
        &self,
        context: &AgentTurnContext,
        _observer: &mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
    ) -> Result<NativeAgentProviderResponse, String> {
        self.complete(context)
    }
}

impl<T: BlockingTestProvider> NativeAgentProvider for T {
    fn complete_streaming_async<'a>(
        self: Arc<Self>,
        context: &'a AgentTurnContext,
        observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
    ) -> BoxFuture<'a, Result<NativeAgentProviderResponse, NativeAgentProviderFailure>> {
        let context = context.clone();
        Box::pin(async move {
            let (result, events) = tauri::async_runtime::spawn_blocking(move || {
                let mut events = Vec::new();
                let result = self.complete_streaming(&context, &mut |event| events.push(event));
                (result, events)
            })
            .await
            .expect("blocking test provider task must join");
            for event in events {
                observer(event);
            }
            result.map_err(NativeAgentProviderFailure::provider)
        })
    }
}

pub(crate) trait BlockingTestToolDispatcher: Send + Sync + 'static {
    fn dispatch(
        &self,
        context: &AgentTurnContext,
        tool_call: &PreparedToolCall,
    ) -> Result<NativeAgentToolResult, String>;
}

impl<T: BlockingTestToolDispatcher> NativeAgentToolDispatcher for T {
    fn dispatch(
        &self,
        context: &AgentTurnContext,
        tool_call: &PreparedToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        BlockingTestToolDispatcher::dispatch(self, context, tool_call)
    }

    fn dispatch_async(
        self: Arc<Self>,
        context: AgentTurnContext,
        tool_call: PreparedToolCall,
    ) -> BoxFuture<'static, Result<NativeAgentToolResult, AgentError>> {
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || {
                BlockingTestToolDispatcher::dispatch(self.as_ref(), &context, &tool_call)
            })
            .await
            .expect("blocking test tool task must join")
            .map_err(AgentError::from)
        })
    }
}
