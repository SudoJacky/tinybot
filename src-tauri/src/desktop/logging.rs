use std::{
    collections::VecDeque,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) fn append_native_backend_log_line(
    path: &Path,
    max_bytes: u64,
    stream: &str,
    line: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create native backend log directory: {error}"))?;
    }
    rotate_native_backend_log_if_needed(path, max_bytes)
        .map_err(|error| format!("failed to rotate native backend log: {error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open native backend log: {error}"))?;
    writeln!(file, "{} {} {}", now_unix_ms(), stream, line)
        .map_err(|error| format!("failed to write native backend log: {error}"))
}

fn rotate_native_backend_log_if_needed(path: &Path, max_bytes: u64) -> std::io::Result<()> {
    if max_bytes == 0
        || std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            < max_bytes
    {
        return Ok(());
    }
    let rotated = native_backend_rotated_log_path(path);
    let _ = std::fs::remove_file(&rotated);
    std::fs::rename(path, rotated)
}

fn native_backend_rotated_log_path(path: &Path) -> PathBuf {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return path.with_extension("1");
    };
    path.with_file_name(format!("{file_name}.1"))
}

pub(crate) fn gateway_runtime_logs(runtime_logs: &VecDeque<String>) -> Vec<String> {
    runtime_logs.iter().cloned().collect()
}

pub(crate) fn read_native_backend_log_tail(path: &Path, max_lines: usize) -> Vec<String> {
    if max_lines == 0 {
        return Vec::new();
    }
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines = contents
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].to_vec()
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
