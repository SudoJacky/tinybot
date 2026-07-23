use super::domain::WorkerThreadRpc;
use super::rollout::store::WorkerThreadLogRpc;
use crate::protocol::capability::CapabilityPolicy;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceThreadStore {
    inner: Arc<WorkspaceThreadStoreInner>,
}

#[derive(Debug)]
struct WorkspaceThreadStoreInner {
    workspace_root: PathBuf,
    thread: WorkerThreadRpc,
    thread_log: WorkerThreadLogRpc,
    lifecycle: Mutex<WorkspaceThreadStoreLifecycle>,
}

#[derive(Debug)]
struct WorkspaceThreadStoreLifecycle {
    accepting: bool,
    projection_loaded: bool,
}

pub(crate) struct WorkspaceThreadOperation<'a> {
    inner: &'a WorkspaceThreadStoreInner,
    lifecycle: MutexGuard<'a, WorkspaceThreadStoreLifecycle>,
}

impl WorkspaceThreadStore {
    pub(crate) fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self {
            inner: Arc::new(WorkspaceThreadStoreInner {
                thread: WorkerThreadRpc::new(workspace_root.clone(), policy.clone()),
                thread_log: WorkerThreadLogRpc::new(workspace_root.clone(), policy),
                workspace_root,
                lifecycle: Mutex::new(WorkspaceThreadStoreLifecycle {
                    accepting: true,
                    projection_loaded: false,
                }),
            }),
        }
    }

    pub(crate) fn workspace_root(&self) -> &Path {
        &self.inner.workspace_root
    }

    pub(crate) fn begin_operation(
        &self,
    ) -> Result<WorkspaceThreadOperation<'_>, WorkerProtocolError> {
        let mut lifecycle = self.lock_lifecycle()?;
        if !lifecycle.accepting {
            return Err(thread_store_lifecycle_error(
                "workspace thread store is shut down",
                self.workspace_root(),
            ));
        }
        if !lifecycle.projection_loaded {
            let (threads, items) = self.inner.thread_log.thread_projection()?;
            self.inner.thread.replace_projection(threads, items)?;
            lifecycle.projection_loaded = true;
        }
        Ok(WorkspaceThreadOperation {
            inner: &self.inner,
            lifecycle,
        })
    }

    pub(crate) fn flush(&self) -> Result<(), WorkerProtocolError> {
        let _lifecycle = self.lock_lifecycle()?;
        self.inner.thread_log.flush_all()
    }

    pub(crate) fn shutdown(&self) -> Result<(), WorkerProtocolError> {
        let mut lifecycle = self.lock_lifecycle()?;
        if !lifecycle.accepting {
            return self.inner.thread_log.shutdown_all();
        }
        lifecycle.accepting = false;
        self.inner.thread_log.shutdown_all()
    }

    fn lock_lifecycle(
        &self,
    ) -> Result<MutexGuard<'_, WorkspaceThreadStoreLifecycle>, WorkerProtocolError> {
        self.inner.lifecycle.lock().map_err(|_| {
            thread_store_lifecycle_error(
                "workspace thread store lifecycle lock is poisoned",
                self.workspace_root(),
            )
        })
    }
}

impl WorkspaceThreadOperation<'_> {
    pub(crate) fn thread(&self) -> &WorkerThreadRpc {
        &self.inner.thread
    }

    pub(crate) fn thread_log(&self) -> &WorkerThreadLogRpc {
        &self.inner.thread_log
    }

    pub(crate) fn reload_projection(&mut self) -> Result<(), WorkerProtocolError> {
        self.lifecycle.projection_loaded = false;
        self.inner.thread_log.invalidate_state_index();
        let (threads, items) = self.inner.thread_log.thread_projection()?;
        self.inner.thread.replace_projection(threads, items)?;
        self.lifecycle.projection_loaded = true;
        Ok(())
    }

    pub(crate) fn sync_thread_projection(
        &self,
        thread_id: &str,
    ) -> Result<(), WorkerProtocolError> {
        let (thread, items) = self.inner.thread_log.thread_projection_for(thread_id)?;
        self.inner.thread.replace_thread_projection(thread, items)
    }
}

fn thread_store_lifecycle_error(message: &str, workspace_root: &Path) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        serde_json::json!({
            "workspaceRoot": workspace_root.display().to_string(),
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
#[path = "workspace_store_tests.rs"]
mod tests;
