use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{
    runtime::observability::{global_agent_runtime_metrics, AgentRuntimeMetrics},
    storage::atomic::replace_file,
};

use super::{
    logging::{
        native_backend_log_event_line, native_backend_rotated_log_path,
        sanitize_native_log_context, NativeLogEvent, NativeLogLevel,
    },
    memory_metrics::{collect_desktop_memory, DesktopMemorySnapshot},
    state::{lock_runtime, SharedNativeRuntime},
};

const DIAGNOSTIC_BUNDLE_SCHEMA: &str = "tinybot.diagnostic_bundle.v1";
const DIAGNOSTIC_BUNDLE_INPUT_SCHEMA: &str = "tinybot.diagnostic_bundle_input.v1";
const MAX_RENDERER_LOG_ENTRIES: usize = 300;
const MAX_RENDERER_LOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_NATIVE_LOG_SOURCE_BYTES: u64 = 6 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 128;
const MAX_MEMORY_SAMPLES: usize = 300;
const MAX_MEMORY_SAMPLE_BYTES: usize = 4 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn desktop_performance_snapshot(
    app: AppHandle,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    let memory = collect_desktop_memory(&app).await;
    Ok(desktop_performance_snapshot_value(
        state.inner(),
        global_agent_runtime_metrics(),
        &memory,
    ))
}

#[tauri::command]
pub(crate) async fn desktop_memory_snapshot(app: AppHandle) -> DesktopMemorySnapshot {
    collect_desktop_memory(&app).await
}

#[tauri::command]
pub(crate) async fn desktop_export_diagnostic_bundle(
    app: AppHandle,
    input: Value,
    state: State<'_, SharedNativeRuntime>,
) -> Result<Option<Value>, String> {
    let input = parse_bundle_input(input)?;
    let default_name = format!(
        "tinybot-diagnostic-{}.zip",
        Utc::now().format("%Y%m%d-%H%M%S")
    );
    let Some(path) = rfd::FileDialog::new()
        .set_title("Export Tinybot diagnostic bundle")
        .set_file_name(&default_name)
        .add_filter("ZIP archive", &["zip"])
        .save_file()
    else {
        return Ok(None);
    };
    let memory = collect_desktop_memory(&app).await;
    export_diagnostic_bundle(
        &path,
        state.inner(),
        global_agent_runtime_metrics(),
        &memory,
        input,
    )
    .map(Some)
}

#[cfg(test)]
pub(crate) fn desktop_performance_snapshot_with_options(
    shared: &SharedNativeRuntime,
    metrics: &AgentRuntimeMetrics,
) -> Value {
    desktop_performance_snapshot_value(
        shared,
        metrics,
        &DesktopMemorySnapshot::unsupported(now_unix_ms()),
    )
}

fn desktop_performance_snapshot_value(
    shared: &SharedNativeRuntime,
    metrics: &AgentRuntimeMetrics,
    memory: &DesktopMemorySnapshot,
) -> Value {
    let recent_events = {
        let runtime = lock_runtime(shared);
        runtime
            .recent_log_events
            .iter()
            .cloned()
            .collect::<Vec<_>>()
    };
    serde_json::json!({
        "schemaVersion": "tinybot.performance_trace.v1",
        "generatedAtUnixMs": now_unix_ms(),
        "metrics": metrics.snapshot(),
        "memory": memory,
        "recentEvents": recent_events,
    })
}

#[cfg(test)]
pub(crate) fn export_diagnostic_bundle_with_options(
    path: &Path,
    shared: &SharedNativeRuntime,
    metrics: &AgentRuntimeMetrics,
    input: Value,
) -> Result<Value, String> {
    let memory = DesktopMemorySnapshot::unsupported(now_unix_ms());
    export_diagnostic_bundle(path, shared, metrics, &memory, parse_bundle_input(input)?)
}

