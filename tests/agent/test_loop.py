"""Tests for AgentLoop core logic."""

import asyncio

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from tinybot.agent.loop import AgentLoop
from tinybot.agent.turn_lifecycle import CompletedTurn
from tinybot.agent.stream_handler import StreamHandler
from tinybot.agent.memory import MemoryStore
from tinybot.session.manager import Session


class TestLoopHookMergeStreamBuffer:
    """Tests for StreamHandler.merge_stream_buffer static method."""

    def test_empty_delta(self):
        """Empty delta should return previous buffer unchanged."""
        previous = "Hello"
        delta = ""
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == previous
        assert result_inc == ""

    def test_empty_previous(self):
        """Empty previous with delta should return delta as buffer."""
        previous = ""
        delta = "Hello"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == delta
        assert result_inc == delta

    def test_normal_append(self):
        """Normal append should work correctly."""
        previous = "Hello"
        delta = " World"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == "Hello World"
        assert result_inc == " World"

    def test_delta_starts_with_previous(self):
        """When delta starts with previous, it replaces buffer."""
        previous = "Hello"
        delta = "Hello World"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == "Hello World"
        assert result_inc == " World"

    def test_strip_hidden_basic(self):
        """Strip hidden mode should handle think tags."""
        previous = "<think>thinking</think>Hello"
        delta = "<think>more</think>Hello World"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta, strip_hidden=True)
        # Should strip think tags and return clean content
        assert result_inc == " World"

    def test_none_previous_handling(self):
        """None previous should be handled - method expects strings."""
        # In real usage, buffers are always strings


class TestAgentLoopPlaceholder:
    """Placeholder tests for AgentLoop module."""

    def test_placeholder(self):
        """Placeholder test - AgentLoop tests will be added in T002."""
        # This test exists to verify the test framework is working
        assert True

    @pytest.mark.asyncio
    async def test_async_placeholder(self):
        """Placeholder async test."""
        # Verify async test support works
        assert True


@pytest.mark.asyncio
async def test_memory_extraction_triggers_warmup_and_prevent_overlap(tmp_path):
    loop = AgentLoop.__new__(AgentLoop)
    loop.context = SimpleNamespace(memory=MemoryStore(tmp_path))
    loop.sessions = MagicMock()
    loop._config_ref = SimpleNamespace(
        agents=SimpleNamespace(
            defaults=SimpleNamespace(dream=SimpleNamespace(extraction_every_n_turns=3, extraction_idle_seconds=60))
        )
    )
    loop._memory_extraction_locks = {}
    loop._memory_extraction_run_lock = asyncio.Lock()
    loop._memory_extraction_idle_tasks = {}
    loop._background_tasks = []
    loop.dream = SimpleNamespace(run=AsyncMock(return_value=True))

    scheduled = []

    def fake_schedule(coro):
        scheduled.append(coro)
        coro.close()

    loop._schedule_background = fake_schedule
    session = Session(key="cli:test")
    evidence = [SimpleNamespace(role="user")]

    loop._schedule_memory_extraction_triggers(session, evidence)
    loop._schedule_memory_extraction_triggers(session, evidence)
    loop._schedule_memory_extraction_triggers(session, evidence)

    assert session.metadata["memory_extraction"]["completed_user_turns"] == 3
    assert len(scheduled) == 2

    lock = asyncio.Lock()
    await lock.acquire()
    loop._memory_extraction_locks[session.key] = lock
    loop.sessions.get.return_value = session
    await loop._run_memory_extraction_once(session.key)

    assert session.metadata["memory_extraction"]["pending"] is True
    loop.dream.run.assert_not_awaited()

    for task in list(loop._background_tasks):
        task.cancel()
    await asyncio.gather(*loop._background_tasks, return_exceptions=True)


def test_recent_context_references_attach_to_latest_assistant():
    loop = AgentLoop.__new__(AgentLoop)
    session = Session(key="websocket:test")
    session.add_message("user", "What should I prepare?")
    session.add_message("assistant", "Pack light.")
    references = [{"evidence_id": "ev_1", "excerpt": "Tokyo flight tomorrow."}]

    loop._attach_recent_context_references_to_latest_assistant(session, 0, references)

    assert session.messages[-1]["_recent_context_references"] == references
    assert "_memory_references" not in session.messages[-1]


@pytest.mark.asyncio
async def test_process_direct_finalizes_through_turn_lifecycle():
    loop = AgentLoop.__new__(AgentLoop)
    loop.task_progress_state = SimpleNamespace(reset=lambda: None)
    loop.sessions = MagicMock()
    session = Session(key="api:test")
    loop.sessions.get_or_create.return_value = session
    loop.commands = SimpleNamespace(dispatch=AsyncMock(return_value=None))
    loop.consolidator = SimpleNamespace(maybe_consolidate_by_tokens=AsyncMock(return_value=None))
    loop._set_tool_context = lambda *args, **kwargs: None
    loop.tools = MagicMock()
    loop.tools.get.return_value = None
    loop.context = SimpleNamespace(
        last_memory_references=[{"note_id": "note_1"}],
        last_recent_context_references=[{"evidence_id": "ev_1"}],
    )
    loop.context.build_messages = MagicMock(return_value=[{"role": "user", "content": "Hello"}])
    loop._run_agent_loop = AsyncMock(
        return_value=(
            "Hi there.",
            None,
            [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there."},
            ],
            "stop",
        )
    )
    loop._connect_mcp = AsyncMock(return_value=None)

    class FakeLifecycle:
        def __init__(self):
            self.turns: list[CompletedTurn] = []

        def finalize(self, turn: CompletedTurn):
            self.turns.append(turn)

    lifecycle = FakeLifecycle()
    loop.turn_lifecycle = lifecycle

    response = await loop.process_direct(
        "Hello",
        session_key="api:test",
        channel="api",
        chat_id="default",
    )

    assert response is not None
    assert response.content == "Hi there."
    assert loop.sessions.get_or_create.call_args.args == ("api:test",)
    assert len(lifecycle.turns) == 1
    turn = lifecycle.turns[0]
    assert turn.session is session
    assert turn.messages[-1]["content"] == "Hi there."
    assert turn.memory_references == [{"note_id": "note_1"}]
    assert turn.recent_context_references == [{"evidence_id": "ev_1"}]
    assert turn.user_text == "Hello"
    assert turn.assistant_text == "Hi there."
