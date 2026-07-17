use super::{ThreadReplay, ThreadStateRecord, TokenUsageInfo};
use crate::worker_session::{SessionHistoryProjection, SessionMetadata};
use serde_json::{json, Value};

pub fn metadata_from_state(record: ThreadStateRecord) -> SessionMetadata {
    SessionMetadata {
        session_id: record.session_id.unwrap_or_else(|| record.id.clone()),
        title: record.title,
        workspace_dir: record.cwd,
        created_at: record.created_at,
        updated_at: record.updated_at,
        extra: json!({
            "threadId": record.id,
            "threadPath": record.thread_path,
            "threadSource": "thread_log",
            "source": "thread.metadata_projection",
            "preview": record.preview,
            "model": record.model,
            "provider": record.model_provider,
            "tokensUsed": record.tokens_used
        }),
    }
}

pub fn history_from_replay(replay: ThreadReplay, limit: usize) -> SessionHistoryProjection {
    let mut messages = replay.messages;
    if limit == 0 {
        messages.clear();
    } else if messages.len() > limit {
        let start = messages.len() - limit;
        messages = messages.split_off(start);
    }
    attach_usage(&mut messages, replay.token_usage_info.as_ref());
    SessionHistoryProjection {
        session_id: replay.session_id,
        messages,
        user_profile: if replay.user_profile.is_null() {
            json!({})
        } else {
            replay.user_profile
        },
        updated_at: replay.updated_at,
        context_checkpoint: replay.context_checkpoint,
    }
}

fn attach_usage(messages: &mut [Value], token_usage_info: Option<&TokenUsageInfo>) {
    if messages.is_empty() {
        return;
    }
    let Some(token_usage_info) = token_usage_info else {
        return;
    };
    let target_index = messages
        .iter()
        .rev()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .map(|reverse_index| messages.len() - 1 - reverse_index)
        .unwrap_or_else(|| messages.len() - 1);
    let target = &mut messages[target_index];
    if target.get("tokenUsageInfo").is_none() {
        target["tokenUsageInfo"] = serde_json::to_value(token_usage_info)
            .expect("TokenUsageInfo serialization should not fail");
    }
    if target.get("usage").is_none() {
        target["usage"] = usage_from_token_usage_info(token_usage_info);
    }
}

