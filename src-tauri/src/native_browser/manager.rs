use super::{
    model::{
        BrowserAction, BrowserCaptureId, BrowserCaptureSnapshot, BrowserCommandId,
        BrowserCommandResult, BrowserCommandStatus, BrowserControlSnapshot, BrowserControlState,
        BrowserCreateSessionInput, BrowserCreateTabInput, BrowserDeleteProfileInput,
        BrowserInteractionAvailability, BrowserInteractionInput, BrowserNativeSnapshot,
        BrowserNavigationEntry, BrowserNavigationId, BrowserObserveInput, BrowserObserveResult,
        BrowserPolicyRequestId, BrowserPolicyRequestKind, BrowserPolicyRequestSnapshot,
        BrowserProfileId, BrowserProfilePersistence, BrowserRendererLifecycle,
        BrowserResolvePolicyRequestInput, BrowserRuntimeCapabilities, BrowserRuntimeDiagnostic,
        BrowserRuntimeMetrics, BrowserSemanticNode, BrowserSemanticObservation, BrowserSessionId,
        BrowserSessionLifecycle, BrowserSessionSnapshot, BrowserSnapshotProvenance,
        BrowserSurfaceLifecycle, BrowserSurfaceSnapshot, BrowserSurfaceUpdate, BrowserTabId,
        BrowserTabLifecycle, BrowserTabSnapshot,
    },
    platform::{
        diagnostic_details, external_protocol_url, redact_browser_url, safe_browser_url,
        BrowserPlatformAction, BrowserPlatformCreateTab, BrowserPlatformEvent,
        BrowserPlatformProfile, BrowserPlatformSurface, BrowserRuntimeAdapter,
    },
};
use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const CAPTURE_RETENTION: usize = 12;
const MAX_CAPTURE_BASE64_BYTES: usize = 12 * 1024 * 1024;
const DEFAULT_AGENT_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) type BrowserSnapshotSink = Arc<dyn Fn(BrowserNativeSnapshot) + Send + Sync>;
pub(crate) type BrowserDiagnosticSink = Arc<dyn Fn(BrowserRuntimeDiagnostic) + Send + Sync>;
pub(crate) type SharedBrowserRuntime = Arc<BrowserSessionManager>;

struct BrowserRuntimeState {
    sequence: u64,
    revision: u64,
    accepting_commands: bool,
    sessions: HashMap<BrowserSessionId, BrowserSessionRecord>,
    owner_sessions: HashMap<String, BrowserSessionId>,
    metrics: BrowserRuntimeMetrics,
}

impl Default for BrowserRuntimeState {
    fn default() -> Self {
        Self {
            sequence: 0,
            revision: 0,
            accepting_commands: true,
            sessions: HashMap::new(),
            owner_sessions: HashMap::new(),
            metrics: BrowserRuntimeMetrics::default(),
        }
    }
}

struct BrowserSessionRecord {
    id: BrowserSessionId,
    owner_session_id: String,
    run_id: String,
    profile: BrowserPlatformProfile,
    lifecycle: BrowserSessionLifecycle,
    active_tab_id: BrowserTabId,
    tabs: HashMap<BrowserTabId, BrowserTabRecord>,
    tab_order: Vec<BrowserTabId>,
    control: BrowserControlSnapshot,
    surface: BrowserSurfaceSnapshot,
    pending_policy_request: Option<BrowserPendingPolicyRequest>,
}

#[derive(Clone)]
struct BrowserPendingPolicyRequest {
    snapshot: BrowserPolicyRequestSnapshot,
    url: String,
}

#[derive(Clone)]
struct BrowserActiveCancellation {
    command_id: BrowserCommandId,
    notify: Arc<tokio::sync::Notify>,
    outcome: Arc<Mutex<Option<BrowserCancellationOutcome>>>,
}

#[derive(Clone)]
struct BrowserCancellationOutcome {
    status: BrowserCommandStatus,
    reason_code: String,
    reason: String,
}

struct BrowserTabRecord {
    id: BrowserTabId,
    lifecycle: BrowserTabLifecycle,
    renderer_lifecycle: BrowserRendererLifecycle,
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    navigation_id: BrowserNavigationId,
    navigation_sequence: u64,
    navigation_started_at: Option<Instant>,
    observation_revision: u64,
    history: Vec<BrowserNavigationEntry>,
    active_history_index: usize,
    captures: VecDeque<BrowserCaptureSnapshot>,
    semantic: Option<BrowserSemanticObservation>,
    semantic_targets: HashMap<String, BrowserSemanticTarget>,
}

struct BrowserSemanticTarget {
    selector: String,
    protected_reason: Option<String>,
}

pub(crate) struct BrowserSessionManager {
    adapter: Arc<dyn BrowserRuntimeAdapter>,
    profile_root: PathBuf,
    state: Mutex<BrowserRuntimeState>,
    command_locks: Mutex<HashMap<BrowserTabId, Arc<tokio::sync::Mutex<()>>>>,
    active_cancellations: Mutex<HashMap<BrowserTabId, BrowserActiveCancellation>>,
    surface_lock: tokio::sync::Mutex<()>,
    snapshot_sink: BrowserSnapshotSink,
    diagnostic_sink: BrowserDiagnosticSink,
}

impl BrowserSessionManager {
    pub(crate) fn new(
        adapter: Arc<dyn BrowserRuntimeAdapter>,
        profile_root: PathBuf,
        snapshot_sink: BrowserSnapshotSink,
        diagnostic_sink: BrowserDiagnosticSink,
    ) -> SharedBrowserRuntime {
        let manager = Arc::new(Self {
            adapter: adapter.clone(),
            profile_root,
            state: Mutex::new(BrowserRuntimeState::default()),
            command_locks: Mutex::new(HashMap::new()),
            active_cancellations: Mutex::new(HashMap::new()),
            surface_lock: tokio::sync::Mutex::new(()),
            snapshot_sink,
            diagnostic_sink,
        });
        let weak = Arc::downgrade(&manager);
        adapter.bind_event_sink(Arc::new(move |event| {
            if let Some(manager) = weak.upgrade() {
                manager.handle_platform_event(event);
            }
        }));
        manager
    }

    pub(crate) fn capabilities(&self) -> BrowserRuntimeCapabilities {
        let capabilities = self.adapter.capabilities();
        let unavailable = [
            ("session_snapshot", &capabilities.session_snapshot),
            ("direct_input", &capabilities.direct_input),
            ("real_capture", &capabilities.real_capture),
            ("semantic_observation", &capabilities.semantic_observation),
            ("agent_interaction", &capabilities.agent_interaction),
            ("popups", &capabilities.popups),
            ("downloads", &capabilities.downloads),
            ("uploads", &capabilities.uploads),
            ("persistent_profiles", &capabilities.persistent_profiles),
            ("incognito_profiles", &capabilities.incognito_profiles),
        ]
        .into_iter()
        .filter_map(|(name, decision)| (!decision.available).then_some(name))
        .collect::<Vec<_>>();
        if !unavailable.is_empty() {
            let mut state = self.lock_state();
            for name in unavailable {
                increment_counter(
                    &mut state,
                    &format!("browser.capability.unavailable.{name}"),
                );
            }
        }
        capabilities
    }

    pub(crate) fn metrics(&self) -> BrowserRuntimeMetrics {
        self.lock_state().metrics.clone()
    }

    pub(crate) fn snapshot_for_owner(
        &self,
        owner_session_id: &str,
    ) -> Option<BrowserNativeSnapshot> {
        let state = self.lock_state();
        let session_id = state.owner_sessions.get(owner_session_id)?;
        snapshot_from_state(&state, session_id, self.adapter.as_ref())
    }

    pub(crate) fn snapshot(&self, session_id: &BrowserSessionId) -> Option<BrowserNativeSnapshot> {
        snapshot_from_state(&self.lock_state(), session_id, self.adapter.as_ref())
    }

    pub(crate) fn cancel_agent_command(
        &self,
        tab_id: &BrowserTabId,
        command_id: &BrowserCommandId,
    ) -> bool {
        let cancellation = self
            .active_cancellations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(tab_id)
            .filter(|cancellation| &cancellation.command_id == command_id)
            .cloned();
        if let Some(cancellation) = cancellation {
            let mut outcome = cancellation
                .outcome
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if outcome.is_none() {
                *outcome = Some(BrowserCancellationOutcome {
                    status: BrowserCommandStatus::Cancelled,
                    reason_code: "agent_cancelled".to_string(),
                    reason: "Agent browser command was cancelled".to_string(),
                });
                drop(outcome);
                cancellation.notify.notify_waiters();
                return true;
            }
        }
        false
    }

    pub(crate) async fn create_session(
        self: &Arc<Self>,
        input: BrowserCreateSessionInput,
    ) -> Result<BrowserNativeSnapshot, String> {
        let owner_session_id = required_text(input.owner_session_id, "Browser owner session id")?;
        if let Some(snapshot) = self.snapshot_for_owner(&owner_session_id) {
            return Ok(snapshot);
        }
        let initial_url = safe_browser_url(input.initial_url.as_deref().unwrap_or("about:blank"))?;
        let profile_id = validated_profile_id(input.profile_id.as_deref(), &owner_session_id)?;
        let (session_id, tab_id, profile) = {
            let mut state = self.lock_state();
            ensure_accepting(&state)?;
            let session_id = BrowserSessionId(next_id(&mut state, "browser-session"));
            let tab_id = BrowserTabId(next_id(&mut state, "browser-tab"));
            let profile = BrowserPlatformProfile {
                data_directory: profile_directory(
                    &self.profile_root,
                    &profile_id,
                    input.persistence,
                    &session_id,
                ),
                profile_id,
                persistence: input.persistence,
            };
            let navigation_id = BrowserNavigationId(next_id(&mut state, "browser-navigation"));
            let observed_at = now_timestamp();
            let url = initial_url.to_string();
            let tab = BrowserTabRecord {
                id: tab_id.clone(),
                lifecycle: BrowserTabLifecycle::Creating,
                renderer_lifecycle: BrowserRendererLifecycle::Starting,
                url: url.clone(),
                title: "New tab".to_string(),
                loading: true,
                can_go_back: false,
                can_go_forward: false,
                navigation_id: navigation_id.clone(),
                navigation_sequence: 1,
                navigation_started_at: None,
                observation_revision: 0,
                history: vec![BrowserNavigationEntry {
                    url,
                    title: "New tab".to_string(),
                    observed_at,
                    navigation_id,
                    capture_id: None,
                }],
                active_history_index: 0,
                captures: VecDeque::new(),
                semantic: None,
                semantic_targets: HashMap::new(),
            };
            let session = BrowserSessionRecord {
                id: session_id.clone(),
                owner_session_id: owner_session_id.clone(),
                run_id: format!("tinyos-browser-session-{session_id}"),
                profile: profile.clone(),
                lifecycle: BrowserSessionLifecycle::Creating,
                active_tab_id: tab_id.clone(),
                tabs: HashMap::from([(tab_id.clone(), tab)]),
                tab_order: vec![tab_id.clone()],
                control: BrowserControlSnapshot {
                    state: BrowserControlState::Idle,
                    control_epoch: 0,
                    active_command_id: None,
                    reason: None,
                },
                surface: BrowserSurfaceSnapshot {
                    lifecycle: BrowserSurfaceLifecycle::Detached,
                    surface_id: None,
                    tab_id: None,
                    rect: None,
                    layout_revision: 0,
                    reason: None,
                },
                pending_policy_request: None,
            };
            state
                .owner_sessions
                .insert(owner_session_id, session_id.clone());
            state.sessions.insert(session_id.clone(), session);
            increment_counter(&mut state, "browser.session.create.started");
            bump_revision(&mut state);
            (session_id, tab_id, profile)
        };
        self.insert_command_lock(tab_id.clone());
        self.publish_snapshot(&session_id);

        let started = Instant::now();
        let created = self
            .adapter
            .create_tab(BrowserPlatformCreateTab {
                tab_id: tab_id.clone(),
                profile,
                url: initial_url.to_string(),
            })
            .await;

        match created {
            Ok(platform) => {
                {
                    let mut state = self.lock_state();
                    let Some(session) = state.sessions.get_mut(&session_id) else {
                        return Err(
                            "Browser session closed while its first tab was creating".to_string()
                        );
                    };
                    session.lifecycle = session
                        .lifecycle
                        .transition_to(BrowserSessionLifecycle::Ready)?;
                    let tab = session.tabs.get_mut(&tab_id).ok_or_else(|| {
                        "Browser initial tab disappeared during creation".to_string()
                    })?;
                    complete_tab_creation(tab)?;
                    tab.loading = false;
                    tab.url = platform.url;
                    tab.title = platform.title;
                    tab.can_go_back = platform.can_go_back;
                    tab.can_go_forward = platform.can_go_forward;
                    increment_counter(&mut state, "browser.session.create.completed");
                    record_duration(&mut state, "browser.session.create", started.elapsed());
                    bump_revision(&mut state);
                }
                self.diagnostic(
                    "browser.session.created",
                    Some(session_id.clone()),
                    Some(tab_id.clone()),
                    None,
                    None,
                    Some(initial_url.as_str()),
                    BTreeMap::new(),
                );
                self.publish_snapshot(&session_id);
                self.snapshot(&session_id)
                    .ok_or_else(|| "Browser session disappeared after creation".to_string())
            }
            Err(error) => {
                self.remove_command_lock(&tab_id);
                {
                    let mut state = self.lock_state();
                    if let Some(session) = state.sessions.get_mut(&session_id) {
                        session.lifecycle = BrowserSessionLifecycle::Failed;
                        session.control.state = BrowserControlState::Failed;
                        session.control.reason = Some(error.clone());
                        if let Some(tab) = session.tabs.get_mut(&tab_id) {
                            tab.lifecycle = BrowserTabLifecycle::Crashed;
                            tab.renderer_lifecycle = BrowserRendererLifecycle::Failed;
                            tab.loading = false;
                        }
                    }
                    increment_counter(&mut state, "browser.session.create.failed");
                    record_duration(&mut state, "browser.session.create", started.elapsed());
                    bump_revision(&mut state);
                }
                self.diagnostic(
                    "browser.session.create_failed",
                    Some(session_id.clone()),
                    Some(tab_id),
                    None,
                    Some("adapter_initialization_failed"),
                    Some(initial_url.as_str()),
                    diagnostic_details([("message", serde_json::Value::String(error.clone()))]),
                );
                self.publish_snapshot(&session_id);
                Err(error)
            }
        }
    }

