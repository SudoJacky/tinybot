use super::super::usage::{
    context_window_action_payload, context_window_projection, estimate_context_tokens_for_request,
    prepare_provider_request,
};
use super::*;

#[test]
fn runs_fixture_streaming_final_answer_with_frontend_events() {
    let result = run_native_agent_turn(json!({
        "runtime": "rust",
        "turnId": "turn-1",
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
    assert_eq!(turn_started["payload"]["userMessageId"], "turn-1:user");
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
    for event_name in [
        "agent.delta",
        "agent.model_call.completed",
        "agent.token_count",
        "agent.usage",
        "agent.message.completed",
        "agent.done",
    ] {
        assert!(runtime_events
            .iter()
            .any(|event| event["eventName"] == event_name));
    }
    let message_completed = runtime_events
        .iter()
        .find(|event| event["eventName"] == "agent.message.completed")
        .expect("message completion should be present");
    assert_eq!(message_completed["payload"]["content"], "fixture answer");
    let done = runtime_events
        .iter()
        .find(|event| event["eventName"] == "agent.done")
        .expect("done event should be present");
    assert_eq!(done["payload"]["stopReason"], "final_response");
    assert!(done["payload"].get("finalContent").is_none());
    assert_eq!(
        runtime_transcript(&result),
        vec![
            json!({
                "event": "agent.phase.changed",
                "phase": "hydrating_history",
                "iteration": 0,
                "transition": ["queued", "hydrating_history"],
            }),
            json!({
                "event": "agent.phase.changed",
                "phase": "planning",
                "iteration": 0,
                "transition": ["hydrating_history", "planning"],
            }),
            json!({ "event": "agent.turn.started", "phase": "planning" }),
            json!({
                "event": "agent.phase.changed",
                "phase": "calling_model",
                "iteration": 0,
                "transition": ["planning", "calling_model"],
            }),
            json!({
                "event": "agent.status",
                "phase": "calling_model",
                "iteration": 0,
            }),
            json!({
                "event": "agent.phase.changed",
                "phase": "streaming_model",
                "iteration": 0,
                "transition": ["calling_model", "streaming_model"],
            }),
            json!({
                "event": "agent.status",
                "phase": "streaming_model",
                "iteration": 0,
            }),
            json!({
                "event": "agent.delta",
                "phase": "streaming_model",
                "iteration": 0,
                "item": "turn-1:assistant:0",
                "modelCall": "turn-1:provider:1",
                "message": "turn-1:assistant:0",
            }),
            json!({
                "event": "agent.model_call.completed",
                "phase": "planning",
                "iteration": 0,
                "modelCall": "turn-1:provider:1",
            }),
            json!({
                "event": "agent.token_count",
                "phase": "planning",
                "iteration": 0,
                "modelCall": "turn-1:provider:1",
            }),
            json!({
                "event": "agent.usage",
                "phase": "calling_model",
                "iteration": 0,
                "item": "turn-1:usage:0",
                "modelCall": "turn-1:provider:1",
            }),
            json!({
                "event": "agent.phase.changed",
                "phase": "finalizing",
                "iteration": 0,
                "transition": ["streaming_model", "finalizing"],
            }),
            json!({
                "event": "agent.status",
                "phase": "finalizing",
                "iteration": 0,
            }),
            json!({
                "event": "agent.message.completed",
                "phase": "completed",
                "iteration": 0,
                "item": "turn-1:assistant:0",
                "modelCall": "turn-1:provider:1",
                "message": "turn-1:assistant:0",
            }),
            json!({
                "event": "agent.phase.changed",
                "phase": "completed",
                "iteration": 0,
                "transition": ["finalizing", "completed"],
            }),
            json!({
                "event": "agent.status",
                "phase": "completed",
                "iteration": 0,
            }),
            json!({
                "event": "agent.done",
                "phase": "completed",
                "iteration": 0,
                "stop": "final_response",
            }),
        ]
    );
}

#[test]
fn turn_started_preserves_client_event_id_for_canonical_reconciliation() {
    let result = run_native_agent_turn(json!({
        "runtime": "rust",
        "turnId": "turn-client-event",
        "sessionId": "websocket:chat-client-event",
        "input": {
            "role": "user",
            "content": "hello",
            "clientEventId": "client-message-1"
        },
        "config": fixture_provider_config("fixture answer")
    }))
    .expect("fixture provider run should succeed");

    let turn_started = result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.turn.started")
        .expect("turn started should be present");

    assert_eq!(
        turn_started["payload"]["userMessage"]["clientEventId"],
        "client-message-1"
    );
    assert_eq!(turn_started["payload"]["clientEventId"], "client-message-1");
}

#[test]
fn agent_chat_request_trims_old_messages_to_context_window() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-context-window",
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
                    "contextWindowTokens": 32,
                    "contextWindowStrategy": "discard"
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
fn context_window_trimming_does_not_orphan_tool_results() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-context-tool-unit",
            "sessionId": "session-context-tool-unit",
            "messages": [
                { "role": "user", "content": "old message ".repeat(200) },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "context-tool-1",
                        "type": "function",
                        "function": {
                            "name": "workspace.read_file",
                            "arguments": format!(r#"{{"path":"{}"}}"#, "long/".repeat(80))
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "context-tool-1",
                    "name": "workspace.read_file",
                    "content": "small result"
                },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "fixture",
                    "model": "fixture-model",
                    "contextWindowTokens": 60,
                    "contextWindowStrategy": "discard"
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context).expect("request should build");
    let messages = request["messages"]
        .as_array()
        .expect("messages should be an array");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "current question");
}

#[test]
fn system_prompt_survives_context_window_trimming() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "turnId": "turn-system-prompt-context-window",
            "sessionId": "session-system-prompt-context-window",
            "messages": [
                { "role": "user", "content": "old message ".repeat(200) },
                { "role": "assistant", "content": "old answer ".repeat(200) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": {
                "defaults": {
                    "model": "fixture-model",
                    "contextWindowTokens": 32,
                    "contextWindowStrategy": "discard"
                }
            }
        }),
    );
    context.system_prompt =
        Some("You are Tinybot. Keep the active workspace in scope.".to_string());

    let request = agent_chat_completion_request(&context).expect("request should build");
    let messages = request["messages"]
        .as_array()
        .expect("messages should be an array");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(
        messages[0]["content"],
        "You are Tinybot. Keep the active workspace in scope."
    );
    assert_eq!(messages[1]["content"], "current question");
}

