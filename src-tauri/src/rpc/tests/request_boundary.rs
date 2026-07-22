use super::*;

#[test]
fn tool_executor_preserves_explicit_parent_run_context() {
    let arguments = tool_executor_arguments_with_context(&ToolExecutorExecuteRequest {
        tool_id: "subagent.spawn".to_string(),
        arguments: json!({
            "sessionKey": "session-parent",
            "parentRunId": "run-parent",
            "task": "Inspect one bounded boundary"
        }),
        thread_id: None,
        run_id: Some("run-parent".to_string()),
        session_id: Some("session-parent".to_string()),
        turn_id: None,
        tool_call_id: Some("call-subagent-spawn".to_string()),
    });

    assert_eq!(arguments["parentRunId"], "run-parent");
    assert!(arguments.get("runId").is_none());
}

#[test]
fn shell_request_uses_configured_defaults_when_call_omits_them() {
    let params: ShellExecuteRequestParams = serde_json::from_value(json!({
        "command": "echo configured"
    }))
    .expect("shell request should deserialize");
    let params = params.into_shell_params(
        None,
        &json!({
            "tools": {
                "exec": { "timeout": 17 },
                "restrictToWorkspace": false
            }
        }),
    );

    assert_eq!(params.timeout, Some(17));
    assert_eq!(params.restrict_to_workspace, Some(false));
}

#[test]
fn disabled_exec_config_rejects_direct_shell_execution() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({ "tools": { "exec": { "enable": false } } }),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );
    let request = WorkerRequest::new(
        "req-disabled-exec",
        "trace-disabled-exec",
        "shell.execute",
        json!({ "command": "echo should-not-run" }),
    )
    .with_trusted_internal();

    let response = router.dispatch(&request);

    assert_eq!(
        response.error.as_ref().map(|error| error.code.clone()),
        Some(crate::protocol::WorkerProtocolErrorCode::CapabilityDenied)
    );
    assert!(response
        .error
        .as_ref()
        .is_some_and(|error| error.message.contains("tools.exec.enable")));
}

#[test]
fn dispatches_workspace_read_file_request() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "hello router");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "workspace.read_file",
        json!({ "path": "notes/today.md" }),
    );

    let response = router.dispatch(&request);

    assert!(response.matches_request(&request));
    assert!(response.error.is_none());
    let result = response.result.expect("read result should be present");
    assert_eq!(result["path"], "notes/today.md");
    assert_eq!(result["contents"], "hello router");
    assert_eq!(result["content"], "hello router");
    assert_eq!(result["content_type"], "text");
    assert_eq!(result["line_start"], serde_json::Value::Null);
    assert_eq!(result["line_end"], serde_json::Value::Null);
    assert_eq!(result["line_total"], serde_json::Value::Null);
    assert_eq!(result["truncated"], false);
    assert!(result["updated_at"].is_string());
}

#[test]
fn dispatches_workspace_write_file_version_conflict() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "current");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::FsWorkspaceWrite,
        ]),
    );
    approve_once(
        &mut router,
        "run-write-conflict",
        "session-1",
        json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md" }
        }),
        "filesystem_write",
        "medium",
        "File write/edit/delete tools can modify workspace state.",
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "stale",
            "session_id": "session-1",
            "expected_updated_at": "2000-01-01T00:00:00+00:00"
        }),
    );

    let response = router.dispatch(&request);

    let error = response.error.expect("stale write should conflict");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(error.message, "version conflict");
    assert_eq!(error.details["path"], "notes/today.md");
    assert!(error.details["updated_at"].is_string());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("notes").join("today.md"))
            .expect("fixture file should still read"),
        "current"
    );
    assert!(response.result.is_none());
}

#[test]
fn dispatches_workspace_apply_patch_request_with_structured_change_summary() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "before\n");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
    );

    let response = router.dispatch(
        &WorkerRequest::new(
            "req-apply-patch",
            "trace-1",
            "workspace.apply_patch",
            json!({
                "patch": "*** Begin Patch\n*** Update File: notes/today.md\n@@\n-before\n+after\n*** Add File: notes/new.md\n+new file\n*** End Patch\n"
            }),
        )
        .with_trusted_internal(),
    );

    assert!(response.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "after\n");
    assert_eq!(fixture.read("notes/new.md"), "new file\n");
    let result = response.result.expect("patch result should be present");
    assert_eq!(result["files_changed"], 2);
    assert_eq!(result["hunks_applied"], 2);
    assert_eq!(result["changed_files"][0]["path"], "notes/today.md");
    assert_eq!(result["changed_files"][0]["operation"], "update");
    assert_eq!(result["changed_files"][1]["path"], "notes/new.md");
    assert_eq!(result["changed_files"][1]["operation"], "add");
}

