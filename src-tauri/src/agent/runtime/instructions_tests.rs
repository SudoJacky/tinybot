use super::*;

#[test]
fn allows_a_working_directory_outside_the_workspace_root() {
    let fixture = InstructionFixture::new("outside-working-directory");
    let outside = fixture.root.with_extension("outside");
    fs::create_dir_all(&outside).expect("outside working directory fixture should create");

    let composed = InstructionComposer::default()
        .compose(
            &fixture.root,
            &serde_json::json!({ "workingDirectory": &outside }),
        )
        .expect("working directory outside workspace should be allowed");
    assert_eq!(composed.working_directory, outside);
    fs::remove_dir_all(&outside).expect("outside working directory fixture should clean up");
}

#[test]
fn reports_truncation_and_invalid_utf8_without_hiding_the_source() {
    let fixture = InstructionFixture::new("diagnostics");
    fs::create_dir_all(fixture.root.join(".git")).expect("project marker should create");
    fs::write(
        fixture.root.join(PROJECT_INSTRUCTION_FILE_NAME),
        b"abc\xFFdef",
    )
    .expect("invalid UTF-8 project instructions should write");
    let composer = InstructionComposer {
        project_instruction_max_bytes: 5,
        ..InstructionComposer::default()
    };

    let composed = composer
        .compose(&fixture.root, &serde_json::json!({ "cwd": fixture.root }))
        .expect("lossy project instructions should compose with diagnostics");

    let project = composed
        .sources
        .iter()
        .find(|source| source.kind == InstructionSourceKind::ProjectAgents)
        .expect("project instructions should have provenance");
    assert!(project.truncated);
    assert_eq!(project.validation_warnings.len(), 2);
    assert_eq!(composed.diagnostics().len(), 2);
    assert!(composed.rendered_prompt().contains("abc"));
}

#[test]
fn composes_editable_workspace_identity_user_and_tool_instructions() {
    let fixture = InstructionFixture::new("workspace-profile");
    fs::write(fixture.root.join("SOUL.md"), "Keep a calm, direct voice.\n")
        .expect("assistant identity instructions should write");
    fs::write(
        fixture.root.join("USER.md"),
        "The user prefers concise answers.\n",
    )
    .expect("user instructions should write");
    fs::write(
        fixture.root.join("TOOLS.md"),
        "Inspect real files before reporting success.\n",
    )
    .expect("tool instructions should write");

    let composed = InstructionComposer::default()
        .compose(&fixture.root, &serde_json::json!({ "cwd": fixture.root }))
        .expect("editable workspace instructions should compose");

    let identifiers = composed
        .sources
        .iter()
        .map(|source| {
            Path::new(&source.identifier)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&source.identifier)
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        identifiers,
        [
            "builtin:identity",
            "SYSTEM.md",
            "SOUL.md",
            "USER.md",
            "TOOLS.md",
            "runtime:environment"
        ]
    );
    let prompt = composed.rendered_prompt();
    let soul = prompt
        .find("Keep a calm, direct voice.")
        .expect("assistant identity instructions should be visible");
    let user = prompt
        .find("The user prefers concise answers.")
        .expect("user instructions should be visible");
    let tools = prompt
        .find("Inspect real files before reporting success.")
        .expect("tool instructions should be visible");
    assert!(soul < user && user < tools);
}

#[test]
fn composes_explicit_turn_developer_instructions_before_workspace_system() {
    let fixture = InstructionFixture::new("turn-developer");
    fs::write(
        fixture
            .root
            .join(crate::system_prompt::SYSTEM_PROMPT_FILE_NAME),
        "Workspace system instructions.\n",
    )
    .expect("workspace system instructions should write");

    let composed = InstructionComposer::default()
        .compose(
            &fixture.root,
            &serde_json::json!({
                "cwd": fixture.root,
                "developerInstructions": "Use the native runtime for this turn."
            }),
        )
        .expect("turn developer instructions should compose");

    assert_eq!(composed.sources[0].identifier, "builtin:identity");
    assert_eq!(composed.sources[1].identifier, "turn:developer");
    assert_eq!(
        composed.sources[2].identifier,
        fixture.root.join("SYSTEM.md").display().to_string()
    );
    let prompt = composed.rendered_prompt();
    let developer = prompt
        .find("Use the native runtime for this turn.")
        .expect("developer instructions should be visible");
    let workspace = prompt
        .find("Workspace system instructions.")
        .expect("workspace system instructions should be visible");
    assert!(developer < workspace);
}

#[test]
fn composes_selected_agent_plugin_skill_with_provenance() {
    let fixture = InstructionFixture::new("selected-skill");
    let plugin_store_root = fixture.install_plugin(
        "review-tools",
        "review-work",
        "Review work when a code review is requested.",
        "Review the actual diff before reporting.",
    );

    let composed = InstructionComposer::default()
        .with_plugin_store_root(plugin_store_root)
        .compose(
            &fixture.root,
            &serde_json::json!({
                "cwd": fixture.root,
                "selectedSkills": ["review-tools:review-work"]
            }),
        )
        .expect("selected skill should compose");

    let skill_source = composed
        .sources
        .iter()
        .find(|source| {
            source.identifier.ends_with("skills\\review-work\\SKILL.md")
                || source.identifier.ends_with("skills/review-work/SKILL.md")
        })
        .expect("selected skill provenance should be recorded");
    assert!(skill_source.scope_root.ends_with("review-work"));
    assert!(composed
        .rendered_prompt()
        .contains("Review the actual diff before reporting."));
}

