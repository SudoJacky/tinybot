use super::recorder::ThreadLogHead;
use super::ThreadStateRecord;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct LatestContextCheckpointRecord {
    pub(super) thread_id: String,
    pub(super) ordinal: i64,
    pub(super) timestamp: String,
    pub(super) checkpoint_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ThreadLogHeadRecord {
    pub(super) thread_id: String,
    pub(super) byte_length: i64,
    pub(super) tail_hash: String,
    pub(super) projection_hash: String,
}

#[derive(Clone, Debug)]
pub struct ThreadStateDb {
    path: PathBuf,
    #[cfg(test)]
    fail_next_upserts: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl ThreadStateDb {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            path: workspace_root
                .join(".tinybot")
                .join("state")
                .join("state.sqlite"),
            #[cfg(test)]
            fail_next_upserts: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(test)]
    pub fn upsert_thread(&self, record: &ThreadStateRecord) -> Result<(), WorkerProtocolError> {
        self.maybe_fail_upsert(record)?;
        let connection = self.open()?;
        upsert_thread(&connection, record)?;
        Ok(())
    }

    pub(super) fn upsert_thread_projection(
        &self,
        record: &ThreadStateRecord,
        log_head: &ThreadLogHead,
    ) -> Result<(), WorkerProtocolError> {
        self.maybe_fail_upsert(record)?;
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        upsert_thread(&transaction, record)?;
        let latest_checkpoint = latest_context_checkpoint_for_thread(&transaction, &record.id)?;
        let projection_hash = thread_projection_hash(record, latest_checkpoint.as_ref());
        upsert_thread_log_head(&transaction, &record.id, log_head, projection_hash.as_str())?;
        transaction.commit().map_err(sqlite_error)
    }

    pub(super) fn replace_thread_projection(
        &self,
        record: &ThreadStateRecord,
        latest_checkpoint: Option<&LatestContextCheckpointRecord>,
        log_head: &ThreadLogHead,
    ) -> Result<(), WorkerProtocolError> {
        self.maybe_fail_upsert(record)?;
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        upsert_thread(&transaction, record)?;
        match latest_checkpoint {
            Some(checkpoint) => upsert_latest_context_checkpoint(&transaction, checkpoint)?,
            None => {
                transaction
                    .execute(
                        "DELETE FROM latest_context_checkpoints WHERE thread_id = ?1",
                        params![record.id],
                    )
                    .map_err(sqlite_error)?;
            }
        }
        let projection_hash = thread_projection_hash(record, latest_checkpoint);
        upsert_thread_log_head(&transaction, &record.id, log_head, projection_hash.as_str())?;
        transaction.commit().map_err(sqlite_error)
    }

    pub(super) fn thread_log_head(
        &self,
        id: &str,
    ) -> Result<Option<ThreadLogHeadRecord>, WorkerProtocolError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT head.thread_id, head.byte_length, head.tail_hash, head.projection_hash
                 FROM thread_log_heads head
                 INNER JOIN threads thread ON thread.id = head.thread_id
                 WHERE thread.id = ?1 OR thread.session_id = ?1
                 ORDER BY CASE WHEN thread.id = ?1 THEN 0 ELSE 1 END,
                          thread.updated_at DESC, thread.id ASC
                 LIMIT 1",
            )
            .map_err(sqlite_error)?;
        let mut rows = statement.query(params![id]).map_err(sqlite_error)?;
        match rows.next().map_err(sqlite_error)? {
            Some(row) => row_to_thread_log_head(row).map(Some).map_err(sqlite_error),
            None => Ok(None),
        }
    }

    pub(super) fn list_thread_log_heads(
        &self,
    ) -> Result<Vec<ThreadLogHeadRecord>, WorkerProtocolError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT thread_id, byte_length, tail_hash, projection_hash
                 FROM thread_log_heads
                 ORDER BY thread_id ASC",
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([], row_to_thread_log_head)
            .map_err(sqlite_error)?;
        let mut heads = Vec::new();
        for row in rows {
            heads.push(row.map_err(sqlite_error)?);
        }
        Ok(heads)
    }

    pub(super) fn latest_context_checkpoint(
        &self,
        id: &str,
    ) -> Result<Option<LatestContextCheckpointRecord>, WorkerProtocolError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT checkpoint.thread_id, COALESCE(checkpoint.ordinal, checkpoint.line_number),
                        checkpoint.checkpoint_timestamp, checkpoint.checkpoint_hash
                 FROM latest_context_checkpoints checkpoint
                 INNER JOIN threads thread ON thread.id = checkpoint.thread_id
                 WHERE thread.id = ?1 OR thread.session_id = ?1
                 ORDER BY CASE WHEN thread.id = ?1 THEN 0 ELSE 1 END,
                          thread.updated_at DESC, thread.id ASC
                 LIMIT 1",
            )
            .map_err(sqlite_error)?;
        let mut rows = statement.query(params![id]).map_err(sqlite_error)?;
        match rows.next().map_err(sqlite_error)? {
            Some(row) => row_to_latest_context_checkpoint(row)
                .map(Some)
                .map_err(sqlite_error),
            None => Ok(None),
        }
    }

    pub(super) fn list_latest_context_checkpoints(
        &self,
    ) -> Result<Vec<LatestContextCheckpointRecord>, WorkerProtocolError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT thread_id, COALESCE(ordinal, line_number),
                        checkpoint_timestamp, checkpoint_hash
                 FROM latest_context_checkpoints
                 ORDER BY thread_id ASC",
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([], row_to_latest_context_checkpoint)
            .map_err(sqlite_error)?;
        let mut checkpoints = Vec::new();
        for row in rows {
            checkpoints.push(row.map_err(sqlite_error)?);
        }
        Ok(checkpoints)
    }

    #[cfg(test)]
    pub fn fail_next_upserts(&self, count: usize) {
        self.fail_next_upserts
            .store(count, std::sync::atomic::Ordering::SeqCst);
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

    pub fn reset(&self) -> Result<(), WorkerProtocolError> {
        if !self.path.exists() {
            return Ok(());
        }
        let mut connection = Connection::open(&self.path).map_err(sqlite_error)?;
        connection
            .busy_timeout(SQLITE_BUSY_TIMEOUT)
            .map_err(sqlite_error)?;
        match connection.query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0)) {
            Ok(_) => {}
            Err(error) if is_corrupt_database_error(&error) => {
                drop(connection);
                std::fs::remove_file(&self.path).map_err(io_error)?;
                return Ok(());
            }
            Err(error) => return Err(sqlite_error(error)),
        }
        ensure_schema(&connection)?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction
            .execute_batch(
                "DELETE FROM latest_context_checkpoints;
                 DELETE FROM thread_log_heads;
                 DELETE FROM threads;",
            )
            .map_err(sqlite_error)?;
        transaction.commit().map_err(sqlite_error)
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

    #[cfg(test)]
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
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction
            .execute(
                "DELETE FROM latest_context_checkpoints WHERE thread_id = ?1",
                params![record.id],
            )
            .map_err(sqlite_error)?;
        transaction
            .execute(
                "DELETE FROM thread_log_heads WHERE thread_id = ?1",
                params![record.id],
            )
            .map_err(sqlite_error)?;
        let deleted = transaction
            .execute("DELETE FROM threads WHERE id = ?1", params![record.id])
            .map_err(sqlite_error)?
            > 0;
        transaction.commit().map_err(sqlite_error)?;
        Ok(deleted)
    }

    fn maybe_fail_upsert(&self, _record: &ThreadStateRecord) -> Result<(), WorkerProtocolError> {
        #[cfg(test)]
        if self
            .fail_next_upserts
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |remaining| remaining.checked_sub(1),
            )
            .is_ok()
        {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "injected thread state index upsert failure",
                serde_json::json!({ "threadId": _record.id }),
                true,
                WorkerProtocolErrorSource::RustCore,
            ));
        }
        Ok(())
    }

    fn open(&self) -> Result<Connection, WorkerProtocolError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(io_error)?;
        }
        let connection = Connection::open(&self.path).map_err(sqlite_error)?;
        connection
            .busy_timeout(SQLITE_BUSY_TIMEOUT)
            .map_err(sqlite_error)?;
        ensure_schema(&connection)?;
        Ok(connection)
    }
}

