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
