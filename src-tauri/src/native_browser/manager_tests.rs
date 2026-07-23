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
    let manager = manager_with_diagnostics(Arc::new(FakeAdapter::default()), diagnostics.clone());
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
