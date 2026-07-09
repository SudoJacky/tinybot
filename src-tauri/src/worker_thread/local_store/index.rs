use super::{validate_thread_id, LocalThreadStore, THREAD_STORE_VERSION};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_thread::types::{ThreadItem, ThreadItemKind, ThreadRecord};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct ThreadIndex {
    pub(super) version: usize,
    pub(super) threads: Vec<ThreadRecord>,
}

impl LocalThreadStore {
    pub(super) fn read_index(&self) -> Result<ThreadIndex, WorkerProtocolError> {
        let connection = self.open_connection()?;
        let mut statement = connection
            .prepare("SELECT record_json FROM threads ORDER BY rowid ASC")
            .map_err(thread_sqlite_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(thread_sqlite_error)?;
        let mut threads = Vec::new();
        for row in rows {
            let record_json = row.map_err(thread_sqlite_error)?;
            threads.push(serde_json::from_str(&record_json).map_err(thread_json_error)?);
        }
        Ok(ThreadIndex {
            version: THREAD_STORE_VERSION,
            threads,
        })
    }

    pub(super) fn write_index(&self, index: &ThreadIndex) -> Result<(), WorkerProtocolError> {
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction().map_err(thread_sqlite_error)?;
        transaction
            .execute("DELETE FROM threads", [])
            .map_err(thread_sqlite_error)?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO threads (
                        thread_id,
                        title,
                        status,
                        session_key,
                        parent_thread_id,
                        source,
                        created_at,
                        updated_at,
                        archived_at,
                        record_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(thread_sqlite_error)?;
            for thread in &index.threads {
                let record_json = serde_json::to_string(thread).map_err(thread_json_error)?;
                statement
                    .execute(params![
                        thread.thread_id.as_str(),
                        thread.title.as_str(),
                        format!("{:?}", thread.status),
                        thread.session_key.as_deref(),
                        thread.parent_thread_id.as_deref(),
                        thread.source.as_str(),
                        thread.created_at.as_str(),
                        thread.updated_at.as_str(),
                        thread.archived_at.as_deref(),
                        record_json
                    ])
                    .map_err(thread_sqlite_error)?;
            }
        }
        transaction.commit().map_err(thread_sqlite_error)
    }

    pub(super) fn read_items(
        &self,
        thread_id: &str,
    ) -> Result<Vec<ThreadItem>, WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let connection = self.open_connection()?;
        let mut statement = connection
            .prepare(
                "SELECT item_json
                 FROM thread_items
                 WHERE thread_id = ?1
                 ORDER BY sequence ASC",
            )
            .map_err(thread_sqlite_error)?;
        let rows = statement
            .query_map(params![thread_id], |row| row.get::<_, String>(0))
            .map_err(thread_sqlite_error)?;
        let mut items = Vec::new();
        for row in rows {
            let item_json = row.map_err(thread_sqlite_error)?;
            items.push(serde_json::from_str(&item_json).map_err(thread_json_error)?);
        }
        Ok(items)
    }

    pub(super) fn write_items(
        &self,
        thread_id: &str,
        items: &[ThreadItem],
    ) -> Result<(), WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction().map_err(thread_sqlite_error)?;
        transaction
            .execute(
                "DELETE FROM thread_items WHERE thread_id = ?1",
                params![thread_id],
            )
            .map_err(thread_sqlite_error)?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO thread_items (
                        thread_id,
                        sequence,
                        item_id,
                        run_id,
                        turn_id,
                        parent_item_id,
                        created_at,
                        kind,
                        item_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .map_err(thread_sqlite_error)?;
            for item in items {
                let item_json = serde_json::to_string(item).map_err(thread_json_error)?;
                statement
                    .execute(params![
                        item.thread_id.as_str(),
                        item.sequence,
                        item.item_id.as_str(),
                        item.run_id.as_deref(),
                        item.turn_id.as_deref(),
                        item.parent_item_id.as_deref(),
                        item.created_at.as_str(),
                        thread_item_kind_name(&item.kind),
                        item_json
                    ])
                    .map_err(thread_sqlite_error)?;
            }
        }
        transaction.commit().map_err(thread_sqlite_error)
    }

    pub(super) fn delete_items(&self, thread_id: &str) -> Result<(), WorkerProtocolError> {
        validate_thread_id(thread_id)?;
        let connection = self.open_connection()?;
        connection
            .execute(
                "DELETE FROM thread_items WHERE thread_id = ?1",
                params![thread_id],
            )
            .map_err(thread_sqlite_error)?;
        Ok(())
    }

    fn open_connection(&self) -> Result<Connection, WorkerProtocolError> {
        fs::create_dir_all(&self.root).map_err(|error| thread_io_error("create", error))?;
        let connection = Connection::open(self.sqlite_path()).map_err(thread_sqlite_error)?;
        ensure_thread_schema(&connection)?;
        Ok(connection)
    }
}

