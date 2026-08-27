use async_openai::{config::OpenAIConfig, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

const DEFAULT_AGENT_MODEL: &str = "deepseek-v4-pro";
const DEFAULT_PROVIDER_TIMEOUT_MS: u64 = 120_000;
const OPENAI_API_MODES: &[&str] = &["chat_completions", "responses"];
const CHAT_COMPLETIONS_ONLY: &[&str] = &["chat_completions"];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProviderCatalogEntry {
    pub id: &'static str,
    pub display_name: &'static str,
    pub aliases: &'static [&'static str],
    pub categories: &'static [&'static str],
    pub default_api_base: Option<&'static str>,
    pub api_key_env_vars: &'static [&'static str],
    pub api_base_env_vars: &'static [&'static str],
    pub supports_model_discovery: bool,
    pub curated_model_ids: &'static [&'static str],
    pub model_prefixes: &'static [&'static str],
    pub capabilities: &'static [&'static str],
    pub supported_api_modes: &'static [&'static str],
    pub backend: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeProviderProfile {
    pub provider_id: String,
    pub display_name: String,
    pub is_custom: bool,
    pub api_base: Option<String>,
    pub api_key: Option<String>,
    pub api_key_configured: bool,
    pub models: Vec<String>,
    pub model_context_windows: BTreeMap<String, i64>,
    pub supports_model_discovery: bool,
    pub supports_reasoning_effort: bool,
    pub capabilities: Value,
    pub request_timeout_ms: u64,
    pub stream_idle_timeout_ms: u64,
    pub api_mode: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeProviderApiMode {
    ChatCompletions,
    Responses,
}

impl NativeProviderProfile {
    pub fn parsed_api_mode(&self) -> Result<NativeProviderApiMode, String> {
        NativeProviderApiMode::parse(&self.api_mode).map_err(|unsupported| {
            format!(
                "provider `{}` has unsupported api_mode `{unsupported}`",
                self.provider_id
            )
        })
    }

    pub fn context_window_tokens_for_model(&self, model: &str) -> Option<i64> {
        self.model_context_windows
            .get(&model.trim().to_ascii_lowercase())
            .copied()
    }

    pub fn require_api_mode(&self, api_mode: NativeProviderApiMode) -> Result<(), String> {
        let supported_api_modes = catalog_entry_by_id(&self.provider_id)
            .map(|entry| entry.supported_api_modes)
            .unwrap_or(OPENAI_API_MODES);
        if supported_api_modes.contains(&api_mode.as_str()) {
            return Ok(());
        }
        Err(format!(
            "provider `{}` does not support api_mode `{}`; supported modes: {}",
            self.provider_id,
            api_mode.as_str(),
            supported_api_modes.join(", ")
        ))
    }
}

impl NativeProviderApiMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "chat" | "chat_completions" | "chat-completions" => Ok(Self::ChatCompletions),
            "responses" => Ok(Self::Responses),
            unsupported => Err(unsupported.to_string()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat_completions",
            Self::Responses => "responses",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProviderModelsRequest {
    #[serde(alias = "provider", alias = "provider_id")]
    pub provider_id: Option<String>,
    #[serde(alias = "profile", alias = "profile_id")]
    pub profile_name: Option<String>,
    pub model: Option<String>,
    #[serde(alias = "api_key")]
    pub api_key: Option<String>,
    #[serde(alias = "api_base")]
    pub api_base: Option<String>,
    #[serde(alias = "manual_models", alias = "manualModelIds")]
    pub manual_models: Option<Value>,
    #[serde(alias = "refresh", alias = "refresh_live")]
    pub refresh_live: Option<bool>,
    #[serde(default)]
    pub live_model_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProviderModelList {
    pub ok: bool,
    pub models: Vec<String>,
    pub model_sources: BTreeMap<String, Vec<String>>,
    pub sources: BTreeMap<String, usize>,
    pub warning: Option<String>,
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct ProviderModelDiscoveryResponse {
    data: Vec<ProviderModelDiscoveryItem>,
}

#[derive(Deserialize)]
struct ProviderModelDiscoveryItem {
    id: String,
}

const PROVIDER_CATALOG: &[NativeProviderCatalogEntry] = &[
    catalog_entry(
        "openai",
        "OpenAI",
        &["gpt", "chatgpt"],
        &["built_in"],
        Some("https://api.openai.com/v1"),
        &["OPENAI_API_KEY"],
        &["OPENAI_BASE_URL"],
        &["gpt-4.1"],
        &["gpt", "o1", "o3", "o4"],
        &[],
    ),
    catalog_entry(
        "deepseek",
        "DeepSeek",
        &["deep seek"],
        &["built_in"],
        Some("https://api.deepseek.com"),
        &["DEEPSEEK_API_KEY"],
        &["DEEPSEEK_BASE_URL"],
        &["deepseek-v4-pro", "deepseek-v4-flash"],
        &["deepseek"],
        &["reasoning"],
    ),
    catalog_entry_with_discovery(
        "dashscope",
        "DashScope",
        &["dash scope", "model studio", "qwen"],
        &["built_in"],
        Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        &["DASHSCOPE_API_KEY"],
        &["DASHSCOPE_BASE_URL"],
        true,
        &["qwen-plus", "qwen-max", "qwen-turbo"],
        &["qwen"],
        &[],
    ),
    catalog_entry_with_options(
        "zai",
        "Z.ai",
        &["z.ai", "zhipu", "bigmodel"],
        &["built_in"],
        Some("https://open.bigmodel.cn/api/paas/v4"),
        &["ZAI_API_KEY"],
        &["ZAI_BASE_URL"],
        false,
        &["glm-5.3", "glm-5.3-flash", "glm-5.2"],
        &["glm"],
        &[],
        CHAT_COMPLETIONS_ONLY,
    ),
];

const fn catalog_entry(
    id: &'static str,
    display_name: &'static str,
    aliases: &'static [&'static str],
    categories: &'static [&'static str],
    default_api_base: Option<&'static str>,
    api_key_env_vars: &'static [&'static str],
    api_base_env_vars: &'static [&'static str],
    curated_model_ids: &'static [&'static str],
    model_prefixes: &'static [&'static str],
    capabilities: &'static [&'static str],
) -> NativeProviderCatalogEntry {
    catalog_entry_with_discovery(
        id,
        display_name,
        aliases,
        categories,
        default_api_base,
        api_key_env_vars,
        api_base_env_vars,
        true,
        curated_model_ids,
        model_prefixes,
        capabilities,
    )
}

