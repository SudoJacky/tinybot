use super::AgentCheckpoint;
use super::{NativeAgentCancellation, NativeAgentCheckpointStore};
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub struct InMemoryNativeAgentCheckpointStore {
    checkpoints: Mutex<HashMap<String, AgentCheckpoint>>,
}

impl NativeAgentCheckpointStore for InMemoryNativeAgentCheckpointStore {
    fn save_for_turn(&self, session_id: &str, turn_id: &str, checkpoint: AgentCheckpoint) {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .insert(checkpoint_key(session_id, turn_id), checkpoint);
    }

    fn restore_for_turn(&self, session_id: &str, turn_id: &str) -> Option<AgentCheckpoint> {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .get(&checkpoint_key(session_id, turn_id))
            .cloned()
    }

    fn clear_for_turn(&self, session_id: &str, turn_id: &str) {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .remove(&checkpoint_key(session_id, turn_id));
    }
}

fn checkpoint_key(session_id: &str, turn_id: &str) -> String {
    format!("{session_id}\u{1f}{turn_id}")
}

#[derive(Default)]
pub struct InMemoryNativeAgentCancellation {
    cancelled_turns: Mutex<HashMap<String, Option<String>>>,
}

impl NativeAgentCancellation for InMemoryNativeAgentCancellation {
    fn cancel(&self, turn_id: &str) {
        self.cancelled_turns
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .insert(turn_id.to_string(), None);
    }

    fn cancel_with_command_id(&self, turn_id: &str, command_id: &str) {
        self.cancelled_turns
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .insert(turn_id.to_string(), Some(command_id.to_string()));
    }

    fn command_id(&self, turn_id: &str) -> Option<String> {
        self.cancelled_turns
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .get(turn_id)
            .cloned()
            .flatten()
    }

    fn is_cancelled(&self, turn_id: &str) -> bool {
        self.cancelled_turns
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .contains_key(turn_id)
    }
}
