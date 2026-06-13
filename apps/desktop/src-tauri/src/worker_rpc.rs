use crate::config_store::{ConfigPatchBridgeResult, ConfigStore};
use crate::worker_background::{
    BackgroundRunCompleteParams, BackgroundRunUpsertParams, WorkerBackgroundRpc,
};
use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_config::WorkerConfigRpc;
use crate::worker_cron::{
    CronJobAddParams, CronJobDueParams, CronJobRecordRunsParams, CronJobRemoveParams, WorkerCronRpc,
};
use crate::worker_diagnostics::WorkerDiagnosticsRpc;
use crate::worker_knowledge::{
    KnowledgeAddDocumentParams, KnowledgeContextParams, KnowledgeDocumentIdParams,
    KnowledgeListDocumentsParams, KnowledgeQueryParams, WorkerKnowledgeRpc,
};
use crate::worker_protocol::{validate_protocol_version, WorkerRequest, WorkerResponse};
use crate::worker_secret::{ProviderResolveSecretParams, WorkerSecretRpc};
use crate::worker_session::{SessionMetadata, WorkerSessionRpc};
use crate::worker_shell::{ShellExecuteParams, WorkerShellRpc};
use crate::worker_task::{TaskPlanIdParams, TaskPlanListParams, TaskPlanSaveParams, WorkerTaskRpc};
use crate::worker_workspace::{WorkerWorkspaceRpc, WorkspaceReadFormat, WorkspaceReadOptions};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

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
            config_store: None,
        }
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

    pub fn dispatch(&mut self, request: &WorkerRequest) -> WorkerResponse {
        if let Err(error) = validate_protocol_version(&request.protocol_version) {
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
                serde_json::to_value(self.workspace.write_file_with_expected(
                    &params.path,
                    &params.contents,
                    params.expected_updated_at.as_deref(),
                )?)
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
            "channel.connector.start" => {
                let params: ChannelConnectorParams = parse_params(request)?;
                self.channel_connector.start(params)
            }
            "channel.connector.stop" => {
                let params: ChannelConnectorParams = parse_params(request)?;
                self.channel_connector.stop(params)
            }
            "channel.connector.send_text" => {
                let params: ChannelConnectorParams = parse_params(request)?;
                self.channel_connector.send_text(params)
            }
            "channel.connector.send_delta" => {
                let params: ChannelConnectorParams = parse_params(request)?;
                self.channel_connector.send_delta(params)
            }
            "channel.connector.send_usage" => {
                let params: ChannelConnectorParams = parse_params(request)?;
                self.channel_connector.send_usage(params)
            }
            "shell.execute" => {
                let params: ShellExecuteParams = parse_params(request)?;
                serde_json::to_value(self.shell.execute(params)?).map_err(serialization_error)
            }
            "approval.request" => {
                let params: ApprovalRequestParams = parse_params(request)?;
                self.approval.request(params)
            }
            "approval.resolve" => {
                let params: ApprovalResolveParams = parse_params(request)?;
                self.approval.resolve(params)
            }
            "approval.list_pending" => {
                let params: SessionIdParams = parse_params(request)?;
                self.approval.list_pending(&params.session_id)
            }
            "form.request" => {
                let params: FormRequestParams = parse_params(request)?;
                self.form.request(params)
            }
            "memory.search" => {
                let params: MemorySearchParams = parse_params(request)?;
                self.memory.search(params)
            }
            "memory.recall" => {
                let params: MemoryRecallParams = parse_params(request)?;
                self.memory.recall(params)
            }
            "memory.dream_run" => {
                let params: MemoryDreamParams = parse_params(request)?;
                self.memory.dream_run(params)
            }
            "memory.dream_pending" => {
                let params: MemoryDreamParams = parse_params(request)?;
                self.memory.dream_pending(params)
            }
            "memory.dream_apply" => {
                let params: MemoryDreamApplyParams = parse_params(request)?;
                self.memory.dream_apply(params)
            }
            "memory.dream_log" => {
                let params: MemoryDreamParams = parse_params(request)?;
                self.memory.dream_log(params)
            }
            "memory.dream_restore" => {
                let params: MemoryDreamParams = parse_params(request)?;
                self.memory.dream_restore(params)
            }
            "memory.capture_evidence" => {
                let params: MemoryCaptureEvidenceParams = parse_params(request)?;
                self.memory.capture_evidence(params)
            }
            "memory.list_evidence" => {
                let params: MemoryListEvidenceParams = parse_params(request)?;
                self.memory.list_evidence(params)
            }
            "memory.save" => {
                let params: MemorySaveParams = parse_params(request)?;
                self.memory.save(params)
            }
            "memory.trace" => {
                let params: MemoryNoteIdParams = parse_params(request)?;
                self.memory.trace(params)
            }
            "memory.reject" => {
                let params: MemoryRejectParams = parse_params(request)?;
                self.memory.reject(params)
            }
            "memory.supersede" => {
                let params: MemorySupersedeParams = parse_params(request)?;
                self.memory.supersede(params)
            }
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
            "knowledge.delete_document" => {
                let params: KnowledgeDocumentIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.delete_document(params)?)
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
            "mcp.call_tool" => {
                let params: McpCallToolParams = parse_params(request)?;
                self.mcp.call_tool(params)
            }
            "mcp.list_tools" => self.mcp.list_tools(),
            "runtime.now" => {
                let params: RuntimeNowParams = parse_params(request)?;
                Ok(runtime_now(params.timezone))
            }
            "runtime.restart" => {
                let params: RuntimeRestartParams = parse_params(request)?;
                Ok(serde_json::json!({
                    "restart_requested": true,
                    "run_id": params.run_id,
                    "session_id": params.session_id,
                }))
            }
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

#[derive(Clone, Debug)]
struct WorkerApprovalRpc {
    policy: CapabilityPolicy,
    pending: HashMap<String, ApprovalRecord>,
    approved_once: Vec<ApprovalGrant>,
    approved_session: Vec<ApprovalGrant>,
    denied: Vec<Value>,
}

impl WorkerApprovalRpc {
    fn new(policy: CapabilityPolicy) -> Self {
        Self {
            policy,
            pending: HashMap::new(),
            approved_once: Vec::new(),
            approved_session: Vec::new(),
            denied: Vec::new(),
        }
    }

    fn request(
        &mut self,
        params: ApprovalRequestParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalRequest)?;
        let record = ApprovalRecord::from_params(params);
        if self.consume_once_approval(&record) {
            return Ok(approval_allowed_result(&record, "once"));
        }
        if self.has_session_approval(&record) {
            return Ok(approval_allowed_result(&record, "session"));
        }
        let approval_id = record.id.clone();
        let mut result = serde_json::json!({
            "content": "Waiting for approval.",
            "awaitingUserInput": true,
            "stopReason": "awaiting_approval",
            "approvalId": record.id,
            "operation": record.operation,
            "runId": record.run_id,
            "category": record.category,
            "risk": record.risk,
            "reason": record.reason,
            "summary": record.summary,
            "fingerprint": record.fingerprint,
            "sessionFingerprint": record.session_fingerprint,
        });
        if let Some(session_id) = record.session_id.clone() {
            result["sessionId"] = Value::String(session_id);
        }
        self.pending.insert(approval_id, record);
        Ok(result)
    }

    fn resolve(
        &mut self,
        params: ApprovalResolveParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalResolve)?;
        let scope = params.scope.unwrap_or_else(|| "once".to_string());
        if scope != "once" && scope != "session" {
            return Err(invalid_approval_request("scope must be once or session"));
        }
        let Some(record) = self.pending.get(&params.approval_id).cloned() else {
            return Err(invalid_approval_request("pending approval not found"));
        };
        if record.session_id.as_deref() != Some(params.session_id.as_str()) {
            return Err(invalid_approval_request("pending approval not found"));
        }
        self.pending.remove(&params.approval_id);
        if params.approved {
            if scope == "once" {
                let grant = ApprovalGrant::once(&record);
                if !self.approved_once.contains(&grant) {
                    self.approved_once.push(grant);
                }
            } else {
                let grant = ApprovalGrant::session(&record);
                if !self.approved_session.contains(&grant) {
                    self.approved_session.push(grant);
                }
            }
        } else {
            self.denied.push(serde_json::json!({
                "id": record.id,
                "fingerprint": record.fingerprint,
                "deniedAt": runtime_now(None)["current_time"].clone(),
            }));
        }
        Ok(serde_json::json!({
            "approvalId": record.id,
            "approved": params.approved,
            "scope": scope,
            "status": if params.approved { "approved" } else { "denied" },
            "sessionId": params.session_id,
            "operation": record.operation,
            "category": record.category,
            "risk": record.risk,
            "reason": record.reason,
            "summary": record.summary,
            "fingerprint": record.fingerprint,
            "sessionFingerprint": record.session_fingerprint,
        }))
    }

    fn list_pending(
        &self,
        session_id: &str,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalResolve)?;
        let mut approvals: Vec<Value> = self
            .pending
            .values()
            .filter(|record| record.session_id.as_deref() == Some(session_id))
            .map(ApprovalRecord::to_pending_json)
            .collect();
        approvals.sort_by(|left, right| {
            left["id"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["id"].as_str().unwrap_or_default())
        });
        Ok(serde_json::json!({
            "sessionId": session_id,
            "approvals": approvals,
        }))
    }

    fn consume_once_approval(&mut self, record: &ApprovalRecord) -> bool {
        let grant = ApprovalGrant::once(record);
        let Some(index) = self.approved_once.iter().position(|item| item == &grant) else {
            return false;
        };
        self.approved_once.remove(index);
        true
    }

    fn has_session_approval(&self, record: &ApprovalRecord) -> bool {
        let grant = ApprovalGrant::session(record);
        self.approved_session.contains(&grant)
    }

    fn require(
        &self,
        capability: WorkerCapability,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ApprovalGrant {
    session_id: Option<String>,
    fingerprint: String,
}

impl ApprovalGrant {
    fn once(record: &ApprovalRecord) -> Self {
        Self {
            session_id: record.session_id.clone(),
            fingerprint: record.fingerprint.clone(),
        }
    }

    fn session(record: &ApprovalRecord) -> Self {
        Self {
            session_id: record.session_id.clone(),
            fingerprint: record.session_fingerprint.clone(),
        }
    }
}

#[derive(Clone, Debug)]
struct ApprovalRecord {
    id: String,
    run_id: String,
    session_id: Option<String>,
    operation: Value,
    category: String,
    risk: String,
    reason: String,
    summary: String,
    fingerprint: String,
    session_fingerprint: String,
}

impl ApprovalRecord {
    fn from_params(params: ApprovalRequestParams) -> Self {
        let has_explicit_fingerprint = params.fingerprint.is_some();
        let category = params
            .classification
            .as_ref()
            .map(|classification| classification.category.clone())
            .or_else(|| json_string_field(&params.operation, "category"))
            .unwrap_or_else(|| "tool".to_string());
        let risk = params
            .classification
            .as_ref()
            .map(|classification| classification.risk.clone())
            .or_else(|| json_string_field(&params.operation, "risk"))
            .unwrap_or_else(|| "medium".to_string());
        let reason = params
            .classification
            .as_ref()
            .map(|classification| classification.reason.clone())
            .or_else(|| json_string_field(&params.operation, "reason"))
            .unwrap_or_else(|| "This tool requires user approval before execution.".to_string());
        let summary = params
            .summary
            .unwrap_or_else(|| approval_operation_summary(&params.operation));
        let fingerprint = params.fingerprint.unwrap_or_else(|| {
            let fingerprint_input = serde_json::json!({
                "category": category,
                "operation": params.operation,
            });
            format!("{}:{}", category, short_value_hash(&fingerprint_input))
        });
        let session_fingerprint = params
            .session_fingerprint
            .or(params.session_fingerprint_camel)
            .unwrap_or_else(|| fingerprint.clone());
        let id = if has_explicit_fingerprint {
            approval_id_for(
                params.session_id.as_deref(),
                &params.run_id,
                &fingerprint,
                &params.operation,
            )
        } else {
            format!("approval-{}", params.run_id)
        };

        Self {
            id,
            run_id: params.run_id,
            session_id: params.session_id,
            operation: params.operation,
            category,
            risk,
            reason,
            summary,
            fingerprint,
            session_fingerprint,
        }
    }

    fn to_pending_json(&self) -> Value {
        let mut value = serde_json::json!({
            "id": self.id,
            "runId": self.run_id,
            "operation": self.operation,
            "category": self.category,
            "risk": self.risk,
            "reason": self.reason,
            "summary": self.summary,
            "fingerprint": self.fingerprint,
            "sessionFingerprint": self.session_fingerprint,
        });
        if let Some(session_id) = self.session_id.clone() {
            value["sessionId"] = Value::String(session_id);
        }
        value
    }
}

fn approval_allowed_result(record: &ApprovalRecord, scope: &str) -> Value {
    let mut result = serde_json::json!({
        "decision": "allow",
        "status": "approved",
        "scope": scope,
        "operation": record.operation,
        "runId": record.run_id,
        "category": record.category,
        "risk": record.risk,
        "reason": record.reason,
        "summary": record.summary,
        "fingerprint": record.fingerprint,
        "sessionFingerprint": record.session_fingerprint,
    });
    if let Some(session_id) = record.session_id.clone() {
        result["sessionId"] = Value::String(session_id);
    }
    result
}

fn approval_id_for(
    session_id: Option<&str>,
    run_id: &str,
    fingerprint: &str,
    operation: &Value,
) -> String {
    let mut hasher = DefaultHasher::new();
    session_id.unwrap_or("").hash(&mut hasher);
    run_id.hash(&mut hasher);
    fingerprint.hash(&mut hasher);
    operation.to_string().hash(&mut hasher);
    format!("approval-{:016x}", hasher.finish())
}

fn short_value_hash(value: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    value.to_string().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn approval_operation_summary(operation: &Value) -> String {
    let tool_name = json_string_field(operation, "toolName")
        .or_else(|| json_string_field(operation, "tool_name"))
        .unwrap_or_else(|| "tool".to_string());
    if let Some(path) = operation
        .get("arguments")
        .and_then(|arguments| json_string_field(arguments, "path"))
    {
        return format!("{tool_name} path=\"{path}\"");
    }
    format!("{tool_name}({})", operation.to_string())
}

fn json_string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[derive(Clone, Debug)]
struct WorkerFormRpc {
    policy: CapabilityPolicy,
}

impl WorkerFormRpc {
    fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    fn request(
        &self,
        params: FormRequestParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::FormRequest)?;
        let form = params.form;
        let form_id = form
            .get("form_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid_form_request("form.form_id must be a non-empty string"))?;
        let continuation_mode = params
            .continuation_mode
            .unwrap_or_else(|| "structured_message".to_string());
        if continuation_mode != "structured_message" && continuation_mode != "resume" {
            return Err(invalid_form_request(
                "continuation_mode must be structured_message or resume",
            ));
        }

        let mut result = serde_json::json!({
            "content": "Waiting for form submission.",
            "awaitingUserInput": true,
            "stopReason": "awaiting_form",
            "formId": form_id,
            "form": form,
            "continuationMode": continuation_mode,
            "runId": params.run_id,
        });
        if let Some(session_id) = params.session_id {
            result["sessionId"] = Value::String(session_id);
        }
        Ok(result)
    }

    fn require(
        &self,
        capability: WorkerCapability,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Clone, Debug)]
struct WorkerMcpRpc {
    config_snapshot: Value,
    policy: CapabilityPolicy,
}

impl WorkerMcpRpc {
    fn new(config_snapshot: Value, policy: CapabilityPolicy) -> Self {
        Self {
            config_snapshot,
            policy,
        }
    }

    fn call_tool(
        &self,
        params: McpCallToolParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::McpCall)?;
        let server_name = validate_mcp_name("server", &params.server)?;
        let tool_name = validate_mcp_name("tool", &params.tool)?;
        if let Some(arguments) = &params.arguments {
            if !arguments.is_object() {
                return Err(invalid_mcp_request("arguments must be a JSON object"));
            }
        }
        let server = self.server_config(server_name).ok_or_else(|| {
            invalid_mcp_request(format!("MCP server is not configured: {server_name}"))
        })?;
        if !mcp_tool_is_enabled(server_name, tool_name, server) {
            return Err(mcp_tool_denied(server_name, tool_name));
        }
        let content = mcp_fixture_tool_content(server, tool_name).unwrap_or_else(|| {
            format!("MCP tool {server_name}.{tool_name} is configured but native MCP execution is not connected.")
        });
        let _session_id = params.session_id.as_deref();
        Ok(serde_json::json!({
            "content": content,
            "server": server_name,
            "tool": tool_name,
        }))
    }

    fn list_tools(&self) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::McpCall)?;
        let servers = self
            .config_snapshot
            .get("tools")
            .and_then(|tools| tools.get("mcp_servers").or_else(|| tools.get("mcpServers")))
            .and_then(Value::as_object)
            .map(|servers| {
                servers
                    .iter()
                    .filter_map(|(server_name, server)| {
                        validate_mcp_name("server", server_name).ok()?;
                        let tools = mcp_fixture_tool_definitions(server_name, server);
                        if tools.is_empty() {
                            return None;
                        }
                        Some(serde_json::json!({
                            "name": server_name,
                            "tools": tools,
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(serde_json::json!({ "servers": servers }))
    }

    fn server_config(&self, server_name: &str) -> Option<&Value> {
        self.config_snapshot
            .get("tools")
            .and_then(|tools| tools.get("mcp_servers").or_else(|| tools.get("mcpServers")))
            .and_then(|servers| servers.get(server_name))
    }

    fn require(
        &self,
        capability: WorkerCapability,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Clone, Debug)]
struct WorkerMemoryRpc {
    workspace_root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerMemoryRpc {
    fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self {
            workspace_root,
            policy,
        }
    }

    fn search(
        &self,
        params: MemorySearchParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let limit = params.limit.unwrap_or(10).min(50);
        if limit == 0 {
            return Ok(serde_json::json!({ "notes": [] }));
        }
        let note_type =
            validate_optional_memory_value("note_type", params.note_type, MEMORY_NOTE_TYPES)?;
        let scope = validate_optional_memory_value("scope", params.scope, MEMORY_NOTE_SCOPES)?;
        let status = validate_optional_memory_value("status", params.status, MEMORY_NOTE_STATUSES)?;
        let query = params.query.unwrap_or_default();
        let query_terms = memory_query_terms(&query);

        let mut notes: Vec<Value> = self
            .read_notes_with_lines()?
            .into_iter()
            .map(|(note, line)| annotate_memory_note_location(note, line))
            .filter(|note| memory_note_matches(note, "type", note_type.as_deref()))
            .filter(|note| memory_note_matches(note, "scope", scope.as_deref()))
            .filter(|note| memory_note_matches(note, "status", status.as_deref()))
            .filter(|note| query_terms.is_empty() || memory_note_matches_query(note, &query_terms))
            .collect();
        notes.sort_by(|left, right| {
            memory_note_score(right, &query_terms)
                .partial_cmp(&memory_note_score(left, &query_terms))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        notes.truncate(limit);
        Ok(serde_json::json!({ "notes": notes }))
    }

    fn recall(
        &self,
        params: MemoryRecallParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let search_result = self.search(MemorySearchParams {
            query: Some(params.query),
            note_type: None,
            scope: None,
            status: Some("active".to_string()),
            limit: Some(params.max_notes.unwrap_or(6).min(20)),
        })?;
        let notes = search_result
            .get("notes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let context = render_memory_recall_context(&notes, params.max_chars.unwrap_or(1600));
        let references: Vec<Value> = notes.iter().map(memory_recall_reference).collect();
        Ok(serde_json::json!({
            "context": context,
            "notes": notes,
            "references": references
        }))
    }

    fn dream_run(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let _session_id = params.session_id.as_deref();
        let _sha = params.sha.as_deref();
        let evidence_cursor = self.last_evidence_cursor();
        let pending_evidence = self.pending_conversation_evidence(evidence_cursor, 50)?;
        if !pending_evidence.is_empty() {
            let pending_count = pending_evidence.len();
            let extraction = self.extract_dream_notes_from_evidence(&pending_evidence)?;
            let content = if extraction.captured_notes > 0 {
                format!(
                    "Dream captured {} memory note(s) from {pending_count} conversation evidence record(s).",
                    extraction.captured_notes
                )
            } else {
                format!(
                    "Dream deferred {pending_count} conversation evidence record(s) for provider-backed memory extraction."
                )
            };
            return Ok(memory_dream_result_with_metadata(
                &content,
                true,
                serde_json::json!({
                    "changed": extraction.captured_notes > 0,
                    "deferred": extraction.captured_notes == 0,
                    "pending_evidence": pending_count,
                    "captured_notes": extraction.captured_notes,
                    "skipped_evidence": extraction.skipped_evidence,
                    "last_evidence_cursor": extraction.last_evidence_cursor
                }),
            ));
        }

        let pending_legacy_history = self.pending_legacy_history(50)?;
        if !pending_legacy_history.is_empty() {
            let pending_count = pending_legacy_history.len();
            let extraction =
                self.extract_dream_notes_from_legacy_history(&pending_legacy_history)?;
            let content = if extraction.captured_notes > 0 {
                format!(
                    "Dream captured {} memory note(s) from {pending_count} legacy history record(s).",
                    extraction.captured_notes
                )
            } else {
                format!(
                    "Dream deferred {pending_count} legacy history record(s) for provider-backed memory extraction."
                )
            };
            return Ok(memory_dream_result_with_metadata(
                &content,
                true,
                serde_json::json!({
                    "changed": extraction.captured_notes > 0,
                    "deferred": extraction.captured_notes == 0,
                    "pending_evidence": 0,
                    "pending_legacy_history": pending_count,
                    "captured_notes": extraction.captured_notes,
                    "skipped_history": extraction.skipped_history,
                    "last_dream_cursor": extraction.last_dream_cursor
                }),
            ));
        }

        Ok(memory_dream_result_with_metadata(
            "Dream: nothing to process.",
            true,
            serde_json::json!({
                "changed": false,
                "pending_evidence": 0
            }),
        ))
    }

    fn dream_pending(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let _session_id = params.session_id.as_deref();
        let evidence_cursor = self.last_evidence_cursor();
        let pending_evidence = self.pending_conversation_evidence(evidence_cursor, 50)?;
        if !pending_evidence.is_empty() {
            return Ok(memory_dream_pending_batch(
                "conversation_evidence",
                pending_evidence,
                Some(evidence_cursor),
                self.dream_memory_context()?,
            ));
        }

        let pending_legacy_history = self.pending_legacy_history(50)?;
        if !pending_legacy_history.is_empty() {
            return Ok(memory_dream_pending_batch(
                "legacy_history",
                pending_legacy_history,
                Some(self.last_dream_cursor()),
                self.dream_memory_context()?,
            ));
        }

        Ok(serde_json::json!({
            "kind": "none",
            "records": [],
            "pending_evidence": 0,
            "pending_legacy_history": 0,
            "last_evidence_cursor": evidence_cursor,
            "last_dream_cursor": self.last_dream_cursor(),
            "memory_context": self.dream_memory_context()?
        }))
    }

    fn dream_apply(
        &self,
        params: MemoryDreamApplyParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let kind = validate_memory_value(
            "dream_apply kind",
            &params.kind,
            &["conversation_evidence", "legacy_history"],
        )?;
        let cursor_start = params
            .cursor_start
            .ok_or_else(|| invalid_memory_request("Dream apply cursor_start is required"))?;
        let cursor_end = params
            .cursor_end
            .ok_or_else(|| invalid_memory_request("Dream apply cursor_end is required"))?;
        if cursor_end < cursor_start {
            return Err(invalid_memory_request(
                "Dream apply cursor_end must be greater than or equal to cursor_start",
            ));
        }

        let mut notes = self.read_notes()?;
        let timestamp = memory_timestamp();
        let mut applied_notes = 0usize;
        for note_params in params.notes {
            let action = note_params
                .action
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .unwrap_or_else(|| "save".to_string());
            if action == "skip" {
                continue;
            }
            let mut source = serde_json::json!({
                "capture_origin": "dream",
                "history_start_cursor": cursor_start,
                "history_end_cursor": cursor_end
            });
            if kind == "conversation_evidence" {
                let evidence_ids: Vec<String> = note_params
                    .evidence_ids
                    .as_deref()
                    .or(params.evidence_ids.as_deref())
                    .unwrap_or(&[])
                    .iter()
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty())
                    .collect();
                if !evidence_ids.is_empty() {
                    source["evidence_ids"] = serde_json::json!(evidence_ids);
                }
            }
            if let Some(session_id) = params
                .session_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                source["session_key"] = Value::String(session_id.to_string());
            }

            if action == "reject" {
                let note_id =
                    required_memory_note_id(note_params.target_note_id.as_deref().unwrap_or(""))?;
                let note = find_note_mut(&mut notes, note_id)?;
                note["status"] = Value::String("rejected".to_string());
                note["updated_at"] = Value::String(timestamp.clone());
                ensure_json_object_field(note, "metadata");
                note["metadata"]["extractor"] = Value::String("ts_provider_dream".to_string());
                if let Some(reason) = note_params
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("reason"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                {
                    note["metadata"]["rejected_reason"] = Value::String(reason.to_string());
                }
                applied_notes += 1;
                continue;
            }

            let content = note_params.content.trim();
            if content.is_empty() {
                continue;
            }
            let note_type = validate_memory_value(
                "note_type",
                note_params.note_type.as_deref().unwrap_or("project"),
                MEMORY_NOTE_TYPES,
            )?;
            let scope = note_params
                .scope
                .as_deref()
                .map(|value| validate_memory_value("scope", value, MEMORY_NOTE_SCOPES))
                .transpose()?
                .unwrap_or_else(|| default_memory_scope(note_type));
            let priority = validate_memory_score("priority", note_params.priority.unwrap_or(0.6))?;
            let confidence =
                validate_memory_score("confidence", note_params.confidence.unwrap_or(0.6))?;
            let mut metadata = match note_params.metadata {
                Some(value) if value.is_object() => value,
                Some(_) => return Err(invalid_memory_request("metadata must be a JSON object")),
                None => serde_json::json!({}),
            };
            if let Some(object) = metadata.as_object_mut() {
                object.insert(
                    "extractor".to_string(),
                    Value::String("ts_provider_dream".to_string()),
                );
                if kind == "legacy_history" {
                    object.insert("legacy_history".to_string(), Value::Bool(true));
                }
            }
            let tags: Vec<String> = note_params
                .tags
                .unwrap_or_default()
                .into_iter()
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty())
                .collect();
            let note_id = generate_memory_note_id(note_type, scope, content, &source);
            let mut note = serde_json::json!({
                "id": note_id,
                "scope": scope,
                "type": note_type,
                "status": "active",
                "content": content,
                "priority": priority,
                "confidence": confidence,
                "sources": [source],
                "created_at": timestamp,
                "updated_at": timestamp,
                "metadata": metadata
            });
            if !tags.is_empty() {
                note["tags"] = serde_json::json!(tags);
            }
            if action == "supersede" {
                let target_note_id =
                    required_memory_note_id(note_params.target_note_id.as_deref().unwrap_or(""))?;
                let replacement_id = note_id.clone();
                let old_note_exists = notes.iter().any(|existing| {
                    existing.get("id").and_then(Value::as_str) == Some(target_note_id)
                });
                if !old_note_exists {
                    return Err(invalid_memory_request(format!(
                        "Memory Note not found: {target_note_id}"
                    )));
                }
                note["supersedes"] = serde_json::json!([target_note_id]);
                notes.retain(|existing| existing.get("id") != note.get("id"));
                notes.push(note);
                let old_note = find_note_mut(&mut notes, target_note_id)?;
                old_note["status"] = Value::String("superseded".to_string());
                old_note["superseded_by"] = Value::String(replacement_id);
                old_note["updated_at"] = Value::String(memory_timestamp());
                applied_notes += 1;
                continue;
            }
            notes.retain(|existing| existing.get("id") != note.get("id"));
            notes.push(note);
            applied_notes += 1;
        }

        if applied_notes > 0 {
            self.write_notes(&notes)?;
            self.refresh_memory_views(&notes)?;
        }
        if kind == "conversation_evidence" {
            self.write_evidence_cursor(cursor_end)?;
            Ok(serde_json::json!({
                "changed": applied_notes > 0,
                "applied_notes": applied_notes,
                "last_evidence_cursor": self.last_evidence_cursor()
            }))
        } else {
            self.write_dream_cursor(cursor_end)?;
            Ok(serde_json::json!({
                "changed": applied_notes > 0,
                "applied_notes": applied_notes,
                "last_dream_cursor": self.last_dream_cursor()
            }))
        }
    }

    fn extract_dream_notes_from_evidence(
        &self,
        evidence: &[Value],
    ) -> Result<DreamExtractionResult, crate::worker_protocol::WorkerProtocolError> {
        let mut notes = self.read_notes()?;
        let mut captured_notes = 0usize;
        let mut skipped_evidence = 0usize;
        let mut last_evidence_cursor = self.last_evidence_cursor();
        let timestamp = memory_timestamp();

        for record in evidence {
            let cursor = record
                .get("cursor")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(last_evidence_cursor);
            last_evidence_cursor = last_evidence_cursor.max(cursor);

            let Some(content) = dream_note_content(record) else {
                skipped_evidence += 1;
                continue;
            };
            let note_type = dream_note_type(&content);
            let scope = default_memory_scope(note_type);
            let evidence_id = record
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("unknown");
            let mut source = serde_json::json!({
                "capture_origin": "dream",
                "evidence_ids": [evidence_id],
                "history_start_cursor": cursor,
                "history_end_cursor": cursor
            });
            if let Some(session_key) = record
                .get("session_key")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                source["session_key"] = Value::String(session_key.to_string());
            }
            if let Some(turn_id) = record
                .get("turn_id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                source["turn_id"] = Value::String(turn_id.to_string());
            }

            let note_id = generate_memory_note_id(note_type, scope, &content, &source);
            let note = serde_json::json!({
                "id": note_id,
                "scope": scope,
                "type": note_type,
                "status": "active",
                "content": content,
                "priority": 0.6,
                "confidence": 0.6,
                "sources": [source],
                "created_at": timestamp,
                "updated_at": timestamp,
                "metadata": {
                    "extractor": "native_dream_heuristic"
                }
            });
            notes.retain(|existing| existing.get("id") != note.get("id"));
            notes.push(note);
            captured_notes += 1;
        }

        if captured_notes > 0 {
            self.write_notes(&notes)?;
            self.refresh_memory_views(&notes)?;
            self.write_evidence_cursor(last_evidence_cursor)?;
        } else {
            last_evidence_cursor = self.last_evidence_cursor();
        }
        Ok(DreamExtractionResult {
            captured_notes,
            skipped_evidence,
            last_evidence_cursor,
        })
    }

    fn extract_dream_notes_from_legacy_history(
        &self,
        history: &[Value],
    ) -> Result<DreamLegacyExtractionResult, crate::worker_protocol::WorkerProtocolError> {
        let mut notes = self.read_notes()?;
        let mut captured_notes = 0usize;
        let mut skipped_history = 0usize;
        let mut last_dream_cursor = self.last_dream_cursor();
        let timestamp = memory_timestamp();

        for record in history {
            let cursor = record
                .get("cursor")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(last_dream_cursor);
            last_dream_cursor = last_dream_cursor.max(cursor);

            let content = record
                .get("content")
                .and_then(Value::as_str)
                .and_then(dream_memory_text);
            let Some(content) = content else {
                skipped_history += 1;
                continue;
            };
            let note_type = dream_note_type(&content);
            let scope = default_memory_scope(note_type);
            let source = serde_json::json!({
                "capture_origin": "dream",
                "history_start_cursor": cursor,
                "history_end_cursor": cursor
            });
            let note_id = generate_memory_note_id(note_type, scope, &content, &source);
            let note = serde_json::json!({
                "id": note_id,
                "scope": scope,
                "type": note_type,
                "status": "active",
                "content": content,
                "priority": 0.6,
                "confidence": 0.6,
                "sources": [source],
                "created_at": timestamp,
                "updated_at": timestamp,
                "metadata": {
                    "extractor": "native_dream_heuristic",
                    "legacy_history": true
                }
            });
            notes.retain(|existing| existing.get("id") != note.get("id"));
            notes.push(note);
            captured_notes += 1;
        }

        if captured_notes > 0 {
            self.write_notes(&notes)?;
            self.refresh_memory_views(&notes)?;
            self.write_dream_cursor(last_dream_cursor)?;
        } else {
            last_dream_cursor = self.last_dream_cursor();
        }
        Ok(DreamLegacyExtractionResult {
            captured_notes,
            skipped_history,
            last_dream_cursor,
        })
    }

    fn dream_log(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let _session_id = params.session_id.as_deref();
        if !self.dream_git_initialized() {
            if self.last_dream_cursor() == 0 {
                return Ok(memory_dream_unavailable(
                    "Dream has not run yet. Run `/dream`, or wait for the next scheduled Dream cycle.",
                ));
            }
            return Ok(memory_dream_unavailable(
                "Dream history is not available because memory versioning is not initialized.",
            ));
        }

        let content = match params.sha.as_deref().map(str::trim).filter(|sha| !sha.is_empty()) {
            Some(sha) => match self.dream_show_commit_diff(sha, 20) {
                Some((commit, diff)) => dream_log_content(&commit, &diff, Some(sha)),
                None => format!(
                    "Couldn't find Dream change `{sha}`.\n\nUse `/dream-restore` to list recent versions, or `/dream-log` to inspect the latest one."
                ),
            },
            None => {
                let commits = self.dream_log_commits(1);
                match commits.first() {
                    Some(commit) => {
                        let diff = self.dream_commit_diff(commit);
                        dream_log_content(commit, &diff, None)
                    }
                    None => "Dream memory has no saved versions yet.".to_string(),
                }
            }
        };
        Ok(memory_dream_result(&content, true))
    }

    fn dream_restore(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let _session_id = params.session_id.as_deref();
        if !self.dream_git_initialized() {
            return Ok(memory_dream_unavailable(
                "Dream history is not available because memory versioning is not initialized.",
            ));
        }

        let content = match params
            .sha
            .as_deref()
            .map(str::trim)
            .filter(|sha| !sha.is_empty())
        {
            Some(sha) => {
                let changed_files = self
                    .dream_show_commit_diff(sha, 20)
                    .map(|(_, diff)| format_dream_changed_files(&diff))
                    .unwrap_or_else(|| "the tracked memory files".to_string());
                match self.dream_revert_commit(sha) {
                    Some(new_sha) => format!(
                        "Restored Dream memory to the state before `{sha}`.\n\n- New safety commit: `{new_sha}`\n- Restored files: {changed_files}\n\nUse `/dream-log {new_sha}` to inspect the restore diff."
                    ),
                    None => format!(
                        "Couldn't restore Dream change `{sha}`.\n\nIt may not exist, or it may be the first saved version with no earlier state to restore."
                    ),
                }
            }
            None => {
                let commits = self.dream_log_commits(10);
                if commits.is_empty() {
                    "Dream memory has no saved versions to restore yet.".to_string()
                } else {
                    dream_restore_list_content(&commits)
                }
            }
        };
        Ok(memory_dream_result(&content, true))
    }

    fn capture_evidence(
        &self,
        params: MemoryCaptureEvidenceParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let session_key = params.session_key.trim();
        if session_key.is_empty() {
            return Err(invalid_memory_request("session_key is required"));
        }
        let mut evidence_messages = Vec::new();
        for (offset, message) in params.messages.iter().enumerate() {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let content = conversation_evidence_text(message);
            if content.trim().is_empty() {
                continue;
            }
            evidence_messages.push((
                params.start_index.unwrap_or(0) + offset,
                role.to_string(),
                content,
                message
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(memory_timestamp),
            ));
        }
        if evidence_messages.is_empty() {
            return Ok(serde_json::json!({ "evidence": [] }));
        }
        let turn_id = generate_conversation_turn_id(session_key, &evidence_messages);
        let existing_ids = self.read_conversation_evidence_ids()?;
        let mut known_ids = existing_ids;
        let mut written = Vec::new();
        for (message_index, role, content, timestamp) in evidence_messages {
            let evidence_id = generate_conversation_evidence_id(
                session_key,
                &turn_id,
                &role,
                &content,
                message_index,
            );
            if known_ids.contains(&evidence_id) {
                continue;
            }
            let cursor = self.next_evidence_cursor()?;
            let record = serde_json::json!({
                "id": evidence_id,
                "turn_id": turn_id,
                "session_key": session_key,
                "role": role,
                "content": content,
                "timestamp": timestamp,
                "message_index": message_index,
                "cursor": cursor
            });
            self.append_conversation_evidence_record(&record)?;
            self.write_evidence_sequence(cursor)?;
            known_ids.insert(record["id"].as_str().unwrap_or_default().to_string());
            written.push(record);
        }
        Ok(serde_json::json!({ "evidence": written }))
    }

    fn list_evidence(
        &self,
        params: MemoryListEvidenceParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let mut evidence = self.read_conversation_evidence_records()?;
        if let Some(session_key) = params.session_key {
            evidence.retain(|record| {
                record.get("session_key").and_then(Value::as_str) == Some(session_key.as_str())
            });
        }
        if let Some(since_cursor) = params.since_cursor {
            evidence.retain(|record| {
                record
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .is_some_and(|cursor| cursor > since_cursor as u64)
            });
        }
        evidence.sort_by(|left, right| {
            let left_cursor = left.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let right_cursor = right.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            left_cursor
                .cmp(&right_cursor)
                .then_with(|| {
                    left.get("timestamp")
                        .and_then(Value::as_str)
                        .cmp(&right.get("timestamp").and_then(Value::as_str))
                })
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .cmp(&right.get("id").and_then(Value::as_str))
                })
        });
        if let Some(limit) = params.limit {
            evidence.truncate(limit);
        }
        Ok(serde_json::json!({ "evidence": evidence }))
    }

    fn save(
        &self,
        params: MemorySaveParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let content = params.content.trim();
        if content.is_empty() {
            return Err(invalid_memory_request("Memory Note content is required"));
        }
        let note_type = validate_memory_value("note_type", &params.note_type, MEMORY_NOTE_TYPES)?;
        let scope = params
            .scope
            .as_deref()
            .map(|value| validate_memory_value("scope", value, MEMORY_NOTE_SCOPES))
            .transpose()?
            .map(str::to_string)
            .unwrap_or_else(|| default_memory_scope(note_type).to_string());
        let priority = validate_memory_score("priority", params.priority.unwrap_or(0.5))?;
        let confidence = validate_memory_score("confidence", params.confidence.unwrap_or(0.5))?;
        let metadata = match params.metadata {
            Some(value) if value.is_object() => value,
            Some(_) => return Err(invalid_memory_request("metadata must be a JSON object")),
            None => serde_json::json!({}),
        };
        let tags: Vec<String> = params
            .tags
            .unwrap_or_default()
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect();
        let mut source = serde_json::json!({ "capture_origin": "explicit" });
        if let Some(session_id) = params.session_id.filter(|value| !value.trim().is_empty()) {
            source["session_key"] = Value::String(session_id);
        }
        if let Some(message_start) = params.message_start {
            source["message_start"] = serde_json::json!(message_start);
        }
        if let Some(message_end) = params.message_end {
            source["message_end"] = serde_json::json!(message_end);
        }
        let timestamp = memory_timestamp();
        let note_id = generate_memory_note_id(note_type, &scope, content, &source);
        let mut note = serde_json::json!({
            "id": note_id,
            "scope": scope,
            "type": note_type,
            "status": "active",
            "content": content,
            "priority": priority,
            "confidence": confidence,
            "sources": [source],
            "created_at": timestamp,
            "updated_at": timestamp
        });
        if !tags.is_empty() {
            note["tags"] = serde_json::json!(tags);
        }
        if metadata
            .as_object()
            .is_some_and(|object| !object.is_empty())
        {
            note["metadata"] = metadata;
        }

        let mut notes = self.read_notes()?;
        notes.retain(|existing| existing.get("id") != note.get("id"));
        notes.push(note.clone());
        self.write_notes(&notes)?;
        self.refresh_memory_views(&notes)?;
        Ok(serde_json::json!({ "note": note }))
    }

    fn trace(
        &self,
        params: MemoryNoteIdParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let note_id = required_memory_note_id(&params.note_id)?;
        let (note, line) = self.find_note_with_line(note_id)?;
        Ok(serde_json::json!({
            "note": note,
            "locations": memory_note_locations(&note, line)
        }))
    }

    fn reject(
        &self,
        params: MemoryRejectParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let note_id = required_memory_note_id(&params.note_id)?;
        let mut notes = self.read_notes()?;
        let timestamp = memory_timestamp();
        let note = find_note_mut(&mut notes, note_id)?;
        note["status"] = Value::String("rejected".to_string());
        note["updated_at"] = Value::String(timestamp);
        if let Some(reason) = params.reason.filter(|reason| !reason.trim().is_empty()) {
            ensure_json_object_field(note, "metadata");
            note["metadata"]["rejected_reason"] = Value::String(reason);
        }
        let rejected = note.clone();
        self.write_notes(&notes)?;
        self.refresh_memory_views(&notes)?;
        Ok(serde_json::json!({
            "note": rejected,
            "views_refreshed": true
        }))
    }

    fn supersede(
        &self,
        params: MemorySupersedeParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let note_id = required_memory_note_id(&params.note_id)?;
        let replacement_content = params.replacement_content.trim();
        if replacement_content.is_empty() {
            return Err(invalid_memory_request(
                "Replacement Memory Note content is required",
            ));
        }
        let mut notes = self.read_notes()?;
        let old_note = notes
            .iter()
            .find(|note| note.get("id").and_then(Value::as_str) == Some(note_id))
            .cloned()
            .ok_or_else(|| invalid_memory_request(format!("Memory Note not found: {note_id}")))?;
        let note_type = match params.note_type {
            Some(note_type) => {
                validate_memory_value("note_type", &note_type, MEMORY_NOTE_TYPES)?.to_string()
            }
            None => old_note
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("project")
                .to_string(),
        };
        let scope = match params.scope {
            Some(scope) => validate_memory_value("scope", &scope, MEMORY_NOTE_SCOPES)?.to_string(),
            None => old_note
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or_else(|| default_memory_scope(&note_type))
                .to_string(),
        };
        let priority = validate_memory_score(
            "priority",
            params
                .priority
                .or_else(|| old_note.get("priority").and_then(Value::as_f64))
                .unwrap_or(0.5),
        )?;
        let confidence = validate_memory_score(
            "confidence",
            params
                .confidence
                .or_else(|| old_note.get("confidence").and_then(Value::as_f64))
                .unwrap_or(0.5),
        )?;
        let metadata = match params.metadata {
            Some(value) if value.is_object() => value,
            Some(_) => return Err(invalid_memory_request("metadata must be a JSON object")),
            None => old_note
                .get("metadata")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        };
        let tags = params.tags.unwrap_or_else(|| {
            old_note
                .get("tags")
                .and_then(Value::as_array)
                .map(|tags| {
                    tags.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        });
        let tags: Vec<String> = tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect();
        let mut source = serde_json::json!({ "capture_origin": "explicit" });
        if let Some(session_id) = params.session_id.filter(|value| !value.trim().is_empty()) {
            source["session_key"] = Value::String(session_id);
        }
        if let Some(message_start) = params.message_start {
            source["message_start"] = serde_json::json!(message_start);
        }
        if let Some(message_end) = params.message_end {
            source["message_end"] = serde_json::json!(message_end);
        }
        let timestamp = memory_timestamp();
        let replacement_id =
            generate_memory_note_id(&note_type, &scope, replacement_content, &source);
        let mut replacement = serde_json::json!({
            "id": replacement_id,
            "scope": scope,
            "type": note_type,
            "status": "active",
            "content": replacement_content,
            "priority": priority,
            "confidence": confidence,
            "sources": [source],
            "created_at": timestamp,
            "updated_at": timestamp,
            "supersedes": [note_id]
        });
        if !tags.is_empty() {
            replacement["tags"] = serde_json::json!(tags);
        }
        if metadata
            .as_object()
            .is_some_and(|object| !object.is_empty())
        {
            replacement["metadata"] = metadata;
        }
        notes.retain(|existing| existing.get("id") != replacement.get("id"));
        notes.push(replacement.clone());
        let old_note = find_note_mut(&mut notes, note_id)?;
        old_note["status"] = Value::String("superseded".to_string());
        old_note["superseded_by"] = replacement["id"].clone();
        old_note["updated_at"] = Value::String(memory_timestamp());
        let old_note = old_note.clone();
        self.write_notes(&notes)?;
        self.refresh_memory_views(&notes)?;
        Ok(serde_json::json!({
            "old_note": old_note,
            "note": replacement,
            "views_refreshed": true
        }))
    }

    fn require(
        &self,
        capability: WorkerCapability,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        ))
    }

    fn notes_path(&self) -> PathBuf {
        self.workspace_root.join("memory").join("notes.jsonl")
    }

    fn dream_memory_context(&self) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let notes = self.read_notes()?;
        Ok(serde_json::json!({
            "current_notes": format_dream_current_notes(&notes),
            "current_memory": self.read_memory_text("memory/MEMORY.md", "(empty)")?,
            "current_soul": self.read_memory_text("SOUL.md", "(empty)")?,
            "current_user": self.read_memory_text("USER.md", "(empty)")?,
        }))
    }

    fn read_memory_text(
        &self,
        relative_path: &str,
        default_value: &str,
    ) -> Result<String, crate::worker_protocol::WorkerProtocolError> {
        match fs::read_to_string(self.workspace_root.join(relative_path)) {
            Ok(contents) => Ok(contents),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(default_value.to_string())
            }
            Err(error) => Err(memory_io_error(error)),
        }
    }

    fn dream_git_initialized(&self) -> bool {
        self.workspace_root.join(".git").is_dir()
    }

    fn last_dream_cursor(&self) -> usize {
        let path = self.workspace_root.join("memory").join(".dream_cursor");
        fs::read_to_string(path)
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0)
    }

    fn write_dream_cursor(
        &self,
        cursor: usize,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let path = self.workspace_root.join("memory").join(".dream_cursor");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        fs::write(path, cursor.to_string()).map_err(memory_io_error)
    }

    fn dream_log_commits(&self, max_entries: usize) -> Vec<DreamCommitInfo> {
        if max_entries == 0 {
            return vec![];
        }
        let max_entries = max_entries.to_string();
        let output = self.git_output(&[
            "log",
            "-n",
            &max_entries,
            "--date=format:%Y-%m-%d %H:%M",
            "--format=%H%x1f%cd%x1f%s%x1e",
        ]);
        output
            .unwrap_or_default()
            .split('\x1e')
            .filter_map(|record| {
                let record = record.trim();
                if record.is_empty() {
                    return None;
                }
                let mut parts = record.splitn(3, '\x1f');
                let sha = parts.next()?.trim();
                let timestamp = parts.next()?.trim();
                let message = parts.next().unwrap_or_default().trim();
                Some(DreamCommitInfo {
                    sha: sha.chars().take(8).collect(),
                    full_sha: sha.to_string(),
                    message: message.to_string(),
                    timestamp: timestamp.to_string(),
                })
            })
            .collect()
    }

    fn dream_show_commit_diff(
        &self,
        short_sha: &str,
        max_entries: usize,
    ) -> Option<(DreamCommitInfo, String)> {
        self.dream_log_commits(max_entries)
            .into_iter()
            .find(|commit| commit.sha.starts_with(short_sha))
            .map(|commit| {
                let diff = self.dream_commit_diff(&commit);
                (commit, diff)
            })
    }

    fn dream_commit_diff(&self, commit: &DreamCommitInfo) -> String {
        let parents = self
            .git_output(&["rev-list", "--parents", "-n", "1", &commit.full_sha])
            .unwrap_or_default();
        let mut parts = parents.split_whitespace();
        let Some(_commit_sha) = parts.next() else {
            return String::new();
        };
        let Some(parent_sha) = parts.next() else {
            return String::new();
        };
        self.git_output(&[
            "diff",
            "--no-color",
            parent_sha,
            &commit.full_sha,
            "--",
            "SOUL.md",
            "USER.md",
            "memory/MEMORY.md",
            "memory/notes.jsonl",
        ])
        .unwrap_or_default()
    }

    fn dream_revert_commit(&self, short_sha: &str) -> Option<String> {
        let commit = self
            .dream_log_commits(20)
            .into_iter()
            .find(|commit| commit.sha.starts_with(short_sha))?;
        let parents = self
            .git_output(&["rev-list", "--parents", "-n", "1", &commit.full_sha])
            .unwrap_or_default();
        let mut parts = parents.split_whitespace();
        let _commit_sha = parts.next()?;
        let parent_sha = parts.next()?;
        let parent_sha = parent_sha.to_string();

        let mut restored = 0;
        for path in DREAM_TRACKED_MEMORY_FILES {
            let spec = format!("{parent_sha}:{path}");
            let Some(contents) = self.git_output_bytes(&["show", &spec]) else {
                continue;
            };
            let destination = self.workspace_root.join(path);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).ok()?;
            }
            fs::write(destination, contents).ok()?;
            restored += 1;
        }
        if restored == 0 {
            return None;
        }
        self.git_status(&[
            "add",
            "--",
            "SOUL.md",
            "USER.md",
            "memory/MEMORY.md",
            "memory/notes.jsonl",
        ])?;
        if self
            .git_status(&["diff", "--cached", "--quiet", "--"])
            .is_some()
        {
            return None;
        }
        self.git_status(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            &format!("revert: undo {short_sha}"),
        ])?;
        self.git_output(&["rev-parse", "--short=8", "HEAD"])
            .map(|sha| sha.trim().to_string())
            .filter(|sha| !sha.is_empty())
    }

    fn git_output(&self, args: &[&str]) -> Option<String> {
        self.git_output_bytes(args)
            .map(|output| String::from_utf8_lossy(&output).into_owned())
    }

    fn git_output_bytes(&self, args: &[&str]) -> Option<Vec<u8>> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.workspace_root)
            .args(args)
            .output()
            .ok()?;
        output.status.success().then_some(output.stdout)
    }

    fn git_status(&self, args: &[&str]) -> Option<()> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.workspace_root)
            .args(args)
            .output()
            .ok()?;
        output.status.success().then_some(())
    }

    fn read_notes(&self) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        Ok(self
            .read_notes_with_lines()?
            .into_iter()
            .map(|(note, _line)| note)
            .collect())
    }

    fn read_notes_with_lines(
        &self,
    ) -> Result<Vec<(Value, usize)>, crate::worker_protocol::WorkerProtocolError> {
        let path = self.notes_path();
        if !path.exists() {
            return Ok(vec![]);
        }
        let contents = fs::read_to_string(&path).map_err(memory_io_error)?;
        Ok(contents
            .lines()
            .enumerate()
            .filter_map(|(index, line)| {
                let value = serde_json::from_str::<Value>(line).ok()?;
                value.is_object().then_some((value, index + 1))
            })
            .collect())
    }

    fn find_note_with_line(
        &self,
        note_id: &str,
    ) -> Result<(Value, usize), crate::worker_protocol::WorkerProtocolError> {
        self.read_notes_with_lines()?
            .into_iter()
            .find(|(note, _line)| note.get("id").and_then(Value::as_str) == Some(note_id))
            .ok_or_else(|| invalid_memory_request(format!("Memory Note not found: {note_id}")))
    }

    fn write_notes(
        &self,
        notes: &[Value],
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let path = self.notes_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        let contents = notes
            .iter()
            .map(|note| serde_json::to_string(note).map_err(serialization_error))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        fs::write(path, format!("{contents}\n")).map_err(memory_io_error)
    }

    fn refresh_memory_views(
        &self,
        notes: &[Value],
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        for (view_file, title) in MEMORY_VIEW_TITLES {
            let rendered = render_memory_view_section(title, notes, view_file);
            let path = self.workspace_root.join(view_file);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(memory_io_error)?;
            }
            let existing =
                fs::read_to_string(&path).unwrap_or_else(|_| default_memory_view(view_file));
            let updated = replace_managed_memory_view(&existing, title, &rendered);
            fs::write(path, updated).map_err(memory_io_error)?;
        }
        Ok(())
    }

    fn evidence_sequence_path(&self) -> PathBuf {
        self.workspace_root
            .join("memory")
            .join(".evidence_sequence")
    }

    fn evidence_cursor_path(&self) -> PathBuf {
        self.workspace_root.join("memory").join(".evidence_cursor")
    }

    fn write_evidence_cursor(
        &self,
        cursor: usize,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let path = self.evidence_cursor_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        fs::write(path, cursor.to_string()).map_err(memory_io_error)
    }

    fn conversations_dir(&self) -> PathBuf {
        self.workspace_root.join("memory").join("conversations")
    }

    fn conversation_evidence_path(&self, timestamp: &str) -> PathBuf {
        self.conversations_dir()
            .join(format!("{}.jsonl", conversation_evidence_date(timestamp)))
    }

    fn read_conversation_evidence_ids(
        &self,
    ) -> Result<std::collections::HashSet<String>, crate::worker_protocol::WorkerProtocolError>
    {
        let mut ids = std::collections::HashSet::new();
        let conversations_dir = self.conversations_dir();
        let entries = match fs::read_dir(&conversations_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
            Err(error) => return Err(memory_io_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(memory_io_error)?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let contents = fs::read_to_string(path).map_err(memory_io_error)?;
            for line in contents.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        ids.insert(id.to_string());
                    }
                }
            }
        }
        Ok(ids)
    }

    fn read_conversation_evidence_records(
        &self,
    ) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        let mut records = Vec::new();
        let conversations_dir = self.conversations_dir();
        let entries = match fs::read_dir(&conversations_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(records),
            Err(error) => return Err(memory_io_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(memory_io_error)?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let contents = fs::read_to_string(path).map_err(memory_io_error)?;
            for line in contents.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    if value.is_object() {
                        records.push(value);
                    }
                }
            }
        }
        Ok(records)
    }

    fn pending_conversation_evidence(
        &self,
        since_cursor: usize,
        limit: usize,
    ) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        let mut evidence = self.read_conversation_evidence_records()?;
        evidence.retain(|record| {
            record
                .get("cursor")
                .and_then(Value::as_u64)
                .is_some_and(|cursor| cursor > since_cursor as u64)
        });
        evidence.sort_by(|left, right| {
            let left_cursor = left.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let right_cursor = right.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            left_cursor
                .cmp(&right_cursor)
                .then_with(|| {
                    left.get("timestamp")
                        .and_then(Value::as_str)
                        .cmp(&right.get("timestamp").and_then(Value::as_str))
                })
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .cmp(&right.get("id").and_then(Value::as_str))
                })
        });
        evidence.truncate(limit);
        Ok(evidence)
    }

    fn next_evidence_cursor(&self) -> Result<usize, crate::worker_protocol::WorkerProtocolError> {
        let sequence_path = self.evidence_sequence_path();
        if let Ok(contents) = fs::read_to_string(&sequence_path) {
            if let Ok(value) = contents.trim().parse::<usize>() {
                return Ok(value + 1);
            }
        }
        Ok(self.max_evidence_cursor()? + 1)
    }

    fn max_evidence_cursor(&self) -> Result<usize, crate::worker_protocol::WorkerProtocolError> {
        let mut max_cursor = 0;
        let conversations_dir = self.conversations_dir();
        let entries = match fs::read_dir(&conversations_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(memory_io_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(memory_io_error)?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let contents = fs::read_to_string(path).map_err(memory_io_error)?;
            for line in contents.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    if let Some(cursor) = value.get("cursor").and_then(Value::as_u64) {
                        max_cursor = max_cursor.max(cursor as usize);
                    }
                }
            }
        }
        Ok(max_cursor)
    }

    fn last_evidence_cursor(&self) -> usize {
        fs::read_to_string(self.evidence_cursor_path())
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0)
    }

    fn pending_legacy_history(
        &self,
        limit: usize,
    ) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        let path = self.workspace_root.join("memory").join("history.jsonl");
        let contents = match fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(memory_io_error(error)),
        };
        let since_cursor = self.last_dream_cursor() as u64;
        let mut history = contents
            .lines()
            .filter_map(|line| {
                let value = serde_json::from_str::<Value>(line).ok()?;
                value
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .is_some_and(|cursor| cursor > since_cursor)
                    .then_some(value)
            })
            .collect::<Vec<_>>();
        history.sort_by(|left, right| {
            let left_cursor = left.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let right_cursor = right.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            left_cursor.cmp(&right_cursor).then_with(|| {
                left.get("timestamp")
                    .and_then(Value::as_str)
                    .cmp(&right.get("timestamp").and_then(Value::as_str))
            })
        });
        history.truncate(limit);
        Ok(history)
    }

    fn append_conversation_evidence_record(
        &self,
        record: &Value,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let path = self.conversation_evidence_path(timestamp);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(memory_io_error)?;
        writeln!(
            file,
            "{}",
            serde_json::to_string(record).map_err(serialization_error)?
        )
        .map_err(memory_io_error)
    }

    fn write_evidence_sequence(
        &self,
        cursor: usize,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let path = self.evidence_sequence_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        fs::write(path, cursor.to_string()).map_err(memory_io_error)
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
struct ChannelConnectorParams {
    channel: String,
}

#[derive(Deserialize)]
struct ApprovalRequestParams {
    run_id: String,
    #[serde(default)]
    session_id: Option<String>,
    operation: Value,
    #[serde(default)]
    classification: Option<ApprovalClassificationParams>,
    #[serde(default)]
    fingerprint: Option<String>,
    #[serde(default)]
    session_fingerprint: Option<String>,
    #[serde(default, rename = "sessionFingerprint")]
    session_fingerprint_camel: Option<String>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Deserialize)]
