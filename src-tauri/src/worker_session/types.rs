#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SessionMetadata {
    pub session_id: String,
    pub title: String,
    pub workspace_dir: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub extra: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
struct SessionStore {
    #[serde(default = "default_session_store_version")]
    version: usize,
    #[serde(default)]
    sessions: Vec<SessionMetadata>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SessionHistoryProjection {
    pub session_id: String,
    pub messages: Vec<Value>,
    pub user_profile: Value,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PersistTurnResult {
    pub session_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub saved_message_count: usize,
    pub saved_messages: Vec<Value>,
    pub checkpoint_cleared: bool,
    pub duplicate_message_count: usize,
    pub truncated_tool_result_count: usize,
    pub omitted_side_effects: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClearSessionResult {
    pub session_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub checkpoint_cleared: bool,
    pub session: SessionMetadata,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TrimSessionResult {
    pub session_id: String,
    pub messages_before: usize,
    pub messages_after: usize,
    pub session: SessionMetadata,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeleteSessionResult {
    pub session_id: String,
    pub deleted: bool,
}
