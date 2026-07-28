use super::*;

fn record(id: &str, session_id: Option<&str>, updated_at: &str) -> ThreadStateRecord {
    ThreadStateRecord {
        id: id.to_string(),
        session_id: session_id.map(str::to_string),
        thread_path: format!("/tmp/{id}.jsonl"),
        created_at: "2026-07-08T10:00:00Z".to_string(),
        updated_at: updated_at.to_string(),
        source: "desktop".to_string(),
        title: format!("Title {id}"),
        preview: format!("Preview {id}"),
        cwd: "/workspace".to_string(),
        model_provider: Some("deepseek".to_string()),
        model: Some("deepseek-v4-pro".to_string()),
        tokens_used: 42,
        archived: false,
        archived_at: None,
    }
}

#[test]
fn clones_share_state_but_a_new_index_starts_empty() {
    let index = ThreadStateIndex::new();
    let clone = index.clone();
    index
        .upsert_thread(&record(
            "thread-shared",
            Some("session-shared"),
            "2026-07-08T10:00:00Z",
        ))
        .unwrap();

    assert!(clone
        .find_by_session_or_thread_id("thread-shared")
        .unwrap()
        .is_some());
    assert!(ThreadStateIndex::new()
        .find_by_session_or_thread_id("thread-shared")
        .unwrap()
        .is_none());

    clone.reset().unwrap();
    assert!(index.list_all_threads().unwrap().is_empty());
}

#[test]
fn upsert_thread_lists_unarchived_threads_by_updated_at_desc_then_id() {
    let index = ThreadStateIndex::new();
    index
        .upsert_thread(&record(
            "thread-b",
            Some("session-b"),
            "2026-07-08T10:02:00Z",
        ))
        .unwrap();
    index
        .upsert_thread(&record(
            "thread-c",
            Some("session-c"),
            "2026-07-08T10:03:00Z",
        ))
        .unwrap();
    index
        .upsert_thread(&record(
            "thread-a",
            Some("session-a"),
            "2026-07-08T10:02:00Z",
        ))
        .unwrap();

    assert_eq!(
        index
            .list_threads()
            .unwrap()
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        vec!["thread-c", "thread-a", "thread-b"]
    );
}

#[test]
fn upsert_thread_replaces_existing_record_without_changing_created_at() {
    let index = ThreadStateIndex::new();
    let mut original = record("thread-a", Some("session-a"), "2026-07-08T10:00:00Z");
    original.created_at = "2026-07-08T09:00:00Z".to_string();
    index.upsert_thread(&original).unwrap();

    let mut updated = record("thread-a", Some("session-new"), "2026-07-08T11:00:00Z");
    updated.created_at = "2026-07-08T12:00:00Z".to_string();
    updated.title = "Updated title".to_string();
    index.upsert_thread(&updated).unwrap();

    let found = index
        .find_by_session_or_thread_id("thread-a")
        .unwrap()
        .unwrap();
    assert_eq!(found.session_id.as_deref(), Some("session-new"));
    assert_eq!(found.title, "Updated title");
    assert_eq!(found.created_at, "2026-07-08T09:00:00Z");
}

#[test]
fn find_by_session_or_thread_id_matches_either_identifier() {
    let index = ThreadStateIndex::new();
    index
        .upsert_thread(&record(
            "thread-a",
            Some("session-a"),
            "2026-07-08T10:00:00Z",
        ))
        .unwrap();

    assert_eq!(
        index
            .find_by_session_or_thread_id("thread-a")
            .unwrap()
            .unwrap()
            .session_id
            .as_deref(),
        Some("session-a")
    );
    assert_eq!(
        index
            .find_by_session_or_thread_id("session-a")
            .unwrap()
            .unwrap()
            .id,
        "thread-a"
    );
    assert!(index
        .find_by_session_or_thread_id("missing")
        .unwrap()
        .is_none());
}

#[test]
fn find_and_archive_prefer_exact_thread_id_over_colliding_session_id() {
    let index = ThreadStateIndex::new();
    index
        .upsert_thread(&record(
            "thread-a",
            Some("session-a"),
            "2026-07-08T10:00:00Z",
        ))
        .unwrap();
    index
        .upsert_thread(&record(
            "thread-newer",
            Some("thread-a"),
            "2026-07-08T11:00:00Z",
        ))
        .unwrap();

    assert_eq!(
        index
            .find_by_session_or_thread_id("thread-a")
            .unwrap()
            .unwrap()
            .id,
        "thread-a"
    );

    let archived = index
        .archive_thread("thread-a", "2026-07-08T12:00:00Z".to_string())
        .unwrap()
        .unwrap();
    assert_eq!(archived.id, "thread-a");
    assert!(
        index
            .find_by_session_or_thread_id("thread-a")
            .unwrap()
            .unwrap()
            .archived
    );
    assert!(
        !index
            .find_by_session_or_thread_id("thread-newer")
            .unwrap()
            .unwrap()
            .archived
    );
}

#[test]
fn archive_thread_excludes_record_from_list_but_keeps_findable_state() {
    let index = ThreadStateIndex::new();
    index
        .upsert_thread(&record(
            "thread-a",
            Some("session-a"),
            "2026-07-08T10:00:00Z",
        ))
        .unwrap();

    let archived = index
        .archive_thread("session-a", "2026-07-08T11:00:00Z".to_string())
        .unwrap()
        .unwrap();

    assert!(archived.archived);
    assert_eq!(
        archived.archived_at.as_deref(),
        Some("2026-07-08T11:00:00Z")
    );
    assert!(index.list_threads().unwrap().is_empty());
    assert!(
        index
            .find_by_session_or_thread_id("thread-a")
            .unwrap()
            .unwrap()
            .archived
    );
}

#[test]
fn latest_context_checkpoint_projection_is_replaceable_and_preserved_by_thread_updates() {
    let index = ThreadStateIndex::new();
    let mut thread = record(
        "thread-checkpoint",
        Some("session-checkpoint"),
        "2026-07-08T10:00:00Z",
    );
    let checkpoint = LatestContextCheckpointRecord {
        thread_id: thread.id.clone(),
        ordinal: 4,
        timestamp: "2026-07-08T10:00:00Z".to_string(),
        checkpoint_hash: "sha256:checkpoint-1".to_string(),
    };
    let log_head = ThreadLogHead {
        byte_length: 128,
        tail_hash: "sha256:tail-1".to_string(),
    };

    index
        .replace_thread_projection(&thread, Some(&checkpoint), &log_head)
        .unwrap();
    assert_eq!(
        index
            .latest_context_checkpoint("session-checkpoint")
            .unwrap(),
        Some(checkpoint.clone())
    );
    assert_eq!(
        index.thread_log_head("session-checkpoint").unwrap(),
        Some(ThreadLogHeadRecord {
            thread_id: thread.id.clone(),
            byte_length: log_head.byte_length,
            tail_hash: log_head.tail_hash.clone(),
            projection_hash: thread_projection_hash(&thread, Some(&checkpoint)),
        })
    );

    thread.updated_at = "2026-07-08T11:00:00Z".to_string();
    index.upsert_thread(&thread).unwrap();
    assert_eq!(
        index
            .latest_context_checkpoint("thread-checkpoint")
            .unwrap(),
        Some(checkpoint)
    );
    assert_eq!(
        index
            .thread_log_head("thread-checkpoint")
            .unwrap()
            .unwrap()
            .tail_hash,
        log_head.tail_hash
    );

    index
        .replace_thread_projection(&thread, None, &log_head)
        .unwrap();
    assert!(index
        .latest_context_checkpoint("session-checkpoint")
        .unwrap()
        .is_none());
}
