use crate::config_store::{
    ConfigDiagnostic, ConfigDiagnosticCode, ConfigDiagnosticLevel, ConfigEditorSnapshot,
    ConfigOperationRequest, ConfigPatchApplyResult, ConfigPatchBridgeResult, ConfigStore,
};
use crate::settings_registry::{build_settings_snapshot, SettingsSnapshot, SettingsSnapshotInput};
use std::path::{Path, PathBuf};

#[tauri::command]
pub(crate) fn apply_config_patch_result(
    result: ConfigPatchBridgeResult,
) -> Result<ConfigPatchApplyResult, String> {
    apply_config_patch_result_to_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
        result,
    )
}

#[tauri::command]
pub(crate) fn get_config_editor_snapshot() -> Result<ConfigEditorSnapshot, String> {
    config_editor_snapshot_from_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
    )
}

#[tauri::command]
pub(crate) fn get_settings_snapshot() -> Result<SettingsSnapshot, String> {
    get_settings_snapshot_from_path(
        &default_tinybot_config_path(),
        experimental_worker_default_config_snapshot(),
    )
}

#[tauri::command]
pub(crate) fn apply_config_operations(
    request: ConfigOperationRequest,
) -> Result<ConfigPatchApplyResult, String> {
    apply_config_operations_to_path(
        &default_tinybot_config_path(),
        experimental_worker_config_snapshot(),
        request,
    )
}

pub(crate) fn default_tinybot_config_path() -> PathBuf {
    tinybot_home_dir().join(".tinybot").join("config.json")
}

fn tinybot_home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub(crate) fn default_tinybot_workspace_root() -> PathBuf {
    tinybot_home_dir().join(".tinybot").join("workspace")
}

pub(crate) fn native_backend_workspace_root() -> PathBuf {
    let root =
        resolve_native_backend_workspace_root_from_config_path(&default_tinybot_config_path());
    let _ = std::fs::create_dir_all(&root);
    root
}

pub(crate) fn resolve_native_backend_workspace_root_from_config_path(
    config_path: &Path,
) -> PathBuf {
    configured_tinybot_workspace(config_path)
        .map(|workspace| expand_tinybot_workspace_path(&workspace))
        .unwrap_or_else(default_tinybot_workspace_root)
}

fn configured_tinybot_workspace(config_path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(config_path).ok()?;
    let config = serde_json::from_str::<serde_json::Value>(&contents).ok()?;
    config
        .pointer("/agents/defaults/workspace")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|workspace| !workspace.is_empty())
        .map(str::to_string)
}

fn expand_tinybot_workspace_path(workspace: &str) -> PathBuf {
    let workspace = workspace.trim();
    if workspace == "~" {
        return tinybot_home_dir();
    }
    if let Some(relative) = workspace
        .strip_prefix("~/")
        .or_else(|| workspace.strip_prefix("~\\"))
    {
        return tinybot_home_dir().join(relative);
    }
    PathBuf::from(workspace)
}

pub(crate) fn experimental_worker_default_config_snapshot() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "agents": {
            "defaults": {
                "activeProfile": "deepseek-default",
                "model": "deepseek-v4-pro",
                "workspace": "~/.tinybot/workspace"
            }
        },
        "providers": {
            "profiles": {
                "deepseek-default": {
                    "provider": "deepseek",
                    "displayName": "DeepSeek",
                    "enabled": true,
                    "apiBase": "https://api.deepseek.com",
                    "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
                    "defaultModel": "deepseek-v4-pro",
                    "supportsModelDiscovery": true
                }
            }
        },
        "gateway": {
            "host": "127.0.0.1",
            "port": 18790
        }
    })
}

pub(crate) fn experimental_worker_config_snapshot_from_path(
    config_path: &Path,
) -> serde_json::Value {
    ConfigStore::load(
        config_path.to_path_buf(),
        experimental_worker_default_config_snapshot(),
    )
    .map(|store| store.snapshot().clone())
    .unwrap_or_else(|_| experimental_worker_default_config_snapshot())
}