struct ApprovalResolveParams {
    session_id: String,
    approval_id: String,
    approved: bool,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize)]
struct ApprovalClassificationParams {
    category: String,
    risk: String,
    reason: String,
}

#[derive(Deserialize)]
struct FormRequestParams {
    run_id: String,
    #[serde(default)]
    session_id: Option<String>,
    form: Value,
    #[serde(default)]
    continuation_mode: Option<String>,
}

#[derive(Deserialize)]
struct MemorySearchParams {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    note_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct MemoryRecallParams {
    #[serde(default)]
    query: String,
    #[serde(default)]
    max_notes: Option<usize>,
    #[serde(default)]
    max_chars: Option<usize>,
}

#[derive(Deserialize)]
struct MemoryDreamParams {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Clone, Debug)]
struct DreamCommitInfo {
    sha: String,
    full_sha: String,
    message: String,
    timestamp: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DreamExtractionResult {
    captured_notes: usize,
    skipped_evidence: usize,
    last_evidence_cursor: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DreamLegacyExtractionResult {
    captured_notes: usize,
    skipped_history: usize,
    last_dream_cursor: usize,
}

#[derive(Deserialize)]
struct MemoryCaptureEvidenceParams {
    session_key: String,
    #[serde(default)]
    start_index: Option<usize>,
    #[serde(default)]
    messages: Vec<Value>,
}

#[derive(Deserialize)]
struct MemoryListEvidenceParams {
    #[serde(default)]
    since_cursor: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    session_key: Option<String>,
}

#[derive(Deserialize)]
struct MemoryNoteIdParams {
    note_id: String,
}

#[derive(Deserialize)]
struct MemoryRejectParams {
    note_id: String,
    #[serde(default)]
    reason: Option<String>,
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
struct McpCallToolParams {
    #[serde(default)]
    session_id: Option<String>,
    server: String,
    tool: String,
    #[serde(default)]
    arguments: Option<Value>,
}

#[derive(Deserialize)]
struct MemorySaveParams {
    #[serde(default)]
    session_id: Option<String>,
    content: String,
    note_type: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    priority: Option<f64>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    message_start: Option<usize>,
    #[serde(default)]
    message_end: Option<usize>,
}

#[derive(Deserialize)]
struct MemoryDreamApplyParams {
    #[serde(default)]
    session_id: Option<String>,
    kind: String,
    #[serde(default)]
    cursor_start: Option<usize>,
    #[serde(default)]
    cursor_end: Option<usize>,
    #[serde(default)]
    evidence_ids: Option<Vec<String>>,
    #[serde(default)]
    notes: Vec<MemoryDreamApplyNoteParams>,
}

#[derive(Deserialize)]
struct MemoryDreamApplyNoteParams {
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    target_note_id: Option<String>,
    #[serde(default)]
    content: String,
    #[serde(default)]
    note_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    priority: Option<f64>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    evidence_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct MemorySupersedeParams {
    note_id: String,
    replacement_content: String,
    #[serde(default)]
    note_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    priority: Option<f64>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    message_start: Option<usize>,
    #[serde(default)]
    message_end: Option<usize>,
}

#[derive(Deserialize)]
struct RuntimeNowParams {
    timezone: Option<String>,
}

#[derive(Deserialize)]
struct RuntimeRestartParams {
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
}

#[derive(Clone, Debug)]
struct WorkerChannelConnectorRpc {
    policy: CapabilityPolicy,
}

impl WorkerChannelConnectorRpc {
    fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    fn start(
        &self,
        params: ChannelConnectorParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.unavailable(params.channel, "start")
    }

    fn stop(
        &self,
        params: ChannelConnectorParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.unavailable(params.channel, "stop")
    }

    fn send_text(
        &self,
        params: ChannelConnectorParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.unavailable(params.channel, "send_text")
    }

    fn send_delta(
        &self,
        params: ChannelConnectorParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.unavailable(params.channel, "send_delta")
    }

    fn send_usage(
        &self,
        params: ChannelConnectorParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.unavailable(params.channel, "send_usage")
    }

    fn unavailable(
        &self,
        channel: String,
        operation: &str,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require()?;
        Ok(serde_json::json!({
            "ok": true,
            "channel": channel,
            "operation": operation,
            "handled": false,
            "reason": "native_connector_unavailable",
        }))
    }

    fn require(&self) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        if self.policy.allows(&WorkerCapability::ChannelConnector) {
            return Ok(());
        }
        Err(crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": WorkerCapability::ChannelConnector }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        ))
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(
    request: &WorkerRequest,
) -> Result<T, crate::worker_protocol::WorkerProtocolError> {
    serde_json::from_value(request.params.clone()).map_err(|error| {
        crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
            "invalid worker request params",
            serde_json::json!({
                "method": request.method,
                "error": error.to_string(),
            }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        )
    })
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

fn runtime_now(timezone: Option<String>) -> Value {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let timezone = timezone.unwrap_or_else(|| "local".to_string());
    serde_json::json!({
        "current_time": format!("unix-ms:{millis} {timezone}"),
        "timezone": timezone,
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

fn unknown_method_error(request: &WorkerRequest) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        "unknown worker RPC method",
        serde_json::json!({ "method": request.method }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn invalid_form_request(message: impl Into<String>) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "form.request" }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn invalid_approval_request(
    message: impl Into<String>,
) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "approval.resolve" }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

const MEMORY_NOTE_TYPES: &[&str] = &[
    "preference",
    "instruction",
    "project",
    "decision",
    "fix",
    "followup",
];
const MEMORY_NOTE_SCOPES: &[&str] = &["user", "assistant", "project", "session"];
const MEMORY_NOTE_STATUSES: &[&str] = &["active", "superseded", "rejected"];
const MEMORY_VIEW_TITLES: &[(&str, &str)] = &[
    ("memory/MEMORY.md", "Project Memory Notes"),
    ("USER.md", "User Memory Notes"),
    ("SOUL.md", "Assistant Memory Notes"),
];
const DREAM_TRACKED_MEMORY_FILES: &[&str] = &[
    "SOUL.md",
    "USER.md",
    "memory/MEMORY.md",
    "memory/notes.jsonl",
];

fn invalid_memory_request(
    message: impl Into<String>,
) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "memory" }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn memory_dream_unavailable(content: &str) -> Value {
    memory_dream_result(content, false)
}

fn memory_dream_result(content: &str, available: bool) -> Value {
    memory_dream_result_with_metadata(content, available, serde_json::json!({}))
}

fn memory_dream_result_with_metadata(
    content: &str,
    available: bool,
    extra_metadata: Value,
) -> Value {
    let mut metadata = serde_json::json!({
        "render_as": "text",
        "available": available
    });
    if let (Some(base), Some(extra)) = (metadata.as_object_mut(), extra_metadata.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    serde_json::json!({
        "content": content,
        "metadata": metadata
    })
}

fn memory_dream_pending_batch(
    kind: &str,
    records: Vec<Value>,
    last_cursor: Option<usize>,
    memory_context: Value,
) -> Value {
    let cursors: Vec<usize> = records
        .iter()
        .filter_map(|record| {
            record
                .get("cursor")
                .and_then(Value::as_u64)
                .map(|cursor| cursor as usize)
        })
        .collect();
    let cursor_start = cursors.iter().min().copied().unwrap_or(0);
    let cursor_end = cursors.iter().max().copied().unwrap_or(cursor_start);
    let evidence_ids: Vec<String> = records
        .iter()
        .filter_map(|record| {
            record
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
        })
        .collect();
    serde_json::json!({
        "kind": kind,
        "records": records,
        "pending_evidence": if kind == "conversation_evidence" { cursors.len() } else { 0 },
        "pending_legacy_history": if kind == "legacy_history" { cursors.len() } else { 0 },
        "cursor_start": cursor_start,
        "cursor_end": cursor_end,
        "last_cursor": last_cursor.unwrap_or(0),
        "evidence_ids": evidence_ids,
        "memory_context": memory_context
    })
}

fn format_dream_current_notes(notes: &[Value]) -> String {
    let mut active_notes = notes
        .iter()
        .filter(|note| {
            note.get("status")
                .and_then(Value::as_str)
                .unwrap_or("active")
                == "active"
        })
        .collect::<Vec<_>>();
    active_notes.sort_by(|left, right| {
        let left_key = (
            left.get("status")
                .and_then(Value::as_str)
                .unwrap_or("active"),
            left.get("type")
                .and_then(Value::as_str)
                .unwrap_or("project"),
            left.get("content").and_then(Value::as_str).unwrap_or(""),
        );
        let right_key = (
            right
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("active"),
            right
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("project"),
            right.get("content").and_then(Value::as_str).unwrap_or(""),
        );
        left_key.cmp(&right_key)
    });
    if active_notes.is_empty() {
        return "(no Memory Notes)".to_string();
    }
    active_notes
        .into_iter()
        .map(|note| {
            format!(
                "- id={} status={} scope={} type={} priority={} confidence={}: {}",
                note.get("id").and_then(Value::as_str).unwrap_or("unknown"),
                note.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("active"),
                note.get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("project"),
                note.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("project"),
                format_memory_number(note.get("priority").and_then(Value::as_f64).unwrap_or(0.5)),
                format_memory_number(
                    note.get("confidence")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.5)
                ),
                note.get("content").and_then(Value::as_str).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn dream_note_content(record: &Value) -> Option<String> {
    let role = record
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if role != "user" && role != "assistant" {
        return None;
    }
    record
        .get("content")
        .and_then(Value::as_str)
        .and_then(dream_memory_text)
}

fn dream_memory_text(content: &str) -> Option<String> {
    let content = content
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if content.len() < 8 || content.len() > 2_000 {
        return None;
    }
    let lower = content.to_ascii_lowercase();
    let has_memory_intent = [
        "remember",
        "persist",
        "save this",
        "keep this",
        "note that",
        "preference",
        "prefer",
        "decided",
        "decision",
        "follow up",
        "follow-up",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    has_memory_intent.then_some(content)
}

fn dream_note_type(content: &str) -> &'static str {
    let lower = content.to_ascii_lowercase();
    if lower.contains("prefer") || lower.contains("preference") {
        "preference"
    } else if lower.contains("decided") || lower.contains("decision") {
        "decision"
    } else if lower.contains("fix") || lower.contains("bug") || lower.contains("regression") {
        "fix"
    } else if lower.contains("follow up") || lower.contains("follow-up") || lower.contains("todo") {
        "followup"
    } else {
        "project"
    }
}

fn dream_log_content(commit: &DreamCommitInfo, diff: &str, requested_sha: Option<&str>) -> String {
    let mut lines = vec![
        "## Dream Update".to_string(),
        String::new(),
        if requested_sha.is_some() {
            "Here is the selected Dream memory change.".to_string()
        } else {
            "Here is the latest Dream memory change.".to_string()
        },
        String::new(),
        format!("- Commit: `{}`", commit.sha),
        format!("- Time: {}", commit.timestamp),
        format!("- Changed files: {}", format_dream_changed_files(diff)),
    ];
    if diff.trim().is_empty() {
        lines.extend([
            String::new(),
            "Dream recorded this version, but there is no file diff to display.".to_string(),
        ]);
    } else {
        lines.extend([
            String::new(),
            format!("Use `/dream-restore {}` to undo this change.", commit.sha),
            String::new(),
            "```diff".to_string(),
            diff.trim_end().to_string(),
            "```".to_string(),
        ]);
    }
    lines.join("\n")
}

fn dream_restore_list_content(commits: &[DreamCommitInfo]) -> String {
    let mut lines = vec![
        "## Dream Restore".to_string(),
        String::new(),
        "Choose a Dream memory version to restore. Latest first:".to_string(),
        String::new(),
    ];
    for commit in commits {
        let summary = commit.message.lines().next().unwrap_or_default();
        lines.push(format!(
            "- `{}` {} - {}",
            commit.sha, commit.timestamp, summary
        ));
    }
    lines.extend([
        String::new(),
        "Preview a version with `/dream-log <sha>` before restoring it.".to_string(),
        "Restore a version with `/dream-restore <sha>`.".to_string(),
    ]);
    lines.join("\n")
}

fn format_dream_changed_files(diff: &str) -> String {
    let files = extract_dream_changed_files(diff);
    if files.is_empty() {
        return "No tracked memory files changed.".to_string();
    }
    files
        .into_iter()
        .map(|path| format!("`{path}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn extract_dream_changed_files(diff: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in diff.lines() {
        if !line.starts_with("diff --git ") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let _diff = parts.next();
        let _git = parts.next();
        let _left = parts.next();
        let Some(right) = parts.next() else {
            continue;
        };
        let path = right.strip_prefix("b/").unwrap_or(right).to_string();
        if !files.contains(&path) {
            files.push(path);
        }
    }
    files
}

fn required_memory_note_id(
    note_id: &str,
) -> Result<&str, crate::worker_protocol::WorkerProtocolError> {
    let note_id = note_id.trim();
    if note_id.is_empty() {
        return Err(invalid_memory_request("Memory Note id is required"));
    }
    Ok(note_id)
}

fn find_note_mut<'a>(
    notes: &'a mut [Value],
    note_id: &str,
) -> Result<&'a mut Value, crate::worker_protocol::WorkerProtocolError> {
    notes
        .iter_mut()
        .find(|note| note.get("id").and_then(Value::as_str) == Some(note_id))
        .ok_or_else(|| invalid_memory_request(format!("Memory Note not found: {note_id}")))
}

fn ensure_json_object_field(note: &mut Value, field: &str) {
    if !note.get(field).is_some_and(Value::is_object) {
        note[field] = serde_json::json!({});
    }
}

fn memory_note_locations(note: &Value, line: usize) -> Value {
    let view_file = note
        .get("type")
        .and_then(Value::as_str)
        .map(memory_note_view_file)
        .unwrap_or("memory/MEMORY.md");
    serde_json::json!({
        "file": "memory/notes.jsonl",
        "line": line,
        "view_file": view_file
    })
}

fn memory_recall_reference(note: &Value) -> Value {
    let mut reference = serde_json::json!({
        "note_id": note.get("id").cloned().unwrap_or(Value::Null),
        "scope": note.get("scope").cloned().unwrap_or(Value::String("project".to_string())),
        "type": note.get("type").cloned().unwrap_or(Value::String("project".to_string())),
        "status": note.get("status").cloned().unwrap_or(Value::String("active".to_string())),
        "content": note.get("content").cloned().unwrap_or(Value::String(String::new())),
        "priority": note.get("priority").cloned().unwrap_or(serde_json::json!(0.5)),
        "confidence": note.get("confidence").cloned().unwrap_or(serde_json::json!(0.5)),
        "tags": note.get("tags").cloned().unwrap_or(serde_json::json!([])),
        "metadata": note.get("metadata").cloned().unwrap_or(serde_json::json!({})),
    });
    for key in ["file", "line", "view_file", "view_line"] {
        if let Some(value) = note.get(key) {
            reference[key] = value.clone();
        }
    }
    let evidence_ids = memory_note_evidence_ids(note);
    if !evidence_ids.is_empty() {
        reference["evidence_ids"] = serde_json::json!(evidence_ids);
    }
    reference
}

fn render_memory_recall_context(notes: &[Value], max_chars: usize) -> String {
    if notes.is_empty() || max_chars == 0 {
        return String::new();
    }
    let mut lines = vec![
        "---".to_string(),
        "[MEMORY RECALL]".to_string(),
        String::new(),
        "Active Memory Notes selected for this request. Keep this separate from Experience and Knowledge Base context.".to_string(),
        String::new(),
    ];
    for note in notes {
        lines.push(format_memory_recall_note(note));
    }
    lines.push("---".to_string());
    truncate_memory_context(&lines.join("\n"), max_chars)
}

fn format_memory_recall_note(note: &Value) -> String {
    let content = note.get("content").and_then(Value::as_str).unwrap_or("");
    let id = note.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let scope = note
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("project");
    let note_type = note
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("project");
    let priority = note.get("priority").and_then(Value::as_f64).unwrap_or(0.5);
    let confidence = note
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.5);
    let tags = note
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|value| !value.is_empty())
        .map(|value| format!("; tags: {value}"))
        .unwrap_or_default();
    format!(
        "- {content} (id: {id}; scope: {scope}; type: {note_type}; priority: {}; confidence: {}{tags})",
        format_memory_number(priority),
        format_memory_number(confidence)
    )
}

fn truncate_memory_context(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(max_chars.saturating_sub(3)).collect();
    truncated.push_str("...");
    truncated
}

fn memory_note_evidence_ids(note: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(sources) = note.get("sources").and_then(Value::as_array) {
        for source in sources {
            if let Some(evidence_ids) = source.get("evidence_ids").and_then(Value::as_array) {
                for evidence_id in evidence_ids {
                    if let Some(evidence_id) = evidence_id.as_str() {
                        ids.push(evidence_id.to_string());
                    }
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn conversation_evidence_text(message: &Value) -> String {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
        return String::new();
    }
    if role == "assistant" && message.get("tool_calls").is_some_and(Value::is_array) {
        return String::new();
    }
    match message.get("content") {
        Some(Value::String(content)) => strip_think_tags(content).trim().to_string(),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                let Some(block) = block.as_object() else {
                    continue;
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            let text = strip_think_tags(text).trim().to_string();
                            if !text.is_empty() {
                                parts.push(text);
                            }
                        }
                    }
                    Some("image_url") => parts.push("[media omitted]".to_string()),
                    _ => {}
                }
            }
            parts.join("\n").trim().to_string()
        }
        _ => String::new(),
    }
}

fn strip_think_tags(value: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
    loop {
        let Some(start) = rest.find("<think>") else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..start]);
        let after_start = &rest[start + "<think>".len()..];
        if let Some(end) = after_start.find("</think>") {
            rest = &after_start[end + "</think>".len()..];
        } else {
            break;
        }
    }
    output
}

fn generate_conversation_turn_id(
    session_key: &str,
    messages: &[(usize, String, String, String)],
) -> String {
    let mut payload = String::new();
    payload.push_str(session_key);
    for (message_index, role, content, _) in messages {
        payload.push('|');
        payload.push_str(&message_index.to_string());
        payload.push(':');
        payload.push_str(role);
        payload.push(':');
        payload.push_str(content);
    }
    format!("turn_{:016x}", stable_memory_hash(&payload))
}

fn generate_conversation_evidence_id(
    session_key: &str,
    turn_id: &str,
    role: &str,
    content: &str,
    message_index: usize,
) -> String {
    format!(
        "ev_{:016x}",
        stable_memory_hash(&format!(
            "{session_key}|{turn_id}|{role}|{content}|{message_index}"
        ))
    )
}

fn stable_memory_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn conversation_evidence_date(timestamp: &str) -> String {
    let candidate = timestamp.get(..10).unwrap_or_default();
    if is_iso_date(candidate) {
        candidate.to_string()
    } else {
        memory_timestamp_date()
    }
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn memory_timestamp_date() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() / 86_400)
        .unwrap_or_default();
    // Civil date conversion based on Howard Hinnant's days_from_civil inverse.
    let z = days as i64 + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{year:04}-{m:02}-{d:02}")
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

fn invalid_mcp_request(message: impl Into<String>) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "mcp.call_tool" }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn mcp_tool_denied(server: &str, tool: &str) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied,
        "MCP tool is not allowlisted",
        serde_json::json!({
            "capability": WorkerCapability::McpCall,
            "server": server,
            "tool": tool,
        }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn validate_mcp_name<'a>(
    field: &str,
    value: &'a str,
) -> Result<&'a str, crate::worker_protocol::WorkerProtocolError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
        })
    {
        return Err(invalid_mcp_request(format!(
            "{field} must contain only ASCII letters, numbers, _, -, or ."
        )));
    }
    Ok(value)
}

fn mcp_tool_is_enabled(server_name: &str, tool_name: &str, server: &Value) -> bool {
    let enabled_tools = server
        .get("enabled_tools")
        .or_else(|| server.get("enabledTools"))
        .and_then(Value::as_array);
    let Some(enabled_tools) = enabled_tools else {
        return false;
    };
    let wrapped_name = format!("mcp_{server_name}_{tool_name}");
    enabled_tools.iter().any(|value| {
        value.as_str().is_some_and(|enabled| {
            enabled == "*" || enabled == tool_name || enabled == wrapped_name
        })
    })
}

fn mcp_fixture_tool_content(server: &Value, tool_name: &str) -> Option<String> {
    let tool_result = server
        .get("fixture_tools")
        .or_else(|| server.get("fixtureTools"))
        .and_then(|tools| tools.get(tool_name))?;
    if let Some(content) = tool_result.as_str() {
        return Some(content.to_string());
    }
    tool_result
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| Some(tool_result.to_string()))
}

fn mcp_fixture_tool_definitions(server_name: &str, server: &Value) -> Vec<Value> {
    let Some(tools) = server
        .get("fixture_tools")
        .or_else(|| server.get("fixtureTools"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut definitions = tools
        .iter()
        .filter_map(|(tool_name, tool)| {
            validate_mcp_name("tool", tool_name).ok()?;
            if !mcp_tool_is_enabled(server_name, tool_name, server) {
                return None;
            }
            let input_schema = tool
                .get("inputSchema")
                .or_else(|| tool.get("input_schema"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "type": "object" }));
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or(tool_name);
            Some(serde_json::json!({
                "name": tool_name,
                "description": description,
                "inputSchema": input_schema,
            }))
        })
        .collect::<Vec<_>>();
    definitions.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    });
    definitions
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

fn memory_io_error(error: std::io::Error) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::WorkerError,
        "memory note store I/O failed",
        serde_json::json!({ "error": error.to_string() }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn validate_memory_value<'a>(
    field: &str,
    value: &'a str,
    allowed: &[&str],
) -> Result<&'a str, crate::worker_protocol::WorkerProtocolError> {
    if allowed.contains(&value) {
        return Ok(value);
    }
    Err(invalid_memory_request(format!(
        "Invalid Memory Note {field}: {value:?}. Allowed: {}",
        allowed.join(", ")
    )))
}

fn validate_optional_memory_value(
    field: &str,
    value: Option<String>,
    allowed: &[&str],
) -> Result<Option<String>, crate::worker_protocol::WorkerProtocolError> {
    match value.filter(|value| !value.trim().is_empty()) {
        Some(value) => Ok(Some(
            validate_memory_value(field, &value, allowed)?.to_string(),
        )),
        None => Ok(None),
    }
}

fn validate_memory_score(
    field: &str,
    value: f64,
) -> Result<f64, crate::worker_protocol::WorkerProtocolError> {
    if (0.0..=1.0).contains(&value) {
        return Ok(value);
    }
    Err(invalid_memory_request(format!(
        "{field} must be between 0 and 1"
    )))
}

fn default_memory_scope(note_type: &str) -> &'static str {
    match note_type {
        "preference" => "user",
        "instruction" => "assistant",
        _ => "project",
    }
}

