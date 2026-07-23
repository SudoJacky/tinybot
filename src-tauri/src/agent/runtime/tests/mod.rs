use super::*;
use crate::memory::WorkerMemoryRpc;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::WorkerRequest;
use crate::tools::registry::{
    ToolApprovalMetadata, ToolCancellationMode, ToolExecutionTarget, ToolExposure,
    ToolRegistryEntry, ToolRuntimePolicy, WorkerToolRegistryRpc,
};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

fn test_registry_with_model_tools(methods: &[&str]) -> Vec<ToolRegistryEntry> {
    let mut entries = WorkerToolRegistryRpc::new(
        crate::protocol::capability::default_desktop_capability_policy(),
    )
    .list_tools()
    .tools;

    if methods.contains(&"workspace.read_file") {
        entries.push(ToolRegistryEntry {
            tool_id: "workspace.read_file".to_string(),
            method: "workspace.read_file".to_string(),
            namespace: "test".to_string(),
            title: "Test read tool".to_string(),
            description: "Test-only read tool for generic runtime behavior.".to_string(),
            exposure: ToolExposure::Model,
            dynamic: false,
            supports_parallel_tool_calls: true,
            runtime_policy: ToolRuntimePolicy {
                supports_parallel_tool_calls: true,
                cancellation_mode: ToolCancellationMode::Cooperative,
                cleanup_timeout_ms: 100,
                mutates_workspace: false,
                mutates_session: false,
            },
            required_capabilities: vec![WorkerCapability::FsWorkspaceRead],
            available: true,
            approval: ToolApprovalMetadata {
                required: false,
                scope: None,
                lifetime: None,
            },
            input_schema: json!({
                "type": "object",
                "required": ["path"],
                "properties": { "path": { "type": "string" } }
            }),
            output_schema: json!({ "type": "object" }),
            execution_target: ToolExecutionTarget::WorkerRpc {
                method: "workspace.read_file".to_string(),
            },
        });
    }

    for entry in &mut entries {
        if methods.contains(&entry.method.as_str()) {
            entry.exposure = ToolExposure::Model;
            entry.approval.required = false;
            entry.approval.scope = None;
            entry.approval.lifetime = None;
        }
    }
    entries
}

fn test_registry_without_approval(methods: &[&str]) -> Vec<ToolRegistryEntry> {
    let mut entries = WorkerToolRegistryRpc::new(
        crate::protocol::capability::default_desktop_capability_policy(),
    )
    .list_tools()
    .tools;
    for entry in &mut entries {
        if methods.contains(&entry.method.as_str()) {
            entry.approval.required = false;
            entry.approval.scope = None;
            entry.approval.lifetime = None;
        }
    }
    entries
}

#[derive(Default)]
struct RecordingTraceSink {
    events: Arc<Mutex<Vec<AgentRuntimeEventEnvelope>>>,
    timeline_patches: Arc<Mutex<Vec<crate::agent::runtime_protocol::AgentTimelinePatch>>>,
}

#[derive(Default)]
struct FailingContextCheckpointCommitter {
    commits: Mutex<Vec<NativeAgentContextCheckpointCommit>>,
}

impl NativeAgentContextCheckpointCommitter for FailingContextCheckpointCommitter {
    fn commit(&self, input: &NativeAgentContextCheckpointCommit) -> Result<(), String> {
        self.commits
            .lock()
            .expect("checkpoint commit lock should not be poisoned")
            .push(input.clone());
        Err("fixture durable append failed".to_string())
    }
}

struct SystemPromptWorkspace {
    root: PathBuf,
}

impl SystemPromptWorkspace {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "tinybot-agent-system-prompt-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("system prompt workspace should create");
        Self { root }
    }
}

impl Drop for SystemPromptWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl NativeAgentTraceSink for RecordingTraceSink {
    fn load_runtime_events(
        &self,
        _session_id: &str,
        _turn_id: &str,
    ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
        Ok(self
            .events
            .lock()
            .expect("trace sink lock should not be poisoned")
            .clone())
    }

    fn append_trace_event(
        &self,
        _session_id: &str,
        _turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        self.events
            .lock()
            .expect("trace sink lock should not be poisoned")
            .push(event.clone());
        Ok(())
    }

    fn append_timeline_patch(
        &self,
        _session_id: &str,
        _turn_id: &str,
        patch: &crate::agent::runtime_protocol::AgentTimelinePatch,
    ) -> Result<(), String> {
        self.timeline_patches
            .lock()
            .expect("timeline patch sink lock should not be poisoned")
            .push(patch.clone());
        Ok(())
    }
}

fn wait_for_approval_id(trace_sink: &RecordingTraceSink, turn_id: &str) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(approval_id) = trace_sink
            .events
            .lock()
            .expect("trace sink lock should not be poisoned")
            .iter()
            .find(|event| {
                event.event_name == "agent.awaiting_approval" && event.payload["turnId"] == turn_id
            })
            .and_then(|event| event.payload["approvalId"].as_str())
            .map(str::to_string)
        {
            return approval_id;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "approval event for turn `{turn_id}` was not emitted"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

mod configuration;
mod context;
mod interactions;
mod lifecycle;
mod tools;

fn event_names(result: &Value) -> Vec<&str> {
    result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .map(|event| event["eventName"].as_str().unwrap_or_default())
        .collect::<Vec<_>>()
}

fn runtime_event_names(result: &Value) -> Vec<&str> {
    result["runtimeEvents"]
        .as_array()
        .expect("runtimeEvents should be an array")
        .iter()
        .map(|event| event["eventName"].as_str().unwrap_or_default())
        .collect::<Vec<_>>()
}

fn fixture_provider_config(content: &str) -> Value {
    json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": content }] } }
    })
}
