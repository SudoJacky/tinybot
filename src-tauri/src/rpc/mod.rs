use crate::automation::background::{
    BackgroundRunCompleteParams, BackgroundRunUpsertParams, BackgroundSubagentEnqueueInputParams,
    BackgroundTraceAppendParams, BackgroundTraceGetArtifactParams,
    BackgroundTraceGetDelegateTraceParams, BackgroundTraceListFilter, BackgroundTraceListParams,
    WorkerBackgroundRpc,
};
use crate::automation::cron::{
    CronJobAddParams, CronJobDueParams, CronJobRecordRunsParams, CronJobRemoveParams, WorkerCronRpc,
};
use crate::automation::tasks::{
    TaskPlanIdParams, TaskPlanListParams, TaskPlanSaveParams, WorkerTaskRpc,
};
use crate::collaboration::subagents::{
    SubagentHistoryMode, SubagentInputSender, SubagentSendInputParams, SubagentSpawnParams,
    SubagentTargetParams, SubagentThreadManager, SubagentThreadStatus, SubagentThreadSummary,
    SubagentWaitParams,
};
use crate::config::runtime::WorkerConfigRpc;
use crate::config::secrets::{ProviderResolveSecretParams, WorkerSecretRpc};
use crate::config::store::{ConfigPatchBridgeResult, ConfigStore};
use crate::memory::WorkerMemoryRpc;
use crate::protocol::capability::CapabilityPolicy;
use crate::protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
    WorkerResponse,
};
use crate::runtime::mcp::McpRuntime;
use crate::threads::domain::{
    AppendThreadItemsRequest, ArchiveThreadRequest, ContinueThreadTurnRequest, CreateThreadRequest,
    DeleteThreadRequest, ForkThreadRequest, InterruptThreadRequest, ListThreadsRequest,
    ReadThreadRequest, RestoreThreadCheckpointRequest, ResumeThreadRequest, SearchThreadsRequest,
    StartThreadTurnRequest, ThreadActivityRequest, ThreadAgentRegistryEntry,
    ThreadAgentRegistryRequest, ThreadApplyOpRequest, ThreadEventsRequest, ThreadIdParams,
    ThreadOp, ThreadPersistenceRepairRequest, UpdateThreadMetadataRequest, WorkerThreadRpc,
};
use crate::threads::rollout::store::{ThreadLogIndexRepairRequest, WorkerThreadLogRpc};
use crate::threads::session::{AgentRunRecord, AgentRunSummary, SessionMetadata};
use crate::tools::executor::{
    tool_not_found_error, tool_unavailable_error, ToolExecutorExecuteRequest,
    ToolExecutorExecuteResult,
};
use crate::tools::permissions::{
    PermissionDecision, PermissionEvaluateToolRequest, PermissionNetworkMode,
    PermissionRequestToolApprovalRequest, PermissionResolveToolApprovalRequest, ShellSandboxMode,
    WorkerPermissionProfileRpc,
};
use crate::tools::registry::{
    ToolExecutionTarget, ToolExposure, ToolRegistrySearchRequest, WorkerToolRegistryRpc,
};
use crate::tools::shell::{
    ShellExecuteParams, ShellProcessIdParams, ShellProcessInputParams, ShellProcessListParams,
    ShellProcessPollParams, ShellProcessResizeParams, ShellStartParams, WorkerShellRpc,
    WorkerShellRuntime,
};
use crate::transport::stdio_worker::diagnostics::WorkerDiagnosticsRpc;
use crate::workspace::{WorkerWorkspaceRpc, WorkspaceReadFormat, WorkspaceReadOptions};
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
mod mcp;
mod memory_dispatch;
mod method;
mod persistence_facade;
mod runtime;
mod runtime_dispatch;
mod subagent_dispatch;
mod thread_dispatch;
mod tool_dispatch;
mod workspace_dispatch;

