use super::*;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    config_path: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-mcp-configuration-{name}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("fixture root should be created");
        Self {
            config_path: root.join("config.json"),
            root,
        }
    }

    fn list(&self) -> Value {
        list_global_mcp_config_at_path(&self.config_path).expect("MCP config should list")
    }

    fn upsert(&self, input: Value) -> Result<Value, String> {
        let input = serde_json::from_value(input).expect("upsert input should deserialize");
        upsert_global_mcp_config_at_path(&self.config_path, input)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn upserts_stdio_server_with_revision_and_dotted_name() {
    let fixture = Fixture::new("stdio");
    let revision = fixture.list()["revision"].as_str().unwrap().to_string();

    let result = fixture
        .upsert(json!({
            "name": "local.sqlite",
            "expectedRevision": revision,
            "server": {
                "transport": "stdio",
                "command": "uvx",
                "args": ["mcp-server-sqlite", "--db-path", "data.db"],
                "env": { "LOG_LEVEL": "info" },
                "envVarRefs": { "API_TOKEN": "SQLITE_MCP_TOKEN" },
                "cwd": "."
            }
        }))
        .expect("stdio server should save");

    assert_eq!(result["configured"], true);
    let saved: Value = serde_json::from_str(
        &fs::read_to_string(&fixture.config_path).expect("config should be readable"),
    )
    .unwrap();
    let server = &saved["tools"]["mcpServers"]["local.sqlite"];
    assert_eq!(server["transport"], "stdio");
    assert_eq!(server["command"], "uvx");
    assert_eq!(server["envVarRefs"]["API_TOKEN"], "SQLITE_MCP_TOKEN");
    assert_eq!(server["enabledTools"], json!(["*"]));
}

#[test]
fn upserts_streamable_http_server_without_accepting_literal_credentials() {
    let fixture = Fixture::new("http");
    let revision = fixture.list()["revision"].as_str().unwrap().to_string();
    fixture
        .upsert(json!({
            "name": "docs",
            "expectedRevision": revision,
            "server": {
                "transport": "streamable-http",
                "url": "https://mcp.example.com/mcp",
                "bearerTokenEnvVar": "MCP_BEARER_TOKEN",
                "httpHeaders": { "X-Region": "sg" },
                "envHttpHeaders": { "X-Api-Key": "MCP_API_KEY" }
            }
        }))
        .expect("HTTP server should save");

    let saved: Value = serde_json::from_str(
        &fs::read_to_string(&fixture.config_path).expect("config should be readable"),
    )
    .unwrap();
    let server = &saved["tools"]["mcpServers"]["docs"];
    assert_eq!(server["transport"], "streamable-http");
    assert_eq!(server["bearerTokenEnvVar"], "MCP_BEARER_TOKEN");
    assert_eq!(server["envHttpHeaders"]["X-Api-Key"], "MCP_API_KEY");
    assert!(server.get("bearerToken").is_none());
}

#[test]
fn list_redacts_direct_credentials() {
    let fixture = Fixture::new("redact");
    fs::write(
        &fixture.config_path,
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 2,
            "tools": { "mcpServers": {
                "private": {
                    "transport": "streamable-http",
                    "url": "https://mcp.example.com/mcp",
                    "bearerToken": "bearer-secret",
                    "httpHeaders": {
                        "Authorization": "Basic secret",
                        "X-Region": "sg"
                    },
                    "enabledTools": ["*"]
                }
            }}
        }))
        .unwrap(),
    )
    .unwrap();

    let listed = fixture.list();
    let server = &listed["servers"][0];
    assert_eq!(server["bearerTokenConfigured"], true);
    assert_eq!(server["httpHeaders"]["X-Region"], "sg");
    assert_eq!(server["sensitiveHttpHeaderNames"], json!(["Authorization"]));
    let serialized = listed.to_string();
    assert!(!serialized.contains("bearer-secret"));
    assert!(!serialized.contains("Basic secret"));
}