#[test]
fn agent_turn_emits_context_trim_event_when_old_messages_are_discarded() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-context-trim-event",
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
                    "contextWindowTokens": 32,
                    "contextWindowStrategy": "discard"
                }
            },
            "providers": { "fixture": { "responses": [{ "content": "fixture answer" }] } }
        }),
    )
    .expect("fixture provider run should succeed");

    let trim_event = result["runtimeEvents"]
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
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-stream-usage",
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
    let mut context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-context-compact",
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
                    "contextWindowTokens": 800,
                    "contextWindowStrategy": "compact",
                    "compactTriggerPercent": 50,
                    "compactSummaryMaxTokens": 32
                }
            },
            "providers": { "fixture": { "responses": [{ "content": "summary of earlier turns" }] } }
        }),
    );
    context.tool_router = NativeToolRouter::new(Vec::new());

    let request = agent_chat_completion_request(&context).expect("request should build");
    let messages = request["messages"]
        .as_array()
        .expect("messages should be an array");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "current question");
    assert_eq!(messages[1]["role"], "user");
    assert!(messages[1]["content"]
        .as_str()
        .expect("summary content should be text")
        .contains("summary of earlier turns"));
    assert!(messages[1].get("contextCompaction").is_none());
}

#[test]
fn context_compaction_fails_when_one_atomic_unit_exceeds_summary_budget() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-context-compact-oversized-unit",
            "sessionId": "session-context-compact-oversized-unit",
            "messages": [
                { "role": "user", "content": "indivisible context ".repeat(500) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 120,
                "contextWindowStrategy": "compact",
                "compactTriggerPercent": 50
            }},
            "providers": { "fixture": {
                "responses": [{ "content": "must not be requested" }]
            }}
        }),
    );

    let error = agent_chat_completion_request(&context)
        .expect_err("an oversized atomic context unit should fail before provider dispatch");

    assert!(error.contains("single context unit"));
    assert!(error.contains("summary request budget"));
}

#[test]
fn agent_turn_emits_compaction_failed_without_installing_a_checkpoint() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-context-compaction-failed",
            "sessionId": "session-context-compaction-failed",
            "messages": [
                { "role": "user", "content": "indivisible context ".repeat(500) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 120,
                "contextWindowStrategy": "compact",
                "compactTriggerPercent": 50
            }},
            "providers": { "fixture": {
                "responses": [{ "content": "must not be requested" }]
            }}
        }),
    )
    .expect("compaction failure should be returned as a terminal agent result");

    assert_eq!(result["stopReason"], "provider_error");
    assert!(result.get("contextCheckpoint").is_none());
    assert!(result["runtimeEvents"]
        .as_array()
        .is_some_and(|events| !events
            .iter()
            .any(|event| { event["eventName"] == "agent.context.compacted" })));
    let failed = result["runtimeEvents"]
        .as_array()
        .expect("events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.context.compaction_failed")
        .expect("compaction failure event should be present");
    assert_eq!(failed["payload"]["status"], "failed");
    assert_eq!(failed["payload"]["trigger"], "auto");
    assert_eq!(failed["payload"]["reason"], "context_limit");
    assert_eq!(failed["payload"]["phase"], "pre_turn");
    assert_eq!(failed["payload"]["method"], "summary");
    assert_eq!(failed["payload"]["canonicalContextChanged"], false);
    assert_eq!(
        failed["payload"]["agentItem"]["code"],
        "context_compaction_failed"
    );
    assert!(failed["payload"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("single context unit")));
}

