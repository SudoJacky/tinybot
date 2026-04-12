"""Subagent manager for background task execution."""

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Coroutine

from loguru import logger

from tinybot.agent.hook import AgentHook, AgentHookContext
from tinybot.utils.prompt_templates import render_template
from tinybot.agent.runner import AgentRunSpec, AgentRunner
from tinybot.agent.skills import BUILTIN_SKILLS_DIR
from tinybot.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.agent.tools.shell import ExecTool
from tinybot.bus.events import InboundMessage
from tinybot.bus.queue import MessageBus
from tinybot.config.schema import ExecToolConfig
from tinybot.providers.base import LLMProvider


class _SubagentHook(AgentHook):
    """Logging-only hook for subagent execution."""

    def __init__(self, task_id: str) -> None:
        self._task_id = task_id

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        for tool_call in context.tool_calls:
            args_str = json.dumps(tool_call.arguments, ensure_ascii=False)
            logger.debug(
                "Subagent [{}] executing: {} with arguments: {}",
                self._task_id, tool_call.name, args_str,
            )


class SubagentManager:
    """Manages background subagent execution with concurrency limits and heartbeat monitoring."""

    # Default timeout for subagent execution (5 minutes)
    DEFAULT_TIMEOUT_SECONDS = 300
    # Default max concurrent subagents
    DEFAULT_MAX_CONCURRENT = 5

    def __init__(
        self,
        provider: LLMProvider,
        workspace: Path,
        bus: MessageBus,
        max_tool_result_chars: int,
        model: str | None = None,
        exec_config: "ExecToolConfig | None" = None,
        restrict_to_workspace: bool = False,
        max_concurrent: int | None = None,
        timeout_seconds: int | None = None,
    ):
        from tinybot.config.schema import ExecToolConfig

        self.provider = provider
        self.workspace = workspace
        self.bus = bus
        self.model = model or provider.get_default_model()
        self.max_tool_result_chars = max_tool_result_chars
        self.exec_config = exec_config or ExecToolConfig()
        self.restrict_to_workspace = restrict_to_workspace
        self.runner = AgentRunner(provider)
        self._running_tasks: dict[str, asyncio.Task[None]] = {}
        self._session_tasks: dict[str, set[str]] = {}  # session_key -> {task_id, ...}
        # Concurrency control
        self.max_concurrent = max_concurrent or self.DEFAULT_MAX_CONCURRENT
        self._concurrency_semaphore = asyncio.Semaphore(self.max_concurrent)
        # Heartbeat tracking
        self.timeout_seconds = timeout_seconds or self.DEFAULT_TIMEOUT_SECONDS
        self._task_start_times: dict[str, float] = {}  # task_id -> start timestamp
        self._heartbeat_monitor_task: asyncio.Task | None = None

    async def spawn(
        self,
        task: str,
        label: str | None = None,
        origin_channel: str = "cli",
        origin_chat_id: str = "direct",
        session_key: str | None = None,
        metadata: dict[str, Any] | None = None,
        on_complete: Callable[[str, str, str, dict[str, Any] | None], Coroutine[Any, Any, None]] | None = None,
    ) -> str:
        """Spawn a subagent to execute a task in the background.

        Args:
            task: The task description for the subagent
            label: Optional short label for display
            origin_channel: Channel where the request originated
            origin_chat_id: Chat ID where the request originated
            session_key: Optional session key for grouping subagents
            metadata: Optional metadata passed to on_complete callback (e.g., plan_id, subtask_id)
            on_complete: Optional async callback when subagent completes (result, status, metadata)

        Returns:
            Message about the spawn result.
        """
        task_id = str(uuid.uuid4())[:8]
        display_label = label or task[:30] + ("..." if len(task) > 30 else "")
        origin = {"channel": origin_channel, "chat_id": origin_chat_id}

        # Start heartbeat monitor if not running
        if self._heartbeat_monitor_task is None or self._heartbeat_monitor_task.done():
            self._heartbeat_monitor_task = asyncio.create_task(self._heartbeat_monitor_loop())

        async def _run_with_semaphore():
            async with self._concurrency_semaphore:
                # Record start time for heartbeat tracking (after acquiring semaphore)
                self._task_start_times[task_id] = time.monotonic()
                try:
                    await self._run_subagent(task_id, task, display_label, origin, metadata, on_complete)
                finally:
                    self._task_start_times.pop(task_id, None)

        bg_task = asyncio.create_task(_run_with_semaphore())
        self._running_tasks[task_id] = bg_task
        if session_key:
            self._session_tasks.setdefault(session_key, set()).add(task_id)

        def _cleanup(_: asyncio.Task) -> None:
            self._running_tasks.pop(task_id, None)
            self._task_start_times.pop(task_id, None)
            if session_key and (ids := self._session_tasks.get(session_key)):
                ids.discard(task_id)
                if not ids:
                    del self._session_tasks[session_key]

        bg_task.add_done_callback(_cleanup)

        # Count tasks actually running (past semaphore) vs queued
        running_count = len([t for t in self._running_tasks.values() if not t.done() and t.get_coro().__name__ == "_run_with_semaphore"])
        queued_count = self.get_running_count() - running_count

        logger.info("Spawned subagent [{}]: {} (queued: {}, running: {})",
                    task_id, display_label, queued_count, running_count)

        if queued_count > 0:
            return f"Subagent [{display_label}] queued (id: {task_id}). {queued_count} waiting, {running_count} running."
        return f"Subagent [{display_label}] started (id: {task_id}). Running: {running_count}/{self.max_concurrent}"

    async def _run_subagent(
        self,
        task_id: str,
        task: str,
        label: str,
        origin: dict[str, str],
        metadata: dict[str, Any] | None = None,
        on_complete: Callable[[str, str, str, dict[str, Any] | None], Coroutine[Any, Any, None]] | None = None,
    ) -> None:
        """Execute the subagent task and announce the result."""
        logger.info("Subagent [{}] starting task: {}", task_id, label)

        try:
            # Build subagent tools (no message tool, no spawn tool)
            tools = ToolRegistry()
            allowed_dir = self.workspace if self.restrict_to_workspace else None
            extra_read = [BUILTIN_SKILLS_DIR] if allowed_dir else None
            tools.register(ReadFileTool(workspace=self.workspace, allowed_dir=allowed_dir, extra_allowed_dirs=extra_read))
            tools.register(WriteFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
            tools.register(EditFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
            tools.register(ListDirTool(workspace=self.workspace, allowed_dir=allowed_dir))
            if self.exec_config.enable:
                tools.register(ExecTool(
                    working_dir=str(self.workspace),
                    timeout=self.exec_config.timeout,
                    restrict_to_workspace=self.restrict_to_workspace,
                    path_append=self.exec_config.path_append,
                ))
            system_prompt = self._build_subagent_prompt()
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task},
            ]

            result = await self.runner.run(AgentRunSpec(
                initial_messages=messages,
                tools=tools,
                model=self.model,
                max_iterations=15,
                max_tool_result_chars=self.max_tool_result_chars,
                hook=_SubagentHook(task_id),
                max_iterations_message="Task completed but no final response was generated.",
                error_message=None,
                fail_on_tool_error=True,
            ))

            # Handle different stop reasons
            final_result: str
            final_status: str

            if result.stop_reason == "tool_error":
                final_result = self._format_partial_progress(result)
                final_status = "failed"
            elif result.stop_reason == "error":
                final_result = result.error or "Error: subagent execution failed."
                final_status = "failed"
            else:
                final_result = result.final_content or "Task completed but no final response was generated."
                final_status = "completed"

            logger.info("Subagent [{}] {} with status: {}", task_id, label, final_status)

            # Call on_complete callback (updates TaskManager, auto-spawns next, sends final notification)
            # This is the single point that drives the entire execution chain
            if on_complete:
                try:
                    await on_complete(final_result, final_status, task_id, metadata)
                except Exception as e:
                    logger.error("Subagent [{}] on_complete callback failed: {}", task_id, e)

        except asyncio.CancelledError:
            # Handle timeout cancellation
            elapsed = self.get_task_elapsed_time(task_id) or 0
            error_msg = f"Subagent timed out after {elapsed:.1f}s (limit: {self.timeout_seconds}s)"
            logger.warning("Subagent [{}] cancelled: {}", task_id, error_msg)

            # Call on_complete callback with timeout error
            if on_complete:
                try:
                    await on_complete(error_msg, "failed", task_id, metadata)
                except Exception as cb_err:
                    logger.error("Subagent [{}] on_complete callback failed: {}", task_id, cb_err)

            raise  # Re-raise to properly cleanup

        except Exception as e:
            error_msg = f"Error: {str(e)}"
            logger.error("Subagent [{}] failed: {}", task_id, e)

            # Call on_complete callback with error
            if on_complete:
                try:
                    await on_complete(error_msg, "failed", task_id, metadata)
                except Exception as cb_err:
                    logger.error("Subagent [{}] on_complete callback failed: {}", task_id, cb_err)

    async def _announce_result(
        self,
        content: str,
        origin: dict[str, str],
        sender_id: str = "subagent",
    ) -> None:
        """Send notification to main agent via the message bus.

        Args:
            content: The notification content (markdown formatted)
            origin: Origin channel/chat_id info
            sender_id: Sender identifier (default "subagent" triggers main agent reply)
        """
        msg = InboundMessage(
            channel="system",
            sender_id=sender_id,
            chat_id=f"{origin['channel']}:{origin['chat_id']}",
            content=content,
        )

        await self.bus.publish_inbound(msg)
        logger.debug("Sent notification to {}:{}", origin['channel'], origin['chat_id'])

    @staticmethod
    def _format_partial_progress(result) -> str:
        completed = [e for e in result.tool_events if e["status"] == "ok"]
        failure = next((e for e in reversed(result.tool_events) if e["status"] == "error"), None)
        lines: list[str] = []
        if completed:
            lines.append("Completed steps:")
            for event in completed[-3:]:
                lines.append(f"- {event['name']}: {event['detail']}")
        if failure:
            if lines:
                lines.append("")
            lines.append("Failure:")
            lines.append(f"- {failure['name']}: {failure['detail']}")
        if result.error and not failure:
            if lines:
                lines.append("")
            lines.append("Failure:")
            lines.append(f"- {result.error}")
        return "\n".join(lines) or (result.error or "Error: subagent execution failed.")

    def _build_subagent_prompt(self) -> str:
        """Build a focused system prompt for the subagent."""
        from tinybot.agent.context import ContextBuilder
        from tinybot.agent.skills import SkillsLoader

        time_ctx = ContextBuilder._build_runtime_context(None, None)
        skills_summary = SkillsLoader(self.workspace).build_skills_summary()
        return render_template(
            "agent/subagent_system.md",
            time_ctx=time_ctx,
            workspace=str(self.workspace),
            skills_summary=skills_summary or "",
        )

    async def cancel_by_session(self, session_key: str) -> int:
        """Cancel all subagents for the given session. Returns count cancelled."""
        tasks = [self._running_tasks[tid] for tid in self._session_tasks.get(session_key, [])
                 if tid in self._running_tasks and not self._running_tasks[tid].done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return len(tasks)

    def get_running_count(self) -> int:
        """Return the number of currently running subagents."""
        return len(self._running_tasks)

    def get_task_elapsed_time(self, task_id: str) -> float | None:
        """Get elapsed time in seconds for a running task."""
        start = self._task_start_times.get(task_id)
        if start is None:
            return None
        return time.monotonic() - start

    async def _heartbeat_monitor_loop(self) -> None:
        """Background task that monitors for timeout and handles stale subagents."""
        check_interval = 30  # Check every 30 seconds
        logger.info("Heartbeat monitor started (timeout: {}s)", self.timeout_seconds)

        while self._running_tasks:
            try:
                await asyncio.sleep(check_interval)
            except asyncio.CancelledError:
                logger.debug("Heartbeat monitor cancelled")
                break

            now = time.monotonic()
            stale_tasks = []

            for task_id, start_time in list(self._task_start_times.items()):
                elapsed = now - start_time
                if elapsed > self.timeout_seconds:
                    stale_tasks.append((task_id, elapsed))

            for task_id, elapsed in stale_tasks:
                task = self._running_tasks.get(task_id)
                if task and not task.done():
                    logger.warning(
                        "Subagent [{}] timeout after {:.1f}s (limit: {}s)",
                        task_id, elapsed, self.timeout_seconds
                    )
                    task.cancel()
                    # The task will handle cancellation in _run_subagent and call on_complete

        logger.debug("Heartbeat monitor stopped (no running tasks)")
