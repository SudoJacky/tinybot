use super::*;

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
