use super::{
    model::{BrowserRuntimeCapabilities, BrowserTabId},
    platform::{
        unsupported_capabilities, BrowserPlatformAction, BrowserPlatformCreateTab,
        BrowserPlatformEventSink, BrowserPlatformObservation, BrowserPlatformProfile,
        BrowserPlatformSurface, BrowserPlatformTabState, BrowserRuntimeAdapter,
    },
};
use async_trait::async_trait;

#[derive(Default)]
pub(crate) struct UnsupportedBrowserRuntime;

#[async_trait]
impl BrowserRuntimeAdapter for UnsupportedBrowserRuntime {
    fn runtime_kind(&self) -> &'static str {
        "unavailable"
    }
    fn runtime_version(&self) -> &'static str {
        env!("CARGO_PKG_VERSION")
    }
    fn capabilities(&self) -> BrowserRuntimeCapabilities {
        unsupported_capabilities(
            "platform_unsupported",
            "The native browser runtime is currently available only on Windows WebView2.",
        )
    }
    fn bind_event_sink(&self, _sink: BrowserPlatformEventSink) {}
    async fn create_tab(
        &self,
        _request: BrowserPlatformCreateTab,
    ) -> Result<BrowserPlatformTabState, String> {
        Err(unavailable())
    }
    async fn close_tab(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(unavailable())
    }
    async fn set_surface(&self, _surface: BrowserPlatformSurface) -> Result<(), String> {
        Err(unavailable())
    }
    async fn navigate(&self, _tab_id: &BrowserTabId, _url: &str) -> Result<(), String> {
        Err(unavailable())
    }
    async fn back(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(unavailable())
    }
    async fn forward(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(unavailable())
    }
    async fn reload(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(unavailable())
    }
    async fn stop(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(unavailable())
    }
    async fn observe(
        &self,
        _tab_id: &BrowserTabId,
        _capture: bool,
        _semantic: bool,
    ) -> Result<BrowserPlatformObservation, String> {
        Err(unavailable())
    }
    async fn interact(
        &self,
        _tab_id: &BrowserTabId,
        _action: BrowserPlatformAction,
    ) -> Result<(), String> {
        Err(unavailable())
    }
    async fn open_external(&self, _url: &str) -> Result<(), String> {
        Err(unavailable())
    }
    async fn delete_profile(&self, _profile: &BrowserPlatformProfile) -> Result<(), String> {
        Err(unavailable())
    }
}

fn unavailable() -> String {
    "The native browser runtime is unavailable on this platform".to_string()
}
