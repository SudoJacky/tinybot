use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) const PLUGIN_SCHEMA_V1: &str =
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
pub(crate) const MCP_SCHEMA_V1: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginDiagnostic {
    pub(crate) level: &'static str,
    pub(crate) code: String,
    pub(crate) message: String,
}

impl PluginDiagnostic {
    fn warning(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            level: "warning",
            code: code.into(),
            message: message.into(),
        }
    }

    fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            level: "error",
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PluginManifest {
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    pub(crate) description: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PluginSkill {
    pub(crate) plugin_name: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) content: String,
}

impl PluginSkill {
    pub(crate) fn qualified_name(&self) -> String {
        format!("{}:{}", self.plugin_name, self.name)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PluginMcpServer {
    pub(crate) plugin_name: String,
    pub(crate) name: String,
    pub(crate) config: Value,
}

impl PluginMcpServer {
    pub(crate) fn qualified_name(&self) -> String {
        format!("plugin:{}:{}", self.plugin_name, self.name)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LoadedPlugin {
    pub(crate) root: PathBuf,
    pub(crate) manifest: PluginManifest,
    pub(crate) skills: Vec<PluginSkill>,
    pub(crate) mcp_servers: Vec<PluginMcpServer>,
    pub(crate) diagnostics: Vec<PluginDiagnostic>,
}

pub(crate) fn load_plugin(root: &Path) -> Result<LoadedPlugin, String> {
    let root = root.canonicalize().map_err(|error| {
        format!(
            "failed to resolve plugin directory {}: {error}",
            root.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "plugin root is not a directory: {}",
            root.display()
        ));
    }
    let manifest_path = contained_existing_path(&root, &root.join("plugin.json"))?;
    if !manifest_path.is_file() {
        return Err(format!(
            "plugin manifest is not a regular file: {}",
            manifest_path.display()
        ));
    }
    let manifest_value = read_json(&manifest_path, "plugin manifest")?;
    let (manifest, mut diagnostics) = validate_manifest(&manifest_value)?;
    let skills = discover_skills(&root, &manifest.name, &mut diagnostics);
    let mcp_servers = discover_mcp_servers(&root, &manifest.name, &mut diagnostics);
    Ok(LoadedPlugin {
        root,
        manifest,
        skills,
        mcp_servers,
        diagnostics,
    })
}

fn validate_manifest(value: &Value) -> Result<(PluginManifest, Vec<PluginDiagnostic>), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "plugin.json must contain a JSON object".to_string())?;
    let schema = required_string(object, "$schema", "plugin.json")?;
    if schema != PLUGIN_SCHEMA_V1 {
        return Err(format!("unsupported Agent Plugins schema `{schema}`"));
    }
    let name = required_string(object, "name", "plugin.json")?;
    validate_plugin_name(&name)?;
    let version = optional_string(object, "version", "plugin.json")?;
    let description = optional_string(object, "description", "plugin.json")?;
    for field in ["homepage", "repository", "license"] {
        optional_string(object, field, "plugin.json")?;
    }
    if let Some(author) = object.get("author") {
        validate_author(author)?;
    }
    if let Some(keywords) = object.get("keywords") {
        let values = keywords
            .as_array()
            .ok_or_else(|| "plugin.json field `keywords` must be an array".to_string())?;
        if values.iter().any(|value| !value.is_string()) {
            return Err("plugin.json field `keywords` must contain only strings".to_string());
        }
    }
    let mut diagnostics = Vec::new();
    if object
        .get("extensions")
        .is_some_and(|extensions| !extensions.is_object())
    {
        diagnostics.push(PluginDiagnostic::warning(
            "manifest.extensions_ignored",
            "plugin.json field `extensions` is not an object and was ignored",
        ));
    }
    let allowed = [
        "$schema",
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "repository",
        "license",
        "keywords",
        "extensions",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    for field in object
        .keys()
        .filter(|field| !allowed.contains(field.as_str()))
    {
        diagnostics.push(PluginDiagnostic::warning(
            "manifest.unknown_field",
            format!("unknown plugin.json field `{field}` was ignored"),
        ));
    }
    Ok((
        PluginManifest {
            name,
            version,
            description,
        },
        diagnostics,
    ))
}

fn validate_author(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "plugin.json field `author` must be an object".to_string())?;
    for field in object.keys() {
        if !matches!(field.as_str(), "name" | "email" | "url") {
            return Err(format!("plugin.json field `author.{field}` is not allowed"));
        }
    }
    for field in ["name", "email", "url"] {
        optional_string(object, field, "plugin.json author")?;
    }
    Ok(())
}

fn discover_skills(
    root: &Path,
    plugin_name: &str,
    diagnostics: &mut Vec<PluginDiagnostic>,
) -> Vec<PluginSkill> {
    let skills_path = root.join("skills");
    if !skills_path.exists() {
        return Vec::new();
    }
    let skills_root = match contained_existing_path(root, &skills_path) {
        Ok(path) if path.is_dir() => path,
        Ok(path) => {
            diagnostics.push(PluginDiagnostic::error(
                "skills.invalid_location",
                format!("skills component is not a directory: {}", path.display()),
            ));
            return Vec::new();
        }
        Err(error) => {
            diagnostics.push(PluginDiagnostic::error("skills.invalid_location", error));
            return Vec::new();
        }
    };
    let mut entries = match fs::read_dir(&skills_root) {
        Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(error) => {
            diagnostics.push(PluginDiagnostic::error(
                "skills.read_failed",
                format!("failed to read {}: {error}", skills_root.display()),
            ));
            return Vec::new();
        }
    };
    entries.sort_by_key(|entry| entry.file_name());
    let mut skills = Vec::new();
    for entry in entries {
        let skill_dir = entry.path();
        if !skill_dir.is_dir() {
            continue;
        }
        let skill_path = skill_dir.join("SKILL.md");
        if !skill_path.exists() {
            continue;
        }
        match load_skill(root, plugin_name, &skill_dir, &skill_path) {
            Ok(skill) => skills.push(skill),
            Err(error) => diagnostics.push(PluginDiagnostic::error(
                "skill.invalid",
                format!("{}: {error}", skill_path.display()),
            )),
        }
    }
    skills
}

fn load_skill(
    plugin_root: &Path,
    plugin_name: &str,
    skill_dir: &Path,
    skill_path: &Path,
) -> Result<PluginSkill, String> {
    let root = contained_existing_path(plugin_root, skill_dir)?;
    let path = contained_existing_path(plugin_root, skill_path)?;
    if !path.is_file() {
        return Err("SKILL.md is not a regular file".to_string());
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("failed to read SKILL.md: {error}"))?;
    let frontmatter = skill_frontmatter(&content)?;
    let object = frontmatter
        .as_mapping()
        .ok_or_else(|| "SKILL.md frontmatter must be a YAML mapping".to_string())?;
    let name = yaml_required_string(object, "name")?;
    validate_skill_name(&name)?;
    let directory_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "skill directory name is not valid UTF-8".to_string())?;
    if name != directory_name {
        return Err(format!(
            "skill name `{name}` must match parent directory `{directory_name}`"
        ));
    }
    let description = yaml_required_string(object, "description")?;
    if description.chars().count() > 1024 {
        return Err("skill description exceeds 1024 characters".to_string());
    }
    if let Some(value) = yaml_field(object, "compatibility") {
        let compatibility = value
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "skill compatibility must be a non-empty string".to_string())?;
        if compatibility.chars().count() > 500 {
            return Err("skill compatibility exceeds 500 characters".to_string());
        }
    }
    for field in ["license", "allowed-tools"] {
        if let Some(value) = yaml_field(object, field) {
            if !value.is_string() {
                return Err(format!("skill {field} must be a string"));
            }
        }
    }
    if let Some(value) = yaml_field(object, "metadata") {
        let metadata = value
            .as_mapping()
            .ok_or_else(|| "skill metadata must be a string map".to_string())?;
        if metadata
            .iter()
            .any(|(key, value)| !key.is_string() || !value.is_string())
        {
            return Err("skill metadata must contain only string keys and values".to_string());
        }
    }
    Ok(PluginSkill {
        plugin_name: plugin_name.to_string(),
        name,
        description,
        path,
        root,
        content,
    })
}

