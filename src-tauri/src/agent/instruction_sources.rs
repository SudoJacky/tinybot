//! Filesystem and plugin loading for instructions. The runtime composes only loaded values.
use crate::agent::runtime::instructions::*;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub(crate) struct InstructionLoader {
    project_instruction_max_bytes: usize,
    plugin_root: PathBuf,
}
impl Default for InstructionLoader {
    fn default() -> Self {
        Self::new(crate::config::application::tinybot_data_root().join("plugins"))
    }
}
impl InstructionLoader {
    pub(crate) fn new(plugin_root: PathBuf) -> Self {
        Self {
            project_instruction_max_bytes: PROJECT_INSTRUCTION_MAX_BYTES,
            plugin_root,
        }
    }
    #[cfg(test)]
    pub(crate) fn with_plugin_store_root(mut self, root: PathBuf) -> Self {
        self.plugin_root = root;
        self
    }
    pub(crate) fn compose(
        &self,
        root: &Path,
        spec: &Value,
    ) -> Result<ComposedInstructions, String> {
        self.compose_input(root, &TurnInstructionInput::from_wire(spec, root)?)
    }
    pub(crate) fn compose_input(
        &self,
        root: &Path,
        input: &TurnInstructionInput,
    ) -> Result<ComposedInstructions, String> {
        InstructionComposer.compose(root, input, self.load(root, &input.working_directory)?)
    }
    pub(crate) fn load(
        &self,
        root: &Path,
        working_directory: &Path,
    ) -> Result<LoadedInstructionSources, String> {
        let loaded_at_ms = current_unix_ms();
        let system_content =
            crate::system_prompt::load_or_create_system_prompt_for_working_directory(
                root,
                working_directory,
            )?;
        crate::tool_notes::create_default_tool_notes_if_missing(root)?;
        let mut profiles = Vec::new();
        for (name, kind) in [
            ("SOUL.md", InstructionSourceKind::WorkspaceSoul),
            ("USER.md", InstructionSourceKind::WorkspaceUser),
            (
                crate::tool_notes::TOOL_NOTES_FILE_NAME,
                InstructionSourceKind::WorkspaceTools,
            ),
        ] {
            let path = root.join(name);
            if let Some((content, warnings)) = read_optional_workspace_instruction(&path)? {
                profiles.push(LoadedInstructionFile {
                    path,
                    scope_root: root.to_path_buf(),
                    kind,
                    content,
                    warnings,
                    truncated: false,
                });
            }
        }
        let mut projects = Vec::new();
        let mut remaining_bytes = self.project_instruction_max_bytes;
        for candidate in project_instruction_paths(working_directory)? {
            let (content, truncated, warnings, consumed_bytes) =
                read_project_instruction(&candidate.path, remaining_bytes)?;
            remaining_bytes = remaining_bytes.saturating_sub(consumed_bytes);
            projects.push(LoadedInstructionFile {
                path: candidate.path,
                scope_root: candidate.scope_root,
                kind: candidate.kind,
                content,
                truncated,
                warnings,
            });
        }
        let workspace_skills =
            crate::workspace_extensions::discover_workspace_skills(working_directory)?
                .into_iter()
                .map(|s| InstructionSkill {
                    name: s.name,
                    description: s.description,
                    path: s.path,
                    root: s.root,
                    content: s.content,
                })
                .collect();
        let plugin_skills = crate::plugins::PluginStore::new(self.plugin_root.clone())
            .enabled()
            .map_err(|error| format!("failed to discover Agent Plugin skills: {error}"))?
            .into_iter()
            .flat_map(|p| p.skills)
            .map(|s| InstructionSkill {
                name: s.qualified_name(),
                description: s.description,
                path: s.path,
                root: s.root,
                content: s.content,
            })
            .collect();
        Ok(LoadedInstructionSources {
            loaded_at_ms,
            system_content,
            profiles,
            projects,
            workspace_skills,
            plugin_skills,
            plugin_root: self.plugin_root.clone(),
        })
    }
}

const PROJECT_INSTRUCTION_OVERRIDE_FILE_NAME: &str = "AGENTS.override.md";

const PROJECT_INSTRUCTION_FILE_NAME: &str = "AGENTS.md";

const WORKSPACE_PROFILE_MAX_BYTES: usize = 64 * 1024;

const PROJECT_INSTRUCTION_MAX_BYTES: usize = 64 * 1024;

impl TurnInstructionInput {
    pub(crate) fn from_wire(spec: &Value, workspace_root: &Path) -> Result<Self, String> {
        Ok(Self {
            working_directory: instruction_working_directory(spec, workspace_root)?,
            developer: optional_turn_instruction(
                spec,
                &["developerInstructions", "developer_instructions"],
                "developer instructions",
            )?,
            collaboration: optional_turn_instruction(
                spec,
                &["collaborationMode", "collaboration_mode"],
                "collaboration mode instructions",
            )?,
            agent_role: optional_turn_instruction(
                spec,
                &["agentRole", "agent_role"],
                "agent role instructions",
            )?,
            memory_snapshot: long_term_memory_snapshot(spec)?,
            selected_skills: selected_skill_names(spec)?,
        })
    }
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
    crate::runtime::working_directory::resolve_existing_working_directory(
        workspace_root,
        &candidate,
    )
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

struct ProjectInstructionCandidate {
    path: PathBuf,
    scope_root: PathBuf,
    kind: InstructionSourceKind,
}

fn project_instruction_paths(
    working_directory: &Path,
) -> Result<Vec<ProjectInstructionCandidate>, String> {
    let mut candidates = Vec::new();
    for directory in crate::workspace_extensions::project_scope_directories(working_directory)? {
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

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn instruction_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn long_term_memory_snapshot(spec: &Value) -> Result<Option<String>, String> {
    let value = std::iter::once(spec)
        .chain(spec.get("metadata"))
        .find_map(|source| {
            source
                .get("longTermMemorySnapshot")
                .or_else(|| source.get("long_term_memory_snapshot"))
        });
    let Some(value) = value else {
        return Ok(None);
    };
    let content = value
        .as_str()
        .ok_or_else(|| "long-term memory snapshot must be a string".to_string())?;
    if content.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(content.to_string()))
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
        if !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        }) {
            return Err(format!("selected skill name is invalid: `{name}`"));
        }
        if names.iter().any(|existing| existing == name) {
            return Err(format!("selected skill is duplicated: `{name}`"));
        }
        names.push(name.to_string());
    }
    Ok(names)
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
#[cfg(test)]
#[path = "instruction_sources_tests.rs"]
mod tests;
