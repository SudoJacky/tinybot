fn validate_entity_graph_relations(
    document: &KnowledgeDocument,
    params: &KnowledgeEntityGraphExtractionParams,
) -> Result<(), WorkerProtocolError> {
    for (index, relation) in params.relations.iter().enumerate() {
        if relation.source.trim().is_empty()
            || relation.target.trim().is_empty()
            || relation.predicate.trim().is_empty()
        {
            continue;
        }
        if !controlled_relation_predicate(relation.predicate.trim()) {
            return Err(invalid_knowledge_request_with_details(
                "unsupported relation predicate",
                serde_json::json!({
                    "doc_id": document.id,
                    "relation_index": index,
                    "source": relation.source,
                    "target": relation.target,
                    "predicate": relation.predicate,
                    "allowed_predicates": CONTROLLED_RELATION_PREDICATES
                }),
            ));
        }
        let evidence_texts = relation
            .evidence
            .iter()
            .filter_map(|evidence| {
                value_string(evidence, "text")
                    .or_else(|| value_string(evidence, "quote"))
                    .map(|text| text.trim().to_string())
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>();
        if evidence_texts.is_empty() {
            return Err(invalid_knowledge_request_with_details(
                "relation evidence is required",
                serde_json::json!({
                    "doc_id": document.id,
                    "relation_index": index,
                    "source": relation.source,
                    "target": relation.target,
                    "predicate": relation.predicate
                }),
            ));
        }
        if let Some(text) = evidence_texts
            .iter()
            .find(|text| !document.content.contains(text.as_str()))
        {
            return Err(invalid_knowledge_request_with_details(
                "relation evidence must match document content",
                serde_json::json!({
                    "doc_id": document.id,
                    "relation_index": index,
                    "source": relation.source,
                    "target": relation.target,
                    "predicate": relation.predicate,
                    "evidence": text
                }),
            ));
        }
        if let Some(evidence_doc_id) = relation.evidence.iter().find_map(|evidence| {
            value_string(evidence, "doc_id")
                .map(|doc_id| doc_id.trim().to_string())
                .filter(|doc_id| !doc_id.is_empty() && doc_id != &document.id)
        }) {
            return Err(invalid_knowledge_request_with_details(
                "relation evidence doc_id must match document",
                serde_json::json!({
                    "doc_id": document.id,
                    "relation_index": index,
                    "source": relation.source,
                    "target": relation.target,
                    "predicate": relation.predicate,
                    "evidence_doc_id": evidence_doc_id
                }),
            ));
        }
    }
    Ok(())
}

fn controlled_relation_predicate(predicate: &str) -> bool {
    CONTROLLED_RELATION_PREDICATES
        .iter()
        .any(|allowed| predicate.eq_ignore_ascii_case(allowed))
}

fn merge_entity_graph_node(
    node: &mut KnowledgeGraphNode,
    entity: &KnowledgeExtractedEntity,
    evidence_ids: Vec<String>,
) {
    if let Value::Object(attributes) = &mut node.attributes {
        append_unique_json_strings(attributes, "evidence_ids", evidence_ids);
        update_entity_graph_evidence_status(attributes);

        let alias = entity.name.trim();
        if !alias.is_empty() && alias != node.label {
            append_unique_json_strings(attributes, "aliases", vec![alias.to_string()]);
        }

        let entity_type = normalize_entity_graph_type(&entity.entity_type);
        let existing_type = attributes
            .get("entity_type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if existing_type.is_empty() && !entity_type.is_empty() {
            attributes.insert("entity_type".to_string(), Value::String(entity_type));
        }

        if let Some(confidence) = entity.confidence {
            let existing_confidence = attributes.get("confidence").and_then(Value::as_f64);
            if existing_confidence.map_or(true, |existing| confidence > existing) {
                attributes.insert("confidence".to_string(), serde_json::json!(confidence));
            }
        }
    }
}

fn append_unique_json_strings(
    attributes: &mut serde_json::Map<String, Value>,
    key: &str,
    values: Vec<String>,
) {
    let mut existing = attributes
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = existing
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    for value in values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if seen.insert(value.clone()) {
            existing.push(Value::String(value));
        }
    }
    attributes.insert(key.to_string(), Value::Array(existing));
}

fn update_entity_graph_evidence_status(attributes: &mut serde_json::Map<String, Value>) {
    let evidence_ids = attributes
        .get("evidence_ids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .count()
        })
        .unwrap_or(0);
    let status = if evidence_ids == 0 {
        "missing"
    } else {
        "verified"
    };
    attributes.insert(
        "evidence_status".to_string(),
        Value::String(status.to_string()),
    );
}

