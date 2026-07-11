use crate::runtime::mcp::{
    configured_mcp_servers, mcp_tool_is_enabled, McpRuntime, McpRuntimeError,
};
use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource, WorkerRequest,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

use super::protocol::parse_params;
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
        cancellation: Option<std::sync::Arc<dyn crate::worker_protocol::WorkerRequestCancellation>>,
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
mod tests {
    use super::*;
    use crate::worker_protocol::WorkerRequestCancellation;
    use rmcp::{
        handler::server::{router::tool::ToolRouter, wrapper::Parameters},
        model::{ServerCapabilities, ServerInfo},
        schemars, tool, tool_handler, tool_router, Json, ServerHandler,
    };
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio_util::sync::CancellationToken;

    struct StdioMcpFixture {
        root: PathBuf,
        script: PathBuf,
    }

    impl StdioMcpFixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("fixture timestamp should be available")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "tinybot-mcp-stdio-test-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).expect("MCP fixture directory should create");
            let script = root.join("server.js");
            std::fs::write(
                &script,
                r#"
const readline = require("readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tinybot-test-mcp", version: "1.0.0" }
      }
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "echo",
          description: "Echo text from a real stdio MCP server.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          },
          annotations: { readOnlyHint: true }
        }]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    const text = message.params.arguments.text;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text }],
        structuredContent: { echo: text },
        isError: false
      }
    });
  }
});
"#,
            )
            .expect("MCP fixture script should write");
            Self { root, script }
        }

        fn from_source(source: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("fixture timestamp should be available")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "tinybot-mcp-stdio-test-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).expect("MCP fixture directory should create");
            let script = root.join("server.js");
            std::fs::write(&script, source).expect("MCP fixture script should write");
            Self { root, script }
        }
    }

    impl Drop for StdioMcpFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
    struct HttpEchoRequest {
        text: String,
    }

    #[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
    struct HttpEchoResult {
        echo: String,
    }

    #[derive(Debug, Clone)]
    struct HttpEchoServer {
        tool_router: ToolRouter<Self>,
    }

    #[tool_router]
    impl HttpEchoServer {
        fn new() -> Self {
            Self {
                tool_router: Self::tool_router(),
            }
        }

        #[tool(name = "echo", description = "Echo text from a real HTTP MCP server.")]
        async fn echo(
            &self,
            Parameters(request): Parameters<HttpEchoRequest>,
        ) -> Json<HttpEchoResult> {
            Json(HttpEchoResult { echo: request.text })
        }

        #[tool(
            name = "slow",
            description = "Wait long enough for cancellation testing."
        )]
        async fn slow(&self) -> String {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            "too late".to_string()
        }
    }

    #[tool_handler(router = self.tool_router)]
    impl ServerHandler for HttpEchoServer {
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
        }
    }

    struct HttpMcpFixture {
        endpoint: String,
        cancellation: CancellationToken,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl HttpMcpFixture {
        fn new() -> Self {
            use rmcp::transport::streamable_http_server::{
                session::local::LocalSessionManager, StreamableHttpServerConfig,
                StreamableHttpService,
            };

            let cancellation = CancellationToken::new();
            let server_cancellation = cancellation.clone();
            let (endpoint_sender, endpoint_receiver) = std::sync::mpsc::sync_channel(1);
            let thread = std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("HTTP MCP fixture runtime should create");
                runtime.block_on(async move {
                    let service: StreamableHttpService<HttpEchoServer, LocalSessionManager> =
                        StreamableHttpService::new(
                            || Ok(HttpEchoServer::new()),
                            Default::default(),
                            StreamableHttpServerConfig::default()
                                .with_sse_keep_alive(None)
                                .with_cancellation_token(server_cancellation.child_token()),
                        );
                    let router = axum::Router::new().nest_service("/mcp", service);
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                        .await
                        .expect("HTTP MCP fixture should bind");
                    let endpoint = format!(
                        "http://{}/mcp",
                        listener
                            .local_addr()
                            .expect("HTTP MCP fixture address should resolve")
                    );
                    endpoint_sender
                        .send(endpoint)
                        .expect("HTTP MCP fixture endpoint should publish");
                    let shutdown = server_cancellation.clone();
                    axum::serve(listener, router)
                        .with_graceful_shutdown(async move { shutdown.cancelled_owned().await })
                        .await
                        .expect("HTTP MCP fixture should serve");
                });
            });
            let endpoint = endpoint_receiver
                .recv()
                .expect("HTTP MCP fixture endpoint should be available");
            Self {
                endpoint,
                cancellation,
                thread: Some(thread),
            }
        }
    }

    impl Drop for HttpMcpFixture {
        fn drop(&mut self) {
            self.cancellation.cancel();
            if let Some(thread) = self.thread.take() {
                thread.join().expect("HTTP MCP fixture should stop cleanly");
            }
        }
    }

    fn mcp_rpc(config_snapshot: Value) -> WorkerMcpRpc {
        mcp_rpc_with_runtime(config_snapshot, McpRuntime::new())
    }

    fn mcp_rpc_with_runtime(config_snapshot: Value, runtime: McpRuntime) -> WorkerMcpRpc {
        WorkerMcpRpc::new(
            std::env::current_dir().expect("test working directory should be available"),
            config_snapshot,
            CapabilityPolicy::new([WorkerCapability::McpCall]),
            runtime,
        )
    }

    fn wait_for_fixture_marker(path: &std::path::Path) -> bool {
        for _ in 0..40 {
            if path.exists() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        false
    }

    #[cfg(windows)]
    fn fixture_process_is_alive(pid: u32) -> bool {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("tasklist should inspect fixture process");
        String::from_utf8_lossy(&output.stdout).contains(&format!(",\"{pid}\","))
    }

    #[cfg(unix)]
    fn fixture_process_is_alive(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn wait_for_fixture_process_exit(pid: u32) -> bool {
        for _ in 0..40 {
            if !fixture_process_is_alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        false
    }

    #[test]
    fn mcp_fixture_fields_never_create_a_fake_runtime() {
        let rpc = mcp_rpc(json!({
            "mcp": {
                "servers": {
                    "docs": {
                        "enabled_tools": ["search"],
                        "fixture_tools": {
                            "search": { "content": "must never be returned" }
                        }
                    }
                }
            }
        }));
        let request = WorkerRequest::new(
            "req-no-fixture-runtime",
            "trace-no-fixture-runtime",
            "mcp.call_tool",
            json!({
                "server": "docs",
                "tool": "search",
                "arguments": {}
            }),
        );

        let call_error = rpc
            .call_tool_from_request(&request)
            .expect_err("fixture fields must not synthesize MCP call success");
        let list_error = rpc
            .list_tools()
            .expect_err("fixture fields must not synthesize MCP tool definitions");

        assert!(call_error.message.contains("requires a command"));
        assert!(list_error.message.contains("requires a command"));
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
    fn mcp_stdio_runtime_initializes_lists_and_calls_real_server() {
        let fixture = StdioMcpFixture::new();
        let rpc = mcp_rpc(json!({
            "mcp": {
                "servers": {
                    "docs": {
                        "enabled": true,
                        "transport": "stdio",
                        "command": "node",
                        "args": [fixture.script.to_string_lossy()],
                        "cwd": fixture.root.to_string_lossy(),
                        "timeout_seconds": 5,
                        "enabled_tools": ["echo"]
                    }
                }
            }
        }));

        let listed = rpc.list_tools().expect("real MCP tools should list");
        assert_eq!(listed["servers"][0]["name"], "docs");
        assert_eq!(listed["servers"][0]["status"]["state"], "ready");
        assert_eq!(listed["servers"][0]["tools"][0]["name"], "echo");
        assert_eq!(
            listed["servers"][0]["tools"][0]["inputSchema"]["required"],
            json!(["text"])
        );

        let called = rpc
            .call_tool_from_request(&WorkerRequest::new(
                "req-real-mcp-call",
                "trace-real-mcp-call",
                "mcp.call_tool",
                json!({
                    "server": "docs",
                    "tool": "echo",
                    "arguments": { "text": "hello from stdio" }
                }),
            ))
            .expect("real MCP tool should execute");
        assert_eq!(called["server"], "docs");
        assert_eq!(called["tool"], "echo");
        assert_eq!(called["content"][0]["text"], "hello from stdio");
        assert_eq!(called["structuredContent"]["echo"], "hello from stdio");

        rpc.shutdown()
            .expect("MCP runtime should shut down cleanly");
        assert_eq!(
            rpc.server_status("docs")
                .expect("server status should remain queryable")["state"],
            "stopped"
        );
    }

    #[test]
    fn mcp_http_runtime_initializes_lists_calls_and_shuts_down_real_server() {
        let fixture = HttpMcpFixture::new();
        let rpc = mcp_rpc(json!({
            "tools": {
                "mcp_servers": {
                    "remote": {
                        "enabled": true,
                        "transport": "http",
                        "url": fixture.endpoint,
                        "timeout_seconds": 5,
                        "enabled_tools": ["echo"]
                    }
                }
            }
        }));

        let listed = rpc.list_tools().expect("real HTTP MCP tools should list");
        assert_eq!(listed["servers"][0]["name"], "remote");
        assert_eq!(listed["servers"][0]["status"]["state"], "ready");
        assert_eq!(listed["servers"][0]["status"]["transport"], "http");
        assert_eq!(listed["servers"][0]["status"]["toolCount"], 2);
        assert_eq!(listed["servers"][0]["tools"][0]["name"], "echo");
        assert_eq!(
            listed["servers"][0]["tools"][0]["inputSchema"]["required"],
            json!(["text"])
        );

        let called = rpc
            .call_tool_from_request(&WorkerRequest::new(
                "req-real-http-mcp-call",
                "trace-real-http-mcp-call",
                "mcp.call_tool",
                json!({
                    "server": "remote",
                    "tool": "echo",
                    "arguments": { "text": "hello from http" }
                }),
            ))
            .expect("real HTTP MCP tool should execute");
        assert_eq!(called["server"], "remote");
        assert_eq!(called["tool"], "echo");
        assert_eq!(called["structuredContent"]["echo"], "hello from http");

        rpc.shutdown()
            .expect("HTTP MCP runtime should shut down cleanly");
        let stopped = rpc
            .server_status("remote")
            .expect("HTTP MCP status should remain queryable");
        assert_eq!(stopped["state"], "stopped");
        assert_eq!(stopped["transport"], "http");
    }

    #[test]
    fn mcp_legacy_sse_is_rejected_without_transport_fallback() {
        let rpc = mcp_rpc(json!({
            "tools": {
                "mcp_servers": {
                    "legacy": {
                        "enabled": true,
                        "transport": "sse",
                        "url": "https://example.com/sse",
                        "enabled_tools": ["search"]
                    }
                }
            }
        }));

        let error = rpc
            .list_tools()
            .expect_err("legacy SSE must fail validation explicitly");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["server"], "legacy");
        assert_eq!(error.details["transport"], "sse");
        assert!(error.message.contains("unsupported transport"));
    }

    #[test]
    fn mcp_http_cancellation_closes_transport_and_marks_failure() {
        let fixture = HttpMcpFixture::new();
        let rpc = mcp_rpc(json!({
            "tools": { "mcp_servers": { "remote": {
                "enabled": true,
                "transport": "http",
                "url": fixture.endpoint,
                "timeout_seconds": 5,
                "enabled_tools": ["slow"]
            }}}
        }));
        rpc.list_tools()
            .expect("HTTP MCP server should initialize before cancellation");
        let cancellation = Arc::new(TestCancellation::new(false));
        let cancel_from_thread = cancellation.clone();
        let cancel_thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(75));
            cancel_from_thread.cancelled.store(true, Ordering::SeqCst);
        });
        let request = WorkerRequest::new(
            "req-cancel-http-call",
            "trace-cancel-http-call",
            "mcp.call_tool",
            json!({ "server": "remote", "tool": "slow", "arguments": {} }),
        )
        .with_cancellation(Some(cancellation));

        let error = rpc
            .call_tool_from_request(&request)
            .expect_err("in-flight HTTP cancellation should stop the MCP call");
        cancel_thread
            .join()
            .expect("HTTP cancellation thread should finish");

        assert_eq!(error.message, "MCP tool call cancelled");
        assert_eq!(error.details["transport"], "http");
        let status = rpc
            .server_status("remote")
            .expect("cancelled HTTP server status should be available");
        assert_eq!(status["state"], "failed");
        assert_eq!(status["transport"], "http");
        rpc.shutdown()
            .expect("cancelled HTTP MCP runtime should shut down");
    }

    #[test]
    fn mcp_runtime_is_shared_across_short_lived_rpc_adapters() {
        let fixture = StdioMcpFixture::new();
        let config = json!({
            "tools": {
                "mcp_servers": {
                    "docs": {
                        "enabled": true,
                        "transport": "stdio",
                        "command": "node",
                        "args": [fixture.script.to_string_lossy()],
                        "cwd": fixture.root.to_string_lossy(),
                        "timeout_seconds": 5,
                        "enabled_tools": ["echo"]
                    }
                }
            }
        });
        let runtime = McpRuntime::new();
        let list_adapter = mcp_rpc_with_runtime(config.clone(), runtime.clone());
        list_adapter
            .list_tools()
            .expect("first adapter should start and discover the MCP server");

        let call_adapter = mcp_rpc_with_runtime(config, runtime);
        assert_eq!(
            call_adapter
                .server_status("docs")
                .expect("second adapter should observe shared state")["state"],
            "ready"
        );
        let called = call_adapter
            .call_tool_from_request(&WorkerRequest::new(
                "req-shared-mcp-call",
                "trace-shared-mcp-call",
                "mcp.call_tool",
                json!({
                    "server": "docs",
                    "tool": "echo",
                    "arguments": { "text": "shared runtime" }
                }),
            ))
            .expect("second adapter should reuse the live client");
        assert_eq!(called["content"][0]["text"], "shared runtime");
        call_adapter
            .shutdown()
            .expect("shared MCP runtime should shut down");
    }

    #[test]
    fn mcp_cancellation_during_call_closes_transport_and_marks_failure() {
        let fixture = StdioMcpFixture::from_source(
            r#"
const fs = require("fs");
const readline = require("readline");
const closedMarker = process.argv[2];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tinybot-slow-mcp", version: "1.0.0" }
    }});
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "slow",
      description: "Wait until cancelled.",
      inputSchema: { type: "object" }
    }] }});
    return;
  }
  if (message.method === "tools/call") {
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: "too late" }], isError: false
    }}), 10000);
  }
});
lines.on("close", () => {
  fs.writeFileSync(closedMarker, "closed");
  process.exit(0);
});
"#,
        );
        let closed_marker = fixture.root.join("cancelled-call-closed.txt");
        let rpc = mcp_rpc(json!({
            "tools": { "mcp_servers": { "slow": {
                "transport": "stdio",
                "command": "node",
                "args": [fixture.script.to_string_lossy(), closed_marker.to_string_lossy()],
                "cwd": fixture.root.to_string_lossy(),
                "timeout_seconds": 5,
                "enabled_tools": ["slow"]
            }}}
        }));
        rpc.list_tools()
            .expect("slow MCP server should initialize before cancellation");
        let cancellation = Arc::new(TestCancellation::new(false));
        let cancel_from_thread = cancellation.clone();
        let cancel_thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(75));
            cancel_from_thread.cancelled.store(true, Ordering::SeqCst);
        });
        let request = WorkerRequest::new(
            "req-cancel-during-call",
            "trace-cancel-during-call",
            "mcp.call_tool",
            json!({ "server": "slow", "tool": "slow", "arguments": {} }),
        )
        .with_cancellation(Some(cancellation));

        let error = rpc
            .call_tool_from_request(&request)
            .expect_err("in-flight cancellation should stop the MCP call");
        cancel_thread
            .join()
            .expect("cancellation thread should finish");

        assert_eq!(error.message, "MCP tool call cancelled");
        let status = rpc
            .server_status("slow")
            .expect("cancelled server status should be available");
        assert_eq!(status["state"], "failed");
        assert!(status["lastError"]
            .as_str()
            .is_some_and(|error| error.contains("cancelled")));
        assert!(
            wait_for_fixture_marker(&closed_marker),
            "in-flight cancellation should close the MCP child stdin"
        );
    }

    #[test]
    fn mcp_cancellation_during_startup_stops_discovery_promptly() {
        let fixture = StdioMcpFixture::from_source(
            r#"
const fs = require("fs");
const readline = require("readline");
const pidPath = process.argv[2];
fs.writeFileSync(pidPath, String(process.pid));
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tinybot-slow-start-mcp", version: "1.0.0" }
    }}), 10000);
  }
});
"#,
        );
        let pid_path = fixture.root.join("cancelled-startup.pid");
        let config = json!({
            "mcp": { "servers": { "slow-start": {
                "transport": "stdio",
                "command": "node",
                "args": [fixture.script.to_string_lossy(), pid_path.to_string_lossy()],
                "cwd": fixture.root.to_string_lossy(),
                "startup_timeout_seconds": 30,
                "timeout_seconds": 30,
                "enabled_tools": ["echo"]
            }}}
        });
        let rpc = mcp_rpc(config.clone());
        let server = configured_mcp_servers(&config)
            .and_then(|servers| servers.get("slow-start"))
            .expect("slow startup server should be configured");
        let cancellation = Arc::new(TestCancellation::new(false));
        let cancel_from_thread = cancellation.clone();
        let pid_for_cancellation = pid_path.clone();
        let cancel_thread = std::thread::spawn(move || {
            assert!(
                wait_for_fixture_marker(&pid_for_cancellation),
                "MCP child should start before startup cancellation"
            );
            cancel_from_thread.cancelled.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();

        let error = tauri::async_runtime::block_on(rpc.runtime.list_tools(
            &rpc.workspace_root,
            "slow-start",
            server,
            Some(cancellation),
        ))
        .expect_err("startup cancellation should stop MCP discovery");
        cancel_thread
            .join()
            .expect("startup cancellation thread should finish");

        assert!(error.cancelled);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        let status = rpc
            .server_status("slow-start")
            .expect("cancelled startup status should be available");
        assert_eq!(status["state"], "failed");
        assert!(status["lastError"]
            .as_str()
            .is_some_and(|error| error.contains("cancelled")));
        assert!(
            wait_for_fixture_marker(&pid_path),
            "MCP child should publish its PID"
        );
        let pid = std::fs::read_to_string(&pid_path)
            .expect("MCP child PID should be readable")
            .parse::<u32>()
            .expect("MCP child PID should be numeric");
        assert!(
            wait_for_fixture_process_exit(pid),
            "startup cancellation should leave no live MCP child process"
        );
        rpc.shutdown()
            .expect("cancelled startup should leave no live MCP process");
    }

    #[test]
    fn mcp_failed_client_restarts_cleanly_on_next_call() {
        let fixture = StdioMcpFixture::from_source(
            r#"
const fs = require("fs");
const readline = require("readline");
const countPath = process.argv[2];
const count = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0) + 1;
fs.writeFileSync(countPath, String(count));
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tinybot-restart-mcp", version: "1.0.0" }
    }});
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "recover", description: "Recover after restart.", inputSchema: { type: "object" }
    }] }});
    return;
  }
  if (message.method === "tools/call") {
    const response = () => send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: `process-${count}` }], isError: false
    }});
    if (count === 1) setTimeout(response, 10000); else response();
  }
});
"#,
        );
        let count_path = fixture.root.join("starts.txt");
        let rpc = mcp_rpc(json!({
            "tools": { "mcp_servers": { "restart": {
                "transport": "stdio",
                "command": "node",
                "args": [fixture.script.to_string_lossy(), count_path.to_string_lossy()],
                "cwd": fixture.root.to_string_lossy(),
                "timeout_seconds": 1,
                "startup_timeout_seconds": 5,
                "enabled_tools": ["recover"]
            }}}
        }));
        rpc.list_tools()
            .expect("restart fixture should initialize its first process");
        let request = || {
            WorkerRequest::new(
                "req-restart-mcp",
                "trace-restart-mcp",
                "mcp.call_tool",
                json!({ "server": "restart", "tool": "recover", "arguments": {} }),
            )
        };

        let first_error = rpc
            .call_tool_from_request(&request())
            .expect_err("first process should time out");
        assert!(first_error.message.contains("timed out"));
        assert_eq!(
            rpc.server_status("restart")
                .expect("failed status should be available")["state"],
            "failed"
        );

        let recovered = rpc
            .call_tool_from_request(&request())
            .expect("next call should start a clean client");
        assert_eq!(recovered["content"][0]["text"], "process-2");
        assert_eq!(
            rpc.server_status("restart")
                .expect("restarted status should be available")["state"],
            "ready"
        );
        rpc.shutdown().expect("restart fixture should shut down");
    }

    #[test]
    fn mcp_startup_failure_does_not_echo_command_or_environment_secrets() {
        let secret = "tinybot-mcp-do-not-leak-9f2e";
        let rpc = mcp_rpc(json!({
            "tools": { "mcp_servers": { "private": {
                "transport": "stdio",
                "command": secret,
                "env": { "PRIVATE_TOKEN": secret },
                "enabled_tools": ["read"]
            }}}
        }));

        let error = rpc
            .list_tools()
            .expect_err("missing configured command should fail startup");
        let status = rpc
            .server_status("private")
            .expect("startup failure status should be available");

        assert_eq!(error.details["server"], "private");
        assert_eq!(error.details["transport"], "stdio");
        assert!(!error.message.contains(secret));
        assert!(!status["lastError"]
            .as_str()
            .unwrap_or_default()
            .contains(secret));
        assert!(!rpc
            .diagnostics()
            .expect("failure diagnostics should be available")
            .to_string()
            .contains(secret));
    }

    #[test]
    fn mcp_stdio_server_requires_a_command_before_runtime_start() {
        let rpc = mcp_rpc(json!({
            "tools": {
                "mcp_servers": {
                    "docs": {
                        "transport": "stdio",
                        "enabled_tools": ["search"]
                    }
                }
            }
        }));
        let request = WorkerRequest::new(
            "req-missing-command",
            "trace-missing-command",
            "mcp.call_tool",
            json!({
                "server": "docs",
                "tool": "search",
                "arguments": {}
            }),
        );

        let error = rpc
            .call_tool_from_request(&request)
            .expect_err("stdio server without command must fail before runtime start");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["server"], "docs");
        assert_eq!(error.details["transport"], "stdio");
        assert!(error.message.contains("command"));
        assert_eq!(
            rpc.server_status("docs")
                .expect("configuration failure status should be available")["state"],
            "failed"
        );
        let diagnostics = rpc
            .diagnostics()
            .expect("MCP diagnostics should be queryable");
        let diagnostic = diagnostics["diagnostics"]
            .as_array()
            .and_then(|diagnostics| diagnostics.last())
            .expect("configuration failure should record a diagnostic");
        assert_eq!(diagnostic["serverId"], "docs");
        assert_eq!(diagnostic["transport"], "stdio");
        assert_eq!(diagnostic["phase"], "configuration");
        assert_eq!(diagnostic["errorCode"], "invalid_configuration");
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
