use crate::agent::bridge::resolve_agent_ui_form_body_with_services;
use crate::config::application::{native_backend_workspace_root, native_runtime_config_snapshot};
use crate::desktop::{state::lock_runtime, SharedNativeRuntime};
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
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::native_request_router;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tauri::State;

const WORKER_WEBUI_ROUTE_TIMEOUT: Duration = Duration::from_secs(10);

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
pub(crate) async fn worker_webui_route(
    input: WorkerWebuiRouteInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    let timeout = worker_webui_route_timeout(&input);
    let shared = state.inner().clone();
    worker_webui_route_with_options_async(
        &shared,
        input,
        native_backend_workspace_root(),
        native_runtime_config_snapshot(),
        timeout,
    )
    .await
}

#[cfg(test)]
pub(crate) fn worker_webui_route_with_options(
    shared: &SharedNativeRuntime,
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
    shared: &SharedNativeRuntime,
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
    shared: &SharedNativeRuntime,
    input: &WorkerWebuiRouteInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<Option<serde_json::Value>, String> {
    let method = input.method.to_ascii_uppercase();
    let (path, query) = split_webui_route_path(&input.path);
    let body = input.body.clone().unwrap_or(serde_json::Value::Null);

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

    let tools_workspace_root = query
        .get("workingDirectory")
        .map(String::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.clone());

    if method == "GET" {
        if let Some(skill_id) = webui_tool_skill_detail_id(&path) {
            let detail =
                worker_webui_tool_skill_detail_body(skill_id, tools_workspace_root.clone()).await?;
            let (status, body) = match detail {
                Some(detail) => (200, detail),
                None => (
                    404,
                    serde_json::json!({ "error": { "message": "Skill not found" } }),
                ),
            };
            return Ok(Some(webui_route_response(
                status,
                body,
                "rust",
                webui_route_group(&path),
            )));
        }
    }

    let result = match (method.as_str(), path.as_str()) {
        ("GET", "/api/tools") => Some(
            worker_webui_tools_body(shared, tools_workspace_root, config_snapshot.clone()).await,
        ),
        ("GET", "/api/providers") => Some(Ok(crate::agent::provider::provider_catalog_body(
            &config_snapshot,
        ))),
        ("POST", "/api/provider-models") => Some(Ok(crate::agent::provider::provider_models_body(
            &config_snapshot,
            &body,
        )
        .await)),
        ("GET", "/api/skills") => Some(worker_skills_list_with_options(
            shared,
            workspace_root.clone(),
            config_snapshot.clone(),
            timeout,
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
    shared: &SharedNativeRuntime,
    method: &str,
    path: &str,
    body: &serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Option<Result<serde_json::Value, String>> {
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
    None
}

async fn worker_webui_tools_body(
    shared: &SharedNativeRuntime,
    workspace_root: PathBuf,
    mut config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (mcp_runtime, thread_store) = {
        let runtime = lock_runtime(shared);
        (runtime.mcp_runtime.clone(), runtime.thread_store.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::workspace_extensions::merge_workspace_mcp_servers(
            &mut config_snapshot,
            &workspace_root,
        )?;
        let mut skills = crate::workspace_extensions::discover_workspace_skills(&workspace_root)?
            .into_iter()
            .map(|skill| {
                serde_json::json!({
                    "id": format!("workspace:{}", skill.name),
                    "name": skill.name,
                    "description": skill.description,
                    "source": "workspace",
                    "path": skill.path.display().to_string(),
                })
            })
            .collect::<Vec<_>>();
        for plugin in crate::plugins::PluginStore::default_global()
            .enabled()
            .map_err(|error| format!("failed to discover Agent Plugin skills: {error}"))?
        {
            for skill in plugin.skills {
                skills.push(serde_json::json!({
                    "id": skill.qualified_name(),
                    "name": skill.name,
                    "description": skill.description,
                    "source": format!("plugin:{}", skill.plugin_name),
                    "path": skill.path.display().to_string(),
                }));
            }
        }
        skills.sort_by(|left, right| {
            left.get("id")
                .and_then(serde_json::Value::as_str)
                .cmp(&right.get("id").and_then(serde_json::Value::as_str))
        });
        let request_id = next_worker_request_correlation();
        let mut router =
            native_request_router(thread_store, config_snapshot).with_mcp_runtime(mcp_runtime);
        let response = router.dispatch(&WorkerRequest::new(
            request_id.id("webui-tools"),
            request_id.trace_id("webui-tools"),
            "tools.webui_catalog",
            serde_json::json!({}),
        ));
        if let Some(error) = response.error {
            return Err(format!("worker webui tools failed: {}", error.message));
        }
        let mut result = response
            .result
            .ok_or_else(|| "worker webui tools failed: missing response result".to_string())?;
        result["skills"] = serde_json::Value::Array(skills);
        Ok(result)
    })
    .await
    .map_err(|error| format!("worker webui tools task failed: {error}"))?
}

async fn worker_webui_tool_skill_detail_body(
    skill_id: String,
    workspace_root: PathBuf,
) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(skill) =
            crate::workspace_extensions::discover_workspace_skills(&workspace_root)?
                .into_iter()
                .find(|skill| format!("workspace:{}", skill.name) == skill_id)
        {
            return Ok(Some(serde_json::json!({
                "id": skill_id,
                "name": skill.name,
                "description": skill.description,
                "source": "workspace",
                "path": skill.path.display().to_string(),
                "content": skill.content,
            })));
        }
        for plugin in crate::plugins::PluginStore::default_global()
            .enabled()
            .map_err(|error| format!("failed to discover Agent Plugin skills: {error}"))?
        {
            if let Some(skill) = plugin
                .skills
                .into_iter()
                .find(|skill| skill.qualified_name() == skill_id)
            {
                return Ok(Some(serde_json::json!({
                    "id": skill_id,
                    "name": skill.name,
                    "description": skill.description,
                    "source": format!("plugin:{}", skill.plugin_name),
                    "path": skill.path.display().to_string(),
                    "content": skill.content,
                })));
            }
        }
        Ok(None)
    })
    .await
    .map_err(|error| format!("worker webui Skill detail task failed: {error}"))?
}

pub(crate) async fn native_webui_agent_ui_form_resolution_body_async(
    shared: &SharedNativeRuntime,
    form_id: String,
    body: &serde_json::Value,
    cancelled: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(u16, serde_json::Value), String> {
    let base_services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_services()
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

fn webui_tool_skill_detail_id(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/tools/skills/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(percent_decode(rest))
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
    if path.starts_with("/api/workspace") {
        "workspace"
    } else if path.starts_with("/api/skills") {
        "skills"
    } else if path.starts_with("/api/tools") {
        "tools"
    } else if path == "/api/providers" || path == "/api/provider-models" {
        "providers"
    } else if path.starts_with("/api/agent-ui") {
        "agent-ui"
    } else if path.starts_with("/v1/") {
        "openai"
    } else {
        "unsupported"
    }
}

fn unsupported_webui_route_response(method: &str, path: &str, message: &str) -> serde_json::Value {
    let route_group = webui_route_group(path);
    let body = serde_json::json!({
        "diagnostic": "unsupported-route",
        "inventoryStatus": "not-inventoried",
        "routeGroup": route_group,
        "error": { "message": message },
        "method": method,
        "path": path,
        "route": format!("{} {}", method, path),
    });
    webui_route_response(501, body, "unsupported", route_group)
}

pub(crate) fn worker_webui_route_timeout(input: &WorkerWebuiRouteInput) -> Duration {
    let _ = input;
    WORKER_WEBUI_ROUTE_TIMEOUT
}