    pub(crate) async fn create_tab(
        self: &Arc<Self>,
        input: BrowserCreateTabInput,
    ) -> Result<BrowserNativeSnapshot, String> {
        let url = safe_browser_url(input.url.as_deref().unwrap_or("about:blank"))?;
        let (tab_id, profile) = {
            let mut state = self.lock_state();
            ensure_accepting(&state)?;
            let tab_id = BrowserTabId(next_id(&mut state, "browser-tab"));
            let navigation_id = BrowserNavigationId(next_id(&mut state, "browser-navigation"));
            let session = ready_session_mut(&mut state, &input.browser_session_id)?;
            let tab = new_tab_record(tab_id.clone(), navigation_id, url.as_str());
            session.tabs.insert(tab_id.clone(), tab);
            session.tab_order.push(tab_id.clone());
            session.active_tab_id = tab_id.clone();
            let profile = session.profile.clone();
            increment_counter(&mut state, "browser.tab.create.started");
            bump_revision(&mut state);
            (tab_id, profile)
        };
        self.insert_command_lock(tab_id.clone());
        self.publish_snapshot(&input.browser_session_id);
        let platform = self
            .adapter
            .create_tab(BrowserPlatformCreateTab {
                tab_id: tab_id.clone(),
                profile,
                url: url.to_string(),
            })
            .await;
        match platform {
            Ok(platform) => {
                let diagnostic_url = platform.url.clone();
                let mut state = self.lock_state();
                let session = ready_session_mut(&mut state, &input.browser_session_id)?;
                let tab = session
                    .tabs
                    .get_mut(&tab_id)
                    .ok_or_else(|| "Browser tab closed during creation".to_string())?;
                complete_tab_creation(tab)?;
                tab.loading = false;
                tab.url = platform.url;
                tab.title = platform.title;
                tab.can_go_back = platform.can_go_back;
                tab.can_go_forward = platform.can_go_forward;
                increment_counter(&mut state, "browser.tab.create.completed");
                bump_revision(&mut state);
                drop(state);
                self.diagnostic(
                    "browser.tab.created",
                    Some(input.browser_session_id.clone()),
                    Some(tab_id.clone()),
                    None,
                    None,
                    Some(&diagnostic_url),
                    BTreeMap::new(),
                );
                self.publish_snapshot(&input.browser_session_id);
                self.snapshot(&input.browser_session_id)
                    .ok_or_else(|| "Browser session disappeared after tab creation".to_string())
            }
            Err(error) => {
                self.remove_command_lock(&tab_id);
                let mut state = self.lock_state();
                if let Some(session) = state.sessions.get_mut(&input.browser_session_id) {
                    session.tabs.remove(&tab_id);
                    session.tab_order.retain(|id| id != &tab_id);
                    if let Some(first) = session.tab_order.first() {
                        session.active_tab_id = first.clone();
                    }
                }
                increment_counter(&mut state, "browser.tab.create.failed");
                bump_revision(&mut state);
                drop(state);
                self.diagnostic(
                    "browser.tab.create_failed",
                    Some(input.browser_session_id.clone()),
                    Some(tab_id.clone()),
                    None,
                    Some("adapter_tab_create_failed"),
                    Some(url.as_str()),
                    diagnostic_details([("message", serde_json::Value::String(error.clone()))]),
                );
                self.publish_snapshot(&input.browser_session_id);
                Err(error)
            }
        }
    }

