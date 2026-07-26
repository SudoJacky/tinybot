use super::*;

fn raw_tool_call(arguments_json: &str) -> super::super::NativeAgentToolCall {
    super::super::NativeAgentToolCall {
        id: "call-prepared".to_string(),
        name: "workspace.read_file".to_string(),
        arguments_json: arguments_json.to_string(),
        result: Value::Null,
    }
}

#[test]
fn prepared_tool_call_preserves_raw_json_and_exposes_one_object() {
    let arguments_json = " { \"path\" : \"README.md\" } ";
    let prepared =
        PreparedToolCall::prepare(raw_tool_call(arguments_json)).expect("arguments should prepare");

    assert_eq!(prepared.arguments_json, arguments_json);
    assert_eq!(
        prepared.arguments_value(),
        serde_json::json!({ "path": "README.md" })
    );
}

#[test]
fn prepared_tool_call_rejects_invalid_or_non_object_arguments() {
    for (arguments_json, expected) in [
        ("{", "arguments are invalid JSON"),
        ("[]", "arguments must be a JSON object"),
    ] {
        let error = PreparedToolCall::prepare(raw_tool_call(arguments_json))
            .expect_err("invalid arguments should fail preparation");
        assert!(
            error.contains(expected),
            "expected `{expected}` in `{error}`"
        );
    }
}

#[test]
fn removed_workspace_list_files_alias_is_not_permitted() {
    let context = AgentTurnContext::from_spec(
        serde_json::json!({
            "turnId": "turn-no-list-alias",
            "sessionId": "session-no-list-alias",
            "messages": [{ "role": "user", "content": "list files" }]
        }),
        serde_json::json!({}),
    );

    assert!(!native_tool_is_permitted(&context, "workspace.list_files"));
}

#[test]
fn shell_read_only_allowlist_rejects_chained_commands() {
    assert!(!shell_command_is_read_only_allowlisted(
        "git status & touch workspace-marker"
    ));
}
