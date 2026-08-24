use super::*;
use crate::agent::runtime::{
    AgentTurnContext, FakeNativeAgentToolDispatcher, InMemoryNativeAgentCancellation,
    InMemoryNativeAgentCheckpointStore, NativeAgentProvider, NativeAgentProviderResponse,
    NativeAgentToolCall,
};
use crate::agent::runtime_protocol::{AgentRuntimeEventEnvelope, AgentTimelinePatch};
use crate::protocol::capability::default_desktop_capability_policy;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::sync::atomic::{AtomicUsize, Ordering};

struct DataViewProvider {
    calls: AtomicUsize,
}

impl NativeAgentProvider for DataViewProvider {
    fn complete(&self, _context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![NativeAgentToolCall {
                    id: "call-data-view".to_string(),
                    name: "publish_data_view".to_string(),
                    arguments_json: serde_json::json!({
                        "schemaVersion": "tinybot.data_view.v1",
                        "title": "Agent projects",
                        "insight": "Compare projects.",
                        "dataset": {
                            "columns": [
                                { "key": "name", "label": "Project", "type": "string" },
                                { "key": "stars", "label": "Stars", "type": "number" }
                            ],
                            "rows": [{
                                "id": "openhands",
                                "values": { "name": "OpenHands", "stars": 84937 }
                            }]
                        },
                        "view": {
                            "kind": "table",
                            "fields": ["name", "stars"],
                            "defaultSort": "stars"
                        },
                        "provenance": { "status": "unsourced" }
                    })
                    .to_string(),
                    result: serde_json::json!({}),
                }],
                response_items: Vec::new(),
            });
        }
        Ok(NativeAgentProviderResponse {
            final_content: "done".to_string(),
            reasoning_delta: None,
            usage: None,
            tool_calls: Vec::new(),
            response_items: Vec::new(),
        })
    }
}

struct FailWhenToolStartsLiveSink;

impl NativeAgentTraceSink for FailWhenToolStartsLiveSink {
    fn append_trace_event(
        &self,
        _session_id: &str,
        _turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        if event.event_name == "agent.phase.changed" && event.payload["nextPhase"] == "tool_running"
        {
            return Err("simulated live trace failure after tool delta".to_string());
        }
        Ok(())
    }

    fn append_timeline_patch(
        &self,
        _session_id: &str,
        _turn_id: &str,
        _patch: &AgentTimelinePatch,
    ) -> Result<(), String> {
        Ok(())
    }
}

struct TestWorkspace {
    root: PathBuf,
}

impl TestWorkspace {
    fn new() -> Self {
        let correlation = next_worker_request_correlation();
        let root = std::env::temp_dir().join(format!(
            "tinybot-agent-flow-{}",
            correlation.id("workspace")
        ));
        std::fs::create_dir_all(&root).expect("test workspace should create");
        Self { root }
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn runtime_error_after_tool_delta_persists_a_failed_turn() {
    tauri::async_runtime::block_on(async {
        let workspace = TestWorkspace::new();
        let store = WorkspaceThreadStore::new_with_data_root(
            workspace.root.clone(),
            workspace.root.join("thread-data"),
            default_desktop_capability_policy(),
        );
        let services = NativeAgentRuntimeServices::new(
            Arc::new(DataViewProvider {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_thread_store(store.clone());
        let result = run_agent_with_services(
            services,
            serde_json::json!({
                "runtime": "rust",
                "sessionId": "thread-data-view-failure",
                "threadId": "thread-data-view-failure",
                "turnId": "turn-data-view-failure",
                "model": "fixture-model",
                "messages": [{ "role": "user", "content": "compare projects" }]
            }),
            workspace.root.clone(),
            serde_json::json!({}),
            Some(Arc::new(FailWhenToolStartsLiveSink)),
        )
        .await;

        assert!(result
            .expect_err("live trace failure should remain observable")
            .contains("simulated live trace failure after tool delta"));

        let correlation = next_worker_request_correlation();
        let turns = call_rust_state_service(
            &store,
            serde_json::json!({}),
            WorkerRequest::new(
                correlation.id("agent-flow-test-turn-list"),
                correlation.trace_id("agent-flow-test-turn-list"),
                "thread.turn.list",
                serde_json::json!({ "threadId": "thread-data-view-failure" }),
            ),
            "agent flow test turn list",
        )
        .expect("persisted turns should load");
        let turn = turns["turns"]
            .as_array()
            .expect("turns should be an array")
            .iter()
            .find(|turn| turn["turnId"] == "turn-data-view-failure")
            .expect("failed turn should remain persisted");

        assert_eq!(turn["status"], "failed");
        assert_eq!(turn["phase"], "failed");
        assert_eq!(turn["stopReason"], "runtime_error");

        let correlation = next_worker_request_correlation();
        let persisted = call_rust_state_service(
            &store,
            serde_json::json!({}),
            WorkerRequest::new(
                correlation.id("agent-flow-test-turn-get"),
                correlation.trace_id("agent-flow-test-turn-get"),
                "thread.turn.get",
                serde_json::json!({
                    "threadId": "thread-data-view-failure",
                    "turnId": "turn-data-view-failure"
                }),
            ),
            "agent flow test turn get",
        )
        .expect("failed turn should load");
        assert!(persisted["error"]["message"]
            .as_str()
            .expect("failed turn should preserve the runtime error")
            .contains("simulated live trace failure after tool delta"));

        let correlation = next_worker_request_correlation();
        let runtime_state = call_rust_state_service(
            &store,
            serde_json::json!({}),
            WorkerRequest::new(
                correlation.id("agent-flow-test-runtime-state"),
                correlation.trace_id("agent-flow-test-runtime-state"),
                "thread.turn.runtime_state",
                serde_json::json!({
                    "threadId": "thread-data-view-failure",
                    "turnId": "turn-data-view-failure"
                }),
            ),
            "agent flow test runtime state",
        )
        .expect("failed turn runtime state should load");
        assert_eq!(runtime_state["status"], "failed");
        assert_eq!(runtime_state["stopReason"], "runtime_error");
    });
}
