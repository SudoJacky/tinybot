use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn resolve_existing_working_directory(
    workspace_root: &Path,
    requested: &Path,
) -> Result<PathBuf, String> {
    let working_directory = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        workspace_root.join(requested)
    };
    let metadata = fs::metadata(&working_directory).map_err(|error| {
        format!(
            "failed to inspect working directory `{}`: {error}",
            working_directory.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "working directory is not a directory: `{}`",
            working_directory.display()
        ));
    }
    fs::canonicalize(&working_directory).map_err(|error| {
        format!(
            "failed to resolve working directory `{}`: {error}",
            working_directory.display()
        )
    })?;
    Ok(working_directory)
}
