use super::*;

#[test]
fn strict_patch_search_and_real_dispatch_work_end_to_end() {
    struct PatchProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for PatchProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: vec![NativeAgentToolCall {
                        id: "apply-patch".to_string(),
                        name: "apply_patch".to_string(),
                        arguments_json: serde_json::to_string(&json!({
                            "patch": "*** Begin Patch\n*** Add File: notes/created.md\n+created by strict patch\n*** End Patch\n"
                        }))
                        .expect("patch arguments should serialize"),
                        result: Value::Null,
                    }],
                }),
                _ => Ok(NativeAgentProviderResponse {
                    final_content: "patch applied".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: Vec::new(),
                }),
            }
        }
    }

    let persistence_workspace = SystemPromptWorkspace::new();
    let turn_workspace = SystemPromptWorkspace::new();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(PatchProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(crate::threads::workspace_store::WorkspaceThreadStore::new(
        persistence_workspace.root.clone(),
        crate::protocol::capability::default_desktop_capability_policy(),
    ));
    let trace_sink = Arc::new(RecordingTraceSink::default());
    let services = crate::agent::bridge::native_agent_services_with_tool_executor(
        services,
        persistence_workspace.root.clone(),
    )
    .expect("workspace thread store should configure the tool executor")
    .with_trace_sink(trace_sink.clone());

    let run_services = services.clone();
    let run_workspace = persistence_workspace.root.clone();
    let turn_working_directory = turn_workspace.root.clone();
    let run = thread::spawn(move || {
        run_native_agent_turn_with_workspace(
            &run_services,
            json!({
                "turnId": "turn-real-patch",
                "sessionId": "session-real-patch",
                "maxIterations": 4,
                "cwd": turn_working_directory,
                "messages": [{ "role": "user", "content": "create the note" }]
            }),
            json!({}),
            &run_workspace,
        )
    });
    let completed = run
        .join()
        .expect("patch run thread should join")
        .expect("patch should dispatch through the original tool future");

    assert_eq!(completed["stopReason"], "final_response");
    assert_eq!(completed["finalContent"], "patch applied");
    assert_eq!(completed["toolsUsed"], json!(["apply_patch"]));
    assert!(
        !persistence_workspace.root.join("notes/created.md").exists(),
        "apply_patch must not write into the thread persistence workspace"
    );
    assert_eq!(
        std::fs::read_to_string(turn_workspace.root.join("notes/created.md"))
            .expect("patch should create the file"),
        "created by strict patch\n"
    );
}

