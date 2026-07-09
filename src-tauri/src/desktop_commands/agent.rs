use crate::desktop_commands::config::{
    experimental_worker_config_snapshot, native_backend_workspace_root,
};
use crate::desktop_commands::webui::{
    native_webui_agent_ui_form_resolution_body, native_webui_approval_resolution_body,
};
use crate::native_agent_bridge::{
    cancel_agent_with_services, resolve_thread_approval_with_services,
    restore_agent_checkpoint_with_services, run_agent_with_services,
    submit_thread_form_with_services, submit_thread_turn_with_services, ResolveThreadApprovalInput,
    SubmitThreadFormInput, SubmitThreadTurnInput,
};
use crate::worker_agent_runtime::NativeAgentTraceSink;
use crate::worker_background::BackgroundTraceEvent;
use crate::worker_client::WorkerClient;
use crate::worker_manager::{WorkerCommandSpec, WorkerManager, WorkerManagerState};
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::{next_worker_request_correlation, WorkerRequestCorrelation};
use crate::worker_subagent_manager::{
    SubagentSendInputParams, SubagentSpawnParams, SubagentTargetParams, SubagentWaitParams,
};
use crate::{call_rust_state_service, experimental_worker_router, lock_runtime, SharedGateway};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::State;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerAgentEchoResult {
    pub(crate) ok: bool,
    pub(crate) echo: String,
    pub(crate) config_value: serde_json::Value,
    pub(crate) workspace_file_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerRunAgentInput {
    pub(crate) spec: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerRunAgentWithInputInput {
    pub(crate) input: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSubmitThreadTurnInput {
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
    pub(crate) input: serde_json::Value,
    #[serde(default)]
    pub(crate) spec: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerCancelAgentInput {
    pub(crate) run_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerRestoreAgentCheckpointInput {
    pub(crate) session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSubmitAgentFormInput {
    pub(crate) session_id: String,
    pub(crate) form_id: String,
    #[serde(default)]
    pub(crate) values: serde_json::Value,
    #[serde(default)]
    pub(crate) action: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerResumeAgentApprovalInput {
    pub(crate) session_id: String,
    pub(crate) approval_id: String,
    pub(crate) approved: bool,
    #[serde(default)]
    pub(crate) scope: Option<String>,
    #[serde(default)]
    pub(crate) guidance: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerResolveThreadApprovalInput {
    pub(crate) thread_id: String,
    pub(crate) approval_id: String,
    pub(crate) approved: bool,
    #[serde(default)]
    pub(crate) scope: Option<String>,
    #[serde(default)]
    pub(crate) guidance: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSubmitThreadFormInput {
    pub(crate) thread_id: String,
    pub(crate) form_id: String,
    #[serde(default)]
    pub(crate) values: serde_json::Value,
    #[serde(default)]
    pub(crate) action: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerBackgroundTraceListInput {
    #[serde(default)]
    pub(crate) filter: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerBackgroundTraceGetDelegateTraceInput {
    #[serde(default)]
    pub(crate) filter: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerBackgroundTraceGetArtifactInput {
    #[serde(default)]
    pub(crate) filter: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerBackgroundTraceAppendInput {
    pub(crate) event: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerBackgroundSubagentInputInput {
    pub(crate) session_key: String,
    pub(crate) subagent_id: String,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    #[serde(default)]
    pub(crate) trace_ref: Option<String>,
    #[serde(default)]
    pub(crate) child_run_id: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) metadata: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerSubagentListInput {
    pub(crate) session_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerTaskPlanListInput {
    #[serde(default)]
    pub(crate) include_completed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerTaskPlanIdInput {
    pub(crate) plan_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerTaskPlanSaveInput {
    pub(crate) plan: serde_json::Value,
}

#[tauri::command]
pub(crate) fn worker_echo_agent(
    input: String,
    state: State<'_, SharedGateway>,
) -> Result<WorkerAgentEchoResult, String> {
    worker_echo_agent_with_options(
        state.inner(),
        input,
        experimental_worker_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_run_agent(
    input: WorkerRunAgentInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_run_agent_with_options(
        state.inner(),
        input.spec,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
pub(crate) fn worker_run_agent_input(
    input: WorkerRunAgentWithInputInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_run_agent_input_with_options(
        state.inner(),
        input.input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
pub(crate) fn worker_submit_thread_turn(
    input: WorkerSubmitThreadTurnInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_submit_thread_turn_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
pub(crate) fn worker_cancel_agent(
    input: WorkerCancelAgentInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_cancel_agent_with_options(
        state.inner(),
        input.run_id,
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_restore_agent_checkpoint(
    input: WorkerRestoreAgentCheckpointInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_restore_agent_checkpoint_with_options(
        state.inner(),
        input.session_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_submit_agent_form(
    input: WorkerSubmitAgentFormInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_submit_agent_form_with_options(
        state.inner(),
        input.session_id,
        input.form_id,
        input.values,
        input.action,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
pub(crate) fn worker_resume_agent_approval(
    input: WorkerResumeAgentApprovalInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_resume_agent_approval_with_options(
        state.inner(),
        input.session_id,
        input.approval_id,
        input.approved,
        input.scope,
        input.guidance,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
pub(crate) fn worker_resolve_thread_approval(
    input: WorkerResolveThreadApprovalInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_resolve_thread_approval_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
pub(crate) fn worker_submit_thread_form(
    input: WorkerSubmitThreadFormInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_submit_thread_form_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(120),
    )
}

#[tauri::command]
pub(crate) fn worker_background_trace_list(
    input: WorkerBackgroundTraceListInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_list_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_background_trace_get_delegate_trace(
    input: WorkerBackgroundTraceGetDelegateTraceInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_get_delegate_trace_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_background_trace_get_artifact(
    input: WorkerBackgroundTraceGetArtifactInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_get_artifact_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_background_trace_append(
    input: WorkerBackgroundTraceAppendInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_trace_append_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_background_subagent_enqueue_input(
    input: WorkerBackgroundSubagentInputInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_background_subagent_enqueue_input_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_subagent_spawn(
    input: SubagentSpawnParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.spawn(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent spawn serialization failed: {error}"))
}

#[tauri::command]
pub(crate) fn worker_subagent_list(
    input: WorkerSubagentListInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    serde_json::to_value(manager.list(&input.session_key))
        .map_err(|error| format!("worker subagent list serialization failed: {error}"))
}

#[tauri::command]
pub(crate) fn worker_subagent_query(
    input: SubagentTargetParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    serde_json::to_value(manager.query(input))
        .map_err(|error| format!("worker subagent query serialization failed: {error}"))
}

#[tauri::command]
pub(crate) fn worker_subagent_send_input(
    input: SubagentSendInputParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.enqueue_input(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent send input serialization failed: {error}"))
}

#[tauri::command]
pub(crate) fn worker_subagent_wait(
    input: SubagentWaitParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    serde_json::to_value(manager.wait(input))
        .map_err(|error| format!("worker subagent wait serialization failed: {error}"))
}

#[tauri::command]
pub(crate) fn worker_subagent_cancel(
    input: SubagentTargetParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.cancel(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent cancel serialization failed: {error}"))
}

#[tauri::command]
pub(crate) fn worker_subagent_close(
    input: SubagentTargetParams,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    let manager = {
        let runtime = lock_runtime(state.inner());
        runtime.subagent_manager.clone()
    };
    let result = manager.close(input);
    persist_subagent_manager_event_if_present(
        result.event.as_ref(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
    )?;
    serde_json::to_value(result)
        .map_err(|error| format!("worker subagent close serialization failed: {error}"))
}

#[tauri::command]
pub(crate) fn worker_task_plan_list(
    input: WorkerTaskPlanListInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_list_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_task_plan_get(
    input: WorkerTaskPlanIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_get_with_options(
        state.inner(),
        input.plan_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_task_plan_save(
    input: WorkerTaskPlanSaveInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_save_with_options(
        state.inner(),
        input.plan,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_task_plan_delete(
    input: WorkerTaskPlanIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_task_plan_delete_with_options(
        state.inner(),
        input.plan_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

pub(crate) fn worker_echo_agent_with_options(
    shared: &SharedGateway,
    input: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<WorkerAgentEchoResult, String> {
    let client = WorkerClient::experimental(shared);
    client.ensure_experimental_fixture_running(workspace_root, config_snapshot)?;

    let request_id = next_worker_request_correlation();
    let request = WorkerRequest::new(
        request_id.id("agent-echo"),
        request_id.trace_id("agent-echo"),
        "agent.echo",
        serde_json::json!({ "input": input }),
    );
    let result = client.call(&request, timeout, "worker echo")?;
    serde_json::from_value(result)
        .map_err(|error| format!("worker echo response shape is invalid: {error}"))
}

pub(crate) fn worker_run_agent_with_options(
    shared: &SharedGateway,
    spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    worker_run_agent_with_live_trace_sink(
        shared,
        spec,
        workspace_root,
        config_snapshot,
        timeout,
        None,
    )
}

pub(crate) fn worker_run_agent_with_live_trace_sink(
    shared: &SharedGateway,
    spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let _ = timeout;
    let base_services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    run_agent_with_services(
        base_services,
        spec,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
}

pub(crate) fn worker_run_agent_input_with_options(
    shared: &SharedGateway,
    input: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    worker_run_agent_with_options(shared, input, workspace_root, config_snapshot, timeout)
}

pub(crate) fn worker_submit_thread_turn_with_options(
    shared: &SharedGateway,
    input: WorkerSubmitThreadTurnInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = timeout;
    let base_services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    submit_thread_turn_with_services(
        base_services,
        SubmitThreadTurnInput {
            thread_id: input.thread_id,
            input: input.input,
            spec: input.spec,
        },
        workspace_root,
        config_snapshot,
    )
}

pub(crate) fn worker_background_trace_list_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceListInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request =
        build_worker_background_trace_list_request(next_worker_request_correlation(), input);
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background trace list",
    )
}

pub(crate) fn build_worker_background_trace_list_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundTraceListInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-trace-list"),
        request_id.trace_id("background-trace-list"),
        "background.trace.list",
        serde_json::json!({ "filter": input.filter }),
    )
}

pub(crate) fn worker_background_trace_get_delegate_trace_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceGetDelegateTraceInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request = build_worker_background_trace_get_delegate_trace_request(
        next_worker_request_correlation(),
        input,
    );
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background delegate trace get",
    )
}

pub(crate) fn build_worker_background_trace_get_delegate_trace_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundTraceGetDelegateTraceInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-trace-get-delegate-trace"),
        request_id.trace_id("background-trace-get-delegate-trace"),
        "background.trace.get_delegate_trace",
        serde_json::json!({ "filter": input.filter }),
    )
}

pub(crate) fn worker_background_trace_get_artifact_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceGetArtifactInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request = build_worker_background_trace_get_artifact_request(
        next_worker_request_correlation(),
        input,
    );
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background trace artifact get",
    )
}

pub(crate) fn build_worker_background_trace_get_artifact_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundTraceGetArtifactInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-trace-get-artifact"),
        request_id.trace_id("background-trace-get-artifact"),
        "background.trace.get_artifact",
        serde_json::json!({ "filter": input.filter }),
    )
}

pub(crate) fn worker_background_trace_append_with_options(
    _shared: &SharedGateway,
    input: WorkerBackgroundTraceAppendInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let request = WorkerRequest::new(
        request_id.id("background-trace-append"),
        request_id.trace_id("background-trace-append"),
        "background.trace.append",
        serde_json::json!({ "event": input.event }),
    );
    dispatch_worker_background_trace_request(
        workspace_root,
        config_snapshot,
        request,
        "worker background trace append",
    )
}

pub(crate) fn worker_background_subagent_enqueue_input_with_options(
    shared: &SharedGateway,
    input: WorkerBackgroundSubagentInputInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request = build_worker_background_subagent_enqueue_input_request(
        next_worker_request_correlation(),
        input,
    );
    let manager = {
        let runtime = lock_runtime(shared);
        runtime.subagent_manager.clone()
    };
    let mut router =
        experimental_worker_router(workspace_root, config_snapshot).with_subagent_manager(manager);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!(
            "worker background subagent input enqueue returned error: {}",
            error.message
        ));
    }
    response.result.ok_or_else(|| {
        "worker background subagent input enqueue response missing result".to_string()
    })
}

pub(crate) fn build_worker_background_subagent_enqueue_input_request(
    request_id: WorkerRequestCorrelation,
    input: WorkerBackgroundSubagentInputInput,
) -> WorkerRequest {
    WorkerRequest::new(
        request_id.id("background-subagent-enqueue-input"),
        request_id.trace_id("background-subagent-enqueue-input"),
        "background.subagent.enqueue_input",
        serde_json::json!({
            "sessionKey": input.session_key,
            "subagentId": input.subagent_id,
            "content": input.content,
            "turnId": input.turn_id,
            "traceRef": input.trace_ref,
            "childRunId": input.child_run_id,
            "createdAt": input.created_at,
            "metadata": input.metadata,
        }),
    )
}

fn dispatch_worker_background_trace_request(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    context: &str,
) -> Result<serde_json::Value, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{context} returned error: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{context} response missing result"))
}

fn persist_subagent_manager_event_if_present(
    event: Option<&BackgroundTraceEvent>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    let Some(event) = event else {
        return Ok(());
    };
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("subagent-manager-trace-append"),
            request_id.trace_id("subagent-manager-trace-append"),
            "background.trace.append",
            serde_json::json!({ "event": event }),
        ),
        "subagent manager trace append",
    )?;
    Ok(())
}

pub(crate) fn worker_cancel_agent_with_options(
    shared: &SharedGateway,
    run_id: String,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = (config_snapshot, timeout);
    let services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    Ok(cancel_agent_with_services(services, &run_id))
}

pub(crate) fn worker_restore_agent_checkpoint_with_options(
    shared: &SharedGateway,
    session_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = timeout;
    let services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    restore_agent_checkpoint_with_services(services, session_id, workspace_root, config_snapshot)
}

pub(crate) fn worker_submit_agent_form_with_options(
    shared: &SharedGateway,
    session_id: String,
    form_id: String,
    values: serde_json::Value,
    action: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let cancelled = thread_form_action_is_cancel(action.as_deref());
    let (status_code, mut body) = native_webui_agent_ui_form_resolution_body(
        shared,
        form_id,
        &serde_json::json!({
            "session_key": session_id,
            "values": values,
            "action": action,
        }),
        cancelled,
        workspace_root,
        config_snapshot,
    )?;
    body["statusCode"] = serde_json::Value::Number(status_code.into());
    Ok(body)
}

pub(crate) fn worker_resume_agent_approval_with_options(
    shared: &SharedGateway,
    session_id: String,
    approval_id: String,
    approved: bool,
    scope: Option<String>,
    guidance: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    native_webui_approval_resolution_body(
        shared,
        approval_id,
        &serde_json::json!({
            "session_key": session_id,
            "scope": scope,
            "guidance": guidance,
        }),
        approved,
        workspace_root,
        config_snapshot,
    )
}

pub(crate) fn worker_resolve_thread_approval_with_options(
    shared: &SharedGateway,
    input: WorkerResolveThreadApprovalInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = timeout;
    let base_services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    resolve_thread_approval_with_services(
        base_services,
        ResolveThreadApprovalInput {
            thread_id: input.thread_id,
            approval_id: input.approval_id,
            approved: input.approved,
            scope: input.scope,
            guidance: input.guidance,
        },
        workspace_root,
        config_snapshot,
    )
}

pub(crate) fn worker_submit_thread_form_with_options(
    shared: &SharedGateway,
    input: WorkerSubmitThreadFormInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let _ = timeout;
    let base_services = {
        let runtime = lock_runtime(shared);
        runtime.native_agent_runtime.clone()
    };
    submit_thread_form_with_services(
        base_services,
        SubmitThreadFormInput {
            thread_id: input.thread_id,
            form_id: input.form_id,
            values: input.values,
            action: input.action,
        },
        workspace_root,
        config_snapshot,
    )
}

fn thread_form_action_is_cancel(action: Option<&str>) -> bool {
    matches!(action, Some("cancel" | "cancelled" | "dismiss"))
}

pub(crate) fn worker_task_plan_list_with_options(
    _shared: &SharedGateway,
    input: WorkerTaskPlanListInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-list"),
            request_id.trace_id("task-plan-list"),
            "task.plan.list",
            serde_json::json!({ "include_completed": input.include_completed }),
        ),
        "worker task plan list",
    )
}

pub(crate) fn worker_task_plan_get_with_options(
    _shared: &SharedGateway,
    plan_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-get"),
            request_id.trace_id("task-plan-get"),
            "task.plan.get",
            serde_json::json!({ "plan_id": plan_id }),
        ),
        "worker task plan get",
    )
}

pub(crate) fn worker_task_plan_save_with_options(
    _shared: &SharedGateway,
    plan: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-save"),
            request_id.trace_id("task-plan-save"),
            "task.plan.save",
            serde_json::json!({ "plan": plan }),
        ),
        "worker task plan save",
    )
}

pub(crate) fn worker_task_plan_delete_with_options(
    _shared: &SharedGateway,
    plan_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    dispatch_rust_task_request(
        workspace_root,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("task-plan-delete"),
            request_id.trace_id("task-plan-delete"),
            "task.plan.delete",
            serde_json::json!({ "plan_id": plan_id }),
        ),
        "worker task plan delete",
    )
}

fn dispatch_rust_task_request(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request: WorkerRequest,
    context: &str,
) -> Result<serde_json::Value, String> {
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{context} returned error: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{context} response missing result"))
}

pub(crate) fn ensure_experimental_fixture_worker_running(
    worker: &WorkerManager,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
) -> Result<(), String> {
    if worker.status().state == WorkerManagerState::Running {
        return Ok(());
    }
    worker
        .start_stdio_rpc(
            stdio_worker_fixture_command_spec(),
            experimental_worker_router(workspace_root, config_snapshot),
        )
        .map_err(|error| format!("failed to start TS worker fixture: {error:?}"))
}

fn stdio_worker_fixture_command_spec() -> WorkerCommandSpec {
    let desktop_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have repo parent")
        .to_path_buf();
    WorkerCommandSpec::new(
        "node",
        ["workers/ts-worker-fixture/src/index.ts"],
        desktop_dir,
    )
    .with_label("ts-worker-fixture")
}

fn experimental_worker_workspace_root() -> PathBuf {
    let desktop_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have repo parent")
        .to_path_buf();
    let current_layout = desktop_dir.join("workers").join("ts-worker-fixture");
    if current_layout.exists() {
        current_layout
    } else {
        desktop_dir
            .join("apps")
            .join("desktop")
            .join("workers")
            .join("ts-worker-fixture")
    }
}
