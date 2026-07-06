use crate::config_store::ConfigDiagnostic;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsSnapshotInput {
    pub config: Value,
    #[serde(rename = "configPath", alias = "config_path")]
    pub config_path: PathBuf,
    pub revision: String,
    pub diagnostics: Vec<ConfigDiagnostic>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsSnapshot {
    pub areas: Vec<SettingsAreaSummary>,
    pub groups: Vec<SettingsGroup>,
    #[serde(rename = "configPath", alias = "config_path")]
    pub config_path: PathBuf,
    pub revision: String,
    pub diagnostics: Vec<ConfigDiagnostic>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsAreaSummary {
    pub id: SettingsArea,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsGroup {
    pub id: String,
    pub label: String,
    pub area: SettingsArea,
    pub fields: Vec<SettingsField>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsField {
    pub id: String,
    pub label: String,
    pub path: String,
    pub scope: SettingScope,
    pub source: SettingSource,
    #[serde(rename = "valueType", alias = "value_type")]
    pub value_type: SettingValueType,
    pub editable: bool,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<SettingsSecretMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<SettingRisk>,
    #[serde(rename = "sideEffect", alias = "side_effect")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_effect: Option<SettingSideEffect>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsSecretMetadata {
    pub configured: bool,
    pub revealable: bool,
    pub copyable: bool,
    pub exportable: bool,
    pub loggable: bool,
    #[serde(rename = "displayValue", alias = "display_value")]
    pub display_value: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsArea {
    Core,
    Application,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingScope {
    Global,
    Profile,
    Workspace,
    Session,
    RunDefault,
    Project,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingSource {
    Config,
    Secret,
    SecretPresence,
    Environment,
    Runtime,
    Diagnostic,
    Computed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingValueType {
    String,
    Number,
    Boolean,
    Select,
    Json,
    Secret,
    Readonly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingRisk {
    Low,
    Sensitive,
    Dangerous,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingSideEffect {
    None,
    GatewayRestart,
    WorkspaceReload,
    AppRestart,
}

impl SettingsSnapshot {
    #[cfg(test)]
    fn field(&self, path: &str) -> Option<&SettingsField> {
        self.groups
            .iter()
            .flat_map(|group| group.fields.iter())
            .find(|field| field.path == path)
    }
}

pub fn build_settings_snapshot(input: SettingsSnapshotInput) -> SettingsSnapshot {
    let config = &input.config;
    let groups = vec![
        group(
            "general",
            "General",
            SettingsArea::Core,
            vec![
                config_field(
                    "active-profile",
                    "Active profile",
                    "agents.defaults.active_profile",
                    SettingScope::RunDefault,
                    SettingValueType::String,
                    true,
                    get_path(config, &["agents", "defaults", "active_profile"]),
                ),
                config_field(
                    "default-model",
                    "Default model",
                    "agents.defaults.model",
                    SettingScope::RunDefault,
                    SettingValueType::String,
                    true,
                    get_path(config, &["agents", "defaults", "model"]),
                ),
                config_field(
                    "timezone",
                    "Timezone",
                    "agents.defaults.timezone",
                    SettingScope::Global,
                    SettingValueType::String,
                    true,
                    get_path(config, &["agents", "defaults", "timezone"]),
                ),
                config_field(
                    "temperature",
                    "Temperature",
                    "agents.defaults.temperature",
                    SettingScope::RunDefault,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["agents", "defaults", "temperature"]),
                ),
                config_field(
                    "max-tokens",
                    "Max output tokens",
                    "agents.defaults.max_tokens",
                    SettingScope::RunDefault,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["agents", "defaults", "max_tokens"]),
                ),
                config_field(
                    "context-window-tokens",
                    "Context window budget",
                    "agents.defaults.context_window_tokens",
                    SettingScope::RunDefault,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["agents", "defaults", "context_window_tokens"]),
                ),
                config_field(
                    "max-tool-iterations",
                    "Max tool iterations",
                    "agents.defaults.max_tool_iterations",
                    SettingScope::RunDefault,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["agents", "defaults", "max_tool_iterations"]),
                ),
                config_field(
                    "reasoning-effort",
                    "Reasoning effort",
                    "agents.defaults.reasoning_effort",
                    SettingScope::RunDefault,
                    SettingValueType::String,
                    true,
                    get_path(config, &["agents", "defaults", "reasoning_effort"]),
                ),
            ],
        ),
        provider_models_group(config),
        group(
            "workspace",
            "Workspace",
            SettingsArea::Core,
            vec![
                config_field(
                    "workspace-root",
                    "Workspace root",
                    "workspace.root",
                    SettingScope::Workspace,
                    SettingValueType::String,
                    true,
                    get_path(config, &["workspace", "root"]),
                ),
                config_field(
                    "default-artifact-dir",
                    "Default artifact directory",
                    "workspace.default_artifact_dir",
                    SettingScope::Workspace,
                    SettingValueType::String,
                    true,
                    get_path(config, &["workspace", "default_artifact_dir"]),
                ),
                config_field(
                    "ignore-globs",
                    "Ignore globs",
                    "workspace.ignore_globs",
                    SettingScope::Workspace,
                    SettingValueType::Json,
                    true,
                    get_path(config, &["workspace", "ignore_globs"]),
                ),
                config_field(
                    "max-file-size-mb",
                    "Max file size",
                    "workspace.max_file_size_mb",
                    SettingScope::Workspace,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["workspace", "max_file_size_mb"]),
                ),
            ],
        ),
        mcp_servers_group(config),
        group(
            "skills",
            "Skills",
            SettingsArea::Application,
            vec![
                config_field(
                    "skills-enabled",
                    "Skills enabled",
                    "skills.enabled",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["skills", "enabled"]),
                ),
                config_field(
                    "skills-autoload",
                    "Autoload skills",
                    "skills.autoload",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["skills", "autoload"]),
                ),
                config_field(
                    "user-skills-dir",
                    "User skills directory",
                    "skills.user_skills_dir",
                    SettingScope::Global,
                    SettingValueType::String,
                    true,
                    get_path(config, &["skills", "user_skills_dir"]),
                ),
                config_field(
                    "disabled-skills",
                    "Disabled skills",
                    "skills.disabled_skills",
                    SettingScope::Global,
                    SettingValueType::Json,
                    true,
                    get_path(config, &["skills", "disabled_skills"]),
                ),
                config_field(
                    "require-approval-for-new-skill",
                    "Require approval for new skill",
                    "skills.require_approval_for_new_skill",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["skills", "require_approval_for_new_skill"]),
                ),
            ],
        ),
        group(
            "automations",
            "Automations",
            SettingsArea::Application,
            vec![
                config_field(
                    "automations-enabled",
                    "Automations enabled",
                    "automations.enabled",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["automations", "enabled"]),
                ),
                config_field(
                    "cron-enabled",
                    "Cron enabled",
                    "automations.cron_enabled",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["automations", "cron_enabled"]),
                ),
                config_field(
                    "max-concurrent-jobs",
                    "Max concurrent jobs",
                    "automations.max_concurrent_jobs",
                    SettingScope::Global,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["automations", "max_concurrent_jobs"]),
                ),
                config_field(
                    "missed-run-policy",
                    "Missed run policy",
                    "automations.missed_run_policy",
                    SettingScope::Global,
                    SettingValueType::Select,
                    true,
                    get_path(config, &["automations", "missed_run_policy"]),
                ),
                config_field(
                    "notify-on-complete",
                    "Notify on complete",
                    "automations.notify_on_complete",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["automations", "notify_on_complete"]),
                ),
                config_field(
                    "notify-on-failure",
                    "Notify on failure",
                    "automations.notify_on_failure",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["automations", "notify_on_failure"]),
                ),
            ],
        ),
        group(
            "gateway-runtime",
            "Gateway & Runtime",
            SettingsArea::System,
            vec![
                readonly_field(
                    "gateway-host",
                    "Gateway host",
                    "gateway.host",
                    SettingScope::Global,
                    SettingSource::Computed,
                    Value::String("127.0.0.1".to_string()),
                )
                .with_side_effect(SettingSideEffect::GatewayRestart),
                config_field(
                    "gateway-port",
                    "Gateway port",
                    "gateway.port",
                    SettingScope::Global,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["gateway", "port"]).or_else(|| Some(Value::from(18790))),
                )
                .with_side_effect(SettingSideEffect::GatewayRestart),
                readonly_field(
                    "gateway-http-base-url",
                    "Gateway HTTP base URL",
                    "gateway.http_base_url",
                    SettingScope::Session,
                    SettingSource::Computed,
                    Value::String(format!(
                        "http://127.0.0.1:{}",
                        get_path(config, &["gateway", "port"])
                            .and_then(|value| value.as_i64().map(|port| port.to_string()))
                            .unwrap_or_else(|| "18790".to_string())
                    )),
                ),
                readonly_field(
                    "gateway-ws-url",
                    "Gateway WebSocket URL",
                    "gateway.ws_url",
                    SettingScope::Session,
                    SettingSource::Computed,
                    Value::String(format!(
                        "ws://127.0.0.1:{}/ws",
                        get_path(config, &["gateway", "port"])
                            .and_then(|value| value.as_i64().map(|port| port.to_string()))
                            .unwrap_or_else(|| "18790".to_string())
                    )),
                ),
                config_field(
                    "gateway-heartbeat-enabled",
                    "Gateway heartbeat enabled",
                    "gateway.heartbeat.enabled",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["gateway", "heartbeat", "enabled"]),
                ),
                config_field(
                    "gateway-heartbeat-interval",
                    "Gateway heartbeat interval",
                    "gateway.heartbeat.interval_s",
                    SettingScope::Global,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["gateway", "heartbeat", "interval_s"]),
                ),
                readonly_field(
                    "config-path",
                    "Config path",
                    "runtime.config_path",
                    SettingScope::Session,
                    SettingSource::Runtime,
                    Value::String(input.config_path.display().to_string()),
                ),
                readonly_field(
                    "config-revision",
                    "Config revision",
                    "runtime.config_revision",
                    SettingScope::Session,
                    SettingSource::Runtime,
                    Value::String(input.revision.clone()),
                ),
            ],
        ),
        group(
            "security-approvals",
            "Security & Approvals",
            SettingsArea::System,
            vec![
                config_field(
                    "restrict-to-workspace",
                    "Restrict to workspace",
                    "tools.restrict_to_workspace",
                    SettingScope::Workspace,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["tools", "restrict_to_workspace"]),
                )
                .with_risk(SettingRisk::Sensitive),
                config_field(
                    "allowed-read-roots",
                    "Allowed read roots",
                    "workspace.allowed_read_roots",
                    SettingScope::Workspace,
                    SettingValueType::Json,
                    true,
                    get_path(config, &["workspace", "allowed_read_roots"]),
                )
                .with_risk(SettingRisk::Sensitive),
                config_field(
                    "allowed-write-roots",
                    "Allowed write roots",
                    "workspace.allowed_write_roots",
                    SettingScope::Workspace,
                    SettingValueType::Json,
                    true,
                    get_path(config, &["workspace", "allowed_write_roots"]),
                )
                .with_risk(SettingRisk::Dangerous),
                config_field(
                    "snapshot-before-write",
                    "Snapshot before write",
                    "workspace.snapshot_before_write",
                    SettingScope::Workspace,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["workspace", "snapshot_before_write"]),
                ),
                config_field(
                    "mcp-default-approval-policy",
                    "Default MCP approval policy",
                    "mcp.default_approval_policy",
                    SettingScope::Workspace,
                    SettingValueType::Select,
                    true,
                    get_path(config, &["mcp", "default_approval_policy"]),
                )
                .with_risk(SettingRisk::Sensitive),
                config_field(
                    "approval-delete",
                    "Require approval for delete",
                    "workspace.approval.delete",
                    SettingScope::Workspace,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["workspace", "approval", "delete"]),
                )
                .with_risk(SettingRisk::Dangerous),
                config_field(
                    "approval-overwrite",
                    "Require approval for overwrite",
                    "workspace.approval.overwrite",
                    SettingScope::Workspace,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["workspace", "approval", "overwrite"]),
                )
                .with_risk(SettingRisk::Sensitive),
                config_field(
                    "external-network-approval",
                    "Require approval for external network",
                    "network.require_approval_for_external_network",
                    SettingScope::Workspace,
                    SettingValueType::Boolean,
                    true,
                    get_path(
                        config,
                        &["network", "require_approval_for_external_network"],
                    ),
                )
                .with_risk(SettingRisk::Sensitive),
            ],
        ),
        group(
            "logs-diagnostics",
            "Logs & Diagnostics",
            SettingsArea::System,
            vec![
                config_field(
                    "log-level",
                    "Log level",
                    "diagnostics.log_level",
                    SettingScope::Global,
                    SettingValueType::Select,
                    true,
                    get_path(config, &["diagnostics", "log_level"]),
                ),
                config_field(
                    "retain-days",
                    "Retain days",
                    "diagnostics.retain_days",
                    SettingScope::Global,
                    SettingValueType::Number,
                    true,
                    get_path(config, &["diagnostics", "retain_days"]),
                ),
                config_field(
                    "redact-secrets",
                    "Redact secrets",
                    "diagnostics.redact_secrets",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["diagnostics", "redact_secrets"]),
                )
                .with_risk(SettingRisk::Sensitive),
                config_field(
                    "export-bundle-enabled",
                    "Export bundle enabled",
                    "diagnostics.export_bundle_enabled",
                    SettingScope::Global,
                    SettingValueType::Boolean,
                    true,
                    get_path(config, &["diagnostics", "export_bundle_enabled"]),
                ),
            ],
        ),
        group(
            "expert-config",
            "Expert / Config",
            SettingsArea::System,
            vec![
                readonly_field(
                    "effective-public-config",
                    "Effective public config",
                    "expert.effective_public_config",
                    SettingScope::Session,
                    SettingSource::Computed,
                    public_config_snapshot(config),
                ),
                readonly_field(
                    "expert-config-path",
                    "Config path",
                    "expert.config_path",
                    SettingScope::Session,
                    SettingSource::Runtime,
                    Value::String(input.config_path.display().to_string()),
                ),
                readonly_field(
                    "expert-config-revision",
                    "Config revision",
                    "expert.config_revision",
                    SettingScope::Session,
                    SettingSource::Runtime,
                    Value::String(input.revision.clone()),
                ),
            ],
        ),
    ];

    SettingsSnapshot {
        areas: vec![
            SettingsAreaSummary {
                id: SettingsArea::Core,
                label: "Core".to_string(),
            },
            SettingsAreaSummary {
                id: SettingsArea::Application,
                label: "Application".to_string(),
            },
            SettingsAreaSummary {
                id: SettingsArea::System,
                label: "System".to_string(),
            },
        ],
        groups,
        config_path: input.config_path,
        revision: input.revision,
        diagnostics: input.diagnostics,
    }
}

