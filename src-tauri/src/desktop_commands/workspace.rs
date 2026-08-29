use crate::config::application::{native_backend_workspace_root, native_config_snapshot};
use crate::desktop::{lock_runtime, SharedNativeRuntime};
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::{
    call_rust_state_service, native_request_router, native_request_router_with_workspace_root,
};
use crate::workspace::WorkerWorkspaceRpc;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tauri::{ipc::Response, State};

const OFFICE_PREVIEW_FILE_LIMIT_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerWorkspaceFileInput {
    path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerWorkspaceBootstrapFilesInput {
    files: Vec<String>,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerThreadWorkspaceFileChunkInput {
    thread_id: String,
    path: String,
    cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerThreadWorkspaceFileBytesInput {
    thread_id: String,
    path: String,
    expected_revision: Option<String>,
}

#[tauri::command]
pub(crate) fn worker_workspace_files(
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    worker_workspace_files_with_options(
        state.inner(),
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_file(
    input: WorkerWorkspaceFileInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    worker_workspace_file_with_options(
        state.inner(),
        input.path,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_bootstrap_files(
    input: WorkerWorkspaceBootstrapFilesInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    worker_workspace_bootstrap_files_with_options(
        state.inner(),
        input.files,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_put_file(
    input: WorkerWorkspacePutFileInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    worker_workspace_put_file_with_options(
        state.inner(),
        input.path,
        input.body,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_directory(
    input: WorkerWorkspaceDirectoryInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    worker_workspace_directory_with_options(
        state.inner(),
        input.path,
        input.cursor,
        input.name_query,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_workspace_file_chunk(
    input: WorkerWorkspaceFileChunkInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    worker_workspace_file_chunk_with_options(
        state.inner(),
        input.path,
        input.cursor,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_thread_workspace_file_chunk(
    input: WorkerThreadWorkspaceFileChunkInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    worker_thread_workspace_file_chunk_with_options(
        state.inner(),
        input.thread_id,
        input.path,
        input.cursor,
        native_backend_workspace_root(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_thread_workspace_file_bytes(
    input: WorkerThreadWorkspaceFileBytesInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<Response, String> {
    worker_thread_workspace_file_bytes_with_options(
        state.inner(),
        input.thread_id,
        input.path,
        input.expected_revision,
        native_backend_workspace_root(),
        OFFICE_PREVIEW_FILE_LIMIT_BYTES,
    )
    .map(Response::new)
}

pub(crate) fn worker_workspace_files_with_options(
    shared: &SharedNativeRuntime,
    _workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let request_id = next_worker_request_correlation();
    let items = call_rust_state_service(
        &thread_store,
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
    shared: &SharedNativeRuntime,
    path: String,
    _workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        &thread_store,
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

pub(crate) fn worker_workspace_bootstrap_files_with_options(
    shared: &SharedNativeRuntime,
    files: Vec<String>,
    _workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        &thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-bootstrap-files"),
            request_id.trace_id("workspace-bootstrap-files"),
            "workspace.read_bootstrap_files",
            serde_json::json!({ "files": files }),
        ),
        "worker workspace bootstrap files",
    )
}

pub(crate) fn worker_workspace_put_file_with_options(
    shared: &SharedNativeRuntime,
    path: String,
    body: serde_json::Value,
    _workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
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
        &thread_store,
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
        ),
        "worker workspace put file",
    )
}

pub(crate) fn worker_workspace_directory_with_options(
    shared: &SharedNativeRuntime,
    path: String,
    cursor: Option<String>,
    name_query: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let request_id = next_worker_request_correlation();
    let workspace_key = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.clone())
        .to_string_lossy()
        .to_string();
    let mut response =
        native_request_router(thread_store, config_snapshot).dispatch(&WorkerRequest::new(
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
    shared: &SharedNativeRuntime,
    path: String,
    cursor: Option<String>,
    _workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let request_id = next_worker_request_correlation();
    let response =
        native_request_router(thread_store, config_snapshot).dispatch(&WorkerRequest::new(
            request_id.id("workspace-file-chunk"),
            request_id.trace_id("workspace-file-chunk"),
            "workspace.read_file_chunk",
            serde_json::json!({ "path": path, "cursor": cursor }),
        ));
    serde_json::to_value(response)
        .map_err(|error| format!("worker workspace file chunk failed: {error}"))
}

pub(crate) fn worker_thread_workspace_file_chunk_with_options(
    shared: &SharedNativeRuntime,
    thread_id: String,
    path: String,
    cursor: Option<String>,
    default_workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (thread_store, workspace_root) =
        thread_workspace(shared, &thread_id, default_workspace_root)?;
    let path = thread_workspace_file_path(&workspace_root, &path)?;
    let request_id = next_worker_request_correlation();
    let response =
        native_request_router_with_workspace_root(thread_store, workspace_root, config_snapshot)
            .dispatch(&WorkerRequest::new(
                request_id.id("thread-workspace-file-chunk"),
                request_id.trace_id("thread-workspace-file-chunk"),
                "workspace.read_file_chunk",
                serde_json::json!({ "path": path, "cursor": cursor }),
            ));
    serde_json::to_value(response)
        .map_err(|error| format!("thread workspace file chunk failed: {error}"))
}

pub(crate) fn worker_thread_workspace_file_bytes_with_options(
    shared: &SharedNativeRuntime,
    thread_id: String,
    path: String,
    expected_revision: Option<String>,
    default_workspace_root: PathBuf,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let (_, workspace_root) = thread_workspace(shared, &thread_id, default_workspace_root)?;
    let path = thread_workspace_file_path(&workspace_root, &path)?;
    WorkerWorkspaceRpc::new(
        workspace_root,
        crate::protocol::capability::default_desktop_capability_policy(),
    )
    .with_builtin_skills_root(crate::config::application::repo_root())
    .read_file_bytes(&path, expected_revision.as_deref(), max_bytes)
    .map_err(|error| {
        format!(
            "thread workspace file bytes failed: {}; details={}",
            error.message, error.details
        )
    })
}

fn thread_workspace(
    shared: &SharedNativeRuntime,
    thread_id: &str,
    default_workspace_root: PathBuf,
) -> Result<
    (
        crate::threads::workspace_store::WorkspaceThreadStore,
        PathBuf,
    ),
    String,
> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let workspace_root = {
        let operation = thread_store.begin_operation().map_err(|error| {
            format!(
                "thread workspace file lookup failed: {}; details={}",
                error.message, error.details
            )
        })?;
        let (thread, _) = operation
            .thread_log()
            .thread_projection_for(thread_id)
            .map_err(|error| {
                format!(
                    "thread workspace file lookup failed: {}; details={}",
                    error.message, error.details
                )
            })?;
        thread
            .metadata
            .working_directory
            .map(PathBuf::from)
            .unwrap_or(default_workspace_root)
    };
    Ok((thread_store, workspace_root))
}

fn thread_workspace_file_path(
    workspace_root: &std::path::Path,
    requested: &str,
) -> Result<String, String> {
    let requested_path = PathBuf::from(requested);
    if !requested_path.is_absolute() {
        return Ok(requested.to_string());
    }
    let canonical_root = workspace_root.canonicalize().map_err(|error| {
        format!(
            "thread workspace file lookup failed: workspace root is unavailable: {error}; workspaceRoot={}",
            workspace_root.display()
        )
    })?;
    let canonical_file = requested_path.canonicalize().map_err(|error| {
        format!(
            "thread workspace file lookup failed: file is unavailable: {error}; path={requested}"
        )
    })?;
    let relative = canonical_file.strip_prefix(&canonical_root).map_err(|_| {
        format!(
            "thread workspace file lookup failed: file is outside the thread workspace; path={requested}; workspaceRoot={}",
            canonical_root.display()
        )
    })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    if relative.is_empty() {
        return Err(
            "thread workspace file lookup failed: path identifies the workspace root".to_string(),
        );
    }
    Ok(relative)
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
