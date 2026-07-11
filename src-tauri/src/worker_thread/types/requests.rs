use super::activity::{ThreadChildActivity, ThreadChildSummary};
use super::events::ThreadEvent;
use super::items::ThreadItem;
use super::records::{
    ThreadCheckpoint, ThreadMetadataPatch, ThreadRecord, ThreadRunSummary, ThreadSnapshot,
};
use crate::agent_loop_runtime_protocol::AgentTraceContext;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub session_key: Option<String>,
    #[serde(default)]
    pub root_run_id: Option<String>,
    #[serde(default)]
    pub active_run_id: Option<String>,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub metadata: ThreadMetadataPatch,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreThreadCheckpointRequest {
    pub thread_id: String,
    #[serde(default)]
    pub checkpoint_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreThreadCheckpointResult {
    pub thread_id: String,
    pub checkpoint: ThreadCheckpoint,
    pub restore_payload: Value,
    pub snapshot: ThreadSnapshot,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadThreadRequest {
    pub thread_id: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub before_sequence: Option<u64>,
    #[serde(default)]
    pub checkpoint_sequence: Option<u64>,
    #[serde(default)]
    pub checkpoint_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsRequest {
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub include_child_threads: bool,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub ancestor_thread_id: Option<String>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsResult {
    pub threads: Vec<ThreadRecord>,
    pub total: usize,
    #[serde(default)]
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchThreadsRequest {
    pub query: String,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub include_child_threads: bool,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub ancestor_thread_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchThreadsResult {
    pub query: String,
    pub threads: Vec<ThreadRecord>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveThreadRequest {
    pub thread_id: String,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default, alias = "unarchiveChildren")]
    pub archive_children: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkThreadRequest {
    pub thread_id: String,
    #[serde(default)]
    pub client_event_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub fork_after_sequence: Option<u64>,
    #[serde(default)]
    pub include_children: bool,
    #[serde(default)]
    pub include_checkpoints: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThreadMetadataRequest {
    pub thread_id: String,
    #[serde(default)]
    pub session_key: Option<String>,
    pub metadata: ThreadMetadataPatch,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendThreadItemsRequest {
    pub thread_id: String,
    #[serde(default)]
    pub client_event_id: Option<String>,
    pub items: Vec<ThreadItem>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendThreadItemsResult {
    pub thread: ThreadRecord,
    pub items: Vec<ThreadItem>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventsRequest {
    pub thread_id: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub after_sequence: Option<u64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventsResult {
    pub thread_id: String,
    pub thread: ThreadRecord,
    #[serde(default)]
    pub active_run: Option<ThreadRunSummary>,
    #[serde(default)]
    pub latest_checkpoint: Option<ThreadCheckpoint>,
    #[serde(default)]
    pub runs: Vec<ThreadRunSummary>,
    #[serde(default)]
    pub child_activities: Vec<ThreadChildActivity>,
    pub cursor: String,
    #[serde(default)]
    pub events: Vec<ThreadEvent>,
    pub items: Vec<ThreadItem>,
    pub next_cursor: String,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadApplyOpRequest {
    pub thread_id: String,
    #[serde(default)]
    pub client_event_id: Option<String>,
    pub op: ThreadOp,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ThreadOp {
    UserInput {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        metadata: ThreadMetadataPatch,
    },
    ContinueRun {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        input: Value,
    },
    Interrupt {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    },
    ApprovalRequest {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        approval_id: Option<String>,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        scope: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    ApprovalDecision {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        approval_id: Option<String>,
        #[serde(default)]
        approved: bool,
        #[serde(default)]
        scope: Option<String>,
        #[serde(default)]
        guidance: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    ToolCallStarted {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        tool_call_id: Option<String>,
        #[serde(default)]
        tool_name: Option<String>,
        #[serde(default)]
        args: Value,
    },
    ToolResult {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        tool_call_id: Option<String>,
        #[serde(default)]
        tool_name: Option<String>,
        #[serde(default)]
        output: Value,
        #[serde(default)]
        error: Option<Value>,
    },
    SubagentSpawned {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        subagent_id: Option<String>,
        #[serde(default)]
        child_thread_id: Option<String>,
        #[serde(default)]
        child_run_id: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        task: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    SubagentMessage {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        subagent_id: Option<String>,
        #[serde(default)]
        child_thread_id: Option<String>,
        #[serde(default)]
        child_run_id: Option<String>,
        #[serde(default)]
        content: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    SubagentCompleted {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        subagent_id: Option<String>,
        #[serde(default)]
        child_thread_id: Option<String>,
        #[serde(default)]
        child_run_id: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        result: Value,
    },
    Checkpoint {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        checkpoint_id: Option<String>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        restore_payload: Value,
    },
    AssistantDelta {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        delta: Option<String>,
        #[serde(default)]
        message: Value,
    },
    Reasoning {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    AgentStep {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        step_id: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    RuntimeEvent {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        event_name: String,
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        visibility: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    AssistantResponse {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        content: Option<String>,
        #[serde(default)]
        message: Value,
        #[serde(default)]
        stop_reason: Option<String>,
        #[serde(default)]
        usage: Option<Value>,
        #[serde(default)]
        instruction_provenance: Option<Value>,
        #[serde(default)]
        instruction_diagnostics: Vec<Value>,
    },
    Error {
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        details: Value,
    },
    UpdateSettings {
        #[serde(default)]
        metadata: ThreadMetadataPatch,
        #[serde(default)]
        reason: Option<String>,
    },
    Archive {
        #[serde(default)]
        archive_children: bool,
    },
    Unarchive {
        #[serde(default)]
        unarchive_children: bool,
    },
    Fork {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        fork_after_sequence: Option<u64>,
        #[serde(default)]
        include_children: bool,
        #[serde(default)]
        include_checkpoints: bool,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartThreadTurnRequest {
    pub thread_id: String,
    #[serde(default)]
    pub client_event_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub metadata: ThreadMetadataPatch,
    #[serde(default)]
    pub trace_context: Option<AgentTraceContext>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueThreadTurnRequest {
    pub thread_id: String,
    #[serde(default)]
    pub client_event_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub input: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptThreadRequest {
    pub thread_id: String,
    #[serde(default)]
    pub client_event_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnRuntimeResult {
    pub snapshot: ThreadSnapshot,
    #[serde(default)]
    pub run: Option<ThreadRunSummary>,
    pub appended_items: Vec<ThreadItem>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdParams {
    pub thread_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeThreadRequest {
    pub thread_id: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub checkpoint_sequence: Option<u64>,
    #[serde(default)]
    pub checkpoint_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteThreadRequest {
    pub thread_id: String,
    #[serde(default)]
    pub delete_children: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteThreadResult {
    pub thread_id: String,
    pub deleted: bool,
    #[serde(default)]
    pub deleted_children: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatusResult {
    pub thread: ThreadRecord,
    #[serde(default)]
    pub active_run: Option<ThreadRunSummary>,
    #[serde(default)]
    pub latest_checkpoint: Option<ThreadCheckpoint>,
    #[serde(default)]
    pub runs: Vec<ThreadRunSummary>,
    #[serde(default)]
    pub children: Vec<ThreadChildSummary>,
    #[serde(default)]
    pub turn_items: Vec<crate::agent_loop_runtime_protocol::AgentTurnItem>,
    #[serde(default)]
    pub child_activities: Vec<ThreadChildActivity>,
}
