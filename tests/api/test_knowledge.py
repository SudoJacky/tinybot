"""Tests for knowledge API traceability payloads."""

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import pytest

from tinybot.api.knowledge import _job_snapshot, register_knowledge_routes


async def _client(app: web.Application) -> TestClient:
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


class FakeKnowledgeStore:
    def query(self, **kwargs):
        return [
            {
                "id": "chunk_doc_1_0",
                "parent_id": "chunk_doc_1_0",
                "chunk_type": "parent",
                "content": "TinyBot supports RAG.",
                "doc_id": "doc_1",
                "doc_name": "Traceable API",
                "score_metadata": {"score": 0.9, "confidence": 0.9},
                "source_snippets": [{"doc_id": "doc_1", "chunk_id": "chunk_doc_1_0", "text": "TinyBot supports RAG."}],
                "retrieval_method": "hybrid",
                "matched_claims": ["TinyBot supports RAG."],
                "matched_claim_evidence": [{"id": "claim_1", "source": {"doc_id": "doc_1"}}],
                "matched_relations": ["TinyBot supports RAG"],
                "matched_relation_evidence": [{"id": "rel_1", "source_refs": [{"doc_id": "doc_1"}]}],
                "conflict_metadata": [],
                "projection_metadata": [{"id": "crep_1", "projection_type": "community_report"}],
                "method": "hybrid",
                "matched_methods": ["sparse"],
            }
        ]

    def get_stats(self):
        return {
            "document_count": 1,
            "chunk_count": 1,
            "total_chars": 24,
            "categories": {"uncategorized": 1},
            "indexed_dense": 0,
            "indexed_sparse": 1,
            "entity_count": 2,
            "claim_count": 1,
            "relation_count": 1,
            "community_count": 1,
            "community_count_by_level": {"0": 1},
            "community_report_count": 1,
            "stage_details": [{"stage": "graph_projection", "status": "stale", "stale": 1}],
            "stage_readiness": {"graph_projection": {"ready": False, "stale": 1}},
            "stage_coverage": {"graph_projection": {"processed": 1, "total": 1, "stale": 1}},
            "failed_stage_count": 0,
            "stale_stage_count": 1,
            "retrieval_ready": True,
            "claims_ready": True,
            "relations_ready": True,
            "graph_ready": False,
            "partial_availability": True,
        }


@pytest.mark.asyncio
async def test_query_endpoint_preserves_existing_fields_and_adds_traceability() -> None:
    app = web.Application()
    app["knowledge_store"] = FakeKnowledgeStore()
    register_knowledge_routes(app)
    client = await _client(app)
    try:
        response = await client.post("/v1/knowledge/query", json={"query": "TinyBot"})
        assert response.status == 200
        payload = await response.json()
        item = payload["data"][0]
        assert item["content"] == "TinyBot supports RAG."
        assert item["matched_claims"] == ["TinyBot supports RAG."]
        assert item["source_snippets"][0]["doc_id"] == "doc_1"
        assert item["retrieval_method"] == "hybrid"
        assert item["matched_claim_evidence"][0]["id"] == "claim_1"
        assert item["matched_relation_evidence"][0]["id"] == "rel_1"
        assert item["projection_metadata"][0]["projection_type"] == "community_report"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_stats_endpoint_exposes_readiness_and_partial_state() -> None:
    app = web.Application()
    app["knowledge_store"] = FakeKnowledgeStore()
    register_knowledge_routes(app)
    client = await _client(app)
    try:
        response = await client.get("/v1/knowledge/stats")
        assert response.status == 200
        payload = await response.json()
        assert payload["total_documents"] == 1
        assert payload["stage_readiness"]["graph_projection"]["ready"] is False
        assert payload["stage_coverage"]["graph_projection"]["stale"] == 1
        assert payload["graph_ready"] is False
        assert payload["partial_availability"] is True
        assert payload["stale_stage_count"] == 1
    finally:
        await client.close()


def test_job_snapshot_exposes_partial_readiness_summary() -> None:
    snapshot = _job_snapshot(
        {
            "id": "kjob_1",
            "status": "completed",
            "stage": "completed",
            "processed": 1,
            "total": 1,
            "stage_details": [
                {"stage": "sparse_indexing", "status": "complete", "failed": 0, "stale": 0},
                {"stage": "graph_projection", "status": "stale", "failed": 0, "stale": 1},
            ],
        }
    )

    assert snapshot["stage_details"]
    assert snapshot["stale_stage_count"] == 1
    assert snapshot["failed_stage_count"] == 0
    assert snapshot["graph_ready"] is False
    assert snapshot["partial_availability"] is True


def test_job_snapshot_requires_both_graph_projection_stages() -> None:
    snapshot = _job_snapshot(
        {
            "id": "kjob_2",
            "status": "running",
            "stage": "graph_projection",
            "processed": 1,
            "total": 2,
            "stage_details": [
                {"stage": "sparse_indexing", "status": "complete", "failed": 0, "stale": 0},
                {"stage": "graph_projection", "status": "complete", "failed": 0, "stale": 0},
            ],
        }
    )

    assert snapshot["graph_ready"] is False
    assert snapshot["partial_availability"] is True
