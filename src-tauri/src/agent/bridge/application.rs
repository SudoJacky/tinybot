use crate::agent::runtime::{NativeAgentRuntimeServices, NativeAgentTraceSink};
use crate::collaboration::subagents::SubagentThreadManager;
use crate::runtime::mcp::McpRuntime;
use crate::threads::workspace_store::WorkspaceThreadStore;
use crate::tools::shell::WorkerShellRuntime;
use std::{path::Path, sync::Arc};

/// Application-owned resources shared by parent, child and resumed Turns.
#[derive(Clone)]
pub(crate) struct AgentApplicationServices {
    pub runtime: NativeAgentRuntimeServices,
    pub thread_store: WorkspaceThreadStore,
    pub mcp_runtime: McpRuntime,
    pub shell_runtime: WorkerShellRuntime,
    pub subagent_manager: SubagentThreadManager,
    pub browser_runtime: Option<crate::native_browser::SharedBrowserRuntime>,
}

impl AgentApplicationServices {
    /// Install persistence and tracing before capturing the services for child Turns.
    pub(super) fn prepare_turn(
        mut self,
        workspace_root: &Path,
        working_directory: &Path,
        base_config_snapshot: serde_json::Value,
        live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    ) -> NativeAgentRuntimeServices {
        self.runtime = self.runtime.with_context_checkpoint_committer(
            super::native_agent_context_checkpoint_committer(self.thread_store.clone()),
        );
        self.runtime = match live_trace_sink {
            Some(sink) => self.runtime.with_trace_sink(super::native_agent_trace_sink(
                self.thread_store.clone(),
                Some(sink),
            )),
            None => self.runtime.with_trace_sink_if_missing(|| {
                super::native_agent_trace_sink(self.thread_store.clone(), None)
            }),
        };
        #[cfg(not(test))]
        {
            self.runtime =
                self.runtime
                    .with_command_hooks(crate::command_hooks::CommandHookEngine::load(
                        self.thread_store.data_root(),
                        working_directory,
                    ));
        }
        #[cfg(test)]
        let _ = working_directory;
        super::native_agent_services_with_tool_executor(
            self,
            workspace_root.to_path_buf(),
            base_config_snapshot,
        )
    }
}

#[cfg(test)]
pub(crate) trait TestApplicationServices {
    fn with_thread_store(self, store: WorkspaceThreadStore) -> AgentApplicationServices;
}

#[cfg(test)]
impl TestApplicationServices for NativeAgentRuntimeServices {
    fn with_thread_store(self, store: WorkspaceThreadStore) -> AgentApplicationServices {
        AgentApplicationServices {
            runtime: self,
            thread_store: store,
            mcp_runtime: McpRuntime::new(),
            shell_runtime: WorkerShellRuntime::default(),
            subagent_manager: SubagentThreadManager::default(),
            browser_runtime: None,
        }
    }
}
