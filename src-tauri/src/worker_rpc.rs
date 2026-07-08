use crate::config_store::{ConfigPatchBridgeResult, ConfigStore};
use crate::worker_background::{
    BackgroundRunCompleteParams, BackgroundRunUpsertParams, BackgroundSubagentEnqueueInputParams,
    BackgroundTraceAppendParams, BackgroundTraceGetArtifactParams,
    BackgroundTraceGetDelegateTraceParams, BackgroundTraceListFilter, BackgroundTraceListParams,
    WorkerBackgroundRpc,
};
use crate::worker_capability::CapabilityPolicy;
use crate::worker_config::WorkerConfigRpc;
use crate::worker_cron::{
    CronJobAddParams, CronJobDueParams, CronJobRecordRunsParams, CronJobRemoveParams, WorkerCronRpc,
};
use crate::worker_diagnostics::WorkerDiagnosticsRpc;
use crate::worker_knowledge::{
    KnowledgeAddDocumentParams, KnowledgeContextParams, KnowledgeDocumentIdParams,
    KnowledgeEntityGraphExtractionParams, KnowledgeGraphParams, KnowledgeJobIdParams,
    KnowledgeListDocumentsParams, KnowledgeQueryParams, KnowledgeRebuildIndexParams,
    KnowledgeStartIndexJobParams, WorkerKnowledgeRpc,
};
use crate::worker_memory::WorkerMemoryRpc;
use crate::worker_permission_profile::{
    PermissionDecision, PermissionEvaluateToolRequest, PermissionRequestToolApprovalRequest,
    PermissionResolveToolApprovalRequest, WorkerPermissionProfileRpc,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
    WorkerResponse,
};
use crate::worker_secret::{ProviderResolveSecretParams, WorkerSecretRpc};
use crate::worker_session::{AgentRunRecord, AgentRunSummary, SessionMetadata, WorkerSessionRpc};
use crate::worker_shell::{ShellExecuteParams, WorkerShellRpc};
use crate::worker_subagent_manager::{
    SubagentInputSender, SubagentSendInputParams, SubagentSpawnParams, SubagentTargetParams,
    SubagentThreadManager, SubagentWaitParams,
};
use crate::worker_task::{TaskPlanIdParams, TaskPlanListParams, TaskPlanSaveParams, WorkerTaskRpc};
use crate::worker_thread::{
    AppendThreadItemsRequest, ArchiveThreadRequest, ContinueThreadTurnRequest, CreateThreadRequest,
    DeleteThreadRequest, ForkThreadRequest, InterruptThreadRequest, ListThreadsRequest,
    ReadThreadRequest, RestoreThreadCheckpointRequest, ResumeThreadRequest, SearchThreadsRequest,
    StartThreadTurnRequest, ThreadActivityRequest, ThreadAgentRegistryRequest,
    ThreadApplyOpRequest, ThreadEventsRequest, ThreadIdParams, ThreadOp, ThreadRecord,
    UpdateThreadMetadataRequest, WorkerThreadRpc,
};
use crate::worker_thread_log::WorkerThreadLogRpc;
use crate::worker_tool_executor::{
    tool_not_found_error, tool_unavailable_error, ToolExecutorExecuteRequest,
    ToolExecutorExecuteResult,
};
use crate::worker_tool_registry::{ToolRegistrySearchRequest, WorkerToolRegistryRpc};
use crate::worker_workspace::{WorkerWorkspaceRpc, WorkspaceReadFormat, WorkspaceReadOptions};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;

mod approval;
mod channel;
mod errors;
mod form;
mod mcp;
mod method;
pub(crate) mod protocol;
mod runtime;

use self::approval::{
    shell_execute_approval, workspace_delete_approval, workspace_write_approval, WorkerApprovalRpc,
};
use self::channel::WorkerChannelConnectorRpc;
use self::errors::unknown_method_error;
use self::form::WorkerFormRpc;
use self::mcp::WorkerMcpRpc;
use self::method::classify_method;
use self::protocol::parse_params;
pub use self::runtime::RuntimeRestartRequest;
use self::runtime::WorkerRuntimeRpc;

#[derive(Clone, Debug)]
pub struct WorkerRpcRouter {
    workspace: WorkerWorkspaceRpc,
    config: WorkerConfigRpc,
    secret: WorkerSecretRpc,
    session: WorkerSessionRpc,
    diagnostics: WorkerDiagnosticsRpc,
    shell: WorkerShellRpc,
    approval: WorkerApprovalRpc,
    form: WorkerFormRpc,
    memory: WorkerMemoryRpc,
    knowledge: WorkerKnowledgeRpc,
    task: WorkerTaskRpc,
    cron: WorkerCronRpc,
    background: WorkerBackgroundRpc,
    mcp: WorkerMcpRpc,
    channel_connector: WorkerChannelConnectorRpc,
    runtime: WorkerRuntimeRpc,
    thread: WorkerThreadRpc,
    thread_log: WorkerThreadLogRpc,
    tool_registry: WorkerToolRegistryRpc,
    permission_profile: WorkerPermissionProfileRpc,
    subagents: Option<SubagentThreadManager>,
    config_store: Option<ConfigStore>,
}

impl WorkerRpcRouter {
    pub fn new(
        workspace_root: PathBuf,
        config_snapshot: Value,
        sessions: Vec<SessionMetadata>,
        diagnostic_capacity: usize,
        policy: CapabilityPolicy,
    ) -> Self {
        Self {
            workspace: WorkerWorkspaceRpc::new(workspace_root.clone(), policy.clone()),
            config: WorkerConfigRpc::new(config_snapshot.clone(), policy.clone()),
            secret: WorkerSecretRpc::new(config_snapshot.clone(), policy.clone()),
            session: WorkerSessionRpc::new(sessions, policy.clone()),
            diagnostics: WorkerDiagnosticsRpc::new(diagnostic_capacity, policy.clone()),
            shell: WorkerShellRpc::new(workspace_root.clone(), policy.clone()),
            approval: WorkerApprovalRpc::new(policy.clone()),
            form: WorkerFormRpc::new(policy.clone()),
            memory: WorkerMemoryRpc::new(workspace_root.clone(), policy.clone()),
            knowledge: WorkerKnowledgeRpc::new(workspace_root.clone(), policy.clone()),
            task: WorkerTaskRpc::new(workspace_root.clone(), policy.clone()),
            cron: WorkerCronRpc::new(workspace_root.clone(), policy.clone()),
            background: WorkerBackgroundRpc::new(workspace_root.clone(), policy.clone()),
            channel_connector: WorkerChannelConnectorRpc::new(policy.clone()),
            mcp: WorkerMcpRpc::new(config_snapshot, policy.clone()),
            runtime: WorkerRuntimeRpc::new(),
            thread: WorkerThreadRpc::new(workspace_root.clone(), policy.clone()),
            thread_log: WorkerThreadLogRpc::new(workspace_root, policy.clone()),
            tool_registry: WorkerToolRegistryRpc::new(policy.clone()),
            permission_profile: WorkerPermissionProfileRpc::new(policy),
            subagents: None,
            config_store: None,
        }
    }

    pub fn new_persistent_sessions(
        workspace_root: PathBuf,
        config_snapshot: Value,
        sessions: Vec<SessionMetadata>,
        diagnostic_capacity: usize,
        policy: CapabilityPolicy,
    ) -> Result<Self, crate::worker_protocol::WorkerProtocolError> {
        Ok(Self {
            workspace: WorkerWorkspaceRpc::new(workspace_root.clone(), policy.clone()),
            config: WorkerConfigRpc::new(config_snapshot.clone(), policy.clone()),
            secret: WorkerSecretRpc::new(config_snapshot.clone(), policy.clone()),
            session: WorkerSessionRpc::new_persistent(
                workspace_root.clone(),
                sessions,
                policy.clone(),
            )?,
            diagnostics: WorkerDiagnosticsRpc::new(diagnostic_capacity, policy.clone()),
            shell: WorkerShellRpc::new(workspace_root.clone(), policy.clone()),
            approval: WorkerApprovalRpc::new(policy.clone()),
            form: WorkerFormRpc::new(policy.clone()),
            memory: WorkerMemoryRpc::new(workspace_root.clone(), policy.clone()),
            knowledge: WorkerKnowledgeRpc::new(workspace_root.clone(), policy.clone()),
            task: WorkerTaskRpc::new(workspace_root.clone(), policy.clone()),
            cron: WorkerCronRpc::new(workspace_root.clone(), policy.clone()),
            background: WorkerBackgroundRpc::new(workspace_root.clone(), policy.clone()),
            channel_connector: WorkerChannelConnectorRpc::new(policy.clone()),
            mcp: WorkerMcpRpc::new(config_snapshot, policy.clone()),
            runtime: WorkerRuntimeRpc::new(),
            thread: WorkerThreadRpc::new(workspace_root.clone(), policy.clone()),
            thread_log: WorkerThreadLogRpc::new(workspace_root, policy.clone()),
            tool_registry: WorkerToolRegistryRpc::new(policy.clone()),
            permission_profile: WorkerPermissionProfileRpc::new(policy),
            subagents: None,
            config_store: None,
        })
    }

    pub fn with_config_store(
        workspace_root: PathBuf,
        config_store: ConfigStore,
        sessions: Vec<SessionMetadata>,
        diagnostic_capacity: usize,
        policy: CapabilityPolicy,
    ) -> Self {
        let config_snapshot = config_store.snapshot().clone();
        let mut router = Self::new(
            workspace_root,
            config_snapshot,
            sessions,
            diagnostic_capacity,
            policy,
        );
        router.config_store = Some(config_store);
        router
    }

    pub fn with_runtime_restart_handler(
        mut self,
        handler: impl Fn(RuntimeRestartRequest) + Send + Sync + 'static,
    ) -> Self {
        self.runtime = WorkerRuntimeRpc::with_restart_handler(handler);
        self
    }

    pub fn with_subagent_manager(mut self, manager: SubagentThreadManager) -> Self {
        self.subagents = Some(manager);
        self
    }

    pub fn with_builtin_skills_root(mut self, builtin_skills_root: PathBuf) -> Self {
        self.workspace = self.workspace.with_builtin_skills_root(builtin_skills_root);
        self
    }

    pub fn dispatch(&mut self, request: &WorkerRequest) -> WorkerResponse {
        if let Err(error) = protocol::validate_request(request) {
            return WorkerResponse::failure(request, error);
        }

        match self.dispatch_result(request) {
            Ok(result) => WorkerResponse::success(request, result),
            Err(error) => WorkerResponse::failure(request, error),
        }
    }

    fn dispatch_result(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let _namespace = classify_method(&request.method);
        match request.method.as_str() {
            "workspace.resolve_path" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.workspace.resolve_path(&params.path)?)
                    .map_err(serialization_error)
            }
            "workspace.read_file" => {
                let params: ReadFileParams = parse_params(request)?;
                serde_json::to_value(self.workspace.read_file_with_options(
                    &params.path,
                    WorkspaceReadOptions {
                        offset: params.offset,
                        limit: params.limit,
                        format: params.format.unwrap_or(WorkspaceReadFormat::Raw),
                    },
                )?)
                .map_err(serialization_error)
            }
            "workspace.read_bootstrap_files" => {
                let params: BootstrapFilesParams = parse_params(request)?;
                serde_json::to_value(self.workspace.read_bootstrap_files(&params.files)?)
                    .map_err(serialization_error)
            }
            "workspace.write_file" => {
                let params: WriteFileParams = parse_params(request)?;
                if !params.internal_operation.unwrap_or(false) {
                    self.approval
                        .require_sensitive_operation(workspace_write_approval(
                            &params.path,
                            params.session_id.clone(),
                            params.run_id.clone(),
                            params.approval_fingerprint.clone(),
                            params.approval_session_fingerprint.clone(),
                        ))?;
                }
                serde_json::to_value(self.workspace.write_file_with_expected(
                    &params.path,
                    &params.contents,
                    params.expected_updated_at.as_deref(),
                )?)
                .map_err(serialization_error)
            }
            "workspace.create_dir" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.workspace.create_dir(&params.path)?)
                    .map_err(serialization_error)
            }
            "workspace.list_dir" => {
                let params: ListDirParams = parse_params(request)?;
                serde_json::to_value(self.workspace.list_dir(
                    &params.path,
                    params.recursive.unwrap_or(false),
                    params.max_entries,
                )?)
                .map_err(serialization_error)
            }
            "workspace.delete_file" => {
                let params: DeleteFileParams = parse_params(request)?;
                if !params.internal_operation.unwrap_or(false) {
                    self.approval
                        .require_sensitive_operation(workspace_delete_approval(
                            &params.path,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(
                    self.workspace
                        .delete_file(&params.path, params.recursive.unwrap_or(false))?,
                )
                .map_err(serialization_error)
            }
            "workspace.list_files" => {
                serde_json::to_value(self.workspace.list_files()?).map_err(serialization_error)
            }
            "skills.list" => {
                serde_json::to_value(self.workspace.list_skills()?).map_err(serialization_error)
            }
            "skills.webui_list" => self
                .workspace
                .webui_list_skills(enabled_skills_from_snapshot(
                    &self.config.snapshot_public()?.value,
                )),
            "skills.webui_detail" => {
                let params: SkillNameParams = parse_params(request)?;
                self.workspace.webui_skill_detail(&params.name)
            }
            "skills.webui_create" => {
                let params: SkillCreateParams = parse_params(request)?;
                self.workspace.webui_create_skill(params.body)
            }
            "skills.webui_update" => {
                let params: SkillUpdateParams = parse_params(request)?;
                self.workspace.webui_update_skill(&params.name, params.body)
            }
            "skills.webui_delete" => {
                let params: SkillNameParams = parse_params(request)?;
                self.workspace.webui_delete_skill(&params.name)
            }
            "skills.webui_validate" => {
                let params: SkillNameParams = parse_params(request)?;
                self.workspace.webui_validate_skill(&params.name)
            }
            "config.get" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.config.get(&params.path)?).map_err(serialization_error)
            }
            "config.snapshot_public" => {
                serde_json::to_value(self.config.snapshot_public()?).map_err(serialization_error)
            }
            "config.apply_patch_result" => {
                let params: ConfigPatchBridgeResult = parse_params(request)?;
                let result = if let Some(config_store) = self.config_store.as_mut() {
                    self.config
                        .apply_patch_result_to_store(config_store, params)?
                } else {
                    self.config.apply_patch_result(params)?
                };
                if result.ok {
                    self.secret.update_snapshot(self.config.snapshot().clone());
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "config.apply_operations" => {
                let params: crate::config_store::ConfigOperationRequest = parse_params(request)?;
                let result = if let Some(config_store) = self.config_store.as_mut() {
                    self.config
                        .apply_operations_to_store(config_store, params)?
                } else {
                    return Err(WorkerProtocolError::new(
                        WorkerProtocolErrorCode::InvalidProtocol,
                        "config operation writes require a config store",
                        serde_json::json!({ "method": request.method }),
                        false,
                        WorkerProtocolErrorSource::RustCore,
                    ));
                };
                if result.ok {
                    self.secret.update_snapshot(self.config.snapshot().clone());
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "provider.resolve_secret" => {
                let params: ProviderResolveSecretParams = parse_params(request)?;
                serde_json::to_value(self.secret.resolve_secret(params)?)
                    .map_err(serialization_error)
            }
            "session.get_metadata" => {
                let params: SessionIdParams = parse_params(request)?;
                if let Some(session) = self.thread_log.get_session_metadata(&params.session_id)? {
                    return serde_json::to_value(session).map_err(serialization_error);
                }
                let session = match self.session.get_metadata(&params.session_id) {
                    Ok(session) => session,
                    Err(error) => match self
                        .thread
                        .get_session_metadata_from_threads(&params.session_id)?
                    {
                        Some(session) => session,
                        None => return Err(error),
                    },
                };
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.get_history" => {
                let params: SessionHistoryParams = parse_params(request)?;
                if let Some(projection) = self
                    .thread_log
                    .get_session_history(&params.session_id, params.limit.unwrap_or(80))?
                {
                    return serde_json::to_value(projection).map_err(serialization_error);
                }
                let projection = self
                    .session
                    .get_history(&params.session_id, params.limit.unwrap_or(80))?;
                let projection =
                    if projection.messages.is_empty() && projection.updated_at.is_empty() {
                        self.thread
                            .get_session_history_from_threads(
                                &params.session_id,
                                params.limit.unwrap_or(80),
                            )?
                            .unwrap_or(projection)
                    } else {
                        self.thread.project_session_history_if_writable(
                            &projection.session_id,
                            &projection.messages,
                        )?;
                        projection
                    };
                serde_json::to_value(projection).map_err(serialization_error)
            }
            "session.list_metadata" => {
                let thread_log_sessions = self.thread_log.list_session_metadata()?;
                let sessions = self.session.list_metadata()?;
                let mut merged = self.thread.list_session_metadata_with_threads(&sessions)?;
                for session in thread_log_sessions {
                    if let Some(existing_index) = merged
                        .iter()
                        .position(|existing| existing.session_id == session.session_id)
                    {
                        merged[existing_index] = session;
                    } else {
                        merged.push(session);
                    }
                }
                merged.sort_by(|left, right| {
                    session_updated_sort_millis(&right.updated_at)
                        .cmp(&session_updated_sort_millis(&left.updated_at))
                        .then_with(|| left.session_id.cmp(&right.session_id))
                });
                serde_json::to_value(merged).map_err(serialization_error)
            }
            "session.get_checkpoint" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.session.get_checkpoint(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.set_checkpoint" => {
                let params: SessionCheckpointParams = parse_params(request)?;
                let checkpoint = params.checkpoint;
                let run_id = checkpoint_run_id(&checkpoint);
                let session = self
                    .session
                    .set_checkpoint(&params.session_id, checkpoint)?;
                if let Some(run_id) = run_id {
                    if let Some(record) = agent_run_from_session_metadata(&session, &run_id) {
                        let append = self.thread.record_agent_run_checkpoint(&record)?;
                        self.session
                            .upsert_agent_run(agent_run_with_thread(record, &append.thread))?;
                    }
                }
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.clear_checkpoint" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.session.clear_checkpoint(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.clear" => {
                let params: SessionIdParams = parse_params(request)?;
                let legacy_result = self.session.clear_session(&params.session_id)?;
                let thread_log_result = self.thread_log.clear_session(&params.session_id)?;
                serde_json::to_value(thread_log_result.unwrap_or(legacy_result))
                    .map_err(serialization_error)
            }
            "session.trim" => {
                let params: SessionTrimParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .trim_session(&params.session_id, params.keep_recent_messages)?,
                )
                .map_err(serialization_error)
            }
            "session.delete" => {
                let params: SessionIdParams = parse_params(request)?;
                let result = self.session.delete_session(&params.session_id)?;
                let thread_log_result = self.thread_log.delete_session(&params.session_id)?;
                if result.deleted {
                    self.thread.archive_session_thread(&params.session_id)?;
                }
                let deleted = result.deleted || thread_log_result.deleted;
                serde_json::to_value(crate::worker_session::DeleteSessionResult {
                    session_id: params.session_id,
                    deleted,
                })
                .map_err(serialization_error)
            }
            "session.patch_metadata" => {
                let params: SessionPatchMetadataParams = parse_params(request)?;
                let thread_log_session = self
                    .thread_log
                    .patch_metadata(&params.session_id, &params.metadata)?;
                let session = match self
                    .session
                    .patch_metadata(&params.session_id, params.metadata)
                {
                    Ok(session) => {
                        self.thread.sync_session_metadata(&session)?;
                        thread_log_session.unwrap_or(session)
                    }
                    Err(error) => match thread_log_session {
                        Some(session) if is_legacy_session_not_found_error(&error) => session,
                        None => return Err(error),
                        Some(_) => return Err(error),
                    },
                };
                serde_json::to_value(session).map_err(serialization_error)
            }
            "session.patch_user_profile" => {
                let params: SessionPatchUserProfileParams = parse_params(request)?;
                serde_json::to_value(self.session.patch_user_profile(
                    &params.session_id,
                    params.user_profile,
                    params.metadata.unwrap_or_else(|| serde_json::json!({})),
                )?)
                .map_err(serialization_error)
            }
            "session.temporary_file.upload" => {
                let params: SessionTemporaryFileUploadParams = parse_params(request)?;
                self.session.upload_temporary_file(
                    &params.session_id,
                    &params.name,
                    &params.file_type,
                    &params.content,
                    params
                        .size_bytes
                        .unwrap_or_else(|| params.content.len() as u64),
                )
            }
            "session.append_messages" => {
                let params: SessionAppendMessagesParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .append_messages(&params.session_id, params.messages)?,
                )
                .map_err(serialization_error)
            }
            "session.task_progress.upsert" => {
                let params: SessionTaskProgressUpsertParams = parse_params(request)?;
                serde_json::to_value(self.session.upsert_task_progress(
                    &params.session_id,
                    &params.plan_id,
                    params.progress,
                    params.content,
                )?)
                .map_err(serialization_error)
            }
            "session.persist_turn" => {
                let params: SessionPersistTurnParams = parse_params(request)?;
                let _legacy_clear_checkpoint = params.clear_checkpoint;
                let _legacy_context_metadata = params.context_metadata();
                let result = self.thread_log.persist_session_turn(
                    &params.session_id,
                    &params.run_id,
                    params.messages,
                )?;
                serde_json::to_value(result).map_err(serialization_error)
            }
            "thread.create" => {
                let params: CreateThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.create_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.read" => {
                let params: ReadThreadRequest = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .read_thread_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.resume" => {
                let params: ResumeThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.resume_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.status" => {
                let params: ThreadIdParams = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .get_thread_status_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.list" => {
                let params: ListThreadsRequest = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .list_threads_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.search" => {
                let params: SearchThreadsRequest = parse_params(request)?;
                let sessions = self.session.list_metadata()?;
                serde_json::to_value(
                    self.thread
                        .search_threads_with_legacy_sessions(params, &sessions)?,
                )
                .map_err(serialization_error)
            }
            "thread.update_metadata" => {
                let params: UpdateThreadMetadataRequest = parse_params(request)?;
                serde_json::to_value(self.thread.update_thread_metadata(params)?)
                    .map_err(serialization_error)
            }
            "thread.archive" => {
                let params: ArchiveThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.archive_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.unarchive" => {
                let mut params: ArchiveThreadRequest = parse_params(request)?;
                params.archived = Some(false);
                serde_json::to_value(self.thread.unarchive_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.delete" => {
                let params: DeleteThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.delete_thread(params)?)
                    .map_err(serialization_error)
            }
            "thread.fork" => {
                let params: ForkThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.fork_thread(params)?).map_err(serialization_error)
            }
            "thread.append_items" => {
                let params: AppendThreadItemsRequest = parse_params(request)?;
                serde_json::to_value(self.thread.append_items(params)?).map_err(serialization_error)
            }
            "thread.events" => {
                let params: ThreadEventsRequest = parse_params(request)?;
                serde_json::to_value(self.thread.thread_events(params)?)
                    .map_err(serialization_error)
            }
            "thread.restore_checkpoint" => {
                let params: RestoreThreadCheckpointRequest = parse_params(request)?;
                serde_json::to_value(self.thread.restore_checkpoint(params)?)
                    .map_err(serialization_error)
            }
            "thread.agent_registry" => {
                let params: ThreadAgentRegistryRequest = parse_params(request)?;
                serde_json::to_value(self.thread.agent_registry(params)?)
                    .map_err(serialization_error)
            }
            "thread.activity" => {
                let params: ThreadActivityRequest = parse_params(request)?;
                serde_json::to_value(self.thread.activity(params)?).map_err(serialization_error)
            }
            "thread.start_turn" => {
                let params: StartThreadTurnRequest = parse_params(request)?;
                serde_json::to_value(self.thread.start_turn(params)?).map_err(serialization_error)
            }
            "thread.apply_op" => {
                let params: ThreadApplyOpRequest = parse_params(request)?;
                serde_json::to_value(self.thread.apply_op(params)?).map_err(serialization_error)
            }
            "thread.continue_turn" => {
                let params: ContinueThreadTurnRequest = parse_params(request)?;
                serde_json::to_value(self.thread.continue_turn(params)?)
                    .map_err(serialization_error)
            }
            "thread.interrupt" => {
                let params: InterruptThreadRequest = parse_params(request)?;
                serde_json::to_value(self.thread.interrupt(params)?).map_err(serialization_error)
            }
            "agent_run.upsert" => {
                let params: AgentRunUpsertParams = parse_params(request)?;
                let record = self.session.upsert_agent_run(params.record)?;
                let append = self.thread.record_agent_run(&record)?;
                let record = self
                    .session
                    .upsert_agent_run(agent_run_with_thread(record, &append.thread))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.list" => {
                let params: AgentRunListParams = parse_params(request)?;
                let runs = merge_agent_run_records(
                    self.session.list_agent_runs(&params.session_id)?,
                    self.thread
                        .list_agent_runs_from_threads(&params.session_id)?,
                )
                .iter()
                .map(AgentRunSummary::from_record)
                .collect::<Vec<_>>();
                Ok(serde_json::json!({
                    "sessionId": params.session_id,
                    "runs": runs,
                }))
            }
            "agent_run.get" => {
                let params: AgentRunIdParams = parse_params(request)?;
                let record = match self
                    .session
                    .get_agent_run(&params.session_id, &params.run_id)
                {
                    Ok(record) => record,
                    Err(session_error) => match self
                        .thread
                        .get_agent_run_from_threads(&params.session_id, &params.run_id)?
                    {
                        Some(record) => record,
                        None => return Err(session_error),
                    },
                };
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.list_trace" => {
                let params: AgentRunListTraceParams = parse_params(request)?;
                let trace_page = match self.thread.list_agent_run_trace_events(
                    &params.session_id,
                    &params.run_id,
                    params.cursor.as_deref(),
                    params.limit,
                )? {
                    Some(trace_page) => trace_page,
                    None => self.session.list_agent_run_trace_events(
                        &params.session_id,
                        &params.run_id,
                        params.cursor.as_deref(),
                        params.limit,
                    )?,
                };
                serde_json::to_value(trace_page).map_err(serialization_error)
            }
            "agent_run.runtime_state" => {
                let params: AgentRunIdParams = parse_params(request)?;
                let runtime_state = match self
                    .thread
                    .get_agent_run_runtime_state(&params.session_id, &params.run_id)?
                {
                    Some(runtime_state) => runtime_state,
                    None => self
                        .session
                        .get_agent_run_runtime_state(&params.session_id, &params.run_id)?,
                };
                serde_json::to_value(runtime_state).map_err(serialization_error)
            }
            "agent_run.append_trace" => {
                let params: AgentRunAppendTraceParams = parse_params(request)?;
                let event = params.event.clone();
                let record = self.session.append_agent_run_trace_event(
                    &params.session_id,
                    &params.run_id,
                    params.event,
                )?;
                let append = self.thread.record_agent_run_trace(&record, event)?;
                let record = self
                    .session
                    .upsert_agent_run(agent_run_with_thread(record, &append.thread))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.set_checkpoint" => {
                let params: AgentRunCheckpointParams = parse_params(request)?;
                let record = self.session.set_agent_run_checkpoint(
                    &params.session_id,
                    &params.run_id,
                    params.checkpoint,
                )?;
                let append = self.thread.record_agent_run_checkpoint(&record)?;
                let record = self
                    .session
                    .upsert_agent_run(agent_run_with_thread(record, &append.thread))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.get_checkpoint" => {
                let params: AgentRunIdParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .get_agent_run_checkpoint(&params.session_id, &params.run_id)?,
                )
                .map_err(serialization_error)
            }
            "agent_run.clear_checkpoint" => {
                let params: AgentRunIdParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .clear_agent_run_checkpoint(&params.session_id, &params.run_id)?,
                )
                .map_err(serialization_error)
            }
            "agent_run.mark_completed" => {
                let params: AgentRunMarkCompletedParams = parse_params(request)?;
                let record = self.session.mark_agent_run_completed(
                    &params.session_id,
                    &params.run_id,
                    &params.stop_reason,
                    params.final_content,
                )?;
                let append = self.thread.record_agent_run_terminal(&record)?;
                let record = self
                    .session
                    .upsert_agent_run(agent_run_with_thread(record, &append.thread))?;
                if let Some(token_usage_info) = record.token_usage_info.clone() {
                    let info_value =
                        serde_json::to_value(token_usage_info).map_err(serialization_error)?;
                    let info = serde_json::from_value::<crate::worker_thread_log::TokenUsageInfo>(
                        info_value,
                    )
                    .map_err(serialization_error)?;
                    self.thread_log
                        .append_token_count(&record.session_id, info)?;
                }
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.mark_failed" => {
                let params: AgentRunMarkFailedParams = parse_params(request)?;
                let record = self.session.mark_agent_run_failed(
                    &params.session_id,
                    &params.run_id,
                    &params.stop_reason,
                    params.error,
                )?;
                let append = self.thread.record_agent_run_terminal(&record)?;
                let record = self
                    .session
                    .upsert_agent_run(agent_run_with_thread(record, &append.thread))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "agent_run.mark_cancelled" => {
                let params: AgentRunIdParams = parse_params(request)?;
                let record = self
                    .session
                    .mark_agent_run_cancelled(&params.session_id, &params.run_id)?;
                let append = self.thread.record_agent_run_terminal(&record)?;
                let record = self
                    .session
                    .upsert_agent_run(agent_run_with_thread(record, &append.thread))?;
                serde_json::to_value(record).map_err(serialization_error)
            }
            "diagnostics.append" => {
                let params: DiagnosticsAppendParams = parse_params(request)?;
                serde_json::to_value(self.diagnostics.append(&params.stream, &params.line)?)
                    .map_err(serialization_error)
            }
            "channel.connector.start" => self.channel_connector.start_from_request(request),
            "channel.connector.stop" => self.channel_connector.stop_from_request(request),
            "channel.connector.login" => self.channel_connector.login_from_request(request),
            "channel.connector.send_text" => self.channel_connector.send_text_from_request(request),
            "channel.connector.send_delta" => {
                self.channel_connector.send_delta_from_request(request)
            }
            "channel.connector.send_usage" => {
                self.channel_connector.send_usage_from_request(request)
            }
            "channel.connector.transcribe_audio" => self
                .channel_connector
                .transcribe_audio_from_request(request),
            "shell.execute" => {
                let params: ShellExecuteRequestParams = parse_params(request)?;
                self.approval
                    .require_sensitive_operation(shell_execute_approval(
                        &params.command,
                        params.session_id.clone(),
                        params.run_id.clone(),
                    ))?;
                serde_json::to_value(self.shell.execute(params.into_shell_params())?)
                    .map_err(serialization_error)
            }
            "approval.request" => self.approval.request_from_request(request),
            "approval.resolve" => self.approval.resolve_from_request(request),
            "approval.list_pending" => self.approval.list_pending_from_request(request),
            "form.request" => self.form.request_from_request(request),
            "memory.search" => self.memory.search_from_request(request),
            "memory.recall" => self.memory.recall_from_request(request),
            "memory.rebuild_index" => self.memory.rebuild_index(),
            "memory.refresh_views" => self.memory.refresh_views(),
            "memory.migrate_legacy_notes" => self.memory.migrate_legacy_notes(),
            "memory.dream_run" => self.memory.dream_run_from_request(request),
            "memory.dream_pending" => self.memory.dream_pending_from_request(request),
            "memory.dream_apply" => self.memory.dream_apply_from_request(request),
            "memory.dream_log" => self.memory.dream_log_from_request(request),
            "memory.dream_restore" => self.memory.dream_restore_from_request(request),
            "memory.capture_evidence" => self.memory.capture_evidence_from_request(request),
            "memory.list_evidence" => self.memory.list_evidence_from_request(request),
            "memory.save" => self.memory.save_from_request(request),
            "memory.trace" => self.memory.trace_from_request(request),
            "memory.reject" => self.memory.reject_from_request(request),
            "memory.supersede" => self.memory.supersede_from_request(request),
            "knowledge.add_document" => {
                let params: KnowledgeAddDocumentParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.add_document(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.list_documents" => {
                let params: KnowledgeListDocumentsParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.list_documents(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.get_document" => {
                let params: KnowledgeDocumentIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.get_document(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.document_tree" => {
                let params: KnowledgeDocumentIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.document_tree(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.delete_document" => {
                let params: KnowledgeDocumentIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.delete_document(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.start_index_job" => {
                let params: KnowledgeStartIndexJobParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.start_index_job(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.get_job" => {
                let params: KnowledgeJobIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.get_job(params)?).map_err(serialization_error)
            }
            "knowledge.rebuild_index" => {
                let params: KnowledgeRebuildIndexParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.rebuild_index(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.graph" => {
                let params: KnowledgeGraphParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.document_graph(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.save_entity_graph_extraction" => {
                let params: KnowledgeEntityGraphExtractionParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.save_entity_graph_extraction(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.stats" => {
                serde_json::to_value(self.knowledge.stats()?).map_err(serialization_error)
            }
            "knowledge.context" => {
                let params: KnowledgeContextParams = parse_params(request)?;
                let session_files = params
                    .session_key
                    .as_deref()
                    .and_then(|session_key| self.session.get_metadata(session_key).ok())
                    .and_then(|session| {
                        session
                            .extra
                            .get("temporary_files")
                            .and_then(Value::as_array)
                            .cloned()
                    })
                    .unwrap_or_default();
                serde_json::to_value(
                    self.knowledge
                        .context_with_session_files(params, session_files)?,
                )
                .map_err(serialization_error)
            }
            "knowledge.session_upload" => {
                let params: SessionTemporaryFileUploadParams = parse_params(request)?;
                self.session.upload_temporary_file(
                    &params.session_id,
                    &params.name,
                    &params.file_type,
                    &params.content,
                    params
                        .size_bytes
                        .unwrap_or_else(|| params.content.len() as u64),
                )
            }
            "knowledge.session_list" => {
                let params: SessionIdParams = parse_params(request)?;
                self.session.list_temporary_files(&params.session_id)
            }
            "knowledge.session_clear" => {
                let params: SessionIdParams = parse_params(request)?;
                self.session.clear_temporary_files(&params.session_id)
            }
            "rag.query" => {
                let params: RagQueryParams = parse_params(request)?;
                self.query_rag(params)
            }
            "knowledge.query" => {
                let params: KnowledgeQueryParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.query(params)?).map_err(serialization_error)
            }
            "task.store.load" => {
                serde_json::to_value(self.task.load_store()?).map_err(serialization_error)
            }
            "task.plan.list" => {
                let params: TaskPlanListParams = parse_params(request)?;
                serde_json::to_value(self.task.list_plans(params)?).map_err(serialization_error)
            }
            "task.plan.get" => {
                let params: TaskPlanIdParams = parse_params(request)?;
                serde_json::to_value(self.task.get_plan(params)?).map_err(serialization_error)
            }
            "task.plan.save" => {
                let params: TaskPlanSaveParams = parse_params(request)?;
                serde_json::to_value(self.task.save_plan(params)?).map_err(serialization_error)
            }
            "task.plan.delete" => {
                let params: TaskPlanIdParams = parse_params(request)?;
                serde_json::to_value(self.task.delete_plan(params)?).map_err(serialization_error)
            }
            "cron.job.add" => {
                let params: CronJobAddParams = parse_params(request)?;
                serde_json::to_value(self.cron.add_job(params)?).map_err(serialization_error)
            }
            "cron.job.list" => {
                serde_json::to_value(self.cron.list_jobs()?).map_err(serialization_error)
            }
            "cron.job.due" => {
                let params: CronJobDueParams = parse_params(request)?;
                serde_json::to_value(self.cron.due_jobs(params)?).map_err(serialization_error)
            }
            "cron.job.record_runs" => {
                let params: CronJobRecordRunsParams = parse_params(request)?;
                serde_json::to_value(self.cron.record_runs(params)?).map_err(serialization_error)
            }
            "cron.job.remove" => {
                let params: CronJobRemoveParams = parse_params(request)?;
                serde_json::to_value(self.cron.remove_job(params)?).map_err(serialization_error)
            }
            "background.run.list" => {
                serde_json::to_value(self.background.list_runs()?).map_err(serialization_error)
            }
            "background.run.upsert" => {
                let params: BackgroundRunUpsertParams = parse_params(request)?;
                serde_json::to_value(self.background.upsert_run(params)?)
                    .map_err(serialization_error)
            }
            "background.run.complete" => {
                let params: BackgroundRunCompleteParams = parse_params(request)?;
                serde_json::to_value(self.background.complete_run(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.append" => {
                let params: BackgroundTraceAppendParams = parse_params(request)?;
                serde_json::to_value(self.background.append_trace_event(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.list" => {
                let params: BackgroundTraceListParams = parse_params(request)?;
                serde_json::to_value(self.background.list_trace_events(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.get_delegate_trace" => {
                let params: BackgroundTraceGetDelegateTraceParams = parse_params(request)?;
                serde_json::to_value(self.background.get_delegate_trace(params)?)
                    .map_err(serialization_error)
            }
            "background.trace.get_artifact" => {
                let params: BackgroundTraceGetArtifactParams = parse_params(request)?;
                serde_json::to_value(self.background.get_artifact(params)?)
                    .map_err(serialization_error)
            }
            "background.subagent.enqueue_input" => {
                let mut params: BackgroundSubagentEnqueueInputParams = parse_params(request)?;
                if let Some(manager) = &self.subagents {
                    let live = manager.enqueue_input(SubagentSendInputParams {
                        session_key: params.session_key.clone(),
                        subagent_id: params.subagent_id.clone(),
                        content: params.content.clone(),
                        sender: SubagentInputSender::User,
                        turn_id: params.turn_id.clone(),
                        child_run_id: params.child_run_id.clone(),
                        trace_ref: params.trace_ref.clone(),
                        created_at: params.created_at.clone(),
                        metadata: params.metadata.clone(),
                    });
                    if !live.accepted {
                        return serde_json::to_value(live).map_err(serialization_error);
                    }
                    if live.delivery == "live_delivered" {
                        params.delivery = Some(live.delivery.clone());
                        let persisted = self.background.enqueue_subagent_input(params)?;
                        return Ok(serde_json::json!({
                            "accepted": true,
                            "delivery": live.delivery,
                            "event": persisted.event,
                            "input": live.input,
                            "subagent": live.subagent,
                        }));
                    }
                }
                serde_json::to_value(self.background.enqueue_subagent_input(params)?)
                    .map_err(serialization_error)
            }
            "subagent.spawn" => {
                let params: SubagentSpawnParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.spawn(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_spawn(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.list" => {
                let params: SubagentListParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let trace_events = self
                    .background
                    .list_trace_events(BackgroundTraceListParams {
                        filter: Some(BackgroundTraceListFilter {
                            session_key: Some(params.session_key.clone()),
                            ..Default::default()
                        }),
                    })?
                    .events;
                manager.restore_interrupted_from_trace_events(&params.session_key, &trace_events);
                serde_json::to_value(manager.list(&params.session_key)).map_err(serialization_error)
            }
            "subagent.query" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                serde_json::to_value(manager.query(params)).map_err(serialization_error)
            }
            "subagent.send_input" => {
                let params: SubagentSendInputParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.enqueue_input(params);
                if result.accepted {
                    if let (Some(subagent), Some(input)) = (&result.subagent, &result.input) {
                        self.thread.record_subagent_input(
                            subagent,
                            input,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.wait" => {
                let params: SubagentWaitParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.wait(params);
                for subagent in &result.statuses {
                    self.thread.record_subagent_status(subagent, None)?;
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.cancel" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.cancel(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_status(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "subagent.close" => {
                let params: SubagentTargetParams = parse_params(request)?;
                let Some(manager) = &self.subagents else {
                    return Err(unavailable_subagent_manager());
                };
                let result = manager.close(params);
                if result.accepted {
                    if let Some(subagent) = &result.subagent {
                        self.thread.record_subagent_status(
                            subagent,
                            result
                                .event
                                .as_ref()
                                .map(serde_json::to_value)
                                .transpose()
                                .map_err(serialization_error)?,
                        )?;
                    }
                }
                serde_json::to_value(result).map_err(serialization_error)
            }
            "mcp.call_tool" => self.mcp.call_tool_from_request(request),
            "mcp.list_tools" => self.mcp.list_tools(),
            "permission_profile.current" => serde_json::to_value(
                self.permission_profile
                    .current_profile(self.tool_registry.list_tools().tools),
            )
            .map_err(serialization_error),
            "permission_profile.evaluate_tool" => {
                let params: PermissionEvaluateToolRequest = parse_params(request)?;
                let tool = self
                    .tool_registry
                    .get_tool(&params.tool_id)
                    .ok_or_else(|| {
                        self.permission_profile
                            .tool_not_found_error(&params.tool_id)
                    })?;
                serde_json::to_value(self.permission_profile.evaluate_tool(&tool, params))
                    .map_err(serialization_error)
            }
            "permission_profile.request_tool_approval" => {
                let params: PermissionRequestToolApprovalRequest = parse_params(request)?;
                self.request_tool_approval(request, params)
            }
            "permission_profile.resolve_tool_approval" => {
                let params: PermissionResolveToolApprovalRequest = parse_params(request)?;
                self.resolve_tool_approval(request, params)
            }
            "tool_executor.execute" => {
                let params: ToolExecutorExecuteRequest = parse_params(request)?;
                self.execute_registered_tool(request, params)
            }
            "tool_registry.list" => {
                serde_json::to_value(self.tool_registry.list_tools()).map_err(serialization_error)
            }
            "tool_registry.search" => {
                let params: ToolRegistrySearchRequest = parse_params(request)?;
                serde_json::to_value(self.tool_registry.search_tools(params))
                    .map_err(serialization_error)
            }
            "runtime.now" => self.runtime.now_from_request(request),
            "runtime.restart" => self.runtime.restart_from_request(request),
            _ => Err(unknown_method_error(request)),
        }
    }

    fn query_rag(
        &self,
        params: RagQueryParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let limit = params.limit.unwrap_or(5).min(20);
        if limit == 0 {
            return Ok(serde_json::json!({ "documents": [] }));
        }
        let collection = normalize_rag_collection(params.collection)?;
        let query_terms = rag_query_terms(&params.query);
        if query_terms.is_empty() {
            return Err(invalid_rag_request(
                "query must contain at least one searchable term",
            ));
        }
        let mut documents = Vec::new();
        for entry in self.workspace.list_files()? {
            if !is_rag_candidate_path(&entry.path, collection.as_deref()) {
                continue;
            }
            let file = match self.workspace.read_file(&entry.path) {
                Ok(file) => file,
                Err(_) => continue,
            };
            let score = rag_document_score(&file.path, &file.contents, &query_terms);
            if score == 0 {
                continue;
            }
            documents.push(serde_json::json!({
                "id": file.path,
                "title": rag_document_title(&file.path, &file.contents),
                "path": file.path,
                "score": score,
                "excerpt": rag_document_excerpt(&file.contents, &query_terms),
            }));
        }
        documents.sort_by(|left, right| {
            let left_score = left.get("score").and_then(Value::as_u64).unwrap_or(0);
            let right_score = right.get("score").and_then(Value::as_u64).unwrap_or(0);
            right_score
                .cmp(&left_score)
                .then_with(|| left["path"].as_str().cmp(&right["path"].as_str()))
        });
        documents.truncate(limit);
        Ok(serde_json::json!({ "documents": documents }))
    }

    fn request_tool_approval(
        &mut self,
        request: &WorkerRequest,
        params: PermissionRequestToolApprovalRequest,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let tool = self
            .tool_registry
            .get_tool(&params.tool_id)
            .ok_or_else(|| {
                self.permission_profile
                    .tool_not_found_error(&params.tool_id)
            })?;
        let evaluation = self.permission_profile.evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: params.tool_id.clone(),
                arguments: params.arguments,
                session_id: params.session_id.clone(),
                run_id: params.run_id.clone(),
            },
        );

        if evaluation.decision == PermissionDecision::Allow {
            return Ok(serde_json::json!({
                "status": "allowed",
                "evaluation": evaluation,
                "appendedItems": []
            }));
        }
        if evaluation.decision == PermissionDecision::Deny {
            return Ok(serde_json::json!({
                "status": "denied",
                "evaluation": evaluation,
                "appendedItems": []
            }));
        }

        let approval_request = evaluation.approval_request.clone().ok_or_else(|| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "tool approval request is unavailable",
                serde_json::json!({
                    "method": request.method,
                    "toolId": params.tool_id,
                }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        let run_id = params
            .run_id
            .clone()
            .or_else(|| approval_request.run_id.clone())
            .unwrap_or_else(|| tool.method.to_string());
        let approval = self.approval.request_from_request(&WorkerRequest::new(
            format!("{}:approval-request", request.id),
            request.trace_id.clone(),
            "approval.request",
            serde_json::json!({
                "run_id": run_id,
                "session_id": params.session_id,
                "operation": approval_request.operation,
                "classification": {
                    "category": approval_request.category,
                    "risk": approval_request.risk,
                    "reason": approval_request.reason
                },
                "fingerprint": approval_request.fingerprint,
                "sessionFingerprint": approval_request.session_fingerprint,
                "summary": approval_request.summary
            }),
        ))?;

        let mut appended_items = Vec::new();
        if let Some(thread_id) = params.thread_id.as_deref() {
            let approval_id = approval
                .get("approvalId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let summary = approval
                .get("summary")
                .and_then(Value::as_str)
                .map(str::to_string);
            let client_event_id = params
                .client_event_id
                .clone()
                .unwrap_or_else(|| format!("{}:approval-request", request.id));
            appended_items.extend(
                self.apply_thread_op(
                    thread_id,
                    client_event_id,
                    ThreadOp::ApprovalRequest {
                        run_id: params.run_id,
                        turn_id: params.turn_id,
                        approval_id,
                        summary,
                        scope: approval
                            .get("scope")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        payload: approval.clone(),
                    },
                )?,
            );
        }

        Ok(serde_json::json!({
            "status": "awaiting_approval",
            "evaluation": evaluation,
            "approval": approval,
            "appendedItems": appended_items
        }))
    }

    fn resolve_tool_approval(
        &mut self,
        request: &WorkerRequest,
        params: PermissionResolveToolApprovalRequest,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let resolution = self.approval.resolve_from_request(&WorkerRequest::new(
            format!("{}:approval-resolve", request.id),
            request.trace_id.clone(),
            "approval.resolve",
            serde_json::json!({
                "session_id": params.session_id,
                "approval_id": params.approval_id,
                "approved": params.approved,
                "scope": params.scope
            }),
        ))?;

        let mut appended_items = Vec::new();
        if let Some(thread_id) = params.thread_id.as_deref() {
            let client_event_id = params
                .client_event_id
                .clone()
                .unwrap_or_else(|| format!("{}:approval-resolve", request.id));
            appended_items.extend(self.apply_thread_op(
                thread_id,
                client_event_id,
                ThreadOp::ApprovalDecision {
                    run_id: params.run_id,
                    turn_id: params.turn_id,
                    approval_id: Some(params.approval_id),
                    approved: params.approved,
                    scope: params.scope,
                    guidance: params.guidance,
                    payload: resolution.clone(),
                },
            )?);
        }

        Ok(serde_json::json!({
            "status": resolution
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or(if params.approved { "approved" } else { "denied" }),
            "resolution": resolution,
            "appendedItems": appended_items
        }))
    }

    fn execute_registered_tool(
        &mut self,
        request: &WorkerRequest,
        params: ToolExecutorExecuteRequest,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let tool = self
            .tool_registry
            .get_tool(&params.tool_id)
            .ok_or_else(|| tool_not_found_error(&params.tool_id))?;
        let missing_capabilities = self.tool_registry.missing_capabilities(&tool);
        if !missing_capabilities.is_empty() {
            return Err(tool_unavailable_error(&tool, missing_capabilities));
        }
        let permission = self.permission_profile.evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: params.tool_id.clone(),
                arguments: params.arguments.clone(),
                session_id: params.session_id.clone(),
                run_id: params.run_id.clone(),
            },
        );

        let tool_call_id = params.thread_id.as_ref().map(|_| {
            params
                .tool_call_id
                .clone()
                .unwrap_or_else(|| format!("tool-executor-{}", request.id))
        });
        let mut appended_items = Vec::new();
        if let (Some(thread_id), Some(tool_call_id)) = (&params.thread_id, &tool_call_id) {
            appended_items.extend(self.apply_thread_op(
                thread_id,
                format!("{}:tool-start", request.id),
                ThreadOp::ToolCallStarted {
                    run_id: params.run_id.clone(),
                    turn_id: params.turn_id.clone(),
                    tool_call_id: Some(tool_call_id.clone()),
                    tool_name: Some(tool.method.to_string()),
                    args: params.arguments.clone(),
                },
            )?);
        }

        let tool_arguments = tool_executor_arguments_with_context(&params);
        let tool_request = WorkerRequest::new(
            request.id.clone(),
            request.trace_id.clone(),
            tool.method,
            tool_arguments,
        );
        match self.dispatch_result(&tool_request) {
            Ok(result) => {
                if let (Some(thread_id), Some(tool_call_id)) = (&params.thread_id, &tool_call_id) {
                    appended_items.extend(self.apply_thread_op(
                        thread_id,
                        format!("{}:tool-result", request.id),
                        ThreadOp::ToolResult {
                            run_id: params.run_id.clone(),
                            turn_id: params.turn_id.clone(),
                            tool_call_id: Some(tool_call_id.clone()),
                            tool_name: Some(tool.method.to_string()),
                            output: result.clone(),
                            error: None,
                        },
                    )?);
                }
                serde_json::to_value(ToolExecutorExecuteResult::new(
                    &tool,
                    &params,
                    tool_call_id,
                    appended_items,
                    permission,
                    result,
                ))
                .map_err(serialization_error)
            }
            Err(error) => {
                if let (Some(thread_id), Some(tool_call_id)) = (&params.thread_id, &tool_call_id) {
                    if let Ok(error_value) = serde_json::to_value(&error) {
                        let _ = self.apply_thread_op(
                            thread_id,
                            format!("{}:tool-error", request.id),
                            ThreadOp::ToolResult {
                                run_id: params.run_id.clone(),
                                turn_id: params.turn_id.clone(),
                                tool_call_id: Some(tool_call_id.clone()),
                                tool_name: Some(tool.method.to_string()),
                                output: Value::Null,
                                error: Some(error_value),
                            },
                        );
                    }
                }
                Err(error)
            }
        }
    }

    fn apply_thread_op(
        &mut self,
        thread_id: &str,
        client_event_id: String,
        op: ThreadOp,
    ) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        self.thread
            .apply_op(ThreadApplyOpRequest {
                thread_id: thread_id.to_string(),
                client_event_id: Some(client_event_id),
                op,
            })?
            .appended_items
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(serialization_error)
    }
}

fn tool_executor_arguments_with_context(params: &ToolExecutorExecuteRequest) -> Value {
    let mut arguments = params.arguments.clone();
    if let Value::Object(object) = &mut arguments {
        if !object.contains_key("sessionId") && !object.contains_key("session_id") {
            if let Some(session_id) = params
                .session_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                object.insert(
                    "sessionId".to_string(),
                    Value::String(session_id.to_string()),
                );
            }
        }
        if !object.contains_key("runId") && !object.contains_key("run_id") {
            if let Some(run_id) = params
                .run_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                object.insert("runId".to_string(), Value::String(run_id.to_string()));
            }
        }
    }
    arguments
}

#[derive(Deserialize)]
struct PathParams {
    path: String,
}

#[derive(Deserialize)]
struct ReadFileParams {
    path: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default, deserialize_with = "deserialize_workspace_read_format")]
    format: Option<WorkspaceReadFormat>,
}

#[derive(Deserialize)]
struct ListDirParams {
    path: String,
    #[serde(default)]
    recursive: Option<bool>,
    #[serde(default)]
    max_entries: Option<usize>,
}

#[derive(Deserialize)]
struct DeleteFileParams {
    path: String,
    #[serde(default)]
    recursive: Option<bool>,
    #[serde(default, alias = "internalOperation")]
    internal_operation: Option<bool>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
}

#[derive(Deserialize)]
struct BootstrapFilesParams {
    files: Vec<String>,
}

#[derive(Deserialize)]
struct WriteFileParams {
    path: String,
    contents: String,
    #[serde(default, alias = "expectedUpdatedAt")]
    expected_updated_at: Option<String>,
    #[serde(default, alias = "internalOperation")]
    internal_operation: Option<bool>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
    #[serde(default, alias = "approvalFingerprint")]
    approval_fingerprint: Option<String>,
    #[serde(
        default,
        alias = "approvalSessionFingerprint",
        alias = "sessionFingerprint"
    )]
    approval_session_fingerprint: Option<String>,
}

#[derive(Deserialize)]
struct SkillNameParams {
    name: String,
}

#[derive(Deserialize)]
struct SkillCreateParams {
    body: Value,
}

#[derive(Deserialize)]
struct SkillUpdateParams {
    name: String,
    body: Value,
}

#[derive(Deserialize)]
struct ShellExecuteRequestParams {
    command: String,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    restrict_to_workspace: Option<bool>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
}

impl ShellExecuteRequestParams {
    fn into_shell_params(self) -> ShellExecuteParams {
        ShellExecuteParams {
            command: self.command,
            working_dir: self.working_dir,
            timeout: self.timeout,
            restrict_to_workspace: self.restrict_to_workspace,
        }
    }
}

#[derive(Deserialize)]
struct SessionIdParams {
    session_id: String,
}

#[derive(Deserialize)]
struct SessionHistoryParams {
    session_id: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct SessionCheckpointParams {
    session_id: String,
    checkpoint: Value,
}

#[derive(Deserialize)]
struct SessionPatchMetadataParams {
    session_id: String,
    metadata: Value,
}

#[derive(Deserialize)]
struct SessionPatchUserProfileParams {
    session_id: String,
    #[serde(alias = "userProfile")]
    user_profile: Value,
    metadata: Option<Value>,
}

#[derive(Deserialize)]
struct SessionTemporaryFileUploadParams {
    session_id: String,
    name: String,
    file_type: String,
    content: String,
    size_bytes: Option<u64>,
}

#[derive(Deserialize)]
struct SessionAppendMessagesParams {
    session_id: String,
    messages: Vec<Value>,
}

#[derive(Deserialize)]
struct SessionTaskProgressUpsertParams {
    session_id: String,
    plan_id: String,
    progress: Value,
    content: String,
}

#[derive(Deserialize)]
struct SessionTrimParams {
    session_id: String,
    keep_recent_messages: usize,
}

#[derive(Deserialize)]
struct SessionPersistTurnParams {
    session_id: String,
    run_id: String,
    messages: Vec<Value>,
    #[serde(default)]
    clear_checkpoint: bool,
    #[serde(default)]
    context_metadata: Option<Value>,
    #[serde(default, rename = "contextMetadata")]
    context_metadata_camel: Option<Value>,
}

impl SessionPersistTurnParams {
    fn context_metadata(&self) -> Option<Value> {
        self.context_metadata
            .clone()
            .or_else(|| self.context_metadata_camel.clone())
    }
}

#[derive(Deserialize)]
struct AgentRunUpsertParams {
    record: AgentRunRecord,
}

#[derive(Deserialize)]
struct AgentRunListParams {
    #[serde(alias = "sessionId")]
    session_id: String,
}

#[derive(Deserialize)]
struct AgentRunIdParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
}

#[derive(Deserialize)]
struct AgentRunListTraceParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct AgentRunAppendTraceParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    event: Value,
}

#[derive(Deserialize)]
struct AgentRunCheckpointParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    checkpoint: Value,
}

#[derive(Deserialize)]
struct AgentRunMarkCompletedParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    #[serde(alias = "stopReason")]
    stop_reason: String,
    #[serde(default, alias = "finalContent")]
    final_content: Option<String>,
}

#[derive(Deserialize)]
struct AgentRunMarkFailedParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    #[serde(alias = "stopReason")]
    stop_reason: String,
    error: Value,
}

#[derive(Deserialize)]
struct DiagnosticsAppendParams {
    stream: String,
    line: String,
}

#[derive(Deserialize)]
struct RagQueryParams {
    query: String,
    #[serde(default)]
    collection: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentListParams {
    session_key: String,
}

fn deserialize_workspace_read_format<'de, D>(
    deserializer: D,
) -> Result<Option<WorkspaceReadFormat>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(match value.as_deref() {
        None => None,
        Some("raw") => Some(WorkspaceReadFormat::Raw),
        Some("numbered_lines") => Some(WorkspaceReadFormat::NumberedLines),
        Some(other) => {
            return Err(serde::de::Error::custom(format!(
                "unsupported workspace read format: {other}"
            )));
        }
    })
}

fn enabled_skills_from_snapshot(snapshot: &Value) -> Option<Vec<String>> {
    snapshot
        .get("skills")
        .and_then(|value| value.get("enabled"))
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
}

fn serialization_error(error: serde_json::Error) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::WorkerError,
        "failed to serialize worker RPC result",
        serde_json::json!({ "error": error.to_string() }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn is_legacy_session_not_found_error(error: &WorkerProtocolError) -> bool {
    error.code == WorkerProtocolErrorCode::InvalidProtocol
        && error.message == "session metadata not found"
}

fn session_updated_sort_millis(value: &str) -> i128 {
    if let Some(rest) = value.strip_prefix("unix-ms:") {
        let digits = rest
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>();
        return digits.parse::<i128>().unwrap_or_default();
    }
    parse_utc_iso_millis(value).unwrap_or_default()
}

fn parse_utc_iso_millis(value: &str) -> Option<i128> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }

    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second_part = time_parts.next()?;
    if time_parts.next().is_some() {
        return None;
    }
    let (second, millis) = match second_part.split_once('.') {
        Some((second, fraction)) => {
            let mut millis = fraction.chars().take(3).collect::<String>();
            while millis.len() < 3 {
                millis.push('0');
            }
            (second.parse::<u32>().ok()?, millis.parse::<u32>().ok()?)
        }
        None => (second_part.parse::<u32>().ok()?, 0),
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let days = days_from_civil(year, month, day);
    Some(
        ((((days * 24) + hour as i128) * 60 + minute as i128) * 60 + second as i128) * 1000
            + millis as i128,
    )
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i128 {
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    i128::from(era * 146_097 + day_of_era - 719_468)
}

fn invalid_rag_request(message: impl Into<String>) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "rag.query" }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn unavailable_subagent_manager() -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::WorkerError,
        "subagent thread manager is unavailable",
        serde_json::json!({ "methodGroup": "subagent" }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn normalize_rag_collection(
    value: Option<String>,
) -> Result<Option<String>, crate::worker_protocol::WorkerProtocolError> {
    let Some(value) = value.map(|value| value.trim().replace('\\', "/")) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if value.starts_with('/')
        || value.contains(':')
        || value.contains('\0')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid_rag_request(
            "collection must be a workspace-relative prefix",
        ));
    }
    Ok(Some(value.trim_end_matches('/').to_string()))
}

fn is_rag_candidate_path(path: &str, collection: Option<&str>) -> bool {
    if let Some(collection) = collection {
        let prefix = format!("{collection}/");
        if path != collection && !path.starts_with(&prefix) {
            return false;
        }
    }
    let lower = path.to_ascii_lowercase();
    [
        ".md", ".mdx", ".txt", ".rst", ".adoc", ".json", ".toml", ".yaml", ".yml", ".ts", ".tsx",
        ".js", ".jsx", ".rs",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension))
}

fn rag_query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = query
        .split(|character: char| !character.is_alphanumeric())
        .map(|term| term.trim().to_ascii_lowercase())
        .filter(|term| term.len() > 2)
        .collect();
    terms.sort();
    terms.dedup();
    terms
}

fn merge_agent_run_records(
    primary_records: Vec<AgentRunRecord>,
    fallback_records: Vec<AgentRunRecord>,
) -> Vec<AgentRunRecord> {
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    for record in primary_records.into_iter().chain(fallback_records) {
        if seen.insert(record.run_id.clone()) {
            records.push(record);
        }
    }
    records.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    records
}

fn agent_run_with_thread(mut record: AgentRunRecord, thread: &ThreadRecord) -> AgentRunRecord {
    record.thread_id = Some(thread.thread_id.clone());
    record.parent_thread_id = thread.parent_thread_id.clone();
    if record.turn_id.is_none() {
        record.turn_id = thread
            .active_run_id
            .clone()
            .or_else(|| thread.root_run_id.clone());
    }
    record
}

fn checkpoint_run_id(checkpoint: &Value) -> Option<String> {
    checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn agent_run_from_session_metadata(
    session: &SessionMetadata,
    run_id: &str,
) -> Option<AgentRunRecord> {
    session
        .extra
        .get("agent_runs")
        .and_then(Value::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run.get("runId").and_then(Value::as_str) == Some(run_id))
        })
        .and_then(|run| serde_json::from_value::<AgentRunRecord>(run.clone()).ok())
}

fn rag_document_score(path: &str, contents: &str, terms: &[String]) -> usize {
    let haystack = format!("{path}\n{contents}").to_ascii_lowercase();
    terms
        .iter()
        .filter(|term| haystack.contains(term.as_str()))
        .count()
}

fn rag_document_title(path: &str, contents: &str) -> String {
    contents
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            trimmed
                .strip_prefix("# ")
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            path.rsplit('/')
                .next()
                .and_then(|name| name.split('.').next())
                .filter(|name| !name.is_empty())
                .unwrap_or(path)
                .to_string()
        })
}

fn rag_document_excerpt(contents: &str, terms: &[String]) -> String {
    contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            terms.iter().any(|term| lower.contains(term.as_str()))
        })
        .or_else(|| {
            contents
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
        })
        .unwrap_or("")
        .chars()
        .take(500)
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::WorkerRequest;
    use crate::worker_rpc::WorkerRpcRouter;
    use crate::worker_subagent_manager::{SubagentSpawnParams, SubagentThreadManager};
    use serde_json::{json, Value};
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static WORKSPACE_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn dispatches_workspace_read_file_request() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello router");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.read_file",
            json!({ "path": "notes/today.md" }),
        );

        let response = router.dispatch(&request);

        assert!(response.matches_request(&request));
        assert!(response.error.is_none());
        let result = response.result.expect("read result should be present");
        assert_eq!(result["path"], "notes/today.md");
        assert_eq!(result["contents"], "hello router");
        assert_eq!(result["content"], "hello router");
        assert_eq!(result["content_type"], "text");
        assert_eq!(result["line_start"], serde_json::Value::Null);
        assert_eq!(result["line_end"], serde_json::Value::Null);
        assert_eq!(result["line_total"], serde_json::Value::Null);
        assert_eq!(result["truncated"], false);
        assert!(result["updated_at"].is_string());
    }

    #[test]
    fn dispatches_workspace_write_file_version_conflict() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "current");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
                WorkerCapability::FsWorkspaceWrite,
            ]),
        );
        approve_once(
            &mut router,
            "run-write-conflict",
            "session-1",
            json!({
                "toolName": "write_file",
                "arguments": { "path": "notes/today.md" }
            }),
            "filesystem_write",
            "medium",
            "File write/edit/delete tools can modify workspace state.",
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "stale",
                "session_id": "session-1",
                "expected_updated_at": "2000-01-01T00:00:00+00:00"
            }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("stale write should conflict");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.message, "version conflict");
        assert_eq!(error.details["path"], "notes/today.md");
        assert!(error.details["updated_at"].is_string());
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("notes").join("today.md"))
                .expect("fixture file should still read"),
            "current"
        );
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_workspace_create_dir_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-create-dir",
            "trace-1",
            "workspace.create_dir",
            json!({ "path": "skills/planner/scripts" }),
        ));

        assert_eq!(
            response.result,
            Some(json!({ "path": "skills/planner/scripts", "kind": "dir", "created": true }))
        );
        assert!(fixture
            .root
            .join("skills")
            .join("planner")
            .join("scripts")
            .is_dir());
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_skills_list_request_with_workspace_precedence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "skills/planner/SKILL.md",
            "---\nname: planner\ndescription: Workspace planner\n---\nWorkspace body",
        );
        fixture.write(
            "builtin-skills/planner/SKILL.md",
            "---\nname: planner\ndescription: Builtin planner\n---\nBuiltin body",
        );
        fixture.write(
            "builtin-skills/tmux/SKILL.md",
            "---\nname: tmux\ndescription: Terminal sessions\n---\nTmux body",
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new("req-1", "trace-1", "skills.list", json!({}));

        let response = router.dispatch(&request);

        assert!(response.matches_request(&request));
        assert!(response.error.is_none());
        assert_eq!(
            response.result,
            Some(json!({
                "skills": [
                    {
                        "name": "planner",
                        "path": "skills/planner/SKILL.md",
                        "source": "workspace",
                        "content": "---\nname: planner\ndescription: Workspace planner\n---\nWorkspace body"
                    },
                    {
                        "name": "tmux",
                        "path": "builtin-skills/tmux/SKILL.md",
                        "source": "builtin",
                        "content": "---\nname: tmux\ndescription: Terminal sessions\n---\nTmux body"
                    }
                ]
            }))
        );
    }

    #[test]
    fn dispatch_returns_capability_error_response() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello router");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.read_file",
            json!({ "path": "notes/today.md" }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "fs.workspace.read");
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatch_rejects_unknown_method() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new("req-1", "trace-1", "shell.execute", json!({}));

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.details["method"], "shell.execute");
    }

    #[test]
    fn dispatch_rejects_invalid_params() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.read_file",
            json!({ "missing_path": "notes/today.md" }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.details["method"], "workspace.read_file");
    }

    #[test]
    fn dispatches_config_get_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ConfigRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "config.get",
            json!({ "path": "agents.defaults.model" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({ "path": "agents.defaults.model", "value": "gpt-5" }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_config_snapshot_public_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({
                "providers": {
                    "openai": {
                        "provider": "openai",
                        "api_key": "sk-secret"
                    }
                }
            }),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ConfigRead]),
        );
        let request = WorkerRequest::new("req-1", "trace-1", "config.snapshot_public", json!({}));

        let response = router.dispatch(&request);

        let provider = response.result.as_ref().unwrap()["value"]["providers"]["openai"]
            .as_object()
            .expect("provider public config should be an object");
        assert!(!provider.contains_key("api_key"));
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_config_apply_patch_result_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({
                "agents": { "defaults": { "model": "gpt-5" } },
                "providers": { "openai": { "apiKey": "sk-old-secret" } }
            }),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ConfigRead,
                WorkerCapability::ConfigWrite,
                WorkerCapability::ProviderSecretRead,
            ]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "config.apply_patch_result",
            json!({
                "ok": true,
                "config": {
                    "agents": { "defaults": { "model": "gpt-5.1" } },
                    "providers": { "openai": { "apiKey": "sk-new-secret" } }
                },
                "updatedFields": ["agents.defaults.model"],
                "sideEffects": {
                    "applied": ["providerRuntimeChanged"],
                    "restartRequired": [],
                    "warnings": []
                },
                "error": null
            }),
        );

        let response = router.dispatch(&request);

        let result = response.result.expect("patch result should return");
        assert_eq!(result["ok"], true);
        assert_eq!(result["updatedFields"], json!(["agents.defaults.model"]));
        assert_eq!(
            result["sideEffects"]["applied"],
            json!(["providerRuntimeChanged"])
        );
        assert_eq!(result["config"]["agents"]["defaults"]["model"], "gpt-5.1");
        assert!(result
            .get("config")
            .and_then(|config| config.get("providers"))
            .and_then(|providers| providers.get("openai"))
            .and_then(|provider| provider.get("apiKey"))
            .is_none());
        assert!(response.error.is_none());

        let get_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-2",
            "config.get",
            json!({ "path": "agents.defaults.model" }),
        ));
        assert_eq!(
            get_response.result,
            Some(json!({ "path": "agents.defaults.model", "value": "gpt-5.1" }))
        );

        let secret_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-3",
            "provider.resolve_secret",
            json!({ "providerId": "openai", "apiKeyEnvVars": ["OPENAI_API_KEY"] }),
        ));
        assert_eq!(
            secret_response.result,
            Some(json!({
                "apiKey": "sk-new-secret",
                "apiKeySource": "config"
            }))
        );
        assert!(secret_response.error.is_none());
    }

    #[test]
    fn dispatches_config_apply_patch_result_to_config_store() {
        let fixture = WorkspaceFixture::new();
        let config_path = fixture.root.join("tinybot-config.json");
        let store = crate::config_store::ConfigStore::from_snapshot(
            config_path.clone(),
            json!({
                "agents": { "defaults": { "model": "gpt-5" } },
                "providers": { "openai": { "apiKey": "sk-old-secret" } }
            }),
        );
        let mut router = WorkerRpcRouter::with_config_store(
            fixture.root.clone(),
            store,
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ConfigRead, WorkerCapability::ConfigWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "config.apply_patch_result",
            json!({
                "ok": true,
                "config": {
                    "agents": { "defaults": { "model": "gpt-5.2" } },
                    "providers": { "openai": { "apiKey": "sk-new-secret" } }
                },
                "updatedFields": ["agents.defaults.model"],
                "sideEffects": {
                    "applied": ["providerRuntimeChanged"],
                    "restartRequired": [],
                    "warnings": []
                },
                "error": null
            }),
        ));

        let result = response.result.expect("stored patch result should return");
        assert_eq!(result["ok"], true);
        assert_eq!(result["config"]["agents"]["defaults"]["model"], "gpt-5.2");
        assert!(result
            .get("config")
            .and_then(|config| config.get("providers"))
            .and_then(|providers| providers.get("openai"))
            .and_then(|provider| provider.get("apiKey"))
            .is_none());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(config_path).expect("patched config should save")
            )
            .expect("saved config should be JSON"),
            json!({
                "agents": { "defaults": { "model": "gpt-5.2" } },
                "providers": { "openai": { "apiKey": "sk-new-secret" } }
            })
        );

        let get_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-2",
            "config.get",
            json!({ "path": "agents.defaults.model" }),
        ));
        assert_eq!(
            get_response.result,
            Some(json!({ "path": "agents.defaults.model", "value": "gpt-5.2" }))
        );
    }

    #[test]
    fn dispatches_config_apply_operations_to_config_store() {
        let fixture = WorkspaceFixture::new();
        let config_path = fixture.root.join("tinybot-config.json");
        let mut store = crate::config_store::ConfigStore::from_snapshot(
            config_path.clone(),
            json!({
                "agents": { "defaults": { "model": "gpt-5", "timezone": "UTC" } },
                "providers": { "openai": { "api_key": "sk-old-secret" } }
            }),
        );
        store
            .save_snapshot()
            .expect("fixture config should be saved before operation dispatch");
        let revision = store.revision();
        let mut router = WorkerRpcRouter::with_config_store(
            fixture.root.clone(),
            store,
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ConfigRead, WorkerCapability::ConfigWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "config.apply_operations",
            json!({
                "expectedRevision": revision,
                "operations": [
                    {
                        "op": "replace",
                        "path": "agents.defaults.timezone",
                        "value": "Asia/Shanghai"
                    }
                ]
            }),
        ));

        let result = response.result.expect("operation result should return");
        assert_eq!(result["ok"], true);
        assert_eq!(result["updatedFields"], json!(["agents.defaults.timezone"]));
        assert_eq!(
            result["config"]["providers"]["openai"]["api_key_configured"],
            true
        );
        assert!(result["config"]["providers"]["openai"]
            .get("api_key")
            .is_none());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(config_path).expect("patched config should save")
            )
            .expect("saved config should be JSON")["providers"]["openai"]["api_key"],
            "sk-old-secret"
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn config_store_patch_result_requires_write_capability_before_save() {
        let fixture = WorkspaceFixture::new();
        let config_path = fixture.root.join("tinybot-config.json");
        let store = crate::config_store::ConfigStore::from_snapshot(
            config_path.clone(),
            json!({
                "agents": { "defaults": { "model": "gpt-5" } }
            }),
        );
        let mut router = WorkerRpcRouter::with_config_store(
            fixture.root.clone(),
            store,
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ConfigRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "config.apply_patch_result",
            json!({
                "ok": true,
                "config": {
                    "agents": { "defaults": { "model": "gpt-5.2" } }
                },
                "updatedFields": ["agents.defaults.model"],
                "sideEffects": {
                    "applied": ["providerRuntimeChanged"],
                    "restartRequired": [],
                    "warnings": []
                },
                "error": null
            }),
        ));

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "config.write");
        assert!(
            !config_path.exists(),
            "denied config patch must not create or save config"
        );
    }

    #[test]
    fn dispatches_provider_resolve_secret_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({
                "providers": {
                    "profiles": {
                        "dashscope-search": {
                            "provider": "dashscope",
                            "api_key": "profile-secret"
                        }
                    }
                }
            }),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ProviderSecretRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "provider.resolve_secret",
            json!({
                "providerId": "dashscope",
                "profileName": "dashscope-search",
                "apiKeyEnvVars": ["DASHSCOPE_API_KEY"]
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "apiKey": "profile-secret",
                "apiKeySource": "config"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_get_metadata_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.get_metadata",
            json!({ "session_id": "session-1" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(response.result.as_ref().unwrap()["session_id"], "session-1");
        assert_eq!(
            response.result.as_ref().unwrap()["title"],
            "Native Core Migration"
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_list_metadata_includes_thread_only_sessions() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let create = router.dispatch(&WorkerRequest::new(
            "req-session-list-thread-create",
            "trace-session-list-thread",
            "thread.create",
            json!({
                "threadId": "thread-only-session",
                "title": "Thread Only Session",
                "sessionKey": "thread-session-1",
                "metadata": {
                    "workingDirectory": "D:/code/tinybot/workspace",
                    "lastActivityAt": "2026-07-05T03:00:00Z",
                    "preview": "Thread-only preview"
                },
                "source": "user"
            }),
        ));
        assert_eq!(create.error, None);

        let response = router.dispatch(&WorkerRequest::new(
            "req-session-list-thread",
            "trace-session-list-thread",
            "session.list_metadata",
            json!({}),
        ));

        assert_eq!(response.error, None);
        let sessions = response.result.as_ref().unwrap().as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["session_id"], "thread-session-1");
        assert_eq!(sessions[0]["title"], "Thread Only Session");
        assert_eq!(sessions[0]["workspace_dir"], "D:/code/tinybot/workspace");
        assert_eq!(sessions[0]["updated_at"], "2026-07-05T03:00:00Z");
        assert_eq!(sessions[0]["extra"]["threadId"], "thread-only-session");
        assert_eq!(sessions[0]["extra"]["source"], "thread.metadata_projection");
        assert_eq!(sessions[1]["session_id"], "session-1");
    }

    #[test]
    fn dispatches_thread_status_for_legacy_session_projection() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        );

        let list = router.dispatch(&WorkerRequest::new(
            "req-legacy-status-list",
            "trace-legacy-status",
            "thread.list",
            json!({}),
        ));
        assert_eq!(list.error, None);
        let projected_thread_id = list.result.as_ref().unwrap()["threads"][0]["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let status = router.dispatch(&WorkerRequest::new(
            "req-legacy-status",
            "trace-legacy-status",
            "thread.status",
            json!({ "threadId": projected_thread_id }),
        ));

        assert_eq!(status.error, None);
        assert_eq!(
            status.result.as_ref().unwrap()["thread"]["sessionKey"],
            "session-1"
        );
        assert_eq!(
            status.result.as_ref().unwrap()["thread"]["source"],
            "legacy_session_projection"
        );
        assert_eq!(status.result.as_ref().unwrap()["children"], json!([]));
    }

    #[test]
    fn dispatches_session_get_metadata_and_history_for_thread_only_sessions() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let create = router.dispatch(&WorkerRequest::new(
            "req-session-get-thread-create",
            "trace-session-get-thread",
            "thread.create",
            json!({
                "threadId": "thread-backed-session",
                "title": "Thread Backed Session",
                "sessionKey": "thread-backed-session-key",
                "metadata": {
                    "workingDirectory": "D:/code/tinybot/thread",
                    "lastActivityAt": "2026-07-05T04:00:00Z"
                },
                "source": "user"
            }),
        ));
        assert_eq!(create.error, None);

        let append = router.dispatch(&WorkerRequest::new(
            "req-session-get-thread-append",
            "trace-session-get-thread",
            "thread.append_items",
            json!({
                "threadId": "thread-backed-session",
                "items": [
                    {
                        "itemId": "thread-backed-session:item:user",
                        "threadId": "",
                        "runId": "run-thread-backed",
                        "turnId": "turn-thread-backed",
                        "sequence": 0,
                        "createdAt": "2026-07-05T04:00:01Z",
                        "kind": {
                            "type": "user_message",
                            "payload": { "content": "old UI opens thread-backed session" }
                        }
                    },
                    {
                        "itemId": "thread-backed-session:item:assistant",
                        "threadId": "",
                        "runId": "run-thread-backed",
                        "turnId": "turn-thread-backed",
                        "sequence": 0,
                        "createdAt": "2026-07-05T04:00:02Z",
                        "kind": {
                            "type": "assistant_message_completed",
                            "payload": { "content": "thread history is projected" }
                        }
                    }
                ]
            }),
        ));
        assert_eq!(append.error, None);

        let metadata = router.dispatch(&WorkerRequest::new(
            "req-session-get-thread-metadata",
            "trace-session-get-thread",
            "session.get_metadata",
            json!({ "session_id": "thread-backed-session-key" }),
        ));
        assert_eq!(metadata.error, None);
        assert_eq!(
            metadata.result.as_ref().unwrap()["session_id"],
            "thread-backed-session-key"
        );
        assert_eq!(
            metadata.result.as_ref().unwrap()["title"],
            "Thread Backed Session"
        );
        assert_eq!(
            metadata.result.as_ref().unwrap()["extra"]["threadId"],
            "thread-backed-session"
        );

        let history = router.dispatch(&WorkerRequest::new(
            "req-session-get-thread-history",
            "trace-session-get-thread",
            "session.get_history",
            json!({ "session_id": "thread-backed-session-key" }),
        ));
        assert_eq!(history.error, None);
        assert_eq!(
            history.result.as_ref().unwrap()["session_id"],
            "thread-backed-session-key"
        );
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][0]["role"],
            "user"
        );
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][0]["content"],
            "old UI opens thread-backed session"
        );
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][1]["role"],
            "assistant"
        );
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][1]["content"],
            "thread history is projected"
        );
        assert_eq!(
            history.result.as_ref().unwrap()["updated_at"],
            "2026-07-05T04:00:02Z"
        );
    }

    #[test]
    fn dispatches_session_get_history_reads_thread_tail() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let create = router.dispatch(&WorkerRequest::new(
            "req-session-tail-thread-create",
            "trace-session-tail-thread",
            "thread.create",
            json!({
                "threadId": "thread-tail-history",
                "title": "Tail History",
                "sessionKey": "thread-tail-session",
                "source": "user"
            }),
        ));
        assert_eq!(create.error, None);

        let items = (0..205)
            .map(|index| {
                json!({
                    "itemId": format!("thread-tail-history:item:{index}"),
                    "threadId": "",
                    "runId": "run-thread-tail",
                    "turnId": "turn-thread-tail",
                    "sequence": 0,
                    "createdAt": format!("2026-07-05T05:{:02}:{:02}Z", index / 60, index % 60),
                    "kind": {
                        "type": "user_message",
                        "payload": { "content": format!("message-{index}") }
                    }
                })
            })
            .collect::<Vec<_>>();
        let append = router.dispatch(&WorkerRequest::new(
            "req-session-tail-thread-append",
            "trace-session-tail-thread",
            "thread.append_items",
            json!({
                "threadId": "thread-tail-history",
                "items": items
            }),
        ));
        assert_eq!(append.error, None);

        let history = router.dispatch(&WorkerRequest::new(
            "req-session-tail-history",
            "trace-session-tail-thread",
            "session.get_history",
            json!({ "session_id": "thread-tail-session", "limit": 2 }),
        ));

        assert_eq!(history.error, None);
        assert_eq!(
            history.result.as_ref().unwrap()["messages"],
            json!([
                {
                    "role": "user",
                    "content": "message-203",
                    "timestamp": "2026-07-05T05:03:23Z"
                },
                {
                    "role": "user",
                    "content": "message-204",
                    "timestamp": "2026-07-05T05:03:24Z"
                }
            ])
        );
    }

    #[test]
    fn dispatches_session_get_history_projects_thread_message_metadata_and_usage() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let create = router.dispatch(&WorkerRequest::new(
            "req-session-rich-thread-create",
            "trace-session-rich-thread",
            "thread.create",
            json!({
                "threadId": "thread-rich-history",
                "title": "Rich History",
                "sessionKey": "thread-rich-session",
                "source": "user"
            }),
        ));
        assert_eq!(create.error, None);

        let append = router.dispatch(&WorkerRequest::new(
            "req-session-rich-thread-append",
            "trace-session-rich-thread",
            "thread.append_items",
            json!({
                "threadId": "thread-rich-history",
                "items": [
                    {
                        "itemId": "thread-rich-history:user",
                        "threadId": "",
                        "runId": "run-rich-history",
                        "turnId": "turn-rich-history",
                        "sequence": 0,
                        "createdAt": "2026-07-05T06:00:01Z",
                        "kind": {
                            "type": "user_message",
                            "payload": {
                                "messageId": "user-rich",
                                "content": "load rich history"
                            }
                        }
                    },
                    {
                        "itemId": "thread-rich-history:assistant",
                        "threadId": "",
                        "runId": "run-rich-history",
                        "turnId": "turn-rich-history",
                        "sequence": 0,
                        "createdAt": "2026-07-05T06:00:02Z",
                        "kind": {
                            "type": "assistant_message_completed",
                            "payload": {
                                "messageId": "assistant-rich",
                                "content": "rich history loaded",
                                "references": [{ "id": "ref-1", "kind": "memory", "title": "Memory" }],
                                "metadata": { "finishReason": "stop" }
                            }
                        }
                    },
                    {
                        "itemId": "thread-rich-history:terminal",
                        "threadId": "",
                        "runId": "run-rich-history",
                        "turnId": "turn-rich-history",
                        "sequence": 0,
                        "createdAt": "2026-07-05T06:00:03Z",
                        "kind": {
                            "type": "agent_run_completed",
                            "payload": {
                                "runId": "run-rich-history",
                                "tokenUsageInfo": {
                                    "totalTokenUsage": {
                                        "inputTokens": 0,
                                        "cachedInputTokens": 0,
                                        "outputTokens": 0,
                                        "reasoningOutputTokens": 0,
                                        "totalTokens": 172
                                    },
                                    "lastTokenUsage": {
                                        "inputTokens": 10,
                                        "cachedInputTokens": 0,
                                        "outputTokens": 162,
                                        "reasoningOutputTokens": 41,
                                        "totalTokens": 172
                                    },
                                    "modelContextWindow": 128000
                                }
                            }
                        }
                    }
                ]
            }),
        ));
        assert_eq!(append.error, None);

        let history = router.dispatch(&WorkerRequest::new(
            "req-session-rich-history",
            "trace-session-rich-thread",
            "session.get_history",
            json!({ "session_id": "thread-rich-session" }),
        ));

        assert_eq!(history.error, None);
        let messages = &history.result.as_ref().unwrap()["messages"];
        assert_eq!(messages[0]["messageId"], "user-rich");
        assert_eq!(messages[1]["messageId"], "assistant-rich");
        assert_eq!(messages[1]["references"][0]["id"], "ref-1");
        assert_eq!(messages[1]["metadata"]["finishReason"], "stop");
        assert_eq!(messages[1]["usage"]["contextWindowTokens"], 128000);
        assert_eq!(messages[1]["usage"]["contextWindowUsedTokens"], 172);
        assert_eq!(messages[1]["usage"]["totalTokens"], 172);
        assert_eq!(messages[1]["usage"]["completionTokens"], 162);
    }

    #[test]
    fn dispatches_session_get_history_request() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "second" }
            ],
            "user_profile": { "name": "Ada" }
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.get_history",
            json!({ "session_id": "session-1", "limit": 1 }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "session_id": "session-1",
                "messages": [{ "role": "assistant", "content": "second" }],
                "user_profile": { "name": "Ada" },
                "updated_at": "2026-06-09T09:30:00Z"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_get_history_projects_empty_thread_when_writable() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "second" }
            ],
            "user_profile": { "name": "Ada" }
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let response = router.dispatch(&WorkerRequest::new(
            "req-session-history-project",
            "trace-history-project",
            "session.get_history",
            json!({ "session_id": "session-1", "limit": 80 }),
        ));
        assert_eq!(response.error, None);
        assert_eq!(
            response.result.as_ref().unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let thread_list = router.dispatch(&WorkerRequest::new(
            "req-thread-list-after-history",
            "trace-history-project",
            "thread.list",
            json!({ "includeArchived": true }),
        ));
        assert_eq!(thread_list.error, None);
        let thread_id = thread_list.result.as_ref().unwrap()["threads"][0]["threadId"]
            .as_str()
            .expect("history projection should create a thread")
            .to_string();

        let thread_read = router.dispatch(&WorkerRequest::new(
            "req-thread-read-after-history",
            "trace-history-project",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(thread_read.error, None);
        let item_kinds = thread_read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec!["user_message", "assistant_message_completed"]
        );
    }

    #[test]
    fn dispatches_session_delete_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );
        let create_thread = router.dispatch(&WorkerRequest::new(
            "req-thread-before-session-delete",
            "trace-1",
            "thread.create",
            json!({
                "title": "Linked session",
                "sessionKey": "session-1"
            }),
        ));
        assert_eq!(create_thread.error, None);
        let thread_id = create_thread.result.as_ref().unwrap()["threadId"]
            .as_str()
            .expect("thread id should be present")
            .to_string();
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.delete",
            json!({ "session_id": "session-1" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "session_id": "session-1",
                "deleted": true
            }))
        );
        assert!(response.error.is_none());

        let thread_list = router.dispatch(&WorkerRequest::new(
            "req-thread-after-session-delete",
            "trace-1",
            "thread.list",
            json!({ "includeArchived": true }),
        ));
        assert_eq!(thread_list.error, None);
        let thread = &thread_list.result.as_ref().unwrap()["threads"][0];
        assert_eq!(thread["threadId"], thread_id);
        assert_eq!(thread["status"], "archived");
    }

    #[test]
    fn dispatches_session_patch_metadata_request() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.extra = json!({ "metadata": { "pinned": false, "topic": "old" } });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.patch_metadata",
            json!({
                "session_id": "session-1",
                "metadata": { "pinned": true, "title": "Patched title" }
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result.as_ref().unwrap()["extra"]["metadata"],
            json!({
                "pinned": true,
                "title": "Patched title",
                "topic": "old"
            })
        );
        assert_eq!(response.result.as_ref().unwrap()["title"], "Patched title");
        assert!(response.error.is_none());

        let thread_list = router.dispatch(&WorkerRequest::new(
            "req-thread-after-session-patch",
            "trace-1",
            "thread.list",
            json!({ "includeArchived": true }),
        ));
        assert_eq!(thread_list.error, None);
        let thread = &thread_list.result.as_ref().unwrap()["threads"][0];
        assert_eq!(thread["sessionKey"], "session-1");
        assert_eq!(thread["title"], "Patched title");
        assert_eq!(
            thread["metadata"]["extra"]["metadata"],
            json!({
                "pinned": true,
                "title": "Patched title",
                "topic": "old"
            })
        );
    }

    #[test]
    fn dispatches_session_patch_user_profile_request() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.extra = json!({
            "user_profile": { "name": "Ada", "preferences": ["short answers"] },
            "metadata": { "entity_extractor_last_turn_hash": "old-hash", "topic": "native" }
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.patch_user_profile",
            json!({
                "session_id": "session-1",
                "user_profile": {
                    "name": "Ada",
                    "preferences": ["short answers", "code examples"]
                },
                "metadata": { "entity_extractor_last_turn_hash": "new-hash" }
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result.as_ref().unwrap()["extra"]["user_profile"],
            json!({
                "name": "Ada",
                "preferences": ["short answers", "code examples"]
            })
        );
        assert_eq!(
            response.result.as_ref().unwrap()["extra"]["metadata"],
            json!({
                "entity_extractor_last_turn_hash": "new-hash",
                "topic": "native"
            })
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_workspace_read_bootstrap_files_request() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agent rules");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.read_bootstrap_files",
            json!({ "files": ["AGENTS.md", "TOOLS.md"] }),
        );

        let response = router.dispatch(&request);

        let result = response.result.expect("bootstrap result should be present");
        assert_eq!(result["missing"], json!(["TOOLS.md"]));
        let files = result["files"]
            .as_array()
            .expect("files should be an array");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "AGENTS.md");
        assert_eq!(files[0]["contents"], "agent rules");
        assert!(files[0]["updated_at"].is_string());
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_checkpoint_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );
        let set_request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.set_checkpoint",
            json!({
                "session_id": "session-1",
                "checkpoint": {
                    "phase": "awaiting_tools",
                    "runId": "run-session-checkpoint",
                    "checkpointId": "checkpoint-session-route"
                }
            }),
        );
        let clear_request = WorkerRequest::new(
            "req-2",
            "trace-1",
            "session.clear_checkpoint",
            json!({ "session_id": "session-1" }),
        );

        let set_response = router.dispatch(&set_request);
        let thread_list = router.dispatch(&WorkerRequest::new(
            "req-session-checkpoint-thread-list",
            "trace-1",
            "thread.list",
            json!({ "includeArchived": true }),
        ));
        let thread_id = thread_list.result.as_ref().unwrap()["threads"][0]["threadId"]
            .as_str()
            .unwrap()
            .to_string();
        let thread_read = router.dispatch(&WorkerRequest::new(
            "req-session-checkpoint-thread-read",
            "trace-1",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        let clear_response = router.dispatch(&clear_request);

        assert_eq!(
            set_response.result.as_ref().unwrap()["extra"]["runtime_checkpoint"],
            json!({
                "phase": "awaiting_tools",
                "runId": "run-session-checkpoint",
                "checkpointId": "checkpoint-session-route"
            })
        );
        assert_eq!(thread_list.error, None);
        assert_eq!(
            thread_read.result.as_ref().unwrap()["latestCheckpoint"]["checkpointId"],
            "checkpoint-session-route"
        );
        assert_eq!(
            thread_read.result.as_ref().unwrap()["latestCheckpoint"]["runId"],
            "run-session-checkpoint"
        );
        assert!(thread_read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"]["type"] == "checkpoint_created"));
        assert!(clear_response.result.as_ref().unwrap()["extra"]
            .get("runtime_checkpoint")
            .is_none());
        assert!(set_response.error.is_none());
        assert!(clear_response.error.is_none());
    }

    #[test]
    fn dispatches_session_get_checkpoint_request() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.extra = json!({
            "runtime_checkpoint": {
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.get_checkpoint",
            json!({ "session_id": "session-1" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_missing_session_checkpoint_as_null() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.get_checkpoint",
            json!({ "session_id": "desktop-session-1" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(response.result, Some(json!(null)));
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_append_messages_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.append_messages",
            json!({
                "session_id": "session-1",
                "messages": [
                    { "role": "user", "content": "hello" },
                    { "role": "assistant", "content": "done" }
                ]
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result.as_ref().unwrap()["extra"]["messages"],
            json!([
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ])
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_clear_request() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "runtime_checkpoint": { "phase": "awaiting_tools" },
            "user_profile": { "name": "Ada" },
            "last_consolidated": 1
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.clear",
            json!({ "session_id": "session-1" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result.as_ref().unwrap()["messages_before"],
            json!(2)
        );
        assert_eq!(
            response.result.as_ref().unwrap()["messages_after"],
            json!(0)
        );
        assert_eq!(
            response.result.as_ref().unwrap()["checkpoint_cleared"],
            json!(true)
        );
        assert_eq!(
            response.result.as_ref().unwrap()["session"]["extra"]["messages"],
            json!([])
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_trim_request() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "old" },
                { "role": "assistant", "content": "old answer" },
                { "role": "user", "content": "recent" },
                { "role": "assistant", "content": "recent answer" }
            ],
            "last_consolidated": 1
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.trim",
            json!({ "session_id": "session-1", "keep_recent_messages": 1 }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result.as_ref().unwrap()["messages_before"],
            json!(4)
        );
        assert_eq!(
            response.result.as_ref().unwrap()["messages_after"],
            json!(2)
        );
        assert_eq!(
            response.result.as_ref().unwrap()["session"]["extra"]["messages"],
            json!([
                { "role": "user", "content": "recent" },
                { "role": "assistant", "content": "recent answer" }
            ])
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_session_persist_turn_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.persist_turn",
            json!({
                "session_id": "session-1",
                "run_id": "run-1",
                "messages": [
                    { "role": "user", "content": "hello" },
                    { "role": "assistant", "content": "done" }
                ],
                "clear_checkpoint": true,
                "contextMetadata": {
                    "historyMessageCount": 1,
                    "bridge": {
                        "missingSession": false
                    }
                },
                "context_metadata": {
                    "historyMessageCount": 1,
                    "bridge": {
                        "missingSession": false
                    }
                }
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "session_id": "session-1",
                "messages_before": 0,
                "messages_after": 2,
                "saved_message_count": 2,
                "saved_messages": [
                    { "role": "user", "content": "hello" },
                    { "role": "assistant", "content": "done" }
                ],
                "checkpoint_cleared": false,
                "duplicate_message_count": 0,
                "truncated_tool_result_count": 0,
                "omitted_side_effects": [
                    "conversation_evidence",
                    "memory_extraction",
                    "consolidation",
                    "user_profile_update"
                ]
            }))
        );
        assert!(response.error.is_none());

        let history = router.dispatch(&WorkerRequest::new(
            "req-session-persist-history",
            "trace-1",
            "session.get_history",
            json!({ "session_id": "session-1", "limit": 80 }),
        ));
        assert_eq!(history.error, None);
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][0]["content"],
            "hello"
        );
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][1]["content"],
            "done"
        );
    }

    #[test]
    fn persists_session_turn_to_thread_log() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();

        let persist = router.dispatch(&WorkerRequest::new(
            "req-thread-log-persist",
            "trace-thread-log-persist",
            "session.persist_turn",
            json!({
                "session_id": "session-thread-log-1",
                "run_id": "run-1",
                "messages": [
                    { "role": "user", "content": "hello", "messageId": "user-1" },
                    { "role": "assistant", "content": "hi", "messageId": "assistant-1" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);

        let history = router.dispatch(&WorkerRequest::new(
            "req-thread-log-history",
            "trace-thread-log-history",
            "session.get_history",
            json!({ "session_id": "session-thread-log-1", "limit": 80 }),
        ));

        assert_eq!(history.error, None);
        let messages = &history.result.as_ref().unwrap()["messages"];
        assert_eq!(messages.as_array().unwrap().len(), 2);
        assert_eq!(messages[0]["messageId"], "user-1");
        assert_eq!(messages[1]["messageId"], "assistant-1");
    }

    #[test]
    fn session_persist_turn_does_not_write_legacy_session_or_thread_stores() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();

        let persist = router.dispatch(&WorkerRequest::new(
            "req-thread-log-only-persist",
            "trace-thread-log-only-persist",
            "session.persist_turn",
            json!({
                "session_id": "session-thread-log-only",
                "run_id": "run-thread-log-only",
                "messages": [
                    { "role": "user", "content": "canonical only" },
                    { "role": "assistant", "content": "saved in thread log" }
                ],
                "clear_checkpoint": false
            }),
        ));

        assert_eq!(persist.error, None);
        assert!(fixture
            .root
            .join(".tinybot")
            .join("state")
            .join("state.sqlite")
            .exists());
        assert!(!fixture
            .root
            .join("sessions")
            .join("sessions.sqlite")
            .exists());
        assert!(!fixture
            .root
            .join(".tinybot")
            .join("threads")
            .join("threads.sqlite")
            .exists());
    }

    #[test]
    fn persists_thread_log_token_count_and_replays_usage() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();

        let persist = router.dispatch(&WorkerRequest::new(
            "req-token-count-persist",
            "trace-token-count-persist",
            "session.persist_turn",
            json!({
                "session_id": "session-token-count",
                "run_id": "run-token-count",
                "messages": [
                    { "role": "user", "content": "hello", "messageId": "user-token" },
                    { "role": "assistant", "content": "hi", "messageId": "assistant-token" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);

        router
            .thread_log
            .append_token_count(
                "session-token-count",
                crate::worker_thread_log::TokenUsageInfo {
                    total_token_usage: crate::worker_thread_log::TokenUsage {
                        input_tokens: 1010,
                        cached_input_tokens: 0,
                        output_tokens: 162,
                        reasoning_output_tokens: 0,
                        total_tokens: 1172,
                    },
                    last_token_usage: crate::worker_thread_log::TokenUsage {
                        input_tokens: 10,
                        cached_input_tokens: 0,
                        output_tokens: 162,
                        reasoning_output_tokens: 0,
                        total_tokens: 172,
                    },
                    model_context_window: Some(128000),
                },
            )
            .unwrap();

        let history = router.dispatch(&WorkerRequest::new(
            "req-token-count-history",
            "trace-token-count-history",
            "session.get_history",
            json!({ "session_id": "session-token-count", "limit": 80 }),
        ));

        assert_eq!(history.error, None);
        let assistant = &history.result.as_ref().unwrap()["messages"][1];
        assert_eq!(assistant["usage"]["contextWindowUsedTokens"], 172);
        assert_eq!(assistant["usage"]["contextWindowTokens"], 128000);
        assert_eq!(assistant["usage"]["totalTokens"], 172);
        assert_eq!(
            assistant["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            172
        );

        let list = router.dispatch(&WorkerRequest::new(
            "req-token-count-list",
            "trace-token-count-history",
            "session.list_metadata",
            json!({}),
        ));
        assert_eq!(list.error, None);
        assert_eq!(
            list.result.as_ref().unwrap()[0]["extra"]["tokensUsed"],
            1172
        );
    }

    #[test]
    fn thread_log_history_survives_router_restart() {
        let fixture = WorkspaceFixture::new();
        {
            let mut router = WorkerRpcRouter::new_persistent_sessions(
                fixture.root.clone(),
                json!({}),
                vec![],
                50,
                CapabilityPolicy::new([
                    WorkerCapability::SessionWrite,
                    WorkerCapability::SessionMetadataRead,
                ]),
            )
            .unwrap();
            let persist = router.dispatch(&WorkerRequest::new(
                "req-restart-persist",
                "trace-restart-persist",
                "session.persist_turn",
                json!({
                    "session_id": "session-restart",
                    "run_id": "run-restart",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-restart" },
                        { "role": "assistant", "content": "persisted", "messageId": "assistant-restart" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
            assert_eq!(persist.error, None);
        }

        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let history = router.dispatch(&WorkerRequest::new(
            "req-restart-history",
            "trace-restart-history",
            "session.get_history",
            json!({ "session_id": "session-restart", "limit": 80 }),
        ));

        assert_eq!(history.error, None);
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][1]["messageId"],
            "assistant-restart"
        );
    }

    #[test]
    fn thread_log_history_rebuilds_missing_state_index_from_jsonl() {
        let fixture = WorkspaceFixture::new();
        {
            let mut router = WorkerRpcRouter::new_persistent_sessions(
                fixture.root.clone(),
                json!({}),
                vec![],
                50,
                CapabilityPolicy::new([
                    WorkerCapability::SessionWrite,
                    WorkerCapability::SessionMetadataRead,
                ]),
            )
            .unwrap();
            let persist = router.dispatch(&WorkerRequest::new(
                "req-rebuild-state-persist",
                "trace-rebuild-state",
                "session.persist_turn",
                json!({
                    "session_id": "session-rebuild-state",
                    "run_id": "run-rebuild-state",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-rebuild" },
                        { "role": "assistant", "content": "rebuilt", "messageId": "assistant-rebuild" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
            assert_eq!(persist.error, None);
        }
        let state_path = fixture
            .root
            .join(".tinybot")
            .join("state")
            .join("state.sqlite");
        std::fs::remove_file(&state_path).expect("state index should be removable");

        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let history = router.dispatch(&WorkerRequest::new(
            "req-rebuild-state-history",
            "trace-rebuild-state",
            "session.get_history",
            json!({ "session_id": "session-rebuild-state", "limit": 80 }),
        ));

        assert_eq!(history.error, None);
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][1]["messageId"],
            "assistant-rebuild"
        );
    }

    #[test]
    fn session_list_metadata_rebuild_ignores_legacy_thread_item_jsonl() {
        let fixture = WorkspaceFixture::new();
        {
            let mut router = WorkerRpcRouter::new_persistent_sessions(
                fixture.root.clone(),
                json!({}),
                vec![],
                50,
                CapabilityPolicy::new([
                    WorkerCapability::SessionWrite,
                    WorkerCapability::SessionMetadataRead,
                ]),
            )
            .unwrap();
            let persist = router.dispatch(&WorkerRequest::new(
                "req-ignore-legacy-items-persist",
                "trace-ignore-legacy-items",
                "session.persist_turn",
                json!({
                    "session_id": "session-ignore-legacy-items",
                    "run_id": "run-ignore-legacy-items",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-ignore-legacy-items" },
                        { "role": "assistant", "content": "rebuilt", "messageId": "assistant-ignore-legacy-items" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
            assert_eq!(persist.error, None);
        }
        fixture.write(
            ".tinybot/threads/items/thread-legacy-items.jsonl",
            r#"{"itemId":"legacy-session:1","threadId":"thread-legacy-items","runId":"legacy-history","turnId":"legacy-history","parentItemId":null,"sequence":1,"createdAt":"1783312765469","kind":{"type":"user_message","payload":{"content":"hello","role":"user"}}}
"#,
        );
        let state_path = fixture
            .root
            .join(".tinybot")
            .join("state")
            .join("state.sqlite");
        std::fs::remove_file(&state_path).expect("state index should be removable");

        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let list = router.dispatch(&WorkerRequest::new(
            "req-ignore-legacy-items-list",
            "trace-ignore-legacy-items",
            "session.list_metadata",
            json!({}),
        ));

        assert_eq!(list.error, None);
        let sessions = list.result.as_ref().unwrap().as_array().unwrap();
        assert!(sessions
            .iter()
            .any(|session| session["session_id"] == "session-ignore-legacy-items"));
    }

    #[test]
    fn session_get_metadata_reads_thread_log_after_state_rebuild() {
        let fixture = WorkspaceFixture::new();
        {
            let mut router = WorkerRpcRouter::new_persistent_sessions(
                fixture.root.clone(),
                json!({}),
                vec![],
                50,
                CapabilityPolicy::new([
                    WorkerCapability::SessionWrite,
                    WorkerCapability::SessionMetadataRead,
                ]),
            )
            .unwrap();
            let persist = router.dispatch(&WorkerRequest::new(
                "req-metadata-rebuild-persist",
                "trace-metadata-rebuild",
                "session.persist_turn",
                json!({
                    "session_id": "session-metadata-rebuild",
                    "run_id": "run-metadata-rebuild",
                    "messages": [
                        { "role": "user", "content": "metadata", "messageId": "user-metadata-rebuild" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
            assert_eq!(persist.error, None);
        }
        let state_path = fixture
            .root
            .join(".tinybot")
            .join("state")
            .join("state.sqlite");
        std::fs::remove_file(&state_path).expect("state index should be removable");

        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let metadata = router.dispatch(&WorkerRequest::new(
            "req-metadata-rebuild-get",
            "trace-metadata-rebuild",
            "session.get_metadata",
            json!({ "session_id": "session-metadata-rebuild" }),
        ));

        assert_eq!(metadata.error, None);
        assert_eq!(
            metadata.result.as_ref().unwrap()["session_id"],
            "session-metadata-rebuild"
        );
    }

    #[test]
    fn thread_log_history_rebuilds_corrupt_state_index_from_jsonl() {
        let fixture = WorkspaceFixture::new();
        {
            let mut router = WorkerRpcRouter::new_persistent_sessions(
                fixture.root.clone(),
                json!({}),
                vec![],
                50,
                CapabilityPolicy::new([
                    WorkerCapability::SessionWrite,
                    WorkerCapability::SessionMetadataRead,
                ]),
            )
            .unwrap();
            let persist = router.dispatch(&WorkerRequest::new(
                "req-corrupt-state-persist",
                "trace-corrupt-state",
                "session.persist_turn",
                json!({
                    "session_id": "session-corrupt-state",
                    "run_id": "run-corrupt-state",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-corrupt" },
                        { "role": "assistant", "content": "rebuilt", "messageId": "assistant-corrupt" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
            assert_eq!(persist.error, None);
        }
        let state_path = fixture
            .root
            .join(".tinybot")
            .join("state")
            .join("state.sqlite");
        std::fs::write(&state_path, b"not sqlite").expect("state index should be corruptible");

        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let history = router.dispatch(&WorkerRequest::new(
            "req-corrupt-state-history",
            "trace-corrupt-state",
            "session.get_history",
            json!({ "session_id": "session-corrupt-state", "limit": 80 }),
        ));

        assert_eq!(history.error, None);
        assert_eq!(
            history.result.as_ref().unwrap()["messages"][1]["messageId"],
            "assistant-corrupt"
        );
    }

    #[test]
    fn thread_log_history_rejects_state_index_path_escape() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-path-escape-persist",
            "trace-path-escape",
            "session.persist_turn",
            json!({
                "session_id": "session-path-escape",
                "run_id": "run-path-escape",
                "messages": [
                    { "role": "user", "content": "hello", "messageId": "user-path-escape" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);

        let state_path = fixture
            .root
            .join(".tinybot")
            .join("state")
            .join("state.sqlite");
        let escaped_path = fixture.root.join("escaped.jsonl");
        let connection = rusqlite::Connection::open(state_path).unwrap();
        connection
            .execute(
                "UPDATE threads SET thread_path = ?1 WHERE session_id = ?2",
                rusqlite::params![escaped_path.display().to_string(), "session-path-escape"],
            )
            .unwrap();

        let history = router.dispatch(&WorkerRequest::new(
            "req-path-escape-history",
            "trace-path-escape",
            "session.get_history",
            json!({ "session_id": "session-path-escape", "limit": 80 }),
        ));

        assert!(history.error.is_some());
        assert!(history
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("thread log path"));
    }

    #[test]
    fn session_list_metadata_merges_thread_log_and_legacy_sessions() {
        let fixture = WorkspaceFixture::new();
        let mut legacy_session = session_fixture();
        legacy_session.session_id = "legacy-session".to_string();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![legacy_session],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-mixed-list-persist",
            "trace-mixed-list",
            "session.persist_turn",
            json!({
                "session_id": "thread-log-session",
                "run_id": "run-thread-log-session",
                "messages": [
                    { "role": "user", "content": "hello", "messageId": "user-mixed" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);

        let list = router.dispatch(&WorkerRequest::new(
            "req-mixed-list",
            "trace-mixed-list",
            "session.list_metadata",
            json!({}),
        ));

        assert_eq!(list.error, None);
        let session_ids = list
            .result
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["session_id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert!(session_ids.contains(&"legacy-session".to_string()));
        assert!(session_ids.contains(&"thread-log-session".to_string()));
    }

    #[test]
    fn session_list_metadata_sorts_unix_ms_and_iso_timestamps_by_time() {
        let fixture = WorkspaceFixture::new();
        let mut legacy_session = session_fixture();
        legacy_session.session_id = "legacy-old-session".to_string();
        legacy_session.updated_at = "unix-ms:1".to_string();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![legacy_session],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-sort-mixed-timestamps-persist",
            "trace-sort-mixed-timestamps",
            "session.persist_turn",
            json!({
                "session_id": "thread-log-new-session",
                "run_id": "run-thread-log-new-session",
                "messages": [
                    { "role": "user", "content": "newer", "messageId": "user-sort-mixed" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);

        let list = router.dispatch(&WorkerRequest::new(
            "req-sort-mixed-timestamps-list",
            "trace-sort-mixed-timestamps",
            "session.list_metadata",
            json!({}),
        ));

        assert_eq!(list.error, None);
        assert_eq!(
            list.result.as_ref().unwrap()[0]["session_id"],
            "thread-log-new-session"
        );
    }

    #[test]
    fn session_list_metadata_prunes_missing_thread_log_rows() {
        let fixture = WorkspaceFixture::new();
        {
            let router = WorkerRpcRouter::new_persistent_sessions(
                fixture.root.clone(),
                json!({}),
                vec![],
                50,
                CapabilityPolicy::new([
                    WorkerCapability::SessionWrite,
                    WorkerCapability::SessionMetadataRead,
                ]),
            )
            .unwrap();
            router
                .thread_log
                .persist_session_turn(
                    "session-prune-missing-log",
                    "run-prune-missing-log",
                    vec![json!({
                        "role": "user",
                        "content": "stale",
                        "messageId": "user-prune-missing"
                    })],
                )
                .unwrap();
        }
        let thread_log_path = first_thread_log_file(&fixture.root);
        std::fs::remove_file(thread_log_path).expect("thread log should be removable");

        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let list = router.dispatch(&WorkerRequest::new(
            "req-prune-missing-log-list",
            "trace-prune-missing-log",
            "session.list_metadata",
            json!({}),
        ));

        assert_eq!(list.error, None);
        assert!(list.result.as_ref().unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn session_delete_removes_thread_log_only_session() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-delete-thread-log-persist",
            "trace-delete-thread-log",
            "session.persist_turn",
            json!({
                "session_id": "session-delete-thread-log",
                "run_id": "run-delete-thread-log",
                "messages": [
                    { "role": "user", "content": "delete me", "messageId": "user-delete-thread-log" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
        let delete = router.dispatch(&WorkerRequest::new(
            "req-delete-thread-log",
            "trace-delete-thread-log",
            "session.delete",
            json!({ "session_id": "session-delete-thread-log" }),
        ));
        assert_eq!(delete.error, None);
        assert_eq!(delete.result.as_ref().unwrap()["deleted"], true);

        let list = router.dispatch(&WorkerRequest::new(
            "req-delete-thread-log-list",
            "trace-delete-thread-log",
            "session.list_metadata",
            json!({}),
        ));
        assert_eq!(list.error, None);
        assert!(list.result.as_ref().unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn session_clear_clears_thread_log_history() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-clear-thread-log-persist",
            "trace-clear-thread-log",
            "session.persist_turn",
            json!({
                "session_id": "session-clear-thread-log",
                "run_id": "run-clear-thread-log",
                "messages": [
                    { "role": "user", "content": "clear me", "messageId": "user-clear-thread-log" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
        let clear = router.dispatch(&WorkerRequest::new(
            "req-clear-thread-log",
            "trace-clear-thread-log",
            "session.clear",
            json!({ "session_id": "session-clear-thread-log" }),
        ));
        assert_eq!(clear.error, None);
        assert_eq!(clear.result.as_ref().unwrap()["messages_before"], 1);

        let history = router.dispatch(&WorkerRequest::new(
            "req-clear-thread-log-history",
            "trace-clear-thread-log",
            "session.get_history",
            json!({ "session_id": "session-clear-thread-log", "limit": 80 }),
        ));
        assert_eq!(history.error, None);
        assert!(history.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn session_clear_rebuilds_thread_log_projection_without_stale_token_usage() {
        let fixture = WorkspaceFixture::new();
        {
            let mut router = WorkerRpcRouter::new_persistent_sessions(
                fixture.root.clone(),
                json!({}),
                vec![],
                50,
                CapabilityPolicy::new([
                    WorkerCapability::SessionWrite,
                    WorkerCapability::SessionMetadataRead,
                ]),
            )
            .unwrap();
            let persist = router.dispatch(&WorkerRequest::new(
                "req-clear-rebuild-persist",
                "trace-clear-rebuild",
                "session.persist_turn",
                json!({
                    "session_id": "session-clear-rebuild",
                    "run_id": "run-clear-rebuild",
                    "messages": [
                        { "role": "user", "content": "clear me", "messageId": "user-clear-rebuild" },
                        { "role": "assistant", "content": "ok", "messageId": "assistant-clear-rebuild" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
            assert_eq!(persist.error, None);
            router
                .thread_log
                .append_token_count(
                    "session-clear-rebuild",
                    crate::worker_thread_log::TokenUsageInfo {
                        total_token_usage: crate::worker_thread_log::TokenUsage {
                            input_tokens: 1010,
                            cached_input_tokens: 0,
                            output_tokens: 162,
                            reasoning_output_tokens: 0,
                            total_tokens: 1172,
                        },
                        last_token_usage: crate::worker_thread_log::TokenUsage {
                            input_tokens: 10,
                            cached_input_tokens: 0,
                            output_tokens: 162,
                            reasoning_output_tokens: 0,
                            total_tokens: 172,
                        },
                        model_context_window: Some(128000),
                    },
                )
                .unwrap();
            let clear = router.dispatch(&WorkerRequest::new(
                "req-clear-rebuild-clear",
                "trace-clear-rebuild",
                "session.clear",
                json!({ "session_id": "session-clear-rebuild" }),
            ));
            assert_eq!(clear.error, None);
        }

        let state_path = fixture
            .root
            .join(".tinybot")
            .join("state")
            .join("state.sqlite");
        std::fs::remove_file(&state_path).expect("state index should be removable");
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();

        let list = router.dispatch(&WorkerRequest::new(
            "req-clear-rebuild-list",
            "trace-clear-rebuild",
            "session.list_metadata",
            json!({}),
        ));
        assert_eq!(list.error, None);
        assert_eq!(list.result.as_ref().unwrap()[0]["extra"]["tokensUsed"], 0);

        let history = router.dispatch(&WorkerRequest::new(
            "req-clear-rebuild-history",
            "trace-clear-rebuild",
            "session.get_history",
            json!({ "session_id": "session-clear-rebuild", "limit": 80 }),
        ));
        assert_eq!(history.error, None);
        assert!(history.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn session_patch_metadata_updates_thread_log_list_projection() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-patch-thread-log-persist",
            "trace-patch-thread-log",
            "session.persist_turn",
            json!({
                "session_id": "session-patch-thread-log",
                "run_id": "run-patch-thread-log",
                "messages": [
                    { "role": "user", "content": "rename me", "messageId": "user-patch-thread-log" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
        let patch = router.dispatch(&WorkerRequest::new(
            "req-patch-thread-log",
            "trace-patch-thread-log",
            "session.patch_metadata",
            json!({
                "session_id": "session-patch-thread-log",
                "metadata": { "title": "Thread log title" }
            }),
        ));
        assert_eq!(patch.error, None);
        assert_eq!(patch.result.as_ref().unwrap()["title"], "Thread log title");

        let list = router.dispatch(&WorkerRequest::new(
            "req-patch-thread-log-list",
            "trace-patch-thread-log",
            "session.list_metadata",
            json!({}),
        ));
        assert_eq!(list.error, None);
        assert_eq!(
            list.result.as_ref().unwrap()[0]["title"],
            "Thread log title"
        );
    }

    #[test]
    fn session_patch_metadata_allows_thread_log_only_session() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        router
            .thread_log
            .persist_session_turn(
                "session-patch-thread-log-only",
                "run-patch-thread-log-only",
                vec![json!({
                    "role": "user",
                    "content": "rename me",
                    "messageId": "user-patch-thread-log-only"
                })],
            )
            .unwrap();

        let patch = router.dispatch(&WorkerRequest::new(
            "req-patch-thread-log-only",
            "trace-patch-thread-log-only",
            "session.patch_metadata",
            json!({
                "session_id": "session-patch-thread-log-only",
                "metadata": { "title": "Thread log only title" }
            }),
        ));

        assert_eq!(patch.error, None);
        assert_eq!(
            patch.result.as_ref().unwrap()["title"],
            "Thread log only title"
        );
    }

    #[test]
    fn session_patch_metadata_returns_legacy_persistence_error_after_thread_log_patch() {
        let fixture = WorkspaceFixture::new();
        let mut legacy_session = session_fixture();
        legacy_session.session_id = "session-patch-legacy-error".to_string();
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![legacy_session],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        router
            .thread_log
            .persist_session_turn(
                "session-patch-legacy-error",
                "run-patch-legacy-error",
                vec![json!({
                    "role": "user",
                    "content": "rename me",
                    "messageId": "user-patch-legacy-error"
                })],
            )
            .unwrap();
        let sqlite_path = fixture.root.join("sessions").join("sessions.sqlite");
        std::fs::create_dir_all(&sqlite_path).expect("sqlite path should be blockable");

        let patch = router.dispatch(&WorkerRequest::new(
            "req-patch-legacy-error",
            "trace-patch-legacy-error",
            "session.patch_metadata",
            json!({
                "session_id": "session-patch-legacy-error",
                "metadata": { "title": "Should not hide legacy failure" }
            }),
        ));

        assert!(patch.error.is_some());
        assert_eq!(
            patch.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::WorkerError
        );
    }

    #[test]
    fn dispatches_thread_store_round_trip_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-create",
            "trace-thread-create",
            "thread.create",
            json!({
                "title": "Reactbits research",
                "sessionKey": "session-1",
                "metadata": {
                    "tags": ["ui", "agent"],
                    "model": "deepseek-v4-flash"
                }
            }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .expect("thread id should be present")
            .to_string();

        let append = router.dispatch(&WorkerRequest::new(
            "req-thread-append",
            "trace-thread-append",
            "thread.append_items",
            json!({
                "threadId": thread_id,
                "items": [{
                    "itemId": "",
                    "threadId": "",
                    "runId": "run-1",
                    "turnId": "turn-1",
                    "sequence": 0,
                    "createdAt": "",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "Summarize a document" }
                    }
                }]
            }),
        ));
        assert_eq!(append.error, None);
        assert_eq!(append.result.as_ref().unwrap()["items"][0]["sequence"], 1);

        let search = router.dispatch(&WorkerRequest::new(
            "req-thread-search",
            "trace-thread-search",
            "thread.search",
            json!({ "query": "summarize" }),
        ));
        assert_eq!(search.error, None);
        assert_eq!(
            search.result.as_ref().unwrap()["threads"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-read",
            "trace-thread-read",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(read.error, None);
        assert_eq!(
            read.result.as_ref().unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let archive = router.dispatch(&WorkerRequest::new(
            "req-thread-archive",
            "trace-thread-archive",
            "thread.archive",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(archive.error, None);
        assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");

        let list = router.dispatch(&WorkerRequest::new(
            "req-thread-list",
            "trace-thread-list",
            "thread.list",
            json!({}),
        ));
        assert_eq!(list.error, None);
        assert_eq!(list.result.as_ref().unwrap()["threads"], json!([]));
    }

    #[test]
    fn dispatches_thread_list_and_search_include_legacy_session_projections() {
        let fixture = WorkspaceFixture::new();
        let mut legacy_session = session_fixture();
        legacy_session.session_id = "session:websocket-1".to_string();
        legacy_session.title = "Legacy Websocket Session".to_string();
        legacy_session.updated_at = "2026-06-09T11:00:00Z".to_string();
        legacy_session.extra = json!({
            "mode": "desktop",
            "metadata": {
                "topic": "reactbits"
            },
            "messages": [
                {
                    "role": "user",
                    "content": "查看 reactbits 内容",
                    "timestamp": "2026-06-09T10:58:00Z"
                },
                {
                    "role": "assistant",
                    "content": "整理 chat layout 文档",
                    "timestamp": "2026-06-09T10:59:00Z"
                }
            ]
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![legacy_session.clone()],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let list = router.dispatch(&WorkerRequest::new(
            "req-thread-list-legacy-session",
            "trace-thread-legacy-session",
            "thread.list",
            json!({}),
        ));
        assert_eq!(list.error, None);
        let threads = list.result.as_ref().unwrap()["threads"].as_array().unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0]["threadId"], "legacy-session-session_websocket-1");
        assert_eq!(threads[0]["sessionKey"], "session:websocket-1");
        assert_eq!(threads[0]["source"], "legacy_session_projection");
        assert_eq!(threads[0]["metadata"]["itemCount"], 2);
        assert_eq!(threads[0]["metadata"]["preview"], "整理 chat layout 文档");
        let projected_thread_id = threads[0]["threadId"].as_str().unwrap().to_string();

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-read-legacy-session",
            "trace-thread-legacy-session",
            "thread.read",
            json!({ "threadId": projected_thread_id }),
        ));
        assert_eq!(read.error, None);
        let read_result = read.result.as_ref().unwrap();
        assert_eq!(read_result["thread"]["source"], "legacy_session_projection");
        assert_eq!(read_result["pagination"]["itemCount"], 2);
        let read_items = read_result["items"].as_array().unwrap();
        assert_eq!(read_items.len(), 2);
        assert_eq!(read_items[0]["sequence"], 1);
        assert_eq!(read_items[0]["kind"]["type"], "user_message");
        assert_eq!(read_items[1]["kind"]["type"], "assistant_message_completed");

        let search = router.dispatch(&WorkerRequest::new(
            "req-thread-search-legacy-session",
            "trace-thread-legacy-session",
            "thread.search",
            json!({ "query": "reactbits" }),
        ));
        assert_eq!(search.error, None);
        let search_threads = search.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap();
        assert_eq!(search_threads.len(), 1);
        assert_eq!(search_threads[0]["sessionKey"], "session:websocket-1");

        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-create-existing-session",
            "trace-thread-legacy-session",
            "thread.create",
            json!({
                "title": "Stored replacement",
                "sessionKey": "session:websocket-1"
            }),
        ));
        assert_eq!(create.error, None);

        let deduped = router.dispatch(&WorkerRequest::new(
            "req-thread-list-legacy-deduped",
            "trace-thread-legacy-session",
            "thread.list",
            json!({ "includeArchived": true }),
        ));
        assert_eq!(deduped.error, None);
        let deduped_threads = deduped.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap();
        assert_eq!(deduped_threads.len(), 1);
        assert_ne!(
            deduped_threads[0]["source"], "legacy_session_projection",
            "stored thread should suppress the read-only legacy projection"
        );
    }

    #[test]
    fn dispatches_thread_lifecycle_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-create",
            "trace-thread-lifecycle",
            "thread.create",
            json!({ "title": "Lifecycle" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let archive = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-archive",
            "trace-thread-lifecycle",
            "thread.archive",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(archive.error, None);
        assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");

        let resume = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-resume",
            "trace-thread-lifecycle",
            "thread.resume",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(resume.error, None);
        assert_eq!(resume.result.as_ref().unwrap()["thread"]["status"], "empty");
        assert_eq!(resume.result.as_ref().unwrap()["activeRun"], json!(null));

        let status = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-status",
            "trace-thread-lifecycle",
            "thread.status",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(status.error, None);
        assert_eq!(
            status.result.as_ref().unwrap()["thread"]["threadId"],
            thread_id
        );
        assert_eq!(status.result.as_ref().unwrap()["children"], json!([]));

        let rearchive = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-rearchive",
            "trace-thread-lifecycle",
            "thread.archive",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(rearchive.error, None);
        let unarchive = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-unarchive",
            "trace-thread-lifecycle",
            "thread.unarchive",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(unarchive.error, None);
        assert_eq!(unarchive.result.as_ref().unwrap()["status"], "empty");

        let delete = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-delete",
            "trace-thread-lifecycle",
            "thread.delete",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(delete.error, None);
        assert_eq!(delete.result.as_ref().unwrap()["deleted"], true);

        let read_deleted = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-read-deleted",
            "trace-thread-lifecycle",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(
            read_deleted.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
    }

    #[test]
    fn dispatches_thread_resume_from_checkpoint_id() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-resume-checkpoint-create",
            "trace-thread-resume-checkpoint",
            "thread.create",
            json!({ "threadId": "thread-resume-checkpoint", "title": "Resume checkpoint" }),
        ));
        assert_eq!(create.error, None);

        let append = router.dispatch(&WorkerRequest::new(
            "req-thread-resume-checkpoint-append",
            "trace-thread-resume-checkpoint",
            "thread.append_items",
            json!({
                "threadId": "thread-resume-checkpoint",
                "items": [
                    {
                        "itemId": "thread-resume-checkpoint-before",
                        "threadId": "",
                        "runId": "run-resume-checkpoint",
                        "turnId": "turn-resume-checkpoint",
                        "sequence": 0,
                        "createdAt": "2026-07-05T00:00:01Z",
                        "kind": {
                            "type": "user_message",
                            "payload": { "text": "Before checkpoint" }
                        }
                    },
                    {
                        "itemId": "thread-resume-checkpoint-marker",
                        "threadId": "",
                        "runId": "run-resume-checkpoint",
                        "turnId": "turn-resume-checkpoint",
                        "sequence": 0,
                        "createdAt": "2026-07-05T00:00:02Z",
                        "kind": {
                            "type": "checkpoint_created",
                            "payload": {
                                "checkpointId": "checkpoint-resume",
                                "runId": "run-resume-checkpoint",
                                "restorePayload": { "phase": "awaiting_tool" }
                            }
                        }
                    },
                    {
                        "itemId": "thread-resume-checkpoint-after",
                        "threadId": "",
                        "runId": "run-resume-checkpoint",
                        "turnId": "turn-resume-checkpoint",
                        "sequence": 0,
                        "createdAt": "2026-07-05T00:00:03Z",
                        "kind": {
                            "type": "user_message",
                            "payload": { "text": "After checkpoint" }
                        }
                    }
                ]
            }),
        ));
        assert_eq!(append.error, None);

        let archive = router.dispatch(&WorkerRequest::new(
            "req-thread-resume-checkpoint-archive",
            "trace-thread-resume-checkpoint",
            "thread.archive",
            json!({ "threadId": "thread-resume-checkpoint" }),
        ));
        assert_eq!(archive.error, None);

        let resume = router.dispatch(&WorkerRequest::new(
            "req-thread-resume-checkpoint",
            "trace-thread-resume-checkpoint",
            "thread.resume",
            json!({
                "threadId": "thread-resume-checkpoint",
                "checkpointId": "checkpoint-resume"
            }),
        ));
        assert_eq!(resume.error, None);
        let items = resume.result.as_ref().unwrap()["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["sequence"], 2);
        assert_eq!(items[0]["kind"]["type"], "checkpoint_created");
        assert_eq!(items[1]["sequence"], 3);
        assert_eq!(
            resume.result.as_ref().unwrap()["latestCheckpoint"]["checkpointId"],
            "checkpoint-resume"
        );
        assert_eq!(resume.result.as_ref().unwrap()["thread"]["status"], "idle");
    }

    #[test]
    fn dispatches_thread_archive_children_policy() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let parent = router.dispatch(&WorkerRequest::new(
            "req-thread-archive-tree-parent",
            "trace-thread-archive-tree",
            "thread.create",
            json!({
                "threadId": "thread-archive-tree-parent",
                "title": "Parent",
                "source": "agent_run"
            }),
        ));
        assert_eq!(parent.error, None);
        let child = router.dispatch(&WorkerRequest::new(
            "req-thread-archive-tree-child",
            "trace-thread-archive-tree",
            "thread.create",
            json!({
                "threadId": "thread-archive-tree-child",
                "title": "Child",
                "parentThreadId": "thread-archive-tree-parent",
                "source": "subagent"
            }),
        ));
        assert_eq!(child.error, None);

        let archive = router.dispatch(&WorkerRequest::new(
            "req-thread-archive-tree-archive",
            "trace-thread-archive-tree",
            "thread.archive",
            json!({
                "threadId": "thread-archive-tree-parent",
                "archiveChildren": true
            }),
        ));
        assert_eq!(archive.error, None);
        assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");

        let children = router.dispatch(&WorkerRequest::new(
            "req-thread-archive-tree-children",
            "trace-thread-archive-tree",
            "thread.list",
            json!({
                "parentThreadId": "thread-archive-tree-parent",
                "includeArchived": true
            }),
        ));
        assert_eq!(children.error, None);
        assert_eq!(
            children.result.as_ref().unwrap()["threads"][0]["threadId"],
            "thread-archive-tree-child"
        );
        assert_eq!(
            children.result.as_ref().unwrap()["threads"][0]["status"],
            "archived"
        );

        let default_children = router.dispatch(&WorkerRequest::new(
            "req-thread-archive-tree-default-children",
            "trace-thread-archive-tree",
            "thread.list",
            json!({ "parentThreadId": "thread-archive-tree-parent" }),
        ));
        assert_eq!(default_children.error, None);
        assert_eq!(
            default_children.result.as_ref().unwrap()["threads"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        let unarchive = router.dispatch(&WorkerRequest::new(
            "req-thread-archive-tree-unarchive",
            "trace-thread-archive-tree",
            "thread.unarchive",
            json!({
                "threadId": "thread-archive-tree-parent",
                "unarchiveChildren": true
            }),
        ));
        assert_eq!(unarchive.error, None);
        assert_eq!(unarchive.result.as_ref().unwrap()["status"], "empty");

        let unarchived_child = router.dispatch(&WorkerRequest::new(
            "req-thread-archive-tree-read-unarchived-child",
            "trace-thread-archive-tree",
            "thread.read",
            json!({ "threadId": "thread-archive-tree-child" }),
        ));
        assert_eq!(unarchived_child.error, None);
        assert_eq!(
            unarchived_child.result.as_ref().unwrap()["thread"]["status"],
            "empty"
        );
    }

    #[test]
    fn dispatches_thread_fork_include_children_policy() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let parent = router.dispatch(&WorkerRequest::new(
            "req-thread-fork-tree-parent",
            "trace-thread-fork-tree",
            "thread.create",
            json!({
                "threadId": "thread-fork-tree-parent",
                "title": "Fork parent",
                "source": "agent_run"
            }),
        ));
        assert_eq!(parent.error, None);
        let child = router.dispatch(&WorkerRequest::new(
            "req-thread-fork-tree-child",
            "trace-thread-fork-tree",
            "thread.create",
            json!({
                "threadId": "thread-fork-tree-child",
                "title": "Fork child",
                "parentThreadId": "thread-fork-tree-parent",
                "source": "subagent"
            }),
        ));
        assert_eq!(child.error, None);
        let append = router.dispatch(&WorkerRequest::new(
            "req-thread-fork-tree-child-append",
            "trace-thread-fork-tree",
            "thread.append_items",
            json!({
                "threadId": "thread-fork-tree-child",
                "items": [{
                    "itemId": "thread-fork-tree-child-item",
                    "threadId": "",
                    "runId": "run-fork-child",
                    "turnId": "turn-fork-child",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "Child context" }
                    }
                }]
            }),
        ));
        assert_eq!(append.error, None);

        let fork = router.dispatch(&WorkerRequest::new(
            "req-thread-fork-tree-fork",
            "trace-thread-fork-tree",
            "thread.fork",
            json!({
                "threadId": "thread-fork-tree-parent",
                "title": "Forked parent",
                "includeChildren": true
            }),
        ));
        assert_eq!(fork.error, None);
        let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let children = router.dispatch(&WorkerRequest::new(
            "req-thread-fork-tree-children",
            "trace-thread-fork-tree",
            "thread.list",
            json!({ "parentThreadId": fork_thread_id }),
        ));
        assert_eq!(children.error, None);
        let child_threads = children.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap();
        assert_eq!(child_threads.len(), 1);
        assert_eq!(child_threads[0]["title"], "Fork child");
        assert_eq!(child_threads[0]["parentThreadId"], fork_thread_id);
        let copied_child_thread_id = child_threads[0]["threadId"].as_str().unwrap();
        assert_ne!(copied_child_thread_id, "thread-fork-tree-child");

        let copied_child = router.dispatch(&WorkerRequest::new(
            "req-thread-fork-tree-child-read",
            "trace-thread-fork-tree",
            "thread.read",
            json!({ "threadId": copied_child_thread_id }),
        ));
        assert_eq!(copied_child.error, None);
        assert_eq!(
            copied_child.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
            "Child context"
        );
    }

    #[test]
    fn dispatches_thread_fork_idempotently_by_client_event_id() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-direct-fork-idempotent-create",
            "trace-thread-direct-fork-idempotent",
            "thread.create",
            json!({ "threadId": "thread-direct-fork-source", "title": "Fork source" }),
        ));
        assert_eq!(create.error, None);

        let fork = router.dispatch(&WorkerRequest::new(
            "req-thread-direct-fork-idempotent-fork",
            "trace-thread-direct-fork-idempotent",
            "thread.fork",
            json!({
                "threadId": "thread-direct-fork-source",
                "clientEventId": "direct-fork-client-1",
                "title": "Direct fork"
            }),
        ));
        assert_eq!(fork.error, None);
        let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(fork.result.as_ref().unwrap()["title"], "Direct fork");

        let fork_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-direct-fork-idempotent-fork-retry",
            "trace-thread-direct-fork-idempotent",
            "thread.fork",
            json!({
                "threadId": "thread-direct-fork-source",
                "clientEventId": "direct-fork-client-1",
                "title": "Retry must not fork"
            }),
        ));
        assert_eq!(fork_retry.error, None);
        assert_eq!(
            fork_retry.result.as_ref().unwrap()["threadId"],
            fork_thread_id
        );
        assert_eq!(fork_retry.result.as_ref().unwrap()["title"], "Direct fork");

        let children = router.dispatch(&WorkerRequest::new(
            "req-thread-direct-fork-idempotent-children",
            "trace-thread-direct-fork-idempotent",
            "thread.list",
            json!({ "parentThreadId": "thread-direct-fork-source", "includeChildThreads": true }),
        ));
        assert_eq!(children.error, None);
        let child_threads = children.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap();
        assert_eq!(child_threads.len(), 1);
        assert_eq!(child_threads[0]["threadId"], fork_thread_id);
        assert_eq!(child_threads[0]["source"], "fork");
    }

    #[test]
    fn dispatches_thread_runtime_turn_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-create",
            "trace-thread-runtime",
            "thread.create",
            json!({ "title": "Runtime" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let start = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-start",
            "trace-thread-runtime",
            "thread.start_turn",
            json!({
                "threadId": thread_id,
                "runId": "run-runtime-1",
                "input": { "text": "Summarize this document" },
                "model": "deepseek-v4-flash",
                "provider": "tinybot"
            }),
        ));
        assert_eq!(start.error, None);
        let start_result = start.result.as_ref().unwrap();
        assert_eq!(start_result["run"]["runId"], "run-runtime-1");
        assert_eq!(start_result["run"]["status"], "running");
        assert_eq!(start_result["run"]["active"], true);
        assert_eq!(
            start_result["appendedItems"]
                .as_array()
                .expect("start should append items")
                .len(),
            2
        );
        assert_eq!(start_result["snapshot"]["thread"]["status"], "running");

        let continue_turn = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-continue",
            "trace-thread-runtime",
            "thread.continue_turn",
            json!({
                "threadId": thread_id,
                "input": { "approval": "continue" }
            }),
        ));
        assert_eq!(continue_turn.error, None);
        assert_eq!(
            continue_turn.result.as_ref().unwrap()["run"]["runId"],
            "run-runtime-1"
        );
        assert_eq!(
            continue_turn.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "event"
        );

        let status_running = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-status-running",
            "trace-thread-runtime",
            "thread.status",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(status_running.error, None);
        assert_eq!(
            status_running.result.as_ref().unwrap()["activeRun"]["runId"],
            "run-runtime-1"
        );

        let interrupt = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-interrupt",
            "trace-thread-runtime",
            "thread.interrupt",
            json!({
                "threadId": thread_id,
                "reason": "user requested stop"
            }),
        ));
        assert_eq!(interrupt.error, None);
        assert_eq!(
            interrupt.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "cancelled"
        );
        assert_eq!(interrupt.result.as_ref().unwrap()["run"]["active"], false);
        assert_eq!(
            interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "idle"
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-read",
            "trace-thread-runtime",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(read.error, None);
        assert_eq!(
            read.result.as_ref().unwrap()["items"]
                .as_array()
                .expect("runtime items should be readable")
                .len(),
            4
        );
        assert_eq!(read.result.as_ref().unwrap()["activeRun"], json!(null));
    }

    #[test]
    fn dispatches_thread_runtime_turn_requests_idempotently() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-idempotent-create",
            "trace-thread-runtime-idempotent",
            "thread.create",
            json!({ "threadId": "thread-runtime-idempotent", "title": "Runtime idempotency" }),
        ));
        assert_eq!(create.error, None);

        let start = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-idempotent-start",
            "trace-thread-runtime-idempotent",
            "thread.start_turn",
            json!({
                "threadId": "thread-runtime-idempotent",
                "clientEventId": "direct-start-client-1",
                "runId": "run-direct-original",
                "input": { "text": "Original prompt" },
                "model": "deepseek-v4-flash",
                "provider": "tinybot"
            }),
        ));
        assert_eq!(start.error, None);
        let start_items = start.result.as_ref().unwrap()["appendedItems"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(
            start.result.as_ref().unwrap()["run"]["runId"],
            "run-direct-original"
        );

        let start_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-idempotent-start-retry",
            "trace-thread-runtime-idempotent",
            "thread.start_turn",
            json!({
                "threadId": "thread-runtime-idempotent",
                "clientEventId": "direct-start-client-1",
                "runId": "run-direct-retry",
                "input": { "text": "Retry must not append" },
                "model": "retry-model",
                "provider": "retry-provider"
            }),
        ));
        assert_eq!(start_retry.error, None);
        assert_eq!(
            start_retry.result.as_ref().unwrap()["run"]["runId"],
            "run-direct-original"
        );
        assert_eq!(
            start_retry.result.as_ref().unwrap()["appendedItems"]
                .as_array()
                .unwrap(),
            &start_items
        );
        assert_eq!(
            start_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["text"],
            "Original prompt"
        );

        let continue_turn = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-idempotent-continue",
            "trace-thread-runtime-idempotent",
            "thread.continue_turn",
            json!({
                "threadId": "thread-runtime-idempotent",
                "clientEventId": "direct-continue-client-1",
                "input": { "approval": "continue" }
            }),
        ));
        assert_eq!(continue_turn.error, None);
        let continue_items = continue_turn.result.as_ref().unwrap()["appendedItems"]
            .as_array()
            .unwrap()
            .clone();

        let interrupt = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-idempotent-interrupt",
            "trace-thread-runtime-idempotent",
            "thread.interrupt",
            json!({
                "threadId": "thread-runtime-idempotent",
                "reason": "stop before retry"
            }),
        ));
        assert_eq!(interrupt.error, None);
        assert_eq!(
            interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "idle"
        );

        let continue_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-idempotent-continue-retry",
            "trace-thread-runtime-idempotent",
            "thread.continue_turn",
            json!({
                "threadId": "thread-runtime-idempotent",
                "clientEventId": "direct-continue-client-1",
                "input": { "approval": "retry must replay" }
            }),
        ));
        assert_eq!(continue_retry.error, None);
        assert_eq!(
            continue_retry.result.as_ref().unwrap()["run"]["runId"],
            "run-direct-original"
        );
        assert_eq!(
            continue_retry.result.as_ref().unwrap()["appendedItems"]
                .as_array()
                .unwrap(),
            &continue_items
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-runtime-idempotent-read",
            "trace-thread-runtime-idempotent",
            "thread.read",
            json!({ "threadId": "thread-runtime-idempotent" }),
        ));
        assert_eq!(read.error, None);
        let items = read.result.as_ref().unwrap()["items"].as_array().unwrap();
        assert_eq!(items.len(), 4);
        assert_eq!(items[0]["kind"]["payload"]["text"], "Original prompt");
        assert_eq!(items[1]["kind"]["type"], "agent_run_started");
        assert_eq!(items[2]["kind"]["type"], "event");
        assert_eq!(items[3]["kind"]["type"], "cancelled");
    }

    #[test]
    fn dispatches_thread_events_after_cursor() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-events-create",
            "trace-thread-events",
            "thread.create",
            json!({ "title": "Event feed" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let start = router.dispatch(&WorkerRequest::new(
            "req-thread-events-start",
            "trace-thread-events",
            "thread.start_turn",
            json!({
                "threadId": thread_id,
                "runId": "run-events-1",
                "input": "Summarize a document"
            }),
        ));
        assert_eq!(start.error, None);

        let first_page = router.dispatch(&WorkerRequest::new(
            "req-thread-events-first-page",
            "trace-thread-events",
            "thread.events",
            json!({ "threadId": thread_id, "afterSequence": 0, "limit": 1 }),
        ));
        assert_eq!(first_page.error, None);
        assert_eq!(first_page.result.as_ref().unwrap()["threadId"], thread_id);
        assert_eq!(
            first_page.result.as_ref().unwrap()["thread"]["threadId"],
            thread_id
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["thread"]["status"],
            "running"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["activeRun"]["runId"],
            "run-events-1"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["runs"][0]["runId"],
            "run-events-1"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["runs"][0]["active"],
            true
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["items"][0]["sequence"],
            1
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["items"][0]["kind"]["type"],
            "user_message"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][0]["type"],
            "thread_snapshot"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][0]["thread"]["threadId"],
            thread_id
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][0]["activeRun"]["runId"],
            "run-events-1"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][1]["type"],
            "thread_status"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][1]["thread"]["status"],
            "running"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][1]["activeRun"]["runId"],
            "run-events-1"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][2]["type"],
            "item_appended"
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][2]["sequence"],
            1
        );
        assert_eq!(
            first_page.result.as_ref().unwrap()["events"][2]["item"]["kind"]["type"],
            "user_message"
        );
        assert_eq!(first_page.result.as_ref().unwrap()["nextCursor"], "1");

        let second_page = router.dispatch(&WorkerRequest::new(
            "req-thread-events-second-page",
            "trace-thread-events",
            "thread.events",
            json!({
                "threadId": thread_id,
                "cursor": first_page.result.as_ref().unwrap()["nextCursor"],
                "limit": 10
            }),
        ));
        assert_eq!(second_page.error, None);
        assert_eq!(
            second_page.result.as_ref().unwrap()["items"][0]["sequence"],
            2
        );
        assert_eq!(
            second_page.result.as_ref().unwrap()["items"][0]["kind"]["type"],
            "agent_run_started"
        );
        assert_eq!(
            second_page.result.as_ref().unwrap()["events"][0]["type"],
            "thread_snapshot"
        );
        assert_eq!(
            second_page.result.as_ref().unwrap()["events"][0]["activeRun"]["runId"],
            "run-events-1"
        );
        assert_eq!(
            second_page.result.as_ref().unwrap()["events"][1]["type"],
            "thread_status"
        );
        assert_eq!(
            second_page.result.as_ref().unwrap()["events"][2]["type"],
            "item_appended"
        );
        assert_eq!(
            second_page.result.as_ref().unwrap()["events"][2]["sequence"],
            2
        );
        assert_eq!(second_page.result.as_ref().unwrap()["nextCursor"], "2");

        let empty_page = router.dispatch(&WorkerRequest::new(
            "req-thread-events-empty-page",
            "trace-thread-events",
            "thread.events",
            json!({ "threadId": thread_id, "cursor": "2", "limit": 10 }),
        ));
        assert_eq!(empty_page.error, None);
        assert_eq!(
            empty_page.result.as_ref().unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            empty_page.result.as_ref().unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            empty_page.result.as_ref().unwrap()["events"][0]["type"],
            "thread_snapshot"
        );
        assert_eq!(
            empty_page.result.as_ref().unwrap()["events"][0]["activeRun"]["runId"],
            "run-events-1"
        );
        assert_eq!(
            empty_page.result.as_ref().unwrap()["events"][1]["type"],
            "thread_status"
        );
        assert_eq!(
            empty_page.result.as_ref().unwrap()["events"][1]["thread"]["threadId"],
            thread_id
        );
        assert_eq!(empty_page.result.as_ref().unwrap()["nextCursor"], "2");
    }

    #[test]
    fn dispatches_tool_registry_list_with_capability_metadata() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::MemoryRead,
                WorkerCapability::McpCall,
            ]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-tool-registry-list",
            "trace-tool-registry",
            "tool_registry.list",
            json!({}),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        let tools = result["tools"]
            .as_array()
            .expect("tools should be an array");
        assert!(tools.len() >= 8);
        assert_eq!(result["total"], tools.len());

        let knowledge = tools
            .iter()
            .find(|tool| tool["method"] == "knowledge.query")
            .expect("knowledge.query should be registered");
        assert_eq!(knowledge["toolId"], "knowledge.query");
        assert_eq!(knowledge["namespace"], "knowledge");
        assert_eq!(knowledge["exposure"], "model");
        assert_eq!(knowledge["available"], true);
        assert_eq!(knowledge["requiredCapabilities"], json!(["knowledge.read"]));
        assert_eq!(knowledge["approval"]["required"], false);

        let shell = tools
            .iter()
            .find(|tool| tool["method"] == "shell.execute")
            .expect("shell.execute should be registered");
        assert_eq!(shell["namespace"], "shell");
        assert_eq!(shell["exposure"], "deferred");
        assert_eq!(shell["available"], false);
        assert_eq!(shell["requiredCapabilities"], json!(["shell.execute"]));
        assert_eq!(shell["approval"]["required"], true);
        assert_eq!(shell["approval"]["scope"], "command");

        let mcp = tools
            .iter()
            .find(|tool| tool["method"] == "mcp.call_tool")
            .expect("mcp.call_tool should be registered");
        assert_eq!(mcp["namespace"], "mcp");
        assert_eq!(mcp["dynamic"], true);
        assert_eq!(mcp["requiredCapabilities"], json!(["mcp.call"]));

        let write_file = tools
            .iter()
            .find(|tool| tool["method"] == "workspace.write_file")
            .expect("workspace.write_file should be registered");
        assert_eq!(
            write_file["requiredCapabilities"],
            json!(["fs.workspace.write", "approval.request"])
        );
        assert_eq!(write_file["approval"]["required"], true);
        assert_eq!(write_file["available"], false);
    }

    #[test]
    fn dispatches_tool_registry_search_with_filters() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::ShellExecute]),
        );

        let shell = router.dispatch(&WorkerRequest::new(
            "req-tool-registry-search-shell",
            "trace-tool-registry-search",
            "tool_registry.search",
            json!({ "query": "command" }),
        ));
        assert_eq!(shell.error, None);
        assert_eq!(shell.result.as_ref().unwrap()["query"], "command");
        assert_eq!(shell.result.as_ref().unwrap()["total"], 1);
        assert_eq!(
            shell.result.as_ref().unwrap()["tools"][0]["method"],
            "shell.execute"
        );
        assert_eq!(
            shell.result.as_ref().unwrap()["tools"][0]["available"],
            true
        );

        let memory = router.dispatch(&WorkerRequest::new(
            "req-tool-registry-search-memory",
            "trace-tool-registry-search",
            "tool_registry.search",
            json!({
                "namespace": "memory",
                "availableOnly": true,
                "exposure": "model"
            }),
        ));
        assert_eq!(memory.error, None);
        let memory_tools = memory.result.as_ref().unwrap()["tools"]
            .as_array()
            .expect("memory tools should be an array");
        assert_eq!(memory_tools.len(), 2);
        assert!(memory_tools
            .iter()
            .all(|tool| tool["namespace"] == "memory"));
        assert!(memory_tools.iter().all(|tool| tool["available"] == true));

        let unavailable = router.dispatch(&WorkerRequest::new(
            "req-tool-registry-search-unavailable",
            "trace-tool-registry-search",
            "tool_registry.search",
            json!({
                "namespace": "workspace",
                "availableOnly": true
            }),
        ));
        assert_eq!(unavailable.error, None);
        assert_eq!(unavailable.result.as_ref().unwrap()["total"], 0);
        assert!(unavailable.result.as_ref().unwrap()["tools"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn dispatches_permission_profile_current_with_tool_decisions() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::FsWorkspaceRead,
                WorkerCapability::FsWorkspaceWrite,
                WorkerCapability::ApprovalRequest,
                WorkerCapability::MemoryRead,
            ]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-permission-profile-current",
            "trace-permission-profile",
            "permission_profile.current",
            json!({}),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["profileId"], "local-worker");
        assert_eq!(result["approvalPolicy"], "on_request");
        assert_eq!(result["sandbox"]["mode"], "workspace_write");
        assert!(result["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability["capability"] == "fs.workspace.read"
                && capability["granted"] == true
                && capability["scope"] == "workspace://current"));
        let read_file = result["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["toolId"] == "workspace.read_file")
            .expect("workspace.read_file decision should be present");
        assert_eq!(read_file["decision"], "allow");
        assert_eq!(read_file["requiresApproval"], false);
        let write_file = result["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["toolId"] == "workspace.write_file")
            .expect("workspace.write_file decision should be present");
        assert_eq!(write_file["decision"], "needs_approval");
        assert_eq!(write_file["requiresApproval"], true);
        assert_eq!(write_file["approval"]["scope"], "file");
        let shell = result["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["toolId"] == "shell.execute")
            .expect("shell.execute decision should be present");
        assert_eq!(shell["decision"], "deny");
        assert_eq!(shell["missingCapabilities"], json!(["shell.execute"]));
    }

    #[test]
    fn dispatches_permission_profile_evaluate_tool_for_sensitive_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ShellExecute,
                WorkerCapability::ApprovalRequest,
            ]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-permission-profile-evaluate-shell",
            "trace-permission-profile",
            "permission_profile.evaluate_tool",
            json!({
                "toolId": "shell.execute",
                "arguments": { "command": "cargo test --lib" },
                "sessionId": "session-1",
                "runId": "run-1"
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["tool"]["toolId"], "shell.execute");
        assert_eq!(result["decision"], "needs_approval");
        assert_eq!(result["requiresApproval"], true);
        assert_eq!(result["approvalRequest"]["method"], "shell.execute");
        assert_eq!(result["approvalRequest"]["category"], "shell");
        assert_eq!(result["approvalRequest"]["risk"], "high");
        assert_eq!(
            result["approvalRequest"]["operation"],
            json!({
                "toolName": "shell.execute",
                "arguments": { "command": "cargo test --lib" }
            })
        );
        assert_eq!(result["approvalRequest"]["sessionId"], "session-1");
        assert_eq!(result["approvalRequest"]["runId"], "run-1");
    }

    #[test]
    fn dispatches_permission_profile_evaluate_tool_denies_missing_capability() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-permission-profile-evaluate-denied",
            "trace-permission-profile",
            "permission_profile.evaluate_tool",
            json!({
                "toolId": "mcp.call_tool",
                "arguments": { "server": "docs", "tool": "search" }
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["tool"]["toolId"], "mcp.call_tool");
        assert_eq!(result["decision"], "deny");
        assert_eq!(result["requiresApproval"], true);
        assert_eq!(result["missingCapabilities"], json!(["mcp.call"]));
        assert!(result.get("approvalRequest").is_none());
    }

    #[test]
    fn dispatches_permission_profile_request_tool_approval_records_thread_item() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ShellExecute,
                WorkerCapability::ApprovalRequest,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-permission-approval-thread-create",
            "trace-permission-approval",
            "thread.create",
            json!({
                "threadId": "thread-permission-approval",
                "title": "Permission approval thread"
            }),
        ));
        assert_eq!(create.error, None);
        let start = router.dispatch(&WorkerRequest::new(
            "req-permission-approval-thread-start",
            "trace-permission-approval",
            "thread.start_turn",
            json!({
                "threadId": "thread-permission-approval",
                "runId": "run-permission-approval",
                "turnId": "turn-permission-approval",
                "input": { "content": "run shell" }
            }),
        ));
        assert_eq!(start.error, None);

        let response = router.dispatch(&WorkerRequest::new(
            "req-permission-approval-request",
            "trace-permission-approval",
            "permission_profile.request_tool_approval",
            json!({
                "toolId": "shell.execute",
                "threadId": "thread-permission-approval",
                "runId": "run-permission-approval",
                "turnId": "turn-permission-approval",
                "sessionId": "session-permission-approval",
                "arguments": { "command": "echo needs approval" }
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["status"], "awaiting_approval");
        assert_eq!(result["evaluation"]["decision"], "needs_approval");
        assert_eq!(result["approval"]["stopReason"], "awaiting_approval");
        assert_eq!(result["approval"]["category"], "shell");
        assert_eq!(result["appendedItems"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["appendedItems"][0]["kind"]["type"],
            "approval_requested"
        );
        assert_eq!(
            result["appendedItems"][0]["kind"]["payload"]["approvalId"],
            result["approval"]["approvalId"]
        );

        let snapshot = router.dispatch(&WorkerRequest::new(
            "req-permission-approval-thread-snapshot",
            "trace-permission-approval",
            "thread.read",
            json!({ "threadId": "thread-permission-approval" }),
        ));
        assert_eq!(snapshot.error, None);
        let item_kinds = snapshot.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec!["user_message", "agent_run_started", "approval_requested"]
        );
    }

    #[test]
    fn dispatches_permission_profile_resolve_tool_approval_records_thread_item() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ShellExecute,
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-permission-resolve-thread-create",
            "trace-permission-resolve",
            "thread.create",
            json!({
                "threadId": "thread-permission-resolve",
                "title": "Permission resolve thread"
            }),
        ));
        assert_eq!(create.error, None);
        let start = router.dispatch(&WorkerRequest::new(
            "req-permission-resolve-thread-start",
            "trace-permission-resolve",
            "thread.start_turn",
            json!({
                "threadId": "thread-permission-resolve",
                "runId": "run-permission-resolve",
                "turnId": "turn-permission-resolve",
                "input": { "content": "run shell" }
            }),
        ));
        assert_eq!(start.error, None);
        let request_response = router.dispatch(&WorkerRequest::new(
            "req-permission-resolve-request",
            "trace-permission-resolve",
            "permission_profile.request_tool_approval",
            json!({
                "toolId": "shell.execute",
                "threadId": "thread-permission-resolve",
                "runId": "run-permission-resolve",
                "turnId": "turn-permission-resolve",
                "sessionId": "session-permission-resolve",
                "arguments": { "command": "echo resolve approval" }
            }),
        ));
        assert_eq!(request_response.error, None);
        let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
            .as_str()
            .unwrap()
            .to_string();

        let response = router.dispatch(&WorkerRequest::new(
            "req-permission-resolve-decision",
            "trace-permission-resolve",
            "permission_profile.resolve_tool_approval",
            json!({
                "threadId": "thread-permission-resolve",
                "runId": "run-permission-resolve",
                "turnId": "turn-permission-resolve",
                "sessionId": "session-permission-resolve",
                "approvalId": approval_id,
                "approved": true,
                "scope": "once",
                "guidance": "approved for this run"
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["status"], "approved");
        assert_eq!(result["resolution"]["status"], "approved");
        assert_eq!(result["appendedItems"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["appendedItems"][0]["kind"]["type"],
            "approval_resolved"
        );
        assert_eq!(
            result["appendedItems"][0]["kind"]["payload"]["approved"],
            true
        );
        assert_eq!(
            result["appendedItems"][0]["parentItemId"],
            request_response.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        );
    }

    #[test]
    fn permission_profile_resolved_tool_approval_allows_matching_sensitive_tool() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ShellExecute,
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
            ]),
        );
        let request_response = router.dispatch(&WorkerRequest::new(
            "req-permission-grant-request",
            "trace-permission-grant",
            "permission_profile.request_tool_approval",
            json!({
                "toolId": "shell.execute",
                "runId": "run-permission-grant",
                "sessionId": "session-permission-grant",
                "arguments": { "command": "echo approval grant works" }
            }),
        ));
        assert_eq!(request_response.error, None);
        let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        let resolve_response = router.dispatch(&WorkerRequest::new(
            "req-permission-grant-resolve",
            "trace-permission-grant",
            "permission_profile.resolve_tool_approval",
            json!({
                "sessionId": "session-permission-grant",
                "approvalId": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ));
        assert_eq!(resolve_response.error, None);

        let shell_response = router.dispatch(&WorkerRequest::new(
            "req-permission-grant-shell",
            "trace-permission-grant",
            "shell.execute",
            json!({
                "command": "echo approval grant works",
                "working_dir": ".",
                "timeout": 5,
                "session_id": "session-permission-grant",
                "run_id": "run-permission-grant"
            }),
        ));

        assert_eq!(shell_response.error, None);
        let result = shell_response.result.as_ref().unwrap();
        assert_eq!(result["exit_code"], 0);
        assert!(result["content"]
            .as_str()
            .unwrap()
            .contains("approval grant works"));
    }

    #[test]
    fn tool_executor_forwards_top_level_context_to_sensitive_tool() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ShellExecute,
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
            ]),
        );
        let request_response = router.dispatch(&WorkerRequest::new(
            "req-executor-grant-request",
            "trace-executor-grant",
            "permission_profile.request_tool_approval",
            json!({
                "toolId": "shell.execute",
                "runId": "run-executor-grant",
                "sessionId": "session-executor-grant",
                "arguments": { "command": "echo executor grant works" }
            }),
        ));
        assert_eq!(request_response.error, None);
        let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        let resolve_response = router.dispatch(&WorkerRequest::new(
            "req-executor-grant-resolve",
            "trace-executor-grant",
            "permission_profile.resolve_tool_approval",
            json!({
                "sessionId": "session-executor-grant",
                "approvalId": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ));
        assert_eq!(resolve_response.error, None);

        let executor_response = router.dispatch(&WorkerRequest::new(
            "req-executor-grant-shell",
            "trace-executor-grant",
            "tool_executor.execute",
            json!({
                "toolId": "shell.execute",
                "sessionId": "session-executor-grant",
                "runId": "run-executor-grant",
                "arguments": {
                    "command": "echo executor grant works",
                    "working_dir": ".",
                    "timeout": 5
                }
            }),
        ));

        assert_eq!(executor_response.error, None);
        let result = executor_response.result.as_ref().unwrap();
        assert_eq!(result["result"]["exit_code"], 0);
        assert!(result["result"]["content"]
            .as_str()
            .unwrap()
            .contains("executor grant works"));
    }

    #[test]
    fn dispatches_thread_restore_checkpoint_from_thread_history() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-restore-create",
            "trace-thread-restore",
            "thread.create",
            json!({
                "threadId": "thread-restore-checkpoint",
                "title": "Restore checkpoint thread"
            }),
        ));
        assert_eq!(create.error, None);
        let start = router.dispatch(&WorkerRequest::new(
            "req-thread-restore-start",
            "trace-thread-restore",
            "thread.start_turn",
            json!({
                "threadId": "thread-restore-checkpoint",
                "runId": "run-restore-checkpoint",
                "turnId": "turn-restore-checkpoint",
                "input": { "content": "prepare checkpoint" }
            }),
        ));
        assert_eq!(start.error, None);
        let checkpoint = router.dispatch(&WorkerRequest::new(
            "req-thread-restore-checkpoint",
            "trace-thread-restore",
            "thread.apply_op",
            json!({
                "threadId": "thread-restore-checkpoint",
                "op": {
                    "type": "checkpoint",
                    "runId": "run-restore-checkpoint",
                    "turnId": "turn-restore-checkpoint",
                    "checkpointId": "checkpoint-restore-1",
                    "label": "Before tool execution",
                    "restorePayload": {
                        "phase": "before_tool",
                        "pendingToolCalls": [{ "id": "call-1", "name": "workspace.read_file" }]
                    }
                }
            }),
        ));
        assert_eq!(checkpoint.error, None);
        let after_checkpoint = router.dispatch(&WorkerRequest::new(
            "req-thread-restore-after-checkpoint",
            "trace-thread-restore",
            "thread.apply_op",
            json!({
                "threadId": "thread-restore-checkpoint",
                "op": {
                    "type": "runtime_event",
                    "runId": "run-restore-checkpoint",
                    "turnId": "turn-restore-checkpoint",
                    "eventName": "agent.after_checkpoint",
                    "source": "test",
                    "visibility": "internal",
                    "payload": { "after": true }
                }
            }),
        ));
        assert_eq!(after_checkpoint.error, None);

        let response = router.dispatch(&WorkerRequest::new(
            "req-thread-restore",
            "trace-thread-restore",
            "thread.restore_checkpoint",
            json!({
                "threadId": "thread-restore-checkpoint",
                "checkpointId": "checkpoint-restore-1"
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["checkpoint"]["checkpointId"], "checkpoint-restore-1");
        assert_eq!(result["checkpoint"]["label"], "Before tool execution");
        assert_eq!(result["restorePayload"]["phase"], "before_tool");
        assert_eq!(
            result["restorePayload"]["pendingToolCalls"][0]["name"],
            "workspace.read_file"
        );
        assert_eq!(
            result["snapshot"]["items"][0]["kind"]["type"],
            "checkpoint_created"
        );
        assert_eq!(result["snapshot"]["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            result["snapshot"]["items"][1]["kind"]["payload"]["eventName"],
            "agent.after_checkpoint"
        );
    }

    #[test]
    fn dispatches_thread_restore_checkpoint_defaults_to_latest_checkpoint() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-restore-latest-create",
            "trace-thread-restore-latest",
            "thread.create",
            json!({ "threadId": "thread-restore-latest" }),
        ));
        assert_eq!(create.error, None);
        let start = router.dispatch(&WorkerRequest::new(
            "req-thread-restore-latest-start",
            "trace-thread-restore-latest",
            "thread.start_turn",
            json!({
                "threadId": "thread-restore-latest",
                "runId": "run-restore-latest",
                "turnId": "turn-restore-latest",
                "input": { "content": "make checkpoints" }
            }),
        ));
        assert_eq!(start.error, None);
        for (checkpoint_id, phase) in [
            ("checkpoint-restore-old", "old"),
            ("checkpoint-restore-new", "new"),
        ] {
            let response = router.dispatch(&WorkerRequest::new(
                format!("req-thread-restore-latest-{phase}"),
                "trace-thread-restore-latest",
                "thread.apply_op",
                json!({
                    "threadId": "thread-restore-latest",
                    "op": {
                        "type": "checkpoint",
                        "runId": "run-restore-latest",
                        "turnId": "turn-restore-latest",
                        "checkpointId": checkpoint_id,
                        "restorePayload": { "phase": phase }
                    }
                }),
            ));
            assert_eq!(response.error, None);
        }

        let response = router.dispatch(&WorkerRequest::new(
            "req-thread-restore-latest",
            "trace-thread-restore-latest",
            "thread.restore_checkpoint",
            json!({ "threadId": "thread-restore-latest" }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(
            result["checkpoint"]["checkpointId"],
            "checkpoint-restore-new"
        );
        assert_eq!(result["restorePayload"]["phase"], "new");
        assert_eq!(
            result["snapshot"]["latestCheckpoint"]["checkpointId"],
            "checkpoint-restore-new"
        );
    }

    #[test]
    fn dispatches_thread_agent_registry_for_parent_and_child_threads() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let parent = router.dispatch(&WorkerRequest::new(
            "req-thread-agent-registry-parent",
            "trace-thread-agent-registry",
            "thread.create",
            json!({
                "threadId": "thread-agent-parent",
                "title": "Main thread",
                "sessionKey": "session-agent-registry",
                "source": "agent_run"
            }),
        ));
        assert_eq!(parent.error, None);
        let parent_start = router.dispatch(&WorkerRequest::new(
            "req-thread-agent-registry-parent-start",
            "trace-thread-agent-registry",
            "thread.start_turn",
            json!({
                "threadId": "thread-agent-parent",
                "runId": "run-agent-parent",
                "turnId": "turn-agent-parent",
                "input": { "content": "coordinate child work" }
            }),
        ));
        assert_eq!(parent_start.error, None);
        let child = router.dispatch(&WorkerRequest::new(
            "req-thread-agent-registry-child",
            "trace-thread-agent-registry",
            "thread.create",
            json!({
                "threadId": "thread-agent-child",
                "title": "Research child",
                "sessionKey": "session-agent-registry",
                "parentThreadId": "thread-agent-parent",
                "source": "subagent",
                "metadata": {
                    "extra": {
                        "agentControl": {
                            "agentId": "child-agent-1",
                            "agentPath": ["main", "child-agent-1"],
                            "parentThreadId": "thread-agent-parent",
                            "parentRunId": "run-agent-parent",
                            "childRunId": "run-agent-child",
                            "role": "research",
                            "nickname": "Researcher",
                            "depth": 1,
                            "capacity": { "maxActivePerSession": 4 },
                            "lifecycle": {
                                "status": "awaiting_approval",
                                "active": true,
                                "terminal": false,
                                "mailboxDepth": 2,
                                "pendingApproval": { "approvalId": "approval-child-1" }
                            }
                        }
                    }
                }
            }),
        ));
        assert_eq!(child.error, None);
        let child_start = router.dispatch(&WorkerRequest::new(
            "req-thread-agent-registry-child-start",
            "trace-thread-agent-registry",
            "thread.start_turn",
            json!({
                "threadId": "thread-agent-child",
                "runId": "run-agent-child",
                "turnId": "turn-agent-child",
                "input": { "content": "research task" }
            }),
        ));
        assert_eq!(child_start.error, None);
        let checkpoint = router.dispatch(&WorkerRequest::new(
            "req-thread-agent-registry-child-checkpoint",
            "trace-thread-agent-registry",
            "thread.apply_op",
            json!({
                "threadId": "thread-agent-child",
                "op": {
                    "type": "checkpoint",
                    "runId": "run-agent-child",
                    "turnId": "turn-agent-child",
                    "checkpointId": "checkpoint-child-agent",
                    "restorePayload": { "phase": "child_waiting" }
                }
            }),
        ));
        assert_eq!(checkpoint.error, None);
        let approval = router.dispatch(&WorkerRequest::new(
            "req-thread-agent-registry-child-approval",
            "trace-thread-agent-registry",
            "thread.apply_op",
            json!({
                "threadId": "thread-agent-child",
                "op": {
                    "type": "approval_request",
                    "runId": "run-agent-child",
                    "turnId": "turn-agent-child",
                    "approvalId": "approval-child-1",
                    "summary": "Allow child tool?"
                }
            }),
        ));
        assert_eq!(approval.error, None);

        let response = router.dispatch(&WorkerRequest::new(
            "req-thread-agent-registry",
            "trace-thread-agent-registry",
            "thread.agent_registry",
            json!({ "threadId": "thread-agent-parent" }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["rootThreadId"], "thread-agent-parent");
        assert_eq!(result["total"], 2);
        assert_eq!(result["activeCount"], 2);
        assert_eq!(result["waitingForApprovalCount"], 1);
        assert_eq!(result["agents"][0]["threadId"], "thread-agent-parent");
        assert_eq!(result["agents"][0]["role"], "main");
        assert_eq!(result["agents"][0]["childCount"], 1);
        assert_eq!(result["agents"][1]["agentId"], "child-agent-1");
        assert_eq!(result["agents"][1]["parentThreadId"], "thread-agent-parent");
        assert_eq!(result["agents"][1]["role"], "research");
        assert_eq!(result["agents"][1]["nickname"], "Researcher");
        assert_eq!(
            result["agents"][1]["latestCheckpoint"]["checkpointId"],
            "checkpoint-child-agent"
        );
        assert!(result["agents"][1]["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "approval_request"));
        assert_eq!(
            result["agents"][1]["pendingApproval"]["approvalId"],
            "approval-child-1"
        );
    }

    #[test]
    fn dispatches_thread_activity_for_activity_rail_summary() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create_parent = router.dispatch(&WorkerRequest::new(
            "req-thread-activity-parent",
            "trace-thread-activity",
            "thread.create",
            json!({
                "threadId": "thread-activity-parent",
                "title": "Activity parent",
                "sessionKey": "session-activity-summary"
            }),
        ));
        assert_eq!(create_parent.error, None);
        let start_parent = router.dispatch(&WorkerRequest::new(
            "req-thread-activity-parent-start",
            "trace-thread-activity",
            "thread.start_turn",
            json!({
                "threadId": "thread-activity-parent",
                "runId": "run-activity-parent",
                "turnId": "turn-activity-parent",
                "input": { "content": "show activity" }
            }),
        ));
        assert_eq!(start_parent.error, None);
        for (request_id, op) in [
            (
                "req-thread-activity-checkpoint",
                json!({
                    "type": "checkpoint",
                    "runId": "run-activity-parent",
                    "turnId": "turn-activity-parent",
                    "checkpointId": "checkpoint-activity-parent",
                    "label": "Before tool",
                    "restorePayload": { "phase": "before_tool" }
                }),
            ),
            (
                "req-thread-activity-tool-start",
                json!({
                    "type": "tool_call_started",
                    "runId": "run-activity-parent",
                    "turnId": "turn-activity-parent",
                    "toolCallId": "tool-activity-1",
                    "toolName": "workspace.read_file",
                    "args": { "path": "notes/today.md" }
                }),
            ),
            (
                "req-thread-activity-approval",
                json!({
                    "type": "approval_request",
                    "runId": "run-activity-parent",
                    "turnId": "turn-activity-parent",
                    "approvalId": "approval-activity-1",
                    "summary": "Allow workspace read?"
                }),
            ),
        ] {
            let response = router.dispatch(&WorkerRequest::new(
                request_id,
                "trace-thread-activity",
                "thread.apply_op",
                json!({
                    "threadId": "thread-activity-parent",
                    "op": op
                }),
            ));
            assert_eq!(response.error, None);
        }
        let create_child = router.dispatch(&WorkerRequest::new(
            "req-thread-activity-child",
            "trace-thread-activity",
            "thread.create",
            json!({
                "threadId": "thread-activity-child",
                "title": "Activity child",
                "sessionKey": "session-activity-summary",
                "parentThreadId": "thread-activity-parent",
                "source": "subagent",
                "metadata": {
                    "extra": {
                        "agentControl": {
                            "agentId": "child-activity-agent",
                            "agentPath": ["main", "child-activity-agent"],
                            "parentThreadId": "thread-activity-parent",
                            "childRunId": "run-activity-child",
                            "role": "research",
                            "nickname": "Activity child",
                            "depth": 1,
                            "lifecycle": {
                                "status": "running",
                                "active": true,
                                "terminal": false
                            }
                        }
                    }
                }
            }),
        ));
        assert_eq!(create_child.error, None);
        let start_child = router.dispatch(&WorkerRequest::new(
            "req-thread-activity-child-start",
            "trace-thread-activity",
            "thread.start_turn",
            json!({
                "threadId": "thread-activity-child",
                "runId": "run-activity-child",
                "turnId": "turn-activity-child",
                "input": { "content": "child work" }
            }),
        ));
        assert_eq!(start_child.error, None);

        let response = router.dispatch(&WorkerRequest::new(
            "req-thread-activity",
            "trace-thread-activity",
            "thread.activity",
            json!({ "threadId": "thread-activity-parent" }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["threadId"], "thread-activity-parent");
        assert_eq!(result["summary"]["pendingApprovals"], 1);
        assert_eq!(result["summary"]["runningTools"], 1);
        assert_eq!(result["summary"]["checkpoints"], 1);
        assert_eq!(result["summary"]["activeChildren"], 1);
        assert_eq!(
            result["pendingApprovals"][0]["approvalId"],
            "approval-activity-1"
        );
        assert_eq!(result["runningTools"][0]["toolCallId"], "tool-activity-1");
        assert_eq!(
            result["checkpoints"][0]["checkpointId"],
            "checkpoint-activity-parent"
        );
        assert_eq!(
            result["activeChildren"][0]["child"]["threadId"],
            "thread-activity-child"
        );
        assert_eq!(result["agents"]["activeCount"], 2);
    }

    #[test]
    fn dispatches_thread_activity_excludes_completed_tool_calls() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        assert_eq!(
            router
                .dispatch(&WorkerRequest::new(
                    "req-thread-activity-completed-tool-create",
                    "trace-thread-activity-completed-tool",
                    "thread.create",
                    json!({ "threadId": "thread-activity-completed-tool" }),
                ))
                .error,
            None
        );
        assert_eq!(
            router
                .dispatch(&WorkerRequest::new(
                    "req-thread-activity-completed-tool-start",
                    "trace-thread-activity-completed-tool",
                    "thread.start_turn",
                    json!({
                        "threadId": "thread-activity-completed-tool",
                        "runId": "run-activity-completed-tool",
                        "turnId": "turn-activity-completed-tool",
                        "input": { "content": "run completed tool" }
                    }),
                ))
                .error,
            None
        );
        for (request_id, op) in [
            (
                "req-thread-activity-completed-tool-call",
                json!({
                    "type": "tool_call_started",
                    "runId": "run-activity-completed-tool",
                    "turnId": "turn-activity-completed-tool",
                    "toolCallId": "tool-completed-1",
                    "toolName": "workspace.read_file",
                    "args": { "path": "notes/today.md" }
                }),
            ),
            (
                "req-thread-activity-completed-tool-result",
                json!({
                    "type": "tool_result",
                    "runId": "run-activity-completed-tool",
                    "turnId": "turn-activity-completed-tool",
                    "toolCallId": "tool-completed-1",
                    "toolName": "workspace.read_file",
                    "output": { "contents": "done" }
                }),
            ),
        ] {
            assert_eq!(
                router
                    .dispatch(&WorkerRequest::new(
                        request_id,
                        "trace-thread-activity-completed-tool",
                        "thread.apply_op",
                        json!({
                            "threadId": "thread-activity-completed-tool",
                            "op": op
                        }),
                    ))
                    .error,
                None
            );
        }

        let response = router.dispatch(&WorkerRequest::new(
            "req-thread-activity-completed-tool",
            "trace-thread-activity-completed-tool",
            "thread.activity",
            json!({ "threadId": "thread-activity-completed-tool" }),
        ));

        assert_eq!(response.error, None);
        assert_eq!(
            response.result.as_ref().unwrap()["summary"]["runningTools"],
            0
        );
        assert!(response.result.as_ref().unwrap()["runningTools"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn dispatches_tool_executor_execute_for_registered_read_tool() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello from executor");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-tool-executor-read",
            "trace-tool-executor",
            "tool_executor.execute",
            json!({
                "toolId": "workspace.read_file",
                "arguments": { "path": "notes/today.md" }
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["toolId"], "workspace.read_file");
        assert_eq!(result["method"], "workspace.read_file");
        assert_eq!(result["namespace"], "workspace");
        assert_eq!(result["exposure"], "model");
        assert_eq!(result["approval"]["required"], false);
        assert_eq!(result["permission"]["decision"], "allow");
        assert_eq!(result["permission"]["requiresApproval"], false);
        assert_eq!(
            result["permission"]["tool"]["toolId"],
            "workspace.read_file"
        );
        assert_eq!(result["result"]["path"], "notes/today.md");
        assert_eq!(result["result"]["contents"], "hello from executor");
    }

    #[test]
    fn dispatches_tool_executor_records_thread_tool_lifecycle() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello thread executor");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::FsWorkspaceRead,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-tool-executor-thread-create",
            "trace-tool-executor-thread",
            "thread.create",
            json!({
                "threadId": "thread-tool-executor",
                "title": "Tool executor thread"
            }),
        ));
        assert_eq!(create.error, None);
        let start = router.dispatch(&WorkerRequest::new(
            "req-tool-executor-thread-start",
            "trace-tool-executor-thread",
            "thread.start_turn",
            json!({
                "threadId": "thread-tool-executor",
                "runId": "run-tool-executor",
                "turnId": "turn-tool-executor",
                "input": { "content": "read notes" }
            }),
        ));
        assert_eq!(start.error, None);

        let response = router.dispatch(&WorkerRequest::new(
            "req-tool-executor-thread-read",
            "trace-tool-executor-thread",
            "tool_executor.execute",
            json!({
                "toolId": "workspace.read_file",
                "threadId": "thread-tool-executor",
                "runId": "run-tool-executor",
                "turnId": "turn-tool-executor",
                "toolCallId": "call-tool-executor-read",
                "arguments": { "path": "notes/today.md" }
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["threadId"], "thread-tool-executor");
        assert_eq!(result["runId"], "run-tool-executor");
        assert_eq!(result["toolCallId"], "call-tool-executor-read");
        assert_eq!(result["appendedItems"].as_array().unwrap().len(), 2);
        assert_eq!(
            result["appendedItems"][0]["kind"]["type"],
            "tool_call_started"
        );
        assert_eq!(
            result["appendedItems"][1]["kind"]["type"],
            "tool_call_output"
        );
        assert_eq!(
            result["appendedItems"][1]["parentItemId"],
            result["appendedItems"][0]["itemId"]
        );

        let snapshot = router.dispatch(&WorkerRequest::new(
            "req-tool-executor-thread-snapshot",
            "trace-tool-executor-thread",
            "thread.read",
            json!({ "threadId": "thread-tool-executor" }),
        ));
        assert_eq!(snapshot.error, None);
        let item_kinds = snapshot.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec![
                "user_message",
                "agent_run_started",
                "tool_call_started",
                "tool_call_output"
            ]
        );
        assert_eq!(
            snapshot.result.as_ref().unwrap()["items"][3]["kind"]["payload"]["output"]["contents"],
            "hello thread executor"
        );
    }

    #[test]
    fn dispatches_tool_executor_rejects_unavailable_registered_tool() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-tool-executor-shell-denied",
            "trace-tool-executor",
            "tool_executor.execute",
            json!({
                "toolId": "shell.execute",
                "arguments": {
                    "command": "echo blocked",
                    "sessionId": "session-1",
                    "runId": "run-1"
                }
            }),
        ));

        let error = response
            .error
            .expect("unavailable registered tool should be rejected");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.message, "registered tool is unavailable");
        assert_eq!(error.details["toolId"], "shell.execute");
        assert_eq!(error.details["targetMethod"], "shell.execute");
        assert_eq!(
            error.details["missingCapabilities"],
            json!(["shell.execute"])
        );
    }

    #[test]
    fn dispatches_tool_executor_preserves_sensitive_tool_approval_boundary() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ShellExecute]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-tool-executor-shell-approval",
            "trace-tool-executor",
            "tool_executor.execute",
            json!({
                "toolId": "shell.execute",
                "arguments": {
                    "command": "echo needs approval",
                    "sessionId": "session-1",
                    "runId": "run-1"
                }
            }),
        ));

        let error = response
            .error
            .expect("sensitive registered tool should still require approval");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.message, "approval required for sensitive operation");
        assert_eq!(error.details["method"], "shell.execute");
        assert_eq!(error.details["boundary"], "security");
        assert_eq!(error.details["category"], "shell");
    }

    #[test]
    fn dispatches_thread_read_before_sequence_page() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-read-before-create",
            "trace-thread-read-before",
            "thread.create",
            json!({ "threadId": "thread-read-before", "title": "Paged thread" }),
        ));
        assert_eq!(create.error, None);

        let items = (1..=5)
            .map(|index| {
                json!({
                    "itemId": format!("thread-read-before-item-{index}"),
                    "threadId": "",
                    "runId": "run-read-before",
                    "turnId": "turn-read-before",
                    "sequence": 0,
                    "createdAt": format!("2026-07-05T00:00:0{index}Z"),
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": format!("Message {index}") }
                    }
                })
            })
            .collect::<Vec<_>>();
        let append = router.dispatch(&WorkerRequest::new(
            "req-thread-read-before-append",
            "trace-thread-read-before",
            "thread.append_items",
            json!({ "threadId": "thread-read-before", "items": items }),
        ));
        assert_eq!(append.error, None);

        let page = router.dispatch(&WorkerRequest::new(
            "req-thread-read-before-page",
            "trace-thread-read-before",
            "thread.read",
            json!({ "threadId": "thread-read-before", "limit": 2, "beforeSequence": 5 }),
        ));
        assert_eq!(page.error, None);
        let items = page.result.as_ref().unwrap()["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["sequence"], 3);
        assert_eq!(items[1]["sequence"], 4);
        assert_eq!(
            page.result.as_ref().unwrap()["pagination"]["previousCursor"],
            "3"
        );
        assert_eq!(
            page.result.as_ref().unwrap()["pagination"]["hasMoreBefore"],
            true
        );

        let checkpoint_append = router.dispatch(&WorkerRequest::new(
            "req-thread-read-checkpoint-append",
            "trace-thread-read-before",
            "thread.append_items",
            json!({
                "threadId": "thread-read-before",
                "items": [
                    {
                        "itemId": "thread-read-before-checkpoint",
                        "threadId": "",
                        "runId": "run-read-before",
                        "turnId": "turn-read-before",
                        "sequence": 0,
                        "createdAt": "2026-07-05T00:00:06Z",
                        "kind": {
                            "type": "checkpoint_created",
                            "payload": {
                                "checkpointId": "checkpoint-read-before",
                                "runId": "run-read-before",
                                "restorePayload": { "phase": "awaiting_tool" }
                            }
                        }
                    },
                    {
                        "itemId": "thread-read-before-after-checkpoint",
                        "threadId": "",
                        "runId": "run-read-before",
                        "turnId": "turn-read-before",
                        "sequence": 0,
                        "createdAt": "2026-07-05T00:00:07Z",
                        "kind": {
                            "type": "user_message",
                            "payload": { "text": "After checkpoint" }
                        }
                    }
                ]
            }),
        ));
        assert_eq!(checkpoint_append.error, None);

        let checkpoint_page = router.dispatch(&WorkerRequest::new(
            "req-thread-read-checkpoint-page",
            "trace-thread-read-before",
            "thread.read",
            json!({
                "threadId": "thread-read-before",
                "checkpointId": "checkpoint-read-before"
            }),
        ));
        assert_eq!(checkpoint_page.error, None);
        let checkpoint_items = checkpoint_page.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap();
        assert_eq!(checkpoint_items[0]["sequence"], 6);
        assert_eq!(checkpoint_items[0]["kind"]["type"], "checkpoint_created");
        assert_eq!(checkpoint_items[1]["sequence"], 7);
        assert_eq!(
            checkpoint_page.result.as_ref().unwrap()["latestCheckpoint"]["checkpointId"],
            "checkpoint-read-before"
        );
    }

    #[test]
    fn dispatches_thread_append_items_idempotently_by_client_event_id() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-idempotent-create",
            "trace-thread-idempotent",
            "thread.create",
            json!({ "title": "Idempotent thread" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let payload = json!({
            "threadId": thread_id,
            "clientEventId": "client-event-1",
            "items": [{
                "itemId": "",
                "threadId": "",
                "sequence": 0,
                "createdAt": "",
                "kind": {
                    "type": "user_message",
                    "payload": { "text": "retry-safe input" }
                }
            }]
        });

        let first = router.dispatch(&WorkerRequest::new(
            "req-thread-idempotent-first",
            "trace-thread-idempotent",
            "thread.append_items",
            payload.clone(),
        ));
        assert_eq!(first.error, None);
        let first_item_id = first.result.as_ref().unwrap()["items"][0]["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let retry = router.dispatch(&WorkerRequest::new(
            "req-thread-idempotent-retry",
            "trace-thread-idempotent",
            "thread.append_items",
            payload,
        ));
        assert_eq!(retry.error, None);
        assert_eq!(
            retry.result.as_ref().unwrap()["items"][0]["itemId"],
            first_item_id
        );
        assert_eq!(retry.result.as_ref().unwrap()["items"][0]["sequence"], 1);

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-idempotent-read",
            "trace-thread-idempotent",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(read.error, None);
        assert_eq!(read.result.as_ref().unwrap()["pagination"]["itemCount"], 1);
        assert_eq!(
            read.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
            "retry-safe input"
        );
    }

    #[test]
    fn dispatches_thread_apply_op_for_turn_lifecycle() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-op-create",
            "trace-thread-op",
            "thread.create",
            json!({ "title": "Thread op" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let user_input = router.dispatch(&WorkerRequest::new(
            "req-thread-op-user-input",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "user-input-client-1",
                "op": {
                    "type": "user_input",
                    "runId": "run-op-1",
                    "input": { "text": "Summarize this document" },
                    "model": "deepseek-v4-flash"
                }
            }),
        ));
        assert_eq!(user_input.error, None);
        assert_eq!(
            user_input.result.as_ref().unwrap()["run"]["runId"],
            "run-op-1"
        );
        assert_eq!(
            user_input.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "user_message"
        );
        let first_user_item_id = user_input.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
            .as_str()
            .unwrap()
            .to_string();
        let first_started_item_id = user_input.result.as_ref().unwrap()["appendedItems"][1]
            ["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let user_input_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-op-user-input-retry",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "user-input-client-1",
                "op": {
                    "type": "user_input",
                    "runId": "run-op-1",
                    "input": { "text": "This retry must not append" },
                    "model": "deepseek-v4-flash"
                }
            }),
        ));
        assert_eq!(user_input_retry.error, None);
        assert_eq!(
            user_input_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
            first_user_item_id
        );
        assert_eq!(
            user_input_retry.result.as_ref().unwrap()["appendedItems"][1]["itemId"],
            first_started_item_id
        );
        assert_eq!(
            user_input_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["text"],
            "Summarize this document"
        );

        let continue_run = router.dispatch(&WorkerRequest::new(
            "req-thread-op-continue",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "continue-client-1",
                "op": {
                    "type": "continue_run",
                    "input": { "approval": "continue" }
                }
            }),
        ));
        assert_eq!(continue_run.error, None);
        assert_eq!(
            continue_run.result.as_ref().unwrap()["run"]["runId"],
            "run-op-1"
        );
        assert_eq!(
            continue_run.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "event"
        );
        let continue_item_id = continue_run.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let continue_run_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-op-continue-retry",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "continue-client-1",
                "op": {
                    "type": "continue_run",
                    "input": { "approval": "retry should not append" }
                }
            }),
        ));
        assert_eq!(continue_run_retry.error, None);
        assert_eq!(
            continue_run_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
            continue_item_id
        );
        assert_eq!(
            continue_run_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["payload"]["approval"],
            "continue"
        );

        let checkpoint = router.dispatch(&WorkerRequest::new(
            "req-thread-op-checkpoint",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "checkpoint",
                    "checkpointId": "checkpoint-op-1",
                    "label": "After outline",
                    "restorePayload": {
                        "phase": "outlined",
                        "note": "resume from outline"
                    }
                }
            }),
        ));
        assert_eq!(checkpoint.error, None);
        assert_eq!(
            checkpoint.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "checkpoint_created"
        );
        assert_eq!(
            checkpoint.result.as_ref().unwrap()["snapshot"]["latestCheckpoint"]["checkpointId"],
            "checkpoint-op-1"
        );
        assert_eq!(
            checkpoint.result.as_ref().unwrap()["snapshot"]["latestCheckpoint"]["restorePayload"]
                ["phase"],
            "outlined"
        );

        let approval_request = router.dispatch(&WorkerRequest::new(
            "req-thread-op-approval-request",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "approval_request",
                    "approvalId": "approval-op-1",
                    "summary": "Allow workspace read",
                    "scope": "once",
                    "payload": {
                        "reason": "Read workspace file"
                    }
                }
            }),
        ));
        assert_eq!(approval_request.error, None);
        assert_eq!(
            approval_request.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "approval_requested"
        );
        let approval_request_item_id = approval_request.result.as_ref().unwrap()["appendedItems"]
            [0]["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let tool_call_start = router.dispatch(&WorkerRequest::new(
            "req-thread-op-tool-call-start",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "tool_call_started",
                    "toolCallId": "tool-call-op-1",
                    "toolName": "workspace.read_file",
                    "args": {
                        "path": "README.md"
                    }
                }
            }),
        ));
        assert_eq!(tool_call_start.error, None);
        assert_eq!(
            tool_call_start.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "tool_call_started"
        );
        let tool_call_start_item_id = tool_call_start.result.as_ref().unwrap()["appendedItems"][0]
            ["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let approval = router.dispatch(&WorkerRequest::new(
            "req-thread-op-approval",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "approval_decision",
                    "approvalId": "approval-op-1",
                    "approved": true,
                    "scope": "once",
                    "guidance": "Allowed for this run"
                }
            }),
        ));
        assert_eq!(approval.error, None);
        assert_eq!(
            approval.result.as_ref().unwrap()["run"]["runId"],
            "run-op-1"
        );
        assert_eq!(
            approval.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "approval_resolved"
        );
        assert_eq!(
            approval.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["approvalId"],
            "approval-op-1"
        );
        assert_eq!(
            approval.result.as_ref().unwrap()["appendedItems"][0]["parentItemId"],
            approval_request_item_id
        );
        assert_eq!(
            approval.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "running"
        );

        let tool_result = router.dispatch(&WorkerRequest::new(
            "req-thread-op-tool-result",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "tool_result",
                    "toolCallId": "tool-call-op-1",
                    "toolName": "workspace.read_file",
                    "output": { "text": "README contents" }
                }
            }),
        ));
        assert_eq!(tool_result.error, None);
        assert_eq!(
            tool_result.result.as_ref().unwrap()["run"]["runId"],
            "run-op-1"
        );
        assert_eq!(
            tool_result.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "tool_call_output"
        );
        assert_eq!(
            tool_result.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["toolCallId"],
            "tool-call-op-1"
        );
        assert_eq!(
            tool_result.result.as_ref().unwrap()["appendedItems"][0]["parentItemId"],
            tool_call_start_item_id
        );

        let assistant_delta = router.dispatch(&WorkerRequest::new(
            "req-thread-op-assistant-delta",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "assistant_delta",
                    "delta": "The document",
                    "message": {
                        "role": "assistant",
                        "delta": "The document"
                    }
                }
            }),
        ));
        assert_eq!(assistant_delta.error, None);
        assert_eq!(
            assistant_delta.result.as_ref().unwrap()["run"]["runId"],
            "run-op-1"
        );
        assert_eq!(
            assistant_delta.result.as_ref().unwrap()["run"]["active"],
            true
        );
        assert_eq!(
            assistant_delta.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "assistant_message_delta"
        );
        assert_eq!(
            assistant_delta.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["delta"],
            "The document"
        );

        let reasoning = router.dispatch(&WorkerRequest::new(
            "req-thread-op-reasoning",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "reasoning",
                    "summary": "Need to synthesize the uploaded document.",
                    "payload": {
                        "phase": "synthesis"
                    }
                }
            }),
        ));
        assert_eq!(reasoning.error, None);
        assert_eq!(
            reasoning.result.as_ref().unwrap()["run"]["runId"],
            "run-op-1"
        );
        assert_eq!(
            reasoning.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "reasoning"
        );
        assert_eq!(
            reasoning.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["summary"],
            "Need to synthesize the uploaded document."
        );

        let assistant_response = router.dispatch(&WorkerRequest::new(
            "req-thread-op-assistant-response",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "assistant-response-client-1",
                "op": {
                    "type": "assistant_response",
                    "content": "The document is summarized.",
                    "stopReason": "final_response"
                }
            }),
        ));
        assert_eq!(assistant_response.error, None);
        assert_eq!(
            assistant_response.result.as_ref().unwrap()["run"]["runId"],
            "run-op-1"
        );
        assert_eq!(
            assistant_response.result.as_ref().unwrap()["run"]["active"],
            false
        );
        assert_eq!(
            assistant_response.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "assistant_message_completed"
        );
        assert_eq!(
            assistant_response.result.as_ref().unwrap()["appendedItems"][1]["kind"]["type"],
            "agent_run_completed"
        );
        assert_eq!(
            assistant_response.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "idle"
        );
        assert_eq!(
            assistant_response.result.as_ref().unwrap()["snapshot"]["activeRun"],
            json!(null)
        );
        let assistant_message_item_id = assistant_response.result.as_ref().unwrap()
            ["appendedItems"][0]["itemId"]
            .as_str()
            .unwrap()
            .to_string();
        let completion_item_id = assistant_response.result.as_ref().unwrap()["appendedItems"][1]
            ["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let assistant_response_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-op-assistant-response-retry",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "assistant-response-client-1",
                "op": {
                    "type": "assistant_response",
                    "content": "This retry must not append.",
                    "stopReason": "retry"
                }
            }),
        ));
        assert_eq!(assistant_response_retry.error, None);
        assert_eq!(
            assistant_response_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
            assistant_message_item_id
        );
        assert_eq!(
            assistant_response_retry.result.as_ref().unwrap()["appendedItems"][1]["itemId"],
            completion_item_id
        );
        assert_eq!(
            assistant_response_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]
                ["payload"]["text"],
            "The document is summarized."
        );
        assert_eq!(
            assistant_response_retry.result.as_ref().unwrap()["appendedItems"][1]["kind"]
                ["payload"]["stopReason"],
            "final_response"
        );

        let late_tool_result = router.dispatch(&WorkerRequest::new(
            "req-thread-op-late-tool-result",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "tool_result",
                    "runId": "run-op-1",
                    "toolCallId": "tool-call-op-1",
                    "toolName": "workspace.read_file",
                    "output": { "text": "late output" }
                }
            }),
        ));
        assert_eq!(
            late_tool_result.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(
            late_tool_result.error.as_ref().unwrap().message,
            "thread operation targets a run that is not active"
        );

        let continue_without_active_run = router.dispatch(&WorkerRequest::new(
            "req-thread-op-continue-without-active-run",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "continue_run",
                    "input": { "approval": "late continue" }
                }
            }),
        ));
        assert_eq!(
            continue_without_active_run.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(
            continue_without_active_run.error.as_ref().unwrap().message,
            "thread operation requires an active run or explicit runId"
        );

        let second_user_input = router.dispatch(&WorkerRequest::new(
            "req-thread-op-second-user-input",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "user_input",
                    "runId": "run-op-2",
                    "input": { "text": "Start another task" }
                }
            }),
        ));
        assert_eq!(second_user_input.error, None);
        assert_eq!(
            second_user_input.result.as_ref().unwrap()["run"]["runId"],
            "run-op-2"
        );

        let interrupt = router.dispatch(&WorkerRequest::new(
            "req-thread-op-interrupt",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "interrupt-client-1",
                "op": {
                    "type": "interrupt",
                    "reason": "user stopped"
                }
            }),
        ));
        assert_eq!(interrupt.error, None);
        assert_eq!(
            interrupt.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "cancelled"
        );
        assert_eq!(
            interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "idle"
        );
        let cancelled_item_id = interrupt.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let interrupt_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-op-interrupt-retry",
            "trace-thread-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "interrupt-client-1",
                "op": {
                    "type": "interrupt",
                    "reason": "retry should not append"
                }
            }),
        ));
        assert_eq!(interrupt_retry.error, None);
        assert_eq!(
            interrupt_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
            cancelled_item_id
        );
        assert_eq!(
            interrupt_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["reason"],
            "user stopped"
        );
    }

    #[test]
    fn dispatches_thread_apply_op_records_terminal_error() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-error-op-create",
            "trace-thread-error-op",
            "thread.create",
            json!({ "title": "Thread error op", "sessionKey": "session-error-op" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let start = router.dispatch(&WorkerRequest::new(
            "req-thread-error-op-start",
            "trace-thread-error-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "user_input",
                    "runId": "run-error-op-1",
                    "input": "Start risky task"
                }
            }),
        ));
        assert_eq!(start.error, None);

        let failed = router.dispatch(&WorkerRequest::new(
            "req-thread-error-op-fail",
            "trace-thread-error-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "error",
                    "message": "Tool execution failed",
                    "code": "tool_error",
                    "details": { "toolName": "workspace.write_file" }
                }
            }),
        ));
        assert_eq!(failed.error, None);
        assert_eq!(
            failed.result.as_ref().unwrap()["run"]["runId"],
            "run-error-op-1"
        );
        assert_eq!(failed.result.as_ref().unwrap()["run"]["status"], "failed");
        assert_eq!(
            failed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "error"
        );
        assert_eq!(
            failed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["message"],
            "Tool execution failed"
        );
        assert_eq!(
            failed.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "failed"
        );
        assert_eq!(
            failed.result.as_ref().unwrap()["snapshot"]["activeRun"],
            json!(null)
        );

        let run_get = router.dispatch(&WorkerRequest::new(
            "req-thread-error-op-run-get",
            "trace-thread-error-op",
            "agent_run.get",
            json!({ "session_id": "session-error-op", "run_id": "run-error-op-1" }),
        ));
        assert_eq!(run_get.error, None);
        assert_eq!(run_get.result.as_ref().unwrap()["status"], "failed");
        assert_eq!(
            run_get.result.as_ref().unwrap()["error"]["message"],
            "thread run failed"
        );
    }

    #[test]
    fn dispatches_thread_apply_op_for_subagent_events() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-op-subagent-create",
            "trace-thread-op-subagent",
            "thread.create",
            json!({ "title": "Thread op subagent" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let user_input = router.dispatch(&WorkerRequest::new(
            "req-thread-op-subagent-user-input",
            "trace-thread-op-subagent",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "user_input",
                    "runId": "run-subagent-op-1",
                    "input": { "text": "Delegate this task" }
                }
            }),
        ));
        assert_eq!(user_input.error, None);

        let spawned = router.dispatch(&WorkerRequest::new(
            "req-thread-op-subagent-spawned",
            "trace-thread-op-subagent",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "subagent_spawned",
                    "subagentId": "delegate-op-1",
                    "childThreadId": "thread-child-op-1",
                    "childRunId": "run-child-op-1",
                    "name": "Researcher",
                    "task": "Find source material",
                    "payload": {
                        "role": "research"
                    }
                }
            }),
        ));
        assert_eq!(spawned.error, None);
        assert_eq!(
            spawned.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "subagent_spawned"
        );
        assert_eq!(
            spawned.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["subagentId"],
            "delegate-op-1"
        );

        let message = router.dispatch(&WorkerRequest::new(
            "req-thread-op-subagent-message",
            "trace-thread-op-subagent",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "subagent_message",
                    "subagentId": "delegate-op-1",
                    "childThreadId": "thread-child-op-1",
                    "childRunId": "run-child-op-1",
                    "content": "I found two relevant sources.",
                    "status": "running",
                    "payload": {
                        "sourceCount": 2
                    }
                }
            }),
        ));
        assert_eq!(message.error, None);
        assert_eq!(
            message.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "subagent_message"
        );
        assert_eq!(
            message.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["content"],
            "I found two relevant sources."
        );

        let completed = router.dispatch(&WorkerRequest::new(
            "req-thread-op-subagent-completed",
            "trace-thread-op-subagent",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "op": {
                    "type": "subagent_completed",
                    "subagentId": "delegate-op-1",
                    "childThreadId": "thread-child-op-1",
                    "childRunId": "run-child-op-1",
                    "status": "completed",
                    "result": {
                        "summary": "Two sources found"
                    }
                }
            }),
        ));
        assert_eq!(completed.error, None);
        assert_eq!(
            completed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "subagent_completed"
        );
        assert_eq!(
            completed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["result"]
                ["summary"],
            "Two sources found"
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-op-subagent-read",
            "trace-thread-op-subagent",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(read.error, None);
        let item_kinds = read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec![
                "user_message",
                "agent_run_started",
                "subagent_spawned",
                "subagent_message",
                "subagent_completed",
            ]
        );
    }

    #[test]
    fn dispatches_thread_apply_op_for_agent_step_events() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-op-step-create",
            "trace-thread-op-step",
            "thread.create",
            json!({
                "threadId": "thread-agent-step-op",
                "title": "Thread op step",
                "sessionKey": "session-agent-step-op"
            }),
        ));
        assert_eq!(create.error, None);

        let user_input = router.dispatch(&WorkerRequest::new(
            "req-thread-op-step-user-input",
            "trace-thread-op-step",
            "thread.apply_op",
            json!({
                "threadId": "thread-agent-step-op",
                "op": {
                    "type": "user_input",
                    "runId": "run-agent-step-op",
                    "input": { "text": "Run a multi-step task" }
                }
            }),
        ));
        assert_eq!(user_input.error, None);

        let step = router.dispatch(&WorkerRequest::new(
            "req-thread-op-step",
            "trace-thread-op-step",
            "thread.apply_op",
            json!({
                "threadId": "thread-agent-step-op",
                "op": {
                    "type": "agent_step",
                    "stepId": "step-plan-1",
                    "name": "Plan",
                    "status": "running",
                    "summary": "Preparing the tool plan",
                    "payload": {
                        "phase": "planning"
                    }
                }
            }),
        ));
        assert_eq!(step.error, None);
        assert_eq!(
            step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "agent_run_step"
        );
        assert_eq!(
            step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["stepId"],
            "step-plan-1"
        );
        assert_eq!(
            step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["eventName"],
            "agent.step"
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-op-step-read",
            "trace-thread-op-step",
            "thread.read",
            json!({ "threadId": "thread-agent-step-op" }),
        ));
        assert_eq!(read.error, None);
        let item_kinds = read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec!["user_message", "agent_run_started", "agent_run_step"]
        );

        let trace = router.dispatch(&WorkerRequest::new(
            "req-thread-op-step-trace",
            "trace-thread-op-step",
            "agent_run.list_trace",
            json!({
                "sessionId": "session-agent-step-op",
                "runId": "run-agent-step-op"
            }),
        ));
        assert_eq!(trace.error, None);
        assert_eq!(
            trace.result.as_ref().unwrap()["items"][0]["eventName"],
            "agent.step"
        );
        assert_eq!(
            trace.result.as_ref().unwrap()["items"][0]["payload"]["summary"],
            "Preparing the tool plan"
        );
    }

    #[test]
    fn dispatches_thread_apply_op_for_runtime_events() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-op-runtime-event-create",
            "trace-thread-op-runtime-event",
            "thread.create",
            json!({
                "threadId": "thread-runtime-event-op",
                "title": "Runtime event op",
                "sessionKey": "session-runtime-event-op"
            }),
        ));
        assert_eq!(create.error, None);

        let user_input = router.dispatch(&WorkerRequest::new(
            "req-thread-op-runtime-event-user-input",
            "trace-thread-op-runtime-event",
            "thread.apply_op",
            json!({
                "threadId": "thread-runtime-event-op",
                "op": {
                    "type": "user_input",
                    "runId": "run-runtime-event-op",
                    "input": { "text": "Search the web" }
                }
            }),
        ));
        assert_eq!(user_input.error, None);

        let runtime_event = router.dispatch(&WorkerRequest::new(
            "req-thread-op-runtime-event",
            "trace-thread-op-runtime-event",
            "thread.apply_op",
            json!({
                "threadId": "thread-runtime-event-op",
                "clientEventId": "runtime-event-client-1",
                "op": {
                    "type": "runtime_event",
                    "eventName": "agent.browser.search",
                    "source": "tool",
                    "visibility": "user",
                    "payload": {
                        "query": "thread event log design",
                        "resultCount": 4
                    }
                }
            }),
        ));
        assert_eq!(runtime_event.error, None);
        assert_eq!(
            runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "event"
        );
        assert_eq!(
            runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["eventName"],
            "agent.browser.search"
        );
        assert_eq!(
            runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["payload"]["resultCount"],
            4
        );
        let runtime_event_item_id = runtime_event.result.as_ref().unwrap()["appendedItems"][0]
            ["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let runtime_event_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-op-runtime-event-retry",
            "trace-thread-op-runtime-event",
            "thread.apply_op",
            json!({
                "threadId": "thread-runtime-event-op",
                "clientEventId": "runtime-event-client-1",
                "op": {
                    "type": "runtime_event",
                    "eventName": "agent.browser.search.retry",
                    "source": "tool",
                    "visibility": "user",
                    "payload": {
                        "query": "this should not be appended",
                        "resultCount": 99
                    }
                }
            }),
        ));
        assert_eq!(runtime_event_retry.error, None);
        assert_eq!(
            runtime_event_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
            runtime_event_item_id
        );
        assert_eq!(
            runtime_event_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["eventName"],
            "agent.browser.search"
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-op-runtime-event-read",
            "trace-thread-op-runtime-event",
            "thread.read",
            json!({ "threadId": "thread-runtime-event-op" }),
        ));
        assert_eq!(read.error, None);
        let item_kinds = read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec!["user_message", "agent_run_started", "event"]
        );

        let trace = router.dispatch(&WorkerRequest::new(
            "req-thread-op-runtime-event-trace",
            "trace-thread-op-runtime-event",
            "agent_run.list_trace",
            json!({
                "sessionId": "session-runtime-event-op",
                "runId": "run-runtime-event-op"
            }),
        ));
        assert_eq!(trace.error, None);
        assert_eq!(
            trace.result.as_ref().unwrap()["items"][0]["eventName"],
            "agent.browser.search"
        );
        assert_eq!(
            trace.result.as_ref().unwrap()["items"][0]["payload"]["query"],
            "thread event log design"
        );
    }

    #[test]
    fn dispatches_thread_apply_op_updates_settings_and_records_item() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-settings-op-create",
            "trace-thread-settings-op",
            "thread.create",
            json!({ "title": "Settings before" }),
        ));
        assert_eq!(create.error, None);
        let thread_id = create.result.as_ref().unwrap()["threadId"]
            .as_str()
            .unwrap()
            .to_string();

        let settings = router.dispatch(&WorkerRequest::new(
            "req-thread-settings-op-apply",
            "trace-thread-settings-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "settings-client-1",
                "op": {
                    "type": "update_settings",
                    "metadata": {
                        "title": "Settings after",
                        "model": "deepseek-v4-flash",
                        "tags": ["thread", "settings"],
                        "extra": { "temperature": 0.2 }
                    },
                    "reason": "user changed model"
                }
            }),
        ));
        assert_eq!(settings.error, None);
        assert_eq!(
            settings.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
            "Settings after"
        );
        assert_eq!(
            settings.result.as_ref().unwrap()["snapshot"]["thread"]["metadata"]["model"],
            "deepseek-v4-flash"
        );
        assert_eq!(
            settings.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
            "settings_changed"
        );
        assert_eq!(
            settings.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["reason"],
            "user changed model"
        );
        assert_eq!(settings.result.as_ref().unwrap()["run"], json!(null));
        let settings_item_id = settings.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
            .as_str()
            .unwrap()
            .to_string();

        let settings_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-settings-op-retry",
            "trace-thread-settings-op",
            "thread.apply_op",
            json!({
                "threadId": thread_id,
                "clientEventId": "settings-client-1",
                "op": {
                    "type": "update_settings",
                    "metadata": {
                        "title": "Retry must not apply",
                        "model": "retry-model",
                        "tags": ["retry"],
                        "extra": { "temperature": 1.0 }
                    },
                    "reason": "retry reason"
                }
            }),
        ));
        assert_eq!(settings_retry.error, None);
        assert_eq!(
            settings_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
            settings_item_id
        );
        assert_eq!(
            settings_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
                ["reason"],
            "user changed model"
        );
        assert_eq!(
            settings_retry.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
            "Settings after"
        );
        assert_eq!(
            settings_retry.result.as_ref().unwrap()["snapshot"]["thread"]["metadata"]["model"],
            "deepseek-v4-flash"
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-settings-op-read",
            "trace-thread-settings-op",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(read.error, None);
        assert_eq!(
            read.result.as_ref().unwrap()["thread"]["title"],
            "Settings after"
        );
        assert_eq!(
            read.result.as_ref().unwrap()["items"][0]["kind"]["type"],
            "settings_changed"
        );
    }

    #[test]
    fn dispatches_thread_apply_op_for_lifecycle_actions() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let create_parent = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-parent",
            "trace-thread-lifecycle-op",
            "thread.create",
            json!({ "threadId": "lifecycle-parent", "title": "Lifecycle parent" }),
        ));
        assert_eq!(create_parent.error, None);
        let create_child = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-child",
            "trace-thread-lifecycle-op",
            "thread.create",
            json!({
                "threadId": "lifecycle-child",
                "title": "Lifecycle child",
                "parentThreadId": "lifecycle-parent",
                "source": "subagent"
            }),
        ));
        assert_eq!(create_child.error, None);

        let archive = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-archive",
            "trace-thread-lifecycle-op",
            "thread.apply_op",
            json!({
                "threadId": "lifecycle-parent",
                "op": {
                    "type": "archive",
                    "archiveChildren": true
                }
            }),
        ));
        assert_eq!(archive.error, None);
        assert_eq!(
            archive.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "archived"
        );
        assert_eq!(archive.result.as_ref().unwrap()["appendedItems"], json!([]));

        let archived_child = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-read-archived-child",
            "trace-thread-lifecycle-op",
            "thread.read",
            json!({ "threadId": "lifecycle-child" }),
        ));
        assert_eq!(archived_child.error, None);
        assert_eq!(
            archived_child.result.as_ref().unwrap()["thread"]["status"],
            "archived"
        );

        let unarchive = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-unarchive",
            "trace-thread-lifecycle-op",
            "thread.apply_op",
            json!({
                "threadId": "lifecycle-parent",
                "op": {
                    "type": "unarchive",
                    "unarchiveChildren": true
                }
            }),
        ));
        assert_eq!(unarchive.error, None);
        assert_eq!(
            unarchive.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
            "empty"
        );

        let fork = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-fork",
            "trace-thread-lifecycle-op",
            "thread.apply_op",
            json!({
                "threadId": "lifecycle-parent",
                "clientEventId": "fork-client-1",
                "op": {
                    "type": "fork",
                    "title": "Lifecycle fork",
                    "includeChildren": true
                }
            }),
        ));
        assert_eq!(fork.error, None);
        let fork_id = fork.result.as_ref().unwrap()["snapshot"]["thread"]["threadId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(fork_id, "lifecycle-parent");
        assert_eq!(
            fork.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
            "Lifecycle fork"
        );
        assert_eq!(
            fork.result.as_ref().unwrap()["snapshot"]["thread"]["parentThreadId"],
            "lifecycle-parent"
        );

        let fork_retry = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-fork-retry",
            "trace-thread-lifecycle-op",
            "thread.apply_op",
            json!({
                "threadId": "lifecycle-parent",
                "clientEventId": "fork-client-1",
                "op": {
                    "type": "fork",
                    "title": "Retry must not fork again",
                    "includeChildren": true
                }
            }),
        ));
        assert_eq!(fork_retry.error, None);
        assert_eq!(
            fork_retry.result.as_ref().unwrap()["snapshot"]["thread"]["threadId"],
            fork_id
        );
        assert_eq!(
            fork_retry.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
            "Lifecycle fork"
        );

        let fork_children = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-fork-children",
            "trace-thread-lifecycle-op",
            "thread.list",
            json!({
                "includeChildThreads": true,
                "parentThreadId": fork_id
            }),
        ));
        assert_eq!(fork_children.error, None);
        assert_eq!(
            fork_children.result.as_ref().unwrap()["threads"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let fork_siblings = router.dispatch(&WorkerRequest::new(
            "req-thread-lifecycle-op-fork-siblings",
            "trace-thread-lifecycle-op",
            "thread.list",
            json!({
                "includeChildThreads": true,
                "parentThreadId": "lifecycle-parent"
            }),
        ));
        assert_eq!(fork_siblings.error, None);
        assert_eq!(
            fork_siblings.result.as_ref().unwrap()["threads"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|thread| thread["source"] == "fork")
                .count(),
            1
        );
    }

    #[test]
    fn dispatches_agent_run_store_round_trip_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );
        let record = json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "status": "running",
            "phase": "active_turn",
            "startedAt": "unix-ms:1",
            "updatedAt": "unix-ms:1",
            "completedAt": null,
            "stopReason": null,
            "model": "fixture-model",
            "provider": "fixture",
            "maxIterations": 4,
            "currentIteration": 0,
            "conversationMessageIds": [],
            "traceMessages": [],
            "traceEvents": [],
            "completedToolResults": [],
            "pendingToolCalls": [],
            "checkpoint": null,
            "artifacts": [],
            "usage": [],
            "error": null
        });

        let upsert = router.dispatch(&WorkerRequest::new(
            "req-upsert",
            "trace-agent-run",
            "agent_run.upsert",
            json!({ "record": record }),
        ));
        let append_trace = router.dispatch(&WorkerRequest::new(
            "req-trace",
            "trace-agent-run",
            "agent_run.append_trace",
            json!({
                "session_id": "session-1",
                "run_id": "run-1",
                "event": {
                    "eventId": "trace-tool-result",
                    "eventName": "agent.tool.result",
                    "payload": {
                        "toolCallId": "call-1",
                        "toolName": "workspace.read_file",
                        "content": "README"
                    }
                }
            }),
        ));
        let append_second_trace = router.dispatch(&WorkerRequest::new(
            "req-trace-2",
            "trace-agent-run",
            "agent_run.append_trace",
            json!({
                "session_id": "session-1",
                "run_id": "run-1",
                "event": {
                    "eventId": "trace-done",
                    "eventName": "agent.done",
                    "payload": { "finalContent": "done" }
                }
            }),
        ));
        let set_checkpoint = router.dispatch(&WorkerRequest::new(
            "req-set-checkpoint",
            "trace-agent-run",
            "agent_run.set_checkpoint",
            json!({
                "session_id": "session-1",
                "run_id": "run-1",
                "checkpoint": { "sessionId": "session-1", "runId": "run-1", "phase": "awaiting_tool" }
            }),
        ));
        let get_checkpoint = router.dispatch(&WorkerRequest::new(
            "req-get-checkpoint",
            "trace-agent-run",
            "agent_run.get_checkpoint",
            json!({ "session_id": "session-1", "run_id": "run-1" }),
        ));
        let thread_list = router.dispatch(&WorkerRequest::new(
            "req-thread-list-after-checkpoint",
            "trace-agent-run",
            "thread.list",
            json!({}),
        ));
        let thread_id = thread_list.result.as_ref().unwrap()["threads"][0]["threadId"]
            .as_str()
            .unwrap()
            .to_string();
        let thread_read = router.dispatch(&WorkerRequest::new(
            "req-thread-read-after-checkpoint",
            "trace-agent-run",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        let list = router.dispatch(&WorkerRequest::new(
            "req-list",
            "trace-agent-run",
            "agent_run.list",
            json!({ "sessionId": "session-1" }),
        ));
        let get = router.dispatch(&WorkerRequest::new(
            "req-get",
            "trace-agent-run",
            "agent_run.get",
            json!({ "session_id": "session-1", "run_id": "run-1" }),
        ));
        let trace_page = router.dispatch(&WorkerRequest::new(
            "req-list-trace",
            "trace-agent-run",
            "agent_run.list_trace",
            json!({ "session_id": "session-1", "run_id": "run-1", "limit": 1 }),
        ));
        let runtime_state = router.dispatch(&WorkerRequest::new(
            "req-runtime-state",
            "trace-agent-run",
            "agent_run.runtime_state",
            json!({ "session_id": "session-1", "run_id": "run-1" }),
        ));
        let completed = router.dispatch(&WorkerRequest::new(
            "req-complete",
            "trace-agent-run",
            "agent_run.mark_completed",
            json!({
                "session_id": "session-1",
                "run_id": "run-1",
                "stop_reason": "final_response",
                "final_content": "done"
            }),
        ));
        let get_completed = router.dispatch(&WorkerRequest::new(
            "req-get-completed",
            "trace-agent-run",
            "agent_run.get",
            json!({ "session_id": "session-1", "run_id": "run-1" }),
        ));
        let clear_checkpoint = router.dispatch(&WorkerRequest::new(
            "req-clear-checkpoint",
            "trace-agent-run",
            "agent_run.clear_checkpoint",
            json!({ "session_id": "session-1", "run_id": "run-1" }),
        ));

        assert!(upsert.error.is_none());
        assert!(append_trace.error.is_none());
        assert!(append_second_trace.error.is_none());
        assert!(set_checkpoint.error.is_none());
        assert_eq!(
            get_checkpoint.result.as_ref().unwrap()["checkpoint"]["phase"],
            "awaiting_tool"
        );
        assert_eq!(thread_list.error, None);
        assert_eq!(upsert.result.as_ref().unwrap()["threadId"], thread_id);
        assert_eq!(append_trace.result.as_ref().unwrap()["threadId"], thread_id);
        assert_eq!(
            set_checkpoint.result.as_ref().unwrap()["threadId"],
            thread_id
        );
        assert_eq!(
            thread_read.result.as_ref().unwrap()["latestCheckpoint"]["restorePayload"]["phase"],
            "awaiting_tool"
        );
        assert_eq!(list.result.as_ref().unwrap()["sessionId"], "session-1");
        assert_eq!(list.result.as_ref().unwrap()["runs"][0]["runId"], "run-1");
        assert_eq!(
            list.result.as_ref().unwrap()["runs"][0]["threadId"],
            thread_id
        );
        assert!(list.result.as_ref().unwrap()["runs"][0]
            .get("traceEvents")
            .is_none());
        assert_eq!(get.result.as_ref().unwrap()["threadId"], thread_id);
        assert_eq!(
            get.result.as_ref().unwrap()["traceEvents"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(trace_page.error, None);
        assert_eq!(
            trace_page.result.as_ref().unwrap()["items"][0]["eventName"],
            "agent.tool.result"
        );
        assert_eq!(trace_page.result.as_ref().unwrap()["nextCursor"], "1");
        assert_eq!(runtime_state.error, None);
        assert_eq!(
            runtime_state.result.as_ref().unwrap()["runtimeEvents"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["sessionId"],
            "session-1"
        );
        assert_eq!(
            runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["turnId"],
            "run-1"
        );
        assert_eq!(
            runtime_state.result.as_ref().unwrap()["turnItems"][0]["kind"],
            "tool_call"
        );
        assert_eq!(
            runtime_state.result.as_ref().unwrap()["turnItems"][1]["kind"],
            "assistant_message"
        );
        assert_eq!(completed.result.as_ref().unwrap()["status"], "completed");
        assert_eq!(completed.result.as_ref().unwrap()["phase"], "completed");
        assert_eq!(completed.result.as_ref().unwrap()["threadId"], thread_id);
        assert_eq!(get_completed.error, None);
        assert_eq!(
            get_completed.result.as_ref().unwrap()["threadId"],
            thread_id
        );
        assert_eq!(
            get_completed.result.as_ref().unwrap()["stopReason"],
            "final_response"
        );
        assert_eq!(
            clear_checkpoint.result.as_ref().unwrap()["checkpoint"],
            json!(null)
        );

        let thread_list = router.dispatch(&WorkerRequest::new(
            "req-thread-list-after-agent-run",
            "trace-agent-run",
            "thread.list",
            json!({ "includeArchived": true }),
        ));
        assert_eq!(thread_list.error, None);
        let thread_id = thread_list.result.as_ref().unwrap()["threads"][0]["threadId"]
            .as_str()
            .expect("projected thread id should be present")
            .to_string();
        assert_eq!(
            thread_list.result.as_ref().unwrap()["threads"][0]["sessionKey"],
            "session-1"
        );
        assert_eq!(
            thread_list.result.as_ref().unwrap()["threads"][0]["metadata"]["runCount"],
            1
        );

        let thread_read = router.dispatch(&WorkerRequest::new(
            "req-thread-read-after-agent-run",
            "trace-agent-run",
            "thread.read",
            json!({ "threadId": thread_id }),
        ));
        assert_eq!(thread_read.error, None);
        let item_kinds = thread_read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec![
                "agent_run_started",
                "tool_call_output",
                "assistant_message_completed",
                "checkpoint_created",
                "agent_run_completed",
            ]
        );
    }

    #[test]
    fn dispatches_agent_run_trace_and_runtime_state_from_thread_items() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let create = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-create",
            "trace-thread-backed-run",
            "thread.create",
            json!({
                "threadId": "thread-session-1",
                "title": "Thread-backed run",
                "sessionKey": "session-1",
                "rootRunId": "run-thread-only",
                "activeRunId": "run-thread-only",
                "source": "agent_run"
            }),
        ));
        assert_eq!(create.error, None);

        let append = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-append",
            "trace-thread-backed-run",
            "thread.append_items",
            json!({
                "threadId": "thread-session-1",
                "items": [{
                    "itemId": "agent-run:session-1:run-thread-only:trace:approval-1",
                    "threadId": "",
                    "runId": "run-thread-only",
                    "turnId": "run-thread-only",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:00Z",
                    "kind": {
                        "type": "approval_requested",
                        "payload": {
                            "eventId": "approval-1",
                            "eventName": "agent.awaiting_approval",
                            "sessionId": "session-1",
                            "runId": "run-thread-only",
                            "turnId": "run-thread-only",
                            "sequence": 1,
                            "timestamp": "2026-07-05T00:00:00Z",
                            "payload": {
                                "approvalId": "approval-1",
                                "summary": "Allow workspace.write_file?"
                            }
                        }
                    }
                }]
            }),
        ));
        assert_eq!(append.error, None);

        let run_list = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-list",
            "trace-thread-backed-run",
            "agent_run.list",
            json!({ "sessionId": "session-1" }),
        ));
        assert_eq!(run_list.error, None);
        assert_eq!(run_list.result.as_ref().unwrap()["sessionId"], "session-1");
        assert_eq!(
            run_list.result.as_ref().unwrap()["runs"][0]["runId"],
            "run-thread-only"
        );
        assert_eq!(
            run_list.result.as_ref().unwrap()["runs"][0]["status"],
            "waiting"
        );

        let run_get = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-get",
            "trace-thread-backed-run",
            "agent_run.get",
            json!({ "session_id": "session-1", "run_id": "run-thread-only" }),
        ));
        assert_eq!(run_get.error, None);
        assert_eq!(run_get.result.as_ref().unwrap()["sessionId"], "session-1");
        assert_eq!(run_get.result.as_ref().unwrap()["runId"], "run-thread-only");
        assert_eq!(run_get.result.as_ref().unwrap()["status"], "waiting");
        assert_eq!(
            run_get.result.as_ref().unwrap()["traceEvents"][0]["eventName"],
            "agent.awaiting_approval"
        );

        let trace_page = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-trace",
            "trace-thread-backed-run",
            "agent_run.list_trace",
            json!({ "session_id": "session-1", "run_id": "run-thread-only" }),
        ));
        assert_eq!(trace_page.error, None);
        assert_eq!(
            trace_page.result.as_ref().unwrap()["items"][0]["eventName"],
            "agent.awaiting_approval"
        );

        let runtime_state = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-state",
            "trace-thread-backed-run",
            "agent_run.runtime_state",
            json!({ "session_id": "session-1", "run_id": "run-thread-only" }),
        ));
        assert_eq!(runtime_state.error, None);
        assert_eq!(
            runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["eventName"],
            "agent.awaiting_approval"
        );
        assert_eq!(
            runtime_state.result.as_ref().unwrap()["turnItems"][0]["kind"],
            "approval_request"
        );

        let status = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-status",
            "trace-thread-backed-run",
            "thread.status",
            json!({ "threadId": "thread-session-1" }),
        ));
        assert_eq!(status.error, None);
        assert_eq!(
            status.result.as_ref().unwrap()["activeRun"]["runId"],
            "run-thread-only"
        );
        assert_eq!(
            status.result.as_ref().unwrap()["turnItems"][0]["kind"],
            "approval_request"
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-backed-run-read",
            "trace-thread-backed-run",
            "thread.read",
            json!({ "threadId": "thread-session-1" }),
        ));
        assert_eq!(read.error, None);
        assert_eq!(
            read.result.as_ref().unwrap()["activeRun"]["runId"],
            "run-thread-only"
        );
        assert_eq!(
            read.result.as_ref().unwrap()["turnItems"][0]["kind"],
            "approval_request"
        );
    }

    #[test]
    fn dispatches_thread_status_includes_active_child_activity() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let parent = router.dispatch(&WorkerRequest::new(
            "req-thread-child-activity-parent",
            "trace-thread-child-activity",
            "thread.create",
            json!({
                "threadId": "thread-parent-activity",
                "title": "Parent thread",
                "sessionKey": "session-activity",
                "source": "agent_run"
            }),
        ));
        assert_eq!(parent.error, None);
        let child = router.dispatch(&WorkerRequest::new(
            "req-thread-child-activity-child",
            "trace-thread-child-activity",
            "thread.create",
            json!({
                "threadId": "thread-child-activity",
                "title": "Child worker",
                "sessionKey": "session-activity",
                "rootRunId": "run-child-active",
                "activeRunId": "run-child-active",
                "parentThreadId": "thread-parent-activity",
                "source": "subagent"
            }),
        ));
        assert_eq!(child.error, None);

        let append = router.dispatch(&WorkerRequest::new(
            "req-thread-child-activity-append",
            "trace-thread-child-activity",
            "thread.append_items",
            json!({
                "threadId": "thread-child-activity",
                "items": [{
                    "itemId": "agent-run:session-activity:run-child-active:trace:approval-child",
                    "threadId": "",
                    "runId": "run-child-active",
                    "turnId": "run-child-active",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:01:00Z",
                    "kind": {
                        "type": "approval_requested",
                        "payload": {
                            "eventId": "approval-child",
                            "eventName": "agent.awaiting_approval",
                            "sessionId": "session-activity",
                            "runId": "run-child-active",
                            "turnId": "run-child-active",
                            "sequence": 1,
                            "timestamp": "2026-07-05T00:01:00Z",
                            "payload": {
                                "approvalId": "approval-child",
                                "summary": "Allow child write?"
                            }
                        }
                    }
                }]
            }),
        ));
        assert_eq!(append.error, None);

        let status = router.dispatch(&WorkerRequest::new(
            "req-thread-child-activity-status",
            "trace-thread-child-activity",
            "thread.status",
            json!({ "threadId": "thread-parent-activity" }),
        ));
        assert_eq!(status.error, None);
        assert_eq!(
            status.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
            "thread-child-activity"
        );
        assert_eq!(
            status.result.as_ref().unwrap()["childActivities"][0]["activeRun"]["runId"],
            "run-child-active"
        );
        assert_eq!(
            status.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
            "approval_request"
        );

        let read = router.dispatch(&WorkerRequest::new(
            "req-thread-child-activity-read",
            "trace-thread-child-activity",
            "thread.read",
            json!({ "threadId": "thread-parent-activity" }),
        ));
        assert_eq!(read.error, None);
        assert_eq!(
            read.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
            "thread-child-activity"
        );
        assert_eq!(
            read.result.as_ref().unwrap()["childActivities"][0]["activeRun"]["runId"],
            "run-child-active"
        );
        assert_eq!(
            read.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
            "approval_request"
        );

        let events = router.dispatch(&WorkerRequest::new(
            "req-thread-child-activity-events",
            "trace-thread-child-activity",
            "thread.events",
            json!({ "threadId": "thread-parent-activity", "afterSequence": 0 }),
        ));
        assert_eq!(events.error, None);
        assert_eq!(
            events.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
            "thread-child-activity"
        );
        assert_eq!(
            events.result.as_ref().unwrap()["childActivities"][0]["activeRun"]["runId"],
            "run-child-active"
        );
        assert_eq!(
            events.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
            "approval_request"
        );
        assert_eq!(
            events.result.as_ref().unwrap()["events"][2]["type"],
            "child_activity"
        );
        assert_eq!(
            events.result.as_ref().unwrap()["events"][2]["childActivity"]["child"]["threadId"],
            "thread-child-activity"
        );
        assert_eq!(
            events.result.as_ref().unwrap()["events"][2]["childActivity"]["turnItems"][0]["kind"],
            "approval_request"
        );
    }

    #[test]
    fn agent_run_rpc_enforces_capabilities_and_unknown_run_errors() {
        let fixture = WorkspaceFixture::new();
        let mut denied_router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );
        let denied = denied_router.dispatch(&WorkerRequest::new(
            "req-denied",
            "trace-agent-run",
            "agent_run.list",
            json!({ "session_id": "session-1" }),
        ));
        assert_eq!(
            denied.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );

        let mut read_router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        );
        let missing = read_router.dispatch(&WorkerRequest::new(
            "req-missing",
            "trace-agent-run",
            "agent_run.get",
            json!({ "session_id": "session-1", "run_id": "missing-run" }),
        ));
        assert_eq!(
            missing.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(
            missing.error.as_ref().unwrap().details["run_id"],
            "missing-run"
        );

        let malformed = read_router.dispatch(&WorkerRequest::new(
            "req-malformed",
            "trace-agent-run",
            "agent_run.get",
            json!({ "session_id": "session-1" }),
        ));
        assert_eq!(
            malformed.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(
            malformed.error.as_ref().unwrap().details["method"],
            "agent_run.get"
        );
    }

    #[test]
    fn dispatches_session_writes_for_new_experimental_session() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );
        let set_checkpoint = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.set_checkpoint",
            json!({
                "session_id": "desktop-session-1",
                "checkpoint": { "runId": "run-1", "phase": "awaiting_tools" }
            }),
        );
        let append_messages = WorkerRequest::new(
            "req-2",
            "trace-1",
            "session.append_messages",
            json!({
                "session_id": "desktop-session-1",
                "messages": [
                    { "role": "assistant", "content": "done" }
                ]
            }),
        );

        let checkpoint_response = router.dispatch(&set_checkpoint);
        let append_response = router.dispatch(&append_messages);

        assert_eq!(
            checkpoint_response.result.as_ref().unwrap()["session_id"],
            "desktop-session-1"
        );
        assert_eq!(
            checkpoint_response.result.as_ref().unwrap()["extra"]["runtime_checkpoint"],
            json!({ "runId": "run-1", "phase": "awaiting_tools" })
        );
        assert_eq!(
            append_response.result.as_ref().unwrap()["extra"]["messages"],
            json!([{ "role": "assistant", "content": "done" }])
        );
        assert!(checkpoint_response.error.is_none());
        assert!(append_response.error.is_none());
    }

    #[test]
    fn dispatches_diagnostics_append_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::DiagnosticsWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "diagnostics.append",
            json!({ "stream": "stderr", "line": "worker warning" }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({ "stream": "stderr", "line": "worker warning" }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_task_store_load_missing_as_empty_store() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::TaskRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-task-load",
            "trace-1",
            "task.store.load",
            json!({}),
        ));

        assert_eq!(response.result, Some(json!({ "version": 1, "plans": [] })));
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_task_plan_store_round_trip_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::TaskRead, WorkerCapability::TaskWrite]),
        );
        let plan = json!({
            "id": "plan-1",
            "title": "Backend migration",
            "original_request": "Move backend runtime to TS",
            "status": "executing",
            "current_subtask_ids": ["sub-1"],
            "context": { "channel": "desktop" },
            "subtasks": [
                {
                    "id": "sub-1",
                    "title": "Foundation",
                    "description": "Build foundation",
                    "status": "in_progress",
                    "dependencies": [],
                    "parallel_safe": true,
                    "retry_count": 0,
                    "max_retries": 2
                }
            ]
        });

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-task-save",
            "trace-1",
            "task.plan.save",
            json!({ "plan": plan }),
        ));
        let get_response = router.dispatch(&WorkerRequest::new(
            "req-task-get",
            "trace-1",
            "task.plan.get",
            json!({ "plan_id": "plan-1" }),
        ));
        assert!(fixture.read("plans/store.json").contains("\"plan-1\""));
        let list_response = router.dispatch(&WorkerRequest::new(
            "req-task-list",
            "trace-1",
            "task.plan.list",
            json!({}),
        ));
        let delete_response = router.dispatch(&WorkerRequest::new(
            "req-task-delete",
            "trace-1",
            "task.plan.delete",
            json!({ "plan_id": "plan-1" }),
        ));
        let missing_response = router.dispatch(&WorkerRequest::new(
            "req-task-get-missing",
            "trace-1",
            "task.plan.get",
            json!({ "plan_id": "plan-1" }),
        ));

        assert!(save_response.error.is_none());
        assert_eq!(
            save_response.result.as_ref().unwrap()["plan"]["id"],
            "plan-1"
        );
        assert_eq!(
            get_response.result.as_ref().unwrap()["plan"]["id"],
            "plan-1"
        );
        assert_eq!(
            list_response.result.as_ref().unwrap()["plans"][0]["id"],
            "plan-1"
        );
        assert_eq!(delete_response.result, Some(json!({ "deleted": true })));
        assert_eq!(missing_response.result, Some(json!({ "plan": null })));
    }

    #[test]
    fn dispatches_task_plan_list_filters_completed_by_default() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "plans/store.json",
            &json!({
                "version": 1,
                "plans": [
                    { "id": "active", "title": "Active", "status": "executing", "subtasks": [] },
                    { "id": "done", "title": "Done", "status": "completed", "subtasks": [] }
                ]
            })
            .to_string(),
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::TaskRead]),
        );

        let default_response = router.dispatch(&WorkerRequest::new(
            "req-task-list",
            "trace-1",
            "task.plan.list",
            json!({}),
        ));
        let include_response = router.dispatch(&WorkerRequest::new(
            "req-task-list-all",
            "trace-1",
            "task.plan.list",
            json!({ "include_completed": true }),
        ));

        assert_eq!(
            default_response.result.as_ref().unwrap()["plans"],
            json!([{ "id": "active", "title": "Active", "status": "executing", "subtasks": [] }])
        );
        assert_eq!(
            include_response.result.as_ref().unwrap()["plans"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn denies_task_plan_save_without_write_capability() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::TaskRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-task-save",
            "trace-1",
            "task.plan.save",
            json!({
                "plan": { "id": "plan-1", "title": "Plan", "subtasks": [] }
            }),
        ));

        let error = response.error.expect("task write should be denied");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "task.write");
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_cron_job_store_round_trip_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronWrite]),
        );

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-cron-add",
            "trace-1",
            "cron.job.add",
            json!({
                "job": {
                    "name": "Check status",
                    "schedule": { "kind": "every", "everyMs": 60000 },
                    "payload": {
                        "kind": "agent_turn",
                        "message": "Check status",
                        "deliver": true,
                        "channel": "native",
                        "to": "run-1"
                    },
                    "deleteAfterRun": false
                }
            }),
        ));
        let add_result = add_response
            .result
            .as_ref()
            .expect("cron.job.add should return result");
        assert_eq!(add_response.error, None);
        let job_id = add_result["job"]["id"]
            .as_str()
            .expect("cron job should receive id")
            .to_string();
        assert_eq!(add_result["job"]["name"], "Check status");
        assert_eq!(add_result["job"]["schedule"]["everyMs"], 60000);
        assert_eq!(add_result["job"]["payload"]["to"], "run-1");
        assert!(add_result["job"]["enabled"].as_bool().unwrap());
        assert!(add_result["job"]["createdAtMs"].as_i64().unwrap() > 0);
        assert!(add_result["job"]["state"]["nextRunAtMs"].as_i64().unwrap() > 0);
        assert!(fixture.read("cron/jobs.json").contains(&job_id));

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-cron-list",
            "trace-1",
            "cron.job.list",
            json!({}),
        ));
        assert_eq!(list_response.error, None);
        assert_eq!(
            list_response.result.as_ref().unwrap()["jobs"][0]["id"],
            job_id
        );

        let remove_response = router.dispatch(&WorkerRequest::new(
            "req-cron-remove",
            "trace-1",
            "cron.job.remove",
            json!({ "job_id": job_id }),
        ));
        assert_eq!(remove_response.error, None);
        assert_eq!(remove_response.result, Some(json!({ "status": "removed" })));

        let empty_response = router.dispatch(&WorkerRequest::new(
            "req-cron-list-empty",
            "trace-1",
            "cron.job.list",
            json!({}),
        ));
        assert_eq!(empty_response.result, Some(json!({ "jobs": [] })));
    }

    #[test]
    fn dispatches_cron_job_remove_protects_system_events() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "cron/jobs.json",
            &json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "system-job",
                        "name": "System upkeep",
                        "enabled": true,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "system_event", "message": "upkeep" },
                        "state": { "nextRunAtMs": 1234, "lastRunAtMs": null, "lastError": null, "runCount": 0, "history": [] },
                        "createdAtMs": 1000,
                        "updatedAtMs": 1000,
                        "deleteAfterRun": false
                    }
                ]
            })
            .to_string(),
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-cron-protected",
            "trace-1",
            "cron.job.remove",
            json!({ "job_id": "system-job" }),
        ));

        assert_eq!(response.error, None);
        assert_eq!(response.result, Some(json!({ "status": "protected" })));
        assert!(fixture.read("cron/jobs.json").contains("system-job"));
    }

    #[test]
    fn denies_cron_job_add_without_write_capability() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::CronRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-cron-add",
            "trace-1",
            "cron.job.add",
            json!({
                "job": {
                    "name": "Check status",
                    "schedule": { "kind": "every", "everyMs": 60000 },
                    "payload": { "kind": "agent_turn", "message": "Check status" }
                }
            }),
        ));

        let error = response.error.expect("cron write should be denied");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "cron.write");
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_cron_due_and_record_run_updates_store() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "cron/jobs.json",
            &json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "due-every",
                        "name": "Every",
                        "enabled": true,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "agent_turn", "message": "check", "deliver": true },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": false
                    },
                    {
                        "id": "due-at",
                        "name": "Once",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 1000 },
                        "payload": { "kind": "agent_turn", "message": "once", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "future",
                        "name": "Future",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 100000 },
                        "payload": { "kind": "agent_turn", "message": "later", "deliver": false },
                        "state": { "nextRunAtMs": 100000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "disabled",
                        "name": "Disabled",
                        "enabled": false,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "agent_turn", "message": "skip", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": false
                    }
                ]
            })
            .to_string(),
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronRun]),
        );

        let due_response = router.dispatch(&WorkerRequest::new(
            "req-cron-due",
            "trace-1",
            "cron.job.due",
            json!({ "now_ms": 2000 }),
        ));

        assert_eq!(due_response.error, None);
        assert_eq!(
            due_response.result.as_ref().unwrap()["jobs"],
            json!([
                {
                    "id": "due-every",
                    "name": "Every",
                    "enabled": true,
                    "schedule": { "kind": "every", "everyMs": 60000 },
                    "payload": { "kind": "agent_turn", "message": "check", "deliver": true, "channel": null, "to": null },
                    "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                    "createdAtMs": 1,
                    "updatedAtMs": 1,
                    "deleteAfterRun": false
                },
                {
                    "id": "due-at",
                    "name": "Once",
                    "enabled": true,
                    "schedule": { "kind": "at", "atMs": 1000 },
                    "payload": { "kind": "agent_turn", "message": "once", "deliver": false, "channel": null, "to": null },
                    "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                    "createdAtMs": 1,
                    "updatedAtMs": 1,
                    "deleteAfterRun": true
                }
            ])
        );

        let record_response = router.dispatch(&WorkerRequest::new(
            "req-cron-record",
            "trace-1",
            "cron.job.record_runs",
            json!({
                "now_ms": 3000,
                "records": [
                    { "job_id": "due-every", "run_at_ms": 2000, "status": "ok", "duration_ms": 25 },
                    { "job_id": "due-at", "run_at_ms": 2000, "status": "error", "duration_ms": 5, "error": "boom" }
                ]
            }),
        ));

        assert_eq!(record_response.error, None);
        assert_eq!(
            record_response.result,
            Some(json!({ "updated": ["due-every"], "deleted": ["due-at"], "missing": [] }))
        );
        let store: Value = serde_json::from_str(&fixture.read("cron/jobs.json")).unwrap();
        let every = store["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|job| job["id"] == "due-every")
            .unwrap();
        assert_eq!(every["state"]["lastRunAtMs"], 2000);
        assert_eq!(every["state"]["lastStatus"], "ok");
        assert_eq!(every["state"]["lastError"], Value::Null);
        assert_eq!(every["state"]["nextRunAtMs"], 63000);
        assert_eq!(every["state"]["runHistory"][0]["durationMs"], 25);
        assert!(!fixture.read("cron/jobs.json").contains("due-at"));
    }

    #[test]
    fn dispatches_session_task_progress_upsert_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session_fixture()],
            20,
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );

        let first = router.dispatch(&WorkerRequest::new(
            "req-progress-1",
            "trace-1",
            "session.task_progress.upsert",
            json!({
                "session_id": "session-1",
                "plan_id": "plan-1",
                "content": "first progress",
                "progress": { "completed": 0, "total": 2 }
            }),
        ));
        let second = router.dispatch(&WorkerRequest::new(
            "req-progress-2",
            "trace-2",
            "session.task_progress.upsert",
            json!({
                "session_id": "session-1",
                "plan_id": "plan-1",
                "content": "updated progress",
                "progress": { "completed": 1, "total": 2 }
            }),
        ));

        assert_eq!(first.error, None);
        assert_eq!(second.error, None);
        let messages = second.result.as_ref().unwrap()["extra"]["messages"]
            .as_array()
            .expect("messages should be an array");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "progress");
        assert_eq!(messages[0]["content"], "updated progress");
        assert_eq!(messages[0]["_task_plan_id"], "plan-1");
        assert_eq!(messages[0]["_task_progress"]["completed"], 1);
    }

    #[test]
    fn dispatches_background_run_registry_round_trip_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
            ]),
        );

        let upsert_response = router.dispatch(&WorkerRequest::new(
            "req-background-upsert",
            "trace-1",
            "background.run.upsert",
            json!({
                "run": {
                    "id": "subagent-1",
                    "kind": "subagent",
                    "source": "task",
                    "status": "running",
                    "label": "Inspect",
                    "sessionKey": "desktop:chat-1",
                    "planId": "plan-1",
                    "subtaskId": "a",
                    "startedAtMs": 1000,
                    "updatedAtMs": 1000,
                    "metadata": { "traceId": "trace-1" }
                }
            }),
        ));
        assert_eq!(upsert_response.error, None);
        assert_eq!(
            upsert_response.result.as_ref().unwrap()["run"]["id"],
            "subagent-1"
        );
        assert!(fixture
            .read("background/registry.json")
            .contains("subagent-1"));

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-background-list",
            "trace-1",
            "background.run.list",
            json!({}),
        ));
        assert_eq!(list_response.error, None);
        assert_eq!(
            list_response.result.as_ref().unwrap()["runs"][0]["status"],
            "running"
        );

        let complete_response = router.dispatch(&WorkerRequest::new(
            "req-background-complete",
            "trace-1",
            "background.run.complete",
            json!({
                "run_id": "subagent-1",
                "status": "completed",
                "completedAtMs": 2000,
                "result": "inspection complete"
            }),
        ));
        assert_eq!(complete_response.error, None);
        assert_eq!(
            complete_response.result.as_ref().unwrap()["run"]["status"],
            "completed"
        );
        assert_eq!(
            complete_response.result.as_ref().unwrap()["run"]["result"],
            "inspection complete"
        );
        assert_eq!(
            complete_response.result.as_ref().unwrap()["run"]["completedAtMs"],
            2000
        );

        let append_trace_response = router.dispatch(&WorkerRequest::new(
            "req-background-trace-append",
            "trace-1",
            "background.trace.append",
            json!({
                "event": {
                    "eventId": "event-1",
                    "eventType": "agent.delegate.started",
                    "sessionKey": "desktop:chat-1",
                    "turnId": "turn-1",
                    "delegateId": "subagent-1",
                    "childRunId": "subagent-1",
                    "traceRef": "trace-1",
                    "sequence": 1,
                    "createdAt": "2026-06-28T00:00:00.000Z",
                    "payload": { "status": "running" }
                }
            }),
        ));
        assert_eq!(append_trace_response.error, None);
        assert_eq!(
            append_trace_response.result.as_ref().unwrap()["event"]["eventId"],
            "event-1"
        );

        let list_trace_response = router.dispatch(&WorkerRequest::new(
            "req-background-trace-list",
            "trace-1",
            "background.trace.list",
            json!({
                "filter": {
                    "sessionKey": "desktop:chat-1",
                    "delegateId": "subagent-1"
                }
            }),
        ));
        assert_eq!(list_trace_response.error, None);
        assert_eq!(
            list_trace_response.result.as_ref().unwrap()["events"][0]["eventType"],
            "agent.delegate.started"
        );

        let get_trace_response = router.dispatch(&WorkerRequest::new(
            "req-background-trace-get",
            "trace-1",
            "background.trace.get_delegate_trace",
            json!({
                "filter": {
                    "sessionKey": "desktop:chat-1",
                    "delegateId": "subagent-1"
                }
            }),
        ));
        assert_eq!(get_trace_response.error, None);
        assert_eq!(
            get_trace_response.result.as_ref().unwrap()["trace"]["status"],
            "running"
        );
        assert_eq!(
            get_trace_response.result.as_ref().unwrap()["trace"]["events"][0]["eventType"],
            "agent.delegate.started"
        );

        let append_artifact_response = router.dispatch(&WorkerRequest::new(
            "req-background-trace-artifact-append",
            "trace-1",
            "background.trace.append",
            json!({
                "event": {
                    "eventId": "event-artifact-1",
                    "eventType": "child.artifact.created",
                    "sessionKey": "desktop:chat-1",
                    "turnId": "turn-1",
                    "delegateId": "subagent-1",
                    "childRunId": "subagent-1",
                    "childStepId": "artifact-1",
                    "traceRef": "trace-1",
                    "sequence": 2,
                    "createdAt": "2026-06-28T00:00:01.000Z",
                    "payload": {
                        "artifactId": "artifact-1",
                        "kind": "diff",
                        "title": "Patch"
                    }
                }
            }),
        ));
        assert_eq!(append_artifact_response.error, None);
        let get_artifact_response = router.dispatch(&WorkerRequest::new(
            "req-background-trace-get-artifact",
            "trace-1",
            "background.trace.get_artifact",
            json!({
                "filter": {
                    "sessionKey": "desktop:chat-1",
                    "delegateId": "subagent-1",
                    "artifactId": "artifact-1"
                }
            }),
        ));
        assert_eq!(get_artifact_response.error, None);
        assert_eq!(
            get_artifact_response.result.as_ref().unwrap()["artifact"]["artifactId"],
            "artifact-1"
        );
    }

    #[test]
    fn background_subagent_enqueue_input_writes_user_message_trace_event() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
            ]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-background-subagent-input",
            "trace-1",
            "background.subagent.enqueue_input",
            json!({
                "sessionKey": "desktop:chat-1",
                "subagentId": "subagent-1",
                "content": "Use the safer option.",
                "traceRef": "trace-subagent-1",
                "childRunId": "run-subagent-1",
                "createdAt": "2026-06-28T00:00:02.000Z"
            }),
        ));

        assert_eq!(response.error, None);
        let result = response
            .result
            .as_ref()
            .expect("enqueue should return a result");
        assert_eq!(result["accepted"], true);
        assert_eq!(result["delivery"], "queued_for_runtime");
        assert_eq!(
            result["event"]["eventType"],
            "agent.delegate.message_queued"
        );
        assert_eq!(result["event"]["sessionKey"], "desktop:chat-1");
        assert_eq!(result["event"]["delegateId"], "subagent-1");
        assert_eq!(
            result["event"]["payload"]["content"],
            "Use the safer option."
        );
        assert_eq!(result["event"]["payload"]["source"], "user");
    }

    #[test]
    fn dispatches_subagent_control_requests() {
        let fixture = WorkspaceFixture::new();
        let manager = SubagentThreadManager::default();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        )
        .with_subagent_manager(manager);

        let spawn = router.dispatch(&WorkerRequest::new(
            "req-subagent-spawn",
            "trace-subagent",
            "subagent.spawn",
            json!({
                "sessionKey": "desktop:chat-1",
                "parentRunId": "parent-run-1",
                "subagentId": "delegate-1",
                "childRunId": "child-1",
                "traceRef": "trace-delegate-1",
                "name": "Goodall",
                "task": "Inspect a narrow question",
                "metadata": {
                    "role": "research",
                    "nickname": "Scout",
                    "depth": 1,
                    "capacity": { "maxActivePerSession": 8 }
                }
            }),
        ));
        assert_eq!(spawn.error, None);
        assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);

        let send = router.dispatch(&WorkerRequest::new(
            "req-subagent-send",
            "trace-subagent",
            "subagent.send_input",
            json!({
                "sessionKey": "desktop:chat-1",
                "subagentId": "delegate-1",
                "content": "Please continue",
                "sender": "main_agent"
            }),
        ));
        assert_eq!(send.error, None);
        assert_eq!(send.result.as_ref().unwrap()["delivery"], "live_delivered");
        assert_eq!(send.result.as_ref().unwrap()["subagent"]["mailboxDepth"], 1);

        let wait = router.dispatch(&WorkerRequest::new(
            "req-subagent-wait",
            "trace-subagent",
            "subagent.wait",
            json!({
                "sessionKey": "desktop:chat-1",
                "subagentIds": ["delegate-1"],
                "timeoutMs": 1
            }),
        ));
        assert_eq!(wait.error, None);
        assert_eq!(wait.result.as_ref().unwrap()["timedOut"], true);

        let close = router.dispatch(&WorkerRequest::new(
            "req-subagent-close",
            "trace-subagent",
            "subagent.close",
            json!({
                "sessionKey": "desktop:chat-1",
                "subagentId": "delegate-1"
            }),
        ));
        assert_eq!(close.error, None);
        assert_eq!(close.result.as_ref().unwrap()["accepted"], true);
        assert_eq!(
            close.result.as_ref().unwrap()["subagent"]["status"],
            "closed"
        );

        let default_thread_list = router.dispatch(&WorkerRequest::new(
            "req-subagent-default-thread-list",
            "trace-subagent",
            "thread.list",
            json!({ "includeArchived": true }),
        ));
        assert_eq!(default_thread_list.error, None);
        let default_threads = default_thread_list.result.as_ref().unwrap()["threads"]
            .as_array()
            .expect("thread list should be an array");
        assert_eq!(default_threads.len(), 1);
        assert_eq!(default_threads[0]["source"], "legacy_subagent_parent");

        let thread_list = router.dispatch(&WorkerRequest::new(
            "req-subagent-thread-list",
            "trace-subagent",
            "thread.list",
            json!({ "includeArchived": true, "includeChildThreads": true }),
        ));
        assert_eq!(thread_list.error, None);
        let threads = thread_list.result.as_ref().unwrap()["threads"]
            .as_array()
            .expect("thread list should be an array");
        assert_eq!(threads.len(), 2);
        let parent_thread = threads
            .iter()
            .find(|thread| thread["source"] == "legacy_subagent_parent")
            .expect("parent thread should be projected");
        let child_thread = threads
            .iter()
            .find(|thread| thread["source"] == "subagent")
            .expect("child thread should be projected");
        assert_eq!(child_thread["parentThreadId"], parent_thread["threadId"]);
        assert_eq!(
            child_thread["metadata"]["extra"]["subagentId"],
            "delegate-1"
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["agentId"],
            "delegate-1"
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["agentPath"],
            json!(["main", "delegate-1"])
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["role"],
            "research"
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["nickname"],
            "Scout"
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["depth"],
            1
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["capacity"],
            json!({ "maxActivePerSession": 8 })
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["status"],
            "closed"
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["active"],
            false
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["terminal"],
            true
        );
        assert_eq!(
            child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["mailboxDepth"],
            1
        );

        let direct_child_list = router.dispatch(&WorkerRequest::new(
            "req-subagent-direct-child-list",
            "trace-subagent",
            "thread.list",
            json!({
                "includeArchived": true,
                "parentThreadId": parent_thread["threadId"]
            }),
        ));
        assert_eq!(direct_child_list.error, None);
        assert_eq!(
            direct_child_list.result.as_ref().unwrap()["threads"][0]["threadId"],
            child_thread["threadId"]
        );

        let descendant_search = router.dispatch(&WorkerRequest::new(
            "req-subagent-descendant-search",
            "trace-subagent",
            "thread.search",
            json!({
                "query": "narrow question",
                "includeArchived": true,
                "ancestorThreadId": parent_thread["threadId"]
            }),
        ));
        assert_eq!(descendant_search.error, None);
        assert_eq!(
            descendant_search.result.as_ref().unwrap()["threads"][0]["threadId"],
            child_thread["threadId"]
        );

        let parent_read = router.dispatch(&WorkerRequest::new(
            "req-subagent-parent-thread-read",
            "trace-subagent",
            "thread.read",
            json!({ "threadId": parent_thread["threadId"] }),
        ));
        assert_eq!(parent_read.error, None);
        assert_eq!(
            parent_read.result.as_ref().unwrap()["children"][0]["threadId"],
            child_thread["threadId"]
        );
        assert_eq!(
            parent_read.result.as_ref().unwrap()["children"][0]["agentControl"]["agentId"],
            "delegate-1"
        );
        assert_eq!(
            parent_read.result.as_ref().unwrap()["children"][0]["agentControl"]["lifecycle"]
                ["status"],
            "closed"
        );
        assert_eq!(
            parent_read.result.as_ref().unwrap()["pagination"]["itemCount"],
            2
        );
        let parent_kinds = parent_read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(parent_kinds, vec!["subagent_spawned", "subagent_completed"]);

        let child_read = router.dispatch(&WorkerRequest::new(
            "req-subagent-child-thread-read",
            "trace-subagent",
            "thread.read",
            json!({ "threadId": child_thread["threadId"] }),
        ));
        assert_eq!(child_read.error, None);
        assert_eq!(
            child_read.result.as_ref().unwrap()["runs"][0]["runId"],
            "child-1"
        );
        assert_eq!(
            child_read.result.as_ref().unwrap()["runs"][0]["active"],
            false
        );
        assert_eq!(
            child_read.result.as_ref().unwrap()["pagination"]["itemCount"],
            5
        );
        let child_kinds = child_read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            child_kinds,
            vec![
                "user_message",
                "agent_run_started",
                "user_message",
                "subagent_message",
                "agent_run_completed",
            ]
        );

        let delete_parent_only = router.dispatch(&WorkerRequest::new(
            "req-subagent-thread-delete-parent-only",
            "trace-subagent",
            "thread.delete",
            json!({ "threadId": parent_thread["threadId"] }),
        ));
        assert_eq!(
            delete_parent_only.error.as_ref().unwrap().code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );

        let delete_tree = router.dispatch(&WorkerRequest::new(
            "req-subagent-thread-delete-tree",
            "trace-subagent",
            "thread.delete",
            json!({ "threadId": parent_thread["threadId"], "deleteChildren": true }),
        ));
        assert_eq!(delete_tree.error, None);
        assert_eq!(delete_tree.result.as_ref().unwrap()["deleted"], true);
        assert_eq!(
            delete_tree.result.as_ref().unwrap()["deletedChildren"],
            json!([child_thread["threadId"].clone()])
        );
    }

    #[test]
    fn background_subagent_enqueue_input_live_delivers_when_manager_has_child() {
        let fixture = WorkspaceFixture::new();
        let manager = SubagentThreadManager::default();
        manager.spawn(SubagentSpawnParams {
            session_key: "desktop:chat-1".to_string(),
            parent_run_id: Some("parent-run".to_string()),
            subagent_id: Some("delegate-1".to_string()),
            child_run_id: Some("child-1".to_string()),
            trace_ref: Some("trace-delegate-1".to_string()),
            name: Some("Goodall".to_string()),
            task: Some("Inspect a narrow question".to_string()),
            status: None,
            created_at: None,
            metadata: json!({}),
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
            ]),
        )
        .with_subagent_manager(manager);

        let response = router.dispatch(&WorkerRequest::new(
            "req-background-subagent-input",
            "trace-1",
            "background.subagent.enqueue_input",
            json!({
                "sessionKey": "desktop:chat-1",
                "subagentId": "delegate-1",
                "content": "User intervention",
                "traceRef": "trace-delegate-1",
                "childRunId": "child-1",
                "createdAt": "2026-06-28T00:00:02.000Z"
            }),
        ));

        assert_eq!(response.error, None);
        let result = response.result.as_ref().unwrap();
        assert_eq!(result["accepted"], true);
        assert_eq!(result["delivery"], "live_delivered");
        assert_eq!(result["event"]["payload"]["delivery"], "live_delivered");
        assert_eq!(result["subagent"]["mailboxDepth"], 1);
    }

    #[test]
    fn subagent_list_restores_interrupted_children_from_background_trace() {
        let fixture = WorkspaceFixture::new();
        let manager = SubagentThreadManager::default();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::BackgroundRead,
                WorkerCapability::BackgroundWrite,
            ]),
        )
        .with_subagent_manager(manager);

        let append = router.dispatch(&WorkerRequest::new(
            "req-background-trace-append",
            "trace-1",
            "background.trace.append",
            json!({
                "event": {
                    "eventId": "event-running",
                    "eventType": "agent.delegate.running",
                    "sessionKey": "desktop:chat-1",
                    "turnId": "parent-run",
                    "delegateId": "delegate-1",
                    "childRunId": "child-1",
                    "traceRef": "trace-delegate-1",
                    "sequence": 1,
                    "createdAt": "2026-06-28T00:00:00.000Z",
                    "payload": { "name": "Goodall", "task": "Inspect" }
                }
            }),
        ));
        assert_eq!(append.error, None);

        let list = router.dispatch(&WorkerRequest::new(
            "req-subagent-list",
            "trace-1",
            "subagent.list",
            json!({ "sessionKey": "desktop:chat-1" }),
        ));

        assert_eq!(list.error, None);
        let subagents = list.result.as_ref().unwrap()["subagents"]
            .as_array()
            .expect("subagent list should be an array");
        assert_eq!(subagents.len(), 1);
        assert_eq!(subagents[0]["subagentId"], "delegate-1");
        assert_eq!(subagents[0]["status"], "interrupted");
    }

    #[test]
    fn denies_background_run_write_without_write_capability() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::BackgroundRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-background-upsert",
            "trace-1",
            "background.run.upsert",
            json!({
                "run": {
                    "id": "subagent-1",
                    "kind": "subagent",
                    "source": "task",
                    "status": "running",
                    "startedAtMs": 1000,
                    "updatedAtMs": 1000
                }
            }),
        ));

        let error = response.error.expect("background write should be denied");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "background.write");
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_rag_query_request() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "docs/native-agent-loop.md",
            "# Native Agent Loop Design\n\nNative agent should route product integrations through Rust.\n",
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "rag.query",
            json!({
                "query": "Native agent Rust",
                "collection": "docs",
                "limit": 3
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "documents": [{
                    "id": "docs/native-agent-loop.md",
                    "title": "Native Agent Loop Design",
                    "path": "docs/native-agent-loop.md",
                    "score": 3,
                    "excerpt": "Native agent should route product integrations through Rust."
                }]
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn knowledge_query_requires_knowledge_read_capability() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "docs/native-agent-loop.md",
            "# Native Agent Loop Design\n\nNative agent should route product integrations through Rust.\n",
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.query",
            json!({
                "query": "Native agent Rust",
                "category": "docs",
                "limit": 3
            }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "knowledge.read");
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_knowledge_document_crud_and_sparse_query() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Desktop Knowledge Notes",
                "content": "# Desktop Knowledge Notes\n\nTS worker knowledge store should persist chunks for sparse retrieval.\n",
                "category": "desktop",
                "tags": ["ts", "knowledge"],
                "file_type": "md",
                "original_path": "docs/desktop-knowledge.md"
            }),
        ));
        let add_result = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result");
        let doc_id = add_result["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        assert_eq!(add_response.error, None);
        assert!(doc_id.starts_with("doc_"));
        assert_eq!(add_result["document"]["name"], "Desktop Knowledge Notes");
        assert_eq!(add_result["document"]["chunk_count"], 1);
        assert_eq!(add_result["document"]["category"], "desktop");
        assert_eq!(add_result["document"]["tags"], json!(["ts", "knowledge"]));
        assert!(fixture.read("knowledge/documents.jsonl").contains(&doc_id));
        assert!(fixture
            .read("knowledge/chunks.jsonl")
            .contains(&format!("chunk_{doc_id}_0")));

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.list_documents",
            json!({ "category": "desktop", "limit": 10 }),
        ));
        assert_eq!(list_response.error, None);
        assert_eq!(
            list_response.result.as_ref().unwrap()["documents"][0]["id"],
            doc_id
        );

        let get_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "knowledge.get_document",
            json!({ "doc_id": doc_id }),
        ));
        assert_eq!(get_response.error, None);
        assert_eq!(
            get_response.result.as_ref().unwrap()["content"],
            "# Desktop Knowledge Notes\n\nTS worker knowledge store should persist chunks for sparse retrieval.\n"
        );

        let json_response = router.dispatch(&WorkerRequest::new(
            "req-json",
            "trace-json",
            "knowledge.add_document",
            json!({
                "name": "Desktop Payload",
                "content": "{\"topic\":\"native knowledge\",\"mode\":\"json\"}\n",
                "file_type": "json",
                "category": "desktop",
                "tags": ["json"],
            }),
        ));
        assert_eq!(json_response.error, None);
        let json_result = json_response
            .result
            .as_ref()
            .expect("json knowledge.add_document should return result");
        assert_eq!(
            json_result["document"]["file_type"].as_str().unwrap(),
            "json"
        );

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "knowledge.query",
            json!({
                "query": "sparse retrieval",
                "category": "desktop",
                "tags": ["knowledge"],
                "limit": 5
            }),
        ));
        assert_eq!(query_response.error, None);
        let query_result = &query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result")["results"][0];
        assert_eq!(query_result["id"], json!(format!("chunk_{doc_id}_0")));
        assert_eq!(query_result["doc_id"], json!(doc_id));
        assert_eq!(
            query_result["parent_id"],
            json!(format!("chunk_{doc_id}_0"))
        );
        assert_eq!(query_result["chunk_type"], "parent");
        assert_eq!(query_result["doc_name"], "Desktop Knowledge Notes");
        assert_eq!(query_result["section_path"], "Desktop Knowledge Notes");
        assert_eq!(query_result["section_id"], format!("section_{doc_id}_0"));
        assert_eq!(query_result["section_title"], "Desktop Knowledge Notes");
        assert_eq!(query_result["parent_section_id"], "section-root");
        assert_eq!(query_result["section_ordinal"], 0);
        assert_eq!(query_result["matched_child_ids"], json!([]));
        assert_eq!(query_result["matched_child_snippets"], json!([]));
        assert_eq!(query_result["matched_child_section_paths"], json!([]));
        assert_eq!(query_result["score"], 2);
        assert_eq!(query_result["retrieval_method"], "sparse");

        let delete_response = router.dispatch(&WorkerRequest::new(
            "req-5",
            "trace-1",
            "knowledge.delete_document",
            json!({ "doc_id": doc_id }),
        ));
        assert_eq!(delete_response.error, None);
        assert_eq!(delete_response.result.as_ref().unwrap()["deleted"], true);
        assert!(!fixture
            .read("knowledge/documents.jsonl")
            .contains("Desktop Knowledge Notes"));
        assert!(!fixture
            .read("knowledge/chunks.jsonl")
            .contains("Desktop Knowledge Notes"));
    }

    #[test]
    fn knowledge_query_returns_parent_context_for_matched_child_chunks() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let retrieval_section = [
            "## Retrieval Pipeline",
            "",
            "Sparse retrieval should find child chunks with precise lexical evidence.",
            "The child snippet contains uniqueneedle evidence for ranking.",
            "Parent context must include enough surrounding text for the model.",
        ]
        .join("\n");
        let content = [
            "# Desktop Knowledge Notes",
            "",
            "Introductory text without the target term.",
            "",
            retrieval_section.as_str(),
            "",
            "## Operational Notes",
            "",
            "Unrelated final section for ordering.",
        ]
        .join("\n");

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Chunked Knowledge Notes",
                "content": content,
                "category": "desktop",
                "tags": ["chunking"],
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        assert_eq!(add_response.error, None);
        assert_eq!(
            add_response.result.as_ref().unwrap()["document"]["chunk_count"],
            3
        );
        let chunks_jsonl = fixture.read("knowledge/chunks.jsonl");
        assert!(chunks_jsonl.contains(&format!("\"id\":\"chunk_{doc_id}_1\"")));
        assert!(chunks_jsonl.contains(&format!("\"id\":\"chunk_{doc_id}_1_child_0\"")));
        assert!(chunks_jsonl.contains("\"chunk_type\":\"child\""));

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.query",
            json!({
                "query": "uniqueneedle",
                "category": "desktop",
                "tags": ["chunking"],
                "limit": 3
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = &query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result")["results"][0];
        assert_eq!(result["id"], format!("chunk_{doc_id}_1"));
        assert_eq!(result["parent_id"], format!("chunk_{doc_id}_1"));
        assert_eq!(result["chunk_type"], "parent");
        assert_eq!(result["section_path"], "Retrieval Pipeline");
        assert_eq!(result["section_id"], format!("section_{doc_id}_1"));
        assert_eq!(result["section_title"], "Retrieval Pipeline");
        assert_eq!(result["parent_section_id"], format!("section_{doc_id}_0"));
        assert_eq!(result["section_ordinal"], 1);
        assert_eq!(
            result["matched_child_section_paths"],
            json!(["Retrieval Pipeline"])
        );
        assert!(result["content"]
            .as_str()
            .expect("result content should be string")
            .contains("Parent context must include enough surrounding text"));
        assert_eq!(
            result["matched_child_ids"],
            json!([format!("chunk_{doc_id}_1_child_1")])
        );
        assert_eq!(
            result["matched_child_snippets"],
            json!(["The child snippet contains uniqueneedle evidence for ranking."])
        );
        assert_eq!(result["retrieval_method"], "sparse");
    }

    #[test]
    fn knowledge_query_returns_score_component_metadata() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-score-1",
            "trace-score",
            "knowledge.add_document",
            json!({
                "name": "Score Metadata Notes",
                "content": "# Score Metadata Notes\n\nSparse retrieval ranking should explain sparse score contribution.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-score-2",
            "trace-score",
            "knowledge.query",
            json!({
                "query": "sparse retrieval",
                "category": "desktop",
                "limit": 3
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = &query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result")["results"][0];
        assert_eq!(result["score"], 2);
        assert_eq!(result["matched_methods"], json!(["keyword"]));
        assert_eq!(
            result["score_metadata"],
            json!({
                "object": "knowledge_score_metadata",
                "score_model": "deterministic_sparse_v1",
                "final_score": 2,
                "components": {
                    "sparse": {
                        "score": 2,
                        "rank": 1,
                        "normalized_score": 1.0,
                        "contribution": 2
                    }
                },
                "route_contributions": [
                    {
                        "route": "keyword",
                        "method": "sparse",
                        "score": 2,
                        "rank": 1,
                        "normalized_score": 1.0,
                        "contribution": 2
                    }
                ],
                "rerank": {
                    "object": "knowledge_rerank_metadata",
                    "method": "deterministic_score_path_id_v1",
                    "sort_keys": ["score_desc", "file_path_asc", "chunk_id_asc"],
                    "rank": 1
                }
            })
        );
    }

    #[test]
    fn knowledge_query_can_return_tree_structure_context() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let content = [
            "# Desktop Knowledge Notes",
            "",
            "Root overview.",
            "",
            "## Retrieval Pipeline",
            "",
            "The uniquetree marker belongs to retrieval.",
            "",
            "### Ranking Details",
            "",
            "Ranking details should be listed as a child section.",
            "",
            "## Operational Notes",
            "",
            "Operational notes should be listed as a sibling section.",
        ]
        .join("\n");
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-structure-1",
            "trace-structure",
            "knowledge.add_document",
            json!({
                "name": "Structured Knowledge Notes",
                "content": content,
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-structure-2",
            "trace-structure",
            "knowledge.query",
            json!({
                "query": "uniquetree",
                "category": "desktop",
                "limit": 3,
                "include_structure_context": true
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = &query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result")["results"][0];
        assert_eq!(result["id"], format!("chunk_{doc_id}_1"));
        assert_eq!(
            result["structure_context"],
            json!({
                "object": "knowledge_structure_context",
                "section": {
                    "id": format!("section_{doc_id}_1"),
                    "chunk_id": format!("chunk_{doc_id}_1"),
                    "title": "Retrieval Pipeline",
                    "section_path": "Retrieval Pipeline",
                    "ordinal": 1,
                    "line_start": 5,
                    "line_end": 8
                },
                "parent_section": {
                    "id": format!("section_{doc_id}_0"),
                    "chunk_id": format!("chunk_{doc_id}_0"),
                    "title": "Desktop Knowledge Notes",
                    "section_path": "Desktop Knowledge Notes",
                    "ordinal": 0,
                    "line_start": 1,
                    "line_end": 4
                },
                "sibling_sections": [
                    {
                        "id": format!("section_{doc_id}_3"),
                        "chunk_id": format!("chunk_{doc_id}_3"),
                        "title": "Operational Notes",
                        "section_path": "Operational Notes",
                        "ordinal": 3,
                        "line_start": 13,
                        "line_end": 15
                    }
                ],
                "child_sections": [
                    {
                        "id": format!("section_{doc_id}_2"),
                        "chunk_id": format!("chunk_{doc_id}_2"),
                        "title": "Ranking Details",
                        "section_path": "Ranking Details",
                        "ordinal": 2,
                        "line_start": 9,
                        "line_end": 12
                    }
                ]
            })
        );
        assert_eq!(result["matched_methods"], json!(["keyword", "structure"]));
        assert_eq!(
            result["score_metadata"]["components"]["structure"],
            json!({
                "score": 4,
                "rank": 1,
                "normalized_score": 0.0,
                "contribution": 0
            })
        );
        assert_eq!(
            result["score_metadata"]["route_contributions"][1],
            json!({
                "route": "tree",
                "method": "structure_context",
                "score": 4,
                "rank": 1,
                "normalized_score": 0.0,
                "contribution": 0
            })
        );
    }

    #[test]
    fn knowledge_query_auto_routes_tree_location_questions() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let content = [
            "# Desktop Knowledge Notes",
            "",
            "Root overview.",
            "",
            "## Retrieval Pipeline",
            "",
            "The uniquetree marker belongs to retrieval.",
            "",
            "### Ranking Details",
            "",
            "Ranking details should be listed as a child section.",
            "",
            "## Operational Notes",
            "",
            "Operational notes should be listed as a sibling section.",
        ]
        .join("\n");
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-auto-tree-1",
            "trace-auto-tree",
            "knowledge.add_document",
            json!({
                "name": "Auto Tree Notes",
                "content": content,
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-auto-tree-2",
            "trace-auto-tree",
            "knowledge.query",
            json!({
                "query": "where uniquetree",
                "category": "desktop",
                "limit": 3
            }),
        ));

        assert_eq!(query_response.error, None);
        let response = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result");
        assert_eq!(
            response["retrieval_plan"]["selected_routes"],
            json!(["keyword", "tree"])
        );
        assert_eq!(response["retrieval_plan"]["budgets"]["tree"], 3);
        let result = &response["results"][0];
        assert_eq!(result["id"], format!("chunk_{doc_id}_1"));
        assert_eq!(result["matched_methods"], json!(["keyword", "structure"]));
        assert_eq!(
            result["structure_context"]["section"]["title"],
            "Retrieval Pipeline"
        );
        assert_eq!(
            result["structure_context"]["parent_section"]["title"],
            "Desktop Knowledge Notes"
        );
        assert_eq!(
            result["structure_context"]["child_sections"][0]["title"],
            "Ranking Details"
        );
    }

    #[test]
    fn knowledge_query_can_expand_from_entity_graph_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-graph-query-1",
            "trace-graph-query",
            "knowledge.add_document",
            json!({
                "name": "Graph Expansion Notes",
                "content": "# Graph Expansion Notes\n\nThe orchestration layer coordinates background jobs.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-graph-query-2",
            "trace-graph-query",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Graph Expansion Notes",
                "model": "knowledge-model",
                "entities": [
                    {
                        "name": "TinyBot",
                        "type": "project",
                        "confidence": 0.93,
                        "evidence": [
                            {
                                "text": "The orchestration layer coordinates background jobs.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "relations": [],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-graph-query-3",
            "trace-graph-query",
            "knowledge.query",
            json!({
                "query": "TinyBot dependency",
                "category": "desktop",
                "limit": 3,
                "include_graph_context": true
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = &query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result")["results"][0];
        assert_eq!(result["id"], format!("chunk_{doc_id}_0"));
        assert_eq!(result["score"], 2);
        assert_eq!(result["retrieval_method"], "graph");
        assert_eq!(result["matched_methods"], json!(["graph"]));
        assert_eq!(result["matched_entities"][0]["label"], "TinyBot");
        assert_eq!(
            result["source_snippets"][0]["text"],
            "The orchestration layer coordinates background jobs."
        );
        assert_eq!(result["source_snippets"][0]["owner_type"], "entity");
        assert_eq!(
            result["score_metadata"]["route_contributions"][0]["route"],
            "graph"
        );
        assert_eq!(
            result["score_metadata"]["components"]["evidence_quality_bonus"],
            json!({
                "score": 1,
                "verified_evidence_count": 1,
                "normalized_score": 0.5,
                "contribution": 1
            })
        );
        assert_eq!(
            result["projection_metadata"][0]["object"],
            "knowledge_projection_metadata"
        );
        assert_eq!(
            result["projection_metadata"][0]["projection"],
            "entity_graph"
        );
        assert_eq!(result["projection_metadata"][0]["owner_type"], "entity");
        assert_eq!(result["projection_metadata"][0]["owner_label"], "TinyBot");
        assert_eq!(
            result["projection_metadata"][0]["evidence_status"],
            "verified"
        );
        assert_eq!(result["projection_metadata"][0]["confidence"], 0.93);
        assert_eq!(result["projection_metadata"][0]["stale"], false);
        assert!(result["projection_metadata"][0]["source_hash"].is_string());
        assert!(result["projection_metadata"][0]["evidence_id"].is_string());
    }

    #[test]
    fn knowledge_query_can_expand_from_relation_graph_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-relation-query-1",
            "trace-relation-query",
            "knowledge.add_document",
            json!({
                "name": "Relation Expansion Notes",
                "content": "# Relation Expansion Notes\n\nThe orchestration layer coordinates background jobs.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-relation-query-2",
            "trace-relation-query",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Relation Expansion Notes",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.93 },
                    { "name": "RuntimeScheduler", "type": "component", "confidence": 0.91 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "RuntimeScheduler",
                        "predicate": "depends_on",
                        "confidence": 0.88,
                        "evidence": [
                            {
                                "text": "The orchestration layer coordinates background jobs.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    },
                    {
                        "source": "TinyBot",
                        "target": "Unrelated",
                        "predicate": "mentions",
                        "confidence": 0.95,
                        "evidence": [
                            {
                                "text": "The orchestration layer coordinates background jobs.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-relation-query-3",
            "trace-relation-query",
            "knowledge.query",
            json!({
                "query": "TinyBot",
                "category": "desktop",
                "limit": 3,
                "include_graph_context": true,
                "graph_relation_filters": ["depends_on"],
                "graph_min_confidence": 0.8,
                "graph_max_added_chunks": 1
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = &query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result")["results"][0];
        assert_eq!(result["id"], format!("chunk_{doc_id}_0"));
        assert_eq!(result["retrieval_method"], "graph");
        assert_eq!(result["matched_methods"], json!(["graph"]));
        assert_eq!(result["matched_entities"], json!([]));
        assert_eq!(result["matched_relations"].as_array().unwrap().len(), 1);
        assert_eq!(result["matched_relations"][0]["label"], "depends_on");
        assert_eq!(
            result["matched_relation_evidence"][0]["text"],
            "The orchestration layer coordinates background jobs."
        );
        assert_eq!(result["source_snippets"][0]["owner_type"], "relation");
        assert_eq!(
            result["score_metadata"]["route_contributions"][0]["method"],
            "graph_evidence"
        );
        assert_eq!(
            result["projection_metadata"][0]["object"],
            "knowledge_projection_metadata"
        );
        assert_eq!(
            result["projection_metadata"][0]["projection"],
            "entity_graph"
        );
        assert_eq!(result["projection_metadata"][0]["owner_type"], "relation");
        assert_eq!(
            result["projection_metadata"][0]["owner_label"],
            "depends_on"
        );
        assert_eq!(result["projection_metadata"][0]["predicate"], "depends_on");
        assert_eq!(result["projection_metadata"][0]["source_label"], "TinyBot");
        assert_eq!(
            result["projection_metadata"][0]["target_label"],
            "RuntimeScheduler"
        );
    }

    #[test]
    fn knowledge_query_can_disable_relation_hop_graph_expansion() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-relation-hop-query-1",
            "trace-relation-hop-query",
            "knowledge.add_document",
            json!({
                "name": "Relation Hop Notes",
                "content": "# Relation Hop Notes\n\nThe orchestration layer coordinates background jobs.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-relation-hop-query-2",
            "trace-relation-hop-query",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Relation Hop Notes",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.93 },
                    { "name": "RuntimeScheduler", "type": "component", "confidence": 0.91 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "RuntimeScheduler",
                        "predicate": "depends_on",
                        "confidence": 0.88,
                        "evidence": [
                            {
                                "text": "The orchestration layer coordinates background jobs.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-relation-hop-query-3",
            "trace-relation-hop-query",
            "knowledge.query",
            json!({
                "query": "TinyBot",
                "category": "desktop",
                "limit": 3,
                "include_graph_context": true,
                "graph_max_hops": 0,
                "graph_relation_filters": ["depends_on"],
                "graph_min_confidence": 0.8,
                "graph_max_added_chunks": 1
            }),
        ));

        assert_eq!(query_response.error, None);
        assert_eq!(
            query_response
                .result
                .as_ref()
                .expect("knowledge.query should return result")["results"],
            json!([])
        );
    }

    #[test]
    fn knowledge_query_auto_routes_graph_intent_questions() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-auto-graph-query-1",
            "trace-auto-graph-query",
            "knowledge.add_document",
            json!({
                "name": "Auto Graph Notes",
                "content": "# Auto Graph Notes\n\nThe orchestration layer coordinates background jobs.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-auto-graph-query-2",
            "trace-auto-graph-query",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Auto Graph Notes",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.93 },
                    { "name": "RuntimeScheduler", "type": "component", "confidence": 0.91 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "RuntimeScheduler",
                        "predicate": "depends_on",
                        "confidence": 0.88,
                        "evidence": [
                            {
                                "text": "The orchestration layer coordinates background jobs.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-auto-graph-query-3",
            "trace-auto-graph-query",
            "knowledge.query",
            json!({
                "query": "why TinyBot dependency RuntimeScheduler",
                "category": "desktop",
                "limit": 3,
                "graph_min_confidence": 0.8
            }),
        ));

        assert_eq!(query_response.error, None);
        let response = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result");
        assert_eq!(
            response["retrieval_plan"]["selected_routes"],
            json!(["keyword", "graph"])
        );
        let result = &response["results"][0];
        assert_eq!(result["id"], format!("chunk_{doc_id}_0"));
        assert_eq!(result["retrieval_method"], "graph");
        assert_eq!(result["matched_relations"][0]["label"], "depends_on");
        assert_eq!(
            result["matched_relation_evidence"][0]["text"],
            "The orchestration layer coordinates background jobs."
        );
    }

    #[test]
    fn knowledge_query_can_expand_relation_graph_two_hops() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-relation-two-hop-1",
            "trace-relation-two-hop",
            "knowledge.add_document",
            json!({
                "name": "Relation Two Hop Notes",
                "content": "# Relation Two Hop Notes\n\n## Runtime\n\nThe orchestration layer coordinates background jobs.\n\n## Worker Pool\n\nThe scheduler configures worker pool slots.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-relation-two-hop-2",
            "trace-relation-two-hop",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Relation Two Hop Notes",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.93 },
                    { "name": "RuntimeScheduler", "type": "component", "confidence": 0.91 },
                    { "name": "WorkerPool", "type": "component", "confidence": 0.9 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "RuntimeScheduler",
                        "predicate": "depends_on",
                        "confidence": 0.88,
                        "evidence": [
                            {
                                "text": "The orchestration layer coordinates background jobs.",
                                "line_start": 5,
                                "line_end": 5
                            }
                        ]
                    },
                    {
                        "source": "RuntimeScheduler",
                        "target": "WorkerPool",
                        "predicate": "configures",
                        "confidence": 0.86,
                        "evidence": [
                            {
                                "text": "The scheduler configures worker pool slots.",
                                "line_start": 9,
                                "line_end": 9
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 2 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-relation-two-hop-3",
            "trace-relation-two-hop",
            "knowledge.query",
            json!({
                "query": "TinyBot",
                "category": "desktop",
                "limit": 3,
                "include_graph_context": true,
                "graph_max_hops": 2,
                "graph_min_confidence": 0.8,
                "graph_max_added_chunks": 2
            }),
        ));

        assert_eq!(query_response.error, None);
        let results = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result")["results"]
            .as_array()
            .expect("results should be an array");
        assert_eq!(results.len(), 2);
        let relation_labels = results
            .iter()
            .flat_map(|result| {
                result["matched_relations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|relation| relation["label"].as_str())
            })
            .collect::<Vec<_>>();
        assert!(relation_labels.contains(&"depends_on"));
        assert!(relation_labels.contains(&"configures"));
        let snippets = results
            .iter()
            .flat_map(|result| {
                result["source_snippets"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|snippet| snippet["text"].as_str())
            })
            .collect::<Vec<_>>();
        assert!(snippets.contains(&"The orchestration layer coordinates background jobs."));
        assert!(snippets.contains(&"The scheduler configures worker pool slots."));
    }

    #[test]
    fn save_entity_graph_extraction_merges_duplicate_entity_aliases() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-entity-alias-1",
            "trace-entity-alias",
            "knowledge.add_document",
            json!({
                "name": "Entity Alias Source",
                "content": "# Entity Alias Source\n\nTinyBot validates entity aliases.\ntinybot records duplicate evidence.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-entity-alias-2",
            "trace-entity-alias",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Entity Alias Source",
                "model": "knowledge-model",
                "entities": [
                    {
                        "name": "TinyBot",
                        "type": "Project",
                        "confidence": 0.91,
                        "evidence": [
                            {
                                "text": "TinyBot validates entity aliases.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    },
                    {
                        "name": " tinybot ",
                        "type": "project",
                        "confidence": 0.86,
                        "evidence": [
                            {
                                "text": "tinybot records duplicate evidence.",
                                "line_start": 4,
                                "line_end": 4
                            }
                        ]
                    }
                ],
                "relations": [],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-entity-alias-3",
            "trace-entity-alias",
            "knowledge.graph",
            json!({
                "graph_type": "entity",
                "doc_id": doc_id,
                "include_orphans": true
            }),
        ));

        assert_eq!(graph_response.error, None);
        let result = graph_response
            .result
            .as_ref()
            .expect("knowledge.graph should return result");
        assert_eq!(result["stats"]["node_count"], 1);
        assert_eq!(result["nodes"][0]["label"], "TinyBot");
        assert_eq!(result["nodes"][0]["attributes"]["entity_type"], "project");
        assert_eq!(
            result["nodes"][0]["attributes"]["aliases"],
            json!(["tinybot"])
        );
        assert_eq!(result["nodes"][0]["evidence"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn entity_graph_flags_entities_without_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-entity-evidence-status-1",
            "trace-entity-evidence-status",
            "knowledge.add_document",
            json!({
                "name": "Entity Evidence Status",
                "content": "# Entity Evidence Status\n\nTinyBot has direct entity evidence.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-entity-evidence-status-2",
            "trace-entity-evidence-status",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Entity Evidence Status",
                "model": "knowledge-model",
                "entities": [
                    {
                        "name": "TinyBot",
                        "type": "project",
                        "confidence": 0.91,
                        "evidence": [
                            {
                                "text": "TinyBot has direct entity evidence.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    },
                    {
                        "name": "UnverifiedEntity",
                        "type": "concept",
                        "confidence": 0.64
                    }
                ],
                "relations": [],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-entity-evidence-status-3",
            "trace-entity-evidence-status",
            "knowledge.graph",
            json!({
                "graph_type": "entity",
                "doc_id": doc_id,
                "include_orphans": true
            }),
        ));

        assert_eq!(graph_response.error, None);
        let graph = graph_response
            .result
            .as_ref()
            .expect("knowledge.graph should return result");
        assert_eq!(graph["stats"]["verified_node_count"], 1);
        assert_eq!(graph["stats"]["unverified_node_count"], 1);
        let nodes = graph["nodes"].as_array().expect("nodes should be an array");
        let verified = nodes
            .iter()
            .find(|node| node["label"] == "TinyBot")
            .expect("verified entity should be present");
        let missing = nodes
            .iter()
            .find(|node| node["label"] == "UnverifiedEntity")
            .expect("unverified entity should be present");
        assert_eq!(verified["attributes"]["evidence_status"], "verified");
        assert_eq!(missing["attributes"]["evidence_status"], "missing");
    }

    #[test]
    fn save_entity_graph_extraction_rejects_relation_without_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-validate-relation-1",
            "trace-validate-relation",
            "knowledge.add_document",
            json!({
                "name": "Validation Source",
                "content": "# Validation Source\n\nTinyBot validates relation evidence.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-validate-relation-2",
            "trace-validate-relation",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Validation Source",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.9 },
                    { "name": "EvidenceValidation", "type": "concept", "confidence": 0.9 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "EvidenceValidation",
                        "predicate": "supports",
                        "confidence": 0.82
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));

        let error = save_response
            .error
            .expect("relation without evidence should be rejected");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.message, "relation evidence is required");
        assert_eq!(error.details["relation_index"], 0);
        let edges_path = fixture.root.join("knowledge/entity_graph_edges.jsonl");
        let edges_content = std::fs::read_to_string(edges_path).unwrap_or_default();
        assert_eq!(edges_content.trim(), "");
    }

    #[test]
    fn save_entity_graph_extraction_rejects_relation_evidence_not_in_document() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-validate-evidence-1",
            "trace-validate-evidence",
            "knowledge.add_document",
            json!({
                "name": "Validation Source",
                "content": "# Validation Source\n\nTinyBot validates relation evidence.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-validate-evidence-2",
            "trace-validate-evidence",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Validation Source",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.9 },
                    { "name": "EvidenceValidation", "type": "concept", "confidence": 0.9 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "EvidenceValidation",
                        "predicate": "supports",
                        "confidence": 0.82,
                        "evidence": [
                            {
                                "text": "This sentence is not in the document.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));

        let error = save_response
            .error
            .expect("mismatched relation evidence should be rejected");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(
            error.message,
            "relation evidence must match document content"
        );
        assert_eq!(error.details["relation_index"], 0);
        assert_eq!(
            error.details["evidence"],
            "This sentence is not in the document."
        );
    }

    #[test]
    fn save_entity_graph_extraction_rejects_relation_evidence_from_other_document() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-validate-source-1",
            "trace-validate-source",
            "knowledge.add_document",
            json!({
                "name": "Source Identity",
                "content": "# Source Identity\n\nTinyBot validates relation source identity.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-validate-source-2",
            "trace-validate-source",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Source Identity",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.9 },
                    { "name": "SourceIdentity", "type": "concept", "confidence": 0.9 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "SourceIdentity",
                        "predicate": "supports",
                        "confidence": 0.82,
                        "evidence": [
                            {
                                "doc_id": "other_doc",
                                "text": "TinyBot validates relation source identity.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));

        let error = save_response
            .error
            .expect("wrong-document relation evidence should be rejected");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(
            error.message,
            "relation evidence doc_id must match document"
        );
        assert_eq!(error.details["relation_index"], 0);
        assert_eq!(error.details["evidence_doc_id"], "other_doc");
        assert_eq!(error.details["doc_id"], doc_id);
    }

    #[test]
    fn save_entity_graph_extraction_rejects_unsupported_relation_predicate() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-validate-predicate-1",
            "trace-validate-predicate",
            "knowledge.add_document",
            json!({
                "name": "Predicate Source",
                "content": "# Predicate Source\n\nTinyBot validates controlled predicates.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-validate-predicate-2",
            "trace-validate-predicate",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Predicate Source",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.9 },
                    { "name": "PredicateRegistry", "type": "concept", "confidence": 0.9 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "PredicateRegistry",
                        "predicate": "stores",
                        "confidence": 0.82,
                        "evidence": [
                            {
                                "text": "TinyBot validates controlled predicates.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));

        let error = save_response
            .error
            .expect("unsupported predicate should be rejected");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.message, "unsupported relation predicate");
        assert_eq!(error.details["predicate"], "stores");
        assert_eq!(
            error.details["allowed_predicates"],
            json!([
                "depends_on",
                "causes",
                "implements",
                "configures",
                "mentions",
                "conflicts_with",
                "supports"
            ])
        );
    }

    #[test]
    fn entity_graph_exposes_conflicting_relations_with_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-conflict-graph-1",
            "trace-conflict-graph",
            "knowledge.add_document",
            json!({
                "name": "Conflict Source",
                "content": "# Conflict Source\n\nTinyBot conflicts with LegacyBot behavior.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-conflict-graph-2",
            "trace-conflict-graph",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Conflict Source",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.91 },
                    { "name": "LegacyBot", "type": "project", "confidence": 0.88 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "LegacyBot",
                        "predicate": "conflicts_with",
                        "confidence": 0.84,
                        "evidence": [
                            {
                                "text": "TinyBot conflicts with LegacyBot behavior.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-conflict-graph-3",
            "trace-conflict-graph",
            "knowledge.graph",
            json!({
                "graph_type": "entity",
                "doc_id": doc_id,
                "include_orphans": true
            }),
        ));

        assert_eq!(graph_response.error, None);
        let graph = graph_response
            .result
            .as_ref()
            .expect("knowledge.graph should return result");
        assert_eq!(graph["stats"]["conflict_count"], 1);
        assert_eq!(graph["conflicts"].as_array().unwrap().len(), 1);
        assert_eq!(graph["conflicts"][0]["source_label"], "TinyBot");
        assert_eq!(graph["conflicts"][0]["target_label"], "LegacyBot");
        assert_eq!(graph["conflicts"][0]["predicate"], "conflicts_with");
        assert_eq!(
            graph["conflicts"][0]["evidence"][0]["text"],
            "TinyBot conflicts with LegacyBot behavior."
        );

        let stats_response = router.dispatch(&WorkerRequest::new(
            "req-conflict-graph-4",
            "trace-conflict-graph",
            "knowledge.stats",
            json!({}),
        ));
        assert_eq!(stats_response.error, None);
        let stats = stats_response
            .result
            .as_ref()
            .expect("knowledge.stats should return result");
        assert_eq!(stats["conflict_count"], 1);
    }

    #[test]
    fn knowledge_query_returns_conflict_metadata_for_graph_conflicts() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-query-conflict-1",
            "trace-query-conflict",
            "knowledge.add_document",
            json!({
                "name": "Query Conflict Source",
                "content": "# Query Conflict Source\n\nTinyBot conflicts with LegacyBot behavior.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-query-conflict-2",
            "trace-query-conflict",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Query Conflict Source",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.91 },
                    { "name": "LegacyBot", "type": "project", "confidence": 0.88 }
                ],
                "relations": [
                    {
                        "source": "TinyBot",
                        "target": "LegacyBot",
                        "predicate": "conflicts_with",
                        "confidence": 0.84,
                        "evidence": [
                            {
                                "text": "TinyBot conflicts with LegacyBot behavior.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-query-conflict-3",
            "trace-query-conflict",
            "knowledge.query",
            json!({
                "query": "TinyBot conflict LegacyBot",
                "category": "desktop",
                "limit": 3
            }),
        ));

        assert_eq!(query_response.error, None);
        let response = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result");
        assert_eq!(
            response["retrieval_plan"]["selected_routes"],
            json!(["keyword", "graph"])
        );
        let result = &response["results"][0];
        assert_eq!(result["matched_relations"][0]["label"], "conflicts_with");
        assert_eq!(
            result["matched_relation_evidence"][0]["text"],
            "TinyBot conflicts with LegacyBot behavior."
        );
        assert_eq!(result["conflict_metadata"].as_array().unwrap().len(), 1);
        assert_eq!(result["conflict_metadata"][0]["source_label"], "TinyBot");
        assert_eq!(result["conflict_metadata"][0]["target_label"], "LegacyBot");
        assert_eq!(
            result["conflict_metadata"][0]["predicate"],
            "conflicts_with"
        );
        assert_eq!(
            result["conflict_metadata"][0]["evidence"][0]["text"],
            "TinyBot conflicts with LegacyBot behavior."
        );
    }

    #[test]
    fn knowledge_query_returns_deterministic_retrieval_plan() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-plan-1",
            "trace-plan",
            "knowledge.add_document",
            json!({
                "name": "Knowledge API Notes",
                "content": "# Knowledge API Notes\n\nThe knowledge.document_tree API returns section hierarchy for exact navigation.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-plan-2",
            "trace-plan",
            "knowledge.query",
            json!({
                "query": "knowledge.document_tree API",
                "category": "desktop",
                "limit": 4
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result");
        assert_eq!(
            result["retrieval_plan"],
            json!({
                "object": "knowledge_retrieval_plan",
                "classification": "exact",
                "selected_routes": ["keyword"],
                "route_reasons": [
                    {
                        "route": "keyword",
                        "reason": "query contains exact identifiers or API/config-like terms"
                    }
                ],
                "budgets": {
                    "limit": 4,
                    "keyword": 4,
                    "semantic": 0,
                    "graph": 0,
                    "tree": 0
                },
                "fallback_behavior": "fallback_to_hybrid_when_no_results",
                "fallback_routes": ["keyword", "tree", "graph"],
                "graph_options": {
                    "include_graph_context": false,
                    "max_hops": 1,
                    "relation_filters": [],
                    "min_confidence": 0.0,
                    "max_added_chunks": 5
                },
                "tree_options": {
                    "include_structure_context": false,
                    "context_budget": 0,
                    "trigger": "none"
                }
            })
        );
        assert_eq!(result["results"][0]["retrieval_method"], "sparse");
    }

    #[test]
    fn knowledge_query_exact_retrieval_plan_includes_enabled_tree_route() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-plan-exact-tree-1",
            "trace-plan-exact-tree",
            "knowledge.add_document",
            json!({
                "name": "Knowledge API Tree Notes",
                "content": "# Knowledge API Tree Notes\n\nThe knowledge.document_tree API exposes exact section hierarchy.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-plan-exact-tree-2",
            "trace-plan-exact-tree",
            "knowledge.query",
            json!({
                "query": "where knowledge.document_tree API",
                "category": "desktop",
                "limit": 3
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result");
        assert_eq!(result["retrieval_plan"]["classification"], "exact");
        assert_eq!(
            result["retrieval_plan"]["selected_routes"],
            json!(["keyword", "tree"])
        );
        assert_eq!(result["retrieval_plan"]["budgets"]["tree"], 3);
        assert_eq!(
            result["results"][0]["matched_methods"],
            json!(["keyword", "structure"])
        );
    }

    #[test]
    fn knowledge_query_retrieval_plan_exposes_graph_options() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-plan-graph-1",
            "trace-plan-graph",
            "knowledge.add_document",
            json!({
                "name": "Knowledge Graph Notes",
                "content": "# Knowledge Graph Notes\n\nTinyBot depends on WorkerPool through RuntimeScheduler.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-plan-graph-2",
            "trace-plan-graph",
            "knowledge.query",
            json!({
                "query": "TinyBot dependency graph",
                "category": "desktop",
                "limit": 3,
                "include_structure_context": true,
                "include_graph_context": true,
                "graph_max_hops": 2,
                "graph_relation_filters": ["depends_on", "configures"],
                "graph_min_confidence": 0.75,
                "graph_max_added_chunks": 3
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result");
        assert_eq!(
            result["retrieval_plan"]["graph_options"],
            json!({
                "include_graph_context": true,
                "max_hops": 2,
                "relation_filters": ["depends_on", "configures"],
                "min_confidence": 0.75,
                "max_added_chunks": 3
            })
        );
        assert_eq!(
            result["retrieval_plan"]["tree_options"],
            json!({
                "include_structure_context": true,
                "context_budget": 3,
                "trigger": "explicit"
            })
        );
        assert_eq!(result["retrieval_plan"]["budgets"]["graph"], 3);
        assert_eq!(result["retrieval_plan"]["budgets"]["tree"], 3);
    }

    #[test]
    fn knowledge_query_retrieval_plan_selects_only_enabled_routes() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-plan-routes-1",
            "trace-plan-routes",
            "knowledge.add_document",
            json!({
                "name": "Concept Recall Notes",
                "content": "# Concept Recall Notes\n\nHybrid concept recall should still describe only enabled routes.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let query_response = router.dispatch(&WorkerRequest::new(
            "req-plan-routes-2",
            "trace-plan-routes",
            "knowledge.query",
            json!({
                "query": "concept recall",
                "category": "desktop",
                "limit": 3
            }),
        ));

        assert_eq!(query_response.error, None);
        let result = query_response
            .result
            .as_ref()
            .expect("knowledge.query should return result");
        assert_eq!(result["retrieval_plan"]["classification"], "hybrid");
        assert_eq!(
            result["retrieval_plan"]["selected_routes"],
            json!(["keyword"])
        );
        assert_eq!(result["retrieval_plan"]["budgets"]["graph"], 0);
        assert_eq!(result["retrieval_plan"]["budgets"]["tree"], 0);
    }

    #[test]
    fn knowledge_document_tree_returns_markdown_section_hierarchy() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let content = [
            "# Desktop Knowledge Notes",
            "",
            "Root overview.",
            "",
            "## Retrieval Pipeline",
            "",
            "Sparse retrieval should find parent sections.",
            "",
            "### Ranking Details",
            "",
            "RRF and sparse scores are tracked.",
            "",
            "## Operational Notes",
            "",
            "Unrelated final section.",
        ]
        .join("\n");

        let add_response = router.dispatch(&WorkerRequest::new(
            "req-tree-1",
            "trace-tree",
            "knowledge.add_document",
            json!({
                "name": "Tree Knowledge Notes",
                "content": content,
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let tree_response = router.dispatch(&WorkerRequest::new(
            "req-tree-2",
            "trace-tree",
            "knowledge.document_tree",
            json!({ "doc_id": doc_id }),
        ));

        assert_eq!(tree_response.error, None);
        let tree = tree_response
            .result
            .as_ref()
            .expect("knowledge.document_tree should return result");
        assert_eq!(tree["object"], "knowledge_document_tree");
        assert_eq!(tree["doc_id"], doc_id);
        assert_eq!(tree["root"]["id"], "section-root");
        assert_eq!(
            tree["root"]["children"],
            json!([format!("section_{doc_id}_0")])
        );
        assert_eq!(tree["section_count"], 4);
        assert_eq!(
            tree["sections"],
            json!([
                {
                    "id": format!("section_{doc_id}_0"),
                    "doc_id": doc_id,
                    "chunk_id": format!("chunk_{doc_id}_0"),
                    "title": "Desktop Knowledge Notes",
                    "section_path": "Desktop Knowledge Notes",
                    "parent_id": "section-root",
                    "children": [format!("section_{doc_id}_1"), format!("section_{doc_id}_3")],
                    "ordinal": 0,
                    "line_start": 1,
                    "line_end": 4,
                    "chunk_count": 1
                },
                {
                    "id": format!("section_{doc_id}_1"),
                    "doc_id": doc_id,
                    "chunk_id": format!("chunk_{doc_id}_1"),
                    "title": "Retrieval Pipeline",
                    "section_path": "Retrieval Pipeline",
                    "parent_id": format!("section_{doc_id}_0"),
                    "children": [format!("section_{doc_id}_2")],
                    "ordinal": 1,
                    "line_start": 5,
                    "line_end": 8,
                    "chunk_count": 1
                },
                {
                    "id": format!("section_{doc_id}_2"),
                    "doc_id": doc_id,
                    "chunk_id": format!("chunk_{doc_id}_2"),
                    "title": "Ranking Details",
                    "section_path": "Ranking Details",
                    "parent_id": format!("section_{doc_id}_1"),
                    "children": [],
                    "ordinal": 2,
                    "line_start": 9,
                    "line_end": 12,
                    "chunk_count": 1
                },
                {
                    "id": format!("section_{doc_id}_3"),
                    "doc_id": doc_id,
                    "chunk_id": format!("chunk_{doc_id}_3"),
                    "title": "Operational Notes",
                    "section_path": "Operational Notes",
                    "parent_id": format!("section_{doc_id}_0"),
                    "children": [],
                    "ordinal": 3,
                    "line_start": 13,
                    "line_end": 15,
                    "chunk_count": 1
                }
            ])
        );
    }

    #[test]
    fn dispatches_knowledge_stats_with_readiness_payload() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let content = [
            "# Stats Document",
            "",
            "Stats retrieval text for sparse readiness.",
            "",
            "## Second Section",
            "",
            "Another section for child chunk accounting.",
        ]
        .join("\n");
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Stats Document",
                "content": content,
                "category": "ops",
                "tags": ["stats"],
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let stats_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.stats",
            json!({}),
        ));

        assert_eq!(stats_response.error, None);
        let stats = stats_response
            .result
            .as_ref()
            .expect("knowledge.stats should return result");
        assert_eq!(stats["document_count"], 1);
        assert_eq!(stats["total_documents"], 1);
        assert_eq!(stats["chunk_count"], 2);
        assert_eq!(stats["parent_chunk_count"], 2);
        assert_eq!(stats["child_chunk_count"], 2);
        assert_eq!(stats["total_chunks"], 2);
        assert_eq!(stats["categories"], json!({ "ops": 1 }));
        assert_eq!(stats["indexed_sparse"], 4);
        assert_eq!(stats["indexed_dense"], 0);
        assert_eq!(stats["retrieval_ready"], true);
        assert_eq!(stats["claims_ready"], false);
        assert_eq!(stats["relations_ready"], false);
        assert_eq!(stats["graph_ready"], false);
        assert_eq!(stats["partial_availability"], true);
        assert_eq!(stats["failed_stage_count"], 0);
        assert_eq!(stats["stale_stage_count"], 0);
        assert_eq!(stats["stage_readiness"]["sparse_indexing"]["ready"], true);
        assert_eq!(stats["stage_readiness"]["tree_index"]["ready"], true);
        assert_eq!(stats["stage_readiness"]["tree_index"]["status"], "ready");
        assert_eq!(stats["stage_readiness"]["tree_index"]["processed"], 2);
        assert_eq!(stats["stage_readiness"]["tree_index"]["total"], 2);
        assert_eq!(stats["stage_readiness"]["tree_index"]["stale"], 0);
        assert_eq!(
            stats["stage_readiness"]["claim_extraction"]["status"],
            "not_configured"
        );
        assert_eq!(stats["stage_readiness"]["claim_extraction"]["total"], 0);
        assert_eq!(
            stats["stage_readiness"]["relation_extraction"]["status"],
            "not_configured"
        );
        assert_eq!(stats["stage_readiness"]["relation_extraction"]["total"], 0);
        assert_eq!(
            stats["stage_readiness"]["graph_projection"]["status"],
            "not_configured"
        );
        assert_eq!(stats["stage_readiness"]["graph_projection"]["total"], 0);
        assert_eq!(stats["stage_coverage"]["sparse_indexing"], 1.0);
        assert_eq!(stats["stage_coverage"]["tree_index"], 1.0);
        assert_eq!(stats["stage_details"], json!([]));
    }

    #[test]
    fn dispatches_persistent_knowledge_jobs_for_retrieval_index_and_rebuilds() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Job Document",
                "content": "# Job Document\n\nNative retrieval jobs should be persisted.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let start_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.start_index_job",
            json!({ "doc_id": doc_id }),
        ));
        assert_eq!(start_response.error, None);
        let started = start_response
            .result
            .as_ref()
            .expect("knowledge.start_index_job should return result");
        assert_eq!(started["id"], format!("kjob_{doc_id}"));
        assert_eq!(started["doc_id"], doc_id);
        assert_eq!(started["status"], "completed");
        assert_eq!(started["stage"], "retrieval_indexed");
        assert_eq!(started["processed"], 1);
        assert_eq!(started["total"], 1);
        assert_eq!(started["retrieval_ready"], true);
        assert_eq!(started["graph_ready"], false);
        assert!(fixture
            .read("knowledge/jobs.jsonl")
            .contains(&format!("kjob_{doc_id}")));

        let get_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "knowledge.get_job",
            json!({ "job_id": format!("kjob_{doc_id}") }),
        ));
        assert_eq!(get_response.error, None);
        assert_eq!(
            get_response.result.as_ref().unwrap()["id"],
            format!("kjob_{doc_id}")
        );

        let rebuild_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "knowledge.rebuild_index",
            json!({ "type": "all" }),
        ));
        assert_eq!(rebuild_response.error, None);
        let rebuild = rebuild_response
            .result
            .as_ref()
            .expect("knowledge.rebuild_index should return result");
        assert_eq!(rebuild["id"], "kjob_rebuild_all");
        assert_eq!(rebuild["name"], "rebuild:all");
        assert_eq!(rebuild["status"], "completed");
        assert_eq!(rebuild["stage"], "completed");
        assert_eq!(rebuild["result"]["semantic"]["available"], false);
        assert_eq!(rebuild["result"]["bm25"]["chunks_indexed"], 1);

        let tree_rebuild_response = router.dispatch(&WorkerRequest::new(
            "req-5",
            "trace-1",
            "knowledge.rebuild_index",
            json!({ "type": "tree" }),
        ));
        assert_eq!(tree_rebuild_response.error, None);
        let tree_rebuild = tree_rebuild_response
            .result
            .as_ref()
            .expect("knowledge.rebuild_index tree should return result");
        assert_eq!(tree_rebuild["id"], "kjob_rebuild_tree");
        assert_eq!(tree_rebuild["name"], "rebuild:tree");
        assert_eq!(tree_rebuild["status"], "completed");
        assert_eq!(tree_rebuild["result"]["available"], true);
        assert_eq!(tree_rebuild["result"]["documents_scanned"], 1);
        assert_eq!(tree_rebuild["result"]["sections_indexed"], 1);
        assert_eq!(tree_rebuild["result"]["tree_ready"], true);
    }

    #[test]
    fn dispatches_explicit_knowledge_document_graph() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let target_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Target.md",
                "content": "# Target\n\nReferenced explicitly.\n",
                "file_type": "md"
            }),
        ));
        assert_eq!(target_response.error, None);

        let source_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Source.md",
                "content": "# Source\n\nSee [Target](Target.md), [Site](https://example.com/a), and notes/local.md.\n",
                "file_type": "md",
                "category": "docs",
                "tags": ["ops"]
            }),
        ));
        assert_eq!(source_response.error, None);
        let source_id = source_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("source document id should be present")
            .to_string();

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "knowledge.graph",
            json!({ "doc_id": source_id, "include_orphans": true }),
        ));
        assert_eq!(graph_response.error, None);
        let graph = graph_response
            .result
            .as_ref()
            .expect("knowledge.graph should return result");
        assert_eq!(graph["object"], "knowledge_graph");
        assert_eq!(graph["graph_type"], "document");
        let edge_types = graph["edges"]
            .as_array()
            .expect("graph edges should be an array")
            .iter()
            .filter_map(|edge| edge["type"].as_str())
            .collect::<Vec<_>>();
        assert!(edge_types.contains(&"links_to"));
        assert!(edge_types.contains(&"references_url"));
        assert!(edge_types.contains(&"references_file"));
        assert!(edge_types.contains(&"tagged"));
        assert!(edge_types.contains(&"categorized_as"));
        let node_types = graph["nodes"]
            .as_array()
            .expect("graph nodes should be an array")
            .iter()
            .filter_map(|node| node["type"].as_str())
            .collect::<Vec<_>>();
        assert!(node_types.contains(&"document"));
        assert!(node_types.contains(&"tag"));
        assert!(node_types.contains(&"category"));
        assert!(node_types.contains(&"url"));
        assert!(node_types.contains(&"file"));
        assert!(fixture
            .read("knowledge/document_graph_edges.jsonl")
            .contains("references_url"));
    }

    #[test]
    fn dispatches_entity_graph_extraction_persistence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Entity Source.md",
                "content": "# Entity Source\n\nTinyBot stores knowledge graph evidence.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Entity Source.md",
                "model": "knowledge-model",
                "token_estimate": { "total_tokens": 120, "max_tokens": 800 },
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.91, "evidence": [{ "text": "TinyBot stores knowledge graph evidence.", "line_start": 3, "line_end": 3 }] },
                    { "name": "knowledge graph", "type": "concept", "confidence": 0.86 }
                ],
                "relations": [
                    { "source": "TinyBot", "target": "knowledge graph", "predicate": "supports", "confidence": 0.82, "evidence": [{ "text": "TinyBot stores knowledge graph evidence.", "line_start": 3, "line_end": 3 }] }
                ],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);
        let job = save_response
            .result
            .as_ref()
            .expect("knowledge.save_entity_graph_extraction should return result");
        assert_eq!(job["id"], format!("kjob_extract_graph_{doc_id}"));
        assert_eq!(job["stage"], "entity_graph_extracted");
        assert_eq!(job["result"]["entities"], 2);
        assert_eq!(job["result"]["relations"], 1);
        assert!(fixture
            .read("knowledge/entity_graph_nodes.jsonl")
            .contains("TinyBot"));
        assert!(fixture
            .read("knowledge/entity_graph_edges.jsonl")
            .contains("supports"));
        assert!(fixture
            .read("knowledge/entity_graph_evidence.jsonl")
            .contains("knowledge graph evidence"));

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "knowledge.graph",
            json!({ "doc_id": doc_id, "graph_type": "entity", "include_orphans": true }),
        ));
        assert_eq!(graph_response.error, None);
        let graph = graph_response
            .result
            .as_ref()
            .expect("knowledge.graph should return entity graph");
        assert_eq!(graph["graph_type"], "entity");
        assert_eq!(graph["stats"]["node_count"], 2);
        assert_eq!(graph["stats"]["edge_count"], 1);
        assert_eq!(graph["readiness"]["entity_graph_ready"], true);
        assert_eq!(
            graph["nodes"][0]["evidence"][0]["text"],
            "TinyBot stores knowledge graph evidence."
        );
        assert_eq!(
            graph["edges"][0]["evidence"][0]["text"],
            "TinyBot stores knowledge graph evidence."
        );
        assert_eq!(graph["stats"]["stale_count"], 0);
        assert_eq!(graph["readiness"]["entity_graph_stale"], false);

        fixture.write(
            "knowledge/documents.jsonl",
            &fixture.read("knowledge/documents.jsonl").replace(
                "TinyBot stores knowledge graph evidence.",
                "TinyBot stores updated knowledge graph evidence.",
            ),
        );
        let stale_graph_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "knowledge.graph",
            json!({ "doc_id": doc_id, "graph_type": "entity", "include_orphans": true }),
        ));
        assert_eq!(stale_graph_response.error, None);
        let stale_graph = stale_graph_response
            .result
            .as_ref()
            .expect("knowledge.graph should return stale entity graph");
        assert_eq!(stale_graph["stats"]["stale_node_count"], 2);
        assert_eq!(stale_graph["stats"]["stale_edge_count"], 1);
        assert_eq!(stale_graph["readiness"]["entity_graph_stale"], true);
        assert_eq!(stale_graph["nodes"][0]["attributes"]["stale"], true);
        assert_eq!(stale_graph["edges"][0]["attributes"]["stale"], true);
        assert!(stale_graph["nodes"][0]["attributes"]["current_source_hash"].is_string());

        let stats_response = router.dispatch(&WorkerRequest::new(
            "req-5",
            "trace-1",
            "knowledge.stats",
            json!({}),
        ));
        assert_eq!(stats_response.error, None);
        let stats = stats_response
            .result
            .as_ref()
            .expect("knowledge.stats should return result");
        assert_eq!(stats["entity_count"], 2);
        assert_eq!(stats["relation_count"], 1);
        assert_eq!(stats["source_count"], 2);
        assert_eq!(stats["graph_ready"], true);
        assert_eq!(stats["stale_stage_count"], 1);
        assert_eq!(
            stats["stage_readiness"]["graph_projection"]["status"],
            "stale"
        );
        assert_eq!(stats["stage_readiness"]["graph_projection"]["stale"], 3);
    }

    #[test]
    fn deleting_knowledge_document_purges_entity_graph_records() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Delete Entity Source.md",
                "content": "# Delete Entity Source\n\nTinyBot deletion evidence should disappear.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Delete Entity Source.md",
                "model": "knowledge-model",
                "entities": [
                    { "name": "TinyBot", "type": "project", "confidence": 0.91, "evidence": [{ "text": "TinyBot deletion evidence should disappear.", "line_start": 3, "line_end": 3 }] }
                ],
                "relations": [
                    { "source": "TinyBot", "target": "Deletion", "predicate": "conflicts_with", "confidence": 0.82, "evidence": [{ "text": "TinyBot deletion evidence should disappear.", "line_start": 3, "line_end": 3 }] }
                ]
            }),
        ));
        assert_eq!(save_response.error, None);

        let delete_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "knowledge.delete_document",
            json!({ "doc_id": doc_id }),
        ));
        assert_eq!(delete_response.error, None);
        assert_eq!(delete_response.result.as_ref().unwrap()["deleted"], true);
        assert!(!fixture
            .read("knowledge/entity_graph_nodes.jsonl")
            .contains("TinyBot"));
        assert!(!fixture
            .read("knowledge/entity_graph_edges.jsonl")
            .contains("conflicts_with"));
        assert!(!fixture
            .read("knowledge/entity_graph_evidence.jsonl")
            .contains("deletion evidence"));

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "knowledge.graph",
            json!({ "graph_type": "entity", "include_orphans": true }),
        ));
        assert_eq!(graph_response.error, None);
        let graph = graph_response.result.as_ref().unwrap();
        assert_eq!(graph["stats"]["node_count"], 0);
        assert_eq!(graph["stats"]["edge_count"], 0);
        assert_eq!(graph["readiness"]["entity_graph_ready"], false);
    }

    #[test]
    fn rebuilding_knowledge_index_refreshes_document_graph() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let target_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Upgrade Target.md",
                "content": "# Upgrade Target\n\nExisting workspace target.\n",
                "file_type": "md"
            }),
        ));
        assert_eq!(target_response.error, None);
        let source_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Upgrade Source.md",
                "content": "# Upgrade Source\n\nSee [Upgrade Target](Upgrade Target.md).\n",
                "file_type": "md"
            }),
        ));
        assert_eq!(source_response.error, None);
        let document_graph_nodes = fixture.root.join("knowledge/document_graph_nodes.jsonl");
        let document_graph_edges = fixture.root.join("knowledge/document_graph_edges.jsonl");
        let _ = std::fs::remove_file(document_graph_nodes);
        let _ = std::fs::remove_file(document_graph_edges);

        let rebuild_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "knowledge.rebuild_index",
            json!({ "type": "bm25" }),
        ));
        assert_eq!(rebuild_response.error, None);

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "knowledge.graph",
            json!({ "graph_type": "document", "include_orphans": true }),
        ));
        assert_eq!(graph_response.error, None);
        let graph = graph_response.result.as_ref().unwrap();
        assert_eq!(graph["readiness"]["document_graph_ready"], true);
        assert!(graph["stats"]["edge_count"].as_u64().unwrap_or_default() > 0);
        assert!(fixture
            .read("knowledge/document_graph_edges.jsonl")
            .contains("links_to"));
    }

    #[test]
    fn entity_graph_queries_honor_min_confidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Confidence Source.md",
                "content": "# Confidence Source\n\nHigh and low confidence graph data.\n",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Confidence Source.md",
                "model": "knowledge-model",
                "entities": [
                    { "name": "HighConfidence", "type": "concept", "confidence": 0.95 },
                    { "name": "LowConfidence", "type": "concept", "confidence": 0.25 }
                ],
                "relations": [
                    { "source": "HighConfidence", "target": "HighConfidence", "predicate": "supports", "confidence": 0.96, "evidence": [{ "text": "High and low confidence graph data.", "line_start": 3, "line_end": 3 }] },
                    { "source": "HighConfidence", "target": "LowConfidence", "predicate": "mentions", "confidence": 0.20, "evidence": [{ "text": "High and low confidence graph data.", "line_start": 3, "line_end": 3 }] }
                ]
            }),
        ));
        assert_eq!(save_response.error, None);

        let graph_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "knowledge.graph",
            json!({
                "doc_id": doc_id,
                "graph_type": "entity",
                "include_orphans": true,
                "min_confidence": 0.9
            }),
        ));
        assert_eq!(graph_response.error, None);
        let graph = graph_response.result.as_ref().unwrap();
        assert_eq!(graph["stats"]["node_count"], 1);
        assert_eq!(graph["stats"]["edge_count"], 1);
        assert_eq!(graph["nodes"][0]["label"], "HighConfidence");
        assert_eq!(graph["edges"][0]["label"], "supports");
    }

    #[test]
    fn dispatches_knowledge_context_for_persistent_results() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "knowledge.add_document",
            json!({
                "name": "Runtime Context Notes",
                "content": "# Runtime Context Notes\n\nNative knowledge context should cite persistent retrieval evidence.\n",
                "category": "runtime",
                "tags": ["context"],
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let context_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "knowledge.context",
            json!({
                "current_message": "Please use persistent retrieval evidence",
                "session_key": "desktop:session-1",
                "max_chunks": 3,
                "use_persistent_knowledge": true
            }),
        ));

        assert_eq!(context_response.error, None);
        let result = context_response
            .result
            .as_ref()
            .expect("knowledge.context should return result");
        assert!(result["context"]
            .as_str()
            .expect("context should be string")
            .contains("[RELEVANT KNOWLEDGE]"));
        assert!(result["context"]
            .as_str()
            .expect("context should be string")
            .contains("contextual evidence"));
        assert!(result["context"]
            .as_str()
            .expect("context should be string")
            .contains("Runtime Context Notes"));
        assert_eq!(result["persistent_results"][0]["doc_id"], doc_id);
        assert_eq!(result["session_results"], json!([]));
        assert_eq!(
            result["references"][0],
            json!({
                "doc_id": doc_id,
                "doc_name": "Runtime Context Notes",
                "chunk_id": format!("chunk_{doc_id}_0"),
                "file_path": format!("knowledge/files/{doc_id}.md"),
                "line_start": 1,
                "line_end": 3,
                "retrieval_method": "sparse"
            })
        );
    }

    #[test]
    fn knowledge_context_references_preserve_graph_evidence_metadata() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-context-graph-1",
            "trace-context-graph",
            "knowledge.add_document",
            json!({
                "name": "Context Graph Notes",
                "content": "# Context Graph Notes\n\nThe orchestration layer coordinates background jobs.\n",
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        let doc_id = add_response
            .result
            .as_ref()
            .expect("knowledge.add_document should return result")["document"]["id"]
            .as_str()
            .expect("document id should be present")
            .to_string();

        let save_response = router.dispatch(&WorkerRequest::new(
            "req-context-graph-2",
            "trace-context-graph",
            "knowledge.save_entity_graph_extraction",
            json!({
                "doc_id": doc_id,
                "doc_name": "Context Graph Notes",
                "model": "knowledge-model",
                "entities": [
                    {
                        "name": "TinyBot",
                        "type": "project",
                        "confidence": 0.93,
                        "evidence": [
                            {
                                "text": "The orchestration layer coordinates background jobs.",
                                "line_start": 3,
                                "line_end": 3
                            }
                        ]
                    }
                ],
                "relations": [],
                "diagnostics": { "chunks_used": 1 }
            }),
        ));
        assert_eq!(save_response.error, None);

        let context_response = router.dispatch(&WorkerRequest::new(
            "req-context-graph-3",
            "trace-context-graph",
            "knowledge.context",
            json!({
                "current_message": "TinyBot dependency",
                "session_key": "desktop:session-graph",
                "max_chunks": 3,
                "use_persistent_knowledge": true
            }),
        ));

        assert_eq!(context_response.error, None);
        let result = context_response
            .result
            .as_ref()
            .expect("knowledge.context should return result");
        assert_eq!(result["persistent_results"][0]["retrieval_method"], "graph");
        assert_eq!(result["references"][0]["retrieval_method"], "graph");
        assert_eq!(
            result["references"][0]["source_snippets"][0]["text"],
            "The orchestration layer coordinates background jobs."
        );
        assert_eq!(
            result["references"][0]["projection_metadata"][0]["projection"],
            "entity_graph"
        );
        assert_eq!(
            result["references"][0]["projection_metadata"][0]["owner_label"],
            "TinyBot"
        );
        assert_eq!(
            result["references"][0]["score_metadata"]["components"]["evidence_quality_bonus"]
                ["score"],
            1
        );
    }

    #[test]
    fn knowledge_context_references_preserve_tree_structure_metadata() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let content = [
            "# Context Tree Notes",
            "",
            "Root overview.",
            "",
            "## Retrieval Pipeline",
            "",
            "The uniquetreecontext marker belongs to retrieval.",
            "",
            "### Ranking Details",
            "",
            "Ranking details should be listed as a child section.",
        ]
        .join("\n");
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-context-tree-1",
            "trace-context-tree",
            "knowledge.add_document",
            json!({
                "name": "Context Tree Notes",
                "content": content,
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let context_response = router.dispatch(&WorkerRequest::new(
            "req-context-tree-2",
            "trace-context-tree",
            "knowledge.context",
            json!({
                "current_message": "where uniquetreecontext",
                "session_key": "desktop:session-tree",
                "max_chunks": 3,
                "use_persistent_knowledge": true
            }),
        ));

        assert_eq!(context_response.error, None);
        let result = context_response
            .result
            .as_ref()
            .expect("knowledge.context should return result");
        assert_eq!(
            result["persistent_results"][0]["matched_methods"],
            json!(["keyword", "structure"])
        );
        assert_eq!(
            result["references"][0]["structure_context"]["section"]["title"],
            "Retrieval Pipeline"
        );
        assert_eq!(
            result["references"][0]["structure_context"]["parent_section"]["title"],
            "Context Tree Notes"
        );
        assert_eq!(
            result["references"][0]["structure_context"]["child_sections"][0]["title"],
            "Ranking Details"
        );
    }

    #[test]
    fn knowledge_context_returns_retrieval_plan_for_persistent_results() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::KnowledgeWrite,
            ]),
        );
        let content = [
            "# Context Plan Notes",
            "",
            "Root overview.",
            "",
            "## Retrieval Location",
            "",
            "The uniquetreeplan marker belongs under the retrieval location section.",
        ]
        .join("\n");
        let add_response = router.dispatch(&WorkerRequest::new(
            "req-context-plan-1",
            "trace-context-plan",
            "knowledge.add_document",
            json!({
                "name": "Context Plan Notes",
                "content": content,
                "category": "desktop",
                "file_type": "md"
            }),
        ));
        assert_eq!(add_response.error, None);

        let context_response = router.dispatch(&WorkerRequest::new(
            "req-context-plan-2",
            "trace-context-plan",
            "knowledge.context",
            json!({
                "current_message": "where uniquetreeplan",
                "session_key": "desktop:session-plan",
                "max_chunks": 3,
                "use_persistent_knowledge": true
            }),
        ));

        assert_eq!(context_response.error, None);
        let result = context_response
            .result
            .as_ref()
            .expect("knowledge.context should return result");
        assert_eq!(
            result["retrieval_plan"]["selected_routes"],
            json!(["keyword", "tree"])
        );
        assert_eq!(
            result["retrieval_plan"]["tree_options"],
            json!({
                "include_structure_context": true,
                "context_budget": 3,
                "trigger": "auto"
            })
        );
        assert_eq!(
            result["persistent_results"][0]["matched_methods"],
            json!(["keyword", "structure"])
        );
    }

    #[test]
    fn dispatches_knowledge_context_with_session_temporary_files() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.session_id = "websocket:chat-1".to_string();
        session.extra["temporary_files"] = json!([
            {
                "id": "session_doc_temp1",
                "name": "Session Notes.md",
                "file_type": "md",
                "content": "# Session Notes\n\nTemporary session evidence should be available without persistent retrieval.",
                "created_at": "2026-06-13T10:00:00Z",
                "chunk_count": 1,
                "metadata": { "size_bytes": 86 },
                "size_bytes": 86,
                "temporary": true
            }
        ]);
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let context_response = router.dispatch(&WorkerRequest::new(
            "req-temp-context",
            "trace-temp-context",
            "knowledge.context",
            json!({
                "current_message": "Please use the temporary session evidence",
                "session_key": "websocket:chat-1",
                "max_chunks": 3,
                "use_persistent_knowledge": false
            }),
        ));

        assert_eq!(context_response.error, None);
        let result = context_response
            .result
            .as_ref()
            .expect("knowledge.context should return result");
        let context = result["context"]
            .as_str()
            .expect("context should be string");
        assert!(context.contains("[RELEVANT KNOWLEDGE]"));
        assert!(context.contains("[Current session temporary files]"));
        assert!(context.contains("Session Notes.md"));
        assert_eq!(result["persistent_results"], json!([]));
        assert_eq!(result["session_results"][0]["id"], "session_doc_temp1");
        assert_eq!(result["session_results"][0]["temporary"], true);
        assert_eq!(
            result["references"][0],
            json!({
                "doc_id": "session_doc_temp1",
                "doc_name": "Session Notes.md",
                "chunk_id": "session_doc_temp1",
                "file_path": "session://websocket:chat-1/Session Notes.md",
                "line_start": 1,
                "line_end": 3,
                "retrieval_method": "session_temporary",
                "temporary": true
            })
        );
    }

    #[test]
    fn dispatches_knowledge_session_temporary_file_lifecycle() {
        let fixture = WorkspaceFixture::new();
        let mut session = session_fixture();
        session.session_id = "websocket:chat-1".to_string();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![session],
            20,
            CapabilityPolicy::new([
                WorkerCapability::KnowledgeRead,
                WorkerCapability::SessionMetadataRead,
                WorkerCapability::SessionWrite,
            ]),
        );

        let upload_response = router.dispatch(&WorkerRequest::new(
            "req-knowledge-session-upload",
            "trace-knowledge-session-upload",
            "knowledge.session_upload",
            json!({
                "session_id": "websocket:chat-1",
                "name": "Session Notes.md",
                "file_type": "md",
                "content": "# Session Notes\n\nTemporary evidence for this chat.",
                "size_bytes": 50
            }),
        ));

        assert_eq!(upload_response.error, None);
        let upload_result = upload_response
            .result
            .as_ref()
            .expect("knowledge.session_upload should return result");
        assert_eq!(upload_result["name"], "Session Notes.md");
        assert_eq!(upload_result["temporary"], true);
        assert_eq!(upload_result["source"], "session_upload");

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-knowledge-session-list",
            "trace-knowledge-session-list",
            "knowledge.session_list",
            json!({ "session_id": "websocket:chat-1" }),
        ));

        assert_eq!(list_response.error, None);
        assert_eq!(
            list_response.result.as_ref().unwrap()["session_id"],
            "websocket:chat-1"
        );
        assert_eq!(
            list_response.result.as_ref().unwrap()["temporary_files"][0]["name"],
            "Session Notes.md"
        );

        let clear_response = router.dispatch(&WorkerRequest::new(
            "req-knowledge-session-clear",
            "trace-knowledge-session-clear",
            "knowledge.session_clear",
            json!({ "session_id": "websocket:chat-1" }),
        ));

        assert_eq!(clear_response.error, None);
        assert_eq!(
            clear_response.result.as_ref().unwrap()["session_id"],
            "websocket:chat-1"
        );
        assert_eq!(clear_response.result.as_ref().unwrap()["cleared"], 1);
        assert_eq!(
            clear_response.result.as_ref().unwrap()["temporary_files"],
            json!([])
        );
    }

    fn approval_request(
        request_id: &'static str,
        run_id: &str,
        session_id: &str,
        operation: Value,
        fingerprint: &str,
        session_fingerprint: &str,
    ) -> WorkerRequest {
        WorkerRequest::new(
            request_id,
            "trace-1",
            "approval.request",
            json!({
                "run_id": run_id,
                "session_id": session_id,
                "operation": operation,
                "classification": {
                    "category": "filesystem_write",
                    "risk": "medium",
                    "reason": "File write/edit/delete tools can modify workspace state."
                },
                "fingerprint": fingerprint,
                "session_fingerprint": session_fingerprint,
                "summary": "write_file path=\"notes/today.md\""
            }),
        )
    }

    fn approve_once(
        router: &mut WorkerRpcRouter,
        run_id: &str,
        session_id: &str,
        operation: Value,
        category: &str,
        risk: &str,
        reason: &str,
        fingerprint: &str,
        session_fingerprint: &str,
    ) {
        let request_response = router.dispatch(&WorkerRequest::new(
            "req-approval-helper",
            "trace-approval",
            "approval.request",
            json!({
                "run_id": run_id,
                "session_id": session_id,
                "operation": operation,
                "classification": {
                    "category": category,
                    "risk": risk,
                    "reason": reason
                },
                "fingerprint": fingerprint,
                "session_fingerprint": session_fingerprint
            }),
        ));
        let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        let resolve_response = router.dispatch(&WorkerRequest::new(
            "req-approval-resolve-helper",
            "trace-approval",
            "approval.resolve",
            json!({
                "session_id": session_id,
                "approval_id": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ));
        assert!(resolve_response.error.is_none());
    }

    #[test]
    fn workspace_write_consumes_matching_once_approval_grant() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
                WorkerCapability::FsWorkspaceWrite,
            ]),
        );

        let denied = router.dispatch(&WorkerRequest::new(
            "req-write-denied",
            "trace-1",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "hello",
                "session_id": "session-1"
            }),
        ));
        let error = denied.error.expect("write without approval should fail");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["boundary"], "security");
        assert!(!fixture.root.join("notes").join("today.md").exists());

        let request_response = router.dispatch(&approval_request(
            "req-approval",
            "run-1",
            "session-1",
            json!({
                "toolName": "write_file",
                "arguments": { "path": "notes/today.md" }
            }),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ));
        let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        let resolve_response = router.dispatch(&WorkerRequest::new(
            "req-resolve",
            "trace-2",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ));
        assert!(resolve_response.error.is_none());

        let allowed = router.dispatch(&WorkerRequest::new(
            "req-write-allowed",
            "trace-3",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "hello",
                "session_id": "session-1"
            }),
        ));
        assert!(allowed.error.is_none());
        assert_eq!(fixture.read("notes/today.md"), "hello");

        let reused = router.dispatch(&WorkerRequest::new(
            "req-write-reused",
            "trace-4",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "changed",
                "session_id": "session-1"
            }),
        ));
        assert_eq!(
            reused.error.expect("once approval should be consumed").code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(fixture.read("notes/today.md"), "hello");
    }

    #[test]
    fn workspace_write_allows_trusted_internal_operations_without_approval() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
        );

        let denied = router.dispatch(&WorkerRequest::new(
            "req-write-denied",
            "trace-1",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "agent write",
                "session_id": "session-1"
            }),
        ));
        assert_eq!(
            denied
                .error
                .expect("agent write should require approval")
                .code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert!(!fixture.root.join("notes").join("today.md").exists());

        let allowed = router.dispatch(&WorkerRequest::new(
            "req-write-internal",
            "trace-2",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "webui write",
                "internal_operation": true
            }),
        ));
        assert!(allowed.error.is_none());
        assert_eq!(fixture.read("notes/today.md"), "webui write");
    }

    #[test]
    fn shell_execute_requires_matching_approval_grant() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ShellExecute]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-shell-denied",
            "trace-1",
            "shell.execute",
            json!({
                "command": "echo tinybot",
                "working_dir": ".",
                "timeout": 30,
                "session_id": "session-1"
            }),
        ));

        let error = response.error.expect("shell without approval should fail");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["boundary"], "security");
        assert_eq!(error.details["category"], "shell");
        assert_eq!(error.details["fingerprint"], "exec:echo tinybot");
    }

    #[test]
    fn dispatches_workspace_list_dir_and_delete_file_requests() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
                WorkerCapability::FsWorkspaceRead,
                WorkerCapability::FsWorkspaceWrite,
            ]),
        );

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-list",
            "trace-1",
            "workspace.list_dir",
            json!({ "path": ".", "recursive": true, "max_entries": 10 }),
        ));
        approve_once(
            &mut router,
            "run-delete",
            "session-1",
            json!({
                "toolName": "delete_file",
                "arguments": { "path": "notes" }
            }),
            "filesystem_write",
            "medium",
            "File write/edit/delete tools can modify workspace state.",
            "delete_file:notes",
            "delete_file:notes",
        );
        let delete_response = router.dispatch(&WorkerRequest::new(
            "req-delete",
            "trace-1",
            "workspace.delete_file",
            json!({ "path": "notes", "recursive": true, "session_id": "session-1" }),
        ));

        assert_eq!(
            list_response.result.as_ref().unwrap()["entries"][0]["path"],
            "notes/"
        );
        assert_eq!(
            list_response.result.as_ref().unwrap()["entries"][1]["path"],
            "notes/today.md"
        );
        assert_eq!(
            delete_response.result,
            Some(json!({ "path": "notes", "kind": "dir", "deleted": true }))
        );
        assert!(list_response.error.is_none());
        assert!(delete_response.error.is_none());
    }

    #[test]
    fn dispatches_shell_execute_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
                WorkerCapability::ShellExecute,
            ]),
        );
        approve_once(
            &mut router,
            "run-shell",
            "session-1",
            json!({
                "toolName": "exec",
                "arguments": { "command": "echo tinybot" }
            }),
            "shell",
            "high",
            "Shell execution can modify files, run programs, or access the network.",
            "exec:echo tinybot",
            "exec:echo tinybot",
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-shell",
            "trace-1",
            "shell.execute",
            json!({
                "command": "echo tinybot",
                "working_dir": ".",
                "timeout": 5,
                "session_id": "session-1"
            }),
        ));

        let result = response.result.expect("shell.execute should return result");
        assert_eq!(result["exit_code"], 0);
        assert_eq!(result["timed_out"], false);
        assert_eq!(result["blocked"], false);
        assert!(result["content"].as_str().unwrap().contains("tinybot"));
        assert!(response.error.is_none());
    }

    fn session_fixture() -> crate::worker_session::SessionMetadata {
        crate::worker_session::SessionMetadata {
            session_id: "session-1".to_string(),
            title: "Native Core Migration".to_string(),
            workspace_dir: "D:/code/tinybot/tinybot".to_string(),
            created_at: "2026-06-09T09:00:00Z".to_string(),
            updated_at: "2026-06-09T09:30:00Z".to_string(),
            extra: json!({ "mode": "desktop" }),
        }
    }

    fn first_thread_log_file(root: &Path) -> PathBuf {
        fn visit(dir: &Path) -> Option<PathBuf> {
            for entry in std::fs::read_dir(dir).ok()? {
                let path = entry.ok()?.path();
                if path.is_dir() {
                    if let Some(found) = visit(&path) {
                        return Some(found);
                    }
                } else if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("thread-") && name.ends_with(".jsonl"))
                {
                    return Some(path);
                }
            }
            None
        }
        visit(&root.join(".tinybot").join("threads")).expect("thread log file should exist")
    }

    struct WorkspaceFixture {
        root: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let counter = WORKSPACE_FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-rpc-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos(),
                counter
            ));
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            Self { root }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }

        fn read(&self, relative_path: &str) -> String {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::read_to_string(path).expect("fixture file should read")
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
