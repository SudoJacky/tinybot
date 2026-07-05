mod live_thread;
mod local_store;
mod runtime;
mod session_adapter;
mod types;

pub use self::live_thread::LiveThread;
pub use self::local_store::{LocalThreadStore, ThreadStore};
pub use self::runtime::ThreadRuntime;
pub use self::types::{
    AppendThreadItemsRequest, AppendThreadItemsResult, ArchiveThreadRequest,
    ContinueThreadTurnRequest, CreateThreadRequest, DeleteThreadRequest, DeleteThreadResult,
    ForkThreadRequest, InterruptThreadRequest, ListThreadsRequest, ListThreadsResult,
    ReadThreadRequest, RestoreThreadCheckpointRequest, RestoreThreadCheckpointResult,
    ResumeThreadRequest, SearchThreadsRequest, SearchThreadsResult, StartThreadTurnRequest,
    ThreadActivityRequest, ThreadActivityResult, ThreadActivitySummary, ThreadAgentRegistryEntry,
    ThreadAgentRegistryRequest, ThreadAgentRegistryResult, ThreadApplyOpRequest,
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
use crate::worker_session::{
    AgentRunRecord, AgentRunRuntimeState, AgentRunTracePage, SessionHistoryProjection,
    SessionMetadata,
};
use crate::worker_subagent_manager::{SubagentMailboxInput, SubagentThreadSummary};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct WorkerThreadRpc {
    store: LocalThreadStore,
    runtime: ThreadRuntime,
    policy: CapabilityPolicy,
}

impl WorkerThreadRpc {
    pub fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        let store = LocalThreadStore::new(workspace_root);
        let runtime = ThreadRuntime::new(store.clone());
        Self {
            store,
            runtime,
            policy,
        }
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

    pub fn read_thread_with_legacy_sessions(
        &self,
        request: ReadThreadRequest,
        sessions: &[SessionMetadata],
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        session_adapter::read_thread_with_legacy_sessions(&self.store, request, sessions)
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

    pub fn list_threads_with_legacy_sessions(
        &self,
        request: ListThreadsRequest,
        sessions: &[SessionMetadata],
    ) -> Result<ListThreadsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        session_adapter::list_threads_with_legacy_sessions(&self.store, request, sessions)
    }

    pub fn list_session_metadata_with_threads(
        &self,
        sessions: &[SessionMetadata],
    ) -> Result<Vec<SessionMetadata>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        session_adapter::list_session_metadata_with_threads(&self.store, sessions)
    }

    pub fn get_session_metadata_from_threads(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionMetadata>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        session_adapter::get_session_metadata_from_threads(&self.store, session_id)
    }

    pub fn get_session_history_from_threads(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Option<SessionHistoryProjection>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        session_adapter::get_session_history_from_threads(&self.store, session_id, limit)
    }

    pub fn search_threads(
        &self,
        request: SearchThreadsRequest,
    ) -> Result<SearchThreadsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.search_threads(request)
    }

    pub fn search_threads_with_legacy_sessions(
        &self,
        request: SearchThreadsRequest,
        sessions: &[SessionMetadata],
    ) -> Result<SearchThreadsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        session_adapter::search_threads_with_legacy_sessions(&self.store, request, sessions)
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

    pub fn unarchive_thread(
        &self,
        params: ThreadIdParams,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.archive_thread(&params.thread_id, false)
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

    pub fn record_agent_run(
        &self,
        record: &AgentRunRecord,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.record_agent_run(record)
    }

    pub fn record_session_turn(
        &self,
        session_id: &str,
        run_id: &str,
        messages: &[Value],
    ) -> Result<Option<AppendThreadItemsResult>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        session_adapter::record_session_turn(&self.store, session_id, run_id, messages)
    }

    pub fn project_session_history_if_writable(
        &self,
        session_id: &str,
        messages: &[Value],
    ) -> Result<Option<AppendThreadItemsResult>, WorkerProtocolError> {
        if !self.policy.allows(&WorkerCapability::SessionWrite) {
            return Ok(None);
        }
        session_adapter::project_session_history_if_empty(&self.store, session_id, messages)
    }

    pub fn sync_session_metadata(
        &self,
        session: &SessionMetadata,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        session_adapter::sync_session_metadata(&self.store, session)
    }

    pub fn archive_session_thread(
        &self,
        session_id: &str,
    ) -> Result<Option<ThreadRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        session_adapter::archive_session_thread(&self.store, session_id)
    }

    pub fn record_agent_run_trace(
        &self,
        record: &AgentRunRecord,
        event: Value,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.record_agent_run_trace(record, event)
    }

    pub fn list_agent_run_trace_events(
        &self,
        session_id: &str,
        run_id: &str,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Option<AgentRunTracePage>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store
            .list_agent_run_trace_events(session_id, run_id, cursor, limit)
    }

    pub fn get_agent_run_runtime_state(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRuntimeState>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.get_agent_run_runtime_state(session_id, run_id)
    }

    pub fn list_agent_runs_from_threads(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentRunRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.list_agent_runs_from_threads(session_id)
    }

    pub fn get_agent_run_from_threads(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<AgentRunRecord>, WorkerProtocolError> {
        self.require(WorkerCapability::SessionMetadataRead)?;
        self.store.get_agent_run_from_threads(session_id, run_id)
    }

    pub fn record_agent_run_checkpoint(
        &self,
        record: &AgentRunRecord,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.record_agent_run_checkpoint(record)
    }

    pub fn record_agent_run_terminal(
        &self,
        record: &AgentRunRecord,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.require(WorkerCapability::SessionWrite)?;
        self.store.record_agent_run_terminal(record)
    }

    pub fn record_subagent_spawn(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.store.record_subagent_spawn(summary, event)
    }

    pub fn record_subagent_input(
        &self,
        summary: &SubagentThreadSummary,
        input: &SubagentMailboxInput,
        event: Option<Value>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.store.record_subagent_input(summary, input, event)
    }

    pub fn record_subagent_status(
        &self,
        summary: &SubagentThreadSummary,
        event: Option<Value>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
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
