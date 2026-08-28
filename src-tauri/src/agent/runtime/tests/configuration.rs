use super::*;
use crate::agent::runtime::provider_protocol::ProviderProtocolAdapter;

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
fn defaults_context_window_strategy_to_compact() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({}),
    );

    assert_eq!(context.settings.context_window_strategy.as_str(), "compact");
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
fn project_coordinator_profile_has_no_workspace_or_shell_authority() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "model": "fixture-model",
            "metadata": { "permissionProfile": "project-coordinator" },
            "messages": [{ "role": "user", "content": "coordinate the project" }]
        }),
        json!({
            "agents": { "defaults": { "workingDirectory": "D:\\Repos\\default" } }
        }),
    );
    let policy = context
        .settings
        .capability_policy()
        .expect("project coordinator profile should be valid");

    assert_eq!(context.settings.working_directory, None);
    assert!(!policy.allows(&WorkerCapability::FsWorkspaceRead));
    assert!(!policy.allows(&WorkerCapability::FsWorkspaceWrite));
    assert!(!policy.allows(&WorkerCapability::ShellExecute));
    assert!(policy.allows(&WorkerCapability::SessionWrite));
}

#[test]
fn resolves_profile_based_provider_for_reasoning_turns() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "reasoningEffort": "medium",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "activeProfile": "deepseek-default",
                    "model": "deepseek-v4-pro"
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
fn reasoning_summary_still_requires_profile_capability() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "reasoning": { "summary": "auto" },
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "activeProfile": "deepseek-default",
                    "model": "deepseek-v4-pro"
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
        .expect_err("reasoning summaries should retain their capability check");

    assert!(error.contains("deepseek"));
    assert!(error.contains("reasoning"));
}

#[test]
fn legacy_agent_default_reasoning_effort_is_not_applied_to_requests() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "openai",
                    "model": "gpt-test",
                    "reasoningEffort": "high"
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context)
        .expect("legacy reasoning defaults should not require provider capability");

    assert!(context.settings.reasoning.is_none());
    assert!(request.get("reasoning_effort").is_none());
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
fn zai_chat_requests_use_the_documented_parameter_dialect() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "stream": true,
            "reasoningEffort": "medium",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "activeProfile": "zai-default",
                    "model": "glm-5.3",
                    "temperature": 0.6,
                    "maxTokens": 2048
                }
            },
            "providers": {
                "profiles": {
                    "zai-default": {
                        "provider": "zai",
                        "apiBase": "https://open.bigmodel.cn/api/paas/v4"
                    }
                }
            }
        }),
    );

    let request = agent_chat_completion_request(&context)
        .expect("Z.ai request should use its Chat Completions dialect");

    assert_eq!(request["temperature"], json!(0.6));
    assert_eq!(request["max_tokens"], 2048);
    assert_eq!(request["reasoning_effort"], "medium");
    assert!(request.get("max_completion_tokens").is_none());
    assert!(request.get("stream_options").is_none());
}

#[test]
fn zai_rejects_temperature_outside_its_documented_range() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "zai",
                    "model": "glm-5.3",
                    "temperature": 1.1
                }
            }
        }),
    );

    let error = agent_chat_completion_request(&context)
        .expect_err("Z.ai temperature above one should fail before the request is sent");

    assert!(error.contains("zai"));
    assert!(error.contains("temperature"));
}

#[test]
fn zai_profile_rejects_responses_api_mode() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "activeProfile": "zai-default",
                    "model": "glm-5.3"
                }
            },
            "providers": {
                "profiles": {
                    "zai-default": {
                        "provider": "zai",
                        "apiMode": "responses"
                    }
                }
            }
        }),
    );
    let provider_config = agent_provider_config(&context);

    let error = ProviderProtocolAdapter::resolve(&context, &provider_config)
        .expect_err("Z.ai should fail fast when configured for Responses API");

    assert!(error.contains("zai"));
    assert!(error.contains("responses"));
}

