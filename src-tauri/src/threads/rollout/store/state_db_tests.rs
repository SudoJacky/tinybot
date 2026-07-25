use super::*;
use std::fs;

fn temp_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "tinybot-thread-state-db-{name}-{}",
        std::process::id()
    ))
}

#[test]
fn reset_clears_an_open_database_without_replacing_the_file() {
    let root = temp_root("reset-open");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
    db.upsert_thread(&record(
        "thread-reset-open",
        Some("session-reset-open"),
        "2026-07-21T00:00:00Z",
    ))
    .unwrap();
    let open_connection = Connection::open(db.path()).unwrap();

    db.reset().unwrap();

    let count = open_connection
        .query_row("SELECT COUNT(*) FROM threads", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    assert!(db.path().exists());
    let _ = fs::remove_dir_all(root);
}

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
fn upsert_thread_lists_unarchived_threads_by_updated_at_desc_then_id() {
    let root = temp_root("list-order");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());

    db.upsert_thread(&record(
        "thread-b",
        Some("session-b"),
        "2026-07-08T10:02:00Z",
    ))
    .unwrap();
    db.upsert_thread(&record(
        "thread-c",
        Some("session-c"),
        "2026-07-08T10:03:00Z",
    ))
    .unwrap();
    db.upsert_thread(&record(
        "thread-a",
        Some("session-a"),
        "2026-07-08T10:02:00Z",
    ))
    .unwrap();

    let records = db.list_threads().unwrap();

    assert_eq!(
        records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        vec!["thread-c", "thread-a", "thread-b"]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn upsert_thread_replaces_existing_record_without_changing_created_at() {
    let root = temp_root("upsert-replace");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
    let mut original = record("thread-a", Some("session-a"), "2026-07-08T10:00:00Z");
    original.created_at = "2026-07-08T09:00:00Z".to_string();
    db.upsert_thread(&original).unwrap();

    let mut updated = record("thread-a", Some("session-new"), "2026-07-08T11:00:00Z");
    updated.created_at = "2026-07-08T12:00:00Z".to_string();
    updated.title = "Updated title".to_string();
    db.upsert_thread(&updated).unwrap();

    let found = db
        .find_by_session_or_thread_id("thread-a")
        .unwrap()
        .unwrap();
    assert_eq!(found.session_id.as_deref(), Some("session-new"));
    assert_eq!(found.title, "Updated title");
    assert_eq!(found.created_at, "2026-07-08T09:00:00Z");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn find_by_session_or_thread_id_matches_either_identifier() {
    let root = temp_root("find");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
    db.upsert_thread(&record(
        "thread-a",
        Some("session-a"),
        "2026-07-08T10:00:00Z",
    ))
    .unwrap();

    assert_eq!(
        db.find_by_session_or_thread_id("thread-a")
            .unwrap()
            .unwrap()
            .session_id
            .as_deref(),
        Some("session-a")
    );
    assert_eq!(
        db.find_by_session_or_thread_id("session-a")
            .unwrap()
            .unwrap()
            .id,
        "thread-a"
    );
    assert!(db
        .find_by_session_or_thread_id("missing")
        .unwrap()
        .is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn find_and_archive_prefer_exact_thread_id_over_colliding_session_id() {
    let root = temp_root("find-id-precedence");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
    db.upsert_thread(&record(
        "thread-a",
        Some("session-a"),
        "2026-07-08T10:00:00Z",
    ))
    .unwrap();
    db.upsert_thread(&record(
        "thread-newer",
        Some("thread-a"),
        "2026-07-08T11:00:00Z",
    ))
    .unwrap();

    let found = db
        .find_by_session_or_thread_id("thread-a")
        .unwrap()
        .unwrap();
    assert_eq!(found.id, "thread-a");

    let archived = db
        .archive_thread("thread-a", "2026-07-08T12:00:00Z".to_string())
        .unwrap()
        .unwrap();
    assert_eq!(archived.id, "thread-a");
    assert!(
        db.find_by_session_or_thread_id("thread-a")
            .unwrap()
            .unwrap()
            .archived
    );
    assert!(
        !db.find_by_session_or_thread_id("thread-newer")
            .unwrap()
            .unwrap()
            .archived
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_thread_excludes_record_from_list_but_keeps_findable_state() {
    let root = temp_root("archive");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
    db.upsert_thread(&record(
        "thread-a",
        Some("session-a"),
        "2026-07-08T10:00:00Z",
    ))
    .unwrap();

    let archived = db
        .archive_thread("session-a", "2026-07-08T11:00:00Z".to_string())
        .unwrap()
        .unwrap();

    assert!(archived.archived);
    assert_eq!(
        archived.archived_at.as_deref(),
        Some("2026-07-08T11:00:00Z")
    );
    assert!(db.list_threads().unwrap().is_empty());
    assert!(
        db.find_by_session_or_thread_id("thread-a")
            .unwrap()
            .unwrap()
            .archived
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn upsert_thread_creates_state_db_path_and_schema() {
    let root = temp_root("schema");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());

    db.upsert_thread(&record(
        "thread-a",
        Some("session-a"),
        "2026-07-08T10:00:00Z",
    ))
    .unwrap();

    assert_eq!(
        db.path(),
        root.join(".tinybot").join("state").join("state.sqlite")
    );
    assert!(db.path().exists());
    let connection = rusqlite::Connection::open(db.path()).unwrap();
    let table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(table_count, 1);
    let checkpoint_table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'latest_context_checkpoints'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checkpoint_table_count, 1);
    let head_table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'thread_log_heads'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(head_table_count, 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn schema_migrates_legacy_checkpoint_line_numbers_to_ordinals() {
    let root = temp_root("checkpoint-ordinal-migration");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
    fs::create_dir_all(db.path().parent().unwrap()).unwrap();
    let connection = rusqlite::Connection::open(db.path()).unwrap();
    connection
        .execute_batch(
            "
                CREATE TABLE latest_context_checkpoints (
                    thread_id TEXT PRIMARY KEY NOT NULL,
                    line_number INTEGER NOT NULL,
                    checkpoint_timestamp TEXT NOT NULL,
                    checkpoint_hash TEXT NOT NULL
                );
                INSERT INTO latest_context_checkpoints (
                    thread_id, line_number, checkpoint_timestamp, checkpoint_hash
                ) VALUES (
                    'thread-legacy', 7, '2026-07-08T10:00:00Z', 'sha256:legacy'
                );
                ",
        )
        .unwrap();
    drop(connection);

    let connection = db.open().unwrap();
    let ordinal: i64 = connection
        .query_row(
            "SELECT ordinal FROM latest_context_checkpoints
                 WHERE thread_id = 'thread-legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(ordinal, 7);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn schema_adds_projection_hash_to_legacy_log_heads() {
    let root = temp_root("projection-hash-migration");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
    fs::create_dir_all(db.path().parent().unwrap()).unwrap();
    let connection = rusqlite::Connection::open(db.path()).unwrap();
    connection
        .execute_batch(
            "
                CREATE TABLE thread_log_heads (
                    thread_id TEXT PRIMARY KEY NOT NULL,
                    byte_length INTEGER NOT NULL,
                    tail_hash TEXT NOT NULL
                );
                ",
        )
        .unwrap();
    drop(connection);

    let connection = db.open().unwrap();
    let projection_hash_default: String = connection
        .query_row(
            "SELECT dflt_value
                 FROM pragma_table_info('thread_log_heads')
                 WHERE name = 'projection_hash'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(projection_hash_default, "''");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn latest_context_checkpoint_projection_is_replaceable_and_preserved_by_thread_updates() {
    let root = temp_root("latest-checkpoint");
    let _ = fs::remove_dir_all(&root);
    let db = ThreadStateDb::new(root.clone());
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

    db.replace_thread_projection(&thread, Some(&checkpoint), &log_head)
        .unwrap();
    assert_eq!(
        db.latest_context_checkpoint("session-checkpoint").unwrap(),
        Some(checkpoint.clone())
    );
    assert_eq!(
        db.thread_log_head("session-checkpoint").unwrap(),
        Some(ThreadLogHeadRecord {
            thread_id: thread.id.clone(),
            byte_length: log_head.byte_length,
            tail_hash: log_head.tail_hash.clone(),
            projection_hash: thread_projection_hash(&thread, Some(&checkpoint)),
        })
    );

    thread.updated_at = "2026-07-08T11:00:00Z".to_string();
    db.upsert_thread(&thread).unwrap();
    assert_eq!(
        db.latest_context_checkpoint("thread-checkpoint").unwrap(),
        Some(checkpoint)
    );
    assert_eq!(
        db.thread_log_head("thread-checkpoint")
            .unwrap()
            .unwrap()
            .tail_hash,
        log_head.tail_hash
    );

    db.replace_thread_projection(&thread, None, &log_head)
        .unwrap();
    assert!(db
        .latest_context_checkpoint("session-checkpoint")
        .unwrap()
        .is_none());
    let _ = fs::remove_dir_all(root);
}
