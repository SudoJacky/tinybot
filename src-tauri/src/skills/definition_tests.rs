use super::*;

#[test]
fn parses_typed_yaml_and_reports_only_missing_requirements() {
    let definition = SkillDefinition::parse(
            "---\nname: review-work\ndescription: Review work\nalways: true\nrequires:\n  bins: [git, rg]\n  env:\n    - REVIEW_TOKEN\n---\nDo the review.",
        )
        .expect("typed skill should parse");

    assert_eq!(definition.name, "review-work");
    assert!(definition.always);
    assert_eq!(definition.required_bins, vec!["git", "rg"]);
    assert_eq!(definition.required_env, vec!["REVIEW_TOKEN"]);
    assert_eq!(definition.body, "Do the review.");
    assert_eq!(
        definition.availability_with(|bin| bin == "git", |_| false),
        SkillAvailability {
            available: false,
            missing: vec!["CLI: rg".to_string(), "ENV: REVIEW_TOKEN".to_string()],
        }
    );
}

#[test]
fn accepts_legacy_json_metadata() {
    let definition = SkillDefinition::parse(
            "---\nname: legacy\ndescription: Legacy\nmetadata: '{\"always\":true,\"requires\":{\"bins\":[\"git\"]}}'\n---\nLegacy body",
        )
        .expect("legacy metadata should remain compatible");

    assert!(definition.always);
    assert_eq!(definition.required_bins, vec!["git"]);
}

#[test]
fn update_preserves_nested_frontmatter() {
    let updated = update_skill_document(
        "---\nname: review-work\ndescription: Old\nrequires:\n  bins: [git]\n---\nOld body",
        Some("New".to_string()),
        Some(true),
        Some("New body".to_string()),
    )
    .expect("skill should update");
    let parsed = SkillDefinition::parse(&updated).expect("updated skill should parse");

    assert_eq!(parsed.description, "New");
    assert!(parsed.always);
    assert_eq!(parsed.required_bins, vec!["git"]);
    assert_eq!(parsed.body, "New body");
}
