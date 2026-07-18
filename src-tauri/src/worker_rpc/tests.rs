use super::ShellExecuteRequestParams;
use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_permission_profile::PermissionEvaluateToolRequest;
use crate::worker_protocol::{WorkerRequest, WorkerRequestCancellation};
use crate::worker_rpc::WorkerRpcRouter;
use crate::worker_shell::WorkerShellRuntime;
use crate::worker_subagent_manager::{SubagentSpawnParams, SubagentThreadManager};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

static WORKSPACE_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

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
        Some(crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied)
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
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
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
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
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
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
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
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
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
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
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
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
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
    let store = crate::config_store::ConfigStore::from_snapshot(
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
    let mut store = crate::config_store::ConfigStore::from_snapshot(
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
    let store = crate::config_store::ConfigStore::from_snapshot(
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
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
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

#[test]
fn dispatches_session_get_metadata_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_metadata",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(response.result.as_ref().unwrap()["session_id"], "session-1");
    assert_eq!(
        response.result.as_ref().unwrap()["title"],
        "Native Core Migration"
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_list_metadata_includes_thread_only_sessions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-list-thread-create",
        "trace-session-list-thread",
        "thread.create",
        json!({
            "threadId": "thread-only-session",
            "title": "Thread Only Session",
            "sessionKey": "thread-session-1",
            "metadata": {
                "workingDirectory": "D:/code/tinybot/workspace",
                "lastActivityAt": "2026-07-05T03:00:00Z",
                "preview": "Thread-only preview"
            },
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-session-list-thread",
        "trace-session-list-thread",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(response.error, None);
    let sessions = response.result.as_ref().unwrap().as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["session_id"], "thread-session-1");
    assert_eq!(sessions[0]["title"], "Thread Only Session");
    assert_eq!(sessions[0]["workspace_dir"], "D:/code/tinybot/workspace");
    assert_eq!(sessions[0]["updated_at"], "2026-07-05T03:00:00Z");
    assert_eq!(sessions[0]["extra"]["threadId"], "thread-only-session");
    assert_eq!(sessions[0]["extra"]["source"], "thread.metadata_projection");
    assert_eq!(sessions[1]["session_id"], "session-1");
}

#[test]
fn thread_status_does_not_project_legacy_sessions_at_request_time() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );

    let list = router.dispatch(&WorkerRequest::new(
        "req-legacy-status-list",
        "trace-legacy-status",
        "thread.list",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()["threads"], json!([]));
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_none());
}

#[test]
fn dispatches_session_get_metadata_and_history_for_thread_only_sessions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-create",
        "trace-session-get-thread",
        "thread.create",
        json!({
            "threadId": "thread-backed-session",
            "title": "Thread Backed Session",
            "sessionKey": "thread-backed-session-key",
            "metadata": {
                "workingDirectory": "D:/code/tinybot/thread",
                "lastActivityAt": "2026-07-05T04:00:00Z"
            },
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-append",
        "trace-session-get-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-backed-session",
            "items": [
                {
                    "itemId": "thread-backed-session:item:user",
                    "threadId": "",
                    "runId": "run-thread-backed",
                    "turnId": "turn-thread-backed",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "content": "old UI opens thread-backed session" }
                    }
                },
                {
                    "itemId": "thread-backed-session:item:assistant",
                    "threadId": "",
                    "runId": "run-thread-backed",
                    "turnId": "turn-thread-backed",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:02Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": { "content": "thread history is projected" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let metadata = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-metadata",
        "trace-session-get-thread",
        "session.get_metadata",
        json!({ "session_id": "thread-backed-session-key" }),
    ));
    assert_eq!(metadata.error, None);
    assert_eq!(
        metadata.result.as_ref().unwrap()["session_id"],
        "thread-backed-session-key"
    );
    assert_eq!(
        metadata.result.as_ref().unwrap()["title"],
        "Thread Backed Session"
    );
    assert_eq!(
        metadata.result.as_ref().unwrap()["extra"]["threadId"],
        "thread-backed-session"
    );

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-history",
        "trace-session-get-thread",
        "session.get_history",
        json!({ "session_id": "thread-backed-session-key" }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["session_id"],
        "thread-backed-session-key"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["role"],
        "user"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["content"],
        "old UI opens thread-backed session"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["role"],
        "assistant"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["content"],
        "thread history is projected"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["updated_at"],
        "2026-07-05T04:00:02Z"
    );
}

#[test]
fn dispatches_session_get_agent_context_from_latest_thread_compaction() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-agent-context-thread-create",
        "trace-agent-context-thread",
        "thread.create",
        json!({
            "threadId": "thread-agent-context",
            "title": "Agent Context",
            "sessionKey": "session-agent-context",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-agent-context-thread-append",
        "trace-agent-context-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-agent-context",
            "items": [
                {
                    "itemId": "thread-agent-context:old-user",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "content": "old user message" }
                    }
                },
                {
                    "itemId": "thread-agent-context:old-assistant",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:02Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": { "content": "old assistant message" }
                    }
                },
                {
                    "itemId": "thread-agent-context:compaction",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:03Z",
                    "kind": {
                        "type": "context_compaction",
                        "payload": {
                            "payload": {
                                "contextCheckpoint": {
                                    "installedReplacementHistory": [
                                        { "role": "assistant", "content": "summary of old conversation" }
                                    ],
                                    "replacementHistory": [
                                        { "role": "assistant", "content": "summary of old conversation" },
                                        {
                                            "role": "assistant",
                                            "content": "",
                                            "tool_calls": [{
                                                "id": "context-read-1",
                                                "type": "function",
                                                "function": {
                                                    "name": "workspace.read_file",
                                                    "arguments": "{\"path\":\"README.md\"}"
                                                }
                                            }]
                                        },
                                        {
                                            "role": "tool",
                                            "tool_call_id": "context-read-1",
                                            "name": "workspace.read_file",
                                            "content": "README contents"
                                        },
                                        { "role": "assistant", "content": "answer from compacted turn" }
                                    ]
                                }
                            }
                        }
                    }
                },
                {
                    "itemId": "thread-agent-context:compacted-answer",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:04Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": { "content": "answer from compacted turn" }
                    }
                },
                {
                    "itemId": "thread-agent-context:new-user",
                    "threadId": "",
                    "runId": "run-agent-context-next",
                    "turnId": "turn-agent-context-next",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:05Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "content": "next question" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-agent-context-full-history",
        "trace-agent-context-thread",
        "session.get_history",
        json!({ "session_id": "session-agent-context" }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        4
    );

    let agent_context = router.dispatch(&WorkerRequest::new(
        "req-agent-context-projection",
        "trace-agent-context-thread",
        "session.get_agent_context",
        json!({ "session_id": "session-agent-context" }),
    ));
    assert_eq!(agent_context.error, None);
    assert_eq!(
        agent_context.result.as_ref().unwrap()["messages"],
        json!([
            { "role": "assistant", "content": "summary of old conversation" },
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "context-read-1",
                    "type": "function",
                    "function": {
                        "name": "workspace.read_file",
                        "arguments": "{\"path\":\"README.md\"}"
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "context-read-1",
                "name": "workspace.read_file",
                "content": "README contents"
            },
            {
                "role": "assistant",
                "content": "answer from compacted turn"
            },
            {
                "role": "user",
                "content": "next question",
                "timestamp": "2026-07-05T04:00:05Z"
            }
        ])
    );
}

#[test]
fn dispatches_session_get_history_reads_thread_tail() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-tail-thread-create",
        "trace-session-tail-thread",
        "thread.create",
        json!({
            "threadId": "thread-tail-history",
            "title": "Tail History",
            "sessionKey": "thread-tail-session",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let items = (0..205)
        .map(|index| {
            json!({
                "itemId": format!("thread-tail-history:item:{index}"),
                "threadId": "",
                "runId": "run-thread-tail",
                "turnId": "turn-thread-tail",
                "sequence": 0,
                "createdAt": format!("2026-07-05T05:{:02}:{:02}Z", index / 60, index % 60),
                "kind": {
                    "type": "user_message",
                    "payload": { "content": format!("message-{index}") }
                }
            })
        })
        .collect::<Vec<_>>();
    let append = router.dispatch(&WorkerRequest::new(
        "req-session-tail-thread-append",
        "trace-session-tail-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-tail-history",
            "items": items
        }),
    ));
    assert_eq!(append.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-tail-history",
        "trace-session-tail-thread",
        "session.get_history",
        json!({ "session_id": "thread-tail-session", "limit": 2 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"],
        json!([
            {
                "role": "user",
                "content": "message-203",
                "timestamp": "2026-07-05T05:03:23Z"
            },
            {
                "role": "user",
                "content": "message-204",
                "timestamp": "2026-07-05T05:03:24Z"
            }
        ])
    );
}

#[test]
fn dispatches_session_get_history_projects_thread_message_metadata_and_usage() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-rich-thread-create",
        "trace-session-rich-thread",
        "thread.create",
        json!({
            "threadId": "thread-rich-history",
            "title": "Rich History",
            "sessionKey": "thread-rich-session",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-session-rich-thread-append",
        "trace-session-rich-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-rich-history",
            "items": [
                {
                    "itemId": "thread-rich-history:user",
                    "threadId": "",
                    "runId": "run-rich-history",
                    "turnId": "turn-rich-history",
                    "sequence": 0,
                    "createdAt": "2026-07-05T06:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": {
                            "messageId": "user-rich",
                            "content": "load rich history"
                        }
                    }
                },
                {
                    "itemId": "thread-rich-history:assistant",
                    "threadId": "",
                    "runId": "run-rich-history",
                    "turnId": "turn-rich-history",
                    "sequence": 0,
                    "createdAt": "2026-07-05T06:00:02Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": {
                            "messageId": "assistant-rich",
                            "content": "rich history loaded",
                            "references": [{ "id": "ref-1", "kind": "memory", "title": "Memory" }],
                            "metadata": { "finishReason": "stop" }
                        }
                    }
                },
                {
                    "itemId": "thread-rich-history:terminal",
                    "threadId": "",
                    "runId": "run-rich-history",
                    "turnId": "turn-rich-history",
                    "sequence": 0,
                    "createdAt": "2026-07-05T06:00:03Z",
                    "kind": {
                        "type": "agent_run_completed",
                        "payload": {
                            "runId": "run-rich-history",
                            "tokenUsageInfo": {
                                "totalTokenUsage": {
                                    "inputTokens": 0,
                                    "cachedInputTokens": 0,
                                    "outputTokens": 0,
                                    "reasoningOutputTokens": 0,
                                    "totalTokens": 172
                                },
                                "lastTokenUsage": {
                                    "inputTokens": 10,
                                    "cachedInputTokens": 0,
                                    "outputTokens": 162,
                                    "reasoningOutputTokens": 41,
                                    "totalTokens": 172
                                },
                                "modelContextWindow": 128000
                            }
                        }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-rich-history",
        "trace-session-rich-thread",
        "session.get_history",
        json!({ "session_id": "thread-rich-session" }),
    ));

    assert_eq!(history.error, None);
    let messages = &history.result.as_ref().unwrap()["messages"];
    assert_eq!(messages[0]["messageId"], "user-rich");
    assert_eq!(messages[1]["messageId"], "assistant-rich");
    assert_eq!(messages[1]["references"][0]["id"], "ref-1");
    assert_eq!(messages[1]["metadata"]["finishReason"], "stop");
    assert_eq!(messages[1]["usage"]["contextWindowTokens"], 128000);
    assert_eq!(messages[1]["usage"]["contextWindowUsedTokens"], 172);
    assert_eq!(messages[1]["usage"]["totalTokens"], 172);
    assert_eq!(messages[1]["usage"]["completionTokens"], 162);
}

#[test]
fn dispatches_session_get_history_request() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "first" },
            { "role": "assistant", "content": "second" }
        ],
        "user_profile": { "name": "Ada" }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_history",
        json!({ "session_id": "session-1", "limit": 1 }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "session_id": "session-1",
            "messages": [{
                "role": "assistant",
                "content": "second",
                "timestamp": "2026-06-09T09:30:00Z"
            }],
            "user_profile": { "name": "Ada" },
            "updated_at": "2026-06-09T09:30:00Z"
        }))
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_thread_rollback_as_an_append_only_rollout_marker() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    for (run_id, user, assistant, checkpoint) in [
        ("rollback-run-1", "first user", "first assistant", None),
        (
            "rollback-run-2",
            "second user",
            "second assistant",
            Some(json!({
                "replacementHistory": [
                    { "role": "user", "content": "compacted second turn" },
                    { "role": "assistant", "content": "summary after second turn" }
                ],
                "checkpointStage": "finalized"
            })),
        ),
    ] {
        let mut params = json!({
            "session_id": "thread-rollout-rollback",
            "run_id": run_id,
            "messages": [
                { "role": "user", "content": user },
                { "role": "assistant", "content": assistant }
            ]
        });
        if let Some(checkpoint) = checkpoint {
            params["contextMetadata"] = json!({ "contextCheckpoint": checkpoint });
        }
        let persisted = router.dispatch(&WorkerRequest::new(
            format!("req-{run_id}"),
            "trace-thread-rollout-rollback",
            "session.persist_turn",
            params,
        ));
        assert_eq!(persisted.error, None);
    }

    let rolled_back = router.dispatch(&WorkerRequest::new(
        "req-thread-rollout-rollback",
        "trace-thread-rollout-rollback",
        "thread.rollback",
        json!({
            "threadId": "thread-rollout-rollback",
            "numTurns": 1
        }),
    ));
    assert_eq!(rolled_back.error, None);
    let result = rolled_back.result.as_ref().unwrap();
    assert_eq!(result["threadId"], "thread-rollout-rollback");
    assert_eq!(result["numTurns"], 1);
    assert_eq!(result["remainingMessageCount"], 2);
    assert_eq!(result["contextCheckpointRetained"], false);

    for method in ["session.get_history", "session.get_agent_context"] {
        let projection = router.dispatch(&WorkerRequest::new(
            format!("req-thread-rollout-rollback-{method}"),
            "trace-thread-rollout-rollback",
            method,
            json!({ "session_id": "thread-rollout-rollback" }),
        ));
        assert_eq!(projection.error, None);
        let messages = projection.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], "first user");
        assert_eq!(messages[1]["content"], "first assistant");
    }

    let metadata = router.dispatch(&WorkerRequest::new(
        "req-thread-rollout-rollback-metadata",
        "trace-thread-rollout-rollback",
        "session.get_metadata",
        json!({ "session_id": "thread-rollout-rollback" }),
    ));
    let rollout_path = metadata.result.as_ref().unwrap()["extra"]["threadPath"]
        .as_str()
        .unwrap();
    let rollout = std::fs::read_to_string(rollout_path).unwrap();
    assert!(rollout.contains("second user"));
    assert!(rollout.contains("\"type\":\"thread_rolled_back\""));
    assert!(rollout.contains("\"num_turns\":1"));

    let consistency = router.dispatch(&WorkerRequest::new(
        "req-thread-rollout-rollback-consistency",
        "trace-thread-rollout-rollback",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn thread_rollback_rejects_an_in_progress_turn() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let started = router.dispatch(&WorkerRequest::new(
        "req-thread-rollback-start",
        "trace-thread-rollback-start",
        "rollout.append_turn_context",
        json!({
            "sessionId": "thread-rollback-active",
            "context": {
                "turnId": "turn-rollback-active",
                "cwd": "",
                "approvalPolicy": {},
                "sandboxPolicy": {},
                "model": "fixture-model",
                "summary": {}
            }
        }),
    ));
    assert_eq!(started.error, None);

    let rollback = router.dispatch(&WorkerRequest::new(
        "req-thread-rollback-active",
        "trace-thread-rollback-active",
        "thread.rollback",
        json!({
            "threadId": "thread-rollback-active",
            "numTurns": 1
        }),
    ));
    assert!(rollback.error.as_ref().is_some_and(|error| {
        error
            .message
            .contains("cannot rollback while a turn is in progress")
    }));
}

#[test]
fn rollout_world_state_appends_typed_full_and_patch_items() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    for (index, world_state) in [
        json!({
            "full": true,
            "state": {
                "environment": {
                    "cwd": "D:/workspace",
                    "status": "starting"
                }
            }
        }),
        json!({
            "full": false,
            "state": {
                "environment": {
                    "status": "ready"
                }
            }
        }),
    ]
    .into_iter()
    .enumerate()
    {
        let appended = router.dispatch(&WorkerRequest::new(
            format!("req-world-state-{index}"),
            "trace-world-state",
            "rollout.append_world_state",
            json!({
                "sessionId": "thread-world-state",
                "worldState": world_state
            }),
        ));
        assert_eq!(appended.error, None);
    }

    let metadata = router.dispatch(&WorkerRequest::new(
        "req-world-state-metadata",
        "trace-world-state",
        "session.get_metadata",
        json!({ "session_id": "thread-world-state" }),
    ));
    let rollout_path = metadata.result.as_ref().unwrap()["extra"]["threadPath"]
        .as_str()
        .unwrap();
    let lines =
        crate::worker_thread_log::read_thread_lines(std::path::Path::new(rollout_path)).unwrap();
    let reconstructed = crate::worker_rollout::reconstruct_rollout(&lines).unwrap();
    assert_eq!(
        reconstructed.world_state_baseline,
        Some(json!({
            "environment": {
                "cwd": "D:/workspace",
                "status": "ready"
            }
        }))
    );
}

#[test]
fn dispatches_session_get_history_does_not_project_legacy_history_on_read() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "first" },
            { "role": "assistant", "content": "second" }
        ],
        "user_profile": { "name": "Ada" }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let response = router.dispatch(&WorkerRequest::new(
        "req-session-history-project",
        "trace-history-project",
        "session.get_history",
        json!({ "session_id": "session-1", "limit": 80 }),
    ));
    assert_eq!(response.error, None);
    assert_eq!(
        response.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("threads")
        .join("threads.sqlite")
        .exists());
}

#[test]
fn dispatches_session_delete_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let create_thread = router.dispatch(&WorkerRequest::new(
        "req-thread-before-session-delete",
        "trace-1",
        "thread.create",
        json!({
            "title": "Linked session",
            "sessionKey": "session-1"
        }),
    ));
    assert_eq!(create_thread.error, None);
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.delete",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "session_id": "session-1",
            "deleted": true
        }))
    );
    assert!(response.error.is_none());

    let session_list = router.dispatch(&WorkerRequest::new(
        "req-session-list-after-session-delete",
        "trace-1",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(session_list.error, None);
    assert_eq!(session_list.result, Some(json!([])));
}

#[test]
fn dispatches_session_patch_metadata_request() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({ "metadata": { "pinned": false, "topic": "old" } });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.patch_metadata",
        json!({
            "session_id": "session-1",
            "metadata": { "pinned": true, "title": "Patched title" }
        }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["extra"]["metadata"],
        json!({
            "pinned": true,
            "title": "Patched title",
            "topic": "old"
        })
    );
    assert_eq!(response.result.as_ref().unwrap()["title"], "Patched title");
    assert!(response.error.is_none());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("threads")
        .join("threads.sqlite")
        .exists());
}

#[test]
fn dispatches_session_patch_user_profile_request() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "user_profile": { "name": "Ada", "preferences": ["short answers"] },
        "metadata": { "entity_extractor_last_turn_hash": "old-hash", "topic": "native" }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.patch_user_profile",
        json!({
            "session_id": "session-1",
            "user_profile": {
                "name": "Ada",
                "preferences": ["short answers", "code examples"]
            },
            "metadata": { "entity_extractor_last_turn_hash": "new-hash" }
        }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["extra"]["user_profile"],
        json!({
            "name": "Ada",
            "preferences": ["short answers", "code examples"]
        })
    );
    assert_eq!(
        response.result.as_ref().unwrap()["extra"]["metadata"],
        json!({
            "entity_extractor_last_turn_hash": "new-hash",
            "topic": "native"
        })
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_workspace_read_bootstrap_files_request() {
    let fixture = WorkspaceFixture::new();
    fixture.write("AGENTS.md", "agent rules");
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
        "workspace.read_bootstrap_files",
        json!({ "files": ["AGENTS.md", "TOOLS.md"] }),
    );

    let response = router.dispatch(&request);

    let result = response.result.expect("bootstrap result should be present");
    assert_eq!(result["missing"], json!(["TOOLS.md"]));
    let files = result["files"]
        .as_array()
        .expect("files should be an array");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "AGENTS.md");
    assert_eq!(files[0]["contents"], "agent rules");
    assert!(files[0]["updated_at"].is_string());
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_checkpoint_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let set_request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.set_checkpoint",
        json!({
            "session_id": "session-1",
            "checkpoint": {
                "phase": "awaiting_tools",
                "runId": "run-session-checkpoint",
                "checkpointId": "checkpoint-session-route"
            }
        }),
    );
    let clear_request = WorkerRequest::new(
        "req-2",
        "trace-1",
        "session.clear_checkpoint",
        json!({ "session_id": "session-1" }),
    );

    let set_response = router.dispatch(&set_request);
    let clear_response = router.dispatch(&clear_request);

    assert_eq!(
        set_response.result.as_ref().unwrap()["extra"]["runtime_checkpoint"],
        json!({
            "phase": "awaiting_tools",
            "runId": "run-session-checkpoint",
            "checkpointId": "checkpoint-session-route"
        })
    );
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("threads")
        .join("threads.sqlite")
        .exists());
    assert!(clear_response.result.as_ref().unwrap()["extra"]
        .get("runtime_checkpoint")
        .is_none());
    assert!(set_response.error.is_none());
    assert!(clear_response.error.is_none());
}

#[test]
fn dispatches_session_get_checkpoint_request() {
    let fixture = WorkspaceFixture::new();
    let mut seed_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let seed = seed_router.dispatch(&WorkerRequest::new(
        "req-seed-checkpoint",
        "trace-seed-checkpoint",
        "session.set_checkpoint",
        json!({
            "session_id": "session-1",
            "checkpoint": {
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }
        }),
    ));
    assert_eq!(seed.error, None);

    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_checkpoint",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "runId": "run-1",
            "phase": "awaiting_tools",
            "iteration": 1
        }))
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_get_checkpoint_falls_back_to_legacy_runtime_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "runtime_checkpoint": {
            "runId": "run-legacy-checkpoint",
            "phase": "awaiting_tools",
            "iteration": 2
        }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-legacy-checkpoint",
        "trace-legacy-checkpoint",
        "session.get_checkpoint",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "runId": "run-legacy-checkpoint",
            "phase": "awaiting_tools",
            "iteration": 2
        }))
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_missing_session_checkpoint_as_null() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_checkpoint",
        json!({ "session_id": "desktop-session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(response.result, Some(json!(null)));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_append_messages_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.append_messages",
        json!({
            "session_id": "session-1",
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ]
        }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["extra"]["messages"],
        json!([
            { "role": "user", "content": "hello" },
            { "role": "assistant", "content": "done" }
        ])
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_clear_request() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "hello" },
            { "role": "assistant", "content": "done" }
        ],
        "runtime_checkpoint": { "phase": "awaiting_tools" },
        "user_profile": { "name": "Ada" },
        "last_consolidated": 1
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.clear",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["messages_before"],
        json!(2)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["messages_after"],
        json!(0)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["checkpoint_cleared"],
        json!(true)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["session"]["extra"]["messages"],
        json!([])
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_trim_request() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "old" },
            { "role": "assistant", "content": "old answer" },
            { "role": "user", "content": "recent" },
            { "role": "assistant", "content": "recent answer" }
        ],
        "last_consolidated": 1
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.trim",
        json!({ "session_id": "session-1", "keep_recent_messages": 1 }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["messages_before"],
        json!(4)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["messages_after"],
        json!(2)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["session"]["extra"]["messages"],
        json!([
            {
                "role": "user",
                "content": "recent",
                "timestamp": "2026-06-09T09:30:00Z"
            },
            {
                "role": "assistant",
                "content": "recent answer",
                "timestamp": "2026-06-09T09:30:00Z"
            }
        ])
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_persist_turn_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.persist_turn",
        json!({
            "session_id": "session-1",
            "run_id": "run-1",
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "clear_checkpoint": true,
            "contextMetadata": {
                "historyMessageCount": 1,
                "bridge": {
                    "missingSession": false
                }
            },
            "context_metadata": {
                "historyMessageCount": 1,
                "bridge": {
                    "missingSession": false
                }
            }
        }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "session_id": "session-1",
            "messages_before": 0,
            "messages_after": 2,
            "saved_message_count": 2,
            "saved_messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "checkpoint_cleared": false,
            "duplicate_message_count": 0,
            "truncated_tool_result_count": 0,
            "omitted_side_effects": [
                "conversation_evidence",
                "memory_extraction",
                "consolidation",
                "user_profile_update"
            ]
        }))
    );
    assert!(response.error.is_none());

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-persist-history",
        "trace-1",
        "session.get_history",
        json!({ "session_id": "session-1", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["content"],
        "hello"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["content"],
        "done"
    );
}