fn ensure_thread_schema(connection: &Connection) -> Result<(), WorkerProtocolError> {
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS threads (
                thread_id TEXT PRIMARY KEY NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                session_key TEXT,
                parent_thread_id TEXT,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT,
                record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_threads_updated_at
                ON threads(updated_at DESC, thread_id ASC);
            CREATE INDEX IF NOT EXISTS idx_threads_session_key
                ON threads(session_key);
            CREATE INDEX IF NOT EXISTS idx_threads_parent
                ON threads(parent_thread_id);
            CREATE TABLE IF NOT EXISTS thread_items (
                thread_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                item_id TEXT NOT NULL,
                run_id TEXT,
                turn_id TEXT,
                parent_item_id TEXT,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                item_json TEXT NOT NULL,
                PRIMARY KEY (thread_id, sequence),
                UNIQUE (thread_id, item_id)
            );
            CREATE INDEX IF NOT EXISTS idx_thread_items_run
                ON thread_items(thread_id, run_id);
            CREATE INDEX IF NOT EXISTS idx_thread_items_created
                ON thread_items(thread_id, created_at);
            ",
        )
        .map_err(thread_sqlite_error)
}

fn thread_item_kind_name(kind: &ThreadItemKind) -> &'static str {
    match kind {
        ThreadItemKind::UserMessage(_) => "user_message",
        ThreadItemKind::AssistantMessageDelta(_) => "assistant_message_delta",
        ThreadItemKind::AssistantMessageCompleted(_) => "assistant_message_completed",
        ThreadItemKind::Reasoning(_) => "reasoning",
        ThreadItemKind::ToolCallStarted(_) => "tool_call_started",
        ThreadItemKind::ToolCallOutput(_) => "tool_call_output",
        ThreadItemKind::ApprovalRequested(_) => "approval_requested",
        ThreadItemKind::ApprovalResolved(_) => "approval_resolved",
        ThreadItemKind::AgentRunStarted(_) => "agent_run_started",
        ThreadItemKind::AgentRunStep(_) => "agent_run_step",
        ThreadItemKind::AgentRunCompleted(_) => "agent_run_completed",
        ThreadItemKind::CheckpointCreated(_) => "checkpoint_created",
        ThreadItemKind::ContextTrimmed(_) => "context_trimmed",
        ThreadItemKind::ContextCompaction(_) => "context_compaction",
        ThreadItemKind::SubagentSpawned(_) => "subagent_spawned",
        ThreadItemKind::SubagentMessage(_) => "subagent_message",
        ThreadItemKind::SubagentCompleted(_) => "subagent_completed",
        ThreadItemKind::SettingsChanged(_) => "settings_changed",
        ThreadItemKind::Error(_) => "error",
        ThreadItemKind::Cancelled(_) => "cancelled",
        ThreadItemKind::Event(_) => "event",
    }
}

fn thread_io_error(operation: &'static str, error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread store IO error during {operation}: {error}"),
        serde_json::json!({ "method": "thread" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_sqlite_error(error: rusqlite::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("thread store SQLite error: {error}"),
        serde_json::json!({ "method": "thread" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_json_error(error: serde_json::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        format!("thread store JSON error: {error}"),
        serde_json::json!({ "method": "thread" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
