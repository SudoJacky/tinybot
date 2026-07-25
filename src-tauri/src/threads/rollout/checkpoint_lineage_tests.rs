use super::*;

#[test]
fn creates_and_advances_context_window_chain() {
    let first = next_context_window("session-1", "context-1", None);
    assert_eq!(
        first,
        ContextWindowLineage {
            source_context_id: None,
            window_number: 1,
            first_window_id: "session-1:context-window:0".to_string(),
            previous_window_id: "session-1:context-window:0".to_string(),
            window_id: "context-1".to_string(),
        }
    );
    let first_checkpoint = json!({
        "contextId": "context-1",
        "windowNumber": first.window_number,
        "firstWindowId": first.first_window_id,
        "previousWindowId": first.previous_window_id,
        "windowId": first.window_id,
    });

    let second = next_context_window("session-1", "context-2", Some(&first_checkpoint));
    assert_eq!(second.source_context_id.as_deref(), Some("context-1"));
    assert_eq!(second.window_number, 2);
    assert_eq!(second.first_window_id, "session-1:context-window:0");
    assert_eq!(second.previous_window_id, "context-1");
    assert_eq!(second.window_id, "context-2");
}

#[test]
fn legacy_parent_checkpoint_becomes_window_zero_baseline() {
    let lineage = next_context_window(
        "session-1",
        "context-2",
        Some(&json!({ "contextId": "legacy-context" })),
    );

    assert_eq!(lineage.window_number, 1);
    assert_eq!(lineage.first_window_id, "legacy-context");
    assert_eq!(lineage.previous_window_id, "legacy-context");
}

#[test]
fn validates_source_and_window_successor_together() {
    let current = json!({
        "contextId": "context-1",
        "windowNumber": 1,
        "firstWindowId": "session-1:context-window:0",
        "previousWindowId": "session-1:context-window:0",
        "windowId": "context-1",
    });
    let valid = json!({
        "contextId": "context-2",
        "sourceContextId": "context-1",
        "windowNumber": 2,
        "firstWindowId": "session-1:context-window:0",
        "previousWindowId": "context-1",
        "windowId": "context-2",
    });
    validate_context_checkpoint_successor("session-1", Some(&current), &valid).unwrap();

    let mut stale = valid.clone();
    stale["sourceContextId"] = json!("older");
    let error =
        validate_context_checkpoint_successor("session-1", Some(&current), &stale).unwrap_err();
    assert_eq!(error.field, SOURCE_CONTEXT_ID);

    let mut skipped = valid;
    skipped["windowNumber"] = json!(3);
    let error =
        validate_context_checkpoint_successor("session-1", Some(&current), &skipped).unwrap_err();
    assert_eq!(error.field, WINDOW_NUMBER);

    let snake_case = json!({
        "context_id": "context-2",
        "source_context_id": "context-1",
        "window_number": 2,
        "first_window_id": "session-1:context-window:0",
        "previous_window_id": "context-1",
        "window_id": "context-2",
    });
    validate_context_checkpoint_successor("session-1", Some(&current), &snake_case).unwrap();

    let missing_source = json!({
        "contextId": "context-2",
        "replacementHistory": [],
    });
    let error = validate_context_checkpoint_successor("session-1", Some(&current), &missing_source)
        .unwrap_err();
    assert_eq!(error.field, SOURCE_CONTEXT_ID);
}
