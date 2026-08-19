use super::config::{load_catalog_snapshot, load_resolved_hooks};
use super::managed::ManagedHookLanguage;
use super::runner::apply_json_output;
use super::{
    archive_managed_hook, compile_matcher, read_managed_hook_script, save_managed_hook,
    set_hook_trusted, test_managed_hook, write_managed_hook_script, CommandHookEngine,
    CommandHookEvent, CommandHookRequest, CommandHookRunResult, ManagedHookDraft,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "tinybot-command-hooks-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("test directory should be created");
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn config_is_untrusted_until_exact_definition_hash_is_approved() {
    let root = TestDirectory::new("trust");
    let data_root = root.path().join("data");
    let workspace_root = root.path().join("workspace");
    fs::create_dir_all(&data_root).expect("data root should be created");
    fs::create_dir_all(workspace_root.join(".tinybot"))
        .expect("workspace hook directory should be created");
    let config_path = workspace_root.join(".tinybot").join("hooks.json");
    fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "^workspace\\.",
                    "hooks": [{ "type": "command", "command": "check-tool" }]
                }]
            }
        }))
        .expect("hook config should serialize"),
    )
    .expect("hook config should be written");

    let initial =
        load_resolved_hooks(&data_root, &workspace_root).expect("hook config should load");
    assert_eq!(initial.hooks.len(), 1);
    assert!(!initial.hooks[0].trusted);
    let original_hash = initial.hooks[0].hash.clone();

    set_hook_trusted(&data_root, &workspace_root, &original_hash, true)
        .expect("configured hook should be trusted");
    let trusted =
        load_resolved_hooks(&data_root, &workspace_root).expect("trusted hook config should load");
    assert!(trusted.hooks[0].trusted);

    fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "^workspace\\.",
                    "hooks": [{ "type": "command", "command": "different-check-tool" }]
                }]
            }
        }))
        .expect("changed hook config should serialize"),
    )
    .expect("changed hook config should be written");
    let changed =
        load_resolved_hooks(&data_root, &workspace_root).expect("changed hook config should load");
    assert_ne!(changed.hooks[0].hash, original_hash);
    assert!(!changed.hooks[0].trusted);
}

#[test]
fn catalog_creates_commented_templates_without_overwriting_user_edits() {
    let root = TestDirectory::new("templates");
    let data_root = root.path().join("data");
    let workspace_root = root.path().join("workspace");
    fs::create_dir_all(&workspace_root).expect("workspace root should be created");

    let snapshot = load_catalog_snapshot(&data_root, &workspace_root)
        .expect("hook catalog and templates should load");
    let config_template =
        fs::read_to_string(&snapshot.template_config_path).expect("config template should exist");
    assert!(config_template.contains("// \"UserPromptSubmit\""));
    assert!(config_template.contains("// \"PreToolUse\""));
    assert!(config_template.contains("// \"PostToolUse\""));
    assert!(config_template.contains("// \"PostCompact\""));
    assert!(
        fs::metadata(snapshot.template_scripts_path.join("hook-template.ps1")).is_ok(),
        "PowerShell template should exist"
    );
    assert!(
        fs::metadata(snapshot.template_scripts_path.join("hook-template.sh")).is_ok(),
        "shell template should exist"
    );

    fs::write(&snapshot.template_config_path, "user-owned template")
        .expect("template should be editable");
    load_catalog_snapshot(&data_root, &workspace_root)
        .expect("catalog reload should preserve templates");
    assert_eq!(
        fs::read_to_string(&snapshot.template_config_path)
            .expect("template should remain readable"),
        "user-owned template"
    );
}

