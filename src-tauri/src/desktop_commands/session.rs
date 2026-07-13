use crate::worker_capability::{
    default_desktop_capability_policy, CapabilityPolicy, WorkerCapability,
};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use crate::{
    call_rust_state_service, experimental_worker_config_snapshot, native_backend_workspace_root,
    SharedGateway,
};
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
pub(crate) struct WorkerAgentRunInput {
    session_key: String,
    run_id: String,
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
pub(crate) struct WorkerSessionTemporaryFileUploadInput {
    key: String,
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
        experimental_worker_config_snapshot(),
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
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_agent_runs_list(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_agent_runs_list_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_agent_run_runtime_state(
    input: WorkerAgentRunInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_agent_run_runtime_state_with_options(
        state.inner(),
        input.session_key,
        input.run_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_effective_capabilities(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_effective_capabilities_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_temporary_files(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_temporary_files_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_upload_temporary_file(
    input: WorkerSessionTemporaryFileUploadInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_upload_temporary_file_with_options(
        state.inner(),
        input.key,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_session_clear_temporary_files(
    input: WorkerSessionInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_session_clear_temporary_files_with_options(
        state.inner(),
        input.key,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
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
        experimental_worker_config_snapshot(),
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
        experimental_worker_config_snapshot(),
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
        experimental_worker_config_snapshot(),
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
        experimental_worker_config_snapshot(),
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
        experimental_worker_config_snapshot(),
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
    let sessions = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("sessions-list"),
            request_id.trace_id("sessions-list"),
            "session.list_metadata",
            serde_json::json!({}),
        ),
        "worker sessions list",
    )?;
    let items = sessions
        .as_array()
        .ok_or_else(|| "worker sessions list failed: response was not an array".to_string())?
        .iter()
        .map(webui_session_item)
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
    let request_id = next_worker_request_correlation();
    let mut history = call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("session-messages"),
            request_id.trace_id("session-messages"),
            "session.get_history",
            serde_json::json!({ "session_id": key, "limit": 500 }),
        ),
        "worker session messages",
    )?;
    let object = history
        .as_object_mut()
        .ok_or_else(|| "worker session messages failed: response was not an object".to_string())?;
    let session_id = object
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    object.insert(
        "key".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    object.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&session_id)),
    );
    enrich_session_history_metadata(object, &session_id, workspace_root, config_snapshot);
    Ok(history)
}

pub(crate) fn worker_agent_runs_list_with_options(
    _shared: &SharedGateway,
    session_key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("agent-run-list"),
            request_id.trace_id("agent-run-list"),
            "agent_run.list",
            serde_json::json!({ "session_id": session_key }),
        ),
        "worker agent run list",
    )
}

pub(crate) fn worker_agent_run_runtime_state_with_options(
    _shared: &SharedGateway,
    session_key: String,
    run_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("agent-run-runtime-state"),
            request_id.trace_id("agent-run-runtime-state"),
            "agent_run.runtime_state",
            serde_json::json!({
                "session_id": session_key,
                "run_id": run_id,
            }),
        ),
        "worker agent run runtime state",
    )
}

pub(crate) fn worker_session_effective_capabilities_with_options(
    shared: &SharedGateway,
    session_key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let workspace_available = workspace_root.is_dir();
    let runs = worker_agent_runs_list_with_options(
        shared,
        session_key.clone(),
        workspace_root,
        config_snapshot,
        timeout,
    )?;
    Ok(build_worker_session_effective_capabilities(
        &session_key,
        &runs,
        workspace_available,
        &default_desktop_capability_policy(),
    ))
}

