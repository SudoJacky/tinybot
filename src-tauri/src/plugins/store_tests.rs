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
fn imports_disabled_then_enables_globally() {
    let fixture = Fixture::new("enable");
    let source = fixture.plugin();
    let store = PluginStore::new(fixture.root.join("global-plugins"));

    let installed = store
        .install_from_directory(&source)
        .expect("plugin should install");
    assert!(!installed.enabled);
    assert!(store
        .enabled()
        .expect("enabled plugins should load")
        .is_empty());

    let enabled = store
        .set_enabled("review-tools", true)
        .expect("plugin should enable");
    assert!(enabled.enabled);
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
        .set_enabled("review-tools", true)
        .expect("plugin should enable");
    let data_file = store.data_directory("review-tools").join("state.txt");
    fs::write(&data_file, "persistent").expect("plugin data should be writable");

    let reinstalled = store
        .install_from_directory(&source)
        .expect("plugin should reinstall");
    assert!(reinstalled.enabled);
    store
        .uninstall("review-tools")
        .expect("plugin should uninstall");
    assert!(data_file.exists());
    assert!(store.list().expect("plugin state should load").is_empty());
}
