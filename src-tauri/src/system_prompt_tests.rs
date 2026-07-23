use super::*;
use std::path::PathBuf;

#[test]
fn creates_default_prompt_and_renders_runtime_context() {
    let fixture = SystemPromptFixture::new("default");

    let prompt =
        load_or_create_system_prompt(&fixture.root).expect("default system prompt should load");
    let saved = std::fs::read_to_string(fixture.root.join(SYSTEM_PROMPT_FILE_NAME))
        .expect("default system prompt should be persisted");

    assert!(saved.contains("{{identity}}"));
    assert!(saved.contains("{{working_directory}}"));
    assert!(saved.contains("{{operating_system}}"));
    assert!(saved.contains("Use `update_plan`"));
    assert!(prompt.contains("You are Tinybot"));
    assert!(prompt.contains(&fixture.root.display().to_string()));
    assert!(prompt.contains(std::env::consts::OS));
    assert!(!prompt.contains("{{"));
}

#[test]
fn reloads_user_edits_without_overwriting_the_file() {
    let fixture = SystemPromptFixture::new("edited");
    let path = fixture.root.join(SYSTEM_PROMPT_FILE_NAME);
    let edited =
        "# Custom identity\n\nYou are LocalHelper.\n\nWorking in `{{working_directory}}`.\n";
    std::fs::write(&path, edited).expect("custom system prompt should write");

    let prompt =
        load_or_create_system_prompt(&fixture.root).expect("custom system prompt should load");

    assert!(prompt.contains("You are LocalHelper."));
    assert!(prompt.contains(&fixture.root.display().to_string()));
    assert_eq!(
        std::fs::read_to_string(path).expect("custom system prompt should remain readable"),
        edited
    );
}

#[test]
fn rejects_empty_or_invalid_templates_with_the_file_path() {
    let fixture = SystemPromptFixture::new("invalid");
    let path = fixture.root.join(SYSTEM_PROMPT_FILE_NAME);
    std::fs::write(&path, "  \n").expect("empty fixture should write");

    let empty_error =
        load_or_create_system_prompt(&fixture.root).expect_err("empty system prompt should fail");

    assert!(empty_error.contains("empty"));
    assert!(empty_error.contains(&path.display().to_string()));

    std::fs::write(&path, "Unknown: {{current_weather}}")
        .expect("unknown placeholder fixture should write");
    let unknown_error =
        load_or_create_system_prompt(&fixture.root).expect_err("unknown placeholder should fail");

    assert!(unknown_error.contains("current_weather"));
    assert!(unknown_error.contains(&path.display().to_string()));

    std::fs::write(&path, "Broken: {{identity").expect("unclosed placeholder fixture should write");
    let unclosed_error =
        load_or_create_system_prompt(&fixture.root).expect_err("unclosed placeholder should fail");

    assert!(unclosed_error.contains("unclosed"));
    assert!(unclosed_error.contains(&path.display().to_string()));
}

struct SystemPromptFixture {
    root: PathBuf,
}

impl SystemPromptFixture {
    fn new(label: &str) -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "tinybot-system-prompt-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("system prompt fixture should create");
        Self { root }
    }
}

impl Drop for SystemPromptFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
