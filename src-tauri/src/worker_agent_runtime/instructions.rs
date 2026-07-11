use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const BUILTIN_IDENTITY_PRECEDENCE: u32 = 100;
const WORKSPACE_SYSTEM_PRECEDENCE: u32 = 300;
const TURN_DEVELOPER_PRECEDENCE: u32 = 200;
const WORKSPACE_SOUL_PRECEDENCE: u32 = 400;
const WORKSPACE_USER_PRECEDENCE: u32 = 410;
const WORKSPACE_TOOLS_PRECEDENCE: u32 = 420;
const PROJECT_INSTRUCTION_PRECEDENCE: u32 = 500;
const SELECTED_SKILL_PRECEDENCE: u32 = 700;
const COLLABORATION_PRECEDENCE: u32 = 800;
const AGENT_ROLE_PRECEDENCE: u32 = 810;
const RUNTIME_ENVIRONMENT_PRECEDENCE: u32 = 900;
const PROJECT_INSTRUCTION_MAX_BYTES: usize = 64 * 1024;
const WORKSPACE_SYSTEM_MAX_BYTES: usize = 128 * 1024;
const WORKSPACE_PROFILE_MAX_BYTES: usize = 64 * 1024;
const PROJECT_INSTRUCTION_FILE_NAME: &str = "AGENTS.md";
const PROJECT_INSTRUCTION_OVERRIDE_FILE_NAME: &str = "AGENTS.override.md";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionSourceKind {
    BuiltInIdentity,
    TurnDeveloper,
    WorkspaceSystem,
    WorkspaceSoul,
    WorkspaceUser,
    WorkspaceTools,
    ProjectAgents,
    ProjectOverride,
    SelectedSkill,
    CollaborationMode,
    AgentRole,
    RuntimeEnvironment,
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
            InstructionSourceKind::BuiltInIdentity,
            PathBuf::from("builtin:identity"),
            workspace_root.to_path_buf(),
            BUILTIN_IDENTITY_PRECEDENCE,
            loaded_at_ms,
            "You are Tinybot, a local-first AI assistant running on the user's machine."
                .to_string(),
            false,
            Vec::new(),
            false,
        );
        if let Some(content) = optional_turn_instruction(
            spec,
            &["developerInstructions", "developer_instructions"],
            "developer instructions",
        )? {
            push_instruction_source(
                &mut messages,
                &mut sources,
                InstructionSourceKind::TurnDeveloper,
                PathBuf::from("turn:developer"),
                working_directory.clone(),
                TURN_DEVELOPER_PRECEDENCE,
                loaded_at_ms,
                content,
                false,
                Vec::new(),
                false,
            );
        }
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

        for (file_name, kind, precedence) in [
            (
                "SOUL.md",
                InstructionSourceKind::WorkspaceSoul,
                WORKSPACE_SOUL_PRECEDENCE,
            ),
            (
                "USER.md",
                InstructionSourceKind::WorkspaceUser,
                WORKSPACE_USER_PRECEDENCE,
            ),
            (
                "TOOLS.md",
                InstructionSourceKind::WorkspaceTools,
                WORKSPACE_TOOLS_PRECEDENCE,
            ),
        ] {
            let path = workspace_root.join(file_name);
            let Some((content, warnings)) = read_optional_workspace_instruction(&path)? else {
                continue;
            };
            push_instruction_source(
                &mut messages,
                &mut sources,
                kind,
                path,
                workspace_root.to_path_buf(),
                precedence,
                loaded_at_ms,
                content,
                false,
                warnings,
                false,
            );
        }

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

        for (index, skill_name) in selected_skill_names(spec)?.into_iter().enumerate() {
            let (path, scope_root) = selected_skill_path(workspace_root, &skill_name)?;
            let (content, warnings) = read_optional_workspace_instruction(&path)?
                .ok_or_else(|| format!("selected skill `{skill_name}` does not exist"))?;
            push_instruction_source(
                &mut messages,
                &mut sources,
                InstructionSourceKind::SelectedSkill,
                path,
                scope_root,
                SELECTED_SKILL_PRECEDENCE.saturating_add(index as u32),
                loaded_at_ms,
                content,
                false,
                warnings,
                false,
            );
        }

        if let Some(content) = optional_turn_instruction(
            spec,
            &["collaborationMode", "collaboration_mode"],
            "collaboration mode instructions",
        )? {
            push_instruction_source(
                &mut messages,
                &mut sources,
                InstructionSourceKind::CollaborationMode,
                PathBuf::from("turn:collaboration"),
                working_directory.clone(),
                COLLABORATION_PRECEDENCE,
                loaded_at_ms,
                content,
                false,
                Vec::new(),
                false,
            );
        }
        if let Some(content) = optional_turn_instruction(
            spec,
            &["agentRole", "agent_role"],
            "agent role instructions",
        )? {
            push_instruction_source(
                &mut messages,
                &mut sources,
                InstructionSourceKind::AgentRole,
                PathBuf::from("turn:agent_role"),
                working_directory.clone(),
                AGENT_ROLE_PRECEDENCE,
                loaded_at_ms,
                content,
                false,
                Vec::new(),
                false,
            );
        }
        push_instruction_source(
            &mut messages,
            &mut sources,
            InstructionSourceKind::RuntimeEnvironment,
            PathBuf::from("runtime:environment"),
            working_directory.clone(),
            RUNTIME_ENVIRONMENT_PRECEDENCE,
            loaded_at_ms,
            format!(
                "# Runtime environment\n\n- Working directory: `{}`\n- Operating system: `{}`",
                working_directory.display(),
                std::env::consts::OS
            ),
            false,
            Vec::new(),
            false,
        );

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