fn is_corrupt_database_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            )
    )
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
            CREATE TABLE IF NOT EXISTS latest_context_checkpoints (
                thread_id TEXT PRIMARY KEY NOT NULL,
                line_number INTEGER NOT NULL,
                ordinal INTEGER,
                checkpoint_timestamp TEXT NOT NULL,
                checkpoint_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS thread_log_heads (
                thread_id TEXT PRIMARY KEY NOT NULL,
                byte_length INTEGER NOT NULL,
                tail_hash TEXT NOT NULL,
                projection_hash TEXT NOT NULL DEFAULT ''
            );
            ",
        )
        .map_err(sqlite_error)?;
    let has_ordinal = {
        let mut statement = connection
            .prepare("PRAGMA table_info(latest_context_checkpoints)")
            .map_err(sqlite_error)?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_error)?;
        let mut found = false;
        for column in columns {
            if column.map_err(sqlite_error)? == "ordinal" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_ordinal {
        connection
            .execute(
                "ALTER TABLE latest_context_checkpoints ADD COLUMN ordinal INTEGER",
                [],
            )
            .map_err(sqlite_error)?;
    }
    connection
        .execute(
            "UPDATE latest_context_checkpoints
             SET ordinal = line_number
             WHERE ordinal IS NULL",
            [],
        )
        .map_err(sqlite_error)?;
    let has_projection_hash = {
        let mut statement = connection
            .prepare("PRAGMA table_info(thread_log_heads)")
            .map_err(sqlite_error)?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_error)?;
        let mut found = false;
        for column in columns {
            if column.map_err(sqlite_error)? == "projection_hash" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_projection_hash {
        connection
            .execute(
                "ALTER TABLE thread_log_heads
                 ADD COLUMN projection_hash TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(sqlite_error)?;
    }
    Ok(())
}

fn upsert_thread(
    connection: &Connection,
    record: &ThreadStateRecord,
) -> Result<(), WorkerProtocolError> {
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

fn upsert_latest_context_checkpoint(
    connection: &Connection,
    checkpoint: &LatestContextCheckpointRecord,
) -> Result<(), WorkerProtocolError> {
    connection
        .execute(
            "INSERT INTO latest_context_checkpoints (
                thread_id, line_number, ordinal, checkpoint_timestamp, checkpoint_hash
             ) VALUES (?1, ?2, ?2, ?3, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET
                line_number = excluded.line_number,
                ordinal = excluded.ordinal,
                checkpoint_timestamp = excluded.checkpoint_timestamp,
                checkpoint_hash = excluded.checkpoint_hash",
            params![
                checkpoint.thread_id.as_str(),
                checkpoint.ordinal,
                checkpoint.timestamp.as_str(),
                checkpoint.checkpoint_hash.as_str(),
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

fn latest_context_checkpoint_for_thread(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<LatestContextCheckpointRecord>, WorkerProtocolError> {
    connection
        .query_row(
            "SELECT thread_id, COALESCE(ordinal, line_number),
                    checkpoint_timestamp, checkpoint_hash
             FROM latest_context_checkpoints
             WHERE thread_id = ?1",
            params![thread_id],
            row_to_latest_context_checkpoint,
        )
        .optional()
        .map_err(sqlite_error)
}

pub(super) fn thread_projection_hash(
    record: &ThreadStateRecord,
    latest_checkpoint: Option<&LatestContextCheckpointRecord>,
) -> String {
    let checkpoint = latest_checkpoint.map(|checkpoint| {
        serde_json::json!({
            "threadId": checkpoint.thread_id,
            "ordinal": checkpoint.ordinal,
            "timestamp": checkpoint.timestamp,
            "checkpointHash": checkpoint.checkpoint_hash,
        })
    });
    let projection = serde_json::json!({
        "id": record.id,
        "sessionId": record.session_id,
        "threadPath": record.thread_path,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "source": record.source,
        "title": record.title,
        "preview": record.preview,
        "cwd": record.cwd,
        "modelProvider": record.model_provider,
        "model": record.model,
        "tokensUsed": record.tokens_used,
        "archived": record.archived,
        "archivedAt": record.archived_at,
        "latestCheckpoint": checkpoint,
    });
    let encoded =
        serde_json::to_vec(&projection).expect("thread projection JSON serialization cannot fail");
    format!("sha256:{:x}", Sha256::digest(encoded))
}

fn upsert_thread_log_head(
    connection: &Connection,
    thread_id: &str,
    log_head: &ThreadLogHead,
    projection_hash: &str,
) -> Result<(), WorkerProtocolError> {
    connection
        .execute(
            "INSERT INTO thread_log_heads (
                thread_id, byte_length, tail_hash, projection_hash
             ) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET
                byte_length = excluded.byte_length,
                tail_hash = excluded.tail_hash,
                projection_hash = excluded.projection_hash",
            params![
                thread_id,
                log_head.byte_length,
                log_head.tail_hash.as_str(),
                projection_hash
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
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

fn row_to_latest_context_checkpoint(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<LatestContextCheckpointRecord> {
    Ok(LatestContextCheckpointRecord {
        thread_id: row.get(0)?,
        ordinal: row.get(1)?,
        timestamp: row.get(2)?,
        checkpoint_hash: row.get(3)?,
    })
}

fn row_to_thread_log_head(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadLogHeadRecord> {
    Ok(ThreadLogHeadRecord {
        thread_id: row.get(0)?,
        byte_length: row.get(1)?,
        tail_hash: row.get(2)?,
        projection_hash: row.get(3)?,
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
#[path = "state_db_tests.rs"]
mod tests;
