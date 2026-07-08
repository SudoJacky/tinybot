use super::{ThreadLogItem, ThreadLogLine, ThreadMeta, ThreadReplay, TokenUsage, TokenUsageInfo};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde_json::{json, Value};

const DEFAULT_TITLE: &str = "New session";
const PRESERVED_MESSAGE_FIELDS: &[&str] = &[
    "id",
    "messageId",
    "message_id",
    "turnId",
    "turn_id",
    "usage",
    "tokenUsageInfo",
    "token_usage_info",
    "metadata",
    "references",
    "contextReferences",
    "context_references",
    "toolActivities",
    "tool_activities",
    "artifacts",
    "reasoningContent",
    "reasoning_content",
    "toolCalls",
    "tool_calls",
    "toolCallId",
    "tool_call_id",
    "toolName",
    "tool_name",
    "name",
    "arguments",
    "argumentsJson",
    "arguments_json",
    "function",
    "status",
];

pub fn replay_thread(lines: &[ThreadLogLine]) -> Result<ThreadReplay, WorkerProtocolError> {
    let mut replay = ThreadReplay::default();
    for line in lines {
        match &line.item {
            ThreadLogItem::ThreadMeta(meta) => apply_meta(&mut replay, meta, &line.timestamp),
            ThreadLogItem::ResponseItem(item) => {
                apply_response_item(&mut replay, item, &line.timestamp)
            }
            ThreadLogItem::EventMsg(event) => apply_event(&mut replay, event, &line.timestamp)?,
            ThreadLogItem::Compacted(compacted) => {
                apply_compacted(&mut replay, compacted, &line.timestamp)?
            }
            ThreadLogItem::TurnContext(_)
            | ThreadLogItem::WorldState(_)
            | ThreadLogItem::InterAgentCommunication(_) => {}
        }
    }
    attach_token_usage_to_history(&mut replay);
    Ok(replay)
}

fn apply_meta(replay: &mut ThreadReplay, meta: &ThreadMeta, timestamp: &str) {
    replay.thread_id = meta.thread_id.clone();
    replay.session_id = meta
        .session_id
        .clone()
        .unwrap_or_else(|| meta.thread_id.clone());
    replay.title = DEFAULT_TITLE.to_string();
    replay.updated_at = timestamp.to_string();
}

fn apply_response_item(replay: &mut ThreadReplay, item: &Value, timestamp: &str) {
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let content = thread_item_content(item);
    let mut message = json!({
        "role": role,
        "content": content,
        "timestamp": timestamp
    });
    copy_optional_message_fields(item, &mut message, PRESERVED_MESSAGE_FIELDS);
    replay.messages.push(message);
    replay.updated_at = timestamp.to_string();
}

fn apply_event(
    replay: &mut ThreadReplay,
    event: &Value,
    timestamp: &str,
) -> Result<(), WorkerProtocolError> {
    replay.updated_at = timestamp.to_string();
    if event.get("type").and_then(Value::as_str) != Some("token_count") {
        return Ok(());
    }
    let info = token_usage_info_value(event).ok_or_else(|| {
        replay_semantic_error(
            "thread log token_count event is missing token usage info",
            timestamp,
            json!({ "event": event }),
        )
    })?;
    replay.token_usage_info = Some(parse_token_usage_info(info, timestamp)?);
    Ok(())
}

fn apply_compacted(
    replay: &mut ThreadReplay,
    compacted: &Value,
    timestamp: &str,
) -> Result<(), WorkerProtocolError> {
    let replacement_history = compacted
        .get("replacementHistory")
        .or_else(|| compacted.get("replacement_history"))
        .ok_or_else(|| {
            replay_semantic_error(
                "thread log compacted item is missing replacementHistory",
                timestamp,
                json!({ "compacted": compacted }),
            )
        })?
        .as_array()
        .ok_or_else(|| {
            replay_semantic_error(
                "thread log compacted replacementHistory must be an array",
                timestamp,
                json!({ "compacted": compacted }),
            )
        })?;
    replay.messages = replacement_history.clone();
    replay.token_usage_info = None;
    Ok(())
}

