use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    time::{SystemTime, UNIX_EPOCH},
};

use super::protocol::parse_params;

#[derive(Clone, Debug)]
pub(super) struct WorkerApprovalRpc {
    policy: CapabilityPolicy,
    pending: HashMap<String, ApprovalRecord>,
    approved_once: Vec<ApprovalGrant>,
    approved_session: Vec<ApprovalGrant>,
    approved_current_run: Vec<ApprovalRunGrant>,
    denied: Vec<Value>,
}

impl WorkerApprovalRpc {
    pub(super) fn new(policy: CapabilityPolicy) -> Self {
        Self {
            policy,
            pending: HashMap::new(),
            approved_once: Vec::new(),
            approved_session: Vec::new(),
            approved_current_run: Vec::new(),
            denied: Vec::new(),
        }
    }

    pub(super) fn request_from_request(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.request(parse_params(request)?)
    }

    pub(super) fn resolve_from_request(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.resolve(parse_params(request)?)
    }

    pub(super) fn list_pending_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        let params: ApprovalListPendingParams = parse_params(request)?;
        self.list_pending(&params.session_id)
    }

    fn request(&mut self, params: ApprovalRequestParams) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalRequest)?;
        let record = ApprovalRecord::from_params(params);
        if self.consume_once_approval(&record) {
            self.approved_current_run
                .push(ApprovalRunGrant::from_record(&record));
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

    fn resolve(&mut self, params: ApprovalResolveParams) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalResolve)?;
        let scope = params.scope.unwrap_or_else(|| "once".to_string());
        if scope != "once" && scope != "session" {
            return Err(invalid_approval_request("scope must be once or session"));
        }
        let Some(record) = self.pending.get(&params.approval_id).cloned() else {
            return Err(invalid_approval_request("pending approval not found"));
        };
        if !same_session_id(record.session_id.as_deref(), &params.session_id) {
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
                "deniedAt": approval_timestamp(),
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

    fn list_pending(&self, session_id: &str) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::ApprovalResolve)?;
        let mut approvals: Vec<Value> = self
            .pending
            .values()
            .filter(|record| same_session_id(record.session_id.as_deref(), session_id))
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

    pub(super) fn require_sensitive_operation(
        &mut self,
        requirement: SensitiveOperationApproval,
    ) -> Result<(), WorkerProtocolError> {
        let record = requirement.to_record();
        if self.consume_current_run_approval(&record)
            || self.consume_once_approval(&record)
            || self.has_session_approval(&record)
        {
            return Ok(());
        }
        Err(approval_required_error(&requirement))
    }

    fn consume_current_run_approval(&mut self, record: &ApprovalRecord) -> bool {
        let grant = ApprovalRunGrant::from_record(record);
        let Some(index) = self
            .approved_current_run
            .iter()
            .position(|item| item == &grant)
        else {
            return false;
        };
        self.approved_current_run.remove(index);
        true
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

#[derive(Clone, Debug)]
pub(super) struct SensitiveOperationApproval {
    method: &'static str,
    run_id: String,
    session_id: Option<String>,
    operation: Value,
    category: &'static str,
    risk: &'static str,
    reason: &'static str,
    summary: String,
    fingerprint: String,
    session_fingerprint: String,
}

impl SensitiveOperationApproval {
    fn to_record(&self) -> ApprovalRecord {
        ApprovalRecord {
            id: approval_id_for(
                self.session_id.as_deref(),
                &self.run_id,
                &self.fingerprint,
                &self.operation,
            ),
            run_id: self.run_id.clone(),
            session_id: self.session_id.clone(),
            operation: self.operation.clone(),
            category: self.category.to_string(),
            risk: self.risk.to_string(),
            reason: self.reason.to_string(),
            summary: self.summary.clone(),
            fingerprint: self.fingerprint.clone(),
            session_fingerprint: self.session_fingerprint.clone(),
        }
    }
}

pub(super) fn workspace_write_approval(
    path: &str,
    session_id: Option<String>,
    run_id: Option<String>,
    fingerprint: Option<String>,
    session_fingerprint: Option<String>,
) -> SensitiveOperationApproval {
    let normalized_path = normalize_approval_path(path);
    let default_fingerprint = format!("write_file:{normalized_path}");
    SensitiveOperationApproval {
        method: "workspace.write_file",
        run_id: run_id.unwrap_or_else(|| "workspace.write_file".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "write_file",
            "arguments": { "path": path }
        }),
        category: "filesystem_write",
        risk: "medium",
        reason: "Workspace file writes are approval-sensitive security operations.",
        summary: format!("write_file path=\"{path}\""),
        fingerprint: fingerprint.unwrap_or_else(|| default_fingerprint.clone()),
        session_fingerprint: session_fingerprint.unwrap_or(default_fingerprint),
    }
}