#[test]
fn persisted_compaction_replaces_agent_context_but_preserves_transcript() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let old_turn = router.dispatch(&WorkerRequest::new(
        "req-compact-old-turn",
        "trace-compact-persistence",
        "session.persist_turn",
        json!({
            "session_id": "session-compact-persistence",
            "run_id": "run-compact-old-turn",
            "messages": [
                { "role": "user", "content": "old user", "messageId": "compact-old-user" },
                { "role": "assistant", "content": "old answer", "messageId": "compact-old-answer" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(old_turn.error, None);

    let compacted_turn = router.dispatch(&WorkerRequest::new(
        "req-compact-current-turn",
        "trace-compact-persistence",
        "session.persist_turn",
        json!({
            "session_id": "session-compact-persistence",
            "run_id": "run-compact-current-turn",
            "messages": [
                { "role": "user", "content": "current user", "messageId": "compact-current-user" },
                { "role": "assistant", "content": "current answer", "messageId": "compact-current-answer" }
            ],
            "clear_checkpoint": false,
            "context_metadata": {
                "contextCheckpoint": {
                    "schemaVersion": 1,
                    "replacementHistory": [
                        { "role": "assistant", "content": "summary of old turn" },
                        { "role": "user", "content": "current user" },
                        { "role": "assistant", "content": "current answer" }
                    ]
                }
            }
        }),
    ));
    assert_eq!(compacted_turn.error, None);
    assert_eq!(compacted_turn.result.as_ref().unwrap()["messages_after"], 3);

    let history = router.dispatch(&WorkerRequest::new(
        "req-compact-transcript",
        "trace-compact-persistence",
        "session.get_history",
        json!({ "session_id": "session-compact-persistence", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["old user", "old answer", "current user", "current answer"]
    );

    let agent_context = router.dispatch(&WorkerRequest::new(
        "req-compact-agent-context",
        "trace-compact-persistence",
        "session.get_agent_context",
        json!({ "session_id": "session-compact-persistence", "limit": 80 }),
    ));
    assert_eq!(agent_context.error, None);
    assert_eq!(
        agent_context.result.as_ref().unwrap()["messages"],
        json!([
            { "role": "assistant", "content": "summary of old turn" },
            { "role": "user", "content": "current user" },
            { "role": "assistant", "content": "current answer" }
        ])
    );
}

#[test]
fn persists_session_turn_to_thread_log() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let persist = router.dispatch(&WorkerRequest::new(
        "req-thread-log-persist",
        "trace-thread-log-persist",
        "session.persist_turn",
        json!({
            "session_id": "session-thread-log-1",
            "run_id": "run-1",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-1" },
                { "role": "assistant", "content": "hi", "messageId": "assistant-1" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-thread-log-history",
        "trace-thread-log-history",
        "session.get_history",
        json!({ "session_id": "session-thread-log-1", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    let messages = &history.result.as_ref().unwrap()["messages"];
    assert_eq!(messages.as_array().unwrap().len(), 2);
    assert_eq!(messages[0]["messageId"], "user-1");
    assert_eq!(messages[1]["messageId"], "assistant-1");
}

#[test]
fn session_persist_turn_does_not_write_legacy_session_or_thread_stores() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let persist = router.dispatch(&WorkerRequest::new(
        "req-thread-log-only-persist",
        "trace-thread-log-only-persist",
        "session.persist_turn",
        json!({
            "session_id": "session-thread-log-only",
            "run_id": "run-thread-log-only",
            "messages": [
                { "role": "user", "content": "canonical only" },
                { "role": "assistant", "content": "saved in thread log" }
            ],
            "clear_checkpoint": false
        }),
    ));

    assert_eq!(persist.error, None);
    assert!(fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_some());
    assert!(!fixture
        .root
        .join("sessions")
        .join("sessions.sqlite")
        .exists());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("thread-store.jsonl")
        .exists());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("threads")
        .join("threads.sqlite")
        .exists());
}

#[test]
fn rollout_native_session_mutations_survive_restart_without_legacy_stores() {
    let fixture = WorkspaceFixture::new();
    let policy = CapabilityPolicy::new([
        WorkerCapability::SessionWrite,
        WorkerCapability::SessionMetadataRead,
    ]);
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            policy.clone(),
        )
        .unwrap();
        let appended = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-append",
            "trace-rollout-session",
            "session.append_messages",
            json!({
                "session_id": "session-rollout-native",
                "messages": [
                    { "role": "user", "content": "old" },
                    { "role": "assistant", "content": "old answer" },
                    { "role": "user", "content": "recent" },
                    { "role": "assistant", "content": "recent answer" }
                ]
            }),
        ));
        assert_eq!(appended.error, None);

        let profile = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-profile",
            "trace-rollout-session",
            "session.patch_user_profile",
            json!({
                "session_id": "session-rollout-native",
                "user_profile": { "name": "Ada" },
                "metadata": { "profileSource": "test" }
            }),
        ));
        assert_eq!(profile.error, None);

        let trimmed = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-trim",
            "trace-rollout-session",
            "session.trim",
            json!({
                "session_id": "session-rollout-native",
                "keep_recent_messages": 1
            }),
        ));
        assert_eq!(trimmed.error, None);
        assert_eq!(trimmed.result.as_ref().unwrap()["messages_after"], 2);

        for (request_id, content, completed, steps) in [
            (
                "req-rollout-session-progress-1",
                "first progress",
                0,
                json!([
                    { "step": "Inspect session", "status": "in_progress" },
                    { "step": "Finish session", "status": "pending" }
                ]),
            ),
            (
                "req-rollout-session-progress-2",
                "updated progress",
                1,
                json!([
                    { "step": "Inspect session", "status": "completed" },
                    { "step": "Finish session", "status": "in_progress" }
                ]),
            ),
        ] {
            let progress = router.dispatch(&WorkerRequest::new(
                request_id,
                "trace-rollout-session",
                "session.task_progress.upsert",
                json!({
                    "session_id": "session-rollout-native",
                    "plan_id": "plan-rollout-native",
                    "content": content,
                    "progress": {
                        "completed": completed,
                        "total": 2,
                        "steps": steps
                    }
                }),
            ));
            assert_eq!(progress.error, None);
        }

        let metadata = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-metadata",
            "trace-rollout-session",
            "session.patch_metadata",
            json!({
                "session_id": "session-rollout-native",
                "metadata": { "title": "Rollout native session", "pinned": true }
            }),
        ));
        assert_eq!(metadata.error, None);

        for session_id in ["session-rollout-clear", "session-rollout-delete"] {
            let appended = router.dispatch(&WorkerRequest::new(
                format!("req-{session_id}-append"),
                "trace-rollout-session-lifecycle",
                "session.append_messages",
                json!({
                    "session_id": session_id,
                    "messages": [
                        { "role": "user", "content": "lifecycle message" },
                        { "role": "assistant", "content": "lifecycle answer" }
                    ]
                }),
            ));
            assert_eq!(appended.error, None);
        }
        let cleared = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-clear",
            "trace-rollout-session-lifecycle",
            "session.clear",
            json!({ "session_id": "session-rollout-clear" }),
        ));
        assert_eq!(cleared.error, None);
        let deleted = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-delete",
            "trace-rollout-session-lifecycle",
            "session.delete",
            json!({ "session_id": "session-rollout-delete" }),
        ));
        assert_eq!(deleted.error, None);
        assert_eq!(deleted.result.as_ref().unwrap()["deleted"], true);
    }

    let mut restarted = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        policy,
    )
    .unwrap();
    let history = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-history-after-restart",
        "trace-rollout-session",
        "session.get_history",
        json!({ "session_id": "session-rollout-native", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    let history = history.result.unwrap();
    assert_eq!(history["user_profile"], json!({ "name": "Ada" }));
    assert_eq!(
        history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["recent", "recent answer"]
    );
    let agent_context = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-context-after-restart",
        "trace-rollout-session",
        "session.get_agent_context",
        json!({ "session_id": "session-rollout-native", "limit": 80 }),
    ));
    assert_eq!(agent_context.error, None);
    assert_eq!(
        agent_context.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["_task_plan_id"] == "plan-rollout-native")
            .count(),
        1
    );
    let metadata = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-metadata-after-restart",
        "trace-rollout-session",
        "session.get_metadata",
        json!({ "session_id": "session-rollout-native" }),
    ));
    assert_eq!(metadata.error, None);
    assert_eq!(
        metadata.result.as_ref().unwrap()["title"],
        "Rollout native session"
    );
    assert_eq!(
        metadata.result.as_ref().unwrap()["extra"]["metadata"]["pinned"],
        true
    );
    let cleared_history = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-clear-after-restart",
        "trace-rollout-session-lifecycle",
        "session.get_history",
        json!({ "session_id": "session-rollout-clear", "limit": 80 }),
    ));
    assert_eq!(cleared_history.error, None);
    assert_eq!(
        cleared_history.result.as_ref().unwrap()["messages"],
        json!([])
    );
    let sessions = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-list-after-restart",
        "trace-rollout-session-lifecycle",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(sessions.error, None);
    assert!(!sessions
        .result
        .as_ref()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|session| session["session_id"] == "session-rollout-delete"));

    let rollout_path = PathBuf::from(
        metadata.result.as_ref().unwrap()["extra"]["threadPath"]
            .as_str()
            .unwrap(),
    );
    let rollout = std::fs::read_to_string(rollout_path).unwrap();
    assert!(rollout.contains("\"type\":\"session_trimmed\""));
    assert!(rollout.contains("\"type\":\"task_progress_updated\""));
    assert!(!fixture
        .root
        .join("sessions")
        .join("sessions.sqlite")
        .exists());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("thread-store.jsonl")
        .exists());
}

#[test]
fn agent_run_persistence_drops_transient_trace_and_does_not_write_legacy_session_store() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let record = json!({
        "sessionId": "session-agent-log-only",
        "runId": "run-agent-log-only",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "2026-07-08T10:00:00Z",
        "updatedAt": "2026-07-08T10:00:00Z",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "traceEvents": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-upsert",
        "trace-agent-log-only",
        "agent_run.upsert",
        json!({ "record": record }),
    ));
    let append_trace = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-trace",
        "trace-agent-log-only",
        "agent_run.append_trace_batch",
        json!({
            "session_id": "session-agent-log-only",
            "run_id": "run-agent-log-only",
            "events": [{
                "eventId": "trace-delta-1",
                "eventName": "agent.delta",
                "payload": { "delta": "hel" }
            }, {
                "eventId": "trace-delta-2",
                "eventName": "agent.delta",
                "payload": { "delta": "lo" }
            }]
        }),
    ));
    let completed = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-complete",
        "trace-agent-log-only",
        "agent_run.mark_completed",
        json!({
            "session_id": "session-agent-log-only",
            "run_id": "run-agent-log-only",
            "stop_reason": "final_response",
            "final_content": "hello"
        }),
    ));
    let get = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-get",
        "trace-agent-log-only",
        "agent_run.get",
        json!({
            "session_id": "session-agent-log-only",
            "run_id": "run-agent-log-only"
        }),
    ));

    assert_eq!(upsert.error, None);
    assert_eq!(append_trace.error, None);
    assert_eq!(completed.error, None);
    assert_eq!(get.error, None);
    assert_eq!(get.result.as_ref().unwrap()["status"], "completed");
    let trace_events = get.result.as_ref().unwrap()["traceEvents"]
        .as_array()
        .expect("trace events should be an array");
    assert!(trace_events.is_empty());
    assert!(!fixture
        .root
        .join("sessions")
        .join("sessions.sqlite")
        .exists());
    assert!(fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_some());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("thread-store.jsonl")
        .exists());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("threads")
        .join("threads.sqlite")
        .exists());
}