fn entity_graph_evidence_status(evidence_ids: &[String]) -> &'static str {
    if evidence_ids.iter().any(|id| !id.trim().is_empty()) {
        "verified"
    } else {
        "missing"
    }
}

fn entity_graph_node_evidence_status(attributes: &Value) -> &str {
    attributes
        .get("evidence_status")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if graph_evidence_ids(attributes).is_empty() {
                "missing"
            } else {
                "verified"
            }
        })
}

fn normalize_entity_graph_type(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn entity_graph_stub_node(
    document: &KnowledgeDocument,
    name: &str,
    id: &str,
    source_hash: &str,
) -> KnowledgeGraphNode {
    KnowledgeGraphNode {
        id: id.to_string(),
        label: name.trim().to_string(),
        node_type: "entity".to_string(),
        doc_id: document.id.clone(),
        evidence: Vec::new(),
        attributes: serde_json::json!({
            "entity_type": "",
            "source_hash": source_hash,
            "stale": false,
            "evidence_status": "missing",
            "evidence_ids": []
        }),
    }
}

fn purge_entity_graph_records(
    store: &KnowledgeStorePaths,
    doc_id: &str,
) -> Result<(), WorkerProtocolError> {
    let mut nodes = read_jsonl::<KnowledgeGraphNode>(&store.entity_graph_nodes_file)?;
    let mut edges = read_jsonl::<KnowledgeGraphEdge>(&store.entity_graph_edges_file)?;
    let mut evidence_records = read_jsonl::<Value>(&store.entity_graph_evidence_file)?;
    nodes.retain(|node| node.doc_id != doc_id);
    edges.retain(|edge| edge.doc_id != doc_id);
    evidence_records.retain(|item| value_string(item, "doc_id").as_deref() != Some(doc_id));
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
    )
}

fn graph_record_confidence(attributes: &Value) -> f64 {
    attributes
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(1.0)
        .clamp(0.0, 1.0)
}

fn entity_graph_conflicts(
    nodes: &[KnowledgeGraphNode],
    edges: &[KnowledgeGraphEdge],
) -> Vec<Value> {
    let labels = nodes
        .iter()
        .map(|node| (node.id.as_str(), node.label.as_str()))
        .collect::<HashMap<_, _>>();
    edges
        .iter()
        .filter(|edge| entity_graph_edge_is_conflict(edge))
        .map(|edge| {
            serde_json::json!({
                "id": edge.id,
                "type": "relation_conflict",
                "edge_id": edge.id,
                "source": edge.source,
                "source_label": labels.get(edge.source.as_str()).copied().unwrap_or(edge.source.as_str()),
                "target": edge.target,
                "target_label": labels.get(edge.target.as_str()).copied().unwrap_or(edge.target.as_str()),
                "predicate": edge.label,
                "confidence": graph_record_confidence(&edge.attributes),
                "doc_id": edge.doc_id,
                "stale": edge.attributes.get("stale").and_then(Value::as_bool).unwrap_or(false),
                "evidence": edge.evidence
            })
        })
        .collect()
}

fn entity_graph_edge_is_conflict(edge: &KnowledgeGraphEdge) -> bool {
    edge.label.eq_ignore_ascii_case("conflicts_with")
        || edge.edge_type.eq_ignore_ascii_case("conflicts_with")
}

#[derive(Clone, Copy, Debug, Default)]
struct EntityGraphStaleness {
    node_count: usize,
    edge_count: usize,
}

fn mark_entity_graph_staleness(
    root: &Path,
    nodes: &mut [KnowledgeGraphNode],
    edges: &mut [KnowledgeGraphEdge],
) -> Result<EntityGraphStaleness, WorkerProtocolError> {
    let documents =
        read_jsonl::<KnowledgeDocument>(&KnowledgeStorePaths::new(root).documents_file)?;
    let current_hashes = documents
        .iter()
        .map(|document| (document.id.clone(), document_content_hash(document)))
        .collect::<HashMap<_, _>>();
    let mut stale = EntityGraphStaleness::default();
    for node in nodes {
        if mark_graph_attributes_staleness(&mut node.attributes, current_hashes.get(&node.doc_id)) {
            stale.node_count += 1;
        }
    }
    for edge in edges {
        if mark_graph_attributes_staleness(&mut edge.attributes, current_hashes.get(&edge.doc_id)) {
            stale.edge_count += 1;
        }
    }
    Ok(stale)
}