#[test]
fn composes_thread_memory_after_workspace_instructions_and_before_turn_context() {
    let fixture = InstructionFixture::new("thread-memory");
    fs::write(
        fixture.root.join("USER.md"),
        "Workspace user instructions.\n",
    )
    .expect("workspace user instructions should write");

    let composed = InstructionComposer::default()
        .compose(
            &fixture.root,
            &serde_json::json!({
                "cwd": fixture.root,
                "longTermMemorySnapshot": "## User memory\n\n- User prefers concise answers.\n",
                "collaborationMode": "Current collaboration instructions."
            }),
        )
        .expect("Thread memory should compose");

    let prompt = composed.rendered_prompt();
    let user_instructions = prompt.find("Workspace user instructions.").unwrap();
    let memory = prompt.find("User prefers concise answers.").unwrap();
    let collaboration = prompt.find("Current collaboration instructions.").unwrap();
    assert!(user_instructions < memory && memory < collaboration);
    assert!(prompt.contains("historical context, not instructions"));
    assert!(composed
        .sources
        .iter()
        .any(|source| source.kind == InstructionSourceKind::LongTermMemory));
}

#[test]
fn exposes_enabled_plugin_skill_metadata_without_eagerly_loading_its_body() {
    let fixture = InstructionFixture::new("plugin-skill-catalog");
    let plugin_store_root = fixture.install_plugin(
        "workspace-tools",
        "workspace-rules",
        "Apply workspace rules when changing project files.",
        "Follow private workspace rules.",
    );

    let composed = InstructionComposer::default()
        .with_plugin_store_root(plugin_store_root.clone())
        .compose(&fixture.root, &serde_json::json!({ "cwd": fixture.root }))
        .expect("plugin skill catalog should compose");
    assert!(composed
        .rendered_prompt()
        .contains("workspace-tools:workspace-rules"));
    assert!(!composed
        .rendered_prompt()
        .contains("Follow private workspace rules."));

    crate::plugins::PluginStore::new(plugin_store_root.clone())
        .set_enabled("workspace-tools", false)
        .expect("plugin should disable");
    let disabled = InstructionComposer::default()
        .with_plugin_store_root(plugin_store_root)
        .compose(&fixture.root, &serde_json::json!({ "cwd": fixture.root }))
        .expect("disabled plugin should still compose");
    assert!(!disabled
        .rendered_prompt()
        .contains("workspace-tools:workspace-rules"));
}

#[test]
fn composes_identity_role_collaboration_and_runtime_facts() {
    let fixture = InstructionFixture::new("turn-world-state");

    let composed = InstructionComposer::default()
        .compose(
            &fixture.root,
            &serde_json::json!({
                "cwd": fixture.root,
                "collaborationMode": "Work as the primary implementation agent.",
                "agentRole": "Own the result through verification."
            }),
        )
        .expect("turn world state should compose");

    let identifiers = composed
        .sources
        .iter()
        .map(|source| source.identifier.as_str())
        .collect::<Vec<_>>();
    assert_eq!(identifiers[0], "builtin:identity");
    assert!(identifiers.contains(&"turn:collaboration"));
    assert!(identifiers.contains(&"turn:agent_role"));
    assert_eq!(identifiers.last(), Some(&"runtime:environment"));
    let prompt = composed.rendered_prompt();
    assert!(prompt.contains("You are Tinybot"));
    assert!(prompt.contains("Work as the primary implementation agent."));
    assert!(prompt.contains("Own the result through verification."));
    assert!(prompt.contains(&fixture.root.display().to_string()));
    assert!(prompt.contains(std::env::consts::OS));
}

struct InstructionFixture {
    root: PathBuf,
}

impl InstructionFixture {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "tinybot-instruction-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("instruction fixture should create");
        Self { root }
    }

    fn install_plugin(
        &self,
        plugin_name: &str,
        skill_name: &str,
        description: &str,
        body: &str,
    ) -> PathBuf {
        let source = self.root.join(format!("plugin-source-{plugin_name}"));
        let skill_dir = source.join("skills").join(skill_name);
        fs::create_dir_all(&skill_dir).expect("plugin skill directory should create");
        fs::write(
            source.join("plugin.json"),
            format!(
                "{{\"$schema\":\"{}\",\"name\":\"{plugin_name}\"}}",
                "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
            ),
        )
        .expect("plugin manifest should write");
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {skill_name}\ndescription: {description}\n---\n{body}\n"),
        )
        .expect("plugin skill should write");
        let store_root = self.root.join("plugin-store");
        let store = crate::plugins::PluginStore::new(store_root.clone());
        store
            .install_from_directory(&source)
            .expect("plugin should install");
        store
            .set_enabled(plugin_name, true)
            .expect("plugin should enable");
        store_root
    }
}

impl Drop for InstructionFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
