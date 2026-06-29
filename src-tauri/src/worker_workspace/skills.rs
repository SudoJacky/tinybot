impl WorkerWorkspaceRpc {
    pub fn list_skills(&self) -> Result<WorkspaceSkillsList, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let root = canonicalize_workspace_root(&self.root)?;
        let builtin_skills_root = canonicalize_workspace_root(&self.builtin_skills_root)?;
        let mut skills = Vec::new();
        let mut seen_names = Vec::new();
        collect_skill_entries(&root, "skills", "workspace", &mut skills, &mut seen_names)?;
        collect_skill_entries(
            &builtin_skills_root,
            "workers/ts-agent-worker/skills",
            "builtin",
            &mut skills,
            &mut seen_names,
        )?;
        Ok(WorkspaceSkillsList { skills })
    }

    pub fn webui_list_skills(
        &self,
        enabled_skills: Option<Vec<String>>,
    ) -> Result<serde_json::Value, WorkerProtocolError> {
        let skills = self
            .list_skills()?
            .skills
            .into_iter()
            .map(|skill| webui_skill_list_item(skill, enabled_skills.as_deref()))
            .collect::<Vec<_>>();
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
        let metadata = parse_skill_frontmatter(&skill.content).unwrap_or_default();
        let tinybot_meta = skill_tinybot_meta(&metadata);
        Ok(serde_json::json!({
            "name": name,
            "content": strip_skill_frontmatter(&skill.content),
            "raw_content": skill.content,
            "metadata": metadata,
            "tinybot_meta": tinybot_meta,
            "available": skill_missing_requirements(&tinybot_meta).is_empty(),
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
        let contents = create_skill_content(&name, &description, &content, always);
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
        let contents = update_skill_content(&file.content, name, &body)?;
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
        let Some(frontmatter) = parse_skill_frontmatter(&content) else {
            return Ok(serde_json::json!({
                "name": name,
                "valid": false,
                "message": "Invalid frontmatter format",
            }));
        };
        if let Some(result) = validate_skill_frontmatter(name, &frontmatter) {
            return Ok(result);
        }
        Ok(validate_skill_children(name, &listing.entries))
    }
}

fn webui_skill_list_item(
    skill: WorkspaceSkillEntry,
    enabled_skills: Option<&[String]>,
) -> serde_json::Value {
    let metadata = parse_skill_frontmatter(&skill.content).unwrap_or_default();
    let tinybot_meta = skill_tinybot_meta(&metadata);
    let missing_requirements = skill_missing_requirements(&tinybot_meta);
    let description = metadata
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or(&skill.name)
        .to_string();
    let mut item = serde_json::json!({
        "name": skill.name,
        "path": skill.path,
        "source": skill.source,
        "description": description,
        "available": missing_requirements.is_empty(),
        "enabled": skill_enabled(&skill.name, enabled_skills),
        "always": bool_metadata(metadata.get("always")),
    });
    if !missing_requirements.is_empty() {
        item["missing_requirements"] = serde_json::Value::String(missing_requirements);
    }
    item
}

fn skill_enabled(name: &str, enabled_skills: Option<&[String]>) -> bool {
    enabled_skills.is_none_or(|skills| {
        skills.is_empty()
            || skills.iter().any(|skill| skill == "*")
            || skills.iter().any(|skill| skill == name)
    })
}

fn parse_skill_frontmatter(content: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let content = content.strip_prefix("---")?;
    let content = content
        .strip_prefix("\r\n")
        .or_else(|| content.strip_prefix('\n'))?;
    let end = content.find("\n---").or_else(|| content.find("\r\n---"))?;
    let raw = &content[..end];
    let mut metadata = serde_json::Map::new();
    for line in raw.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        metadata.insert(
            key.to_string(),
            serde_json::Value::String(
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            ),
        );
    }
    Some(metadata)
}

fn strip_skill_frontmatter(content: &str) -> String {
    let Some(content_without_open) = content.strip_prefix("---") else {
        return content.trim().to_string();
    };
    let Some(content_without_open) = content_without_open
        .strip_prefix("\r\n")
        .or_else(|| content_without_open.strip_prefix('\n'))
    else {
        return content.trim().to_string();
    };
    let Some(end) = content_without_open
        .find("\n---")
        .or_else(|| content_without_open.find("\r\n---"))
    else {
        return content.trim().to_string();
    };
    let after_marker = &content_without_open[end + 4..];
    after_marker.trim().to_string()
}

fn skill_tinybot_meta(
    metadata: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut result = metadata
        .get("metadata")
        .and_then(|value| value.as_str())
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if !result.contains_key("always") {
        if let Some(always) = metadata.get("always") {
            result.insert(
                "always".to_string(),
                serde_json::Value::Bool(bool_metadata(Some(always))),
            );
        }
    }
    result
}

fn skill_missing_requirements(metadata: &serde_json::Map<String, serde_json::Value>) -> String {
    let Some(requires) = metadata.get("requires").and_then(|value| value.as_object()) else {
        return String::new();
    };
    let mut missing = Vec::new();
    for bin in requires
        .get("bins")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
    {
        missing.push(format!("CLI: {bin}"));
    }
    for env in requires
        .get("env")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
    {
        if std::env::var_os(env).is_none() {
            missing.push(format!("ENV: {env}"));
        }
    }
    missing.join(", ")
}

fn bool_metadata(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(|value| {
            value
                .as_bool()
                .or_else(|| value.as_str().map(json_string_truthy))
        })
        .unwrap_or(false)
}

fn json_string_truthy(value: &str) -> bool {
    !matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "" | "false" | "0"
    )
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

fn create_skill_content(name: &str, description: &str, content: &str, always: bool) -> String {
    let mut lines = vec![
        "---".to_string(),
        format!("name: {name}"),
        format!("description: {description}"),
    ];
    if always {
        lines.push("always: true".to_string());
    }
    lines.extend([
        "---".to_string(),
        String::new(),
        format!("# {}", title_case_skill_name(name)),
        String::new(),
        if content.is_empty() {
            "[TODO: Add skill instructions here]".to_string()
        } else {
            content.to_string()
        },
    ]);
    lines.join("\n")
}

fn update_skill_content(
    current_content: &str,
    name: &str,
    body: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, WorkerProtocolError> {
    let (metadata, body_content) = split_skill_frontmatter_for_update(current_content);
    let mut lines = vec!["---".to_string()];
    if metadata.is_empty() {
        lines.push(format!("name: {name}"));
        lines.push(format!(
            "description: {}",
            body.get("description")
                .map(json_value_to_string)
                .unwrap_or_else(|| name.to_string())
        ));
        if body
            .get("always")
            .is_some_and(|value| json_truthy(Some(value)))
        {
            lines.push("always: true".to_string());
        }
    } else {
        let mut saw_description = false;
        let mut saw_always = false;
        for (key, value) in metadata {
            if key == "description" {
                saw_description = true;
                if let Some(description) = body.get("description") {
                    lines.push(format!(
                        "description: {}",
                        json_value_to_string(description)
                    ));
                } else {
                    lines.push(format!("{key}: {value}"));
                }
            } else if key == "always" {
                saw_always = true;
                if let Some(always) = body.get("always") {
                    lines.push(format!("always: {}", json_truthy(Some(always))));
                } else {
                    lines.push(format!("{key}: {value}"));
                }
            } else {
                lines.push(format!("{key}: {value}"));
            }
        }
        if !saw_description {
            if let Some(description) = body.get("description") {
                lines.push(format!(
                    "description: {}",
                    json_value_to_string(description)
                ));
            }
        }
        if !saw_always {
            if let Some(always) = body.get("always") {
                lines.push(format!("always: {}", json_truthy(Some(always))));
            }
        }
    }
    lines.push("---".to_string());
    let next_body = if let Some(content) = body.get("content") {
        update_skill_body_content(content)?
    } else {
        body_content.trim().to_string()
    };
    Ok(format!("{}\n{}", lines.join("\n"), next_body))
}

fn split_skill_frontmatter_for_update(content: &str) -> (Vec<(String, String)>, String) {
    let Some(content_without_open) = content.strip_prefix("---\n") else {
        return (Vec::new(), content.to_string());
    };
    let Some(end) = content_without_open.find("\n---\n") else {
        return (Vec::new(), content.to_string());
    };
    let raw = &content_without_open[..end];
    let body = content_without_open[end + 5..].trim().to_string();
    let metadata = raw
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    (metadata, body)
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

fn validate_skill_frontmatter(
    name: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
) -> Option<serde_json::Value> {
    let skill_name = frontmatter.get("name").and_then(|value| value.as_str());
    if skill_name.is_none() {
        return Some(serde_json::json!({
            "name": name,
            "valid": false,
            "message": "Missing 'name' in frontmatter",
        }));
    }
    if !frontmatter.contains_key("description") {
        return Some(serde_json::json!({
            "name": name,
            "valid": false,
            "message": "Missing 'description' in frontmatter",
        }));
    }
    let skill_name = skill_name.unwrap_or_default();
    if skill_name != name {
        return Some(serde_json::json!({
            "name": name,
            "valid": false,
            "message": format!("Skill name '{skill_name}' must match directory name '{name}'"),
        }));
    }
    if normalize_skill_name(skill_name) != skill_name {
        return Some(serde_json::json!({
            "name": name,
            "valid": false,
            "message": "Name should be hyphen-case (lowercase letters, digits, hyphens)",
        }));
    }
    if frontmatter
        .get("description")
        .and_then(|value| value.as_str())
        .is_none_or(|value| value.trim().is_empty())
    {
        return Some(serde_json::json!({
            "name": name,
            "valid": false,
            "message": "Description cannot be empty",
        }));
    }
    None
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
