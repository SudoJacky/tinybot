use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ROLLOUT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutLine {
    pub timestamp: String,
    #[serde(flatten)]
    pub item: RolloutItem,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum RolloutItem {
    SessionMeta(SessionMeta),
    EventMsg(Value),
    ResponseItem(Value),
    TurnContext(TurnContextItem),
    WorldState(WorldStateItem),
    Compacted(Value),
    InterAgentCommunication(Value),
    InterAgentCommunicationMetadata { trigger_turn: bool },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldStateItem {
    pub full: bool,
    pub state: Value,
}

impl WorldStateItem {
    pub fn full(state: Value) -> Self {
        Self { full: true, state }
    }

    pub fn patch(state: Value) -> Self {
        Self { full: false, state }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnContextItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_roots: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    pub approval_policy: Value,
    pub sandbox_policy: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_profile: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<Value>,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comp_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personality: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Value>,
    pub summary: Value,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
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

impl TokenUsageInfo {
    pub fn new_or_append(
        current: Option<&Self>,
        last: TokenUsage,
        model_context_window: Option<i64>,
    ) -> Self {
        let mut next = current.cloned().unwrap_or(Self {
            total_token_usage: TokenUsage::default(),
            last_token_usage: TokenUsage::default(),
            model_context_window,
        });
        next.total_token_usage.input_tokens = next
            .total_token_usage
            .input_tokens
            .saturating_add(last.input_tokens);
        next.total_token_usage.cached_input_tokens = next
            .total_token_usage
            .cached_input_tokens
            .saturating_add(last.cached_input_tokens);
        next.total_token_usage.output_tokens = next
            .total_token_usage
            .output_tokens
            .saturating_add(last.output_tokens);
        next.total_token_usage.reasoning_output_tokens = next
            .total_token_usage
            .reasoning_output_tokens
            .saturating_add(last.reasoning_output_tokens);
        next.total_token_usage.total_tokens = next
            .total_token_usage
            .total_tokens
            .saturating_add(last.total_tokens);
        next.last_token_usage = last;
        if model_context_window.is_some() {
            next.model_context_window = model_context_window;
        }
        next
    }
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
pub struct RolloutReconstruction {
    pub thread_id: String,
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
    pub messages: Vec<Value>,
    pub token_usage_info: Option<TokenUsageInfo>,
    pub context_checkpoint: Option<Value>,
    pub world_state_baseline: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rollout_line_serializes_session_meta_with_snake_type() {
        let line = RolloutLine {
            timestamp: "2026-07-08T10:12:30Z".to_string(),
            item: RolloutItem::SessionMeta(SessionMeta {
                schema_version: ROLLOUT_SCHEMA_VERSION,
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
        assert_eq!(value["type"], "session_meta");
        assert_eq!(value["payload"]["schemaVersion"], 1);
        assert_eq!(value["payload"]["threadId"], "thread-1");
        assert_eq!(value["payload"]["sessionId"], "session-1");
    }

    #[test]
    fn session_meta_requires_schema_version() {
        let error = serde_json::from_value::<SessionMeta>(json!({
            "threadId": "thread-legacy",
            "createdAt": "2026-07-08T10:12:30Z"
        }))
        .unwrap_err();

        assert!(error.to_string().contains("schemaVersion"));
    }

    #[test]
    fn world_state_item_serializes_like_codex_rollout() {
        let line = RolloutLine {
            timestamp: "2026-07-17T10:00:00Z".to_string(),
            item: RolloutItem::WorldState(WorldStateItem::patch(json!({
                "environment": { "cwd": "D:/code/tinybot" }
            }))),
        };

        let value = serde_json::to_value(line).unwrap();
        assert_eq!(value["type"], "world_state");
        assert_eq!(value["payload"]["full"], false);
        assert_eq!(
            value["payload"]["state"]["environment"]["cwd"],
            "D:/code/tinybot"
        );
    }
}
