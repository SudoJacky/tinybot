use super::*;

#[test]
fn runs_fixture_tool_event_sequence() {
    let services = NativeAgentRuntimeServices::default()
        .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-tool",
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
            context: &AgentTurnContext,
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-tool-loop",
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
fn selected_deferred_tool_calls_are_permitted_by_runtime_dispatch() {
    struct MemorySearchProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for MemorySearchProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
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
            "turnId": "turn-memory-search-tool",
            "sessionId": "websocket:chat-memory-search-tool",
            "maxIterations": 2,
            "selectedTools": ["memory.search"],
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
            _context: &AgentTurnContext,
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
            _context: &AgentTurnContext,
            _tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            panic!("tool runtime should use dispatch_async, not sync dispatch");
        }

        fn dispatch_async(
            self: Arc<Self>,
            _context: AgentTurnContext,
            tool_call: NativeAgentToolCall,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<NativeAgentToolResult, String>> + Send>,
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
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"])),
        json!({
            "runtime": "rust",
            "turnId": "turn-async-dispatch-seam",
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
        WorkerCapability::McpCall,
        WorkerCapability::ShellExecute,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionWrite,
    ]));
    let tools = registry.list_tools().tools;
    let parallel_methods = tools
        .iter()
        .filter(|tool| tool.supports_parallel_tool_calls)
        .map(|tool| tool.method.clone())
        .collect::<Vec<_>>();

    assert_eq!(parallel_methods, vec!["memory.search", "memory.recall"]);
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
        WorkerCapability::McpCall,
        WorkerCapability::ShellExecute,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionWrite,
    ]));
    let tools = registry.list_tools().tools;
    assert!(tools
        .iter()
        .all(|tool| tool.method != "workspace.read_file"));
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

    assert!(!write_file.runtime_policy.supports_parallel_tool_calls);
    assert!(write_file.runtime_policy.waits_for_runtime_cancellation());
    assert_eq!(
        write_file.runtime_policy.cancellation_mode,
        ToolCancellationMode::DetachForbidden
    );
    assert_eq!(write_file.runtime_policy.cleanup_timeout_ms, 2_000);
    assert!(write_file.runtime_policy.mutates_workspace);
    assert!(!write_file.runtime_policy.mutates_session);

    assert!(!shell.runtime_policy.supports_parallel_tool_calls);
    assert!(shell.runtime_policy.waits_for_runtime_cancellation());
    assert_eq!(
        shell.runtime_policy.cancellation_mode,
        ToolCancellationMode::TerminateProcess
    );
    assert_eq!(shell.runtime_policy.cleanup_timeout_ms, 2_000);
    assert!(shell.runtime_policy.mutates_workspace);
    assert!(!shell.runtime_policy.mutates_session);

    assert!(!subagent_spawn.runtime_policy.supports_parallel_tool_calls);
    assert!(subagent_spawn
        .runtime_policy
        .waits_for_runtime_cancellation());
    assert_eq!(
        subagent_spawn.runtime_policy.cancellation_mode,
        ToolCancellationMode::DetachForbidden
    );
    assert_eq!(subagent_spawn.runtime_policy.cleanup_timeout_ms, 2_000);
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
            _context: &AgentTurnContext,
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
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&[
            "workspace.read_file",
            "memory.search",
        ])),
        json!({
            "runtime": "rust",
            "turnId": "turn-read-only-parallel-tools",
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
fn mcp_call_scheduling_uses_registry_runtime_policy() {
    struct TwoMcpToolsThenFinalProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for TwoMcpToolsThenFinalProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
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
            _context: &AgentTurnContext,
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
        )
        .with_test_tool_registry_entries(test_registry_without_approval(&["mcp.call_tool"]))
        .with_test_activated_tools(&["mcp.call_tool"]),
        json!({
            "runtime": "rust",
            "turnId": "turn-read-only-mcp-tools",
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
    assert_eq!(dispatcher.max_running.load(Ordering::SeqCst), 1);
    assert_eq!(mcp_start_modes, vec![json!("write"), json!("write")]);
}

#[test]
fn shell_read_only_allowlist_uses_read_lock_only_when_explicitly_enabled() {
    struct TwoShellReadsThenFinalProvider {
        calls: Mutex<usize>,
    }

    impl NativeAgentProvider for TwoShellReadsThenFinalProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
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
                            name: "exec_command".to_string(),
                            arguments_json: "{\"command\":\"git status\"}".to_string(),
                            result: json!({ "content": "status" }),
                        },
                        NativeAgentToolCall {
                            id: "call-shell-diff".to_string(),
                            name: "exec_command".to_string(),
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
            _context: &AgentTurnContext,
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
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&["exec_command"])),
        json!({
            "runtime": "rust",
            "turnId": "turn-shell-read-allowlist",
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
                && event["payload"]["toolName"] == "exec_command"
                && event["payload"]["status"] == "queued"
        })
        .map(|event| event["payload"]["parallelMode"].clone())
        .collect::<Vec<_>>();

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(dispatcher.max_running.load(Ordering::SeqCst), 2);
    assert_eq!(shell_start_modes, vec![json!("read"), json!("read")]);
}

#[test]
fn parallel_tool_failures_are_returned_to_the_model_in_call_order() {
    struct TwoFailingToolsProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for TwoFailingToolsProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                let tool_messages = context
                    .messages
                    .iter()
                    .filter(|message| message["role"] == "tool")
                    .collect::<Vec<_>>();
                assert_eq!(tool_messages.len(), 2);
                assert_eq!(tool_messages[0]["tool_call_id"], "call-first-fails");
                assert_eq!(tool_messages[1]["tool_call_id"], "call-second-fails");
                assert!(tool_messages[0]["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("call-first-fails failed")));
                assert!(tool_messages[1]["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("call-second-fails failed")));
                return Ok(NativeAgentProviderResponse {
                    final_content: "handled both tool errors".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                });
            }
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
            _context: &AgentTurnContext,
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
            Arc::new(TwoFailingToolsProvider {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(FailingParallelDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&[
            "workspace.read_file",
            "memory.search",
        ])),
        json!({
            "runtime": "rust",
            "turnId": "turn-two-parallel-failures",
            "sessionId": "websocket:chat-two-parallel-failures",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run failing parallel tools" }]
        }),
    )
    .expect("parallel tool failures should be returned to the model");
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

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "handled both tool errors");
    assert!(terminal_errors.is_empty());
    assert!(debug_events.is_empty());
    assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "call-first-fails"
    );
    assert_eq!(
        result["completedToolResults"][1]["toolCallId"],
        "call-second-fails"
    );
    assert!(result["completedToolResults"]
        .as_array()
        .unwrap()
        .iter()
        .all(|result| result["status"] == "error"));
}

#[test]
fn mixed_parallel_and_non_parallel_tool_batch_uses_read_write_lock_scheduling() {
    struct MixedToolsThenFinalProvider {
        seen_messages: Mutex<Vec<Vec<Value>>>,
    }

    impl NativeAgentProvider for MixedToolsThenFinalProvider {
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
                            name: "exec_command".to_string(),
                            arguments_json: "{\"command\":\"echo hi\"}".to_string(),
                            result: json!({ "content": "hi" }),
                        },
                        NativeAgentToolCall {
                            id: "call-read-three".to_string(),
                            name: "memory.recall".to_string(),
                            arguments_json: "{\"query\":\"README\"}".to_string(),
                            result: json!({ "content": "recalled memory" }),
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
            _context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            let is_write = tool_call.name == "exec_command";
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

        fn save_for_turn(&self, session_id: &str, turn_id: &str, checkpoint: Value) {
            self.saved
                .lock()
                .expect("saved checkpoints lock should not be poisoned")
                .push(checkpoint.clone());
            self.inner.save_for_turn(session_id, turn_id, checkpoint);
        }

        fn restore(&self, session_id: &str) -> Option<Value> {
            self.inner.restore(session_id)
        }

        fn restore_for_turn(&self, session_id: &str, turn_id: &str) -> Option<Value> {
            self.inner.restore_for_turn(session_id, turn_id)
        }

        fn clear_for_turn(&self, session_id: &str, turn_id: &str) {
            self.inner.clear_for_turn(session_id, turn_id);
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
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&[
            "workspace.read_file",
            "memory.search",
            "exec_command",
            "memory.recall",
        ])),
        json!({
            "runtime": "rust",
            "turnId": "turn-mixed-tool-batch",
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
            "exec_command",
            "memory.recall"
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
            _context: &AgentTurnContext,
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
                            name: "exec_command".to_string(),
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
            context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            if tool_call.name == "workspace.read_file" {
                self.cancellations.cancel(&context.turn_id);
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
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&[
            "workspace.read_file",
            "exec_command",
        ])),
        json!({
            "runtime": "rust",
            "turnId": "turn-cancel-queued-write",
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
fn returned_failure_before_queued_write_does_not_skip_waiting_tool() {
    struct FailingWriteThenWriteProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for FailingWriteThenWriteProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                let tool_messages = context
                    .messages
                    .iter()
                    .filter(|message| message["role"] == "tool")
                    .collect::<Vec<_>>();
                assert_eq!(tool_messages.len(), 2);
                assert_eq!(tool_messages[0]["tool_call_id"], "call-first-write-fails");
                assert_eq!(tool_messages[1]["tool_call_id"], "call-second-write-waits");
                return Ok(NativeAgentProviderResponse {
                    final_content: "handled write failure".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![
                    NativeAgentToolCall {
                        id: "call-first-write-fails".to_string(),
                        name: "exec_command".to_string(),
                        arguments_json: "{\"command\":\"false\"}".to_string(),
                        result: json!({ "content": "unused first" }),
                    },
                    NativeAgentToolCall {
                        id: "call-second-write-waits".to_string(),
                        name: "exec_command".to_string(),
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
            _context: &AgentTurnContext,
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
            Arc::new(FailingWriteThenWriteProvider {
                calls: AtomicUsize::new(0),
            }),
            dispatcher.clone(),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&["exec_command"])),
        json!({
            "runtime": "rust",
            "turnId": "turn-failed-queued-write",
            "sessionId": "websocket:chat-failed-queued-write",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "fail then continue write" }]
        }),
    )
    .expect("queued write failure should be returned to the model");

    let events = result["events"]
        .as_array()
        .expect("events should be returned");
    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(dispatcher.second_write_dispatches.load(Ordering::SeqCst), 1);
    assert!(events.iter().any(|event| {
        event["eventName"] == "agent.tool.start"
            && event["payload"]["toolCallId"] == "call-second-write-waits"
            && event["payload"]["status"] == "running"
    }));
    assert!(!events
        .iter()
        .any(|event| event["eventName"] == "agent.tool.debug"));
}

#[test]
fn cancellation_during_non_cleanup_parallel_tool_returns_without_waiting_for_late_result() {
    struct SlowReadProvider;

    impl NativeAgentProvider for SlowReadProvider {
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
            context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            self.cancellations.cancel(&context.turn_id);
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
            .with_test_tool_registry_entries(test_registry_with_model_tools(&[
                "workspace.read_file",
                "memory.search",
            ]))
            .with_trace_sink(trace_sink),
            json!({
                "runtime": "rust",
                "turnId": "turn-cancel-slow-read",
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
        cancellation_probe.is_cancelled("turn-cancel-slow-read"),
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
            _context: &AgentTurnContext,
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));
    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-provider-error-after-tool",
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
            "agent.model_call.completed",
            "agent.token_count",
            "agent.usage",
            "agent.error"
        ]
    );
}

#[test]
fn emits_tool_result_envelope_with_legacy_content_projection() {
    let services = NativeAgentRuntimeServices::default()
        .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-tool-envelope",
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
    let services = NativeAgentRuntimeServices::default().with_test_tool_registry_entries(
        test_registry_with_model_tools(&[
            "subagent.spawn",
            "subagent.send_input",
            "subagent.wait",
            "subagent.close",
        ]),
    );
    let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "turnId": "turn-subagent-tools",
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
                                    "argumentsJson": "{\"subagentId\":\"delegate-1\",\"childTurnId\":\"child-1\",\"traceRef\":\"trace-delegate-1\",\"name\":\"Goodall\",\"task\":\"Inspect a bounded topic\"}"
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
    assert_eq!(link_event["payload"]["parentTurnId"], "turn-subagent-tools");
    assert_eq!(link_event["payload"]["delegateId"], "delegate-1");
    assert_eq!(link_event["payload"]["subagentId"], "delegate-1");
    assert_eq!(link_event["payload"]["childTurnId"], "child-1");
    assert_eq!(link_event["payload"]["traceRef"], "trace-delegate-1");
    assert_eq!(link_event["payload"]["sourceToolCallId"], "call-spawn");
    assert_eq!(link_event["payload"]["agentItem"]["type"], "subagent");
    assert_eq!(link_event["payload"]["agentItem"]["agentId"], "delegate-1");
    assert_eq!(link_event["payload"]["agentItem"]["id"], "delegate-1");
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
            context: &AgentTurnContext,
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
                    child_turn_id: None,
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["subagent.spawn"]));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-private-subagent-input",
            "sessionId": "websocket:chat-private-subagent-input",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "start private subagent" }]
        }),
    )
    .expect("subagent turn should complete without leaking private child input");

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
        &NativeAgentRuntimeServices::default().with_test_tool_registry_entries(
            test_registry_with_model_tools(&["workspace.read_file"]),
        ),
        json!({
            "runtime": "rust",
            "turnId": "turn-tool-budget",
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
    let services = NativeAgentRuntimeServices::default().with_test_tool_registry_entries(
        test_registry_with_model_tools(&["workspace.read_file", "memory.search"]),
    );
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-multiple-tools",
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
                                    "id": "call-search",
                                    "name": "memory.search",
                                    "argumentsJson": "{\"query\":\"src\"}",
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
        json!(["workspace.read_file", "memory.search"])
    );
    assert_eq!(tool_results.len(), 2);
    assert_eq!(tool_results[0]["payload"]["toolCallId"], "call-read");
    assert_eq!(tool_results[1]["payload"]["toolCallId"], "call-search");
    assert_eq!(result["finalContent"], "workspace inspected");
}