#[test]
fn workspace_apply_patch_requires_a_matching_approval_grant() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::FsWorkspaceWrite,
        ]),
    );
    let patch = "*** Begin Patch\n*** Add File: notes/today.md\n+approved\n*** End Patch\n";

    let denied = router.dispatch(&WorkerRequest::new(
        "req-apply-patch-denied",
        "trace-1",
        "workspace.apply_patch",
        json!({
            "patch": patch,
            "session_id": "session-1",
            "approval_fingerprint": "apply_patch:notes/today.md",
            "approval_session_fingerprint": "apply_patch:notes/today.md"
        }),
    ));
    assert_eq!(
        denied
            .error
            .expect("patch without approval should fail")
            .code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert!(!fixture.root.join("notes/today.md").exists());

    approve_once(
        &mut router,
        "run-apply-patch",
        "session-1",
        json!({
            "toolName": "apply_patch",
            "arguments": { "patch": patch }
        }),
        "filesystem_write",
        "medium",
        "Workspace file changes require user approval.",
    );

    let allowed = router.dispatch(&WorkerRequest::new(
        "req-apply-patch-allowed",
        "trace-2",
        "workspace.apply_patch",
        json!({
            "patch": patch,
            "session_id": "session-1",
            "approval_fingerprint": "apply_patch:notes/today.md",
            "approval_session_fingerprint": "apply_patch:notes/today.md"
        }),
    ));

    assert!(allowed.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "approved\n");
}

#[test]
fn workspace_apply_patch_rejects_caller_claimed_internal_operation() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-apply-patch-spoofed",
        "trace-1",
        "workspace.apply_patch",
        json!({
            "patch": "*** Begin Patch\n*** Add File: notes/today.md\n+unsafe\n*** End Patch\n",
            "internal_operation": true
        }),
    ));

    assert_eq!(
        response
            .error
            .expect("serialized internal flag must not bypass approval")
            .code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert!(!fixture.root.join("notes/today.md").exists());
}

#[test]
fn dispatches_workspace_create_dir_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-create-dir",
        "trace-1",
        "workspace.create_dir",
        json!({ "path": "skills/planner/scripts" }),
    ));

    assert_eq!(
        response.result,
        Some(json!({ "path": "skills/planner/scripts", "kind": "dir", "created": true }))
    );
    assert!(fixture
        .root
        .join("skills")
        .join("planner")
        .join("scripts")
        .is_dir());
    assert!(response.error.is_none());
}

#[test]
fn dispatches_skills_list_request_with_workspace_precedence() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
        "skills/planner/SKILL.md",
        "---\nname: planner\ndescription: Workspace planner\n---\nWorkspace body",
    );
    fixture.write(
        "builtin-skills/planner/SKILL.md",
        "---\nname: planner\ndescription: Builtin planner\n---\nBuiltin body",
    );
    fixture.write(
        "builtin-skills/tmux/SKILL.md",
        "---\nname: tmux\ndescription: Terminal sessions\n---\nTmux body",
    );
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );
    let request = WorkerRequest::new("req-1", "trace-1", "skills.list", json!({}));

    let response = router.dispatch(&request);

    assert!(response.matches_request(&request));
    assert!(response.error.is_none());
    assert_eq!(
        response.result,
        Some(json!({
            "skills": [
                {
                    "name": "planner",
                    "path": "skills/planner/SKILL.md",
                    "source": "workspace",
                    "content": "---\nname: planner\ndescription: Workspace planner\n---\nWorkspace body"
                },
                {
                    "name": "tmux",
                    "path": "builtin-skills/tmux/SKILL.md",
                    "source": "builtin",
                    "content": "---\nname: tmux\ndescription: Terminal sessions\n---\nTmux body"
                }
            ]
        }))
    );
}

#[test]
fn dispatch_returns_capability_error_response() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "hello router");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::default(),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "workspace.read_file",
        json!({ "path": "notes/today.md" }),
    );

    let response = router.dispatch(&request);

    let error = response.error.expect("response should contain error");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "fs.workspace.read");
    assert!(response.result.is_none());
}

