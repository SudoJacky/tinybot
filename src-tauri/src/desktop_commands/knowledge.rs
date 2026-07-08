use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use crate::{
    experimental_worker_config_snapshot, experimental_worker_router, native_backend_workspace_root,
    SharedGateway,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerKnowledgeDocumentsInput {
    #[serde(default)]
    pub(crate) category: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerKnowledgeBodyInput {
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerKnowledgeDocumentIdInput {
    doc_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerKnowledgeJobIdInput {
    job_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerKnowledgeRebuildIndexInput {
    #[serde(default)]
    rebuild_type: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerKnowledgeGraphInput {
    #[serde(default)]
    pub(crate) doc_id: Option<String>,
    #[serde(default)]
    pub(crate) graph_type: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
    #[serde(default)]
    pub(crate) edge_limit: Option<usize>,
    #[serde(default)]
    pub(crate) min_confidence: Option<f64>,
    #[serde(default)]
    pub(crate) include_orphans: Option<bool>,
}

#[tauri::command]
pub(crate) fn worker_knowledge_documents(
    input: WorkerKnowledgeDocumentsInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_documents_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_knowledge_add_document(
    input: WorkerKnowledgeBodyInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_add_document_with_options(
        state.inner(),
        input.body,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_knowledge_document(
    input: WorkerKnowledgeDocumentIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_document_with_options(
        state.inner(),
        input.doc_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_knowledge_delete_document(
    input: WorkerKnowledgeDocumentIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_delete_document_with_options(
        state.inner(),
        input.doc_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_knowledge_job(
    input: WorkerKnowledgeJobIdInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_job_with_options(
        state.inner(),
        input.job_id,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_knowledge_rebuild_index(
    input: WorkerKnowledgeRebuildIndexInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_rebuild_index_with_options(
        state.inner(),
        input.rebuild_type,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_knowledge_stats(
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_stats_with_options(
        state.inner(),
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub(crate) fn worker_knowledge_graph(
    input: WorkerKnowledgeGraphInput,
    state: State<'_, SharedGateway>,
) -> Result<serde_json::Value, String> {
    worker_knowledge_graph_with_options(
        state.inner(),
        input,
        native_backend_workspace_root(),
        experimental_worker_config_snapshot(),
        Duration::from_secs(10),
    )
}

pub(crate) fn worker_knowledge_documents_with_options(
    _shared: &SharedGateway,
    input: WorkerKnowledgeDocumentsInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-documents",
        "knowledge.list_documents",
        serde_json::json!({
            "category": input.category,
            "limit": input.limit,
        }),
        "worker knowledge documents",
    )
}

pub(crate) fn worker_knowledge_add_document_with_options(
    _shared: &SharedGateway,
    body: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-add-document",
        "knowledge.add_document",
        body,
        "worker knowledge add document",
    )
}

pub(crate) fn worker_knowledge_document_with_options(
    _shared: &SharedGateway,
    doc_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-document",
        "knowledge.get_document",
        serde_json::json!({ "doc_id": doc_id }),
        "worker knowledge document",
    )
}

pub(crate) fn worker_knowledge_delete_document_with_options(
    _shared: &SharedGateway,
    doc_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-delete-document",
        "knowledge.delete_document",
        serde_json::json!({ "doc_id": doc_id }),
        "worker knowledge delete document",
    )
}

pub(crate) fn worker_knowledge_job_with_options(
    _shared: &SharedGateway,
    job_id: String,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-job",
        "knowledge.get_job",
        serde_json::json!({ "job_id": job_id }),
        "worker knowledge job",
    )
}

pub(crate) fn worker_knowledge_rebuild_index_with_options(
    _shared: &SharedGateway,
    rebuild_type: Option<String>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-rebuild-index",
        "knowledge.rebuild_index",
        serde_json::json!({ "type": rebuild_type }),
        "worker knowledge rebuild index",
    )
}

pub(crate) fn worker_knowledge_stats_with_options(
    _shared: &SharedGateway,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-stats",
        "knowledge.stats",
        serde_json::json!({}),
        "worker knowledge stats",
    )
}

pub(crate) fn worker_knowledge_graph_with_options(
    _shared: &SharedGateway,
    input: WorkerKnowledgeGraphInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    _timeout: Duration,
) -> Result<serde_json::Value, String> {
    dispatch_rust_knowledge_request(
        workspace_root,
        config_snapshot,
        "knowledge-graph",
        "knowledge.graph",
        serde_json::json!({
            "doc_id": input.doc_id,
            "graph_type": input.graph_type,
            "limit": input.limit,
            "edge_limit": input.edge_limit,
            "min_confidence": input.min_confidence,
            "include_orphans": input.include_orphans,
        }),
        "worker knowledge graph",
    )
}

fn dispatch_rust_knowledge_request(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    request_suffix: &str,
    method: &str,
    params: serde_json::Value,
    context: &str,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    let request = WorkerRequest::new(
        request_id.id(request_suffix),
        request_id.trace_id(request_suffix),
        method,
        params,
    );
    let mut router = experimental_worker_router(workspace_root, config_snapshot);
    let response = router.dispatch(&request);
    if let Some(error) = response.error {
        return Err(format!("{context} returned error: {}", error.message));
    }
    response
        .result
        .ok_or_else(|| format!("{context} response missing result"))
}
