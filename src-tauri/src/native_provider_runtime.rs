use crate::worker_protocol::WorkerRequestCancellation;
use async_openai::{config::OpenAIConfig, error::OpenAIError, Client};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_AGENT_MODEL: &str = "deepseek-v4-pro";
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
    pub stream_idle_timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NativeProviderStreamEvent {
    ContentDelta(String),
    ReasoningDelta(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeProviderFailureKind {
    Cancelled,
    RequestTimeout,
    StreamIdleTimeout,
    Transport,
    Provider,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeProviderFailure {
    kind: NativeProviderFailureKind,
    message: String,
}

impl NativeProviderFailure {
    fn new(kind: NativeProviderFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn from_route_error(error: NativeChatRouteError) -> Self {
        let kind = match error.code {
            "provider_cancelled" => NativeProviderFailureKind::Cancelled,
            "provider_timeout" => NativeProviderFailureKind::RequestTimeout,
            "provider_stream_idle_timeout" => NativeProviderFailureKind::StreamIdleTimeout,
            "provider_transport_error" => NativeProviderFailureKind::Transport,
            _ => NativeProviderFailureKind::Provider,
        };
        Self::new(kind, error.message)
    }

    pub fn kind(&self) -> NativeProviderFailureKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for NativeProviderFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for NativeProviderFailure {}

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
        &["gpt-4.1"],
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
        &["deepseek-v4-pro", "deepseek-v4-flash"],
        &["deepseek"],
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
    tauri::async_runtime::block_on(openai_chat_completions_route_async(config, body))
}

pub async fn openai_chat_completions_route_async(config: &Value, body: &Value) -> Value {
    match native_chat_completion_with_observer_async(config, body, None, None).await {
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
    let mut observer = |_event: NativeProviderStreamEvent| {};
    complete_chat_for_agent_with_observer(config, body, &mut observer)
}

pub fn complete_chat_for_agent_with_observer(
    config: &Value,
    body: &Value,
    observer: &mut (dyn FnMut(NativeProviderStreamEvent) + Send),
) -> Result<Value, String> {
    tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
        config, body, observer, None,
    ))
    .map_err(|error| error.to_string())
}

pub async fn complete_chat_for_agent_with_observer_async(
    config: &Value,
    body: &Value,
    observer: &mut (dyn FnMut(NativeProviderStreamEvent) + Send),
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeProviderFailure> {
    match native_chat_completion_with_observer_async(config, body, Some(observer), cancellation)
        .await
    {
        Ok(response) if (200..300).contains(&response.status) && !response.stream => {
            Ok(response.body)
        }
        Ok(response) if (200..300).contains(&response.status) && response.stream => {
            let body = response.body.as_str().ok_or_else(|| {
                NativeProviderFailure::new(
                    NativeProviderFailureKind::Provider,
                    "streaming chat completion returned non-text body",
                )
            })?;
            if response.observed_stream {
                aggregate_chat_completion_sse(body).map_err(|error| {
                    NativeProviderFailure::new(NativeProviderFailureKind::Provider, error)
                })
            } else {
                aggregate_chat_completion_sse_with_observer(body, Some(observer)).map_err(|error| {
                    NativeProviderFailure::new(NativeProviderFailureKind::Provider, error)
                })
            }
        }
        Ok(response) => Err(NativeProviderFailure::new(
            NativeProviderFailureKind::Provider,
            format!(
                "chat completion returned unexpected status {}",
                response.status
            ),
        )),
        Err(error) => Err(NativeProviderFailure::from_route_error(error)),
    }
}

fn aggregate_chat_completion_sse(body: &str) -> Result<Value, String> {
    aggregate_chat_completion_sse_with_observer(body, None)
}

fn aggregate_chat_completion_sse_with_observer(
    body: &str,
    mut observer: Option<&mut dyn FnMut(NativeProviderStreamEvent)>,
) -> Result<Value, String> {
    let mut content = String::new();
    let mut reasoning_content = String::new();
    let mut model = None::<String>;
    let mut usage = None::<Value>;
    let mut tool_calls = std::collections::BTreeMap::<usize, StreamingToolCallParts>::new();
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let chunk: Value = serde_json::from_str(data).map_err(|error| {
            format!("streaming chat completion chunk was invalid JSON: {error}")
        })?;
        if let Some(error) = chunk.get("error") {
            return Err(format!("streaming chat completion returned error: {error}"));
        }
        if let Some(chunk_usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            usage = Some(chunk_usage.clone());
        }
        if model.is_none() {
            model = chunk
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(delta) = chunk
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
        {
            content.push_str(delta);
            if let Some(observer) = observer.as_deref_mut() {
                observer(NativeProviderStreamEvent::ContentDelta(delta.to_string()));
            }
        }
        if let Some(delta) = chunk
            .pointer("/choices/0/delta/reasoning_content")
            .or_else(|| chunk.pointer("/choices/0/delta/reasoningContent"))
            .and_then(Value::as_str)
        {
            reasoning_content.push_str(delta);
            if let Some(observer) = observer.as_deref_mut() {
                observer(NativeProviderStreamEvent::ReasoningDelta(delta.to_string()));
            }
        }
        if let Some(deltas) = chunk
            .pointer("/choices/0/delta/tool_calls")
            .and_then(Value::as_array)
        {
            for (fallback_index, delta) in deltas.iter().enumerate() {
                let index = delta
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(fallback_index);
                let entry = tool_calls.entry(index).or_default();
                if let Some(id) = delta.get("id").and_then(Value::as_str) {
                    entry.id = Some(id.to_string());
                }
                if let Some(call_type) = delta.get("type").and_then(Value::as_str) {
                    entry.call_type = Some(call_type.to_string());
                }
                if let Some(name) = delta.pointer("/function/name").and_then(Value::as_str) {
                    entry.name = Some(name.to_string());
                }
                if let Some(arguments) =
                    delta.pointer("/function/arguments").and_then(Value::as_str)
                {
                    entry.arguments.push_str(arguments);
                }
            }
        }
    }
    let model = model.unwrap_or_else(|| "unknown-model".to_string());
    if tool_calls.is_empty() {
        let mut completion = chat_completion_body(&model, &content);
        if !reasoning_content.is_empty() {
            completion["choices"][0]["message"]["reasoning_content"] =
                Value::String(reasoning_content);
        }
        if let Some(usage) = usage {
            completion["usage"] = usage;
        }
        return Ok(completion);
    }
    let tool_calls = tool_calls
        .into_iter()
        .enumerate()
        .map(|(fallback_index, (_index, parts))| {
            serde_json::json!({
                "id": parts.id.unwrap_or_else(|| format!("tool-call-{}", fallback_index + 1)),
                "type": parts.call_type.unwrap_or_else(|| "function".to_string()),
                "function": {
                    "name": parts.name.unwrap_or_default(),
                    "arguments": parts.arguments,
                }
            })
        })
        .collect::<Vec<_>>();
    let mut message = serde_json::json!({
        "role": "assistant",
        "content": content,
        "tool_calls": tool_calls,
    });
    if !reasoning_content.is_empty() {
        message["reasoning_content"] = Value::String(reasoning_content);
    }
    Ok(serde_json::json!({
        "id": chat_completion_id(),
        "object": "chat.completion",
        "created": unix_timestamp(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "tool_calls",
        }],
        "usage": usage.unwrap_or_else(|| serde_json::json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }))
    }))
}

#[derive(Default)]
struct StreamingToolCallParts {
    id: Option<String>,
    call_type: Option<String>,
    name: Option<String>,
    arguments: String,
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
                    profile.request_timeout_ms,
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

fn discover_openai_models(
    api_base: String,
    api_key: String,
    timeout_ms: u64,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::block_on(async move {
        let timeout = Duration::from_millis(timeout_ms.max(1));
        let config = OpenAIConfig::new()
            .with_api_base(api_base)
            .with_api_key(api_key);
        let client = Client::with_config(config);
        tokio::time::timeout(timeout, client.models().list())
            .await
            .map_err(|_| {
                format!(
                    "provider request timed out after {} ms",
                    timeout.as_millis()
                )
            })?
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
    observed_stream: bool,
}

#[derive(Clone, Debug)]
struct NativeChatRouteError {
    status: u16,
    message: String,
    error_type: &'static str,
    code: &'static str,
}

async fn native_chat_completion_with_observer_async(
    config: &Value,
    body: &Value,
    mut observer: Option<&mut (dyn FnMut(NativeProviderStreamEvent) + Send)>,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<NativeChatRouteBody, NativeChatRouteError> {
    if cancellation_requested(&cancellation) {
        return Err(provider_cancelled_error());
    }
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
                observed_stream: false,
            }
        } else {
            NativeChatRouteBody {
                status: 200,
                body: chat_completion_body(&request.model, &content),
                stream: false,
                observed_stream: false,
            }
        });
    }

    if request.stream {
        let observed_stream = observer.is_some();
        let stream_result = match observer {
            Some(ref mut observer) => {
                complete_openai_chat_stream(profile, request, Some(&mut **observer), cancellation)
                    .await
            }
            None => complete_openai_chat_stream(profile, request, None, cancellation).await,
        };
        stream_result.map(|body| NativeChatRouteBody {
            status: 200,
            body: Value::String(body),
            stream: true,
            observed_stream,
        })
    } else {
        complete_openai_chat(profile, request, cancellation)
            .await
            .map(|body| NativeChatRouteBody {
                status: 200,
                body,
                stream: false,
                observed_stream: false,
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

async fn complete_openai_chat(
    profile: NativeProviderProfile,
    mut request: NativeChatRequest,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeChatRouteError> {
    request.body["stream"] = Value::Bool(false);
    let timeout = Duration::from_millis(profile.request_timeout_ms.max(1));
    let client = openai_client(profile)?;
    await_provider_request(
        client.chat().create_byot(request.body),
        timeout,
        cancellation,
    )
    .await
}

async fn complete_openai_chat_stream(
    profile: NativeProviderProfile,
    mut request: NativeChatRequest,
    mut observer: Option<&mut (dyn FnMut(NativeProviderStreamEvent) + Send)>,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<String, NativeChatRouteError> {
    request.body["stream"] = Value::Bool(true);
    let request_timeout = Duration::from_millis(profile.request_timeout_ms.max(1));
    let stream_idle_timeout = Duration::from_millis(profile.stream_idle_timeout_ms.max(1));
    let client = openai_client(profile)?;
    let mut stream: async_openai::types::stream::StreamResponse<Value> = await_provider_request(
        client.chat().create_stream_byot(request.body),
        request_timeout,
        cancellation.clone(),
    )
    .await?;
    let mut body = String::new();
    while let Some(chunk) =
        next_provider_stream_chunk(&mut stream, stream_idle_timeout, cancellation.clone()).await?
    {
        match chunk {
            Ok(chunk) => {
                if cancellation_requested(&cancellation) {
                    return Err(provider_cancelled_error());
                }
                if let Some(observer) = observer.as_deref_mut() {
                    observe_stream_chunk(&chunk, observer);
                }
                if cancellation_requested(&cancellation) {
                    return Err(provider_cancelled_error());
                }
                push_sse_json(&mut body, &chunk);
            }
            Err(error) => return Err(provider_openai_error(error)),
        }
    }
    body.push_str("data: [DONE]\n\n");
    Ok(body)
}

async fn await_provider_request<T, F>(
    request: F,
    timeout: Duration,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<T, NativeChatRouteError>
where
    F: Future<Output = Result<T, OpenAIError>>,
{
    if cancellation_requested(&cancellation) {
        return Err(provider_cancelled_error());
    }
    let timed_request = tokio::time::timeout(timeout, request);
    let result = if let Some(cancellation) = cancellation {
        tokio::select! {
            biased;
            _ = wait_for_provider_cancellation(cancellation) => {
                return Err(provider_cancelled_error());
            }
            result = timed_request => result,
        }
    } else {
        timed_request.await
    };
    result
        .map_err(|_| provider_timeout_error(timeout))?
        .map_err(provider_openai_error)
}

async fn next_provider_stream_chunk(
    stream: &mut async_openai::types::stream::StreamResponse<Value>,
    idle_timeout: Duration,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Option<Result<Value, OpenAIError>>, NativeChatRouteError> {
    if cancellation_requested(&cancellation) {
        return Err(provider_cancelled_error());
    }
    let next_chunk = tokio::time::timeout(idle_timeout, stream.next());
    let result = if let Some(cancellation) = cancellation {
        tokio::select! {
            biased;
            _ = wait_for_provider_cancellation(cancellation) => {
                return Err(provider_cancelled_error());
            }
            result = next_chunk => result,
        }
    } else {
        next_chunk.await
    };
    result.map_err(|_| provider_stream_idle_timeout_error(idle_timeout))
}

fn cancellation_requested(cancellation: &Option<Arc<dyn WorkerRequestCancellation>>) -> bool {
    cancellation
        .as_ref()
        .is_some_and(|cancellation| cancellation.is_cancelled())
}

async fn wait_for_provider_cancellation(cancellation: Arc<dyn WorkerRequestCancellation>) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
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

fn observe_stream_chunk(chunk: &Value, observer: &mut dyn FnMut(NativeProviderStreamEvent)) {
    if let Some(delta) = chunk
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .filter(|delta| !delta.is_empty())
    {
        observer(NativeProviderStreamEvent::ContentDelta(delta.to_string()));
    }
    if let Some(delta) = chunk
        .pointer("/choices/0/delta/reasoning_content")
        .or_else(|| chunk.pointer("/choices/0/delta/reasoningContent"))
        .and_then(Value::as_str)
        .filter(|delta| !delta.is_empty())
    {
        observer(NativeProviderStreamEvent::ReasoningDelta(delta.to_string()));
    }
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

fn provider_openai_error(error: OpenAIError) -> NativeChatRouteError {
    let is_transport = matches!(
        &error,
        OpenAIError::Reqwest(_) | OpenAIError::StreamError(_)
    );
    if is_transport {
        chat_error(
            503,
            error.to_string(),
            "provider_transport_error",
            "provider_transport_error",
        )
    } else {
        chat_error(
            503,
            error.to_string(),
            "provider_error",
            "provider_request_failed",
        )
    }
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

fn provider_stream_idle_timeout_error(timeout: Duration) -> NativeChatRouteError {
    chat_error(
        504,
        format!("provider stream was idle for {} ms", timeout.as_millis()),
        "provider_stream_idle_timeout",
        "provider_stream_idle_timeout",
    )
}

fn provider_cancelled_error() -> NativeChatRouteError {
    chat_error(
        499,
        "provider request was cancelled",
        "provider_cancelled",
        "provider_cancelled",
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
        stream_idle_timeout_ms,
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
    use crate::worker_protocol::WorkerRequestCancellation;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
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
    fn provider_catalog_exposes_current_built_in_providers_only() {
        let body = provider_catalog_body(&json!({}));
        let provider_ids = body["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(provider_ids, vec!["openai", "deepseek", "dashscope"]);
        assert!(!provider_ids.contains(&"openrouter"));
        assert!(!provider_ids.contains(&"ollama"));
        assert!(!provider_ids.contains(&"custom"));
    }

    #[test]
    fn resolves_provider_profile_from_config_and_defaults() {
        let profile = resolve_provider_profile(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
                "providers": { "openai": {
                    "api_key": "sk-secret",
                    "models": ["gpt-4.1-custom"],
                    "request_timeout_ms": 900,
                    "stream_idle_timeout_ms": 125
                } }
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
        assert_eq!(profile.request_timeout_ms, 900);
        assert_eq!(profile.stream_idle_timeout_ms, 125);
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
    fn provider_models_fetches_openai_compatible_model_list() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 2048];
                let _ = stream.read(&mut buffer);
                let body = r#"{"object":"list","data":[{"id":"live-a","object":"model","created":1,"owned_by":"test"},{"id":"live-b","object":"model","created":1,"owned_by":"test"}]}"#;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });

        let result = list_provider_models(
            &json!({
                "providers": {
                    "openai": {
                        "api_key": "sk-test",
                        "api_base": api_base
                    }
                }
            }),
            NativeProviderModelsRequest {
                provider_id: Some("openai".to_string()),
                refresh_live: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let _ = server.join();

        assert!(result.ok);
        assert!(result.models.contains(&"live-a".to_string()));
        assert!(result.models.contains(&"live-b".to_string()));
        assert_eq!(result.sources["live"], 2);
    }

    #[test]
    fn dashscope_models_use_openai_compatible_discovery() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 2048];
                let _ = stream.read(&mut buffer);
                let body = r#"{"object":"list","data":[{"id":"qwen-live","object":"model","created":1,"owned_by":"test"}]}"#;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });

        let result = list_provider_models(
            &json!({
                "providers": {
                    "dashscope": {
                        "api_key": "sk-test",
                        "api_base": api_base
                    }
                }
            }),
            NativeProviderModelsRequest {
                provider_id: Some("dashscope".to_string()),
                refresh_live: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let _ = server.join();

        assert!(result.ok);
        assert!(result.models.contains(&"qwen-plus".to_string()));
        assert!(result.models.contains(&"qwen-live".to_string()));
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
    fn agent_chat_completion_preserves_streaming_request_to_provider() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 8192];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let is_streaming = request.contains(r#""stream":true"#);
                let _ = request_tx.send(request);
                let body = if is_streaming {
                    concat!(
                        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"streamed\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                        "data: [DONE]\n\n"
                    )
                } else {
                    r#"{"id":"chatcmpl-test","object":"chat.completion","created":1,"model":"gpt-test","choices":[{"index":0,"message":{"role":"assistant","content":"not streamed"},"finish_reason":"stop"}]}"#
                };
                let content_type = if is_streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });

        let result = complete_chat_for_agent(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
                "providers": {
                    "openai": {
                        "api_key": "sk-test",
                        "api_base": api_base,
                        "timeout_ms": 500
                    }
                }
            }),
            &json!({
                "model": "gpt-test",
                "messages": [{ "role": "user", "content": "hello" }],
                "stream": true
            }),
        )
        .expect("streaming agent completion should aggregate provider chunks");
        let captured_request = request_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("provider request should be captured");
        let _ = server.join();

        assert!(captured_request.contains(r#""stream":true"#));
        assert_eq!(result["choices"][0]["message"]["content"], "streamed");
    }

    #[test]
    fn aggregates_streaming_tool_call_chunks_for_agent_completion() {
        let completion = aggregate_chat_completion_sse(concat!(
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"workspace.read_file\",\"arguments\":\"{\\\"path\\\"\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"README.md\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ))
        .expect("streaming tool call chunks should aggregate");

        assert_eq!(
            completion["choices"][0]["message"]["tool_calls"][0]["id"],
            "call-1"
        );
        assert_eq!(
            completion["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "workspace.read_file"
        );
        assert_eq!(
            completion["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"README.md\"}"
        );
    }

    #[test]
    fn aggregates_streaming_reasoning_and_usage_for_agent_completion() {
        let completion = aggregate_chat_completion_sse(concat!(
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"think \"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"reasoningContent\":\"again\",\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":5,\"total_tokens\":12}}\n\n",
            "data: [DONE]\n\n"
        ))
        .expect("streaming reasoning and usage chunks should aggregate");

        assert_eq!(
            completion["choices"][0]["message"]["reasoning_content"],
            "think again"
        );
        assert_eq!(completion["choices"][0]["message"]["content"], "done");
        assert_eq!(completion["usage"]["prompt_tokens"], 7);
        assert_eq!(completion["usage"]["completion_tokens"], 5);
        assert_eq!(completion["usage"]["total_tokens"], 12);
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

    #[test]
    fn async_agent_chat_reports_request_timeout_separately() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let stalled_server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 512];
                let _ = stream.read(&mut buffer);
                thread::sleep(Duration::from_millis(250));
            }
        });
        let mut observer = |_event: NativeProviderStreamEvent| {};

        let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
                "providers": { "openai": {
                    "api_key": "sk-test",
                    "api_base": api_base,
                    "request_timeout_ms": 25
                } }
            }),
            &json!({
                "model": "gpt-test",
                "messages": [{ "role": "user", "content": "hello" }]
            }),
            &mut observer,
            None,
        ))
        .expect_err("stalled request should time out");

        let _ = stalled_server.join();
        assert_eq!(error.kind(), NativeProviderFailureKind::RequestTimeout);
    }

    #[test]
    fn async_agent_stream_reports_idle_timeout_after_partial_output() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 8192];
                let _ = stream.read(&mut buffer);
                let event = "data: {\"id\":\"chatcmpl-idle\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n";
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{:X}\r\n{}\r\n",
                    event.len(),
                    event
                );
                let _ = stream.flush();
                thread::sleep(Duration::from_millis(250));
            }
        });
        let mut observed = Vec::new();
        let mut observer = |event: NativeProviderStreamEvent| observed.push(event);

        let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
                "providers": { "openai": {
                    "api_key": "sk-test",
                    "api_base": api_base,
                    "request_timeout_ms": 500,
                    "stream_idle_timeout_ms": 25
                } }
            }),
            &json!({
                "model": "gpt-test",
                "messages": [{ "role": "user", "content": "hello" }],
                "stream": true
            }),
            &mut observer,
            None,
        ))
        .expect_err("stalled stream should hit its idle timeout");

        let _ = server.join();
        assert_eq!(error.kind(), NativeProviderFailureKind::StreamIdleTimeout);
        assert_eq!(
            observed,
            vec![NativeProviderStreamEvent::ContentDelta("first".to_string())]
        );
    }

    #[test]
    fn async_agent_stream_stops_observing_after_partial_output_cancellation() {
        struct TestCancellation(Arc<AtomicBool>);

        impl WorkerRequestCancellation for TestCancellation {
            fn is_cancelled(&self) -> bool {
                self.0.load(Ordering::SeqCst)
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let api_base = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 8192];
                let _ = stream.read(&mut buffer);
                let body = concat!(
                    "data: {\"id\":\"chatcmpl-cancel\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n",
                    "data: {\"id\":\"chatcmpl-cancel\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"late\"},\"finish_reason\":null}]}\n\n",
                    "data: [DONE]\n\n"
                );
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.flush();
            }
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = Arc::new(TestCancellation(cancelled.clone()));
        let observer_cancellation = cancelled.clone();
        let mut observed = Vec::new();
        let mut observer = |event: NativeProviderStreamEvent| {
            observed.push(event);
            observer_cancellation.store(true, Ordering::SeqCst);
        };

        let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
            &json!({
                "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
                "providers": { "openai": {
                    "api_key": "sk-test",
                    "api_base": api_base,
                    "request_timeout_ms": 500,
                    "stream_idle_timeout_ms": 500
                } }
            }),
            &json!({
                "model": "gpt-test",
                "messages": [{ "role": "user", "content": "hello" }],
                "stream": true
            }),
            &mut observer,
            Some(cancellation),
        ))
        .expect_err("stream cancellation should stop before a second delta");

        let _ = server.join();
        assert_eq!(error.kind(), NativeProviderFailureKind::Cancelled);
        assert_eq!(
            observed,
            vec![NativeProviderStreamEvent::ContentDelta("first".to_string())]
        );
    }

    #[test]
    fn async_agent_chat_honors_cancellation_before_provider_request() {
        struct TestCancellation(Arc<AtomicBool>);

        impl WorkerRequestCancellation for TestCancellation {
            fn is_cancelled(&self) -> bool {
                self.0.load(Ordering::SeqCst)
            }
        }

        let cancellation = Arc::new(TestCancellation(Arc::new(AtomicBool::new(true))));
        let mut observer = |_event: NativeProviderStreamEvent| {};
        let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
            &json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": { "fixture": { "responses": [{ "content": "unused" }] } }
            }),
            &json!({
                "model": "fixture-model",
                "messages": [{ "role": "user", "content": "hello" }]
            }),
            &mut observer,
            Some(cancellation),
        ))
        .expect_err("cancelled request should not reach the fixture provider");

        assert_eq!(error.kind(), NativeProviderFailureKind::Cancelled);
    }
}
