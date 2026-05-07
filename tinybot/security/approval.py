"""Session-scoped approval gate for high-risk agent tool execution."""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from tinybot.agent.tools.base import Tool
    from tinybot.session.manager import Session


APPROVAL_METADATA_KEY = "security_approvals"


class ApprovalAction(StrEnum):
    """Decision returned by the approval gate."""

    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"


class ApprovalScope(StrEnum):
    """User-selected approval scope."""

    ONCE = "once"
    SESSION = "session"


@dataclass(frozen=True)
class ApprovalRequest:
    """A pending approval request stored in session metadata."""

    id: str
    tool_name: str
    params: dict[str, Any]
    fingerprint: str
    category: str
    risk: str
    reason: str
    summary: str
    created_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tool_name": self.tool_name,
            "params": self.params,
            "fingerprint": self.fingerprint,
            "category": self.category,
            "risk": self.risk,
            "reason": self.reason,
            "summary": self.summary,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ApprovalRequest:
        return cls(
            id=str(data.get("id") or ""),
            tool_name=str(data.get("tool_name") or ""),
            params=data.get("params") if isinstance(data.get("params"), dict) else {},
            fingerprint=str(data.get("fingerprint") or ""),
            category=str(data.get("category") or "tool"),
            risk=str(data.get("risk") or "high"),
            reason=str(data.get("reason") or "High-risk tool call requires user approval."),
            summary=str(data.get("summary") or ""),
            created_at=float(data.get("created_at") or time.time()),
        )


@dataclass(frozen=True)
class ApprovalDecision:
    """Approval gate result."""

    action: ApprovalAction
    request: ApprovalRequest | None = None


_SAFE_EXEC_PATTERNS = [
    r"\s*git\s+(status|diff|log|show|branch|rev-parse|ls-files)(?:\s+[\w./\\:@{}=,+~^*-]+)*\s*",
    r"\s*uv\s+run\s+(pytest|ruff|mypy)(?:\s+[\w./\\:@{}=,+~^*-]+)*\s*",
    r"\s*python\s+-m\s+pytest(?:\s+[\w./\\:@{}=,+~^*-]+)*\s*",
]
_SHELL_CONTROL_CHARS = frozenset(";&|<>\n\r`")


def _stable_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        return json.dumps(str(value), ensure_ascii=False)


def _short_hash(value: str, length: int = 12) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _metadata(session: Session) -> dict[str, Any]:
    data = session.metadata.setdefault(APPROVAL_METADATA_KEY, {})
    if not isinstance(data, dict):
        data = {}
        session.metadata[APPROVAL_METADATA_KEY] = data
    data.setdefault("pending", {})
    data.setdefault("approved_once", [])
    data.setdefault("approved_session", [])
    data.setdefault("denied", [])
    return data


def _normalize_command(command: str) -> str:
    return " ".join(command.strip().split())


def _normalize_path_value(value: Any) -> str:
    return str(value or "").replace("\\", "/").lower()


def _has_shell_control_operator(command: str) -> bool:
    quote: str | None = None
    escaped = False
    for char in command:
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char in _SHELL_CONTROL_CHARS:
            return True
    return False


def _is_low_risk_exec(command: str) -> bool:
    normalized = _normalize_command(command).lower()
    if _has_shell_control_operator(normalized):
        return False
    return any(re.fullmatch(pattern, normalized) for pattern in _SAFE_EXEC_PATTERNS)


def classify_tool_call(tool: Tool | None, tool_name: str, params: dict[str, Any]) -> tuple[str, str, str] | None:
    """Return (category, risk, reason) if a tool call needs approval."""
    if tool is not None and tool.read_only and not tool_name.startswith("mcp_"):
        return None

    if tool_name == "exec":
        command = str(params.get("command") or "")
        if _is_low_risk_exec(command):
            return None
        return ("shell", "high", "Shell execution can modify files, run programs, or access the network.")

    if tool_name in {"write_file", "edit_file"}:
        return ("filesystem_write", "medium", "File write/edit tools can modify workspace state.")

    if tool_name in {"cron", "task", "spawn"}:
        return ("agent_control", "high", "Agent control tools can create background or delegated execution.")

    if tool_name.startswith("mcp_"):
        return ("mcp", "high", "MCP tools are externally supplied capabilities and may have side effects.")

    if tool_name in {"add_document", "delete_document", "delete_experience", "save_experience"}:
        return ("persistent_data", "medium", "This tool modifies persistent agent data.")

    if tool_name == "message":
        return ("external_message", "medium", "Message tool can send content to an external channel.")

    if tool is not None and not tool.read_only:
        return ("tool", "medium", "This tool is not marked read-only and may have side effects.")

    return None


def build_fingerprint(tool_name: str, params: dict[str, Any], category: str) -> str:
    """Build a precise approval fingerprint for one operation."""
    if tool_name == "exec":
        return f"exec:{_normalize_command(str(params.get('command') or '')).lower()}"
    if tool_name in {"write_file", "edit_file"}:
        return f"{tool_name}:{_normalize_path_value(params.get('path'))}"
    if tool_name.startswith("mcp_"):
        return f"{tool_name}:{_short_hash(_stable_json(params))}"
    return f"{category}:{tool_name}:{_short_hash(_stable_json(params))}"


