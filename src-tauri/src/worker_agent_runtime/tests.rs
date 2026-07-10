use super::*;
use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_tool_registry::WorkerToolRegistryRpc;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Default)]
struct RecordingTraceSink {
    events: Arc<Mutex<Vec<AgentRuntimeEventEnvelope>>>,
}

impl NativeAgentTraceSink for RecordingTraceSink {
    fn append_trace_event(
        &self,
        _session_id: &str,
        _run_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        self.events
            .lock()
            .expect("trace sink lock should not be poisoned")
            .push(event.clone());
        Ok(())
    }
}

#[test]
fn trace_sink_receives_waiting_boundary_before_runtime_returns() {
    let sink = Arc::new(RecordingTraceSink::default());
    let events = sink.events.clone();
    let services = NativeAgentRuntimeServices::default().with_trace_sink(sink);

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-sink-waiting",
            "sessionId": "websocket:chat-sink-waiting",
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-sink",
                    "toolName": "workspace.write_file"
                }
            }
        }),
    )
    .expect("waiting run should return");
    let recorded = events
        .lock()
        .expect("trace sink lock should not be poisoned")
        .clone();

    assert_eq!(result["stopReason"], "awaiting_approval");
    assert!(recorded.iter().any(|event| {
        event.event_name == "agent.phase.changed"
            && event.payload["nextPhase"] == "awaiting_approval"
    }));
    assert!(recorded
        .iter()
        .any(|event| event.event_name == "agent.awaiting_approval"));
    assert_eq!(
        recorded.last().map(|event| event.event_name.as_str()),
        Some("agent.done")
    );
}

#[test]
fn selects_rust_runtime_from_spec_or_config() {
    assert_eq!(
        resolve_native_agent_runtime_mode(&json!({ "runtime": "rust" }), &json!({})),
        NativeAgentRuntimeMode::Rust
    );
    assert_eq!(
        resolve_native_agent_runtime_mode(
            &json!({}),
            &json!({ "desktop": { "nativeAgentRuntime": "rust" } })
        ),
        NativeAgentRuntimeMode::Rust
    );
    assert_eq!(
        resolve_native_agent_runtime_mode(&json!({}), &json!({})),
        NativeAgentRuntimeMode::Rust
    );
}

#[test]
fn normalizes_desktop_run_spec_inputs_for_rust_turns() {
    let context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-normalized",
            "activeSessionId": "websocket:active-chat",
            "provider": "fixture",
            "model": "fixture-model",
            "max_iterations": 4,
            "input": { "role": "user", "content": "hello normalized" },
            "metadata": {
                "_wants_stream": true,
                "source": "desktop"
            }
        }),
        json!({
            "agents": { "defaults": { "provider": "auto", "model": "fallback-model" } },
            "providers": { "fixture": { "responses": [{ "content": "normalized answer" }] } }
        }),
    );
    let request = agent_chat_completion_request(&context)
        .expect("normalized run spec should produce a chat completion request");
    let provider_config = agent_provider_config(&context);

    assert_eq!(context.session_id, "websocket:active-chat");
    assert_eq!(context.model, "fixture-model");
    assert_eq!(context.provider.as_deref(), Some("fixture"));
    assert_eq!(context.max_iterations, 4);
    assert!(context.stream);
    assert_eq!(context.metadata["source"], "desktop");
    assert_eq!(request["model"], "fixture-model");
    assert_eq!(request["stream"], true);
    assert_eq!(request["messages"][0]["content"], "hello normalized");
    assert_eq!(provider_config["agents"]["defaults"]["provider"], "fixture");
    assert_eq!(
        provider_config["agents"]["defaults"]["model"],
        "fixture-model"
    );
}

#[test]
fn chat_completion_request_injects_available_model_tools() {
    let mut context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-tools",
            "sessionId": "websocket:chat-tools",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "read the workspace" }]
        }),
        json!({}),
    );
    context.tool_registry_entries = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::FsWorkspaceRead,
        WorkerCapability::MemoryRead,
        WorkerCapability::KnowledgeRead,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionWrite,
    ]))
    .list_tools()
    .tools;

    let request = agent_chat_completion_request(&context)
        .expect("available model tools should produce a chat completion request");
    let tools = request["tools"]
        .as_array()
        .expect("available model tools should be injected");
    let names = tools
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();

    assert_eq!(request["tool_choice"], "auto");
    assert!(request.get("parallel_tool_calls").is_none());
    assert!(names.contains(&"workspace.read_file"));
    assert!(names.contains(&"memory.search"));
    assert!(names.contains(&"memory.recall"));
    assert!(names.contains(&"knowledge.query"));
    assert!(names.contains(&"subagent.spawn"));
    assert!(names.contains(&"subagent.send_input"));
    assert!(!names.contains(&"workspace.write_file"));
    assert!(!names.contains(&"workspace.delete_file"));
    assert!(!names.contains(&"mcp.call_tool"));
    assert!(!names.contains(&"shell.execute"));
    assert_eq!(tools[0]["type"], "function");
    assert_eq!(
        tools
            .iter()
            .find(|tool| tool["function"]["name"] == "workspace.read_file")
            .expect("workspace.read_file spec should be present")["function"]["parameters"],
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "offset": { "type": "integer" },
                "limit": { "type": "integer" },
                "format": { "type": "string" }
            }
        })
    );
}

#[test]
fn chat_completion_request_enables_parallel_tool_calls_only_when_explicitly_requested() {
    let mut context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-parallel-request",
            "sessionId": "websocket:chat-parallel-request",
            "model": "fixture-model",
            "parallelToolCalls": true,
            "messages": [{ "role": "user", "content": "read and search" }]
        }),
        json!({}),
    );
    context.tool_registry_entries = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::FsWorkspaceRead,
        WorkerCapability::MemoryRead,
    ]))
    .list_tools()
    .tools;

    let enabled_request = agent_chat_completion_request(&context)
        .expect("explicit parallel tool request should build");
    assert_eq!(enabled_request["parallel_tool_calls"], true);

    context.spec["parallelToolCalls"] = json!(false);
    let disabled_request = agent_chat_completion_request(&context)
        .expect("disabled parallel tool request should build");
    assert!(disabled_request.get("parallel_tool_calls").is_none());
}

#[test]
fn chat_completion_request_omits_tools_when_no_model_tools_are_available() {
    let mut context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-no-tools",
            "sessionId": "websocket:chat-no-tools",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({}),
    );
    context.tool_registry_entries = WorkerToolRegistryRpc::new(CapabilityPolicy::default())
        .list_tools()
        .tools;

    let request = agent_chat_completion_request(&context)
        .expect("request without available model tools should still be built");

    assert!(request.get("tools").is_none());
    assert!(request.get("tool_choice").is_none());
}

#[test]
fn chat_completion_request_keeps_tool_continuation_messages_unchanged() {
    let mut context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-tool-continuation",
            "sessionId": "websocket:chat-tool-continuation",
            "model": "fixture-model",
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call-read",
                        "type": "function",
                        "function": {
                            "name": "workspace.read_file",
                            "arguments": "{\"path\":\"README.md\"}"
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-read",
                    "name": "workspace.read_file",
                    "content": "{\"content\":\"README body\"}"
                },
                { "role": "user", "content": "continue" }
            ]
        }),
        json!({}),
    );
    context.tool_registry_entries =
        WorkerToolRegistryRpc::new(CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]))
            .list_tools()
            .tools;

    let request =
        agent_chat_completion_request(&context).expect("tool continuation request should be built");

    assert_eq!(request["messages"][0]["tool_calls"][0]["id"], "call-read");
    assert_eq!(request["messages"][1]["role"], "tool");
    assert_eq!(request["messages"][1]["tool_call_id"], "call-read");
    assert_eq!(
        request["messages"][1]["content"],
        "{\"content\":\"README body\"}"
    );
}

#[test]
fn invalid_request_stops_before_provider_call() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "runId": "run-invalid",
            "sessionId": "websocket:chat-invalid"
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "should not be used" }] } }
        }),
    )
    .expect("invalid request should return a structured result");

    assert_eq!(result["stopReason"], "invalid_request");
    assert_eq!(result["finalContent"], "");
    assert_eq!(event_names(&result), vec!["agent.error"]);
    assert_eq!(
        result["events"][0]["payload"]["stopReason"],
        "invalid_request"
    );
}

#[test]
fn runs_fixture_streaming_final_answer_with_frontend_events() {
    let result = run_native_agent_turn(json!({
        "runtime": "rust",
        "runId": "run-1",
        "sessionId": "websocket:chat-1",
        "stream": true,
        "messages": [{ "role": "user", "content": "hello" }],
        "config": fixture_provider_config("fixture answer")
    }))
    .expect("fixture provider run should succeed");

    assert_eq!(result["runtime"], "rust");
    assert_eq!(result["finalContent"], "fixture answer");
    assert_eq!(
        result["runtimeEvents"][0]["schemaVersion"],
        "tinybot.agent_event.v1"
    );
    let runtime_events = result["runtimeEvents"].as_array().unwrap();
    assert_eq!(
        runtime_events[0]["payload"]["nextPhase"],
        "hydrating_history"
    );
    assert_eq!(runtime_events[1]["payload"]["nextPhase"], "planning");
    let turn_started = runtime_events
        .iter()
        .find(|event| event["eventName"] == "agent.turn.started")
        .expect("turn started event should be present");
    assert_eq!(turn_started["eventName"], "agent.turn.started");
    assert_eq!(turn_started["payload"]["userMessage"]["content"], "hello");
    assert_eq!(turn_started["payload"]["userMessageId"], "run-1:user");
    assert!(runtime_events
        .iter()
        .any(|event| event["eventName"] == "agent.phase.changed"
            && event["payload"]["previousPhase"] == "planning"
            && event["payload"]["nextPhase"] == "calling_model"
            && event["payload"]["triggerEventName"] == "provider_call"));
    assert_eq!(
        runtime_events
            .iter()
            .filter(|event| event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "streaming_model")
            .count(),
        1
    );
    assert_eq!(result["events"][0]["eventName"], "agent.delta");
    assert_eq!(result["events"][1]["eventName"], "agent.usage");
    assert_eq!(result["events"][2]["eventName"], "agent.message.completed");
    assert_eq!(result["events"][2]["payload"]["content"], "fixture answer");
    assert_eq!(result["events"][3]["eventName"], "agent.done");
    assert_eq!(
        result["events"][3]["payload"]["stopReason"],
        "final_response"
    );
    assert!(result["events"][3]["payload"].get("finalContent").is_none());
}

#[test]
fn agent_chat_request_trims_old_messages_to_context_window() {
    let context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-context-window",
            "sessionId": "websocket:chat-context-window",
            "messages": [
                { "role": "user", "content": "old message ".repeat(200) },
                { "role": "assistant", "content": "old answer ".repeat(200) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 32
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context).expect("request should build");
    let messages = request["messages"]
        .as_array()
        .expect("messages should be an array");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "current question");
}

#[test]
fn agent_run_emits_context_trim_event_when_old_messages_are_discarded() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "runId": "run-context-trim-event",
            "sessionId": "websocket:chat-context-trim-event",
            "messages": [
                { "role": "user", "content": "old message ".repeat(200) },
                { "role": "assistant", "content": "old answer ".repeat(200) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 32
                }
            },
            "providers": { "fixture": { "responses": [{ "content": "fixture answer" }] } }
        }),
    )
    .expect("fixture provider run should succeed");

    let trim_event = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.context.trimmed")
        .expect("context trim event should be emitted");

    assert_eq!(trim_event["payload"]["strategy"], "discard");
    assert_eq!(trim_event["payload"]["droppedMessageCount"], 2);
    assert_eq!(trim_event["payload"]["retainedMessageCount"], 1);
    assert_eq!(trim_event["payload"]["contextWindowTokens"], 32);
}

#[test]
fn agent_chat_request_requests_stream_usage() {
    let context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-stream-usage",
            "sessionId": "websocket:chat-stream-usage",
            "stream": true,
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model"
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context).expect("request should build");

    assert_eq!(request["stream"], true);
    assert_eq!(request["stream_options"]["include_usage"], true);
}

#[test]
fn agent_chat_request_compacts_old_messages_when_strategy_is_compact() {
    let context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-context-compact",
            "sessionId": "websocket:chat-context-compact",
            "messages": [
                { "role": "user", "content": "old context ".repeat(200) },
                { "role": "assistant", "content": "old answer ".repeat(200) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 80,
                    "contextWindowStrategy": "compact",
                    "compactTriggerPercent": 50
                }
            },
            "providers": { "fixture": { "responses": [{ "content": "summary of earlier turns" }] } }
        }),
    );

    let request = agent_chat_completion_request(&context).expect("request should build");
    let messages = request["messages"]
        .as_array()
        .expect("messages should be an array");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "system");
    assert!(messages[0]["content"]
        .as_str()
        .expect("summary content should be text")
        .contains("summary of earlier turns"));
    assert_eq!(messages[1]["content"], "current question");
}