#[test]
fn agent_run_trace_append_preserves_thread_updated_at_and_keeps_index_clean() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let record = json!({
        "sessionId": "session-trace-state-index",
        "runId": "run-trace-state-index",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "2026-07-08T10:00:00Z",
        "updatedAt": "2026-07-08T10:00:00Z",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "traceEvents": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-trace-state-index-upsert",
        "trace-state-index",
        "agent_run.upsert",
        json!({ "record": record }),
    ));
    assert_eq!(upsert.error, None);
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let before_updated_at = thread_state_updated_at(&state_path, "session-trace-state-index");
    thread::sleep(Duration::from_millis(5));

    let append_trace = router.dispatch(&WorkerRequest::new(
        "req-trace-state-index-append",
        "trace-state-index",
        "agent_run.append_trace",
        json!({
            "session_id": "session-trace-state-index",
            "run_id": "run-trace-state-index",
            "event": {
                "eventId": "trace-state-index-delta",
                "eventName": "agent.delta",
                "payload": { "delta": "streamed" }
            }
        }),
    ));
    assert_eq!(append_trace.error, None);

    let after_updated_at = thread_state_updated_at(&state_path, "session-trace-state-index");
    assert_eq!(after_updated_at, before_updated_at);
    let context = router
        .thread_log
        .get_agent_context("session-trace-state-index", 50)
        .unwrap()
        .unwrap();
    assert!(context.messages.is_empty());
    let consistency = router.dispatch(&WorkerRequest::new(
        "req-trace-state-index-consistency",
        "trace-state-index",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
    assert_eq!(
        append_trace.result.as_ref().unwrap()["traceEvents"][0]["eventName"],
        "agent.delta"
    );
}

#[test]
fn persists_thread_log_token_count_and_replays_usage() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let persist = router.dispatch(&WorkerRequest::new(
        "req-token-count-persist",
        "trace-token-count-persist",
        "session.persist_turn",
        json!({
            "session_id": "session-token-count",
            "run_id": "run-token-count",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-token" },
                { "role": "assistant", "content": "hi", "messageId": "assistant-token" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    router
        .thread_log
        .append_token_count(
            "session-token-count",
            crate::worker_thread_log::TokenUsageInfo {
                total_token_usage: crate::worker_thread_log::TokenUsage {
                    input_tokens: 1010,
                    cached_input_tokens: 0,
                    output_tokens: 162,
                    reasoning_output_tokens: 0,
                    total_tokens: 1172,
                },
                last_token_usage: crate::worker_thread_log::TokenUsage {
                    input_tokens: 10,
                    cached_input_tokens: 0,
                    output_tokens: 162,
                    reasoning_output_tokens: 0,
                    total_tokens: 172,
                },
                model_context_window: Some(128000),
            },
        )
        .unwrap();

    let history = router.dispatch(&WorkerRequest::new(
        "req-token-count-history",
        "trace-token-count-history",
        "session.get_history",
        json!({ "session_id": "session-token-count", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    let assistant = &history.result.as_ref().unwrap()["messages"][1];
    assert_eq!(assistant["usage"]["contextWindowUsedTokens"], 172);
    assert_eq!(assistant["usage"]["contextWindowTokens"], 128000);
    assert_eq!(assistant["usage"]["totalTokens"], 172);
    assert_eq!(
        assistant["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
        172
    );

    let list = router.dispatch(&WorkerRequest::new(
        "req-token-count-list",
        "trace-token-count-history",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["extra"]["tokensUsed"],
        1172
    );
}

#[test]
fn thread_log_history_survives_router_restart() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
                "req-restart-persist",
                "trace-restart-persist",
                "session.persist_turn",
                json!({
                    "session_id": "session-restart",
                    "run_id": "run-restart",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-restart" },
                        { "role": "assistant", "content": "persisted", "messageId": "assistant-restart" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
        assert_eq!(persist.error, None);
    }

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let history = router.dispatch(&WorkerRequest::new(
        "req-restart-history",
        "trace-restart-history",
        "session.get_history",
        json!({ "session_id": "session-restart", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["messageId"],
        "assistant-restart"
    );
}

#[test]
fn thread_log_history_rebuilds_missing_index_on_first_read() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-rebuild-state-persist",
            "trace-rebuild-state",
            "session.persist_turn",
            json!({
                "session_id": "session-rebuild-state",
                "run_id": "run-rebuild-state",
                "messages": [
                    { "role": "user", "content": "persist me", "messageId": "user-rebuild" },
                    { "role": "assistant", "content": "rebuilt", "messageId": "assistant-rebuild" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let history = router.dispatch(&WorkerRequest::new(
        "req-rebuild-state-history",
        "trace-rebuild-state",
        "session.get_history",
        json!({ "session_id": "session-rebuild-state", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["messageId"],
        "assistant-rebuild"
    );
}

#[test]
fn thread_log_title_is_derived_from_first_user_message_and_survives_state_rebuild() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-title-persist",
            "trace-title-persist",
            "session.persist_turn",
            json!({
                "session_id": "session-title-rebuild",
                "run_id": "run-title-rebuild",
                "messages": [
                    {
                        "role": "user",
                        "content": "  Design backend titles\nwith durable metadata  ",
                        "messageId": "user-title-rebuild"
                    },
                    {
                        "role": "assistant",
                        "content": "done",
                        "messageId": "assistant-title-rebuild"
                    }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }

    let thread_log_path = first_thread_log_file(&fixture.root);
    let thread_log =
        std::fs::read_to_string(&thread_log_path).expect("thread log should be readable");
    assert!(thread_log.contains("\"type\":\"metadata_updated\""));
    assert!(thread_log.contains("\"title\":\"Design backend titles\""));

    let legacy_thread_log = thread_log
        .lines()
        .filter(|line| !line.contains("\"type\":\"metadata_updated\""))
        .map(|line| {
            let mut value: serde_json::Value = serde_json::from_str(line).unwrap();
            value.as_object_mut().unwrap().remove("ordinal");
            serde_json::to_string(&value).unwrap()
        })
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&thread_log_path, format!("{legacy_thread_log}\n"))
        .expect("legacy thread log fixture should be writable");

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(&state_path).expect("state db should open");
    connection
        .execute(
            "UPDATE threads SET title = 'New session' WHERE session_id = ?1",
            ["session-title-rebuild"],
        )
        .expect("legacy title should be writable");
    drop(connection);
    repair_session_log_index(&fixture.root);

    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let list = router.dispatch(&WorkerRequest::new(
            "req-title-backfill-list",
            "trace-title-backfill-list",
            "session.list_metadata",
            json!({}),
        ));
        assert_eq!(list.error, None);
        assert_eq!(
            list.result.as_ref().unwrap()[0]["title"],
            "Design backend titles"
        );
    }

    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let list = router.dispatch(&WorkerRequest::new(
        "req-title-list",
        "trace-title-list",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["title"],
        "Design backend titles"
    );
}

#[test]
fn session_list_metadata_rebuild_ignores_legacy_thread_item_jsonl() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
                "req-ignore-legacy-items-persist",
                "trace-ignore-legacy-items",
                "session.persist_turn",
                json!({
                    "session_id": "session-ignore-legacy-items",
                    "run_id": "run-ignore-legacy-items",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-ignore-legacy-items" },
                        { "role": "assistant", "content": "rebuilt", "messageId": "assistant-ignore-legacy-items" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
        assert_eq!(persist.error, None);
    }
    fixture.write(
            ".tinybot/threads/items/thread-legacy-items.jsonl",
            r#"{"itemId":"legacy-session:1","threadId":"thread-legacy-items","runId":"legacy-history","turnId":"legacy-history","parentItemId":null,"sequence":1,"createdAt":"1783312765469","kind":{"type":"user_message","payload":{"content":"hello","role":"user"}}}
"#,
        );
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let list = router.dispatch(&WorkerRequest::new(
        "req-ignore-legacy-items-list",
        "trace-ignore-legacy-items",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    let sessions = list.result.as_ref().unwrap().as_array().unwrap();
    assert!(sessions
        .iter()
        .any(|session| session["session_id"] == "session-ignore-legacy-items"));
}

#[test]
fn session_get_metadata_reads_thread_log_after_state_rebuild() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-metadata-rebuild-persist",
            "trace-metadata-rebuild",
            "session.persist_turn",
            json!({
                "session_id": "session-metadata-rebuild",
                "run_id": "run-metadata-rebuild",
                "messages": [
                    { "role": "user", "content": "metadata", "messageId": "user-metadata-rebuild" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let metadata = router.dispatch(&WorkerRequest::new(
        "req-metadata-rebuild-get",
        "trace-metadata-rebuild",
        "session.get_metadata",
        json!({ "session_id": "session-metadata-rebuild" }),
    ));

    assert_eq!(metadata.error, None);
    assert_eq!(
        metadata.result.as_ref().unwrap()["session_id"],
        "session-metadata-rebuild"
    );
}

#[test]
fn thread_log_history_rebuilds_corrupt_derived_index_on_first_read() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-corrupt-state-persist",
            "trace-corrupt-state",
            "session.persist_turn",
            json!({
                "session_id": "session-corrupt-state",
                "run_id": "run-corrupt-state",
                "messages": [
                    { "role": "user", "content": "persist me", "messageId": "user-corrupt" },
                    { "role": "assistant", "content": "rebuilt", "messageId": "assistant-corrupt" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::write(&state_path, b"not sqlite").expect("state index should be corruptible");

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let history = router.dispatch(&WorkerRequest::new(
        "req-corrupt-state-history",
        "trace-corrupt-state",
        "session.get_history",
        json!({ "session_id": "session-corrupt-state", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["messageId"],
        "assistant-corrupt"
    );
}

#[test]
fn thread_log_history_rejects_state_index_path_escape() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-path-escape-persist",
        "trace-path-escape",
        "session.persist_turn",
        json!({
            "session_id": "session-path-escape",
            "run_id": "run-path-escape",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-path-escape" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let canonical_path = first_thread_log_file(&fixture.root);
    let escaped_path = fixture.root.join("escaped.jsonl");
    let connection = rusqlite::Connection::open(&state_path).unwrap();
    connection
        .execute(
            "UPDATE threads SET thread_path = ?1 WHERE session_id = ?2",
            rusqlite::params![escaped_path.display().to_string(), "session-path-escape"],
        )
        .unwrap();
    drop(connection);

    let history = router.dispatch(&WorkerRequest::new(
        "req-path-escape-history",
        "trace-path-escape",
        "session.get_history",
        json!({ "session_id": "session-path-escape", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["content"],
        "hello"
    );
    let connection = rusqlite::Connection::open(&state_path).unwrap();
    let repaired_path = connection
        .query_row(
            "SELECT thread_path FROM threads WHERE session_id = ?1",
            ["session-path-escape"],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(repaired_path, canonical_path.display().to_string());
}

#[test]
fn session_list_metadata_merges_thread_log_and_legacy_sessions() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "legacy-session".to_string();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-mixed-list-persist",
        "trace-mixed-list",
        "session.persist_turn",
        json!({
            "session_id": "thread-log-session",
            "run_id": "run-thread-log-session",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-mixed" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let list = router.dispatch(&WorkerRequest::new(
        "req-mixed-list",
        "trace-mixed-list",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    let session_ids = list
        .result
        .as_ref()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|session| session["session_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(session_ids.contains(&"legacy-session".to_string()));
    assert!(session_ids.contains(&"thread-log-session".to_string()));
}

#[test]
fn session_list_metadata_sorts_unix_ms_and_iso_timestamps_by_time() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "legacy-old-session".to_string();
    legacy_session.updated_at = "unix-ms:1".to_string();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-sort-mixed-timestamps-persist",
        "trace-sort-mixed-timestamps",
        "session.persist_turn",
        json!({
            "session_id": "thread-log-new-session",
            "run_id": "run-thread-log-new-session",
            "messages": [
                { "role": "user", "content": "newer", "messageId": "user-sort-mixed" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let list = router.dispatch(&WorkerRequest::new(
        "req-sort-mixed-timestamps-list",
        "trace-sort-mixed-timestamps",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["session_id"],
        "thread-log-new-session"
    );
}

#[test]
fn session_log_index_prunes_missing_canonical_rollout_automatically() {
    let fixture = WorkspaceFixture::new();
    {
        let router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        router
            .thread_log
            .persist_session_turn(
                "session-prune-missing-log",
                "run-prune-missing-log",
                vec![json!({
                    "role": "user",
                    "content": "stale",
                    "messageId": "user-prune-missing"
                })],
                None,
            )
            .unwrap();
    }
    let thread_log_path = first_thread_log_file(&fixture.root);
    std::fs::remove_file(thread_log_path).expect("thread log should be removable");

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .unwrap();
    let list = router.dispatch(&WorkerRequest::new(
        "req-prune-missing-log-list",
        "trace-prune-missing-log",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    assert!(list.result.as_ref().unwrap().as_array().unwrap().is_empty());

    let check = router.dispatch(&WorkerRequest::new(
        "req-missing-log-check",
        "trace-missing-log-check",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(check.error, None);
    assert_eq!(check.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn session_context_checkpoint_commit_is_durable_and_idempotent() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let checkpoint = json!({
        "schemaVersion": 1,
        "contextId": "run-commit-context:context:1",
        "sourceVersion": "sha256:fixture",
        "sourceContextId": null,
        "windowNumber": 1,
        "firstWindowId": "session-commit-context:context-window:0",
        "previousWindowId": "session-commit-context:context-window:0",
        "windowId": "run-commit-context:context:1",
        "checkpointStage": "installed",
        "replacementHistory": [
            { "role": "system", "content": "summary" },
            { "role": "user", "content": "current question" }
        ]
    });
    let request = || {
        WorkerRequest::new(
            "req-commit-context",
            "trace-commit-context",
            "session.commit_context_checkpoint",
            json!({
                "session_id": "session-commit-context",
                "run_id": "run-commit-context",
                "checkpoint": checkpoint
            }),
        )
    };

    let first = router.dispatch(&request());
    assert_eq!(first.error, None);
    assert_eq!(first.result.as_ref().unwrap()["committed"], true);
    assert_eq!(first.result.as_ref().unwrap()["duplicate"], false);
    assert_eq!(first.result.as_ref().unwrap()["indexSynchronized"], true);
    assert_eq!(first.result.as_ref().unwrap()["indexRecovered"], false);

    let duplicate = router.dispatch(&request());
    assert_eq!(duplicate.error, None);
    assert_eq!(duplicate.result.as_ref().unwrap()["committed"], false);
    assert_eq!(duplicate.result.as_ref().unwrap()["duplicate"], true);

    let context = router.dispatch(&WorkerRequest::new(
        "req-read-committed-context",
        "trace-read-committed-context",
        "session.get_agent_context",
        json!({ "session_id": "session-commit-context", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"],
        checkpoint["replacementHistory"]
    );
    assert_eq!(
        context.result.as_ref().unwrap()["contextCheckpoint"]["contextId"],
        "run-commit-context:context:1"
    );

    let stale = router.dispatch(&WorkerRequest::new(
        "req-stale-context",
        "trace-stale-context",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-stale-context",
            "checkpoint": {
                "contextId": "run-stale-context:context:1",
                "sourceContextId": null,
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "stale summary" }]
            }
        }),
    ));
    assert!(stale.error.as_ref().is_some_and(|error| error
        .message
        .contains("stale context compaction checkpoint")));

    let skipped_window = router.dispatch(&WorkerRequest::new(
        "req-skipped-context-window",
        "trace-skipped-context-window",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-skipped-context-window",
            "checkpoint": {
                "contextId": "run-skipped-context-window:context:1",
                "sourceContextId": "run-commit-context:context:1",
                "windowNumber": 9,
                "firstWindowId": "session-commit-context:context-window:0",
                "previousWindowId": "run-commit-context:context:1",
                "windowId": "run-skipped-context-window:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "skipped window" }]
            }
        }),
    ));
    assert!(skipped_window.error.as_ref().is_some_and(|error| {
        error.message.contains("invalid windowNumber")
            && error.details["expected"] == 2
            && error.details["actual"] == 9
    }));

    let next = router.dispatch(&WorkerRequest::new(
        "req-next-context",
        "trace-next-context",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-next-context",
            "checkpoint": {
                "contextId": "run-next-context:context:1",
                "sourceContextId": "run-commit-context:context:1",
                "windowNumber": 2,
                "firstWindowId": "session-commit-context:context-window:0",
                "previousWindowId": "run-commit-context:context:1",
                "windowId": "run-next-context:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "next summary" }]
            }
        }),
    ));
    assert_eq!(next.error, None);
    assert_eq!(next.result.as_ref().unwrap()["committed"], true);

    let historical_retry = router.dispatch(&request());
    assert!(
        historical_retry.error.as_ref().is_some_and(|error| {
            error
                .message
                .contains("checkpoint identity is historical and no longer current")
        }),
        "{:?}",
        historical_retry.error
    );

    let mut stale_finalized_checkpoint = checkpoint.clone();
    stale_finalized_checkpoint["checkpointStage"] = json!("finalized");
    let stale_finalization = router.dispatch(&WorkerRequest::new(
        "req-stale-context-finalization",
        "trace-stale-context-finalization",
        "session.persist_turn",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-stale-context-finalization",
            "messages": [],
            "clear_checkpoint": false,
            "context_metadata": {
                "contextCheckpoint": stale_finalized_checkpoint
            }
        }),
    ));
    assert!(stale_finalization.error.as_ref().is_some_and(|error| {
        error.message.contains("invalid contextId")
            && error.details["expected"] == "run-next-context:context:1"
            && error.details["actual"] == "run-commit-context:context:1"
    }));

    let conflict = router.dispatch(&WorkerRequest::new(
        "req-conflicting-context",
        "trace-conflicting-context",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-commit-context",
            "checkpoint": {
                "contextId": "run-commit-context:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "different" }]
            }
        }),
    ));
    assert!(conflict.error.is_some());
}

#[test]
fn session_clear_resets_latest_checkpoint_lineage_without_reviving_history() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let commit = |context_id: &str, summary: &str| {
        WorkerRequest::new(
            format!("req-{context_id}"),
            "trace-clear-checkpoint",
            "session.commit_context_checkpoint",
            json!({
                "session_id": "session-clear-checkpoint",
                "run_id": context_id,
                "checkpoint": {
                    "contextId": context_id,
                    "sourceContextId": null,
                    "windowNumber": 1,
                    "firstWindowId": "session-clear-checkpoint:context-window:0",
                    "previousWindowId": "session-clear-checkpoint:context-window:0",
                    "windowId": context_id,
                    "checkpointStage": "installed",
                    "replacementHistory": [{ "role": "system", "content": summary }]
                }
            }),
        )
    };

    let first = router.dispatch(&commit("context-before-clear", "old summary"));
    assert_eq!(first.error, None);
    let clear = router.dispatch(&WorkerRequest::new(
        "req-clear-checkpoint",
        "trace-clear-checkpoint",
        "session.clear",
        json!({ "session_id": "session-clear-checkpoint" }),
    ));
    assert_eq!(clear.error, None);

    let fresh = router.dispatch(&commit("context-after-clear", "fresh summary"));
    assert_eq!(fresh.error, None);
    assert_eq!(fresh.result.as_ref().unwrap()["committed"], true);

    let historical = router.dispatch(&commit("context-before-clear", "old summary"));
    assert!(historical.error.as_ref().is_some_and(|error| {
        error
            .message
            .contains("checkpoint identity is historical and no longer current")
    }));
    let context = router.dispatch(&WorkerRequest::new(
        "req-read-after-clear-checkpoint",
        "trace-clear-checkpoint",
        "session.get_agent_context",
        json!({ "session_id": "session-clear-checkpoint", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][0]["content"],
        "fresh summary"
    );
}

#[test]
fn session_checkpoint_ordinal_index_self_heals_from_canonical_rollout() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let committed = router.dispatch(&WorkerRequest::new(
        "req-checkpoint-position",
        "trace-checkpoint-position",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-checkpoint-position",
            "run_id": "run-checkpoint-position",
            "checkpoint": {
                "contextId": "context-position",
                "sourceContextId": null,
                "windowNumber": 1,
                "firstWindowId": "session-checkpoint-position:context-window:0",
                "previousWindowId": "session-checkpoint-position:context-window:0",
                "windowId": "context-position",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "indexed summary" }]
            }
        }),
    ));
    assert_eq!(committed.error, None);

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(state_path).unwrap();
    connection
        .execute("UPDATE latest_context_checkpoints SET ordinal = 999", [])
        .unwrap();
    drop(connection);

    let context = router.dispatch(&WorkerRequest::new(
        "req-checkpoint-position-read",
        "trace-checkpoint-position",
        "session.get_agent_context",
        json!({ "session_id": "session-checkpoint-position", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][0]["content"],
        "indexed summary"
    );
    let consistency = router.dispatch(&WorkerRequest::new(
        "req-checkpoint-position-check",
        "trace-checkpoint-position",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn session_agent_context_self_heals_after_canonical_rollout_advances() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-head-mismatch",
            "run-head-mismatch",
            vec![json!({ "role": "user", "content": "indexed message" })],
            None,
        )
        .unwrap();

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(state_path).unwrap();
    let thread_path = connection
        .query_row(
            "SELECT thread_path FROM threads WHERE session_id = ?1",
            ["session-head-mismatch"],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    drop(connection);
    let next_ordinal = std::fs::read_to_string(&thread_path)
        .unwrap()
        .lines()
        .count() as u64;
    let external_line = crate::worker_thread_log::ThreadLogLine {
        timestamp: "2026-07-17T10:00:00.000Z".to_string(),
        ordinal: Some(next_ordinal),
        item: crate::worker_thread_log::ThreadLogItem::ResponseItem(
            crate::worker_rollout::ResponseItem::from_value(
                json!({ "role": "assistant", "content": "external append" }),
            )
            .unwrap(),
        ),
    };
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&thread_path)
        .unwrap();
    writeln!(file, "{}", serde_json::to_string(&external_line).unwrap()).unwrap();
    drop(file);

    let context = router.dispatch(&WorkerRequest::new(
        "req-head-mismatch-read",
        "trace-head-mismatch",
        "session.get_agent_context",
        json!({ "session_id": "session-head-mismatch", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][1]["content"],
        "external append"
    );
}

#[test]
fn session_agent_context_fast_path_does_not_scan_unrelated_journals() {
    let fixture = WorkspaceFixture::new();
    let router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    for (session_id, run_id, content) in [
        ("session-fast-target", "run-fast-target", "target message"),
        ("session-fast-other", "run-fast-other", "other message"),
    ] {
        router
            .thread_log
            .persist_session_turn(
                session_id,
                run_id,
                vec![json!({ "role": "user", "content": content })],
                None,
            )
            .unwrap();
    }

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(state_path).unwrap();
    let unrelated_path = connection
        .query_row(
            "SELECT thread_path FROM threads WHERE session_id = ?1",
            ["session-fast-other"],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    drop(connection);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(unrelated_path)
        .unwrap();
    writeln!(file, "not-json").unwrap();
    drop(file);

    let context = router
        .thread_log
        .get_agent_context("session-fast-target", 50)
        .unwrap()
        .unwrap();
    assert_eq!(context.messages[0]["content"], "target message");
}

#[test]
fn session_context_checkpoint_commit_recovers_transient_index_failure() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-index-retry",
            "run-before-index-retry",
            vec![json!({ "role": "user", "content": "old context" })],
            None,
        )
        .unwrap();
    router.thread_log.fail_next_state_index_upserts(1);

    let committed = router.dispatch(&WorkerRequest::new(
        "req-index-retry",
        "trace-index-retry",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-index-retry",
            "run_id": "run-index-retry",
            "checkpoint": {
                "contextId": "run-index-retry:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "recovered summary" }]
            }
        }),
    ));

    assert_eq!(committed.error, None);
    assert_eq!(committed.result.as_ref().unwrap()["committed"], true);
    assert_eq!(
        committed.result.as_ref().unwrap()["indexSynchronized"],
        true
    );
    assert_eq!(committed.result.as_ref().unwrap()["indexRecovered"], true);
    assert!(committed.result.as_ref().unwrap()["diagnostics"]
        .as_array()
        .is_some_and(|diagnostics| !diagnostics.is_empty()));
    let consistency = router.dispatch(&WorkerRequest::new(
        "req-index-retry-check",
        "trace-index-retry-check",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn session_context_checkpoint_commit_reports_degraded_index_without_losing_journal() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-index-degraded",
            "run-before-index-degraded",
            vec![json!({ "role": "user", "content": "old context" })],
            None,
        )
        .unwrap();
    router.thread_log.fail_next_state_index_upserts(2);

    let committed = router.dispatch(&WorkerRequest::new(
        "req-index-degraded",
        "trace-index-degraded",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-index-degraded",
            "run_id": "run-index-degraded",
            "checkpoint": {
                "contextId": "run-index-degraded:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "durable summary" }]
            }
        }),
    ));

    assert_eq!(committed.error, None);
    assert_eq!(committed.result.as_ref().unwrap()["committed"], true);
    assert_eq!(
        committed.result.as_ref().unwrap()["indexSynchronized"],
        false
    );
    assert_eq!(committed.result.as_ref().unwrap()["indexRecovered"], false);
    assert!(committed.result.as_ref().unwrap()["diagnostics"][0]
        .as_str()
        .is_some_and(|message| message.contains("checkpoint is durable")));

    let consistency = router.dispatch(&WorkerRequest::new(
        "req-index-degraded-check",
        "trace-index-degraded-check",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "diverged");

    let repair = router.dispatch(&WorkerRequest::new(
        "req-index-degraded-repair",
        "trace-index-degraded-repair",
        "session.persistence.repair",
        json!({ "mode": "rebuild_index" }),
    ));
    assert_eq!(repair.error, None);
    assert_eq!(repair.result.as_ref().unwrap()["after"]["status"], "clean");
    let context = router.dispatch(&WorkerRequest::new(
        "req-index-degraded-context",
        "trace-index-degraded-context",
        "session.get_agent_context",
        json!({ "session_id": "session-index-degraded", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][0]["content"],
        "durable summary"
    );
}

#[test]
fn session_delete_removes_thread_log_only_session() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-delete-thread-log-persist",
        "trace-delete-thread-log",
        "session.persist_turn",
        json!({
            "session_id": "session-delete-thread-log",
            "run_id": "run-delete-thread-log",
            "messages": [
                { "role": "user", "content": "delete me", "messageId": "user-delete-thread-log" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);
    let delete = router.dispatch(&WorkerRequest::new(
        "req-delete-thread-log",
        "trace-delete-thread-log",
        "session.delete",
        json!({ "session_id": "session-delete-thread-log" }),
    ));
    assert_eq!(delete.error, None);
    assert_eq!(delete.result.as_ref().unwrap()["deleted"], true);

    let list = router.dispatch(&WorkerRequest::new(
        "req-delete-thread-log-list",
        "trace-delete-thread-log",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert!(list.result.as_ref().unwrap().as_array().unwrap().is_empty());
}

#[test]
fn session_clear_clears_thread_log_history() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-clear-thread-log-persist",
        "trace-clear-thread-log",
        "session.persist_turn",
        json!({
            "session_id": "session-clear-thread-log",
            "run_id": "run-clear-thread-log",
            "messages": [
                { "role": "user", "content": "clear me", "messageId": "user-clear-thread-log" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);
    let clear = router.dispatch(&WorkerRequest::new(
        "req-clear-thread-log",
        "trace-clear-thread-log",
        "session.clear",
        json!({ "session_id": "session-clear-thread-log" }),
    ));
    assert_eq!(clear.error, None);
    assert_eq!(clear.result.as_ref().unwrap()["messages_before"], 1);

    let history = router.dispatch(&WorkerRequest::new(
        "req-clear-thread-log-history",
        "trace-clear-thread-log",
        "session.get_history",
        json!({ "session_id": "session-clear-thread-log", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert!(history.result.as_ref().unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn session_clear_rebuilds_thread_log_projection_without_stale_token_usage() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-clear-rebuild-persist",
            "trace-clear-rebuild",
            "session.persist_turn",
            json!({
                "session_id": "session-clear-rebuild",
                "run_id": "run-clear-rebuild",
                "messages": [
                    { "role": "user", "content": "clear me", "messageId": "user-clear-rebuild" },
                    { "role": "assistant", "content": "ok", "messageId": "assistant-clear-rebuild" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
        router
            .thread_log
            .append_token_count(
                "session-clear-rebuild",
                crate::worker_thread_log::TokenUsageInfo {
                    total_token_usage: crate::worker_thread_log::TokenUsage {
                        input_tokens: 1010,
                        cached_input_tokens: 0,
                        output_tokens: 162,
                        reasoning_output_tokens: 0,
                        total_tokens: 1172,
                    },
                    last_token_usage: crate::worker_thread_log::TokenUsage {
                        input_tokens: 10,
                        cached_input_tokens: 0,
                        output_tokens: 162,
                        reasoning_output_tokens: 0,
                        total_tokens: 172,
                    },
                    model_context_window: Some(128000),
                },
            )
            .unwrap();
        let clear = router.dispatch(&WorkerRequest::new(
            "req-clear-rebuild-clear",
            "trace-clear-rebuild",
            "session.clear",
            json!({ "session_id": "session-clear-rebuild" }),
        ));
        assert_eq!(clear.error, None);
    }

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();

    let list = router.dispatch(&WorkerRequest::new(
        "req-clear-rebuild-list",
        "trace-clear-rebuild",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()[0]["extra"]["tokensUsed"], 0);

    let history = router.dispatch(&WorkerRequest::new(
        "req-clear-rebuild-history",
        "trace-clear-rebuild",
        "session.get_history",
        json!({ "session_id": "session-clear-rebuild", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert!(history.result.as_ref().unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn session_patch_metadata_updates_thread_log_list_projection() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log-persist",
        "trace-patch-thread-log",
        "session.persist_turn",
        json!({
            "session_id": "session-patch-thread-log",
            "run_id": "run-patch-thread-log",
            "messages": [
                { "role": "user", "content": "rename me", "messageId": "user-patch-thread-log" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);
    let patch = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log",
        "trace-patch-thread-log",
        "session.patch_metadata",
        json!({
            "session_id": "session-patch-thread-log",
            "metadata": { "title": "Thread log title" }
        }),
    ));
    assert_eq!(patch.error, None);
    assert_eq!(patch.result.as_ref().unwrap()["title"], "Thread log title");

    let list = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log-list",
        "trace-patch-thread-log",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["title"],
        "Thread log title"
    );
}

#[test]
fn session_patch_metadata_allows_thread_log_only_session() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-patch-thread-log-only",
            "run-patch-thread-log-only",
            vec![json!({
                "role": "user",
                "content": "rename me",
                "messageId": "user-patch-thread-log-only"
            })],
            None,
        )
        .unwrap();

    let patch = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log-only",
        "trace-patch-thread-log-only",
        "session.patch_metadata",
        json!({
            "session_id": "session-patch-thread-log-only",
            "metadata": { "title": "Thread log only title" }
        }),
    ));

    assert_eq!(patch.error, None);
    assert_eq!(
        patch.result.as_ref().unwrap()["title"],
        "Thread log only title"
    );
}

#[test]
fn session_patch_metadata_prefers_thread_log_over_legacy_persistence() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "session-patch-legacy-error".to_string();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-patch-legacy-error",
            "run-patch-legacy-error",
            vec![json!({
                "role": "user",
                "content": "rename me",
                "messageId": "user-patch-legacy-error"
            })],
            None,
        )
        .unwrap();
    let sqlite_path = fixture.root.join("sessions").join("sessions.sqlite");
    std::fs::create_dir_all(&sqlite_path).expect("sqlite path should be blockable");

    let patch = router.dispatch(&WorkerRequest::new(
        "req-patch-legacy-error",
        "trace-patch-legacy-error",
        "session.patch_metadata",
        json!({
            "session_id": "session-patch-legacy-error",
            "metadata": { "title": "Should not hide legacy failure" }
        }),
    ));

    assert_eq!(
        patch.result.as_ref().unwrap()["title"],
        "Should not hide legacy failure"
    );
    assert!(patch.error.is_none());
}

#[test]
fn dispatches_thread_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-create",
        "trace-thread-create",
        "thread.create",
        json!({
            "title": "Reactbits research",
            "sessionKey": "session-1",
            "metadata": {
                "tags": ["ui", "agent"],
                "model": "deepseek-v4-flash"
            }
        }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .expect("thread id should be present")
        .to_string();

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-append",
        "trace-thread-append",
        "thread.append_items",
        json!({
            "threadId": thread_id,
            "items": [{
                "itemId": "",
                "threadId": "",
                "runId": "run-1",
                "turnId": "turn-1",
                "sequence": 0,
                "createdAt": "",
                "kind": {
                    "type": "user_message",
                    "payload": { "text": "Summarize a document" }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);
    assert_eq!(append.result.as_ref().unwrap()["items"][0]["sequence"], 1);

    let search = router.dispatch(&WorkerRequest::new(
        "req-thread-search",
        "trace-thread-search",
        "thread.search",
        json!({ "query": "summarize" }),
    ));
    assert_eq!(search.error, None);
    assert_eq!(
        search.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-read",
        "trace-thread-read",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-archive",
        "trace-thread-archive",
        "thread.archive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");

    let list = router.dispatch(&WorkerRequest::new(
        "req-thread-list",
        "trace-thread-list",
        "thread.list",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()["threads"], json!([]));
}

#[test]
fn thread_list_does_not_import_legacy_sessions_at_request_time() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "session:websocket-1".to_string();
    legacy_session.title = "Legacy Websocket Session".to_string();
    legacy_session.updated_at = "2026-06-09T11:00:00Z".to_string();
    legacy_session.extra = json!({
        "mode": "desktop",
        "metadata": {
            "topic": "reactbits"
        },
        "messages": [
            {
                "role": "user",
                "content": "查看 reactbits 内容",
                "timestamp": "2026-06-09T10:58:00Z"
            },
            {
                "role": "assistant",
                "content": "整理 chat layout 文档",
                "timestamp": "2026-06-09T10:59:00Z"
            }
        ]
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session.clone()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let list = router.dispatch(&WorkerRequest::new(
        "req-thread-list-legacy-session",
        "trace-thread-legacy-session",
        "thread.list",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()["threads"], json!([]));
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_none());
}

#[test]
fn thread_api_survives_restart_from_rollout_without_legacy_stores() {
    let fixture = WorkspaceFixture::new();
    let policy = CapabilityPolicy::new([
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]);
    {
        let mut router =
            WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone());
        let create = router.dispatch(&WorkerRequest::new(
            "req-rollout-thread-create",
            "trace-rollout-thread",
            "thread.create",
            json!({
                "threadId": "thread-rollout-restart",
                "title": "Rollout restart",
                "sessionKey": "session-rollout-restart"
            }),
        ));
        assert_eq!(create.error, None);
        let append = router.dispatch(&WorkerRequest::new(
            "req-rollout-thread-append",
            "trace-rollout-thread",
            "thread.append_items",
            json!({
                "threadId": "thread-rollout-restart",
                "items": [{
                    "itemId": "thread-rollout-restart:item:user",
                    "threadId": "",
                    "runId": "run-rollout-restart",
                    "turnId": "turn-rollout-restart",
                    "sequence": 0,
                    "createdAt": "2026-07-18T00:00:00Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "persisted through rollout" }
                    }
                }]
            }),
        ));
        assert_eq!(append.error, None);
    }

    let mut restarted = WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy);
    let read = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-thread-read-after-restart",
        "trace-rollout-thread",
        "thread.read",
        json!({ "threadId": "thread-rollout-restart" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["thread"]["sessionKey"],
        "session-rollout-restart"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
        "persisted through rollout"
    );
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_some());
    assert!(fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    assert!(!fixture
        .root
        .join("sessions")
        .join("sessions.sqlite")
        .exists());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("thread-store.jsonl")
        .exists());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("threads")
        .join("threads.sqlite")
        .exists());
}

#[test]
fn dispatches_thread_lifecycle_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-create",
        "trace-thread-lifecycle",
        "thread.create",
        json!({ "title": "Lifecycle" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-archive",
        "trace-thread-lifecycle",
        "thread.archive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");
    let archived_path = first_archived_thread_log_file(&fixture.root);
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_none());

    let resume = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-resume",
        "trace-thread-lifecycle",
        "thread.resume",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(resume.error, None);
    assert_eq!(resume.result.as_ref().unwrap()["thread"]["status"], "empty");
    assert_eq!(resume.result.as_ref().unwrap()["activeRun"], json!(null));
    assert!(!archived_path.exists());
    assert!(first_thread_log_file(&fixture.root).exists());

    let status = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-status",
        "trace-thread-lifecycle",
        "thread.status",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(status.error, None);
    assert_eq!(
        status.result.as_ref().unwrap()["thread"]["threadId"],
        thread_id
    );
    assert_eq!(status.result.as_ref().unwrap()["children"], json!([]));

    let rearchive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-rearchive",
        "trace-thread-lifecycle",
        "thread.archive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(rearchive.error, None);
    let unarchive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-unarchive",
        "trace-thread-lifecycle",
        "thread.unarchive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(unarchive.error, None);
    assert_eq!(unarchive.result.as_ref().unwrap()["status"], "empty");

    let delete = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-delete",
        "trace-thread-lifecycle",
        "thread.delete",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(delete.error, None);
    assert_eq!(delete.result.as_ref().unwrap()["deleted"], true);

    let read_deleted = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-read-deleted",
        "trace-thread-lifecycle",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(
        read_deleted.error.as_ref().unwrap().code,
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
}

#[test]
fn dispatches_thread_resume_from_checkpoint_id() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint-create",
        "trace-thread-resume-checkpoint",
        "thread.create",
        json!({ "threadId": "thread-resume-checkpoint", "title": "Resume checkpoint" }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint-append",
        "trace-thread-resume-checkpoint",
        "thread.append_items",
        json!({
            "threadId": "thread-resume-checkpoint",
            "items": [
                {
                    "itemId": "thread-resume-checkpoint-before",
                    "threadId": "",
                    "runId": "run-resume-checkpoint",
                    "turnId": "turn-resume-checkpoint",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "Before checkpoint" }
                    }
                },
                {
                    "itemId": "thread-resume-checkpoint-marker",
                    "threadId": "",
                    "runId": "run-resume-checkpoint",
                    "turnId": "turn-resume-checkpoint",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:02Z",
                    "kind": {
                        "type": "checkpoint_created",
                        "payload": {
                            "checkpointId": "checkpoint-resume",
                            "runId": "run-resume-checkpoint",
                            "restorePayload": { "phase": "awaiting_tool" }
                        }
                    }
                },
                {
                    "itemId": "thread-resume-checkpoint-after",
                    "threadId": "",
                    "runId": "run-resume-checkpoint",
                    "turnId": "turn-resume-checkpoint",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:03Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "After checkpoint" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint-archive",
        "trace-thread-resume-checkpoint",
        "thread.archive",
        json!({ "threadId": "thread-resume-checkpoint" }),
    ));
    assert_eq!(archive.error, None);

    let resume = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint",
        "trace-thread-resume-checkpoint",
        "thread.resume",
        json!({
            "threadId": "thread-resume-checkpoint",
            "checkpointId": "checkpoint-resume"
        }),
    ));
    assert_eq!(resume.error, None);
    let items = resume.result.as_ref().unwrap()["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["sequence"], 2);
    assert_eq!(items[0]["kind"]["type"], "checkpoint_created");
    assert_eq!(items[1]["sequence"], 3);
    assert_eq!(
        resume.result.as_ref().unwrap()["latestCheckpoint"]["checkpointId"],
        "checkpoint-resume"
    );
    assert_eq!(resume.result.as_ref().unwrap()["thread"]["status"], "idle");
}

#[test]
fn dispatches_thread_archive_children_policy() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-parent",
        "trace-thread-archive-tree",
        "thread.create",
        json!({
            "threadId": "thread-archive-tree-parent",
            "title": "Parent",
            "source": "agent_run"
        }),
    ));
    assert_eq!(parent.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-child",
        "trace-thread-archive-tree",
        "thread.create",
        json!({
            "threadId": "thread-archive-tree-child",
            "title": "Child",
            "parentThreadId": "thread-archive-tree-parent",
            "source": "subagent"
        }),
    ));
    assert_eq!(child.error, None);

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-archive",
        "trace-thread-archive-tree",
        "thread.archive",
        json!({
            "threadId": "thread-archive-tree-parent",
            "archiveChildren": true
        }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");

    let children = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-children",
        "trace-thread-archive-tree",
        "thread.list",
        json!({
            "parentThreadId": "thread-archive-tree-parent",
            "includeArchived": true
        }),
    ));
    assert_eq!(children.error, None);
    assert_eq!(
        children.result.as_ref().unwrap()["threads"][0]["threadId"],
        "thread-archive-tree-child"
    );
    assert_eq!(
        children.result.as_ref().unwrap()["threads"][0]["status"],
        "archived"
    );

    let default_children = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-default-children",
        "trace-thread-archive-tree",
        "thread.list",
        json!({ "parentThreadId": "thread-archive-tree-parent" }),
    ));
    assert_eq!(default_children.error, None);
    assert_eq!(
        default_children.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let unarchive = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-unarchive",
        "trace-thread-archive-tree",
        "thread.unarchive",
        json!({
            "threadId": "thread-archive-tree-parent",
            "unarchiveChildren": true
        }),
    ));
    assert_eq!(unarchive.error, None);
    assert_eq!(unarchive.result.as_ref().unwrap()["status"], "empty");

    let unarchived_child = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-read-unarchived-child",
        "trace-thread-archive-tree",
        "thread.read",
        json!({ "threadId": "thread-archive-tree-child" }),
    ));
    assert_eq!(unarchived_child.error, None);
    assert_eq!(
        unarchived_child.result.as_ref().unwrap()["thread"]["status"],
        "empty"
    );
}

#[test]
fn dispatches_thread_fork_include_children_policy() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-parent",
        "trace-thread-fork-tree",
        "thread.create",
        json!({
            "threadId": "thread-fork-tree-parent",
            "title": "Fork parent",
            "source": "agent_run"
        }),
    ));
    assert_eq!(parent.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-child",
        "trace-thread-fork-tree",
        "thread.create",
        json!({
            "threadId": "thread-fork-tree-child",
            "title": "Fork child",
            "parentThreadId": "thread-fork-tree-parent",
            "source": "subagent"
        }),
    ));
    assert_eq!(child.error, None);
    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-child-append",
        "trace-thread-fork-tree",
        "thread.append_items",
        json!({
            "threadId": "thread-fork-tree-child",
            "items": [{
                "itemId": "thread-fork-tree-child-item",
                "threadId": "",
                "runId": "run-fork-child",
                "turnId": "turn-fork-child",
                "sequence": 0,
                "createdAt": "2026-07-05T00:00:01Z",
                "kind": {
                    "type": "user_message",
                    "payload": { "text": "Child context" }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);

    let fork = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-fork",
        "trace-thread-fork-tree",
        "thread.fork",
        json!({
            "threadId": "thread-fork-tree-parent",
            "title": "Forked parent",
            "includeChildren": true
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let children = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-children",
        "trace-thread-fork-tree",
        "thread.list",
        json!({ "parentThreadId": fork_thread_id }),
    ));
    assert_eq!(children.error, None);
    let child_threads = children.result.as_ref().unwrap()["threads"]
        .as_array()
        .unwrap();
    assert_eq!(child_threads.len(), 1);
    assert_eq!(child_threads[0]["title"], "Fork child");
    assert_eq!(child_threads[0]["parentThreadId"], fork_thread_id);
    let copied_child_thread_id = child_threads[0]["threadId"].as_str().unwrap();
    assert_ne!(copied_child_thread_id, "thread-fork-tree-child");

    let copied_child = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-child-read",
        "trace-thread-fork-tree",
        "thread.read",
        json!({ "threadId": copied_child_thread_id }),
    ));
    assert_eq!(copied_child.error, None);
    assert_eq!(
        copied_child.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
        "Child context"
    );
}

#[test]
fn dispatches_thread_fork_idempotently_by_client_event_id() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-create",
        "trace-thread-direct-fork-idempotent",
        "thread.create",
        json!({ "threadId": "thread-direct-fork-source", "title": "Fork source" }),
    ));
    assert_eq!(create.error, None);

    let fork = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-fork",
        "trace-thread-direct-fork-idempotent",
        "thread.fork",
        json!({
            "threadId": "thread-direct-fork-source",
            "clientEventId": "direct-fork-client-1",
            "title": "Direct fork"
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(fork.result.as_ref().unwrap()["title"], "Direct fork");

    let fork_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-fork-retry",
        "trace-thread-direct-fork-idempotent",
        "thread.fork",
        json!({
            "threadId": "thread-direct-fork-source",
            "clientEventId": "direct-fork-client-1",
            "title": "Retry must not fork"
        }),
    ));
    assert_eq!(fork_retry.error, None);
    assert_eq!(
        fork_retry.result.as_ref().unwrap()["threadId"],
        fork_thread_id
    );
    assert_eq!(fork_retry.result.as_ref().unwrap()["title"], "Direct fork");

    let children = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-children",
        "trace-thread-direct-fork-idempotent",
        "thread.list",
        json!({ "parentThreadId": "thread-direct-fork-source", "includeChildThreads": true }),
    ));
    assert_eq!(children.error, None);
    let child_threads = children.result.as_ref().unwrap()["threads"]
        .as_array()
        .unwrap();
    assert_eq!(child_threads.len(), 1);
    assert_eq!(child_threads[0]["threadId"], fork_thread_id);
    assert_eq!(child_threads[0]["source"], "fork");
}

#[test]
fn thread_fork_inherits_effective_history_from_canonical_rollout() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .unwrap();
    let create = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-create",
        "trace-rollout-fork",
        "thread.create",
        json!({
            "threadId": "thread-rollout-fork-source",
            "title": "Canonical fork source"
        }),
    ));
    assert_eq!(create.error, None);
    for (run_id, content) in [
        ("run-rollout-fork-1", "keep"),
        ("run-rollout-fork-2", "drop"),
    ] {
        let persist = router.dispatch(&WorkerRequest::new(
            format!("req-rollout-fork-{run_id}"),
            "trace-rollout-fork",
            "session.persist_turn",
            json!({
                "session_id": "thread-rollout-fork-source",
                "run_id": run_id,
                "messages": [
                    { "role": "user", "content": format!("{content} user") },
                    { "role": "assistant", "content": format!("{content} assistant") }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let rollback = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-rollback",
        "trace-rollout-fork",
        "thread.rollback",
        json!({
            "threadId": "thread-rollout-fork-source",
            "numTurns": 1
        }),
    ));
    assert_eq!(rollback.error, None);

    let fork = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork",
        "trace-rollout-fork",
        "thread.fork",
        json!({
            "threadId": "thread-rollout-fork-source",
            "title": "Canonical fork"
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(fork.result.as_ref().unwrap()["sessionKey"], fork_thread_id);

    let history = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-history",
        "trace-rollout-fork",
        "session.get_history",
        json!({ "session_id": fork_thread_id, "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    let contents = history.result.as_ref().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(contents, vec!["keep user", "keep assistant"]);
}

#[test]
fn dispatches_thread_runtime_turn_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-create",
        "trace-thread-runtime",
        "thread.create",
        json!({ "title": "Runtime" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-start",
        "trace-thread-runtime",
        "thread.start_turn",
        json!({
            "threadId": thread_id,
            "runId": "run-runtime-1",
            "input": { "text": "Summarize this document" },
            "model": "deepseek-v4-flash",
            "provider": "tinybot"
        }),
    ));
    assert_eq!(start.error, None);
    let start_result = start.result.as_ref().unwrap();
    assert_eq!(start_result["run"]["runId"], "run-runtime-1");
    assert_eq!(start_result["run"]["status"], "running");
    assert_eq!(start_result["run"]["active"], true);
    assert_eq!(
        start_result["appendedItems"]
            .as_array()
            .expect("start should append items")
            .len(),
        2
    );
    assert_eq!(start_result["snapshot"]["thread"]["status"], "running");

    let continue_turn = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-continue",
        "trace-thread-runtime",
        "thread.continue_turn",
        json!({
            "threadId": thread_id,
            "input": { "approval": "continue" }
        }),
    ));
    assert_eq!(continue_turn.error, None);
    assert_eq!(
        continue_turn.result.as_ref().unwrap()["run"]["runId"],
        "run-runtime-1"
    );
    assert_eq!(
        continue_turn.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "event"
    );

    let status_running = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-status-running",
        "trace-thread-runtime",
        "thread.status",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(status_running.error, None);
    assert_eq!(
        status_running.result.as_ref().unwrap()["activeRun"]["runId"],
        "run-runtime-1"
    );

    let interrupt = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-interrupt",
        "trace-thread-runtime",
        "thread.interrupt",
        json!({
            "threadId": thread_id,
            "reason": "user requested stop"
        }),
    ));
    assert_eq!(interrupt.error, None);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "cancelled"
    );
    assert_eq!(interrupt.result.as_ref().unwrap()["run"]["active"], false);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-read",
        "trace-thread-runtime",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["items"]
            .as_array()
            .expect("runtime items should be readable")
            .len(),
        4
    );
    assert_eq!(read.result.as_ref().unwrap()["activeRun"], json!(null));
}

#[test]
fn dispatches_thread_runtime_turn_requests_idempotently() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-create",
        "trace-thread-runtime-idempotent",
        "thread.create",
        json!({ "threadId": "thread-runtime-idempotent", "title": "Runtime idempotency" }),
    ));
    assert_eq!(create.error, None);

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-start",
        "trace-thread-runtime-idempotent",
        "thread.start_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-start-client-1",
            "runId": "run-direct-original",
            "input": { "text": "Original prompt" },
            "model": "deepseek-v4-flash",
            "provider": "tinybot"
        }),
    ));
    assert_eq!(start.error, None);
    let start_items = start.result.as_ref().unwrap()["appendedItems"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(
        start.result.as_ref().unwrap()["run"]["runId"],
        "run-direct-original"
    );

    let start_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-start-retry",
        "trace-thread-runtime-idempotent",
        "thread.start_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-start-client-1",
            "runId": "run-direct-retry",
            "input": { "text": "Retry must not append" },
            "model": "retry-model",
            "provider": "retry-provider"
        }),
    ));
    assert_eq!(start_retry.error, None);
    assert_eq!(
        start_retry.result.as_ref().unwrap()["run"]["runId"],
        "run-direct-original"
    );
    assert_eq!(
        start_retry.result.as_ref().unwrap()["appendedItems"]
            .as_array()
            .unwrap(),
        &start_items
    );
    assert_eq!(
        start_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["text"],
        "Original prompt"
    );

    let continue_turn = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-continue",
        "trace-thread-runtime-idempotent",
        "thread.continue_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-continue-client-1",
            "input": { "approval": "continue" }
        }),
    ));
    assert_eq!(continue_turn.error, None);
    let continue_items = continue_turn.result.as_ref().unwrap()["appendedItems"]
        .as_array()
        .unwrap()
        .clone();

    let interrupt = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-interrupt",
        "trace-thread-runtime-idempotent",
        "thread.interrupt",
        json!({
            "threadId": "thread-runtime-idempotent",
            "reason": "stop before retry"
        }),
    ));
    assert_eq!(interrupt.error, None);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );

    let continue_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-continue-retry",
        "trace-thread-runtime-idempotent",
        "thread.continue_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-continue-client-1",
            "input": { "approval": "retry must replay" }
        }),
    ));
    assert_eq!(continue_retry.error, None);
    assert_eq!(
        continue_retry.result.as_ref().unwrap()["run"]["runId"],
        "run-direct-original"
    );
    assert_eq!(
        continue_retry.result.as_ref().unwrap()["appendedItems"]
            .as_array()
            .unwrap(),
        &continue_items
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-read",
        "trace-thread-runtime-idempotent",
        "thread.read",
        json!({ "threadId": "thread-runtime-idempotent" }),
    ));
    assert_eq!(read.error, None);
    let items = read.result.as_ref().unwrap()["items"].as_array().unwrap();
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["kind"]["payload"]["text"], "Original prompt");
    assert_eq!(items[1]["kind"]["type"], "agent_run_started");
    assert_eq!(items[2]["kind"]["type"], "event");
    assert_eq!(items[3]["kind"]["type"], "cancelled");
}

#[test]
fn dispatches_thread_events_after_cursor() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-events-create",
        "trace-thread-events",
        "thread.create",
        json!({ "title": "Event feed" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-events-start",
        "trace-thread-events",
        "thread.start_turn",
        json!({
            "threadId": thread_id,
            "runId": "run-events-1",
            "input": "Summarize a document"
        }),
    ));
    assert_eq!(start.error, None);

    let first_page = router.dispatch(&WorkerRequest::new(
        "req-thread-events-first-page",
        "trace-thread-events",
        "thread.events",
        json!({ "threadId": thread_id, "afterSequence": 0, "limit": 1 }),
    ));
    assert_eq!(first_page.error, None);
    assert_eq!(first_page.result.as_ref().unwrap()["threadId"], thread_id);
    assert_eq!(
        first_page.result.as_ref().unwrap()["thread"]["threadId"],
        thread_id
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["thread"]["status"],
        "running"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["activeRun"]["runId"],
        "run-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["runs"][0]["runId"],
        "run-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["runs"][0]["active"],
        true
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["items"][0]["sequence"],
        1
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["items"][0]["kind"]["type"],
        "user_message"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][0]["type"],
        "thread_snapshot"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][0]["thread"]["threadId"],
        thread_id
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][0]["activeRun"]["runId"],
        "run-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][1]["type"],
        "thread_status"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][1]["thread"]["status"],
        "running"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][1]["activeRun"]["runId"],
        "run-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][2]["type"],
        "item_appended"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][2]["sequence"],
        1
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][2]["item"]["kind"]["type"],
        "user_message"
    );
    assert_eq!(first_page.result.as_ref().unwrap()["nextCursor"], "1");

    let second_page = router.dispatch(&WorkerRequest::new(
        "req-thread-events-second-page",
        "trace-thread-events",
        "thread.events",
        json!({
            "threadId": thread_id,
            "cursor": first_page.result.as_ref().unwrap()["nextCursor"],
            "limit": 10
        }),
    ));
    assert_eq!(second_page.error, None);
    assert_eq!(
        second_page.result.as_ref().unwrap()["items"][0]["sequence"],
        2
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["items"][0]["kind"]["type"],
        "agent_run_started"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][0]["type"],
        "thread_snapshot"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][0]["activeRun"]["runId"],
        "run-events-1"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][1]["type"],
        "thread_status"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][2]["type"],
        "item_appended"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][2]["sequence"],
        2
    );
    assert_eq!(second_page.result.as_ref().unwrap()["nextCursor"], "2");

    let empty_page = router.dispatch(&WorkerRequest::new(
        "req-thread-events-empty-page",
        "trace-thread-events",
        "thread.events",
        json!({ "threadId": thread_id, "cursor": "2", "limit": 10 }),
    ));
    assert_eq!(empty_page.error, None);
    assert_eq!(
        empty_page.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][0]["type"],
        "thread_snapshot"
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][0]["activeRun"]["runId"],
        "run-events-1"
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][1]["type"],
        "thread_status"
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][1]["thread"]["threadId"],
        thread_id
    );
    assert_eq!(empty_page.result.as_ref().unwrap()["nextCursor"], "2");
}

