use crate::config_application::{
    apply_config_operations_to_path, apply_config_patch_result_to_path,
    config_editor_snapshot_from_path, default_tinybot_config_path,
    experimental_worker_config_snapshot, experimental_worker_config_snapshot_from_path,
    experimental_worker_default_config_snapshot, get_settings_snapshot_from_path,
    native_backend_workspace_root, ConfigApplicationError, ConfigApplicationErrorCode,
};
use crate::config_store::{
    ConfigEditorSnapshot, ConfigOperationRequest, ConfigPatchApplyResult, ConfigPatchBridgeResult,
};
use crate::settings_registry::{apply_mcp_runtime_statuses, SettingsSnapshot};
use crate::{lock_runtime, SharedGateway};
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConfigIpcErrorCode {
    InitializeDefaultConfig,
    LoadConfigStore,
    ApplyConfigPatch,
    ApplyConfigOperations,
    ReconcileMcpRuntime,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigIpcError {
    pub code: ConfigIpcErrorCode,
    pub message: String,
    pub config_path: PathBuf,
}

impl From<ConfigApplicationError> for ConfigIpcError {
    fn from(error: ConfigApplicationError) -> Self {
        let code = match error.code {
            ConfigApplicationErrorCode::InitializeDefaultConfig => {
                ConfigIpcErrorCode::InitializeDefaultConfig
            }
            ConfigApplicationErrorCode::LoadConfigStore => ConfigIpcErrorCode::LoadConfigStore,
            ConfigApplicationErrorCode::ApplyConfigPatch => ConfigIpcErrorCode::ApplyConfigPatch,
            ConfigApplicationErrorCode::ApplyConfigOperations => {
                ConfigIpcErrorCode::ApplyConfigOperations
            }
        };
        Self {
            code,
            message: error.message,
            config_path: error.config_path,
        }
    }
}

#[tauri::command]
pub(crate) fn apply_config_patch_result(
    result: ConfigPatchBridgeResult,
    state: State<'_, SharedGateway>,
) -> Result<ConfigPatchApplyResult, ConfigIpcError> {
    let applied = apply_config_patch_result_to_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
        result,
    )?;
    reconcile_mcp_runtime_if_changed(state.inner(), &applied)?;
    Ok(applied)
}

#[tauri::command]
pub(crate) fn get_config_editor_snapshot() -> Result<ConfigEditorSnapshot, ConfigIpcError> {
    config_editor_snapshot_from_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn get_settings_snapshot(
    state: State<'_, SharedGateway>,
) -> Result<SettingsSnapshot, ConfigIpcError> {
    let config_path = default_tinybot_config_path();
    let mut snapshot = get_settings_snapshot_from_path(
        &config_path,
        experimental_worker_default_config_snapshot(),
    )?;
    let config = experimental_worker_config_snapshot_from_path(&config_path);
    let runtime = { lock_runtime(state.inner()).mcp_runtime.clone() };
    let statuses = tauri::async_runtime::block_on(
        runtime.configured_statuses(&native_backend_workspace_root(), &config),
    );
    apply_mcp_runtime_statuses(&mut snapshot, &statuses);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn apply_config_operations(
    request: ConfigOperationRequest,
    state: State<'_, SharedGateway>,
) -> Result<ConfigPatchApplyResult, ConfigIpcError> {
    let applied = apply_config_operations_to_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
        request,
    )?;
    reconcile_mcp_runtime_if_changed(state.inner(), &applied)?;
    Ok(applied)
}

fn reconcile_mcp_runtime_if_changed(
    shared: &SharedGateway,
    result: &ConfigPatchApplyResult,
) -> Result<(), ConfigIpcError> {
    if !result.ok
        || !result
            .side_effects
            .applied
            .iter()
            .any(|effect| effect == "mcpConfigChanged")
    {
        return Ok(());
    }
    let runtime = { lock_runtime(shared).mcp_runtime.clone() };
    tauri::async_runtime::block_on(
        runtime.reconcile(&native_backend_workspace_root(), &result.config),
    )
    .map_err(|error| ConfigIpcError {
        code: ConfigIpcErrorCode::ReconcileMcpRuntime,
        message: format!("failed to reconcile MCP runtime: {}", error.message),
        config_path: default_tinybot_config_path(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_application_error_maps_to_structured_ipc_payload() {
        let config_path = PathBuf::from("fixture-config.json");
        let ipc_error = ConfigIpcError::from(ConfigApplicationError {
            code: ConfigApplicationErrorCode::ApplyConfigOperations,
            config_path: config_path.clone(),
            message: "fixture failure".to_string(),
        });

        let payload = serde_json::to_value(ipc_error).expect("IPC error should serialize");
        assert_eq!(payload["code"], "apply_config_operations");
        assert_eq!(payload["message"], "fixture failure");
        assert_eq!(
            payload["configPath"],
            config_path.to_string_lossy().as_ref()
        );
    }
}
