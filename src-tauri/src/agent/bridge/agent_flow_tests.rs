use super::*;
#[cfg(test)]
use crate::agent::bridge::TestApplicationServices;
#[cfg(test)]
use crate::agent::runtime::test_support::BlockingTestProvider;
use crate::agent::runtime::{
    AgentTurnContext, FakeNativeAgentToolDispatcher, InMemoryNativeAgentCancellation,
    InMemoryNativeAgentCheckpointStore, NativeAgentProviderResponse, NativeAgentToolCall,
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

impl BlockingTestProvider for DataViewProvider {
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

#[test]
fn cancelled_form_can_start_a_new_turn_after_reopening_storage() {
    struct FormProvider {
        calls: AtomicUsize,
    }
    impl BlockingTestProvider for FormProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
            if !first {
                let messages = context.messages.to_legacy_messages()?;
                let results: Vec<_> = messages
                    .iter()
                    .filter(|message| {
                        message["role"] == "tool" && message["tool_call_id"] == "cancel-form-call"
                    })
                    .collect();
                assert_eq!(results.len(), 1);
                assert_eq!(results[0]["content"], "User input request was cancelled.");
            }
            let arguments = serde_json::json!({
                "title": "Choose a target",
                "fields": [{"name": "target", "type": "text", "label": "Target"}]
            })
            .to_string();
            Ok(NativeAgentProviderResponse {
                final_content: if first { "" } else { "conversation recovered" }.into(),
                reasoning_delta: None,
                usage: None,
                response_items: if context.api_mode.as_deref() != Some("responses") {
                    Vec::new()
                } else if first {
                    vec![serde_json::json!({
                        "type": "function_call", "call_id": "cancel-form-call",
                        "name": "request_user_input", "arguments": arguments,
                    })]
                } else {
                    vec![serde_json::json!({
                        "type": "message", "id": "after-cancel-answer", "role": "assistant",
                        "status": "completed", "phase": "final_answer",
                        "content": [{"type": "output_text", "text": "conversation recovered"}],
                    })]
                },
                tool_calls: if first {
                    vec![NativeAgentToolCall {
                        id: "cancel-form-call".into(),
                        name: "request_user_input".into(),
                        arguments_json: arguments,
                        result: serde_json::Value::Null,
                    }]
                } else {
                    Vec::new()
                },
            })
        }
    }

    tauri::async_runtime::block_on(async {
        for mode in ["chat_completions", "responses"] {
            let workspace = TestWorkspace::new();
            let open = || {
                WorkspaceThreadStore::new_with_data_root(
                    workspace.root.clone(),
                    workspace.root.join("thread-data"),
                    default_desktop_capability_policy(),
                )
            };
            let provider = Arc::new(FormProvider {
                calls: AtomicUsize::new(0),
            });
            let make_services = |store: WorkspaceThreadStore| {
                NativeAgentRuntimeServices::new(
                    provider.clone(),
                    Arc::new(FakeNativeAgentToolDispatcher),
                    Arc::new(InMemoryNativeAgentCheckpointStore::default()),
                    Arc::new(InMemoryNativeAgentCancellation::default()),
                )
                .with_thread_store(store)
            };
            let store = open();
            let services = make_services(store.clone());
            let mut spec = serde_json::json!({
                "sessionId": "thread-cancel-form", "threadId": "thread-cancel-form",
                "turnId": "turn-form", "model": "fixture-model", "apiMode": mode,
                "messages": [{"role": "user", "content": "choose a target"}],
                "metadata": {"mcpEnabled": false},
            });
            let waiting = run_agent_from_wire_with_services(
                services.clone(),
                spec.clone(),
                workspace.root.clone(),
                serde_json::json!({}),
                None,
            )
            .await
            .unwrap();
            assert_eq!(waiting.stop_reason, AgentStopReason::AwaitingForm);
            spec.as_object_mut().unwrap().remove("messages");
            spec["metadata"]["agentContinuation"] = serde_json::json!({
                "kind": "form", "formId": "user-input:cancel-form-call", "action": "cancel",
            });
            let cancelled = run_agent_from_wire_with_services(
                services.clone(),
                spec,
                workspace.root.clone(),
                serde_json::json!({}),
                None,
            )
            .await
            .unwrap();
            assert_eq!(cancelled.stop_reason, AgentStopReason::FormCancelled);
            assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
            assert_eq!(cancelled.completed_tool_results.as_ref().unwrap().len(), 1);
            let persisted = store
                .agent_turn("thread-cancel-form", "turn-form")
                .unwrap()
                .unwrap();
            assert_eq!(persisted.completed_tool_results.len(), 1,
                "the new cancellation result must actually be persisted, not supplied by legacy recovery");
            store.flush().unwrap();
            drop(services);
            drop(store);

            let store = open();
            let history = store
                .agent_history("thread-cancel-form", 500)
                .unwrap()
                .unwrap();
            assert_eq!(serde_json::to_value(history.api_mode).unwrap(), mode);
            let results: Vec<_> = history
                .messages
                .iter()
                .filter(|message| {
                    message["role"] == "tool" && message["tool_call_id"] == "cancel-form-call"
                })
                .collect();
            assert_eq!(results.len(), 1);
            let resumed = run_agent_from_wire_with_services(
                make_services(store),
                serde_json::json!({
                    "sessionId": "thread-cancel-form", "threadId": "thread-cancel-form",
                    "turnId": "turn-after-cancel", "model": "fixture-model",
                    "apiMode": mode,
                    "messages": [{"role": "user", "content": "hello"}],
                    "metadata": {"mcpEnabled": false},
                }),
                workspace.root.clone(),
                serde_json::json!({}),
                None,
            )
            .await
            .unwrap();
            assert_eq!(resumed.stop_reason, AgentStopReason::FinalResponse);
            assert_eq!(resumed.final_content, "conversation recovered");
            assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        }
    });
}

