use super::{NativeAgentCancellation, NativeAgentCheckpointStore};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

#[derive(Default)]
pub struct InMemoryNativeAgentCheckpointStore {
    checkpoints: Mutex<HashMap<String, StoredNativeCheckpoint>>,
    sequence: AtomicU64,
}

#[derive(Clone, Debug)]
struct StoredNativeCheckpoint {
    checkpoint: Value,
    sequence: u64,
}

impl NativeAgentCheckpointStore for InMemoryNativeAgentCheckpointStore {
    fn save(&self, session_id: &str, checkpoint: Value) {
        let run_id =
            checkpoint_run_id(&checkpoint).unwrap_or_else(|| legacy_session_run_id(session_id));
        self.save_for_run(session_id, &run_id, checkpoint);
    }

    fn save_for_run(&self, session_id: &str, run_id: &str, checkpoint: Value) {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .insert(
                checkpoint_key(session_id, run_id),
                StoredNativeCheckpoint {
                    checkpoint,
                    sequence,
                },
            );
    }

    fn restore(&self, session_id: &str) -> Option<Value> {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .iter()
            .filter_map(|(key, stored)| {
                checkpoint_key_session(key)
                    .filter(|key_session_id| *key_session_id == session_id)
                    .map(|_| stored)
            })
            .max_by_key(|stored| stored.sequence)
            .map(|stored| stored.checkpoint.clone())
    }

    fn restore_for_run(&self, session_id: &str, run_id: &str) -> Option<Value> {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .get(&checkpoint_key(session_id, run_id))
            .map(|stored| stored.checkpoint.clone())
    }

    fn clear(&self, session_id: &str) {
        let mut checkpoints = self
            .checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned");
        let Some(key) = checkpoints
            .iter()
            .filter(|(key, _stored)| {
                checkpoint_key_session(key)
                    .is_some_and(|key_session_id| key_session_id == session_id)
            })
            .max_by_key(|(_key, stored)| stored.sequence)
            .map(|(key, _stored)| key.clone())
        else {
            return;
        };
        checkpoints.remove(&key);
    }

    fn clear_for_run(&self, session_id: &str, run_id: &str) {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .remove(&checkpoint_key(session_id, run_id));
    }
}

fn checkpoint_key(session_id: &str, run_id: &str) -> String {
    format!("{session_id}\u{1f}{run_id}")
}

fn checkpoint_key_session(key: &str) -> Option<&str> {
    key.split_once('\u{1f}')
        .map(|(session_id, _run_id)| session_id)
}

fn checkpoint_run_id(checkpoint: &Value) -> Option<String> {
    checkpoint
        .get("runId")
        .or_else(|| checkpoint.get("run_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn legacy_session_run_id(session_id: &str) -> String {
    format!("legacy-session:{session_id}")
}

#[derive(Default)]
pub struct InMemoryNativeAgentCancellation {
    cancelled_runs: Mutex<HashMap<String, Option<String>>>,
}

impl NativeAgentCancellation for InMemoryNativeAgentCancellation {
    fn cancel(&self, run_id: &str) {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .insert(run_id.to_string(), None);
    }

    fn cancel_with_command_id(&self, run_id: &str, command_id: &str) {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .insert(run_id.to_string(), Some(command_id.to_string()));
    }

    fn command_id(&self, run_id: &str) -> Option<String> {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .get(run_id)
            .cloned()
            .flatten()
    }

    fn is_cancelled(&self, run_id: &str) -> bool {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .contains_key(run_id)
    }
}
