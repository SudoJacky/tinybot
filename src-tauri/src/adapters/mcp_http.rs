use http::{HeaderName, HeaderValue};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::time::Duration;

const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const MAX_TIMEOUT_SECONDS: u64 = 300;

#[derive(Clone, Debug)]
pub(crate) struct HttpServerConfig {
    pub(crate) endpoint: String,
    pub(crate) headers: HashMap<HeaderName, HeaderValue>,
    pub(crate) bearer_token: Option<String>,
    pub(crate) startup_timeout: Duration,
    pub(crate) call_timeout: Duration,
    pub(crate) fingerprint: String,
}

#[derive(Clone, Debug)]
pub(crate) struct HttpConfigError {
    pub(crate) message: String,
    pub(crate) transport: String,
}

pub(crate) fn parse_http_server_config(
    server_name: &str,
    server: &Value,
) -> Result<HttpServerConfig, HttpConfigError> {
    let transport = server
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("http")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        transport.as_str(),
        "http" | "streamable_http" | "streamable-http"
    ) {
        return Err(HttpConfigError {
            message: format!("MCP server `{server_name}` uses unsupported transport `{transport}`"),
            transport,
        });
    }
    let endpoint = server
        .get("url")
        .or_else(|| server.get("endpoint"))
        .or_else(|| server.get("uri"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty())
        .ok_or_else(|| HttpConfigError {
            message: format!("MCP HTTP server `{server_name}` requires a URL"),
            transport: "http".to_string(),
        })?;
    let parsed = url::Url::parse(endpoint).map_err(|_| HttpConfigError {
        message: format!("MCP HTTP server `{server_name}` URL is invalid"),
        transport: "http".to_string(),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(HttpConfigError {
            message: format!("MCP HTTP server `{server_name}` URL must use http or https"),
            transport: "http".to_string(),
        });
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(HttpConfigError {
            message: format!(
                "MCP HTTP server `{server_name}` URL must not contain credentials or a fragment"
            ),
            transport: "http".to_string(),
        });
    }

    if server
        .get("bearerToken")
        .or_else(|| server.get("bearer_token"))
        .is_some_and(|value| !value.is_null())
    {
        return Err(HttpConfigError {
            message: format!(
                "MCP HTTP server `{server_name}` uses unsupported bearer_token; set bearer_token_env_var"
            ),
            transport: "http".to_string(),
        });
    }
    let bearer_token = optional_env_secret(
        server_name,
        server
            .get("bearerTokenEnvVar")
            .or_else(|| server.get("bearer_token_env_var")),
        "bearer_token_env_var",
    )?;
    let mut headers = parse_header_map(
        server_name,
        server
            .get("httpHeaders")
            .or_else(|| server.get("http_headers"))
            .or_else(|| server.get("headers")),
        "http_headers",
    )?;
    let env_headers = parse_string_map(
        server_name,
        server
            .get("envHttpHeaders")
            .or_else(|| server.get("env_http_headers")),
        "env_http_headers",
    )?;
    for (name, env_var) in env_headers {
        let value = required_env_value(server_name, &env_var, "HTTP header")?;
        let name = parse_header_name(server_name, &name)?;
        let value = parse_header_value(server_name, &name, &value)?;
        headers.insert(name, value);
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
    let fingerprint = serde_json::to_string(server).map_err(|error| HttpConfigError {
        message: format!("MCP server `{server_name}` configuration is invalid: {error}"),
        transport: "http".to_string(),
    })?;

    Ok(HttpServerConfig {
        endpoint: endpoint.to_string(),
        headers,
        bearer_token,
        startup_timeout: Duration::from_secs(startup_timeout_seconds),
        call_timeout: Duration::from_secs(timeout_seconds),
        fingerprint,
    })
}

fn optional_env_secret(
    server_name: &str,
    value: Option<&Value>,
    field: &str,
) -> Result<Option<String>, HttpConfigError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let env_var = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HttpConfigError {
            message: format!("MCP HTTP server `{server_name}` {field} must be a non-empty string"),
            transport: "http".to_string(),
        })?;
    required_env_value(server_name, env_var, field).map(Some)
}

fn required_env_value(
    server_name: &str,
    env_var: &str,
    purpose: &str,
) -> Result<String, HttpConfigError> {
    match env::var(env_var) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        Ok(_) => Err(HttpConfigError {
            message: format!(
                "Environment variable `{env_var}` for MCP server `{server_name}` {purpose} is empty"
            ),
            transport: "http".to_string(),
        }),
        Err(env::VarError::NotPresent) => Err(HttpConfigError {
            message: format!(
                "Environment variable `{env_var}` for MCP server `{server_name}` {purpose} is not set"
            ),
            transport: "http".to_string(),
        }),
        Err(env::VarError::NotUnicode(_)) => Err(HttpConfigError {
            message: format!(
                "Environment variable `{env_var}` for MCP server `{server_name}` {purpose} is not valid Unicode"
            ),
            transport: "http".to_string(),
        }),
    }
}

