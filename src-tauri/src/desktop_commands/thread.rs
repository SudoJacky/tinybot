use crate::config::application::{native_backend_workspace_root, native_config_snapshot};
use crate::desktop::{lock_runtime, SharedNativeRuntime};
use crate::native_browser::SharedBrowserRuntime;
use crate::protocol::capability::default_desktop_capability_policy;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerThreadRequestInput {
    #[serde(default = "empty_json_object")]
    body: serde_json::Value,
}

fn empty_json_object() -> serde_json::Value {
    serde_json::json!({})
}

macro_rules! thread_command {
    ($command:ident, $suffix:literal, $method:literal) => {
        #[tauri::command]
        pub(crate) fn $command(
            input: WorkerThreadRequestInput,
            state: State<'_, SharedNativeRuntime>,
        ) -> Result<serde_json::Value, String> {
            worker_thread_request_with_options(
                state.inner(),
                $suffix,
                $method,
                input.body,
                native_backend_workspace_root(),
                native_config_snapshot(),
                Duration::from_secs(10),
            )
        }
    };
}

thread_command!(worker_thread_create, "thread-create", "thread.create");
thread_command!(worker_thread_read, "thread-read", "thread.read");
thread_command!(worker_thread_resume, "thread-resume", "thread.resume");
thread_command!(worker_threads_list, "thread-list", "thread.list");
thread_command!(worker_thread_search, "thread-search", "thread.search");
thread_command!(worker_thread_activity, "thread-activity", "thread.activity");
thread_command!(worker_thread_status, "thread-status", "thread.status");
thread_command!(
    worker_thread_update_metadata,
    "thread-update-metadata",
    "thread.update_metadata"
);
thread_command!(
    worker_thread_agent_registry,
    "thread-agent-registry",
    "thread.agent_registry"
);
thread_command!(
    worker_thread_start_turn,
    "thread-start-turn",
    "thread.start_turn"
);
thread_command!(
    worker_thread_continue_turn,
    "thread-continue-turn",
    "thread.continue_turn"
);
thread_command!(
    worker_thread_interrupt,
    "thread-interrupt",
    "thread.interrupt"
);
thread_command!(worker_thread_apply_op, "thread-apply-op", "thread.apply_op");
thread_command!(worker_thread_archive, "thread-archive", "thread.archive");
thread_command!(
    worker_thread_unarchive,
    "thread-unarchive",
    "thread.unarchive"
);
thread_command!(worker_thread_delete, "thread-delete", "thread.delete");
thread_command!(worker_thread_fork, "thread-fork", "thread.fork");
thread_command!(worker_thread_events, "thread-events", "thread.events");
thread_command!(
    worker_thread_restore_checkpoint,
    "thread-restore-checkpoint",
    "thread.restore_checkpoint"
);
thread_command!(thread_list_turns, "thread-turn-list", "thread.turn.list");
thread_command!(
    thread_get_turn_runtime_state,
    "thread-turn-runtime-state",
    "thread.turn.runtime_state"
);

#[tauri::command]
pub(crate) fn thread_get_effective_capabilities(
    input: WorkerThreadRequestInput,
    state: State<'_, SharedNativeRuntime>,
    browser_runtime: State<'_, SharedBrowserRuntime>,
) -> Result<serde_json::Value, String> {
    let thread_id = input
        .body
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "thread effective capabilities require threadId".to_string())?
        .to_string();
    let workspace_root = native_backend_workspace_root();
    let turns = worker_thread_request_with_options(
        state.inner(),
        "thread-turn-list",
        "thread.turn.list",
        serde_json::json!({ "threadId": thread_id.clone() }),
        workspace_root.clone(),
        native_config_snapshot(),
        Duration::from_secs(10),
    )?;
    let mut capabilities = super::session::build_worker_session_effective_capabilities(
        &thread_id,
        &turns,
        workspace_root.is_dir(),
        &default_desktop_capability_policy(),
    );
    project_browser_capabilities(&mut capabilities, browser_runtime.inner())?;
    Ok(capabilities)
}

pub(crate) fn worker_thread_request_with_options(
    shared: &SharedNativeRuntime,
    request_suffix: &str,
    method: &str,
    body: serde_json::Value,
    _workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let thread_store = { lock_runtime(shared).thread_store.clone() };
    let requested_turn_id = body
        .get("turnId")
        .or_else(|| body.get("turn_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let request_id = next_worker_request_correlation();
    let mut result = call_rust_state_service(
        &thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id(request_suffix),
            request_id.trace_id(request_suffix),
            method,
            body,
        ),
        request_suffix,
    )?;
    if method == "thread.interrupt" {
        let turn_id = requested_turn_id.or_else(|| {
            result
                .pointer("/turn/turnId")
                .or_else(|| result.pointer("/turn/turn_id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
        if let Some(turn_id) = turn_id {
            let services = {
                let runtime = crate::desktop::state::lock_runtime(shared);
                runtime.native_agent_services()
            };
            let cancellation = services.cancel(&turn_id);
            let result_object = result.as_object_mut().ok_or_else(|| {
                "thread interrupt result must be a JSON object before task cancellation projection"
                    .to_string()
            })?;
            result_object.insert("taskCancellation".to_string(), cancellation);
        }
    }
    Ok(result)
}

fn project_browser_capabilities(
    capabilities: &mut serde_json::Value,
    browser_runtime: &SharedBrowserRuntime,
) -> Result<(), String> {
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
    Ok(())
}
