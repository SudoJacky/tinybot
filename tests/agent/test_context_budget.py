from __future__ import annotations

from pathlib import Path
import shutil
from types import SimpleNamespace

import pytest

from tinybot.agent.memory import Consolidator
from tinybot.agent.runner import AgentRunner, AgentRunSpec
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.session.manager import Session, SessionManager


class _BudgetProvider:
    generation = SimpleNamespace(max_tokens=128)

    def estimate_prompt_tokens(self, messages, tools, model):
        total = 0
        for message in messages:
            content = message.get("content", "")
            if isinstance(content, str):
                total += max(1, len(content) // 4)
        return total, "fake"


def test_snip_history_can_drop_dynamic_system_context() -> None:
    runner = AgentRunner(_BudgetProvider())
    tools = ToolRegistry()
    spec = AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=1,
        max_tool_result_chars=1000,
        context_window_tokens=1000,
        context_block_limit=120,
    )
    messages = [
        {"role": "system", "content": "core system contract"},
        {"role": "system", "content": "[RELEVANT PAST CONTEXT]\n" + ("old " * 2000)},
        {"role": "user", "content": "Please continue with the current task."},
        {"role": "assistant", "content": "I will continue from here."},
    ]

    snipped = runner._snip_history(spec, messages)

    assert snipped[0]["content"] == "core system contract"
    assert all("[RELEVANT PAST CONTEXT]" not in str(m.get("content")) for m in snipped)
    assert any(m.get("role") == "user" for m in snipped)


@pytest.mark.asyncio
async def test_consolidator_uses_context_block_limit() -> None:
    workspace = Path(".test-context-budget-workspace")
    if workspace.exists():
        shutil.rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True)

    session = Session(key="cli:test")
    for idx in range(8):
        session.add_message("user", f"user message {idx} " + ("x" * 200))
        session.add_message("assistant", f"assistant message {idx} " + ("y" * 200))

    sessions = SessionManager(workspace)
    calls: list[list[dict]] = []

    consolidator = Consolidator(
        store=SimpleNamespace(
            append_history=lambda entry: 1,
            raw_archive=lambda messages: None,
        ),
        provider=_BudgetProvider(),
        model="test-model",
        sessions=sessions,
        context_window_tokens=10_000,
        context_block_limit=300,
        build_messages=lambda **kwargs: kwargs["history"] + [{"role": "user", "content": kwargs["current_message"]}],
        get_tool_definitions=lambda: [],
        max_completion_tokens=128,
        vector_store=None,
    )

    async def archive(messages):
        calls.append(messages)
        return "summary", []

    consolidator.archive = archive

    try:
        await consolidator.maybe_consolidate_by_tokens(session)

        assert calls
        assert session.last_consolidated > 0
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
