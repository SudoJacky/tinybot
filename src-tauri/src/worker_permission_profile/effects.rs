use crate::worker_capability::WorkerCapability;
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use crate::worker_tool_registry::{ToolExecutionTarget, ToolRegistryEntry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

const CURRENT_WORKSPACE: &str = "workspace://current";

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEffects {
    pub filesystem: PermissionFilesystemEffects,
    pub network: PermissionNetworkEffects,
    pub process: PermissionProcessEffects,
    pub environment: PermissionEnvironmentEffects,
    pub mcp: Vec<String>,
    pub mutates_session: bool,
    pub mutates_background: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<ShellSandboxMode>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionFilesystemEffects {
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionNetworkEffects {
    pub mode: PermissionNetworkMode,
    pub destinations: Vec<String>,
}

impl Default for PermissionNetworkEffects {
    fn default() -> Self {
        Self {
            mode: PermissionNetworkMode::Denied,
            destinations: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionNetworkMode {
    #[default]
    Denied,
    Configured,
    Unrestricted,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProcessEffects {
    pub execute: bool,
    pub interactive: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEnvironmentEffects {
    pub inherit: bool,
    pub secret_scopes: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellSandboxMode {
    ReadOnly,
    #[default]
    Unsandboxed,
}

pub fn normalize_tool_effects(
    tool: &ToolRegistryEntry,
    arguments: &Value,
) -> Result<PermissionEffects, WorkerProtocolError> {
    let mut effects = effects_from_capabilities(tool);
    effects.mutates_session = tool.runtime_policy.mutates_session;

    match tool.method.as_str() {
        "shell.execute" | "exec_command" => {
            let sandbox_mode = parse_shell_sandbox_mode(arguments)?;
            let network_mode = parse_network_mode(arguments)?;
            effects = shell_permission_effects(
                sandbox_mode,
                network_mode,
                bool_argument(arguments, "tty", "tty").unwrap_or(false),
            );
        }
        "write_stdin" => {
            effects.filesystem.read_roots = vec!["filesystem://unrestricted".to_string()];
            effects.filesystem.write_roots = vec!["filesystem://unrestricted".to_string()];
            effects.network.mode = PermissionNetworkMode::Unrestricted;
            effects.network.destinations = vec!["network://unrestricted".to_string()];
            effects.process.interactive = true;
            effects.environment.inherit = true;
            effects.environment.secret_scopes = vec!["environment://ambient-process".to_string()];
        }
        "workspace.read_file" => {
            effects.filesystem.read_roots = vec![workspace_path(arguments, "path")];
        }
        "workspace.write_file" | "workspace.delete_file" | "workspace.create_dir" => {
            effects = workspace_write_permission_effects(
                string_argument(arguments, "path", "path")
                    .as_deref()
                    .unwrap_or("."),
            );
        }
        "workspace.apply_patch" => {
            effects = workspace_patch_permission_effects();
        }
        "mcp.call_tool" => {
            let server = string_argument(arguments, "server", "server")
                .unwrap_or_else(|| "configured".to_string());
            let tool_name =
                string_argument(arguments, "tool", "tool").unwrap_or_else(|| "unknown".to_string());
            effects = mcp_permission_effects(&server, &tool_name);
        }
        method if method.starts_with("subagent.") => {
            effects.mutates_session = true;
            effects.mutates_background = true;
        }
        _ => {
            if let ToolExecutionTarget::Mcp { server, tool } = &tool.execution_target {
                effects.network.mode = PermissionNetworkMode::Configured;
                effects.network.destinations = vec![format!("mcp://{server}")];
                effects.mcp = vec![format!("{server}.{tool}")];
                effects.environment.secret_scopes = vec![format!("provider://mcp/{server}")];
            }
        }
    }

    normalize_effect_lists(&mut effects);
    Ok(effects)
}

pub fn shell_permission_effects(
    sandbox_mode: ShellSandboxMode,
    network_mode: PermissionNetworkMode,
    interactive: bool,
) -> PermissionEffects {
    let mut effects = PermissionEffects {
        sandbox_mode: Some(sandbox_mode),
        ..PermissionEffects::default()
    };
    effects.filesystem.read_roots = vec!["filesystem://unrestricted".to_string()];
    effects.filesystem.write_roots = match sandbox_mode {
        #[cfg(target_os = "windows")]
        ShellSandboxMode::ReadOnly => vec!["windows://low-integrity".to_string()],
        #[cfg(not(target_os = "windows"))]
        ShellSandboxMode::ReadOnly => Vec::new(),
        ShellSandboxMode::Unsandboxed => vec!["filesystem://unrestricted".to_string()],
    };
    effects.network.mode = network_mode;
    effects.network.destinations = match network_mode {
        PermissionNetworkMode::Denied => Vec::new(),
        PermissionNetworkMode::Configured => vec!["network://configured".to_string()],
        PermissionNetworkMode::Unrestricted => vec!["network://unrestricted".to_string()],
    };
    effects.process.execute = true;
    effects.process.interactive = interactive;
    effects.environment.inherit = true;
    effects.environment.secret_scopes = vec!["environment://ambient-process".to_string()];
    effects
}

pub fn workspace_write_permission_effects(path: &str) -> PermissionEffects {
    let mut effects = PermissionEffects::default();
    effects.filesystem.read_roots = vec![CURRENT_WORKSPACE.to_string()];
    effects.filesystem.write_roots = vec![workspace_path_value(path)];
    effects
}

pub fn workspace_patch_permission_effects() -> PermissionEffects {
    let mut effects = PermissionEffects::default();
    effects.filesystem.read_roots = vec![CURRENT_WORKSPACE.to_string()];
    effects.filesystem.write_roots = vec![CURRENT_WORKSPACE.to_string()];
    effects
}

pub fn mcp_permission_effects(server: &str, tool: &str) -> PermissionEffects {
    let server = server.trim();
    let tool = tool.trim();
    let mut effects = PermissionEffects::default();
    effects.network.mode = PermissionNetworkMode::Configured;
    effects.network.destinations = vec![format!("mcp://{server}")];
    effects.mcp = vec![format!("{server}.{tool}")];
    effects.environment.secret_scopes = vec![format!("provider://mcp/{server}")];
    effects
}

pub fn permission_fingerprint(
    prefix: &str,
    operation: &str,
    effects: &PermissionEffects,
) -> String {
    let normalized_operation = operation.replace("\r\n", "\n");
    let normalized_operation = normalized_operation.trim();
    let canonical_effects = canonical_effects(effects);
    let fingerprint_input = format!("{prefix}\0{normalized_operation}\0{canonical_effects}");
    format!(
        "{prefix}:sha256:{}",
        sha256_hex(fingerprint_input.as_bytes())
    )
}

pub fn normalize_permission_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        normalized
    }
}

pub fn normalize_permission_effects(mut effects: PermissionEffects) -> PermissionEffects {
    normalize_effect_lists(&mut effects);
    effects
}

fn effects_from_capabilities(tool: &ToolRegistryEntry) -> PermissionEffects {
    let mut effects = PermissionEffects::default();
    for capability in &tool.required_capabilities {
        match capability {
            WorkerCapability::FsWorkspaceRead => effects
                .filesystem
                .read_roots
                .push(CURRENT_WORKSPACE.to_string()),
            WorkerCapability::FsWorkspaceWrite => effects
                .filesystem
                .write_roots
                .push(CURRENT_WORKSPACE.to_string()),
            WorkerCapability::NetworkOpenAi => {
                effects.network.mode = PermissionNetworkMode::Configured;
                effects
                    .network
                    .destinations
                    .push("provider://configured".to_string());
            }
            WorkerCapability::ProviderSecretRead => effects
                .environment
                .secret_scopes
                .push("provider://runtime".to_string()),
            WorkerCapability::McpCall => {
                effects.network.mode = PermissionNetworkMode::Configured;
            }
            WorkerCapability::ShellExecute => effects.process.execute = true,
            WorkerCapability::SessionWrite => effects.mutates_session = true,
            WorkerCapability::BackgroundWrite => effects.mutates_background = true,
            _ => {}
        }
    }
    effects
}

fn parse_shell_sandbox_mode(arguments: &Value) -> Result<ShellSandboxMode, WorkerProtocolError> {
    match string_argument(arguments, "sandboxMode", "sandbox_mode").as_deref() {
        None | Some("unsandboxed") => Ok(ShellSandboxMode::Unsandboxed),
        Some("read_only") => Ok(ShellSandboxMode::ReadOnly),
        Some(value) => Err(invalid_effect_request(
            "sandboxMode must be read_only or unsandboxed",
            serde_json::json!({ "sandboxMode": value }),
        )),
    }
}

fn parse_network_mode(arguments: &Value) -> Result<PermissionNetworkMode, WorkerProtocolError> {
    match string_argument(arguments, "networkMode", "network_mode").as_deref() {
        None | Some("unrestricted") => Ok(PermissionNetworkMode::Unrestricted),
        Some("denied") => Ok(PermissionNetworkMode::Denied),
        Some("configured") => Ok(PermissionNetworkMode::Configured),
        Some(value) => Err(invalid_effect_request(
            "networkMode must be denied, configured, or unrestricted",
            serde_json::json!({ "networkMode": value }),
        )),
    }
}

fn workspace_path(arguments: &Value, key: &str) -> String {
    let Some(path) = arguments.get(key).and_then(Value::as_str) else {
        return CURRENT_WORKSPACE.to_string();
    };
    workspace_path_value(path)
}

fn workspace_path_value(path: &str) -> String {
    let normalized = normalize_permission_path(path);
    let normalized = normalized.trim_matches('/');
    if normalized.is_empty() || normalized == "." {
        CURRENT_WORKSPACE.to_string()
    } else {
        format!("{CURRENT_WORKSPACE}/{normalized}")
    }
}

fn string_argument(arguments: &Value, camel: &str, snake: &str) -> Option<String> {
    arguments
        .get(camel)
        .or_else(|| arguments.get(snake))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_argument(arguments: &Value, camel: &str, snake: &str) -> Option<bool> {
    arguments
        .get(camel)
        .or_else(|| arguments.get(snake))
        .and_then(Value::as_bool)
}

fn normalize_effect_lists(effects: &mut PermissionEffects) {
    sort_and_deduplicate(&mut effects.filesystem.read_roots);
    sort_and_deduplicate(&mut effects.filesystem.write_roots);
    sort_and_deduplicate(&mut effects.network.destinations);
    sort_and_deduplicate(&mut effects.environment.secret_scopes);
    sort_and_deduplicate(&mut effects.mcp);
}

fn sort_and_deduplicate(values: &mut Vec<String>) {
    values.sort();
    values.dedup();
}

fn canonical_effects(effects: &PermissionEffects) -> String {
    let normalized = normalize_permission_effects(effects.clone());
    serde_json::to_string(&normalized).expect("permission effects should serialize")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String should not fail");
    }
    encoded
}

fn invalid_effect_request(message: &str, details: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