#[test]
fn later_tool_error_and_earlier_success_are_both_returned_to_the_model() {
    struct TwoToolProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for TwoToolProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                let tool_messages = context
                    .messages
                    .iter()
                    .filter(|message| message["role"] == "tool")
                    .collect::<Vec<_>>();
                assert_eq!(tool_messages.len(), 2);
                assert_eq!(tool_messages[0]["tool_call_id"], "call-first-ok");
                assert_eq!(tool_messages[1]["tool_call_id"], "call-second-fails");
                assert!(tool_messages[1]["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("missing path")));
                return Ok(NativeAgentProviderResponse {
                    final_content: "handled mixed tool results".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                });
            }
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
                        name: "memory.search".to_string(),
                        arguments_json: "{\"query\":\"missing\"}".to_string(),
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
            _context: &AgentTurnContext,
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
            Arc::new(TwoToolProvider {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(FailingSecondToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&[
            "workspace.read_file",
            "memory.search",
        ])),
        json!({
            "runtime": "rust",
            "turnId": "turn-later-tool-error",
            "sessionId": "websocket:chat-later-tool-error",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run two tools" }]
        }),
    )
    .expect("later tool error should be returned to the model");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "handled mixed tool results");
    assert_eq!(
        result["toolsUsed"],
        json!(["workspace.read_file", "memory.search"])
    );
    assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "call-first-ok"
    );
    assert_eq!(
        result["completedToolResults"][1]["toolCallId"],
        "call-second-fails"
    );
    assert_eq!(result["completedToolResults"][1]["status"], "error");
    assert!(!result["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["eventName"] == "agent.error"));
}

#[test]
fn single_tool_dispatch_error_is_returned_to_the_model() {
    struct RecoveringProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for RecoveringProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                assert!(context.messages.iter().any(|message| {
                    message["role"] == "tool"
                        && message["tool_call_id"] == "call-single-fails"
                        && message["content"]
                            .as_str()
                            .is_some_and(|content| content.contains("single tool failed"))
                }));
                return Ok(NativeAgentProviderResponse {
                    final_content: "single tool error handled".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![NativeAgentToolCall {
                    id: "call-single-fails".to_string(),
                    name: "workspace.read_file".to_string(),
                    arguments_json: "{\"path\":\"missing.md\"}".to_string(),
                    result: Value::Null,
                }],
            })
        }
    }

    struct FailingDispatcher;

    impl NativeAgentToolDispatcher for FailingDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            _tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            Err("single tool failed".to_string())
        }
    }

    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            Arc::new(RecoveringProvider {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(FailingDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"])),
        json!({
            "runtime": "rust",
            "turnId": "turn-single-tool-error",
            "sessionId": "session-single-tool-error",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read a missing file" }]
        }),
    )
    .expect("single tool error should be returned to the model");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "single tool error handled");
    assert_eq!(result["completedToolResults"][0]["status"], "error");
    assert!(!result["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["eventName"] == "agent.error"));
}

#[test]
fn rejects_unpermitted_native_tool_with_structured_error_result() {
    let services = NativeAgentRuntimeServices::default();
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-tool-denied",
            "sessionId": "websocket:chat-tool-denied",
            "messages": [{ "role": "user", "content": "run shell" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-denied",
                                "name": "shell.exec",
                                "argumentsJson": "{\"command\":\"rm -rf .\"}",
                                "result": { "content": "denied" }
                            }]
                        },
                        { "content": "permission denial handled" }
                    ]
                }
            }
        }),
    )
    .expect("tool denial should be returned to the model");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "permission denial handled");
    assert_eq!(result["toolsUsed"], json!([]));
    assert!(!result["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["eventName"] == "agent.error"));
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "call-denied"
    );
    assert_eq!(result["completedToolResults"][0]["status"], "error");
}