fn attach_entity_graph_node_evidence(nodes: &mut [KnowledgeGraphNode], evidence_records: &[Value]) {
    for node in nodes {
        let evidence_ids = node
            .attributes
            .get("evidence_ids")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        if evidence_ids.is_empty() {
            node.evidence.clear();
            continue;
        }
        node.evidence = evidence_records
            .iter()
            .filter(|item| {
                value_string(item, "doc_id").as_deref() == Some(node.doc_id.as_str())
                    && value_string(item, "owner_id").as_deref() == Some(node.id.as_str())
                    && value_string(item, "owner_type").as_deref() == Some("entity")
                    && value_string(item, "id")
                        .as_deref()
                        .map(|id| evidence_ids.contains(id))
                        .unwrap_or(false)
            })
            .cloned()
            .collect();
    }
}

fn mark_graph_attributes_staleness(attributes: &mut Value, current_hash: Option<&String>) -> bool {
    let stale = attributes
        .get("source_hash")
        .and_then(Value::as_str)
        .map(|source_hash| current_hash.map_or(true, |hash| source_hash != hash))
        .unwrap_or(false);
    if let Value::Object(map) = attributes {
        map.insert("stale".to_string(), Value::Bool(stale));
        if stale {
            if let Some(hash) = current_hash {
                map.insert(
                    "current_source_hash".to_string(),
                    Value::String(hash.clone()),
                );
            }
        } else {
            map.remove("current_source_hash");
        }
    }
    stale
}

fn persist_entity_graph_evidence(
    evidence_records: &mut Vec<Value>,
    document: &KnowledgeDocument,
    owner_id: &str,
    owner_type: &str,
    index: usize,
    evidence: &Value,
) -> String {
    let text = value_string(evidence, "text")
        .or_else(|| value_string(evidence, "quote"))
        .unwrap_or_default();
    let line_start = value_usize(evidence, "line_start").unwrap_or(1);
    let line_end = value_usize(evidence, "line_end").unwrap_or(line_start);
    let id = document_graph_value_id(
        "evidence",
        &format!("{}:{owner_id}:{owner_type}:{index}:{text}", document.id),
    );
    evidence_records.push(serde_json::json!({
        "id": id,
        "doc_id": document.id,
        "doc_name": document.name,
        "owner_id": owner_id,
        "owner_type": owner_type,
        "text": text,
        "line_start": line_start,
        "line_end": line_end
    }));
    id
}

fn entity_graph_entity_id(doc_id: &str, name: &str) -> String {
    document_graph_value_id(
        "entity",
        &format!("{doc_id}:{}", normalize_graph_reference_key(name)),
    )
}

fn document_content_hash(document: &KnowledgeDocument) -> String {
    format!(
        "{:016x}",
        stable_graph_hash(&format!("{}\n{}", document.id, document.content))
    )
}

fn refresh_document_graph(root: &Path) -> Result<(), WorkerProtocolError> {
    let store = KnowledgeStorePaths::new(root);
    let documents = read_jsonl::<KnowledgeDocument>(&store.documents_file)?;
    let (nodes, edges) = build_document_graph_records(&documents);
    run_knowledge_jsonl_update(
        &[
            &store.document_graph_nodes_file,
            &store.document_graph_edges_file,
        ],
        || {
            write_jsonl(&store.document_graph_nodes_file, &nodes)?;
            write_jsonl(&store.document_graph_edges_file, &edges)
        },
    )
}