fn usage_from_token_usage_info(info: &TokenUsageInfo) -> Value {
    let used_tokens = info.last_token_usage.total_tokens;
    let context_window = info.model_context_window;
    let remaining_tokens = context_window.map(|window| window.saturating_sub(used_tokens).max(0));
    let percent = context_window
        .filter(|window| *window > 0)
        .map(|window| ((used_tokens as f64 / window as f64) * 100.0).clamp(0.0, 100.0));
    json!({
        "cachedTokens": info.last_token_usage.cached_input_tokens,
        "completionTokens": info.last_token_usage.output_tokens,
        "contextWindowRemainingTokens": remaining_tokens,
        "contextWindowTokens": context_window,
        "contextWindowUsedTokens": used_tokens,
        "estimatedContextTokens": used_tokens,
        "promptTokens": info.last_token_usage.input_tokens,
        "reasoningOutputTokens": info.last_token_usage.reasoning_output_tokens,
        "totalTokens": used_tokens,
        "cumulativeUsageTokens": info.total_token_usage.total_tokens,
        "percent": percent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_thread_log::{TokenUsage, TokenUsageInfo};
    use serde_json::json;

    #[test]
    fn metadata_from_state_projects_existing_session_metadata_shape() {
        let metadata = metadata_from_state(ThreadStateRecord {
            id: "thread-1".to_string(),
            session_id: Some("session-1".to_string()),
            thread_path: "D:/code/tinybot/.tinybot/threads/thread-1.jsonl".to_string(),
            created_at: "2026-07-08T10:00:00Z".to_string(),
            updated_at: "2026-07-08T10:03:00Z".to_string(),
            source: "desktop".to_string(),
            title: "Projected title".to_string(),
            preview: "Projected preview".to_string(),
            cwd: "D:/code/tinybot/tinybot".to_string(),
            model_provider: Some("deepseek".to_string()),
            model: Some("deepseek-v4-pro".to_string()),
            tokens_used: 172,
            archived: false,
            archived_at: None,
        });

        assert_eq!(metadata.session_id, "session-1");
        assert_eq!(metadata.title, "Projected title");
        assert_eq!(metadata.workspace_dir, "D:/code/tinybot/tinybot");
        assert_eq!(metadata.created_at, "2026-07-08T10:00:00Z");
        assert_eq!(metadata.updated_at, "2026-07-08T10:03:00Z");
        assert_eq!(metadata.extra["threadId"], "thread-1");
        assert_eq!(
            metadata.extra["threadPath"],
            "D:/code/tinybot/.tinybot/threads/thread-1.jsonl"
        );
        assert_eq!(metadata.extra["threadSource"], "thread_log");
        assert_eq!(metadata.extra["preview"], "Projected preview");
        assert_eq!(metadata.extra["model"], "deepseek-v4-pro");
        assert_eq!(metadata.extra["provider"], "deepseek");
        assert_eq!(metadata.extra["tokensUsed"], 172);
    }

    #[test]
    fn history_from_replay_applies_limit_from_end() {
        let projection = history_from_replay(
            replay(vec![
                json!({"role": "user", "content": "one", "messageId": "m1"}),
                json!({"role": "assistant", "content": "two", "messageId": "m2"}),
                json!({"role": "user", "content": "three", "messageId": "m3"}),
            ]),
            2,
        );

        assert_eq!(projection.session_id, "session-1");
        assert_eq!(projection.messages.len(), 2);
        assert_eq!(projection.messages[0]["messageId"], "m2");
        assert_eq!(projection.messages[1]["messageId"], "m3");
        assert_eq!(projection.user_profile, json!({}));
        assert_eq!(projection.updated_at, "2026-07-08T10:03:00Z");
    }

    #[test]
    fn history_from_replay_attaches_usage_to_last_assistant_message() {
        let projection = history_from_replay(
            replay_with_usage(vec![
                json!({"role": "user", "content": "hello"}),
                json!({"role": "assistant", "content": "hi"}),
                json!({"role": "user", "content": "thanks"}),
            ]),
            80,
        );

        assert_eq!(projection.messages[0].get("usage"), None);
        assert_eq!(
            projection.messages[1]["usage"]["contextWindowUsedTokens"],
            172
        );
        assert_eq!(
            projection.messages[1]["usage"]["contextWindowTokens"],
            128000
        );
        assert_eq!(
            projection.messages[1]["usage"]["cumulativeUsageTokens"],
            1172
        );
        assert_eq!(
            projection.messages[1]["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            172
        );
        assert_eq!(projection.messages[2].get("usage"), None);
    }

    #[test]
    fn history_from_replay_attaches_usage_to_last_message_without_assistant() {
        let projection = history_from_replay(
            replay_with_usage(vec![
                json!({"role": "user", "content": "hello"}),
                json!({"role": "tool", "content": "lookup"}),
            ]),
            80,
        );

        assert_eq!(projection.messages[0].get("usage"), None);
        assert_eq!(
            projection.messages[1]["usage"]["contextWindowUsedTokens"],
            172
        );
        assert_eq!(
            projection.messages[1]["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            172
        );
    }

    #[test]
    fn history_from_replay_preserves_existing_usage_fields() {
        let projection = history_from_replay(
            replay_with_usage(vec![
                json!({"role": "user", "content": "hello"}),
                json!({
                    "role": "assistant",
                    "content": "hi",
                    "usage": {"contextWindowUsedTokens": 9},
                    "tokenUsageInfo": {"lastTokenUsage": {"totalTokens": 9}}
                }),
            ]),
            80,
        );

        assert_eq!(
            projection.messages[1]["usage"]["contextWindowUsedTokens"],
            9
        );
        assert_eq!(
            projection.messages[1]["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            9
        );
    }

    fn replay(messages: Vec<serde_json::Value>) -> ThreadReplay {
        ThreadReplay {
            thread_id: "thread-1".to_string(),
            session_id: "session-1".to_string(),
            title: "New session".to_string(),
            updated_at: "2026-07-08T10:03:00Z".to_string(),
            messages,
            user_profile: serde_json::json!({}),
            token_usage_info: None,
            context_checkpoint: None,
            world_state_baseline: None,
            compaction_overlap_candidate: None,
        }
    }

    fn replay_with_usage(messages: Vec<serde_json::Value>) -> ThreadReplay {
        ThreadReplay {
            token_usage_info: Some(TokenUsageInfo {
                total_token_usage: usage(1172),
                last_token_usage: usage(172),
                model_context_window: Some(128000),
            }),
            ..replay(messages)
        }
    }

    fn usage(total_tokens: i64) -> TokenUsage {
        TokenUsage {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: total_tokens - 10,
            reasoning_output_tokens: 3,
            total_tokens,
        }
    }
}
