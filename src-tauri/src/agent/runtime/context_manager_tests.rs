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
fn compaction_summary_round_trips_as_internal_assistant_and_provider_user_message() {
    let history = ContextManager::from_legacy_messages(&[json!({
        "role": "assistant",
        "content": "Conversation summary so far:\nfinished the first task",
        "contextCompaction": true
    })])
    .unwrap();

    let stored = history.messages();
    assert_eq!(stored[0]["role"], "assistant");
    assert_eq!(stored[0]["contextCompaction"], true);

    let prompt = history.for_prompt().unwrap();
    assert_eq!(prompt[0]["role"], "user");
    assert!(prompt[0].get("contextCompaction").is_none());
    assert!(prompt[0]["content"]
        .as_str()
        .is_some_and(|content| content.starts_with("Conversation summary so far:")));
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

#[test]
fn token_info_reads_cached_input_tokens_from_provider_details() {
    let mut history = ContextManager::from_legacy_messages(&[]).unwrap();

    history.update_token_info(
        &json!({
            "input_tokens": 4216,
            "input_tokens_details": { "cached_tokens": 4096 },
            "output_tokens": 60,
            "total_tokens": 4276
        }),
        Some(128_000),
    );

    let info = history.token_info().unwrap();
    assert_eq!(info.last_token_usage.cached_input_tokens, 4096);
    assert_eq!(info.total_token_usage.cached_input_tokens, 4096);
}

#[test]
fn token_info_reads_reasoning_output_tokens_from_provider_details() {
    let mut history = ContextManager::from_legacy_messages(&[]).unwrap();

    history.update_token_info(
        &json!({
            "input_tokens": 4130,
            "output_tokens": 81,
            "output_tokens_details": { "reasoning_tokens": 47 },
            "total_tokens": 4211
        }),
        Some(128_000),
    );

    let info = history.token_info().unwrap();
    assert_eq!(info.last_token_usage.reasoning_output_tokens, 47);
    assert_eq!(info.total_token_usage.reasoning_output_tokens, 47);
}

#[test]
fn prompt_only_keeps_targets_from_the_latest_web_snapshot() {
    let snapshot = |target_ref: &str, text: &str| {
        json!({
            "status": "completed",
            "snapshot": {
                "targets": [{ "targetRef": target_ref, "role": "button", "name": "Save" }],
                "targetsTruncated": false,
                "content": { "trust": "untrusted", "text": text }
            }
        })
        .to_string()
    };
    let history = ContextManager::from_legacy_messages(&[
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "call-old",
                "type": "function",
                "function": { "name": "web.read", "arguments": "{}" }
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call-old",
            "content": snapshot("target-old", "Older page text")
        }),
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "call-latest",
                "type": "function",
                "function": { "name": "web.act", "arguments": "{}" }
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call-latest",
            "content": snapshot("target-latest", "Latest page text")
        }),
    ])
    .unwrap();

    let prompt = history.for_prompt().unwrap();
    let old_result: Value = serde_json::from_str(prompt[1]["content"].as_str().unwrap()).unwrap();
    let latest_result: Value =
        serde_json::from_str(prompt[3]["content"].as_str().unwrap()).unwrap();

    assert!(old_result["snapshot"].get("targets").is_none());
    assert_eq!(old_result["snapshot"]["targetsSuperseded"], true);
    assert_eq!(old_result["snapshot"]["content"]["text"], "Older page text");
    assert_eq!(
        latest_result["snapshot"]["targets"][0]["targetRef"],
        "target-latest"
    );
    assert_eq!(
        history.messages()[1]["content"],
        snapshot("target-old", "Older page text")
    );
}
