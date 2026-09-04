use crate::config::application::{
    apply_config_operations_to_path, config_editor_snapshot_from_path,
    native_config_snapshot_from_path, native_default_config_snapshot,
};
use crate::config::store::{ConfigOperation, ConfigOperationRequest};
use crate::runtime::mcp::configured_mcp_servers;
use http::{HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

const MAX_SERVER_NAME_LENGTH: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpConfigUpsertInput {
    name: String,
    expected_revision: String,
    server: McpConfigServerInput,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "transport",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum McpConfigServerInput {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        env_var_refs: BTreeMap<String, String>,
        cwd: Option<String>,
    },
    #[serde(rename = "streamable-http")]
    StreamableHttp {
        url: String,
        bearer_token_env_var: Option<String>,
        #[serde(default)]
        http_headers: BTreeMap<String, String>,
        #[serde(default)]
        env_http_headers: BTreeMap<String, String>,
    },
}

pub(crate) fn list_global_mcp_config_at_path(config_path: &Path) -> Result<Value, String> {
    let editor = config_editor_snapshot_from_path(config_path, native_default_config_snapshot())
        .map_err(|error| format!("failed to read Tinybot configuration: {error}"))?;
    let snapshot = native_config_snapshot_from_path(config_path);
    let mut servers = configured_mcp_servers(&snapshot)
        .map(|servers| {
            servers
                .iter()
                .map(|(name, server)| project_server(name, server))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    servers.sort_by(|left, right| {
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
    Ok(json!({
        "revision": editor.revision,
        "servers": servers,
        "diagnostics": editor.diagnostics.into_iter().map(|diagnostic| json!({
            "level": diagnostic.level,
            "code": diagnostic.code,
            "message": diagnostic.message,
        })).collect::<Vec<_>>(),
    }))
}

pub(crate) fn upsert_global_mcp_config_at_path(
    config_path: &Path,
    input: McpConfigUpsertInput,
) -> Result<Value, String> {
    let name = validate_mcp_server_name(&input.name)?;
    let expected_revision = input.expected_revision.trim();
    if expected_revision.is_empty() {
        return Err(
            "expectedRevision must be a non-empty revision returned by mcp.config.list".to_string(),
        );
    }

    let editor = config_editor_snapshot_from_path(config_path, native_default_config_snapshot())
        .map_err(|error| format!("failed to read Tinybot configuration: {error}"))?;
    if let Some(diagnostic) = editor.diagnostics.iter().find(|diagnostic| {
        matches!(
            diagnostic.code,
            crate::config::store::ConfigDiagnosticCode::InvalidJson
                | crate::config::store::ConfigDiagnosticCode::InvalidConfig
                | crate::config::store::ConfigDiagnosticCode::AliasConflict
        )
    }) {
        return Err(format!(
            "Tinybot configuration must be repaired before updating MCP servers: {}",
            diagnostic.message
        ));
    }
    let current = native_config_snapshot_from_path(config_path);
    if let Some(existing) = configured_mcp_servers(&current).and_then(|servers| servers.get(&name))
    {
        reject_hidden_existing_secrets(&name, existing)?;
    }
    let server = normalize_server(&name, input.server)?;
    let path = format!("/tools/mcpServers/{}", escape_json_pointer_segment(&name));
    let result = apply_config_operations_to_path(
        config_path,
        native_default_config_snapshot(),
        ConfigOperationRequest {
            expected_revision: Some(expected_revision.to_string()),
            operations: vec![ConfigOperation::Replace {
                path,
                value: server,
            }],
        },
    )
    .map_err(|error| format!("failed to save MCP server `{name}`: {error}"))?;

    if !result.ok {
        let error = result
            .error
            .unwrap_or_else(|| "configuration update was rejected".to_string());
        let current_revision = result.revision.unwrap_or_default();
        return Err(if error == "configuration_changed" {
            format!(
                "MCP configuration changed since it was read; call mcp.config.list again and retry with revision `{current_revision}`"
            )
        } else {
            format!("failed to save MCP server `{name}`: {error}")
        });
    }

    Ok(json!({
        "configured": true,
        "name": name,
        "revision": result.revision,
        "updatedFields": result.updated_fields,
    }))
}

pub(crate) fn validate_mcp_server_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_SERVER_NAME_LENGTH {
        return Err(format!(
            "MCP server name must contain 1 to {MAX_SERVER_NAME_LENGTH} characters"
        ));
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
    {
        return Err(
            "MCP server name may contain only ASCII letters, numbers, dots, hyphens, and underscores"
                .to_string(),
        );
    }
    Ok(name.to_string())
}

fn normalize_server(name: &str, input: McpConfigServerInput) -> Result<Value, String> {
    match input {
        McpConfigServerInput::Stdio {
            command,
            args,
            env,
            env_var_refs,
            cwd,
        } => {
            let command = command.trim();
            if command.is_empty() {
                return Err(format!("MCP stdio server `{name}` requires a command"));
            }
            validate_string_map(name, "env", &env, true)?;
            validate_string_map(name, "envVarRefs", &env_var_refs, false)?;
            for child_name in env.keys() {
                if env_var_refs.contains_key(child_name) {
                    return Err(format!(
                        "MCP stdio server `{name}` environment `{child_name}` cannot be set in both env and envVarRefs"
                    ));
                }
            }
            let mut server = Map::from_iter([
                ("transport".to_string(), json!("stdio")),
                ("command".to_string(), json!(command)),
                ("args".to_string(), json!(args)),
                ("env".to_string(), json!(env)),
                ("envVarRefs".to_string(), json!(env_var_refs)),
                ("enabled".to_string(), json!(true)),
                ("enabledTools".to_string(), json!(["*"])),
            ]);
            if let Some(cwd) = cwd
                .map(|cwd| cwd.trim().to_string())
                .filter(|cwd| !cwd.is_empty())
            {
                server.insert("cwd".to_string(), json!(cwd));
            }
            Ok(Value::Object(server))
        }
        McpConfigServerInput::StreamableHttp {
            url,
            bearer_token_env_var,
            http_headers,
            env_http_headers,
        } => {
            let url = validate_http_url(name, &url)?;
            let bearer_token_env_var = bearer_token_env_var
                .map(|value| validate_env_name(name, "bearerTokenEnvVar", &value))
                .transpose()?;
            validate_http_headers(name, &http_headers, true)?;
            validate_http_headers(name, &env_http_headers, false)?;
            for header_name in http_headers.keys() {
                if env_http_headers
                    .keys()
                    .any(|candidate| candidate.eq_ignore_ascii_case(header_name))
                {
                    return Err(format!(
                        "MCP HTTP server `{name}` header `{header_name}` cannot be set in both httpHeaders and envHttpHeaders"
                    ));
                }
            }
            if bearer_token_env_var.is_some()
                && env_http_headers
                    .keys()
                    .any(|header| header.eq_ignore_ascii_case("authorization"))
            {
                return Err(format!(
                    "MCP HTTP server `{name}` cannot set both bearerTokenEnvVar and an Authorization env header"
                ));
            }
            Ok(json!({
                "transport": "streamable-http",
                "url": url,
                "bearerTokenEnvVar": bearer_token_env_var,
                "httpHeaders": http_headers,
                "envHttpHeaders": env_http_headers,
                "enabled": true,
                "enabledTools": ["*"],
            }))
        }
    }
}

fn validate_http_url(server_name: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    let parsed = url::Url::parse(value)
        .map_err(|_| format!("MCP HTTP server `{server_name}` URL is invalid"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!(
            "MCP HTTP server `{server_name}` URL must use http or https"
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(format!(
            "MCP HTTP server `{server_name}` URL must not contain credentials or a fragment"
        ));
    }
    Ok(value.to_string())
}

fn validate_string_map(
    server_name: &str,
    field: &str,
    values: &BTreeMap<String, String>,
    reject_sensitive_values: bool,
) -> Result<(), String> {
    for (key, value) in values {
        validate_env_name(server_name, field, key)?;
        if value.is_empty() {
            return Err(format!(
                "MCP server `{server_name}` {field} value for `{key}` must not be empty"
            ));
        }
        if reject_sensitive_values && is_sensitive_name(key) {
            return Err(format!(
                "MCP server `{server_name}` environment `{key}` may contain a credential; use envVarRefs instead"
            ));
        }
        if !reject_sensitive_values {
            validate_env_name(server_name, field, value)?;
        }
    }
    Ok(())
}

fn validate_env_name(server_name: &str, field: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let mut characters = trimmed.chars();
    let valid = characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_');
    if !valid || trimmed != value {
        return Err(format!(
            "MCP server `{server_name}` {field} must use valid environment variable names"
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_http_headers(
    server_name: &str,
    values: &BTreeMap<String, String>,
    literal: bool,
) -> Result<(), String> {
    for (name, value) in values {
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            format!("MCP HTTP server `{server_name}` header name `{name}` is invalid")
        })?;
        if literal {
            HeaderValue::from_str(value).map_err(|_| {
                format!("MCP HTTP server `{server_name}` header `{name}` value is invalid")
            })?;
            if is_sensitive_name(name) {
                return Err(format!(
                    "MCP HTTP server `{server_name}` header `{name}` may contain a credential; use envHttpHeaders instead"
                ));
            }
        } else {
            validate_env_name(server_name, "envHttpHeaders", value)?;
        }
    }
    Ok(())
}

fn project_server(name: &str, server: &Value) -> Value {
    let transport = server
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .to_ascii_lowercase();
    let mut projected = Map::from_iter([
        ("name".to_string(), json!(name)),
        ("transport".to_string(), json!(transport)),
        (
            "enabled".to_string(),
            json!(server.get("enabled").and_then(Value::as_bool) != Some(false)),
        ),
        (
            "enabledTools".to_string(),
            server
                .get("enabledTools")
                .or_else(|| server.get("enabled_tools"))
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
    ]);
    if transport == "stdio" {
        copy_field(server, &mut projected, "command");
        copy_field(server, &mut projected, "args");
        copy_field(server, &mut projected, "cwd");
        let env = string_map(server.get("env"));
        let (safe_env, sensitive_env_names) = partition_sensitive_values(env);
        projected.insert("env".to_string(), json!(safe_env));
        projected.insert("sensitiveEnvNames".to_string(), json!(sensitive_env_names));
        projected.insert(
            "envVarRefs".to_string(),
            json!(string_map(
                server
                    .get("envVarRefs")
                    .or_else(|| server.get("env_var_refs"))
            )),
        );
    } else if matches!(
        transport.as_str(),
        "http" | "streamable_http" | "streamable-http"
    ) {
        copy_alias_field(server, &mut projected, "url", &["endpoint", "uri"]);
        let bearer_token_configured = server
            .get("bearerToken")
            .or_else(|| server.get("bearer_token"))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        projected.insert(
            "bearerTokenConfigured".to_string(),
            json!(bearer_token_configured),
        );
        copy_alias_field(
            server,
            &mut projected,
            "bearerTokenEnvVar",
            &["bearer_token_env_var"],
        );
        let headers = string_map(
            server
                .get("httpHeaders")
                .or_else(|| server.get("http_headers"))
                .or_else(|| server.get("headers")),
        );
        let (safe_headers, sensitive_header_names) = partition_sensitive_values(headers);
        projected.insert("httpHeaders".to_string(), json!(safe_headers));
        projected.insert(
            "sensitiveHttpHeaderNames".to_string(),
            json!(sensitive_header_names),
        );
        projected.insert(
            "envHttpHeaders".to_string(),
            json!(string_map(
                server
                    .get("envHttpHeaders")
                    .or_else(|| server.get("env_http_headers"))
            )),
        );
    }
    Value::Object(projected)
}

fn copy_field(source: &Value, target: &mut Map<String, Value>, field: &str) {
    if let Some(value) = source.get(field) {
        target.insert(field.to_string(), value.clone());
    }
}

fn copy_alias_field(
    source: &Value,
    target: &mut Map<String, Value>,
    field: &str,
    aliases: &[&str],
) {
    if let Some(value) = source
        .get(field)
        .or_else(|| aliases.iter().find_map(|alias| source.get(*alias)))
    {
        target.insert(field.to_string(), value.clone());
    }
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn partition_sensitive_values(
    values: BTreeMap<String, String>,
) -> (BTreeMap<String, String>, Vec<String>) {
    let mut safe = BTreeMap::new();
    let mut sensitive = Vec::new();
    for (name, value) in values {
        if is_sensitive_name(&name) {
            sensitive.push(name);
        } else {
            safe.insert(name, value);
        }
    }
    (safe, sensitive)
}

fn reject_hidden_existing_secrets(name: &str, server: &Value) -> Result<(), String> {
    let has_bearer_token = server
        .get("bearerToken")
        .or_else(|| server.get("bearer_token"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let has_sensitive_env = string_map(server.get("env"))
        .keys()
        .any(|key| is_sensitive_name(key));
    let has_sensitive_header = string_map(
        server
            .get("httpHeaders")
            .or_else(|| server.get("http_headers"))
            .or_else(|| server.get("headers")),
    )
    .keys()
    .any(|key| is_sensitive_name(key));
    if has_bearer_token || has_sensitive_env || has_sensitive_header {
        return Err(format!(
            "MCP server `{name}` contains credentials hidden from the Agent; update it in Tools & Plugins to avoid losing secret values"
        ));
    }
    Ok(())
}

fn is_sensitive_name(name: &str) -> bool {
    let compact = name
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
        "credential",
        "apikey",
        "cookie",
    ]
    .iter()
    .any(|marker| compact.ends_with(marker))
}

fn escape_json_pointer_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
#[path = "mcp_configuration_tests.rs"]
mod tests;
