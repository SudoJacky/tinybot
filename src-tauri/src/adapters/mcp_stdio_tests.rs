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