#[test]
fn request_user_input_waits_then_resumes_the_same_tool_chain() {
    struct RequestInputThenReadProvider {
        calls: AtomicUsize,
        resumed_messages: Arc<Mutex<Vec<Value>>>,
    }

    impl NativeAgentProvider for RequestInputThenReadProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: vec![NativeAgentToolCall {
                        id: "clarify-1".to_string(),
                        name: "request_user_input".to_string(),
                        arguments_json: serde_json::to_string(&json!({
                            "title": "Choose a target",
                            "description": "Select the file to inspect.",
                            "fields": [{
                                "name": "target",
                                "type": "select",
                                "label": "Target file",
                                "required": true,
                                "options": [
                                    { "label": "README", "value": "README.md" },
                                    { "label": "Manifest", "value": "Cargo.toml" }
                                ]
                            }]
                        }))
                        .expect("request arguments should serialize"),
                        result: Value::Null,
                    }],
                }),
                1 => {
                    *self
                        .resumed_messages
                        .lock()
                        .expect("resumed messages lock should not be poisoned") =
                        context.messages.clone();
                    Ok(NativeAgentProviderResponse {
                        final_content: String::new(),
                        reasoning_delta: None,
                        usage: None,
                        response_items: Vec::new(),
                        tool_calls: vec![NativeAgentToolCall {
                            id: "read-after-input".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: r#"{"path":"README.md"}"#.to_string(),
                            result: json!({ "content": "workspace read" }),
                        }],
                    })
                }
                _ => Ok(NativeAgentProviderResponse {
                    final_content: "input accepted and file inspected".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: Vec::new(),
                }),
            }
        }
    }

    let resumed_messages = Arc::new(Mutex::new(Vec::new()));
    let services = NativeAgentRuntimeServices::new(
        Arc::new(RequestInputThenReadProvider {
            calls: AtomicUsize::new(0),
            resumed_messages: resumed_messages.clone(),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));

    let waiting = run_native_agent_turn_with_config(
        &services,
        json!({
            "turnId": "turn-user-input",
            "sessionId": "session-user-input",
            "maxIterations": 4,
            "messages": [{ "role": "user", "content": "inspect the right file" }]
        }),
        json!({}),
    )
    .expect("user input request should create a waiting checkpoint");

    assert_eq!(waiting["stopReason"], "awaiting_form");
    assert_eq!(waiting["form"]["form_id"], "user-input:clarify-1");
    assert_eq!(waiting["form"]["title"], "Choose a target");
    assert_eq!(waiting["checkpoint"]["payload"]["kind"], "user_input");
    assert_eq!(
        waiting["checkpoint"]["pendingToolCalls"][0]["toolName"],
        "request_user_input"
    );
    assert!(waiting["checkpoint"]["messages"]
        .as_array()
        .expect("checkpoint messages should be an array")
        .iter()
        .any(|message| message["tool_calls"][0]["id"] == "clarify-1"));
    let mut checkpoint_with_prior_result = waiting["checkpoint"].clone();
    checkpoint_with_prior_result["completedToolResults"] = json!([{
        "toolCallId": "call-before-form",
        "toolName": "workspace.read_file",
        "status": "ok",
        "summary": "completed before form"
    }]);
    services.save_turn_checkpoint(
        "session-user-input",
        "turn-user-input",
        checkpoint_with_prior_result,
    );

    let resumed = run_native_agent_turn_with_config(
        &services,
        json!({
            "turnId": "turn-user-input",
            "sessionId": "session-user-input",
            "maxIterations": 4,
            "metadata": {
                "agentContinuation": {
                    "kind": "form",
                    "formId": "user-input:clarify-1",
                    "action": "submit",
                    "values": { "target": "README.md" }
                }
            }
        }),
        json!({}),
    )
    .expect("submitted user input should resume the provider loop");

    assert_eq!(resumed["stopReason"], "final_response");
    assert_eq!(resumed["finalContent"], "input accepted and file inspected");
    assert_eq!(
        resumed["toolsUsed"],
        json!(["request_user_input", "workspace.read_file"])
    );
    assert_eq!(
        resumed["completedToolResults"]
            .as_array()
            .expect("completed tool results should be an array")
            .iter()
            .map(|result| result["toolCallId"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        vec!["call-before-form", "clarify-1", "read-after-input"]
    );
    assert!(resumed["runtimeEvents"]
        .as_array()
        .expect("runtime events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.form.resolution"));
    let messages = resumed_messages
        .lock()
        .expect("resumed messages lock should not be poisoned");
    assert_eq!(
        messages
            .iter()
            .filter_map(|message| message.get("tool_calls").and_then(Value::as_array))
            .flatten()
            .filter(|call| call.get("id").and_then(Value::as_str) == Some("clarify-1"))
            .count(),
        1,
        "form continuation must preserve exactly one request tool call"
    );
    assert_eq!(
        messages
            .iter()
            .filter(|message| {
                message["role"] == "tool" && message["tool_call_id"] == "clarify-1"
            })
            .count(),
        1,
        "form continuation must append exactly one request tool result"
    );
    let observation = messages
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == "clarify-1")
        .expect("submitted values should become the request_user_input tool result");
    let content: Value = serde_json::from_str(
        observation["content"]
            .as_str()
            .expect("tool observation content should be JSON text"),
    )
    .expect("tool observation content should parse");
    assert_eq!(content["values"]["target"], "README.md");
    assert!(
        services.restore_turn_checkpoint("session-user-input", "turn-user-input")["checkpoint"]
            .is_null()
    );
}

#[test]
fn request_user_input_rejects_invalid_forms_without_waiting() {
    struct InvalidInputProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for InvalidInputProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                assert!(context.messages.iter().any(|message| {
                    message["role"] == "tool"
                        && message["tool_call_id"] == "invalid-form"
                        && message["content"].as_str().is_some_and(|content| {
                            content.contains("fields must contain between 1 and 50 entries")
                        })
                }));
                return Ok(NativeAgentProviderResponse {
                    final_content: "invalid form handled".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: Vec::new(),
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                response_items: Vec::new(),
                tool_calls: vec![NativeAgentToolCall {
                    id: "invalid-form".to_string(),
                    name: "request_user_input".to_string(),
                    arguments_json: r#"{"title":"Missing fields","fields":[]}"#.to_string(),
                    result: Value::Null,
                }],
            })
        }
    }

    let services = NativeAgentRuntimeServices::new(
        Arc::new(InvalidInputProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "turnId": "turn-invalid-user-input",
            "sessionId": "session-invalid-user-input",
            "messages": [{ "role": "user", "content": "ask me" }]
        }),
        json!({}),
    )
    .expect("invalid model tool arguments should be returned to the model");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "invalid form handled");
    assert!(services
        .restore_turn_checkpoint("session-invalid-user-input", "turn-invalid-user-input")
        ["checkpoint"]
        .is_null());
}

