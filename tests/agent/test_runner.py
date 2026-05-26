from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tinybot.agent.runner import AgentRunSpec, AgentRunner
from tinybot.agent.hook import AgentHook
from tinybot.agent.tools.base import AwaitingUserInputResult, Tool, tool_parameters
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.providers.base import LLMResponse, ToolCallArgumentDelta, ToolCallRequest


class _Provider:
    generation = SimpleNamespace(max_tokens=128)

    def __init__(self) -> None:
        self.calls = 0

    def estimate_prompt_tokens(self, messages, tools, model):
        return 1, "fake"

    async def chat_with_retry(self, **kwargs):
        self.calls += 1
        if self.calls > 1:
            raise AssertionError("provider should not be called again after awaiting user input")
        return LLMResponse(
            content="",
            tool_calls=[
                ToolCallRequest(
                    id="call_form",
                    name="request_form",
                    arguments={"form": {"form_id": "travel-form-1"}},
                )
            ],
        )


@tool_parameters({"type": "object", "properties": {"form": {"type": "object"}}, "required": ["form"]})
class _AwaitingFormTool(Tool):
    @property
    def name(self) -> str:
        return "request_form"

    @property
    def description(self) -> str:
        return "test form tool"

    async def execute(self, **kwargs: Any) -> AwaitingUserInputResult:
        return AwaitingUserInputResult(
            "Agent UI form `travel-form-1` requested asynchronously.",
            stop_reason="awaiting_form",
        )


@pytest.mark.asyncio
async def test_runner_stops_after_tool_requests_user_input():
    provider = _Provider()
    tools = ToolRegistry()
    tools.register(_AwaitingFormTool())
    runner = AgentRunner(provider)

    result = await runner.run(
        AgentRunSpec(
            initial_messages=[{"role": "user", "content": "Collect travel preferences."}],
            tools=tools,
            model="test-model",
            max_iterations=3,
            max_tool_result_chars=1000,
        )
    )

    assert provider.calls == 1
    assert result.stop_reason == "awaiting_form"
    assert result.final_content is None
    assert result.messages[-1]["role"] == "tool"
    assert result.messages[-1]["content"] == "Agent UI form `travel-form-1` requested asynchronously."
    assert result.messages[-1]["_awaiting_user_input"] is True
    assert result.messages[-1]["_agent_ui_internal"] is True


class _StreamingToolDeltaProvider:
    generation = SimpleNamespace(max_tokens=128)

    def estimate_prompt_tokens(self, messages, tools, model):
        return 1, "fake"

    async def chat_stream_with_retry(self, **kwargs):
        await kwargs["on_tool_call_delta"](
            ToolCallArgumentDelta(
                provider_call_id="chatcmpl-1",
                tool_call_id="call_form",
                tool_call_index=0,
                tool_name="request_form",
                sequence=1,
                delta_text='{"form":',
                phase="arguments",
                status="streaming",
                completed=False,
            )
        )
        return LLMResponse(
            content="",
            tool_calls=[
                ToolCallRequest(
                    id="call_form",
                    name="request_form",
                    arguments={"form": {"form_id": "travel-form-1"}},
                )
            ],
        )


class _ToolDeltaHook(AgentHook):
    def __init__(self):
        self.events = []

    def wants_streaming(self):
        return True

    async def on_tool_call_delta(self, context, delta):
        self.events.append(("delta", delta.run_id, delta.delta_text, delta.status))

    async def before_execute_tools(self, context):
        self.events.append(("before_execute_tools", None, None, None))

    async def on_tool_start(self, context, tool_name, args):
        self.events.append(("tool_start", None, tool_name, None))


@pytest.mark.asyncio
async def test_runner_forwards_tool_call_deltas_before_final_tool_execution():
    tools = ToolRegistry()
    tools.register(_AwaitingFormTool())
    hook = _ToolDeltaHook()
    runner = AgentRunner(_StreamingToolDeltaProvider())

    result = await runner.run(
        AgentRunSpec(
            initial_messages=[{"role": "user", "content": "Collect travel preferences."}],
            tools=tools,
            model="test-model",
            max_iterations=1,
            max_tool_result_chars=1000,
            hook=hook,
            session_key="session-1",
        )
    )

    assert result.stop_reason == "awaiting_form"
    assert hook.events[:3] == [
        ("delta", "session-1:0", '{"form":', "streaming"),
        ("before_execute_tools", None, None, None),
        ("tool_start", None, "request_form", None),
    ]


@pytest.mark.asyncio
async def test_runner_tool_call_deltas_do_not_duplicate_tool_execution_or_checkpoints():
    tools = ToolRegistry()
    tools.register(_AwaitingFormTool())
    hook = _ToolDeltaHook()
    checkpoints = []
    runner = AgentRunner(_StreamingToolDeltaProvider())

    async def checkpoint_callback(payload):
        checkpoints.append(payload)

    result = await runner.run(
        AgentRunSpec(
            initial_messages=[{"role": "user", "content": "Collect travel preferences."}],
            tools=tools,
            model="test-model",
            max_iterations=1,
            max_tool_result_chars=1000,
            hook=hook,
            session_key="session-1",
            checkpoint_callback=checkpoint_callback,
        )
    )

    assert result.stop_reason == "awaiting_form"
    assert [event for event in hook.events if event[0] == "tool_start"] == [("tool_start", None, "request_form", None)]
    assert [message["role"] for message in result.messages] == ["user", "assistant", "tool"]
    assert [checkpoint["phase"] for checkpoint in checkpoints] == ["awaiting_tools", "tools_completed"]


class _InterruptedToolDeltaProvider:
    generation = SimpleNamespace(max_tokens=128)

    def estimate_prompt_tokens(self, messages, tools, model):
        return 1, "fake"

    async def chat_stream_with_retry(self, **kwargs):
        await kwargs["on_tool_call_delta"](
            ToolCallArgumentDelta(
                provider_call_id="chatcmpl-1",
                tool_call_id="call_form",
                tool_call_index=0,
                tool_name="request_form",
                sequence=1,
                delta_text='{"form":',
                phase="arguments",
                status="streaming",
                completed=False,
            )
        )
        return LLMResponse(content="provider error", finish_reason="error")


@pytest.mark.asyncio
async def test_runner_emits_terminal_delta_when_streaming_response_errors():
    hook = _ToolDeltaHook()
    runner = AgentRunner(_InterruptedToolDeltaProvider())

    await runner.run(
        AgentRunSpec(
            initial_messages=[{"role": "user", "content": "Collect travel preferences."}],
            tools=ToolRegistry(),
            model="test-model",
            max_iterations=1,
            max_tool_result_chars=1000,
            hook=hook,
            session_key="session-1",
        )
    )

    assert hook.events[-1] == ("delta", "session-1:0", "", "failed")
