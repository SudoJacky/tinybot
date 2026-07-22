use crate::agent::bridge::{
    native_session_checkpoint, pending_approvals_from_checkpoint,
    resolve_agent_ui_form_body_with_services, resolve_approval_body_with_services,
};
use crate::collaboration::cowork::WorkerCoworkRuntime;
use crate::config::application::{
    experimental_worker_config_snapshot, native_backend_workspace_root,
};
use crate::desktop_commands::session::{
    worker_session_branch_with_options, worker_session_clear_temporary_files_with_options,
    worker_session_clear_with_options, worker_session_delete_with_options,
    worker_session_effective_capabilities_with_options, worker_session_messages_with_options,
    worker_session_patch_with_options, worker_session_temporary_files_with_options,
    worker_session_upload_temporary_file_with_options, worker_sessions_list_with_options,
};
use crate::desktop_commands::skills::{
    worker_skills_create_with_options, worker_skills_delete_with_options,
    worker_skills_detail_with_options, worker_skills_list_with_options,
    worker_skills_update_with_options, worker_skills_validate_with_options,
};
use crate::desktop_commands::workspace::{
    worker_workspace_directory_with_options, worker_workspace_file_chunk_with_options,
    worker_workspace_file_with_options, worker_workspace_files_with_options,
    worker_workspace_put_file_with_options,
};
use crate::native_backend_contract::webui_route_inventory_entry;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::transport::stdio_worker::manager::WorkerManagerState;
use crate::transport::stdio_worker::status::WorkerRuntimeStatus;
use crate::{call_rust_state_service, lock_runtime, SharedGateway, WORKER_WEBUI_ROUTE_TIMEOUT};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tauri::State;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerCoworkRouteInput {
    pub(crate) method: String,
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) body: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) query: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerWebuiRouteInput {
    pub(crate) method: String,
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) headers: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) body: Option<serde_json::Value>,
}

#[tauri::command]
pub(crate) fn worker_probe_status() -> WorkerRuntimeStatus {
    WorkerRuntimeStatus::rust_backend_active(vec![crate::protocol::WorkerDiagnosticLine::new(
        "stdout",
        format!(
            "rust backend protocol {}",
            crate::protocol::WORKER_PROTOCOL_VERSION
        ),
    )])
}

#[tauri::command]
pub(crate) fn worker_cowork_route(
    input: WorkerCoworkRouteInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_cowork_route_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(30),
    )
}

#[tauri::command]
pub(crate) async fn worker_webui_route(
    input: WorkerWebuiRouteInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let timeout = worker_webui_route_timeout(&input);
    let shared = state.inner().clone();
    worker_webui_route_with_options_async(
        &shared,
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        timeout,
    )
    .await
}

pub(crate) fn worker_cowork_route_with_options(
    _shared: &SharedGateway,
    input: WorkerCoworkRouteInput,
    workspace_root: PathBuf,
    _config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    if let Some(response) = worker_cowork_rust_route_with_options(&input, workspace_root.clone()) {
        return response;
    }

    let method = input.method.to_ascii_uppercase();
    let (path, _) = split_webui_route_path(&input.path);
    Ok(unsupported_webui_route_response(
        &method,
        &path,
        "cowork route unavailable in the Rust-only backend",
    ))
}