fn skill_frontmatter(content: &str) -> Result<serde_yaml::Value, String> {
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = normalized.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("SKILL.md must start with YAML frontmatter".to_string());
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !closed {
        return Err("SKILL.md frontmatter is not closed".to_string());
    }
    serde_yaml::from_str(&yaml).map_err(|error| format!("invalid SKILL.md frontmatter: {error}"))
}

fn discover_mcp_servers(
    root: &Path,
    plugin_name: &str,
    diagnostics: &mut Vec<PluginDiagnostic>,
) -> Vec<PluginMcpServer> {
    let mcp_path = root.join("mcp.json");
    if !mcp_path.exists() {
        return Vec::new();
    }
    let path = match contained_existing_path(root, &mcp_path) {
        Ok(path) if path.is_file() => path,
        Ok(path) => {
            diagnostics.push(PluginDiagnostic::error(
                "mcp.invalid_location",
                format!("MCP component is not a regular file: {}", path.display()),
            ));
            return Vec::new();
        }
        Err(error) => {
            diagnostics.push(PluginDiagnostic::error("mcp.invalid_location", error));
            return Vec::new();
        }
    };
    let value = match read_json(&path, "MCP configuration") {
        Ok(value) => value,
        Err(error) => {
            diagnostics.push(PluginDiagnostic::error("mcp.invalid_document", error));
            return Vec::new();
        }
    };
    let object = match validate_mcp_document(&value) {
        Ok(object) => object,
        Err(error) => {
            diagnostics.push(PluginDiagnostic::error("mcp.invalid_document", error));
            return Vec::new();
        }
    };
    let mut servers = Vec::new();
    for (name, config) in object {
        match validate_mcp_server(root, name, config) {
            Ok(()) => {
                if config.get("type").and_then(Value::as_str) == Some("sse") {
                    diagnostics.push(PluginDiagnostic::warning(
                        "mcp.unsupported_transport",
                        format!("MCP server `{name}` uses optional legacy SSE and was skipped"),
                    ));
                    continue;
                }
                servers.push(PluginMcpServer {
                    plugin_name: plugin_name.to_string(),
                    name: name.clone(),
                    config: config.clone(),
                });
            }
            Err(error) => diagnostics.push(PluginDiagnostic::error(
                "mcp.invalid_server",
                format!("MCP server `{name}` was skipped: {error}"),
            )),
        }
    }
    servers
}

