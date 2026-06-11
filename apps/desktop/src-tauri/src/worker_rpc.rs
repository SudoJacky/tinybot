use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_config::WorkerConfigRpc;
use crate::worker_diagnostics::WorkerDiagnosticsRpc;
use crate::worker_protocol::{validate_protocol_version, WorkerRequest, WorkerResponse};
use crate::worker_secret::{ProviderResolveSecretParams, WorkerSecretRpc};
use crate::worker_session::{SessionMetadata, WorkerSessionRpc};
use crate::worker_workspace::WorkerWorkspaceRpc;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct WorkerRpcRouter {
    workspace: WorkerWorkspaceRpc,
    config: WorkerConfigRpc,
    secret: WorkerSecretRpc,
    session: WorkerSessionRpc,
    diagnostics: WorkerDiagnosticsRpc,
    approval: WorkerApprovalRpc,
    form: WorkerFormRpc,
    memory: WorkerMemoryRpc,
    mcp: WorkerMcpRpc,
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
            approval: WorkerApprovalRpc::new(policy.clone()),
            form: WorkerFormRpc::new(policy.clone()),
            memory: WorkerMemoryRpc::new(workspace_root, policy.clone()),
            mcp: WorkerMcpRpc::new(config_snapshot, policy),
        }
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
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.workspace.read_file(&params.path)?)
                    .map_err(serialization_error)
            }
            "workspace.read_bootstrap_files" => {
                let params: BootstrapFilesParams = parse_params(request)?;
                serde_json::to_value(self.workspace.read_bootstrap_files(&params.files)?)
                    .map_err(serialization_error)
            }
            "workspace.write_file" => {
                let params: WriteFileParams = parse_params(request)?;
                serde_json::to_value(self.workspace.write_file(&params.path, &params.contents)?)
                    .map_err(serialization_error)
            }
            "workspace.list_files" => {
                serde_json::to_value(self.workspace.list_files()?).map_err(serialization_error)
            }
            "config.get" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.config.get(&params.path)?).map_err(serialization_error)
            }
            "config.snapshot_public" => {
                serde_json::to_value(self.config.snapshot_public()?).map_err(serialization_error)
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
            "session.append_messages" => {
                let params: SessionAppendMessagesParams = parse_params(request)?;
                serde_json::to_value(
                    self.session
                        .append_messages(&params.session_id, params.messages)?,
                )
                .map_err(serialization_error)
            }
            "diagnostics.append" => {
                let params: DiagnosticsAppendParams = parse_params(request)?;
                serde_json::to_value(self.diagnostics.append(&params.stream, &params.line)?)
                    .map_err(serialization_error)
            }
            "approval.request" => {
                let params: ApprovalRequestParams = parse_params(request)?;
                self.approval.request(params)
            }
            "approval.resolve" => {
                let params: ApprovalResolveParams = parse_params(request)?;
                self.approval.resolve(params)
            }
            "form.request" => {
                let params: FormRequestParams = parse_params(request)?;
                self.form.request(params)
            }
            "memory.search" => {
                let params: MemorySearchParams = parse_params(request)?;
                self.memory.search(params)
            }
            "memory.save" => {
                let params: MemorySaveParams = parse_params(request)?;
                self.memory.save(params)
            }
            "rag.query" => {
                let params: RagQueryParams = parse_params(request)?;
                self.query_rag(params)
            }
            "mcp.call_tool" => {
                let params: McpCallToolParams = parse_params(request)?;
                self.mcp.call_tool(params)
            }
            "runtime.now" => {
                let params: RuntimeNowParams = parse_params(request)?;
                Ok(runtime_now(params.timezone))
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
}

impl WorkerApprovalRpc {
    fn new(policy: CapabilityPolicy) -> Self {
        Self { policy }
    }

    fn request(
        &self,
        params: ApprovalRequestParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalRequest)?;
        let operation = params.operation;
        let approval_id = format!("approval-{}", params.run_id);
        let mut result = serde_json::json!({
            "content": "Waiting for approval.",
            "awaitingUserInput": true,
            "stopReason": "awaiting_approval",
            "approvalId": approval_id,
            "operation": operation,
            "runId": params.run_id,
        });
        if let Some(session_id) = params.session_id {
            result["sessionId"] = Value::String(session_id);
        }
        Ok(result)
    }

    fn resolve(
        &self,
        params: ApprovalResolveParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalResolve)?;
        let scope = params.scope.unwrap_or_else(|| "once".to_string());
        if scope != "once" && scope != "session" {
            return Err(invalid_approval_request("scope must be once or session"));
        }
        Ok(serde_json::json!({
            "approvalId": params.approval_id,
            "approved": params.approved,
            "scope": scope,
            "status": if params.approved { "approved" } else { "denied" },
            "sessionId": params.session_id,
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
}

#[derive(Deserialize)]
struct PathParams {
    path: String,
}

#[derive(Deserialize)]
struct BootstrapFilesParams {
    files: Vec<String>,
}

#[derive(Deserialize)]
struct WriteFileParams {
    path: String,
    contents: String,
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
struct SessionAppendMessagesParams {
    session_id: String,
    messages: Vec<Value>,
}

#[derive(Deserialize)]
struct DiagnosticsAppendParams {
    stream: String,
    line: String,
}

#[derive(Deserialize)]
struct ApprovalRequestParams {
    run_id: String,
    #[serde(default)]
    session_id: Option<String>,
    operation: Value,
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
struct RuntimeNowParams {
    timezone: Option<String>,
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
    use serde_json::json;
    use std::path::PathBuf;

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
        assert_eq!(
            response.result,
            Some(json!({ "path": "notes/today.md", "contents": "hello router" }))
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

        assert_eq!(
            response.result.as_ref().unwrap()["value"]["providers"]["openai"]["api_key"],
            serde_json::Value::Null
        );
        assert!(response.error.is_none());
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

        assert_eq!(
            response.result,
            Some(json!({
                "files": [{ "path": "AGENTS.md", "contents": "agent rules" }],
                "missing": ["TOOLS.md"]
            }))
        );
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
        assert_eq!(response.result.as_ref().unwrap()["timezone"], "Asia/Shanghai");
        assert!(response.result.as_ref().unwrap()["current_time"].as_str().is_some());
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

    #[test]
    fn dispatches_approval_request() {
        let fixture = WorkspaceFixture::new();
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "category": "filesystem_write",
            "risk": "medium",
            "reason": "File write/edit/delete tools can modify workspace state."
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
                "operation": operation
            }),
        );

        let response = router.dispatch(&request);

        assert_eq!(
            response.result,
            Some(json!({
                "content": "Waiting for approval.",
                "awaitingUserInput": true,
                "stopReason": "awaiting_approval",
                "approvalId": "approval-run-1",
                "operation": operation,
                "runId": "run-1",
                "sessionId": "session-1"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_approval_resolve_request() {
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

        assert_eq!(
            response.result,
            Some(json!({
                "approvalId": "approval-1",
                "approved": true,
                "scope": "session",
                "status": "approved",
                "sessionId": "session-1"
            }))
        );
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
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-rpc-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos()
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
