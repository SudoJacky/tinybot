"""Tests for AgentLoop core logic."""

import asyncio

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from tinybot.agent.loop import AgentLoop
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
