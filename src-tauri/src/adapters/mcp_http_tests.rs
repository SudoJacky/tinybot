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
fn accepts_inline_bearer_token_without_exposing_it_as_a_header() {
    let config = parse_http_server_config(
        "docs",
        &json!({
            "transport": "http",
            "url": "https://example.com/mcp",
            "bearer_token": "private-token"
        }),
    )
    .expect("inline bearer token should parse");

    assert_eq!(config.bearer_token.as_deref(), Some("private-token"));
    assert!(config.headers.is_empty());
}

#[test]
fn rejects_conflicting_bearer_token_sources_without_echoing_the_token() {
    let error = parse_http_server_config(
        "docs",
        &json!({
            "transport": "http",
            "url": "https://example.com/mcp",
            "bearer_token": "must-not-leak",
            "bearer_token_env_var": "DOCS_MCP_TOKEN"
        }),
    )
    .expect_err("conflicting bearer token sources should be rejected");

    assert!(error.message.contains("not both"));
    assert!(!error.message.contains("must-not-leak"));
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
