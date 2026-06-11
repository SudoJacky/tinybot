use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct ConfigStore {
    config_path: PathBuf,
    snapshot: Value,
    diagnostics: Vec<ConfigDiagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigDiagnostic {
    pub level: ConfigDiagnosticLevel,
    pub code: ConfigDiagnosticCode,
    pub message: String,
    pub path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigDiagnosticLevel {
    Info,
    Warning,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigDiagnosticCode {
    MissingConfig,
    InvalidJson,
    InvalidConfig,
}

#[derive(Debug)]
pub enum ConfigStoreError {
    Io {
        path: PathBuf,
        source: io::Error,
    },
    Serialize {
        path: PathBuf,
        source: serde_json::Error,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigPatchBridgeResult {
    pub ok: bool,
    pub config: Value,
    #[serde(rename = "updatedFields", alias = "updated_fields")]
    pub updated_fields: Vec<String>,
    #[serde(rename = "sideEffects", alias = "side_effects", default)]
    pub side_effects: ConfigPatchSideEffects,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigPatchApplyResult {
    pub ok: bool,
    pub config: Value,
    #[serde(rename = "updatedFields", alias = "updated_fields")]
    pub updated_fields: Vec<String>,
    #[serde(rename = "sideEffects", alias = "side_effects")]
    pub side_effects: ConfigPatchSideEffects,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct ConfigPatchSideEffects {
    pub applied: Vec<String>,
    #[serde(rename = "restartRequired", alias = "restart_required")]
    pub restart_required: Vec<String>,
    pub warnings: Vec<String>,
}

impl ConfigStore {
    pub fn load(config_path: PathBuf, default_snapshot: Value) -> Result<Self, ConfigStoreError> {
        match fs::read_to_string(&config_path) {
            Ok(contents) => Ok(Self::load_from_text(
                config_path,
                contents,
                default_snapshot,
            )),
            Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(Self {
                config_path: config_path.clone(),
                snapshot: default_snapshot,
                diagnostics: vec![ConfigDiagnostic {
                    level: ConfigDiagnosticLevel::Info,
                    code: ConfigDiagnosticCode::MissingConfig,
                    message: "config file is missing; using defaults".to_string(),
                    path: Some(config_path),
                }],
            }),
            Err(source) => Err(ConfigStoreError::Io {
                path: config_path,
                source,
            }),
        }
    }

    pub fn from_snapshot(config_path: PathBuf, snapshot: Value) -> Self {
        Self {
            config_path,
            snapshot,
            diagnostics: Vec::new(),
        }
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub fn snapshot(&self) -> &Value {
        &self.snapshot
    }

    pub fn diagnostics(&self) -> &[ConfigDiagnostic] {
        &self.diagnostics
    }

    pub fn save_snapshot(&mut self) -> Result<(), ConfigStoreError> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent).map_err(|source| ConfigStoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }

        let contents = serde_json::to_string_pretty(&self.snapshot).map_err(|source| {
            ConfigStoreError::Serialize {
                path: self.config_path.clone(),
                source,
            }
        })?;

        fs::write(&self.config_path, contents).map_err(|source| ConfigStoreError::Io {
            path: self.config_path.clone(),
            source,
        })
    }

    pub fn apply_validated_patch_result(
        &mut self,
        result: ConfigPatchBridgeResult,
    ) -> Result<ConfigPatchApplyResult, ConfigStoreError> {
        if !result.ok {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: self.snapshot.clone(),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: result.error,
            });
        }
        if !result.config.is_object() {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: self.snapshot.clone(),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: Some(
                    "validated config patch result must contain an object config".to_string(),
                ),
            });
        }

        self.snapshot = result.config;
        self.save_snapshot()?;

        Ok(ConfigPatchApplyResult {
            ok: true,
            config: self.snapshot.clone(),
            updated_fields: result.updated_fields,
            side_effects: result.side_effects,
            error: None,
        })
    }

    fn load_from_text(config_path: PathBuf, contents: String, default_snapshot: Value) -> Self {
        let snapshot = match serde_json::from_str::<Value>(&contents) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Self {
                    config_path: config_path.clone(),
                    snapshot: default_snapshot,
                    diagnostics: vec![ConfigDiagnostic {
                        level: ConfigDiagnosticLevel::Warning,
                        code: ConfigDiagnosticCode::InvalidJson,
                        message: format!("failed to parse config JSON: {error}"),
                        path: Some(config_path),
                    }],
                };
            }
        };

        if !snapshot.is_object() {
            return Self {
                config_path: config_path.clone(),
                snapshot: default_snapshot,
                diagnostics: vec![ConfigDiagnostic {
                    level: ConfigDiagnosticLevel::Warning,
                    code: ConfigDiagnosticCode::InvalidConfig,
                    message: "config root must be an object".to_string(),
                    path: Some(config_path),
                }],
            };
        }

        Self {
            config_path,
            snapshot,
            diagnostics: Vec::new(),
        }
    }
}

