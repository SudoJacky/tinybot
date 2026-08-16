use std::{
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) const NATIVE_BACKEND_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

const MAX_LOG_ARRAY_ITEMS: usize = 32;
const MAX_LOG_CONTEXT_DEPTH: usize = 6;
const MAX_LOG_CONTEXT_KEYS: usize = 64;
const MAX_LOG_EVENT_BYTES: usize = 64 * 1024;
const MAX_LOG_STRING_BYTES: usize = 2 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLogEvent {
    schema_version: &'static str,
    level: NativeLogLevel,
    event: String,
    context: Value,
}

impl NativeLogEvent {
    pub(crate) fn new(level: NativeLogLevel, event: impl Into<String>, context: Value) -> Self {
        Self {
            schema_version: "tinybot.native_log.v1",
            level,
            event: event.into(),
            context: sanitize_native_log_context(context),
        }
    }
}

pub(crate) fn sanitize_native_log_context(value: Value) -> Value {
    sanitize_log_value(value, "", 0)
}

pub(crate) fn append_native_backend_log_event(
    path: &Path,
    max_bytes: u64,
    stream: &str,
    event: NativeLogEvent,
) -> Result<(), String> {
    validate_log_identity("stream", stream)?;
    let line = native_backend_log_event_line(&event)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create native backend log directory: {error}"))?;
    }
    rotate_native_backend_log_if_needed(path, max_bytes)
        .map_err(|error| format!("failed to rotate native backend log: {error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open native backend log: {error}"))?;
    writeln!(file, "{} {} {}", now_unix_ms(), stream, line)
        .map_err(|error| format!("failed to write native backend log: {error}"))
}

pub(crate) fn append_default_native_backend_log_event(
    stream: &str,
    event: NativeLogEvent,
) -> Result<(), String> {
    append_native_backend_log_event(
        &native_backend_log_path(),
        NATIVE_BACKEND_LOG_MAX_BYTES,
        stream,
        event,
    )
}

pub(crate) fn native_backend_log_event_line(event: &NativeLogEvent) -> Result<String, String> {
    validate_log_identity("event", &event.event)?;
    let line = serde_json::to_string(event)
        .map_err(|error| format!("failed to serialize native backend log event: {error}"))?;
    if line.len() > MAX_LOG_EVENT_BYTES {
        return Err(format!(
            "native backend log event exceeds {MAX_LOG_EVENT_BYTES} bytes"
        ));
    }
    Ok(line)
}

pub(crate) fn native_backend_log_event_value(
    stream: &str,
    event: &NativeLogEvent,
) -> Result<Value, String> {
    validate_log_identity("stream", stream)?;
    validate_log_identity("event", &event.event)?;
    let mut value = serde_json::to_value(event)
        .map_err(|error| format!("failed to serialize native backend log event: {error}"))?;
    let object = value
        .as_object_mut()
        .expect("native backend log event must serialize to an object");
    object.insert("stream".to_string(), Value::String(stream.to_string()));
    object.insert(
        "timestampUnixMs".to_string(),
        Value::from(now_unix_ms_u64()),
    );
    Ok(value)
}

pub(crate) fn native_backend_log_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .or_else(|| std::env::var_os("XDG_STATE_HOME"))
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join("tinybot").join("logs").join("native-backend.log")
}

fn rotate_native_backend_log_if_needed(path: &Path, max_bytes: u64) -> std::io::Result<()> {
    if max_bytes == 0
        || std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            < max_bytes
    {
        return Ok(());
    }
    let rotated = native_backend_rotated_log_path(path);
    let _ = std::fs::remove_file(&rotated);
    std::fs::rename(path, rotated)
}

pub(crate) fn native_backend_rotated_log_path(path: &Path) -> PathBuf {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return path.with_extension("1");
    };
    path.with_file_name(format!("{file_name}.1"))
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn now_unix_ms_u64() -> u64 {
    now_unix_ms().min(u128::from(u64::MAX)) as u64
}

fn validate_log_identity(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return Err(format!(
            "native backend log {name} must be non-empty and contain no whitespace"
        ));
    }
    Ok(())
}

fn sanitize_log_value(value: Value, key: &str, depth: usize) -> Value {
    if is_sensitive_log_key(key) {
        return Value::String("[redacted]".to_string());
    }
    match value {
        Value::String(value) => Value::String(truncate_utf8(value, MAX_LOG_STRING_BYTES)),
        Value::Array(values) if depth < MAX_LOG_CONTEXT_DEPTH => Value::Array(
            values
                .into_iter()
                .take(MAX_LOG_ARRAY_ITEMS)
                .map(|value| sanitize_log_value(value, "", depth + 1))
                .collect(),
        ),
        Value::Object(values) if depth < MAX_LOG_CONTEXT_DEPTH => Value::Object(
            values
                .into_iter()
                .take(MAX_LOG_CONTEXT_KEYS)
                .map(|(key, value)| {
                    let sanitized = sanitize_log_value(value, &key, depth + 1);
                    (key, sanitized)
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(_) | Value::Object(_) => Value::String("[truncated]".to_string()),
        value => value,
    }
}

fn is_sensitive_log_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
    [
        "authorization",
        "cookie",
        "credential",
        "password",
        "passcode",
        "secret",
        "token",
        "apikey",
        "prompt",
        "preview",
        "requestbody",
        "responsebody",
    ]
    .iter()
    .any(|sensitive| normalized.contains(sensitive))
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let boundary = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or(0);
    value.truncate(boundary);
    format!("{value}...")
}
