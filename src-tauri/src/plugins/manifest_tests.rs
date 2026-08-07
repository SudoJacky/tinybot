use super::*;
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-plugin-manifest-{name}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("fixture root should be created");
        Self { root }
    }

    fn write(&self, relative: &str, contents: &str) {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().expect("fixture file should have a parent"))
            .expect("fixture parent should be created");
        fs::write(path, contents).expect("fixture file should be written");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn loads_valid_components_and_isolates_invalid_siblings() {
    let fixture = Fixture::new("isolation");
    fixture.write(
        "plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"review-tools","description":"Review helpers","future":true}"#,
    );
    fixture.write(
        "skills/review-code/SKILL.md",
        "---\nname: review-code\ndescription: Review code when a user requests a review.\n---\nReview carefully.",
    );
    fixture.write(
        "skills/broken/SKILL.md",
        "---\nname: another-name\ndescription: Broken.\n---\nBroken.",
    );
    fixture.write(
        "mcp.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"local":{"type":"stdio","command":"node","args":["${PLUGIN_ROOT}/server.js"]},"broken":{"type":"stdio"}}}"#,
    );

    let plugin = load_plugin(&fixture.root).expect("plugin should load");

    assert_eq!(plugin.manifest.name, "review-tools");
    assert_eq!(plugin.skills.len(), 1);
    assert_eq!(
        plugin.skills[0].qualified_name(),
        "review-tools:review-code"
    );
    assert_eq!(plugin.mcp_servers.len(), 1);
    assert_eq!(
        plugin.mcp_servers[0].qualified_name(),
        "plugin:review-tools:local"
    );
    assert!(plugin
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "manifest.unknown_field"));
    assert!(plugin
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "skill.invalid"));
    assert!(plugin
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "mcp.invalid_server"));
}

#[test]
fn rejects_fatal_manifest_violations_before_component_discovery() {
    let fixture = Fixture::new("fatal");
    fixture.write(
        "plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"Bad Name"}"#,
    );
    fixture.write(
        "skills/review/SKILL.md",
        "---\nname: review\ndescription: Review code.\n---\nReview.",
    );

    let error = load_plugin(&fixture.root).expect_err("invalid manifest should be rejected");

    assert!(error.contains("does not satisfy Agent Plugins"));
}

#[test]
fn ignores_non_object_extensions_but_rejects_invalid_author_fields() {
    let fixture = Fixture::new("extensions");
    fixture.write(
        "plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"valid","extensions":false}"#,
    );
    let plugin = load_plugin(&fixture.root).expect("non-object extensions are non-fatal");
    assert!(plugin
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "manifest.extensions_ignored"));

    fixture.write(
        "plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"valid","author":{"company":"Tinybot"}}"#,
    );
    assert!(load_plugin(&fixture.root)
        .expect_err("unknown author field should be fatal")
        .contains("author.company"));
}
