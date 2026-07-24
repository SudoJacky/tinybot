use super::*;

#[test]
fn owned_task_runtime_cancels_normal_turn_and_ignores_late_provider_result() {
    struct BlockingOwnedProvider {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl NativeAgentProvider for BlockingOwnedProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.started.send(()).expect("provider start should send");
            self.release
                .lock()
                .expect("provider release lock should not be poisoned")
                .recv()
                .expect("provider release should arrive");
            Ok(NativeAgentProviderResponse {
                final_content: "late provider result".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let (started_sender, started_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(BlockingOwnedProvider {
            started: started_sender,
            release: Mutex::new(release_receiver),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    let runner_services = services.clone();
    let runner = thread::spawn(move || {
        run_native_agent_turn_with_services(
            &runner_services,
            json!({
                "runtime": "rust",
                "turnId": "turn-owned-cancel",
                "sessionId": "session-owned-cancel",
                "messages": [{ "role": "user", "content": "wait" }]
            }),
        )
    });
    started_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("owned provider should start");

    let active = services
        .task_runtime
        .status("turn-owned-cancel")
        .expect("owned turn status should exist");
    assert!(active.active);
    assert_eq!(active.phase, "running");

    let cancellation = services.cancel("turn-owned-cancel");
    let result = runner
        .join()
        .expect("owned runner should not panic")
        .expect("owned cancellation should return a result");
    assert_eq!(cancellation["task"]["state"], "cancel_requested");
    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(services.task_runtime.active_count(), 0);
    assert_eq!(services.task_runtime.draining_count(), 0);

    release_sender
        .send(())
        .expect("provider release should send");
    let cancelled = services
        .task_runtime
        .status("turn-owned-cancel")
        .expect("cancelled turn status should remain");
    assert_eq!(services.task_runtime.draining_count(), 0);
    assert_eq!(cancelled.terminal_outcome.as_deref(), Some("cancelled"));
    assert_eq!(cancelled.late_results_ignored, 0);
}

#[test]
fn cancellation_during_subagent_wait_prevents_followup_model_call() {
    struct SpawnWaitProvider {
        calls: Mutex<u32>,
    }

    impl NativeAgentProvider for SpawnWaitProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
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
            context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let result = self.fallback.dispatch(context, tool_call)?;
            if matches!(tool_call.name.as_str(), "subagent.wait" | "wait_agent") {
                self.cancellations.cancel(&context.turn_id);
            }
            Ok(result)
        }

        fn dispatch_async(
            self: Arc<Self>,
            context: AgentTurnContext,
            tool_call: NativeAgentToolCall,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send>,
        > {
            let result = self.fallback.dispatch(&context, &tool_call);
            if !matches!(tool_call.name.as_str(), "subagent.wait" | "wait_agent") {
                return Box::pin(async move { result });
            }
            let cancellations = self.cancellations.clone();
            let turn_id = context.turn_id.clone();
            Box::pin(async move {
                cancellations.cancel(&turn_id);
                tokio::time::sleep(Duration::from_millis(10)).await;
                result
            })
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&[
        "subagent.spawn",
        "subagent.wait",
    ]));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-cancel-subagent-wait",
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
            context: &AgentTurnContext,
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
            context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let checkpoint = self
                .checkpoints
                .restore(&context.session_id)
                .expect("tool wait checkpoint should be present during tool dispatch");
            assert_eq!(checkpoint["phase"], "tool_running");
            assert_eq!(checkpoint["schemaVersion"], 1);
            assert_eq!(checkpoint["runtime"], "rust");
            assert_eq!(checkpoint["turnId"], context.turn_id);
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));
    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-checkpoint-storage",
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

    services.cancel("turn-cancel-checkpoint");
    let cancelled = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-cancel-checkpoint",
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
fn runtime_checkpoint_store_isolates_same_session_turns() {
    let services = NativeAgentRuntimeServices::default();
    services.save_turn_checkpoint(
        "websocket:chat-1",
        "turn-1",
        json!({
            "sessionId": "websocket:chat-1",
            "turnId": "turn-1",
            "phase": "tool_running"
        }),
    );
    services.save_turn_checkpoint(
        "websocket:chat-1",
        "turn-2",
        json!({
            "sessionId": "websocket:chat-1",
            "turnId": "turn-2",
            "phase": "awaiting_approval"
        }),
    );

    assert_eq!(
        services.restore_turn_checkpoint("websocket:chat-1", "turn-1")["checkpoint"]["turnId"],
        "turn-1"
    );
    assert_eq!(
        services.restore_turn_checkpoint("websocket:chat-1", "turn-2")["checkpoint"]["turnId"],
        "turn-2"
    );

    services.clear_turn_checkpoint("websocket:chat-1", "turn-1");
    assert!(services.restore_turn_checkpoint("websocket:chat-1", "turn-1")["checkpoint"].is_null());
    assert_eq!(
        services.restore_turn_checkpoint("websocket:chat-1", "turn-2")["checkpoint"]["turnId"],
        "turn-2"
    );
}

#[test]
fn runtime_checkpoint_restore_by_session_uses_latest_resumable_turn() {
    let services = NativeAgentRuntimeServices::default();
    services.save_turn_checkpoint(
        "websocket:chat-1",
        "turn-old",
        json!({
            "sessionId": "websocket:chat-1",
            "turnId": "turn-old",
            "phase": "tool_running"
        }),
    );
    services.save_turn_checkpoint(
        "websocket:chat-1",
        "turn-new",
        json!({
            "sessionId": "websocket:chat-1",
            "turnId": "turn-new",
            "phase": "awaiting_form"
        }),
    );

    let restored = services.restore_checkpoint("websocket:chat-1");

    assert_eq!(restored["checkpoint"]["turnId"], "turn-new");
}

#[test]
fn native_turn_projects_core_canonical_timeline_equally_live_and_after_reload() {
    struct AcceptanceProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for AcceptanceProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(NativeAgentProviderResponse {
                    final_content: "I will create the execution plan.".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "acceptance-plan-start".to_string(),
                        name: "update_plan".to_string(),
                        arguments_json: serde_json::to_string(&json!({
                            "plan": [
                                { "step": "Inspect referenced inputs", "status": "in_progress" },
                                { "step": "Report findings", "status": "pending" }
                            ]
                        }))
                        .expect("initial plan arguments should serialize"),
                        result: Value::Null,
                    }],
                }),
                1 => {
                    assert!(context.messages.iter().any(|message| {
                        message["role"] == "tool"
                            && message["tool_call_id"] == "acceptance-plan-start"
                            && message["content"] == "Plan updated"
                    }));
                    Ok(NativeAgentProviderResponse {
                        final_content: "The plan is ready; now I will inspect the file."
                            .to_string(),
                        reasoning_delta: Some("Inspect the referenced inputs".to_string()),
                        usage: Some(json!({
                            "input_tokens": 20,
                            "output_tokens": 4,
                            "total_tokens": 24
                        })),
                        tool_calls: vec![NativeAgentToolCall {
                            id: "acceptance-read".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: r#"{"path":"README.md"}"#.to_string(),
                            result: json!({ "content": "README body" }),
                        }],
                    })
                }
                2 => Ok(NativeAgentProviderResponse {
                    final_content: "The plan is complete; I will summarize the result.".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "acceptance-plan-complete".to_string(),
                        name: "update_plan".to_string(),
                        arguments_json: serde_json::to_string(&json!({
                            "explanation": "Inspection and reporting are complete.",
                            "plan": [
                                { "step": "Inspect referenced inputs", "status": "completed" },
                                { "step": "Report findings", "status": "completed" }
                            ]
                        }))
                        .expect("completed plan arguments should serialize"),
                        result: Value::Null,
                    }],
                }),
                _ => Ok(NativeAgentProviderResponse {
                    final_content: "Core acceptance complete.".to_string(),
                    reasoning_delta: None,
                    usage: Some(json!({
                        "input_tokens": 32,
                        "output_tokens": 8,
                        "total_tokens": 40
                    })),
                    tool_calls: Vec::new(),
                }),
            }
        }
    }

    let sink = Arc::new(RecordingTraceSink::default());
    let events = sink.events.clone();
    let patches = sink.timeline_patches.clone();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(AcceptanceProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]))
    .with_trace_sink(sink);
    let session_id = "websocket:chat-canonical-acceptance";
    let turn_id = "turn-canonical-acceptance";

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": turn_id,
            "sessionId": session_id,
            "metadata": { "clientEventId": "client-canonical-acceptance" },
            "messages": [{
                "id": "user-canonical-acceptance",
                "role": "user",
                "content": [
                    { "type": "text", "text": "Inspect these inputs" },
                    { "type": "file", "path": "README.md", "mime_type": "text/markdown" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,aGVsbG8=", "detail": "low" } }
                ]
            }]
        }),
    )
    .expect("native canonical acceptance run should complete");

    assert_eq!(result["stopReason"], "final_response");
    let recorded_events = events
        .lock()
        .expect("trace events lock should not be poisoned")
        .clone();
    let reloaded = crate::agent::runtime_protocol::project_timeline_snapshot(
        session_id,
        turn_id,
        &recorded_events,
    )
    .expect("native acceptance events should reload into one canonical snapshot");
    let recorded_patches = patches
        .lock()
        .expect("timeline patches lock should not be poisoned")
        .clone();
    let mut live_items = std::collections::BTreeMap::new();
    for patch in &recorded_patches {
        live_items.insert(patch.item.item_id.clone(), patch.item.clone());
    }
    let mut live_items = live_items.into_values().collect::<Vec<_>>();
    live_items.sort_by_key(|item| item.sequence);

    assert_eq!(live_items, reloaded.items);
    assert_eq!(
        recorded_patches.last().map(|patch| patch.snapshot_revision),
        Some(reloaded.snapshot_revision)
    );
    let items =
        serde_json::to_value(&reloaded.items).expect("canonical acceptance items should serialize");
    let items = items
        .as_array()
        .expect("canonical items should be an array");
    let user = items
        .iter()
        .find(|item| item["kind"] == "user_message")
        .expect("canonical user item should exist");
    assert_eq!(user["data"]["content"], "Inspect these inputs");
    assert_eq!(user["data"]["clientEventId"], "client-canonical-acceptance");
    assert_eq!(
        items
            .iter()
            .filter(|item| item["kind"] == "file_reference")
            .count(),
        2
    );
    assert!(items.iter().any(|item| {
        item["kind"] == "reasoning" && item["data"]["summary"] == "Inspect the referenced inputs"
    }));
    assert!(items.iter().any(|item| {
        item["kind"] == "tool_call"
            && item["status"] == "completed"
            && item["data"]["toolCallId"] == "acceptance-read"
    }));
    let plan = items
        .iter()
        .find(|item| item["kind"] == "plan_progress")
        .expect("canonical plan item should exist");
    assert_eq!(plan["itemId"], format!("{turn_id}:plan"));
    assert_eq!(plan["revision"], 2);
    assert_eq!(plan["status"], "completed");
    assert_eq!(plan["data"]["completed"], 2);
    assert_eq!(plan["data"]["total"], 2);
    assert_eq!(plan["data"]["steps"][1]["step"], "Report findings");
    assert_eq!(
        plan["data"]["explanation"],
        "Inspection and reporting are complete."
    );
    assert!(items
        .iter()
        .any(|item| { item["kind"] == "usage" && item["data"]["totalTokens"] == 40 }));
    assert!(items.iter().any(|item| {
        item["kind"] == "assistant_message"
            && item["status"] == "completed"
            && item["data"]["phase"] == "final_answer"
            && item["data"]["content"] == "Core acceptance complete."
    }));
    let assistant_items = items
        .iter()
        .filter(|item| item["kind"] == "assistant_message")
        .collect::<Vec<_>>();
    assert_eq!(assistant_items.len(), 4);
    assert_eq!(
        assistant_items
            .iter()
            .filter(|item| item["data"]["phase"] == "commentary")
            .count(),
        3
    );
    assert_eq!(
        assistant_items
            .iter()
            .filter(|item| item["data"]["phase"] == "final_answer")
            .count(),
        1,
        "completing update_plan must not classify commentary as a final answer"
    );
    let final_sequence = items
        .iter()
        .find(|item| item["kind"] == "assistant_message" && item["data"]["phase"] == "final_answer")
        .and_then(|item| item["sequence"].as_u64())
        .expect("final assistant item should have a sequence");
    assert!(
        final_sequence
            > plan["sequence"]
                .as_u64()
                .expect("plan should have a sequence"),
        "the final answer must follow completed plan progress"
    );
}

