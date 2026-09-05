use crate::protocol::{WorkerProtocolError, WorkerRequest};
use serde::Deserialize;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol::params::parse_params;

pub(super) fn now_from_request(request: &WorkerRequest) -> Result<Value, WorkerProtocolError> {
    let params: RuntimeNowParams = parse_params(request)?;
    Ok(runtime_now(params.timezone))
}

#[derive(Deserialize)]
struct RuntimeNowParams {
    timezone: Option<String>,
}

fn runtime_now(timezone: Option<String>) -> Value {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let timezone = timezone.unwrap_or_else(|| "local".to_string());
    serde_json::json!({
        "current_time": format!("unix-ms:{millis} {timezone}"),
        "timezone": timezone,
    })
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