#[test]
fn agent_run_emits_context_compaction_event_when_old_messages_are_summarized() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "runId": "run-context-compact-event",
            "sessionId": "websocket:chat-context-compact-event",
            "messages": [
                { "role": "user", "content": "old context ".repeat(200) },
                { "role": "assistant", "content": "old answer ".repeat(200) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 80,
                    "contextWindowStrategy": "compact",
                    "compactTriggerPercent": 50
                }
            },
            "providers": {
                "fixture": {
                    "responses": [
                        { "content": "summary of earlier turns" },
                        { "content": "fixture answer" }
                    ]
                }
            }
        }),
    )
    .expect("fixture provider run should succeed");

    let compact_event = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.context.compacted")
        .expect("context compaction event should be emitted");

    assert_eq!(compact_event["payload"]["strategy"], "compact");
    assert_eq!(compact_event["payload"]["droppedMessageCount"], 2);
    assert_eq!(compact_event["payload"]["retainedMessageCount"], 1);
    assert_eq!(compact_event["payload"]["replacementMessageCount"], 2);
    assert_eq!(compact_event["payload"]["contextWindowTokens"], 80);
}

#[test]
fn agent_usage_event_includes_context_window_budget() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "runId": "run-usage-window",
            "sessionId": "websocket:chat-usage-window",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 100
                }
            },
            "providers": { "fixture": { "responses": [{ "content": "fixture answer" }] } }
        }),
    )
    .expect("fixture provider run should succeed");

    let usage_event = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.usage")
        .expect("usage event should be present");
    let usage = &usage_event["payload"]["usage"];

    assert_eq!(usage["context_window_tokens"], 100);
    assert!(usage["context_window_remaining_tokens"].is_number());
    assert!(usage["context_window_used_tokens"].is_number());
}

#[test]
fn usage_context_window_prefers_provider_total_tokens() {
    let context = NativeAgentRunContext::from_spec(
        json!({
            "runtime": "rust",
            "runId": "run-total-usage",
            "sessionId": "websocket:chat-total-usage",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 128000
                }
            }
        }),
    );

    let usage = enrich_usage_with_context_window(
        &context,
        json!({
            "prompt_tokens": 5,
            "completion_tokens": 167,
            "total_tokens": 172
        }),
        9,
        1000,
    );

    assert_eq!(usage["promptTokens"], 5);
    assert_eq!(usage["completionTokens"], 167);
    assert_eq!(usage["totalTokens"], 172);
    assert_eq!(usage["contextWindowUsedTokens"], 172);
    assert_eq!(usage["contextUsageTokens"], 172);
    assert_eq!(usage["cumulativeUsageTokens"], 1172);
    assert_eq!(usage["tokenUsageSource"], "provider_usage");
}

#[test]
fn agent_usage_event_falls_back_to_estimated_context_when_provider_omits_usage() {
    struct NoUsageProvider;

    impl NativeAgentProvider for NoUsageProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: "no usage answer".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }

        fn complete_streaming(
            &self,
            _context: &NativeAgentRunContext,
            observer: &mut dyn FnMut(NativeAgentProviderStreamEvent),
        ) -> Result<NativeAgentProviderResponse, String> {
            observer(NativeAgentProviderStreamEvent::ContentDelta(
                "no usage answer".to_string(),
            ));
            Ok(NativeAgentProviderResponse {
                final_content: "no usage answer".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let services = NativeAgentRuntimeServices {
        provider: Arc::new(NoUsageProvider),
        ..NativeAgentRuntimeServices::default()
    };
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-estimated-usage",
            "sessionId": "websocket:chat-estimated-usage",
            "messages": [{ "role": "user", "content": "hello world" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 128000
                }
            }
        }),
    )
    .expect("run should succeed");

    let usage_event = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.usage")
        .expect("usage event should be present");
    let usage = &usage_event["payload"]["usage"];

    assert_eq!(usage["context_window_tokens"], 128000);
    assert!(
        usage["estimated_context_tokens"]
            .as_i64()
            .unwrap_or_default()
            > 0
    );
    assert_eq!(
        usage["context_window_used_tokens"],
        usage["estimated_context_tokens"]
    );
}

#[test]
fn emits_user_visible_status_events_without_legacy_event_projection() {
    let result = run_native_agent_turn(json!({
        "runtime": "rust",
        "runId": "run-status",
        "sessionId": "websocket:chat-status",
        "stream": true,
        "messages": [{ "role": "user", "content": "hello" }],
        "config": fixture_provider_config("fixture answer")
    }))
    .expect("fixture provider run should succeed");

    let runtime_events = result["runtimeEvents"].as_array().unwrap();
    assert!(runtime_events.iter().any(|event| {
        event["eventName"] == "agent.status"
            && event["phase"] == "calling_model"
            && event["visibility"] == "user"
            && event["payload"]["runId"] == "run-status"
            && event["payload"]["sessionId"] == "websocket:chat-status"
            && event["payload"]["phase"] == "calling_model"
            && event["payload"]["label"] == "Calling model"
            && event["payload"]["detail"] == "provider_call"
            && event["payload"]["iteration"] == 0
            && event["payload"]["isBlocking"] == false
    }));
    assert!(runtime_events.iter().any(|event| {
        event["eventName"] == "agent.status"
            && event["phase"] == "streaming_model"
            && event["payload"]["label"] == "Streaming response"
    }));
    assert!(result["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|event| event["eventName"] != "agent.status"));
}

#[test]
fn runs_fixture_tool_event_sequence() {
    let services = NativeAgentRuntimeServices::default();
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-tool",
            "sessionId": "websocket:chat-1",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-1",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "README" }
                            }]
                        },
                        { "content": "tool complete" }
                    ]
                }
            }
        }),
    )
    .expect("fixture tool run should succeed");

    let event_names = event_names(&result);
    let runtime_event_names = runtime_event_names(&result);
    let runtime_events = result["runtimeEvents"].as_array().unwrap();
    let tool_calling_phase_index = runtime_events
        .iter()
        .position(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "tool_calling"
        })
        .expect("tool calling phase change should precede tool call delta");
    let tool_call_delta_index = runtime_event_names
        .iter()
        .position(|event_name| *event_name == "agent.tool_call.delta")
        .expect("tool call delta event should be present");
    assert!(tool_calling_phase_index < tool_call_delta_index);
    assert!(result["runtimeEvents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "tool_running"
                && event["payload"]["triggerEventName"] == "agent.tool.start"
        }));
    assert_eq!(
        &event_names[..3],
        &[
            "agent.tool_call.delta",
            "agent.tool.start",
            "agent.tool.result"
        ]
    );
    assert_eq!(event_names.last().copied(), Some("agent.done"));
    assert_eq!(result["finalContent"], "tool complete");
    assert_eq!(result["toolsUsed"][0], "workspace.read_file");
}

#[test]
fn feeds_tool_observation_back_into_second_provider_call() {
    struct TwoStepProvider {
        seen_messages: Mutex<Vec<Value>>,
    }

    impl NativeAgentProvider for TwoStepProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let request = agent_chat_completion_request(context)
                .expect("provider context should build request messages");
            self.seen_messages
                .lock()
                .expect("seen messages lock should not be poisoned")
                .push(request["messages"].clone());
            let call_count = self
                .seen_messages
                .lock()
                .expect("seen messages lock should not be poisoned")
                .len();

            if call_count == 1 {
                Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-read".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "README body" }),
                    }],
                })
            } else {
                Ok(NativeAgentProviderResponse {
                    final_content: "I read README body.".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                })
            }
        }
    }

    let provider = Arc::new(TwoStepProvider {
        seen_messages: Mutex::new(Vec::new()),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-tool-loop",
            "sessionId": "websocket:chat-tool-loop",
            "maxIterations": 4,
            "messages": [{ "role": "user", "content": "read README then answer" }]
        }),
    )
    .expect("multi-iteration tool run should complete");

    let seen_messages = provider
        .seen_messages
        .lock()
        .expect("seen messages lock should not be poisoned");
    assert_eq!(seen_messages.len(), 2);
    assert_eq!(result["finalContent"], "I read README body.");
    assert_eq!(result["stopReason"], "final_response");
    assert!(seen_messages[1]
        .as_array()
        .expect("messages should be an array")
        .iter()
        .any(|message| message["role"] == "tool"
            && message["tool_call_id"] == "call-read"
            && message["content"]
                .as_str()
                .expect("tool observation should be text")
                .contains("README body")));
}

#[test]
fn registry_model_tool_calls_are_permitted_by_runtime_dispatch() {
    struct MemorySearchProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for MemorySearchProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self
                .calls
                .lock()
                .expect("provider call count lock should not be poisoned");
            *calls += 1;
            if *calls == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-memory-search".to_string(),
                        name: "memory.search".to_string(),
                        arguments_json: "{\"query\":\"tool runtime\"}".to_string(),
                        result: json!({ "notes": [] }),
                    }],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "memory search complete".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let services = NativeAgentRuntimeServices::new(
        Arc::new(MemorySearchProvider {
            calls: Mutex::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-memory-search-tool",
            "sessionId": "websocket:chat-memory-search-tool",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "search memory" }]
        }),
    )
    .expect("memory search tool run should return a structured result");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["toolsUsed"], json!(["memory.search"]));
    assert_eq!(result["finalContent"], "memory search complete");
}

#[test]
fn tool_runtime_dispatches_through_async_dispatch_seam() {
    struct OneToolThenFinalProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for OneToolThenFinalProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self.calls.lock().expect("provider calls lock");
            *calls += 1;
            if *calls == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-async-dispatch".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "sync dispatch must not run" }),
                    }],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "async dispatch complete".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    struct AsyncOnlyDispatcher {
        async_dispatches: AtomicUsize,
    }

    impl NativeAgentToolDispatcher for AsyncOnlyDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            _tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            panic!("tool runtime should use dispatch_async, not sync dispatch");
        }

        fn dispatch_async(
            &self,
            _context: NativeAgentRunContext,
            tool_call: NativeAgentToolCall,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send + '_,
            >,
        > {
            self.async_dispatches.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(NativeAgentToolResult::generic_success(
                    &tool_call,
                    json!({ "content": "async dispatch ran" }),
                ))
            })
        }
    }

    let dispatcher = Arc::new(AsyncOnlyDispatcher {
        async_dispatches: AtomicUsize::new(0),
    });
    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            Arc::new(OneToolThenFinalProvider {
                calls: Mutex::new(0),
            }),
            dispatcher.clone(),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-async-dispatch-seam",
            "sessionId": "websocket:chat-async-dispatch-seam",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run async dispatcher" }]
        }),
    )
    .expect("async dispatch seam should complete");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(dispatcher.async_dispatches.load(Ordering::SeqCst), 1);
    assert_eq!(result["finalContent"], "async dispatch complete");
}

#[test]
fn registry_marks_only_read_only_model_tools_as_parallel_safe() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::FsWorkspaceRead,
        WorkerCapability::FsWorkspaceWrite,
        WorkerCapability::ApprovalRequest,
        WorkerCapability::MemoryRead,
        WorkerCapability::KnowledgeRead,
        WorkerCapability::McpCall,
        WorkerCapability::ShellExecute,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionWrite,
    ]));
    let tools = registry.list_tools().tools;
    let parallel_methods = tools
        .iter()
        .filter(|tool| tool.supports_parallel_tool_calls)
        .map(|tool| tool.method)
        .collect::<Vec<_>>();

    assert_eq!(
        parallel_methods,
        vec![
            "workspace.read_file",
            "knowledge.query",
            "memory.search",
            "memory.recall"
        ]
    );
    assert!(
        !tools
            .iter()
            .find(|tool| tool.method == "workspace.write_file")
            .expect("workspace.write_file should be registered")
            .supports_parallel_tool_calls
    );
    assert!(
        !tools
            .iter()
            .find(|tool| tool.method == "shell.execute")
            .expect("shell.execute should be registered")
            .supports_parallel_tool_calls
    );
    assert!(
        !tools
            .iter()
            .find(|tool| tool.method == "subagent.spawn")
            .expect("subagent.spawn should be registered")
            .supports_parallel_tool_calls
    );
}

