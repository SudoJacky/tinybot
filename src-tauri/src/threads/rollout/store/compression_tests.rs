use super::*;
use crate::threads::rollout::format::{EventKind, SessionMeta};
use crate::threads::rollout::store::{read_thread_lines, value_event, ThreadRecorder};

fn test_rollout_path(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "tinybot-rollout-compression-{}-{}-{name}",
            std::process::id(),
            TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
        .join("rollout.jsonl")
}

#[test]
fn compressed_rollout_reads_exactly_and_materializes_for_append() {
    let path = test_rollout_path("roundtrip");
    let root = path.parent().unwrap();
    let _ = fs::remove_dir_all(root);
    fs::create_dir_all(root).unwrap();
    let contents = b"{\"ordinal\":1,\"type\":\"session_meta\"}\n\
{\"ordinal\":2,\"type\":\"event_msg\"}\n";
    fs::write(&path, contents).unwrap();

    compress_rollout(&path).unwrap();
    let compressed = compressed_rollout_path(&path).unwrap();
    assert!(!path.exists());
    assert!(compressed.exists());
    let mut decoded = Vec::new();
    open_rollout_reader(&path)
        .unwrap()
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(decoded, contents);

    materialize_rollout_for_append(&path).unwrap();
    assert!(path.exists());
    assert!(!compressed.exists());
    assert_eq!(fs::read(&path).unwrap(), contents);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn reader_rejects_dual_materialized_and_compressed_state() {
    let path = test_rollout_path("dual");
    let root = path.parent().unwrap();
    let _ = fs::remove_dir_all(root);
    fs::create_dir_all(root).unwrap();
    fs::write(&path, b"plain").unwrap();
    fs::write(compressed_rollout_path(&path).unwrap(), b"compressed").unwrap();

    let error = match open_rollout_reader(&path) {
        Ok(_) => panic!("dual Rollout state must be rejected"),
        Err(error) => error,
    };
    assert!(error
        .message
        .contains("materialized and compressed Rollouts both exist"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cold_rollout_worker_compresses_plain_rollouts_without_changing_logical_path() {
    let root = test_rollout_path("cold-worker")
        .parent()
        .unwrap()
        .to_path_buf();
    let _ = fs::remove_dir_all(&root);
    let path = root
        .join(".tinybot")
        .join("threads")
        .join("2026")
        .join("07")
        .join("17")
        .join("thread-2026-07-17T00-00-00-thread-cold.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"{\"ordinal\":0,\"type\":\"session_meta\"}\n").unwrap();

    let recorder = ThreadRecorder::new(root.clone());
    run_rollout_compression_worker_with_age(&root, Duration::ZERO, &recorder).unwrap();

    assert!(!path.exists());
    assert!(compressed_rollout_path(&path).unwrap().exists());
    let mut decoded = Vec::new();
    open_rollout_reader(&path)
        .unwrap()
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(decoded, b"{\"ordinal\":0,\"type\":\"session_meta\"}\n");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cold_rollout_worker_skips_live_writer_and_future_append_remains_valid() {
    let root = test_rollout_path("live-writer")
        .parent()
        .unwrap()
        .to_path_buf();
    let _ = fs::remove_dir_all(&root);
    let recorder = ThreadRecorder::new(root.clone());
    let path = recorder
        .create_thread(SessionMeta {
            schema_version: 1,
            thread_id: "thread-live-writer".to_string(),
            session_id: Some("session-live-writer".to_string()),
            created_at: "2026-07-17T00:00:00Z".to_string(),
            cwd: root.display().to_string(),
            source: "test".to_string(),
            model_provider: None,
            model: None,
            base_instructions: None,
            history_mode: None,
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: None,
        })
        .unwrap();

    run_rollout_compression_worker_with_age(&root, Duration::ZERO, &recorder).unwrap();
    assert!(path.exists());
    assert!(!compressed_rollout_path(&path).unwrap().exists());

    recorder
        .append_item(
            &path,
            "2026-07-17T00:01:00Z".to_string(),
            value_event(
                EventKind::UserMessage,
                serde_json::json!({"content": "still writable"}),
            ),
        )
        .unwrap();
    assert_eq!(read_thread_lines(&path).unwrap().len(), 2);
    recorder.shutdown(&path).unwrap();
    let _ = fs::remove_dir_all(root);
}
