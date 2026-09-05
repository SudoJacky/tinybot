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
        self.unavailable(
            parse_params::<ChannelConnectorParams>(request)?.channel,
            "start",
        )
    }

    pub(super) fn stop_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.unavailable(
            parse_params::<ChannelConnectorParams>(request)?.channel,
            "stop",
        )
    }

    pub(super) fn login_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.unavailable(
            parse_params::<ChannelConnectorParams>(request)?.channel,
            "login",
        )
    }

    pub(super) fn send_text_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.unavailable(
            parse_params::<ChannelConnectorParams>(request)?.channel,
            "send_text",
        )
    }

    pub(super) fn send_delta_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.unavailable(
            parse_params::<ChannelConnectorParams>(request)?.channel,
            "send_delta",
        )
    }

    pub(super) fn send_usage_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.unavailable(
            parse_params::<ChannelConnectorParams>(request)?.channel,
            "send_usage",
        )
    }

    pub(super) fn transcribe_audio_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.unavailable(
            parse_params::<ChannelConnectorParams>(request)?.channel,
            "transcribe_audio",
        )
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