#[test]
fn dispatch_rejects_unknown_method() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );
    let request = WorkerRequest::new("req-1", "trace-1", "shell.execute", json!({}));

    let response = router.dispatch(&request);

    let error = response.error.expect("response should contain error");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(error.details["method"], "shell.execute");
}

#[test]
fn dispatch_rejects_invalid_params() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "workspace.read_file",
        json!({ "missing_path": "notes/today.md" }),
    );

    let response = router.dispatch(&request);

    let error = response.error.expect("response should contain error");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(error.details["method"], "workspace.read_file");
}

#[test]
fn dispatches_config_get_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({ "agents": { "defaults": { "model": "gpt-5" } } }),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ConfigRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "config.get",
        json!({ "path": "agents.defaults.model" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({ "path": "agents.defaults.model", "value": "gpt-5" }))
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_config_snapshot_public_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({
            "providers": {
                "openai": {
                    "provider": "openai",
                    "api_key": "sk-secret"
                }
            }
        }),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ConfigRead]),
    );
    let request = WorkerRequest::new("req-1", "trace-1", "config.snapshot_public", json!({}));

    let response = router.dispatch(&request);

    let provider = response.result.as_ref().unwrap()["value"]["providers"]["openai"]
        .as_object()
        .expect("provider public config should be an object");
    assert!(!provider.contains_key("api_key"));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_config_apply_patch_result_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({
            "agents": { "defaults": { "model": "gpt-5" } },
            "providers": { "openai": { "apiKey": "sk-old-secret" } }
        }),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ConfigRead,
            WorkerCapability::ConfigWrite,
            WorkerCapability::ProviderSecretRead,
        ]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "config.apply_patch_result",
        json!({
            "ok": true,
            "config": {
                "agents": { "defaults": { "model": "gpt-5.1" } },
                "providers": { "openai": { "apiKey": "sk-new-secret" } }
            },
            "updatedFields": ["agents.defaults.model"],
            "sideEffects": {
                "applied": ["providerRuntimeChanged"],
                "restartRequired": [],
                "warnings": []
            },
            "error": null
        }),
    );

    let response = router.dispatch(&request);

    let result = response.result.expect("patch result should return");
    assert_eq!(result["ok"], true);
    assert_eq!(result["updatedFields"], json!(["agents.defaults.model"]));
    assert_eq!(
        result["sideEffects"]["applied"],
        json!(["providerRuntimeChanged"])
    );
    assert_eq!(result["config"]["agents"]["defaults"]["model"], "gpt-5.1");
    assert!(result
        .get("config")
        .and_then(|config| config.get("providers"))
        .and_then(|providers| providers.get("openai"))
        .and_then(|provider| provider.get("apiKey"))
        .is_none());
    assert!(response.error.is_none());

    let get_response = router.dispatch(&WorkerRequest::new(
        "req-2",
        "trace-2",
        "config.get",
        json!({ "path": "agents.defaults.model" }),
    ));
    assert_eq!(
        get_response.result,
        Some(json!({ "path": "agents.defaults.model", "value": "gpt-5.1" }))
    );

    let secret_response = router.dispatch(&WorkerRequest::new(
        "req-3",
        "trace-3",
        "provider.resolve_secret",
        json!({ "providerId": "openai", "apiKeyEnvVars": ["OPENAI_API_KEY"] }),
    ));
    assert_eq!(
        secret_response.result,
        Some(json!({
            "apiKey": "sk-new-secret",
            "apiKeySource": "config"
        }))
    );
    assert!(secret_response.error.is_none());
}

