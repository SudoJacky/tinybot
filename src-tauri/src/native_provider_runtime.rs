use async_openai::{config::OpenAIConfig, Client};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_AGENT_MODEL: &str = "deepseek-reasoner";
const DEFAULT_PROVIDER_TIMEOUT_MS: u64 = 120_000;

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
    pub backend: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeProviderProfile {
    pub provider_id: String,
    pub display_name: String,
    pub api_base: Option<String>,
    pub api_key: Option<String>,
    pub api_key_configured: bool,
    pub models: Vec<String>,
    pub supports_model_discovery: bool,
    pub request_timeout_ms: u64,
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

const PROVIDER_CATALOG: &[NativeProviderCatalogEntry] = &[
    catalog_entry(
        "openai",
        "OpenAI",
        &["gpt", "chatgpt"],
        &["built_in"],
        Some("https://api.openai.com/v1"),
        &["OPENAI_API_KEY"],
        &["OPENAI_BASE_URL"],
        &[
            "gpt-5.5",
            "gpt-5.5-pro",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "gpt-5-mini",
            "gpt-5.3-codex",
            "gpt-4.1",
            "gpt-4o",
            "gpt-4o-mini",
        ],
        &["gpt", "o1", "o3", "o4"],
    ),
    catalog_entry(
        "deepseek",
        "DeepSeek",
        &["deep seek"],
        &["built_in"],
        Some("https://api.deepseek.com"),
        &["DEEPSEEK_API_KEY"],
        &["DEEPSEEK_BASE_URL"],
        &[
            "deepseek-v4-pro",
            "deepseek-v4-flash",
            "deepseek-chat",
            "deepseek-reasoner",
        ],
        &["deepseek"],
    ),
    catalog_entry(
        "openrouter",
        "OpenRouter",
        &["open router"],
        &["built_in", "aggregator"],
        Some("https://openrouter.ai/api/v1"),
        &["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
        &["OPENROUTER_BASE_URL"],
        &[
            "anthropic/claude-opus-4.7",
            "anthropic/claude-sonnet-4.6",
            "openai/gpt-5.5",
            "openai/gpt-5.4-mini",
        ],
        &["openrouter", "anthropic", "openai", "google", "qwen"],
    ),
    catalog_entry(
        "ollama",
        "Ollama",
        &["local ollama"],
        &["local"],
        Some("http://127.0.0.1:11434/v1"),
        &[],
        &[],
        &["llama3.1", "qwen2.5", "mistral"],
        &["ollama", "llama", "mistral"],
    ),
    catalog_entry(
        "custom",
        "Custom OpenAI-compatible",
        &["custom", "openai compatible", "compatible endpoint"],
        &["custom"],
        None,
        &[],
        &[],
        &[],
        &[],
    ),
    NativeProviderCatalogEntry {
        id: "fixture",
        display_name: "Fixture",
        aliases: &["test fixture"],
        categories: &["local", "test"],
        default_api_base: None,
        api_key_env_vars: &[],
        api_base_env_vars: &[],
        supports_model_discovery: false,
        curated_model_ids: &["fixture-model"],
        model_prefixes: &["fixture"],
        backend: "fixture",
    },
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
) -> NativeProviderCatalogEntry {
    NativeProviderCatalogEntry {
        id,
        display_name,
        aliases,
        categories,
        default_api_base,
        api_key_env_vars,
        api_base_env_vars,
        supports_model_discovery: true,
        curated_model_ids,
        model_prefixes,
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

pub fn openai_models_body(config: &Value) -> Value {
    serde_json::json!({
        "object": "list",
        "data": [{
            "id": configured_model(config),
            "object": "model",
            "created": 0,
            "owned_by": "tinybot",
        }],
    })
}

pub fn provider_models_body(config: &Value, body: &Value) -> Value {
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
    match list_provider_models(config, request) {
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

pub fn openai_chat_completions_route(config: &Value, body: &Value) -> Value {
    match native_chat_completion(config, body) {
        Ok(response) => chat_route_response(response.status, response.body, response.stream),
        Err(error) => chat_route_response(
            error.status,
            serde_json::json!({
                "error": {
                    "message": error.message,
                    "type": error.error_type,
                    "code": error.code,
                }
            }),
            false,
        ),
    }
}

pub fn complete_chat_for_agent(config: &Value, body: &Value) -> Result<Value, String> {
    let mut request_body = body.clone();
    request_body["stream"] = Value::Bool(false);
    match native_chat_completion(config, &request_body) {
        Ok(response) if (200..300).contains(&response.status) && !response.stream => {
            Ok(response.body)
        }
        Ok(response) => Err(format!(
            "chat completion returned unexpected status {}",
            response.status
        )),
        Err(error) => Err(error.message),
    }
}

pub fn list_provider_models(
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
                )
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

fn discover_openai_models(api_base: String, api_key: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::block_on(async move {
        let config = OpenAIConfig::new()
            .with_api_base(api_base)
            .with_api_key(api_key);
        let client = Client::with_config(config);
        client
            .models()
            .list()
            .await
            .map(|response| response.data.into_iter().map(|model| model.id).collect())
            .map_err(|error| error.to_string())
    })
}

#[derive(Clone, Debug)]
struct NativeChatRequest {
    model: String,
    stream: bool,
    body: Value,
}

#[derive(Clone, Debug)]
struct NativeChatRouteBody {
    status: u16,
    body: Value,
    stream: bool,
}

#[derive(Clone, Debug)]
struct NativeChatRouteError {
    status: u16,
    message: String,
    error_type: &'static str,
    code: &'static str,
}

fn native_chat_completion(
    config: &Value,
    body: &Value,
) -> Result<NativeChatRouteBody, NativeChatRouteError> {
    let request = parse_chat_request(config, body)?;
    let profile = resolve_chat_provider_profile(config, &request.model).ok_or_else(|| {
        chat_error(
            503,
            format!("provider for model '{}' is not configured", request.model),
            "configuration_error",
            "provider_not_configured",
        )
    })?;

    if profile.provider_id == "fixture" {
        let content = fixture_chat_content(config)?;
        return Ok(if request.stream {
            NativeChatRouteBody {
                status: 200,
                body: Value::String(chat_completion_sse(&request.model, &content)),
                stream: true,
            }
        } else {
            NativeChatRouteBody {
                status: 200,
                body: chat_completion_body(&request.model, &content),
                stream: false,
            }
        });
    }

    if request.stream {
        complete_openai_chat_stream(profile, request).map(|body| NativeChatRouteBody {
            status: 200,
            body: Value::String(body),
            stream: true,
        })
    } else {
        complete_openai_chat(profile, request).map(|body| NativeChatRouteBody {
            status: 200,
            body,
            stream: false,
        })
    }
}

fn parse_chat_request(
    config: &Value,
    body: &Value,
) -> Result<NativeChatRequest, NativeChatRouteError> {
    if !body.is_object() {
        return Err(chat_error(
            400,
            "request body must be a JSON object",
            "invalid_request_error",
            "invalid_body",
        ));
    }
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            chat_error(
                400,
                "messages must be a non-empty array",
                "invalid_request_error",
                "invalid_messages",
            )
        })?;
    if messages.is_empty() {
        return Err(chat_error(
            400,
            "messages must be a non-empty array",
            "invalid_request_error",
            "invalid_messages",
        ));
    }
    if messages.iter().any(|message| {
        !message.is_object()
            || message
                .get("role")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
    }) {
        return Err(chat_error(
            400,
            "each message must be an object with a role",
            "invalid_request_error",
            "invalid_messages",
        ));
    }

    let model = string_field(body, "model").unwrap_or_else(|| configured_model(config));
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut request_body = body.clone();
    request_body["model"] = Value::String(model.clone());
    request_body["stream"] = Value::Bool(stream);

    Ok(NativeChatRequest {
        model,
        stream,
        body: request_body,
    })
}

fn complete_openai_chat(
    profile: NativeProviderProfile,
    mut request: NativeChatRequest,
) -> Result<Value, NativeChatRouteError> {
    request.body["stream"] = Value::Bool(false);
    tauri::async_runtime::block_on(async move {
        let timeout = Duration::from_millis(profile.request_timeout_ms.max(1));
        let client = openai_client(profile)?;
        let response: Value =
            tokio::time::timeout(timeout, client.chat().create_byot(request.body))
                .await
                .map_err(|_| provider_timeout_error(timeout))?
                .map_err(|error| provider_chat_error(error.to_string()))?;
        Ok(response)
    })
}

fn complete_openai_chat_stream(
    profile: NativeProviderProfile,
    mut request: NativeChatRequest,
) -> Result<String, NativeChatRouteError> {
    request.body["stream"] = Value::Bool(true);
    tauri::async_runtime::block_on(async move {
        let timeout = Duration::from_millis(profile.request_timeout_ms.max(1));
        let client = openai_client(profile)?;
        let mut stream: async_openai::types::stream::StreamResponse<Value> =
            tokio::time::timeout(timeout, client.chat().create_stream_byot(request.body))
                .await
                .map_err(|_| provider_timeout_error(timeout))?
                .map_err(|error| provider_chat_error(error.to_string()))?;
        let mut body = String::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => push_sse_json(&mut body, &chunk),
                Err(error) => {
                    push_sse_error(&mut body, error.to_string());
                    body.push_str("data: [DONE]\n\n");
                    return Ok(body);
                }
            }
        }
        body.push_str("data: [DONE]\n\n");
        Ok(body)
    })
}

fn openai_client(
    profile: NativeProviderProfile,
) -> Result<Client<OpenAIConfig>, NativeChatRouteError> {
    let api_base = profile.api_base.as_deref().unwrap_or_default().trim();
    if api_base.is_empty() {
        return Err(chat_error(
            503,
            format!("provider '{}' requires api_base", profile.provider_id),
            "configuration_error",
            "missing_api_base",
        ));
    }
    if provider_requires_api_key(&profile)
        && profile
            .api_key
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Err(chat_error(
            503,
            format!("provider '{}' requires an API key", profile.provider_id),
            "configuration_error",
            "missing_api_key",
        ));
    }

    Ok(Client::with_config(
        OpenAIConfig::new()
            .with_api_base(api_base.to_string())
            .with_api_key(profile.api_key.unwrap_or_default()),
    ))
}

fn resolve_chat_provider_profile(config: &Value, model: &str) -> Option<NativeProviderProfile> {
    let default_provider = config
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| string_field(defaults, "provider"));
    let provider_id = default_provider
        .as_deref()
        .map(normalize_provider_id)
        .filter(|provider| !provider.is_empty() && provider != "auto")
        .unwrap_or_else(|| infer_provider_from_model(model));
    resolve_provider_profile(config, Some(&provider_id), None)
}

