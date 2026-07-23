use super::*;

impl WorkerWorkspaceRpc {
    pub fn list_skills(&self) -> Result<WorkspaceSkillsList, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        Ok(WorkspaceSkillsList {
            skills: discover_skill_entries(&self.root, &self.builtin_skills_root)?,
        })
    }

    pub fn webui_list_skills(
        &self,
        config_snapshot: &serde_json::Value,
    ) -> Result<serde_json::Value, WorkerProtocolError> {
        let skills =
            crate::skills::resolve_skills(self.list_skills()?.skills, config_snapshot, &[])
                .map_err(|error| skill_error(error, 400))?
                .catalog;
        Ok(serde_json::json!({ "skills": skills }))
    }

    pub fn webui_skill_detail(&self, name: &str) -> Result<serde_json::Value, WorkerProtocolError> {
        let Some(skill) = self
            .list_skills()?
            .skills
            .into_iter()
            .find(|skill| skill.name == name)
        else {
            return Ok(serde_json::Value::Null);
        };
        let definition = crate::skills::SkillDefinition::parse(&skill.content)
            .map_err(|error| skill_error(format!("invalid skill: {error}"), 400))?;
        let availability = definition.availability();
        Ok(serde_json::json!({
            "name": name,
            "content": definition.body,
            "raw_content": skill.content,
            "metadata": definition.frontmatter,
            "tinybot_meta": {
                "always": definition.always,
                "requires": {
                    "bins": definition.required_bins,
                    "env": definition.required_env,
                }
            },
            "available": availability.available,
            "missing_requirements": availability.missing,
        }))
    }

    pub fn webui_create_skill(
        &self,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, WorkerProtocolError> {
        let body = body.as_object().cloned().unwrap_or_default();
        let name = normalize_skill_name(&truthy_json_string(body.get("name")).unwrap_or_default());
        if name.is_empty() {
            return Err(skill_error("name is required", 400));
        }
        if name.len() > 64 {
            return Err(skill_error("skill name too long (max 64 chars)", 400));
        }
        if self
            .list_skills()?
            .skills
            .iter()
            .any(|skill| skill.name == name && skill.source == "workspace")
        {
            return Err(skill_error(format!("skill '{name}' already exists"), 409));
        }
        let description = body
            .get("description")
            .map(json_value_to_string)
            .unwrap_or_else(|| format!("Custom skill: {name}"));
        let always = json_truthy(body.get("always"));
        let content = create_skill_body_content(body.get("content"), always)?;
        let contents = crate::skills::render_new_skill(
            &name,
            &description,
            &format!(
                "# {}\n\n{}",
                title_case_skill_name(&name),
                if content.is_empty() {
                    "[TODO: Add skill instructions here]"
                } else {
                    content.as_str()
                }
            ),
            always,
        )
        .map_err(|error| skill_error(format!("failed to create skill: {error}"), 400))?;
        let path = skill_file_path(&name);
        if let Err(error) = self.write_file(&path, &contents) {
            let _ = self.delete_file(&skill_dir_path(&name), true);
            return Err(skill_error(
                format!("failed to create skill: {}", error.message),
                500,
            ));
        }
        for resource in normalize_skill_resources(body.get("resources")) {
            if let Err(error) = self.create_dir(&format!("{}/{}", skill_dir_path(&name), resource))
            {
                let _ = self.delete_file(&skill_dir_path(&name), true);
                return Err(skill_error(
                    format!("failed to create skill: {}", error.message),
                    500,
                ));
            }
        }
        Ok(serde_json::json!({
            "created": true,
            "name": name,
            "path": path,
            "message": format!("Skill '{name}' created successfully"),
        }))
    }

    pub fn webui_update_skill(
        &self,
        name: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, WorkerProtocolError> {
        let path = skill_file_path(name);
        let file = self.read_file_with_options(
            &path,
            WorkspaceReadOptions {
                offset: None,
                limit: None,
                format: WorkspaceReadFormat::Raw,
            },
        )?;
        let body = body.as_object().cloned().unwrap_or_default();
        let description = body.get("description").map(json_value_to_string);
        let always = body.get("always").map(|value| json_truthy(Some(value)));
        let content = body
            .get("content")
            .map(update_skill_body_content)
            .transpose()?;
        let contents =
            crate::skills::update_skill_document(&file.content, description, always, content)
                .map_err(|error| skill_error(format!("failed to update skill: {error}"), 400))?;
        self.write_file(&path, &contents)?;
        Ok(serde_json::json!({
            "updated": true,
            "name": name,
            "path": path,
        }))
    }

    pub fn webui_delete_skill(&self, name: &str) -> Result<serde_json::Value, WorkerProtocolError> {
        let Some(skill) = self
            .list_skills()?
            .skills
            .into_iter()
            .find(|skill| skill.name == name)
        else {
            return Err(skill_error("skill not found", 404));
        };
        if skill.source == "builtin" {
            return Err(skill_error("cannot delete builtin skills", 403));
        }
        self.delete_file(&skill_dir_path(name), true)
            .map_err(|error| {
                skill_error(format!("failed to delete skill: {}", error.message), 500)
            })?;
        Ok(serde_json::json!({ "deleted": true, "name": name }))
    }

    pub fn webui_validate_skill(
        &self,
        name: &str,
    ) -> Result<serde_json::Value, WorkerProtocolError> {
        let listing = self
            .list_dir(&skill_dir_path(name), false, None)
            .map_err(|_| skill_error("skill not found", 404))?;
        let path = skill_file_path(name);
        let file = self.read_file_with_options(
            &path,
            WorkspaceReadOptions {
                offset: None,
                limit: None,
                format: WorkspaceReadFormat::Raw,
            },
        );
        let content = match file {
            Ok(file) => file.content,
            Err(_) => {
                return Ok(serde_json::json!({
                    "name": name,
                    "valid": false,
                    "message": "SKILL.md not found",
                }))
            }
        };
        let definition = match crate::skills::SkillDefinition::parse(&content) {
            Ok(definition) => definition,
            Err(error) => {
                return Ok(serde_json::json!({
                    "name": name,
                    "valid": false,
                    "message": error.to_string(),
                }));
            }
        };
        if let Err(error) = definition.validate_directory_name(name) {
            return Ok(serde_json::json!({
                "name": name,
                "valid": false,
                "message": error.to_string(),
            }));
        }
        Ok(validate_skill_children(name, &listing.entries))
    }
}

fn normalize_skill_name(name: &str) -> String {
    let mut normalized = String::new();
    let mut previous_dash = false;
    for ch in name.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            normalized.push('-');
            previous_dash = true;
        }
    }
    normalized.trim_matches('-').to_string()
}

