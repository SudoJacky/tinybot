use crate::config::application::{native_backend_workspace_root, native_config_snapshot};
use crate::desktop::{lock_runtime, SharedNativeRuntime};
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
    let mut capabilities = build_thread_effective_capabilities(
        &thread_id,
        &turns,
        workspace_root.is_dir(),
        &default_desktop_capability_policy(),
    );
    project_browser_capabilities(&mut capabilities, browser_runtime.inner())?;
    Ok(capabilities)
}

pub(crate) fn build_thread_effective_capabilities(
    thread_id: &str,
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
        _ => unavailable_capability("no_active_turn", "The thread has no active Agent turn."),
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
            "The thread has no latest failed Agent turn to retry.",
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
        "schemaVersion": "tinybot.effective_capabilities.v2",
        "threadId": thread_id,
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
