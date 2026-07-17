use super::thread_flow::apply_native_agent_thread_op;
use crate::call_rust_state_service;
use crate::worker_agent_runtime::{
    NativeAgentContextCheckpointCommit, NativeAgentContextCheckpointCommitter,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
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
        if let Some(thread_id) = input.thread_id.as_deref() {
            let mut payload = input.event_payload.clone();
            payload["contextCheckpoint"] = input.checkpoint.clone();
            let operation = apply_native_agent_thread_op(
                thread_id,
                Some(format!("native-agent-context-checkpoint:{context_id}")),
                serde_json::json!({
                    "type": "runtime_event",
                    "runId": input.run_id,
                    "turnId": input.run_id,
                    "eventName": "agent.context.compacted",
                    "source": "rust_backend",
                    "visibility": "hidden",
                    "payload": payload,
                }),
                self.workspace_root.clone(),
                self.config_snapshot.clone(),
                "native agent context checkpoint commit",
                None,
            )?;
            let persisted_checkpoint = operation
                .get("appendedItems")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find_map(|item| {
                    item.get("kind")
                        .and_then(|kind| kind.get("payload"))
                        .and_then(|event| event.get("payload"))
                        .and_then(|payload| payload.get("contextCheckpoint"))
                })
                .ok_or_else(|| {
                    "thread context checkpoint commit returned no persisted checkpoint".to_string()
                })?;
            if persisted_checkpoint != &input.checkpoint {
                return Err(format!(
                    "thread context checkpoint identity `{context_id}` already has different content"
                ));
            }
            return Ok(());
        }

        let generated = next_worker_request_correlation();
        let result = call_rust_state_service(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            WorkerRequest::new(
                generated.id("session-context-checkpoint-commit"),
                generated.trace_id("session-context-checkpoint-commit"),
                "session.commit_context_checkpoint",
                serde_json::json!({
                    "session_id": input.session_id,
                    "run_id": input.run_id,
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
