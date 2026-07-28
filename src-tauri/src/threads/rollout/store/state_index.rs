use super::recorder::ThreadLogHead;
use super::ThreadStateRecord;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct LatestContextCheckpointRecord {
    pub(super) thread_id: String,
    pub(super) ordinal: i64,
    pub(super) timestamp: String,
    pub(super) checkpoint_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ThreadLogHeadRecord {
    pub(super) thread_id: String,
    pub(super) byte_length: i64,
    pub(super) tail_hash: String,
    pub(super) projection_hash: String,
}

#[derive(Clone, Debug, Default)]
pub struct ThreadStateIndex {
    inner: Arc<Mutex<ThreadStateIndexData>>,
}

#[derive(Debug, Default)]
struct ThreadStateIndexData {
    threads: BTreeMap<String, ThreadStateRecord>,
    latest_context_checkpoints: BTreeMap<String, LatestContextCheckpointRecord>,
    thread_log_heads: BTreeMap<String, ThreadLogHeadRecord>,
}

impl ThreadStateIndex {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub fn upsert_thread(&self, record: &ThreadStateRecord) -> Result<(), WorkerProtocolError> {
        let mut index = self.lock()?;
        upsert_thread(&mut index, record);
        Ok(())
    }

    pub(super) fn upsert_thread_projection(
        &self,
        record: &ThreadStateRecord,
        log_head: &ThreadLogHead,
    ) -> Result<(), WorkerProtocolError> {
        let mut index = self.lock()?;
        let stored = upsert_thread(&mut index, record);
        let latest_checkpoint = index.latest_context_checkpoints.get(&stored.id);
        let projection_hash = thread_projection_hash(&stored, latest_checkpoint);
        upsert_thread_log_head(&mut index, &stored.id, log_head, projection_hash);
        Ok(())
    }

    pub(super) fn replace_thread_projection(
        &self,
        record: &ThreadStateRecord,
        latest_checkpoint: Option<&LatestContextCheckpointRecord>,
        log_head: &ThreadLogHead,
    ) -> Result<(), WorkerProtocolError> {
        let mut index = self.lock()?;
        let stored = upsert_thread(&mut index, record);
        match latest_checkpoint {
            Some(checkpoint) => {
                index
                    .latest_context_checkpoints
                    .insert(stored.id.clone(), checkpoint.clone());
            }
            None => {
                index.latest_context_checkpoints.remove(&stored.id);
            }
        }
        let projection_hash = thread_projection_hash(&stored, latest_checkpoint);
        upsert_thread_log_head(&mut index, &stored.id, log_head, projection_hash);
        Ok(())
    }

    pub(super) fn thread_log_head(
        &self,
        id: &str,
    ) -> Result<Option<ThreadLogHeadRecord>, WorkerProtocolError> {
        let index = self.lock()?;
        let Some(record) = find_record(&index, id) else {
            return Ok(None);
        };
        Ok(index.thread_log_heads.get(&record.id).cloned())
    }

    pub(super) fn list_thread_log_heads(
        &self,
    ) -> Result<Vec<ThreadLogHeadRecord>, WorkerProtocolError> {
        Ok(self.lock()?.thread_log_heads.values().cloned().collect())
    }

    pub(super) fn latest_context_checkpoint(
        &self,
        id: &str,
    ) -> Result<Option<LatestContextCheckpointRecord>, WorkerProtocolError> {
        let index = self.lock()?;
        let Some(record) = find_record(&index, id) else {
            return Ok(None);
        };
        Ok(index.latest_context_checkpoints.get(&record.id).cloned())
    }

    pub(super) fn list_latest_context_checkpoints(
        &self,
    ) -> Result<Vec<LatestContextCheckpointRecord>, WorkerProtocolError> {
        Ok(self
            .lock()?
            .latest_context_checkpoints
            .values()
            .cloned()
            .collect())
    }

    pub fn list_threads(&self) -> Result<Vec<ThreadStateRecord>, WorkerProtocolError> {
        let mut records = self
            .lock()?
            .threads
            .values()
            .filter(|record| !record.archived)
            .cloned()
            .collect::<Vec<_>>();
        records.sort_by(thread_order);
        Ok(records)
    }

    pub fn list_all_threads(&self) -> Result<Vec<ThreadStateRecord>, WorkerProtocolError> {
        let mut records = self.lock()?.threads.values().cloned().collect::<Vec<_>>();
        records.sort_by(thread_order);
        Ok(records)
    }

    pub fn reset(&self) -> Result<(), WorkerProtocolError> {
        *self.lock()? = ThreadStateIndexData::default();
        Ok(())
    }

    pub fn find_by_session_or_thread_id(
        &self,
        id: &str,
    ) -> Result<Option<ThreadStateRecord>, WorkerProtocolError> {
        let index = self.lock()?;
        Ok(find_record(&index, id).cloned())
    }

    #[cfg(test)]
    pub fn archive_thread(
        &self,
        id: &str,
        archived_at: String,
    ) -> Result<Option<ThreadStateRecord>, WorkerProtocolError> {
        let mut index = self.lock()?;
        let Some(mut record) = find_record(&index, id).cloned() else {
            return Ok(None);
        };
        record.updated_at = archived_at.clone();
        record.archived = true;
        record.archived_at = Some(archived_at);
        index.threads.insert(record.id.clone(), record.clone());
        Ok(Some(record))
    }

    pub fn delete_thread(&self, id: &str) -> Result<bool, WorkerProtocolError> {
        let mut index = self.lock()?;
        let Some(record) = find_record(&index, id).cloned() else {
            return Ok(false);
        };
        index.latest_context_checkpoints.remove(&record.id);
        index.thread_log_heads.remove(&record.id);
        Ok(index.threads.remove(&record.id).is_some())
    }

    fn lock(&self) -> Result<MutexGuard<'_, ThreadStateIndexData>, WorkerProtocolError> {
        self.inner.lock().map_err(|_| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::WorkerError,
                "thread state index lock is poisoned",
                serde_json::json!({ "method": "thread_state_index" }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })
    }
}

