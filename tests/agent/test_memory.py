import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from tinybot.agent.memory import (
    ConversationEvidence,
    Dream,
    MemoryCaptureOrigin,
    MemoryNote,
    MemoryNoteScope,
    MemoryNoteStatus,
    MemoryNoteType,
    MemorySource,
    MemoryStore,
    capture_conversation_evidence,
    generate_memory_note_id,
)


class _FakeMemoryNoteCollection:
    def __init__(self):
        self.items = {}
        self.query_ids = []

    def count(self):
        return len(self.items)

    def get(self):
        return {"ids": list(self.items)}

    def delete(self, ids):
        for item_id in ids:
            self.items.pop(item_id, None)

    def upsert(self, ids, documents, metadatas):
        for item_id, document, metadata in zip(ids, documents, metadatas, strict=False):
            self.items[item_id] = {"document": document, "metadata": metadata}

    def query(self, query_texts, n_results, where=None, include=None):
        del query_texts, where, include
        ids = self.query_ids or list(self.items)
        return {"ids": [ids[:n_results]], "distances": [[0.1 for _ in ids[:n_results]]]}


class _FakeMemoryNoteVectorStore:
    def __init__(self):
        self.collection = _FakeMemoryNoteCollection()

    def _get_or_create_collection(self, collection_name):
        assert collection_name == "agent_memory_notes"
        return self.collection

    def _get_collection(self, collection_name):
        assert collection_name == "agent_memory_notes"
        return self.collection


