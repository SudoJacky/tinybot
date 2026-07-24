use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use crate::tools::permissions::{
    mcp_permission_effects, normalize_permission_effects, normalize_permission_path,
    permission_fingerprint, shell_permission_effects, workspace_patch_permission_effects,
    workspace_write_permission_effects, PermissionEffects, PermissionNetworkMode, ShellSandboxMode,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::protocol::params::parse_params;

#[derive(Clone, Debug)]
pub(super) struct WorkerApprovalRpc {
    policy: CapabilityPolicy,
    pending: HashMap<String, ApprovalRecord>,
    approved_once: Vec<ApprovalGrant>,
    approved_session: Vec<ApprovalGrant>,
    approved_current_turn: Vec<ApprovalTurnGrant>,
    denied: Vec<Value>,
}

impl WorkerApprovalRpc {
    pub(super) fn new(policy: CapabilityPolicy) -> Self {
        Self {
            policy,
            pending: HashMap::new(),
            approved_once: Vec::new(),
            approved_session: Vec::new(),
            approved_current_turn: Vec::new(),
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
        let record = ApprovalRecord::from_params(params)?;
        if self.consume_once_approval(&record) {
            self.approved_current_turn
                .push(ApprovalTurnGrant::from_record(&record));
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
            "turnId": record.turn_id,
            "category": record.category,
            "risk": record.risk,
            "reason": record.reason,
            "summary": record.summary,
            "fingerprint": record.fingerprint,
            "sessionFingerprint": record.session_fingerprint,
        });
        insert_permission_details(
            &mut result,
            "scope",
            record.scope.as_deref(),
            record.lifetime.as_deref(),
            record.effects.as_ref(),
        );
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
        let mut result = serde_json::json!({
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
        });
        insert_permission_details(
            &mut result,
            "permissionScope",
            record.scope.as_deref(),
            record.lifetime.as_deref(),
            record.effects.as_ref(),
        );
        Ok(result)
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
        if self.consume_current_turn_approval(&record)
            || self.consume_once_approval(&record)
            || self.has_session_approval(&record)
        {
            return Ok(());
        }
        Err(approval_required_error(&requirement))
    }

    fn consume_current_turn_approval(&mut self, record: &ApprovalRecord) -> bool {
        let grant = ApprovalTurnGrant::from_record(record);
        let Some(index) = self
            .approved_current_turn
            .iter()
            .position(|item| item == &grant)
        else {
            return false;
        };
        self.approved_current_turn.remove(index);
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
    turn_id: String,
    session_id: Option<String>,
    operation: Value,
    category: &'static str,
    risk: &'static str,
    reason: &'static str,
    summary: String,
    scope: &'static str,
    lifetime: &'static str,
    effects: PermissionEffects,
    fingerprint: String,
    session_fingerprint: String,
}

impl SensitiveOperationApproval {
    fn to_record(&self) -> ApprovalRecord {
        ApprovalRecord {
            id: approval_id_for(
                self.session_id.as_deref(),
                &self.turn_id,
                &self.fingerprint,
                &self.operation,
            ),
            turn_id: self.turn_id.clone(),
            session_id: self.session_id.clone(),
            operation: self.operation.clone(),
            category: self.category.to_string(),
            risk: self.risk.to_string(),
            reason: self.reason.to_string(),
            summary: self.summary.clone(),
            scope: Some(self.scope.to_string()),
            lifetime: Some(self.lifetime.to_string()),
            effects: Some(
                serde_json::to_value(&self.effects).expect("permission effects serialize"),
            ),
            fingerprint: self.fingerprint.clone(),
            session_fingerprint: self.session_fingerprint.clone(),
        }
    }
}

pub(super) fn workspace_write_approval(
    path: &str,
    session_id: Option<String>,
    turn_id: Option<String>,
) -> SensitiveOperationApproval {
    let normalized_path = normalize_approval_path(path);
    let effects = workspace_write_permission_effects(path);
    let fingerprint = permission_fingerprint("write_file", &normalized_path, &effects);
    SensitiveOperationApproval {
        method: "workspace.write_file",
        turn_id: turn_id.unwrap_or_else(|| "workspace.write_file".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "write_file",
            "arguments": { "path": path },
            "effects": &effects,
        }),
        category: "filesystem_write",
        risk: "medium",
        reason: "Workspace file writes are approval-sensitive security operations.",
        summary: format!("write_file path=\"{path}\""),
        scope: "file",
        lifetime: "per_request",
        effects,
        fingerprint: fingerprint.clone(),
        session_fingerprint: fingerprint,
    }
}

pub(super) fn workspace_apply_patch_approval(
    patch: &str,
    paths: &[String],
    session_id: Option<String>,
    turn_id: Option<String>,
) -> SensitiveOperationApproval {
    let effects = workspace_patch_permission_effects();
    let fingerprint = permission_fingerprint("apply_patch", patch, &effects);
    SensitiveOperationApproval {
        method: "workspace.apply_patch",
        turn_id: turn_id.unwrap_or_else(|| "workspace.apply_patch".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "apply_patch",
            "arguments": { "paths": paths },
            "effects": &effects,
        }),
        category: "filesystem_write",
        risk: "medium",
        reason: "Workspace patches are approval-sensitive security operations.",
        summary: format!("apply_patch paths=[{}]", paths.join(", ")),
        scope: "file",
        lifetime: "per_request",
        effects,
        fingerprint: fingerprint.clone(),
        session_fingerprint: fingerprint,
    }
}