    pub(crate) async fn activate_tab(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<BrowserNativeSnapshot, String> {
        let surface = {
            let mut state = self.lock_state();
            let session = ready_session_mut(&mut state, session_id)?;
            require_tab(session, tab_id)?;
            session.active_tab_id = tab_id.clone();
            let surface = session.surface.clone();
            bump_revision(&mut state);
            surface
        };
        if let (Some(rect), true) = (
            surface.rect,
            surface.lifecycle == BrowserSurfaceLifecycle::Visible,
        ) {
            self.adapter
                .set_surface(BrowserPlatformSurface {
                    tab_id: tab_id.clone(),
                    rect,
                    visible: true,
                })
                .await?;
        }
        self.publish_snapshot(session_id);
        self.snapshot(session_id)
            .ok_or_else(|| "Browser session disappeared after tab activation".to_string())
    }

    pub(crate) async fn close_tab(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<BrowserNativeSnapshot, String> {
        let started = Instant::now();
        {
            let mut state = self.lock_state();
            let session = ready_session_mut(&mut state, session_id)?;
            if session.tabs.len() == 1 {
                return Err("A browser session must retain at least one tab".to_string());
            }
            let tab = require_tab_mut(session, tab_id)?;
            tab.lifecycle = tab.lifecycle.transition_to(BrowserTabLifecycle::Closing)?;
            bump_revision(&mut state);
        }
        self.publish_snapshot(session_id);
        if let Err(error) = self.adapter.close_tab(tab_id).await {
            let mut state = self.lock_state();
            if let Some(session) = state.sessions.get_mut(session_id) {
                session.control.state = BrowserControlState::Failed;
                session.control.reason = Some(error.clone());
                if let Some(tab) = session.tabs.get_mut(tab_id) {
                    tab.lifecycle = BrowserTabLifecycle::Crashed;
                }
            }
            increment_counter(&mut state, "browser.tab.close.failed");
            record_duration(&mut state, "browser.tab.close", started.elapsed());
            bump_revision(&mut state);
            drop(state);
            self.diagnostic(
                "browser.tab.close_failed",
                Some(session_id.clone()),
                Some(tab_id.clone()),
                None,
                Some("adapter_tab_close_failed"),
                None,
                diagnostic_details([("message", serde_json::Value::String(error.clone()))]),
            );
            self.publish_snapshot(session_id);
            return Err(error);
        }
        self.remove_command_lock(tab_id);
        let cleared_surface = {
            let mut state = self.lock_state();
            let session = state
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "Browser session is unavailable".to_string())?;
            session.tabs.remove(tab_id);
            session.tab_order.retain(|id| id != tab_id);
            if session.active_tab_id == *tab_id {
                session.active_tab_id = session
                    .tab_order
                    .first()
                    .cloned()
                    .ok_or_else(|| "Browser session lost every tab".to_string())?;
            }
            let cleared_surface = session.surface.tab_id.as_ref() == Some(tab_id);
            if cleared_surface {
                session.surface.lifecycle = match session.surface.lifecycle {
                    BrowserSurfaceLifecycle::Attaching | BrowserSurfaceLifecycle::Visible => {
                        session
                            .surface
                            .lifecycle
                            .transition_to(BrowserSurfaceLifecycle::Hidden)?
                    }
                    BrowserSurfaceLifecycle::Failed => session
                        .surface
                        .lifecycle
                        .transition_to(BrowserSurfaceLifecycle::Detached)?,
                    lifecycle => lifecycle,
                };
                session.surface.surface_id = None;
                session.surface.tab_id = None;
                session.surface.rect = None;
                session.surface.reason = Some("The attached browser tab was closed".to_string());
            }
            increment_counter(&mut state, "browser.tab.close.completed");
            record_duration(&mut state, "browser.tab.close", started.elapsed());
            bump_revision(&mut state);
            cleared_surface
        };
        self.diagnostic(
            "browser.tab.closed",
            Some(session_id.clone()),
            Some(tab_id.clone()),
            None,
            None,
            None,
            diagnostic_details([("surface_cleared", serde_json::Value::Bool(cleared_surface))]),
        );
        self.publish_snapshot(session_id);
        self.snapshot(session_id)
            .ok_or_else(|| "Browser session disappeared after tab close".to_string())
    }

    pub(crate) async fn navigate(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
        url: &str,
    ) -> Result<BrowserNativeSnapshot, String> {
        let url = safe_browser_url(url)?;
        let started = Instant::now();
        {
            let mut state = self.lock_state();
            let session = ready_session_mut(&mut state, session_id)?;
            let tab = require_tab_mut(session, tab_id)?;
            tab.lifecycle = tab.lifecycle.transition_to(BrowserTabLifecycle::Loading)?;
            tab.loading = true;
            bump_revision(&mut state);
        }
        self.publish_snapshot(session_id);
        if let Err(error) = self.adapter.navigate(tab_id, url.as_str()).await {
            let mut state = self.lock_state();
            if let Some(tab) = state
                .sessions
                .get_mut(session_id)
                .and_then(|session| session.tabs.get_mut(tab_id))
            {
                tab.lifecycle = BrowserTabLifecycle::Ready;
                tab.loading = false;
            }
            increment_counter(&mut state, "browser.navigation.failed");
            record_duration(&mut state, "browser.navigation", started.elapsed());
            bump_revision(&mut state);
            drop(state);
            self.diagnostic(
                "browser.navigation.failed",
                Some(session_id.clone()),
                Some(tab_id.clone()),
                None,
                Some("platform_navigation_failed"),
                Some(url.as_str()),
                diagnostic_details([("message", serde_json::Value::String(error.clone()))]),
            );
            self.publish_snapshot(session_id);
            return Err(error);
        }
        self.snapshot(session_id)
            .ok_or_else(|| "Browser session disappeared after navigation dispatch".to_string())
    }

    pub(crate) async fn back(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<(), String> {
        self.require_ready_tab(session_id, tab_id)?;
        self.adapter.back(tab_id).await
    }

    pub(crate) async fn forward(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<(), String> {
        self.require_ready_tab(session_id, tab_id)?;
        self.adapter.forward(tab_id).await
    }

    pub(crate) async fn reload(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<(), String> {
        self.require_ready_tab(session_id, tab_id)?;
        self.adapter.reload(tab_id).await
    }

    pub(crate) async fn stop(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<(), String> {
        self.require_ready_tab(session_id, tab_id)?;
        self.adapter.stop(tab_id).await
    }

    pub(crate) async fn restart_tab(
        self: &Arc<Self>,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<BrowserNativeSnapshot, String> {
        let (request, surface) = {
            let mut state = self.lock_state();
            ensure_accepting(&state)?;
            let session = state
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "Browser session is unavailable".to_string())?;
            if session.lifecycle != BrowserSessionLifecycle::Crashed {
                return Err("Only a crashed browser renderer can be restarted".to_string());
            }
            let url = {
                let tab = require_tab_mut(session, tab_id)?;
                if tab.lifecycle != BrowserTabLifecycle::Crashed
                    || tab.renderer_lifecycle != BrowserRendererLifecycle::Failed
                {
                    return Err("Only a crashed browser renderer can be restarted".to_string());
                }
                tab.lifecycle = tab.lifecycle.transition_to(BrowserTabLifecycle::Creating)?;
                tab.renderer_lifecycle = tab
                    .renderer_lifecycle
                    .transition_to(BrowserRendererLifecycle::Restarting)?;
                tab.loading = true;
                tab.url.clone()
            };
            session.control.state = BrowserControlState::Recovering;
            session.control.reason = Some("Restarting crashed browser renderer".to_string());
            session.control.control_epoch = session.control.control_epoch.saturating_add(1);
            session.control.active_command_id = None;
            let request = BrowserPlatformCreateTab {
                tab_id: tab_id.clone(),
                profile: session.profile.clone(),
                url,
            };
            let surface = session.surface.clone();
            increment_counter(&mut state, "browser.renderer.restart.started");
            bump_revision(&mut state);
            (request, surface)
        };
        self.publish_snapshot(session_id);
        if let Err(error) = self.adapter.close_tab(tab_id).await {
            self.fail_renderer_restart(session_id, tab_id, &error);
            return Err(format!("Failed to close crashed browser renderer: {error}"));
        }
        let platform = match self.adapter.create_tab(request).await {
            Ok(platform) => platform,
            Err(error) => {
                self.fail_renderer_restart(session_id, tab_id, &error);
                return Err(format!("Failed to restart browser renderer: {error}"));
            }
        };
        {
            let mut state = self.lock_state();
            let session = state
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "Browser session closed during renderer restart".to_string())?;
            let tab = require_tab_mut(session, tab_id)?;
            complete_tab_creation(tab)?;
            tab.loading = false;
            tab.url = platform.url;
            tab.title = platform.title;
            tab.can_go_back = platform.can_go_back;
            tab.can_go_forward = platform.can_go_forward;
            session.lifecycle = session
                .lifecycle
                .transition_to(BrowserSessionLifecycle::Ready)?;
            session.control.state = BrowserControlState::Idle;
            session.control.reason = None;
            increment_counter(&mut state, "browser.renderer.restart.completed");
            bump_revision(&mut state);
        }
        if surface.lifecycle == BrowserSurfaceLifecycle::Visible
            && surface.tab_id.as_ref() == Some(tab_id)
        {
            if let Some(rect) = surface.rect {
                self.adapter
                    .set_surface(BrowserPlatformSurface {
                        tab_id: tab_id.clone(),
                        rect,
                        visible: true,
                    })
                    .await?;
            }
        }
        self.publish_snapshot(session_id);
        let _ = self
            .observe(BrowserObserveInput {
                browser_session_id: session_id.clone(),
                tab_id: tab_id.clone(),
                capture: true,
                semantic: true,
            })
            .await;
        self.snapshot(session_id)
            .ok_or_else(|| "Browser session disappeared after renderer restart".to_string())
    }

    fn fail_renderer_restart(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
        error: &str,
    ) {
        let mut state = self.lock_state();
        if let Some(session) = state.sessions.get_mut(session_id) {
            session.lifecycle = BrowserSessionLifecycle::Failed;
            session.control.state = BrowserControlState::Failed;
            session.control.reason = Some(error.to_string());
            if let Some(tab) = session.tabs.get_mut(tab_id) {
                tab.lifecycle = BrowserTabLifecycle::Crashed;
                tab.renderer_lifecycle = BrowserRendererLifecycle::Failed;
                tab.loading = false;
            }
        }
        increment_counter(&mut state, "browser.renderer.restart.failed");
        bump_revision(&mut state);
        drop(state);
        self.publish_snapshot(session_id);
    }

    pub(crate) async fn update_surface(
        self: &Arc<Self>,
        input: BrowserSurfaceUpdate,
    ) -> Result<BrowserNativeSnapshot, String> {
        let _surface_guard = self.surface_lock.lock().await;
        input.rect.validate()?;
        let show = input.should_show();
        let capture_before_hide = {
            let state = self.lock_state();
            let session = state
                .sessions
                .get(&input.browser_session_id)
                .ok_or_else(|| "Browser session is unavailable".to_string())?;
            require_tab(session, &input.tab_id)?;
            input.layout_revision >= session.surface.layout_revision
                && !show
                && session.surface.lifecycle == BrowserSurfaceLifecycle::Visible
        };
        if capture_before_hide {
            let _ = self
                .observe(BrowserObserveInput {
                    browser_session_id: input.browser_session_id.clone(),
                    tab_id: input.tab_id.clone(),
                    capture: true,
                    semantic: false,
                })
                .await;
        }
        let previous_surface = {
            let mut state = self.lock_state();
            let session = ready_session_mut(&mut state, &input.browser_session_id)?;
            if input.layout_revision < session.surface.layout_revision {
                return Err(format!(
                    "Browser surface layout revision {} is stale; current revision is {}",
                    input.layout_revision, session.surface.layout_revision
                ));
            }
            let previous_surface = session.surface.clone();
            session.surface = BrowserSurfaceSnapshot {
                lifecycle: session
                    .surface
                    .lifecycle
                    .transition_to(BrowserSurfaceLifecycle::Attaching)?,
                surface_id: Some(input.surface_id.clone()),
                tab_id: Some(input.tab_id.clone()),
                rect: Some(input.rect.clone()),
                layout_revision: input.layout_revision,
                reason: (!show).then(|| hidden_surface_reason(&input)),
            };
            bump_revision(&mut state);
            previous_surface
        };
        self.publish_snapshot(&input.browser_session_id);
        if previous_surface.lifecycle == BrowserSurfaceLifecycle::Visible
            && previous_surface.tab_id.as_ref() != Some(&input.tab_id)
        {
            if let (Some(previous_tab_id), Some(previous_rect)) =
                (previous_surface.tab_id, previous_surface.rect)
            {
                self.adapter
                    .set_surface(BrowserPlatformSurface {
                        tab_id: previous_tab_id,
                        rect: previous_rect,
                        visible: false,
                    })
                    .await?;
            }
        }
        let result = self
            .adapter
            .set_surface(BrowserPlatformSurface {
                tab_id: input.tab_id.clone(),
                rect: input.rect.clone(),
                visible: show,
            })
            .await;
        let superseded = {
            let mut state = self.lock_state();
            let session = state
                .sessions
                .get_mut(&input.browser_session_id)
                .ok_or_else(|| "Browser session is unavailable".to_string())?;
            if session.surface.layout_revision != input.layout_revision {
                true
            } else {
                match &result {
                    Ok(()) => {
                        let next = if show {
                            BrowserSurfaceLifecycle::Visible
                        } else {
                            BrowserSurfaceLifecycle::Hidden
                        };
                        session.surface.lifecycle =
                            session.surface.lifecycle.transition_to(next)?;
                        increment_counter(
                            &mut state,
                            if show {
                                "browser.surface.visible"
                            } else {
                                "browser.surface.hidden"
                            },
                        );
                    }
                    Err(error) => {
                        session.surface.lifecycle = session
                            .surface
                            .lifecycle
                            .transition_to(BrowserSurfaceLifecycle::Failed)?;
                        session.surface.reason = Some(error.clone());
                        increment_counter(&mut state, "browser.surface.failed");
                    }
                }
                bump_revision(&mut state);
                false
            }
        };
        if superseded {
            self.diagnostic(
                "browser.surface.superseded",
                Some(input.browser_session_id.clone()),
                Some(input.tab_id.clone()),
                None,
                Some("layout_revision_superseded"),
                None,
                diagnostic_details([(
                    "layoutRevision",
                    serde_json::Value::from(input.layout_revision),
                )]),
            );
            result?;
            return self.snapshot(&input.browser_session_id).ok_or_else(|| {
                "Browser session disappeared after superseded surface update".to_string()
            });
        }
        self.publish_snapshot(&input.browser_session_id);
        self.diagnostic(
            if result.is_ok() {
                if show {
                    "browser.surface.visible"
                } else {
                    "browser.surface.hidden"
                }
            } else {
                "browser.surface.failed"
            },
            Some(input.browser_session_id.clone()),
            Some(input.tab_id.clone()),
            None,
            result.as_ref().err().map(|_| "platform_surface_failed"),
            None,
            diagnostic_details([
                (
                    "layoutRevision",
                    serde_json::Value::from(input.layout_revision),
                ),
                (
                    "deviceScale",
                    serde_json::Value::from(input.rect.device_scale),
                ),
            ]),
        );
        result?;
        if show {
            let manager = self.clone();
            let observe_input = BrowserObserveInput {
                browser_session_id: input.browser_session_id.clone(),
                tab_id: input.tab_id.clone(),
                capture: true,
                semantic: true,
            };
            tauri::async_runtime::spawn(async move {
                if let Err(error) = manager.observe(observe_input).await {
                    eprintln!("failed to capture visible native browser surface: {error}");
                }
            });
        }
        self.snapshot(&input.browser_session_id)
            .ok_or_else(|| "Browser session disappeared after surface update".to_string())
    }

    pub(crate) async fn observe(
        self: &Arc<Self>,
        input: BrowserObserveInput,
    ) -> Result<BrowserObserveResult, String> {
        self.require_ready_tab(&input.browser_session_id, &input.tab_id)?;
        let started = Instant::now();
        let platform = self
            .adapter
            .observe(&input.tab_id, input.capture, input.semantic)
            .await;
        let platform = match platform {
            Ok(platform) => platform,
            Err(error) => {
                let mut state = self.lock_state();
                increment_counter(&mut state, "browser.observe.failed");
                record_duration(&mut state, "browser.observe", started.elapsed());
                drop(state);
                self.diagnostic(
                    "browser.observe.failed",
                    Some(input.browser_session_id.clone()),
                    Some(input.tab_id.clone()),
                    None,
                    Some("platform_observation_failed"),
                    None,
                    diagnostic_details([("message", serde_json::Value::String(error.clone()))]),
                );
                return Err(error);
            }
        };

        let (capture, semantic) = {
            let mut state = self.lock_state();
            let navigation_id = {
                let session = ready_session_mut(&mut state, &input.browser_session_id)?;
                require_tab(session, &input.tab_id)?.navigation_id.clone()
            };
            let capture_id = input
                .capture
                .then(|| BrowserCaptureId(next_id(&mut state, "browser-capture")));
            let observed_at = now_timestamp();
            let (capture, semantic, retention_truncated) = {
                let session = ready_session_mut(&mut state, &input.browser_session_id)?;
                let tab = require_tab_mut(session, &input.tab_id)?;
                tab.observation_revision = tab.observation_revision.saturating_add(1);
                let observation_revision = tab.observation_revision;

                let capture = if let Some(capture_id) = capture_id {
                    let data_url = platform
                        .capture_base64
                        .map(|base64| {
                            if base64.len() > MAX_CAPTURE_BASE64_BYTES {
                                return Err(format!(
                                    "Browser capture exceeds the {} byte retention limit",
                                    MAX_CAPTURE_BASE64_BYTES
                                ));
                            }
                            Ok(format!("data:image/png;base64,{base64}"))
                        })
                        .transpose()?;
                    for retained in &mut tab.captures {
                        retained.stale = true;
                    }
                    let capture = BrowserCaptureSnapshot {
                        capture_id: capture_id.clone(),
                        observed_at: observed_at.clone(),
                        stale: false,
                        observation_revision,
                        navigation_id: navigation_id.clone(),
                        viewport_width: platform.viewport_width,
                        viewport_height: platform.viewport_height,
                        device_scale: platform.device_scale,
                        data_url,
                    };
                    tab.captures.push_back(capture.clone());
                    let mut retention_truncated = 0;
                    while tab.captures.len() > CAPTURE_RETENTION {
                        tab.captures.pop_front();
                        retention_truncated += 1;
                    }
                    if let Some(history) = tab.history.get_mut(tab.active_history_index) {
                        history.capture_id = Some(capture_id);
                    }
                    (Some(capture), retention_truncated)
                } else {
                    (None, 0)
                };

                tab.semantic_targets.clear();
                let semantic = if input.semantic {
                    let nodes = platform
                        .semantic_nodes
                        .into_iter()
                        .enumerate()
                        .map(|(index, node)| {
                            let target_ref = format!("target-{observation_revision}-{index}");
                            tab.semantic_targets.insert(
                                target_ref.clone(),
                                BrowserSemanticTarget {
                                    selector: node.selector,
                                    protected_reason: node.protected_reason.clone(),
                                },
                            );
                            BrowserSemanticNode {
                                target_ref,
                                role: node.role,
                                name: node.name,
                                frame: node.frame,
                                x: node.x,
                                y: node.y,
                                width: node.width,
                                height: node.height,
                                disabled: node.disabled,
                                focused: node.focused,
                                sensitive: node.sensitive,
                                protected_reason: node.protected_reason,
                            }
                        })
                        .collect();
                    let observation = BrowserSemanticObservation {
                        observation_revision,
                        observed_at,
                        truncated: platform.semantic_truncated,
                        nodes,
                    };
                    tab.semantic = Some(observation.clone());
                    Some(observation)
                } else {
                    None
                };
                (capture.0, semantic, capture.1)
            };
            for _ in 0..retention_truncated {
                increment_counter(&mut state, "browser.capture.retention_truncated");
            }
            increment_counter(&mut state, "browser.observe.completed");
            if capture.is_some() {
                increment_counter(&mut state, "browser.capture.completed");
                record_duration(&mut state, "browser.capture", started.elapsed());
            }
            record_duration(&mut state, "browser.observe", started.elapsed());
            bump_revision(&mut state);
            (capture, semantic)
        };
        self.publish_snapshot(&input.browser_session_id);
        let snapshot = self
            .snapshot(&input.browser_session_id)
            .ok_or_else(|| "Browser session disappeared after observation".to_string())?;
        self.diagnostic(
            "browser.observe.completed",
            Some(input.browser_session_id.clone()),
            Some(input.tab_id.clone()),
            None,
            None,
            None,
            diagnostic_details([
                (
                    "observationRevision",
                    serde_json::Value::from(
                        snapshot
                            .data
                            .tabs
                            .iter()
                            .find(|tab| tab.tab_id == input.tab_id)
                            .map(|tab| tab.observation_revision)
                            .unwrap_or_default(),
                    ),
                ),
                (
                    "durationMs",
                    serde_json::Value::from(
                        started.elapsed().as_millis().min(u64::MAX as u128) as u64
                    ),
                ),
            ]),
        );
        if let Some(capture) = capture.as_ref() {
            self.diagnostic(
                "browser.capture.completed",
                Some(input.browser_session_id.clone()),
                Some(input.tab_id.clone()),
                None,
                None,
                None,
                diagnostic_details([
                    (
                        "captureId",
                        serde_json::Value::String(capture.capture_id.to_string()),
                    ),
                    (
                        "observationRevision",
                        serde_json::Value::from(capture.observation_revision),
                    ),
                ]),
            );
        }
        Ok(BrowserObserveResult {
            snapshot,
            capture,
            semantic,
        })
    }

    pub(crate) async fn interact(
        self: &Arc<Self>,
        input: BrowserInteractionInput,
    ) -> Result<BrowserCommandResult, String> {
        let command_lock = self.command_lock(&input.tab_id)?;
        let _command_guard = command_lock.lock().await;
        let started = Instant::now();
        let cancellation = BrowserActiveCancellation {
            command_id: input.command_id.clone(),
            notify: Arc::new(tokio::sync::Notify::new()),
            outcome: Arc::new(Mutex::new(None)),
        };
        let platform_action = {
            let mut state = self.lock_state();
            ensure_accepting(&state)?;
            let validation = (|| -> Result<BrowserPlatformAction, (&'static str, String)> {
                let session = ready_session(&state, &input.browser_session_id)
                    .map_err(|error| ("browser.command.rejected.session", error))?;
                if session.control.control_epoch != input.control_epoch {
                    return Err((
                        "browser.command.rejected.stale_epoch",
                        format!(
                            "Browser control epoch {} is stale; current epoch is {}",
                            input.control_epoch, session.control.control_epoch
                        ),
                    ));
                }
                let tab = require_tab(session, &input.tab_id)
                    .map_err(|error| ("browser.command.rejected.tab", error))?;
                if input.action.requires_observation() {
                    let expected_revision = input.observation_revision.ok_or_else(|| {
                        (
                            "browser.command.rejected.missing_observation",
                            "Browser interaction requires an observation revision".to_string(),
                        )
                    })?;
                    if expected_revision != tab.observation_revision {
                        return Err(("browser.command.rejected.stale_observation", format!(
                            "Browser observation revision {expected_revision} is stale; current revision is {}",
                            tab.observation_revision
                        )));
                    }
                    if let Some(capture_id) = &input.capture_id {
                        let current = tab.captures.back().map(|capture| &capture.capture_id);
                        if current != Some(capture_id) {
                            return Err((
                                "browser.command.rejected.stale_capture",
                                "Browser interaction capture is stale".to_string(),
                            ));
                        }
                    }
                }
                match &input.action {
                    BrowserAction::Click { x, y } => {
                        if !x.is_finite() || !y.is_finite() || *x < 0.0 || *y < 0.0 {
                            return Err((
                                "browser.command.rejected.coordinates",
                                "Browser click coordinates must be finite and non-negative"
                                    .to_string(),
                            ));
                        }
                        let capture_id = input.capture_id.as_ref().ok_or_else(|| {
                            (
                                "browser.command.rejected.missing_capture",
                                "Coordinate interaction requires the current capture identity"
                                    .to_string(),
                            )
                        })?;
                        let capture = tab
                            .captures
                            .back()
                            .filter(|capture| &capture.capture_id == capture_id)
                            .ok_or_else(|| {
                                (
                                    "browser.command.rejected.stale_capture",
                                    "Browser interaction capture is stale".to_string(),
                                )
                            })?;
                        if *x > f64::from(capture.viewport_width)
                            || *y > f64::from(capture.viewport_height)
                        {
                            return Err((
                                "browser.command.rejected.coordinates",
                                format!(
                                    "Browser click ({x}, {y}) exceeds current viewport {}x{} at scale {}",
                                    capture.viewport_width,
                                    capture.viewport_height,
                                    capture.device_scale
                                ),
                            ));
                        }
                        Ok(BrowserPlatformAction::Browser(input.action.clone()))
                    }
                    BrowserAction::ClickTarget { target_ref } => {
                        let target = tab.semantic_targets.get(target_ref).ok_or_else(|| {
                            (
                                "browser.command.rejected.stale_target",
                                "Browser semantic target is stale or unavailable".to_string(),
                            )
                        })?;
                        if let Some(reason_code) = &target.protected_reason {
                            Ok(BrowserPlatformAction::UserRequired {
                                reason_code: reason_code.clone(),
                                reason: protected_operation_reason(reason_code),
                            })
                        } else {
                            Ok(BrowserPlatformAction::ClickSelector {
                                selector: target.selector.clone(),
                            })
                        }
                    }
                    BrowserAction::Fill { target_ref, text } => {
                        let target = tab.semantic_targets.get(target_ref).ok_or_else(|| {
                            (
                                "browser.command.rejected.stale_target",
                                "Browser semantic target is stale or unavailable".to_string(),
                            )
                        })?;
                        if let Some(reason_code) = &target.protected_reason {
                            Ok(BrowserPlatformAction::UserRequired {
                                reason_code: reason_code.clone(),
                                reason: protected_operation_reason(reason_code),
                            })
                        } else {
                            Ok(BrowserPlatformAction::FillSelector {
                                selector: target.selector.clone(),
                                text: text.clone(),
                            })
                        }
                    }
                    action => Ok(BrowserPlatformAction::Browser(action.clone())),
                }
            })();
            let platform_action = match validation {
                Ok(action) => action,
                Err((metric, error)) => {
                    increment_counter(&mut state, metric);
                    return Err(error);
                }
            };
            let session = ready_session_mut(&mut state, &input.browser_session_id)?;
            /* Validation above deliberately runs before mutable state transitions so rejected
             * commands can be observed without overlapping session and metrics borrows. */
            if let BrowserPlatformAction::UserRequired {
                reason_code,
                reason,
            } = &platform_action
            {
                session.control.state = BrowserControlState::UserRequired;
                session.control.reason = Some(reason.clone());
                session.control.active_command_id = None;
                increment_counter(&mut state, "browser.command.user_required");
                bump_revision(&mut state);
                drop(state);
                self.publish_snapshot(&input.browser_session_id);
                let result = self.command_result(
                    &input,
                    BrowserCommandStatus::UserRequired,
                    Some(reason_code),
                    Some(reason),
                )?;
                self.diagnostic_command_result(&input, &result, started.elapsed());
                return Ok(result);
            }
            match &input.action {
                BrowserAction::UserHandoff { reason } => {
                    session.control.state = BrowserControlState::UserRequired;
                    session.control.reason =
                        Some(required_text(reason.clone(), "Browser handoff reason")?);
                    session.control.active_command_id = None;
                    bump_revision(&mut state);
                    drop(state);
                    self.publish_snapshot(&input.browser_session_id);
                    let result = self.command_result(
                        &input,
                        BrowserCommandStatus::UserRequired,
                        Some("user_required"),
                        Some("Direct user interaction is required"),
                    )?;
                    self.diagnostic_command_result(&input, &result, started.elapsed());
                    return Ok(result);
                }
                BrowserAction::Resume => {
                    session.control.state = BrowserControlState::Idle;
                    session.control.reason = None;
                    session.control.control_epoch = session.control.control_epoch.saturating_add(1);
                    session.control.active_command_id = None;
                    bump_revision(&mut state);
                    drop(state);
                    self.publish_snapshot(&input.browser_session_id);
                    let result =
                        self.command_result(&input, BrowserCommandStatus::Completed, None, None)?;
                    self.diagnostic_command_result(&input, &result, started.elapsed());
                    return Ok(result);
                }
                _ => {}
            }
            session.control.state = BrowserControlState::AgentActive;
            session.control.active_command_id = Some(input.command_id.clone());
            session.control.reason = None;
            increment_counter(&mut state, "browser.command.dispatched");
            bump_revision(&mut state);
            self.active_cancellations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(input.tab_id.clone(), cancellation.clone());
            platform_action
        };
        self.publish_snapshot(&input.browser_session_id);
        self.diagnostic(
            "browser.command.dispatched",
            Some(input.browser_session_id.clone()),
            Some(input.tab_id.clone()),
            Some(input.command_id.clone()),
            None,
            None,
            diagnostic_details([
                ("controlEpoch", serde_json::Value::from(input.control_epoch)),
                (
                    "observationRevision",
                    serde_json::Value::from(input.observation_revision.unwrap_or_default()),
                ),
            ]),
        );

        let (status, reason_code, reason) = tokio::select! {
            _ = cancellation.notify.notified() => {
                let outcome = cancellation
                    .outcome
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
                    .unwrap_or(BrowserCancellationOutcome {
                        status: BrowserCommandStatus::Cancelled,
                        reason_code: "command_cancelled".to_string(),
                        reason: "Browser command was cancelled".to_string(),
                    });
                (outcome.status, Some(outcome.reason_code), Some(outcome.reason))
            },
            result = tokio::time::timeout(
                DEFAULT_AGENT_TIMEOUT,
                self.adapter.interact(&input.tab_id, platform_action),
            ) => match result {
                Ok(Ok(())) => (BrowserCommandStatus::Completed, None, None),
                Ok(Err(error)) => (
                    BrowserCommandStatus::Failed,
                    Some("platform_interaction_failed".to_string()),
                    Some(error),
                ),
                Err(_) => (
                    BrowserCommandStatus::TimedOut,
                    Some("interaction_timeout".to_string()),
                    Some("Browser interaction exceeded its deadline".to_string()),
                ),
            }
        };
        self.active_cancellations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&input.tab_id);
        let status = BrowserCommandStatus::Dispatched.transition_to(status)?;

        let final_status = {
            let mut state = self.lock_state();
            let session = state
                .sessions
                .get_mut(&input.browser_session_id)
                .ok_or_else(|| "Browser session closed during interaction".to_string())?;
            let interrupted = session.control.control_epoch != input.control_epoch
                || session.control.active_command_id.as_ref() != Some(&input.command_id);
            let final_status = if interrupted && status == BrowserCommandStatus::Completed {
                BrowserCommandStatus::Cancelled
            } else {
                status
            };
            session.control.active_command_id = None;
            let policy_pending = session.pending_policy_request.is_some();
            session.control.state = if policy_pending {
                BrowserControlState::UserRequired
            } else {
                match final_status {
                    BrowserCommandStatus::Completed => BrowserControlState::Idle,
                    BrowserCommandStatus::Cancelled => BrowserControlState::Interrupted,
                    BrowserCommandStatus::UserRequired => BrowserControlState::UserRequired,
                    _ => BrowserControlState::Failed,
                }
            };
            if !policy_pending {
                session.control.reason = reason.clone().or_else(|| {
                    interrupted.then(|| {
                        "Direct user input interrupted the Agent browser action".to_string()
                    })
                });
            }
            increment_counter(
                &mut state,
                match final_status {
                    BrowserCommandStatus::Completed => "browser.command.completed",
                    BrowserCommandStatus::Cancelled => "browser.command.cancelled",
                    BrowserCommandStatus::TimedOut => "browser.command.timed_out",
                    BrowserCommandStatus::UserRequired => "browser.command.user_required",
                    _ => "browser.command.failed",
                },
            );
            record_duration(&mut state, "browser.command", started.elapsed());
            bump_revision(&mut state);
            final_status
        };
        self.publish_snapshot(&input.browser_session_id);
        if final_status == BrowserCommandStatus::Completed {
            let _ = self
                .observe(BrowserObserveInput {
                    browser_session_id: input.browser_session_id.clone(),
                    tab_id: input.tab_id.clone(),
                    capture: true,
                    semantic: true,
                })
                .await;
        }
        let (code, message) =
            if final_status == BrowserCommandStatus::Cancelled && reason_code.is_none() {
                (
                    Some("user_interrupted"),
                    Some("Direct user input interrupted the Agent browser action"),
                )
            } else {
                (reason_code.as_deref(), reason.as_deref())
            };
        let result = self.command_result(&input, final_status, code, message)?;
        self.diagnostic_command_result(&input, &result, started.elapsed());
        Ok(result)
    }

    pub(crate) async fn resolve_policy_request(
        self: &Arc<Self>,
        input: BrowserResolvePolicyRequestInput,
    ) -> Result<BrowserNativeSnapshot, String> {
        let request = {
            let mut state = self.lock_state();
            ensure_accepting(&state)?;
            let session = ready_session_mut(&mut state, &input.browser_session_id)?;
            let request = session
                .pending_policy_request
                .as_ref()
                .filter(|request| request.snapshot.request_id == input.request_id)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "Browser policy request {} is stale or unavailable",
                        input.request_id
                    )
                })?;
            session.pending_policy_request = None;
            session.control.active_command_id = None;
            session.control.state = if input.approved {
                BrowserControlState::Recovering
            } else {
                BrowserControlState::Idle
            };
            session.control.reason = None;
            increment_counter(
                &mut state,
                if input.approved {
                    "browser.policy_request.approved"
                } else {
                    "browser.policy_request.denied"
                },
            );
            bump_revision(&mut state);
            request
        };
        self.publish_snapshot(&input.browser_session_id);

        if !input.approved {
            self.diagnostic(
                "browser.policy_request.denied",
                Some(input.browser_session_id.clone()),
                Some(request.snapshot.source_tab_id.clone()),
                None,
                Some("user_denied"),
                Some(&request.url),
                diagnostic_details([(
                    "requestId",
                    serde_json::Value::String(request.snapshot.request_id.to_string()),
                )]),
            );
            return self
                .snapshot(&input.browser_session_id)
                .ok_or_else(|| "Browser session disappeared after policy decision".to_string());
        }

        let operation = match request.snapshot.kind {
            BrowserPolicyRequestKind::Popup => match safe_browser_url(&request.url) {
                Ok(_) => self
                    .create_tab(BrowserCreateTabInput {
                        browser_session_id: input.browser_session_id.clone(),
                        url: Some(request.url.clone()),
                    })
                    .await
                    .map(|_| ()),
                Err(error) => Err(error),
            },
            BrowserPolicyRequestKind::ExternalProtocol => {
                match external_protocol_url(&request.url) {
                    Ok(_) => self.adapter.open_external(&request.url).await,
                    Err(error) => Err(error),
                }
            }
        };

        {
            let mut state = self.lock_state();
            let session = state
                .sessions
                .get_mut(&input.browser_session_id)
                .ok_or_else(|| "Browser session closed during policy decision".to_string())?;
            session.control.state = if operation.is_ok() {
                BrowserControlState::Idle
            } else {
                BrowserControlState::Failed
            };
            session.control.reason = operation.as_ref().err().cloned();
            increment_counter(
                &mut state,
                if operation.is_ok() {
                    "browser.policy_request.completed"
                } else {
                    "browser.policy_request.failed"
                },
            );
            bump_revision(&mut state);
        }
        self.diagnostic(
            if operation.is_ok() {
                "browser.policy_request.completed"
            } else {
                "browser.policy_request.failed"
            },
            Some(input.browser_session_id.clone()),
            Some(request.snapshot.source_tab_id),
            None,
            operation.as_ref().err().map(|_| "policy_operation_failed"),
            Some(&request.url),
            diagnostic_details([
                (
                    "requestId",
                    serde_json::Value::String(request.snapshot.request_id.to_string()),
                ),
                (
                    "kind",
                    serde_json::Value::String(
                        match request.snapshot.kind {
                            BrowserPolicyRequestKind::Popup => "popup",
                            BrowserPolicyRequestKind::ExternalProtocol => "external_protocol",
                        }
                        .to_string(),
                    ),
                ),
            ]),
        );
        self.publish_snapshot(&input.browser_session_id);
        operation?;
        self.snapshot(&input.browser_session_id)
            .ok_or_else(|| "Browser session disappeared after policy decision".to_string())
    }