#[test]
fn reports_provider_and_iteration_errors_as_frontend_events() {
    let provider_error = run_native_agent_turn(json!({
        "runtime": "rust",
        "turnId": "turn-error",
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
        "turnId": "turn-iteration",
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
        &NativeAgentRuntimeServices::default().with_test_tool_registry_entries(
            test_registry_with_model_tools(&["workspace.read_file"]),
        ),
        json!({
            "runtime": "rust",
            "turnId": "turn-max-iterations",
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
fn denied_tool_is_returned_to_the_model_without_tool_dispatch() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-policy-denied",
            "sessionId": "websocket:chat-policy-denied",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "run shell" }]
        }),
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": {
                "fixture": {
                    "responses": [
                        {
                            "content": "",
                            "toolCalls": [{
                                "id": "call-denied",
                                "name": "shell.exec",
                                "argumentsJson": "{\"command\":\"rm -rf .\"}",
                                "result": { "content": "must not execute" }
                            }]
                        },
                        { "content": "policy denial handled" }
                    ]
                }
            }
        }),
    )
    .expect("policy denial should be returned to the model");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "policy denial handled");
    assert_eq!(result["toolsUsed"], json!([]));
    assert!(!event_names(&result).contains(&"agent.error"));
    assert_eq!(
        result["completedToolResults"][0]["toolCallId"],
        "call-denied"
    );
    assert_eq!(result["completedToolResults"][0]["status"], "error");
}

