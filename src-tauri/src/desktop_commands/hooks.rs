use crate::command_hooks::{
    archive_managed_hook, load_catalog_snapshot, save_managed_hook, set_hook_trusted,
    test_managed_hook, CommandHookCatalogSnapshot, ManagedHookDraft, ManagedHookTestResult,
};
use crate::config::application::{native_backend_workspace_root, tinybot_data_root};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerHooksSnapshotInput {
    #[serde(default)]
    workspace_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerHookTrustInput {
    #[serde(default)]
    workspace_path: Option<String>,
    hash: String,
    trusted: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerManagedHookSaveInput {
    workspace_path: String,
    #[serde(flatten)]
    hook: ManagedHookDraft,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerManagedHookIdInput {
    workspace_path: String,
    id: String,
}

#[tauri::command]
pub(crate) fn worker_hooks_snapshot(
    input: WorkerHooksSnapshotInput,
) -> Result<CommandHookCatalogSnapshot, String> {
    let workspace_root = resolve_workspace_root(input.workspace_path.as_deref())?;
    load_catalog_snapshot(&tinybot_data_root(), &workspace_root)
}

#[tauri::command]
pub(crate) fn worker_hook_set_trusted(
    input: WorkerHookTrustInput,
) -> Result<CommandHookCatalogSnapshot, String> {
    let workspace_root = resolve_workspace_root(input.workspace_path.as_deref())?;
    let hash = input.hash.trim();
    if hash.is_empty() {
        return Err("hook hash must not be empty".to_string());
    }
    let data_root = tinybot_data_root();
    set_hook_trusted(&data_root, &workspace_root, hash, input.trusted)?;
    load_catalog_snapshot(&data_root, &workspace_root)
}

#[tauri::command]
pub(crate) fn worker_managed_hook_save(
    input: WorkerManagedHookSaveInput,
) -> Result<CommandHookCatalogSnapshot, String> {
    let workspace_root = resolve_workspace_root(Some(&input.workspace_path))?;
    save_managed_hook(&workspace_root, input.hook)?;
    load_catalog_snapshot(&tinybot_data_root(), &workspace_root)
}

#[tauri::command]
pub(crate) async fn worker_managed_hook_test(
    input: WorkerManagedHookIdInput,
) -> Result<ManagedHookTestResult, String> {
    let workspace_root = resolve_workspace_root(Some(&input.workspace_path))?;
    test_managed_hook(&tinybot_data_root(), &workspace_root, input.id.trim()).await
}

#[tauri::command]
pub(crate) fn worker_managed_hook_archive(
    input: WorkerManagedHookIdInput,
) -> Result<CommandHookCatalogSnapshot, String> {
    let workspace_root = resolve_workspace_root(Some(&input.workspace_path))?;
    archive_managed_hook(&workspace_root, input.id.trim())?;
    load_catalog_snapshot(&tinybot_data_root(), &workspace_root)
}

fn resolve_workspace_root(workspace_path: Option<&str>) -> Result<PathBuf, String> {
    let Some(workspace_path) = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return canonical_directory(&native_backend_workspace_root());
    };
    canonical_directory(Path::new(workspace_path))
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "failed to resolve workspace directory `{}`: {error}",
            path.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "hook workspace path is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}