fn provider_models_group(config: &Value) -> SettingsGroup {
    let mut fields = vec![
        config_field(
            "active-profile",
            "Active profile",
            "agents.defaults.active_profile",
            SettingScope::RunDefault,
            SettingValueType::String,
            true,
            get_path(config, &["agents", "defaults", "active_profile"]),
        ),
        config_field(
            "agent-default-model",
            "Agent default model",
            "agents.defaults.model",
            SettingScope::RunDefault,
            SettingValueType::String,
            true,
            get_path(config, &["agents", "defaults", "model"]),
        ),
    ];

    if let Some(profiles) =
        get_path(config, &["providers", "profiles"]).and_then(|value| value.as_object().cloned())
    {
        for (profile_id, profile) in profiles {
            let prefix = format!("providers.profiles.{profile_id}");
            fields.push(config_field(
                &format!("provider-profile-{profile_id}-display-name"),
                "Profile display name",
                &format!("{prefix}.display_name"),
                SettingScope::Profile,
                SettingValueType::String,
                true,
                profile.get("display_name").cloned(),
            ));
            fields.push(config_field(
                &format!("provider-profile-{profile_id}-provider"),
                "Provider type",
                &format!("{prefix}.provider"),
                SettingScope::Profile,
                SettingValueType::Select,
                true,
                profile.get("provider").cloned(),
            ));
            fields.push(config_field(
                &format!("provider-profile-{profile_id}-enabled"),
                "Profile enabled",
                &format!("{prefix}.enabled"),
                SettingScope::Profile,
                SettingValueType::Boolean,
                true,
                profile.get("enabled").cloned(),
            ));
            fields.push(secret_field(
                &format!("provider-profile-{profile_id}-api-key"),
                "API key",
                &format!("{prefix}.api_key"),
                SettingScope::Profile,
                sensitive_value_configured(profile.get("api_key")),
            ));
            fields.push(config_field(
                &format!("provider-profile-{profile_id}-api-base"),
                "API base",
                &format!("{prefix}.api_base"),
                SettingScope::Profile,
                SettingValueType::String,
                true,
                profile.get("api_base").cloned(),
            ));
            fields.push(config_field(
                &format!("provider-profile-{profile_id}-request-timeout"),
                "Request timeout",
                &format!("{prefix}.request_timeout_ms"),
                SettingScope::Profile,
                SettingValueType::Number,
                true,
                profile.get("request_timeout_ms").cloned(),
            ));
            fields.push(config_field(
                &format!("provider-profile-{profile_id}-models"),
                "Manual models",
                &format!("{prefix}.models"),
                SettingScope::Profile,
                SettingValueType::Json,
                true,
                profile.get("models").cloned(),
            ));
            fields.push(config_field(
                &format!("provider-profile-{profile_id}-default-model"),
                "Profile default model",
                &format!("{prefix}.default_model"),
                SettingScope::Profile,
                SettingValueType::String,
                true,
                profile.get("default_model").cloned(),
            ));
        }
    }

    group(
        "provider-models",
        "Provider & Models",
        SettingsArea::Core,
        fields,
    )
}

