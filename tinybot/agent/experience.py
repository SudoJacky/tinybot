"""Experience storage for self-evolution: record tool call outcomes and solutions."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from tinybot.utils.fs import ensure_dir


@dataclass
class Experience:
    """A single experience record representing a tool call outcome."""

    id: str = ""
    timestamp: str = ""
    tool_name: str = ""
    error_type: str = ""
    error_message: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    outcome: str = "success"  # "success" | "failure" | "resolved"
    resolution: str = ""
    confidence: float = 0.5
    session_key: str = ""
    merged_count: int = 0  # Number of similar experiences merged into this one


class ExperienceStore:
    """File-based storage for tool call experiences.

    Experiences are stored in JSONL format (append-only) for durability.
    Supports keyword-based search and merging of similar experiences.
    """

    _DEFAULT_MAX_EXPERIENCES = 500

    def __init__(self, workspace: Path, max_experiences: int = _DEFAULT_MAX_EXPERIENCES):
        self.workspace = workspace
        self.max_experiences = max_experiences
        self.experience_dir = ensure_dir(workspace / "experiences")
        self.experience_file = self.experience_dir / "experiences.jsonl"
        self._cursor_file = self.experience_dir / ".cursor"

    # -- Core operations -----------------------------------------------------

    def append_experience(
        self,
        tool_name: str,
        error_type: str = "",
        error_message: str = "",
        params: dict[str, Any] | None = None,
        outcome: str = "success",
        resolution: str = "",
        confidence: float = 0.5,
        session_key: str = "",
    ) -> str:
        """Append a new experience and return its ID.

        Args:
            tool_name: The tool that was called.
            error_type: Exception type if failed (e.g., "FileNotFoundError").
            error_message: The error message if failed.
            params: The parameters used (summary, not full detail).
            outcome: "success", "failure", or "resolved" (failed then fixed).
            resolution: How the problem was solved (for "resolved" outcomes).
            confidence: Initial confidence score (0.0-1.0).
            session_key: The session where this occurred.

        Returns:
            The new experience's ID.
        """
        now = datetime.now()
        ts = now.strftime("%Y-%m-%dT%H:%M:%S")

        # Generate ID: timestamp hash + random suffix
        id_base = f"{ts}:{tool_name}:{error_type}:{session_key}"
        id_hash = hashlib.sha1(id_base.encode()).hexdigest()[:8]
        exp_id = f"exp_{id_hash}"

        exp = Experience(
            id=exp_id,
            timestamp=ts,
            tool_name=tool_name,
            error_type=error_type,
            error_message=error_message[:200] if error_message else "",
            params=params or {},
            outcome=outcome,
            resolution=resolution[:500] if resolution else "",
            confidence=min(1.0, max(0.0, confidence)),
            session_key=session_key,
        )

        record = asdict(exp)
        with open(self.experience_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

        self._cursor_file.write_text(str(len(self.read_experiences())), encoding="utf-8")
        logger.debug("ExperienceStore: appended {} ({}/{})", exp_id, tool_name, outcome)

        return exp_id

    def read_experiences(self) -> list[Experience]:
        """Read all experiences from the JSONL file."""
        experiences: list[Experience] = []
        try:
            with open(self.experience_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        experiences.append(Experience(**data))
                    except (json.JSONDecodeError, TypeError):
                        continue
        except FileNotFoundError:
            pass
        return experiences

    # -- Search operations ----------------------------------------------------

    def search_by_context(
        self,
        tool_name: str | None = None,
        error_type: str | None = None,
        outcome: str | None = None,
        keywords: list[str] | None = None,
        min_confidence: float = 0.0,
        limit: int = 10,
    ) -> list[Experience]:
        """Search experiences by context criteria (keyword matching).

        Args:
            tool_name: Exact match on tool name.
            error_type: Exact match on error type.
            outcome: Exact match on outcome.
            keywords: Keywords to match in resolution text (case-insensitive).
            min_confidence: Minimum confidence threshold.
            limit: Maximum number of results.

        Returns:
            List of matching experiences, sorted by confidence descending.
        """
        experiences = self.read_experiences()
        results: list[Experience] = []

        for exp in experiences:
            # Exact matches
            if tool_name and exp.tool_name != tool_name:
                continue
            if error_type and exp.error_type != error_type:
                continue
            if outcome and exp.outcome != outcome:
                continue
            if exp.confidence < min_confidence:
                continue

            # Keyword matching in resolution
            if keywords:
                resolution_lower = exp.resolution.lower()
                if not any(kw.lower() in resolution_lower for kw in keywords):
                    continue

            results.append(exp)

        # Sort by confidence descending
        results.sort(key=lambda e: e.confidence, reverse=True)
        return results[:limit]

    def get_similar_experiences(
        self,
        tool_name: str,
        error_type: str = "",
        limit: int = 5,
        min_confidence: float = 0.3,
    ) -> list[Experience]:
        """Get experiences similar to a given tool + error context.

        This is the primary method used when a tool fails to find
        relevant past resolutions.

        Args:
            tool_name: The tool that failed.
            error_type: The error type that occurred.
            limit: Maximum results.
            min_confidence: Minimum confidence to include.

        Returns:
            List of similar experiences with resolutions.
        """
        # First try exact match on tool + error
        exact = self.search_by_context(
            tool_name=tool_name,
            error_type=error_type,
            outcome="resolved",
            min_confidence=min_confidence,
            limit=limit,
        )

        if len(exact) >= limit:
            return exact

        # Fall back to tool-only match if not enough exact matches
        tool_only = self.search_by_context(
            tool_name=tool_name,
            outcome="resolved",
            min_confidence=min_confidence,
            limit=limit - len(exact),
        )

        # Deduplicate by ID
        seen_ids = {e.id for e in exact}
        combined = exact + [e for e in tool_only if e.id not in seen_ids]
        return combined[:limit]

    # -- Merge and maintenance operations -------------------------------------

    def merge_similar(self) -> int:
        """Merge similar experiences and update confidence.

        Experiences with same tool_name + error_type + outcome are merged.
        The merged experience gets higher confidence based on occurrence count.

        Returns:
            Number of experiences merged (removed).
        """
        experiences = self.read_experiences()
        if not experiences:
            return 0

        # Group by (tool_name, error_type, outcome)
        groups: dict[str, list[Experience]] = {}
        for exp in experiences:
            key = f"{exp.tool_name}:{exp.error_type}:{exp.outcome}"
            groups.setdefault(key, []).append(exp)

        merged_count = 0
        new_experiences: list[Experience] = []

        for key, group in groups.items():
            if len(group) == 1:
                # No merging needed
                new_experiences.append(group[0])
                continue

            # Sort by timestamp descending (keep latest resolution)
            group.sort(key=lambda e: e.timestamp, reverse=True)

            # Create merged experience
            base = group[0]
            merged = Experience(
                id=base.id,
                timestamp=base.timestamp,
                tool_name=base.tool_name,
                error_type=base.error_type,
                error_message=base.error_message,
                params=base.params,
                outcome=base.outcome,
                resolution=base.resolution,
                # Confidence increases with more occurrences
                confidence=min(1.0, 0.5 + 0.1 * len(group)),
                session_key=base.session_key,
                merged_count=len(group),
            )
            new_experiences.append(merged)
            merged_count += len(group) - 1

        # Rewrite the file with merged experiences
        self._write_experiences(new_experiences)
        logger.info("ExperienceStore: merged {} experiences", merged_count)
        return merged_count

    def compact(self) -> None:
        """Remove old experiences if exceeding max_experiences limit."""
        experiences = self.read_experiences()
        if len(experiences) <= self.max_experiences:
            return

        # Sort by confidence and timestamp, keep best ones
        experiences.sort(key=lambda e: (e.confidence, e.timestamp), reverse=True)
        kept = experiences[:self.max_experiences]
        self._write_experiences(kept)
        logger.info("ExperienceStore: compacted to {} experiences", len(kept))

    def _write_experiences(self, experiences: list[Experience]) -> None:
        """Overwrite the experience file with given experiences."""
        with open(self.experience_file, "w", encoding="utf-8") as f:
            for exp in experiences:
                f.write(json.dumps(asdict(exp), ensure_ascii=False) + "\n")
        self._cursor_file.write_text(str(len(experiences)), encoding="utf-8")

    # -- Stats and debug -----------------------------------------------------

    def get_stats(self) -> dict[str, Any]:
        """Return statistics about the experience store."""
        experiences = self.read_experiences()
        if not experiences:
            return {"count": 0, "tools": {}, "outcomes": {}}

        tools: dict[str, int] = {}
        outcomes: dict[str, int] = {}
        avg_confidence = 0.0

        for exp in experiences:
            tools[exp.tool_name] = tools.get(exp.tool_name, 0) + 1
            outcomes[exp.outcome] = outcomes.get(exp.outcome, 0) + 1
            avg_confidence += exp.confidence

        return {
            "count": len(experiences),
            "tools": tools,
            "outcomes": outcomes,
            "avg_confidence": avg_confidence / len(experiences),
            "merged_total": sum(e.merged_count for e in experiences),
        }