const fn catalog_entry_with_discovery(
    id: &'static str,
    display_name: &'static str,
    aliases: &'static [&'static str],
    categories: &'static [&'static str],
    default_api_base: Option<&'static str>,
    api_key_env_vars: &'static [&'static str],
    api_base_env_vars: &'static [&'static str],
    supports_model_discovery: bool,
    curated_model_ids: &'static [&'static str],
    model_prefixes: &'static [&'static str],
    capabilities: &'static [&'static str],
) -> NativeProviderCatalogEntry {
    catalog_entry_with_options(
        id,
        display_name,
        aliases,
        categories,
        default_api_base,
        api_key_env_vars,
        api_base_env_vars,
        supports_model_discovery,
        curated_model_ids,
        model_prefixes,
        capabilities,
        OPENAI_API_MODES,
    )
}

#[allow(clippy::too_many_arguments)]
const fn catalog_entry_with_options(
    id: &'static str,
    display_name: &'static str,
    aliases: &'static [&'static str],
    categories: &'static [&'static str],
    default_api_base: Option<&'static str>,
    api_key_env_vars: &'static [&'static str],
    api_base_env_vars: &'static [&'static str],
    supports_model_discovery: bool,
    curated_model_ids: &'static [&'static str],
    model_prefixes: &'static [&'static str],
    capabilities: &'static [&'static str],
    supported_api_modes: &'static [&'static str],
) -> NativeProviderCatalogEntry {
    NativeProviderCatalogEntry {
        id,
        display_name,
        aliases,
        categories,
        default_api_base,
        api_key_env_vars,
        api_base_env_vars,
        supports_model_discovery,
        curated_model_ids,
        model_prefixes,
        capabilities,
        supported_api_modes,
        backend: "openai",
    }
}

