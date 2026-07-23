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
            "gateway-runtime",
            "security-approvals",
            "logs-diagnostics",
            "expert-config",
        ]
    );
    assert!(!group_ids.contains(&"memory-experience"));
    assert!(!group_ids.contains(&"cowork-tasks"));
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
fn gateway_host_is_readonly_but_port_is_editable() {
    let snapshot = build_settings_snapshot(SettingsSnapshotInput {
        config: config_fixture(),
        config_path: PathBuf::from("C:/Users/example/.tinybot/config.json"),
        revision: "rev-1".to_string(),
        diagnostics: Vec::new(),
    });

    let host = snapshot
        .field("gateway.host")
        .expect("gateway host field should exist");
    let port = snapshot
        .field("gateway.port")
        .expect("gateway port field should exist");

    assert!(!host.editable);
    assert_eq!(host.source, SettingSource::Computed);
    assert_eq!(host.value, json!("127.0.0.1"));

    assert!(port.editable);
    assert_eq!(port.source, SettingSource::Config);
    assert_eq!(port.value, json!(18791));
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
                    },
                    "approval": "always"
                }
            }
        },
        "gateway": {
            "host": "0.0.0.0",
            "port": 18791
        },
        "memory": {
            "enabled": true
        },
        "cowork": {
            "enabled": true
        },
        "channels": {
            "send_progress": true
        }
    })
}
