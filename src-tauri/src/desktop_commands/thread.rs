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
            state: State<'_, SharedGateway>,
        ) -> Result<serde_json::Value, String> {
            worker_thread_request_with_options(
                state.inner(),
                $suffix,
                $method,
                input.body,
                native_backend_workspace_root(),
                experimental_worker_config_snapshot(),
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

pub(crate) fn worker_thread_request_with_options(
    _shared: &SharedGateway,
    request_suffix: &str,
    method: &str,
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
            request_id.id(request_suffix),
            request_id.trace_id(request_suffix),
            method,
            body,
        ),
        request_suffix,
    )
}
