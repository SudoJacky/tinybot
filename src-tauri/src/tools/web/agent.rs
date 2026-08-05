use super::browser::{dispatch_browser_interact, dispatch_browser_observe, WebToolCancellation};
use crate::native_browser::{
    BrowserAgentPageState, BrowserAgentPageText, BrowserControlState, BrowserCreateSessionInput,
    BrowserNativeSnapshot, BrowserSemanticNode, SharedBrowserRuntime, AGENT_SNAPSHOT_STALE,
};
use serde_json::{json, Map, Value};

const MAX_AGENT_SNAPSHOT_TARGETS: usize = 100;
const MAX_AGENT_PAGE_TEXT_CHARS: usize = 8_000;

#[derive(Clone, Copy)]
struct SnapshotProjection {
    content_offset: Option<usize>,
    include_targets: bool,
}

impl SnapshotProjection {
    fn initial_page() -> Self {
        Self {
            content_offset: Some(0),
            include_targets: true,
        }
    }

    fn interaction() -> Self {
        Self {
            content_offset: None,
            include_targets: true,
        }
    }
}

pub(crate) async fn dispatch_web_open(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    cancellation: Option<&dyn WebToolCancellation>,
    arguments: Value,
) -> Result<Value, String> {
    let url = required_text(&arguments, "url")?;
    if runtime.snapshot_for_owner(owner_session_id).is_none() {
        create_session_with_cancellation(
            runtime,
            cancellation,
            serde_json::from_value::<BrowserCreateSessionInput>(json!({
                "ownerSessionId": owner_session_id,
                "initialUrl": url,
            }))
            .map_err(|error| format!("web.open payload is invalid: {error}"))?,
        )
        .await?;
        let (page, content) = refresh_page_with_initial_content(runtime, owner_session_id).await?;
        return Ok(completed_response(
            &page,
            None,
            SnapshotProjection::initial_page(),
            Some(&content),
        ));
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
        SnapshotProjection::initial_page(),
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
    let text_offset = optional_usize(&arguments, "textOffset")?.unwrap_or_default();
    let page = refresh_page(runtime, owner_session_id).await?;
    if text_offset == 0 && requested_snapshot_id.as_deref() == Some(page.snapshot_id.as_str()) {
        return Ok(json!({
            "status": "unchanged",
            "snapshotId": page.snapshot_id,
        }));
    }
    if text_offset > 0 {
        let requested_snapshot_id = requested_snapshot_id.as_deref().ok_or_else(|| {
            "web.read textOffset requires the snapshotId that returned nextTextOffset".to_string()
        })?;
        if requested_snapshot_id != page.snapshot_id {
            let (latest, content) =
                refresh_page_with_initial_content(runtime, owner_session_id).await?;
            return Ok(read_reset_response(
                requested_snapshot_id,
                &latest,
                &content,
            ));
        }
        let content = match read_page_content(runtime, owner_session_id, &page, text_offset).await {
            Ok(content) => content,
            Err(error) if error == AGENT_SNAPSHOT_STALE => {
                let (latest, content) =
                    refresh_page_with_initial_content(runtime, owner_session_id).await?;
                return Ok(read_reset_response(
                    requested_snapshot_id,
                    &latest,
                    &content,
                ));
            }
            Err(error) => return Err(error),
        };
        return Ok(completed_response(
            &page,
            None,
            SnapshotProjection {
                content_offset: Some(text_offset),
                include_targets: false,
            },
            Some(&content),
        ));
    }
    let (page, content) = match read_page_content(runtime, owner_session_id, &page, 0).await {
        Ok(content) => (page, content),
        Err(error) if error == AGENT_SNAPSHOT_STALE => {
            refresh_page_with_initial_content(runtime, owner_session_id).await?
        }
        Err(error) => return Err(error),
    };
    Ok(completed_response(
        &page,
        None,
        SnapshotProjection::initial_page(),
        Some(&content),
    ))
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
    if action.get("type").and_then(Value::as_str) == Some("resume") {
        return Err("Only the user can hand browser control back to the Agent".to_string());
    }
    ensure_session(runtime, owner_session_id).await?;
    let page = refresh_page(runtime, owner_session_id).await?;
    if requested_snapshot_id != page.snapshot_id {
        return Ok(stale_response(
            &requested_snapshot_id,
            &page,
            SnapshotProjection::interaction(),
        ));
    }
    execute_action(
        runtime,
        owner_session_id,
        cancellation,
        &page,
        &command_id,
        action,
        SnapshotProjection::interaction(),
    )
    .await
}

async fn create_session_with_cancellation(
    runtime: &SharedBrowserRuntime,
    cancellation: Option<&dyn WebToolCancellation>,
    input: BrowserCreateSessionInput,
) -> Result<BrowserNativeSnapshot, String> {
    if cancellation.is_some_and(WebToolCancellation::is_cancelled) {
        return Err("Agent browser session creation was cancelled".to_string());
    }
    let runtime = runtime.clone();
    let mut creation =
        tauri::async_runtime::spawn(async move { runtime.create_session(input).await });
    if let Some(cancellation) = cancellation {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                Err("Agent browser session creation was cancelled".to_string())
            }
            result = &mut creation => {
                result.map_err(|error| {
                    format!("Agent browser session creation task failed: {error}")
                })?
            },
        }
    } else {
        creation
            .await
            .map_err(|error| format!("Agent browser session creation task failed: {error}"))?
    }
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

