"""Tests for AgentLoop core logic."""

import asyncio

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from tinybot.agent.loop import AgentLoop
from tinybot.agent.forms import AgentUiFormRegistry
from tinybot.agent.session_handler import SessionHandler
from tinybot.agent.tool_executor import ToolContextManager
from tinybot.agent.tools.form import FormRequestTool
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.agent.turn_lifecycle import CompletedTurn
from tinybot.agent.stream_handler import StreamHandler
from tinybot.agent.memory import MemoryStore
from tinybot.bus.events import InboundMessage
from tinybot.security.approval import ApprovalRequest, build_fingerprint
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
async def test_memory_extraction_run_marks_pending_when_locked(tmp_path):
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

    session = Session(key="cli:test")

    lock = asyncio.Lock()
    await lock.acquire()
    loop._memory_extraction_locks[session.key] = lock
    loop.sessions.get.return_value = session
    await loop._run_memory_extraction_once(session.key)

    assert session.metadata["memory_extraction"]["pending"] is True
    loop.dream.run.assert_not_awaited()


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


@pytest.mark.asyncio
async def test_webui_form_request_waits_without_final_assistant_reply():
    loop = AgentLoop.__new__(AgentLoop)
    loop.task_progress_state = SimpleNamespace(reset=lambda: None)
    loop.session_handler = SessionHandler(max_tool_result_chars=10000)
    loop.sessions = MagicMock()
    session = Session(key="websocket:chat-1")
    loop.sessions.get_or_create.return_value = session
    loop.commands = SimpleNamespace(dispatch=AsyncMock(return_value=None))
    loop.consolidator = SimpleNamespace(maybe_consolidate_by_tokens=AsyncMock(return_value=None))
    loop._set_tool_context = lambda *args, **kwargs: None
    loop.tools = MagicMock()
    loop.tools.get.return_value = None
    loop.context = SimpleNamespace(
        last_memory_references=[],
        last_recent_context_references=[],
    )
    loop.context.build_messages = MagicMock(return_value=[{"role": "user", "content": "Collect travel preferences."}])
    loop._run_agent_loop = AsyncMock(
        return_value=(
            None,
            ["request_form"],
            [
                {"role": "user", "content": "Collect travel preferences."},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "call_form"}]},
                {"role": "tool", "tool_call_id": "call_form", "name": "request_form", "content": "form requested"},
            ],
            "awaiting_form",
        )
    )

    class FakeLifecycle:
        def __init__(self):
            self.turns: list[CompletedTurn] = []

        def finalize(self, turn: CompletedTurn):
            self.turns.append(turn)

    lifecycle = FakeLifecycle()
    loop.turn_lifecycle = lifecycle

    response = await loop._process_message(
        InboundMessage(
            channel="websocket",
            sender_id="user",
            chat_id="chat-1",
            content="Collect travel preferences.",
        )
    )

    assert response is None
    assert lifecycle.turns == []
    loop.sessions.save.assert_called_once_with(session)


@pytest.mark.asyncio
async def test_approval_continuation_finalizes_through_turn_lifecycle(tmp_path):
    loop = AgentLoop.__new__(AgentLoop)
    loop.session_handler = SessionHandler(max_tool_result_chars=10000)
    loop.sessions = MagicMock()
    loop.consolidator = SimpleNamespace(maybe_consolidate_by_tokens=AsyncMock(return_value=None))
    loop.bus = SimpleNamespace(publish_outbound=AsyncMock())
    loop.context = SimpleNamespace(
        memory=MemoryStore(tmp_path),
        last_memory_references=[{"note_id": "note_1"}],
        last_recent_context_references=[{"evidence_id": "ev_1"}],
    )
    loop.context.build_messages = MagicMock(return_value=[{"role": "system", "content": "Continue after approval."}])
    loop._run_agent_loop = AsyncMock(
        return_value=(
            "Approved work complete.",
            None,
            [
                {"role": "system", "content": "Continue after approval."},
                {"role": "assistant", "content": "Approved work complete."},
            ],
            "stop",
        )
    )
    loop._set_tool_context = lambda *args, **kwargs: None
    loop.tools = MagicMock()
    loop.tools.get.return_value = None

    def fake_schedule_background(item):
        close = getattr(item, "close", None)
        if callable(close):
            close()

    loop._schedule_background = fake_schedule_background

    raw_tool_call = {
        "id": "call_1",
        "function": {"name": "dummy_tool", "arguments": "{}"},
    }
    request = ApprovalRequest(
        id="approval_1",
        tool_name="dummy_tool",
        params={},
        fingerprint=build_fingerprint("dummy_tool", {}, "tool"),
        category="tool",
        risk="medium",
        reason="needs approval",
        summary="dummy_tool({})",
        created_at=1.0,
    )
    session = Session(key="cli:test")
    session.add_message("user", "Please run the approved tool.")
    session.metadata[SessionHandler.RUNTIME_CHECKPOINT_KEY] = {
        "assistant_message": {
            "role": "assistant",
            "content": "",
            "tool_calls": [raw_tool_call],
        },
        "pending_tool_calls": [raw_tool_call],
        "completed_tool_results": [],
        "_use_persistent_knowledge": True,
    }
    loop._execute_resolved_approval_tool = AsyncMock(
        return_value={
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "dummy_tool",
            "content": "tool result",
            "_approval_status": "approved",
            "_approval_id": "approval_1",
        }
    )

    class FakeLifecycle:
        def __init__(self):
            self.turns: list[tuple[CompletedTurn, bool]] = []

        def finalize(self, turn: CompletedTurn):
            checkpoint_present = SessionHandler.RUNTIME_CHECKPOINT_KEY in turn.session.metadata
            self.turns.append((turn, checkpoint_present))

    lifecycle = FakeLifecycle()
    loop.turn_lifecycle = lifecycle
    msg = InboundMessage(
        channel="system",
        sender_id="approval",
        chat_id="cli:test",
        content="Approval resolved.",
        metadata={
            "_approval_resolution": {"id": "approval_1", "approved": True},
            "_approval_request": request.to_dict(),
        },
    )

    response = await loop._process_approval_resolution(
        msg=msg,
        session=session,
        channel="cli",
        chat_id="test",
    )

    assert response is not None
    assert response.content == "Approved work complete."
    assert len(lifecycle.turns) == 1
    turn, checkpoint_present = lifecycle.turns[0]
    assert checkpoint_present is False
    assert turn.session is session
    assert turn.turn_start_index == 0
    assert turn.messages[-1]["content"] == "Approved work complete."
    assert turn.memory_references == [{"note_id": "note_1"}]
    assert turn.recent_context_references == [{"evidence_id": "ev_1"}]
    assert turn.user_text == "Approval resolved."
    assert turn.assistant_text == "Approved work complete."


