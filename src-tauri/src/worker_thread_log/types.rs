use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const THREAD_LOG_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLogLine {
    pub timestamp: String,
    #[serde(flatten)]
    pub item: ThreadLogItem,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum ThreadLogItem {
    ThreadMeta(ThreadMeta),
    EventMsg(Value),
    ResponseItem(Value),
    TurnContext(Value),
    WorldState(Value),
    Compacted(Value),
    InterAgentCommunication(Value),
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    #[serde(default)]
    pub schema_version: u32,
    pub thread_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub model_provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub base_instructions: Option<Value>,
    #[serde(default)]
    pub history_mode: Option<String>,
    #[serde(default)]
    pub forked_from_thread_id: Option<String>,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub originator: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub cached_input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub reasoning_output_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageInfo {
    pub total_token_usage: TokenUsage,
    pub last_token_usage: TokenUsage,
    #[serde(default)]
    pub model_context_window: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStateRecord {
    pub id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub thread_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub source: String,
    pub title: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub model_provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub tokens_used: i64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ThreadReplay {
    pub thread_id: String,
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
    pub messages: Vec<Value>,
    pub token_usage_info: Option<TokenUsageInfo>,
    pub context_checkpoint: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn thread_log_line_serializes_thread_meta_with_snake_type() {
        let line = ThreadLogLine {
            timestamp: "2026-07-08T10:12:30Z".to_string(),
            item: ThreadLogItem::ThreadMeta(ThreadMeta {
                schema_version: THREAD_LOG_SCHEMA_VERSION,
                thread_id: "thread-1".to_string(),
                session_id: Some("session-1".to_string()),
                created_at: "2026-07-08T10:12:30Z".to_string(),
                cwd: "D:/code/tinybot/tinybot".to_string(),
                source: "desktop".to_string(),
                model_provider: Some("deepseek".to_string()),
                model: Some("deepseek-v4-pro".to_string()),
                base_instructions: Some(json!({"text": "base"})),
                history_mode: Some("default".to_string()),
                forked_from_thread_id: None,
                parent_thread_id: None,
                originator: Some("Tinybot Desktop".to_string()),
            }),
        };

        let value = serde_json::to_value(line).unwrap();
        assert_eq!(value["type"], "thread_meta");
        assert_eq!(value["payload"]["schemaVersion"], 1);
        assert_eq!(value["payload"]["threadId"], "thread-1");
        assert_eq!(value["payload"]["sessionId"], "session-1");
    }

    #[test]
    fn legacy_thread_meta_without_schema_version_migrates_as_v0() {
        let meta: ThreadMeta = serde_json::from_value(json!({
            "threadId": "thread-legacy",
            "createdAt": "2026-07-08T10:12:30Z"
        }))
        .unwrap();

        assert_eq!(meta.schema_version, 0);
    }
}