fn attach_token_usage_to_history(replay: &mut ThreadReplay) {
    if replay.messages.is_empty() {
        return;
    }
    let Some(token_usage_info) = replay.token_usage_info.as_ref() else {
        return;
    };
    let Ok(token_usage_value) = serde_json::to_value(token_usage_info) else {
        return;
    };
    let target_index = replay
        .messages
        .iter()
        .rev()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .map(|reverse_index| replay.messages.len() - 1 - reverse_index)
        .unwrap_or_else(|| replay.messages.len() - 1);
    let target = &mut replay.messages[target_index];
    if target.get("tokenUsageInfo").is_none() {
        target["tokenUsageInfo"] = token_usage_value.clone();
    }
    if target.get("usage").is_none() {
        target["usage"] = usage_from_token_usage_info(&token_usage_value);
    }
}

fn token_usage_info_value(event: &Value) -> Option<&Value> {
    event
        .get("info")
        .or_else(|| event.get("tokenUsageInfo"))
        .or_else(|| event.get("token_usage_info"))
        .or_else(|| {
            let payload = event.get("payload")?;
            payload
                .get("info")
                .or_else(|| payload.get("tokenUsageInfo"))
                .or_else(|| payload.get("token_usage_info"))
        })
}

fn parse_token_usage_info(
    value: &Value,
    timestamp: &str,
) -> Result<TokenUsageInfo, WorkerProtocolError> {
    parse_token_usage_info_fields(value, timestamp)
}

fn parse_token_usage_info_fields(
    value: &Value,
    timestamp: &str,
) -> Result<TokenUsageInfo, WorkerProtocolError> {
    Ok(TokenUsageInfo {
        total_token_usage: parse_token_usage(
            field_any(value, &["totalTokenUsage", "total_token_usage"])
                .ok_or_else(|| missing_token_usage_field(timestamp, "totalTokenUsage", value))?,
            timestamp,
        )?,
        last_token_usage: parse_token_usage(
            field_any(value, &["lastTokenUsage", "last_token_usage"])
                .ok_or_else(|| missing_token_usage_field(timestamp, "lastTokenUsage", value))?,
            timestamp,
        )?,
        model_context_window: optional_i64_field_any(
            value,
            &["modelContextWindow", "model_context_window"],
            timestamp,
            "modelContextWindow",
        )?,
    })
}

fn parse_token_usage(value: &Value, timestamp: &str) -> Result<TokenUsage, WorkerProtocolError> {
    if !value.is_object() {
        return Err(replay_semantic_error(
            "thread log token usage fields must be objects",
            timestamp,
            json!({ "tokenUsage": value }),
        ));
    }
    Ok(TokenUsage {
        input_tokens: optional_i64_field_any(
            value,
            &["inputTokens", "input_tokens"],
            timestamp,
            "inputTokens",
        )?
        .unwrap_or_default(),
        cached_input_tokens: optional_i64_field_any(
            value,
            &["cachedInputTokens", "cached_input_tokens"],
            timestamp,
            "cachedInputTokens",
        )?
        .unwrap_or_default(),
        output_tokens: optional_i64_field_any(
            value,
            &["outputTokens", "output_tokens"],
            timestamp,
            "outputTokens",
        )?
        .unwrap_or_default(),
        reasoning_output_tokens: optional_i64_field_any(
            value,
            &["reasoningOutputTokens", "reasoning_output_tokens"],
            timestamp,
            "reasoningOutputTokens",
        )?
        .unwrap_or_default(),
        total_tokens: required_i64_field_any(
            value,
            &["totalTokens", "total_tokens"],
            timestamp,
            "totalTokens",
        )?,
    })
}