    pub(crate) async fn delete_profile(
        &self,
        input: BrowserDeleteProfileInput,
    ) -> Result<(), String> {
        let profile_id = validated_profile_id(Some(&input.profile_id), "profile-delete")?;
        let profile = BrowserPlatformProfile {
            data_directory: self.profile_root.join("profiles").join(profile_id.as_str()),
            profile_id: profile_id.clone(),
            persistence: BrowserProfilePersistence::Persistent,
        };
        {
            let mut state = self.lock_state();
            ensure_accepting(&state)?;
            if state
                .sessions
                .values()
                .any(|session| session.profile.profile_id == profile_id)
            {
                increment_counter(&mut state, "browser.profile.delete.rejected_in_use");
                return Err(format!(
                    "Cannot delete browser profile {profile_id} while a session owns it"
                ));
            }
            increment_counter(&mut state, "browser.profile.delete.started");
        }
        let result = self.adapter.delete_profile(&profile).await;
        {
            let mut state = self.lock_state();
            increment_counter(
                &mut state,
                if result.is_ok() {
                    "browser.profile.delete.completed"
                } else {
                    "browser.profile.delete.failed"
                },
            );
        }
        self.diagnostic(
            if result.is_ok() {
                "browser.profile.deleted"
            } else {
                "browser.profile.delete_failed"
            },
            None,
            None,
            None,
            result.as_ref().err().map(|_| "profile_delete_failed"),
            None,
            diagnostic_details([(
                "profileId",
                serde_json::Value::String(profile_id.to_string()),
            )]),
        );
        result
    }

