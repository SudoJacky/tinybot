fn session_message_key(message: &Value) -> String {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let key = match role {
        "tool" => serde_json::json!(["tool", message_field(message, "toolCallId", "tool_call_id")]),
        "assistant" => serde_json::json!([
            "assistant",
            message.get("content").cloned().unwrap_or(Value::Null),
            normalized_tool_calls_for_key(message),
        ]),
        "user" => serde_json::json!([
            "user",
            message.get("content").cloned().unwrap_or(Value::Null),
        ]),
        _ => serde_json::json!([role, message.get("content").cloned().unwrap_or(Value::Null),]),
    };
    serde_json::to_string(&key).unwrap_or_default()
}

fn message_field(message: &Value, camel: &str, snake: &str) -> Value {
    message
        .get(camel)
        .or_else(|| message.get(snake))
        .cloned()
        .unwrap_or(Value::Null)
}

fn normalized_tool_calls_for_key(message: &Value) -> Value {
    let Some(tool_calls) = message_array_any(message, &["toolCalls", "tool_calls"]) else {
        return Value::Null;
    };
    Value::Array(
        tool_calls
            .iter()
            .map(normalized_tool_call_for_key)
            .collect(),
    )
}

fn normalized_tool_call_for_key(tool_call: &Value) -> Value {
    let function = tool_call.get("function").and_then(Value::as_object);
    serde_json::json!({
        "id": message_string(tool_call, "id"),
        "name": message_string(tool_call, "name")
            .or_else(|| function.and_then(|payload| payload.get("name")).and_then(Value::as_str).map(str::to_string)),
        "arguments": message_string(tool_call, "argumentsJson")
            .or_else(|| message_string(tool_call, "arguments_json"))
            .or_else(|| function.and_then(|payload| payload.get("arguments")).and_then(Value::as_str).map(str::to_string)),
    })
}

fn project_history_messages(
    messages: &[Value],
    last_consolidated: usize,
    limit: usize,
) -> Vec<Value> {
    let unconsolidated_start = last_consolidated.min(messages.len());
    let unconsolidated = &messages[unconsolidated_start..];
    let limit_start = unconsolidated.len().saturating_sub(limit);
    let mut sliced = &unconsolidated[limit_start..];
    if let Some(first_user) = sliced
        .iter()
        .position(|message| message_role(message) == Some("user"))
    {
        sliced = &sliced[first_user..];
    }
    let legal_start = find_legal_message_start(sliced);
    sliced[legal_start..]
        .iter()
        .filter(|message| !is_progress_message(message))
        .filter_map(project_history_message)
        .collect()
}

fn recent_legal_suffix(messages: &[Value], keep_recent_messages: usize) -> Vec<Value> {
    if messages.len() <= keep_recent_messages {
        return messages.to_vec();
    }
    let mut start_idx = messages.len().saturating_sub(keep_recent_messages);
    while start_idx > 0 && message_role(&messages[start_idx]) != Some("user") {
        start_idx -= 1;
    }
    let retained = &messages[start_idx..];
    let legal_start = find_legal_message_start(retained);
    retained[legal_start..].to_vec()
}

fn session_last_consolidated(session: &SessionMetadata) -> usize {
    session
        .extra
        .get("last_consolidated")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or_default()
}

fn temporary_chunk_count(content: &str) -> usize {
    let len = content.chars().count();
    if len == 0 {
        0
    } else {
        len.div_ceil(900)
    }
}

fn stable_upload_digest(session_id: &str, name: &str, timestamp: &str, content: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    session_id.hash(&mut hasher);
    name.hash(&mut hasher);
    timestamp.hash(&mut hasher);
    content
        .chars()
        .take(200)
        .collect::<String>()
        .hash(&mut hasher);
    format!("{:010x}", hasher.finish())[..10].to_string()
}

fn find_legal_message_start(messages: &[Value]) -> usize {
    let mut declared: Vec<String> = Vec::new();
    let mut start = 0;
    for (index, message) in messages.iter().enumerate() {
        match message_role(message) {
            Some("assistant") => {
                for tool_call_id in assistant_tool_call_ids(message) {
                    if !declared.contains(&tool_call_id) {
                        declared.push(tool_call_id);
                    }
                }
            }
            Some("tool") => {
                if let Some(tool_call_id) =
                    message_string_any(message, &["tool_call_id", "toolCallId"])
                {
                    if !declared.contains(&tool_call_id) {
                        start = index + 1;
                        declared.clear();
                        for previous in &messages[start..=index] {
                            if message_role(previous) == Some("assistant") {
                                for previous_tool_call_id in assistant_tool_call_ids(previous) {
                                    if !declared.contains(&previous_tool_call_id) {
                                        declared.push(previous_tool_call_id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    start
}

fn project_history_message(message: &Value) -> Option<Value> {
    let object = message.as_object()?;
    let role = object.get("role")?.as_str()?;
    let mut projected = serde_json::Map::new();
    projected.insert("role".to_string(), Value::String(role.to_string()));
    projected.insert(
        "content".to_string(),
        object
            .get("content")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    for key in [
        "tool_calls",
        "toolCalls",
        "tool_call_id",
        "toolCallId",
        "name",
        "reasoning_content",
        "reasoningContent",
        "thinking_blocks",
        "thinkingBlocks",
        "usage",
    ] {
        if let Some(value) = object.get(key) {
            projected.insert(key.to_string(), value.clone());
        }
    }
    Some(Value::Object(projected))
}

fn assistant_tool_call_ids(message: &Value) -> Vec<String> {
    message_array_any(message, &["tool_calls", "toolCalls"])
        .map(|tool_calls| {
            tool_calls
                .iter()
                .filter_map(|tool_call| message_string(tool_call, "id"))
                .collect()
        })
        .unwrap_or_default()
}
