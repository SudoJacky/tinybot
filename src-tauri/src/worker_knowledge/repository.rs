use super::*;

#[derive(Clone, Debug)]
pub struct WorkerKnowledgeRpc {
    root: PathBuf,
    policy: CapabilityPolicy,
}

pub(super) const CONTROLLED_RELATION_PREDICATES: &[&str] = &[
    "depends_on",
    "causes",
    "implements",
    "configures",
    "mentions",
    "conflicts_with",
    "supports",
];

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
        if !is_text_like_knowledge_file_type(&file_type) {
            return Err(invalid_knowledge_request(
                "file_type must be txt, md, json, or csv",
            ));
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
        run_knowledge_jsonl_update(&[&store.documents_file, &store.chunks_file], || {
            append_jsonl(&store.documents_file, &document)?;
            for chunk in &chunks {
                append_jsonl(&store.chunks_file, chunk)?;
            }
            Ok(())
        })?;
        refresh_document_graph(&self.root)?;
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

    pub fn document_tree(
        &self,
        params: KnowledgeDocumentIdParams,
    ) -> Result<KnowledgeDocumentTreeResult, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        if find_document(&self.root, &params.doc_id)?.is_none() {
            return Err(unknown_knowledge_document(&params.doc_id));
        }
        let chunks =
            read_jsonl::<KnowledgeChunk>(&KnowledgeStorePaths::new(&self.root).chunks_file)?;
        let parent_chunks = chunks
            .into_iter()
            .filter(|chunk| chunk.doc_id == params.doc_id && chunk.chunk_type == "parent")
            .collect::<Vec<_>>();
        Ok(build_knowledge_document_tree(&params.doc_id, parent_chunks))
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
        let mut chunks = read_jsonl::<KnowledgeChunk>(&store.chunks_file)?;
        chunks.retain(|chunk| chunk.doc_id != params.doc_id);
        run_knowledge_jsonl_update(&[&store.documents_file, &store.chunks_file], || {
            write_jsonl(&store.documents_file, &documents)?;
            write_jsonl(&store.chunks_file, &chunks)
        })?;
        purge_entity_graph_records(&store, &params.doc_id)?;
        let _ = fs::remove_file(self.root.join(&document.file_path));
        refresh_document_graph(&self.root)?;
        Ok(KnowledgeDeleteDocumentResult {
            deleted: true,
            doc_id: params.doc_id,
        })
    }

    pub fn start_index_job(
        &self,
        params: KnowledgeStartIndexJobParams,
    ) -> Result<KnowledgeJob, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeWrite)?;
        let Some(document) = find_document(&self.root, &params.doc_id)? else {
            return Err(unknown_knowledge_document(&params.doc_id));
        };
        let job = completed_retrieval_job(&document);
        upsert_knowledge_job(&self.root, &job)?;
        Ok(job)
    }

    pub fn get_job(
        &self,
        params: KnowledgeJobIdParams,
    ) -> Result<KnowledgeJob, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let jobs = read_jsonl::<KnowledgeJob>(&KnowledgeStorePaths::new(&self.root).jobs_file)?;
        jobs.into_iter()
            .find(|job| job.id == params.job_id)
            .ok_or_else(|| {
                WorkerProtocolError::new(
                    WorkerProtocolErrorCode::InvalidProtocol,
                    "knowledge job not found",
                    serde_json::json!({ "job_id": params.job_id }),
                    false,
                    WorkerProtocolErrorSource::RustCore,
                )
            })
    }

    pub fn rebuild_index(
        &self,
        params: KnowledgeRebuildIndexParams,
    ) -> Result<KnowledgeJob, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeWrite)?;
        let rebuild_type = params.rebuild_type.unwrap_or_else(|| "bm25".to_string());
        if !matches!(rebuild_type.as_str(), "bm25" | "semantic" | "tree" | "all") {
            return Err(invalid_knowledge_request(
                "type must be bm25, semantic, tree, or all",
            ));
        }
        let stats = self.stats()?;
        let result = match rebuild_type.as_str() {
            "bm25" => {
                let result = knowledge_bm25_rebuild_result(&self.root)?;
                refresh_document_graph(&self.root)?;
                result
            }
            "tree" => knowledge_tree_rebuild_result(&self.root)?,
            "semantic" => knowledge_semantic_unavailable_result(),
            "all" => {
                let result = serde_json::json!({
                    "bm25": knowledge_bm25_rebuild_result(&self.root)?,
                    "tree": knowledge_tree_rebuild_result(&self.root)?,
                    "semantic": knowledge_semantic_unavailable_result()
                });
                refresh_document_graph(&self.root)?;
                result
            }
            _ => unreachable!(),
        };
        let job = completed_rebuild_job(&rebuild_type, &stats, result);
        upsert_knowledge_job(&self.root, &job)?;
        Ok(job)
    }

    pub fn document_graph(
        &self,
        params: KnowledgeGraphParams,
    ) -> Result<KnowledgeGraphResult, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        if params.graph_type.as_deref() == Some("entity") {
            return self.entity_graph(params);
        }
        let store = KnowledgeStorePaths::new(&self.root);
        let mut nodes = read_jsonl::<KnowledgeGraphNode>(&store.document_graph_nodes_file)?;
        let mut edges = read_jsonl::<KnowledgeGraphEdge>(&store.document_graph_edges_file)?;
        if let Some(doc_id) = params.doc_id.as_deref().filter(|value| !value.is_empty()) {
            let document_node_id = document_graph_node_id(doc_id);
            edges.retain(|edge| edge.doc_id == doc_id || edge.source == document_node_id);
            let connected_node_ids = edges
                .iter()
                .flat_map(|edge| [edge.source.clone(), edge.target.clone()])
                .collect::<HashSet<_>>();
            nodes.retain(|node| connected_node_ids.contains(&node.id) || node.doc_id == doc_id);
        }
        if !params.include_orphans.unwrap_or(false) {
            let connected_node_ids = edges
                .iter()
                .flat_map(|edge| [edge.source.clone(), edge.target.clone()])
                .collect::<HashSet<_>>();
            nodes.retain(|node| connected_node_ids.contains(&node.id));
        }
        nodes.sort_by(|left, right| {
            left.node_type
                .cmp(&right.node_type)
                .then_with(|| left.label.cmp(&right.label))
        });
        edges.sort_by(|left, right| {
            left.edge_type
                .cmp(&right.edge_type)
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| left.target.cmp(&right.target))
        });
        let edge_limit = params.edge_limit.unwrap_or(160).clamp(1, 1000);
        edges.truncate(edge_limit);
        let connected_node_ids = edges
            .iter()
            .flat_map(|edge| [edge.source.clone(), edge.target.clone()])
            .collect::<HashSet<_>>();
        if !params.include_orphans.unwrap_or(false) {
            nodes.retain(|node| connected_node_ids.contains(&node.id));
        }
        let limit = params.limit.unwrap_or(80).clamp(1, 500);
        nodes.truncate(limit);
        let readiness = serde_json::json!({
            "retrieval_ready": !nodes.is_empty(),
            "claims_ready": false,
            "relations_ready": false,
            "graph_ready": false,
            "partial_availability": !nodes.is_empty(),
            "document_graph_ready": !nodes.is_empty(),
            "entity_graph_ready": false
        });
        let stats = serde_json::json!({
            "node_count": nodes.len(),
            "edge_count": edges.len(),
            "total_entities": 0,
            "total_relations": 0,
            "total_mentions": 0,
            "doc_id": params.doc_id.unwrap_or_default(),
            "limit": limit,
            "edge_limit": edge_limit,
            "min_confidence": params.min_confidence.unwrap_or(0.0),
            "include_orphans": params.include_orphans.unwrap_or(false)
        });
        Ok(KnowledgeGraphResult {
            object: "knowledge_graph".to_string(),
            graph_type: "document".to_string(),
            nodes,
            edges,
            communities: Vec::new(),
            reports: Vec::new(),
            claims: Vec::new(),
            conflicts: Vec::new(),
            stats,
            readiness,
            stage_readiness: serde_json::json!({}),
            stage_coverage: serde_json::json!({}),
        })
    }

    pub fn save_entity_graph_extraction(
        &self,
        params: KnowledgeEntityGraphExtractionParams,
    ) -> Result<KnowledgeJob, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeWrite)?;
        let Some(document) = find_document(&self.root, &params.doc_id)? else {
            return Err(unknown_knowledge_document(&params.doc_id));
        };
        validate_entity_graph_relations(&document, &params)?;
        let store = KnowledgeStorePaths::new(&self.root);
        let source_hash = document_content_hash(&document);
        let mut nodes = read_jsonl::<KnowledgeGraphNode>(&store.entity_graph_nodes_file)?;
        let mut edges = read_jsonl::<KnowledgeGraphEdge>(&store.entity_graph_edges_file)?;
        let mut evidence_records = read_jsonl::<Value>(&store.entity_graph_evidence_file)?;
        nodes.retain(|node| node.doc_id != document.id);
        edges.retain(|edge| edge.doc_id != document.id);
        evidence_records
            .retain(|item| value_string(item, "doc_id").as_deref() != Some(document.id.as_str()));

        let mut entity_ids = HashMap::new();
        let mut entity_node_indexes = HashMap::new();
        for entity in params
            .entities
            .iter()
            .filter(|entity| !entity.name.trim().is_empty())
        {
            let id = entity_graph_entity_id(&document.id, &entity.name);
            entity_ids.insert(normalize_graph_reference_key(&entity.name), id.clone());
            let evidence_ids = entity
                .evidence
                .iter()
                .enumerate()
                .map(|(index, evidence)| {
                    persist_entity_graph_evidence(
                        &mut evidence_records,
                        &document,
                        &id,
                        "entity",
                        index,
                        evidence,
                    )
                })
                .collect::<Vec<_>>();
            if let Some(index) = entity_node_indexes.get(&id).copied() {
                merge_entity_graph_node(&mut nodes[index], entity, evidence_ids);
            } else {
                let evidence_status = entity_graph_evidence_status(&evidence_ids);
                nodes.push(KnowledgeGraphNode {
                    id: id.clone(),
                    label: entity.name.trim().to_string(),
                    node_type: "entity".to_string(),
                    doc_id: document.id.clone(),
                    evidence: Vec::new(),
                    attributes: serde_json::json!({
                        "entity_type": normalize_entity_graph_type(&entity.entity_type),
                        "aliases": [],
                        "confidence": entity.confidence,
                        "source_hash": source_hash,
                        "stale": false,
                        "evidence_status": evidence_status,
                        "evidence_ids": evidence_ids
                    }),
                });
                entity_node_indexes.insert(id, nodes.len() - 1);
            }
        }
        for relation in params.relations.iter().filter(|relation| {
            !relation.source.trim().is_empty()
                && !relation.target.trim().is_empty()
                && !relation.predicate.trim().is_empty()
        }) {
            let source = entity_ids
                .get(&normalize_graph_reference_key(&relation.source))
                .cloned()
                .unwrap_or_else(|| {
                    let id = entity_graph_entity_id(&document.id, &relation.source);
                    nodes.push(entity_graph_stub_node(
                        &document,
                        &relation.source,
                        &id,
                        &source_hash,
                    ));
                    id
                });
            let target = entity_ids
                .get(&normalize_graph_reference_key(&relation.target))
                .cloned()
                .unwrap_or_else(|| {
                    let id = entity_graph_entity_id(&document.id, &relation.target);
                    nodes.push(entity_graph_stub_node(
                        &document,
                        &relation.target,
                        &id,
                        &source_hash,
                    ));
                    id
                });
            let edge_id = document_graph_edge_id(&source, &relation.predicate, &target);
            let evidence = relation
                .evidence
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    persist_entity_graph_evidence(
                        &mut evidence_records,
                        &document,
                        &edge_id,
                        "relation",
                        index,
                        item,
                    )
                })
                .collect::<Vec<_>>();
            let edge_evidence = evidence
                .iter()
                .filter_map(|id| {
                    evidence_records
                        .iter()
                        .find(|item| value_string(item, "id").as_deref() == Some(id.as_str()))
                        .cloned()
                })
                .collect::<Vec<_>>();
            edges.push(KnowledgeGraphEdge {
                id: edge_id,
                source,
                target,
                edge_type: relation.predicate.trim().to_string(),
                label: relation.predicate.trim().to_string(),
                doc_id: document.id.clone(),
                evidence: edge_evidence,
                attributes: serde_json::json!({
                    "doc_id": document.id,
                    "doc_name": document.name,
                    "confidence": relation.confidence,
                    "source_hash": source_hash,
                    "stale": false,
                    "evidence_ids": evidence
                }),
            });
        }
        run_knowledge_jsonl_update(
            &[
                &store.entity_graph_nodes_file,
                &store.entity_graph_edges_file,
                &store.entity_graph_evidence_file,
            ],
            || {
                write_jsonl(&store.entity_graph_nodes_file, &nodes)?;
                write_jsonl(&store.entity_graph_edges_file, &edges)?;
                write_jsonl(&store.entity_graph_evidence_file, &evidence_records)
            },
        )?;
        let job = completed_entity_graph_job(&document, &params, &source_hash);
        upsert_knowledge_job(&self.root, &job)?;
        Ok(job)
    }

    fn entity_graph(
        &self,
        params: KnowledgeGraphParams,
    ) -> Result<KnowledgeGraphResult, WorkerProtocolError> {
        let store = KnowledgeStorePaths::new(&self.root);
        let mut nodes = read_jsonl::<KnowledgeGraphNode>(&store.entity_graph_nodes_file)?;
        let mut edges = read_jsonl::<KnowledgeGraphEdge>(&store.entity_graph_edges_file)?;
        let evidence_records = read_jsonl::<Value>(&store.entity_graph_evidence_file)?;
        let requested_doc_id = params.doc_id.clone().unwrap_or_default();
        if let Some(doc_id) = params.doc_id.as_deref().filter(|value| !value.is_empty()) {
            nodes.retain(|node| node.doc_id == doc_id);
            edges.retain(|edge| edge.doc_id == doc_id);
        }
        let min_confidence = params.min_confidence.unwrap_or(0.0).clamp(0.0, 1.0);
        nodes.retain(|node| graph_record_confidence(&node.attributes) >= min_confidence);
        let retained_node_ids = nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<HashSet<_>>();
        edges.retain(|edge| {
            graph_record_confidence(&edge.attributes) >= min_confidence
                && retained_node_ids.contains(&edge.source)
                && retained_node_ids.contains(&edge.target)
        });
        attach_entity_graph_node_evidence(&mut nodes, &evidence_records);
        let edge_limit = params.edge_limit.unwrap_or(160).clamp(1, 1000);
        edges.truncate(edge_limit);
        let connected_node_ids = edges
            .iter()
            .flat_map(|edge| [edge.source.clone(), edge.target.clone()])
            .collect::<HashSet<_>>();
        if !params.include_orphans.unwrap_or(false) {
            nodes.retain(|node| connected_node_ids.contains(&node.id));
        }
        let limit = params.limit.unwrap_or(80).clamp(1, 500);
        nodes.truncate(limit);
        let stale = mark_entity_graph_staleness(&self.root, &mut nodes, &mut edges)?;
        let conflicts = entity_graph_conflicts(&nodes, &edges);
        let verified_node_count = nodes
            .iter()
            .filter(|node| entity_graph_node_evidence_status(&node.attributes) == "verified")
            .count();
        let unverified_node_count = nodes.len().saturating_sub(verified_node_count);
        let entity_ready = !nodes.is_empty() || !edges.is_empty();
        Ok(KnowledgeGraphResult {
            object: "knowledge_graph".to_string(),
            graph_type: "entity".to_string(),
            stats: serde_json::json!({
                "node_count": nodes.len(),
                "edge_count": edges.len(),
                "total_entities": nodes.len(),
                "total_relations": edges.len(),
                "total_mentions": edges.iter().map(|edge| edge.evidence.len()).sum::<usize>(),
                "conflict_count": conflicts.len(),
                "verified_node_count": verified_node_count,
                "unverified_node_count": unverified_node_count,
                "stale_count": stale.node_count + stale.edge_count,
                "stale_node_count": stale.node_count,
                "stale_edge_count": stale.edge_count,
                "doc_id": requested_doc_id,
                "limit": limit,
                "edge_limit": edge_limit,
                "min_confidence": min_confidence,
                "include_orphans": params.include_orphans.unwrap_or(false)
            }),
            readiness: serde_json::json!({
                "retrieval_ready": entity_ready,
                "claims_ready": false,
                "relations_ready": entity_ready,
                "graph_ready": entity_ready,
                "partial_availability": entity_ready,
                "document_graph_ready": false,
                "entity_graph_ready": entity_ready,
                "entity_graph_stale": stale.node_count + stale.edge_count > 0
            }),
            nodes,
            edges,
            communities: Vec::new(),
            reports: Vec::new(),
            claims: Vec::new(),
            conflicts,
            stage_readiness: serde_json::json!({}),
            stage_coverage: serde_json::json!({}),
        })
    }

    pub fn query(
        &self,
        params: KnowledgeQueryParams,
    ) -> Result<KnowledgeQueryResultSet, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let limit = params.limit.unwrap_or(5).min(20);
        let retrieval_plan = build_knowledge_retrieval_plan(&params, limit);
        if limit == 0 {
            return Ok(KnowledgeQueryResultSet {
                results: Vec::new(),
                retrieval_plan,
            });
        }
        let query_terms = knowledge_query_terms(&params.query);
        if query_terms.is_empty() {
            return Err(invalid_knowledge_request(
                "query must contain at least one searchable term",
            ));
        }
        let include_structure_context =
            knowledge_query_should_include_structure_context(&params, &query_terms);
        let include_graph_context =
            knowledge_query_should_include_graph_context(&params, &query_terms);
        let chunks =
            read_jsonl::<KnowledgeChunk>(&KnowledgeStorePaths::new(&self.root).chunks_file)?;
        let parents: HashMap<String, KnowledgeChunk> = chunks
            .iter()
            .filter(|chunk| chunk.chunk_type == "parent")
            .map(|chunk| (chunk.id.clone(), chunk.clone()))
            .collect();
        let mut results_by_parent: HashMap<String, KnowledgeQueryResult> = HashMap::new();
        for chunk in chunks {
            if !knowledge_chunk_matches_query_filters(&chunk, &params) {
                continue;
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
                if !entry
                    .matched_child_section_paths
                    .contains(&chunk.section_path)
                {
                    entry
                        .matched_child_section_paths
                        .push(chunk.section_path.clone());
                }
            }
        }
        if include_graph_context {
            let store = KnowledgeStorePaths::new(&self.root);
            let entity_nodes = read_jsonl::<KnowledgeGraphNode>(&store.entity_graph_nodes_file)?;
            let entity_edges = read_jsonl::<KnowledgeGraphEdge>(&store.entity_graph_edges_file)?;
            let entity_evidence = read_jsonl::<Value>(&store.entity_graph_evidence_file)?;
            expand_query_with_entity_graph(
                &mut results_by_parent,
                &parents,
                &entity_nodes,
                &entity_edges,
                &entity_evidence,
                &query_terms,
                &params,
            );
        }
        let mut results: Vec<KnowledgeQueryResult> = results_by_parent.into_values().collect();
        for result in &mut results {
            apply_knowledge_evidence_quality_bonus(result);
        }
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
        for result in &mut results {
            if include_structure_context {
                populate_knowledge_structure_context(result, &parents);
            }
            populate_knowledge_score_metadata(result);
        }
        Ok(KnowledgeQueryResultSet {
            results,
            retrieval_plan,
        })
    }

    pub fn context(
        &self,
        params: KnowledgeContextParams,
    ) -> Result<KnowledgeContextResult, WorkerProtocolError> {
        self.context_with_session_files(params, Vec::new())
    }

    pub fn context_with_session_files(
        &self,
        params: KnowledgeContextParams,
        session_files: Vec<Value>,
    ) -> Result<KnowledgeContextResult, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let max_chunks = params.max_chunks.unwrap_or(5).min(20);
        if max_chunks == 0 {
            return Ok(empty_knowledge_context());
        }
        let (persistent_results, retrieval_plan) = if params.use_persistent_knowledge == Some(false)
        {
            (Vec::new(), serde_json::json!({}))
        } else {
            let query_result = self.query(KnowledgeQueryParams {
                query: params.current_message.clone(),
                category: None,
                tags: None,
                limit: Some(max_chunks),
                include_structure_context: None,
                include_graph_context: None,
                graph_relation_filters: None,
                graph_max_hops: None,
                graph_min_confidence: None,
                graph_max_added_chunks: None,
            })?;
            (query_result.results, query_result.retrieval_plan)
        };
        let session_results = session_temporary_context_results(
            params.session_key.as_deref(),
            &session_files,
            &params.current_message,
            max_chunks,
        );
        let context = format_knowledge_context(&persistent_results, &session_results);
        let mut references: Vec<Value> = persistent_results
            .iter()
            .map(knowledge_reference_metadata)
            .collect();
        references.extend(
            session_results
                .iter()
                .map(knowledge_session_reference_metadata),
        );
        Ok(KnowledgeContextResult {
            context,
            persistent_results,
            session_results,
            references,
            retrieval_plan,
        })
    }

    pub fn stats(&self) -> Result<KnowledgeStats, WorkerProtocolError> {
        self.require(WorkerCapability::KnowledgeRead)?;
        let store = KnowledgeStorePaths::new(&self.root);
        let documents = read_jsonl::<KnowledgeDocument>(&store.documents_file)?;
        let chunks = read_jsonl::<KnowledgeChunk>(&store.chunks_file)?;
        let mut entity_nodes = read_jsonl::<KnowledgeGraphNode>(&store.entity_graph_nodes_file)?;
        let mut entity_edges = read_jsonl::<KnowledgeGraphEdge>(&store.entity_graph_edges_file)?;
        let entity_evidence = read_jsonl::<Value>(&store.entity_graph_evidence_file)?;
        let graph_stale =
            mark_entity_graph_staleness(&self.root, &mut entity_nodes, &mut entity_edges)?;
        let graph_stale_count = graph_stale.node_count + graph_stale.edge_count;
        let conflict_count = entity_edges
            .iter()
            .filter(|edge| entity_graph_edge_is_conflict(edge))
            .count();
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
        let tree_ready = parent_chunk_count > 0;
        let claims_ready = false;
        let relations_ready = !entity_edges.is_empty();
        let graph_ready = !entity_nodes.is_empty() || !entity_edges.is_empty();
        let sparse_stage = serde_json::json!({
            "ready": retrieval_ready,
            "status": if retrieval_ready { "ready" } else { "empty" },
            "processed": chunks.len(),
            "total": chunks.len(),
            "failed": 0,
            "stale": 0
        });
        let graph_projection_status = if graph_stale_count > 0 {
            "stale"
        } else if graph_ready {
            "ready"
        } else {
            "not_configured"
        };
        let stage_readiness = serde_json::json!({
            "sparse_indexing": sparse_stage,
            "tree_index": { "ready": tree_ready, "status": if tree_ready { "ready" } else { "empty" }, "processed": parent_chunk_count, "total": parent_chunk_count, "failed": 0, "stale": 0, "skipped": 0 },
            "dense_indexing": { "ready": false, "status": "not_configured", "processed": 0, "total": 0, "failed": 0, "stale": 0, "skipped": parent_chunk_count },
            "claim_extraction": { "ready": false, "status": "not_configured", "processed": 0, "total": 0, "failed": 0, "stale": 0, "skipped": parent_chunk_count },
            "claim_validation": { "ready": false, "status": "not_configured", "processed": 0, "total": 0, "failed": 0, "stale": 0, "skipped": parent_chunk_count },
            "relation_extraction": { "ready": relations_ready, "status": if relations_ready { "ready" } else { "not_configured" }, "processed": entity_edges.len(), "total": entity_edges.len(), "failed": 0, "stale": 0, "skipped": if relations_ready { 0 } else { parent_chunk_count } },
            "relation_validation": { "ready": relations_ready, "status": if relations_ready { "ready" } else { "not_configured" }, "processed": entity_edges.len(), "total": entity_edges.len(), "failed": 0, "stale": 0, "skipped": if relations_ready { 0 } else { parent_chunk_count } },
            "graph_projection": { "ready": graph_ready, "status": graph_projection_status, "processed": entity_nodes.len() + entity_edges.len(), "total": entity_nodes.len() + entity_edges.len(), "failed": 0, "stale": graph_stale_count, "skipped": if graph_ready { 0 } else { parent_chunk_count } },
            "community_report_projection": { "ready": false, "status": "not_configured", "processed": 0, "total": 0, "failed": 0, "stale": 0, "skipped": parent_chunk_count }
        });
        let stage_coverage = serde_json::json!({
            "sparse_indexing": if retrieval_ready { 1.0 } else { 0.0 },
            "tree_index": if tree_ready { 1.0 } else { 0.0 },
            "dense_indexing": 0.0,
            "claim_extraction": 0.0,
            "claim_validation": 0.0,
            "relation_extraction": if relations_ready { 1.0 } else { 0.0 },
            "relation_validation": if relations_ready { 1.0 } else { 0.0 },
            "graph_projection": if graph_ready { 1.0 } else { 0.0 },
            "community_report_projection": 0.0
        });
        Ok(KnowledgeStats {
            document_count: documents.len(),
            total_documents: documents.len(),
            chunk_count: parent_chunk_count,
            total_chunks: parent_chunk_count,
            parent_chunk_count,
            child_chunk_count,
            entity_count: entity_nodes.len(),
            claim_count: 0,
            relation_count: entity_edges.len(),
            source_count: entity_evidence.len(),
            conflict_count,
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
            stale_stage_count: usize::from(graph_stale_count > 0),
            retrieval_ready,
            claims_ready,
            relations_ready,
            graph_ready,
            partial_availability: retrieval_ready
                && (!claims_ready || !relations_ready || !graph_ready),
        })
    }

    pub(super) fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
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
pub(super) struct KnowledgeStorePaths {
    pub(super) files_dir: PathBuf,
    pub(super) documents_file: PathBuf,
    pub(super) chunks_file: PathBuf,
    pub(super) jobs_file: PathBuf,
    pub(super) document_graph_nodes_file: PathBuf,
    pub(super) document_graph_edges_file: PathBuf,
    pub(super) entity_graph_nodes_file: PathBuf,
    pub(super) entity_graph_edges_file: PathBuf,
    pub(super) entity_graph_evidence_file: PathBuf,
}

impl KnowledgeStorePaths {
    pub(super) fn new(root: &Path) -> Self {
        let knowledge_dir = root.join("knowledge");
        Self {
            files_dir: knowledge_dir.join("files"),
            documents_file: knowledge_dir.join("documents.jsonl"),
            chunks_file: knowledge_dir.join("chunks.jsonl"),
            jobs_file: knowledge_dir.join("jobs.jsonl"),
            document_graph_nodes_file: knowledge_dir.join("document_graph_nodes.jsonl"),
            document_graph_edges_file: knowledge_dir.join("document_graph_edges.jsonl"),
            entity_graph_nodes_file: knowledge_dir.join("entity_graph_nodes.jsonl"),
            entity_graph_edges_file: knowledge_dir.join("entity_graph_edges.jsonl"),
            entity_graph_evidence_file: knowledge_dir.join("entity_graph_evidence.jsonl"),
        }
    }

    pub(super) fn ensure_dirs(&self) -> Result<(), WorkerProtocolError> {
        fs::create_dir_all(&self.files_dir).map_err(|error| {
            knowledge_filesystem_error(
                "failed to create knowledge directory",
                serde_json::json!({ "error": error.to_string() }),
            )
        })
    }
}