fn usage_from_token_usage_info(token_usage_info: &Value) -> Value {
    let last = token_usage_info
        .get("lastTokenUsage")
        .expect("TokenUsageInfo serializes lastTokenUsage");
    let total = token_usage_info.get("totalTokenUsage");
    let used_tokens =
        i64_field_any(last, &["totalTokens"]).expect("TokenUsageInfo serializes totalTokens");
    let context_window = i64_field_any(token_usage_info, &["modelContextWindow"]);
    let remaining_tokens = context_window.map(|window| window.saturating_sub(used_tokens).max(0));
    let percent = context_window
        .filter(|window| *window > 0)
        .map(|window| ((used_tokens as f64 / window as f64) * 100.0).clamp(0.0, 100.0));
    json!({
        "cachedTokens": i64_field_any(last, &["cachedInputTokens"]),
        "completionTokens": i64_field_any(last, &["outputTokens"]),
        "contextWindowRemainingTokens": remaining_tokens,
        "contextWindowTokens": context_window,
        "contextWindowUsedTokens": used_tokens,
        "estimatedContextTokens": used_tokens,
        "promptTokens": i64_field_any(last, &["inputTokens"]),
        "reasoningOutputTokens": i64_field_any(last, &["reasoningOutputTokens"]),
        "totalTokens": used_tokens,
        "cumulativeUsageTokens": total.and_then(|usage| i64_field_any(usage, &["totalTokens"])),
        "percent": percent,
    })
}

fn copy_optional_message_fields(payload: &Value, message: &mut Value, fields: &[&str]) {
    let Some(message_object) = message.as_object_mut() else {
        return;
    };
    for field in fields {
        if let Some(value) = payload.get(*field) {
            message_object.insert((*field).to_string(), value.clone());
        }
    }
}

fn thread_item_content(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| payload.get("text").and_then(Value::as_str))
        .or_else(|| payload.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            payload
                .get("content")
                .or_else(|| payload.get("text"))
                .map(Value::to_string)
                .unwrap_or_default()
        })
}

fn field_any<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a Value> {
    fields.iter().find_map(|field| value.get(*field))
}

fn i64_field_any(value: &Value, fields: &[&str]) -> Option<i64> {
    field_any(value, fields).and_then(|field| {
        field
            .as_i64()
            .or_else(|| field.as_u64().and_then(|number| i64::try_from(number).ok()))
    })
}

fn optional_i64_field_any(
    value: &Value,
    fields: &[&str],
    timestamp: &str,
    display_field: &str,
) -> Result<Option<i64>, WorkerProtocolError> {
    let Some(field) = field_any(value, fields) else {
        return Ok(None);
    };
    parse_i64_field(field).map(Some).ok_or_else(|| {
        replay_semantic_error(
            format!("thread log token usage field {display_field} must be an integer"),
            timestamp,
            json!({
                "field": display_field,
                "tokenUsage": value
            }),
        )
    })
}

fn required_i64_field_any(
    value: &Value,
    fields: &[&str],
    timestamp: &str,
    display_field: &str,
) -> Result<i64, WorkerProtocolError> {
    field_any(value, fields)
        .ok_or_else(|| {
            replay_semantic_error(
                format!("thread log token usage is missing {display_field}"),
                timestamp,
                json!({ "tokenUsage": value }),
            )
        })
        .and_then(|field| {
            parse_i64_field(field).ok_or_else(|| {
                replay_semantic_error(
                    format!("thread log token usage field {display_field} must be an integer"),
                    timestamp,
                    json!({
                        "field": display_field,
                        "tokenUsage": value
                    }),
                )
            })
        })
}

fn parse_i64_field(field: &Value) -> Option<i64> {
    field
        .as_i64()
        .or_else(|| field.as_u64().and_then(|number| i64::try_from(number).ok()))
}

fn missing_token_usage_field(timestamp: &str, field: &str, value: &Value) -> WorkerProtocolError {
    replay_semantic_error(
        format!("thread log token_count event is missing {field}"),
        timestamp,
        json!({ "tokenUsageInfo": value }),
    )
}

