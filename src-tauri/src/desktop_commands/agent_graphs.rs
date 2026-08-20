use crate::agent_graphs::{
    self, DeleteAgentGraphInput, ListAgentGraphsInput, SaveAgentGraphInput, StoredAgentGraph,
};

#[tauri::command]
pub(crate) fn worker_agent_graphs_list(
    input: ListAgentGraphsInput,
) -> Result<Vec<StoredAgentGraph>, String> {
    agent_graphs::list(input)
}

#[tauri::command]
pub(crate) fn worker_agent_graph_save(
    input: SaveAgentGraphInput,
) -> Result<StoredAgentGraph, String> {
    agent_graphs::save(input)
}

#[tauri::command]
pub(crate) fn worker_agent_graph_delete(input: DeleteAgentGraphInput) -> Result<(), String> {
    agent_graphs::delete(input)
}
