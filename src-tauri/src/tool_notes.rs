use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(crate) const TOOL_NOTES_FILE_NAME: &str = "TOOLS.md";

const DEFAULT_TOOL_NOTES: &str = r#"# Tool Usage Notes

Tool descriptions and input schemas are supplied with each request. Follow them as the source of truth. Use this file only for local guidance that is not expressed by a tool definition.
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
