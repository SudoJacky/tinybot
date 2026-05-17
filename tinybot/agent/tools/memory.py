"""Agent Memory Note tools."""

from __future__ import annotations

from typing import TYPE_CHECKING

from tinybot.agent.memory import MemoryNote, MemorySource
from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import IntegerSchema, NumberSchema, StringSchema, tool_parameters_schema

if TYPE_CHECKING:
    from tinybot.agent.memory import MemoryStore
    from tinybot.agent.vector_store import VectorStore


_NOTE_TYPES = ["preference", "instruction", "project", "decision", "fix", "followup"]
_NOTE_STATUSES = ["active", "superseded", "rejected"]


def _format_source(source: MemorySource) -> str:
    fields = [source.capture_origin.value]
    if source.session_key:
        fields.append(f"session={source.session_key}")
    if source.source_file:
        fields.append(f"file={source.source_file}")
    if source.history_start_cursor is not None or source.history_end_cursor is not None:
        fields.append(f"history={source.history_start_cursor}-{source.history_end_cursor}")
    if source.message_start is not None or source.message_end is not None:
        fields.append(f"messages={source.message_start}-{source.message_end}")
    return " ".join(fields)


def _source_summary(note: MemoryNote) -> str:
    if not note.sources:
        return "none"
    parts: list[str] = []
    for source in note.sources:
        parts.append(_format_source(source))
    return "; ".join(parts)


def _format_note_summary(note: MemoryNote) -> str:
    tags = f" tags={','.join(note.tags)}" if note.tags else ""
    return (
        f"- [{note.id}] {note.type.value}/{note.status.value} "
        f"priority={note.priority:g} confidence={note.confidence:g}{tags}\n"
        f"  {note.content}\n"
        f"  sources: {_source_summary(note)}"
    )


def _explicit_source(session_key: str, message_start: int | None, message_end: int | None) -> MemorySource:
    return MemorySource.explicit(
        session_key=session_key or None,
        message_start=message_start,
        message_end=message_end,
    )


@tool_parameters(
    tool_parameters_schema(
        content=StringSchema("Durable Memory Note content to save.", min_length=1),
        note_type=StringSchema("Memory Note type.", enum=_NOTE_TYPES),
        priority=NumberSchema(0.5, description="Importance from 0 to 1.", minimum=0, maximum=1),
        confidence=NumberSchema(0.5, description="Confidence from 0 to 1.", minimum=0, maximum=1),
        tags=StringSchema("Optional comma-separated tags."),
        message_start=IntegerSchema(0, description="Optional source message start index.", minimum=0),
        message_end=IntegerSchema(0, description="Optional source message end index.", minimum=0),
        required=["content", "note_type"],
    )
)
class SaveMemoryNoteTool(Tool):
    """Save a durable Agent Memory Note explicitly."""

    def __init__(
        self,
        memory_store: MemoryStore,
        session_key: str = "",
        vector_store: VectorStore | None = None,
    ):
        self._store = memory_store
        self._session_key = session_key
        self._vector_store = vector_store

    @property
    def name(self) -> str:
        return "save_memory_note"

    @property
    def description(self) -> str:
        return (
            "Save durable agent-side memory as a typed Memory Note. "
            "Use this only for durable preferences, instructions, project facts, decisions, fixes, or followups."
        )

    async def execute(
        self,
        content: str,
        note_type: str,
        priority: float = 0.5,
        confidence: float = 0.5,
        tags: str = "",
        message_start: int | None = None,
        message_end: int | None = None,
    ) -> str:
        try:
            note = self._store.save_memory_note(
                content=content,
                note_type=note_type,
                source=_explicit_source(self._session_key, message_start, message_end),
                priority=priority,
                confidence=confidence,
                tags=tags,
            )
            self._store.refresh_memory_views()
            self._store.rebuild_memory_note_index(self._vector_store)
            return f"Memory Note saved: {note.id} ({note.type.value}, {note.status.value})"
        except ValueError as exc:
            return f"Error: {exc}"


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("Optional lexical query over content, id, tags, type, status, and source summary."),
        note_type=StringSchema("Optional Memory Note type filter.", enum=_NOTE_TYPES),
        status=StringSchema("Optional Memory Note status filter.", enum=_NOTE_STATUSES),
        limit=IntegerSchema(10, description="Maximum notes to return.", minimum=1, maximum=50),
    )
)
class SearchMemoryNotesTool(Tool):
    """Search canonical Agent Memory Notes."""

    def __init__(self, memory_store: MemoryStore, vector_store: VectorStore | None = None):
        self._store = memory_store
        self._vector_store = vector_store

    @property
    def name(self) -> str:
        return "search_memory_notes"

    @property
    def description(self) -> str:
        return "Search Memory Notes by query, type, status, and limit without mixing in Experience or Knowledge Base."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        query: str = "",
        note_type: str = "",
        status: str = "",
        limit: int = 10,
    ) -> str:
        try:
            notes = self._store.search_memory_notes(
                query=query or "",
                note_type=note_type or None,
                status=status or None,
                limit=limit,
                vector_store=self._vector_store,
            )
        except ValueError as exc:
            return f"Error: {exc}"
        if not notes:
            return "No Memory Notes found."
        return "## Memory Notes\n" + "\n".join(_format_note_summary(note) for note in notes)