fn memory_query_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn memory_note_matches(note: &Value, key: &str, expected: Option<&str>) -> bool {
    expected.is_none_or(|expected| note.get(key).and_then(Value::as_str) == Some(expected))
}

fn memory_note_matches_query(note: &Value, query_terms: &[String]) -> bool {
    let haystack = memory_note_search_text(note);
    query_terms.iter().all(|term| haystack.contains(term))
}

fn memory_note_score(note: &Value, query_terms: &[String]) -> f64 {
    let haystack = memory_note_search_text(note);
    let query_score = query_terms
        .iter()
        .filter(|term| haystack.contains(term.as_str()))
        .count() as f64;
    let priority = note.get("priority").and_then(Value::as_f64).unwrap_or(0.5);
    let confidence = note
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.5);
    query_score + priority + confidence
}

fn memory_note_search_text(note: &Value) -> String {
    let mut fields = vec![];
    for key in ["id", "scope", "type", "status", "content"] {
        if let Some(value) = note.get(key).and_then(Value::as_str) {
            fields.push(value.to_ascii_lowercase());
        }
    }
    if let Some(tags) = note.get("tags").and_then(Value::as_array) {
        for tag in tags {
            if let Some(value) = tag.as_str() {
                fields.push(value.to_ascii_lowercase());
            }
        }
    }
    fields.join(" ")
}

