use super::*;

pub(super) fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

pub(super) fn message_string(message: &Value, key: &str) -> Option<String> {
    message.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(super) fn message_string_any(message: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| message_string(message, key))
}

pub(super) fn message_array_any<'a>(message: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter()
        .find_map(|key| message.get(key).and_then(Value::as_array))
}

pub(super) fn now_session_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("unix-ms:{millis}")
}

pub(super) fn default_omitted_side_effects() -> Vec<String> {
    [
        "conversation_evidence",
        "memory_extraction",
        "consolidation",
        "user_profile_update",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}
