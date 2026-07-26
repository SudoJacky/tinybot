use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq)]
pub enum NativeProviderStreamEvent {
    MessagePhase(String),
    ContentDelta(String),
    ReasoningDelta(String),
}

pub(super) fn aggregate_chat_completion_sse(body: &str) -> Result<Value, String> {
    aggregate_chat_completion_sse_with_observer(body, None)
}

pub(super) fn aggregate_chat_completion_sse_with_observer(
    body: &str,
    mut observer: Option<&mut dyn FnMut(NativeProviderStreamEvent)>,
) -> Result<Value, String> {
    let mut content = String::new();
    let mut reasoning_content = String::new();
    let mut model = None::<String>;
    let mut usage = None::<Value>;
    let mut tool_calls = BTreeMap::<usize, StreamingToolCallParts>::new();
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let chunk: Value = serde_json::from_str(data).map_err(|error| {
            format!("streaming chat completion chunk was invalid JSON: {error}")
        })?;
        if let Some(error) = chunk.get("error") {
            return Err(format!("streaming chat completion returned error: {error}"));
        }
        if let Some(chunk_usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            usage = Some(chunk_usage.clone());
        }
        if model.is_none() {
            model = chunk
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(phase) = stream_message_phase(&chunk) {
            if let Some(observer) = observer.as_deref_mut() {
                observer(NativeProviderStreamEvent::MessagePhase(phase.to_string()));
            }
        }
        if let Some(delta) = stream_content_delta(&chunk) {
            content.push_str(delta);
            if let Some(observer) = observer.as_deref_mut() {
                observer(NativeProviderStreamEvent::ContentDelta(delta.to_string()));
            }
        }
        if let Some(delta) = stream_reasoning_delta(&chunk) {
            reasoning_content.push_str(delta);
            if let Some(observer) = observer.as_deref_mut() {
                observer(NativeProviderStreamEvent::ReasoningDelta(delta.to_string()));
            }
        }
        if let Some(deltas) = chunk
            .pointer("/choices/0/delta/tool_calls")
            .and_then(Value::as_array)
        {
            for (fallback_index, delta) in deltas.iter().enumerate() {
                let index = delta
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(fallback_index);
                let entry = tool_calls.entry(index).or_default();
                if let Some(id) = delta.get("id").and_then(Value::as_str) {
                    entry.id = Some(id.to_string());
                }
                if let Some(call_type) = delta.get("type").and_then(Value::as_str) {
                    entry.call_type = Some(call_type.to_string());
                }
                if let Some(name) = delta.pointer("/function/name").and_then(Value::as_str) {
                    entry.name = Some(name.to_string());
                }
                if let Some(arguments) =
                    delta.pointer("/function/arguments").and_then(Value::as_str)
                {
                    entry.arguments.push_str(arguments);
                }
            }
        }
    }
    let model = model.unwrap_or_else(|| "unknown-model".to_string());
    if tool_calls.is_empty() {
        let mut completion = chat_completion_body(&model, &content);
        if !reasoning_content.is_empty() {
            completion["choices"][0]["message"]["reasoning_content"] =
                Value::String(reasoning_content);
        }
        if let Some(usage) = usage {
            completion["usage"] = usage;
        }
        return Ok(completion);
    }
    let tool_calls = tool_calls
        .into_iter()
        .enumerate()
        .map(|(fallback_index, (_index, parts))| {
            serde_json::json!({
                "id": parts.id.unwrap_or_else(|| format!("tool-call-{}", fallback_index + 1)),
                "type": parts.call_type.unwrap_or_else(|| "function".to_string()),
                "function": {
                    "name": parts.name.unwrap_or_default(),
                    "arguments": parts.arguments,
                }
            })
        })
        .collect::<Vec<_>>();
    let mut message = serde_json::json!({
        "role": "assistant",
        "content": content,
        "tool_calls": tool_calls,
    });
    if !reasoning_content.is_empty() {
        message["reasoning_content"] = Value::String(reasoning_content);
    }
    Ok(serde_json::json!({
        "id": chat_completion_id(),
        "object": "chat.completion",
        "created": unix_timestamp(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "tool_calls",
        }],
        "usage": usage.unwrap_or_else(|| serde_json::json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }))
    }))
}

#[derive(Default)]
struct StreamingToolCallParts {
    id: Option<String>,
    call_type: Option<String>,
    name: Option<String>,
    arguments: String,
}

pub(super) fn chat_completion_body(model: &str, content: &str) -> Value {
    serde_json::json!({
        "id": chat_completion_id(),
        "object": "chat.completion",
        "created": unix_timestamp(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": content,
            },
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    })
}

pub(super) fn chat_completion_sse(model: &str, content: &str) -> String {
    let id = chat_completion_id();
    let created = unix_timestamp();
    let mut body = String::new();
    push_sse_json(
        &mut body,
        &serde_json::json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{ "index": 0, "delta": { "role": "assistant" }, "finish_reason": Value::Null }],
        }),
    );
    if !content.is_empty() {
        push_sse_json(
            &mut body,
            &serde_json::json!({
                "id": id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{ "index": 0, "delta": { "content": content }, "finish_reason": Value::Null }],
            }),
        );
    }
    push_sse_json(
        &mut body,
        &serde_json::json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        }),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

pub(super) fn push_sse_json(body: &mut String, value: &Value) {
    let line = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    body.push_str("data: ");
    body.push_str(&line);
    body.push_str("\n\n");
}

pub(super) fn observe_stream_chunk(
    chunk: &Value,
    observer: &mut dyn FnMut(NativeProviderStreamEvent),
) {
    if let Some(phase) = stream_message_phase(chunk) {
        observer(NativeProviderStreamEvent::MessagePhase(phase.to_string()));
    }
    if let Some(delta) = stream_content_delta(chunk).filter(|delta| !delta.is_empty()) {
        observer(NativeProviderStreamEvent::ContentDelta(delta.to_string()));
    }
    if let Some(delta) = stream_reasoning_delta(chunk).filter(|delta| !delta.is_empty()) {
        observer(NativeProviderStreamEvent::ReasoningDelta(delta.to_string()));
    }
}

pub(super) fn stream_message_phase(chunk: &Value) -> Option<&str> {
    chunk
        .get("phase")
        .or_else(|| chunk.get("message_phase"))
        .or_else(|| chunk.get("messagePhase"))
        .or_else(|| chunk.pointer("/choices/0/delta/phase"))
        .or_else(|| chunk.pointer("/choices/0/delta/message_phase"))
        .or_else(|| chunk.pointer("/choices/0/delta/messagePhase"))
        .or_else(|| chunk.pointer("/choices/0/message/phase"))
        .or_else(|| chunk.pointer("/choices/0/message/message_phase"))
        .or_else(|| chunk.pointer("/choices/0/message/messagePhase"))
        .and_then(Value::as_str)
}

fn stream_content_delta(chunk: &Value) -> Option<&str> {
    chunk
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
}

fn stream_reasoning_delta(chunk: &Value) -> Option<&str> {
    chunk
        .pointer("/choices/0/delta/reasoning_content")
        .or_else(|| chunk.pointer("/choices/0/delta/reasoningContent"))
        .and_then(Value::as_str)
}

fn chat_completion_id() -> String {
    format!("chatcmpl-rust-{}", unix_timestamp())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}
