use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const AGENT_RUNTIME_EVENT_SCHEMA_VERSION: &str = "tinybot.agent_event.v1";
pub const AGENT_TURN_ITEM_SCHEMA_VERSION: &str = "tinybot.turn_item.v2";
pub const AGENT_TIMELINE_SCHEMA_VERSION: &str = "tinybot.timeline.v2";
pub const AGENT_TIMELINE_PATCH_SCHEMA_VERSION: &str = "tinybot.timeline_patch.v2";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceContext {
    pub request_id: String,
    pub trace_id: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_turn_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimePhase {
    Queued,
    HydratingHistory,
    Planning,
    CallingModel,
    StreamingModel,
    ToolCalling,
    ToolRunning,
    AwaitingForm,
    AwaitingSubagent,
    Paused,
    Finalizing,
    Completed,
    Failed,
    Cancelling,
    Cancelled,
}

impl AgentRuntimePhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::HydratingHistory => "hydrating_history",
            Self::Planning => "planning",
            Self::CallingModel => "calling_model",
            Self::StreamingModel => "streaming_model",
            Self::ToolCalling => "tool_calling",
            Self::ToolRunning => "tool_running",
            Self::AwaitingForm => "awaiting_form",
            Self::AwaitingSubagent => "awaiting_subagent",
            Self::Paused => "paused",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnItemKind {
    UserMessage,
    AssistantMessage,
    Reasoning,
    ToolCall,
    #[serde(alias = "form_request")]
    Form,
    #[serde(alias = "subagent_activity")]
    SubagentLifecycle,
    SubagentMessage,
    PlanProgress,
    ContextCompaction,
    Usage,
    FileReference,
    Error,
    SystemNotice,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnItemStatus {
    Queued,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAssistantMessagePhase {
    Unknown,
    Commentary,
    FinalAnswer,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeEventSource {
    RustBackend,
    Provider,
    Tool,
    Subagent,
    User,
    System,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeEventVisibility {
    User,
    Debug,
    Hidden,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFormAction {
    Submit,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentContinuationInput {
    Form {
        #[serde(rename = "formId")]
        form_id: String,
        action: AgentFormAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        values: Option<Value>,
    },
    QueuedUserMessage {
        #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        content: String,
    },
    Guidance {
        #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        content: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeEventEnvelope {
    pub schema_version: String,
    pub event_id: String,
    pub sequence: u64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub event_name: String,
    pub phase: AgentRuntimePhase,
    pub timestamp: String,
    pub source: AgentRuntimeEventSource,
    pub visibility: AgentRuntimeEventVisibility,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_context: Option<AgentTraceContext>,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentTurnItemData {
    UserMessage {
        message_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_event_id: Option<String>,
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        references: Vec<Value>,
    },
    AssistantMessage {
        message_id: Option<String>,
        model_call_id: String,
        phase: AgentAssistantMessagePhase,
        content: String,
    },
    Reasoning {
        model_call_id: String,
        summary: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        status: String,
        args: Value,
        result: Value,
        detail_id: Option<String>,
        timing: Value,
    },
    Form {
        form_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        status: String,
        title: Option<String>,
        action: Option<String>,
        field_ids: Vec<String>,
        values: Value,
        errors: Value,
        detail_id: Option<String>,
    },
    SubagentLifecycle {
        agent_id: String,
        action: String,
        status: String,
        message: Option<String>,
        child_turn_id: Option<String>,
        child_thread_id: Option<String>,
        parent_agent_id: Option<String>,
        parent_turn_id: Option<String>,
        name: Option<String>,
        task: Option<String>,
        trace_ref: Option<String>,
    },
    SubagentMessage {
        agent_id: String,
        message_id: String,
        content: String,
        visibility: String,
    },
    PlanProgress {
        id: String,
        explanation: Option<String>,
        steps: Vec<crate::agent::runtime::AgentPlanStep>,
        summary: String,
        completed: u32,
        total: u32,
        current_step: Option<String>,
    },
    ContextCompaction {
        id: String,
        summary: String,
        dropped_item_count: usize,
        context_window_tokens: Option<u64>,
        strategy: Option<String>,
        estimated_tokens_before: Option<u64>,
        estimated_tokens_after: Option<u64>,
    },
    Usage {
        id: Option<String>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        total_tokens: Option<i64>,
        provider_payload: Value,
    },
    FileReference {
        id: String,
        path: String,
        mime_type: Option<String>,
        reference_kind: String,
    },
    Error {
        id: Option<String>,
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        cancelled: bool,
    },
    SystemNotice {
        message: String,
        detail: Value,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnItem {
    pub schema_version: String,
    pub item_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_item_id: Option<String>,
    pub sequence: u64,
    pub revision: u64,
    pub kind: AgentTurnItemKind,
    pub status: AgentTurnItemStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub data: AgentTurnItemData,
    #[serde(skip)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTimelineSnapshot {
    pub schema_version: String,
    pub session_id: String,
    pub turn_id: String,
    pub snapshot_revision: u64,
    pub items: Vec<AgentTurnItem>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTimelinePatch {
    pub schema_version: String,
    pub session_id: String,
    pub turn_id: String,
    pub snapshot_revision: u64,
    pub item: AgentTurnItem,
}