fn selected_skill_names(spec: &Value) -> Result<Vec<String>, String> {
    let value = std::iter::once(spec)
        .chain(spec.get("metadata"))
        .find_map(|source| {
            ["selectedSkills", "selected_skills"]
                .iter()
                .find_map(|key| source.get(*key))
        });
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| "selected skills must be an array of names".to_string())?;
    let mut names = Vec::with_capacity(values.len());
    for value in values {
        let name = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "selected skills must contain non-empty strings".to_string())?;
        if !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        {
            return Err(format!("selected skill name is invalid: `{name}`"));
        }
        if names.iter().any(|existing| existing == name) {
            return Err(format!("selected skill is duplicated: `{name}`"));
        }
        names.push(name.to_string());
    }
    Ok(names)
}

fn selected_skill_path(
    workspace_root: &Path,
    skill_name: &str,
) -> Result<(PathBuf, PathBuf), String> {
    for (root, relative_root) in [
        (workspace_root.to_path_buf(), "skills"),
        (crate::repo_root(), "builtin-skills"),
    ] {
        let path = root.join(relative_root).join(skill_name).join("SKILL.md");
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => return Ok((path, root)),
            Ok(_) => {
                return Err(format!(
                    "selected skill instruction path is not a file: `{}`",
                    path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect selected skill `{}`: {error}",
                    path.display()
                ));
            }
        }
    }
    Err(format!("selected skill `{skill_name}` does not exist"))
}

fn optional_turn_instruction(
    spec: &Value,
    keys: &[&str],
    label: &str,
) -> Result<Option<String>, String> {
    let value = std::iter::once(spec)
        .chain(spec.get("metadata"))
        .find_map(|source| keys.iter().find_map(|key| source.get(*key)));
    let Some(value) = value else {
        return Ok(None);
    };
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| format!("{label} must be a non-empty string"))
}

