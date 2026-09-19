use super::*;
use crate::protocol::WorkerRequestCancellation;
use serde_json::{json, Value};
use std::{
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

mod process;
#[cfg(test)]
mod tests;

const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchParams {
    pub pattern: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub ignore_case: bool,
    #[serde(default)]
    pub glob: Option<String>,
    #[serde(default)]
    pub context_lines: usize,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub include_ignored: bool,
}

fn default_path() -> String {
    ".".into()
}
fn default_max_results() -> usize {
    200
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub entries: Vec<SearchEntry>,
    pub match_count: usize,
    pub truncated: bool,
    pub stop_reason: &'static str,
    pub scope: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchEntry {
    pub path: String,
    pub line: u64,
    pub text: String,
    pub kind: String,
}

impl WorkerWorkspaceRpc {
    pub(crate) fn search_file_content(
        &self,
        params: SearchParams,
        cancellation: Option<Arc<dyn WorkerRequestCancellation>>,
    ) -> Result<SearchResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        if params.pattern.is_empty()
            || params.pattern.len() > 4096
            || params.context_lines > 5
            || !(1..=1000).contains(&params.max_results)
            || params
                .glob
                .as_ref()
                .is_some_and(|g| g.is_empty() || g.len() > 1024)
        {
            return Err(invalid_search("invalid search parameters: pattern must be 1-4096 bytes, glob 1-1024 bytes, contextLines 0-5, maxResults 1-1000"));
        }
        let relative = normalize_workspace_dir_path(&params.path)?;
        if relative
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
        {
            return Err(invalid_search("searching .git metadata is not supported"));
        }
        let root = canonicalize_workspace_root(&self.root)?;
        let target = workspace_dir_absolute_path(&root, &relative);
        ensure_inside_canonical_workspace(&root, &target)?;
        let metadata =
            std::fs::symlink_metadata(&target).map_err(|e| search_io("inspect search path", e))?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_search("search path must not be a symbolic link"));
        }
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(invalid_search(
                "search path must be a regular file or directory",
            ));
        }
        let mut command = search_command(&bundled_binary()?, &root, &relative, &params);
        let mut result = SearchResult {
            entries: Vec::new(),
            match_count: 0,
            truncated: false,
            stop_reason: "complete",
            scope: json!({
                "path": relative, "glob": params.glob,
                "includeHidden": params.include_hidden, "includeIgnored": params.include_ignored,
                "binaryFiles": "skipped", "followSymlinks": false, "excludedDirectories": [".git"],
                "explicitFile": metadata.is_file(), "maxOutputBytes": MAX_OUTPUT_BYTES,
            }),
        };
        let mut output_bytes = 0;
        let execution = process::run(
            &mut command,
            cancellation.as_deref(),
            SEARCH_TIMEOUT,
            |line| {
                let event: Value = serde_json::from_slice(line)
                    .map_err(|e| search_io("decode ripgrep JSON", e))?;
                let kind = event["type"]
                    .as_str()
                    .ok_or_else(|| invalid_search("ripgrep event has no type"))?;
                match kind {
                    "begin" | "end" | "summary" => return Ok(true),
                    "match" | "context" => {}
                    _ => return Err(invalid_search("unsupported ripgrep JSON event")),
                }
                if kind == "match" && result.match_count == params.max_results {
                    result.stop_reason = "result_limit";
                    return Ok(false);
                }
                let data = &event["data"];
                let entry = SearchEntry {
                    path: json_text(&data["path"])?
                        .replace('\\', "/")
                        .trim_start_matches("./")
                        .to_string(),
                    line: data["line_number"]
                        .as_u64()
                        .ok_or_else(|| invalid_search("ripgrep match has no line number"))?,
                    text: json_text(&data["lines"])?
                        .trim_end_matches(['\r', '\n'])
                        .to_string(),
                    kind: kind.into(),
                };
                let size = serde_json::to_vec(&entry)
                    .map_err(|e| search_io("serialize search match", e))?
                    .len()
                    + 1;
                if output_bytes + size > MAX_OUTPUT_BYTES {
                    result.stop_reason = "output_limit";
                    return Ok(false);
                }
                output_bytes += size;
                result.match_count += usize::from(kind == "match");
                result.entries.push(entry);
                Ok(true)
            },
        )?;
        if execution.record_limit {
            result.stop_reason = "output_limit";
        }
        result.truncated = result.stop_reason != "complete";
        Ok(result)
    }
}

fn json_text(value: &Value) -> Result<String, WorkerProtocolError> {
    if let Some(text) = value["text"].as_str() {
        return Ok(text.to_string());
    }
    // ripgrep uses base64 for bytes that cannot be represented as UTF-8.
    Err(filesystem_error(
        "search output contains non-UTF-8 text or paths",
        json!({"reason": "unsupported_encoding"}),
    ))
}

fn bundled_binary() -> Result<PathBuf, WorkerProtocolError> {
    #[cfg(debug_assertions)]
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!(
            "tinybot-rg-{}{}",
            env!("TINYBOT_TARGET_TRIPLE"),
            std::env::consts::EXE_SUFFIX,
        ));
    #[cfg(not(debug_assertions))]
    let path = std::env::current_exe()
        .map_err(|e| search_io("resolve application executable", e))?
        .with_file_name(format!("tinybot-rg{}", std::env::consts::EXE_SUFFIX));
    if !path.is_file() {
        return Err(filesystem_error("bundled ripgrep executable is missing; development builds must run npm run prepare:ripgrep", json!({"path": path})));
    }
    Ok(path)
}

fn search_command(binary: &Path, root: &Path, path: &str, params: &SearchParams) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(root)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .args([
            "--json",
            "--no-config",
            "--color=never",
            "--no-follow",
            "--no-ignore-global",
            "--no-require-git",
            "--threads=2",
            "--context",
        ])
        .arg(params.context_lines.to_string());
    if !params.regex {
        command.arg("--fixed-strings");
    }
    if params.ignore_case {
        command.arg("--ignore-case");
    } else {
        command.arg("--case-sensitive");
    }
    if params.include_hidden {
        command.arg("--hidden");
    }
    if params.include_ignored {
        command.arg("--no-ignore");
    }
    if let Some(glob) = &params.glob {
        command.arg("--glob").arg(glob);
    }
    command
        .arg("--glob=!.git")
        .arg("--regexp")
        .arg(&params.pattern)
        .arg("--")
        .arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
    }
    command
}

fn invalid_search(message: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        json!({}),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn search_io(operation: &str, error: impl std::fmt::Display) -> WorkerProtocolError {
    filesystem_error(
        format!("failed to {operation}"),
        json!({"error": error.to_string()}),
    )
}
