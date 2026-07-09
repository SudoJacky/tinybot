use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_knowledge_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "knowledge.add_document" => {
                let params: KnowledgeAddDocumentParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.add_document(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.list_documents" => {
                let params: KnowledgeListDocumentsParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.list_documents(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.get_document" => {
                let params: KnowledgeDocumentIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.get_document(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.document_tree" => {
                let params: KnowledgeDocumentIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.document_tree(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.delete_document" => {
                let params: KnowledgeDocumentIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.delete_document(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.start_index_job" => {
                let params: KnowledgeStartIndexJobParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.start_index_job(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.get_job" => {
                let params: KnowledgeJobIdParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.get_job(params)?).map_err(serialization_error)
            }
            "knowledge.rebuild_index" => {
                let params: KnowledgeRebuildIndexParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.rebuild_index(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.graph" => {
                let params: KnowledgeGraphParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.document_graph(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.save_entity_graph_extraction" => {
                let params: KnowledgeEntityGraphExtractionParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.save_entity_graph_extraction(params)?)
                    .map_err(serialization_error)
            }
            "knowledge.stats" => {
                serde_json::to_value(self.knowledge.stats()?).map_err(serialization_error)
            }
            "knowledge.context" => {
                let params: KnowledgeContextParams = parse_params(request)?;
                let session_files = params
                    .session_key
                    .as_deref()
                    .and_then(|session_key| self.session.get_metadata(session_key).ok())
                    .and_then(|session| {
                        session
                            .extra
                            .get("temporary_files")
                            .and_then(Value::as_array)
                            .cloned()
                    })
                    .unwrap_or_default();
                serde_json::to_value(
                    self.knowledge
                        .context_with_session_files(params, session_files)?,
                )
                .map_err(serialization_error)
            }
            "knowledge.session_upload" => {
                let params: SessionTemporaryFileUploadParams = parse_params(request)?;
                self.session.upload_temporary_file(
                    &params.session_id,
                    &params.name,
                    &params.file_type,
                    &params.content,
                    params
                        .size_bytes
                        .unwrap_or_else(|| params.content.len() as u64),
                )
            }
            "knowledge.session_list" => {
                let params: SessionIdParams = parse_params(request)?;
                self.session.list_temporary_files(&params.session_id)
            }
            "knowledge.session_clear" => {
                let params: SessionIdParams = parse_params(request)?;
                self.session.clear_temporary_files(&params.session_id)
            }
            "rag.query" => {
                let params: RagQueryParams = parse_params(request)?;
                self.query_rag(params)
            }
            "knowledge.query" => {
                let params: KnowledgeQueryParams = parse_params(request)?;
                serde_json::to_value(self.knowledge.query(params)?).map_err(serialization_error)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}