fn validate_mcp_document(value: &Value) -> Result<&Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "mcp.json must contain a JSON object".to_string())?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "$schema" | "mcpServers"))
    {
        return Err("mcp.json contains an unknown top-level field".to_string());
    }
    let schema = required_string(object, "$schema", "mcp.json")?;
    if schema != MCP_SCHEMA_V1 {
        return Err(format!("unsupported MCP schema `{schema}`"));
    }
    object
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| "mcp.json field `mcpServers` must be an object".to_string())
}

fn validate_mcp_server(root: &Path, name: &str, value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "server configuration must be an object".to_string())?;
    let transport = required_string(object, "type", "MCP server")?;
    match transport.as_str() {
        "stdio" => validate_stdio_server(root, object),
        "streamable-http" | "sse" => validate_http_server(object),
        _ => Err(format!("unsupported transport `{transport}` for `{name}`")),
    }
}

fn validate_stdio_server(root: &Path, object: &Map<String, Value>) -> Result<(), String> {
    reject_unknown_fields(object, &["type", "command", "args", "env", "cwd"])?;
    let command = required_string(object, "command", "stdio MCP server")?;
    if let Some(relative) = command.strip_prefix("./") {
        contained_existing_path(root, &root.join(relative))?;
    } else if command.contains(['/', '\\']) {
        return Err("stdio command must be a bare executable or start with `./`".to_string());
    }
    if let Some(args) = object.get("args") {
        let args = args
            .as_array()
            .ok_or_else(|| "stdio args must be an array".to_string())?;
        if args.iter().any(|value| !value.is_string()) {
            return Err("stdio args must contain only strings".to_string());
        }
    }
    if let Some(env) = object.get("env") {
        let env = env
            .as_object()
            .ok_or_else(|| "stdio env must be an object".to_string())?;
        if env.contains_key("PLUGIN_ROOT") || env.contains_key("PLUGIN_DATA") {
            return Err("stdio env cannot override PLUGIN_ROOT or PLUGIN_DATA".to_string());
        }
        if env.values().any(|value| !value.is_string()) {
            return Err("stdio env values must be strings".to_string());
        }
    }
    if let Some(cwd) = object.get("cwd") {
        let cwd = cwd
            .as_str()
            .ok_or_else(|| "stdio cwd must be a string".to_string())?;
        validate_portable_cwd(cwd)?;
    }
    Ok(())
}