pub fn provider_catalog_body(config: &Value) -> Value {
    let providers = PROVIDER_CATALOG
        .iter()
        .map(|entry| {
            let profile = resolve_provider_profile(config, Some(entry.id), None);
            serde_json::json!({
                "id": entry.id,
                "displayName": entry.display_name,
                "display_name": entry.display_name,
                "aliases": entry.aliases,
                "categories": entry.categories,
                "capabilities": entry.capabilities,
                "defaultApiBase": entry.default_api_base,
                "default_api_base": entry.default_api_base,
                "apiKeyEnvVars": entry.api_key_env_vars,
                "api_key_env_vars": entry.api_key_env_vars,
                "apiBaseEnvVars": entry.api_base_env_vars,
                "api_base_env_vars": entry.api_base_env_vars,
                "supportsModelDiscovery": entry.supports_model_discovery,
                "supports_model_discovery": entry.supports_model_discovery,
                "curatedModelIds": entry.curated_model_ids,
                "curated_model_ids": entry.curated_model_ids,
                "modelPrefixes": entry.model_prefixes,
                "model_prefixes": entry.model_prefixes,
                "supportedApiModes": entry.supported_api_modes,
                "supported_api_modes": entry.supported_api_modes,
                "backend": entry.backend,
                "configured": profile.as_ref().is_some_and(|profile| profile.api_key_configured || profile.api_base.is_some()),
                "api_key_configured": profile.as_ref().is_some_and(|profile| profile.api_key_configured),
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "ok": true,
        "providers": providers,
        "items": providers,
        "source": "rust",
    })
}

pub async fn provider_models_body(config: &Value, body: &Value) -> Value {
    if !body.is_object() {
        return serde_json::json!({ "ok": false, "error": "payload must be a dict", "models": [] });
    }
    let request = match serde_json::from_value::<NativeProviderModelsRequest>(body.clone()) {
        Ok(request) => request,
        Err(error) => {
            return serde_json::json!({
                "ok": false,
                "error": format!("invalid provider model request: {error}"),
                "models": [],
            });
        }
    };
    match list_provider_models(config, request).await {
        Ok(result) => serde_json::to_value(result).unwrap_or_else(|_| {
            serde_json::json!({ "ok": false, "error": "failed to serialize provider models", "models": [] })
        }),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": error,
            "models": [],
            "sources": {},
            "warning": Value::Null,
            "url": Value::Null,
        }),
    }
}