fn annotate_memory_note_location(mut note: Value, line: usize) -> Value {
    note["file"] = Value::String("memory/notes.jsonl".to_string());
    note["line"] = serde_json::json!(line);
    if let Some(note_type) = note.get("type").and_then(Value::as_str) {
        note["view_file"] = Value::String(memory_note_view_file(note_type).to_string());
    }
    note
}

fn memory_note_view_file(note_type: &str) -> &'static str {
    match note_type {
        "preference" => "USER.md",
        "instruction" => "SOUL.md",
        _ => "memory/MEMORY.md",
    }
}

fn memory_note_view_file_for_note(note: &Value) -> &'static str {
    match note.get("scope").and_then(Value::as_str) {
        Some("user") => "USER.md",
        Some("assistant") => "SOUL.md",
        Some("project" | "session") => "memory/MEMORY.md",
        _ => note
            .get("type")
            .and_then(Value::as_str)
            .map(memory_note_view_file)
            .unwrap_or("memory/MEMORY.md"),
    }
}

fn default_memory_view(view_file: &str) -> String {
    match view_file {
        "USER.md" => {
            "# User Profile\n\n## User Memory Notes\n\n(No active Memory Notes.)\n".to_string()
        }
        "SOUL.md" => {
            "# Assistant Profile\n\n## Assistant Memory Notes\n\n(No active Memory Notes.)\n"
                .to_string()
        }
        _ => "# Long-term Memory\n\n## Project Memory Notes\n\n(No active Memory Notes.)\n"
            .to_string(),
    }
}

