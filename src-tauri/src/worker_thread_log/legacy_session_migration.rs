use super::{legacy_session_migration_error, SessionMetadata, WorkerProtocolError};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

pub(super) fn read_legacy_session_store(
    workspace_root: &Path,
) -> Result<Option<(PathBuf, Vec<SessionMetadata>)>, WorkerProtocolError> {
    // This is a read-only, one-time migration source. The normal runtime never
    // creates this path or treats it as a persistence authority.
    let path = workspace_root.join("sessions").join("sessions.sqlite");
    if !path.is_file() {
        return Ok(None);
    }
    let connection =
        Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
            legacy_session_migration_error(
                "failed to open legacy session store for migration",
                serde_json::json!({
                    "sourcePath": path,
                    "error": error.to_string(),
                }),
            )
        })?;
    let mut statement = connection
        .prepare("SELECT session_json FROM sessions ORDER BY updated_at DESC, session_id ASC")
        .map_err(|error| {
            legacy_session_migration_error(
                "failed to read legacy session store for migration",
                serde_json::json!({
                    "sourcePath": path,
                    "error": error.to_string(),
                }),
            )
        })?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| {
            legacy_session_migration_error(
                "failed to query legacy session store for migration",
                serde_json::json!({
                    "sourcePath": path,
                    "error": error.to_string(),
                }),
            )
        })?;
    let mut sessions = Vec::new();
    for row in rows {
        let session_json = row.map_err(|error| {
            legacy_session_migration_error(
                "failed to decode legacy session row for migration",
                serde_json::json!({
                    "sourcePath": path,
                    "error": error.to_string(),
                }),
            )
        })?;
        let session = serde_json::from_str(&session_json).map_err(|error| {
            legacy_session_migration_error(
                "legacy session metadata is invalid",
                serde_json::json!({
                    "sourcePath": path,
                    "error": error.to_string(),
                }),
            )
        })?;
        sessions.push(session);
    }
    Ok(Some((path, sessions)))
}
