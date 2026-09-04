use crate::adapters::mcp_http::{
    http_transport_config, parse_http_server_config, HttpServerConfig,
};
use crate::adapters::mcp_stdio::{parse_stdio_server_config, stdio_command, StdioServerConfig};
use crate::protocol::WorkerRequestCancellation;
use futures_util::future::join_all;
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

type ClientService = RunningService<RoleClient, ClientInfo>;
type SharedClientService = Arc<Mutex<ClientService>>;
const MCP_REGISTRY_FAILURE_RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct McpRuntime {
    servers: Arc<Mutex<BTreeMap<McpServerKey, ManagedServer>>>,
    diagnostics: Arc<Mutex<VecDeque<Value>>>,
    registry_snapshots: Arc<Mutex<BTreeMap<PathBuf, Arc<McpRegistrySnapshot>>>>,
    registry_refresh: Arc<Mutex<()>>,
    registry_revision: Arc<AtomicU64>,
}

#[derive(Clone, Debug)]
pub(crate) struct McpRuntimeError {
    pub(crate) kind: McpRuntimeErrorKind,
    pub(crate) server: String,
    pub(crate) transport: String,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) cancelled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum McpRuntimeErrorKind {
    Configuration,
    InvalidArguments,
    ServerStarting,
    Timeout,
    Operation,
    Cancelled,
    Shutdown,
}

