use crate::config::application::{native_backend_workspace_root, native_config_snapshot};
use crate::desktop::SharedGateway;
use crate::native_browser::SharedBrowserRuntime;
use crate::protocol::capability::{
    default_desktop_capability_policy, CapabilityPolicy, WorkerCapability,
};
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSessionInput {
    key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerAgentTurnInput {
    session_key: String,
    turn_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSessionPatchInput {
    key: String,
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSessionBranchInput {
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSessionTaskProgressInput {
    key: String,
    body: serde_json::Value,
}

#[tauri::command]
pub(crate) fn worker_sessions_list(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_sessions_list_with_options(
        state.inner(),
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_messages(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_messages_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_turns_list(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_turns_list_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_turn_runtime_state(
    input: WorkerAgentTurnInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_turn_runtime_state_with_options(
        state.inner(),
        input.session_key,
        input.turn_id,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_effective_capabilities(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
    browser_runtime: State<'_, SharedBrowserRuntime>,
) -> Result<serde_json::Value, String> {
    let mut capabilities = worker_session_effective_capabilities_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )?;
    let browser = browser_runtime.capabilities();
    if let Some(target) = capabilities
        .pointer_mut("/capabilities/browser")
        .and_then(serde_json::Value::as_object_mut)
    {
        target.insert(
            "sessionSnapshot".to_string(),
            serde_json::Value::Bool(browser.session_snapshot.available),
        );
        target.insert(
            "realCapture".to_string(),
            serde_json::to_value(&browser.real_capture).map_err(|error| error.to_string())?,
        );
        target.insert(
            "interact".to_string(),
            serde_json::to_value(&browser.agent_interaction).map_err(|error| error.to_string())?,
        );
        target.insert(
            "runtime".to_string(),
            serde_json::to_value(browser).map_err(|error| error.to_string())?,
        );
    }
    Ok(capabilities)
}

#[tauri::command]
pub(crate) fn worker_session_delete(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_delete_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_patch(
    input: WorkerSessionPatchInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_patch_with_options(
        state.inner(),
        input.key,
        input.body,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_branch(
    input: WorkerSessionBranchInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_branch_with_options(
        state.inner(),
        input.body,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_clear(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_clear_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_task_progress(
    input: WorkerSessionTaskProgressInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_task_progress_with_options(
        state.inner(),
        input.key,
        input.body,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

pub(crate) fn worker_sessions_list_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("threads-list"),
            request_id.trace_id("threads-list"),
            "thread.list",
            serde_json::json!({
                "includeArchived": false,
                "includeChildThreads": true,
            }),
        ),
        "worker threads list",
    )?;
    let items = result
        .get("threads")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "worker threads list failed: response did not contain threads".to_string())?
        .iter()
        .map(webui_thread_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(serde_json::json!({ "items": items }))
}

pub(crate) fn worker_session_messages_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_id = resolve_thread_id(&key, workspace_root.clone(), config_snapshot.clone())?;
    let request_id = next_worker_request_correlation();
    let mut history = call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("thread-messages"),
            request_id.trace_id("thread-messages"),
            "thread.history",
            serde_json::json!({ "threadId": thread_id, "limit": 500 }),
        ),
        "worker thread messages",
    )?;
    let object = history
        .as_object_mut()
        .ok_or_else(|| "worker session messages failed: response was not an object".to_string())?;
    let canonical_thread_id = object
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    object.insert(
        "session_id".to_string(),
        serde_json::Value::String(key.clone()),
    );
    object.insert("key".to_string(), serde_json::Value::String(key.clone()));
    object.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&key)),
    );
    if let Some(user_profile) = object.get("userProfile").cloned() {
        object.insert("user_profile".to_string(), user_profile);
    }
    if let Some(updated_at) = object.get("updatedAt").cloned() {
        object.insert("updated_at".to_string(), updated_at);
    }
    enrich_thread_history_metadata(
        object,
        &canonical_thread_id,
        workspace_root,
        config_snapshot,
    )?;
    Ok(history)
}

pub(crate) fn worker_turns_list_with_options(
    _shared: &SharedGateway,
    session_key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_id = resolve_thread_id(
        &session_key,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("agent-turn-list"),
            request_id.trace_id("agent-turn-list"),
            "thread.turn.list",
            serde_json::json!({ "threadId": thread_id }),
        ),
        "worker agent turn list",
    )
}

pub(crate) fn worker_turn_runtime_state_with_options(
    _shared: &SharedGateway,
    session_key: String,
    turn_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_id = resolve_thread_id(
        &session_key,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let request_id = next_worker_request_correlation();
    let mut runtime_state = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("agent-turn-runtime-state"),
            request_id.trace_id("agent-turn-runtime-state"),
            "thread.turn.runtime_state",
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        ),
        "worker agent turn runtime state",
    )?;
    if let Some(timeline) = runtime_state
        .get_mut("timeline")
        .and_then(serde_json::Value::as_object_mut)
    {
        timeline.insert(
            "sessionId".to_string(),
            serde_json::Value::String(session_key),
        );
    }
    Ok(runtime_state)
}

pub(crate) fn worker_session_effective_capabilities_with_options(
    shared: &SharedGateway,
    session_key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let workspace_available = workspace_root.is_dir();
    let turns = worker_turns_list_with_options(
        shared,
        session_key.clone(),
        workspace_root,
        config_snapshot,
        timeout,
    )?;
    Ok(build_worker_session_effective_capabilities(
        &session_key,
        &turns,
        workspace_available,
        &default_desktop_capability_policy(),
    ))
}

pub(crate) fn build_worker_session_effective_capabilities(
    session_key: &str,
    turns: &serde_json::Value,
    workspace_available: bool,
    policy: &CapabilityPolicy,
) -> serde_json::Value {
    let evaluated_turn = turns
        .get("turns")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|turn| {
                    matches!(
                        turn.get("status").and_then(serde_json::Value::as_str),
                        Some("running" | "waiting")
                    )
                })
                .or_else(|| items.first())
        });
    let evaluated_turn_id = evaluated_turn
        .and_then(|turn| turn.get("turnId"))
        .and_then(serde_json::Value::as_str);
    let evaluated_turn_status = evaluated_turn
        .and_then(|turn| turn.get("status"))
        .and_then(serde_json::Value::as_str);
    let evaluated_turn_phase = evaluated_turn
        .and_then(|turn| turn.get("phase"))
        .and_then(serde_json::Value::as_str);
    let cancel = match (evaluated_turn_status, evaluated_turn_phase) {
        (Some("running"), _) | (Some("waiting"), Some("paused")) => available_capability(),
        (Some("waiting"), _) => unavailable_capability(
            "turn_waiting",
            "Cancellation of a turn waiting for user input is not supported yet.",
        ),
        _ => unavailable_capability("no_active_turn", "The session has no active Agent turn."),
    };
    let pause = if evaluated_turn_status == Some("running") {
        available_capability()
    } else {
        unavailable_capability(
            "turn_not_running",
            "Only a running Agent turn can be paused.",
        )
    };
    let resume =
        if evaluated_turn_status == Some("waiting") && evaluated_turn_phase == Some("paused") {
            available_capability()
        } else {
            unavailable_capability("turn_not_paused", "The Agent turn is not paused.")
        };
    let retry = match evaluated_turn_status {
        Some("failed") => available_capability(),
        Some("running" | "waiting") => unavailable_capability(
            "turn_active",
            "Retry is unavailable while an Agent turn is active.",
        ),
        _ => unavailable_capability(
            "no_failed_turn",
            "The session has no latest failed Agent turn to retry.",
        ),
    };
    let files_read = if policy.allows(&WorkerCapability::FsWorkspaceRead) && workspace_available {
        available_capability()
    } else if !workspace_available {
        unavailable_capability(
            "workspace_unavailable",
            "The configured workspace root is unavailable.",
        )
    } else {
        unavailable_capability(
            "permission_denied",
            "Workspace read permission is not granted.",
        )
    };
    let request_change = if matches!(evaluated_turn_status, Some("running" | "waiting")) {
        unavailable_capability(
            "turn_active",
            "Agent requests are unavailable while a turn is active.",
        )
    } else if policy.allows(&WorkerCapability::FsWorkspaceRead) && workspace_available {
        available_capability()
    } else if !workspace_available {
        unavailable_capability(
            "workspace_unavailable",
            "The configured workspace root is unavailable.",
        )
    } else {
        unavailable_capability(
            "permission_denied",
            "Workspace read permission is not granted.",
        )
    };
    let turn_active = matches!(evaluated_turn_status, Some("running" | "waiting"));
    let workspace_write = if turn_active {
        unavailable_capability(
            "turn_active",
            "Direct file operations are unavailable while another turn is active.",
        )
    } else if policy.allows(&WorkerCapability::FsWorkspaceWrite) && workspace_available {
        available_capability()
    } else if !workspace_available {
        unavailable_capability(
            "workspace_unavailable",
            "The configured workspace root is unavailable.",
        )
    } else {
        unavailable_capability(
            "permission_denied",
            "Workspace write permission is not granted.",
        )
    };
    let terminal_execute = if turn_active {
        unavailable_capability(
            "turn_active",
            "Terminal execution is unavailable while another turn is active.",
        )
    } else if !workspace_available {
        unavailable_capability(
            "workspace_unavailable",
            "The configured workspace root is unavailable.",
        )
    } else if !policy.allows(&WorkerCapability::ShellExecute) {
        unavailable_capability(
            "permission_denied",
            "Shell execution permission is not granted.",
        )
    } else {
        unavailable_capability(
            "network_enforcement_unavailable",
            "Terminal execution requires denied-network enforcement, which is unavailable in the current native shell backend.",
        )
    };
    let terminal_cancel = unavailable_capability(
        "no_active_terminal",
        "There is no running TinyOS terminal process to cancel.",
    );

    serde_json::json!({
        "schemaVersion": "tinybot.effective_capabilities.v1",
        "sessionId": session_key,
        "evaluatedTurnId": evaluated_turn_id,
        "capabilities": {
            "agent": {
                "pause": pause,
                "resume": resume,
                "cancel": cancel,
                "retry": retry,
            },
            "files": {
                "read": files_read,
                "requestChange": request_change,
                "directEdit": workspace_write.clone(),
                "save": workspace_write,
            },
            "terminal": {
                "contract": "retained_execution_v1",
                "persistentPty": false,
                "inspect": available_capability(),
                "execute": terminal_execute,
                "cancel": terminal_cancel,
            },
            "browser": {
                "interactionRequires": "current_real_capture",
                "structured": available_capability(),
                "projectionContract": "structured_projection_v1",
                "realCapture": unavailable_capability("backend_unavailable", "No real browser capture backend is configured."),
                "sessionContract": "browser_session_v1",
                "sessionSnapshot": false,
                "interact": unavailable_capability("backend_unavailable", "No real browser interaction backend is configured."),
            },
        },
    })
}

fn available_capability() -> serde_json::Value {
    serde_json::json!({ "available": true })
}

fn unavailable_capability(reason_code: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({
        "available": false,
        "reasonCode": reason_code,
        "reason": reason,
    })
}

pub(crate) fn worker_session_delete_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_id = resolve_thread_id(&key, workspace_root.clone(), config_snapshot.clone())?;
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-delete"),
            request_id.trace_id("thread-delete"),
            "thread.delete",
            serde_json::json!({ "threadId": thread_id, "deleteChildren": false }),
        ),
        "worker thread delete",
    )?;
    add_session_key_fields(&mut result, &key)?;
    result["deleted"] = serde_json::Value::Bool(true);
    Ok(result)
}

