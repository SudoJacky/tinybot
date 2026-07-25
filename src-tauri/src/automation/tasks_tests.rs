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
