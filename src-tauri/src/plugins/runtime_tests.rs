use super::*;
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn normalizes_stdio_paths_and_client_controlled_environment() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-plugin-runtime-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let plugin_root = root.join("plugin");
    let data_root = root.join("data");
    fs::create_dir_all(plugin_root.join("bin")).expect("plugin bin should be created");
    fs::create_dir_all(&data_root).expect("plugin data should be created");
    fs::write(plugin_root.join("bin/server"), "fixture").expect("server should be written");
    let config = serde_json::json!({
        "type": "stdio",
        "command": "./bin/server",
        "args": ["--root", "${PLUGIN_ROOT}", "--data=${PLUGIN_DATA}"],
        "env": { "CACHE": "${PLUGIN_DATA}/cache" },
        "cwd": "${PLUGIN_DATA}/work"
    });

    let normalized = normalize_stdio_server(&plugin_root, &data_root, &config)
        .expect("stdio server should normalize");

    assert!(
        normalized["command"]
            .as_str()
            .expect("command should be a string")
            .ends_with("bin\\server")
            || normalized["command"]
                .as_str()
                .expect("command should be a string")
                .ends_with("bin/server")
    );
    assert_eq!(
        normalized["env"]["PLUGIN_ROOT"],
        plugin_root.display().to_string()
    );
    assert_eq!(
        normalized["env"]["PLUGIN_DATA"],
        data_root.display().to_string()
    );
    assert_eq!(normalized["agent_plugin"], true);
    assert!(data_root.join("work").is_dir());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn reinstall_changes_mcp_runtime_fingerprint_when_only_plugin_content_changes() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-plugin-runtime-reinstall-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let source = root.join("source");
    let store = PluginStore::new(root.join("store"));
    fs::create_dir_all(source.join("bin")).expect("plugin bin should be created");
    fs::write(
        source.join("plugin.json"),
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"runtime-tools","version":"1.0.0"}"#,
    )
    .expect("manifest should be written");
    fs::write(
        source.join("mcp.json"),
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"runtime":{"type":"stdio","command":"./bin/server"}}}"#,
    )
    .expect("MCP config should be written");
    fs::write(source.join("bin/server"), "version-one").expect("server v1 should be written");
    store
        .install_from_directory(&source)
        .expect("plugin v1 should install");
    let mut first = serde_json::json!({});
    merge_enabled_mcp_servers_from_store(&mut first, &store)
        .expect("plugin v1 MCP config should merge");

    fs::write(source.join("bin/server"), "version-two").expect("server v2 should be written");
    store
        .install_from_directory(&source)
        .expect("plugin v2 should reinstall");
    let mut second = serde_json::json!({});
    merge_enabled_mcp_servers_from_store(&mut second, &store)
        .expect("plugin v2 MCP config should merge");

    assert_ne!(
        first["tools"]["mcpServers"]["plugin:runtime-tools:runtime"],
        second["tools"]["mcpServers"]["plugin:runtime-tools:runtime"],
        "reinstalling changed plugin code must invalidate the running MCP client"
    );
    let _ = fs::remove_dir_all(root);
}
