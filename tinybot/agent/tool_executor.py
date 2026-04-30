"""Tool execution helpers: formatting, context management."""

from __future__ import annotations

import asyncio
import base64
import re
import subprocess
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from tinybot.agent.hook import AgentHook, AgentHookContext
from tinybot.bus.events import OutboundMessage
from tinybot.config.paths import get_media_dir

if TYPE_CHECKING:
    from tinybot.agent.tools.message import MessageTool
    from tinybot.bus.queue import MessageBus


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


_OPENCLI_RE = re.compile(
    r"(?:^|[;&|]\s*)opencli(?:\.(?:cmd|ps1|bat|exe))?\b",
    re.IGNORECASE,
)


def is_opencli_command(command: str | None) -> bool:
    """Return whether a shell command appears to invoke OpenCLI."""
    if not command:
        return False
    return bool(_OPENCLI_RE.search(command))


class BrowserSnapshotHook(AgentHook):
    """Capture OpenCLI browser state after OpenCLI exec calls."""

    def __init__(
        self,
        *,
        bus: MessageBus,
        channel: str,
        chat_id: str,
        timeout: float = 20.0,
    ) -> None:
        self._bus = bus
        self._channel = channel
        self._chat_id = chat_id
        self._timeout = timeout
        self._pending_commands: list[str] = []

    async def on_tool_start(
        self,
        context: AgentHookContext,
        tool_name: str,
        args: dict[str, Any],
    ) -> None:
        if tool_name != "exec":
            return
        command = args.get("command")
        if isinstance(command, str) and is_opencli_command(command):
            self._pending_commands.append(command)

    async def on_tool_end(
        self,
        context: AgentHookContext,
        tool_name: str,
        result: Any,
    ) -> None:
        if tool_name != "exec" or not self._pending_commands:
            return
        command = self._pending_commands.pop(0)
        await self._capture_and_send(command)

    async def _capture_and_send(self, source_command: str) -> None:
        snapshot_dir = get_media_dir("browser_snapshots")
        snapshot_path = snapshot_dir / f"opencli-{uuid.uuid4().hex}.png"
        try:
            command = subprocess.list2cmdline([
                "opencli",
                "browser",
                "screenshot",
                str(snapshot_path),
            ])
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=self._timeout,
            )
            if process.returncode != 0 or not snapshot_path.is_file():
                detail = (stderr or stdout or b"").decode("utf-8", errors="replace").strip()
                logger.debug("OpenCLI browser snapshot skipped: {}", detail[:300])
                return

            raw = snapshot_path.read_bytes()
            image_url = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
            await self._bus.publish_outbound(OutboundMessage(
                channel=self._channel,
                chat_id=self._chat_id,
                content="",
                metadata={
                    "_browser_snapshot": True,
                    "image_url": image_url,
                    "source_command": source_command,
                    "captured_at": datetime.now(UTC).isoformat(),
                },
            ))
        except TimeoutError:
            logger.debug("OpenCLI browser snapshot timed out")
        except Exception as exc:
            logger.debug("OpenCLI browser snapshot failed: {}", exc)
        finally:
            self._safe_unlink(snapshot_path)

    @staticmethod
    def _safe_unlink(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            logger.debug("Failed to remove temporary browser snapshot {}", path)