#[test]
fn discovered_allowlisted_mcp_tool_is_injected_and_calls_real_server() {
    struct McpDiscoveryProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for McpDiscoveryProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: vec![NativeAgentToolCall {
                        id: "call-real-mcp".to_string(),
                        name: "mcp.4:docs.4:echo".to_string(),
                        arguments_json: r#"{"text":"hello through router"}"#.to_string(),
                        result: Value::Null,
                    }],
                }),
                _ => {
                    assert!(context.messages.iter().any(|message| {
                        message["role"] == "tool"
                            && message["tool_call_id"] == "call-real-mcp"
                            && message["content"]
                                .to_string()
                                .contains("hello through router")
                    }));
                    Ok(NativeAgentProviderResponse {
                        final_content: "real MCP complete".to_string(),
                        reasoning_delta: None,
                        usage: None,
                        response_items: Vec::new(),
                        tool_calls: Vec::new(),
                    })
                }
            }
        }
    }

    let workspace = SystemPromptWorkspace::new();
    let global_before = crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    let script = workspace.root.join("agent-mcp-server.js");
    std::fs::write(
        &script,
        r#"
const readline = require("readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tinybot-agent-mcp", version: "1.0.0" }
    }});
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "echo",
      description: "Echo text from the documentation server.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    }] }});
    return;
  }
  if (message.method === "tools/call") {
    const text = message.params.arguments.text;
    send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text }],
      structuredContent: { echoed: text },
      isError: false
    }});
  }
});
"#,
    )
    .expect("agent MCP fixture should write");
    let config = json!({
        "mcp": { "servers": { "docs": {
            "enabled": true,
            "transport": "stdio",
            "command": "node",
            "args": [script.to_string_lossy()],
            "cwd": workspace.root.to_string_lossy(),
            "timeout_seconds": 5,
            "enabled_tools": ["echo"]
        }}}
    });
    let trace_sink = Arc::new(RecordingTraceSink::default());
    let services = crate::agent::bridge::native_agent_services_with_tool_executor(
        NativeAgentRuntimeServices::new(
            Arc::new(McpDiscoveryProvider {
                calls: AtomicUsize::new(0),
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_thread_store(crate::threads::workspace_store::WorkspaceThreadStore::new(
            workspace.root.clone(),
            crate::protocol::capability::default_desktop_capability_policy(),
        )),
        workspace.root.clone(),
    )
    .expect("workspace thread store should configure the tool executor")
    .with_trace_sink(trace_sink.clone());

    let run_services = services.clone();
    let run_config = config.clone();
    let run_workspace = workspace.root.clone();
    let run = thread::spawn(move || {
        run_native_agent_turn_with_workspace(
            &run_services,
            json!({
                "turnId": "turn-real-mcp-router",
                "sessionId": "session-real-mcp-router",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "echo through docs" }]
            }),
            run_config,
            &run_workspace,
        )
    });
    let completed = run
        .join()
        .expect("MCP run thread should join")
        .expect("dynamic MCP tool should execute through real transport");

    assert_eq!(completed["stopReason"], "final_response");
    assert_eq!(completed["finalContent"], "real MCP complete");
    assert_eq!(completed["toolsUsed"], json!(["mcp.4:docs.4:echo"]));
    tauri::async_runtime::block_on(services.mcp_runtime().shutdown())
        .expect("agent MCP fixture should shut down");
    let global_after = crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    assert!(
        global_after["counters"]["mcp.server.start.completed"]
            .as_u64()
            .unwrap_or_default()
            >= global_before["counters"]["mcp.server.start.completed"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
    );
    assert!(
        global_after["counters"]["mcp.server.stop.completed"]
            .as_u64()
            .unwrap_or_default()
            >= global_before["counters"]["mcp.server.stop.completed"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
    );
}

#[test]
fn backend_selected_deferred_tool_round_trips_through_checkpoint_validation() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "turnId": "turn-tool-search-checkpoint",
            "sessionId": "session-tool-search-checkpoint",
            "messages": [{ "role": "user", "content": "find subagent wait" }]
        }),
        json!({}),
    );
    context.tool_router = NativeToolRouter::new(vec![test_read_only_tool(
        "test.deferred_wait",
        ToolExposure::Deferred,
    )]);
    context
        .tool_router
        .activate_for_turn(&["test.deferred_wait".to_string()])
        .expect("backend-selected deferred wait should activate for the current turn");
    let checkpoint =
        super::checkpoint::checkpoint_value(&context, "awaiting_form", json!({ "iteration": 1 }));

    assert_eq!(
        checkpoint["activatedToolIds"],
        json!(["test.deferred_wait"])
    );
    let cancelled_checkpoint = super::checkpoint::checkpoint_value(
        &context,
        "cancelled",
        json!({ "iteration": 1, "stopReason": "cancelled" }),
    );
    assert_eq!(cancelled_checkpoint["activatedToolIds"], json!([]));

    let mut restored = AgentTurnContext::from_spec(
        json!({
            "turnId": "turn-tool-search-checkpoint",
            "sessionId": "session-tool-search-checkpoint",
            "messages": [{ "role": "user", "content": "continue" }]
        }),
        json!({}),
    );
    restored.tool_router = NativeToolRouter::new(vec![test_read_only_tool(
        "test.deferred_wait",
        ToolExposure::Deferred,
    )]);
    restored
        .tool_router
        .restore_from_checkpoint(&checkpoint)
        .expect("checkpoint activation should restore after registry validation");
    let request = agent_chat_completion_request(&restored)
        .expect("restored provider request should include activated tools");
    let names = request["tools"]
        .as_array()
        .expect("provider tools should be present")
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(names.contains(&"test_deferred_wait"));

    let stale_checkpoint = json!({ "activatedToolIds": ["missing.tool"] });
    let error = AgentTurnContext::from_spec(
        json!({
            "messages": [{ "role": "user", "content": "continue" }]
        }),
        json!({}),
    )
    .tool_router
    .restore_from_checkpoint(&stale_checkpoint)
    .expect_err("stale checkpoint activation must fail explicitly");
    assert!(error.contains("unknown deferred tool ID"));
}

