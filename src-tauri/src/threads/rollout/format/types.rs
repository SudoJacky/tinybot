use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::ops::Deref;

pub const ROLLOUT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutLine {
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u64>,
    #[serde(flatten)]
    pub item: RolloutItem,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum RolloutItem {
    SessionMeta(SessionMeta),
    EventMsg(EventMsg),
    ResponseItem(ResponseItem),
    TurnContext(TurnContextItem),
    Compacted(CompactedItem),
    InterAgentCommunication(InterAgentCommunication),
    InterAgentCommunicationMetadata { trigger_turn: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventKind {
    TurnStarted,
    TaskStarted,
    TurnComplete,
    TaskComplete,
    TurnAborted,
    UserMessage,
    ThreadRolledBack,
    TokenCount,
    MetadataUpdated,
    SessionCleared,
    SessionTrimmed,
    ThreadItem,
    TurnCheckpointSet,
    TurnCheckpointClear,
}

impl EventKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::TurnStarted => "turn_started",
            Self::TaskStarted => "task_started",
            Self::TurnComplete => "turn_complete",
            Self::TaskComplete => "task_complete",
            Self::TurnAborted => "turn_aborted",
            Self::UserMessage => "user_message",
            Self::ThreadRolledBack => "thread_rolled_back",
            Self::TokenCount => "token_count",
            Self::MetadataUpdated => "metadata_updated",
            Self::SessionCleared => "session_cleared",
            Self::SessionTrimmed => "session_trimmed",
            Self::ThreadItem => "thread_item",
            Self::TurnCheckpointSet => "turn_checkpoint_set",
            Self::TurnCheckpointClear => "turn_checkpoint_clear",
        }
    }

    fn from_str(value: &str) -> Result<Self, String> {
        Ok(match value {
            "turn_started" => Self::TurnStarted,
            "task_started" => Self::TaskStarted,
            "turn_complete" => Self::TurnComplete,
            "task_complete" => Self::TaskComplete,
            "turn_aborted" => Self::TurnAborted,
            "user_message" => Self::UserMessage,
            "thread_rolled_back" => Self::ThreadRolledBack,
            "token_count" => Self::TokenCount,
            "metadata_updated" => Self::MetadataUpdated,
            "session_cleared" => Self::SessionCleared,
            "session_trimmed" => Self::SessionTrimmed,
            "thread_item" => Self::ThreadItem,
            "turn_checkpoint_set" => Self::TurnCheckpointSet,
            "turn_checkpoint_clear" => Self::TurnCheckpointClear,
            other => return Err(format!("unsupported event_msg type `{other}`")),
        })
    }

    pub fn starts_turn(&self) -> bool {
        match self {
            Self::TurnStarted | Self::TaskStarted => true,
            Self::TurnComplete
            | Self::TaskComplete
            | Self::TurnAborted
            | Self::UserMessage
            | Self::ThreadRolledBack
            | Self::TokenCount
            | Self::MetadataUpdated
            | Self::SessionCleared
            | Self::SessionTrimmed
            | Self::ThreadItem
            | Self::TurnCheckpointSet
            | Self::TurnCheckpointClear => false,
        }
    }

    pub fn ends_turn(&self) -> bool {
        match self {
            Self::TurnComplete | Self::TaskComplete | Self::TurnAborted => true,
            Self::TurnStarted
            | Self::TaskStarted
            | Self::UserMessage
            | Self::ThreadRolledBack
            | Self::TokenCount
            | Self::MetadataUpdated
            | Self::SessionCleared
            | Self::SessionTrimmed
            | Self::ThreadItem
            | Self::TurnCheckpointSet
            | Self::TurnCheckpointClear => false,
        }
    }

    pub fn is_turn_lifecycle(&self) -> bool {
        match self {
            Self::TurnCheckpointSet | Self::TurnCheckpointClear => true,
            Self::TurnStarted
            | Self::TaskStarted
            | Self::TurnComplete
            | Self::TaskComplete
            | Self::TurnAborted
            | Self::UserMessage
            | Self::ThreadRolledBack
            | Self::TokenCount
            | Self::MetadataUpdated
            | Self::SessionCleared
            | Self::SessionTrimmed
            | Self::ThreadItem => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventMsg {
    kind: EventKind,
    raw: Value,
}

impl EventMsg {
    pub fn new(kind: EventKind, payload: Value) -> Self {
        let raw = serde_json::json!({
            "type": kind.as_str(),
            "payload": payload,
        });
        Self { kind, raw }
    }

    pub fn kind(&self) -> &EventKind {
        &self.kind
    }

    pub fn payload(&self) -> &Value {
        self.raw.get("payload").unwrap_or(&self.raw)
    }

    pub fn as_value(&self) -> &Value {
        &self.raw
    }

    fn from_value(raw: Value) -> Result<Self, String> {
        let event_type = raw
            .as_object()
            .ok_or_else(|| "event_msg payload must be an object".to_string())?
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "event_msg payload is missing string field `type`".to_string())?;
        Ok(Self {
            kind: EventKind::from_str(event_type)?,
            raw,
        })
    }
}

impl Deref for EventMsg {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.raw
    }
}

impl Serialize for EventMsg {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.raw.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for EventMsg {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::from_value(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResponseItemKind {
    Message,
    FunctionCall,
    FunctionCallOutput,
    Reasoning,
    CustomToolCall,
    CustomToolCallOutput,
    WebSearchCall,
    LocalShellCall,
    ComputerCall,
    Other(String),
    Unspecified,
}

impl ResponseItemKind {
    fn from_value(value: &Value) -> Self {
        match value.get("type").and_then(Value::as_str) {
            Some("message") => Self::Message,
            Some("function_call") => Self::FunctionCall,
            Some("function_call_output") => Self::FunctionCallOutput,
            Some("reasoning") => Self::Reasoning,
            Some("custom_tool_call") => Self::CustomToolCall,
            Some("custom_tool_call_output") => Self::CustomToolCallOutput,
            Some("web_search_call") => Self::WebSearchCall,
            Some("local_shell_call") => Self::LocalShellCall,
            Some("computer_call") => Self::ComputerCall,
            Some(other) => Self::Other(other.to_string()),
            None if value.get("role").and_then(Value::as_str).is_some() => Self::Message,
            None => Self::Unspecified,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResponseRole {
    User,
    Assistant,
    System,
    Developer,
    Tool,
    Other(String),
}

impl ResponseRole {
    fn from_str(value: &str) -> Self {
        match value {
            "user" => Self::User,
            "assistant" => Self::Assistant,
            "system" => Self::System,
            "developer" => Self::Developer,
            "tool" => Self::Tool,
            other => Self::Other(other.to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResponseItem {
    kind: ResponseItemKind,
    role: Option<ResponseRole>,
    raw: Value,
}

impl ResponseItem {
    pub fn from_value(raw: Value) -> Result<Self, String> {
        if !raw.is_object() {
            return Err("response_item payload must be an object".to_string());
        }
        let kind = ResponseItemKind::from_value(&raw);
        let role = raw
            .get("role")
            .and_then(Value::as_str)
            .map(ResponseRole::from_str);
        validate_response_item(&kind, &raw)?;
        Ok(Self { kind, role, raw })
    }

    pub fn kind(&self) -> &ResponseItemKind {
        &self.kind
    }

    pub fn role(&self) -> Option<&ResponseRole> {
        self.role.as_ref()
    }

    pub fn is_user_message(&self) -> bool {
        matches!(self.role, Some(ResponseRole::User))
    }

    pub fn as_value(&self) -> &Value {
        &self.raw
    }
}

fn validate_response_item(kind: &ResponseItemKind, raw: &Value) -> Result<(), String> {
    match kind {
        ResponseItemKind::Message => {
            required_response_string(raw, &["role"], "message role")?;
            let content = raw
                .get("content")
                .ok_or_else(|| "message response item is missing `content`".to_string())?;
            if !content.is_string() && !content.is_array() && !content.is_null() {
                return Err("message response item `content` must be a string or array".to_string());
            }
        }
        ResponseItemKind::Reasoning => {
            required_response_string(raw, &["id"], "reasoning id")?;
            if raw.get("summary").is_none() && raw.get("content").is_none() {
                return Err("reasoning response item requires `summary` or `content`".to_string());
            }
        }
        ResponseItemKind::CustomToolCall => {
            required_response_string(raw, &["call_id", "callId"], "custom tool call id")?;
            required_response_string(raw, &["name"], "custom tool name")?;
            if raw.get("input").is_none() {
                return Err("custom tool call response item is missing `input`".to_string());
            }
        }
        ResponseItemKind::CustomToolCallOutput => {
            required_response_string(raw, &["id"], "custom tool output item id")?;
            required_response_string(raw, &["call_id"], "custom tool call output id")?;
            required_response_string(raw, &["turnId"], "custom tool output turn id")?;
            if raw.get("output").is_none() {
                return Err("custom tool output response item is missing `output`".to_string());
            }
        }
        ResponseItemKind::Unspecified => {
            return Err("response item is missing string field `type` or `role`".to_string());
        }
        ResponseItemKind::FunctionCall
        | ResponseItemKind::FunctionCallOutput
        | ResponseItemKind::WebSearchCall
        | ResponseItemKind::LocalShellCall
        | ResponseItemKind::ComputerCall
        | ResponseItemKind::Other(_) => {}
    }
    Ok(())
}

fn required_response_string(raw: &Value, keys: &[&str], description: &str) -> Result<(), String> {
    if keys.iter().any(|key| {
        raw.get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    }) {
        Ok(())
    } else {
        Err(format!("response item is missing {description}"))
    }
}

impl Deref for ResponseItem {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.raw
    }
}

impl Serialize for ResponseItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.raw.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ResponseItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::from_value(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompactedItem {
    replacement_history: Option<Vec<ResponseItem>>,
    window_number: Option<u64>,
    first_window_id: Option<String>,
    previous_window_id: Option<String>,
    window_id: Option<String>,
    raw: Value,
}

impl CompactedItem {
    pub fn from_value(raw: Value) -> Result<Self, String> {
        if !raw.is_object() {
            return Err("compacted payload must be an object".to_string());
        }
        let replacement_history = raw
            .get("replacementHistory")
            .or_else(|| raw.get("replacement_history"))
            .map(|value| {
                let values = value
                    .as_array()
                    .cloned()
                    .ok_or_else(|| "compacted replacementHistory must be an array".to_string())?;
                values
                    .into_iter()
                    .enumerate()
                    .map(|(index, value)| {
                        ResponseItem::from_value(value).map_err(|error| {
                            format!("compacted replacementHistory item {index} is invalid: {error}")
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        Ok(Self {
            replacement_history,
            window_number: optional_u64(&raw, "windowNumber", "window_number")?,
            first_window_id: optional_string(&raw, "firstWindowId", "first_window_id")?,
            previous_window_id: optional_string(&raw, "previousWindowId", "previous_window_id")?,
            window_id: optional_string(&raw, "windowId", "window_id")?,
            raw,
        })
    }

    pub fn replacement_history(&self) -> Option<&[ResponseItem]> {
        self.replacement_history.as_deref()
    }

    pub fn window_number(&self) -> Option<u64> {
        self.window_number
    }

    pub fn first_window_id(&self) -> Option<&str> {
        self.first_window_id.as_deref()
    }

    pub fn previous_window_id(&self) -> Option<&str> {
        self.previous_window_id.as_deref()
    }

    pub fn window_id(&self) -> Option<&str> {
        self.window_id.as_deref()
    }

    pub fn as_value(&self) -> &Value {
        &self.raw
    }
}

impl Deref for CompactedItem {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.raw
    }
}

impl Serialize for CompactedItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.raw.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CompactedItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::from_value(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct InterAgentCommunication {
    trigger_turn: Option<bool>,
    raw: Value,
}

impl InterAgentCommunication {
    pub fn from_value(raw: Value) -> Result<Self, String> {
        if !raw.is_object() {
            return Err("inter_agent_communication payload must be an object".to_string());
        }
        let trigger_turn = raw
            .get("triggerTurn")
            .map(|value| {
                value.as_bool().ok_or_else(|| {
                    "inter_agent_communication triggerTurn must be a boolean".to_string()
                })
            })
            .transpose()?;
        Ok(Self { trigger_turn, raw })
    }

    pub fn as_value(&self) -> &Value {
        &self.raw
    }
}

impl Deref for InterAgentCommunication {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.raw
    }
}

impl Serialize for InterAgentCommunication {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.raw.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for InterAgentCommunication {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::from_value(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

fn optional_u64(value: &Value, camel_key: &str, snake_key: &str) -> Result<Option<u64>, String> {
    let Some(value) = value.get(camel_key).or_else(|| value.get(snake_key)) else {
        return Ok(None);
    };
    value
        .as_u64()
        .map(Some)
        .ok_or_else(|| format!("compacted {camel_key} must be an unsigned integer"))
}

fn optional_string(
    value: &Value,
    camel_key: &str,
    snake_key: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value.get(camel_key).or_else(|| value.get(snake_key)) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|value| Some(value.to_string()))
        .ok_or_else(|| format!("compacted {camel_key} must be a string"))
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct TurnContextItem {
    pub turn_id: String,
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
pub struct SessionMeta {
    #[serde(skip, default = "current_rollout_schema_version")]
    pub schema_version: u32,
    #[serde(rename = "id")]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "timestamp")]
    pub created_at: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(skip, default)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_mode: Option<String>,
    #[serde(
        rename = "forked_from_id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub forked_from_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub originator: Option<String>,
}

fn current_rollout_schema_version() -> u32 {
    ROLLOUT_SCHEMA_VERSION
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
pub struct PreviousTurnSettings {
    pub model: String,
    pub provider: Option<String>,
    pub comp_hash: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompactionWindowLineage {
    pub window_number: u64,
    pub first_window_id: Option<String>,
    pub previous_window_id: Option<String>,
    pub window_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RolloutReconstruction {
    pub thread_id: String,
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
    pub messages: Vec<Value>,
    pub user_profile: Value,
    pub token_usage_info: Option<TokenUsageInfo>,
    pub context_checkpoint: Option<Value>,
    pub previous_turn_settings: Option<PreviousTurnSettings>,
    pub reference_context: Option<TurnContextItem>,
    pub compaction_window: CompactionWindowLineage,
    pub forked_from_thread_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub effective_line_indexes: Vec<usize>,
    pub(crate) compaction_overlap_candidate: Option<Value>,
}

#[cfg(test)]
#[path = "types_tests.rs"]
mod tests;