pub(crate) fn experimental_worker_config_snapshot() -> serde_json::Value {
    experimental_worker_config_snapshot_from_path(&default_tinybot_config_path())
}

pub(crate) fn apply_config_patch_result_to_path(
    config_path: &Path,
    default_snapshot: serde_json::Value,
    result: ConfigPatchBridgeResult,
) -> Result<ConfigPatchApplyResult, String> {
    ensure_default_config_file(config_path)
        .map_err(|error| format!("failed to initialize default config: {error}"))?;
    let mut store = ConfigStore::load(config_path.to_path_buf(), default_snapshot)
        .map_err(|error| format!("failed to load config store: {error}"))?;
    store
        .apply_validated_patch_result(result)
        .map_err(|error| format!("failed to apply native config patch: {error}"))
}

pub(crate) fn config_editor_snapshot_from_path(
    config_path: &Path,
    default_snapshot: serde_json::Value,
) -> Result<ConfigEditorSnapshot, String> {
    let ensure_diagnostics = ensure_default_config_file(config_path)
        .map_err(|error| format!("failed to initialize default config: {error}"))?;
    let store = ConfigStore::load(config_path.to_path_buf(), default_snapshot)
        .map_err(|error| format!("failed to load config store: {error}"))?;
    let mut snapshot = store.editor_snapshot();
    snapshot.diagnostics.splice(0..0, ensure_diagnostics);
    Ok(snapshot)
}

pub(crate) fn get_settings_snapshot_from_path(
    config_path: &Path,
    default_snapshot: serde_json::Value,
) -> Result<SettingsSnapshot, String> {
    let ensure_diagnostics = ensure_default_config_file(config_path)
        .map_err(|error| format!("failed to initialize default config: {error}"))?;
    let store = ConfigStore::load(config_path.to_path_buf(), default_snapshot)
        .map_err(|error| format!("failed to load config store: {error}"))?;
    let mut diagnostics = ensure_diagnostics;
    diagnostics.extend(store.diagnostics().to_vec());
    Ok(build_settings_snapshot(SettingsSnapshotInput {
        config: store.snapshot().clone(),
        config_path: store.config_path().to_path_buf(),
        revision: store.revision(),
        diagnostics,
    }))
}

pub(crate) fn apply_config_operations_to_path(
    config_path: &Path,
    default_snapshot: serde_json::Value,
    request: ConfigOperationRequest,
) -> Result<ConfigPatchApplyResult, String> {
    ensure_default_config_file(config_path)
        .map_err(|error| format!("failed to initialize default config: {error}"))?;
    let mut store = ConfigStore::load(config_path.to_path_buf(), default_snapshot)
        .map_err(|error| format!("failed to load config store: {error}"))?;
    store
        .apply_operations(request)
        .map_err(|error| format!("failed to apply native config operations: {error}"))
}

pub(crate) fn ensure_default_config_file(
    config_path: &Path,
) -> Result<Vec<ConfigDiagnostic>, std::io::Error> {
    match std::fs::metadata(config_path) {
        Ok(_) => Ok(Vec::new()),
        Err(error) => match error.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
                match write_default_config_file(config_path) {
                    Ok(()) => Ok(vec![ConfigDiagnostic {
                        level: ConfigDiagnosticLevel::Info,
                        code: ConfigDiagnosticCode::DefaultConfigCreated,
                        message: "default config file created".to_string(),
                        path: Some(config_path.to_path_buf()),
                    }]),
                    Err(error) => Ok(vec![ConfigDiagnostic {
                        level: ConfigDiagnosticLevel::Warning,
                        code: ConfigDiagnosticCode::DefaultConfigCreateFailed,
                        message: format!("failed to create default config file: {error}"),
                        path: Some(config_path.to_path_buf()),
                    }]),
                }
            }
            _ => Err(error),
        },
    }
}

fn write_default_config_file(config_path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let contents = serde_json::to_string_pretty(&experimental_worker_default_config_snapshot())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
    std::fs::write(config_path, contents)
}
