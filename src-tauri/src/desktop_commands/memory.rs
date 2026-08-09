use crate::config::application::native_backend_workspace_root;
use crate::memory::{normalized_workspace_path, MemoryRecord, MemoryScope, MemoryStore};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerMemorySnapshot {
    current_workspace_path: String,
    user_memories: Vec<String>,
    workspaces: Vec<WorkerWorkspaceMemory>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWorkspaceMemory {
    path: String,
    current: bool,
    memories: Vec<String>,
}

#[tauri::command]
pub(crate) fn worker_memory_snapshot() -> Result<WorkerMemorySnapshot, String> {
    let workspace_root = native_backend_workspace_root();
    let current_workspace_path = normalized_workspace_path(&workspace_root)?;
    let memories = MemoryStore::for_workspace(&workspace_root).active_memories()?;
    Ok(build_memory_snapshot(current_workspace_path, memories))
}

fn build_memory_snapshot(
    current_workspace_path: String,
    memories: Vec<MemoryRecord>,
) -> WorkerMemorySnapshot {
    let mut user_memories = Vec::new();
    let mut workspace_memories = BTreeMap::<String, Vec<String>>::new();
    for memory in memories {
        match memory.scope {
            MemoryScope::User => user_memories.push(memory.content),
            MemoryScope::Workspace => {
                if let Some(path) = memory.path {
                    workspace_memories
                        .entry(path)
                        .or_default()
                        .push(memory.content);
                }
            }
        }
    }
    workspace_memories
        .entry(current_workspace_path.clone())
        .or_default();
    let workspaces = workspace_memories
        .into_iter()
        .map(|(path, memories)| WorkerWorkspaceMemory {
            current: path == current_workspace_path,
            path,
            memories,
        })
        .collect();
    WorkerMemorySnapshot {
        current_workspace_path,
        user_memories,
        workspaces,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_active_memories_by_scope_and_marks_the_current_workspace() {
        let snapshot = build_memory_snapshot(
            "D:\\Code\\tinybot".to_string(),
            vec![
                MemoryRecord {
                    id: 1,
                    scope: MemoryScope::User,
                    path: None,
                    content: "User prefers concise answers.".to_string(),
                },
                MemoryRecord {
                    id: 2,
                    scope: MemoryScope::Workspace,
                    path: Some("D:\\Code\\other".to_string()),
                    content: "This workspace uses pnpm.".to_string(),
                },
                MemoryRecord {
                    id: 3,
                    scope: MemoryScope::Workspace,
                    path: Some("D:\\Code\\tinybot".to_string()),
                    content: "This workspace uses Rust.".to_string(),
                },
            ],
        );

        assert_eq!(
            snapshot.user_memories,
            vec!["User prefers concise answers."]
        );
        assert_eq!(snapshot.workspaces.len(), 2);
        assert!(!snapshot.workspaces[0].current);
        assert!(snapshot.workspaces[1].current);
        assert_eq!(
            snapshot.workspaces[1].memories,
            vec!["This workspace uses Rust."]
        );
    }

    #[test]
    fn includes_the_current_workspace_when_it_has_no_active_memory() {
        let snapshot = build_memory_snapshot(
            "D:\\Code\\tinybot".to_string(),
            vec![MemoryRecord {
                id: 1,
                scope: MemoryScope::User,
                path: None,
                content: "User prefers concise answers.".to_string(),
            }],
        );

        assert_eq!(snapshot.workspaces.len(), 1);
        assert!(snapshot.workspaces[0].current);
        assert!(snapshot.workspaces[0].memories.is_empty());
    }
}