pub(super) fn mcp_tool_approval(
    server: &str,
    tool: &str,
    session_id: Option<String>,
    turn_id: Option<String>,
) -> SensitiveOperationApproval {
    let server = server.trim();
    let tool = tool.trim();
    let effects = mcp_permission_effects(server, tool);
    let fingerprint = permission_fingerprint("mcp", &format!("{server}.{tool}"), &effects);
    SensitiveOperationApproval {
        method: "mcp.call_tool",
        turn_id: turn_id.unwrap_or_else(|| "mcp.call_tool".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "mcp.call_tool",
            "arguments": { "server": server, "tool": tool },
            "effects": &effects,
        }),
        category: "mcp_tool",
        risk: "medium",
        reason: "MCP tool calls require user approval.",
        summary: format!("mcp.call_tool {server}.{tool}"),
        scope: "mcp_tool",
        lifetime: "per_request",
        effects,
        fingerprint: fingerprint.clone(),
        session_fingerprint: fingerprint,
    }
}

pub(super) fn workspace_delete_approval(
    path: &str,
    session_id: Option<String>,
    turn_id: Option<String>,
) -> SensitiveOperationApproval {
    let normalized_path = normalize_approval_path(path);
    let effects = workspace_write_permission_effects(path);
    let fingerprint = permission_fingerprint("delete_file", &normalized_path, &effects);
    SensitiveOperationApproval {
        method: "workspace.delete_file",
        turn_id: turn_id.unwrap_or_else(|| "workspace.delete_file".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "delete_file",
            "arguments": { "path": path },
            "effects": &effects,
        }),
        category: "filesystem_write",
        risk: "medium",
        reason: "Workspace file deletion is an approval-sensitive security operation.",
        summary: format!("delete_file path=\"{path}\""),
        scope: "file",
        lifetime: "per_request",
        effects,
        fingerprint: fingerprint.clone(),
        session_fingerprint: fingerprint,
    }
}

pub(super) fn shell_execute_approval(
    command: &str,
    sandbox_mode: ShellSandboxMode,
    network_mode: PermissionNetworkMode,
    session_id: Option<String>,
    turn_id: Option<String>,
) -> SensitiveOperationApproval {
    let effects = shell_permission_effects(sandbox_mode, network_mode, false);
    let fingerprint = permission_fingerprint("exec", command, &effects);
    SensitiveOperationApproval {
        method: "shell.execute",
        turn_id: turn_id.unwrap_or_else(|| "shell.execute".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "exec",
            "arguments": {
                "command": command,
                "sandboxMode": sandbox_mode,
                "networkMode": network_mode,
            },
            "effects": &effects,
        }),
        category: "shell",
        risk: "high",
        reason: "Shell execution is an approval-sensitive security operation.",
        summary: format!("exec command=\"{}\"", normalize_approval_command(command)),
        scope: "command",
        lifetime: "per_request",
        effects,
        fingerprint: fingerprint.clone(),
        session_fingerprint: fingerprint,
    }
}

pub(super) fn shell_start_approval(
    command: &str,
    sandbox_mode: ShellSandboxMode,
    network_mode: PermissionNetworkMode,
    tty: bool,
    session_id: Option<String>,
    turn_id: Option<String>,
) -> SensitiveOperationApproval {
    let effects = shell_permission_effects(sandbox_mode, network_mode, tty);
    let fingerprint = permission_fingerprint("start", command, &effects);
    SensitiveOperationApproval {
        method: "shell.start",
        turn_id: turn_id.unwrap_or_else(|| "shell.start".to_string()),
        session_id,
        operation: serde_json::json!({
            "toolName": "exec_command",
            "arguments": {
                "command": command,
                "sandboxMode": sandbox_mode,
                "networkMode": network_mode,
                "tty": tty,
            },
            "effects": &effects,
        }),
        category: "shell",
        risk: "high",
        reason: "Shell execution is an approval-sensitive security operation.",
        summary: format!("start command=\"{}\"", normalize_approval_command(command)),
        scope: "command",
        lifetime: "per_request",
        effects,
        fingerprint: fingerprint.clone(),
        session_fingerprint: fingerprint,
    }
}

