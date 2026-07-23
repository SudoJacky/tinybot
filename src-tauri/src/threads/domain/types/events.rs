use super::activity::ThreadChildActivity;
use super::items::ThreadItem;
use super::records::{ThreadCheckpoint, ThreadRecord, ThreadTurnSummary};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ThreadEvent {
    ThreadSnapshot {
        thread: ThreadRecord,
        #[serde(default)]
        active_turn: Option<ThreadTurnSummary>,
        #[serde(default)]
        latest_checkpoint: Option<ThreadCheckpoint>,
        #[serde(default)]
        turns: Vec<ThreadTurnSummary>,
        #[serde(default)]
        child_activities: Vec<ThreadChildActivity>,
    },
    ThreadStatus {
        thread: ThreadRecord,
        #[serde(default)]
        active_turn: Option<ThreadTurnSummary>,
        #[serde(default)]
        latest_checkpoint: Option<ThreadCheckpoint>,
        #[serde(default)]
        turns: Vec<ThreadTurnSummary>,
    },
    ChildActivity {
        child_activity: ThreadChildActivity,
    },
    ItemAppended {
        sequence: u64,
        item: ThreadItem,
    },
}
