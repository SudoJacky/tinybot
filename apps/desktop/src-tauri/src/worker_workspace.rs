use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct WorkerWorkspaceRpc {
    root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerWorkspaceRpc {
    pub fn new(root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self { root, policy }
    }

    pub fn resolve_path(
        &self,
        requested_path: &str,
    ) -> Result<WorkspaceResolvedPath, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let relative_path = normalize_workspace_path(requested_path)?;
        Ok(WorkspaceResolvedPath {
            absolute_path: join_workspace_relative(&self.root, &relative_path),
            relative_path,
        })
    }

    pub fn read_file(
        &self,
        requested_path: &str,
    ) -> Result<WorkspaceFileContent, WorkerProtocolError> {
        let resolved = self.resolve_path(requested_path)?;
        ensure_inside_workspace(&self.root, &resolved.absolute_path)?;
        let contents = std::fs::read_to_string(&resolved.absolute_path).map_err(|error| {
            filesystem_error(
                "failed to read workspace file",
                serde_json::json!({
                    "path": resolved.relative_path,
                    "error": error.to_string(),
                }),
            )
        })?;
        Ok(WorkspaceFileContent {
            path: resolved.relative_path,
            contents,
        })
    }

    pub fn list_files(&self) -> Result<Vec<WorkspaceFileEntry>, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let root = canonicalize_workspace_root(&self.root)?;
        let mut entries = Vec::new();
        collect_workspace_files(&root, &root, &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceResolvedPath {
    pub relative_path: String,
    pub absolute_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceFileContent {
    pub path: String,
    pub contents: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub size_bytes: u64,
}

fn collect_workspace_files(
    root: &Path,
    current: &Path,
    entries: &mut Vec<WorkspaceFileEntry>,
) -> Result<(), WorkerProtocolError> {
    for entry in std::fs::read_dir(current).map_err(|error| {
        filesystem_error(
            "failed to list workspace directory",
            serde_json::json!({
                "path": current.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })? {
        let entry = entry.map_err(|error| {
            filesystem_error(
                "failed to inspect workspace directory entry",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
        let path = entry.path();
        ensure_inside_canonical_workspace(root, &path)?;
        let metadata = entry.metadata().map_err(|error| {
            filesystem_error(
                "failed to read workspace file metadata",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })?;
        if metadata.is_dir() {
            collect_workspace_files(root, &path, entries)?;
        } else if metadata.is_file() {
            entries.push(WorkspaceFileEntry {
                path: workspace_relative_path(root, &path)?,
                size_bytes: metadata.len(),
            });
        }
    }
    Ok(())
}

fn normalize_workspace_path(requested_path: &str) -> Result<String, WorkerProtocolError> {
    let normalized = requested_path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid_workspace_path(requested_path));
    }
    Ok(normalized)
}

fn join_workspace_relative(root: &Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn ensure_inside_workspace(root: &Path, path: &Path) -> Result<(), WorkerProtocolError> {
    let root = canonicalize_workspace_root(root)?;
    ensure_inside_canonical_workspace(&root, path)
}

fn ensure_inside_canonical_workspace(root: &Path, path: &Path) -> Result<(), WorkerProtocolError> {
    let path = path.canonicalize().map_err(|error| {
        filesystem_error(
            "failed to resolve workspace path",
            serde_json::json!({
                "path": path.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })?;
    if path.starts_with(root) {
        return Ok(());
    }
    Err(WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "workspace path escapes workspace root",
        serde_json::json!({
            "root": root.display().to_string(),
            "path": path.display().to_string(),
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    ))
}

fn workspace_relative_path(root: &Path, path: &Path) -> Result<String, WorkerProtocolError> {
    path.strip_prefix(root)
        .map_err(|error| {
            filesystem_error(
                "failed to compute workspace relative path",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn canonicalize_workspace_root(root: &Path) -> Result<PathBuf, WorkerProtocolError> {
    root.canonicalize().map_err(|error| {
        filesystem_error(
            "failed to resolve workspace root",
            serde_json::json!({
                "root": root.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })
}

fn invalid_workspace_path(requested_path: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "invalid workspace relative path",
        serde_json::json!({ "path": requested_path }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn filesystem_error(message: impl Into<String>, details: serde_json::Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::{WorkerProtocolErrorCode, WorkerProtocolErrorSource};
    use std::path::PathBuf;

    #[test]
    fn default_policy_denies_workspace_read() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), CapabilityPolicy::default());

        let error = rpc
            .read_file("AGENTS.md")
            .expect_err("read should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["capability"], "fs.workspace.read");
    }

    #[test]
    fn read_file_returns_utf8_content_with_read_capability() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "hello worker");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let file = rpc
            .read_file("AGENTS.md")
            .expect("allowed workspace file should read");

        assert_eq!(file.path, "AGENTS.md");
        assert_eq!(file.contents, "hello worker");
    }

    #[test]
    fn list_files_returns_workspace_relative_paths() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        fixture.write("memory/MEMORY.md", "memory");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let files = rpc.list_files().expect("workspace files should list");
        let paths: Vec<String> = files.into_iter().map(|file| file.path).collect();

        assert_eq!(paths, vec!["AGENTS.md", "memory/MEMORY.md"]);
    }

    #[test]
    fn resolve_path_normalizes_slashes_without_touching_filesystem() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let resolved = rpc
            .resolve_path("memory\\MEMORY.md")
            .expect("workspace path should resolve");

        assert_eq!(resolved.relative_path, "memory/MEMORY.md");
        assert_eq!(resolved.absolute_path, fixture.root.join("memory").join("MEMORY.md"));
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        assert!(rpc.resolve_path("../secret.txt").is_err());
        assert!(rpc.resolve_path("memory/../secret.txt").is_err());
        assert!(rpc.resolve_path("C:/Windows/System32").is_err());
        assert!(rpc.resolve_path("/etc/passwd").is_err());
    }

    #[test]
    fn symlink_escape_is_rejected_when_reading_existing_file() {
        let fixture = WorkspaceFixture::new();
        let outside = fixture.outside.join("secret.txt");
        std::fs::write(&outside, "secret").expect("outside fixture should write");

        #[cfg(target_os = "windows")]
        std::os::windows::fs::symlink_file(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        #[cfg(not(target_os = "windows"))]
        std::os::unix::fs::symlink(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let error = rpc
            .read_file("linked-secret.txt")
            .expect_err("symlink escape should be blocked");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead])
    }

    struct WorkspaceFixture {
        root: PathBuf,
        outside: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "tinybot-worker-workspace-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos()
            ));
            let root = base.join("workspace");
            let outside = base.join("outside");
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            std::fs::create_dir_all(&outside).expect("outside fixture should create");
            Self { root, outside }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self.root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }
}
