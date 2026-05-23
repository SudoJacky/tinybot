"""Tests for completed-turn lifecycle orchestration."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from tinybot.agent.memory import MemoryStore
from tinybot.agent.session_handler import SessionHandler
from tinybot.agent.turn_lifecycle import CompletedTurn, TurnLifecycle
from tinybot.session.manager import Session


class FakeSessions:
    def __init__(self) -> None:
        self.saved: list[Session] = []

    def save(self, session: Session) -> None:
        self.saved.append(session)


@dataclass
class FakeRuntime:
    scheduled: list[Any] = field(default_factory=list)
    idle: list[tuple[str, int]] = field(default_factory=list)

    def schedule_background(self, item: Any) -> None:
        self.scheduled.append(item)

    def memory_extraction_config(self) -> tuple[int, int]:
        return 3, 60

    async def run_memory_extraction(self, session_key: str) -> str:
        return f"extract:{session_key}"

    def schedule_idle_extraction(self, session_key: str, seconds: int) -> bool:
        self.idle.append((session_key, seconds))
        return True

    async def consolidate(self, session: Session) -> str:
        return f"consolidate:{session.key}"

    async def update_profile(self, session: Session, user_text: str, assistant_text: str) -> str:
        return f"profile:{session.key}:{user_text}:{assistant_text}"

    def close_scheduled(self) -> None:
        for item in self.scheduled:
            close = getattr(item, "close", None)
            if callable(close):
                close()


def _lifecycle(tmp_path, runtime: FakeRuntime, sessions: FakeSessions) -> TurnLifecycle:
    return TurnLifecycle(
        session_handler=SessionHandler(max_tool_result_chars=10000),
        sessions=sessions,
        memory_store=MemoryStore(tmp_path),
        schedule_background=runtime.schedule_background,
        memory_extraction_config=runtime.memory_extraction_config,
        run_memory_extraction=runtime.run_memory_extraction,
        schedule_idle_extraction=runtime.schedule_idle_extraction,
        consolidate=runtime.consolidate,
        update_user_profile=runtime.update_profile,
    )


def test_real_user_turn_finalizes_in_order(tmp_path):
    runtime = FakeRuntime()
    sessions = FakeSessions()
    lifecycle = _lifecycle(tmp_path, runtime, sessions)
    session = Session(key="cli:test")
    session.metadata[SessionHandler.RUNTIME_CHECKPOINT_KEY] = {"phase": "final_response"}
    turn_start_index = len(session.messages)
    memory_refs = [{"note_id": "note_1"}]
    recent_refs = [{"evidence_id": "ev_1"}]

    result = lifecycle.finalize(
        CompletedTurn(
            session=session,
            turn_start_index=turn_start_index,
            messages=[
                {"role": "user", "content": "Remember this project decision."},
                {"role": "assistant", "content": "I will keep that in mind."},
            ],
            runtime_context_tag="[Runtime Context]",
            memory_references=memory_refs,
            recent_context_references=recent_refs,
            user_text="Remember this project decision.",
            assistant_text="I will keep that in mind.",
        )
    )

    assert SessionHandler.RUNTIME_CHECKPOINT_KEY not in session.metadata
    assert session.messages[-1]["_memory_references"] == memory_refs
    assert session.messages[-1]["_recent_context_references"] == recent_refs
    assert [record.role for record in result.evidence] == ["user", "assistant"]
    assert session.metadata["memory_extraction"]["completed_user_turns"] == 1
    assert result.memory_extraction_scheduled is True
    assert result.idle_memory_extraction_scheduled is True
    assert result.consolidation_scheduled is True
    assert result.user_profile_update_scheduled is True
    assert len(sessions.saved) >= 2
    assert len(runtime.scheduled) == 3
    assert runtime.idle == [("cli:test", 60)]
    runtime.close_scheduled()


def test_synthetic_turn_can_skip_evidence_and_extraction(tmp_path):
    runtime = FakeRuntime()
    sessions = FakeSessions()
    lifecycle = _lifecycle(tmp_path, runtime, sessions)
    session = Session(key="cli:test")

    result = lifecycle.finalize(
        CompletedTurn(
            session=session,
            turn_start_index=len(session.messages),
            messages=[{"role": "assistant", "content": "Background task completed."}],
            runtime_context_tag="[Runtime Context]",
            capture_evidence=False,
            schedule_memory_extraction=False,
            update_user_profile=False,
        )
    )

    assert result.evidence == []
    assert "memory_extraction" not in session.metadata
    assert result.memory_extraction_scheduled is False
    assert result.idle_memory_extraction_scheduled is False
    assert result.consolidation_scheduled is True
    assert result.user_profile_update_scheduled is False
    assert runtime.idle == []
    assert len(runtime.scheduled) == 1
    runtime.close_scheduled()


def test_references_do_not_attach_to_previous_assistant_without_turn_assistant(tmp_path):
    runtime = FakeRuntime()
    sessions = FakeSessions()
    lifecycle = _lifecycle(tmp_path, runtime, sessions)
    session = Session(key="cli:test")
    session.add_message("assistant", "Previous answer.")
    turn_start_index = len(session.messages)

    result = lifecycle.finalize(
        CompletedTurn(
            session=session,
            turn_start_index=turn_start_index,
            messages=[{"role": "user", "content": "Only a user message."}],
            runtime_context_tag="[Runtime Context]",
            memory_references=[{"note_id": "note_1"}],
            recent_context_references=[{"evidence_id": "ev_1"}],
            schedule_memory_extraction=False,
            schedule_consolidation=False,
            update_user_profile=False,
        )
    )

    assert "_memory_references" not in session.messages[0]
    assert "_recent_context_references" not in session.messages[0]
    assert result.attached_memory_reference_count == 0
    assert result.attached_recent_context_reference_count == 0
    assert result.evidence[0].role == "user"
