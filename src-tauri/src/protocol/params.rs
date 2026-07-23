use crate::protocol::{validate_protocol_version, WorkerProtocolError, WorkerRequest};
use serde::Deserialize;

pub fn validate_request(request: &WorkerRequest) -> Result<(), WorkerProtocolError> {
    validate_protocol_version(&request.protocol_version)
}

pub fn parse_params<T: for<'de> Deserialize<'de>>(
    request: &WorkerRequest,
) -> Result<T, WorkerProtocolError> {
    serde_json::from_value(request.params.clone()).map_err(|error| {
        WorkerProtocolError::new(
            crate::protocol::WorkerProtocolErrorCode::InvalidProtocol,
            "invalid worker request params",
            serde_json::json!({
                "method": request.method,
                "error": error.to_string(),
            }),
            false,
            crate::protocol::WorkerProtocolErrorSource::RustCore,
        )
    })
}

#[cfg(test)]
#[path = "params_tests.rs"]
mod tests;