#[test]
fn registry_exposes_runtime_policy_for_cancellation_and_mutation_classification() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::FsWorkspaceRead,
        WorkerCapability::FsWorkspaceWrite,
        WorkerCapability::ApprovalRequest,
        WorkerCapability::MemoryRead,
        WorkerCapability::KnowledgeRead,
        WorkerCapability::McpCall,
        WorkerCapability::ShellExecute,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionWrite,
    ]));
    let tools = registry.list_tools().tools;
    let read_file = tools
        .iter()
        .find(|tool| tool.method == "workspace.read_file")
        .expect("workspace.read_file should be registered");
    let write_file = tools
        .iter()
        .find(|tool| tool.method == "workspace.write_file")
        .expect("workspace.write_file should be registered");
    let shell = tools
        .iter()
        .find(|tool| tool.method == "shell.execute")
        .expect("shell.execute should be registered");
    let subagent_spawn = tools
        .iter()
        .find(|tool| tool.method == "subagent.spawn")
        .expect("subagent.spawn should be registered");

    assert!(read_file.runtime_policy.supports_parallel_tool_calls);
    assert!(!read_file.runtime_policy.waits_for_runtime_cancellation);
    assert!(!read_file.runtime_policy.mutates_workspace);
    assert!(!read_file.runtime_policy.mutates_session);

    assert!(!write_file.runtime_policy.supports_parallel_tool_calls);
    assert!(!write_file.runtime_policy.waits_for_runtime_cancellation);
    assert!(write_file.runtime_policy.mutates_workspace);
    assert!(!write_file.runtime_policy.mutates_session);

    assert!(!shell.runtime_policy.supports_parallel_tool_calls);
    assert!(shell.runtime_policy.waits_for_runtime_cancellation);
    assert!(shell.runtime_policy.mutates_workspace);
    assert!(!shell.runtime_policy.mutates_session);

    assert!(!subagent_spawn.runtime_policy.supports_parallel_tool_calls);
    assert!(subagent_spawn.runtime_policy.waits_for_runtime_cancellation);
    assert!(!subagent_spawn.runtime_policy.mutates_workspace);
    assert!(subagent_spawn.runtime_policy.mutates_session);
}

#[test]
fn read_only_tool_batch_runs_concurrently_and_preserves_model_ordered_observations() {
    struct TwoReadOnlyToolsThenFinalProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for TwoReadOnlyToolsThenFinalProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let call_count = {
                let mut seen_messages = self
                    .seen_messages
                    .lock()
                    .expect("seen messages lock should not be poisoned");
                seen_messages.push(context.messages.clone());
                seen_messages.len()
            };
            if call_count == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![
                        NativeAgentToolCall {
                            id: "call-read-first".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: "{\"path\":\"README.md\"}".to_string(),
                            result: json!({ "content": "README first" }),
                        },
                        NativeAgentToolCall {
                            id: "call-memory-second".to_string(),
                            name: "memory.search".to_string(),
                            arguments_json: "{\"query\":\"README\"}".to_string(),
                            result: json!({ "content": "memory second" }),
                        },
                    ],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "parallel tools complete".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    struct OverlapRecordingDispatcher {
        running: AtomicUsize,
        max_running: AtomicUsize,
    }

    impl NativeAgentToolDispatcher for OverlapRecordingDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let running = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_running.fetch_max(running, Ordering::SeqCst);
            let delay_ms = if tool_call.id == "call-read-first" {
                120
            } else {
                20
            };
            thread::sleep(Duration::from_millis(delay_ms));
            self.running.fetch_sub(1, Ordering::SeqCst);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let provider = Arc::new(TwoReadOnlyToolsThenFinalProvider {
        seen_messages: Mutex::new(Vec::new()),
    });
    let dispatcher = Arc::new(OverlapRecordingDispatcher {
        running: AtomicUsize::new(0),
        max_running: AtomicUsize::new(0),
    });
    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            provider.clone(),
            dispatcher.clone(),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-read-only-parallel-tools",
            "sessionId": "websocket:chat-read-only-parallel-tools",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run read-only tools" }]
        }),
    )
    .expect("parallel read-only tool run should complete");
    let seen_messages = provider
        .seen_messages
        .lock()
        .expect("seen messages lock should not be poisoned");
    let second_request_messages = &seen_messages[1];
    let tool_messages = second_request_messages
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect::<Vec<_>>();

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(dispatcher.max_running.load(Ordering::SeqCst), 2);
    assert_eq!(
        result["toolsUsed"],
        json!(["workspace.read_file", "memory.search"])
    );
    assert_eq!(tool_messages.len(), 2);
    assert_eq!(tool_messages[0]["tool_call_id"], "call-read-first");
    assert_eq!(tool_messages[0]["content"], "README first");
    assert_eq!(tool_messages[1]["tool_call_id"], "call-memory-second");
    assert_eq!(tool_messages[1]["content"], "memory second");
}

#[test]
fn read_only_mcp_tool_calls_use_read_lock_scheduling() {
    struct TwoMcpToolsThenFinalProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for TwoMcpToolsThenFinalProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self.calls.lock().expect("provider calls lock");
            *calls += 1;
            if *calls == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![
                        NativeAgentToolCall {
                            id: "call-mcp-read-one".to_string(),
                            name: "mcp.call_tool".to_string(),
                            arguments_json:
                                "{\"server\":\"docs\",\"tool\":\"lookup\",\"arguments\":{}}"
                                    .to_string(),
                            result: json!({ "content": "lookup" }),
                        },
                        NativeAgentToolCall {
                            id: "call-mcp-read-two".to_string(),
                            name: "mcp.call_tool".to_string(),
                            arguments_json:
                                "{\"server\":\"docs\",\"tool\":\"search\",\"arguments\":{}}"
                                    .to_string(),
                            result: json!({ "content": "search" }),
                        },
                    ],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "mcp reads complete".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    struct McpOverlapDispatcher {
        running: AtomicUsize,
        max_running: AtomicUsize,
    }

    impl NativeAgentToolDispatcher for McpOverlapDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let running = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_running.fetch_max(running, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(40));
            self.running.fetch_sub(1, Ordering::SeqCst);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let dispatcher = Arc::new(McpOverlapDispatcher {
        running: AtomicUsize::new(0),
        max_running: AtomicUsize::new(0),
    });
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::new(
            Arc::new(TwoMcpToolsThenFinalProvider {
                calls: Mutex::new(0),
            }),
            dispatcher.clone(),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-read-only-mcp-tools",
            "sessionId": "websocket:chat-read-only-mcp-tools",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run read-only mcp tools" }]
        }),
        json!({
            "tools": {
                "mcpServers": {
                    "docs": {
                        "enabledTools": ["lookup", "search"],
                        "fixtureTools": {
                            "lookup": {
                                "content": "lookup",
                                "annotations": { "readOnlyHint": true }
                            },
                            "search": {
                                "content": "search",
                                "annotations": { "readOnlyHint": true }
                            }
                        }
                    }
                }
            }
        }),
    )
    .expect("read-only MCP tool run should complete");
    let mcp_start_modes = result["events"]
        .as_array()
        .expect("events should be returned")
        .iter()
        .filter(|event| {
            event["eventName"] == "agent.tool.start"
                && event["payload"]["toolName"] == "mcp.call_tool"
                && event["payload"]["status"] == "queued"
        })
        .map(|event| event["payload"]["parallelMode"].clone())
        .collect::<Vec<_>>();

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(dispatcher.max_running.load(Ordering::SeqCst), 2);
    assert_eq!(mcp_start_modes, vec![json!("read"), json!("read")]);
}

#[test]
fn shell_read_only_allowlist_uses_read_lock_only_when_explicitly_enabled() {
    struct TwoShellReadsThenFinalProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for TwoShellReadsThenFinalProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self.calls.lock().expect("provider calls lock");
            *calls += 1;
            if *calls == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![
                        NativeAgentToolCall {
                            id: "call-shell-status".to_string(),
                            name: "shell.execute".to_string(),
                            arguments_json: "{\"command\":\"git status\"}".to_string(),
                            result: json!({ "content": "status" }),
                        },
                        NativeAgentToolCall {
                            id: "call-shell-diff".to_string(),
                            name: "shell.execute".to_string(),
                            arguments_json: "{\"command\":\"git diff\"}".to_string(),
                            result: json!({ "content": "diff" }),
                        },
                    ],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "shell reads complete".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    struct ShellOverlapDispatcher {
        running: AtomicUsize,
        max_running: AtomicUsize,
    }

    impl NativeAgentToolDispatcher for ShellOverlapDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let running = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_running.fetch_max(running, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(40));
            self.running.fetch_sub(1, Ordering::SeqCst);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let dispatcher = Arc::new(ShellOverlapDispatcher {
        running: AtomicUsize::new(0),
        max_running: AtomicUsize::new(0),
    });
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::new(
            Arc::new(TwoShellReadsThenFinalProvider {
                calls: Mutex::new(0),
            }),
            dispatcher.clone(),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-shell-read-allowlist",
            "sessionId": "websocket:chat-shell-read-allowlist",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run read-only shell tools" }]
        }),
        json!({
            "nativeAgent": {
                "shellParallelPolicy": "readOnlyCommandAllowlist"
            }
        }),
    )
    .expect("read-only shell allowlist run should complete");
    let shell_start_modes = result["events"]
        .as_array()
        .expect("events should be returned")
        .iter()
        .filter(|event| {
            event["eventName"] == "agent.tool.start"
                && event["payload"]["toolName"] == "shell.execute"
                && event["payload"]["status"] == "queued"
        })
        .map(|event| event["payload"]["parallelMode"].clone())
        .collect::<Vec<_>>();

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(dispatcher.max_running.load(Ordering::SeqCst), 2);
    assert_eq!(shell_start_modes, vec![json!("read"), json!("read")]);
}

#[test]
fn parallel_tool_failures_have_single_terminal_error_and_debug_late_failures() {
    struct TwoFailingToolsProvider;

    impl NativeAgentProvider for TwoFailingToolsProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![
                    NativeAgentToolCall {
                        id: "call-first-fails".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"first.md\"}".to_string(),
                        result: json!({ "content": "unused first" }),
                    },
                    NativeAgentToolCall {
                        id: "call-second-fails".to_string(),
                        name: "memory.search".to_string(),
                        arguments_json: "{\"query\":\"second\"}".to_string(),
                        result: json!({ "content": "unused second" }),
                    },
                ],
            })
        }
    }

    struct FailingParallelDispatcher;

    impl NativeAgentToolDispatcher for FailingParallelDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            if tool_call.id == "call-first-fails" {
                thread::sleep(Duration::from_millis(20));
            }
            Err(format!("{} failed", tool_call.id))
        }
    }

    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            Arc::new(TwoFailingToolsProvider),
            Arc::new(FailingParallelDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-two-parallel-failures",
            "sessionId": "websocket:chat-two-parallel-failures",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run failing parallel tools" }]
        }),
    )
    .expect("parallel tool failures should return structured failure");
    let events = result["events"]
        .as_array()
        .expect("events should be returned");
    let terminal_errors = events
        .iter()
        .filter(|event| event["eventName"] == "agent.error")
        .collect::<Vec<_>>();
    let debug_events = events
        .iter()
        .filter(|event| event["eventName"] == "agent.tool.debug")
        .collect::<Vec<_>>();

    assert_eq!(result["stopReason"], "tool_error");
    assert_eq!(terminal_errors.len(), 1);
    assert_eq!(
        terminal_errors[0]["payload"]["toolCallId"],
        "call-second-fails"
    );
    assert_eq!(debug_events.len(), 1);
    assert_eq!(
        debug_events[0]["payload"]["ignoredReason"],
        "terminal_outcome_already_claimed"
    );
    assert_eq!(debug_events[0]["payload"]["terminalOutcome"], "failed");
    assert_eq!(debug_events[0]["payload"]["toolCallId"], "call-first-fails");
    assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 0);
}

