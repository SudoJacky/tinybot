use crate::worker_protocol::WorkerEvent;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeRouteOwner {
    RustOwned,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRouteInventoryEntry {
    pub surface: &'static str,
    pub key: &'static str,
    pub method: Option<&'static str>,
    pub path: &'static str,
    pub owner: NativeRouteOwner,
    pub route_group: &'static str,
    pub reason: &'static str,
    pub replacement_plan: &'static str,
    pub verification_status: &'static str,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRouteOwnerSummary {
    pub rust_owned: usize,
    pub unsupported: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompatibilityFallbackDiagnostic {
    pub surface: String,
    pub route: String,
    pub route_group: String,
    pub reason: String,
}

impl NativeRouteOwnerSummary {
    pub fn from_inventory(entries: &[NativeRouteInventoryEntry]) -> Self {
        let mut summary = Self::default();
        for entry in entries {
            match entry.owner {
                NativeRouteOwner::RustOwned => summary.rust_owned += 1,
                NativeRouteOwner::Unsupported => summary.unsupported += 1,
            }
        }
        summary
    }
}

pub const NATIVE_TAURI_COMMANDS: &[&str] = &[
    "worker_probe_status",
    "worker_run_agent",
    "worker_run_agent_input",
    "worker_cancel_agent",
    "worker_restore_agent_checkpoint",
    "worker_submit_agent_form",
    "worker_resume_agent_approval",
    "worker_background_trace_list",
    "worker_background_trace_get_delegate_trace",
    "worker_background_trace_get_artifact",
    "worker_background_trace_append",
    "worker_task_plan_list",
    "worker_task_plan_get",
    "worker_task_plan_save",
    "worker_task_plan_delete",
    "worker_knowledge_documents",
    "worker_knowledge_add_document",
    "worker_knowledge_document",
    "worker_knowledge_delete_document",
    "worker_knowledge_job",
    "worker_knowledge_rebuild_index",
    "worker_knowledge_stats",
    "worker_knowledge_graph",
    "worker_webui_route",
    "worker_cowork_route",
    "worker_cron_dispatch_due",
    "worker_transport_gateway_frame",
    "worker_transport_websocket_message",
    "worker_transport_dispatch_websocket_message",
    "worker_channel_dispatch_inbound",
    "worker_channel_start",
    "worker_channel_status",
    "worker_channel_stop",
    "worker_channel_login",
    "worker_skills_list",
    "worker_skills_detail",
    "worker_skills_create",
    "worker_skills_update",
    "worker_skills_delete",
    "worker_skills_validate",
    "worker_workspace_files",
    "worker_workspace_file",
    "worker_workspace_put_file",
    "worker_sessions_list",
    "worker_session_messages",
    "worker_session_temporary_files",
    "worker_session_upload_temporary_file",
    "worker_session_clear_temporary_files",
    "worker_session_delete",
    "worker_session_patch",
    "worker_session_clear",
    "worker_session_task_progress",
];

pub fn native_tauri_command_inventory() -> Vec<NativeRouteInventoryEntry> {
    NATIVE_TAURI_COMMANDS
        .iter()
        .map(|command| NativeRouteInventoryEntry {
            surface: "tauri-command",
            key: command,
            method: None,
            path: command,
            owner: tauri_command_owner(command),
            route_group: tauri_command_group(command),
            reason: tauri_command_reason(command),
            replacement_plan: tauri_command_replacement_plan(command),
            verification_status: "covered-by-native-command-contract",
        })
        .collect()
}

pub fn native_webui_route_inventory() -> Vec<NativeRouteInventoryEntry> {
    WEBUI_ROUTE_INVENTORY.to_vec()
}

pub fn native_runtime_component_inventory() -> Vec<NativeRouteInventoryEntry> {
    RUNTIME_COMPONENT_INVENTORY.to_vec()
}

pub fn native_route_owner_summary() -> NativeRouteOwnerSummary {
    let mut entries = native_webui_route_inventory();
    entries.extend(native_tauri_command_inventory());
    entries.extend(native_runtime_component_inventory());
    NativeRouteOwnerSummary::from_inventory(&entries)
}

pub fn webui_route_inventory_entry(method: &str, path: &str) -> Option<NativeRouteInventoryEntry> {
    let method = method.to_ascii_uppercase();
    WEBUI_ROUTE_INVENTORY
        .iter()
        .find(|entry| {
            entry.method == Some(method.as_str()) && webui_inventory_path_matches(entry.path, path)
        })
        .cloned()
}

pub const NATIVE_AGENT_EVENT_NAMES: &[&str] = &[
    "agent.delta",
    "agent.reasoning_delta",
    "agent.tool_call.delta",
    "agent.tool.start",
    "agent.tool.result",
    "agent.usage",
    "agent.checkpoint",
    "agent.awaiting_form",
    "agent.awaiting_approval",
    "agent.memory_reference",
    "agent.task_progress",
    "agent.browser_frame",
    "agent.delegate.started",
    "agent.delegate.running",
    "agent.delegate.message_queued",
    "agent.delegate.awaiting_approval",
    "agent.delegate.tool.approval_required",
    "agent.delegate.tool.completed",
    "agent.delegate.trace.updated",
    "agent.delegate.completed",
    "agent.delegate.failed",
    "agent.delegate.interrupted",
    "agent.delegate.closed",
    "heartbeat.delivery",
    "agent.cancelled",
    "agent.done",
    "agent.error",
    "diagnostics.log",
    "worker.status",
];

pub const NATIVE_AGENT_TOOL_RESULT_PAYLOAD_FIELDS: &[&str] = &[
    "runId",
    "sessionId",
    "iteration",
    "toolCallId",
    "toolName",
    "name",
    "content",
    "envelope",
];

pub const NATIVE_AGENT_CHECKPOINT_FIELDS: &[&str] = &[
    "schemaVersion",
    "runtime",
    "runId",
    "sessionId",
    "phase",
    "iteration",
    "maxIterations",
    "pendingToolCalls",
    "completedToolResults",
    "resumeToken",
    "stopReason",
    "payload",
    "messages",
];

pub const NATIVE_AGENT_RUN_SUMMARY_FIELDS: &[&str] = &[
    "sessionId",
    "runId",
    "status",
    "phase",
    "startedAt",
    "updatedAt",
    "completedAt",
    "stopReason",
    "model",
    "provider",
    "toolsUsed",
    "toolCallCount",
    "hasCheckpoint",
    "finalContentPreview",
    "artifactCount",
];

pub const NATIVE_AGENT_RUN_DETAIL_FIELDS: &[&str] = &[
    "sessionId",
    "runId",
    "status",
    "phase",
    "startedAt",
    "updatedAt",
    "completedAt",
    "stopReason",
    "model",
    "provider",
    "maxIterations",
    "currentIteration",
    "conversationMessageIds",
    "traceMessages",
    "traceEvents",
    "completedToolResults",
    "pendingToolCalls",
    "checkpoint",
    "artifacts",
    "usage",
    "error",
];

pub const NATIVE_AGENT_RUN_CHECKPOINT_FIELDS: &[&str] = &["sessionId", "runId", "checkpoint"];

pub const NATIVE_AGENT_RUN_TRACE_PAGE_FIELDS: &[&str] =
    &["sessionId", "runId", "items", "nextCursor"];

const WEBUI_ROUTE_INVENTORY: &[NativeRouteInventoryEntry] = &[
    rust_webui("health", "GET", "/health", "health", "native health check"),
    rust_webui(
        "bootstrap",
        "GET",
        "/webui/bootstrap",
        "bootstrap",
        "native WebUI bootstrap",
    ),
    rust_webui(
        "refresh_token",
        "POST",
        "/webui/refresh-token",
        "bootstrap",
        "native WebUI bootstrap",
    ),
    rust_webui(
        "get_status",
        "GET",
        "/api/status",
        "status",
        "native runtime status",
    ),
    rust_webui(
        "get_config",
        "GET",
        "/api/config",
        "config",
        "native config store",
    ),
    unsupported_webui(
        "patch_config",
        "PATCH",
        "/api/config",
        "config",
        "config patch is not implemented in the Rust backend",
        "add validated Rust config patch support before enabling",
    ),
    rust_webui(
        "providers",
        "GET",
        "/api/providers",
        "providers",
        "native provider catalog",
    ),
    rust_webui(
        "provider_models",
        "POST",
        "/api/provider-models",
        "providers",
        "native provider model resolution",
    ),
    rust_webui(
        "openai_models",
        "GET",
        "/v1/models",
        "openai",
        "native OpenAI-compatible model list",
    ),
    rust_webui(
        "openai_chat_completions",
        "POST",
        "/v1/chat/completions",
        "openai",
        "native OpenAI-compatible chat completions",
    ),
    rust_webui(
        "get_approvals",
        "GET",
        "/api/approvals",
        "approvals",
        "native approval state",
    ),
    rust_webui(
        "approve_approval",
        "POST",
        "/api/approvals/{approval_id}/approve",
        "approvals",
        "native approval continuation",
    ),
    rust_webui(
        "deny_approval",
        "POST",
        "/api/approvals/{approval_id}/deny",
        "approvals",
        "native approval continuation",
    ),
    rust_webui(
        "submit_agent_ui_form",
        "POST",
        "/api/agent-ui/forms/{form_id}/submit",
        "agent-ui",
        "native Agent UI form continuation",
    ),
    rust_webui(
        "cancel_agent_ui_form",
        "POST",
        "/api/agent-ui/forms/{form_id}/cancel",
        "agent-ui",
        "native Agent UI form continuation",
    ),
    rust_webui(
        "list_sessions",
        "GET",
        "/api/sessions",
        "sessions",
        "native session store",
    ),
    rust_webui(
        "get_messages",
        "GET",
        "/api/sessions/{key}/messages",
        "sessions",
        "native session store",
    ),
    rust_webui(
        "patch_session",
        "PATCH",
        "/api/sessions/{key}",
        "sessions",
        "native session store",
    ),
    rust_webui(
        "delete_session",
        "DELETE",
        "/api/sessions/{key}",
        "sessions",
        "native session store",
    ),
    rust_webui(
        "clear_session",
        "POST",
        "/api/sessions/{key}/clear",
        "sessions",
        "native session store",
    ),
    rust_webui(
        "list_temporary_files",
        "GET",
        "/api/sessions/{key}/temporary-files",
        "sessions",
        "native session temporary files",
    ),
    rust_webui(
        "upload_temporary_file",
        "POST",
        "/api/sessions/{key}/temporary-files",
        "sessions",
        "native session temporary files",
    ),
    rust_webui(
        "clear_temporary_files",
        "DELETE",
        "/api/sessions/{key}/temporary-files",
        "sessions",
        "native session temporary files",
    ),
    rust_webui(
        "get_skills",
        "GET",
        "/api/skills",
        "skills",
        "native skills store",
    ),
    rust_webui(
        "create_skill",
        "POST",
        "/api/skills",
        "skills",
        "native skills store",
    ),
    rust_webui(
        "get_skill_detail",
        "GET",
        "/api/skills/{name}",
        "skills",
        "native skills store",
    ),
    rust_webui(
        "update_skill",
        "PATCH",
        "/api/skills/{name}",
        "skills",
        "native skills store",
    ),
    rust_webui(
        "delete_skill",
        "DELETE",
        "/api/skills/{name}",
        "skills",
        "native skills store",
    ),
    rust_webui(
        "validate_skill",
        "POST",
        "/api/skills/{name}/validate",
        "skills",
        "native skills store",
    ),
    rust_webui(
        "list_workspace_files",
        "GET",
        "/api/workspace/files",
        "workspace",
        "native workspace store",
    ),
    rust_webui(
        "get_workspace_file",
        "GET",
        "/api/workspace/files/{path:.+}",
        "workspace",
        "native workspace store",
    ),
    rust_webui(
        "put_workspace_file",
        "PUT",
        "/api/workspace/files/{path:.+}",
        "workspace",
        "native workspace store",
    ),
    rust_webui(
        "knowledge_list_documents",
        "GET",
        "/v1/knowledge/documents",
        "knowledge",
        "native knowledge store",
    ),
    rust_webui(
        "knowledge_add_document",
        "POST",
        "/v1/knowledge/documents",
        "knowledge",
        "native knowledge store",
    ),
    rust_webui(
        "knowledge_upload_document",
        "POST",
        "/v1/knowledge/documents/upload",
        "knowledge",
        "native knowledge store",
    ),
    rust_webui(
        "knowledge_get_document",
        "GET",
        "/v1/knowledge/documents/{doc_id}",
        "knowledge",
        "native knowledge store",
    ),
    rust_webui(
        "knowledge_delete_document",
        "DELETE",
        "/v1/knowledge/documents/{doc_id}",
        "knowledge",
        "native knowledge store",
    ),
    rust_webui(
        "knowledge_stats",
        "GET",
        "/v1/knowledge/stats",
        "knowledge",
        "native knowledge store",
    ),
    rust_webui(
        "knowledge_job",
        "GET",
        "/v1/knowledge/jobs/{job_id}",
        "knowledge",
        "native knowledge jobs",
    ),
    rust_webui(
        "knowledge_rebuild_index",
        "POST",
        "/v1/knowledge/rebuild-index",
        "knowledge",
        "native knowledge jobs",
    ),
    rust_webui(
        "knowledge_graph",
        "GET",
        "/v1/knowledge/graph",
        "knowledge",
        "native knowledge graph",
    ),
    unsupported_webui(
        "knowledge_query",
        "POST",
        "/v1/knowledge/query",
        "knowledge",
        "advanced query path is not implemented in the Rust backend",
        "add Rust query and GraphRAG execution before enabling",
    ),
    unsupported_webui(
        "knowledge_extract_graph",
        "POST",
        "/v1/knowledge/graph/extract",
        "knowledge",
        "LLM graph extraction orchestration is not implemented in the Rust backend",
        "add Rust graph extraction planner and provider calls before enabling",
    ),
    unsupported_webui(
        "knowledge_graphrag",
        "GET",
        "/v1/knowledge/graphrag",
        "knowledge",
        "GraphRAG read path is not implemented in the Rust backend",
        "add Rust GraphRAG route before enabling",
    ),
    unsupported_webui(
        "cowork_route",
        "GET",
        "/api/cowork/{path:.+}",
        "cowork",
        "unimplemented Cowork routes are not exposed by the Rust backend",
        "add the specific Rust Cowork route before enabling",
    ),
    unsupported_webui(
        "cowork_route",
        "POST",
        "/api/cowork/{path:.+}",
        "cowork",
        "unimplemented Cowork routes are not exposed by the Rust backend",
        "add the specific Rust Cowork route before enabling",
    ),
    unsupported_webui(
        "cowork_route",
        "PATCH",
        "/api/cowork/{path:.+}",
        "cowork",
        "unimplemented Cowork routes are not exposed by the Rust backend",
        "add the specific Rust Cowork route before enabling",
    ),
    unsupported_webui(
        "cowork_route",
        "DELETE",
        "/api/cowork/{path:.+}",
        "cowork",
        "unimplemented Cowork routes are not exposed by the Rust backend",
        "add the specific Rust Cowork route before enabling",
    ),
    unsupported_webui(
        "tools",
        "GET",
        "/api/tools",
        "tools",
        "native tool catalog route is not exposed yet",
        "add Rust tool catalog route before enabling",
    ),
];

const RUNTIME_COMPONENT_INVENTORY: &[NativeRouteInventoryEntry] = &[
    runtime_component(
        "heartbeat_start",
        "heartbeat.start",
        NativeRouteOwner::Unsupported,
        "heartbeat",
        "heartbeat lifecycle is not implemented in the Rust backend",
        "add Rust heartbeat lifecycle and delivery scheduling before enabling",
    ),
    runtime_component(
        "heartbeat_stop",
        "heartbeat.stop",
        NativeRouteOwner::Unsupported,
        "heartbeat",
        "heartbeat lifecycle is not implemented in the Rust backend",
        "add Rust heartbeat lifecycle and delivery scheduling before enabling",
    ),
    runtime_component(
        "mcp_call_tool",
        "mcp.call_tool",
        NativeRouteOwner::RustOwned,
        "tools",
        "MCP fixture/tool execution is dispatched through Rust worker RPC",
        "expand native tool registry coverage as tool parity grows",
    ),
    runtime_component(
        "mcp_list_tools",
        "mcp.list_tools",
        NativeRouteOwner::RustOwned,
        "tools",
        "MCP tool listing is dispatched through Rust worker RPC",
        "expand native tool registry coverage as tool parity grows",
    ),
    runtime_component(
        "background_run_registry",
        "background.run.*",
        NativeRouteOwner::RustOwned,
        "background",
        "background run registry state is persisted through Rust worker RPC",
        "expand Rust background execution orchestration as needed",
    ),
    runtime_component(
        "background_trace_registry",
        "background.trace.*",
        NativeRouteOwner::RustOwned,
        "background",
        "background trace state is persisted through Rust worker RPC",
        "expand Rust background execution orchestration as needed",
    ),
];

const fn rust_webui(
    key: &'static str,
    method: &'static str,
    path: &'static str,
    route_group: &'static str,
    reason: &'static str,
) -> NativeRouteInventoryEntry {
    NativeRouteInventoryEntry {
        surface: "webui-route",
        key,
        method: Some(method),
        path,
        owner: NativeRouteOwner::RustOwned,
        route_group,
        reason,
        replacement_plan: "implemented in Rust",
        verification_status: "implemented",
    }
}

const fn unsupported_webui(
    key: &'static str,
    method: &'static str,
    path: &'static str,
    route_group: &'static str,
    reason: &'static str,
    replacement_plan: &'static str,
) -> NativeRouteInventoryEntry {
    NativeRouteInventoryEntry {
        surface: "webui-route",
        key,
        method: Some(method),
        path,
        owner: NativeRouteOwner::Unsupported,
        route_group,
        reason,
        replacement_plan,
        verification_status: "unsupported",
    }
}

const fn runtime_component(
    key: &'static str,
    path: &'static str,
    owner: NativeRouteOwner,
    route_group: &'static str,
    reason: &'static str,
    replacement_plan: &'static str,
) -> NativeRouteInventoryEntry {
    NativeRouteInventoryEntry {
        surface: "runtime-component",
        key,
        method: None,
        path,
        owner,
        route_group,
        reason,
        replacement_plan,
        verification_status: "inventoried-runtime-component",
    }
}

fn webui_inventory_path_matches(template: &str, path: &str) -> bool {
    if template == path {
        return true;
    }
    let Some(prefix) = template.split('{').next() else {
        return false;
    };
    if prefix.is_empty() || !path.starts_with(prefix) {
        return false;
    }
    if template.contains("{path:.+}") {
        return path.len() > prefix.len();
    }
    let suffix = template.rsplit('}').next().unwrap_or_default();
    let rest = path
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .unwrap_or_default();
    !rest.is_empty() && !rest.contains('/')
}

fn tauri_command_owner(command: &str) -> NativeRouteOwner {
    match command {
        "worker_transport_gateway_frame"
        | "worker_transport_websocket_message"
        | "worker_cron_dispatch_due"
        | "worker_channel_dispatch_inbound"
        | "worker_channel_start"
        | "worker_channel_status"
        | "worker_channel_stop"
        | "worker_channel_login" => NativeRouteOwner::Unsupported,
        _ => NativeRouteOwner::RustOwned,
    }
}

fn tauri_command_group(command: &str) -> &'static str {
    if command.contains("channel") {
        "channel"
    } else if command.contains("cron") {
        "cron"
    } else if command.contains("cowork") {
        "cowork"
    } else if command.contains("knowledge") {
        "knowledge"
    } else if command.contains("session") {
        "sessions"
    } else if command.contains("workspace") {
        "workspace"
    } else if command.contains("skill") {
        "skills"
    } else if command.contains("background") {
        "background"
    } else if command.contains("task") {
        "tasks"
    } else if command.contains("transport") {
        "transport"
    } else if command.contains("agent") {
        "agent"
    } else {
        "runtime"
    }
}

fn tauri_command_reason(command: &str) -> &'static str {
    match tauri_command_owner(command) {
        NativeRouteOwner::RustOwned => "implemented through Rust native backend command",
        NativeRouteOwner::Unsupported => "unsupported command",
    }
}

