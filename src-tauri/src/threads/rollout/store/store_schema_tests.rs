use super::*;

#[test]
fn future_thread_log_schema_is_rejected_explicitly() {
    let error = thread_meta_from_lines(&[ThreadLogLine {
        timestamp: "2026-07-10T00:00:00Z".to_string(),
        ordinal: None,
        item: ThreadLogItem::SessionMeta(ThreadMeta {
            schema_version: THREAD_LOG_SCHEMA_VERSION + 1,
            thread_id: "thread-future-schema".to_string(),
            session_id: None,
            created_at: "2026-07-10T00:00:00Z".to_string(),
            cwd: String::new(),
            source: "test".to_string(),
            model_provider: None,
            model: None,
            base_instructions: None,
            history_mode: None,
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: None,
        }),
    }])
    .unwrap_err();

    assert!(error
        .message
        .contains("unsupported thread log schema version"));
    assert_eq!(error.details["supportedSchemaVersion"], 1);
}

#[test]
fn rollout_reconstruction_rejects_turnless_thread_items() {
    let lines = vec![ThreadLogLine {
        timestamp: "2026-07-23T00:00:00Z".to_string(),
        ordinal: Some(0),
        item: value_event(
            EventKind::UserMessage,
            serde_json::json!({ "message": "missing turn identity" }),
        ),
    }];

    let error = thread_items_from_effective_rollout(&lines, &[0], "thread-turnless")
        .expect_err("turnless Rollout records must not project as Thread items");

    assert_eq!(
        error.message,
        "canonical Rollout item is missing its turn id"
    );
    assert_eq!(error.details["itemType"], "user_message");
}

#[test]
fn repeated_identical_thread_record_does_not_append_metadata_snapshot() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-thread-metadata-noop-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("test workspace should create");
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let mut thread = ThreadRecord {
        thread_id: "thread-metadata-noop".to_string(),
        title: "Metadata no-op".to_string(),
        status: ThreadStatus::Idle,
        session_key: Some("session-metadata-noop".to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: "test".to_string(),
        created_at: "2026-07-20T00:00:00Z".to_string(),
        updated_at: "2026-07-20T00:00:00Z".to_string(),
        archived_at: None,
        metadata: ThreadMetadata {
            preview: Some("first preview".to_string()),
            last_activity_at: Some("2026-07-20T00:00:00Z".to_string()),
            extra: serde_json::json!({"clientThreadId": "client-thread-1"}),
            ..Default::default()
        },
    };

    rpc.create_from_thread_record(&thread)
        .expect("initial thread record should persist");
    let record = rpc
        .state
        .find_by_session_or_thread_id(&thread.thread_id)
        .expect("thread lookup should succeed")
        .expect("thread should be indexed");
    let path = PathBuf::from(record.thread_path);
    let initial_line_count = read_thread_lines(&path)
        .expect("initial Rollout should read")
        .len();
    thread_record_cache()
        .lock()
        .expect("thread record cache should lock")
        .remove(&path);
    drop(rpc);
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );

    rpc.create_from_thread_record(&thread)
        .expect("identical thread record should be accepted after cache reset");
    assert_eq!(
        read_thread_lines(&path)
            .expect("Rollout after no-op should read")
            .len(),
        initial_line_count,
        "an identical thread record must not append another metadata snapshot"
    );

    thread.updated_at = "2026-07-20T00:00:01Z".to_string();
    thread.metadata.last_activity_at = Some("2026-07-20T00:00:01Z".to_string());
    thread.metadata.extra = serde_json::json!({"clientThreadId": "client-thread-2"});
    rpc.create_from_thread_record(&thread)
        .expect("changed thread record should persist");
    assert_eq!(
        read_thread_lines(&path)
            .expect("Rollout after metadata change should read")
            .len(),
        initial_line_count + 1,
        "a changed thread record should append exactly one metadata snapshot"
    );

    drop(rpc);
    std::fs::remove_dir_all(root).expect("test workspace should clean up");
}

#[test]
fn thread_item_timestamp_is_persisted_as_iso_8601() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-thread-item-timestamp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("test workspace should create");
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let thread = ThreadRecord {
        thread_id: "thread-item-timestamp".to_string(),
        title: "Timestamp".to_string(),
        status: ThreadStatus::Idle,
        session_key: Some("session-item-timestamp".to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: "test".to_string(),
        created_at: "2026-07-22T08:49:40.228Z".to_string(),
        updated_at: "2026-07-22T08:49:40.228Z".to_string(),
        archived_at: None,
        metadata: ThreadMetadata::default(),
    };
    rpc.create_from_thread_record(&thread)
        .expect("thread record should persist");
    let missing_turn_error = rpc
        .append_thread_items(
            &thread.thread_id,
            &[ThreadItem {
                item_id: "thread-item-without-turn".to_string(),
                thread_id: thread.thread_id.clone(),
                turn_id: String::new(),
                parent_item_id: None,
                sequence: 1,
                created_at: "2026-07-22T08:49:40.228Z".to_string(),
                kind: ThreadItemKind::UserMessage(serde_json::json!({
                    "content": "invalid",
                    "role": "user"
                })),
            }],
        )
        .expect_err("thread items without a turn must be rejected");
    assert_eq!(
        missing_turn_error.message,
        "thread item turnId must not be empty"
    );
    rpc.append_thread_items(
        &thread.thread_id,
        &[ThreadItem {
            item_id: "thread-runtime:thread-item-timestamp:turn-1:user".to_string(),
            thread_id: thread.thread_id.clone(),
            turn_id: "turn-1".to_string(),
            parent_item_id: None,
            sequence: 1,
            created_at: "1784710180728".to_string(),
            kind: ThreadItemKind::UserMessage(serde_json::json!({
                "content": "hello",
                "role": "user"
            })),
        }],
    )
    .expect("thread item should persist");

    let record = rpc
        .state
        .find_by_session_or_thread_id(&thread.thread_id)
        .expect("thread lookup should succeed")
        .expect("thread should be indexed");
    let lines = read_thread_lines(Path::new(&record.thread_path))
        .expect("Rollout should read after thread item append");
    assert_eq!(
        lines
            .last()
            .expect("thread item line should exist")
            .timestamp,
        "2026-07-22T08:49:40.728Z"
    );

    drop(rpc);
    std::fs::remove_dir_all(root).expect("test workspace should clean up");
}