#[test]
fn legacy_checkpoint_accepts_a_tool_now_injected_by_backend_policy() {
    let mut tool = test_read_only_tool("test.backend_selected", ToolExposure::Model);
    tool.available = true;
    let mut router = NativeToolRouter::new(vec![tool]);

    router
        .restore_from_checkpoint(&json!({
            "activatedToolIds": ["test.backend_selected"]
        }))
        .expect("a now-model-visible tool should not invalidate a legacy checkpoint");

    assert!(router.is_permitted("test.backend_selected"));
    assert!(router.activated_tool_ids().is_empty());
}

#[test]
fn duplicate_deferred_tool_activation_fails_without_partial_state() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "turnId": "turn-duplicate-activation",
            "sessionId": "session-duplicate-activation",
            "messages": [{ "role": "user", "content": "find subagent wait" }]
        }),
        json!({}),
    );
    context.tool_router = NativeToolRouter::new(vec![test_read_only_tool(
        "test.deferred_wait",
        ToolExposure::Deferred,
    )]);

    let error = context
        .tool_router
        .activate_for_turn(&[
            "test.deferred_wait".to_string(),
            "test.deferred_wait".to_string(),
        ])
        .expect_err("duplicate activation IDs must fail explicitly");

    assert!(error.contains("duplicate ID"));
    assert!(context.tool_router.activated_tool_ids().is_empty());
}

#[test]
fn provider_tool_name_collisions_fail_before_request_dispatch() {
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::default());
    let mut dotted = registry
        .get_tool("update_plan")
        .expect("update_plan should be registered");
    dotted.tool_id = "test.lookup".to_string();
    dotted.method = "test.lookup".to_string();
    let mut underscored = dotted.clone();
    underscored.tool_id = "test_lookup".to_string();
    underscored.method = "test_lookup".to_string();
    let mut context = AgentTurnContext::from_spec(
        json!({
            "messages": [{ "role": "user", "content": "test collision" }]
        }),
        json!({}),
    );
    context.tool_router = NativeToolRouter::new(vec![dotted, underscored]);

    let error = agent_chat_completion_request(&context)
        .expect_err("provider name collision should fail before dispatch");

    assert!(error.contains("provider tool name collision"));
    assert!(error.contains("test.lookup"));
    assert!(error.contains("test_lookup"));
}

