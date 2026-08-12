use crate::desktop::{lock_runtime, SharedNativeRuntime};
use crate::project_groups::{ProjectGroup, ProjectGroupSnapshot, SaveProjectGroupInput};
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteProjectGroupInput {
    project_group_id: String,
}

#[tauri::command]
pub(crate) fn worker_project_groups_list(
    state: State<'_, SharedNativeRuntime>,
) -> Result<ProjectGroupSnapshot, String> {
    let store = { lock_runtime(state.inner()).thread_store.project_groups() };
    store.snapshot()
}

#[tauri::command]
pub(crate) fn worker_project_group_save(
    input: SaveProjectGroupInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<ProjectGroup, String> {
    let store = { lock_runtime(state.inner()).thread_store.project_groups() };
    store.save(input)
}

#[tauri::command]
pub(crate) fn worker_project_group_delete(
    input: DeleteProjectGroupInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<ProjectGroup, String> {
    let store = { lock_runtime(state.inner()).thread_store.project_groups() };
    store.delete(&input.project_group_id)
}