pub(crate) fn build_worker_session_effective_capabilities(
    session_key: &str,
    runs: &serde_json::Value,
    workspace_available: bool,
    policy: &CapabilityPolicy,
) -> serde_json::Value {
    let evaluated_run = runs
        .get("runs")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|run| {
                    matches!(
                        run.get("status").and_then(serde_json::Value::as_str),
                        Some("running" | "waiting")
                    )
                })
                .or_else(|| items.first())
        });
    let evaluated_run_id = evaluated_run
        .and_then(|run| run.get("runId"))
        .and_then(serde_json::Value::as_str);
    let evaluated_run_status = evaluated_run
        .and_then(|run| run.get("status"))
        .and_then(serde_json::Value::as_str);
    let evaluated_run_phase = evaluated_run
        .and_then(|run| run.get("phase"))
        .and_then(serde_json::Value::as_str);
    let cancel = match (evaluated_run_status, evaluated_run_phase) {
        (Some("running"), _) | (Some("waiting"), Some("paused")) => available_capability(),
        (Some("waiting"), _) => unavailable_capability(
            "run_waiting",
            "Cancellation of a run waiting for user input is not supported yet.",
        ),
        _ => unavailable_capability("no_active_run", "The session has no active Agent run."),
    };
    let pause = if evaluated_run_status == Some("running") {
        available_capability()
    } else {
        unavailable_capability("run_not_running", "Only a running Agent run can be paused.")
    };
    let resume = if evaluated_run_status == Some("waiting") && evaluated_run_phase == Some("paused")
    {
        available_capability()
    } else {
        unavailable_capability("run_not_paused", "The Agent run is not paused.")
    };
    let retry = match evaluated_run_status {
        Some("failed") => available_capability(),
        Some("running" | "waiting") => unavailable_capability(
            "run_active",
            "Retry is unavailable while an Agent run is active.",
        ),
        _ => unavailable_capability(
            "no_failed_run",
            "The session has no latest failed Agent run to retry.",
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
    let request_change = if matches!(evaluated_run_status, Some("running" | "waiting")) {
        unavailable_capability(
            "run_active",
            "Agent requests are unavailable while a run is active.",
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

    serde_json::json!({
        "schemaVersion": "tinybot.effective_capabilities.v1",
        "sessionId": session_key,
        "evaluatedRunId": evaluated_run_id,
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
                "directEdit": unavailable_capability("phase_unavailable", "Direct file editing is introduced in Phase 3."),
                "save": unavailable_capability("phase_unavailable", "File saving is introduced in Phase 3."),
            },
            "terminal": {
                "inspect": available_capability(),
                "execute": unavailable_capability("phase_unavailable", "Terminal execution is introduced in Phase 3."),
                "cancel": unavailable_capability("phase_unavailable", "Terminal process cancellation is introduced in Phase 3."),
            },
            "browser": {
                "structured": available_capability(),
                "realCapture": unavailable_capability("phase_unavailable", "Real browser capture is introduced in Phase 3."),
                "interact": unavailable_capability("phase_unavailable", "Browser interaction is introduced in Phase 3."),
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

pub(crate) fn worker_session_temporary_files_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-temporary-files"),
            request_id.trace_id("session-temporary-files"),
            "knowledge.session_list",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session temporary files",
    )?;
    add_session_key_fields(&mut result)?;
    Ok(result)
}

pub(crate) fn worker_session_upload_temporary_file_with_options(
    _shared: &SharedGateway,
    key: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-upload-temporary-file"),
            request_id.trace_id("session-upload-temporary-file"),
            "session.temporary_file.upload",
            serde_json::json!({
                "session_id": key,
                "name": body.get("name").and_then(serde_json::Value::as_str).unwrap_or_default(),
                "file_type": body.get("file_type")
                    .or_else(|| body.get("fileType"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
                "content": body.get("content").and_then(serde_json::Value::as_str).unwrap_or_default(),
                "size_bytes": body.get("size_bytes")
                    .or_else(|| body.get("sizeBytes"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default(),
            }),
        ),
        "worker session temporary file upload",
    )
}

pub(crate) fn worker_session_clear_temporary_files_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-clear-temporary-files"),
            request_id.trace_id("session-clear-temporary-files"),
            "knowledge.session_clear",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session temporary files clear",
    )?;
    add_session_key_fields(&mut result)?;
    Ok(result)
}

pub(crate) fn worker_session_delete_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-delete"),
            request_id.trace_id("session-delete"),
            "session.delete",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session delete",
    )?;
    add_session_key_fields(&mut result)?;
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
    let request_id = next_worker_request_correlation();
    let session = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-patch"),
            request_id.trace_id("session-patch"),
            "session.patch_metadata",
            serde_json::json!({ "session_id": key, "metadata": metadata }),
        ),
        "worker session patch",
    )?;
    webui_session_item(&session)
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
    let messages = branch_messages(&body);
    if messages.is_empty() {
        return Err("worker session branch failed: branch messages are required".to_string());
    }
    let title = branch_string(&body, "title").unwrap_or_else(|| "Branched session".to_string());
    let source_session = branch_string(&body, "branchedFromSessionId")
        .or_else(|| branch_string(&body, "branched_from_session_id"))
        .unwrap_or_default();
    let source_message = branch_string(&body, "branchedFromMessageId")
        .or_else(|| branch_string(&body, "branched_from_message_id"))
        .unwrap_or_default();
    let portable_context = body
        .get("portableContext")
        .or_else(|| body.get("portable_context"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    call_rust_state_service(
        workspace_root.clone(),
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("session-branch-append"),
            request_id.trace_id("session-branch-append"),
            "session.append_messages",
            serde_json::json!({
                "session_id": branch_key.clone(),
                "messages": messages,
            }),
        ),
        "worker session branch append",
    )?;
    let session = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-branch-metadata"),
            request_id.trace_id("session-branch-metadata"),
            "session.patch_metadata",
            serde_json::json!({
                "session_id": branch_key,
                "metadata": {
                    "title": title,
                    "branch": {
                        "branchedFromSessionId": source_session,
                        "branchedFromMessageId": source_message,
                        "portableContext": portable_context,
                    },
                },
            }),
        ),
        "worker session branch metadata",
    )?;
    webui_session_item(&session)
}

