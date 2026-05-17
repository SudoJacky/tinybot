import pytest

from tinybot.agent.memory import MemoryNote, MemoryNoteStatus, MemorySource, MemoryStore
from tinybot.agent.tools.memory import (
    RejectMemoryNoteTool,
    SaveMemoryNoteTool,
    SearchMemoryNotesTool,
    SupersedeMemoryNoteTool,
    TraceMemoryNoteTool,
)


@pytest.mark.asyncio
async def test_save_search_and_trace_memory_note_tools(tmp_path):
    store = MemoryStore(tmp_path)
    save_tool = SaveMemoryNoteTool(store, session_key="cli:test")
    search_tool = SearchMemoryNotesTool(store)
    trace_tool = TraceMemoryNoteTool(store)

    saved_result = await save_tool.execute(
        content="User prefers concise implementation handoffs.",
        note_type="preference",
        priority=0.8,
        confidence=0.7,
        tags="handoff, communication",
        message_start=3,
        message_end=4,
    )
    note = store.read_notes()[0]
    search_result = await search_tool.execute(query="handoff", note_type="preference", status="active")
    trace_result = await trace_tool.execute(note.id)

    assert saved_result == f"Memory Note saved: {note.id} (preference, active)"
    assert note.sources[0].session_key == "cli:test"
    assert note.sources[0].message_start == 3
    assert "User prefers concise implementation handoffs." in store.read_user()
    assert f"[{note.id}]" in search_result
    assert "sources: explicit session=cli:test messages=3-4" in search_result
    assert f"## Memory Note {note.id}" in trace_result
    assert "Sources:\n- explicit session=cli:test messages=3-4" in trace_result


@pytest.mark.asyncio
async def test_reject_memory_note_tool_refreshes_views(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:test")
    note = store.upsert_note(MemoryNote.create("Remove this project note from views.", "project", [source]))
    store.refresh_memory_views()
    tool = RejectMemoryNoteTool(store)

    result = await tool.execute(note.id, reason="obsolete")

    assert result == f"Memory Note rejected: {note.id}. Reason: obsolete"
    assert store.trace_memory_note(note.id).status == MemoryNoteStatus.REJECTED
    assert "Remove this project note from views." not in store.read_memory()


@pytest.mark.asyncio
async def test_supersede_memory_note_tool_links_replacement_and_refreshes_views(tmp_path):
    store = MemoryStore(tmp_path)
    source = MemorySource.explicit(session_key="cli:test")
    old = store.upsert_note(MemoryNote.create("Use pytest directly.", "instruction", [source]))
    store.refresh_memory_views()
    tool = SupersedeMemoryNoteTool(store, session_key="cli:test")

    result = await tool.execute(
        old.id,
        replacement_content="Use uv run pytest for test validation.",
        tags="python, tests",
    )
    notes = {note.id: note for note in store.read_notes()}
    replacement_id = notes[old.id].superseded_by

    assert replacement_id is not None
    assert result == f"Memory Note superseded: {old.id} -> {replacement_id}"
    assert notes[old.id].status == MemoryNoteStatus.SUPERSEDED
    assert old.id in notes[replacement_id].supersedes
    assert notes[replacement_id].tags == ["python", "tests"]
    assert "Use uv run pytest for test validation." in store.read_soul()
    assert "Use pytest directly." not in store.read_soul()


@pytest.mark.asyncio
async def test_memory_note_tools_return_errors_for_invalid_inputs(tmp_path):
    store = MemoryStore(tmp_path)
    save_tool = SaveMemoryNoteTool(store)
    search_tool = SearchMemoryNotesTool(store)
    trace_tool = TraceMemoryNoteTool(store)
    reject_tool = RejectMemoryNoteTool(store)
    supersede_tool = SupersedeMemoryNoteTool(store)

    assert await save_tool.execute(content="", note_type="instruction") == "Error: Memory Note content is required"
    assert "Invalid Memory Note type" in await save_tool.execute(content="Durable note.", note_type="workflow")
    assert "Invalid Memory Note status" in await search_tool.execute(status="archived")
    assert await trace_tool.execute("note_missing") == "Error: Memory Note 'note_missing' not found"
    assert await reject_tool.execute("note_missing") == "Error: Memory Note 'note_missing' not found"
    assert await supersede_tool.execute("note_missing", "Replacement") == "Error: Memory Note 'note_missing' not found"
