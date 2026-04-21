from pathlib import Path

import pytest

from tinybot.agent.experience import ExperienceStore
from tinybot.agent.tools.experience import QueryExperienceTool, SaveExperienceTool


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
async def test_save_experience_tool_supports_workflow_schema():
    workspace = _prepare_workspace()
    store = ExperienceStore(workspace)
    tool = SaveExperienceTool(store, session_key="cli:test")

    result = await tool.execute(
        tool_name="general",
        experience_type="workflow",
        trigger_stage="before_plan",
        action_hint="Inspect entry points before changing module structure.",
        applicability="When reviewing a module for architecture improvements.",
        resolution="Start from entry points, then trace the main flow and failure handling.",
        context_summary="Module review workflow.",
    )

    assert "Experience saved:" in result
    saved = store.read_experiences()
    assert saved[0].experience_type == "workflow"
    assert saved[0].trigger_stage == "before_plan"


@pytest.mark.asyncio
async def test_query_experience_tool_formats_recovery_results():
    workspace = _prepare_workspace()
    store = ExperienceStore(workspace)
    store.append_experience(
        tool_name="read_file",
        error_type="FileNotFoundError",
        outcome="resolved",
        experience_type="recovery",
        trigger_stage="on_error",
        action_hint="Retry with an absolute path.",
        applicability="Relative path failures.",
        resolution="Resolve the path from the workspace root before retrying.",
        confidence=0.8,
        category="path",
    )
    tool = QueryExperienceTool(store)

    result = await tool.execute(
        keywords="path, not found",
        tool_name="read_file",
        experience_type="recovery",
        trigger_stage="on_error",
    )

    assert "Recommended action: Retry with an absolute path." in result
    assert "recovery/on_error/resolved" in result
