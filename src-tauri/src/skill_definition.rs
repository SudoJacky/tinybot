use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(default)]
struct SkillRequirements {
    bins: Vec<String>,
    env: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct TinybotMetadata {
    always: Option<bool>,
    requires: SkillRequirements,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillFrontmatter {
    name: String,
    description: String,
    #[serde(default)]
    always: Option<bool>,
    #[serde(default)]
    requires: SkillRequirements,
    #[serde(default)]
    metadata: Option<serde_yaml::Value>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillDefinition {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) always: bool,
    pub(crate) required_bins: Vec<String>,
    pub(crate) required_env: Vec<String>,
    pub(crate) body: String,
    pub(crate) frontmatter: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillAvailability {
    pub(crate) available: bool,
    pub(crate) missing: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SkillDefinitionError {
    MissingFrontmatter,
    InvalidYaml(String),
    InvalidField { field: &'static str, reason: String },
}

impl fmt::Display for SkillDefinitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingFrontmatter => {
                formatter.write_str("missing YAML frontmatter delimited by ---")
            }
            Self::InvalidYaml(error) => write!(formatter, "invalid YAML: {error}"),
            Self::InvalidField { field, reason } => write!(formatter, "invalid {field}: {reason}"),
        }
    }
}

impl std::error::Error for SkillDefinitionError {}

impl SkillDefinition {
    pub(crate) fn parse(content: &str) -> Result<Self, SkillDefinitionError> {
        let (raw_frontmatter, body) = split_skill_document(content)?;
        let parsed: SkillFrontmatter = serde_yaml::from_str(&raw_frontmatter)
            .map_err(|error| SkillDefinitionError::InvalidYaml(error.to_string()))?;
        let yaml_value: serde_yaml::Value = serde_yaml::from_str(&raw_frontmatter)
            .map_err(|error| SkillDefinitionError::InvalidYaml(error.to_string()))?;
        let frontmatter = serde_json::to_value(yaml_value)
            .map_err(|error| SkillDefinitionError::InvalidYaml(error.to_string()))?;
        if !frontmatter.is_object() {
            return Err(SkillDefinitionError::InvalidField {
                field: "frontmatter",
                reason: "expected a mapping".to_string(),
            });
        }

        let name = sanitize_single_line(&parsed.name);
        if name.is_empty() {
            return Err(SkillDefinitionError::InvalidField {
                field: "name",
                reason: "must not be empty".to_string(),
            });
        }
        if name.len() > 64 {
            return Err(SkillDefinitionError::InvalidField {
                field: "name",
                reason: "must be at most 64 bytes".to_string(),
            });
        }
        let description = sanitize_single_line(&parsed.description);
        if description.is_empty() {
            return Err(SkillDefinitionError::InvalidField {
                field: "description",
                reason: "must not be empty".to_string(),
            });
        }

        let metadata = parse_tinybot_metadata(parsed.metadata.as_ref())?;
        let mut bins = parsed.requires.bins;
        bins.extend(metadata.requires.bins);
        let mut required_env = parsed.requires.env;
        required_env.extend(metadata.requires.env);

        Ok(Self {
            name,
            description,
            always: parsed.always.or(metadata.always).unwrap_or(false),
            required_bins: normalize_requirements(bins, "requires.bins")?,
            required_env: normalize_requirements(required_env, "requires.env")?,
            body,
            frontmatter,
        })
    }

    pub(crate) fn validate_directory_name(
        &self,
        directory_name: &str,
    ) -> Result<(), SkillDefinitionError> {
        if self.name != directory_name {
            return Err(SkillDefinitionError::InvalidField {
                field: "name",
                reason: format!(
                    "skill name `{}` must match directory name `{directory_name}`",
                    self.name
                ),
            });
        }
        if normalize_skill_name(&self.name) != self.name {
            return Err(SkillDefinitionError::InvalidField {
                field: "name",
                reason: "must use lowercase letters, digits, and hyphens".to_string(),
            });
        }
        Ok(())
    }

    pub(crate) fn availability(&self) -> SkillAvailability {
        self.availability_with(command_exists, |name| env::var_os(name).is_some())
    }

    fn availability_with(
        &self,
        has_bin: impl Fn(&str) -> bool,
        has_env: impl Fn(&str) -> bool,
    ) -> SkillAvailability {
        let mut missing = self
            .required_bins
            .iter()
            .filter(|name| !has_bin(name))
            .map(|name| format!("CLI: {name}"))
            .collect::<Vec<_>>();
        missing.extend(
            self.required_env
                .iter()
                .filter(|name| !has_env(name))
                .map(|name| format!("ENV: {name}")),
        );
        SkillAvailability {
            available: missing.is_empty(),
            missing,
        }
    }
}

pub(crate) fn render_new_skill(
    name: &str,
    description: &str,
    body: &str,
    always: bool,
) -> Result<String, SkillDefinitionError> {
    let mut frontmatter = serde_json::Map::new();
    frontmatter.insert("name".to_string(), Value::String(name.to_string()));
    frontmatter.insert(
        "description".to_string(),
        Value::String(description.to_string()),
    );
    if always {
        frontmatter.insert("always".to_string(), Value::Bool(true));
    }
    render_skill_document(Value::Object(frontmatter), body)
}

pub(crate) fn update_skill_document(
    content: &str,
    description: Option<String>,
    always: Option<bool>,
    body: Option<String>,
) -> Result<String, SkillDefinitionError> {
    let definition = SkillDefinition::parse(content)?;
    let mut frontmatter = definition.frontmatter;
    let mapping =
        frontmatter
            .as_object_mut()
            .ok_or_else(|| SkillDefinitionError::InvalidField {
                field: "frontmatter",
                reason: "expected a mapping".to_string(),
            })?;
    if let Some(description) = description {
        mapping.insert("description".to_string(), Value::String(description));
    }
    if let Some(always) = always {
        mapping.insert("always".to_string(), Value::Bool(always));
    }
    render_skill_document(frontmatter, body.as_deref().unwrap_or(&definition.body))
}

fn render_skill_document(frontmatter: Value, body: &str) -> Result<String, SkillDefinitionError> {
    let yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| SkillDefinitionError::InvalidYaml(error.to_string()))?;
    Ok(format!("---\n{}---\n\n{}", yaml, body.trim()))
}

fn split_skill_document(content: &str) -> Result<(String, String), SkillDefinitionError> {
    let normalized = content.replace("\r\n", "\n");
    let Some(after_open) = normalized.strip_prefix("---\n") else {
        return Err(SkillDefinitionError::MissingFrontmatter);
    };
    let Some(end) = after_open.find("\n---") else {
        return Err(SkillDefinitionError::MissingFrontmatter);
    };
    let after_close = &after_open[end + 4..];
    if !after_close.is_empty() && !after_close.starts_with('\n') {
        return Err(SkillDefinitionError::MissingFrontmatter);
    }
    Ok((
        after_open[..end].to_string(),
        after_close.trim_start_matches('\n').trim().to_string(),
    ))
}

fn parse_tinybot_metadata(
    metadata: Option<&serde_yaml::Value>,
) -> Result<TinybotMetadata, SkillDefinitionError> {
    let Some(metadata) = metadata else {
        return Ok(TinybotMetadata::default());
    };
    match metadata {
        serde_yaml::Value::Null => Ok(TinybotMetadata::default()),
        serde_yaml::Value::String(value) => {
            serde_json::from_str(value).map_err(|error| SkillDefinitionError::InvalidField {
                field: "metadata",
                reason: format!("legacy JSON metadata is invalid: {error}"),
            })
        }
        value => serde_yaml::from_value(value.clone()).map_err(|error| {
            SkillDefinitionError::InvalidField {
                field: "metadata",
                reason: error.to_string(),
            }
        }),
    }
}

fn normalize_requirements(
    values: Vec<String>,
    field: &'static str,
) -> Result<Vec<String>, SkillDefinitionError> {
    let mut normalized = BTreeSet::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            return Err(SkillDefinitionError::InvalidField {
                field,
                reason: "entries must not be empty".to_string(),
            });
        }
        normalized.insert(value.to_string());
    }
    Ok(normalized.into_iter().collect())
}

