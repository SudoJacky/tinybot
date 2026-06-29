use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_storage::{
    read_json_store, write_json_pretty_atomic, AtomicWriteOptions, WorkerStorageError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct WorkerTaskRpc {
    root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerTaskRpc {
    pub fn new(root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self { root, policy }
    }

    pub fn load_store(&self) -> Result<TaskStoreResult, WorkerProtocolError> {
        self.require(WorkerCapability::TaskRead)?;
        Ok(self.read_store()?)
    }

    pub fn list_plans(
        &self,
        params: TaskPlanListParams,
    ) -> Result<TaskPlanListResult, WorkerProtocolError> {
        self.require(WorkerCapability::TaskRead)?;
        let mut plans = self.read_store()?.plans;
        if !params.include_completed.unwrap_or(false) {
            plans.retain(|plan| plan.get("status").and_then(Value::as_str) != Some("completed"));
        }
        Ok(TaskPlanListResult { plans })
    }

    pub fn get_plan(
        &self,
        params: TaskPlanIdParams,
    ) -> Result<TaskPlanGetResult, WorkerProtocolError> {
        self.require(WorkerCapability::TaskRead)?;
        let store = self.read_store()?;
        Ok(TaskPlanGetResult {
            plan: store.plans.into_iter().find(|plan| {
                plan.get("id").and_then(Value::as_str) == Some(params.plan_id.as_str())
            }),
        })
    }

    pub fn save_plan(
        &self,
        params: TaskPlanSaveParams,
    ) -> Result<TaskPlanSaveResult, WorkerProtocolError> {
        self.require(WorkerCapability::TaskWrite)?;
        validate_plan(&params.plan)?;
        let plan_id = params
            .plan
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut store = self.read_store()?;
        match store
            .plans
            .iter()
            .position(|plan| plan.get("id").and_then(Value::as_str) == Some(plan_id.as_str()))
        {
            Some(index) => store.plans[index] = params.plan.clone(),
            None => store.plans.push(params.plan.clone()),
        }
        self.write_store(&store)?;
        Ok(TaskPlanSaveResult { plan: params.plan })
    }

    pub fn delete_plan(
        &self,
        params: TaskPlanIdParams,
    ) -> Result<TaskPlanDeleteResult, WorkerProtocolError> {
        self.require(WorkerCapability::TaskWrite)?;
        let mut store = self.read_store()?;
        let before = store.plans.len();
        store
            .plans
            .retain(|plan| plan.get("id").and_then(Value::as_str) != Some(params.plan_id.as_str()));
        let deleted = store.plans.len() < before;
        if deleted {
            self.write_store(&store)?;
        }
        Ok(TaskPlanDeleteResult { deleted })
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }

    fn store_path(&self) -> PathBuf {
        self.root.join("plans").join("store.json")
    }

    fn read_store(&self) -> Result<TaskStoreResult, WorkerProtocolError> {
        read_json_store(&self.store_path()).map_err(task_storage_error)
    }

    fn write_store(&self, store: &TaskStoreResult) -> Result<(), WorkerProtocolError> {
        write_json_pretty_atomic(&self.store_path(), store, AtomicWriteOptions::default())
            .map_err(task_storage_error)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct TaskPlanIdParams {
    pub plan_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TaskPlanListParams {
    pub include_completed: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TaskPlanSaveParams {
    pub plan: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TaskStoreResult {
    pub version: usize,
    pub plans: Vec<Value>,
}

impl Default for TaskStoreResult {
    fn default() -> Self {
        Self {
            version: 1,
            plans: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskPlanListResult {
    pub plans: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskPlanGetResult {
    pub plan: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskPlanSaveResult {
    pub plan: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskPlanDeleteResult {
    pub deleted: bool,
}

fn validate_plan(plan: &Value) -> Result<(), WorkerProtocolError> {
    let Some(plan) = plan.as_object() else {
        return Err(invalid_task_request("plan must be an object"));
    };
    let id = plan.get("id").and_then(Value::as_str).unwrap_or_default();
    if id.trim().is_empty() {
        return Err(invalid_task_request("plan.id is required"));
    }
    let title = plan
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if title.trim().is_empty() {
        return Err(invalid_task_request("plan.title is required"));
    }
    if !plan.get("subtasks").is_some_and(Value::is_array) {
        return Err(invalid_task_request("plan.subtasks must be an array"));
    }
    Ok(())
}

fn invalid_task_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "task" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn task_storage_error(error: WorkerStorageError) -> WorkerProtocolError {
    let code = if error.is_parse_error() {
        WorkerProtocolErrorCode::InvalidProtocol
    } else {
        WorkerProtocolErrorCode::WorkerError
    };
    WorkerProtocolError::new(
        code,
        format!("task store error: {error}"),
        serde_json::json!({ "method": "task" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn load_store_reads_existing_task_store_fixture() {
        let root = temp_workspace_root("existing-task-store");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        let store_path = root.join("plans").join("store.json");
        std::fs::create_dir_all(store_path.parent().unwrap()).unwrap();
        std::fs::write(
            &store_path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "plans": [
                    {
                        "id": "plan-existing",
                        "title": "Existing migration plan",
                        "status": "active",
                        "subtasks": [
                            { "id": "step-1", "title": "Keep fixture readable", "status": "pending" }
                        ],
                        "metadata": { "source": "pre-storage-refactor" }
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let rpc = WorkerTaskRpc::new(root, CapabilityPolicy::new([WorkerCapability::TaskRead]));

        let store = rpc.load_store().expect("existing task store should load");

        assert_eq!(store.version, 1);
        assert_eq!(store.plans.len(), 1);
        assert_eq!(store.plans[0]["id"], "plan-existing");
        assert_eq!(store.plans[0]["metadata"]["source"], "pre-storage-refactor");
    }

    fn temp_workspace_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-task-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    struct TempWorkspaceCleanup(PathBuf);

    impl Drop for TempWorkspaceCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
