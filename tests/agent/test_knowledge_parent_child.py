from pathlib import Path
import shutil
import uuid

from tinybot.agent.knowledge import KnowledgeStore
from tinybot.config.schema import KnowledgeConfig


def _workspace() -> Path:
    path = Path("tests") / ".tmp_knowledge_parent_child" / uuid.uuid4().hex
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_child_matches_expand_to_deduplicated_parent_chunks() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=80,
            child_chunk_size=35,
            child_chunk_overlap=8,
            retrieval_mode="sparse",
        ),
    )

    store.add_document(
        name="RAG Strategy",
        content=(
            "Parent Alpha introduces retrieval. It explains dense embeddings. "
            "BM25 keyword matching is also described.\n\n"
            "Parent Beta discusses deployment. It mentions monitoring and rollout."
        ),
        file_type="txt",
    )

    stats = store.get_stats()
    assert stats["parent_chunk_count"] == 2
    assert stats["child_chunk_count"] > stats["parent_chunk_count"]

    results = store.query("dense embeddings BM25", top_k=3, mode="sparse")

    assert len(results) == 1
    assert results[0]["chunk_type"] == "parent"
    assert "Parent Alpha" in results[0]["content"]
    assert "BM25 keyword matching" in results[0]["content"]
    assert results[0]["matched_child_ids"]
    assert results[0]["matched_child_snippets"]
    shutil.rmtree(workspace.parent, ignore_errors=True)
