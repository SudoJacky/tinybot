use super::model::{
    BrowserAction, BrowserCapabilityDecision, BrowserProfileId, BrowserProfilePersistence,
    BrowserRuntimeCapabilities, BrowserSurfaceRect, BrowserTabId,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

pub(crate) type BrowserPlatformEventSink = Arc<dyn Fn(BrowserPlatformEvent) + Send + Sync>;

#[cfg_attr(
    all(windows, not(feature = "native-browser-runtime")),
    allow(dead_code)
)]
#[derive(Clone, Debug)]
pub(crate) enum BrowserPlatformEvent {
    NavigationStarted {
        tab_id: BrowserTabId,
        url: String,
    },
    NavigationFinished {
        tab_id: BrowserTabId,
        url: String,
        can_go_back: bool,
        can_go_forward: bool,
    },
    TitleChanged {
        tab_id: BrowserTabId,
        title: String,
    },
    UserInput {
        tab_id: BrowserTabId,
    },
    PopupRequested {
        tab_id: BrowserTabId,
        url: String,
    },
    ExternalProtocolRequested {
        tab_id: BrowserTabId,
        url: String,
    },
    DownloadBlocked {
        tab_id: BrowserTabId,
        url: String,
    },
    PolicyDenied {
        tab_id: BrowserTabId,
        url: String,
        reason_code: String,
    },
    RendererCrashed {
        tab_id: BrowserTabId,
        reason: String,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserPlatformProfile {
    pub profile_id: BrowserProfileId,
    pub persistence: BrowserProfilePersistence,
    pub data_directory: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserPlatformCreateTab {
    pub tab_id: BrowserTabId,
    pub profile: BrowserPlatformProfile,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPlatformTabState {
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub device_scale: f64,
}

#[cfg_attr(
    all(windows, not(feature = "native-browser-runtime")),
    allow(dead_code)
)]
#[derive(Clone, Debug)]
pub(crate) struct BrowserPlatformSurface {
    pub tab_id: BrowserTabId,
    pub rect: BrowserSurfaceRect,
    pub visible: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BrowserPlatformObservation {
    pub capture_base64: Option<String>,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub device_scale: f64,
    pub semantic_nodes: Vec<BrowserPlatformSemanticNode>,
    pub semantic_truncated: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserPlatformSemanticNode {
    pub selector: String,
    pub role: String,
    pub name: String,
    pub frame: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub disabled: bool,
    pub focused: bool,
    pub sensitive: bool,
    pub protected_reason: Option<String>,
}

#[cfg_attr(
    all(windows, not(feature = "native-browser-runtime")),
    allow(dead_code)
)]
#[derive(Clone, Debug)]
pub(crate) enum BrowserPlatformAction {
    Browser(BrowserAction),
    ClickSelector { selector: String },
    FillSelector { selector: String, text: String },
    UserRequired { reason_code: String, reason: String },
}

#[async_trait]
pub(crate) trait BrowserRuntimeAdapter: Send + Sync {
    fn runtime_kind(&self) -> &'static str;
    fn runtime_version(&self) -> &'static str;
    fn capabilities(&self) -> BrowserRuntimeCapabilities;
    fn bind_event_sink(&self, sink: BrowserPlatformEventSink);

    async fn create_tab(
        &self,
        request: BrowserPlatformCreateTab,
    ) -> Result<BrowserPlatformTabState, String>;
    async fn close_tab(&self, tab_id: &BrowserTabId) -> Result<(), String>;
    async fn set_surface(&self, surface: BrowserPlatformSurface) -> Result<(), String>;
    async fn navigate(&self, tab_id: &BrowserTabId, url: &str) -> Result<(), String>;
    async fn back(&self, tab_id: &BrowserTabId) -> Result<(), String>;
    async fn forward(&self, tab_id: &BrowserTabId) -> Result<(), String>;
    async fn reload(&self, tab_id: &BrowserTabId) -> Result<(), String>;
    async fn stop(&self, tab_id: &BrowserTabId) -> Result<(), String>;
    async fn observe(
        &self,
        tab_id: &BrowserTabId,
        capture: bool,
        semantic: bool,
    ) -> Result<BrowserPlatformObservation, String>;
    async fn interact(
        &self,
        tab_id: &BrowserTabId,
        action: BrowserPlatformAction,
    ) -> Result<(), String>;
    async fn open_external(&self, url: &str) -> Result<(), String>;
    async fn delete_profile(&self, profile: &BrowserPlatformProfile) -> Result<(), String>;
}

#[cfg(any(
    test,
    not(windows),
    all(windows, not(feature = "native-browser-runtime"))
))]
pub(crate) fn unsupported_capabilities(
    reason_code: &str,
    reason: &str,
) -> BrowserRuntimeCapabilities {
    let unavailable = || BrowserCapabilityDecision::unavailable(reason_code, reason);
    BrowserRuntimeCapabilities {
        schema_version: "tinybot.browser_runtime_capabilities.v1",
        runtime_kind: "unavailable".to_string(),
        runtime_version: env!("CARGO_PKG_VERSION").to_string(),
        session_snapshot: unavailable(),
        direct_input: unavailable(),
        real_capture: unavailable(),
        semantic_observation: unavailable(),
        agent_interaction: unavailable(),
        popups: unavailable(),
        downloads: unavailable(),
        uploads: unavailable(),
        persistent_profiles: unavailable(),
        incognito_profiles: unavailable(),
    }
}

