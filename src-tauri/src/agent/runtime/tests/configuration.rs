use super::*;

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
fn normalizes_desktop_turn_spec_inputs_for_rust_turns() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-normalized",
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
        .expect("normalized turn spec should produce a chat completion request");
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
fn resolves_profile_based_provider_for_reasoning_turns() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "activeProfile": "deepseek-default",
                    "model": "deepseek-v4-pro",
                    "reasoningEffort": "medium"
                }
            },
            "providers": {
                "profiles": {
                    "deepseek-default": {
                        "provider": "deepseek",
                        "enabled": true,
                        "apiBase": "https://api.deepseek.com",
                        "models": ["deepseek-v4-pro"]
                    }
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context)
        .expect("profile-based provider should declare built-in reasoning support");

    assert_eq!(context.provider.as_deref(), Some("deepseek"));
    assert_eq!(context.settings.provider.as_deref(), Some("deepseek"));
    assert_eq!(request["reasoning_effort"], "medium");
}

#[test]
fn profile_capabilities_override_built_in_provider_defaults() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "activeProfile": "deepseek-default",
                    "model": "deepseek-v4-pro",
                    "reasoningEffort": "medium"
                }
            },
            "providers": {
                "profiles": {
                    "deepseek-default": {
                        "provider": "deepseek",
                        "capabilities": { "reasoning": false }
                    }
                }
            }
        }),
    );

    let error = agent_chat_completion_request(&context)
        .expect_err("explicit profile capabilities should override catalog defaults");

    assert!(error.contains("deepseek"));
    assert!(error.contains("reasoning"));
}

#[test]
fn agent_defaults_apply_temperature_and_max_tokens_to_provider_requests() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "model": "deepseek-v4-pro",
                    "temperature": 0.6,
                    "maxTokens": 2048
                }
            },
            "providers": {
                "profiles": {
                    "deepseek-default": {
                        "provider": "deepseek",
                        "capabilities": ["reasoning"]
                    }
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context)
        .expect("agent defaults should produce a provider request");

    assert_eq!(request["temperature"], json!(0.6));
    assert_eq!(request["max_completion_tokens"], 2048);
}

#[test]
fn defaults_native_agent_turns_to_the_desktop_iteration_limit() {
    let context = AgentTurnContext::from_spec(json!({}), json!({}));

    assert_eq!(context.max_iterations, DEFAULT_NATIVE_AGENT_MAX_ITERATIONS);
    assert_eq!(context.max_iterations, 200);
}