#[test]
fn tool_task_panic_remains_terminal() {
    struct OneToolProvider;

    impl NativeAgentProvider for OneToolProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![NativeAgentToolCall {
                    id: "call-panics".to_string(),
                    name: "workspace.read_file".to_string(),
                    arguments_json: "{\"path\":\"README.md\"}".to_string(),
                    result: Value::Null,
                }],
            })
        }
    }

    struct PanickingToolDispatcher;

    impl NativeAgentToolDispatcher for PanickingToolDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            _tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            panic!("tool task panic");
        }
    }

    let result = run_native_agent_turn_with_services(
        &NativeAgentRuntimeServices::new(
            Arc::new(OneToolProvider),
            Arc::new(PanickingToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"])),
        json!({
            "runtime": "rust",
            "turnId": "turn-tool-task-panic",
            "sessionId": "session-tool-task-panic",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "trigger a tool panic" }]
        }),
    )
    .expect("tool panic should return a structured terminal result");

    assert_eq!(result["stopReason"], "tool_error");
    assert!(result["error"]
        .as_str()
        .is_some_and(|error| error.contains("owned native tool task panicked")));
    assert_eq!(
        result["events"].as_array().unwrap().last().unwrap()["eventName"],
        "agent.error"
    );
}

#[test]
fn cancellation_before_tool_dispatch_stops_without_dispatching_tool() {
    struct CancellingProvider {
        cancellations: Arc<InMemoryNativeAgentCancellation>,
    }

    impl NativeAgentProvider for CancellingProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.cancellations.cancel(&context.turn_id);
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
            _context: &AgentTurnContext,
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-cancel-before-tool",
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
        vec![
            "agent.message.classified",
            "agent.tool_call.delta",
            "agent.cancelled"
        ]
    );
    let cancelled_event = result["events"]
        .as_array()
        .expect("events should be an array")
        .last()
        .expect("cancelled event should be present");
    assert_eq!(cancelled_event["eventName"], "agent.cancelled");
    assert_eq!(
        cancelled_event["payload"]["turnId"],
        "turn-cancel-before-tool"
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
            context: &AgentTurnContext,
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
            context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            self.cancellations.cancel(&context.turn_id);
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-cancellation-context",
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
            _context: &AgentTurnContext,
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
            context: &AgentTurnContext,
            tool_call: &NativeAgentToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            self.cancellations.cancel(&context.turn_id);
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
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));

    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-cancel-after-result",
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
            "agent.message.classified",
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
