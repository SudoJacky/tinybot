use super::catalog::{
    active_profile_name, catalog_entry_by_id, configured_model, infer_provider_from_model,
    normalize_provider_id, resolve_provider_profile, string_field, NativeProviderProfile,
};
use super::streaming::{
    chat_completion_body, responses_body, NativeProviderStreamEvent, StreamingChatCompletion,
    StreamingResponsesCompletion,
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

    fn from_chat_error(error: NativeChatError) -> Self {
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

#[cfg(test)]
pub fn complete_responses_for_agent_with_observer(
    config: &Value,
    body: &Value,
    observer: &mut (dyn FnMut(NativeProviderStreamEvent) + Send),
) -> Result<Value, String> {
    tauri::async_runtime::block_on(complete_responses_for_agent_with_observer_async(
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
    let response =
        native_chat_completion_with_observer_async(config, body, Some(observer), cancellation)
            .await
            .map_err(NativeProviderFailure::from_chat_error)?;
    record_completed_provider_usage(config, body, &response).await?;
    Ok(response)
}

pub async fn complete_responses_for_agent_with_observer_async(
    config: &Value,
    body: &Value,
    observer: &mut (dyn FnMut(NativeProviderStreamEvent) + Send),
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeProviderFailure> {
    let response = native_responses_with_observer_async(config, body, Some(observer), cancellation)
        .await
        .map_err(NativeProviderFailure::from_chat_error)?;
    record_completed_provider_usage(config, body, &response).await?;
    Ok(response)
}

async fn record_completed_provider_usage(
    config: &Value,
    body: &Value,
    response: &Value,
) -> Result<(), NativeProviderFailure> {
    #[cfg(test)]
    {
        let _ = (config, body, response);
        Ok(())
    }
    #[cfg(not(test))]
    {
        let model_call_id =
            crate::protocol::request_id::next_worker_request_correlation().id("provider-call");
        let requested_model =
            string_field(body, "model").unwrap_or_else(|| configured_model(config));
        let provider_id = resolve_chat_provider_profile(config, &requested_model)
            .map(|profile| profile.provider_id)
            .unwrap_or_else(|| infer_provider_from_model(&requested_model));
        let model_id = string_field(response, "model").unwrap_or(requested_model);
        let usage = crate::token_usage::token_usage_from_provider(
            response.get("usage").unwrap_or(&Value::Null),
        );
        tauri::async_runtime::spawn_blocking(move || {
            crate::token_usage::DailyTokenUsageStore::global().record_model_call(
                &model_call_id,
                &provider_id,
                &model_id,
                &usage,
            )
        })
        .await
        .map_err(|error| {
            NativeProviderFailure::new(
                NativeProviderFailureKind::Provider,
                format!("token usage persistence task failed: {error}"),
            )
        })?
        .map(|_| ())
        .map_err(|error| {
            NativeProviderFailure::new(
                NativeProviderFailureKind::Provider,
                format!("completed provider call could not persist token usage: {error}"),
            )
        })
    }
}

#[derive(Clone, Debug)]
struct NativeChatRequest {
    model: String,
    stream: bool,
    body: Value,
}

#[derive(Clone, Debug)]
struct NativeResponsesRequest {
    model: String,
    stream: bool,
    body: Value,
}

#[derive(Clone, Debug)]
struct NativeChatError {
    message: String,
    code: &'static str,
}

async fn native_chat_completion_with_observer_async(
    config: &Value,
    body: &Value,
    observer: Option<&mut (dyn FnMut(NativeProviderStreamEvent) + Send)>,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeChatError> {
    if cancellation_requested(&cancellation) {
        return Err(provider_cancelled_error());
    }
    let request = parse_chat_request(config, body)?;
    let profile = resolve_chat_provider_profile(config, &request.model).ok_or_else(|| {
        chat_error(
            format!("provider for model '{}' is not configured", request.model),
            "provider_not_configured",
        )
    })?;

    if profile.provider_id == "fixture" {
        let content = fixture_chat_content(config)?;
        if request.stream && !content.is_empty() {
            if let Some(observer) = observer {
                observer(NativeProviderStreamEvent::ContentDelta(content.clone()));
            }
        }
        return Ok(chat_completion_body(&request.model, &content));
    }

    if request.stream {
        complete_openai_chat_stream(profile, request, observer, cancellation).await
    } else {
        complete_openai_chat(profile, request, cancellation).await
    }
}

async fn native_responses_with_observer_async(
    config: &Value,
    body: &Value,
    observer: Option<&mut (dyn FnMut(NativeProviderStreamEvent) + Send)>,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeChatError> {
    if cancellation_requested(&cancellation) {
        return Err(provider_cancelled_error());
    }
    let request = parse_responses_request(config, body)?;
    let profile = resolve_chat_provider_profile(config, &request.model).ok_or_else(|| {
        chat_error(
            format!("provider for model '{}' is not configured", request.model),
            "provider_not_configured",
        )
    })?;

    if profile.provider_id == "fixture" {
        let content = fixture_chat_content(config)?;
        if request.stream && !content.is_empty() {
            if let Some(observer) = observer {
                observer(NativeProviderStreamEvent::ContentDelta(content.clone()));
            }
        }
        return Ok(responses_body(&request.model, &content));
    }

    if request.stream {
        complete_openai_responses_stream(profile, request, observer, cancellation).await
    } else {
        complete_openai_responses(profile, request, cancellation).await
    }
}

fn parse_chat_request(config: &Value, body: &Value) -> Result<NativeChatRequest, NativeChatError> {
    if !body.is_object() {
        return Err(chat_error(
            "request body must be a JSON object",
            "invalid_body",
        ));
    }
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| chat_error("messages must be a non-empty array", "invalid_messages"))?;
    if messages.is_empty() {
        return Err(chat_error(
            "messages must be a non-empty array",
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
            "each message must be an object with a role",
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

fn parse_responses_request(
    config: &Value,
    body: &Value,
) -> Result<NativeResponsesRequest, NativeChatError> {
    if !body.is_object() {
        return Err(chat_error(
            "request body must be a JSON object",
            "invalid_body",
        ));
    }
    let valid_input = match body.get("input") {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(input)) => !input.trim().is_empty(),
        _ => false,
    };
    if !valid_input {
        return Err(chat_error(
            "input must be a non-empty string or array",
            "invalid_input",
        ));
    }

    let model = string_field(body, "model").unwrap_or_else(|| configured_model(config));
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut request_body = body.clone();
    request_body["model"] = Value::String(model.clone());
    request_body["stream"] = Value::Bool(stream);

    Ok(NativeResponsesRequest {
        model,
        stream,
        body: request_body,
    })
}

async fn complete_openai_chat(
    profile: NativeProviderProfile,
    mut request: NativeChatRequest,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeChatError> {
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
) -> Result<Value, NativeChatError> {
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
    let mut completion = StreamingChatCompletion::default();
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
                if let Some(ref mut observer) = observer {
                    let observer_started_at = Instant::now();
                    completion
                        .push_chunk(&chunk, Some(&mut **observer))
                        .map_err(provider_stream_reduction_error)?;
                    metrics.record_duration(
                        "provider.stream.observer.durationMs",
                        observer_started_at.elapsed(),
                    );
                } else {
                    completion
                        .push_chunk(&chunk, None)
                        .map_err(provider_stream_reduction_error)?;
                }
                if cancellation_requested(&cancellation) {
                    return Err(provider_cancelled_error());
                }
            }
            Err(error) => return Err(provider_openai_error(error)),
        }
    }
    Ok(completion.finish())
}

async fn complete_openai_responses(
    profile: NativeProviderProfile,
    mut request: NativeResponsesRequest,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeChatError> {
    request.body["stream"] = Value::Bool(false);
    let timeout = Duration::from_millis(profile.request_timeout_ms.max(1));
    let client = openai_client(profile)?;
    await_provider_request(
        client.responses().create_byot(request.body),
        timeout,
        cancellation,
    )
    .await
}

async fn complete_openai_responses_stream(
    profile: NativeProviderProfile,
    mut request: NativeResponsesRequest,
    mut observer: Option<&mut (dyn FnMut(NativeProviderStreamEvent) + Send)>,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<Value, NativeChatError> {
    request.body["stream"] = Value::Bool(true);
    let request_timeout = Duration::from_millis(profile.request_timeout_ms.max(1));
    let stream_idle_timeout = Duration::from_millis(profile.stream_idle_timeout_ms.max(1));
    let client = openai_client(profile)?;
    let mut stream: async_openai::types::stream::StreamResponse<Value> = await_provider_request(
        client.responses().create_stream_byot(request.body),
        request_timeout,
        cancellation.clone(),
    )
    .await?;
    let mut completion = StreamingResponsesCompletion::default();
    while let Some(event) =
        next_provider_stream_chunk(&mut stream, stream_idle_timeout, cancellation.clone()).await?
    {
        match event {
            Ok(event) => {
                let metrics = crate::runtime::observability::global_agent_runtime_metrics();
                metrics.increment("provider.stream.chunk.received");
                if cancellation_requested(&cancellation) {
                    return Err(provider_cancelled_error());
                }
                if let Some(ref mut observer) = observer {
                    let observer_started_at = Instant::now();
                    completion
                        .push_event(&event, Some(&mut **observer))
                        .map_err(provider_stream_reduction_error)?;
                    metrics.record_duration(
                        "provider.stream.observer.durationMs",
                        observer_started_at.elapsed(),
                    );
                } else {
                    completion
                        .push_event(&event, None)
                        .map_err(provider_stream_reduction_error)?;
                }
                if cancellation_requested(&cancellation) {
                    return Err(provider_cancelled_error());
                }
            }
            Err(error) => return Err(provider_openai_error(error)),
        }
    }
    completion.finish().map_err(provider_stream_reduction_error)
}

async fn await_provider_request<T, F>(
    request: F,
    timeout: Duration,
    cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
) -> Result<T, NativeChatError>
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
) -> Result<Option<Result<Value, OpenAIError>>, NativeChatError> {
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

fn openai_client(profile: NativeProviderProfile) -> Result<Client<OpenAIConfig>, NativeChatError> {
    let api_base = profile
        .api_base
        .as_deref()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/');
    if api_base.is_empty() {
        return Err(chat_error(
            format!("provider '{}' requires api_base", profile.provider_id),
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
            format!("provider '{}' requires an API key", profile.provider_id),
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
    let provider_id = config
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| string_field(defaults, "provider"))
        .map(|provider| normalize_provider_id(&provider))
        .filter(|provider| !provider.is_empty() && provider != "auto")
        .or_else(|| {
            active_profile_name(config).and_then(|profile_name| {
                resolve_provider_profile(config, None, Some(&profile_name))
                    .map(|profile| profile.provider_id)
            })
        })
        .unwrap_or_else(|| infer_provider_from_model(model));
    resolve_provider_profile(config, Some(&provider_id), None)
}

fn provider_requires_api_key(profile: &NativeProviderProfile) -> bool {
    catalog_entry_by_id(&profile.provider_id).is_some_and(|entry| {
        !entry.api_key_env_vars.is_empty() && !entry.categories.contains(&"local")
    })
}

fn fixture_chat_content(config: &Value) -> Result<String, NativeChatError> {
    let response = config
        .get("providers")
        .and_then(|providers| providers.get("fixture"))
        .and_then(|fixture| fixture.get("responses"))
        .and_then(Value::as_array)
        .and_then(|responses| responses.first())
        .ok_or_else(|| {
            chat_error(
                "fixture provider has no queued response",
                "fixture_response_missing",
            )
        })?;
    Ok(string_field(response, "content").unwrap_or_default())
}

fn chat_error(message: impl Into<String>, code: &'static str) -> NativeChatError {
    NativeChatError {
        message: message.into(),
        code,
    }
}

fn provider_openai_error(error: OpenAIError) -> NativeChatError {
    let is_transport = matches!(
        &error,
        OpenAIError::Reqwest(_) | OpenAIError::StreamError(_)
    );
    if is_transport {
        chat_error(error.to_string(), "provider_transport_error")
    } else {
        chat_error(error.to_string(), "provider_request_failed")
    }
}

fn provider_stream_reduction_error(error: String) -> NativeChatError {
    chat_error(error, "provider_stream_error")
}

fn provider_timeout_error(timeout: Duration) -> NativeChatError {
    chat_error(
        format!(
            "provider request timed out after {} ms",
            timeout.as_millis()
        ),
        "provider_timeout",
    )
}

fn provider_stream_idle_timeout_error(timeout: Duration) -> NativeChatError {
    chat_error(
        format!("provider stream was idle for {} ms", timeout.as_millis()),
        "provider_stream_idle_timeout",
    )
}

fn provider_cancelled_error() -> NativeChatError {
    chat_error("provider request was cancelled", "provider_cancelled")
}
