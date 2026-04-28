from pathlib import Path
import shutil
import uuid

from tinybot.agent.knowledge import KnowledgeStore
from tinybot.config.schema import KnowledgeConfig


def _workspace() -> Path:
    path = Path("tests") / ".tmp_knowledge_preprocessing" / uuid.uuid4().hex
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_markdown_chunks_keep_raw_content_and_use_clean_retrieval_text() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(
            chunk_size=1000,
            child_chunk_size=80,
            retrieval_mode="sparse",
        ),
    )

    doc_id = store.add_document(
        name="Markdown Notes",
        content=(
            "---\n"
            "title: Demo\n"
            "---\n"
            "# Overview\n"
            "- **TinyBot** supports [RAG](https://example.test/rag).\n"
            "| Feature | Benefit |\n"
            "| --- | --- |\n"
            "| BM25 | keyword matching |\n"
            "```python\n"
            "def build_index():\n"
            "    return 'ok'\n"
            "```\n"
        ),
        file_type="md",
    )

    chunks = store._read_chunks()
    parent = next(chunk for chunk in chunks if chunk.doc_id == doc_id and chunk.chunk_type == "parent")

    assert "**TinyBot**" in parent.content
    assert "**" not in parent.retrieval_text
    assert "https://example.test/rag" not in parent.retrieval_text
    assert "TinyBot supports RAG" in parent.context_content
    assert "Section: Overview" in parent.semantic_text

    results = store.query("keyword matching BM25", top_k=3, mode="sparse")
    assert results
    assert results[0]["chunk_type"] == "parent"
    assert "BM25" in results[0]["content"]
    assert results[0]["matched_child_snippets"]
    shutil.rmtree(workspace.parent, ignore_errors=True)


def test_pdf_preprocessing_removes_repeated_edges_and_merges_soft_lines() -> None:
    workspace = _workspace()
    store = KnowledgeStore(
        workspace,
        config=KnowledgeConfig(chunk_size=1000, child_chunk_size=80),
    )

    pages = [
        {
            "content": "Company Report\n1\nThis is hyphen-\nated text\nthat continues\nacross lines.\nConfidential",
            "page": 1,
            "start_char": 0,
            "end_char": 88,
        },
        {
            "content": "Company Report\n2\nAnother formal\nparagraph continues\non the next line.\nConfidential",
            "page": 2,
            "start_char": 90,
            "end_char": 170,
        },
        {
            "content": "Company Report\n3\nFinal page content\nkeeps useful text.\nConfidential",
            "page": 3,
            "start_char": 172,
            "end_char": 240,
        },
    ]

    processed = store._preprocess_pdf_pages(pages)

    assert all("Company Report" not in page["content"] for page in processed)
    assert all("Confidential" not in page["content"] for page in processed)
    assert "hyphenated text that continues across lines." in processed[0]["content"]
    shutil.rmtree(workspace.parent, ignore_errors=True)
