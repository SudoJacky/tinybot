use crate::{
    config::application::{native_backend_workspace_root, native_runtime_config_snapshot},
    desktop::{lock_runtime, SharedNativeRuntime},
    plugins::PluginStore,
};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerPluginInstallInput {
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerPluginEnableInput {
    name: String,
    enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerPluginNameInput {
    name: String,
}

#[tauri::command]
pub(crate) fn worker_plugins_list() -> Result<serde_json::Value, String> {
    let plugins = PluginStore::default_global().list()?;
    serde_json::to_value(serde_json::json!({ "plugins": plugins }))
        .map_err(|error| format!("failed to serialize installed plugins: {error}"))
}

#[tauri::command]
pub(crate) fn worker_plugin_install(
    input: WorkerPluginInstallInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    let source = PathBuf::from(input.path.trim());
    if input.path.trim().is_empty() {
        return Err("plugin directory path must not be empty".to_string());
    }
    let plugin = PluginStore::default_global().install_from_directory(&source)?;
    reconcile_plugin_mcp_runtime(state.inner())?;
    serde_json::to_value(plugin)
        .map_err(|error| format!("failed to serialize installed plugin: {error}"))
}

#[tauri::command]
pub(crate) fn worker_plugin_set_enabled(
    input: WorkerPluginEnableInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    let plugin = PluginStore::default_global().set_enabled(input.name.trim(), input.enabled)?;
    reconcile_plugin_mcp_runtime(state.inner())?;
    serde_json::to_value(plugin)
        .map_err(|error| format!("failed to serialize installed plugin: {error}"))
}

#[tauri::command]
pub(crate) fn worker_plugin_uninstall(
    input: WorkerPluginNameInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<(), String> {
    let name = input.name.trim();
    let store = PluginStore::default_global();
    let plugin = store
        .list()?
        .into_iter()
        .find(|plugin| plugin.name == name)
        .ok_or_else(|| format!("plugin `{name}` is not installed"))?;
    if plugin.enabled {
        store.set_enabled(name, false)?;
        reconcile_plugin_mcp_runtime(state.inner()).map_err(|error| {
            format!("plugin `{name}` was disabled but could not be stopped before removal: {error}")
        })?;
    }
    store.uninstall(name).map_err(|error| {
        if plugin.enabled {
            format!("plugin `{name}` was disabled but could not be removed: {error}")
        } else {
            error
        }
    })?;
    reconcile_plugin_mcp_runtime(state.inner())
}

fn reconcile_plugin_mcp_runtime(shared: &SharedNativeRuntime) -> Result<(), String> {
    let runtime = { lock_runtime(shared).mcp_runtime.clone() };
    tauri::async_runtime::block_on(runtime.reconcile(
        &native_backend_workspace_root(),
        &native_runtime_config_snapshot(),
    ))
    .map_err(|error| {
        format!(
            "plugin state was saved, but the MCP runtime could not be reconciled: {}",
            error.message
        )
    })
}
