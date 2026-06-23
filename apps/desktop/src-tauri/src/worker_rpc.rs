use crate::config_store::{ConfigPatchBridgeResult, ConfigStore};
use crate::worker_background::{
    BackgroundRunCompleteParams, BackgroundRunUpsertParams, WorkerBackgroundRpc,
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
use crate::worker_protocol::{WorkerRequest, WorkerResponse};
use crate::worker_secret::{ProviderResolveSecretParams, WorkerSecretRpc};
use crate::worker_session::{SessionMetadata, WorkerSessionRpc};
use crate::worker_shell::{ShellExecuteParams, WorkerShellRpc};
use crate::worker_task::{TaskPlanIdParams, TaskPlanListParams, TaskPlanSaveParams, WorkerTaskRpc};
use crate::worker_workspace::{WorkerWorkspaceRpc, WorkspaceReadFormat, WorkspaceReadOptions};
use serde::Deserialize;
use serde_json::Value;
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
            mcp: WorkerMcpRpc::new(config_snapshot, policy),
            runtime: WorkerRuntimeRpc::new(),
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
            mcp: WorkerMcpRpc::new(config_snapshot, policy),
            runtime: WorkerRuntimeRpc::new(),
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
                self.approval
                    .require_sensitive_operation(workspace_write_approval(
                        &params.path,
                        params.session_id.clone(),
                        params.run_id.clone(),
                    ))?;
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
                self.approval
                    .require_sensitive_operation(workspace_delete_approval(
                        &params.path,
                        params.session_id.clone(),
                        params.run_id.clone(),
                    ))?;
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
            "provider.resolve_secret" => {
                let params: ProviderResolveSecretParams = parse_params(request)?;
                serde_json::to_value(self.secret.resolve_secret(params)?)
                    .map_err(serialization_error)
            }
            "session.get_metadata" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.session.get_metadata(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.get_history" => {
                let params: SessionHistoryParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .get_history(&params.session_id, params.limit.unwrap_or(80))?,
                )
                .map_err(serialization_error)
            }
            "session.list_metadata" => {
                serde_json::to_value(self.session.list_metadata()?).map_err(serialization_error)
            }
            "session.get_checkpoint" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.session.get_checkpoint(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.set_checkpoint" => {
                let params: SessionCheckpointParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .set_checkpoint(&params.session_id, params.checkpoint)?,
                )
                .map_err(serialization_error)
            }
            "session.clear_checkpoint" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.session.clear_checkpoint(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.clear" => {
                let params: SessionIdParams = parse_params(request)?;
                serde_json::to_value(self.session.clear_session(&params.session_id)?)
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
                serde_json::to_value(self.session.delete_session(&params.session_id)?)
                    .map_err(serialization_error)
            }
            "session.patch_metadata" => {
                let params: SessionPatchMetadataParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .patch_metadata(&params.session_id, params.metadata)?,
                )
                .map_err(serialization_error)
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
                let context_metadata = params.context_metadata();
                serde_json::to_value(self.session.persist_turn(
                    &params.session_id,
                    &params.run_id,
                    params.messages,
                    params.clear_checkpoint,
                    context_metadata,
                )?)
                .map_err(serialization_error)
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
            "mcp.call_tool" => self.mcp.call_tool_from_request(request),
            "mcp.list_tools" => self.mcp.list_tools(),
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
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
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

fn serialization_error(error: serde_json::Error) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::WorkerError,
        "failed to serialize worker RPC result",
        serde_json::json!({ "error": error.to_string() }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
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
        ".js", ".jsx", ".rs", ".py",
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
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
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
            "tinybot/skills/planner/SKILL.md",
            "---\nname: planner\ndescription: Builtin planner\n---\nBuiltin body",
        );
        fixture.write(
            "tinybot/skills/tmux/SKILL.md",
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
                        "path": "tinybot/skills/tmux/SKILL.md",
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
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.patch_metadata",
            json!({
                "session_id": "session-1",
                "metadata": { "pinned": true }
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result.as_ref().unwrap()["extra"]["metadata"],
            json!({
                "pinned": true,
                "topic": "old"
            })
        );
        assert!(response.error.is_none());
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
            CapabilityPolicy::new([WorkerCapability::SessionWrite]),
        );
        let set_request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "session.set_checkpoint",
            json!({
                "session_id": "session-1",
                "checkpoint": { "phase": "awaiting_tools" }
            }),
        );
        let clear_request = WorkerRequest::new(
            "req-2",
            "trace-1",
            "session.clear_checkpoint",
            json!({ "session_id": "session-1" }),
        );

        let set_response = router.dispatch(&set_request);
        let clear_response = router.dispatch(&clear_request);

        assert_eq!(
            set_response.result.as_ref().unwrap()["extra"]["runtime_checkpoint"],
            json!({ "phase": "awaiting_tools" })
        );
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
        let mut session = session_fixture();
        session.extra = json!({
            "runtime_checkpoint": { "phase": "tools_completed" },
            "messages": [
                { "role": "user", "content": "existing" }
            ]
        });
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
                "messages_before": 1,
                "messages_after": 3,
                "saved_message_count": 2,
                "saved_messages": [
                    { "role": "user", "content": "hello" },
                    { "role": "assistant", "content": "done" }
                ],
                "checkpoint_cleared": true,
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
        let updated = router
            .session
            .get_metadata("session-1")
            .expect("session should exist");
        assert_eq!(
            updated.extra["last_context_metadata"],
            json!({
                "historyMessageCount": 1,
                "bridge": {
                    "missingSession": false
                }
            })
        );
        assert!(response.error.is_none());
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
            "docs/ts-agent-loop.md",
            "# TS Agent Loop Design\n\nTS worker should proxy product integrations through Rust.\n",
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
                "query": "TS worker Rust",
                "collection": "docs",
                "limit": 3
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "documents": [{
                    "id": "docs/ts-agent-loop.md",
                    "title": "TS Agent Loop Design",
                    "path": "docs/ts-agent-loop.md",
                    "score": 2,
                    "excerpt": "TS worker should proxy product integrations through Rust."
                }]
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn knowledge_query_requires_knowledge_read_capability() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "docs/ts-agent-loop.md",
            "# TS Agent Loop Design\n\nTS worker should proxy product integrations through Rust.\n",
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
                "query": "TS worker Rust",
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
                "timeout": 5,
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
