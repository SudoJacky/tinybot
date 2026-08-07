use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-plugin-store-{name}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("fixture root should be created");
        Self { root }
    }

    fn plugin(&self) -> PathBuf {
        let plugin = self.root.join("source");
        fs::create_dir_all(plugin.join("skills/review-code"))
            .expect("plugin directories should be created");
        fs::write(
            plugin.join("plugin.json"),
            r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"review-tools","version":"1.0.0"}"#,
        )
        .expect("manifest should be written");
        fs::write(
            plugin.join("skills/review-code/SKILL.md"),
            "---\nname: review-code\ndescription: Review code.\n---\nReview carefully.",
        )
        .expect("skill should be written");
        plugin
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn imports_enabled_globally_by_default() {
    let fixture = Fixture::new("enable");
    let source = fixture.plugin();
    let store = PluginStore::new(fixture.root.join("global-plugins"));

    let installed = store
        .install_from_directory(&source)
        .expect("plugin should install");
    assert!(installed.enabled);
    let active = store.enabled().expect("enabled plugin should load");
    assert_eq!(active.len(), 1);
    assert_eq!(
        active[0].skills[0].qualified_name(),
        "review-tools:review-code"
    );
}

#[test]
fn reinstall_preserves_enablement_and_uninstall_preserves_plugin_data() {
    let fixture = Fixture::new("reinstall");
    let source = fixture.plugin();
    let store = PluginStore::new(fixture.root.join("global-plugins"));
    store
        .install_from_directory(&source)
        .expect("plugin should install");
    store
        .set_enabled("review-tools", false)
        .expect("plugin should disable");
    let data_file = store.data_directory("review-tools").join("state.txt");
    assert!(!data_file
        .parent()
        .expect("data file should have a parent")
        .exists());
    fs::create_dir_all(data_file.parent().expect("data file should have a parent"))
        .expect("plugin data directory should be writable when needed");
    fs::write(&data_file, "persistent").expect("plugin data should be writable");

    let reinstalled = store
        .install_from_directory(&source)
        .expect("plugin should reinstall");
    assert!(!reinstalled.enabled);
    store
        .uninstall("review-tools")
        .expect("plugin should uninstall");
    assert!(data_file.exists());
    assert!(store.list().expect("plugin state should load").is_empty());
}

#[test]
fn prepares_isolated_migration_workspace_for_standalone_skill() {
    let fixture = Fixture::new("migration-skill");
    let source = fixture.root.join("legacy-skill");
    fs::create_dir_all(source.join("references")).expect("skill directories should be created");
    fs::write(
        source.join("SKILL.md"),
        "---\nname: legacy-skill\ndescription: Legacy skill.\n---\nUse it.",
    )
    .expect("skill should be written");
    fs::write(source.join("references/notes.md"), "notes")
        .expect("skill reference should be written");
    let store = PluginStore::new(fixture.root.join("global-plugins"));

    let job = store
        .prepare_migration(&source)
        .expect("standalone skill migration should prepare");

    assert_eq!(job.detected_artifacts, vec!["standalone Skill"]);
    assert!(Path::new(&job.working_directory).is_dir());
    assert!(Path::new(&job.source_directory).join("SKILL.md").is_file());
    assert!(Path::new(&job.source_directory)
        .join("references/notes.md")
        .is_file());
    assert!(Path::new(&job.output_directory).is_dir());
    assert!(fs::read_dir(&job.output_directory)
        .expect("migration output should be readable")
        .next()
        .is_none());
}

#[test]
fn installs_valid_migration_output_and_removes_the_job_workspace() {
    let fixture = Fixture::new("migration-install");
    let source = fixture.root.join("legacy-skill");
    fs::create_dir_all(&source).expect("legacy skill directory should be created");
    fs::write(
        source.join("SKILL.md"),
        "---\nname: legacy-skill\ndescription: Legacy skill.\n---\nUse it.",
    )
    .expect("legacy skill should be written");
    let store = PluginStore::new(fixture.root.join("global-plugins"));
    let job = store
        .prepare_migration(&source)
        .expect("migration should prepare");
    let output = PathBuf::from(&job.output_directory);
    fs::create_dir_all(output.join("skills/legacy-skill"))
        .expect("migration output directories should be created");
    fs::write(
        output.join("plugin.json"),
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"legacy-tools","version":"1.0.0"}"#,
    )
    .expect("migration manifest should be written");
    fs::write(
        output.join("skills/legacy-skill/SKILL.md"),
        "---\nname: legacy-skill\ndescription: Migrated skill.\n---\nUse it.",
    )
    .expect("migrated skill should be written");

    let result = store
        .install_migration(&job.job_id)
        .expect("valid migration output should install");

    assert_eq!(result.plugin.name, "legacy-tools");
    assert!(result.plugin.enabled);
    assert!(result.cleanup_warning.is_none());
    assert!(!Path::new(&job.working_directory).exists());
    assert!(store
        .list()
        .expect("installed plugins should list")
        .iter()
        .any(|plugin| plugin.name == "legacy-tools" && plugin.enabled));
}

#[test]
fn rejects_invalid_migration_job_ids() {
    let fixture = Fixture::new("migration-invalid-job");
    let store = PluginStore::new(fixture.root.join("global-plugins"));

    let error = store
        .install_migration("../outside")
        .expect_err("path traversal must be rejected");

    assert!(error.contains("invalid plugin migration job id"));
}

#[test]
fn refuses_to_migrate_an_already_valid_agent_plugin() {
    let fixture = Fixture::new("migration-valid-plugin");
    let source = fixture.plugin();
    let store = PluginStore::new(fixture.root.join("global-plugins"));

    let error = store
        .prepare_migration(&source)
        .expect_err("valid Agent Plugin should use normal import");

    assert!(error.contains("already a valid Agent Plugin"));
    assert!(!fixture.root.join("global-plugins/migrations").exists());
}

#[test]
fn refuses_unrecognized_migration_sources() {
    let fixture = Fixture::new("migration-unrecognized");
    let source = fixture.root.join("ordinary-folder");
    fs::create_dir_all(&source).expect("source directory should be created");
    fs::write(source.join("README.md"), "not a plugin").expect("ordinary file should be written");
    let store = PluginStore::new(fixture.root.join("global-plugins"));

    let error = store
        .prepare_migration(&source)
        .expect_err("unrecognized source should fail fast");

    assert!(error.contains("no standalone Skill, MCP configuration"));
}
