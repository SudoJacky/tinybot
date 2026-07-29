use super::browser::{dispatch_browser_interact, dispatch_browser_observe, WebToolCancellation};
use crate::native_browser::{
    BrowserAgentPageState, BrowserCreateSessionInput, SharedBrowserRuntime, AGENT_SNAPSHOT_STALE,
};
use serde_json::{json, Value};

pub(crate) async fn dispatch_web_open(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    cancellation: Option<&dyn WebToolCancellation>,
    arguments: Value,
) -> Result<Value, String> {
    let url = required_text(&arguments, "url")?;
    if runtime.snapshot_for_owner(owner_session_id).is_none() {
        runtime
            .create_session(
                serde_json::from_value::<BrowserCreateSessionInput>(json!({
                    "ownerSessionId": owner_session_id,
                    "initialUrl": url,
                }))
                .map_err(|error| format!("web.open payload is invalid: {error}"))?,
            )
            .await?;
        let page = refresh_page(runtime, owner_session_id).await?;
        return Ok(completed_response(&page, None));
    }

    let page = refresh_page(runtime, owner_session_id).await?;
    execute_action(
        runtime,
        owner_session_id,
        cancellation,
        &page,
        arguments
            .get("commandId")
            .and_then(Value::as_str)
            .ok_or_else(|| "web.open command id is missing".to_string())?,
        json!({ "type": "navigate", "url": url }),
    )
    .await
}

pub(crate) async fn dispatch_web_read(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    ensure_session(runtime, owner_session_id).await?;
    let requested_snapshot_id = optional_text(&arguments, "snapshotId")?;
    let page = refresh_page(runtime, owner_session_id).await?;
    if requested_snapshot_id.as_deref() == Some(page.snapshot_id.as_str()) {
        return Ok(json!({
            "status": "unchanged",
            "snapshotId": page.snapshot_id,
        }));
    }
    Ok(completed_response(&page, None))
}

pub(crate) async fn dispatch_web_act(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    cancellation: Option<&dyn WebToolCancellation>,
    arguments: Value,
) -> Result<Value, String> {
    let requested_snapshot_id = required_text(&arguments, "snapshotId")?;
    let command_id = required_text(&arguments, "commandId")?;
    let action = arguments
        .get("action")
        .cloned()
        .ok_or_else(|| "web.act requires an action".to_string())?;
    ensure_session(runtime, owner_session_id).await?;
    let page = refresh_page(runtime, owner_session_id).await?;
    if requested_snapshot_id != page.snapshot_id {
        return Ok(stale_response(&requested_snapshot_id, &page));
    }
    execute_action(
        runtime,
        owner_session_id,
        cancellation,
        &page,
        &command_id,
        action,
    )
    .await
}

async fn ensure_session(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
) -> Result<(), String> {
    if runtime.snapshot_for_owner(owner_session_id).is_none() {
        dispatch_browser_observe(runtime, owner_session_id, json!({})).await?;
    }
    Ok(())
}

async fn refresh_page(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
) -> Result<BrowserAgentPageState, String> {
    let page = runtime
        .agent_page_state_for_owner(owner_session_id)
        .ok_or_else(|| "TinyOS browser session is unavailable for this chat".to_string())?;
    if page.dirty || page.observation.capture.is_none() || page.observation.semantic.is_none() {
        dispatch_browser_observe(
            runtime,
            owner_session_id,
            json!({
                "browserSessionId": page.observation.snapshot.data.browser_session_id,
                "tabId": page.observation.snapshot.data.active_tab_id,
                "capture": true,
                "semantic": true,
            }),
        )
        .await?;
        return runtime
            .agent_page_state_for_owner(owner_session_id)
            .ok_or_else(|| "TinyOS browser session disappeared after refresh".to_string());
    }
    Ok(page)
}

