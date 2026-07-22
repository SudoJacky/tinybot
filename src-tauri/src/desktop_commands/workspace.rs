use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::{
    call_rust_state_service, experimental_worker_config_snapshot, experimental_worker_router,
    native_backend_workspace_root, SharedGateway,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerWorkspaceDirectoryInput {
    path: String,
    cursor: Option<String>,
    name_query: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerWorkspaceFileChunkInput {
    path: String,
    cursor: Option<String>,
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

#[tauri::command]
pub(crate) fn worker_workspace_directory(
    input: WorkerWorkspaceDirectoryInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_workspace_directory_with_options(
        state.inner(),
        input.path,
        input.cursor,
        input.name_query,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_file_chunk(
    input: WorkerWorkspaceFileChunkInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_workspace_file_chunk_with_options(
        state.inner(),
        input.path,
        input.cursor,
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

pub(crate) fn worker_workspace_directory_with_options(
    _shared: &SharedGateway,
    path: String,
    cursor: Option<String>,
    name_query: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let workspace_key = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.clone())
        .to_string_lossy()
        .to_string();
    let mut response =
        experimental_worker_router(workspace_root, config_snapshot).dispatch(&WorkerRequest::new(
            request_id.id("workspace-directory"),
            request_id.trace_id("workspace-directory"),
            "workspace.list_dir_page",
            serde_json::json!({
                "path": path,
                "cursor": cursor,
                "name_query": name_query,
            }),
        ));
    if let Some(result) = response
        .result
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    {
        result.insert(
            "workspace_key".to_string(),
            serde_json::Value::String(workspace_key),
        );
    }
    serde_json::to_value(response)
        .map_err(|error| format!("worker workspace directory failed: {error}"))
}

pub(crate) fn worker_workspace_file_chunk_with_options(
    _shared: &SharedGateway,
    path: String,
    cursor: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let response =
        experimental_worker_router(workspace_root, config_snapshot).dispatch(&WorkerRequest::new(
            request_id.id("workspace-file-chunk"),
            request_id.trace_id("workspace-file-chunk"),
            "workspace.read_file_chunk",
            serde_json::json!({ "path": path, "cursor": cursor }),
        ));
    serde_json::to_value(response)
        .map_err(|error| format!("worker workspace file chunk failed: {error}"))
}