#[test]
fn agent_turn_emits_context_compaction_event_when_old_messages_are_summarized() {
    let services = NativeAgentRuntimeServices {
        test_tool_registry_entries: Some(Vec::new()),
        ..NativeAgentRuntimeServices::default()
    };
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-context-compact-event",
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
                    "contextWindowTokens": 800,
                    "contextWindowStrategy": "compact",
                    "compactTriggerPercent": 50,
                    "compactSummaryMaxTokens": 32
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

    let compact_event = result["runtimeEvents"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.context.compacted")
        .expect("context compaction event should be emitted");

    assert_eq!(compact_event["payload"]["strategy"], "compact");
    assert_eq!(compact_event["payload"]["droppedMessageCount"], 2);
    assert_eq!(compact_event["payload"]["retainedMessageCount"], 1);
    assert_eq!(compact_event["payload"]["replacementMessageCount"], 2);
    assert_eq!(compact_event["payload"]["preservedUserMessageCount"], 1);
    assert_eq!(compact_event["payload"]["droppedUserMessageCount"], 1);
    assert_eq!(compact_event["payload"]["droppedAssistantMessageCount"], 1);
    assert_eq!(compact_event["payload"]["droppedToolMessageCount"], 0);
    assert_eq!(compact_event["payload"]["contextWindowTokens"], 800);
    assert_eq!(
        compact_event["payload"]["agentItem"]["type"],
        "context_compaction"
    );
    assert_eq!(compact_event["payload"]["agentItem"]["droppedItemCount"], 2);
    assert_eq!(compact_event["payload"]["trigger"], "auto");
    assert_eq!(compact_event["payload"]["reason"], "context_limit");
    assert_eq!(compact_event["payload"]["method"], "summary");
    assert_eq!(compact_event["payload"]["windowNumber"], 1);
    assert_eq!(
        compact_event["payload"]["windowId"],
        compact_event["payload"]["contextId"]
    );
    assert_eq!(result["contextCheckpoint"]["schemaVersion"], 1);
    assert_eq!(result["contextCheckpoint"]["checkpointStage"], "finalized");
    assert!(result["contextCheckpoint"]["sourceContextId"].is_null());
    assert_eq!(result["contextCheckpoint"]["windowNumber"], 1);
    assert_eq!(
        result["contextCheckpoint"]["firstWindowId"],
        "websocket:chat-context-compact-event:context-window:0"
    );
    assert_eq!(
        result["contextCheckpoint"]["previousWindowId"],
        "websocket:chat-context-compact-event:context-window:0"
    );
    assert_eq!(
        result["contextCheckpoint"]["windowId"],
        result["contextCheckpoint"]["contextId"]
    );
    assert!(result["contextCheckpoint"]["sourceVersion"]
        .as_str()
        .is_some_and(|version| version.starts_with("sha256:")));
    assert!(result["contextCheckpoint"]["replacementHistory"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|message| {
            message["content"]
                .as_str()
                .is_some_and(|content| content.contains("summary of earlier turns"))
        })));
}

#[test]
fn manual_context_compaction_bypasses_threshold_and_finishes_without_a_normal_response() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-context-compact-manual",
            "sessionId": "session-context-compact-manual",
            "contextCompaction": {
                "trigger": "manual",
                "reason": "user_requested",
                "phase": "standalone_turn"
            },
            "messages": [
                { "role": "user", "content": "earlier question ".repeat(80) },
                { "role": "assistant", "content": "earlier answer ".repeat(80) },
                { "role": "user", "content": "recent question" }
            ]
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 8_000,
                "contextWindowStrategy": "discard",
                "compactSummaryMaxTokens": 64
            } },
            "providers": { "fixture": { "responses": [
                { "content": "manual summary of earlier turns" }
            ] } }
        }),
    )
    .expect("manual compaction should complete");

    assert_eq!(result["stopReason"], "context_compacted");
    assert_eq!(result["finalContent"], "");
    assert_eq!(result["messages"], json!([]));
    let compact_event = result["runtimeEvents"]
        .as_array()
        .expect("events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.context.compacted")
        .expect("manual compaction should emit its canonical item");
    assert_eq!(compact_event["payload"]["trigger"], "manual");
    assert_eq!(compact_event["payload"]["reason"], "user_requested");
    assert_eq!(compact_event["payload"]["phase"], "standalone_turn");
    assert!(result["runtimeEvents"]
        .as_array()
        .is_some_and(|events| !events
            .iter()
            .any(|event| event["eventName"] == "agent.turn.started")));
    assert!(compact_event["payload"]["droppedMessageCount"]
        .as_u64()
        .is_some_and(|count| count > 0));
    assert_eq!(result["contextCheckpoint"]["checkpointStage"], "finalized");
    let replacement = result["contextCheckpoint"]["replacementHistory"]
        .as_array()
        .expect("manual compaction should persist replacement history");
    assert_eq!(replacement.len(), 3);
    assert_eq!(replacement[0]["role"], "user");
    assert_eq!(replacement[1]["role"], "user");
    assert_eq!(replacement[2]["role"], "assistant");
    assert_eq!(replacement[2]["contextCompaction"], true);
    assert!(result["runtimeEvents"]
        .as_array()
        .is_some_and(|events| !events
            .iter()
            .any(|event| event["eventName"] == "agent.message.completed")));
}

