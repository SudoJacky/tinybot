mod activity;
mod agent_run_projection;
mod checkpoint;
mod fork;
mod index;
mod memory;
mod metadata;
mod query;
mod runtime_projection;
mod subagent_projection;

use super::types::{
    AppendThreadItemsResult, CreateThreadRequest, DeleteThreadRequest, DeleteThreadResult,
    ForkThreadRequest, ListThreadsRequest, ListThreadsResult, ReadThreadRequest,
    RestoreThreadCheckpointRequest, RestoreThreadCheckpointResult, ResumeThreadRequest,
    SearchThreadsRequest, SearchThreadsResult, ThreadActivityRequest, ThreadActivityResult,
    ThreadActivitySummary, ThreadAgentRegistryRequest, ThreadAgentRegistryResult,
    ThreadChildActivity, ThreadChildSummary, ThreadEvent, ThreadEventsRequest, ThreadEventsResult,
    ThreadItem, ThreadItemKind, ThreadMetadata, ThreadMetadataPatch, ThreadPagination,
    ThreadRecord, ThreadSnapshot, ThreadStatus, ThreadStatusResult,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_subagent_manager::{
    SubagentMailboxInput, SubagentThreadStatus, SubagentThreadSummary,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use self::activity::{
    agent_registry_entry, pending_approvals_from_items, running_tools_from_items,
};
pub(crate) use self::agent_run_projection::run_summaries_from_items;
use self::checkpoint::{checkpoint_from_item, latest_checkpoint_from_items};
pub use self::memory::MemoryThreadStore;
use self::metadata::{apply_metadata_patch, recompute_dynamic_metadata};
use self::query::{
    bounded_limit, descendant_thread_ids, items_match_query as thread_items_match_query,
    parse_sequence_cursor, read_cursor_from_request, thread_matches_list_filters,
    thread_matches_query,
};
pub(crate) use self::runtime_projection::runtime_events_from_thread_items;
use self::runtime_projection::turn_items_from_thread_items;
use self::subagent_projection::{
    active_child_run_id_for_status, inherited_subagent_history_items, status_value,
    subagent_agent_control_payload, subagent_child_status_item, subagent_initial_child_items,
    subagent_input_item, subagent_lifecycle_item_label, subagent_parent_item,
    thread_status_for_subagent,
};

const DEFAULT_READ_LIMIT: usize = 200;
const DEFAULT_LIST_LIMIT: usize = 100;
const DEFAULT_SEARCH_LIMIT: usize = 25;
const MAX_READ_LIMIT: usize = 1_000;
const MAX_LIST_LIMIT: usize = 500;
const MAX_SEARCH_LIMIT: usize = 100;
const CLIENT_EVENT_IDS_KEY: &str = "clientEventIds";
pub(super) const DEFAULT_THREAD_TITLE: &str = "New session";
pub(super) const TITLE_SOURCE_KEY: &str = "titleSource";
pub(super) const TITLE_SOURCE_MANUAL: &str = "manual";

static THREAD_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static ITEM_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub trait ThreadStore: Clone + std::fmt::Debug + Send + Sync + 'static {
    fn create_thread(
        &self,
        request: CreateThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn read_thread(
        &self,
        request: ReadThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError>;
    fn resume_thread(
        &self,
        request: ResumeThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError>;
    fn get_thread_status(&self, thread_id: &str)
        -> Result<ThreadStatusResult, WorkerProtocolError>;
    fn list_threads(
        &self,
        request: ListThreadsRequest,
    ) -> Result<ListThreadsResult, WorkerProtocolError>;
    fn search_threads(
        &self,
        request: SearchThreadsRequest,
    ) -> Result<SearchThreadsResult, WorkerProtocolError>;
    fn update_thread_metadata(
        &self,
        thread_id: &str,
        patch: ThreadMetadataPatch,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn update_thread_session_key(
        &self,
        thread_id: &str,
        session_key: String,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn archive_thread(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn archive_thread_with_children(
        &self,
        thread_id: &str,
        archived: bool,
        archive_children: bool,
    ) -> Result<ThreadRecord, WorkerProtocolError>;
    fn delete_thread(
        &self,
        request: DeleteThreadRequest,
    ) -> Result<DeleteThreadResult, WorkerProtocolError>;
    fn fork_thread(&self, request: ForkThreadRequest) -> Result<ThreadRecord, WorkerProtocolError>;
    fn append_items(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError>;
    fn append_items_with_client_event_id(
        &self,
        thread_id: &str,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError>;
    fn client_event_items(
        &self,
        thread_id: &str,
        client_event_id: &str,
    ) -> Result<Option<Vec<ThreadItem>>, WorkerProtocolError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadPersistenceRepairMode {
    MigrateLegacyProjection,
    RebuildProjection,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPersistenceRepairRequest {
    pub mode: ThreadPersistenceRepairMode,
}

impl From<&ThreadRecord> for ThreadChildSummary {
    fn from(record: &ThreadRecord) -> Self {
        Self {
            thread_id: record.thread_id.clone(),
            title: record.title.clone(),
            status: record.status.clone(),
            source: record.source.clone(),
            subagent_id: record
                .metadata
                .extra
                .get("subagentId")
                .and_then(Value::as_str)
                .map(str::to_string),
            child_run_id: record
                .metadata
                .extra
                .get("childRunId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| record.root_run_id.clone()),
            preview: record.metadata.preview.clone(),
            agent_control: record.metadata.extra.get("agentControl").cloned(),
            updated_at: record.updated_at.clone(),
        }
    }
}

pub(super) fn validate_context_checkpoint_lineage(
    session_id: &str,
    existing: &[ThreadItem],
    pending: &[ThreadItem],
) -> Result<(), WorkerProtocolError> {
    let mut current_checkpoint = existing
        .iter()
        .rev()
        .find_map(thread_item_context_checkpoint);
    for item in pending {
        let Some(checkpoint) = installed_context_checkpoint(item) else {
            continue;
        };
        crate::context_checkpoint_lineage::validate_context_checkpoint_successor(
            session_id,
            current_checkpoint,
            checkpoint,
        )
        .map_err(|error| {
            invalid_thread_request(
                error.to_string(),
                serde_json::json!({
                    "contextId": checkpoint.get("contextId"),
                    "field": error.field,
                    "expected": error.expected,
                    "actual": error.actual,
                }),
            )
        })?;
        current_checkpoint = Some(checkpoint);
    }
    Ok(())
}

fn installed_context_checkpoint(item: &ThreadItem) -> Option<&Value> {
    let checkpoint = thread_item_context_checkpoint(item)?;
    (checkpoint.get("checkpointStage").and_then(Value::as_str) == Some("installed"))
        .then_some(checkpoint)
}

fn thread_item_context_checkpoint(item: &ThreadItem) -> Option<&Value> {
    let ThreadItemKind::ContextCompaction(payload) = &item.kind else {
        return None;
    };
    payload
        .get("payload")
        .and_then(|payload| payload.get("contextCheckpoint"))
        .or_else(|| payload.get("contextCheckpoint"))
        .or_else(|| payload.get("replacementHistory").map(|_| payload))
}

pub(super) fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(super) fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(super) fn bool_field(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

pub(super) fn u64_field(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn validate_thread_id(thread_id: &str) -> Result<(), WorkerProtocolError> {
    let valid = !thread_id.is_empty()
        && thread_id.len() <= 128
        && thread_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    if valid {
        return Ok(());
    }
    Err(invalid_thread_request(
        "thread id must be 1-128 ascii characters using letters, numbers, '-', '_' or '.'",
        serde_json::json!({ "threadId": thread_id }),
    ))
}

fn generate_thread_id() -> String {
    format!(
        "thread-{}-{}",
        now_millis(),
        THREAD_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn generate_item_id() -> String {
    format!(
        "item-{}-{}",
        now_millis(),
        ITEM_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn remember_client_event_items(extra: &mut Value, client_event_id: &str, items: &[ThreadItem]) {
    if !extra.is_object() {
        *extra = Value::Object(Default::default());
    }
    let Some(extra_object) = extra.as_object_mut() else {
        return;
    };
    let entry = extra_object
        .entry(CLIENT_EVENT_IDS_KEY.to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !entry.is_object() {
        *entry = Value::Object(Default::default());
    }
    if let Some(client_events) = entry.as_object_mut() {
        client_events.insert(
            client_event_id.to_string(),
            Value::Array(
                items
                    .iter()
                    .map(|item| Value::String(item.item_id.clone()))
                    .collect(),
            ),
        );
    }
}

fn now_timestamp() -> String {
    now_millis().to_string()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn unknown_thread_error(thread_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "unknown thread",
        serde_json::json!({ "threadId": thread_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn invalid_thread_request(
    message: impl Into<String>,
    details: Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