fn render_memory_view_section(title: &str, notes: &[Value], view_file: &str) -> String {
    let active_notes: Vec<&Value> = notes
        .iter()
        .filter(|note| {
            note.get("status")
                .and_then(Value::as_str)
                .unwrap_or("active")
                == "active"
        })
        .filter(|note| memory_note_view_file_for_note(note) == view_file)
        .collect();
    let mut lines = vec![
        format!("## {title}"),
        String::new(),
        "Edit durable memory through Memory Note operations instead of changing this section directly.".to_string(),
        String::new(),
    ];
    if active_notes.is_empty() {
        lines.push("(No active Memory Notes.)".to_string());
        return format!("{}\n", lines.join("\n"));
    }
    for note_type in MEMORY_NOTE_TYPES {
        let typed_notes: Vec<&Value> = active_notes
            .iter()
            .copied()
            .filter(|note| note.get("type").and_then(Value::as_str) == Some(*note_type))
            .collect();
        if typed_notes.is_empty() {
            continue;
        }
        lines.push(format!("### {}", memory_note_type_heading(note_type)));
        lines.push(String::new());
        for note in typed_notes {
            lines.push(render_memory_view_note(note));
        }
        lines.push(String::new());
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    format!("{}\n", lines.join("\n"))
}

fn render_memory_view_note(note: &Value) -> String {
    let id = note.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let content = note.get("content").and_then(Value::as_str).unwrap_or("");
    let priority = note.get("priority").and_then(Value::as_f64).unwrap_or(0.5);
    let confidence = note
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.5);
    let tags = note
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .filter(|tags| !tags.is_empty())
        .map(|tags| format!(" tags={tags}"))
        .unwrap_or_default();
    format!(
        "- [{id}] {content} priority={} confidence={}{}",
        format_memory_number(priority),
        format_memory_number(confidence),
        tags
    )
}

