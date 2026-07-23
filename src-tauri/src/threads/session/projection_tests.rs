use super::*;
use crate::threads::rollout::format::{TokenUsage, TokenUsageInfo};
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
        compaction_overlap_candidate: None,
        ..Default::default()
    }
}

#[test]
fn session_history_hides_model_only_tool_pairs_and_progress() {
    let projection = session_history_from_replay(
        replay(vec![
            json!({"role": "user", "content": "inspect"}),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call-1", "name": "read_file"}]
            }),
            json!({"role": "tool", "content": "contents", "tool_call_id": "call-1"}),
            json!({
                "role": "progress",
                "content": "working",
                "_progress": true
            }),
            json!({"role": "assistant", "content": "done"}),
        ]),
        80,
    );

    assert_eq!(
        projection
            .messages
            .iter()
            .map(|message| message["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["inspect", "done"]
    );
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
