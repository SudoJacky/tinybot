import json
from dataclasses import asdict
from pathlib import Path
import shutil
import threading
import time
import uuid

from tinybot.agent.knowledge import KnowledgeCandidate, KnowledgeStageStatus, KnowledgeStore
from tinybot.api.knowledge import _start_rebuild_job
from tinybot.config.schema import KnowledgeConfig


def _workspace() -> Path:
    path = Path("tests") / ".tmp_knowledge_semantic" / uuid.uuid4().hex
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_semantic_index_extracts_claims_entities_and_relations() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )

    doc_id = store.add_document(
        name="TinyBot RAG Notes",
        content=("TinyBot supports RAG. RAG depends on embeddings. BM25 is part of hybrid retrieval."),
        file_type="txt",
    )

    stats = store.get_stats()
    assert stats["document_count"] == 1
    assert stats["chunk_count"] == 1
    assert stats["entity_count"] >= 3
    assert stats["claim_count"] >= 3
    assert stats["relation_count"] >= 2

    results = store.query("What does TinyBot support?", mode="semantic", top_k=3)
    assert results
    assert results[0]["doc_id"] == doc_id
    assert "semantic" in results[0]["matched_methods"]
    assert results[0]["matched_relations"] or results[0]["matched_claims"]
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_hybrid_query_merges_semantic_results_without_vector_store() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0, retrieval_mode="hybrid"),
    )
    store.add_document(
        name="Architecture",
        content="Graph retrieval connects entities. Entity links improve knowledge traversal.",
        file_type="txt",
    )

    results = store.query("How does Graph retrieval connect entities?", top_k=2)

    assert results
    assert any("semantic" in result.get("matched_methods", []) for result in results)
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_delete_document_removes_semantic_index_entries() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Relations",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
    )
    assert store.get_stats()["relation_count"] >= 1

    assert store.delete_document(doc_id) is True

    stats = store.get_stats()
    assert stats["document_count"] == 0
    assert stats["chunk_count"] == 0
    assert stats["entity_count"] == 0
    assert stats["claim_count"] == 0
    assert stats["relation_count"] == 0
    assert stats["source_count"] == 0
    assert stats["community_count"] == 0
    assert stats["community_report_count"] == 0
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_traceability_fields_hydrate_old_semantic_records() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )

    store.entities_file.write_text(
        json.dumps({"id": "ent_old", "name": "TinyBot", "canonical_name": "tinybot"}) + "\n",
        encoding="utf-8",
    )
    store.claims_file.write_text(
        json.dumps({"id": "claim_old", "chunk_id": "chunk_old", "doc_id": "doc_old", "text": "TinyBot supports RAG."})
        + "\n",
        encoding="utf-8",
    )
    store.relations_file.write_text(
        json.dumps(
            {
                "id": "rel_old",
                "subject_entity_id": "ent_old",
                "predicate": "supports",
                "object_entity_id": "ent_rag",
                "evidence_chunk_id": "chunk_old",
                "doc_id": "doc_old",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    entity = store._read_entities()[0]
    claim = store._read_claims()[0]
    relation = store._read_relations()[0]

    assert entity.source_refs == []
    assert entity.mention_count == 0
    assert claim.source == {}
    assert claim.source_refs == []
    assert claim.validation_status == "validated"
    assert relation.source == {}
    assert relation.source_refs == []
    assert relation.claim_ids == []
    assert relation.validation_status == "validated"
    assert store._read_sources() == []
    assert store._read_conflicts() == []
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_semantic_index_persists_source_evidence_sidecar() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Traceable",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
    )

    sources = store._read_sources()
    claim = store._read_claims()[0]
    relation = store._read_relations()[0]

    assert sources
    assert claim.source["doc_id"] == doc_id
    assert claim.source["doc_name"] == "Traceable"
    assert claim.source["chunk_id"].startswith(f"chunk_{doc_id}_")
    assert claim.source["evidence_text"]
    assert claim.source["chunk_hash"]
    assert claim.source["extraction_method"] == "rule"
    assert claim.source_refs == [claim.source]
    assert relation.source["doc_id"] == doc_id
    assert relation.source_refs == [relation.source]
    assert store.get_stats()["source_count"] == len(sources)
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_stage_status_and_candidate_diagnostics_round_trip() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )

    status = KnowledgeStageStatus(
        id="stage_doc_1_chunking",
        stage="chunking",
        status="complete",
        doc_id="doc_1",
        processed=1,
        total=1,
        output_counts={"chunks": 2},
    )
    candidate = KnowledgeCandidate(
        id="cand_1",
        candidate_type="claim",
        doc_id="doc_1",
        chunk_id="chunk_1",
        text="Unsupported claim",
        validation_status="rejected",
        rejection_reasons=["missing_source_evidence"],
        diagnostics={"validator": "source_substring"},
    )

    store._write_stage_statuses([status])
    store._write_candidate_diagnostics([candidate])

    assert store._read_stage_statuses() == [status]
    assert store._read_candidate_diagnostics() == [candidate]
    stats = store.get_stats()
    assert stats["stage_status_count"] == 1
    assert stats["candidate_diagnostic_count"] == 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_rule_semantic_extraction_builds_candidates_before_persistence() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    chunk = {
        "index": 0,
        "content": "TinyBot supports RAG.",
        "semantic_text": "TinyBot supports RAG.",
        "context_content": "TinyBot supports RAG.",
        "section_path": "",
        "start_char": 0,
        "end_char": len("TinyBot supports RAG."),
    }

    candidates = store._extract_semantic_candidates(
        doc_id="doc_candidate",
        doc_name="Candidates",
        chunk_id="chunk_doc_candidate_0",
        chunk=chunk,
        content="TinyBot supports RAG.",
        semantic_units=store._extract_semantic_units("TinyBot supports RAG.", "", "Candidates"),
        extraction_method="rule",
        ts="2026-05-28T00:00:00+00:00",
    )

    by_type = {}
    for candidate in candidates:
        by_type.setdefault(candidate.candidate_type, []).append(candidate)

    assert {"mention", "claim", "relation"}.issubset(by_type)
    assert all(candidate.validation_status == "pending" for candidate in candidates)
    assert all(candidate.extraction_method == "rule" for candidate in candidates)
    assert all(candidate.sources for candidate in candidates)
    assert all(candidate.sources[0]["doc_id"] == "doc_candidate" for candidate in candidates)
    assert all(candidate.sources[0]["chunk_id"] == "chunk_doc_candidate_0" for candidate in candidates)
    assert any(candidate.payload["entity_name"] == "TinyBot" for candidate in by_type["mention"])
    assert any(candidate.text == "TinyBot supports RAG." for candidate in by_type["claim"])
    assert any(
        candidate.payload["subject"] == "TinyBot"
        and candidate.payload["predicate"] == "supports"
        and candidate.payload["object"] == "RAG"
        for candidate in by_type["relation"]
    )
    assert store._read_claims() == []
    assert store._read_relations() == []
    assert store._read_mentions() == []
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_structured_knowledge_snapshot_is_read_only_and_source_traceable() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Expansion Context",
        content="TinyBot supports RAG. RAG depends on embeddings.",
        file_type="txt",
        category="architecture",
        tags=["rag", "graph"],
    )

    snapshot = store.read_structured_knowledge(doc_id=doc_id)

    assert [doc["id"] for doc in snapshot["documents"]] == [doc_id]
    assert snapshot["chunks"]
    assert all(chunk["doc_id"] == doc_id for chunk in snapshot["chunks"])
    assert snapshot["semantic_text"]
    assert snapshot["semantic_text"][0]["text"]
    assert snapshot["entities"]
    assert snapshot["mentions"]
    assert snapshot["claims"]
    assert snapshot["relations"]
    assert snapshot["sources"]
    assert snapshot["projections"]["communities"] or snapshot["projections"]["community_reports"]
    assert snapshot["source_metadata"][doc_id]["name"] == "Expansion Context"
    assert snapshot["source_metadata"][doc_id]["category"] == "architecture"
    assert snapshot["source_metadata"][doc_id]["tags"] == ["rag", "graph"]

    snapshot["documents"][0]["name"] = "Mutated"
    snapshot["chunks"][0]["content"] = "mutated"
    snapshot["source_metadata"][doc_id]["name"] = "Mutated"

    assert store.get_document(doc_id).name == "Expansion Context"
    assert store._read_chunks()[0].content != "mutated"
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_evidence_expansion_defaults_to_document_scope_and_keeps_reports_read_only() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Primary",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
        category="architecture",
        tags=["rag"],
    )
    other_doc_id = store.add_document(
        name="Related",
        content="TinyBot supports RAG in production. RAG does not require embeddings.",
        file_type="txt",
        category="architecture",
        tags=["rag"],
    )

    result = store.run_evidence_expansion(doc_id=doc_id)

    assert result["scope"] == "document"
    assert result["searched_doc_ids"] == [doc_id]
    assert all(match["doc_id"] == doc_id for search in result["searches"] for match in search["matched_sources"])
    assert any(report["report_type"] == "support" for report in result["reports"])
    assert not any(report.get("doc_id") == other_doc_id for report in result["reports"])
    assert store.get_stats()["claim_count"] >= 2
    assert store._read_evidence_expansion_reports()
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_evidence_expansion_collection_scope_reports_conflicts_and_validated_candidates() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Primary",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
        category="architecture",
        tags=["rag"],
    )
    related_doc_id = store.add_document(
        name="Related",
        content="TinyBot supports RAG in production. RAG does not require embeddings.",
        file_type="txt",
        category="architecture",
        tags=["rag"],
    )
    unrelated_doc_id = store.add_document(
        name="Unrelated",
        content="TinyBot supports billing workflows.",
        file_type="txt",
        category="finance",
        tags=["billing"],
    )

    result = store.run_evidence_expansion(doc_id=doc_id, scope="collection")

    assert result["scope"] == "collection"
    assert set(result["searched_doc_ids"]) == {doc_id, related_doc_id}
    assert unrelated_doc_id not in result["searched_doc_ids"]
    assert any(report["report_type"] == "conflict" for report in result["reports"])
    assert any(
        report["report_type"] in {"candidate_claim", "candidate_relation"}
        and report["validation_status"] in {"validated", "normalized"}
        for report in result["reports"]
    )
    assert not any(report.report_type.startswith("formal_") for report in store._read_evidence_expansion_reports())
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_evidence_expansion_global_scope_and_query_budget_are_visible() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            evidence_expansion_max_queries=1,
        ),
    )
    doc_id = store.add_document(
        name="Primary",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
        category="architecture",
        tags=["rag"],
    )
    global_doc_id = store.add_document(
        name="Global",
        content="TinyBot supports RAG across workspaces.",
        file_type="txt",
        category="operations",
        tags=["global"],
    )

    result = store.run_evidence_expansion(doc_id=doc_id, scope="global")

    assert result["scope"] == "global"
    assert global_doc_id in result["searched_doc_ids"]
    assert result["status"] == "budget_limited"
    assert result["budget_limited"] is True
    assert result["budget_limit_reason"] == "query_limit"
    stages = {detail["stage"]: detail for detail in result["stage_details"]}
    assert stages["evidence_expansion"]["status"] == "budget_limited"
    assert stages["evidence_expansion"]["metadata"]["scope"] == "global"
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_evidence_expansion_preserves_reports_after_partial_search_failure(monkeypatch) -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Primary",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
    )
    original_search = store._search_evidence_chunks
    calls = {"count": 0}

    def flaky_search(**kwargs):
        calls["count"] += 1
        if calls["count"] == 2:
            raise RuntimeError("search backend unavailable")
        return original_search(**kwargs)

    monkeypatch.setattr(store, "_search_evidence_chunks", flaky_search)

    result = store.run_evidence_expansion(doc_id=doc_id)

    assert result["status"] == "partial_failed"
    assert any(report["report_type"] == "support" for report in result["reports"])
    assert any(report["report_type"] == "failure" for report in result["reports"])
    stages = {detail["stage"]: detail for detail in result["stage_details"]}
    assert stages["evidence_expansion"]["failed"] == 1
    assert stages["evidence_expansion"]["last_error"] == "search backend unavailable"
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_schema_normalization_builds_candidates_before_persistence() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    chunk = {
        "index": 0,
        "content": "GraphRAG supports community reports.",
        "semantic_text": "GraphRAG supports community reports.",
        "context_content": "GraphRAG supports community reports.",
        "section_path": "",
        "start_char": 0,
        "end_char": len("GraphRAG supports community reports."),
    }

    units = store._normalize_llm_semantic_units(
        {
            "graph": {
                "nodes": [
                    {"id": "GraphRAG", "label": "GraphRAG", "type": "technology", "confidence": 0.9},
                    {
                        "id": "community reports",
                        "label": "community reports",
                        "type": "business_object",
                        "confidence": 0.8,
                    },
                ],
                "edges": [
                    {
                        "from": "GraphRAG",
                        "to": "community reports",
                        "relation": "supports",
                        "evidence": "GraphRAG supports community reports.",
                        "strength": 3.0,
                        "confidence": 0.9,
                    }
                ],
            },
            "facts": [
                {
                    "subject": "GraphRAG",
                    "description": "GraphRAG supports community reports.",
                    "source_text": "GraphRAG supports community reports.",
                    "confidence": 0.9,
                }
            ],
        }
    )
    candidates = store._extract_semantic_candidates(
        doc_id="doc_llm_candidate",
        doc_name="LLM Candidates",
        chunk_id="chunk_doc_llm_candidate_0",
        chunk=chunk,
        content="GraphRAG supports community reports.",
        semantic_units=store._validate_semantic_units(units, "GraphRAG supports community reports."),
        extraction_method="llm",
        ts="2026-05-28T00:00:00+00:00",
    )

    by_type = {}
    for candidate in candidates:
        by_type.setdefault(candidate.candidate_type, []).append(candidate)

    assert {"mention", "claim", "relation"}.issubset(by_type)
    assert all(candidate.extraction_method == "llm" for candidate in candidates)
    assert any(candidate.payload["predicate"] == "supports" for candidate in by_type["relation"])
    assert all(candidate.sources[0]["extraction_method"] == "llm" for candidate in candidates)
    assert store._read_claims() == []
    assert store._read_relations() == []
    assert store._read_mentions() == []
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_rebuild_semantic_index_from_existing_chunks() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    store.add_document(
        name="Rebuild",
        content="TinyBot supports semantic retrieval. Semantic retrieval includes claims.",
        file_type="txt",
    )
    store._write_entities([])
    store._write_mentions([])
    store._write_claims([])
    store._write_relations([])

    stats = store.rebuild_semantic_index()

    assert stats["entities"] >= 2
    assert stats["claims"] >= 2
    assert stats["relations"] >= 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_deferred_document_indexing_from_persisted_chunks() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Deferred",
        content="TinyBot supports RAG. RAG depends on embeddings.",
        file_type="txt",
        defer_index=True,
    )

    assert store.get_document(doc_id) is not None
    assert store._read_chunks()
    assert store._read_entities() == []

    progress: list[tuple[str, int, int]] = []
    store.index_document(
        doc_id,
        progress_callback=lambda stage, _message, processed, total: progress.append((stage, processed, total)),
    )

    entity_names = {entity.name for entity in store._read_entities()}
    assert "TinyBot" in entity_names
    assert "RAG" in entity_names
    assert store.get_stats()["relation_count"] >= 1
    assert progress
    assert progress[-1][0] == "completed"
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_document_indexing_records_named_stage_statuses() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    progress: list[tuple[str, int, int]] = []

    doc_id = store.add_document(
        name="Staged",
        content="TinyBot supports RAG. RAG depends on embeddings.",
        file_type="txt",
        progress_callback=lambda stage, _message, processed, total: progress.append((stage, processed, total)),
    )

    stages = {status.stage: status for status in store._read_stage_statuses() if status.doc_id == doc_id}
    expected_stages = {
        "chunking",
        "dense_indexing",
        "sparse_indexing",
        "mention_extraction",
        "entity_canonicalization",
        "claim_extraction",
        "claim_validation",
        "relation_extraction",
        "relation_validation",
        "conflict_detection",
        "evidence_expansion",
        "graph_projection",
        "community_report_projection",
    }

    assert expected_stages.issubset(stages)
    assert stages["chunking"].status == "complete"
    assert stages["dense_indexing"].status == "skipped"
    assert stages["sparse_indexing"].status == "complete"
    assert stages["evidence_expansion"].status == "skipped"
    assert stages["claim_extraction"].output_counts["claims"] >= 1
    assert stages["relation_validation"].output_counts["relations"] >= 1
    assert all(stages[stage].input_hash for stage in expected_stages)
    assert all(stages[stage].source_version for stage in expected_stages)
    assert progress[0][0] == "chunking"
    assert progress[-1][0] == "completed"
    assert store.index_document(doc_id)["stage_details"]
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_selected_document_rebuild_refreshes_only_target_semantic_records() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    target_doc = store.add_document(
        name="Target",
        content="TinyBot supports RAG. RAG depends on embeddings.",
        file_type="txt",
    )
    other_doc = store.add_document(
        name="Other",
        content="GraphRAG builds communities. Communities contain claims.",
        file_type="txt",
    )
    store._write_claims([claim for claim in store._read_claims() if claim.doc_id != target_doc])
    other_claim_ids = {claim.id for claim in store._read_claims() if claim.doc_id == other_doc}

    result = store.rebuild_stages(doc_id=target_doc, stages=["mention_extraction"])

    claims_by_doc = {}
    for claim in store._read_claims():
        claims_by_doc.setdefault(claim.doc_id, set()).add(claim.id)
    assert claims_by_doc[target_doc]
    assert claims_by_doc[other_doc] == other_claim_ids
    assert result["doc_ids"] == [target_doc]
    assert "mention_extraction" in result["recomputed_stages"]
    assert "graph_projection" in result["recomputed_stages"]
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_selected_stage_rebuild_includes_downstream_stages() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Downstream",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
    )

    result = store.rebuild_stages(doc_id=doc_id, stages=["claim_extraction"])
    stage_status = {status.stage: status for status in store._read_stage_statuses() if status.doc_id == doc_id}

    assert result["recomputed_stages"] == [
        "claim_extraction",
        "claim_validation",
        "relation_extraction",
        "relation_validation",
        "conflict_detection",
        "graph_projection",
        "community_report_projection",
    ]
    assert all(stage_status[stage].stale == 0 for stage in result["recomputed_stages"])
    assert all(stage_status[stage].status in {"complete", "skipped"} for stage in result["recomputed_stages"])
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_stats_report_stage_readiness_and_partial_availability() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Stats",
        content="TinyBot supports RAG. RAG depends on embeddings.",
        file_type="txt",
    )
    statuses = [
        KnowledgeStageStatus(
            **{
                **asdict(status),
                "status": "failed",
                "failed": 1,
                "last_error": "provider unavailable",
            }
        )
        if status.stage == "claim_extraction"
        else KnowledgeStageStatus(**{**asdict(status), "status": "stale", "stale": 1})
        if status.stage == "graph_projection"
        else status
        for status in store._read_stage_statuses()
        if status.doc_id == doc_id
    ]
    store._write_stage_statuses(statuses)

    stats = store.get_stats()

    assert stats["retrieval_ready"] is True
    assert stats["claims_ready"] is False
    assert stats["relations_ready"] is True
    assert stats["graph_ready"] is False
    assert stats["partial_availability"] is True
    assert stats["failed_stage_count"] == 1
    assert stats["stale_stage_count"] == 1
    assert stats["stage_readiness"]["claim_extraction"]["status"] == "failed"
    assert stats["stage_readiness"]["graph_projection"]["stale"] == 1
    assert stats["stage_coverage"]["claim_extraction"]["failed"] == 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_entity_graph_returns_grouped_edges_with_evidence() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="Graph",
        content="TinyBot supports RAG. RAG requires embeddings.",
        file_type="txt",
    )

    graph = store.get_entity_graph(doc_id=doc_id)

    assert graph["object"] == "knowledge_graph"
    assert graph["nodes"]
    assert graph["edges"]
    assert graph["stats"]["doc_id"] == doc_id
    assert graph["stats"]["edge_count"] >= 1
    assert any(node["label"] == "TinyBot" for node in graph["nodes"])
    assert all(edge["source"] and edge["target"] for edge in graph["edges"])
    assert graph["edges"][0]["evidence"]
    assert graph["edges"][0]["evidence"][0]["doc_name"] == "Graph"
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_graphrag_index_exports_aggregated_knowledge_model_tables() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    doc_id = store.add_document(
        name="GraphRAG Model",
        content=("TinyBot supports RAG. TinyBot supports RAG. RAG depends on embeddings."),
        file_type="txt",
    )

    index = store.get_graphrag_index(doc_id=doc_id)

    assert index["object"] == "graphrag_index"
    assert index["stats"]["document_count"] == 1
    assert index["stats"]["text_unit_count"] == 1
    assert index["entities"]
    assert index["relationships"]
    assert index["covariates"]
    assert index["communities"]
    assert index["community_reports"]
    assert index["stats"]["community_count"] >= 1
    assert index["stats"]["community_report_count"] >= 1

    tinybot = next(entity for entity in index["entities"] if entity["title"] == "TinyBot")
    assert tinybot["frequency"] == 1
    assert tinybot["degree"] >= 1
    assert tinybot["text_unit_ids"]
    assert tinybot["description"]

    supports_edges = [
        relationship
        for relationship in index["relationships"]
        if relationship["source"] == "TinyBot"
        and relationship["target"] == "RAG"
        and relationship["predicate"] == "supports"
    ]
    assert len(supports_edges) == 1
    assert supports_edges[0]["weight"] > 0
    assert supports_edges[0]["strength"] == supports_edges[0]["weight"]
    assert supports_edges[0]["combined_degree"] >= 2
    assert supports_edges[0]["text_unit_ids"]
    assert "TinyBot supports RAG" in supports_edges[0]["description"]

    text_unit = index["text_units"][0]
    assert text_unit["document_id"] == doc_id
    assert text_unit["entity_ids"]
    assert text_unit["relationship_ids"]
    assert text_unit["covariate_ids"]
    assert index["community_reports"][0]["rank"] > 0
    assert "relationship weight" in index["community_reports"][0]["rating_explanation"]
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_graphrag_local_global_and_drift_modes_use_graph_context() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    store.add_document(
        name="GraphRAG Query Modes",
        content=("TinyBot supports RAG. RAG depends on embeddings. GraphRAG supports community reports."),
        file_type="txt",
    )

    local_results = store.query("What does TinyBot support?", mode="local", top_k=3)
    global_results = store.query("summarize community reports", mode="global", top_k=3)
    drift_results = store.query("RAG and community reports", mode="drift", top_k=3)

    assert local_results
    assert global_results
    assert drift_results
    assert "local" in local_results[0]["matched_methods"]
    assert "global" in global_results[0]["matched_methods"]
    assert "drift" in drift_results[0]["matched_methods"]
    assert global_results[0]["matched_communities"]
    assert global_results[0]["matched_claims"]
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_graphrag_communities_export_hierarchy_levels() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            graphrag_max_community_size=2,
        ),
    )
    doc_id = store.add_document(
        name="Community hierarchy",
        content=("Alpha supports Beta. Beta supports Gamma. Gamma supports Delta."),
        file_type="txt",
    )

    level0 = store.get_graphrag_index(doc_id=doc_id, level=0)
    level1 = store.get_graphrag_index(doc_id=doc_id, level=1)
    stats = store.get_stats()

    assert level0["communities"]
    assert stats["community_count_by_level"]["0"] >= 1
    assert stats["community_count_by_level"]["1"] >= 1
    assert level0["communities"][0]["level"] == 0
    assert level0["communities"][0]["children"]
    assert level1["communities"]
    assert all(community["level"] == 1 for community in level1["communities"])
    assert all(community["parent"] == level0["communities"][0]["community"] for community in level1["communities"])
    assert sum(community["size"] for community in level1["communities"]) == level0["communities"][0]["size"]
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_rule_semantic_extraction_rejects_descriptive_phrases() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    store.add_document(
        name="Task DAG",
        content=("**智能分解** — LLM 自动分析任务，生成带依赖关系的子任务图。TinyBot supports RAG."),
        file_type="txt",
    )

    entity_names = {entity.name for entity in store._read_entities()}

    assert "TinyBot" in entity_names
    assert "RAG" in entity_names
    assert all("自动分析任务" not in name for name in entity_names)
    assert all("生成带依赖关系" not in name for name in entity_names)
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_semantic_extraction_rejects_conversational_noise() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    store.add_document(
        name="RAG intro",
        content=("大家好。面试官再多问一点，就只能“阿巴阿巴”。我会一次性给大家讲清楚。GraphRAG 支持知识图谱。"),
        file_type="txt",
    )

    entity_names = {entity.name for entity in store._read_entities()}

    assert "GraphRAG" in entity_names
    assert "知识图谱" in entity_names
    assert "大家好" not in entity_names
    assert "阿巴阿巴" not in entity_names
    assert "我会一次性给大家讲清楚" not in entity_names
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_semantic_extraction_rejects_clause_fragments() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    store.add_document(
        name="RAG long context",
        content=(
            "现在的大模型不是已经支持百万 token 的上下文窗口了，还需要 RAG 吗？"
            "而且用得比以前更多了。GraphRAG 支持知识图谱。"
        ),
        file_type="txt",
    )

    entity_names = {entity.name for entity in store._read_entities()}

    assert "GraphRAG" in entity_names
    assert "知识图谱" in entity_names
    assert "现在的大模型不" not in entity_names
    assert "而且用得比以前更多了" not in entity_names
    assert all(not name.startswith("现在") for name in entity_names)
    assert all("用得比以前" not in name for name in entity_names)
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_semantic_extraction_is_validated(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "{"
                                '"entities": ['
                                '{"name": "TinyBot", "type": "product", "confidence": 0.9},'
                                '{"name": "RAG", "type": "technology", "confidence": 0.9},'
                                '{"name": "自动将复杂任务分解为可执行的子任务 DAG，支持", "type": "concept"},'
                                '{"name": "阿巴阿巴", "type": "concept", "confidence": 0.99},'
                                '{"name": "大家好", "type": "concept", "confidence": 0.99},'
                                '{"name": "我会一次性给大家讲清楚", "type": "concept", "confidence": 0.99}'
                                "],"
                                '"claims": ['
                                '{"text": "TinyBot supports RAG.", '
                                '"entity_names": ["TinyBot", "RAG", "大家好"], "confidence": 0.88}'
                                "],"
                                '"relations": ['
                                '{"subject": "TinyBot", "predicate": "supports", "object": "RAG", '
                                '"evidence": "TinyBot supports RAG.", "confidence": 0.86},'
                                '{"subject": "大家好", "predicate": "supports", "object": "阿巴阿巴", '
                                '"evidence": "TinyBot supports RAG.", "confidence": 0.86}'
                                "]"
                                "}"
                            )
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="LLM extraction",
        content="TinyBot supports RAG.",
        file_type="txt",
    )

    entity_names = {entity.name for entity in store._read_entities()}
    assert entity_names == {"TinyBot", "RAG"}
    assert store.get_stats()["relation_count"] == 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_semantic_extraction_uses_single_pass_strategy(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    prompts: list[str] = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "{"
                                '"entities": [{"title": "TinyBot", "type": "product", "confidence": 0.9},'
                                '{"title": "RAG", "type": "technology", "confidence": 0.9}],'
                                '"relationships": [{"source": "TinyBot", "predicate": "supports", '
                                '"target": "RAG", "evidence": "TinyBot supports RAG.", "confidence": 0.9}]'
                                "}"
                            )
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            prompts.append(kwargs["json"]["messages"][0]["content"])
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
            llm_extraction_strategy="single_pass",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="Single pass LLM extraction",
        content="TinyBot supports RAG.",
        file_type="txt",
    )

    assert prompts
    assert "Strategy: single_pass" in prompts[0]
    assert store.get_stats()["relation_count"] == 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_semantic_extraction_uses_entity_guided_second_pass(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    prompts: list[str] = []
    responses = [
        (
            "{"
            '"entities": [{"title": "TinyBot", "type": "product", "confidence": 0.9},'
            '{"title": "RAG", "type": "technology", "confidence": 0.9}]'
            "}"
        ),
        (
            "{"
            '"relationships": [{"source": "TinyBot", "predicate": "supports", '
            '"target": "RAG", "evidence": "TinyBot supports RAG.", "confidence": 0.9}],'
            '"covariates": [{"subject": "TinyBot", "description": "TinyBot supports RAG.", '
            '"source_text": "TinyBot supports RAG.", "confidence": 0.9}]'
            "}"
        ),
    ]

    class FakeResponse:
        def __init__(self, content):
            self.content = content

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": self.content}}]}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            prompts.append(kwargs["json"]["messages"][0]["content"])
            return FakeResponse(responses[len(prompts) - 1])

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
            llm_extraction_strategy="entity_guided",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="Entity guided LLM extraction",
        content="TinyBot supports RAG.",
        file_type="txt",
    )

    assert len(prompts) == 2
    assert "Strategy: entity_guided" in prompts[0]
    assert "Known entity candidates" in prompts[1]
    assert "TinyBot" in prompts[1]
    assert store.get_stats()["claim_count"] == 1
    assert store.get_stats()["relation_count"] == 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_candidate_validation_rejects_unsupported_claims(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "{"
                                '"entities": [{"title": "TinyBot", "type": "product", "confidence": 0.9},'
                                '{"title": "RAG", "type": "technology", "confidence": 0.9}],'
                                '"claims": [{"text": "TinyBot supports GraphQL.", '
                                '"entity_names": ["TinyBot"], "source_text": "TinyBot supports GraphQL.", "confidence": 0.9}],'
                                '"relationships": [{"source": "TinyBot", "predicate": "invented", '
                                '"target": "RAG", "evidence": "TinyBot supports RAG.", "confidence": 0.9}]'
                                "}"
                            )
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="Rejected candidates",
        content="TinyBot supports RAG.",
        file_type="txt",
    )

    diagnostics = store._read_candidate_diagnostics()
    assert store.get_stats()["claim_count"] == 0
    assert store.get_stats()["relation_count"] == 0
    assert any(candidate.validation_status == "rejected" for candidate in diagnostics)
    assert any("unsupported_claim_evidence" in candidate.rejection_reasons for candidate in diagnostics)
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_candidate_validation_normalizes_types_predicates_and_merges_relation_support(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "{"
                                '"entities": [{"title": "TinyBot", "type": "company", "confidence": 0.9},'
                                '{"title": "RAG", "type": "library", "confidence": 0.9}],'
                                '"relationships": ['
                                '{"source": "TinyBot", "predicate": "uses", "target": "RAG", '
                                '"evidence": "TinyBot uses RAG.", "confidence": 0.9},'
                                '{"source": "TinyBot", "predicate": "uses", "target": "RAG", '
                                '"evidence": "TinyBot uses RAG.", "confidence": 0.8}'
                                "]"
                                "}"
                            )
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="Normalized candidates",
        content="TinyBot uses RAG.",
        file_type="txt",
    )

    entities = {entity.name: entity for entity in store._read_entities()}
    relations = store._read_relations()
    diagnostics = store._read_candidate_diagnostics()

    assert entities["TinyBot"].type == "organization"
    assert entities["RAG"].type == "technology"
    assert len(relations) == 1
    assert relations[0].predicate == "used_for"
    assert len(relations[0].source_refs) == 2
    assert any(candidate.validation_status == "normalized" for candidate in diagnostics)
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_conflicting_validated_claims_are_preserved_with_conflict_record(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "{"
                                '"entities": [{"title": "TinyBot", "type": "product", "confidence": 0.9},'
                                '{"title": "RAG", "type": "technology", "confidence": 0.9}],'
                                '"claims": ['
                                '{"text": "TinyBot supports RAG.", "entity_names": ["TinyBot", "RAG"], '
                                '"status": "TRUE", "source_text": "TinyBot supports RAG.", "confidence": 0.9},'
                                '{"text": "TinyBot does not support RAG.", "entity_names": ["TinyBot", "RAG"], '
                                '"status": "FALSE", "source_text": "TinyBot does not support RAG.", "confidence": 0.9}'
                                "]"
                                "}"
                            )
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="Conflicting claims",
        content="TinyBot supports RAG. TinyBot does not support RAG.",
        file_type="txt",
    )

    conflicts = store._read_conflicts()
    assert store.get_stats()["claim_count"] == 2
    assert len(conflicts) == 1
    assert conflicts[0].conflict_type == "claim_polarity"
    assert len(conflicts[0].sources) == 2
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_semantic_extraction_accepts_compact_kg_schema(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "{"
                                '"e": ['
                                '{"n": "GraphRAG", "t": "technology", "c": 0.9},'
                                '{"n": "知识图谱", "t": "technology", "c": 0.9},'
                                '{"n": "现在的大模型不", "t": "concept", "c": 0.99}'
                                "],"
                                '"r": ['
                                '{"s": "GraphRAG", "p": "supports", "o": "知识图谱", '
                                '"e": "GraphRAG 支持知识图谱。", "c": 0.86}'
                                "]"
                                "}"
                            )
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="Compact KG extraction",
        content="GraphRAG 支持知识图谱。",
        file_type="txt",
    )

    entity_names = {entity.name for entity in store._read_entities()}
    assert entity_names == {"GraphRAG", "知识图谱"}
    assert store.get_stats()["claim_count"] == 1
    assert store.get_stats()["relation_count"] == 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_semantic_extraction_accepts_graphrag_subgraph_schema(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                "{"
                                '"entities": ['
                                '{"title": "GraphRAG", "type": "technology", "description": "GraphRAG uses graph indexing.", "confidence": 0.9},'
                                '{"title": "community reports", "type": "business_object", "description": "Summaries for graph communities.", "confidence": 0.8}'
                                "],"
                                '"relationships": ['
                                '{"source": "GraphRAG", "predicate": "supports", "target": "community reports", '
                                '"description": "GraphRAG supports community reports.", '
                                '"evidence": "GraphRAG supports community reports.", "strength": 2.0, "confidence": 0.9}'
                                "],"
                                '"covariates": ['
                                '{"subject": "GraphRAG", "description": "GraphRAG supports community reports.", '
                                '"status": "TRUE", "start_date": "2024", "end_date": "", '
                                '"source_text": "GraphRAG supports community reports.", "confidence": 0.9}'
                                "]"
                                "}"
                            )
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="GraphRAG schema",
        content="GraphRAG supports community reports.",
        file_type="txt",
    )

    index = store.get_graphrag_index(include_reports=False)

    assert {entity["title"] for entity in index["entities"]} == {"GraphRAG", "community reports"}
    assert index["relationships"][0]["source"] == "GraphRAG"
    assert index["relationships"][0]["target"] == "community reports"
    assert index["relationships"][0]["weight"] >= 2.0
    assert index["relationships"][0]["strength"] >= 2.0
    assert index["covariates"][0]["status"] == "TRUE"
    assert index["covariates"][0]["start_date"] == "2024"
    assert index["community_reports"] == []
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_llm_semantic_extraction_runs_chunks_concurrently(monkeypatch) -> None:
    workspace = _workspace()

    class Provider:
        api_key = "test-key"
        api_base = "https://example.test/v1"
        extra_headers = {}

    class Defaults:
        model = "test-model"

    class Agents:
        defaults = Defaults()

    class ConfigRef:
        agents = Agents()

        def get_provider(self, model):
            return Provider()

        def get_api_base(self, model):
            return "https://example.test/v1"

    active_calls = 0
    max_active_calls = 0
    lock = threading.Lock()

    class FakeResponse:
        def __init__(self, content: str):
            self.content = content

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": self.content}}]}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            nonlocal active_calls, max_active_calls
            prompt = kwargs["json"]["messages"][0]["content"]
            with lock:
                active_calls += 1
                max_active_calls = max(max_active_calls, active_calls)
            time.sleep(0.05)
            with lock:
                active_calls -= 1
            if "GraphRAG supports community reports" in prompt:
                content = (
                    "{"
                    '"entities": [{"title": "GraphRAG", "type": "technology", "confidence": 0.9},'
                    '{"title": "community reports", "type": "business_object", "confidence": 0.9}],'
                    '"relationships": [{"source": "GraphRAG", "predicate": "supports", '
                    '"target": "community reports", "evidence": "GraphRAG supports community reports.", '
                    '"confidence": 0.9}]'
                    "}"
                )
            else:
                content = (
                    "{"
                    '"entities": [{"title": "TinyBot", "type": "product", "confidence": 0.9},'
                    '{"title": "RAG", "type": "technology", "confidence": 0.9}],'
                    '"relationships": [{"source": "TinyBot", "predicate": "supports", '
                    '"target": "RAG", "evidence": "TinyBot supports RAG.", "confidence": 0.9}]'
                    "}"
                )
            return FakeResponse(content)

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=32,
            chunk_overlap=0,
            semantic_extraction_mode="llm",
            semantic_llm_concurrency=2,
        ),
        config_ref=ConfigRef(),
    )
    store.add_document(
        name="Concurrent LLM extraction",
        content="TinyBot supports RAG.\n\nGraphRAG supports community reports.",
        file_type="txt",
    )

    entity_names = {entity.name for entity in store._read_entities()}
    assert {"TinyBot", "RAG", "GraphRAG", "community reports"}.issubset(entity_names)
    assert store.get_stats()["relation_count"] == 2
    assert max_active_calls > 1
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_rebuild_job_runs_in_background() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, chunk_overlap=0),
    )
    store.add_document(
        name="Background rebuild",
        content="TinyBot supports RAG. RAG depends on embeddings.",
        file_type="txt",
    )

    class Request:
        app = {"knowledge_store": store}

    job = _start_rebuild_job(Request(), rebuild_type="all")

    deadline = time.time() + 5
    jobs = Request.app["knowledge_jobs"]
    while time.time() < deadline and jobs[job["id"]]["status"] not in {"completed", "failed"}:
        time.sleep(0.02)

    assert jobs[job["id"]]["status"] == "completed"
    assert jobs[job["id"]]["stage"] == "completed"
    assert jobs[job["id"]]["processed"] == jobs[job["id"]]["total"]
    assert "semantic" in jobs[job["id"]]["result"]
    assert jobs[job["id"]]["stage_details"]
    assert any(detail["stage"] == "community_report_projection" for detail in jobs[job["id"]]["stage_details"])
    shutil.rmtree(workspace.parent, ignore_errors=True)