    pub(crate) async fn close_session(&self, session_id: &BrowserSessionId) -> Result<(), String> {
        let started = Instant::now();
        let (tab_ids, profile, owner_session_id) = {
            let mut state = self.lock_state();
            let session = state
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "Browser session is unavailable".to_string())?;
            session.lifecycle = session
                .lifecycle
                .transition_to(BrowserSessionLifecycle::Closing)?;
            session.control.control_epoch = session.control.control_epoch.saturating_add(1);
            session.control.active_command_id = None;
            session.surface.lifecycle = BrowserSurfaceLifecycle::Hidden;
            let values = (
                session.tab_order.clone(),
                session.profile.clone(),
                session.owner_session_id.clone(),
            );
            increment_counter(&mut state, "browser.session.close.started");
            bump_revision(&mut state);
            values
        };
        self.publish_snapshot(session_id);
        let mut failures = Vec::new();
        for tab_id in &tab_ids {
            self.cancel_tab_command(
                tab_id,
                BrowserCommandStatus::Cancelled,
                "session_closing",
                "Browser session is closing",
            );
            if let Err(error) = self.adapter.close_tab(tab_id).await {
                failures.push(format!("{tab_id}: {error}"));
            }
            self.remove_command_lock(tab_id);
        }
        if profile.persistence == BrowserProfilePersistence::Incognito {
            if let Err(error) = self.adapter.delete_profile(&profile).await {
                failures.push(format!("profile {}: {error}", profile.profile_id));
            }
        }
        let mut state = self.lock_state();
        state.sessions.remove(session_id);
        state.owner_sessions.remove(&owner_session_id);
        if failures.is_empty() {
            increment_counter(&mut state, "browser.session.close.completed");
        } else {
            increment_counter(&mut state, "browser.session.close.failed");
        }
        record_duration(&mut state, "browser.session.close", started.elapsed());
        bump_revision(&mut state);
        drop(state);
        if failures.is_empty() {
            self.diagnostic(
                "browser.session.closed",
                Some(session_id.clone()),
                None,
                None,
                None,
                None,
                diagnostic_details([(
                    "profileId",
                    serde_json::Value::String(profile.profile_id.to_string()),
                )]),
            );
            Ok(())
        } else {
            self.diagnostic(
                "browser.session.cleanup_failed",
                Some(session_id.clone()),
                None,
                None,
                Some("incomplete_cleanup"),
                None,
                diagnostic_details([(
                    "failureCount",
                    serde_json::Value::from(failures.len() as u64),
                )]),
            );
            Err(format!(
                "Browser cleanup incomplete: {}",
                failures.join("; ")
            ))
        }
    }

    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        let session_ids = {
            let mut state = self.lock_state();
            state.accepting_commands = false;
            state.sessions.keys().cloned().collect::<Vec<_>>()
        };
        let mut failures = Vec::new();
        for session_id in session_ids {
            if let Err(error) = self.close_session(&session_id).await {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn require_ready_tab(
        &self,
        session_id: &BrowserSessionId,
        tab_id: &BrowserTabId,
    ) -> Result<(), String> {
        let state = self.lock_state();
        let session = ready_session(&state, session_id)?;
        require_tab(session, tab_id)?;
        Ok(())
    }

    fn insert_command_lock(&self, tab_id: BrowserTabId) {
        self.command_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(tab_id, Arc::new(tokio::sync::Mutex::new(())));
    }

    fn remove_command_lock(&self, tab_id: &BrowserTabId) {
        self.command_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(tab_id);
    }

    fn cancel_tab_command(
        &self,
        tab_id: &BrowserTabId,
        status: BrowserCommandStatus,
        reason_code: &str,
        reason: &str,
    ) {
        if let Some(cancellation) = self
            .active_cancellations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(tab_id)
            .cloned()
        {
            let mut outcome = cancellation
                .outcome
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if outcome.is_none() {
                *outcome = Some(BrowserCancellationOutcome {
                    status,
                    reason_code: reason_code.to_string(),
                    reason: reason.to_string(),
                });
                cancellation.notify.notify_one();
            }
        }
    }

    fn command_lock(&self, tab_id: &BrowserTabId) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        self.command_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(tab_id)
            .cloned()
            .ok_or_else(|| format!("Browser tab `{tab_id}` has no command serializer"))
    }

    fn command_result(
        &self,
        input: &BrowserInteractionInput,
        status: BrowserCommandStatus,
        reason_code: Option<&str>,
        reason: Option<&str>,
    ) -> Result<BrowserCommandResult, String> {
        let state = self.lock_state();
        let session = state
            .sessions
            .get(&input.browser_session_id)
            .ok_or_else(|| "Browser session is unavailable".to_string())?;
        let tab = require_tab(session, &input.tab_id)?;
        Ok(BrowserCommandResult {
            command_id: input.command_id.clone(),
            status,
            browser_session_id: input.browser_session_id.clone(),
            tab_id: input.tab_id.clone(),
            control_epoch: session.control.control_epoch,
            observation_revision: tab.observation_revision,
            navigation_id: Some(tab.navigation_id.clone()),
            reason_code: reason_code.map(str::to_string),
            reason: reason.map(str::to_string),
        })
    }

    fn diagnostic_command_result(
        &self,
        input: &BrowserInteractionInput,
        result: &BrowserCommandResult,
        duration: Duration,
    ) {
        let event = match result.status {
            BrowserCommandStatus::Completed => "browser.command.completed",
            BrowserCommandStatus::Failed => "browser.command.failed",
            BrowserCommandStatus::Cancelled => "browser.command.cancelled",
            BrowserCommandStatus::TimedOut => "browser.command.timed_out",
            BrowserCommandStatus::UserRequired => "browser.command.user_required",
            BrowserCommandStatus::Dispatched => "browser.command.dispatched",
        };
        self.diagnostic(
            event,
            Some(input.browser_session_id.clone()),
            Some(input.tab_id.clone()),
            Some(input.command_id.clone()),
            result.reason_code.as_deref(),
            None,
            diagnostic_details([
                (
                    "controlEpoch",
                    serde_json::Value::from(result.control_epoch),
                ),
                (
                    "observationRevision",
                    serde_json::Value::from(result.observation_revision),
                ),
                (
                    "durationMs",
                    serde_json::Value::from(duration.as_millis().min(u64::MAX as u128) as u64),
                ),
            ]),
        );
    }

    fn handle_platform_event(self: &Arc<Self>, event: BrowserPlatformEvent) {
        let (session_id, recapture_tab_id) = {
            let mut state = self.lock_state();
            let Some(session_id) = find_session_for_tab(&state, event_tab_id(&event)) else {
                return;
            };
            let mut recapture_tab_id = None;
            match event {
                BrowserPlatformEvent::NavigationStarted { tab_id, url } => {
                    self.diagnostic(
                        "browser.navigation.started",
                        Some(session_id.clone()),
                        Some(tab_id.clone()),
                        None,
                        None,
                        Some(&url),
                        BTreeMap::new(),
                    );
                    let next_navigation =
                        BrowserNavigationId(next_id(&mut state, "browser-navigation"));
                    if let Some(tab) = state
                        .sessions
                        .get_mut(&session_id)
                        .and_then(|session| session.tabs.get_mut(&tab_id))
                    {
                        tab.lifecycle = BrowserTabLifecycle::Loading;
                        tab.loading = true;
                        tab.url = url;
                        tab.navigation_sequence = tab.navigation_sequence.saturating_add(1);
                        tab.navigation_started_at = Some(Instant::now());
                        tab.navigation_id = next_navigation;
                        tab.semantic = None;
                        tab.semantic_targets.clear();
                        for capture in &mut tab.captures {
                            capture.stale = true;
                        }
                    }
                    increment_counter(&mut state, "browser.navigation.started");
                }
                BrowserPlatformEvent::NavigationFinished {
                    tab_id,
                    url,
                    can_go_back,
                    can_go_forward,
                } => {
                    self.diagnostic(
                        "browser.navigation.completed",
                        Some(session_id.clone()),
                        Some(tab_id.clone()),
                        None,
                        None,
                        Some(&url),
                        BTreeMap::new(),
                    );
                    let navigation_duration = if let Some(tab) = state
                        .sessions
                        .get_mut(&session_id)
                        .and_then(|session| session.tabs.get_mut(&tab_id))
                    {
                        tab.lifecycle = BrowserTabLifecycle::Ready;
                        tab.loading = false;
                        tab.url = url.clone();
                        tab.can_go_back = can_go_back;
                        tab.can_go_forward = can_go_forward;
                        let observed_at = now_timestamp();
                        if tab
                            .history
                            .get(tab.active_history_index)
                            .map(|entry| entry.url.as_str())
                            != Some(url.as_str())
                        {
                            tab.history
                                .truncate(tab.active_history_index.saturating_add(1));
                            tab.history.push(BrowserNavigationEntry {
                                url,
                                title: tab.title.clone(),
                                observed_at,
                                navigation_id: tab.navigation_id.clone(),
                                capture_id: None,
                            });
                            tab.active_history_index = tab.history.len().saturating_sub(1);
                        }
                        recapture_tab_id = Some(tab_id.clone());
                        tab.navigation_started_at
                            .take()
                            .map(|started| started.elapsed())
                    } else {
                        None
                    };
                    increment_counter(&mut state, "browser.navigation.completed");
                    if let Some(duration) = navigation_duration {
                        record_duration(&mut state, "browser.navigation", duration);
                    }
                }
                BrowserPlatformEvent::TitleChanged { tab_id, title } => {
                    if let Some(tab) = state
                        .sessions
                        .get_mut(&session_id)
                        .and_then(|session| session.tabs.get_mut(&tab_id))
                    {
                        tab.title = title.clone();
                        if let Some(history) = tab.history.get_mut(tab.active_history_index) {
                            history.title = title;
                        }
                    }
                }
                BrowserPlatformEvent::UserInput { tab_id } => {
                    self.diagnostic(
                        "browser.user_input.interrupted",
                        Some(session_id.clone()),
                        Some(tab_id.clone()),
                        None,
                        Some("user_interrupted"),
                        None,
                        BTreeMap::new(),
                    );
                    self.cancel_tab_command(
                        &tab_id,
                        BrowserCommandStatus::Cancelled,
                        "user_interrupted",
                        "Direct user input interrupted the Agent browser action",
                    );
                    if let Some(session) = state.sessions.get_mut(&session_id) {
                        session.control.control_epoch =
                            session.control.control_epoch.saturating_add(1);
                        session.control.active_command_id = None;
                        if session.pending_policy_request.is_none() {
                            session.control.state = BrowserControlState::Interrupted;
                            session.control.reason = Some(
                                "Direct user input invalidated pending Agent browser work"
                                    .to_string(),
                            );
                        }
                    }
                    increment_counter(&mut state, "browser.user_input.interrupted");
                }
                BrowserPlatformEvent::PopupRequested { tab_id, url } => {
                    self.diagnostic(
                        "browser.popup.confirmation_requested",
                        Some(session_id.clone()),
                        Some(tab_id.clone()),
                        None,
                        Some("user_confirmation_required"),
                        Some(&url),
                        BTreeMap::new(),
                    );
                    self.cancel_tab_command(
                        &tab_id,
                        BrowserCommandStatus::UserRequired,
                        "user_required",
                        "A popup requires explicit user confirmation",
                    );
                    let request_id =
                        BrowserPolicyRequestId(next_id(&mut state, "browser-policy-request"));
                    if let Some(session) = state.sessions.get_mut(&session_id) {
                        session.control.control_epoch =
                            session.control.control_epoch.saturating_add(1);
                        session.control.active_command_id = None;
                        session.control.state = BrowserControlState::UserRequired;
                        session.control.reason = Some(format!(
                            "Popup from tab {tab_id} requires explicit user confirmation: {}",
                            redact_browser_url(&url).unwrap_or_else(|| "invalid URL".to_string())
                        ));
                        session.pending_policy_request = Some(BrowserPendingPolicyRequest {
                            snapshot: BrowserPolicyRequestSnapshot {
                                request_id,
                                kind: BrowserPolicyRequestKind::Popup,
                                source_tab_id: tab_id,
                                safe_url: redact_browser_url(&url)
                                    .unwrap_or_else(|| "invalid URL".to_string()),
                            },
                            url,
                        });
                    }
                    increment_counter(&mut state, "browser.popup.blocked");
                }
                BrowserPlatformEvent::ExternalProtocolRequested { tab_id, url } => {
                    self.diagnostic(
                        "browser.external_protocol.confirmation_requested",
                        Some(session_id.clone()),
                        Some(tab_id.clone()),
                        None,
                        Some("user_confirmation_required"),
                        Some(&url),
                        BTreeMap::new(),
                    );
                    self.cancel_tab_command(
                        &tab_id,
                        BrowserCommandStatus::UserRequired,
                        "user_required",
                        "An external protocol requires explicit user confirmation",
                    );
                    let request_id =
                        BrowserPolicyRequestId(next_id(&mut state, "browser-policy-request"));
                    if let Some(session) = state.sessions.get_mut(&session_id) {
                        session.control.control_epoch =
                            session.control.control_epoch.saturating_add(1);
                        session.control.active_command_id = None;
                        session.control.state = BrowserControlState::UserRequired;
                        session.control.reason = Some(format!(
                            "External protocol from tab {tab_id} requires explicit user confirmation: {}",
                            redact_browser_url(&url).unwrap_or_else(|| "external protocol".to_string())
                        ));
                        session.pending_policy_request = Some(BrowserPendingPolicyRequest {
                            snapshot: BrowserPolicyRequestSnapshot {
                                request_id,
                                kind: BrowserPolicyRequestKind::ExternalProtocol,
                                source_tab_id: tab_id,
                                safe_url: redact_browser_url(&url)
                                    .unwrap_or_else(|| "external protocol".to_string()),
                            },
                            url,
                        });
                    }
                    increment_counter(
                        &mut state,
                        "browser.external_protocol.confirmation_requested",
                    );
                }
                BrowserPlatformEvent::DownloadBlocked { tab_id, url } => {
                    self.cancel_tab_command(
                        &tab_id,
                        BrowserCommandStatus::Failed,
                        "download_contract_unavailable",
                        "Browser downloads are unavailable",
                    );
                    increment_counter(&mut state, "browser.download.blocked");
                    self.diagnostic(
                        "browser.download.blocked",
                        Some(session_id.clone()),
                        Some(tab_id),
                        None,
                        Some("download_contract_unavailable"),
                        Some(&url),
                        BTreeMap::new(),
                    );
                }
                BrowserPlatformEvent::PolicyDenied {
                    tab_id,
                    url,
                    reason_code,
                } => {
                    self.cancel_tab_command(
                        &tab_id,
                        BrowserCommandStatus::Failed,
                        &reason_code,
                        "Browser navigation was denied by policy",
                    );
                    increment_counter(&mut state, "browser.navigation.denied");
                    self.diagnostic(
                        "browser.navigation.denied",
                        Some(session_id.clone()),
                        Some(tab_id),
                        None,
                        Some(&reason_code),
                        Some(&url),
                        BTreeMap::new(),
                    );
                }
                BrowserPlatformEvent::RendererCrashed { tab_id, reason } => {
                    self.cancel_tab_command(
                        &tab_id,
                        BrowserCommandStatus::Failed,
                        "renderer_process_failed",
                        &reason,
                    );
                    if let Some(session) = state.sessions.get_mut(&session_id) {
                        session.lifecycle = BrowserSessionLifecycle::Crashed;
                        session.control.state = BrowserControlState::Failed;
                        session.control.reason = Some(reason.clone());
                        if let Some(tab) = session.tabs.get_mut(&tab_id) {
                            tab.lifecycle = BrowserTabLifecycle::Crashed;
                            tab.renderer_lifecycle = BrowserRendererLifecycle::Failed;
                            tab.loading = false;
                        }
                    }
                    increment_counter(&mut state, "browser.renderer.crashed");
                    self.diagnostic(
                        "browser.renderer.crashed",
                        Some(session_id.clone()),
                        Some(tab_id),
                        None,
                        Some("renderer_process_failed"),
                        None,
                        diagnostic_details([(
                            "message",
                            serde_json::Value::String(reason.clone()),
                        )]),
                    );
                }
            }
            bump_revision(&mut state);
            (session_id, recapture_tab_id)
        };
        self.publish_snapshot(&session_id);
        if let Some(tab_id) = recapture_tab_id {
            let manager = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = manager
                    .observe(BrowserObserveInput {
                        browser_session_id: session_id,
                        tab_id,
                        capture: true,
                        semantic: true,
                    })
                    .await;
            });
        }
    }

    fn publish_snapshot(&self, session_id: &BrowserSessionId) {
        if let Some(snapshot) = self.snapshot(session_id) {
            (self.snapshot_sink)(snapshot);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn diagnostic(
        &self,
        event: &str,
        browser_session_id: Option<BrowserSessionId>,
        tab_id: Option<BrowserTabId>,
        command_id: Option<BrowserCommandId>,
        reason_code: Option<&str>,
        url: Option<&str>,
        details: BTreeMap<String, serde_json::Value>,
    ) {
        (self.diagnostic_sink)(BrowserRuntimeDiagnostic {
            schema_version: "tinybot.browser_runtime_diagnostic.v1",
            event: event.to_string(),
            observed_at: now_timestamp(),
            browser_session_id,
            tab_id,
            command_id,
            reason_code: reason_code.map(str::to_string),
            safe_url: url.and_then(redact_browser_url),
            details,
        });
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, BrowserRuntimeState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn snapshot_from_state(
    state: &BrowserRuntimeState,
    session_id: &BrowserSessionId,
    adapter: &dyn BrowserRuntimeAdapter,
) -> Option<BrowserNativeSnapshot> {
    let session = state.sessions.get(session_id)?;
    let observed_at = now_timestamp();
    let tabs = session
        .tab_order
        .iter()
        .filter_map(|tab_id| session.tabs.get(tab_id))
        .map(tab_snapshot)
        .collect::<Vec<_>>();
    if tabs.is_empty() {
        return None;
    }
    let capabilities = adapter.capabilities();
    let ready = session.lifecycle == BrowserSessionLifecycle::Ready;
    let interaction = ready && capabilities.agent_interaction.available;
    let source_id = format!("native-browser:{}", session.id);
    Some(BrowserNativeSnapshot {
        schema_version: "tinybot.tinyos_native_snapshot.v1",
        source_id: source_id.clone(),
        revision: state.revision,
        observed_at: observed_at.clone(),
        provenance: BrowserSnapshotProvenance {
            kind: "native_query",
            source_id,
            revision: state.revision,
            observed_at,
        },
        data: BrowserSessionSnapshot {
            kind: "browser_session",
            contract: "browser_session_v1",
            browser_session_id: session.id.clone(),
            session_id: session.owner_session_id.clone(),
            run_id: session.run_id.clone(),
            state: process_state(session.lifecycle),
            runtime_kind: adapter.runtime_kind().to_string(),
            runtime_version: adapter.runtime_version().to_string(),
            lifecycle: session.lifecycle,
            profile_id: session.profile.profile_id.clone(),
            profile_persistence: session.profile.persistence,
            active_tab_id: session.active_tab_id.clone(),
            tabs,
            interaction: BrowserInteractionAvailability {
                navigate: interaction,
                click: interaction,
                type_text: interaction,
                key: interaction,
                scroll: interaction,
                semantic: ready && capabilities.semantic_observation.available,
                wait: interaction,
            },
            control: session.control.clone(),
            surface: session.surface.clone(),
            pending_policy_request: session
                .pending_policy_request
                .as_ref()
                .map(|request| request.snapshot.clone()),
        },
    })
}

fn tab_snapshot(tab: &BrowserTabRecord) -> BrowserTabSnapshot {
    BrowserTabSnapshot {
        tab_id: tab.id.clone(),
        lifecycle: tab.lifecycle,
        renderer_lifecycle: tab.renderer_lifecycle,
        url: tab.url.clone(),
        title: tab.title.clone(),
        loading: tab.loading,
        can_go_back: tab.can_go_back,
        can_go_forward: tab.can_go_forward,
        active_history_index: tab.active_history_index,
        history: tab.history.clone(),
        captures: tab.captures.iter().cloned().collect(),
        current_capture_id: tab
            .captures
            .back()
            .map(|capture| capture.capture_id.clone()),
        navigation_id: tab.navigation_id.clone(),
        observation_revision: tab.observation_revision,
        semantic_observation: tab.semantic.clone(),
    }
}

fn process_state(lifecycle: BrowserSessionLifecycle) -> &'static str {
    match lifecycle {
        BrowserSessionLifecycle::Creating | BrowserSessionLifecycle::Ready => "running",
        BrowserSessionLifecycle::Closing => "cancelling",
        BrowserSessionLifecycle::Closed => "completed",
        BrowserSessionLifecycle::Failed | BrowserSessionLifecycle::Crashed => "failed",
    }
}

fn new_tab_record(
    tab_id: BrowserTabId,
    navigation_id: BrowserNavigationId,
    url: &str,
) -> BrowserTabRecord {
    BrowserTabRecord {
        id: tab_id,
        lifecycle: BrowserTabLifecycle::Creating,
        renderer_lifecycle: BrowserRendererLifecycle::Starting,
        url: url.to_string(),
        title: "New tab".to_string(),
        loading: true,
        can_go_back: false,
        can_go_forward: false,
        navigation_id: navigation_id.clone(),
        navigation_sequence: 1,
        navigation_started_at: None,
        observation_revision: 0,
        history: vec![BrowserNavigationEntry {
            url: url.to_string(),
            title: "New tab".to_string(),
            observed_at: now_timestamp(),
            navigation_id,
            capture_id: None,
        }],
        active_history_index: 0,
        captures: VecDeque::new(),
        semantic: None,
        semantic_targets: HashMap::new(),
    }
}

fn complete_tab_creation(tab: &mut BrowserTabRecord) -> Result<(), String> {
    tab.lifecycle = match tab.lifecycle {
        BrowserTabLifecycle::Creating | BrowserTabLifecycle::Loading => {
            tab.lifecycle.transition_to(BrowserTabLifecycle::Ready)?
        }
        BrowserTabLifecycle::Ready => BrowserTabLifecycle::Ready,
        lifecycle => {
            return Err(format!(
                "Browser tab creation completed from invalid lifecycle {lifecycle:?}"
            ));
        }
    };
    tab.renderer_lifecycle = match tab.renderer_lifecycle {
        BrowserRendererLifecycle::Starting | BrowserRendererLifecycle::Restarting => tab
            .renderer_lifecycle
            .transition_to(BrowserRendererLifecycle::Running)?,
        BrowserRendererLifecycle::Running => BrowserRendererLifecycle::Running,
        lifecycle => {
            return Err(format!(
                "Browser renderer creation completed from invalid lifecycle {lifecycle:?}"
            ));
        }
    };
    Ok(())
}

fn ready_session<'a>(
    state: &'a BrowserRuntimeState,
    session_id: &BrowserSessionId,
) -> Result<&'a BrowserSessionRecord, String> {
    let session = state
        .sessions
        .get(session_id)
        .ok_or_else(|| "Browser session is unavailable".to_string())?;
    if session.lifecycle != BrowserSessionLifecycle::Ready {
        return Err(format!(
            "Browser session is not ready: {:?}",
            session.lifecycle
        ));
    }
    Ok(session)
}

