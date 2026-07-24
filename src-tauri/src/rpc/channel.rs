use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use serde::Deserialize;
use serde_json::Value;

use crate::protocol::params::parse_params;

#[derive(Clone, Debug)]
pub(super) struct WorkerChannelConnectorRpc {
    policy: CapabilityPolicy,
}

impl WorkerChannelConnectorRpc {
    pub(super) fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    pub(super) fn start_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.start(parse_params(request)?)
    }

    pub(super) fn stop_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.stop(parse_params(request)?)
    }

    pub(super) fn login_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.login(parse_params(request)?)
    }

    pub(super) fn send_text_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.send_text(parse_params(request)?)
    }

    pub(super) fn send_delta_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.send_delta(parse_params(request)?)
    }

    pub(super) fn send_usage_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.send_usage(parse_params(request)?)
    }

    pub(super) fn transcribe_audio_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.transcribe_audio(parse_params(request)?)
    }

    fn start(&self, params: ChannelConnectorParams) -> Result<Value, WorkerProtocolError> {
        self.unavailable(params.channel, "start")
    }

    fn stop(&self, params: ChannelConnectorParams) -> Result<Value, WorkerProtocolError> {
        self.unavailable(params.channel, "stop")
    }

    fn login(&self, params: ChannelConnectorParams) -> Result<Value, WorkerProtocolError> {
        self.unavailable(params.channel, "login")
    }

    fn send_text(&self, params: ChannelConnectorParams) -> Result<Value, WorkerProtocolError> {
        self.unavailable(params.channel, "send_text")
    }

    fn send_delta(&self, params: ChannelConnectorParams) -> Result<Value, WorkerProtocolError> {
        self.unavailable(params.channel, "send_delta")
    }

    fn send_usage(&self, params: ChannelConnectorParams) -> Result<Value, WorkerProtocolError> {
        self.unavailable(params.channel, "send_usage")
    }

    fn transcribe_audio(
        &self,
        params: ChannelConnectorParams,
    ) -> Result<Value, WorkerProtocolError> {
        self.unavailable(params.channel, "transcribe_audio")
    }

    fn unavailable(&self, channel: String, operation: &str) -> Result<Value, WorkerProtocolError> {
        self.require()?;
        Ok(serde_json::json!({
            "ok": true,
            "channel": channel,
            "operation": operation,
            "handled": false,
            "reason": "native_connector_unavailable",
        }))
    }

    fn require(&self) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&WorkerCapability::ChannelConnector) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": WorkerCapability::ChannelConnector }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Deserialize)]
struct ChannelConnectorParams {
    channel: String,
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