#[test]
fn direct_calls_to_unactivated_deferred_tools_are_rejected() {
    struct DeferredToolProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for DeferredToolProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                assert!(context.messages.iter().any(|message| {
                    message["role"] == "tool"
                        && message["tool_call_id"] == "unactivated-deferred"
                        && message["content"].as_str().is_some_and(|content| {
                            content.contains("not active for this turn")
                                && content.contains("backend tool policy")
                        })
                }));
                return Ok(NativeAgentProviderResponse {
                    final_content: "deferred tool rejection handled".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: Vec::new(),
                });
            }
            Ok(NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                response_items: Vec::new(),
                tool_calls: vec![NativeAgentToolCall {
                    id: "unactivated-deferred".to_string(),
                    name: "test.deferred_echo".to_string(),
                    arguments_json: r#"{"query":"should-not-run"}"#.to_string(),
                    result: Value::Null,
                }],
            })
        }
    }

    struct PanickingDeferredDispatcher;

    impl NativeAgentToolDispatcher for PanickingDeferredDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            _tool_call: &PreparedToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            panic!("unactivated deferred tool must not reach dispatcher");
        }
    }

    let services = NativeAgentRuntimeServices::new(
        Arc::new(DeferredToolProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(PanickingDeferredDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_test_tool_registry_entries(vec![test_read_only_tool(
        "test.deferred_echo",
        ToolExposure::Deferred,
    )]);
    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "turnId": "turn-unactivated-deferred",
            "sessionId": "session-unactivated-deferred",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "guess a shell tool" }]
        }),
        json!({}),
    )
    .expect("policy rejection should be returned to the model");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "deferred tool rejection handled");
    let tool_result = result["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present")
        .iter()
        .find(|event| event["eventName"] == "agent.tool.result")
        .expect("tool result should be present");
    assert_eq!(tool_result["payload"]["toolName"], "test.deferred_echo");
}

#[test]
fn inactive_deferred_provider_names_still_resolve_to_the_registered_method() {
    let router = NativeToolRouter::new(vec![test_read_only_tool(
        "test.deferred_echo",
        ToolExposure::Deferred,
    )]);

    assert_eq!(
        router.resolve_provider_name("test_deferred_echo").unwrap(),
        "test.deferred_echo"
    );
    assert!(!router.is_permitted("test.deferred_echo"));
    assert!(router
        .rejection_reason("test.deferred_echo")
        .contains("backend tool policy"));
}

#[test]
fn tool_batch_dispatches_directly_and_injects_all_results_before_the_next_model_call() {
    struct BatchProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for BatchProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: vec![
                        NativeAgentToolCall {
                            id: "batch-write".to_string(),
                            name: "apply_patch".to_string(),
                            arguments_json: r#"{"patch":"*** Begin Patch\n*** Add File: note.md\n+hello\n*** End Patch\n"}"#.to_string(),
                            result: Value::Null,
                        },
                        NativeAgentToolCall {
                            id: "batch-read".to_string(),
                            name: "workspace.read_file".to_string(),
                            arguments_json: r#"{"path":"note.md"}"#.to_string(),
                            result: Value::Null,
                        },
                    ],
                }),
                _ => {
                    let tool_result_ids = context
                        .messages
                        .iter()
                        .filter(|message| message["role"] == "tool")
                        .filter_map(|message| message["tool_call_id"].as_str())
                        .collect::<Vec<_>>();
                    assert_eq!(tool_result_ids, vec!["batch-write", "batch-read"]);
                    Ok(NativeAgentProviderResponse {
                        final_content: "batch complete".to_string(),
                        reasoning_delta: None,
                        usage: None,
                        response_items: Vec::new(),
                        tool_calls: Vec::new(),
                    })
                }
            }
        }
    }

    struct RecordingBatchDispatcher {
        dispatched: Arc<Mutex<Vec<String>>>,
    }

    impl NativeAgentToolDispatcher for RecordingBatchDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            tool_call: &PreparedToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            self.dispatched
                .lock()
                .expect("dispatched calls lock should not be poisoned")
                .push(tool_call.id.clone());
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                json!({ "content": format!("{} complete", tool_call.id) }),
            ))
        }
    }

    let dispatched = Arc::new(Mutex::new(Vec::new()));
    let services = NativeAgentRuntimeServices::new(
        Arc::new(BatchProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(RecordingBatchDispatcher {
            dispatched: dispatched.clone(),
        }),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_test_tool_registry_entries(test_registry_with_model_tools(&["workspace.read_file"]));
    let run_services = services.clone();
    let run = thread::spawn(move || {
        run_native_agent_turn_with_config(
            &run_services,
            json!({
                "turnId": "turn-tool-batch",
                "sessionId": "session-tool-batch",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "write then read" }]
            }),
            json!({}),
        )
    });

    let result = run
        .join()
        .expect("batch run thread should join")
        .expect("batch should complete in the original run");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "batch complete");
    assert_eq!(
        *dispatched
            .lock()
            .expect("dispatched calls lock should not be poisoned"),
        vec!["batch-write".to_string(), "batch-read".to_string()]
    );
}

