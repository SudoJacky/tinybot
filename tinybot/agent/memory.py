"""Memory system: pure file I/O store, lightweight Consolidator, and Dream processor."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import weakref

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any
from collections.abc import Callable

from loguru import logger

from tinybot.agent.vector_store import VectorStore
from tinybot.utils.prompt_templates import render_template
from tinybot.utils.tokens import estimate_message_tokens, estimate_prompt_tokens_chain
from tinybot.utils.fs import ensure_dir
from tinybot.utils.helper import strip_think
from tinybot.utils.legacy_migrate import migrate_legacy_history

from tinybot.utils.gitstore import GitStore

if TYPE_CHECKING:
    from tinybot.providers.base import LLMProvider
    from tinybot.session.manager import Session, SessionManager


# ---------------------------------------------------------------------------
# Memory Notes - canonical structured Agent Memory records
# ---------------------------------------------------------------------------

class MemoryNoteType(StrEnum):
    PREFERENCE = "preference"
    INSTRUCTION = "instruction"
    PROJECT = "project"
    DECISION = "decision"
    FIX = "fix"
    FOLLOWUP = "followup"


class MemoryNoteStatus(StrEnum):
    ACTIVE = "active"
    SUPERSEDED = "superseded"
    REJECTED = "rejected"


class MemoryCaptureOrigin(StrEnum):
    DREAM = "dream"
    EXPLICIT = "explicit"
    MIGRATION = "migration"


def _utc_timestamp() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _normalize_note_text(text: str) -> str:
    return " ".join(text.strip().casefold().split())


def _coerce_enum(enum_type: type[StrEnum], value: Any, default: StrEnum) -> StrEnum:
    try:
        return enum_type(str(value))
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(slots=True)
class MemorySource:
    capture_origin: MemoryCaptureOrigin
    captured_at: str = field(default_factory=_utc_timestamp)
    session_key: str | None = None
    message_start: int | None = None
    message_end: int | None = None
    history_start_cursor: int | None = None
    history_end_cursor: int | None = None
    source_file: str | None = None

    @classmethod
    def dream(
        cls,
        *,
        history_start_cursor: int | None = None,
        history_end_cursor: int | None = None,
    ) -> MemorySource:
        return cls(
            capture_origin=MemoryCaptureOrigin.DREAM,
            history_start_cursor=history_start_cursor,
            history_end_cursor=history_end_cursor,
        )

    @classmethod
    def explicit(
        cls,
        *,
        session_key: str | None = None,
        message_start: int | None = None,
        message_end: int | None = None,
    ) -> MemorySource:
        return cls(
            capture_origin=MemoryCaptureOrigin.EXPLICIT,
            session_key=session_key,
            message_start=message_start,
            message_end=message_end,
        )

    @classmethod
    def migration(cls, source_file: str) -> MemorySource:
        return cls(
            capture_origin=MemoryCaptureOrigin.MIGRATION,
            source_file=source_file,
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> MemorySource:
        raw = data or {}
        return cls(
            capture_origin=_coerce_enum(
                MemoryCaptureOrigin,
                raw.get("capture_origin") or raw.get("origin"),
                MemoryCaptureOrigin.EXPLICIT,
            ),
            captured_at=str(raw.get("captured_at") or raw.get("created_at") or _utc_timestamp()),
            session_key=str(raw["session_key"]) if raw.get("session_key") else None,
            message_start=_coerce_int(raw.get("message_start")),
            message_end=_coerce_int(raw.get("message_end")),
            history_start_cursor=_coerce_int(raw.get("history_start_cursor")),
            history_end_cursor=_coerce_int(raw.get("history_end_cursor")),
            source_file=str(raw["source_file"]) if raw.get("source_file") else None,
        )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "capture_origin": self.capture_origin.value,
            "captured_at": self.captured_at,
        }
        for key in (
            "session_key",
            "message_start",
            "message_end",
            "history_start_cursor",
            "history_end_cursor",
            "source_file",
        ):
            value = getattr(self, key)
            if value is not None:
                data[key] = value
        return data

    def identity(self) -> tuple[Any, ...]:
        return (
            self.capture_origin.value,
            self.session_key,
            self.message_start,
            self.message_end,
            self.history_start_cursor,
            self.history_end_cursor,
            self.source_file,
        )


@dataclass(slots=True)
class MemoryNote:
    content: str
    type: MemoryNoteType
    sources: list[MemorySource]
    id: str = ""
    status: MemoryNoteStatus = MemoryNoteStatus.ACTIVE
    priority: float = 0.5
    confidence: float = 0.5
    created_at: str = field(default_factory=_utc_timestamp)
    updated_at: str = field(default_factory=_utc_timestamp)
    supersedes: list[str] = field(default_factory=list)
    superseded_by: str | None = None
    tags: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.content = self.content.strip()
        self.sources = [source for source in self.sources if isinstance(source, MemorySource)]
        if not self.id:
            self.id = generate_memory_note_id(self.type, self.content, self.sources)

    @classmethod
    def create(
        cls,
        content: str,
        note_type: MemoryNoteType | str,
        sources: list[MemorySource] | None = None,
        *,
        priority: float = 0.5,
        confidence: float = 0.5,
        tags: list[str] | None = None,
    ) -> MemoryNote:
        return cls(
            content=content,
            type=_coerce_enum(MemoryNoteType, note_type, MemoryNoteType.PROJECT),
            sources=sources or [],
            priority=priority,
            confidence=confidence,
            tags=list(tags or []),
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MemoryNote:
        note_type = _coerce_enum(MemoryNoteType, data.get("type"), MemoryNoteType.PROJECT)
        content = str(data.get("content") or "")
        raw_sources = data.get("sources")
        if isinstance(raw_sources, list):
            sources = [MemorySource.from_dict(item) for item in raw_sources if isinstance(item, dict)]
        else:
            sources = []
        return cls(
            id=str(data.get("id") or generate_memory_note_id(note_type, content, sources)),
            type=note_type,
            status=_coerce_enum(MemoryNoteStatus, data.get("status"), MemoryNoteStatus.ACTIVE),
            content=content,
            priority=_coerce_float(data.get("priority"), 0.5),
            confidence=_coerce_float(data.get("confidence"), 0.5),
            sources=sources,
            created_at=str(data.get("created_at") or _utc_timestamp()),
            updated_at=str(data.get("updated_at") or data.get("created_at") or _utc_timestamp()),
            supersedes=[str(item) for item in data.get("supersedes") or []],
            superseded_by=str(data["superseded_by"]) if data.get("superseded_by") else None,
            tags=[str(item) for item in data.get("tags") or []],
        )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "type": self.type.value,
            "status": self.status.value,
            "content": self.content,
            "priority": self.priority,
            "confidence": self.confidence,
            "sources": [source.to_dict() for source in self.sources],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
        if self.supersedes:
            data["supersedes"] = list(self.supersedes)
        if self.superseded_by:
            data["superseded_by"] = self.superseded_by
        if self.tags:
            data["tags"] = list(self.tags)
        return data

    def equivalent_key(self) -> tuple[Any, ...]:
        return memory_note_equivalent_key(self.type, self.content, self.sources)


def memory_note_equivalent_key(
    note_type: MemoryNoteType | str,
    content: str,
    sources: list[MemorySource] | None = None,
) -> tuple[Any, ...]:
    coerced_type = _coerce_enum(MemoryNoteType, note_type, MemoryNoteType.PROJECT)
    source_keys = sorted((source.identity() for source in (sources or [])), key=repr)
    return (coerced_type.value, _normalize_note_text(content), tuple(source_keys))


def generate_memory_note_id(
    note_type: MemoryNoteType | str,
    content: str,
    sources: list[MemorySource] | None = None,
) -> str:
    payload = json.dumps(
        memory_note_equivalent_key(note_type, content, sources),
        ensure_ascii=False,
        sort_keys=True,
    )
    return "note_" + hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# MemoryStore — pure file I/O layer
# ---------------------------------------------------------------------------

class MemoryStore:
    """Pure file I/O for memory files: MEMORY.md, history.jsonl, SOUL.md, USER.md."""

    _DEFAULT_MAX_HISTORY = 1000
    _VIEW_MARKER_BEGIN = "<!-- tinybot-memory-notes:start -->"
    _VIEW_MARKER_END = "<!-- tinybot-memory-notes:end -->"
    _VIEW_TITLES = {
        "memory/MEMORY.md": "Project Memory Notes",
        "USER.md": "User Memory Notes",
        "SOUL.md": "Assistant Memory Notes",
    }
    _TYPE_VIEW_DEFAULTS = {
        MemoryNoteType.PREFERENCE: "USER.md",
        MemoryNoteType.INSTRUCTION: "SOUL.md",
        MemoryNoteType.PROJECT: "memory/MEMORY.md",
        MemoryNoteType.DECISION: "memory/MEMORY.md",
        MemoryNoteType.FIX: "memory/MEMORY.md",
        MemoryNoteType.FOLLOWUP: "memory/MEMORY.md",
    }

    def __init__(self, workspace: Path, max_history_entries: int = _DEFAULT_MAX_HISTORY):
        self.workspace = workspace
        self.max_history_entries = max_history_entries
        self.memory_dir = ensure_dir(workspace / "memory")
        self.memory_file = self.memory_dir / "MEMORY.md"
        self.notes_file = self.memory_dir / "notes.jsonl"
        self.history_file = self.memory_dir / "history.jsonl"
        self.legacy_history_file = self.memory_dir / "HISTORY.md"
        self.soul_file = workspace / "SOUL.md"
        self.user_file = workspace / "USER.md"
        self._cursor_file = self.memory_dir / ".cursor"
        self._dream_cursor_file = self.memory_dir / ".dream_cursor"
        self._git = GitStore(workspace, tracked_files=[
            "SOUL.md", "USER.md", "memory/MEMORY.md", "memory/notes.jsonl",
        ])
        # One-time migration from legacy HISTORY.md format
        migrate_legacy_history(self.memory_dir)

    @property
    def git(self) -> GitStore:
        return self._git

    # -- generic helpers -----------------------------------------------------

    @staticmethod
    def read_file(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    # -- notes.jsonl (canonical Memory Notes) -------------------------------

    def read_notes(self) -> list[MemoryNote]:
        """Read all Memory Notes, skipping malformed JSONL rows."""
        notes: list[MemoryNote] = []
        try:
            with open(self.notes_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(raw, dict):
                        notes.append(MemoryNote.from_dict(raw))
        except FileNotFoundError:
            pass
        return notes

    def write_notes(self, notes: list[MemoryNote]) -> None:
        with open(self.notes_file, "w", encoding="utf-8") as f:
            for note in notes:
                f.write(json.dumps(note.to_dict(), ensure_ascii=False) + "\n")

    def find_duplicate_note(self, candidate: MemoryNote) -> MemoryNote | None:
        candidate_key = candidate.equivalent_key()
        for note in self.read_notes():
            if note.equivalent_key() == candidate_key:
                return note
        return None

    def upsert_note(self, note: MemoryNote) -> MemoryNote:
        """Insert or replace a Memory Note by id or equivalent content/source."""
        notes = self.read_notes()
        replacement = note
        replacement.updated_at = _utc_timestamp()
        for idx, existing in enumerate(notes):
            if existing.id == note.id or existing.equivalent_key() == note.equivalent_key():
                if existing.id != note.id:
                    replacement.id = existing.id
                    replacement.created_at = existing.created_at
                notes[idx] = replacement
                self.write_notes(notes)
                return replacement
        notes.append(replacement)
        self.write_notes(notes)
        return replacement

    def get_note(self, note_id: str) -> MemoryNote | None:
        for note in self.read_notes():
            if note.id == note_id:
                return note
        return None

    def set_note_status(self, note_id: str, status: MemoryNoteStatus | str) -> MemoryNote:
        notes = self.read_notes()
        new_status = _coerce_enum(MemoryNoteStatus, status, MemoryNoteStatus.ACTIVE)
        for note in notes:
            if note.id == note_id:
                note.status = new_status
                note.updated_at = _utc_timestamp()
                self.write_notes(notes)
                return note
        raise KeyError(f"Memory Note not found: {note_id}")

    def reject_note(self, note_id: str) -> MemoryNote:
        return self.set_note_status(note_id, MemoryNoteStatus.REJECTED)

    def supersede_note(self, note_id: str, replacement: MemoryNote) -> MemoryNote:
        """Mark an existing note superseded and link it to a replacement note."""
        notes = self.read_notes()
        old_note: MemoryNote | None = None
        for note in notes:
            if note.id == note_id:
                old_note = note
                break
        if old_note is None:
            raise KeyError(f"Memory Note not found: {note_id}")

        replacement.status = MemoryNoteStatus.ACTIVE
        if note_id not in replacement.supersedes:
            replacement.supersedes.append(note_id)
        replacement = self.upsert_note(replacement)

        notes = self.read_notes()
        for note in notes:
            if note.id == note_id:
                note.status = MemoryNoteStatus.SUPERSEDED
                note.superseded_by = replacement.id
                note.updated_at = _utc_timestamp()
                self.write_notes(notes)
                return replacement
        raise KeyError(f"Memory Note not found after replacement insert: {note_id}")

    def migrate_legacy_memory_notes(self) -> list[MemoryNote]:
        """Create conservative Memory Notes from existing Markdown memory views.

        The original Markdown files are read-only inputs here. Re-running this
        method is idempotent because note ids include normalized content and
        source identity.
        """
        migrated: list[MemoryNote] = []
        for source_file, path, note_type in (
            ("memory/MEMORY.md", self.memory_file, MemoryNoteType.PROJECT),
            ("USER.md", self.user_file, MemoryNoteType.PREFERENCE),
            ("SOUL.md", self.soul_file, MemoryNoteType.INSTRUCTION),
        ):
            content = self.read_file(path)
            if not content.strip():
                continue
            source = MemorySource.migration(source_file)
            for item in self._parse_legacy_memory_markdown(content):
                note = MemoryNote.create(
                    item,
                    note_type,
                    [source],
                    priority=0.4,
                    confidence=0.45,
                    tags=["legacy-migration"],
                )
                migrated.append(self.upsert_note(note))
        return migrated

    def refresh_memory_views(self) -> dict[str, str]:
        """Render active Memory Notes into managed Markdown view sections."""
        notes = self.read_notes()
        rendered = {
            "memory/MEMORY.md": self.render_memory_view("memory/MEMORY.md", notes),
            "USER.md": self.render_memory_view("USER.md", notes),
            "SOUL.md": self.render_memory_view("SOUL.md", notes),
        }
        self.write_memory(self._replace_managed_memory_view(self.read_memory(), rendered["memory/MEMORY.md"]))
        self.write_user(self._replace_managed_memory_view(self.read_user(), rendered["USER.md"]))
        self.write_soul(self._replace_managed_memory_view(self.read_soul(), rendered["SOUL.md"]))
        return rendered

    def render_memory_view(self, view_file: str, notes: list[MemoryNote] | None = None) -> str:
        """Render one managed Memory View section from active Memory Notes."""
        active_notes = [
            note
            for note in (notes if notes is not None else self.read_notes())
            if note.status == MemoryNoteStatus.ACTIVE
            and note.content
            and self._note_view_file(note) == view_file
        ]
        active_notes.sort(
            key=lambda note: (
                note.type.value,
                -note.priority,
                -note.confidence,
                note.content.casefold(),
            )
        )

        title = self._VIEW_TITLES.get(view_file, "Memory Notes")
        lines = [
            self._VIEW_MARKER_BEGIN,
            f"## {title}",
            "",
            "This managed section is rendered from `memory/notes.jsonl`.",
            "Edit durable memory through Memory Note operations instead of changing this section directly.",
            "",
        ]
        if not active_notes:
            lines.append("(No active Memory Notes.)")
        else:
            current_type: MemoryNoteType | None = None
            for note in active_notes:
                if note.type != current_type:
                    current_type = note.type
                    lines.extend(("", f"### {note.type.value.title()}"))
                metadata = [
                    f"id: {note.id}",
                    f"priority: {note.priority:g}",
                    f"confidence: {note.confidence:g}",
                ]
                if note.tags:
                    metadata.append("tags: " + ", ".join(sorted(note.tags)))
                lines.append(f"- {note.content} ({'; '.join(metadata)})")
        lines.append(self._VIEW_MARKER_END)
        return "\n".join(lines).rstrip() + "\n"

    @classmethod
    def _replace_managed_memory_view(cls, existing: str, rendered_section: str) -> str:
        existing = existing.rstrip()
        begin = existing.find(cls._VIEW_MARKER_BEGIN)
        end = existing.find(cls._VIEW_MARKER_END)
        if begin != -1 and end != -1 and begin < end:
            suffix_start = end + len(cls._VIEW_MARKER_END)
            prefix = existing[:begin].rstrip()
            suffix = existing[suffix_start:].strip()
            parts = [part for part in (prefix, rendered_section.rstrip(), suffix) if part]
            return "\n\n".join(parts).rstrip() + "\n"
        if not existing:
            return rendered_section
        return existing + "\n\n" + rendered_section

    def _note_view_file(self, note: MemoryNote) -> str:
        for source in note.sources:
            if source.source_file in self._VIEW_TITLES:
                return source.source_file
        return self._TYPE_VIEW_DEFAULTS.get(note.type, "memory/MEMORY.md")

    @staticmethod
    def _parse_legacy_memory_markdown(content: str) -> list[str]:
        items: list[str] = []
        in_fence = False
        paragraph: list[str] = []

        def flush_paragraph() -> None:
            if paragraph:
                text = " ".join(paragraph).strip()
                if text:
                    items.append(text)
                paragraph.clear()

        for raw_line in content.splitlines():
            line = raw_line.strip()
            if line.startswith("```"):
                in_fence = not in_fence
                flush_paragraph()
                continue
            if in_fence:
                continue
            if not line:
                flush_paragraph()
                continue
            if line.startswith("#"):
                flush_paragraph()
                continue
            bullet = re.match(r"^(?:[-*+]|\d+[.)])\s+(?P<text>.+)$", line)
            if bullet:
                flush_paragraph()
                items.append(bullet.group("text").strip())
                continue
            paragraph.append(line)

        flush_paragraph()
        seen: set[str] = set()
        unique: list[str] = []
        for item in items:
            normalized = _normalize_note_text(item)
            if len(normalized) < 3 or normalized in seen:
                continue
            seen.add(normalized)
            unique.append(item)
        return unique

    # -- MEMORY.md (long-term facts) -----------------------------------------

    def read_memory(self) -> str:
        return self.read_file(self.memory_file)

    def write_memory(self, content: str) -> None:
        self.memory_file.write_text(content, encoding="utf-8")

    # -- SOUL.md -------------------------------------------------------------

    def read_soul(self) -> str:
        return self.read_file(self.soul_file)

    def write_soul(self, content: str) -> None:
        self.soul_file.write_text(content, encoding="utf-8")

    # -- USER.md -------------------------------------------------------------

    def read_user(self) -> str:
        return self.read_file(self.user_file)

    def write_user(self, content: str) -> None:
        self.user_file.write_text(content, encoding="utf-8")

    # -- context injection (used by context.py) ------------------------------

    def get_memory_context(self) -> str:
        long_term = self.read_memory()
        return f"## Long-term Memory\n{long_term}" if long_term else ""

    # -- history.jsonl — append-only, JSONL format ---------------------------

    def append_history(self, entry: str) -> int:
        """Append *entry* to history.jsonl and return its auto-incrementing cursor."""
        cursor = self._next_cursor()
        ts = datetime.now().strftime("%Y-%m-%d %H:%M")
        record = {"cursor": cursor, "timestamp": ts, "content": strip_think(entry.rstrip()) or entry.rstrip()}
        with open(self.history_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._cursor_file.write_text(str(cursor), encoding="utf-8")
        return cursor

    def _next_cursor(self) -> int:
        """Read the current cursor counter and return next value."""
        if self._cursor_file.exists():
            try:
                return int(self._cursor_file.read_text(encoding="utf-8").strip()) + 1
            except (ValueError, OSError):
                pass
        # Fallback: read last line's cursor from the JSONL file.
        last = self._read_last_entry()
        if last:
            return last["cursor"] + 1
        return 1

    def read_unprocessed_history(self, since_cursor: int) -> list[dict[str, Any]]:
        """Return history entries with cursor > *since_cursor*."""
        return [e for e in self._read_entries() if e["cursor"] > since_cursor]

    def compact_history(self) -> None:
        """Drop oldest entries if the file exceeds *max_history_entries*."""
        if self.max_history_entries <= 0:
            return
        entries = self._read_entries()
        if len(entries) <= self.max_history_entries:
            return
        kept = entries[-self.max_history_entries:]
        self._write_entries(kept)

    # -- JSONL helpers -------------------------------------------------------

    def _read_entries(self) -> list[dict[str, Any]]:
        """Read all entries from history.jsonl."""
        entries: list[dict[str, Any]] = []
        try:
            with open(self.history_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
        except FileNotFoundError:
            pass
        return entries

    def _read_last_entry(self) -> dict[str, Any] | None:
        """Read the last entry from the JSONL file efficiently."""
        try:
            with open(self.history_file, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                if size == 0:
                    return None
                read_size = min(size, 4096)
                f.seek(size - read_size)
                data = f.read().decode("utf-8")
                lines = [line for line in data.split("\n") if line.strip()]
                if not lines:
                    return None
                return json.loads(lines[-1])
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def _write_entries(self, entries: list[dict[str, Any]]) -> None:
        """Overwrite history.jsonl with the given entries."""
        with open(self.history_file, "w", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # -- dream cursor --------------------------------------------------------

    def get_last_dream_cursor(self) -> int:
        if self._dream_cursor_file.exists():
            try:
                return int(self._dream_cursor_file.read_text(encoding="utf-8").strip())
            except (ValueError, OSError):
                pass
        return 0

    def set_last_dream_cursor(self, cursor: int) -> None:
        self._dream_cursor_file.write_text(str(cursor), encoding="utf-8")

    # -- message formatting utility ------------------------------------------

    @staticmethod
    def _format_messages(messages: list[dict]) -> str:
        lines = []
        for message in messages:
            if not message.get("content"):
                continue
            tools = f" [tools: {', '.join(message['tools_used'])}]" if message.get("tools_used") else ""
            lines.append(
                f"[{message.get('timestamp', '?')[:16]}] {message['role'].upper()}{tools}: {message['content']}"
            )
        return "\n".join(lines)

    def raw_archive(self, messages: list[dict]) -> None:
        """Fallback: dump raw messages to history.jsonl without LLM summarization."""
        self.append_history(
            f"[RAW] {len(messages)} messages\n"
            f"{self._format_messages(messages)}"
        )
        logger.warning(
            "Memory consolidation degraded: raw-archived {} messages", len(messages)
        )



# ---------------------------------------------------------------------------
# Consolidator — lightweight token-budget triggered consolidation
# ---------------------------------------------------------------------------


class Consolidator:
    """Lightweight consolidation: moves pointer to 50 % then batch-summarizes.

    When the prompt token estimate exceeds the budget, the pointer
    (*last_consolidated*) is advanced user-turn by user-turn until the
    estimated size drops below the target (50 % of budget).  All messages
    passed over are then sent **in one batch** to the LLM for summarization.
    The resulting summary is stored in ChromaDB (and optionally history.jsonl).
    """

    _MAX_CONSOLIDATION_ROUNDS = 20

    _SAFETY_BUFFER = 1024  # extra headroom for tokenizer estimation drift

    def __init__(
        self,
        store: MemoryStore,
        provider: LLMProvider,
        model: str,
        sessions: SessionManager,
        context_window_tokens: int,
        build_messages: Callable[..., list[dict[str, Any]]],
        get_tool_definitions: Callable[[], list[dict[str, Any]]],
        max_completion_tokens: int = 4096,
        context_block_limit: int | None = None,
        vector_store: VectorStore | None = None,
    ):
        self.store = store
        self.provider = provider
        self.model = model
        self.sessions = sessions
        self.context_window_tokens = context_window_tokens
        self.max_completion_tokens = max_completion_tokens
        self.vector_store = vector_store
        self._build_messages = build_messages
        self._get_tool_definitions = get_tool_definitions
        self.context_block_limit = context_block_limit
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )

    def get_lock(self, session_key: str) -> asyncio.Lock:
        """Return the shared consolidation lock for one session."""
        return self._locks.setdefault(session_key, asyncio.Lock())

    def pick_consolidation_boundary(
        self,
        session: Session,
        tokens_to_remove: int,
    ) -> tuple[int, int] | None:
        """Pick a user-turn boundary that removes enough old prompt tokens."""
        start = session.last_consolidated
        if start >= len(session.messages) or tokens_to_remove <= 0:
            return None

        removed_tokens = 0
        last_boundary: tuple[int, int] | None = None
        for idx in range(start, len(session.messages)):
            message = session.messages[idx]
            if idx > start and message.get("role") == "user":
                last_boundary = (idx, removed_tokens)
                if removed_tokens >= tokens_to_remove:
                    return last_boundary
            removed_tokens += estimate_message_tokens(message, model=self.model)


        return last_boundary

    def estimate_session_prompt_tokens(self, session: Session) -> tuple[int, str]:
        """Estimate current prompt size for the normal session history view."""
        history = session.get_history(max_messages=0)
        channel, chat_id = (session.key.split(":", 1) if ":" in session.key else (None, None))
        probe_messages = self._build_messages(
            history=history,
            current_message="[token-probe]",
            channel=channel,
            chat_id=chat_id,
        )
        return estimate_prompt_tokens_chain(
            self.provider,
            self.model,
            probe_messages,
            self._get_tool_definitions(),
        )

    # ------------------------------------------------------------------
    # Single batch archive (called once after pointer is moved)
    # ------------------------------------------------------------------

    async def archive(self, messages: list[dict]) -> tuple[str | None, list[str]]:
        """Summarize messages via LLM, store to ChromaDB + history.jsonl.

        Returns a tuple of (summary_text, topic_tags).
        Topic tags are 3-5 keywords extracted by the LLM for later filtering.
        """
        if not messages:
            return None, []
        try:
            formatted = MemoryStore._format_messages(messages)
            response = await self.provider.chat_with_retry(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": render_template(
                            "agent/consolidator_archive.md",
                            strip=True,
                        ),
                    },
                    {"role": "user", "content": formatted},
                ],
                tools=None,
                tool_choice=None,
            )
            summary = response.content or "[no summary]"
            self.store.append_history(summary)

            # Extract topic tags from the summary
            topics = await self._extract_topics(summary)
            return summary, topics
        except Exception:
            logger.warning("Consolidation LLM call failed, raw-dumping to history")
            self.store.raw_archive(messages)
            return None, []

    async def _extract_topics(self, text: str) -> list[str]:
        """Extract 3-5 topic keywords from text via a lightweight LLM call."""
        if not text.strip() or text.strip() == "(nothing)":
            return []
        try:
            response = await self.provider.chat_with_retry(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Extract 3-5 concise topic keywords from the text below. "
                            "Output ONLY a JSON array of strings, e.g. "
                            '[\"refactoring\", \"database\", \"api-design\"]. '
                            "No explanation, no markdown."
                        ),
                    },
                    {"role": "user", "content": text[:2000]},
                ],
                tools=None,
                tool_choice=None,
            )
            raw = (response.content or "").strip()
            # Try to parse JSON array
            import re as _re
            match = _re.search(r"\[.*\]", raw, _re.DOTALL)
            if match:
                tags = json.loads(match.group())
                if isinstance(tags, list):
                    return [str(t).strip() for t in tags if str(t).strip()][:5]
        except Exception:
            logger.debug("Topic extraction failed, skipping")
        return []

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def maybe_consolidate_by_tokens(self, session: Session) -> None:
        """Move pointer to ≤50 % budget, then batch-summarize evicted messages.

        Phase 1 – *pointer walk*: Advance *last_consolidated* user-turn by
        user-turn until the estimated prompt size drops to the target.

        Phase 2 – *batch archive*: Collect all messages passed over and send
        them in one go to the LLM.  The summary is persisted to ChromaDB
        (and history.jsonl as a fallback record).
        """
        if not session.messages or self.context_window_tokens <= 0:
            return

        lock = self.get_lock(session.key)
        async with lock:
            budget = self.context_block_limit or (
                self.context_window_tokens
                - self.max_completion_tokens
                - self._SAFETY_BUFFER
            )
            if budget <= 0:
                return
            target = budget // 2
            estimated, source = self.estimate_session_prompt_tokens(session)
            if estimated <= 0:
                return
            if estimated < budget:
                logger.debug(
                    "Token consolidation idle {}: {}/{} via {}",
                    session.key,
                    estimated,
                    self.context_window_tokens,
                    source,
                )
                return

            original_consolidated = session.last_consolidated

            # Phase 1: advance pointer step-by-step until ≤ target
            for round_num in range(self._MAX_CONSOLIDATION_ROUNDS):
                if estimated <= target:
                    break

                boundary = self.pick_consolidation_boundary(
                    session, max(1, estimated - target)
                )
                if boundary is None:
                    logger.debug(
                        "Token consolidation: no safe boundary for {} (round {})",
                        session.key,
                        round_num,
                    )
                    break

                end_idx = boundary[0]
                if end_idx <= session.last_consolidated:
                    break
                session.last_consolidated = end_idx

                logger.info(
                    "Token consolidation pointer move {} for {}: round={}, "
                    "pointer {}→{}, estimated {}/{}",
                    session.key,
                    round_num,
                    session.key,
                    original_consolidated,
                    end_idx,
                    estimated,
                    self.context_window_tokens,
                )

                estimated, source = self.estimate_session_prompt_tokens(session)
                if estimated <= 0:
                    break

            # Nothing was evicted
            if session.last_consolidated <= original_consolidated:
                return

            # Phase 2: batch archive all evicted messages at once
            evicted = session.messages[original_consolidated:session.last_consolidated]
            if not evicted:
                return

            logger.info(
                "Token consolidation batch archive for {}: {} msgs ({}→{})",
                session.key,
                len(evicted),
                original_consolidated,
                session.last_consolidated,
            )

            summary = await self.archive(evicted)

            # Store in ChromaDB
            if self.vector_store is not None:
                summary_text, topics = summary
                text_to_store = summary_text or MemoryStore._format_messages(evicted)
                self.vector_store.store_summary(
                    session_key=session.key,
                    summary=text_to_store,
                    messages=evicted,
                    boundary_start=original_consolidated,
                    boundary_end=session.last_consolidated,
                    topics=topics,
                )

            self.sessions.save(session)


# ---------------------------------------------------------------------------
# Dream — heavyweight cron-scheduled memory consolidation
# ---------------------------------------------------------------------------


class Dream:
    """Memory processor: analyze history.jsonl, write Memory Notes, refresh views.

    Phase 1 produces structured note operations from conversation history.
    Phase 2 applies those operations to canonical Memory Notes, then refreshes
    managed Markdown Memory Views.
    Phase 3 processes Experiences separately as execution guidance.
    """

    _NOTE_TARGETS = {
        "MEMORY": ("memory/MEMORY.md", MemoryNoteType.PROJECT),
        "USER": ("USER.md", MemoryNoteType.PREFERENCE),
        "SOUL": ("SOUL.md", MemoryNoteType.INSTRUCTION),
    }
    _NOTE_LINE_RE = re.compile(r"^\[(?P<header>[^\]]+)\]\s*(?P<content>.*)$")

    def __init__(
        self,
        store: MemoryStore,
        provider: LLMProvider,
        model: str,
        max_batch_size: int = 20,
        max_iterations: int = 10,
        max_tool_result_chars: int = 16_000,
        experience_store: Any | None = None,
    ):
        self.store = store
        self.provider = provider
        self.model = model
        self.max_batch_size = max_batch_size
        self.max_iterations = max_iterations
        self.max_tool_result_chars = max_tool_result_chars
        self.experience_store = experience_store

    # -- main entry ----------------------------------------------------------

    async def run(self) -> bool:
        """Process unprocessed history entries. Returns True if work was done."""
        last_cursor = self.store.get_last_dream_cursor()
        entries = self.store.read_unprocessed_history(since_cursor=last_cursor)
        if not entries:
            return False

        batch = entries[: self.max_batch_size]
        logger.info(
            "Dream: processing {} entries (cursor {}→{}), batch={}",
            len(entries), last_cursor, batch[-1]["cursor"], len(batch),
        )

        # Build history text for LLM
        history_text = "\n".join(
            f"[{e['timestamp']}] {e['content']}" for e in batch
        )

        # Current file contents
        current_memory = self.store.read_memory() or "(empty)"
        current_soul = self.store.read_soul() or "(empty)"
        current_user = self.store.read_user() or "(empty)"
        current_notes = self._format_current_notes() or "(no Memory Notes)"
        file_context = (
            f"## Current Memory Notes\n{current_notes}\n\n"
            f"## Current MEMORY.md\n{current_memory}\n\n"
            f"## Current SOUL.md\n{current_soul}\n\n"
            f"## Current USER.md\n{current_user}"
        )

        # Phase 1: Analyze
        phase1_prompt = (
            f"## Conversation History\n{history_text}\n\n{file_context}"
        )

        try:
            phase1_response = await self.provider.chat_with_retry(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": render_template("agent/dream_phase1.md", strip=True),
                    },
                    {"role": "user", "content": phase1_prompt},
                ],
                tools=None,
                tool_choice=None,
            )
            analysis = phase1_response.content or ""
            logger.debug("Dream Phase 1 complete ({} chars)", len(analysis))
        except Exception:
            logger.exception("Dream Phase 1 failed")
            return False

        # Phase 2: apply structured Memory Note operations before refreshing views.
        source = MemorySource.dream(
            history_start_cursor=batch[0]["cursor"],
            history_end_cursor=batch[-1]["cursor"],
        )
        changelog = self._apply_memory_note_analysis(analysis, source)
        if changelog:
            self.store.refresh_memory_views()
            changelog.append("refresh_memory_views")
            logger.info("Dream Phase 2: applied {} Memory Note change(s)", len(changelog) - 1)
        else:
            logger.debug("Dream Phase 2: no durable Memory Notes created")

        # Advance cursor — always, to avoid re-processing Phase 1
        new_cursor = batch[-1]["cursor"]
        self.store.set_last_dream_cursor(new_cursor)
        self.store.compact_history()

        if changelog:
            logger.info(
                "Dream done: {} change(s), cursor advanced to {}",
                len(changelog), new_cursor,
            )
        else:
            logger.info("Dream done: no durable memory, cursor advanced to {}", new_cursor)

        # Git auto-commit (only when there are actual changes)
        if changelog and self.store.git.is_initialized():
            ts = batch[-1]["timestamp"]
            sha = self.store.git.auto_commit(f"dream: {ts}, {len(changelog)} change(s)")
            if sha:
                logger.info("Dream commit: {}", sha)

        # Phase 3: Process experiences
        if self.experience_store is not None:
            await self._process_experiences()

        return True

    def _format_current_notes(self) -> str:
        lines: list[str] = []
        for note in sorted(
            self.store.read_notes(),
            key=lambda item: (item.status.value, item.type.value, item.content.casefold()),
        ):
            lines.append(
                f"- id={note.id} status={note.status.value} type={note.type.value} "
                f"priority={note.priority:g} confidence={note.confidence:g}: {note.content}"
            )
        return "\n".join(lines)

    def _apply_memory_note_analysis(
        self,
        analysis: str,
        source: MemorySource,
    ) -> list[str]:
        changes: list[str] = []
        for operation in self._parse_memory_note_operations(analysis, source):
            action = operation["action"]
            note_id = operation.get("note_id") or ""
            content = operation.get("content") or ""
            if action == "skip":
                continue
            if action == "reject":
                if note_id:
                    self.store.reject_note(note_id)
                    changes.append(f"reject_note:{note_id}")
                continue
            if not content:
                continue
            note = MemoryNote.create(
                content,
                operation["type"],
                [source],
                priority=operation["priority"],
                confidence=operation["confidence"],
                tags=operation["tags"],
            )
            source_file = operation.get("source_file")
            if source_file:
                note.sources[0].source_file = source_file
            if action == "supersede" and note_id:
                replacement = self.store.supersede_note(note_id, note)
                changes.append(f"supersede_note:{note_id}->{replacement.id}")
                continue
            existing = self._find_active_note_by_type_and_content(note.type, note.content)
            if existing is not None:
                existing.sources = self._merge_note_sources(existing.sources, note.sources)
                existing.priority = max(existing.priority, note.priority)
                existing.confidence = max(existing.confidence, note.confidence)
                existing.tags = sorted(set(existing.tags + note.tags))
                stored = self.store.upsert_note(existing)
                changes.append(f"merge_note:{stored.id}")
            else:
                stored = self.store.upsert_note(note)
                changes.append(f"save_note:{stored.id}")
        return changes

    def _parse_memory_note_operations(
        self,
        analysis: str,
        source: MemorySource,
    ) -> list[dict[str, Any]]:
        operations: list[dict[str, Any]] = []
        for raw_line in analysis.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            parsed = self._parse_memory_note_operation(line, source)
            if parsed is not None:
                operations.append(parsed)
        return operations

    def _parse_memory_note_operation(
        self,
        line: str,
        source: MemorySource,
    ) -> dict[str, Any] | None:
        del source
        match = self._NOTE_LINE_RE.match(line)
        if not match:
            return None
        header = match.group("header").strip()
        content = match.group("content").strip()
        if header.upper().startswith("SKIP"):
            return {"action": "skip"}

        parts = [part.strip() for part in header.split(":") if part.strip()]
        if not parts:
            return None
        action = parts[0].casefold()
        if action in {"memory", "user", "soul"}:
            target = parts[0].upper()
            source_file, note_type = self._NOTE_TARGETS[target]
            return self._build_note_operation("save", content, note_type, source_file)
        if action in {"save", "note"}:
            target = parts[1].upper() if len(parts) >= 2 else "MEMORY"
            source_file, note_type = self._resolve_note_target(target)
            return self._build_note_operation("save", content, note_type, source_file)
        if action == "supersede":
            note_id = parts[1] if len(parts) >= 2 else ""
            target = parts[2].upper() if len(parts) >= 3 else "MEMORY"
            source_file, note_type = self._resolve_note_target(target)
            return self._build_note_operation(
                "supersede", content, note_type, source_file, note_id=note_id
            )
        if action == "reject":
            note_id = parts[1] if len(parts) >= 2 else ""
            return {
                "action": "reject",
                "note_id": note_id,
                "content": content,
                "type": MemoryNoteType.PROJECT,
                "source_file": None,
                "priority": 0.5,
                "confidence": 0.5,
                "tags": ["dream"],
            }
        return None

    def _build_note_operation(
        self,
        action: str,
        content: str,
        note_type: MemoryNoteType,
        source_file: str,
        *,
        note_id: str = "",
    ) -> dict[str, Any]:
        tags = ["dream"]
        if source_file == "memory/MEMORY.md":
            tags.append("project-memory")
        elif source_file == "USER.md":
            tags.append("user-memory")
        elif source_file == "SOUL.md":
            tags.append("assistant-memory")
        return {
            "action": action,
            "note_id": note_id,
            "content": content,
            "type": note_type,
            "source_file": source_file,
            "priority": 0.6,
            "confidence": 0.65,
            "tags": tags,
        }

    def _resolve_note_target(self, target: str) -> tuple[str, MemoryNoteType]:
        if target in self._NOTE_TARGETS:
            return self._NOTE_TARGETS[target]
        return "memory/MEMORY.md", _coerce_enum(MemoryNoteType, target.casefold(), MemoryNoteType.PROJECT)

    def _find_active_note_by_type_and_content(
        self,
        note_type: MemoryNoteType,
        content: str,
    ) -> MemoryNote | None:
        normalized = _normalize_note_text(content)
        for note in self.store.read_notes():
            if (
                note.status == MemoryNoteStatus.ACTIVE
                and note.type == note_type
                and _normalize_note_text(note.content) == normalized
            ):
                return note
        return None

    @staticmethod
    def _merge_note_sources(
        existing: list[MemorySource],
        new_sources: list[MemorySource],
    ) -> list[MemorySource]:
        merged: list[MemorySource] = []
        seen: set[tuple[Any, ...]] = set()
        for source in existing + new_sources:
            identity = source.identity()
            if identity in seen:
                continue
            seen.add(identity)
            merged.append(source)
        return merged

    async def _process_experiences(self) -> None:
        """Phase 3: keep Experience processing separate from Memory Notes."""
        if self.experience_store is None:
            return

        # 1. Merge similar experiences (boosts confidence automatically)
        merged_count = self.experience_store.merge_similar()
        if merged_count > 0:
            logger.info("Dream Phase 3: merged {} similar experiences", merged_count)

        # 2. Decay confidence of unused experiences
        decayed_count = self.experience_store.decay_confidence(days_threshold=30)
        if decayed_count > 0:
            logger.info("Dream Phase 3: decayed {} stale experiences", decayed_count)

        # 3. Prune low-confidence or old experiences
        pruned_count = self.experience_store.prune_stale(min_confidence=0.3, max_age_days=90)
        if pruned_count > 0:
            logger.info("Dream Phase 3: pruned {} low-quality experiences", pruned_count)

        # 4. Compact if exceeding limit
        self.experience_store.compact()

        # 5. Get high-confidence strategies for MEMORY.md
        high_conf = [
            e for e in self.experience_store.read_experiences()
            if e.confidence >= 0.7 and e.resolution and e.outcome in ("success", "resolved")
        ]

        if not high_conf:
            logger.debug("Dream Phase 3: no high-confidence experiences to update")
            return

        # Build strategies section
        strategies_by_tool: dict[str, list[Any]] = {}
        for exp in high_conf:
            strategies_by_tool.setdefault(exp.tool_name, []).append(exp)

        strategy_lines = ["## Tool Strategies\n\n"]
        strategy_lines.append("Patterns learned from successful problem-solving.\n\n")

        for tool_name, exps in sorted(strategies_by_tool.items()):
            strategy_lines.append(f"### {tool_name}\n")
            for exp in sorted(exps, key=lambda x: -x.confidence):
                error_label = exp.error_type or "general"
                strategy_lines.append(
                    f"- **{error_label}**: {exp.resolution} ({int(exp.confidence * 100)}%)\n"
                )
            strategy_lines.append("\n")

        strategy_content = "".join(strategy_lines).rstrip()

        # Update MEMORY.md
        current_memory = self.store.read_memory()
        if "## Tool Strategies" in current_memory:
            import re
            new_memory = re.sub(
                r"## Tool Strategies\n.*",
                strategy_content,
                current_memory,
                flags=re.DOTALL
            )
        else:
            new_memory = current_memory.rstrip() + "\n\n" + strategy_content

        self.store.write_memory(new_memory)
        logger.info("Dream Phase 3: wrote {} strategies to MEMORY.md", len(high_conf))


# ---------------------------------------------------------------------------
# EntityExtractor — lightweight runtime entity extraction for user_profile
# ---------------------------------------------------------------------------

_ENTITY_EXTRACT_SYSTEM = """\
You are an entity extractor. Given a conversation turn, extract structured facts about the user as JSON.

