from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from tinybot.agent.experience import ExperienceStore
from tinybot.task.service import TaskManager


def _prepare_workspace() -> Path:
    workspace = Path("tests")
    experience_dir = workspace / "experiences"
    experience_file = experience_dir / "experiences.jsonl"
    cursor_file = experience_dir / ".cursor"
    if experience_file.exists():
        experience_file.unlink()
    if cursor_file.exists():
        cursor_file.unlink()
    return workspace


@pytest.mark.asyncio
async def test_task_manager_includes_planning_strategy_in_decomposition_prompt():
    workspace = _prepare_workspace()
    store = ExperienceStore(workspace)
    store.append_experience(
        tool_name="general",
        outcome="success",
        experience_type="workflow",
        trigger_stage="before_plan",
        context_summary="Module review workflow",
        action_hint="Inspect entry points before decomposing the task.",
        applicability="When planning architecture review work.",
        resolution="Break the task into entry-point tracing, main flow analysis, and failure-path inspection.",
        confidence=0.9,
        category="general",
    )

    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=MagicMock(has_tool_calls=False))
    manager = TaskManager(
        workspace=workspace,
        provider=provider,
        model="test-model",
        experience_store=store,
    )

    await manager.create_plan(
        request="Review the experience module and propose improvements.",
        channel="cli",
        chat_id="test",
    )

    call_kwargs = provider.chat_with_retry.await_args.kwargs
    user_message = call_kwargs["messages"][1]["content"]
    assert "[PLANNING STRATEGY]" in user_message
    assert "Inspect entry points before decomposing the task." in user_message
