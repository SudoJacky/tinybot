from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from tinybot.agent.context import ContextBuilder
from tinybot.agent.memory import ConversationEvidence, MemoryNote, MemorySource, RecentContextCandidate


def test_context_builder_injects_memory_recall_as_distinct_section(tmp_path):
    builder = ContextBuilder(tmp_path)
    source = MemorySource.explicit(session_key="cli:test")
    builder.memory.upsert_note(
        MemoryNote.create(
            "Use uv run pytest for Python validation.",
            "instruction",
            [source],
            priority=0.9,
            confidence=0.8,
            tags=["python", "tests"],
        )
    )

    messages = builder.build_messages(
        history=[],
        current_message="Please add Python validation tests for this memory feature.",
        channel="cli",
        chat_id="test",
    )

    recall_messages = [
        message for message in messages if message["role"] == "system" and "[MEMORY RECALL]" in message["content"]
    ]
    assert len(recall_messages) == 1
    assert "Use uv run pytest for Python validation." in recall_messages[0]["content"]
    assert "[RELEVANT WORKFLOWS]" not in recall_messages[0]["content"]
    assert "[RELEVANT KNOWLEDGE]" not in recall_messages[0]["content"]
    assert builder.last_memory_references
    assert builder.last_memory_references[0]["content"] == "Use uv run pytest for Python validation."
    assert builder.last_memory_references[0]["file"] == "memory/notes.jsonl"
    assert builder.last_memory_references[0]["line"] == 1


def test_context_builder_shows_memory_references_for_short_preference_questions(tmp_path):
    builder = ContextBuilder(tmp_path)
    source = MemorySource.explicit(session_key="websocket:test")
    builder.memory.upsert_note(
        MemoryNote.create(
            "The user likes eating strawberries (草莓).",
            "preference",
            [source],
            scope="user",
            priority=0.5,
            confidence=0.8,
        )
    )

    messages = builder.build_messages(
        history=[],
        current_message="我喜欢吃什么",
        channel="websocket",
        chat_id="test",
    )

    recall_messages = [
        message for message in messages if message["role"] == "system" and "[MEMORY RECALL]" in message["content"]
    ]
    assert len(recall_messages) == 1
    assert "strawberries" in recall_messages[0]["content"]
    assert builder.last_memory_references[0]["content"] == "The user likes eating strawberries (草莓)."


def test_context_builder_keeps_memory_experience_and_knowledge_paths_separate(tmp_path):
    experience_store = MagicMock()
    experience = SimpleNamespace(
        id="exp-1",
        experience_type="workflow",
        context_summary="Python test workflow",
        tool_name="pytest",
        action_hint="Run focused tests",
        applicability="Python validation work",
        resolution="Use uv run pytest",
        confidence=0.8,
        category="testing",
    )
    experience_store.search_workflows.return_value = [experience]
    experience_store.search_semantic.return_value = []

    knowledge_store = MagicMock()
    knowledge_store.query.return_value = [
        {
            "doc_name": "testing-guide.md",
            "content": "Knowledge Base evidence about validation.",
            "summary": "",
            "line_start": 3,
            "line_end": 5,
        }
    ]

    builder = ContextBuilder(
        tmp_path,
        experience_store=experience_store,
        knowledge_store=knowledge_store,
    )
    source = MemorySource.explicit(session_key="cli:test")
    builder.memory.upsert_note(
        MemoryNote.create(
            "Memory Notes should stay separate from Knowledge Base snippets.",
            "decision",
            [source],
            priority=0.9,
            confidence=0.8,
        )
    )

    messages = builder.build_messages(
        history=[],
        current_message="Use the memory notes and knowledge guide for Python validation.",
        channel="cli",
        chat_id="test",
    )
    sections = [message["content"] for message in messages if message["role"] == "system"]

    memory_section = next(section for section in sections if "[MEMORY RECALL]" in section)
    experience_section = next(section for section in sections if "[RELEVANT WORKFLOWS]" in section)
    knowledge_section = next(section for section in sections if "[RELEVANT KNOWLEDGE]" in section)

    assert "Memory Notes should stay separate" in memory_section
    assert "Python test workflow" in experience_section
    assert "Knowledge Base evidence" in knowledge_section
    assert "[RELEVANT WORKFLOWS]" not in memory_section
    assert "[RELEVANT KNOWLEDGE]" not in memory_section
    assert "[MEMORY RECALL]" not in experience_section
    assert "[MEMORY RECALL]" not in knowledge_section


