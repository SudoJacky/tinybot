use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use serde::Deserialize;
use serde_json::Value;

use super::protocol::parse_params;

#[derive(Clone, Debug)]
pub(super) struct WorkerMcpRpc {
    config_snapshot: Value,
    policy: CapabilityPolicy,
}

impl WorkerMcpRpc {
    pub(super) fn new(config_snapshot: Value, policy: CapabilityPolicy) -> Self {
        Self {
            config_snapshot,
            policy,
        }
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
        self.call_tool(parse_params(request)?)
    }

    pub(super) fn list_tools(&self) -> Result<Value, WorkerProtocolError> {
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

    fn call_tool(&self, params: McpCallToolParams) -> Result<Value, WorkerProtocolError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_protocol::WorkerRequestCancellation;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    fn mcp_rpc(config_snapshot: Value) -> WorkerMcpRpc {
        WorkerMcpRpc::new(
            config_snapshot,
            CapabilityPolicy::new([WorkerCapability::McpCall]),
        )
    }

    #[test]
    fn mcp_call_tool_returns_configured_fixture_tool_content() {
        let rpc = mcp_rpc(json!({
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
        }));
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

        assert_eq!(
            rpc.call_tool_from_request(&request).unwrap(),
            json!({
                "content": "MCP search result",
                "server": "docs",
                "tool": "search"
            })
        );
    }

    #[test]
    fn mcp_list_tools_returns_allowlisted_fixture_definitions() {
        let rpc = mcp_rpc(json!({
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
        }));

        assert_eq!(
            rpc.list_tools().unwrap(),
            json!({
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
            })
        );
    }

    #[test]
    fn mcp_call_tool_requires_allowlisted_tool() {
        let rpc = mcp_rpc(json!({
            "tools": {
                "mcp_servers": {
                    "docs": {
                        "enabled_tools": ["search"]
                    }
                }
            }
        }));
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

        let error = rpc
            .call_tool_from_request(&request)
            .expect_err("not allowlisted should fail");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["server"], "docs");
        assert_eq!(error.details["tool"], "delete_everything");
    }

    #[test]
    fn mcp_call_tool_fails_fast_when_request_is_cancelled() {
        let rpc = mcp_rpc(json!({
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
        }));
        let cancellation = Arc::new(TestCancellation::new(true));
        let request = WorkerRequest::new(
            "req-cancelled",
            "trace-cancelled",
            "mcp.call_tool",
            json!({
                "server": "docs",
                "tool": "search",
                "arguments": {}
            }),
        )
        .with_cancellation(Some(cancellation));

        let error = rpc
            .call_tool_from_request(&request)
            .expect_err("cancelled MCP request should fail before dispatch");

        assert_eq!(error.code, WorkerProtocolErrorCode::WorkerError);
        assert_eq!(error.message, "MCP tool call cancelled");
        assert_eq!(error.details["method"], "mcp.call_tool");
    }

    #[derive(Debug)]
    struct TestCancellation {
        cancelled: AtomicBool,
    }

    impl TestCancellation {
        fn new(cancelled: bool) -> Self {
            Self {
                cancelled: AtomicBool::new(cancelled),
            }
        }
    }

    impl WorkerRequestCancellation for TestCancellation {
        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }
    }
}
