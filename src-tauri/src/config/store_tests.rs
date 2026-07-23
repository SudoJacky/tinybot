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
    let mut store =
        ConfigStore::from_snapshot(path.clone(), json!({"tools":{"restrictToWorkspace":false}}));

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

#[test]
fn editor_snapshot_exposes_revision_and_redacted_public_config() {
    let path = PathBuf::from("config.json");
    let store = ConfigStore::from_snapshot(
        path.clone(),
        json!({
            "agents": {
                "defaults": {
                    "model": "gpt-5",
                    "timezone": "UTC"
                }
            },
            "providers": {
                "openai": {
                    "provider": "openai",
                    "api_key": "sk-secret",
                    "api_base": "https://api.openai.com/v1"
                }
            }
        }),
    );

    let snapshot = store.editor_snapshot();

    assert_eq!(snapshot.config_path, path);
    assert_eq!(snapshot.revision, store.revision());
    assert_eq!(
        snapshot.explicit_public_config["providers"]["openai"]["api_key_configured"],
        json!(true)
    );
    assert!(snapshot.explicit_public_config["providers"]["openai"]
        .get("api_key")
        .is_none());
    assert_eq!(
        snapshot.secret_presence["providers.openai.api_key"],
        json!({
            "configured": true,
            "source": "config"
        })
    );
}

#[test]
fn editor_snapshot_keeps_missing_file_defaults_out_of_explicit_config() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.path("missing/config.json");
    let store = ConfigStore::load(path, default_snapshot())
        .expect("missing config should load defaults for effective view");

    let snapshot = store.editor_snapshot();

    assert_eq!(snapshot.explicit_public_config, json!({}));
    assert_eq!(
        snapshot.effective_public_config["agents"]["defaults"]["model"],
        "deepseek-v4-pro"
    );
    assert_eq!(snapshot.origins["agents.defaults.model"], "default");
}

#[test]
fn apply_operations_preserves_unrelated_raw_secrets() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write(
        "config.json",
        r#"{
              "agents": { "defaults": { "model": "gpt-5", "timezone": "UTC" } },
              "providers": {
                "openai": {
                  "provider": "openai",
                  "api_key": "sk-secret",
                  "api_base": "https://api.openai.com/v1"
                }
              }
            }"#,
    );
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("fixture config should load");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![ConfigOperation::Replace {
                path: "agents.defaults.timezone".to_string(),
                value: json!("Asia/Shanghai"),
            }],
        })
        .expect("operation patch should save");

    assert!(result.ok);
    assert_eq!(result.updated_fields, vec!["agents.defaults.timezone"]);
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("patched config should save"),
    )
    .expect("patched config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
    assert_eq!(saved["providers"]["openai"]["api_key"], "sk-secret");
    assert!(result.config["providers"]["openai"]
        .get("api_key")
        .is_none());
    assert_eq!(
        result.config["providers"]["openai"]["api_key_configured"],
        json!(true)
    );
}

#[test]
fn apply_operations_to_missing_config_does_not_materialize_defaults() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.path("missing/config.json");
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("missing config should load");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![ConfigOperation::Replace {
                path: "agents.defaults.timezone".to_string(),
                value: json!("Asia/Shanghai"),
            }],
        })
        .expect("operation save should create config");

    assert!(result.ok);
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("config should save"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
    assert!(saved["agents"]["defaults"].get("model").is_none());
}

#[test]
fn apply_operations_remove_deletes_target_without_empty_object_merge() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write(
        "config.json",
        r#"{
              "tools": {
                "mcpServers": {
                  "docs": { "command": "docs-mcp" },
                  "search": { "command": "search-mcp" }
                }
              }
            }"#,
    );
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("fixture config should load");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![ConfigOperation::Remove {
                path: "tools.mcpServers.docs".to_string(),
            }],
        })
        .expect("remove operation should save");

    assert!(result.ok);
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("patched config should save"),
    )
    .expect("patched config should be JSON");
    assert!(saved["tools"]["mcpServers"].get("docs").is_none());
    assert_eq!(
        saved["tools"]["mcpServers"]["search"]["command"],
        "search-mcp"
    );
}

#[test]
fn apply_operations_rejects_stale_revision_and_preserves_file() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write(
        "config.json",
        r#"{"agents":{"defaults":{"model":"gpt-5"}}}"#,
    );
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("fixture config should load");
    fs::write(
        &path,
        r#"{"agents":{"defaults":{"model":"externally-edited"}}}"#,
    )
    .expect("external edit should write");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some("stale-revision".to_string()),
            operations: vec![ConfigOperation::Replace {
                path: "agents.defaults.model".to_string(),
                value: json!("gpt-5.1"),
            }],
        })
        .expect("revision conflict should be a protocol result");

    assert!(!result.ok);
    assert_eq!(result.error.as_deref(), Some("configuration_changed"));
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("externally edited config should remain"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["model"], "externally-edited");
}