def test_agent_loop_schedules_form_response_without_approval_grant():
    loop = AgentLoop.__new__(AgentLoop)
    captured: list[InboundMessage] = []

    class FakeBus:
        def publish_inbound(self, message):
            captured.append(message)
            return None

    loop.bus = FakeBus()
    loop._schedule_background = lambda item: None
    registry = AgentUiFormRegistry()
    interaction = registry.create(
        {
            "form_id": "travel-form-1",
            "title": "Travel preferences",
            "correlation": {"session_key": "websocket:chat-1", "chat_id": "chat-1"},
            "fields": [{"name": "destination", "type": "text", "label": "Destination"}],
        },
        continuation={"mode": "resume"},
    )
    registry.submit(interaction.form_id, {"destination": "Shanghai"})

    loop.schedule_form_response(
        interaction=interaction,
        action="submitted",
        payload={
            "values": interaction.submitted_values,
            "schema": interaction.schema,
            "continuation_mode": interaction.continuation_mode,
        },
    )

    assert captured[0].channel == "system"
    assert captured[0].sender_id == "agent-ui-form"
    assert captured[0].chat_id == "websocket:chat-1"
    assert captured[0].metadata["_agent_ui_form_response"]["values"]["destination"] == "Shanghai"
    assert captured[0].metadata["_approval_grant"] is False


def test_agent_loop_applies_context_to_request_form_tool():
    loop = AgentLoop.__new__(AgentLoop)
    loop.tool_context = ToolContextManager()
    loop.tools = ToolRegistry()
    form_tool = FormRequestTool(form_interactions=AgentUiFormRegistry(), send_callback=lambda message: None)
    loop.tools.register(form_tool)
    loop._task_progress_channel = ""
    loop._task_progress_chat_id = ""

    loop._set_tool_context("websocket", "chat-1", "msg-1")

    assert form_tool.current_context == ("websocket", "chat-1", "msg-1")


@pytest.mark.asyncio
async def test_subagent_notification_finalizes_as_synthetic_turn():
    loop = AgentLoop.__new__(AgentLoop)
    loop.task_progress_state = SimpleNamespace(reset=lambda: None)
    loop.session_handler = SessionHandler(max_tool_result_chars=10000)
    loop.sessions = MagicMock()
    session = Session(key="cli:test")
    loop.sessions.get_or_create.return_value = session
    loop.consolidator = SimpleNamespace(maybe_consolidate_by_tokens=AsyncMock(return_value=None))
    loop._set_tool_context = lambda *args, **kwargs: None
    loop.tools = MagicMock()
    loop.tools.get.return_value = None
    loop.context = SimpleNamespace(
        last_memory_references=[],
        last_recent_context_references=[],
    )
    loop.context.build_messages = MagicMock(return_value=[{"role": "user", "content": "subagent finished"}])
    loop._run_agent_loop = AsyncMock(
        return_value=(
            "Background task completed.",
            None,
            [{"role": "assistant", "content": "Background task completed."}],
            "stop",
        )
    )

    class FakeLifecycle:
        def __init__(self):
            self.turns: list[CompletedTurn] = []

        def finalize(self, turn: CompletedTurn):
            self.turns.append(turn)

    lifecycle = FakeLifecycle()
    loop.turn_lifecycle = lifecycle
    msg = InboundMessage(
        channel="system",
        sender_id="subagent",
        chat_id="cli:test",
        content="subagent finished",
    )

    response = await loop._process_message(msg)

    assert response is not None
    assert response.content == "Background task completed."
    assert len(lifecycle.turns) == 1
    turn = lifecycle.turns[0]
    assert turn.capture_evidence is False
    assert turn.schedule_memory_extraction is False
    assert turn.update_user_profile is False
    assert turn.messages == [{"role": "assistant", "content": "Background task completed."}]