pub(crate) fn worker_session_clear_with_options(
    _shared: &SharedGateway,
    key: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-clear"),
            request_id.trace_id("session-clear"),
            "session.clear",
            serde_json::json!({ "session_id": key }),
        ),
        "worker session clear",
    )?;
    add_session_key_fields(&mut result)?;
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
    let request_id = next_worker_request_correlation();
    let session = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-task-progress"),
            request_id.trace_id("session-task-progress"),
            "session.task_progress.upsert",
            serde_json::json!({
                "session_id": key,
                "plan_id": plan_id,
                "progress": progress,
                "content": content,
            }),
        ),
        "worker session task progress",
    )?;
    webui_session_item(&session)
}

fn webui_session_item(session: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut item = session
        .as_object()
        .cloned()
        .ok_or_else(|| "worker sessions list failed: session item was not an object".to_string())?;
    let session_id = item
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    item.insert(
        "key".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    item.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&session_id)),
    );
    if let Some(metadata) = item
        .get("extra")
        .and_then(|extra| extra.get("metadata"))
        .cloned()
    {
        if let Some(title) = metadata.get("title").and_then(serde_json::Value::as_str) {
            item.insert(
                "title".to_string(),
                serde_json::Value::String(title.to_string()),
            );
        }
        item.insert("metadata".to_string(), metadata);
    }
    Ok(serde_json::Value::Object(item))
}

fn enrich_session_history_metadata(
    object: &mut serde_json::Map<String, serde_json::Value>,
    session_id: &str,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) {
    let request_id = next_worker_request_correlation();
    let Ok(metadata) = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("session-history-metadata"),
            request_id.trace_id("session-history-metadata"),
            "session.get_metadata",
            serde_json::json!({ "session_id": session_id }),
        ),
        "worker session history metadata",
    ) else {
        return;
    };
    if let Some(branch) = metadata
        .get("extra")
        .and_then(|extra| extra.get("metadata"))
        .and_then(|metadata| metadata.get("branch"))
        .cloned()
    {
        object.insert("branch".to_string(), branch);
    }
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

fn add_session_key_fields(value: &mut serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "worker session operation failed: response was not an object".to_string())?;
    let session_id = object
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    object.insert(
        "key".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    object.insert(
        "chat_id".to_string(),
        serde_json::Value::String(session_chat_id_from_key(&session_id)),
    );
    Ok(())
}

fn session_chat_id_from_key(key: &str) -> String {
    key.split_once(':')
        .map(|(_, chat_id)| chat_id)
        .unwrap_or(key)
        .to_string()
}
