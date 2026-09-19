use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-search-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, contents: impl AsRef<[u8]>) {
        let path = self.0.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    fn workspace(&self) -> WorkerWorkspaceRpc {
        WorkerWorkspaceRpc::new(
            self.0.clone(),
            CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
        )
    }
    fn search(&self, params: Value) -> Result<SearchResult, WorkerProtocolError> {
        self.workspace()
            .search_file_content(serde_json::from_value(params).unwrap(), None)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn literal_search_returns_unicode_paths_line_numbers_and_context() {
    let fixture = Fixture::new();
    fixture.write("中文 空格/a.txt", "before\n你好 a.b\naXb\nafter\n");
    let result = fixture
        .search(json!({"pattern": "a.b", "contextLines": 1}))
        .unwrap();
    assert_eq!(result.match_count, 1);
    assert!(!result.truncated);
    assert_eq!(result.entries.len(), 3);
    let matched = result.entries.iter().find(|e| e.kind == "match").unwrap();
    assert_eq!(matched.path, "中文 空格/a.txt");
    assert_eq!(matched.line, 2);
    assert_eq!(matched.text, "你好 a.b");
    assert_eq!(result.entries[0].kind, "context");
}

#[test]
fn regex_case_and_glob_filters_are_explicit() {
    let fixture = Fixture::new();
    fixture.write("a.rs", "HELLO123\nhello456\n");
    fixture.write("a.txt", "HELLO123\n");
    let result = fixture
        .search(
            json!({"pattern": "hello[0-9]+", "regex": true, "ignoreCase": true, "glob": "*.rs"}),
        )
        .unwrap();
    assert_eq!(result.match_count, 2);
    assert!(result.entries.iter().all(|e| e.path == "a.rs"));
}

#[test]
fn respects_ignore_hidden_binary_and_git_metadata_boundaries() {
    let fixture = Fixture::new();
    fixture.write("visible.txt", "needle");
    fixture.write("ignored.txt", "needle");
    fixture.write(".hidden.txt", "needle");
    fixture.write(".git/config", "needle");
    fixture.write(".gitignore", "ignored.txt\n");
    fixture.write("binary.dat", b"\0needle\0");
    let normal = fixture.search(json!({"pattern": "needle"})).unwrap();
    assert_eq!(normal.match_count, 1);
    assert_eq!(normal.entries[0].path, "visible.txt");
    let expanded = fixture
        .search(json!({"pattern": "needle", "includeHidden": true, "includeIgnored": true}))
        .unwrap();
    assert_eq!(expanded.match_count, 3);
    let explicit = fixture
        .search(json!({"pattern": "needle", "path": "ignored.txt"}))
        .unwrap();
    assert_eq!(explicit.match_count, 1);
    assert_eq!(explicit.scope["explicitFile"], true);
}

#[test]
fn literal_arguments_cannot_be_interpreted_as_flags_or_shell_commands() {
    let fixture = Fixture::new();
    fixture.write("-folder/a.txt", "--pre=touch injected & echo hi\n");
    let result = fixture
        .search(json!({"pattern": "--pre=touch injected & echo hi", "path": "-folder"}))
        .unwrap();
    assert_eq!(result.match_count, 1);
    assert!(!fixture.0.join("injected").exists());
}

#[test]
fn narrowed_directory_search_still_respects_project_root_ignores() {
    let fixture = Fixture::new();
    fixture.write(".gitignore", "ignored.txt\n");
    fixture.write("nested/ignored.txt", "needle");
    fixture.write("nested/visible.txt", "needle");
    let result = fixture
        .search(json!({"pattern": "needle", "path": "nested"}))
        .unwrap();
    assert_eq!(result.match_count, 1);
    assert_eq!(result.entries[0].path, "nested/visible.txt");
}

#[test]
fn no_matches_is_success_but_regex_and_path_errors_are_not() {
    let fixture = Fixture::new();
    fixture.write("a.txt", "hello");
    let result = fixture.search(json!({"pattern": "absent"})).unwrap();
    assert_eq!(result.match_count, 0);
    assert_eq!(result.stop_reason, "complete");
    let error = fixture
        .search(json!({"pattern": "[", "regex": true}))
        .unwrap_err();
    assert_eq!(error.details["exitCode"], 2);
    assert!(error.details["stderr"].as_str().unwrap().contains("regex"));
    assert!(fixture
        .search(json!({"pattern": "hello", "path": "missing"}))
        .is_err());
}

#[test]
fn caps_global_matching_lines_and_marks_incomplete_searches() {
    let fixture = Fixture::new();
    fixture.write("a.txt", "needle\nneedle\nneedle\n");
    let capped = fixture
        .search(json!({"pattern": "needle", "maxResults": 2}))
        .unwrap();
    assert_eq!(capped.match_count, 2);
    assert!(capped.truncated);
    assert_eq!(capped.stop_reason, "result_limit");
    let exact = fixture
        .search(json!({"pattern": "needle", "maxResults": 3}))
        .unwrap();
    assert_eq!(exact.match_count, 3);
    assert!(!exact.truncated);
}

#[test]
fn bounds_output_bytes_and_single_json_records() {
    let fixture = Fixture::new();
    fixture.write("a.txt", format!("needle{}\n", "a".repeat(MAX_OUTPUT_BYTES)));
    let result = fixture.search(json!({"pattern": "needle"})).unwrap();
    assert!(result.truncated);
    assert_eq!(result.stop_reason, "output_limit");
    fixture.write("a.txt", format!("needle{}\n", "a".repeat(1024 * 1024)));
    let result = fixture.search(json!({"pattern": "needle"})).unwrap();
    assert!(result.truncated);
    assert_eq!(result.stop_reason, "output_limit");
}

#[test]
fn rejects_workspace_escape_and_denied_read_capability() {
    let fixture = Fixture::new();
    for path in [
        "..",
        "../outside",
        "C:/outside",
        "/outside",
        ".git/config",
        ".GIT/config",
    ] {
        assert!(
            fixture
                .search(json!({"pattern": "x", "path": path}))
                .is_err(),
            "{path}"
        );
    }
    let denied = WorkerWorkspaceRpc::new(fixture.0.clone(), CapabilityPolicy::default());
    let error = denied
        .search_file_content(
            serde_json::from_value(json!({"pattern": "x"})).unwrap(),
            None,
        )
        .unwrap_err();
    assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
}

#[cfg(unix)]
#[test]
fn symlinks_do_not_expand_the_workspace_scope() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    outside.write("secret.txt", "needle");
    std::os::unix::fs::symlink(&outside.0, fixture.0.join("link")).unwrap();
    assert!(fixture
        .search(json!({"pattern": "needle", "path": "link"}))
        .is_err());
    assert_eq!(
        fixture
            .search(json!({"pattern": "needle"}))
            .unwrap()
            .match_count,
        0
    );
}

#[cfg(windows)]
#[test]
fn junctions_do_not_expand_the_workspace_scope() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    outside.write("secret.txt", "needle");
    let status = Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(fixture.0.join("link"))
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(status.status.success(), "{:?}", status.stderr);
    assert!(fixture
        .search(json!({"pattern": "needle", "path": "link"}))
        .is_err());
    assert_eq!(
        fixture
            .search(json!({"pattern": "needle"}))
            .unwrap()
            .match_count,
        0
    );
    std::fs::remove_dir(fixture.0.join("link")).unwrap();
}