fn truthy_json_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .filter(|value| json_truthy(Some(value)))
        .map(json_value_to_string)
}

fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        other => other.to_string().trim_matches('"').to_string(),
    }
}

fn json_truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false)) => false,
        Some(serde_json::Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(serde_json::Value::String(value)) => !value.is_empty(),
        Some(serde_json::Value::Array(values)) => !values.is_empty(),
        Some(serde_json::Value::Object(values)) => !values.is_empty(),
        Some(serde_json::Value::Bool(true)) => true,
    }
}

fn create_skill_body_content(
    value: Option<&serde_json::Value>,
    always: bool,
) -> Result<String, WorkerProtocolError> {
    match value {
        None => Ok(String::new()),
        Some(serde_json::Value::String(value)) => Ok(value.clone()),
        Some(value) if !json_truthy(Some(value)) => Ok(String::new()),
        Some(value) => Err(skill_error(
            format!(
                "failed to create skill: sequence item {}: expected str instance, {} found",
                if always { 8 } else { 7 },
                compat_type_name(value)
            ),
            500,
        )),
    }
}

fn update_skill_body_content(value: &serde_json::Value) -> Result<String, WorkerProtocolError> {
    match value {
        serde_json::Value::String(value) => Ok(value.clone()),
        other => Err(skill_error(
            format!(
                "can only concatenate str (not \"{}\") to str",
                compat_type_name(other)
            ),
            500,
        )),
    }
}

fn compat_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "NoneType",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(number) if number.is_i64() || number.is_u64() => "int",
        serde_json::Value::Number(_) => "float",
        serde_json::Value::String(_) => "str",
        serde_json::Value::Array(_) => "list",
        serde_json::Value::Object(_) => "dict",
    }
}

