use super::*;
use serde_json::json;
use std::path::PathBuf;

#[test]
fn snapshot_contains_only_first_version_settings_groups() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let group_ids: Vec<&str> = snapshot
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();

    assert_eq!(
        group_ids,
        vec![
            "general",
            "provider-models",
            "workspace",
            "mcp-servers",
            "skills",
            "automations",
            "runtime",
            "logs-diagnostics",
            "expert-config",
        ]
    );
    assert!(!group_ids.contains(&"channels"));
}

#[test]
fn provider_api_key_is_secret_modeled_and_revealable() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let field = snapshot
        .field("providers.profiles.openai-work.apiKey")
        .expect("provider api key field should exist");

    assert_eq!(field.value_type, SettingValueType::Secret);
    assert_eq!(field.source, SettingSource::Secret);
    assert_eq!(field.scope, SettingScope::Profile);
    assert!(field.editable);
    assert!(field.secret.as_ref().expect("secret metadata").configured);
    assert!(field.secret.as_ref().expect("secret metadata").revealable);
    assert_eq!(field.value, json!(null));
}

#[test]
fn provider_api_mode_is_exposed_with_chat_completions_as_the_default() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let field = snapshot
        .field("providers.profiles.openai-work.apiMode")
        .expect("provider API mode field should exist");

    assert_eq!(field.value_type, SettingValueType::Select);
    assert_eq!(field.scope, SettingScope::Profile);
    assert_eq!(field.value, json!("chat_completions"));
}

#[test]
fn memory_model_override_is_exposed_as_an_editable_profile_model_pair() {
    let mut config = config_fixture();
    config["memory"] = json!({
        "activeProfile": "openai-work",
        "model": "gpt-5-mini"
    });
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config,
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let profile = snapshot
        .field("memory.activeProfile")
        .expect("Memory profile field should exist");
    let model = snapshot
        .field("memory.model")
        .expect("Memory model field should exist");

    assert!(profile.editable);
    assert!(model.editable);
    assert_eq!(profile.scope, SettingScope::RunDefault);
    assert_eq!(model.scope, SettingScope::RunDefault);
    assert_eq!(profile.value, json!("openai-work"));
    assert_eq!(model.value, json!("gpt-5-mini"));
}

#[test]
fn provider_model_enablement_and_capabilities_are_exposed_as_profile_json() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    for path in [
        "providers.profiles.openai-work.enabledModels",
        "providers.profiles.openai-work.modelCapabilities",
    ] {
        let field = snapshot
            .field(path)
            .expect("model profile field should exist");
        assert_eq!(field.value_type, SettingValueType::Json);
        assert_eq!(field.scope, SettingScope::Profile);
        assert!(field.editable);
    }
}

#[test]
fn runtime_group_ignores_legacy_gateway_config_fields() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    assert!(snapshot.field("gateway.host").is_none());
    assert!(snapshot.field("gateway.port").is_none());
    assert!(snapshot.field("gateway.http_base_url").is_none());
    assert!(snapshot.field("gateway.ws_url").is_none());
    assert!(snapshot.field("gateway.heartbeat.enabled").is_none());
    assert!(snapshot.field("gateway.heartbeat.interval_s").is_none());
    assert!(snapshot.field("runtime.config_path").is_some());
    assert!(snapshot.field("runtime.config_revision").is_some());
}

#[test]
fn mcp_runtime_statuses_replace_static_settings_placeholders() {
    let mut snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });
    apply_mcp_runtime_statuses(
        &mut snapshot,
        &BTreeMap::from([(
            "github".to_string(),
            json!({
                "state": "ready",
                "transport": "stdio",
                "toolCount": 3,
                "lastError": null
            }),
        )]),
    );

    assert_eq!(
        snapshot
            .field("tools.mcpServers.github.status")
            .expect("MCP status field should exist")
            .value,
        json!("ready")
    );
    assert_eq!(
        snapshot
            .field("tools.mcpServers.github.tool_count")
            .expect("MCP tool-count field should exist")
            .value,
        json!(3)
    );
}

