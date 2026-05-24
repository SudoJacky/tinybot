from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tinybot.agent.runner import AgentRunSpec, AgentRunner
from tinybot.agent.tools.base import AwaitingUserInputResult, Tool, tool_parameters
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.providers.base import LLMResponse, ToolCallRequest


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
