use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const MAX_TIMEOUT_SECONDS: u64 = 300;

#[derive(Clone)]
pub(crate) struct StdioServerConfig {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) startup_timeout: Duration,
    pub(crate) call_timeout: Duration,
    pub(crate) fingerprint: String,
}

impl fmt::Debug for StdioServerConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StdioServerConfig")
            .field("command", &"<configured>")
            .field("args_count", &self.args.len())
            .field("cwd", &self.cwd)
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .field("startup_timeout", &self.startup_timeout)
            .field("call_timeout", &self.call_timeout)
            .finish_non_exhaustive()
    }
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

    let mut env = match server.get("env") {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(env)) => env
            .iter()
            .map(|(key, value)| {
                if is_sensitive_env_key(key) {
                    return Err(StdioConfigError {
                        message: format!(
                            "MCP stdio server `{server_name}` environment `{key}` is sensitive; set it through env_var_refs"
                        ),
                        transport: transport.clone(),
                    });
                }
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
    let env_var_refs = server
        .get("envVarRefs")
        .or_else(|| server.get("env_var_refs"));
    match env_var_refs {
        None | Some(Value::Null) => {}
        Some(Value::Object(references)) => {
            for (child_key, host_env) in references {
                if env.contains_key(child_key) {
                    return Err(StdioConfigError {
                        message: format!(
                            "MCP stdio server `{server_name}` environment `{child_key}` cannot be set in both env and env_var_refs"
                        ),
                        transport: transport.clone(),
                    });
                }
                let host_env = host_env
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| StdioConfigError {
                        message: format!(
                            "MCP stdio server `{server_name}` env_var_refs values must be non-empty strings"
                        ),
                        transport: transport.clone(),
                    })?;
                let value = required_env_value(server_name, child_key, host_env, &transport)?;
                env.insert(child_key.clone(), value);
            }
        }
        Some(_) => {
            return Err(StdioConfigError {
                message: format!("MCP stdio server `{server_name}` env_var_refs must be an object"),
                transport,
            });
        }
    }
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

fn is_sensitive_env_key(key: &str) -> bool {
    let compact = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "token",
        "secret",
        "password",
        "authorization",
        "credentials",
        "apikey",
    ]
    .iter()
    .any(|suffix| compact.ends_with(suffix))
}

fn required_env_value(
    server_name: &str,
    child_key: &str,
    host_env: &str,
    transport: &str,
) -> Result<String, StdioConfigError> {
    match std::env::var(host_env) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        Ok(_) => Err(StdioConfigError {
            message: format!(
                "Environment variable `{host_env}` for MCP stdio server `{server_name}` environment `{child_key}` is empty"
            ),
            transport: transport.to_string(),
        }),
        Err(std::env::VarError::NotPresent) => Err(StdioConfigError {
            message: format!(
                "Environment variable `{host_env}` for MCP stdio server `{server_name}` environment `{child_key}` is not set"
            ),
            transport: transport.to_string(),
        }),
        Err(std::env::VarError::NotUnicode(_)) => Err(StdioConfigError {
            message: format!(
                "Environment variable `{host_env}` for MCP stdio server `{server_name}` environment `{child_key}` is not valid Unicode"
            ),
            transport: transport.to_string(),
        }),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_inline_sensitive_environment_values_without_echoing_them() {
        let secret = "mcp-inline-secret-must-not-leak";
        let error = parse_stdio_server_config(
            "private",
            &json!({
                "transport": "stdio",
                "command": "node",
                "env": { "PRIVATE_TOKEN": secret }
            }),
            &std::env::temp_dir(),
        )
        .expect_err("inline sensitive environment values should be rejected");

        assert!(error.message.contains("env_var_refs"));
        assert!(error.message.contains("PRIVATE_TOKEN"));
        assert!(!error.message.contains(secret));
    }

    #[test]
    fn resolves_sensitive_child_environment_from_named_host_reference() {
        let host_env = format!("TINYBOT_MCP_STDIO_TOKEN_{}", std::process::id());
        let _guard = ScopedEnv::set(&host_env, "resolved-private-token");

        let config = parse_stdio_server_config(
            "private",
            &json!({
                "transport": "stdio",
                "command": "node",
                "env": { "LOG_LEVEL": "debug" },
                "envVarRefs": { "PRIVATE_TOKEN": host_env }
            }),
            &std::env::temp_dir(),
        )
        .expect("environment references should resolve before process startup");

        assert_eq!(
            config.env.get("LOG_LEVEL").map(String::as_str),
            Some("debug")
        );
        assert_eq!(
            config.env.get("PRIVATE_TOKEN").map(String::as_str),
            Some("resolved-private-token")
        );
        let debug = format!("{config:?}");
        assert!(debug.contains("PRIVATE_TOKEN"));
        assert!(!debug.contains("resolved-private-token"));
    }

    struct ScopedEnv {
        name: String,
    }

    impl ScopedEnv {
        fn set(name: &str, value: &str) -> Self {
            std::env::set_var(name, value);
            Self {
                name: name.to_string(),
            }
        }
    }

    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            std::env::remove_var(&self.name);
        }
    }
}
