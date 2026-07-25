use super::*;
use crate::rpc::WorkerRpcRouter;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

fn channel_rpc(policy: CapabilityPolicy) -> WorkerChannelConnectorRpc {
    WorkerChannelConnectorRpc::new(policy)
}

fn fixture_root(name: &str) -> std::path::PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "tinybot-worker-rpc-channel-{name}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).expect("channel fixture root should be created");
    root
}

#[test]
fn channel_connector_send_text_returns_explicit_unavailable_bridge_result() {
    let rpc = channel_rpc(CapabilityPolicy::new([WorkerCapability::ChannelConnector]));
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "channel.connector.send_text",
        json!({
            "channel": "feishu",
            "chat_id": "oc_1",
            "content": "hello",
            "media": ["file://a.png"],
            "metadata": { "reply_kind": "text" },
            "reply_to": "msg-1"
        }),
    );

    let result = rpc
        .send_text_from_request(&request)
        .expect("send_text should return unavailable result");

    assert_eq!(result["ok"], true);
    assert_eq!(result["channel"], "feishu");
    assert_eq!(result["operation"], "send_text");
    assert_eq!(result["handled"], false);
    assert_eq!(result["reason"], "native_connector_unavailable");
}

#[test]
fn channel_connector_dispatch_routes_to_channel_module() {
    let root = fixture_root("dispatch");
    let mut router = WorkerRpcRouter::new(
        root,
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ChannelConnector]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "channel.connector.send_text",
        json!({
            "channel": "feishu",
            "content": "hello"
        }),
    );

    let response = router.dispatch(&request);

    assert!(response.error.is_none());
    let result = response.result.expect("connector result should be present");
    assert_eq!(result["channel"], "feishu");
    assert_eq!(result["operation"], "send_text");
    assert_eq!(result["reason"], "native_connector_unavailable");
}

#[test]
fn channel_connector_login_returns_explicit_unavailable_bridge_result() {
    let rpc = channel_rpc(CapabilityPolicy::new([WorkerCapability::ChannelConnector]));
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "channel.connector.login",
        json!({
            "channel": "weixin",
            "force": true
        }),
    );

    let result = rpc
        .login_from_request(&request)
        .expect("login should return unavailable result");

    assert_eq!(result["ok"], true);
    assert_eq!(result["channel"], "weixin");
    assert_eq!(result["operation"], "login");
    assert_eq!(result["handled"], false);
    assert_eq!(result["reason"], "native_connector_unavailable");
}

#[test]
fn channel_connector_transcribe_audio_returns_explicit_unavailable_bridge_result() {
    let rpc = channel_rpc(CapabilityPolicy::new([WorkerCapability::ChannelConnector]));
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "channel.connector.transcribe_audio",
        json!({
            "channel": "feishu",
            "file_path": "voice.opus",
            "api_key": "groq-key"
        }),
    );

    let result = rpc
        .transcribe_audio_from_request(&request)
        .expect("transcribe_audio should return unavailable result");

    assert_eq!(result["ok"], true);
    assert_eq!(result["channel"], "feishu");
    assert_eq!(result["operation"], "transcribe_audio");
    assert_eq!(result["handled"], false);
    assert_eq!(result["reason"], "native_connector_unavailable");
}

#[test]
fn channel_connector_methods_require_connector_capability() {
    let rpc = channel_rpc(CapabilityPolicy::default());
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "channel.connector.start",
        json!({ "channel": "feishu" }),
    );

    let error = rpc
        .start_from_request(&request)
        .expect_err("connector start should require channel capability");

    assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
    assert_eq!(error.details["capability"], "channel.connector");
}