@tool_parameters(
    tool_parameters_schema(
        note_id=StringSchema("Memory Note id to trace.", min_length=1),
        required=["note_id"],
    )
)
class TraceMemoryNoteTool(Tool):
    """Trace one Memory Note and its sources."""

    def __init__(self, memory_store: MemoryStore):
        self._store = memory_store

    @property
    def name(self) -> str:
        return "trace_memory_note"

    @property
    def description(self) -> str:
        return "Return one Memory Note with its source trace-back fields."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, note_id: str) -> str:
        try:
            note = self._store.trace_memory_note(note_id)
        except KeyError:
            return f"Error: Memory Note '{note_id}' not found"
        lines = [
            f"## Memory Note {note.id}",
            "",
            f"Type: {note.type.value}",
            f"Status: {note.status.value}",
            f"Priority: {note.priority:g}",
            f"Confidence: {note.confidence:g}",
            f"Created: {note.created_at}",
            f"Updated: {note.updated_at}",
        ]
        if note.tags:
            lines.append("Tags: " + ", ".join(note.tags))
        if note.supersedes:
            lines.append("Supersedes: " + ", ".join(note.supersedes))
        if note.superseded_by:
            lines.append(f"Superseded by: {note.superseded_by}")
        lines.extend(["", note.content, "", "Sources:"])
        for source in note.sources:
            lines.append(f"- {_format_source(source)}")
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        note_id=StringSchema("Memory Note id to reject.", min_length=1),
        reason=StringSchema("Optional reason for rejection."),
        required=["note_id"],
    )
)
class RejectMemoryNoteTool(Tool):
    """Reject an outdated or incorrect Memory Note."""

    def __init__(self, memory_store: MemoryStore, vector_store: VectorStore | None = None):
        self._store = memory_store
        self._vector_store = vector_store

    @property
    def name(self) -> str:
        return "reject_memory_note"

    @property
    def description(self) -> str:
        return "Mark a Memory Note as rejected so default recall and Memory Views exclude it."

    async def execute(self, note_id: str, reason: str = "") -> str:
        try:
            note = self._store.reject_memory_note(note_id)
            self._store.refresh_memory_views()
            self._store.rebuild_memory_note_index(self._vector_store)
        except KeyError:
            return f"Error: Memory Note '{note_id}' not found"
        suffix = f" Reason: {reason.strip()}" if reason.strip() else ""
        return f"Memory Note rejected: {note.id}.{suffix}"


@tool_parameters(
    tool_parameters_schema(
        note_id=StringSchema("Existing Memory Note id to supersede.", min_length=1),
        replacement_content=StringSchema("Replacement durable Memory Note content.", min_length=1),
        note_type=StringSchema("Optional replacement Memory Note type. Defaults to the old note type.", enum=_NOTE_TYPES),
        priority=NumberSchema(0.5, description="Optional replacement priority from 0 to 1.", minimum=0, maximum=1),
        confidence=NumberSchema(0.5, description="Optional replacement confidence from 0 to 1.", minimum=0, maximum=1),
        tags=StringSchema("Optional comma-separated replacement tags. Defaults to the old note tags."),
        message_start=IntegerSchema(0, description="Optional source message start index.", minimum=0),
        message_end=IntegerSchema(0, description="Optional source message end index.", minimum=0),
        required=["note_id", "replacement_content"],
    )
)
class SupersedeMemoryNoteTool(Tool):
    """Supersede one Memory Note with a replacement note."""

    def __init__(
        self,
        memory_store: MemoryStore,
        session_key: str = "",
        vector_store: VectorStore | None = None,
    ):
        self._store = memory_store
        self._session_key = session_key
        self._vector_store = vector_store

    @property
    def name(self) -> str:
        return "supersede_memory_note"

    @property
    def description(self) -> str:
        return "Create a replacement Memory Note and mark the old note superseded."

    async def execute(
        self,
        note_id: str,
        replacement_content: str,
        note_type: str = "",
        priority: float | None = None,
        confidence: float | None = None,
        tags: str = "",
        message_start: int | None = None,
        message_end: int | None = None,
    ) -> str:
        try:
            note = self._store.supersede_memory_note(
                note_id,
                replacement_content=replacement_content,
                note_type=note_type or None,
                source=_explicit_source(self._session_key, message_start, message_end),
                priority=priority,
                confidence=confidence,
                tags=tags if tags else None,
            )
            self._store.refresh_memory_views()
            self._store.rebuild_memory_note_index(self._vector_store)
        except KeyError:
            return f"Error: Memory Note '{note_id}' not found"
        except ValueError as exc:
            return f"Error: {exc}"
        return f"Memory Note superseded: {note_id} -> {note.id}"