#[test]
fn dispatches_tool_registry_list_with_capability_metadata() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::McpCall]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-list",
        "trace-tool-registry",
        "tool_registry.list",
        json!({}),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    let tools = result["tools"]
        .as_array()
        .expect("tools should be an array");
    assert!(tools.len() >= 8);
    assert_eq!(result["total"], tools.len());

    let shell = tools
        .iter()
        .find(|tool| tool["method"] == "shell.execute")
        .expect("shell.execute should be registered");
    assert_eq!(shell["namespace"], "shell");
    assert_eq!(shell["exposure"], "deferred");
    assert_eq!(shell["available"], false);
    assert_eq!(shell["requiredCapabilities"], json!(["shell.execute"]));
    assert_eq!(shell["approval"]["required"], true);
    assert_eq!(shell["approval"]["scope"], "command");

    let mcp = tools
        .iter()
        .find(|tool| tool["method"] == "mcp.call_tool")
        .expect("mcp.call_tool should be registered");
    assert_eq!(mcp["namespace"], "mcp");
    assert_eq!(mcp["dynamic"], true);
    assert_eq!(mcp["requiredCapabilities"], json!(["mcp.call"]));

    let write_file = tools
        .iter()
        .find(|tool| tool["method"] == "workspace.write_file")
        .expect("workspace.write_file should be registered");
    assert_eq!(
        write_file["requiredCapabilities"],
        json!(["fs.workspace.write", "approval.request"])
    );
    assert_eq!(write_file["approval"]["required"], true);
    assert_eq!(write_file["available"], false);
}

#[test]
fn dispatches_tool_registry_search_with_filters() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::ShellExecute]),
    );

    let shell = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-search-shell",
        "trace-tool-registry-search",
        "tool_registry.search",
        json!({ "query": "command" }),
    ));
    assert_eq!(shell.error, None);
    assert_eq!(shell.result.as_ref().unwrap()["query"], "command");
    let shell_tools = shell.result.as_ref().unwrap()["tools"]
        .as_array()
        .expect("command search should return shell tools");
    assert_eq!(shell.result.as_ref().unwrap()["total"], 2);
    assert!(shell_tools
        .iter()
        .any(|tool| tool["method"] == "shell.execute" && tool["available"] == true));
    assert!(shell_tools
        .iter()
        .any(|tool| tool["method"] == "exec_command" && tool["available"] == true));

    let memory = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-search-memory",
        "trace-tool-registry-search",
        "tool_registry.search",
        json!({
            "namespace": "memory",
            "availableOnly": true,
            "exposure": "model"
        }),
    ));
    assert_eq!(memory.error, None);
    let memory_tools = memory.result.as_ref().unwrap()["tools"]
        .as_array()
        .expect("memory tools should be an array");
    assert_eq!(memory_tools.len(), 2);
    assert!(memory_tools
        .iter()
        .all(|tool| tool["namespace"] == "memory"));
    assert!(memory_tools.iter().all(|tool| tool["available"] == true));

    let unavailable = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-search-unavailable",
        "trace-tool-registry-search",
        "tool_registry.search",
        json!({
            "namespace": "workspace",
            "availableOnly": true
        }),
    ));
    assert_eq!(unavailable.error, None);
    assert_eq!(unavailable.result.as_ref().unwrap()["total"], 0);
    assert!(unavailable.result.as_ref().unwrap()["tools"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn dispatches_permission_profile_current_with_tool_decisions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::FsWorkspaceWrite,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::MemoryRead,
        ]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-profile-current",
        "trace-permission-profile",
        "permission_profile.current",
        json!({}),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["profileId"], "local-worker");
    assert_eq!(result["approvalPolicy"], "on_request");
    assert_eq!(result["sandbox"]["mode"], "workspace_write");
    assert!(result["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|capability| capability["capability"] == "fs.workspace.read"
            && capability["granted"] == true
            && capability["scope"] == "workspace://current"));
    let read_file = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["toolId"] == "workspace.read_file")
        .expect("workspace.read_file decision should be present");
    assert_eq!(read_file["decision"], "allow");
    assert_eq!(read_file["requiresApproval"], false);
    let write_file = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["toolId"] == "workspace.write_file")
        .expect("workspace.write_file decision should be present");
    assert_eq!(write_file["decision"], "needs_approval");
    assert_eq!(write_file["requiresApproval"], true);
    assert_eq!(write_file["approval"]["scope"], "file");
    let shell = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["toolId"] == "shell.execute")
        .expect("shell.execute decision should be present");
    assert_eq!(shell["decision"], "deny");
    assert_eq!(shell["missingCapabilities"], json!(["shell.execute"]));
}

#[test]
fn dispatches_permission_profile_evaluate_tool_for_sensitive_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
        ]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-profile-evaluate-shell",
        "trace-permission-profile",
        "permission_profile.evaluate_tool",
        json!({
            "toolId": "shell.execute",
            "arguments": { "command": "cargo test --lib" },
            "sessionId": "session-1",
            "runId": "run-1"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["tool"]["toolId"], "shell.execute");
    assert_eq!(result["decision"], "needs_approval");
    assert_eq!(result["requiresApproval"], true);
    assert_eq!(result["approvalRequest"]["method"], "shell.execute");
    assert_eq!(result["approvalRequest"]["category"], "shell");
    assert_eq!(result["approvalRequest"]["risk"], "high");
    assert_eq!(
        result["approvalRequest"]["operation"]["toolName"],
        "shell.execute"
    );
    assert_eq!(
        result["approvalRequest"]["operation"]["arguments"],
        json!({ "command": "cargo test --lib" })
    );
    assert_eq!(
        result["approvalRequest"]["operation"]["effects"],
        result["approvalRequest"]["effects"]
    );
    assert_eq!(
        result["approvalRequest"]["effects"]["sandboxMode"],
        "unsandboxed"
    );
    assert_eq!(
        result["approvalRequest"]["effects"]["network"]["mode"],
        "unrestricted"
    );
    assert_eq!(result["approvalRequest"]["sessionId"], "session-1");
    assert_eq!(result["approvalRequest"]["runId"], "run-1");
}

#[test]
fn dispatches_permission_profile_evaluate_tool_denies_missing_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-profile-evaluate-denied",
        "trace-permission-profile",
        "permission_profile.evaluate_tool",
        json!({
            "toolId": "mcp.call_tool",
            "arguments": { "server": "docs", "tool": "search" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["tool"]["toolId"], "mcp.call_tool");
    assert_eq!(result["decision"], "deny");
    assert_eq!(result["requiresApproval"], true);
    assert_eq!(result["missingCapabilities"], json!(["mcp.call"]));
    assert!(result.get("approvalRequest").is_none());
}

#[test]
fn dispatches_permission_profile_request_tool_approval_records_thread_item() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-thread-create",
        "trace-permission-approval",
        "thread.create",
        json!({
            "threadId": "thread-permission-approval",
            "title": "Permission approval thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-thread-start",
        "trace-permission-approval",
        "thread.start_turn",
        json!({
            "threadId": "thread-permission-approval",
            "runId": "run-permission-approval",
            "turnId": "turn-permission-approval",
            "input": { "content": "run shell" }
        }),
    ));
    assert_eq!(start.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-request",
        "trace-permission-approval",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "threadId": "thread-permission-approval",
            "runId": "run-permission-approval",
            "turnId": "turn-permission-approval",
            "sessionId": "session-permission-approval",
            "arguments": { "command": "echo needs approval" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["status"], "awaiting_approval");
    assert_eq!(result["evaluation"]["decision"], "needs_approval");
    assert_eq!(result["approval"]["stopReason"], "awaiting_approval");
    assert_eq!(result["approval"]["category"], "shell");
    assert_eq!(result["appendedItems"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["appendedItems"][0]["kind"]["type"],
        "approval_requested"
    );
    assert_eq!(
        result["appendedItems"][0]["kind"]["payload"]["approvalId"],
        result["approval"]["approvalId"]
    );

    let snapshot = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-thread-snapshot",
        "trace-permission-approval",
        "thread.read",
        json!({ "threadId": "thread-permission-approval" }),
    ));
    assert_eq!(snapshot.error, None);
    let item_kinds = snapshot.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec!["user_message", "agent_run_started", "approval_requested"]
    );
}

#[test]
fn dispatches_permission_profile_resolve_tool_approval_records_thread_item() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-thread-create",
        "trace-permission-resolve",
        "thread.create",
        json!({
            "threadId": "thread-permission-resolve",
            "title": "Permission resolve thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-thread-start",
        "trace-permission-resolve",
        "thread.start_turn",
        json!({
            "threadId": "thread-permission-resolve",
            "runId": "run-permission-resolve",
            "turnId": "turn-permission-resolve",
            "input": { "content": "run shell" }
        }),
    ));
    assert_eq!(start.error, None);
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-request",
        "trace-permission-resolve",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "threadId": "thread-permission-resolve",
            "runId": "run-permission-resolve",
            "turnId": "turn-permission-resolve",
            "sessionId": "session-permission-resolve",
            "arguments": { "command": "echo resolve approval" }
        }),
    ));
    assert_eq!(request_response.error, None);
    let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_string();

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-decision",
        "trace-permission-resolve",
        "permission_profile.resolve_tool_approval",
        json!({
            "threadId": "thread-permission-resolve",
            "runId": "run-permission-resolve",
            "turnId": "turn-permission-resolve",
            "sessionId": "session-permission-resolve",
            "approvalId": approval_id,
            "approved": true,
            "scope": "once",
            "guidance": "approved for this run"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["status"], "approved");
    assert_eq!(result["resolution"]["status"], "approved");
    assert_eq!(result["appendedItems"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["appendedItems"][0]["kind"]["type"],
        "approval_resolved"
    );
    assert_eq!(
        result["appendedItems"][0]["kind"]["payload"]["approved"],
        true
    );
    assert_eq!(
        result["appendedItems"][0]["parentItemId"],
        request_response.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
    );
}

#[test]
fn permission_profile_resolved_tool_approval_allows_matching_sensitive_tool() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
        ]),
    );
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-permission-grant-request",
        "trace-permission-grant",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "runId": "run-permission-grant",
            "sessionId": "session-permission-grant",
            "arguments": { "command": "echo approval grant works" }
        }),
    ));
    assert_eq!(request_response.error, None);
    let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_string();
    let resolve_response = router.dispatch(&WorkerRequest::new(
        "req-permission-grant-resolve",
        "trace-permission-grant",
        "permission_profile.resolve_tool_approval",
        json!({
            "sessionId": "session-permission-grant",
            "approvalId": approval_id,
            "approved": true,
            "scope": "once"
        }),
    ));
    assert_eq!(resolve_response.error, None);

    let shell_response = router.dispatch(&WorkerRequest::new(
        "req-permission-grant-shell",
        "trace-permission-grant",
        "shell.execute",
        json!({
            "command": "echo approval grant works",
            "working_dir": ".",
            "timeout": 5,
            "session_id": "session-permission-grant",
            "run_id": "run-permission-grant"
        }),
    ));

    assert_eq!(shell_response.error, None);
    let result = shell_response.result.as_ref().unwrap();
    assert_eq!(result["exit_code"], 0);
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("approval grant works"));
}

#[test]
fn tool_executor_forwards_top_level_context_to_sensitive_tool() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
        ]),
    );
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-executor-grant-request",
        "trace-executor-grant",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "runId": "run-executor-grant",
            "sessionId": "session-executor-grant",
            "arguments": { "command": "echo executor grant works" }
        }),
    ));
    assert_eq!(request_response.error, None);
    let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_string();
    let resolve_response = router.dispatch(&WorkerRequest::new(
        "req-executor-grant-resolve",
        "trace-executor-grant",
        "permission_profile.resolve_tool_approval",
        json!({
            "sessionId": "session-executor-grant",
            "approvalId": approval_id,
            "approved": true,
            "scope": "once"
        }),
    ));
    assert_eq!(resolve_response.error, None);

    let executor_response = router.dispatch(&WorkerRequest::new(
        "req-executor-grant-shell",
        "trace-executor-grant",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "sessionId": "session-executor-grant",
            "runId": "run-executor-grant",
            "arguments": {
                "command": "echo executor grant works",
                "working_dir": ".",
                "timeout": 5
            }
        }),
    ));

    assert_eq!(executor_response.error, None);
    let result = executor_response.result.as_ref().unwrap();
    assert_eq!(result["result"]["exit_code"], 0);
    assert!(result["result"]["content"]
        .as_str()
        .unwrap()
        .contains("executor grant works"));
}

#[test]
fn dispatches_thread_restore_checkpoint_from_thread_history() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-create",
        "trace-thread-restore",
        "thread.create",
        json!({
            "threadId": "thread-restore-checkpoint",
            "title": "Restore checkpoint thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-start",
        "trace-thread-restore",
        "thread.start_turn",
        json!({
            "threadId": "thread-restore-checkpoint",
            "runId": "run-restore-checkpoint",
            "turnId": "turn-restore-checkpoint",
            "input": { "content": "prepare checkpoint" }
        }),
    ));
    assert_eq!(start.error, None);
    let checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-checkpoint",
        "trace-thread-restore",
        "thread.apply_op",
        json!({
            "threadId": "thread-restore-checkpoint",
            "op": {
                "type": "checkpoint",
                "runId": "run-restore-checkpoint",
                "turnId": "turn-restore-checkpoint",
                "checkpointId": "checkpoint-restore-1",
                "label": "Before tool execution",
                "restorePayload": {
                    "phase": "before_tool",
                    "pendingToolCalls": [{ "id": "call-1", "name": "workspace.read_file" }]
                }
            }
        }),
    ));
    assert_eq!(checkpoint.error, None);
    let after_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-after-checkpoint",
        "trace-thread-restore",
        "thread.apply_op",
        json!({
            "threadId": "thread-restore-checkpoint",
            "op": {
                "type": "runtime_event",
                "runId": "run-restore-checkpoint",
                "turnId": "turn-restore-checkpoint",
                "eventName": "agent.after_checkpoint",
                "source": "test",
                "visibility": "internal",
                "payload": { "after": true }
            }
        }),
    ));
    assert_eq!(after_checkpoint.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-restore",
        "trace-thread-restore",
        "thread.restore_checkpoint",
        json!({
            "threadId": "thread-restore-checkpoint",
            "checkpointId": "checkpoint-restore-1"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["checkpoint"]["checkpointId"], "checkpoint-restore-1");
    assert_eq!(result["checkpoint"]["label"], "Before tool execution");
    assert_eq!(result["restorePayload"]["phase"], "before_tool");
    assert_eq!(
        result["restorePayload"]["pendingToolCalls"][0]["name"],
        "workspace.read_file"
    );
    assert_eq!(
        result["snapshot"]["items"][0]["kind"]["type"],
        "checkpoint_created"
    );
    assert_eq!(result["snapshot"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["snapshot"]["items"][1]["kind"]["payload"]["eventName"],
        "agent.after_checkpoint"
    );
}

#[test]
fn dispatches_thread_restore_checkpoint_defaults_to_latest_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-latest-create",
        "trace-thread-restore-latest",
        "thread.create",
        json!({ "threadId": "thread-restore-latest" }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-latest-start",
        "trace-thread-restore-latest",
        "thread.start_turn",
        json!({
            "threadId": "thread-restore-latest",
            "runId": "run-restore-latest",
            "turnId": "turn-restore-latest",
            "input": { "content": "make checkpoints" }
        }),
    ));
    assert_eq!(start.error, None);
    for (checkpoint_id, phase) in [
        ("checkpoint-restore-old", "old"),
        ("checkpoint-restore-new", "new"),
    ] {
        let response = router.dispatch(&WorkerRequest::new(
            format!("req-thread-restore-latest-{phase}"),
            "trace-thread-restore-latest",
            "thread.apply_op",
            json!({
                "threadId": "thread-restore-latest",
                "op": {
                    "type": "checkpoint",
                    "runId": "run-restore-latest",
                    "turnId": "turn-restore-latest",
                    "checkpointId": checkpoint_id,
                    "restorePayload": { "phase": phase }
                }
            }),
        ));
        assert_eq!(response.error, None);
    }

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-latest",
        "trace-thread-restore-latest",
        "thread.restore_checkpoint",
        json!({ "threadId": "thread-restore-latest" }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(
        result["checkpoint"]["checkpointId"],
        "checkpoint-restore-new"
    );
    assert_eq!(result["restorePayload"]["phase"], "new");
    assert_eq!(
        result["snapshot"]["latestCheckpoint"]["checkpointId"],
        "checkpoint-restore-new"
    );
}

#[test]
fn dispatches_thread_agent_registry_for_parent_and_child_threads() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-parent",
        "trace-thread-agent-registry",
        "thread.create",
        json!({
            "threadId": "thread-agent-parent",
            "title": "Main thread",
            "sessionKey": "session-agent-registry",
            "source": "agent_run"
        }),
    ));
    assert_eq!(parent.error, None);
    let parent_start = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-parent-start",
        "trace-thread-agent-registry",
        "thread.start_turn",
        json!({
            "threadId": "thread-agent-parent",
            "runId": "run-agent-parent",
            "turnId": "turn-agent-parent",
            "input": { "content": "coordinate child work" }
        }),
    ));
    assert_eq!(parent_start.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child",
        "trace-thread-agent-registry",
        "thread.create",
        json!({
            "threadId": "thread-agent-child",
            "title": "Research child",
            "sessionKey": "session-agent-registry",
            "parentThreadId": "thread-agent-parent",
            "source": "subagent",
            "metadata": {
                "extra": {
                    "agentControl": {
                        "agentId": "child-agent-1",
                        "agentPath": ["main", "child-agent-1"],
                        "parentThreadId": "thread-agent-parent",
                        "parentRunId": "run-agent-parent",
                        "childRunId": "run-agent-child",
                        "role": "research",
                        "nickname": "Researcher",
                        "depth": 1,
                        "capacity": { "maxActivePerSession": 4 },
                        "lifecycle": {
                            "status": "awaiting_approval",
                            "active": true,
                            "terminal": false,
                            "mailboxDepth": 2,
                            "pendingApproval": { "approvalId": "approval-child-1" }
                        }
                    }
                }
            }
        }),
    ));
    assert_eq!(child.error, None);
    let child_start = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child-start",
        "trace-thread-agent-registry",
        "thread.start_turn",
        json!({
            "threadId": "thread-agent-child",
            "runId": "run-agent-child",
            "turnId": "turn-agent-child",
            "input": { "content": "research task" }
        }),
    ));
    assert_eq!(child_start.error, None);
    let checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child-checkpoint",
        "trace-thread-agent-registry",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-child",
            "op": {
                "type": "checkpoint",
                "runId": "run-agent-child",
                "turnId": "turn-agent-child",
                "checkpointId": "checkpoint-child-agent",
                "restorePayload": { "phase": "child_waiting" }
            }
        }),
    ));
    assert_eq!(checkpoint.error, None);
    let approval = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child-approval",
        "trace-thread-agent-registry",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-child",
            "op": {
                "type": "approval_request",
                "runId": "run-agent-child",
                "turnId": "turn-agent-child",
                "approvalId": "approval-child-1",
                "summary": "Allow child tool?"
            }
        }),
    ));
    assert_eq!(approval.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry",
        "trace-thread-agent-registry",
        "thread.agent_registry",
        json!({ "threadId": "thread-agent-parent" }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["rootThreadId"], "thread-agent-parent");
    assert_eq!(result["total"], 2);
    assert_eq!(result["activeCount"], 2);
    assert_eq!(result["waitingForApprovalCount"], 1);
    assert_eq!(result["agents"][0]["threadId"], "thread-agent-parent");
    assert_eq!(result["agents"][0]["role"], "main");
    assert_eq!(result["agents"][0]["childCount"], 1);
    assert_eq!(result["agents"][1]["agentId"], "child-agent-1");
    assert_eq!(result["agents"][1]["parentThreadId"], "thread-agent-parent");
    assert_eq!(result["agents"][1]["role"], "research");
    assert_eq!(result["agents"][1]["nickname"], "Researcher");
    assert_eq!(
        result["agents"][1]["latestCheckpoint"]["checkpointId"],
        "checkpoint-child-agent"
    );
    assert!(result["agents"][1]["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["kind"] == "approval"));
    assert_eq!(
        result["agents"][1]["pendingApproval"]["approvalId"],
        "approval-child-1"
    );
}

#[test]
fn dispatches_thread_activity_for_activity_rail_summary() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create_parent = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-parent",
        "trace-thread-activity",
        "thread.create",
        json!({
            "threadId": "thread-activity-parent",
            "title": "Activity parent",
            "sessionKey": "session-activity-summary"
        }),
    ));
    assert_eq!(create_parent.error, None);
    let start_parent = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-parent-start",
        "trace-thread-activity",
        "thread.start_turn",
        json!({
            "threadId": "thread-activity-parent",
            "runId": "run-activity-parent",
            "turnId": "turn-activity-parent",
            "input": { "content": "show activity" }
        }),
    ));
    assert_eq!(start_parent.error, None);
    for (request_id, op) in [
        (
            "req-thread-activity-checkpoint",
            json!({
                "type": "checkpoint",
                "runId": "run-activity-parent",
                "turnId": "turn-activity-parent",
                "checkpointId": "checkpoint-activity-parent",
                "label": "Before tool",
                "restorePayload": { "phase": "before_tool" }
            }),
        ),
        (
            "req-thread-activity-tool-start",
            json!({
                "type": "tool_call_started",
                "runId": "run-activity-parent",
                "turnId": "turn-activity-parent",
                "toolCallId": "tool-activity-1",
                "toolName": "workspace.read_file",
                "args": { "path": "notes/today.md" }
            }),
        ),
        (
            "req-thread-activity-approval",
            json!({
                "type": "approval_request",
                "runId": "run-activity-parent",
                "turnId": "turn-activity-parent",
                "approvalId": "approval-activity-1",
                "summary": "Allow workspace read?"
            }),
        ),
    ] {
        let response = router.dispatch(&WorkerRequest::new(
            request_id,
            "trace-thread-activity",
            "thread.apply_op",
            json!({
                "threadId": "thread-activity-parent",
                "op": op
            }),
        ));
        assert_eq!(response.error, None);
    }
    let create_child = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-child",
        "trace-thread-activity",
        "thread.create",
        json!({
            "threadId": "thread-activity-child",
            "title": "Activity child",
            "sessionKey": "session-activity-summary",
            "parentThreadId": "thread-activity-parent",
            "source": "subagent",
            "metadata": {
                "extra": {
                    "agentControl": {
                        "agentId": "child-activity-agent",
                        "agentPath": ["main", "child-activity-agent"],
                        "parentThreadId": "thread-activity-parent",
                        "childRunId": "run-activity-child",
                        "role": "research",
                        "nickname": "Activity child",
                        "depth": 1,
                        "lifecycle": {
                            "status": "running",
                            "active": true,
                            "terminal": false
                        }
                    }
                }
            }
        }),
    ));
    assert_eq!(create_child.error, None);
    let start_child = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-child-start",
        "trace-thread-activity",
        "thread.start_turn",
        json!({
            "threadId": "thread-activity-child",
            "runId": "run-activity-child",
            "turnId": "turn-activity-child",
            "input": { "content": "child work" }
        }),
    ));
    assert_eq!(start_child.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-activity",
        "trace-thread-activity",
        "thread.activity",
        json!({ "threadId": "thread-activity-parent" }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["threadId"], "thread-activity-parent");
    assert_eq!(result["summary"]["pendingApprovals"], 1);
    assert_eq!(result["summary"]["runningTools"], 1);
    assert_eq!(result["summary"]["checkpoints"], 1);
    assert_eq!(result["summary"]["activeChildren"], 1);
    assert_eq!(
        result["pendingApprovals"][0]["approvalId"],
        "approval-activity-1"
    );
    assert_eq!(result["runningTools"][0]["toolCallId"], "tool-activity-1");
    assert_eq!(
        result["checkpoints"][0]["checkpointId"],
        "checkpoint-activity-parent"
    );
    assert_eq!(
        result["activeChildren"][0]["child"]["threadId"],
        "thread-activity-child"
    );
    assert_eq!(result["agents"]["activeCount"], 2);
}

