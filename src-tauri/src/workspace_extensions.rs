use crate::skills::SkillDefinition;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const WORKSPACE_SKILLS_PATHS: [[&str; 2]; 2] = [[".codex", "skills"], [".agents", "skills"]];
const WORKSPACE_MCP_PATHS: [&str; 3] = [".github/mcp.json", "mcp.json", ".mcp.json"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceSkill {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) content: String,
}

pub(crate) fn project_scope_directories(working_directory: &Path) -> Result<Vec<PathBuf>, String> {
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
    Ok(directories)
}

pub(crate) fn discover_workspace_skills(
    working_directory: &Path,
) -> Result<Vec<WorkspaceSkill>, String> {
    let mut discovered = BTreeMap::new();
    for scope_root in project_scope_directories(working_directory)? {
        for relative_path in WORKSPACE_SKILLS_PATHS {
            let skills_root = scope_root.join(relative_path[0]).join(relative_path[1]);
            let entries = match fs::read_dir(&skills_root) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "failed to enumerate workspace skills `{}`: {error}",
                        skills_root.display()
                    ));
                }
            };
            let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| {
                format!(
                    "failed to enumerate workspace skills `{}`: {error}",
                    skills_root.display()
                )
            })?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let metadata = entry.metadata().map_err(|error| {
                    format!(
                        "failed to inspect workspace skill `{}`: {error}",
                        entry.path().display()
                    )
                })?;
                if !metadata.is_dir() {
                    continue;
                }
                let skill_path = entry.path().join("SKILL.md");
                let metadata = match fs::metadata(&skill_path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!(
                            "failed to inspect workspace skill `{}`: {error}",
                            skill_path.display()
                        ));
                    }
                };
                if !metadata.is_file() {
                    return Err(format!(
                        "workspace skill path is not a file: `{}`",
                        skill_path.display()
                    ));
                }
                let content = fs::read_to_string(&skill_path).map_err(|error| {
                    format!(
                        "failed to read workspace skill `{}`: {error}",
                        skill_path.display()
                    )
                })?;
                let definition = SkillDefinition::parse(&content).map_err(|error| {
                    format!(
                        "workspace skill `{}` is invalid: {error}",
                        skill_path.display()
                    )
                })?;
                let directory_name = entry.file_name().to_string_lossy().to_string();
                definition
                    .validate_directory_name(&directory_name)
                    .map_err(|error| {
                        format!(
                            "workspace skill `{}` is invalid: {error}",
                            skill_path.display()
                        )
                    })?;
                discovered.insert(
                    definition.name.clone(),
                    WorkspaceSkill {
                        name: definition.name,
                        description: definition.description,
                        path: skill_path,
                        root: entry.path(),
                        content,
                    },
                );
            }
        }
    }
    Ok(discovered.into_values().collect())
}

pub(crate) fn merge_workspace_mcp_servers(
    config: &mut Value,
    working_directory: &Path,
) -> Result<(), String> {
    let mut discovered = Vec::new();
    for scope_root in project_scope_directories(working_directory)? {
        for relative_path in WORKSPACE_MCP_PATHS {
            let path = scope_root.join(relative_path);
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "failed to inspect workspace MCP configuration `{}`: {error}",
                        path.display()
                    ));
                }
            };
            if !metadata.is_file() {
                return Err(format!(
                    "workspace MCP configuration is not a file: `{}`",
                    path.display()
                ));
            }
            discovered.push((scope_root.clone(), path));
        }
    }
    if discovered.is_empty() {
        return Ok(());
    }

    for (scope_root, path) in discovered {
        let contents = fs::read_to_string(&path).map_err(|error| {
            format!(
                "failed to read workspace MCP configuration `{}`: {error}",
                path.display()
            )
        })?;
        let document: Value = serde_json::from_str(&contents).map_err(|error| {
            format!(
                "workspace MCP configuration `{}` is invalid JSON: {error}",
                path.display()
            )
        })?;
        let servers = workspace_mcp_servers(&document, &path)?;
        for (name, server) in servers {
            let normalized = normalize_workspace_mcp_server(name, server, &scope_root, &path)?;
            workspace_mcp_target(config)?.insert(name.clone(), normalized);
        }
    }
    Ok(())
}

fn workspace_mcp_servers<'a>(
    document: &'a Value,
    path: &Path,
) -> Result<&'a Map<String, Value>, String> {
    let object = document.as_object().ok_or_else(|| {
        format!(
            "workspace MCP configuration `{}` must contain a JSON object",
            path.display()
        )
    })?;
    object
        .get("mcpServers")
        .or_else(|| object.get("servers"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!(
                "workspace MCP configuration `{}` must contain an `mcpServers` or `servers` object",
                path.display()
            )
        })
}

fn normalize_workspace_mcp_server(
    name: &str,
    server: &Value,
    scope_root: &Path,
    source_path: &Path,
) -> Result<Value, String> {
    let mut normalized = server.as_object().cloned().ok_or_else(|| {
        format!(
            "workspace MCP server `{name}` in `{}` must be an object",
            source_path.display()
        )
    })?;
    let transport = normalized
        .get("transport")
        .or_else(|| normalized.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        transport.as_str(),
        "stdio" | "http" | "streamable_http" | "streamable-http"
    ) {
        return Err(format!(
            "workspace MCP server `{name}` in `{}` uses unsupported transport `{transport}`",
            source_path.display()
        ));
    }
    normalized.insert("transport".to_string(), Value::String(transport.clone()));
    normalized
        .entry("enabled".to_string())
        .or_insert(Value::Bool(true));
    if !normalized.contains_key("enabled_tools") && !normalized.contains_key("enabledTools") {
        normalized.insert("enabled_tools".to_string(), serde_json::json!(["*"]));
    }
    if transport == "stdio" {
        let command = normalized
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .ok_or_else(|| {
                format!(
                    "workspace MCP stdio server `{name}` in `{}` requires a command",
                    source_path.display()
                )
            })?;
        let _ = command;
        let cwd = normalized
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .map(PathBuf::from)
            .map(|cwd| {
                if cwd.is_absolute() {
                    cwd
                } else {
                    scope_root.join(cwd)
                }
            })
            .unwrap_or_else(|| scope_root.to_path_buf());
        normalized.insert("cwd".to_string(), Value::String(cwd.display().to_string()));
    }
    normalized.insert(
        "workspace_source".to_string(),
        Value::String(source_path.display().to_string()),
    );
    Ok(Value::Object(normalized))
}

