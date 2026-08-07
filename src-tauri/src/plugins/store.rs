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
        let source_plugin = load_plugin(source)?;
        let plugin_name = source_plugin.manifest.name.clone();
        fs::create_dir_all(self.cache_root()).map_err(|error| {
            format!(
                "failed to create plugin cache {}: {error}",
                self.cache_root().display()
            )
        })?;
        fs::create_dir_all(self.data_root().join(&plugin_name)).map_err(|error| {
            format!("failed to create plugin data directory for `{plugin_name}`: {error}")
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
        let installed = InstalledPluginState {
            enabled: previous.as_ref().is_some_and(|plugin| plugin.enabled),
            installed_at_ms: now_ms(),
            source_path: source_plugin.root.display().to_string(),
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
        let state = self.read_state()?;
        let mut plugins = Vec::new();
        for (name, installed) in state.plugins {
            if !installed.enabled {
                continue;
            }
            match load_plugin(&self.cache_root().join(&name)) {
                Ok(plugin) if plugin.manifest.name == name => plugins.push(plugin),
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
