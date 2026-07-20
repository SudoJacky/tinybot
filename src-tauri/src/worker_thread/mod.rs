mod live_thread;
mod runtime;
mod store;
mod types;

pub use self::live_thread::LiveThread;
pub use self::runtime::ThreadRuntime;
pub(crate) use self::store::{run_summaries_from_items, runtime_events_from_thread_items};
pub use self::store::{
    MemoryThreadStore, ThreadPersistenceRepairMode, ThreadPersistenceRepairRequest, ThreadStore,
};
pub use self::types::{
    AppendThreadItemsRequest, AppendThreadItemsResult, ArchiveThreadRequest,
    ContinueThreadTurnRequest, CreateThreadRequest, DeleteThreadRequest, DeleteThreadResult,
    ForkThreadRequest, InterruptThreadRequest, ListThreadsRequest, ListThreadsResult,
    ReadThreadRequest, RestoreThreadCheckpointRequest, RestoreThreadCheckpointResult,
    ResumeThreadRequest, SearchThreadsRequest, SearchThreadsResult, StartThreadTurnRequest,
    ThreadActivityRequest, ThreadActivityResult, ThreadActivitySummary, ThreadAgentRegistryEntry,
    ThreadAgentRegistryRequest, ThreadAgentRegistryResult, ThreadApplyOpRequest, ThreadCheckpoint,
    ThreadChildActivity, ThreadChildSummary, ThreadEvent, ThreadEventsRequest, ThreadEventsResult,
    ThreadIdParams, ThreadItem, ThreadItemKind, ThreadMetadata, ThreadMetadataPatch, ThreadOp,
    ThreadPagination, ThreadPendingApproval, ThreadRecord, ThreadRunSummary, ThreadRunningTool,
    ThreadSnapshot, ThreadStatus, ThreadStatusResult, ThreadTurnRuntimeResult,
    UpdateThreadMetadataRequest,
};

use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_subagent_manager::{SubagentMailboxInput, SubagentThreadSummary};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct WorkerThreadRpc {
    store: MemoryThreadStore,
    runtime: ThreadRuntime<MemoryThreadStore>,
    policy: CapabilityPolicy,
}

impl WorkerThreadRpc {
    pub fn new(_workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        let store = MemoryThreadStore::default();
        let runtime = ThreadRuntime::new(store.clone());
        Self {
            store,
            runtime,
            policy,
        }
    }

    pub(crate) fn replace_projection(
        &self,
        threads: Vec<ThreadRecord>,
        items: std::collections::BTreeMap<String, Vec<ThreadItem>>,
    ) -> Result<(), WorkerProtocolError> {
        self.store.replace_projection(threads, items)
    }

    pub fn create_thread(
        &self,
        request: CreateThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.create_thread(request)
    }

    pub fn read_thread(
        &self,
        request: ReadThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.read_thread(request)
    }

    pub fn resume_thread(
        &self,
        request: ResumeThreadRequest,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.resume_thread(request)
    }

    pub fn get_thread_status(
        &self,
        params: ThreadIdParams,
    ) -> Result<ThreadStatusResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.get_thread_status(&params.thread_id)
    }

    pub fn list_threads(
        &self,
        request: ListThreadsRequest,
    ) -> Result<ListThreadsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.list_threads(request)
    }

    pub fn search_threads(
        &self,
        request: SearchThreadsRequest,
    ) -> Result<SearchThreadsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.search_threads(request)
    }

    pub fn update_thread_metadata(
        &self,
        request: UpdateThreadMetadataRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        let mut updated = self
            .store
            .update_thread_metadata(&request.thread_id, request.metadata)?;
        if let Some(session_key) = request.session_key {
            updated = self
                .store
                .update_thread_session_key(&request.thread_id, session_key)?;
        }
        Ok(updated)
    }

    pub fn archive_thread(
        &self,
        request: ArchiveThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.archive_thread_with_children(
            &request.thread_id,
            request.archived.unwrap_or(true),
            request.archive_children,
        )
    }

    pub fn archive_target_records(
        &self,
        thread_id: &str,
        archive_children: bool,
    ) -> Result<Vec<ThreadRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store
            .archive_target_records(thread_id, archive_children)
    }

    pub fn unarchive_thread(
        &self,
        request: ArchiveThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store
            .archive_thread_with_children(&request.thread_id, false, request.archive_children)
    }

    pub fn delete_thread(
        &self,
        request: DeleteThreadRequest,
    ) -> Result<DeleteThreadResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.delete_thread(request)
    }

    pub fn fork_thread(
        &self,
        request: ForkThreadRequest,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.fork_thread(request)
    }

    pub fn append_items(
        &self,
        request: AppendThreadItemsRequest,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.append_items_with_client_event_id(
            &request.thread_id,
            request.items,
            request.client_event_id.as_deref(),
        )
    }

    pub fn thread_events(
        &self,
        request: ThreadEventsRequest,
    ) -> Result<ThreadEventsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.thread_events(request)
    }

    pub fn restore_checkpoint(
        &self,
        request: RestoreThreadCheckpointRequest,
    ) -> Result<RestoreThreadCheckpointResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.restore_checkpoint(request)
    }

    pub fn agent_registry(
        &self,
        request: ThreadAgentRegistryRequest,
    ) -> Result<ThreadAgentRegistryResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.agent_registry(request)
    }

    pub fn activity(
        &self,
        request: ThreadActivityRequest,
    ) -> Result<ThreadActivityResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.activity(request)
    }

    pub fn start_turn(
        &self,
        request: StartThreadTurnRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.runtime.start_turn(request)
    }

    pub fn apply_op(
        &self,
        request: ThreadApplyOpRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.runtime.apply_op(request)
    }

    pub fn continue_turn(
        &self,
        request: ContinueThreadTurnRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.runtime.continue_turn(request)
    }

    pub fn interrupt(
        &self,
        request: InterruptThreadRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.runtime.interrupt(request)
    }

    pub fn record_subagent_spawn(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<Vec<AppendThreadItemsResult>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.record_subagent_spawn(summary, event)
    }

    pub fn record_subagent_input(
        &self,
        summary: &SubagentThreadSummary,
        input: &SubagentMailboxInput,
        event: Option<Value>,
    ) -> Result<Vec<AppendThreadItemsResult>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.record_subagent_input(summary, input, event)
    }

    pub fn record_subagent_status(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<Vec<AppendThreadItemsResult>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.record_subagent_status(summary, event)
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}
