use crate::config::registry::{build_settings_snapshot, SettingsSnapshot, SettingsSnapshotInput};
use crate::config::store::{
    ConfigDiagnostic, ConfigDiagnosticCode, ConfigDiagnosticLevel, ConfigEditorSnapshot,
    ConfigOperationRequest, ConfigPatchApplyResult, ConfigPatchBridgeResult, ConfigStore,
    ConfigStoreError,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    fmt,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigApplicationErrorCode {
    InitializeDefaultConfig,
    LoadConfigStore,
    ApplyConfigPatch,
    ApplyConfigOperations,
}

#[derive(Debug)]
pub struct ConfigApplicationError {
    pub code: ConfigApplicationErrorCode,
    pub config_path: PathBuf,
    pub message: String,
}

impl fmt::Display for ConfigApplicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: {}",
            self.config_path.display(),
            self.message
        )
    }
}

impl std::error::Error for ConfigApplicationError {}

#[derive(Clone, Debug)]
pub struct ConfigApplication {
    config_path: PathBuf,
    default_snapshot: Value,
}

impl ConfigApplication {
    pub fn new(config_path: PathBuf, default_snapshot: Value) -> Self {
        Self {
            config_path,
            default_snapshot,
        }
    }

    pub fn apply_patch(
        &self,
        result: ConfigPatchBridgeResult,
    ) -> Result<ConfigPatchApplyResult, ConfigApplicationError> {
        self.ensure_default_file()?;
        self.load_store()?
            .apply_validated_patch_result(result)
            .map_err(|error| self.store_error(ConfigApplicationErrorCode::ApplyConfigPatch, error))
    }

    pub fn editor_snapshot(&self) -> Result<ConfigEditorSnapshot, ConfigApplicationError> {
        let ensure_diagnostics = self.ensure_default_file()?;
        let store = self.load_store()?;
        let mut snapshot = store.editor_snapshot();
        snapshot.diagnostics.splice(0..0, ensure_diagnostics);
        Ok(snapshot)
    }

    pub fn settings_snapshot(&self) -> Result<SettingsSnapshot, ConfigApplicationError> {
        let ensure_diagnostics = self.ensure_default_file()?;
        let store = self.load_store()?;
        let mut diagnostics = ensure_diagnostics;
        diagnostics.extend(store.diagnostics().to_vec());
        Ok(build_settings_snapshot(SettingsSnapshotInput {
            config: store.snapshot().clone(),
            config_path: store.config_path().to_path_buf(),
            revision: store.revision(),
            diagnostics,
        }))
    }

    pub fn apply_operations(
        &self,
        request: ConfigOperationRequest,
    ) -> Result<ConfigPatchApplyResult, ConfigApplicationError> {
        self.ensure_default_file()?;
        self.load_store()?
            .apply_operations(request)
            .map_err(|error| {
                self.store_error(ConfigApplicationErrorCode::ApplyConfigOperations, error)
            })
    }

