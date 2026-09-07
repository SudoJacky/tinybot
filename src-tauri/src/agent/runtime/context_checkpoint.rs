use super::{AgentError, AgentItemHistory};
use crate::threads::rollout::checkpoint_lineage::{ContextCheckpointParent, ContextWindowLineage};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextCheckpoint {
    pub schema_version: u32,
    pub context_id: String,
    pub source_version: String,
    pub history_version: u64,
    #[serde(flatten)]
    pub lineage: ContextWindowLineage,
    pub trigger: Option<String>,
    pub reason: Option<String>,
    pub phase: Option<String>,
    pub method: Option<String>,
    pub provider: Option<String>,
    pub model: String,
    pub estimated_tokens_before: i64,
    pub estimated_tokens_after: i64,
    pub masked_tool_output_count: usize,
    pub summary_request_count: usize,
    #[serde(with = "super::items::legacy_history")]
    pub installed_replacement_history: AgentItemHistory,
    #[serde(with = "super::items::legacy_history")]
    pub replacement_history: AgentItemHistory,
    pub checkpoint_stage: ContextCheckpointStage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextCheckpointStage {
    Installed,
    Finalized,
}

impl AgentContextCheckpoint {
    pub(crate) fn parent(&self) -> ContextCheckpointParent {
        ContextCheckpointParent {
            context_id: self.context_id.clone(),
            window_number: Some(self.lineage.window_number),
            first_window_id: Some(self.lineage.first_window_id.clone()),
            window_id: Some(self.lineage.window_id.clone()),
        }
    }

    pub(crate) fn validate_successor(
        &self,
        session_id: &str,
        current: &Self,
    ) -> Result<(), AgentError> {
        let expected = crate::threads::rollout::checkpoint_lineage::next_context_window_from_parent(
            session_id,
            &self.context_id,
            Some(&current.parent()),
        );
        if self.lineage != expected {
            return Err(AgentError::invalid_input(format!(
                "stale context compaction checkpoint: expected {expected:?}, actual {:?}",
                self.lineage
            )));
        }
        Ok(())
    }
}
