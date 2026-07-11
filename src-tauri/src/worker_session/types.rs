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

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunKey {
    pub session_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub session_id: String,
    pub run_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub child_thread_ids: Vec<String>,
    pub status: AgentRunStatus,
    pub phase: String,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub stop_reason: Option<String>,
    pub model: String,
    pub provider: Option<String>,
    pub max_iterations: i64,
    pub current_iteration: i64,
    #[serde(default)]
    pub conversation_message_ids: Vec<String>,
    #[serde(default)]
    pub trace_messages: Vec<Value>,
    #[serde(default)]
    pub trace_events: Vec<Value>,
    #[serde(default)]
    pub completed_tool_results: Vec<Value>,
    #[serde(default)]
    pub pending_tool_calls: Vec<Value>,
    pub checkpoint: Option<Value>,
    #[serde(default)]
    pub artifacts: Vec<Value>,
    #[serde(default)]
    pub usage: Vec<Value>,
    #[serde(default)]
    pub token_usage_info: Option<TokenUsageInfo>,
    pub error: Option<Value>,
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSummary {
    pub session_id: String,
    pub run_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub child_thread_ids: Vec<String>,
    pub status: AgentRunStatus,
    pub phase: String,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub stop_reason: Option<String>,
    pub model: String,
    pub provider: Option<String>,
    pub tools_used: Vec<String>,
    pub tool_call_count: usize,
    pub has_checkpoint: bool,
    pub final_content_preview: Option<String>,
    pub artifact_count: usize,
}

impl AgentRunSummary {
    pub fn from_record(record: &AgentRunRecord) -> Self {
        let tools_used = record
            .completed_tool_results
            .iter()
            .filter_map(|result| {
                result
                    .get("toolName")
                    .or_else(|| result.get("tool_name"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();
        Self {
            session_id: record.session_id.clone(),
            run_id: record.run_id.clone(),
            thread_id: record.thread_id.clone(),
            turn_id: record.turn_id.clone(),
            parent_thread_id: record.parent_thread_id.clone(),
            child_thread_ids: record.child_thread_ids.clone(),
            status: record.status.clone(),
            phase: record.phase.clone(),
            started_at: record.started_at.clone(),
            updated_at: record.updated_at.clone(),
            completed_at: record.completed_at.clone(),
            stop_reason: record.stop_reason.clone(),
            model: record.model.clone(),
            provider: record.provider.clone(),
            tool_call_count: record.completed_tool_results.len(),
            has_checkpoint: record.checkpoint.is_some(),
            final_content_preview: final_content_preview(record),
            artifact_count: record.artifacts.len(),
            tools_used,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunCheckpoint {
    pub session_id: String,
    pub run_id: String,
    pub checkpoint: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunTracePage {
    pub session_id: String,
    pub run_id: String,
    pub items: Vec<Value>,
    pub next_cursor: Option<String>,
}

impl AgentRunTracePage {
    pub fn new(session_id: &str, run_id: &str, items: Vec<Value>) -> Self {
        Self {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            items,
            next_cursor: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRuntimeState {
    pub session_id: String,
    pub run_id: String,
    pub runtime_events: Vec<crate::agent_loop_runtime_protocol::AgentRuntimeEventEnvelope>,
    pub turn_items: Vec<crate::agent_loop_runtime_protocol::AgentTurnItem>,
}

fn final_content_preview(record: &AgentRunRecord) -> Option<String> {
    record.trace_messages.iter().rev().find_map(|message| {
        let role = message.get("role").and_then(Value::as_str)?;
        if role != "assistant" {
            return None;
        }
        let content = message.get("content").and_then(Value::as_str)?.trim();
        if content.is_empty() {
            None
        } else {
            Some(content.chars().take(160).collect())
        }
    })
}