fn read_optional_workspace_instruction(
    path: &Path,
) -> Result<Option<(String, Vec<String>)>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to inspect workspace instructions `{}`: {error}",
                path.display()
            ));
        }
    };
    if !metadata.is_file() {
        return Err(format!(
            "workspace instruction path is not a file: `{}`",
            path.display()
        ));
    }
    if metadata.len() > WORKSPACE_PROFILE_MAX_BYTES as u64 {
        return Err(format!(
            "workspace instructions exceed the {WORKSPACE_PROFILE_MAX_BYTES}-byte limit: `{}`",
            path.display()
        ));
    }
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read workspace instructions `{}`: {error}",
            path.display()
        )
    })?;
    let warnings = if content.trim().is_empty() {
        vec!["workspace instruction source is empty".to_string()]
    } else {
        Vec::new()
    };
    Ok(Some((content, warnings)))
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

        let project = composed
            .sources
            .iter()
            .find(|source| source.kind == InstructionSourceKind::ProjectAgents)
            .expect("project instructions should have provenance");
        assert!(project.truncated);
        assert_eq!(project.validation_warnings.len(), 2);
        assert_eq!(composed.diagnostics().len(), 2);
        assert!(composed.rendered_prompt().contains("abc"));
    }

    #[test]
    fn composes_editable_workspace_identity_user_and_tool_instructions() {
        let fixture = InstructionFixture::new("workspace-profile");
        fs::write(fixture.root.join("SOUL.md"), "Keep a calm, direct voice.\n")
            .expect("assistant identity instructions should write");
        fs::write(
            fixture.root.join("USER.md"),
            "The user prefers concise answers.\n",
        )
        .expect("user instructions should write");
        fs::write(
            fixture.root.join("TOOLS.md"),
            "Inspect real files before reporting success.\n",
        )
        .expect("tool instructions should write");

        let composed = InstructionComposer::default()
            .compose(&fixture.root, &serde_json::json!({ "cwd": fixture.root }))
            .expect("editable workspace instructions should compose");

        let identifiers = composed
            .sources
            .iter()
            .map(|source| {
                Path::new(&source.identifier)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&source.identifier)
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            identifiers,
            [
                "builtin:identity",
                "SYSTEM.md",
                "SOUL.md",
                "USER.md",
                "TOOLS.md",
                "runtime:environment"
            ]
        );
        let prompt = composed.rendered_prompt();
        let soul = prompt
            .find("Keep a calm, direct voice.")
            .expect("assistant identity instructions should be visible");
        let user = prompt
            .find("The user prefers concise answers.")
            .expect("user instructions should be visible");
        let tools = prompt
            .find("Inspect real files before reporting success.")
            .expect("tool instructions should be visible");
        assert!(soul < user && user < tools);
    }

    #[test]
    fn composes_explicit_turn_developer_instructions_before_workspace_system() {
        let fixture = InstructionFixture::new("turn-developer");
        fs::write(
            fixture
                .root
                .join(crate::system_prompt::SYSTEM_PROMPT_FILE_NAME),
            "Workspace system instructions.\n",
        )
        .expect("workspace system instructions should write");

        let composed = InstructionComposer::default()
            .compose(
                &fixture.root,
                &serde_json::json!({
                    "cwd": fixture.root,
                    "developerInstructions": "Use the native runtime for this turn."
                }),
            )
            .expect("turn developer instructions should compose");

        assert_eq!(composed.sources[0].identifier, "builtin:identity");
        assert_eq!(composed.sources[1].identifier, "turn:developer");
        assert_eq!(
            composed.sources[2].identifier,
            fixture.root.join("SYSTEM.md").display().to_string()
        );
        let prompt = composed.rendered_prompt();
        let developer = prompt
            .find("Use the native runtime for this turn.")
            .expect("developer instructions should be visible");
        let workspace = prompt
            .find("Workspace system instructions.")
            .expect("workspace system instructions should be visible");
        assert!(developer < workspace);
    }

    #[test]
    fn composes_selected_workspace_skill_with_provenance() {
        let fixture = InstructionFixture::new("selected-skill");
        let skill_dir = fixture.root.join("skills").join("review-work");
        fs::create_dir_all(&skill_dir).expect("selected skill directory should create");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: review-work\n---\nReview the actual diff before reporting.\n",
        )
        .expect("selected skill should write");

        let composed = InstructionComposer::default()
            .compose(
                &fixture.root,
                &serde_json::json!({
                    "cwd": fixture.root,
                    "selectedSkills": ["review-work"]
                }),
            )
            .expect("selected skill should compose");

        let skill_source = composed
            .sources
            .iter()
            .find(|source| {
                source.identifier.ends_with("skills\\review-work\\SKILL.md")
                    || source.identifier.ends_with("skills/review-work/SKILL.md")
            })
            .expect("selected skill provenance should be recorded");
        assert_eq!(skill_source.scope_root, fixture.root.display().to_string());
        assert!(composed
            .rendered_prompt()
            .contains("Review the actual diff before reporting."));
    }

    #[test]
    fn composes_identity_role_collaboration_and_runtime_facts() {
        let fixture = InstructionFixture::new("turn-world-state");

        let composed = InstructionComposer::default()
            .compose(
                &fixture.root,
                &serde_json::json!({
                    "cwd": fixture.root,
                    "collaborationMode": "Work as the primary implementation agent.",
                    "agentRole": "Own the result through verification."
                }),
            )
            .expect("turn world state should compose");

        let identifiers = composed
            .sources
            .iter()
            .map(|source| source.identifier.as_str())
            .collect::<Vec<_>>();
        assert_eq!(identifiers[0], "builtin:identity");
        assert!(identifiers.contains(&"turn:collaboration"));
        assert!(identifiers.contains(&"turn:agent_role"));
        assert_eq!(identifiers.last(), Some(&"runtime:environment"));
        let prompt = composed.rendered_prompt();
        assert!(prompt.contains("You are Tinybot"));
        assert!(prompt.contains("Work as the primary implementation agent."));
        assert!(prompt.contains("Own the result through verification."));
        assert!(prompt.contains(&fixture.root.display().to_string()));
        assert!(prompt.contains(std::env::consts::OS));
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
