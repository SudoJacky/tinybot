use std::{path::PathBuf, time::Duration};

use crate::desktop::{
    state::{lock_runtime, push_log},
    SharedNativeRuntime,
};
use crate::runtime::lifecycle::RuntimeLifecycle;

pub(crate) fn start_native_runtime_with_workspace_root(
    shared: &SharedNativeRuntime,
    workspace_root: PathBuf,
) -> Result<(), String> {
    #[cfg(not(test))]
    let data_root = crate::config::application::tinybot_data_root();
    #[cfg(test)]
    let data_root = workspace_root.join(".tinybot");
    if let Err(error) =
        crate::threads::workspace_store::migrate_legacy_thread_storage(&workspace_root, &data_root)
    {
        let message = error.message;
        {
            let mut runtime = lock_runtime(shared);
            runtime.last_error = Some(message.clone());
        }
        push_log(shared, &message);
        return Err(message);
    }
    let (agent_task_runtime, shell_runtime, thread_store, startup_reconciled) = {
        let mut runtime = lock_runtime(shared);
        if runtime.thread_store.workspace_root() != workspace_root
            || runtime.thread_store.data_root() != data_root
        {
            let thread_store =
                crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
                    workspace_root.clone(),
                    data_root,
                    crate::protocol::capability::default_desktop_capability_policy(),
                );
            runtime.thread_store = thread_store.clone();
            runtime.native_agent_runtime = runtime
                .native_agent_runtime
                .clone()
                .with_thread_store(thread_store);
        }
        (
            runtime.native_agent_runtime.task_runtime(),
            runtime.native_agent_runtime.shell_runtime(),
            runtime.thread_store.clone(),
            runtime.lifecycle_status.startup_reconciled,
        )
    };
    if !startup_reconciled {
        agent_task_runtime.pause_accepting();
        match RuntimeLifecycle::reconcile_startup(&thread_store) {
            Ok(report) => {
                let report_line = serde_json::to_string(&report)
                    .expect("startup recovery report should serialize");
                {
                    let mut runtime = lock_runtime(shared);
                    runtime.last_error = None;
                    runtime.lifecycle_status.record_startup_recovery(report);
                }
                push_log(shared, &format!("runtime startup recovery {report_line}"));
            }
            Err(error) => {
                let message = format!("runtime startup recovery failed: {}", error.message);
                {
                    let mut runtime = lock_runtime(shared);
                    runtime.last_error = Some(message.clone());
                    runtime
                        .lifecycle_status
                        .record_startup_failure(message.clone());
                }
                push_log(shared, &message);
                return Err(message);
            }
        }
    }
    #[cfg(not(test))]
    crate::memory::start_workspace_runtime(
        workspace_root,
        thread_store.clone(),
        crate::config::application::native_runtime_config_snapshot(),
    );
    if let Err(error) = shell_runtime.resume_accepting() {
        let message = format!("runtime resume failed: {}", error.message);
        {
            let mut runtime = lock_runtime(shared);
            runtime.last_error = Some(message.clone());
            runtime
                .lifecycle_status
                .record_resume_failure(message.clone());
        }
        push_log(shared, &message);
        return Err(message);
    }
    agent_task_runtime.resume_accepting();
    push_log(shared, "Rust native backend active");
    Ok(())
}

pub(crate) fn native_backend_log_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .or_else(|| std::env::var_os("XDG_STATE_HOME"))
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join("tinybot").join("logs").join("native-backend.log")
}

pub(crate) fn shutdown_native_runtime(
    shared: &SharedNativeRuntime,
    explicit: bool,
) -> Result<(), String> {
    shutdown_native_runtime_with_timeout(shared, explicit, Duration::from_secs(5))
}

pub(crate) async fn shutdown_native_runtime_for_window_close(
    shared: SharedNativeRuntime,
    explicit: bool,
) -> Result<(), String> {
    shutdown_native_runtime_async_with_timeout(&shared, explicit, Duration::from_secs(5)).await
}

pub(crate) fn shutdown_native_runtime_with_timeout(
    shared: &SharedNativeRuntime,
    explicit: bool,
    timeout: Duration,
) -> Result<(), String> {
    tauri::async_runtime::block_on(shutdown_native_runtime_async_with_timeout(
        shared, explicit, timeout,
    ))
}

async fn shutdown_native_runtime_async_with_timeout(
    shared: &SharedNativeRuntime,
    explicit: bool,
    timeout: Duration,
) -> Result<(), String> {
    let lifecycle = {
        let runtime = lock_runtime(shared);
        RuntimeLifecycle::new(
            runtime.native_agent_runtime.task_runtime(),
            runtime.native_agent_runtime.shell_runtime(),
            runtime.mcp_runtime.clone(),
            runtime.subagent_manager.clone(),
            runtime.thread_store.clone(),
        )
    };
    let report = lifecycle.shutdown(timeout, !explicit).await;
    let report_line =
        serde_json::to_string(&report).expect("runtime shutdown report should serialize");
    let failures = report
        .failures
        .iter()
        .map(|failure| failure.message.clone())
        .collect::<Vec<_>>();
    {
        let mut runtime = lock_runtime(shared);
        runtime.last_error = failures.first().cloned();
        runtime.lifecycle_status.record_shutdown(report);
    }
    push_log(shared, &format!("runtime shutdown {report_line}"));
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