pub(crate) fn available_windows_capabilities() -> BrowserRuntimeCapabilities {
    BrowserRuntimeCapabilities {
        schema_version: "tinybot.browser_runtime_capabilities.v1",
        runtime_kind: "windows_webview2".to_string(),
        runtime_version: "tauri-2.11.2/wry-0.55.1/webview2-com-0.38.2".to_string(),
        session_snapshot: BrowserCapabilityDecision::available(),
        direct_input: BrowserCapabilityDecision::available(),
        real_capture: BrowserCapabilityDecision::available(),
        semantic_observation: BrowserCapabilityDecision::available(),
        agent_interaction: BrowserCapabilityDecision::available(),
        popups: BrowserCapabilityDecision::available(),
        downloads: BrowserCapabilityDecision::unavailable(
            "download_contract_unavailable",
            "Browser downloads remain blocked until destination and progress contracts are implemented.",
        ),
        uploads: BrowserCapabilityDecision::unavailable(
            "user_required",
            "File selection requires direct user interaction with the native picker.",
        ),
        persistent_profiles: BrowserCapabilityDecision::available(),
        incognito_profiles: BrowserCapabilityDecision::available(),
    }
}

pub(crate) fn safe_browser_url(value: &str) -> Result<url::Url, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err("Browser URL is required".to_string());
    }
    let candidate = if normalized.contains("://") || normalized.starts_with("about:") {
        normalized.to_string()
    } else {
        format!("https://{normalized}")
    };
    let parsed =
        url::Url::parse(&candidate).map_err(|error| format!("Invalid browser URL: {error}"))?;
    match navigation_policy(&parsed) {
        BrowserNavigationPolicy::Embedded => Ok(parsed),
        BrowserNavigationPolicy::ExternalCandidate => Err(format!(
            "Browser external protocol `{}` requires explicit user confirmation",
            parsed.scheme()
        )),
        BrowserNavigationPolicy::Denied => Err(format!(
            "Browser navigation scheme `{}` is blocked",
            parsed.scheme()
        )),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BrowserNavigationPolicy {
    Embedded,
    ExternalCandidate,
    Denied,
}

pub(crate) fn navigation_policy(url: &url::Url) -> BrowserNavigationPolicy {
    match url.scheme() {
        "https" | "http" => BrowserNavigationPolicy::Embedded,
        "about" if url.as_str() == "about:blank" => BrowserNavigationPolicy::Embedded,
        "mailto" | "tel" | "webcal" | "ms-teams" => BrowserNavigationPolicy::ExternalCandidate,
        _ => BrowserNavigationPolicy::Denied,
    }
}

pub(crate) fn external_protocol_url(value: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(value)
        .map_err(|error| format!("Invalid external protocol URL: {error}"))?;
    if navigation_policy(&parsed) != BrowserNavigationPolicy::ExternalCandidate {
        return Err(format!(
            "External protocol `{}` is not approved for system handoff",
            parsed.scheme()
        ));
    }
    Ok(parsed)
}

pub(crate) fn redact_browser_url(value: &str) -> Option<String> {
    let mut parsed = url::Url::parse(value).ok()?;
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

pub(crate) fn diagnostic_details(
    pairs: impl IntoIterator<Item = (&'static str, serde_json::Value)>,
) -> BTreeMap<String, serde_json::Value> {
    pairs
        .into_iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect()
}

#[cfg(test)]
#[path = "platform_tests.rs"]
mod tests;
