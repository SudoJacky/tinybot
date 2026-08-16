mod bootstrap;
pub(crate) mod files;
pub(crate) mod logging;
pub(crate) mod menu;
pub(crate) mod state;
mod update;

#[cfg(test)]
pub(crate) use bootstrap::{
    desktop_performance_snapshot_with_options, record_renderer_diagnostic_with_options,
    record_renderer_log_with_options,
};
pub(crate) use state::{lock_runtime, SharedNativeRuntime};

pub(crate) fn run() {
    bootstrap::run();
}
