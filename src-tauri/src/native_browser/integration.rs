use super::{
    commands::{
        browser_back, browser_capabilities, browser_close_session, browser_create_session,
        browser_forward, browser_interact, browser_metrics, browser_navigate, browser_observe,
        browser_snapshot, browser_update_surface,
    },
    manager::BrowserSessionManager,
    model::{
        BrowserAction, BrowserCommandId, BrowserCommandStatus, BrowserCreateSessionInput,
        BrowserInteractionInput, BrowserNavigateInput, BrowserObserveInput,
        BrowserProfilePersistence, BrowserSessionTarget, BrowserSurfaceId, BrowserSurfaceRect,
        BrowserSurfaceUpdate, BrowserTabTarget,
    },
    test_fixture::NativeBrowserFixture,
    windows::WindowsBrowserRuntime,
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{mpsc, Arc},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

#[tauri::command]
fn native_browser_integration_probe() -> bool {
    true
}

pub(crate) fn run() -> Result<(), String> {
    let profile_root = integration_profile_root();
    let cleanup_root = profile_root.clone();
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_browser_integration_probe])
        .setup(move |app| {
            let adapter = WindowsBrowserRuntime::new(app.handle().clone(), profile_root.clone())
                .map_err(std::io::Error::other)?;
            let runtime = BrowserSessionManager::new(
                adapter,
                profile_root,
                Arc::new(|_| {}),
                Arc::new(|_| {}),
            );
            if !app.manage(runtime) {
                return Err(std::io::Error::other(
                    "Native browser integration runtime was already managed",
                )
                .into());
            }
            let app_handle = app.handle().clone();
            let exit_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let result = run_public_command_scenario(&app_handle).await;
                let _ = result_tx.send(result);
                exit_handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|error| format!("Failed to build native browser integration app: {error}"))?;

    let exit_code = app.run_return(|_, _| {});
    let result = result_rx
        .recv_timeout(Duration::from_secs(60))
        .map_err(|error| format!("Native browser integration result was not reported: {error}"))?;
    let cleanup_result = if cleanup_root.exists() {
        std::fs::remove_dir_all(&cleanup_root).map_err(|error| {
            format!(
                "Failed to remove native browser integration profile root {}: {error}",
                cleanup_root.display()
            )
        })
    } else {
        Ok(())
    };
    if exit_code != 0 {
        return Err(format!(
            "Native browser integration app exited with code {exit_code}"
        ));
    }
    match (result, cleanup_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Err(scenario), Err(cleanup)) => Err(format!("{scenario}; cleanup also failed: {cleanup}")),
    }
}

async fn run_public_command_scenario(app: &tauri::AppHandle) -> Result<(), String> {
    let fixture = NativeBrowserFixture::start().await?;
    let result = exercise_public_commands(app, &fixture).await;
    let close_result = fixture.close().await;
    result.and(close_result)
}

async fn exercise_public_commands(
    app: &tauri::AppHandle,
    fixture: &NativeBrowserFixture,
) -> Result<(), String> {
    let capabilities = browser_capabilities(runtime_state(app));
    if !capabilities.session_snapshot.available || capabilities.runtime_kind != "windows_webview2" {
        return Err(format!(
            "Windows WebView2 capabilities were unavailable: {}",
            capabilities.runtime_kind
        ));
    }

    let created = browser_create_session(
        runtime_state(app),
        BrowserCreateSessionInput {
            owner_session_id: "native-browser-integration".to_string(),
            profile_id: Some("native-browser-integration".to_string()),
            persistence: BrowserProfilePersistence::Incognito,
            initial_url: None,
        },
    )
    .await?;
    let browser_session_id = created.data.browser_session_id.clone();
    let tab_id = created.data.active_tab_id.clone();

    let scenario_result = exercise_open_session(app, fixture, &browser_session_id, &tab_id).await;
    let close_result = browser_close_session(
        runtime_state(app),
        BrowserSessionTarget {
            browser_session_id: browser_session_id.clone(),
        },
    )
    .await;
    let semantic_nodes = match (scenario_result, close_result) {
        (Ok(count), Ok(())) => count,
        (Err(error), Ok(())) => return Err(error),
        (Ok(_), Err(error)) => return Err(error),
        (Err(scenario), Err(cleanup)) => {
            return Err(format!(
                "{scenario}; session cleanup also failed: {cleanup}"
            ));
        }
    };
    if browser_snapshot(
        runtime_state(app),
        BrowserSessionTarget { browser_session_id },
    )
    .is_ok()
    {
        return Err("Closed browser session remained readable".to_string());
    }

    let metrics = browser_metrics(runtime_state(app));
    if metrics
        .counters
        .get("browser.observe.failed")
        .copied()
        .unwrap_or_default()
        != 0
    {
        return Err(format!(
            "Native browser integration recorded failed observations: {:?}",
            metrics.counters
        ));
    }
    println!(
        "{}",
        json!({
            "capture": "png",
            "fixture": fixture.base_url(),
            "interactions": ["click", "fill", "type", "key", "wait", "scroll", "protected_handoff", "stale_rejection"],
            "navigation": "back_forward",
            "semanticNodes": semantic_nodes,
            "status": "passed",
            "metrics": metrics,
        })
    );
    Ok(())
}

