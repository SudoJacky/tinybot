use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Deserialize)]
pub(crate) struct UploadFilePickerOptions {
    title: Option<String>,
    filters: Option<Vec<UploadFilePickerFilter>>,
}

#[derive(Deserialize)]
struct UploadFilePickerFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportFileOptions {
    title: Option<String>,
    default_path: Option<String>,
    filters: Option<Vec<UploadFilePickerFilter>>,
    contents: String,
}

#[derive(Serialize)]
pub(crate) struct PickedUploadFile {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) mime_type: String,
    pub(crate) size_bytes: u64,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Serialize)]
pub(crate) struct SavedExportFile {
    pub(crate) path: String,
}

const ALLOWED_WORKSPACE_FILES: &[&str] = &[
    "AGENTS.md",
    "SOUL.md",
    "SYSTEM.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "memory/MEMORY.md",
];

#[tauri::command]
pub(crate) fn pick_upload_file(
    options: UploadFilePickerOptions,
) -> Result<Option<PickedUploadFile>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = options.title {
        dialog = dialog.set_title(&title);
    }
    for filter in options.filters.unwrap_or_default() {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let Some(path) = dialog.pick_file() else {
        return Ok(None);
    };
    upload_file_from_path(&path).map(Some)
}

#[tauri::command]
pub(crate) fn reveal_workspace_file(path: String) -> Result<(), String> {
    let target_path = reveal_workspace_file_path(&path)?;
    reveal_file_in_folder(&target_path)
}

#[tauri::command]
pub(crate) fn save_export_file(
    options: ExportFileOptions,
) -> Result<Option<SavedExportFile>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = options.title {
        dialog = dialog.set_title(&title);
    }
    if let Some(default_path) = options.default_path {
        dialog = dialog.set_file_name(safe_export_file_name(&default_path));
    }
    for filter in options.filters.unwrap_or_default() {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let Some(path) = dialog.save_file() else {
        return Ok(None);
    };
    write_export_file(&path, &options.contents)?;
    Ok(Some(SavedExportFile {
        path: path.display().to_string(),
    }))
}

pub(crate) fn upload_file_from_path(path: &Path) -> Result<PickedUploadFile, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("failed to read selected file: {error}"))?;
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("failed to inspect selected file: {error}"))?;
    Ok(PickedUploadFile {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("upload")
            .to_string(),
        path: path.display().to_string(),
        mime_type: mime_type_for_path(path).to_string(),
        size_bytes: metadata.len(),
        bytes,
    })
}

pub(crate) fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "csv" => "text/csv",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "json" => "application/json",
        "markdown" | "md" => "text/markdown",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "jpeg" | "jpg" => "image/jpeg",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

pub(crate) fn allowed_workspace_file_path(
    repo_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    let normalized = normalize_workspace_file_path(requested_path)
        .ok_or_else(|| "workspace file is not revealable".to_string())?;
    if !ALLOWED_WORKSPACE_FILES
        .iter()
        .any(|allowed| *allowed == normalized)
    {
        return Err("workspace file is not revealable".to_string());
    }
    Ok(repo_root.join(normalized))
}

fn reveal_workspace_file_path(requested_path: &str) -> Result<PathBuf, String> {
    reveal_workspace_file_path_from_config_path(
        &crate::default_tinybot_config_path(),
        requested_path,
    )
}

pub(crate) fn reveal_workspace_file_path_from_config_path(
    config_path: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    let root = crate::resolve_native_backend_workspace_root_from_config_path(config_path);
    allowed_workspace_file_path(&root, requested_path)
}

fn normalize_workspace_file_path(requested_path: &str) -> Option<String> {
    let normalized = requested_path.replace('\\', "/");
    let normalized = normalized.trim_matches('/');
    if normalized.is_empty()
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(normalized.to_string())
}

fn reveal_file_in_folder(path: &Path) -> Result<(), String> {
    let parent = if path.is_dir() {
        path
    } else {
        path.parent()
            .ok_or_else(|| "workspace file has no containing folder".to_string())?
    };

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        if path.exists() {
            command.arg(format!("/select,{}", path.display()));
        } else {
            command.arg(parent);
        }
        command.creation_flags(0x08000000);
        return spawn_reveal_command(command);
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if path.exists() {
            command.args(["-R", &path.display().to_string()]);
        } else {
            command.arg(parent);
        }
        return spawn_reveal_command(command);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(parent);
        return spawn_reveal_command(command);
    }

    #[allow(unreachable_code)]
    Err("revealing workspace files is not supported on this platform".to_string())
}

fn spawn_reveal_command(mut command: Command) -> Result<(), String> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to reveal workspace file: {error}"))
}

pub(crate) fn write_export_file(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|error| format!("failed to write export file: {error}"))
}

fn safe_export_file_name(default_path: &str) -> String {
    default_path
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-")
        .trim()
        .trim_matches('-')
        .to_string()
}
