use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use serde::Deserialize;
use serde_json::Value;

use crate::protocol::params::parse_params;

#[derive(Clone, Debug)]
pub(super) struct WorkerFormRpc {
    policy: CapabilityPolicy,
}

impl WorkerFormRpc {
    pub(super) fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    pub(super) fn request_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.request(parse_params(request)?)
    }

    fn request(&self, params: FormRequestParams) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::FormRequest)?;
        let form = params.form;
        let form_id = form
            .get("form_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid_form_request("form.form_id must be a non-empty string"))?;
        let continuation_mode = params
            .continuation_mode
            .unwrap_or_else(|| "structured_message".to_string());
        if continuation_mode != "structured_message" && continuation_mode != "resume" {
            return Err(invalid_form_request(
                "continuation_mode must be structured_message or resume",
            ));
        }

        let mut result = serde_json::json!({
            "content": "Waiting for form submission.",
            "awaitingUserInput": true,
            "stopReason": "awaiting_form",
            "formId": form_id,
            "form": form,
            "continuationMode": continuation_mode,
            "turnId": params.turn_id,
        });
        if let Some(session_id) = params.session_id {
            result["sessionId"] = Value::String(session_id);
        }
        Ok(result)
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Deserialize)]
struct FormRequestParams {
    turn_id: String,
    #[serde(default)]
    session_id: Option<String>,
    form: Value,
    #[serde(default)]
    continuation_mode: Option<String>,
}

fn invalid_form_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "form.request" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
#[path = "form_tests.rs"]
mod tests;