#[test]
fn mixed_parallel_and_non_parallel_tool_batch_uses_read_write_lock_scheduling() {
    struct MixedToolsThenFinalProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for MixedToolsThenFinalProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let call_count = {
                let mut seen_messages = self
                    .seen_messages
                    .lock()
                    .expect("seen messages lock should not be poisoned");
                seen_messages.push(context.messages.clone());
                seen_messages.len()
            };
            if call_count == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![
                        NativeAgentToolCall {
                            id: "call-read-one".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: "{\"path\":\"README.md\"}".to_string(),
                            result: json!({ "content": "README" }),
                        },
                        NativeAgentToolCall {
                            id: "call-read-two".to_string(),
                            name: "memory.search".to_string(),
                            arguments_json: "{\"query\":\"README\"}".to_string(),
                            result: json!({ "content": "memory" }),
                        },
                        NativeAgentToolCall {
                            id: "call-write-exclusive".to_string(),
                            name: "shell.execute".to_string(),
                            arguments_json: "{\"command\":\"echo hi\"}".to_string(),
                            result: json!({ "content": "hi" }),
                        },
                        NativeAgentToolCall {
                            id: "call-read-three".to_string(),
                            name: "knowledge.query".to_string(),
                            arguments_json: "{\"query\":\"README\"}".to_string(),
                            result: json!({ "content": "knowledge" }),
                        },
                    ],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "mixed tools complete".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    struct ReadWriteLockRecordingDispatcher {
        active_reads: AtomicUsize,
        active_writes: AtomicUsize,
        max_active_reads: AtomicUsize,
        write_overlaps: AtomicUsize,
    }

    impl NativeAgentToolDispatcher for ReadWriteLockRecordingDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let is_write = tool_call.name == "shell.execute";
            if is_write {
                if self.active_reads.load(Ordering::SeqCst) > 0 {
                    self.write_overlaps.fetch_add(1, Ordering::SeqCst);
                }
                let writes = self.active_writes.fetch_add(1, Ordering::SeqCst) + 1;
                if writes > 1 {
                    self.write_overlaps.fetch_add(1, Ordering::SeqCst);
                }
                thread::sleep(Duration::from_millis(60));
                self.active_writes.fetch_sub(1, Ordering::SeqCst);
            } else {
                if self.active_writes.load(Ordering::SeqCst) > 0 {
                    self.write_overlaps.fetch_add(1, Ordering::SeqCst);
                }
                let reads = self.active_reads.fetch_add(1, Ordering::SeqCst) + 1;
                self.max_active_reads.fetch_max(reads, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(60));
                self.active_reads.fetch_sub(1, Ordering::SeqCst);
            }
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    #[derive(Default)]
    struct RecordingCheckpointStore {
        inner: InMemoryNativeAgentCheckpointStore,
        saved: Mutex<Vec<Value>>,
    }

    impl NativeAgentCheckpointStore for RecordingCheckpointStore {
        fn save(&self, session_id: &str, checkpoint: Value) {
            self.saved
                .lock()
                .expect("saved checkpoints lock should not be poisoned")
                .push(checkpoint.clone());
            self.inner.save(session_id, checkpoint);
        }

        fn save_for_run(&self, session_id: &str, run_id: &str, checkpoint: Value) {
            self.saved
                .lock()
                .expect("saved checkpoints lock should not be poisoned")
                .push(checkpoint.clone());
            self.inner.save_for_run(session_id, run_id, checkpoint);
        }

        fn restore(&self, session_id: &str) -> Option<Value> {
            self.inner.restore(session_id)
        }

        fn restore_for_run(&self, session_id: &str, run_id: &str) -> Option<Value> {
            self.inner.restore_for_run(session_id, run_id)
        }

        fn clear(&self, session_id: &str) {
            self.inner.clear(session_id);
        }

        fn clear_for_run(&self, session_id: &str, run_id: &str) {
            self.inner.clear_for_run(session_id, run_id);
        }
    }

    let provider = Arc::new(MixedToolsThenFinalProvider {
        seen_messages: Mutex::new(Vec::new()),
    });
    let dispatcher = Arc::new(ReadWriteLockRecordingDispatcher {
        active_reads: AtomicUsize::new(0),
        active_writes: AtomicUsize::new(0),
        max_active_reads: AtomicUsize::new(0),
        write_overlaps: AtomicUsize::new(0),
    });
    let checkpoints = Arc::new(RecordingCheckpointStore::default());
    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            provider.clone(),
            dispatcher.clone(),
            checkpoints.clone(),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-mixed-tool-batch",
            "sessionId": "websocket:chat-mixed-tool-batch",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run mixed tools" }]
        }),
    )
    .expect("mixed tool run should complete");
    let seen_messages = provider
        .seen_messages
        .lock()
        .expect("seen messages lock should not be poisoned");
    let second_request_messages = &seen_messages[1];
    let tool_messages = second_request_messages
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect::<Vec<_>>();
    let tool_start_statuses = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .filter(|event| event["eventName"] == "agent.tool.start")
        .map(|event| {
            (
                event["payload"]["toolCallId"].as_str().unwrap_or_default(),
                event["payload"]["status"].as_str().unwrap_or_default(),
                event["payload"]["parallelMode"]
                    .as_str()
                    .unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>();
    let saved_checkpoints = checkpoints
        .saved
        .lock()
        .expect("saved checkpoints lock should not be poisoned")
        .clone();

    assert_eq!(result["stopReason"], "final_response");
    assert!(
        dispatcher.max_active_reads.load(Ordering::SeqCst) >= 2,
        "read guards should allow parallel-safe tools to overlap inside a mixed batch"
    );
    assert_eq!(
        dispatcher.write_overlaps.load(Ordering::SeqCst),
        0,
        "write-locked tools must not overlap reads or other writes"
    );
    assert_eq!(
        result["toolsUsed"],
        json!([
            "workspace.read_file",
            "memory.search",
            "shell.execute",
            "knowledge.query"
        ])
    );
    assert_eq!(
        tool_start_statuses
            .iter()
            .filter(|(_, status, _)| *status == "queued")
            .count(),
        4
    );
    assert!(tool_start_statuses.contains(&("call-read-one", "queued", "read")));
    assert!(tool_start_statuses.contains(&("call-write-exclusive", "queued", "write")));
    assert!(tool_start_statuses.contains(&("call-write-exclusive", "running", "write")));
    assert_eq!(tool_messages.len(), 4);
    assert_eq!(tool_messages[0]["tool_call_id"], "call-read-one");
    assert_eq!(tool_messages[1]["tool_call_id"], "call-read-two");
    assert_eq!(tool_messages[2]["tool_call_id"], "call-write-exclusive");
    assert_eq!(tool_messages[3]["tool_call_id"], "call-read-three");
    assert!(saved_checkpoints.iter().any(|checkpoint| {
        checkpoint["pendingToolCalls"]
            .as_array()
            .is_some_and(|pending| {
                pending.len() == 4
                    && pending.iter().all(|entry| entry["status"] == "queued")
                    && pending.iter().any(|entry| {
                        entry["toolCallId"] == "call-write-exclusive"
                            && entry["parallelMode"] == "write"
                    })
            })
    }));
    assert!(saved_checkpoints.iter().any(|checkpoint| {
        checkpoint["pendingToolCalls"]
            .as_array()
            .is_some_and(|pending| {
                pending.iter().any(|entry| {
                    entry["toolCallId"] == "call-write-exclusive"
                        && entry["status"] == "running"
                        && entry["parallelMode"] == "write"
                })
            })
    }));
}

#[test]
fn cancellation_before_queued_write_lock_dispatch_skips_waiting_tool() {
    struct ReadThenWriteProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for ReadThenWriteProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self.calls.lock().expect("provider calls lock");
            *calls += 1;
            if *calls == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![
                        NativeAgentToolCall {
                            id: "call-read-cancels".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: "{\"path\":\"README.md\"}".to_string(),
                            result: json!({ "content": "README" }),
                        },
                        NativeAgentToolCall {
                            id: "call-write-waits".to_string(),
                            name: "shell.execute".to_string(),
                            arguments_json: "{\"command\":\"echo should-not-run\"}".to_string(),
                            result: json!({ "content": "should not run" }),
                        },
                    ],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "unreachable after cancellation".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    struct CancellingReadDispatcher {
        cancellations: Arc<InMemoryNativeAgentCancellation>,
        write_dispatches: AtomicUsize,
    }

    impl NativeAgentToolDispatcher for CancellingReadDispatcher {
        fn dispatch(
            &self,
            context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            if tool_call.name == "workspace.read_file" {
                self.cancellations.cancel(&context.run_id);
                thread::sleep(Duration::from_millis(80));
                return Ok(NativeAgentToolResult::generic_success(
                    tool_call,
                    tool_call.result.clone(),
                ));
            }
            self.write_dispatches.fetch_add(1, Ordering::SeqCst);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
    let dispatcher = Arc::new(CancellingReadDispatcher {
        cancellations: cancellations.clone(),
        write_dispatches: AtomicUsize::new(0),
    });
    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            Arc::new(ReadThenWriteProvider {
                calls: Mutex::new(0),
            }),
            dispatcher.clone(),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            cancellations,
        ),
        json!({
            "runtime": "rust",
            "runId": "run-cancel-queued-write",
            "sessionId": "websocket:chat-cancel-queued-write",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read then cancel write" }]
        }),
    )
    .expect("queued write cancellation should return a structured result");

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(dispatcher.write_dispatches.load(Ordering::SeqCst), 0);
    assert_eq!(
        event_names(&result)
            .into_iter()
            .filter(|event_name| *event_name == "agent.cancelled")
            .count(),
        1
    );
    assert_eq!(result["finalContent"], "");
}

#[test]
fn terminal_failure_before_queued_write_dispatch_skips_waiting_tool() {
    struct FailingWriteThenWriteProvider;

    impl NativeAgentProvider for FailingWriteThenWriteProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![
                    NativeAgentToolCall {
                        id: "call-first-write-fails".to_string(),
                        name: "shell.execute".to_string(),
                        arguments_json: "{\"command\":\"false\"}".to_string(),
                        result: json!({ "content": "unused first" }),
                    },
                    NativeAgentToolCall {
                        id: "call-second-write-waits".to_string(),
                        name: "shell.execute".to_string(),
                        arguments_json: "{\"command\":\"touch should-not-run\"}".to_string(),
                        result: json!({ "content": "unused second" }),
                    },
                ],
            })
        }
    }

    struct FailingWriteDispatcher {
        second_write_dispatches: AtomicUsize,
    }

    impl NativeAgentToolDispatcher for FailingWriteDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            if tool_call.id == "call-first-write-fails" {
                return Err("first write failed".to_string());
            }
            self.second_write_dispatches.fetch_add(1, Ordering::SeqCst);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let dispatcher = Arc::new(FailingWriteDispatcher {
        second_write_dispatches: AtomicUsize::new(0),
    });
    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            Arc::new(FailingWriteThenWriteProvider),
            dispatcher.clone(),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-failed-queued-write",
            "sessionId": "websocket:chat-failed-queued-write",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "fail then skip write" }]
        }),
    )
    .expect("queued write failure should return a structured result");

    let events = result["events"]
        .as_array()
        .expect("events should be returned");
    assert_eq!(result["stopReason"], "tool_error");
    assert_eq!(dispatcher.second_write_dispatches.load(Ordering::SeqCst), 0);
    assert!(!events.iter().any(|event| {
        event["eventName"] == "agent.tool.start"
            && event["payload"]["toolCallId"] == "call-second-write-waits"
            && event["payload"]["status"] == "running"
    }));
    assert!(events.iter().any(|event| {
        event["eventName"] == "agent.tool.debug"
            && event["payload"]["toolCallId"] == "call-second-write-waits"
            && event["payload"]["ignoredReason"] == "dispatch_skipped_after_terminal"
            && event["payload"]["terminalOutcome"] == "failed"
    }));
}

#[test]
fn cancellation_during_non_cleanup_parallel_tool_returns_without_waiting_for_late_result() {
    struct SlowReadProvider;

    impl NativeAgentProvider for SlowReadProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![
                    NativeAgentToolCall {
                        id: "call-slow-read-one".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "late read one" }),
                    },
                    NativeAgentToolCall {
                        id: "call-slow-read-two".to_string(),
                        name: "memory.search".to_string(),
                        arguments_json: "{\"query\":\"README\"}".to_string(),
                        result: json!({ "content": "late read two" }),
                    },
                ],
            })
        }
    }

    struct SlowCancellingReadDispatcher {
        cancellations: Arc<InMemoryNativeAgentCancellation>,
        cancelled_tx: std::sync::mpsc::Sender<()>,
        release_rx: Arc<Mutex<std::sync::mpsc::Receiver<()>>>,
    }

    impl NativeAgentToolDispatcher for SlowCancellingReadDispatcher {
        fn dispatch(
            &self,
            context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            self.cancellations.cancel(&context.run_id);
            let _ = self.cancelled_tx.send(());
            let _ = self
                .release_rx
                .lock()
                .expect("release receiver lock should not be poisoned")
                .recv_timeout(Duration::from_secs(30));
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
    let (cancelled_tx, cancelled_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let trace_sink = Arc::new(RecordingTraceSink::default());
    let trace_events = trace_sink.events.clone();
    let cancellation_probe = cancellations.clone();
    thread::spawn(move || {
        let result = run_native_agent_turn_with_services(
            &NativeAgentRuntimeServices::new(
                Arc::new(SlowReadProvider),
                Arc::new(SlowCancellingReadDispatcher {
                    cancellations: cancellations.clone(),
                    cancelled_tx,
                    release_rx,
                }),
                Arc::new(InMemoryNativeAgentCheckpointStore::default()),
                cancellations,
            )
            .with_trace_sink(trace_sink),
            json!({
                "runtime": "rust",
                "runId": "run-cancel-slow-read",
                "sessionId": "websocket:chat-cancel-slow-read",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "cancel slow read" }]
            }),
        );
        let _ = result_tx.send(result);
    });

    cancelled_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("slow read dispatcher should trigger cancellation");
    assert!(
        cancellation_probe.is_cancelled("run-cancel-slow-read"),
        "dispatcher cancellation signal must update the runtime cancellation store"
    );
    let result = match result_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result) => result.expect("slow read cancellation should return a structured result"),
        Err(error) => {
            let _ = release_tx.send(());
            let _ = release_tx.send(());
            let result_after_release = result_rx
                .recv_timeout(Duration::from_secs(5))
                .map(|result| result.map(|value| value["stopReason"].clone()));
            let tool_events = trace_events
                .lock()
                .expect("trace event lock should not be poisoned")
                .iter()
                .filter(|event| {
                    event.event_name == "agent.tool.start" || event.event_name == "agent.cancelled"
                })
                .map(|event| {
                    serde_json::json!({
                        "event": event.event_name,
                        "payload": event.payload,
                    })
                })
                .collect::<Vec<_>>();
            panic!(
                "non-cleanup read tool cancellation should not wait for late result: {error}; result_after_release={result_after_release:?}; tool_events={tool_events:?}"
            );
        }
    };
    let _ = release_tx.send(());
    let _ = release_tx.send(());

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 0);
}

