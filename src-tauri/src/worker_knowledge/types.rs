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
    pub section_id: String,
    #[serde(default)]
    pub section_title: String,
    #[serde(default)]
    pub parent_section_id: String,
    #[serde(default)]
    pub section_ordinal: usize,
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
            section_id: section_id(doc_id, index),
            section_title: section.section_title.clone(),
            parent_section_id: section
                .parent_section_index
                .map(|parent_index| section_id(doc_id, parent_index))
                .unwrap_or_else(|| "section-root".to_string()),
            section_ordinal: section.section_ordinal,
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
        section_title: &str,
        parent_section_id: &str,
        section_ordinal: usize,
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
            section_id: section_id(doc_id, parent_index),
            section_title: section_title.to_string(),
            parent_section_id: parent_section_id.to_string(),
            section_ordinal,
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
    section_title: String,
    parent_section_index: Option<usize>,
    section_ordinal: usize,
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
pub struct KnowledgeStartIndexJobParams {
    pub doc_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeJobIdParams {
    pub job_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeRebuildIndexParams {
    #[serde(default, rename = "type")]
    pub rebuild_type: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeGraphParams {
    #[serde(default)]
    pub doc_id: Option<String>,
    #[serde(default)]
    pub graph_type: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub edge_limit: Option<usize>,
    #[serde(default)]
    pub min_confidence: Option<f64>,
    #[serde(default)]
    pub include_orphans: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeEntityGraphExtractionParams {
    pub doc_id: String,
    #[serde(default)]
    pub doc_name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub token_estimate: Value,
    #[serde(default)]
    pub entities: Vec<KnowledgeExtractedEntity>,
    #[serde(default)]
    pub relations: Vec<KnowledgeExtractedRelation>,
    #[serde(default)]
    pub diagnostics: Value,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeExtractedEntity {
    pub name: String,
    #[serde(default, rename = "type")]
    pub entity_type: String,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub evidence: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeExtractedRelation {
    pub source: String,
    pub target: String,
    pub predicate: String,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub evidence: Vec<Value>,
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
    #[serde(default)]
    pub include_structure_context: Option<bool>,
    #[serde(default)]
    pub include_graph_context: Option<bool>,
    #[serde(default)]
    pub graph_relation_filters: Option<Vec<String>>,
    #[serde(default)]
    pub graph_max_hops: Option<usize>,
    #[serde(default)]
    pub graph_min_confidence: Option<f64>,
    #[serde(default)]
    pub graph_max_added_chunks: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KnowledgeContextParams {
    pub current_message: String,
    #[serde(default)]
    pub session_key: Option<String>,
    #[serde(default)]
    pub max_chunks: Option<usize>,
    #[serde(default)]
    pub use_persistent_knowledge: Option<bool>,
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
pub struct KnowledgeDocumentTreeResult {
    pub object: String,
    pub doc_id: String,
    pub root: KnowledgeDocumentTreeRoot,
    pub sections: Vec<KnowledgeDocumentTreeSection>,
    pub section_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeDocumentTreeRoot {
    pub id: String,
    pub children: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeDocumentTreeSection {
    pub id: String,
    pub doc_id: String,
    pub chunk_id: String,
    pub title: String,
    pub section_path: String,
    pub parent_id: String,
    pub children: Vec<String>,
    pub ordinal: usize,
    pub line_start: usize,
    pub line_end: usize,
    pub chunk_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeDeleteDocumentResult {
    pub deleted: bool,
    pub doc_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeQueryResultSet {
    pub results: Vec<KnowledgeQueryResult>,
    pub retrieval_plan: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeContextResult {
    pub context: String,
    pub persistent_results: Vec<KnowledgeQueryResult>,
    pub session_results: Vec<Value>,
    pub references: Vec<Value>,
    pub retrieval_plan: Value,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KnowledgeJob {
    pub id: String,
    #[serde(default)]
    pub doc_id: String,
    pub name: String,
    pub status: String,
    pub stage: String,
    pub message: String,
    pub processed: usize,
    pub total: usize,
    #[serde(default)]
    pub error: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: String,
    #[serde(default)]
    pub stage_details: Vec<Value>,
    pub failed_stage_count: usize,
    pub stale_stage_count: usize,
    pub retrieval_ready: bool,
    pub graph_ready: bool,
    pub partial_availability: bool,
    #[serde(default)]
    pub result: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KnowledgeGraphNode {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub doc_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<Value>,
    #[serde(default)]
    pub attributes: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KnowledgeGraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub label: String,
    #[serde(default)]
    pub doc_id: String,
    #[serde(default)]
    pub evidence: Vec<Value>,
    #[serde(default)]
    pub attributes: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeGraphResult {
    pub object: String,
    pub graph_type: String,
    pub nodes: Vec<KnowledgeGraphNode>,
    pub edges: Vec<KnowledgeGraphEdge>,
    pub communities: Vec<Value>,
    pub reports: Vec<Value>,
    pub claims: Vec<Value>,
    pub conflicts: Vec<Value>,
    pub stats: Value,
    pub readiness: Value,
    pub stage_readiness: Value,
    pub stage_coverage: Value,
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
    pub matched_child_section_paths: Vec<String>,
    pub doc_name: String,
    pub file_path: String,
    pub start_char: usize,
    pub end_char: usize,
    pub line_start: usize,
    pub line_end: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    pub section_path: String,
    pub section_id: String,
    pub section_title: String,
    pub parent_section_id: String,
    pub section_ordinal: usize,
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
    pub structure_context: Value,
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
            matched_child_section_paths: Vec::new(),
            doc_name: chunk.doc_name,
            file_path: chunk.file_path,
            start_char: chunk.start_char,
            end_char: chunk.end_char,
            line_start: chunk.line_start,
            line_end: chunk.line_end,
            page: chunk.page,
            section_path: chunk.section_path,
            section_id: chunk.section_id,
            section_title: chunk.section_title,
            parent_section_id: chunk.parent_section_id,
            section_ordinal: chunk.section_ordinal,
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
            structure_context: serde_json::json!({}),
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
