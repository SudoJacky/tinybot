from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from tinybot.agent.context import ContextBuilder
from tinybot.agent.memory import MemoryNote, MemorySource


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