fn build_document_graph_records(
    documents: &[KnowledgeDocument],
) -> (Vec<KnowledgeGraphNode>, Vec<KnowledgeGraphEdge>) {
    let mut nodes: HashMap<String, KnowledgeGraphNode> = HashMap::new();
    let mut edges: HashMap<String, KnowledgeGraphEdge> = HashMap::new();
    let document_lookup = document_graph_lookup(documents);
    for document in documents {
        let doc_node_id = document_graph_node_id(&document.id);
        nodes.insert(doc_node_id.clone(), document_graph_document_node(document));
        if !document.category.trim().is_empty() {
            let category_node = document_graph_value_node("category", &document.category);
            let category_id = category_node.id.clone();
            nodes.entry(category_id.clone()).or_insert(category_node);
            upsert_document_graph_edge(
                &mut edges,
                &doc_node_id,
                &category_id,
                "categorized_as",
                document,
                None,
            );
        }
        for tag in document
            .tags
            .iter()
            .map(String::as_str)
            .filter(|tag| !tag.trim().is_empty())
        {
            let tag_node = document_graph_value_node("tag", tag);
            let tag_id = tag_node.id.clone();
            nodes.entry(tag_id.clone()).or_insert(tag_node);
            upsert_document_graph_edge(&mut edges, &doc_node_id, &tag_id, "tagged", document, None);
        }
        for reference in explicit_document_references(document) {
            let (target_node, edge_type) = match reference.kind {
                ExplicitReferenceKind::Url => (
                    document_graph_value_node("url", &reference.target),
                    "references_url",
                ),
                ExplicitReferenceKind::File => {
                    if let Some(target_doc_id) =
                        resolve_document_graph_link(&reference.target, &document_lookup)
                    {
                        (
                            document_graph_document_stub_node(&target_doc_id, documents),
                            "links_to",
                        )
                    } else {
                        (
                            document_graph_value_node("file", &reference.target),
                            "references_file",
                        )
                    }
                }
            };
            let target_id = target_node.id.clone();
            nodes.entry(target_id.clone()).or_insert(target_node);
            upsert_document_graph_edge(
                &mut edges,
                &doc_node_id,
                &target_id,
                edge_type,
                document,
                Some(reference.evidence),
            );
        }
    }
    let mut nodes = nodes.into_values().collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        left.node_type
            .cmp(&right.node_type)
            .then_with(|| left.label.cmp(&right.label))
    });
    let mut edges = edges.into_values().collect::<Vec<_>>();
    edges.sort_by(|left, right| {
        left.edge_type
            .cmp(&right.edge_type)
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.target.cmp(&right.target))
    });
    (nodes, edges)
}

fn document_graph_lookup(documents: &[KnowledgeDocument]) -> HashMap<String, String> {
    let mut lookup = HashMap::new();
    for document in documents {
        for key in [
            document.name.as_str(),
            document.file_path.as_str(),
            document.original_path.as_deref().unwrap_or_default(),
            path_basename(&document.name),
            path_basename(&document.file_path),
            path_basename(document.original_path.as_deref().unwrap_or_default()),
        ] {
            let normalized = normalize_graph_reference_key(key);
            if !normalized.is_empty() {
                lookup.insert(normalized, document.id.clone());
            }
        }
    }
    lookup
}

fn document_graph_document_node(document: &KnowledgeDocument) -> KnowledgeGraphNode {
    KnowledgeGraphNode {
        id: document_graph_node_id(&document.id),
        label: document.name.clone(),
        node_type: "document".to_string(),
        doc_id: document.id.clone(),
        evidence: Vec::new(),
        attributes: serde_json::json!({
            "doc_id": document.id,
            "file_path": document.file_path,
            "file_type": document.file_type,
            "category": document.category,
            "tags": document.tags,
        }),
    }
}

fn document_graph_document_stub_node(
    doc_id: &str,
    documents: &[KnowledgeDocument],
) -> KnowledgeGraphNode {
    documents
        .iter()
        .find(|document| document.id == doc_id)
        .map(document_graph_document_node)
        .unwrap_or_else(|| KnowledgeGraphNode {
            id: document_graph_node_id(doc_id),
            label: doc_id.to_string(),
            node_type: "document".to_string(),
            doc_id: doc_id.to_string(),
            evidence: Vec::new(),
            attributes: serde_json::json!({ "doc_id": doc_id }),
        })
}

fn document_graph_value_node(kind: &str, value: &str) -> KnowledgeGraphNode {
    KnowledgeGraphNode {
        id: document_graph_value_id(kind, value),
        label: value.trim().to_string(),
        node_type: kind.to_string(),
        doc_id: String::new(),
        evidence: Vec::new(),
        attributes: serde_json::json!({ "value": value.trim() }),
    }
}

fn upsert_document_graph_edge(
    edges: &mut HashMap<String, KnowledgeGraphEdge>,
    source: &str,
    target: &str,
    edge_type: &str,
    document: &KnowledgeDocument,
    evidence: Option<Value>,
) {
    if source == target {
        return;
    }
    let id = document_graph_edge_id(source, edge_type, target);
    edges
        .entry(id.clone())
        .or_insert_with(|| KnowledgeGraphEdge {
            id,
            source: source.to_string(),
            target: target.to_string(),
            edge_type: edge_type.to_string(),
            label: edge_type.to_string(),
            doc_id: document.id.clone(),
            evidence: evidence.into_iter().collect(),
            attributes: serde_json::json!({
                "doc_id": document.id,
                "doc_name": document.name
            }),
        });
}