    pub fn ensure_default_file(&self) -> Result<Vec<ConfigDiagnostic>, ConfigApplicationError> {
        match std::fs::metadata(&self.config_path) {
            Ok(_) => Ok(Vec::new()),
            Err(error) => match error.kind() {
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
                    match self.write_default_file() {
                        Ok(()) => Ok(vec![ConfigDiagnostic {
                            level: ConfigDiagnosticLevel::Info,
                            code: ConfigDiagnosticCode::DefaultConfigCreated,
                            message: "default config file created".to_string(),
                            path: Some(self.config_path.clone()),
                        }]),
                        Err(error) => Ok(vec![ConfigDiagnostic {
                            level: ConfigDiagnosticLevel::Warning,
                            code: ConfigDiagnosticCode::DefaultConfigCreateFailed,
                            message: format!("failed to create default config file: {error}"),
                            path: Some(self.config_path.clone()),
                        }]),
                    }
                }
                _ => Err(self.io_error(ConfigApplicationErrorCode::InitializeDefaultConfig, error)),
            },
        }
    }

    fn load_store(&self) -> Result<ConfigStore, ConfigApplicationError> {
        ConfigStore::load(self.config_path.clone(), self.default_snapshot.clone())
            .map_err(|error| self.store_error(ConfigApplicationErrorCode::LoadConfigStore, error))
    }

    fn write_default_file(&self) -> Result<(), std::io::Error> {
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let contents =
            serde_json::to_string_pretty(&self.default_snapshot).map_err(std::io::Error::other)?;
        std::fs::write(&self.config_path, contents)
    }

    fn io_error(
        &self,
        code: ConfigApplicationErrorCode,
        error: std::io::Error,
    ) -> ConfigApplicationError {
        ConfigApplicationError {
            code,
            config_path: self.config_path.clone(),
            message: error.to_string(),
        }
    }

    fn store_error(
        &self,
        code: ConfigApplicationErrorCode,
        error: ConfigStoreError,
    ) -> ConfigApplicationError {
        ConfigApplicationError {
            code,
            config_path: self.config_path.clone(),
            message: error.to_string(),
        }
    }
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
    let config = serde_json::from_str::<Value>(&contents).ok()?;
    config
        .pointer("/agents/defaults/workspace")
        .and_then(Value::as_str)
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

pub(crate) fn experimental_worker_default_config_snapshot() -> Value {
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
                    "supportsModelDiscovery": true,
                    "capabilities": ["reasoning"]
                }
            }
        },
        "gateway": {
            "host": "127.0.0.1",
            "port": 18790
        }
    })
}

pub(crate) fn experimental_worker_config_snapshot_from_path(config_path: &Path) -> Value {
    ConfigStore::load(
        config_path.to_path_buf(),
        experimental_worker_default_config_snapshot(),
    )
    .map(|store| store.snapshot().clone())
    .unwrap_or_else(|_| experimental_worker_default_config_snapshot())
}

pub(crate) fn experimental_worker_config_snapshot() -> Value {
    experimental_worker_config_snapshot_from_path(&default_tinybot_config_path())
}

pub(crate) fn apply_config_patch_result_to_path(
    config_path: &Path,
    default_snapshot: Value,
    result: ConfigPatchBridgeResult,
) -> Result<ConfigPatchApplyResult, ConfigApplicationError> {
    ConfigApplication::new(config_path.to_path_buf(), default_snapshot).apply_patch(result)
}

pub(crate) fn config_editor_snapshot_from_path(
    config_path: &Path,
    default_snapshot: Value,
) -> Result<ConfigEditorSnapshot, ConfigApplicationError> {
    ConfigApplication::new(config_path.to_path_buf(), default_snapshot).editor_snapshot()
}

pub(crate) fn get_settings_snapshot_from_path(
    config_path: &Path,
    default_snapshot: Value,
) -> Result<SettingsSnapshot, ConfigApplicationError> {
    ConfigApplication::new(config_path.to_path_buf(), default_snapshot).settings_snapshot()
}

pub(crate) fn apply_config_operations_to_path(
    config_path: &Path,
    default_snapshot: Value,
    request: ConfigOperationRequest,
) -> Result<ConfigPatchApplyResult, ConfigApplicationError> {
    ConfigApplication::new(config_path.to_path_buf(), default_snapshot).apply_operations(request)
}

pub(crate) fn ensure_default_config_file(
    config_path: &Path,
) -> Result<Vec<ConfigDiagnostic>, ConfigApplicationError> {
    ConfigApplication::new(
        config_path.to_path_buf(),
        experimental_worker_default_config_snapshot(),
    )
    .ensure_default_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_config_path_reports_structured_load_error() {
        let root =
            std::env::temp_dir().join(format!("tinybot-config-application-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("fixture directory should create");
        let application = ConfigApplication::new(root.clone(), serde_json::json!({}));

        let error = application
            .editor_snapshot()
            .expect_err("directory config path should fail to load");

        assert_eq!(error.code, ConfigApplicationErrorCode::LoadConfigStore);
        assert_eq!(error.config_path, root);
        assert!(!error.message.is_empty());
        std::fs::remove_dir_all(&error.config_path).expect("fixture directory should clean up");
    }
}