#[test]
fn managed_hook_save_owns_configuration_but_preserves_the_user_script() {
    let root = TestDirectory::new("managed");
    let data_root = root.path().join("data");
    let workspace_root = root.path().join("workspace");
    fs::create_dir_all(&workspace_root).expect("workspace root should be created");

    let id = save_managed_hook(
        &workspace_root,
        ManagedHookDraft {
            id: None,
            name: "Protect files".to_string(),
            event: "PreToolUse".to_string(),
            matcher: Some("^workspace\\.".to_string()),
            language: ManagedHookLanguage::Powershell,
            enabled: true,
            timeout: 30,
        },
    )
    .expect("managed hook should be saved");
    assert_eq!(id, "protect-files");

    let snapshot = load_catalog_snapshot(&data_root, &workspace_root)
        .expect("managed hook should appear in the catalog");
    assert_eq!(snapshot.hooks.len(), 1);
    let hook = &snapshot.hooks[0];
    assert!(hook.enabled);
    assert!(!hook.trusted);
    assert_eq!(hook.event, "PreToolUse");
    assert_eq!(hook.matcher.as_deref(), Some("^workspace\\."));
    let managed = hook.managed.as_ref().expect("hook should be managed");
    assert_eq!(managed.id, id);
    assert_eq!(managed.name, "Protect files");
    assert!(managed.script_path.ends_with("hook.ps1"));
    set_hook_trusted(&data_root, &workspace_root, &hook.hash, true)
        .expect("managed hook should be trusted for testing");
    let tested =
        tauri::async_runtime::block_on(test_managed_hook(&data_root, &workspace_root, &id))
            .expect("trusted managed script should run with sample input");
    assert_eq!(tested.decision, "continue");
    assert!(tested.failure.is_none());

    fs::write(&managed.script_path, "# user-owned script")
        .expect("managed script should be editable");
    save_managed_hook(
        &workspace_root,
        ManagedHookDraft {
            id: Some(id),
            name: "Protect workspace files".to_string(),
            event: "PostToolUse".to_string(),
            matcher: Some("*".to_string()),
            language: ManagedHookLanguage::Powershell,
            enabled: false,
            timeout: 45,
        },
    )
    .expect("managed hook should be updated");
    assert_eq!(
        fs::read_to_string(&managed.script_path).expect("script should remain readable"),
        "# user-owned script"
    );
    let updated = load_catalog_snapshot(&data_root, &workspace_root)
        .expect("updated managed hook should load");
    assert_eq!(updated.hooks[0].event, "PostToolUse");
    assert!(!updated.hooks[0].enabled);
    assert_eq!(updated.hooks[0].timeout, 45);
    let script = read_managed_hook_script(&workspace_root, "protect-files")
        .expect("managed script should open in the editor");
    assert_eq!(script.contents, "# user-owned script");
    let saved = write_managed_hook_script(
        &workspace_root,
        "protect-files",
        "# edited in Tinybot\n",
        &script.revision,
    )
    .expect("managed script should save through the editor");
    assert_eq!(saved.contents, "# edited in Tinybot\n");
    assert_ne!(saved.revision, script.revision);
    let conflict = write_managed_hook_script(
        &workspace_root,
        "protect-files",
        "# stale edit\n",
        &script.revision,
    )
    .expect_err("stale editor content must not overwrite a newer script");
    assert!(conflict.contains("changed on disk"));
    set_hook_trusted(&data_root, &workspace_root, &updated.hooks[0].hash, true)
        .expect("disabled definition may retain trust for later re-enabling");
    let evaluation = tauri::async_runtime::block_on(
        CommandHookEngine::load(&data_root, &workspace_root).evaluate(&CommandHookRequest {
            event: CommandHookEvent::PostToolUse,
            session_id: "session-managed".to_string(),
            turn_id: "turn-managed".to_string(),
            model: "test-model".to_string(),
            permission_mode: "local-worker".to_string(),
            prompt: None,
            tool_name: Some("workspace.read_file".to_string()),
            tool_match_names: vec!["workspace.read_file".to_string()],
            tool_use_id: Some("call-managed".to_string()),
            tool_input: Some(json!({ "path": "README.md" })),
            tool_response: Some(json!({ "content": "test" })),
            trigger: None,
        }),
    );
    assert!(
        evaluation.runs.is_empty(),
        "disabled hooks must not execute"
    );
    let archived =
        archive_managed_hook(&workspace_root, "protect-files").expect("hook should be archived");
    assert!(archived.starts_with(workspace_root.join(".tinybot").join("hooks-archive")));
    assert!(archived.join("hook.json").is_file());
    assert!(!workspace_root
        .join(".tinybot")
        .join("hooks")
        .join("protect-files")
        .exists());
}

#[test]
fn unsupported_async_handlers_are_reported_and_skipped() {
    let root = TestDirectory::new("async");
    let data_root = root.path().join("data");
    let workspace_root = root.path().join("workspace");
    fs::create_dir_all(&data_root).expect("data root should be created");
    fs::create_dir_all(&workspace_root).expect("workspace root should be created");
    fs::write(
        data_root.join("hooks.json"),
        serde_json::to_vec_pretty(&json!({
            "hooks": {
                "PostCompact": [{
                    "hooks": [{ "type": "command", "command": "notify", "async": true }]
                }]
            }
        }))
        .expect("hook config should serialize"),
    )
    .expect("hook config should be written");

    let loaded = load_resolved_hooks(&data_root, &workspace_root).expect("hook config should load");
    assert!(loaded.hooks.is_empty());
    assert_eq!(loaded.diagnostics.len(), 1);
    assert_eq!(loaded.diagnostics[0].code, "hook_async_unsupported");
}