#[test]
fn invalid_utf8_is_an_explicit_error() {
    let fixture = Fixture::new();
    fixture.write("a.txt", b"needle\xff\n");
    let error = fixture.search(json!({"pattern": "needle"})).unwrap_err();
    assert_eq!(error.details["reason"], "unsupported_encoding");
}

// A real child process used to verify that interruption returns only after reaping.
#[test]
#[ignore]
fn process_fixture() {
    if let Ok(marker) = std::env::var("TINYBOT_SEARCH_TEST_MARKER") {
        std::fs::write(marker, "started").unwrap();
        loop {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn waiting_child(fixture: &Fixture) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "workspace::search::tests::process_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("TINYBOT_SEARCH_TEST_MARKER", fixture.0.join("started"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

struct CancelOnMarker(PathBuf);
impl WorkerRequestCancellation for CancelOnMarker {
    fn is_cancelled(&self) -> bool {
        self.0.exists()
    }
}

#[test]
fn running_process_is_cancelled_and_reaped() {
    let fixture = Fixture::new();
    let mut child = waiting_child(&fixture);
    let cancellation = CancelOnMarker(fixture.0.join("started"));
    let started = Instant::now();
    let error = process::run(
        &mut child,
        Some(&cancellation),
        Duration::from_secs(10),
        |_| Ok(true),
    )
    .err()
    .unwrap();
    assert_eq!(error.details["cancelled"], true);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn running_process_times_out_and_is_reaped() {
    let fixture = Fixture::new();
    let started = Instant::now();
    let error = process::run(
        &mut waiting_child(&fixture),
        None,
        Duration::from_millis(100),
        |_| Ok(true),
    )
    .err()
    .unwrap();
    assert_eq!(error.details["timedOut"], true);
    assert!(started.elapsed() < Duration::from_secs(5));
}
