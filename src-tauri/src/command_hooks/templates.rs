use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const CONFIG_TEMPLATE: &str = include_str!("templates/hooks.example.jsonc");
const POWERSHELL_TEMPLATE: &str = include_str!("templates/hook-template.ps1");
const SHELL_TEMPLATE: &str = include_str!("templates/hook-template.sh");

pub(super) struct HookTemplatePaths {
    pub config_path: PathBuf,
    pub scripts_path: PathBuf,
}

pub(super) fn hook_template_paths(data_root: &Path) -> HookTemplatePaths {
    HookTemplatePaths {
        config_path: data_root.join("hooks.example.jsonc"),
        scripts_path: data_root.join("hook-templates"),
    }
}

pub(super) fn ensure_hook_templates(data_root: &Path) -> Result<HookTemplatePaths, String> {
    let paths = hook_template_paths(data_root);
    fs::create_dir_all(&paths.scripts_path).map_err(|error| {
        format!(
            "failed to create hook template directory `{}`: {error}",
            paths.scripts_path.display()
        )
    })?;
    write_if_missing(&paths.config_path, CONFIG_TEMPLATE)?;
    write_if_missing(
        &paths.scripts_path.join("hook-template.ps1"),
        POWERSHELL_TEMPLATE,
    )?;
    write_if_missing(&paths.scripts_path.join("hook-template.sh"), SHELL_TEMPLATE)?;
    Ok(paths)
}

fn write_if_missing(path: &Path, contents: &str) -> Result<(), String> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to create hook template `{}`: {error}",
                path.display()
            ))
        }
    };
    file.write_all(contents.as_bytes()).map_err(|error| {
        format!(
            "failed to write hook template `{}`: {error}",
            path.display()
        )
    })
}
