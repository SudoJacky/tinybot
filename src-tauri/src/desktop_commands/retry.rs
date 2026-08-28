use crate::agent::bridge::desktop_agent_event_sink;
use crate::agent::runtime::NativeAgentTraceSink;
use crate::config::application::{native_backend_workspace_root, native_runtime_config_snapshot};
use crate::desktop::{state::lock_runtime, SharedNativeRuntime};
use crate::desktop_commands::agent::worker_run_agent_with_live_trace_sink_async;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::workspace_store::WorkspaceThreadStore;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{Runtime, State};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerThreadOperationRetryInput {
    pub(crate) command_id: String,
    #[serde(default)]
    pub(crate) source: serde_json::Value,
    pub(crate) source_item_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) target_turn_id: String,
    pub(crate) thread_id: String,
}

#[tauri::command]
pub(crate) async fn worker_retry_thread_operation<R: Runtime + 'static>(
    input: WorkerThreadOperationRetryInput,
    state: State<'_, SharedNativeRuntime>,
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let shared = state.inner().clone();
    let live_trace_sink = desktop_agent_event_sink(app);
    retry_thread_operation_with_live_trace_sink(
        &shared,
        input,
        native_backend_workspace_root(),
        native_runtime_config_snapshot(),
        Some(live_trace_sink),
        Duration::from_secs(60),
    )
    .await
}

#[cfg(test)]
pub(crate) fn retry_thread_operation_with_options(
    shared: &SharedNativeRuntime,
    input: WorkerThreadOperationRetryInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::block_on(retry_thread_operation_with_live_trace_sink(
        shared,
        input,
        workspace_root,
        config_snapshot,
        None,
        timeout,
    ))
}

async fn retry_thread_operation_with_live_trace_sink(
    shared: &SharedNativeRuntime,
    input: WorkerThreadOperationRetryInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let command_id = required_input_text(&input.command_id, "commandId")?;
    let thread_id = required_input_text(&input.thread_id, "threadId")?;
    let source_turn_id = required_input_text(&input.source_turn_id, "sourceTurnId")?;
    let source_item_id = required_input_text(&input.source_item_id, "sourceItemId")?;
    let target_turn_id = required_input_text(&input.target_turn_id, "targetTurnId")?;
    if target_turn_id == source_turn_id {
        return Err("operation.retry requires a new targetTurnId".to_string());
    }

    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let source_item = validate_retry_source(
        &thread_store,
        &thread_id,
        &source_turn_id,
        &source_item_id,
        config_snapshot.clone(),
    )?;
    let description = retry_source_description(&source_item);
    let content = format!(
        "Retry the failed canonical operation `{description}` (source item `{source_item_id}` from turn `{source_turn_id}`). Preserve completed work, verify the failure context, and continue the task from that operation."
    );
    let command_metadata = serde_json::json!({
        "commandId": command_id,
        "commandKind": "operation.retry",
        "operation": {
            "itemId": source_item_id,
            "turnId": source_turn_id,
        },
        "source": input.source,
        "target": {
            "turnId": target_turn_id,
            "sessionId": thread_id,
            "threadId": thread_id,
        },
    });
    let turn_spec = serde_json::json!({
        "turnId": target_turn_id,
        "sessionId": thread_id,
        "input": {
            "role": "user",
            "content": content,
        },
        "channel": "desktop",
        "stream": true,
        "metadata": {
            "_threadCommand": command_metadata,
            "_wants_stream": true,
        },
    });
    worker_run_agent_with_live_trace_sink_async(
        shared,
        turn_spec,
        workspace_root,
        config_snapshot,
        timeout,
        live_trace_sink,
    )
    .await?;

    Ok(serde_json::json!({
        "threadId": thread_id,
        "sessionId": thread_id,
        "turnId": target_turn_id,
    }))
}

fn validate_retry_source(
    thread_store: &WorkspaceThreadStore,
    thread_id: &str,
    source_turn_id: &str,
    source_item_id: &str,
    config_snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let turns = call_rust_state_service(
        thread_store,
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("operation-retry-turn-list"),
            request_id.trace_id("operation-retry-turn-list"),
            "thread.turn.list",
            serde_json::json!({ "threadId": thread_id }),
        ),
        "Operation retry turn lookup",
    )?;
    let latest_turn = turns
        .get("turns")
        .and_then(serde_json::Value::as_array)
        .and_then(|turns| turns.first())
        .ok_or_else(|| "operation.retry source turn was not found".to_string())?;
    let latest_turn_id = latest_turn
        .get("turnId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if latest_turn_id != source_turn_id {
        return Err(format!(
            "operation.retry targets stale turn `{source_turn_id}`; latest turn is `{latest_turn_id}`"
        ));
    }
    if latest_turn
        .get("status")
        .and_then(serde_json::Value::as_str)
        != Some("failed")
    {
        return Err(format!(
            "operation.retry source turn `{source_turn_id}` is not failed"
        ));
    }

    let request_id = next_worker_request_correlation();
    let runtime_state = call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("operation-retry-runtime-state"),
            request_id.trace_id("operation-retry-runtime-state"),
            "thread.turn.runtime_state",
            serde_json::json!({
                "threadId": thread_id,
                "turnId": source_turn_id,
            }),
        ),
        "Operation retry source item lookup",
    )?;
    runtime_state
        .get("timeline")
        .and_then(|timeline| timeline.get("items"))
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("itemId").and_then(serde_json::Value::as_str) == Some(source_item_id)
                    && item.get("status").and_then(serde_json::Value::as_str) == Some("failed")
            })
        })
        .cloned()
        .ok_or_else(|| format!("operation.retry source item `{source_item_id}` is not failed"))
}

fn retry_source_description(item: &serde_json::Value) -> String {
    let data = item.get("data").unwrap_or(&serde_json::Value::Null);
    let value = ["title", "summary", "message"]
        .iter()
        .find_map(|key| data.get(key).and_then(serde_json::Value::as_str))
        .or_else(|| item.get("kind").and_then(serde_json::Value::as_str))
        .unwrap_or("failed operation")
        .trim();
    value.chars().take(500).collect()
}

fn required_input_text(value: &str, name: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("operation.retry requires {name}"));
    }
    Ok(value.to_string())
}
