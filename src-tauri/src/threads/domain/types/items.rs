use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItem {
    pub item_id: String,
    pub thread_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub parent_item_id: Option<String>,
    #[serde(default)]
    pub sequence: u64,
    pub created_at: String,
    pub kind: ThreadItemKind,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum ThreadItemKind {
    UserMessage(Value),
    AssistantMessageDelta(Value),
    AssistantMessageCompleted(Value),
    Reasoning(Value),
    ToolCallStarted(Value),
    ToolCallOutput(Value),
    ApprovalRequested(Value),
    ApprovalResolved(Value),
    TurnStarted(Value),
    TurnStep(Value),
    TurnCompleted(Value),
    CheckpointCreated(Value),
    ContextTrimmed(Value),
    ContextCompaction(Value),
    SubagentSpawned(Value),
    SubagentMessage(Value),
    SubagentCompleted(Value),
    SettingsChanged(Value),
    Error(Value),
    Cancelled(Value),
    Event(Value),
}
