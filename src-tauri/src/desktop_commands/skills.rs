use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::{
    call_rust_state_service, experimental_worker_config_snapshot, native_backend_workspace_root,
    SharedGateway,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSkillDetailInput {
    name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSkillCreateInput {
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSkillUpdateInput {
    name: String,
    body: serde_json::Value,
}

#[tauri::command]
pub(crate) fn worker_skills_list(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_list_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_skills_detail(
    input: WorkerSkillDetailInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_detail_with_options(
        state.inner(),
        input.name,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_skills_create(
    input: WorkerSkillCreateInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_create_with_options(
        state.inner(),
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_skills_update(
    input: WorkerSkillUpdateInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_update_with_options(
        state.inner(),
        input.name,
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_skills_delete(
    input: WorkerSkillDetailInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_delete_with_options(
        state.inner(),
        input.name,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_skills_validate(
    input: WorkerSkillDetailInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_skills_validate_with_options(
        state.inner(),
        input.name,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

pub(crate) fn worker_skills_list_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_list_request(next_worker_request_correlation()),
        "worker skills list",
    )
}

pub(crate) fn build_worker_skills_list_request(
    request_id: WorkerRequestCorrelation,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-list"),
        request_id.trace_id("skills-list"),
        "skills.webui_list",
        serde_json::json!({}),
    )
}

pub(crate) fn worker_skills_detail_with_options(
    _shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_detail_request(next_worker_request_correlation(), name),
        "worker skills detail",
    )
}

pub(crate) fn build_worker_skills_detail_request(
    request_id: WorkerRequestCorrelation,
    name: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-detail"),
        request_id.trace_id("skills-detail"),
        "skills.webui_detail",
        serde_json::json!({ "name": name }),
    )
}

pub(crate) fn worker_skills_create_with_options(
    _shared: &SharedGateway,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_create_request(next_worker_request_correlation(), body),
        "worker skills create",
    )
}

pub(crate) fn build_worker_skills_create_request(
    request_id: WorkerRequestCorrelation,
    body: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-create"),
        request_id.trace_id("skills-create"),
        "skills.webui_create",
        serde_json::json!({ "body": body }),
    )
}

pub(crate) fn worker_skills_update_with_options(
    _shared: &SharedGateway,
    name: String,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_update_request(next_worker_request_correlation(), name, body),
        "worker skills update",
    )
}

pub(crate) fn build_worker_skills_update_request(
    request_id: WorkerRequestCorrelation,
    name: String,
    body: serde_json::Value,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-update"),
        request_id.trace_id("skills-update"),
        "skills.webui_update",
        serde_json::json!({ "name": name, "body": body }),
    )
}

pub(crate) fn worker_skills_delete_with_options(
    _shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_delete_request(next_worker_request_correlation(), name),
        "worker skills delete",
    )
}

pub(crate) fn build_worker_skills_delete_request(
    request_id: WorkerRequestCorrelation,
    name: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-delete"),
        request_id.trace_id("skills-delete"),
        "skills.webui_delete",
        serde_json::json!({ "name": name }),
    )
}

pub(crate) fn worker_skills_validate_with_options(
    _shared: &SharedGateway,
    name: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        build_worker_skills_validate_request(next_worker_request_correlation(), name),
        "worker skills validate",
    )
}

pub(crate) fn build_worker_skills_validate_request(
    request_id: WorkerRequestCorrelation,
    name: String,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("skills-validate"),
        request_id.trace_id("skills-validate"),
        "skills.webui_validate",
        serde_json::json!({ "name": name }),
    )
}