#[test]
fn provider_error_after_tool_result_preserves_accumulated_tool_state() {
    struct ToolThenErrorProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for ToolThenErrorProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self.calls.lock().expect("provider calls lock");
            *calls += 1;
            if *calls == 1 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-before-provider-error".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "README before provider error" }),
                    }],
                });
            }

            Err("provider failed after tool result".to_string())
        }
    }

    let services = NativeAgentRuntimeServices::new(
        Arc::new(ToolThenErrorProvider {
            calls: Mutex::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-provider-error-after-tool",
            "sessionId": "websocket:chat-provider-error-after-tool",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "read then fail" }]
        }),
    )
    .expect("provider error should return a structured result");

    assert_eq!(result["stopReason"], "provider_error");
    assert_eq!(result["toolsUsed"], json!(["workspace.read_file"]));
    assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "call-before-provider-error"
    );
    assert_eq!(
        event_names(&result),
        vec![
            "agent.tool_call.delta",
            "agent.tool.start",
            "agent.tool.result",
            "agent.usage",
            "agent.error"
        ]
    );
}

#[test]
fn emits_tool_result_envelope_with_legacy_content_projection() {
    let services = NativeAgentRuntimeServices::default();
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-tool-envelope",
            "sessionId": "websocket:chat-tool-envelope",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-envelope",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "README envelope body" }
                            }]
                        },
                        { "content": "envelope final" }
                    ]
                }
            }
        }),
    )
    .expect("fixture tool run should succeed");

    let tool_start = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.tool.start")
        .expect("tool start event should be emitted");
    let tool_result = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.tool.result")
        .expect("tool result event should be emitted");
    let start_payload = &tool_start["payload"];
    let payload = &tool_result["payload"];

    assert_eq!(start_payload["status"], "running");
    assert_eq!(start_payload["detailId"], "tool:call-envelope");
    assert_eq!(payload["content"], "README envelope body");
    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["resultStatus"], "ok");
    assert_eq!(payload["summary"], "README envelope body");
    assert_eq!(payload["detailId"], "tool:call-envelope");
    assert!(payload["timing"].get("durationMs").is_some());
    assert_eq!(payload["envelope"]["status"], "ok");
    assert_eq!(payload["envelope"]["summary"], "README envelope body");
    assert_eq!(payload["envelope"]["modelContent"], "README envelope body");
    assert_eq!(payload["envelope"]["ui"]["type"], "generic_result");
    assert_eq!(payload["envelope"]["ui"]["title"], "workspace.read_file");
    assert!(payload["envelope"]["references"]
        .as_array()
        .expect("references should be an array")
        .is_empty());
    assert_eq!(payload["envelope"]["metrics"]["modelChars"], 20);
    assert_eq!(payload["envelope"]["trace"]["toolCallId"], "call-envelope");
    assert_eq!(
        payload["envelope"]["trace"]["toolName"],
        "workspace.read_file"
    );
}

#[test]
fn subagent_tools_share_manager_state_without_copying_child_transcript_to_parent() {
    let services = NativeAgentRuntimeServices::default();
    let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-subagent-tools",
                "sessionId": "websocket:chat-subagent-tools",
                "maxIterations": 7,
                "messages": [{ "role": "user", "content": "delegate then close" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-spawn",
                                    "name": "subagent.spawn",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\",\"childRunId\":\"child-1\",\"traceRef\":\"trace-delegate-1\",\"name\":\"Goodall\",\"task\":\"Inspect a bounded topic\"}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-send",
                                    "name": "subagent.send_input",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\",\"content\":\"Please continue\"}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-query",
                                    "name": "subagent.query",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\"}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-wait",
                                    "name": "subagent.wait",
                                    "argumentsJson": "{\"subagentIds\":[\"delegate-1\"],\"timeoutMs\":1}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-cancel",
                                    "name": "subagent.cancel",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\"}"
                                }]
                            },
                            {
                                "content": "",
                                "toolCalls": [{
                                    "id": "call-close",
                                    "name": "subagent.close",
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\"}"
                                }]
                            },
                            { "content": "Subagent lifecycle handled." }
                        ]
                    }
                }
            }),
        )
        .expect("subagent tool run should succeed");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(
        result["toolsUsed"],
        json!([
            "subagent.spawn",
            "subagent.send_input",
            "subagent.query",
            "subagent.wait",
            "subagent.cancel",
            "subagent.close"
        ])
    );
    let completed = result["completedToolResults"]
        .as_array()
        .expect("completed tool results should be present");
    assert_eq!(completed.len(), 6);
    assert_eq!(completed[0]["envelope"]["raw"]["accepted"], true);
    assert_eq!(
        completed[1]["envelope"]["raw"]["delivery"],
        "live_delivered"
    );
    assert_eq!(
        completed[1]["envelope"]["raw"]["subagent"]["mailboxDepth"],
        1
    );
    assert_eq!(completed[2]["envelope"]["raw"]["found"], true);
    assert_eq!(completed[3]["envelope"]["raw"]["timedOut"], true);
    assert_eq!(
        completed[4]["envelope"]["raw"]["subagent"]["status"],
        "cancelled"
    );
    assert_eq!(
        completed[5]["envelope"]["raw"]["subagent"]["status"],
        "closed"
    );
    let event_names = event_names(&result);
    assert!(event_names.contains(&"agent.delegate.message_queued"));
    assert!(event_names.contains(&"agent.delegate.queried"));
    assert!(event_names.contains(&"agent.delegate.wait"));
    assert!(event_names.contains(&"agent.delegate.cancelled"));
    assert!(event_names.contains(&"agent.delegate.closed"));
    let link_event = result["events"]
        .as_array()
        .expect("events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.delegate.linked")
        .expect("subagent spawn should emit a parent-child link event");
    assert_eq!(link_event["payload"]["parentTurnId"], "run-subagent-tools");
    assert_eq!(link_event["payload"]["delegateId"], "delegate-1");
    assert_eq!(link_event["payload"]["subagentId"], "delegate-1");
    assert_eq!(link_event["payload"]["childRunId"], "child-1");
    assert_eq!(link_event["payload"]["traceRef"], "trace-delegate-1");
    assert_eq!(link_event["payload"]["sourceToolCallId"], "call-spawn");
    assert_eq!(
        result["messages"],
        json!([{ "role": "assistant", "content": "Subagent lifecycle handled." }])
    );
}

#[test]
fn private_user_subagent_input_is_not_added_to_main_model_context() {
    struct SpawnThenFinalProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for SpawnThenFinalProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let call_count = {
                let mut seen_messages = self
                    .seen_messages
                    .lock()
                    .expect("seen messages lock should not be poisoned");
                seen_messages.push(context.messages.clone());
                seen_messages.len()
            };
            if call_count == 1 {
                Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-private-spawn".to_string(),
                        name: "subagent.spawn".to_string(),
                        arguments_json:
                            "{\"subagentId\":\"private-child\",\"task\":\"Private work\"}"
                                .to_string(),
                        result: Value::Null,
                    }],
                })
            } else {
                Ok(NativeAgentProviderResponse {
                    final_content: "Main thread finished.".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                })
            }
        }
    }

    struct DirectUserInputAfterSpawnDispatcher {
        manager: SubagentThreadManager,
        fallback: SubagentNativeAgentToolDispatcher,
    }

    impl NativeAgentToolDispatcher for DirectUserInputAfterSpawnDispatcher {
        fn dispatch(
            &self,
            context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let result = self.fallback.dispatch(context, tool_call)?;
            if matches!(tool_call.name.as_str(), "subagent.spawn" | "spawn_agent") {
                self.manager.enqueue_input(SubagentSendInputParams {
                    session_key: context.session_id.clone(),
                    subagent_id: "private-child".to_string(),
                    content: "private child-only instruction".to_string(),
                    sender: SubagentInputSender::User,
                    turn_id: None,
                    child_run_id: None,
                    trace_ref: None,
                    created_at: None,
                    metadata: json!({ "source": "direct_user_subagent_chat" }),
                });
            }
            Ok(result)
        }
    }

    let provider = Arc::new(SpawnThenFinalProvider {
        seen_messages: Mutex::new(Vec::new()),
    });
    let manager = SubagentThreadManager::default();
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(DirectUserInputAfterSpawnDispatcher {
            manager: manager.clone(),
            fallback: SubagentNativeAgentToolDispatcher::new(manager.clone()),
        }),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-private-subagent-input",
            "sessionId": "websocket:chat-private-subagent-input",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "start private subagent" }]
        }),
    )
    .expect("subagent run should complete without leaking private child input");

    let seen_messages = provider
        .seen_messages
        .lock()
        .expect("seen messages lock should not be poisoned");
    let child = manager
        .query(SubagentTargetParams {
            session_key: "websocket:chat-private-subagent-input".to_string(),
            subagent_id: "private-child".to_string(),
        })
        .subagent
        .expect("private child subagent should exist");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(seen_messages.len(), 2);
    assert_eq!(child.mailbox_depth, 1);
    assert!(!seen_messages[1].iter().any(|message| {
        message
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|content| content.contains("private child-only instruction"))
    }));
}

#[test]
fn tool_result_projection_redacts_and_truncates_model_content() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "runId": "run-tool-budget",
            "sessionId": "websocket:chat-tool-budget",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read bounded result" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "maxToolResultChars": 12
                }
            },
            "providers": {
                "fixture": {
                    "api_key": "secret-token",
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-budget",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "secret-token ABCDEFGHIJKLMNOP" }
                            }]
                        },
                        { "content": "bounded final" }
                    ]
                }
            }
        }),
    )
    .expect("bounded tool result run should complete");
    let tool_result = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.tool.result")
        .expect("tool result event should be emitted");
    let content = tool_result["payload"]["content"]
        .as_str()
        .expect("legacy content should be text");

    assert!(!content.contains("secret-token"));
    assert!(content.chars().count() <= 12);
    assert_eq!(
        tool_result["payload"]["envelope"]["truncation"]["truncated"],
        true
    );
    assert_eq!(
        tool_result["payload"]["envelope"]["redactions"][0],
        "config_secret"
    );
    assert!(!tool_result["payload"]["envelope"]["modelContent"]
        .as_str()
        .unwrap()
        .contains("secret-token"));
    assert!(!tool_result["payload"]["envelope"]
        .to_string()
        .contains("secret-token"));
    assert_eq!(
        tool_result["payload"]["envelope"]["continuation"]["nextOffset"],
        12
    );
}

#[test]
fn dispatches_multiple_tool_calls_from_one_provider_response_in_order() {
    let services = NativeAgentRuntimeServices::default();
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-multiple-tools",
            "sessionId": "websocket:chat-multiple-tools",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "inspect workspace" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [
                                {
                                    "id": "call-read",
                                    "name": "workspace.read_file",
                                    "argumentsJson": "{\"path\":\"README.md\"}",
                                    "result": { "content": "README body" }
                                },
                                {
                                    "id": "call-list",
                                    "name": "workspace.list_files",
                                    "argumentsJson": "{\"path\":\"src\"}",
                                    "result": { "content": "src/main.ts" }
                                }
                            ]
                        },
                        { "content": "workspace inspected" }
                    ]
                }
            }
        }),
    )
    .expect("multiple tool run should succeed");

    let tool_results = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .filter(|event| event["eventName"] == "agent.tool.result")
        .collect::<Vec<_>>();

    assert_eq!(
        result["toolsUsed"],
        json!(["workspace.read_file", "workspace.list_files"])
    );
    assert_eq!(tool_results.len(), 2);
    assert_eq!(tool_results[0]["payload"]["toolCallId"], "call-read");
    assert_eq!(tool_results[1]["payload"]["toolCallId"], "call-list");
    assert_eq!(result["finalContent"], "workspace inspected");
}

#[test]
fn later_tool_error_preserves_earlier_completed_tool_result() {
    struct TwoToolProvider;

    impl NativeAgentProvider for TwoToolProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: "".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![
                    NativeAgentToolCall {
                        id: "call-first-ok".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "README" }),
                    },
                    NativeAgentToolCall {
                        id: "call-second-fails".to_string(),
                        name: "workspace.list_files".to_string(),
                        arguments_json: "{\"path\":\"missing\"}".to_string(),
                        result: json!({ "content": "unused" }),
                    },
                ],
            })
        }
    }

    struct FailingSecondToolDispatcher;

    impl NativeAgentToolDispatcher for FailingSecondToolDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            if tool_call.id == "call-second-fails" {
                return Err("missing path".to_string());
            }
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            Arc::new(TwoToolProvider),
            Arc::new(FailingSecondToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        ),
        json!({
            "runtime": "rust",
            "runId": "run-later-tool-error",
            "sessionId": "websocket:chat-later-tool-error",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run two tools" }]
        }),
    )
    .expect("later tool error should return structured failure");

    assert_eq!(result["stopReason"], "tool_error");
    assert_eq!(
        result["toolsUsed"],
        json!(["workspace.read_file", "workspace.list_files"])
    );
    assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "call-first-ok"
    );
    assert_eq!(
        result["events"].as_array().unwrap().last().unwrap()["eventName"],
        "agent.error"
    );
    assert_eq!(
        result["events"].as_array().unwrap().last().unwrap()["payload"]["toolCallId"],
        "call-second-fails"
    );
}