#[test]
fn builds_internal_responses_api_request_without_changing_chat_defaults() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "reasoning": { "effort": "high" },
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "agents": {
                "defaults": {
                    "provider": "openai",
                    "model": "gpt-test",
                    "maxTokens": 512
                }
            },
            "providers": {
                "openai": {
                    "api_key": "sk-test",
                    "api_mode": "responses",
                    "capabilities": ["reasoning"]
                }
            }
        }),
    );

    let responses_request =
        agent_responses_request(&context).expect("Responses request should build");
    let chat_request =
        agent_chat_completion_request(&context).expect("Chat request should still build");

    assert_eq!(responses_request["input"][0]["role"], "user");
    assert_eq!(responses_request["store"], false);
    assert_eq!(responses_request["max_output_tokens"], 512);
    assert_eq!(responses_request["reasoning"]["effort"], "high");
    assert!(responses_request.get("messages").is_none());
    assert!(chat_request.get("messages").is_some());
    assert_eq!(chat_request["reasoning_effort"], "high");
    assert!(chat_request.get("input").is_none());
}

#[test]
fn responses_request_replays_native_items_and_keeps_repeated_user_turns() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "apiMode": "responses",
            "responseItems": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "first" }],
                    "messageId": "internal-user-id",
                    "turnId": "turn-1"
                },
                {
                    "type": "reasoning",
                    "id": "reasoning-1",
                    "summary": [],
                    "encrypted_content": "opaque",
                    "turnId": "turn-1"
                },
                {
                    "type": "message",
                    "id": "message-1",
                    "role": "assistant",
                    "phase": "final_answer",
                    "status": "completed",
                    "content": [{ "type": "output_text", "text": "answer" }],
                    "turnId": "turn-1"
                }
            ],
            "messages": [
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "answer" },
                {
                    "role": "user",
                    "content": "first",
                    "references": [{ "referenceKind": "browser", "title": "Example" }]
                }
            ]
        }),
        json!({
            "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
            "providers": { "openai": { "api_key": "sk-test", "api_mode": "chat_completions" } }
        }),
    );

    let request = agent_responses_request(&context).expect("native response history should replay");
    let input = request["input"].as_array().unwrap();

    assert_eq!(input.len(), 4);
    assert_eq!(input[1]["encrypted_content"], "opaque");
    assert_eq!(input[2]["phase"], "final_answer");
    assert_eq!(input[3]["role"], "user");
    assert!(input[3]["content"]
        .as_str()
        .is_some_and(|content| content.starts_with("first\n\n[Attached evidence]")));
    assert!(input[3].get("references").is_none());
    assert_eq!(
        input
            .iter()
            .filter(|item| item.get("role").and_then(Value::as_str) == Some("user"))
            .count(),
        2
    );
    assert!(input[0].get("messageId").is_none());
    assert!(input[1].get("turnId").is_none());
}

#[test]
fn rust_provider_selects_responses_adapter_only_for_internal_api_mode() {
    let context = AgentTurnContext::from_spec(
        json!({
            "runtime": "rust",
            "provider": "fixture",
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        json!({
            "providers": {
                "fixture": {
                    "api_mode": "responses",
                    "responses": [{ "content": "Responses answer" }]
                }
            }
        }),
    );

    let response = RustNativeAgentProvider
        .complete(&context)
        .expect("fixture Responses turn should complete");

    assert_eq!(response.final_content, "Responses answer");
    assert!(!response.response_items.is_empty());
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
                response_items: Vec::new(),
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
        let source_kinds = sources
            .iter()
            .map(|source| source["kind"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            &source_kinds[..5],
            [
                "built_in_identity",
                "workspace_system",
                "workspace_tools",
                "project_agents",
                "project_override",
            ]
        );
        assert_eq!(source_kinds.last(), Some(&"runtime_environment"));
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
fn chat_completion_request_exposes_foundational_and_subagent_model_tools() {
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
            ToolExposure::Model
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
    assert!(!names.contains(&"tool_search"));
    assert!(names.contains(&"publish_data_view"));
    assert!(names.contains(&"request_user_input"));
    assert!(!names.contains(&"workspace_read_file"));
    assert!(names.contains(&"subagent_spawn"));
    assert!(names.contains(&"subagent_send_input"));
    assert!(names.contains(&"subagent_wait"));
    assert!(names.contains(&"subagent_close"));
    assert!(names.contains(&"subagent_resume"));
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
    assert!(!names.contains(&"tool_search"));
}