fn tauri_command_replacement_plan(command: &str) -> &'static str {
    match tauri_command_owner(command) {
        NativeRouteOwner::RustOwned => "implemented in Rust",
        NativeRouteOwner::Unsupported => "add a Rust command implementation before exposing",
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeBackendKind {
    Rust,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeBackendEventSource {
    RustBackend,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendRuntimeStatus {
    pub backend_kind: NativeBackendKind,
    pub backend_label: String,
}

impl NativeBackendRuntimeStatus {
    pub fn rust_without_compatibility() -> Self {
        Self {
            backend_kind: NativeBackendKind::Rust,
            backend_label: "rust".to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendEvent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub trace_id: String,
    pub event_name: String,
    pub timestamp: String,
    pub source: NativeBackendEventSource,
    #[serde(default)]
    pub payload: Value,
}

impl NativeBackendEvent {
    pub fn from_worker_event(
        event: WorkerEvent,
        session_id: impl Into<String>,
        run_id: Option<impl Into<String>>,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            run_id: run_id.map(Into::into),
            trace_id: event.trace_id,
            event_name: event.event,
            timestamp: timestamp.into(),
            source: NativeBackendEventSource::RustBackend,
            payload: event.payload,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendMessage {
    pub role: String,
    pub content: String,
    #[serde(default, flatten)]
    pub additional: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendRunSpec {
    pub run_id: String,
    pub session_id: String,
    #[serde(default)]
    pub messages: Vec<NativeBackendMessage>,
    pub model: String,
    pub max_iterations: u32,
    pub stream: bool,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(default, flatten)]
    pub additional: Map<String, Value>,
}

impl NativeBackendRunSpec {
    pub fn from_value(value: Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_run_timeline_contract_fields_are_stable() {
        assert_eq!(
            NATIVE_AGENT_RUN_SUMMARY_FIELDS,
            &[
                "sessionId",
                "runId",
                "status",
                "phase",
                "startedAt",
                "updatedAt",
                "completedAt",
                "stopReason",
                "model",
                "provider",
                "toolsUsed",
                "toolCallCount",
                "hasCheckpoint",
                "finalContentPreview",
                "artifactCount",
            ]
        );
        assert!(NATIVE_AGENT_RUN_DETAIL_FIELDS.contains(&"traceEvents"));
        assert!(NATIVE_AGENT_RUN_DETAIL_FIELDS.contains(&"completedToolResults"));
        assert!(NATIVE_AGENT_RUN_DETAIL_FIELDS.contains(&"pendingToolCalls"));
        assert!(NATIVE_AGENT_RUN_DETAIL_FIELDS.contains(&"checkpoint"));
        assert_eq!(
            NATIVE_AGENT_RUN_TRACE_PAGE_FIELDS,
            &["sessionId", "runId", "items", "nextCursor"]
        );
        assert!(NATIVE_AGENT_RUN_CHECKPOINT_FIELDS.contains(&"checkpoint"));
    }
}
