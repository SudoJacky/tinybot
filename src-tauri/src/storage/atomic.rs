use serde::{de::DeserializeOwned, Serialize};
use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AtomicWriteOptions {
    backup_suffix: Option<String>,
}

impl AtomicWriteOptions {
    pub fn with_backup_suffix(mut self, suffix: impl Into<String>) -> Self {
        self.backup_suffix = Some(suffix.into());
        self
    }
}

#[derive(Debug)]
pub enum WorkerStorageError {
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    SerializeJson(serde_json::Error),
    ParseJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    ParseJsonLine {
        path: PathBuf,
        line: usize,
        source: serde_json::Error,
    },
}

impl WorkerStorageError {
    pub fn is_parse_error(&self) -> bool {
        matches!(
            self,
            WorkerStorageError::ParseJson { .. } | WorkerStorageError::ParseJsonLine { .. }
        )
    }
}

impl fmt::Display for WorkerStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WorkerStorageError::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "failed to {operation} {}: {source}",
                path.display()
            ),
            WorkerStorageError::SerializeJson(source) => {
                write!(formatter, "failed to serialize JSON store: {source}")
            }
            WorkerStorageError::ParseJson { path, source } => {
                write!(
                    formatter,
                    "failed to parse JSON store {}: {source}",
                    path.display()
                )
            }
            WorkerStorageError::ParseJsonLine { path, line, source } => write!(
                formatter,
                "failed to parse JSONL store {} at line {line}: {source}",
                path.display()
            ),
        }
    }
}

impl Error for WorkerStorageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            WorkerStorageError::Io { source, .. } => Some(source),
            WorkerStorageError::SerializeJson(source)
            | WorkerStorageError::ParseJson { source, .. }
            | WorkerStorageError::ParseJsonLine { source, .. } => Some(source),
        }
    }
}

pub fn read_json_store<T>(path: &Path) -> Result<T, WorkerStorageError>
where
    T: Default + DeserializeOwned,
{
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(io_error("read", path, error)),
    };
    if contents.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&contents).map_err(|source| WorkerStorageError::ParseJson {
        path: path.to_path_buf(),
        source,
    })
}

pub fn read_jsonl_strict<T>(path: &Path) -> Result<Vec<T>, WorkerStorageError>
where
    T: DeserializeOwned,
{
    Ok(read_jsonl_strict_with_lines(path)?
        .into_iter()
        .map(|(record, _line)| record)
        .collect())
}

pub fn read_jsonl_strict_with_lines<T>(path: &Path) -> Result<Vec<(T, usize)>, WorkerStorageError>
where
    T: DeserializeOwned,
{
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error("read", path, error)),
    };
    let mut records = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let line_number = index + 1;
        let record =
            serde_json::from_str(trimmed).map_err(|source| WorkerStorageError::ParseJsonLine {
                path: path.to_path_buf(),
                line: line_number,
                source,
            })?;
        records.push((record, line_number));
    }
    Ok(records)
}

pub fn write_json_pretty_atomic<T>(
    path: &Path,
    value: &T,
    options: AtomicWriteOptions,
) -> Result<(), WorkerStorageError>
where
    T: Serialize,
{
    let contents =
        serde_json::to_string_pretty(value).map_err(WorkerStorageError::SerializeJson)?;
    write_text_atomic(path, &format!("{contents}\n"), options)
}

pub fn write_jsonl_atomic<T>(
    path: &Path,
    records: &[T],
    options: AtomicWriteOptions,
) -> Result<(), WorkerStorageError>
where
    T: Serialize,
{
    let mut contents = String::new();
    for record in records {
        let line = serde_json::to_string(record).map_err(WorkerStorageError::SerializeJson)?;
        contents.push_str(&line);
        contents.push('\n');
    }
    write_text_atomic(path, &contents, options)
}

pub fn write_text_atomic(
    path: &Path,
    contents: &str,
    options: AtomicWriteOptions,
) -> Result<(), WorkerStorageError> {
    let parent = storage_parent(path);
    fs::create_dir_all(parent)
        .map_err(|error| io_error("create parent directory", parent, error))?;
    let temp_path = temp_path_for(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| io_error("create temporary file", &temp_path, error))?;
        file.write_all(contents.as_bytes())
            .map_err(|error| io_error("write temporary file", &temp_path, error))?;
        file.sync_all()
            .map_err(|error| io_error("sync temporary file", &temp_path, error))?;
        drop(file);
        if let Some(suffix) = options.backup_suffix.as_deref() {
            if path.exists() {
                let backup_path = backup_path_for(path, suffix)?;
                fs::copy(path, &backup_path)
                    .map_err(|error| io_error("backup target file", &backup_path, error))?;
            }
        }
        replace_file(&temp_path, path).map_err(|error| io_error("replace target file", path, error))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub fn backup_path_for(path: &Path, suffix: &str) -> Result<PathBuf, WorkerStorageError> {
    let file_name = file_name(path)?;
    Ok(storage_parent(path).join(format!("{file_name}{suffix}")))
}

fn temp_path_for(path: &Path) -> Result<PathBuf, WorkerStorageError> {
    let file_name = file_name(path)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(storage_parent(path).join(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        timestamp,
        sequence
    )))
}

fn file_name(path: &Path) -> Result<String, WorkerStorageError> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| {
            io_error(
                "resolve file name for",
                path,
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path does not include a file name",
                ),
            )
        })
}

fn storage_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

#[cfg(not(windows))]
pub(crate) fn replace_file(temp_path: &Path, target_path: &Path) -> io::Result<()> {
    fs::rename(temp_path, target_path)
}

#[cfg(windows)]
pub(crate) fn replace_file(temp_path: &Path, target_path: &Path) -> io::Result<()> {
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source = wide_path(temp_path);
    let target = wide_path(target_path);
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> WorkerStorageError {
    WorkerStorageError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
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

        let error =
            write_json_pretty_atomic(&path, &FailingSerialize, AtomicWriteOptions::default())
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
}