#[test]
fn manual_and_auto_compaction_install_the_same_role_aware_history() {
    let messages = json!([
        { "role": "system", "content": "historical system instruction" },
        { "role": "user", "content": "The login page returns 401; investigate it." },
        { "role": "assistant", "content": "I will inspect authentication. ".repeat(100) },
        {
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "compact-call-1",
                "type": "function",
                "function": { "name": "workspace.search", "arguments": "{}" }
            }]
        },
        { "role": "tool", "tool_call_id": "compact-call-1", "content": "search results" },
        { "role": "assistant", "content": "The token validation is wrong." },
        { "role": "user", "content": "Keep the old Session API compatible." },
        { "role": "assistant", "content": "I will preserve that constraint." },
        {
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "compact-call-2",
                "type": "function",
                "function": { "name": "workspace.read_file", "arguments": "{}" }
            }]
        },
        { "role": "tool", "tool_call_id": "compact-call-2", "content": "auth.ts contents" },
        { "role": "assistant", "content": "I changed the middleware." },
        {
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "compact-call-3",
                "type": "function",
                "function": { "name": "workspace.run_tests", "arguments": "{}" }
            }]
        },
        { "role": "tool", "tool_call_id": "compact-call-3", "content": "all tests passed" },
        { "role": "assistant", "content": "The fix is complete." }
    ]);
    let config = json!({
        "agents": { "defaults": {
            "provider": "fixture",
            "model": "fixture-model",
            "contextWindowTokens": 10_000,
            "contextWindowStrategy": "compact",
            "compactTriggerPercent": 1,
            "compactSummaryMaxTokens": 64
        }},
        "providers": { "fixture": { "responses": [
            { "content": "fixed token validation, preserved Session compatibility, and passed tests" }
        ]}}
    });
    let base_spec = json!({
        "runtime": "rust",
        "turnId": "turn-unified-compaction",
        "sessionId": "session-unified-compaction",
        "messages": messages
    });
    let auto_context = AgentTurnContext::from_spec(base_spec.clone(), config.clone());
    let mut manual_spec = base_spec;
    manual_spec["contextCompaction"] = json!({
        "trigger": "manual",
        "reason": "user_requested",
        "phase": "standalone_turn"
    });
    let manual_context = AgentTurnContext::from_spec(manual_spec, config);

    let auto = context_window_projection(&auto_context).expect("auto compaction should project");
    let manual =
        context_window_projection(&manual_context).expect("manual compaction should project");

    assert_eq!(manual.messages, auto.messages);
    assert_eq!(manual.messages.len(), 4);
    assert_eq!(manual.messages[0]["role"], "system");
    assert_eq!(manual.messages[1]["role"], "user");
    assert_eq!(manual.messages[2]["role"], "user");
    assert_eq!(manual.messages[3]["role"], "assistant");
    assert_eq!(manual.messages[3]["contextCompaction"], true);
    assert!(manual.messages[3]["content"]
        .as_str()
        .is_some_and(|content| content.contains("fixed token validation")));
    assert!(!manual
        .messages
        .iter()
        .any(|message| message["role"] == "tool" || message.get("tool_calls").is_some()));

    let auto_payload = context_window_action_payload(
        &auto_context,
        0,
        auto.action.as_ref().expect("auto action should exist"),
    );
    let manual_payload = context_window_action_payload(
        &manual_context,
        0,
        manual.action.as_ref().expect("manual action should exist"),
    );
    assert_eq!(auto_payload["trigger"], "auto");
    assert_eq!(manual_payload["trigger"], "manual");
    assert_eq!(auto_payload["preservedUserMessageCount"], 2);
    assert_eq!(auto_payload["droppedAssistantMessageCount"], 8);
    assert_eq!(auto_payload["droppedToolMessageCount"], 3);
}

