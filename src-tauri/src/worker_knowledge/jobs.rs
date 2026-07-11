use super::*;

pub(super) fn find_document(
    root: &Path,
    doc_id: &str,
) -> Result<Option<KnowledgeDocument>, WorkerProtocolError> {
    Ok(
        read_jsonl::<KnowledgeDocument>(&KnowledgeStorePaths::new(root).documents_file)?
            .into_iter()
            .find(|document| document.id == doc_id),
    )
}

pub(super) fn completed_retrieval_job(document: &KnowledgeDocument) -> KnowledgeJob {
    let timestamp = now_timestamp();
    let chunk_count = document.chunk_count.max(1);
    KnowledgeJob {
        id: format!("kjob_{}", document.id),
        doc_id: document.id.clone(),
        name: document.name.clone(),
        status: "completed".to_string(),
        stage: "retrieval_indexed".to_string(),
        message: "Native retrieval index is available; semantic graph indexing is not available in native TS worker".to_string(),
        processed: chunk_count,
        total: chunk_count,
        error: String::new(),
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
        completed_at: timestamp,
        stage_details: Vec::new(),
        failed_stage_count: 0,
        stale_stage_count: 0,
        retrieval_ready: true,
        graph_ready: false,
        partial_availability: true,
        result: serde_json::json!({}),
    }
}

pub(super) fn completed_rebuild_job(
    rebuild_type: &str,
    stats: &KnowledgeStats,
    result: Value,
) -> KnowledgeJob {
    let timestamp = now_timestamp();
    let bm25_chunks = match rebuild_type {
        "all" => result
            .get("bm25")
            .and_then(|bm25| bm25.get("chunks_indexed"))
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(stats.total_chunks),
        "bm25" => result
            .get("chunks_indexed")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(stats.total_chunks),
        _ => stats.total_chunks,
    };
    let (processed, total, message) = match rebuild_type {
        "all" => (
            4,
            4,
            "Native available knowledge indexes are rebuilt; semantic index is not available natively",
        ),
        "tree" => (
            result
                .get("sections_indexed")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(stats.total_chunks),
            result
                .get("sections_indexed")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(stats.total_chunks),
            "Tree index is available from section-aware knowledge chunks",
        ),
        "semantic" => (2, 2, "Semantic index is not available in native TS worker"),
        _ => (
            bm25_chunks,
            bm25_chunks,
            "BM25 index is available in native TS worker",
        ),
    };
    let retrieval_ready = stats.retrieval_ready || bm25_chunks > 0;
    let graph_ready = stats.graph_ready;
    KnowledgeJob {
        id: format!("kjob_rebuild_{rebuild_type}"),
        doc_id: String::new(),
        name: format!("rebuild:{rebuild_type}"),
        status: "completed".to_string(),
        stage: "completed".to_string(),
        message: message.to_string(),
        processed,
        total,
        error: String::new(),
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
        completed_at: timestamp,
        stage_details: stats.stage_details.clone(),
        failed_stage_count: stats.failed_stage_count,
        stale_stage_count: stats.stale_stage_count,
        retrieval_ready,
        graph_ready,
        partial_availability: retrieval_ready && !graph_ready,
        result,
    }
}

pub(super) fn knowledge_bm25_rebuild_result(root: &Path) -> Result<Value, WorkerProtocolError> {
    let store = KnowledgeStorePaths::new(root);
    let documents = read_jsonl::<KnowledgeDocument>(&store.documents_file)?;
    let chunks = read_jsonl::<KnowledgeChunk>(&store.chunks_file)?;
    let chunks_indexed = chunks
        .iter()
        .filter(|chunk| !chunk.retrieval_text.trim().is_empty())
        .count();
    let mut terms = HashSet::new();
    for chunk in &chunks {
        for term in knowledge_query_terms(&chunk.retrieval_text) {
            terms.insert(term);
        }
    }
    Ok(serde_json::json!({
        "chunks_indexed": chunks_indexed,
        "terms_created": terms.len(),
        "total_docs": documents.len()
    }))
}

pub(super) fn knowledge_tree_rebuild_result(root: &Path) -> Result<Value, WorkerProtocolError> {
    let store = KnowledgeStorePaths::new(root);
    let documents = read_jsonl::<KnowledgeDocument>(&store.documents_file)?;
    let chunks = read_jsonl::<KnowledgeChunk>(&store.chunks_file)?;
    let sections_indexed = chunks
        .iter()
        .filter(|chunk| chunk.chunk_type == "parent")
        .count();
    Ok(serde_json::json!({
        "available": true,
        "documents_scanned": documents.len(),
        "sections_indexed": sections_indexed,
        "tree_ready": sections_indexed > 0
    }))
}

pub(super) fn knowledge_semantic_unavailable_result() -> Value {
    serde_json::json!({
        "skipped": true,
        "available": false,
        "entities": 0,
        "claims": 0,
        "relations": 0,
        "mentions": 0,
        "communities": 0,
        "community_reports": 0
    })
}

pub(super) fn upsert_knowledge_job(
    root: &Path,
    job: &KnowledgeJob,
) -> Result<(), WorkerProtocolError> {
    let jobs_file = KnowledgeStorePaths::new(root).jobs_file;
    let mut jobs = read_jsonl::<KnowledgeJob>(&jobs_file)?;
    jobs.retain(|existing| existing.id != job.id);
    jobs.push(job.clone());
    write_jsonl(&jobs_file, &jobs)
}

pub(super) fn completed_entity_graph_job(
    document: &KnowledgeDocument,
    params: &KnowledgeEntityGraphExtractionParams,
    source_hash: &str,
) -> KnowledgeJob {
    let timestamp = now_timestamp();
    let evidence_count = params
        .entities
        .iter()
        .map(|entity| entity.evidence.len())
        .sum::<usize>()
        + params
            .relations
            .iter()
            .map(|relation| relation.evidence.len())
            .sum::<usize>();
    KnowledgeJob {
        id: format!("kjob_extract_graph_{}", document.id),
        doc_id: document.id.clone(),
        name: format!("extract_graph:{}", document.name),
        status: "completed".to_string(),
        stage: "entity_graph_extracted".to_string(),
        message: "Knowledge entity graph extraction completed".to_string(),
        processed: 1,
        total: 1,
        error: String::new(),
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
        completed_at: timestamp,
        stage_details: Vec::new(),
        failed_stage_count: 0,
        stale_stage_count: 0,
        retrieval_ready: true,
        graph_ready: true,
        partial_availability: true,
        result: serde_json::json!({
            "entities": params.entities.len(),
            "relations": params.relations.len(),
            "evidence": evidence_count,
            "model": params.model,
            "source_hash": source_hash,
            "token_estimate": params.token_estimate,
            "diagnostics": params.diagnostics
        }),
    }
}
