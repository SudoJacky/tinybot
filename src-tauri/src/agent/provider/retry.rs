//! Observable HTTP retries, before a response stream has started.
use async_openai::{
    config::OpenAIConfig,
    error::{ApiError, ApiErrorResponse, OpenAIError},
    middleware::HttpRequestFactory,
    Client,
};
use reqwest::{header::RETRY_AFTER, Response};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

const MAX_RETRIES: u32 = 3;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRetryStatus {
    pub attempt: u32,
    pub max_retries: u32,
    pub delay_ms: u64,
    pub reason: String,
}

pub(super) fn with_observed_retries(
    client: Client<OpenAIConfig>,
    progress: UnboundedSender<ProviderRetryStatus>,
) -> Client<OpenAIConfig> {
    let http = reqwest::Client::new();
    // Installing a service replaces the SDK's default retry executor. There is
    // exactly one retry budget, shared by streaming and non-streaming requests.
    client.with_http_service(tower::service_fn(move |factory: HttpRequestFactory| {
        let http = http.clone();
        let progress = progress.clone();
        retry_request(
            move || {
                let http = http.clone();
                let factory = factory.clone();
                async move { Ok(http.execute(factory.build().await?).await?) }
            },
            progress,
        )
    }))
}

async fn retry_request<F, Fut>(
    mut request: F,
    progress: UnboundedSender<ProviderRetryStatus>,
) -> Result<Response, OpenAIError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Response, OpenAIError>>,
{
    let mut backoff = 0;
    for attempt in 0..=MAX_RETRIES {
        let result = request().await;
        let retry_after = result
            .as_ref()
            .ok()
            .and_then(|response| response.headers().get(RETRY_AFTER))
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_secs);
        let (result, reason) = match result {
            Ok(response) if response.status().as_u16() == 429 => {
                #[derive(Deserialize)]
                struct WrappedError {
                    error: ApiError,
                }
                let status_code = response.status();
                let bytes = response.bytes().await?;
                let wrapped: WrappedError = serde_json::from_slice(&bytes).map_err(|error| {
                    OpenAIError::JSONDeserialize(
                        error,
                        String::from_utf8_lossy(&bytes).into_owned(),
                    )
                })?;
                let permanent = wrapped.error.r#type.as_deref() == Some("insufficient_quota");
                let error = OpenAIError::ApiError(ApiErrorResponse {
                    status_code,
                    api_error: wrapped.error,
                });
                if permanent {
                    return Err(error);
                }
                (Err(error), "rate_limit")
            }
            Ok(response) if response.status().is_server_error() => (Ok(response), "server_error"),
            Err(OpenAIError::Reqwest(error)) if error.is_connect() => {
                (Err(OpenAIError::Reqwest(error)), "connection_error")
            }
            result => return result,
        };
        if attempt == MAX_RETRIES {
            return result;
        }
        // Release unsuccessful responses before waiting, retaining no response body.
        drop(result);
        let delay = retry_after.unwrap_or_else(|| {
            let delay = Duration::from_millis(100 * (1 << backoff));
            backoff += 1;
            delay
        });
        let mut status = ProviderRetryStatus {
            attempt: attempt + 1,
            max_retries: MAX_RETRIES,
            delay_ms: delay.as_millis().min(u64::MAX as u128) as u64,
            reason: reason.into(),
        };
        // The receiver belongs to the awaiting request. Cancellation drops this
        // entire future (including the sleep); no detached retry task is spawned.
        progress
            .send(status.clone())
            .map_err(|_| OpenAIError::InvalidArgument("retry observer disconnected".into()))?;
        tokio::time::sleep(delay).await;
        status.delay_ms = 0;
        progress
            .send(status)
            .map_err(|_| OpenAIError::InvalidArgument("retry observer disconnected".into()))?;
    }
    unreachable!("retry loop always returns on its final attempt")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, body: &str, delay: Option<&str>) -> Response {
        let mut response = http::Response::builder().status(status);
        if let Some(delay) = delay {
            response = response.header(RETRY_AFTER, delay);
        }
        response.body(body.to_string()).unwrap().into()
    }

    #[tokio::test]
    async fn retry_budget_is_three_and_backoff_is_reported() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut calls = 0;
        let result = retry_request(
            || {
                calls += 1;
                std::future::ready(Ok(response(503, "unavailable", None)))
            },
            tx,
        )
        .await
        .unwrap();
        assert_eq!(calls, 4);
        assert_eq!(result.status(), 503);
        let mut updates = vec![];
        while let Ok(update) = rx.try_recv() {
            updates.push(update);
        }
        assert_eq!(
            updates
                .iter()
                .map(|s| (s.attempt, s.delay_ms))
                .collect::<Vec<_>>(),
            vec![(1, 100), (1, 0), (2, 200), (2, 0), (3, 400), (3, 0)]
        );
        assert!(updates
            .iter()
            .all(|s| s.max_retries == 3 && s.reason == "server_error"));
    }

    #[tokio::test]
    async fn permanent_errors_and_successful_error_text_do_not_retry() {
        for (status, body) in [
            (401, "unauthorized"),
            (400, "bad request"),
            (
                429,
                r#"{"error":{"message":"quota exceeded","type":"insufficient_quota"}}"#,
            ),
            (429, "invalid rate limit JSON"),
            (
                200,
                r#"{"choices":[{"message":{"role":"assistant","content":"[Error: Chat completion request failed]"}}]}"#,
            ),
        ] {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let mut calls = 0;
            let result = retry_request(
                || {
                    calls += 1;
                    std::future::ready(Ok(response(status, body, None)))
                },
                tx,
            )
            .await;
            assert_eq!(calls, 1, "status {status}");
            assert!(rx.try_recv().is_err());
            if status == 429 {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap().status(), status);
            }
        }
    }

    #[tokio::test]
    async fn retry_after_is_observable_and_dropping_wait_cancels_request() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut calls = 0;
        {
            let request = retry_request(
                || {
                    calls += 1;
                    std::future::ready(Ok(response(
                        429,
                        r#"{"error":{"message":"slow down","type":"rate_limit_error"}}"#,
                        Some("60"),
                    )))
                },
                tx,
            );
            tokio::pin!(request);
            tokio::select! {
                update = rx.recv() => {
                    let update = update.unwrap();
                    assert_eq!(update.delay_ms, 60_000);
                    assert_eq!(update.reason, "rate_limit");
                }
                _ = &mut request => panic!("request must still be waiting"),
            }
        }
        assert_eq!(calls, 1);
        assert!(
            rx.recv().await.is_none(),
            "no detached task should keep retrying"
        );
    }
}