fn provider_requires_api_key(profile: &NativeProviderProfile) -> bool {
    catalog_entry_by_id(&profile.provider_id).is_some_and(|entry| {
        !entry.api_key_env_vars.is_empty() && !entry.categories.contains(&"local")
    })
}

fn fixture_chat_content(config: &Value) -> Result<String, NativeChatRouteError> {
    let response = config
        .get("providers")
        .and_then(|providers| providers.get("fixture"))
        .and_then(|fixture| fixture.get("responses"))
        .and_then(Value::as_array)
        .and_then(|responses| responses.first())
        .ok_or_else(|| {
            chat_error(
                503,
                "fixture provider has no queued response",
                "configuration_error",
                "fixture_response_missing",
            )
        })?;
    Ok(string_field(response, "content").unwrap_or_default())
}

fn chat_completion_body(model: &str, content: &str) -> Value {
    serde_json::json!({
        "id": chat_completion_id(),
        "object": "chat.completion",
        "created": unix_timestamp(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": content,
            },
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    })
}

fn chat_completion_sse(model: &str, content: &str) -> String {
    let id = chat_completion_id();
    let created = unix_timestamp();
    let mut body = String::new();
    push_sse_json(
        &mut body,
        &serde_json::json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{ "index": 0, "delta": { "role": "assistant" }, "finish_reason": Value::Null }],
        }),
    );
    if !content.is_empty() {
        push_sse_json(
            &mut body,
            &serde_json::json!({
                "id": id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{ "index": 0, "delta": { "content": content }, "finish_reason": Value::Null }],
            }),
        );
    }
    push_sse_json(
        &mut body,
        &serde_json::json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        }),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