pub(crate) fn worker_session_patch_with_options(
    _shared: &SharedGateway,
    key: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let metadata = body
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| body.clone());
    let metadata_patch = thread_metadata_patch(&metadata)?;
    let thread_id = resolve_thread_id(&key, workspace_root.clone(), config_snapshot.clone())?;
    let request_id = next_worker_request_correlation();
    let thread = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-patch"),
            request_id.trace_id("thread-patch"),
            "thread.update_metadata",
            serde_json::json!({ "threadId": thread_id, "metadata": metadata_patch }),
        ),
        "worker thread patch",
    )?;
    let mut item = webui_thread_item(&thread)?;
    item["metadata"] = metadata;
    Ok(item)
}

pub(crate) fn worker_session_branch_with_options(
    _shared: &SharedGateway,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let branch_key = branch_session_key(&body, request_id.suffix());
    let branch_turn_id = branch_string(&body, "turnId")
        .or_else(|| branch_string(&body, "turn_id"))
        .unwrap_or_else(|| format!("turn-branch-{}", request_id.suffix()));
    let messages = branch_messages(&body);
    if messages.is_empty() {
        return Err("worker session branch failed: branch messages are required".to_string());
    }
    let title = branch_string(&body, "title").unwrap_or_else(|| "Branched session".to_string());
    let source_session = branch_string(&body, "branchedFromSessionId")
        .or_else(|| branch_string(&body, "branched_from_session_id"))
        .unwrap_or_default();
    let source_thread_id = resolve_thread_id(
        &source_session,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let source_message = branch_string(&body, "branchedFromMessageId")
        .or_else(|| branch_string(&body, "branched_from_message_id"))
        .unwrap_or_default();
    let portable_context = body
        .get("portableContext")
        .or_else(|| body.get("portable_context"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let created = call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("thread-branch-create"),
            request_id.trace_id("thread-branch-create"),
            "thread.create",
            serde_json::json!({
                "title": title,
                "sessionKey": branch_key.clone(),
                "rootTurnId": branch_turn_id,
                "source": "desktop",
                "metadata": {
                    "extra": {
                        "branch": {
                            "branchedFromThreadId": source_thread_id,
                            "branchedFromSessionId": source_session,
                            "branchedFromMessageId": source_message,
                            "portableContext": portable_context,
                        },
                    },
                },
            }),
        ),
        "worker thread branch create",
    )?;
    let thread_id = created
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "worker thread branch create failed: missing threadId".to_string())?
        .to_string();
    let thread = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-branch-append"),
            request_id.trace_id("thread-branch-append"),
            "thread.append_messages",
            serde_json::json!({
                "threadId": thread_id,
                "turnId": branch_turn_id,
                "messages": messages,
            }),
        ),
        "worker thread branch append",
    )?;
    webui_thread_item(&thread)
}