async fn refresh_page_with_initial_content(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
) -> Result<(BrowserAgentPageState, BrowserAgentPageText), String> {
    for _ in 0..3 {
        let page = refresh_page(runtime, owner_session_id).await?;
        match read_page_content(runtime, owner_session_id, &page, 0).await {
            Ok(content) => return Ok((page, content)),
            Err(error) if error == AGENT_SNAPSHOT_STALE => continue,
            Err(error) => return Err(error),
        }
    }
    Err("Browser page kept changing while its first text chunk was read".to_string())
}

async fn read_page_content(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    page: &BrowserAgentPageState,
    text_offset: usize,
) -> Result<BrowserAgentPageText, String> {
    runtime
        .read_agent_page_text_for_owner(
            owner_session_id,
            &page.snapshot_id,
            text_offset,
            MAX_AGENT_PAGE_TEXT_CHARS,
        )
        .await
}

async fn execute_action(
    runtime: &SharedBrowserRuntime,
    owner_session_id: &str,
    cancellation: Option<&dyn WebToolCancellation>,
    page: &BrowserAgentPageState,
    command_id: &str,
    action: Value,
    projection: SnapshotProjection,
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
            return Ok(stale_response(&page.snapshot_id, &latest, projection));
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
    let content = if projection.content_offset.is_some() {
        let (page, content) = refresh_page_with_initial_content(runtime, owner_session_id).await?;
        latest = page;
        Some(content)
    } else {
        None
    };
    Ok(completed_response(
        &latest,
        Some(&command),
        projection,
        content.as_ref(),
    ))
}

