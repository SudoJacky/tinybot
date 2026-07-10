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
pub(crate) struct WorkerWorkspaceFileInput {
    path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerWorkspacePutFileInput {
    path: String,
    body: serde_json::Value,
}

#[tauri::command]
pub(crate) fn worker_workspace_files(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_workspace_files_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_file(
    input: WorkerWorkspaceFileInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_workspace_file_with_options(
        state.inner(),
        input.path,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_put_file(
    input: WorkerWorkspacePutFileInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_workspace_put_file_with_options(
        state.inner(),
        input.path,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

pub(crate) fn worker_workspace_files_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let items = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-files"),
            request_id.trace_id("workspace-files"),
            "workspace.list_files",
            serde_json::json!({}),
        ),
        "worker workspace files",
    )?;
    Ok(serde_json::json!({ "items": items }))
}

pub(crate) fn worker_workspace_file_with_options(
    _shared: &SharedGateway,
    path: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-file"),
            request_id.trace_id("workspace-file"),
            "workspace.read_file",
            serde_json::json!({ "path": path, "format": "raw" }),
        ),
        "worker workspace file",
    )
}

pub(crate) fn worker_workspace_put_file_with_options(
    _shared: &SharedGateway,
    path: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let contents = body
        .get("content")
        .or_else(|| body.get("contents"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "worker workspace put file failed: content is required".to_string())?;
    let expected_updated_at = body
        .get("expectedUpdatedAt")
        .or_else(|| body.get("expected_updated_at"))
        .and_then(|value| value.as_str());
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-put-file"),
            request_id.trace_id("workspace-put-file"),
            "workspace.write_file",
            serde_json::json!({
                "path": path,
                "contents": contents,
                "expected_updated_at": expected_updated_at,
            }),
        )
        .with_trusted_internal(),
        "worker workspace put file",
    )
}
