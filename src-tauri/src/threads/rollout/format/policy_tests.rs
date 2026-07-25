use super::*;
use crate::threads::rollout::format::ResponseItem;
use serde_json::json;

#[test]
fn policy_rejects_unknown_response_items() {
    let unknown_response = RolloutItem::ResponseItem(
        ResponseItem::from_value(json!({"type": "future_response"})).unwrap(),
    );

    assert!(should_persist_rollout_item(&unknown_response).is_err());
}