#[test]
fn mcp_http_settings_expose_endpoint_and_environment_references_without_secret_values() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: json!({
            "tools": { "mcp_servers": { "docs": {
                "enabled": true,
                "transport": "http",
                "url": "https://example.com/mcp",
                "bearer_token_env_var": "DOCS_TOKEN",
                "http_headers": {
                    "Authorization": "Bearer secret",
                    "X-Tenant": "tinybot"
                },
                "env_http_headers": { "X-Trace": "TRACE_HEADER" }
            }}}
        }),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    assert_eq!(
        snapshot
            .field("tools.mcpServers.docs.url")
            .expect("HTTP endpoint field should exist")
            .value,
        json!("https://example.com/mcp")
    );
    assert_eq!(
        snapshot
            .field("tools.mcpServers.docs.bearer_token_env_var")
            .expect("bearer environment field should exist")
            .value,
        json!("DOCS_TOKEN")
    );
    let authorization = snapshot
        .field("tools.mcpServers.docs.http_headers.Authorization")
        .expect("authorization header should exist as a secret field");
    assert_eq!(authorization.value, Value::Null);
    assert_eq!(authorization.source, SettingSource::Secret);
    assert!(authorization
        .secret
        .as_ref()
        .is_some_and(|secret| secret.configured));
    assert_eq!(
        snapshot
            .field("tools.mcpServers.docs.env_http_headers")
            .expect("environment-backed headers field should exist")
            .value,
        json!({ "X-Trace": "TRACE_HEADER" })
    );
}

#[test]
fn mcp_http_settings_expose_direct_bearer_token_as_a_secret_field() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: json!({
            "tools": { "mcpServers": { "docs": {
                "enabled": true,
                "transport": "streamable-http",
                "url": "https://example.com/mcp",
                "bearerToken": "direct-secret"
            }}}
        }),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let bearer_token = snapshot
        .field("tools.mcpServers.docs.bearerToken")
        .expect("direct bearer token should exist as a secret field");
    assert_eq!(bearer_token.value, Value::Null);
    assert_eq!(bearer_token.source, SettingSource::Secret);
    assert!(bearer_token
        .secret
        .as_ref()
        .is_some_and(|secret| secret.configured));
}

#[test]
fn mcp_stdio_settings_expose_environment_reference_names() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: json!({
            "tools": { "mcp_servers": { "local": {
                "enabled": true,
                "transport": "stdio",
                "command": "node",
                "env_var_refs": { "PRIVATE_TOKEN": "TINYBOT_PRIVATE_TOKEN" }
            }}}
        }),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    assert_eq!(
        snapshot
            .field("tools.mcpServers.local.env_var_refs")
            .expect("stdio environment references field should exist")
            .value,
        json!({ "PRIVATE_TOKEN": "TINYBOT_PRIVATE_TOKEN" })
    );
}

#[test]
fn max_tool_iterations_projects_runtime_key_with_legacy_aliases() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let field = snapshot
        .field("agents.defaults.maxIterations")
        .expect("max tool iterations field should use runtime key");

    assert_eq!(field.value_type, SettingValueType::Number);
    assert_eq!(field.value, json!(12));
}

#[test]
fn agent_defaults_do_not_expose_legacy_reasoning_effort() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: json!({
            "agents": { "defaults": { "reasoningEffort": "medium" } }
        }),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    assert!(snapshot.field("agents.defaults.reasoningEffort").is_none());
}

#[test]
fn expert_config_exposes_redacted_effective_config() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let public_config = snapshot
        .field("expert.effective_public_config")
        .expect("effective public config field should exist");

    assert_eq!(public_config.value_type, SettingValueType::Readonly);
    assert!(!public_config.editable);
    assert_eq!(
        public_config.value["providers"]["profiles"]["openai-work"]["api_key_configured"],
        json!(true)
    );
    assert!(public_config.value["providers"]["profiles"]["openai-work"]
        .get("api_key")
        .is_none());
}

fn config_fixture() -> serde_json::Value {
    json!({
        "agents": {
            "defaults": {
                "active_profile": "openai-work",
                "model": "gpt-5",
                "timezone": "Asia/Singapore",
                "maxToolIterations": 12
            }
        },
        "providers": {
            "profiles": {
                "openai-work": {
                    "provider": "openai",
                    "display_name": "OpenAI Work",
                    "enabled": true,
                    "api_key": "sk-secret",
                    "api_base": "https://api.openai.com/v1",
                    "request_timeout_ms": 120000,
                    "models": ["gpt-5", "gpt-5-mini"],
                    "default_model": "gpt-5-mini"
                }
            }
        },
        "workspace": {
            "root": "D:/Code/py/tinybot",
            "default_artifact_dir": "artifacts",
            "ignore_globs": ["node_modules/**"],
            "max_file_size_mb": 20
        },
        "mcp": {
            "servers": {
                "github": {
                    "enabled": false,
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-github"],
                    "env": {
                        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp-secret"
                    }
                }
            }
        },
        "gateway": {
            "host": "0.0.0.0",
            "port": 18791,
            "heartbeat": {
                "enabled": true,
                "interval_s": 1800
            }
        },
        "channels": {
            "send_progress": true
        }
    })
}