fn mcp_servers_group(config: &Value) -> SettingsGroup {
    let mut fields = Vec::new();
    if let Some(servers) =
        get_path(config, &["mcp", "servers"]).and_then(|value| value.as_object().cloned())
    {
        for (server_id, server) in servers {
            let prefix = format!("mcp.servers.{server_id}");
            fields.push(config_field(
                &format!("mcp-{server_id}-enabled"),
                "Server enabled",
                &format!("{prefix}.enabled"),
                SettingScope::Workspace,
                SettingValueType::Boolean,
                true,
                server.get("enabled").cloned(),
            ));
            fields.push(config_field(
                &format!("mcp-{server_id}-transport"),
                "Transport",
                &format!("{prefix}.transport"),
                SettingScope::Workspace,
                SettingValueType::Select,
                true,
                server.get("transport").cloned(),
            ));
            fields.push(config_field(
                &format!("mcp-{server_id}-command"),
                "Command",
                &format!("{prefix}.command"),
                SettingScope::Workspace,
                SettingValueType::String,
                true,
                server.get("command").cloned(),
            ));
            fields.push(config_field(
                &format!("mcp-{server_id}-args"),
                "Args",
                &format!("{prefix}.args"),
                SettingScope::Workspace,
                SettingValueType::Json,
                true,
                server.get("args").cloned(),
            ));
            fields.push(config_field(
                &format!("mcp-{server_id}-cwd"),
                "Working directory",
                &format!("{prefix}.cwd"),
                SettingScope::Workspace,
                SettingValueType::String,
                true,
                server.get("cwd").cloned(),
            ));
            fields.push(config_field(
                &format!("mcp-{server_id}-timeout"),
                "Timeout seconds",
                &format!("{prefix}.timeout_seconds"),
                SettingScope::Workspace,
                SettingValueType::Number,
                true,
                server.get("timeout_seconds").cloned(),
            ));
            fields.push(
                config_field(
                    &format!("mcp-{server_id}-approval"),
                    "Approval policy",
                    &format!("{prefix}.approval"),
                    SettingScope::Workspace,
                    SettingValueType::Select,
                    true,
                    server.get("approval").cloned(),
                )
                .with_risk(SettingRisk::Sensitive),
            );
            if let Some(env) = server.get("env").and_then(Value::as_object) {
                for (env_key, env_value) in env {
                    let env_path = format!("{prefix}.env.{env_key}");
                    if is_sensitive_key(env_key) {
                        fields.push(secret_field(
                            &format!("mcp-{server_id}-env-{env_key}"),
                            env_key,
                            &env_path,
                            SettingScope::Workspace,
                            sensitive_value_configured(Some(env_value)),
                        ));
                    } else {
                        fields.push(config_field(
                            &format!("mcp-{server_id}-env-{env_key}"),
                            env_key,
                            &env_path,
                            SettingScope::Workspace,
                            SettingValueType::String,
                            true,
                            Some(env_value.clone()),
                        ));
                    }
                }
            }
            fields.push(readonly_field(
                &format!("mcp-{server_id}-status"),
                "Connection status",
                &format!("{prefix}.status"),
                SettingScope::Session,
                SettingSource::Runtime,
                Value::String("unknown".to_string()),
            ));
            fields.push(readonly_field(
                &format!("mcp-{server_id}-tool-count"),
                "Discovered tool count",
                &format!("{prefix}.tool_count"),
                SettingScope::Session,
                SettingSource::Runtime,
                Value::from(0),
            ));
        }
    }
    group(
        "mcp-servers",
        "MCP Servers",
        SettingsArea::Application,
        fields,
    )
}

