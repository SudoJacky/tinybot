use super::definition::{SkillAvailability, SkillDefinition};
use crate::workspace::WorkspaceSkillEntry;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillSettings {
    globally_enabled: bool,
    autoload: bool,
    allowlist: Option<HashSet<String>>,
    disabled: HashSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SkillActivation {
    Explicit,
    Autoload,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedSkill {
    pub(crate) entry: WorkspaceSkillEntry,
    pub(crate) activation: SkillActivation,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillCatalogEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) source: String,
    pub(crate) description: String,
    pub(crate) always: bool,
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) effective: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) activation: Option<SkillActivation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) missing_requirements: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct SkillResolution {
    pub(crate) catalog: Vec<SkillCatalogEntry>,
    pub(crate) active: Vec<ResolvedSkill>,
}

impl SkillSettings {
    pub(crate) fn from_config(config: &Value) -> Self {
        let skills = config.get("skills").unwrap_or(&Value::Null);
        let enabled_value = skills.get("enabled");
        let globally_enabled = enabled_value.and_then(Value::as_bool).unwrap_or(true);
        let allowlist = enabled_value.and_then(Value::as_array).and_then(|values| {
            let names = values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect::<HashSet<_>>();
            (!names.is_empty() && !names.contains("*")).then_some(names)
        });
        let disabled = skills
            .get("disabled_skills")
            .or_else(|| skills.get("disabledSkills"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect();
        Self {
            globally_enabled,
            autoload: skills
                .get("autoload")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            allowlist,
            disabled,
        }
    }

    fn enabled(&self, name: &str) -> bool {
        self.globally_enabled
            && !self.disabled.contains(name)
            && self
                .allowlist
                .as_ref()
                .is_none_or(|allowlist| allowlist.contains(name))
    }
}

pub(crate) fn resolve_skills(
    entries: Vec<WorkspaceSkillEntry>,
    config: &Value,
    selected_names: &[String],
) -> Result<SkillResolution, String> {
    let settings = SkillSettings::from_config(config);
    let selected = selected_names.iter().cloned().collect::<BTreeSet<_>>();
    let mut found_selected = BTreeSet::new();
    let mut catalog = Vec::with_capacity(entries.len());
    let mut active = Vec::new();

    for entry in entries {
        let explicit = selected.contains(&entry.name);
        if explicit {
            found_selected.insert(entry.name.clone());
        }
        let definition = match SkillDefinition::parse(&entry.content).and_then(|definition| {
            definition.validate_directory_name(&entry.name)?;
            Ok(definition)
        }) {
            Ok(definition) => definition,
            Err(error) => {
                if explicit {
                    return Err(format!(
                        "selected skill `{}` is invalid: {error}",
                        entry.name
                    ));
                }
                let enabled = settings.enabled(&entry.name);
                catalog.push(SkillCatalogEntry {
                    name: entry.name,
                    path: entry.path,
                    source: entry.source,
                    description: "Invalid skill".to_string(),
                    always: false,
                    enabled,
                    available: false,
                    effective: false,
                    activation: None,
                    reason: Some(error.to_string()),
                    missing_requirements: Vec::new(),
                });
                continue;
            }
        };
        let enabled = settings.enabled(&entry.name);
        let availability = definition.availability();
        let activation = if explicit {
            Some(SkillActivation::Explicit)
        } else if settings.autoload && definition.always {
            Some(SkillActivation::Autoload)
        } else {
            None
        };
        let effective = enabled && availability.available && activation.is_some();
        let reason = resolution_reason(enabled, &availability, activation.as_ref());

        if explicit && !enabled {
            return Err(format!("selected skill `{}` is disabled", entry.name));
        }
        if explicit && !availability.available {
            return Err(format!(
                "selected skill `{}` is unavailable: {}",
                entry.name,
                availability.missing.join(", ")
            ));
        }
        if effective {
            active.push(ResolvedSkill {
                entry: entry.clone(),
                activation: activation
                    .clone()
                    .expect("effective skills have activation"),
            });
        }
        catalog.push(SkillCatalogEntry {
            name: entry.name,
            path: entry.path,
            source: entry.source,
            description: definition.description,
            always: definition.always,
            enabled,
            available: availability.available,
            effective,
            activation,
            reason,
            missing_requirements: availability.missing,
        });
    }

    if let Some(missing) = selected.difference(&found_selected).next() {
        return Err(format!("selected skill `{missing}` does not exist"));
    }
    Ok(SkillResolution { catalog, active })
}

fn resolution_reason(
    enabled: bool,
    availability: &SkillAvailability,
    activation: Option<&SkillActivation>,
) -> Option<String> {
    if !enabled {
        Some("disabled by Skill settings".to_string())
    } else if !availability.available {
        Some(format!(
            "missing requirements: {}",
            availability.missing.join(", ")
        ))
    } else if activation.is_none() {
        Some("not selected for this turn".to_string())
    } else {
        None
    }
}

#[cfg(test)]
#[path = "resolver_tests.rs"]
mod tests;