fn upsert_thread(
    index: &mut ThreadStateIndexData,
    record: &ThreadStateRecord,
) -> ThreadStateRecord {
    let mut stored = record.clone();
    if let Some(existing) = index.threads.get(&record.id) {
        stored.created_at = existing.created_at.clone();
    }
    index.threads.insert(stored.id.clone(), stored.clone());
    stored
}

fn upsert_thread_log_head(
    index: &mut ThreadStateIndexData,
    thread_id: &str,
    log_head: &ThreadLogHead,
    projection_hash: String,
) {
    index.thread_log_heads.insert(
        thread_id.to_string(),
        ThreadLogHeadRecord {
            thread_id: thread_id.to_string(),
            byte_length: log_head.byte_length,
            tail_hash: log_head.tail_hash.clone(),
            projection_hash,
        },
    );
}

fn find_record<'a>(index: &'a ThreadStateIndexData, id: &str) -> Option<&'a ThreadStateRecord> {
    index.threads.get(id).or_else(|| {
        index
            .threads
            .values()
            .filter(|record| record.session_id.as_deref() == Some(id))
            .min_by(|left, right| thread_order(left, right))
    })
}

fn thread_order(left: &ThreadStateRecord, right: &ThreadStateRecord) -> std::cmp::Ordering {
    right
        .updated_at
        .cmp(&left.updated_at)
        .then_with(|| left.id.cmp(&right.id))
}

pub(super) fn thread_projection_hash(
    record: &ThreadStateRecord,
    latest_checkpoint: Option<&LatestContextCheckpointRecord>,
) -> String {
    let checkpoint = latest_checkpoint.map(|checkpoint| {
        serde_json::json!({
            "threadId": checkpoint.thread_id,
            "ordinal": checkpoint.ordinal,
            "timestamp": checkpoint.timestamp,
            "checkpointHash": checkpoint.checkpoint_hash,
        })
    });
    let projection = serde_json::json!({
        "id": record.id,
        "sessionId": record.session_id,
        "threadPath": record.thread_path,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "source": record.source,
        "title": record.title,
        "preview": record.preview,
        "cwd": record.cwd,
        "modelProvider": record.model_provider,
        "model": record.model,
        "tokensUsed": record.tokens_used,
        "archived": record.archived,
        "archivedAt": record.archived_at,
        "latestCheckpoint": checkpoint,
    });
    let encoded =
        serde_json::to_vec(&projection).expect("thread projection JSON serialization cannot fail");
    format!("sha256:{:x}", Sha256::digest(encoded))
}

#[cfg(test)]
#[path = "state_index_tests.rs"]
mod tests;