#[test]
fn write_tool_dispatches_and_does_not_abort_the_turn() {
    struct DeniedProvider {
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for DeniedProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    response_items: Vec::new(),
                    tool_calls: vec![NativeAgentToolCall {
                        id: "denied-write".to_string(),
                        name: "apply_patch".to_string(),
                        arguments_json: r#"{"patch":"*** Begin Patch\n*** Add File: denied.md\n+no\n*** End Patch\n"}"#.to_string(),
                        result: Value::Null,
                    }],
                });
            }
            assert!(context.messages.iter().any(|message| {
                message["role"] == "tool"
                    && message["tool_call_id"] == "denied-write"
                    && message["content"]
                        .as_str()
                        .is_some_and(|content| content.contains("write complete"))
            }));
            Ok(NativeAgentProviderResponse {
                final_content: "continued after execution".to_string(),
                reasoning_delta: None,
                usage: None,
                response_items: Vec::new(),
                tool_calls: Vec::new(),
            })
        }
    }

    struct SuccessDispatcher;

    impl NativeAgentToolDispatcher for SuccessDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            tool_call: &PreparedToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                json!({ "content": "write complete" }),
            ))
        }
    }

    let trace_sink = Arc::new(RecordingTraceSink::default());
    let services = NativeAgentRuntimeServices::new(
        Arc::new(DeniedProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(SuccessDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_trace_sink(trace_sink.clone());
    let run_services = services.clone();
    let run = thread::spawn(move || {
        run_native_agent_turn_with_config(
            &run_services,
            json!({
                "turnId": "turn-write-tool",
                "sessionId": "session-write-tool",
                "maxIterations": 2,
                "messages": [{ "role": "user", "content": "try a write" }]
            }),
            json!({}),
        )
    });
    let result = run
        .join()
        .expect("tool run thread should join")
        .expect("tool execution should remain recoverable");
    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "continued after execution");
}

#[test]
fn chat_completion_request_enables_parallel_tool_calls_only_when_explicitly_requested() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-parallel-request",
            "sessionId": "websocket:chat-parallel-request",
            "model": "fixture-model",
            "parallelToolCalls": true,
            "messages": [{ "role": "user", "content": "wait for delegated work" }]
        }),
        json!({}),
    );
    let mut tools = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::BackgroundRead,
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]))
    .list_tools()
    .tools;
    let wait_tool = tools
        .iter_mut()
        .find(|tool| tool.tool_id == "subagent.wait")
        .expect("subagent wait should be registered");
    wait_tool.supports_parallel_tool_calls = true;
    wait_tool.runtime_policy.supports_parallel_tool_calls = true;
    context.tool_router = NativeToolRouter::new(tools);
    let enabled_request = agent_chat_completion_request(&context)
        .expect("explicit parallel tool request should build");
    assert_eq!(enabled_request["parallel_tool_calls"], true);

    let mut disabled_context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-parallel-request-disabled",
            "sessionId": "websocket:chat-parallel-request",
            "model": "fixture-model",
            "parallelToolCalls": false,
            "messages": [{ "role": "user", "content": "read and search" }]
        }),
        json!({}),
    );
    disabled_context.tool_router = context.tool_router.clone();
    let disabled_request = agent_chat_completion_request(&disabled_context)
        .expect("disabled parallel tool request should build");
    assert!(disabled_request.get("parallel_tool_calls").is_none());
}

#[test]
fn chat_completion_request_exposes_core_controls_when_no_capability_tools_are_available() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-no-tools",
            "sessionId": "websocket:chat-no-tools",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({}),
    );
    context.tool_router = NativeToolRouter::new(
        WorkerToolRegistryRpc::new(CapabilityPolicy::default())
            .list_tools()
            .tools,
    );

    let request = agent_chat_completion_request(&context)
        .expect("request without available model tools should still be built");

    assert_eq!(request["tools"].as_array().map(Vec::len), Some(1));
    assert_eq!(request["tools"][0]["function"]["name"], "update_plan");
    assert_eq!(request["tool_choice"], "auto");
}

#[test]
fn chat_completion_request_encodes_tool_continuation_names_for_provider() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-tool-continuation",
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
    context.tool_router = NativeToolRouter::new(
        WorkerToolRegistryRpc::new(CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]))
            .list_tools()
            .tools,
    );

    let request =
        agent_chat_completion_request(&context).expect("tool continuation request should be built");

    assert_eq!(request["messages"][0]["tool_calls"][0]["id"], "call-read");
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "workspace_read_file"
    );
    assert_eq!(request["messages"][1]["role"], "tool");
    assert_eq!(request["messages"][1]["tool_call_id"], "call-read");
    assert_eq!(request["messages"][1]["name"], "workspace_read_file");
    assert_eq!(
        request["messages"][1]["content"],
        "{\"content\":\"README body\"}"
    );
}

