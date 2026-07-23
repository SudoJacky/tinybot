use super::support::*;
use crate::config::application::apply_config_operations_to_path;
use crate::config::application::apply_config_patch_result_to_path;
use crate::config::application::config_editor_snapshot_from_path;
use crate::config::application::ensure_default_config_file;
use crate::config::application::get_settings_snapshot_from_path;
use crate::config::application::native_default_config_snapshot;

#[test]
fn native_config_patch_result_persists_legacy_compatible_config_file() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    let result = apply_config_patch_result_to_path(
            &config_path,
            serde_json::json!({"agents":{"defaults":{"model":"gpt-4.1-mini","provider":"openai"}}}),
            crate::config::store::ConfigPatchBridgeResult {
                ok: true,
                config: serde_json::json!({"agents":{"defaults":{"model":"gpt-4.1","provider":"openai"}}}),
                updated_fields: vec!["agents.defaults.model".to_string()],
                side_effects: crate::config::store::ConfigPatchSideEffects {
                    applied: vec!["providerRuntimeChanged".to_string()],
                    restart_required: vec![],
                    warnings: vec![],
                },
                error: None,
            },
        )
        .expect("native config patch should persist");

    assert!(result.ok);
    assert_eq!(result.config["agents"]["defaults"]["model"], "gpt-4.1");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(config_path).expect("config file should save")
        )
        .expect("saved config should be JSON")["agents"]["defaults"]["model"],
        "gpt-4.1"
    );
}

#[test]
fn native_config_editor_snapshot_returns_redacted_revisioned_view() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(
        &config_path,
        r#"{
              "agents": { "defaults": { "model": "gpt-5" } },
              "providers": { "openai": { "api_key": "sk-secret" } }
            }"#,
    )
    .expect("fixture config should write");

    let snapshot = config_editor_snapshot_from_path(
        &config_path,
        serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
    )
    .expect("editor snapshot should load");

    assert_eq!(snapshot.config_path, config_path);
    assert!(snapshot.revision.starts_with("hash:"));
    assert_eq!(
        snapshot.explicit_public_config["providers"]["openai"]["api_key_configured"],
        true
    );
    assert!(snapshot.explicit_public_config["providers"]["openai"]
        .get("api_key")
        .is_none());
    assert_eq!(
        snapshot.secret_presence["providers.openai.api_key"]["configured"],
        true
    );
}

#[test]
fn ensure_default_config_file_creates_schema_v1_deepseek_profile_when_missing() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");

    let diagnostics = ensure_default_config_file(&config_path)
        .expect("missing config should initialize default file");

    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>(),
        vec![crate::config::store::ConfigDiagnosticCode::DefaultConfigCreated]
    );
    let saved = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(&config_path).expect("default config should be created"),
    )
    .expect("default config should be JSON");
    assert_eq!(saved["schemaVersion"], 1);
    assert_eq!(
        saved["agents"]["defaults"]["activeProfile"],
        "deepseek-default"
    );
    assert_eq!(
        saved["providers"]["profiles"]["deepseek-default"]["capabilities"],
        serde_json::json!(["reasoning"])
    );
    assert_eq!(saved["agents"]["defaults"]["model"], "deepseek-v4-pro");
    assert!(saved["agents"]["defaults"].get("provider").is_none());
    assert_eq!(
        saved["providers"]["profiles"]["deepseek-default"]["provider"],
        "deepseek"
    );
    assert_eq!(
        saved["providers"]["profiles"]["deepseek-default"]["models"],
        serde_json::json!(["deepseek-v4-pro", "deepseek-v4-flash"])
    );
    assert_eq!(saved["gateway"]["host"], "127.0.0.1");
    assert_eq!(saved["gateway"]["port"], 18790);
    assert!(!fixture.root.join(".tinybot").join("workspace").exists());
}

#[test]
fn ensure_default_config_file_does_not_overwrite_existing_or_invalid_config() {
    let fixture = WorkspaceFixture::new();
    let valid_path = fixture.root.join("valid").join("config.json");
    if let Some(parent) = valid_path.parent() {
        std::fs::create_dir_all(parent).expect("valid parent should create");
    }
    std::fs::write(&valid_path, r#"{"agents":{"defaults":{"model":"custom"}}}"#)
        .expect("fixture config should write");

    let diagnostics =
        ensure_default_config_file(&valid_path).expect("existing config should not be overwritten");

    assert!(diagnostics.is_empty());
    assert_eq!(
        std::fs::read_to_string(&valid_path).expect("valid config should remain"),
        r#"{"agents":{"defaults":{"model":"custom"}}}"#
    );

    let invalid_path = fixture.root.join("invalid").join("config.json");
    if let Some(parent) = invalid_path.parent() {
        std::fs::create_dir_all(parent).expect("invalid parent should create");
    }
    std::fs::write(&invalid_path, "{ invalid json").expect("invalid fixture should write");

    let diagnostics = ensure_default_config_file(&invalid_path)
        .expect("invalid existing config should not be overwritten");

    assert!(diagnostics.is_empty());
    assert_eq!(
        std::fs::read_to_string(&invalid_path).expect("invalid config should remain"),
        "{ invalid json"
    );
}

#[test]
fn config_editor_snapshot_ensures_missing_default_config_before_loading() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");

    let snapshot = config_editor_snapshot_from_path(&config_path, native_default_config_snapshot())
        .expect("editor snapshot should initialize missing config");

    assert!(config_path.exists());
    assert_eq!(
        snapshot.effective_public_config["agents"]["defaults"]["activeProfile"],
        "deepseek-default"
    );
    assert_eq!(
        snapshot
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>(),
        vec![crate::config::store::ConfigDiagnosticCode::DefaultConfigCreated]
    );
}

