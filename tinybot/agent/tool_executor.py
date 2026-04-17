"""Tool execution helpers: formatting, context management."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from tinybot.agent.tools.message import MessageTool


def format_tool_hint(tool_calls: list) -> str:
    """Format tool calls as concise hint, e.g. 'web_search("query")'."""
    def _fmt(tc):
        args = (tc.arguments[0] if isinstance(tc.arguments, list) else tc.arguments) or {}
        val = next(iter(args.values()), None) if isinstance(args, dict) else None
        if not isinstance(val, str):
            return tc.name
        return f'{tc.name}("{val[:40]}…")' if len(val) > 40 else f'{tc.name}("{val}")'
    return ", ".join(_fmt(tc) for tc in tool_calls)


def format_tool_call_detail(tc) -> str:
    """Format tool call as Claude Code-style display: ToolName(args)."""
    args = tc.arguments if isinstance(tc.arguments, dict) else {}
    if args:
        first_key = next(iter(args.keys()), None)
        first_val = args.get(first_key) if first_key else None
        if isinstance(first_val, str):
            val_display = first_val[:60] + "…" if len(first_val) > 60 else first_val
            summary = f"{first_key}=\"{val_display}\""
        elif first_val is not None:
            summary = f"{first_key}={first_val}"
        else:
            summary = ""
        other_args = []
        for k, v in list(args.items())[1:3]:
            if isinstance(v, str) and len(v) > 30:
                other_args.append(f"{k}=\"{v[:30]}…\"")
            elif isinstance(v, str):
                other_args.append(f"{k}=\"{v}\"")
            else:
                other_args.append(f"{k}={v}")
        if other_args:
            summary += ", " + ", ".join(other_args)
        return f"{tc.name}({summary})" if summary else tc.name
    return tc.name


class ToolContextManager:
    """Manage tool execution context (channel, chat_id, message_id)."""

    def __init__(self) -> None:
        self._channel: str = ""
        self._chat_id: str = ""
        self._message_id: str | None = None

    def set_context(
        self,
        channel: str,
        chat_id: str,
        message_id: str | None = None,
    ) -> None:
        """Set the current tool execution context."""
        self._channel = channel
        self._chat_id = chat_id
        self._message_id = message_id

    def get_context(self) -> tuple[str, str, str | None]:
        """Get the current tool execution context."""
        return self._channel, self._chat_id, self._message_id

    def apply_to_tools(self, tools: Any) -> None:
        """Apply context to message tool if available."""
        message_tool = tools.get("message")
        if message_tool:
            # Check if the tool has set_context method (MessageTool interface)
            if hasattr(message_tool, "set_context"):
                message_tool.set_context(self._channel, self._chat_id, self._message_id)
