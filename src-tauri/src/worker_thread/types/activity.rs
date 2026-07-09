use super::records::{ThreadCheckpoint, ThreadRecord, ThreadRunSummary, ThreadStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadChildSummary {
    pub thread_id: String,
    pub title: String,
    pub status: ThreadStatus,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub subagent_id: Option<String>,
    #[serde(default)]
    pub child_run_id: Option<String>,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_control: Option<Value>,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadChildActivity {
    pub child: ThreadChildSummary,
    #[serde(default)]
    pub active_run: Option<ThreadRunSummary>,
    #[serde(default)]
    pub turn_items: Vec<crate::agent_loop_runtime_protocol::AgentTurnItem>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadAgentRegistryRequest {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default = "default_true")]
    pub include_child_threads: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadAgentRegistryResult {
    #[serde(default)]
    pub root_thread_id: Option<String>,
    pub agents: Vec<ThreadAgentRegistryEntry>,
    pub total: usize,
    pub active_count: usize,
    pub waiting_for_approval_count: usize,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadAgentRegistryEntry {
    pub agent_id: String,
    pub thread_id: String,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    pub title: String,
    pub role: String,
    pub nickname: String,
    pub status: ThreadStatus,
    pub active: bool,
    pub terminal: bool,
    pub source: String,
    pub depth: u64,
    pub agent_path: Value,
    pub child_count: u64,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mailbox_depth: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approval: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacity: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_control: Option<Value>,
    #[serde(default)]
    pub active_run: Option<ThreadRunSummary>,
    #[serde(default)]
    pub latest_checkpoint: Option<ThreadCheckpoint>,
    #[serde(default)]
    pub turn_items: Vec<crate::agent_loop_runtime_protocol::AgentTurnItem>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActivityRequest {
    pub thread_id: String,
    #[serde(default = "default_true")]
    pub include_child_threads: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActivityResult {
    pub thread_id: String,
    pub thread: ThreadRecord,
    #[serde(default)]
    pub active_run: Option<ThreadRunSummary>,
    #[serde(default)]
    pub active_children: Vec<ThreadChildActivity>,
    #[serde(default)]
    pub pending_approvals: Vec<ThreadPendingApproval>,
    #[serde(default)]
    pub running_tools: Vec<ThreadRunningTool>,
    #[serde(default)]
    pub checkpoints: Vec<ThreadCheckpoint>,
    pub agents: ThreadAgentRegistryResult,
    pub summary: ThreadActivitySummary,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActivitySummary {
    pub active_children: usize,
    pub pending_approvals: usize,
    pub running_tools: usize,
    pub checkpoints: usize,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPendingApproval {
    pub thread_id: String,
    pub item_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    pub approval_id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    pub created_at: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRunningTool {
    pub thread_id: String,
    pub item_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    pub tool_call_id: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub args: Value,
    pub started_at: String,
    pub payload: Value,
}

fn default_true() -> bool {
    true
}
