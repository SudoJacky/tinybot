use super::*;
use crate::threads::rollout::store::{ThreadLogItem, ThreadLogLine, ThreadMeta};
use serde_json::json;

#[test]
fn replay_projects_messages_and_latest_token_count() {
    let replay = reconstruct_rollout(&[
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
    assert_eq!(replay.messages[0]["usage"]["cumulativeUsageTokens"], 372);
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
fn replay_projects_user_message_event_without_response_item() {
    let replay = reconstruct_rollout(&[
        meta_line(
            "thread-event-user",
            Some("session-event-user"),
            "2026-07-08T10:00:00Z",
        ),
        event_line(
            "2026-07-08T10:01:00Z",
            "user_message",
            json!({
                "message": "hello from thread",
                "messageId": "user-event-1",
            }),
        ),
    ])
    .unwrap();

    assert_eq!(replay.messages.len(), 1);
    assert_eq!(replay.messages[0]["role"], "user");
    assert_eq!(replay.messages[0]["content"], "hello from thread");
    assert_eq!(replay.messages[0]["messageId"], "user-event-1");
    assert!(replay.messages[0].get(USER_MESSAGE_EVENT_MARKER).is_none());
}

#[test]
fn replay_collapses_user_message_event_and_matching_response_item() {
    let replay = reconstruct_rollout(&[
        meta_line(
            "thread-event-response-user",
            Some("session-event-response-user"),
            "2026-07-08T10:00:00Z",
        ),
        event_line(
            "2026-07-08T10:01:00Z",
            "user_message",
            json!({
                "message": "one logical message",
                "messageId": "user-event-response-1",
            }),
        ),
        response_line(
            "2026-07-08T10:02:00Z",
            json!({
                "role": "user",
                "messageId": "user-event-response-1",
                "content": "one logical message",
                "metadata": {"source": "response_item"},
            }),
        ),
    ])
    .unwrap();

    assert_eq!(replay.messages.len(), 1);
    assert_eq!(replay.messages[0]["content"], "one logical message");
    assert_eq!(replay.messages[0]["metadata"]["source"], "response_item");
    assert_eq!(replay.messages[0]["timestamp"], "2026-07-08T10:02:00Z");
    assert!(replay.messages[0].get(USER_MESSAGE_EVENT_MARKER).is_none());
}

#[test]
fn replay_preserves_existing_frontend_fields() {
    let replay = reconstruct_rollout(&[
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
    assert_eq!(message["content"], "structured");
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
    let replay = reconstruct_rollout(&[
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
            ordinal: None,
            item: ThreadLogItem::Compacted(compacted_item(json!({
                "replacementHistory": [
                    {
                        "role": "assistant",
                        "messageId": "compact-summary",
                        "content": "Summary of earlier context",
                        "timestamp": "2026-07-08T10:02:00Z"
                    }
                ]
            }))),
        },
    ])
    .unwrap();

    assert_eq!(replay.messages.len(), 1);
    assert_eq!(replay.messages[0]["messageId"], "compact-summary");
}

#[test]
fn replay_compacted_clears_previous_token_usage() {
    let replay = reconstruct_rollout(&[
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
            ordinal: None,
            item: ThreadLogItem::EventMsg(event_msg(json!({
                "type": "token_count",
                "info": {
                    "usage": usage_value(300),
                    "modelContextWindow": 128000
                }
            }))),
        },
        ThreadLogLine {
            timestamp: "2026-07-08T10:03:00Z".to_string(),
            ordinal: None,
            item: ThreadLogItem::Compacted(compacted_item(json!({
                "replacementHistory": []
            }))),
        },
    ])
    .unwrap();

    assert!(replay.messages.is_empty());
    assert!(replay.token_usage_info.is_none());
}

#[test]
fn replay_attaches_token_count_that_arrives_after_assistant_message() {
    let replay = reconstruct_rollout(&[
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
            ordinal: None,
            item: ThreadLogItem::EventMsg(event_msg(json!({
                "type": "token_count",
                "payload": {
                    "tokenUsageInfo": {
                        "usage": usage_value(300),
                        "modelContextWindow": 128000
                    }
                }
            }))),
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
    assert_eq!(replay.messages[1]["usage"]["cumulativeUsageTokens"], 300);
}

#[test]
fn replay_errors_on_malformed_token_count() {
    let error = reconstruct_rollout(&[
        meta_line(
            "thread-bad-token",
            Some("session-bad-token"),
            "2026-07-08T10:00:00Z",
        ),
        ThreadLogLine {
            timestamp: "2026-07-08T10:01:00Z".to_string(),
            ordinal: None,
            item: ThreadLogItem::EventMsg(event_msg(json!({
                "type": "token_count",
                "info": {
                    "usage": {
                        "inputTokens": 1
                    },
                    "modelContextWindow": 128000
                }
            }))),
        },
    ])
    .unwrap_err();

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
    assert_eq!(error.details["method"], "rollout.reconstruct");
    assert!(error.message.contains("totalTokens"));
}

#[test]
fn replay_errors_on_present_non_integer_optional_token_field() {
    let error = reconstruct_rollout(&[
        meta_line(
            "thread-bad-optional-token",
            Some("session-bad-optional-token"),
            "2026-07-08T10:00:00Z",
        ),
        ThreadLogLine {
            timestamp: "2026-07-08T10:01:00Z".to_string(),
            ordinal: None,
            item: ThreadLogItem::EventMsg(event_msg(json!({
                "type": "token_count",
                "info": {
                    "usage": {
                        "inputTokens": 1,
                        "outputTokens": "162",
                        "totalTokens": 172
                    },
                    "modelContextWindow": 128000
                }
            }))),
        },
    ])
    .unwrap_err();

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
    assert_eq!(error.details["method"], "rollout.reconstruct");
    assert_eq!(error.details["detail"]["field"], "outputTokens");
    assert!(error.message.contains("must be an integer"));
}

#[test]
fn replay_errors_on_token_count_missing_info() {
    let error = reconstruct_rollout(&[
        meta_line(
            "thread-missing-token",
            Some("session-missing-token"),
            "2026-07-08T10:00:00Z",
        ),
        ThreadLogLine {
            timestamp: "2026-07-08T10:01:00Z".to_string(),
            ordinal: None,
            item: ThreadLogItem::EventMsg(event_msg(json!({
                "type": "token_count"
            }))),
        },
    ])
    .unwrap_err();

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
    assert_eq!(error.details["method"], "rollout.reconstruct");
    assert!(error.message.contains("missing token usage info"));
}

#[test]
fn replay_errors_on_malformed_compacted_line() {
    let error = CompactedItem::from_value(json!({
        "replacementHistory": {
            "role": "assistant",
            "content": "not an array"
        }
    }))
    .unwrap_err();

    assert!(error.contains("must be an array"));
}

#[test]
fn rollback_discards_compaction_from_removed_turn() {
    let replay = reconstruct_rollout(&[
        meta_line(
            "thread-rollback-compact",
            Some("session-rollback-compact"),
            "2026-07-08T10:00:00Z",
        ),
        event_line("2026-07-08T10:01:00Z", "turn_started", json!({})),
        response_line(
            "2026-07-08T10:01:01Z",
            json!({"role": "user", "content": "first"}),
        ),
        compacted_line("2026-07-08T10:01:02Z", "first summary"),
        event_line("2026-07-08T10:01:03Z", "turn_complete", json!({})),
        event_line("2026-07-08T10:02:00Z", "turn_started", json!({})),
        response_line(
            "2026-07-08T10:02:01Z",
            json!({"role": "user", "content": "second"}),
        ),
        compacted_line("2026-07-08T10:02:02Z", "removed summary"),
        event_line("2026-07-08T10:02:03Z", "turn_complete", json!({})),
        event_line(
            "2026-07-08T10:03:00Z",
            "thread_rolled_back",
            json!({"num_turns": 1}),
        ),
    ])
    .unwrap();

    assert_eq!(replay.messages.len(), 1);
    assert_eq!(replay.messages[0]["content"], "first summary");
    assert_eq!(
        replay.context_checkpoint.unwrap()["replacementHistory"][0]["content"],
        "first summary"
    );
}

#[test]
fn transcript_ignores_compaction_replacement_history() {
    let replay = reconstruct_transcript(&[
        meta_line(
            "thread-transcript",
            Some("session-transcript"),
            "2026-07-08T10:00:00Z",
        ),
        response_line(
            "2026-07-08T10:01:00Z",
            json!({"role": "user", "content": "original"}),
        ),
        compacted_line("2026-07-08T10:02:00Z", "model-only summary"),
        response_line(
            "2026-07-08T10:03:00Z",
            json!({"role": "assistant", "content": "answer"}),
        ),
    ])
    .unwrap();

    assert_eq!(replay.messages.len(), 2);
    assert_eq!(replay.messages[0]["content"], "original");
    assert_eq!(replay.messages[1]["content"], "answer");
    assert!(replay.context_checkpoint.is_none());
}

fn meta_line(thread_id: &str, session_id: Option<&str>, timestamp: &str) -> ThreadLogLine {
    ThreadLogLine {
        timestamp: timestamp.to_string(),
        ordinal: None,
        item: ThreadLogItem::SessionMeta(ThreadMeta {
            schema_version: crate::threads::rollout::store::THREAD_LOG_SCHEMA_VERSION,
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
        ordinal: None,
        item: ThreadLogItem::ResponseItem(response_item(item)),
    }
}

fn event_line(timestamp: &str, event_type: &str, payload: Value) -> ThreadLogLine {
    ThreadLogLine {
        timestamp: timestamp.to_string(),
        ordinal: None,
        item: ThreadLogItem::EventMsg(event_msg(json!({
            "type": event_type,
            "payload": payload
        }))),
    }
}

fn compacted_line(timestamp: &str, summary: &str) -> ThreadLogLine {
    ThreadLogLine {
        timestamp: timestamp.to_string(),
        ordinal: None,
        item: ThreadLogItem::Compacted(compacted_item(json!({
            "replacementHistory": [{
                "role": "assistant",
                "content": summary
            }]
        }))),
    }
}

fn token_count_line(timestamp: &str, last_tokens: i64, context_window: i64) -> ThreadLogLine {
    ThreadLogLine {
        timestamp: timestamp.to_string(),
        ordinal: None,
        item: ThreadLogItem::EventMsg(event_msg(json!({
            "type": "token_count",
            "info": {
                "usage": usage_value(last_tokens),
                "model_context_window": context_window
            }
        }))),
    }
}

fn event_msg(value: Value) -> EventMsg {
    serde_json::from_value(value).unwrap()
}

fn response_item(value: Value) -> ResponseItem {
    ResponseItem::from_value(value).unwrap()
}

fn compacted_item(value: Value) -> CompactedItem {
    CompactedItem::from_value(value).unwrap()
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
