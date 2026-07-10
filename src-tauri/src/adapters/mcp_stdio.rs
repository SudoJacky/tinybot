use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const MAX_TIMEOUT_SECONDS: u64 = 300;

#[derive(Clone, Debug)]
pub(crate) struct StdioServerConfig {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) startup_timeout: Duration,
    pub(crate) call_timeout: Duration,
    pub(crate) fingerprint: String,
}

#[derive(Clone, Debug)]
pub(crate) struct StdioConfigError {
    pub(crate) message: String,
    pub(crate) transport: String,
}

pub(crate) fn parse_stdio_server_config(
    server_name: &str,
    server: &Value,
    workspace_root: &Path,
) -> Result<StdioServerConfig, StdioConfigError> {
    let transport = server
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .trim()
        .to_lowercase();
    if transport != "stdio" {
        return Err(StdioConfigError {
            message: format!("MCP server `{server_name}` uses unsupported transport `{transport}`"),
            transport,
        });
    }

    let command = server
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .ok_or_else(|| StdioConfigError {
            message: format!("MCP stdio server `{server_name}` requires a command"),
            transport: transport.clone(),
        })?
        .to_string();
    let args = match server.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(args)) => args
            .iter()
            .map(|arg| {
                arg.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| StdioConfigError {
                        message: format!(
                            "MCP stdio server `{server_name}` args must contain only strings"
                        ),
                        transport: transport.clone(),
                    })
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => {
            return Err(StdioConfigError {
                message: format!("MCP stdio server `{server_name}` args must be an array"),
                transport,
            });
        }
    };
    let cwd = server
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .map(PathBuf::from)
        .map(|cwd| {
            if cwd.is_absolute() {
                cwd
            } else {
                workspace_root.join(cwd)
            }
        })
        .unwrap_or_else(|| workspace_root.to_path_buf());
    if !cwd.is_dir() {
        return Err(StdioConfigError {
            message: format!(
                "MCP stdio server `{server_name}` working directory does not exist: {}",
                cwd.display()
            ),
            transport: transport.clone(),
        });
    }

    let env = match server.get("env") {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(env)) => env
            .iter()
            .map(|(key, value)| {
                value
                    .as_str()
                    .map(|value| (key.clone(), value.to_string()))
                    .ok_or_else(|| StdioConfigError {
                        message: format!(
                            "MCP stdio server `{server_name}` environment values must be strings"
                        ),
                        transport: transport.clone(),
                    })
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?,
        Some(_) => {
            return Err(StdioConfigError {
                message: format!("MCP stdio server `{server_name}` env must be an object"),
                transport,
            });
        }
    };
    let timeout_seconds = server
        .get("timeout_seconds")
        .or_else(|| server.get("timeoutSeconds"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
        .clamp(1, MAX_TIMEOUT_SECONDS);
    let startup_timeout_seconds = server
        .get("startup_timeout_seconds")
        .or_else(|| server.get("startupTimeoutSeconds"))
        .and_then(Value::as_u64)
        .unwrap_or(timeout_seconds)
        .clamp(1, MAX_TIMEOUT_SECONDS);
    let fingerprint = serde_json::to_string(server).map_err(|error| StdioConfigError {
        message: format!("MCP server `{server_name}` configuration is invalid: {error}"),
        transport: transport.clone(),
    })?;

    Ok(StdioServerConfig {
        command,
        args,
        cwd,
        env,
        startup_timeout: Duration::from_secs(startup_timeout_seconds),
        call_timeout: Duration::from_secs(timeout_seconds),
        fingerprint,
    })
}

pub(crate) fn stdio_command(
    config: &StdioServerConfig,
) -> std::io::Result<tokio::process::Command> {
    let mut command = rmcp::transport::which_command(&config.command)?;
    command
        .args(&config.args)
        .current_dir(&config.cwd)
        .envs(&config.env)
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    Ok(command)
}
