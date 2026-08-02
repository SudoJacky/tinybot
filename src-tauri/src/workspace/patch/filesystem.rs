use super::*;
use crate::storage::atomic::{write_text_atomic, AtomicWriteOptions};

pub(super) trait PatchFileSystem {
    fn create_parent(&self, path: &Path, relative_path: &str) -> Result<(), PatchFileSystemError>;

    fn write_text(
        &self,
        path: &Path,
        contents: &str,
        relative_path: &str,
        preserve_target_permissions: bool,
        explicit_permissions: Option<std::fs::Permissions>,
    ) -> Result<(), PatchFileSystemError>;

    fn remove_file(&self, path: &Path, relative_path: &str) -> Result<(), PatchFileSystemError>;
}

#[derive(Debug)]
pub(super) struct PatchFileSystemError {
    pub(super) error: WorkerProtocolError,
    pub(super) textual_change_committed: bool,
}

impl PatchFileSystemError {
    fn before_commit(error: WorkerProtocolError) -> Self {
        Self {
            error,
            textual_change_committed: false,
        }
    }

    fn after_commit(error: WorkerProtocolError) -> Self {
        Self {
            error,
            textual_change_committed: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct LocalPatchFileSystem;

impl PatchFileSystem for LocalPatchFileSystem {
    fn create_parent(&self, path: &Path, relative_path: &str) -> Result<(), PatchFileSystemError> {
        let Some(parent) = path.parent() else {
            return Ok(());
        };
        std::fs::create_dir_all(parent).map_err(|error| {
            PatchFileSystemError::before_commit(filesystem_error(
                "failed to create workspace patch parent directory",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            ))
        })
    }

    fn write_text(
        &self,
        path: &Path,
        contents: &str,
        relative_path: &str,
        preserve_target_permissions: bool,
        explicit_permissions: Option<std::fs::Permissions>,
    ) -> Result<(), PatchFileSystemError> {
        let options = if preserve_target_permissions {
            AtomicWriteOptions::default().preserve_target_permissions()
        } else {
            AtomicWriteOptions::default()
        };
        write_text_atomic(path, contents, options).map_err(|error| {
            PatchFileSystemError::before_commit(filesystem_error(
                "failed to write workspace patch target",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            ))
        })?;
        if let Some(permissions) = explicit_permissions {
            std::fs::set_permissions(path, permissions).map_err(|error| {
                PatchFileSystemError::after_commit(filesystem_error(
                    "failed to preserve workspace patch target permissions",
                    serde_json::json!({
                        "path": relative_path,
                        "error": error.to_string(),
                    }),
                ))
            })?;
        }
        Ok(())
    }

    fn remove_file(&self, path: &Path, relative_path: &str) -> Result<(), PatchFileSystemError> {
        std::fs::remove_file(path).map_err(|error| {
            PatchFileSystemError::before_commit(filesystem_error(
                "failed to delete workspace patch target",
                serde_json::json!({
                    "path": relative_path,
                    "error": error.to_string(),
                }),
            ))
        })
    }
}