fn push_sse_json(body: &mut String, value: &Value) {
    let line = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    body.push_str("data: ");
    body.push_str(&line);
    body.push_str("\n\n");
}

fn push_sse_error(body: &mut String, message: String) {
    push_sse_json(
        body,
        &serde_json::json!({
            "error": {
                "message": message,
                "type": "provider_error",
                "code": "provider_stream_failed",
            }
        }),
    );
}

fn chat_route_response(status: u16, body: Value, stream: bool) -> Value {
    let mut headers = serde_json::json!({
        "x-tinybot-route-owner": "rust",
        "x-tinybot-route-group": "openai",
    });
    if stream {
        headers["content-type"] = Value::String("text/event-stream".to_string());
        headers["cache-control"] = Value::String("no-cache".to_string());
    }
    serde_json::json!({
        "status": status,
        "body": body,
        "headers": headers,
    })
}

fn chat_error(
    status: u16,
    message: impl Into<String>,
    error_type: &'static str,
    code: &'static str,
) -> NativeChatRouteError {
    NativeChatRouteError {
        status,
        message: message.into(),
        error_type,
        code,
    }
}

fn provider_chat_error(message: String) -> NativeChatRouteError {
    chat_error(503, message, "provider_error", "provider_request_failed")
}

fn provider_timeout_error(timeout: Duration) -> NativeChatRouteError {
    chat_error(
        504,
        format!(
            "provider request timed out after {} ms",
            timeout.as_millis()
        ),
        "provider_timeout",
        "provider_timeout",
    )
}