fn memory_note_type_heading(note_type: &str) -> String {
    let mut chars = note_type.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => "Memory".to_string(),
    }
}

fn format_memory_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn replace_managed_memory_view(existing: &str, title: &str, rendered: &str) -> String {
    let heading = format!("## {title}");
    if let Some(start) = existing.find(&heading) {
        let after_heading = &existing[start + heading.len()..];
        let end = after_heading
            .find("\n## ")
            .map(|offset| start + heading.len() + offset)
            .unwrap_or(existing.len());
        let prefix = existing[..start].trim_end();
        let suffix = existing[end..].trim_start();
        let mut parts = vec![];
        if !prefix.is_empty() {
            parts.push(prefix.to_string());
        }
        parts.push(rendered.trim_end().to_string());
        if !suffix.is_empty() {
            parts.push(suffix.to_string());
        }
        return format!("{}\n", parts.join("\n\n"));
    }
    if existing.trim().is_empty() {
        return rendered.to_string();
    }
    format!("{}\n\n{}", existing.trim_end(), rendered)
}

fn generate_memory_note_id(note_type: &str, scope: &str, content: &str, source: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    note_type.hash(&mut hasher);
    scope.hash(&mut hasher);
    content.hash(&mut hasher);
    source.to_string().hash(&mut hasher);
    format!("mem_{:016x}", hasher.finish())
}