async fn execute_action(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    cancellation: Option<&dyn WebToolCancellation>,
    page: &BrowserAgentPageState,
    command_id: &str,
    action: Value,
) -> Result<Value, String> {
    let native = &page.observation.snapshot.data;
    let tab = native
        .tabs
        .iter()
        .find(|tab| tab.tab_id == native.active_tab_id)
        .ok_or_else(|| "TinyOS browser active tab is unavailable".to_string())?;
    let result = dispatch_browser_interact(
        runtime,
        owner_session_id,
        cancellation,
        json!({
            "browserSessionId": native.browser_session_id,
            "tabId": native.active_tab_id,
            "commandId": command_id,
            "controlEpoch": native.control.control_epoch,
            "snapshotId": page.snapshot_id,
            "captureId": tab.current_capture_id,
            "observationRevision": tab.observation_revision,
            "action": action,
        }),
    )
    .await;

    let command = match result {
        Ok(command) => command,
        Err(error) if error == AGENT_SNAPSHOT_STALE => {
            let latest = refresh_page(runtime, owner_session_id).await?;
            return Ok(stale_response(&page.snapshot_id, &latest));
        }
        Err(error) => return Err(error),
    };
    let status = command
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    let mut latest = refresh_page(runtime, owner_session_id).await?;
    if status == "completed" && latest.snapshot_id == page.snapshot_id {
        runtime.advance_agent_snapshot_for_owner(owner_session_id)?;
        latest = runtime
            .agent_page_state_for_owner(owner_session_id)
            .ok_or_else(|| "TinyOS browser session disappeared after interaction".to_string())?;
    }
    Ok(completed_response(&latest, Some(&command)))
}

fn completed_response(page: &BrowserAgentPageState, command: Option<&Value>) -> Value {
    let status = command
        .and_then(|command| command.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let mut response = json!({
        "status": status,
        "snapshotId": page.snapshot_id,
        "snapshot": snapshot_payload(page),
    });
    if let Some(command) = command {
        response["actionExecuted"] = Value::Bool(status == "completed");
        if let Some(reason_code) = command.get("reasonCode") {
            response["reasonCode"] = reason_code.clone();
        }
        if let Some(reason) = command.get("reason") {
            response["reason"] = reason.clone();
        }
    }
    response
}

fn stale_response(requested_snapshot_id: &str, page: &BrowserAgentPageState) -> Value {
    json!({
        "status": "stale_snapshot",
        "actionExecuted": false,
        "requestedSnapshotId": requested_snapshot_id,
        "snapshotId": page.snapshot_id,
        "snapshot": snapshot_payload(page),
    })
}

fn snapshot_payload(page: &BrowserAgentPageState) -> Value {
    let native = &page.observation.snapshot.data;
    let Some(tab) = native
        .tabs
        .iter()
        .find(|tab| tab.tab_id == native.active_tab_id)
    else {
        return json!({});
    };
    let viewport = page.observation.capture.as_ref().map(|capture| {
        json!({
            "width": capture.viewport_width,
            "height": capture.viewport_height,
            "deviceScale": capture.device_scale,
        })
    });
    let targets = page
        .observation
        .semantic
        .as_ref()
        .map(|semantic| &semantic.nodes);
    let targets_truncated = page
        .observation
        .semantic
        .as_ref()
        .is_some_and(|semantic| semantic.truncated);
    json!({
        "url": tab.url,
        "title": tab.title,
        "loading": tab.loading,
        "canGoBack": tab.can_go_back,
        "canGoForward": tab.can_go_forward,
        "viewport": viewport,
        "targets": targets,
        "targetsTruncated": targets_truncated,
        "interaction": native.interaction,
        "control": {
            "state": native.control.state,
            "reason": native.control.reason,
        },
        "pendingPolicyRequest": native.pending_policy_request.as_ref().map(|request| json!({
            "kind": request.kind,
            "safeUrl": request.safe_url,
        })),
    })
}

fn required_text(value: &Value, key: &str) -> Result<String, String> {
    optional_text(value, key)?.ok_or_else(|| format!("{key} is required"))
}

fn optional_text(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(Some(text.trim().to_string())),
        Some(_) => Err(format!("{key} must be a non-empty string")),
    }
}
