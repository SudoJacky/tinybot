import json

import pytest

from tinybot.agent.memory import (
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
