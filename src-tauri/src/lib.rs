#![recursion_limit = "256"]

mod adapters;
mod agent;
mod agent_graphs;
mod automation;
mod chat_attachments;
mod collaboration;
mod command_hooks;
mod config;
mod desktop;
pub mod desktop_commands;
mod desktop_terminal;
mod graph_runs;
mod mcp_capability_catalog;
mod memory;
mod native_browser;
mod plugins;
mod project_groups;
mod protocol;
mod rpc;
mod runtime;
mod skills;
mod storage;
mod system_prompt;
mod threads;
mod tool_notes;
mod tools;
mod transport;
mod workspace;
mod workspace_extensions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    desktop::run();
}

#[cfg(feature = "native-browser-integration")]
pub fn run_native_browser_integration() -> Result<(), String> {
    #[cfg(windows)]
    {
        native_browser::integration::run()
    }
    #[cfg(not(windows))]
    {
        Err("The native browser integration harness is available only on Windows".to_string())
    }
}

#[cfg(test)]
#[path = "../tests/crate/mod.rs"]
mod tests;
