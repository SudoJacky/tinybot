use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const WORKSPACE_SYSTEM_PRECEDENCE: u32 = 300;
const PROJECT_INSTRUCTION_PRECEDENCE: u32 = 500;
const PROJECT_INSTRUCTION_MAX_BYTES: usize = 64 * 1024;
const WORKSPACE_SYSTEM_MAX_BYTES: usize = 128 * 1024;
const PROJECT_INSTRUCTION_FILE_NAME: &str = "AGENTS.md";
const PROJECT_INSTRUCTION_OVERRIDE_FILE_NAME: &str = "AGENTS.override.md";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionSourceKind {
    WorkspaceSystem,
    ProjectAgents,
    ProjectOverride,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionSource {
    pub kind: InstructionSourceKind,
    pub identifier: String,
    pub precedence: u32,
    pub scope_root: String,
    pub loaded_at_ms: u64,
    pub content_hash: String,
    pub truncated: bool,
    #[serde(default)]
    pub validation_warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SystemInstructionItem {
    pub content: String,
    pub source_index: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposedInstructions {
    pub messages: Vec<SystemInstructionItem>,
    pub sources: Vec<InstructionSource>,
    pub content_hash: String,
    pub working_directory: PathBuf,
    rendered_prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionProvenance {
    pub working_directory: String,
    pub content_hash: String,
    pub sources: Vec<InstructionSource>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDiagnostic {
    pub level: &'static str,
    pub code: &'static str,
    pub source_identifier: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct InstructionComposer {
    project_instruction_max_bytes: usize,
}

impl Default for InstructionComposer {
    fn default() -> Self {
        Self {
            project_instruction_max_bytes: PROJECT_INSTRUCTION_MAX_BYTES,
        }
    }
}

impl InstructionComposer {
    pub fn compose(
        &self,
        workspace_root: &Path,
        spec: &Value,
    ) -> Result<ComposedInstructions, String> {
        let working_directory = instruction_working_directory(spec, workspace_root)?;
        let loaded_at_ms = current_unix_ms();
        let system_content =
            crate::system_prompt::load_or_create_system_prompt_for_working_directory(
                workspace_root,
                &working_directory,
            )?;
        if system_content.len() > WORKSPACE_SYSTEM_MAX_BYTES {
            return Err(format!(
                "workspace system instructions exceed the {WORKSPACE_SYSTEM_MAX_BYTES}-byte limit: `{}`",
                workspace_root
                    .join(crate::system_prompt::SYSTEM_PROMPT_FILE_NAME)
                    .display()
            ));
        }

        let mut messages = Vec::new();
        let mut sources = Vec::new();
        push_instruction_source(
            &mut messages,
            &mut sources,
            InstructionSourceKind::WorkspaceSystem,
            workspace_root.join(crate::system_prompt::SYSTEM_PROMPT_FILE_NAME),
            workspace_root.to_path_buf(),
            WORKSPACE_SYSTEM_PRECEDENCE,
            loaded_at_ms,
            system_content,
            false,
            Vec::new(),
            false,
        );

        let mut remaining_bytes = self.project_instruction_max_bytes;
        for (depth, candidate) in project_instruction_paths(&working_directory)?
            .into_iter()
            .enumerate()
        {
            let (content, truncated, warnings, consumed_bytes) =
                read_project_instruction(&candidate.path, remaining_bytes)?;
            remaining_bytes = remaining_bytes.saturating_sub(consumed_bytes);
            push_instruction_source(
                &mut messages,
                &mut sources,
                candidate.kind,
                candidate.path,
                candidate.scope_root,
                PROJECT_INSTRUCTION_PRECEDENCE.saturating_add(depth as u32),
                loaded_at_ms,
                content,
                truncated,
                warnings,
                true,
            );
        }

        let rendered_prompt = messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let content_hash = content_hash(&rendered_prompt);
        Ok(ComposedInstructions {
            messages,
            sources,
            content_hash,
            working_directory,
            rendered_prompt,
        })
    }
}

impl ComposedInstructions {
    pub fn rendered_prompt(&self) -> &str {
        &self.rendered_prompt
    }

    pub fn provenance(&self) -> InstructionProvenance {
        InstructionProvenance {
            working_directory: self.working_directory.display().to_string(),
            content_hash: self.content_hash.clone(),
            sources: self.sources.clone(),
        }
    }

    pub fn diagnostics(&self) -> Vec<InstructionDiagnostic> {
        self.sources
            .iter()
            .flat_map(|source| {
                source
                    .validation_warnings
                    .iter()
                    .map(|message| InstructionDiagnostic {
                        level: "warning",
                        code: "instruction_source_warning",
                        source_identifier: source.identifier.clone(),
                        message: message.clone(),
                    })
            })
            .collect()
    }

    pub fn attach_diagnostics(&self, value: &mut Value) -> Result<(), String> {
        let object = value.as_object_mut().ok_or_else(|| {
            "agent result must be an object for instruction diagnostics".to_string()
        })?;
        object.insert(
            "instructionProvenance".to_string(),
            serde_json::to_value(self.provenance())
                .map_err(|error| format!("failed to serialize instruction provenance: {error}"))?,
        );
        object.insert(
            "instructionDiagnostics".to_string(),
            serde_json::to_value(self.diagnostics())
                .map_err(|error| format!("failed to serialize instruction diagnostics: {error}"))?,
        );
        Ok(())
    }
}

struct ProjectInstructionCandidate {
    path: PathBuf,
    scope_root: PathBuf,
    kind: InstructionSourceKind,
}

fn instruction_working_directory(spec: &Value, workspace_root: &Path) -> Result<PathBuf, String> {
    let candidate = instruction_string_field(spec, "cwd")
        .or_else(|| instruction_string_field(spec, "workingDirectory"))
        .or_else(|| instruction_string_field(spec, "working_directory"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| instruction_string_field(metadata, "cwd"))
        })
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| instruction_string_field(metadata, "workingDirectory"))
        })
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| instruction_string_field(metadata, "working_directory"))
        })
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.to_path_buf());
    let working_directory = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    };
    let metadata = fs::metadata(&working_directory).map_err(|error| {
        format!(
            "failed to inspect agent working directory `{}`: {error}",
            working_directory.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "agent working directory is not a directory: `{}`",
            working_directory.display()
        ));
    }
    Ok(working_directory)
}

