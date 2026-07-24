mod bootstrap;
pub(crate) mod files;
pub(crate) mod logging;
pub(crate) mod menu;
pub(crate) mod state;
mod update;

#[cfg(test)]
pub(crate) use bootstrap::{record_renderer_diagnostic_with_options, truncate_utf8_with_ellipsis};
pub(crate) use state::{lock_runtime, SharedGateway};

pub(crate) fn run() {
    bootstrap::run();
}