fn ready_session_mut<'a>(
    state: &'a mut BrowserRuntimeState,
    session_id: &BrowserSessionId,
) -> Result<&'a mut BrowserSessionRecord, String> {
    let session = state
        .sessions
        .get_mut(session_id)
        .ok_or_else(|| "Browser session is unavailable".to_string())?;
    if session.lifecycle != BrowserSessionLifecycle::Ready {
        return Err(format!(
            "Browser session is not ready: {:?}",
            session.lifecycle
        ));
    }
    Ok(session)
}

fn require_tab<'a>(
    session: &'a BrowserSessionRecord,
    tab_id: &BrowserTabId,
) -> Result<&'a BrowserTabRecord, String> {
    session
        .tabs
        .get(tab_id)
        .ok_or_else(|| format!("Browser tab `{tab_id}` is unavailable"))
}

fn require_tab_mut<'a>(
    session: &'a mut BrowserSessionRecord,
    tab_id: &BrowserTabId,
) -> Result<&'a mut BrowserTabRecord, String> {
    session
        .tabs
        .get_mut(tab_id)
        .ok_or_else(|| format!("Browser tab `{tab_id}` is unavailable"))
}

fn next_id(state: &mut BrowserRuntimeState, prefix: &str) -> String {
    state.sequence = state.sequence.saturating_add(1);
    format!("{prefix}-{}", state.sequence)
}

fn bump_revision(state: &mut BrowserRuntimeState) {
    state.revision = state.revision.saturating_add(1);
}

fn increment_counter(state: &mut BrowserRuntimeState, name: &str) {
    let counter = state.metrics.counters.entry(name.to_string()).or_default();
    *counter = counter.saturating_add(1);
}

fn record_duration(state: &mut BrowserRuntimeState, name: &str, duration: Duration) {
    state.metrics.durations_ms.insert(
        name.to_string(),
        duration.as_millis().min(u64::MAX as u128) as u64,
    );
}

fn ensure_accepting(state: &BrowserRuntimeState) -> Result<(), String> {
    if state.accepting_commands {
        Ok(())
    } else {
        Err("Browser runtime is shutting down".to_string())
    }
}

fn find_session_for_tab(
    state: &BrowserRuntimeState,
    tab_id: &BrowserTabId,
) -> Option<BrowserSessionId> {
    state.sessions.iter().find_map(|(session_id, session)| {
        session
            .tabs
            .contains_key(tab_id)
            .then(|| session_id.clone())
    })
}

fn event_tab_id(event: &BrowserPlatformEvent) -> &BrowserTabId {
    match event {
        BrowserPlatformEvent::NavigationStarted { tab_id, .. }
        | BrowserPlatformEvent::NavigationFinished { tab_id, .. }
        | BrowserPlatformEvent::TitleChanged { tab_id, .. }
        | BrowserPlatformEvent::UserInput { tab_id }
        | BrowserPlatformEvent::PopupRequested { tab_id, .. }
        | BrowserPlatformEvent::ExternalProtocolRequested { tab_id, .. }
        | BrowserPlatformEvent::DownloadBlocked { tab_id, .. }
        | BrowserPlatformEvent::PolicyDenied { tab_id, .. }
        | BrowserPlatformEvent::RendererCrashed { tab_id, .. } => tab_id,
    }
}

fn profile_directory(
    root: &Path,
    profile_id: &BrowserProfileId,
    persistence: BrowserProfilePersistence,
    session_id: &BrowserSessionId,
) -> PathBuf {
    match persistence {
        BrowserProfilePersistence::Persistent => root.join("profiles").join(profile_id.as_str()),
        BrowserProfilePersistence::Incognito => root
            .join("ephemeral")
            .join(format!("{}-{}", profile_id, session_id)),
    }
}

fn validated_profile_id(
    requested: Option<&str>,
    owner_session_id: &str,
) -> Result<BrowserProfileId, String> {
    let candidate = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("workspace-{}", stable_short_hash(owner_session_id)));
    if !candidate
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Browser profile id may contain only letters, digits, '-' and '_'".to_string());
    }
    BrowserProfileId::new(candidate)
}

fn stable_short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn required_text(value: impl Into<String>, label: &str) -> Result<String, String> {
    let value = value.into();
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(value.to_string())
    }
}

fn protected_operation_reason(reason_code: &str) -> String {
    match reason_code {
        "native_file_picker" => {
            "A native file picker requires direct user selection before Agent work can resume"
                .to_string()
        }
        "captcha" => {
            "CAPTCHA requires direct user completion before Agent work can resume".to_string()
        }
        _ => "This protected browser operation requires direct user completion".to_string(),
    }
}

fn hidden_surface_reason(input: &BrowserSurfaceUpdate) -> String {
    if !input.live {
        "history_mode".to_string()
    } else if !input.visible {
        "browser_window_hidden".to_string()
    } else if !input.topmost {
        "browser_window_not_topmost".to_string()
    } else if !input.unobscured {
        "browser_surface_obscured".to_string()
    } else {
        "browser_surface_hidden".to_string()
    }
}