pub async fn list_provider_models(
    config: &Value,
    request: NativeProviderModelsRequest,
) -> Result<NativeProviderModelList, String> {
    let profile = resolve_provider_profile(
        config,
        request.provider_id.as_deref(),
        request.profile_name.as_deref(),
    )
    .ok_or_else(|| {
        let provider_id = request
            .provider_id
            .as_deref()
            .or(request.profile_name.as_deref())
            .unwrap_or("default");
        format!("provider '{provider_id}' is not configured")
    })?;
    let catalog = catalog_entry_by_id(&profile.provider_id);
    let mut warning = None;
    let mut merged: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    add_models(
        &mut merged,
        "curated",
        catalog.map(|entry| entry.curated_model_ids).unwrap_or(&[]),
    );
    add_models(
        &mut merged,
        "profile",
        &profile
            .models
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
    );
    let manual_models = manual_model_ids(request.manual_models.as_ref());
    add_models(
        &mut merged,
        "manual",
        &manual_models.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let mut url = profile.api_base.as_deref().map(join_models_url);

    if request.refresh_live.unwrap_or(false) {
        let api_base = request.api_base.or(profile.api_base.clone());
        let api_key = request.api_key.or(profile.api_key.clone());
        if !profile.supports_model_discovery {
            warning = Some(
                "live discovery skipped: provider does not support model discovery".to_string(),
            );
        } else if api_base.as_deref().is_none_or(str::is_empty) {
            warning = Some("live discovery skipped: api_base is required".to_string());
        } else if api_key.as_deref().is_none_or(str::is_empty)
            && catalog.is_some_and(|entry| {
                !entry.api_key_env_vars.is_empty() && !entry.categories.contains(&"local")
            })
        {
            warning = Some("live discovery skipped: api key is required".to_string());
        } else {
            let discovery = if let Some(live_models) = request.live_model_ids {
                Ok((live_models, api_base.as_deref().map(join_models_url)))
            } else {
                discover_openai_models(
                    api_base.clone().unwrap_or_default(),
                    api_key.unwrap_or_default(),
                    profile.request_timeout_ms,
                )
                .await
                .map(|models| (models, api_base.as_deref().map(join_models_url)))
            };
            match discovery {
                Ok((live_models, live_url)) => {
                    add_models(
                        &mut merged,
                        "live",
                        &live_models.iter().map(String::as_str).collect::<Vec<_>>(),
                    );
                    url = live_url;
                }
                Err(error) => warning = Some(format!("live discovery failed: {error}")),
            }
        }
    }

    if let Some(model) = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        add_models(&mut merged, "manual", &[model]);
    }

    let models = merged.keys().cloned().collect::<Vec<_>>();
    let mut model_sources = BTreeMap::new();
    let mut sources = BTreeMap::from([
        ("curated".to_string(), 0),
        ("profile".to_string(), 0),
        ("manual".to_string(), 0),
        ("live".to_string(), 0),
    ]);
    for (model, model_source_set) in &merged {
        let model_source_list = model_source_set.iter().cloned().collect::<Vec<_>>();
        for source in &model_source_list {
            if let Some(count) = sources.get_mut(source) {
                *count += 1;
            }
        }
        model_sources.insert(model.clone(), model_source_list);
    }

    Ok(NativeProviderModelList {
        ok: !models.is_empty(),
        error: if models.is_empty() {
            Some(
                warning
                    .clone()
                    .unwrap_or_else(|| "no models available".to_string()),
            )
        } else {
            None
        },
        models,
        model_sources,
        sources,
        warning,
        url,
    })
}

async fn discover_openai_models(
    api_base: String,
    api_key: String,
    timeout_ms: u64,
) -> Result<Vec<String>, String> {
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let config = OpenAIConfig::new()
        .with_api_base(api_base)
        .with_api_key(api_key);
    let client = Client::with_config(config);
    let response: ProviderModelDiscoveryResponse =
        tokio::time::timeout(timeout, client.models().list_byot())
            .await
            .map_err(|_| {
                format!(
                    "provider request timed out after {} ms",
                    timeout.as_millis()
                )
            })?
            .map_err(|error| error.to_string())?;
    Ok(response.data.into_iter().map(|model| model.id).collect())
}

pub fn configured_model(config: &Value) -> String {
    config
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| string_field(defaults, "model"))
        .or_else(|| {
            config
                .get("agents")
                .and_then(|agents| string_field(agents, "model"))
        })
        .unwrap_or_else(|| DEFAULT_AGENT_MODEL.to_string())
}