#[test]
fn pre_tool_output_can_replace_input_or_deny() {
    let mut replaced = CommandHookRunResult::default();
    apply_json_output(
        &mut replaced,
        CommandHookEvent::PreToolUse,
        &json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": { "path": "reviewed.md" }
            }
        }),
        10_000,
    )
    .expect("valid replacement output should be accepted");
    assert_eq!(
        replaced.updated_input,
        Some(json!({ "path": "reviewed.md" }))
    );
    assert_eq!(replaced.decision, "replace_input");

    let mut denied = CommandHookRunResult::default();
    apply_json_output(
        &mut denied,
        CommandHookEvent::PreToolUse,
        &json!({
            "hookSpecificOutput": {
                "permissionDecision": "deny",
                "permissionDecisionReason": "policy rejected this tool"
            }
        }),
        10_000,
    )
    .expect("valid deny output should be accepted");
    assert_eq!(
        denied.denied_reason.as_deref(),
        Some("policy rejected this tool")
    );
    assert_eq!(denied.decision, "deny");
}

#[test]
fn matcher_uses_regular_expression_syntax() {
    let matcher = compile_matcher(Some("^(workspace\\.|shell_command$)"))
        .expect("matcher should compile")
        .expect("matcher should not be wildcard");
    assert!(matcher.is_match("workspace.read_file"));
    assert!(matcher.is_match("shell_command"));
    assert!(!matcher.is_match("web.search"));
}

#[test]
fn trusted_command_hook_runs_with_json_input_and_output() {
    let root = TestDirectory::new("runner");
    let data_root = root.path().join("data");
    let workspace_root = root.path().join("workspace");
    fs::create_dir_all(&data_root).expect("data root should be created");
    fs::create_dir_all(&workspace_root).expect("workspace root should be created");
    #[cfg(windows)]
    let (command, command_windows) = {
        let script = workspace_root.join("hook.cmd");
        fs::write(
            &script,
            "@echo off\r\necho {\"hookSpecificOutput\":{\"permissionDecision\":\"allow\",\"updatedInput\":{\"path\":\"after.md\"}}}\r\n",
        )
        .expect("Windows hook script should be written");
        ("unused-on-windows".to_string(), "call hook.cmd".to_string())
    };
    #[cfg(not(windows))]
    let (command, command_windows) = {
        let script = workspace_root.join("hook.sh");
        fs::write(
            &script,
            "cat >/dev/null\nprintf '%s\\n' '{\"hookSpecificOutput\":{\"permissionDecision\":\"allow\",\"updatedInput\":{\"path\":\"after.md\"}}}'\n",
        )
        .expect("Unix hook script should be written");
        ("sh ./hook.sh".to_string(), String::new())
    };
    fs::write(
        data_root.join("hooks.json"),
        serde_json::to_vec_pretty(&json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "^workspace\\.read_file$",
                    "hooks": [{
                        "type": "command",
                        "command": command,
                        "commandWindows": command_windows
                    }]
                }]
            }
        }))
        .expect("hook config should serialize"),
    )
    .expect("hook config should be written");
    let loaded = load_resolved_hooks(&data_root, &workspace_root)
        .expect("hook config should load before trusting");
    let hash = loaded.hooks[0].hash.clone();
    set_hook_trusted(&data_root, &workspace_root, &hash, true)
        .expect("configured hook should be trusted");
    let engine = CommandHookEngine::load(&data_root, &workspace_root);
    let evaluation = tauri::async_runtime::block_on(engine.evaluate(&CommandHookRequest {
        event: CommandHookEvent::PreToolUse,
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        model: "test-model".to_string(),
        permission_mode: "local-worker".to_string(),
        prompt: None,
        tool_name: Some("workspace.read_file".to_string()),
        tool_match_names: vec!["workspace.read_file".to_string()],
        tool_use_id: Some("call-1".to_string()),
        tool_input: Some(json!({ "path": "before.md" })),
        tool_response: None,
        trigger: None,
    }));

    assert_eq!(evaluation.runs.len(), 1);
    assert_eq!(
        evaluation.runs[0].updated_input,
        Some(json!({ "path": "after.md" })),
        "hook run: {:?}",
        evaluation.runs[0]
    );
    assert_eq!(evaluation.runs[0].decision, "replace_input");
    assert!(evaluation.runs[0].failure.is_none());
}

#[test]
fn event_specific_stop_outputs_are_mapped_without_rolling_back_tools() {
    let mut post_tool = CommandHookRunResult::default();
    apply_json_output(
        &mut post_tool,
        CommandHookEvent::PostToolUse,
        &json!({ "continue": false, "stopReason": "review the generated file" }),
        10_000,
    )
    .expect("PostToolUse stop output should be accepted");
    assert_eq!(
        post_tool.tool_feedback.as_deref(),
        Some("review the generated file")
    );

    let mut post_compact = CommandHookRunResult::default();
    apply_json_output(
        &mut post_compact,
        CommandHookEvent::PostCompact,
        &json!({ "continue": false, "stopReason": "compaction policy stopped the turn" }),
        10_000,
    )
    .expect("PostCompact stop output should be accepted");
    assert_eq!(
        post_compact.denied_reason.as_deref(),
        Some("compaction policy stopped the turn")
    );
}
