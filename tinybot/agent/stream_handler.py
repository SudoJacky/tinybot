"""Stream handling: buffer management, callbacks, and hook chain."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from collections.abc import Awaitable, Callable

from loguru import logger

from tinybot.agent.hook import AgentHook, AgentHookContext, CompositeHook
from tinybot.agent.tool_executor import format_tool_call_detail

if TYPE_CHECKING:
    from tinybot.agent.loop import AgentLoop


class StreamHandler(AgentHook):
    """Core hook for stream handling with buffer management and callbacks."""

    def __init__(
        self,
        agent_loop: AgentLoop,
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_reasoning_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        *,
        channel: str = "cli",
        chat_id: str = "direct",
        message_id: str | None = None,
    ) -> None:
        self._loop = agent_loop
        self._on_progress = on_progress
        self._on_stream = on_stream
        self._on_reasoning_stream = on_reasoning_stream
        self._on_stream_end = on_stream_end
        self._channel = channel
        self._chat_id = chat_id
        self._message_id = message_id
        self._stream_buf = ""
        self._reasoning_buf = ""

    def wants_streaming(self) -> bool:
        return self._on_stream is not None or self._on_reasoning_stream is not None

    @staticmethod
    def merge_stream_buffer(
        previous: str,
        delta: str,
        *,
        strip_hidden: bool = False,
    ) -> tuple[str, str]:
        """Merge stream delta into buffer, optionally stripping hidden content."""
        if not delta:
            return previous, ""

        if strip_hidden:
            from tinybot.utils.text import strip_think

            prev_clean = strip_think(previous)
            appended_buf = previous + delta
            appended_clean = strip_think(appended_buf)
            snapshot_clean = strip_think(delta)

            candidates: list[tuple[int, str, str]] = []
            if appended_clean.startswith(prev_clean):
                candidates.append((len(appended_clean), appended_buf, appended_clean))
            if snapshot_clean.startswith(prev_clean):
                candidates.append((len(snapshot_clean), delta, snapshot_clean))

            if candidates:
                _, next_buf, next_clean = min(candidates, key=lambda item: item[0])
            else:
                next_buf = appended_buf
                next_clean = appended_clean
            incremental = next_clean[len(prev_clean):]
            return next_buf, incremental

        next_buf = delta if delta.startswith(previous) else previous + delta
        incremental = next_buf[len(previous):]
        return next_buf, incremental

    async def on_stream(self, context: AgentHookContext, delta: str) -> None:
        self._stream_buf, incremental = self.merge_stream_buffer(
            self._stream_buf,
            delta,
            strip_hidden=True,
        )
        if incremental and self._on_stream:
            await self._on_stream(incremental)

    async def on_reasoning_stream(self, context: AgentHookContext, delta: str) -> None:
        self._reasoning_buf, incremental = self.merge_stream_buffer(
            self._reasoning_buf,
            delta,
        )
        if incremental and self._on_reasoning_stream:
            await self._on_reasoning_stream(incremental)

    async def on_stream_end(self, context: AgentHookContext, *, resuming: bool) -> None:
        if self._on_stream_end:
            await self._on_stream_end(resuming=resuming)
        self._stream_buf = ""
        self._reasoning_buf = ""

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        if self._on_progress:
            if not self._on_stream:
                thought = self._loop._strip_think(
                    context.response.content if context.response else None
                )
                if thought:
                    await self._on_progress(thought)

            # Send details for each tool call
            for tc in context.tool_calls:
                detail = format_tool_call_detail(tc)
                await self._on_progress(detail, tool_hint=True, tool_detail=True, tool_name=tc.name)

        for tc in context.tool_calls:
            args_str = json.dumps(tc.arguments, ensure_ascii=False)
            logger.info("Tool call: {}({})", tc.name, args_str[:200])
        self._loop._set_tool_context(self._channel, self._chat_id, self._message_id)

    async def after_execute_tools(self, context: AgentHookContext) -> None:
        """Send tool execution results."""
        if self._on_progress and context.tool_events:
            for event in context.tool_events:
                name = event.get("name", "tool")
                status = event.get("status", "ok")
                detail = event.get("detail", "")
                # Truncate long detail
                if len(detail) > 80:
                    detail = detail[:80] + "..."
                if status == "ok":
                    await self._on_progress(detail, tool_hint=True, tool_result=True, tool_name=name)
                else:
                    await self._on_progress(f"✗ {detail}", tool_hint=True, tool_result=True, tool_name=name)

    async def after_iteration(self, context: AgentHookContext) -> None:
        u = context.usage or {}
        logger.debug(
            "LLM usage: prompt={} completion={} cached={}",
            u.get("prompt_tokens", 0),
            u.get("completion_tokens", 0),
            u.get("cached_tokens", 0),
        )

    def finalize_content(self, context: AgentHookContext, content: str | None) -> str | None:
        return self._loop._strip_think(content)


class StreamHookChain(AgentHook):
    """Run the core stream hook before extra hooks."""

    __slots__ = ("_primary", "_extras")

    def __init__(self, primary: AgentHook, extra_hooks: list[AgentHook]) -> None:
        self._primary = primary
        self._extras = CompositeHook(extra_hooks)

    def wants_streaming(self) -> bool:
        return self._primary.wants_streaming() or self._extras.wants_streaming()

    async def before_iteration(self, context: AgentHookContext) -> None:
        await self._primary.before_iteration(context)
        await self._extras.before_iteration(context)

    async def on_stream(self, context: AgentHookContext, delta: str) -> None:
        await self._primary.on_stream(context, delta)
        await self._extras.on_stream(context, delta)

    async def on_reasoning_stream(self, context: AgentHookContext, delta: str) -> None:
        await self._primary.on_reasoning_stream(context, delta)
        await self._extras.on_reasoning_stream(context, delta)

    async def on_stream_end(self, context: AgentHookContext, *, resuming: bool) -> None:
        await self._primary.on_stream_end(context, resuming=resuming)
        await self._extras.on_stream_end(context, resuming=resuming)

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        await self._primary.before_execute_tools(context)
        await self._extras.before_execute_tools(context)

    async def after_execute_tools(self, context: AgentHookContext) -> None:
        await self._primary.after_execute_tools(context)
        await self._extras.after_execute_tools(context)

    async def after_iteration(self, context: AgentHookContext) -> None:
        await self._primary.after_iteration(context)
        await self._extras.after_iteration(context)

    async def on_tool_start(self, context: AgentHookContext, tool_name: str, args: dict[str, Any]) -> None:
        await self._primary.on_tool_start(context, tool_name, args)
        await self._extras.on_tool_start(context, tool_name, args)

    async def on_tool_end(self, context: AgentHookContext, tool_name: str, result: Any) -> None:
        await self._primary.on_tool_end(context, tool_name, result)
        await self._extras.on_tool_end(context, tool_name, result)

    async def on_error(self, context: AgentHookContext, error: Exception) -> None:
        await self._primary.on_error(context, error)
        await self._extras.on_error(context, error)

    def finalize_content(self, context: AgentHookContext, content: str | None) -> str | None:
        content = self._primary.finalize_content(context, content)
        return self._extras.finalize_content(context, content)
