use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::workspace::patch::filesystem::PatchFileSystemError;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

static PATCH_TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn failure_reports_the_exact_prefix_committed_before_the_error() {
    let fixture = PatchFixture::new();
    let rpc = WorkerWorkspaceRpc::new(
        fixture.root.clone(),
        CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::FsWorkspaceWrite,
        ]),
    );
    let file_system = FailOnSecondWrite {
        writes: AtomicUsize::new(0),
        inner: LocalPatchFileSystem,
    };

    let error = rpc
        .apply_patch_with_file_system(
            "*** Begin Patch\n*** Add File: notes/first.md\n+first\n*** Add File: notes/second.md\n+second\n*** End Patch\n",
            &file_system,
        )
        .expect_err("the injected second write should fail");

    assert_eq!(error.message, "injected workspace patch write failure");
    assert_eq!(error.details["committed"]["files_changed"], 1);
    assert_eq!(error.details["committed"]["hunks_applied"], 1);
    assert_eq!(error.details["committed"]["exact"], true);
    assert_eq!(
        error.details["committed"]["changed_files"][0]["path"],
        "notes/first.md"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("notes/first.md"))
            .expect("the committed first file should remain observable"),
        "first\n"
    );
    assert!(!fixture.root.join("notes/second.md").exists());
}

struct FailOnSecondWrite {
    writes: AtomicUsize,
    inner: LocalPatchFileSystem,
}

impl PatchFileSystem for FailOnSecondWrite {
    fn create_parent(&self, path: &Path, relative_path: &str) -> Result<(), PatchFileSystemError> {
        self.inner.create_parent(path, relative_path)
    }

    fn write_text(
        &self,
        path: &Path,
        contents: &str,
        relative_path: &str,
        preserve_target_permissions: bool,
        explicit_permissions: Option<std::fs::Permissions>,
    ) -> Result<(), PatchFileSystemError> {
        if self.writes.fetch_add(1, Ordering::SeqCst) == 1 {
            return Err(PatchFileSystemError {
                error: patch_error(
                    "injected workspace patch write failure",
                    serde_json::json!({ "path": relative_path }),
                ),
                textual_change_committed: false,
            });
        }
        self.inner.write_text(
            path,
            contents,
            relative_path,
            preserve_target_permissions,
            explicit_permissions,
        )
    }

    fn remove_file(&self, path: &Path, relative_path: &str) -> Result<(), PatchFileSystemError> {
        self.inner.remove_file(path, relative_path)
    }
}

struct PatchFixture {
    root: PathBuf,
}

impl PatchFixture {
    fn new() -> Self {
        let id = PATCH_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tinybot-workspace-patch-test-{}-{id}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("patch fixture root should be created");
        Self { root }
    }
}

impl Drop for PatchFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
