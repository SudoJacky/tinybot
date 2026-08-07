use super::manifest::{load_plugin, LoadedPlugin, PluginDiagnostic};
use crate::storage::atomic::{read_json_store, write_json_pretty_atomic, AtomicWriteOptions};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static INSTALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginState {
    #[serde(default = "state_schema_version")]
    schema_version: u32,
    #[serde(default)]
    plugins: BTreeMap<String, InstalledPluginState>,
}

impl Default for PluginState {
    fn default() -> Self {
        Self {
            schema_version: state_schema_version(),
            plugins: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPluginState {
    enabled: bool,
    installed_at_ms: u64,
    source_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginSkillSummary {
    pub(crate) name: String,
    pub(crate) qualified_name: String,
    pub(crate) description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginMcpSummary {
    pub(crate) name: String,
    pub(crate) qualified_name: String,
    pub(crate) transport: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginSummary {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) installed_at_ms: u64,
    pub(crate) source_path: String,
    pub(crate) install_path: String,
    pub(crate) skills: Vec<PluginSkillSummary>,
    pub(crate) mcp_servers: Vec<PluginMcpSummary>,
    pub(crate) diagnostics: Vec<PluginDiagnostic>,
    pub(crate) valid: bool,
}

pub(crate) struct EnabledPlugin {
    pub(crate) plugin: LoadedPlugin,
    pub(crate) install_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginMigrationJob {
    pub(crate) job_id: String,
    pub(crate) working_directory: String,
    pub(crate) source_directory: String,
    pub(crate) output_directory: String,
    pub(crate) detected_artifacts: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginMigrationInstallResult {
    pub(crate) plugin: PluginSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cleanup_warning: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PluginStore {
    root: PathBuf,
}

impl PluginStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn default_global() -> Self {
        Self::new(crate::config::application::tinybot_data_root().join("plugins"))
    }

    pub(crate) fn list(&self) -> Result<Vec<PluginSummary>, String> {
        let state = self.read_state()?;
        let mut plugins = Vec::with_capacity(state.plugins.len());
        for (name, installed) in state.plugins {
            let install_root = self.cache_root().join(&name);
            match load_plugin(&install_root) {
                Ok(plugin) if plugin.manifest.name == name => {
                    plugins.push(summary_from_loaded(plugin, installed, install_root));
                }
                Ok(plugin) => plugins.push(PluginSummary {
                    name: name.clone(),
                    version: plugin.manifest.version,
                    description: plugin.manifest.description,
                    enabled: installed.enabled,
                    installed_at_ms: installed.installed_at_ms,
                    source_path: installed.source_path,
                    install_path: install_root.display().to_string(),
                    skills: Vec::new(),
                    mcp_servers: Vec::new(),
                    diagnostics: vec![PluginDiagnostic {
                        level: "error",
                        code: "install.name_mismatch".to_string(),
                        message: format!(
                            "installed plugin manifest name `{}` does not match state key `{name}`",
                            plugin.manifest.name
                        ),
                    }],
                    valid: false,
                }),
                Err(error) => plugins.push(PluginSummary {
                    name,
                    version: None,
                    description: None,
                    enabled: installed.enabled,
                    installed_at_ms: installed.installed_at_ms,
                    source_path: installed.source_path,
                    install_path: install_root.display().to_string(),
                    skills: Vec::new(),
                    mcp_servers: Vec::new(),
                    diagnostics: vec![PluginDiagnostic {
                        level: "error",
                        code: "install.invalid".to_string(),
                        message: error,
                    }],
                    valid: false,
                }),
            }
        }
        Ok(plugins)
    }

    pub(crate) fn install_from_directory(&self, source: &Path) -> Result<PluginSummary, String> {
        self.install_from_directory_with_source(source, None)
    }

    fn install_from_directory_with_source(
        &self,
        source: &Path,
        source_path: Option<String>,
    ) -> Result<PluginSummary, String> {
        let source_plugin = load_plugin(source)?;
        let plugin_name = source_plugin.manifest.name.clone();
        fs::create_dir_all(self.cache_root()).map_err(|error| {
            format!(
                "failed to create plugin cache {}: {error}",
                self.cache_root().display()
            )
        })?;
        let nonce = install_nonce();
        let stage = self
            .cache_root()
            .join(format!(".install-{plugin_name}-{nonce}"));
        let backup = self
            .cache_root()
            .join(format!(".backup-{plugin_name}-{nonce}"));
        copy_plugin_directory(&source_plugin.root, &stage)?;
        match load_plugin(&stage) {
            Ok(plugin) if plugin.manifest.name == plugin_name => {}
            Ok(plugin) => {
                let _ = fs::remove_dir_all(&stage);
                return Err(format!(
                    "copied plugin changed identity from `{plugin_name}` to `{}`",
                    plugin.manifest.name
                ));
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&stage);
                return Err(format!("copied plugin failed validation: {error}"));
            }
        };
        let target = self.cache_root().join(&plugin_name);
        let mut state = self.read_state()?;
        let previous = state.plugins.get(&plugin_name).cloned();
        let had_target = target.exists();
        if had_target {
            fs::rename(&target, &backup).map_err(|error| {
                let _ = fs::remove_dir_all(&stage);
                format!("failed to stage existing plugin `{plugin_name}` for replacement: {error}")
            })?;
        }
        if let Err(error) = fs::rename(&stage, &target) {
            if had_target {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("failed to install plugin `{plugin_name}`: {error}"));
        }
        let installed_at_ms = previous.as_ref().map_or_else(now_ms, |plugin| {
            now_ms().max(plugin.installed_at_ms.saturating_add(1))
        });
        let installed = InstalledPluginState {
            enabled: previous.as_ref().map_or(true, |plugin| plugin.enabled),
            installed_at_ms,
            source_path: source_path.unwrap_or_else(|| source_plugin.root.display().to_string()),
        };
        state.plugins.insert(plugin_name.clone(), installed.clone());
        if let Err(error) = self.write_state(&state) {
            let _ = fs::remove_dir_all(&target);
            if had_target {
                let _ = fs::rename(&backup, &target);
            }
            return Err(error);
        }
        if had_target {
            fs::remove_dir_all(&backup).map_err(|error| {
                format!("plugin `{plugin_name}` was installed but its old cache could not be removed: {error}")
            })?;
        }
        let installed_plugin = load_plugin(&target).map_err(|error| {
            format!("installed plugin `{plugin_name}` could not be loaded: {error}")
        })?;
        Ok(summary_from_loaded(installed_plugin, installed, target))
    }

    pub(crate) fn prepare_migration(&self, source: &Path) -> Result<PluginMigrationJob, String> {
        let source = source.canonicalize().map_err(|error| {
            format!(
                "failed to resolve migration source {}: {error}",
                source.display()
            )
        })?;
        if !source.is_dir() {
            return Err(format!(
                "migration source is not a directory: {}",
                source.display()
            ));
        }
        if source.join("plugin.json").is_file() && load_plugin(&source).is_ok() {
            return Err(
                "this directory is already a valid Agent Plugin; use Import plugin instead"
                    .to_string(),
            );
        }
        let detected_artifacts = detect_migration_artifacts(&source);
        if detected_artifacts.is_empty() {
            return Err(
                "no standalone Skill, MCP configuration, or client plugin manifest was found in the selected directory"
                    .to_string(),
            );
        }

        fs::create_dir_all(&self.root).map_err(|error| {
            format!(
                "failed to create plugin storage {}: {error}",
                self.root.display()
            )
        })?;
        let store_root = self.root.canonicalize().map_err(|error| {
            format!(
                "failed to resolve plugin storage {}: {error}",
                self.root.display()
            )
        })?;
        if store_root.starts_with(&source) {
            return Err(
                "migration source must not contain Tinybot's global plugin storage directory"
                    .to_string(),
            );
        }

        let migrations_root = store_root.join("migrations");
        fs::create_dir_all(&migrations_root).map_err(|error| {
            format!(
                "failed to create plugin migrations directory {}: {error}",
                migrations_root.display()
            )
        })?;
        let job_id = format!("migration-{}", install_nonce());
        let job_root = migrations_root.join(&job_id);
        fs::create_dir(&job_root).map_err(|error| {
            format!(
                "failed to create plugin migration job {}: {error}",
                job_root.display()
            )
        })?;
        let source_snapshot = job_root.join("source");
        let output = job_root.join("output");
        let prepare_result = copy_plugin_directory(&source, &source_snapshot).and_then(|_| {
            fs::create_dir(&output)
                .map_err(|error| format!("failed to create migration output directory: {error}"))
        });
        if let Err(error) = prepare_result {
            let _ = fs::remove_dir_all(&job_root);
            return Err(error);
        }

        Ok(PluginMigrationJob {
            job_id,
            working_directory: job_root.display().to_string(),
            source_directory: source_snapshot.display().to_string(),
            output_directory: output.display().to_string(),
            detected_artifacts,
        })
    }

    pub(crate) fn install_migration(
        &self,
        job_id: &str,
    ) -> Result<PluginMigrationInstallResult, String> {
        let job_root = self.resolve_migration_job(job_id)?;
        let output = job_root.join("output");
        let generated = load_plugin(&output).map_err(|error| {
            format!("migration `{job_id}` output is not an installable Agent Plugin: {error}")
        })?;
        let component_errors = generated
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.level == "error")
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>();
        if !component_errors.is_empty() {
            return Err(format!(
                "migration `{job_id}` output contains invalid components: {}",
                component_errors.join("; ")
            ));
        }
        let plugin = self
            .install_from_directory_with_source(&output, Some(format!("migration:{job_id}")))
            .map_err(|error| {
                format!("migration `{job_id}` output is not an installable Agent Plugin: {error}")
            })?;
        let cleanup_warning = fs::remove_dir_all(&job_root).err().map(|error| {
            format!(
                "plugin `{}` was installed, but migration workspace {} could not be removed: {error}",
                plugin.name,
                job_root.display()
            )
        });
        Ok(PluginMigrationInstallResult {
            plugin,
            cleanup_warning,
        })
    }

    pub(crate) fn set_enabled(&self, name: &str, enabled: bool) -> Result<PluginSummary, String> {
        let mut state = self.read_state()?;
        let installed = state
            .plugins
            .get_mut(name)
            .ok_or_else(|| format!("plugin `{name}` is not installed"))?;
        if enabled {
            let plugin = load_plugin(&self.cache_root().join(name))?;
            if plugin.manifest.name != name {
                return Err(format!(
                    "installed plugin `{name}` has a mismatched manifest name"
                ));
            }
        }
        installed.enabled = enabled;
        self.write_state(&state)?;
        self.summary(name)
    }

    pub(crate) fn uninstall(&self, name: &str) -> Result<(), String> {
        let mut state = self.read_state()?;
        if state.plugins.remove(name).is_none() {
            return Err(format!("plugin `{name}` is not installed"));
        }
        let target = self.cache_root().join(name);
        let removal = self
            .cache_root()
            .join(format!(".remove-{name}-{}", install_nonce()));
        let cache_root = self
            .cache_root()
            .canonicalize()
            .unwrap_or_else(|_| self.cache_root());
        let mut cache_staged = false;
        if target.exists() {
            let resolved = target
                .canonicalize()
                .map_err(|error| format!("failed to resolve installed plugin `{name}`: {error}"))?;
            if resolved.parent() != Some(cache_root.as_path()) {
                return Err(format!(
                    "refusing to remove plugin outside the global cache: {}",
                    resolved.display()
                ));
            }
            fs::rename(&resolved, &removal).map_err(|error| {
                format!("failed to stage plugin `{name}` cache for removal: {error}")
            })?;
            cache_staged = true;
        }
        if let Err(error) = self.write_state(&state) {
            if cache_staged {
                fs::rename(&removal, &target).map_err(|restore_error| {
                    format!(
                        "{error}; plugin cache rollback also failed for `{name}`: {restore_error}"
                    )
                })?;
            }
            return Err(error);
        }
        if cache_staged {
            fs::remove_dir_all(&removal).map_err(|error| {
                format!(
                    "plugin `{name}` was uninstalled, but its old cache could not be removed: {error}"
                )
            })?;
        }
        Ok(())
    }

    pub(crate) fn enabled(&self) -> Result<Vec<LoadedPlugin>, String> {
        Ok(self
            .enabled_with_revisions()?
            .into_iter()
            .map(|enabled| enabled.plugin)
            .collect())
    }

    pub(crate) fn enabled_with_revisions(&self) -> Result<Vec<EnabledPlugin>, String> {
        let state = self.read_state()?;
        let mut plugins = Vec::new();
        for (name, installed) in state.plugins {
            if !installed.enabled {
                continue;
            }
            match load_plugin(&self.cache_root().join(&name)) {
                Ok(plugin) if plugin.manifest.name == name => plugins.push(EnabledPlugin {
                    plugin,
                    install_revision: installed.installed_at_ms,
                }),
                Ok(plugin) => eprintln!(
                    "plugin_load_skipped name={name} reason=manifest_name_mismatch actual={}",
                    plugin.manifest.name
                ),
                Err(error) => eprintln!("plugin_load_skipped name={name} error={error}"),
            }
        }
        Ok(plugins)
    }

    pub(crate) fn data_directory(&self, name: &str) -> PathBuf {
        self.data_root().join(name)
    }

    fn summary(&self, name: &str) -> Result<PluginSummary, String> {
        self.list()?
            .into_iter()
            .find(|plugin| plugin.name == name)
            .ok_or_else(|| format!("plugin `{name}` is not installed"))
    }

    fn cache_root(&self) -> PathBuf {
        self.root.join("cache")
    }

    fn data_root(&self) -> PathBuf {
        self.root.join("data")
    }

    fn resolve_migration_job(&self, job_id: &str) -> Result<PathBuf, String> {
        if !job_id.starts_with("migration-")
            || !job_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err("invalid plugin migration job id".to_string());
        }
        let migrations_root = self
            .root
            .join("migrations")
            .canonicalize()
            .map_err(|error| {
                format!(
                    "failed to resolve plugin migrations directory {}: {error}",
                    self.root.join("migrations").display()
                )
            })?;
        let job_root = migrations_root
            .join(job_id)
            .canonicalize()
            .map_err(|error| {
                format!("plugin migration `{job_id}` does not exist or is inaccessible: {error}")
            })?;
        if job_root.parent() != Some(migrations_root.as_path()) {
            return Err(format!(
                "plugin migration `{job_id}` resolves outside Tinybot's migration storage"
            ));
        }
        Ok(job_root)
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn read_state(&self) -> Result<PluginState, String> {
        let state: PluginState = read_json_store(&self.state_path())
            .map_err(|error| format!("failed to read plugin state: {error}"))?;
        if state.schema_version != state_schema_version() {
            return Err(format!(
                "unsupported plugin state schema version {}",
                state.schema_version
            ));
        }
        Ok(state)
    }

    fn write_state(&self, state: &PluginState) -> Result<(), String> {
        write_json_pretty_atomic(&self.state_path(), state, AtomicWriteOptions::default())
            .map_err(|error| format!("failed to write plugin state: {error}"))
    }
}

fn summary_from_loaded(
    plugin: LoadedPlugin,
    installed: InstalledPluginState,
    install_root: PathBuf,
) -> PluginSummary {
    let skills = plugin
        .skills
        .iter()
        .map(|skill| PluginSkillSummary {
            name: skill.name.clone(),
            qualified_name: skill.qualified_name(),
            description: skill.description.clone(),
        })
        .collect();
    let mcp_servers = plugin
        .mcp_servers
        .iter()
        .map(|server| PluginMcpSummary {
            name: server.name.clone(),
            qualified_name: server.qualified_name(),
            transport: server
                .config
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect();
    PluginSummary {
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        enabled: installed.enabled,
        installed_at_ms: installed.installed_at_ms,
        source_path: installed.source_path,
        install_path: install_root.display().to_string(),
        skills,
        mcp_servers,
        diagnostics: plugin.diagnostics,
        valid: true,
    }
}

fn copy_plugin_directory(source: &Path, target: &Path) -> Result<(), String> {
    let source = source.canonicalize().map_err(|error| {
        format!(
            "failed to resolve plugin source {}: {error}",
            source.display()
        )
    })?;
    if target.exists() {
        return Err(format!(
            "plugin staging directory already exists: {}",
            target.display()
        ));
    }
    fs::create_dir(target)
        .map_err(|error| format!("failed to create plugin staging directory: {error}"))?;
    let result = copy_directory_contents(&source, &source, target);
    if result.is_err() {
        let _ = fs::remove_dir_all(target);
    }
    result
}

fn detect_migration_artifacts(source: &Path) -> Vec<String> {
    let mut artifacts = Vec::new();
    if source.join("SKILL.md").is_file() {
        artifacts.push("standalone Skill".to_string());
    }
    if [
        "skills",
        ".agents/skills",
        ".github/skills",
        ".claude/skills",
    ]
    .iter()
    .any(|path| source.join(path).is_dir())
    {
        artifacts.push("skills directory".to_string());
    }
    if ["mcp.json", ".mcp.json", ".github/mcp.json"]
        .iter()
        .any(|path| source.join(path).is_file())
    {
        artifacts.push("MCP configuration".to_string());
    }
    if [
        "plugin.json",
        ".plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".github/plugin/plugin.json",
    ]
    .iter()
    .any(|path| source.join(path).is_file())
    {
        artifacts.push("client plugin manifest".to_string());
    }
    artifacts
}

fn copy_directory_contents(source_root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    let mut entries = fs::read_dir(source)
        .map_err(|error| {
            format!(
                "failed to read plugin directory {}: {error}",
                source.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to enumerate plugin directory: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| {
            format!(
                "failed to inspect plugin path {}: {error}",
                source_path.display()
            )
        })?;
        if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
            return Err(format!(
                "plugin import does not allow links or reparse points: {}",
                source_path.display()
            ));
        }
        let resolved = source_path.canonicalize().map_err(|error| {
            format!(
                "failed to resolve plugin path {}: {error}",
                source_path.display()
            )
        })?;
        if !resolved.starts_with(source_root) {
            return Err(format!(
                "plugin path escapes source root: {}",
                source_path.display()
            ));
        }
        let target_path = target.join(entry.file_name());
        if metadata.is_dir() {
            fs::create_dir(&target_path).map_err(|error| {
                format!(
                    "failed to create plugin directory {}: {error}",
                    target_path.display()
                )
            })?;
            copy_directory_contents(source_root, &resolved, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&resolved, &target_path).map_err(|error| {
                format!(
                    "failed to copy plugin file {}: {error}",
                    source_path.display()
                )
            })?;
        } else {
            return Err(format!(
                "plugin contains an unsupported filesystem entry: {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn install_nonce() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        now_ms(),
        INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

const fn state_schema_version() -> u32 {
    1
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
