from pathlib import Path

from tinybot.agent.context import ContextBuilder
from tinybot.agent.experience import ExperienceStore
from tinybot.agent.experience_analyzer import ErrorAnalyzer


def test_workflow_experience_is_injected_for_matching_request():
    workspace = _prepare_workspace()
    store = ExperienceStore(workspace)
    store.append_experience(
        tool_name="general",
        outcome="success",
        experience_type="workflow",
        trigger_stage="before_plan",
        context_summary="Review a module by tracing entry points and main execution flow",
        action_hint="Inspect module entry points before proposing structural changes.",
        applicability="Use when reviewing architecture or proposing module-level improvements.",
        resolution="Start at the entry points, trace the main flow, then inspect error handling and tests.",
        confidence=0.9,
        category="general",
    )

    builder = ContextBuilder(workspace=workspace, experience_store=store)
    context = builder._build_experience_context(
        "Please review the experience module and suggest architecture improvements."
    )

    assert context is not None
    assert "[RELEVANT WORKFLOWS]" in context
    assert "Inspect module entry points before proposing structural changes." in context


def test_recovery_experience_is_returned_for_tool_error():
    workspace = _prepare_workspace()
    store = ExperienceStore(workspace)
    store.append_experience(
        tool_name="read_file",
        error_type="FileNotFoundError",
        outcome="resolved",
        experience_type="recovery",
        trigger_stage="on_error",
        action_hint="Retry with a workspace absolute path after confirming the file location.",
        applicability="Use when a relative path fails during file reads.",
        resolution="List the target directory first, then rebuild the path from the workspace root.",
        confidence=0.85,
        category="path",
        context_summary="Relative path failures while reading files.",
    )

    analyzer = ErrorAnalyzer(store)
    suggestions = analyzer.analyze_error(
        "read_file",
        "FileNotFoundError: config/settings.json not found",
    )

    assert suggestions is not None
    assert "[PRIMARY RECOVERY ACTION]" not in suggestions
    assert "Retry with a workspace absolute path" in suggestions
    assert "RECOVERY SUGGESTIONS" in suggestions


def test_recovery_strategy_returns_primary_action():
    workspace = _prepare_workspace()
    store = ExperienceStore(workspace)
    store.append_experience(
        tool_name="read_file",
        error_type="FileNotFoundError",
        outcome="resolved",
        experience_type="recovery",
        trigger_stage="on_error",
        action_hint="Retry with a workspace absolute path.",
        applicability="Relative path failures.",
        resolution="Resolve the path from the workspace root and retry.",
        confidence=0.9,
        category="path",
    )

    analyzer = ErrorAnalyzer(store)
    strategy = analyzer.build_recovery_strategy(
        "read_file",
        "FileNotFoundError: config/settings.json not found",
    )

    assert strategy is not None
    assert strategy["primary_action"] == "Retry with a workspace absolute path."


def test_retry_success_links_back_to_recovery_experience():
    workspace = _prepare_workspace()
    store = ExperienceStore(workspace)
    recovery_id = store.append_experience(
        tool_name="read_file",
        error_type="FileNotFoundError",
        outcome="resolved",
        experience_type="recovery",
        trigger_stage="on_error",
        action_hint="Use an absolute path.",
        applicability="Relative path failures.",
        resolution="Retry with an absolute path from the workspace root.",
        confidence=0.8,
        category="path",
    )

    store.record_tool_event(
        tool_name="read_file",
        params={"path": "config/settings.json"},
        status="ok",
        detail="File read successfully",
        session_key="cli:test",
        attempt_no=2,
        related_experience_id=recovery_id,
    )

    experiences = {exp.id: exp for exp in store.read_experiences()}
    assert experiences[recovery_id].applied_count == 1
    assert experiences[recovery_id].retry_success_count == 1
    linked = [exp for exp in experiences.values() if exp.related_experience_id == recovery_id]
    assert linked


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
