use crate::agent::runtime::{
    NativeAgentContextCheckpointCommit, NativeAgentContextCheckpointCommitter,
};
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
struct NativeAgentContextCheckpointCommitAdapter {
    workspace_root: PathBuf,
    config_snapshot: Value,
}

impl NativeAgentContextCheckpointCommitter for NativeAgentContextCheckpointCommitAdapter {
    fn commit(&self, input: &NativeAgentContextCheckpointCommit) -> Result<(), String> {
        let context_id = input
            .checkpoint
            .get("contextId")
            .and_then(Value::as_str)
            .ok_or_else(|| "context checkpoint is missing contextId".to_string())?;
        let generated = next_worker_request_correlation();
        let rollout_id = input
            .thread_id
            .as_deref()
            .unwrap_or(input.session_id.as_str());
        let result = call_rust_state_service(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            WorkerRequest::new(
                generated.id("session-context-checkpoint-commit"),
                generated.trace_id("session-context-checkpoint-commit"),
                "session.commit_context_checkpoint",
                serde_json::json!({
                    "session_id": rollout_id,
                    "turn_id": input.turn_id,
                    "checkpoint": input.checkpoint,
                }),
            ),
            "native agent session context checkpoint commit",
        )?;
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        if result
            .get("indexRecovered")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            metrics.increment("compaction.persistence.index_recovered");
        }
        if !result
            .get("indexSynchronized")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            metrics.increment("compaction.persistence.index_degraded");
            let diagnostics = result
                .get("diagnostics")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; ");
            eprintln!(
                "context checkpoint {context_id} is durable but the derived thread index is degraded: {diagnostics}"
            );
        }
        Ok(())
    }
}

pub(crate) fn native_agent_context_checkpoint_committer(
    workspace_root: PathBuf,
    config_snapshot: Value,
) -> Arc<dyn NativeAgentContextCheckpointCommitter> {
    Arc::new(NativeAgentContextCheckpointCommitAdapter {
        workspace_root,
        config_snapshot,
    })
}