async fn exercise_open_session(
    app: &tauri::AppHandle,
    fixture: &NativeBrowserFixture,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
) -> Result<usize, String> {
    let snapshot = browser_snapshot(
        runtime_state(app),
        BrowserSessionTarget {
            browser_session_id: browser_session_id.clone(),
        },
    )?;
    if snapshot.data.tabs.len() != 1 || snapshot.data.tabs[0].url != "about:blank" {
        return Err("Public create/snapshot commands returned unexpected tab state".to_string());
    }

    browser_navigate(
        runtime_state(app),
        BrowserNavigateInput {
            browser_session_id: browser_session_id.clone(),
            tab_id: tab_id.clone(),
            url: fixture.url("/"),
        },
    )
    .await?;

    browser_update_surface(
        runtime_state(app),
        BrowserSurfaceUpdate {
            browser_session_id: browser_session_id.clone(),
            tab_id: tab_id.clone(),
            surface_id: BrowserSurfaceId::new("native-browser-integration-surface")?,
            layout_revision: 1,
            rect: BrowserSurfaceRect {
                x: 20.0,
                y: 20.0,
                width: 720.0,
                height: 520.0,
                device_scale: 1.0,
            },
            visible: true,
            live: true,
            topmost: true,
            unobscured: true,
        },
    )
    .await?;

    let observed = browser_observe(
        runtime_state(app),
        BrowserObserveInput {
            browser_session_id: browser_session_id.clone(),
            tab_id: tab_id.clone(),
            capture: true,
            semantic: true,
        },
    )
    .await?;
    let capture = observed
        .capture
        .as_ref()
        .ok_or_else(|| "Public observe command did not return a real capture".to_string())?;
    if !capture
        .data_url
        .as_deref()
        .unwrap_or_default()
        .starts_with("data:image/png;base64,")
    {
        return Err("Public observe capture was not a PNG data URL".to_string());
    }
    let mut semantic = observed
        .semantic
        .clone()
        .ok_or_else(|| "Public observe command did not return semantic nodes".to_string())?;
    for _ in 0..20 {
        if semantic.nodes.iter().any(|node| {
            node.name.contains("invoke-denied") || node.name.contains("invoke-unavailable")
        }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        semantic = browser_observe(
            runtime_state(app),
            BrowserObserveInput {
                browser_session_id: browser_session_id.clone(),
                tab_id: tab_id.clone(),
                capture: false,
                semantic: true,
            },
        )
        .await?
        .semantic
        .ok_or_else(|| "Public observe polling lost semantic nodes".to_string())?;
    }
    let sensitive_nodes = semantic.nodes.iter().filter(|node| node.sensitive).count();
    if sensitive_nodes < 3
        || !semantic
            .nodes
            .iter()
            .any(|node| node.protected_reason.as_deref() == Some("native_file_picker"))
        || !semantic
            .nodes
            .iter()
            .any(|node| node.protected_reason.as_deref() == Some("captcha"))
        || !semantic.nodes.iter().any(|node| {
            node.name.contains("global-false")
                && (node.name.contains("invoke-denied") || node.name.contains("invoke-unavailable"))
                && node.name.contains("tinybot-false")
        })
    {
        return Err(format!(
            "Public observe command did not preserve fixture privacy boundaries: {}",
            serde_json::to_string(&semantic.nodes)
                .unwrap_or_else(|_| "<semantic serialization failed>".to_string())
        ));
    }

    exercise_agent_interactions(app, browser_session_id, tab_id).await?;

    navigate(app, &browser_session_id, &tab_id, fixture.url("/history/a")).await?;
    navigate(app, &browser_session_id, &tab_id, fixture.url("/history/b")).await?;
    let target = BrowserTabTarget {
        browser_session_id: browser_session_id.clone(),
        tab_id: tab_id.clone(),
    };
    let back_observation_revision = observation_revision(app, browser_session_id, tab_id)?;
    browser_back(runtime_state(app), target.clone()).await?;
    wait_for_observation_revision(app, browser_session_id, tab_id, back_observation_revision)
        .await?;
    assert_active_url(
        app,
        &browser_session_id,
        &tab_id,
        &fixture.url("/history/a"),
    )?;
    let forward_observation_revision = observation_revision(app, browser_session_id, tab_id)?;
    browser_forward(runtime_state(app), target).await?;
    wait_for_observation_revision(
        app,
        browser_session_id,
        tab_id,
        forward_observation_revision,
    )
    .await?;
    assert_active_url(
        app,
        &browser_session_id,
        &tab_id,
        &fixture.url("/history/b"),
    )?;

    Ok(semantic.nodes.len())
}

async fn exercise_agent_interactions(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
) -> Result<(), String> {
    let dynamic_target = semantic_target(app, browser_session_id, tab_id, |node| {
        node.name == "Update dynamic text"
    })?;
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "click-dynamic",
        BrowserAction::ClickTarget {
            target_ref: dynamic_target,
        },
        BrowserCommandStatus::Completed,
    )
    .await?;
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "wait-dynamic",
        BrowserAction::Wait {
            text: Some("updated-1".to_string()),
            target_ref: None,
            timeout_ms: 2_000,
        },
        BrowserCommandStatus::Completed,
    )
    .await?;

    let text_target = semantic_target(app, browser_session_id, tab_id, |node| {
        node.role == "input" && !node.sensitive && node.protected_reason.is_none()
    })?;
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "fill-text",
        BrowserAction::Fill {
            target_ref: text_target,
            text: "fixture".to_string(),
        },
        BrowserCommandStatus::Completed,
    )
    .await?;
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "type-text",
        BrowserAction::Type {
            text: "-typed".to_string(),
        },
        BrowserCommandStatus::Completed,
    )
    .await?;
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "key-enter",
        BrowserAction::Key {
            key: "Enter".to_string(),
        },
        BrowserCommandStatus::Completed,
    )
    .await?;
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "wait-key",
        BrowserAction::Wait {
            text: Some("key-Enter".to_string()),
            target_ref: None,
            timeout_ms: 2_000,
        },
        BrowserCommandStatus::Completed,
    )
    .await?;

    let stale_context = interaction_context(app, browser_session_id, tab_id)?;
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "scroll",
        BrowserAction::Scroll {
            delta_x: 0.0,
            delta_y: 1_200.0,
        },
        BrowserCommandStatus::Completed,
    )
    .await?;
    let stale_result = browser_interact(
        runtime_state(app),
        BrowserInteractionInput {
            browser_session_id: browser_session_id.clone(),
            tab_id: tab_id.clone(),
            command_id: BrowserCommandId::new("stale-observation")?,
            control_epoch: stale_context.0,
            capture_id: stale_context.2,
            observation_revision: Some(stale_context.1),
            action: BrowserAction::Wait {
                text: Some("Native browser fixture".to_string()),
                target_ref: None,
                timeout_ms: 100,
            },
        },
    )
    .await;
    if !matches!(stale_result, Err(ref error) if error.contains("stale")) {
        return Err(format!(
            "Stale browser observation was not rejected: {stale_result:?}"
        ));
    }

    let file_target = semantic_target(app, browser_session_id, tab_id, |node| {
        node.protected_reason.as_deref() == Some("native_file_picker")
    })?;
    let protected = run_interaction(
        app,
        browser_session_id,
        tab_id,
        "protected-file",
        BrowserAction::ClickTarget {
            target_ref: file_target,
        },
        BrowserCommandStatus::UserRequired,
    )
    .await?;
    if protected.reason_code.as_deref() != Some("native_file_picker") {
        return Err(format!(
            "Protected file target returned the wrong reason: {:?}",
            protected.reason_code
        ));
    }
    run_interaction(
        app,
        browser_session_id,
        tab_id,
        "resume",
        BrowserAction::Resume,
        BrowserCommandStatus::Completed,
    )
    .await?;
    Ok(())
}