use self::approval::{
    mcp_tool_approval, shell_execute_approval, shell_start_approval,
    workspace_apply_patch_approval, workspace_delete_approval, workspace_write_approval,
    WorkerApprovalRpc,
};
use self::channel::WorkerChannelConnectorRpc;
use self::errors::unknown_method_error;
use self::form::WorkerFormRpc;
use self::mcp::WorkerMcpRpc;
use self::method::classify_method;
#[cfg(test)]
pub use self::runtime::RuntimeRestartRequest;
use self::runtime::WorkerRuntimeRpc;
use crate::protocol::params::parse_params;

#[derive(Clone, Debug)]
pub struct WorkerRpcRouter {
    workspace: WorkerWorkspaceRpc,
    config: WorkerConfigRpc,
    secret: WorkerSecretRpc,
    diagnostics: WorkerDiagnosticsRpc,
    shell: WorkerShellRpc,
    approval: WorkerApprovalRpc,
    form: WorkerFormRpc,
    memory: WorkerMemoryRpc,
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
    #[cfg(test)]
    pub fn new(
        workspace_root: PathBuf,
        config_snapshot: Value,
        _sessions: Vec<SessionMetadata>,
        diagnostic_capacity: usize,
        policy: CapabilityPolicy,
    ) -> Self {
        Self {
            workspace: WorkerWorkspaceRpc::new(workspace_root.clone(), policy.clone()),
            config: WorkerConfigRpc::new(config_snapshot.clone(), policy.clone()),
            secret: WorkerSecretRpc::new(config_snapshot.clone(), policy.clone()),
            diagnostics: WorkerDiagnosticsRpc::new(diagnostic_capacity, policy.clone()),
            shell: WorkerShellRpc::new(workspace_root.clone(), policy.clone()),
            approval: WorkerApprovalRpc::new(policy.clone()),
            form: WorkerFormRpc::new(policy.clone()),
            memory: WorkerMemoryRpc::new(workspace_root.clone(), policy.clone()),
            task: WorkerTaskRpc::new(workspace_root.clone(), policy.clone()),
            cron: WorkerCronRpc::new(workspace_root.clone(), policy.clone()),
            background: WorkerBackgroundRpc::new(workspace_root.clone(), policy.clone()),
            channel_connector: WorkerChannelConnectorRpc::new(policy.clone()),
            tool_registry: WorkerToolRegistryRpc::new_with_config(
                policy.clone(),
                config_snapshot.clone(),
            ),
            mcp: WorkerMcpRpc::new(
                workspace_root.clone(),
                config_snapshot,
                policy.clone(),
                McpRuntime::new(),
            ),
            runtime: WorkerRuntimeRpc::new(),
            thread: WorkerThreadRpc::new(workspace_root.clone(), policy.clone()),
            thread_log: WorkerThreadLogRpc::new(workspace_root, policy.clone()),
            permission_profile: WorkerPermissionProfileRpc::new(policy),
            subagents: None,
            config_store: None,
        }
    }

    pub fn new_persistent_sessions(
        workspace_root: PathBuf,
        config_snapshot: Value,
        _sessions: Vec<SessionMetadata>,
        diagnostic_capacity: usize,
        policy: CapabilityPolicy,
    ) -> Result<Self, crate::protocol::WorkerProtocolError> {
        let thread_log = WorkerThreadLogRpc::new(workspace_root.clone(), policy.clone());
        Ok(Self {
            workspace: WorkerWorkspaceRpc::new(workspace_root.clone(), policy.clone()),
            config: WorkerConfigRpc::new(config_snapshot.clone(), policy.clone()),
            secret: WorkerSecretRpc::new(config_snapshot.clone(), policy.clone()),
            diagnostics: WorkerDiagnosticsRpc::new(diagnostic_capacity, policy.clone()),
            shell: WorkerShellRpc::new(workspace_root.clone(), policy.clone()),
            approval: WorkerApprovalRpc::new(policy.clone()),
            form: WorkerFormRpc::new(policy.clone()),
            memory: WorkerMemoryRpc::new(workspace_root.clone(), policy.clone()),
            task: WorkerTaskRpc::new(workspace_root.clone(), policy.clone()),
            cron: WorkerCronRpc::new(workspace_root.clone(), policy.clone()),
            background: WorkerBackgroundRpc::new(workspace_root.clone(), policy.clone()),
            channel_connector: WorkerChannelConnectorRpc::new(policy.clone()),
            tool_registry: WorkerToolRegistryRpc::new_with_config(
                policy.clone(),
                config_snapshot.clone(),
            ),
            mcp: WorkerMcpRpc::new(
                workspace_root.clone(),
                config_snapshot,
                policy.clone(),
                McpRuntime::new(),
            ),
            runtime: WorkerRuntimeRpc::new(),
            thread: WorkerThreadRpc::new(workspace_root.clone(), policy.clone()),
            thread_log,
            permission_profile: WorkerPermissionProfileRpc::new(policy),
            subagents: None,
            config_store: None,
        })
    }

