use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq)]
pub enum NativeProviderStreamEvent {
    MessagePhase(String),
    ContentDelta(String),
    ReasoningDelta(String),
}

#[derive(Default)]
pub(super) struct StreamingChatCompletion {
    state: StreamingCompletionState,
}

impl StreamingChatCompletion {
    pub(super) fn push_chunk(
        &mut self,
        chunk: &Value,
        mut observer: Option<&mut (dyn FnMut(NativeProviderStreamEvent) + Send)>,
    ) -> Result<(), String> {
        let parsed = parse_stream_chunk(chunk);
        self.state = reduce_stream_chunk(std::mem::take(&mut self.state), &parsed)?;
        if let Some(observer) = observer.as_deref_mut() {
            observe_parsed_stream_chunk(&parsed, observer);
        }
        Ok(())
    }

    pub(super) fn finish(self) -> Value {
        streaming_completion_body(self.state)
    }
}

#[derive(Default)]
pub(super) struct StreamingResponsesCompletion {
    completed_response: Option<Value>,
}

impl StreamingResponsesCompletion {
    pub(super) fn push_event(
        &mut self,
        event: &Value,
        mut observer: Option<&mut (dyn FnMut(NativeProviderStreamEvent) + Send)>,
    ) -> Result<(), String> {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Responses API stream event requires type".to_string())?;
        match event_type {
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        if let Some(observer) = observer.as_deref_mut() {
                            observer(NativeProviderStreamEvent::ContentDelta(delta.to_string()));
                        }
                    }
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        if let Some(observer) = observer.as_deref_mut() {
                            observer(NativeProviderStreamEvent::ReasoningDelta(delta.to_string()));
                        }
                    }
                }
            }
            "response.completed" => {
                self.completed_response =
                    Some(event.get("response").cloned().ok_or_else(|| {
                        "Responses API response.completed event requires response".to_string()
                    })?);
            }
            "response.failed" | "response.incomplete" | "error" => {
                return Err(format!(
                    "Responses API stream returned terminal event `{event_type}`: {event}"
                ));
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn finish(self) -> Result<Value, String> {
        self.completed_response
            .ok_or_else(|| "Responses API stream ended before response.completed".to_string())
    }
}

struct ParsedStreamChunk<'a> {
    provider_error: Option<&'a Value>,
    model: Option<&'a str>,
    usage: Option<&'a Value>,
    phase: Option<&'a str>,
    content_delta: Option<&'a str>,
    reasoning_delta: Option<&'a str>,
    tool_call_deltas: Option<&'a [Value]>,
}

fn parse_stream_chunk(chunk: &Value) -> ParsedStreamChunk<'_> {
    ParsedStreamChunk {
        provider_error: chunk.get("error"),
        model: chunk.get("model").and_then(Value::as_str),
        usage: chunk.get("usage").filter(|value| !value.is_null()),
        phase: stream_message_phase(chunk),
        content_delta: stream_content_delta(chunk),
        reasoning_delta: stream_reasoning_delta(chunk),
        tool_call_deltas: chunk
            .pointer("/choices/0/delta/tool_calls")
            .and_then(Value::as_array)
            .map(Vec::as_slice),
    }
}

#[derive(Default)]
struct StreamingCompletionState {
    content: String,
    reasoning_content: String,
    model: Option<String>,
    usage: Option<Value>,
    tool_calls: BTreeMap<usize, StreamingToolCallParts>,
}

fn reduce_stream_chunk(
    mut state: StreamingCompletionState,
    chunk: &ParsedStreamChunk<'_>,
) -> Result<StreamingCompletionState, String> {
    if let Some(error) = chunk.provider_error {
        return Err(format!("streaming chat completion returned error: {error}"));
    }
    if let Some(usage) = chunk.usage {
        state.usage = Some(usage.clone());
    }
    if state.model.is_none() {
        state.model = chunk.model.map(str::to_string);
    }
    if let Some(delta) = chunk.content_delta {
        state.content.push_str(delta);
    }
    if let Some(delta) = chunk.reasoning_delta {
        state.reasoning_content.push_str(delta);
    }
    if let Some(deltas) = chunk.tool_call_deltas {
        state.tool_calls = merge_tool_call_deltas(state.tool_calls, deltas);
    }
    Ok(state)
}

fn merge_tool_call_deltas(
    mut tool_calls: BTreeMap<usize, StreamingToolCallParts>,
    deltas: &[Value],
) -> BTreeMap<usize, StreamingToolCallParts> {
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
        if let Some(arguments) = delta.pointer("/function/arguments").and_then(Value::as_str) {
            entry.arguments.push_str(arguments);
        }
    }
    tool_calls
}

fn observe_parsed_stream_chunk(
    chunk: &ParsedStreamChunk<'_>,
    observer: &mut (dyn FnMut(NativeProviderStreamEvent) + Send),
) {
    if let Some(phase) = chunk.phase {
        observer(NativeProviderStreamEvent::MessagePhase(phase.to_string()));
    }
    if let Some(delta) = chunk.content_delta.filter(|delta| !delta.is_empty()) {
        observer(NativeProviderStreamEvent::ContentDelta(delta.to_string()));
    }
    if let Some(delta) = chunk.reasoning_delta.filter(|delta| !delta.is_empty()) {
        observer(NativeProviderStreamEvent::ReasoningDelta(delta.to_string()));
    }
}

fn streaming_completion_body(state: StreamingCompletionState) -> Value {
    let model = state.model.unwrap_or_else(|| "unknown-model".to_string());
    if state.tool_calls.is_empty() {
        let content = state.content;
        let mut completion = chat_completion_body(&model, &content);
        if !state.reasoning_content.is_empty() {
            completion["choices"][0]["message"]["reasoning_content"] =
                Value::String(state.reasoning_content);
        }
        if let Some(usage) = state.usage {
            completion["usage"] = usage;
        }
        return completion;
    }
    let tool_calls = state
        .tool_calls
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
        "content": state.content,
        "tool_calls": tool_calls,
    });
    if !state.reasoning_content.is_empty() {
        message["reasoning_content"] = Value::String(state.reasoning_content);
    }
    serde_json::json!({
        "id": chat_completion_id(),
        "object": "chat.completion",
        "created": unix_timestamp(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "tool_calls",
        }],
        "usage": state.usage.unwrap_or_else(|| serde_json::json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }))
    })
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

pub(super) fn responses_body(model: &str, content: &str) -> Value {
    serde_json::json!({
        "id": format!("resp-rust-{}", unix_timestamp()),
        "object": "response",
        "created_at": unix_timestamp(),
        "status": "completed",
        "model": model,
        "output": [{
            "id": format!("msg-rust-{}", unix_timestamp()),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": content,
                "annotations": [],
            }],
        }],
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        },
    })
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