#[test]
fn rejects_unpermitted_native_tool_with_structured_error_result() {
    let services = NativeAgentRuntimeServices::default();
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-tool-denied",
            "sessionId": "websocket:chat-tool-denied",
            "messages": [{ "role": "user", "content": "run shell" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [{
                        "content": "should not finish",
                        "toolCalls": [{
                            "id": "call-denied",
                            "name": "shell.exec",
                            "argumentsJson": "{\"command\":\"rm -rf .\"}",
                            "result": { "content": "denied" }
                        }]
                    }]
                }
            }
        }),
    )
    .expect("tool denial should return a structured result");

    assert_eq!(result["stopReason"], "policy_denied");
    assert_eq!(result["toolsUsed"], json!([]));
    assert!(result["error"]
        .as_str()
        .expect("tool error should be a string")
        .contains("not permitted"));
    assert_eq!(
        event_names(&result),
        vec!["agent.tool_call.delta", "agent.error"]
    );
    assert_eq!(result["events"][1]["payload"]["toolName"], "shell.exec");
}

#[test]
fn reports_provider_and_iteration_errors_as_frontend_events() {
    let provider_error = run_native_agent_turn(json!({
        "runtime": "rust",
        "runId": "run-error",
        "sessionId": "websocket:chat-1",
        "messages": [{ "role": "user", "content": "hello" }],
        "config": {
            "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
            "providers": { "openai": { "api_key": "" } }
        }
    }))
    .expect("provider error should return compatibility result");
    let iteration_error = run_native_agent_turn(json!({
        "runtime": "rust",
        "runId": "run-iteration",
        "sessionId": "websocket:chat-1",
        "maxIterations": 0
    }))
    .expect("iteration error should return compatibility result");

    assert_eq!(provider_error["stopReason"], "provider_error");
    assert_eq!(provider_error["events"][0]["eventName"], "agent.error");
    assert_eq!(iteration_error["stopReason"], "max_iterations");
    assert_eq!(iteration_error["events"][0]["eventName"], "agent.error");
}

#[test]
fn stops_with_max_iterations_after_bounded_tool_iterations() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "runId": "run-max-iterations",
            "sessionId": "websocket:chat-max-iterations",
            "maxIterations": 1,
            "messages": [{ "role": "user", "content": "read forever" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-read",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "README body" }
                            }]
                        },
                        { "content": "unreachable final" }
                    ]
                }
            }
        }),
    )
    .expect("max iteration run should return a structured result");

    assert_eq!(result["stopReason"], "max_iterations");
    assert_eq!(result["finalContent"], "");
    assert_eq!(result["toolsUsed"], json!(["workspace.read_file"]));
    assert_eq!(
        result["events"].as_array().unwrap().last().unwrap()["eventName"],
        "agent.error"
    );
    assert_eq!(
        result["events"].as_array().unwrap().last().unwrap()["payload"]["stopReason"],
        "max_iterations"
    );
}

#[test]
fn denied_tool_stops_with_policy_denied_without_tool_dispatch() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "runId": "run-policy-denied",
            "sessionId": "websocket:chat-policy-denied",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run shell" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [{
                        "content": "",
                        "toolCalls": [{
                            "id": "call-denied",
                            "name": "shell.exec",
                            "argumentsJson": "{\"command\":\"rm -rf .\"}",
                            "result": { "content": "must not execute" }
                        }]
                    }]
                }
            }
        }),
    )
    .expect("policy denial should return a structured result");

    assert_eq!(result["stopReason"], "policy_denied");
    assert_eq!(result["toolsUsed"], json!([]));
    assert_eq!(
        event_names(&result),
        vec!["agent.tool_call.delta", "agent.error"]
    );
    assert_eq!(result["events"][1]["payload"]["toolName"], "shell.exec");
}

#[test]
fn cancellation_before_tool_dispatch_stops_without_dispatching_tool() {
    struct CancellingProvider {
        cancellations: Arc<InMemoryNativeAgentCancellation>,
    }

    impl NativeAgentProvider for CancellingProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.cancellations.cancel(&context.run_id);
            Ok(NativeAgentProviderResponse {
                final_content: "needs cancelled tool".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![NativeAgentToolCall {
                    id: "call-cancel-before-tool".to_string(),
                    name: "workspace.read_file".to_string(),
                    arguments_json: "{\"path\":\"README.md\"}".to_string(),
                    result: json!({ "content": "must not run" }),
                }],
            })
        }
    }

    struct PanickingToolDispatcher;

    impl NativeAgentToolDispatcher for PanickingToolDispatcher {
        fn dispatch(
            &self,
            _context: &NativeAgentRunContext,
            _tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            panic!("tool dispatch should be skipped after cancellation");
        }
    }

    let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
    let services = NativeAgentRuntimeServices::new(
        Arc::new(CancellingProvider {
            cancellations: cancellations.clone(),
        }),
        Arc::new(PanickingToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        cancellations,
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancel-before-tool",
            "sessionId": "websocket:chat-cancel-before-tool",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read then cancel" }]
        }),
    )
    .expect("cancelled run should return a structured result");

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(result["toolsUsed"], json!([]));
    assert!(result["completedToolResults"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        event_names(&result),
        vec!["agent.tool_call.delta", "agent.cancelled"]
    );
    let cancelled_event = result["events"]
        .as_array()
        .expect("events should be an array")
        .last()
        .expect("cancelled event should be present");
    assert_eq!(cancelled_event["eventName"], "agent.cancelled");
    assert_eq!(
        cancelled_event["payload"]["runId"],
        "run-cancel-before-tool"
    );
    assert_eq!(
        cancelled_event["payload"]["sessionId"],
        "websocket:chat-cancel-before-tool"
    );
    assert_eq!(cancelled_event["payload"]["iteration"], 0);
    assert_eq!(cancelled_event["payload"]["cancelled"], true);
    assert_eq!(cancelled_event["payload"]["stopReason"], "cancelled");
    assert_eq!(cancelled_event["payload"]["error"], "cancelled");
    assert!(result["runtimeEvents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "cancelled"
                && event["payload"]["triggerEventName"] == "agent.cancelled"
        }));
    assert_eq!(result["checkpoint"]["phase"], "cancelled");
    assert_eq!(result["checkpoint"]["iteration"], 0);
}

#[test]
fn cancellation_context_is_available_to_provider_and_tool_dispatch() {
    struct ContextAwareProvider {
        saw_context: Arc<Mutex<bool>>,
    }

    impl NativeAgentProvider for ContextAwareProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            *self
                .saw_context
                .lock()
                .expect("provider observation lock should not be poisoned") = context
                .cancellation
                .as_ref()
                .is_some_and(|cancellation| !cancellation.is_cancelled());
            Ok(NativeAgentProviderResponse {
                final_content: "dispatch cancellable tool".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![NativeAgentToolCall {
                    id: "call-cancellable-tool".to_string(),
                    name: "workspace.read_file".to_string(),
                    arguments_json: "{\"path\":\"README.md\"}".to_string(),
                    result: json!({ "content": "unused" }),
                }],
            })
        }
    }

    struct ContextAwareToolDispatcher {
        cancellations: Arc<InMemoryNativeAgentCancellation>,
        saw_cancelled_context: Arc<Mutex<bool>>,
    }

    impl NativeAgentToolDispatcher for ContextAwareToolDispatcher {
        fn dispatch(
            &self,
            context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            self.cancellations.cancel(&context.run_id);
            *self
                .saw_cancelled_context
                .lock()
                .expect("tool observation lock should not be poisoned") = context
                .cancellation
                .as_ref()
                .is_some_and(NativeAgentCancellationContext::is_cancelled);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                json!({ "content": "cancelled after dispatch" }),
            ))
        }
    }

    let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
    let provider_saw_context = Arc::new(Mutex::new(false));
    let tool_saw_cancelled_context = Arc::new(Mutex::new(false));
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ContextAwareProvider {
            saw_context: provider_saw_context.clone(),
        }),
        Arc::new(ContextAwareToolDispatcher {
            cancellations: cancellations.clone(),
            saw_cancelled_context: tool_saw_cancelled_context.clone(),
        }),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        cancellations,
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancellation-context",
            "sessionId": "websocket:chat-cancellation-context",
            "messages": [{ "role": "user", "content": "use cancellable tool" }]
        }),
    )
    .expect("cancellation context run should return a structured result");

    assert_eq!(result["stopReason"], "cancelled");
    assert!(*provider_saw_context
        .lock()
        .expect("provider observation lock should not be poisoned"));
    assert!(*tool_saw_cancelled_context
        .lock()
        .expect("tool observation lock should not be poisoned"));
}

#[test]
fn cancellation_after_tool_result_preserves_completed_tool_state() {
    struct SingleToolProvider {
        calls: Mutex<u32>,
    }

    impl NativeAgentProvider for SingleToolProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self
                .calls
                .lock()
                .expect("provider calls lock should not be poisoned");
            *calls += 1;
            assert_eq!(
                *calls, 1,
                "provider should not be called after cancellation"
            );
            Ok(NativeAgentProviderResponse {
                final_content: "needs one tool".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![NativeAgentToolCall {
                    id: "call-cancel-after-result".to_string(),
                    name: "workspace.read_file".to_string(),
                    arguments_json: "{\"path\":\"README.md\"}".to_string(),
                    result: json!({ "content": "README" }),
                }],
            })
        }
    }

    struct CancellingToolDispatcher {
        cancellations: Arc<InMemoryNativeAgentCancellation>,
    }

    impl NativeAgentToolDispatcher for CancellingToolDispatcher {
        fn dispatch(
            &self,
            context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            self.cancellations.cancel(&context.run_id);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
    let provider = Arc::new(SingleToolProvider {
        calls: Mutex::new(0),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(CancellingToolDispatcher {
            cancellations: cancellations.clone(),
        }),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        cancellations,
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancel-after-result",
            "sessionId": "websocket:chat-cancel-after-result",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read then cancel" }]
        }),
    )
    .expect("cancelled run should preserve completed tool result state");

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(
        *provider
            .calls
            .lock()
            .expect("provider calls lock should not be poisoned"),
        1
    );
    assert_eq!(result["toolsUsed"], json!(["workspace.read_file"]));
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "call-cancel-after-result"
    );
    assert_eq!(
        event_names(&result),
        vec![
            "agent.tool_call.delta",
            "agent.tool.start",
            "agent.tool.result",
            "agent.cancelled"
        ]
    );
    assert_eq!(
        result["events"]
            .as_array()
            .expect("events should be an array")
            .last()
            .expect("cancelled event should be present")["eventName"],
        "agent.cancelled"
    );
    assert_eq!(result["checkpoint"]["phase"], "cancelled");
    assert_eq!(
        result["checkpoint"]["completedToolResults"][0]["toolCallId"],
        "call-cancel-after-result"
    );
}

#[test]
fn cancellation_during_approval_wait_reaches_cancelled_without_resume() {
    let services = NativeAgentRuntimeServices::default();
    run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancel-approval-wait",
            "sessionId": "websocket:chat-cancel-approval-wait",
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-cancel",
                    "toolName": "workspace.write_file"
                }
            }
        }),
    )
    .expect("approval wait checkpoint should be created");

    services.cancel("run-cancel-approval-wait");
    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancel-approval-wait",
            "sessionId": "websocket:chat-cancel-approval-wait",
            "metadata": {
                "agentContinuation": {
                    "kind": "approval",
                    "approvalId": "approval-cancel",
                    "decision": "approved",
                    "scope": "once"
                }
            }
        }),
    )
    .expect("cancelled approval wait should return cancellation result");

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(result["checkpoint"]["phase"], "cancelled");
    assert_eq!(event_names(&result), vec!["agent.cancelled"]);
}