pub(crate) fn worker_session_clear_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_id = resolve_thread_id(&key, workspace_root.clone(), config_snapshot.clone())?;
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-clear"),
            request_id.trace_id("thread-clear"),
            "thread.clear",
            serde_json::json!({ "threadId": thread_id }),
        ),
        "worker thread clear",
    )?;
    add_session_key_fields(&mut result, &key)?;
    for (camel, snake) in [
        ("messagesBefore", "messages_before"),
        ("messagesAfter", "messages_after"),
        ("checkpointCleared", "checkpoint_cleared"),
    ] {
        if let Some(value) = result.get(camel).cloned() {
            result[snake] = value;
        }
    }
    Ok(result)
}

pub(crate) fn worker_session_task_progress_with_options(
    _shared: &SharedGateway,
    key: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let turn_id = body
        .get("turnId")
        .or_else(|| body.get("turn_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|turn_id| !turn_id.trim().is_empty())
        .ok_or_else(|| "worker session task progress requires turnId".to_string())?;
    let plan_id = body
        .get("planId")
        .or_else(|| body.get("plan_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let progress = body
        .get("progress")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let content = body
        .get("content")
        .or_else(|| body.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Task progress updated.");
    let thread_id = resolve_thread_id(&key, workspace_root.clone(), config_snapshot.clone())?;
    let request_id = next_worker_request_correlation();
    let thread = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-task-progress"),
            request_id.trace_id("thread-task-progress"),
            "thread.task_progress.upsert",
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "planId": plan_id,
                "progress": progress.clone(),
                "content": content,
            }),
        ),
        "worker thread task progress",
    )?;
    let mut item = webui_thread_item(&thread)?;
    let extra = item
        .get_mut("extra")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "worker thread task progress failed: missing extra object".to_string())?;
    extra.insert(
        "messages".to_string(),
        serde_json::json!([{
            "role": "progress",
            "content": content,
            "turnId": turn_id,
            "_progress": true,
            "_task_plan_id": plan_id,
            "_task_progress": progress,
        }]),
    );
    Ok(item)
}

