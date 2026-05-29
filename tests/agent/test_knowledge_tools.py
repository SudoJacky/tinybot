import pytest

from tinybot.agent.tools.knowledge import QueryKnowledgeTool


class FakeKnowledgeStore:
    def query(self, **kwargs):
        return [
            {
                "doc_id": "doc-1",
                "doc_name": "traceable.md",
                "content": "TinyBot supports traceable knowledge answers.",
                "file_path": "docs/traceable.md",
                "start_char": 10,
                "end_char": 60,
                "method": "hybrid",
                "source_snippets": [
                    {
                        "text": "TinyBot supports source citations.",
                        "doc_name": "traceable.md",
                        "line_start": 4,
                        "line_end": 4,
                    }
                ],
                "matched_claims": ["TinyBot supports RAG."],
                "matched_claim_evidence": [
                    {
                        "source": {
                            "doc_name": "traceable.md",
                            "line_start": 4,
                            "line_end": 4,
                            "evidence_text": "TinyBot supports source citations.",
                        }
                    }
                ],
                "matched_relations": ["TinyBot -[supports]-> RAG"],
                "matched_relation_evidence": [
                    {
                        "predicate": "supports",
                        "evidence_text": "TinyBot supports RAG.",
                        "doc_name": "traceable.md",
                    }
                ],
                "conflict_metadata": [
                    {"conflict_type": "claim_polarity", "evidence_text": "A source says it is stale."}
                ],
                "projection_metadata": [{"title": "RAG architecture", "projection_type": "community_report"}],
            }
        ]


@pytest.mark.asyncio
async def test_query_knowledge_tool_returns_traceable_contextual_evidence() -> None:
    tool = QueryKnowledgeTool(FakeKnowledgeStore())

    output = await tool.execute(query="traceable rag")

    assert "contextual evidence" in output
    assert "**Source snippets**" in output
    assert "TinyBot supports source citations. (traceable.md L4-4)" in output
    assert "**Claims**" in output
    assert "TinyBot supports RAG." in output
    assert "**Relations**" in output
    assert "TinyBot -[supports]-> RAG" in output
    assert "**Conflicts**" in output
    assert "claim_polarity: A source says it is stale." in output
    assert "**Derived projections**" in output
    assert "RAG architecture (community_report)" in output
