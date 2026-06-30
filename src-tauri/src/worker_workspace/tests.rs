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
        assert!(file.updated_at.is_some());
    }

    #[test]
    fn list_files_returns_workspace_relative_paths() {
        let fixture = WorkspaceFixture::new();
        fixture.write("AGENTS.md", "agents");
        fixture.write("memory/MEMORY.md", "memory");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let files = rpc.list_files().expect("workspace files should list");
        let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();

        assert_eq!(paths, vec!["AGENTS.md", "memory/MEMORY.md"]);
        assert!(files.iter().all(|file| file.updated_at.is_some()));
    }

    #[test]
    fn read_bootstrap_files_returns_present_files_and_missing_names() {
        let fixture = WorkspaceFixture::new();
        fixture.write("USER.md", "user rules");
        fixture.write("AGENTS.md", "agent rules");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let result = rpc
            .read_bootstrap_files(&[
                "AGENTS.md".to_string(),
                "TOOLS.md".to_string(),
                "USER.md".to_string(),
            ])
            .expect("bootstrap files should read");

        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].path, "AGENTS.md");
        assert_eq!(result.files[0].contents, "agent rules");
        assert!(result.files[0].updated_at.is_some());
        assert_eq!(result.files[1].path, "USER.md");
        assert_eq!(result.files[1].contents, "user rules");
        assert!(result.files[1].updated_at.is_some());
        assert_eq!(result.missing, vec!["TOOLS.md"]);
    }

    #[test]
    fn read_bootstrap_files_rejects_non_allowlisted_paths() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let error = rpc
            .read_bootstrap_files(&["../secret.txt".to_string()])
            .expect_err("bootstrap reader should reject traversal");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    }

    #[test]
    fn list_files_skips_symlinked_directories() {
        let fixture = WorkspaceFixture::new();
        fixture.write("real/NOTE.md", "note");
        let link = fixture.root.join("linked-real");

        #[cfg(target_os = "windows")]
        if let Err(error) = std::os::windows::fs::symlink_dir(fixture.root.join("real"), &link) {
            eprintln!("skipping symlink test because symlink creation failed: {error}");
            return;
        }

        #[cfg(not(target_os = "windows"))]
        if let Err(error) = std::os::unix::fs::symlink(fixture.root.join("real"), &link) {
            eprintln!("skipping symlink test because symlink creation failed: {error}");
            return;
        }

        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let files = rpc.list_files().expect("workspace files should list");
        let paths: Vec<String> = files.into_iter().map(|file| file.path).collect();

        assert_eq!(paths, vec!["real/NOTE.md"]);
    }

    #[test]
    fn list_files_ignores_workspace_noise_directories() {
        let fixture = WorkspaceFixture::new();
        fixture.write("README.md", "readme");
        fixture.write("src/main.ts", "main");
        fixture.write("node_modules/pkg/index.js", "noise");
        fixture.write(".git/objects/pack.idx", "noise");
        fixture.write("target/debug/app.exe", "noise");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let files = rpc.list_files().expect("workspace files should list");
        let paths: Vec<String> = files.into_iter().map(|file| file.path).collect();

        assert_eq!(paths, vec!["README.md", "src/main.ts"]);
    }

    #[test]
    fn list_files_ignores_hidden_workspace_paths() {
        let fixture = WorkspaceFixture::new();
        fixture.write("README.md", "readme");
        fixture.write("src/main.ts", "main");
        fixture.write(".env", "secret");
        fixture.write(".browser-data/Avatar/avatar.json", "noise");
        fixture.write("src/.cache/generated.txt", "noise");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let files = rpc.list_files().expect("workspace files should list");
        let paths: Vec<String> = files.into_iter().map(|file| file.path).collect();

        assert_eq!(paths, vec!["README.md", "src/main.ts"]);
    }

    #[test]
    fn list_skills_uses_separate_builtin_root_with_workspace_precedence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "skills/planner/SKILL.md",
            "---\nname: planner\ndescription: Workspace planner\n---\nWorkspace body",
        );
        fixture.write_outside(
            "builtin-skills/planner/SKILL.md",
            "---\nname: planner\ndescription: Builtin planner\n---\nBuiltin body",
        );
        fixture.write_outside(
            "builtin-skills/tmux/SKILL.md",
            "---\nname: tmux\ndescription: Terminal sessions\n---\nTmux body",
        );
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy())
            .with_builtin_skills_root(fixture.outside.clone());

        let result = rpc.list_skills().expect("skills should list");
        let skills: Vec<(String, String, String)> = result
            .skills
            .into_iter()
            .map(|skill| (skill.name, skill.source, skill.path))
            .collect();

        assert_eq!(
            skills,
            vec![
                (
                    "planner".to_string(),
                    "workspace".to_string(),
                    "skills/planner/SKILL.md".to_string()
                ),
                (
                    "tmux".to_string(),
                    "builtin".to_string(),
                    "builtin-skills/tmux/SKILL.md".to_string()
                )
            ]
        );
    }

    #[test]
    fn resolve_path_normalizes_slashes_without_touching_filesystem() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let resolved = rpc
            .resolve_path("memory\\MEMORY.md")
            .expect("workspace path should resolve");

        assert_eq!(resolved.relative_path, "memory/MEMORY.md");
        assert_eq!(
            resolved.absolute_path,
            fixture.root.join("memory").join("MEMORY.md")
        );
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
        if let Err(error) =
            std::os::windows::fs::symlink_file(&outside, fixture.root.join("linked-secret.txt"))
        {
            eprintln!("skipping symlink test because symlink creation failed: {error}");
            return;
        }

        #[cfg(not(target_os = "windows"))]
        std::os::unix::fs::symlink(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let error = rpc
            .read_file("linked-secret.txt")
            .expect_err("symlink escape should be blocked");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    }

    #[test]
    fn default_policy_denies_workspace_write() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), CapabilityPolicy::default());

        let error = rpc
            .write_file("notes/today.md", "hello")
            .expect_err("write should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "fs.workspace.write");
    }

    #[test]
    fn read_policy_does_not_allow_workspace_write() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let error = rpc
            .write_file("notes/today.md", "hello")
            .expect_err("read capability should not allow write");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "fs.workspace.write");
    }

    #[test]
    fn write_file_creates_parent_directories_inside_workspace() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        let written = rpc
            .write_file("notes/today.md", "hello writer")
            .expect("write should succeed");

        assert_eq!(written.path, "notes/today.md");
        assert_eq!(written.bytes_written, 12);
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("notes").join("today.md"))
                .expect("written file should read"),
            "hello writer"
        );
    }

    #[test]
    fn create_dir_creates_nested_directory_inside_workspace() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        let created = rpc
            .create_dir("skills/planner/scripts")
            .expect("directory create should succeed");

        assert_eq!(created.path, "skills/planner/scripts");
        assert_eq!(created.kind, "dir");
        assert!(created.created);
        assert!(fixture
            .root
            .join("skills")
            .join("planner")
            .join("scripts")
            .is_dir());
    }

    #[test]
    fn write_file_rejects_traversal_and_absolute_paths() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        assert!(rpc.write_file("../secret.txt", "secret").is_err());
        assert!(rpc.write_file("notes/../secret.txt", "secret").is_err());
        assert!(rpc.write_file("C:/Windows/System32", "secret").is_err());
        assert!(rpc.write_file("/etc/passwd", "secret").is_err());
    }

    #[test]
    fn write_file_rejects_symlink_escape_overwrite() {
        let fixture = WorkspaceFixture::new();
        let outside = fixture.outside.join("secret.txt");
        std::fs::write(&outside, "secret").expect("outside fixture should write");

        #[cfg(target_os = "windows")]
        if let Err(error) =
            std::os::windows::fs::symlink_file(&outside, fixture.root.join("linked-secret.txt"))
        {
            eprintln!("skipping symlink test because symlink creation failed: {error}");
            return;
        }

        #[cfg(not(target_os = "windows"))]
        std::os::unix::fs::symlink(&outside, fixture.root.join("linked-secret.txt"))
            .expect("symlink should create");

        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), write_policy());

        let error = rpc
            .write_file("linked-secret.txt", "overwrite")
            .expect_err("symlink escape should be blocked");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(
            std::fs::read_to_string(outside).expect("outside file should read"),
            "secret"
        );
    }

    #[test]
    fn read_file_with_options_returns_numbered_paginated_lines() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "one\ntwo\nthree\nfour\n");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let file = rpc
            .read_file_with_options(
                "notes/today.md",
                WorkspaceReadOptions {
                    offset: Some(2),
                    limit: Some(2),
                    format: WorkspaceReadFormat::NumberedLines,
                },
            )
            .expect("paginated file should read");

        assert_eq!(file.path, "notes/today.md");
        assert_eq!(
            file.content,
            "2| two\n3| three\n\n(Showing lines 2-3 of 4. Use offset=4 to continue.)"
        );
        assert_eq!(file.content_type, "text");
        assert_eq!(file.line_start, Some(2));
        assert_eq!(file.line_end, Some(3));
        assert_eq!(file.line_total, Some(4));
        assert!(file.truncated);
    }

    #[test]
    fn list_dir_respects_path_recursion_max_entries_and_ignores_noise() {
        let fixture = WorkspaceFixture::new();
        fixture.write("README.md", "readme");
        fixture.write("src/main.ts", "main");
        fixture.write("node_modules/pkg/index.js", "noise");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let listing = rpc
            .list_dir(".", true, Some(10))
            .expect("workspace directory should list");
        let paths: Vec<String> = listing
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .collect();

        assert_eq!(paths, vec!["README.md", "src/", "src/main.ts"]);
        assert_eq!(listing.path, ".");
        assert!(!listing.truncated);
    }

    #[test]
    fn list_dir_reports_workspace_relative_paths_from_subdirectories() {
        let fixture = WorkspaceFixture::new();
        fixture.write("src/main.ts", "main");
        fixture.write("src/components/button.ts", "button");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_policy());

        let listing = rpc
            .list_dir("src", true, Some(10))
            .expect("subdirectory should list");
        let paths: Vec<String> = listing
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .collect();

        assert_eq!(listing.path, "src");
        assert_eq!(
            paths,
            vec!["src/components/", "src/components/button.ts", "src/main.ts"]
        );
    }

    #[test]
    fn delete_file_refuses_workspace_root_and_requires_recursive_for_nonempty_dirs() {
        let fixture = WorkspaceFixture::new();
        fixture.write("notes/today.md", "hello");
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_write_policy());

        let root_error = rpc
            .delete_file(".", true)
            .expect_err("workspace root should be protected");
        let nonempty_error = rpc
            .delete_file("notes", false)
            .expect_err("non-empty dir should require recursive");
        let deleted = rpc
            .delete_file("notes", true)
            .expect("recursive delete should delete directory");

        assert_eq!(root_error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(nonempty_error.message, "workspace directory is not empty");
        assert_eq!(deleted.path, "notes");
        assert_eq!(deleted.kind, "dir");
        assert!(!fixture.root.join("notes").exists());
    }

    #[test]
    fn webui_skill_lifecycle_runs_in_rust_workspace_service() {
        let fixture = WorkspaceFixture::new();
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_write_policy());

        let created = rpc
            .webui_create_skill(serde_json::json!({
                "name": " Review Work! ",
                "description": "Review changes",
                "content": "Check diffs.",
                "always": true,
                "resources": ["scripts", "references", "invalid", "assets", "scripts"],
            }))
            .expect("skill should create");

        assert_eq!(created["created"], true);
        assert_eq!(created["name"], "review-work");
        assert_eq!(created["path"], "skills/review-work/SKILL.md");
        assert!(fixture.root.join("skills/review-work/scripts").is_dir());
        assert!(fixture.root.join("skills/review-work/references").is_dir());
        assert!(fixture.root.join("skills/review-work/assets").is_dir());

        let listed = rpc
            .webui_list_skills(Some(vec!["review-work".to_string()]))
            .expect("skills should list");
        assert_eq!(listed["skills"][0]["name"], "review-work");
        assert_eq!(listed["skills"][0]["enabled"], true);
        assert_eq!(listed["skills"][0]["always"], true);

        let detail = rpc
            .webui_skill_detail("review-work")
            .expect("skill detail should load");
        assert_eq!(detail["name"], "review-work");
        assert_eq!(detail["content"], "# Review Work\n\nCheck diffs.");
        assert_eq!(detail["metadata"]["description"], "Review changes");

        let updated = rpc
            .webui_update_skill(
                "review-work",
                serde_json::json!({
                    "description": "Updated review",
                    "content": "Review the changed files.",
                    "always": false,
                }),
            )
            .expect("skill should update");
        assert_eq!(updated["updated"], true);

        let validated = rpc
            .webui_validate_skill("review-work")
            .expect("skill should validate");
        assert_eq!(validated["valid"], true);
        assert_eq!(validated["message"], "Skill is valid");

        let deleted = rpc
            .webui_delete_skill("review-work")
            .expect("skill should delete");
        assert_eq!(deleted["deleted"], true);
        assert!(!fixture.root.join("skills/review-work").exists());
    }

    #[test]
    fn webui_skill_delete_rejects_builtin_skills() {
        let fixture = WorkspaceFixture::new();
        fixture.write_outside(
            "builtin-skills/planner/SKILL.md",
            "---\nname: planner\ndescription: Builtin planner\n---\nBuiltin body",
        );
        let rpc = WorkerWorkspaceRpc::new(fixture.root.clone(), read_write_policy())
            .with_builtin_skills_root(fixture.outside.clone());

        let error = rpc
            .webui_delete_skill("planner")
            .expect_err("builtin skill should not delete");

        assert_eq!(error.message, "cannot delete builtin skills");
        assert_eq!(error.details["status"], 403);
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead])
    }

    fn write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite])
    }

    fn read_write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::FsWorkspaceWrite,
        ])
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
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }

        fn write_outside(&self, relative_path: &str, contents: &str) {
            let path = self
                .outside
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("outside fixture parent should create");
            }
            std::fs::write(path, contents).expect("outside fixture file should write");
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
