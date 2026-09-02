use crate::storage::atomic::{
    read_json_store, write_json_pretty_atomic, AtomicWriteOptions, WorkerStorageError,
};
use crate::workspace_registry::{
    canonical_workspace, normalized_workspace_key, WorkspaceRegistry, WorkspaceRegistryEntry,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const PROJECT_GROUP_STORE_VERSION: usize = 1;
static PROJECT_GROUP_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub(crate) struct ProjectGroupStore {
    path: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
    workspace_catalog_lock: Arc<Mutex<()>>,
    workspace_registry: WorkspaceRegistry,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectGroup {
    pub(crate) project_group_id: String,
    pub(crate) name: String,
    pub(crate) workspace_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveProjectGroupInput {
    #[serde(default)]
    pub(crate) project_group_id: Option<String>,
    pub(crate) name: String,
    pub(crate) workspace_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectGroupSnapshot {
    pub(crate) groups: Vec<ProjectGroup>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectGroupDocument {
    version: usize,
    groups: Vec<ProjectGroup>,
}

impl Default for ProjectGroupDocument {
    fn default() -> Self {
        Self {
            version: PROJECT_GROUP_STORE_VERSION,
            groups: Vec::new(),
        }
    }
}

impl ProjectGroupStore {
    #[cfg(test)]
    pub(crate) fn new(data_root: &Path) -> Self {
        Self::with_workspace_registry(data_root, WorkspaceRegistry::new(data_root))
    }

    pub(crate) fn with_workspace_registry(
        data_root: &Path,
        workspace_registry: WorkspaceRegistry,
    ) -> Self {
        Self {
            path: Arc::new(data_root.join("project-groups.json")),
            lock: Arc::new(Mutex::new(())),
            workspace_catalog_lock: Arc::new(Mutex::new(())),
            workspace_registry,
        }
    }

    pub(crate) fn snapshot(&self) -> Result<ProjectGroupSnapshot, String> {
        let _guard = self.lock()?;
        let document = self.read_document()?;
        Ok(ProjectGroupSnapshot {
            groups: document.groups,
        })
    }

    pub(crate) fn save(&self, input: SaveProjectGroupInput) -> Result<ProjectGroup, String> {
        let name = non_empty("project group name", input.name)?;
        let _catalog_guard = self.workspace_catalog_lock()?;
        let workspace_ids = self
            .workspace_registry
            .register_many(input.workspace_ids)?
            .into_iter()
            .map(|workspace| workspace.path)
            .collect::<Vec<_>>();
        if workspace_ids.is_empty() {
            return Err("project group requires at least one workspace".to_string());
        }
        let _guard = self.lock()?;
        let mut document = self.read_document()?;
        if document.groups.iter().any(|group| {
            group.name.eq_ignore_ascii_case(&name)
                && input.project_group_id.as_deref() != Some(group.project_group_id.as_str())
        }) {
            return Err(format!("project group name `{name}` already exists"));
        }
        let group = if let Some(project_group_id) = input.project_group_id {
            let project_group_id = non_empty("projectGroupId", project_group_id)?;
            let existing = document
                .groups
                .iter_mut()
                .find(|group| group.project_group_id == project_group_id)
                .ok_or_else(|| format!("project group `{project_group_id}` was not found"))?;
            existing.name = name;
            existing.workspace_ids = workspace_ids;
            existing.clone()
        } else {
            let group = ProjectGroup {
                project_group_id: generate_project_group_id(),
                name,
                workspace_ids,
            };
            document.groups.push(group.clone());
            group
        };
        self.write_document(&document)?;
        eprintln!(
            "project_group_saved project_group_id={} workspace_count={}",
            group.project_group_id,
            group.workspace_ids.len()
        );
        Ok(group)
    }

    pub(crate) fn forget_workspace(
        &self,
        workspace_path: &str,
    ) -> Result<WorkspaceRegistryEntry, String> {
        let _catalog_guard = self.workspace_catalog_lock()?;
        let registered = self.workspace_registry.get(workspace_path)?;
        let path_key = normalized_workspace_key(&registered.path);
        let _guard = self.lock()?;
        if let Some(group) = self.read_document()?.groups.into_iter().find(|group| {
            group
                .workspace_ids
                .iter()
                .any(|workspace_id| normalized_workspace_key(workspace_id) == path_key)
        }) {
            return Err(format!(
                "workspace `{}` belongs to project group `{}`; remove it from the project before forgetting it",
                registered.path, group.name
            ));
        }
        self.workspace_registry.forget(&registered.path)
    }

    pub(crate) fn delete(&self, project_group_id: &str) -> Result<ProjectGroup, String> {
        let project_group_id = non_empty("projectGroupId", project_group_id.to_string())?;
        let _guard = self.lock()?;
        let mut document = self.read_document()?;
        let index = document
            .groups
            .iter()
            .position(|group| group.project_group_id == project_group_id)
            .ok_or_else(|| format!("project group `{project_group_id}` was not found"))?;
        let deleted = document.groups.remove(index);
        self.write_document(&document)?;
        eprintln!(
            "project_group_deleted project_group_id={}",
            deleted.project_group_id
        );
        Ok(deleted)
    }

    pub(crate) fn group(&self, project_group_id: &str) -> Result<ProjectGroup, String> {
        self.find_group(project_group_id)?
            .ok_or_else(|| format!("project group `{project_group_id}` was not found"))
    }

    pub(crate) fn find_group(
        &self,
        project_group_id: &str,
    ) -> Result<Option<ProjectGroup>, String> {
        let project_group_id = non_empty("projectGroupId", project_group_id.to_string())?;
        Ok(self
            .snapshot()?
            .groups
            .into_iter()
            .find(|group| group.project_group_id == project_group_id))
    }

    pub(crate) fn authorize_workspace(
        &self,
        project_group_id: &str,
        workspace_id: &str,
    ) -> Result<PathBuf, String> {
        let group = self.group(project_group_id)?;
        let stored = group
            .workspace_ids
            .iter()
            .find(|candidate| {
                normalized_workspace_key(candidate) == normalized_workspace_key(workspace_id)
            })
            .ok_or_else(|| {
                format!(
                    "workspace `{workspace_id}` is not a member of project group `{project_group_id}`"
                )
            })?;
        canonical_workspace(Path::new(stored))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.lock
            .lock()
            .map_err(|_| "project group store lock is poisoned".to_string())
    }

    fn workspace_catalog_lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.workspace_catalog_lock
            .lock()
            .map_err(|_| "workspace catalog coordination lock is poisoned".to_string())
    }

    fn read_document(&self) -> Result<ProjectGroupDocument, String> {
        let document =
            read_json_store::<ProjectGroupDocument>(&self.path).map_err(storage_error)?;
        if document.version != PROJECT_GROUP_STORE_VERSION {
            return Err(format!(
                "unsupported project group store version {}",
                document.version
            ));
        }
        Ok(document)
    }

    fn write_document(&self, document: &ProjectGroupDocument) -> Result<(), String> {
        write_json_pretty_atomic(&self.path, document, AtomicWriteOptions::default())
            .map_err(storage_error)
    }
}

fn non_empty(label: &str, value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(value)
    }
}

fn generate_project_group_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let sequence = PROJECT_GROUP_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("project-group-{now}-{sequence}")
}

fn storage_error(error: WorkerStorageError) -> String {
    format!("project group persistence failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(generate_project_group_id());
            std::fs::create_dir_all(root.join("gateway")).unwrap();
            std::fs::create_dir_all(root.join("payments")).unwrap();
            Self { root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn project_groups_persist_arbitrary_workspace_membership() {
        let fixture = Fixture::new();
        let data_root = fixture.root.join("data");
        let registry = WorkspaceRegistry::new(&data_root);
        let store = ProjectGroupStore::with_workspace_registry(&data_root, registry.clone());
        let saved = store
            .save(SaveProjectGroupInput {
                project_group_id: None,
                name: "Commerce".to_string(),
                workspace_ids: vec![
                    fixture.root.join("gateway").display().to_string(),
                    fixture.root.join("payments").display().to_string(),
                ],
            })
            .unwrap();

        let reloaded = ProjectGroupStore::new(&data_root).snapshot().unwrap();
        assert_eq!(reloaded.groups, vec![saved.clone()]);
        assert_eq!(
            registry
                .snapshot()
                .unwrap()
                .workspaces
                .into_iter()
                .map(|workspace| workspace.path)
                .collect::<Vec<_>>(),
            saved.workspace_ids
        );
        assert_eq!(
            store
                .authorize_workspace(&saved.project_group_id, &saved.workspace_ids[1])
                .unwrap(),
            fixture.root.join("payments").canonicalize().unwrap()
        );
    }

    #[test]
    fn save_rejects_missing_workspaces_without_changing_the_store() {
        let fixture = Fixture::new();
        let store = ProjectGroupStore::new(&fixture.root.join("data"));
        let error = store
            .save(SaveProjectGroupInput {
                project_group_id: None,
                name: "Broken".to_string(),
                workspace_ids: vec![fixture.root.join("missing").display().to_string()],
            })
            .unwrap_err();
        assert!(error.contains("failed to resolve workspace"));
        assert!(store.snapshot().unwrap().groups.is_empty());
    }

    #[test]
    fn deleting_a_group_only_removes_the_membership_record() {
        let fixture = Fixture::new();
        let data_root = fixture.root.join("data");
        let registry = WorkspaceRegistry::new(&data_root);
        let store = ProjectGroupStore::with_workspace_registry(&data_root, registry.clone());
        let saved = store
            .save(SaveProjectGroupInput {
                project_group_id: None,
                name: "Commerce".to_string(),
                workspace_ids: vec![fixture.root.join("gateway").display().to_string()],
            })
            .unwrap();
        let workspace_id = saved.workspace_ids[0].clone();
        let error = store.forget_workspace(&workspace_id).unwrap_err();
        assert!(error.contains("belongs to project group `Commerce`"));
        assert_eq!(store.delete(&saved.project_group_id).unwrap(), saved);
        assert!(fixture.root.join("gateway").is_dir());
        assert!(store.snapshot().unwrap().groups.is_empty());
        store.forget_workspace(&workspace_id).unwrap();
        assert!(registry.snapshot().unwrap().workspaces.is_empty());
    }
}