#[test]
fn dispatches_thread_activity_excludes_completed_tool_calls() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    assert_eq!(
        router
            .dispatch(&WorkerRequest::new(
                "req-thread-activity-completed-tool-create",
                "trace-thread-activity-completed-tool",
                "thread.create",
                json!({ "threadId": "thread-activity-completed-tool" }),
            ))
            .error,
        None
    );
    assert_eq!(
        router
            .dispatch(&WorkerRequest::new(
                "req-thread-activity-completed-tool-start",
                "trace-thread-activity-completed-tool",
                "thread.start_turn",
                json!({
                    "threadId": "thread-activity-completed-tool",
                    "runId": "run-activity-completed-tool",
                    "turnId": "turn-activity-completed-tool",
                    "input": { "content": "run completed tool" }
                }),
            ))
            .error,
        None
    );
    for (request_id, op) in [
        (
            "req-thread-activity-completed-tool-call",
            json!({
                "type": "tool_call_started",
                "runId": "run-activity-completed-tool",
                "turnId": "turn-activity-completed-tool",
                "toolCallId": "tool-completed-1",
                "toolName": "workspace.read_file",
                "args": { "path": "notes/today.md" }
            }),
        ),
        (
            "req-thread-activity-completed-tool-result",
            json!({
                "type": "tool_result",
                "runId": "run-activity-completed-tool",
                "turnId": "turn-activity-completed-tool",
                "toolCallId": "tool-completed-1",
                "toolName": "workspace.read_file",
                "output": { "contents": "done" }
            }),
        ),
    ] {
        assert_eq!(
            router
                .dispatch(&WorkerRequest::new(
                    request_id,
                    "trace-thread-activity-completed-tool",
                    "thread.apply_op",
                    json!({
                        "threadId": "thread-activity-completed-tool",
                        "op": op
                    }),
                ))
                .error,
            None
        );
    }

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-completed-tool",
        "trace-thread-activity-completed-tool",
        "thread.activity",
        json!({ "threadId": "thread-activity-completed-tool" }),
    ));

    assert_eq!(response.error, None);
    assert_eq!(
        response.result.as_ref().unwrap()["summary"]["runningTools"],
        0
    );
    assert!(response.result.as_ref().unwrap()["runningTools"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn dispatches_tool_executor_execute_for_registered_read_tool() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "hello from executor");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-read",
        "trace-tool-executor",
        "tool_executor.execute",
        json!({
            "toolId": "workspace.read_file",
            "arguments": { "path": "notes/today.md" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["toolId"], "workspace.read_file");
    assert_eq!(result["method"], "workspace.read_file");
    assert_eq!(result["namespace"], "workspace");
    assert_eq!(result["exposure"], "model");
    assert_eq!(result["approval"]["required"], false);
    assert_eq!(result["permission"]["decision"], "allow");
    assert_eq!(result["permission"]["requiresApproval"], false);
    assert_eq!(
        result["permission"]["tool"]["toolId"],
        "workspace.read_file"
    );
    assert_eq!(result["result"]["path"], "notes/today.md");
    assert_eq!(result["result"]["contents"], "hello from executor");
}

#[test]
fn dispatches_tool_executor_records_thread_tool_lifecycle() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "hello thread executor");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-create",
        "trace-tool-executor-thread",
        "thread.create",
        json!({
            "threadId": "thread-tool-executor",
            "title": "Tool executor thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-start",
        "trace-tool-executor-thread",
        "thread.start_turn",
        json!({
            "threadId": "thread-tool-executor",
            "runId": "run-tool-executor",
            "turnId": "turn-tool-executor",
            "input": { "content": "read notes" }
        }),
    ));
    assert_eq!(start.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-read",
        "trace-tool-executor-thread",
        "tool_executor.execute",
        json!({
            "toolId": "workspace.read_file",
            "threadId": "thread-tool-executor",
            "runId": "run-tool-executor",
            "turnId": "turn-tool-executor",
            "toolCallId": "call-tool-executor-read",
            "arguments": { "path": "notes/today.md" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["threadId"], "thread-tool-executor");
    assert_eq!(result["runId"], "run-tool-executor");
    assert_eq!(result["toolCallId"], "call-tool-executor-read");
    assert_eq!(result["appendedItems"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["appendedItems"][0]["kind"]["type"],
        "tool_call_started"
    );
    assert_eq!(
        result["appendedItems"][1]["kind"]["type"],
        "tool_call_output"
    );
    assert_eq!(
        result["appendedItems"][1]["parentItemId"],
        result["appendedItems"][0]["itemId"]
    );

    let snapshot = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-snapshot",
        "trace-tool-executor-thread",
        "thread.read",
        json!({ "threadId": "thread-tool-executor" }),
    ));
    assert_eq!(snapshot.error, None);
    let item_kinds = snapshot.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec![
            "user_message",
            "agent_run_started",
            "tool_call_started",
            "tool_call_output"
        ]
    );
    assert_eq!(
        snapshot.result.as_ref().unwrap()["items"][3]["kind"]["payload"]["output"]["contents"],
        "hello thread executor"
    );
}

#[test]
fn dispatches_tool_executor_rejects_unavailable_registered_tool() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-shell-denied",
        "trace-tool-executor",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "arguments": {
                "command": "echo blocked",
                "sessionId": "session-1",
                "runId": "run-1"
            }
        }),
    ));

    let error = response
        .error
        .expect("unavailable registered tool should be rejected");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.message, "registered tool is unavailable");
    assert_eq!(error.details["toolId"], "shell.execute");
    assert_eq!(error.details["targetMethod"], "shell.execute");
    assert_eq!(
        error.details["missingCapabilities"],
        json!(["shell.execute"])
    );
}

#[test]
fn dispatches_tool_executor_preserves_sensitive_tool_approval_boundary() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-shell-approval",
        "trace-tool-executor",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "arguments": {
                "command": "echo needs approval",
                "sessionId": "session-1",
                "runId": "run-1"
            }
        }),
    ));

    let error = response
        .error
        .expect("sensitive registered tool should still require approval");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.message, "approval required for sensitive operation");
    assert_eq!(error.details["method"], "shell.execute");
    assert_eq!(error.details["boundary"], "security");
    assert_eq!(error.details["category"], "shell");
}

#[test]
fn mcp_tool_calls_cannot_bypass_approval_through_low_level_rpc() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({
            "tools": {
                "mcp_servers": {
                    "docs": { "enabled_tools": ["search"] }
                }
            }
        }),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::McpCall]),
    );
    let arguments = json!({
        "server": "docs",
        "tool": "search",
        "arguments": {},
        "internal_operation": true
    });

    let direct = router.dispatch(&WorkerRequest::new(
        "req-direct-mcp",
        "trace-direct-mcp",
        "mcp.call_tool",
        arguments.clone(),
    ));
    let direct_error = direct
        .error
        .expect("direct MCP RPC should require a matching approval");
    assert_eq!(
        direct_error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(direct_error.details["boundary"], "security");
    assert_eq!(direct_error.details["method"], "mcp.call_tool");
    assert_eq!(direct_error.details["category"], "mcp_tool");

    let executor = router.dispatch(&WorkerRequest::new(
        "req-executor-mcp",
        "trace-executor-mcp",
        "tool_executor.execute",
        json!({
            "toolId": "mcp.call_tool",
            "arguments": arguments
        }),
    ));
    let executor_error = executor
        .error
        .expect("tool executor MCP RPC should require the trusted approved path");
    assert_eq!(
        executor_error.message,
        "approval-required tools must be dispatched through a trusted approved runtime path"
    );
    assert_eq!(executor_error.details["boundary"], "security");
    assert_eq!(executor_error.details["toolId"], "mcp.call_tool");
}

#[test]
fn dispatches_thread_read_before_sequence_page() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-read-before-create",
        "trace-thread-read-before",
        "thread.create",
        json!({ "threadId": "thread-read-before", "title": "Paged thread" }),
    ));
    assert_eq!(create.error, None);

    let items = (1..=5)
        .map(|index| {
            json!({
                "itemId": format!("thread-read-before-item-{index}"),
                "threadId": "",
                "runId": "run-read-before",
                "turnId": "turn-read-before",
                "sequence": 0,
                "createdAt": format!("2026-07-05T00:00:0{index}Z"),
                "kind": {
                    "type": "user_message",
                    "payload": { "text": format!("Message {index}") }
                }
            })
        })
        .collect::<Vec<_>>();
    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-read-before-append",
        "trace-thread-read-before",
        "thread.append_items",
        json!({ "threadId": "thread-read-before", "items": items }),
    ));
    assert_eq!(append.error, None);

    let page = router.dispatch(&WorkerRequest::new(
        "req-thread-read-before-page",
        "trace-thread-read-before",
        "thread.read",
        json!({ "threadId": "thread-read-before", "limit": 2, "beforeSequence": 7 }),
    ));
    assert_eq!(page.error, None);
    let items = page.result.as_ref().unwrap()["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["sequence"], 4);
    assert_eq!(items[1]["sequence"], 5);
    assert_eq!(
        page.result.as_ref().unwrap()["pagination"]["previousCursor"],
        "4"
    );
    assert_eq!(
        page.result.as_ref().unwrap()["pagination"]["hasMoreBefore"],
        true
    );

    let checkpoint_append = router.dispatch(&WorkerRequest::new(
        "req-thread-read-checkpoint-append",
        "trace-thread-read-before",
        "thread.append_items",
        json!({
            "threadId": "thread-read-before",
            "items": [
                {
                    "itemId": "thread-read-before-checkpoint",
                    "threadId": "",
                    "runId": "run-read-before",
                    "turnId": "turn-read-before",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:06Z",
                    "kind": {
                        "type": "checkpoint_created",
                        "payload": {
                            "checkpointId": "checkpoint-read-before",
                            "runId": "run-read-before",
                            "restorePayload": { "phase": "awaiting_tool" }
                        }
                    }
                },
                {
                    "itemId": "thread-read-before-after-checkpoint",
                    "threadId": "",
                    "runId": "run-read-before",
                    "turnId": "turn-read-before",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:07Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "After checkpoint" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(checkpoint_append.error, None);

    let checkpoint_page = router.dispatch(&WorkerRequest::new(
        "req-thread-read-checkpoint-page",
        "trace-thread-read-before",
        "thread.read",
        json!({
            "threadId": "thread-read-before",
            "checkpointId": "checkpoint-read-before"
        }),
    ));
    assert_eq!(checkpoint_page.error, None);
    let checkpoint_items = checkpoint_page.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap();
    assert_eq!(checkpoint_items[0]["sequence"], 6);
    assert_eq!(checkpoint_items[0]["kind"]["type"], "checkpoint_created");
    assert_eq!(checkpoint_items[1]["sequence"], 7);
    assert_eq!(
        checkpoint_page.result.as_ref().unwrap()["latestCheckpoint"]["checkpointId"],
        "checkpoint-read-before"
    );
}

#[test]
fn dispatches_thread_append_items_idempotently_by_client_event_id() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-create",
        "trace-thread-idempotent",
        "thread.create",
        json!({ "title": "Idempotent thread" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let payload = json!({
        "threadId": thread_id,
        "clientEventId": "client-event-1",
        "items": [{
            "itemId": "",
            "threadId": "",
            "sequence": 0,
            "createdAt": "",
            "kind": {
                "type": "user_message",
                "payload": { "text": "retry-safe input" }
            }
        }]
    });

    let first = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-first",
        "trace-thread-idempotent",
        "thread.append_items",
        payload.clone(),
    ));
    assert_eq!(first.error, None);
    let first_item_id = first.result.as_ref().unwrap()["items"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let retry = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-retry",
        "trace-thread-idempotent",
        "thread.append_items",
        payload,
    ));
    assert_eq!(retry.error, None);
    assert_eq!(
        retry.result.as_ref().unwrap()["items"][0]["itemId"],
        first_item_id
    );
    assert_eq!(retry.result.as_ref().unwrap()["items"][0]["sequence"], 1);

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-read",
        "trace-thread-idempotent",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(read.result.as_ref().unwrap()["pagination"]["itemCount"], 1);
    assert_eq!(
        read.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
        "retry-safe input"
    );
}

#[test]
fn dispatches_thread_apply_op_for_turn_lifecycle() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-create",
        "trace-thread-op",
        "thread.create",
        json!({ "title": "Thread op" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-user-input",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "user-input-client-1",
            "op": {
                "type": "user_input",
                "runId": "run-op-1",
                "input": { "text": "Summarize this document" },
                "model": "deepseek-v4-flash"
            }
        }),
    ));
    assert_eq!(user_input.error, None);
    assert_eq!(
        user_input.result.as_ref().unwrap()["run"]["runId"],
        "run-op-1"
    );
    assert_eq!(
        user_input.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "user_message"
    );
    let first_user_item_id = user_input.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();
    let first_started_item_id = user_input.result.as_ref().unwrap()["appendedItems"][1]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let user_input_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-user-input-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "user-input-client-1",
            "op": {
                "type": "user_input",
                "runId": "run-op-1",
                "input": { "text": "This retry must not append" },
                "model": "deepseek-v4-flash"
            }
        }),
    ));
    assert_eq!(user_input_retry.error, None);
    assert_eq!(
        user_input_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        first_user_item_id
    );
    assert_eq!(
        user_input_retry.result.as_ref().unwrap()["appendedItems"][1]["itemId"],
        first_started_item_id
    );
    assert_eq!(
        user_input_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["text"],
        "Summarize this document"
    );

    let continue_run = router.dispatch(&WorkerRequest::new(
        "req-thread-op-continue",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "continue-client-1",
            "op": {
                "type": "continue_run",
                "input": { "approval": "continue" }
            }
        }),
    ));
    assert_eq!(continue_run.error, None);
    assert_eq!(
        continue_run.result.as_ref().unwrap()["run"]["runId"],
        "run-op-1"
    );
    assert_eq!(
        continue_run.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "event"
    );
    let continue_item_id = continue_run.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let continue_run_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-continue-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "continue-client-1",
            "op": {
                "type": "continue_run",
                "input": { "approval": "retry should not append" }
            }
        }),
    ));
    assert_eq!(continue_run_retry.error, None);
    assert_eq!(
        continue_run_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        continue_item_id
    );
    assert_eq!(
        continue_run_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
            ["payload"]["approval"],
        "continue"
    );

    let checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-op-checkpoint",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "checkpoint",
                "checkpointId": "checkpoint-op-1",
                "label": "After outline",
                "restorePayload": {
                    "phase": "outlined",
                    "note": "resume from outline"
                }
            }
        }),
    ));
    assert_eq!(checkpoint.error, None);
    assert_eq!(
        checkpoint.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "checkpoint_created"
    );
    assert_eq!(
        checkpoint.result.as_ref().unwrap()["snapshot"]["latestCheckpoint"]["checkpointId"],
        "checkpoint-op-1"
    );
    assert_eq!(
        checkpoint.result.as_ref().unwrap()["snapshot"]["latestCheckpoint"]["restorePayload"]
            ["phase"],
        "outlined"
    );

    let approval_request = router.dispatch(&WorkerRequest::new(
        "req-thread-op-approval-request",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "approval_request",
                "approvalId": "approval-op-1",
                "summary": "Allow workspace read",
                "scope": "once",
                "payload": {
                    "reason": "Read workspace file"
                }
            }
        }),
    ));
    assert_eq!(approval_request.error, None);
    assert_eq!(
        approval_request.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "approval_requested"
    );
    let approval_request_item_id = approval_request.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let tool_call_start = router.dispatch(&WorkerRequest::new(
        "req-thread-op-tool-call-start",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "tool_call_started",
                "toolCallId": "tool-call-op-1",
                "toolName": "workspace.read_file",
                "args": {
                    "path": "README.md"
                }
            }
        }),
    ));
    assert_eq!(tool_call_start.error, None);
    assert_eq!(
        tool_call_start.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "tool_call_started"
    );
    let tool_call_start_item_id = tool_call_start.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let approval = router.dispatch(&WorkerRequest::new(
        "req-thread-op-approval",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "approval_decision",
                "approvalId": "approval-op-1",
                "approved": true,
                "scope": "once",
                "guidance": "Allowed for this run"
            }
        }),
    ));
    assert_eq!(approval.error, None);
    assert_eq!(
        approval.result.as_ref().unwrap()["run"]["runId"],
        "run-op-1"
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "approval_resolved"
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["approvalId"],
        "approval-op-1"
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["appendedItems"][0]["parentItemId"],
        approval_request_item_id
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "running"
    );

    let tool_result = router.dispatch(&WorkerRequest::new(
        "req-thread-op-tool-result",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "tool_result",
                "toolCallId": "tool-call-op-1",
                "toolName": "workspace.read_file",
                "output": { "text": "README contents" }
            }
        }),
    ));
    assert_eq!(tool_result.error, None);
    assert_eq!(
        tool_result.result.as_ref().unwrap()["run"]["runId"],
        "run-op-1"
    );
    assert_eq!(
        tool_result.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "tool_call_output"
    );
    assert_eq!(
        tool_result.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["toolCallId"],
        "tool-call-op-1"
    );
    assert_eq!(
        tool_result.result.as_ref().unwrap()["appendedItems"][0]["parentItemId"],
        tool_call_start_item_id
    );

    let assistant_delta = router.dispatch(&WorkerRequest::new(
        "req-thread-op-assistant-delta",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "assistant_delta",
                "delta": "The document",
                "message": {
                    "role": "assistant",
                    "delta": "The document"
                }
            }
        }),
    ));
    assert_eq!(assistant_delta.error, None);
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["run"]["runId"],
        "run-op-1"
    );
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["run"]["active"],
        true
    );
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "assistant_message_delta"
    );
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["delta"],
        "The document"
    );

    let reasoning = router.dispatch(&WorkerRequest::new(
        "req-thread-op-reasoning",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "reasoning",
                "summary": "Need to synthesize the uploaded document.",
                "payload": {
                    "phase": "synthesis"
                }
            }
        }),
    ));
    assert_eq!(reasoning.error, None);
    assert_eq!(
        reasoning.result.as_ref().unwrap()["run"]["runId"],
        "run-op-1"
    );
    assert_eq!(
        reasoning.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "reasoning"
    );
    assert_eq!(
        reasoning.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["summary"],
        "Need to synthesize the uploaded document."
    );

    let assistant_response = router.dispatch(&WorkerRequest::new(
        "req-thread-op-assistant-response",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "assistant-response-client-1",
            "op": {
                "type": "assistant_response",
                "content": "The document is summarized.",
                "stopReason": "final_response"
            }
        }),
    ));
    assert_eq!(assistant_response.error, None);
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["run"]["runId"],
        "run-op-1"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["run"]["active"],
        false
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "assistant_message_completed"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["appendedItems"][1]["kind"]["type"],
        "agent_run_completed"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["snapshot"]["activeRun"],
        json!(null)
    );
    let assistant_message_item_id = assistant_response.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();
    let completion_item_id = assistant_response.result.as_ref().unwrap()["appendedItems"][1]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let assistant_response_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-assistant-response-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "assistant-response-client-1",
            "op": {
                "type": "assistant_response",
                "content": "This retry must not append.",
                "stopReason": "retry"
            }
        }),
    ));
    assert_eq!(assistant_response_retry.error, None);
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        assistant_message_item_id
    );
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][1]["itemId"],
        completion_item_id
    );
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
            ["text"],
        "The document is summarized."
    );
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][1]["kind"]["payload"]
            ["stopReason"],
        "final_response"
    );

    let late_tool_result = router.dispatch(&WorkerRequest::new(
        "req-thread-op-late-tool-result",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "tool_result",
                "runId": "run-op-1",
                "toolCallId": "tool-call-op-1",
                "toolName": "workspace.read_file",
                "output": { "text": "late output" }
            }
        }),
    ));
    assert_eq!(
        late_tool_result.error.as_ref().unwrap().code,
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        late_tool_result.error.as_ref().unwrap().message,
        "thread operation targets a run that is not active"
    );

    let continue_without_active_run = router.dispatch(&WorkerRequest::new(
        "req-thread-op-continue-without-active-run",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "continue_run",
                "input": { "approval": "late continue" }
            }
        }),
    ));
    assert_eq!(
        continue_without_active_run.error.as_ref().unwrap().code,
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        continue_without_active_run.error.as_ref().unwrap().message,
        "thread operation requires an active run or explicit runId"
    );

    let second_user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-second-user-input",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "user_input",
                "runId": "run-op-2",
                "input": { "text": "Start another task" }
            }
        }),
    ));
    assert_eq!(second_user_input.error, None);
    assert_eq!(
        second_user_input.result.as_ref().unwrap()["run"]["runId"],
        "run-op-2"
    );

    let interrupt = router.dispatch(&WorkerRequest::new(
        "req-thread-op-interrupt",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "interrupt-client-1",
            "op": {
                "type": "interrupt",
                "reason": "user stopped"
            }
        }),
    ));
    assert_eq!(interrupt.error, None);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "cancelled"
    );
    assert_eq!(
        interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );
    let cancelled_item_id = interrupt.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let interrupt_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-interrupt-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "interrupt-client-1",
            "op": {
                "type": "interrupt",
                "reason": "retry should not append"
            }
        }),
    ));
    assert_eq!(interrupt_retry.error, None);
    assert_eq!(
        interrupt_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        cancelled_item_id
    );
    assert_eq!(
        interrupt_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["reason"],
        "user stopped"
    );
}

#[test]
fn dispatches_thread_apply_op_records_terminal_error() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-create",
        "trace-thread-error-op",
        "thread.create",
        json!({ "title": "Thread error op", "sessionKey": "session-error-op" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-start",
        "trace-thread-error-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "user_input",
                "runId": "run-error-op-1",
                "input": "Start risky task"
            }
        }),
    ));
    assert_eq!(start.error, None);

    let failed = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-fail",
        "trace-thread-error-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "error",
                "message": "Tool execution failed",
                "code": "tool_error",
                "details": { "toolName": "workspace.write_file" }
            }
        }),
    ));
    assert_eq!(failed.error, None);
    assert_eq!(
        failed.result.as_ref().unwrap()["run"]["runId"],
        "run-error-op-1"
    );
    assert_eq!(failed.result.as_ref().unwrap()["run"]["status"], "failed");
    assert_eq!(
        failed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "error"
    );
    assert_eq!(
        failed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["message"],
        "Tool execution failed"
    );
    assert_eq!(
        failed.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "failed"
    );
    assert_eq!(
        failed.result.as_ref().unwrap()["snapshot"]["activeRun"],
        json!(null)
    );

    let run_get = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-run-get",
        "trace-thread-error-op",
        "agent_run.get",
        json!({ "session_id": "session-error-op", "run_id": "run-error-op-1" }),
    ));
    assert_eq!(run_get.error, None);
    assert_eq!(run_get.result.as_ref().unwrap()["status"], "failed");
    assert_eq!(
        run_get.result.as_ref().unwrap()["error"]["message"],
        "thread run failed"
    );
}

#[test]
fn dispatches_thread_apply_op_for_subagent_events() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-create",
        "trace-thread-op-subagent",
        "thread.create",
        json!({ "title": "Thread op subagent" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-user-input",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "user_input",
                "runId": "run-subagent-op-1",
                "input": { "text": "Delegate this task" }
            }
        }),
    ));
    assert_eq!(user_input.error, None);

    let spawned = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-spawned",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "subagent_spawned",
                "subagentId": "delegate-op-1",
                "childThreadId": "thread-child-op-1",
                "childRunId": "run-child-op-1",
                "name": "Researcher",
                "task": "Find source material",
                "payload": {
                    "role": "research"
                }
            }
        }),
    ));
    assert_eq!(spawned.error, None);
    assert_eq!(
        spawned.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "subagent_spawned"
    );
    assert_eq!(
        spawned.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["subagentId"],
        "delegate-op-1"
    );

    let message = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-message",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "subagent_message",
                "subagentId": "delegate-op-1",
                "childThreadId": "thread-child-op-1",
                "childRunId": "run-child-op-1",
                "content": "I found two relevant sources.",
                "status": "running",
                "payload": {
                    "sourceCount": 2
                }
            }
        }),
    ));
    assert_eq!(message.error, None);
    assert_eq!(
        message.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "subagent_message"
    );
    assert_eq!(
        message.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["content"],
        "I found two relevant sources."
    );

    let completed = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-completed",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "subagent_completed",
                "subagentId": "delegate-op-1",
                "childThreadId": "thread-child-op-1",
                "childRunId": "run-child-op-1",
                "status": "completed",
                "result": {
                    "summary": "Two sources found"
                }
            }
        }),
    ));
    assert_eq!(completed.error, None);
    assert_eq!(
        completed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "subagent_completed"
    );
    assert_eq!(
        completed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["result"]
            ["summary"],
        "Two sources found"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-read",
        "trace-thread-op-subagent",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    let item_kinds = read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec![
            "user_message",
            "agent_run_started",
            "subagent_spawned",
            "subagent_message",
            "subagent_completed",
        ]
    );
}

#[test]
fn dispatches_thread_apply_op_for_agent_step_events() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step-create",
        "trace-thread-op-step",
        "thread.create",
        json!({
            "threadId": "thread-agent-step-op",
            "title": "Thread op step",
            "sessionKey": "session-agent-step-op"
        }),
    ));
    assert_eq!(create.error, None);

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step-user-input",
        "trace-thread-op-step",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-step-op",
            "op": {
                "type": "user_input",
                "runId": "run-agent-step-op",
                "input": { "text": "Run a multi-step task" }
            }
        }),
    ));
    assert_eq!(user_input.error, None);

    let step = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step",
        "trace-thread-op-step",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-step-op",
            "op": {
                "type": "agent_step",
                "stepId": "step-plan-1",
                "name": "Plan",
                "status": "running",
                "summary": "Preparing the tool plan",
                "payload": {
                    "phase": "planning"
                }
            }
        }),
    ));
    assert_eq!(step.error, None);
    assert_eq!(
        step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "agent_run_step"
    );
    assert_eq!(
        step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["stepId"],
        "step-plan-1"
    );
    assert_eq!(
        step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["eventName"],
        "agent.step"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step-read",
        "trace-thread-op-step",
        "thread.read",
        json!({ "threadId": "thread-agent-step-op" }),
    ));
    assert_eq!(read.error, None);
    let item_kinds = read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec!["user_message", "agent_run_started", "agent_run_step"]
    );

    let trace = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step-trace",
        "trace-thread-op-step",
        "agent_run.list_trace",
        json!({
            "sessionId": "session-agent-step-op",
            "runId": "run-agent-step-op"
        }),
    ));
    assert_eq!(trace.error, None);
    assert_eq!(
        trace.result.as_ref().unwrap()["items"][0]["eventName"],
        "agent.step"
    );
    assert_eq!(
        trace.result.as_ref().unwrap()["items"][0]["payload"]["summary"],
        "Preparing the tool plan"
    );
}