Rules:
1. Only extract EXPLICITLY stated facts — never infer or guess.
2. Output a single JSON object with these keys (omit empty keys):
   - "name": the user's name (if mentioned)
   - "preferences": list of stated preferences (colors, styles, tools, etc.)
   - "mentioned_entities": list of named things (people, pets, projects, companies, etc.) with brief context
   - "communication_style": one of "casual", "formal", "technical", "brief"
   - "key_facts": list of any other important facts about the user
3. If nothing can be extracted, output: {}
4. Keep values concise — no full sentences, just key facts.

Example output:
{"name": "张三", "preferences": ["蓝色", "VS Code"], "mentioned_entities": ["大黄（狗）"], "key_facts": ["住在上海"]}"""

_ENTITY_SIGNAL_PATTERNS = (
    re.compile(r"\b(my name is|call me|please call me|i am|i'm|i prefer|i like|i use|i work as|i live in|i'm from)\b", re.IGNORECASE),
    re.compile(r"(我叫|叫我|我是|我在|我住在|我来自|我做|我从事|我主要用|我常用|我喜欢|我偏好|我习惯|我不喜欢|我讨厌|请叫我)"),
    re.compile(r"(名字|昵称|称呼|偏好|习惯|邮箱|email|e-mail|电话|手机号|微信|qq|职业|岗位|学校|专业)"),
)


class EntityExtractor:

    """Extracts user entities from conversation turns and updates Session.user_profile.

    Designed to be called after each agent turn completes. Uses a lightweight
    LLM call to extract structured facts, then merges them into the session's
    ``user_profile`` dict.
    """

    def __init__(
        self,
        provider: LLMProvider,
        model: str,
    ):
        self.provider = provider
        self.model = model

    @staticmethod
    def turn_fingerprint(user_message: str) -> str:
        normalized = " ".join(user_message.strip().lower().split())
        return hashlib.sha1(normalized.encode("utf-8")).hexdigest()

    @staticmethod
    def should_extract(
        user_message: str,
        current_profile: dict[str, Any] | None = None,
    ) -> bool:
        text = user_message.strip()
        if not text:
            return False

        lowered = text.lower()
        if any(pattern.search(text) for pattern in _ENTITY_SIGNAL_PATTERNS):
            return True

        if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text):
            return True
        if re.search(r"\b\d{11}\b", text):
            return True
        if current_profile:
            if not current_profile.get("name") and ("叫我" in text or "my name is" in lowered):
                return True
            if not current_profile.get("preferences") and any(token in text for token in ("喜欢", "偏好", "习惯")):
                return True

        return bool(re.search(r"\b(my|i)\b", lowered) and len(text) >= 48)

    async def extract(

        self,
        user_message: str,
        assistant_message: str,
    ) -> dict[str, Any]:
        """Run entity extraction on a single turn. Returns extracted dict (may be empty)."""
        if not user_message.strip():
            return {}

        prompt = f"USER: {user_message}\nASSISTANT: {assistant_message}"
        try:
            response = await self.provider.chat_with_retry(
                model=self.model,
                messages=[
                    {"role": "system", "content": _ENTITY_EXTRACT_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
                tools=None,
                tool_choice=None,
            )
            text = (response.content or "").strip()
            # Find JSON in response — LLM may wrap it in markdown code fences
            json_match = re.search(r"\{.*\}", text, re.DOTALL)
            if json_match:
                extracted = json.loads(json_match.group())
                if isinstance(extracted, dict):
                    return extracted
        except (json.JSONDecodeError, Exception):
            logger.debug("Entity extraction failed or returned non-JSON")
        return {}

    @staticmethod
    def merge_profile(
        current: dict[str, Any],
        extracted: dict[str, Any],
    ) -> dict[str, Any]:
        """Merge newly extracted entities into the current profile.

        - Scalar values (name, communication_style) are overwritten by new values.
        - List values (preferences, mentioned_entities, key_facts) are union-merged.
        """
        if not extracted:
            return current

        merged = dict(current)

        # Scalar fields
        for key in ("name", "communication_style"):
            if key in extracted and extracted[key]:
                merged[key] = extracted[key]

        # List fields — union merge
        for key in ("preferences", "mentioned_entities", "key_facts"):
            if key in extracted and isinstance(extracted[key], list):
                existing = set(merged.get(key, []))
                for item in extracted[key]:
                    if item not in existing:
                        merged.setdefault(key, []).append(item)
                        existing.add(item)

        return merged
