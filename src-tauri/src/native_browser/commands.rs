use super::{
    manager::SharedBrowserRuntime,
    model::{
        BrowserCreateSessionInput, BrowserCreateTabInput, BrowserDeleteProfileInput,
        BrowserInteractionInput, BrowserNativeSnapshot, BrowserNavigateInput, BrowserObserveInput,
        BrowserObserveResult, BrowserResolvePolicyRequestInput, BrowserRuntimeCapabilities,
        BrowserRuntimeMetrics, BrowserSessionTarget, BrowserSurfaceUpdate, BrowserTabTarget,
    },
};
use tauri::State;

#[tauri::command]
pub(crate) fn browser_capabilities(
    runtime: State<'_, SharedBrowserRuntime>,
) -> BrowserRuntimeCapabilities {
    runtime.capabilities()
}

#[tauri::command]
pub(crate) fn browser_metrics(runtime: State<'_, SharedBrowserRuntime>) -> BrowserRuntimeMetrics {
    runtime.metrics()
}

#[tauri::command]
pub(crate) fn browser_snapshot(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserSessionTarget,
) -> Result<BrowserNativeSnapshot, String> {
    runtime
        .snapshot(&input.browser_session_id)
        .ok_or_else(|| format!("Browser session {} was not found", input.browser_session_id))
}

#[tauri::command]
pub(crate) async fn browser_create_session(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserCreateSessionInput,
) -> Result<BrowserNativeSnapshot, String> {
    runtime.inner().create_session(input).await
}

#[tauri::command]
pub(crate) async fn browser_close_session(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserSessionTarget,
) -> Result<(), String> {
    runtime
        .inner()
        .close_session(&input.browser_session_id)
        .await
}

#[tauri::command]
pub(crate) async fn browser_create_tab(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserCreateTabInput,
) -> Result<BrowserNativeSnapshot, String> {
    runtime.inner().create_tab(input).await
}

#[tauri::command]
pub(crate) async fn browser_activate_tab(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserTabTarget,
) -> Result<BrowserNativeSnapshot, String> {
    runtime
        .inner()
        .activate_tab(&input.browser_session_id, &input.tab_id)
        .await
}

#[tauri::command]
pub(crate) async fn browser_close_tab(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserTabTarget,
) -> Result<BrowserNativeSnapshot, String> {
    runtime
        .inner()
        .close_tab(&input.browser_session_id, &input.tab_id)
        .await
}

#[tauri::command]
pub(crate) async fn browser_navigate(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserNavigateInput,
) -> Result<BrowserNativeSnapshot, String> {
    runtime
        .inner()
        .navigate(&input.browser_session_id, &input.tab_id, &input.url)
        .await
}

macro_rules! tab_command {
    ($name:ident, $method:ident) => {
        #[tauri::command]
        pub(crate) async fn $name(
            runtime: State<'_, SharedBrowserRuntime>,
            input: BrowserTabTarget,
        ) -> Result<(), String> {
            runtime
                .inner()
                .$method(&input.browser_session_id, &input.tab_id)
                .await
        }
    };
}

tab_command!(browser_back, back);
tab_command!(browser_forward, forward);
tab_command!(browser_reload, reload);
tab_command!(browser_stop, stop);

#[tauri::command]
pub(crate) async fn browser_restart_tab(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserTabTarget,
) -> Result<BrowserNativeSnapshot, String> {
    runtime
        .inner()
        .restart_tab(&input.browser_session_id, &input.tab_id)
        .await
}

#[tauri::command]
pub(crate) async fn browser_update_surface(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserSurfaceUpdate,
) -> Result<BrowserNativeSnapshot, String> {
    runtime.inner().update_surface(input).await
}

#[tauri::command]
pub(crate) async fn browser_observe(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserObserveInput,
) -> Result<BrowserObserveResult, String> {
    runtime.inner().observe(input).await
}

#[tauri::command]
pub(crate) async fn browser_interact(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserInteractionInput,
) -> Result<super::model::BrowserCommandResult, String> {
    runtime.inner().interact(input).await
}

#[tauri::command]
pub(crate) async fn browser_resolve_policy_request(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserResolvePolicyRequestInput,
) -> Result<BrowserNativeSnapshot, String> {
    runtime.inner().resolve_policy_request(input).await
}

#[tauri::command]
pub(crate) async fn browser_delete_profile(
    runtime: State<'_, SharedBrowserRuntime>,
    input: BrowserDeleteProfileInput,
) -> Result<(), String> {
    runtime.inner().delete_profile(input).await
}
