"""Experience accumulator for background processing after agent run completes."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from loguru import logger

from tinybot.agent.experience import ExperienceStore


class ExperienceAccumulator:
    """Background experience processor that runs after agent completes.

    Analyzes tool_events from a completed run and:
    - For success events: boost confidence of similar experiences or create new
    - For error events: record failure (if no similar resolved experience exists)

    This runs asynchronously after the agent finishes responding to the user,
    so it doesn't block the conversation flow.
    """

    def __init__(self, store: ExperienceStore):
        self.store = store

    async def accumulate_from_events(
        self,
        tool_events: list[dict[str, str]],
        session_key: str,
    ) -> int:
        """Process tool events and accumulate experiences.

        Args:
            tool_events: List of tool execution events from AgentRunResult.
            session_key: The session where these events occurred.

        Returns:
            Number of experiences added or updated.
        """
        if not tool_events:
            return 0

        count = 0
        for event in tool_events:
            tool_name = event.get("name", "")
            status = event.get("status", "")
            detail = event.get("detail", "")

            if not tool_name:
                continue

            if status == "ok":
                count += self._process_success(tool_name, detail, session_key)
            elif status == "error":
                count += self._process_error(tool_name, detail, session_key)

        # Compact if needed
        self.store.compact()

        if count > 0:
            logger.debug(
                "ExperienceAccumulator: accumulated {} experiences from {} events",
                count, len(tool_events)
            )

        return count

    def _process_success(self, tool_name: str, detail: str, session_key: str) -> int:
        """Process a successful tool execution.

        If similar success experience exists, boost its confidence.
        Otherwise, create a new success experience.
        """
        # Find existing success experience for this tool
        existing = self.store.search_by_context(
            tool_name=tool_name,
            outcome="success",
            limit=1,
        )

        if existing:
            # Already have success record for this tool - boost confidence via merge
            # The merge_similar call will handle confidence boost
            self.store.merge_similar()
            return 0  # No new entry created

        # Create new success experience
        self.store.append_experience(
            tool_name=tool_name,
            outcome="success",
            resolution="Tool executed successfully",
            confidence=0.5,
            session_key=session_key,
        )
        return 1

    def _process_error(self, tool_name: str, detail: str, session_key: str) -> int:
        """Process a failed tool execution.

        If a resolved experience for similar error exists, don't record failure.
        If a similar failure already recorded, increment its count.
        Otherwise, create a new failure record.
        """
        # Parse error type from detail
        error_type = "UnknownError"
        error_message = detail[:200] if detail else ""

        if ":" in detail:
            parts = detail.split(":", 1)
            error_type = parts[0].strip() or "UnknownError"
            error_message = parts[1].strip()[:200] if len(parts) > 1 else ""

        # Check if similar error already has a resolution
        resolved = self.store.search_by_context(
            tool_name=tool_name,
            error_type=error_type,
            outcome="resolved",
            limit=1,
        )

        if resolved:
            # Already have solution for this error - don't duplicate failure record
            logger.debug(
                "ExperienceAccumulator: skipping failure {} {} - already resolved",
                tool_name, error_type
            )
            return 0

        # Check if similar failure already recorded
        existing_failure = self.store.search_by_context(
            tool_name=tool_name,
            error_type=error_type,
            outcome="failure",
            limit=1,
        )

        if existing_failure:
            # Similar failure already recorded - merge will handle frequency tracking
            self.store.merge_similar()
            return 0

        # Create new failure record (waiting for future resolution)
        self.store.append_experience(
            tool_name=tool_name,
            error_type=error_type,
            error_message=error_message,
            outcome="failure",
            resolution="",  # Empty - waiting to be resolved
            confidence=0.3,
            session_key=session_key,
        )
        logger.debug(
            "ExperienceAccumulator: recorded failure {} {}",
            tool_name, error_type
        )
        return 1
