use super::store::PluginStore;
use serde_json::{Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn merge_enabled_mcp_servers(config: &mut Value) -> Result<(), String> {
    let store = PluginStore::default_global();
    merge_enabled_mcp_servers_from_store(config, &store)
}

fn merge_enabled_mcp_servers_from_store(
    config: &mut Value,
    store: &PluginStore,
) -> Result<(), String> {
    let plugins = store.enabled_with_revisions()?;
    if plugins.is_empty() {
        return Ok(());
    }
    let config_object = config
        .as_object_mut()
        .ok_or_else(|| "Tinybot config snapshot must be an object".to_string())?;
    let tools = config_object
        .entry("tools")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Tinybot config field `tools` must be an object".to_string())?;
    let servers = tools
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Tinybot config field `tools.mcpServers` must be an object".to_string())?;

    for enabled_plugin in plugins {
        let plugin = enabled_plugin.plugin;
        let data_root = store.data_directory(&plugin.manifest.name);
        for server in plugin.mcp_servers {
            let qualified_name = server.qualified_name();
            match normalize_server(&plugin.root, &data_root, &server.config) {
                Ok(mut normalized) => {
                    normalized["plugin_install_revision"] =
                        Value::from(enabled_plugin.install_revision);
                    servers.insert(qualified_name, normalized);
                }
                Err(error) => {
                    eprintln!("plugin_mcp_server_skipped server={qualified_name} error={error}")
                }
            }
        }
    }
    Ok(())
}

fn normalize_server(plugin_root: &Path, data_root: &Path, config: &Value) -> Result<Value, String> {
    let transport = config
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing transport type".to_string())?;
    match transport {
        "stdio" => normalize_stdio_server(plugin_root, data_root, config),
        "streamable-http" => Ok(serde_json::json!({
            "transport": "streamable-http",
            "url": config.get("url").cloned().unwrap_or(Value::Null),
            "headers": config.get("headers").cloned().unwrap_or_else(|| serde_json::json!({})),
            "enabled": true,
            "enabled_tools": ["*"]
        })),
        unsupported => Err(format!("unsupported transport `{unsupported}`")),
    }
}

fn normalize_stdio_server(
    plugin_root: &Path,
    data_root: &Path,
    config: &Value,
) -> Result<Value, String> {
    fs::create_dir_all(data_root).map_err(|error| {
        format!(
            "failed to create plugin data directory {}: {error}",
            data_root.display()
        )
    })?;
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing command".to_string())?;
    let command = if let Some(relative) = command.strip_prefix("./") {
        canonical_contained(plugin_root, &plugin_root.join(relative))?
            .display()
            .to_string()
    } else {
        command.to_string()
    };
    let plugin_root_text = plugin_root.display().to_string();
    let data_root_text = data_root.display().to_string();
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|value| expand_plugin_variables(value, &plugin_root_text, &data_root_text))
        .collect::<Vec<_>>();
    let mut env = config
        .get("env")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| {
            value.as_str().map(|value| {
                (
                    key.clone(),
                    Value::String(expand_plugin_variables(
                        value,
                        &plugin_root_text,
                        &data_root_text,
                    )),
                )
            })
        })
        .collect::<Map<_, _>>();
    env.insert(
        "PLUGIN_ROOT".to_string(),
        Value::String(plugin_root_text.clone()),
    );
    env.insert(
        "PLUGIN_DATA".to_string(),
        Value::String(data_root_text.clone()),
    );
    let cwd = resolve_cwd(
        plugin_root,
        data_root,
        config.get("cwd").and_then(Value::as_str),
    )?;
    Ok(serde_json::json!({
        "transport": "stdio",
        "agent_plugin": true,
        "command": command,
        "args": args,
        "env": env,
        "cwd": cwd.display().to_string(),
        "enabled": true,
        "enabled_tools": ["*"]
    }))
}

fn resolve_cwd(
    plugin_root: &Path,
    data_root: &Path,
    configured: Option<&str>,
) -> Result<PathBuf, String> {
    let Some(configured) = configured else {
        return Ok(plugin_root.to_path_buf());
    };
    if configured == "${PLUGIN_ROOT}" {
        return Ok(plugin_root.to_path_buf());
    }
    if configured == "${PLUGIN_DATA}" {
        return Ok(data_root.to_path_buf());
    }
    if let Some(relative) = configured.strip_prefix("./") {
        return canonical_contained(plugin_root, &plugin_root.join(relative));
    }
    if let Some(relative) = configured.strip_prefix("${PLUGIN_ROOT}/") {
        return canonical_contained(plugin_root, &plugin_root.join(relative));
    }
    if let Some(relative) = configured.strip_prefix("${PLUGIN_DATA}/") {
        let target = data_root.join(relative);
        fs::create_dir_all(&target).map_err(|error| {
            format!(
                "failed to create plugin data working directory {}: {error}",
                target.display()
            )
        })?;
        return canonical_contained(data_root, &target);
    }
    Err("working directory does not use a supported plugin root".to_string())
}

fn canonical_contained(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?;
    let resolved_root = root
        .canonicalize()
        .map_err(|error| format!("failed to resolve {}: {error}", root.display()))?;
    if !resolved.starts_with(&resolved_root) {
        return Err(format!("path escapes permitted root: {}", path.display()));
    }
    Ok(resolved)
}

fn expand_plugin_variables(value: &str, plugin_root: &str, data_root: &str) -> String {
    value
        .replace("${PLUGIN_ROOT}", plugin_root)
        .replace("${PLUGIN_DATA}", data_root)
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
