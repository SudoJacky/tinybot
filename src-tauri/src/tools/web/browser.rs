use crate::native_browser::{
    BrowserCreateSessionInput, BrowserInteractionInput, BrowserNativeSnapshot, BrowserObserveInput,
    BrowserSessionLifecycle, SharedBrowserRuntime,
};
use std::future::Future;
use std::pin::Pin;

pub(crate) trait WebToolCancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;

    fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

pub(crate) async fn dispatch_browser_observe(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let capabilities = runtime.capabilities();
    if !capabilities.session_snapshot.available {
        return Err(capabilities
            .session_snapshot
            .reason
            .unwrap_or_else(|| "TinyOS browser sessions are unavailable".to_string()));
    }
    let capture = arguments
        .get("capture")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let semantic = arguments
        .get("semantic")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    if capture && !capabilities.real_capture.available {
        return Err(capabilities
            .real_capture
            .reason
            .unwrap_or_else(|| "TinyOS browser capture is unavailable".to_string()));
    }
    if semantic && !capabilities.semantic_observation.available {
        return Err(capabilities
            .semantic_observation
            .reason
            .unwrap_or_else(|| "TinyOS browser semantic observation is unavailable".to_string()));
    }
    let requested_session_id = optional_text(&arguments, "browserSessionId")?;
    let snapshot = match runtime.snapshot_for_owner(owner_session_id) {
        Some(snapshot) if snapshot.data.lifecycle == BrowserSessionLifecycle::Creating => {
            runtime
                .create_session(
                    serde_json::from_value::<BrowserCreateSessionInput>(serde_json::json!({
                        "ownerSessionId": owner_session_id
                    }))
                    .map_err(|error| {
                        format!("failed to create TinyOS browser session input: {error}")
                    })?,
                )
                .await?
        }
        Some(snapshot) => snapshot,
        None if requested_session_id.is_some() => {
            return Err(
                "The requested TinyOS browser session is not owned by this chat".to_string(),
            );
        }
        None => {
            runtime
                .create_session(
                    serde_json::from_value::<BrowserCreateSessionInput>(serde_json::json!({
                        "ownerSessionId": owner_session_id
                    }))
                    .map_err(|error| {
                        format!("failed to create TinyOS browser session input: {error}")
                    })?,
                )
                .await?
        }
    };
    ensure_browser_owner(&snapshot, requested_session_id.as_deref())?;
    let requested_tab_id = optional_text(&arguments, "tabId")?;
    let tab_id = requested_tab_id
        .as_deref()
        .unwrap_or_else(|| snapshot.data.active_tab_id.as_str());
    ensure_browser_tab(&snapshot, tab_id)?;
    let input = serde_json::from_value::<BrowserObserveInput>(serde_json::json!({
        "browserSessionId": snapshot.data.browser_session_id.as_str(),
        "tabId": tab_id,
        "capture": capture,
        "semantic": semantic,
    }))
    .map_err(|error| format!("browser.observe payload is invalid: {error}"))?;
    serde_json::to_value(runtime.observe(input).await?)
        .map_err(|error| format!("browser.observe result serialization failed: {error}"))
}

pub(crate) async fn dispatch_browser_interact(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    cancellation: Option<&dyn WebToolCancellation>,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let capabilities = runtime.capabilities();
    if !capabilities.agent_interaction.available {
        return Err(capabilities
            .agent_interaction
            .reason
            .unwrap_or_else(|| "TinyOS Agent browser interaction is unavailable".to_string()));
    }
    let input = serde_json::from_value::<BrowserInteractionInput>(arguments)
        .map_err(|error| format!("browser.interact payload is invalid: {error}"))?;
    let snapshot = runtime
        .snapshot_for_owner(owner_session_id)
        .ok_or_else(|| {
            "Open or observe the TinyOS browser before interacting with it".to_string()
        })?;
    ensure_browser_owner(&snapshot, Some(input.browser_session_id.as_str()))?;
    ensure_browser_tab(&snapshot, input.tab_id.as_str())?;
    let tab_id = input.tab_id.clone();
    let command_id = input.command_id.clone();
    if cancellation.is_some_and(|cancellation| cancellation.is_cancelled()) {
        return Err("Agent browser command was cancelled before dispatch".to_string());
    }
    let interaction = runtime.interact(input);
    tokio::pin!(interaction);
    let result = if let Some(cancellation) = cancellation {
        tokio::select! {
            result = &mut interaction => result,
            _ = cancellation.cancelled() => {
                if runtime.cancel_agent_command(&tab_id, &command_id) {
                    interaction.await
                } else {
                    return Err("Agent browser command was cancelled before dispatch".to_string());
                }
            }
        }
    } else {
        interaction.await
    }?;
    serde_json::to_value(result)
        .map_err(|error| format!("browser.interact result serialization failed: {error}"))
}

fn ensure_browser_owner(
    snapshot: &BrowserNativeSnapshot,
    requested_session_id: Option<&str>,
) -> Result<(), String> {
    if snapshot.data.session_id.is_empty() {
        return Err("TinyOS browser snapshot has no owning chat session".to_string());
    }
    if requested_session_id
        .is_some_and(|requested| requested != snapshot.data.browser_session_id.as_str())
    {
        return Err("The requested TinyOS browser session is not owned by this chat".to_string());
    }
    Ok(())
}

fn ensure_browser_tab(snapshot: &BrowserNativeSnapshot, tab_id: &str) -> Result<(), String> {
    snapshot
        .data
        .tabs
        .iter()
        .any(|tab| tab.tab_id.as_str() == tab_id)
        .then_some(())
        .ok_or_else(|| {
            "The requested TinyOS browser tab is not part of this chat session".to_string()
        })
}

fn optional_text(value: &serde_json::Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(text)) if !text.trim().is_empty() => {
            Ok(Some(text.trim().to_string()))
        }
        Some(_) => Err(format!("{key} must be a non-empty string")),
    }
}

pub(crate) fn strip_browser_capture_data(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.remove("dataUrl");
            for child in object.values_mut() {
                strip_browser_capture_data(child);
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                strip_browser_capture_data(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;
