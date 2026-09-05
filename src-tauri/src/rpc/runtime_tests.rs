use super::*;
use crate::protocol::capability::CapabilityPolicy;
use crate::rpc::WorkerRpcRouter;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

fn fixture_root(name: &str) -> std::path::PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "tinybot-worker-rpc-runtime-{name}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).expect("runtime fixture root should be created");
    root
}

#[test]
fn runtime_restart_is_rejected_without_claiming_success() {
    let root = fixture_root("restart");
    let policy = CapabilityPolicy::default();
    let threads = crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
        root.clone(),
        root.join("data"),
        policy.clone(),
    );
    let mut router = WorkerRpcRouter::with_workspace_thread_store(threads, json!({}), 20, policy);
    let request = WorkerRequest::new(
        "req-restart",
        "trace-restart",
        "runtime.restart",
        json!({ "turnId": "turn-1", "sessionId": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert!(response.result.is_none());
    let error = response
        .error
        .expect("unsupported restart must return an error");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(error.message, "unknown worker RPC method");
    assert_eq!(error.details["method"], "runtime.restart");
}

#[test]
fn runtime_now_returns_current_time_with_timezone() {
    let request = WorkerRequest::new(
        "req-now",
        "trace-now",
        "runtime.now",
        json!({ "timezone": "Asia/Shanghai" }),
    );

    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock should be after the Unix epoch")
        .as_millis();
    let result = now_from_request(&request).expect("runtime now should return result");
    let after = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock should be after the Unix epoch")
        .as_millis();

    assert_eq!(result["timezone"], "Asia/Shanghai");
    let current_time = result["current_time"]
        .as_str()
        .expect("current_time should be a string");
    let millis = current_time
        .strip_prefix("unix-ms:")
        .and_then(|value| value.strip_suffix(" Asia/Shanghai"))
        .expect("current_time should contain its timestamp and timezone")
        .parse::<u128>()
        .expect("current_time should contain Unix milliseconds");
    assert!((before..=after).contains(&millis));

    let default_result = now_from_request(&WorkerRequest::new(
        "req-now-default",
        "trace-now-default",
        "runtime.now",
        json!({}),
    ))
    .expect("runtime now should default its timezone");
    assert_eq!(default_result["timezone"], "local");
    assert!(default_result["current_time"]
        .as_str()
        .expect("default current_time should be a string")
        .ends_with(" local"));
}

#[test]
fn runtime_metrics_returns_process_observability_snapshot() {
    crate::runtime::observability::global_agent_runtime_metrics().increment("turn.started");
    let mut router = WorkerRpcRouter::new(
        fixture_root("metrics"),
        json!({}),
        20,
        CapabilityPolicy::default(),
    );
    let request = WorkerRequest::new("req-metrics", "trace-metrics", "runtime.metrics", json!({}));

    let response = router.dispatch(&request);
    let result = response.result.expect("metrics result should be present");

    assert!(response.error.is_none());
    assert_eq!(result["schemaVersion"], 1);
    assert!(result["counters"]["turn.started"].as_u64().unwrap_or(0) >= 1);
    assert!(result["generatedAtUnixMs"].as_u64().is_some());
}
