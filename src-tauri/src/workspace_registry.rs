use crate::storage::atomic::{
    read_json_store, write_json_pretty_atomic, AtomicWriteOptions, WorkerStorageError,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const WORKSPACE_REGISTRY_VERSION: usize = 1;

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceRegistry {
    path: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRegistryEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) exists: bool,
    pub(crate) added_at_ms: u64,
    pub(crate) updated_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRegistrySnapshot {
    pub(crate) workspaces: Vec<WorkspaceRegistryEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkspace {
    path: String,
    name: String,
    added_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRegistryDocument {
    version: usize,
    #[serde(default)]
    legacy_imported: bool,
    workspaces: Vec<StoredWorkspace>,
}

impl Default for WorkspaceRegistryDocument {
    fn default() -> Self {
        Self {
            version: WORKSPACE_REGISTRY_VERSION,
            legacy_imported: false,
            workspaces: Vec::new(),
        }
    }
}

impl WorkspaceRegistry {
    pub(crate) fn new(data_root: &Path) -> Self {
        Self {
            path: Arc::new(data_root.join("workspaces.json")),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn snapshot(&self) -> Result<WorkspaceRegistrySnapshot, String> {
        let _guard = self.lock()?;
        let document = self.read_document()?;
        Ok(snapshot(document))
    }

    pub(crate) fn requires_legacy_import(&self) -> Result<bool, String> {
        let _guard = self.lock()?;
        Ok(!self.read_document()?.legacy_imported)
    }

    pub(crate) fn import_legacy(&self, paths: Vec<String>) -> Result<(), String> {
        let _guard = self.lock()?;
        let mut document = self.read_document()?;
        if document.legacy_imported {
            return Ok(());
        }
        let mut seen = document
            .workspaces
            .iter()
            .map(|workspace| normalized_workspace_key(&workspace.path))
            .collect::<BTreeSet<_>>();
        let now = now_ms();
        for path in paths {
            let Some(path) = normalize_legacy_workspace(&path) else {
                continue;
            };
            if seen.insert(normalized_workspace_key(&path)) {
                document.workspaces.push(StoredWorkspace {
                    name: default_workspace_name(&path),
                    path,
                    added_at_ms: now,
                    updated_at_ms: now,
                });
            }
        }
        document.legacy_imported = true;
        self.write_document(&document)
    }

    pub(crate) fn register(&self, path: &str) -> Result<WorkspaceRegistryEntry, String> {
        self.register_many(vec![path.to_string()])?
            .into_iter()
            .next()
            .ok_or_else(|| "workspace path must not be empty".to_string())
    }

    pub(crate) fn get(&self, path: &str) -> Result<WorkspaceRegistryEntry, String> {
        let key = lookup_workspace_key(path)?;
        let _guard = self.lock()?;
        self.read_document()?
            .workspaces
            .into_iter()
            .find(|workspace| normalized_workspace_key(&workspace.path) == key)
            .map(entry)
            .ok_or_else(|| {
                format!(
                    "workspace `{}` was not found",
                    portable_workspace_path(path)
                )
            })
    }

    pub(crate) fn register_many(
        &self,
        paths: Vec<String>,
    ) -> Result<Vec<WorkspaceRegistryEntry>, String> {
        let normalized = canonical_workspace_ids(paths)?;
        let _guard = self.lock()?;
        let mut document = self.read_document()?;
        let now = now_ms();
        let mut changed = false;
        let mut registered = Vec::with_capacity(normalized.len());
        for path in normalized {
            let key = normalized_workspace_key(&path);
            if let Some(existing) = document
                .workspaces
                .iter()
                .find(|workspace| normalized_workspace_key(&workspace.path) == key)
            {
                registered.push(entry(existing.clone()));
                continue;
            }
            let stored = StoredWorkspace {
                name: default_workspace_name(&path),
                path,
                added_at_ms: now,
                updated_at_ms: now,
            };
            registered.push(entry(stored.clone()));
            document.workspaces.push(stored);
            changed = true;
        }
        if changed {
            self.write_document(&document)?;
        }
        Ok(registered)
    }

    pub(crate) fn rename(
        &self,
        path: &str,
        name: String,
    ) -> Result<WorkspaceRegistryEntry, String> {
        let name = non_empty("workspace name", name)?;
        let key = lookup_workspace_key(path)?;
        let _guard = self.lock()?;
        let mut document = self.read_document()?;
        let workspace = document
            .workspaces
            .iter_mut()
            .find(|workspace| normalized_workspace_key(&workspace.path) == key)
            .ok_or_else(|| {
                format!(
                    "workspace `{}` was not found",
                    portable_workspace_path(path)
                )
            })?;
        workspace.name = name;
        workspace.updated_at_ms = now_ms();
        let renamed = entry(workspace.clone());
        self.write_document(&document)?;
        Ok(renamed)
    }

    pub(crate) fn forget(&self, path: &str) -> Result<WorkspaceRegistryEntry, String> {
        let key = lookup_workspace_key(path)?;
        let _guard = self.lock()?;
        let mut document = self.read_document()?;
        let index = document
            .workspaces
            .iter()
            .position(|workspace| normalized_workspace_key(&workspace.path) == key)
            .ok_or_else(|| {
                format!(
                    "workspace `{}` was not found",
                    portable_workspace_path(path)
                )
            })?;
        let forgotten = entry(document.workspaces.remove(index));
        self.write_document(&document)?;
        Ok(forgotten)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.lock
            .lock()
            .map_err(|_| "workspace registry lock is poisoned".to_string())
    }

    fn read_document(&self) -> Result<WorkspaceRegistryDocument, String> {
        let document =
            read_json_store::<WorkspaceRegistryDocument>(&self.path).map_err(storage_error)?;
        if document.version != WORKSPACE_REGISTRY_VERSION {
            return Err(format!(
                "unsupported workspace registry version {}",
                document.version
            ));
        }
        Ok(document)
    }

    fn write_document(&self, document: &WorkspaceRegistryDocument) -> Result<(), String> {
        write_json_pretty_atomic(&self.path, document, AtomicWriteOptions::default())
            .map_err(storage_error)
    }
}

pub(crate) fn canonical_workspace(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("failed to resolve workspace `{}`: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("workspace `{}` is not a directory", path.display()));
    }
    Ok(canonical)
}

pub(crate) fn workspace_id(path: &Path) -> String {
    portable_workspace_path(&path.to_string_lossy())
}

pub(crate) fn normalized_workspace_key(value: &str) -> String {
    let value = portable_workspace_path(value)
        .trim_end_matches(['/', '\\'])
        .replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn canonical_workspace_ids(values: Vec<String>) -> Result<Vec<String>, String> {
    let mut seen = BTreeSet::new();
    let mut workspace_ids = Vec::new();
    for value in values {
        let value = non_empty("workspace path", value)?;
        let canonical = canonical_workspace(Path::new(&value))?;
        let workspace_id = workspace_id(&canonical);
        if seen.insert(normalized_workspace_key(&workspace_id)) {
            workspace_ids.push(workspace_id);
        }
    }
    Ok(workspace_ids)
}

fn lookup_workspace_key(value: &str) -> Result<String, String> {
    let value = non_empty("workspace path", value.to_string())?;
    let path = Path::new(&value);
    if path.exists() {
        return canonical_workspace(path)
            .map(|path| normalized_workspace_key(&workspace_id(&path)));
    }
    Ok(normalized_workspace_key(&value))
}

fn normalize_legacy_workspace(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let path = Path::new(value);
    if path.exists() {
        return canonical_workspace(path)
            .ok()
            .map(|path| workspace_id(&path));
    }
    path.is_absolute().then(|| portable_workspace_path(value))
}

fn portable_workspace_path(value: &str) -> String {
    if let Some(network_path) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{network_path}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
}

fn snapshot(document: WorkspaceRegistryDocument) -> WorkspaceRegistrySnapshot {
    WorkspaceRegistrySnapshot {
        workspaces: document.workspaces.into_iter().map(entry).collect(),
    }
}

fn entry(workspace: StoredWorkspace) -> WorkspaceRegistryEntry {
    WorkspaceRegistryEntry {
        exists: Path::new(&workspace.path).is_dir(),
        path: workspace.path,
        name: workspace.name,
        added_at_ms: workspace.added_at_ms,
        updated_at_ms: workspace.updated_at_ms,
    }
}

fn default_workspace_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(path)
        .to_string()
}

fn non_empty(label: &str, value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(value)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn storage_error(error: WorkerStorageError) -> String {
    format!("workspace registry persistence failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-workspace-registry-{}-{}",
                std::process::id(),
                FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(root.join("commerce")).unwrap();
            Self { root }
        }

        fn registry(&self) -> WorkspaceRegistry {
            WorkspaceRegistry::new(&self.root.join("data"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn registry_persists_register_rename_and_forget_without_touching_the_directory() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        let workspace = fixture.root.join("commerce");

        let registered = registry.register(&workspace.display().to_string()).unwrap();
        assert_eq!(registered.name, "commerce");
        assert!(registered.exists);
        assert!(!registered.path.starts_with(r"\\?\"));

        let renamed = registry
            .rename(&registered.path, "Commerce API".to_string())
            .unwrap();
        assert_eq!(renamed.name, "Commerce API");
        assert_eq!(
            fixture.registry().snapshot().unwrap().workspaces,
            vec![renamed.clone()]
        );

        assert_eq!(registry.forget(&registered.path).unwrap(), renamed);
        assert!(workspace.is_dir());
        assert!(fixture.registry().snapshot().unwrap().workspaces.is_empty());
    }

    #[test]
    fn registry_deduplicates_canonical_workspace_paths() {
        let fixture = Fixture::new();
        let workspace = fixture.root.join("commerce");
        let registry = fixture.registry();

        registry.register(&workspace.display().to_string()).unwrap();
        registry
            .register(&workspace.join(".").display().to_string())
            .unwrap();

        assert_eq!(registry.snapshot().unwrap().workspaces.len(), 1);
    }

    #[test]
    fn legacy_import_runs_once_and_keeps_missing_absolute_workspaces_visible() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        let workspace = fixture.root.join("commerce").display().to_string();
        let missing = fixture.root.join("missing").display().to_string();

        assert!(registry.requires_legacy_import().unwrap());
        registry
            .import_legacy(vec![workspace.clone(), missing.clone()])
            .unwrap();
        registry
            .import_legacy(vec![fixture.root.display().to_string()])
            .unwrap();

        let snapshot = registry.snapshot().unwrap();
        assert!(!registry.requires_legacy_import().unwrap());
        assert_eq!(snapshot.workspaces.len(), 2);
        assert!(snapshot
            .workspaces
            .iter()
            .any(|entry| entry.path == missing && !entry.exists));
    }

    #[test]
    fn portable_paths_remove_windows_verbatim_prefixes() {
        assert_eq!(
            portable_workspace_path(r"\\?\C:\code\tinybot"),
            r"C:\code\tinybot"
        );
        assert_eq!(
            portable_workspace_path(r"\\?\UNC\server\share\tinybot"),
            r"\\server\share\tinybot"
        );
    }
}
