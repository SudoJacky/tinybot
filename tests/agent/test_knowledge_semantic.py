from pathlib import Path
import shutil
import uuid

from tinybot.agent.knowledge import KnowledgeStore
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
