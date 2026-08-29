use super::*;
use crate::desktop::state::NativeRuntimeState;
use crate::protocol::capability::default_desktop_capability_policy;
use crate::threads::workspace_store::WorkspaceThreadStore;
use serde_json::json;
use std::sync::{Arc, Mutex};

fn test_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "tinybot-thread-workspace-preview-{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should follow the Unix epoch")
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).expect("test root should create");
    root
}

#[test]
fn thread_file_preview_reads_from_the_recorded_workspace_and_rejects_escape() {
    let root = test_root("guarded-read");
    let default_workspace = root.join("default-workspace");
    let thread_workspace = root.join("thread-workspace");
    let data_root = root.join("data");
    std::fs::create_dir_all(default_workspace.join("src"))
        .expect("default workspace should create");
    std::fs::create_dir_all(thread_workspace.join("src")).expect("thread workspace should create");
    std::fs::write(default_workspace.join("src/main.ts"), "default root")
        .expect("default file should write");
    std::fs::write(thread_workspace.join("src/main.ts"), "thread root")
        .expect("thread file should write");
    std::fs::write(thread_workspace.join("src/report.xlsx"), [0_u8, 1, 2, 3])
        .expect("thread binary file should write");
    std::fs::write(root.join("secret.txt"), "outside thread workspace")
        .expect("outside file should write");

    let store = WorkspaceThreadStore::new_with_data_root(
        default_workspace.clone(),
        data_root,
        default_desktop_capability_policy(),
    );
    let mut router = native_request_router(store.clone(), json!({}));
    let created = router.dispatch(&WorkerRequest::new(
        "request-create-thread-workspace-preview",
        "trace-create-thread-workspace-preview",
        "thread.create",
        json!({
            "threadId": "thread-workspace-preview",
            "sessionKey": "session-workspace-preview",
            "title": "Workspace preview",
            "metadata": {
                "workingDirectory": thread_workspace.to_string_lossy(),
            },
        }),
    ));
    assert_eq!(created.error, None, "{created:?}");
    let default_created = router.dispatch(&WorkerRequest::new(
        "request-create-default-workspace-preview",
        "trace-create-default-workspace-preview",
        "thread.create",
        json!({
            "threadId": "thread-default-workspace-preview",
            "sessionKey": "session-default-workspace-preview",
            "title": "Default workspace preview",
        }),
    ));
    assert_eq!(default_created.error, None, "{default_created:?}");
    drop(router);

    let shared = Arc::new(Mutex::new(NativeRuntimeState::with_thread_store(
        store.clone(),
    )));
    let loaded = worker_thread_workspace_file_chunk_with_options(
        &shared,
        "session-workspace-preview".to_string(),
        "src/main.ts".to_string(),
        None,
        default_workspace.clone(),
        json!({}),
        Duration::from_secs(1),
    )
    .expect("thread workspace file should load");
    assert_eq!(loaded["result"]["content"], "thread root");

    let binary_metadata = worker_thread_workspace_file_chunk_with_options(
        &shared,
        "session-workspace-preview".to_string(),
        "src/report.xlsx".to_string(),
        None,
        default_workspace.clone(),
        json!({}),
        Duration::from_secs(1),
    )
    .expect("thread binary metadata should load");
    let binary = worker_thread_workspace_file_bytes_with_options(
        &shared,
        "session-workspace-preview".to_string(),
        "src/report.xlsx".to_string(),
        binary_metadata["result"]["revision"]
            .as_str()
            .map(ToOwned::to_owned),
        default_workspace.clone(),
        4,
    )
    .expect("thread binary bytes should load");
    assert_eq!(binary, [0, 1, 2, 3]);

    let oversized = worker_thread_workspace_file_bytes_with_options(
        &shared,
        "session-workspace-preview".to_string(),
        "src/report.xlsx".to_string(),
        None,
        default_workspace.clone(),
        3,
    )
    .expect_err("oversized preview file should fail");
    assert!(oversized.contains("file_too_large"), "{oversized}");

    std::fs::write(thread_workspace.join("src/report.xlsx"), [4_u8, 5, 6, 7, 8])
        .expect("changed binary file should write");
    let changed = worker_thread_workspace_file_bytes_with_options(
        &shared,
        "session-workspace-preview".to_string(),
        "src/report.xlsx".to_string(),
        binary_metadata["result"]["revision"]
            .as_str()
            .map(ToOwned::to_owned),
        default_workspace.clone(),
        5,
    )
    .expect_err("changed preview file should fail");
    assert!(changed.contains("source_changed"), "{changed}");

    let default_loaded = worker_thread_workspace_file_chunk_with_options(
        &shared,
        "session-default-workspace-preview".to_string(),
        default_workspace
            .join("src/main.ts")
            .to_string_lossy()
            .to_string(),
        None,
        default_workspace.clone(),
        json!({}),
        Duration::from_secs(1),
    )
    .expect("absolute file in the default thread workspace should load");
    assert_eq!(default_loaded["result"]["content"], "default root");

    let escaped = worker_thread_workspace_file_chunk_with_options(
        &shared,
        "session-workspace-preview".to_string(),
        "../secret.txt".to_string(),
        None,
        root.clone(),
        json!({}),
        Duration::from_secs(1),
    )
    .expect("guarded workspace errors should stay structured");
    assert!(escaped["error"].is_object(), "{escaped}");
    assert!(escaped["result"].is_null(), "{escaped}");

    drop(shared);
    drop(store);
    std::fs::remove_dir_all(root).expect("test root should clean up");
}