fn workspace_mcp_target(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let config = config
        .as_object_mut()
        .ok_or_else(|| "Tinybot config snapshot must be an object".to_string())?;
    if config
        .get("tools")
        .and_then(|tools| tools.get("mcp_servers"))
        .is_some()
    {
        return config
            .get_mut("tools")
            .and_then(Value::as_object_mut)
            .and_then(|tools| tools.get_mut("mcp_servers"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                "Tinybot config field `tools.mcp_servers` must be an object".to_string()
            });
    }
    if config
        .get("mcp")
        .and_then(|mcp| mcp.get("servers"))
        .is_some()
        && config
            .get("tools")
            .and_then(|tools| tools.get("mcpServers"))
            .is_none()
    {
        return config
            .get_mut("mcp")
            .and_then(Value::as_object_mut)
            .and_then(|mcp| mcp.get_mut("servers"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Tinybot config field `mcp.servers` must be an object".to_string());
    }
    config
        .entry("tools")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Tinybot config field `tools` must be an object".to_string())?
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Tinybot config field `tools.mcpServers` must be an object".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-workspace-extensions-{label}-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).expect("fixture should create");
            Self { root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn discovers_agents_skills_and_lets_nested_scopes_override() {
        let fixture = Fixture::new("skills");
        fs::create_dir_all(fixture.root.join(".git")).expect("git marker should create");
        let nested = fixture.root.join("services").join("api");
        for (root, description) in [
            (&fixture.root, "Root review rules."),
            (&nested, "API review rules."),
        ] {
            let skill = root.join(".agents/skills/review-work");
            fs::create_dir_all(&skill).expect("skill directory should create");
            fs::write(
                skill.join("SKILL.md"),
                format!(
                    "---\nname: review-work\ndescription: {description}\n---\nFollow the rules.\n"
                ),
            )
            .expect("skill should write");
        }

        let skills = discover_workspace_skills(&nested).expect("skills should discover");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].description, "API review rules.");
        assert!(skills[0].path.starts_with(&nested));
    }

    #[test]
    fn discovers_codex_skills_alongside_portable_workspace_skills() {
        let fixture = Fixture::new("codex-skills");
        fs::create_dir_all(fixture.root.join(".git")).expect("git marker should create");
        for (relative_path, name, description) in [
            (
                ".codex/skills/codex-review",
                "codex-review",
                "Review through the Codex workspace catalog.",
            ),
            (
                ".agents/skills/portable-review",
                "portable-review",
                "Review through the portable workspace catalog.",
            ),
            (
                ".codex/skills/shared-review",
                "shared-review",
                "Codex-specific shared review rules.",
            ),
            (
                ".agents/skills/shared-review",
                "shared-review",
                "Portable shared review rules.",
            ),
        ] {
            let skill = fixture.root.join(relative_path);
            fs::create_dir_all(&skill).expect("skill directory should create");
            fs::write(
                skill.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {description}\n---\nFollow the rules.\n"),
            )
            .expect("skill should write");
        }

        let skills = discover_workspace_skills(&fixture.root).expect("skills should discover");
        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["codex-review", "portable-review", "shared-review"]
        );
        let shared = skills
            .iter()
            .find(|skill| skill.name == "shared-review")
            .expect("shared Skill should discover");
        assert_eq!(shared.description, "Portable shared review rules.");
        assert!(shared.path.starts_with(fixture.root.join(".agents")));
    }

    #[test]
    fn merges_common_workspace_mcp_documents_but_ignores_codex() {
        let fixture = Fixture::new("mcp");
        fs::create_dir_all(fixture.root.join(".git")).expect("git marker should create");
        fs::write(
            fixture.root.join(".mcp.json"),
            r#"{"mcpServers":{"docs":{"command":"docs-server"}}}"#,
        )
        .expect("root MCP should write");
        let nested = fixture.root.join("services/api");
        fs::create_dir_all(nested.join(".github")).expect("nested config directory should create");
        fs::write(
            nested.join(".github/mcp.json"),
            r#"{"servers":{"docs":{"type":"stdio","command":"api-docs"},"remote":{"type":"streamable-http","url":"https://example.com/mcp"}}}"#,
        )
        .expect("nested MCP should write");
        fs::create_dir_all(nested.join(".codex")).expect("ignored config directory should create");
        fs::write(
            nested.join(".codex/mcp.json"),
            r#"{"mcpServers":{"ignored":{"command":"ignored"}}}"#,
        )
        .expect("ignored MCP should write");

        let mut config = serde_json::json!({});
        merge_workspace_mcp_servers(&mut config, &nested).expect("MCP should merge");
        let servers = config["tools"]["mcpServers"]
            .as_object()
            .expect("servers should exist");
        assert_eq!(servers["docs"]["command"], "api-docs");
        assert_eq!(servers["docs"]["cwd"], nested.display().to_string());
        assert_eq!(servers["remote"]["enabled_tools"], serde_json::json!(["*"]));
        assert!(!servers.contains_key("ignored"));
    }
}
