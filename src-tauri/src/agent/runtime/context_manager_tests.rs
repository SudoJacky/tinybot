use super::*;
use serde_json::json;

#[test]
fn replace_bumps_history_version() {
    let mut history =
        ContextManager::from_legacy_messages(&[json!({"role": "user", "content": "one"})]).unwrap();

    history
        .replace(vec![json!({"role": "user", "content": "two"})])
        .unwrap();

    assert_eq!(history.history_version(), 1);
    assert_eq!(history.messages()[0]["content"], "two");
}

#[test]
fn prompt_requires_complete_tool_pairs() {
    let history = ContextManager::from_legacy_messages(&[json!({
        "role": "assistant",
        "content": null,
        "tool_calls": [{
            "id": "call-1",
            "type": "function",
            "function": {"name": "lookup", "arguments": "{}"}
        }]
    })])
    .unwrap();

    assert!(history.for_prompt().unwrap_err().contains("has no result"));
}

#[test]
fn prompt_accepts_complete_tool_pairs() {
    let history = ContextManager::from_legacy_messages(&[
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {"name": "lookup", "arguments": "{}"}
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call-1",
            "name": "lookup",
            "content": "done"
        }),
    ])
    .unwrap();

    assert_eq!(history.for_prompt().unwrap().len(), 2);
}

#[test]
fn token_info_tracks_total_and_last_model_call_usage() {
    let mut history = ContextManager::from_legacy_messages(&[]).unwrap();

    history.update_token_info(
        &json!({"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}),
        Some(128_000),
    );
    history.update_token_info(
        &json!({"input_tokens": 7, "output_tokens": 2, "total_tokens": 9}),
        Some(128_000),
    );

    let info = history.token_info().unwrap();
    assert_eq!(info.total_token_usage.total_tokens, 22);
    assert_eq!(info.total_token_usage.input_tokens, 17);
    assert_eq!(info.last_token_usage.total_tokens, 9);
    assert_eq!(info.model_context_window, Some(128_000));
}
