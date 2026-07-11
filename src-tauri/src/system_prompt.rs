use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(crate) const SYSTEM_PROMPT_FILE_NAME: &str = "SYSTEM.md";
const DEFAULT_SYSTEM_PROMPT: &str = r#"# Tinybot System Prompt

<!-- Supported placeholders: {{identity}}, {{working_directory}}, {{operating_system}} -->

## Identity

You are {{identity}}, a local-first AI assistant running on the user's machine.

## Runtime environment

- Working directory: `{{working_directory}}`
- Operating system: `{{operating_system}}`

## Working principles

- Treat the working directory as the default scope for file and shell operations.
- Inspect real files and runtime state before making claims about them.
- Report errors clearly. Do not hide failures or claim success without verification.
- Preserve existing user changes and request confirmation before destructive operations.

## Planning

- Use `update_plan` for non-trivial, ambiguous, or multi-phase work; do not add plans to simple tasks.
- Keep exactly one plan step `in_progress` until all steps are `completed`.
- Update the complete plan before moving to the next step, and explain material plan revisions.
- Do not repeat the full plan in a message because the timeline already renders it.
"#;

pub(crate) fn load_or_create_system_prompt(workspace_root: &Path) -> Result<String, String> {
    load_or_create_system_prompt_for_working_directory(workspace_root, workspace_root)
}

pub(crate) fn load_or_create_system_prompt_for_working_directory(
    workspace_root: &Path,
    working_directory: &Path,
) -> Result<String, String> {
    fs::create_dir_all(workspace_root).map_err(|error| {
        format!(
            "failed to create system prompt directory `{}`: {error}",
            workspace_root.display()
        )
    })?;
    let path = workspace_root.join(SYSTEM_PROMPT_FILE_NAME);
    create_default_system_prompt_if_missing(&path)?;
    let template = fs::read_to_string(&path).map_err(|error| {
        format!(
            "failed to read system prompt file `{}`: {error}",
            path.display()
        )
    })?;
    if template.trim().is_empty() {
        return Err(format!("system prompt file is empty: `{}`", path.display()));
    }
    render_system_prompt(&template, working_directory, &path)
}

fn create_default_system_prompt_if_missing(path: &Path) -> Result<(), String> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to create system prompt file `{}`: {error}",
                path.display()
            ));
        }
    };
    if let Err(error) = file.write_all(DEFAULT_SYSTEM_PROMPT.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!(
            "failed to write default system prompt file `{}`: {error}",
            path.display()
        ));
    }
    Ok(())
}

fn render_system_prompt(
    template: &str,
    workspace_root: &Path,
    path: &Path,
) -> Result<String, String> {
    let mut rendered = String::with_capacity(template.len() + 64);
    let mut cursor = 0;
    while let Some(relative_start) = template[cursor..].find("{{") {
        let start = cursor + relative_start;
        let prefix = &template[cursor..start];
        if prefix.contains("}}") {
            return Err(invalid_placeholder_error(
                path,
                "unmatched closing placeholder",
            ));
        }
        rendered.push_str(prefix);
        let value_start = start + 2;
        let Some(relative_end) = template[value_start..].find("}}") else {
            return Err(invalid_placeholder_error(path, "unclosed placeholder"));
        };
        let end = value_start + relative_end;
        let name = template[value_start..end].trim();
        let value = match name {
            "identity" => "Tinybot".to_string(),
            "working_directory" => workspace_root.display().to_string(),
            "operating_system" => std::env::consts::OS.to_string(),
            _ => {
                return Err(invalid_placeholder_error(
                    path,
                    &format!("unsupported placeholder `{name}`"),
                ));
            }
        };
        rendered.push_str(&value);
        cursor = end + 2;
    }
    let suffix = &template[cursor..];
    if suffix.contains("}}") {
        return Err(invalid_placeholder_error(
            path,
            "unmatched closing placeholder",
        ));
    }
    rendered.push_str(suffix);
    Ok(rendered)
}

fn invalid_placeholder_error(path: &Path, detail: &str) -> String {
    format!(
        "invalid system prompt template `{}`: {detail}",
        path.display()
    )
}

#[cfg(test)]
mod tests {
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

        let empty_error = load_or_create_system_prompt(&fixture.root)
            .expect_err("empty system prompt should fail");

        assert!(empty_error.contains("empty"));
        assert!(empty_error.contains(&path.display().to_string()));

        std::fs::write(&path, "Unknown: {{current_weather}}")
            .expect("unknown placeholder fixture should write");
        let unknown_error = load_or_create_system_prompt(&fixture.root)
            .expect_err("unknown placeholder should fail");

        assert!(unknown_error.contains("current_weather"));
        assert!(unknown_error.contains(&path.display().to_string()));

        std::fs::write(&path, "Broken: {{identity")
            .expect("unclosed placeholder fixture should write");
        let unclosed_error = load_or_create_system_prompt(&fixture.root)
            .expect_err("unclosed placeholder should fail");

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
}
