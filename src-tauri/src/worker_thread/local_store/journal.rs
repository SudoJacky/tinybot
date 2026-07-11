use super::index::ThreadIndex;
use super::{LocalThreadStore, ThreadItem, ThreadRecord, THREAD_STORE_VERSION};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const THREAD_JOURNAL_SCHEMA_VERSION: u32 = 1;
const THREAD_JOURNAL_FILE_NAME: &str = "thread-store.jsonl";
static JOURNAL_OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadPersistenceConsistencyStatus {
    Clean,
    LegacyProjection,
    Diverged,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPersistenceConsistencyReport {
    pub status: ThreadPersistenceConsistencyStatus,
    pub schema_version: u32,
    pub canonical_head: Option<String>,
    pub projection_head: Option<String>,
    pub canonical_thread_count: usize,
    pub projection_thread_count: usize,
    pub canonical_item_count: usize,
    pub projection_item_count: usize,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadPersistenceRepairMode {
    MigrateLegacyProjection,
    RebuildProjection,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPersistenceRepairRequest {
    pub mode: ThreadPersistenceRepairMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPersistenceRepairReport {
    pub mode: ThreadPersistenceRepairMode,
    pub before: ThreadPersistenceConsistencyReport,
    pub after: ThreadPersistenceConsistencyReport,
    pub migrated_thread_count: usize,
    pub rebuilt_thread_count: usize,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadJournalOperation {
    schema_version: u32,
    operation_id: String,
    timestamp: String,
    mutations: Vec<ThreadJournalMutation>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub(super) enum ThreadJournalMutation {
    UpsertThread {
        record: Box<ThreadRecord>,
    },
    UpsertItems {
        thread_id: String,
        items: Vec<ThreadItem>,
    },
    DeleteThread {
        thread_id: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
struct CanonicalThreadState {
    threads: BTreeMap<String, ThreadRecord>,
    items: BTreeMap<String, Vec<ThreadItem>>,
    head: Option<String>,
}

impl LocalThreadStore {
    pub fn check_persistence_consistency(
        &self,
    ) -> Result<ThreadPersistenceConsistencyReport, WorkerProtocolError> {
        let canonical = self.read_canonical_state()?;
        let projection = self.read_projection_state()?;
        let projection_head = if self.exists() {
            self.projection_journal_head()?
        } else {
            None
        };
        let canonical_item_count = item_count(&canonical.items);
        let projection_item_count = item_count(&projection.items);
        let journal_exists = self.journal_path().exists();
        let status = if !journal_exists {
            if projection.threads.is_empty() && projection_item_count == 0 {
                ThreadPersistenceConsistencyStatus::Clean
            } else {
                ThreadPersistenceConsistencyStatus::LegacyProjection
            }
        } else if canonical.threads == projection.threads
            && canonical.items == projection.items
            && canonical.head == projection_head
        {
            ThreadPersistenceConsistencyStatus::Clean
        } else {
            ThreadPersistenceConsistencyStatus::Diverged
        };
        let mut diagnostics = Vec::new();
        match status {
            ThreadPersistenceConsistencyStatus::Clean => {}
            ThreadPersistenceConsistencyStatus::LegacyProjection => diagnostics.push(
                "SQLite thread state predates the canonical journal; run the legacy projection migration before writes."
                    .to_string(),
            ),
            ThreadPersistenceConsistencyStatus::Diverged => {
                if canonical.head != projection_head {
                    diagnostics.push(format!(
                        "journal head {:?} does not match projection head {:?}",
                        canonical.head, projection_head
                    ));
                }
                if canonical.threads != projection.threads {
                    diagnostics.push("canonical thread records differ from the SQLite projection".to_string());
                }
                if canonical.items != projection.items {
                    diagnostics.push("canonical thread items differ from the SQLite projection".to_string());
                }
            }
        }
        Ok(ThreadPersistenceConsistencyReport {
            status,
            schema_version: THREAD_JOURNAL_SCHEMA_VERSION,
            canonical_head: canonical.head,
            projection_head,
            canonical_thread_count: canonical.threads.len(),
            projection_thread_count: projection.threads.len(),
            canonical_item_count,
            projection_item_count,
            diagnostics,
        })
    }

    pub fn repair_persistence(
        &self,
        mode: ThreadPersistenceRepairMode,
    ) -> Result<ThreadPersistenceRepairReport, WorkerProtocolError> {
        let _guard = self.lock_mutation()?;
        let before = self.check_persistence_consistency()?;
        let mut migrated_thread_count = 0;
        let mut rebuilt_thread_count = 0;
        match mode {
            ThreadPersistenceRepairMode::MigrateLegacyProjection => {
                if before.status != ThreadPersistenceConsistencyStatus::LegacyProjection {
                    return Err(persistence_error(
                        "legacy projection migration requires legacy_projection state",
                        serde_json::json!({ "status": before.status }),
                    ));
                }
                let projection = self.read_projection_state()?;
                migrated_thread_count = projection.threads.len();
                let mut mutations = Vec::new();
                for record in projection.threads.values() {
                    mutations.push(ThreadJournalMutation::UpsertThread {
                        record: Box::new(record.clone()),
                    });
                    if let Some(items) = projection.items.get(&record.thread_id) {
                        if !items.is_empty() {
                            mutations.push(ThreadJournalMutation::UpsertItems {
                                thread_id: record.thread_id.clone(),
                                items: items.clone(),
                            });
                        }
                    }
                }
                let head = self
                    .append_journal_operation(Some("migration:sqlite-projection:v1"), mutations)?;
                self.set_projection_journal_head(&head)?;
            }
            ThreadPersistenceRepairMode::RebuildProjection => {
                if !self.journal_path().exists() {
                    return Err(persistence_error(
                        "cannot rebuild the SQLite projection without a canonical journal",
                        serde_json::json!({ "journalPath": self.journal_path() }),
                    ));
                }
                let canonical = self.read_canonical_state()?;
                let head = canonical.head.clone().ok_or_else(|| {
                    persistence_error(
                        "canonical journal contains no operations",
                        serde_json::json!({ "journalPath": self.journal_path() }),
                    )
                })?;
                rebuilt_thread_count = canonical.threads.len();
                self.replace_projection(
                    &ThreadIndex {
                        version: THREAD_STORE_VERSION,
                        threads: canonical.threads.values().cloned().collect(),
                    },
                    &canonical.items,
                    &head,
                )?;
            }
        }
        let after = self.check_persistence_consistency()?;
        if after.status != ThreadPersistenceConsistencyStatus::Clean {
            return Err(persistence_error(
                "thread persistence repair did not produce a clean projection",
                serde_json::to_value(&after).unwrap_or_default(),
            ));
        }
        Ok(ThreadPersistenceRepairReport {
            mode,
            before,
            after,
            migrated_thread_count,
            rebuilt_thread_count,
        })
    }

    pub(super) fn begin_persistence_operation(
        &self,
        operation_id: Option<&str>,
        mutations: Vec<ThreadJournalMutation>,
    ) -> Result<String, WorkerProtocolError> {
        let canonical_head = self.read_journal_head()?;
        let projection_head = if self.exists() {
            self.projection_journal_head()?
        } else {
            None
        };
        let legacy_projection = canonical_head.is_none()
            && self.exists()
            && (!self.read_index()?.threads.is_empty() || !self.read_all_items()?.is_empty());
        if canonical_head != projection_head || legacy_projection {
            let report = self.check_persistence_consistency()?;
            return Err(persistence_error(
                "thread persistence is not consistent; run an explicit migration or repair before writing",
                serde_json::to_value(report).unwrap_or_default(),
            ));
        }
        self.append_journal_operation(operation_id, mutations)
    }

    pub(super) fn complete_persistence_operation(
        &self,
        journal_head: &str,
    ) -> Result<(), WorkerProtocolError> {
        self.set_projection_journal_head(journal_head)
    }

    pub(super) fn lock_mutation(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, ()>, WorkerProtocolError> {
        self.mutation_lock.lock().map_err(|_| {
            persistence_error(
                "thread persistence mutation lock is poisoned",
                serde_json::json!({}),
            )
        })
    }

    fn journal_path(&self) -> PathBuf {
        self.root
            .parent()
            .unwrap_or(&self.root)
            .join("state")
            .join(THREAD_JOURNAL_FILE_NAME)
    }

    fn append_journal_operation(
        &self,
        operation_id: Option<&str>,
        mutations: Vec<ThreadJournalMutation>,
    ) -> Result<String, WorkerProtocolError> {
        if mutations.is_empty() {
            return Err(persistence_error(
                "canonical thread journal operation must contain at least one mutation",
                serde_json::json!({}),
            ));
        }
        let operation_id = operation_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(generate_operation_id);
        let operation = ThreadJournalOperation {
            schema_version: THREAD_JOURNAL_SCHEMA_VERSION,
            operation_id: operation_id.clone(),
            timestamp: journal_timestamp(),
            mutations,
        };
        let mut serialized = serde_json::to_vec(&operation).map_err(|error| {
            persistence_error(
                format!("failed to serialize canonical thread journal operation: {error}"),
                serde_json::json!({ "operationId": operation_id }),
            )
        })?;
        serialized.push(b'\n');
        let path = self.journal_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| persistence_io_error("create", error))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| persistence_io_error("open", error))?;
        file.write_all(&serialized)
            .map_err(|error| persistence_io_error("append", error))?;
        file.flush()
            .map_err(|error| persistence_io_error("flush", error))?;
        file.sync_data()
            .map_err(|error| persistence_io_error("sync", error))?;
        Ok(operation_id)
    }

    fn read_journal_head(&self) -> Result<Option<String>, WorkerProtocolError> {
        const TAIL_CHUNK_SIZE: u64 = 8 * 1024;

        let path = self.journal_path();
        if !path.exists() {
            return Ok(None);
        }
        let mut file =
            fs::File::open(&path).map_err(|error| persistence_io_error("open", error))?;
        let mut end = file
            .seek(SeekFrom::End(0))
            .map_err(|error| persistence_io_error("seek", error))?;
        while end > 0 {
            file.seek(SeekFrom::Start(end - 1))
                .map_err(|error| persistence_io_error("seek", error))?;
            let mut byte = [0_u8; 1];
            file.read_exact(&mut byte)
                .map_err(|error| persistence_io_error("read", error))?;
            if matches!(byte[0], b'\n' | b'\r') {
                end -= 1;
            } else {
                break;
            }
        }
        if end == 0 {
            return Ok(None);
        }

        let mut cursor = end;
        let mut reverse_chunks = Vec::<Vec<u8>>::new();
        loop {
            let start = cursor.saturating_sub(TAIL_CHUNK_SIZE);
            let size = usize::try_from(cursor - start).map_err(|_| {
                persistence_error(
                    "canonical thread journal tail chunk is too large",
                    serde_json::json!({ "journalPath": path }),
                )
            })?;
            file.seek(SeekFrom::Start(start))
                .map_err(|error| persistence_io_error("seek", error))?;
            let mut chunk = vec![0_u8; size];
            file.read_exact(&mut chunk)
                .map_err(|error| persistence_io_error("read", error))?;
            if let Some(newline) = chunk.iter().rposition(|byte| *byte == b'\n') {
                reverse_chunks.push(chunk[(newline + 1)..].to_vec());
                break;
            }
            reverse_chunks.push(chunk);
            if start == 0 {
                break;
            }
            cursor = start;
        }

        let line = reverse_chunks
            .into_iter()
            .rev()
            .flatten()
            .collect::<Vec<_>>();
        let operation: ThreadJournalOperation = serde_json::from_slice(&line).map_err(|error| {
            persistence_error(
                format!("invalid canonical thread journal tail: {error}"),
                serde_json::json!({ "journalPath": path }),
            )
        })?;
        if operation.schema_version != THREAD_JOURNAL_SCHEMA_VERSION {
            return Err(persistence_error(
                format!(
                    "unsupported canonical thread journal schema version {}",
                    operation.schema_version
                ),
                serde_json::json!({
                    "schemaVersion": operation.schema_version,
                    "supportedSchemaVersion": THREAD_JOURNAL_SCHEMA_VERSION,
                }),
            ));
        }
        Ok(Some(operation.operation_id))
    }

    fn read_canonical_state(&self) -> Result<CanonicalThreadState, WorkerProtocolError> {
        let path = self.journal_path();
        if !path.exists() {
            return Ok(CanonicalThreadState::default());
        }
        let file = fs::File::open(&path).map_err(|error| persistence_io_error("open", error))?;
        let mut state = CanonicalThreadState::default();
        let mut seen_operations = HashMap::<String, ThreadJournalOperation>::new();
        for (line_index, line) in BufReader::new(file).lines().enumerate() {
            let line = line.map_err(|error| persistence_io_error("read", error))?;
            if line.trim().is_empty() {
                return Err(persistence_error(
                    "canonical thread journal contains a blank line",
                    serde_json::json!({ "line": line_index + 1, "journalPath": path }),
                ));
            }
            let operation: ThreadJournalOperation =
                serde_json::from_str(&line).map_err(|error| {
                    persistence_error(
                        format!("invalid canonical thread journal line: {error}"),
                        serde_json::json!({ "line": line_index + 1, "journalPath": path }),
                    )
                })?;
            if operation.schema_version != THREAD_JOURNAL_SCHEMA_VERSION {
                return Err(persistence_error(
                    format!(
                        "unsupported canonical thread journal schema version {}",
                        operation.schema_version
                    ),
                    serde_json::json!({
                        "line": line_index + 1,
                        "schemaVersion": operation.schema_version,
                        "supportedSchemaVersion": THREAD_JOURNAL_SCHEMA_VERSION,
                    }),
                ));
            }
            if let Some(existing) = seen_operations.get(&operation.operation_id) {
                if existing == &operation {
                    continue;
                }
                return Err(persistence_error(
                    "canonical thread journal reuses an operation id with different content",
                    serde_json::json!({ "operationId": operation.operation_id }),
                ));
            }
            apply_operation(&mut state, &operation)?;
            state.head = Some(operation.operation_id.clone());
            seen_operations.insert(operation.operation_id.clone(), operation);
        }
        Ok(state)
    }

    fn read_projection_state(&self) -> Result<CanonicalThreadState, WorkerProtocolError> {
        if !self.exists() {
            return Ok(CanonicalThreadState::default());
        }
        let index = self.read_index()?;
        let threads = index
            .threads
            .into_iter()
            .map(|record| (record.thread_id.clone(), record))
            .collect::<BTreeMap<_, _>>();
        let mut items = self.read_all_items()?;
        for thread_id in threads.keys() {
            items.entry(thread_id.clone()).or_default();
        }
        Ok(CanonicalThreadState {
            threads,
            items,
            head: self.projection_journal_head()?,
        })
    }
}

fn apply_operation(
    state: &mut CanonicalThreadState,
    operation: &ThreadJournalOperation,
) -> Result<(), WorkerProtocolError> {
    for mutation in &operation.mutations {
        match mutation {
            ThreadJournalMutation::UpsertThread { record } => {
                state
                    .threads
                    .insert(record.thread_id.clone(), record.as_ref().clone());
                state.items.entry(record.thread_id.clone()).or_default();
            }
            ThreadJournalMutation::UpsertItems { thread_id, items } => {
                if !state.threads.contains_key(thread_id) {
                    return Err(persistence_error(
                        "canonical item mutation references an unknown thread",
                        serde_json::json!({
                            "operationId": operation.operation_id,
                            "threadId": thread_id,
                        }),
                    ));
                }
                let stored = state.items.entry(thread_id.clone()).or_default();
                for item in items {
                    if item.thread_id != *thread_id || item.item_id.trim().is_empty() {
                        return Err(persistence_error(
                            "canonical item mutation contains an invalid thread or item id",
                            serde_json::json!({
                                "operationId": operation.operation_id,
                                "threadId": thread_id,
                                "itemId": item.item_id,
                            }),
                        ));
                    }
                    if let Some(position) = stored
                        .iter()
                        .position(|existing| existing.item_id == item.item_id)
                    {
                        stored[position] = item.clone();
                    } else {
                        stored.push(item.clone());
                    }
                }
                stored.sort_by_key(|item| item.sequence);
                for pair in stored.windows(2) {
                    if pair[0].sequence == pair[1].sequence {
                        return Err(persistence_error(
                            "canonical thread journal contains duplicate item sequences",
                            serde_json::json!({
                                "operationId": operation.operation_id,
                                "threadId": thread_id,
                                "sequence": pair[0].sequence,
                            }),
                        ));
                    }
                }
            }
            ThreadJournalMutation::DeleteThread { thread_id } => {
                state.threads.remove(thread_id);
                state.items.remove(thread_id);
            }
        }
    }
    Ok(())
}

fn item_count(items: &BTreeMap<String, Vec<ThreadItem>>) -> usize {
    items.values().map(Vec::len).sum()
}

fn generate_operation_id() -> String {
    format!(
        "thread-op-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        JOURNAL_OPERATION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn journal_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn persistence_io_error(operation: &str, error: std::io::Error) -> WorkerProtocolError {
    persistence_error(
        format!("canonical thread journal IO error during {operation}: {error}"),
        serde_json::json!({ "operation": operation }),
    )
}

fn persistence_error(
    message: impl Into<String>,
    details: serde_json::Value,
) -> WorkerProtocolError {
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

    #[test]
    fn future_journal_schema_fails_instead_of_guessing_a_migration() {
        let root = std::env::temp_dir().join(format!(
            "tinybot-thread-journal-future-schema-{}",
            generate_operation_id()
        ));
        let store = LocalThreadStore::new(root.clone());
        let path = store.journal_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"schemaVersion":2,"operationId":"future","timestamp":"1","mutations":[]}
"#,
        )
        .unwrap();

        let error = store.check_persistence_consistency().unwrap_err();

        assert!(error
            .message
            .contains("unsupported canonical thread journal schema version 2"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn journal_head_reader_handles_operations_larger_than_one_tail_chunk() {
        let root = std::env::temp_dir().join(format!(
            "tinybot-thread-journal-large-tail-{}",
            generate_operation_id()
        ));
        let store = LocalThreadStore::new(root.clone());
        store
            .append_journal_operation(
                Some("small-operation"),
                vec![ThreadJournalMutation::DeleteThread {
                    thread_id: "thread-small".to_string(),
                }],
            )
            .unwrap();
        store
            .append_journal_operation(
                Some("large-operation"),
                vec![ThreadJournalMutation::DeleteThread {
                    thread_id: "x".repeat(20_000),
                }],
            )
            .unwrap();

        assert_eq!(
            store.read_journal_head().unwrap().as_deref(),
            Some("large-operation")
        );
        let _ = fs::remove_dir_all(root);
    }
}
