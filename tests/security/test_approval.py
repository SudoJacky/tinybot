"""Tests for session-scoped tool execution approvals."""

from tinybot.security.approval import ApprovalAction, ApprovalManager, ApprovalScope
from tinybot.session.manager import Session


class _Tool:
    def __init__(self, *, read_only: bool = False):
        self._read_only = read_only

    @property
    def read_only(self) -> bool:
        return self._read_only


def test_read_only_tool_is_allowed() -> None:
    session = Session(key="cli:test")
    decision = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(read_only=True),
        tool_name="read_file",
        params={"path": "README.md"},
    )
    assert decision.action == ApprovalAction.ALLOW
    assert ApprovalManager.list_pending(session) == []


def test_exec_requires_approval() -> None:
    session = Session(key="cli:test")
    decision = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="exec",
        params={"command": "powershell -Command Remove-Item secret.txt"},
    )
    assert decision.action == ApprovalAction.REQUIRE_APPROVAL
    assert decision.request is not None
    assert decision.request.tool_name == "exec"
    assert ApprovalManager.list_pending(session)[0].id == decision.request.id


def test_low_risk_exec_is_allowed() -> None:
    session = Session(key="cli:test")
    decision = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="exec",
        params={"command": "uv run pytest tests/security -q"},
    )
    assert decision.action == ApprovalAction.ALLOW


def test_low_risk_exec_with_shell_control_requires_approval() -> None:
    session = Session(key="cli:test")
    decision = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="exec",
        params={"command": "uv run pytest tests/security -q; Remove-Item secret.txt"},
    )
    assert decision.action == ApprovalAction.REQUIRE_APPROVAL


def test_once_approval_is_consumed() -> None:
    session = Session(key="cli:test")
    params = {"path": "notes.md", "content": "hello"}
    first = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="write_file",
        params=params,
    )
    assert first.request is not None
    approved = ApprovalManager.approve(session, first.request.id, ApprovalScope.ONCE)
    assert approved is not None

    second = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="write_file",
        params=params,
    )
    assert second.action == ApprovalAction.ALLOW

    third = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="write_file",
        params=params,
    )
    assert third.action == ApprovalAction.REQUIRE_APPROVAL


def test_session_approval_allows_matching_operations() -> None:
    session = Session(key="cli:test")
    params = {"path": "notes.md", "content": "hello"}
    first = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="write_file",
        params=params,
    )
    assert first.request is not None
    approved = ApprovalManager.approve(session, first.request.id, ApprovalScope.SESSION)
    assert approved is not None

    second = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="write_file",
        params={"path": "notes.md", "content": "changed"},
    )
    assert second.action == ApprovalAction.ALLOW


def test_exec_session_approval_requires_exact_command_match() -> None:
    session = Session(key="cli:test")
    command = "custom-tool " + ("a" * 100)
    changed_command = command + " --delete"

    first = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="exec",
        params={"command": command},
    )
    assert first.request is not None
    approved = ApprovalManager.approve(session, first.request.id, ApprovalScope.SESSION)
    assert approved is not None

    second = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="exec",
        params={"command": command},
    )
    assert second.action == ApprovalAction.ALLOW

    third = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(),
        tool_name="exec",
        params={"command": changed_command},
    )
    assert third.action == ApprovalAction.REQUIRE_APPROVAL


def test_mcp_tool_requires_approval_even_if_marked_read_only() -> None:
    session = Session(key="cli:test")
    decision = ApprovalManager.evaluate(
        session=session,
        tool=_Tool(read_only=True),
        tool_name="mcp_filesystem_read",
        params={"path": "README.md"},
    )
    assert decision.action == ApprovalAction.REQUIRE_APPROVAL
