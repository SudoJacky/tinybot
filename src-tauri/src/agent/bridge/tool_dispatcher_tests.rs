use super::{
    apply_turn_working_directory, native_tool_executor_model_content,
    native_tool_result_from_executor_response,
};
use crate::agent::runtime::{NativeAgentToolCall, PreparedToolCall};

#[test]
fn shell_process_output_uses_terminal_output_as_model_content() {
    let result = serde_json::json!({
        "processId": "process-1",
        "stdout": "first\nsecond\n",
        "stderr": "",
        "output": "first\nsecond\n",
        "chunks": [
            { "sequence": 1, "stream": "stdout", "content": "first\n" },
            { "sequence": 2, "stream": "stdout", "content": "second\n" }
        ]
    });

    let content = native_tool_executor_model_content(&result);
    let compact: serde_json::Value =
        serde_json::from_str(&content).expect("shell model content should remain structured");

    assert_eq!(compact["processId"], "process-1");
    assert_eq!(compact["output"], "first\nsecond\n");
    assert!(compact.get("stdout").is_none());
    assert!(compact.get("stderr").is_none());
    assert!(compact.get("chunks").is_none());
}

#[test]
fn executor_response_keeps_only_the_native_shell_result() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-1".to_string(),
        name: "exec_command".to_string(),
        arguments_json: r#"{"command":"dir /b"}"#.to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");
    let shell_result = serde_json::json!({
        "processId": "process-1",
        "status": "exited",
        "running": false,
        "exitCode": 0,
        "stdout": "first\nsecond\n",
        "stderr": "",
        "output": "first\nsecond\n",
        "chunks": [
            { "sequence": 1, "stream": "stdout", "content": "first\n" },
            { "sequence": 2, "stream": "stdout", "content": "second\n" }
        ],
        "cursor": 2,
        "truncated": false,
        "droppedBytes": 0
    });
    let executor_response = serde_json::json!({
        "toolId": "exec_command",
        "method": "shell.start",
        "permission": { "decision": "allow" },
        "result": shell_result
    });

    let result = native_tool_result_from_executor_response(&tool_call, executor_response)
        .expect("executor response should become a native result");
    let raw = &result.envelope["raw"];
    let model_content: serde_json::Value = serde_json::from_str(
        result.envelope["modelContent"]
            .as_str()
            .expect("model content should be a string"),
    )
    .expect("model content should be compact JSON");

    assert_eq!(model_content["output"], "first\nsecond\n");
    assert!(model_content.get("stdout").is_none());
    assert_eq!(raw, &shell_result);
    assert!(result.envelope["structured"].get("value").is_none());
    let serialized =
        serde_json::to_string(&result.envelope).expect("native result envelope should serialize");
    assert_eq!(serialized.matches("\"stdout\"").count(), 3);
    assert!(!serialized.contains("permission"));
    assert!(!serialized.contains("executor"));
}

#[test]
fn turn_working_directory_becomes_shell_default_without_overriding_tool_input() {
    let workspace = std::path::PathBuf::from("D:/workspace");
    let turn_directory = workspace.join("project").join("task");
    let mut defaulted = serde_json::json!({ "command": "pwd" });
    apply_turn_working_directory(
        Some(&turn_directory),
        "exec_command",
        &mut defaulted,
        &workspace,
    )
    .expect("turn working directory should become shell default");
    let mut explicit = serde_json::json!({
        "command": "pwd",
        "workingDir": "other"
    });
    apply_turn_working_directory(
        Some(&turn_directory),
        "shell.start",
        &mut explicit,
        &workspace,
    )
    .expect("explicit shell working directory should remain valid");

    assert_eq!(defaulted["workingDir"], "project/task");
    assert_eq!(explicit["workingDir"], "other");
}

#[test]
fn turn_working_directory_preserves_an_absolute_path_outside_the_workspace() {
    let workspace = std::path::PathBuf::from("D:/workspace");
    let mut arguments = serde_json::json!({ "command": "pwd" });

    apply_turn_working_directory(
        Some(std::path::Path::new("D:/outside")),
        "shell.execute",
        &mut arguments,
        &workspace,
    )
    .expect("outside turn working directory should reach shell dispatch");

    assert_eq!(arguments["workingDir"], "D:/outside");
}
