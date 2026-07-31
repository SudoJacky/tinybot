use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(crate) const TOOL_NOTES_FILE_NAME: &str = "TOOLS.md";

const DEFAULT_TOOL_NOTES: &str = r#"# Tool Usage Notes

Tool names, descriptions, and input schemas are supplied automatically. Use this file for non-obvious usage scenarios, tool combinations, and practical tips rather than repeating complete tool signatures.

## Web browser

- Use the web tools when a task depends on current website content or requires interaction with a page.
- `web.open` opens a URL and automatically creates or reuses this chat's browser session.
- `web.read` reads the current page. Pass the previous `snapshotId` to get a compact unchanged response when possible.
- `web.act` changes the current page and requires the latest `snapshotId`. If an action is rejected as stale, use the returned snapshot and retry only if the action is still appropriate.
- Prefer semantic `targetRef` values from the latest snapshot over screen coordinates, and treat both `snapshotId` and `targetRef` as opaque values.
- Use `web.open` for URL navigation instead of inventing a navigation action for `web.act`.
- Hand control to the user when login credentials, verification codes, CAPTCHA, payment details, file pickers, or another protected step requires human input. Only the user can hand browser control back to the Agent.
"#;

pub(crate) fn create_default_tool_notes_if_missing(workspace_root: &Path) -> Result<bool, String> {
    fs::create_dir_all(workspace_root).map_err(|error| {
        format!(
            "failed to create tool notes directory `{}`: {error}",
            workspace_root.display()
        )
    })?;
    let path = workspace_root.join(TOOL_NOTES_FILE_NAME);
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => {
            return Err(format!(
                "failed to create tool notes file `{}`: {error}",
                path.display()
            ));
        }
    };
    if let Err(error) = file.write_all(DEFAULT_TOOL_NOTES.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(format!(
            "failed to write default tool notes file `{}`: {error}",
            path.display()
        ));
    }
    Ok(true)
}

#[cfg(test)]
#[path = "tool_notes_tests.rs"]
mod tests;
