use super::runtime_event_item;
use serde_json::json;

#[test]
fn persisted_runtime_event_item_uses_stable_event_identity() {
    let item = runtime_event_item(
        "thread-1",
        "turn-1",
        Some("approval-1".to_string()),
        Some("turn-1:agent-approval-decision:210".to_string()),
        Some(210),
        Some("2100".to_string()),
        "agent.approval.decision".to_string(),
        Some("user".to_string()),
        Some("user".to_string()),
        json!({ "approvalId": "approval-1" }),
    );

    assert_eq!(
        item.item_id,
        "thread-runtime:thread-1:turn-1:event-id:turn-1:agent-approval-decision:210"
    );
    let payload = match item.kind {
        crate::threads::domain::types::ThreadItemKind::Event(payload) => payload,
        kind => panic!("expected runtime event item, got {kind:?}"),
    };
    assert_eq!(payload["eventId"], "turn-1:agent-approval-decision:210");
    assert_eq!(payload["itemId"], "approval-1");
    assert_eq!(payload["sequence"], 210);
    assert_eq!(payload["timestamp"], "2100");
}