def test_knowledge_context_prioritizes_source_snippets_before_derived_claims() -> None:
    formatted = ContextBuilder._format_knowledge_results(
        [
            {
                "doc_name": "traceable.md",
                "content": "Derived projection summary should not be first.",
                "source_snippets": [
                    {
                        "text": "TinyBot supports RAG.",
                        "doc_name": "traceable.md",
                        "line_start": 4,
                        "line_end": 4,
                    }
                ],
                "matched_claim_evidence": [
                    {
                        "text": "TinyBot supports RAG.",
                        "source": {"doc_name": "traceable.md", "line_start": 4, "line_end": 4},
                    }
                ],
                "projection_metadata": [{"title": "TinyBot / RAG", "projection_type": "community_report"}],
                "matched_claims": ["TinyBot supports RAG."],
            }
        ]
    )

    source_index = formatted.index("Source snippets:")
    claim_index = formatted.index("Claim evidence:")
    projection_index = formatted.index("Derived projections:")
    assert source_index < claim_index < projection_index
    assert "TinyBot supports RAG." in formatted


def test_context_builder_injects_recent_context_for_preparation_prompt(tmp_path):
    builder = ContextBuilder(tmp_path)
    evidence = builder.memory.append_conversation_evidence(
        [
            ConversationEvidence.create(
                session_key="websocket:old",
                turn_id="turn_trip",
                role="user",
                content="I have a flight to Tokyo tomorrow and need to pack light.",
                timestamp="2999-05-18T10:00:00Z",
            )
        ]
    )[0]

    messages = builder.build_messages(
        history=[],
        current_message="What should I prepare?",
        channel="websocket",
        chat_id="new",
    )

    recent_messages = [
        message for message in messages if message["role"] == "system" and "[RECENT CONTEXT]" in message["content"]
    ]
    assert len(recent_messages) == 1
    assert "Recent conversation evidence" in recent_messages[0]["content"]
    assert "Tokyo tomorrow" in recent_messages[0]["content"]
    assert builder.last_recent_context_references[0]["evidence_id"] == evidence.id
    assert builder.last_recent_context_references[0]["file"] == "memory/conversations/2999-05-18.jsonl"
    assert builder.last_memory_references == []


def test_context_builder_skips_recent_context_for_simple_greeting(tmp_path):
    builder = ContextBuilder(tmp_path)
    builder.memory.append_conversation_evidence(
        [
            ConversationEvidence.create(
                session_key="websocket:old",
                turn_id="turn_trip",
                role="user",
                content="I have a flight to Tokyo tomorrow.",
                timestamp="2999-05-18T10:00:00Z",
            )
        ]
    )

    messages = builder.build_messages(
        history=[],
        current_message="hi",
        channel="websocket",
        chat_id="new",
    )

    assert not any(message["role"] == "system" and "[RECENT CONTEXT]" in message["content"] for message in messages)
    assert builder.last_recent_context_references == []


def test_recent_context_ranking_prefers_recent_user_future_plan():
    older_assistant = RecentContextCandidate(
        evidence_id="ev_old",
        excerpt="You may want to bring a charger.",
        timestamp="2026-05-11T10:00:00Z",
        session_key="websocket:old",
        role="assistant",
        turn_id="turn_old",
        cursor=1,
    )
    recent_user = RecentContextCandidate(
        evidence_id="ev_recent",
        excerpt="I have a flight to Tokyo tomorrow and a hotel reservation.",
        timestamp="2999-05-18T10:00:00Z",
        session_key="websocket:recent",
        role="user",
        turn_id="turn_recent",
        cursor=2,
    )

    ranked = ContextBuilder._rank_recent_context_candidates(
        "What should I prepare for the trip?",
        [older_assistant, recent_user],
        max_records=2,
    )

    assert ranked[0].evidence_id == "ev_recent"
    assert ranked[0].score_inputs["future_plan_marker"] is True
