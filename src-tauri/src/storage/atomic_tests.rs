use super::*;
use serde::{ser::Error as _, Serializer};
use serde_json::json;

#[derive(Debug)]
struct FailingSerialize;

impl Serialize for FailingSerialize {
    fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        Err(S::Error::custom("intentional serialization failure"))
    }
}

#[test]
fn json_write_serializes_before_replacing_existing_file() {
    let root = temp_workspace_root("serialize-before-replace");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let path = root.join("store.json");
    fs::write(&path, "original\n").unwrap();

    let error = write_json_pretty_atomic(&path, &FailingSerialize, AtomicWriteOptions::default())
        .expect_err("failing serialization should be returned");

    assert!(matches!(error, WorkerStorageError::SerializeJson(_)));
    assert_eq!(fs::read_to_string(&path).unwrap(), "original\n");
    assert_eq!(temp_files(&root), Vec::<String>::new());
}

#[test]
fn text_write_uses_same_directory_temp_file_and_replaces_target() {
    let root = temp_workspace_root("same-dir-replace");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let path = root.join("nested").join("store.json");

    write_text_atomic(&path, "{\"ok\":true}\n", AtomicWriteOptions::default())
        .expect("atomic write should succeed");

    assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":true}\n");
    assert_eq!(temp_files(path.parent().unwrap()), Vec::<String>::new());
}

#[test]
fn text_write_can_backup_existing_target_before_replace() {
    let root = temp_workspace_root("backup-before-replace");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let path = root.join("store.json");
    fs::write(&path, "old\n").unwrap();

    write_text_atomic(
        &path,
        "new\n",
        AtomicWriteOptions::default().with_backup_suffix(".bak"),
    )
    .expect("atomic write should succeed");

    assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
    assert_eq!(
        fs::read_to_string(backup_path_for(&path, ".bak").unwrap()).unwrap(),
        "old\n"
    );
}

#[test]
fn strict_jsonl_returns_line_numbered_parse_errors() {
    let root = temp_workspace_root("strict-jsonl");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let path = root.join("records.jsonl");
    fs::write(&path, "{\"id\":1}\n\nnot-json\n").unwrap();

    let error =
        read_jsonl_strict::<serde_json::Value>(&path).expect_err("invalid line should fail");

    let WorkerStorageError::ParseJsonLine { line, .. } = error else {
        panic!("expected JSONL line parse error");
    };
    assert_eq!(line, 3);
}

#[test]
fn strict_jsonl_ignores_blank_lines_and_missing_files() {
    let root = temp_workspace_root("strict-jsonl-empty");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let missing = root.join("missing.jsonl");
    assert!(read_jsonl_strict::<serde_json::Value>(&missing)
        .unwrap()
        .is_empty());

    let path = root.join("records.jsonl");
    fs::write(&path, "\n{\"id\":1}\n\n").unwrap();
    assert_eq!(
        read_jsonl_strict::<serde_json::Value>(&path).unwrap(),
        vec![json!({ "id": 1 })]
    );
}

#[test]
fn strict_jsonl_with_lines_preserves_source_line_numbers() {
    let root = temp_workspace_root("strict-jsonl-lines");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let path = root.join("records.jsonl");
    fs::write(&path, "\n{\"id\":1}\n\n{\"id\":2}\n").unwrap();

    assert_eq!(
        read_jsonl_strict_with_lines::<serde_json::Value>(&path).unwrap(),
        vec![(json!({ "id": 1 }), 2), (json!({ "id": 2 }), 4)]
    );
}

fn temp_files(root: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    names.sort();
    names
}

fn temp_workspace_root(label: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    path.push(format!(
        "tinybot-worker-storage-{label}-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

struct TempWorkspaceCleanup(PathBuf);

impl Drop for TempWorkspaceCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