#[test]
fn provider_tool_call_names_restore_internal_registry_methods() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-provider-tool-name",
            "sessionId": "websocket:chat-provider-tool-name",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "wait for delegated work" }]
        }),
        json!({}),
    );
    context.tool_router = NativeToolRouter::new(
        WorkerToolRegistryRpc::new(CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]))
        .list_tools()
        .tools,
    );
    let completion = json!({
        "choices": [{
            "message": {
                "tool_calls": [{
                    "id": "call-read",
                    "type": "function",
                    "function": {
                            "name": "subagent_wait",
                            "arguments": "{\"subagentIds\":[\"agent-1\"]}"
                    }
                }]
            }
        }]
    });

    let tool_calls = super::provider::chat_completion_tool_calls(&completion, &context)
        .expect("provider tool names should resolve");

    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].name, "subagent.wait");
    assert_eq!(
        tool_calls[0].arguments_json,
        "{\"subagentIds\":[\"agent-1\"]}"
    );
    assert!(tool_calls[0].result.is_null());
}

#[test]
fn typed_agent_history_rejects_unknown_roles_before_provider_dispatch() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "provider": "fixture",
            "model": "fixture-model",
            "messages": [{ "role": "observer", "content": "hidden shape" }]
        }),
        json!({}),
    );

    let error = agent_chat_completion_request(&context)
        .expect_err("unknown history roles must not pass through to provider JSON");

    assert!(error.contains("unsupported agent message role"));
    assert!(error.contains("observer"));
}

#[test]
fn typed_provider_response_rejects_malformed_tool_calls_instead_of_dropping_them() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "run a tool" }]
        }),
        json!({}),
    );
    let completion = json!({
        "choices": [{
            "message": {
                "content": "",
                "tool_calls": [{
                    "id": "call-malformed",
                    "type": "function",
                    "function": { "arguments": "{}" }
                }]
            }
        }]
    });

    let error = super::provider::chat_completion_tool_calls(&completion, &context)
        .expect_err("missing provider tool names must fail explicitly");

    assert!(error.contains("call-malformed"));
    assert!(error.contains("name"));
}

#[test]
fn typed_turn_settings_report_unsupported_provider_features() {
    let unsupported = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "model": "fixture-model",
            "serviceTier": "priority",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": { "defaults": { "activeProfile": "fixture-default" } },
            "providers": {
                "profiles": {
                    "fixture-default": { "provider": "fixture" }
                }
            }
        }),
    );

    let error = agent_chat_completion_request(&unsupported)
        .expect_err("undeclared provider features must not be silently dropped");

    assert!(error.contains("fixture"));
    assert!(error.contains("service_tier"));
}

#[test]
fn typed_turn_settings_encode_declared_provider_features() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "model": "fixture-model",
            "serviceTier": "priority",
            "reasoning": { "effort": "high" },
            "outputSchema": {
                "name": "answer",
                "strict": true,
                "schema": {
                    "type": "object",
                    "properties": { "answer": { "type": "string" } },
                    "required": ["answer"]
                }
            },
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": { "defaults": { "activeProfile": "fixture-default" } },
            "providers": {
                "profiles": {
                    "fixture-default": {
                        "provider": "fixture",
                        "capabilities": {
                            "serviceTier": true,
                            "reasoning": true,
                            "structuredOutput": true
                        }
                    }
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context)
        .expect("declared provider features should encode through typed settings");

    assert_eq!(context.settings.service_tier.as_deref(), Some("priority"));
    assert_eq!(
        context
            .settings
            .reasoning
            .as_ref()
            .and_then(|reasoning| reasoning.effort.as_deref()),
        Some("high")
    );
    assert_eq!(request["service_tier"], "priority");
    assert_eq!(request["reasoning_effort"], "high");
    assert_eq!(request["response_format"]["type"], "json_schema");
    assert_eq!(request["response_format"]["json_schema"]["name"], "answer");
}

#[test]
fn custom_provider_reasoning_effort_defaults_on_for_both_protocols() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "provider": "fixture",
            "model": "fixture-model",
            "reasoning": { "effort": "high" },
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "providers": {
                "profiles": {
                    "fixture-default": {
                        "provider": "fixture",
                        "apiBase": "https://fixture.example.test/v1"
                    }
                }
            }
        }),
    );

    let chat_request = agent_chat_completion_request(&context)
        .expect("custom providers should accept reasoning effort by default");
    let responses_request = agent_responses_request(&context)
        .expect("custom providers should accept Responses reasoning effort by default");

    assert_eq!(chat_request["reasoning_effort"], "high");
    assert_eq!(responses_request["reasoning"]["effort"], "high");
}