fn project_instruction_paths(
    working_directory: &Path,
) -> Result<Vec<ProjectInstructionCandidate>, String> {
    let mut project_root = None;
    for directory in working_directory.ancestors() {
        let marker = directory.join(".git");
        match fs::metadata(&marker) {
            Ok(_) => {
                project_root = Some(directory);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect project root marker `{}`: {error}",
                    marker.display()
                ));
            }
        }
    }
    let project_root = project_root.unwrap_or(working_directory);
    let mut directories = Vec::new();
    let mut cursor = working_directory;
    loop {
        directories.push(cursor.to_path_buf());
        if cursor == project_root {
            break;
        }
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }
    directories.reverse();

    let mut candidates = Vec::new();
    for directory in directories {
        if let Some((path, kind)) = instruction_candidate_in_directory(&directory)? {
            candidates.push(ProjectInstructionCandidate {
                path,
                scope_root: directory,
                kind,
            });
        }
    }
    Ok(candidates)
}

fn instruction_candidate_in_directory(
    directory: &Path,
) -> Result<Option<(PathBuf, InstructionSourceKind)>, String> {
    for (name, kind) in [
        (
            PROJECT_INSTRUCTION_OVERRIDE_FILE_NAME,
            InstructionSourceKind::ProjectOverride,
        ),
        (
            PROJECT_INSTRUCTION_FILE_NAME,
            InstructionSourceKind::ProjectAgents,
        ),
    ] {
        let path = directory.join(name);
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => return Ok(Some((path, kind))),
            Ok(_) => {
                return Err(format!(
                    "project instruction path is not a file: `{}`",
                    path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect project instruction path `{}`: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(None)
}

fn read_project_instruction(
    path: &Path,
    remaining_bytes: usize,
) -> Result<(String, bool, Vec<String>, usize), String> {
    let file = fs::File::open(path).map_err(|error| {
        format!(
            "failed to read project instructions `{}`: {error}",
            path.display()
        )
    })?;
    let original_len = file
        .metadata()
        .map_err(|error| {
            format!(
                "failed to inspect project instructions `{}`: {error}",
                path.display()
            )
        })?
        .len();
    let read_limit = remaining_bytes.saturating_add(1) as u64;
    let mut data = Vec::with_capacity(remaining_bytes.saturating_add(1));
    file.take(read_limit)
        .read_to_end(&mut data)
        .map_err(|error| {
            format!(
                "failed to read project instructions `{}`: {error}",
                path.display()
            )
        })?;
    let truncated = original_len > remaining_bytes as u64 || data.len() > remaining_bytes;
    data.truncate(remaining_bytes);
    let consumed_bytes = data.len();
    let mut warnings = Vec::new();
    if truncated {
        warnings.push(format!(
            "project instructions were truncated from {original_len} to {consumed_bytes} bytes"
        ));
    }
    let content = match String::from_utf8(data) {
        Ok(content) => content,
        Err(error) => {
            warnings.push(
                "project instructions contained invalid UTF-8 and were decoded lossily".to_string(),
            );
            String::from_utf8_lossy(error.as_bytes()).into_owned()
        }
    };
    if content.trim().is_empty() {
        warnings.push("project instruction source is empty".to_string());
    }
    Ok((content, truncated, warnings, consumed_bytes))
}

#[allow(clippy::too_many_arguments)]
fn push_instruction_source(
    messages: &mut Vec<SystemInstructionItem>,
    sources: &mut Vec<InstructionSource>,
    kind: InstructionSourceKind,
    path: PathBuf,
    scope_root: PathBuf,
    precedence: u32,
    loaded_at_ms: u64,
    content: String,
    truncated: bool,
    validation_warnings: Vec<String>,
    wrap_project_source: bool,
) {
    let source_index = sources.len();
    let model_content = if wrap_project_source && !content.trim().is_empty() {
        format!(
            "# Project instructions from `{}`\n\n<INSTRUCTIONS>\n{}\n</INSTRUCTIONS>",
            path.display(),
            content.trim_end()
        )
    } else {
        content.clone()
    };
    sources.push(InstructionSource {
        kind,
        identifier: path.display().to_string(),
        precedence,
        scope_root: scope_root.display().to_string(),
        loaded_at_ms,
        content_hash: content_hash(&content),
        truncated,
        validation_warnings,
    });
    if !model_content.trim().is_empty() {
        messages.push(SystemInstructionItem {
            content: model_content,
            source_index,
        });
    }
}

fn instruction_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_truncation_and_invalid_utf8_without_hiding_the_source() {
        let fixture = InstructionFixture::new("diagnostics");
        fs::create_dir_all(fixture.root.join(".git")).expect("project marker should create");
        fs::write(
            fixture.root.join(PROJECT_INSTRUCTION_FILE_NAME),
            b"abc\xFFdef",
        )
        .expect("invalid UTF-8 project instructions should write");
        let composer = InstructionComposer {
            project_instruction_max_bytes: 5,
        };

        let composed = composer
            .compose(&fixture.root, &serde_json::json!({ "cwd": fixture.root }))
            .expect("lossy project instructions should compose with diagnostics");

        let project = &composed.sources[1];
        assert!(project.truncated);
        assert_eq!(project.validation_warnings.len(), 2);
        assert_eq!(composed.diagnostics().len(), 2);
        assert!(composed.rendered_prompt().contains("abc"));
    }

    struct InstructionFixture {
        root: PathBuf,
    }

    impl InstructionFixture {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "tinybot-instruction-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&root).expect("instruction fixture should create");
            Self { root }
        }
    }

    impl Drop for InstructionFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
