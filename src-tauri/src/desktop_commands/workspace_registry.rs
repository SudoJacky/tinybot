use crate::desktop::{lock_runtime, SharedNativeRuntime};
use crate::threads::domain::ListThreadsRequest;
use crate::workspace_registry::{WorkspaceRegistryEntry, WorkspaceRegistrySnapshot};
use serde::Deserialize;
use tauri::State;

const LEGACY_THREAD_PAGE_SIZE: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterWorkspaceInput {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RenameWorkspaceInput {
    path: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ForgetWorkspaceInput {
    path: String,
}

#[tauri::command]
pub(crate) fn worker_workspace_registry_list(
    state: State<'_, SharedNativeRuntime>,
) -> Result<WorkspaceRegistrySnapshot, String> {
    let thread_store = { lock_runtime(state.inner()).thread_store.clone() };
    let registry = thread_store.workspace_registry();
    if registry.requires_legacy_import()? {
        let mut legacy_paths = thread_store
            .project_groups()
            .snapshot()?
            .groups
            .into_iter()
            .flat_map(|group| group.workspace_ids)
            .collect::<Vec<_>>();
        let operation = thread_store.begin_operation().map_err(|error| {
            format!(
                "failed to load legacy workspaces from Threads: {}",
                error.message
            )
        })?;
        let mut offset = 0;
        loop {
            let page = operation
                .thread()
                .list_threads(ListThreadsRequest {
                    include_archived: true,
                    include_child_threads: true,
                    parent_thread_id: None,
                    ancestor_thread_id: None,
                    offset: Some(offset),
                    limit: Some(LEGACY_THREAD_PAGE_SIZE),
                })
                .map_err(|error| {
                    format!("failed to list legacy workspace Threads: {}", error.message)
                })?;
            legacy_paths.extend(page.threads.into_iter().filter_map(|thread| {
                if thread.metadata.extra.get("pluginMigration").is_some() {
                    None
                } else {
                    thread.metadata.working_directory
                }
            }));
            let Some(next_offset) = page.next_offset else {
                break;
            };
            offset = next_offset;
        }
        registry.import_legacy(legacy_paths)?;
    }
    registry.snapshot()
}

#[tauri::command]
pub(crate) fn worker_workspace_register(
    input: RegisterWorkspaceInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<WorkspaceRegistryEntry, String> {
    let registry = {
        lock_runtime(state.inner())
            .thread_store
            .workspace_registry()
    };
    let registered = registry.register(&input.path)?;
    eprintln!("workspace_registered path={}", registered.path);
    Ok(registered)
}

#[tauri::command]
pub(crate) fn worker_workspace_rename(
    input: RenameWorkspaceInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<WorkspaceRegistryEntry, String> {
    let registry = {
        lock_runtime(state.inner())
            .thread_store
            .workspace_registry()
    };
    let renamed = registry.rename(&input.path, input.name)?;
    eprintln!("workspace_renamed path={}", renamed.path);
    Ok(renamed)
}

#[tauri::command]
pub(crate) fn worker_workspace_forget(
    input: ForgetWorkspaceInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<WorkspaceRegistryEntry, String> {
    let thread_store = { lock_runtime(state.inner()).thread_store.clone() };
    let forgotten = thread_store
        .project_groups()
        .forget_workspace(&input.path)?;
    eprintln!("workspace_forgotten path={}", forgotten.path);
    Ok(forgotten)
}