    #[cfg(test)]
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

    #[cfg(test)]
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

    pub fn with_shell_runtime(mut self, runtime: WorkerShellRuntime) -> Self {
        self.shell = self.shell.use_runtime(runtime);
        self
    }

    pub fn dispatch(&mut self, request: &WorkerRequest) -> WorkerResponse {
        if let Err(error) = crate::protocol::params::validate_request(request) {
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
    ) -> Result<Value, crate::protocol::WorkerProtocolError> {
        let _namespace = classify_method(&request.method);
        match request.method.as_str() {
            method if method.starts_with("workspace.") || method.starts_with("skills.") => {
                self.dispatch_workspace_method(request)
            }
            method if method.starts_with("config.") || method == "provider.resolve_secret" => {
                self.dispatch_config_method(request)
            }
            method if method.starts_with("session.") || method.starts_with("rollout.") => {
                self.dispatch_session_persistence(request)
            }
            method if method.starts_with("thread.") => self.dispatch_thread_method(request),
            method if method.starts_with("agent_run.") => {
                self.dispatch_agent_run_persistence(request)
            }
            method
                if method == "diagnostics.append"
                    || method.starts_with("channel.connector.")
                    || method.starts_with("shell.")
                    || method.starts_with("approval.")
                    || method == "form.request" =>
            {
                self.dispatch_interaction_method(request)
            }
            method if method.starts_with("memory.") => self.dispatch_memory_method(request),
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
                    || method == "tools.webui_catalog"
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

    fn request_tool_approval(
        &mut self,
        request: &WorkerRequest,
        params: PermissionRequestToolApprovalRequest,
    ) -> Result<Value, crate::protocol::WorkerProtocolError> {
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
        )?;

        if evaluation.decision == PermissionDecision::NeedsApproval {
            if let Some(sandbox_mode) = evaluation.effects.sandbox_mode {
                self.shell.validate_security_request(
                    sandbox_mode,
                    evaluation.effects.network.mode,
                    evaluation.effects.process.interactive,
                )?;
            }
        }

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
                "summary": approval_request.summary,
                "scope": approval_request.scope,
                "lifetime": approval_request.lifetime,
                "effects": approval_request.effects
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
    ) -> Result<Value, crate::protocol::WorkerProtocolError> {
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
    ) -> Result<Value, crate::protocol::WorkerProtocolError> {
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
        )?;
        if permission.requires_approval
            && !request.is_trusted_internal()
            && !registered_tool_has_final_approval_boundary(&tool)
        {
            return Err(WorkerProtocolError::new(
                WorkerProtocolErrorCode::CapabilityDenied,
                "approval-required tools must be dispatched through a trusted approved runtime path",
                serde_json::json!({
                    "boundary": "security",
                    "method": "tool_executor.execute",
                    "toolId": tool.tool_id,
                    "approval": permission.approval_request.clone(),
                }),
                false,
                WorkerProtocolErrorSource::RustCore,
            ));
        }

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
        let mut tool_request = WorkerRequest::new(
            request.id.clone(),
            request.trace_id.clone(),
            target_method,
            tool_arguments,
        )
        .with_cancellation(request.cancellation());
        if request.is_trusted_internal() {
            tool_request = tool_request.with_trusted_internal();
        }
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
    ) -> Result<Vec<Value>, crate::protocol::WorkerProtocolError> {
        let result = self.thread.apply_op(ThreadApplyOpRequest {
            thread_id: thread_id.to_string(),
            client_event_id: Some(client_event_id),
            op,
        })?;
        self.persist_thread_runtime_result(&result)?;
        result
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
        if let Some(session_id) = params
            .session_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            object.remove("session_id");
            object.insert(
                "sessionId".to_string(),
                Value::String(session_id.to_string()),
            );
        }
        if !object.contains_key("parentRunId") {
            if let Some(run_id) = params
                .run_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                object.remove("run_id");
                object.insert("runId".to_string(), Value::String(run_id.to_string()));
            }
        }
        if let Some(tool_call_id) = params
            .tool_call_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            object.remove("tool_call_id");
            object.insert(
                "toolCallId".to_string(),
                Value::String(tool_call_id.to_string()),
            );
        }
    }
    arguments
}