impl fmt::Display for ConfigStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigStoreError::Io { path, source } => {
                write!(formatter, "failed to access {}: {source}", path.display())
            }
            ConfigStoreError::Serialize { path, source } => {
                write!(
                    formatter,
                    "failed to serialize config {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl Error for ConfigStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            ConfigStoreError::Io { source, .. } => Some(source),
            ConfigStoreError::Serialize { source, .. } => Some(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn load_missing_config_returns_default_snapshot_with_diagnostic() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("missing/config.json");

        let store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("missing config should fall back to defaults");

        assert_eq!(store.snapshot(), &default_snapshot());
        assert_eq!(
            store.diagnostics(),
            &[ConfigDiagnostic {
                level: ConfigDiagnosticLevel::Info,
                code: ConfigDiagnosticCode::MissingConfig,
                message: "config file is missing; using defaults".to_string(),
                path: Some(path),
            }]
        );
    }

    #[test]
    fn load_invalid_json_returns_default_snapshot_with_warning() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write("config.json", "{ invalid json");

        let store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("invalid config should fall back to defaults");

        assert_eq!(store.snapshot(), &default_snapshot());
        assert_eq!(store.diagnostics()[0].level, ConfigDiagnosticLevel::Warning);
        assert_eq!(
            store.diagnostics()[0].code,
            ConfigDiagnosticCode::InvalidJson
        );
        assert_eq!(store.diagnostics()[0].path, Some(path));
        assert!(store.diagnostics()[0]
            .message
            .contains("failed to parse config JSON"));
    }

    #[test]
    fn load_non_object_json_returns_default_snapshot_with_warning() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write("config.json", "[]");

        let store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("non-object config should fall back to defaults");

        assert_eq!(store.snapshot(), &default_snapshot());
        assert_eq!(store.diagnostics()[0].level, ConfigDiagnosticLevel::Warning);
        assert_eq!(
            store.diagnostics()[0].code,
            ConfigDiagnosticCode::InvalidConfig
        );
        assert_eq!(
            store.diagnostics()[0].message,
            "config root must be an object"
        );
        assert_eq!(store.diagnostics()[0].path, Some(path));
    }

    #[test]
    fn load_valid_config_uses_file_snapshot_without_diagnostics() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{"agents":{"defaults":{"model":"gpt-5"}}}"#,
        );

        let store = ConfigStore::load(path, default_snapshot())
            .expect("valid config should load file snapshot");

        assert_eq!(store.snapshot()["agents"]["defaults"]["model"], "gpt-5");
        assert!(store.diagnostics().is_empty());
    }

    #[test]
    fn save_snapshot_creates_parent_and_writes_pretty_json() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("nested/config.json");
        let mut store = ConfigStore::from_snapshot(
            path.clone(),
            json!({"tools":{"restrictToWorkspace":false}}),
        );

        store
            .save_snapshot()
            .expect("save should create parent dirs and write json");

        let saved = fs::read_to_string(path).expect("saved config should exist");
        assert!(saved.contains("\n  \"tools\": {"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&saved).expect("saved config should be JSON"),
            json!({"tools":{"restrictToWorkspace":false}})
        );
    }

    #[test]
    fn apply_validated_patch_result_updates_snapshot_and_saves_file() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("config.json");
        let mut store = ConfigStore::from_snapshot(path.clone(), default_snapshot());

        let result = store
            .apply_validated_patch_result(ConfigPatchBridgeResult {
                ok: true,
                config: json!({"agents":{"defaults":{"model":"gpt-5","provider":"openai"}}}),
                updated_fields: vec![
                    "agents.defaults.model".to_string(),
                    "agents.defaults.provider".to_string(),
                ],
                side_effects: ConfigPatchSideEffects {
                    applied: vec!["providerRuntimeChanged".to_string()],
                    restart_required: vec![],
                    warnings: vec![],
                },
                error: None,
            })
            .expect("validated patch should save");

        assert!(result.ok);
        assert_eq!(
            result.updated_fields,
            vec!["agents.defaults.model", "agents.defaults.provider"]
        );
        assert_eq!(result.side_effects.applied, vec!["providerRuntimeChanged"]);
        assert_eq!(store.snapshot()["agents"]["defaults"]["model"], "gpt-5");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(path).expect("patched config should save")
            )
            .expect("patched config should be JSON"),
            json!({"agents":{"defaults":{"model":"gpt-5","provider":"openai"}}})
        );
    }

    #[test]
    fn apply_failed_patch_result_preserves_snapshot_and_file() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("config.json");
        let original = default_snapshot();
        let mut store = ConfigStore::from_snapshot(path.clone(), original.clone());
        store
            .save_snapshot()
            .expect("fixture config should save before failed patch");

        let result = store
            .apply_validated_patch_result(ConfigPatchBridgeResult {
                ok: false,
                config: json!({"agents":{"defaults":{"model":" "}}}),
                updated_fields: vec!["agents.defaults.model".to_string()],
                side_effects: ConfigPatchSideEffects::default(),
                error: Some("agents.defaults.model must not be empty".to_string()),
            })
            .expect("failed patch result should not be an IO error");

        assert!(!result.ok);
        assert_eq!(
            result.error,
            Some("agents.defaults.model must not be empty".to_string())
        );
        assert_eq!(store.snapshot(), &original);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(path).expect("original config should still exist")
            )
            .expect("original config should be JSON"),
            original
        );
    }

    fn default_snapshot() -> serde_json::Value {
        json!({
            "agents": {
                "defaults": {
                    "model": "deepseek-reasoner"
                }
            }
        })
    }

    struct ConfigStoreFixture {
        root: PathBuf,
    }

    impl ConfigStoreFixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos();
            let root = std::env::temp_dir().join(format!("tinybot-config-store-test-{nonce}"));
            fs::create_dir_all(&root).expect("fixture root should create");
            Self { root }
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.path(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("fixture parent should create");
            }
            fs::write(&path, contents).expect("fixture file should write");
            path
        }
    }

    impl Drop for ConfigStoreFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
