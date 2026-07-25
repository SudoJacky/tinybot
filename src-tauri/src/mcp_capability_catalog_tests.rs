use super::*;

#[test]
fn disabled_servers_are_visible_without_starting_a_transport() {
    let catalog = tauri::async_runtime::block_on(build_mcp_capability_catalog(
        &McpRuntime::new(),
        Path::new("."),
        &serde_json::json!({
            "tools": { "mcp_servers": { "docs": {
                "enabled": false,
                "transport": "stdio",
                "command": "does-not-run"
            }}}
        }),
        true,
    ));

    assert_eq!(catalog.servers.len(), 1);
    assert_eq!(catalog.servers[0].status["state"], "disabled");
    assert!(catalog.tools.is_empty());
}
