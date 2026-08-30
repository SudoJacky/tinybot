mod bootstrap;
pub(crate) mod diagnostics;
pub(crate) mod files;
pub(crate) mod logging;
pub(crate) mod memory_metrics;
pub(crate) mod menu;
pub(crate) mod pet;
pub(crate) mod pet_file_drop;
pub(crate) mod state;
mod tray;
mod update;

#[cfg(test)]
pub(crate) use bootstrap::{
    record_renderer_diagnostic_with_options, record_renderer_log_with_options,
};
#[cfg(test)]
pub(crate) use diagnostics::{
    desktop_performance_snapshot_with_options, export_diagnostic_bundle_with_options,
};
pub(crate) use state::{lock_runtime, SharedNativeRuntime};

pub(crate) fn run() {
    bootstrap::run();
}
