use crate::config_store::{ConfigPatchBridgeResult, ConfigStore};
use crate::runtime::mcp::McpRuntime;
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
    ThreadApplyOpRequest, ThreadEventsRequest, ThreadIdParams, ThreadOp,
    UpdateThreadMetadataRequest, WorkerThreadRpc,
};
use crate::worker_thread_log::WorkerThreadLogRpc;
use crate::worker_tool_executor::{
    tool_not_found_error, tool_unavailable_error, ToolExecutorExecuteRequest,
    ToolExecutorExecuteResult,
};
use crate::worker_tool_registry::{
    ToolExecutionTarget, ToolRegistrySearchRequest, WorkerToolRegistryRpc,
};
use crate::worker_workspace::{WorkerWorkspaceRpc, WorkspaceReadFormat, WorkspaceReadOptions};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

mod approval;
mod background_dispatch;
mod channel;
mod config_dispatch;
mod errors;
mod form;
mod interaction_dispatch;
mod knowledge_dispatch;
mod mcp;
mod memory_dispatch;
mod method;
mod persistence_facade;
pub(crate) mod protocol;
mod runtime;
mod runtime_dispatch;
mod subagent_dispatch;
mod thread_dispatch;
mod tool_dispatch;
mod workspace_dispatch;

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
            mcp: WorkerMcpRpc::new(
                workspace_root.clone(),
                config_snapshot,
                policy.clone(),
                McpRuntime::new(),
            ),
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
            mcp: WorkerMcpRpc::new(
                workspace_root.clone(),
                config_snapshot,
                policy.clone(),
                McpRuntime::new(),
            ),
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

    pub(crate) fn with_mcp_runtime(mut self, runtime: McpRuntime) -> Self {
        self.mcp.replace_runtime(runtime);
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
            method if method.starts_with("workspace.") || method.starts_with("skills.") => {
                self.dispatch_workspace_method(request)
            }
            method if method.starts_with("config.") || method == "provider.resolve_secret" => {
                self.dispatch_config_method(request)
            }
            method if method.starts_with("session.") => self.dispatch_session_persistence(request),
            method if method.starts_with("thread.") => self.dispatch_thread_method(request),
            method if method.starts_with("agent_run.") => {
                self.dispatch_agent_run_persistence(request)
            }
            method
                if method == "diagnostics.append"
                    || method.starts_with("channel.connector.")
                    || method == "shell.execute"
                    || method.starts_with("approval.")
                    || method == "form.request" =>
            {
                self.dispatch_interaction_method(request)
            }
            method if method.starts_with("memory.") => self.dispatch_memory_method(request),
            method if method.starts_with("knowledge.") || method == "rag.query" => {
                self.dispatch_knowledge_method(request)
            }
            method
                if method.starts_with("task.")
                    || method.starts_with("cron.")
                    || method.starts_with("background.") =>
            {
                self.dispatch_background_method(request)
            }
            method if method.starts_with("subagent.") => self.dispatch_subagent_method(request),
            method
                if method.starts_with("mcp.")
                    || method.starts_with("permission_profile.")
                    || method.starts_with("tool_executor.")
                    || method.starts_with("tool_registry.") =>
            {
                self.dispatch_tool_method(request)
            }
            method if method.starts_with("runtime.") => self.dispatch_runtime_method(request),
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

        let (target_method, tool_arguments) = match &tool.execution_target {
            ToolExecutionTarget::WorkerRpc { method } => (
                method.clone(),
                tool_executor_arguments_with_context(&params),
            ),
            ToolExecutionTarget::Mcp { server, tool } => (
                "mcp.call_tool".to_string(),
                serde_json::json!({
                    "server": server,
                    "tool": tool,
                    "arguments": params.arguments.clone(),
                    "session_id": params.session_id,
                }),
            ),
            ToolExecutionTarget::RuntimeControl(_) => {
                return Err(WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "runtime control tools cannot be dispatched through tool_executor.execute",
                    serde_json::json!({ "toolId": tool.tool_id }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                ));
            }
        };
        let tool_request = WorkerRequest::new(
            request.id.clone(),
            request.trace_id.clone(),
            target_method,
            tool_arguments,
        )
        .with_cancellation(request.cancellation());
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
    fn into_shell_params(
        self,
        cancellation: Option<std::sync::Arc<dyn crate::worker_protocol::WorkerRequestCancellation>>,
    ) -> ShellExecuteParams {
        ShellExecuteParams {
            command: self.command,
            working_dir: self.working_dir,
            timeout: self.timeout,
            restrict_to_workspace: self.restrict_to_workspace,
            cancellation,
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
mod tests;