impl NativeAgentTraceSink for FailWhenToolStartsLiveSink {
    fn append_trace_event(
        &self,
        _session_id: &str,
        _turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), crate::agent::runtime::AgentError> {
        if event.event_name == "agent.phase.changed" && event.payload["nextPhase"] == "tool_running"
        {
            return Err(AgentError::persistence(
                "live trace",
                crate::protocol::WorkerProtocolError::new(
                    crate::protocol::WorkerProtocolErrorCode::WorkerError,
                    "simulated live trace failure after tool delta",
                    serde_json::json!({"operation":"emit_tool_start"}),
                    true,
                    crate::protocol::WorkerProtocolErrorSource::RustCore,
                ),
            ));
        }
        Ok(())
    }

    fn append_timeline_patch(
        &self,
        _session_id: &str,
        _turn_id: &str,
        _patch: &AgentTimelinePatch,
    ) -> Result<(), crate::agent::runtime::AgentError> {
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
fn direct_thread_services_survive_reopening_canonical_storage() {
    let workspace = TestWorkspace::new();
    let open = || {
        WorkspaceThreadStore::new_with_data_root(
            workspace.root.clone(),
            workspace.root.join("thread-data"),
            default_desktop_capability_policy(),
        )
    };
    let store = open();
    let thread = store
        .create_agent_thread("thread-direct-service".into(), &serde_json::json!({}))
        .unwrap();
    assert_eq!(thread.metadata.extra["apiMode"], "chat_completions");
    store
        .start_agent_thread_turn(crate::threads::domain::StartThreadTurnRequest {
            thread_id: thread.thread_id.clone(),
            turn_id: Some("turn-direct-service".into()),
            client_event_id: Some("event-direct-service".into()),
            input: serde_json::json!({"role":"user", "content":"persisted request"}),
            ..Default::default()
        })
        .unwrap();
    store.flush().unwrap();
    let reopened = open();
    let snapshot = reopened.read_agent_thread(&thread.thread_id).unwrap();
    assert_eq!(
        snapshot.thread.active_turn_id.as_deref(),
        Some("turn-direct-service")
    );
    assert!(serde_json::to_string(&snapshot.items)
        .unwrap()
        .contains("persisted request"));
}

#[test]
fn invalid_thread_input_does_not_start_a_durable_turn() {
    tauri::async_runtime::block_on(async {
        let workspace = TestWorkspace::new();
        let store = WorkspaceThreadStore::new_with_data_root(
            workspace.root.clone(),
            workspace.root.join("thread-data"),
            default_desktop_capability_policy(),
        );
        let thread = store
            .create_agent_thread("thread-invalid-service".into(), &serde_json::json!({}))
            .unwrap();
        let services = NativeAgentRuntimeServices::default().with_thread_store(store.clone());
        let error = crate::agent::bridge::thread_flow::execute_thread_turn_with_services(
            services,
            crate::agent::bridge::thread_flow::SubmitThreadTurnInput {
                thread_id: Some(thread.thread_id.clone()),
                input: serde_json::json!({"content":"hello"}),
                spec: serde_json::json!({"turnId":"turn-invalid-service", "maxIterations":"invalid"}),
            }, workspace.root.clone(), serde_json::json!({}), None,
        ).await.err().expect("invalid settings should fail");
        assert_eq!(
            error.code,
            crate::agent::runtime::AgentErrorCode::InvalidRequest
        );
        assert!(store
            .read_agent_thread(&thread.thread_id)
            .unwrap()
            .active_turn
            .is_none());
        assert!(store.agent_turns(&thread.thread_id).unwrap().is_empty());
    });
}

#[test]
fn invalid_continuation_is_rejected_before_durability_and_task_ownership() {
    tauri::async_runtime::block_on(async {
        let workspace = TestWorkspace::new();
        let store = WorkspaceThreadStore::new_with_data_root(
            workspace.root.clone(),
            workspace.root.join("thread-data"),
            default_desktop_capability_policy(),
        );
        let provider = Arc::new(DataViewProvider {
            calls: AtomicUsize::new(0),
        });
        let services = NativeAgentRuntimeServices::new(
            provider.clone(),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_thread_store(store.clone());
        let runtime = services.runtime.task_runtime().clone();
        let error = run_agent_from_wire_with_services(
            services,
            serde_json::json!({
                "sessionId": "thread-invalid-input", "threadId": "thread-invalid-input",
                "turnId": "turn-invalid-input", "model": "fixture-model",
                "messages": [{"role":"user", "content":"hello"}],
                "metadata": {"agentContinuation": {"kind":"form", "formId":"missing-action"}}
            }),
            workspace.root.clone(),
            serde_json::json!({}),
            None,
        )
        .await
        .expect_err("invalid continuation should fail");
        assert!(error.to_string().contains("agentContinuation"), "{error}");
        assert_eq!(
            error.code,
            crate::agent::runtime::AgentErrorCode::InvalidRequest
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        assert!(runtime.status("turn-invalid-input").is_none());
        assert!(store
            .agent_turn("thread-invalid-input", "turn-invalid-input")
            .unwrap()
            .is_none());
    });
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
        let result = run_agent_from_wire_with_services(
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
            .to_string()
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
        assert_eq!(persisted["error"]["code"], "persistence_error");
        assert_eq!(persisted["error"]["serviceError"]["code"], "worker_error");
        assert_eq!(persisted["error"]["serviceError"]["retryable"], true);
        assert_eq!(
            persisted["error"]["serviceError"]["details"]["operation"],
            "emit_tool_start"
        );

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
#[test]
fn invalid_command_hooks_fail_the_durable_turn_before_provider_execution() {
    tauri::async_runtime::block_on(async {
        let workspace = TestWorkspace::new();
        let data_root = workspace.root.join("thread-data");
        std::fs::create_dir_all(&data_root).unwrap();
        std::fs::write(data_root.join("hooks.json"), "{invalid").unwrap();
        let store = WorkspaceThreadStore::new_with_data_root(
            workspace.root.clone(),
            data_root,
            default_desktop_capability_policy(),
        );
        let provider = Arc::new(DataViewProvider {
            calls: AtomicUsize::new(0),
        });
        let services = NativeAgentRuntimeServices::new(
            provider.clone(),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_thread_store(store.clone());
        let error = run_agent_from_wire_with_services(services, serde_json::json!({
            "sessionId":"hook-thread", "threadId":"hook-thread", "turnId":"hook-turn", "model":"fixture-model",
            "messages":[{"role":"user", "content":"hello"}],
        }), workspace.root.clone(), serde_json::json!({}), None).await.unwrap_err();
        assert!(error.to_string().contains("hook_config_invalid_json"));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        let turn = store
            .agent_turn("hook-thread", "hook-turn")
            .unwrap()
            .unwrap();
        assert_eq!(turn.status, crate::threads::turn::AgentTurnStatus::Failed);
    });
}