fn title_case_skill_name(name: &str) -> String {
    name.split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn skill_dir_path(name: &str) -> String {
    format!("skills/{name}")
}

fn skill_file_path(name: &str) -> String {
    format!("{}/SKILL.md", skill_dir_path(name))
}

fn normalize_skill_resources(value: Option<&serde_json::Value>) -> Vec<String> {
    let Some(serde_json::Value::Array(values)) = value else {
        return Vec::new();
    };
    let mut resources = Vec::new();
    for value in values {
        let Some(value) = value.as_str() else {
            continue;
        };
        if matches!(value, "scripts" | "references" | "assets")
            && !resources.iter().any(|resource| resource == value)
        {
            resources.push(value.to_string());
        }
    }
    resources
}

fn validate_skill_children(name: &str, entries: &[WorkspaceDirectoryEntry]) -> serde_json::Value {
    for entry in entries {
        let trimmed_path = entry.path.trim_end_matches('/');
        let child = trimmed_path.rsplit('/').next().unwrap_or(trimmed_path);
        if child == "SKILL.md"
            || entry.kind == "symlink"
            || (entry.kind == "dir" && matches!(child, "scripts" | "references" | "assets"))
        {
            continue;
        }
        return serde_json::json!({
            "name": name,
            "valid": false,
            "message": format!("Unexpected file/directory: {child}. Only scripts/, references/, assets/ allowed"),
        });
    }
    serde_json::json!({ "name": name, "valid": true, "message": "Skill is valid" })
}

fn skill_error(message: impl Into<String>, status: u16) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        serde_json::json!({ "status": status }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
pub(crate) fn discover_skill_entries(
    workspace_root: &Path,
    builtin_skills_root: &Path,
) -> Result<Vec<WorkspaceSkillEntry>, WorkerProtocolError> {
    let workspace_root = canonicalize_workspace_root(workspace_root)?;
    let builtin_skills_root = canonicalize_workspace_root(builtin_skills_root)?;
    let mut skills = Vec::new();
    let mut seen_names = Vec::new();
    collect_skill_entries(
        &workspace_root,
        "skills",
        "workspace",
        &mut skills,
        &mut seen_names,
    )?;
    collect_skill_entries(
        &builtin_skills_root,
        "builtin-skills",
        "builtin",
        &mut skills,
        &mut seen_names,
    )?;
    Ok(skills)
}

fn collect_skill_entries(
    root: &Path,
    relative_dir: &str,
    source: &str,
    skills: &mut Vec<WorkspaceSkillEntry>,
    seen_names: &mut Vec<String>,
) -> Result<(), WorkerProtocolError> {
    let absolute_dir = workspace_dir_absolute_path(root, relative_dir);
    if !absolute_dir.exists() || !absolute_dir.is_dir() {
        return Ok(());
    }
    ensure_inside_canonical_workspace(root, &absolute_dir)?;

    let mut entries = std::fs::read_dir(&absolute_dir)
        .map_err(|error| {
            filesystem_error(
                "failed to list skills directory",
                serde_json::json!({
                    "path": relative_dir,
                    "error": error.to_string(),
                }),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            filesystem_error(
                "failed to inspect skills directory entry",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            filesystem_error(
                "failed to read skill metadata",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if seen_names.iter().any(|seen| seen == &name) {
            continue;
        }
        let skill_file = path.join("SKILL.md");
        if !skill_file.is_file() {
            continue;
        }
        ensure_inside_canonical_workspace(root, &skill_file)?;
        let canonical_skill_file = skill_file.canonicalize().map_err(|error| {
            filesystem_error(
                "failed to resolve skill file",
                serde_json::json!({
                    "path": skill_file.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })?;
        let content = std::fs::read_to_string(&canonical_skill_file).map_err(|error| {
            filesystem_error(
                "failed to read skill file",
                serde_json::json!({
                    "path": skill_file.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })?;
        seen_names.push(name.clone());
        skills.push(WorkspaceSkillEntry {
            name,
            path: workspace_relative_path(root, &canonical_skill_file)?,
            source: source.to_string(),
            content,
        });
    }
    Ok(())
}
