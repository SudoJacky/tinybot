use super::*;
use crate::threads::rollout::store::read_thread_lines;

fn temp_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("tinybot-thread-log-{name}-{}", std::process::id()))
}

fn thread_meta(root: &Path, thread_id: &str, created_at: &str) -> ThreadMeta {
    ThreadMeta {
        schema_version: crate::threads::rollout::store::THREAD_LOG_SCHEMA_VERSION,
        thread_id: thread_id.to_string(),
        session_id: Some("session-a".to_string()),
        created_at: created_at.to_string(),
        cwd: root.display().to_string(),
        source: "desktop".to_string(),
        model_provider: Some("deepseek".to_string()),
        model: Some("deepseek-v4-pro".to_string()),
        base_instructions: None,
        history_mode: Some("default".to_string()),
        forked_from_thread_id: None,
        parent_thread_id: None,
        originator: Some("Tinybot Desktop".to_string()),
    }
}

#[test]
fn recorder_creates_single_thread_jsonl_with_meta_first() {
    let root = temp_root("create");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(&root, "thread-a", "2026-07-08T10:12:30Z"))
        .unwrap();

    assert!(path.ends_with("thread-2026-07-08T10-12-30-thread-a.jsonl"));
    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines.len(), 1);
    assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
    assert_eq!(lines[0].ordinal, Some(0));
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_appends_items_after_meta() {
    let root = temp_root("append");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(&root, "thread-append", "2026-07-08T10:12:30Z"))
        .unwrap();

    recorder
        .append_item(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            value_event(
                EventKind::TurnStarted,
                serde_json::json!({ "turnId": "turn-1" }),
            ),
        )
        .unwrap();

    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines.len(), 2);
    assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
    assert!(matches!(lines[1].item, ThreadLogItem::EventMsg(_)));
    assert_eq!(
        lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
        vec![Some(0), Some(1)]
    );
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_batch_appends_items_after_meta_in_order() {
    let root = temp_root("batch-append");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-batch-append",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();

    recorder
        .append_items(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            vec![
                value_event(
                    EventKind::TurnStarted,
                    serde_json::json!({ "turnId": "turn-1" }),
                ),
                ThreadLogItem::ResponseItem(
                    ResponseItem::from_value(serde_json::json!({
                        "type": "message",
                        "role": "assistant",
                        "content": "done"
                    }))
                    .unwrap(),
                ),
                value_event(
                    EventKind::TurnComplete,
                    serde_json::json!({ "turnId": "turn-1" }),
                ),
            ],
        )
        .unwrap();

    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines.len(), 4);
    assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
    assert!(matches!(lines[1].item, ThreadLogItem::EventMsg(_)));
    assert!(matches!(lines[2].item, ThreadLogItem::ResponseItem(_)));
    assert!(matches!(lines[3].item, ThreadLogItem::EventMsg(_)));
    assert_eq!(
        lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(2), Some(3)]
    );
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_retries_buffered_items_after_initial_filesystem_failure() {
    let root = temp_root("retry-buffered");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(".tinybot"), "blocks thread directory").unwrap();
    let recorder = ThreadRecorder::new(root.clone());
    let created_at = "2026-07-08T10:12:30Z";

    let error = recorder
        .create_thread(thread_meta(&root, "thread-retry", created_at))
        .unwrap_err();

    assert!(error.retryable);
    assert_eq!(error.details["operation"], "persist");
    assert_eq!(error.details["pendingCount"], 1);

    fs::remove_file(root.join(".tinybot")).unwrap();
    let path = root
        .join(".tinybot")
        .join("threads")
        .join("2026")
        .join("07")
        .join("08")
        .join("thread-2026-07-08T10-12-30-thread-retry.jsonl");
    recorder.persist(&path).unwrap();

    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].ordinal, Some(0));
    assert!(matches!(lines[0].item, ThreadLogItem::SessionMeta(_)));
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_repairs_missing_trailing_newline_before_append() {
    let root = temp_root("repair-newline");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-repair-newline",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    recorder.shutdown(&path).unwrap();
    let mut bytes = fs::read(&path).unwrap();
    assert_eq!(bytes.pop(), Some(b'\n'));
    fs::write(&path, bytes).unwrap();

    recorder
        .append_item(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            value_event(
                EventKind::TurnStarted,
                serde_json::json!({ "turnId": "turn-1" }),
            ),
        )
        .unwrap();

    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].ordinal, Some(0));
    assert_eq!(lines[1].ordinal, Some(1));
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_continues_ordinals_after_legacy_prefix() {
    let root = temp_root("legacy-prefix");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-legacy-prefix",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    recorder.shutdown(&path).unwrap();
    let mut legacy_lines = read_thread_lines(&path).unwrap();
    legacy_lines[0].ordinal = None;
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string(&legacy_lines[0]).unwrap()),
    )
    .unwrap();

    recorder
        .append_item(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            value_event(
                EventKind::TurnStarted,
                serde_json::json!({ "turnId": "turn-1" }),
            ),
        )
        .unwrap();

    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines[0].ordinal, None);
    assert_eq!(lines[1].ordinal, Some(1));
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_clones_share_one_workspace_writer_per_thread() {
    let root = temp_root("shared-writer");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-shared-writer",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    let mut workers = Vec::new();
    for index in 0..8 {
        let recorder = recorder.clone();
        let path = path.clone();
        workers.push(std::thread::spawn(move || {
            recorder
                .append_item(
                    &path,
                    "2026-07-08T10:13:30Z".to_string(),
                    value_event(
                        EventKind::UserMessage,
                        serde_json::json!({ "workerIndex": index }),
                    ),
                )
                .unwrap();
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }

    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines.len(), 9);
    assert_eq!(
        lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
        (0..9).map(Some).collect::<Vec<_>>()
    );
    let mut worker_indexes = lines[1..]
        .iter()
        .map(|line| match &line.item {
            ThreadLogItem::EventMsg(event) => event["payload"]["workerIndex"]
                .as_u64()
                .expect("worker event index"),
            other => panic!("expected worker event, found {other:?}"),
        })
        .collect::<Vec<_>>();
    worker_indexes.sort_unstable();
    assert_eq!(worker_indexes, (0..8).collect::<Vec<_>>());
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_flush_and_shutdown_are_acknowledged_barriers() {
    let root = temp_root("barriers");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-barriers",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();

    recorder
        .add_items(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            vec![value_event(
                EventKind::UserMessage,
                serde_json::json!({ "barrier": "flush" }),
            )],
        )
        .unwrap();
    recorder.flush(&path).unwrap();
    assert_eq!(read_thread_lines(&path).unwrap().len(), 2);

    recorder
        .add_items(
            &path,
            "2026-07-08T10:14:30Z".to_string(),
            vec![value_event(
                EventKind::UserMessage,
                serde_json::json!({ "barrier": "shutdown" }),
            )],
        )
        .unwrap();
    recorder.shutdown(&path).unwrap();

    let lines = read_thread_lines(&path).unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(
        lines.iter().map(|line| line.ordinal).collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(2)]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_flush_all_drains_every_active_writer() {
    let root = temp_root("flush-all");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let first = recorder
        .create_thread(thread_meta(
            &root,
            "thread-flush-all-a",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    let second = recorder
        .create_thread(thread_meta(
            &root,
            "thread-flush-all-b",
            "2026-07-08T10:12:31Z",
        ))
        .unwrap();
    for path in [&first, &second] {
        recorder
            .add_items(
                path,
                "2026-07-08T10:13:30Z".to_string(),
                vec![value_event(
                    EventKind::UserMessage,
                    serde_json::json!({ "barrier": "flush_all" }),
                )],
            )
            .unwrap();
    }

    recorder.flush_all().unwrap();

    assert_eq!(read_thread_lines(&first).unwrap().len(), 2);
    assert_eq!(read_thread_lines(&second).unwrap().len(), 2);
    recorder.shutdown_all().unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_flush_all_does_not_create_thread_storage() {
    let root = temp_root("flush-all-empty");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());

    recorder.flush_all().unwrap();

    assert!(!root.join(".tinybot").join("threads").exists());
    recorder.shutdown_all().unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_shutdown_all_drains_writers_and_closes_every_clone() {
    let root = temp_root("shutdown-all");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let clone = recorder.clone();
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-shutdown-all",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    recorder
        .add_items(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            vec![value_event(
                EventKind::UserMessage,
                serde_json::json!({ "barrier": "shutdown_all" }),
            )],
        )
        .unwrap();

    recorder.shutdown_all().unwrap();
    recorder.shutdown_all().unwrap();

    assert_eq!(read_thread_lines(&path).unwrap().len(), 2);
    let error = clone
        .append_item(
            &path,
            "2026-07-08T10:14:30Z".to_string(),
            value_event(
                EventKind::UserMessage,
                serde_json::json!({ "after": "shutdown_all" }),
            ),
        )
        .unwrap_err();
    assert!(error.message.contains("shut down"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_add_items_waits_for_an_explicit_flush_barrier() {
    let root = temp_root("add-items-buffered");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-add-items-buffered",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();

    recorder
        .add_items(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            vec![value_event(
                EventKind::UserMessage,
                serde_json::json!({ "barrier": "persist" }),
            )],
        )
        .unwrap();

    assert_eq!(
        recorder
            .writer(&path)
            .unwrap()
            .pending_item_count()
            .unwrap(),
        1,
        "AddItems must stay buffered until Persist, Flush, or Shutdown"
    );
    assert_eq!(read_thread_lines(&path).unwrap().len(), 1);

    recorder.persist(&path).unwrap();
    assert_eq!(read_thread_lines(&path).unwrap().len(), 2);
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_fails_fast_on_corrupt_canonical_ordinal() {
    let root = temp_root("corrupt-ordinal");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-corrupt-ordinal",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    recorder.shutdown(&path).unwrap();
    let mut lines = read_thread_lines(&path).unwrap();
    lines[0].ordinal = Some(7);
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string(&lines[0]).unwrap()),
    )
    .unwrap();

    let error = recorder
        .append_item(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            value_event(
                EventKind::TurnStarted,
                serde_json::json!({ "turnId": "turn-1" }),
            ),
        )
        .unwrap_err();

    assert!(!error.retryable);
    assert!(error.message.contains("ordinal mismatch"));
    lines[0].ordinal = Some(0);
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string(&lines[0]).unwrap()),
    )
    .unwrap();
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_delete_fences_live_writers_before_removing_rollout() {
    let root = temp_root("delete-fences-writer");
    let _ = fs::remove_dir_all(&root);
    let owner = ThreadRecorder::new(root.clone());
    let path = owner
        .create_thread(thread_meta(
            &root,
            "thread-delete-fence",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    let concurrent = owner.clone();
    concurrent
        .add_items(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            vec![value_event(
                EventKind::UserMessage,
                serde_json::json!({ "turnId": "turn-delete-fence" }),
            )],
        )
        .unwrap();

    owner.delete_rollout(&path).unwrap();

    assert!(!path.exists());
    let error = concurrent
        .append_item(
            &path,
            "2026-07-08T10:14:30Z".to_string(),
            value_event(
                EventKind::UserMessage,
                serde_json::json!({ "turnId": "turn-delete-fence" }),
            ),
        )
        .unwrap_err();
    assert!(error
        .message
        .contains("new rollout must begin with session metadata"));
    assert!(!path.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_archive_and_unarchive_fence_writers_and_preserve_rollout() {
    let root = temp_root("archive-fences-writer");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(thread_meta(
            &root,
            "thread-archive-fence",
            "2026-07-08T10:12:30Z",
        ))
        .unwrap();
    recorder
        .append_item(
            &path,
            "2026-07-08T10:13:30Z".to_string(),
            value_event(
                EventKind::UserMessage,
                serde_json::json!({ "turnId": "turn-archive-fence" }),
            ),
        )
        .unwrap();

    let archived_path = recorder.archive_rollout(&path).unwrap();

    assert!(!path.exists());
    assert!(!archived_path.exists());
    assert!(recorder.is_compressed(&archived_path).unwrap());
    assert!(recorder.is_archived_path(&archived_path));
    assert_eq!(read_thread_lines(&archived_path).unwrap().len(), 2);
    recorder
        .append_item(
            &archived_path,
            "2026-07-08T10:14:30Z".to_string(),
            value_event(
                EventKind::UserMessage,
                serde_json::json!({ "turnId": "turn-archive-fence" }),
            ),
        )
        .unwrap();
    assert!(archived_path.exists());
    assert!(!recorder.is_compressed(&archived_path).unwrap());

    let restored_path = recorder.unarchive_rollout(&archived_path).unwrap();

    assert_eq!(restored_path, path);
    assert!(!archived_path.exists());
    assert!(restored_path.exists());
    assert!(!recorder.is_archived_path(&restored_path));
    recorder
        .append_item(
            &restored_path,
            "2026-07-08T10:15:30Z".to_string(),
            value_event(
                EventKind::UserMessage,
                serde_json::json!({ "turnId": "turn-archive-fence" }),
            ),
        )
        .unwrap();
    assert_eq!(read_thread_lines(&restored_path).unwrap().len(), 4);
    recorder.shutdown(&restored_path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_rejects_unsafe_thread_id() {
    let root = temp_root("unsafe-id");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());

    let error = recorder
        .create_thread(thread_meta(&root, "../thread", "2026-07-08T10:12:30Z"))
        .unwrap_err();

    assert!(error.message.contains("invalid thread_id"));
    assert!(!root.join(".tinybot").join("threads").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorder_rejects_malformed_created_at() {
    let root = temp_root("bad-time");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());

    let error = recorder
        .create_thread(thread_meta(&root, "thread-a", "not-a-date"))
        .unwrap_err();

    assert!(error.message.contains("invalid thread log timestamp"));
    assert!(!root.join(".tinybot").join("threads").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn now_thread_timestamp_can_create_thread_log_path() {
    let root = temp_root("now-time");
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let timestamp = now_thread_timestamp();
    assert!(timestamp.contains(':'));
    assert!(timestamp.contains('.'));

    let path = recorder
        .create_thread(thread_meta(&root, "thread-now", &timestamp))
        .unwrap();

    assert!(path.exists());
    assert!(path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap()
        .starts_with(&format!(
            "thread-{}-thread-now",
            timestamp
                .replace(':', "-")
                .replace('.', "-")
                .trim_end_matches('Z')
        )));
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}
