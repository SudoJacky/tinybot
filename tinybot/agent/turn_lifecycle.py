"""Completed-turn lifecycle orchestration for agent runs."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from loguru import logger

from tinybot.agent.memory import ConversationEvidence, MemoryStore, capture_conversation_evidence
from tinybot.agent.session_handler import SessionHandler
from tinybot.session.manager import Session


class SessionSaver(Protocol):
    def save(self, session: Session) -> None:
        """Persist a session."""


ScheduleBackground = Callable[[Awaitable[Any]], None]
MemoryExtractionConfig = Callable[[], tuple[int, int]]
MemoryExtractionRun = Callable[[str], Awaitable[Any]]
IdleExtractionScheduler = Callable[[str, int], bool]
ConsolidationRun = Callable[[Session], Awaitable[Any]]
ProfileUpdateRun = Callable[[Session, str, str], Awaitable[Any]]


@dataclass(slots=True)
class CompletedTurn:
    """Inputs needed to finalize one completed agent turn."""

    session: Session
    messages: list[dict[str, Any]]
    turn_start_index: int
    runtime_context_tag: str
    memory_references: list[dict[str, Any]] = field(default_factory=list)
    recent_context_references: list[dict[str, Any]] = field(default_factory=list)
    user_text: str = ""
    assistant_text: str = ""
    capture_evidence: bool = True
    schedule_memory_extraction: bool = True
    schedule_consolidation: bool = True
    update_user_profile: bool = True
    clear_checkpoint: bool = True


@dataclass(slots=True)
class CompletedTurnResult:
    """Observable result of completed-turn finalization."""

    messages_before: int
    messages_after: int
    checkpoint_cleared: bool = False
    attached_memory_reference_count: int = 0
    attached_recent_context_reference_count: int = 0
    evidence: list[ConversationEvidence] = field(default_factory=list)
    memory_extraction_scheduled: bool = False
    idle_memory_extraction_scheduled: bool = False
    consolidation_scheduled: bool = False
    user_profile_update_scheduled: bool = False

    @property
    def saved_message_count(self) -> int:
        return max(0, self.messages_after - self.messages_before)


class TurnLifecycle:
    """Coordinate after-effects for completed agent turns."""

    def __init__(
        self,
        *,
        session_handler: SessionHandler,
        sessions: SessionSaver,
        memory_store: MemoryStore,
        schedule_background: ScheduleBackground,
        memory_extraction_config: MemoryExtractionConfig,
        run_memory_extraction: MemoryExtractionRun,
        schedule_idle_extraction: IdleExtractionScheduler,
        consolidate: ConsolidationRun | None = None,
        update_user_profile: ProfileUpdateRun | None = None,
    ) -> None:
        self.session_handler = session_handler
        self.sessions = sessions
        self.memory_store = memory_store
        self.schedule_background = schedule_background
        self.memory_extraction_config = memory_extraction_config
        self.run_memory_extraction = run_memory_extraction
        self.schedule_idle_extraction = schedule_idle_extraction
        self.consolidate = consolidate
        self.update_user_profile = update_user_profile

    def finalize(self, turn: CompletedTurn) -> CompletedTurnResult:
        """Finalize a completed turn after provider/tool execution is done."""
        messages_before = len(turn.session.messages)
        self.session_handler.save_turn(
            turn.session,
            turn.messages,
            messages_before,
            turn.runtime_context_tag,
        )
        if turn.clear_checkpoint:
            self.session_handler.clear_checkpoint(turn.session)

        memory_refs = self._attach_references_to_latest_assistant(
            turn.session,
            turn.turn_start_index,
            "_memory_references",
            turn.memory_references,
        )
        recent_refs = self._attach_references_to_latest_assistant(
            turn.session,
            turn.turn_start_index,
            "_recent_context_references",
            turn.recent_context_references,
        )
        self.sessions.save(turn.session)

        evidence: list[ConversationEvidence] = []
        if turn.capture_evidence:
            evidence = self._capture_evidence(turn.session, turn.turn_start_index)

        extraction_scheduled = False
        idle_scheduled = False
        if turn.schedule_memory_extraction and evidence:
            extraction_scheduled, idle_scheduled = self._schedule_memory_extraction_triggers(
                turn.session,
                evidence,
            )

        consolidation_scheduled = False
        if turn.schedule_consolidation and self.consolidate is not None:
            self.schedule_background(self.consolidate(turn.session))
            consolidation_scheduled = True

        profile_scheduled = False
        if turn.update_user_profile and self.update_user_profile is not None:
            self.schedule_background(
                self.update_user_profile(
                    turn.session,
                    turn.user_text,
                    turn.assistant_text,
                )
            )
            profile_scheduled = True

        return CompletedTurnResult(
            messages_before=messages_before,
            messages_after=len(turn.session.messages),
            checkpoint_cleared=turn.clear_checkpoint,
            attached_memory_reference_count=memory_refs,
            attached_recent_context_reference_count=recent_refs,
            evidence=evidence,
            memory_extraction_scheduled=extraction_scheduled,
            idle_memory_extraction_scheduled=idle_scheduled,
            consolidation_scheduled=consolidation_scheduled,
            user_profile_update_scheduled=profile_scheduled,
        )

    def _capture_evidence(
        self,
        session: Session,
        turn_start_index: int,
    ) -> list[ConversationEvidence]:
        try:
            return capture_conversation_evidence(
                self.memory_store,
                session_key=session.key,
                messages=session.messages[turn_start_index:],
                start_index=turn_start_index,
            )
        except Exception:
            logger.exception("Conversation Evidence capture failed for {}", session.key)
            return []

    @staticmethod
    def _attach_references_to_latest_assistant(
        session: Session,
        turn_start_index: int,
        field_name: str,
        references: list[dict[str, Any]],
    ) -> int:
        if not references:
            return 0
        for idx in range(len(session.messages) - 1, max(turn_start_index, 0) - 1, -1):
            message = session.messages[idx]
            if message.get("role") == "assistant":
                message[field_name] = references
                return len(references)
        return 0

    def _schedule_memory_extraction_triggers(
        self,
        session: Session,
        evidence: list[ConversationEvidence],
    ) -> tuple[bool, bool]:
        if not evidence or not any(record.role == "user" for record in evidence):
            return False, False

        every_n, idle_seconds = self.memory_extraction_config()
        state = session.metadata.setdefault("memory_extraction", {})
        if not isinstance(state, dict):
            state = {}
            session.metadata["memory_extraction"] = state

        completed_turns = int(state.get("completed_user_turns") or 0) + 1
        state["completed_user_turns"] = completed_turns
        should_run_now = completed_turns in {1, 2, 4}
        if completed_turns > 4 and (completed_turns - 4) % every_n == 0:
            should_run_now = True
        self.sessions.save(session)

        if should_run_now:
            self.schedule_background(self.run_memory_extraction(session.key))

        idle_scheduled = self.schedule_idle_extraction(session.key, idle_seconds)
        return should_run_now, idle_scheduled