#[test]
fn rejects_sensitive_literal_values_and_stale_revisions() {
    let fixture = Fixture::new("reject");
    let revision = fixture.list()["revision"].as_str().unwrap().to_string();
    let sensitive = fixture
        .upsert(json!({
            "name": "private",
            "expectedRevision": revision,
            "server": {
                "transport": "stdio",
                "command": "server",
                "env": { "API_TOKEN": "secret" }
            }
        }))
        .expect_err("sensitive literal env should fail");
    assert!(sensitive.contains("use envVarRefs"));

    let current_revision = fixture.list()["revision"].as_str().unwrap().to_string();
    fixture
        .upsert(json!({
            "name": "first",
            "expectedRevision": current_revision,
            "server": { "transport": "stdio", "command": "server" }
        }))
        .unwrap();
    let stale = fixture
        .upsert(json!({
            "name": "second",
            "expectedRevision": current_revision,
            "server": { "transport": "stdio", "command": "server" }
        }))
        .expect_err("stale update should fail");
    assert!(stale.contains("call mcp.config.list again"));
}

#[test]
fn rejects_literal_http_credentials_at_the_input_boundary() {
    let literal_token = serde_json::from_value::<McpConfigUpsertInput>(json!({
        "name": "private",
        "expectedRevision": "revision",
        "server": {
            "transport": "streamable-http",
            "url": "https://mcp.example.com/mcp",
            "bearerToken": "secret"
        }
    }))
    .expect_err("literal bearer token must not be part of the Agent schema");
    assert!(literal_token.to_string().contains("unknown field"));

    let fixture = Fixture::new("sensitive-header");
    let revision = fixture.list()["revision"].as_str().unwrap().to_string();
    let sensitive_header = fixture
        .upsert(json!({
            "name": "private",
            "expectedRevision": revision,
            "server": {
                "transport": "streamable-http",
                "url": "https://mcp.example.com/mcp",
                "httpHeaders": { "Authorization": "Bearer secret" }
            }
        }))
        .expect_err("literal Authorization header should fail");
    assert!(sensitive_header.contains("use envHttpHeaders"));
}

#[test]
fn refuses_to_replace_a_server_with_hidden_direct_secrets() {
    let fixture = Fixture::new("hidden-secret");
    fs::write(
        &fixture.config_path,
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 2,
            "tools": { "mcpServers": { "private": {
                "transport": "streamable-http",
                "url": "https://old.example.com/mcp",
                "bearerToken": "hidden"
            }}}
        }))
        .unwrap(),
    )
    .unwrap();
    let revision = fixture.list()["revision"].as_str().unwrap().to_string();

    let error = fixture
        .upsert(json!({
            "name": "private",
            "expectedRevision": revision,
            "server": {
                "transport": "streamable-http",
                "url": "https://new.example.com/mcp"
            }
        }))
        .expect_err("hidden secret should require UI editing");

    assert!(error.contains("Tools & Plugins"));
    let saved: Value = serde_json::from_str(&fs::read_to_string(&fixture.config_path).unwrap())
        .expect("config should remain valid");
    assert_eq!(
        saved["tools"]["mcpServers"]["private"]["bearerToken"],
        "hidden"
    );
}

#[test]
fn refuses_to_overwrite_invalid_configuration() {
    let fixture = Fixture::new("invalid-config");
    fs::write(&fixture.config_path, "{ invalid json").unwrap();
    let revision = fixture.list()["revision"].as_str().unwrap().to_string();

    let error = fixture
        .upsert(json!({
            "name": "docs",
            "expectedRevision": revision,
            "server": {
                "transport": "streamable-http",
                "url": "https://mcp.example.com/mcp"
            }
        }))
        .expect_err("invalid config should not be overwritten");

    assert!(error.contains("must be repaired"));
    assert_eq!(
        fs::read_to_string(&fixture.config_path).unwrap(),
        "{ invalid json"
    );
}