fn group(id: &str, label: &str, area: SettingsArea, fields: Vec<SettingsField>) -> SettingsGroup {
    SettingsGroup {
        id: id.to_string(),
        label: label.to_string(),
        area,
        fields,
    }
}

fn config_field(
    id: &str,
    label: &str,
    path: &str,
    scope: SettingScope,
    value_type: SettingValueType,
    editable: bool,
    value: Option<Value>,
) -> SettingsField {
    SettingsField {
        id: id.to_string(),
        label: label.to_string(),
        path: path.to_string(),
        scope,
        source: SettingSource::Config,
        value_type,
        editable,
        value: value.unwrap_or(Value::Null),
        secret: None,
        risk: None,
        side_effect: Some(SettingSideEffect::None),
    }
}

fn readonly_field(
    id: &str,
    label: &str,
    path: &str,
    scope: SettingScope,
    source: SettingSource,
    value: Value,
) -> SettingsField {
    SettingsField {
        id: id.to_string(),
        label: label.to_string(),
        path: path.to_string(),
        scope,
        source,
        value_type: SettingValueType::Readonly,
        editable: false,
        value,
        secret: None,
        risk: None,
        side_effect: None,
    }
}

fn secret_field(
    id: &str,
    label: &str,
    path: &str,
    scope: SettingScope,
    configured: bool,
) -> SettingsField {
    SettingsField {
        id: id.to_string(),
        label: label.to_string(),
        path: path.to_string(),
        scope,
        source: SettingSource::Secret,
        value_type: SettingValueType::Secret,
        editable: true,
        value: Value::Null,
        secret: Some(SettingsSecretMetadata {
            configured,
            revealable: true,
            copyable: true,
            exportable: false,
            loggable: false,
            display_value: if configured {
                "••••••••".to_string()
            } else {
                String::new()
            },
        }),
        risk: Some(SettingRisk::Sensitive),
        side_effect: Some(SettingSideEffect::None),
    }
}