#[test]
fn apply_operations_rejects_masked_secret_placeholder() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write(
        "config.json",
        r#"{"providers":{"openai":{"api_key":"sk-secret"}}}"#,
    );
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("fixture config should load");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![ConfigOperation::SecretReplace {
                path: "providers.openai.api_key".to_string(),
                value: json!("********"),
            }],
        })
        .expect("masked placeholder should be rejected as a protocol result");

    assert!(!result.ok);
    assert_eq!(result.error.as_deref(), Some("masked_secret_placeholder"));
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("original config should remain"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["providers"]["openai"]["api_key"], "sk-secret");
}

#[test]
fn apply_operations_writes_canonical_key_for_legacy_alias_path() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write(
            "config.json",
            r#"{"agents":{"defaults":{"maxTokens":2048,"max_tokens":2048,"contextWindowStrategy":"discard","context_window_strategy":"discard"}}}"#,
        );
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("fixture config should load");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![
                ConfigOperation::Replace {
                    path: "agents.defaults.max_tokens".to_string(),
                    value: json!(8192),
                },
                ConfigOperation::Replace {
                    path: "agents.defaults.context_window_strategy".to_string(),
                    value: json!("compact"),
                },
            ],
        })
        .expect("alias operation should save");

    assert!(result.ok);
    assert_eq!(
        result.updated_fields,
        vec![
            "agents.defaults.maxTokens",
            "agents.defaults.contextWindowStrategy"
        ]
    );
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("patched config should save"),
    )
    .expect("patched config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["maxTokens"], 8192);
    assert_eq!(
        saved["agents"]["defaults"]["contextWindowStrategy"],
        "compact"
    );
    assert!(saved["agents"]["defaults"].get("max_tokens").is_none());
    assert!(saved["agents"]["defaults"]
        .get("context_window_strategy")
        .is_none());
}

#[test]
fn load_reports_conflicting_alias_diagnostics() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write(
        "config.json",
        r#"{"agents":{"defaults":{"maxTokens":4096,"max_tokens":2048}}}"#,
    );

    let store = ConfigStore::load(path, default_snapshot())
        .expect("conflicting aliases should still load for diagnostics");

    assert_eq!(
        store.diagnostics()[0].code,
        ConfigDiagnosticCode::AliasConflict
    );
    assert!(store.diagnostics()[0]
        .message
        .contains("agents.defaults.maxTokens"));
}

#[test]
fn apply_operations_rejects_conflicting_aliases_without_writing() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write(
        "config.json",
        r#"{"agents":{"defaults":{"maxTokens":4096,"max_tokens":2048}}}"#,
    );
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("fixture config should load");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![ConfigOperation::Replace {
                path: "agents.defaults.maxTokens".to_string(),
                value: json!(8192),
            }],
        })
        .expect("alias conflict should be a protocol result");

    assert!(!result.ok);
    assert_eq!(
        result.error.as_deref(),
        Some("alias_conflict: agents.defaults.maxTokens")
    );
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("original config should remain"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["maxTokens"], 4096);
    assert_eq!(saved["agents"]["defaults"]["max_tokens"], 2048);
}

#[test]
fn apply_operations_rejects_invalid_gateway_port_without_writing() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write("config.json", r#"{"gateway":{"port":18790}}"#);
    let mut store =
        ConfigStore::load(path.clone(), default_snapshot()).expect("fixture config should load");

    let result = store
        .apply_operations(ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![ConfigOperation::Replace {
                path: "gateway.port".to_string(),
                value: json!(70000),
            }],
        })
        .expect("validation failure should be a protocol result");

    assert!(!result.ok);
    assert_eq!(
        result.error.as_deref(),
        Some("validation_failed: gateway.port")
    );
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("original config should remain"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["gateway"]["port"], 18790);
}

#[test]
fn save_snapshot_reports_atomic_write_failure_without_changing_authoritative_file() {
    let fixture = ConfigStoreFixture::new();
    let path = fixture.write("config.json", r#"{"gateway":{"port":18790}}"#);
    let blocking_temp_path = path.with_extension("json.tmp");
    fs::create_dir_all(&blocking_temp_path).expect("blocking temp directory should create");
    let mut store = ConfigStore::from_snapshot(path.clone(), json!({"gateway":{"port":18888}}));

    let error = store
        .save_snapshot()
        .expect_err("temp-file creation failure should be reported");

    match error {
        ConfigStoreError::Io {
            path: error_path, ..
        } => assert_eq!(error_path, path),
        other => panic!("expected IO error, got {other:?}"),
    }
    let saved = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path).expect("authoritative config should remain"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["gateway"]["port"], 18790);
}

fn default_snapshot() -> serde_json::Value {
    json!({
        "agents": {
            "defaults": {
                "model": "deepseek-v4-pro"
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
