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
    ))
    .expect("disabled server catalog should build");

    assert_eq!(catalog.servers.len(), 1);
    assert_eq!(catalog.servers[0].status["state"], "disabled");
    assert!(catalog.tools.is_empty());
}

#[test]
fn ui_and_turn_callers_reuse_the_same_published_registry_snapshot() {
    let runtime = McpRuntime::new();
    let config = serde_json::json!({
        "tools": { "mcp_servers": { "docs": {
            "enabled": false,
            "transport": "stdio",
            "command": "does-not-run"
        }}}
    });

    let first =
        tauri::async_runtime::block_on(runtime.registry_snapshot(Path::new("."), &config, None))
            .unwrap();
    let second =
        tauri::async_runtime::block_on(runtime.registry_snapshot(Path::new("."), &config, None))
            .unwrap();

    assert!(std::sync::Arc::ptr_eq(&first, &second));
    assert_eq!(first.revision, second.revision);
}
