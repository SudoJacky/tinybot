use super::{materialized_turn_messages, native_agent_turn_context};

#[test]
fn materialized_turn_messages_preserve_frontend_user_content_verbatim() {
    let content = "# Files mentioned by the user:\n\n## notes.md: C:\\Users\\tester\\notes.md\n\n## My request for Tinybot:\nReview this file\n";
    let request = super::super::turn_request::AgentTurnRequest::from_wire(
        serde_json::json!({
            "messages": [{
                "role": "user",
                "content": content,
                "clientEventId": "client-1"
            }]
        }),
        &serde_json::json!({}),
        &std::env::temp_dir(),
    )
    .unwrap();
    let messages = materialized_turn_messages(&request, "", "").unwrap();

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], content);
}

#[test]
fn manual_compaction_does_not_materialize_historical_user_messages() {
    let request = super::super::turn_request::AgentTurnRequest::from_wire(
        serde_json::json!({
            "contextCompaction": {
                "trigger": "manual",
                "reason": "user_requested",
                "phase": "standalone_turn"
            },
            "messages": [
                { "role": "user", "content": "historical question" },
                { "role": "assistant", "content": "historical answer" }
            ]
        }),
        &serde_json::json!({}),
        &std::env::temp_dir(),
    )
    .unwrap();
    let messages = materialized_turn_messages(&request, "", "").unwrap();

    assert!(messages.is_empty());
}

#[test]
fn persisted_turn_context_uses_only_explicit_reasoning_settings() {
    let explicit = native_agent_turn_context(
        &serde_json::json!({
            "reasoning": { "effort": "high", "summary": "detailed" }
        }),
        &serde_json::json!({
            "agents": { "defaults": { "reasoningEffort": "low" } }
        }),
        "turn-explicit",
    );
    let explicit = explicit.unwrap();
    assert_eq!(explicit.effort.unwrap(), "high");
    assert_eq!(explicit.summary, "detailed");

    let omitted = native_agent_turn_context(
        &serde_json::json!({}),
        &serde_json::json!({
            "agents": { "defaults": { "reasoningEffort": "low" } }
        }),
        "turn-omitted",
    );
    let omitted = omitted.unwrap();
    assert!(omitted.effort.is_none());
    assert_eq!(omitted.summary, "auto");
}