#[test]
fn repeated_compaction_replaces_the_previous_summary() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-repeat-compaction",
            "sessionId": "session-repeat-compaction",
            "contextCompaction": { "trigger": "manual" },
            "messages": [
                { "role": "system", "content": "historical system instruction" },
                { "role": "user", "content": "first request" },
                { "role": "user", "content": "second request" },
                {
                    "role": "assistant",
                    "content": "Conversation summary so far:\nOLD SUMMARY MUST BE REPLACED",
                    "contextCompaction": true
                },
                { "role": "user", "content": "third request" },
                { "role": "assistant", "content": "new work after the first compaction" }
            ]
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 10_000,
                "contextWindowStrategy": "compact",
                "compactSummaryMaxTokens": 64
            }},
            "providers": { "fixture": { "responses": [
                { "content": "NEW MERGED SUMMARY" }
            ]}}
        }),
    );

    let projection = context_window_projection(&context).expect("repeat compaction should project");

    assert_eq!(projection.messages.len(), 5);
    assert_eq!(
        projection
            .messages
            .iter()
            .filter(|message| message["contextCompaction"] == true)
            .count(),
        1
    );
    assert!(!projection
        .messages
        .iter()
        .any(|message| message.to_string().contains("OLD SUMMARY MUST BE REPLACED")));
    assert!(projection.messages.last().is_some_and(|message| {
        message["role"] == "assistant"
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("NEW MERGED SUMMARY"))
    }));
}

#[test]
fn context_checkpoint_uses_hydrated_parent_context_id() {
    let context = AgentTurnContext::from_spec(
        json!({
            "turnId": "turn-context-lineage",
            "sessionId": "session-context-lineage",
            "metadata": {
                "contextSourceCheckpointId": "previous-context",
                "contextSourceCheckpoint": {
                    "contextId": "previous-context",
                    "windowNumber": 3,
                    "firstWindowId": "first-window",
                    "previousWindowId": "window-2",
                    "windowId": "window-3"
                }
            },
            "messages": [{ "role": "user", "content": "current question" }]
        }),
        json!({}),
    );
    let state = super::state::AgentTurnState::new(&context, None).unwrap();
    let checkpoint = state.compacted_context_checkpoint(
        &[json!({ "role": "system", "content": "summary" })],
        &json!({ "contextId": "next-context" }),
    );

    assert_eq!(checkpoint["sourceContextId"], "previous-context");
    assert_eq!(checkpoint["windowNumber"], 4);
    assert_eq!(checkpoint["firstWindowId"], "first-window");
    assert_eq!(checkpoint["previousWindowId"], "window-3");
    assert_eq!(checkpoint["windowId"], "next-context");
}

#[test]
fn in_memory_context_checkpoint_committer_bootstraps_and_enforces_lineage() {
    let committer = InMemoryNativeAgentContextCheckpointCommitter::default();
    let commit = |context_id: &str, source_context_id: &str| NativeAgentContextCheckpointCommit {
        session_id: "session-context-lineage".to_string(),
        turn_id: format!("turn-{context_id}"),
        thread_id: None,
        checkpoint: json!({
            "contextId": context_id,
            "sourceContextId": source_context_id,
            "checkpointStage": "installed",
            "replacementHistory": []
        }),
    };

    committer
        .commit(&commit("context-2", "context-1"))
        .expect("hydrated parent should bootstrap the in-memory committer");
    let stale = committer
        .commit(&commit("context-stale", "context-1"))
        .unwrap_err();
    assert!(stale.contains("stale context compaction checkpoint"));
}

#[test]
fn context_compaction_commit_failure_keeps_live_context_unmodified() {
    let committer = Arc::new(FailingContextCheckpointCommitter::default());
    let services =
        NativeAgentRuntimeServices::default().with_context_checkpoint_committer(committer.clone());
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-context-commit-failed",
            "sessionId": "session-context-commit-failed",
            "messages": [
                { "role": "user", "content": "old context ".repeat(200) },
                { "role": "assistant", "content": "old answer ".repeat(200) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 800,
                "contextWindowStrategy": "compact",
                "compactTriggerPercent": 50,
                "compactSummaryMaxTokens": 32
            }},
            "providers": { "fixture": { "responses": [
                { "content": "summary of earlier turns" },
                { "content": "must not reach the main provider request" }
            ] } }
        }),
    )
    .expect("commit failure should be returned as a terminal agent result");

    assert_eq!(result["stopReason"], "context_compaction_commit_failed");
    assert!(result.get("contextCheckpoint").is_none());
    assert!(result["runtimeEvents"]
        .as_array()
        .is_some_and(|events| !events
            .iter()
            .any(|event| event["eventName"] == "agent.context.compacted")));
    let failed = result["runtimeEvents"]
        .as_array()
        .expect("events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.context.compaction_failed")
        .expect("compaction failure event should be present");
    assert_eq!(
        failed["payload"]["failureStopReason"],
        "context_compaction_commit_failed"
    );
    assert_eq!(failed["payload"]["canonicalContextChanged"], false);

    let commits = committer
        .commits
        .lock()
        .expect("checkpoint commit lock should not be poisoned");
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].checkpoint["checkpointStage"], "installed");
    assert!(commits[0].checkpoint["replacementHistory"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|message| message["content"]
            .as_str()
            .is_some_and(|content| content.contains("summary of earlier turns")))));
}

