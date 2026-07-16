use super::{
    model::{BrowserRuntimeCapabilities, BrowserTabId},
    platform::{
        unsupported_capabilities, BrowserPlatformAction, BrowserPlatformCreateTab,
        BrowserPlatformEventSink, BrowserPlatformObservation, BrowserPlatformProfile,
        BrowserPlatformSurface, BrowserPlatformTabState, BrowserRuntimeAdapter,
    },
};
use async_trait::async_trait;

pub(crate) struct UnsupportedBrowserRuntime {
    reason_code: &'static str,
    reason: &'static str,
}

impl UnsupportedBrowserRuntime {
    pub(crate) fn platform_unsupported() -> Self {
        Self {
            reason_code: "platform_unsupported",
            reason: "The native browser runtime is currently available only on Windows WebView2.",
        }
    }

    #[cfg(windows)]
    pub(crate) fn feature_disabled() -> Self {
        Self {
            reason_code: "feature_disabled",
            reason: "The experimental Windows native browser runtime is disabled in this build.",
        }
    }

    fn unavailable(&self) -> String {
        self.reason.to_string()
    }
}

#[async_trait]
impl BrowserRuntimeAdapter for UnsupportedBrowserRuntime {
    fn runtime_kind(&self) -> &'static str {
        "unavailable"
    }
    fn runtime_version(&self) -> &'static str {
        env!("CARGO_PKG_VERSION")
    }
    fn capabilities(&self) -> BrowserRuntimeCapabilities {
        unsupported_capabilities(self.reason_code, self.reason)
    }
    fn bind_event_sink(&self, _sink: BrowserPlatformEventSink) {}
    async fn create_tab(
        &self,
        _request: BrowserPlatformCreateTab,
    ) -> Result<BrowserPlatformTabState, String> {
        Err(self.unavailable())
    }
    async fn close_tab(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn set_surface(&self, _surface: BrowserPlatformSurface) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn navigate(&self, _tab_id: &BrowserTabId, _url: &str) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn back(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn forward(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn reload(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn stop(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn observe(
        &self,
        _tab_id: &BrowserTabId,
        _capture: bool,
        _semantic: bool,
    ) -> Result<BrowserPlatformObservation, String> {
        Err(self.unavailable())
    }
    async fn interact(
        &self,
        _tab_id: &BrowserTabId,
        _action: BrowserPlatformAction,
    ) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn open_external(&self, _url: &str) -> Result<(), String> {
        Err(self.unavailable())
    }
    async fn delete_profile(&self, _profile: &BrowserPlatformProfile) -> Result<(), String> {
        Err(self.unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_reports_fail_closed_capabilities() {
        let capabilities = UnsupportedBrowserRuntime::platform_unsupported().capabilities();

        assert!(!capabilities.session_snapshot.available);
        assert_eq!(
            capabilities.session_snapshot.reason_code.as_deref(),
            Some("platform_unsupported")
        );
    }

    #[cfg(windows)]
    #[test]
    fn disabled_windows_feature_reports_fail_closed_capabilities() {
        let capabilities = UnsupportedBrowserRuntime::feature_disabled().capabilities();

        assert!(!capabilities.session_snapshot.available);
        assert_eq!(
            capabilities.session_snapshot.reason_code.as_deref(),
            Some("feature_disabled")
        );
    }
}
