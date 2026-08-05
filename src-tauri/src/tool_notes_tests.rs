use super::*;
use std::path::PathBuf;

#[test]
fn creates_default_tool_notes_with_usage_guidance() {
    let fixture = ToolNotesFixture::new("default");

    assert!(create_default_tool_notes_if_missing(&fixture.root)
        .expect("default tool notes should be created"));
    let saved = std::fs::read_to_string(fixture.root.join(TOOL_NOTES_FILE_NAME))
        .expect("default tool notes should be readable");

    assert!(saved.contains("usage scenarios"));
    assert!(saved.contains("`web.open`"));
    assert!(saved.contains("latest `snapshotId`"));
    assert!(saved.contains("`nextTextOffset`"));
    assert!(saved.contains("Hand control to the user"));
}

#[test]
fn preserves_existing_tool_notes() {
    let fixture = ToolNotesFixture::new("existing");
    let path = fixture.root.join(TOOL_NOTES_FILE_NAME);
    let custom = "# Local tool guidance\n\nPrefer the internal search service.\n";
    std::fs::write(&path, custom).expect("custom tool notes should write");

    assert!(!create_default_tool_notes_if_missing(&fixture.root)
        .expect("existing tool notes should be preserved"));
    assert_eq!(
        std::fs::read_to_string(path).expect("custom tool notes should remain readable"),
        custom
    );
}

struct ToolNotesFixture {
    root: PathBuf,
}

impl ToolNotesFixture {
    fn new(label: &str) -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "tinybot-tool-notes-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("tool notes fixture should create");
        Self { root }
    }
}

impl Drop for ToolNotesFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
