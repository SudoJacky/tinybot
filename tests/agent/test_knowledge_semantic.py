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
    assert supports_edges[0]["combined_degree"] >= 2
    assert supports_edges[0]["text_unit_ids"]
    assert "TinyBot supports RAG" in supports_edges[0]["description"]

    text_unit = index["text_units"][0]
    assert text_unit["document_id"] == doc_id
    assert text_unit["entity_ids"]
    assert text_unit["relationship_ids"]
    assert text_unit["covariate_ids"]
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