#[derive(Clone, Debug)]
struct ExplicitReference {
    target: String,
    kind: ExplicitReferenceKind,
    evidence: Value,
}

#[derive(Clone, Debug)]
enum ExplicitReferenceKind {
    Url,
    File,
}

fn explicit_document_references(document: &KnowledgeDocument) -> Vec<ExplicitReference> {
    let mut references = Vec::new();
    for (line_index, line) in document.content.lines().enumerate() {
        references.extend(markdown_link_references(document, line, line_index + 1));
        for token in line.split_whitespace() {
            let target = trim_reference_token(token);
            if target.is_empty() {
                continue;
            }
            if is_explicit_url(&target) {
                references.push(explicit_reference(
                    document,
                    &target,
                    ExplicitReferenceKind::Url,
                    line,
                    line_index + 1,
                ));
            } else if is_explicit_file_reference(&target) {
                references.push(explicit_reference(
                    document,
                    &target,
                    ExplicitReferenceKind::File,
                    line,
                    line_index + 1,
                ));
            }
        }
    }
    references
}

fn markdown_link_references(
    document: &KnowledgeDocument,
    line: &str,
    line_number: usize,
) -> Vec<ExplicitReference> {
    let mut references = Vec::new();
    let mut cursor = 0usize;
    while let Some(open_label) = line[cursor..].find('[') {
        let label_start = cursor + open_label + 1;
        let Some(close_label_offset) = line[label_start..].find(']') else {
            break;
        };
        let close_label = label_start + close_label_offset;
        if !line[close_label..].starts_with("](") {
            cursor = close_label + 1;
            continue;
        }
        let target_start = close_label + 2;
        let Some(close_target_offset) = line[target_start..].find(')') else {
            break;
        };
        let target_end = target_start + close_target_offset;
        let target = trim_reference_token(&line[target_start..target_end]);
        if !target.is_empty() {
            let kind = if is_explicit_url(&target) {
                ExplicitReferenceKind::Url
            } else {
                ExplicitReferenceKind::File
            };
            references.push(explicit_reference(
                document,
                &target,
                kind,
                line,
                line_number,
            ));
        }
        cursor = target_end + 1;
    }
    references
}

fn explicit_reference(
    document: &KnowledgeDocument,
    target: &str,
    kind: ExplicitReferenceKind,
    line: &str,
    line_number: usize,
) -> ExplicitReference {
    ExplicitReference {
        target: target.to_string(),
        kind,
        evidence: serde_json::json!({
            "id": document_graph_value_id("evidence", &format!("{}:{line_number}:{target}", document.id)),
            "doc_id": document.id,
            "doc_name": document.name,
            "text": line.trim(),
            "line_start": line_number,
            "line_end": line_number,
            "target": target
        }),
    }
}

fn resolve_document_graph_link(target: &str, lookup: &HashMap<String, String>) -> Option<String> {
    let normalized = normalize_graph_reference_key(target);
    lookup.get(&normalized).cloned().or_else(|| {
        lookup
            .get(&normalize_graph_reference_key(path_basename(target)))
            .cloned()
    })
}

fn document_graph_node_id(doc_id: &str) -> String {
    format!("doc:{doc_id}")
}

fn document_graph_value_id(kind: &str, value: &str) -> String {
    format!(
        "{kind}:{:016x}",
        stable_graph_hash(&normalize_graph_reference_key(value))
    )
}

fn document_graph_edge_id(source: &str, edge_type: &str, target: &str) -> String {
    format!(
        "edge:{:016x}",
        stable_graph_hash(&format!("{source}\n{edge_type}\n{target}"))
    )
}

fn stable_graph_hash(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn normalize_graph_reference_key(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("./")
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn path_basename(value: &str) -> &str {
    value.rsplit(['/', '\\']).next().unwrap_or(value)
}

fn trim_reference_token(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character: char| {
            matches!(
                character,
                ',' | '.' | ';' | ':' | '!' | '?' | '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']'
            )
        })
        .to_string()
}

fn is_explicit_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn is_explicit_file_reference(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [".md", ".txt", ".json", ".csv"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}
