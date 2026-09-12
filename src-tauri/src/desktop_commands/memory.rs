use crate::desktop::state::{lock_runtime, SharedNativeRuntime};
use crate::memory::{
    normalized_workspace_path, MemoryManagementSnapshot, MemoryMutation, MemoryStore,
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerMemorySnapshot {
    current_workspace_path: String,
    #[serde(flatten)]
    memory: MemoryManagementSnapshot,
}

fn memory_store(state: &SharedNativeRuntime) -> Result<(String, MemoryStore), String> {
    let runtime = lock_runtime(state);
    let workspace = normalized_workspace_path(runtime.thread_store.workspace_root())?;
    Ok((
        workspace,
        MemoryStore::new(runtime.thread_store.data_root()),
    ))
}

#[tauri::command]
pub(crate) fn worker_memory_snapshot(
    state: tauri::State<'_, SharedNativeRuntime>,
) -> Result<WorkerMemorySnapshot, String> {
    let (current_workspace_path, store) = memory_store(state.inner())?;
    Ok(WorkerMemorySnapshot {
        current_workspace_path,
        memory: store.management_snapshot()?,
    })
}

#[tauri::command]
pub(crate) fn worker_memory_mutate(
    state: tauri::State<'_, SharedNativeRuntime>,
    expected_revision: i64,
    mutation: MemoryMutation,
) -> Result<WorkerMemorySnapshot, String> {
    let (current_workspace_path, store) = memory_store(state.inner())?;
    let operation = match &mutation {
        MemoryMutation::Create { .. } => "create",
        MemoryMutation::Update { .. } => "update",
        MemoryMutation::Delete { .. } => "delete",
    };
    let memory = store.mutate_memory(expected_revision, &mutation).map_err(|error| {
        eprintln!("[memory-management] operation={operation} expected_revision={expected_revision} failed: {error}");
        error
    })?;
    eprintln!(
        "[memory-management] operation={operation} committed_revision={}",
        memory.revision
    );
    store.write_latest_markdown().map_err(|error| {
        eprintln!("[memory-management] Markdown refresh failed after commit: {error}");
        format!("Memory was saved, but its Markdown view could not be refreshed: {error}. Reload memory to see the saved state.")
    })?;
    Ok(WorkerMemorySnapshot {
        current_workspace_path,
        memory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MemoryEntry, MemoryRecord, MemoryScope};
    use serde_json::json;

    #[test]
    fn management_wire_contract_uses_stable_ids_and_camel_case_metadata() {
        let snapshot = WorkerMemorySnapshot {
            current_workspace_path: "/workspace".to_string(),
            memory: MemoryManagementSnapshot {
                revision: 7,
                entries: vec![MemoryEntry {
                    record: MemoryRecord {
                        id: 3,
                        scope: MemoryScope::User,
                        path: None,
                        content: "Concise answers.".to_string(),
                    },
                    user_managed: true,
                }],
            },
        };
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            json!({
                "currentWorkspacePath": "/workspace", "revision": 7,
                "entries": [{ "id": 3, "scope": "user", "path": null, "content": "Concise answers.", "userManaged": true }]
            })
        );
        assert!(matches!(serde_json::from_value::<MemoryMutation>(json!({
            "operation": "delete", "ids": [3]
        })).unwrap(), MemoryMutation::Delete { ids } if ids == vec![3]));
    }
}
