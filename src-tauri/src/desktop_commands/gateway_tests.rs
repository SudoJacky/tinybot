use super::*;
use crate::desktop::state::{lock_runtime, NativeRuntimeState};
use std::sync::{Arc, Mutex};

#[test]
fn window_close_always_shuts_down_the_native_runtime() {
    let shared = Arc::new(Mutex::new(NativeRuntimeState::default()));

    let result =
        tauri::async_runtime::block_on(stop_owned_gateway_for_window_close(shared.clone(), false));

    assert!(result.is_ok(), "{result:?}");
    assert!(!lock_runtime(&shared)
        .native_agent_runtime
        .task_runtime()
        .is_accepting());
}