#[test]
fn dispatches_thread_apply_op_for_runtime_events() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-create",
        "trace-thread-op-runtime-event",
        "thread.create",
        json!({
            "threadId": "thread-runtime-event-op",
            "title": "Runtime event op",
            "sessionKey": "session-runtime-event-op"
        }),
    ));
    assert_eq!(create.error, None);

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-user-input",
        "trace-thread-op-runtime-event",
        "thread.apply_op",
        json!({
            "threadId": "thread-runtime-event-op",
            "op": {
                "type": "user_input",
                "runId": "run-runtime-event-op",
                "input": { "text": "Search the web" }
            }
        }),
    ));
    assert_eq!(user_input.error, None);

    let runtime_event = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event",
        "trace-thread-op-runtime-event",
        "thread.apply_op",
        json!({
            "threadId": "thread-runtime-event-op",
            "clientEventId": "runtime-event-client-1",
            "op": {
                "type": "runtime_event",
                "eventName": "agent.browser.search",
                "source": "tool",
                "visibility": "user",
                "payload": {
                    "query": "thread event log design",
                    "resultCount": 4
                }
            }
        }),
    ));
    assert_eq!(runtime_event.error, None);
    assert_eq!(
        runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "event"
    );
    assert_eq!(
        runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["eventName"],
        "agent.browser.search"
    );
    assert_eq!(
        runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["payload"]
            ["resultCount"],
        4
    );
    let runtime_event_item_id = runtime_event.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let runtime_event_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-retry",
        "trace-thread-op-runtime-event",
        "thread.apply_op",
        json!({
            "threadId": "thread-runtime-event-op",
            "clientEventId": "runtime-event-client-1",
            "op": {
                "type": "runtime_event",
                "eventName": "agent.browser.search.retry",
                "source": "tool",
                "visibility": "user",
                "payload": {
                    "query": "this should not be appended",
                    "resultCount": 99
                }
            }
        }),
    ));
    assert_eq!(runtime_event_retry.error, None);
    assert_eq!(
        runtime_event_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        runtime_event_item_id
    );
    assert_eq!(
        runtime_event_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
            ["eventName"],
        "agent.browser.search"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-read",
        "trace-thread-op-runtime-event",
        "thread.read",
        json!({ "threadId": "thread-runtime-event-op" }),
    ));
    assert_eq!(read.error, None);
    let item_kinds = read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec!["user_message", "agent_run_started", "event"]
    );

    let trace = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-trace",
        "trace-thread-op-runtime-event",
        "agent_run.list_trace",
        json!({
            "sessionId": "session-runtime-event-op",
            "runId": "run-runtime-event-op"
        }),
    ));
    assert_eq!(trace.error, None);
    assert_eq!(
        trace.result.as_ref().unwrap()["items"][0]["eventName"],
        "agent.browser.search"
    );
    assert_eq!(
        trace.result.as_ref().unwrap()["items"][0]["payload"]["query"],
        "thread event log design"
    );
}

#[test]
fn dispatches_thread_apply_op_updates_settings_and_records_item() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-create",
        "trace-thread-settings-op",
        "thread.create",
        json!({ "title": "Settings before" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let settings = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-apply",
        "trace-thread-settings-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "settings-client-1",
            "op": {
                "type": "update_settings",
                "metadata": {
                    "title": "Settings after",
                    "model": "deepseek-v4-flash",
                    "tags": ["thread", "settings"],
                    "extra": { "temperature": 0.2 }
                },
                "reason": "user changed model"
            }
        }),
    ));
    assert_eq!(settings.error, None);
    assert_eq!(
        settings.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Settings after"
    );
    assert_eq!(
        settings.result.as_ref().unwrap()["snapshot"]["thread"]["metadata"]["model"],
        "deepseek-v4-flash"
    );
    assert_eq!(
        settings.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "settings_changed"
    );
    assert_eq!(
        settings.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["reason"],
        "user changed model"
    );
    assert_eq!(settings.result.as_ref().unwrap()["run"], json!(null));
    let settings_item_id = settings.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let settings_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-retry",
        "trace-thread-settings-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "settings-client-1",
            "op": {
                "type": "update_settings",
                "metadata": {
                    "title": "Retry must not apply",
                    "model": "retry-model",
                    "tags": ["retry"],
                    "extra": { "temperature": 1.0 }
                },
                "reason": "retry reason"
            }
        }),
    ));
    assert_eq!(settings_retry.error, None);
    assert_eq!(
        settings_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        settings_item_id
    );
    assert_eq!(
        settings_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["reason"],
        "user changed model"
    );
    assert_eq!(
        settings_retry.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Settings after"
    );
    assert_eq!(
        settings_retry.result.as_ref().unwrap()["snapshot"]["thread"]["metadata"]["model"],
        "deepseek-v4-flash"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-read",
        "trace-thread-settings-op",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["thread"]["title"],
        "Settings after"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["items"][0]["kind"]["type"],
        "settings_changed"
    );
}

#[test]
fn dispatches_thread_apply_op_for_lifecycle_actions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create_parent = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-parent",
        "trace-thread-lifecycle-op",
        "thread.create",
        json!({ "threadId": "lifecycle-parent", "title": "Lifecycle parent" }),
    ));
    assert_eq!(create_parent.error, None);
    let create_child = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-child",
        "trace-thread-lifecycle-op",
        "thread.create",
        json!({
            "threadId": "lifecycle-child",
            "title": "Lifecycle child",
            "parentThreadId": "lifecycle-parent",
            "source": "subagent"
        }),
    ));
    assert_eq!(create_child.error, None);

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-archive",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "op": {
                "type": "archive",
                "archiveChildren": true
            }
        }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(
        archive.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "archived"
    );
    assert_eq!(archive.result.as_ref().unwrap()["appendedItems"], json!([]));

    let archived_child = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-read-archived-child",
        "trace-thread-lifecycle-op",
        "thread.read",
        json!({ "threadId": "lifecycle-child" }),
    ));
    assert_eq!(archived_child.error, None);
    assert_eq!(
        archived_child.result.as_ref().unwrap()["thread"]["status"],
        "archived"
    );

    let unarchive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-unarchive",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "op": {
                "type": "unarchive",
                "unarchiveChildren": true
            }
        }),
    ));
    assert_eq!(unarchive.error, None);
    assert_eq!(
        unarchive.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "empty"
    );

    let fork = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "clientEventId": "fork-client-1",
            "op": {
                "type": "fork",
                "title": "Lifecycle fork",
                "includeChildren": true
            }
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_id = fork.result.as_ref().unwrap()["snapshot"]["thread"]["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(fork_id, "lifecycle-parent");
    assert_eq!(
        fork.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Lifecycle fork"
    );
    assert_eq!(
        fork.result.as_ref().unwrap()["snapshot"]["thread"]["parentThreadId"],
        "lifecycle-parent"
    );

    let fork_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork-retry",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "clientEventId": "fork-client-1",
            "op": {
                "type": "fork",
                "title": "Retry must not fork again",
                "includeChildren": true
            }
        }),
    ));
    assert_eq!(fork_retry.error, None);
    assert_eq!(
        fork_retry.result.as_ref().unwrap()["snapshot"]["thread"]["threadId"],
        fork_id
    );
    assert_eq!(
        fork_retry.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Lifecycle fork"
    );

    let fork_children = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork-children",
        "trace-thread-lifecycle-op",
        "thread.list",
        json!({
            "includeChildThreads": true,
            "parentThreadId": fork_id
        }),
    ));
    assert_eq!(fork_children.error, None);
    assert_eq!(
        fork_children.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let fork_siblings = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork-siblings",
        "trace-thread-lifecycle-op",
        "thread.list",
        json!({
            "includeChildThreads": true,
            "parentThreadId": "lifecycle-parent"
        }),
    ));
    assert_eq!(fork_siblings.error, None);
    assert_eq!(
        fork_siblings.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|thread| thread["source"] == "fork")
            .count(),
        1
    );
}

#[test]
fn dispatches_agent_run_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let record = json!({
        "sessionId": "session-1",
        "runId": "run-1",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "unix-ms:1",
        "updatedAt": "unix-ms:1",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "traceEvents": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-upsert",
        "trace-agent-run",
        "agent_run.upsert",
        json!({ "record": record }),
    ));
    let append_trace = router.dispatch(&WorkerRequest::new(
        "req-trace",
        "trace-agent-run",
        "agent_run.append_trace",
        json!({
            "session_id": "session-1",
            "run_id": "run-1",
            "event": {
                "eventId": "trace-tool-result",
                "eventName": "agent.tool.result",
                "payload": {
                    "toolCallId": "call-1",
                    "toolName": "workspace.read_file",
                    "content": "README"
                }
            }
        }),
    ));
    let append_second_trace = router.dispatch(&WorkerRequest::new(
        "req-trace-2",
        "trace-agent-run",
        "agent_run.append_trace",
        json!({
            "session_id": "session-1",
            "run_id": "run-1",
            "event": {
                "eventId": "trace-done",
                "eventName": "agent.done",
                "payload": { "finalContent": "done" }
            }
        }),
    ));
    let set_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-set-checkpoint",
        "trace-agent-run",
        "agent_run.set_checkpoint",
        json!({
            "session_id": "session-1",
            "run_id": "run-1",
            "checkpoint": { "sessionId": "session-1", "runId": "run-1", "phase": "awaiting_tool" }
        }),
    ));
    let get_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-get-checkpoint",
        "trace-agent-run",
        "agent_run.get_checkpoint",
        json!({ "session_id": "session-1", "run_id": "run-1" }),
    ));
    let list = router.dispatch(&WorkerRequest::new(
        "req-list",
        "trace-agent-run",
        "agent_run.list",
        json!({ "sessionId": "session-1" }),
    ));
    let get = router.dispatch(&WorkerRequest::new(
        "req-get",
        "trace-agent-run",
        "agent_run.get",
        json!({ "session_id": "session-1", "run_id": "run-1" }),
    ));
    let trace_page = router.dispatch(&WorkerRequest::new(
        "req-list-trace",
        "trace-agent-run",
        "agent_run.list_trace",
        json!({ "session_id": "session-1", "run_id": "run-1", "limit": 1 }),
    ));
    let runtime_state = router.dispatch(&WorkerRequest::new(
        "req-runtime-state",
        "trace-agent-run",
        "agent_run.runtime_state",
        json!({ "session_id": "session-1", "run_id": "run-1" }),
    ));
    let completed = router.dispatch(&WorkerRequest::new(
        "req-complete",
        "trace-agent-run",
        "agent_run.mark_completed",
        json!({
            "session_id": "session-1",
            "run_id": "run-1",
            "stop_reason": "final_response",
            "final_content": "done"
        }),
    ));
    let get_completed = router.dispatch(&WorkerRequest::new(
        "req-get-completed",
        "trace-agent-run",
        "agent_run.get",
        json!({ "session_id": "session-1", "run_id": "run-1" }),
    ));
    let clear_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-clear-checkpoint",
        "trace-agent-run",
        "agent_run.clear_checkpoint",
        json!({ "session_id": "session-1", "run_id": "run-1" }),
    ));

    assert!(upsert.error.is_none());
    assert!(append_trace.error.is_none());
    assert!(append_second_trace.error.is_none());
    assert!(set_checkpoint.error.is_none());
    assert_eq!(
        get_checkpoint.result.as_ref().unwrap()["checkpoint"]["phase"],
        "awaiting_tool"
    );
    assert_eq!(upsert.result.as_ref().unwrap()["threadId"], json!(null));
    assert_eq!(
        append_trace.result.as_ref().unwrap()["threadId"],
        json!(null)
    );
    assert_eq!(
        set_checkpoint.result.as_ref().unwrap()["threadId"],
        json!(null)
    );
    assert_eq!(list.result.as_ref().unwrap()["sessionId"], "session-1");
    assert_eq!(list.result.as_ref().unwrap()["runs"][0]["runId"], "run-1");
    assert_eq!(
        list.result.as_ref().unwrap()["runs"][0]["threadId"],
        json!(null)
    );
    assert!(list.result.as_ref().unwrap()["runs"][0]
        .get("traceEvents")
        .is_none());
    assert_eq!(get.result.as_ref().unwrap()["threadId"], json!(null));
    assert_eq!(
        get.result.as_ref().unwrap()["traceEvents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(trace_page.error, None);
    assert_eq!(
        trace_page.result.as_ref().unwrap()["items"][0]["eventName"],
        "agent.tool.result"
    );
    assert_eq!(trace_page.result.as_ref().unwrap()["nextCursor"], "1");
    assert_eq!(runtime_state.error, None);
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["runtimeEvents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["sessionId"],
        "session-1"
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["turnId"],
        "run-1"
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["timeline"]["items"][0]["kind"],
        "tool_call"
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["timeline"]["items"][1]["kind"],
        "assistant_message"
    );
    assert_eq!(completed.result.as_ref().unwrap()["status"], "completed");
    assert_eq!(completed.result.as_ref().unwrap()["phase"], "completed");
    assert_eq!(completed.result.as_ref().unwrap()["threadId"], json!(null));
    assert_eq!(get_completed.error, None);
    assert_eq!(
        get_completed.result.as_ref().unwrap()["threadId"],
        json!(null)
    );
    assert_eq!(
        get_completed.result.as_ref().unwrap()["stopReason"],
        "final_response"
    );
    assert_eq!(
        clear_checkpoint.result.as_ref().unwrap()["checkpoint"],
        json!(null)
    );

    assert!(!fixture
        .root
        .join("sessions")
        .join("sessions.sqlite")
        .exists());
    assert!(!fixture
        .root
        .join(".tinybot")
        .join("threads")
        .join("threads.sqlite")
        .exists());

    let metadata = router.dispatch(&WorkerRequest::new(
        "req-session-metadata-after-agent-run",
        "trace-agent-run",
        "session.get_metadata",
        json!({ "session_id": "session-1" }),
    ));
    assert_eq!(metadata.error, None);
    assert_eq!(metadata.result.as_ref().unwrap()["session_id"], "session-1");
    assert_eq!(
        metadata.result.as_ref().unwrap()["extra"]["threadSource"],
        "thread_log"
    );
}

#[test]
fn dispatches_agent_run_trace_and_runtime_state_from_thread_items() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-create",
        "trace-thread-backed-run",
        "thread.create",
        json!({
            "threadId": "thread-session-1",
            "title": "Thread-backed run",
            "sessionKey": "session-1",
            "rootRunId": "run-thread-only",
            "activeRunId": "run-thread-only",
            "source": "agent_run"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-append",
        "trace-thread-backed-run",
        "thread.append_items",
        json!({
            "threadId": "thread-session-1",
            "items": [{
                "itemId": "agent-run:session-1:run-thread-only:trace:approval-1",
                "threadId": "",
                "runId": "run-thread-only",
                "turnId": "run-thread-only",
                "sequence": 0,
                "createdAt": "2026-07-05T00:00:00Z",
                "kind": {
                    "type": "approval_requested",
                    "payload": {
                        "eventId": "approval-1",
                        "eventName": "agent.awaiting_approval",
                        "sessionId": "session-1",
                        "runId": "run-thread-only",
                        "turnId": "run-thread-only",
                        "sequence": 1,
                        "timestamp": "2026-07-05T00:00:00Z",
                        "payload": {
                            "approvalId": "approval-1",
                            "summary": "Allow workspace.write_file?"
                        }
                    }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);

    let run_list = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-list",
        "trace-thread-backed-run",
        "agent_run.list",
        json!({ "sessionId": "session-1" }),
    ));
    assert_eq!(run_list.error, None);
    assert_eq!(run_list.result.as_ref().unwrap()["sessionId"], "session-1");
    assert_eq!(
        run_list.result.as_ref().unwrap()["runs"][0]["runId"],
        "run-thread-only"
    );
    assert_eq!(
        run_list.result.as_ref().unwrap()["runs"][0]["status"],
        "waiting"
    );

    let run_get = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-get",
        "trace-thread-backed-run",
        "agent_run.get",
        json!({ "session_id": "session-1", "run_id": "run-thread-only" }),
    ));
    assert_eq!(run_get.error, None);
    assert_eq!(run_get.result.as_ref().unwrap()["sessionId"], "session-1");
    assert_eq!(run_get.result.as_ref().unwrap()["runId"], "run-thread-only");
    assert_eq!(run_get.result.as_ref().unwrap()["status"], "waiting");
    assert_eq!(
        run_get.result.as_ref().unwrap()["traceEvents"][0]["eventName"],
        "agent.awaiting_approval"
    );

    let trace_page = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-trace",
        "trace-thread-backed-run",
        "agent_run.list_trace",
        json!({ "session_id": "session-1", "run_id": "run-thread-only" }),
    ));
    assert_eq!(trace_page.error, None);
    assert_eq!(
        trace_page.result.as_ref().unwrap()["items"][0]["eventName"],
        "agent.awaiting_approval"
    );

    let runtime_state = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-state",
        "trace-thread-backed-run",
        "agent_run.runtime_state",
        json!({ "session_id": "session-1", "run_id": "run-thread-only" }),
    ));
    assert_eq!(runtime_state.error, None);
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["eventName"],
        "agent.awaiting_approval"
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["timeline"]["items"][0]["kind"],
        "approval"
    );

    let status = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-status",
        "trace-thread-backed-run",
        "thread.status",
        json!({ "threadId": "thread-session-1" }),
    ));
    assert_eq!(status.error, None);
    assert_eq!(
        status.result.as_ref().unwrap()["activeRun"]["runId"],
        "run-thread-only"
    );
    assert_eq!(
        status.result.as_ref().unwrap()["turnItems"][0]["kind"],
        "approval"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-run-read",
        "trace-thread-backed-run",
        "thread.read",
        json!({ "threadId": "thread-session-1" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["activeRun"]["runId"],
        "run-thread-only"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["turnItems"][0]["kind"],
        "approval"
    );
}

#[test]
fn dispatches_agent_run_list_merges_thread_log_and_thread_backed_runs() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let thread_log_record = json!({
        "sessionId": "session-1",
        "runId": "run-thread-log",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "2026-07-05T00:00:00Z",
        "updatedAt": "2026-07-05T00:00:00Z",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "traceEvents": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-mixed-agent-run-upsert",
        "trace-mixed-agent-runs",
        "agent_run.upsert",
        json!({ "record": thread_log_record }),
    ));
    assert_eq!(upsert.error, None);

    let thread_only = router.dispatch(&WorkerRequest::new(
        "req-mixed-agent-run-thread-only",
        "trace-mixed-agent-runs",
        "thread.create",
        json!({
            "threadId": "thread-run-only",
            "title": "Thread-backed run",
            "sessionKey": "session-1",
            "rootRunId": "run-thread-only",
            "activeRunId": "run-thread-only",
            "source": "agent_run"
        }),
    ));
    assert_eq!(thread_only.error, None);

    let duplicate = router.dispatch(&WorkerRequest::new(
        "req-mixed-agent-run-duplicate",
        "trace-mixed-agent-runs",
        "thread.create",
        json!({
            "threadId": "thread-run-log-duplicate",
            "title": "Duplicate thread log run",
            "sessionKey": "session-1",
            "rootRunId": "run-thread-log",
            "activeRunId": "run-thread-log",
            "source": "agent_run"
        }),
    ));
    assert_eq!(duplicate.error, None);

    let run_list = router.dispatch(&WorkerRequest::new(
        "req-mixed-agent-run-list",
        "trace-mixed-agent-runs",
        "agent_run.list",
        json!({ "sessionId": "session-1" }),
    ));

    assert_eq!(run_list.error, None);
    let runs = run_list.result.as_ref().unwrap()["runs"]
        .as_array()
        .expect("agent_run.list should return runs");
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().any(|run| run["runId"] == "run-thread-log"));
    assert!(runs.iter().any(|run| run["runId"] == "run-thread-only"));
}

#[test]
fn dispatches_agent_run_reads_legacy_session_backed_runs() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "agent_runs": [{
            "sessionId": "session-1",
            "runId": "run-legacy-session",
            "status": "completed",
            "phase": "completed",
            "startedAt": "2026-07-05T00:00:00Z",
            "updatedAt": "2026-07-05T00:00:02Z",
            "completedAt": "2026-07-05T00:00:02Z",
            "stopReason": "final_response",
            "model": "fixture-model",
            "provider": "fixture",
            "maxIterations": 4,
            "currentIteration": 1,
            "conversationMessageIds": [],
            "traceMessages": [],
            "traceEvents": [{
                "schemaVersion": "tinybot.agent_event.v1",
                "eventId": "run-legacy-session:agent-done:0000000000000001",
                "sequence": 1,
                "sessionId": "session-1",
                "turnId": "run-legacy-session",
                "itemId": "run-legacy-session:assistant",
                "eventName": "agent.done",
                "phase": "completed",
                "timestamp": "2026-07-05T00:00:02Z",
                "source": "rust_backend",
                "visibility": "user",
                "payload": { "finalContent": "Legacy final response" }
            }],
            "completedToolResults": [],
            "pendingToolCalls": [],
            "checkpoint": null,
            "artifacts": [],
            "usage": [],
            "error": null
        }]
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );

    let run_list = router.dispatch(&WorkerRequest::new(
        "req-legacy-agent-run-list",
        "trace-legacy-agent-run",
        "agent_run.list",
        json!({ "sessionId": "session-1" }),
    ));
    let get = router.dispatch(&WorkerRequest::new(
        "req-legacy-agent-run-get",
        "trace-legacy-agent-run",
        "agent_run.get",
        json!({ "session_id": "session-1", "run_id": "run-legacy-session" }),
    ));
    let runtime_state = router.dispatch(&WorkerRequest::new(
        "req-legacy-agent-run-runtime",
        "trace-legacy-agent-run",
        "agent_run.runtime_state",
        json!({ "session_id": "session-1", "run_id": "run-legacy-session" }),
    ));

    assert_eq!(run_list.error, None);
    assert_eq!(
        run_list.result.as_ref().unwrap()["runs"][0]["runId"],
        "run-legacy-session"
    );
    assert_eq!(get.error, None);
    assert_eq!(get.result.as_ref().unwrap()["status"], "completed");
    assert_eq!(runtime_state.error, None);
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["timeline"]["items"][0]["kind"],
        "assistant_message"
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["timeline"]["items"][0]["data"]["content"],
        "Legacy final response"
    );
}

#[test]
fn dispatches_thread_status_includes_active_child_activity() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-parent",
        "trace-thread-child-activity",
        "thread.create",
        json!({
            "threadId": "thread-parent-activity",
            "title": "Parent thread",
            "sessionKey": "session-activity",
            "source": "agent_run"
        }),
    ));
    assert_eq!(parent.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-child",
        "trace-thread-child-activity",
        "thread.create",
        json!({
            "threadId": "thread-child-activity",
            "title": "Child worker",
            "sessionKey": "session-activity",
            "rootRunId": "run-child-active",
            "activeRunId": "run-child-active",
            "parentThreadId": "thread-parent-activity",
            "source": "subagent"
        }),
    ));
    assert_eq!(child.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-append",
        "trace-thread-child-activity",
        "thread.append_items",
        json!({
            "threadId": "thread-child-activity",
            "items": [{
                "itemId": "agent-run:session-activity:run-child-active:trace:approval-child",
                "threadId": "",
                "runId": "run-child-active",
                "turnId": "run-child-active",
                "sequence": 0,
                "createdAt": "2026-07-05T00:01:00Z",
                "kind": {
                    "type": "approval_requested",
                    "payload": {
                        "eventId": "approval-child",
                        "eventName": "agent.awaiting_approval",
                        "sessionId": "session-activity",
                        "runId": "run-child-active",
                        "turnId": "run-child-active",
                        "sequence": 1,
                        "timestamp": "2026-07-05T00:01:00Z",
                        "payload": {
                            "approvalId": "approval-child",
                            "summary": "Allow child write?"
                        }
                    }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);

    let status = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-status",
        "trace-thread-child-activity",
        "thread.status",
        json!({ "threadId": "thread-parent-activity" }),
    ));
    assert_eq!(status.error, None);
    assert_eq!(
        status.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        status.result.as_ref().unwrap()["childActivities"][0]["activeRun"]["runId"],
        "run-child-active"
    );
    assert_eq!(
        status.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
        "approval"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-read",
        "trace-thread-child-activity",
        "thread.read",
        json!({ "threadId": "thread-parent-activity" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["childActivities"][0]["activeRun"]["runId"],
        "run-child-active"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
        "approval"
    );

    let events = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-events",
        "trace-thread-child-activity",
        "thread.events",
        json!({ "threadId": "thread-parent-activity", "afterSequence": 0 }),
    ));
    assert_eq!(events.error, None);
    assert_eq!(
        events.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["childActivities"][0]["activeRun"]["runId"],
        "run-child-active"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
        "approval"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["events"][2]["type"],
        "child_activity"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["events"][2]["childActivity"]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["events"][2]["childActivity"]["turnItems"][0]["kind"],
        "approval"
    );
}

#[test]
fn agent_run_rpc_enforces_capabilities_and_unknown_run_errors() {
    let fixture = WorkspaceFixture::new();
    let mut denied_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::default(),
    );
    let denied = denied_router.dispatch(&WorkerRequest::new(
        "req-denied",
        "trace-agent-run",
        "agent_run.list",
        json!({ "session_id": "session-1" }),
    ));
    assert_eq!(
        denied.error.as_ref().unwrap().code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );

    let mut read_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let missing = read_router.dispatch(&WorkerRequest::new(
        "req-missing",
        "trace-agent-run",
        "agent_run.get",
        json!({ "session_id": "session-1", "run_id": "missing-run" }),
    ));
    assert_eq!(
        missing.error.as_ref().unwrap().code,
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        missing.error.as_ref().unwrap().details["run_id"],
        "missing-run"
    );

    let malformed = read_router.dispatch(&WorkerRequest::new(
        "req-malformed",
        "trace-agent-run",
        "agent_run.get",
        json!({ "session_id": "session-1" }),
    ));
    assert_eq!(
        malformed.error.as_ref().unwrap().code,
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        malformed.error.as_ref().unwrap().details["method"],
        "agent_run.get"
    );
}

#[test]
fn dispatches_session_writes_for_new_experimental_session() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let set_checkpoint = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.set_checkpoint",
        json!({
            "session_id": "desktop-session-1",
            "checkpoint": { "runId": "run-1", "phase": "awaiting_tools" }
        }),
    );
    let append_messages = WorkerRequest::new(
        "req-2",
        "trace-1",
        "session.append_messages",
        json!({
            "session_id": "desktop-session-1",
            "messages": [
                { "role": "assistant", "content": "done" }
            ]
        }),
    );

    let checkpoint_response = router.dispatch(&set_checkpoint);
    let append_response = router.dispatch(&append_messages);

    assert_eq!(
        checkpoint_response.result.as_ref().unwrap()["session_id"],
        "desktop-session-1"
    );
    assert_eq!(
        checkpoint_response.result.as_ref().unwrap()["extra"]["runtime_checkpoint"],
        json!({ "runId": "run-1", "phase": "awaiting_tools" })
    );
    assert_eq!(
        append_response.result.as_ref().unwrap()["extra"]["messages"],
        json!([{ "role": "assistant", "content": "done" }])
    );
    assert!(checkpoint_response.error.is_none());
    assert!(append_response.error.is_none());
}

#[test]
fn dispatches_diagnostics_append_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::DiagnosticsWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "diagnostics.append",
        json!({ "stream": "stderr", "line": "worker warning" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({ "stream": "stderr", "line": "worker warning" }))
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_task_store_load_missing_as_empty_store() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-task-load",
        "trace-1",
        "task.store.load",
        json!({}),
    ));

    assert_eq!(response.result, Some(json!({ "version": 1, "plans": [] })));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_task_plan_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead, WorkerCapability::TaskWrite]),
    );
    let plan = json!({
        "id": "plan-1",
        "title": "Backend migration",
        "original_request": "Move backend runtime to TS",
        "status": "executing",
        "current_subtask_ids": ["sub-1"],
        "context": { "channel": "desktop" },
        "subtasks": [
            {
                "id": "sub-1",
                "title": "Foundation",
                "description": "Build foundation",
                "status": "in_progress",
                "dependencies": [],
                "parallel_safe": true,
                "retry_count": 0,
                "max_retries": 2
            }
        ]
    });

    let save_response = router.dispatch(&WorkerRequest::new(
        "req-task-save",
        "trace-1",
        "task.plan.save",
        json!({ "plan": plan }),
    ));
    let get_response = router.dispatch(&WorkerRequest::new(
        "req-task-get",
        "trace-1",
        "task.plan.get",
        json!({ "plan_id": "plan-1" }),
    ));
    assert!(fixture.read("plans/store.json").contains("\"plan-1\""));
    let list_response = router.dispatch(&WorkerRequest::new(
        "req-task-list",
        "trace-1",
        "task.plan.list",
        json!({}),
    ));
    let delete_response = router.dispatch(&WorkerRequest::new(
        "req-task-delete",
        "trace-1",
        "task.plan.delete",
        json!({ "plan_id": "plan-1" }),
    ));
    let missing_response = router.dispatch(&WorkerRequest::new(
        "req-task-get-missing",
        "trace-1",
        "task.plan.get",
        json!({ "plan_id": "plan-1" }),
    ));

    assert!(save_response.error.is_none());
    assert_eq!(
        save_response.result.as_ref().unwrap()["plan"]["id"],
        "plan-1"
    );
    assert_eq!(
        get_response.result.as_ref().unwrap()["plan"]["id"],
        "plan-1"
    );
    assert_eq!(
        list_response.result.as_ref().unwrap()["plans"][0]["id"],
        "plan-1"
    );
    assert_eq!(delete_response.result, Some(json!({ "deleted": true })));
    assert_eq!(missing_response.result, Some(json!({ "plan": null })));
}