pub fn resolve_provider_profile(
    config: &Value,
    provider_id: Option<&str>,
    profile_name: Option<&str>,
) -> Option<NativeProviderProfile> {
    let requested_provider_id = provider_id
        .map(normalize_provider_id)
        .filter(|value| !value.is_empty() && value != "auto");
    let explicit_profile_config =
        profile_name.and_then(|name| provider_profile_config(config, name));
    let active_profile_config =
        active_profile_name(config).and_then(|name| provider_profile_config(config, &name));
    let profile_provider_id = explicit_profile_config
        .or(active_profile_config)
        .and_then(|profile| string_field(profile, "provider"))
        .map(|value| normalize_provider_id(&value));
    let default_provider_id = default_provider_id(config);
    let provider_id = requested_provider_id
        .or(profile_provider_id)
        .or(default_provider_id)
        .unwrap_or_else(|| infer_provider_from_model(&configured_model(config)));
    let catalog = catalog_entry_by_id(&provider_id);
    let provider_config = provider_config(config, &provider_id, profile_name);
    if catalog.is_none() && provider_config.is_none() {
        return None;
    }
    let api_base = string_field(provider_config.unwrap_or(&Value::Null), "api_base")
        .or_else(|| string_field(provider_config.unwrap_or(&Value::Null), "apiBase"))
        .or_else(|| catalog.and_then(|entry| env_first(entry.api_base_env_vars)))
        .or_else(|| catalog.and_then(|entry| entry.default_api_base.map(str::to_string)));
    let api_key = string_field(provider_config.unwrap_or(&Value::Null), "api_key")
        .or_else(|| string_field(provider_config.unwrap_or(&Value::Null), "apiKey"))
        .or_else(|| catalog.and_then(|entry| env_first(entry.api_key_env_vars)));
    let models = string_array_field(provider_config.unwrap_or(&Value::Null), "models")
        .or_else(|| string_array_field(provider_config.unwrap_or(&Value::Null), "model_ids"))
        .unwrap_or_default();
    let model_context_windows =
        model_context_windows_field(provider_config.unwrap_or(&Value::Null));
    let request_timeout_ms = u64_field(provider_config.unwrap_or(&Value::Null), "timeout_ms")
        .or_else(|| u64_field(provider_config.unwrap_or(&Value::Null), "timeoutMs"))
        .or_else(|| {
            u64_field(
                provider_config.unwrap_or(&Value::Null),
                "request_timeout_ms",
            )
        })
        .or_else(|| u64_field(provider_config.unwrap_or(&Value::Null), "requestTimeoutMs"))
        .unwrap_or(DEFAULT_PROVIDER_TIMEOUT_MS)
        .max(1);
    let stream_idle_timeout_ms = u64_field(
        provider_config.unwrap_or(&Value::Null),
        "stream_idle_timeout_ms",
    )
    .or_else(|| {
        u64_field(
            provider_config.unwrap_or(&Value::Null),
            "streamIdleTimeoutMs",
        )
    })
    .unwrap_or(request_timeout_ms)
    .max(1);

    Some(NativeProviderProfile {
        provider_id: provider_id.to_string(),
        display_name: string_field(provider_config.unwrap_or(&Value::Null), "displayName")
            .or_else(|| string_field(provider_config.unwrap_or(&Value::Null), "display_name"))
            .unwrap_or_else(|| {
                catalog
                    .map(|entry| entry.display_name.to_string())
                    .unwrap_or_else(|| provider_id.to_string())
            }),
        is_custom: catalog.is_none(),
        api_base,
        api_key_configured: api_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        api_key,
        models,
        model_context_windows,
        supports_model_discovery: catalog
            .map(|entry| entry.supports_model_discovery)
            .unwrap_or(true)
            && bool_field(
                provider_config.unwrap_or(&Value::Null),
                "supports_model_discovery",
            )
            .or_else(|| {
                bool_field(
                    provider_config.unwrap_or(&Value::Null),
                    "supportsModelDiscovery",
                )
            })
            .unwrap_or(true),
        supports_reasoning_effort: bool_field(
            provider_config.unwrap_or(&Value::Null),
            "supports_reasoning_effort",
        )
        .or_else(|| {
            bool_field(
                provider_config.unwrap_or(&Value::Null),
                "supportsReasoningEffort",
            )
        })
        .unwrap_or(true),
        capabilities: provider_config
            .and_then(|provider| provider.get("capabilities"))
            .cloned()
            .unwrap_or_else(|| {
                Value::Array(
                    catalog
                        .map(|entry| entry.capabilities)
                        .unwrap_or_default()
                        .iter()
                        .map(|capability| Value::String((*capability).to_string()))
                        .collect(),
                )
            }),
        request_timeout_ms,
        stream_idle_timeout_ms,
        api_mode: string_field(provider_config.unwrap_or(&Value::Null), "api_mode")
            .or_else(|| string_field(provider_config.unwrap_or(&Value::Null), "apiMode"))
            .unwrap_or_else(|| "chat_completions".to_string())
            .to_ascii_lowercase(),
    })
}