#[test]
fn context_compaction_summarizes_oversized_history_in_bounded_layers() {
    let mut messages = (0..6)
        .map(|index| {
            json!({
                "role": "user",
                "content": format!("old context {index}: {}", "x".repeat(1600))
            })
        })
        .collect::<Vec<_>>();
    messages.push(json!({ "role": "user", "content": "current question" }));
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-context-layered-summary",
            "sessionId": "session-context-layered-summary",
            "messages": messages
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 1000,
                "contextWindowStrategy": "compact",
                "compactTriggerPercent": 50,
                "compactSummaryMaxTokens": 250
            }},
            "providers": { "fixture": {
                "responses": [{ "content": "bounded partial summary" }]
            }}
        }),
    )
    .expect("layered summary should fit every provider request");

    let compact_event = result["runtimeEvents"]
        .as_array()
        .expect("events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.context.compacted")
        .expect("compaction event should be present");
    assert!(compact_event["payload"]["summaryRequestCount"]
        .as_u64()
        .is_some_and(|count| count > 1));
    assert!(result["contextCheckpoint"]["replacementHistory"]
        .as_array()
        .is_some_and(|replacement| replacement.iter().any(|message| {
            message["content"]
                .as_str()
                .is_some_and(|content| content.contains("bounded partial summary"))
        })));
}

#[test]
fn context_compaction_masks_large_tool_output_without_splitting_its_call() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-context-tool-mask",
            "sessionId": "session-context-tool-mask",
            "messages": [
                { "role": "user", "content": "old message ".repeat(300) },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "context-tool-mask-1",
                        "type": "function",
                        "function": {
                            "name": "workspace.read_file",
                            "arguments": r#"{"path":"large.log"}"#
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "context-tool-mask-1",
                    "name": "workspace.read_file",
                    "content": format!("HEAD-{}-TAIL", "x".repeat(4000))
                },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 1400,
                "contextWindowStrategy": "compact",
                "compactTriggerPercent": 50,
                "compactSummaryMaxTokens": 64
            }},
            "providers": { "fixture": {
                "responses": [
                    { "content": "summary before the tool call" },
                    { "content": "finished with masked tool output" }
                ]
            }}
        }),
    )
    .expect("compacted run should succeed");

    let compact_event = result["runtimeEvents"]
        .as_array()
        .expect("events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.context.compacted")
        .expect("compaction event should be present");
    assert_eq!(compact_event["payload"]["maskedToolOutputCount"], 1);

    let replacement = result["contextCheckpoint"]["replacementHistory"]
        .as_array()
        .expect("replacement history should be present");
    assert!(!replacement.iter().any(|message| message["role"] == "tool"));
    assert!(!replacement.iter().any(|message| {
        message["tool_calls"].as_array().is_some_and(|tool_calls| {
            tool_calls
                .iter()
                .any(|call| call["id"] == "context-tool-mask-1")
        })
    }));
    assert!(replacement.iter().any(|message| {
        message["contextCompaction"] == true
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("summary before the tool call"))
    }));
}