#[test]
fn composed_workspace_instructions_reach_provider_and_reload_user_edits() {
    struct CapturingProvider {
        requests: Arc<Mutex<Vec<Vec<Value>>>>,
        working_directories: Arc<Mutex<Vec<Option<PathBuf>>>>,
    }

    impl NativeAgentProvider for CapturingProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let request = agent_chat_completion_request(context)?;
            self.requests
                .lock()
                .expect("captured requests lock should not be poisoned")
                .push(
                    request["messages"]
                        .as_array()
                        .expect("request messages should be an array")
                        .clone(),
                );
            self.working_directories
                .lock()
                .expect("captured working directories lock should not be poisoned")
                .push(context.settings.working_directory.clone());
            Ok(NativeAgentProviderResponse {
                final_content: "done".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }
    }

    let workspace = SystemPromptWorkspace::new();
    let project_root = workspace.root.join("project");
    let nested_root = project_root.join("nested");
    let working_directory = nested_root.join("task");
    std::fs::create_dir_all(project_root.join(".git")).expect("project marker should create");
    std::fs::create_dir_all(&working_directory).expect("nested project should create");
    std::fs::write(project_root.join("AGENTS.md"), "root project instructions")
        .expect("root project instructions should write");
    std::fs::write(
        nested_root.join("AGENTS.md"),
        "shadowed nested instructions",
    )
    .expect("nested project instructions should write");
    std::fs::write(
        nested_root.join("AGENTS.override.md"),
        "nested override instructions",
    )
    .expect("nested override instructions should write");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let working_directories = Arc::new(Mutex::new(Vec::new()));
    let services = NativeAgentRuntimeServices::new(
        Arc::new(CapturingProvider {
            requests: requests.clone(),
            working_directories: working_directories.clone(),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );

    let default_result = run_native_agent_turn_with_workspace(
        &services,
        json!({
            "turnId": "turn-system-prompt-default",
            "sessionId": "session-system-prompt-default",
            "cwd": working_directory,
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({}),
        &workspace.root,
    )
    .expect("default workspace system prompt run should succeed");

    let custom_template =
        "# Custom system prompt\n\nYou are Inspector.\n\nWorkspace: `{{working_directory}}`\n";
    std::fs::write(
        workspace
            .root
            .join(crate::system_prompt::SYSTEM_PROMPT_FILE_NAME),
        custom_template,
    )
    .expect("custom system prompt should write");

    let custom_result = run_native_agent_turn_with_workspace(
        &services,
        json!({
            "turnId": "turn-system-prompt-custom",
            "sessionId": "session-system-prompt-custom",
            "cwd": working_directory,
            "messages": [{ "role": "user", "content": "hello again" }]
        }),
        json!({}),
        &workspace.root,
    )
    .expect("custom workspace system prompt run should succeed");

    let requests = requests
        .lock()
        .expect("captured requests lock should not be poisoned");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0][0]["role"], "system");
    assert!(requests[0][0]["content"]
        .as_str()
        .expect("default system prompt should be text")
        .contains("You are Tinybot"));
    let default_instructions = requests[0][0]["content"]
        .as_str()
        .expect("default instructions should be text");
    let root_position = default_instructions
        .find("root project instructions")
        .expect("root project instructions should reach the provider");
    let override_position = default_instructions
        .find("nested override instructions")
        .expect("nested override instructions should reach the provider");
    assert!(root_position < override_position);
    assert!(!default_instructions.contains("shadowed nested instructions"));
    assert_eq!(requests[0][1]["content"], "hello");
    assert_eq!(requests[1][0]["role"], "system");
    assert!(requests[1][0]["content"]
        .as_str()
        .expect("custom system prompt should be text")
        .contains("You are Inspector."));
    assert!(requests[1][0]["content"]
        .as_str()
        .expect("custom system prompt should be text")
        .contains(&working_directory.display().to_string()));
    assert!(requests[1][0]["content"]
        .as_str()
        .expect("custom system prompt should be text")
        .contains("You are Tinybot"));
    assert_eq!(requests[1][1]["content"], "hello again");
    assert_eq!(
        *working_directories
            .lock()
            .expect("captured working directories lock should not be poisoned"),
        [
            Some(working_directory.clone()),
            Some(working_directory.clone())
        ]
    );

    for result in [&default_result, &custom_result] {
        assert_eq!(
            result["instructionProvenance"]["workingDirectory"],
            working_directory.display().to_string()
        );
        let sources = result["instructionProvenance"]["sources"]
            .as_array()
            .expect("instruction provenance sources should be visible");
        assert_eq!(sources[0]["kind"], "built_in_identity");
        assert_eq!(sources[1]["kind"], "workspace_system");
        assert_eq!(sources[2]["kind"], "project_agents");
        assert_eq!(sources[3]["kind"], "project_override");
        assert_eq!(sources[4]["kind"], "runtime_environment");
        assert!(sources.iter().all(|source| source["contentHash"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)));
        assert!(result["instructionProvenance"]["contentHash"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64));
    }
}

#[test]
fn context_contributor_ids_must_be_unique() {
    #[derive(Debug)]
    struct DuplicateContributor;

    impl AgentContextContributor for DuplicateContributor {
        fn id(&self) -> &str {
            "test.duplicate"
        }

        fn contribute(
            &self,
            _request: &AgentContextRequest,
        ) -> Result<Option<AgentContextContribution>, String> {
            Ok(None)
        }
    }

    let error = NativeAgentRuntimeServices::new(
        Arc::new(RustNativeAgentProvider),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .try_with_context_contributor(Arc::new(DuplicateContributor))
    .expect("first contributor should register")
    .try_with_context_contributor(Arc::new(DuplicateContributor))
    .err()
    .expect("duplicate context contributor IDs must fail before activation");

    assert!(error.contains("test.duplicate"));
}

#[test]
fn chat_completion_request_exposes_only_foundational_model_tools() {
    let mut context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-tools",
            "sessionId": "websocket:chat-tools",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "read the workspace" }]
        }),
        json!({}),
    );
    let registry = WorkerToolRegistryRpc::new(CapabilityPolicy::new([
        WorkerCapability::FsWorkspaceRead,
        WorkerCapability::BackgroundRead,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
        WorkerCapability::FormRequest,
    ]));
    for method in [
        "subagent.spawn",
        "subagent.send_input",
        "subagent.wait",
        "subagent.close",
        "subagent.resume",
    ] {
        assert_eq!(
            registry.get_tool(method).unwrap().exposure,
            ToolExposure::Deferred
        );
    }
    assert!(registry.get_tool("workspace.read_file").is_none());
    context.tool_router = NativeToolRouter::new(registry.list_tools().tools);

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
    assert!(names.contains(&"update_plan"));
    assert!(names.contains(&"tool_search"));
    assert!(names.contains(&"request_user_input"));
    assert!(!names.contains(&"workspace_read_file"));
    assert!(!names.contains(&"subagent_spawn"));
    assert!(!names.contains(&"subagent_send_input"));
    assert!(!names.contains(&"workspace_write_file"));
    assert!(!names.contains(&"workspace_delete_file"));
    assert!(!names.contains(&"mcp_call_tool"));
    assert!(!names.contains(&"shell_execute"));
    assert!(names.iter().all(|name| name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))));
    assert_eq!(tools[0]["type"], "function");
}