fn completed_response(
    page: &BrowserAgentPageState,
    command: Option<&Value>,
    projection: SnapshotProjection,
    content: Option<&BrowserAgentPageText>,
) -> Value {
    let status = command
        .and_then(|command| command.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let mut response = json!({
        "status": status,
        "snapshotId": page.snapshot_id,
        "snapshot": snapshot_payload(page, projection, content),
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

fn stale_response(
    requested_snapshot_id: &str,
    page: &BrowserAgentPageState,
    projection: SnapshotProjection,
) -> Value {
    json!({
        "status": "stale_snapshot",
        "actionExecuted": false,
        "requestedSnapshotId": requested_snapshot_id,
        "snapshotId": page.snapshot_id,
        "snapshot": snapshot_payload(page, projection, None),
    })
}

fn read_reset_response(
    requested_snapshot_id: &str,
    page: &BrowserAgentPageState,
    content: &BrowserAgentPageText,
) -> Value {
    json!({
        "status": "stale_snapshot",
        "requestedSnapshotId": requested_snapshot_id,
        "snapshotId": page.snapshot_id,
        "textOffsetReset": true,
        "snapshot": snapshot_payload(page, SnapshotProjection::initial_page(), Some(content)),
    })
}

fn snapshot_payload(
    page: &BrowserAgentPageState,
    projection: SnapshotProjection,
    content: Option<&BrowserAgentPageText>,
) -> Value {
    let native = &page.observation.snapshot.data;
    let Some(tab) = native
        .tabs
        .iter()
        .find(|tab| tab.tab_id == native.active_tab_id)
    else {
        return json!({});
    };
    let mut targets_truncated = false;
    let targets = projection
        .include_targets
        .then(|| page.observation.semantic.as_ref())
        .flatten()
        .map(|semantic| {
            targets_truncated = semantic.truncated;
            let mut targets = semantic
                .nodes
                .iter()
                .filter(|target| {
                    let meaningful = !target.name.trim().is_empty()
                        || target.sensitive
                        || target.protected_reason.is_some();
                    meaningful
                        && page.observation.capture.as_ref().is_none_or(|capture| {
                            capture.viewport_width <= 1
                                || capture.viewport_height <= 1
                                || (target.x + target.width > 0.0
                                    && target.y + target.height > 0.0
                                    && target.x < f64::from(capture.viewport_width)
                                    && target.y < f64::from(capture.viewport_height))
                        })
                })
                .take(MAX_AGENT_SNAPSHOT_TARGETS + 1)
                .collect::<Vec<_>>();
            if targets.len() > MAX_AGENT_SNAPSHOT_TARGETS {
                targets.truncate(MAX_AGENT_SNAPSHOT_TARGETS);
                targets_truncated = true;
            }
            targets
                .into_iter()
                .map(snapshot_target_payload)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut snapshot = Map::new();
    snapshot.insert("url".to_string(), Value::String(tab.url.clone()));
    snapshot.insert("title".to_string(), Value::String(tab.title.clone()));
    if projection.include_targets {
        snapshot.insert("targets".to_string(), Value::Array(targets));
        snapshot.insert(
            "targetsTruncated".to_string(),
            Value::Bool(targets_truncated),
        );
    }
    if let Some(content) = content.and_then(page_content_payload) {
        snapshot.insert("content".to_string(), content);
    }
    if tab.loading {
        snapshot.insert("loading".to_string(), Value::Bool(true));
    }
    if tab.can_go_back {
        snapshot.insert("canGoBack".to_string(), Value::Bool(true));
    }
    if tab.can_go_forward {
        snapshot.insert("canGoForward".to_string(), Value::Bool(true));
    }
    if !matches!(
        native.control.state,
        BrowserControlState::Idle | BrowserControlState::AgentActive
    ) || native.control.reason.is_some()
    {
        let mut control = Map::new();
        control.insert("state".to_string(), json!(native.control.state));
        if let Some(reason) = native.control.reason.as_ref() {
            control.insert("reason".to_string(), Value::String(reason.clone()));
        }
        snapshot.insert("control".to_string(), Value::Object(control));
    }
    if let Some(request) = native.pending_policy_request.as_ref() {
        snapshot.insert(
            "pendingPolicyRequest".to_string(),
            json!({
                "kind": request.kind,
                "safeUrl": request.safe_url,
            }),
        );
    }
    Value::Object(snapshot)
}

fn page_content_payload(page_text: &BrowserAgentPageText) -> Option<Value> {
    if page_text.text.is_empty()
        && page_text.text_offset == 0
        && page_text.next_text_offset.is_none()
        && !page_text.source_truncated
    {
        return None;
    }
    let mut content = Map::new();
    content.insert("trust".to_string(), Value::String("untrusted".to_string()));
    content.insert("text".to_string(), Value::String(page_text.text.clone()));
    if page_text.text_offset > 0 {
        content.insert("textOffset".to_string(), json!(page_text.text_offset));
    }
    if let Some(next_text_offset) = page_text.next_text_offset {
        content.insert("nextTextOffset".to_string(), json!(next_text_offset));
    }
    if page_text.next_text_offset.is_some() || page_text.source_truncated {
        content.insert("truncated".to_string(), Value::Bool(true));
    }
    if page_text.source_truncated {
        content.insert("sourceTruncated".to_string(), Value::Bool(true));
    }
    Some(Value::Object(content))
}

fn snapshot_target_payload(target: &BrowserSemanticNode) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "targetRef".to_string(),
        Value::String(target.target_ref.clone()),
    );
    payload.insert("role".to_string(), Value::String(target.role.clone()));
    payload.insert("name".to_string(), Value::String(target.name.clone()));
    if target.frame != "top" {
        payload.insert("frame".to_string(), Value::String(target.frame.clone()));
    }
    if target.disabled {
        payload.insert("disabled".to_string(), Value::Bool(true));
    }
    if target.focused {
        payload.insert("focused".to_string(), Value::Bool(true));
    }
    if target.sensitive {
        payload.insert("sensitive".to_string(), Value::Bool(true));
    }
    if let Some(reason) = target.protected_reason.as_ref() {
        payload.insert("protectedReason".to_string(), Value::String(reason.clone()));
    }
    Value::Object(payload)
}

pub(crate) fn result_summary(method: &str, result: &Value) -> String {
    let status = result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let snapshot = result.get("snapshot").unwrap_or(&Value::Null);
    let page = snapshot
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .or_else(|| snapshot.get("url").and_then(Value::as_str))
        .map(|label| compact_label(label, 80))
        .unwrap_or_else(|| "current page".to_string());
    let target_count = snapshot
        .get("targets")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();

    match status {
        "unchanged" => format!("Page unchanged: {page}"),
        "stale_snapshot" if method == "web.read" => {
            format!("Page changed while reading; text offset reset: {page}")
        }
        "stale_snapshot" => format!("Page changed before the action: {page}"),
        "completed" => match method {
            "web.open" => format!("Opened {page} with {target_count} visible targets"),
            "web.read" => format!("Read {page} with {target_count} visible targets"),
            "web.act" => {
                format!("Web action completed on {page} with {target_count} visible targets")
            }
            _ => format!("Read {page} with {target_count} visible targets"),
        },
        other => format!("Web action returned {other}: {page}"),
    }
}

pub(crate) fn project_web_result_history(model_content: &mut String, retain_targets: bool) -> bool {
    let Ok(mut result) = serde_json::from_str::<Value>(model_content) else {
        return false;
    };
    let Some(snapshot) = result.get_mut("snapshot").and_then(Value::as_object_mut) else {
        return false;
    };
    if !snapshot.contains_key("targets") {
        return false;
    }
    if !retain_targets {
        snapshot.remove("targets");
        snapshot.remove("targetsTruncated");
        snapshot.insert("targetsSuperseded".to_string(), Value::Bool(true));
        *model_content = result.to_string();
    }
    true
}

fn compact_label(label: &str, max_chars: usize) -> String {
    let mut characters = label.trim().chars();
    let compact = characters.by_ref().take(max_chars).collect::<String>();
    if characters.next().is_some() {
        format!("{compact}…")
    } else {
        compact
    }
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

fn optional_usize(value: &Value, key: &str) -> Result<Option<usize>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|number| usize::try_from(number).ok())
            .map(Some)
            .ok_or_else(|| format!("{key} must be a non-negative integer")),
        Some(_) => Err(format!("{key} must be a non-negative integer")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn semantic_node(index: usize) -> BrowserSemanticNode {
        BrowserSemanticNode {
            target_ref: format!("target-4-{index}"),
            role: "button".to_string(),
            name: "Open account settings".to_string(),
            frame: "top".to_string(),
            x: 10.0,
            y: index as f64 * 30.0,
            width: 180.0,
            height: 28.0,
            disabled: false,
            focused: false,
            sensitive: false,
            protected_reason: None,
        }
    }

    #[test]
    fn agent_target_payload_omits_geometry_and_default_state() {
        let payload = snapshot_target_payload(&semantic_node(7));

        assert_eq!(payload["targetRef"], "target-4-7");
        assert_eq!(payload["role"], "button");
        assert_eq!(payload["name"], "Open account settings");
        for omitted in [
            "x",
            "y",
            "width",
            "height",
            "frame",
            "disabled",
            "focused",
            "sensitive",
            "protectedReason",
        ] {
            assert!(
                payload.get(omitted).is_none(),
                "unexpected field: {omitted}"
            );
        }
    }

    #[test]
    fn agent_target_payload_preserves_non_default_safety_state() {
        let mut target = semantic_node(2);
        target.frame = "child".to_string();
        target.disabled = true;
        target.focused = true;
        target.sensitive = true;
        target.protected_reason = Some("native_file_picker".to_string());

        let payload = snapshot_target_payload(&target);

        assert_eq!(payload["frame"], "child");
        assert_eq!(payload["disabled"], true);
        assert_eq!(payload["focused"], true);
        assert_eq!(payload["sensitive"], true);
        assert_eq!(payload["protectedReason"], "native_file_picker");
    }

    #[test]
    fn compact_targets_are_materially_smaller_than_native_nodes() {
        let nodes = (0..MAX_AGENT_SNAPSHOT_TARGETS)
            .map(semantic_node)
            .collect::<Vec<_>>();
        let compact = nodes
            .iter()
            .map(snapshot_target_payload)
            .collect::<Vec<_>>();
        let native_chars = serde_json::to_string(&nodes).unwrap().chars().count();
        let compact_chars = serde_json::to_string(&compact).unwrap().chars().count();

        assert!(compact_chars * 2 < native_chars);
    }

    #[test]
    fn page_content_is_untrusted_bounded_and_continuable() {
        let first = page_content_payload(&BrowserAgentPageText {
            text_offset: 0,
            text: "A".repeat(MAX_AGENT_PAGE_TEXT_CHARS),
            next_text_offset: Some(MAX_AGENT_PAGE_TEXT_CHARS),
            source_truncated: false,
        })
        .unwrap();
        let continued = page_content_payload(&BrowserAgentPageText {
            text_offset: MAX_AGENT_PAGE_TEXT_CHARS,
            text: "tail".to_string(),
            next_text_offset: None,
            source_truncated: false,
        })
        .unwrap();

        assert_eq!(first["trust"], "untrusted");
        assert_eq!(first["text"].as_str().unwrap().chars().count(), 8_000);
        assert_eq!(first["truncated"], true);
        assert_eq!(first["nextTextOffset"], 8_000);
        assert_eq!(continued["trust"], "untrusted");
        assert_eq!(continued["textOffset"], 8_000);
        assert_eq!(continued["text"], "tail");
        assert!(continued.get("nextTextOffset").is_none());
        assert!(continued.get("truncated").is_none());
    }

    #[test]
    fn page_content_reports_native_extraction_limit() {
        let content = page_content_payload(&BrowserAgentPageText {
            text_offset: 0,
            text: "bounded source".to_string(),
            next_text_offset: None,
            source_truncated: true,
        })
        .unwrap();

        assert_eq!(content["truncated"], true);
        assert_eq!(content["sourceTruncated"], true);
        assert!(content.get("nextTextOffset").is_none());
    }

    #[test]
    fn text_offset_requires_a_non_negative_integer() {
        assert_eq!(
            optional_usize(&json!({ "textOffset": 12 }), "textOffset"),
            Ok(Some(12))
        );
        assert!(optional_usize(&json!({ "textOffset": -1 }), "textOffset").is_err());
        assert!(optional_usize(&json!({ "textOffset": 1.5 }), "textOffset").is_err());
        assert!(optional_usize(&json!({ "textOffset": "12" }), "textOffset").is_err());
    }

    #[test]
    fn web_result_summary_is_short_and_status_specific() {
        let opened = json!({
            "status": "completed",
            "snapshot": {
                "title": "Account settings",
                "targets": [{}, {}, {}]
            }
        });
        let unchanged = json!({ "status": "unchanged" });
        let reset = json!({
            "status": "stale_snapshot",
            "snapshot": { "title": "Updated article" }
        });

        assert_eq!(
            result_summary("web.open", &opened),
            "Opened Account settings with 3 visible targets"
        );
        assert_eq!(
            result_summary("web.read", &unchanged),
            "Page unchanged: current page"
        );
        assert_eq!(
            result_summary("web.read", &reset),
            "Page changed while reading; text offset reset: Updated article"
        );
    }

    #[test]
    fn superseded_history_projection_only_removes_targets() {
        let mut content = json!({
            "status": "completed",
            "snapshot": {
                "url": "https://example.com",
                "targets": [{ "targetRef": "target-1", "role": "button", "name": "Save" }],
                "targetsTruncated": false,
                "content": { "trust": "untrusted", "text": "Important page text" }
            }
        })
        .to_string();

        assert!(project_web_result_history(&mut content, false));
        let projected: Value = serde_json::from_str(&content).unwrap();
        assert!(projected["snapshot"].get("targets").is_none());
        assert!(projected["snapshot"].get("targetsTruncated").is_none());
        assert_eq!(projected["snapshot"]["targetsSuperseded"], true);
        assert_eq!(
            projected["snapshot"]["content"]["text"],
            "Important page text"
        );
    }
}
