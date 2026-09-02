use super::{finish_native_agent_turn, native_agent_ui_form_continuation_spec};

#[test]
fn form_continuation_preserves_thread_command_correlation() {
    let spec = native_agent_ui_form_continuation_spec(
        &serde_json::json!({
            "turnId": "turn-1",
            "sessionId": "thread-1",
            "threadId": "thread-1",
            "messages": [{ "role": "user", "content": "choose" }],
        }),
        &serde_json::json!({
            "commandId": "command-form-1",
            "source": { "control": "chat-form", "surface": "chat" },
            "target": {
                "sessionId": "thread-1",
                "threadId": "thread-1",
                "turnId": "turn-1",
            },
        }),
        "form-1",
        &serde_json::json!({ "target": "README.md" }),
        false,
    );

    assert_eq!(
        spec["metadata"]["_threadCommand"],
        serde_json::json!({
            "commandId": "command-form-1",
            "commandKind": "form.submit",
            "form": { "formId": "form-1" },
            "source": { "control": "chat-form", "surface": "chat" },
            "target": {
                "sessionId": "thread-1",
                "threadId": "thread-1",
                "turnId": "turn-1",
            },
        })
    );

    let cancelled_spec = native_agent_ui_form_continuation_spec(
        &serde_json::json!({ "turnId": "turn-1", "sessionId": "thread-1" }),
        &serde_json::json!({ "commandId": "command-form-cancel-1" }),
        "form-1",
        &serde_json::json!({}),
        true,
    );
    assert_eq!(
        cancelled_spec["metadata"]["_threadCommand"]["commandKind"],
        "form.cancel"
    );
}

#[test]
fn continuation_turn_reports_both_runtime_and_flush_failures() {
    let error = finish_native_agent_turn::<()>(
        Err("runtime failed".to_string()),
        Err("flush failed".to_string()),
        "native agent continuation",
    )
    .expect_err("both failures should be reported");

    assert_eq!(
        error,
        "native agent continuation failed: runtime failed; trace persistence flush failed: \
             flush failed"
    );
}
