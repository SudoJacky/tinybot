fn validate_session_id(session_id: &str) -> Result<(), WorkerProtocolError> {
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

fn unknown_session_error(session_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "session metadata not found",
        serde_json::json!({ "session_id": session_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn default_session_store_version() -> usize {
    1
}

fn session_store_path(root: &Path) -> PathBuf {
    root.join("sessions").join("store.json")
}

fn read_session_store(path: &Path) -> Result<Option<SessionStore>, WorkerProtocolError> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(session_io_error(error)),
    };
    if contents.trim().is_empty() {
        return Ok(None);
    }
    let store = serde_json::from_str(&contents).map_err(|error| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::WorkerError,
            format!("failed to parse session store: {error}"),
            serde_json::json!({ "method": "session" }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })?;
    Ok(Some(store))
}

fn session_io_error(error: std::io::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("session store IO error: {error}"),
        serde_json::json!({ "method": "session" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn session_serialization_error(error: serde_json::Error) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        format!("failed to serialize session store: {error}"),
        serde_json::json!({ "method": "session" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn ensure_extra_object(session: &mut SessionMetadata) {
    if !session.extra.is_object() {
        session.extra = serde_json::json!({});
    }
}

fn ensure_messages_array(session: &mut SessionMetadata) {
    if !session.extra.get("messages").is_some_and(Value::is_array) {
        session.extra["messages"] = serde_json::json!([]);
    }
}