pub(super) fn workspace_apply_patch_approval(
    paths: &[String],
    session_id: Option<String>,
    run_id: Option<String>,
    fingerprint: Option<String>,
    session_fingerprint: Option<String>,
) -> SensitiveOperationApproval {
    let normalized_paths = paths
        .iter()
        .map(|path| normalize_approval_path(path))
        .collect::<Vec<_>>();
    let default_fingerprint = format!("apply_patch:{}", normalized_paths.join("|"));
    SensitiveOperationApproval {
        method: "workspace.apply_patch",
        run_id: run_id.unwrap_or_else(|| "workspace.apply_patch".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "apply_patch",
            "arguments": { "paths": paths }
        }),
        category: "filesystem_write",
        risk: "medium",
        reason: "Workspace patches are approval-sensitive security operations.",
        summary: format!("apply_patch paths=[{}]", paths.join(", ")),
        fingerprint: fingerprint.unwrap_or_else(|| default_fingerprint.clone()),
        session_fingerprint: session_fingerprint.unwrap_or(default_fingerprint),
    }
}

pub(super) fn mcp_tool_approval(
    server: &str,
    tool: &str,
    session_id: Option<String>,
    run_id: Option<String>,
    fingerprint: Option<String>,
    session_fingerprint: Option<String>,
) -> SensitiveOperationApproval {
    let server = server.trim();
    let tool = tool.trim();
    let default_fingerprint = format!("mcp:{server}:{tool}");
    SensitiveOperationApproval {
        method: "mcp.call_tool",
        run_id: run_id.unwrap_or_else(|| "mcp.call_tool".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "mcp.call_tool",
            "arguments": { "server": server, "tool": tool }
        }),
        category: "mcp_tool",
        risk: "medium",
        reason: "MCP tool calls require user approval.",
        summary: format!("mcp.call_tool {server}.{tool}"),
        fingerprint: fingerprint.unwrap_or_else(|| default_fingerprint.clone()),
        session_fingerprint: session_fingerprint.unwrap_or(default_fingerprint),
    }
}

pub(super) fn workspace_delete_approval(
    path: &str,
    session_id: Option<String>,
    run_id: Option<String>,
) -> SensitiveOperationApproval {
    let normalized_path = normalize_approval_path(path);
    SensitiveOperationApproval {
        method: "workspace.delete_file",
        run_id: run_id.unwrap_or_else(|| "workspace.delete_file".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "delete_file",
            "arguments": { "path": path }
        }),
        category: "filesystem_write",
        risk: "medium",
        reason: "Workspace file deletion is an approval-sensitive security operation.",
        summary: format!("delete_file path=\"{path}\""),
        fingerprint: format!("delete_file:{normalized_path}"),
        session_fingerprint: format!("delete_file:{normalized_path}"),
    }
}

pub(super) fn shell_execute_approval(
    command: &str,
    session_id: Option<String>,
    run_id: Option<String>,
) -> SensitiveOperationApproval {
    let normalized_command = normalize_approval_command(command).to_ascii_lowercase();
    SensitiveOperationApproval {
        method: "shell.execute",
        run_id: run_id.unwrap_or_else(|| "shell.execute".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "exec",
            "arguments": { "command": command }
        }),
        category: "shell",
        risk: "high",
        reason: "Shell execution is an approval-sensitive security operation.",
        summary: format!("exec command=\"{}\"", normalize_approval_command(command)),
        fingerprint: format!("exec:{normalized_command}"),
        session_fingerprint: format!("exec:{normalized_command}"),
    }
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
struct ApprovalListPendingParams {
    session_id: String,
}