fn replay_semantic_error(
    message: impl Into<String>,
    timestamp: &str,
    detail: Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message.into(),
        json!({
            "method": "thread_log.replay",
            "timestamp": timestamp,
            "detail": detail
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_thread_log::{ThreadLogItem, ThreadLogLine, ThreadMeta};
    use serde_json::json;

    #[test]
    fn replay_projects_messages_and_latest_token_count() {
        let replay = replay_thread(&[
            meta_line("thread-1", Some("session-1"), "2026-07-08T10:00:00Z"),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "user",
                    "messageId": "user-1",
                    "content": "hello"
                }),
            ),
            token_count_line("2026-07-08T10:02:00Z", 172, 128000),
            token_count_line("2026-07-08T10:03:00Z", 200, 128000),
        ])
        .unwrap();

        assert_eq!(replay.thread_id, "thread-1");
        assert_eq!(replay.session_id, "session-1");
        assert_eq!(replay.title, DEFAULT_TITLE);
        assert_eq!(replay.updated_at, "2026-07-08T10:03:00Z");
        assert_eq!(replay.messages.len(), 1);
        assert_eq!(replay.messages[0]["messageId"], "user-1");
        assert_eq!(
            replay.messages[0]["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            200
        );
        assert_eq!(replay.messages[0]["usage"]["contextWindowUsedTokens"], 200);
        assert_eq!(replay.messages[0]["usage"]["contextWindowTokens"], 128000);
        assert_eq!(replay.messages[0]["usage"]["cumulativeUsageTokens"], 1200);
        assert_eq!(
            replay
                .token_usage_info
                .unwrap()
                .last_token_usage
                .total_tokens,
            200
        );
    }

    #[test]
    fn replay_preserves_existing_frontend_fields() {
        let replay = replay_thread(&[
            meta_line("thread-fields", None, "2026-07-08T10:00:00Z"),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "assistant",
                    "id": "response-id",
                    "message_id": "message-snake",
                    "messageId": "message-camel",
                    "content": [{"type": "output_text", "text": "structured"}],
                    "usage": {"totalTokens": 9},
                    "tokenUsageInfo": {"lastTokenUsage": {"totalTokens": 9}},
                    "metadata": {"k": "v"},
                    "references": [{"uri": "file:///tmp/a"}],
                    "context_references": [{"id": "ctx-snake"}],
                    "contextReferences": [{"id": "ctx-camel"}],
                    "tool_activities": [{"id": "tool-snake"}],
                    "toolActivities": [{"id": "tool-camel"}],
                    "artifacts": [{"id": "artifact-1"}],
                    "reasoning_content": "snake reasoning",
                    "reasoningContent": "camel reasoning",
                    "tool_calls": [{"id": "call-snake"}],
                    "toolCalls": [{"id": "call-camel"}],
                    "tool_call_id": "call-result-snake",
                    "toolCallId": "call-result-camel",
                    "name": "lookup",
                    "arguments_json": "{}",
                    "argumentsJson": "{}",
                    "function": {"name": "lookup"}
                }),
            ),
        ])
        .unwrap();

        let message = &replay.messages[0];
        assert_eq!(replay.session_id, "thread-fields");
        assert_eq!(
            message["content"],
            "[{\"text\":\"structured\",\"type\":\"output_text\"}]"
        );
        assert_eq!(message["id"], "response-id");
        assert_eq!(message["messageId"], "message-camel");
        assert_eq!(message["message_id"], "message-snake");
        assert_eq!(message["usage"]["totalTokens"], 9);
        assert_eq!(
            message["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            9
        );
        assert_eq!(message["metadata"]["k"], "v");
        assert_eq!(message["references"][0]["uri"], "file:///tmp/a");
        assert_eq!(message["contextReferences"][0]["id"], "ctx-camel");
        assert_eq!(message["context_references"][0]["id"], "ctx-snake");
        assert_eq!(message["toolActivities"][0]["id"], "tool-camel");
        assert_eq!(message["tool_activities"][0]["id"], "tool-snake");
        assert_eq!(message["artifacts"][0]["id"], "artifact-1");
        assert_eq!(message["reasoningContent"], "camel reasoning");
        assert_eq!(message["reasoning_content"], "snake reasoning");
        assert_eq!(message["toolCalls"][0]["id"], "call-camel");
        assert_eq!(message["tool_calls"][0]["id"], "call-snake");
        assert_eq!(message["toolCallId"], "call-result-camel");
        assert_eq!(message["tool_call_id"], "call-result-snake");
        assert_eq!(message["name"], "lookup");
        assert_eq!(message["argumentsJson"], "{}");
        assert_eq!(message["arguments_json"], "{}");
        assert_eq!(message["function"]["name"], "lookup");
    }

    #[test]
    fn replay_compacted_replacement_history_wins() {
        let replay = replay_thread(&[
            meta_line(
                "thread-compact",
                Some("session-compact"),
                "2026-07-08T10:00:00Z",
            ),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "user",
                    "messageId": "old-user",
                    "content": "old"
                }),
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:02:00Z".to_string(),
                item: ThreadLogItem::Compacted(json!({
                    "replacementHistory": [
                        {
                            "role": "assistant",
                            "messageId": "compact-summary",
                            "content": "Summary of earlier context",
                            "timestamp": "2026-07-08T10:02:00Z"
                        }
                    ]
                })),
            },
        ])
        .unwrap();

        assert_eq!(replay.messages.len(), 1);
        assert_eq!(replay.messages[0]["messageId"], "compact-summary");
    }

    #[test]
    fn replay_compacted_clears_previous_token_usage() {
        let replay = replay_thread(&[
            meta_line(
                "thread-compact-usage",
                Some("session-compact-usage"),
                "2026-07-08T10:00:00Z",
            ),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "assistant",
                    "messageId": "old-assistant",
                    "content": "old"
                }),
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:02:00Z".to_string(),
                item: ThreadLogItem::EventMsg(json!({
                    "type": "token_count",
                    "info": {
                        "totalTokenUsage": usage_value(1500),
                        "lastTokenUsage": usage_value(300),
                        "modelContextWindow": 128000
                    }
                })),
            },
            ThreadLogLine {
                timestamp: "2026-07-08T10:03:00Z".to_string(),
                item: ThreadLogItem::Compacted(json!({
                    "replacementHistory": []
                })),
            },
        ])
        .unwrap();

        assert!(replay.messages.is_empty());
        assert!(replay.token_usage_info.is_none());
    }

    #[test]
    fn replay_attaches_token_count_that_arrives_after_assistant_message() {
        let replay = replay_thread(&[
            meta_line(
                "thread-token",
                Some("session-token"),
                "2026-07-08T10:00:00Z",
            ),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "user",
                    "messageId": "user-token",
                    "content": "hello"
                }),
            ),
            response_line(
                "2026-07-08T10:02:00Z",
                json!({
                    "role": "assistant",
                    "messageId": "assistant-token",
                    "content": "hi"
                }),
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:03:00Z".to_string(),
                item: ThreadLogItem::EventMsg(json!({
                    "type": "token_count",
                    "payload": {
                        "tokenUsageInfo": {
                            "totalTokenUsage": usage_value(1500),
                            "lastTokenUsage": usage_value(300),
                            "modelContextWindow": 128000
                        }
                    }
                })),
            },
        ])
        .unwrap();

        assert_eq!(replay.messages[0].get("usage"), None);
        assert_eq!(replay.messages[1]["messageId"], "assistant-token");
        assert_eq!(
            replay.messages[1]["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            300
        );
        assert_eq!(replay.messages[1]["usage"]["contextWindowUsedTokens"], 300);
        assert_eq!(replay.messages[1]["usage"]["cumulativeUsageTokens"], 1500);
    }

    #[test]
    fn replay_errors_on_malformed_token_count() {
        let error = replay_thread(&[
            meta_line(
                "thread-bad-token",
                Some("session-bad-token"),
                "2026-07-08T10:00:00Z",
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:01:00Z".to_string(),
                item: ThreadLogItem::EventMsg(json!({
                    "type": "token_count",
                    "info": {
                        "totalTokenUsage": usage_value(1500),
                        "lastTokenUsage": {
                            "inputTokens": 1
                        },
                        "modelContextWindow": 128000
                    }
                })),
            },
        ])
        .unwrap_err();

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["method"], "thread_log.replay");
        assert!(error.message.contains("totalTokens"));
    }

    #[test]
    fn replay_errors_on_present_non_integer_optional_token_field() {
        let error = replay_thread(&[
            meta_line(
                "thread-bad-optional-token",
                Some("session-bad-optional-token"),
                "2026-07-08T10:00:00Z",
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:01:00Z".to_string(),
                item: ThreadLogItem::EventMsg(json!({
                    "type": "token_count",
                    "info": {
                        "totalTokenUsage": usage_value(1500),
                        "lastTokenUsage": {
                            "inputTokens": 1,
                            "outputTokens": "162",
                            "totalTokens": 172
                        },
                        "modelContextWindow": 128000
                    }
                })),
            },
        ])
        .unwrap_err();

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["method"], "thread_log.replay");
        assert_eq!(error.details["detail"]["field"], "outputTokens");
        assert!(error.message.contains("must be an integer"));
    }

    #[test]
    fn replay_errors_on_token_count_missing_info() {
        let error = replay_thread(&[
            meta_line(
                "thread-missing-token",
                Some("session-missing-token"),
                "2026-07-08T10:00:00Z",
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:01:00Z".to_string(),
                item: ThreadLogItem::EventMsg(json!({
                    "type": "token_count"
                })),
            },
        ])
        .unwrap_err();

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["method"], "thread_log.replay");
        assert!(error.message.contains("missing token usage info"));
    }

    #[test]
    fn replay_errors_on_malformed_compacted_line() {
        let error = replay_thread(&[
            meta_line(
                "thread-bad-compact",
                Some("session-bad-compact"),
                "2026-07-08T10:00:00Z",
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:01:00Z".to_string(),
                item: ThreadLogItem::Compacted(json!({
                    "replacementHistory": {
                        "role": "assistant",
                        "content": "not an array"
                    }
                })),
            },
        ])
        .unwrap_err();

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["method"], "thread_log.replay");
        assert!(error.message.contains("must be an array"));
    }

    fn meta_line(thread_id: &str, session_id: Option<&str>, timestamp: &str) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            item: ThreadLogItem::ThreadMeta(ThreadMeta {
                thread_id: thread_id.to_string(),
                session_id: session_id.map(str::to_string),
                created_at: timestamp.to_string(),
                cwd: String::new(),
                source: "desktop".to_string(),
                model_provider: Some("deepseek".to_string()),
                model: Some("deepseek-v4-pro".to_string()),
                base_instructions: None,
                history_mode: Some("default".to_string()),
                forked_from_thread_id: None,
                parent_thread_id: None,
                originator: Some("Tinybot Desktop".to_string()),
            }),
        }
    }

    fn response_line(timestamp: &str, item: Value) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            item: ThreadLogItem::ResponseItem(item),
        }
    }

    fn token_count_line(timestamp: &str, last_tokens: i64, context_window: i64) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            item: ThreadLogItem::EventMsg(json!({
                "type": "token_count",
                "info": {
                    "total_token_usage": usage_value(1000 + last_tokens),
                    "last_token_usage": usage_value(last_tokens),
                    "model_context_window": context_window
                }
            })),
        }
    }

    fn usage_value(total_tokens: i64) -> Value {
        json!({
            "input_tokens": total_tokens / 2,
            "cached_input_tokens": 0,
            "output_tokens": total_tokens / 2,
            "reasoning_output_tokens": 0,
            "total_tokens": total_tokens
        })
    }
}