#[test]
fn compacted_context_becomes_the_next_tool_iteration_baseline() {
    struct ToolThenFinishProvider {
        calls: AtomicUsize,
        contexts: Arc<Mutex<Vec<Vec<Value>>>>,
    }

    impl NativeAgentProvider for ToolThenFinishProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.contexts
                .lock()
                .expect("provider context lock should not be poisoned")
                .push(context.messages.clone());
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: vec![NativeAgentToolCall {
                        id: "compact-read-1".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: r#"{"path":"README.md"}"#.to_string(),
                        result: Value::Null,
                    }],
                })
            } else {
                Ok(NativeAgentProviderResponse {
                    final_content: "finished after compact".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: Vec::new(),
                })
            }
        }
    }

    struct ReadDispatcher;

    impl NativeAgentToolDispatcher for ReadDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            tool_call: &PreparedToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                json!({ "content": "small tool result" }),
            ))
        }
    }

    let contexts = Arc::new(Mutex::new(Vec::new()));
    let services = NativeAgentRuntimeServices {
        provider: Arc::new(ToolThenFinishProvider {
            calls: AtomicUsize::new(0),
            contexts: contexts.clone(),
        }),
        tools: Arc::new(ReadDispatcher),
        test_tool_registry_entries: Some(
            test_registry_with_model_tools(&["workspace.read_file"])
                .into_iter()
                .filter(|entry| entry.method == "workspace.read_file")
                .collect(),
        ),
        ..NativeAgentRuntimeServices::default()
    };
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-durable-context-compact",
            "sessionId": "session-durable-context-compact",
            "messages": [
                { "role": "user", "content": "old context ".repeat(300) },
                { "role": "assistant", "content": "old answer ".repeat(300) },
                { "role": "user", "content": "current question" }
            ]
        }),
        json!({
            "agents": { "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "contextWindowTokens": 1200,
                "contextWindowStrategy": "compact",
                "compactTriggerPercent": 80,
                "compactSummaryMaxTokens": 64
            }},
            "providers": { "fixture": {
                "responses": [{ "content": "durable summary" }]
            }}
        }),
    )
    .expect("tool loop should finish");

    let compact_events = result["runtimeEvents"]
        .as_array()
        .expect("events should be present")
        .iter()
        .filter(|event| event["eventName"] == "agent.context.compacted")
        .count();
    assert_eq!(compact_events, 1);
    let contexts = contexts
        .lock()
        .expect("provider context lock should not be poisoned");
    assert_eq!(contexts.len(), 2);
    assert!(contexts[1].iter().any(|message| {
        message["content"]
            .as_str()
            .is_some_and(|content| content.contains("durable summary"))
    }));
    assert!(!contexts[1]
        .iter()
        .any(|message| message.to_string().contains("old context")));
    assert!(result["contextCheckpoint"]["replacementHistory"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|message| message["role"] == "tool")));
}

#[test]
fn agent_usage_event_includes_context_window_budget() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-usage-window",
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

    let usage_event = result["runtimeEvents"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .find(|event| event["eventName"] == "agent.usage")
        .expect("usage event should be present");
    let usage = &usage_event["payload"]["usage"];

    assert_eq!(usage["context_window_tokens"], 100);
    assert!(usage["context_window_remaining_tokens"].is_number());
    assert!(usage["context_window_used_tokens"].is_number());
    assert_eq!(usage_event["payload"]["agentItem"]["type"], "usage");
    assert!(usage_event["payload"]["agentItem"]["providerPayload"]
        .get("contextWindowTokens")
        .is_none());
}

#[test]
fn context_estimate_includes_provider_visible_tool_definitions() {
    let mut without_tools = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({}),
    );
    without_tools.tool_router = NativeToolRouter::new(Vec::new());
    let mut with_tools = without_tools.clone();
    with_tools.tool_router =
        NativeToolRouter::new(test_registry_with_model_tools(&["workspace.read_file"]));

    let estimate_without_tools = estimate_context_tokens_for_request(&without_tools).unwrap();
    let estimate_with_tools = estimate_context_tokens_for_request(&with_tools).unwrap();

    assert!(estimate_with_tools > estimate_without_tools + 500);
}

#[test]
fn context_estimate_uses_the_fully_assembled_provider_request() {
    let replayed_content = "replayed provider context ".repeat(400);
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "apiMode": "responses",
            "turnId": "turn-final-request-estimate",
            "messages": [{ "role": "user", "content": "continue" }],
            "responseItems": [{
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": replayed_content }]
            }]
        }),
        json!({}),
    );
    let request = agent_responses_request(&context).expect("Responses request should assemble");
    let serialized = serde_json::to_string(&request).expect("request should serialize");
    let expected = i64::try_from((serialized.len() + 3) / 4).unwrap();

    assert_eq!(
        estimate_context_tokens_for_request(&context).unwrap(),
        expected
    );
}

#[test]
fn rust_provider_dispatches_the_request_used_for_the_final_estimate() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "provider": "fixture",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        fixture_provider_config("fixture answer"),
    );
    let (request, _) = prepare_provider_request(&context).expect("request should prepare");
    context.set_prepared_provider_request(request);
    context.messages.clear();

    let response = RustNativeAgentProvider
        .complete(&context)
        .expect("provider should dispatch the retained request");

    assert_eq!(response.final_content, "fixture answer");
}

#[test]
fn context_window_uses_whitelisted_model_default_when_unconfigured() {
    for model in [
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "deepseek-v4-pro",
        "glm-5.3",
        "glm-5.3-flash",
    ] {
        let context = AgentTurnContext::from_spec(json!({ "model": model }), json!({}));

        let usage = enrich_usage_with_context_window(&context, json!({}), 10, 0);

        assert_eq!(usage["contextWindowTokens"], 1_000_000, "model: {model}");
    }
}