#[test]
fn cancellation_during_subagent_wait_prevents_followup_model_call() {
    struct SpawnWaitProvider {
        calls: Mutex<u32>,
    }

    impl NativeAgentProvider for SpawnWaitProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let mut calls = self
                .calls
                .lock()
                .expect("provider calls lock should not be poisoned");
            *calls += 1;
            match *calls {
                1 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-cancel-wait-spawn".to_string(),
                        name: "subagent.spawn".to_string(),
                        arguments_json:
                            "{\"subagentId\":\"wait-child\",\"task\":\"Wait boundary\"}".to_string(),
                        result: Value::Null,
                    }],
                }),
                2 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-cancel-wait".to_string(),
                        name: "subagent.wait".to_string(),
                        arguments_json: "{\"subagentIds\":[\"wait-child\"],\"timeoutMs\":1}"
                            .to_string(),
                        result: Value::Null,
                    }],
                }),
                _ => panic!("provider should not be called after subagent wait cancellation"),
            }
        }
    }

    struct CancellingSubagentWaitDispatcher {
        cancellations: Arc<InMemoryNativeAgentCancellation>,
        fallback: SubagentNativeAgentToolDispatcher,
    }

    impl NativeAgentToolDispatcher for CancellingSubagentWaitDispatcher {
        fn dispatch(
            &self,
            context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let result = self.fallback.dispatch(context, tool_call)?;
            if matches!(tool_call.name.as_str(), "subagent.wait" | "wait_agent") {
                self.cancellations.cancel(&context.run_id);
            }
            Ok(result)
        }
    }

    let manager = SubagentThreadManager::default();
    let cancellations = Arc::new(InMemoryNativeAgentCancellation::default());
    let provider = Arc::new(SpawnWaitProvider {
        calls: Mutex::new(0),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(CancellingSubagentWaitDispatcher {
            cancellations: cancellations.clone(),
            fallback: SubagentNativeAgentToolDispatcher::new(manager),
        }),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        cancellations,
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancel-subagent-wait",
            "sessionId": "websocket:chat-cancel-subagent-wait",
            "maxIterations": 4,
            "messages": [{ "role": "user", "content": "spawn then wait" }]
        }),
    )
    .expect("subagent wait cancellation should return cancellation result");

    let event_names = event_names(&result);
    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(
        *provider
            .calls
            .lock()
            .expect("provider calls lock should not be poisoned"),
        2
    );
    assert!(event_names.contains(&"agent.delegate.wait"));
    let runtime_events = result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present");
    let awaiting_subagent_index = runtime_events
        .iter()
        .position(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "awaiting_subagent"
                && event["payload"]["triggerEventName"] == "agent.delegate.wait"
        })
        .expect("awaiting subagent phase should be emitted");
    let delegate_wait_index = runtime_events
        .iter()
        .position(|event| event["eventName"] == "agent.delegate.wait")
        .expect("delegate wait event should be emitted");
    assert!(awaiting_subagent_index < delegate_wait_index);
    assert_eq!(event_names.last(), Some(&"agent.cancelled"));
    assert_eq!(result["checkpoint"]["phase"], "cancelled");
}

#[test]
fn stores_active_turn_tool_wait_and_cancellation_checkpoints() {
    struct CheckpointAwareProvider {
        checkpoints: Arc<InMemoryNativeAgentCheckpointStore>,
        calls: Mutex<u32>,
    }

    impl NativeAgentProvider for CheckpointAwareProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let checkpoint = self
                .checkpoints
                .restore(&context.session_id)
                .expect("active turn checkpoint should be present during provider call");
            assert_eq!(checkpoint["phase"], "calling_model");
            let mut calls = self
                .calls
                .lock()
                .expect("provider call lock should not be poisoned");
            *calls += 1;
            if *calls == 1 {
                Ok(NativeAgentProviderResponse {
                    final_content: "needs tool".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-checkpoint".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "README" }),
                    }],
                })
            } else {
                Ok(NativeAgentProviderResponse {
                    final_content: "checkpoint-aware final".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                })
            }
        }
    }

    struct CheckpointAwareToolDispatcher {
        checkpoints: Arc<InMemoryNativeAgentCheckpointStore>,
    }

    impl NativeAgentToolDispatcher for CheckpointAwareToolDispatcher {
        fn dispatch(
            &self,
            context: &NativeAgentRunContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let checkpoint = self
                .checkpoints
                .restore(&context.session_id)
                .expect("tool wait checkpoint should be present during tool dispatch");
            assert_eq!(checkpoint["phase"], "tool_running");
            assert_eq!(checkpoint["schemaVersion"], 1);
            assert_eq!(checkpoint["runtime"], "rust");
            assert_eq!(checkpoint["runId"], context.run_id);
            assert_eq!(checkpoint["sessionId"], context.session_id);
            assert_eq!(checkpoint["iteration"], 0);
            assert_eq!(checkpoint["maxIterations"], 2);
            assert_eq!(
                checkpoint["pendingToolCalls"][0]["toolCallId"],
                tool_call.id
            );
            assert_eq!(
                checkpoint["pendingToolCalls"][0]["toolName"],
                tool_call.name
            );
            assert!(checkpoint["completedToolResults"]
                .as_array()
                .expect("completed results should be an array")
                .is_empty());
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                tool_call.result.clone(),
            ))
        }
    }

    let checkpoints = Arc::new(InMemoryNativeAgentCheckpointStore::default());
    let services = NativeAgentRuntimeServices::new(
        Arc::new(CheckpointAwareProvider {
            checkpoints: checkpoints.clone(),
            calls: Mutex::new(0),
        }),
        Arc::new(CheckpointAwareToolDispatcher {
            checkpoints: checkpoints.clone(),
        }),
        checkpoints.clone(),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-checkpoint-storage",
            "sessionId": "websocket:chat-checkpoint-storage",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read" }]
        }),
    )
    .expect("checkpoint-aware run should complete");

    assert_eq!(result["stopReason"], "final_response");
    assert!(
        services.restore_checkpoint("websocket:chat-checkpoint-storage")["checkpoint"].is_null()
    );

    services.cancel("run-cancel-checkpoint");
    let cancelled = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancel-checkpoint",
            "sessionId": "websocket:chat-cancel-checkpoint"
        }),
    )
    .expect("cancelled run should return a checkpointed cancellation result");

    assert_eq!(cancelled["stopReason"], "cancelled");
    assert_eq!(cancelled["checkpoint"]["phase"], "cancelled");
    assert_eq!(
        services.restore_checkpoint("websocket:chat-cancel-checkpoint")["checkpoint"]["phase"],
        "cancelled"
    );
}

#[test]
fn runtime_checkpoint_store_isolates_same_session_runs() {
    let services = NativeAgentRuntimeServices::default();
    services.save_run_checkpoint(
        "websocket:chat-1",
        "run-1",
        json!({
            "sessionId": "websocket:chat-1",
            "runId": "run-1",
            "phase": "tool_running"
        }),
    );
    services.save_run_checkpoint(
        "websocket:chat-1",
        "run-2",
        json!({
            "sessionId": "websocket:chat-1",
            "runId": "run-2",
            "phase": "awaiting_approval"
        }),
    );

    assert_eq!(
        services.restore_run_checkpoint("websocket:chat-1", "run-1")["checkpoint"]["runId"],
        "run-1"
    );
    assert_eq!(
        services.restore_run_checkpoint("websocket:chat-1", "run-2")["checkpoint"]["runId"],
        "run-2"
    );

    services.clear_run_checkpoint("websocket:chat-1", "run-1");
    assert!(services.restore_run_checkpoint("websocket:chat-1", "run-1")["checkpoint"].is_null());
    assert_eq!(
        services.restore_run_checkpoint("websocket:chat-1", "run-2")["checkpoint"]["runId"],
        "run-2"
    );
}

#[test]
fn runtime_checkpoint_restore_by_session_uses_latest_resumable_run() {
    let services = NativeAgentRuntimeServices::default();
    services.save_run_checkpoint(
        "websocket:chat-1",
        "run-old",
        json!({
            "sessionId": "websocket:chat-1",
            "runId": "run-old",
            "phase": "tool_running"
        }),
    );
    services.save_run_checkpoint(
        "websocket:chat-1",
        "run-new",
        json!({
            "sessionId": "websocket:chat-1",
            "runId": "run-new",
            "phase": "awaiting_form"
        }),
    );

    let restored = services.restore_checkpoint("websocket:chat-1");

    assert_eq!(restored["checkpoint"]["runId"], "run-new");
}

#[test]
fn saves_and_restores_approval_checkpoint_before_resume() {
    let services = NativeAgentRuntimeServices::default();
    let awaiting = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-approval",
            "sessionId": "websocket:chat-approval",
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-1",
                    "toolName": "workspace.write_file"
                }
            }
        }),
    )
    .expect("approval checkpoint should be created");

    assert_eq!(awaiting["stopReason"], "awaiting_approval");
    assert_eq!(
        awaiting["events"][1]["eventName"],
        "agent.awaiting_approval"
    );
    assert!(awaiting["runtimeEvents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "awaiting_approval"
                && event["payload"]["triggerEventName"] == "agent.awaiting_approval"
        }));
    assert!(awaiting["runtimeEvents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| {
            event["eventName"] == "agent.awaiting_approval"
                && event["payload"]["approvalId"] == "approval-1"
        }));
    assert_eq!(awaiting["events"][1]["payload"]["status"], "waiting");
    assert_eq!(
        awaiting["events"][1]["payload"]["detailId"],
        "approval:approval-1"
    );
    assert_eq!(
        awaiting["events"][1]["payload"]["options"]
            .as_array()
            .map(Vec::len),
        Some(3)
    );
    assert_eq!(awaiting["checkpoint"]["schemaVersion"], 1);
    assert_eq!(awaiting["checkpoint"]["runId"], "run-approval");
    assert_eq!(
        awaiting["checkpoint"]["sessionId"],
        "websocket:chat-approval"
    );
    assert_eq!(awaiting["checkpoint"]["phase"], "awaiting_approval");
    assert_eq!(awaiting["checkpoint"]["iteration"], 0);
    assert_eq!(awaiting["checkpoint"]["maxIterations"], 1);
    assert_eq!(
        awaiting["checkpoint"]["pendingToolCalls"][0]["toolCallId"],
        "approval-1"
    );
    assert_eq!(
        awaiting["checkpoint"]["pendingToolCalls"][0]["toolName"],
        "workspace.write_file"
    );
    assert!(awaiting["checkpoint"]["completedToolResults"]
        .as_array()
        .expect("approval completed results should be an array")
        .is_empty());
    assert_eq!(awaiting["checkpoint"]["resumeToken"], "approval:approval-1");
    assert_eq!(
        services.restore_checkpoint("websocket:chat-approval")["checkpoint"]["phase"],
        "awaiting_approval"
    );

    let resumed = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-approval",
            "sessionId": "websocket:chat-approval",
            "metadata": {
                "agentContinuation": {
                    "kind": "approval",
                    "approvalId": "approval-1",
                    "decision": "approved",
                    "scope": "once"
                },
                "finalContent": "Approved write completed."
            }
        }),
    )
    .expect("approval resume should complete");

    assert_eq!(resumed["stopReason"], "final_response");
    assert_eq!(resumed["events"][0]["eventName"], "agent.approval.decision");
    assert_eq!(resumed["events"][0]["payload"]["decision"], "approved");
    assert_eq!(resumed["events"][0]["payload"]["scope"], "once");
    assert_eq!(resumed["restoredCheckpoint"]["phase"], "awaiting_approval");
    assert!(services.restore_checkpoint("websocket:chat-approval")["checkpoint"].is_null());
}