#[test]
fn dispatches_config_apply_patch_result_to_config_store() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join("tinybot-config.json");
    let store = crate::config::store::ConfigStore::from_snapshot(
        config_path.clone(),
        json!({
            "agents": { "defaults": { "model": "gpt-5" } },
            "providers": { "openai": { "apiKey": "sk-old-secret" } }
        }),
    );
    let mut router = WorkerRpcRouter::with_config_store(
        fixture.root.clone(),
        store,
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ConfigRead, WorkerCapability::ConfigWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-1",
        "trace-1",
        "config.apply_patch_result",
        json!({
            "ok": true,
            "config": {
                "agents": { "defaults": { "model": "gpt-5.2" } },
                "providers": { "openai": { "apiKey": "sk-new-secret" } }
            },
            "updatedFields": ["agents.defaults.model"],
            "sideEffects": {
                "applied": ["providerRuntimeChanged"],
                "restartRequired": [],
                "warnings": []
            },
            "error": null
        }),
    ));

    let result = response.result.expect("stored patch result should return");
    assert_eq!(result["ok"], true);
    assert_eq!(result["config"]["agents"]["defaults"]["model"], "gpt-5.2");
    assert!(result
        .get("config")
        .and_then(|config| config.get("providers"))
        .and_then(|providers| providers.get("openai"))
        .and_then(|provider| provider.get("apiKey"))
        .is_none());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(config_path).expect("patched config should save")
        )
        .expect("saved config should be JSON"),
        json!({
            "agents": { "defaults": { "model": "gpt-5.2" } },
            "providers": { "openai": { "apiKey": "sk-new-secret" } }
        })
    );

    let get_response = router.dispatch(&WorkerRequest::new(
        "req-2",
        "trace-2",
        "config.get",
        json!({ "path": "agents.defaults.model" }),
    ));
    assert_eq!(
        get_response.result,
        Some(json!({ "path": "agents.defaults.model", "value": "gpt-5.2" }))
    );
}

#[test]
fn dispatches_config_apply_operations_to_config_store() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join("tinybot-config.json");
    let mut store = crate::config::store::ConfigStore::from_snapshot(
        config_path.clone(),
        json!({
            "agents": { "defaults": { "model": "gpt-5", "timezone": "UTC" } },
            "providers": { "openai": { "api_key": "sk-old-secret" } }
        }),
    );
    store
        .save_snapshot()
        .expect("fixture config should be saved before operation dispatch");
    let revision = store.revision();
    let mut router = WorkerRpcRouter::with_config_store(
        fixture.root.clone(),
        store,
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ConfigRead, WorkerCapability::ConfigWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-1",
        "trace-1",
        "config.apply_operations",
        json!({
            "expectedRevision": revision,
            "operations": [
                {
                    "op": "replace",
                    "path": "agents.defaults.timezone",
                    "value": "Asia/Shanghai"
                }
            ]
        }),
    ));

    let result = response.result.expect("operation result should return");
    assert_eq!(result["ok"], true);
    assert_eq!(result["updatedFields"], json!(["agents.defaults.timezone"]));
    assert_eq!(
        result["config"]["providers"]["openai"]["api_key_configured"],
        true
    );
    assert!(result["config"]["providers"]["openai"]
        .get("api_key")
        .is_none());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(config_path).expect("patched config should save")
        )
        .expect("saved config should be JSON")["providers"]["openai"]["api_key"],
        "sk-old-secret"
    );
    assert!(response.error.is_none());
}

#[test]
fn config_store_patch_result_requires_write_capability_before_save() {
    let fixture = WorkspaceFixture::new();
    let config_path = fixture.root.join("tinybot-config.json");
    let store = crate::config::store::ConfigStore::from_snapshot(
        config_path.clone(),
        json!({
            "agents": { "defaults": { "model": "gpt-5" } }
        }),
    );
    let mut router = WorkerRpcRouter::with_config_store(
        fixture.root.clone(),
        store,
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ConfigRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-1",
        "trace-1",
        "config.apply_patch_result",
        json!({
            "ok": true,
            "config": {
                "agents": { "defaults": { "model": "gpt-5.2" } }
            },
            "updatedFields": ["agents.defaults.model"],
            "sideEffects": {
                "applied": ["providerRuntimeChanged"],
                "restartRequired": [],
                "warnings": []
            },
            "error": null
        }),
    ));

    let error = response.error.expect("response should contain error");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "config.write");
    assert!(
        !config_path.exists(),
        "denied config patch must not create or save config"
    );
}

#[test]
fn dispatches_provider_resolve_secret_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({
            "providers": {
                "profiles": {
                    "dashscope-search": {
                        "provider": "dashscope",
                        "api_key": "profile-secret"
                    }
                }
            }
        }),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ProviderSecretRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "provider.resolve_secret",
        json!({
            "providerId": "dashscope",
            "profileName": "dashscope-search",
            "apiKeyEnvVars": ["DASHSCOPE_API_KEY"]
        }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "apiKey": "profile-secret",
            "apiKeySource": "config"
        }))
    );
    assert!(response.error.is_none());
}