#[cfg(all(windows, feature = "native-browser-runtime"))]
#[test]
fn feature_build_always_exposes_high_level_web_tools() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "turnId": "turn-browser-tools",
            "sessionId": "websocket:chat-browser-tools",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "inspect the shared browser" }]
        }),
        json!({}),
    );

    let request = agent_chat_completion_request(&context)
        .expect("feature build should expose foundational tools");
    let names = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect::<Vec<_>>();

    assert!(!names.contains(&"browser_observe"));
    assert!(!names.contains(&"browser_interact"));
    assert!(names.contains(&"web_open"));
    assert!(names.contains(&"web_read"));
    assert!(names.contains(&"web_act"));
    assert!(names.contains(&"tool_search"));
}

#[test]
fn tool_search_activates_dispatches_and_expires_a_deferred_tool() {
    struct SearchThenFinishProvider {
        requests: Arc<Mutex<Vec<Vec<String>>>>,
        calls: AtomicUsize,
    }

    impl NativeAgentProvider for SearchThenFinishProvider {
        fn complete(
            &self,
            context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let request = agent_chat_completion_request(context)?;
            let tool_names = request["tools"]
                .as_array()
                .expect("provider request tools should be an array")
                .iter()
                .map(|tool| {
                    tool["function"]["name"]
                        .as_str()
                        .expect("provider tool name should be text")
                        .to_string()
                })
                .collect::<Vec<_>>();
            self.requests
                .lock()
                .expect("captured tool requests lock should not be poisoned")
                .push(tool_names);

            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "tool-search-1".to_string(),
                        name: "tool_search".to_string(),
                        arguments_json: r#"{"query":"deferred echo","limit":1}"#.to_string(),
                        result: Value::Null,
                    }],
                }),
                1 => Ok(NativeAgentProviderResponse {
                    final_content: String::new(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: vec![NativeAgentToolCall {
                        id: "deferred-echo-1".to_string(),
                        name: "test.deferred_echo".to_string(),
                        arguments_json: r#"{"text":"hello"}"#.to_string(),
                        result: Value::Null,
                    }],
                }),
                _ => Ok(NativeAgentProviderResponse {
                    final_content: "search complete".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                }),
            }
        }
    }

    struct RecordingDeferredDispatcher {
        dispatched: Arc<Mutex<Vec<String>>>,
    }

    impl NativeAgentToolDispatcher for RecordingDeferredDispatcher {
        fn dispatch(
            &self,
            _context: &AgentTurnContext,
            tool_call: &PreparedToolCall,
        ) -> Result<NativeAgentToolResult, String> {
            if tool_call.name == "tool_search" {
                return Err("tool_search must not reach the normal dispatcher".to_string());
            }
            self.dispatched
                .lock()
                .expect("dispatched tools lock should not be poisoned")
                .push(tool_call.name.clone());
            Ok(NativeAgentToolResult::generic_success(
                tool_call,
                json!({ "echo": "hello" }),
            ))
        }
    }

    let requests = Arc::new(Mutex::new(Vec::new()));
    let dispatched = Arc::new(Mutex::new(Vec::new()));
    let mut registry_entries = WorkerToolRegistryRpc::new(
        crate::protocol::capability::default_desktop_capability_policy(),
    )
    .list_tools()
    .tools;
    registry_entries.push(ToolRegistryEntry {
        tool_id: "test.deferred_echo".to_string(),
        method: "test.deferred_echo".to_string(),
        namespace: "test".to_string(),
        title: "Deferred echo".to_string(),
        description: "Echo text through a deferred read-only test tool.".to_string(),
        exposure: ToolExposure::Deferred,
        dynamic: false,
        supports_parallel_tool_calls: true,
        runtime_policy: ToolRuntimePolicy {
            supports_parallel_tool_calls: true,
            cancellation_mode: ToolCancellationMode::Cooperative,
            cleanup_timeout_ms: 100,
            mutates_workspace: false,
            mutates_session: false,
        },
        required_capabilities: Vec::new(),
        available: true,
        input_schema: json!({
            "type": "object",
            "required": ["text"],
            "properties": { "text": { "type": "string" } }
        }),
        output_schema: json!({ "type": "object" }),
        execution_target: ToolExecutionTarget::WorkerRpc {
            method: "test.deferred_echo".to_string(),
        },
    });
    let services = NativeAgentRuntimeServices::new(
        Arc::new(SearchThenFinishProvider {
            requests: requests.clone(),
            calls: AtomicUsize::new(0),
        }),
        Arc::new(RecordingDeferredDispatcher {
            dispatched: dispatched.clone(),
        }),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_test_tool_registry_entries(registry_entries);

    let result = run_native_agent_turn_with_config(
        &services,
        json!({
            "turnId": "turn-tool-search-activation",
            "sessionId": "session-tool-search-activation",
            "maxIterations": 3,
            "messages": [{ "role": "user", "content": "find a deferred echo tool" }]
        }),
        json!({}),
    )
    .expect("tool search run should complete");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "search complete");
    assert_eq!(
        result["toolsUsed"],
        json!(["tool_search", "test.deferred_echo"])
    );
    assert_eq!(
        result["completedToolResults"][0]["envelope"]["raw"]["tools"][0],
        json!({
            "toolId": "test.deferred_echo",
            "title": "Deferred echo",
            "description": "Echo text through a deferred read-only test tool."
        })
    );
    assert_eq!(
        *dispatched
            .lock()
            .expect("dispatched tools lock should not be poisoned"),
        vec!["test.deferred_echo".to_string()]
    );

    let second_turn = run_native_agent_turn_with_config(
        &services,
        json!({
            "turnId": "turn-tool-search-expired",
            "sessionId": "session-tool-search-expired",
            "maxIterations": 1,
            "messages": [{ "role": "user", "content": "start a fresh turn" }]
        }),
        json!({}),
    )
    .expect("fresh turn should complete without inherited activation");
    assert_eq!(second_turn["stopReason"], "final_response");

    let requests = requests
        .lock()
        .expect("captured tool requests lock should not be poisoned");
    assert_eq!(requests.len(), 4);
    assert!(requests[0].contains(&"tool_search".to_string()));
    assert!(!requests[0].contains(&"test_deferred_echo".to_string()));
    assert!(requests[1].contains(&"test_deferred_echo".to_string()));
    assert!(!requests[3].contains(&"test_deferred_echo".to_string()));
}
