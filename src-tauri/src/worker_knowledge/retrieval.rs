use super::*;

pub(super) fn build_knowledge_retrieval_plan(params: &KnowledgeQueryParams, limit: usize) -> Value {
    let query = params.query.as_str();
    let terms = knowledge_query_terms(query);
    let budgets = knowledge_retrieval_plan_budgets(params, limit);
    let (selected_routes, route_reasons) = knowledge_retrieval_plan_routes(params);
    let graph_options = knowledge_retrieval_plan_graph_options(params);
    let tree_options = knowledge_retrieval_plan_tree_options(params, limit);
    let exact_query = query.contains('.')
        || query.contains('_')
        || terms.iter().any(|term| {
            matches!(
                term.as_str(),
                "api" | "id" | "ids" | "config" | "key" | "keys" | "path" | "method"
            )
        });
    if exact_query {
        let mut exact_route_reasons = vec![serde_json::json!({
            "route": "keyword",
            "reason": "query contains exact identifiers or API/config-like terms"
        })];
        exact_route_reasons.extend(route_reasons.into_iter().skip(1));
        serde_json::json!({
            "object": "knowledge_retrieval_plan",
            "classification": "exact",
            "selected_routes": selected_routes,
            "route_reasons": exact_route_reasons,
            "budgets": budgets,
            "fallback_behavior": "fallback_to_hybrid_when_no_results",
            "fallback_routes": ["keyword", "tree", "graph"],
            "graph_options": graph_options,
            "tree_options": tree_options
        })
    } else {
        serde_json::json!({
            "object": "knowledge_retrieval_plan",
            "classification": "hybrid",
            "selected_routes": selected_routes,
            "route_reasons": route_reasons,
            "budgets": budgets,
            "fallback_behavior": "fallback_to_keyword_sparse",
            "fallback_routes": ["keyword"],
            "graph_options": graph_options,
            "tree_options": tree_options
        })
    }
}

pub(super) fn knowledge_retrieval_plan_routes(
    params: &KnowledgeQueryParams,
) -> (Vec<&'static str>, Vec<Value>) {
    let terms = knowledge_query_terms(&params.query);
    let include_structure_context =
        knowledge_query_should_include_structure_context(params, &terms);
    let include_graph_context = knowledge_query_should_include_graph_context(params, &terms);
    let mut selected_routes = vec!["keyword"];
    let mut route_reasons = vec![serde_json::json!({
        "route": "keyword",
        "reason": "baseline sparse retrieval remains available for all queries"
    })];
    if include_structure_context {
        selected_routes.push("tree");
        route_reasons.push(serde_json::json!({
            "route": "tree",
            "reason": if params.include_structure_context == Some(true) { "section metadata is requested for local structure context" } else { "query terms indicate section, chapter, or location navigation intent" }
        }));
    }
    if include_graph_context {
        selected_routes.push("graph");
        route_reasons.push(serde_json::json!({
            "route": "graph",
            "reason": if params.include_graph_context == Some(true) { "entity graph expansion is requested for evidence recall" } else { "query terms indicate dependency, causal, relation, or why/how graph intent" }
        }));
    }
    (selected_routes, route_reasons)
}

pub(super) fn knowledge_retrieval_plan_budgets(
    params: &KnowledgeQueryParams,
    limit: usize,
) -> Value {
    let terms = knowledge_query_terms(&params.query);
    let graph_budget = if knowledge_query_should_include_graph_context(params, &terms) {
        params.graph_max_added_chunks.unwrap_or(5).min(20)
    } else {
        0
    };
    let tree_budget = if knowledge_query_should_include_structure_context(params, &terms) {
        limit
    } else {
        0
    };
    serde_json::json!({
        "limit": limit,
        "keyword": limit,
        "semantic": 0,
        "graph": graph_budget,
        "tree": tree_budget
    })
}

pub(super) fn knowledge_retrieval_plan_graph_options(params: &KnowledgeQueryParams) -> Value {
    let terms = knowledge_query_terms(&params.query);
    serde_json::json!({
        "include_graph_context": knowledge_query_should_include_graph_context(params, &terms),
        "max_hops": params.graph_max_hops.unwrap_or(1).min(4),
        "relation_filters": params.graph_relation_filters.clone().unwrap_or_default(),
        "min_confidence": params.graph_min_confidence.unwrap_or(0.0).clamp(0.0, 1.0),
        "max_added_chunks": params.graph_max_added_chunks.unwrap_or(5).min(20)
    })
}

pub(super) fn knowledge_retrieval_plan_tree_options(
    params: &KnowledgeQueryParams,
    limit: usize,
) -> Value {
    let terms = knowledge_query_terms(&params.query);
    let include_structure_context =
        knowledge_query_should_include_structure_context(params, &terms);
    serde_json::json!({
        "include_structure_context": include_structure_context,
        "context_budget": if include_structure_context { limit } else { 0 },
        "trigger": match params.include_structure_context {
            Some(true) => "explicit",
            Some(false) => "disabled",
            None if include_structure_context => "auto",
            None => "none",
        }
    })
}

pub(super) fn knowledge_query_should_include_structure_context(
    params: &KnowledgeQueryParams,
    terms: &[String],
) -> bool {
    match params.include_structure_context {
        Some(value) => value,
        None => terms.iter().any(|term| {
            matches!(
                term.as_str(),
                "where"
                    | "section"
                    | "sections"
                    | "chapter"
                    | "chapters"
                    | "heading"
                    | "headings"
                    | "location"
                    | "located"
                    | "parent"
                    | "sibling"
                    | "siblings"
                    | "child"
                    | "children"
            )
        }),
    }
}

pub(super) fn knowledge_query_should_include_graph_context(
    params: &KnowledgeQueryParams,
    terms: &[String],
) -> bool {
    match params.include_graph_context {
        Some(value) => value,
        None => terms.iter().any(|term| {
            matches!(
                term.as_str(),
                "why"
                    | "how"
                    | "depend"
                    | "depends"
                    | "dependency"
                    | "dependencies"
                    | "cause"
                    | "causes"
                    | "causal"
                    | "relation"
                    | "relations"
                    | "relationship"
                    | "relationships"
                    | "configure"
                    | "configures"
                    | "conflict"
                    | "conflicts"
                    | "support"
                    | "supports"
            )
        }),
    }
}

pub(super) fn knowledge_query_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

pub(super) fn knowledge_score(content: &str, terms: &[String]) -> usize {
    let lower = content.to_ascii_lowercase();
    terms
        .iter()
        .filter(|term| lower.contains(term.as_str()))
        .count()
}

pub(super) fn invalid_knowledge_request(message: &str) -> WorkerProtocolError {
    invalid_knowledge_request_with_details(message, serde_json::json!({}))
}

pub(super) fn invalid_knowledge_request_with_details(
    message: &str,
    details: Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn unknown_knowledge_document(doc_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "knowledge document not found",
        serde_json::json!({ "doc_id": doc_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn knowledge_filesystem_error(message: &str, details: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        true,
        WorkerProtocolErrorSource::RustCore,
    )
}
