use super::*;
use crate::protocol::capability::default_desktop_capability_policy;
use crate::protocol::WorkerRequest;
use crate::rpc::native_request_router;
use crate::threads::domain::ReadThreadRequest;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static WORKSPACE_STORE_TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn workspace_root(label: &str) -> PathBuf {
    let sequence = WORKSPACE_STORE_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "tinybot-workspace-thread-store-{}-{sequence}-{label}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("workspace store test root should create");
    root
}

#[test]
fn short_lived_routers_share_one_workspace_store() {
    let root = workspace_root("router-reuse");
    let store = WorkspaceThreadStore::new(root.clone(), default_desktop_capability_policy());
    let clone = store.clone();
    assert!(Arc::ptr_eq(&store.inner, &clone.inner));

    let mut first_router = native_request_router(store.clone(), json!({}));
    let created = first_router.dispatch(&WorkerRequest::new(
        "req-workspace-store-create",
        "trace-workspace-store",
        "thread.create",
        json!({
            "threadId": "thread-workspace-store",
            "title": "Workspace Store"
        }),
    ));
    assert_eq!(created.error, None);
    drop(first_router);

    let mut second_router = native_request_router(store.clone(), json!({}));
    let read = second_router.dispatch(&WorkerRequest::new(
        "req-workspace-store-read",
        "trace-workspace-store",
        "thread.read",
        json!({ "threadId": "thread-workspace-store" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["thread"]["threadId"],
        "thread-workspace-store"
    );

    store
        .flush()
        .expect("workspace store flush should preserve usability");
    assert!(store.begin_operation().is_ok());
    store
        .shutdown()
        .expect("workspace store shutdown should drain writers");
    assert!(clone.begin_operation().is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn explicit_reload_recovers_domain_projection_from_canonical_rollout() {
    let root = workspace_root("projection-reload");
    let store = WorkspaceThreadStore::new(root.clone(), default_desktop_capability_policy());
    let mut router = native_request_router(store.clone(), json!({}));
    let created = router.dispatch(&WorkerRequest::new(
        "req-workspace-store-reload-create",
        "trace-workspace-store-reload",
        "thread.create",
        json!({
            "threadId": "thread-workspace-store-reload",
            "title": "Projection reload"
        }),
    ));
    assert_eq!(created.error, None);
    drop(router);

    let mut operation = store
        .begin_operation()
        .expect("workspace store operation should start");
    operation
        .thread_log()
        .append_thread_messages(
            "thread-workspace-store-reload",
            "turn-workspace-store-reload",
            vec![json!({
                "role": "user",
                "content": "recover this canonical message"
            })],
        )
        .expect("canonical rollout mutation should persist");
    let stale = operation
        .thread()
        .read_thread(ReadThreadRequest {
            thread_id: "thread-workspace-store-reload".to_string(),
            ..ReadThreadRequest::default()
        })
        .expect("stale domain projection should remain readable");
    assert!(stale.items.is_empty());

    operation
        .reload_projection()
        .expect("explicit recovery should reload the canonical rollout");
    let recovered = operation
        .thread()
        .read_thread(ReadThreadRequest {
            thread_id: "thread-workspace-store-reload".to_string(),
            ..ReadThreadRequest::default()
        })
        .expect("recovered domain projection should be readable");
    assert!(recovered.items.iter().any(|item| {
        serde_json::to_value(&item.kind)
            .expect("thread item kind should serialize")
            .to_string()
            .contains("recover this canonical message")
    }));
    drop(operation);

    store
        .shutdown()
        .expect("workspace store shutdown should drain writers");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn failed_reload_leaves_projection_uninitialized_for_the_next_operation() {
    let root = workspace_root("reload-retry");
    let store = WorkspaceThreadStore::new(root.clone(), default_desktop_capability_policy());
    drop(
        store
            .begin_operation()
            .expect("initial empty projection should load"),
    );

    let thread_root = root.join(".tinybot").join("threads");
    std::fs::create_dir_all(thread_root.parent().unwrap())
        .expect("thread storage parent should create");
    std::fs::write(&thread_root, "not a directory")
        .expect("invalid thread storage fixture should write");
    let mut operation = store
        .begin_operation()
        .expect("loaded projection should allow an operation");
    assert!(operation.reload_projection().is_err());
    drop(operation);
    assert!(
        !store
            .inner
            .lifecycle
            .lock()
            .expect("workspace store lifecycle should lock")
            .projection_loaded
    );

    std::fs::remove_file(&thread_root).expect("invalid thread storage fixture should remove");
    drop(
        store
            .begin_operation()
            .expect("next operation should retry projection loading"),
    );
    store
        .shutdown()
        .expect("workspace store shutdown should drain writers");
    let _ = std::fs::remove_dir_all(root);
}
