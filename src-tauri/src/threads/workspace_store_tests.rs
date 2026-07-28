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

#[test]
fn explicit_data_root_keeps_thread_persistence_out_of_workspace() {
    let root = workspace_root("explicit-data-root");
    let workspace = root.join("workspace");
    let data_root = root.join("data");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = WorkspaceThreadStore::new_with_data_root(
        workspace.clone(),
        data_root.clone(),
        default_desktop_capability_policy(),
    );
    let mut router = native_request_router(store.clone(), json!({}));
    let created = router.dispatch(&WorkerRequest::new(
        "req-explicit-data-root",
        "trace-explicit-data-root",
        "thread.create",
        json!({
            "threadId": "thread-explicit-data-root",
            "title": "Explicit data root"
        }),
    ));
    assert_eq!(created.error, None);
    drop(router);
    store.shutdown().unwrap();

    assert!(data_root.join("threads").exists());
    assert!(!data_root.join("state").join("state.sqlite").exists());
    assert!(!workspace.join(".tinybot").join("threads").exists());
    assert!(!workspace
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn obsolete_state_sqlite_is_left_untouched() {
    let root = workspace_root("obsolete-state-sqlite");
    let workspace = root.join("workspace");
    let data_root = root.join("data");
    let obsolete_state = data_root.join("state").join("state.sqlite");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(obsolete_state.parent().unwrap()).unwrap();
    std::fs::write(&obsolete_state, "obsolete-index-sentinel").unwrap();

    let store = WorkspaceThreadStore::new_with_data_root(
        workspace,
        data_root,
        default_desktop_capability_policy(),
    );
    let mut router = native_request_router(store.clone(), json!({}));
    let created = router.dispatch(&WorkerRequest::new(
        "req-obsolete-state-sqlite",
        "trace-obsolete-state-sqlite",
        "thread.create",
        json!({
            "threadId": "thread-obsolete-state-sqlite",
            "title": "Obsolete state SQLite"
        }),
    ));
    assert_eq!(created.error, None);
    drop(router);
    store.shutdown().unwrap();

    assert_eq!(
        std::fs::read_to_string(&obsolete_state).unwrap(),
        "obsolete-index-sentinel"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_workspace_thread_storage_migrates_and_rebuilds_the_index() {
    let root = workspace_root("legacy-storage-migration");
    let workspace = root.join("workspace");
    let data_root = root.join("data");
    std::fs::create_dir_all(&workspace).unwrap();
    let legacy = WorkspaceThreadStore::new(workspace.clone(), default_desktop_capability_policy());
    let mut router = native_request_router(legacy.clone(), json!({}));
    let created = router.dispatch(&WorkerRequest::new(
        "req-legacy-storage-create",
        "trace-legacy-storage-create",
        "thread.create",
        json!({
            "threadId": "thread-legacy-storage",
            "title": "Legacy storage"
        }),
    ));
    assert_eq!(created.error, None);
    drop(router);
    legacy.shutdown().unwrap();
    let legacy_state = workspace
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::create_dir_all(legacy_state.parent().unwrap()).unwrap();
    std::fs::write(&legacy_state, "obsolete derived index").unwrap();
    assert!(workspace
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());

    let report = migrate_legacy_thread_storage(&workspace, &data_root).unwrap();
    assert!(report.moved_file_count >= 1);
    assert!(report.removed_legacy_index);

    let migrated = WorkspaceThreadStore::new_with_data_root(
        workspace.clone(),
        data_root.clone(),
        default_desktop_capability_policy(),
    );
    let mut router = native_request_router(migrated.clone(), json!({}));
    let read = router.dispatch(&WorkerRequest::new(
        "req-legacy-storage-read",
        "trace-legacy-storage-read",
        "thread.read",
        json!({ "threadId": "thread-legacy-storage" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["thread"]["threadId"],
        "thread-legacy-storage"
    );
    drop(router);
    migrated.shutdown().unwrap();

    assert!(data_root.join("threads").exists());
    assert!(!data_root.join("state").join("state.sqlite").exists());
    assert!(!workspace.join(".tinybot").join("threads").exists());
    assert!(!workspace
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_thread_storage_migration_never_overwrites_a_conflict() {
    let root = workspace_root("legacy-storage-conflict");
    let workspace = root.join("workspace");
    let data_root = root.join("data");
    let relative = PathBuf::from("2026")
        .join("07")
        .join("28")
        .join("thread-2026-07-28T00-00-00-conflict.jsonl");
    let legacy_file = workspace.join(".tinybot").join("threads").join(&relative);
    let target_file = data_root.join("threads").join(&relative);
    std::fs::create_dir_all(legacy_file.parent().unwrap()).unwrap();
    std::fs::create_dir_all(target_file.parent().unwrap()).unwrap();
    std::fs::write(&legacy_file, "legacy").unwrap();
    std::fs::write(&target_file, "target").unwrap();

    let error = migrate_legacy_thread_storage(&workspace, &data_root).unwrap_err();
    assert!(error.message.contains("conflict"));
    assert_eq!(std::fs::read_to_string(&legacy_file).unwrap(), "legacy");
    assert_eq!(std::fs::read_to_string(&target_file).unwrap(), "target");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_thread_storage_migration_accepts_a_relative_workspace_root() {
    let current_dir = std::env::current_dir().unwrap();
    let sequence = WORKSPACE_STORE_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let relative_root = PathBuf::from(".tmp").join(format!(
        "workspace-store-relative-migration-{}-{sequence}",
        std::process::id()
    ));
    let root = current_dir.join(&relative_root);
    let relative_workspace = relative_root.join("workspace");
    let data_root = root.join("data");
    let legacy_file = current_dir
        .join(&relative_workspace)
        .join(".tinybot")
        .join("threads")
        .join("2026")
        .join("07")
        .join("28")
        .join("thread-relative.jsonl");
    let target_file = data_root
        .join("threads")
        .join("2026")
        .join("07")
        .join("28")
        .join("thread-relative.jsonl");
    std::fs::create_dir_all(legacy_file.parent().unwrap()).unwrap();
    std::fs::write(&legacy_file, "relative").unwrap();

    let report = migrate_legacy_thread_storage(&relative_workspace, &data_root).unwrap();

    assert_eq!(report.moved_file_count, 1);
    assert_eq!(std::fs::read_to_string(&target_file).unwrap(), "relative");
    assert!(!legacy_file.exists());
    let _ = std::fs::remove_dir_all(root);
}
