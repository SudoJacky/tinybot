from pathlib import Path
import shutil
import uuid

from tinybot.agent.knowledge import KnowledgeStore
from tinybot.config.schema import KnowledgeConfig


def _workspace() -> Path:
    path = Path("tests") / ".tmp_knowledge_rerank" / uuid.uuid4().hex
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_apply_rerank_response_reorders_candidates() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(rerank_enabled=True, rerank_model="qwen3-rerank"),
    )
    candidates = [
        {"id": "chunk_1", "content": "first", "rrf_score": 0.1, "method": "hybrid"},
        {"id": "chunk_2", "content": "second", "rrf_score": 0.2, "method": "hybrid"},
        {"id": "chunk_3", "content": "third", "rrf_score": 0.3, "method": "hybrid"},
    ]

    reranked = store._apply_rerank_response(
        candidates,
        {
            "results": [
                {"index": 2, "relevance_score": 0.92},
                {"index": 0, "relevance_score": 0.61},
            ]
        },
        top_n=2,
    )

    assert [r["id"] for r in reranked] == ["chunk_3", "chunk_1"]
    assert reranked[0]["rerank_score"] == 0.92
    assert reranked[0]["rerank_rank"] == 1
    assert reranked[0]["pre_rerank_score"] == 0.3
    assert reranked[0]["method"] == "hybrid+rerank"
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_rerank_candidate_count_fetches_extra_candidates() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(rerank_enabled=True, rerank_top_n=4),
    )

    assert store._rerank_candidate_count(5) == 15
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_rerank_candidate_count_is_unchanged_when_disabled() -> None:
    workspace = _workspace()
    store = KnowledgeStore(workspace, config=KnowledgeConfig(rerank_enabled=False))

    assert store._rerank_candidate_count(5) == 5
    shutil.rmtree(workspace.parent, ignore_errors=True)