fn worker_cowork_rust_route_with_options(
    input: &WorkerCoworkRouteInput,
    workspace_root: PathBuf,
) -> Option<Result<serde_json::Value, String>> {
    let method = input.method.to_ascii_uppercase();
    let (path, path_query) = split_webui_route_path(&input.path);
    let mut query = path_query;
    if let Some(input_query) = input.query.as_ref().and_then(serde_json::Value::as_object) {
        for (key, value) in input_query {
            if let Some(value) = value.as_str() {
                query.insert(key.clone(), value.to_string());
            }
        }
    }
    let runtime = WorkerCoworkRuntime::new(workspace_root);
    let result = match (method.as_str(), path.as_str()) {
        ("GET", "/api/cowork/sessions") => Some(
            runtime.list_sessions(
                query
                    .get("include_completed")
                    .is_some_and(|value| matches!(value.as_str(), "1" | "true")),
            ),
        ),
        ("POST", "/api/cowork/sessions") => Some(
            runtime.create_session(input.body.clone().unwrap_or_else(|| serde_json::json!({}))),
        ),
        ("POST", "/api/cowork/blueprints/validate") => Some(runtime.validate_blueprint(
            input.body.clone().unwrap_or_else(|| serde_json::json!({})),
            false,
        )),
        ("POST", "/api/cowork/blueprints/preview") => Some(runtime.validate_blueprint(
            input.body.clone().unwrap_or_else(|| serde_json::json!({})),
            true,
        )),
        _ => worker_cowork_rust_dynamic_route(
            &runtime,
            &method,
            &path,
            input.body.clone().unwrap_or_else(|| serde_json::json!({})),
            &query,
        ),
    };

    result.map(|result| {
        result
            .map(|body| webui_route_response(200, body, "rust", "cowork"))
            .or_else(|error| {
                Ok(webui_route_response(
                    500,
                    serde_json::json!({ "error": { "message": error } }),
                    "rust",
                    "cowork",
                ))
            })
    })
}