#[test]
fn invalid_update_plan_returns_a_tool_error_that_the_model_can_correct() {
    struct RecoveringPlanProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for RecoveringPlanProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "plan-invalid".to_string(),
                        name: "update_plan".to_string(),
                        arguments_json: r#"{"plan":[{"step":"Inspect","status":"pending"}]}"#
                            .to_string(),
                        result: Value::Null,
                    }],
                }),
                1 => {
                    assert!(context.messages.iter().any(|message| {
                        message["role"] == "tool"
                            && message["tool_call_id"] == "plan-invalid"
                            && message["content"]
                                .as_str()
                                .is_some_and(|content| content.contains("exactly one in_progress"))
                    }));
                    Ok(NativeAgentProviderResponse {
                        final_content: String::new(),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: vec![NativeAgentToolCall {
                            id: "plan-corrected".to_string(),
                            name: "update_plan".to_string(),
                            arguments_json: r#"{"plan":[{"step":"Inspect","status":"completed"}]}"#
                                .to_string(),
                            result: Value::Null,
                        }],
                    })
                }
                _ => Ok(NativeAgentProviderResponse {
                    final_content: "Plan corrected.".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                }),
            }
        }
    }

    let services = NativeAgentRuntimeServices::new(
        Arc::new(RecoveringPlanProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-plan-correction",
            "sessionId": "session-plan-correction",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "Use a plan" }]
        }),
    )
    .expect("the provider should correct an invalid plan and complete");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "Plan corrected.");
    assert!(!result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.error"));
    assert!(result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.plan.progress"));
}

#[test]
fn approval_and_form_continuations_fail_without_matching_checkpoints() {
    let services = NativeAgentRuntimeServices::default();
    let approval_error = run_native_agent_turn_with_services(
        &services,
        json!({
            "turnId": "turn-missing-approval-checkpoint",
            "sessionId": "session-missing-approval-checkpoint",
            "metadata": {
                "agentContinuation": {
                    "kind": "approval",
                    "approvalId": "approval-missing",
                    "decision": "approved",
                    "scope": "once"
                }
            }
        }),
    )
    .expect_err("approval continuation must not synthesize success without a checkpoint");
    let form_error = run_native_agent_turn_with_services(
        &services,
        json!({
            "turnId": "turn-missing-form-checkpoint",
            "sessionId": "session-missing-form-checkpoint",
            "metadata": {
                "agentContinuation": {
                    "kind": "form",
                    "formId": "form-missing",
                    "action": "submit",
                    "values": {}
                }
            }
        }),
    )
    .expect_err("form continuation must not synthesize success without a checkpoint");

    assert!(approval_error.contains("matching turn checkpoint"));
    assert!(form_error.contains("matching turn checkpoint"));
}

#[test]
fn queued_user_message_continuation_becomes_next_turn_input() {
    struct RecordingProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for RecordingProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
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
            "turnId": "turn-queued-message",
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
            context: &AgentTurnContext,
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-guided-message",
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
fn provider_stream_observer_emits_live_deltas_without_duplicate_final_delta() {
    struct StreamingProvider;

    impl NativeAgentProvider for StreamingProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
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
            _context: &AgentTurnContext,
            observer: &mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
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
            "turnId": "turn-streaming-provider",
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
    let reasoning_completed = result["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .filter(|event| event["eventName"] == "agent.reasoning.completed")
        .collect::<Vec<_>>();

    assert_eq!(deltas, vec!["Hel", "lo"]);
    assert_eq!(reasoning_deltas, vec!["thinking"]);
    assert_eq!(reasoning_completed.len(), 1);
    assert_eq!(reasoning_completed[0]["payload"]["summary"], "thinking");
    assert_eq!(result["finalContent"], "Hello");
}

#[test]
fn async_provider_is_not_called_when_turn_was_cancelled_before_request() {
    struct CountingProvider(Arc<AtomicUsize>);

    impl NativeAgentProvider for CountingProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(NativeAgentProviderResponse {
                final_content: "must not run".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    tauri::async_runtime::block_on(async {
        let calls = Arc::new(AtomicUsize::new(0));
        let services = NativeAgentRuntimeServices::new(
            Arc::new(CountingProvider(calls.clone())),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        );
        services.cancel("turn-async-cancel-before-request");

        let result = run_native_agent_turn_with_config_async(
            &services,
            json!({
                "runtime": "rust",
                "turnId": "turn-async-cancel-before-request",
                "sessionId": "websocket:chat-async-cancel-before-request",
                "messages": [{ "role": "user", "content": "hello" }]
            }),
            json!({}),
        )
        .await
        .expect("pre-request cancellation should return a structured result");

        assert_eq!(result["stopReason"], "cancelled");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn async_provider_turn_pauses_at_safe_boundary_and_resumes_same_turn() {
    struct BoundaryProvider {
        release: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }

    impl NativeAgentProvider for BoundaryProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            panic!("async provider path should not call blocking completion");
        }

        fn complete_streaming_async<'a>(
            self: Arc<Self>,
            _context: &'a AgentTurnContext,
            _observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<NativeAgentProviderResponse, NativeAgentProviderFailure>,
                    > + Send
                    + 'a,
            >,
        > {
            let started = self
                .started
                .lock()
                .expect("provider start signal lock should not be poisoned")
                .take();
            let release = self
                .release
                .lock()
                .expect("provider release signal lock should not be poisoned")
                .take();
            Box::pin(async move {
                if let Some(started) = started {
                    started.send(()).expect("provider start signal should send");
                }
                release
                    .expect("provider release signal should exist")
                    .await
                    .expect("provider release signal should send");
                Ok(NativeAgentProviderResponse {
                    final_content: "done after resume".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                })
            })
        }
    }

    tauri::async_runtime::block_on(async {
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let trace_sink = Arc::new(RecordingTraceSink::default());
        let recorded_events = trace_sink.events.clone();
        let services = NativeAgentRuntimeServices::new(
            Arc::new(BoundaryProvider {
                release: Mutex::new(Some(release_receiver)),
                started: Mutex::new(Some(started_sender)),
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_trace_sink(trace_sink);
        let run_services = services.clone();
        let run_task = tauri::async_runtime::spawn(async move {
            run_native_agent_turn_with_config_async(
                &run_services,
                json!({
                    "runtime": "rust",
                    "turnId": "turn-safe-boundary-pause",
                    "sessionId": "websocket:chat-safe-boundary-pause",
                    "messages": [{ "role": "user", "content": "pause safely" }]
                }),
                json!({}),
            )
            .await
        });
        started_receiver
            .await
            .expect("provider should enter its request");

        services
            .task_runtime()
            .request_pause("turn-safe-boundary-pause", "command-pause-1")
            .expect("pause request should be accepted");
        release_sender
            .send(())
            .expect("provider release should send");
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if services
                    .task_runtime()
                    .status("turn-safe-boundary-pause")
                    .is_some_and(|status| status.phase == "paused")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("run should pause at a safe boundary before the timeout");
        let paused_status = services
            .task_runtime()
            .status("turn-safe-boundary-pause")
            .expect("paused turn status should exist");
        assert_eq!(paused_status.phase, "paused");
        assert!(paused_status.active);

        services
            .task_runtime()
            .request_resume("turn-safe-boundary-pause", "command-resume-1")
            .expect("resume request should be accepted");
        let result = run_task
            .await
            .expect("owned run task should join")
            .expect("resumed run should complete");
        let events = recorded_events
            .lock()
            .expect("recorded events lock should not be poisoned")
            .clone();

        assert_eq!(result["turnId"], "turn-safe-boundary-pause");
        assert_eq!(result["finalContent"], "done after resume");
        assert!(events.iter().any(|event| {
            event.event_name == "agent.paused" && event.payload["commandId"] == "command-pause-1"
        }));
        assert!(events.iter().any(|event| {
            event.event_name == "agent.resumed" && event.payload["commandId"] == "command-resume-1"
        }));
    });
}

#[test]
fn async_provider_cancellation_after_partial_output_drops_stream_without_late_events() {
    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    struct PendingStreamingProvider {
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        dropped: Arc<AtomicBool>,
    }

    impl NativeAgentProvider for PendingStreamingProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            panic!("async provider path should not call the blocking completion method");
        }

        fn complete_streaming_async<'a>(
            self: Arc<Self>,
            _context: &'a AgentTurnContext,
            observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<NativeAgentProviderResponse, NativeAgentProviderFailure>,
                    > + Send
                    + 'a,
            >,
        > {
            let started = self
                .started
                .lock()
                .expect("provider start signal lock should not be poisoned")
                .take();
            let dropped = self.dropped.clone();
            Box::pin(async move {
                let _drop_signal = DropSignal(dropped);
                observer(NativeAgentProviderStreamEvent::ContentDelta(
                    "first".to_string(),
                ));
                if let Some(started) = started {
                    started.send(()).expect("provider start signal should send");
                }
                std::future::pending::<
                    Result<NativeAgentProviderResponse, NativeAgentProviderFailure>,
                >()
                .await
            })
        }
    }

    tauri::async_runtime::block_on(async {
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let dropped = Arc::new(AtomicBool::new(false));
        let trace_sink = Arc::new(RecordingTraceSink::default());
        let trace_events = trace_sink.events.clone();
        let services = NativeAgentRuntimeServices::new(
            Arc::new(PendingStreamingProvider {
                started: Mutex::new(Some(started_sender)),
                dropped: dropped.clone(),
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_trace_sink(trace_sink);
        let run_services = services.clone();
        let run_task = tauri::async_runtime::spawn(async move {
            run_native_agent_turn_with_config_async(
                &run_services,
                json!({
                    "runtime": "rust",
                    "turnId": "turn-async-stream-cancel",
                    "sessionId": "websocket:chat-async-stream-cancel",
                    "stream": true,
                    "messages": [{ "role": "user", "content": "hello" }]
                }),
                json!({}),
            )
            .await
        });
        started_receiver
            .await
            .expect("provider should emit the first stream delta");

        let cancellation = services.cancel("turn-async-stream-cancel");
        let result = run_task
            .await
            .expect("owned async run task should join")
            .expect("cancelled async run should return a structured result");
        for _ in 0..100 {
            if services.task_runtime().draining_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let events = trace_events
            .lock()
            .expect("trace event lock should not be poisoned")
            .clone();
        let content_deltas = events
            .iter()
            .filter(|event| event.event_name == "agent.delta")
            .map(|event| event.payload["delta"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(cancellation["stopReason"], "cancelled");
        assert_eq!(result["stopReason"], "cancelled");
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(services.task_runtime().active_count(), 0);
        assert_eq!(services.task_runtime().draining_count(), 0);
        assert_eq!(content_deltas, vec!["first"]);
        assert!(!events.iter().any(|event| event.event_name == "agent.done"));
    });
}

#[test]
fn async_provider_failures_keep_distinct_stop_reasons() {
    struct FailingProvider(NativeAgentProviderFailureKind);

    impl NativeAgentProvider for FailingProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            panic!("async provider path should not call the blocking completion method");
        }

        fn complete_streaming_async<'a>(
            self: Arc<Self>,
            _context: &'a AgentTurnContext,
            _observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<NativeAgentProviderResponse, NativeAgentProviderFailure>,
                    > + Send
                    + 'a,
            >,
        > {
            let kind = self.0;
            Box::pin(async move { Err(NativeAgentProviderFailure::new(kind, "provider failed")) })
        }
    }

    tauri::async_runtime::block_on(async {
        let cases = [
            (NativeAgentProviderFailureKind::Cancelled, "cancelled"),
            (
                NativeAgentProviderFailureKind::RequestTimeout,
                "provider_request_timeout",
            ),
            (
                NativeAgentProviderFailureKind::StreamIdleTimeout,
                "provider_stream_idle_timeout",
            ),
            (
                NativeAgentProviderFailureKind::Transport,
                "provider_transport_error",
            ),
            (NativeAgentProviderFailureKind::Provider, "provider_error"),
        ];
        for (index, (kind, expected_stop_reason)) in cases.into_iter().enumerate() {
            let turn_id = format!("turn-async-provider-failure-{index}");
            let services = NativeAgentRuntimeServices::new(
                Arc::new(FailingProvider(kind)),
                Arc::new(FakeNativeAgentToolDispatcher),
                Arc::new(InMemoryNativeAgentCheckpointStore::default()),
                Arc::new(InMemoryNativeAgentCancellation::default()),
            );
            let result = run_native_agent_turn_with_config_async(
                &services,
                json!({
                    "runtime": "rust",
                    "turnId": turn_id,
                    "sessionId": format!("websocket:chat-provider-failure-{index}"),
                    "messages": [{ "role": "user", "content": "hello" }]
                }),
                json!({}),
            )
            .await
            .expect("typed provider failure should return a structured result");

            assert_eq!(result["stopReason"], expected_stop_reason);
        }
    });
}

#[test]
fn hanging_cleanup_tool_batch_times_out_without_hanging_the_owned_turn() {
    struct HangingToolProvider;

    impl NativeAgentProvider for HangingToolProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![
                    NativeAgentToolCall {
                        id: "call-hanging-cleanup".to_string(),
                        name: "test.hanging_cleanup".to_string(),
                        arguments_json: "{}".to_string(),
                        result: Value::Null,
                    },
                    NativeAgentToolCall {
                        id: "call-queued-after-hanging-cleanup".to_string(),
                        name: "test.hanging_cleanup".to_string(),
                        arguments_json: "{}".to_string(),
                        result: Value::Null,
                    },
                ],
            })
        }
    }

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    struct HangingCleanupDispatcher {
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        dropped: Arc<AtomicBool>,
    }

    impl NativeAgentToolDispatcher for HangingCleanupDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            _tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            panic!("hanging cleanup test must use async dispatch");
        }

        fn dispatch_async(
            self: Arc<Self>,
            _context: AgentTurnContext,
            _tool_call: NativeAgentToolCall,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send>,
        > {
            let started = self
                .started
                .lock()
                .expect("hanging dispatcher start lock should not be poisoned")
                .take();
            let dropped = self.dropped.clone();
            Box::pin(async move {
                let _drop_signal = DropSignal(dropped);
                if let Some(started) = started {
                    started.send(()).expect("hanging tool start should send");
                }
                std::future::pending::<Result<NativeAgentToolResult, String>>().await
            })
        }
    }

    tauri::async_runtime::block_on(async {
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let dropped = Arc::new(AtomicBool::new(false));
        let registry = vec![ToolRegistryEntry {
            tool_id: "test.hanging_cleanup".to_string(),
            method: "test.hanging_cleanup".to_string(),
            namespace: "test".to_string(),
            title: "Hanging cleanup".to_string(),
            description: "Exercise bounded owned-tool cleanup.".to_string(),
            exposure: ToolExposure::Model,
            dynamic: false,
            supports_parallel_tool_calls: false,
            runtime_policy: ToolRuntimePolicy {
                supports_parallel_tool_calls: false,
                cancellation_mode: ToolCancellationMode::DetachForbidden,
                cleanup_timeout_ms: 25,
                mutates_workspace: false,
                mutates_session: false,
            },
            required_capabilities: Vec::new(),
            available: true,
            approval: ToolApprovalMetadata {
                required: false,
                scope: None,
                lifetime: None,
            },
            input_schema: json!({ "type": "object" }),
            output_schema: json!({ "type": "object" }),
            execution_target: ToolExecutionTarget::WorkerRpc {
                method: "test.hanging_cleanup".to_string(),
            },
        }];
        let services = NativeAgentRuntimeServices::new(
            Arc::new(HangingToolProvider),
            Arc::new(HangingCleanupDispatcher {
                started: Mutex::new(Some(started_sender)),
                dropped: dropped.clone(),
            }),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_test_tool_registry_entries(registry);
        let run_services = services.clone();
        let started_at = std::time::Instant::now();
        let run_task = tauri::async_runtime::spawn(async move {
            run_native_agent_turn_with_config_async(
                &run_services,
                json!({
                    "runtime": "rust",
                    "turnId": "turn-hanging-tool-cleanup",
                    "sessionId": "session-hanging-tool-cleanup",
                    "maxIterations": 2,
                    "messages": [{ "role": "user", "content": "run hanging tool" }]
                }),
                json!({}),
            )
            .await
        });
        started_receiver
            .await
            .expect("hanging cleanup tool should start");

        let cancellation = services.cancel("turn-hanging-tool-cleanup");
        let result = run_task
            .await
            .expect("owned hanging-tool run should join")
            .expect("cleanup timeout should be a structured run result");

        assert_eq!(cancellation["task"]["state"], "cancel_requested");
        assert_eq!(result["stopReason"], "tool_cleanup_timeout");
        assert!(started_at.elapsed() < Duration::from_secs(1));
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(services.task_runtime().active_count(), 0);
        assert_eq!(services.task_runtime().draining_count(), 0);
        assert!(result["events"]
            .as_array()
            .expect("cleanup timeout events should be an array")
            .iter()
            .any(|event| event["eventName"] == "agent.tool.cleanup_timeout"));
    });
}

#[test]
fn trace_context_and_hook_rewrite_follow_provider_tool_and_completion() {
    struct ToolThenFinalProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for ToolThenFinalProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-traced-hook".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: r#"{"path":"before.md"}"#.to_string(),
                        result: Value::Null,
                    }],
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: "done".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    struct RewriteToolInputHook;

    impl AgentHook for RewriteToolInputHook {
        fn evaluate(&self, invocation: &AgentHookInvocation) -> Result<AgentHookDecision, String> {
            if invocation.stage == AgentHookStage::BeforeToolUse {
                return Ok(AgentHookDecision::ReplaceNormalizedInput {
                    normalized_input: json!({ "path": "after.md" }),
                });
            }
            Ok(AgentHookDecision::Continue)
        }
    }

    struct RecordingDispatcher {
        arguments: Arc<Mutex<Vec<Value>>>,
    }

    impl NativeAgentToolDispatcher for RecordingDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let arguments = serde_json::from_str(&tool_call.arguments_json)
                .expect("hook-rewritten tool input should remain JSON");
            self.arguments
                .lock()
                .expect("tool arguments lock should not be poisoned")
                .push(arguments);
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                json!({ "content": "after" }),
            ))
        }
    }

    let arguments = Arc::new(Mutex::new(Vec::new()));
    let metrics = AgentRuntimeMetrics::isolated();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ToolThenFinalProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(RecordingDispatcher {
            arguments: arguments.clone(),
        }),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]))
    .with_metrics(metrics.clone())
    .with_hook(Arc::new(RewriteToolInputHook));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "requestId": "request-traced-hook",
            "traceId": "trace-traced-hook",
            "threadId": "thread-traced-hook",
            "turnId": "turn-traced-hook",
            "sessionId": "session-traced-hook",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read" }]
        }),
    )
    .expect("traced hook run should complete");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["traceContext"]["requestId"], "request-traced-hook");
    assert_eq!(result["traceContext"]["traceId"], "trace-traced-hook");
    assert_eq!(result["traceContext"]["threadId"], "thread-traced-hook");
    assert_eq!(result["traceContext"]["turnId"], "turn-traced-hook");
    assert_eq!(
        arguments
            .lock()
            .expect("tool arguments lock should not be poisoned")
            .as_slice(),
        [json!({ "path": "after.md" })]
    );
    let runtime_events = result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present");
    assert!(runtime_events
        .iter()
        .any(|event| event["eventName"] == "agent.provider.requested"));
    assert!(runtime_events
        .iter()
        .any(|event| event["eventName"] == "agent.provider.completed"));
    assert!(runtime_events
        .iter()
        .any(|event| event["eventName"] == "agent.hook.decision"));
    assert!(runtime_events.iter().all(|event| {
        event["traceContext"]["traceId"] == "trace-traced-hook"
            && event["traceContext"]["requestId"] == "request-traced-hook"
    }));
    let snapshot = metrics.snapshot();
    assert_eq!(snapshot["counters"]["turn.started"], 1);
    assert_eq!(snapshot["counters"]["turn.completed"], 1);
    assert_eq!(snapshot["counters"]["provider.attempted"], 2);
    assert_eq!(snapshot["counters"]["tool.completed"], 1);
    assert!(snapshot["durations"]["turn.durationMs"]["count"] == 1);
    assert!(snapshot["durations"]["provider.durationMs"]["count"] == 2);
    assert!(snapshot["durations"]["tool.durationMs"]["count"] == 1);
}

