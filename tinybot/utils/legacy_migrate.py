"""Legacy history migration utility.

This module handles one-time migration from legacy HISTORY.md format to
history.jsonl. It is called during MemoryStore initialization and can be
removed once all users have upgraded (recommend: after 2-3 major releases).

Migration is best-effort and prioritizes preserving as much content as
possible over perfect parsing.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from loguru import logger

# Regex patterns for parsing legacy HISTORY.md format
_LEGACY_ENTRY_START_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*")
_LEGACY_TIMESTAMP_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*")
_LEGACY_RAW_MESSAGE_RE = re.compile(
    r"^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[A-Z][A-Z0-9_]*(?:\s+\[tools:\s*[^\]]+\])?:"
)


def migrate_legacy_history(memory_dir: Path) -> bool:
    """Migrate legacy HISTORY.md to history.jsonl if needed.

    Args:
        memory_dir: Path to the memory directory containing HISTORY.md and history.jsonl.

    Returns:
        True if migration was performed, False if no migration needed or failed.
    """
    legacy_file = memory_dir / "HISTORY.md"
    history_file = memory_dir / "history.jsonl"
    cursor_file = memory_dir / ".cursor"
    dream_cursor_file = memory_dir / ".dream_cursor"

    if not legacy_file.exists():
        return False
    if history_file.exists() and history_file.stat().st_size > 0:
        return False

    try:
        legacy_text = legacy_file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        logger.exception("Failed to read legacy HISTORY.md for migration")
        return False

    entries = _parse_legacy_history(legacy_text, legacy_file)
    if not entries:
        return False

    try:
        _write_entries(history_file, entries)
        last_cursor = entries[-1]["cursor"]
        cursor_file.write_text(str(last_cursor), encoding="utf-8")
        # Mark as already processed so upgrades don't replay into Dream
        dream_cursor_file.write_text(str(last_cursor), encoding="utf-8")

        backup_path = _next_legacy_backup_path(memory_dir)
        legacy_file.replace(backup_path)
        logger.info("Migrated legacy HISTORY.md to history.jsonl ({} entries)", len(entries))
        return True
    except Exception:
        logger.exception("Failed to migrate legacy HISTORY.md")
        return False


def _parse_legacy_history(text: str, legacy_file: Path) -> list[dict]:
    """Parse legacy HISTORY.md text into structured entries."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []

    fallback_timestamp = _legacy_fallback_timestamp(legacy_file)
    entries: list[dict] = []
    chunks = _split_legacy_history_chunks(normalized)

    for cursor, chunk in enumerate(chunks, start=1):
        timestamp = fallback_timestamp
        content = chunk
        match = _LEGACY_TIMESTAMP_RE.match(chunk)
        if match:
            timestamp = match.group(1)
            remainder = chunk[match.end():].lstrip()
            if remainder:
                content = remainder

        entries.append({
            "cursor": cursor,
            "timestamp": timestamp,
            "content": content,
        })
    return entries


def _split_legacy_history_chunks(text: str) -> list[str]:
    """Split legacy history text into individual entry chunks."""
    lines = text.split("\n")
    chunks: list[str] = []
    current: list[str] = []
    saw_blank_separator = False

    for line in lines:
        if saw_blank_separator and line.strip() and current:
            chunks.append("\n".join(current).strip())
            current = [line]
            saw_blank_separator = False
            continue
        if _should_start_new_legacy_chunk(line, current):
            chunks.append("\n".join(current).strip())
            current = [line]
            saw_blank_separator = False
            continue
        current.append(line)
        saw_blank_separator = not line.strip()

    if current:
        chunks.append("\n".join(current).strip())
    return [chunk for chunk in chunks if chunk]


def _should_start_new_legacy_chunk(line: str, current: list[str]) -> bool:
    """Determine if a new history entry chunk should start."""
    if not current:
        return False
    if not _LEGACY_ENTRY_START_RE.match(line):
        return False
    if _is_raw_legacy_chunk(current) and _LEGACY_RAW_MESSAGE_RE.match(line):
        return False
    return True


def _is_raw_legacy_chunk(lines: list[str]) -> bool:
    """Check if current chunk is a RAW message block."""
    first_nonempty = next((line for line in lines if line.strip()), "")
    match = _LEGACY_TIMESTAMP_RE.match(first_nonempty)
    if not match:
        return False
    return first_nonempty[match.end():].lstrip().startswith("[RAW]")


def _legacy_fallback_timestamp(legacy_file: Path) -> str:
    """Get fallback timestamp from file modification time."""
    try:
        return datetime.fromtimestamp(legacy_file.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    except OSError:
        return datetime.now().strftime("%Y-%m-%d %H:%M")


def _next_legacy_backup_path(memory_dir: Path) -> Path:
    """Generate next available backup path for legacy file."""
    candidate = memory_dir / "HISTORY.md.bak"
    suffix = 2
    while candidate.exists():
        candidate = memory_dir / f"HISTORY.md.bak.{suffix}"
        suffix += 1
    return candidate


def _write_entries(history_file: Path, entries: list[dict]) -> None:
    """Write entries to history.jsonl file."""
    with open(history_file, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