fn export_diagnostic_bundle(
    path: &Path,
    shared: &SharedNativeRuntime,
    metrics: &AgentRuntimeMetrics,
    memory: &DesktopMemorySnapshot,
    input: DiagnosticBundleInput,
) -> Result<Value, String> {
    let created_at_unix_ms = now_unix_ms();
    let log_path = {
        let runtime = lock_runtime(shared);
        runtime.persistent_log_path.clone()
    };
    let renderer_logs = normalize_renderer_logs(input.renderer_logs)?;
    let memory_samples = normalize_memory_samples(input.memory_samples)?;
    let mut entries = vec![
        BundleEntry::json(
            "performance-trace.json",
            &desktop_performance_snapshot_value(shared, metrics, memory),
        )?,
        BundleEntry::json("renderer-logs.json", &renderer_logs)?,
        BundleEntry::json(
            "system-info.json",
            &DiagnosticSystemInfo {
                schema_version: "tinybot.diagnostic_system.v1",
                app_version: env!("CARGO_PKG_VERSION"),
                os: std::env::consts::OS,
                arch: std::env::consts::ARCH,
                locale: validate_optional_metadata(input.locale, "locale")?,
                time_zone: validate_optional_metadata(input.time_zone, "timeZone")?,
                diagnostic_mode_enabled: input.diagnostic_mode_enabled,
            },
        )?,
    ];
    if !memory_samples.is_empty() {
        entries.push(BundleEntry::json("memory-samples.json", &memory_samples)?);
    }
    let mut missing_files = Vec::new();
    let mut truncated_files = Vec::new();
    let mut omitted_malformed_log_lines = 0_u64;
    for (name, source) in [
        ("native-backend.log", log_path.clone()),
        (
            "native-backend.log.1",
            native_backend_rotated_log_path(&log_path),
        ),
    ] {
        match read_sanitized_log_source(&source)? {
            Some(log) => {
                if log.truncated {
                    truncated_files.push(name.to_string());
                }
                omitted_malformed_log_lines =
                    omitted_malformed_log_lines.saturating_add(log.omitted_malformed_lines);
                entries.push(BundleEntry {
                    name,
                    contents: log.contents.into_bytes(),
                });
            }
            None => missing_files.push(name.to_string()),
        }
    }
    let included_files = entries
        .iter()
        .map(|entry| entry.name.to_string())
        .chain(std::iter::once("manifest.json".to_string()))
        .collect::<Vec<_>>();
    let manifest = DiagnosticBundleManifest {
        schema_version: DIAGNOSTIC_BUNDLE_SCHEMA,
        created_at_unix_ms,
        included_files: included_files.clone(),
        missing_files,
        truncated_files,
        omitted_malformed_log_lines,
        redaction: DiagnosticBundleRedaction {
            strategy: "bounded key-based redaction; malformed persistent log lines are omitted",
            user_review_required: true,
        },
        limits: DiagnosticBundleLimits {
            renderer_log_entries: MAX_RENDERER_LOG_ENTRIES,
            renderer_log_bytes: MAX_RENDERER_LOG_BYTES,
            memory_samples: MAX_MEMORY_SAMPLES,
            memory_sample_bytes: MAX_MEMORY_SAMPLE_BYTES,
            native_log_source_bytes: MAX_NATIVE_LOG_SOURCE_BYTES,
        },
    };
    entries.insert(0, BundleEntry::json("manifest.json", &manifest)?);
    let size_bytes = write_zip_atomically(path, entries)?;
    Ok(serde_json::json!({
        "schemaVersion": DIAGNOSTIC_BUNDLE_SCHEMA,
        "path": path.display().to_string(),
        "sizeBytes": size_bytes,
        "includedFiles": included_files,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticBundleInput {
    schema_version: String,
    diagnostic_mode_enabled: bool,
    locale: Option<String>,
    time_zone: Option<String>,
    renderer_logs: Vec<RendererBundleLog>,
    #[serde(default)]
    memory_samples: Vec<DesktopMemorySnapshot>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererBundleLog {
    schema_version: String,
    at: String,
    level: NativeLogLevel,
    stage: String,
    details: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentNativeLogEvent {
    schema_version: String,
    level: NativeLogLevel,
    event: String,
    context: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticSystemInfo {
    schema_version: &'static str,
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
    locale: Option<String>,
    time_zone: Option<String>,
    diagnostic_mode_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticBundleManifest {
    schema_version: &'static str,
    created_at_unix_ms: u64,
    included_files: Vec<String>,
    missing_files: Vec<String>,
    truncated_files: Vec<String>,
    omitted_malformed_log_lines: u64,
    redaction: DiagnosticBundleRedaction,
    limits: DiagnosticBundleLimits,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticBundleRedaction {
    strategy: &'static str,
    user_review_required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticBundleLimits {
    renderer_log_entries: usize,
    renderer_log_bytes: usize,
    memory_samples: usize,
    memory_sample_bytes: usize,
    native_log_source_bytes: u64,
}

struct BundleEntry {
    name: &'static str,
    contents: Vec<u8>,
}

impl BundleEntry {
    fn json(name: &'static str, value: &impl Serialize) -> Result<Self, String> {
        let mut contents = serde_json::to_vec_pretty(value)
            .map_err(|error| format!("failed to serialize diagnostic bundle {name}: {error}"))?;
        contents.push(b'\n');
        Ok(Self { name, contents })
    }
}

struct SanitizedLogSource {
    contents: String,
    truncated: bool,
    omitted_malformed_lines: u64,
}

fn parse_bundle_input(value: Value) -> Result<DiagnosticBundleInput, String> {
    let input: DiagnosticBundleInput = serde_json::from_value(value)
        .map_err(|error| format!("invalid diagnostic bundle input: {error}"))?;
    if input.schema_version != DIAGNOSTIC_BUNDLE_INPUT_SCHEMA {
        return Err(format!(
            "invalid diagnostic bundle input: unsupported schema {}",
            input.schema_version
        ));
    }
    Ok(input)
}

fn normalize_renderer_logs(logs: Vec<RendererBundleLog>) -> Result<Vec<RendererBundleLog>, String> {
    if logs.len() > MAX_RENDERER_LOG_ENTRIES {
        return Err(format!(
            "diagnostic bundle renderer logs exceed {MAX_RENDERER_LOG_ENTRIES} entries"
        ));
    }
    let mut total_bytes = 0_usize;
    logs.into_iter()
        .enumerate()
        .map(|(index, mut log)| {
            if log.schema_version != "tinybot.renderer_log.v1" {
                return Err(format!(
                    "diagnostic bundle renderer log {index} has unsupported schema {}",
                    log.schema_version
                ));
            }
            chrono::DateTime::parse_from_rfc3339(&log.at).map_err(|error| {
                format!("diagnostic bundle renderer log {index} has invalid timestamp: {error}")
            })?;
            if !log.details.is_object() {
                return Err(format!(
                    "diagnostic bundle renderer log {index} details must be an object"
                ));
            }
            log.details = sanitize_native_log_context(log.details);
            let event = NativeLogEvent::new(log.level, log.stage.clone(), log.details.clone());
            native_backend_log_event_line(&event).map_err(|error| {
                format!("diagnostic bundle renderer log {index} is invalid: {error}")
            })?;
            let bytes = serde_json::to_vec(&log)
                .map_err(|error| format!("failed to serialize renderer log {index}: {error}"))?;
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > MAX_RENDERER_LOG_BYTES {
                return Err(format!(
                    "diagnostic bundle renderer logs exceed {MAX_RENDERER_LOG_BYTES} bytes"
                ));
            }
            Ok(log)
        })
        .collect()
}

fn normalize_memory_samples(
    samples: Vec<DesktopMemorySnapshot>,
) -> Result<Vec<DesktopMemorySnapshot>, String> {
    if samples.len() > MAX_MEMORY_SAMPLES {
        return Err(format!(
            "diagnostic bundle memory samples exceed {MAX_MEMORY_SAMPLES} entries"
        ));
    }
    let encoded = serde_json::to_vec(&samples)
        .map_err(|error| format!("failed to serialize diagnostic memory samples: {error}"))?;
    if encoded.len() > MAX_MEMORY_SAMPLE_BYTES {
        return Err(format!(
            "diagnostic bundle memory samples exceed {MAX_MEMORY_SAMPLE_BYTES} bytes"
        ));
    }
    if let Some((index, sample)) = samples
        .iter()
        .enumerate()
        .find(|(_, sample)| sample.schema_version != "tinybot.memory_snapshot.v1")
    {
        return Err(format!(
            "diagnostic bundle memory sample {index} has unsupported schema {}",
            sample.schema_version
        ));
    }
    Ok(samples)
}

fn validate_optional_metadata(
    value: Option<String>,
    label: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_METADATA_BYTES || value.chars().any(char::is_control) {
        return Err(format!(
            "diagnostic bundle {label} must be at most {MAX_METADATA_BYTES} bytes without control characters"
        ));
    }
    Ok(Some(value.to_string()))
}

fn read_sanitized_log_source(path: &Path) -> Result<Option<SanitizedLogSource>, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to open diagnostic log source {}: {error}",
                path.display()
            ))
        }
    };
    let length = file
        .metadata()
        .map_err(|error| format!("failed to inspect diagnostic log source: {error}"))?
        .len();
    let truncated = length > MAX_NATIVE_LOG_SOURCE_BYTES;
    if truncated {
        file.seek(SeekFrom::Start(length - MAX_NATIVE_LOG_SOURCE_BYTES))
            .map_err(|error| format!("failed to seek diagnostic log source: {error}"))?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read diagnostic log source: {error}"))?;
    if truncated {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        } else {
            bytes.clear();
        }
    }
    let contents = String::from_utf8(bytes)
        .map_err(|error| format!("diagnostic log source is not valid UTF-8: {error}"))?;
    let mut sanitized = String::new();
    let mut omitted_malformed_lines = 0_u64;
    for line in contents.lines() {
        let Some(sanitized_line) = sanitize_persistent_log_line(line) else {
            omitted_malformed_lines = omitted_malformed_lines.saturating_add(1);
            continue;
        };
        sanitized.push_str(&sanitized_line);
        sanitized.push('\n');
    }
    Ok(Some(SanitizedLogSource {
        contents: sanitized,
        truncated,
        omitted_malformed_lines,
    }))
}

fn sanitize_persistent_log_line(line: &str) -> Option<String> {
    let mut fields = line.splitn(3, ' ');
    let timestamp = fields.next()?;
    let stream = fields.next()?;
    let json = fields.next()?;
    timestamp.parse::<u128>().ok()?;
    if stream.is_empty() || stream.chars().any(char::is_whitespace) {
        return None;
    }
    let parsed = serde_json::from_str::<PersistentNativeLogEvent>(json).ok()?;
    if parsed.schema_version != "tinybot.native_log.v1" {
        return None;
    }
    let event = NativeLogEvent::new(parsed.level, parsed.event, parsed.context);
    let record = native_backend_log_event_line(&event).ok()?;
    Some(format!("{timestamp} {stream} {record}"))
}

fn write_zip_atomically(path: &Path, entries: Vec<BundleEntry>) -> Result<u64, String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create diagnostic bundle directory: {error}"))?;
    let temp_path = diagnostic_temp_path(path)?;
    let result = (|| {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("failed to create diagnostic bundle: {error}"))?;
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        for entry in entries {
            zip.start_file(entry.name, options)
                .map_err(|error| format!("failed to start diagnostic bundle entry: {error}"))?;
            zip.write_all(&entry.contents)
                .map_err(|error| format!("failed to write diagnostic bundle entry: {error}"))?;
        }
        let mut writer = zip
            .finish()
            .map_err(|error| format!("failed to finish diagnostic bundle: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("failed to flush diagnostic bundle: {error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("failed to sync diagnostic bundle: {error}"))?;
        drop(writer);
        replace_file(&temp_path, path)
            .map_err(|error| format!("failed to activate diagnostic bundle: {error}"))?;
        fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|error| format!("failed to inspect diagnostic bundle: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn diagnostic_temp_path(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "diagnostic bundle path must include a UTF-8 file name".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".{name}.{}.{}.tmp", std::process::id(), nonce)))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}
