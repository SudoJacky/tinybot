use super::*;
use std::sync::{Arc, Mutex};

tokio::task_local! { static CALL: Arc<ProviderUsageCall>; }

/// A logical model request owns one or more separately identified HTTP attempts.
pub(crate) struct ProviderUsageCall {
    store: Option<DailyTokenUsageStore>,
    current: Mutex<UsageInvocation>,
}

impl ProviderUsageCall {
    pub fn begin(provider: String, model: String) -> Result<Arc<Self>, String> {
        let scope = UsageScope::current();
        let request_id =
            crate::protocol::request_id::next_worker_request_correlation().id("provider-call");
        let invocation = UsageInvocation {
            sequence: None,
            id: format!("{request_id}:0"),
            request_id,
            attempt: 0,
            date: Local::now().date_naive().to_string(),
            started_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
            provider_id: provider,
            model_id: model,
            origin: scope.origin,
            status: "pending".into(),
            usage: None,
        };
        if let Some(store) = &scope.store {
            store.begin_invocation(&invocation)?;
        }
        Ok(Arc::new(Self {
            store: scope.store,
            current: Mutex::new(invocation),
        }))
    }

    pub fn current() -> Option<Arc<Self>> {
        CALL.try_with(Arc::clone).ok()
    }

    pub async fn run<F: std::future::Future>(self: Arc<Self>, future: F) -> F::Output {
        CALL.scope(self, Box::pin(future)).await
    }

    pub fn retry(&self) -> Result<(), String> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Usage invocation lock poisoned")?;
        if let Some(store) = &self.store {
            store.finish_invocation(&current.id, "retry", None, None)?;
        }
        current.attempt += 1;
        current.id = format!("{}:{}", current.request_id, current.attempt);
        current.started_at = chrono::Utc::now().to_rfc3339();
        current.date = Local::now().date_naive().to_string();
        if let Some(store) = &self.store {
            store.begin_invocation(&current)?;
        }
        Ok(())
    }

    pub fn finish(&self, status: &str, response: Option<&Value>) -> Result<(), String> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Usage invocation lock poisoned")?;
        let usage = normalize_provider_token_usage(
            response
                .and_then(|r| r.get("usage"))
                .unwrap_or(&Value::Null),
        )?;
        let model = response
            .and_then(|r| r.get("model"))
            .and_then(Value::as_str);
        if let Some(store) = &self.store {
            store.finish_invocation(&current.id, status, model, usage.as_ref())?;
        }
        current.status = status.into();
        Ok(())
    }
}

impl Drop for ProviderUsageCall {
    fn drop(&mut self) {
        // A dropped request future still leaves an inspectable terminal record.
        // Process crashes leave 'pending' (an uncertain outcome), never a fake zero.
        let Ok(current) = self.current.get_mut() else {
            return;
        };
        if current.status == "pending" {
            if let Some(store) = &self.store {
                if let Err(error) = store.finish_invocation(&current.id, "interrupted", None, None)
                {
                    eprintln!(
                        "provider_usage_interruption_failed invocation_id={} error={error}",
                        current.id
                    );
                    crate::runtime::observability::global_agent_runtime_metrics()
                        .increment("provider.tokenUsage.persistence.failed");
                }
            }
        }
    }
}