fn chat_completion_id() -> String {
    format!("chatcmpl-rust-{}", unix_timestamp())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
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

    Some(NativeProviderProfile {
        provider_id: provider_id.to_string(),
        display_name: string_field(provider_config.unwrap_or(&Value::Null), "displayName")
            .or_else(|| string_field(provider_config.unwrap_or(&Value::Null), "display_name"))
            .unwrap_or_else(|| {
                catalog
                    .map(|entry| entry.display_name.to_string())
                    .unwrap_or_else(|| provider_id.to_string())
            }),
        api_base,
        api_key_configured: api_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        api_key,
        models,
        supports_model_discovery: bool_field(
            provider_config.unwrap_or(&Value::Null),
            "supports_model_discovery",
        )
        .or_else(|| {
            bool_field(
                provider_config.unwrap_or(&Value::Null),
                "supportsModelDiscovery",
            )
        })
        .unwrap_or_else(|| {
            catalog
                .map(|entry| entry.supports_model_discovery)
                .unwrap_or(true)
        }),
        request_timeout_ms,
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

fn active_profile_name(config: &Value) -> Option<String> {
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

fn catalog_entry_by_id(provider_id: &str) -> Option<&'static NativeProviderCatalogEntry> {
    PROVIDER_CATALOG.iter().find(|entry| {
        entry.id == provider_id
            || entry
                .aliases
                .iter()
                .any(|alias| normalize_provider_id(alias) == provider_id)
    })
}

fn infer_provider_from_model(model: &str) -> String {
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

fn string_field(value: &Value, key: &str) -> Option<String> {
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

fn normalize_provider_id(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn provider_catalog_masks_secret_presence() {
        let body = provider_catalog_body(&json!({
            "providers": {
                "openai": { "api_key": "sk-secret", "api_base": "https://example.test/v1" }
            }
        }));

        let openai = body["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "openai")
            .unwrap();
        assert_eq!(openai["api_key_configured"], true);
        assert!(openai.get("api_key").is_none());
    }

    #[test]
    fn resolves_provider_profile_from_config_and_defaults() {
        let profile = resolve_provider_profile(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
                "providers": { "openai": { "api_key": "sk-secret", "models": ["gpt-4.1-custom"] } }
            }),
            None,
            None,
        )
        .unwrap();

        assert_eq!(profile.provider_id, "openai");
        assert_eq!(
            profile.api_base.as_deref(),
            Some("https://api.openai.com/v1")
        );
        assert!(profile.api_key_configured);
        assert_eq!(profile.models, vec!["gpt-4.1-custom"]);
    }

    #[test]
    fn resolves_active_provider_profile_credentials() {
        let config = json!({
            "agents": {
                "defaults": {
                    "provider": "openai",
                    "model": "gpt-4.1",
                    "activeProfile": "work"
                }
            },
            "providers": {
                "profiles": {
                    "work": {
                        "provider": "openai",
                        "api_key": "sk-profile",
                        "api_base": "https://profile.example.test/v1",
                        "models": ["profile-model"]
                    }
                }
            }
        });
        let profile = resolve_provider_profile(&config, None, None).unwrap();
        let models = list_provider_models(
            &config,
            NativeProviderModelsRequest {
                provider_id: Some("openai".to_string()),
                profile_name: Some("work".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(profile.provider_id, "openai");
        assert_eq!(
            profile.api_base.as_deref(),
            Some("https://profile.example.test/v1")
        );
        assert_eq!(profile.api_key.as_deref(), Some("sk-profile"));
        assert!(profile.api_key_configured);
        assert_eq!(profile.models, vec!["profile-model"]);
        assert!(models.models.contains(&"profile-model".to_string()));
    }

    #[test]
    fn resolves_configured_custom_openai_compatible_provider_without_catalog_entry() {
        let config = json!({
            "agents": {
                "defaults": {
                    "provider": "my_gateway",
                    "model": "custom-chat"
                }
            },
            "providers": {
                "my_gateway": {
                    "displayName": "My Gateway",
                    "api_key": "sk-custom",
                    "api_base": "https://gateway.example.test/v1",
                    "models": ["custom-chat"]
                }
            }
        });
        let profile = resolve_provider_profile(&config, Some("my_gateway"), None).unwrap();
        let models = list_provider_models(
            &config,
            NativeProviderModelsRequest {
                provider_id: Some("my_gateway".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(profile.provider_id, "my_gateway");
        assert_eq!(profile.display_name, "My Gateway");
        assert_eq!(
            profile.api_base.as_deref(),
            Some("https://gateway.example.test/v1")
        );
        assert_eq!(profile.api_key.as_deref(), Some("sk-custom"));
        assert!(profile.supports_model_discovery);
        assert_eq!(models.models, vec!["custom-chat"]);
        assert_eq!(models.sources["profile"], 1);
    }

    #[test]
    fn provider_models_merge_curated_profile_manual_and_fixture_live() {
        let result = list_provider_models(
            &json!({
                "providers": {
                    "openai": {
                        "api_key": "sk-secret",
                        "models": ["profile-model"]
                    }
                }
            }),
            NativeProviderModelsRequest {
                provider_id: Some("openai".to_string()),
                manual_models: Some(json!("manual-a, manual-b")),
                refresh_live: Some(true),
                live_model_ids: Some(vec!["live-model".to_string()]),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(result.ok);
        assert!(result.models.contains(&"profile-model".to_string()));
        assert!(result.models.contains(&"manual-a".to_string()));
        assert!(result.models.contains(&"live-model".to_string()));
        assert_eq!(result.sources["live"], 1);
    }

    #[test]
    fn provider_models_reports_discovery_configuration_failure() {
        let result = list_provider_models(
            &json!({ "providers": { "openai": {} } }),
            NativeProviderModelsRequest {
                provider_id: Some("openai".to_string()),
                refresh_live: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(result.ok);
        assert_eq!(
            result.warning.as_deref(),
            Some("live discovery skipped: api key is required")
        );
    }

    #[test]
    fn chat_completion_uses_fixture_provider_without_network() {
        let response = openai_chat_completions_route(
            &json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "fixture answer" }] } }
            }),
            &json!({
                "model": "fixture-model",
                "messages": [{ "role": "user", "content": "hello" }]
            }),
        );

        assert_eq!(response["status"], 200);
        assert_eq!(response["headers"]["x-tinybot-route-owner"], "rust");
        assert_eq!(response["body"]["object"], "chat.completion");
        assert_eq!(
            response["body"]["choices"][0]["message"]["content"],
            "fixture answer"
        );
    }

    #[test]
    fn chat_completion_streams_fixture_response_as_sse() {
        let response = openai_chat_completions_route(
            &json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "stream answer" }] } }
            }),
            &json!({
                "messages": [{ "role": "user", "content": "hello" }],
                "stream": true
            }),
        );

        let body = response["body"]
            .as_str()
            .expect("stream body should be text");
        assert_eq!(response["status"], 200);
        assert_eq!(response["headers"]["content-type"], "text/event-stream");
        assert!(body.contains(r#""object":"chat.completion.chunk""#));
        assert!(body.contains(r#""content":"stream answer""#));
        assert_eq!(body.matches(r#""finish_reason":"stop""#).count(), 1);
        assert!(body.ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn chat_completion_rejects_invalid_messages() {
        let response = openai_chat_completions_route(
            &json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "unused" }] } }
            }),
            &json!({ "messages": [] }),
        );

        assert_eq!(response["status"], 400);
        assert_eq!(response["body"]["error"]["code"], "invalid_messages");
    }

    #[test]
    fn chat_completion_reports_provider_configuration_failure() {
        let response = openai_chat_completions_route(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
                "providers": { "openai": { "api_key": "" } }
            }),
            &json!({
                "messages": [{ "role": "user", "content": "hello" }]
            }),
        );

        assert_eq!(response["status"], 503);
        assert_eq!(response["body"]["error"]["code"], "missing_api_key");
    }

    #[test]
    fn chat_completion_reports_provider_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let stalled_server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 512];
                let _ = stream.read(&mut buffer);
                thread::sleep(Duration::from_millis(250));
            }
        });

        let response = openai_chat_completions_route(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
                "providers": {
                    "openai": {
                        "api_key": "sk-test",
                        "api_base": api_base,
                        "timeout_ms": 25
                    }
                }
            }),
            &json!({
                "messages": [{ "role": "user", "content": "hello" }]
            }),
        );

        let _ = stalled_server.join();
        assert_eq!(response["status"], 504);
        assert_eq!(response["body"]["error"]["type"], "provider_timeout");
        assert_eq!(response["body"]["error"]["code"], "provider_timeout");
    }
}