impl SettingsField {
    fn with_risk(mut self, risk: SettingRisk) -> Self {
        self.risk = Some(risk);
        self
    }

    fn with_side_effect(mut self, side_effect: SettingSideEffect) -> Self {
        self.side_effect = Some(side_effect);
        self
    }
}

fn get_path(value: &Value, path: &[&str]) -> Option<Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current.clone())
}

fn public_config_snapshot(snapshot: &Value) -> Value {
    omit_sensitive_descendants(snapshot)
}

fn omit_sensitive_descendants(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut public = Map::new();
            let mut api_key_configured = false;
            for (key, child) in object {
                if is_sensitive_key(key) {
                    if is_api_key_key(key) && sensitive_value_configured(Some(child)) {
                        api_key_configured = true;
                    }
                    continue;
                }
                public.insert(key.clone(), omit_sensitive_descendants(child));
            }
            if api_key_configured {
                public.insert("api_key_configured".to_string(), Value::Bool(true));
            }
            Value::Object(public)
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(omit_sensitive_descendants).collect())
        }
        _ => value.clone(),
    }
}

fn sensitive_value_configured(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = normalize_key(key);
    let parts: Vec<&str> = normalized
        .split('_')
        .filter(|part| !part.is_empty())
        .collect();
    let Some(last) = parts.last().copied() else {
        return false;
    };
    matches!(
        last,
        "token" | "secret" | "password" | "authorization" | "credentials"
    ) || is_api_key_key(key)
}

fn is_api_key_key(key: &str) -> bool {
    let normalized = normalize_key(key);
    normalized == "apikey" || normalized == "api_key" || normalized.ends_with("_api_key")
}

fn normalize_key(key: &str) -> String {
    let mut normalized = String::new();
    let mut previous_was_lower_or_digit = false;
    for character in key.replace('-', "_").chars() {
        if character.is_ascii_uppercase() && previous_was_lower_or_digit {
            normalized.push('_');
        }
        previous_was_lower_or_digit = character.is_ascii_lowercase() || character.is_ascii_digit();
        normalized.push(character.to_ascii_lowercase());
    }
    normalized
}

#[cfg(test)]
mod tests {
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
        assert!(!group_ids.contains(&"knowledge"));
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
            .field("providers.profiles.openai-work.api_key")
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
                    "timezone": "Asia/Singapore"
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
            "knowledge": {
                "enabled": true
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
}