async fn run_interaction(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
    command_id: &str,
    action: BrowserAction,
    expected_status: BrowserCommandStatus,
) -> Result<super::model::BrowserCommandResult, String> {
    let (control_epoch, observation_revision, capture_id) =
        interaction_context(app, browser_session_id, tab_id)?;
    let result = browser_interact(
        runtime_state(app),
        BrowserInteractionInput {
            browser_session_id: browser_session_id.clone(),
            tab_id: tab_id.clone(),
            command_id: BrowserCommandId::new(command_id)?,
            control_epoch,
            capture_id,
            observation_revision: action
                .requires_observation()
                .then_some(observation_revision),
            action,
        },
    )
    .await?;
    if result.status != expected_status {
        return Err(format!(
            "Browser command {command_id} returned {:?}, expected {:?}: {:?}",
            result.status, expected_status, result.reason
        ));
    }
    Ok(result)
}

fn interaction_context(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
) -> Result<(u64, u64, Option<super::model::BrowserCaptureId>), String> {
    let snapshot = browser_snapshot(
        runtime_state(app),
        BrowserSessionTarget {
            browser_session_id: browser_session_id.clone(),
        },
    )?;
    let tab = snapshot
        .data
        .tabs
        .iter()
        .find(|tab| &tab.tab_id == tab_id)
        .ok_or_else(|| format!("Browser tab {tab_id} is unavailable for interaction"))?;
    Ok((
        snapshot.data.control.control_epoch,
        tab.observation_revision,
        tab.current_capture_id.clone(),
    ))
}

