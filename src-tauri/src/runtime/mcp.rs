use crate::adapters::mcp_http::{
    http_transport_config, parse_http_server_config, HttpServerConfig,
};
use crate::adapters::mcp_stdio::{parse_stdio_server_config, stdio_command, StdioServerConfig};
use crate::worker_protocol::WorkerRequestCancellation;
use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientInfo, Implementation, PaginatedRequestParams,
    ProtocolVersion,
};
use rmcp::service::{self, RoleClient, RunningService};
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::StreamableHttpClientTransport;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

type ClientService = RunningService<RoleClient, ClientInfo>;
type SharedClientService = Arc<Mutex<ClientService>>;

#[derive(Clone)]
pub(crate) struct McpRuntime {
    servers: Arc<Mutex<BTreeMap<McpServerKey, ManagedServer>>>,
    diagnostics: Arc<Mutex<VecDeque<Value>>>,
}

#[derive(Clone, Debug)]
pub(crate) struct McpRuntimeError {
    pub(crate) server: String,
    pub(crate) transport: String,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) cancelled: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct McpServerTools {
    pub(crate) server_id: String,
    pub(crate) server_config: Value,
    pub(crate) tools: Vec<Value>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct McpServerKey {
    workspace_root: PathBuf,
    server_name: String,
}

struct ManagedServer {
    state: McpServerState,
    transport: String,
    fingerprint: String,
    service: Option<SharedClientService>,
    tool_count: usize,
    elapsed_ms: u128,
    last_error: Option<String>,
}

#[derive(Clone, Debug)]
enum McpServerConfig {
    Stdio(StdioServerConfig),
    Http(HttpServerConfig),
}

impl McpServerConfig {
    fn transport(&self) -> &'static str {
        match self {
            Self::Stdio(_) => "stdio",
            Self::Http(_) => "http",
        }
    }

    fn fingerprint(&self) -> &str {
        match self {
            Self::Stdio(config) => &config.fingerprint,
            Self::Http(config) => &config.fingerprint,
        }
    }

    fn call_timeout(&self) -> Duration {
        match self {
            Self::Stdio(config) => config.call_timeout,
            Self::Http(config) => config.call_timeout,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum McpServerState {
    Disabled,
    Starting,
    Ready,
    Failed,
    Stopping,
    Stopped,
}

impl McpRuntime {
    pub(crate) fn new() -> Self {
        Self {
            servers: Arc::new(Mutex::new(BTreeMap::new())),
            diagnostics: Arc::new(Mutex::new(VecDeque::with_capacity(200))),
        }
    }

    pub(crate) async fn list_tools(
        &self,
        workspace_root: &Path,
        server_name: &str,
        server_config: &Value,
    ) -> Result<Vec<Value>, McpRuntimeError> {
        let key = McpServerKey::new(workspace_root, server_name);
        let config = match self.config(workspace_root, server_name, server_config) {
            Ok(config) => config,
            Err(error) => {
                self.record_configuration_failure(&key, &error).await;
                return Err(error);
            }
        };
        let service = self.ensure_client(&key, &config).await?;
        let mut tools = Vec::new();
        let mut cursor = None;
        loop {
            let params = cursor
                .clone()
                .map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
            let response_result = {
                let service = service.lock().await;
                tokio::time::timeout(config.call_timeout(), service.list_tools(params)).await
            };
            let response = match response_result {
                Err(_) => {
                    let error = self.timeout_error(
                        server_name,
                        config.transport(),
                        "tools/list",
                        config.call_timeout(),
                    );
                    self.fail_server(&key, &error.message).await?;
                    return Err(error);
                }
                Ok(Err(source)) => {
                    let error = self.operation_error(
                        server_name,
                        config.transport(),
                        "tools/list",
                        source.to_string(),
                    );
                    self.fail_server(&key, &error.message).await?;
                    return Err(error);
                }
                Ok(Ok(response)) => response,
            };
            tools.extend(
                response
                    .tools
                    .into_iter()
                    .map(|tool| {
                        serde_json::to_value(tool).map_err(|error| {
                            self.operation_error(
                                server_name,
                                config.transport(),
                                "tools/list serialization",
                                error.to_string(),
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            );
            match response.next_cursor {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }
        if let Some(server) = self.servers.lock().await.get_mut(&key) {
            server.tool_count = tools.len();
        }
        Ok(tools)
    }

    pub(crate) async fn call_tool(
        &self,
        workspace_root: &Path,
        server_name: &str,
        server_config: &Value,
        tool_name: &str,
        arguments: Option<Value>,
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Result<Value, McpRuntimeError> {
        if cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.is_cancelled())
        {
            let transport = configured_transport(server_config);
            return Err(self.cancelled_error(server_name, &transport));
        }
        let key = McpServerKey::new(workspace_root, server_name);
        let config = match self.config(workspace_root, server_name, server_config) {
            Ok(config) => config,
            Err(error) => {
                self.record_configuration_failure(&key, &error).await;
                return Err(error);
            }
        };
        let service = self.ensure_client(&key, &config).await?;
        let arguments = match arguments {
            Some(Value::Object(arguments)) => Some(arguments),
            Some(_) => {
                return Err(McpRuntimeError {
                    server: server_name.to_string(),
                    transport: config.transport().to_string(),
                    message: "MCP tool arguments must be a JSON object".to_string(),
                    retryable: false,
                    cancelled: false,
                });
            }
            None => None,
        };
        let mut params = CallToolRequestParams::new(tool_name.to_string());
        params.arguments = arguments;
        let call = async {
            let service = service.lock().await;
            service.call_tool(params).await
        };
        let timed_result = if let Some(cancellation) = cancellation {
            tokio::select! {
                result = tokio::time::timeout(config.call_timeout(), call) => Some(result),
                _ = wait_for_cancellation(cancellation) => None,
            }
        } else {
            Some(tokio::time::timeout(config.call_timeout(), call).await)
        };
        let Some(timed_result) = timed_result else {
            let error = self.cancelled_error(server_name, config.transport());
            self.fail_server(&key, &error.message).await?;
            return Err(error);
        };
        let result = match timed_result {
            Err(_) => {
                let error = self.timeout_error(
                    server_name,
                    config.transport(),
                    "tools/call",
                    config.call_timeout(),
                );
                self.fail_server(&key, &error.message).await?;
                return Err(error);
            }
            Ok(Err(source)) => {
                let error = self.operation_error(
                    server_name,
                    config.transport(),
                    "tools/call",
                    source.to_string(),
                );
                self.fail_server(&key, &error.message).await?;
                return Err(error);
            }
            Ok(Ok(result)) => result,
        };
        serde_json::to_value(result).map_err(|error| {
            self.operation_error(
                server_name,
                config.transport(),
                "tools/call serialization",
                error.to_string(),
            )
        })
    }

    pub(crate) async fn server_status(&self, workspace_root: &Path, server_name: &str) -> Value {
        let key = McpServerKey::new(workspace_root, server_name);
        let servers = self.servers.lock().await;
        servers
            .get(&key)
            .map(ManagedServer::status_value)
            .unwrap_or_else(|| {
                json!({
                    "state": "stopped",
                    "transport": "stdio",
                    "toolCount": 0,
                    "elapsedMs": 0,
                    "lastError": Value::Null,
                })
            })
    }

    pub(crate) async fn configured_statuses(
        &self,
        workspace_root: &Path,
        config_snapshot: &Value,
    ) -> BTreeMap<String, Value> {
        let Some(servers) = config_snapshot
            .get("tools")
            .and_then(|tools| tools.get("mcp_servers").or_else(|| tools.get("mcpServers")))
            .or_else(|| {
                config_snapshot
                    .get("mcp")
                    .and_then(|mcp| mcp.get("servers"))
            })
            .and_then(Value::as_object)
        else {
            return BTreeMap::new();
        };
        let managed = self.servers.lock().await;
        servers
            .iter()
            .map(|(server_name, server_config)| {
                let transport = configured_transport(server_config);
                let status = if server_config.get("enabled").and_then(Value::as_bool) == Some(false)
                {
                    json!({
                        "state": "disabled",
                        "transport": transport,
                        "toolCount": 0,
                        "elapsedMs": 0,
                        "lastError": Value::Null,
                    })
                } else {
                    managed
                        .get(&McpServerKey::new(workspace_root, server_name))
                        .map(ManagedServer::status_value)
                        .unwrap_or_else(|| {
                            json!({
                                "state": "stopped",
                                "transport": transport,
                                "toolCount": 0,
                                "elapsedMs": 0,
                                "lastError": Value::Null,
                            })
                        })
                };
                (server_name.clone(), status)
            })
            .collect()
    }

    pub(crate) async fn shutdown(&self) -> Result<(), McpRuntimeError> {
        let server_keys = self
            .servers
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut failures = Vec::new();
        for server_key in server_keys {
            if let Err(error) = self.stop_server(&server_key).await {
                failures.push(error);
            }
        }
        if let Some(mut error) = failures.into_iter().next() {
            error.message = format!("MCP runtime shutdown failed: {}", error.message);
            return Err(error);
        }
        Ok(())
    }

    pub(crate) async fn diagnostics(&self) -> Vec<Value> {
        self.diagnostics.lock().await.iter().cloned().collect()
    }

    pub(crate) async fn discover_configured_tools(
        &self,
        workspace_root: &Path,
        config_snapshot: &Value,
    ) -> Result<Vec<McpServerTools>, McpRuntimeError> {
        let Some(servers) = config_snapshot
            .get("tools")
            .and_then(|tools| tools.get("mcp_servers").or_else(|| tools.get("mcpServers")))
            .and_then(Value::as_object)
        else {
            return Ok(Vec::new());
        };
        let mut discovered = Vec::new();
        for (server_id, server_config) in servers {
            if server_config.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            if !server_config
                .get("enabled_tools")
                .or_else(|| server_config.get("enabledTools"))
                .and_then(Value::as_array)
                .is_some_and(|tools| !tools.is_empty())
            {
                continue;
            }
            let mut tools = self
                .list_tools(workspace_root, server_id, server_config)
                .await?
                .into_iter()
                .filter(|tool| {
                    tool.get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|tool_name| {
                            mcp_tool_is_enabled(server_id, tool_name, server_config)
                        })
                })
                .collect::<Vec<_>>();
            tools.sort_by(|left, right| {
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
            discovered.push(McpServerTools {
                server_id: server_id.clone(),
                server_config: server_config.clone(),
                tools,
            });
        }
        Ok(discovered)
    }

    pub(crate) async fn reconcile(
        &self,
        workspace_root: &Path,
        config_snapshot: &Value,
    ) -> Result<(), McpRuntimeError> {
        let configured_servers = config_snapshot
            .get("tools")
            .and_then(|tools| tools.get("mcp_servers").or_else(|| tools.get("mcpServers")))
            .and_then(Value::as_object);
        let existing = self
            .servers
            .lock()
            .await
            .keys()
            .filter(|key| key.workspace_root == workspace_root)
            .cloned()
            .collect::<Vec<_>>();
        for key in existing {
            let configured = configured_servers.and_then(|servers| servers.get(&key.server_name));
            let target_state = match configured {
                None => Some(McpServerState::Stopped),
                Some(server) if server.get("enabled").and_then(Value::as_bool) == Some(false) => {
                    Some(McpServerState::Disabled)
                }
                Some(server) => {
                    let fingerprint =
                        serde_json::to_string(server).map_err(|error| McpRuntimeError {
                            server: key.server_name.clone(),
                            transport: server
                                .get("transport")
                                .and_then(Value::as_str)
                                .unwrap_or("stdio")
                                .to_string(),
                            message: format!(
                                "MCP server `{}` configuration is invalid: {error}",
                                key.server_name
                            ),
                            retryable: false,
                            cancelled: false,
                        })?;
                    self.servers
                        .lock()
                        .await
                        .get(&key)
                        .is_some_and(|managed| managed.fingerprint != fingerprint)
                        .then_some(McpServerState::Stopped)
                }
            };
            if let Some(state) = target_state {
                self.finish_server(&key, state, None).await?;
            }
        }
        Ok(())
    }

    fn config(
        &self,
        workspace_root: &Path,
        server_name: &str,
        server_config: &Value,
    ) -> Result<McpServerConfig, McpRuntimeError> {
        let transport = configured_transport(server_config);
        match transport.as_str() {
            "stdio" => parse_stdio_server_config(server_name, server_config, workspace_root)
                .map(McpServerConfig::Stdio)
                .map_err(|error| McpRuntimeError {
                    server: server_name.to_string(),
                    transport: error.transport,
                    message: error.message,
                    retryable: false,
                    cancelled: false,
                }),
            "http" | "streamable_http" | "streamable-http" => {
                parse_http_server_config(server_name, server_config)
                    .map(McpServerConfig::Http)
                    .map_err(|error| McpRuntimeError {
                        server: server_name.to_string(),
                        transport: error.transport,
                        message: error.message,
                        retryable: false,
                        cancelled: false,
                    })
            }
            unsupported => Err(McpRuntimeError {
                server: server_name.to_string(),
                transport: unsupported.to_string(),
                message: format!(
                    "MCP server `{server_name}` uses unsupported transport `{unsupported}`"
                ),
                retryable: false,
                cancelled: false,
            }),
        }
    }

    async fn record_configuration_failure(&self, key: &McpServerKey, error: &McpRuntimeError) {
        self.servers.lock().await.insert(
            key.clone(),
            ManagedServer::failed(
                String::new(),
                error.transport.clone(),
                Duration::ZERO,
                sanitize_error(&error.message),
            ),
        );
        self.record_transition(
            key,
            McpServerState::Failed,
            &error.transport,
            "configuration",
            0,
            Some("invalid_configuration"),
            Some(&error.message),
        )
        .await;
    }

    async fn ensure_client(
        &self,
        key: &McpServerKey,
        config: &McpServerConfig,
    ) -> Result<SharedClientService, McpRuntimeError> {
        let server_name = key.server_name.as_str();
        let previous = {
            let mut servers = self.servers.lock().await;
            if let Some(server) = servers.get(key) {
                if server.state == McpServerState::Ready
                    && server.fingerprint == config.fingerprint()
                {
                    if let Some(service) = &server.service {
                        return Ok(service.clone());
                    }
                }
                if server.state == McpServerState::Starting
                    && server.fingerprint == config.fingerprint()
                {
                    return Err(McpRuntimeError {
                        server: server_name.to_string(),
                        transport: config.transport().to_string(),
                        message: format!("MCP server `{server_name}` is still starting"),
                        retryable: true,
                        cancelled: false,
                    });
                }
            }
            let previous = servers.remove(key);
            servers.insert(
                key.clone(),
                ManagedServer::starting(
                    config.fingerprint().to_string(),
                    config.transport().to_string(),
                ),
            );
            previous
        };
        self.record_transition(
            key,
            McpServerState::Starting,
            config.transport(),
            "startup",
            0,
            None,
            None,
        )
        .await;
        if let Some(previous_service) = previous.and_then(|server| server.service) {
            close_service(previous_service)
                .await
                .map_err(|message| self.shutdown_error(server_name, config.transport(), message))?;
        }

        let started = Instant::now();
        let service = match self.start_client(server_name, config).await {
            Ok(service) => service,
            Err(error) => {
                let mut servers = self.servers.lock().await;
                servers.insert(
                    key.clone(),
                    ManagedServer::failed(
                        config.fingerprint().to_string(),
                        config.transport().to_string(),
                        started.elapsed(),
                        sanitize_error(&error.message),
                    ),
                );
                drop(servers);
                self.record_transition(
                    key,
                    McpServerState::Failed,
                    config.transport(),
                    "startup",
                    started.elapsed().as_millis(),
                    Some("startup_failed"),
                    Some(&error.message),
                )
                .await;
                return Err(error);
            }
        };
        let service = Arc::new(Mutex::new(service));
        self.servers.lock().await.insert(
            key.clone(),
            ManagedServer::ready(
                config.fingerprint().to_string(),
                config.transport().to_string(),
                started.elapsed(),
                service.clone(),
            ),
        );
        self.record_transition(
            key,
            McpServerState::Ready,
            config.transport(),
            "startup",
            started.elapsed().as_millis(),
            None,
            None,
        )
        .await;
        Ok(service)
    }

    async fn start_client(
        &self,
        server_name: &str,
        config: &McpServerConfig,
    ) -> Result<ClientService, McpRuntimeError> {
        match config {
            McpServerConfig::Stdio(config) => self.start_stdio_client(server_name, config).await,
            McpServerConfig::Http(config) => self.start_http_client(server_name, config).await,
        }
    }

    async fn start_stdio_client(
        &self,
        server_name: &str,
        config: &StdioServerConfig,
    ) -> Result<ClientService, McpRuntimeError> {
        let command = stdio_command(config).map_err(|error| McpRuntimeError {
            server: server_name.to_string(),
            transport: "stdio".to_string(),
            message: format!(
                "failed to resolve configured MCP stdio command ({:?})",
                error.kind()
            ),
            retryable: true,
            cancelled: false,
        })?;
        let (transport, _stderr) = TokioChildProcess::builder(command)
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| McpRuntimeError {
                server: server_name.to_string(),
                transport: "stdio".to_string(),
                message: sanitize_error(&format!("failed to start MCP stdio server: {error}")),
                retryable: true,
                cancelled: false,
            })?;
        tokio::time::timeout(
            config.startup_timeout,
            service::serve_client(mcp_client_info(), transport),
        )
        .await
        .map_err(|_| {
            self.timeout_error(server_name, "stdio", "initialize", config.startup_timeout)
        })?
        .map_err(|error| {
            self.operation_error(
                server_name,
                "stdio",
                "initialize",
                sanitize_error(&error.to_string()),
            )
        })
    }

    async fn start_http_client(
        &self,
        server_name: &str,
        config: &HttpServerConfig,
    ) -> Result<ClientService, McpRuntimeError> {
        let transport = StreamableHttpClientTransport::from_config(http_transport_config(config));
        tokio::time::timeout(
            config.startup_timeout,
            service::serve_client(mcp_client_info(), transport),
        )
        .await
        .map_err(|_| self.timeout_error(server_name, "http", "initialize", config.startup_timeout))?
        .map_err(|error| {
            self.operation_error(
                server_name,
                "http",
                "initialize",
                sanitize_error(&error.to_string()),
            )
        })
    }

    async fn stop_server(&self, key: &McpServerKey) -> Result<(), McpRuntimeError> {
        self.finish_server(key, McpServerState::Stopped, None).await
    }

    async fn fail_server(&self, key: &McpServerKey, message: &str) -> Result<(), McpRuntimeError> {
        self.finish_server(key, McpServerState::Failed, Some(sanitize_error(message)))
            .await
    }

    async fn finish_server(
        &self,
        key: &McpServerKey,
        final_state: McpServerState,
        last_error: Option<String>,
    ) -> Result<(), McpRuntimeError> {
        let (service, transport, elapsed_ms) = {
            let mut servers = self.servers.lock().await;
            let Some(server) = servers.get_mut(key) else {
                return Ok(());
            };
            server.state = McpServerState::Stopping;
            (
                server.service.take(),
                server.transport.clone(),
                server.elapsed_ms,
            )
        };
        self.record_transition(
            key,
            McpServerState::Stopping,
            &transport,
            "shutdown",
            elapsed_ms,
            None,
            None,
        )
        .await;
        if let Some(service) = service {
            if let Err(message) = close_service(service).await {
                let error = self.shutdown_error(&key.server_name, &transport, message);
                if let Some(server) = self.servers.lock().await.get_mut(key) {
                    server.state = McpServerState::Failed;
                    server.last_error = Some(error.message.clone());
                }
                self.record_transition(
                    key,
                    McpServerState::Failed,
                    &transport,
                    "shutdown",
                    elapsed_ms,
                    Some("shutdown_failed"),
                    Some(&error.message),
                )
                .await;
                return Err(error);
            }
        }
        if let Some(server) = self.servers.lock().await.get_mut(key) {
            server.state = final_state;
            server.last_error = last_error.clone();
        }
        let (error_code, error_message) = if final_state == McpServerState::Failed {
            (Some("runtime_failed"), last_error.as_deref())
        } else {
            (None, None)
        };
        self.record_transition(
            key,
            final_state,
            &transport,
            "shutdown",
            elapsed_ms,
            error_code,
            error_message,
        )
        .await;
        Ok(())
    }

    async fn record_transition(
        &self,
        key: &McpServerKey,
        state: McpServerState,
        transport: &str,
        phase: &str,
        elapsed_ms: u128,
        error_code: Option<&str>,
        message: Option<&str>,
    ) {
        let mut diagnostics = self.diagnostics.lock().await;
        if diagnostics.len() == 200 {
            diagnostics.pop_front();
        }
        diagnostics.push_back(json!({
            "serverId": key.server_name,
            "transport": transport,
            "state": state.as_str(),
            "phase": phase,
            "elapsedMs": elapsed_ms,
            "errorCode": error_code,
            "message": message.map(sanitize_error),
        }));
    }

    fn timeout_error(
        &self,
        server_name: &str,
        transport: &str,
        operation: &str,
        timeout: Duration,
    ) -> McpRuntimeError {
        McpRuntimeError {
            server: server_name.to_string(),
            transport: transport.to_string(),
            message: format!(
                "MCP server `{server_name}` timed out during {operation} after {} ms",
                timeout.as_millis()
            ),
            retryable: true,
            cancelled: false,
        }
    }

    fn operation_error(
        &self,
        server_name: &str,
        transport: &str,
        operation: &str,
        message: String,
    ) -> McpRuntimeError {
        McpRuntimeError {
            server: server_name.to_string(),
            transport: transport.to_string(),
            message: sanitize_error(&format!(
                "MCP server `{server_name}` failed during {operation}: {message}"
            )),
            retryable: true,
            cancelled: false,
        }
    }

    fn cancelled_error(&self, server_name: &str, transport: &str) -> McpRuntimeError {
        McpRuntimeError {
            server: server_name.to_string(),
            transport: transport.to_string(),
            message: "MCP tool call cancelled".to_string(),
            retryable: false,
            cancelled: true,
        }
    }

    fn shutdown_error(
        &self,
        server_name: &str,
        transport: &str,
        message: String,
    ) -> McpRuntimeError {
        McpRuntimeError {
            server: server_name.to_string(),
            transport: transport.to_string(),
            message: sanitize_error(&message),
            retryable: true,
            cancelled: false,
        }
    }
}

impl fmt::Debug for McpRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("McpRuntime").finish_non_exhaustive()
    }
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl McpServerKey {
    fn new(workspace_root: &Path, server_name: &str) -> Self {
        Self {
            workspace_root: workspace_root.to_path_buf(),
            server_name: server_name.to_string(),
        }
    }
}

impl ManagedServer {
    fn starting(fingerprint: String, transport: String) -> Self {
        Self {
            state: McpServerState::Starting,
            transport,
            fingerprint,
            service: None,
            tool_count: 0,
            elapsed_ms: 0,
            last_error: None,
        }
    }

    fn ready(
        fingerprint: String,
        transport: String,
        elapsed: Duration,
        service: SharedClientService,
    ) -> Self {
        Self {
            state: McpServerState::Ready,
            transport,
            fingerprint,
            service: Some(service),
            tool_count: 0,
            elapsed_ms: elapsed.as_millis(),
            last_error: None,
        }
    }

    fn failed(
        fingerprint: String,
        transport: String,
        elapsed: Duration,
        last_error: String,
    ) -> Self {
        Self {
            state: McpServerState::Failed,
            transport,
            fingerprint,
            service: None,
            tool_count: 0,
            elapsed_ms: elapsed.as_millis(),
            last_error: Some(last_error),
        }
    }

    fn status_value(&self) -> Value {
        json!({
            "state": self.state.as_str(),
            "transport": self.transport,
            "toolCount": self.tool_count,
            "elapsedMs": self.elapsed_ms,
            "lastError": self.last_error,
        })
    }
}

impl McpServerState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
        }
    }
}

async fn close_service(service: SharedClientService) -> Result<(), String> {
    let mut service = service.lock().await;
    match service.close_with_timeout(Duration::from_secs(5)).await {
        Ok(Some(_reason)) => Ok(()),
        Ok(None) => Err("MCP transport shutdown timed out".to_string()),
        Err(error) => Err(format!("MCP transport shutdown task failed: {error}")),
    }
}

async fn wait_for_cancellation(cancellation: Arc<dyn WorkerRequestCancellation>) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn mcp_client_info() -> ClientInfo {
    ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new("tinybot-mcp-client", env!("CARGO_PKG_VERSION")).with_title("Tinybot"),
    )
    .with_protocol_version(ProtocolVersion::V_2025_06_18)
}

fn configured_transport(server: &Value) -> String {
    server
        .get("transport")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|transport| !transport.is_empty())
        .unwrap_or("stdio")
        .to_ascii_lowercase()
}

fn sanitize_error(message: &str) -> String {
    message
        .replace(['\r', '\n'], " ")
        .chars()
        .take(500)
        .collect()
}

pub(crate) fn mcp_tool_is_enabled(server_name: &str, tool_name: &str, server: &Value) -> bool {
    let Some(enabled_tools) = server
        .get("enabled_tools")
        .or_else(|| server.get("enabledTools"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    let wrapped_name = format!("mcp_{server_name}_{tool_name}");
    enabled_tools.iter().any(|value| {
        value.as_str().is_some_and(|enabled| {
            enabled == "*" || enabled == tool_name || enabled == wrapped_name
        })
    })
}
