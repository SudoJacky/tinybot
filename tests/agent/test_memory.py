import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from tinybot.agent.memory import (
    Dream,
    MemoryCaptureOrigin,
    MemoryNote,
    MemoryNoteStatus,
    MemoryNoteType,
    MemorySource,
    MemoryStore,
    generate_memory_note_id,
)


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
