use super::activity::{ThreadChildActivity, ThreadChildSummary};
use super::items::ThreadItem;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub thread_id: String,
    pub title: String,
    pub status: ThreadStatus,
    #[serde(default)]
    pub session_key: Option<String>,
    #[serde(default)]
    pub root_turn_id: Option<String>,
    #[serde(default)]
    pub active_turn_id: Option<String>,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub metadata: ThreadMetadata,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Empty,
    Idle,
    Running,
    WaitingForInput,
    WaitingForApproval,
    Cancelling,
    Failed,
    Archived,
}

impl Default for ThreadStatus {
    fn default() -> Self {
        Self::Empty
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub last_user_message_at: Option<String>,
    #[serde(default)]
    pub last_assistant_message_at: Option<String>,
    #[serde(default)]
    pub last_activity_at: Option<String>,
    #[serde(default)]
    pub item_count: u64,
    #[serde(default)]
    pub turn_count: u64,
    #[serde(default)]
    pub has_active_turn: bool,
    #[serde(default)]
    pub extra: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub last_user_message_at: Option<String>,
    #[serde(default)]
    pub last_assistant_message_at: Option<String>,
    #[serde(default)]
    pub last_activity_at: Option<String>,
    #[serde(default)]
    pub has_active_turn: Option<bool>,
    #[serde(default)]
    pub extra: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread: ThreadRecord,
    pub items: Vec<ThreadItem>,
    #[serde(default)]
    pub turns: Vec<ThreadTurnSummary>,
    #[serde(default)]
    pub active_turn: Option<ThreadTurnSummary>,
    #[serde(default)]
    pub latest_checkpoint: Option<ThreadCheckpoint>,
    #[serde(default)]
    pub children: Vec<ThreadChildSummary>,
    #[serde(default)]
    pub turn_items: Vec<crate::agent::runtime_protocol::AgentTurnItem>,
    #[serde(default)]
    pub child_activities: Vec<ThreadChildActivity>,
    pub pagination: ThreadPagination,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnSummary {
    pub turn_id: String,
    pub status: ThreadStatus,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    pub item_count: u64,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCheckpoint {
    pub checkpoint_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub sequence: u64,
    #[serde(default)]
    pub label: Option<String>,
    pub created_at: String,
    pub restore_payload: Value,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPagination {
    pub cursor: String,
    pub limit: usize,
    pub item_count: usize,
    #[serde(default)]
    pub previous_cursor: Option<String>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub has_more_before: bool,
    #[serde(default)]
    pub has_more_after: bool,
}
