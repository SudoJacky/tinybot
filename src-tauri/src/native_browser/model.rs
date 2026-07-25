use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

macro_rules! string_id_new {
    ($name:ident) => {
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, String> {
                let value = value.into();
                let value = value.trim();
                if value.is_empty() {
                    return Err(concat!(stringify!($name), " is required").to_string());
                }
                Ok(Self(value.to_string()))
            }
        }
    };
}

macro_rules! string_id_as_str {
    ($name:ident) => {
        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

string_id!(BrowserSessionId);
string_id!(BrowserProfileId);
string_id!(BrowserTabId);
string_id!(BrowserNavigationId);
string_id!(BrowserCaptureId);
string_id!(BrowserSurfaceId);
string_id!(BrowserCommandId);
string_id!(BrowserPolicyRequestId);

string_id_new!(BrowserProfileId);
#[cfg(any(test, all(windows, feature = "native-browser-integration")))]
string_id_new!(BrowserSurfaceId);
#[cfg(any(test, all(windows, feature = "native-browser-integration")))]
string_id_new!(BrowserCommandId);

string_id_as_str!(BrowserSessionId);
string_id_as_str!(BrowserProfileId);
string_id_as_str!(BrowserTabId);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserSessionLifecycle {
    Creating,
    Ready,
    Closing,
    Closed,
    Failed,
    Crashed,
}

impl BrowserSessionLifecycle {
    pub fn transition_to(self, next: Self) -> Result<Self, String> {
        let valid = matches!(
            (self, next),
            (Self::Creating, Self::Ready | Self::Failed | Self::Closing)
                | (Self::Ready, Self::Crashed | Self::Failed | Self::Closing)
                | (Self::Crashed, Self::Ready | Self::Failed | Self::Closing)
                | (Self::Failed, Self::Closing)
                | (Self::Closing, Self::Closed | Self::Failed)
        );
        valid
            .then_some(next)
            .ok_or_else(|| format!("Invalid browser session transition: {self:?} -> {next:?}"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserTabLifecycle {
    Creating,
    Ready,
    Loading,
    Closing,
    Closed,
    Crashed,
}

impl BrowserTabLifecycle {
    pub fn transition_to(self, next: Self) -> Result<Self, String> {
        let valid = matches!(
            (self, next),
            (
                Self::Creating,
                Self::Ready | Self::Loading | Self::Closing | Self::Crashed
            ) | (Self::Ready, Self::Loading | Self::Closing | Self::Crashed)
                | (Self::Loading, Self::Ready | Self::Closing | Self::Crashed)
                | (Self::Crashed, Self::Creating | Self::Closing)
                | (Self::Closing, Self::Closed | Self::Crashed)
        );
        valid
            .then_some(next)
            .ok_or_else(|| format!("Invalid browser tab transition: {self:?} -> {next:?}"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserRendererLifecycle {
    Starting,
    Running,
    Failed,
    Restarting,
    Stopped,
}

impl BrowserRendererLifecycle {
    pub fn transition_to(self, next: Self) -> Result<Self, String> {
        let valid = matches!(
            (self, next),
            (Self::Starting, Self::Running | Self::Failed | Self::Stopped)
                | (Self::Running, Self::Failed | Self::Stopped)
                | (Self::Failed, Self::Restarting | Self::Stopped)
                | (
                    Self::Restarting,
                    Self::Running | Self::Failed | Self::Stopped
                )
        );
        valid
            .then_some(next)
            .ok_or_else(|| format!("Invalid browser renderer transition: {self:?} -> {next:?}"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserSurfaceLifecycle {
    Detached,
    Attaching,
    Visible,
    Hidden,
    Failed,
}

impl BrowserSurfaceLifecycle {
    pub fn transition_to(self, next: Self) -> Result<Self, String> {
        let valid = matches!(
            (self, next),
            (Self::Detached, Self::Attaching)
                | (
                    Self::Attaching,
                    Self::Attaching | Self::Visible | Self::Hidden | Self::Failed
                )
                | (Self::Visible, Self::Attaching | Self::Hidden | Self::Failed)
                | (
                    Self::Hidden,
                    Self::Attaching | Self::Detached | Self::Failed
                )
                | (Self::Failed, Self::Attaching | Self::Detached)
        );
        valid
            .then_some(next)
            .ok_or_else(|| format!("Invalid browser surface transition: {self:?} -> {next:?}"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserControlState {
    Idle,
    AgentActive,
    UserRequired,
    Interrupted,
    Failed,
    Recovering,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserProfilePersistence {
    Persistent,
    Incognito,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserCommandStatus {
    Dispatched,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    UserRequired,
}

impl BrowserCommandStatus {
    pub fn transition_to(self, next: Self) -> Result<Self, String> {
        let valid = self == Self::Dispatched
            && matches!(
                next,
                Self::Completed
                    | Self::Failed
                    | Self::Cancelled
                    | Self::TimedOut
                    | Self::UserRequired
            );
        valid
            .then_some(next)
            .ok_or_else(|| format!("Invalid browser command transition: {self:?} -> {next:?}"))
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub device_scale: f64,
}

impl BrowserSurfaceRect {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("x", self.x),
            ("y", self.y),
            ("width", self.width),
            ("height", self.height),
            ("deviceScale", self.device_scale),
        ] {
            if !value.is_finite() {
                return Err(format!("Browser surface {name} must be finite"));
            }
        }
        if self.x < 0.0 || self.y < 0.0 {
            return Err("Browser surface position must be non-negative".to_string());
        }
        if self.width < 1.0 || self.height < 1.0 || self.device_scale <= 0.0 {
            return Err("Browser surface size and scale must be positive".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceUpdate {
    pub browser_session_id: BrowserSessionId,
    pub tab_id: BrowserTabId,
    pub surface_id: BrowserSurfaceId,
    pub layout_revision: u64,
    pub rect: BrowserSurfaceRect,
    pub visible: bool,
    pub live: bool,
    pub topmost: bool,
    pub unobscured: bool,
}

impl BrowserSurfaceUpdate {
    pub fn should_show(&self) -> bool {
        self.visible && self.live && self.topmost && self.unobscured
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCreateSessionInput {
    pub owner_session_id: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default = "default_profile_persistence")]
    pub persistence: BrowserProfilePersistence,
    #[serde(default)]
    pub initial_url: Option<String>,
}

fn default_profile_persistence() -> BrowserProfilePersistence {
    BrowserProfilePersistence::Persistent
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionTarget {
    pub browser_session_id: BrowserSessionId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabTarget {
    pub browser_session_id: BrowserSessionId,
    pub tab_id: BrowserTabId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCreateTabInput {
    pub browser_session_id: BrowserSessionId,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeleteProfileInput {
    pub profile_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigateInput {
    pub browser_session_id: BrowserSessionId,
    pub tab_id: BrowserTabId,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObserveInput {
    pub browser_session_id: BrowserSessionId,
    pub tab_id: BrowserTabId,
    #[serde(default = "default_true")]
    pub capture: bool,
    #[serde(default = "default_true")]
    pub semantic: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractionInput {
    pub browser_session_id: BrowserSessionId,
    pub tab_id: BrowserTabId,
    pub command_id: BrowserCommandId,
    pub control_epoch: u64,
    #[serde(default)]
    pub capture_id: Option<BrowserCaptureId>,
    #[serde(default)]
    pub observation_revision: Option<u64>,
    pub action: BrowserAction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResolvePolicyRequestInput {
    pub browser_session_id: BrowserSessionId,
    pub request_id: BrowserPolicyRequestId,
    pub approved: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserPolicyRequestKind {
    Popup,
    ExternalProtocol,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPolicyRequestSnapshot {
    pub request_id: BrowserPolicyRequestId,
    pub kind: BrowserPolicyRequestKind,
    pub source_tab_id: BrowserTabId,
    pub safe_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum BrowserAction {
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Stop,
    Click {
        x: f64,
        y: f64,
    },
    ClickTarget {
        target_ref: String,
    },
    Type {
        text: String,
    },
    Fill {
        target_ref: String,
        text: String,
    },
    Key {
        key: String,
    },
    Scroll {
        delta_x: f64,
        delta_y: f64,
    },
    Wait {
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        target_ref: Option<String>,
        timeout_ms: u64,
    },
    UserHandoff {
        reason: String,
    },
    Resume,
}

impl BrowserAction {
    pub fn requires_observation(&self) -> bool {
        matches!(
            self,
            Self::Click { .. }
                | Self::ClickTarget { .. }
                | Self::Type { .. }
                | Self::Fill { .. }
                | Self::Key { .. }
                | Self::Scroll { .. }
                | Self::Wait { .. }
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationEntry {
    pub url: String,
    pub title: String,
    pub observed_at: String,
    pub navigation_id: BrowserNavigationId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_id: Option<BrowserCaptureId>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureSnapshot {
    pub capture_id: BrowserCaptureId,
    pub observed_at: String,
    pub stale: bool,
    pub observation_revision: u64,
    pub navigation_id: BrowserNavigationId,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub device_scale: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSemanticNode {
    pub target_ref: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSemanticObservation {
    pub observation_revision: u64,
    pub observed_at: String,
    pub truncated: bool,
    pub nodes: Vec<BrowserSemanticNode>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSnapshot {
    pub tab_id: BrowserTabId,
    pub lifecycle: BrowserTabLifecycle,
    pub renderer_lifecycle: BrowserRendererLifecycle,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub active_history_index: usize,
    pub history: Vec<BrowserNavigationEntry>,
    pub captures: Vec<BrowserCaptureSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_capture_id: Option<BrowserCaptureId>,
    pub navigation_id: BrowserNavigationId,
    pub observation_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_observation: Option<BrowserSemanticObservation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceSnapshot {
    pub lifecycle: BrowserSurfaceLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_id: Option<BrowserSurfaceId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<BrowserTabId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<BrowserSurfaceRect>,
    pub layout_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlSnapshot {
    pub state: BrowserControlState,
    pub control_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_command_id: Option<BrowserCommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionSnapshot {
    pub kind: &'static str,
    pub contract: &'static str,
    pub browser_session_id: BrowserSessionId,
    pub session_id: String,
    pub operation_id: String,
    pub state: &'static str,
    pub runtime_kind: String,
    pub runtime_version: String,
    pub lifecycle: BrowserSessionLifecycle,
    pub profile_id: BrowserProfileId,
    pub profile_persistence: BrowserProfilePersistence,
    pub active_tab_id: BrowserTabId,
    pub tabs: Vec<BrowserTabSnapshot>,
    pub interaction: BrowserInteractionAvailability,
    pub control: BrowserControlSnapshot,
    pub surface: BrowserSurfaceSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_policy_request: Option<BrowserPolicyRequestSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractionAvailability {
    pub navigate: bool,
    pub click: bool,
    #[serde(rename = "type")]
    pub type_text: bool,
    pub key: bool,
    pub scroll: bool,
    pub semantic: bool,
    pub wait: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNativeSnapshot {
    pub schema_version: &'static str,
    pub source_id: String,
    pub revision: u64,
    pub observed_at: String,
    pub provenance: BrowserSnapshotProvenance,
    pub data: BrowserSessionSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotProvenance {
    pub kind: &'static str,
    pub source_id: String,
    pub revision: u64,
    pub observed_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObserveResult {
    pub snapshot: BrowserNativeSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<BrowserCaptureSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic: Option<BrowserSemanticObservation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCommandResult {
    pub command_id: BrowserCommandId,
    pub status: BrowserCommandStatus,
    pub browser_session_id: BrowserSessionId,
    pub tab_id: BrowserTabId,
    pub control_epoch: u64,
    pub observation_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigation_id: Option<BrowserNavigationId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilityDecision {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl BrowserCapabilityDecision {
    pub fn available() -> Self {
        Self {
            available: true,
            reason_code: None,
            reason: None,
        }
    }

    pub fn unavailable(reason_code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason_code: Some(reason_code.into()),
            reason: Some(reason.into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeCapabilities {
    pub schema_version: &'static str,
    pub runtime_kind: String,
    pub runtime_version: String,
    pub session_snapshot: BrowserCapabilityDecision,
    pub direct_input: BrowserCapabilityDecision,
    pub real_capture: BrowserCapabilityDecision,
    pub semantic_observation: BrowserCapabilityDecision,
    pub agent_interaction: BrowserCapabilityDecision,
    pub popups: BrowserCapabilityDecision,
    pub downloads: BrowserCapabilityDecision,
    pub uploads: BrowserCapabilityDecision,
    pub persistent_profiles: BrowserCapabilityDecision,
    pub incognito_profiles: BrowserCapabilityDecision,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeMetrics {
    pub counters: BTreeMap<String, u64>,
    pub durations_ms: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeDiagnostic {
    pub schema_version: &'static str,
    pub event: String,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_session_id: Option<BrowserSessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<BrowserTabId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<BrowserCommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, serde_json::Value>,
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
