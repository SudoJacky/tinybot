use super::ThreadStateRecord;
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ThreadStateDb {
    path: PathBuf,
}

impl ThreadStateDb {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            path: workspace_root
                .join(".tinybot")
                .join("state")
                .join("state.sqlite"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn upsert_thread(&self, record: &ThreadStateRecord) -> Result<(), WorkerProtocolError> {
        let connection = self.open()?;
        connection
            .execute(
                "INSERT INTO threads (
                    id, session_id, thread_path, created_at, updated_at, source, title, preview,
                    cwd, model_provider, model, tokens_used, archived, archived_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(id) DO UPDATE SET
                    session_id = excluded.session_id,
                    thread_path = excluded.thread_path,
                    updated_at = excluded.updated_at,
                    source = excluded.source,
                    title = excluded.title,
                    preview = excluded.preview,
                    cwd = excluded.cwd,
                    model_provider = excluded.model_provider,
                    model = excluded.model,
                    tokens_used = excluded.tokens_used,
                    archived = excluded.archived,
                    archived_at = excluded.archived_at",
                params![
                    record.id.as_str(),
                    record.session_id.as_deref(),
                    record.thread_path.as_str(),
                    record.created_at.as_str(),
                    record.updated_at.as_str(),
                    record.source.as_str(),
                    record.title.as_str(),
                    record.preview.as_str(),
                    record.cwd.as_str(),
                    record.model_provider.as_deref(),
                    record.model.as_deref(),
                    record.tokens_used,
                    if record.archived { 1 } else { 0 },
                    record.archived_at.as_deref(),
                ],
            )
            .map_err(sqlite_error)?;
        Ok(())
    }

    pub fn list_threads(&self) -> Result<Vec<ThreadStateRecord>, WorkerProtocolError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, session_id, thread_path, created_at, updated_at, source, title,
                    preview, cwd, model_provider, model, tokens_used, archived, archived_at
                 FROM threads
                 WHERE archived = 0
                 ORDER BY updated_at DESC, id ASC",
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([], row_to_record)
            .map_err(sqlite_error)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(sqlite_error)?);
        }
        Ok(records)
    }

    pub fn list_all_threads(&self) -> Result<Vec<ThreadStateRecord>, WorkerProtocolError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, session_id, thread_path, created_at, updated_at, source, title,
                    preview, cwd, model_provider, model, tokens_used, archived, archived_at
                 FROM threads
                 ORDER BY updated_at DESC, id ASC",
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([], row_to_record)
            .map_err(sqlite_error)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(sqlite_error)?);
        }
        Ok(records)
    }

    pub fn count_threads(&self) -> Result<i64, WorkerProtocolError> {
        let connection = self.open()?;
        connection
            .query_row("SELECT COUNT(*) FROM threads", [], |row| row.get(0))
            .map_err(sqlite_error)
    }

    pub fn reset(&self) -> Result<(), WorkerProtocolError> {
        if self.path.exists() {
            std::fs::remove_file(&self.path).map_err(io_error)?;
        }
        Ok(())
    }

    pub fn find_by_session_or_thread_id(
        &self,
        id: &str,
    ) -> Result<Option<ThreadStateRecord>, WorkerProtocolError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT id, session_id, thread_path, created_at, updated_at, source, title,
                    preview, cwd, model_provider, model, tokens_used, archived, archived_at
                 FROM threads
                 WHERE id = ?1 OR session_id = ?1
                 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END, updated_at DESC, id ASC
                 LIMIT 1",
            )
            .map_err(sqlite_error)?;
        let mut rows = statement.query(params![id]).map_err(sqlite_error)?;
        match rows.next().map_err(sqlite_error)? {
            Some(row) => Ok(Some(row_to_record(row).map_err(sqlite_error)?)),
            None => Ok(None),
        }
    }

    pub fn archive_thread(
        &self,
        id: &str,
        archived_at: String,
    ) -> Result<Option<ThreadStateRecord>, WorkerProtocolError> {
        let Some(mut record) = self.find_by_session_or_thread_id(id)? else {
            return Ok(None);
        };
        record.updated_at = archived_at.clone();
        record.archived = true;
        record.archived_at = Some(archived_at);
        self.upsert_thread(&record)?;
        Ok(Some(record))
    }

    pub fn delete_thread(&self, id: &str) -> Result<bool, WorkerProtocolError> {
        let Some(record) = self.find_by_session_or_thread_id(id)? else {
            return Ok(false);
        };
        let connection = self.open()?;
        let deleted = connection
            .execute("DELETE FROM threads WHERE id = ?1", params![record.id])
            .map_err(sqlite_error)?
            > 0;
        Ok(deleted)
    }

    fn open(&self) -> Result<Connection, WorkerProtocolError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(io_error)?;
        }
        let connection = Connection::open(&self.path).map_err(sqlite_error)?;
        ensure_schema(&connection)?;
        Ok(connection)
    }
}

fn ensure_schema(connection: &Connection) -> Result<(), WorkerProtocolError> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT,
                thread_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                preview TEXT NOT NULL DEFAULT '',
                cwd TEXT NOT NULL DEFAULT '',
                model_provider TEXT,
                model TEXT,
                tokens_used INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_thread_state_updated_at
                ON threads(updated_at DESC, id ASC);
            CREATE INDEX IF NOT EXISTS idx_thread_state_created_at
                ON threads(created_at DESC, id ASC);
            CREATE INDEX IF NOT EXISTS idx_thread_state_archived
                ON threads(archived);
            CREATE INDEX IF NOT EXISTS idx_thread_state_session_id
                ON threads(session_id);
            ",
        )
        .map_err(sqlite_error)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadStateRecord> {
    let archived: i64 = row.get(12)?;
    Ok(ThreadStateRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        thread_path: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        source: row.get(5)?,
        title: row.get(6)?,
        preview: row.get(7)?,
        cwd: row.get(8)?,
        model_provider: row.get(9)?,
        model: row.get(10)?,
        tokens_used: row.get(11)?,
        archived: archived != 0,
        archived_at: row.get(13)?,
    })
}

fn io_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread state IO error: {error}"),
        serde_json::json!({ "method": "thread_state" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn sqlite_error(error: rusqlite::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread state SQLite error: {error}"),
        serde_json::json!({ "method": "thread_state" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tinybot-thread-state-db-{name}-{}",
            std::process::id()
        ))
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
        let _ = fs::remove_dir_all(root);
    }
}