#[test]
fn handles_approval_denial_form_submit_and_cancel_events() {
    let services = NativeAgentRuntimeServices::default();
    let denied = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-denied",
            "sessionId": "websocket:chat-denied",
            "metadata": {
                "agentContinuation": {
                    "kind": "approval",
                    "approvalId": "approval-1",
                    "decision": "denied",
                    "scope": "once"
                }
            }
        }),
    )
    .expect("approval denial should return error result");
    let awaiting_form = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-form",
            "sessionId": "websocket:chat-form",
            "metadata": {
                "fakeAwaitingForm": {
                    "formId": "form-1",
                    "title": "Configure run"
                }
            }
        }),
    )
    .expect("form checkpoint should be created");
    let submitted = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-form",
            "sessionId": "websocket:chat-form",
            "metadata": {
                "agentContinuation": {
                    "kind": "form",
                    "formId": "form-1",
                    "action": "submit",
                    "values": {}
                },
                "finalContent": "Form values accepted."
            }
        }),
    )
    .expect("form submit should complete");
    let form_cancelled = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-form-cancelled",
            "sessionId": "websocket:chat-form-cancelled",
            "metadata": {
                "agentContinuation": {
                    "kind": "form",
                    "formId": "form-cancelled",
                    "action": "cancel",
                    "values": {}
                }
            }
        }),
    )
    .expect("form cancellation should return error result");
    let cancelled = services.cancel("run-cancel");
    let cancel_result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-cancel",
            "sessionId": "websocket:chat-cancel"
        }),
    )
    .expect("cancelled run should return cancellation result");

    assert_eq!(denied["stopReason"], "approval_denied");
    assert_eq!(denied["events"][0]["eventName"], "agent.approval.decision");
    assert_eq!(denied["events"][0]["payload"]["decision"], "denied");
    assert_eq!(
        awaiting_form["events"][1]["eventName"],
        "agent.awaiting_form"
    );
    assert!(awaiting_form["runtimeEvents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| {
            event["eventName"] == "agent.phase.changed"
                && event["payload"]["nextPhase"] == "awaiting_form"
                && event["payload"]["triggerEventName"] == "agent.awaiting_form"
        }));
    assert!(awaiting_form["runtimeEvents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| {
            event["eventName"] == "agent.awaiting_form" && event["payload"]["formId"] == "form-1"
        }));
    assert_eq!(awaiting_form["events"][1]["payload"]["status"], "waiting");
    assert_eq!(
        awaiting_form["events"][1]["payload"]["detailId"],
        "form:form-1"
    );
    assert_eq!(
        awaiting_form["events"][1]["payload"]["summary"],
        "Configure run"
    );
    assert_eq!(awaiting_form["checkpoint"]["schemaVersion"], 1);
    assert_eq!(awaiting_form["checkpoint"]["runId"], "run-form");
    assert_eq!(
        awaiting_form["checkpoint"]["sessionId"],
        "websocket:chat-form"
    );
    assert_eq!(awaiting_form["checkpoint"]["phase"], "awaiting_form");
    assert_eq!(awaiting_form["checkpoint"]["iteration"], 0);
    assert_eq!(awaiting_form["checkpoint"]["maxIterations"], 1);
    assert!(awaiting_form["checkpoint"]["pendingToolCalls"]
        .as_array()
        .expect("form pending tool calls should be an array")
        .is_empty());
    assert!(awaiting_form["checkpoint"]["completedToolResults"]
        .as_array()
        .expect("form completed results should be an array")
        .is_empty());
    assert_eq!(awaiting_form["checkpoint"]["resumeToken"], "form:form-1");
    assert_eq!(submitted["finalContent"], "Form values accepted.");
    assert_eq!(submitted["events"][0]["eventName"], "agent.form.resolution");
    assert_eq!(submitted["events"][0]["payload"]["status"], "completed");
    assert_eq!(submitted["events"][0]["payload"]["action"], "submit");
    assert_eq!(submitted["events"][0]["payload"]["detailId"], "form:form-1");
    assert_eq!(form_cancelled["stopReason"], "form_cancelled");
    assert_eq!(
        form_cancelled["events"][0]["eventName"],
        "agent.form.resolution"
    );
    assert_eq!(form_cancelled["events"][0]["payload"]["action"], "cancel");
    assert_eq!(
        form_cancelled["events"][0]["payload"]["detailId"],
        "form:form-cancelled"
    );
    assert_eq!(form_cancelled["events"][1]["eventName"], "agent.error");
    assert_eq!(cancelled["stopReason"], "cancelled");
    assert_eq!(cancelled["error"], "cancelled");
    assert_eq!(cancelled["events"][0]["eventName"], "agent.cancelled");
    assert_eq!(cancelled["events"][0]["payload"]["stopReason"], "cancelled");
    assert_eq!(cancel_result["stopReason"], "cancelled");
}

#[test]
fn accepts_typed_approval_and_form_continuations_without_legacy_metadata() {
    let services = NativeAgentRuntimeServices::default();
    run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-typed-approval",
            "sessionId": "websocket:chat-typed-approval",
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-typed",
                    "toolName": "workspace.write_file"
                }
            }
        }),
    )
    .expect("approval checkpoint should be created");

    let approval = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-typed-approval",
            "sessionId": "websocket:chat-typed-approval",
            "metadata": {
                "agentContinuation": {
                    "kind": "approval",
                    "approvalId": "approval-typed",
                    "decision": "approved",
                    "scope": "session"
                },
                "finalContent": "Typed approval completed."
            }
        }),
    )
    .expect("typed approval continuation should complete");

    run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-typed-form",
            "sessionId": "websocket:chat-typed-form",
            "metadata": {
                "fakeAwaitingForm": {
                    "formId": "form-typed",
                    "title": "Configure run"
                }
            }
        }),
    )
    .expect("form checkpoint should be created");

    let form = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-typed-form",
            "sessionId": "websocket:chat-typed-form",
            "metadata": {
                "agentContinuation": {
                    "kind": "form",
                    "formId": "form-typed",
                    "action": "submit",
                    "values": { "destination": "Tokyo" }
                },
                "finalContent": "Typed form submitted."
            }
        }),
    )
    .expect("typed form continuation should complete");

    assert_eq!(approval["stopReason"], "final_response");
    assert_eq!(approval["finalContent"], "Typed approval completed.");
    assert_eq!(approval["continuation"]["kind"], "approval");
    assert_eq!(approval["continuation"]["approvalId"], "approval-typed");
    assert_eq!(approval["continuation"]["decision"], "approved");
    assert_eq!(approval["continuation"]["scope"], "session");
    assert_eq!(approval["restoredCheckpoint"]["phase"], "awaiting_approval");
    assert!(services.restore_checkpoint("websocket:chat-typed-approval")["checkpoint"].is_null());

    assert_eq!(form["stopReason"], "final_response");
    assert_eq!(form["finalContent"], "Typed form submitted.");
    assert_eq!(form["continuation"]["kind"], "form");
    assert_eq!(form["continuation"]["formId"], "form-typed");
    assert_eq!(form["continuation"]["action"], "submit");
    assert_eq!(form["continuation"]["values"]["destination"], "Tokyo");
    assert_eq!(form["restoredCheckpoint"]["phase"], "awaiting_form");
    assert_eq!(form["events"][0]["eventName"], "agent.form.resolution");
    assert_eq!(form["events"][0]["payload"]["status"], "completed");
    assert_eq!(form["events"][0]["payload"]["action"], "submit");
    assert_eq!(
        form["events"][0]["payload"]["values"]["destination"],
        "Tokyo"
    );
    assert!(services.restore_checkpoint("websocket:chat-typed-form")["checkpoint"].is_null());
}

#[test]
fn queued_user_message_continuation_becomes_next_turn_input() {
    struct RecordingProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for RecordingProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.seen_messages
                .lock()
                .expect("seen messages lock should not be poisoned")
                .push(context.messages.clone());
            Ok(NativeAgentProviderResponse {
                final_content: "queued response".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let provider = Arc::new(RecordingProvider {
        seen_messages: Mutex::new(Vec::new()),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-queued-message",
            "sessionId": "websocket:chat-queued-message",
            "metadata": {
                "agentContinuation": {
                    "kind": "queued_user_message",
                    "messageId": "queued-1",
                    "content": "queued hello"
                }
            }
        }),
    )
    .expect("queued message continuation should become provider input");
    let seen_messages = provider
        .seen_messages
        .lock()
        .expect("seen messages lock should not be poisoned");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(seen_messages.len(), 1);
    assert_eq!(seen_messages[0][0]["role"], "user");
    assert_eq!(seen_messages[0][0]["content"], "queued hello");
}

#[test]
fn guidance_continuation_is_inserted_before_next_model_call_after_tools() {
    struct ToolThenFinalProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for ToolThenFinalProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let call_count = {
                let mut seen_messages = self
                    .seen_messages
                    .lock()
                    .expect("seen messages lock should not be poisoned");
                seen_messages.push(context.messages.clone());
                seen_messages.len()
            };
            if call_count == 1 {
                Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-guidance-read".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "README body" }),
                    }],
                })
            } else {
                Ok(NativeAgentProviderResponse {
                    final_content: "guided response".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                })
            }
        }
    }

    let provider = Arc::new(ToolThenFinalProvider {
        seen_messages: Mutex::new(Vec::new()),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-guided-message",
            "sessionId": "websocket:chat-guided-message",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "read first" }],
            "metadata": {
                "agentContinuation": {
                    "kind": "guidance",
                    "messageId": "guidance-1",
                    "content": "use the README result carefully"
                }
            }
        }),
    )
    .expect("guidance continuation should be inserted after tool boundary");
    let seen_messages = provider
        .seen_messages
        .lock()
        .expect("seen messages lock should not be poisoned");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(seen_messages.len(), 2);
    assert!(!seen_messages[0]
        .iter()
        .any(|message| message["content"] == "use the README result carefully"));
    assert!(seen_messages[1]
        .iter()
        .any(|message| message["content"] == "use the README result carefully"));
    assert!(seen_messages[1].iter().any(
        |message| message["role"] == "tool" && message["tool_call_id"] == "call-guidance-read"
    ));
    assert!(result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.guidance"));
}

#[test]
fn approval_denial_guidance_becomes_tool_result_before_next_model_call() {
    struct RecordingProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for RecordingProvider {
        fn complete(
            &self,
            context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.seen_messages
                .lock()
                .expect("seen messages lock should not be poisoned")
                .push(context.messages.clone());
            Ok(NativeAgentProviderResponse {
                final_content: "I will avoid writing and explain instead.".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let provider = Arc::new(RecordingProvider {
        seen_messages: Mutex::new(Vec::new()),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-approval-guidance",
            "sessionId": "websocket:chat-approval-guidance",
            "messages": [{ "role": "user", "content": "write the file" }],
            "metadata": {
                "fakeAwaitingApproval": {
                    "approvalId": "approval-guidance",
                    "toolName": "workspace.write_file"
                }
            }
        }),
    )
    .expect("approval checkpoint should be created");

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-approval-guidance",
            "sessionId": "websocket:chat-approval-guidance",
            "metadata": {
                "agentContinuation": {
                    "kind": "approval",
                    "approvalId": "approval-guidance",
                    "decision": "denied",
                    "scope": "once",
                    "guidance": "Do not write files; explain the manual steps instead."
                }
            }
        }),
    )
    .expect("approval denial guidance should continue through the model");

    let seen_messages = provider
        .seen_messages
        .lock()
        .expect("seen messages lock should not be poisoned");
    let events = event_names(&result);

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(
        result["finalContent"],
        "I will avoid writing and explain instead."
    );
    assert_eq!(seen_messages.len(), 1);
    assert_eq!(seen_messages[0][0]["role"], "user");
    assert_eq!(seen_messages[0][0]["content"], "write the file");
    assert_eq!(seen_messages[0][1]["role"], "assistant");
    assert_eq!(
        seen_messages[0][1]["tool_calls"][0]["id"],
        "approval-guidance"
    );
    assert_eq!(seen_messages[0][2]["role"], "tool");
    assert_eq!(seen_messages[0][2]["tool_call_id"], "approval-guidance");
    assert!(seen_messages[0][2]["content"]
        .as_str()
        .expect("tool result content should be text")
        .contains("Do not write files"));
    assert_eq!(result["completedToolResults"][0]["status"], "denied");
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "approval-guidance"
    );
    assert_eq!(result["events"][0]["eventName"], "agent.approval.decision");
    assert_eq!(result["events"][0]["payload"]["decision"], "denied");
    assert_eq!(
        result["events"][0]["payload"]["guidance"],
        "Do not write files; explain the manual steps instead."
    );
    assert_eq!(result["events"][1]["eventName"], "agent.tool.result");
    assert_eq!(result["events"][1]["payload"]["resultStatus"], "denied");
    assert_eq!(
        events,
        vec!["agent.approval.decision", "agent.tool.result", "agent.done"]
    );
    assert!(
        services.restore_checkpoint("websocket:chat-approval-guidance")["checkpoint"].is_null()
    );
}

#[test]
fn provider_stream_observer_emits_live_deltas_without_duplicate_final_delta() {
    struct StreamingProvider;

    impl NativeAgentProvider for StreamingProvider {
        fn complete(
            &self,
            _context: &NativeAgentRunContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: "Hello".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }

        fn complete_streaming(
            &self,
            _context: &NativeAgentRunContext,
            observer: &mut dyn FnMut(NativeAgentProviderStreamEvent),
        ) -> Result<NativeAgentProviderResponse, String> {
            observer(NativeAgentProviderStreamEvent::ReasoningDelta(
                "thinking".to_string(),
            ));
            observer(NativeAgentProviderStreamEvent::ContentDelta(
                "Hel".to_string(),
            ));
            observer(NativeAgentProviderStreamEvent::ContentDelta(
                "lo".to_string(),
            ));
            Ok(NativeAgentProviderResponse {
                final_content: "Hello".to_string(),
                reasoning_delta: Some("thinking".to_string()),
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let services = NativeAgentRuntimeServices::new(
        Arc::new(StreamingProvider),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "runId": "run-streaming-provider",
            "sessionId": "websocket:chat-streaming-provider",
            "stream": true,
            "messages": [{ "role": "user", "content": "hello" }]
        }),
    )
    .expect("streaming provider run should succeed");

    let deltas = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .filter(|event| event["eventName"] == "agent.delta")
        .map(|event| event["payload"]["delta"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    let reasoning_deltas = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .filter(|event| event["eventName"] == "agent.reasoning_delta")
        .map(|event| event["payload"]["delta"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();

    assert_eq!(deltas, vec!["Hel", "lo"]);
    assert_eq!(reasoning_deltas, vec!["thinking"]);
    assert_eq!(result["finalContent"], "Hello");
}

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
