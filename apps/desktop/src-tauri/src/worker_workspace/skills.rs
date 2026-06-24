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
            "tinybot/skills",
            "builtin",
            &mut skills,
            &mut seen_names,
        )?;
        Ok(WorkspaceSkillsList { skills })
    }
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
