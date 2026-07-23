use super::{apply_turn_working_directory, strip_browser_capture_data};

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
fn turn_working_directory_rejects_a_path_outside_the_workspace() {
    let workspace = std::path::PathBuf::from("D:/workspace");
    let mut arguments = serde_json::json!({ "command": "pwd" });

    let error = apply_turn_working_directory(
        Some(std::path::Path::new("D:/outside")),
        "shell.execute",
        &mut arguments,
        &workspace,
    )
    .expect_err("outside turn working directory must not reach shell dispatch");

    assert!(error.contains("outside workspace"));
}

#[test]
fn browser_capture_bytes_are_not_returned_to_the_model_context() {
    let mut result = serde_json::json!({
        "capture": { "captureId": "capture-1", "dataUrl": "data:image/png;base64,AAAA" },
        "snapshot": {
            "data": {
                "tabs": [{ "captures": [{ "captureId": "capture-1", "dataUrl": "data:image/png;base64,BBBB" }] }]
            }
        }
    });

    strip_browser_capture_data(&mut result);

    assert_eq!(result["capture"]["captureId"], "capture-1");
    assert!(result["capture"].get("dataUrl").is_none());
    assert!(result["snapshot"]["data"]["tabs"][0]["captures"][0]
        .get("dataUrl")
        .is_none());
}