def build_session_fingerprint(tool_name: str, params: dict[str, Any], category: str) -> str:
    """Build a broader fingerprint for session-scoped approval."""
    if tool_name == "exec":
        return build_fingerprint(tool_name, params, category)
    if tool_name in {"write_file", "edit_file"}:
        return f"{tool_name}:{_normalize_path_value(params.get('path'))}"
    return f"{category}:{tool_name}"


def _summary(tool_name: str, params: dict[str, Any]) -> str:
    if tool_name == "exec":
        return f'exec command="{_normalize_command(str(params.get("command") or ""))[:160]}"'
    if tool_name in {"write_file", "edit_file", "read_file", "list_dir"}:
        return f'{tool_name} path="{params.get("path", "")}"'
    return f"{tool_name}({_stable_json(params)[:160]})"


class ApprovalManager:
    """Stores and evaluates session-scoped tool approvals."""

    @staticmethod
    def evaluate(
        *,
        session: Session | None,
        tool: Tool | None,
        tool_name: str,
        params: dict[str, Any],
    ) -> ApprovalDecision:
        if session is None:
            return ApprovalDecision(ApprovalAction.ALLOW)

        classification = classify_tool_call(tool, tool_name, params)
        if classification is None:
            return ApprovalDecision(ApprovalAction.ALLOW)

        category, risk, reason = classification
        fingerprint = build_fingerprint(tool_name, params, category)
        session_fingerprint = build_session_fingerprint(tool_name, params, category)
        data = _metadata(session)

        approved_once = data.get("approved_once", [])
        if fingerprint in approved_once:
            data["approved_once"] = [item for item in approved_once if item != fingerprint]
            return ApprovalDecision(ApprovalAction.ALLOW)

        if session_fingerprint in data.get("approved_session", []):
            return ApprovalDecision(ApprovalAction.ALLOW)

        request_id = _short_hash(f"{session.key}:{fingerprint}", length=10)
        pending = data.setdefault("pending", {})
        if isinstance(pending, dict):
            pending[request_id] = ApprovalRequest(
                id=request_id,
                tool_name=tool_name,
                params=params,
                fingerprint=fingerprint,
                category=category,
                risk=risk,
                reason=reason,
                summary=_summary(tool_name, params),
                created_at=time.time(),
            ).to_dict()
            request = ApprovalRequest.from_dict(pending[request_id])
        else:
            request = ApprovalRequest(
                id=request_id,
                tool_name=tool_name,
                params=params,
                fingerprint=fingerprint,
                category=category,
                risk=risk,
                reason=reason,
                summary=_summary(tool_name, params),
                created_at=time.time(),
            )
            data["pending"] = {request_id: request.to_dict()}
        return ApprovalDecision(ApprovalAction.REQUIRE_APPROVAL, request)

    @staticmethod
    def list_pending(session: Session) -> list[ApprovalRequest]:
        pending = _metadata(session).get("pending", {})
        if not isinstance(pending, dict):
            return []
        return [ApprovalRequest.from_dict(item) for item in pending.values() if isinstance(item, dict)]

    @staticmethod
    def approve(session: Session, request_id: str, scope: ApprovalScope) -> ApprovalRequest | None:
        data = _metadata(session)
        pending = data.get("pending", {})
        if not isinstance(pending, dict):
            return None
        raw = pending.pop(request_id, None)
        if not isinstance(raw, dict):
            return None
        request = ApprovalRequest.from_dict(raw)
        if scope == ApprovalScope.ONCE:
            approved = data.setdefault("approved_once", [])
            if request.fingerprint not in approved:
                approved.append(request.fingerprint)
        else:
            approved = data.setdefault("approved_session", [])
            session_fp = build_session_fingerprint(request.tool_name, request.params, request.category)
            if session_fp not in approved:
                approved.append(session_fp)
        return request

    @staticmethod
    def deny(session: Session, request_id: str) -> ApprovalRequest | None:
        data = _metadata(session)
        pending = data.get("pending", {})
        if not isinstance(pending, dict):
            return None
        raw = pending.pop(request_id, None)
        if not isinstance(raw, dict):
            return None
        request = ApprovalRequest.from_dict(raw)
        denied = data.setdefault("denied", [])
        denied.append({"id": request.id, "fingerprint": request.fingerprint, "denied_at": time.time()})
        return request


def format_approval_required(request: ApprovalRequest) -> str:
    """Tool result text returned to the model when a call is blocked for approval."""
    return (
        "Error: Tool execution requires user approval.\n"
        f"Approval ID: {request.id}\n"
        f"Tool: {request.tool_name}\n"
        f"Risk: {request.risk} ({request.category})\n"
        f"Reason: {request.reason}\n"
        f"Operation: {request.summary}\n\n"
        "Ask the user to choose one of:\n"
        f"- /approve {request.id} once\n"
        f"- /approve {request.id} session\n"
        f"- /deny {request.id}"
    )