fn validate_http_server(object: &Map<String, Value>) -> Result<(), String> {
    reject_unknown_fields(object, &["type", "url", "headers"])?;
    let endpoint = required_string(object, "url", "HTTP MCP server")?;
    let parsed = url::Url::parse(&endpoint).map_err(|_| "MCP URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("MCP URL must use http or https and include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("MCP URL must not contain credentials or a fragment".to_string());
    }
    if let Some(headers) = object.get("headers") {
        let headers = headers
            .as_object()
            .ok_or_else(|| "MCP headers must be an object".to_string())?;
        if headers.values().any(|value| !value.is_string()) {
            return Err("MCP header values must be strings".to_string());
        }
    }
    Ok(())
}

fn validate_portable_cwd(cwd: &str) -> Result<(), String> {
    let relative = cwd
        .strip_prefix("./")
        .or_else(|| cwd.strip_prefix("${PLUGIN_ROOT}/"))
        .or_else(|| cwd.strip_prefix("${PLUGIN_DATA}/"));
    if cwd == "${PLUGIN_ROOT}" || cwd == "${PLUGIN_DATA}" {
        return Ok(());
    }
    let Some(relative) = relative else {
        return Err(
            "stdio cwd must begin with `./`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}`".to_string(),
        );
    };
    if has_parent_or_root_component(Path::new(relative)) {
        return Err("stdio cwd must remain inside its declared plugin root".to_string());
    }
    Ok(())
}

fn reject_unknown_fields(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if let Some(field) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("unknown field `{field}`"));
    }
    Ok(())
}

fn validate_plugin_name(name: &str) -> Result<(), String> {
    let length = name.chars().count();
    if !(1..=64).contains(&length)
        || !name.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '.')
        })
        || !name
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || !name
            .chars()
            .last()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || name.contains("--")
        || name.contains("..")
    {
        return Err(format!(
            "plugin name `{name}` does not satisfy Agent Plugins 1.0.0"
        ));
    }
    Ok(())
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    let length = name.chars().count();
    if !(1..=64).contains(&length)
        || !name.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        || name.starts_with('-')
        || name.ends_with('-')
        || name.contains("--")
    {
        return Err(format!("skill name `{name}` does not satisfy Agent Skills"));
    }
    Ok(())
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    document: &str,
) -> Result<String, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{document} field `{field}` must be a non-empty string"))
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
    document: &str,
) -> Result<Option<String>, String> {
    object
        .get(field)
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{document} field `{field}` must be a string"))
        })
        .transpose()
}

fn yaml_field<'a>(object: &'a serde_yaml::Mapping, field: &str) -> Option<&'a serde_yaml::Value> {
    object.get(serde_yaml::Value::String(field.to_string()))
}

fn yaml_required_string(object: &serde_yaml::Mapping, field: &str) -> Result<String, String> {
    yaml_field(object, field)
        .and_then(serde_yaml::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("skill {field} must be a non-empty string"))
}

fn read_json(path: &Path, label: &str) -> Result<Value, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {label} {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse {label} {}: {error}", path.display()))
}

fn contained_existing_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve package path {}: {error}", path.display()))?;
    if !resolved.starts_with(root) {
        return Err(format!(
            "package path escapes plugin root: {}",
            path.display()
        ));
    }
    Ok(resolved)
}

pub(crate) fn has_parent_or_root_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
