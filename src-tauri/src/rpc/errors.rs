use crate::protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};

use super::method::classify_method;

pub fn unknown_method_error(request: &WorkerRequest) -> WorkerProtocolError {
    let namespace = classify_method(&request.method);
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "unknown worker RPC method",
        serde_json::json!({
            "method": request.method,
            "namespace": namespace.as_str()
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
#[path = "errors_tests.rs"]
mod tests;