pub(crate) fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::super::model::{BrowserSurfaceId, BrowserSurfaceRect};
    use super::super::platform::{
        available_windows_capabilities, BrowserPlatformEventSink, BrowserPlatformObservation,
        BrowserPlatformSemanticNode, BrowserPlatformTabState,
    };
    use super::*;
    use async_trait::async_trait;
    use std::sync::RwLock;

    #[derive(Default)]
    struct FakeAdapter {
        sink: RwLock<Option<BrowserPlatformEventSink>>,
        closed: Mutex<Vec<BrowserTabId>>,
        created: Mutex<Vec<BrowserTabId>>,
        surfaces: Mutex<Vec<BrowserPlatformSurface>>,
        created_profile_paths: Mutex<Vec<PathBuf>>,
        deleted_profiles: Mutex<Vec<BrowserProfileId>>,
        interactions: Mutex<Vec<BrowserPlatformAction>>,
        opened_external: Mutex<Vec<String>>,
        interaction_delay_ms: std::sync::atomic::AtomicU64,
        protected_semantic: std::sync::atomic::AtomicBool,
        fail_create: std::sync::atomic::AtomicBool,
    }

    #[async_trait]
    impl BrowserRuntimeAdapter for FakeAdapter {
        fn runtime_kind(&self) -> &'static str {
            "fake_webview"
        }
        fn runtime_version(&self) -> &'static str {
            "test"
        }
        fn capabilities(&self) -> BrowserRuntimeCapabilities {
            available_windows_capabilities()
        }
        fn bind_event_sink(&self, sink: BrowserPlatformEventSink) {
            *self.sink.write().unwrap() = Some(sink);
        }
        async fn create_tab(
            &self,
            request: BrowserPlatformCreateTab,
        ) -> Result<BrowserPlatformTabState, String> {
            if self.fail_create.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("fixture WebView initialization failed".to_string());
            }
            self.created.lock().unwrap().push(request.tab_id.clone());
            self.created_profile_paths
                .lock()
                .unwrap()
                .push(request.profile.data_directory.clone());
            Ok(BrowserPlatformTabState {
                url: request.url,
                title: "Fixture".to_string(),
                can_go_back: false,
                can_go_forward: false,
                viewport_width: 800,
                viewport_height: 600,
                device_scale: 1.0,
            })
        }
        async fn close_tab(&self, tab_id: &BrowserTabId) -> Result<(), String> {
            self.closed.lock().unwrap().push(tab_id.clone());
            Ok(())
        }
        async fn set_surface(&self, surface: BrowserPlatformSurface) -> Result<(), String> {
            if self.closed.lock().unwrap().contains(&surface.tab_id) {
                return Err("Cannot update the surface for a closed browser tab".to_string());
            }
            self.surfaces.lock().unwrap().push(surface);
            Ok(())
        }
        async fn navigate(&self, tab_id: &BrowserTabId, url: &str) -> Result<(), String> {
            if let Some(sink) = self.sink.read().unwrap().as_ref() {
                sink(BrowserPlatformEvent::NavigationStarted {
                    tab_id: tab_id.clone(),
                    url: url.to_string(),
                });
                sink(BrowserPlatformEvent::NavigationFinished {
                    tab_id: tab_id.clone(),
                    url: url.to_string(),
                    can_go_back: true,
                    can_go_forward: false,
                });
            }
            Ok(())
        }
        async fn back(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
            Ok(())
        }
        async fn forward(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
            Ok(())
        }
        async fn reload(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
            Ok(())
        }
        async fn stop(&self, _tab_id: &BrowserTabId) -> Result<(), String> {
            Ok(())
        }
        async fn observe(
            &self,
            _tab_id: &BrowserTabId,
            capture: bool,
            semantic: bool,
        ) -> Result<BrowserPlatformObservation, String> {
            Ok(BrowserPlatformObservation {
                capture_base64: capture.then(|| "cG5n".to_string()),
                viewport_width: 800,
                viewport_height: 600,
                device_scale: 1.0,
                semantic_nodes: if semantic {
                    vec![BrowserPlatformSemanticNode {
                        selector: "#submit".to_string(),
                        role: "button".to_string(),
                        name: "Submit".to_string(),
                        frame: "top".to_string(),
                        x: 10.0,
                        y: 20.0,
                        width: 80.0,
                        height: 30.0,
                        disabled: false,
                        focused: false,
                        sensitive: false,
                        protected_reason: self
                            .protected_semantic
                            .load(std::sync::atomic::Ordering::Relaxed)
                            .then(|| "native_file_picker".to_string()),
                    }]
                } else {
                    vec![]
                },
                semantic_truncated: false,
            })
        }
        async fn interact(
            &self,
            tab_id: &BrowserTabId,
            action: BrowserPlatformAction,
        ) -> Result<(), String> {
            if let BrowserPlatformAction::Browser(BrowserAction::Navigate { url }) = &action {
                if let Some(sink) = self.sink.read().unwrap().as_ref() {
                    sink(BrowserPlatformEvent::NavigationStarted {
                        tab_id: tab_id.clone(),
                        url: url.clone(),
                    });
                    sink(BrowserPlatformEvent::NavigationFinished {
                        tab_id: tab_id.clone(),
                        url: url.clone(),
                        can_go_back: true,
                        can_go_forward: false,
                    });
                }
            }
            self.interactions.lock().unwrap().push(action);
            let delay_ms = self
                .interaction_delay_ms
                .load(std::sync::atomic::Ordering::Relaxed);
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            Ok(())
        }
        async fn open_external(&self, url: &str) -> Result<(), String> {
            self.opened_external.lock().unwrap().push(url.to_string());
            Ok(())
        }
        async fn delete_profile(&self, profile: &BrowserPlatformProfile) -> Result<(), String> {
            self.deleted_profiles
                .lock()
                .unwrap()
                .push(profile.profile_id.clone());
            Ok(())
        }
    }

    fn manager(adapter: Arc<FakeAdapter>) -> SharedBrowserRuntime {
        BrowserSessionManager::new(
            adapter,
            std::env::temp_dir().join("tinybot-browser-tests"),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        )
    }

    fn manager_with_diagnostics(
        adapter: Arc<FakeAdapter>,
        diagnostics: Arc<Mutex<Vec<BrowserRuntimeDiagnostic>>>,
    ) -> SharedBrowserRuntime {
        BrowserSessionManager::new(
            adapter,
            std::env::temp_dir().join("tinybot-browser-tests"),
            Arc::new(|_| {}),
            Arc::new(move |diagnostic| diagnostics.lock().unwrap().push(diagnostic)),
        )
    }

    #[test]
    fn creation_completion_accepts_a_navigation_event_that_already_made_the_tab_ready() {
        let mut tab = new_tab_record(
            BrowserTabId("tab-race".to_string()),
            BrowserNavigationId("navigation-race".to_string()),
            "http://127.0.0.1/",
        );
        tab.lifecycle = BrowserTabLifecycle::Ready;

        complete_tab_creation(&mut tab).unwrap();

        assert_eq!(tab.lifecycle, BrowserTabLifecycle::Ready);
        assert_eq!(tab.renderer_lifecycle, BrowserRendererLifecycle::Running);
    }

    #[tokio::test]
    async fn session_lifecycle_and_observation_are_revisioned() {
        let manager = manager(Arc::new(FakeAdapter::default()));
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-1".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: Some("https://example.com".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(snapshot.data.lifecycle, BrowserSessionLifecycle::Ready);
        let tab_id = snapshot.data.active_tab_id.clone();
        let observed = manager
            .observe(BrowserObserveInput {
                browser_session_id: snapshot.data.browser_session_id.clone(),
                tab_id,
                capture: true,
                semantic: true,
            })
            .await
            .unwrap();
        assert!(observed
            .capture
            .unwrap()
            .data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(observed.semantic.unwrap().nodes[0].name, "Submit");
    }

    #[tokio::test]
    async fn agent_browser_tools_reuse_the_chat_owned_session() {
        let manager = manager(Arc::new(FakeAdapter::default()));
        let observed = crate::agent::bridge::dispatch_agent_browser_observe(
            &manager,
            "chat-shared-browser",
            serde_json::json!({}),
        )
        .await
        .unwrap();
        let snapshot = &observed["snapshot"]["data"];
        let browser_session_id = snapshot["browserSessionId"].as_str().unwrap();
        let tab_id = snapshot["activeTabId"].as_str().unwrap();
        let control_epoch = snapshot["control"]["controlEpoch"].as_u64().unwrap();
        let observation_revision = snapshot["tabs"][0]["observationRevision"].as_u64().unwrap();

        let result = crate::agent::bridge::dispatch_agent_browser_interact(
            &manager,
            "chat-shared-browser",
            None,
            serde_json::json!({
                "browserSessionId": browser_session_id,
                "tabId": tab_id,
                "commandId": "agent-browser-command",
                "controlEpoch": control_epoch,
                "observationRevision": observation_revision,
                "action": { "type": "scroll", "deltaX": 0, "deltaY": 120 }
            }),
        )
        .await
        .unwrap();

        assert_eq!(result["status"], "completed");
        assert_eq!(
            manager
                .snapshot_for_owner("chat-shared-browser")
                .unwrap()
                .data
                .browser_session_id
                .as_str(),
            browser_session_id
        );
        let ownership_error = crate::agent::bridge::dispatch_agent_browser_observe(
            &manager,
            "other-chat",
            serde_json::json!({ "browserSessionId": browser_session_id }),
        )
        .await
        .expect_err("another chat must not attach to the shared browser session");
        assert!(ownership_error.contains("not owned by this chat"));
    }

    #[tokio::test]
    async fn diagnostics_correlate_commands_and_redact_navigation_urls() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let manager =
            manager_with_diagnostics(Arc::new(FakeAdapter::default()), diagnostics.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-diagnostics".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let command_id = BrowserCommandId::new("diagnostic-command").unwrap();
        manager
            .interact(BrowserInteractionInput {
                browser_session_id: snapshot.data.browser_session_id,
                tab_id: snapshot.data.active_tab_id,
                command_id: command_id.clone(),
                control_epoch: snapshot.data.control.control_epoch,
                capture_id: None,
                observation_revision: None,
                action: BrowserAction::Navigate {
                    url: "https://user:pass@example.com/path?token=secret#fragment".to_string(),
                },
            })
            .await
            .unwrap();
        let diagnostics = diagnostics.lock().unwrap();
        let completed = diagnostics
            .iter()
            .find(|diagnostic| {
                diagnostic.event == "browser.command.completed"
                    && diagnostic.command_id.as_ref() == Some(&command_id)
            })
            .expect("terminal command diagnostic should be emitted");
        assert!(completed.details.contains_key("controlEpoch"));
        assert!(completed.details.contains_key("observationRevision"));
        assert!(completed.details.contains_key("durationMs"));
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.event == "browser.navigation.completed"
                && diagnostic.safe_url.as_deref() == Some("https://example.com/path")
        }));
    }

    #[test]
    fn unavailable_capability_queries_are_counted() {
        let manager = manager(Arc::new(FakeAdapter::default()));
        let capabilities = manager.capabilities();
        assert!(!capabilities.downloads.available);
        assert!(!capabilities.uploads.available);
        let metrics = manager.metrics();
        assert_eq!(
            metrics
                .counters
                .get("browser.capability.unavailable.downloads"),
            Some(&1)
        );
        assert_eq!(
            metrics
                .counters
                .get("browser.capability.unavailable.uploads"),
            Some(&1)
        );
    }

    #[tokio::test]
    async fn failed_session_snapshot_never_advertises_interaction() {
        let adapter = Arc::new(FakeAdapter::default());
        adapter
            .fail_create
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let manager = manager(adapter);
        assert!(manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-create-failure".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap_err()
            .contains("fixture WebView initialization failed"));
        let snapshot = manager
            .snapshot_for_owner("thread-create-failure")
            .expect("failed session should remain observable");
        assert_eq!(snapshot.data.lifecycle, BrowserSessionLifecycle::Failed);
        assert_eq!(snapshot.data.control.state, BrowserControlState::Failed);
        assert_eq!(
            snapshot.data.control.reason.as_deref(),
            Some("fixture WebView initialization failed")
        );
        assert!(!snapshot.data.interaction.navigate);
        assert!(!snapshot.data.interaction.click);
        assert!(!snapshot.data.interaction.semantic);
    }

    #[tokio::test]
    async fn stale_control_epoch_is_rejected_and_user_input_advances_epoch() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-2".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let tab_id = snapshot.data.active_tab_id.clone();
        adapter.sink.read().unwrap().as_ref().unwrap()(BrowserPlatformEvent::UserInput {
            tab_id: tab_id.clone(),
        });
        let result = manager
            .interact(BrowserInteractionInput {
                browser_session_id: snapshot.data.browser_session_id,
                tab_id,
                command_id: BrowserCommandId::new("command-1").unwrap(),
                control_epoch: 0,
                capture_id: None,
                observation_revision: None,
                action: BrowserAction::Navigate {
                    url: "https://example.com".to_string(),
                },
            })
            .await;
        assert!(result.unwrap_err().contains("stale"));
    }

    #[tokio::test]
    async fn incognito_session_closes_every_tab() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-3".to_string(),
                profile_id: Some("incognito-test".to_string()),
                persistence: BrowserProfilePersistence::Incognito,
                initial_url: None,
            })
            .await
            .unwrap();
        manager
            .close_session(&snapshot.data.browser_session_id)
            .await
            .unwrap();
        assert_eq!(adapter.closed.lock().unwrap().len(), 1);
        assert_eq!(adapter.deleted_profiles.lock().unwrap().len(), 1);
        assert!(manager.snapshot_for_owner("thread-3").is_none());
    }

    #[tokio::test]
    async fn incognito_sessions_with_the_same_profile_identity_use_separate_directories() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        for owner in ["thread-incognito-a", "thread-incognito-b"] {
            manager
                .create_session(BrowserCreateSessionInput {
                    owner_session_id: owner.to_string(),
                    profile_id: Some("shared-visible-identity".to_string()),
                    persistence: BrowserProfilePersistence::Incognito,
                    initial_url: None,
                })
                .await
                .unwrap();
        }
        let paths = adapter.created_profile_paths.lock().unwrap();
        assert_eq!(paths.len(), 2);
        assert_ne!(paths[0], paths[1]);
        assert!(paths
            .iter()
            .all(|path| path.to_string_lossy().contains("ephemeral")));
    }

    #[tokio::test]
    async fn persistent_profile_delete_is_rejected_while_in_use_and_allowed_after_close() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-profile-delete".to_string(),
                profile_id: Some("profile-delete-test".to_string()),
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let input = BrowserDeleteProfileInput {
            profile_id: "profile-delete-test".to_string(),
        };
        assert!(manager
            .delete_profile(input.clone())
            .await
            .unwrap_err()
            .contains("owns it"));
        manager
            .close_session(&snapshot.data.browser_session_id)
            .await
            .unwrap();
        manager.delete_profile(input).await.unwrap();
        assert_eq!(adapter.deleted_profiles.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn frontend_reattach_reuses_the_authoritative_session() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let input = BrowserCreateSessionInput {
            owner_session_id: "thread-reattach".to_string(),
            profile_id: None,
            persistence: BrowserProfilePersistence::Persistent,
            initial_url: Some("https://example.com/first".to_string()),
        };
        let first = manager.create_session(input.clone()).await.unwrap();
        let second = manager.create_session(input).await.unwrap();
        assert_eq!(
            first.data.browser_session_id,
            second.data.browser_session_id
        );
        assert_eq!(adapter.created.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn multi_tab_lifecycle_preserves_order_and_active_identity() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let first = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-tabs".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let first_tab = first.data.active_tab_id.clone();
        let second = manager
            .create_tab(BrowserCreateTabInput {
                browser_session_id: first.data.browser_session_id.clone(),
                url: Some("https://example.com/second".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(second.data.tabs.len(), 2);
        let second_tab = second.data.active_tab_id.clone();
        let activated = manager
            .activate_tab(&first.data.browser_session_id, &first_tab)
            .await
            .unwrap();
        assert_eq!(activated.data.active_tab_id, first_tab);
        let closed = manager
            .close_tab(&first.data.browser_session_id, &second_tab)
            .await
            .unwrap();
        assert_eq!(closed.data.tabs.len(), 1);
        assert_eq!(adapter.closed.lock().unwrap().as_slice(), &[second_tab]);
    }

    #[tokio::test]
    async fn closing_the_visible_tab_clears_its_surface_before_showing_the_replacement() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let first = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-visible-tab-close".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let first_tab = first.data.active_tab_id.clone();
        let second = manager
            .create_tab(BrowserCreateTabInput {
                browser_session_id: first.data.browser_session_id.clone(),
                url: Some("https://example.com/second".to_string()),
            })
            .await
            .unwrap();
        let second_tab = second.data.active_tab_id.clone();
        manager
            .update_surface(BrowserSurfaceUpdate {
                browser_session_id: first.data.browser_session_id.clone(),
                tab_id: second_tab.clone(),
                surface_id: BrowserSurfaceId::new("visible-tab-close-surface").unwrap(),
                layout_revision: 1,
                rect: BrowserSurfaceRect {
                    x: 0.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                    device_scale: 1.0,
                },
                visible: true,
                live: true,
                topmost: true,
                unobscured: true,
            })
            .await
            .unwrap();

        let closed = manager
            .close_tab(&first.data.browser_session_id, &second_tab)
            .await
            .unwrap();
        assert_eq!(closed.data.active_tab_id, first_tab);
        assert_eq!(closed.data.surface.tab_id, None);

        let updated = manager
            .update_surface(BrowserSurfaceUpdate {
                browser_session_id: first.data.browser_session_id.clone(),
                tab_id: first_tab.clone(),
                surface_id: BrowserSurfaceId::new("visible-tab-close-surface").unwrap(),
                layout_revision: 2,
                rect: BrowserSurfaceRect {
                    x: 0.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                    device_scale: 1.0,
                },
                visible: true,
                live: true,
                topmost: true,
                unobscured: true,
            })
            .await
            .unwrap();
        assert_eq!(updated.data.surface.tab_id.as_ref(), Some(&first_tab));
        assert_eq!(
            adapter
                .surfaces
                .lock()
                .unwrap()
                .last()
                .map(|surface| &surface.tab_id),
            Some(&first_tab)
        );
    }

    #[tokio::test]
    async fn capture_retention_is_bounded_and_revisions_are_monotonic() {
        let manager = manager(Arc::new(FakeAdapter::default()));
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-retention".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let initial_revision = snapshot.revision;
        for _ in 0..(CAPTURE_RETENTION + 5) {
            manager
                .observe(BrowserObserveInput {
                    browser_session_id: snapshot.data.browser_session_id.clone(),
                    tab_id: snapshot.data.active_tab_id.clone(),
                    capture: true,
                    semantic: true,
                })
                .await
                .unwrap();
        }
        let retained = manager.snapshot(&snapshot.data.browser_session_id).unwrap();
        assert!(retained.revision > initial_revision);
        assert_eq!(retained.data.tabs[0].captures.len(), CAPTURE_RETENTION);
        assert!(retained.data.tabs[0]
            .captures
            .iter()
            .take(CAPTURE_RETENTION - 1)
            .all(|capture| capture.stale));
        assert!(!retained.data.tabs[0].captures.last().unwrap().stale);
    }

    #[tokio::test]
    async fn coordinate_actions_require_current_capture_bounds() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-coordinates".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let observed = manager
            .observe(BrowserObserveInput {
                browser_session_id: snapshot.data.browser_session_id.clone(),
                tab_id: snapshot.data.active_tab_id.clone(),
                capture: true,
                semantic: false,
            })
            .await
            .unwrap();
        let tab = &observed.snapshot.data.tabs[0];
        let rejected = manager
            .interact(BrowserInteractionInput {
                browser_session_id: snapshot.data.browser_session_id.clone(),
                tab_id: tab.tab_id.clone(),
                command_id: BrowserCommandId::new("coordinate-outside").unwrap(),
                control_epoch: observed.snapshot.data.control.control_epoch,
                capture_id: tab.current_capture_id.clone(),
                observation_revision: Some(tab.observation_revision),
                action: BrowserAction::Click { x: 900.0, y: 10.0 },
            })
            .await
            .unwrap_err();
        assert!(rejected.contains("exceeds current viewport"));
        assert!(adapter.interactions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn semantic_action_is_normalized_and_post_action_observed() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-semantic".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let observed = manager
            .observe(BrowserObserveInput {
                browser_session_id: snapshot.data.browser_session_id.clone(),
                tab_id: snapshot.data.active_tab_id.clone(),
                capture: true,
                semantic: true,
            })
            .await
            .unwrap();
        let target_ref = observed.semantic.as_ref().unwrap().nodes[0]
            .target_ref
            .clone();
        let before_revision = observed.semantic.unwrap().observation_revision;
        let result = manager
            .interact(BrowserInteractionInput {
                browser_session_id: snapshot.data.browser_session_id,
                tab_id: snapshot.data.active_tab_id,
                command_id: BrowserCommandId::new("semantic-click").unwrap(),
                control_epoch: observed.snapshot.data.control.control_epoch,
                capture_id: observed.capture.map(|capture| capture.capture_id),
                observation_revision: Some(before_revision),
                action: BrowserAction::ClickTarget { target_ref },
            })
            .await
            .unwrap();
        assert_eq!(result.status, BrowserCommandStatus::Completed);
        assert!(result.observation_revision > before_revision);
        assert!(matches!(
            adapter.interactions.lock().unwrap().first(),
            Some(BrowserPlatformAction::ClickSelector { selector }) if selector == "#submit"
        ));
    }

    #[tokio::test]
    async fn direct_user_input_cancels_an_in_flight_agent_wait() {
        let adapter = Arc::new(FakeAdapter::default());
        adapter
            .interaction_delay_ms
            .store(5_000, std::sync::atomic::Ordering::Relaxed);
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-preemption".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let observed = manager
            .observe(BrowserObserveInput {
                browser_session_id: snapshot.data.browser_session_id.clone(),
                tab_id: snapshot.data.active_tab_id.clone(),
                capture: true,
                semantic: true,
            })
            .await
            .unwrap();
        let tab = &observed.snapshot.data.tabs[0];
        let input = BrowserInteractionInput {
            browser_session_id: snapshot.data.browser_session_id,
            tab_id: tab.tab_id.clone(),
            command_id: BrowserCommandId::new("preempted-wait").unwrap(),
            control_epoch: observed.snapshot.data.control.control_epoch,
            capture_id: tab.current_capture_id.clone(),
            observation_revision: Some(tab.observation_revision),
            action: BrowserAction::Wait {
                text: Some("never".to_string()),
                target_ref: None,
                timeout_ms: 10_000,
            },
        };
        let task = tokio::spawn({
            let manager = manager.clone();
            async move { manager.interact(input).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        adapter.sink.read().unwrap().as_ref().unwrap()(BrowserPlatformEvent::UserInput {
            tab_id: tab.tab_id.clone(),
        });
        let result = tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .expect("Agent wait should be cancelled immediately")
            .unwrap()
            .unwrap();
        assert_eq!(result.status, BrowserCommandStatus::Cancelled);
        assert_eq!(result.reason_code.as_deref(), Some("user_interrupted"));
    }

    #[tokio::test]
    async fn protected_semantic_target_requires_user_without_platform_dispatch() {
        let adapter = Arc::new(FakeAdapter::default());
        adapter
            .protected_semantic
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-file-picker".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let observed = manager
            .observe(BrowserObserveInput {
                browser_session_id: snapshot.data.browser_session_id.clone(),
                tab_id: snapshot.data.active_tab_id.clone(),
                capture: true,
                semantic: true,
            })
            .await
            .unwrap();
        let semantic = observed.semantic.as_ref().unwrap();
        let observation_revision = semantic.observation_revision;
        let node = &semantic.nodes[0];
        assert_eq!(node.protected_reason.as_deref(), Some("native_file_picker"));
        let result = manager
            .interact(BrowserInteractionInput {
                browser_session_id: snapshot.data.browser_session_id,
                tab_id: snapshot.data.active_tab_id,
                command_id: BrowserCommandId::new("file-picker-click").unwrap(),
                control_epoch: observed.snapshot.data.control.control_epoch,
                capture_id: observed.capture.map(|capture| capture.capture_id),
                observation_revision: Some(observation_revision),
                action: BrowserAction::ClickTarget {
                    target_ref: node.target_ref.clone(),
                },
            })
            .await
            .unwrap();
        assert_eq!(result.status, BrowserCommandStatus::UserRequired);
        assert_eq!(result.reason_code.as_deref(), Some("native_file_picker"));
        assert!(adapter.interactions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn renderer_crash_requires_and_completes_explicit_restart() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-crash".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let session_id = snapshot.data.browser_session_id;
        let tab_id = snapshot.data.active_tab_id;
        adapter.sink.read().unwrap().as_ref().unwrap()(BrowserPlatformEvent::RendererCrashed {
            tab_id: tab_id.clone(),
            reason: "fixture crash".to_string(),
        });
        let crashed = manager.snapshot(&session_id).unwrap();
        assert_eq!(crashed.data.lifecycle, BrowserSessionLifecycle::Crashed);
        assert_eq!(
            crashed.data.tabs[0].renderer_lifecycle,
            BrowserRendererLifecycle::Failed
        );
        let restarted = manager.restart_tab(&session_id, &tab_id).await.unwrap();
        assert_eq!(restarted.data.lifecycle, BrowserSessionLifecycle::Ready);
        assert_eq!(
            restarted.data.tabs[0].renderer_lifecycle,
            BrowserRendererLifecycle::Running
        );
        assert_eq!(adapter.created.lock().unwrap().len(), 2);
        assert_eq!(adapter.closed.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn shutdown_closes_sessions_and_rejects_new_work() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        for owner in ["thread-shutdown-a", "thread-shutdown-b"] {
            manager
                .create_session(BrowserCreateSessionInput {
                    owner_session_id: owner.to_string(),
                    profile_id: None,
                    persistence: BrowserProfilePersistence::Persistent,
                    initial_url: None,
                })
                .await
                .unwrap();
        }
        manager.shutdown().await.unwrap();
        assert_eq!(adapter.closed.lock().unwrap().len(), 2);
        let error = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-after-shutdown".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("shutting down"));
    }

    #[tokio::test]
    async fn confirmed_popup_becomes_a_managed_tab() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-popup".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        adapter.sink.read().unwrap().as_ref().unwrap()(BrowserPlatformEvent::PopupRequested {
            tab_id: snapshot.data.active_tab_id.clone(),
            url: "https://example.com/popup?secret=value".to_string(),
        });
        let pending = manager.snapshot(&snapshot.data.browser_session_id).unwrap();
        let request = pending.data.pending_policy_request.unwrap();
        assert_eq!(request.kind, BrowserPolicyRequestKind::Popup);
        assert_eq!(request.safe_url, "https://example.com/popup");
        let resolved = manager
            .resolve_policy_request(BrowserResolvePolicyRequestInput {
                browser_session_id: snapshot.data.browser_session_id,
                request_id: request.request_id,
                approved: true,
            })
            .await
            .unwrap();
        assert_eq!(resolved.data.tabs.len(), 2);
        assert_eq!(
            resolved.data.tabs[1].url,
            "https://example.com/popup?secret=value"
        );
        assert!(resolved.data.pending_policy_request.is_none());
    }

    #[tokio::test]
    async fn external_protocol_requires_confirmation_and_uses_the_adapter_once() {
        let adapter = Arc::new(FakeAdapter::default());
        let manager = manager(adapter.clone());
        let snapshot = manager
            .create_session(BrowserCreateSessionInput {
                owner_session_id: "thread-external".to_string(),
                profile_id: None,
                persistence: BrowserProfilePersistence::Persistent,
                initial_url: None,
            })
            .await
            .unwrap();
        let url = "mailto:hello@example.com?subject=private";
        adapter.sink.read().unwrap().as_ref().unwrap()(
            BrowserPlatformEvent::ExternalProtocolRequested {
                tab_id: snapshot.data.active_tab_id,
                url: url.to_string(),
            },
        );
        let pending = manager.snapshot(&snapshot.data.browser_session_id).unwrap();
        let request = pending.data.pending_policy_request.unwrap();
        assert_eq!(request.kind, BrowserPolicyRequestKind::ExternalProtocol);
        assert!(!request.safe_url.contains("subject"));
        manager
            .resolve_policy_request(BrowserResolvePolicyRequestInput {
                browser_session_id: snapshot.data.browser_session_id,
                request_id: request.request_id,
                approved: true,
            })
            .await
            .unwrap();
        assert_eq!(adapter.opened_external.lock().unwrap().as_slice(), &[url]);
    }
}