#[test]
fn custom_provider_reasoning_effort_can_be_omitted_without_dropping_summary() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "provider": "fixture",
            "model": "fixture-model",
            "reasoning": { "effort": "high", "summary": "auto" },
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "providers": {
                "profiles": {
                    "fixture-default": {
                        "provider": "fixture",
                        "apiBase": "https://fixture.example.test/v1",
                        "supportsReasoningEffort": false,
                        "capabilities": { "reasoning": true }
                    }
                }
            }
        }),
    );

    let chat_request = agent_chat_completion_request(&context)
        .expect("disabled effort should not prevent a declared reasoning summary");
    let responses_request = agent_responses_request(&context)
        .expect("disabled effort should not prevent a declared Responses reasoning summary");

    assert!(chat_request.get("reasoning_effort").is_none());
    assert_eq!(chat_request["reasoning"]["summary"], "auto");
    assert!(responses_request["reasoning"].get("effort").is_none());
    assert_eq!(responses_request["reasoning"]["summary"], "auto");
}

#[test]
fn selected_turn_tools_limit_the_production_provider_registry() {
    #[derive(Clone)]
    struct ToolRegistryProvider {
        definitions: Arc<Mutex<Vec<Vec<String>>>>,
        activated: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl NativeAgentProvider for ToolRegistryProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.definitions
                .lock()
                .expect("tool registry provider lock should not be poisoned")
                .push(
                    context
                        .tool_router
                        .tool_definitions()?
                        .into_iter()
                        .map(|definition| definition.name)
                        .collect(),
                );
            self.activated
                .lock()
                .expect("activated tools lock should not be poisoned")
                .push(context.tool_router.activated_tool_ids());
            Ok(NativeAgentProviderResponse {
                final_content: "selected tools applied".to_string(),
                reasoning_delta: None,
                usage: None,
                response_items: Vec::new(),
                tool_calls: Vec::new(),
            })
        }
    }

    let definitions = Arc::new(Mutex::new(Vec::new()));
    let activated = Arc::new(Mutex::new(Vec::new()));
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ToolRegistryProvider {
            definitions: definitions.clone(),
            activated: activated.clone(),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    let result = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-selected-tools",
            "sessionId": "session-selected-tools",
            "selectedTools": ["subagent.wait"],
            "messages": [{ "role": "user", "content": "wait for delegated work" }]
        }),
    )
    .expect("selected tool should configure the final provider registry");
    run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-selected-apply-patch",
            "sessionId": "session-selected-apply-patch",
            "selectedTools": ["apply_patch"],
            "messages": [{ "role": "user", "content": "prepare one patch tool" }]
        }),
    )
    .expect("selected canonical patch tool should configure the turn");
    let captured = definitions
        .lock()
        .expect("tool registry provider lock should not be poisoned");
    let activated = activated
        .lock()
        .expect("activated tools lock should not be poisoned");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(captured.len(), 2);
    assert_eq!(captured[0].len(), 2);
    assert_eq!(captured[0][0], "update_plan");
    assert_eq!(captured[0][1], "subagent_wait");
    assert!(captured[1].iter().any(|name| name == "update_plan"));
    assert!(activated[0].is_empty());
    assert!(captured[1].iter().any(|name| name == "apply_patch"));
    assert!(activated[1].is_empty());
}

#[test]
fn invalid_turn_policy_stops_before_provider_dispatch() {
    #[derive(Clone)]
    struct CountingProvider {
        calls: Arc<AtomicUsize>,
    }

    impl NativeAgentProvider for CountingProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(NativeAgentProviderResponse {
                final_content: "provider should not run".to_string(),
                reasoning_delta: None,
                usage: None,
                response_items: Vec::new(),
                tool_calls: Vec::new(),
            })
        }
    }

    let calls = Arc::new(AtomicUsize::new(0));
    let services = NativeAgentRuntimeServices::new(
        Arc::new(CountingProvider {
            calls: calls.clone(),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    let invalid_profile = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-invalid-profile",
            "sessionId": "session-invalid-profile",
            "permissionProfile": "remote-worker",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
    )
    .expect_err("unsupported permission profiles must fail explicitly");
    let unknown_tool = run_native_agent_turn_with_services(
        &services,
        json!({
            "runtime": "rust",
            "turnId": "turn-unknown-selected-tool",
            "sessionId": "session-unknown-selected-tool",
            "selectedTools": ["missing.tool"],
            "messages": [{ "role": "user", "content": "use missing tool" }]
        }),
    )
    .expect_err("unknown selected tools must fail explicitly");

    assert!(invalid_profile.contains("permission_profile"));
    assert!(unknown_tool.contains("unknown selected tool"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn invalid_request_stops_before_provider_call() {
    let result = run_native_agent_turn_with_config(
        &NativeAgentRuntimeServices::default(),
        json!({
            "runtime": "rust",
            "turnId": "turn-invalid",
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
        result["runtimeEvents"][0]["payload"]["stopReason"],
        "invalid_request"
    );
}
