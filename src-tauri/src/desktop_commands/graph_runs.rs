use crate::config::application::{native_backend_workspace_root, native_runtime_config_snapshot};
use crate::desktop::{lock_runtime, SharedNativeRuntime};
use crate::graph_runs::{self, AgentGraphRun, ListAgentGraphRunsInput, StartAgentGraphRunInput};
use tauri::State;

#[tauri::command]
pub(crate) fn worker_agent_graph_runs_list(
    input: ListAgentGraphRunsInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<Vec<AgentGraphRun>, String> {
    let data_root = {
        lock_runtime(state.inner())
            .thread_store
            .data_root()
            .to_path_buf()
    };
    graph_runs::list(&data_root, input)
}

#[tauri::command]
pub(crate) async fn worker_agent_graph_run(
    input: StartAgentGraphRunInput,
    state: State<'_, SharedNativeRuntime>,
) -> Result<AgentGraphRun, String> {
    let (data_root, services) = {
        let runtime = lock_runtime(state.inner());
        (
            runtime.thread_store.data_root().to_path_buf(),
            runtime.native_agent_services(),
        )
    };
    graph_runs::start(
        &data_root,
        services,
        native_backend_workspace_root(),
        native_runtime_config_snapshot(),
        input,
    )
    .await
}