fn parse_header_map(
    server_name: &str,
    value: Option<&Value>,
    field: &str,
) -> Result<HashMap<HeaderName, HeaderValue>, HttpConfigError> {
    parse_string_map(server_name, value, field)?
        .into_iter()
        .map(|(name, value)| {
            let name = parse_header_name(server_name, &name)?;
            let value = parse_header_value(server_name, &name, &value)?;
            Ok((name, value))
        })
        .collect()
}

fn parse_string_map(
    server_name: &str,
    value: Option<&Value>,
    field: &str,
) -> Result<HashMap<String, String>, HttpConfigError> {
    let Some(value) = value else {
        return Ok(HashMap::new());
    };
    let values = value.as_object().ok_or_else(|| HttpConfigError {
        message: format!("MCP HTTP server `{server_name}` {field} must be an object"),
        transport: "http".to_string(),
    })?;
    values
        .iter()
        .map(|(name, value)| {
            let value = value.as_str().ok_or_else(|| HttpConfigError {
                message: format!("MCP HTTP server `{server_name}` {field} values must be strings"),
                transport: "http".to_string(),
            })?;
            Ok((name.clone(), value.to_string()))
        })
        .collect()
}

fn parse_header_name(server_name: &str, name: &str) -> Result<HeaderName, HttpConfigError> {
    HeaderName::from_bytes(name.as_bytes()).map_err(|_| HttpConfigError {
        message: format!("MCP HTTP server `{server_name}` has an invalid header name"),
        transport: "http".to_string(),
    })
}

fn parse_header_value(
    server_name: &str,
    name: &HeaderName,
    value: &str,
) -> Result<HeaderValue, HttpConfigError> {
    HeaderValue::from_str(value).map_err(|_| HttpConfigError {
        message: format!(
            "MCP HTTP server `{server_name}` has an invalid value for header `{name}`"
        ),
        transport: "http".to_string(),
    })
}

pub(crate) fn http_transport_config(
    config: &HttpServerConfig,
) -> StreamableHttpClientTransportConfig {
    let mut transport = StreamableHttpClientTransportConfig::with_uri(config.endpoint.clone())
        .custom_headers(config.headers.clone());
    if let Some(token) = &config.bearer_token {
        transport = transport.auth_header(token.clone());
    }
    transport
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_http_endpoint_and_resolves_secret_headers_from_environment() {
        let token_env = format!("TINYBOT_MCP_HTTP_TOKEN_{}", std::process::id());
        let tenant_env = format!("TINYBOT_MCP_HTTP_TENANT_{}", std::process::id());
        let _token_guard = ScopedEnv::set(&token_env, "private-token");
        let _tenant_guard = ScopedEnv::set(&tenant_env, "tinybot");
        let config = parse_http_server_config(
            "docs",
            &json!({
                "transport": "http",
                "url": "https://example.com/mcp",
                "bearer_token_env_var": token_env,
                "env_http_headers": { "X-Tenant": tenant_env }
            }),
        )
        .expect("valid HTTP MCP config should parse");

        assert_eq!(config.endpoint, "https://example.com/mcp");
        assert_eq!(config.bearer_token.as_deref(), Some("private-token"));
        assert_eq!(config.headers.len(), 1);
        assert_eq!(
            config
                .headers
                .get(&HeaderName::from_static("x-tenant"))
                .and_then(|value| value.to_str().ok()),
            Some("tinybot")
        );
    }

    #[test]
    fn rejects_inline_bearer_token_and_names_environment_field() {
        let error = parse_http_server_config(
            "docs",
            &json!({
                "transport": "http",
                "url": "https://example.com/mcp",
                "bearer_token": "must-not-be-used"
            }),
        )
        .expect_err("inline bearer tokens should be rejected");

        assert!(error.message.contains("bearer_token_env_var"));
        assert!(!error.message.contains("must-not-be-used"));
    }

    #[test]
    fn rejects_legacy_sse_without_silent_fallback() {
        let error = parse_http_server_config(
            "legacy",
            &json!({ "transport": "sse", "url": "https://example.com/sse" }),
        )
        .expect_err("legacy SSE should remain explicitly unsupported");

        assert_eq!(error.transport, "sse");
        assert!(error.message.contains("unsupported transport"));
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
