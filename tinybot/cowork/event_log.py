"""Append-only Cowork event-log storage."""

from __future__ import annotations

import json
import tempfile
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from tinybot.cowork.types import now_iso


EVENT_LOG_SCHEMA = "cowork.event_log.v1"
SNAPSHOT_SCHEMA = "cowork.snapshot.v1"
ARTIFACT_INDEX_SCHEMA = "cowork.artifact_index.v1"


class CoworkEventLogStore:
    """Persist replayable Cowork events beside compact session snapshots."""

    def __init__(self, cowork_dir: Path) -> None:
        self.cowork_dir = cowork_dir
        self.events_dir = cowork_dir / "events"
        self.snapshots_dir = cowork_dir / "snapshots"
        self.artifacts_dir = cowork_dir / "artifacts"

    def ensure_dirs(self) -> None:
        self.events_dir.mkdir(parents=True, exist_ok=True)
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)

    def event_path(self, session_id: str) -> Path:
        return self.events_dir / f"{session_id}.jsonl"

    def snapshot_path(self, session_id: str) -> Path:
        return self.snapshots_dir / f"{session_id}.json"

    def artifact_index_path(self, session_id: str) -> Path:
        return self.artifacts_dir / session_id / "index.json"

    def append(
        self,
        session_id: str,
        event_type: str,
        *,
        category: str,
        payload: dict[str, Any] | None = None,
        actor_id: str | None = None,
        created_at: str | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        self.ensure_dirs()
        record = {
            "schema": EVENT_LOG_SCHEMA,
            "id": event_id or "",
            "session_id": session_id,
            "category": category,
            "type": event_type,
            "actor_id": actor_id,
            "payload": _json_safe(payload or {}),
            "created_at": created_at or now_iso(),
        }
        with self.event_path(session_id).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        return record

    def write_snapshot(self, session_id: str, session_payload: dict[str, Any]) -> Path:
        self.ensure_dirs()
        payload = {
            "schema": SNAPSHOT_SCHEMA,
            "session": _json_safe(session_payload),
            "saved_at": now_iso(),
        }
        return _atomic_write_json(self.snapshot_path(session_id), payload)

    def write_artifact_index(self, session_id: str, artifacts: list[dict[str, Any]]) -> Path:
        self.ensure_dirs()
        payload = {
            "schema": ARTIFACT_INDEX_SCHEMA,
            "session_id": session_id,
            "artifacts": _json_safe(artifacts),
            "updated_at": now_iso(),
        }
        return _atomic_write_json(self.artifact_index_path(session_id), payload)

    def read_snapshot_payloads(self) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        if not self.snapshots_dir.exists():
            return payloads
        for path in sorted(self.snapshots_dir.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            session = raw.get("session") if isinstance(raw, dict) else None
            if isinstance(session, dict):
                payloads.append(session)
        return payloads

    def read_events(self, session_id: str) -> list[dict[str, Any]]:
        path = self.event_path(session_id)
        if not path.exists():
            return []
        events: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                item = json.loads(line)
            except Exception:
                continue
            if isinstance(item, dict):
                events.append(item)
        return events


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=path.parent, suffix=".json")
    try:
        with open(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        Path(temp_path).replace(path)
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise
    return path


def _json_safe(value: Any) -> Any:
    if is_dataclass(value):
        return _json_safe(asdict(value))
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_json_safe(item) for item in value]
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return str(value)