fn webui_thread_item(thread: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut item = thread
        .as_object()
        .cloned()
        .ok_or_else(|| "worker threads list failed: thread item was not an object".to_string())?;
    let thread_id = item
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let session_key = item
        .get("sessionKey")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&thread_id)
        .to_string();
    item.insert(
        "session_id".to_string(),
        serde_json::Value::String(session_key.clone()),
    );
    item.insert(
        "key".to_string(),
        serde_json::Value::String(session_key.clone()),
    );
    item.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&session_key)),
    );
    if let Some(created_at) = item.get("createdAt").cloned() {
        item.insert("created_at".to_string(), created_at);
    }
    if let Some(updated_at) = item.get("updatedAt").cloned() {
        item.insert("updated_at".to_string(), updated_at);
    }
    if let Some(metadata) = item.get("metadata").cloned() {
        item.insert(
            "extra".to_string(),
            serde_json::json!({
                "threadId": thread_id,
                "metadata": metadata.get("extra").cloned().unwrap_or_else(|| serde_json::json!({})),
            }),
        );
    }
    Ok(serde_json::Value::Object(item))
}

fn enrich_thread_history_metadata(
    object: &mut serde_json::Map<String, serde_json::Value>,
    thread_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let request_id = next_worker_request_correlation();
    let snapshot = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-history-metadata"),
            request_id.trace_id("thread-history-metadata"),
            "thread.read",
            serde_json::json!({ "threadId": thread_id, "limit": 1 }),
        ),
        "worker thread history metadata",
    )?;
    if let Some(branch) = snapshot
        .get("thread")
        .and_then(|thread| thread.get("metadata"))
        .and_then(|metadata| metadata.get("extra"))
        .and_then(|extra| extra.get("branch"))
        .cloned()
    {
        object.insert("branch".to_string(), branch);
    }
    Ok(())
}

