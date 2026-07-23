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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn form_request_returns_awaiting_form_result() {
        let form = json!({
            "form_id": "travel_plan",
            "title": "Travel plan",
            "fields": [
                { "name": "destination", "type": "text", "label": "Destination" }
            ]
        });
        let rpc = WorkerFormRpc::new(CapabilityPolicy::new([WorkerCapability::FormRequest]));
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "form.request",
            json!({
                "turn_id": "run-1",
                "session_id": "session-1",
                "form": form,
                "continuation_mode": "resume"
            }),
        );

        let response = rpc
            .request_from_request(&request)
            .expect("form request should return result");

        assert_eq!(
            response,
            json!({
                "content": "Waiting for form submission.",
                "awaitingUserInput": true,
                "stopReason": "awaiting_form",
                "formId": "travel_plan",
                "form": form,
                "continuationMode": "resume",
                "turnId": "run-1",
                "sessionId": "session-1"
            })
        );
    }

    #[test]
    fn form_request_rejects_missing_form_id() {
        let rpc = WorkerFormRpc::new(CapabilityPolicy::new([WorkerCapability::FormRequest]));
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "form.request",
            json!({
                "turn_id": "run-1",
                "form": { "fields": [] }
            }),
        );

        let error = rpc
            .request_from_request(&request)
            .expect_err("missing form_id should fail");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.message, "form.form_id must be a non-empty string");
    }

    #[test]
    fn form_request_requires_form_capability() {
        let rpc = WorkerFormRpc::new(CapabilityPolicy::new([]));
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "form.request",
            json!({
                "turn_id": "run-1",
                "form": { "form_id": "travel_plan" }
            }),
        );

        let error = rpc
            .request_from_request(&request)
            .expect_err("missing capability should fail");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "form.request");
    }
}