#[test]
fn lifecycle_hook_denial_aborts_before_provider_call() {
    struct DenyTurnStartHook;

    impl AgentHook for DenyTurnStartHook {
        fn evaluate(&self, invocation: &AgentHookInvocation) -> Result<AgentHookDecision, String> {
            if invocation.stage == AgentHookStage::TurnStart {
                return Ok(AgentHookDecision::Deny {
                    reason: "blocked by lifecycle policy".to_string(),
                });
            }
            Ok(AgentHookDecision::Continue)
        }
    }

    struct CountingProvider(Arc<AtomicUsize>);

    impl NativeAgentProvider for CountingProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(NativeAgentProviderResponse {
                final_content: "must not run".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let provider_calls = Arc::new(AtomicUsize::new(0));
    let metrics = AgentRuntimeMetrics::isolated();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(CountingProvider(provider_calls.clone())),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_metrics(metrics.clone())
    .with_hook(Arc::new(DenyTurnStartHook));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-hook-denied",
            "sessionId": "session-hook-denied",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
    )
    .expect("hook denial should be a structured terminal result");

    assert_eq!(result["stopReason"], "hook_denied");
    assert_eq!(result["error"], "blocked by lifecycle policy");
    assert_eq!(provider_calls.load(Ordering::SeqCst), 0);
    assert_eq!(metrics.snapshot()["counters"]["turn.aborted"], 1);
}
