use super::*;

fn skill(name: &str, always: bool) -> WorkspaceSkillEntry {
    WorkspaceSkillEntry {
        name: name.to_string(),
        path: format!("skills/{name}/SKILL.md"),
        source: "workspace".to_string(),
        content: format!(
            "---\nname: {name}\ndescription: {name}\n{}---\n{name} body",
            if always { "always: true\n" } else { "" }
        ),
    }
}

#[test]
fn resolves_explicit_and_autoloaded_skills_with_reasons() {
    let resolution = resolve_skills(
        vec![
            skill("explicit", false),
            skill("always-on", true),
            skill("off", false),
        ],
        &serde_json::json!({ "skills": { "enabled": true, "autoload": true } }),
        &["explicit".to_string()],
    )
    .expect("skills should resolve");

    assert_eq!(
        resolution.catalog[0].activation,
        Some(SkillActivation::Explicit)
    );
    assert!(resolution.catalog[0].effective);
    assert_eq!(
        resolution.catalog[1].activation,
        Some(SkillActivation::Autoload)
    );
    assert!(resolution.catalog[1].effective);
    assert_eq!(
        resolution.catalog[2].reason.as_deref(),
        Some("not selected for this turn")
    );
}

#[test]
fn disabled_explicit_skill_fails_fast() {
    let error = resolve_skills(
        vec![skill("off", false)],
        &serde_json::json!({ "skills": { "disabled_skills": ["off"] } }),
        &["off".to_string()],
    )
    .expect_err("disabled selected skill should fail");

    assert_eq!(error, "selected skill `off` is disabled");
}