fn memory_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("unix:{seconds}")
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
    fn dispatches_runtime_restart_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([]),
        );
        let request = WorkerRequest::new(
            "req-restart",
            "trace-restart",
            "runtime.restart",
            json!({
                "run_id": "run-1",
                "session_id": "session-1"
            }),
        );

        let response = router.dispatch(&request);

        assert!(response.matches_request(&request));
        assert!(response.error.is_none());
        assert_eq!(
            response.result.expect("restart result should be present"),
            json!({
                "restart_requested": true,
                "run_id": "run-1",
                "session_id": "session-1"
            })
        );
    }

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
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "stale",
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
    fn channel_connector_send_text_returns_explicit_unavailable_bridge_result() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ChannelConnector]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "channel.connector.send_text",
            json!({
                "channel": "feishu",
                "chat_id": "oc_1",
                "content": "hello",
                "media": ["file://a.png"],
                "metadata": { "reply_kind": "text" },
                "reply_to": "msg-1"
            }),
        );

        let response = router.dispatch(&request);

        assert!(response.error.is_none());
        let result = response.result.expect("connector result should be present");
        assert_eq!(result["ok"], true);
        assert_eq!(result["channel"], "feishu");
        assert_eq!(result["operation"], "send_text");
        assert_eq!(result["handled"], false);
        assert_eq!(result["reason"], "native_connector_unavailable");
    }

    #[test]
    fn channel_connector_methods_require_connector_capability() {
        let fixture = WorkspaceFixture::new();
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
            "channel.connector.start",
            json!({ "channel": "feishu" }),
        );

        let response = router.dispatch(&request);

        let error = response
            .error
            .expect("connector start should require channel capability");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "channel.connector");
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

        assert_eq!(
            response.result.as_ref().unwrap()["value"]["providers"]["openai"]["api_key"],
            serde_json::Value::Null
        );
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
        assert_eq!(
            result["config"]["providers"]["openai"]["apiKey"],
            serde_json::Value::Null
        );
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
        assert_eq!(
            result["config"]["providers"]["openai"]["apiKey"],
            serde_json::Value::Null
        );
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
    fn dispatches_runtime_now_request() {
        let fixture = WorkspaceFixture::new();
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
            "runtime.now",
            json!({ "timezone": "Asia/Shanghai" }),
        );

        let response = router.dispatch(&request);

        assert!(response.error.is_none());
        assert_eq!(
            response.result.as_ref().unwrap()["timezone"],
            "Asia/Shanghai"
        );
        assert!(response.result.as_ref().unwrap()["current_time"]
            .as_str()
            .is_some());
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
    fn dispatches_form_request() {
        let fixture = WorkspaceFixture::new();
        let form = json!({
            "form_id": "travel_plan",
            "title": "Travel plan",
            "fields": [
                { "name": "destination", "type": "text", "label": "Destination" }
            ]
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::FormRequest]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "form.request",
            json!({
                "run_id": "run-1",
                "session_id": "session-1",
                "form": form,
                "continuation_mode": "resume"
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "content": "Waiting for form submission.",
                "awaitingUserInput": true,
                "stopReason": "awaiting_form",
                "formId": "travel_plan",
                "form": form,
                "continuationMode": "resume",
                "runId": "run-1",
                "sessionId": "session-1"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_memory_save_and_search_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "session_id": "session-1",
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff", "communication"],
                "metadata": { "source": "desktop" },
                "message_start": 3,
                "message_end": 4
            }),
        );

        let save_response = router.dispatch(&save_request);
        let saved_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let search_request = WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.search",
            json!({
                "query": "handoff",
                "note_type": "preference",
                "status": "active",
                "limit": 5
            }),
        );

        let search_response = router.dispatch(&search_request);
        let mut expected_search_note = saved_note.clone();
        expected_search_note["file"] = json!("memory/notes.jsonl");
        expected_search_note["line"] = json!(1);
        expected_search_note["view_file"] = json!("USER.md");

        assert_eq!(saved_note["scope"], "user");
        assert_eq!(saved_note["type"], "preference");
        assert_eq!(saved_note["status"], "active");
        assert_eq!(
            saved_note["content"],
            "User prefers concise implementation handoffs."
        );
        assert_eq!(saved_note["priority"], 0.8);
        assert_eq!(saved_note["confidence"], 0.7);
        assert_eq!(saved_note["tags"], json!(["handoff", "communication"]));
        assert_eq!(saved_note["metadata"], json!({ "source": "desktop" }));
        assert_eq!(
            saved_note["sources"],
            json!([
                {
                    "capture_origin": "explicit",
                    "session_key": "session-1",
                    "message_start": 3,
                    "message_end": 4
                }
            ])
        );
        assert_eq!(
            search_response.result,
            Some(json!({ "notes": [expected_search_note] }))
        );
        assert!(save_response.error.is_none());
        assert!(search_response.error.is_none());
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("User prefers concise implementation handoffs."));
    }

    #[test]
    fn dispatches_memory_recall_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        let saved_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let note_id = saved_note["id"]
            .as_str()
            .expect("saved note should have id");

        let recall_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.recall",
            json!({
                "query": "handoff",
                "max_notes": 6,
                "max_chars": 1600
            }),
        ));

        let result = recall_response
            .result
            .as_ref()
            .expect("memory.recall should return result");
        assert_eq!(recall_response.error, None);
        assert!(result["context"]
            .as_str()
            .expect("context should be a string")
            .contains("[MEMORY RECALL]"));
        assert_eq!(result["notes"][0]["id"], note_id);
        assert_eq!(result["references"][0]["note_id"], note_id);
        assert_eq!(
            result["references"][0]["content"],
            "User prefers concise implementation handoffs."
        );
        assert_eq!(result["references"][0]["view_file"], "USER.md");
    }

    #[test]
    fn dispatches_memory_dream_log_for_latest_git_memory_commit() {
        let fixture = dream_git_fixture();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-log",
            "trace-1",
            "memory.dream_log",
            json!({}),
        ));
        let result = response.result.expect("dream log should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream log content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("## Dream Update"));
        assert!(content.contains("Here is the latest Dream memory change."));
        assert!(content.contains("- Changed files: `memory/MEMORY.md`"));
        assert!(content.contains("Use `/dream-restore "));
        assert!(content.contains("```diff"));
        assert!(content.contains("+Dream captured a durable fact."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_restore_lists_recent_commits() {
        let fixture = dream_git_fixture();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-restore-list",
            "trace-1",
            "memory.dream_restore",
            json!({}),
        ));
        let result = response
            .result
            .expect("dream restore should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream restore content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("## Dream Restore"));
        assert!(content.contains("Choose a Dream memory version to restore. Latest first:"));
        assert!(content.contains("dream: 2026-06-12, 1 change(s)"));
        assert!(content.contains("Preview a version with `/dream-log <sha>` before restoring it."));
        assert!(content.contains("Restore a version with `/dream-restore <sha>`."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_restore_reverts_selected_commit() {
        let fixture = dream_git_fixture();
        let sha = fixture.git_stdout(&["rev-parse", "--short=8", "HEAD"]);
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-restore",
            "trace-1",
            "memory.dream_restore",
            json!({ "sha": sha.trim() }),
        ));
        let result = response
            .result
            .expect("dream restore should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream restore content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("Restored Dream memory to the state before"));
        assert!(content.contains("- New safety commit: `"));
        assert!(content.contains("- Restored files: `memory/MEMORY.md`"));
        assert_eq!(fixture.read("memory/MEMORY.md"), "Initial memory\n");
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_run_reports_nothing_to_process_without_pending_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({ "session_id": "session-1" }),
        ));

        assert_eq!(
            response.result,
            Some(json!({
                "content": "Dream: nothing to process.",
                "metadata": {
                    "render_as": "text",
                    "available": true,
                    "changed": false,
                    "pending_evidence": 0
                }
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_memory_dream_run_extracts_pending_conversation_evidence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "Remember that I prefer uv for Python commands.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream run content should be text");

        assert!(response.error.is_none());
        assert!(content
            .contains("Dream captured 1 memory note(s) from 1 conversation evidence record(s)."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
        assert_eq!(result["metadata"]["changed"], json!(true));
        assert_eq!(result["metadata"]["pending_evidence"], json!(1));
        assert_eq!(result["metadata"]["captured_notes"], json!(1));
        assert_eq!(result["metadata"]["last_evidence_cursor"], json!(3));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "3");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"evidence_ids\":[\"ev_1\"]"));
        assert!(notes.contains("Remember that I prefer uv for Python commands."));
    }

    #[test]
    fn dispatches_memory_dream_run_extracts_pending_legacy_history() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/history.jsonl",
            &format!(
                "{}\n{}\n",
                json!({
                    "cursor": 3,
                    "timestamp": "2026-06-12 03:00",
                    "content": "User prefers concise progress updates."
                }),
                json!({
                    "cursor": 4,
                    "timestamp": "2026-06-12 03:01",
                    "content": "Short exchange with no durable memory."
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream run content should be text");

        assert!(response.error.is_none());
        assert!(
            content.contains("Dream captured 1 memory note(s) from 2 legacy history record(s).")
        );
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
        assert_eq!(result["metadata"]["changed"], json!(true));
        assert_eq!(result["metadata"]["pending_legacy_history"], json!(2));
        assert_eq!(result["metadata"]["captured_notes"], json!(1));
        assert_eq!(result["metadata"]["skipped_history"], json!(1));
        assert_eq!(result["metadata"]["last_dream_cursor"], json!(4));
        assert_eq!(fixture.read("memory/.dream_cursor"), "4");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"history_start_cursor\":3"));
        assert!(notes.contains("\"history_end_cursor\":3"));
        assert!(notes.contains("User prefers concise progress updates."));
    }

    #[test]
    fn dispatches_memory_dream_run_defers_non_explicit_conversation_evidence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");

        assert!(response.error.is_none());
        assert_eq!(result["metadata"]["changed"], json!(false));
        assert_eq!(result["metadata"]["deferred"], json!(true));
        assert_eq!(result["metadata"]["pending_evidence"], json!(1));
        assert_eq!(result["metadata"]["skipped_evidence"], json!(1));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "2");
    }

    #[test]
    fn dispatches_memory_dream_run_defers_non_explicit_legacy_history() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/history.jsonl",
            &format!(
                "{}\n",
                json!({
                    "cursor": 3,
                    "timestamp": "2026-06-12 03:00",
                    "content": "We discussed the desktop runtime behavior."
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");

        assert!(response.error.is_none());
        assert_eq!(result["metadata"]["changed"], json!(false));
        assert_eq!(result["metadata"]["deferred"], json!(true));
        assert_eq!(result["metadata"]["pending_legacy_history"], json!(1));
        assert_eq!(result["metadata"]["skipped_history"], json!(1));
        assert_eq!(fixture.read("memory/.dream_cursor"), "2");
    }

    #[test]
    fn dispatches_memory_dream_pending_returns_deferred_conversation_evidence_batch() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "note_user_pref",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers compact migration slices.",
                    "priority": 0.8,
                    "confidence": 0.9,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                })
            ),
        );
        fixture.write("memory/MEMORY.md", "Project memory view\n");
        fixture.write("SOUL.md", "Assistant memory view\n");
        fixture.write("USER.md", "User memory view\n");
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-pending",
            "trace-1",
            "memory.dream_pending",
            json!({}),
        ));
        let result = response
            .result
            .expect("dream pending should return a batch");

        assert!(response.error.is_none());
        assert_eq!(result["kind"], json!("conversation_evidence"));
        assert_eq!(result["pending_evidence"], json!(1));
        assert_eq!(result["cursor_start"], json!(3));
        assert_eq!(result["cursor_end"], json!(3));
        assert_eq!(result["evidence_ids"], json!(["ev_1"]));
        assert_eq!(
            result["records"][0]["content"],
            json!("We discussed the desktop runtime behavior.")
        );
        assert!(result["memory_context"]["current_notes"]
            .as_str()
            .unwrap_or_default()
            .contains("id=note_user_pref status=active scope=user type=preference"));
        assert_eq!(
            result["memory_context"]["current_memory"],
            json!("Project memory view\n")
        );
        assert_eq!(
            result["memory_context"]["current_soul"],
            json!("Assistant memory view\n")
        );
        assert_eq!(
            result["memory_context"]["current_user"],
            json!("User memory view\n")
        );
    }

    #[test]
    fn dispatches_memory_dream_apply_writes_provider_notes_with_dream_source_and_advances_cursor() {
        let fixture = WorkspaceFixture::new();
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-apply",
            "trace-1",
            "memory.dream_apply",
            json!({
                "kind": "conversation_evidence",
                "session_id": "desktop:session-1",
                "cursor_start": 3,
                "cursor_end": 5,
                "evidence_ids": ["ev_1", "ev_2"],
                "notes": [{
                    "content": "User wants desktop runtime migration slices to stay reasonably sized.",
                    "note_type": "preference",
                    "scope": "user",
                    "priority": 0.7,
                    "confidence": 0.8,
                    "tags": ["migration"],
                    "metadata": { "source": "provider" }
                }]
            }),
        ));
        let result = response.result.expect("dream apply should return result");

        assert!(response.error.is_none());
        assert_eq!(result["applied_notes"], json!(1));
        assert_eq!(result["last_evidence_cursor"], json!(5));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "5");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"evidence_ids\":[\"ev_1\",\"ev_2\"]"));
        assert!(notes.contains("\"history_start_cursor\":3"));
        assert!(notes.contains("\"history_end_cursor\":5"));
        assert!(notes.contains("\"extractor\":\"ts_provider_dream\""));
        assert!(
            notes.contains("User wants desktop runtime migration slices to stay reasonably sized.")
        );
    }

    #[test]
    fn dispatches_memory_dream_apply_rejects_and_supersedes_provider_operations() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\n{}\n",
                json!({
                    "id": "note_reject",
                    "scope": "project",
                    "type": "project",
                    "status": "active",
                    "content": "Temporary runtime discussion should be durable.",
                    "priority": 0.5,
                    "confidence": 0.5,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                }),
                json!({
                    "id": "note_old",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers very tiny migration commits.",
                    "priority": 0.5,
                    "confidence": 0.5,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "3");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-apply",
            "trace-1",
            "memory.dream_apply",
            json!({
                "kind": "legacy_history",
                "cursor_start": 4,
                "cursor_end": 6,
                "notes": [
                    {
                        "action": "reject",
                        "target_note_id": "note_reject",
                        "metadata": { "reason": "provider correction" }
                    },
                    {
                        "action": "supersede",
                        "target_note_id": "note_old",
                        "content": "User prefers reasonably sized migration slices.",
                        "note_type": "preference",
                        "scope": "user",
                        "priority": 0.8,
                        "confidence": 0.9,
                        "tags": ["dream"]
                    }
                ]
            }),
        ));
        let result = response.result.expect("dream apply should return result");

        assert!(response.error.is_none());
        assert_eq!(result["applied_notes"], json!(2));
        assert_eq!(result["last_dream_cursor"], json!(6));
        assert_eq!(fixture.read("memory/.dream_cursor"), "6");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"id\":\"note_reject\""));
        assert!(notes.contains("\"status\":\"rejected\""));
        assert!(notes.contains("\"id\":\"note_old\""));
        assert!(notes.contains("\"status\":\"superseded\""));
        assert!(notes.contains("\"supersedes\":[\"note_old\"]"));
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"history_start_cursor\":4"));
        assert!(notes.contains("\"history_end_cursor\":6"));
        assert!(notes.contains("User prefers reasonably sized migration slices."));
    }

    #[test]
    fn dispatches_memory_dream_command_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let run_response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({ "session_id": "session-1" }),
        ));
        let log_response = router.dispatch(&WorkerRequest::new(
            "req-log",
            "trace-1",
            "memory.dream_log",
            json!({ "sha": "abc123" }),
        ));
        let restore_response = router.dispatch(&WorkerRequest::new(
            "req-restore",
            "trace-1",
            "memory.dream_restore",
            json!({}),
        ));

        assert_eq!(
            run_response.result,
            Some(json!({
                "content": "Dream: nothing to process.",
                "metadata": {
                    "render_as": "text",
                    "available": true,
                    "changed": false,
                    "pending_evidence": 0
                }
            }))
        );
        assert_eq!(
            log_response.result,
            Some(json!({
                "content": "Dream has not run yet. Run `/dream`, or wait for the next scheduled Dream cycle.",
                "metadata": { "render_as": "text", "available": false }
            }))
        );
        assert_eq!(
            restore_response.result,
            Some(json!({
                "content": "Dream history is not available because memory versioning is not initialized.",
                "metadata": { "render_as": "text", "available": false }
            }))
        );
        assert!(run_response.error.is_none());
        assert!(log_response.error.is_none());
        assert!(restore_response.error.is_none());
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
    fn dispatches_memory_capture_evidence_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.capture_evidence",
            json!({
                "session_key": "desktop:session-1",
                "start_index": 7,
                "messages": [
                    { "role": "user", "content": "Remember this migration note.", "timestamp": "2026-06-12T03:00:00Z" },
                    { "role": "assistant", "content": "Captured.", "timestamp": "2026-06-12T03:00:01Z" },
                    { "role": "assistant", "content": "", "tool_calls": [{ "id": "call-1" }] },
                    { "role": "tool", "content": "ignored" }
                ]
            }),
        ));

        let result = response
            .result
            .as_ref()
            .expect("memory.capture_evidence should return result");
        assert_eq!(response.error, None);
        assert_eq!(result["evidence"].as_array().unwrap().len(), 2);
        assert_eq!(result["evidence"][0]["session_key"], "desktop:session-1");
        assert_eq!(result["evidence"][0]["role"], "user");
        assert_eq!(
            result["evidence"][0]["content"],
            "Remember this migration note."
        );
        assert_eq!(result["evidence"][0]["message_index"], 7);
        assert_eq!(result["evidence"][0]["cursor"], 1);
        assert_eq!(result["evidence"][1]["role"], "assistant");
        assert_eq!(result["evidence"][1]["message_index"], 8);
        assert_eq!(result["evidence"][1]["cursor"], 2);
        assert!(fixture
            .read("memory/conversations/2026-06-12.jsonl")
            .contains("Remember this migration note."));
        assert_eq!(fixture.read("memory/.evidence_sequence").trim(), "2");

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.list_evidence",
            json!({ "session_key": "desktop:session-1", "limit": 10 }),
        ));
        let list_result = list_response
            .result
            .as_ref()
            .expect("memory.list_evidence should return result");
        assert_eq!(list_response.error, None);
        assert_eq!(list_result["evidence"].as_array().unwrap().len(), 2);
        assert_eq!(list_result["evidence"][0]["cursor"], 1);
        assert_eq!(list_result["evidence"][1]["cursor"], 2);
    }

    #[test]
    fn dispatches_memory_trace_reject_and_supersede_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "Use pytest for TS worker tests.",
                "note_type": "instruction",
                "scope": "assistant",
                "priority": 0.6,
                "confidence": 0.65,
                "tags": ["testing"]
            }),
        ));
        let old_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let old_note_id = old_note["id"].as_str().expect("saved note should have id");

        let trace_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.trace",
            json!({ "note_id": old_note_id }),
        ));
        let supersede_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "memory.supersede",
            json!({
                "note_id": old_note_id,
                "replacement_content": "Use vitest for TS worker tests.",
                "note_type": "instruction",
                "scope": "assistant",
                "priority": 0.8,
                "confidence": 0.9,
                "tags": ["testing", "typescript"],
                "metadata": { "reason": "TS worker tests run in Vitest" },
                "session_id": "session-1",
                "message_start": 5,
                "message_end": 6
            }),
        ));
        let replacement_id = supersede_response
            .result
            .as_ref()
            .expect("memory.supersede should return result")["note"]["id"]
            .as_str()
            .expect("replacement note should have id")
            .to_string();
        let reject_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "memory.reject",
            json!({ "note_id": replacement_id }),
        ));

        assert_eq!(
            trace_response.result.as_ref().unwrap()["note"]["id"],
            old_note_id
        );
        assert_eq!(
            trace_response.result.as_ref().unwrap()["locations"],
            json!({
                "file": "memory/notes.jsonl",
                "line": 1,
                "view_file": "SOUL.md"
            })
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["old_note"]["status"],
            "superseded"
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["old_note"]["superseded_by"],
            replacement_id
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["note"]["supersedes"],
            json!([old_note_id])
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["note"]["sources"],
            json!([{
                "capture_origin": "explicit",
                "session_key": "session-1",
                "message_start": 5,
                "message_end": 6
            }])
        );
        assert_eq!(
            reject_response.result.as_ref().unwrap()["note"]["status"],
            "rejected"
        );
        assert_eq!(
            reject_response.result.as_ref().unwrap()["views_refreshed"],
            true
        );
        assert!(trace_response.error.is_none());
        assert!(supersede_response.error.is_none());
        assert!(reject_response.error.is_none());
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("\"status\":\"superseded\""));
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("\"status\":\"rejected\""));
        assert!(!fixture
            .read("SOUL.md")
            .contains("Use pytest for TS worker tests."));
        assert!(!fixture
            .read("SOUL.md")
            .contains("Use vitest for TS worker tests."));
    }

    #[test]
    fn memory_search_respects_read_capability() {
        let fixture = WorkspaceFixture::new();
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
            "memory.search",
            json!({ "query": "handoff" }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "memory.read");
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
        assert_eq!(
            query_response.result.as_ref().unwrap()["results"][0],
            json!({
                "id": format!("chunk_{doc_id}_0"),
                "doc_id": doc_id,
                "parent_id": format!("chunk_{doc_id}_0"),
                "chunk_type": "parent",
                "content": "# Desktop Knowledge Notes\n\nTS worker knowledge store should persist chunks for sparse retrieval.\n",
                "matched_child_ids": [],
                "matched_child_snippets": [],
                "doc_name": "Desktop Knowledge Notes",
                "file_path": format!("knowledge/files/{doc_id}.md"),
                "start_char": 0,
                "end_char": 97,
                "line_start": 1,
                "line_end": 3,
                "section_path": "Desktop Knowledge Notes",
                "block_type": "text",
                "score": 2,
                "rrf_score": 2,
                "semantic_score": null,
                "bm25_score": 2,
                "dense_distance": null,
                "dense_rank": null,
                "sparse_rank": 1,
                "dense_contribution": null,
                "sparse_contribution": 2,
                "method": "sparse",
                "retrieval_method": "sparse",
                "score_metadata": {},
                "source_snippets": [],
                "matched_methods": [],
                "matched_entities": [],
                "matched_claims": [],
                "matched_claim_evidence": [],
                "matched_relations": [],
                "matched_relation_evidence": [],
                "matched_communities": [],
                "conflict_metadata": [],
                "projection_metadata": []
            })
        );

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
        assert_eq!(stats["stage_coverage"]["sparse_indexing"], 1.0);
        assert_eq!(stats["stage_details"], json!([]));
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

    #[test]
    fn dispatches_mcp_call_tool_request_from_configured_allowlist() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({
                "tools": {
                    "mcp_servers": {
                        "docs": {
                            "enabled_tools": ["search"],
                            "fixture_tools": {
                                "search": { "content": "MCP search result" }
                            }
                        }
                    }
                }
            }),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::McpCall]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "mcp.call_tool",
            json!({
                "session_id": "session-1",
                "server": "docs",
                "tool": "search",
                "arguments": { "query": "agent loop" }
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "content": "MCP search result",
                "server": "docs",
                "tool": "search"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_mcp_list_tools_from_configured_fixture_tools() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({
                "tools": {
                    "mcp_servers": {
                        "docs": {
                            "enabled_tools": ["search", "mcp_docs_read"],
                            "fixture_tools": {
                                "search": {
                                    "description": "Search docs",
                                    "input_schema": {
                                        "type": "object",
                                        "properties": { "query": { "type": "string" } }
                                    },
                                    "content": "MCP search result"
                                },
                                "read": {
                                    "description": "Read docs",
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": { "path": { "type": "string" } }
                                    },
                                    "content": "MCP read result"
                                },
                                "delete": { "content": "not allowlisted" }
                            }
                        }
                    }
                }
            }),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::McpCall]),
        );
        let request = WorkerRequest::new("req-1", "trace-1", "mcp.list_tools", json!({}));

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "servers": [
                    {
                        "name": "docs",
                        "tools": [
                            {
                                "name": "read",
                                "description": "Read docs",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": { "path": { "type": "string" } }
                                }
                            },
                            {
                                "name": "search",
                                "description": "Search docs",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": { "query": { "type": "string" } }
                                }
                            }
                        ]
                    }
                ]
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn mcp_call_tool_requires_allowlisted_tool() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({
                "tools": {
                    "mcp_servers": {
                        "docs": {
                            "enabled_tools": ["search"]
                        }
                    }
                }
            }),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::McpCall]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "mcp.call_tool",
            json!({
                "server": "docs",
                "tool": "delete_everything",
                "arguments": {}
            }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["server"], "docs");
        assert_eq!(error.details["tool"], "delete_everything");
        assert!(response.result.is_none());
    }

    #[test]
    fn memory_save_refreshes_managed_memory_views() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "USER.md",
            "# User Profile\n\nKeep this unmanaged note.\n\n## User Memory Notes\n\n(Old managed content.)\n\n*Edit unmanaged sections for manual profile details.*\n",
        );
        fixture.write(
            "SOUL.md",
            "# Assistant Profile\n\n## Assistant Memory Notes\n\n(Old assistant managed content.)\n",
        );
        fixture.write(
            "memory/MEMORY.md",
            "# Long-term Memory\n\n## Project Memory Notes\n\n(Old project managed content.)\n",
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let preference = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        let instruction = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.save",
            json!({
                "content": "Speak directly and avoid vague claims.",
                "note_type": "instruction"
            }),
        ));
        let project = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "memory.save",
            json!({
                "content": "Use the TS worker for experimental agent runs.",
                "note_type": "decision"
            }),
        ));

        let user_view = fixture.read("USER.md");
        let soul_view = fixture.read("SOUL.md");
        let project_view = fixture.read("memory/MEMORY.md");

        assert!(preference.error.is_none());
        assert!(instruction.error.is_none());
        assert!(project.error.is_none());
        assert!(user_view.contains("# User Profile"));
        assert!(user_view.contains("Keep this unmanaged note."));
        assert!(user_view.contains("## User Memory Notes"));
        assert!(user_view.contains("### Preference"));
        assert!(user_view.contains("User prefers concise implementation handoffs."));
        assert!(user_view.contains("tags=handoff"));
        assert!(!user_view.contains("Old managed content"));
        assert!(soul_view.contains("## Assistant Memory Notes"));
        assert!(soul_view.contains("### Instruction"));
        assert!(soul_view.contains("Speak directly and avoid vague claims."));
        assert!(project_view.contains("## Project Memory Notes"));
        assert!(project_view.contains("### Decision"));
        assert!(project_view.contains("Use the TS worker for experimental agent runs."));
    }

    fn approval_test_router(fixture: &WorkspaceFixture) -> WorkerRpcRouter {
        WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
            ]),
        )
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

    #[test]
    fn dispatches_approval_request() {
        let fixture = WorkspaceFixture::new();
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ApprovalRequest]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "approval.request",
            json!({
                "run_id": "run-1",
                "session_id": "session-1",
                "operation": operation,
                "classification": {
                    "category": "filesystem_write",
                    "risk": "medium",
                    "reason": "File write/edit/delete tools can modify workspace state."
                },
                "fingerprint": "write_file:notes/today.md",
                "session_fingerprint": "write_file:notes/today.md",
                "summary": "write_file path=\"notes/today.md\""
            }),
        );

        let response = router.dispatch(&request);
        let result = response.result.as_ref().expect("approval request result");

        assert_eq!(result["content"], "Waiting for approval.");
        assert_eq!(result["awaitingUserInput"], true);
        assert_eq!(result["stopReason"], "awaiting_approval");
        assert!(result["approvalId"]
            .as_str()
            .unwrap()
            .starts_with("approval-"));
        assert_eq!(result["operation"], operation);
        assert_eq!(result["runId"], "run-1");
        assert_eq!(result["sessionId"], "session-1");
        assert_eq!(result["category"], "filesystem_write");
        assert_eq!(result["risk"], "medium");
        assert_eq!(
            result["reason"],
            "File write/edit/delete tools can modify workspace state."
        );
        assert_eq!(result["summary"], "write_file path=\"notes/today.md\"");
        assert_eq!(result["fingerprint"], "write_file:notes/today.md");
        assert_eq!(result["sessionFingerprint"], "write_file:notes/today.md");
        assert!(response.error.is_none());
    }

    #[test]
    fn approval_resolve_returns_the_stored_pending_operation() {
        let fixture = WorkspaceFixture::new();
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
            ]),
        );
        let request_response = router.dispatch(&WorkerRequest::new(
            "req-request",
            "trace-1",
            "approval.request",
            json!({
                "run_id": "run-1",
                "session_id": "session-1",
                "operation": operation,
                "classification": {
                    "category": "filesystem_write",
                    "risk": "medium",
                    "reason": "File write/edit/delete tools can modify workspace state."
                },
                "fingerprint": "write_file:notes/today.md",
                "session_fingerprint": "write_file:notes/today.md",
                "summary": "write_file path=\"notes/today.md\""
            }),
        ));
        let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        let response = router.dispatch(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "session"
            }),
        ));

        assert_eq!(
            response.result,
            Some(json!({
                "approvalId": approval_id,
                "approved": true,
                "scope": "session",
                "status": "approved",
                "sessionId": "session-1",
                "operation": operation,
                "category": "filesystem_write",
                "risk": "medium",
                "reason": "File write/edit/delete tools can modify workspace state.",
                "summary": "write_file path=\"notes/today.md\"",
                "fingerprint": "write_file:notes/today.md",
                "sessionFingerprint": "write_file:notes/today.md"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn approval_list_pending_returns_session_scoped_records() {
        let fixture = WorkspaceFixture::new();
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([
                WorkerCapability::ApprovalRequest,
                WorkerCapability::ApprovalResolve,
            ]),
        );
        let request_response = router.dispatch(&approval_request(
            "req-request-1",
            "run-1",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ));
        let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        router.dispatch(&approval_request(
            "req-request-2",
            "run-2",
            "session-2",
            operation,
            "write_file:notes/other.md",
            "write_file:notes/other.md",
        ));

        let response = router.dispatch(&WorkerRequest::new(
            "req-list",
            "trace-1",
            "approval.list_pending",
            json!({ "session_id": "session-1" }),
        ));

        assert_eq!(
            response.result,
            Some(json!({
                "sessionId": "session-1",
                "approvals": [
                    {
                        "id": approval_id,
                        "runId": "run-1",
                        "sessionId": "session-1",
                        "operation": {
                            "toolName": "write_file",
                            "arguments": { "path": "notes/today.md", "contents": "hello" },
                            "toolCallId": "call-1"
                        },
                        "category": "filesystem_write",
                        "risk": "medium",
                        "reason": "File write/edit/delete tools can modify workspace state.",
                        "summary": "write_file path=\"notes/today.md\"",
                        "fingerprint": "write_file:notes/today.md",
                        "sessionFingerprint": "write_file:notes/today.md"
                    }
                ]
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn approval_resolve_rejects_missing_pending_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::ApprovalResolve]),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": "approval-1",
                "approved": true,
                "scope": "session"
            }),
        );

        let response = router.dispatch(&request);

        assert!(response.result.is_none());
        assert_eq!(
            response.error.as_ref().map(|error| error.message.as_str()),
            Some("pending approval not found")
        );
    }

    #[test]
    fn approval_once_scope_is_consumed_by_the_next_matching_request() {
        let fixture = WorkspaceFixture::new();
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut router = approval_test_router(&fixture);
        let request_response = router.dispatch(&approval_request(
            "req-request",
            "run-1",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ));
        let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        let resolve_response = router.dispatch(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "once"
            }),
        ));
        assert!(resolve_response.error.is_none());

        let allowed_response = router.dispatch(&approval_request(
            "req-allowed",
            "run-2",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ));
        assert_eq!(
            allowed_response.result.as_ref().unwrap()["decision"],
            "allow"
        );
        assert_eq!(allowed_response.result.as_ref().unwrap()["scope"], "once");
        assert_eq!(
            allowed_response.result.as_ref().unwrap()["operation"],
            operation
        );
        assert!(allowed_response.error.is_none());

        let pending_again_response = router.dispatch(&approval_request(
            "req-pending-again",
            "run-3",
            "session-1",
            operation,
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        ));
        let result = pending_again_response.result.as_ref().unwrap();
        assert_eq!(result["stopReason"], "awaiting_approval");
        assert_eq!(result["awaitingUserInput"], true);
        assert!(result["approvalId"]
            .as_str()
            .unwrap()
            .starts_with("approval-"));
        assert!(pending_again_response.error.is_none());
    }

    #[test]
    fn approval_session_scope_allows_matching_session_fingerprint_only_in_same_session() {
        let fixture = WorkspaceFixture::new();
        let mut router = approval_test_router(&fixture);
        let original_operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let request_response = router.dispatch(&approval_request(
            "req-request",
            "run-1",
            "session-1",
            original_operation,
            "write_file:notes/today.md:hello",
            "write_file:notes/today.md",
        ));
        let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
            .as_str()
            .unwrap()
            .to_string();
        let resolve_response = router.dispatch(&WorkerRequest::new(
            "req-resolve",
            "trace-1",
            "approval.resolve",
            json!({
                "session_id": "session-1",
                "approval_id": approval_id,
                "approved": true,
                "scope": "session"
            }),
        ));
        assert!(resolve_response.error.is_none());

        let changed_operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "changed" },
            "toolCallId": "call-2"
        });
        let allowed_response = router.dispatch(&approval_request(
            "req-allowed",
            "run-2",
            "session-1",
            changed_operation.clone(),
            "write_file:notes/today.md:changed",
            "write_file:notes/today.md",
        ));
        assert_eq!(
            allowed_response.result.as_ref().unwrap()["decision"],
            "allow"
        );
        assert_eq!(
            allowed_response.result.as_ref().unwrap()["scope"],
            "session"
        );
        assert_eq!(
            allowed_response.result.as_ref().unwrap()["operation"],
            changed_operation
        );
        assert!(allowed_response.error.is_none());

        let other_session_response = router.dispatch(&approval_request(
            "req-other-session",
            "run-3",
            "session-2",
            changed_operation,
            "write_file:notes/today.md:changed",
            "write_file:notes/today.md",
        ));
        let result = other_session_response.result.as_ref().unwrap();
        assert_eq!(result["stopReason"], "awaiting_approval");
        assert_eq!(result["awaitingUserInput"], true);
        assert!(other_session_response.error.is_none());
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
        let delete_response = router.dispatch(&WorkerRequest::new(
            "req-delete",
            "trace-1",
            "workspace.delete_file",
            json!({ "path": "notes", "recursive": true }),
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
            CapabilityPolicy::new([WorkerCapability::ShellExecute]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-shell",
            "trace-1",
            "shell.execute",
            json!({ "command": "echo tinybot", "working_dir": ".", "timeout": 5 }),
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

    fn dream_git_fixture() -> WorkspaceFixture {
        let fixture = WorkspaceFixture::new();
        fixture.write("memory/MEMORY.md", "Initial memory\n");
        fixture.write("USER.md", "");
        fixture.write("SOUL.md", "");
        fixture.write("memory/notes.jsonl", "");
        fixture.git(&["init"]);
        fixture.git(&[
            "add",
            "SOUL.md",
            "USER.md",
            "memory/MEMORY.md",
            "memory/notes.jsonl",
        ]);
        fixture.git(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            "init: tinybot memory store",
        ]);
        fixture.write(
            "memory/MEMORY.md",
            "Initial memory\nDream captured a durable fact.\n",
        );
        fixture.git(&["add", "memory/MEMORY.md"]);
        fixture.git(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            "dream: 2026-06-12, 1 change(s)",
        ]);
        fixture
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

        fn git(&self, args: &[&str]) {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .expect("git command should run");
            assert!(
                output.status.success(),
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
        }

        fn git_stdout(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .expect("git command should run");
            assert!(
                output.status.success(),
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