fn registered_tool_has_final_approval_boundary(
    tool: &crate::tools::registry::ToolRegistryEntry,
) -> bool {
    matches!(
        &tool.execution_target,
        ToolExecutionTarget::WorkerRpc { method }
            if matches!(
                method.as_str(),
                "workspace.write_file"
                    | "workspace.apply_patch"
                    | "workspace.delete_file"
                    | "shell.execute"
                    | "shell.start"
            )
    )
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
struct ListDirPageParams {
    path: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default, alias = "nameQuery")]
    name_query: Option<String>,
}

#[derive(Deserialize)]
struct ReadFileChunkParams {
    path: String,
    #[serde(default)]
    cursor: Option<String>,
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
struct ApplyPatchParams {
    patch: String,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
}

#[derive(Deserialize)]
struct McpCallApprovalParams {
    server: String,
    tool: String,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
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
    #[serde(default, alias = "sandboxMode")]
    sandbox_mode: Option<ShellSandboxMode>,
    #[serde(default, alias = "networkMode")]
    network_mode: Option<PermissionNetworkMode>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
}

#[derive(Deserialize)]
struct ShellStartRequestParams {
    command: String,
    #[serde(default, alias = "workingDir")]
    working_dir: Option<String>,
    #[serde(default, alias = "restrictToWorkspace")]
    restrict_to_workspace: Option<bool>,
    #[serde(default)]
    tty: Option<bool>,
    #[serde(default, alias = "yieldTimeMs")]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default, alias = "sandboxMode")]
    sandbox_mode: Option<ShellSandboxMode>,
    #[serde(default, alias = "networkMode")]
    network_mode: Option<PermissionNetworkMode>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
    #[serde(default, alias = "runId")]
    run_id: Option<String>,
    #[serde(default, alias = "toolCallId")]
    tool_call_id: Option<String>,
}

impl ShellStartRequestParams {
    fn into_shell_params(
        self,
        cancellation: Option<std::sync::Arc<dyn crate::protocol::WorkerRequestCancellation>>,
        config_snapshot: &Value,
    ) -> ShellStartParams {
        ShellStartParams {
            command: self.command,
            working_dir: self.working_dir,
            restrict_to_workspace: self.restrict_to_workspace.or_else(|| {
                configured_bool(config_snapshot, "/tools/restrictToWorkspace")
                    .or_else(|| configured_bool(config_snapshot, "/tools/restrict_to_workspace"))
            }),
            tty: self.tty,
            yield_time_ms: self.yield_time_ms,
            rows: self.rows,
            cols: self.cols,
            sandbox_mode: self.sandbox_mode,
            network_mode: self.network_mode,
            run_id: self.run_id,
            tool_call_id: self.tool_call_id,
            cancellation,
        }
    }
}

#[derive(Deserialize)]
struct ShellRunParams {
    #[serde(alias = "runId")]
    run_id: String,
}

impl ShellExecuteRequestParams {
    fn into_shell_params(
        self,
        cancellation: Option<std::sync::Arc<dyn crate::protocol::WorkerRequestCancellation>>,
        config_snapshot: &Value,
    ) -> ShellExecuteParams {
        ShellExecuteParams {
            command: self.command,
            working_dir: self.working_dir,
            timeout: self.timeout.or_else(|| {
                config_snapshot
                    .pointer("/tools/exec/timeout")
                    .and_then(Value::as_u64)
            }),
            restrict_to_workspace: self.restrict_to_workspace.or_else(|| {
                configured_bool(config_snapshot, "/tools/restrictToWorkspace")
                    .or_else(|| configured_bool(config_snapshot, "/tools/restrict_to_workspace"))
            }),
            sandbox_mode: self.sandbox_mode,
            network_mode: self.network_mode,
            cancellation,
        }
    }
}

fn configured_bool(config_snapshot: &Value, pointer: &str) -> Option<bool> {
    config_snapshot.pointer(pointer).and_then(Value::as_bool)
}

#[derive(Deserialize)]
struct SessionIdParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRollbackParams {
    #[serde(alias = "thread_id", alias = "session_id")]
    thread_id: String,
    #[serde(alias = "num_turns")]
    num_turns: u32,
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

#[derive(Deserialize)]
struct SessionCommitContextCheckpointParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    checkpoint: Value,
}

impl SessionPersistTurnParams {
    fn context_metadata(&self) -> Option<Value> {
        self.context_metadata
            .clone()
            .or_else(|| self.context_metadata_camel.clone())
    }
}

#[derive(Deserialize)]
struct AgentRunStartParams {
    record: AgentRunRecord,
    #[serde(default)]
    context: Option<crate::threads::rollout::format::TurnContextItem>,
    #[serde(default)]
    messages: Vec<crate::threads::rollout::format::ResponseItem>,
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
struct AgentRunAppendSemanticBatchParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    events: Vec<Value>,
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
    #[serde(default, alias = "contextCheckpoint")]
    context_checkpoint: Option<Value>,
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
    #[serde(default, alias = "contextCheckpoint")]
    context_checkpoint: Option<Value>,
}

#[derive(Deserialize)]
struct AgentRunMarkInterruptedParams {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "runId")]
    run_id: String,
    reason: String,
}

