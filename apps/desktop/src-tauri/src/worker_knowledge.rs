use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct WorkerKnowledgeRpc {
    root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerKnowledgeRpc {
    pub fn new(root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self { root, policy }
    }

    pub fn add_document(
        &self,
        params: KnowledgeAddDocumentParams,
    ) -> Result<KnowledgeDocumentResult, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeWrite)?;
        let name = params.name.trim();
        let content = params.content.clone();
        if name.is_empty() {
            return Err(invalid_knowledge_request("document name is required"));
        }
        if content.trim().is_empty() {
            return Err(invalid_knowledge_request(
                "document content cannot be empty",
            ));
        }
        let file_type = params
            .file_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("txt")
            .to_ascii_lowercase();
        if file_type != "txt" && file_type != "md" {
            return Err(invalid_knowledge_request("file_type must be txt or md"));
        }
        let store = KnowledgeStorePaths::new(&self.root);
        store.ensure_dirs()?;
        let created_at = now_timestamp();
        let doc_id = make_document_id(name, &content, &created_at);
        let relative_file_path = format!("knowledge/files/{doc_id}.{file_type}");
        let absolute_file_path = self.root.join(&relative_file_path);
        fs::write(&absolute_file_path, &content).map_err(|error| {
            knowledge_filesystem_error(
                "failed to write knowledge document file",
                serde_json::json!({ "path": relative_file_path, "error": error.to_string() }),
            )
        })?;
        let parent_sections = split_parent_sections(&content);
        let chunks = build_document_chunks(
            &doc_id,
            name,
            &relative_file_path,
            &parent_sections,
            &params,
            &created_at,
        );
        let parent_chunk_count = chunks
            .iter()
            .filter(|chunk| chunk.chunk_type == "parent")
            .count();
        let document = KnowledgeDocument {
            id: doc_id.clone(),
            name: name.to_string(),
            file_path: relative_file_path,
            original_path: params.original_path,
            source: params.source.unwrap_or_else(|| "manual_upload".to_string()),
            file_type,
            content,
            created_at,
            chunk_count: parent_chunk_count,
            category: params.category.unwrap_or_default(),
            tags: params.tags.unwrap_or_default(),
            metadata: params.metadata.unwrap_or_else(|| serde_json::json!({})),
        };
        append_jsonl(&store.documents_file, &document)?;
        for chunk in &chunks {
            append_jsonl(&store.chunks_file, chunk)?;
        }
        Ok(KnowledgeDocumentResult { document })
    }

    pub fn list_documents(
        &self,
        params: KnowledgeListDocumentsParams,
    ) -> Result<KnowledgeDocumentsResult, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let mut documents =
            read_jsonl::<KnowledgeDocument>(&KnowledgeStorePaths::new(&self.root).documents_file)?;
        if let Some(category) = params.category.as_deref().filter(|value| !value.is_empty()) {
            documents.retain(|document| document.category == category);
        }
        documents.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.name.cmp(&right.name))
        });
        let limit = params.limit.unwrap_or(20).clamp(1, 100);
        documents.truncate(limit);
        Ok(KnowledgeDocumentsResult { documents })
    }

    pub fn get_document(
        &self,
        params: KnowledgeDocumentIdParams,
    ) -> Result<KnowledgeGetDocumentResult, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let Some(document) = find_document(&self.root, &params.doc_id)? else {
            return Err(unknown_knowledge_document(&params.doc_id));
        };
        Ok(KnowledgeGetDocumentResult {
            content: document.content.clone(),
            document,
        })
    }

    pub fn delete_document(
        &self,
        params: KnowledgeDocumentIdParams,
    ) -> Result<KnowledgeDeleteDocumentResult, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeWrite)?;
        let store = KnowledgeStorePaths::new(&self.root);
        let mut documents = read_jsonl::<KnowledgeDocument>(&store.documents_file)?;
        let Some(document) = documents
            .iter()
            .find(|document| document.id == params.doc_id)
            .cloned()
        else {
            return Ok(KnowledgeDeleteDocumentResult {
                deleted: false,
                doc_id: params.doc_id,
            });
        };
        documents.retain(|item| item.id != params.doc_id);
        write_jsonl(&store.documents_file, &documents)?;
        let mut chunks = read_jsonl::<KnowledgeChunk>(&store.chunks_file)?;
        chunks.retain(|chunk| chunk.doc_id != params.doc_id);
        write_jsonl(&store.chunks_file, &chunks)?;
        let _ = fs::remove_file(self.root.join(&document.file_path));
        Ok(KnowledgeDeleteDocumentResult {
            deleted: true,
            doc_id: params.doc_id,
        })
    }

    pub fn query(
        &self,
        params: KnowledgeQueryParams,
    ) -> Result<KnowledgeQueryResultSet, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let limit = params.limit.unwrap_or(5).min(20);
        if limit == 0 {
            return Ok(KnowledgeQueryResultSet {
                results: Vec::new(),
            });
        }
        let query_terms = knowledge_query_terms(&params.query);
        if query_terms.is_empty() {
            return Err(invalid_knowledge_request(
                "query must contain at least one searchable term",
            ));
        }
        let chunks =
            read_jsonl::<KnowledgeChunk>(&KnowledgeStorePaths::new(&self.root).chunks_file)?;
        let parents: HashMap<String, KnowledgeChunk> = chunks
            .iter()
            .filter(|chunk| chunk.chunk_type == "parent")
            .map(|chunk| (chunk.id.clone(), chunk.clone()))
            .collect();
        let mut results_by_parent: HashMap<String, KnowledgeQueryResult> = HashMap::new();
        for chunk in chunks {
            if let Some(category) = params.category.as_deref().filter(|value| !value.is_empty()) {
                if chunk.category != category {
                    continue;
                }
            }
            if let Some(tags) = params.tags.as_ref().filter(|tags| !tags.is_empty()) {
                if !tags.iter().any(|tag| chunk.tags.contains(tag)) {
                    continue;
                }
            }
            let score = knowledge_score(&chunk.retrieval_text, &query_terms);
            if score == 0 {
                continue;
            }
            if chunk.chunk_type == "parent" {
                let entry = results_by_parent
                    .entry(chunk.id.clone())
                    .or_insert_with(|| KnowledgeQueryResult::from_chunk(chunk, 0));
                entry.score += score;
                entry.rrf_score += score;
                entry.bm25_score += score;
                entry.sparse_contribution += score;
            } else if chunk.chunk_type == "child" {
                let Some(parent) = parents.get(&chunk.parent_id).cloned() else {
                    continue;
                };
                let entry = results_by_parent
                    .entry(parent.id.clone())
                    .or_insert_with(|| KnowledgeQueryResult::from_chunk(parent, 0));
                entry.score += score;
                entry.rrf_score += score;
                entry.bm25_score += score;
                entry.sparse_contribution += score;
                if !entry.matched_child_ids.contains(&chunk.id) {
                    entry.matched_child_ids.push(chunk.id.clone());
                }
                if !entry.matched_child_snippets.contains(&chunk.content) {
                    entry.matched_child_snippets.push(chunk.content.clone());
                }
            }
        }
        let mut results: Vec<KnowledgeQueryResult> = results_by_parent.into_values().collect();
        results.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.file_path.cmp(&right.file_path))
                .then_with(|| left.id.cmp(&right.id))
        });
        for (index, result) in results.iter_mut().enumerate() {
            result.sparse_rank = index + 1;
        }
        results.truncate(limit);
        Ok(KnowledgeQueryResultSet { results })
    }

    pub fn stats(&self) -> Result<KnowledgeStats, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let store = KnowledgeStorePaths::new(&self.root);
        let documents = read_jsonl::<KnowledgeDocument>(&store.documents_file)?;
        let chunks = read_jsonl::<KnowledgeChunk>(&store.chunks_file)?;
        let parent_chunk_count = chunks
            .iter()
            .filter(|chunk| chunk.chunk_type == "parent")
            .count();
        let child_chunk_count = chunks
            .iter()
            .filter(|chunk| chunk.chunk_type == "child")
            .count();
        let mut categories: HashMap<String, usize> = HashMap::new();
        for document in &documents {
            let category = if document.category.is_empty() {
                "uncategorized"
            } else {
                document.category.as_str()
            };
            *categories.entry(category.to_string()).or_insert(0) += 1;
        }
        let total_chars = documents
            .iter()
            .map(|document| document.content.chars().count())
            .sum();
        let retrieval_ready = parent_chunk_count > 0;
        let sparse_stage = serde_json::json!({
            "ready": retrieval_ready,
            "status": if retrieval_ready { "ready" } else { "empty" },
            "processed": chunks.len(),
            "total": chunks.len(),
            "failed": 0,
            "stale": 0
        });
        let stage_readiness = serde_json::json!({
            "sparse_indexing": sparse_stage,
            "dense_indexing": { "ready": false, "status": "not_configured", "processed": 0, "total": parent_chunk_count, "failed": 0, "stale": 0 },
            "claim_extraction": { "ready": false, "status": "not_started", "processed": 0, "total": parent_chunk_count, "failed": 0, "stale": 0 },
            "claim_validation": { "ready": false, "status": "not_started", "processed": 0, "total": parent_chunk_count, "failed": 0, "stale": 0 },
            "relation_extraction": { "ready": false, "status": "not_started", "processed": 0, "total": parent_chunk_count, "failed": 0, "stale": 0 },
            "relation_validation": { "ready": false, "status": "not_started", "processed": 0, "total": parent_chunk_count, "failed": 0, "stale": 0 },
            "graph_projection": { "ready": false, "status": "not_started", "processed": 0, "total": parent_chunk_count, "failed": 0, "stale": 0 },
            "community_report_projection": { "ready": false, "status": "not_started", "processed": 0, "total": parent_chunk_count, "failed": 0, "stale": 0 }
        });
        let stage_coverage = serde_json::json!({
            "sparse_indexing": if retrieval_ready { 1.0 } else { 0.0 },
            "dense_indexing": 0.0,
            "claim_extraction": 0.0,
            "claim_validation": 0.0,
            "relation_extraction": 0.0,
            "relation_validation": 0.0,
            "graph_projection": 0.0,
            "community_report_projection": 0.0
        });
        let claims_ready = false;
        let relations_ready = false;
        let graph_ready = false;
        Ok(KnowledgeStats {
            document_count: documents.len(),
            total_documents: documents.len(),
            chunk_count: parent_chunk_count,
            total_chunks: parent_chunk_count,
            parent_chunk_count,
            child_chunk_count,
            entity_count: 0,
            claim_count: 0,
            relation_count: 0,
            source_count: 0,
            conflict_count: 0,
            stage_status_count: 0,
            candidate_diagnostic_count: 0,
            community_count: 0,
            community_count_by_level: serde_json::json!({}),
            community_report_count: 0,
            total_chars,
            categories,
            indexed_dense: 0,
            indexed_sparse: chunks.len(),
            stage_details: Vec::new(),
            stage_readiness,
            stage_coverage,
            failed_stage_count: 0,
            stale_stage_count: 0,
            retrieval_ready,
            claims_ready,
            relations_ready,
            graph_ready,
            partial_availability: retrieval_ready
                && (!claims_ready || !relations_ready || !graph_ready),
        })
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Clone, Debug)]
struct KnowledgeStorePaths {
    files_dir: PathBuf,
    documents_file: PathBuf,
    chunks_file: PathBuf,
}

