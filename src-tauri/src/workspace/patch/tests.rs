use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::workspace::patch::filesystem::PatchFileSystemError;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

static PATCH_TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn parse_diagnostics_locate_missing_prefixes_in_the_submitted_patch() {
    for (operation, body, content, line) in [
        ("Add", "+first\n中文缺少前缀", "中文缺少前缀", 6),
        ("Add", "+first\n\n+last", "", 6),
        ("Update", "@@\n-old\n中文缺少前缀", "中文缺少前缀", 7),
        ("Update", "missing hunk prefix", "missing hunk prefix", 5),
    ] {
        let patch = format!(
            "\r\n\r\n*** Begin Patch\r\n*** {operation} File: reports/报告.md\r\n{}\r\n*** End Patch\r\n",
            body.replace('\n', "\r\n")
        );
        let error = parse_patch(&patch).expect_err("missing prefixes must be rejected");
        assert_eq!(error.details["stage"], "parse");
        assert_eq!(error.details["path"], "reports/报告.md");
        assert_eq!(error.details["line"], line);
        assert_eq!(error.details["content"], content);
        assert!(error.details["hint"]
            .as_str()
            .unwrap()
            .contains("No files were changed"));
        if operation == "Add" {
            assert!(error.details["hint"]
                .as_str()
                .unwrap()
                .contains("including empty lines"));
        }
    }
}

#[test]
fn parse_diagnostics_bound_unicode_content_and_paths() {
    let content = "报告🙂".repeat(10_000);
    let path = format!("{}.md", "目录🙂".repeat(1_000));
    for patch in [
        format!("*** Begin Patch\n*** Add File: {path}\n{content}\n*** End Patch"),
        format!("*** Begin Patch\n{content}\n*** End Patch"),
    ] {
        let error = parse_patch(&patch).expect_err("invalid patch must be rejected");
        let excerpt = error.details["content"].as_str().unwrap();
        assert!(excerpt.len() <= 256);
        assert!(content.starts_with(excerpt));
        assert_eq!(error.details["content_truncated"], true);
        if let Some(excerpt) = error.details["path"].as_str() {
            assert!(excerpt.len() <= 512);
            assert!(path.starts_with(excerpt));
            assert_eq!(error.details["path_truncated"], true);
        }
        assert!(serde_json::to_string(&error).unwrap().len() < 2_048);
    }
}

#[test]
fn parse_diagnostics_handle_missing_envelope_without_inventing_content() {
    let error = parse_patch("").expect_err("empty patch should fail");
    assert_eq!(error.details["line"], 1);
    assert!(error.details.get("content").is_none());
    assert_eq!(error.details["stage"], "parse");

    let error = parse_patch("*** Begin Patch\n*** Add File: note.md\n+unfinished")
        .expect_err("missing end marker should fail");
    assert_eq!(error.details["line"], 3);
    assert_eq!(error.details["content"], "+unfinished");
}

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
    assert!(error.details.get("hint").is_none());
    assert!(error.details.get("stage").is_none());
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