#[derive(Deserialize)]
struct ApprovalClassificationParams {
    category: String,
    risk: String,
    reason: String,
}

fn approval_required_error(requirement: &SensitiveOperationApproval) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::CapabilityDenied,
        "approval required for sensitive operation",
        serde_json::json!({
            "method": requirement.method,
            "boundary": "security",
            "category": requirement.category,
            "risk": requirement.risk,
            "reason": requirement.reason,
            "summary": requirement.summary,
            "fingerprint": requirement.fingerprint,
            "sessionFingerprint": requirement.session_fingerprint,
            "sessionId": requirement.session_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn invalid_approval_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "approval.resolve" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn normalize_approval_path(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

fn normalize_approval_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ApprovalGrant {
    session_id: Option<String>,
    fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ApprovalRunGrant {
    run_id: String,
    session_id: Option<String>,
    fingerprint: String,
}

impl ApprovalRunGrant {
    fn from_record(record: &ApprovalRecord) -> Self {
        Self {
            run_id: record.run_id.clone(),
            session_id: canonical_session_id_option(record.session_id.as_deref()),
            fingerprint: record.fingerprint.clone(),
        }
    }
}

impl ApprovalGrant {
    fn once(record: &ApprovalRecord) -> Self {
        Self {
            session_id: canonical_session_id_option(record.session_id.as_deref()),
            fingerprint: record.fingerprint.clone(),
        }
    }

    fn session(record: &ApprovalRecord) -> Self {
        Self {
            session_id: canonical_session_id_option(record.session_id.as_deref()),
            fingerprint: record.session_fingerprint.clone(),
        }
    }
}

fn same_session_id(left: Option<&str>, right: &str) -> bool {
    left.map(canonical_session_id).as_deref() == Some(canonical_session_id(right).as_str())
}

fn canonical_session_id_option(value: Option<&str>) -> Option<String> {
    value.map(canonical_session_id)
}

fn canonical_session_id(value: &str) -> String {
    let Some((channel, id)) = value.split_once(':') else {
        return value.to_string();
    };
    if channel.eq_ignore_ascii_case("websocket") {
        format!("websocket:{id}")
    } else {
        value.to_string()
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

fn approval_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("unix-ms:{millis} local")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn approval_rpc() -> WorkerApprovalRpc {
        WorkerApprovalRpc::new(CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
        ]))
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
    fn approval_request_returns_pending_record() {
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
        });
        let mut approval =
            WorkerApprovalRpc::new(CapabilityPolicy::new([WorkerCapability::ApprovalRequest]));
        let request = approval_request(
            "req-1",
            "run-1",
            "session-1",
            operation.clone(),
            "write_file:notes/today.md",
            "write_file:notes/today.md",
        );

        let result = approval
            .request_from_request(&request)
            .expect("approval request should return result");

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
    }

    #[test]
    fn approval_resolve_returns_stored_pending_operation() {
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut approval = approval_rpc();
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "session-1",
                operation.clone(),
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
        let response = approval
            .resolve_from_request(&WorkerRequest::new(
                "req-resolve",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "session-1",
                    "approval_id": approval_id,
                    "approved": true,
                    "scope": "session"
                }),
            ))
            .unwrap();

        assert_eq!(
            response,
            json!({
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
            })
        );
    }

    #[test]
    fn approval_resolve_matches_websocket_session_key_case_insensitively() {
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut approval = approval_rpc();
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "WebSocket:chat-1",
                operation,
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();

        let response = approval
            .resolve_from_request(&WorkerRequest::new(
                "req-resolve",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "websocket:chat-1",
                    "approval_id": approval_id,
                    "approved": true,
                    "scope": "once"
                }),
            ))
            .unwrap();

        assert_eq!(response["status"], "approved");
        assert_eq!(response["sessionId"], "websocket:chat-1");
    }

    #[test]
    fn approval_list_pending_matches_websocket_session_key_case_insensitively() {
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut approval = approval_rpc();
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "WebSocket:chat-1",
                operation,
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();

        let response = approval
            .list_pending_from_request(&WorkerRequest::new(
                "req-list",
                "trace-1",
                "approval.list_pending",
                json!({ "session_id": "websocket:chat-1" }),
            ))
            .unwrap();

        assert_eq!(response["approvals"][0]["id"], approval_id);
    }

    #[test]
    fn approval_session_scope_matches_websocket_session_key_case_insensitively() {
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut approval = approval_rpc();
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "WebSocket:chat-1",
                operation.clone(),
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
        approval
            .resolve_from_request(&WorkerRequest::new(
                "req-resolve",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "websocket:chat-1",
                    "approval_id": approval_id,
                    "approved": true,
                    "scope": "session"
                }),
            ))
            .unwrap();

        let response = approval
            .request_from_request(&approval_request(
                "req-request-again",
                "run-2",
                "websocket:chat-1",
                operation,
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();

        assert_eq!(response["status"], "approved");
        assert_eq!(response["scope"], "session");
    }

    #[test]
    fn approval_list_pending_returns_session_scoped_records() {
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut approval = approval_rpc();
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request-1",
                "run-1",
                "session-1",
                operation.clone(),
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
        approval
            .request_from_request(&approval_request(
                "req-request-2",
                "run-2",
                "session-2",
                operation,
                "write_file:notes/other.md",
                "write_file:notes/other.md",
            ))
            .unwrap();

        let response = approval
            .list_pending_from_request(&WorkerRequest::new(
                "req-list",
                "trace-1",
                "approval.list_pending",
                json!({ "session_id": "session-1" }),
            ))
            .unwrap();

        assert_eq!(
            response,
            json!({
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
            })
        );
    }

    #[test]
    fn approval_resolve_rejects_missing_pending_request() {
        let mut approval =
            WorkerApprovalRpc::new(CapabilityPolicy::new([WorkerCapability::ApprovalResolve]));

        let error = approval
            .resolve_from_request(&WorkerRequest::new(
                "req-1",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "session-1",
                    "approval_id": "approval-1",
                    "approved": true,
                    "scope": "session"
                }),
            ))
            .expect_err("missing pending approval should fail");

        assert_eq!(error.message, "pending approval not found");
    }

    #[test]
    fn approval_once_scope_is_consumed_by_next_matching_request() {
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let mut approval = approval_rpc();
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "session-1",
                operation.clone(),
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
        approval
            .resolve_from_request(&WorkerRequest::new(
                "req-resolve",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "session-1",
                    "approval_id": approval_id,
                    "approved": true,
                    "scope": "once"
                }),
            ))
            .unwrap();

        let allowed = approval
            .request_from_request(&approval_request(
                "req-allowed",
                "run-2",
                "session-1",
                operation.clone(),
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        assert_eq!(allowed["decision"], "allow");
        assert_eq!(allowed["scope"], "once");
        assert_eq!(allowed["operation"], operation);

        let pending_again = approval
            .request_from_request(&approval_request(
                "req-pending-again",
                "run-3",
                "session-1",
                operation,
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        assert_eq!(pending_again["stopReason"], "awaiting_approval");
        assert_eq!(pending_again["awaitingUserInput"], true);
    }

    #[test]
    fn approval_session_scope_allows_matching_session_fingerprint_only_in_same_session() {
        let mut approval = approval_rpc();
        let original_operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "hello" },
            "toolCallId": "call-1"
        });
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "session-1",
                original_operation,
                "write_file:notes/today.md:hello",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
        approval
            .resolve_from_request(&WorkerRequest::new(
                "req-resolve",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "session-1",
                    "approval_id": approval_id,
                    "approved": true,
                    "scope": "session"
                }),
            ))
            .unwrap();

        let changed_operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md", "contents": "changed" },
            "toolCallId": "call-2"
        });
        let allowed = approval
            .request_from_request(&approval_request(
                "req-allowed",
                "run-2",
                "session-1",
                changed_operation.clone(),
                "write_file:notes/today.md:changed",
                "write_file:notes/today.md",
            ))
            .unwrap();
        assert_eq!(allowed["decision"], "allow");
        assert_eq!(allowed["scope"], "session");
        assert_eq!(allowed["operation"], changed_operation);

        let other_session = approval
            .request_from_request(&approval_request(
                "req-other-session",
                "run-3",
                "session-2",
                changed_operation,
                "write_file:notes/today.md:changed",
                "write_file:notes/today.md",
            ))
            .unwrap();
        assert_eq!(other_session["stopReason"], "awaiting_approval");
        assert_eq!(other_session["awaitingUserInput"], true);
    }

    #[test]
    fn sensitive_operation_requires_matching_approval_grant() {
        let mut approval = approval_rpc();
        let requirement = workspace_write_approval(
            "notes/today.md",
            Some("session-1".to_string()),
            Some("run-write".to_string()),
            None,
            None,
        );
        let error = approval
            .require_sensitive_operation(requirement.clone())
            .expect_err("write without approval should fail");
        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["boundary"], "security");

        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "session-1",
                json!({
                    "toolName": "write_file",
                    "arguments": { "path": "notes/today.md" }
                }),
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
        approval
            .resolve_from_request(&WorkerRequest::new(
                "req-resolve",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "session-1",
                    "approval_id": approval_id,
                    "approved": true,
                    "scope": "once"
                }),
            ))
            .unwrap();

        approval
            .require_sensitive_operation(requirement)
            .expect("matching once approval should be consumed");
    }

    #[test]
    fn sensitive_operation_accepts_current_run_after_once_request_allows() {
        let mut approval = approval_rpc();
        let operation = json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md" }
        });
        let request_response = approval
            .request_from_request(&approval_request(
                "req-request",
                "run-1",
                "session-1",
                operation,
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        let approval_id = request_response["approvalId"].as_str().unwrap().to_string();
        approval
            .resolve_from_request(&WorkerRequest::new(
                "req-resolve",
                "trace-1",
                "approval.resolve",
                json!({
                    "session_id": "session-1",
                    "approval_id": approval_id,
                    "approved": true,
                    "scope": "once"
                }),
            ))
            .unwrap();

        let allowed = approval
            .request_from_request(&approval_request(
                "req-allowed",
                "run-1",
                "session-1",
                json!({
                    "toolName": "write_file",
                    "arguments": { "path": "notes/today.md" }
                }),
                "write_file:notes/today.md",
                "write_file:notes/today.md",
            ))
            .unwrap();
        assert_eq!(allowed["decision"], "allow");
        assert_eq!(allowed["scope"], "once");

        approval
            .require_sensitive_operation(workspace_write_approval(
                "notes/today.md",
                Some("session-1".to_string()),
                Some("run-1".to_string()),
                None,
                None,
            ))
            .expect("same-run native operation should use the consumed once approval");

        approval
            .require_sensitive_operation(workspace_write_approval(
                "notes/today.md",
                Some("session-1".to_string()),
                Some("run-1".to_string()),
                None,
                None,
            ))
            .expect_err("same-run once bridge should be consumed");
    }

    #[test]
    fn workspace_write_approval_accepts_original_tool_fingerprints() {
        let requirement = workspace_write_approval(
            "notes/today.md",
            Some("session-1".to_string()),
            Some("run-1".to_string()),
            Some("edit_file:notes/today.md".to_string()),
            Some("edit_file:notes/today.md".to_string()),
        );
        let record = requirement.to_record();

        assert_eq!(record.fingerprint, "edit_file:notes/today.md");
        assert_eq!(record.session_fingerprint, "edit_file:notes/today.md");
    }
}
