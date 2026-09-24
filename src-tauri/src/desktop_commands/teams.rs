use crate::config::application::{native_backend_workspace_root, native_runtime_config_snapshot};
use crate::desktop::{lock_runtime, SharedNativeRuntime};
use crate::teams::{
    self, ControlTeamInput, NativeTeamExecutor, PrepareTeamInput, ReviseTeamInput, TeamRun,
    TeamRunInput,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub(crate) async fn worker_team_prepare(
    input: PrepareTeamInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<TeamRun, String> {
    let root = lock_runtime(state.inner())
        .thread_store
        .data_root()
        .to_path_buf();
    // Reject invalid workspaces before spending a planner request.
    crate::workspace_registry::canonical_workspace(std::path::Path::new(
        &input.spec.workspace_path,
    ))?;
    let run_id = teams::new_run_id();
    let scope = crate::token_usage::UsageScope {
        origin: crate::token_usage::UsageOrigin {
            purpose: crate::token_usage::UsagePurpose::TeamPlanning,
            team_run_id: Some(run_id.clone()),
            ..Default::default()
        },
        store: Some(crate::token_usage::DailyTokenUsageStore::from_data_root(
            &root,
        )),
    };
    let plan = match input.plan {
        Some(plan) => plan,
        None => {
            scope
                .run(teams::plan(
                    &native_runtime_config_snapshot(),
                    &input.spec,
                    input.planner_model.as_ref(),
                ))
                .await?
        }
    };
    teams::prepare_with_id(&root, input.spec, plan, run_id)
}

#[tauri::command]
pub(crate) fn worker_team_runs_list(
    state: State<'_, SharedNativeRuntime>,
) -> Result<Vec<TeamRun>, String> {
    let root = lock_runtime(state.inner())
        .thread_store
        .data_root()
        .to_path_buf();
    teams::list(&root)
}

#[tauri::command]
pub(crate) fn worker_team_run_get(
    run_id: String,
    state: State<'_, SharedNativeRuntime>,
) -> Result<TeamRun, String> {
    let root = lock_runtime(state.inner())
        .thread_store
        .data_root()
        .to_path_buf();
    teams::get(&root, &run_id)
}

#[tauri::command]
pub(crate) fn worker_team_revise(
    input: ReviseTeamInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<TeamRun, String> {
    let root = lock_runtime(state.inner())
        .thread_store
        .data_root()
        .to_path_buf();
    teams::revise(&root, input)
}

#[tauri::command]
pub(crate) fn worker_team_control(
    input: ControlTeamInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<TeamRun, String> {
    let root = lock_runtime(state.inner())
        .thread_store
        .data_root()
        .to_path_buf();
    teams::control(&root, input)
}

#[tauri::command]
pub(crate) async fn worker_team_execute(
    input: TeamRunInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<TeamRun, String> {
    let (root, services) = {
        let runtime = lock_runtime(state.inner());
        (
            runtime.thread_store.data_root().to_path_buf(),
            runtime.native_agent_services(),
        )
    };
    teams::execute(
        &root,
        input,
        Arc::new(NativeTeamExecutor {
            worker_options: serde_json::json!({}),
            services,
            workspace_root: native_backend_workspace_root(),
            config: native_runtime_config_snapshot(),
        }),
    )
    .await
}

#[tauri::command]
pub(crate) fn worker_team_artifact_read(
    run_id: String,
    input: teams::tools::ArtifactRead,
    state: State<'_, SharedNativeRuntime>,
) -> Result<serde_json::Value, String> {
    let root = lock_runtime(state.inner())
        .thread_store
        .data_root()
        .to_path_buf();
    let run = teams::get(&root, &run_id)?;
    teams::board::read_artifact(
        &run,
        crate::protocol::capability::default_desktop_capability_policy(),
        &input.entry_id,
        input.artifact_index,
        input.byte_offset,
        input.max_bytes.unwrap_or(teams::board::READ_BYTES),
    )
}