fn sanitize_single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_skill_name(name: &str) -> String {
    let mut normalized = String::new();
    let mut previous_dash = false;
    for character in name.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character);
            previous_dash = false;
        } else if !previous_dash {
            normalized.push('-');
            previous_dash = true;
        }
    }
    normalized.trim_matches('-').to_string()
}

fn command_exists(command: &str) -> bool {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return is_executable_file(command_path);
    }
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    let candidates = executable_names(command);
    env::split_paths(&path).any(|directory| {
        candidates
            .iter()
            .any(|candidate| is_executable_file(&directory.join(candidate)))
    })
}

fn executable_names(command: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if Path::new(command).extension().is_some() {
            return vec![PathBuf::from(command)];
        }
        let extensions = env::var_os("PATHEXT")
            .and_then(|value| value.into_string().ok())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
        return extensions
            .split(';')
            .filter(|extension| !extension.trim().is_empty())
            .map(|extension| PathBuf::from(format!("{command}{}", extension.trim())))
            .chain(std::iter::once(PathBuf::from(command)))
            .collect();
    }
    #[cfg(not(windows))]
    {
        vec![PathBuf::from(command)]
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typed_yaml_and_reports_only_missing_requirements() {
        let definition = SkillDefinition::parse(
            "---\nname: review-work\ndescription: Review work\nalways: true\nrequires:\n  bins: [git, rg]\n  env:\n    - REVIEW_TOKEN\n---\nDo the review.",
        )
        .expect("typed skill should parse");

        assert_eq!(definition.name, "review-work");
        assert!(definition.always);
        assert_eq!(definition.required_bins, vec!["git", "rg"]);
        assert_eq!(definition.required_env, vec!["REVIEW_TOKEN"]);
        assert_eq!(definition.body, "Do the review.");
        assert_eq!(
            definition.availability_with(|bin| bin == "git", |_| false),
            SkillAvailability {
                available: false,
                missing: vec!["CLI: rg".to_string(), "ENV: REVIEW_TOKEN".to_string()],
            }
        );
    }

    #[test]
    fn accepts_legacy_json_metadata() {
        let definition = SkillDefinition::parse(
            "---\nname: legacy\ndescription: Legacy\nmetadata: '{\"always\":true,\"requires\":{\"bins\":[\"git\"]}}'\n---\nLegacy body",
        )
        .expect("legacy metadata should remain compatible");

        assert!(definition.always);
        assert_eq!(definition.required_bins, vec!["git"]);
    }

    #[test]
    fn update_preserves_nested_frontmatter() {
        let updated = update_skill_document(
            "---\nname: review-work\ndescription: Old\nrequires:\n  bins: [git]\n---\nOld body",
            Some("New".to_string()),
            Some(true),
            Some("New body".to_string()),
        )
        .expect("skill should update");
        let parsed = SkillDefinition::parse(&updated).expect("updated skill should parse");

        assert_eq!(parsed.description, "New");
        assert!(parsed.always);
        assert_eq!(parsed.required_bins, vec!["git"]);
        assert_eq!(parsed.body, "New body");
    }
}
