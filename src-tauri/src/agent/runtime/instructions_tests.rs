use super::*;

#[test]
fn rejects_a_working_directory_outside_the_workspace_root() {
    let fixture = InstructionFixture::new("outside-working-directory");
    let outside = fixture.root.with_extension("outside");
    fs::create_dir_all(&outside).expect("outside working directory fixture should create");

    let error = InstructionComposer::default()
        .compose(
            &fixture.root,
            &serde_json::json!({ "workingDirectory": outside }),
        )
        .expect_err("working directory outside workspace must fail");
    fs::remove_dir_all(&outside).expect("outside working directory fixture should clean up");

    assert!(error.contains("escapes workspace root"));
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
fn composes_selected_workspace_skill_with_provenance() {
    let fixture = InstructionFixture::new("selected-skill");
    let skill_dir = fixture.root.join("skills").join("review-work");
    fs::create_dir_all(&skill_dir).expect("selected skill directory should create");
    fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: review-work\ndescription: Review work\n---\nReview the actual diff before reporting.\n",
        )
        .expect("selected skill should write");

    let composed = InstructionComposer::default()
        .compose(
            &fixture.root,
            &serde_json::json!({
                "cwd": fixture.root,
                "selectedSkills": ["review-work"]
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
    assert_eq!(skill_source.scope_root, fixture.root.display().to_string());
    assert!(composed
        .rendered_prompt()
        .contains("Review the actual diff before reporting."));
}

#[test]
fn autoloads_always_skill_only_when_enabled_by_config() {
    let fixture = InstructionFixture::new("autoload-skill");
    let skill_dir = fixture.root.join("skills").join("workspace-rules");
    fs::create_dir_all(&skill_dir).expect("autoload skill directory should create");
    fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: workspace-rules\ndescription: Workspace rules\nalways: true\n---\nFollow workspace rules.\n",
        )
        .expect("autoload skill should write");

    let composed = InstructionComposer::default()
        .compose_with_config(
            &fixture.root,
            &serde_json::json!({ "cwd": fixture.root }),
            &serde_json::json!({ "skills": { "enabled": true, "autoload": true } }),
        )
        .expect("autoload skill should compose");
    assert!(composed
        .rendered_prompt()
        .contains("Follow workspace rules."));

    let disabled = InstructionComposer::default()
        .compose_with_config(
            &fixture.root,
            &serde_json::json!({ "cwd": fixture.root }),
            &serde_json::json!({ "skills": { "enabled": false, "autoload": true } }),
        )
        .expect("disabled Skill settings should still compose");
    assert!(!disabled
        .rendered_prompt()
        .contains("Follow workspace rules."));
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
}

impl Drop for InstructionFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