#[derive(Deserialize)]
struct DiagnosticsAppendParams {
    stream: String,
    line: String,
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

fn serialization_error(error: serde_json::Error) -> crate::protocol::WorkerProtocolError {
    crate::protocol::WorkerProtocolError::new(
        crate::protocol::WorkerProtocolErrorCode::WorkerError,
        "failed to serialize worker RPC result",
        serde_json::json!({ "error": error.to_string() }),
        false,
        crate::protocol::WorkerProtocolErrorSource::RustCore,
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

fn unavailable_subagent_manager() -> crate::protocol::WorkerProtocolError {
    crate::protocol::WorkerProtocolError::new(
        crate::protocol::WorkerProtocolErrorCode::WorkerError,
        "subagent thread manager is unavailable",
        serde_json::json!({ "methodGroup": "subagent" }),
        false,
        crate::protocol::WorkerProtocolErrorSource::RustCore,
    )
}

pub(crate) fn call_rust_state_service(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    label: &str,
) -> Result<serde_json::Value, String> {
    let mut router = native_request_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{label} failed: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{label} failed: missing response result"))
}

pub(crate) fn call_rust_state_service_with_mcp_runtime(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    mcp_runtime: McpRuntime,
    shell_runtime: WorkerShellRuntime,
    subagent_manager: SubagentThreadManager,
    request: WorkerRequest,
    label: &str,
) -> Result<serde_json::Value, String> {
    let mut router = native_request_router(workspace_root, config_snapshot)
        .with_mcp_runtime(mcp_runtime)
        .with_shell_runtime(shell_runtime)
        .with_subagent_manager(subagent_manager);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{label} failed: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{label} failed: missing response result"))
}

pub(crate) fn native_request_router(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> WorkerRpcRouter {
    WorkerRpcRouter::new_persistent_sessions(
        workspace_root,
        config_snapshot,
        vec![],
        200,
        crate::protocol::capability::default_desktop_capability_policy(),
    )
    .expect("persistent session store should initialize")
    .with_builtin_skills_root(crate::config::application::repo_root())
}

#[cfg(test)]
mod tests;
