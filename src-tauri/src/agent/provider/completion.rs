use super::catalog::{
    catalog_entry_by_id, configured_model, infer_provider_from_model, normalize_provider_id,
    resolve_provider_profile, string_field, NativeProviderProfile,
};
use super::sse::{
    aggregate_chat_completion_sse, aggregate_chat_completion_sse_with_observer,
    chat_completion_body, chat_completion_sse, observe_stream_chunk, push_sse_json,
    NativeProviderStreamEvent,
};
use crate::protocol::WorkerRequestCancellation;
use async_openai::{config::OpenAIConfig, error::OpenAIError, Client};
use futures_util::StreamExt;
use serde_json::Value;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

#[cfg(test)]
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

#[cfg(test)]
pub fn complete_chat_for_agent(config: &Value, body: &Value) -> Result<Value, String> {
    let mut observer = |_event: NativeProviderStreamEvent| {};
    complete_chat_for_agent_with_observer(config, body, &mut observer)
}

#[cfg(test)]
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
                let metrics = crate::runtime::observability::global_agent_runtime_metrics();
                metrics.increment("provider.stream.chunk.received");
                if cancellation_requested(&cancellation) {
                    return Err(provider_cancelled_error());
                }
                if let Some(observer) = observer.as_deref_mut() {
                    let observer_started_at = Instant::now();
                    observe_stream_chunk(&chunk, observer);
                    metrics.record_duration(
                        "provider.stream.observer.durationMs",
                        observer_started_at.elapsed(),
                    );
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
