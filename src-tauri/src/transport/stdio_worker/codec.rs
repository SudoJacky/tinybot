use crate::protocol::{
    validate_protocol_version, WorkerEvent, WorkerProtocolError, WorkerProtocolErrorCode,
    WorkerProtocolErrorSource, WorkerRequest, WorkerResponse,
};
#[cfg(test)]
use crate::rpc::WorkerRpcRouter;
use serde_json::Value;
#[cfg(test)]
use std::io::{BufRead, Write};

#[derive(Clone, Debug, PartialEq)]
pub enum WorkerInboundMessage {
    Request(WorkerRequest),
    Response(WorkerResponse),
    Event(WorkerEvent),
}

#[derive(Debug)]
#[cfg(test)]
pub struct WorkerStdioTransport<R, W> {
    reader: R,
    writer: W,
}

#[cfg(test)]
impl<R, W> WorkerStdioTransport<R, W>
where
    R: BufRead,
    W: Write,
{
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }

    pub fn send_request(&mut self, request: &WorkerRequest) -> Result<(), WorkerProtocolError> {
        serde_json::to_writer(&mut self.writer, request).map_err(|error| {
            invalid_protocol_error(
                "failed to encode worker request",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.write_all(b"\n").map_err(|error| {
            invalid_protocol_error(
                "failed to write worker request",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.flush().map_err(|error| {
            invalid_protocol_error(
                "failed to flush worker request",
                serde_json::json!({ "error": error.to_string() }),
            )
        })
    }

    pub fn send_response(&mut self, response: &WorkerResponse) -> Result<(), WorkerProtocolError> {
        serde_json::to_writer(&mut self.writer, response).map_err(|error| {
            invalid_protocol_error(
                "failed to encode worker response",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.write_all(b"\n").map_err(|error| {
            invalid_protocol_error(
                "failed to write worker response",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        self.writer.flush().map_err(|error| {
            invalid_protocol_error(
                "failed to flush worker response",
                serde_json::json!({ "error": error.to_string() }),
            )
        })
    }

    pub fn read_message(&mut self) -> Result<Option<WorkerInboundMessage>, WorkerProtocolError> {
        let mut line = String::new();
        let bytes = self.reader.read_line(&mut line).map_err(|error| {
            invalid_protocol_error(
                "failed to read worker message",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        if bytes == 0 {
            return Ok(None);
        }
        decode_worker_line(line.trim_end_matches(['\r', '\n'])).map(Some)
    }

    #[cfg(test)]
    pub fn round_trip(
        &mut self,
        request: &WorkerRequest,
        mut on_event: impl FnMut(&WorkerEvent),
    ) -> Result<WorkerResponse, WorkerProtocolError> {
        self.send_request(request)?;
        loop {
            let Some(message) = self.read_message()? else {
                return Err(worker_error(
                    "worker stream ended before response",
                    serde_json::json!({
                        "id": request.id,
                        "trace_id": request.trace_id,
                    }),
                    true,
                ));
            };
            match message {
                WorkerInboundMessage::Request(request) => {
                    return Err(invalid_protocol_error(
                        "worker RPC request arrived during Rust request round trip",
                        serde_json::json!({
                            "id": request.id,
                            "trace_id": request.trace_id,
                            "method": request.method,
                        }),
                    ));
                }
                WorkerInboundMessage::Event(event) => on_event(&event),
                WorkerInboundMessage::Response(response) => {
                    if response.matches_request(request) {
                        return Ok(response);
                    }
                    return Err(invalid_protocol_error(
                        "worker response does not match request identity",
                        serde_json::json!({
                            "expected_id": request.id,
                            "expected_trace_id": request.trace_id,
                            "actual_id": response.id,
                            "actual_trace_id": response.trace_id,
                        }),
                    ));
                }
            }
        }
    }

    pub fn serve_rust_rpc_requests(
        &mut self,
        router: &mut WorkerRpcRouter,
        mut on_event: impl FnMut(&WorkerEvent),
    ) -> Result<(), WorkerProtocolError> {
        while let Some(message) = self.read_message()? {
            match message {
                WorkerInboundMessage::Request(request) => {
                    let response = router.dispatch(&request);
                    self.send_response(&response)?;
                }
                WorkerInboundMessage::Event(event) => on_event(&event),
                WorkerInboundMessage::Response(response) => {
                    return Err(invalid_protocol_error(
                        "worker response arrived while serving Rust RPC requests",
                        serde_json::json!({
                            "id": response.id,
                            "trace_id": response.trace_id,
                        }),
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn into_writer(self) -> W {
        self.writer
    }
}

pub fn decode_worker_line(line: &str) -> Result<WorkerInboundMessage, WorkerProtocolError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        invalid_protocol_error(
            "worker message is not valid JSON",
            serde_json::json!({ "error": error.to_string(), "line": line }),
        )
    })?;
    let version = value
        .get("protocol_version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            invalid_protocol_error(
                "worker message missing protocol_version",
                serde_json::json!({ "message": value }),
            )
        })?;
    validate_protocol_version(version)?;

    if value.get("method").is_some() {
        let request: WorkerRequest = serde_json::from_value(value).map_err(|error| {
            invalid_protocol_error(
                "worker request has invalid shape",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        return Ok(WorkerInboundMessage::Request(request));
    }

    if value.get("id").is_some() {
        let response: WorkerResponse = serde_json::from_value(value).map_err(|error| {
            invalid_protocol_error(
                "worker response has invalid shape",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        return Ok(WorkerInboundMessage::Response(response));
    }

    if value.get("event").is_some() {
        let event: WorkerEvent = serde_json::from_value(value).map_err(|error| {
            invalid_protocol_error(
                "worker event has invalid shape",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        return Ok(WorkerInboundMessage::Event(event));
    }

    Err(invalid_protocol_error(
        "worker message is neither response nor event",
        serde_json::json!({ "message": value }),
    ))
}

fn invalid_protocol_error(message: impl Into<String>, details: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
fn worker_error(
    message: impl Into<String>,
    details: Value,
    retryable: bool,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        retryable,
        WorkerProtocolErrorSource::Worker,
    )
}

#[cfg(test)]
#[path = "codec_tests.rs"]
mod tests;
