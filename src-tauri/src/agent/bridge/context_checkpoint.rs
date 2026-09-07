use crate::agent::runtime::{
    AgentError, NativeAgentContextCheckpointCommit, NativeAgentContextCheckpointCommitter,
};
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::sync::Arc;

#[derive(Clone)]
struct NativeAgentContextCheckpointCommitAdapter {
    thread_store: WorkspaceThreadStore,
}

impl NativeAgentContextCheckpointCommitter for NativeAgentContextCheckpointCommitAdapter {
    fn commit(&self, input: &NativeAgentContextCheckpointCommit) -> Result<(), AgentError> {
        let thread_id = input.thread_id.as_deref().unwrap_or(&input.session_id);
        let result = self
            .thread_store
            .commit_agent_context_checkpoint(thread_id, &input.turn_id, &input.checkpoint)
            .map_err(|error| AgentError::persistence("context checkpoint commit", error))?;
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        if result.index_recovered {
            metrics.increment("compaction.persistence.index_recovered");
        }
        if !result.index_synchronized {
            metrics.increment("compaction.persistence.index_degraded");
            let diagnostics = result.diagnostics.join("; ");
            eprintln!("context checkpoint {} is durable but the derived thread index is degraded: {diagnostics}", input.checkpoint.context_id);
        }
        Ok(())
    }
}

pub(crate) fn native_agent_context_checkpoint_committer(
    thread_store: WorkspaceThreadStore,
) -> Arc<dyn NativeAgentContextCheckpointCommitter> {
    Arc::new(NativeAgentContextCheckpointCommitAdapter { thread_store })
}
