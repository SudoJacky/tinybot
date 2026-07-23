use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use crate::runtime::mcp::{
    configured_mcp_servers, mcp_tool_is_enabled, McpRuntime, McpRuntimeError,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

use crate::protocol::params::parse_params;
#[derive(Clone, Debug)]
pub(super) struct WorkerMcpRpc {
    workspace_root: PathBuf,
    config_snapshot: Value,
    policy: CapabilityPolicy,
    runtime: McpRuntime,
}

impl WorkerMcpRpc {
    pub(super) fn new(
        workspace_root: PathBuf,
        config_snapshot: Value,
        policy: CapabilityPolicy,
        runtime: McpRuntime,
    ) -> Self {
        Self {
            workspace_root,
            config_snapshot,
            policy,
            runtime,
        }
    }

    pub(super) fn replace_runtime(&mut self, runtime: McpRuntime) {
        self.runtime = runtime;
    }

    pub(super) fn call_tool_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        if request
            .cancellation()
            .is_some_and(|cancellation| cancellation.is_cancelled())
        {
            return Err(mcp_cancelled_error());
        }
        self.call_tool(parse_params(request)?, request.cancellation())
    }

    pub(super) fn list_tools(&self) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::McpCall)?;
        let configured_servers = configured_mcp_servers(&self.config_snapshot);
        let Some(configured_servers) = configured_servers else {
            return Ok(serde_json::json!({ "servers": [] }));
        };
        let mut servers = Vec::new();
        for (server_name, server) in configured_servers {
            validate_mcp_name("server", server_name)?;
            if server.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let tools = tauri::async_runtime::block_on(self.runtime.list_tools(
                &self.workspace_root,
                server_name,
                server,
                None,
            ))
            .map_err(|error| mcp_runtime_error("mcp.list_tools", error))?
            .into_iter()
            .filter(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|tool_name| mcp_tool_is_enabled(server_name, tool_name, server))
            })
            .collect::<Vec<_>>();
            let status = tauri::async_runtime::block_on(
                self.runtime
                    .server_status(&self.workspace_root, server_name),
            );
            servers.push(serde_json::json!({
                "name": server_name,
                "status": status,
                "tools": tools,
            }));
        }
        Ok(serde_json::json!({ "servers": servers }))
    }

    pub(super) fn capability_catalog(&self) -> Result<Value, WorkerProtocolError> {
        let allowed = self.policy.allows(&WorkerCapability::McpCall);
        serde_json::to_value(tauri::async_runtime::block_on(
            crate::mcp_capability_catalog::build_mcp_capability_catalog(
                &self.runtime,
                &self.workspace_root,
                &self.config_snapshot,
                allowed,
            ),
        ))
        .map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                format!("failed to serialize MCP capability catalog: {error}"),
                serde_json::json!({ "method": "mcp.capability_catalog" }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })
    }

    pub(super) fn server_status_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        let params: McpServerStatusParams = parse_params(request)?;
        self.server_status(&params.server)
    }

    fn call_tool(
        &self,
        params: McpCallToolParams,
        cancellation: Option<std::sync::Arc<dyn crate::protocol::WorkerRequestCancellation>>,
    ) -> Result<Value, WorkerProtocolError> {
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
        if server.get("enabled").and_then(Value::as_bool) == Some(false) {
            return Err(invalid_mcp_request(format!(
                "MCP server is disabled: {server_name}"
            )));
        }
        if !mcp_tool_is_enabled(server_name, tool_name, server) {
            return Err(mcp_tool_denied(server_name, tool_name));
        }
        let result = tauri::async_runtime::block_on(self.runtime.call_tool(
            &self.workspace_root,
            server_name,
            server,
            tool_name,
            params.arguments,
            cancellation,
        ))
        .map_err(|error| mcp_runtime_error("mcp.call_tool", error))?;
        let _session_id = params.session_id.as_deref();
        Ok(serde_json::json!({
            "content": result.get("content").cloned().unwrap_or(Value::Null),
            "structuredContent": result
                .get("structuredContent")
                .or_else(|| result.get("structured_content"))
                .cloned()
                .unwrap_or(Value::Null),
            "isError": result
                .get("isError")
                .or_else(|| result.get("is_error"))
                .cloned()
                .unwrap_or(Value::Bool(false)),
            "server": server_name,
            "tool": tool_name,
            "result": result,
        }))
    }

    pub(super) fn server_status(&self, server_name: &str) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::McpCall)?;
        validate_mcp_name("server", server_name)?;
        let server = self.server_config(server_name).ok_or_else(|| {
            invalid_mcp_request(format!("MCP server is not configured: {server_name}"))
        })?;
        if server.get("enabled").and_then(Value::as_bool) == Some(false) {
            return Ok(serde_json::json!({
                "state": "disabled",
                "transport": server
                    .get("transport")
                    .and_then(Value::as_str)
                    .unwrap_or("stdio"),
                "toolCount": 0,
                "elapsedMs": 0,
                "lastError": Value::Null,
            }));
        }
        Ok(tauri::async_runtime::block_on(
            self.runtime
                .server_status(&self.workspace_root, server_name),
        ))
    }

    pub(super) fn shutdown(&self) -> Result<(), WorkerProtocolError> {
        self.require(WorkerCapability::McpCall)?;
        tauri::async_runtime::block_on(self.runtime.shutdown())
            .map_err(|error| mcp_runtime_error("mcp.shutdown", error))
    }

    pub(super) fn diagnostics(&self) -> Result<Value, WorkerProtocolError> {
        self.require(WorkerCapability::McpCall)?;
        Ok(serde_json::json!({
            "diagnostics": tauri::async_runtime::block_on(self.runtime.diagnostics())
        }))
    }

    fn server_config(&self, server_name: &str) -> Option<&Value> {
        configured_mcp_servers(&self.config_snapshot).and_then(|servers| servers.get(server_name))
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

#[derive(Deserialize)]
struct McpCallToolParams {
    #[serde(default)]
    session_id: Option<String>,
    server: String,
    tool: String,
    #[serde(default)]
    arguments: Option<Value>,
}

fn invalid_mcp_request(message: impl Into<String>) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "mcp.call_tool" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[derive(Deserialize)]
struct McpServerStatusParams {
    #[serde(rename = "serverId", alias = "server_id", alias = "server")]
    server: String,
}

fn mcp_runtime_error(method: &str, error: McpRuntimeError) -> WorkerProtocolError {
    WorkerProtocolError::new(
        if error.cancelled {
            WorkerProtocolErrorCode::WorkerError
        } else if error.retryable {
            WorkerProtocolErrorCode::WorkerError
        } else {
            WorkerProtocolErrorCode::InvalidProtocol
        },
        error.message,
        serde_json::json!({
            "method": method,
            "server": error.server,
            "transport": error.transport,
            "retryable": error.retryable,
            "cancelled": error.cancelled,
        }),
        error.retryable,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn mcp_cancelled_error() -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        "MCP tool call cancelled",
        serde_json::json!({ "method": "mcp.call_tool" }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn mcp_tool_denied(server: &str, tool: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::CapabilityDenied,
        "MCP tool is not allowlisted",
        serde_json::json!({
            "capability": WorkerCapability::McpCall,
            "server": server,
            "tool": tool,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn validate_mcp_name<'a>(field: &str, value: &'a str) -> Result<&'a str, WorkerProtocolError> {
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

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
