use super::*;
use crate::desktop::state::GatewayRuntime;
use std::sync::{Arc, Mutex};

#[test]
fn window_close_shutdown_does_not_nest_async_runtime() {
    let shared = Arc::new(Mutex::new(GatewayRuntime::default()));

    let result = tauri::async_runtime::block_on(stop_owned_gateway_for_window_close(shared, false));

    assert!(result.is_ok(), "{result:?}");
}