impl McpRuntimeErrorKind {
    pub(crate) fn reason_code(self) -> &'static str {
        match self {
            Self::Configuration => "mcp_configuration_invalid",
            Self::InvalidArguments => "mcp_arguments_invalid",
            Self::ServerStarting => "mcp_server_starting",
            Self::Timeout => "mcp_timed_out",
            Self::Operation => "mcp_operation_failed",
            Self::Cancelled => "mcp_call_cancelled",
            Self::Shutdown => "mcp_shutdown_failed",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct McpServerTools {
    pub(crate) server_id: String,
    pub(crate) server_config: Value,
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) stale: bool,
    pub(crate) status: Value,
    pub(crate) error: Option<String>,
    pub(crate) tools: Vec<McpRegistryTool>,
}

#[derive(Clone, Debug)]
pub(crate) struct McpRegistryTool {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) definition: Value,
    pub(crate) allowed: bool,
    pub(crate) default_selected: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct McpRegistrySnapshot {
    pub(crate) revision: u64,
    pub(crate) servers: Vec<McpServerTools>,
    config_fingerprint: String,
    refreshed_at: Instant,
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
            registry_snapshots: Arc::new(Mutex::new(BTreeMap::new())),
            registry_refresh: Arc::new(Mutex::new(())),
            registry_revision: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) async fn list_tools(
        &self,
        workspace_root: &Path,
        server_name: &str,
        server_config: &Value,
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Result<Vec<Value>, McpRuntimeError> {
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
        let service = self
            .ensure_client(&key, &config, cancellation.clone())
            .await?;
        let mut tools = Vec::new();
        let mut cursor = None;
        loop {
            let params = cursor
                .clone()
                .map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
            let request = async {
                let service = service.lock().await;
                service.list_tools(params).await
            };
            let response_result = if let Some(cancellation) = cancellation.clone() {
                tokio::select! {
                    result = tokio::time::timeout(config.call_timeout(), request) => Some(result),
                    _ = wait_for_cancellation(cancellation) => None,
                }
            } else {
                Some(tokio::time::timeout(config.call_timeout(), request).await)
            };
            let Some(response_result) = response_result else {
                let error = self.cancelled_error(server_name, config.transport());
                self.fail_server(&key, &error.message).await?;
                return Err(error);
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
        let service = self
            .ensure_client(&key, &config, cancellation.clone())
            .await?;
        let arguments = match arguments {
            Some(Value::Object(arguments)) => Some(arguments),
            Some(_) => {
                return Err(McpRuntimeError {
                    kind: McpRuntimeErrorKind::InvalidArguments,
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
        let Some(servers) = configured_mcp_servers(config_snapshot) else {
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

    pub(crate) async fn registry_snapshot(
        &self,
        workspace_root: &Path,
        config_snapshot: &Value,
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Result<Arc<McpRegistrySnapshot>, McpRuntimeError> {
        let config_fingerprint = registry_config_fingerprint(config_snapshot);
        if cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.is_cancelled())
        {
            return Err(self.cancelled_error("registry", "mixed"));
        }
        if let Some(snapshot) = self
            .cached_registry_snapshot(workspace_root, &config_fingerprint)
            .await
        {
            return Ok(snapshot);
        }

        // Serialize refreshes so UI catalog loads and Turns cannot race while starting
        // the same MCP server. Both callers receive the same published snapshot.
        let _refresh = self.registry_refresh.lock().await;
        if cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.is_cancelled())
        {
            return Err(self.cancelled_error("registry", "mixed"));
        }
        if let Some(snapshot) = self
            .cached_registry_snapshot(workspace_root, &config_fingerprint)
            .await
        {
            return Ok(snapshot);
        }
        let previous = self
            .registry_snapshots
            .lock()
            .await
            .get(workspace_root)
            .cloned();
        let configured = configured_mcp_servers(config_snapshot)
            .into_iter()
            .flat_map(|servers| servers.iter())
            .map(|(server_id, server_config)| (server_id.clone(), server_config.clone()))
            .collect::<Vec<_>>();
        let runtime = self.clone();
        let workspace_root = workspace_root.to_path_buf();
        let results = join_all(configured.into_iter().map(|(server_id, server_config)| {
            let runtime = runtime.clone();
            let workspace_root = workspace_root.clone();
            let cancellation = cancellation.clone();
            let previous = previous.clone();
            async move {
                runtime
                    .discover_registry_server(
                        &workspace_root,
                        server_id,
                        server_config,
                        previous.as_deref(),
                        cancellation,
                    )
                    .await
            }
        }))
        .await;
        let mut servers = Vec::with_capacity(results.len());
        for result in results {
            match result {
                Ok(server) => servers.push(server),
                Err(error) => return Err(error),
            }
        }
        servers.sort_by(|left, right| left.server_id.cmp(&right.server_id));
        let snapshot = Arc::new(McpRegistrySnapshot {
            revision: self.registry_revision.fetch_add(1, Ordering::Relaxed) + 1,
            servers,
            config_fingerprint,
            refreshed_at: Instant::now(),
        });
        self.registry_snapshots
            .lock()
            .await
            .insert(workspace_root, snapshot.clone());
        Ok(snapshot)
    }

    async fn cached_registry_snapshot(
        &self,
        workspace_root: &Path,
        config_fingerprint: &str,
    ) -> Option<Arc<McpRegistrySnapshot>> {
        self.registry_snapshots
            .lock()
            .await
            .get(workspace_root)
            .filter(|snapshot| {
                snapshot.config_fingerprint == config_fingerprint
                    && (snapshot
                        .servers
                        .iter()
                        .all(|server| !server.enabled || server.available)
                        || snapshot.refreshed_at.elapsed() < MCP_REGISTRY_FAILURE_RETRY_DELAY)
            })
            .cloned()
    }

    async fn discover_registry_server(
        &self,
        workspace_root: &Path,
        server_id: String,
        server_config: Value,
        previous: Option<&McpRegistrySnapshot>,
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Result<McpServerTools, McpRuntimeError> {
        let enabled = server_config.get("enabled").and_then(Value::as_bool) != Some(false);
        if !enabled {
            let transport = configured_transport(&server_config);
            return Ok(McpServerTools {
                server_id,
                server_config,
                enabled: false,
                available: false,
                stale: false,
                status: json!({
                    "state": "disabled",
                    "transport": transport,
                    "toolCount": 0,
                    "elapsedMs": 0,
                    "lastError": Value::Null,
                }),
                error: None,
                tools: Vec::new(),
            });
        }
        if let Some(server) = previous.and_then(|snapshot| {
            snapshot.servers.iter().find(|server| {
                server.server_id == server_id
                    && server.server_config == server_config
                    && server.available
            })
        }) {
            return Ok(server.clone());
        }
        if cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.is_cancelled())
        {
            return Err(self.cancelled_error(&server_id, &configured_transport(&server_config)));
        }

        match self
            .list_tools(workspace_root, &server_id, &server_config, cancellation)
            .await
        {
            Ok(definitions) => {
                let tools = definitions
                    .into_iter()
                    .map(|definition| {
                        normalize_registry_tool(&server_id, &server_config, definition)
                    })
                    .collect::<Result<Vec<_>, _>>();
                let mut tools = match tools {
                    Ok(tools) => tools,
                    Err(message) => {
                        let error = self.operation_error(
                            &server_id,
                            &configured_transport(&server_config),
                            "tools/list schema validation",
                            message,
                        );
                        self.fail_server(
                            &McpServerKey::new(workspace_root, &server_id),
                            &error.message,
                        )
                        .await?;
                        return Ok(self
                            .unavailable_registry_server(
                                workspace_root,
                                server_id,
                                server_config,
                                previous,
                                error.message,
                            )
                            .await);
                    }
                };
                tools.sort_by(|left, right| left.name.cmp(&right.name));
                let status = self.server_status(workspace_root, &server_id).await;
                Ok(McpServerTools {
                    server_id,
                    server_config,
                    enabled: true,
                    available: true,
                    stale: false,
                    status,
                    error: None,
                    tools,
                })
            }
            Err(error) if error.cancelled => Err(error),
            Err(error) => Ok(self
                .unavailable_registry_server(
                    workspace_root,
                    server_id,
                    server_config,
                    previous,
                    error.message,
                )
                .await),
        }
    }

    async fn unavailable_registry_server(
        &self,
        workspace_root: &Path,
        server_id: String,
        server_config: Value,
        previous: Option<&McpRegistrySnapshot>,
        error: String,
    ) -> McpServerTools {
        let tools = previous
            .and_then(|snapshot| {
                snapshot.servers.iter().find(|server| {
                    server.server_id == server_id && server.server_config == server_config
                })
            })
            .map(|server| server.tools.clone())
            .unwrap_or_default();
        let status = self.server_status(workspace_root, &server_id).await;
        McpServerTools {
            server_id,
            server_config,
            enabled: true,
            available: false,
            stale: !tools.is_empty(),
            status,
            error: Some(error),
            tools,
        }
    }

    pub(crate) async fn reconcile(
        &self,
        workspace_root: &Path,
        config_snapshot: &Value,
    ) -> Result<(), McpRuntimeError> {
        let configured_servers = configured_mcp_servers(config_snapshot);
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
                            kind: McpRuntimeErrorKind::Configuration,
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
                    kind: McpRuntimeErrorKind::Configuration,
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
                        kind: McpRuntimeErrorKind::Configuration,
                        server: server_name.to_string(),
                        transport: error.transport,
                        message: error.message,
                        retryable: false,
                        cancelled: false,
                    })
            }
            unsupported => Err(McpRuntimeError {
                kind: McpRuntimeErrorKind::Configuration,
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
        self.mark_registry_server_unavailable(key, McpServerState::Failed, Some(&error.message))
            .await;
    }

    async fn ensure_client(
        &self,
        key: &McpServerKey,
        config: &McpServerConfig,
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Result<SharedClientService, McpRuntimeError> {
        let server_name = key.server_name.as_str();
        if cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.is_cancelled())
        {
            return Err(self.cancelled_error(server_name, config.transport()));
        }
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
                        kind: McpRuntimeErrorKind::ServerStarting,
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

        if cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.is_cancelled())
        {
            let error = self.cancelled_error(server_name, config.transport());
            self.finish_server(key, McpServerState::Failed, Some(error.message.clone()))
                .await?;
            return Err(error);
        }

        let started = Instant::now();
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        metrics.increment("mcp.server.start.requested");
        let startup = self.start_client(server_name, config);
        let startup_result = if let Some(cancellation) = cancellation {
            tokio::select! {
                result = startup => result,
                _ = wait_for_cancellation(cancellation) => {
                    Err(self.cancelled_error(server_name, config.transport()))
                }
            }
        } else {
            startup.await
        };
        let service = match startup_result {
            Ok(service) => service,
            Err(error) => {
                metrics.record_duration("mcp.server.start.durationMs", started.elapsed());
                metrics.increment(if error.cancelled {
                    "mcp.server.start.cancelled"
                } else {
                    "mcp.server.start.failed"
                });
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
                    Some(if error.cancelled {
                        "cancelled"
                    } else {
                        "startup_failed"
                    }),
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
        metrics.record_duration("mcp.server.start.durationMs", started.elapsed());
        metrics.increment("mcp.server.start.completed");
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
            kind: McpRuntimeErrorKind::Operation,
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
                kind: McpRuntimeErrorKind::Operation,
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
        let shutdown_started = Instant::now();
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
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        metrics.increment("mcp.server.stop.requested");
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
                metrics.record_duration("mcp.server.stop.durationMs", shutdown_started.elapsed());
                metrics.increment("mcp.server.stop.failed");
                self.mark_registry_server_unavailable(
                    key,
                    McpServerState::Failed,
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
        metrics.record_duration("mcp.server.stop.durationMs", shutdown_started.elapsed());
        metrics.increment("mcp.server.stop.completed");
        self.mark_registry_server_unavailable(key, final_state, last_error.as_deref())
            .await;
        Ok(())
    }

    async fn mark_registry_server_unavailable(
        &self,
        key: &McpServerKey,
        state: McpServerState,
        error: Option<&str>,
    ) {
        let mut snapshots = self.registry_snapshots.lock().await;
        let Some(current) = snapshots.get(&key.workspace_root) else {
            return;
        };
        let mut next = (**current).clone();
        let Some(server) = next
            .servers
            .iter_mut()
            .find(|server| server.server_id == key.server_name)
        else {
            return;
        };
        server.available = false;
        server.stale = !server.tools.is_empty();
        server.error = error.map(sanitize_error);
        if let Some(status) = server.status.as_object_mut() {
            status.insert("state".to_string(), json!(state.as_str()));
            status.insert("lastError".to_string(), json!(server.error));
        }
        next.revision = self.registry_revision.fetch_add(1, Ordering::Relaxed) + 1;
        next.refreshed_at = Instant::now();
        snapshots.insert(key.workspace_root.clone(), Arc::new(next));
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
            kind: McpRuntimeErrorKind::Timeout,
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
            kind: McpRuntimeErrorKind::Operation,
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
            kind: McpRuntimeErrorKind::Cancelled,
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
            kind: McpRuntimeErrorKind::Shutdown,
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

pub(crate) fn configured_mcp_servers(
    config_snapshot: &Value,
) -> Option<&serde_json::Map<String, Value>> {
    config_snapshot
        .get("tools")
        .and_then(|tools| tools.get("mcp_servers").or_else(|| tools.get("mcpServers")))
        .or_else(|| {
            config_snapshot
                .get("mcp")
                .and_then(|mcp| mcp.get("servers"))
        })
        .and_then(Value::as_object)
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

fn normalize_registry_tool(
    server_name: &str,
    server: &Value,
    mut definition: Value,
) -> Result<McpRegistryTool, String> {
    let tool_name = definition
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("MCP server `{server_name}` returned a tool without a name"))?
        .to_string();
    let mut input_schema = definition
        .get("inputSchema")
        .or_else(|| definition.get("input_schema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));
    let input = input_schema.as_object_mut().ok_or_else(|| {
        format!("MCP tool `{server_name}.{tool_name}` input schema must be a JSON object")
    })?;
    if let Some(schema_type) = input.get("type") {
        if schema_type.as_str() != Some("object") {
            return Err(format!(
                "MCP tool `{server_name}.{tool_name}` input schema type must be object"
            ));
        }
    } else {
        input.insert("type".to_string(), Value::String("object".to_string()));
    }
    let output_schema = definition
        .get("outputSchema")
        .or_else(|| definition.get("output_schema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));
    if !output_schema.is_object() {
        return Err(format!(
            "MCP tool `{server_name}.{tool_name}` output schema must be a JSON object"
        ));
    }
    let definition_object = definition.as_object_mut().ok_or_else(|| {
        format!("MCP server `{server_name}` returned a non-object tool definition")
    })?;
    definition_object.insert("inputSchema".to_string(), input_schema);
    definition_object.insert("outputSchema".to_string(), output_schema);
    let allowed = mcp_tool_is_enabled(server_name, &tool_name, server);
    Ok(McpRegistryTool {
        id: mcp_tool_id(server_name, &tool_name),
        name: tool_name,
        definition,
        allowed,
        default_selected: allowed,
    })
}

pub(crate) fn mcp_tool_id(server_name: &str, tool_name: &str) -> String {
    format!(
        "mcp.{}:{server_name}.{}:{tool_name}",
        server_name.len(),
        tool_name.len()
    )
}

fn registry_config_fingerprint(config_snapshot: &Value) -> String {
    serde_json::to_string(&configured_mcp_servers(config_snapshot)).unwrap_or_default()
}
