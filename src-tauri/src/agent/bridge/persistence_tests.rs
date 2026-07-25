use super::materialized_turn_messages;

#[test]
fn materialized_turn_messages_preserve_frontend_user_content_verbatim() {
    let content = "# Files mentioned by the user:\n\n## notes.md: C:\\Users\\tester\\notes.md\n\n## My request for Tinybot:\nReview this file\n";
    let messages = materialized_turn_messages(
        &serde_json::json!({
            "messages": [{
                "role": "user",
                "content": content,
                "clientEventId": "client-1"
            }]
        }),
        "turn-1",
    );

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], content);
}