fn thread_metadata_patch(metadata: &serde_json::Value) -> Result<serde_json::Value, String> {
    let source = metadata
        .as_object()
        .ok_or_else(|| "worker thread metadata patch must be an object".to_string())?;
    let mut patch = serde_json::Map::new();
    for key in [
        "title",
        "summary",
        "preview",
        "tags",
        "model",
        "workingDirectory",
        "lastUserMessageAt",
        "lastAssistantMessageAt",
        "lastActivityAt",
        "hasActiveTurn",
    ] {
        if let Some(value) = source.get(key) {
            patch.insert(key.to_string(), value.clone());
        }
    }
    patch.insert("extra".to_string(), metadata.clone());
    Ok(serde_json::Value::Object(patch))
}

fn branch_session_key(body: &serde_json::Value, fallback_suffix: &str) -> String {
    branch_string(body, "sessionKey")
        .or_else(|| branch_string(body, "session_key"))
        .unwrap_or_else(|| format!("websocket:branch-{fallback_suffix}"))
}

fn branch_messages(body: &serde_json::Value) -> Vec<serde_json::Value> {
    body.get("messages")
        .and_then(serde_json::Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .map(|message| {
                    serde_json::json!({
                        "message_id": branch_string(message, "messageId")
                            .or_else(|| branch_string(message, "message_id"))
                            .unwrap_or_default(),
                        "role": branch_string(message, "role").unwrap_or_else(|| "assistant".to_string()),
                        "content": branch_string(message, "content").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn branch_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn resolve_thread_id(
    session_key: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<String, String> {
    let request_id = next_worker_request_correlation();
    let result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-resolve-session-key"),
            request_id.trace_id("thread-resolve-session-key"),
            "thread.resolve",
            serde_json::json!({ "identity": session_key }),
        ),
        "worker thread resolve session key",
    )?;
    result
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            "worker thread resolve failed: response did not contain threadId".to_string()
        })
}

fn add_session_key_fields(value: &mut serde_json::Value, session_key: &str) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "worker session operation failed: response was not an object".to_string())?;
    object.insert(
        "session_id".to_string(),
        serde_json::Value::String(session_key.to_string()),
    );
    object.insert(
        "key".to_string(),
        serde_json::Value::String(session_key.to_string()),
    );
    object.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(session_key)),
    );
    Ok(())
}

fn session_chat_id_from_key(key: &str) -> String {
    key.split_once(':')
        .map(|(_, chat_id)| chat_id)
        .unwrap_or(key)
        .to_string()
}