fn semantic_target(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
    predicate: impl Fn(&super::model::BrowserSemanticNode) -> bool,
) -> Result<String, String> {
    let snapshot = browser_snapshot(
        runtime_state(app),
        BrowserSessionTarget {
            browser_session_id: browser_session_id.clone(),
        },
    )?;
    snapshot
        .data
        .tabs
        .iter()
        .find(|tab| &tab.tab_id == tab_id)
        .and_then(|tab| tab.semantic_observation.as_ref())
        .and_then(|semantic| semantic.nodes.iter().find(|node| predicate(node)))
        .map(|node| node.target_ref.clone())
        .ok_or_else(|| "Expected semantic target was unavailable".to_string())
}

async fn navigate(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
    url: String,
) -> Result<(), String> {
    let baseline = observation_revision(app, browser_session_id, tab_id)?;
    browser_navigate(
        runtime_state(app),
        BrowserNavigateInput {
            browser_session_id: browser_session_id.clone(),
            tab_id: tab_id.clone(),
            url,
        },
    )
    .await?;
    wait_for_observation_revision(app, browser_session_id, tab_id, baseline).await
}

async fn wait_for_observation_revision(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
    baseline: u64,
) -> Result<(), String> {
    for _ in 0..100 {
        if observation_revision(app, browser_session_id, tab_id)? > baseline {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(format!(
        "Post-navigation observation did not advance after revision {baseline}"
    ))
}

fn observation_revision(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
) -> Result<u64, String> {
    let snapshot = browser_snapshot(
        runtime_state(app),
        BrowserSessionTarget {
            browser_session_id: browser_session_id.clone(),
        },
    )?;
    snapshot
        .data
        .tabs
        .iter()
        .find(|tab| &tab.tab_id == tab_id)
        .map(|tab| tab.observation_revision)
        .ok_or_else(|| format!("Browser tab {tab_id} disappeared while waiting for observation"))
}

fn assert_active_url(
    app: &tauri::AppHandle,
    browser_session_id: &super::model::BrowserSessionId,
    tab_id: &super::model::BrowserTabId,
    expected: &str,
) -> Result<(), String> {
    let snapshot = browser_snapshot(
        runtime_state(app),
        BrowserSessionTarget {
            browser_session_id: browser_session_id.clone(),
        },
    )?;
    let actual = snapshot
        .data
        .tabs
        .iter()
        .find(|tab| &tab.tab_id == tab_id)
        .map(|tab| tab.url.as_str());
    if actual != Some(expected) {
        return Err(format!(
            "Browser navigation URL mismatch: expected {expected}, got {actual:?}"
        ));
    }
    Ok(())
}

fn runtime_state(app: &tauri::AppHandle) -> State<'_, super::manager::SharedBrowserRuntime> {
    app.state::<super::manager::SharedBrowserRuntime>()
}

fn integration_profile_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "tinybot-native-browser-integration-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
}