#[test]
fn context_window_keeps_generic_default_for_unlisted_models() {
    let context = AgentTurnContext::from_spec(json!({ "model": "custom-model" }), json!({}));

    let usage = enrich_usage_with_context_window(&context, json!({}), 10, 0);

    assert_eq!(usage["contextWindowTokens"], 128_000);
}

#[test]
fn legacy_global_context_window_is_only_an_unknown_model_fallback() {
    let context = AgentTurnContext::from_spec(
        json!({ "model": "deepseek-v4-pro" }),
        json!({
            "agents": {
                "defaults": {
                    "contextWindowTokens": 64_000
                }
            }
        }),
    );

    let usage = enrich_usage_with_context_window(&context, json!({}), 10, 0);

    assert_eq!(usage["contextWindowTokens"], 1_000_000);

    let unknown_context = AgentTurnContext::from_spec(
        json!({ "model": "custom-model" }),
        json!({
            "agents": {
                "defaults": {
                    "contextWindowTokens": 64_000
                }
            }
        }),
    );
    let unknown_usage = enrich_usage_with_context_window(&unknown_context, json!({}), 10, 0);
    assert_eq!(unknown_usage["contextWindowTokens"], 64_000);
}

#[test]
fn provider_profile_model_context_window_overrides_automatic_default() {
    let context = AgentTurnContext::from_spec(
        json!({ "model": "deepseek-v4-pro", "provider": "deepseek" }),
        json!({
            "agents": {
                "defaults": {
                    "activeProfile": "deepseek-default",
                    "contextWindowTokens": 128_000
                }
            },
            "providers": {
                "profiles": {
                    "deepseek-default": {
                        "provider": "deepseek",
                        "modelContextWindows": [{
                            "model": "deepseek-v4-pro",
                            "contextWindowTokens": 64_000
                        }]
                    }
                }
            }
        }),
    );

    let usage = enrich_usage_with_context_window(&context, json!({}), 10, 0);

    assert_eq!(usage["contextWindowTokens"], 64_000);
}

#[test]
fn user_file_and_image_parts_emit_typed_reference_items() {
    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-file-references",
            "sessionId": "websocket:chat-file-references",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "Inspect these inputs" },
                    { "type": "file", "path": "D:/workspace/report.md", "mime_type": "text/markdown" },
                    { "type": "image_url", "image_url": { "url": "https://example.invalid/image.png", "detail": "low" } }
                ]
            }]
        }),
    )
    .expect("fixture provider run should succeed");

    let references = result["runtimeEvents"]
        .as_array()
        .expect("events should be present")
        .iter()
        .filter(|event| event["eventName"] == "agent.file.reference")
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 2);
    assert_eq!(
        references[0]["payload"]["agentItem"]["type"],
        "file_reference"
    );
    assert_eq!(
        references[0]["payload"]["agentItem"]["path"],
        "D:/workspace/report.md"
    );
    assert_eq!(
        references[1]["payload"]["agentItem"]["referenceKind"],
        "image"
    );
}

#[test]
fn usage_context_window_prefers_provider_total_tokens() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-total-usage",
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
fn responses_usage_is_normalized_for_existing_usage_consumers() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({}),
    );

    let usage = enrich_usage_with_context_window(
        &context,
        json!({
            "input_tokens": 5,
            "output_tokens": 7,
            "total_tokens": 12
        }),
        9,
        0,
    );

    assert_eq!(usage["prompt_tokens"], 5);
    assert_eq!(usage["promptTokens"], 5);
    assert_eq!(usage["completion_tokens"], 7);
    assert_eq!(usage["completionTokens"], 7);
    assert_eq!(usage["contextWindowUsedTokens"], 12);
}

#[test]
fn agent_usage_event_falls_back_to_estimated_context_when_provider_omits_usage() {
    struct NoUsageProvider;

    impl NativeAgentProvider for NoUsageProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: "no usage answer".to_string(),
                reasoning_delta: None,
                usage: None,
                response_items: Vec::new(),
                tool_calls: Vec::new(),
            })
        }

        fn complete_streaming(
            &self,
            _context: &AgentTurnContext,
            observer: &mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
        ) -> Result<NativeAgentProviderResponse, String> {
            observer(NativeAgentProviderStreamEvent::ContentDelta(
                "no usage answer".to_string(),
            ));
            Ok(NativeAgentProviderResponse {
                final_content: "no usage answer".to_string(),
                reasoning_delta: None,
                usage: None,
                response_items: Vec::new(),
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
            "turnId": "turn-estimated-usage",
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

    let usage_event = result["runtimeEvents"]
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
        "turnId": "turn-status",
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
            && event["payload"]["turnId"] == "turn-status"
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
    assert!(result.get("events").is_none());
}