#[test]
fn dispatches_task_plan_list_filters_completed_by_default() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
        "plans/store.json",
        &json!({
            "version": 1,
            "plans": [
                { "id": "active", "title": "Active", "status": "executing", "subtasks": [] },
                { "id": "done", "title": "Done", "status": "completed", "subtasks": [] }
            ]
        })
        .to_string(),
    );
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead]),
    );

    let default_response = router.dispatch(&WorkerRequest::new(
        "req-task-list",
        "trace-1",
        "task.plan.list",
        json!({}),
    ));
    let include_response = router.dispatch(&WorkerRequest::new(
        "req-task-list-all",
        "trace-1",
        "task.plan.list",
        json!({ "include_completed": true }),
    ));

    assert_eq!(
        default_response.result.as_ref().unwrap()["plans"],
        json!([{ "id": "active", "title": "Active", "status": "executing", "subtasks": [] }])
    );
    assert_eq!(
        include_response.result.as_ref().unwrap()["plans"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn denies_task_plan_save_without_write_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::TaskRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-task-save",
        "trace-1",
        "task.plan.save",
        json!({
            "plan": { "id": "plan-1", "title": "Plan", "subtasks": [] }
        }),
    ));

    let error = response.error.expect("task write should be denied");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "task.write");
    assert!(response.result.is_none());
}

#[test]
fn dispatches_cron_job_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronWrite]),
    );

    let add_response = router.dispatch(&WorkerRequest::new(
        "req-cron-add",
        "trace-1",
        "cron.job.add",
        json!({
            "job": {
                "name": "Check status",
                "schedule": { "kind": "every", "everyMs": 60000 },
                "payload": {
                    "kind": "agent_turn",
                    "message": "Check status",
                    "deliver": true,
                    "channel": "native",
                    "to": "run-1"
                },
                "deleteAfterRun": false
            }
        }),
    ));
    let add_result = add_response
        .result
        .as_ref()
        .expect("cron.job.add should return result");
    assert_eq!(add_response.error, None);
    let job_id = add_result["job"]["id"]
        .as_str()
        .expect("cron job should receive id")
        .to_string();
    assert_eq!(add_result["job"]["name"], "Check status");
    assert_eq!(add_result["job"]["schedule"]["everyMs"], 60000);
    assert_eq!(add_result["job"]["payload"]["to"], "run-1");
    assert!(add_result["job"]["enabled"].as_bool().unwrap());
    assert!(add_result["job"]["createdAtMs"].as_i64().unwrap() > 0);
    assert!(add_result["job"]["state"]["nextRunAtMs"].as_i64().unwrap() > 0);
    assert!(fixture.read("cron/jobs.json").contains(&job_id));

    let list_response = router.dispatch(&WorkerRequest::new(
        "req-cron-list",
        "trace-1",
        "cron.job.list",
        json!({}),
    ));
    assert_eq!(list_response.error, None);
    assert_eq!(
        list_response.result.as_ref().unwrap()["jobs"][0]["id"],
        job_id
    );

    let remove_response = router.dispatch(&WorkerRequest::new(
        "req-cron-remove",
        "trace-1",
        "cron.job.remove",
        json!({ "job_id": job_id }),
    ));
    assert_eq!(remove_response.error, None);
    assert_eq!(remove_response.result, Some(json!({ "status": "removed" })));

    let empty_response = router.dispatch(&WorkerRequest::new(
        "req-cron-list-empty",
        "trace-1",
        "cron.job.list",
        json!({}),
    ));
    assert_eq!(empty_response.result, Some(json!({ "jobs": [] })));
}

#[test]
fn dispatches_cron_job_remove_protects_system_events() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
            "cron/jobs.json",
            &json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "system-job",
                        "name": "System upkeep",
                        "enabled": true,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "system_event", "message": "upkeep" },
                        "state": { "nextRunAtMs": 1234, "lastRunAtMs": null, "lastError": null, "runCount": 0, "history": [] },
                        "createdAtMs": 1000,
                        "updatedAtMs": 1000,
                        "deleteAfterRun": false
                    }
                ]
            })
            .to_string(),
        );
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronWrite]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-cron-protected",
        "trace-1",
        "cron.job.remove",
        json!({ "job_id": "system-job" }),
    ));

    assert_eq!(response.error, None);
    assert_eq!(response.result, Some(json!({ "status": "protected" })));
    assert!(fixture.read("cron/jobs.json").contains("system-job"));
}

#[test]
fn denies_cron_job_add_without_write_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-cron-add",
        "trace-1",
        "cron.job.add",
        json!({
            "job": {
                "name": "Check status",
                "schedule": { "kind": "every", "everyMs": 60000 },
                "payload": { "kind": "agent_turn", "message": "Check status" }
            }
        }),
    ));

    let error = response.error.expect("cron write should be denied");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "cron.write");
    assert!(response.result.is_none());
}

#[test]
fn dispatches_cron_due_and_record_run_updates_store() {
    let fixture = WorkspaceFixture::new();
    fixture.write(
            "cron/jobs.json",
            &json!({
                "version": 1,
                "jobs": [
                    {
                        "id": "due-every",
                        "name": "Every",
                        "enabled": true,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "agent_turn", "message": "check", "deliver": true },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": false
                    },
                    {
                        "id": "due-at",
                        "name": "Once",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 1000 },
                        "payload": { "kind": "agent_turn", "message": "once", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "future",
                        "name": "Future",
                        "enabled": true,
                        "schedule": { "kind": "at", "atMs": 100000 },
                        "payload": { "kind": "agent_turn", "message": "later", "deliver": false },
                        "state": { "nextRunAtMs": 100000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": true
                    },
                    {
                        "id": "disabled",
                        "name": "Disabled",
                        "enabled": false,
                        "schedule": { "kind": "every", "everyMs": 60000 },
                        "payload": { "kind": "agent_turn", "message": "skip", "deliver": false },
                        "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "deleteAfterRun": false
                    }
                ]
            })
            .to_string(),
        );
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::CronRead, WorkerCapability::CronRun]),
    );

    let due_response = router.dispatch(&WorkerRequest::new(
        "req-cron-due",
        "trace-1",
        "cron.job.due",
        json!({ "now_ms": 2000 }),
    ));

    assert_eq!(due_response.error, None);
    assert_eq!(
        due_response.result.as_ref().unwrap()["jobs"],
        json!([
            {
                "id": "due-every",
                "name": "Every",
                "enabled": true,
                "schedule": { "kind": "every", "everyMs": 60000 },
                "payload": { "kind": "agent_turn", "message": "check", "deliver": true, "channel": null, "to": null },
                "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                "createdAtMs": 1,
                "updatedAtMs": 1,
                "deleteAfterRun": false
            },
            {
                "id": "due-at",
                "name": "Once",
                "enabled": true,
                "schedule": { "kind": "at", "atMs": 1000 },
                "payload": { "kind": "agent_turn", "message": "once", "deliver": false, "channel": null, "to": null },
                "state": { "nextRunAtMs": 1000, "lastRunAtMs": null, "lastStatus": null, "lastError": null, "runHistory": [] },
                "createdAtMs": 1,
                "updatedAtMs": 1,
                "deleteAfterRun": true
            }
        ])
    );

    let record_response = router.dispatch(&WorkerRequest::new(
            "req-cron-record",
            "trace-1",
            "cron.job.record_runs",
            json!({
                "now_ms": 3000,
                "records": [
                    { "job_id": "due-every", "run_at_ms": 2000, "status": "ok", "duration_ms": 25 },
                    { "job_id": "due-at", "run_at_ms": 2000, "status": "error", "duration_ms": 5, "error": "boom" }
                ]
            }),
        ));

    assert_eq!(record_response.error, None);
    assert_eq!(
        record_response.result,
        Some(json!({ "updated": ["due-every"], "deleted": ["due-at"], "missing": [] }))
    );
    let store: Value = serde_json::from_str(&fixture.read("cron/jobs.json")).unwrap();
    let every = store["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|job| job["id"] == "due-every")
        .unwrap();
    assert_eq!(every["state"]["lastRunAtMs"], 2000);
    assert_eq!(every["state"]["lastStatus"], "ok");
    assert_eq!(every["state"]["lastError"], Value::Null);
    assert_eq!(every["state"]["nextRunAtMs"], 63000);
    assert_eq!(every["state"]["runHistory"][0]["durationMs"], 25);
    assert!(!fixture.read("cron/jobs.json").contains("due-at"));
}

#[test]
fn dispatches_session_task_progress_upsert_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );

    let first = router.dispatch(&WorkerRequest::new(
        "req-progress-1",
        "trace-1",
        "session.task_progress.upsert",
        json!({
            "session_id": "session-1",
            "plan_id": "plan-1",
            "content": "first progress",
            "progress": {
                "completed": 0,
                "total": 2,
                "steps": [
                    { "step": "Inspect session", "status": "in_progress" },
                    { "step": "Finish session", "status": "pending" }
                ]
            }
        }),
    ));
    let second = router.dispatch(&WorkerRequest::new(
        "req-progress-2",
        "trace-2",
        "session.task_progress.upsert",
        json!({
            "session_id": "session-1",
            "plan_id": "plan-1",
            "content": "updated progress",
            "progress": {
                "completed": 1,
                "total": 2,
                "steps": [
                    { "step": "Inspect session", "status": "completed" },
                    { "step": "Finish session", "status": "in_progress" }
                ]
            }
        }),
    ));

    assert_eq!(first.error, None);
    assert_eq!(second.error, None);
    let messages = second.result.as_ref().unwrap()["extra"]["messages"]
        .as_array()
        .expect("messages should be an array");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "progress");
    assert_eq!(messages[0]["content"], "updated progress");
    assert_eq!(messages[0]["_task_plan_id"], "plan-1");
    assert_eq!(messages[0]["_task_progress"]["completed"], 1);
}

#[test]
fn dispatches_background_run_registry_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    );

    let upsert_response = router.dispatch(&WorkerRequest::new(
        "req-background-upsert",
        "trace-1",
        "background.run.upsert",
        json!({
            "run": {
                "id": "subagent-1",
                "kind": "subagent",
                "source": "task",
                "status": "running",
                "label": "Inspect",
                "sessionKey": "desktop:chat-1",
                "planId": "plan-1",
                "subtaskId": "a",
                "startedAtMs": 1000,
                "updatedAtMs": 1000,
                "metadata": { "traceId": "trace-1" }
            }
        }),
    ));
    assert_eq!(upsert_response.error, None);
    assert_eq!(
        upsert_response.result.as_ref().unwrap()["run"]["id"],
        "subagent-1"
    );
    assert!(fixture
        .read("background/registry.json")
        .contains("subagent-1"));

    let list_response = router.dispatch(&WorkerRequest::new(
        "req-background-list",
        "trace-1",
        "background.run.list",
        json!({}),
    ));
    assert_eq!(list_response.error, None);
    assert_eq!(
        list_response.result.as_ref().unwrap()["runs"][0]["status"],
        "running"
    );

    let complete_response = router.dispatch(&WorkerRequest::new(
        "req-background-complete",
        "trace-1",
        "background.run.complete",
        json!({
            "run_id": "subagent-1",
            "status": "completed",
            "completedAtMs": 2000,
            "result": "inspection complete"
        }),
    ));
    assert_eq!(complete_response.error, None);
    assert_eq!(
        complete_response.result.as_ref().unwrap()["run"]["status"],
        "completed"
    );
    assert_eq!(
        complete_response.result.as_ref().unwrap()["run"]["result"],
        "inspection complete"
    );
    assert_eq!(
        complete_response.result.as_ref().unwrap()["run"]["completedAtMs"],
        2000
    );

    let append_trace_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-append",
        "trace-1",
        "background.trace.append",
        json!({
            "event": {
                "eventId": "event-1",
                "eventType": "agent.delegate.started",
                "sessionKey": "desktop:chat-1",
                "turnId": "turn-1",
                "delegateId": "subagent-1",
                "childRunId": "subagent-1",
                "traceRef": "trace-1",
                "sequence": 1,
                "createdAt": "2026-06-28T00:00:00.000Z",
                "payload": { "status": "running" }
            }
        }),
    ));
    assert_eq!(append_trace_response.error, None);
    assert_eq!(
        append_trace_response.result.as_ref().unwrap()["event"]["eventId"],
        "event-1"
    );

    let list_trace_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-list",
        "trace-1",
        "background.trace.list",
        json!({
            "filter": {
                "sessionKey": "desktop:chat-1",
                "delegateId": "subagent-1"
            }
        }),
    ));
    assert_eq!(list_trace_response.error, None);
    assert_eq!(
        list_trace_response.result.as_ref().unwrap()["events"][0]["eventType"],
        "agent.delegate.started"
    );

    let get_trace_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-get",
        "trace-1",
        "background.trace.get_delegate_trace",
        json!({
            "filter": {
                "sessionKey": "desktop:chat-1",
                "delegateId": "subagent-1"
            }
        }),
    ));
    assert_eq!(get_trace_response.error, None);
    assert_eq!(
        get_trace_response.result.as_ref().unwrap()["trace"]["status"],
        "running"
    );
    assert_eq!(
        get_trace_response.result.as_ref().unwrap()["trace"]["events"][0]["eventType"],
        "agent.delegate.started"
    );

    let append_artifact_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-artifact-append",
        "trace-1",
        "background.trace.append",
        json!({
            "event": {
                "eventId": "event-artifact-1",
                "eventType": "child.artifact.created",
                "sessionKey": "desktop:chat-1",
                "turnId": "turn-1",
                "delegateId": "subagent-1",
                "childRunId": "subagent-1",
                "childStepId": "artifact-1",
                "traceRef": "trace-1",
                "sequence": 2,
                "createdAt": "2026-06-28T00:00:01.000Z",
                "payload": {
                    "artifactId": "artifact-1",
                    "kind": "diff",
                    "title": "Patch"
                }
            }
        }),
    ));
    assert_eq!(append_artifact_response.error, None);
    let get_artifact_response = router.dispatch(&WorkerRequest::new(
        "req-background-trace-get-artifact",
        "trace-1",
        "background.trace.get_artifact",
        json!({
            "filter": {
                "sessionKey": "desktop:chat-1",
                "delegateId": "subagent-1",
                "artifactId": "artifact-1"
            }
        }),
    ));
    assert_eq!(get_artifact_response.error, None);
    assert_eq!(
        get_artifact_response.result.as_ref().unwrap()["artifact"]["artifactId"],
        "artifact-1"
    );
}

#[test]
fn background_subagent_enqueue_input_writes_user_message_trace_event() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-background-subagent-input",
        "trace-1",
        "background.subagent.enqueue_input",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "subagent-1",
            "content": "Use the safer option.",
            "traceRef": "trace-subagent-1",
            "childRunId": "run-subagent-1",
            "createdAt": "2026-06-28T00:00:02.000Z"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response
        .result
        .as_ref()
        .expect("enqueue should return a result");
    assert_eq!(result["accepted"], true);
    assert_eq!(result["delivery"], "queued_for_runtime");
    assert_eq!(
        result["event"]["eventType"],
        "agent.delegate.message_queued"
    );
    assert_eq!(result["event"]["sessionKey"], "desktop:chat-1");
    assert_eq!(result["event"]["delegateId"], "subagent-1");
    assert_eq!(
        result["event"]["payload"]["content"],
        "Use the safer option."
    );
    assert_eq!(result["event"]["payload"]["source"], "user");
}

#[test]
fn dispatches_subagent_control_requests() {
    let fixture = WorkspaceFixture::new();
    let manager = SubagentThreadManager::default();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .with_subagent_manager(manager);

    let spawn = router.dispatch(&WorkerRequest::new(
        "req-subagent-spawn",
        "trace-subagent",
        "subagent.spawn",
        json!({
            "sessionKey": "desktop:chat-1",
            "parentRunId": "parent-run-1",
            "subagentId": "delegate-1",
            "childRunId": "child-1",
            "traceRef": "trace-delegate-1",
            "name": "Goodall",
            "task": "Inspect a narrow question",
            "metadata": {
                "role": "research",
                "nickname": "Scout",
                "depth": 1,
                "capacity": { "maxActivePerSession": 8 }
            }
        }),
    ));
    assert_eq!(spawn.error, None);
    assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);

    let send = router.dispatch(&WorkerRequest::new(
        "req-subagent-send",
        "trace-subagent",
        "subagent.send_input",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "delegate-1",
            "content": "Please continue",
            "sender": "main_agent"
        }),
    ));
    assert_eq!(send.error, None);
    assert_eq!(send.result.as_ref().unwrap()["delivery"], "live_delivered");
    assert_eq!(send.result.as_ref().unwrap()["subagent"]["mailboxDepth"], 1);

    let wait = router.dispatch(&WorkerRequest::new(
        "req-subagent-wait",
        "trace-subagent",
        "subagent.wait",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentIds": ["delegate-1"],
            "timeoutMs": 1
        }),
    ));
    assert_eq!(wait.error, None);
    assert_eq!(wait.result.as_ref().unwrap()["timedOut"], true);

    let close = router.dispatch(&WorkerRequest::new(
        "req-subagent-close",
        "trace-subagent",
        "subagent.close",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(close.error, None);
    assert_eq!(close.result.as_ref().unwrap()["accepted"], true);
    assert_eq!(
        close.result.as_ref().unwrap()["subagent"]["status"],
        "closed"
    );

    let default_thread_list = router.dispatch(&WorkerRequest::new(
        "req-subagent-default-thread-list",
        "trace-subagent",
        "thread.list",
        json!({ "includeArchived": true }),
    ));
    assert_eq!(default_thread_list.error, None);
    let default_threads = default_thread_list.result.as_ref().unwrap()["threads"]
        .as_array()
        .expect("thread list should be an array");
    assert_eq!(default_threads.len(), 1);
    assert_eq!(default_threads[0]["source"], "subagent_parent");

    let thread_list = router.dispatch(&WorkerRequest::new(
        "req-subagent-thread-list",
        "trace-subagent",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    assert_eq!(thread_list.error, None);
    let threads = thread_list.result.as_ref().unwrap()["threads"]
        .as_array()
        .expect("thread list should be an array");
    assert_eq!(threads.len(), 2);
    let parent_thread = threads
        .iter()
        .find(|thread| thread["source"] == "subagent_parent")
        .expect("parent thread should be projected");
    let child_thread = threads
        .iter()
        .find(|thread| thread["source"] == "subagent")
        .expect("child thread should be projected");
    assert_eq!(child_thread["parentThreadId"], parent_thread["threadId"]);
    assert_eq!(
        child_thread["metadata"]["extra"]["subagentId"],
        "delegate-1"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["agentId"],
        "delegate-1"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["agentPath"],
        json!(["main", "delegate-1"])
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["role"],
        "research"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["nickname"],
        "Scout"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["depth"],
        1
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["capacity"],
        json!({
            "maxActivePerSession": 8,
            "maxActiveGlobal": 32,
            "maxDelegationDepth": 4
        })
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["status"],
        "closed"
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["active"],
        false
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["terminal"],
        true
    );
    assert_eq!(
        child_thread["metadata"]["extra"]["agentControl"]["lifecycle"]["mailboxDepth"],
        1
    );

    let direct_child_list = router.dispatch(&WorkerRequest::new(
        "req-subagent-direct-child-list",
        "trace-subagent",
        "thread.list",
        json!({
            "includeArchived": true,
            "parentThreadId": parent_thread["threadId"]
        }),
    ));
    assert_eq!(direct_child_list.error, None);
    assert_eq!(
        direct_child_list.result.as_ref().unwrap()["threads"][0]["threadId"],
        child_thread["threadId"]
    );

    let descendant_search = router.dispatch(&WorkerRequest::new(
        "req-subagent-descendant-search",
        "trace-subagent",
        "thread.search",
        json!({
            "query": "narrow question",
            "includeArchived": true,
            "ancestorThreadId": parent_thread["threadId"]
        }),
    ));
    assert_eq!(descendant_search.error, None);
    assert_eq!(
        descendant_search.result.as_ref().unwrap()["threads"][0]["threadId"],
        child_thread["threadId"]
    );

    let parent_read = router.dispatch(&WorkerRequest::new(
        "req-subagent-parent-thread-read",
        "trace-subagent",
        "thread.read",
        json!({ "threadId": parent_thread["threadId"] }),
    ));
    assert_eq!(parent_read.error, None);
    assert_eq!(
        parent_read.result.as_ref().unwrap()["children"][0]["threadId"],
        child_thread["threadId"]
    );
    assert_eq!(
        parent_read.result.as_ref().unwrap()["children"][0]["agentControl"]["agentId"],
        "delegate-1"
    );
    assert_eq!(
        parent_read.result.as_ref().unwrap()["children"][0]["agentControl"]["lifecycle"]["status"],
        "closed"
    );
    assert_eq!(
        parent_read.result.as_ref().unwrap()["pagination"]["itemCount"],
        2
    );
    let parent_kinds = parent_read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(parent_kinds, vec!["subagent_spawned", "subagent_completed"]);

    let child_read = router.dispatch(&WorkerRequest::new(
        "req-subagent-child-thread-read",
        "trace-subagent",
        "thread.read",
        json!({ "threadId": child_thread["threadId"] }),
    ));
    assert_eq!(child_read.error, None);
    assert_eq!(
        child_read.result.as_ref().unwrap()["runs"][0]["runId"],
        "child-1"
    );
    assert_eq!(
        child_read.result.as_ref().unwrap()["runs"][0]["active"],
        false
    );
    assert_eq!(
        child_read.result.as_ref().unwrap()["pagination"]["itemCount"],
        4
    );
    let child_kinds = child_read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        child_kinds,
        vec![
            "user_message",
            "agent_run_started",
            "user_message",
            "agent_run_completed",
        ]
    );

    let delete_parent_only = router.dispatch(&WorkerRequest::new(
        "req-subagent-thread-delete-parent-only",
        "trace-subagent",
        "thread.delete",
        json!({ "threadId": parent_thread["threadId"] }),
    ));
    assert_eq!(
        delete_parent_only.error.as_ref().unwrap().code,
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
    );

    let delete_tree = router.dispatch(&WorkerRequest::new(
        "req-subagent-thread-delete-tree",
        "trace-subagent",
        "thread.delete",
        json!({ "threadId": parent_thread["threadId"], "deleteChildren": true }),
    ));
    assert_eq!(delete_tree.error, None);
    assert_eq!(delete_tree.result.as_ref().unwrap()["deleted"], true);
    assert_eq!(
        delete_tree.result.as_ref().unwrap()["deletedChildren"],
        json!([child_thread["threadId"].clone()])
    );
}

#[test]
fn subagent_history_modes_copy_only_public_parent_messages() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .with_subagent_manager(SubagentThreadManager::default());

    let create = router.dispatch(&WorkerRequest::new(
        "req-history-thread-create",
        "trace-history",
        "thread.create",
        json!({
            "threadId": "thread-history-parent",
            "title": "History parent",
            "sessionKey": "desktop:history",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-history-thread-append",
        "trace-history",
        "thread.append_items",
        json!({
            "threadId": "thread-history-parent",
            "items": [
                {
                    "itemId": "history:user:old",
                    "threadId": "",
                    "runId": "parent-run",
                    "turnId": "turn-old",
                    "sequence": 0,
                    "createdAt": "1000",
                    "kind": { "type": "user_message", "payload": { "text": "old user" } }
                },
                {
                    "itemId": "history:assistant:old",
                    "threadId": "",
                    "runId": "parent-run",
                    "turnId": "turn-old",
                    "sequence": 0,
                    "createdAt": "1001",
                    "kind": { "type": "assistant_message_completed", "payload": { "text": "old assistant" } }
                },
                {
                    "itemId": "history:reasoning:private",
                    "threadId": "",
                    "runId": "parent-run",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1002",
                    "kind": { "type": "reasoning", "payload": { "text": "private reasoning" } }
                },
                {
                    "itemId": "history:tool:private",
                    "threadId": "",
                    "runId": "parent-run",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1003",
                    "kind": { "type": "tool_call_output", "payload": { "text": "private tool output" } }
                },
                {
                    "itemId": "history:user:current",
                    "threadId": "",
                    "runId": "parent-run",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1004",
                    "kind": { "type": "user_message", "payload": { "text": "current user" } }
                },
                {
                    "itemId": "history:assistant:current",
                    "threadId": "",
                    "runId": "parent-run",
                    "turnId": "turn-current",
                    "sequence": 0,
                    "createdAt": "1005",
                    "kind": { "type": "assistant_message_completed", "payload": { "text": "current assistant" } }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    for (subagent_id, history_mode) in [
        ("delegate-parent-turn", "parent_turn"),
        ("delegate-full-history", "full_history"),
    ] {
        let spawn = router.dispatch(&WorkerRequest::new(
            format!("req-history-spawn-{subagent_id}"),
            "trace-history",
            "subagent.spawn",
            json!({
                "sessionKey": "desktop:history",
                "parentRunId": "parent-run",
                "subagentId": subagent_id,
                "childRunId": format!("run-{subagent_id}"),
                "task": "Inspect inherited context",
                "historyMode": history_mode
            }),
        ));
        assert_eq!(spawn.error, None);
        assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);
    }

    let list = router.dispatch(&WorkerRequest::new(
        "req-history-thread-list",
        "trace-history",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    assert_eq!(list.error, None);
    let threads = list.result.as_ref().unwrap()["threads"].as_array().unwrap();

    for (subagent_id, expected_messages) in [
        (
            "delegate-parent-turn",
            vec!["current user", "current assistant"],
        ),
        (
            "delegate-full-history",
            vec![
                "old user",
                "old assistant",
                "current user",
                "current assistant",
            ],
        ),
    ] {
        let child = threads
            .iter()
            .find(|thread| thread["metadata"]["extra"]["subagentId"] == subagent_id)
            .unwrap();
        let read = router.dispatch(&WorkerRequest::new(
            format!("req-history-read-{subagent_id}"),
            "trace-history",
            "thread.read",
            json!({ "threadId": child["threadId"] }),
        ));
        assert_eq!(read.error, None);
        let inherited = read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| !item["kind"]["payload"]["inherited"].is_null())
            .map(|item| item["kind"]["payload"]["text"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(inherited, expected_messages);
        assert!(read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(
                |item| item["kind"]["payload"]["text"] != "private reasoning"
                    && item["kind"]["payload"]["text"] != "private tool output"
            ));
    }
}

#[test]
fn nested_subagents_persist_their_direct_parent_thread_edge() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .with_subagent_manager(SubagentThreadManager::with_limits(4, 8, 3));

    for params in [
        json!({
            "sessionKey": "desktop:nested",
            "parentRunId": "root-run",
            "subagentId": "delegate-parent",
            "childRunId": "delegate-parent-run",
            "delegationDepth": 1,
            "task": "Delegate a bounded child task"
        }),
        json!({
            "sessionKey": "desktop:nested",
            "parentRunId": "delegate-parent-run",
            "parentSubagentId": "delegate-parent",
            "subagentId": "delegate-child",
            "childRunId": "delegate-child-run",
            "delegationDepth": 2,
            "task": "Inspect the nested detail"
        }),
    ] {
        let spawn = router.dispatch(&WorkerRequest::new(
            format!("req-nested-spawn-{}", params["subagentId"]),
            "trace-nested",
            "subagent.spawn",
            params,
        ));
        assert_eq!(spawn.error, None);
        assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);
    }

    let list = router.dispatch(&WorkerRequest::new(
        "req-nested-thread-list",
        "trace-nested",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    assert_eq!(list.error, None);
    let threads = list.result.as_ref().unwrap()["threads"].as_array().unwrap();
    let parent = threads
        .iter()
        .find(|thread| thread["metadata"]["extra"]["subagentId"] == "delegate-parent")
        .unwrap();
    let child = threads
        .iter()
        .find(|thread| thread["metadata"]["extra"]["subagentId"] == "delegate-child")
        .unwrap();
    assert_eq!(child["parentThreadId"], parent["threadId"]);
    assert_eq!(
        child["metadata"]["extra"]["agentControl"]["parentAgentId"],
        "delegate-parent"
    );
    assert_eq!(child["metadata"]["extra"]["agentControl"]["depth"], 2);
}

#[test]
fn background_subagent_enqueue_input_live_delivers_when_manager_has_child() {
    let fixture = WorkspaceFixture::new();
    let manager = SubagentThreadManager::default();
    manager.spawn(SubagentSpawnParams {
        session_key: "desktop:chat-1".to_string(),
        parent_run_id: Some("parent-run".to_string()),
        parent_subagent_id: None,
        delegation_depth: None,
        history_mode: None,
        subagent_id: Some("delegate-1".to_string()),
        child_run_id: Some("child-1".to_string()),
        trace_ref: Some("trace-delegate-1".to_string()),
        name: Some("Goodall".to_string()),
        task: Some("Inspect a narrow question".to_string()),
        status: None,
        created_at: None,
        metadata: json!({}),
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
        ]),
    )
    .with_subagent_manager(manager);

    let response = router.dispatch(&WorkerRequest::new(
        "req-background-subagent-input",
        "trace-1",
        "background.subagent.enqueue_input",
        json!({
            "sessionKey": "desktop:chat-1",
            "subagentId": "delegate-1",
            "content": "User intervention",
            "traceRef": "trace-delegate-1",
            "childRunId": "child-1",
            "createdAt": "2026-06-28T00:00:02.000Z"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(result["delivery"], "live_delivered");
    assert_eq!(result["event"]["payload"]["delivery"], "live_delivered");
    assert_eq!(result["subagent"]["mailboxDepth"], 1);
}

#[test]
fn subagent_list_restores_interrupted_children_from_background_trace() {
    let fixture = WorkspaceFixture::new();
    let manager = SubagentThreadManager::default();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::BackgroundRead,
            WorkerCapability::BackgroundWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .with_subagent_manager(manager);

    let append = router.dispatch(&WorkerRequest::new(
        "req-background-trace-append",
        "trace-1",
        "background.trace.append",
        json!({
            "event": {
                "eventId": "event-running",
                "eventType": "agent.delegate.running",
                "sessionKey": "desktop:chat-1",
                "turnId": "parent-run",
                "delegateId": "delegate-1",
                "childRunId": "child-1",
                "traceRef": "trace-delegate-1",
                "sequence": 1,
                "createdAt": "2026-06-28T00:00:00.000Z",
                "payload": { "name": "Goodall", "task": "Inspect" }
            }
        }),
    ));
    assert_eq!(append.error, None);

    let list = router.dispatch(&WorkerRequest::new(
        "req-subagent-list",
        "trace-1",
        "subagent.list",
        json!({ "sessionKey": "desktop:chat-1" }),
    ));

    assert_eq!(list.error, None);
    let subagents = list.result.as_ref().unwrap()["subagents"]
        .as_array()
        .expect("subagent list should be an array");
    assert_eq!(subagents.len(), 1);
    assert_eq!(subagents[0]["subagentId"], "delegate-1");
    assert_eq!(subagents[0]["status"], "interrupted");
}

#[test]
fn subagent_restart_restores_canonical_edges_and_resumes_only_selected_children() {
    let fixture = WorkspaceFixture::new();
    let policy = CapabilityPolicy::new([
        WorkerCapability::BackgroundRead,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]);
    let first_manager = SubagentThreadManager::with_limits(4, 8, 3);
    let mut first_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone())
            .with_subagent_manager(first_manager);

    for subagent_id in ["delegate-1", "delegate-2"] {
        let spawn = first_router.dispatch(&WorkerRequest::new(
            format!("req-spawn-{subagent_id}"),
            "trace-subagent-restart",
            "subagent.spawn",
            json!({
                "sessionKey": "desktop:restart",
                "parentRunId": "parent-run",
                "subagentId": subagent_id,
                "childRunId": format!("child-{subagent_id}"),
                "task": format!("Task for {subagent_id}"),
                "historyMode": "isolated"
            }),
        ));
        assert_eq!(spawn.error, None);
        assert_eq!(spawn.result.as_ref().unwrap()["accepted"], true);
    }
    let before_restart_input = first_router.dispatch(&WorkerRequest::new(
        "req-input-before-restart",
        "trace-subagent-restart",
        "subagent.send_input",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1",
            "content": "before restart",
            "sender": "main_agent"
        }),
    ));
    assert_eq!(before_restart_input.error, None);
    drop(first_router);

    let second_manager = SubagentThreadManager::with_limits(4, 8, 3);
    let mut second_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone())
            .with_subagent_manager(second_manager);
    let restored = second_router.dispatch(&WorkerRequest::new(
        "req-list-restored",
        "trace-subagent-restart",
        "subagent.list",
        json!({ "sessionKey": "desktop:restart" }),
    ));
    assert_eq!(restored.error, None);
    assert_eq!(
        restored.result.as_ref().unwrap()["subagents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(restored.result.as_ref().unwrap()["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|subagent| subagent["status"] == "interrupted"));

    let resumed = second_router.dispatch(&WorkerRequest::new(
        "req-resume-selected",
        "trace-subagent-restart",
        "subagent.resume",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(resumed.error, None);
    assert_eq!(resumed.result.as_ref().unwrap()["accepted"], true);
    assert_eq!(
        resumed.result.as_ref().unwrap()["subagent"]["status"],
        "running"
    );
    let after_restart_input = second_router.dispatch(&WorkerRequest::new(
        "req-input-after-restart",
        "trace-subagent-restart",
        "subagent.send_input",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1",
            "content": "after restart",
            "sender": "main_agent"
        }),
    ));
    assert_eq!(after_restart_input.error, None);

    let thread_list = second_router.dispatch(&WorkerRequest::new(
        "req-list-restarted-child-threads",
        "trace-subagent-restart",
        "thread.list",
        json!({ "includeArchived": true, "includeChildThreads": true }),
    ));
    let delegate_thread = thread_list.result.as_ref().unwrap()["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["metadata"]["extra"]["subagentId"] == "delegate-1")
        .unwrap();
    let delegate_read = second_router.dispatch(&WorkerRequest::new(
        "req-read-restarted-child-thread",
        "trace-subagent-restart",
        "thread.read",
        json!({ "threadId": delegate_thread["threadId"] }),
    ));
    let delivered_inputs = delegate_read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"]["payload"]["sender"] == "main_agent")
        .map(|item| item["kind"]["payload"]["text"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(delivered_inputs, vec!["before restart", "after restart"]);

    let after_resume = second_router.dispatch(&WorkerRequest::new(
        "req-list-after-resume",
        "trace-subagent-restart",
        "subagent.list",
        json!({ "sessionKey": "desktop:restart" }),
    ));
    let statuses = after_resume.result.as_ref().unwrap()["subagents"]
        .as_array()
        .unwrap();
    assert_eq!(statuses[0]["status"], "running");
    assert_eq!(statuses[1]["status"], "interrupted");

    let closed = second_router.dispatch(&WorkerRequest::new(
        "req-close-selected",
        "trace-subagent-restart",
        "subagent.close",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(closed.error, None);
    assert_eq!(closed.result.as_ref().unwrap()["accepted"], true);
    drop(second_router);

    let third_manager = SubagentThreadManager::with_limits(4, 8, 3);
    let mut third_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy)
            .with_subagent_manager(third_manager);
    let closed_resume = third_router.dispatch(&WorkerRequest::new(
        "req-resume-explicitly-closed",
        "trace-subagent-restart",
        "subagent.resume",
        json!({
            "sessionKey": "desktop:restart",
            "subagentId": "delegate-1"
        }),
    ));
    assert_eq!(closed_resume.error, None);
    assert_eq!(closed_resume.result.as_ref().unwrap()["accepted"], false);
    assert_eq!(
        closed_resume.result.as_ref().unwrap()["error"]["code"],
        "forbidden"
    );
}

#[test]
fn denies_background_run_write_without_write_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::BackgroundRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-background-upsert",
        "trace-1",
        "background.run.upsert",
        json!({
            "run": {
                "id": "subagent-1",
                "kind": "subagent",
                "source": "task",
                "status": "running",
                "startedAtMs": 1000,
                "updatedAtMs": 1000
            }
        }),
    ));

    let error = response.error.expect("background write should be denied");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["capability"], "background.write");
    assert!(response.result.is_none());
}

#[test]
fn dispatches_session_temporary_file_lifecycle() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.session_id = "websocket:chat-1".to_string();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let upload_response = router.dispatch(&WorkerRequest::new(
        "req-session-file-upload",
        "trace-session-file-upload",
        "session.temporary_file.upload",
        json!({
            "session_id": "websocket:chat-1",
            "name": "Session Notes.md",
            "file_type": "md",
            "content": "# Session Notes\n\nTemporary evidence for this chat.",
            "size_bytes": 50
        }),
    ));

    assert_eq!(upload_response.error, None);
    let upload_result = upload_response
        .result
        .as_ref()
        .expect("session temporary file upload should return result");
    assert_eq!(upload_result["name"], "Session Notes.md");
    assert_eq!(upload_result["temporary"], true);
    assert_eq!(upload_result["source"], "session_upload");

    let list_response = router.dispatch(&WorkerRequest::new(
        "req-session-file-list",
        "trace-session-file-list",
        "session.temporary_file.list",
        json!({ "session_id": "websocket:chat-1" }),
    ));

    assert_eq!(list_response.error, None);
    assert_eq!(
        list_response.result.as_ref().unwrap()["session_id"],
        "websocket:chat-1"
    );
    assert_eq!(
        list_response.result.as_ref().unwrap()["temporary_files"][0]["name"],
        "Session Notes.md"
    );

    let clear_response = router.dispatch(&WorkerRequest::new(
        "req-session-file-clear",
        "trace-session-file-clear",
        "session.temporary_file.clear",
        json!({ "session_id": "websocket:chat-1" }),
    ));

    assert_eq!(clear_response.error, None);
    assert_eq!(
        clear_response.result.as_ref().unwrap()["session_id"],
        "websocket:chat-1"
    );
    assert_eq!(clear_response.result.as_ref().unwrap()["cleared"], 1);
    assert_eq!(
        clear_response.result.as_ref().unwrap()["temporary_files"],
        json!([])
    );
}

fn approve_once(
    router: &mut WorkerRpcRouter,
    run_id: &str,
    session_id: &str,
    operation: Value,
    category: &str,
    risk: &str,
    reason: &str,
) {
    let requested_tool_name = operation["toolName"]
        .as_str()
        .expect("approval helper operation should identify a tool");
    let tool_id = match requested_tool_name {
        "write_file" => "workspace.write_file",
        "apply_patch" => "workspace.apply_patch",
        "delete_file" => "workspace.delete_file",
        "exec" => "shell.execute",
        other => other,
    };
    let tool = router
        .tool_registry
        .get_tool(tool_id)
        .unwrap_or_else(|| panic!("approval helper tool should be registered: {tool_id}"));
    let evaluation = router
        .permission_profile
        .evaluate_tool(
            &tool,
            PermissionEvaluateToolRequest {
                tool_id: tool_id.to_string(),
                arguments: operation["arguments"].clone(),
                session_id: Some(session_id.to_string()),
                run_id: Some(run_id.to_string()),
            },
        )
        .expect("approval helper effects should normalize");
    let approval = evaluation
        .approval_request
        .expect("approval helper tool should require approval");
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-approval-helper",
        "trace-approval",
        "approval.request",
        json!({
            "run_id": run_id,
            "session_id": session_id,
            "operation": approval.operation,
            "classification": {
                "category": category,
                "risk": risk,
                "reason": reason
            },
            "fingerprint": approval.fingerprint,
            "session_fingerprint": approval.session_fingerprint,
            "scope": approval.scope,
            "lifetime": approval.lifetime,
            "effects": approval.effects
        }),
    ));
    let approval_id = request_response.result.as_ref().unwrap()["approvalId"]
        .as_str()
        .unwrap()
        .to_string();
    let resolve_response = router.dispatch(&WorkerRequest::new(
        "req-approval-resolve-helper",
        "trace-approval",
        "approval.resolve",
        json!({
            "session_id": session_id,
            "approval_id": approval_id,
            "approved": true,
            "scope": "once"
        }),
    ));
    assert!(resolve_response.error.is_none());
}

#[test]
fn workspace_write_consumes_matching_once_approval_grant() {
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

    let denied = router.dispatch(&WorkerRequest::new(
        "req-write-denied",
        "trace-1",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "hello",
            "session_id": "session-1"
        }),
    ));
    let error = denied.error.expect("write without approval should fail");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["boundary"], "security");
    assert!(!fixture.root.join("notes").join("today.md").exists());

    approve_once(
        &mut router,
        "run-1",
        "session-1",
        json!({
            "toolName": "write_file",
            "arguments": { "path": "notes/today.md" }
        }),
        "filesystem_write",
        "medium",
        "File write/edit/delete tools can modify workspace state.",
    );

    let allowed = router.dispatch(&WorkerRequest::new(
        "req-write-allowed",
        "trace-3",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "hello",
            "session_id": "session-1"
        }),
    ));
    assert!(allowed.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "hello");

    let reused = router.dispatch(&WorkerRequest::new(
        "req-write-reused",
        "trace-4",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "changed",
            "session_id": "session-1"
        }),
    ));
    assert_eq!(
        reused.error.expect("once approval should be consumed").code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(fixture.read("notes/today.md"), "hello");
}

#[test]
fn workspace_write_allows_trusted_internal_operations_without_approval() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceWrite]),
    );

    let denied = router.dispatch(&WorkerRequest::new(
        "req-write-denied",
        "trace-1",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "agent write",
            "session_id": "session-1"
        }),
    ));
    assert_eq!(
        denied
            .error
            .expect("agent write should require approval")
            .code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert!(!fixture.root.join("notes").join("today.md").exists());

    let spoofed = router.dispatch(&WorkerRequest::new(
        "req-write-spoofed",
        "trace-2",
        "workspace.write_file",
        json!({
            "path": "notes/today.md",
            "contents": "spoofed write",
            "internal_operation": true
        }),
    ));
    assert_eq!(
        spoofed
            .error
            .expect("serialized internal flag must not bypass approval")
            .code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );

    let allowed = router.dispatch(
        &WorkerRequest::new(
            "req-write-internal",
            "trace-3",
            "workspace.write_file",
            json!({
                "path": "notes/today.md",
                "contents": "webui write"
            }),
        )
        .with_trusted_internal(),
    );
    assert!(allowed.error.is_none());
    assert_eq!(fixture.read("notes/today.md"), "webui write");
}

