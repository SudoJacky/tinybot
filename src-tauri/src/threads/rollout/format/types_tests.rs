use super::*;
use serde_json::json;

#[test]
fn rollout_line_serializes_codex_compatible_session_meta() {
    let line = RolloutLine {
        timestamp: "2026-07-08T10:12:30Z".to_string(),
        ordinal: None,
        item: RolloutItem::SessionMeta(SessionMeta {
            schema_version: ROLLOUT_SCHEMA_VERSION,
            thread_id: "thread-1".to_string(),
            session_id: Some("session-1".to_string()),
            created_at: "2026-07-08T10:12:30Z".to_string(),
            cwd: "D:/code/tinybot/tinybot".to_string(),
            source: "desktop".to_string(),
            model_provider: Some("deepseek".to_string()),
            model: Some("deepseek-v4-pro".to_string()),
            base_instructions: Some(json!({"text": "base"})),
            history_mode: Some("default".to_string()),
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: Some("Tinybot Desktop".to_string()),
        }),
    };

    let value = serde_json::to_value(line).unwrap();
    assert_eq!(value["type"], "session_meta");
    assert_eq!(value["payload"]["id"], "thread-1");
    assert_eq!(value["payload"]["session_id"], "session-1");
    assert_eq!(value["payload"]["timestamp"], "2026-07-08T10:12:30Z");
    assert_eq!(value["payload"]["model_provider"], "deepseek");
    assert!(value["payload"].get("schemaVersion").is_none());
    assert!(value["payload"].get("schema_version").is_none());
    assert!(value["payload"].get("threadId").is_none());
    assert!(value["payload"].get("createdAt").is_none());
    assert!(value["payload"].get("model").is_none());
}

#[test]
fn session_meta_reads_codex_wire_keys_without_a_tinybot_schema_field() {
    let meta = serde_json::from_value::<SessionMeta>(json!({
        "id": "thread-codex",
        "session_id": "session-codex",
        "timestamp": "2026-07-08T10:12:30Z",
        "cwd": "D:/workspace",
        "source": "desktop",
        "forked_from_id": "thread-parent"
    }))
    .unwrap();

    assert_eq!(meta.schema_version, ROLLOUT_SCHEMA_VERSION);
    assert_eq!(meta.thread_id, "thread-codex");
    assert_eq!(meta.session_id.as_deref(), Some("session-codex"));
    assert_eq!(meta.forked_from_thread_id.as_deref(), Some("thread-parent"));
}

#[test]
fn turn_context_serializes_with_codex_snake_case_keys() {
    let context = TurnContextItem {
        turn_id: "turn-1".to_string(),
        cwd: "D:/workspace".to_string(),
        workspace_roots: Some(vec!["D:/workspace".to_string()]),
        current_date: Some("2026-07-20".to_string()),
        timezone: Some("Asia/Singapore".to_string()),
        approval_policy: json!("on_request"),
        sandbox_policy: json!("workspace_write"),
        permission_profile: Some(json!({"name": "default"})),
        network: Some(json!({"enabled": true})),
        model: "deepseek-v4-pro".to_string(),
        provider: Some("deepseek".to_string()),
        comp_hash: Some("hash".to_string()),
        personality: None,
        collaboration_mode: None,
        effort: Some(json!("high")),
        summary: json!("auto"),
    };

    let value = serde_json::to_value(context).unwrap();
    assert_eq!(value["turn_id"], "turn-1");
    assert_eq!(value["workspace_roots"][0], "D:/workspace");
    assert_eq!(value["approval_policy"], "on_request");
    assert_eq!(value["sandbox_policy"], "workspace_write");
    assert_eq!(value["comp_hash"], "hash");
    assert!(value.get("turnId").is_none());
    assert!(value.get("workspaceRoots").is_none());
    assert!(value.get("approvalPolicy").is_none());
}

#[test]
fn typed_rollout_records_preserve_wire_values_and_discriminants() {
    let known_raw = json!({
        "type": "turn_started",
        "payload": {"turnId": "turn-1", "turnId": "turn-1"}
    });
    let known = EventMsg::from_value(known_raw.clone()).unwrap();
    assert_eq!(known.kind(), &EventKind::TurnStarted);
    assert!(known.kind().starts_turn());
    assert_eq!(serde_json::to_value(known).unwrap(), known_raw);

    let legacy_raw = json!({
        "type": "future_event",
        "payload": {"newField": true}
    });
    assert_eq!(
        EventMsg::from_value(legacy_raw).unwrap_err(),
        "unsupported event_msg type `future_event`"
    );

    let response_raw = json!({
        "type": "message",
        "role": "assistant",
        "content": "hello"
    });
    let response = ResponseItem::from_value(response_raw.clone()).unwrap();
    assert_eq!(response.kind(), &ResponseItemKind::Message);
    assert_eq!(response.role(), Some(&ResponseRole::Assistant));
    assert_eq!(serde_json::to_value(response).unwrap(), response_raw);
}

#[test]
fn compacted_item_restores_window_lineage_without_rewriting_wire_value() {
    let raw = json!({
        "replacementHistory": [{"role": "assistant", "content": "summary"}],
        "windowNumber": 3,
        "firstWindowId": "window-1",
        "previousWindowId": "window-2",
        "windowId": "window-3"
    });
    let compacted = CompactedItem::from_value(raw.clone()).unwrap();

    assert_eq!(compacted.window_number(), Some(3));
    assert_eq!(compacted.first_window_id(), Some("window-1"));
    assert_eq!(compacted.previous_window_id(), Some("window-2"));
    assert_eq!(compacted.window_id(), Some("window-3"));
    assert_eq!(compacted.replacement_history().unwrap().len(), 1);
    assert_eq!(serde_json::to_value(compacted).unwrap(), raw);
}

#[test]
fn typed_rollout_records_reject_invalid_shapes() {
    assert!(EventMsg::from_value(json!({"payload": {}}))
        .unwrap_err()
        .contains("type"));
    assert!(ResponseItem::from_value(json!("message"))
        .unwrap_err()
        .contains("object"));
    assert!(CompactedItem::from_value(json!({"windowNumber": "3"}))
        .unwrap_err()
        .contains("unsigned integer"));
    assert!(
        InterAgentCommunication::from_value(json!({"triggerTurn": "yes"}))
            .unwrap_err()
            .contains("boolean")
    );
}

#[test]
fn custom_tool_output_requires_the_slim_persisted_identity() {
    let output = json!({
        "type": "custom_tool_call_output",
        "id": "tool-output:call-1",
        "call_id": "call-1",
        "turnId": "turn-1",
        "output": "contents",
    });
    assert!(ResponseItem::from_value(output.clone()).is_ok());

    let mut missing_item_id = output.clone();
    missing_item_id.as_object_mut().unwrap().remove("id");
    assert!(ResponseItem::from_value(missing_item_id)
        .unwrap_err()
        .contains("item id"));

    let mut legacy_call_id = output;
    legacy_call_id.as_object_mut().unwrap().remove("call_id");
    legacy_call_id["callId"] = Value::String("call-1".to_string());
    assert!(ResponseItem::from_value(legacy_call_id)
        .unwrap_err()
        .contains("call output id"));
}