def test_memory_note_serializes_and_round_trips(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource(
        capture_origin=MemoryCaptureOrigin.EXPLICIT,
        session_key="cli:default",
        message_start=2,
        message_end=3,
    )
    note = MemoryNote.create(
        "Use uv for Python commands.",
        MemoryNoteType.INSTRUCTION,
        [source],
        priority=0.9,
        confidence=0.8,
        tags=["python", "tooling"],
    )

    stored = store.upsert_note(note)
    loaded = store.read_notes()

    assert len(loaded) == 1
    assert loaded[0].id == stored.id
    assert loaded[0].type == MemoryNoteType.INSTRUCTION
    assert loaded[0].status == MemoryNoteStatus.ACTIVE
    assert loaded[0].sources[0].capture_origin == MemoryCaptureOrigin.EXPLICIT
    assert loaded[0].sources[0].session_key == "cli:default"
    assert loaded[0].priority == pytest.approx(0.9)
    assert loaded[0].confidence == pytest.approx(0.8)
    assert loaded[0].tags == ["python", "tooling"]


def test_legacy_note_hydration_uses_safe_defaults(tmp_path):
    store = MemoryStore(tmp_path)
    store.notes_file.write_text(
        json.dumps(
            {
                "content": "Legacy note without newer fields.",
                "sources": [{"origin": "migration", "source_file": "MEMORY.md"}],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    note = store.read_notes()[0]

    assert note.type == MemoryNoteType.PROJECT
    assert note.status == MemoryNoteStatus.ACTIVE
    assert note.priority == pytest.approx(0.5)
    assert note.confidence == pytest.approx(0.5)
    assert note.id == generate_memory_note_id(note.type, note.content, note.sources)
    assert note.sources[0].capture_origin == MemoryCaptureOrigin.MIGRATION


def test_duplicate_detection_uses_equivalent_content_and_sources(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource(
        capture_origin=MemoryCaptureOrigin.MIGRATION,
        source_file="memory/MEMORY.md",
    )
    original = MemoryNote.create("Remember  the API choice", "decision", [source])
    duplicate = MemoryNote.create(" remember the api choice ", "decision", [source])

    stored = store.upsert_note(original)
    duplicate_result = store.find_duplicate_note(duplicate)
    upserted = store.upsert_note(duplicate)

    assert duplicate_result is not None
    assert duplicate_result.id == stored.id
    assert upserted.id == stored.id
    assert len(store.read_notes()) == 1


def test_note_lifecycle_reject_and_supersede(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource(capture_origin=MemoryCaptureOrigin.EXPLICIT, session_key="cli:default")
    old_note = store.upsert_note(MemoryNote.create("Use pytest directly.", "instruction", [source]))

    rejected = store.reject_note(old_note.id)
    assert rejected.status == MemoryNoteStatus.REJECTED

    replacement = MemoryNote.create("Use uv run pytest when validating tests.", "instruction", [source])
    stored_replacement = store.supersede_note(old_note.id, replacement)
    notes = {note.id: note for note in store.read_notes()}

    assert notes[old_note.id].status == MemoryNoteStatus.SUPERSEDED
    assert notes[old_note.id].superseded_by == stored_replacement.id
    assert notes[stored_replacement.id].status == MemoryNoteStatus.ACTIVE
    assert old_note.id in notes[stored_replacement.id].supersedes


def test_memory_source_helpers_capture_trace_fields():
    dream = MemorySource.dream(history_start_cursor=4, history_end_cursor=9)
    explicit = MemorySource.explicit(
        session_key="cli:default",
        message_start=1,
        message_end=2,
    )
    migrated = MemorySource.migration("memory/MEMORY.md")

    assert dream.capture_origin == MemoryCaptureOrigin.DREAM
    assert dream.history_start_cursor == 4
    assert dream.history_end_cursor == 9
    assert explicit.capture_origin == MemoryCaptureOrigin.EXPLICIT
    assert explicit.session_key == "cli:default"
    assert explicit.message_start == 1
    assert explicit.message_end == 2
    assert migrated.capture_origin == MemoryCaptureOrigin.MIGRATION
    assert migrated.source_file == "memory/MEMORY.md"


def test_conversation_evidence_append_read_cursor_and_capture(tmp_path):
    store = MemoryStore(tmp_path)
    messages = [
        {"role": "system", "content": "runtime prompt"},
        {"role": "user", "content": "Remember that I prefer concise updates.", "timestamp": "2026-05-18T10:00:00"},
        {"role": "assistant", "tool_calls": [{"id": "call_1"}], "content": ""},
        {"role": "tool", "content": "tool result"},
        {"role": "assistant", "content": "Noted. I will keep updates concise.", "timestamp": "2026-05-18T10:00:02"},
    ]

    written = capture_conversation_evidence(
        store,
        session_key="cli:test",
        messages=messages,
        start_index=3,
    )

    assert [record.role for record in written] == ["user", "assistant"]
    assert all(record.cursor for record in written)
    assert written[0].message_index == 4
    assert written[1].message_index == 7
    assert len(store.read_pending_conversation_evidence()) == 2

    store.set_last_evidence_cursor(written[0].cursor or 0)
    pending = store.read_pending_conversation_evidence()
    assert [record.id for record in pending] == [written[1].id]

    duplicate = capture_conversation_evidence(
        store,
        session_key="cli:test",
        messages=messages,
        start_index=3,
    )
    assert duplicate == []


def test_memory_source_and_note_preserve_evidence_scope_and_metadata(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.dream(evidence_ids=["ev_1", "ev_2"])
    note = store.upsert_note(
        MemoryNote.create(
            "User prefers concise updates.",
            "preference",
            [source],
            scope="user",
            metadata={"reason": "explicit preference"},
            tags=["dream"],
        )
    )

    loaded = store.read_notes()[0]
    assert loaded.scope == MemoryNoteScope.USER
    assert loaded.metadata == {"reason": "explicit preference"}
    assert loaded.sources[0].evidence_ids == ["ev_1", "ev_2"]
    assert loaded.sources[0].identity() == MemorySource.dream(evidence_ids=["ev_other"]).identity()
    assert note.id == generate_memory_note_id("preference", "User prefers concise updates.", [source], scope="user")


def test_legacy_note_loading_infers_scope(tmp_path):
    store = MemoryStore(tmp_path)
    store.notes_file.write_text(
        json.dumps(
            {
                "id": "note_legacy",
                "type": "instruction",
                "status": "active",
                "content": "Be direct.",
                "priority": 0.5,
                "confidence": 0.5,
                "sources": [],
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    loaded = store.read_notes()[0]
    assert loaded.scope == MemoryNoteScope.ASSISTANT
    assert loaded.metadata == {}


def test_legacy_migration_creates_conservative_notes_and_preserves_files(tmp_path):
    store = MemoryStore(tmp_path)
    store.memory_file.write_text(
        "# Memory\n\n- Project uses source-linked swarm wording.\n\nKeep maintainer docs separate.",
        encoding="utf-8",
    )
    store.user_file.write_text("- User prefers uv commands.", encoding="utf-8")
    store.soul_file.write_text("## Soul\n\nAvoid vendor API names in tinybot surfaces.", encoding="utf-8")
    original_memory = store.memory_file.read_text(encoding="utf-8")

    migrated = store.migrate_legacy_memory_notes()
    notes = store.read_notes()

    assert len(migrated) == 4
    assert len(notes) == 4
    assert store.memory_file.read_text(encoding="utf-8") == original_memory
    assert {note.type for note in notes} == {
        MemoryNoteType.PROJECT,
        MemoryNoteType.PREFERENCE,
        MemoryNoteType.INSTRUCTION,
    }
    assert all(note.confidence == pytest.approx(0.45) for note in notes)
    assert all(note.status == MemoryNoteStatus.ACTIVE for note in notes)
    assert {note.sources[0].source_file for note in notes} == {
        "memory/MEMORY.md",
        "USER.md",
        "SOUL.md",
    }


def test_legacy_migration_is_idempotent_and_legacy_context_still_loads(tmp_path):
    store = MemoryStore(tmp_path)
    store.memory_file.write_text("- Keep legacy context usable.", encoding="utf-8")

    first = store.migrate_legacy_memory_notes()
    second = store.migrate_legacy_memory_notes()

    assert [note.id for note in first] == [note.id for note in second]
    assert len(store.read_notes()) == 1
    assert "Keep legacy context usable." in store.get_memory_context()


def test_memory_view_rendering_writes_active_notes_to_managed_sections(tmp_path):
    store = MemoryStore(tmp_path)
    store.memory_file.write_text("# Existing Memory\n\nKeep this paragraph.", encoding="utf-8")
    source = MemorySource.explicit(session_key="cli:default")
    project_note = store.upsert_note(
        MemoryNote.create(
            "Use the Memory Notes store as canonical agent memory.",
            MemoryNoteType.PROJECT,
            [source],
            priority=0.8,
            confidence=0.9,
            tags=["agent-memory"],
        )
    )
    store.upsert_note(MemoryNote.create("User prefers concise summaries.", MemoryNoteType.PREFERENCE, [source]))
    store.upsert_note(MemoryNote.create("Speak directly and avoid vague claims.", MemoryNoteType.INSTRUCTION, [source]))

    rendered = store.refresh_memory_views()

    memory_content = store.read_memory()
    user_content = store.read_user()
    soul_content = store.read_soul()
    assert "# Existing Memory" in memory_content
    assert "Keep this paragraph." in memory_content
    assert "Use the Memory Notes store as canonical agent memory." in memory_content
    assert project_note.id in rendered["memory/MEMORY.md"]
    assert "User prefers concise summaries." in user_content
    assert "Speak directly and avoid vague claims." in soul_content


def test_memory_views_exclude_rejected_and_superseded_notes(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:default")
    active = store.upsert_note(MemoryNote.create("Keep active project note.", MemoryNoteType.PROJECT, [source]))
    rejected = store.upsert_note(MemoryNote.create("Do not show rejected note.", MemoryNoteType.PROJECT, [source]))
    superseded = store.upsert_note(MemoryNote.create("Do not show superseded note.", MemoryNoteType.PROJECT, [source]))
    store.reject_note(rejected.id)
    store.supersede_note(
        superseded.id,
        MemoryNote.create("Show replacement note.", MemoryNoteType.PROJECT, [source]),
    )

    rendered = store.refresh_memory_views()["memory/MEMORY.md"]

    assert active.content in rendered
    assert "Show replacement note." in rendered
    assert rejected.content not in rendered
    assert superseded.content not in rendered


def test_memory_recall_orders_by_relevance_priority_and_budget(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:default")
    first = store.upsert_note(
        MemoryNote.create(
            "Use uv run pytest for Python validation.",
            MemoryNoteType.INSTRUCTION,
            [source],
            priority=0.7,
            confidence=0.8,
            tags=["python", "tests"],
        )
    )
    second = store.upsert_note(
        MemoryNote.create(
            "Prefer concise implementation progress updates.",
            MemoryNoteType.PREFERENCE,
            [source],
            priority=0.95,
            confidence=0.7,
            tags=["communication"],
        )
    )
    store.upsert_note(
        MemoryNote.create(
            "Unrelated but important repository decision.",
            MemoryNoteType.DECISION,
            [source],
            priority=0.9,
            confidence=0.7,
        )
    )

    selected = store.select_memory_recall(
        "Please add Python tests and validation.",
        max_notes=2,
        max_chars=1_000,
    )

    assert [note.id for note in selected] == [first.id, second.id]


def test_memory_recall_excludes_inactive_notes_by_default(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:default")
    active = store.upsert_note(MemoryNote.create("Active Python testing note.", "instruction", [source]))
    rejected = store.upsert_note(MemoryNote.create("Rejected Python testing note.", "instruction", [source]))
    superseded = store.upsert_note(MemoryNote.create("Superseded Python testing note.", "instruction", [source]))
    store.reject_note(rejected.id)
    store.supersede_note(
        superseded.id,
        MemoryNote.create("Replacement Python testing note.", "instruction", [source]),
    )

    context = store.format_memory_recall_context("Python testing validation")

    assert active.content in context
    assert "Replacement Python testing note." in context
    assert rejected.content not in context
    assert superseded.content not in context
    assert "[MEMORY RECALL]" in context


def test_explicit_memory_note_save_search_trace_reject_and_supersede(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:default", message_start=1, message_end=2)

    saved = store.save_memory_note(
        content="Use uv for Python validation commands.",
        note_type="instruction",
        source=source,
        priority=0.9,
        confidence=0.8,
        tags="python, validation, python",
    )
    matches = store.search_memory_notes(query="validation", note_type="instruction", status="active")
    traced = store.trace_memory_note(saved.id)
    rejected = store.reject_memory_note(saved.id)
    replacement = store.supersede_memory_note(
        saved.id,
        replacement_content="Use uv run pytest for Python test validation.",
        source=source,
    )
    notes = {note.id: note for note in store.read_notes()}

    assert matches == [saved]
    assert traced.sources[0].capture_origin == MemoryCaptureOrigin.EXPLICIT
    assert traced.sources[0].session_key == "cli:default"
    assert traced.tags == ["python", "validation"]
    assert rejected.status == MemoryNoteStatus.REJECTED
    assert notes[saved.id].status == MemoryNoteStatus.SUPERSEDED
    assert notes[saved.id].superseded_by == replacement.id
    assert saved.id in notes[replacement.id].supersedes
    assert replacement.content == "Use uv run pytest for Python test validation."


def test_explicit_memory_note_operations_validate_inputs(tmp_path):
    store = MemoryStore(tmp_path)

    with pytest.raises(ValueError, match="content is required"):
        store.save_memory_note(content="", note_type="instruction")
    with pytest.raises(ValueError, match="Invalid Memory Note type"):
        store.save_memory_note(content="Durable note.", note_type="workflow")
    with pytest.raises(ValueError, match="priority must be between 0 and 1"):
        store.save_memory_note(content="Durable note.", note_type="instruction", priority=2)
    with pytest.raises(ValueError, match="Invalid Memory Note status"):
        store.search_memory_notes(status="archived")
    with pytest.raises(KeyError, match="Memory Note not found"):
        store.trace_memory_note("note_missing")


def test_memory_note_lexical_search_fallback_ranks_notes_jsonl(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:test")
    low_priority = store.upsert_note(
        MemoryNote.create(
            "Use Python for one-off repository scripts.",
            MemoryNoteType.INSTRUCTION,
            [source],
            priority=0.4,
        )
    )
    high_priority = store.upsert_note(
        MemoryNote.create(
            "Use uv run pytest for Python validation.",
            MemoryNoteType.INSTRUCTION,
            [source],
            priority=0.9,
            tags=["python", "validation"],
        )
    )
    store.upsert_note(
        MemoryNote.create(
            "Keep maintainer documentation logic-only.",
            MemoryNoteType.PROJECT,
            [source],
            priority=0.95,
        )
    )

    matches = store.search_memory_notes(query="python validation", status="active")

    assert [note.id for note in matches] == [high_priority.id, low_priority.id]


def test_memory_note_vector_search_uses_jsonl_as_canonical_source(tmp_path):
    store = MemoryStore(tmp_path)
    vector_store = _FakeMemoryNoteVectorStore()
    source = MemorySource.explicit(session_key="cli:test")
    active = store.upsert_note(MemoryNote.create("Use uv run pytest for Python validation.", "instruction", [source]))
    rejected = store.upsert_note(
        MemoryNote.create("Use pytest directly for Python validation.", "instruction", [source])
    )
    store.reject_memory_note(rejected.id)
    vector_store.collection.items = {
        "note_missing": {"document": "stale vector", "metadata": {"kind": "memory_note"}},
        rejected.id: {"document": rejected.content, "metadata": {"kind": "memory_note"}},
        active.id: {"document": active.content, "metadata": {"kind": "memory_note"}},
    }
    vector_store.collection.query_ids = ["note_missing", rejected.id, active.id]

    matches = store.search_memory_notes(
        query="python validation",
        status="active",
        vector_store=vector_store,
    )

    assert matches == [active]


def test_memory_note_index_rebuild_recreates_active_notes_from_jsonl(tmp_path):
    store = MemoryStore(tmp_path)
    vector_store = _FakeMemoryNoteVectorStore()
    source = MemorySource.explicit(session_key="cli:test")
    active = store.upsert_note(MemoryNote.create("Active indexed note.", "project", [source]))
    rejected = store.upsert_note(MemoryNote.create("Rejected unindexed note.", "project", [source]))
    store.reject_memory_note(rejected.id)
    vector_store.collection.items = {
        "note_stale": {"document": "old note", "metadata": {"kind": "memory_note"}},
    }

    stats = store.rebuild_memory_note_index(vector_store)

    assert stats == {"available": True, "active_notes": 1, "indexed": 1, "deleted": 1}
    assert set(vector_store.collection.items) == {active.id}
    assert vector_store.collection.items[active.id]["document"] == "Active indexed note. | Type: project"
    assert vector_store.collection.items[active.id]["metadata"]["kind"] == "memory_note"


def test_memory_note_index_rebuild_is_noop_without_vector_store(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:test")
    store.upsert_note(MemoryNote.create("Active JSONL-only note.", "project", [source]))

    stats = store.rebuild_memory_note_index(None)

    assert stats == {"available": False, "active_notes": 1, "indexed": 0, "deleted": 0}


def test_memory_view_refresh_replaces_only_existing_managed_section(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:default")
    store.memory_file.write_text(
        "# Existing Memory\n\n"
        "<!-- tinybot-memory-notes:start -->\n"
        "old managed content\n"
        "<!-- tinybot-memory-notes:end -->\n\n"
        "Unmanaged footer.",
        encoding="utf-8",
    )
    store.upsert_note(MemoryNote.create("Render this active note.", "decision", [source]))

    store.refresh_memory_views()
    memory_content = store.read_memory()

    assert "# Existing Memory" in memory_content
    assert "Unmanaged footer." in memory_content
    assert "Render this active note." in memory_content
    assert "old managed content" not in memory_content
    assert memory_content.count("<!-- tinybot-memory-notes:start -->") == 1


@pytest.mark.asyncio
async def test_dream_creates_notes_refreshes_views_and_advances_cursor(tmp_path):
    store = MemoryStore(tmp_path)
    first_cursor = store.append_history("User confirmed the project uses uv for Python commands.")
    second_cursor = store.append_history("User prefers concise progress updates.")
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(
        return_value=SimpleNamespace(
            content=(
                "[SAVE:MEMORY] Project uses uv for Python commands.\n[SAVE:USER] User prefers concise progress updates."
            )
        )
    )
    dream = Dream(store=store, provider=provider, model="test-model")

    assert await dream.run() is True

    notes = store.read_notes()
    assert len(notes) == 2
    assert {note.type for note in notes} == {MemoryNoteType.PROJECT, MemoryNoteType.PREFERENCE}
    assert all(note.sources[0].capture_origin == MemoryCaptureOrigin.DREAM for note in notes)
    assert all(note.sources[0].history_start_cursor == first_cursor for note in notes)
    assert all(note.sources[0].history_end_cursor == second_cursor for note in notes)
    assert "Project uses uv for Python commands." in store.read_memory()
    assert "User prefers concise progress updates." in store.read_user()
    assert store.get_last_dream_cursor() == second_cursor


@pytest.mark.asyncio
async def test_dream_processes_pending_evidence_before_legacy_history(tmp_path):
    store = MemoryStore(tmp_path)
    store.append_history("Legacy history should wait.")
    evidence = store.append_conversation_evidence(
        [
            ConversationEvidence.create(
                session_key="cli:test",
                turn_id="turn_1",
                role="user",
                content="I prefer concise progress updates.",
                message_index=0,
                timestamp="2026-05-18T10:00:00Z",
            )
        ]
    )
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                [
                    {
                        "action": "save",
                        "scope": "user",
                        "type": "preference",
                        "content": "User prefers concise progress updates.",
                        "priority": 0.8,
                        "confidence": 0.9,
                        "evidence_ids": [evidence[0].id],
                        "metadata": {"source": "conversation-evidence"},
                        "tags": ["dream"],
                    }
                ]
            )
        )
    )
    dream = Dream(store=store, provider=provider, model="test-model")

    assert await dream.run() is True

    note = store.read_notes()[0]
    assert note.scope == MemoryNoteScope.USER
    assert note.sources[0].evidence_ids == [evidence[0].id]
    assert note.metadata == {"source": "conversation-evidence"}
    assert store.get_last_evidence_cursor() == evidence[0].cursor
    assert store.get_last_dream_cursor() == 0


@pytest.mark.asyncio
async def test_dream_evidence_json_parse_failure_preserves_cursor_and_notes(tmp_path):
    store = MemoryStore(tmp_path)
    evidence = store.append_conversation_evidence(
        [
            ConversationEvidence.create(
                session_key="cli:test",
                turn_id="turn_1",
                role="user",
                content="I prefer concise progress updates.",
                message_index=0,
            )
        ]
    )
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=SimpleNamespace(content="{not valid json"))
    dream = Dream(store=store, provider=provider, model="test-model")

    assert await dream.run() is False

    assert store.read_notes() == []
    assert store.get_last_evidence_cursor() == 0
    assert store.read_pending_conversation_evidence()[0].id == evidence[0].id


def test_read_recent_conversation_evidence_filters_bounds_and_source_location(tmp_path):
    store = MemoryStore(tmp_path)
    fresh_user, stale_user, same_session, assistant = store.append_conversation_evidence(
        [
            ConversationEvidence.create(
                session_key="cli:older",
                turn_id="turn_1",
                role="user",
                content="I have a flight to Tokyo tomorrow.",
                message_index=0,
                timestamp="2026-05-18T10:00:00Z",
            ),
            ConversationEvidence.create(
                session_key="cli:older",
                turn_id="turn_2",
                role="user",
                content="This old trip is no longer relevant.",
                message_index=1,
                timestamp="2026-05-01T10:00:00Z",
            ),
            ConversationEvidence.create(
                session_key="cli:current",
                turn_id="turn_3",
                role="user",
                content="Current session text should be excluded.",
                message_index=2,
                timestamp="2026-05-18T11:00:00Z",
            ),
            ConversationEvidence.create(
                session_key="cli:older",
                turn_id="turn_4",
                role="assistant",
                content="Assistant detail.",
                message_index=3,
                timestamp="2026-05-18T11:30:00Z",
            ),
        ]
    )

    results = store.read_recent_conversation_evidence(
        max_age_days=7,
        max_records=10,
        roles={"user"},
        exclude_session_key="cli:current",
        now=datetime(2026, 5, 18, 12, 0, 0),
    )

    assert [record.id for record, _ in results] == [fresh_user.id]
    assert stale_user.id not in [record.id for record, _ in results]
    assert same_session.id not in [record.id for record, _ in results]
    assert assistant.id not in [record.id for record, _ in results]
    _, source = results[0]
    assert source.file == "memory/conversations/2026-05-18.jsonl"
    assert source.line == 1


@pytest.mark.asyncio
async def test_dream_json_supersede_reject_skip_and_duplicate_merge(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:test")
    old = store.upsert_note(MemoryNote.create("Use pytest directly.", "instruction", [source], scope="assistant"))
    rejected = store.upsert_note(MemoryNote.create("Obsolete project note.", "project", [source], scope="project"))
    evidence = store.append_conversation_evidence(
        [
            ConversationEvidence.create(
                session_key="cli:test", turn_id="turn_1", role="user", content="Use uv run pytest.", message_index=0
            ),
            ConversationEvidence.create(
                session_key="cli:test",
                turn_id="turn_1",
                role="assistant",
                content="I will use uv run pytest.",
                message_index=1,
            ),
        ]
    )
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                [
                    {
                        "action": "save",
                        "scope": "project",
                        "type": "project",
                        "content": "Project uses uv for Python validation.",
                        "priority": 0.7,
                        "confidence": 0.8,
                        "evidence_ids": [evidence[0].id],
                        "metadata": {"first": True},
                        "tags": ["dream"],
                    },
                    {
                        "action": "save",
                        "scope": "project",
                        "type": "project",
                        "content": "Project uses uv for Python validation.",
                        "priority": 0.9,
                        "confidence": 0.85,
                        "evidence_ids": [evidence[1].id],
                        "metadata": {"second": True},
                        "tags": ["validated"],
                    },
                    {
                        "action": "supersede",
                        "target_note_id": old.id,
                        "scope": "assistant",
                        "type": "instruction",
                        "content": "Use uv run pytest for validation.",
                        "priority": 0.8,
                        "confidence": 0.9,
                        "evidence_ids": [evidence[0].id],
                        "metadata": {},
                        "tags": ["dream"],
                    },
                    {"action": "reject", "target_note_id": rejected.id},
                    {"action": "skip"},
                ]
            )
        )
    )
    dream = Dream(store=store, provider=provider, model="test-model")

    assert await dream.run() is True

    notes = {note.id: note for note in store.read_notes()}
    merged = [note for note in notes.values() if note.content == "Project uses uv for Python validation."][0]
    assert merged.priority == pytest.approx(0.9)
    assert merged.confidence == pytest.approx(0.85)
    assert merged.sources[0].evidence_ids == [evidence[0].id, evidence[1].id]
    assert merged.metadata == {"first": True, "second": True}
    assert sorted(merged.tags) == ["dream", "validated"]
    assert notes[old.id].status == MemoryNoteStatus.SUPERSEDED
    assert notes[rejected.id].status == MemoryNoteStatus.REJECTED


@pytest.mark.asyncio
async def test_dream_supersedes_corrected_note(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:test")
    old_note = store.upsert_note(
        MemoryNote.create("Use pytest directly for validation.", MemoryNoteType.INSTRUCTION, [source])
    )
    cursor = store.append_history("Correction: use uv run pytest for validation.")
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(
        return_value=SimpleNamespace(content=f"[SUPERSEDE:{old_note.id}:SOUL] Use uv run pytest for validation.")
    )
    dream = Dream(store=store, provider=provider, model="test-model")

    assert await dream.run() is True

    notes = {note.id: note for note in store.read_notes()}
    replacement_id = notes[old_note.id].superseded_by
    assert notes[old_note.id].status == MemoryNoteStatus.SUPERSEDED
    assert replacement_id is not None
    assert notes[replacement_id].status == MemoryNoteStatus.ACTIVE
    assert old_note.id in notes[replacement_id].supersedes
    assert "Use uv run pytest for validation." in store.read_soul()
    assert "Use pytest directly for validation." not in store.render_memory_view("SOUL.md")
    assert store.get_last_dream_cursor() == cursor


@pytest.mark.asyncio
async def test_dream_skip_advances_cursor_without_creating_notes(tmp_path):
    store = MemoryStore(tmp_path)
    cursor = store.append_history("Short exchange with no durable memory.")
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=SimpleNamespace(content="[SKIP] no new information"))
    dream = Dream(store=store, provider=provider, model="test-model")

    assert await dream.run() is True

    assert store.read_notes() == []
    assert store.get_last_dream_cursor() == cursor


@pytest.mark.asyncio
async def test_dream_keeps_experience_processing_separate_from_memory_notes(tmp_path):
    store = MemoryStore(tmp_path)
    store.append_history("A tool execution tactic was observed.")
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=SimpleNamespace(content="[SKIP] no new information"))
    experience_store = MagicMock()
    experience_store.merge_similar.return_value = 0
    experience_store.decay_confidence.return_value = 0
    experience_store.prune_stale.return_value = 0
    experience_store.read_experiences.return_value = []
    dream = Dream(
        store=store,
        provider=provider,
        model="test-model",
        experience_store=experience_store,
    )

    assert await dream.run() is True

    assert store.read_notes() == []
    experience_store.merge_similar.assert_called_once()
    experience_store.compact.assert_called_once()