fn default_provider_id(config: &Value) -> Option<String> {
    config
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| string_field(defaults, "provider"))
        .map(|value| normalize_provider_id(&value))
        .filter(|value| !value.is_empty() && value != "auto")
}

pub(super) fn active_profile_name(config: &Value) -> Option<String> {
    config
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| {
            string_field(defaults, "activeProfile")
                .or_else(|| string_field(defaults, "active_profile"))
        })
}

fn provider_profile_config<'a>(config: &'a Value, profile_name: &str) -> Option<&'a Value> {
    config
        .get("providers")
        .and_then(|providers| providers.get("profiles"))
        .and_then(|profiles| profiles.get(profile_name))
}

fn provider_config<'a>(
    config: &'a Value,
    provider_id: &str,
    profile_name: Option<&str>,
) -> Option<&'a Value> {
    let providers = config.get("providers")?.as_object()?;
    profile_name
        .and_then(|name| provider_profile_config(config, name))
        .or_else(|| {
            active_profile_name(config)
                .as_deref()
                .and_then(|name| provider_profile_config(config, name))
                .filter(|profile| profile_matches_provider(profile, provider_id))
        })
        .or_else(|| providers.get(provider_id))
        .or_else(|| provider_profile_config(config, provider_id))
        .or_else(|| {
            providers
                .get("profiles")
                .and_then(Value::as_object)
                .and_then(|profiles| {
                    profiles
                        .values()
                        .find(|profile| profile_matches_provider(profile, provider_id))
                })
        })
}

fn profile_matches_provider(profile: &Value, provider_id: &str) -> bool {
    string_field(profile, "provider")
        .map(|value| normalize_provider_id(&value) == provider_id)
        .unwrap_or(false)
}

pub(super) fn catalog_entry_by_id(
    provider_id: &str,
) -> Option<&'static NativeProviderCatalogEntry> {
    PROVIDER_CATALOG.iter().find(|entry| {
        entry.id == provider_id
            || entry
                .aliases
                .iter()
                .any(|alias| normalize_provider_id(alias) == provider_id)
    })
}

pub(super) fn infer_provider_from_model(model: &str) -> String {
    let normalized = model.trim().to_ascii_lowercase();
    PROVIDER_CATALOG
        .iter()
        .find(|entry| {
            entry
                .curated_model_ids
                .iter()
                .any(|id| id.eq_ignore_ascii_case(&normalized))
                || entry
                    .model_prefixes
                    .iter()
                    .any(|prefix| normalized.starts_with(&prefix.to_ascii_lowercase()))
        })
        .map(|entry| entry.id.to_string())
        .unwrap_or_else(|| "deepseek".to_string())
}

fn add_models(merged: &mut BTreeMap<String, BTreeSet<String>>, source: &str, models: &[&str]) {
    for model in models {
        let model = model.trim();
        if !model.is_empty() {
            merged
                .entry(model.to_string())
                .or_default()
                .insert(source.to_string());
        }
    }
}

fn manual_model_ids(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => value
            .replace('\n', ",")
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::trim))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn string_array_field(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::trim))
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect()
    })
}

pub(super) fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn model_context_windows_field(value: &Value) -> BTreeMap<String, i64> {
    value
        .get("modelContextWindows")
        .or_else(|| value.get("model_context_windows"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let model = string_field(entry, "model")
                .or_else(|| string_field(entry, "modelId"))
                .or_else(|| string_field(entry, "model_id"))?;
            let tokens = entry
                .get("contextWindowTokens")
                .or_else(|| entry.get("context_window_tokens"))
                .and_then(Value::as_i64)
                .filter(|tokens| *tokens > 0)?;
            Some((model.to_ascii_lowercase(), tokens))
        })
        .collect()
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn env_first(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

pub(super) fn normalize_provider_id(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn join_models_url(api_base: &str) -> String {
    format!("{}/models", api_base.trim_end_matches('/'))
}
