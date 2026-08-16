use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::collaboration::subagents::SubagentThreadManager;
use crate::runtime::lifecycle::RuntimeLifecycleStatus;
use crate::runtime::mcp::McpRuntime;
use crate::threads::workspace_store::WorkspaceThreadStore;
use serde_json::json;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use super::logging::{
    append_native_backend_log_event, native_backend_log_event_line, native_backend_log_event_value,
    native_backend_log_path, NativeLogEvent, NativeLogLevel, NATIVE_BACKEND_LOG_MAX_BYTES,
};

const RECENT_NATIVE_LOG_EVENT_LIMIT: usize = 200;

pub(crate) type SharedNativeRuntime = Arc<Mutex<NativeRuntimeState>>;

pub(crate) struct NativeRuntimeState {
    pub(crate) native_agent_runtime: NativeAgentRuntimeServices,
    pub(crate) mcp_runtime: McpRuntime,
    pub(crate) subagent_manager: SubagentThreadManager,
    pub(crate) thread_store: WorkspaceThreadStore,
    pub(crate) lifecycle_status: RuntimeLifecycleStatus,
    pub(crate) logs: VecDeque<String>,
    pub(crate) recent_log_events: VecDeque<serde_json::Value>,
    pub(crate) persistent_log_path: PathBuf,
    pub(crate) last_error: Option<String>,
}

impl Default for NativeRuntimeState {
    fn default() -> Self {
        #[cfg(test)]
        {
            let workspace_root = crate::config::application::native_backend_workspace_root();
            Self::with_thread_store(WorkspaceThreadStore::new(
                workspace_root,
                crate::protocol::capability::default_desktop_capability_policy(),
            ))
        }
        #[cfg(not(test))]
        {
            let workspace_root = crate::config::application::native_backend_workspace_root();
            let data_root = crate::config::application::tinybot_data_root();
            let migration_error = crate::threads::workspace_store::migrate_legacy_thread_storage(
                &workspace_root,
                &data_root,
            )
            .err()
            .map(|error| error.message);
            let mut state = Self::new_with_data_root(workspace_root, data_root);
            state.last_error = migration_error;
            state
        }
    }
}

impl NativeRuntimeState {
    #[cfg(not(test))]
    pub(crate) fn new_with_data_root(workspace_root: PathBuf, data_root: PathBuf) -> Self {
        Self::with_thread_store(WorkspaceThreadStore::new_with_data_root(
            workspace_root,
            data_root,
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
            recent_log_events: VecDeque::with_capacity(RECENT_NATIVE_LOG_EVENT_LIMIT),
            persistent_log_path: native_backend_log_path(),
            last_error: None,
        }
    }

    pub(crate) fn native_agent_services(&self) -> NativeAgentRuntimeServices {
        self.native_agent_runtime
            .clone()
            .with_thread_store(self.thread_store.clone())
    }
}

pub(crate) fn lock_runtime(
    shared: &SharedNativeRuntime,
) -> std::sync::MutexGuard<'_, NativeRuntimeState> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn push_log(shared: &SharedNativeRuntime, line: &str) {
    if let Err(error) = record_native_log_with_memory_line(
        shared,
        "runtime",
        NativeLogEvent::new(
            NativeLogLevel::Info,
            "runtime.message",
            json!({ "message": line }),
        ),
        Some(line),
    ) {
        eprintln!("native runtime log write failed: {error}; message={line}");
    }
}

pub(crate) fn record_native_log(
    shared: &SharedNativeRuntime,
    stream: &str,
    event: NativeLogEvent,
) -> Result<(), String> {
    record_native_log_with_memory_line(shared, stream, event, None)
}

fn record_native_log_with_memory_line(
    shared: &SharedNativeRuntime,
    stream: &str,
    event: NativeLogEvent,
    memory_line: Option<&str>,
) -> Result<(), String> {
    let line = native_backend_log_event_line(&event)?;
    let recent_event = native_backend_log_event_value(stream, &event)?;
    let log_path = {
        let mut runtime = lock_runtime(shared);
        let in_memory_line = memory_line
            .map(str::to_string)
            .unwrap_or_else(|| format!("{stream} {line}"));
        append_log(&mut runtime, &in_memory_line);
        append_recent_log_event(&mut runtime, recent_event);
        runtime.persistent_log_path.clone()
    };
    append_native_backend_log_event(&log_path, NATIVE_BACKEND_LOG_MAX_BYTES, stream, event)
}

pub(crate) fn append_log(runtime: &mut NativeRuntimeState, line: &str) {
    if runtime.logs.len() >= 200 {
        runtime.logs.pop_front();
    }
    runtime.logs.push_back(line.to_string());
}

fn append_recent_log_event(runtime: &mut NativeRuntimeState, event: serde_json::Value) {
    if runtime.recent_log_events.len() >= RECENT_NATIVE_LOG_EVENT_LIMIT {
        runtime.recent_log_events.pop_front();
    }
    runtime.recent_log_events.push_back(event);
}