fn worker_cowork_rust_dynamic_route(
    runtime: &WorkerCoworkRuntime,
    method: &str,
    path: &str,
    body: serde_json::Value,
    query: &HashMap<String, String>,
) -> Option<Result<serde_json::Value, String>> {
    let rest = path.strip_prefix("/api/cowork/sessions/")?;
    let mut parts = rest.split('/').map(percent_decode).collect::<Vec<_>>();
    if parts.is_empty() || parts[0].is_empty() {
        return None;
    }
    let session_id = parts.remove(0);
    if method == "GET" && parts.is_empty() {
        return Some(runtime.get_session(&session_id).map(|session| {
            session.unwrap_or_else(|| serde_json::json!({ "error": "cowork session not found" }))
        }));
    }
    if method == "GET" && parts.len() == 1 {
        return Some(runtime.session_view(&session_id, &parts[0]).map(|view| {
            view.unwrap_or_else(|| serde_json::json!({ "error": "cowork session not found" }))
        }));
    }
    if method == "DELETE" && parts.is_empty() {
        return Some(runtime.delete_session(&session_id));
    }
    if method == "POST" && parts.len() == 1 {
        return match parts[0].as_str() {
            "run" => Some(runtime.run_session(&session_id, body)),
            "budget" => Some(runtime.update_budget(&session_id, body)),
            "pause" | "resume" | "emergency-stop" => {
                Some(runtime.session_action(&session_id, &parts[0], body))
            }
            "messages" => Some(runtime.append_message(&session_id, body)),
            "tasks" => Some(runtime.add_task(&session_id, body)),
            _ => None,
        };
    }
    if method == "PATCH" && parts.len() == 1 && parts[0] == "budget" {
        return Some(runtime.update_budget(&session_id, body));
    }
    if method == "GET" && parts.len() == 3 && parts[0] == "agents" && parts[2] == "activity" {
        let limit = query
            .get("limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(50);
        return Some(runtime.agent_activity(&session_id, &parts[1], limit));
    }
    if method == "GET" && parts.len() == 2 && parts[0] == "observations" {
        return Some(runtime.observation(&session_id, &parts[1]));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "tasks" {
        return Some(runtime.task_action(&session_id, &parts[1], &parts[2], body));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "work-units" {
        return Some(runtime.work_unit_action(&session_id, &parts[1], &parts[2], body));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "branches" && parts[2] == "select" {
        return Some(runtime.select_branch(&session_id, &parts[1], body));
    }
    if method == "POST" && parts.len() == 3 && parts[0] == "branches" && parts[2] == "derive" {
        return Some(runtime.derive_branch(&session_id, Some(&parts[1]), body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "branches" && parts[1] == "derive" {
        return Some(runtime.derive_branch(&session_id, None, body));
    }
    if method == "POST"
        && parts.len() == 4
        && parts[0] == "branches"
        && parts[2] == "result"
        && parts[3] == "select-final"
    {
        return Some(runtime.select_branch_result(&session_id, &parts[1], body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "branch-results" && parts[1] == "merge" {
        return Some(runtime.merge_branch_results(&session_id, body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "final-result" && parts[1] == "select" {
        return Some(runtime.select_final_result(&session_id, body));
    }
    if method == "POST" && parts.len() == 2 && parts[0] == "final-result" && parts[1] == "merge" {
        return Some(runtime.merge_final_result(&session_id, body));
    }
    None
}

#[cfg(test)]
pub(crate) fn worker_webui_route_with_options(
    shared: &SharedGateway,
    input: WorkerWebuiRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::block_on(worker_webui_route_with_options_async(
        shared,
        input,
        workspace_root,
        config_snapshot,
        timeout,
    ))
}

pub(crate) async fn worker_webui_route_with_options_async(
    shared: &SharedGateway,
    input: WorkerWebuiRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let method = input.method.to_ascii_uppercase();
    let (path, _) = split_webui_route_path(&input.path);
    if let Some(response) = worker_webui_rust_route_with_options(
        shared,
        &input,
        workspace_root.clone(),
        config_snapshot.clone(),
        timeout,
    )
    .await?
    {
        return Ok(response);
    }

    Ok(unsupported_webui_route_response(
        &method,
        &path,
        "webui control route unavailable in the Rust-only backend",
    ))
}

async fn worker_webui_rust_route_with_options(
    shared: &SharedGateway,
    input: &WorkerWebuiRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<Option<serde_json::Value>, String> {
    let method = input.method.to_ascii_uppercase();
    let (path, query) = split_webui_route_path(&input.path);
    let body = input.body.clone().unwrap_or(serde_json::Value::Null);

    if method == "POST" && path == "/v1/chat/completions" {
        return Ok(Some(
            crate::agent::provider::openai_chat_completions_route_async(&config_snapshot, &body)
                .await,
        ));
    }
    if method == "POST" {
        if let Some((form_id, cancelled)) = webui_agent_ui_form_route(&path) {
            let (status, body) = native_webui_agent_ui_form_resolution_body_async(
                shared,
                form_id,
                &body,
                cancelled,
                workspace_root,
                config_snapshot,
            )
            .await?;
            return Ok(Some(webui_route_response(
                status,
                body,
                "rust",
                webui_route_group(&path),
            )));
        }
    }

    let result = match (method.as_str(), path.as_str()) {
        ("GET", "/health") => Some(Ok(serde_json::json!({
            "ok": true,
            "status": "ok",
            "runtime": "native-rust"
        }))),
        ("GET", "/webui/bootstrap") => Some(Ok(native_webui_bootstrap_body())),
        ("POST", "/webui/refresh-token") => Some(Ok(native_webui_bootstrap_body())),
        ("GET", "/api/status") => Some(Ok(native_webui_status_body(shared))),
        ("GET", "/api/config") => Some(worker_webui_config_body(
            workspace_root.clone(),
            config_snapshot.clone(),
        )),
        ("GET", "/api/tools") => Some(
            worker_webui_tools_body(shared, workspace_root.clone(), config_snapshot.clone()).await,
        ),
        ("GET", "/api/providers") => Some(Ok(crate::agent::provider::provider_catalog_body(
            &config_snapshot,
        ))),
        ("POST", "/api/provider-models") => Some(Ok(crate::agent::provider::provider_models_body(
            &config_snapshot,
            &body,
        ))),
        ("GET", "/v1/models") => Some(Ok(crate::agent::provider::openai_models_body(
            &config_snapshot,
        ))),
        ("GET", "/api/sessions") => Some(worker_sessions_list_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("POST", "/api/sessions/branch") => Some(worker_session_branch_with_options(
            shared,
            body,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/skills") => Some(worker_skills_list_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/approvals") => Some(native_webui_approvals_body(
            &query,
            workspace_root.clone(),
            config_snapshot.clone(),
        )),
        ("POST", "/api/skills") => Some(worker_skills_create_with_options(
            shared,
            body,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/workspace/files") => Some(worker_workspace_files_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/workspace/directory") => Some(worker_workspace_directory_with_options(
            shared,
            query
                .get("path")
                .cloned()
                .unwrap_or_else(|| ".".to_string()),
            query.get("cursor").cloned(),
            query
                .get("nameQuery")
                .or_else(|| query.get("name_query"))
                .cloned(),
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        ("GET", "/api/workspace/read") => Some(worker_workspace_file_chunk_with_options(
            shared,
            query
                .get("path")
                .cloned()
                .unwrap_or_else(|| ".".to_string()),
            query.get("cursor").cloned(),
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
        )),
        _ => {
            worker_webui_rust_dynamic_route(
                shared,
                &method,
                &path,
                &body,
                workspace_root.clone(),
                config_snapshot.clone(),
                timeout,
            )
            .await
        }
    };

    match result {
        Some(Ok(body)) => Ok(Some(webui_route_response(
            200,
            body,
            "rust",
            webui_route_group(&path),
        ))),
        Some(Err(error)) => Ok(Some(webui_route_response(
            500,
            serde_json::json!({ "error": { "message": error } }),
            "rust",
            webui_route_group(&path),
        ))),
        None if webui_route_inventory_entry(&method, &path).is_some() => {
            Ok(Some(unsupported_webui_route_response(
                &method,
                &path,
                "webui control route unavailable in the Rust-only backend",
            )))
        }
        None => {
            let route_group = webui_route_group(&path);
            Ok(Some(webui_route_response(
                404,
                serde_json::json!({
                    "diagnostic": "unsupported-route",
                    "inventoryStatus": "not-inventoried",
                    "routeGroup": route_group,
                    "error": {
                        "message": "webui control route unavailable",
                    },
                    "method": method,
                    "path": path,
                    "route": format!("{} {}", method, path),
                }),
                "unsupported",
                route_group,
            )))
        }
    }
}

async fn worker_webui_rust_dynamic_route(
    shared: &SharedGateway,
    method: &str,
    path: &str,
    body: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Option<Result<serde_json::Value, String>> {
    if let Some(key) = webui_session_route_key(path, "/effective-capabilities") {
        if method == "GET" {
            return Some(worker_session_effective_capabilities_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    if let Some(key) = webui_session_route_key(path, "/messages") {
        if method == "GET" {
            return Some(worker_session_messages_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    if let Some(key) = webui_session_route_key(path, "/temporary-files") {
        return match method {
            "GET" => Some(worker_session_temporary_files_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "POST" => Some(worker_session_upload_temporary_file_with_options(
                shared,
                key,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "DELETE" => Some(worker_session_clear_temporary_files_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(key) = webui_session_route_key(path, "/clear") {
        if method == "POST" {
            return Some(worker_session_clear_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    if let Some(key) = webui_session_item_key(path) {
        return match method {
            "PATCH" => Some(worker_session_patch_with_options(
                shared,
                key,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "DELETE" => Some(worker_session_delete_with_options(
                shared,
                key,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(path) = webui_workspace_file_path(path) {
        return match method {
            "GET" => Some(worker_workspace_file_with_options(
                shared,
                path,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "PUT" => Some(worker_workspace_put_file_with_options(
                shared,
                path,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(name) = webui_skill_route_name(path, "/validate") {
        if method == "POST" {
            return Some(worker_skills_validate_with_options(
                shared,
                name,
                workspace_root,
                config_snapshot,
                timeout,
            ));
        }
    }
    if let Some(name) = webui_skill_item_name(path) {
        return match method {
            "GET" => Some(worker_skills_detail_with_options(
                shared,
                name,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "PATCH" => Some(worker_skills_update_with_options(
                shared,
                name,
                body.clone(),
                workspace_root,
                config_snapshot,
                timeout,
            )),
            "DELETE" => Some(worker_skills_delete_with_options(
                shared,
                name,
                workspace_root,
                config_snapshot,
                timeout,
            )),
            _ => None,
        };
    }
    if let Some(approval_id) = webui_approval_route_id(path, "/approve") {
        if method == "POST" {
            return Some(
                native_webui_approval_resolution_body_async(
                    shared,
                    approval_id,
                    body,
                    true,
                    workspace_root,
                    config_snapshot,
                )
                .await,
            );
        }
    }
    if let Some(approval_id) = webui_approval_route_id(path, "/deny") {
        if method == "POST" {
            return Some(
                native_webui_approval_resolution_body_async(
                    shared,
                    approval_id,
                    body,
                    false,
                    workspace_root,
                    config_snapshot,
                )
                .await,
            );
        }
    }
    None
}

fn native_webui_bootstrap_body() -> serde_json::Value {
    serde_json::json!({
        "token": "native-rust-local",
        "ws_path": "/ws",
        "refresh_token_path": "/webui/refresh-token",
        "token_ttl_s": 300,
    })
}

fn native_webui_status_body(shared: &SharedGateway) -> serde_json::Value {
    let status = lock_runtime(shared).experimental_worker.status();
    serde_json::json!({
        "channels": {
            "websocket": {
                "enabled": true,
                "running": matches!(status.state, WorkerManagerState::Running | WorkerManagerState::Starting)
            }
        },
        "native_backend": status,
        "provider": crate::agent::provider::resolve_provider_profile(
            &experimental_worker_config_snapshot(),
            None,
            None,
        ).map(|profile| serde_json::json!({
            "id": profile.provider_id,
            "displayName": profile.display_name,
            "api_base": profile.api_base,
            "api_key_configured": profile.api_key_configured,
        })),
        "model": crate::agent::provider::configured_model(&experimental_worker_config_snapshot()),
    })
}

fn worker_webui_config_body(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let snapshot = call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("webui-config"),
            request_id.trace_id("webui-config"),
            "config.snapshot_public",
            serde_json::json!({}),
        ),
        "worker webui config",
    )?;
    Ok(snapshot.get("value").cloned().unwrap_or(snapshot))
}

async fn worker_webui_tools_body(
    shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mcp_runtime = { lock_runtime(shared).mcp_runtime.clone() };
    tauri::async_runtime::spawn_blocking(move || {
        let request_id = next_worker_request_correlation();
        let mut router = crate::experimental_worker_router(workspace_root, config_snapshot)
            .with_mcp_runtime(mcp_runtime);
        let response = router.dispatch(
            &WorkerRequest::new(
                request_id.id("webui-tools"),
                request_id.trace_id("webui-tools"),
                "tools.webui_catalog",
                serde_json::json!({}),
            )
            .with_trusted_internal(),
        );
        if let Some(error) = response.error {
            return Err(format!("worker webui tools failed: {}", error.message));
        }
        response
            .result
            .ok_or_else(|| "worker webui tools failed: missing response result".to_string())
    })
    .await
    .map_err(|error| format!("worker webui tools task failed: {error}"))?
}

fn native_webui_approvals_body(
    query: &HashMap<String, String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_key = query
        .get("session_key")
        .or_else(|| query.get("chat_id"))
        .cloned()
        .unwrap_or_default();
    let checkpoint = if session_key.is_empty() {
        None
    } else {
        native_session_checkpoint(
            &session_key,
            workspace_root,
            config_snapshot,
            "native approvals checkpoint lookup",
        )?
    };
    Ok(serde_json::json!({
        "session_key": session_key,
        "approvals": pending_approvals_from_checkpoint(checkpoint.as_ref()),
        "source": "rust",
    }))
}

pub(crate) async fn native_webui_approval_resolution_body_async(
    shared: &SharedGateway,
    approval_id: String,
    body: &serde_json::Value,
    approved: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let base_services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    resolve_approval_body_with_services(
        base_services,
        approval_id,
        body,
        approved,
        workspace_root,
        config_snapshot,
    )
    .await
}

pub(crate) async fn native_webui_agent_ui_form_resolution_body_async(
    shared: &SharedGateway,
    form_id: String,
    body: &serde_json::Value,
    cancelled: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(u16, serde_json::Value), String> {
    let base_services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    resolve_agent_ui_form_body_with_services(
        base_services,
        form_id,
        body,
        cancelled,
        workspace_root,
        config_snapshot,
    )
    .await
}

fn webui_route_response(
    status: u16,
    body: serde_json::Value,
    owner: &str,
    route_group: &str,
) -> serde_json::Value {
    serde_json::json!({
        "status": status,
        "body": body,
        "headers": {
            "x-tinybot-route-owner": owner,
            "x-tinybot-route-group": route_group,
        }
    })
}

fn split_webui_route_path(path: &str) -> (String, HashMap<String, String>) {
    let (path_only, query) = path.split_once('?').unwrap_or((path, ""));
    let mut params = HashMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(percent_decode(key), percent_decode(value));
    }
    (path_only.to_string(), params)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = &input[index + 1..index + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    output.push(value);
                    index += 3;
                    continue;
                }
                output.push(bytes[index]);
                index += 1;
            }
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).to_string()
}

fn webui_session_route_key(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/sessions/")?;
    let key = rest.strip_suffix(suffix)?;
    if key.is_empty() || key.contains('/') {
        return None;
    }
    Some(percent_decode(key))
}

fn webui_session_item_key(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/sessions/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(percent_decode(rest))
}

fn webui_workspace_file_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/workspace/files/")?;
    if rest.is_empty() {
        return None;
    }
    Some(percent_decode(rest))
}

fn webui_skill_route_name(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/skills/")?;
    let name = rest.strip_suffix(suffix)?;
    if name.is_empty() || name.contains('/') {
        return None;
    }
    Some(percent_decode(name))
}

fn webui_skill_item_name(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/skills/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(percent_decode(rest))
}

fn webui_approval_route_id(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/approvals/")?;
    let approval_id = rest.strip_suffix(suffix)?;
    if approval_id.is_empty() || approval_id.contains('/') {
        return None;
    }
    Some(percent_decode(approval_id))
}

fn webui_agent_ui_form_route(path: &str) -> Option<(String, bool)> {
    webui_agent_ui_form_route_id(path, "/submit")
        .map(|form_id| (form_id, false))
        .or_else(|| webui_agent_ui_form_route_id(path, "/cancel").map(|form_id| (form_id, true)))
}

fn webui_agent_ui_form_route_id(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/agent-ui/forms/")?;
    let form_id = rest.strip_suffix(suffix)?;
    if form_id.is_empty() || form_id.contains('/') {
        return None;
    }
    Some(percent_decode(form_id))
}

fn webui_route_group(path: &str) -> &'static str {
    if path == "/health" {
        "health"
    } else if path.starts_with("/webui/") {
        "bootstrap"
    } else if path == "/api/status" {
        "status"
    } else if path == "/api/config" {
        "config"
    } else if path.starts_with("/api/sessions") {
        "sessions"
    } else if path.starts_with("/api/workspace") {
        "workspace"
    } else if path.starts_with("/api/skills") {
        "skills"
    } else if path == "/api/tools" {
        "tools"
    } else if path == "/api/providers" || path == "/api/provider-models" {
        "providers"
    } else if path.starts_with("/api/cowork") {
        "cowork"
    } else if path.starts_with("/api/approvals") {
        "approvals"
    } else if path.starts_with("/api/agent-ui") {
        "agent-ui"
    } else if path.starts_with("/v1/") {
        "openai"
    } else {
        "unsupported"
    }
}

fn unsupported_webui_route_response(method: &str, path: &str, message: &str) -> serde_json::Value {
    let inventory = webui_route_inventory_entry(method, path);
    let route_group = inventory
        .as_ref()
        .map(|entry| entry.route_group)
        .unwrap_or_else(|| webui_route_group(path));
    let mut body = serde_json::json!({
        "diagnostic": "unsupported-route",
        "inventoryStatus": if inventory.is_some() { "unsupported" } else { "not-inventoried" },
        "routeGroup": route_group,
        "error": { "message": message },
        "method": method,
        "path": path,
        "route": format!("{} {}", method, path),
    });
    if let Some(entry) = inventory {
        body["reason"] = serde_json::Value::String(entry.reason.to_string());
        body["replacementPlan"] = serde_json::Value::String(entry.replacement_plan.to_string());
    }
    webui_route_response(501, body, "unsupported", route_group)
}

pub(crate) fn worker_webui_route_timeout(input: &WorkerWebuiRouteInput) -> Duration {
    let _ = input;
    WORKER_WEBUI_ROUTE_TIMEOUT
}
