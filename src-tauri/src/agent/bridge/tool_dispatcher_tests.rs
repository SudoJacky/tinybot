use super::apply_turn_working_directory;

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
