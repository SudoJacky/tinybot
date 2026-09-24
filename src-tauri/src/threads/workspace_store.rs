use super::domain::{UpdateGeneratedThreadTitleResult, WorkerThreadRpc};
use super::rollout::store::WorkerThreadLogRpc;
use crate::project_groups::ProjectGroupStore;
use crate::protocol::capability::CapabilityPolicy;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::workspace_registry::WorkspaceRegistry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub(crate) use super::storage_migration::migrate_legacy_thread_storage;

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceThreadStore {
    inner: Arc<WorkspaceThreadStoreInner>,
}

#[derive(Debug)]
struct WorkspaceThreadStoreInner {
    workspace_root: PathBuf,
    data_root: PathBuf,
    thread: WorkerThreadRpc,
    thread_log: WorkerThreadLogRpc,
    project_groups: ProjectGroupStore,
    workspace_registry: WorkspaceRegistry,
    lifecycle: Mutex<WorkspaceThreadStoreLifecycle>,
    policy: CapabilityPolicy,
    team_scope: Option<String>,
    team_stores: Mutex<HashMap<String, WorkspaceThreadStore>>,
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
    #[cfg(test)]
    pub(crate) fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        let data_root = workspace_root.join(".tinybot");
        Self::new_with_data_root(workspace_root, data_root, policy)
    }

    pub(crate) fn new_with_data_root(
        workspace_root: PathBuf,
        data_root: PathBuf,
        policy: CapabilityPolicy,
    ) -> Self {
        Self::with_storage_root(workspace_root, data_root.clone(), data_root, policy, None)
    }

    fn with_storage_root(
        workspace_root: PathBuf,
        data_root: PathBuf,
        storage_root: PathBuf,
        policy: CapabilityPolicy,
        team_scope: Option<String>,
    ) -> Self {
        let workspace_registry = WorkspaceRegistry::new(&data_root);
        Self {
            inner: Arc::new(WorkspaceThreadStoreInner {
                project_groups: ProjectGroupStore::with_workspace_registry(
                    &data_root,
                    workspace_registry.clone(),
                ),
                workspace_registry,
                thread: WorkerThreadRpc::new(workspace_root.clone(), policy.clone()),
                thread_log: WorkerThreadLogRpc::new_with_storage_root(
                    workspace_root.clone(),
                    data_root.clone(),
                    storage_root,
                    policy.clone(),
                ),
                policy,
                team_scope,
                team_stores: Mutex::new(HashMap::new()),
                workspace_root,
                data_root,
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

    pub(crate) fn data_root(&self) -> &Path {
        &self.inner.data_root
    }

    /// Separate persistence, indexes and lifecycle; application configuration stays shared.
    pub(crate) fn for_team(&self, run_id: &str) -> Result<Self, String> {
        crate::teams::validate_run_id(run_id)?;
        if self.inner.team_scope.as_deref() == Some(run_id) {
            return Ok(self.clone());
        }
        if self.inner.team_scope.is_some() {
            return Err("Cannot switch Team conversation scope from a worker store".into());
        }
        let lifecycle = self.lock_lifecycle().map_err(|e| e.message)?;
        if !lifecycle.accepting {
            return Err("Thread store is shut down".into());
        }
        let mut stores = self
            .inner
            .team_stores
            .lock()
            .map_err(|_| "Team conversation registry poisoned")?;
        Ok(stores
            .entry(run_id.into())
            .or_insert_with(|| {
                Self::with_storage_root(
                    self.inner.workspace_root.clone(),
                    self.inner.data_root.clone(),
                    self.inner
                        .data_root
                        .join("team-runs")
                        .join(run_id)
                        .join("conversations"),
                    self.inner.policy.clone(),
                    Some(run_id.into()),
                )
            })
            .clone())
    }

    pub(crate) fn is_team_scope(&self) -> bool {
        self.inner.team_scope.is_some()
    }

    pub(crate) fn project_groups(&self) -> ProjectGroupStore {
        self.inner.project_groups.clone()
    }

    pub(crate) fn workspace_registry(&self) -> WorkspaceRegistry {
        self.inner.workspace_registry.clone()
    }

    pub(crate) fn begin_operation(
        &self,
    ) -> Result<WorkspaceThreadOperation<'_>, WorkerProtocolError> {
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        let mut lifecycle = metrics.measure("storage.operation.lockWait.durationMs", || {
            self.lock_lifecycle()
        })?;
        if !lifecycle.accepting {
            return Err(thread_store_lifecycle_error(
                "workspace thread store is shut down",
                self.workspace_root(),
            ));
        }
        if !lifecycle.projection_loaded {
            let (threads, items) = self.inner.thread_log.thread_projection()?;
            metrics.measure("storage.projection.install.durationMs", || {
                self.inner.thread.replace_projection(threads, items)
            })?;
            lifecycle.projection_loaded = true;
        }
        Ok(WorkspaceThreadOperation {
            inner: &self.inner,
            lifecycle,
        })
    }

    pub(crate) fn flush(&self) -> Result<(), WorkerProtocolError> {
        let _lifecycle = self.lock_lifecycle()?;
        for store in self
            .inner
            .team_stores
            .lock()
            .map_err(|_| {
                thread_store_lifecycle_error(
                    "Team conversation registry poisoned",
                    self.workspace_root(),
                )
            })?
            .values()
        {
            store.flush()?;
        }
        self.inner.thread_log.flush_all()
    }

    pub(crate) fn update_generated_thread_title(
        &self,
        thread_id: &str,
        source_turn_id: &str,
        title: String,
    ) -> Result<UpdateGeneratedThreadTitleResult, WorkerProtocolError> {
        let mut operation = self.begin_operation()?;
        let result: Result<UpdateGeneratedThreadTitleResult, WorkerProtocolError> = (|| {
            let result = operation.thread().update_generated_thread_title(
                thread_id,
                source_turn_id,
                title,
            )?;
            if let Some(thread) = result.thread.as_ref() {
                operation.thread_log().create_from_thread_record(thread)?;
            }
            Ok(result)
        })();
        if let Err(error) = &result {
            if let Err(reload_error) = operation.reload_projection() {
                eprintln!(
                    "generated_thread_title_projection_reload_failed thread_id={} operation_error={} reload_error={}",
                    thread_id, error.message, reload_error.message
                );
                return Err(reload_error);
            }
        }
        result
    }

    pub(crate) fn shutdown(&self) -> Result<(), WorkerProtocolError> {
        let mut lifecycle = self.lock_lifecycle()?;
        if !lifecycle.accepting {
            return self.inner.thread_log.shutdown_all();
        }
        lifecycle.accepting = false;
        for store in self
            .inner
            .team_stores
            .lock()
            .map_err(|_| {
                thread_store_lifecycle_error(
                    "Team conversation registry poisoned",
                    self.workspace_root(),
                )
            })?
            .values()
        {
            store.shutdown()?;
        }
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
