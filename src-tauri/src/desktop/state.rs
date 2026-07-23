use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::collaboration::subagents::SubagentThreadManager;
use crate::desktop_commands::gateway::native_backend_log_path;
use crate::runtime::lifecycle::RuntimeLifecycleStatus;
use crate::runtime::mcp::McpRuntime;
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use super::logging::append_native_backend_log_line;

pub(crate) type SharedGateway = Arc<Mutex<GatewayRuntime>>;

pub(crate) const NATIVE_BACKEND_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const NATIVE_BACKEND_LOG_TAIL_LINES: usize = 100;

pub(crate) struct GatewayRuntime {
    pub(crate) native_agent_runtime: NativeAgentRuntimeServices,
    pub(crate) mcp_runtime: McpRuntime,
    pub(crate) subagent_manager: SubagentThreadManager,
    pub(crate) thread_store: WorkspaceThreadStore,
    pub(crate) lifecycle_status: RuntimeLifecycleStatus,
    pub(crate) logs: VecDeque<String>,
    pub(crate) persistent_log_path: PathBuf,
    pub(crate) last_error: Option<String>,
    pub(crate) keep_background: bool,
}

impl Default for GatewayRuntime {
    fn default() -> Self {
        Self::new(crate::config::application::native_backend_workspace_root())
    }
}

impl GatewayRuntime {
    pub(crate) fn new(workspace_root: PathBuf) -> Self {
        Self::with_thread_store(WorkspaceThreadStore::new(
            workspace_root,
            crate::protocol::capability::default_desktop_capability_policy(),
        ))
    }

    pub(crate) fn with_thread_store(thread_store: WorkspaceThreadStore) -> Self {
        let subagent_manager = SubagentThreadManager::default();
        let mcp_runtime = McpRuntime::new();
        Self {
            native_agent_runtime: NativeAgentRuntimeServices::with_subagent_manager(
                subagent_manager.clone(),
            )
            .with_mcp_runtime(mcp_runtime.clone())
            .with_thread_store(thread_store.clone()),
            mcp_runtime,
            subagent_manager,
            thread_store,
            lifecycle_status: RuntimeLifecycleStatus::default(),
            logs: VecDeque::with_capacity(200),
            persistent_log_path: native_backend_log_path(),
            last_error: None,
            keep_background: false,
        }
    }

    pub(crate) fn native_agent_services(&self) -> NativeAgentRuntimeServices {
        self.native_agent_runtime
            .clone()
            .with_thread_store(self.thread_store.clone())
    }
}

pub(crate) fn lock_runtime(shared: &SharedGateway) -> std::sync::MutexGuard<'_, GatewayRuntime> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn push_log(shared: &SharedGateway, line: &str) {
    let log_path = {
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, line);
        runtime.persistent_log_path.clone()
    };
    let _ =
        append_native_backend_log_line(&log_path, NATIVE_BACKEND_LOG_MAX_BYTES, "runtime", line);
}

pub(crate) fn append_log(runtime: &mut GatewayRuntime, line: &str) {
    if runtime.logs.len() >= 200 {
        runtime.logs.pop_front();
    }
    runtime.logs.push_back(line.to_string());
}