#[derive(Deserialize)]
struct ApprovalRequestParams {
    turn_id: String,
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
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    lifetime: Option<String>,
    #[serde(default)]
    effects: Option<Value>,
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
            "scope": requirement.scope,
            "lifetime": requirement.lifetime,
            "effects": requirement.effects,
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
    normalize_permission_path(path)
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
struct ApprovalTurnGrant {
    turn_id: String,
    session_id: Option<String>,
    fingerprint: String,
}

impl ApprovalTurnGrant {
    fn from_record(record: &ApprovalRecord) -> Self {
        Self {
            turn_id: record.turn_id.clone(),
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
    turn_id: String,
    session_id: Option<String>,
    operation: Value,
    category: String,
    risk: String,
    reason: String,
    summary: String,
    scope: Option<String>,
    lifetime: Option<String>,
    effects: Option<Value>,
    fingerprint: String,
    session_fingerprint: String,
}

impl ApprovalRecord {
    fn from_params(params: ApprovalRequestParams) -> Result<Self, WorkerProtocolError> {
        let mut operation = params.operation;
        let mut category = params
            .classification
            .as_ref()
            .map(|classification| classification.category.clone())
            .or_else(|| json_string_field(&operation, "category"))
            .unwrap_or_else(|| "tool".to_string());
        let mut risk = params
            .classification
            .as_ref()
            .map(|classification| classification.risk.clone())
            .or_else(|| json_string_field(&operation, "risk"))
            .unwrap_or_else(|| "medium".to_string());
        let mut reason = params
            .classification
            .as_ref()
            .map(|classification| classification.reason.clone())
            .or_else(|| json_string_field(&operation, "reason"))
            .unwrap_or_else(|| "This tool requires user approval before execution.".to_string());
        let mut summary = params
            .summary
            .unwrap_or_else(|| approval_operation_summary(&operation));
        let mut scope = params
            .scope
            .or_else(|| json_string_field(&operation, "scope"));
        let mut lifetime = params
            .lifetime
            .or_else(|| json_string_field(&operation, "lifetime"));
        let operation_effects = operation.get("effects").cloned();
        if let (Some(request_effects), Some(operation_effects)) =
            (params.effects.as_ref(), operation_effects.as_ref())
        {
            if request_effects != operation_effects {
                return Err(invalid_approval_submission(
                    "approval effects do not match the presented operation",
                    serde_json::json!({
                        "requestEffects": request_effects,
                        "operationEffects": operation_effects,
                    }),
                ));
            }
        }
        let effects_value = params.effects.or(operation_effects).ok_or_else(|| {
            invalid_approval_submission(
                "approval effects are required",
                serde_json::json!({ "operation": operation }),
            )
        })?;
        let effects: PermissionEffects =
            serde_json::from_value(effects_value).map_err(|error| {
                invalid_approval_submission(
                    "approval effects are invalid",
                    serde_json::json!({ "error": error.to_string() }),
                )
            })?;
        let effects = normalize_permission_effects(effects);
        let effects_value = serde_json::to_value(&effects).map_err(|error| {
            invalid_approval_submission(
                "approval effects could not be normalized",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let operation_object = operation.as_object_mut().ok_or_else(|| {
            invalid_approval_submission(
                "approval operation must be an object",
                serde_json::json!({}),
            )
        })?;
        operation_object.insert("effects".to_string(), effects_value.clone());
        if let Some(presentation) = known_approval_presentation(&operation, &effects)? {
            category = presentation.category.to_string();
            risk = presentation.risk.to_string();
            reason = presentation.reason.to_string();
            summary = presentation.summary;
            scope = Some(presentation.scope.to_string());
            lifetime = Some(presentation.lifetime.to_string());
        }
        let expected_fingerprint =
            fingerprint_for_approval_operation(&operation, &effects, &category)?;
        if let Some(provided) = params.fingerprint.as_deref() {
            if provided != expected_fingerprint {
                return Err(fingerprint_mismatch_error(
                    "fingerprint",
                    provided,
                    &expected_fingerprint,
                ));
            }
        }
        let provided_session_fingerprint = params
            .session_fingerprint
            .or(params.session_fingerprint_camel);
        if let Some(provided) = provided_session_fingerprint.as_deref() {
            if provided != expected_fingerprint {
                return Err(fingerprint_mismatch_error(
                    "sessionFingerprint",
                    provided,
                    &expected_fingerprint,
                ));
            }
        }
        let fingerprint = expected_fingerprint;
        let session_fingerprint = fingerprint.clone();
        let id = approval_id_for(
            params.session_id.as_deref(),
            &params.turn_id,
            &fingerprint,
            &operation,
        );

        Ok(Self {
            id,
            turn_id: params.turn_id,
            session_id: params.session_id,
            operation,
            category,
            risk,
            reason,
            summary,
            scope,
            lifetime,
            effects: Some(effects_value),
            fingerprint,
            session_fingerprint,
        })
    }

    fn to_pending_json(&self) -> Value {
        let mut value = serde_json::json!({
            "id": self.id,
            "turnId": self.turn_id,
            "operation": self.operation,
            "category": self.category,
            "risk": self.risk,
            "reason": self.reason,
            "summary": self.summary,
            "fingerprint": self.fingerprint,
            "sessionFingerprint": self.session_fingerprint,
        });
        insert_permission_details(
            &mut value,
            "scope",
            self.scope.as_deref(),
            self.lifetime.as_deref(),
            self.effects.as_ref(),
        );
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
        "turnId": record.turn_id,
        "category": record.category,
        "risk": record.risk,
        "reason": record.reason,
        "summary": record.summary,
        "fingerprint": record.fingerprint,
        "sessionFingerprint": record.session_fingerprint,
    });
    insert_permission_details(
        &mut result,
        "permissionScope",
        record.scope.as_deref(),
        record.lifetime.as_deref(),
        record.effects.as_ref(),
    );
    if let Some(session_id) = record.session_id.clone() {
        result["sessionId"] = Value::String(session_id);
    }
    result
}

fn approval_id_for(
    session_id: Option<&str>,
    turn_id: &str,
    fingerprint: &str,
    operation: &Value,
) -> String {
    let mut hasher = DefaultHasher::new();
    session_id.unwrap_or("").hash(&mut hasher);
    turn_id.hash(&mut hasher);
    fingerprint.hash(&mut hasher);
    operation.to_string().hash(&mut hasher);
    format!("approval-{:016x}", hasher.finish())
}

fn invalid_approval_submission(message: impl Into<String>, details: Value) -> WorkerProtocolError {
    let mut details = details;
    if let Some(object) = details.as_object_mut() {
        object.insert(
            "method".to_string(),
            Value::String("approval.request".to_string()),
        );
    }
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn fingerprint_for_approval_operation(
    operation: &Value,
    effects: &PermissionEffects,
    category: &str,
) -> Result<String, WorkerProtocolError> {
    let tool_name = json_string_field(operation, "toolName")
        .or_else(|| json_string_field(operation, "tool_name"))
        .ok_or_else(|| {
            invalid_approval_submission(
                "approval operation toolName is required",
                serde_json::json!({}),
            )
        })?;
    let arguments = operation.get("arguments").unwrap_or(&Value::Null);
    let fingerprint = match tool_name.as_str() {
        "shell.execute" | "exec" => permission_fingerprint(
            "exec",
            &required_approval_argument(arguments, "command")?,
            effects,
        ),
        "shell.start" | "exec_command" => permission_fingerprint(
            "start",
            &required_approval_argument(arguments, "command")?,
            effects,
        ),
        "workspace.write_file" | "write_file" => permission_fingerprint(
            "write_file",
            &normalize_approval_path(&required_approval_argument(arguments, "path")?),
            effects,
        ),
        "workspace.apply_patch" | "apply_patch" => permission_fingerprint(
            "apply_patch",
            &required_approval_argument(arguments, "patch")?,
            effects,
        ),
        "workspace.delete_file" | "delete_file" => permission_fingerprint(
            "delete_file",
            &normalize_approval_path(&required_approval_argument(arguments, "path")?),
            effects,
        ),
        "mcp.call_tool" => {
            let server = required_approval_argument(arguments, "server")?;
            let tool = required_approval_argument(arguments, "tool")?;
            permission_fingerprint("mcp", &format!("{server}.{tool}"), effects)
        }
        _ if category == "mcp_tool" && effects.mcp.len() == 1 => {
            permission_fingerprint("mcp", &effects.mcp[0], effects)
        }
        _ => permission_fingerprint(
            &format!("approval:{category}:{tool_name}"),
            &operation.to_string(),
            effects,
        ),
    };
    Ok(fingerprint)
}

struct KnownApprovalPresentation {
    category: &'static str,
    risk: &'static str,
    reason: &'static str,
    summary: String,
    scope: &'static str,
    lifetime: &'static str,
}

fn known_approval_presentation(
    operation: &Value,
    effects: &PermissionEffects,
) -> Result<Option<KnownApprovalPresentation>, WorkerProtocolError> {
    let Some(tool_name) = json_string_field(operation, "toolName")
        .or_else(|| json_string_field(operation, "tool_name"))
    else {
        return Ok(None);
    };
    let arguments = operation.get("arguments").unwrap_or(&Value::Null);
    let presentation = match tool_name.as_str() {
        "shell.execute" | "exec" => KnownApprovalPresentation {
            category: "shell",
            risk: "high",
            reason: "Shell execution requires user approval.",
            summary: format!(
                "exec command=\"{}\"",
                normalize_approval_command(&required_approval_argument(arguments, "command")?)
            ),
            scope: "command",
            lifetime: "per_request",
        },
        "shell.start" | "exec_command" => KnownApprovalPresentation {
            category: "shell",
            risk: "high",
            reason: "Shell execution requires user approval.",
            summary: format!(
                "start command=\"{}\"",
                normalize_approval_command(&required_approval_argument(arguments, "command")?)
            ),
            scope: "command",
            lifetime: "per_request",
        },
        "workspace.write_file" | "write_file" => KnownApprovalPresentation {
            category: "filesystem_write",
            risk: "medium",
            reason: "Workspace file changes require user approval.",
            summary: format!(
                "write_file path=\"{}\"",
                required_approval_argument(arguments, "path")?
            ),
            scope: "file",
            lifetime: "per_request",
        },
        "workspace.apply_patch" | "apply_patch" => KnownApprovalPresentation {
            category: "filesystem_write",
            risk: "medium",
            reason: "Workspace file changes require user approval.",
            summary: "apply_patch workspace files".to_string(),
            scope: "file",
            lifetime: "per_request",
        },
        "workspace.delete_file" | "delete_file" => KnownApprovalPresentation {
            category: "filesystem_write",
            risk: "medium",
            reason: "Workspace file changes require user approval.",
            summary: format!(
                "delete_file path=\"{}\"",
                required_approval_argument(arguments, "path")?
            ),
            scope: "file",
            lifetime: "per_request",
        },
        "mcp.call_tool" => KnownApprovalPresentation {
            category: "mcp_tool",
            risk: "medium",
            reason: "MCP tool calls require user approval.",
            summary: format!(
                "mcp.call_tool {}.{}",
                required_approval_argument(arguments, "server")?,
                required_approval_argument(arguments, "tool")?
            ),
            scope: "mcp_tool",
            lifetime: "per_request",
        },
        _ if effects.mcp.len() == 1 => KnownApprovalPresentation {
            category: "mcp_tool",
            risk: "medium",
            reason: "MCP tool calls require user approval.",
            summary: format!("mcp.call_tool {}", effects.mcp[0]),
            scope: "mcp_tool",
            lifetime: "per_request",
        },
        _ => return Ok(None),
    };
    Ok(Some(presentation))
}

fn required_approval_argument(
    arguments: &Value,
    field: &str,
) -> Result<String, WorkerProtocolError> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            invalid_approval_submission(
                format!("approval operation argument {field} is required"),
                serde_json::json!({ "field": field }),
            )
        })
}

fn fingerprint_mismatch_error(field: &str, provided: &str, expected: &str) -> WorkerProtocolError {
    invalid_approval_submission(
        format!("approval {field} does not match normalized operation effects"),
        serde_json::json!({
            "field": field,
            "provided": provided,
            "expected": expected,
        }),
    )
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
    format!("{tool_name}({operation})")
}

fn json_string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn insert_permission_details(
    value: &mut Value,
    scope_field: &str,
    scope: Option<&str>,
    lifetime: Option<&str>,
    effects: Option<&Value>,
) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if let Some(scope) = scope {
        object.insert(scope_field.to_string(), Value::String(scope.to_string()));
    }
    if let Some(lifetime) = lifetime {
        object.insert("lifetime".to_string(), Value::String(lifetime.to_string()));
    }
    if let Some(effects) = effects {
        object.insert("effects".to_string(), effects.clone());
    }
}

fn approval_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("unix-ms:{millis} local")
}

#[cfg(test)]
#[path = "approval_tests.rs"]
mod tests;