#[test]
fn config_editor_snapshot_reports_default_config_create_failure_as_diagnostic() {
    let fixture = WorkspaceFixture::new();
    let blocked_parent = fixture.root.join("blocked");
    std::fs::write(&blocked_parent, "not a directory").expect("blocking parent file should write");
    let config_path = blocked_parent.join("config.json");

    let snapshot = config_editor_snapshot_from_path(&config_path, native_default_config_snapshot())
        .expect("editor snapshot should remain readable with in-memory defaults");

    assert_eq!(
        snapshot
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>(),
        vec![
            crate::config::store::ConfigDiagnosticCode::DefaultConfigCreateFailed,
            crate::config::store::ConfigDiagnosticCode::MissingConfig,
        ]
    );
    assert_eq!(
        snapshot.effective_public_config["agents"]["defaults"]["activeProfile"],
        "deepseek-default"
    );
    assert_eq!(
        std::fs::read_to_string(&blocked_parent).expect("blocked parent should remain a file"),
        "not a directory"
    );
}

#[test]
fn native_settings_snapshot_returns_registry_projection() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(
        &config_path,
        r#"{
              "agents": { "defaults": { "active_profile": "openai-work", "model": "gpt-5" } },
              "providers": {
                "profiles": {
                  "openai-work": {
                    "provider": "openai",
                    "api_key": "sk-secret",
                    "default_model": "gpt-5-mini"
                  }
                }
              },
              "gateway": { "host": "0.0.0.0", "port": 18791 }
            }"#,
    )
    .expect("fixture config should write");

    let snapshot = get_settings_snapshot_from_path(
        &config_path,
        serde_json::json!({ "gateway": { "host": "127.0.0.1", "port": 18790 } }),
    )
    .expect("settings snapshot should load");

    let group_ids: Vec<&str> = snapshot
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();
    assert_eq!(group_ids[0], "general");
    assert!(group_ids.contains(&"provider-models"));
    assert!(group_ids.contains(&"expert-config"));

    let provider_group = snapshot
        .groups
        .iter()
        .find(|group| group.id == "provider-models")
        .expect("provider group should exist");
    let api_key = provider_group
        .fields
        .iter()
        .find(|field| field.path == "providers.profiles.openai-work.apiKey")
        .expect("api key field should exist");
    assert_eq!(api_key.value, serde_json::Value::Null);
    assert_eq!(
        api_key
            .secret
            .as_ref()
            .expect("secret metadata should exist")
            .configured,
        true
    );

    let gateway_group = snapshot
        .groups
        .iter()
        .find(|group| group.id == "gateway-runtime")
        .expect("gateway group should exist");
    let host = gateway_group
        .fields
        .iter()
        .find(|field| field.path == "gateway.host")
        .expect("host field should exist");
    assert!(!host.editable);
    assert_eq!(host.value, serde_json::json!("127.0.0.1"));
}

#[test]
fn native_config_operations_preserve_secret_while_saving_unrelated_field() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join(".tinybot").join("config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(
        &config_path,
        r#"{
              "agents": { "defaults": { "model": "gpt-5", "timezone": "UTC" } },
              "providers": { "openai": { "api_key": "sk-secret" } }
            }"#,
    )
    .expect("fixture config should write");
    let store = crate::config::store::ConfigStore::load(
        config_path.clone(),
        serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
    )
    .expect("fixture config should load");

    let result = apply_config_operations_to_path(
        &config_path,
        serde_json::json!({ "agents": { "defaults": { "model": "fallback" } } }),
        crate::config::store::ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![crate::config::store::ConfigOperation::Replace {
                path: "agents.defaults.timezone".to_string(),
                value: serde_json::json!("Asia/Shanghai"),
            }],
        },
    )
    .expect("native config operations should persist");

    assert!(result.ok);
    assert_eq!(result.updated_fields, vec!["agents.defaults.timezone"]);
    assert_eq!(
        result.config["providers"]["openai"]["api_key_configured"],
        true
    );
    assert!(result.config["providers"]["openai"]
        .get("api_key")
        .is_none());
    let saved = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(config_path).expect("config file should save"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
    assert_eq!(saved["providers"]["openai"]["api_key"], "sk-secret");
}

#[test]
fn native_config_operations_save_to_custom_config_path() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join("portable").join("custom-config.json");
    std::fs::create_dir_all(
        config_path
            .parent()
            .expect("config path should have parent"),
    )
    .expect("config directory should create");
    std::fs::write(&config_path, r#"{"agents":{"defaults":{"model":"gpt-5"}}}"#)
        .expect("fixture config should write");
    let store = crate::config::store::ConfigStore::load(config_path.clone(), serde_json::json!({}))
        .expect("custom config should load");

    let result = apply_config_operations_to_path(
        &config_path,
        serde_json::json!({}),
        crate::config::store::ConfigOperationRequest {
            expected_revision: Some(store.revision()),
            operations: vec![crate::config::store::ConfigOperation::Replace {
                path: "agents.defaults.timezone".to_string(),
                value: serde_json::json!("Asia/Shanghai"),
            }],
        },
    )
    .expect("custom config operation should persist");

    assert!(result.ok);
    let saved = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(&config_path).expect("custom config should save"),
    )
    .expect("saved config should be JSON");
    assert_eq!(saved["agents"]["defaults"]["model"], "gpt-5");
    assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
    assert!(!fixture.root.join(".tinybot").join("config.json").exists());
}