#[test]
fn shell_execute_requires_matching_approval_grant() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-shell-denied",
        "trace-1",
        "shell.execute",
        json!({
            "command": "echo tinybot",
            "working_dir": ".",
            "timeout": 30,
            "session_id": "session-1"
        }),
    ));

    let error = response.error.expect("shell without approval should fail");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["boundary"], "security");
    assert_eq!(error.details["category"], "shell");
    assert!(error.details["fingerprint"]
        .as_str()
        .unwrap()
        .starts_with("exec:sha256:"));
    assert_eq!(error.details["effects"]["sandboxMode"], "unsandboxed");
    assert_eq!(error.details["effects"]["network"]["mode"], "unrestricted");
}

#[test]
fn dispatches_workspace_list_dir_and_delete_file_requests() {
    let fixture = WorkspaceFixture::new();
    fixture.write("notes/today.md", "hello");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::FsWorkspaceWrite,
        ]),
    );

    let list_response = router.dispatch(&WorkerRequest::new(
        "req-list",
        "trace-1",
        "workspace.list_dir",
        json!({ "path": ".", "recursive": true, "max_entries": 10 }),
    ));
    approve_once(
        &mut router,
        "run-delete",
        "session-1",
        json!({
            "toolName": "delete_file",
            "arguments": { "path": "notes" }
        }),
        "filesystem_write",
        "medium",
        "File write/edit/delete tools can modify workspace state.",
    );
    let delete_response = router.dispatch(&WorkerRequest::new(
        "req-delete",
        "trace-1",
        "workspace.delete_file",
        json!({ "path": "notes", "recursive": true, "session_id": "session-1" }),
    ));

    assert_eq!(
        list_response.result.as_ref().unwrap()["entries"][0]["path"],
        "notes/"
    );
    assert_eq!(
        list_response.result.as_ref().unwrap()["entries"][1]["path"],
        "notes/today.md"
    );
    assert_eq!(
        delete_response.result,
        Some(json!({ "path": "notes", "kind": "dir", "deleted": true }))
    );
    assert!(list_response.error.is_none());
    assert!(delete_response.error.is_none());
}

#[test]
fn dispatches_shell_execute_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    approve_once(
        &mut router,
        "run-shell",
        "session-1",
        json!({
            "toolName": "exec",
            "arguments": { "command": "echo tinybot" }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-shell",
        "trace-1",
        "shell.execute",
        json!({
            "command": "echo tinybot",
            "working_dir": ".",
            "timeout": 5,
            "session_id": "session-1"
        }),
    ));

    let result = response.result.expect("shell.execute should return result");
    assert_eq!(result["exit_code"], 0);
    assert_eq!(result["timed_out"], false);
    assert_eq!(result["blocked"], false);
    assert_eq!(result["sandbox_mode"], "unsandboxed_approved");
    assert_eq!(result["network_mode"], "unrestricted");
    assert_eq!(result["approval_decision"], "approved");
    assert!(result["content"].as_str().unwrap().contains("tinybot"));
    assert!(response.error.is_none());
}

#[cfg(target_os = "windows")]
#[test]
fn read_only_shell_approval_cannot_authorize_unsandboxed_execution() {
    let fixture = WorkspaceFixture::new();
    fixture.write("readable.txt", "readable-content");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = "type readable.txt & echo blocked>blocked.txt";
    approve_once(
        &mut router,
        "run-shell-read-only",
        "session-1",
        json!({
            "toolName": "exec",
            "arguments": {
                "command": command,
                "sandboxMode": "read_only",
                "networkMode": "unrestricted"
            }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

    let unsandboxed = router.dispatch(&WorkerRequest::new(
        "req-shell-unsandboxed",
        "trace-shell-read-only",
        "shell.execute",
        json!({
            "command": command,
            "sessionId": "session-1",
            "runId": "run-shell-read-only"
        }),
    ));
    let error = unsandboxed
        .error
        .expect("read-only approval must not authorize unsandboxed execution");
    assert_eq!(
        error.code,
        crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.details["effects"]["sandboxMode"], "unsandboxed");

    let read_only = router.dispatch(&WorkerRequest::new(
        "req-shell-read-only",
        "trace-shell-read-only",
        "shell.execute",
        json!({
            "command": command,
            "sandboxMode": "read_only",
            "networkMode": "unrestricted",
            "sessionId": "session-1",
            "runId": "run-shell-read-only"
        }),
    ));
    assert!(read_only.error.is_none(), "{read_only:?}");
    let result = read_only.result.unwrap();
    assert!(result["stdout"]
        .as_str()
        .unwrap()
        .contains("readable-content"));
    assert_ne!(result["exit_code"], 0);
    assert_eq!(
        result["sandbox_mode"],
        "windows_restricted_low_integrity_read_only"
    );
    assert_eq!(result["network_mode"], "unrestricted");
    assert_eq!(result["approval_decision"], "approved");
    assert!(!fixture.root.join("blocked.txt").exists());
}

#[test]
fn dispatches_owned_shell_process_lifecycle() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = blocking_shell_command_with_marker();
    approve_once(
        &mut router,
        "run-shell-process",
        "session-shell-process",
        json!({
            "toolName": "exec_command",
            "arguments": { "command": command.clone() }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

    let started = router.dispatch(&WorkerRequest::new(
        "req-shell-start",
        "trace-shell-process",
        "shell.start",
        json!({
            "command": command,
            "workingDir": ".",
            "yieldTimeMs": 0,
            "tty": false,
            "sessionId": "session-shell-process",
            "runId": "run-shell-process",
            "toolCallId": "tool-shell-process"
        }),
    ));
    let started = started.result.expect("shell.start should return a process");
    assert_eq!(started["running"], true, "{started:?}");
    assert_eq!(started["runId"], "run-shell-process");
    assert_eq!(started["toolCallId"], "tool-shell-process");
    assert_eq!(started["sandboxMode"], "unsandboxed_approved");
    assert_eq!(started["networkMode"], "unrestricted");
    assert_eq!(started["approvalDecision"], "approved");
    let process_id = started["processId"]
        .as_str()
        .expect("shell process id should be present")
        .to_string();

    let wrong_owner = router.dispatch(&WorkerRequest::new(
        "req-shell-poll-wrong-owner",
        "trace-shell-process",
        "shell.poll",
        json!({ "processId": process_id, "cursor": 0, "yieldTimeMs": 0 }),
    ));
    let error = wrong_owner
        .error
        .expect("ownerless poll must not access an owned process");
    assert!(error.message.contains("owner does not match"));

    let listed = router.dispatch(&WorkerRequest::new(
        "req-shell-list",
        "trace-shell-process",
        "shell.list",
        json!({ "runId": "run-shell-process" }),
    ));
    let listed = listed
        .result
        .expect("shell.list should return owned processes");
    assert_eq!(listed.as_array().map(Vec::len), Some(1), "{listed:?}");
    assert_eq!(listed[0]["processId"], process_id);

    let terminated = router.dispatch(&WorkerRequest::new(
        "req-shell-terminate",
        "trace-shell-process",
        "shell.terminate",
        json!({
            "processId": process_id,
            "runId": "run-shell-process"
        }),
    ));
    let terminated = terminated
        .result
        .expect("shell.terminate should return the final process snapshot");
    assert_eq!(terminated["status"], "terminated", "{terminated:?}");
    assert_eq!(terminated["running"], false);
}

#[test]
fn tool_executor_injects_run_ownership_into_exec_command() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = blocking_shell_command_with_marker();
    approve_once(
        &mut router,
        "run-exec-command",
        "session-exec-command",
        json!({
            "toolName": "exec_command",
            "arguments": { "command": command.clone() }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-exec-command",
        "trace-tool-exec-command",
        "tool_executor.execute",
        json!({
            "toolId": "exec_command",
            "arguments": {
                "command": command,
                "workingDir": ".",
                "yieldTimeMs": 0,
                "tty": false,
                "sessionId": "spoofed-session",
                "runId": "spoofed-run",
                "toolCallId": "spoofed-tool-call"
            },
            "sessionId": "session-exec-command",
            "runId": "run-exec-command",
            "toolCallId": "tool-exec-command"
        }),
    ));
    let result = response
        .result
        .expect("exec_command should dispatch through tool executor");
    let process = &result["result"];
    assert_eq!(process["runId"], "run-exec-command", "{result:?}");
    assert_eq!(process["toolCallId"], "tool-exec-command", "{result:?}");
    let process_id = process["processId"]
        .as_str()
        .expect("retained process id should be present")
        .to_string();

    let terminated = router.dispatch(&WorkerRequest::new(
        "req-tool-exec-command-terminate",
        "trace-tool-exec-command",
        "shell.terminate",
        json!({
            "processId": process_id,
            "runId": "run-exec-command"
        }),
    ));
    assert_eq!(terminated.result.as_ref().unwrap()["status"], "terminated");
    assert!(terminated.error.is_none());
}

#[test]
fn shared_shell_runtime_survives_router_reconstruction() {
    let fixture = WorkspaceFixture::new();
    let shell_runtime = WorkerShellRuntime::default();
    let policy = CapabilityPolicy::new([WorkerCapability::ShellExecute]);
    let mut first_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone())
            .with_shell_runtime(shell_runtime.clone());
    let command = blocking_shell_command_with_marker();
    let started = first_router.dispatch(
        &WorkerRequest::new(
            "req-shared-shell-start",
            "trace-shared-shell",
            "shell.start",
            json!({
                "command": command,
                "workingDir": ".",
                "yieldTimeMs": 0,
                "sessionId": "session-shared-shell",
                "runId": "run-shared-shell",
                "toolCallId": "tool-shared-shell"
            }),
        )
        .with_trusted_internal(),
    );
    let process_id = started.result.as_ref().unwrap()["processId"]
        .as_str()
        .expect("shared process id should be present")
        .to_string();
    drop(first_router);

    let mut second_router =
        WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy)
            .with_shell_runtime(shell_runtime);
    let polled = second_router.dispatch(&WorkerRequest::new(
        "req-shared-shell-poll",
        "trace-shared-shell",
        "shell.poll",
        json!({
            "processId": process_id,
            "runId": "run-shared-shell",
            "cursor": 0,
            "yieldTimeMs": 0
        }),
    ));
    assert_eq!(polled.result.as_ref().unwrap()["running"], true);

    let terminated = second_router.dispatch(&WorkerRequest::new(
        "req-shared-shell-terminate",
        "trace-shared-shell",
        "shell.terminate",
        json!({
            "processId": process_id,
            "runId": "run-shared-shell"
        }),
    ));
    assert_eq!(terminated.result.as_ref().unwrap()["status"], "terminated");
    assert!(terminated.error.is_none());
}

#[test]
fn tool_executor_forwards_request_cancellation_to_shell_execute() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::ShellExecute,
        ]),
    );
    let command = blocking_shell_command_with_marker();
    approve_once(
        &mut router,
        "run-shell-cancel",
        "session-1",
        json!({
            "toolName": "exec",
            "arguments": { "command": command.clone() }
        }),
        "shell",
        "high",
        "Shell execution can modify files, run programs, or access the network.",
    );

    let cancellation = Arc::new(TestCancellation::default());
    let request = WorkerRequest::new(
        "req-tool-shell-cancel",
        "trace-tool-shell-cancel",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "arguments": {
                "command": command,
                "working_dir": ".",
                "timeout": 30,
                "sessionId": "session-1",
                "runId": "run-shell-cancel"
            }
        }),
    )
    .with_cancellation(Some(cancellation.clone()));

    let started = std::time::Instant::now();
    let marker = fixture.root.join("started.txt");
    let handle = thread::spawn(move || router.dispatch(&request));
    while !marker.exists() {
        if handle.is_finished() {
            let response = handle
                .join()
                .expect("tool executor dispatch should not panic");
            panic!("tool executor shell command finished before marker: {response:?}");
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "tool executor shell command should create started marker"
        );
        thread::sleep(Duration::from_millis(20));
    }
    cancellation.cancel();

    let response = handle
        .join()
        .expect("tool executor dispatch should not panic");
    let result = response
        .result
        .expect("cancelled tool executor shell command should return result");
    assert!(response.error.is_none());
    assert_eq!(result["result"]["cancelled"], true);
    assert_eq!(result["result"]["timed_out"], false);
    assert!(result["result"]["content"]
        .as_str()
        .unwrap()
        .contains("aborted by user"));
}

#[cfg(target_os = "windows")]
fn blocking_shell_command_with_marker() -> String {
    "echo started > started.txt & for /L %i in (0,0,1) do @rem".to_string()
}

#[cfg(not(target_os = "windows"))]
fn blocking_shell_command_with_marker() -> String {
    "printf started > started.txt; while true; do :; done".to_string()
}

#[derive(Default, Debug)]
struct TestCancellation {
    cancelled: AtomicBool,
}

impl TestCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

impl WorkerRequestCancellation for TestCancellation {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

fn session_fixture() -> crate::worker_session::SessionMetadata {
    crate::worker_session::SessionMetadata {
        session_id: "session-1".to_string(),
        title: "Native Core Migration".to_string(),
        workspace_dir: "D:/code/tinybot/tinybot".to_string(),
        created_at: "2026-06-09T09:00:00Z".to_string(),
        updated_at: "2026-06-09T09:30:00Z".to_string(),
        extra: json!({ "mode": "desktop" }),
    }
}

fn first_thread_log_file(root: &Path) -> PathBuf {
    first_thread_log_file_under(root, "threads").expect("thread log file should exist")
}

fn first_archived_thread_log_file(root: &Path) -> PathBuf {
    first_thread_log_file_under(root, "archived_threads")
        .expect("archived thread log file should exist")
}

fn first_thread_log_file_under(root: &Path, directory: &str) -> Option<PathBuf> {
    fn visit(dir: &Path) -> Option<PathBuf> {
        for entry in std::fs::read_dir(dir).ok()? {
            let path = entry.ok()?.path();
            if path.is_dir() {
                if let Some(found) = visit(&path) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("thread-")
                        && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
                })
            {
                return Some(path);
            }
        }
        None
    }
    visit(&root.join(".tinybot").join(directory))
}

fn prepare_session_log_index_for_startup(root: &Path) {
    let rpc = crate::worker_thread_log::WorkerThreadLogRpc::new(
        root.to_path_buf(),
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let migration = rpc
        .prepare_state_index_for_startup()
        .expect("startup index preparation should succeed");
    assert!(migration.is_some(), "missing index should be migrated");
}

fn repair_session_log_index(root: &Path) {
    let rpc = crate::worker_thread_log::WorkerThreadLogRpc::new(
        root.to_path_buf(),
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let repair = rpc
        .repair_state_index(crate::worker_thread_log::ThreadLogIndexRepairMode::RebuildIndex)
        .expect("explicit index repair should succeed");
    assert_eq!(
        repair.after.status,
        crate::worker_thread_log::ThreadLogIndexConsistencyStatus::Clean
    );
}

fn thread_state_updated_at(state_path: &Path, session_id: &str) -> String {
    let connection = rusqlite::Connection::open(state_path).expect("state db should open");
    connection
        .query_row(
            "SELECT updated_at FROM threads WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .expect("thread state row should exist")
}

struct WorkspaceFixture {
    root: PathBuf,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let counter = WORKSPACE_FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-rpc-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos(),
            counter
        ));
        std::fs::create_dir_all(&root).expect("workspace fixture should create");
        Self { root }
    }

    fn write(&self, relative_path: &str, contents: &str) {
        let path = self
            .root
            .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent should create");
        }
        std::fs::write(path, contents).expect("fixture file should write");
    }

    fn read(&self, relative_path: &str) -> String {
        let path = self
            .root
            .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::read_to_string(path).expect("fixture file should read")
    }
}

impl Drop for WorkspaceFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