impl KnowledgeStorePaths {
    fn new(root: &Path) -> Self {
        let knowledge_dir = root.join("knowledge");
        Self {
            files_dir: knowledge_dir.join("files"),
            documents_file: knowledge_dir.join("documents.jsonl"),
            chunks_file: knowledge_dir.join("chunks.jsonl"),
        }
    }

    fn ensure_dirs(&self) -> Result<(), WorkerProtocolError> {
        fs::create_dir_all(&self.files_dir).map_err(|error| {
            knowledge_filesystem_error(
                "failed to create knowledge directory",
                serde_json::json!({ "error": error.to_string() }),
            )
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KnowledgeDocument {
    pub id: String,
    pub name: String,
    pub file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub source: String,
    pub file_type: String,
    pub content: String,
    pub created_at: String,
    pub chunk_count: usize,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KnowledgeChunk {
    pub id: String,
    pub doc_id: String,
    pub parent_id: String,
    pub chunk_type: String,
    pub content: String,
    pub retrieval_text: String,
    pub semantic_text: String,
    pub context_content: String,
    pub summary: String,
    pub chunk_index: usize,
    pub child_index: usize,
    pub start_char: usize,
    pub end_char: usize,
    pub line_start: usize,
    pub line_end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    pub created_at: String,
    pub doc_name: String,
    pub file_path: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub section_path: String,
    #[serde(default)]
    pub block_type: String,
}

impl KnowledgeChunk {
    fn parent(
        doc_id: &str,
        doc_name: &str,
        file_path: &str,
        section: &ParentSection,
        index: usize,
        params: &KnowledgeAddDocumentParams,
        created_at: &str,
    ) -> Self {
        let id = format!("chunk_{doc_id}_{index}");
        Self {
            id: id.clone(),
            doc_id: doc_id.to_string(),
            parent_id: id,
            chunk_type: "parent".to_string(),
            content: section.content.clone(),
            retrieval_text: section.content.clone(),
            semantic_text: section.content.clone(),
            context_content: section.content.clone(),
            summary: String::new(),
            chunk_index: index,
            child_index: 0,
            start_char: section.start_char,
            end_char: section.end_char,
            line_start: section.line_start,
            line_end: section.line_end,
            page: None,
            created_at: created_at.to_string(),
            doc_name: doc_name.to_string(),
            file_path: file_path.to_string(),
            category: params.category.clone().unwrap_or_default(),
            tags: params.tags.clone().unwrap_or_default(),
            section_path: section.section_path.clone(),
            block_type: "text".to_string(),
        }
    }

    fn child(
        doc_id: &str,
        doc_name: &str,
        file_path: &str,
        parent_id: &str,
        parent_index: usize,
        child_index: usize,
        line: &SectionLine,
        section_path: &str,
        params: &KnowledgeAddDocumentParams,
        created_at: &str,
    ) -> Self {
        Self {
            id: format!("chunk_{doc_id}_{parent_index}_child_{child_index}"),
            doc_id: doc_id.to_string(),
            parent_id: parent_id.to_string(),
            chunk_type: "child".to_string(),
            content: line.content.clone(),
            retrieval_text: line.content.clone(),
            semantic_text: line.content.clone(),
            context_content: line.content.clone(),
            summary: String::new(),
            chunk_index: parent_index,
            child_index,
            start_char: line.start_char,
            end_char: line.end_char,
            line_start: line.line_number,
            line_end: line.line_number,
            page: None,
            created_at: created_at.to_string(),
            doc_name: doc_name.to_string(),
            file_path: file_path.to_string(),
            category: params.category.clone().unwrap_or_default(),
            tags: params.tags.clone().unwrap_or_default(),
            section_path: section_path.to_string(),
            block_type: "text".to_string(),
        }
    }
}

#[derive(Clone, Debug)]
struct ParentSection {
    content: String,
    start_char: usize,
    end_char: usize,
    line_start: usize,
    line_end: usize,
    section_path: String,
    child_lines: Vec<SectionLine>,
}

#[derive(Clone, Debug)]
struct SectionLine {
    content: String,
    start_char: usize,
    end_char: usize,
    line_number: usize,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeAddDocumentParams {
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub file_type: Option<String>,
    #[serde(default)]
    pub original_path: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeListDocumentsParams {
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeDocumentIdParams {
    pub doc_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeQueryParams {
    pub query: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeDocumentResult {
    pub document: KnowledgeDocument,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeDocumentsResult {
    pub documents: Vec<KnowledgeDocument>,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeGetDocumentResult {
    pub document: KnowledgeDocument,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeDeleteDocumentResult {
    pub deleted: bool,
    pub doc_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeQueryResultSet {
    pub results: Vec<KnowledgeQueryResult>,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeStats {
    pub document_count: usize,
    pub total_documents: usize,
    pub chunk_count: usize,
    pub total_chunks: usize,
    pub parent_chunk_count: usize,
    pub child_chunk_count: usize,
    pub entity_count: usize,
    pub claim_count: usize,
    pub relation_count: usize,
    pub source_count: usize,
    pub conflict_count: usize,
    pub stage_status_count: usize,
    pub candidate_diagnostic_count: usize,
    pub community_count: usize,
    pub community_count_by_level: Value,
    pub community_report_count: usize,
    pub total_chars: usize,
    pub categories: HashMap<String, usize>,
    pub indexed_dense: usize,
    pub indexed_sparse: usize,
    pub stage_details: Vec<Value>,
    pub stage_readiness: Value,
    pub stage_coverage: Value,
    pub failed_stage_count: usize,
    pub stale_stage_count: usize,
    pub retrieval_ready: bool,
    pub claims_ready: bool,
    pub relations_ready: bool,
    pub graph_ready: bool,
    pub partial_availability: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeQueryResult {
    pub id: String,
    pub doc_id: String,
    pub parent_id: String,
    pub chunk_type: String,
    pub content: String,
    pub matched_child_ids: Vec<String>,
    pub matched_child_snippets: Vec<String>,
    pub doc_name: String,
    pub file_path: String,
    pub start_char: usize,
    pub end_char: usize,
    pub line_start: usize,
    pub line_end: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    pub section_path: String,
    pub block_type: String,
    pub score: usize,
    pub rrf_score: usize,
    pub semantic_score: Option<f64>,
    pub bm25_score: usize,
    pub dense_distance: Option<f64>,
    pub dense_rank: Option<usize>,
    pub sparse_rank: usize,
    pub dense_contribution: Option<f64>,
    pub sparse_contribution: usize,
    pub method: String,
    pub retrieval_method: String,
    pub score_metadata: Value,
    pub source_snippets: Vec<Value>,
    pub matched_methods: Vec<String>,
    pub matched_entities: Vec<Value>,
    pub matched_claims: Vec<Value>,
    pub matched_claim_evidence: Vec<Value>,
    pub matched_relations: Vec<Value>,
    pub matched_relation_evidence: Vec<Value>,
    pub matched_communities: Vec<Value>,
    pub conflict_metadata: Vec<Value>,
    pub projection_metadata: Vec<Value>,
}

impl KnowledgeQueryResult {
    fn from_chunk(chunk: KnowledgeChunk, score: usize) -> Self {
        Self {
            id: chunk.id,
            doc_id: chunk.doc_id,
            parent_id: chunk.parent_id,
            chunk_type: chunk.chunk_type,
            content: chunk.content,
            matched_child_ids: Vec::new(),
            matched_child_snippets: Vec::new(),
            doc_name: chunk.doc_name,
            file_path: chunk.file_path,
            start_char: chunk.start_char,
            end_char: chunk.end_char,
            line_start: chunk.line_start,
            line_end: chunk.line_end,
            page: chunk.page,
            section_path: chunk.section_path,
            block_type: chunk.block_type,
            score,
            rrf_score: score,
            semantic_score: None,
            bm25_score: score,
            dense_distance: None,
            dense_rank: None,
            sparse_rank: 0,
            dense_contribution: None,
            sparse_contribution: score,
            method: "sparse".to_string(),
            retrieval_method: "sparse".to_string(),
            score_metadata: serde_json::json!({}),
            source_snippets: Vec::new(),
            matched_methods: Vec::new(),
            matched_entities: Vec::new(),
            matched_claims: Vec::new(),
            matched_claim_evidence: Vec::new(),
            matched_relations: Vec::new(),
            matched_relation_evidence: Vec::new(),
            matched_communities: Vec::new(),
            conflict_metadata: Vec::new(),
            projection_metadata: Vec::new(),
        }
    }
}

fn find_document(
    root: &Path,
    doc_id: &str,
) -> Result<Option<KnowledgeDocument>, WorkerProtocolError> {
    Ok(
        read_jsonl::<KnowledgeDocument>(&KnowledgeStorePaths::new(root).documents_file)?
            .into_iter()
            .find(|document| document.id == doc_id),
    )
}

fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<(), WorkerProtocolError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            knowledge_filesystem_error(
                "failed to create knowledge index directory",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            knowledge_filesystem_error(
                "failed to open knowledge index",
                serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
            )
        })?;
    let line = serde_json::to_string(value).map_err(|error| {
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "failed to serialize knowledge record",
            serde_json::json!({ "error": error.to_string() }),
            false,
            WorkerProtocolErrorSource::RustCore,
        )
    })?;
    writeln!(file, "{line}").map_err(|error| {
        knowledge_filesystem_error(
            "failed to write knowledge index",
            serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
        )
    })
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, WorkerProtocolError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path).map_err(|error| {
        knowledge_filesystem_error(
            "failed to open knowledge index",
            serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
        )
    })?;
    let mut records = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| {
            knowledge_filesystem_error(
                "failed to read knowledge index",
                serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        records.push(serde_json::from_str(&line).map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "failed to parse knowledge index record",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "line": index + 1,
                    "error": error.to_string()
                }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?);
    }
    Ok(records)
}

fn write_jsonl<T: Serialize>(path: &Path, records: &[T]) -> Result<(), WorkerProtocolError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            knowledge_filesystem_error(
                "failed to create knowledge index directory",
                serde_json::json!({ "error": error.to_string() }),
            )
        })?;
    }
    let mut file = File::create(path).map_err(|error| {
        knowledge_filesystem_error(
            "failed to rewrite knowledge index",
            serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
        )
    })?;
    for record in records {
        let line = serde_json::to_string(record).map_err(|error| {
            WorkerProtocolError::new(
                WorkerProtocolErrorCode::InvalidProtocol,
                "failed to serialize knowledge record",
                serde_json::json!({ "error": error.to_string() }),
                false,
                WorkerProtocolErrorSource::RustCore,
            )
        })?;
        writeln!(file, "{line}").map_err(|error| {
            knowledge_filesystem_error(
                "failed to write knowledge index",
                serde_json::json!({ "path": path.display().to_string(), "error": error.to_string() }),
            )
        })?;
    }
    Ok(())
}

fn make_document_id(name: &str, content: &str, created_at: &str) -> String {
    let mut hasher = DefaultHasher::new();
    created_at.hash(&mut hasher);
    name.hash(&mut hasher);
    content.hash(&mut hasher);
    format!("doc_{:08x}", (hasher.finish() & 0xffff_ffff) as u32)
}

fn build_document_chunks(
    doc_id: &str,
    doc_name: &str,
    file_path: &str,
    sections: &[ParentSection],
    params: &KnowledgeAddDocumentParams,
    created_at: &str,
) -> Vec<KnowledgeChunk> {
    let mut chunks = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        let parent = KnowledgeChunk::parent(
            doc_id, doc_name, file_path, section, index, params, created_at,
        );
        let parent_id = parent.id.clone();
        chunks.push(parent);
        if sections.len() <= 1 {
            continue;
        }
        for (child_index, line) in section.child_lines.iter().enumerate() {
            chunks.push(KnowledgeChunk::child(
                doc_id,
                doc_name,
                file_path,
                &parent_id,
                index,
                child_index,
                line,
                &section.section_path,
                params,
                created_at,
            ));
        }
    }
    chunks
}

fn split_parent_sections(content: &str) -> Vec<ParentSection> {
    let line_spans = content_line_spans(content);
    if line_spans.is_empty() {
        return vec![ParentSection {
            content: content.to_string(),
            start_char: 0,
            end_char: content.chars().count(),
            line_start: 1,
            line_end: 1,
            section_path: String::new(),
            child_lines: Vec::new(),
        }];
    }
    let mut sections = Vec::new();
    let mut current_start = 0usize;
    let mut current_line_start = 1usize;
    let mut current_section_path = first_markdown_heading(content).unwrap_or_default();
    let mut current_child_lines = Vec::new();
    for (index, line) in line_spans.iter().enumerate() {
        if line.is_heading && index != current_start {
            sections.push(parent_section_from_lines(
                &line_spans[current_start..index],
                current_line_start,
                current_section_path,
                current_child_lines,
            ));
            current_start = index;
            current_line_start = line.line_number;
            current_section_path = line.heading.clone().unwrap_or_default();
            current_child_lines = Vec::new();
        }
        if !line.is_heading && !line.trimmed.is_empty() {
            current_child_lines.push(SectionLine {
                content: line.trimmed.clone(),
                start_char: line.start_char,
                end_char: line.end_char,
                line_number: line.line_number,
            });
        }
    }
    sections.push(parent_section_from_lines(
        &line_spans[current_start..],
        current_line_start,
        current_section_path,
        current_child_lines,
    ));
    sections
}

fn parent_section_from_lines(
    lines: &[LineSpan],
    line_start: usize,
    section_path: String,
    child_lines: Vec<SectionLine>,
) -> ParentSection {
    let content = lines
        .iter()
        .map(|line| line.original.as_str())
        .collect::<Vec<_>>()
        .join("");
    let start_char = lines.first().map(|line| line.start_char).unwrap_or(0);
    let end_char = lines.last().map(|line| line.end_char).unwrap_or(start_char);
    let line_end = lines
        .last()
        .map(|line| line.line_number)
        .unwrap_or(line_start);
    ParentSection {
        content,
        start_char,
        end_char,
        line_start,
        line_end,
        section_path,
        child_lines,
    }
}

#[derive(Clone, Debug)]
struct LineSpan {
    original: String,
    trimmed: String,
    start_char: usize,
    end_char: usize,
    line_number: usize,
    is_heading: bool,
    heading: Option<String>,
}

fn content_line_spans(content: &str) -> Vec<LineSpan> {
    let mut spans = Vec::new();
    let mut offset = 0usize;
    for (index, line) in content.split_inclusive('\n').enumerate() {
        let line_without_newline = line.trim_end_matches(['\r', '\n']);
        let trimmed = line_without_newline.trim().to_string();
        let heading = markdown_heading_text(&trimmed);
        let end_char = offset + line.chars().count();
        spans.push(LineSpan {
            original: line.to_string(),
            trimmed,
            start_char: offset,
            end_char,
            line_number: index + 1,
            is_heading: heading.is_some(),
            heading,
        });
        offset = end_char;
    }
    if offset < content.chars().count() {
        let remainder = &content[offset..];
        let trimmed = remainder.trim().to_string();
        let heading = markdown_heading_text(&trimmed);
        spans.push(LineSpan {
            original: remainder.to_string(),
            trimmed,
            start_char: offset,
            end_char: content.chars().count(),
            line_number: spans.len() + 1,
            is_heading: heading.is_some(),
            heading,
        });
    }
    spans
}

fn now_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

fn first_markdown_heading(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|line| markdown_heading_text(line.trim()))
}

fn markdown_heading_text(trimmed: &str) -> Option<String> {
    let title = trimmed.trim_start_matches('#').trim();
    if trimmed.starts_with('#') && !title.is_empty() {
        Some(title.to_string())
    } else {
        None
    }
}

fn knowledge_query_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn knowledge_score(content: &str, terms: &[String]) -> usize {
    let lower = content.to_ascii_lowercase();
    terms
        .iter()
        .filter(|term| lower.contains(term.as_str()))
        .count()
}

fn invalid_knowledge_request(message: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({}),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn unknown_knowledge_document(doc_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "knowledge document not found",
        serde_json::json!({ "doc_id": doc_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn knowledge_filesystem_error(message: &str, details: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        true,
        WorkerProtocolErrorSource::RustCore,
    )
}
