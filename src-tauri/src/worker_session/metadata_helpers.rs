use super::*;

pub(super) fn validate_session_id(session_id: &str) -> Result<(), WorkerProtocolError> {
    if session_id.is_empty()
        || session_id.contains('\0')
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid session id",
            serde_json::json!({ "session_id": session_id }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ));
    }
    Ok(())
}

pub(super) fn unknown_session_error(session_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "session metadata not found",
        serde_json::json!({ "session_id": session_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn default_session_store_version() -> usize {
    1
}

pub(super) fn session_sqlite_path(root: &Path) -> PathBuf {
    root.join("sessions").join("sessions.sqlite")
}

pub(super) fn read_session_store(path: &Path) -> Result<Option<SessionStore>, WorkerProtocolError> {
    if !path.exists() {
        return Ok(None);
    }
    let connection = open_session_connection(path)?;
    ensure_session_schema(&connection)?;
    let mut statement = connection
        .prepare("SELECT session_json FROM sessions ORDER BY updated_at DESC, session_id ASC")
        .map_err(session_sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(session_sqlite_error)?;
    let mut sessions = Vec::new();
    for row in rows {
        let session_json = row.map_err(session_sqlite_error)?;
        sessions.push(serde_json::from_str(&session_json).map_err(session_serialization_error)?);
    }
    let store = SessionStore {
        version: default_session_store_version(),
        sessions,
    };
    Ok(Some(store))
}

pub(super) fn write_session_store(
    path: &Path,
    store: &SessionStore,
) -> Result<(), WorkerProtocolError> {
    let mut connection = open_session_connection(path)?;
    ensure_session_schema(&connection)?;
    let transaction = connection.transaction().map_err(session_sqlite_error)?;
    transaction
        .execute("DELETE FROM sessions", [])
        .map_err(session_sqlite_error)?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO sessions (
                    session_id,
                    title,
                    workspace_dir,
                    created_at,
                    updated_at,
                    session_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(session_sqlite_error)?;
        for session in &store.sessions {
            let session_json =
                serde_json::to_string(session).map_err(session_serialization_error)?;
            statement
                .execute(params![
                    session.session_id.as_str(),
                    session.title.as_str(),
                    session.workspace_dir.as_str(),
                    session.created_at.as_str(),
                    session.updated_at.as_str(),
                    session_json
                ])
                .map_err(session_sqlite_error)?;
        }
    }
    transaction.commit().map_err(session_sqlite_error)
}

pub(super) fn open_session_connection(path: &Path) -> Result<Connection, WorkerProtocolError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(session_io_error)?;
    }
    Connection::open(path).map_err(session_sqlite_error)
}

pub(super) fn ensure_session_schema(connection: &Connection) -> Result<(), WorkerProtocolError> {
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY NOT NULL,
                title TEXT NOT NULL,
                workspace_dir TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                session_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
                ON sessions(updated_at DESC, session_id ASC);
            ",
        )
        .map_err(session_sqlite_error)
}

pub(super) fn session_io_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("session store IO error: {error}"),
        serde_json::json!({ "method": "session" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn session_sqlite_error(error: rusqlite::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("session store SQLite error: {error}"),
        serde_json::json!({ "method": "session" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn session_serialization_error(error: serde_json::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("failed to serialize session store: {error}"),
        serde_json::json!({ "method": "session" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn ensure_extra_object(session: &mut SessionMetadata) {
    if !session.extra.is_object() {
        session.extra = serde_json::json!({});
    }
}

pub(super) fn ensure_messages_array(session: &mut SessionMetadata) {
    if !session.extra.get("messages").is_some_and(Value::is_array) {
        session.extra["messages"] = serde_json::json!([]);
    }
}
